import type { CoalitionProblem } from "../../../shared-types/src/coalition-programme";
import type { RationalRow } from "../../../shared-types/src/robust-programme-search";
import { canonicalJson } from "../source-precedence";
import { r2Quantity as q, r2String as text } from "../r2-rational";
import type { CoalitionFamily } from "./programmes";
import type { CoalitionEncoding } from "./encoding";
import { requireCoalition } from "./guards";

export type CoalitionTieCriterion =
  | { kind: "MEMBERSHIP"; anchor: string }
  | { kind: "PROGRAMME"; members: string[] }
  | { kind: "TRANSFER"; rule: number; partyId: string };
export interface CoalitionTieFix { criterion: CoalitionTieCriterion; value: string }
export interface CoalitionTieEncoding extends CoalitionEncoding {
  primaryValue: string; tieCriterion: CoalitionTieCriterion; tieFixes: CoalitionTieFix[];
}
export const COALITION_TIE_RULE = "SOURCE_ORDER_MEMBERSHIP_THEN_CANONICAL_STEPS_THEN_SIGNED_TRANSFERS" as const;

export function coalitionTieTerms(
  p: CoalitionProblem, family: CoalitionFamily, base: CoalitionEncoding, criterion: CoalitionTieCriterion,
): Array<[string, string]> {
  if (criterion.kind === "TRANSFER") {
    const column = base.transferColumns.find(column => column.rule === criterion.rule && column.partyId === criterion.partyId);
    requireCoalition(column, "ORIGINAL_TIE_TRANSFER_COORDINATE");
    return [[column.variableId, "-1"]];
  }
  const ranks = criterion.kind === "PROGRAMME"
    ? [...new Set(family.options.filter(option => canonicalJson(option.members) === canonicalJson(criterion.members))
      .map(option => canonicalJson(option.steps)))].sort() : [];
  return base.optionColumns.flatMap(column => {
    const option = family.options.find(option => option.id === column.optionId)!;
    if (criterion.kind === "MEMBERSHIP") {
      if (!option.members.includes(criterion.anchor)) return [];
      const mask = p.parties.reduce((mask, party, index) =>
        mask + (option.members.includes(party.id) ? 2 ** (p.parties.length - index - 1) : 0), 0);
      return [[column.variableId, String(mask)] as [string, string]];
    }
    if (canonicalJson(option.members) !== canonicalJson(criterion.members)) return [];
    const rank = ranks.indexOf(canonicalJson(option.steps));
    return rank ? [[column.variableId, String(-rank)] as [string, string]] : [];
  });
}

export function encodeCoalitionTie(
  p: CoalitionProblem, family: CoalitionFamily, base: CoalitionEncoding, primaryValue: string,
  fixes: CoalitionTieFix[], criterion: CoalitionTieCriterion,
): CoalitionTieEncoding {
  const encoding: CoalitionTieEncoding = {
    ...base, primaryValue, tieCriterion: criterion, tieFixes: fixes,
    variables: [{ id: "z", kind: "CONTINUOUS", lower: null, upper: null },
      ...base.variables.map(variable => variable.id === "z"
        ? { ...variable, id: "economic", lower: primaryValue, upper: primaryValue } : variable)],
    rows: base.rows.map(row => ({ ...row, terms: row.terms.map(([id, value]) => [id === "z" ? "economic" : id, value]) })),
  };
  const add = (sense: RationalRow["sense"], rhs: string, terms: Array<[string, string]>) =>
    encoding.rows.push({ id: "r" + encoding.rows.length, sense, rhs, terms });
  for (const fix of fixes) add("E", fix.value, coalitionTieTerms(p, family, base, fix.criterion));
  add("L", "0", [["z", "1"], ...coalitionTieTerms(p, family, base, criterion)
    .map(([id, value]): [string, string] => [id, text(q("0").sub(q(value)))])]);
  requireCoalition(encoding.variables.length <= p.limits.native.maxVariables &&
    encoding.rows.length <= p.limits.native.maxRows &&
    Buffer.byteLength(canonicalJson(encoding)) <= p.limits.maxEncodingBytes, "ORIGINAL_TIE_ENCODING_GRANT");
  return encoding;
}

export function coalitionMembersFromTie(p: CoalitionProblem, value: string): string[] {
  const mask = q(value);
  requireCoalition(mask.d === 1n && mask.n > 0n && mask.n < 2n ** BigInt(p.parties.length), "ORIGINAL_TIE_MEMBERSHIP_MASK");
  return p.parties.filter((_, index) => (mask.n & (1n << BigInt(p.parties.length - index - 1))) !== 0n).map(party => party.id);
}
