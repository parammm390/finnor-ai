/** Z3 ViabilityStrategy native durable store.
 *
 * Owned leaf. The tables below arrive only through the coordinator-owned,
 * preimage-bound migration patch (scope-z/phase-evidence/z3/integration-patches/).
 * Until that patch is applied and verified, this module is uninstalled
 * engineering and every runtime path fails closed on the missing relation.
 * No alternative tenant, Work, reservation, effect or admission identity is
 * created here; S5/S6/S7 owners keep their authority.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canExerciseAuthorityTx } from "@finnor/authority";
import type { z } from "zod";
import { ViabilityFault, PROFILE, type Candidate, type CheckReceipt,
  type OriginalBinding, type PublicArena } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { authorize, codeIdentity, principal, tx, unavailable } from "../../evidence-execution/store";
import { listStoredWorkCompute, persistEconomicRecordTx } from "../../economic-store";
import { unresolvedEffects } from "../../enterprise-control";
import { validateEnterpriseAllocation } from "../../enterprise-allocation";
import { validateInstitutionDemand } from "../../allocation-store";
import type { PeMutationContext } from "../../types";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import { Z3_COMPUTE_SCHEMA, Z3_PRODUCE_JOB, Z3_RECOVER_JOB, Z3NativeFault,
  candidateDigestOf, hash, parseArena, parseBinding, parseStoredCandidate, parseStoredReceipt,
  receiptDigestOf, z3Fault, z3Ref,
  type ReadSchema, type RecoverSchema, type SubmitSchema,
  type ViabilityBoundaryPoint, type ViabilityCheckpoint, type ViabilitySessionRow } from "./contracts";

type SubmitInput = z.infer<typeof SubmitSchema>;
type RecoverInput = z.infer<typeof RecoverSchema>;
type ReadInput = z.infer<typeof ReadSchema>;
type SessionStatus = ViabilitySessionRow["status"];

/** A checked session keeps its terminal verdict vocabulary; UNKNOWN never
 * masquerades as completion and a terminal verdict is never re-driven. */
export const Z3_TERMINAL_STATUSES: readonly SessionStatus[] = ["VIABLE", "UNREALIZABLE", "STALE", "FAILED"];

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const fenceOf = (row: ViabilitySessionRow): number | null =>
  row.active_claim_fence === null ? null : Number(row.active_claim_fence);

/** Producer/parser faults are already Z3_-prefixed; re-raise as native faults. */
function parse<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof ViabilityFault) z3Fault(error.code);
    throw error;
  }
}

async function authorizeOwner(ctx: PeMutationContext, c: PoolClient, lock = true): Promise<void> {
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) throw unavailable();
  const row = await c.query(
    "SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND role='owner' AND status='active'" + (lock ? " FOR SHARE" : ""),
    [ctx.auth.tenantId, principal(ctx)]);
  if (row.rowCount !== 1) throw unavailable();
}

async function authorizeWork(ctx: PeMutationContext, workId: string, c: PoolClient, lock = true): Promise<void> {
  const allowed = await canExerciseAuthorityTx(ctx.auth,
    { operation: "query", capability: "query:pe_world_state", resource: { type: "work", id: workId }, risk: "low" }, c);
  const work = (await c.query("SELECT id, created_by FROM finnor_os.works WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR SHARE" : ""),
    [ctx.auth.tenantId, workId])).rows[0];
  if (!allowed || !work || work.created_by !== principal(ctx)) throw unavailable();
}

export async function viabilitySession(ctx: PeMutationContext, id: string,
  client?: PoolClient, lock = false): Promise<ViabilitySessionRow> {
  const read = async (c: PoolClient) => {
    const row = (await c.query<ViabilitySessionRow>(
      "SELECT * FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3" + (lock ? " FOR UPDATE" : ""),
      [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    // Durable preimage integrity: jsonb key order is normalized, canonical digests are not.
    if (hash(row.arena) !== row.arena_digest || hash(row.binding) !== row.binding_digest
      || row.candidate !== null && candidateDigestOf(parseStoredCandidate(row.candidate)) !== row.candidate_digest
      || row.check_receipt !== null && receiptDigestOf(parseStoredReceipt(row.check_receipt)) !== row.check_digest) {
      throw new Z3NativeFault("Z3_DURABLE_PREIMAGE_CORRUPT");
    }
    return row;
  };
  return client ? read(client) : tx(ctx, read, true);
}

/** Currentness is re-evaluated at every fenced boundary: same original Work
 * input, same authority revision, same loaded runtime code, deadline alive. */
export async function assertViabilityCurrent(ctx: PeMutationContext, row: ViabilitySessionRow,
  c: PoolClient, lock = true): Promise<OriginalBinding> {
  await authorizeWork(ctx, row.work_id, c, lock);
  const binding = parse(() => parseBinding(row.binding));
  const input = (await c.query<{ id: string }>(
    "SELECT id::text AS id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [row.tenant_id, row.work_id])).rows[0];
  if (!input || input.id !== row.work_input_id) z3Fault("Z3_WORK_INPUT_SUPERSEDED");
  const rights = (await c.query<{ revision: string }>(
    "SELECT revision::text AS revision FROM finnor_os.authority_states WHERE tenant_id=$1" + (lock ? " FOR SHARE" : ""),
    [row.tenant_id])).rows[0];
  if (!rights || rights.revision !== binding.rightsRevision) z3Fault("Z3_AUTHORITY_REVISION_CHANGED");
  if ((await codeIdentity()).digest !== binding.codeDigest) z3Fault("Z3_RUNTIME_SOURCE_CHANGED");
  if (Date.now() >= Date.parse(binding.deadlineAt)) z3Fault("Z3_DEADLINE_EXHAUSTED");
  return binding;
}

/** A reservation ref is optional. When present it must validate CURRENT through
 * the real S5 owners at submit and again at publication; there is no Z3 cache. */
async function validateReservation(ctx: PeMutationContext, ref: unknown): Promise<boolean> {
  try {
    if (ref && typeof ref === "object"
      && String((ref as { id?: unknown }).id ?? "").startsWith("institution-reservation:")) {
      return (await validateInstitutionDemand(ctx, ref as never)).status === "CURRENT";
    }
    const validation: unknown = await validateEnterpriseAllocation(ctx, ref);
    return !!validation && typeof validation === "object"
      && (validation as { status?: unknown }).status === "CURRENT";
  } catch { return false; }
}

export async function viabilityEvent(ctx: PeMutationContext, row: ViabilitySessionRow,
  kind: string, body: unknown, c: PoolClient): Promise<void> {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 65536) z3Fault("Z3_EVENT_BOUND");
  const count = (await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND session_id=$2",
    [row.tenant_id, row.id])).rows[0]?.n ?? 0;
  if (count >= 256) z3Fault("Z3_EVENT_HISTORY_BOUND");
  await c.query(
    "INSERT INTO finnor_os.z3_viability_events(tenant_id,principal_id,session_id,kind,body) VALUES($1,$2,$3,$4,$5::jsonb)",
    [row.tenant_id, principal(ctx), row.id, kind, encoded]);
}

async function retainViabilityArtifact(ctx: PeMutationContext, row: ViabilitySessionRow,
  kind: string, body: unknown, c: PoolClient) {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > PROFILE.artifactBytes) z3Fault("Z3_ARTIFACT_BOUND");
  const ref = z3Ref(kind, body);
  const inserted = (await c.query(
    `INSERT INTO finnor_os.z3_viability_artifacts(tenant_id,principal_id,artifact_id,kind,digest,body)
     VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,artifact_id) DO NOTHING RETURNING artifact_id`,
    [row.tenant_id, principal(ctx), ref.id, kind, ref.contentDigest, encoded])).rows[0];
  if (!inserted) {
    const prior = (await c.query<{ digest: string }>(
      "SELECT digest FROM finnor_os.z3_viability_artifacts WHERE tenant_id=$1 AND artifact_id=$2",
      [row.tenant_id, ref.id])).rows[0];
    if (!prior || prior.digest !== ref.contentDigest) z3Fault("Z3_CONFLICTING_IMMUTABLE_ARTIFACT");
  }
  return ref;
}

async function enqueueViabilityJob(ctx: PeMutationContext, row: { id: string; tenant_id: string; work_id: string },
  type: string, idempotencyKey: string, c: PoolClient): Promise<void> {
  await c.query(
    `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at)
     VALUES($1,$2,$3::jsonb,$4,'interactive',1,'reconcilable',clock_timestamp())
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [row.tenant_id, type,
      JSON.stringify({ tenantId: row.tenant_id, principalId: principal(ctx), sessionId: row.id, workId: row.work_id }),
      idempotencyKey]);
}

export async function createViabilitySession(ctx: PeMutationContext, input: SubmitInput) {
  const arena = parse(() => parseArena(input.arena));
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) z3Fault("Z3_DEADLINE_EXHAUSTED");
  const code = await codeIdentity();
  return tx(ctx, async (c) => {
    await authorizeOwner(ctx, c);
    await authorizeWork(ctx, input.workId, c);
    const inputRow = (await c.query<{ id: string }>(
      "SELECT id::text AS id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [ctx.auth.tenantId, input.workId])).rows[0];
    if (!inputRow) z3Fault("Z3_ORIGINAL_WORK_INPUT_REQUIRED");
    const rights = (await c.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE",
      [ctx.auth.tenantId])).rows[0];
    if (!rights) z3Fault("Z3_AUTHORITY_STATE_UNAVAILABLE");
    // The binding is reconstructed from durable reads; only the four declared
    // semantic digests and the parent/deadline come from the caller.
    const binding = parse(() => parseBinding({
      tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: input.workId,
      workInputId: inputRow.id, originalParentId: input.originalParentId,
      sourceRevision: input.sourceRevision, rightsRevision: rights.revision,
      mandateDigest: input.mandateDigest, observationDigest: input.observationDigest,
      resourceDigest: input.resourceDigest, deadlineAt: new Date(deadline).toISOString(),
      codeDigest: code.digest,
    }));
    if (input.reservationRef && !await validateReservation(ctx, input.reservationRef)) {
      z3Fault("Z3_S5_RESERVATION_NOT_CURRENT");
    }
    const arenaDigest = hash(arena), bindingDigest = hash(binding);
    const requestDigest = hash({ operation: "viability-submit", workId: input.workId,
      arenaDigest, bindingDigest, reservationRef: input.reservationRef });
    const prior = (await c.query<{ request_digest: string; session_id: string }>(
      "SELECT request_digest, session_id::text AS session_id FROM finnor_os.z3_viability_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) z3Fault("Z3_IDEMPOTENCY_CONFLICT");
      return { schema: "finnor.z3.viability-submit.v1" as const, sessionId: prior.session_id,
        semanticReplay: true as const, status: "INTAKE" as SessionStatus };
    }
    const id = randomUUID();
    const obligationRefs = arena.resources.obligationIds;
    await c.query(
      `INSERT INTO finnor_os.z3_viability_sessions(
         id,tenant_id,principal_id,work_id,work_input_id,original_parent_id,
         arena_digest,binding_digest,arena,binding,reservation_ref,status,generation,
         checkpoint,obligation_refs,deadline_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,'INTAKE',1,'[]'::jsonb,$12::jsonb,$13)`,
      [id, ctx.auth.tenantId, principal(ctx), input.workId, inputRow.id, input.originalParentId,
        arenaDigest, bindingDigest, JSON.stringify(arena), JSON.stringify(binding),
        JSON.stringify(input.reservationRef), JSON.stringify(obligationRefs), new Date(deadline).toISOString()]);
    await c.query(
      `INSERT INTO finnor_os.z3_viability_requests(tenant_id,principal_id,idempotency_key,request_digest,session_id)
       VALUES($1,$2,$3,$4,$5)`,
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey, requestDigest, id]);
    const row = await viabilitySession(ctx, id, c, true);
    await viabilityEvent(ctx, row, "Z3_SESSION_INTAKE", {
      workId: input.workId, workInputId: inputRow.id, arenaDigest, bindingDigest,
      originalParentId: input.originalParentId, reservationRef: input.reservationRef,
      qualification: "ORIGINAL_WORK_INTAKE_NOT_A_NEW_AUTHORITY_GRANT" }, c);
    await enqueueViabilityJob(ctx, row, Z3_PRODUCE_JOB, `z3:${id}:synthesize:1`, c);
    return { schema: "finnor.z3.viability-submit.v1" as const, sessionId: id,
      arenaDigest, bindingDigest, semanticReplay: false as const, status: "INTAKE" as SessionStatus };
  });
}

/** Session claim fences are session-monotonic, not job-monotonic: a recovery
 * job is a fresh durable row whose own fence restarts, so the session fence is
 * incremented on every adoption of a distinct claim token. Re-adoption by the
 * same token is idempotent. A stale worker cannot adopt, checkpoint or publish. */
export async function adoptViabilityClaim(ctx: PeMutationContext, row: ViabilitySessionRow,
  execution: Readonly<JobExecutionContext>): Promise<ViabilitySessionRow> {
  return tx(ctx, async (c) => {
    await authorizeOwner(ctx, c);
    const updated = (await c.query<ViabilitySessionRow>(
      `UPDATE finnor_os.z3_viability_sessions
          SET active_claim_token=$4, active_claim_fence=COALESCE(active_claim_fence,0)+1,
              generation=generation+1,
              status=CASE WHEN status='INTAKE' THEN 'PRODUCING' ELSE status END,
              updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND principal_id=$3
          AND status IN ('INTAKE','PRODUCING','CHECKING','UNKNOWN')
          AND active_claim_token IS DISTINCT FROM $4
        RETURNING *`,
      [row.tenant_id, row.id, principal(ctx), execution.claimToken])).rows[0];
    if (updated) return updated;
    const current = await viabilitySession(ctx, row.id, c, true);
    if (current.active_claim_token === execution.claimToken
      && ["INTAKE", "PRODUCING", "CHECKING", "UNKNOWN"].includes(current.status)) return current;
    z3Fault("Z3_STALE_FENCE");
  });
}

/** The writer must still hold the real durable job lease it claims under. */
export async function assertViabilityJobLease(ctx: PeMutationContext, row: ViabilitySessionRow,
  execution: Readonly<JobExecutionContext>, type: string): Promise<void> {
  await tx(ctx, async (c) => {
    const job = await c.query(
      `SELECT j.id FROM finnor_os.jobs j
        JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.tenant_id=j.tenant_id
        WHERE j.tenant_id=$1 AND j.id=$2 AND j.type=$3 AND j.protocol_version=1
          AND j.status='running' AND j.claim_token=$4 AND j.claim_fence=$5
          AND j.lease_expires_at>clock_timestamp()
          AND a.id=$6 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence
          AND a.finished_at IS NULL AND j.payload->>'sessionId'=$7
        FOR SHARE OF j,a`,
      [row.tenant_id, execution.jobId, type, execution.claimToken, execution.claimFence,
        execution.deliveryAttemptId, row.id]);
    if (job.rowCount !== 1) z3Fault("Z3_ACTUAL_DURABLE_DELIVERY_REQUIRED");
  });
}

async function assertViabilityClaim(ctx: PeMutationContext, row: ViabilitySessionRow,
  execution: Readonly<JobExecutionContext>, c: PoolClient): Promise<ViabilitySessionRow> {
  const current = await viabilitySession(ctx, row.id, c, true);
  if (current.active_claim_token !== execution.claimToken || fenceOf(current) !== execution.claimFence) {
    z3Fault("Z3_STALE_FENCE");
  }
  return current;
}

export async function checkpointViability(ctx: PeMutationContext, row: ViabilitySessionRow,
  point: ViabilityBoundaryPoint, execution: Readonly<JobExecutionContext>): Promise<void> {
  const checkpoint: ViabilityCheckpoint = { point, jobId: execution.jobId,
    deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
    at: new Date().toISOString() };
  await tx(ctx, async (c) => {
    const updated = (await c.query(
      `UPDATE finnor_os.z3_viability_sessions
          SET checkpoint=COALESCE(checkpoint,'[]'::jsonb) || $4::jsonb, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$5
          AND jsonb_array_length(COALESCE(checkpoint,'[]'::jsonb)) < 16
        RETURNING id`,
      [row.tenant_id, row.id, execution.claimToken, JSON.stringify(checkpoint), execution.claimFence])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
  });
}

export async function publishViabilityCandidate(ctx: PeMutationContext, row: ViabilitySessionRow,
  execution: Readonly<JobExecutionContext>, candidate: Candidate): Promise<ViabilitySessionRow> {
  return tx(ctx, async (c) => {
    const current = await assertViabilityClaim(ctx, row, execution, c);
    await assertViabilityCurrent(ctx, current, c);
    if (candidate.arenaDigest !== current.arena_digest || candidate.bindingDigest !== current.binding_digest) {
      z3Fault("Z3_CANDIDATE_ORIGIN_MISMATCH");
    }
    const digest = candidateDigestOf(candidate);
    const ref = await retainViabilityArtifact(ctx, current, "candidate", candidate, c);
    const updated = (await c.query<ViabilitySessionRow>(
      `UPDATE finnor_os.z3_viability_sessions
          SET candidate=$4::jsonb, candidate_digest=$5, status='CHECKING', updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$6
          AND candidate IS NULL
        RETURNING *`,
      [row.tenant_id, row.id, execution.claimToken, JSON.stringify(candidate), digest, execution.claimFence])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
    await viabilityEvent(ctx, current, "Z3_CANDIDATE_RETAINED", {
      candidateRef: ref, candidateDigest: digest, disposition: candidate.disposition,
      reason: "reason" in candidate ? candidate.reason : null,
      qualification: "PRODUCER_OUTPUT_UNTRUSTED_UNTIL_INDEPENDENT_CHECK" }, c);
    return updated;
  });
}

/** The independent checker's receipt is the uncertain native observation: it is
 * durably observed before any completion status exists. */
export async function publishViabilityObservation(ctx: PeMutationContext, row: ViabilitySessionRow,
  execution: Readonly<JobExecutionContext>, receipt: CheckReceipt): Promise<ViabilitySessionRow> {
  return tx(ctx, async (c) => {
    const current = await assertViabilityClaim(ctx, row, execution, c);
    await assertViabilityCurrent(ctx, current, c);
    if (current.candidate_digest === null
      || receipt.arenaDigest !== current.arena_digest || receipt.bindingDigest !== current.binding_digest
      || receipt.candidateDigest !== current.candidate_digest) z3Fault("Z3_RECEIPT_ORIGIN_MISMATCH");
    const digest = receiptDigestOf(receipt);
    const ref = await retainViabilityArtifact(ctx, current, "check", receipt, c);
    const updated = (await c.query<ViabilitySessionRow>(
      `UPDATE finnor_os.z3_viability_sessions
          SET check_receipt=$4::jsonb, check_digest=$5, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$6
          AND candidate IS NOT NULL AND check_receipt IS NULL
        RETURNING *`,
      [row.tenant_id, row.id, execution.claimToken, JSON.stringify(receipt), digest, execution.claimFence])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
    await viabilityEvent(ctx, current, "Z3_CHECK_OBSERVED", {
      checkRef: ref, checkDigest: digest, status: receipt.status, reason: receipt.reason,
      ordinaryComplete: receipt.ordinaryComplete,
      qualification: "INDEPENDENT_PROCESS_OBSERVATION_RECORDED_BEFORE_COMPLETION" }, c);
    return updated;
  });
}

export interface ViabilityBuildIdentity {
  producerBundleDigest: string; checkerDigest: string; nodeVersion: string; pythonExecutable: string;
}
export interface ViabilityMeters {
  wallMs: number; userCpuMicros: number; systemCpuMicros: number; processMaxRss: number;
}

export async function publishViabilityResult(ctx: PeMutationContext, row: ViabilitySessionRow,
  execution: Readonly<JobExecutionContext>, candidate: Candidate, receipt: CheckReceipt,
  meters: ViabilityMeters, build: ViabilityBuildIdentity): Promise<ViabilitySessionRow> {
  return tx(ctx, async (c) => {
    const current = await assertViabilityClaim(ctx, row, execution, c);
    const binding = await assertViabilityCurrent(ctx, current, c);
    if (current.candidate_digest === null || current.candidate_digest !== candidateDigestOf(candidate)
      || current.check_digest === null || current.check_digest !== receiptDigestOf(receipt)) {
      z3Fault("Z3_PUBLISH_PREIMAGE_CHANGED");
    }
    const s5Current = current.reservation_ref === null ? null : await validateReservation(ctx, current.reservation_ref);
    if (s5Current === false) z3Fault("Z3_S5_RESERVATION_NOT_CURRENT");
    const runManifestRef = await retainViabilityArtifact(ctx, current, "run-manifest", {
      schema: "finnor.z3.run-manifest.v1", ...build,
      jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
      arenaDigest: current.arena_digest, bindingDigest: current.binding_digest,
      candidateDigest: current.candidate_digest, checkDigest: current.check_digest,
      qualification: "PRODUCER_AND_CHECKER_BINARY_IDENTITY_NOT_INSTALLED_RECONSTRUCTION_PROOF" }, c);
    const compute = await persistEconomicRecordTx(ctx, {
      kind: "COMPUTE",
      payload: {
        schema: Z3_COMPUTE_SCHEMA, workId: current.work_id, episodeId: current.id, sessionId: current.id,
        candidateDigest: current.candidate_digest, checkDigest: current.check_digest,
        disposition: candidate.disposition, checkStatus: receipt.status,
        producerMetrics: "metrics" in candidate ? candidate.metrics : null,
        checkerMetrics: receipt.metrics ?? null, worker: meters,
        costs: { money: null, status: "UNMETERED", releaseSufficient: false },
      },
      rightsRef: `z3-rights:${current.tenant_id}:${binding.rightsRevision}`,
      idempotencyKey: `z3-compute:${current.id}:${execution.jobId}`,
      validAt: new Date().toISOString(), horizon: "H0",
      uncertainty: "PROCESS_METERS_MEASURED_LOCALLY; PROVIDER_BILL_AND_HUMAN_WORK_UNMETERED_NOT_ZERO",
    }, c);
    await viabilityEvent(ctx, current, "Z3_S7_COMPUTE_PERSISTED", {
      recordRef: compute.record.ref, semanticReplay: compute.semanticReplay,
      qualification: "ORDINARY_S7_RECORD_NOT_A_PROTECTED_RECEIPT" }, c);
    const s4Consumed = receipt.status === "VIABLE";
    if (s4Consumed) {
      await viabilityEvent(ctx, current, "Z3_S4_CONSUMPTION_RECORDED", {
        candidateDigest: current.candidate_digest, checkDigest: current.check_digest,
        strategyMemoryBound: PROFILE.memories,
        qualification: "S4_SEAM_CONSUMPTION_UNDER_ORIGINAL_WORK_CONTINUATION_RECORDED_NOT_PROTECTED_ADMISSION",
        learnedCompleteness: false, newAllowance: false }, c);
    }
    const status: SessionStatus = receipt.status === "VIABLE" ? "VIABLE"
      : receipt.status === "UNREALIZABLE" ? "UNREALIZABLE"
      : receipt.status === "UNKNOWN" ? "UNKNOWN" : "FAILED";
    const updated = (await c.query<ViabilitySessionRow>(
      `UPDATE finnor_os.z3_viability_sessions
          SET status=$4, reason=$5, s4_consumed=$6, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$7
        RETURNING *`,
      [row.tenant_id, row.id, execution.claimToken, status, receipt.reason, s4Consumed, execution.claimFence])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
    await viabilityEvent(ctx, current, "Z3_RESULT_PUBLISHED", {
      status, reason: receipt.reason, runManifestRef, s5Current, s7RecordRef: compute.record.ref,
      qualification: "PUBLICATION_UNDER_CLAIM_FENCE_AND_CURRENT_BINDING" }, c);
    return updated;
  });
}

/** Typed faults become retained session state; a superseded fence records only
 * an auditable refusal. This function never throws over the original error. */
export async function recordViabilityFault(ctx: PeMutationContext, sessionId: string,
  execution: Readonly<JobExecutionContext>, error: unknown): Promise<void> {
  const code = error instanceof Z3NativeFault ? error.code : "Z3_INTERNAL_FAULT";
  try {
    await tx(ctx, async (c) => {
      const row = await viabilitySession(ctx, sessionId, c, false);
      const fenced = row.active_claim_token === execution.claimToken && fenceOf(row) === execution.claimFence;
      if (!fenced) {
        await viabilityEvent(ctx, row, "Z3_STALE_PUBLICATION_REFUSED",
          { code, jobId: execution.jobId, claimFence: execution.claimFence }, c);
        return;
      }
      const status: SessionStatus = /STALE|SUPERSEDED|CHANGED|EXHAUSTED|EXPIRED/.test(code) ? "STALE"
        : /INTERNAL|CORRUPT|PROTOCOL|MISMATCH|UNSUPPORTED|REJECTED|UNPINNED/.test(code) ? "FAILED" : "UNKNOWN";
      await c.query(
        `UPDATE finnor_os.z3_viability_sessions SET status=$4, reason=$5, updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$6
           AND status NOT IN ('VIABLE','UNREALIZABLE','STALE','FAILED')`,
        [row.tenant_id, row.id, execution.claimToken, status, code, execution.claimFence]);
      await viabilityEvent(ctx, row, "Z3_DELIVERY_FAULT", {
        code, jobId: execution.jobId, claimFence: execution.claimFence,
        responsibilitiesRetained: true, unknownCleared: false }, c);
    });
  } catch { /* the original delivery error governs */ }
}

export async function requestViabilityRecovery(ctx: PeMutationContext, input: RecoverInput) {
  return tx(ctx, async (c) => {
    await authorizeOwner(ctx, c);
    const row = await viabilitySession(ctx, input.sessionId, c, true);
    if (input.root) await authorize(ctx, input.root, [{ type: "work", id: row.work_id }], [], c);
    await assertViabilityCurrent(ctx, row, c);
    if (Z3_TERMINAL_STATUSES.includes(row.status)) {
      return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
        recovery: "NOT_REQUIRED_TERMINAL" as const, status: row.status };
    }
    // A queued driver already covers this session. A physically running one does
    // not block an explicit owner recovery: the session claim fence serializes
    // any concurrent drivers, the loser refuses to publish, and deterministic
    // re-execution over the same durable preimages cannot duplicate an effect,
    // a candidate or an S7 record (its transaction rolls back with the fence).
    const queued = (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM finnor_os.jobs
        WHERE tenant_id=$1 AND type IN ($2,$3) AND payload->>'sessionId'=$4 AND status='queued'`,
      [row.tenant_id, Z3_PRODUCE_JOB, Z3_RECOVER_JOB, row.id])).rows[0]?.n ?? 0;
    if (queued > 0) {
      return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
        recovery: "ALREADY_LIVE" as const, status: row.status };
    }
    const requestDigest = hash({ operation: "viability-recover", sessionId: row.id,
      fence: fenceOf(row), status: row.status });
    const key = `recover:${input.idempotencyKey}`;
    const prior = (await c.query<{ request_digest: string }>(
      "SELECT request_digest FROM finnor_os.z3_viability_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [row.tenant_id, principal(ctx), key])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) z3Fault("Z3_IDEMPOTENCY_CONFLICT");
    } else {
      await c.query(
        "INSERT INTO finnor_os.z3_viability_requests(tenant_id,principal_id,idempotency_key,request_digest,session_id) VALUES($1,$2,$3,$4,$5)",
        [row.tenant_id, principal(ctx), key, requestDigest, row.id]);
      await enqueueViabilityJob(ctx, row, Z3_RECOVER_JOB, `z3r:${row.id}:${input.idempotencyKey.slice(0, 180)}`, c);
    }
    await viabilityEvent(ctx, row, "Z3_RECOVERY_ENQUEUED", {
      idempotencyKey: input.idempotencyKey, replay: !!prior,
      qualification: "RECOVERY_REPLAYS_DURABLE_CHECKPOINTS_ONLY_NO_EFFECT_REPLAY" }, c);
    return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
      recovery: "ENQUEUED" as const, status: row.status };
  });
}

function nextAuthorizedAction(arena: PublicArena, candidate: Candidate | null): string | null {
  if (!candidate || candidate.disposition !== "COMPLETE") return null;
  const index = arena.states.findIndex(s => s.id === arena.initial[0]);
  const state = arena.states[index];
  if (!state || state.owner === "E") return null;
  const edge = candidate.strategy.actions[0]?.[index];
  return typeof edge === "number" && edge >= 0 ? arena.edges[edge]?.action ?? null : null;
}

/** Latest session for a Work, for the mounted panel's work-scoped read. */
export async function latestViabilitySessionForWork(ctx: PeMutationContext,
  workId: string): Promise<ViabilitySessionRow> {
  const id = await tx(ctx, async (c) => (await c.query<{ id: string }>(
    `SELECT id::text AS id FROM finnor_os.z3_viability_sessions
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.auth.tenantId, principal(ctx), workId])).rows[0]?.id, true);
  if (!id) throw unavailable();
  return viabilitySession(ctx, id);
}

/** Authenticated read model for the mounted Work and the recovery driver. */
export async function readViabilityPublic(ctx: PeMutationContext, input: ReadInput) {
  const row = input.sessionId
    ? await viabilitySession(ctx, input.sessionId)
    : await latestViabilitySessionForWork(ctx, input.workId as string);
  const root = input.root;
  const sessionId = row.id;
  if (root) await authorize(ctx, root, [{ type: "work", id: row.work_id }]);
  let staleReason: string | null = null;
  try {
    await tx(ctx, async (c) => { await authorizeOwner(ctx, c, false); await assertViabilityCurrent(ctx, row, c, false); }, true);
  } catch (error) {
    if (error instanceof Z3NativeFault) staleReason = error.code;
    else if (error instanceof Error && error.name === "PeDomainError") staleReason = "Z3_WORK_UNAVAILABLE";
    else throw error;
  }
  const binding = parse(() => parseBinding(row.binding));
  const arena = parse(() => parseArena(row.arena));
  const candidate = row.candidate === null ? null : parseStoredCandidate(row.candidate);
  const receipt = row.check_receipt === null ? null : parseStoredReceipt(row.check_receipt);
  const counts = await tx(ctx, async (c) => {
    const pending = (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM finnor_os.jobs
        WHERE tenant_id=$1 AND type IN ($2,$3) AND payload->>'sessionId'=$4
          AND (status='queued' OR (status='running' AND lease_expires_at > clock_timestamp()))`,
      [row.tenant_id, Z3_PRODUCE_JOB, Z3_RECOVER_JOB, row.id])).rows[0]?.n ?? 0;
    const superseded = (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM finnor_os.jobs
        WHERE tenant_id=$1 AND type IN ($2,$3) AND payload->>'sessionId'=$4
          AND status='running' AND lease_expires_at <= clock_timestamp()`,
      [row.tenant_id, Z3_PRODUCE_JOB, Z3_RECOVER_JOB, row.id])).rows[0]?.n ?? 0;
    const events = (await c.query<{ kind: string; n: number }>(
      "SELECT kind, count(*)::int AS n FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND session_id=$2 GROUP BY kind",
      [row.tenant_id, row.id])).rows;
    return { pending, superseded, events };
  }, true);
  const transitions = counts.events.filter(e => [
    "Z3_CANDIDATE_RETAINED", "Z3_CHECK_OBSERVED", "Z3_S4_CONSUMPTION_RECORDED",
    "Z3_S7_COMPUTE_PERSISTED", "Z3_RESULT_PUBLISHED"].includes(e.kind))
    .reduce((sum, e) => sum + e.n, 0);
  const stalePublications = counts.events.find(e => e.kind === "Z3_STALE_PUBLICATION_REFUSED")?.n ?? 0;
  const compute = await listStoredWorkCompute(ctx,
    { workId: row.work_id, episodeIds: [sessionId], schema: Z3_COMPUTE_SCHEMA });
  const s5Current = row.reservation_ref === null ? null : await validateReservation(ctx, row.reservation_ref);
  const outstandingEffects = await unresolvedEffects(ctx);
  const status: SessionStatus = staleReason !== null && !Z3_TERMINAL_STATUSES.includes(row.status)
    ? "STALE" : row.status;
  return {
    schema: "finnor.z3.viability-read.v1" as const,
    sessionId: row.id, workId: row.work_id, workInputId: row.work_input_id,
    originalParentId: row.original_parent_id,
    status, staleReason, reason: row.reason,
    arenaDigest: row.arena_digest, bindingDigest: row.binding_digest,
    sourceRevision: binding.sourceRevision, rightsRevision: binding.rightsRevision,
    sourceDigest: binding.codeDigest, deadlineAt: binding.deadlineAt,
    reservationRef: row.reservation_ref, obligationRefs: row.obligation_refs,
    candidate: candidate === null ? null : {
      digest: row.candidate_digest, disposition: candidate.disposition,
      ordinaryStatus: candidate.disposition === "COMPLETE" ? candidate.ordinaryStatus : null,
      winningRegionSize: candidate.disposition === "COMPLETE" ? candidate.winningRegion.length : null,
      safetyKernelSize: candidate.disposition === "COMPLETE" ? candidate.safetyKernel.length : null,
      memories: candidate.disposition === "COMPLETE" ? candidate.strategy.memories.length : null,
      completeness: candidate.disposition === "COMPLETE" ? candidate.completeness : null,
    },
    check: receipt === null ? null : {
      digest: row.check_digest, status: receipt.status, reason: receipt.reason,
      ordinaryComplete: receipt.ordinaryComplete, ordinaryStatus: receipt.ordinaryStatus ?? null,
      safety: receipt.safety ?? null, liveness: receipt.liveness ?? null,
      nonconflicting: receipt.nonconflicting ?? null,
      originalAssumptionsSatisfiable: receipt.originalAssumptionsSatisfiable ?? null,
      reachable: receipt.reachable ?? null,
    },
    nextAuthorizedAction: {
      action: nextAuthorizedAction(arena, candidate),
      qualification: "MODEL_ACTION_UNDER_CURRENT_BINDING_NOT_EFFECT_AUTHORITY",
    },
    pendingJobs: counts.pending, supersededRunningJobs: counts.superseded,
    stalePublications, nativeTransitions: transitions,
    s4Consumed: row.s4_consumed, s5Current, s6OutstandingEffects: outstandingEffects,
    s7CostRef: compute.records.at(-1)?.ref ?? null,
    s7HistoryComplete: compute.complete,
    costs: { attempts: compute.records.length, money: null, status: "UNMETERED" as const },
    remainingBudget: null,
    remainingBudgetQualification: "UNMETERED_REMAINING_BUDGET_UNKNOWN_NOT_ZERO",
    claimFence: fenceOf(row) ?? 0,
    unknownClearedWithoutS6: false,
    conditionality: "Conditional recurrence is not a per-request deadline.",
    gates: {
      architecture: "IN_PROGRESS", internalSoftware: "IN_PROGRESS",
      installedReconstruction: "NOT_RUN", mathematicalSecurityDomain: "IN_PROGRESS",
      protectedAdmission: "NOT_RUN", equippedIncrement: "NOT_RUN",
      operational100x: "NOT_RUN", financialHeadroom: "NOT_RUN",
      financial100x: "NOT_RUN", productionActivation: "NOT_RUN",
    },
    envelope: {
      schemaVersion: "finnor.project-z.common-contracts.v1", phase: "Z3",
      principalOutputType: "ViabilityStrategy",
      immutableArtifactDigest: row.candidate_digest,
      productLockDigest: "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf",
      sourceCommit: binding.codeDigest, sourceTree: null,
      producerBuildIdentity: null,
      originalTenant: row.tenant_id, principal: row.principal_id,
      Work: { workId: row.work_id, workInputId: row.work_input_id },
      mandate: { digest: binding.mandateDigest }, assignment: null,
      parentReservation: row.reservation_ref, originalDeadline: binding.deadlineAt,
      remainingBudgetReference: null,
      unresolvedObligationReferences: row.obligation_refs,
      inputSemanticsAndRevisionReferences: {
        arenaDigest: row.arena_digest, bindingDigest: row.binding_digest,
        sourceRevision: binding.sourceRevision, observationDigest: binding.observationDigest,
        resourceDigest: binding.resourceDigest,
      },
      rightsAndPermittedUseFingerprint: binding.rightsRevision,
      supportedDomain: "PUBLIC_PERFECT_INFORMATION finite turn-based GR(1) profile (<=256 states, <=8 outgoing, <=2 assumptions, <=2 goals, <=4 memories)",
      unsupportedConditions: ["PARTIAL_OR_PRIVATE_OBSERVATION", "HIDDEN_STATE_ORACLE",
        "UNBOUNDED_OR_NONINTEGER_RESOURCES", "INVENTED_RENEWAL_OR_FAIRNESS"],
      claimAndEvidenceClasses: { computation: "deterministic", evidenceClass: "deterministic" },
      checkerIdentityAndResultReferences: { checkDigest: row.check_digest, candidateDigest: row.candidate_digest },
      currentnessDependencies: { workInputId: row.work_input_id, rightsRevision: binding.rightsRevision,
        codeDigest: binding.codeDigest, deadlineAt: binding.deadlineAt },
      securityAndConfidentialityProfile: { tenantIsolation: "ROW_LEVEL_SECURITY", secretsExported: false },
      ownerConsumerContractVersion: "z3-native-v1",
      costAndResourceReceiptReferences: { s7: compute.records.map(r => r.ref.id), s5: row.reservation_ref },
      gaps: ["NATIVE_E2E_NOT_RUN_WITHOUT_COORDINATOR_AUTHORIZATION",
        "MANDATE_REF_RESOLVED_TO_DIGEST_ONLY", "REMAINING_BUDGET_UNMETERED_NOT_ZERO"],
      reconstructionReference: null,
    },
    executionAuthorityGranted: false as const, protectedReceipt: null,
  };
}
