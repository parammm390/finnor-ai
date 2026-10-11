import type { RationalMILP, RationalRow } from "../../../shared-types/src/robust-programme-search";
import type { CoalitionDivision, CoalitionProblem } from "../../../shared-types/src/coalition-programme";
import { canonicalJson, epistemicHash } from "../source-precedence";
import { r2Quantity as q, r2String as text } from "../r2-rational";
import { requireCoalition } from "./domain";
import type { CoalitionFamily } from "./programmes";
import {canonicalCoalitionConstraints} from "./canonical-allocation";

export interface CoalitionEncoding extends RationalMILP {
  schema: "finnor.r5.milp.v1";
  originalDigest: string;
  grammarDigest: string;
  worldDigest: string;
  restrictedWorlds: string[];
  optionColumns: Array<{ optionId: string; variableId: string }>;
  transferColumns: Array<{ rule: number; partyId: string; variableId: string }>;
  coverage: { fullProgrammeFamily: boolean; completeWorldIndex: string[]; allEligibleParties: string[] };
}

type Terms = Array<[string, string]>;
const clean = (terms: Terms): Terms => {
  const values = new Map<string, ReturnType<typeof q>>();
  for (const [id, value] of terms) values.set(id, (values.get(id) ?? q("0")).add(q(value)));
  return [...values].filter(([, value]) => value.n !== 0n).map(([id, value]) => [id, text(value)]);
};

export function encodeCoalitionMaster(
  p: CoalitionProblem, family: CoalitionFamily, restrictedWorlds: string[],
): CoalitionEncoding {
  requireCoalition(restrictedWorlds.length > 0 && new Set(restrictedWorlds).size === restrictedWorlds.length &&
    restrictedWorlds.every(id => p.worlds.some(world => world.id === id)), "ORIGINAL_RESTRICTED_WORLD_INDEX");
  const optionColumns = family.options.map((option, index) => ({ optionId: option.id, variableId: `c${index}` }));
  const transferColumns = p.transfers.flatMap((_, rule) => p.parties.map((party, index) =>
    ({ rule, partyId: party.id, variableId: `t${rule}_${index}` })));
  const variables: RationalMILP["variables"] = [
    { id: "z", kind: "CONTINUOUS", lower: null, upper: null },
    ...optionColumns.map(column => ({ id: column.variableId, kind: "BINARY" as const, lower: "0", upper: "1" })),
    ...transferColumns.map(column => ({ id: column.variableId, kind: "CONTINUOUS" as const,
      lower: p.transfers[column.rule]!.bounds[column.partyId]![0],
      upper: p.transfers[column.rule]!.bounds[column.partyId]![1] })),
  ];
  const rows: RationalRow[] = [];
  const row = (sense: RationalRow["sense"], rhs: string, terms: Terms) =>
    rows.push({ id: `r${rows.length}`, sense, rhs: text(q(rhs)), terms: clean(terms) });
  const options = (value: (index: number) => string): Terms =>
    optionColumns.map((column, index) => [column.variableId, value(index)]);

  for (const party of p.parties)
    row("E", "1", options(index => family.options[index]!.members.includes(party.id) ? "1" : "0"));
  for (const category of ["itemIds", "exclusiveItems"] as const)
    for (const item of new Set(family.options.flatMap(option => option[category])))
      row("L", "1", options(index => family.options[index]![category].includes(item) ? "1" : "0"));
  p.transfers.forEach((_, rule) =>
    row("E", "0", transferColumns.filter(column => column.rule === rule).map(column => [column.variableId, "1"])));

  const netTerms = (worldId: string, partyId: string): Terms => {
    const world = p.worlds.find(world => world.id === worldId)!;
    return [
      ...options(index => family.options[index]!.grossPayoffs[worldId]![partyId]!),
      ...transferColumns.filter(column => column.partyId === partyId &&
        world.eventTokens[p.transfers[column.rule]!.eventId] === p.transfers[column.rule]!.token)
        .map((column): [string, string] => [column.variableId, p.discountFactors[p.transfers[column.rule]!.date]!]),
    ];
  };
  for (const worldId of restrictedWorlds) {
    const world = p.worlds.find(world => world.id === worldId)!;
    for (const party of p.parties) {
      row("G", party.outsideOptions[worldId]!, netTerms(worldId, party.id));
      for (let date = 0; date < p.dates.length; date++) {
        const cash: Terms = options(index => text(family.options[index]!.cashFlows[worldId]![party.id]!
          .slice(0, date + 1).reduce((sum, value) => sum.add(q(value)), q("0"))));
        for (const column of transferColumns) {
          const rule = p.transfers[column.rule]!;
          if (column.partyId === party.id && rule.date <= date && world.eventTokens[rule.eventId] === rule.token)
            cash.push([column.variableId, "1"]);
        }
        row("G", text(q("0").sub(q(party.settledCash[worldId]![date]!))), cash);
      }
    }
    for (const resource of p.resources)
      for (let date = 0; date < p.dates.length; date++)
        row("L", resource.available[worldId]![date]!, options(index => {
          const use = family.options[index]!.resourceUse[resource.id]!;
          return resource.kind === "CUMULATIVE_EXPENDITURE"
            ? text(use.slice(0, date + 1).reduce((sum, value) => sum.add(q(value)), q("0")))
            : use[date]!;
        }));
    if (p.objective.kind === "ROBUST") {
      const objective: Terms = [["z", "1"]];
      for (const party of p.parties)
        for (const [id, value] of netTerms(worldId, party.id))
          objective.push([id, text(q("0").sub(q(value).mul(q(party.ownerObjectiveWeight))))]);
      row("L", "0", objective);
    }
  }
  if (p.objective.kind === "EXPECTED") {
    const objective: Terms = [["z", "1"]];
    for (const world of p.worlds)
      for (const party of p.parties)
        for (const [id, value] of netTerms(world.id, party.id))
          objective.push([id, text(q("0").sub(q(value).mul(q(party.ownerObjectiveWeight)).mul(q(p.objective.probabilities[world.id]!))))]);
    row("E", "0", objective);
  }
  const canonical=canonicalCoalitionConstraints(p,family,optionColumns,transferColumns,restrictedWorlds);
  variables.push(...canonical.variables);
  for(const constraint of canonical.rows)row(constraint.sense,constraint.rhs,constraint.terms);
  requireCoalition(variables.length <= p.limits.native.maxVariables && rows.length <= p.limits.native.maxRows,
    "ORIGINAL_MILP_SIZE_GRANT_EXHAUSTED");
  const encoding: CoalitionEncoding = {
    schema: "finnor.r5.milp.v1", originalDigest: epistemicHash(p), grammarDigest: epistemicHash(p.grammar),
    worldDigest: epistemicHash(p.worlds), restrictedWorlds, variables,
    objective: { sense: "min", terms: [["z", "-1"]] }, rows, optionColumns, transferColumns,
    coverage: { fullProgrammeFamily: family.complete, completeWorldIndex: p.worlds.map(world => world.id),
      allEligibleParties: p.parties.map(party => party.id) },
  };
  requireCoalition(Buffer.byteLength(canonicalJson(encoding)) <= p.limits.maxEncodingBytes, "ORIGINAL_ENCODING_BYTE_GRANT_EXHAUSTED");
  return encoding;
}

export function decodeCoalitionPrimal(
  p: CoalitionProblem, family: CoalitionFamily, encoding: CoalitionEncoding, solution: Record<string, string>,
) {
  const selected = encoding.optionColumns.filter(column => {
    const value = q(solution[column.variableId] ?? "0");
    requireCoalition(value.n === 0n || value.compare(q("1")) === 0, "EXACT_INTEGRAL_PRIMAL_REQUIRED");
    return value.n !== 0n;
  }).map(column => family.options.find(option => option.id === column.optionId)!);
  const division: CoalitionDivision[] = p.transfers.map((rule, index) => ({
    eventId: rule.eventId, token: rule.token, date: rule.date, operationRef: rule.operationRef,
    amounts: Object.fromEntries(p.parties.map(party => {
      const column = encoding.transferColumns.find(column => column.rule === index && column.partyId === party.id)!;
      return [party.id, text(q(solution[column.variableId] ?? "0"))];
    })),
  }));
  return { selected, division, objective: text(q(solution.z ?? "0")) };
}
