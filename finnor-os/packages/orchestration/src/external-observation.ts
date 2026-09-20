import {
  businessEffects,
  decisionReceipts,
  domainActions,
  externalOperations,
  externalRefs,
  integrationOperations,
  providerOperationAttempts,
  reconciliationCases,
  reconcileWorkStatus,
  tenantIntegrations,
  withTenant,
  workflowSteps,
} from "@finnor/db";
import type { ExternalEffectObservation } from "@finnor/shared-types";
import { advanceWorkflow, completeStep, failStep, type StepObservationFence } from "@finnor/workflow-runtime";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { resumeObjectiveForAction } from "./objective-loop";
import { ingestIntegrationEvent } from "./event-waits";

export interface ExternalObservationReferences {
  integrationOperationId?: string;
  domainActionId?: string;
  externalOperationKey?: string;
  providerEventId?: string;
}

interface MemberSummary {
  memberCount: number;
  verifiedCount: number;
  knownFailedCount: number;
  uncertainCount: number;
  divergentCount: number;
  incompleteCount: number;
  compensatedCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function operationMemberSummary(rows: Array<typeof externalOperations.$inferSelect>): MemberSummary {
  const summary: MemberSummary = {
    memberCount: rows.length,
    verifiedCount: 0,
    knownFailedCount: 0,
    uncertainCount: 0,
    divergentCount: 0,
    incompleteCount: 0,
    compensatedCount: 0,
  };
  for (const row of rows) {
    const reconciliationOutcome = record(row.response).reconciliationOutcome;
    if (row.executionState === "verified"
        || (row.executionState === "reconciled" && reconciliationOutcome === "happened_as_intended")) {
      summary.verifiedCount += 1;
    } else if (row.executionState === "known_failed"
        || (row.executionState === "reconciled" && reconciliationOutcome === "definitely_did_not_happen")) {
      summary.knownFailedCount += 1;
    } else if (row.executionState === "unknown_outcome" || row.executionState === "reconciliation_required") {
      summary.uncertainCount += 1;
    } else if (row.executionState === "divergent") {
      summary.divergentCount += 1;
    } else if (row.executionState === "compensated") {
      summary.compensatedCount += 1;
    } else {
      summary.incompleteCount += 1;
    }
  }
  return summary;
}

/**
 * The sole terminal boundary for exact provider read-back/events.
 *
 * A BusinessEffect is an aggregate authorization envelope, not a synonym for one
 * provider request. This first settles the referenced logical provider operation,
 * then derives aggregate effect truth from every member. Verified members are
 * monotonic and never become replay candidates merely because another member is
 * incomplete, failed, divergent, or unknown.
 */
export async function settleExternalEffectObservation(
  observation: ExternalEffectObservation,
  refs: ExternalObservationReferences = {},
): Promise<void> {
  const [loaded] = await withTenant(observation.tenantId, (db) => db.select({
    effectId: businessEffects.id,
    effectStatus: businessEffects.status,
    semanticHash: businessEffects.semanticHash,
    effectActionId: businessEffects.domainActionId,
    actionWorkId: domainActions.workId,
  }).from(businessEffects).innerJoin(domainActions, and(
    eq(domainActions.tenantId, observation.tenantId),
    eq(domainActions.id, businessEffects.domainActionId),
  )).where(and(
    eq(businessEffects.tenantId, observation.tenantId),
    eq(businessEffects.id, observation.businessEffectId),
  )).limit(1));
  if (!loaded || !loaded.effectActionId) throw new Error("External observation does not match a tenant Business Effect/action");
  if (refs.domainActionId && refs.domainActionId !== loaded.effectActionId) throw new Error("External observation action/effect mismatch");

  const [integration] = await withTenant(observation.tenantId, (db) => db.select({
    id: tenantIntegrations.id,
    binding: tenantIntegrations.binding,
  }).from(tenantIntegrations).where(and(
    eq(tenantIntegrations.tenantId, observation.tenantId),
    eq(tenantIntegrations.id, observation.integrationId),
  )).limit(1));
  if (!integration || integration.binding !== observation.provider) {
    throw new Error("External observation does not match the configured tenant integration/account");
  }

  const checkedAt = new Date(observation.observedAt);
  if (Number.isNaN(checkedAt.getTime())) throw new Error("External observation timestamp is invalid");
  if (!refs.integrationOperationId && !(refs.domainActionId && refs.externalOperationKey)) {
    throw new Error("External observation requires an exact logical-operation reference");
  }

  const settlement = await withTenant(observation.tenantId, async (db) => {
    // Serialize observers for different members through the aggregate Effect row.
    await db.execute(sql`SELECT id FROM ${businessEffects}
      WHERE ${businessEffects.tenantId}=${observation.tenantId}
        AND ${businessEffects.id}=${observation.businessEffectId}::uuid FOR UPDATE`);
    const [currentEffect] = await db.select({ status: businessEffects.status }).from(businessEffects).where(and(
      eq(businessEffects.tenantId, observation.tenantId),
      eq(businessEffects.id, observation.businessEffectId),
    )).limit(1);
    if (!currentEffect) throw new Error("Business Effect disappeared during observation settlement");

    let exactExternalOperationId: string | null = null;
    if (refs.externalOperationKey && refs.domainActionId) {
      await db.execute(sql`SELECT id FROM ${externalOperations}
        WHERE ${externalOperations.tenantId}=${observation.tenantId}
          AND ${externalOperations.domainActionId}=${refs.domainActionId}::uuid
          AND ${externalOperations.operationKey}=${refs.externalOperationKey} FOR UPDATE`);
      const [member] = await db.select().from(externalOperations).where(and(
        eq(externalOperations.tenantId, observation.tenantId),
        eq(externalOperations.domainActionId, refs.domainActionId),
        eq(externalOperations.operationKey, refs.externalOperationKey),
        eq(externalOperations.integrationId, observation.integrationId),
        eq(externalOperations.businessEffectId, observation.businessEffectId),
      )).limit(1);
      if (!member) throw new Error("Observation does not bind to the exact logical provider operation/account/effect");
      exactExternalOperationId = member.id;

      // Exact member verification is monotonic. A late poll or out-of-order event
      // cannot turn already-proven state back into uncertainty or divergence.
      const mayAdvanceMember = member.executionState !== "verified" || observation.classification === "present";
      if (mayAdvanceMember) {
        const response = {
          ...record(member.response),
          ...(observation.classification === "absent"
            ? { reconciliationOutcome: "definitely_did_not_happen" }
            : observation.classification === "present"
              ? { reconciliationOutcome: "happened_as_intended" }
              : {}),
        };
        const executionState = observation.classification === "present" ? "verified" as const
          : observation.classification === "divergent" ? "divergent" as const
            : observation.classification === "absent" ? "reconciled" as const
              : "reconciliation_required" as const;
        const [updated] = await db.update(externalOperations).set({
          status: observation.classification === "present" ? "succeeded"
            : observation.classification === "absent" ? "failed"
              : observation.classification === "unknown" ? "unknown" : member.status,
          response,
          externalObservedAt: checkedAt,
          verificationStatus: observation.classification === "present" ? "verified"
            : observation.classification === "divergent" ? "divergent" : "unknown",
          observation,
          executionState,
          verifiedAt: observation.classification === "present" ? checkedAt : member.verifiedAt,
          version: sql`${externalOperations.version} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(externalOperations.tenantId, observation.tenantId),
          eq(externalOperations.id, member.id),
          eq(externalOperations.version, member.version),
        )).returning({ id: externalOperations.id });
        if (!updated) throw new Error("Logical provider operation changed during observation settlement");

        const [latestAttempt] = await db.select({ id: providerOperationAttempts.id }).from(providerOperationAttempts).where(and(
          eq(providerOperationAttempts.tenantId, observation.tenantId),
          eq(providerOperationAttempts.externalOperationId, member.id),
        )).orderBy(desc(providerOperationAttempts.ordinal)).limit(1);
        if (latestAttempt) await db.update(providerOperationAttempts).set({
          status: observation.classification === "present" ? "verified"
            : observation.classification === "divergent" ? "divergent"
              : observation.classification === "absent" ? "reconciled" : "reconciliation_required",
          finishedAt: checkedAt,
          outcomeDetail: { observation },
        }).where(and(
          eq(providerOperationAttempts.tenantId, observation.tenantId),
          eq(providerOperationAttempts.id, latestAttempt.id),
        ));
      }
    }

    if (refs.integrationOperationId) {
      const [legacyOperation] = await db.update(integrationOperations).set({
        externalObservedAt: checkedAt,
        verificationStatus: observation.classification === "present" ? "verified"
          : observation.classification === "divergent" ? "divergent" : "unknown",
        observation,
        updatedAt: new Date(),
      }).where(and(
        eq(integrationOperations.tenantId, observation.tenantId),
        eq(integrationOperations.id, refs.integrationOperationId),
        eq(integrationOperations.integrationId, observation.integrationId),
        eq(integrationOperations.businessEffectId, observation.businessEffectId),
        ...(observation.classification === "present"
          ? []
          : [sql`${integrationOperations.verificationStatus} <> 'verified'`]),
      )).returning({ id: integrationOperations.id });
      if (!legacyOperation && currentEffect.status !== "verified") {
        const [exists] = await db.select({ id: integrationOperations.id }).from(integrationOperations).where(and(
          eq(integrationOperations.tenantId, observation.tenantId),
          eq(integrationOperations.id, refs.integrationOperationId),
          eq(integrationOperations.integrationId, observation.integrationId),
          eq(integrationOperations.businessEffectId, observation.businessEffectId),
        )).limit(1);
        if (!exists) throw new Error("Observation does not bind to the exact legacy integration operation/account/effect");
      }
    }

    if (observation.externalId) await db.update(externalRefs).set({
      lastEffectId: observation.businessEffectId,
      updatedAt: new Date(),
    }).where(and(
      eq(externalRefs.tenantId, observation.tenantId),
      eq(externalRefs.integrationId, observation.integrationId),
      eq(externalRefs.externalObjectType, observation.externalObjectType),
      eq(externalRefs.externalId, observation.externalId),
    ));

    const members = await db.select().from(externalOperations).where(and(
      eq(externalOperations.tenantId, observation.tenantId),
      eq(externalOperations.businessEffectId, observation.businessEffectId),
    ));
    const summary = operationMemberSummary(members);
    // Historical protocol-1 effects may have only the aggregate integration row.
    if (summary.memberCount === 0) {
      summary.memberCount = 1;
      if (observation.classification === "present") summary.verifiedCount = 1;
      else if (observation.classification === "absent") summary.knownFailedCount = 1;
      else if (observation.classification === "divergent") summary.divergentCount = 1;
      else summary.uncertainCount = 1;
    }

    const immutableVerified = currentEffect.status === "verified";
    const immutableCompensated = currentEffect.status === "compensated";
    const allVerified = immutableVerified || summary.verifiedCount === summary.memberCount;
    const aggregateState = immutableVerified ? "verified" as const
      : immutableCompensated ? "compensated" as const
        : summary.divergentCount > 0 ? "divergent" as const
          : summary.uncertainCount > 0 ? "reconciliation_required" as const
            : allVerified ? "verified" as const
              : summary.knownFailedCount === summary.memberCount ? "failed" as const
                : "partially_verified" as const;
    const verificationState = aggregateState === "verified" ? "verified" as const
      : aggregateState === "divergent" ? "divergent" as const
        : aggregateState === "reconciliation_required" ? "reconciliation_required" as const
          : aggregateState === "partially_verified" ? "partially_verified" as const
            : "unverified" as const;
    const verification = {
      state: verificationState,
      basis: aggregateState === "verified"
        ? "Every logical provider-operation member is verified against its exact provider/account target"
        : aggregateState === "divergent"
          ? "At least one logical provider-operation member diverges from the authorized intent"
          : aggregateState === "reconciliation_required"
            ? "At least one logical provider-operation member remains uncertain; replay is prohibited"
            : aggregateState === "partially_verified"
              ? "BusinessEffect members are only partially settled; verified members remain final and are not replay candidates"
              : aggregateState === "compensated"
                ? "The original effect remains in compensated history"
                : "Every settled logical provider-operation member is known not to have produced the intended state",
      checkedAt: checkedAt.toISOString(),
      observed: {
        latestObservation: observation,
        operationMembers: summary,
        exactExternalOperationId,
      },
    };

    if (!immutableVerified && !immutableCompensated) await db.update(businessEffects).set({
      status: aggregateState,
      observedResult: { latestObservation: observation, operationMembers: summary },
      verification,
      observedAt: checkedAt,
    }).where(and(
      eq(businessEffects.tenantId, observation.tenantId),
      eq(businessEffects.id, observation.businessEffectId),
    ));

    const hasTerminalProblem = summary.divergentCount > 0
      || summary.uncertainCount > 0
      || summary.knownFailedCount > 0
      || summary.compensatedCount > 0;
    const actionStatus = allVerified ? "completed" as const
      : hasTerminalProblem ? "needs_human_review" as const
        : "executing" as const;
    await db.update(domainActions).set({
      status: actionStatus,
      ...(actionStatus === "executing" ? {} : { executionStartedAt: null }),
    }).where(and(
      eq(domainActions.tenantId, observation.tenantId),
      eq(domainActions.id, loaded.effectActionId!),
      inArray(domainActions.status, ["executing", "needs_human_review", "blocked_integration_unavailable", "failed"]),
    ));
    await db.update(decisionReceipts).set({ executedEffectHash: loaded.semanticHash, verification }).where(and(
      eq(decisionReceipts.tenantId, observation.tenantId),
      eq(decisionReceipts.businessEffectId, observation.businessEffectId),
    ));

    const resolutionOutcome = observation.classification === "present" ? "happened_as_intended" as const
      : observation.classification === "absent" ? "definitely_did_not_happen" as const
        : null;
    if (resolutionOutcome && exactExternalOperationId) {
      await db.update(reconciliationCases).set({
        status: "resolved",
        resolution: { classification: observation.classification, observedAt: checkedAt.toISOString() },
        resolutionOutcome,
        resolutionEvidence: { observation, exactExternalOperationId },
        resolvedBy: "system:external-observer",
        resolutionProvider: String(observation.provider),
        resolutionIntegrationId: observation.integrationId,
        resolvedAt: new Date(),
        version: sql`${reconciliationCases.version} + 1`,
      }).where(and(
        eq(reconciliationCases.tenantId, observation.tenantId),
        eq(reconciliationCases.relatedExternalOperationId, exactExternalOperationId),
        eq(reconciliationCases.status, "open"),
      ));
    }
    if (allVerified) {
      await db.update(reconciliationCases).set({
        status: "resolved",
        resolution: { classification: "present", observedAt: checkedAt.toISOString(), aggregate: summary },
        resolutionOutcome: "happened_as_intended",
        resolutionEvidence: { observation, operationMembers: summary },
        resolvedBy: "system:external-observer",
        resolutionProvider: String(observation.provider),
        resolutionIntegrationId: observation.integrationId,
        resolvedAt: new Date(),
        version: sql`${reconciliationCases.version} + 1`,
      }).where(and(
        eq(reconciliationCases.tenantId, observation.tenantId),
        eq(reconciliationCases.businessEffectId, observation.businessEffectId),
        eq(reconciliationCases.status, "open"),
      ));
    } else if (observation.classification === "divergent" || observation.classification === "unknown") {
      const openPredicate = exactExternalOperationId
        ? and(
            eq(reconciliationCases.tenantId, observation.tenantId),
            eq(reconciliationCases.relatedExternalOperationId, exactExternalOperationId),
            eq(reconciliationCases.status, "open"),
          )
        : and(
            eq(reconciliationCases.tenantId, observation.tenantId),
            eq(reconciliationCases.businessEffectId, observation.businessEffectId),
            eq(reconciliationCases.status, "open"),
          );
      const [open] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(openPredicate).limit(1);
      if (!open) await db.insert(reconciliationCases).values({
        tenantId: observation.tenantId,
        caseType: observation.classification === "divergent" ? "external_drift" : "unknown_delivery",
        businessEffectId: observation.businessEffectId,
        integrationId: observation.integrationId,
        relatedExternalOperationId: exactExternalOperationId,
        classification: observation.classification === "divergent" ? "operation_after_state_mismatch" : "operation_observation_inconclusive",
        authoritativeSide: "external",
        details: { observation, operationMembers: summary },
      });
    }

    const steps = await db.select({
      id: workflowSteps.id,
      runId: workflowSteps.workflowRunId,
      status: workflowSteps.status,
      dispatchGeneration: workflowSteps.dispatchGeneration,
    }).from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, observation.tenantId),
      eq(workflowSteps.businessEffectId, observation.businessEffectId),
    ));
    return { aggregateState, allVerified, hasTerminalProblem, verification, summary, steps };
  });

  // Observation settlement owns only waiting-observation steps. If evidence races a
  // still-leased worker, the durable member truth is already stored; that worker must
  // consult it before parking/completing under its own claim fence.
  for (const step of settlement.steps) {
    if (step.status !== "waiting_observation") continue;
    const fence: StepObservationFence = { kind: "observation", dispatchGeneration: step.dispatchGeneration };
    if (settlement.allVerified) {
      await completeStep(observation.tenantId, step.id, {
        latestObservation: observation,
        verification: settlement.verification,
        operationMembers: settlement.summary,
      }, fence);
      await advanceWorkflow(observation.tenantId, step.runId);
    } else if (settlement.hasTerminalProblem) {
      const unknown = settlement.aggregateState === "reconciliation_required";
      await failStep(
        observation.tenantId,
        step.id,
        settlement.verification.basis,
        unknown ? "unknown_outcome" : settlement.aggregateState === "divergent" ? "conflict" : "retryable",
        fence,
        unknown || settlement.aggregateState === "divergent" ? "reconciling" : "failed_after_possible_effect",
      );
      await advanceWorkflow(observation.tenantId, step.runId);
    }
  }

  await ingestIntegrationEvent({
    tenantId: observation.tenantId,
    source: String(observation.provider),
    provider: String(observation.provider),
    sourceEventId: refs.providerEventId
      ?? `effect-observation:${observation.businessEffectId}:${refs.externalOperationKey ?? refs.integrationOperationId}:${observation.observedAt}`,
    eventType: `effect.${observation.classification}`,
    occurredAt: checkedAt,
    domainActionId: loaded.effectActionId,
    applicationRef: observation.integrationId,
    correlationId: observation.businessEffectId,
    payload: {
      businessEffectId: observation.businessEffectId,
      logicalOperationKey: refs.externalOperationKey ?? null,
      classification: observation.classification,
      externalObjectType: observation.externalObjectType,
      operationMembers: settlement.summary,
    },
    evidenceRefs: observation.externalId ? [{ kind: "provider_object", ref: observation.externalId }] : [],
    trustClass: "trusted_runtime",
  });
  if (loaded.actionWorkId) await reconcileWorkStatus(observation.tenantId, loaded.actionWorkId);
  await resumeObjectiveForAction(observation.tenantId, loaded.effectActionId);
}
