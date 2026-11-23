import { createHash } from "node:crypto";
import { r2Quantity, r2String, r2Zero } from "../r2-rational";
import { controlMeter, type ExactControlBudget } from "../certified-state-reduction/exact";
import { metalevelBudget, metalevelPolicySchema, parseMetalevelModel } from "./contracts";

export type MetalevelCheck =
  | { status: "VALID"; modelSha256: string; checkedStates: number; scope: "MODEL_RELATIVE_EXACT"; authorityGranted: false }
  | { status: "INVALID"; reasons: string[]; authorityGranted: false };

/** Reconstruct every original Bellman predicate. No producer or selection imports. */
export function checkMetalevelPolicy(bytes: string, candidate: unknown, suppliedBudget?: ExactControlBudget): MetalevelCheck {
  try {
    const budget = metalevelBudget(suppliedBudget), model = parseMetalevelModel(bytes, budget);
    const meter = controlMeter(budget), policy = metalevelPolicySchema.parse(candidate);
    const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
    if (policy.modelSha256 !== digest || policy.rootStateId !== model.rootStateId) throw new Error("ORIGINAL_MODEL_BINDING");
    const stateIds = new Set(model.states.map(s => s.id));
    if (Object.keys(policy.states).length !== stateIds.size || Object.keys(policy.states).some(id => !stateIds.has(id))) throw new Error("COMPLETE_STATE_COVERAGE");
    const certified = new Map<string, ReturnType<typeof r2Quantity>>();
    for (const state of [...model.states].sort((a, b) => b.decisionIndex - a.decisionIndex)) {
      meter.step();
      const row = Object.hasOwn(policy.states, state.id) ? policy.states[state.id] : undefined;
      if (row === undefined) throw new Error("MISSING_STATE");
      const choiceIds = new Set(state.choices.map(c => c.id));
      if (Object.keys(row.choiceValues).length !== choiceIds.size || Object.keys(row.choiceValues).some(id => !choiceIds.has(id))) throw new Error("COMPLETE_CHOICE_COVERAGE");
      const reconstructed = new Map<string, ReturnType<typeof r2Quantity>>();
      for (const choice of state.choices) {
        meter.step();
        let continuation = choice.kind === "STOP" ? r2Quantity(choice.utility) : r2Zero().sub(r2Quantity(choice.utilityCost));
        if (choice.kind === "COMPUTE") {
          for (const transition of choice.outcomes) {
            meter.step();
            const downstream = certified.get(transition.nextStateId);
            if (downstream === undefined) throw new Error("UNCHECKED_SUCCESSOR");
            continuation = continuation.add(r2Quantity(transition.probability).mul(downstream.add(r2Quantity(transition.utilityDelta))));
          }
        }
        if (!Object.hasOwn(row.choiceValues, choice.id) || row.choiceValues[choice.id] !== r2String(continuation)) throw new Error("CHOICE_CONTINUATION_VALUE");
        reconstructed.set(choice.id, continuation);
      }
      let maximum: ReturnType<typeof r2Quantity> | undefined;
      for (const value of reconstructed.values()) if (maximum === undefined || value.compare(maximum) > 0) maximum = value;
      if (maximum === undefined || row.value !== r2String(maximum)) throw new Error("STATE_OPTIMAL_VALUE");
      const optimal = model.tieOrder.filter(id => reconstructed.get(id)?.compare(maximum) === 0);
      if (JSON.stringify(optimal) !== JSON.stringify(row.optimalChoiceIds) || row.selectedChoiceId !== optimal[0]) throw new Error("ORIGINAL_EXACT_TIES");
      certified.set(state.id, maximum);
    }
    return { status: "VALID", modelSha256: digest, checkedStates: certified.size, scope: "MODEL_RELATIVE_EXACT", authorityGranted: false };
  } catch (error) {
    return { status: "INVALID", reasons: [error instanceof Error ? error.message : String(error)], authorityGranted: false };
  }
}
