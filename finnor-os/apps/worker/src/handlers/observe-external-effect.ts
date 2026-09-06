import {
  businessEffects,
  enqueueJobAt,
  externalOperations,
  integrationOperations,
  tenantIntegrations,
  withTenant,
  workflowSteps,
} from "@finnor/db";
import { materializeSourceRecord, observeExternalEffect } from "@finnor/data-platform";
import { createSourceAdapterRegistry, IntegrationError } from "@finnor/tools";
import { settleExternalEffectObservation } from "@finnor/orchestration";
import type { BusinessEffectSet, ExternalEffectObservation } from "@finnor/shared-types";
import { and, eq, ne, sql } from "drizzle-orm";
import type { JobHandler } from "../queue";
import { loadSourceCredentialContext } from "./sync-source";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


async function reschedule(
  payload: Record<string, unknown>,
  tenantId: string,
  operationIdentity: string,
  attempt: number,
): Promise<void> {
  const next = attempt + 1;
  const seconds = Math.min(300, 5 * 2 ** Math.min(attempt - 1, 6));
  await enqueueJobAt(
    "observe_external_effect",
    { ...payload, attempt: next },
    new Date(Date.now() + seconds * 1000),
    `observe-effect:${tenantId}:${operationIdentity}:${next}`,
  );
}

async function pendingEffectObservations(tenantId: string, businessEffectId: string): Promise<number> {
  const [external, integration] = await Promise.all([
    withTenant(tenantId, (db) => db.select({ id: externalOperations.domainActionId }).from(externalOperations).where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.businessEffectId, businessEffectId),
      eq(externalOperations.status, "succeeded"),
      sql`${externalOperations.integrationId} IS NOT NULL`,
      ne(externalOperations.verificationStatus, "verified"),
    ))),
    withTenant(tenantId, (db) => db.select({ id: integrationOperations.id }).from(integrationOperations).where(and(
      eq(integrationOperations.tenantId, tenantId),
      eq(integrationOperations.businessEffectId, businessEffectId),
      eq(integrationOperations.status, "succeeded"),
      sql`${integrationOperations.integrationId} IS NOT NULL`,
      ne(integrationOperations.verificationStatus, "verified"),
    ))),
  ]);
  return external.length + integration.length;
}

export const observeExternalEffectHandler: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  const integrationOperationId = typeof payload.integrationOperationId === "string" ? payload.integrationOperationId : undefined;
  const domainActionId = typeof payload.domainActionId === "string" ? payload.domainActionId : undefined;
  const externalOperationKey = typeof payload.externalOperationKey === "string" ? payload.externalOperationKey : undefined;
  const finalizeOnly = payload.finalizeOnly === true;
  const attempt = Math.max(1, Number(payload.attempt ?? 1));
  if (!tenantId || (!integrationOperationId && !(domainActionId && externalOperationKey))) {
    throw new Error("observe_external_effect requires an exact integration or external operation identity");
  }

  const operation = integrationOperationId
    ? (await withTenant(tenantId, (db) => db.select({
        businessEffectId: integrationOperations.businessEffectId,
        integrationId: integrationOperations.integrationId,
        provider: integrationOperations.provider,
        response: integrationOperations.response,
        observation: integrationOperations.observation,
        verificationStatus: integrationOperations.verificationStatus,
        workflowStepId: integrationOperations.workflowStepId,
      }).from(integrationOperations).where(and(
        eq(integrationOperations.tenantId, tenantId),
        eq(integrationOperations.id, integrationOperationId),
      )).limit(1)))[0]
    : (await withTenant(tenantId, (db) => db.select({
        businessEffectId: externalOperations.businessEffectId,
        integrationId: externalOperations.integrationId,
        provider: externalOperations.provider,
        response: externalOperations.response,
        observation: externalOperations.observation,
        verificationStatus: externalOperations.verificationStatus,
        workflowStepId: workflowSteps.id,
      }).from(externalOperations).leftJoin(workflowSteps, and(
        eq(workflowSteps.tenantId, tenantId),
        eq(workflowSteps.businessEffectId, externalOperations.businessEffectId),
      )).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.domainActionId, domainActionId!),
        eq(externalOperations.operationKey, externalOperationKey!),
      )).limit(1)))[0];
  if (!operation?.businessEffectId || !operation.integrationId || !operation.provider) return;
  if (operation.verificationStatus === "divergent" || (operation.verificationStatus === "verified" && !finalizeOnly)) return;

  const [effectRow, integration] = await Promise.all([
    withTenant(tenantId, (db) => db.select({ effect: businessEffects.effect }).from(businessEffects).where(and(
      eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, operation.businessEffectId!),
    )).limit(1)).then((rows) => rows[0]),
    withTenant(tenantId, (db) => db.select().from(tenantIntegrations).where(and(
      eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, operation.integrationId!),
    )).limit(1)).then((rows) => rows[0]),
  ]);
  if (!effectRow || !integration || integration.binding !== operation.provider) throw new Error("Observation operation/effect/integration linkage is invalid");
  if (finalizeOnly && operation.verificationStatus === "verified") {
    const remaining = await pendingEffectObservations(tenantId, operation.businessEffectId);
    if (remaining > 0) {
      if (attempt < 10) return reschedule(payload, tenantId, integrationOperationId ?? `${domainActionId}:${externalOperationKey}`, attempt);
      const prior = object(operation.observation) as unknown as ExternalEffectObservation;
      await settleExternalEffectObservation({
        tenantId,
        businessEffectId: operation.businessEffectId,
        integrationId: integration.id,
        provider: integration.binding,
        externalObjectType: typeof prior.externalObjectType === "string" ? prior.externalObjectType : "unknown",
        observedAt: new Date().toISOString(),
        classification: "unknown",
        expected: {},
        evidence: { mechanism: "poll" },
      }, { integrationOperationId, domainActionId, externalOperationKey });
      return;
    }
    const prior = object(operation.observation) as unknown as ExternalEffectObservation;
    if (prior.classification !== "present") return;
    await settleExternalEffectObservation(prior, { integrationOperationId, domainActionId, externalOperationKey });
    return;
  }
  const registry = createSourceAdapterRegistry();
  let adapter;
  try {
    adapter = registry.get(integration.binding);
  } catch (error) {
    if (attempt < 5) return reschedule(payload, tenantId, integrationOperationId ?? `${domainActionId}:${externalOperationKey}`, attempt);
    await settleExternalEffectObservation({
      tenantId,
      businessEffectId: operation.businessEffectId,
      integrationId: integration.id,
      provider: integration.binding,
      externalObjectType: "unknown",
      observedAt: new Date().toISOString(),
      classification: "unknown",
      expected: {},
      evidence: { mechanism: "poll" },
    }, { integrationOperationId, domainActionId, externalOperationKey });
    return;
  }

  const effect = effectRow.effect as BusinessEffectSet;
  const target = adapter.observationTarget?.(object(operation.response), effect) ?? null;
  if (!target) {
    if (attempt < 5) return reschedule(payload, tenantId, integrationOperationId ?? `${domainActionId}:${externalOperationKey}`, attempt);
    await settleExternalEffectObservation({
      tenantId, businessEffectId: operation.businessEffectId, integrationId: integration.id, provider: integration.binding,
      externalObjectType: "unknown", observedAt: new Date().toISOString(), classification: "unknown", expected: {},
      evidence: { mechanism: "poll" },
    }, { integrationOperationId, domainActionId, externalOperationKey });
    return;
  }

  try {
    const credentialContext = await loadSourceCredentialContext(tenantId, {
      ...integration,
      binding: integration.binding,
    } as Parameters<typeof loadSourceCredentialContext>[1]);
    let record = await adapter.readObject(target.objectType, target.externalId, {
      tenantId, integrationId: integration.id, config: object(integration.config), credentialContext,
    });
    if ((!record || (adapter.isTerminalObservation && !adapter.isTerminalObservation(record))) && attempt < 8) {
      return reschedule(payload, tenantId, integrationOperationId ?? `${domainActionId}:${externalOperationKey}`, attempt);
    }
    if (record) {
      record = { ...record, businessEffectId: operation.businessEffectId };
      if (record.materialization === "observe_only") {
        await withTenant(tenantId, (db) => materializeSourceRecord(db, record!));
      }
    }
    const observation = observeExternalEffect({
      tenantId,
      businessEffectId: operation.businessEffectId,
      integrationId: integration.id,
      provider: integration.binding,
      externalObjectType: target.objectType,
      externalId: target.externalId,
      observedAt: record?.observedAt ?? new Date().toISOString(),
      expected: target.expected,
      observed: record?.data,
      definitelyAbsent: !record && attempt >= 5,
      evidence: { mechanism: "read_after_write" },
    });
    if (observation.classification === "present") {
      const operationPatch = {
        externalObservedAt: new Date(observation.observedAt),
        verificationStatus: "verified" as const,
        observation,
        updatedAt: new Date(),
      };
      if (integrationOperationId) await withTenant(tenantId, (db) => db.update(integrationOperations).set(operationPatch).where(and(
        eq(integrationOperations.tenantId, tenantId),
        eq(integrationOperations.id, integrationOperationId),
        eq(integrationOperations.businessEffectId, operation.businessEffectId!),
      )));
      if (externalOperationKey && domainActionId) await withTenant(tenantId, (db) => db.update(externalOperations).set(operationPatch).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.domainActionId, domainActionId),
        eq(externalOperations.operationKey, externalOperationKey),
        eq(externalOperations.businessEffectId, operation.businessEffectId!),
      )));
      const remaining = await pendingEffectObservations(tenantId, operation.businessEffectId);
      if (remaining > 0) {
        await reschedule({ ...payload, finalizeOnly: true }, tenantId, integrationOperationId ?? `${domainActionId}:${externalOperationKey}`, attempt);
        return;
      }
    }
    await settleExternalEffectObservation(observation, { integrationOperationId, domainActionId, externalOperationKey });
  } catch (error) {
    const retryable = error instanceof IntegrationError && error.retryable;
    if (retryable && attempt < 8) return reschedule(payload, tenantId, integrationOperationId ?? `${domainActionId}:${externalOperationKey}`, attempt);
    throw error;
  }
};
