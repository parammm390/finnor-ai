import type { CoalitionProblem } from "../../../shared-types/src/coalition-programme";
import type { CoalitionFamily } from "../../../epistemic-runtime/src/coalition-programme-search/programmes";
import { encodeCoalitionMaster, decodeCoalitionPrimal } from "../../../epistemic-runtime/src/coalition-programme-search/encoding";
import { encodeCoalitionTie, coalitionTieTerms, coalitionMembersFromTie, COALITION_TIE_RULE,
  type CoalitionTieCriterion, type CoalitionTieFix } from "../../../epistemic-runtime/src/coalition-programme-search/tie";
import { requireCoalition } from "../../../epistemic-runtime/src/coalition-programme-search/guards";
import { r2Quantity as q, r2String as text } from "../../../epistemic-runtime/src/r2-rational";
import type { R2NativeSession } from "./r2-native";

export async function selectCoalitionNativeTie(
  p: CoalitionProblem, family: CoalitionFamily, value: string, session: R2NativeSession,
) {
  const base = encodeCoalitionMaster(p, family, p.worlds.map(world => world.id));
  const fixes: CoalitionTieFix[] = [], stages: Array<{
    encoding: ReturnType<typeof encodeCoalitionTie>; solved: Awaited<ReturnType<R2NativeSession["solve"]>>;
    value: string;
  }> = [];
  const assigned = new Set<string>();
  async function stage(criterion: CoalitionTieCriterion) {
    requireCoalition(session.deadlineAt - Date.now() >= 5000 &&
      session.chargedCpuMs < session.caps.cpuMs - 3000, "ORIGINAL_TIE_REMAINING_GRANT");
    const encoding = encodeCoalitionTie(p, family, base, value, [...fixes], criterion);
    const solved = await session.solve(encoding, 1000 + stages.length);
    requireCoalition(solved.solution && solved.viprRef && solved.proofRef && !solved.proofError, "ORIGINAL_TIE_NATIVE_PROOF_UNKNOWN");
    const objective = text(coalitionTieTerms(p, family, base, criterion).reduce((sum, [id, coefficient]) =>
      sum.add(q(coefficient).mul(q(solved.solution![id] ?? "0"))), q("0")));
    requireCoalition(q(solved.solution.z ?? "0").compare(q(objective)) === 0, "ORIGINAL_TIE_EXACT_PRIMAL_VALUE");
    fixes.push({ criterion, value: objective }); stages.push({ encoding, solved, value: objective });
    return objective;
  }
  for (const party of p.parties) {
    if (assigned.has(party.id)) continue;
    const members = coalitionMembersFromTie(p, await stage({ kind: "MEMBERSHIP", anchor: party.id }));
    requireCoalition(members.includes(party.id) && members.every(id => !assigned.has(id)), "ORIGINAL_TIE_CANONICAL_PARTITION");
    await stage({ kind: "PROGRAMME", members }); members.forEach(id => assigned.add(id));
  }
  for (let rule = 0; rule < p.transfers.length; rule++)
    for (const party of p.parties) await stage({ kind: "TRANSFER", rule, partyId: party.id });
  const last=stages.at(-1);
  requireCoalition(last?.solved.solution, "ORIGINAL_TIE_CANDIDATE_ABSENT");
  const candidate={...decodeCoalitionPrimal(p,family,last.encoding,last.solved.solution),objective:value};
  const checked = await session.checkCoalition(p, "tie", { family, base, primaryValue: value,
    stages: stages.map(stage => ({ encoding: stage.encoding, proofPath: stage.solved.proofPath,
      solution: stage.solved.solution, value: stage.value })), candidate });
  return { rule: COALITION_TIE_RULE, qualified: true as const, candidate, checked, stages };
}
