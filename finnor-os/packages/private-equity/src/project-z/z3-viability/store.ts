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
import type { Db } from "@finnor/db";
import { canExerciseAuthorityTx } from "@finnor/authority";
import type { z } from "zod";
import { ViabilityFault, PROFILE, type Candidate, type CheckReceipt,
  type OriginalBinding, type PublicArena } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { authorize, principal, tx, unavailable } from "../../evidence-execution/store";
import { listStoredWorkCompute, persistEconomicRecordTx } from "../../economic-store";
import type { PeMutationContext } from "../../types";
import { Z3_COMPUTE_SCHEMA, Z3_PRODUCE_JOB, Z3_RECOVER_JOB, Z3NativeFault,
  candidateDigestOf, hash, parseArena, parseBinding, parseStoredCandidate, parseStoredReceipt,
  receiptDigestOf, z3Fault, z3Ref,
  type ReadSchema, type RecoverSchema, type SubmitSchema,
  type ViabilityBoundaryPoint, type ViabilityCheckpoint, type ViabilitySessionRow,
  type ViabilityClaim, type ViabilityDelivery } from "./contracts";
import { assertViabilityJobLeaseTx } from "./delivery";
import { resolveViabilityNativeOrigin, chargeViabilityDelivery, type NativeOrigin } from "./native-origin";
import { viabilityRuntimeIdentity } from "./runtime";
import type { ViabilityBuildIdentity } from "./assets";
import type { ViabilityChildObservation } from "./process";
import type { ViabilityCursor } from "./consumer";
import { originalViabilityIdentityRefinement } from "../../../../orchestration/src/project-z/z3-viability/revision";
import { originalGeneralViabilityIdentityRefinement,
  type GeneralViabilityRevisionBridge } from "../../../../orchestration/src/project-z/z3-viability/general-revision";
import { GENERAL_NATIVE_MAPPING_FAILURES, isGeneralNativeMappingFailure } from "./general-transition";
export type { ViabilityBuildIdentity } from "./assets";

type SubmitInput = z.infer<typeof SubmitSchema>;
type RecoverInput = z.infer<typeof RecoverSchema>;
type ReadInput = z.infer<typeof ReadSchema>;
type SessionStatus = ViabilitySessionRow["status"];

/** Mathematical verdicts are immutable. Explicit recovery of VIABLE may
 * consume another finite owner prefix, never replace its candidate/check. */
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
    { operation: "query", capability: "query:pe_world_state", resource: { type: "work", id: workId }, risk: "low" }, c, lock);
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
  c: PoolClient, lock = true, resolved?: NativeOrigin): Promise<OriginalBinding> {
  await authorizeWork(ctx, row.work_id, c, lock);
  const binding = parse(() => parseBinding(row.binding));
  const origin = resolved ?? await resolveViabilityNativeOrigin(ctx, row.work_id, c, lock);
  if (origin.binding.workInputId !== row.work_input_id) z3Fault("Z3_WORK_INPUT_SUPERSEDED");
  if (origin.binding.rightsRevision !== binding.rightsRevision) z3Fault("Z3_AUTHORITY_REVISION_CHANGED");
  if (origin.binding.codeDigest !== binding.codeDigest) z3Fault("Z3_RUNTIME_SOURCE_CHANGED");
  if (hash(origin.binding) !== row.binding_digest || hash(origin.model.arena) !== row.arena_digest
    || hash(origin.reservationRef) !== hash(row.reservation_ref)
    || hash(origin.obligationIds) !== hash(row.obligation_refs)) z3Fault("Z3_NATIVE_OWNER_DEPENDENCIES_CHANGED");
  if (Date.now() >= Date.parse(binding.deadlineAt)) z3Fault("Z3_DEADLINE_EXHAUSTED");
  return binding;
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

export async function nativeMappingFailureTx(row: ViabilitySessionRow, c: PoolClient): Promise<string | null> {
  const fault = (await c.query<{ code: string }>(
    `SELECT body->>'code' code FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
     AND session_id=$3 AND kind='Z3_DELIVERY_FAULT' AND body->>'code'=ANY($4::text[]) ORDER BY id DESC LIMIT 1`,
    [row.tenant_id, row.principal_id, row.id, GENERAL_NATIVE_MAPPING_FAILURES])).rows[0];
  return fault && isGeneralNativeMappingFailure(fault.code) ? fault.code : null;
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

/** Called only under the original native/S5 serializer, after existing-key
 * replay. Semantic aliases cannot create unlimited retained rows. */
async function assertViabilityRequestRoom(ctx: PeMutationContext, workId: string, c: PoolClient) {
  const count = (await c.query<{ n: number }>(
    `SELECT count(*)::int n FROM finnor_os.z3_viability_requests r
     JOIN finnor_os.z3_viability_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
     WHERE r.tenant_id=$1 AND r.principal_id=$2 AND s.work_id=$3`,
    [ctx.auth.tenantId, principal(ctx), workId])).rows[0]?.n;
  if (count === undefined || count >= 256) z3Fault("Z3_REQUEST_HISTORY_BOUND");
}

export async function createViabilitySession(ctx: PeMutationContext, input: SubmitInput) {
  return tx(ctx, async (c) => {
    const origin = await resolveViabilityNativeOrigin(ctx, input.workId, c);
    await authorizeOwner(ctx, c);
    await authorizeWork(ctx, input.workId, c);
    const { binding, reservationRef, model: { arena } } = origin;
    for (const key of ["originalParentId", "sourceRevision", "mandateDigest", "observationDigest",
      "resourceDigest", "deadlineAt"] as const) {
      if (input[key] !== undefined && input[key] !== binding[key]) z3Fault("Z3_CALLER_EXPECTATION_NOT_ORIGINAL");
    }
    if (input.arena !== undefined && hash(input.arena) !== hash(arena)
      || input.reservationRef !== undefined && hash(input.reservationRef) !== hash(reservationRef)) {
      z3Fault("Z3_CALLER_EXPECTATION_NOT_ORIGINAL");
    }
    const arenaDigest = hash(arena), bindingDigest = hash(binding);
    const requestDigest = hash({ operation: "viability-submit", workId: input.workId,
      arenaDigest, bindingDigest, reservationRef });
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,3303))",
      [`${ctx.auth.tenantId}:${principal(ctx)}:${input.idempotencyKey}`]);
    const prior = (await c.query<{ request_digest: string; session_id: string }>(
      "SELECT request_digest, session_id::text AS session_id FROM finnor_os.z3_viability_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) z3Fault("Z3_IDEMPOTENCY_CONFLICT");
      const current = await viabilitySession(ctx, prior.session_id, c);
      return { schema: "finnor.z3.viability-submit.v1" as const, sessionId: current.id,
        semanticReplay: true as const, status: current.status };
    }
    await assertViabilityRequestRoom(ctx, input.workId, c);
    const previous = (await c.query<{ id: string }>(
      `SELECT id::text FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
       ORDER BY created_at DESC,id DESC LIMIT 1`, [ctx.auth.tenantId, principal(ctx), input.workId])).rows[0];
    let revisionBridge: ReturnType<typeof originalViabilityIdentityRefinement> | GeneralViabilityRevisionBridge | null = null;
    if (previous) {
      const priorSession = await viabilitySession(ctx, previous.id, c, true), priorBinding = parseBinding(priorSession.binding);
      if (priorBinding.originalParentId !== binding.originalParentId || priorBinding.deadlineAt !== binding.deadlineAt
        || priorBinding.resourceDigest !== binding.resourceDigest || hash(priorSession.reservation_ref) !== hash(reservationRef)
        || hash(priorSession.obligation_refs) !== hash(origin.obligationIds)) z3Fault("Z3_ORIGINAL_PARENT_BUDGET_OR_OBLIGATION_RENEWAL_REFUSED");
      // Losing a retry key cannot fork two independently valid original-Work
      // cursors. The original S5 serializer covers this lookup and request map.
      if (priorSession.binding_digest === bindingDigest) {
        await c.query(`INSERT INTO finnor_os.z3_viability_requests(
          tenant_id,principal_id,idempotency_key,request_digest,session_id) VALUES($1,$2,$3,$4,$5)`,
          [ctx.auth.tenantId, principal(ctx), input.idempotencyKey, requestDigest, priorSession.id]);
        return { schema: "finnor.z3.viability-submit.v1" as const, sessionId: priorSession.id,
          semanticReplay: true as const, status: priorSession.status };
      }
      const priorPrefix = (await c.query<{ body: { cursor: ViabilityCursor; cursorDigest: string } }>(
        `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
         AND session_id=$3 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id DESC LIMIT 1`,
        [ctx.auth.tenantId, principal(ctx), previous.id])).rows[0]?.body;
      if (priorSession.s4_consumed) {
        const oldCandidate = parseStoredCandidate(priorSession.candidate);
        if (!priorPrefix || hash(priorPrefix.cursor) !== priorPrefix.cursorDigest || oldCandidate.disposition !== "COMPLETE") {
          z3Fault("Z3_PREVIOUS_ACTUAL_CURSOR_REQUIRED");
        }
        if (priorPrefix.cursor.schema === "finnor.z3.s4-cursor.v2") {
          if (await nativeMappingFailureTx(priorSession, c)) z3Fault("Z3_GENERAL_NATIVE_SEMANTIC_REVISION_BRIDGE_REQUIRED");
          const oldReceipt = parseStoredReceipt(priorSession.check_receipt);
          if (!origin.general || oldCandidate.schema !== "finnor.z3.viability-candidate.v2"
            || oldReceipt.status !== "VIABLE" || oldReceipt.nonconflictingComplete !== true) {
            z3Fault("Z3_GENERAL_NATIVE_PREVIOUS_CHECKED_PREFIX_REQUIRED");
          }
          try { revisionBridge = originalGeneralViabilityIdentityRefinement({
            previousSessionId: previous.id, previousBinding: priorBinding, binding,
            previousArena: parseArena(priorSession.arena), arena, previousReservation: priorSession.reservation_ref,
            reservation: reservationRef, strategy: oldCandidate.strategy, cursor: priorPrefix.cursor,
            mapDigest: origin.general.request.model.mapDigest, ownerEvidenceDigest: origin.general.evidence.digest,
          }); } catch { z3Fault("Z3_GENERAL_NATIVE_SEMANTIC_REVISION_BRIDGE_REQUIRED"); }
        } else {
          try { revisionBridge = originalViabilityIdentityRefinement({
            previousSessionId: previous.id, previousBinding: priorBinding, binding,
            previousArena: parseArena(priorSession.arena), arena, previousReservation: priorSession.reservation_ref,
            reservation: reservationRef, strategy: oldCandidate.strategy, cursor: priorPrefix.cursor,
          }); } catch { z3Fault("Z3_ORIGINAL_BEHAVIOR_REVISION_BRIDGE_REQUIRED"); }
        }
      }
    }
    if (origin.remaining.attempts < 1 || origin.remaining.steps < 5 || origin.remaining.computeRequests < 1) {
      z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
    }
    const id = randomUUID();
    const obligationRefs = origin.obligationIds;
    await c.query(
      `INSERT INTO finnor_os.z3_viability_sessions(
         id,tenant_id,principal_id,work_id,work_input_id,original_parent_id,
         arena_digest,binding_digest,arena,binding,reservation_ref,status,generation,
         checkpoint,obligation_refs,deadline_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,'INTAKE',1,'[]'::jsonb,$12::jsonb,$13)`,
      [id, ctx.auth.tenantId, principal(ctx), input.workId, binding.workInputId, binding.originalParentId,
        arenaDigest, bindingDigest, JSON.stringify(arena), JSON.stringify(binding),
        JSON.stringify(reservationRef), JSON.stringify(obligationRefs), binding.deadlineAt]);
    await c.query(
      `INSERT INTO finnor_os.z3_viability_requests(tenant_id,principal_id,idempotency_key,request_digest,session_id)
       VALUES($1,$2,$3,$4,$5)`,
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey, requestDigest, id]);
    const row = await viabilitySession(ctx, id, c, true);
    await viabilityEvent(ctx, row, "Z3_SESSION_INTAKE", {
      workId: input.workId, workInputId: binding.workInputId, arenaDigest, bindingDigest,
      originalParentId: binding.originalParentId, reservationRef, remainingBudget: origin.remaining, revisionBridge,
      nativeProfile: origin.model.kind, mappingDigest: origin.general?.request.model.mapDigest ?? null,
      ownerBindingDigest: origin.general?.evidence.digest ?? null,
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
  delivery: ViabilityDelivery): Promise<ViabilitySessionRow> {
  const execution = delivery.physical;
  return tx(ctx, async (c) => {
    const origin = await resolveViabilityNativeOrigin(ctx, row.work_id, c);
    await authorizeOwner(ctx, c);
    await assertViabilityJobLeaseTx(ctx, row, delivery, c);
    const current = await viabilitySession(ctx, row.id, c, true);
    await assertViabilityCurrent(ctx, current, c, true, origin);
    const continuation = delivery.jobType === Z3_RECOVER_JOB && current.status === "VIABLE" && current.s4_consumed;
    if (current.active_claim_token === execution.claimToken
      && (["INTAKE", "PRODUCING", "CHECKING", "UNKNOWN"].includes(current.status) || continuation)) return current;
    if (Z3_TERMINAL_STATUSES.includes(current.status) && !continuation) z3Fault("Z3_STALE_FENCE");
    if ((await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id<>$2
      AND payload->>'sessionId'=$3 AND claim_token=$4 AND status='running'
      AND lease_expires_at>clock_timestamp() LIMIT 1 FOR SHARE`,
      [row.tenant_id, execution.jobId, row.id, current.active_claim_token])).rowCount) z3Fault("Z3_PRIOR_DELIVERY_STILL_LIVE");
    const charge = await chargeViabilityDelivery(ctx, origin, delivery, c);
    const updated = (await c.query<ViabilitySessionRow>(
      `UPDATE finnor_os.z3_viability_sessions
          SET active_claim_token=$4, active_claim_fence=COALESCE(active_claim_fence,0)+1,
              generation=generation+1,
              status=CASE WHEN status='INTAKE' THEN 'PRODUCING' ELSE status END,
              updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND principal_id=$3
          AND (status IN ('INTAKE','PRODUCING','CHECKING','UNKNOWN') OR ($5 AND status='VIABLE' AND s4_consumed))
          AND active_claim_token IS DISTINCT FROM $4
        RETURNING *`,
      [row.tenant_id, row.id, principal(ctx), execution.claimToken, continuation])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
    await viabilityEvent(ctx, updated, "Z3_PHYSICAL_DELIVERY_CHARGED", {
      jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      jobClaimFence: execution.claimFence, claimFence: fenceOf(updated), chargeRef: charge.charge.ref,
      originalP1Episode: origin.parent.episode_id, originalCompilerEpisode: origin.compilerEpisodeId,
      interruptedCostGapRetained: true, money: null }, c);
    await assertViabilityJobLeaseTx(ctx, updated, delivery, c);
    if (Date.now() >= Date.parse(origin.binding.deadlineAt)) z3Fault("Z3_DEADLINE_EXHAUSTED");
    return updated;
  });
}

/** The writer must still hold the real durable job lease it claims under. */
export async function assertViabilityJobLease(ctx: PeMutationContext, row: ViabilitySessionRow,
  delivery: ViabilityDelivery) {
  return tx(ctx, async c => assertViabilityJobLeaseTx(ctx, row, delivery, c));
}

export async function assertViabilityClaimTx(ctx: PeMutationContext, row: ViabilitySessionRow,
  claim: ViabilityClaim, c: PoolClient): Promise<ViabilitySessionRow> {
  await assertViabilityJobLeaseTx(ctx, row, claim, c);
  const current = await viabilitySession(ctx, row.id, c, true);
  if (current.active_claim_token !== claim.physical.claimToken || fenceOf(current) !== claim.sessionFence) {
    z3Fault("Z3_STALE_FENCE");
  }
  return current;
}

/** All physical writers use this transaction, including checkpoints, reuse and
 * fault recording. A final lease/deadline check rolls the WHOLE boundary back. */
export async function withViabilityClaim<T>(ctx: PeMutationContext, row: ViabilitySessionRow,
  claim: ViabilityClaim, fn: (current: ViabilitySessionRow, origin: NativeOrigin,
    c: PoolClient, db: Db) => Promise<T>): Promise<T> {
  return tx(ctx, async (c, db) => {
    const origin = await resolveViabilityNativeOrigin(ctx, row.work_id, c);
    const current = await assertViabilityClaimTx(ctx, row, claim, c);
    await authorizeOwner(ctx, c);
    await assertViabilityCurrent(ctx, current, c, true, origin);
    const result = await fn(current, origin, c, db);
    await assertViabilityCurrent(ctx, current, c);
    await assertViabilityJobLeaseTx(ctx, current, claim, c);
    if (Date.now() >= Date.parse(origin.binding.deadlineAt)) z3Fault("Z3_DEADLINE_EXHAUSTED");
    return result;
  });
}

export async function checkpointViability(ctx: PeMutationContext, row: ViabilitySessionRow,
  point: ViabilityBoundaryPoint, claim: ViabilityClaim): Promise<void> {
  const execution = claim.physical;
  const checkpoint: ViabilityCheckpoint = { point, jobId: execution.jobId,
    deliveryAttemptId: execution.deliveryAttemptId, claimFence: claim.sessionFence, jobClaimFence: execution.claimFence,
    at: new Date().toISOString() };
  await withViabilityClaim(ctx, row, claim, async (_current, _origin, c) => {
    const updated = (await c.query(
      `UPDATE finnor_os.z3_viability_sessions
          SET checkpoint=COALESCE(checkpoint,'[]'::jsonb) || $4::jsonb, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$5
          AND jsonb_array_length(COALESCE(checkpoint,'[]'::jsonb)) < 64
        RETURNING id`,
      [row.tenant_id, row.id, execution.claimToken, JSON.stringify(checkpoint), claim.sessionFence])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
  });
}

export async function publishViabilityCandidate(ctx: PeMutationContext, row: ViabilitySessionRow,
  claim: ViabilityClaim, candidate: Candidate): Promise<ViabilitySessionRow> {
  const execution = claim.physical;
  return withViabilityClaim(ctx, row, claim, async (current, _origin, c) => {
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
      [row.tenant_id, row.id, execution.claimToken, JSON.stringify(candidate), digest, claim.sessionFence])).rows[0];
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
  claim: ViabilityClaim, receipt: CheckReceipt): Promise<ViabilitySessionRow> {
  const execution = claim.physical;
  parseStoredReceipt(receipt);
  return withViabilityClaim(ctx, row, claim, async (current, _origin, c) => {
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
      [row.tenant_id, row.id, execution.claimToken, JSON.stringify(receipt), digest, claim.sessionFence])).rows[0];
    if (!updated) z3Fault("Z3_STALE_FENCE");
    await viabilityEvent(ctx, current, "Z3_CHECK_OBSERVED", {
      checkRef: ref, checkDigest: digest, status: receipt.status, reason: receipt.reason,
      ordinaryComplete: receipt.ordinaryComplete,
      qualification: "INDEPENDENT_PROCESS_OBSERVATION_RECORDED_BEFORE_COMPLETION" }, c);
    return updated;
  });
}

export interface ViabilityMeters {
  wallMs: number; userCpuMicros: number; systemCpuMicros: number; processMaxRss: number;
  children: ViabilityChildObservation[];
  meterBasis: "WORKER_PROCESS_DELTA_NOT_ISOLATED_CHILD_CPU";
  childCpuMicros: null; childMaxRss: null;
}

export async function publishViabilityResult(ctx: PeMutationContext, row: ViabilitySessionRow,
  claim: ViabilityClaim, candidate: Candidate, receipt: CheckReceipt,
  meters: ViabilityMeters, build: ViabilityBuildIdentity): Promise<ViabilitySessionRow> {
  const execution = claim.physical;
  parseStoredReceipt(receipt);
  return withViabilityClaim(ctx, row, claim, async (current, origin, c, db) => {
    const binding = origin.binding;
    if (hash(build) !== hash((await viabilityRuntimeIdentity()).assets)) z3Fault("Z3_BUILD_BINDING_CHANGED");
    if (current.candidate_digest === null || current.candidate_digest !== candidateDigestOf(candidate)
      || current.check_digest === null || current.check_digest !== receiptDigestOf(receipt)) {
      z3Fault("Z3_PUBLISH_PREIMAGE_CHANGED");
    }
    const s5Current = true;
    let ownerConsumption: unknown = null;
    if (receipt.status === "VIABLE") {
      const owner = await import("../../enterprise-control");
      if (!("continueEnterpriseViabilityTx" in owner) || typeof owner.continueEnterpriseViabilityTx !== "function") {
        z3Fault("Z3_S4_OWNER_NOT_INSTALLED");
      }
      ownerConsumption = await (owner.continueEnterpriseViabilityTx as ViabilityS4Consumer)(ctx, current.id, claim, c, db);
      if (!ownerConsumption || (ownerConsumption as { consumed?: unknown }).consumed !== true) z3Fault("Z3_S4_CONSUMPTION_NOT_OBSERVED");
    }
    const runManifestRef = await retainViabilityArtifact(ctx, current, "run-manifest", {
      schema: "finnor.z3.run-manifest.v1", ...build,
      jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      jobClaimFence: execution.claimFence, claimFence: claim.sessionFence, ownerConsumption,
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
      uncertainty: "WORKER_PROCESS_DELTA_AND_CHILD_WALL_OBSERVED; CHILD_CPU_RSS_PROVIDER_BILL_AND_HUMAN_WORK_UNMETERED_NOT_ZERO",
    }, c);
    await viabilityEvent(ctx, current, "Z3_S7_COMPUTE_PERSISTED", {
      recordRef: compute.record.ref, semanticReplay: compute.semanticReplay,
      qualification: "ORDINARY_S7_RECORD_NOT_A_PROTECTED_RECEIPT" }, c);
    const s4Consumed = ownerConsumption !== null;
    const status: SessionStatus = receipt.status === "VIABLE" ? "VIABLE"
      : receipt.status === "UNREALIZABLE" ? "UNREALIZABLE"
      : receipt.status === "UNKNOWN" ? "UNKNOWN" : "FAILED";
    const updated = (await c.query<ViabilitySessionRow>(
      `UPDATE finnor_os.z3_viability_sessions
          SET status=$4, reason=$5, s4_consumed=$6, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$7
        RETURNING *`,
      [row.tenant_id, row.id, execution.claimToken, status, receipt.reason, s4Consumed, claim.sessionFence])).rows[0];
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
  claim: ViabilityClaim, error: unknown, meters?: ViabilityMeters): Promise<void> {
  const execution = claim.physical;
  const code = error instanceof Z3NativeFault ? error.code : "Z3_INTERNAL_FAULT";
  try {
    const preimage = await viabilitySession(ctx, sessionId);
    await withViabilityClaim(ctx, preimage, claim, async (row, _origin, c) => {
      const status: SessionStatus = /STALE|SUPERSEDED|CHANGED|EXHAUSTED|EXPIRED/.test(code) ? "STALE"
        : /INTERNAL|CORRUPT|PROTOCOL|MISMATCH|UNSUPPORTED|REJECTED|UNPINNED/.test(code) ? "FAILED" : "UNKNOWN";
      await c.query(
        `UPDATE finnor_os.z3_viability_sessions SET status=$4, reason=$5, updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND active_claim_token=$3 AND active_claim_fence=$6
           AND status NOT IN ('VIABLE','UNREALIZABLE','STALE','FAILED')`,
        [row.tenant_id, row.id, execution.claimToken, status, code, claim.sessionFence]);
      await viabilityEvent(ctx, row, "Z3_DELIVERY_FAULT", {
        code, jobId: execution.jobId, claimFence: claim.sessionFence, jobClaimFence: execution.claimFence,
        meters: meters ?? null,
        responsibilitiesRetained: true, unknownCleared: false }, c);
    });
  } catch { /* A dead lease has no session write authority, even for an event.
    * Queue-owned delivery evidence and precharged S5/P1 resources remain. */ }
}

export type ViabilityS4Consumer = (ctx: PeMutationContext, sessionId: string, claim: ViabilityClaim,
  c: PoolClient, db: Db) => Promise<unknown>;

export async function requestViabilityRecovery(ctx: PeMutationContext, input: RecoverInput) {
  return tx(ctx, async (c) => {
    const initial = await viabilitySession(ctx, input.sessionId, c);
    const origin = await resolveViabilityNativeOrigin(ctx, initial.work_id, c);
    await authorizeOwner(ctx, c);
    const row = await viabilitySession(ctx, input.sessionId, c, true);
    if (input.root) await authorize(ctx, input.root, [{ type: "work", id: row.work_id }], [], c);
    await assertViabilityCurrent(ctx, row, c, true, origin);
    const requestDigest = hash({ operation: "viability-recover", sessionId: row.id,
      bindingDigest: row.binding_digest });
    const key = `recover:${input.idempotencyKey}`;
    const prior = (await c.query<{ request_digest: string }>(
      "SELECT request_digest FROM finnor_os.z3_viability_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [row.tenant_id, principal(ctx), key])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) z3Fault("Z3_IDEMPOTENCY_CONFLICT");
      return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
        recovery: "ENQUEUED" as const, status: row.status, semanticReplay: true };
    }
    if (await nativeMappingFailureTx(row, c)) z3Fault("Z3_NATIVE_MAPPING_FALSIFIED_REQUIRES_ADMITTED_REVISION");
    if (Z3_TERMINAL_STATUSES.includes(row.status) && row.status !== "VIABLE") {
      return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
        recovery: "NOT_REQUIRED_TERMINAL" as const, status: row.status };
    }
    if (origin.remaining.attempts < 1 || origin.remaining.steps < 5 || origin.remaining.computeRequests < 1) {
      z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
    }
    // Never supersede a still-live physical delivery to manufacture a retry.
    // Expired/quarantined deliveries retain their charge and queue evidence.
    const queued = (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM finnor_os.jobs
        WHERE tenant_id=$1 AND type IN ($2,$3) AND payload->>'sessionId'=$4
          AND (status='queued' OR (status='running' AND lease_expires_at>clock_timestamp()))`,
      [row.tenant_id, Z3_PRODUCE_JOB, Z3_RECOVER_JOB, row.id])).rows[0]?.n ?? 0;
    if (queued > 0) {
      return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
        recovery: "ALREADY_LIVE" as const, status: row.status };
    }
    await assertViabilityRequestRoom(ctx, row.work_id, c);
    await c.query(
      "INSERT INTO finnor_os.z3_viability_requests(tenant_id,principal_id,idempotency_key,request_digest,session_id) VALUES($1,$2,$3,$4,$5)",
      [row.tenant_id, principal(ctx), key, requestDigest, row.id]);
    await enqueueViabilityJob(ctx, row, Z3_RECOVER_JOB, `z3r:${row.id}:${hash(input.idempotencyKey)}`, c);
    await viabilityEvent(ctx, row, "Z3_RECOVERY_ENQUEUED", {
      idempotencyKey: input.idempotencyKey, replay: !!prior,
      qualification: "RECOVERY_REPLAYS_DURABLE_CHECKPOINTS_ONLY_NO_EFFECT_REPLAY" }, c);
    return { schema: "finnor.z3.viability-recover.v1" as const, sessionId: row.id,
      recovery: "ENQUEUED" as const, status: row.status };
  });
}

function nextAuthorizedAction(arena: PublicArena, candidate: Candidate | null, cursor: ViabilityCursor | null): string | null {
  if (!candidate || candidate.disposition !== "COMPLETE" || !cursor && arena.initial.length !== 1) return null;
  const index = arena.states.findIndex(s => s.id === (cursor?.stateId ?? arena.initial[0]));
  const state = arena.states[index];
  if (!state || state.owner === "E") return null;
  const edge = candidate.strategy.actions[cursor?.memory ?? candidate.strategy.initial[0] ?? 0]?.[index];
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
  let row = input.sessionId
    ? await viabilitySession(ctx, input.sessionId)
    : await latestViabilitySessionForWork(ctx, input.workId as string);
  const root = input.root;
  const sessionId = row.id;
  if (root) await authorize(ctx, root, [{ type: "work", id: row.work_id }]);
  let staleReason: string | null = null;
  let remainingBudget: NativeOrigin["remaining"] | null = null;
  let nativeProfile: "READINESS" | "GENERAL" | null = null;
  let actualOutstanding: number | null = null;
  let modeledResourceState: NativeOrigin["resourceState"] = null;
  try {
    // Existing native owners take currentness locks and retain S1 decisions.
    // Do not incorrectly call those owners inside a SQL READ ONLY transaction.
    const current = await tx(ctx, async (c) => {
      const origin = await resolveViabilityNativeOrigin(ctx, row.work_id, c);
      const loaded = await viabilitySession(ctx, row.id, c, true);
      await authorizeOwner(ctx, c);
      await assertViabilityCurrent(ctx, loaded, c, true, origin);
      return { row: loaded, remaining: origin.remaining, nativeProfile: origin.model.kind,
        outstanding: origin.resourceState?.unknown.length ?? origin.obligationIds.length,
        resourceState: origin.resourceState };
    });
    row = current.row; remainingBudget = current.remaining; nativeProfile = current.nativeProfile;
    actualOutstanding = current.outstanding; modeledResourceState = current.resourceState;
  } catch (error) {
    if (error instanceof Z3NativeFault) staleReason = error.code;
    else if (error instanceof Error && error.name === "PeDomainError") staleReason = "Z3_WORK_UNAVAILABLE";
    else if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,159}$/.test(error.message)) {
      staleReason = `Z3_ORIGINAL_OWNER_${error.message}`;
    } else throw error;
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
    const prefix = (await c.query<{ body: { cursor: ViabilityCursor; cursorDigest: string } }>(
      `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
        AND session_id=$3 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id DESC LIMIT 1`,
      [row.tenant_id, row.principal_id, row.id])).rows[0]?.body;
    if (prefix && (hash(prefix.cursor) !== prefix.cursorDigest
      || prefix.cursor.candidateDigest !== row.candidate_digest || prefix.cursor.checkDigest !== row.check_digest)) {
      z3Fault("Z3_S4_CURSOR_PREIMAGE_CHANGED");
    }
    const intake = (await c.query<{ body: { nativeProfile?: "READINESS" | "GENERAL" } }>(
      `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
       AND session_id=$3 AND kind='Z3_SESSION_INTAKE' ORDER BY id LIMIT 1`,
      [row.tenant_id, row.principal_id, row.id])).rows[0]?.body;
    const recordedProfile: "GENERAL" | "READINESS" | null = intake?.nativeProfile
      ?? (prefix?.cursor.schema === "finnor.z3.s4-cursor.v2" ? "GENERAL" : prefix ? "READINESS" : null);
    return { pending, superseded, events, cursor: prefix?.cursor ?? null,
      nativeProfile: recordedProfile,
      nativeMappingFailure: await nativeMappingFailureTx(row, c) };
  }, true);
  nativeProfile ??= counts.nativeProfile;
  const attempts = counts.events.find(e => e.kind === "Z3_PHYSICAL_DELIVERY_CHARGED")?.n ?? 0;
  const stalePublications = counts.events.find(e => e.kind === "Z3_STALE_PUBLICATION_REFUSED")?.n ?? 0;
  const compute = await listStoredWorkCompute(ctx,
    { workId: row.work_id, episodeIds: [sessionId], schema: Z3_COMPUTE_SCHEMA });
  const s5Current = staleReason === null ? true : null;
  const status: SessionStatus = staleReason !== null ? "STALE" : row.status;
  return {
    schema: "finnor.z3.viability-read.v1" as const,
    sessionId: row.id, workId: row.work_id, workInputId: row.work_input_id,
    originalParentId: row.original_parent_id,
    status, retainedStatus: row.status, staleReason, reason: row.reason,
    arenaDigest: row.arena_digest, bindingDigest: row.binding_digest,
    sourceRevision: binding.sourceRevision, rightsRevision: binding.rightsRevision,
    sourceDigest: binding.codeDigest, deadlineAt: binding.deadlineAt,
    reservationRef: row.reservation_ref, obligationRefs: row.obligation_refs,
    candidate: candidate === null ? null : {
      digest: row.candidate_digest, disposition: candidate.disposition,
      ordinaryStatus: candidate.disposition === "COMPLETE" ? candidate.ordinaryStatus : null,
      winningRegionSize: candidate.disposition === "COMPLETE" ? candidate.winningRegion.length : null,
      nonconflictingRegionSize: candidate.schema === "finnor.z3.viability-candidate.v2" ? candidate.nonconflicting.region.length : null,
      safetyKernelSize: candidate.disposition === "COMPLETE" ? candidate.safetyKernel.length : null,
      memories: candidate.disposition === "COMPLETE" ? candidate.strategy.memories.length : null,
      completeness: candidate.disposition === "COMPLETE" ? candidate.completeness : null,
    },
    check: receipt === null ? null : {
      digest: row.check_digest, status: receipt.status, reason: receipt.reason,
      ordinaryComplete: receipt.ordinaryComplete, ordinaryStatus: receipt.ordinaryStatus ?? null,
      nonconflictingComplete: receipt.nonconflictingComplete ?? null,
      nonconflictingStatus: receipt.nonconflictingStatus ?? null,
      nonconflictingRegionSize: receipt.nonconflictingRegion?.length ?? null,
      safety: receipt.safety ?? null, liveness: receipt.liveness ?? null,
      nonconflicting: receipt.nonconflicting ?? null,
      originalAssumptionsSatisfiable: receipt.originalAssumptionsSatisfiable ?? null,
      reachable: receipt.reachable ?? null,
    },
    nextAuthorizedAction: {
      action: staleReason || status !== "VIABLE" || receipt?.status !== "VIABLE"
        || counts.nativeMappingFailure
        || nativeProfile === "GENERAL" && !counts.cursor
        ? null : nextAuthorizedAction(arena, candidate, counts.cursor),
      qualification: nativeProfile === "GENERAL" ? "CURRENT_TYPED_S4_BINDING_NOT_EFFECT_AUTHORITY"
        : "INTERNAL_READINESS_MODEL_ACTION_NOT_EFFECT_AUTHORITY",
    },
    pendingJobs: counts.pending, supersededRunningJobs: counts.superseded,
    stalePublications, nativeTransitions: counts.cursor?.schema === "finnor.z3.s4-cursor.v2"
      ? counts.cursor.transitions : (counts.cursor?.operations ?? 0) * 2,
    nativeActions: counts.cursor?.operations ?? 0, s4Cursor: counts.cursor,
    s4Consumed: row.s4_consumed, s5Current, s6OutstandingEffects: actualOutstanding,
    s7CostRef: compute.records.at(-1)?.ref ?? null,
    s7HistoryComplete: compute.complete && attempts === compute.records.length,
    costs: { attempts, completedMeterRecords: compute.records.length, money: null, status: "UNMETERED" as const },
    remainingBudget,
    nativeProfile, modeledResourceState,
    nativeMappingFailure: counts.nativeMappingFailure,
    nativeUseStatus: counts.nativeMappingFailure ? "BLOCKED_MAPPING_FALSIFIER"
      : staleReason ? "BLOCKED_CURRENTNESS" : row.s4_consumed ? "FINITE_PREFIX_OBSERVED" : "NOT_CONSUMED",
    remainingBudgetQualification: "ORIGINAL_P1_AND_S5_REQUEST_UNITS_NOT_USD_OR_UNBOUNDED_ALLOWANCE",
    claimFence: fenceOf(row) ?? 0,
    unknownClearedWithoutS6: false,
    conditionality: "Conditional recurrence is not a per-request deadline or a promise of original fairness. Finite registered owner prefixes spend only the remaining original allowance; exhaustion or unmapped actual outcomes invalidate further use.",
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
      sourceCommit: null, sourceTree: null, sourceIdentityDigest: binding.codeDigest,
      producerBuildIdentity: row.check_receipt === null ? null : "SOURCE_BOUND_APPROVED_ASSETS_IN_RUN_MANIFEST",
      originalTenant: row.tenant_id, principal: row.principal_id,
      Work: { workId: row.work_id, workInputId: row.work_input_id },
      mandate: { digest: binding.mandateDigest }, assignment: null,
      parentReservation: row.reservation_ref, originalDeadline: binding.deadlineAt,
      remainingBudgetReference: remainingBudget === null ? null : { originalParentId: row.original_parent_id,
        reservationRef: row.reservation_ref, remaining: remainingBudget },
      unresolvedObligationReferences: row.obligation_refs,
      inputSemanticsAndRevisionReferences: {
        arenaDigest: row.arena_digest, bindingDigest: row.binding_digest,
        sourceRevision: binding.sourceRevision, observationDigest: binding.observationDigest,
        resourceDigest: binding.resourceDigest,
      },
      rightsAndPermittedUseFingerprint: binding.rightsRevision,
      supportedDomain: "PUBLIC_PERFECT_INFORMATION finite turn-based GR(1) input (<=256 states, <=8 outgoing, <=2 assumptions, <=2 goals); strategy <=4 memories and <=1024 product vertices",
      nativeSupportedDomain: nativeProfile === "GENERAL"
        ? "VERSIONED_GENERAL_ORIGINAL_MAP; total original edge/state/justice tables, actual initial selection, current typed S4 observation/exact-choice/composition owners; no external effect execution; S5 renewal requires an original typed owner representation"
        : nativeProfile === "READINESS"
          ? "S4_READINESS_RECONCILIATION_V1; no original fairness, exactly two operation goals, one observed initial controller state, no renewable resource"
          : "NATIVE_PROFILE_NOT_YET_CURRENTLY_RESOLVED",
      unsupportedConditions: ["PARTIAL_OR_PRIVATE_OBSERVATION", "HIDDEN_STATE_ORACLE",
        "UNBOUNDED_OR_NONINTEGER_RESOURCES", "INVENTED_RENEWAL_OR_FAIRNESS"],
      claimAndEvidenceClasses: { computation: "deterministic", evidenceClass: "deterministic" },
      checkerIdentityAndResultReferences: { checkDigest: row.check_digest, candidateDigest: row.candidate_digest },
      currentnessDependencies: { workInputId: row.work_input_id, rightsRevision: binding.rightsRevision,
        codeDigest: binding.codeDigest, deadlineAt: binding.deadlineAt },
      securityAndConfidentialityProfile: { tenantIsolation: "ROW_LEVEL_SECURITY", secretsExported: false },
      ownerConsumerContractVersion: "z3-native-v2",
      costAndResourceReceiptReferences: { s7: compute.records.map(r => r.ref.id), s5: row.reservation_ref },
      gaps: ["NATIVE_GENERAL_ARENA_MAPPING_NOT_IMPLEMENTED",
        "NATIVE_E2E_NOT_RUN_WITHOUT_COORDINATOR_AUTHORIZATION",
        "MANDATE_REF_RESOLVED_TO_DIGEST_ONLY", "USD_COSTS_UNMETERED_NOT_ZERO",
        "SOURCE_COMMIT_TREE_AND_RECONSTRUCTION_BOUND_SEPARATELY_IN_DELIVERY"],
      reconstructionReference: null,
    },
    executionAuthorityGranted: false as const, protectedReceipt: null,
  };
}
