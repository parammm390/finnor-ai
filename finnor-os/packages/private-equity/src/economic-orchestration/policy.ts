import { createHash } from "node:crypto";
import { canonicalJson, epistemicHash } from "../../../epistemic-runtime/src/source-precedence";
import { r2Quantity } from "../../../epistemic-runtime/src/r2-rational";
import { controlMeter } from "../../../epistemic-runtime/src/certified-state-reduction/exact";
import { compileMetalevelPolicy } from "../../../epistemic-runtime/src/metalevel-policy/producer";
import { checkMetalevelPolicy } from "../../../epistemic-runtime/src/metalevel-policy/checker";
import { parseMetalevelModel } from "../../../epistemic-runtime/src/metalevel-policy/contracts";
import { nativeControlInputSchema, nativeProposalSchema, nativeUnitSchema, nativeDeadlineAt, W1_NATIVE_LIMITS,
  type NativeControlInput, type NativeProposal, type NativeConsumption, type NativeComputation, type NativeUnitState } from "./contracts";
import { buildNativeContinuationModel, nativeFrameKey, nativeStageActions, nativeActionRef } from "./continuation";

export function nativeMaterialDigest(input: NativeControlInput): string {
  return epistemicHash({ searchId: input.searchId, programId: input.programId, episodeId: input.episodeId,
    workInputId: input.workInputId, workInputDigest: input.workInputDigest, generation: input.generation,
    purposeRef: input.purposeRef, populationRef: input.populationRef, binding: input.binding,
    features: input.features, pins: input.pins,
    catalogue: { ref: input.catalogue.ref, entries: input.catalogue.entries.map(({ available: _currentAvailability, ...entry }) => entry) },
    dependencyState: input.dependencyState, utility: input.utility });
}
const fallback = (input: NativeControlInput, reason: string): NativeProposal => ({
  schema: "finnor.w1.native-policy-proposal.v1", status: "FALLBACK_REQUIRED", reason,
  inputDigest: epistemicHash(input), materialDigest: nativeMaterialDigest(input), authorityGranted: false, protectedAdmission: false,
});
const affordable = (input: NativeControlInput, entry: NativeComputation) =>
  entry.attempts + input.remaining.publicationAttempts <= input.remaining.attempts &&
  entry.steps + (input.remaining.publicationSteps ?? 1) <= input.remaining.steps && input.remaining.wallMs > 0;

export function compileNativePolicy(raw: unknown): NativeProposal {
  const input = nativeControlInputSchema.parse(raw);
  if (input.outstanding.length) return fallback(input, "W1_UNRESOLVED_ORIGINAL_OBLIGATION");
  if (!input.utility) return fallback(input, "W1_CURRENT_S4_UTILITY_CONVERSION_REQUIRED");
  if (!input.continuation || !input.frame) return fallback(input, "W1_NATIVE_CONDITIONAL_RESPONSE_REQUIRED");
  if (input.remaining.wallMs <= 0 || Date.parse(input.now) >= nativeDeadlineAt(input))
    return fallback(input, "W1_ORIGINAL_DEADLINE_EXHAUSTED");
  try {
    const fitted = buildNativeContinuationModel(input), modelBytes = canonicalJson(fitted.model);
    const producerAccount = { steps: 0 }, checkerAccount = { steps: 0 };
    const deadlineAt = Math.min(nativeDeadlineAt(input), Date.now() + 1000);
    const policy = compileMetalevelPolicy(modelBytes, { deadlineAt, maxSteps: W1_NATIVE_LIMITS.kernelSteps, account: producerAccount });
    const check = checkMetalevelPolicy(modelBytes, policy, { deadlineAt, maxSteps: W1_NATIVE_LIMITS.kernelSteps, account: checkerAccount });
    if (check.status !== "VALID") return fallback(input, "W1_INDEPENDENT_POLICY_CHECK_FAILED");
    const selected = policy.states[policy.rootStateId]?.selectedChoiceId;
    if (!selected || !fitted.actions[selected] && fitted.unidentified.some(row => row.stateId === policy.rootStateId))
      return fallback(input, "W1_STOP_UNQUALIFIED_WITH_MISSING_CONDITIONAL_SUPPORT");
    return nativeProposalSchema.parse({
      schema: "finnor.w1.native-policy-proposal.v1", status: "CHECKED_POLICY", inputDigest: epistemicHash(input),
      materialDigest: nativeMaterialDigest(input), modelBytes, policy, check, responseRef: input.continuation.ref,
      continuation: { modelRef: input.continuation.ref, frames: fitted.frames, actions: fitted.actions, horizonUsed: fitted.horizonUsed,
        unidentified: fitted.unidentified, kernelUsage: { producerSteps: producerAccount.steps, checkerSteps: checkerAccount.steps, limitPerCall: W1_NATIVE_LIMITS.kernelSteps } },
      limitations: ["EMPIRICAL_FULL_HISTORY_CONDITIONAL_MODEL_NOT_CAUSAL_OR_FIELD_QUALIFIED",
        "JOINT_OBSERVATIONS_NOT_FACTORIZED_NO_EFFORT_MONOTONICITY",
        "MISSING_CONDITIONAL_SUPPORT_REFUSES_OR_USES_ORIGINAL_CHECKED_FALLBACK",
        "ZERO_MASS_INVALID_GUARD_IS_STRUCTURAL_NOT_A_MEASUREMENT",
        "PREDICTED_ACCEPTANCE_IS_NOT_ACTUAL_P1_OR_BUSINESS_COMPLETION",
        "PINNED_IMMUTABLE_FIT_REMAINS_VALID_UNTIL_DEPENDENCY_CHANGE_OR_EXPIRY_NOT_HEAD_REPLACEMENT",
        "CURRENT_CONTROLLER_SUNK_ORIGINAL_DEBIT_RETAINED_NO_FREE_FUTURE_CONTROL",
        "UNKNOWN_CHILD_MONETARY_AND_SUPERVISORY_USAGE_PERSIST_AS_NAMED_GAPS"],
      authorityGranted: false, protectedAdmission: false,
    });
  } catch (error) {
    return fallback(input, error instanceof Error && /^W1_[A-Z0-9_]+$/.test(error.message) ? error.message : "W1_EXACT_KERNEL_BOUND_OR_CHECK_UNPASSED");
  }
}
/** S8 reconstructs the empirical model from the original capsule input; a valid
 * Bellman policy for a producer-invented transition table is not sufficient. */
export function verifyNativeContinuationFit(input: NativeControlInput, proposal: NativeProposal): boolean {
  if (proposal.status !== "CHECKED_POLICY" || !proposal.continuation) return false;
  try {
    const fitted = buildNativeContinuationModel(input);
    return canonicalJson(fitted.model) === proposal.modelBytes &&
      canonicalJson(fitted.frames) === canonicalJson(proposal.continuation.frames) &&
      canonicalJson(fitted.actions) === canonicalJson(proposal.continuation.actions);
  } catch { return false; }
}
const zUnits = (input: unknown) => nativeUnitSchema.array().parse(input);
export function consumeNativePolicy(raw: unknown, proposalInput: unknown, unitInput: unknown): NativeConsumption {
  const input = nativeControlInputSchema.parse(raw), proposal = nativeProposalSchema.parse(proposalInput), units = zUnits(unitInput);
  if (input.outstanding.length || units.some(unit => unit.status === "UNKNOWN") || input.frame?.obligations.some(o => o.status !== "RESOLVED"))
    return { status: "WAIT", reason: "W1_UNKNOWN_REQUIRES_ORIGINAL_OWNER_RECONCILIATION", authorityGranted: false };
  if (input.incumbentRef) return { status: "STOP", reason: "ORIGINAL_INDEPENDENT_P1_INCUMBENT_AVAILABLE", acceptedOriginalResult: true, authorityGranted: false };
  if (nativeMaterialDigest(input) !== proposal.materialDigest) return { status: "FALLBACK", reason: "W1_MATERIAL_PIN_DRIFT", authorityGranted: false };
  if (proposal.status !== "CHECKED_POLICY") return { status: "FALLBACK", reason: proposal.reason, authorityGranted: false };
  const meta = proposal.continuation;
  if (!meta || !input.frame || !input.continuation || meta.modelRef !== input.continuation.ref)
    return { status: "FALLBACK", reason: "W1_LEGACY_OR_UNBOUND_CONDITIONAL_POLICY", authorityGranted: false };
  try {
    const budget = { deadlineAt: Math.min(nativeDeadlineAt(input), Date.now() + 1000),
      maxSteps: W1_NATIVE_LIMITS.kernelSteps, account: { steps: 0 } };
    const check = checkMetalevelPolicy(proposal.modelBytes, proposal.policy, budget);
    if (check.status !== "VALID" || createHash("sha256").update(proposal.modelBytes).digest("hex") !== proposal.check.modelSha256)
      throw Error("W1_CONSUMER_INDEPENDENT_CHECK_FAILED");
    const model = parseMetalevelModel(proposal.modelBytes, budget);
    const rootRemaining = model.states.find(state => state.id === model.rootStateId)!.remaining;
    if (model.id !== "native-model:" + epistemicHash({ response: meta.modelRef, frames: meta.frames, actions: meta.actions, rootResources: rootRemaining }))
      throw Error("W1_CONDITIONAL_STATE_BINDING_MISMATCH");
    const resources: Record<string, ReturnType<typeof r2Quantity>> = {
      "native-attempt": r2Quantity(String(Math.max(0, input.remaining.attempts - input.remaining.publicationAttempts))),
      "logical-step": r2Quantity(String(Math.max(0, input.remaining.steps - (input.remaining.publicationSteps ?? 1)))),
      "wall-ms": r2Quantity(String(Math.max(0, Math.floor(input.remaining.wallMs)))),
    };
    const sameFrame = model.states.filter(state => meta.frames[state.id] && nativeFrameKey(meta.frames[state.id]!) === nativeFrameKey(input.frame!));
    const exact = sameFrame.filter(state => Object.entries(resources).every(([dimension, value]) =>
      value.compare(r2Quantity(state.remaining[dimension]!)) === 0));
    // Equal semantic outcomes can retain distinct joint resource branches.
    // Never average them or choose the first. A uniquely identified state may
    // also survive attenuation, but its complete checked continuation must fit.
    const matches = exact.length ? exact : sameFrame.filter(state => Object.entries(resources).every(([dimension, value]) =>
      value.compare(r2Quantity(state.remaining[dimension]!)) <= 0));
    if (matches.length !== 1) throw Error("W1_OBSERVED_STATE_NOT_UNIQUELY_IN_EMPIRICAL_SUPPORT");
    const state = matches[0]!, choice = state.choices.find(row => row.id === proposal.policy.states[state.id]?.selectedChoiceId);
    if (!choice) throw Error("W1_CONDITIONAL_CHOICE_UNAVAILABLE");
    if (choice.kind === "STOP") {
      if (meta.unidentified.some(row => row.stateId === state.id)) throw Error("W1_STOP_UNQUALIFIED_WITH_MISSING_CONDITIONAL_SUPPORT");
      return { status: "STOP", reason: "W1_CHECKED_COMPUTATION_STOP_ORIGINAL_OUTCOME_INCOMPLETE",
        acceptedOriginalResult: false, authorityGranted: false };
    }
    const actual = nativeStageActions(input, input.frame).find(action => action.ref === choice.computationRef);
    if (!actual || actual.unitIds.some(id => !units.some(unit => unit.id === id && unit.status === "PENDING" &&
        unit.prerequisites.every(prerequisite => units.some(parent => parent.id === prerequisite && parent.status === "COMPLETED")))))
      throw Error("W1_CURRENT_READY_SET_OR_CHECK_BARRIER_UNPASSED");
    const states = new Map(model.states.map(row => [row.id, row])), meter = controlMeter(budget);
    // Recheck feasibility of the existing policy, not an uncharged recompile.
    // Preserve every joint cost/outcome branch under the same finite consumer
    // meter; an affordable immediate action alone is not a feasible chain.
    const requireContinuation = (id: string, remaining: typeof resources): void => {
      meter.step();
      const current = states.get(id), selected = current?.choices.find(row =>
        row.id === proposal.policy.states[id]?.selectedChoiceId);
      if (!selected) throw Error("W1_CONDITIONAL_CHOICE_UNAVAILABLE");
      if (selected.kind === "STOP") return;
      if (Object.entries(remaining).some(([dimension, value]) =>
        r2Quantity(selected.reservation[dimension]!).compare(value) > 0))
        throw Error("W1_ORIGINAL_REMAINING_CONTINUATION_RESOURCES_UNPASSED");
      for (const outcome of selected.outcomes) {
        meter.step();
        const next = Object.fromEntries(Object.entries(remaining).map(([dimension, value]) =>
          [dimension, value.sub(r2Quantity(outcome.consumption[dimension]!))]));
        requireContinuation(outcome.nextStateId, next);
      }
    };
    requireContinuation(state.id, resources);
    return { status: "DISPATCH", computationRef: actual.computationRef, actionRef: actual.ref, stateId: state.id,
      unitIds: actual.unitIds, beforeFrame: input.frame, authorityGranted: false };
  } catch (error) {
    return { status: "FALLBACK", reason: error instanceof Error && /^W1_[A-Z0-9_]+$/.test(error.message) ? error.message : "W1_CONSUMER_CHECK_OR_BOUND_UNPASSED", authorityGranted: false };
  }
}
function readyFor(entry: NativeComputation, units: NativeUnitState[]): string[] {
  return entry.unitIds.filter(id => {
    const unit = units.find(row => row.id === id);
    return unit?.status === "PENDING" && unit.prerequisites.every(prerequisite => units.some(row => row.id === prerequisite && row.status === "COMPLETED"));
  }).slice(0, 1);
}
function remainingEntry(entry: NativeComputation, units: NativeUnitState[]): NativeComputation {
  const pending = entry.unitCosts.filter(cost => units.some(unit => unit.id === cost.unitId && unit.status === "PENDING"));
  return { ...entry, attempts: pending.length, steps: pending.reduce((total, cost) => total + cost.steps, 0) };
}
export function planNativeFallback(raw: unknown, unitInput: unknown): NativeConsumption {
  const input = nativeControlInputSchema.parse(raw), units = zUnits(unitInput);
  if (input.outstanding.length || units.some(unit => unit.status === "UNKNOWN") || input.frame?.obligations.some(o => o.status !== "RESOLVED"))
    return { status: "WAIT", reason: "W1_UNKNOWN_REQUIRES_ORIGINAL_OWNER_RECONCILIATION", authorityGranted: false };
  if (input.incumbentRef) return { status: "STOP", reason: "CURRENT_CHECKED_NATIVE_INCUMBENT_RETAINED", acceptedOriginalResult: true, authorityGranted: false };
  const frame = input.frame;
  if (!frame) return { status: "FALLBACK", reason: "W1_NATIVE_FRAME_REQUIRED_FOR_FALLBACK", authorityGranted: false };
  if (units.some(unit => ["QUEUED", "RUNNING"].includes(unit.status)))
    return { status: "WAIT", reason: "W1_EXISTING_PHYSICAL_WORK_NOT_REPLAYED", authorityGranted: false };
  const entries = input.catalogue.entries.filter(entry => entry.available && entry.moduleIds.length === 1 &&
    !entry.unitIds.some(id => units.some(unit => unit.id === id && ["FAILED", "CANCELLED"].includes(unit.status))) &&
    affordable(input, remainingEntry(entry, units))).sort((a, b) => a.steps - b.steps || a.computationRef.localeCompare(b.computationRef));
  for (const entry of entries) {
    const unitIds = readyFor(entry, units);
    if (unitIds.length) {
      const keys = frame.units.filter(unit => unitIds.includes(unit.unitId)).map(unit => unit.key);
      const action = nativeStageActions(input, frame).find(row => row.ref === nativeActionRef(keys));
      if (keys.length !== unitIds.length || !action)
        return { status: "FALLBACK", reason: "W1_NATIVE_FALLBACK_COMPLETE_STAGE_UNAVAILABLE", authorityGranted: false };
      return { status: "DISPATCH", computationRef: entry.computationRef, unitIds, beforeFrame: frame,
        stateId: null, actionRef: action.ref, authorityGranted: false };
    }
  }
  return { status: "STOP", reason: "W1_NO_COMPATIBLE_NATIVE_FALLBACK_WITH_ORIGINAL_REMAINING_RESOURCES", acceptedOriginalResult: false, authorityGranted: false };
}
