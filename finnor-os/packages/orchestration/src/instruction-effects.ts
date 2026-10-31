/** Pure instruction effect grammar shared by read intake and execution routing.
 * A company name is masked by its bounded subject span, never by a verb exemption. */
export const MUTATION = /\b(?:send|email|message|call|create|update|delete|remove|assign|handoff|delegate|schedule|reschedule|share|approve|reject|close|waive|execute|change)\b/i;
export const EXECUTION_COMMAND = /(?:^|[.!?,;\n]\s*|\b(?:and|then)\s+)(?:(?:please|also)\s+){0,2}(?:run|start|launch)\b|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:run|start|launch)\b/i;
export const EXECUTION_NAME_LIST = /\b(?:for|between|of)\s+(?:run|start|launch)(?:\s*,\s*(?:run|start|launch))*(?:\s*,?\s+(?:and|or)\s+(?:run|start|launch))\b/gi;
const atomicWords = /\b(?:send|text|email|message|call|assign|update|set|mark|reschedule|cancel|create|record)\b/;
export const ATOMIC_VERB = new RegExp(`^(?:please\\s+)?${atomicWords.source}`, "i");
const effectWords = new RegExp(`${MUTATION.source}|${atomicWords.source}|\\b(?:buy|sell|trade|purchase|pay|transfer|restate|increase|decrease|spawn|run|start|launch|submit|monitor)\\b`, "gi");
const negative = /\b(?:do\s+not|does\s+not|did\s+not|must\s+not|should\s+not|will\s+not|shall\s+not|can\s+not|don['’]t|doesn['’]t|didn['’]t|won['’]t|shouldn['’]t|never|without)\b/i;

export function requestsPositiveInstructionEffect(
  instruction: string,
  entitySpans: ReadonlyArray<readonly [number, number]> = [],
): boolean {
  const clauses = /([.;!?\n]|,\s*(?:and|then)\b|,|\b(?:and|or|but|then|also)\b)/iu;
  // Offsets are UTF-16 (RegExp.index), not Unicode code points.
  let masked = instruction;
  for (const [start, end] of [...entitySpans].sort((a, b) => b[0] - a[0])) {
    if (start >= 0 && end >= start && end <= instruction.length)
      masked = masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
  }
  // Restore a clause-leading imperative that a greedy subject could hide.
  // It still goes through the same negation/list grammar as every other verb.
  let cursor = 0;
  for (const clause of instruction.split(clauses)) {
    const clauseStart = instruction.indexOf(clause, cursor);
    cursor = clauseStart + clause.length;
    const trimmed = clause.trim();
    const leading = /^(?:[-*]\s*)?(?:please\s+)?(\w+)\b/i.exec(trimmed);
    const word = leading?.[1] ?? "";
    const wordStart = clauseStart + clause.indexOf(trimmed) + (leading?.[0].lastIndexOf(word) ?? 0);
    effectWords.lastIndex = 0;
    // "Oil and Change Holdings" is one protected subject, not a new command
    // after its internal conjunction. A verb at the subject's start remains
    // ambiguous/imperative and cannot be hidden by a greedy subject capture.
    if (effectWords.test(word) && !entitySpans.some(([start, end]) => start < wordStart && wordStart < end))
      masked = masked.slice(0, wordStart) + word + masked.slice(wordStart + word.length);
  }
  const parts = masked.replace(EXECUTION_NAME_LIST, "operation names").split(clauses);
  let negatedList = false;
  let negatedListLength = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const separator = index ? parts[index - 1]! : "";
    const continuesList = /^(?:,|and|or)$/i.test(separator)
      || /^,\s*and$/i.test(separator) && negatedListLength > 1;
    if (index && !continuesList) {
      negatedList = false;
      negatedListLength = 0;
    }
    const clause = parts[index]!;
    if (!clause.trim()) continue;
    const leading = /^([a-z]+)\b/i.exec(clause.trim())?.[1] ?? "";
    effectWords.lastIndex = 0;
    // Only another bare verb continues a negated coordinated list. "please",
    // a bullet, sentence/newline, semicolon, but/then/also starts a new command.
    const coordinated = negatedList && effectWords.test(leading);
    let seenEffect = false;
    effectWords.lastIndex = 0;
    for (const match of clause.matchAll(effectWords)) {
      seenEffect = true;
      if (!coordinated && !negative.test(clause.slice(0, match.index))) return true;
    }
    const mandate = /\b(?:every|each)\s+(?:day|week|month|quarter|year)\b|\b(?:keep watching|standing mandate)\b/i.exec(clause);
    if (mandate && !coordinated && !negative.test(clause.slice(0, mandate.index))) return true;
    negatedListLength = seenEffect ? negatedListLength + 1 : 0;
    negatedList = seenEffect;
  }
  return false;
}
