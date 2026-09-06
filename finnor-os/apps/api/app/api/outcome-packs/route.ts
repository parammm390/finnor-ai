import { StartOutcomePackSchema } from "@finnor/policy-schema";
import { OUTCOME_PACK_IDS, type OutcomePackId } from "@finnor/shared-types";
import { OUTCOME_PACK_DEFINITIONS, evaluateOutcomeAutonomyReadiness, outcomePackFingerprint, startOutcomePack } from "@finnor/orchestration";
import { outcomePackCertifications, tenantOutcomePackSettings, withTenant } from "@finnor/db";
import { eq } from "drizzle-orm";
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
    const started = await startOutcomePack(parsed.data.packId as OutcomePackId, input, ctx, {
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
    return Response.json({ outcomePack: started }, { status: started.duplicate ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
