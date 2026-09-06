// Provider-neutral reconciliation intake. Domain materialization belongs to an
// explicitly registered active vertical mapper; this handler records durable source
// evidence and wakes only exact effect observers.

import { enqueueJob, resolveTenantVertical } from "@finnor/db";
import { ingestIntegrationEvent } from "@finnor/orchestration";
import { logWithTrace } from "@finnor/tools";
import type { JobHandler } from "../queue";

export const reconciliation: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const providerEventId = typeof payload.providerEventId === "string"
    ? payload.providerEventId
    : typeof payload._providerEventId === "string" ? payload._providerEventId : "";
  const eventType = typeof payload.eventType === "string"
    ? payload.eventType
    : typeof payload.type === "string" ? payload.type : "unknown";
  if (!tenantId || !provider || !providerEventId) {
    throw new Error("reconciliation requires tenantId, provider, and providerEventId");
  }
  await resolveTenantVertical(tenantId);

  await ingestIntegrationEvent({
    tenantId,
    source: provider,
    provider,
    sourceEventId: providerEventId,
    eventType: `${provider}.${eventType.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 180)}`,
    occurredAt: typeof payload.occurredAt === "string" ? new Date(payload.occurredAt) : new Date(),
    providerConversationId: typeof payload.providerConversationId === "string" ? payload.providerConversationId : null,
    applicationRef: typeof payload.integrationId === "string" ? payload.integrationId : null,
    correlationId: typeof payload.correlationId === "string" ? payload.correlationId : null,
    payload: { provider, eventType, quarantinedBusinessMaterialization: true },
    trustClass: "untrusted_external",
  });

  const observationJobs = Array.isArray(payload.observationJobs) ? payload.observationJobs : [];
  for (const candidate of observationJobs) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const job = candidate as Record<string, unknown>;
    const identity = typeof job.integrationOperationId === "string"
      ? job.integrationOperationId
      : typeof job.domainActionId === "string" && typeof job.externalOperationKey === "string"
        ? `${job.domainActionId}:${job.externalOperationKey}`
        : null;
    if (!identity) continue;
    await enqueueJob(
      "observe_external_effect",
      { tenantId, ...job, attempt: 99 },
      `observe-webhook:${tenantId}:${providerEventId}:${identity}`,
    );
  }
  logWithTrace({ traceId: payload._correlationId as string | undefined }).info(
    { tenantId, provider, eventType, materialized: false },
    "[reconciliation] recorded provider event without domain mutation",
  );
}
