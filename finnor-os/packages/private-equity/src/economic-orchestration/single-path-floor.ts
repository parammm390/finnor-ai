import { canonicalJson } from "../../../epistemic-runtime/src/source-precedence";
import { r2Quantity } from "../../../epistemic-runtime/src/r2-rational";
import type { NativeConsumption, NativeControlInput } from "./contracts";
import { fitNativeContinuation, nativeFrameKey, nativeStageActions } from "./continuation";
import { NATIVE_CONTINUATION_LIMITS } from "./continuation-contracts";

/** A narrow supplied-empirical-objective floor, not statistical certainty or a
 * replacement policy compiler. Supervisor CPU remains in the original meter. */
export function observedNativeSinglePathFloor(input: NativeControlInput, fallback: NativeConsumption) {
  const original = input.frame, fitted = input.continuation, utility = input.utility;
  if (!original || !fitted || !utility || fallback.status !== "DISPATCH" ||
      input.remaining.maxParallel !== 1 || original.history.length > 1 || input.outstanding.length ||
      original.disposition !== "ACTIVE" || original.acceptanceRef ||
      original.obligations.some(row => row.status !== "RESOLVED") ||
      input.pins.modelRef !== "P1_REGISTERED_EXACT_NATIVE_NO_MODEL" ||
      fitted.samples.length > NATIVE_CONTINUATION_LIMITS.samples ||
      canonicalJson(fitted.context.pins) !== canonicalJson(input.pins) ||
      canonicalJson(fitted.context.features) !== canonicalJson(input.features) ||
      fitted.context.tenantId !== input.binding.tenantId || fitted.context.principalId !== input.binding.principalId ||
      fitted.context.purposeRef !== input.purposeRef || fitted.context.populationRef !== input.populationRef ||
      fitted.context.sourceClass !== "CONTROLLED_NATIVE" ||
      Date.parse(fitted.knowledgeAt) > Date.parse(input.now) ||
      Date.parse(fitted.context.validUntil) <= Date.parse(input.now) ||
      r2Quantity(utility.delayMsCost).n !== 0n || r2Quantity(utility.nativeAttemptCost).n <= 0n ||
      r2Quantity(utility.lossGap).compare(r2Quantity(utility.nativeAttemptCost).mul(r2Quantity("2"))) <= 0)
    return null;
  try {
    const reconstructed = fitNativeContinuation(fitted.samples, fitted.context, fitted.previousRef, fitted.knowledgeAt);
    if (reconstructed.ref !== fitted.ref) return null;
  } catch { return null; }
  const completedStages = original.history.length, requiredCalls = 2 - completedStages;
  const selected = input.catalogue.entries.find(entry => entry.computationRef === fallback.computationRef);
  if (!selected?.available || selected.moduleIds.length !== 1 || selected.unitIds.length !== 2 ||
      selected.attempts !== 2 || input.remaining.attempts < requiredCalls + input.remaining.publicationAttempts ||
      input.catalogue.entries.some(entry => entry.available && entry.attempts < 2)) return null;
  const selectedUnits = original.units.filter(unit => selected.unitIds.includes(unit.unitId));
  if (selectedUnits.length !== 2 ||
      selectedUnits.some(unit => unit.status !== (completedStages && unit.kind === "EXECUTE_P1" ? "COMPLETED" : "PENDING")) ||
      selectedUnits.filter(unit => unit.kind === "EXECUTE_P1").length !== 1 ||
      selectedUnits.filter(unit => unit.kind === "VERIFY_P1").length !== 1) return null;
  const execute = selectedUnits.find(unit => unit.kind === "EXECUTE_P1")!;
  const verify = selectedUnits.find(unit => unit.kind === "VERIFY_P1")!;
  if (execute.prerequisites.length || canonicalJson(verify.prerequisites) !== canonicalJson([execute.key]))
    return null;
  const remainingSteps = selectedUnits.filter(unit => unit.status === "PENDING").reduce((sum, unit) => sum + unit.steps, 0);
  if (input.remaining.steps < remainingSteps + (input.remaining.publicationSteps ?? 1)) return null;
  const currentIds = new Map(original.units.map(unit => [unit.key, unit.unitId]));
  // Even at the one-call remainder, reconstruct and validate the completed
  // execute against its original root and fitted actual conditional history.
  // Its already-paid consumption is not counted as future consumption again.
  let frame = completedStages ? { ...original, history: [], units: original.units.map(unit =>
    unit.unitId === execute.unitId ? { ...unit, status: "PENDING" as const, observationRef: null } : unit),
  } : original;
  let attempts = 0, steps = 0, wall = r2Quantity("0");
  const evidence = new Set<string>();
  for (let stage = 0; stage < 2; stage++) {
    const actions = nativeStageActions(input, frame).filter(action =>
      action.computationRef === selected.computationRef && action.unitIds.length === 1 &&
      action.unitIds.every(id => selected.unitIds.includes(id)));
    if (actions.length !== 1) return null;
    const action = actions[0]!;
    if (stage === completedStages && action.ref !== fallback.actionRef) return null;
    const key = nativeFrameKey(frame), rows = fitted.samples.filter(sample =>
      sample.action?.ref === action.ref && nativeFrameKey(sample.before) === key);
    const semanticAction = ({ unitIds: _localIds, ...rest }: typeof action) => rest;
    if (!rows.length || rows.some(sample => sample.split !== "TRAIN" || !sample.action ||
        canonicalJson(semanticAction(sample.action)) !== canonicalJson(semanticAction(action)))) return null;
    const nextKeys = new Set(rows.map(sample => nativeFrameKey(sample.after)));
    if (nextKeys.size !== 1 || rows.some(sample =>
      sample.consumption.attempts !== 1 || sample.consumption.steps !== action.steps ||
      sample.consumption.wallMs === null || sample.after.obligations.some(row => row.status !== "RESOLVED") ||
      !["ACTIVE", "ACCEPTED"].includes(sample.after.disposition) ||
      canonicalJson(sample.after.requiredChecks) !== canonicalJson(frame.requiredChecks) ||
      canonicalJson(sample.after.obligations) !== canonicalJson(frame.obligations) ||
      sample.after.units.length !== frame.units.length ||
      sample.after.units.some(after => {
        const before = frame.units.find(unit => unit.key === after.key);
        if (!before) return true;
        const { unitId: _beforeId, ...beforeBody } = before;
        const { unitId: _afterId, ...afterBody } = after;
        if (!action.unitKeys.includes(after.key)) return canonicalJson(beforeBody) !== canonicalJson(afterBody);
        return before.status !== "PENDING" || after.status !== "COMPLETED" || !after.observationRef ||
          canonicalJson({ ...beforeBody, status: after.status, observationRef: after.observationRef }) !== canonicalJson(afterBody);
      }))) return null;
    for (const sample of rows) evidence.add(sample.id);
    const largestWall = rows.reduce((largest, sample) => {
      const observed = r2Quantity(sample.consumption.wallMs!);
      return observed.compare(largest) > 0 ? observed : largest;
    }, r2Quantity("0"));
    if (stage >= completedStages) {
      attempts++;
      steps += action.steps;
      wall = wall.add(largestWall);
    }
    const observed = rows[0]!.after;
    frame = { ...observed, units: observed.units.map(unit => ({
      ...unit, unitId: currentIds.get(unit.key) ?? unit.unitId,
    })) };
    if (stage === 0 && (frame.disposition !== "ACTIVE" || frame.acceptanceRef ||
        frame.completedChecks.length !== original.completedChecks.length)) return null;
    if (stage === 0 && completedStages && nativeFrameKey(frame) !== nativeFrameKey(original)) return null;
  }
  if (attempts !== requiredCalls || steps !== remainingSteps ||
      wall.compare(r2Quantity(String(Math.max(0, Math.floor(input.remaining.wallMs))))) > 0 ||
      frame.disposition !== "ACCEPTED" || !frame.acceptanceRef ||
      frame.requiredChecks.some(check => !frame.completedChecks.includes(check))) return null;
  return {
    schema: "finnor.w1.observed-native-single-path-floor.v1",
    computationRef: selected.computationRef, originalMaxParallel: 1, nativeCallFloor: 2,
    originalCompletedStages: completedStages, remainingNativeCalls: requiredCalls,
    observedStageRefs: [...evidence].sort(), responseRef: fitted.ref,
    lowerBoundBasis: "CURRENT_TWO_NATIVE_CALL_ORIGINAL_EXECUTE_AND_INDEPENDENT_CHECK_CATALOGUE",
    objectiveScope: "SUPPLIED_EMPIRICAL_ACCEPTANCE_CEILING_ZERO_DELAY_PRICE_POSITIVE_NATIVE_CALL_PRICE",
    probabilityOrFutureAcceptanceCertified: false, supervisorCostIsZero: false,
    economicsQualified: false, authorityGranted: false,
  };
}
