import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import type { ProgramRow } from "../program-synthesis/store";
import { units, append, incumbentOf } from "../compute-search/store";
import { sha, stable } from "../evidence-execution/store";
import { W1_NATIVE_LIMITS, W1_NATIVE_PROTOCOL, W1_NATIVE_VERSION, type NativeConsumption, type NativeControlInput } from "./contracts";
import { economicOptions } from "./snapshot";
import { consumeNativePolicy, planNativeFallback, nativeMaterialDigest } from "./policy";
import { latestPublishedEconomicCapsuleTx } from "./capsules";
import { recordNativeObservationsTx } from "./learning";
import { currentEconomicCutTx } from "./cut";
import { nativeFrameKey, nativeStageActions } from "./continuation";
import { persistNativeGapTx } from "./gaps";
import { nativeOwnerReadFailure, invalidateNativeOwnerUnavailableTx } from "./dependencies";
import { beginNativeMeter } from "./meter";
import { observedNativeSinglePathFloor } from "./single-path-floor";

async function enqueue(s: SearchRow, q: ProgramRow, id: string, attempts: number, c: PoolClient, planRef?: string) {
  await c.query(
    `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
     VALUES($1,'run_compute_search_unit_v1',$2::jsonb,$3,'interactive',$4,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING`,
    [s.tenant_id, stable({ tenantId: s.tenant_id, principalId: s.principal_id, searchId: s.id, unitId: id,
      generation: s.generation, originalDeadlineAt: q.proposed.bounds.deadlineAt, ...(planRef ? { w1SelectionGroupRef: planRef } : {}) }),
    "p2:" + s.id + ":" + s.generation + ":" + id + ":admission:" + attempts + (planRef ? ":w1-plan:" + planRef : ""), W1_NATIVE_PROTOCOL],
  );
}
async function stopped(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, input: NativeControlInput, c: PoolClient, disposition: "ACCEPTED" | "INCOMPLETE") {
  if (!input.frame) throw Error("W1_STOP_COMPLETE_ORIGINAL_STATE_REQUIRED");
  const selectionGroupRef = sha({ search: s.id, frame: nativeFrameKey(input.frame), disposition, reason: s.reason });
  await append(ctx, s, "W1_NATIVE_COMPUTATION_STOPPED", { workId: q.work_id, selectionGroupRef,
    beforeFrame: input.frame, stageAction: null, stoppedDisposition: disposition, responseContext: responseContext(input),
    originalEpisode: q.episode_id, originalGrant: s.request.computeGrant, originalAcceptance: q.proposed.acceptanceDigest,
    originalDeadline: q.proposed.bounds.deadlineAt, reason: s.reason, originalEffectIdsPreserved: true,
    computationStopNotBusinessCompletion: true, authorityGranted: false }, c);
  await recordNativeObservationsTx(ctx, s, c);
}
/** P2 retains scheduling/admission/P1 acceptance. Meter intervals overlap native
 * root intervals and are explicitly non-additive; child/money gaps stay named. */
export async function replanEconomicOrchestrationTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient): Promise<void> {
  const finish = beginNativeMeter();
  await replanNative(ctx, s, q, c);
  await append(ctx, s, "W1_SUPERVISOR_MEASUREMENT", { meter: finish(), originalEpisode: q.episode_id,
    originalGrant: s.request.computeGrant, aggregateWithNativeIntervals: false,
    measurementTailAndChildrenUnmetered: true, authorityGranted: false }, c);
}
async function replanNative(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient): Promise<void> {
  economicOptions(s);
  const rows = await units(ctx, s, c);
  // Record censored/missing/UNKNOWN observations before any reconciliation wait.
  await recordNativeObservationsTx(ctx, s, c);
  const unknown = rows.some(unit => unit.status === "UNKNOWN") || !!(await c.query(
    "SELECT id FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status='UNKNOWN' LIMIT 1",
    [s.tenant_id, s.principal_id, s.id])).rowCount;
  if (unknown) {
    await persistNativeGapTx(ctx, s, c, { kind: "UNKNOWN_REQUIRES_ORIGINAL_OWNER_RECONCILIATION", subjectRef: s.id,
      contextRef: "original-search:" + s.id, evidenceRefs: ["p2-search:" + s.id] });
    s.status = "WAITING"; s.reason = "W1_UNKNOWN_REQUIRES_ORIGINAL_OWNER_RECONCILIATION"; return;
  }
  let cut: Awaited<ReturnType<typeof currentEconomicCutTx>>;
  try { cut = await currentEconomicCutTx(ctx, s, q, c); }
  catch (error) {
    const predicate = nativeOwnerReadFailure(error);
    if (!predicate) throw error;
    const historical = await latestPublishedEconomicCapsuleTx(ctx, s, c, { historical: true });
    await invalidateNativeOwnerUnavailableTx(s, q, historical, predicate, c);
    await persistNativeGapTx(ctx, s, c, { kind: "ORIGINAL_OWNER_CURRENTNESS_UNPASSED", subjectRef: s.id,
      contextRef: "original-search:" + s.id, evidenceRefs: ["p2-search:" + s.id], detail: predicate });
    const exhausted = /EXPIRED|EXHAUSTED/.test(predicate);
    s.status = exhausted ? "FAILED" : "WAITING"; s.reason = (exhausted ? "W1_ORIGINAL_BUDGET_EXHAUSTED:" : "W1_ORIGINAL_OWNER_WAIT:") + predicate; return;
  }
  const { input, capsule, invalidated } = cut;
  if (incumbentOf(s, rows)) {
    await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status IN('PENDING','QUEUED')", [s.tenant_id, s.principal_id, s.id]);
    if (rows.some(unit => unit.status === "RUNNING") || input.outstanding.length) {
      s.status = "RUNNING"; s.reason = "W1_INCUMBENT_RETAINED_DRAIN_ORIGINAL_PHYSICAL_OBLIGATIONS_BEFORE_P1"; return;
    }
    s.status = "STOPPED"; s.reason = "W1_ORIGINAL_P1_SQL_INCUMBENT_COMPUTATION_STOP_NOT_BUSINESS_COMPLETION";
    await stopped(ctx, s, q, input, c, "ACCEPTED"); return;
  }
  if (rows.some(unit => ["QUEUED", "RUNNING"].includes(unit.status)) || input.outstanding.length) {
    s.status = "RUNNING"; s.reason = "W1_EXISTING_PHYSICAL_WORK_NOT_REPLAYED"; return;
  }
  const controls = rows.filter(unit => String(unit.kind) === "CONTROL_W1" && unit.attempts > 0);
  const state = rows.map(unit => ({ id: unit.id, status: unit.status, prerequisites: unit.body.prerequisites }));
  let result: NativeConsumption = capsule && !invalidated && capsule.version === W1_NATIVE_VERSION ?
    consumeNativePolicy(input, capsule.proposal, state) :
    { status: "FALLBACK", reason: invalidated ? "W1_DEPENDENCY_INVALIDATED" : "W1_NATIVE_POLICY_NOT_YET_CHECKED", authorityGranted: false };
  let fallbackReason: string | null = null;
  if (result.status === "FALLBACK") {
    fallbackReason = result.reason;
    const nativeFallback = planNativeFallback(input, state);
    const affordableChains = input.catalogue.entries.filter(entry => entry.moduleIds.length === 1 &&
      entry.unitIds.some(id => rows.some(unit => unit.id === id && unit.status === "PENDING")) &&
      !entry.unitIds.some(id => rows.some(unit => unit.id === id && ["FAILED", "CANCELLED", "UNKNOWN"].includes(unit.status))))
      .map(entry => { const pending = entry.unitCosts.filter(cost => rows.some(unit => unit.id === cost.unitId && unit.status === "PENDING"));
        return { attempts: pending.length, steps: pending.reduce((sum, cost) => sum + cost.steps, 0) }; })
      .sort((a, b) => a.steps - b.steps || a.attempts - b.attempts);
    const smallest = affordableChains[0], ready = input.frame ? nativeStageActions(input, input.frame) : [];
    const support = input.frame && input.continuation?.samples.some(sample => sample.split === "TRAIN" && sample.action &&
      nativeFrameKey(sample.before) === nativeFrameKey(input.frame!) && ready.some(action => action.ref === sample.action!.ref) &&
      Object.values(sample.consumption).every(value => value !== null));
    const changed = !capsule || invalidated || capsule.proposal.materialDigest !== nativeMaterialDigest(input);
    const singlePathFloor = observedNativeSinglePathFloor(input, nativeFallback);
    if (singlePathFloor) await append(ctx, s, "W1_OBSERVED_SINGLE_PATH_FLOOR_RETAINED", {
      ...singlePathFloor, originalEpisode: q.episode_id, originalGrant: s.request.computeGrant,
      originalDeadline: q.proposed.bounds.deadlineAt, originalAcceptance: q.proposed.acceptanceDigest,
      supervisorUsageRetainedInOriginalNonAdditiveMeter: true,
    }, c);
    // An equivalent control intent (same body digest) is unique per search across
    // every status and generation. Once one exists — including one that failed
    // before admission with zero attempts — prefer the existing minimum
    // compatible EXECUTE_P1/SQL VERIFY fallback over re-inserting that identity.
    const equivalentControlExists = () => {
      if (s.context == null) return false;
      const context = z.object({ sourceResultDigest: z.string(), inputDigest: z.string() }).passthrough().parse(s.context);
      const digest = sha({ moduleId: W1_NATIVE_VERSION, prerequisites: [], mechanism: "INDEPENDENTLY_CHECKED_W1_EMPIRICAL_CONTINUATION",
        sourceDigest: context.sourceResultDigest, inputDigest: context.inputDigest, routeIds: [] });
      return rows.some(unit => String(unit.kind) === "CONTROL_W1" && unit.digest === digest);
    };
    const canControl = changed && support && !singlePathFloor && input.utility && smallest && nativeFallback.status === "DISPATCH" &&
      !equivalentControlExists() &&
      controls.length < W1_NATIVE_LIMITS.controlRuns && rows.length < s.request.limits.maxUnits &&
      input.remaining.attempts >= smallest.attempts + input.remaining.publicationAttempts + 1 &&
      input.remaining.steps >= W1_NATIVE_LIMITS.controllerSteps + smallest.steps + (input.remaining.publicationSteps ?? 1) && input.remaining.wallMs > 0;
    if (canControl) {
      const id = randomUUID(), context = z.object({ sourceResultDigest: z.string(), inputDigest: z.string() }).passthrough().parse(s.context);
      const body = { moduleId: W1_NATIVE_VERSION, prerequisites: [], mechanism: "INDEPENDENTLY_CHECKED_W1_EMPIRICAL_CONTINUATION",
        sourceDigest: context.sourceResultDigest, inputDigest: context.inputDigest, routeIds: [] };
      await c.query("INSERT INTO finnor_os.p2_units(id,tenant_id,principal_id,search_id,generation,kind,status,body,digest) VALUES($1,$2,$3,$4,$5,'CONTROL_W1','QUEUED',$6::jsonb,$7)",
        [id, s.tenant_id, s.principal_id, s.id, s.generation, stable(body), sha(body)]);
      await enqueue(s, q, id, 0, c);
      await append(ctx, s, "W1_CONTROL_QUEUED", { unitId: id, reason: fallbackReason, continuationRef: input.continuation?.ref,
        originalEpisode: q.episode_id, originalGrant: s.request.computeGrant, originalCountersNotReset: true, authorityGranted: false }, c);
      s.status = "RUNNING"; s.reason = null; return;
    }
    result = nativeFallback;
    await persistNativeGapTx(ctx, s, c, { kind: "CONDITIONAL_POLICY_UNSUPPORTED_OR_INVALIDATED", subjectRef: sha(fallbackReason),
      contextRef: input.continuation?.ref ?? "NATIVE_CONTINUATION_UNAVAILABLE", evidenceRefs: ["p2-search:" + s.id], detail: fallbackReason });
  }
  if (result.status === "WAIT") { s.status = "WAITING"; s.reason = result.reason; return; }
  if (result.status === "STOP") {
    // Never turn a checked STOP into an unmodeled computation merely to make a
    // positive result. Computation STOP remains incomplete without actual SQL.
    s.status = result.acceptedOriginalResult ? "STOPPED" : "FAILED"; s.reason = result.reason;
    await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status='PENDING'", [s.tenant_id, s.principal_id, s.id]);
    await stopped(ctx, s, q, input, c, result.acceptedOriginalResult ? "ACCEPTED" : "INCOMPLETE"); return;
  }
  if (result.status !== "DISPATCH") throw Error("W1_COMPLETE_STAGE_DISPATCH_REQUIRED");
  const computation = input.catalogue.entries.find(entry => entry.computationRef === result.computationRef);
  const action = nativeStageActions(input, result.beforeFrame).find(action => action.ref === result.actionRef);
  if (!computation || !action || stable([...action.unitIds].sort()) !== stable([...result.unitIds].sort()) ||
      result.unitIds.length > s.request.limits.maxParallel) throw Error("W1_ACTUAL_COMPLETE_READY_STAGE_REQUIRED");
  const selectionGroupRef = sha({ search: s.id, generation: s.generation, before: nativeFrameKey(result.beforeFrame),
    action: action.ref, capsule: fallbackReason ? null : capsule && sha(capsule), fallbackReason });
  for (const id of result.unitIds) {
    const unit = rows.find(row => row.id === id);
    if (!unit || unit.status !== "PENDING" || !["EXECUTE_P1", "VERIFY_P1"].includes(unit.kind) ||
        !unit.body.prerequisites.every(prerequisite => rows.some(row => row.id === prerequisite && row.status === "COMPLETED")))
      throw Error("W1_ORIGINAL_P2_PREREQUISITE_BARRIER");
    await c.query("UPDATE finnor_os.p2_units SET status='QUEUED',updated_at=clock_timestamp() WHERE id=$1 AND status='PENDING'", [id]);
    await enqueue(s, q, id, unit.attempts, c, selectionGroupRef);
    await append(ctx, s, fallbackReason ? "W1_NATIVE_FALLBACK_APPLIED" : "W1_NEXT_COMPUTATION_APPLIED", {
      unitId: id, kind: unit.kind, computationRef: result.computationRef, treatmentRef: computation.treatmentRef,
      treatmentUnitIds: result.unitIds, capsuleDigest: capsule ? sha(capsule) : null, fallbackReason,
      stateId: result.stateId, actionRef: result.actionRef, beforeFrame: result.beforeFrame, stageAction: action, selectionGroupRef,
      workId: q.work_id, originalEpisode: q.episode_id, originalGrant: s.request.computeGrant,
      originalDeadline: q.proposed.bounds.deadlineAt, originalAcceptance: q.proposed.acceptanceDigest,
      actualCallees: ["executeHarnessCandidate", "checkNumericalAcceptance"], originalEffectIdsPreserved: true,
      remaining: input.remaining, dependencyState: input.dependencyState,
      contextEdges: computation.prerequisiteEdges, verifierRefs: computation.verifierRefs,
      responseContext: responseContext(input), authorityGranted: false,
    }, c);
  }
  s.status = "RUNNING"; s.reason = null;
}
export function responseContext(input: NativeControlInput) {
  return { pins: input.pins, features: input.features, purposeRef: input.purposeRef, populationRef: input.populationRef,
    validUntil: input.contextValidUntil ?? input.binding.deadline };
}
