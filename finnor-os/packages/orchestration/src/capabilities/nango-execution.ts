import { sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@finnor/db";
import { persistProviderObservationTx, sourceTruthHash } from "@finnor/data-platform";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import { NangoReadOnlyClient, NangoSourceBindingSchema } from "@finnor/tools/nango";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import type { ProviderObservation } from "@finnor/shared-types";
import type { CapabilityActor, CapabilityRun } from "./contracts";
import type { ProviderStep } from "./provider-step";
import { assertCurrentClaim, type CapabilityJobClaim } from "./job-claim";
import { assertCapabilityAuthorityRevision, authorizeCapability, capabilityDigest, requireActiveCapabilityPrincipal } from "./policy";
import { appendCapabilityEvent } from "./repository";
import { loadNangoBinding } from "./nango-bindings";
import { reconcileNangoConnection } from "./nango-lifecycle";

const stateSchema = z.object({ provider: z.literal("nango"), phase: z.literal("accepted"), binding: NangoSourceBindingSchema,
  polls: z.number().int().min(0).max(64), records: z.number().int().nonnegative(), pageEventIds: z.array(z.string()).max(64) }).strict();
const checkpointSchema = z.object({ cursor: z.string().nullable(), revision: z.coerce.number().int().nonnegative(), history_limited: z.boolean() });

export async function executeNangoStep(actor: CapabilityActor, run: CapabilityRun, claim: CapabilityJobClaim): Promise<ProviderStep> {
  const request = run.request;
  if (request.kind !== "nango_sync") throw new CapabilityEngineError("NANGO_REQUEST_KIND_INVALID");
  const state = stateSchema.parse(run.remoteState), binding = state.binding, deadlineAt = Date.parse(run.deadlineAt);
  if (capabilityDigest({ request, sources: run.sources, providerBinding: binding }) !== run.requestDigest) throw new CapabilityEngineError("NANGO_ACCEPTED_BINDING_MISMATCH");
  if (state.polls >= 64) throw new CapabilityEngineError("NANGO_SYNC_PAGE_LIMIT");
  const health = await reconcileNangoConnection(actor, { providerConfigKey: binding.providerConfigKey, connectionId: binding.connectionId,
    triggerDigest: capabilityDigest({ runId: run.id, page: state.polls }), deadlineAt });
  if (health.sources.some(source => source.status !== "ACTIVE")) throw new CapabilityEngineError("NANGO_CONNECTION_DISABLED");
  const snapshot = await withTenant(actor.tenantId, async db => {
    const current = await loadNangoBinding(db, actor, request.integrationId, request.sourceScopeId, request.model);
    if (capabilityDigest(current) !== capabilityDigest(binding)) throw new CapabilityEngineError("NANGO_SOURCE_BINDING_CHANGED");
    const selected = await db.execute(sql`SELECT cursor,revision,history_limited FROM finnor_os.capability_nango_checkpoints WHERE tenant_id=${actor.tenantId}::uuid AND source_scope_id=${binding.sourceScopeId}::uuid`);
    return checkpointSchema.parse(selected.rows[0]);
  }, actor.userId);
  const page = await new NangoReadOnlyClient({ apiKey: process.env.NANGO_API_KEY ?? "", baseUrl: process.env.FINNOR_NANGO_BASE_URL }).readRecords({ binding, tenantId: actor.tenantId,
    model: request.model, cursor: snapshot.cursor, deadlineAt });
  const retrievedAt = new Date().toISOString(), decision = await authorizeCapability(actor, request, run.sources);
  const committed = await withTenant(actor.tenantId, async db => {
    await assertCurrentClaim(db, claim, actor.tenantId); await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    const currentBinding = await loadNangoBinding(db, actor, request.integrationId, request.sourceScopeId, request.model);
    if (capabilityDigest(currentBinding) !== capabilityDigest(binding)) throw new CapabilityEngineError("NANGO_SOURCE_BINDING_CHANGED");
    const locked = await db.execute(sql`SELECT cursor,revision,history_limited FROM finnor_os.capability_nango_checkpoints
      WHERE tenant_id=${actor.tenantId}::uuid AND source_scope_id=${binding.sourceScopeId}::uuid FOR UPDATE`);
    const current = checkpointSchema.parse(locked.rows[0]);
    if (current.revision !== snapshot.revision || current.cursor !== snapshot.cursor) throw new CapabilityEngineError("NANGO_SCOPE_CHECKPOINT_CHANGED");
    if (Date.now() >= deadlineAt) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
    const receipts: Array<Record<string, unknown>> = []; let historyLimited = current.history_limited;
    for (const record of page.records) {
      if (Date.now() >= deadlineAt) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
      const metadata = record._nango_metadata;
      if (!Number.isFinite(Date.parse(metadata.last_modified_at))) throw new CapabilityEngineError("NANGO_RECORD_TIMESTAMP_INVALID");
      const pruned = Boolean(metadata.pruned_at), deleted = metadata.last_action === "DELETED";
      historyLimited ||= pruned;
      const payload: Record<string, unknown> = { ...record };
      if (Buffer.byteLength(JSON.stringify(payload)) > 250_000) throw new CapabilityEngineError("NANGO_RECORD_TOO_LARGE");
      const evidence = await createEvidenceSourceTx(db, actor.tenantId, { sourceKey: `nango:${capabilityDigest({ binding, id: record.id, principalId: actor.userId, authorityRevision: decision.authorityRevision })}`, sourceType: "nango_record",
        title: `${request.model}: ${record.id}`.slice(0, 1000), publisher: "Nango records cache", metadata: { integrationId: binding.integrationId, sourceScopeId: binding.sourceScopeId, model: request.model,
          capabilityPrincipalId: actor.userId, capabilityAuthorityRevision: decision.authorityRevision, connectionEpoch: binding.connectionEpoch } });
      const version = await appendEvidenceVersionTx(db, actor.tenantId, evidence.id, { content: JSON.stringify({ record: payload, deleted, pruned }),
        snapshot: { source: "nango_records_cache", record: payload, deleted, pruned, canonicalTruthEstablished: false }, asOf: new Date(metadata.last_modified_at), retrievedAt: new Date(retrievedAt) });
      const observation: ProviderObservation = { tenantId: actor.tenantId, integrationId: binding.integrationId, sourceScopeId: binding.sourceScopeId,
        provider: "nango", resourceKind: "nango_records", externalObjectType: request.model, externalObjectId: record.id, providerParentRefs: [],
        providerVersion: metadata.cursor, providerSequence: null, observedAt: metadata.last_modified_at, retrievedAt, deleted, payloadHash: sourceTruthHash(payload), payload,
        providerMetadata: { cursor: metadata.cursor, lastAction: metadata.last_action, prunedAt: metadata.pruned_at ?? null,
          finnorAccessCut: capabilityDigest({ principalId: actor.userId, authorityRevision: decision.authorityRevision, connectionEpoch: binding.connectionEpoch }),
          sourceCoverage: "CACHE_ONLY_NOT_CANONICAL_SOURCE_COMPLETENESS" },
        ingestionMode: snapshot.cursor === null ? "initial_backfill" : "incremental", traceId: run.correlationId };
      const persisted = await persistProviderObservationTx(db, { observation, evidenceSourceId: evidence.id, evidenceVersionId: version.versionId,
        rootMappingStatus: "unresolved", canonicalTarget: null, reason: "NANGO_RECORD_REQUIRES_EXISTING_DOMAIN_MAPPER" });
      receipts.push({ recordId: record.id, evidenceSourceId: evidence.id, evidenceVersionId: version.versionId, observationId: persisted.observationId, disposition: persisted.status, deleted, pruned });
    }
    const cursor = page.next_cursor ?? page.records.at(-1)?._nango_metadata.cursor ?? current.cursor;
    const completed = page.next_cursor === null;
    await db.execute(sql`UPDATE finnor_os.capability_nango_checkpoints SET cursor=${cursor},revision=revision+1,cache_enumeration_completed=${completed},history_limited=${historyLimited},updated_at=clock_timestamp()
      WHERE tenant_id=${actor.tenantId}::uuid AND source_scope_id=${binding.sourceScopeId}::uuid AND revision=${current.revision}`);
    const eventId = await appendCapabilityEvent(db, actor.tenantId, run.id, "PROVIDER_OBSERVED", { sourceScopeId: binding.sourceScopeId, checkpointRevision: current.revision + 1,
      records: receipts, nextCursor: page.next_cursor, retainedCursor: cursor, cacheEnumerationCompleted: completed, historyLimited });
    const next = { ...state, polls: state.polls + 1, records: state.records + page.records.length, pageEventIds: [...state.pageEventIds, eventId] };
    const updated = await db.execute(sql`UPDATE finnor_os.capability_runs SET remote_state=${JSON.stringify(next)}::jsonb,updated_at=clock_timestamp()
      WHERE tenant_id=${actor.tenantId}::uuid AND id=${run.id}::uuid AND status='RUNNING' AND job_id=${claim.jobId}::uuid AND worker_claim_token=${claim.claimToken}::uuid RETURNING id`);
    if (!updated.rows.length) throw new CapabilityEngineError("NANGO_PAGE_PUBLICATION_FENCED");
    // A completed cache page does not prove full upstream history or business freshness.
    await db.execute(sql`UPDATE finnor_os.integration_source_scopes SET last_successful_sync_at=clock_timestamp(),last_observed_at=clock_timestamp(),freshness_state='unknown',updated_at=clock_timestamp()
      WHERE tenant_id=${actor.tenantId}::uuid AND id=${binding.sourceScopeId}::uuid`);
    const clock = await db.execute(sql`SELECT clock_timestamp()>=deadline_at AS expired FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND id=${run.id}::uuid`);
    if (clock.rows[0]?.expired === true) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
    return { next, completed, historyLimited, cursor, revision: current.revision + 1 };
  }, actor.userId);
  if (!committed.completed) return { status: "waiting", remoteState: committed.next, delayMs: 1000 };
  return { status: "complete", result: { schema: "finnor.nango-sync.v1", integrationId: binding.integrationId, sourceScopeId: binding.sourceScopeId, model: request.model,
    recordsObserved: committed.next.records, pagesObserved: committed.next.polls, pageEventIds: committed.next.pageEventIds,
    checkpoint: { cursor: committed.cursor, revision: committed.revision }, historyLimited: committed.historyLimited,
    qualification: "IMMUTABLE_CACHE_EVIDENCE_REQUIRES_DOMAIN_MAPPING; UPSTREAM_COMPLETENESS_NOT_ESTABLISHED", canonicalTruthEstablished: false, executionAuthorityGranted: false } };
}
