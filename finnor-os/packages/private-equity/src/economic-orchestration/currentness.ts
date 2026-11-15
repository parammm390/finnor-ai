import type { PoolClient } from "pg";
import { z } from "zod";
import type { PeMutationContext } from "../types";
import type { SearchRow, UnitRow } from "../compute-search/contracts";
import type { ProgramRow } from "../program-synthesis/store";
import { assertProgramCurrent } from "../program-synthesis/store";
import { searchForProgram, searchRow, append, units, snapshot } from "../compute-search/store";
import { authorize, sha, stable, tx } from "../evidence-execution/store";
import { EconomicOrchestrationOptionsSchema, nativeDeadlineAt } from "./contracts";
import { nativeFrameSchema, nativeStageActionSchema } from "./continuation-contracts";
import { isEconomicSearch } from "./snapshot";
import { latestPublishedEconomicCapsuleTx } from "./capsules";
import { nativeMaterialDigest } from "./policy";
import { currentEconomicCutTx } from "./cut";
import { nativeActionRef } from "./continuation";
import { nativeOwnerReadFailure, invalidateNativeOwnerUnavailableTx } from "./dependencies";
import { persistNativeGapTx } from "./gaps";
import { readNativeFrameTx } from "./observations";
import { recheckSearchOwners } from "../compute-search/owners";

export type EconomicBoundary = "SUBMIT" | "CLAIM" | "CHECK" | "PUBLISH" | "USE" | "DISPATCH";
export async function validateEconomicBinding(ctx: PeMutationContext, q: ProgramRow, request: unknown): Promise<void> {
  const parsed = z.object({ orchestration: EconomicOrchestrationOptionsSchema.optional(), deliberation: z.unknown().optional(),
    mode: z.string(), requestedKinds: z.string().array().optional() }).passthrough().parse(request);
  if (!parsed.orchestration) return;
  if (parsed.deliberation) throw Error("W1_M2_CONTROL_DOMAINS_CANNOT_BE_REINTERPRETED");
  if (parsed.mode !== "ordinary_disposable" || process.env.NODE_ENV === "production" || process.env.FINNOR_P4_PROFILE !== "ordinary_disposable")
    throw Error("W1_PROTECTED_OR_PRODUCTION_ADMISSION_UNAVAILABLE");
  if (parsed.requestedKinds?.length) throw Error("W1_NATIVE_CATALOGUE_MODEL_ACQUISITION_PORT_UNIMPLEMENTED");
  await assertProgramCurrent(ctx, q);
  await authorize(ctx, q.request.root, [{ type: "work", id: q.work_id }]);
}
/** Canonical acceptance rechecks the same owners on the accepting client.
 * A successful preflight cannot authorize an intervening changed Work/grant. */
export async function assertEconomicSubmitBoundaryTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient) {
  if (!isEconomicSearch(s.request)) return;
  await assertProgramCurrent(ctx, q, c, true);
  await recheckSearchOwners(ctx, q, s, c);
  return {
    boundary: "SUBMIT", originalEpisode: q.episode_id, originalWorkInput: q.work_input_id,
    originalDeadline: q.proposed.bounds.deadlineAt, originalGrant: s.request.computeGrant,
    scope: "CANONICAL_SAME_CLIENT_ACCEPTANCE_NOT_PREFLIGHT_ONLY", authorityGranted: false,
  };
}
const selectionSchema = z.object({
  unitId: z.string(), treatmentRef: z.string(), treatmentUnitIds: z.string().array(), selectionGroupRef: z.string(),
  actionRef: z.string(), beforeFrame: nativeFrameSchema, stageAction: nativeStageActionSchema,
  capsuleDigest: z.string().nullable(), originalEpisode: z.string(), originalDeadline: z.string(), originalAcceptance: z.string(),
  responseContext: z.object({ pins: z.unknown() }).passthrough(),
}).passthrough();
async function originalSelection(s: SearchRow, u: UnitRow, c: PoolClient) {
  const row = (await c.query(
    `SELECT kind,body,digest FROM finnor_os.p2_events WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3
     AND kind IN('W1_NEXT_COMPUTATION_APPLIED','W1_NATIVE_FALLBACK_APPLIED') AND body->>'unitId'=$4
     ORDER BY created_at DESC,id DESC LIMIT 1`, [s.tenant_id, s.principal_id, s.id, u.id])).rows[0];
  if (!row || sha(row.body) !== row.digest) throw Error("W1_ACTUAL_CONSUMER_SELECTION_REQUIRED");
  return { kind: String(row.kind), digest: String(row.digest), selection: selectionSchema.parse(row.body) };
}
/** Stamped into the original INTENT, not an independent effect/attempt ledger. */
export async function economicAttemptBindingTx(s: SearchRow, u: UnitRow, c: PoolClient) {
  if (String(u.kind) === "CONTROL_W1") return {};
  const { selection } = await originalSelection(s, u, c);
  return { w1SelectionGroupRef: selection.selectionGroupRef, w1ActionRef: selection.actionRef,
    w1BeforeFrameDigest: sha(selection.beforeFrame), w1OriginalSelection: true };
}
/** Withdraw only deliveries with no original physical intent whatsoever.
 * The original P2 scheduler owns the replacement, using a distinct plan-bound
 * idempotency key while preserving unit/episode/grant/generation/effect IDs. */
async function deferOriginalDelivery(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient, reason: string, ownerWait: boolean) {
  const queued = (await units(ctx, s, c)).filter(unit => unit.status === "QUEUED" && unit.attempts === 0);
  const retained: string[] = [];
  for (const unit of queued) {
    if ((await c.query("SELECT id FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND unit_id=$3 LIMIT 1",
      [s.tenant_id, s.principal_id, unit.id])).rowCount) continue;
    await c.query("UPDATE finnor_os.p2_units SET status=$2,updated_at=clock_timestamp() WHERE id=$1 AND status='QUEUED' AND attempts=0",
      [unit.id, String(unit.kind) === "CONTROL_W1" ? "CANCELLED" : "PENDING"]);
    retained.push(unit.id);
  }
  await append(ctx, s, "W1_PRE_ADMISSION_REPLANNED", { reason, withdrawnUnitIds: retained,
    originalEpisode: q.episode_id, originalGrant: s.request.computeGrant, originalCountersUnchanged: true,
    originalEffectIdsPreserved: true, newGrant: false, authorityGranted: false }, c);
  s.status = ownerWait ? "WAITING" : "RUNNING"; s.reason = reason;
  if (ownerWait) {
    if (/EXPIRED|EXHAUSTED/.test(reason)) s.status = "FAILED";
    await c.query("UPDATE finnor_os.p2_requests SET status=$4,reason=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [s.tenant_id, s.principal_id, s.id, s.status, reason]); await snapshot(ctx, s, q, c);
  } else {
    const { replan } = await import("../compute-search/controller");
    await replan(ctx, s, q, c);
  }
}
/** Check before admission AND before original result publication. A compatible
 * post-SUBMITTED outcome is retained even if its economic policy was invalidated;
 * policy invalidation alone must not manufacture UNKNOWN physical execution. */
export async function assertEconomicUnitBoundaryTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, unit: UnitRow,
  boundary: EconomicBoundary, c: PoolClient, jobId?: string): Promise<"CURRENT" | "RESCHEDULED"> {
  if (!isEconomicSearch(s.request)) return "CURRENT";
  const kind = String(unit.kind);
  const actual = (await c.query("SELECT id,status FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND unit_id=$4 AND status IN('INTENT','SUBMITTED','UNKNOWN') ORDER BY created_at DESC LIMIT 1",
    [s.tenant_id, s.principal_id, s.id, unit.id])).rows[0];
  let cut: Awaited<ReturnType<typeof currentEconomicCutTx>>;
  try { cut = await currentEconomicCutTx(ctx, s, q, c, actual?.id); }
  catch (error) {
    const predicate = nativeOwnerReadFailure(error);
    if (!predicate || boundary !== "CLAIM") throw error;
    await invalidateNativeOwnerUnavailableTx(s, q, await latestPublishedEconomicCapsuleTx(ctx, s, c, { historical: true }), predicate, c);
    await persistNativeGapTx(ctx, s, c, { kind: "ORIGINAL_OWNER_CURRENTNESS_UNPASSED", subjectRef: unit.id,
      contextRef: "original-search:" + s.id, evidenceRefs: ["p2-unit:" + unit.id], detail: predicate });
    await deferOriginalDelivery(ctx, s, q, c, "W1_ORIGINAL_OWNER_WAIT:" + predicate, true); return "RESCHEDULED";
  }
  const { input, capsule, invalidated } = cut;
  if (input.outstanding.some(o => o.status === "UNKNOWN") || actual?.status === "UNKNOWN") {
    if (boundary !== "CLAIM") throw Error("W1_ORIGINAL_UNKNOWN_REQUIRES_RECONCILIATION");
    await deferOriginalDelivery(ctx, s, q, c, "W1_UNKNOWN_REQUIRES_ORIGINAL_OWNER_RECONCILIATION", true); return "RESCHEDULED";
  }
  if (input.remaining.wallMs <= 0 || nativeDeadlineAt(input) <= Date.now()) {
    if (boundary !== "CLAIM") throw Error("W1_ORIGINAL_EPISODE_DEADLINE_EXHAUSTED");
    await deferOriginalDelivery(ctx, s, q, c, "W1_ORIGINAL_EPISODE_DEADLINE_EXHAUSTED", true); return "RESCHEDULED";
  }
  const live = (await units(ctx, s, c)).find(row => row.id === unit.id);
  if (boundary === "CLAIM" && (!live || !["QUEUED", "RUNNING"].includes(live.status))) return "RESCHEDULED";
  if (kind !== "CONTROL_W1") {
    const { selection, kind: selectionKind } = await originalSelection(s, unit, c);
    if (selection.originalEpisode !== q.episode_id || selection.originalDeadline !== q.proposed.bounds.deadlineAt ||
        selection.originalAcceptance !== q.proposed.acceptanceDigest || selection.actionRef !== nativeActionRef(selection.stageAction.unitKeys))
      throw Error("W1_ORIGINAL_SELECTION_ASSIGNMENT_BINDING_REQUIRED");
    if (boundary === "CLAIM" && jobId) {
      const job = (await c.query("SELECT payload FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND protocol_version=3 AND type='run_compute_search_unit_v1'",
        [jobId, s.tenant_id])).rows[0];
      if (job?.payload.w1SelectionGroupRef !== selection.selectionGroupRef) return "RESCHEDULED";
    }
    const compatible = stable(selection.responseContext.pins) === stable(input.pins) &&
      input.catalogue.entries.some(entry => (boundary !== "CLAIM" || entry.available) &&
        entry.treatmentRef === selection.treatmentRef && entry.unitIds.includes(unit.id)) &&
      selection.stageAction.unitIds.every(id => input.frame?.units.some(current =>
        current.unitId === id && selection.stageAction.unitKeys.includes(current.key)));
    if (!compatible) {
      if (boundary !== "CLAIM") throw Error("W1_ORIGINAL_NATIVE_METHOD_OR_SOURCE_CURRENTNESS_UNPASSED");
      await deferOriginalDelivery(ctx, s, q, c, "W1_PRE_ADMISSION_COMPATIBLE_REPLAN_REQUIRED", false); return "RESCHEDULED";
    }
    const stalePolicy = selectionKind === "W1_NEXT_COMPUTATION_APPLIED" &&
      (!capsule || sha(capsule) !== selection.capsuleDigest || invalidated || nativeMaterialDigest(input) !== capsule.proposal.materialDigest);
    if (stalePolicy && boundary === "CLAIM") {
      const partial = (await c.query("SELECT id FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND body->>'w1SelectionGroupRef'=$4 LIMIT 1",
        [s.tenant_id, s.principal_id, s.id, selection.selectionGroupRef])).rowCount;
      if (!partial) {
        await deferOriginalDelivery(ctx, s, q, c, "W1_PRE_ADMISSION_INVALIDATED_POLICY_REPLAN", false); return "RESCHEDULED";
      }
    }
    if (stalePolicy) await append(ctx, s, "W1_COMPATIBLE_ORIGINAL_STAGE_RETAINED_AFTER_INVALIDATION", {
      boundary, unitId: unit.id, selectionGroupRef: selection.selectionGroupRef, originalEpisode: q.episode_id,
      originalAcceptance: q.proposed.acceptanceDigest, policyOptimalityClaimed: false, paidCostsRetained: true,
      unknownNotCleared: true, originalEffectIdsPreserved: true, authorityGranted: false }, c);
  } else if (input.outstanding.length) throw Error("W1_CONTROL_CANNOT_CLEAR_ORIGINAL_OBLIGATIONS");
  await append(ctx, s, "W1_BOUNDARY_CURRENTNESS_CHECKED", { boundary, unitId: unit.id,
    materialDigest: nativeMaterialDigest(input), originalEpisode: q.episode_id,
    checkedFacets: Object.keys(input.dependencyState ?? {}).sort(), authorityGranted: false }, c);
  return "CURRENT";
}
/** Cancellation is the original P2 owner's decision, not a fabricated native
 * failure. Keep a STOP label even when no next physical action can be sampled. */
export async function recordEconomicCancellationTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient) {
  const prior = (await c.query("SELECT body,digest FROM finnor_os.p2_events WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND kind IN('W1_NEXT_COMPUTATION_APPLIED','W1_NATIVE_FALLBACK_APPLIED') ORDER BY created_at DESC,id DESC LIMIT 1",
    [s.tenant_id, s.principal_id, s.id])).rows[0];
  if (!s.context || !prior) {
    await persistNativeGapTx(ctx, s, c, { kind: "CANCELLATION_WITHOUT_OBSERVABLE_NATIVE_STATE", subjectRef: s.id,
      contextRef: "original-search:" + s.id, evidenceRefs: ["p2-search:" + s.id] }); return;
  }
  if (sha(prior.body) !== prior.digest) throw Error("W1_ORIGINAL_SELECTION_EVENT_DIGEST_MISMATCH");
  const { recordNativeObservationsTx } = await import("./learning");
  await recordNativeObservationsTx(ctx, s, c);
  const beforeFrame = await readNativeFrameTx(s, await units(ctx, s, c), c);
  await append(ctx, s, "W1_NATIVE_COMPUTATION_STOPPED", { workId: q.work_id, originalEpisode: q.episode_id,
    selectionGroupRef: sha({ search: s.id, disposition: "CANCELLED", generation: s.generation }),
    beforeFrame, stageAction: null, stoppedDisposition: "CANCELLED", responseContext: prior.body.responseContext,
    originalGrant: s.request.computeGrant, originalEffectIdsPreserved: true, authorityGranted: false }, c);
  await recordNativeObservationsTx(ctx, s, c);
}
/** Existing S6 identities are never rewritten. Original SQL acceptance is
 * required independently of whether an economic policy is still current. */
export async function assertEconomicDispatchBoundary(ctx: PeMutationContext, q: ProgramRow): Promise<void> {
  const s = await searchForProgram(ctx, q.id);
  if (!s || !isEconomicSearch(s.request)) return;
  await tx(ctx, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + s.tenant_id]);
    await assertProgramCurrent(ctx, q, c, true);
    const { input, invalidated } = await currentEconomicCutTx(ctx, s, q, c);
    if (input.remaining.wallMs <= 0 || nativeDeadlineAt(input) <= Date.now()) throw Error("W1_ORIGINAL_EPISODE_DEADLINE_EXHAUSTED");
    if (!input.incumbentRef || input.outstanding.length) throw Error("W1_ORIGINAL_CHECKED_INCUMBENT_AND_RECONCILIATION_REQUIRED");
    if ((await c.query("SELECT id FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status IN('INTENT','SUBMITTED','UNKNOWN') LIMIT 1",
      [s.tenant_id, s.principal_id, s.id])).rowCount) throw Error("W1_PRE_EFFECT_ORIGINAL_PHYSICAL_OBLIGATIONS_UNSETTLED");
    await append(ctx, s, "W1_BOUNDARY_CURRENTNESS_CHECKED", { boundary: "DISPATCH", originalEpisode: q.episode_id,
      invalidatedPolicyNotUsedAsAuthority: invalidated, originalOperationsDigest: sha(q.request.operations ?? []),
      originalS6IdentityPreserved: true, authorityGranted: false }, c);
  });
}
