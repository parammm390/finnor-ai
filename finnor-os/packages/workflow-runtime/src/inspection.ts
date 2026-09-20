import {
  businessEffects,
  commands,
  compensationCases,
  deadLetters,
  decisionReceipts,
  domainActions,
  externalOperations,
  inboxEvents,
  integrationEvents,
  jobDeliveryAttempts,
  jobs,
  outboxEvents,
  providerInvocations,
  providerOperationAttempts,
  reconciliationCases,
  runtimeOperatorControls,
  withTenant,
  workflowRuns,
  workflowStepClaims,
  workflowSteps,
  workEventWaits,
  workWakeClaims,
} from "@finnor/db";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

export interface RuntimeTruthSelector {
  workId?: string;
  businessEffectId?: string;
  workflowRunId?: string;
  workflowStepId?: string;
  externalOperationId?: string;
  limit?: number;
}

export interface RuntimeTruthInspection {
  tenantId: string;
  selector: RuntimeTruthSelector;
  commands: unknown[];
  workflowRuns: unknown[];
  workflowSteps: unknown[];
  workflowStepClaims: unknown[];
  decisionReceipts: unknown[];
  jobs: unknown[];
  jobDeliveryAttempts: unknown[];
  businessEffects: unknown[];
  logicalProviderOperations: unknown[];
  providerOperationAttempts: unknown[];
  physicalProviderInvocations: unknown[];
  reconciliationCases: unknown[];
  compensationCases: unknown[];
  runtimeOperatorControls: unknown[];
  inboxEvents: unknown[];
  historicalOutboxEvents: unknown[];
  deadLetters: unknown[];
  durableWaits: unknown[];
  integrationEvents: unknown[];
  wakeClaims: unknown[];
  read: { perCollectionLimit: number; bounded: true; possiblyTruncatedCollections: string[] };
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function clipped<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Tenant-scoped canonical runtime inspection. This is a read model over the owners
 * themselves, not a new truth ledger: operators can traverse semantic intent,
 * physical delivery, logical operation, every physical invocation, observation,
 * reconciliation, signals and governed controls without reconstructing log order. */
export async function inspectRuntimeTruth(
  tenantId: string,
  selector: RuntimeTruthSelector,
): Promise<RuntimeTruthInspection> {
  if (!selector.workId && !selector.businessEffectId && !selector.workflowRunId
      && !selector.workflowStepId && !selector.externalOperationId) {
    throw new Error("Runtime inspection requires a Work, BusinessEffect, run, step, or logical operation selector");
  }
  const limit = Math.max(1, Math.min(selector.limit ?? 200, 500));
  const queryLimit = limit + 1;

  return withTenant(tenantId, async (db) => {
    const initialOperations = selector.externalOperationId
      ? await db.select().from(externalOperations).where(and(
          eq(externalOperations.tenantId, tenantId),
          eq(externalOperations.id, selector.externalOperationId),
        )).limit(queryLimit)
      : [];
    const initialEffects = selector.businessEffectId
      ? await db.select().from(businessEffects).where(and(
          eq(businessEffects.tenantId, tenantId),
          eq(businessEffects.id, selector.businessEffectId),
        )).limit(queryLimit)
      : [];
    const workActions = selector.workId
      ? await db.select().from(domainActions).where(and(
          eq(domainActions.tenantId, tenantId),
          eq(domainActions.workId, selector.workId),
        )).orderBy(asc(domainActions.createdAt), asc(domainActions.id)).limit(queryLimit)
      : [];
    const actionIds = unique([
      ...workActions.map((row) => row.id),
      ...initialEffects.map((row) => row.domainActionId),
      ...initialOperations.map((row) => row.domainActionId),
    ]);
    const effectIds = unique([
      selector.businessEffectId,
      ...initialEffects.map((row) => row.id),
      ...initialOperations.map((row) => row.businessEffectId),
      ...workActions.map((row) => row.businessEffectId),
    ]);

    const stepSeedConditions = [
      selector.workflowStepId ? eq(workflowSteps.id, selector.workflowStepId) : undefined,
      effectIds.length ? inArray(workflowSteps.businessEffectId, effectIds) : undefined,
      actionIds.length ? inArray(workflowSteps.domainActionId, actionIds) : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const seedSteps = stepSeedConditions.length
      ? await db.select().from(workflowSteps).where(and(
          eq(workflowSteps.tenantId, tenantId),
          or(...stepSeedConditions),
        )).orderBy(asc(workflowSteps.createdAt), asc(workflowSteps.id)).limit(queryLimit)
      : [];
    const seedRunIds = unique([selector.workflowRunId, ...seedSteps.map((row) => row.workflowRunId)]);
    const runConditions = [
      seedRunIds.length ? inArray(workflowRuns.id, seedRunIds) : undefined,
      selector.workId ? eq(workflowRuns.workId, selector.workId) : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const runRows = runConditions.length
      ? await db.select().from(workflowRuns).where(and(
          eq(workflowRuns.tenantId, tenantId),
          or(...runConditions),
        )).orderBy(asc(workflowRuns.createdAt), asc(workflowRuns.id)).limit(queryLimit)
      : [];
    const runIds = unique([...seedRunIds, ...runRows.map((row) => row.id)]);
    const allStepConditions = [
      runIds.length ? inArray(workflowSteps.workflowRunId, runIds) : undefined,
      ...stepSeedConditions,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const stepRows = allStepConditions.length
      ? await db.select().from(workflowSteps).where(and(
          eq(workflowSteps.tenantId, tenantId),
          or(...allStepConditions),
        )).orderBy(asc(workflowSteps.createdAt), asc(workflowSteps.id)).limit(queryLimit)
      : [];
    const stepIds = unique(stepRows.map((row) => row.id));
    const allActionIds = unique([...actionIds, ...stepRows.map((row) => row.domainActionId)]);
    const allEffectIds = unique([...effectIds, ...stepRows.map((row) => row.businessEffectId)]);
    const commandIds = unique(runRows.map((row) => row.commandId));
    const commandRows = commandIds.length
      ? await db.select().from(commands).where(and(
          eq(commands.tenantId, tenantId),
          inArray(commands.id, commandIds),
        )).orderBy(asc(commands.createdAt), asc(commands.id)).limit(queryLimit)
      : [];
    const receiptRows = stepIds.length
      ? await db.select().from(decisionReceipts).where(and(
          eq(decisionReceipts.tenantId, tenantId),
          inArray(decisionReceipts.workflowStepId, stepIds),
        )).orderBy(asc(decisionReceipts.createdAt), asc(decisionReceipts.id)).limit(queryLimit)
      : [];
    const claimRows = stepIds.length
      ? await db.select().from(workflowStepClaims).where(and(
          eq(workflowStepClaims.tenantId, tenantId),
          inArray(workflowStepClaims.workflowStepId, stepIds),
        )).orderBy(asc(workflowStepClaims.claimedAt), asc(workflowStepClaims.id)).limit(queryLimit)
      : [];
    const effectRows = allEffectIds.length
      ? await db.select().from(businessEffects).where(and(
          eq(businessEffects.tenantId, tenantId),
          inArray(businessEffects.id, allEffectIds),
        )).orderBy(asc(businessEffects.createdAt), asc(businessEffects.id)).limit(queryLimit)
      : [];
    const operationConditions = [
      selector.externalOperationId ? eq(externalOperations.id, selector.externalOperationId) : undefined,
      allEffectIds.length ? inArray(externalOperations.businessEffectId, allEffectIds) : undefined,
      allActionIds.length ? inArray(externalOperations.domainActionId, allActionIds) : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const operationRows = operationConditions.length
      ? await db.select().from(externalOperations).where(and(
          eq(externalOperations.tenantId, tenantId),
          or(...operationConditions),
        )).orderBy(asc(externalOperations.createdAt), asc(externalOperations.id)).limit(queryLimit)
      : [];
    const operationIds = unique(operationRows.map((row) => row.id));
    const providerAttemptRows = operationIds.length
      ? await db.select().from(providerOperationAttempts).where(and(
          eq(providerOperationAttempts.tenantId, tenantId),
          inArray(providerOperationAttempts.externalOperationId, operationIds),
        )).orderBy(asc(providerOperationAttempts.startedAt), asc(providerOperationAttempts.id)).limit(queryLimit)
      : [];
    const providerAttemptIds = unique(providerAttemptRows.map((row) => row.id));
    const invocationRows = providerAttemptIds.length
      ? await db.select().from(providerInvocations).where(and(
          eq(providerInvocations.tenantId, tenantId),
          inArray(providerInvocations.providerOperationAttemptId, providerAttemptIds),
        )).orderBy(asc(providerInvocations.startedAt), asc(providerInvocations.id)).limit(queryLimit)
      : [];

    const workIds = unique([selector.workId, ...runRows.map((row) => row.workId)]);
    const waitRows = workIds.length
      ? await db.select().from(workEventWaits).where(and(
          eq(workEventWaits.tenantId, tenantId),
          inArray(workEventWaits.workId, workIds),
        )).orderBy(asc(workEventWaits.createdAt), asc(workEventWaits.id)).limit(queryLimit)
      : [];
    const waitIds = unique(waitRows.map((row) => row.id));
    const wakeRows = waitIds.length
      ? await db.select().from(workWakeClaims).where(and(
          eq(workWakeClaims.tenantId, tenantId),
          inArray(workWakeClaims.waitId, waitIds),
        )).orderBy(asc(workWakeClaims.claimedAt), asc(workWakeClaims.id)).limit(queryLimit)
      : [];
    const eventIds = unique([
      ...waitRows.map((row) => row.matchedEventId),
      ...wakeRows.map((row) => row.integrationEventId),
    ]);
    const eventConditions = [
      workIds.length ? inArray(integrationEvents.workId, workIds) : undefined,
      eventIds.length ? inArray(integrationEvents.id, eventIds) : undefined,
      allActionIds.length ? inArray(integrationEvents.domainActionId, allActionIds) : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const eventRows = eventConditions.length
      ? await db.select().from(integrationEvents).where(and(
          eq(integrationEvents.tenantId, tenantId),
          or(...eventConditions),
        )).orderBy(asc(integrationEvents.receivedAt), asc(integrationEvents.id)).limit(queryLimit)
      : [];

    const wakeJobIds = unique(wakeRows.map((row) => row.jobId));
    const operationKeys = unique(operationRows.map((row) => row.operationKey));
    const jobConditions = [
      stepIds.length ? inArray(sql<string>`${jobs.payload}->>'workflowStepId'`, stepIds) : undefined,
      wakeJobIds.length ? inArray(jobs.id, wakeJobIds) : undefined,
      operationKeys.length ? and(
        eq(jobs.tenantId, tenantId),
        inArray(sql<string>`${jobs.payload}->>'externalOperationKey'`, operationKeys),
      ) : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const jobRows = jobConditions.length
      ? await db.select().from(jobs).where(or(...jobConditions))
          .orderBy(asc(jobs.runAt), asc(jobs.id)).limit(queryLimit)
      : [];
    const jobIds = unique(jobRows.map((row) => row.id));
    const deliveryRows = jobIds.length
      ? await db.select().from(jobDeliveryAttempts).where(inArray(jobDeliveryAttempts.jobId, jobIds))
          .orderBy(asc(jobDeliveryAttempts.startedAt), asc(jobDeliveryAttempts.id)).limit(queryLimit)
      : [];
    const inboxRows = stepIds.length
      ? await db.select().from(inboxEvents).where(and(
          eq(inboxEvents.tenantId, tenantId),
          inArray(inboxEvents.matchedStepId, stepIds),
        )).orderBy(asc(inboxEvents.receivedAt), asc(inboxEvents.id)).limit(queryLimit)
      : [];
    const outboxRows = stepIds.length
      ? await db.select().from(outboxEvents).where(and(
          eq(outboxEvents.tenantId, tenantId),
          inArray(outboxEvents.workflowStepId, stepIds),
        )).orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id)).limit(queryLimit)
      : [];
    const deadLetterRows = stepIds.length
      ? await db.select().from(deadLetters).where(and(
          eq(deadLetters.tenantId, tenantId),
          inArray(deadLetters.relatedWorkflowStepId, stepIds),
        )).orderBy(asc(deadLetters.createdAt), asc(deadLetters.id)).limit(queryLimit)
      : [];
    const reconciliationConditions = [
      stepIds.length ? inArray(reconciliationCases.relatedStepId, stepIds) : undefined,
      operationIds.length ? inArray(reconciliationCases.relatedExternalOperationId, operationIds) : undefined,
      allEffectIds.length ? inArray(reconciliationCases.businessEffectId, allEffectIds) : undefined,
    ].filter((condition): condition is Exclude<typeof condition, undefined> => Boolean(condition));
    const reconciliationRows = reconciliationConditions.length
      ? await db.select().from(reconciliationCases).where(and(
          eq(reconciliationCases.tenantId, tenantId),
          or(...reconciliationConditions),
        )).orderBy(asc(reconciliationCases.createdAt), asc(reconciliationCases.id)).limit(queryLimit)
      : [];
    const compensationRows = stepIds.length
      ? await db.select().from(compensationCases).where(and(
          eq(compensationCases.tenantId, tenantId),
          inArray(compensationCases.workflowStepId, stepIds),
        )).orderBy(asc(compensationCases.createdAt), asc(compensationCases.id)).limit(queryLimit)
      : [];
    const controlTargetIds = unique([
      ...stepIds,
      ...deadLetterRows.map((row) => row.id),
      ...reconciliationRows.map((row) => row.id),
      ...compensationRows.map((row) => row.id),
    ]);
    const controlRows = controlTargetIds.length
      ? await db.select().from(runtimeOperatorControls).where(and(
          eq(runtimeOperatorControls.tenantId, tenantId),
          inArray(runtimeOperatorControls.targetId, controlTargetIds),
        )).orderBy(asc(runtimeOperatorControls.createdAt), asc(runtimeOperatorControls.id)).limit(queryLimit)
      : [];

    const collections = {
      commands: clipped(commandRows, limit),
      workflowRuns: clipped(runRows, limit),
      workflowSteps: clipped(stepRows, limit),
      workflowStepClaims: clipped(claimRows, limit),
      decisionReceipts: clipped(receiptRows, limit),
      jobs: clipped(jobRows, limit),
      jobDeliveryAttempts: clipped(deliveryRows, limit),
      businessEffects: clipped(effectRows, limit),
      logicalProviderOperations: clipped(operationRows, limit),
      providerOperationAttempts: clipped(providerAttemptRows, limit),
      physicalProviderInvocations: clipped(invocationRows, limit),
      reconciliationCases: clipped(reconciliationRows, limit),
      compensationCases: clipped(compensationRows, limit),
      runtimeOperatorControls: clipped(controlRows, limit),
      inboxEvents: clipped(inboxRows, limit),
      historicalOutboxEvents: clipped(outboxRows, limit),
      deadLetters: clipped(deadLetterRows, limit),
      durableWaits: clipped(waitRows, limit),
      integrationEvents: clipped(eventRows, limit),
      wakeClaims: clipped(wakeRows, limit),
    };
    return {
      tenantId,
      selector: { ...selector, limit },
      ...Object.fromEntries(Object.entries(collections).map(([name, value]) => [name, value.rows])),
      read: {
        perCollectionLimit: limit,
        bounded: true as const,
        possiblyTruncatedCollections: Object.entries(collections).filter(([, value]) => value.truncated).map(([name]) => name),
      },
    } as RuntimeTruthInspection;
  });
}
