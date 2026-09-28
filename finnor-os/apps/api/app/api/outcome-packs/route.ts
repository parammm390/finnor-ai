import { StartOutcomePackSchema } from "@finnor/policy-schema";
import { OUTCOME_PACK_IDS, type OutcomePackId } from "@finnor/shared-types";
import { OUTCOME_PACK_DEFINITIONS, bindOutcomePack, evaluateOutcomeAutonomyReadiness, linkEmployeeConversationTurnToWork, outcomePackFingerprint, persistEmployeeAssistantTurn, prepareEmployeeConversationTurn, resolveCanonicalHumanPrincipal, startOutcomePack } from "@finnor/orchestration";
import { loadEmployeeConversationThread, outcomePackCertifications, tenantOutcomePackSettings, withTenant, workInputs } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { errorResponse, requireContext } from "../../../lib/auth";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const state = await withTenant(ctx.tenantId, async (db) => {
      const [settings, certifications] = await Promise.all([
        db.select().from(tenantOutcomePackSettings).where(eq(tenantOutcomePackSettings.tenantId, ctx.tenantId)),
        db.select().from(outcomePackCertifications).where(eq(outcomePackCertifications.tenantId, ctx.tenantId)),
      ]);
      return { settings, certifications };
    });
    const readiness = Object.fromEntries(await Promise.all(OUTCOME_PACK_IDS.map(async (packId) => [packId, await evaluateOutcomeAutonomyReadiness(ctx.tenantId, packId)])));
    return Response.json({
      packs: OUTCOME_PACK_IDS.map((packId) => ({
        definition: OUTCOME_PACK_DEFINITIONS[packId],
        fingerprint: outcomePackFingerprint(packId),
        setting: state.settings.find((row) => row.packId === packId) ?? { enabled: true, defaultMode: "approval", revision: 0 },
        certifications: state.certifications.filter((row) => row.packId === packId),
        readiness: readiness[packId],
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Starts existing Work + Objective runtime with one immutable pack contract. */
export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = StartOutcomePackSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const budgets = parsed.data.budgets;
    const input = { ...parsed.data.input, mode: parsed.data.input.mode ?? "approval" };
    let binding: ReturnType<typeof bindOutcomePack>;
    try {
      binding = bindOutcomePack(parsed.data.packId as OutcomePackId, input);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid Outcome Pack input" }, { status: 400 });
    }
    const enabled = await withTenant(ctx.tenantId, async (db) => {
      const [setting] = await db.select({ enabled: tenantOutcomePackSettings.enabled, reason: tenantOutcomePackSettings.reason })
        .from(tenantOutcomePackSettings)
        .where(and(eq(tenantOutcomePackSettings.tenantId, ctx.tenantId), eq(tenantOutcomePackSettings.packId, parsed.data.packId)))
        .limit(1);
      return setting ?? { enabled: true, reason: null };
    });
    if (!enabled.enabled) return Response.json({ error: `Outcome Pack is disabled: ${enabled.reason ?? "operator control"}` }, { status: 409 });
    if (parsed.data.threadId) {
      if (!parsed.data.instructionId) return Response.json({ error: "instructionId is required when threadId is supplied" }, { status: 400 });
      const employeeId = await resolveCanonicalHumanPrincipal(ctx);
      const loaded = await loadEmployeeConversationThread({
        tenantId: ctx.tenantId,
        ownerEmployeeId: employeeId,
        threadId: parsed.data.threadId,
        messageLimit: 1,
      });
      if (!loaded) return Response.json({ error: "conversation_thread_not_found" }, { status: 404 });
    }
    let started: Awaited<ReturnType<typeof startOutcomePack>>;
    try {
      started = await startOutcomePack(parsed.data.packId as OutcomePackId, input, ctx, {
        channel: parsed.data.channel,
        sessionId: parsed.data.sessionId,
        instructionId: parsed.data.instructionId,
        workId: parsed.data.workId,
        idempotencyKey: parsed.data.idempotencyKey,
        activeContext: parsed.data.activeContext,
        maxSteps: budgets?.maxSteps,
        maxActions: budgets?.maxActions,
        maxQueries: budgets?.maxQueries,
        maxPlannerFailures: budgets?.maxPlannerFailures,
        maxConsecutiveNoProgress: budgets?.maxConsecutiveNoProgress,
        deadlineAt: budgets?.deadlineAt ? new Date(budgets.deadlineAt) : undefined,
      });
    } catch (error) {
      if (!parsed.data.instructionId) throw error;
      const [claimed] = await withTenant(ctx.tenantId, (db) => db.select({
        workId: workInputs.workId,
        workInputId: workInputs.id,
        createdBy: workInputs.createdBy,
        instructionText: workInputs.instructionText,
      }).from(workInputs).where(and(eq(workInputs.tenantId, ctx.tenantId), eq(workInputs.instructionId, parsed.data.instructionId!))).limit(1));
      if (!claimed || claimed.createdBy !== (ctx.employeeId ?? ctx.userId) || claimed.instructionText !== binding.objective) throw error;
      return Response.json({
        error: error instanceof Error ? error.message : "Outcome Pack start failed after Work intake",
        recoverable: true,
        workId: claimed.workId,
        workInputId: claimed.workInputId,
        instructionId: parsed.data.instructionId,
        ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}),
      }, { status: 503 });
    }
    const projectionWarnings: Array<{ stage: string; code: "projection_persistence_failed" }> = (started.attachmentWarnings ?? []).map((warning) => ({
      stage: `subject link ${warning.entityType}:${warning.entityId}`,
      code: "projection_persistence_failed" as const,
    }));
    const warn = (stage: string, error: unknown) => {
      console.error(`[POST /api/outcome-packs] ${stage} projection failed`, error instanceof Error ? error.message : String(error));
      projectionWarnings.push({ stage, code: "projection_persistence_failed" });
    };
    if (parsed.data.threadId) {
      try {
        const prepared = await prepareEmployeeConversationTurn({
          ctx,
          threadId: parsed.data.threadId,
          instruction: `Start ${binding.objective}`,
          instructionId: started.instructionId,
          idempotencyKey: parsed.data.idempotencyKey,
          channel: parsed.data.channel,
          transportSessionId: parsed.data.sessionId,
          activeContext: parsed.data.activeContext,
        });
        if (prepared.threadId !== parsed.data.threadId) throw new Error("conversation_thread_identity_changed");
        try {
          await linkEmployeeConversationTurnToWork({
            tenantId: ctx.tenantId,
            employeeId: prepared.employeeId,
            threadId: prepared.threadId,
            userMessageId: prepared.userMessage.id,
            workId: started.workId,
            workInputId: started.workInputId,
            objectiveLoopId: started.objectiveLoopId,
          });
        } catch (error) { warn("work link", error); }
        try {
          await persistEmployeeAssistantTurn({
            tenantId: ctx.tenantId,
            employeeId: prepared.employeeId,
            threadId: prepared.threadId,
            instructionId: started.instructionId,
            channel: parsed.data.channel,
            text: `I started ${binding.objective}. Progress and completion depend on the recorded Work and verification evidence.`,
            workId: started.workId,
            workInputId: started.workInputId,
            outcomeRefs: [
              { kind: "outcome_pack", id: started.pack.packId, version: started.pack.packVersion, mode: started.pack.mode },
              { kind: "objective_loop", id: started.objectiveLoopId, state: started.state },
              { kind: "work", id: started.workId },
            ],
          });
        } catch (error) { warn("assistant message", error); }
      } catch (error) { warn("conversation turn", error); }
    }
    return Response.json({ outcomePack: started, ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}), projectionWarnings }, { status: started.duplicate ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
