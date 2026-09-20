import {
  businessEffects,
  decisionReceipts,
  domainActions,
  externalOperations,
  providerOperationAttempts,
  reconciliationCases,
  withTenant,
  workflowSteps,
} from "@finnor/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { completeStep, failStep, type StepObservationFence } from "./steps";
import { recordRuntimeOperatorControlTx, type RuntimeOperatorControlRequest } from "./operator-controls";

export interface OpenReconciliationCaseParams {
  caseType: typeof reconciliationCases.$inferInsert.caseType;
  relatedOutboxEventId?: string;
  relatedInboxEventId?: string;
  relatedStepId?: string;
  businessEffectId?: string;
  integrationId?: string;
  relatedExternalOperationId?: string;
  classification?: string;
  authoritativeSide?: "finnor" | "external" | "manual";
  details: Record<string, unknown>;
}

export async function openReconciliationCase(
  tenantId: string,
  params: OpenReconciliationCaseParams,
): Promise<{ caseId: string }> {
  const [row] = await withTenant(tenantId, (db) => db.insert(reconciliationCases).values({
    tenantId,
    caseType: params.caseType,
    relatedOutboxEventId: params.relatedOutboxEventId ?? null,
    relatedInboxEventId: params.relatedInboxEventId ?? null,
    relatedStepId: params.relatedStepId ?? null,
    businessEffectId: params.businessEffectId ?? null,
    integrationId: params.integrationId ?? null,
    relatedExternalOperationId: params.relatedExternalOperationId ?? null,
    classification: params.classification ?? null,
    authoritativeSide: params.authoritativeSide ?? null,
    details: params.details,
  }).returning());
  return { caseId: row!.id };
}

export type ReconciliationOutcome = NonNullable<typeof reconciliationCases.$inferSelect.resolutionOutcome>;

export interface ReconciliationResolutionRequest extends RuntimeOperatorControlRequest {
  outcome: ReconciliationOutcome;
  evidence: Record<string, unknown>;
  provider?: string;
  integrationId?: string;
}

export type ReconciliationResolutionResult =
  | { resolved: true; version: number }
  | { resolved: false; reason: "not_found" | "not_open" | "version_conflict" | "evidence_required" | "account_mismatch" | "still_unresolved" };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/**
 * Evidence-bearing reconciliation settlement. This writes runtime outcome and
 * retry-safety facts only. It does not create Scope-1 REPLAN/ESCALATE/CANCEL
 * decisions, and it never re-invokes a provider.
 */
export async function resolveReconciliationCase(
  tenantId: string,
  caseId: string,
  request: ReconciliationResolutionRequest,
): Promise<ReconciliationResolutionResult> {
  const result = await withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${reconciliationCases}
      WHERE ${reconciliationCases.tenantId}=${tenantId}
        AND ${reconciliationCases.id}=${caseId}::uuid FOR UPDATE`);
    const [row] = await db.select().from(reconciliationCases).where(and(
      eq(reconciliationCases.tenantId, tenantId),
      eq(reconciliationCases.id, caseId),
    )).limit(1);
    const audit = (
      outcome: "applied" | "conflict" | "rejected" | "blocked",
      reasonCode: string,
      observedFence?: number | null,
    ) => recordRuntimeOperatorControlTx(db, tenantId, {
      controlType: "reconciliation_resolution",
      targetType: "reconciliation_case",
      targetId: caseId,
      expectedVersion: request.expectedVersion,
      observedFence,
      actorId: request.actorId,
      authorityDecisionId: request.authorityDecisionId,
      reason: request.reason,
      evidence: {
        reasonCode,
        requestedOutcome: request.outcome,
        resolutionEvidence: request.evidence,
        provider: request.provider ?? null,
        integrationId: request.integrationId ?? null,
        relatedExternalOperationId: row?.relatedExternalOperationId ?? null,
      },
      outcome,
      controlKey: request.controlKey,
    });

    if (!row) {
      await audit("rejected", "not_found");
      return { result: { resolved: false, reason: "not_found" } as const, steps: [], aggregate: null };
    }
    if (row.version !== request.expectedVersion) {
      await audit("conflict", "version_conflict");
      return { result: { resolved: false, reason: "version_conflict" } as const, steps: [], aggregate: null };
    }
    if (row.status !== "open") {
      await audit("rejected", "not_open");
      return { result: { resolved: false, reason: "not_open" } as const, steps: [], aggregate: null };
    }
    if (Object.keys(request.evidence).length === 0) {
      await audit("rejected", "evidence_required");
      return { result: { resolved: false, reason: "evidence_required" } as const, steps: [], aggregate: null };
    }
    if (request.outcome === "still_unknowable") {
      // "Still unknown" is important evidence, but it is not permission to close an
      // ambiguity or replay its operation. Keep the case open and audit the refusal.
      await audit("blocked", "still_unresolved");
      return { result: { resolved: false, reason: "still_unresolved" } as const, steps: [], aggregate: null };
    }
    if ((row.integrationId && request.integrationId !== row.integrationId)
        || (request.integrationId && row.integrationId && request.integrationId !== row.integrationId)) {
      await audit("rejected", "account_mismatch");
      return { result: { resolved: false, reason: "account_mismatch" } as const, steps: [], aggregate: null };
    }

    let operation: typeof externalOperations.$inferSelect | null = null;
    if (row.relatedExternalOperationId) {
      const [loadedOperation] = await db.select().from(externalOperations).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.id, row.relatedExternalOperationId),
      )).limit(1);
      operation = loadedOperation ?? null;
      if (!operation
          || (row.businessEffectId && operation.businessEffectId !== row.businessEffectId)
          || (row.integrationId && operation.integrationId !== row.integrationId)
          || (request.integrationId && operation.integrationId !== request.integrationId)
          || (request.provider && operation.provider !== request.provider)) {
        await audit("rejected", "account_mismatch");
        return { result: { resolved: false, reason: "account_mismatch" } as const, steps: [], aggregate: null };
      }
      const response = { ...object(operation.response), reconciliationOutcome: request.outcome, reconciliationEvidence: request.evidence };
      await db.update(externalOperations).set({
        status: request.outcome === "happened_as_intended" ? "succeeded"
          : request.outcome === "definitely_did_not_happen" ? "failed" : operation.status,
        response,
        executionState: request.outcome === "happened_as_intended" ? "verified"
          : request.outcome === "definitely_did_not_happen" ? "reconciled"
            : request.outcome === "happened_differently" ? "divergent" : operation.executionState,
        verificationStatus: request.outcome === "happened_as_intended" ? "verified"
          : request.outcome === "happened_differently" ? "divergent" : "unknown",
        verifiedAt: request.outcome === "happened_as_intended" ? new Date() : operation.verifiedAt,
        version: sql`${externalOperations.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.id, operation.id),
        eq(externalOperations.version, operation.version),
      ));
      const [attempt] = await db.select({ id: providerOperationAttempts.id }).from(providerOperationAttempts).where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.externalOperationId, operation.id),
      )).orderBy(desc(providerOperationAttempts.ordinal)).limit(1);
      if (attempt) await db.update(providerOperationAttempts).set({
        status: request.outcome === "happened_as_intended" ? "verified"
          : request.outcome === "definitely_did_not_happen" ? "reconciled"
            : request.outcome === "happened_differently" ? "divergent" : "reconciliation_required",
        finishedAt: new Date(),
        outcomeDetail: { reconciliationOutcome: request.outcome, evidence: request.evidence },
      }).where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.id, attempt.id),
      ));
    }

    const [resolved] = await db.update(reconciliationCases).set({
      status: "resolved",
      resolution: { outcome: request.outcome, evidence: request.evidence },
      resolutionOutcome: request.outcome,
      resolutionEvidence: request.evidence,
      resolvedBy: request.actorId,
      resolutionProvider: request.provider ?? operation?.provider ?? null,
      resolutionIntegrationId: request.integrationId ?? operation?.integrationId ?? row.integrationId ?? null,
      resolvedAt: new Date(),
      version: sql`${reconciliationCases.version} + 1`,
    }).where(and(
      eq(reconciliationCases.tenantId, tenantId),
      eq(reconciliationCases.id, caseId),
      eq(reconciliationCases.status, "open"),
      eq(reconciliationCases.version, request.expectedVersion),
    )).returning({ version: reconciliationCases.version });
    if (!resolved) throw new Error("Reconciliation resolution lost its version fence");

    let aggregate: "verified" | "failed" | "divergent" | "reconciliation_required" | "partially_verified" | null = null;
    let steps: Array<{ id: string; status: string; dispatchGeneration: number }> = [];
    if (row.businessEffectId) {
      const members = await db.select({
        state: externalOperations.executionState,
        response: externalOperations.response,
      }).from(externalOperations).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.businessEffectId, row.businessEffectId),
      ));
      const counts = members.reduce((acc, member) => {
        const outcome = object(member.response).reconciliationOutcome;
        if (member.state === "verified" || (member.state === "reconciled" && outcome === "happened_as_intended")) acc.verified += 1;
        else if (member.state === "known_failed" || (member.state === "reconciled" && outcome === "definitely_did_not_happen")) acc.failed += 1;
        else if (member.state === "divergent") acc.divergent += 1;
        else if (member.state === "unknown_outcome" || member.state === "reconciliation_required") acc.unknown += 1;
        else acc.incomplete += 1;
        return acc;
      }, { verified: 0, failed: 0, divergent: 0, unknown: 0, incomplete: 0 });
      aggregate = counts.divergent > 0 ? "divergent"
        : counts.unknown > 0 ? "reconciliation_required"
          : members.length > 0 && counts.verified === members.length ? "verified"
            : members.length > 0 && counts.failed === members.length ? "failed"
              : "partially_verified";
      const verification = {
        state: aggregate === "failed" ? "unverified" : aggregate,
        basis: `Reconciliation settled one logical operation; aggregate member state is ${aggregate}`,
        checkedAt: new Date().toISOString(),
        observed: { resolutionCaseId: caseId, resolutionOutcome: request.outcome, counts },
      };
      await db.update(businessEffects).set({
        status: aggregate,
        verification,
        observedResult: { reconciliationCaseId: caseId, operationCounts: counts },
        observedAt: new Date(),
      }).where(and(
        eq(businessEffects.tenantId, tenantId),
        eq(businessEffects.id, row.businessEffectId),
        sql`${businessEffects.status} NOT IN ('verified','compensated')`,
      ));
      await db.update(decisionReceipts).set({ verification }).where(and(
        eq(decisionReceipts.tenantId, tenantId),
        eq(decisionReceipts.businessEffectId, row.businessEffectId),
      ));
      const [effect] = await db.select({ actionId: businessEffects.domainActionId }).from(businessEffects).where(and(
        eq(businessEffects.tenantId, tenantId),
        eq(businessEffects.id, row.businessEffectId),
      )).limit(1);
      if (effect?.actionId) await db.update(domainActions).set({
        status: aggregate === "verified" ? "completed" : "needs_human_review",
        executionStartedAt: null,
      }).where(and(
        eq(domainActions.tenantId, tenantId),
        eq(domainActions.id, effect.actionId),
        inArray(domainActions.status, ["executing", "needs_human_review", "failed", "blocked_integration_unavailable"]),
      ));
      steps = await db.select({
        id: workflowSteps.id,
        status: workflowSteps.status,
        dispatchGeneration: workflowSteps.dispatchGeneration,
      }).from(workflowSteps).where(and(
        eq(workflowSteps.tenantId, tenantId),
        eq(workflowSteps.businessEffectId, row.businessEffectId),
      ));
    }
    await audit("applied", "resolution_applied", operation?.version ?? null);
    return { result: { resolved: true, version: resolved.version } as const, steps, aggregate };
  });

  if (result.result.resolved && result.aggregate) {
    for (const step of result.steps) {
      if (step.status !== "waiting_observation") continue;
      const fence: StepObservationFence = { kind: "observation", dispatchGeneration: step.dispatchGeneration };
      if (result.aggregate === "verified") {
        await completeStep(tenantId, step.id, { reconciliationCaseId: caseId, resolved: true }, fence);
      } else if (result.aggregate !== "partially_verified") {
        await failStep(
          tenantId,
          step.id,
          `Reconciliation resolved runtime outcome as ${request.outcome}; Scope-1 recovery must decide the next business action`,
          result.aggregate === "reconciliation_required" ? "unknown_outcome" : result.aggregate === "divergent" ? "conflict" : "needs_human",
          fence,
          result.aggregate === "failed" ? "failed_after_possible_effect" : "reconciling",
        );
      }
    }
  }
  return result.result;
}
