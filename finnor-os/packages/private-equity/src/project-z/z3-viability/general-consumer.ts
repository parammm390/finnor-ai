/** Bounded actual S4 owner driver. Only the registered non-effect operation
 * algebra is dispatched. The original Work, reservation and physical fence
 * survive every cursor write; no public string becomes a command or effect. */
import { transitionWorkTx, type Db, type WorkStatus } from "@finnor/db";
import type { PoolClient } from "pg";
import type { NonconflictingCandidate } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import type { PeMutationContext } from "../../types";
import { chargeViabilityOwnerStep, resolveViabilityNativeOrigin, type NativeOrigin } from "./native-origin";
import { assertViabilityClaimTx, assertViabilityCurrent, nativeMappingFailureTx, viabilityEvent } from "./store";
import { hash, z3Fault, type ViabilityClaim, type ViabilitySessionRow } from "./contracts";
import { generalS4Owners, readGeneralS4ObservationTx, type GeneralOwnerInvocation,
  type GeneralOwnerObservation } from "./general-owners";
import { nativeStateMatches, selectNativeEnvironmentEdge } from "./general-model";
import { advanceGeneralCursor, assertGeneralCursor, consumedOwnerObservation, initialGeneralCursor,
  type GeneralViabilityCursor } from "./general-transition";
import type { GeneralViabilityRevisionBridge } from "../../../../orchestration/src/project-z/z3-viability/general-revision";

function general(origin: NativeOrigin) {
  if (origin.model.kind !== "GENERAL" || !origin.general || !origin.resourceState) z3Fault("Z3_NATIVE_GENERAL_ORIGIN_REQUIRED");
  return { ...origin.general, resources: origin.resourceState };
}
export async function consumeGeneralViabilityTx(ctx: PeMutationContext, row: ViabilitySessionRow,
  initialOrigin: NativeOrigin, candidate: NonconflictingCandidate, claim: ViabilityClaim, c: PoolClient, db: Db) {
  if (!row.candidate_digest || !row.check_digest) z3Fault("Z3_S4_CURRENT_CHECKED_STRATEGY_REQUIRED");
  let origin = initialOrigin, current = general(origin);
  const model = current.request.model, strategy = candidate.strategy, owners = generalS4Owners();
  if (await nativeMappingFailureTx(row, c)) z3Fault("Z3_NATIVE_MAPPING_FALSIFIED_REQUIRES_ADMITTED_REVISION");
  const prior = (await c.query<{ body: { cursor: GeneralViabilityCursor; cursorDigest: string } }>(
    `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
     AND session_id=$3 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id DESC LIMIT 1`,
    [row.tenant_id, row.principal_id, row.id])).rows[0]?.body;
  const intake = (await c.query<{ body: { revisionBridge: GeneralViabilityRevisionBridge | null } }>(
    `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
     AND session_id=$3 AND kind='Z3_SESSION_INTAKE' ORDER BY id LIMIT 1`,
    [row.tenant_id, row.principal_id, row.id])).rows[0]?.body;
  const bridge = intake?.revisionBridge ?? null;
  if (!prior && bridge && (bridge.schema !== "finnor.z3.identity-revision-bridge.v2"
    || bridge.currentBindingDigest !== row.binding_digest || bridge.strategyDigest !== hash(strategy)
    || bridge.mapDigest !== model.mapDigest || bridge.ownerEvidenceDigest !== current.evidence.digest
    || hash(bridge.cursor) !== bridge.cursorDigest || bridge.cursor.pending !== null)) {
    z3Fault("Z3_GENERAL_NATIVE_SEMANTIC_REVISION_BRIDGE_REQUIRED");
  }
  const initialReads = prior || bridge ? 0 : model.original.observers.length;
  // Each edge can need a source read, a dispatch/outcome read and a target
  // read. This is a precheck of the original grant, not a larger/new grant.
  const edgeLimit = Math.min(4, Math.floor((origin.remaining.steps - initialReads) / 3));
  if (edgeLimit < 1) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
  const identity = { candidateDigest: row.candidate_digest, checkDigest: row.check_digest,
    bindingDigest: row.binding_digest, ownerEvidenceDigest: current.evidence.digest };
  let cursor: GeneralViabilityCursor;
  let before: string;
  const invocation = (): GeneralOwnerInvocation => ({ sessionId: row.id, claim, cursorDigest: cursor ? hash(cursor) : hash(identity) });
  const refresh = async () => {
    origin = await resolveViabilityNativeOrigin(ctx, row.work_id, c);
    await assertViabilityCurrent(ctx, row, c, true, origin);
    await assertViabilityClaimTx(ctx, row, claim, c);
    current = general(origin);
    if (current.evidence.digest !== identity.ownerEvidenceDigest) z3Fault("Z3_NATIVE_OWNER_BINDING_CHANGED");
  };
  const observe = async (observerId: string): Promise<GeneralOwnerObservation> => {
    await chargeViabilityOwnerStep(ctx, origin, claim, c);
    return owners.observeEnterpriseViabilityStateTx(ctx, current.request, observerId, invocation(), c);
  };
  if (prior) {
    cursor = prior.cursor;
    assertGeneralCursor(model, strategy, cursor, prior.cursorDigest, identity);
    before = prior.cursorDigest;
  } else if (bridge) {
    before = bridge.cursorDigest;
    cursor = { ...bridge.cursor, ...identity };
    assertGeneralCursor(model, strategy, cursor, hash(cursor), identity);
  } else {
    const observations: GeneralOwnerObservation[] = [];
    for (const observer of model.original.observers) observations.push(await observe(observer.id));
    await refresh();
    cursor = initialGeneralCursor(model, strategy, observations, current.resources, identity);
    before = hash(cursor);
  }
  const transitions: Array<Record<string, unknown>> = [];
  for (let count = 0; count < edgeLimit; count++) {
    await refresh();
    const stateIndex = model.arena.states.findIndex(s => s.id === cursor.stateId);
    const state = model.arena.states[stateIndex];
    if (!state) z3Fault("Z3_S4_CURRENT_STATE_UNMODELLED");
    const from = { stateId: cursor.stateId, memory: cursor.memory };
    let edgeIndex: number, observation: GeneralOwnerObservation;
    if (state.owner === "C") {
      const source = model.original.observations.find(row => row.stateId === state.id)!;
      const actual = await observe(source.predicate.observerId);
      await refresh();
      if (!nativeStateMatches(model, state.id, [actual], current.resources)) z3Fault("Z3_NATIVE_ACTUAL_SOURCE_STATE_CHANGED");
      edgeIndex = strategy.actions[cursor.memory]?.[stateIndex] ?? -1;
      await chargeViabilityOwnerStep(ctx, origin, claim, c);
      observation = await owners.dispatchEnterpriseViabilityOperationTx(ctx, current.request, edgeIndex, invocation(), c);
    } else {
      const outcome = model.original.environment.find(row => model.arena.edges[row.edgeIndex]!.from === state.id);
      if (!outcome) z3Fault("Z3_NATIVE_TOTAL_E_OUTCOME_BINDING_REQUIRED");
      observation = cursor.pending
        ? await readGeneralS4ObservationTx(ctx, current.request, cursor.pending.receiptRef, row.id, c)
        : await observe(outcome.predicate.observerId);
      if (cursor.pending && hash(observation) !== cursor.pending.observationDigest) z3Fault("Z3_NATIVE_OWNER_RECEIPT_PREIMAGE_CHANGED");
      await refresh();
      edgeIndex = selectNativeEnvironmentEdge(model, state.id, observation, current.resources);
    }
    await refresh();
    const edge = model.arena.edges[edgeIndex];
    if (!edge || edge.from !== state.id) z3Fault("Z3_S4_UNMODELLED_ORIGINAL_EDGE");
    const target = model.original.observations.find(row => row.stateId === edge.to)!;
    let targetObservation = consumedOwnerObservation(model, edgeIndex, observation);
    if (target.predicate.observerId !== targetObservation.observerId
      || !nativeStateMatches(model, edge.to, [targetObservation], current.resources)) {
      // Different owner projection, not a guessed successor or a predicted
      // application state. The original observed E outcome is never replaced.
      targetObservation = await observe(target.predicate.observerId);
      await refresh();
    }
    const next = advanceGeneralCursor(model, strategy, cursor, edgeIndex, targetObservation, current.resources,
      current.evidence.settlements);
    const targetState = model.arena.states.find(s => s.id === edge.to)!;
    cursor = { ...next, pending: state.owner === "C" && targetState.owner === "E"
      ? { receiptRef: observation.receiptRef, observationDigest: hash(observation) } : null };
    transitions.push({ from, edgeIndex, action: edge.action, ownerReceiptRef: observation.receiptRef,
      outcomeDigest: hash(observation), targetReceiptRef: targetObservation.receiptRef,
      targetObservationDigest: hash(targetObservation), targetObservationQualification: targetObservation.qualification,
      resourceObservationDigest: hash(current.resources), to: { stateId: cursor.stateId, memory: cursor.memory } });
  }
  const work = (await c.query<{ status: WorkStatus }>(
    "SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.work_id])).rows[0];
  if (!work || ["cancelled", "failed", "completed"].includes(work.status)) z3Fault("Z3_ORIGINAL_WORK_NOT_CURRENT");
  const body = { schema: "finnor.z3.s4-native-prefix.v2", owner: "S4", sessionId: row.id, workId: row.work_id,
    workInputId: row.work_input_id, originalParentId: row.original_parent_id, reservationRef: row.reservation_ref,
    deadlineAt: origin.binding.deadlineAt, previousCursorDigest: before, cursor, cursorDigest: hash(cursor), transitions,
    mappingDigest: model.mapDigest, ownerBindingDigest: current.evidence.digest,
    deliveryAttemptId: claim.physical.deliveryAttemptId, jobClaimFence: claim.physical.claimFence, claimFence: claim.sessionFence,
    conditionality: "FINITE_ACTUAL_OWNER_PREFIX_ORIGINAL_GF_ASSUMPTIONS_NOT_FAIRNESS_OR_EFFECT_AUTHORITY",
    unknownClearedWithoutS6: false, protectedReceipt: null, executionAuthorityGranted: false };
  await transitionWorkTx(db, row.tenant_id, row.work_id, work.status, "viability_native_prefix_observed", body,
    { expectedStatus: work.status, expectedWorkInputId: row.work_input_id });
  await viabilityEvent(ctx, row, "Z3_S4_NATIVE_PREFIX", body, c);
  await refresh();
  return { consumed: true as const, cursor, cursorDigest: hash(cursor), transitions: transitions.length,
    originalWorkObservation: "viability_native_prefix_observed", executionAuthorityGranted: false as const };
}
