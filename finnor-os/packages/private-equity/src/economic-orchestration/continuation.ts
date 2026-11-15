import { epistemicHash, canonicalJson } from "../../../epistemic-runtime/src/source-precedence";
import { r2Quantity, r2String } from "../../../epistemic-runtime/src/r2-rational";
import { METALEVEL_LIMITS, type MetalevelModel, type MetalevelState } from "../../../epistemic-runtime/src/metalevel-policy/contracts";
import type { NativeControlInput } from "./contracts";
import { nativeContinuationSchema, nativeContinuationContextSchema, nativeStageObservationSchema, nativeFrameSchema,
  NATIVE_CONTINUATION_VERSION, NATIVE_CONTINUATION_LIMITS,
  type NativeFrame, type NativeStageAction, type NativeStageObservation, type NativeContinuationContext, type NativeContinuation } from "./continuation-contracts";

/** Delivery IDs remain in evidence, not exchangeable statistical state. No modeled
 * unit, output/check observation, history, obligation or disposition is dropped. */
export function nativeFrameKey(frame: NativeFrame): string {
  return epistemicHash({ ...frame, units: frame.units.map(({ unitId: _deliveryLocalId, ...unit }) => unit).sort((a, b) => a.key.localeCompare(b.key)),
    requiredChecks: [...frame.requiredChecks].sort(), completedChecks: [...frame.completedChecks].sort() });
}
export const nativeActionRef = (keys: string[]) => "native-stage:" + epistemicHash([...keys].sort());
export function fitNativeContinuation(raw: unknown[], contextRaw: unknown, previousRef: string | null, knowledgeAt: string): NativeContinuation {
  const context = nativeContinuationContextSchema.parse(contextRaw), samples = raw.map(sample => nativeStageObservationSchema.parse(sample));
  const cut = nativeContinuationSchema.shape.knowledgeAt.parse(knowledgeAt);
  if (Date.parse(cut) > Date.parse(context.validUntil)) throw Error("W1_CONTINUATION_KNOWLEDGE_CUT_AFTER_VALIDITY");
  if (samples.length > NATIVE_CONTINUATION_LIMITS.samples) throw Error("W1_CONTINUATION_RETENTION_BOUND");
  const identities = new Map<string, string>(), assignments = new Set<string>(), splits = new Map<string, string>();
  const workSplits = new Map<string, string>(), episodeSplits = new Map<string, string>();
  for (const sample of samples) {
    const digest = epistemicHash(sample);
    if (identities.has(sample.id) || assignments.has(sample.assignmentRef)) throw Error("W1_DUPLICATE_OR_CONFLICTING_STAGE_OBSERVATION");
    identities.set(sample.id, digest); assignments.add(sample.assignmentRef);
    if (workSplits.has(sample.workId) && workSplits.get(sample.workId) !== sample.split) throw Error("W1_ORIGINAL_WORK_SPLIT_LEAKAGE");
    if (episodeSplits.has(sample.episodeRef) && episodeSplits.get(sample.episodeRef) !== sample.split) throw Error("W1_ORIGINAL_EPISODE_SPLIT_LEAKAGE");
    workSplits.set(sample.workId, sample.split); episodeSplits.set(sample.episodeRef, sample.split);
    if (splits.has(sample.premiseRef) && splits.get(sample.premiseRef) !== sample.split) throw Error("W1_COMMON_PREMISE_SPLIT_LEAKAGE");
    splits.set(sample.premiseRef, sample.split);
    if (Date.parse(sample.observedAt) > Date.parse(context.validUntil)) throw Error("W1_CONTINUATION_OBSERVATION_AFTER_VALIDITY");
    if (Date.parse(sample.observedAt) > Date.parse(cut)) throw Error("W1_CONTINUATION_OBSERVATION_AFTER_KNOWLEDGE_CUT");
    if (sample.action && (sample.action.ref !== nativeActionRef(sample.action.unitKeys) ||
      canonicalJson(sample.after.history) !== canonicalJson([...sample.before.history, { actionRef: sample.action.ref, observation: sample.observation }])))
      throw Error("W1_ORIGINAL_STAGE_HISTORY_OR_ACTION_MISMATCH");
  }
  const body = { schema: "finnor.w1.native-continuation-response.v1" as const, version: NATIVE_CONTINUATION_VERSION,
    context, samples, previousRef, knowledgeAt: cut, assignmentDesign: "LOGGED_CONDITIONAL_COMMON_PREMISE_GROUPED_NOT_CAUSAL" as const };
  if (Buffer.byteLength(canonicalJson(body)) > NATIVE_CONTINUATION_LIMITS.bytes) throw Error("W1_CONTINUATION_RETENTION_BOUND");
  return nativeContinuationSchema.parse({ ...body, ref: "native-continuation:" + epistemicHash(body) });
}
export function nativeStageActions(input: NativeControlInput, frame: NativeFrame): NativeStageAction[] {
  const actions = new Map<string, NativeStageAction>();
  for (const entry of input.catalogue.entries) {
    if (!entry.available) continue;
    const ready = frame.units.filter(unit => entry.unitIds.includes(unit.unitId) && unit.status === "PENDING" &&
      unit.prerequisites.every(key => frame.units.some(parent => parent.key === key && parent.status === "COMPLETED")));
    if (!ready.length || ready.length > input.remaining.maxParallel) continue;
    const unitKeys = ready.map(unit => unit.key).sort(), ref = nativeActionRef(unitKeys);
    if (actions.has(ref)) continue;
    actions.set(ref, { ref, unitKeys, unitIds: unitKeys.map(key => ready.find(unit => unit.key === key)!.unitId),
      computationRef: entry.computationRef, contextRefs: entry.contextRefs, verifierRefs: entry.verifierRefs,
      attempts: ready.length, steps: ready.reduce((total, unit) => total + unit.steps, 0) });
  }
  return [...actions.values()].sort((a, b) => a.steps - b.steps || a.ref.localeCompare(b.ref));
}
const exact = (n: number) => r2Quantity(String(n));
function conditional(samples: NativeStageObservation[], frame: NativeFrame, action: NativeStageAction) {
  const matched = samples.filter(sample => sample.split === "TRAIN" && sample.action?.ref === action.ref && nativeFrameKey(sample.before) === nativeFrameKey(frame));
  if (!matched.length || matched.some(sample => Object.values(sample.consumption).some(value => value === null))) return null;
  const premises = new Map<string, NativeStageObservation[]>();
  for (const sample of matched) premises.set(sample.premiseRef, [...(premises.get(sample.premiseRef) ?? []), sample]);
  const outcomes = new Map<string, { frame: NativeFrame; probability: ReturnType<typeof r2Quantity>;
    attempts: ReturnType<typeof r2Quantity>; steps: ReturnType<typeof r2Quantity>; wall: ReturnType<typeof r2Quantity>; evidence: string[] }>();
  for (const rows of premises.values()) for (const sample of rows) {
    // Preserve the joint resource/outcome distribution. Averaging wall/attempt
    // costs across equal semantic results would invent a resource transition
    // and change nonlinear remaining-budget feasibility.
    const key = epistemicHash({ frame: nativeFrameKey(sample.after), consumption: sample.consumption }),
      weight = r2Quantity("1").div(exact(premises.size * rows.length));
    const old = outcomes.get(key) ?? { frame: sample.after, probability: exact(0), attempts: exact(0), steps: exact(0), wall: exact(0), evidence: [] };
    old.probability = old.probability.add(weight);
    old.attempts = old.attempts.add(weight.mul(exact(sample.consumption.attempts!)));
    old.steps = old.steps.add(weight.mul(exact(sample.consumption.steps!)));
    old.wall = old.wall.add(weight.mul(r2Quantity(sample.consumption.wallMs!)));
    old.evidence.push(sample.id); outcomes.set(key, old);
  }
  return [...outcomes.values()].map(row => ({ ...row, attempts: row.attempts.div(row.probability),
    steps: row.steps.div(row.probability), wall: row.wall.div(row.probability) }));
}
export interface NativeContinuationModel {
  model: MetalevelModel; frames: Record<string, NativeFrame>; actions: Record<string, NativeStageAction>;
  horizonUsed: number; unidentified: Array<{ stateId: string; actionRef: string; reason: string }>;
}
/** Unfold the empirical full-history conditional graph; never factor joint
 * observations, merge paths, assume effort monotonicity or prune to fit bounds. */
export function buildNativeContinuationModel(input: NativeControlInput): NativeContinuationModel {
  if (!input.frame || !input.continuation || !input.utility) throw Error("W1_NATIVE_CONDITIONAL_RESPONSE_REQUIRED");
  const fitted = nativeContinuationSchema.parse(input.continuation);
  const reconstructed = fitNativeContinuation(fitted.samples, fitted.context, fitted.previousRef, fitted.knowledgeAt);
  if (reconstructed.ref !== fitted.ref) throw Error("W1_CONTINUATION_RESPONSE_DIGEST_MISMATCH");
  const ctx = fitted.context;
  if (Date.parse(fitted.knowledgeAt) > Date.parse(input.now)) throw Error("W1_CONTINUATION_OBSERVATION_AFTER_KNOWLEDGE_CUT");
  if (ctx.tenantId !== input.binding.tenantId || ctx.principalId !== input.binding.principalId ||
      ctx.purposeRef !== input.purposeRef || ctx.populationRef !== input.populationRef ||
      canonicalJson(ctx.pins) !== canonicalJson(input.pins) || canonicalJson(ctx.features) !== canonicalJson(input.features) ||
      Date.parse(ctx.validUntil) <= Date.parse(input.now)) throw Error("W1_CONTINUATION_RESPONSE_CURRENTNESS_UNPASSED");
  const model: MetalevelModel = { schema: "finnor.metalevel-model.v1", id: "pending-native-model", binding: input.binding,
    utilityUnit: input.utility.unit, rootStateId: "s0", maxDecisions: METALEVEL_LIMITS.decisions, tieOrder: [], states: [] };
  const frames: Record<string, NativeFrame> = {}, actions: Record<string, NativeStageAction> = {}, unidentified: NativeContinuationModel["unidentified"] = [];
  const currentIds = new Map(input.frame.units.map(unit => [unit.key, unit.unitId]));
  const normalize = (frame: NativeFrame) => nativeFrameSchema.parse({ ...frame,
    units: frame.units.map(unit => ({ ...unit, unitId: currentIds.get(unit.key) ?? unit.unitId })) });
  const dimensions = ["native-attempt", "logical-step", "wall-ms"] as const;
  const initial = { "native-attempt": String(Math.max(0, input.remaining.attempts - input.remaining.publicationAttempts)),
    "logical-step": String(Math.max(0, input.remaining.steps - (input.remaining.publicationSteps ?? 1))),
    "wall-ms": String(Math.max(0, Math.floor(input.remaining.wallMs))) };
  let horizonUsed = 0;
  function expand(rawFrame: NativeFrame, remaining: Record<string, string>, history: MetalevelState["history"]): string {
    if (model.states.length >= METALEVEL_LIMITS.states) throw Error("W1_CONTINUATION_STATE_BOUND");
    const id = "s" + model.states.length, frame = normalize(rawFrame);
    frames[id] = frame; horizonUsed = Math.max(horizonUsed, history.length);
    const unknown = frame.obligations.some(o => o.status !== "RESOLVED") || frame.disposition === "UNKNOWN";
    const stopId = id + ":stop";
    const state: MetalevelState = { id, decisionIndex: history.length, history, remaining,
      obligations: frame.obligations.map(o => o.status === "RESOLVED" ?
        { id: o.id, status: "RESOLVED" as const, resolutionRef: o.resolutionRef } :
        { id: o.id, status: o.status, resolutionRef: null }),
      requiredChecks: frame.requiredChecks, completedChecks: frame.completedChecks, acceptanceRef: null,
      choices: [{ id: stopId, kind: "STOP", utility: frame.disposition === "ACCEPTED" && !unknown ? input.utility!.lossGap : "0",
        disposition: unknown ? "UNKNOWN" : "INCOMPLETE", resultRef: null }] };
    model.states.push(state); model.tieOrder.push(stopId);
    if (unknown || frame.disposition !== "ACTIVE" || history.length === METALEVEL_LIMITS.decisions) return id;
    for (const action of nativeStageActions(input, frame)) {
      const estimates = conditional(fitted.samples, frame, action);
      if (!estimates) { unidentified.push({ stateId: id, actionRef: action.ref, reason: "MISSING_OR_UNKNOWN_CONDITIONAL_MEASUREMENT" }); continue; }
      const reserve = Object.fromEntries(dimensions.map((dimension, index) => [dimension, r2String(estimates.reduce((max, row) => {
        const amount = [row.attempts, row.steps, row.wall][index]!;
        return amount.compare(max) > 0 ? amount : max;
      }, exact(index === 0 ? action.attempts : index === 1 ? action.steps : 0)))]));
      if (dimensions.some(dimension => r2Quantity(reserve[dimension]!).compare(r2Quantity(remaining[dimension]!)) > 0)) continue;
      if (state.choices.length >= METALEVEL_LIMITS.choices + 1) throw Error("W1_CONTINUATION_CHOICE_BOUND");
      const choiceId = id + ":compute:" + action.ref;
      actions[choiceId] = action; model.tieOrder.push(choiceId);
      const outcomes: Extract<MetalevelState["choices"][number], { kind: "COMPUTE" }>["outcomes"] = estimates.map((row, index) => {
        const observation = "observed:" + index + ":" + nativeFrameKey(row.frame);
        const consumption = { "native-attempt": r2String(row.attempts), "logical-step": r2String(row.steps), "wall-ms": r2String(row.wall) };
        const next = Object.fromEntries(dimensions.map(dimension => [dimension, r2String(r2Quantity(remaining[dimension]!).sub(r2Quantity(consumption[dimension])))]));
        const nextStateId = expand(row.frame, next, [...history, { choiceId, observation }]);
        const cost = row.attempts.mul(r2Quantity(input.utility!.nativeAttemptCost)).add(row.wall.mul(r2Quantity(input.utility!.delayMsCost)));
        return { observation, kind: "VALID" as const, probability: r2String(row.probability), utilityDelta: r2String(exact(0).sub(cost)), consumption, nextStateId };
      });
      const invalid = normalize({ ...frame, disposition: "UNKNOWN", obligations: [...frame.obligations,
        { id: "invalid:" + choiceId, status: "UNKNOWN", resolutionRef: null }] });
      const invalidId = expand(invalid, { ...remaining }, [...history, { choiceId, observation: "INVALID_UNOBSERVED_GUARD" }]);
      outcomes.push({ observation: "INVALID_UNOBSERVED_GUARD", kind: "INVALID", probability: "0", utilityDelta: "0",
        consumption: { "native-attempt": "0", "logical-step": "0", "wall-ms": "0" }, nextStateId: invalidId });
      state.choices.push({ id: choiceId, kind: "COMPUTE", computationRef: action.ref, contextRefs: action.contextRefs,
        dependsOn: history.filter(event => actions[event.choiceId]?.unitKeys.some(key =>
          action.unitKeys.some(selected => frame.units.find(unit => unit.key === selected)?.prerequisites.includes(key)))).map(event => event.choiceId),
        verifierRefs: action.verifierRefs, utilityCost: "0", reservation: reserve, outcomes });
    }
    return id;
  }
  expand(input.frame, initial, []);
  model.id = "native-model:" + epistemicHash({ response: fitted.ref, frames, actions, rootResources: initial });
  if (Buffer.byteLength(canonicalJson(model)) > METALEVEL_LIMITS.inputBytes) throw Error("W1_CONTINUATION_BYTE_BOUND");
  return { model, frames, actions, horizonUsed, unidentified };
}
