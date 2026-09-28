import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { attachValidatedWorkInputContext, domainActions, employeeConversationMessages, receiveWork, reconcileWorkStatus, recordWorkResponse, transitionWork, withTenant, works } from "@finnor/db";
import { attachWorkToDealGraph } from "@finnor/private-equity";
import { linkEmployeeConversationTurnToWork, OperatingInteractionContextError, persistEmployeeAssistantTurn, prepareEmployeeConversationTurn, resolveCanonicalHumanPrincipal, resolveOperatingInteractionContext } from "@finnor/orchestration";
import { errorResponse, requireContext, enforceRouteRateLimit } from "../../../../lib/auth";
import { getOrchestrator } from "../../../../lib/orchestrator";
import { requireWorkerFleetReady } from "../../../../lib/worker-readiness";
import { HumanClosingActionSchema } from "../../../../lib/product-control-schemas";

// Explicit human-authored decisions. These types remain forbidden to the model
// planner. Core still owns grounding, authority, effect compilation, approval,
// execution, verification, receipts, and the one durable Work/employee Thread.
export async function POST(req: Request): Promise<Response> {
  let received: Awaited<ReturnType<typeof receiveWork>> | undefined;
  let tenantId: string | undefined;
  try {
    const ctx = await requireContext(req);
    tenantId = ctx.tenantId;
    const parsed = HumanClosingActionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Invalid human closing decision", issues: parsed.error.issues }, { status: 400 });
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    const input = parsed.data;
    if (input.actionType === "verify_closing_item" && input.payload.verifierEmployeeId && input.payload.verifierEmployeeId !== employeeId) {
      return Response.json({ error: "You can only record your own verifier identity" }, { status: 403 });
    }
    const target = input.actionType === "waive_closing_condition"
      ? { entityType: "pe_closing_condition" as const, entityId: input.payload.closingConditionId }
      : { entityType: "pe_closing_item" as const, entityId: input.payload.closingItemId };
    const payload = input.actionType === "verify_closing_item" ? { ...input.payload, verifierEmployeeId: employeeId } : input.payload;
    const requestHash = createHash("sha256").update(JSON.stringify({ employeeId, input })).digest("hex");
    const instruction = `Prepare my reviewed ${input.actionType.replaceAll("_", " ")} decision for ${target.entityId}.`;
    const activeContext = await resolveOperatingInteractionContext({ tenantId: ctx.tenantId, channel: "text", context: {
      version: 1, capturedAt: new Date().toISOString(), source: "text", selectedEntities: [
        { entityType: "pe_deal", entityId: input.payload.dealId }, target,
      ], excludedEntities: [], filters: [], surface: { id: "deals", route: "/centropy/world", spatialState: "canvas" },
    } });
    const contextSnapshot = activeContext ? { ...activeContext } : undefined;
    await requireWorkerFleetReady();
    received = await receiveWork({ tenantId: ctx.tenantId, userId: employeeId, instruction, channel: "text",
      instructionId: input.idempotencyKey, idempotencyKey: input.idempotencyKey, activeContext: contextSnapshot,
      authorityContext: { employeeId, principal: employeeId, revision: ctx.authorityRevision ?? null, roles: ctx.authorityRoles ?? [ctx.role], humanRequestHash: requestHash } });
    if (received.duplicate) {
      const [stored] = await withTenant(ctx.tenantId, (db) => db.select({ authorityContext: works.authorityContext, finalOutcome: works.finalOutcome }).from(works)
        .where(and(eq(works.tenantId, ctx.tenantId), eq(works.id, received!.workId))).limit(1));
      const authorityContext = stored?.authorityContext as Record<string, unknown> | undefined;
      if (authorityContext?.humanRequestHash !== requestHash) return Response.json({ error: "This intake key belongs to a different exact human decision", workId: received.workId }, { status: 409 });
      const outcome = stored?.finalOutcome as { response?: Record<string, unknown> } | undefined;
      // A lifecycle reconciliation may replace finalOutcome with terminal counts.
      // Restore the identity from its durable action and authenticated user turn;
      // replay never invokes Core or creates another decision.
      if (!outcome?.response) {
        const restored = await withTenant(ctx.tenantId, async (db) => {
          const [action] = await db.select({ id: domainActions.id, actionType: domainActions.actionType, status: domainActions.status }).from(domainActions)
            .where(and(eq(domainActions.tenantId, ctx.tenantId), eq(domainActions.workId, received!.workId), eq(domainActions.id, received!.workInputId))).limit(1);
          const [turn] = await db.select({ threadId: employeeConversationMessages.threadId }).from(employeeConversationMessages)
            .where(and(eq(employeeConversationMessages.tenantId, ctx.tenantId), eq(employeeConversationMessages.ownerEmployeeId, employeeId), eq(employeeConversationMessages.workInputId, received!.workInputId), eq(employeeConversationMessages.role, "user"))).limit(1);
          return action && turn ? { workId: received!.workId, workInputId: received!.workInputId, instructionId: received!.instructionId,
            threadId: turn.threadId, actionId: action.id, actionType: action.actionType, actionStatus: action.status, status: received!.status, duplicate: true, restored: true } : null;
        }, employeeId);
        if (restored) return Response.json(restored, { status: ["failed", "cancelled"].includes(restored.status) ? 422 : 200 });
      }
      if (!outcome?.response && ["failed", "cancelled", "completed"].includes(received.status)) return Response.json({
        error: `The exact human decision Work is ${received.status}. Refresh its record and review a new decision if necessary.`, workId: received.workId, duplicate: true,
      }, { status: 409 });
      return Response.json(outcome?.response ? { ...outcome.response, duplicate: true } : {
        workId: received.workId, workInputId: received.workInputId, duplicate: true, inProgress: true,
      }, { status: outcome?.response?.result && typeof outcome.response.result === "object" && "status" in outcome.response.result && outcome.response.result.status === "failure" ? 422 : outcome?.response ? 200 : 202 });
    }
    await enforceRouteRateLimit(`intake:${ctx.tenantId}`, Number(process.env.RATE_LIMIT_INTAKE_PER_MINUTE ?? 20));
    const humanCtx = { ...ctx, userId: employeeId, employeeId };
    const prepared = await prepareEmployeeConversationTurn({ ctx: humanCtx, threadId: input.threadId, instruction,
      instructionId: received.instructionId, idempotencyKey: input.idempotencyKey, channel: "text", activeContext: contextSnapshot });
    if (activeContext) await attachValidatedWorkInputContext({ tenantId: ctx.tenantId, workId: received.workId, workInputId: received.workInputId, context: activeContext });
    await linkEmployeeConversationTurnToWork({ tenantId: ctx.tenantId, employeeId, threadId: prepared.threadId,
      userMessageId: prepared.userMessage.id, workId: received.workId, workInputId: received.workInputId });
    await attachWorkToDealGraph({ auth: humanCtx, provenance: { sourceSystem: "api:human-closing-decision", createdBy: employeeId } }, { dealId: input.payload.dealId, workId: received.workId, entities: [{ ...target, relationship: "target" }] });
    await transitionWork(ctx.tenantId, received.workId, "planning", "human_decision_received", { actionType: input.actionType, authoredBy: employeeId });
    const drafted = await getOrchestrator().draftKnownAction(input.actionType, payload, ctx.tenantId, {
      actionId: received.workInputId, source: "authenticated_human_decision", workId: received.workId,
      instructionId: received.instructionId, initiatedBy: employeeId, reviewBeforeExecution: true,
      authorityContext: { employeeId, principal: employeeId, revision: ctx.authorityRevision ?? null, roles: ctx.authorityRoles ?? [ctx.role] },
    });
    const status = await reconcileWorkStatus(ctx.tenantId, received.workId);
    const response = { workId: received.workId, workInputId: received.workInputId, instructionId: received.instructionId,
      threadId: prepared.threadId, actionId: drafted.action.id, actionType: input.actionType, status, result: drafted.result };
    if (drafted.result.status === "failure") {
      const failed = { ...response, error: drafted.result.error ?? "Human decision could not be grounded" };
      await recordWorkResponse(ctx.tenantId, received.workId, failed);
      return Response.json(failed, { status: 422 });
    }
    const projectionWarnings: string[] = [];
    try {
      await persistEmployeeAssistantTurn({ tenantId: ctx.tenantId, employeeId, threadId: prepared.threadId,
        instructionId: received.instructionId, channel: "text", workId: received.workId, workInputId: received.workInputId,
        text: "Your human decision is drafted. Review its exact BusinessEffect and authority before confirming execution.",
        outcomeRefs: [{ kind: "work", id: received.workId }, { kind: "domain_action", id: drafted.action.id }] });
    } catch { projectionWarnings.push("assistant_projection_unavailable"); }
    await recordWorkResponse(ctx.tenantId, received.workId, { ...response, projectionWarnings });
    return Response.json({ ...response, projectionWarnings }, { status: 201 });
  } catch (error) {
    if (received && tenantId && !received.duplicate) {
      // Preserve any action that Core already drafted. Only an intake with no
      // durable child can fail here, fenced against a concurrent state change.
      const status = await reconcileWorkStatus(tenantId, received.workId).catch(() => null);
      if (status === "received" || status === "planning") await transitionWork(tenantId, received.workId, "failed", "human_intake_failed", {}, {
        expectedStatus: status, expectedWorkInputId: received.workInputId,
        failure: { message: error instanceof Error ? error.message : "Human intake failed", recoverable: false, nextAction: "Review a new exact human decision; the model cannot author this decision." },
      }).catch(() => undefined);
    }
    if (error instanceof Error && error.message.startsWith("canonical_human_principal")) return Response.json({ error: error.message }, { status: 403 });
    if (error instanceof OperatingInteractionContextError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    return errorResponse(error);
  }
}
