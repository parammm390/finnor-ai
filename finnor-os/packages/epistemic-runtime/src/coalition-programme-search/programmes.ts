import type {
  CoalitionAtom, CoalitionFeature, CoalitionProblem, CoalitionProgrammeOption, CoalitionStep,
} from "../../../shared-types/src/coalition-programme";
import { epistemicHash } from "../source-precedence";
import { r2Quantity as q, r2String as text } from "../r2-rational";
import { requireCoalition } from "./guards";

function atom(feature: CoalitionAtom, members: string[], step: CoalitionStep) {
  switch (feature.kind) {
    case "CONSTANT": return q("1");
    case "MEMBER": return q(members.includes(feature.partyId) ? "1" : "0");
    case "MEMBER_PAIR":
      requireCoalition(feature.parties[0] !== feature.parties[1], "ORIGINAL_DISTINCT_MEMBER_PAIR");
      return q(feature.parties.every(party => members.includes(party)) ? "1" : "0");
    case "TERM":
      requireCoalition(feature.id in step.terms, "ORIGINAL_TERM_BINDING");
      return q(step.terms[feature.id]!);
    case "GRANT":
      requireCoalition(step.grants[feature.resourceId]?.[feature.date] !== undefined, "ORIGINAL_GRANT_BINDING");
      return q(step.grants[feature.resourceId]![feature.date]!);
  }
}

function evaluate(feature: CoalitionFeature, members: string[], step: CoalitionStep) {
  return feature.kind === "PRODUCT"
    ? atom(feature.left, members, step).mul(atom(feature.right, members, step))
    : atom(feature, members, step);
}

export function reconstructCoalitionProgramme(
  p: CoalitionProblem, members: string[], steps: CoalitionStep[],
): CoalitionProgrammeOption {
  requireCoalition(steps.length > 0 && steps.length <= p.grammar.maxSteps, "ORIGINAL_PROGRAMME_LENGTH");
  const ids = p.parties.map(party => party.id), dates = p.dates.length;
  requireCoalition(new Set(members).size === members.length && members.every(party => ids.includes(party)), "ORIGINAL_MEMBERSHIP");
  const grossPayoffs = Object.fromEntries(p.worlds.map(world =>
    [world.id, Object.fromEntries(ids.map(party => [party, "0"]))]));
  const cashFlows = Object.fromEntries(p.worlds.map(world =>
    [world.id, Object.fromEntries(ids.map(party => [party, Array<string>(dates).fill("0")]))]));
  const cashOutflows = Object.fromEntries(p.worlds.map(world =>
    [world.id, Object.fromEntries(ids.map(party => [party, Array<string>(dates).fill("0")]))]));
  const resourceUse = Object.fromEntries(p.resources.map(resource => [resource.id, Array<string>(dates).fill("0")]));
  const items = new Set<string>(), exclusive = new Set<string>(), consent = new Set<string>(), used: string[] = [];
  for (const step of steps) {
    const op = p.grammar.operators.find(op => op.id === step.operatorId);
    requireCoalition(op && members.every(party => op.eligibleParties.includes(party)) &&
      op.requiredParties.every(party => members.includes(party)) &&
      members.length >= op.minMembers && members.length <= op.maxMembers, "INADMISSIBLE_COALITION_OPERATOR");
    requireCoalition(op.requiresAfter.every(id => used.includes(id)) &&
      (!used.length || p.grammar.operators.find(op => op.id === used.at(-1))!.kind !== "STOP"), "INADMISSIBLE_OPERATOR_ORDER");
    requireCoalition(op.termChoices.some(choice => epistemicHash(choice) === epistemicHash(step.terms)) &&
      op.grantChoices.some(choice => epistemicHash(choice) === epistemicHash(step.grants)), "ORIGINAL_GRAMMAR_CHOICE");
    for (const resource of p.resources)
      for (let date = 0; date < dates; date++)
        resourceUse[resource.id]![date] = text(q(resourceUse[resource.id]![date]!).add(q(step.grants[resource.id]![date]!)));
    for (const { cost, equations } of [{ cost: false, equations: op.equations }, { cost: true, equations: op.costs }])
      for (const equation of equations) {
        let active = false;
        for (const world of p.worlds) {
          const value = equation.terms.reduce((value, term) =>
            value.add(q(world.coefficients[term.coefficientId]!).mul(evaluate(term.feature, members, step))), q("0"));
          requireCoalition(members.includes(equation.ownerPartyId) || value.n === 0n, "UNSUPPORTED_NONMEMBER_PAYOFF");
          requireCoalition(!cost || value.n >= 0n, "ORIGINAL_NONNEGATIVE_COST");
          const signed = cost || equation.kind === "LIABILITY" ? q("0").sub(value) : value;
          grossPayoffs[world.id]![equation.ownerPartyId] = text(
            q(grossPayoffs[world.id]![equation.ownerPartyId]!).add(signed.mul(q(p.discountFactors[equation.date]!))));
          if (equation.kind === "CASH")
            cashFlows[world.id]![equation.ownerPartyId]![equation.date] = text(
              q(cashFlows[world.id]![equation.ownerPartyId]![equation.date]!).add(signed));
          if(equation.kind==="CASH"&&signed.n<0n)
            cashOutflows[world.id]![equation.ownerPartyId]![equation.date]=text(
              q(cashOutflows[world.id]![equation.ownerPartyId]![equation.date]!).sub(signed));
          active ||= value.n !== 0n;
        }
        if (active) {
          requireCoalition(!items.has(equation.itemId), "DUPLICATE_CANONICAL_ECONOMIC_ITEM");
          items.add(equation.itemId);
        }
      }
    op.exclusiveItems.forEach(item => exclusive.add(item));
    op.consentRequired.forEach(party => consent.add(party));
    used.push(op.id);
  }
  return { id: "option:" + epistemicHash({ members, steps }), members, steps,
    itemIds: [...items].sort(), exclusiveItems: [...exclusive].sort(), requiredConsents: [...consent].sort(),
    grossPayoffs, cashFlows, cashOutflows, resourceUse };
}

export interface CoalitionFamily {
  options: CoalitionProgrammeOption[];
  complete: boolean;
  unresolved: string[];
  rejected: Array<{ members: string[]; stepsDigest: string; predicate: string }>;
  partitions: Array<{ id: string; blocks: string[][]; programmeCombinations: string;
    disposition: "COMPLETE_JOINT_ENCODING" | "NO_ADMITTED_LOCAL_PROGRAMME" | "UNRESOLVED" }>;
}

/** Every original nonempty member subset and legal finite sequence is visited.
 * A cap/deadline leaves unresolved family coverage, never a certified shortlist. */
export function constructCoalitionFamily(p: CoalitionProblem, checkpoint: () => void): CoalitionFamily {
  const result: CoalitionFamily = { options: [], complete: true, unresolved: [], rejected: [], partitions: [] };
  const ids = p.parties.map(party => party.id), seen = new Set<string>();
  const visit = (members: string[], steps: CoalitionStep[]): void => {
    checkpoint();
    if (steps.length) {
      let option: CoalitionProgrammeOption;
      try { option = reconstructCoalitionProgramme(p, members, steps); }
      catch (error) {
        const predicate = error instanceof Error ? error.message : "R5_UNSUPPORTED_ORIGINAL_PROGRAMME";
        if (!["R5_INADMISSIBLE_COALITION_OPERATOR", "R5_INADMISSIBLE_OPERATOR_ORDER", "R5_DUPLICATE_CANONICAL_ECONOMIC_ITEM"].includes(predicate))
          throw error;
        result.rejected.push({ members, stepsDigest: epistemicHash(steps), predicate });
        return;
      }
      if (!seen.has(option.id)) {
        requireCoalition(result.options.length < p.limits.maxProgrammeOptions, "ORIGINAL_FAMILY_GENERATION_CAP");
        seen.add(option.id); result.options.push(option);
      }
    }
    if (steps.length === p.grammar.maxSteps) return;
    for (const op of p.grammar.operators) {
      if (steps.length && p.grammar.operators.find(op => op.id === steps.at(-1)!.operatorId)!.kind === "STOP") break;
      for (const terms of op.termChoices)
        for (const grants of op.grantChoices)
          visit(members, [...steps, { operatorId: op.id, terms, grants }]);
    }
  };
  try {
    for (let mask = 1; mask < 1 << ids.length; mask++)
      visit(ids.filter((_, i) => mask & 1 << i), []);
  } catch (error) {
    const predicate = error instanceof Error ? error.message : "R5_ORIGINAL_FAMILY_UNRESOLVED";
    if (!["R5_ORIGINAL_FAMILY_GENERATION_CAP", "R5_ORIGINAL_DEADLINE_EXHAUSTED"].includes(predicate)) throw error;
    result.complete = false; result.unresolved.push(predicate);
  }
  const counts = new Map<string, bigint>();
  for (const option of result.options) {
    const key = epistemicHash(option.members);
    counts.set(key, (counts.get(key) ?? 0n) + 1n);
  }
  const blocks: string[][] = [];
  const partition = (index: number): void => {
    checkpoint();
    if (index === ids.length) {
      const originalBlocks = blocks.map(block => [...block]);
      const combinations = originalBlocks.reduce((product, block) => product * (counts.get(epistemicHash(block)) ?? 0n), 1n);
      result.partitions.push({ id: "partition:" + epistemicHash(originalBlocks), blocks: originalBlocks,
        programmeCombinations: combinations.toString(), disposition: !result.complete ? "UNRESOLVED" :
          combinations === 0n ? "NO_ADMITTED_LOCAL_PROGRAMME" : "COMPLETE_JOINT_ENCODING" });
      return;
    }
    for (const block of blocks) {
      block.push(ids[index]!); partition(index + 1); block.pop();
    }
    blocks.push([ids[index]!]); partition(index + 1); blocks.pop();
  };
  try { partition(0); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "R5_ORIGINAL_DEADLINE_EXHAUSTED") throw error;
    result.complete = false; result.unresolved.push("ORIGINAL_PARTITION_INDEX_UNVISITED");
    result.partitions.forEach(partition => { partition.disposition = "UNRESOLVED"; });
  }
  return result;
}
