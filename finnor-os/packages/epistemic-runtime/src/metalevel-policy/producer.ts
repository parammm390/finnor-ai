import { createHash } from "node:crypto";
import { r2Quantity, r2String, r2Zero } from "../r2-rational";
import { controlMeter, type ExactControlBudget } from "../certified-state-reduction/exact";
import { METALEVEL_VERSION, metalevelBudget, parseMetalevelModel, type MetalevelPolicy } from "./contracts";

/** Full continuation over the declared complete-state finite model, not myopic ROI. */
export function compileMetalevelPolicy(bytes: string, suppliedBudget?: ExactControlBudget): MetalevelPolicy {
  const budget = metalevelBudget(suppliedBudget), model = parseMetalevelModel(bytes, budget);
  const meter = controlMeter(budget), values = new Map<string, ReturnType<typeof r2Quantity>>();
  const rows = new Map<string, MetalevelPolicy["states"][string]>();
  const tieOrder = new Map(model.tieOrder.map((id, index) => [id, index]));
  for (const state of [...model.states].sort((a, b) => b.decisionIndex - a.decisionIndex)) {
    const alternatives = state.choices.map(choice => {
      meter.step();
      if (choice.kind === "STOP") return { id: choice.id, value: r2Quantity(choice.utility) };
      let value = r2Zero().sub(r2Quantity(choice.utilityCost));
      for (const outcome of choice.outcomes) {
        meter.step();
        const next = values.get(outcome.nextStateId);
        if (next === undefined) throw new Error("METALEVEL_MISSING_CONTINUATION");
        value = value.add(r2Quantity(outcome.probability).mul(r2Quantity(outcome.utilityDelta).add(next)));
      }
      return { id: choice.id, value };
    });
    const first = alternatives[0];
    if (first === undefined) throw new Error("METALEVEL_EMPTY_CHOICES");
    const best = alternatives.reduce((value, item) => item.value.compare(value) > 0 ? item.value : value, first.value);
    const optimal = alternatives.filter(item => item.value.compare(best) === 0).map(item => item.id);
    optimal.sort((a, b) => (tieOrder.get(a) ?? Infinity) - (tieOrder.get(b) ?? Infinity));
    const selectedChoiceId = optimal[0];
    if (selectedChoiceId === undefined) throw new Error("METALEVEL_NO_OPTIMAL_CHOICE");
    values.set(state.id, best);
    rows.set(state.id, { value: r2String(best), selectedChoiceId, optimalChoiceIds: optimal,
      choiceValues: Object.fromEntries(alternatives.map(item => [item.id, r2String(item.value)])) });
  }
  return {
    schema: "finnor.metalevel-policy.v1", methodVersion: METALEVEL_VERSION,
    proofKind: "MODEL_RELATIVE_EXACT", modelSha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
    rootStateId: model.rootStateId, states: Object.fromEntries(rows),
  };
}
