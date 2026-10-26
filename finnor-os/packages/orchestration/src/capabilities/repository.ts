import { capabilityDigest, requireActiveCapabilityPrincipal, authorizeCapability, assertCapabilityAuthorityRevision, assertCapabilityOwnerValidity } from "./policy";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { withTenant, type Db } from "@finnor/db";
import { loadDocumentVersion } from "@finnor/data-platform";
import { CAPABILITY_PROVIDERS, CapabilityRequestSchema, CapabilityRunRowSchema, FrozenDocumentSourceSchema, documentSources, parallelMonitorRemoteId, type CapabilityActor, type CapabilityRequest, type CapabilityRun, type FrozenDocumentSource } from "./contracts";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { loadNangoBinding } from "./nango-bindings";

export function rowToCapabilityRun(value: unknown): CapabilityRun {
  const row = CapabilityRunRowSchema.parse(value);
  return { id: row.id, tenantId: row.tenant_id, principalId: row.principal_id, kind: row.request.kind,
    status: row.status, request: row.request, requestDigest: row.request_digest,
    sources: row.sources, result: row.result, resultDigest: row.result_digest,
    failureCode: row.failure_code, remoteState: row.remote_state,
    deadlineAt: row.deadline_at.toISOString(), correlationId: row.correlation_id };
}

export async function createCapabilityRun(actor: CapabilityActor, input: unknown): Promise<{ run: CapabilityRun; replayed: boolean }> {
  const request = CapabilityRequestSchema.parse(input);
  const inheritedSources: FrozenDocumentSource[] = [];
  if (request.kind === "pageindex_retrieve") {
    for (const id of request.indexRunIds) {
      const index = await readCapabilityRun(actor, id);
      if (!index || index.kind !== "pageindex_index" || index.status !== "SUCCEEDED" || index.sources.length !== 1) throw new CapabilityEngineError("PAGEINDEX_INDEX_NOT_FOUND");
      for (const source of index.sources) if (!inheritedSources.some(s => s.documentId === source.documentId && s.versionId === source.versionId)) inheritedSources.push(source);
    }
  }
  if (request.kind === "parallel_monitor_control") {
    const monitor = await readCapabilityRun(actor, request.monitorRunId);
    if (!monitor || parallelMonitorRemoteId(monitor) === null) throw new CapabilityEngineError("CAPABILITY_MONITOR_NOT_FOUND");
  }
  if (request.kind === "modal_control" && !await loadOwnedModalHandle(actor, request.executionRunId)) throw new CapabilityEngineError("MODAL_ACKNOWLEDGED_SANDBOX_NOT_FOUND");
  const decision = await authorizeCapability(actor, request, request.kind === "pageindex_retrieve" ? inheritedSources : undefined);
  return withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor);
    await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    if (await jsonbBytes(db, request) > 1_048_576) throw new CapabilityEngineError("CAPABILITY_REQUEST_TOO_LARGE");
    const sources: FrozenDocumentSource[] = [];
    for (const source of request.kind === "pageindex_retrieve" ? inheritedSources : documentSources(request)) {
      const document = await loadDocumentVersion(db, actor.tenantId, source.documentId, source.versionId);
      if (!document) throw new CapabilityEngineError("CAPABILITY_SOURCE_NOT_FOUND");
      const digest = createHash("sha256").update(document.bytes).digest("hex");
      if (digest !== document.version.byte_sha256) throw new CapabilityEngineError("CAPABILITY_SOURCE_DIGEST_MISMATCH");
      if (inheritedSources.some(s => s.documentId === source.documentId && s.versionId === source.versionId && s.sha256 !== digest)) throw new CapabilityEngineError("PAGEINDEX_FROZEN_SOURCE_MISMATCH");
      sources.push({ documentId: source.documentId, versionId: source.versionId, sha256: digest, mediaType: document.version.media_type, sizeBytes: document.bytes.length });
    }
    const providerBinding = request.kind === "nango_sync" ? await loadNangoBinding(db, actor, request.integrationId, request.sourceScopeId, request.model) : null;
    const requestDigest = capabilityDigest({ request, sources, ...(providerBinding ? { providerBinding } : {}) });
    const prior = await db.execute(sql`SELECT * FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND idempotency_key=${request.idempotencyKey}`);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== requestDigest) throw new CapabilityEngineError("CAPABILITY_IDEMPOTENCY_CONFLICT");
      await assertCapabilityOwnerValidity(db, decision.ownerValidUntil);
      return { run: rowToCapabilityRun(prior.rows[0]), replayed: true };
    }
    const id = randomUUID(), correlationId = actor.correlationId ?? randomUUID();
    await assertCapabilityOwnerValidity(db, decision.ownerValidUntil);
    // One accepted deadline includes queue time and every physical retry.
    const deadline = new Date(Date.now() + request.timeoutMs);
    const initialState = providerBinding ? { provider: "nango", phase: "accepted", binding: providerBinding, polls: 0, records: 0, pageEventIds: [] } : {};
    const inserted = await db.execute(sql`INSERT INTO finnor_os.capability_runs(id,tenant_id,principal_id,kind,idempotency_key,request_digest,request,sources,authority_decision_id,deadline_at,correlation_id,remote_state)
      VALUES(${id}::uuid,${actor.tenantId}::uuid,${actor.userId}::uuid,${request.kind},${request.idempotencyKey},${requestDigest},${JSON.stringify(request)}::jsonb,${JSON.stringify(sources)}::jsonb,${decision.id}::uuid,${deadline.toISOString()}::timestamptz,${correlationId},${JSON.stringify(initialState)}::jsonb)
      ON CONFLICT(tenant_id,principal_id,idempotency_key) DO NOTHING RETURNING *`);
    if (!inserted.rows[0]) {
      const winner = await db.execute(sql`SELECT * FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND idempotency_key=${request.idempotencyKey}`);
      if (!winner.rows[0] || winner.rows[0].request_digest !== requestDigest) throw new CapabilityEngineError("CAPABILITY_IDEMPOTENCY_CONFLICT");
      await assertCapabilityOwnerValidity(db, decision.ownerValidUntil);
      return { run: rowToCapabilityRun(winner.rows[0]), replayed: true };
    }
    const payload = { tenantId: actor.tenantId, principalId: actor.userId, runId: id, _correlationId: correlationId };
    const job = await db.execute(sql`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version)
      VALUES(${actor.tenantId}::uuid,'run_capability_provider_v1',${JSON.stringify(payload)}::jsonb,${`capability:${actor.tenantId}:${id}`},'batch',0,1) RETURNING id`);
    await db.execute(sql`UPDATE finnor_os.capability_runs SET job_id=${String(job.rows[0]!.id)}::uuid WHERE tenant_id=${actor.tenantId}::uuid AND id=${id}::uuid`);
    await appendCapabilityEvent(db, actor.tenantId, id, "ACCEPTED", { requestDigest, sources, provider: CAPABILITY_PROVIDERS[request.kind].provider });
    return { run: rowToCapabilityRun(inserted.rows[0]), replayed: false };
  }, actor.userId);
}

export async function jsonbBytes(db: Db, value: unknown): Promise<number> {
  const result = await db.execute(sql`SELECT octet_length(${JSON.stringify(value)}::jsonb::text) AS bytes`);
  return Number(result.rows[0]!.bytes);
}

export async function appendCapabilityEvent(db: Db, tenantId: string, runId: string, kind: string, body: Record<string, unknown>): Promise<string> {
  const inserted = await db.execute(sql`INSERT INTO finnor_os.capability_run_events(tenant_id,run_id,kind,body) VALUES(${tenantId}::uuid,${runId}::uuid,${kind},${JSON.stringify(body)}::jsonb) RETURNING id`);
  return String(inserted.rows[0]!.id);
}

export async function readCapabilityRun(actor: CapabilityActor, id: string): Promise<CapabilityRun | null> {
  const existing = await withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor);
    const result = await db.execute(sql`SELECT * FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${id}::uuid`);
    return result.rows[0] ? rowToCapabilityRun(result.rows[0]) : null;
  }, actor.userId);
  if (!existing) return null;
  const decision = await authorizeCapability(actor, existing.request, existing.sources);
  return withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor);
    await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    const result = await db.execute(sql`SELECT * FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${id}::uuid`);
    if (!result.rows[0]) return null;
    const run = rowToCapabilityRun(result.rows[0]);
    if (CAPABILITY_PROVIDERS[run.kind].remote && run.remoteState.phase !== "accepted") {
      const journal = await db.execute(sql`SELECT body FROM finnor_os.capability_run_events WHERE tenant_id=${actor.tenantId}::uuid AND run_id=${id}::uuid AND kind='PROVIDER_ACCEPTED' ORDER BY id DESC LIMIT 16`);
      const receiptSchema = z.object({ state: z.object({ provider: z.string(), phase: z.literal("accepted") }).passthrough(), receipt: z.object({ requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
        jobId: z.string().uuid(), claimToken: z.string().uuid(), claimFence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).passthrough() });
      for (const row of journal.rows) {
        const accepted = receiptSchema.safeParse(row.body);
        if (!accepted.success || accepted.data.receipt.requestDigest !== run.requestDigest || accepted.data.state.provider !== CAPABILITY_PROVIDERS[run.kind].provider) continue;
        const receipt = accepted.data.receipt;
        const attempt = await db.execute(sql`SELECT a.id FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.id=a.job_id
          WHERE a.tenant_id=${actor.tenantId}::uuid AND a.job_id=${receipt.jobId}::uuid AND a.claim_token=${receipt.claimToken}::uuid AND a.claim_fence=${receipt.claimFence}
          AND j.type='run_capability_provider_v1' AND j.payload->>'runId'=${run.id} AND j.payload->>'principalId'=${actor.userId} LIMIT 1`);
        if (attempt.rows.length) { run.remoteState = { ...run.remoteState, acceptedReceipt: accepted.data.state }; break; }
      }
    }
    await assertCapabilityOwnerValidity(db, decision.ownerValidUntil);
    return run;
  }, actor.userId);
}

const runListInput = z.object({ documentId: z.string().uuid().optional(), versionId: z.string().uuid().optional(),
  kind: z.string().refine(kind => Object.hasOwn(CAPABILITY_PROVIDERS, kind), "UNKNOWN_CAPABILITY").optional(),
  cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(25).default(10) }).strict()
  .refine(input => Boolean(input.documentId) === Boolean(input.versionId), "EXACT_DOCUMENT_VERSION_REQUIRED");

/** History contains only current-authorized metadata. Large private results are
 * loaded individually through readCapabilityRun, with its own current-rights cut. */
export async function listCapabilityRuns(actor: CapabilityActor, input: unknown = {}) {
  const options = runListInput.parse(input);
  const rows = await withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor);
    const result = await db.execute(sql`SELECT id,request,sources FROM finnor_os.capability_runs r
      WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid
      AND (${options.kind ?? null}::text IS NULL OR kind=${options.kind ?? null})
      AND (${options.documentId ?? null}::uuid IS NULL OR sources @> ${JSON.stringify(options.documentId ? [{ documentId: options.documentId, versionId: options.versionId }] : [])}::jsonb)
      AND (${options.cursor ?? null}::uuid IS NULL OR (created_at,id)<(
        SELECT created_at,id FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${options.cursor ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${options.limit + 1}`);
    return result.rows;
  }, actor.userId);
  const runs: Array<{ id: string; kind: string; status: string; resultDigest: string | null; failureCode: string | null; deadlineAt: string }> = [];
  for (const row of rows.slice(0, options.limit)) {
    const request = CapabilityRequestSchema.parse(row.request), sources = z.array(FrozenDocumentSourceSchema).parse(row.sources);
    let authorization: Awaited<ReturnType<typeof authorizeCapability>>;
    try { authorization = await authorizeCapability(actor, request, sources); }
    catch (error) { if (error instanceof CapabilityEngineError && error.code === "CAPABILITY_AUTHORITY_DENIED") continue; throw error; }
    const visible = await withTenant(actor.tenantId, async db => {
      await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, authorization.authorityRevision);
      const selected = await db.execute(sql`SELECT id,kind,status,result_digest,failure_code,deadline_at FROM finnor_os.capability_runs
        WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${String(row.id)}::uuid`);
      await assertCapabilityOwnerValidity(db, authorization.ownerValidUntil);
      return selected.rows[0];
    }, actor.userId);
    if (visible) runs.push({ id: String(visible.id), kind: String(visible.kind), status: String(visible.status), resultDigest: visible.result_digest as string | null,
      failureCode: visible.failure_code as string | null, deadlineAt: z.coerce.date().parse(visible.deadline_at).toISOString() });
  }
  return { runs, nextCursor: rows.length > options.limit ? String(rows[options.limit - 1]!.id) : null };
}

/** Cleanup needs the owned provider handle, without reopening document content
 * whose read permission may have been revoked. The caller authorizes the
 * separate control capability against this run before using the handle. */
export async function loadOwnedModalHandle(actor: CapabilityActor, id: string): Promise<Record<string, unknown> | null> {
  return withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor);
    const selected = await db.execute(sql`SELECT remote_state,request_digest FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${id}::uuid AND kind='modal_execute'`);
    const row = z.object({ remote_state: z.record(z.string(), z.unknown()), request_digest: z.string() }).safeParse(selected.rows[0]);
    if (!row.success) return null;
    if (row.data.remote_state.provider === "modal" && row.data.remote_state.phase === "accepted") return row.data.remote_state;
    const events = await db.execute(sql`SELECT e.body FROM finnor_os.capability_run_events e JOIN finnor_os.job_delivery_attempts a
      ON a.job_id::text=e.body#>>'{receipt,jobId}' AND a.claim_token::text=e.body#>>'{receipt,claimToken}' AND a.claim_fence::text=e.body#>>'{receipt,claimFence}'
      JOIN finnor_os.jobs j ON j.id=a.job_id
      WHERE e.tenant_id=${actor.tenantId}::uuid AND e.run_id=${id}::uuid AND e.kind='PROVIDER_ACCEPTED' AND e.body#>>'{receipt,requestDigest}'=${row.data.request_digest}
      AND e.body#>>'{state,provider}'='modal' AND e.body#>>'{state,phase}'='accepted' AND a.tenant_id=e.tenant_id
      AND j.type='run_capability_provider_v1' AND j.payload->>'runId'=${id} AND j.payload->>'principalId'=${actor.userId} ORDER BY e.id DESC LIMIT 1`);
    const receipt = z.object({ state: z.record(z.string(), z.unknown()) }).safeParse(events.rows[0]?.body);
    return receipt.success ? receipt.data.state : null;
  }, actor.userId);
}

export async function loadCapabilitySource(actor: CapabilityActor, source: FrozenDocumentSource, deadlineAt: number): Promise<Buffer> {
  return withTenant(actor.tenantId, async db => {
    const remaining = deadlineAt - Date.now();
    if (remaining < 1) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
    await db.execute(sql`SELECT set_config('statement_timeout',${String(Math.min(10_000, remaining))},true)`);
    await requireActiveCapabilityPrincipal(db, actor);
    const found = await loadDocumentVersion(db, actor.tenantId, source.documentId, source.versionId);
    if (!found || createHash("sha256").update(found.bytes).digest("hex") !== source.sha256) throw new CapabilityEngineError("CAPABILITY_SOURCE_UNAVAILABLE_OR_CHANGED");
    if (Date.now() >= deadlineAt) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
    return found.bytes;
  }, actor.userId);
}
