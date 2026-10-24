import type { PoolClient } from "pg";
import type { ExperimentRef } from "@finnor/shared-types";
import { readAllocationSnapshotTx } from "../../allocation-store";
import * as s5 from "../../allocation-store";
import { nativeRequestRow, assertProgramCurrent, type InstitutionProgramRow } from "../../program-synthesis/store";
import { isInstitutionRequest } from "../../program-synthesis/contracts";
import { compilerRow, compilerEpisode } from "../../institution-program/store";
import type { InstitutionChargeRequest } from "../../institution-program/resource-demand";
import type { PeMutationContext } from "../../types";
import { principal } from "../../evidence-execution/store";
import { hash, parseBinding, z3Fault, type ViabilityClaim, type ViabilityDelivery } from "./contracts";
import { parseNativeOriginalInstruction, type NativeOriginalModel } from "./native-model";
import { viabilityRuntimeIdentity } from "./runtime";

type S5Validation = Awaited<ReturnType<typeof s5.validateInstitutionDemand>>;
type S5Charge = Awaited<ReturnType<typeof s5.chargeInstitutionDemand>>;
type S5TransactionOwners = typeof s5 & {
  INSTITUTION_TRANSACTION_BINDING: "finnor.s5.existing-institution-transaction.v1";
  validateInstitutionDemand(ctx: PeMutationContext, ref: ExperimentRef, client: PoolClient): Promise<S5Validation>;
  chargeInstitutionDemand(ctx: PeMutationContext, ref: ExperimentRef, request: InstitutionChargeRequest,
    client: PoolClient): Promise<S5Charge>;
};
function transactionOwners(): S5TransactionOwners {
  if (!("INSTITUTION_TRANSACTION_BINDING" in s5)
    || s5.INSTITUTION_TRANSACTION_BINDING !== "finnor.s5.existing-institution-transaction.v1") {
    z3Fault("Z3_S5_TRANSACTION_OWNER_NOT_INSTALLED");
  }
  return s5 as S5TransactionOwners;
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export interface NativeOrigin {
  model: NativeOriginalModel; parent: InstitutionProgramRow;
  binding: ReturnType<typeof parseBinding>; reservationRef: ExperimentRef;
  compilerEpisodeId: string; obligationIds: string[]; effectsDigest: string;
  remaining: { attempts: number; steps: number; computeRequests: number };
}

/** Uses the same S5 portfolio/source-authority lock ordering as its owners.
 * No alternative parent, mandate, deadline, budget or obligation is minted. */
export async function resolveViabilityNativeOrigin(ctx: PeMutationContext, workId: string,
  c: PoolClient, lock = true): Promise<NativeOrigin> {
  const resources = await readAllocationSnapshotTx(ctx, c);
  const work = (await c.query<{ status: string; created_by: string }>(
    "SELECT status,created_by FROM finnor_os.works WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR SHARE" : ""),
    [ctx.auth.tenantId, workId])).rows[0];
  if (!work || work.created_by !== principal(ctx)
    || ["cancelled", "completed", "failed"].includes(work.status)) z3Fault("Z3_ORIGINAL_WORK_NOT_CURRENT");
  const original = (await c.query<{ id: string; instruction_text: string; body: unknown }>(
    `SELECT id::text,instruction_text,to_jsonb(i) body FROM finnor_os.work_inputs i
     WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.auth.tenantId, workId])).rows[0];
  if (!original) z3Fault("Z3_ORIGINAL_WORK_INPUT_REQUIRED");
  const model = parseNativeOriginalInstruction(original.instruction_text);
  const parents = (await c.query<{ id: string }>(
    `SELECT r.id::text FROM finnor_os.p1_requests r
     JOIN finnor_os.work_plan_revisions p ON p.tenant_id=r.tenant_id AND p.id=r.plan_revision_id
       AND p.work_id=r.work_id AND p.work_input_id=r.work_input_id AND p.status='active'
     WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.work_input_id=$4
       AND r.request->>'schema'='finnor.harness-request.v1'
       AND r.request->>'kind'='institution_responsibility_v1'
       AND r.status IN('WAITING','RUNNING','QUEUED','PARTIAL')
     ORDER BY r.created_at DESC,r.id DESC LIMIT 2`,
    [ctx.auth.tenantId, principal(ctx), workId, original.id])).rows;
  if (parents.length !== 1 || !parents[0]) z3Fault("Z3_UNIQUE_ORIGINAL_NATIVE_CONTINUATION_REQUIRED");
  const parentRaw = await nativeRequestRow(ctx, parents[0].id, c, lock);
  if (!isInstitutionRequest(parentRaw.request) || !parentRaw.request.institution.compilerRequestId) {
    z3Fault("Z3_ORIGINAL_COMPILER_PARENT_REQUIRED");
  }
  const parent = parentRaw as InstitutionProgramRow;
  await assertProgramCurrent(ctx, parent, c, lock);
  const compiler = await compilerRow(ctx, parent.request.institution.compilerRequestId!, c, lock);
  const episode = await compilerEpisode(ctx, compiler.episode_id, c, lock);
  const reservationRef = parent.request.institution.reservationRef;
  if (!episode.parent_reservation || hash(episode.parent_reservation) !== hash(reservationRef)
    || episode.work_id !== workId) z3Fault("Z3_ORIGINAL_S5_PARENT_CHANGED");
  const validation = await transactionOwners().validateInstitutionDemand(ctx, reservationRef, c);
  if (validation.status !== "CURRENT" || validation.reservation.workId !== workId
    || validation.reservation.demand.chargeScope?.kind !== "ORIGINAL_WORK_EPISODE"
    || validation.reservation.demand.chargeScope.episodeId !== episode.id) z3Fault("Z3_S5_RESERVATION_NOT_CURRENT");
  const limits = (await c.query<{ id: string; max_attempts: number; max_steps: number;
    attempts_used: number; steps_used: number; deadline_at: Date }>(
    "SELECT id,max_attempts,max_steps,attempts_used,steps_used,deadline_at FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=$4"
    + (lock ? " FOR UPDATE" : ""), [ctx.auth.tenantId, principal(ctx), workId, parent.episode_id])).rows[0];
  if (!limits) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_REQUIRED");
  const deadlineAt = new Date(Math.min(Date.parse(validation.reservation.originalDeadline),
    Date.parse(iso(episode.original_deadline)), Date.parse(iso(episode.wall_deadline)),
    Date.parse(iso(limits.deadline_at)))).toISOString();
  if (Date.now() >= Date.parse(deadlineAt)) z3Fault("Z3_DEADLINE_EXHAUSTED");
  if ((await c.query<{ complete: boolean }>("SELECT finnor_os.y4_control_context_complete() complete")).rows[0]?.complete !== true) {
    z3Fault("Z3_S6_COMPLETE_CONTEXT_REQUIRED");
  }
  const effects = (await c.query<{ id: string; obligation_id: string | null; body: unknown }>(
    `SELECT e.id::text,o.obligation_id,to_jsonb(e) body FROM finnor_os.business_effects e
     LEFT JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=e.tenant_id AND o.effect_id=e.id
     WHERE e.tenant_id=$1 AND e.status NOT IN('verified','cancelled','compensated')
     ORDER BY e.id LIMIT 257` + (lock ? " FOR SHARE OF e" : ""), [ctx.auth.tenantId])).rows;
  if (effects.length > 256) z3Fault("Z3_ORIGINAL_OBLIGATION_BOUND");
  const obligationIds = [...new Set(effects.map(e => e.obligation_id ?? e.id))].sort();
  if (hash([...model.arena.resources.obligationIds].sort()) !== hash(obligationIds)
    || model.arena.states.some(state => hash([...state.unknown].sort()) !== hash(obligationIds))) {
    z3Fault("Z3_ORIGINAL_S6_IDENTITY_OR_UNKNOWN_CHANGED");
  }
  const charges = (await c.query<{ resource_id: string; units: number; unit: string }>(
    `SELECT resource_id,units,unit FROM finnor_os.s5_governed_resource_charges
     WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3 ORDER BY created_at,charge_key LIMIT 1421`,
    [ctx.auth.tenantId, principal(ctx), reservationRef.id])).rows;
  if (charges.length > 1420) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_BOUND");
  const compute = validation.reservation.envelopes.filter(e => e.unit === "request" && e.kind === "CUMULATIVE_EXPENDITURE");
  if (compute.length !== 1 || !compute[0]) z3Fault("Z3_ORIGINAL_NATIVE_COMPUTE_BUDGET_REQUIRED");
  const limit = Math.max(...compute[0].quantities.map(Number));
  const used = charges.filter(ch => ch.resource_id === compute[0]!.resourceId)
    .reduce((sum, ch) => sum + Number(ch.units), 0);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(used) || limit < used) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_INVALID");
  const rights = (await c.query<{ revision: string }>(
    "SELECT revision::text revision FROM finnor_os.authority_states WHERE tenant_id=$1" + (lock ? " FOR SHARE" : ""),
    [ctx.auth.tenantId])).rows[0];
  if (!rights) z3Fault("Z3_AUTHORITY_STATE_UNAVAILABLE");
  const runtime = await viabilityRuntimeIdentity();
  const effectsDigest = hash(effects);
  const binding = parseBinding({
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId, workInputId: original.id,
    originalParentId: episode.id,
    sourceRevision: hash({ input: original.body, parentId: parent.id, generation: parent.generation,
      planRevisionId: parent.plan_revision_id, requestDigest: parent.request_digest,
      compilerId: compiler.id, compilerRevision: compiler.revision, source: compiler.input_manifest?.current }),
    rightsRevision: rights.revision,
    mandateDigest: hash({ original: model.original, mandate: parent.request.institution.responsibilities.map(r => r.obligation.rule) }),
    observationDigest: hash({ publicObservations: model.arena.states.map(s => [s.id, s.observation]),
      operations: [...model.environmentOperations], effectsDigest }),
    resourceDigest: hash({ reservationRef, demand: validation.reservation.demand,
      resources: resources.resources.map(r => r.ref), episode: { id: limits.id,
        maxAttempts: limits.max_attempts, maxSteps: limits.max_steps }, obligations: obligationIds }),
    deadlineAt, codeDigest: runtime.digest,
  });
  return { model, parent, compilerEpisodeId: episode.id, binding, reservationRef, obligationIds, effectsDigest,
    remaining: { attempts: limits.max_attempts - limits.attempts_used,
      steps: limits.max_steps - limits.steps_used, computeRequests: limit - used } };
}

/** Same original P1 and S5 owners, once per actual physical delivery. A
 * vanished worker retains both debits; recovery has no replenishment path. */
export async function chargeViabilityDelivery(ctx: PeMutationContext, origin: NativeOrigin,
  delivery: ViabilityDelivery, c: PoolClient) {
  if (origin.remaining.attempts <= 0 || origin.remaining.steps <= 0 || origin.remaining.computeRequests <= 0) {
    z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
  }
  const charged = await c.query(
    `UPDATE finnor_os.p1_episodes SET attempts_used=attempts_used+1,steps_used=steps_used+1
     WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND work_id=$4
       AND attempts_used<max_attempts AND steps_used<max_steps AND deadline_at>clock_timestamp() RETURNING id`,
    [ctx.auth.tenantId, principal(ctx), origin.parent.episode_id, origin.binding.workId]);
  if (charged.rowCount !== 1) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
  const responsibilityIdentity = origin.parent.request.institution.responsibilities[0]?.obligation.stableIdentity;
  if (!responsibilityIdentity) z3Fault("Z3_ORIGINAL_RESPONSIBILITY_REQUIRED");
  return transactionOwners().chargeInstitutionDemand(ctx, origin.reservationRef, {
    responsibilityIdentity, phase: "CONTROL", ordinal: 1, units: 1,
    physicalInvocationId: delivery.physical.deliveryAttemptId,
  }, c);
}

export async function chargeViabilityOwnerStep(ctx: PeMutationContext, origin: NativeOrigin,
  claim: ViabilityClaim, c: PoolClient): Promise<void> {
  if (claim.sessionFence < 1) z3Fault("Z3_STALE_FENCE");
  const charged = await c.query(
    `UPDATE finnor_os.p1_episodes SET steps_used=steps_used+1
     WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND steps_used<max_steps
       AND deadline_at>clock_timestamp() RETURNING id`,
    [ctx.auth.tenantId, principal(ctx), origin.parent.episode_id]);
  if (charged.rowCount !== 1) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
}
