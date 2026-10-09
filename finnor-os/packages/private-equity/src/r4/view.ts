import type { IdentificationExpression, IdentificationPlan } from "../../../shared-types/src/identification-plan";
import type { R4Profile } from "./contracts";

/** Presentation only. The checker, not this renderer, supplies the proof. */
function expression(value: IdentificationExpression, depth = 0): string {
  if (depth > 96) throw Error("R4_VIEW_EXPRESSION_BOUND");
  switch (value.op) {
    case "one": return "1";
    case "probability": return `P[${value.variables.join(", ")}${value.given.length ? " | " + value.given.join(", ") : ""}] from ${value.law}`;
    case "product": return value.terms.map(v => "(" + expression(v, depth + 1) + ")").join(" × ");
    case "sum": return `sum over ${value.variables.join(", ")} (${expression(value.expression, depth + 1)})`;
    case "ratio": return `(${expression(value.numerator, depth + 1)}) / (${expression(value.denominator, depth + 1)})`;
  }
}
export function profileView(p: R4Profile) {
  return {
    id: p.id, ref: p.ref, workRevision: p.workInputId, budgetGrantRef: p.ownerBinding.S5.allocationRef,
    query: p.problem.query, graphIds: p.problem.graphs.map(g => g.id), costBasis: p.problem.constraints.costBasis,
    scheduleUnit: p.problem.constraints.scheduleUnit, qualification: p.qualification,
    validUntil: new Date(Math.min(Date.parse(p.ownerBinding.S4.validUntil), Date.parse(p.ownerBinding.S5.validUntil))).toISOString(),
    menu: p.problem.bundles.map(b => ({ id: b.id, costItemIds: b.costItemIds, schedule: b.schedule })),
    graphTruthEstablished: false, executionAuthorityGranted: false,
  };
}
export function planView(plan: IdentificationPlan) {
  return {
    identification: plan.identification, basis: plan.basis, selected: plan.selected,
    commonFunctional: plan.commonFunctional, minimality: plan.minimality,
    pairs: plan.pairs.map(pair => ({
      mask: pair.mask, graphId: pair.graphId, structural: pair.structural, data: pair.data,
      sufficient: pair.sufficient, lawId: pair.lawId, proofId: pair.proofId,
      functional: pair.expression ? expression(pair.expression) : null,
      conditions: pair.conditions, reasons: pair.reasons,
    })),
    masks: plan.masks.map((value: any) => {
      const pairs = plan.pairs.filter(pair => pair.mask === value.mask);
      return {
        mask: value.mask, bundleIds: value.bundleIds, status: value.status,
        totalCost: value.totalCost, completion: value.completion,
        sufficientForFamily: pairs.length > 0 && pairs.every(pair => pair.sufficient),
        reasons: [...new Set([...value.reasons, ...pairs.flatMap(pair => pair.reasons)])],
      };
    }),
    assumptions: plan.assumptions, graphTruthEstablished: false, effectEstimate: null,
    attributionGranted: false, executionAuthorityGranted: false, admission: null,
  };
}
