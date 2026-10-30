import type { PoolClient } from "pg";
import type { ComputeResourceLease } from "@finnor/db";
import { randomUUID } from "node:crypto";
import type { ExperimentRef } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../../types";
import { principal, authorize, assertDependencies } from "../../owner-context";
import { withS5PortfolioTransaction } from "../../allocation-store";
import { canonical, digest, ordinaryDevelopment, type Profile, type SessionRow, type Artifact } from "./contracts";
import { assertPhysicalFence, type BoundScope } from "../../../../epistemic-runtime/src/project-z/z5-institution-linker/ownership";
export { principal };
export type DeliveryFence = Pick<JobExecutionContext, "tenantId" | "protocolVersion" | "jobId" | "claimToken" | "claimFence" | "deliveryAttemptId">;
export const transaction = <T>(ctx: PeMutationContext, fn: (c: PoolClient) => Promise<T>) => {
  ordinaryDevelopment();
  return withS5PortfolioTransaction(ctx, fn);
};
/** Only after the caller's control fence has committed. An unavailable audit
 * never rolls it back; earlier original claim/debit evidence is retained. */
export async function bestEffortTerminalAudit(ctx: PeMutationContext, fn: (c: PoolClient) => Promise<void>) {
  try { await transaction(ctx, fn); return true; }
  catch { return false; }
}
const episodeQuotaConstraints = new Set(["z5_link_episodes_retained_bytes_check",
  "z5_link_episodes_event_count_check", "z5_link_episodes_uses_check"]);
export function nativeFailureReason(error: unknown, fallback = "Z5_NATIVE_DEPENDENCY_OR_PROCESS_UNAVAILABLE") {
  const pg = error as { code?: unknown; schema?: unknown; table?: unknown; constraint?: unknown } | null;
  if (pg?.code === "23514" && pg.schema === "finnor_os" && pg.table === "z5_link_episodes"
    && typeof pg.constraint === "string" && episodeQuotaConstraints.has(pg.constraint))
    return "Z5_ORIGINAL_STORAGE_OR_EVENT_BUDGET_EXHAUSTED";
  return error instanceof Error && /^Z5_[A-Z0-9_]+$/.test(error.message) ? error.message : fallback;
}
export function reference(owner: string, prefix: string, value: unknown): ExperimentRef {
  const contentDigest = digest(value);
  return { owner, id: prefix + ":" + contentDigest, version: "z5-institution-linker-v1", contentDigest };
}
export async function profileTx(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef): Promise<Profile> {
  const row = (await c.query<{ body: Profile; digest: string; revoked_at: Date | null }>(
    `SELECT body,digest,revoked_at FROM finnor_os.z5_component_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND profile_id=$3 FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), ref.id])).rows[0];
  if (!row || row.revoked_at || row.digest !== ref.contentDigest || digest(row.body) !== ref.contentDigest
    || Date.parse(row.body.validUntil) <= Date.now()) throw Error("Z5_FIXED_COMPONENT_PROFILE_NOT_CURRENT");
  await authorize(ctx, row.body.root, [{ type: "work", id: row.body.workId }], [], c);
  await assertDependencies(ctx, row.body.sourceDependencies, c, true);
  return row.body;
}
export async function requestTx(ctx: PeMutationContext, c: PoolClient, id: string, write = false): Promise<SessionRow> {
  const row = (await c.query<SessionRow>(`SELECT * FROM finnor_os.z5_link_requests
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
  [ctx.auth.tenantId, principal(ctx), id])).rows[0];
  if (!row) throw Error("Z5_PERMITTED_REQUEST_UNAVAILABLE");
  await authorize(ctx, row.root, [{ type: "work", id: row.work_id }], [], c);
  return row;
}
/** Recheck under the final request lock after external owner/custody/debit
 * work. A retained checked snapshot cannot override a newer control fence. */
export async function checkedRequestTx(ctx: PeMutationContext, c: PoolClient, retained: string | SessionRow, write = false) {
  const row = await requestTx(ctx, c, typeof retained === "string" ? retained : retained.id, write);
  if (!row.artifact_digest || row.cancel_requested || row.deadline_at.getTime() <= Date.now()
    || ["STALE", "REVOKED", "CANCELLED", "UNKNOWN", "INCOMPLETE"].includes(row.status))
    throw Error("Z5_NO_CURRENT_CHECKED_ARTIFACT");
  if (typeof retained !== "string" && (row.generation !== retained.generation
    || row.artifact_digest !== retained.artifact_digest || row.source_digest !== retained.source_digest
    || row.request_digest !== retained.request_digest))
    throw Error("Z5_RETAINED_CHECKED_REQUEST_FENCED");
  return row;
}
export async function eventTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow, kind: string, key: string, detail: unknown) {
  const body = { schema: "finnor.z5.native-event.v1", tenantId: row.tenant_id, principalId: row.principal_id,
    workId: row.work_id, requestId: row.id, generation: row.generation, kind, detail,
    originalReservation: row.request.parentReservation, originalDeadline: row.request.originalDeadline,
    unresolvedObligationRefs: row.cut.originalObligationRefs, newAllowance: false, executionAuthorityGranted: false };
  const ref = reference("S4", "institution-composition-event", body);
  const inserted = await c.query(`INSERT INTO finnor_os.z5_link_events(tenant_id,principal_id,request_id,event_id,kind,event_key,body)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,request_id,event_key) DO NOTHING RETURNING event_id`,
  [ctx.auth.tenantId, principal(ctx), row.id, ref.id, kind, key, canonical(body)]);
  if (!inserted.rowCount) {
    const prior = (await c.query<{ event_id: string; body: unknown }>(`SELECT event_id,body FROM finnor_os.z5_link_events
      WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND event_key=$4 FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), row.id, key])).rows[0];
    if (!prior || prior.event_id !== ref.id || digest(prior.body) !== digest(body))
      throw Error("Z5_ORIGINAL_EVENT_IDEMPOTENCY_CONFLICT");
  }
  return ref;
}
export async function assertClaimTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow, delivery: Readonly<JobExecutionContext>) {
  assertPhysicalFence({ tenant: row.tenant_id, token: row.claim_token, fence: Number(row.claim_fence),
    cancelled: row.cancel_requested, status: row.status, deadline: row.deadline_at.getTime() },
  { tenant: delivery.tenantId, token: delivery.claimToken, fence: delivery.claimFence });
  await assertDeliveryTx(ctx, c, row, delivery);
}
export function boundScope(row: SessionRow): BoundScope {
  return { tenant: row.tenant_id, principal: row.principal_id, work: row.work_id, input: row.work_input_id, root: row.root,
    inputDigest: row.work_input_digest, sourceDigest: row.source_digest, rightsRevision: row.rights_revision,
    liveDigest: row.cut.liveDigest, ownerCutDigest: digest(row.cut), profile: row.profile_ref,
    mandate: row.request.mandateRef, assignment: row.request.assignmentRef, parentReservation: row.request.parentReservation,
    preparation: row.request.preparationRef, policy: row.request.policyRef, allocation: row.request.allocationRef,
    consumption: row.request.consumptionRef, unresolvedObligations: row.cut.originalObligationRefs,
    originalDeadline: row.request.originalDeadline };
}
export async function assertDeliveryTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow, delivery: Readonly<DeliveryFence>) {
  if (delivery.tenantId !== row.tenant_id || delivery.protocolVersion !== 1) throw Error("Z5_WRONG_PHYSICAL_TENANT_OR_PROTOCOL");
  const result = await c.query(`SELECT j.id FROM finnor_os.jobs j
    JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
    WHERE j.tenant_id=$1 AND j.id=$2 AND j.status='running' AND j.type='link_institution_components_v1'
      AND j.protocol_version=1 AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
      AND j.payload->>'requestId'=$5 AND (j.payload->>'generation')::integer=$6
      AND a.id=$7 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.finished_at IS NULL
      AND j.payload->>'principalId'=$8 FOR SHARE OF j,a`,
  [row.tenant_id, delivery.jobId, delivery.claimToken, delivery.claimFence, row.id, row.generation, delivery.deliveryAttemptId, row.principal_id]);
  if (result.rowCount !== 1) throw Error("Z5_PHYSICAL_JOB_LEASE_NOT_CURRENT");
}
/** The same publication transaction locks the real physical permit. A prior
 * heartbeat is not a publication fence and an empty permit set is not proof. */
export async function assertComputeLeasesTx(ctx: PeMutationContext, c: PoolClient, leases: readonly ComputeResourceLease[]) {
  if (leases.length !== 1 || leases[0]?.resourceKey !== "native:z5-institution-linker")
    throw Error("Z5_EXACT_NATIVE_COMPUTE_PERMIT_REQUIRED");
  const owned = leases.map(l => ({ resource_key: l.resourceKey, token: l.token, fence: l.fence, owner_id: l.ownerId }));
  const found = await c.query(`SELECT l.id FROM finnor_os.compute_resource_leases l
    JOIN jsonb_to_recordset($1::jsonb) owned(resource_key text,token uuid,fence bigint,owner_id text)
      ON l.resource_key=owned.resource_key AND l.lease_token=owned.token AND l.fence=owned.fence AND l.owner_id=owned.owner_id
    JOIN finnor_os.compute_resource_policies p ON p.resource_key=l.resource_key
    WHERE l.tenant_key=$2 AND l.released_at IS NULL AND l.expires_at>clock_timestamp() AND p.enabled
    FOR SHARE OF l,p`, [canonical(owned), ctx.auth.tenantId]);
  if (found.rowCount !== leases.length) throw Error("Z5_NATIVE_COMPUTE_PUBLICATION_PERMIT_LOST");
}
export async function enqueueTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow) {
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,max_attempts)
    VALUES($1,'link_institution_components_v1',$2::jsonb,$3,'interactive',1,'locally_idempotent',4)
    ON CONFLICT(idempotency_key) DO NOTHING`,
  [ctx.auth.tenantId, canonical({ tenantId: row.tenant_id, principalId: row.principal_id, requestId: row.id, generation: row.generation }),
    `z5-link:${row.tenant_id}:${row.id}:${row.generation}`]);
}
export async function artifactTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow): Promise<Artifact> {
  const result = (await c.query<{ body: Artifact; digest: string }>(`SELECT body,digest FROM finnor_os.z5_link_artifacts
    WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND digest=$4 FOR SHARE`,
  [ctx.auth.tenantId, principal(ctx), row.id, row.artifact_digest])).rows[0];
  if (!result || digest(result.body) !== result.digest) throw Error("Z5_IMMUTABLE_ARTIFACT_PREIMAGE_MISMATCH");
  const { ref, ...preimage } = result.body;
  if (digest(result.body.payload) !== result.body.envelope.immutableArtifactDigest
    || digest(reference("S4", "institution-composition-certificate", preimage)) !== digest(ref)
    || digest(result.body.payload.certificate) !== digest(result.body.certificate)
    || digest(result.body.payload.input) !== digest(row.input) || digest(result.body.payload.originalRequest) !== digest(row.request)
    || result.body.envelope.originalTenant !== row.tenant_id || result.body.envelope.principal !== row.principal_id
    || result.body.envelope.Work.id !== row.work_id || result.body.payload.requestId !== row.id)
    throw Error("Z5_ARTIFACT_LOGICAL_ENVELOPE_BINDING");
  return result.body;
}
export async function insertArtifactTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow, artifact: Artifact) {
  const hash = digest(artifact);
  await c.query(`INSERT INTO finnor_os.z5_link_artifacts(tenant_id,principal_id,request_id,digest,body)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,request_id,digest) DO NOTHING`,
  [ctx.auth.tenantId, principal(ctx), row.id, hash, canonical(artifact)]);
  return hash;
}
export async function meterStartTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow, delivery: Readonly<JobExecutionContext>) {
  const id = randomUUID();
  await c.query(`INSERT INTO finnor_os.z5_link_attempts(id,tenant_id,principal_id,request_id,delivery_id,claim_fence,body)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,delivery_id) DO NOTHING`,
  [id, row.tenant_id, row.principal_id, row.id, delivery.deliveryAttemptId, delivery.claimFence,
    canonical({ schema: "finnor.z5.physical-attempt.v1", phase: "CLAIMED_PENDING_DEBIT", money: null,
      human: null, billableExternalCalls: null, exposureRetained: true, originalDeadline: row.request.originalDeadline,
      reservationRef: row.request.parentReservation, status: "UNKNOWN_IF_INTERRUPTED" })]);
  return id;
}
