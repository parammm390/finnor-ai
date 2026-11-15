import { z } from "zod";
import { r2Quantity, r2String, r2Zero } from "../r2-rational";
import { readOriginalExactJson } from "../certified-state-reduction/source-json";
import { controlMeter, type ExactControlBudget } from "../certified-state-reduction/exact";

export const METALEVEL_VERSION = "postz-w1-exact-v1" as const;
export const METALEVEL_LIMITS = Object.freeze({ states: 64, choices: 16, decisions: 8, inputBytes: 2 * 1024 * 1024 });
const identity = z.string().min(1).max(1024);
const uniqueRefs = z.array(identity).refine(v => new Set(v).size === v.length, "Duplicate reference");
const rational = z.string().superRefine((value, ctx) => {
  try { r2Quantity(value); } catch { ctx.addIssue({ code: "custom", message: "Invalid or unsupported exact rational" }); }
});
const nonnegative = rational.refine(v => r2Quantity(v).n >= 0n, "Negative quantity");
function exactRecord<Value extends z.ZodTypeAny>(valueSchema: Value) {
  return z.preprocess(value => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : null,
    z.array(z.tuple([identity, valueSchema])).transform((entries): Record<string, z.output<Value>> => Object.fromEntries(entries)));
}
const resources = exactRecord(nonnegative);
const historyEvent = z.object({ choiceId: identity, observation: identity }).strict();
const obligation = z.discriminatedUnion("status", [
  z.object({ id: identity, status: z.literal("PENDING"), resolutionRef: z.null() }).strict(),
  z.object({ id: identity, status: z.literal("UNKNOWN"), resolutionRef: z.null() }).strict(),
  z.object({ id: identity, status: z.literal("RESOLVED"), resolutionRef: identity }).strict(),
]);
const stopChoice = z.object({
  id: identity, kind: z.literal("STOP"), utility: rational,
  disposition: z.enum(["ACCEPTED", "INCOMPLETE", "UNKNOWN", "ESCALATE"]), resultRef: identity.nullable(),
}).strict();
const outcome = z.object({
  observation: identity, kind: z.enum(["VALID", "INVALID"]), probability: nonnegative,
  utilityDelta: rational, consumption: resources, nextStateId: identity,
}).strict();
const computeChoice = z.object({
  id: identity, kind: z.literal("COMPUTE"), computationRef: identity,
  contextRefs: uniqueRefs, dependsOn: uniqueRefs, verifierRefs: uniqueRefs,
  utilityCost: nonnegative, reservation: resources, outcomes: z.array(outcome).min(1),
}).strict();
export const metalevelBindingSchema = z.object({
  tenantId: identity, principalId: identity, workId: identity, outcomeRef: identity,
  mandateRef: identity, sourceRef: identity, rightsRef: identity, catalogueRef: identity,
  responseRef: identity, modelRef: identity, priceRef: identity, checkerRef: identity,
  runtimeRef: identity, parentGrantRef: identity, deadline: identity,
}).strict();
const stateSchema = z.object({
  id: identity, decisionIndex: z.number().int().min(0).max(METALEVEL_LIMITS.decisions),
  history: z.array(historyEvent), remaining: resources, obligations: z.array(obligation),
  requiredChecks: uniqueRefs, completedChecks: uniqueRefs, acceptanceRef: identity.nullable(),
  choices: z.array(z.discriminatedUnion("kind", [stopChoice, computeChoice])).min(1).max(METALEVEL_LIMITS.choices + 1),
}).strict();
export const metalevelModelSchema = z.object({
  schema: z.literal("finnor.metalevel-model.v1"), id: identity, binding: metalevelBindingSchema,
  utilityUnit: identity, rootStateId: identity,
  maxDecisions: z.number().int().min(0).max(METALEVEL_LIMITS.decisions),
  tieOrder: uniqueRefs, states: z.array(stateSchema).min(1).max(METALEVEL_LIMITS.states),
}).strict();
const policyState = z.object({
  value: rational, selectedChoiceId: identity, optimalChoiceIds: uniqueRefs,
  choiceValues: exactRecord(rational),
}).strict();
export const metalevelPolicySchema = z.object({
  schema: z.literal("finnor.metalevel-policy.v1"), methodVersion: z.literal(METALEVEL_VERSION),
  proofKind: z.literal("MODEL_RELATIVE_EXACT"), modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rootStateId: identity, states: exactRecord(policyState),
}).strict();
export type MetalevelModel = z.infer<typeof metalevelModelSchema>;
export type MetalevelState = MetalevelModel["states"][number];
export type MetalevelPolicy = z.infer<typeof metalevelPolicySchema>;

export function metalevelBudget(budget?: ExactControlBudget): ExactControlBudget {
  return { deadlineAt: budget?.deadlineAt ?? Date.now() + 120_000, maxSteps: budget?.maxSteps ?? 4_000_000,
    ...budget, account: budget?.account ?? { steps: 0 } };
}
function requireModel(condition: boolean, predicate: string): asserts condition {
  if (!condition) throw new Error(`METALEVEL_${predicate}`);
}
function sameKeys(a: object, b: object): boolean {
  const x = Object.keys(a).sort(), y = Object.keys(b).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function resource(vector: Record<string, string>, dimension: string) {
  const value = vector[dimension];
  if (value === undefined) throw new Error("METALEVEL_RESOURCE_DIMENSIONS");
  return r2Quantity(value);
}

/** One lexical/schema/semantic boundary. The original bytes remain authoritative. */
export function parseMetalevelModel(bytes: string, suppliedBudget?: ExactControlBudget): MetalevelModel {
  requireModel(Buffer.byteLength(bytes, "utf8") <= METALEVEL_LIMITS.inputBytes, "INPUT_BYTE_BOUND");
  const budget = metalevelBudget(suppliedBudget), meter = controlMeter(budget);
  const model = metalevelModelSchema.parse(readOriginalExactJson(bytes, budget));
  const states = new Map(model.states.map(s => [s.id, s]));
  requireModel(states.size === model.states.length, "DUPLICATE_STATE");
  const root = states.get(model.rootStateId);
  requireModel(root?.decisionIndex === 0, "ROOT");
  requireModel(root !== undefined && Object.keys(root.remaining).length > 0, "EMPTY_RESOURCES");
  const choiceIds = new Set<string>();
  for (const state of model.states) {
    meter.step();
    requireModel(state.decisionIndex <= model.maxDecisions && state.history.length === state.decisionIndex, "COMPLETE_HISTORY_HORIZON");
    requireModel(sameKeys(root.remaining, state.remaining), "RESOURCE_DIMENSIONS");
    requireModel(new Set(state.obligations.map(o => o.id)).size === state.obligations.length, "DUPLICATE_OBLIGATION");
    requireModel(new Set(state.choices.map(c => c.id)).size === state.choices.length, "DUPLICATE_CHOICE");
    requireModel(state.choices.some(c => c.kind === "STOP"), "EXPLICIT_STOP_REQUIRED");
    for (const choice of state.choices) {
      meter.step();
      choiceIds.add(choice.id);
      if (choice.kind === "STOP") {
        requireModel(choice.disposition !== "ACCEPTED" || (
          choice.resultRef !== null && state.acceptanceRef !== null &&
          state.requiredChecks.every(ref => state.completedChecks.includes(ref)) &&
          state.obligations.every(o => o.status === "RESOLVED")), "UNSAFE_ACCEPTED_STOP");
        continue;
      }
      requireModel(state.decisionIndex < model.maxDecisions, "COMPUTATION_HORIZON");
      requireModel(choice.dependsOn.every(id => state.history.some(event => event.choiceId === id)), "UNMET_DEPENDENCY");
      requireModel(sameKeys(state.remaining, choice.reservation), "RESOURCE_DIMENSIONS");
      for (const dimension of Object.keys(state.remaining)) {
        requireModel(resource(choice.reservation, dimension).compare(resource(state.remaining, dimension)) <= 0, "UNAFFORDABLE_RESERVATION");
      }
      let probability = r2Zero();
      requireModel(new Set(choice.outcomes.map(o => o.observation)).size === choice.outcomes.length, "DUPLICATE_OBSERVATION");
      requireModel(choice.outcomes.filter(o => o.kind === "INVALID").length === 1, "EXPLICIT_INVALID_OBSERVATION");
      for (const transition of choice.outcomes) {
        meter.step();
        probability = probability.add(r2Quantity(transition.probability));
        const successor = states.get(transition.nextStateId);
        requireModel(successor !== undefined && successor.decisionIndex === state.decisionIndex + 1, "SUCCESSOR_HORIZON");
        requireModel(JSON.stringify(successor.history) === JSON.stringify([...state.history, {
          choiceId: choice.id, observation: transition.observation,
        }]), "SUCCESSOR_HISTORY");
        requireModel(sameKeys(state.remaining, transition.consumption) && sameKeys(state.remaining, successor.remaining), "RESOURCE_DIMENSIONS");
        for (const dimension of Object.keys(state.remaining)) {
          const consumed = resource(transition.consumption, dimension);
          requireModel(consumed.compare(resource(choice.reservation, dimension)) <= 0, "RESERVATION_EXCEEDED");
          requireModel(resource(successor.remaining, dimension).compare(resource(state.remaining, dimension).sub(consumed)) === 0, "RESOURCE_CONSERVATION");
        }
        for (const before of state.obligations) {
          const after = successor.obligations.find(o => o.id === before.id);
          requireModel(after !== undefined, "ERASED_OBLIGATION");
          requireModel(before.status !== "RESOLVED" || (
            after.status === "RESOLVED" && after.resolutionRef === before.resolutionRef), "ALTERED_RESOLVED_OBLIGATION");
        }
      }
      requireModel(r2String(probability) === "1", "PROBABILITY_MASS");
    }
  }
  requireModel(model.tieOrder.length === choiceIds.size && model.tieOrder.every(id => choiceIds.has(id)), "TOTAL_TIE_ORDER_REQUIRED");
  return model;
}
