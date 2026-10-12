import { z } from "zod";

const text = z.string().min(1).max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const atom = z.object({ identity: text, semanticDigest: digest }).strict();
export const ExpectedEnvironment = z.object({
  mappings: z.array(atom).max(150000),
  obligations: z.array(atom.extend({ postconditionDigest: digest, deadlineAt: instant,
    critical: z.boolean(), businessAssignmentId: text, fixedBusinessWeight: z.number().positive().finite() }).strict()).max(3840),
  changes: z.array(z.object({ identity: text, occurredAt: instant, availableAt: instant }).strict()).max(150000),
}).strict();
export const ObservedEnvironment = z.object({
  mappings: z.array(atom).max(150000), obligations: z.array(atom).max(3840),
  completions: z.array(z.object({ identity: text,
    disposition: z.enum(["OBSERVED", "MISSED", "BLOCKED", "UNKNOWN", "REFUSED", "EXPIRED", "OVERRIDDEN"]),
    postconditionDigest: digest.nullable(), observedAt: instant.nullable(), witnessDigest: digest.nullable(),
  }).strict()).max(3840),
  changes: z.array(z.object({ identity: text, recognizedAt: instant.nullable(), witnessDigest: digest.nullable() }).strict()).max(150000),
  violations: z.array(z.enum(["UNAUTHORIZED_EFFECT", "TENANT_DISCLOSURE", "STALE_GRANT_EXECUTION",
    "FALSE_COMPLETION", "SILENT_MATERIAL_CONTRADICTION", "INSTITUTION_HUMAN_PATCH", "ORACLE_CONTAMINATION"])).max(10000),
}).strict();
export type Expected = z.infer<typeof ExpectedEnvironment>;
export type Observed = z.infer<typeof ObservedEnvironment>;

function unique(items: Array<{ identity: string }>, predicate: string) {
  if (new Set(items.map(item => item.identity)).size !== items.length) throw Error(predicate);
}
function matches(expected: Expected["mappings"], actual: Observed["mappings"]) {
  const truth = new Map(expected.map(item => [item.identity, item.semanticDigest])), credited = new Set<string>();
  for (const claim of actual) if (!credited.has(claim.identity) && truth.get(claim.identity) === claim.semanticDigest)
    credited.add(claim.identity);
  return { expected: expected.length, claimed: actual.length, correct: credited.size,
    precision: actual.length ? credited.size / actual.length : null,
    recall: expected.length ? credited.size / expected.length : null,
    passed: expected.length > 0 && actual.length > 0
      && 100 * credited.size >= 99 * actual.length && 100 * credited.size >= 95 * expected.length };
}

/** Independent ledger comparison. This function imports no X1 reconstruction,
 * mapping, rule selection or continuation code. It grants no admission. */
export function scoreEnvironment(expectedValue: unknown, observedValue: unknown) {
  const expected = ExpectedEnvironment.parse(expectedValue), observed = ObservedEnvironment.parse(observedValue);
  unique(expected.mappings, "X1_ORACLE_MAPPING_IDENTITY_DUPLICATE");
  unique(expected.obligations, "X1_ORACLE_OBLIGATION_IDENTITY_DUPLICATE");
  unique(expected.changes, "X1_ORACLE_CHANGE_IDENTITY_DUPLICATE");
  if (new Set(expected.obligations.map(item => item.businessAssignmentId)).size !== expected.obligations.length)
    throw Error("X1_ORIGINAL_BUSINESS_ASSIGNMENT_DUPLICATE");
  if (expected.changes.some(change => Date.parse(change.occurredAt) > Date.parse(change.availableAt)))
    throw Error("X1_ADMITTED_CHANNEL_AVAILABILITY_PRECEDES_OCCURRENCE");
  const mapping = matches(expected.mappings, observed.mappings), obligation = matches(expected.obligations, observed.obligations);
  const timely = new Set<string>(), completionGaps: Array<{ identity: string; reason: string }> = [];
  const falseCompletions = new Set<string>();
  const duties = new Map(expected.obligations.map(item => [item.identity, item]));
  const claimedDuties = new Set(observed.obligations.map(item => JSON.stringify([item.identity, item.semanticDigest])));
  const firstCompletion = new Map(observed.completions.map(item => [item.identity, item]));
  for (const actual of observed.completions) {
    const truth = duties.get(actual.identity);
    if (actual.disposition !== "OBSERVED") continue;
    if (!truth || actual.postconditionDigest !== truth.postconditionDigest || !actual.observedAt || !actual.witnessDigest) {
      falseCompletions.add(actual.identity); continue;
    }
    if (claimedDuties.has(JSON.stringify([truth.identity, truth.semanticDigest]))
        && Date.parse(actual.observedAt) <= Date.parse(truth.deadlineAt)) timely.add(truth.identity);
  }
  for (const truth of expected.obligations) if (!timely.has(truth.identity)) {
    const actual = firstCompletion.get(truth.identity);
    completionGaps.push({ identity: truth.identity, reason: actual?.disposition === "OBSERVED"
      ? "LATE_OR_WRONG_MEANING_OR_UNWITNESSED" : actual?.disposition ?? "OMITTED" });
  }
  const criticalMisses = expected.obligations.filter(item => item.critical && !timely.has(item.identity)).map(item => item.identity);
  const recognized = new Set<string>(), changeGaps: Array<{ identity: string; reason: string }> = [];
  const actualChanges = new Map<string, Observed["changes"]>();
  for (const item of observed.changes) actualChanges.set(item.identity, [...(actualChanges.get(item.identity) ?? []), item]);
  for (const truth of expected.changes) {
    const actual = actualChanges.get(truth.identity) ?? [];
    if (actual.some(item => item.recognizedAt && item.witnessDigest
        && Date.parse(item.recognizedAt) >= Date.parse(truth.availableAt)
        && Date.parse(item.recognizedAt) - Date.parse(truth.availableAt) <= 120000)) recognized.add(truth.identity);
    else changeGaps.push({ identity: truth.identity, reason: actual.length ? "LATE_OR_UNWITNESSED" : "OMITTED" });
  }
  const completion = { expected: expected.obligations.length, withinDeadline: timely.size,
    rate: expected.obligations.length ? timely.size / expected.obligations.length : null,
    passed: expected.obligations.length > 0 && 100 * timely.size >= 95 * expected.obligations.length };
  const changeRecognition = { expected: expected.changes.length, within120Seconds: recognized.size,
    rate: expected.changes.length ? recognized.size / expected.changes.length : null,
    passed: expected.changes.length > 0 && 100 * recognized.size >= 95 * expected.changes.length };
  const acceptedBusinessWeight = expected.obligations.filter(item => timely.has(item.identity))
    .reduce((sum, item) => sum + item.fixedBusinessWeight, 0);
  return { schema: "finnor.x1.environment-score.v1", mapping, obligation, completion, changeRecognition,
    criticalMisses, falseCompletions: [...falseCompletions], violations: observed.violations,
    completionGaps, changeGaps, acceptedBusinessWeight,
    originalBusinessWeight: expected.obligations.reduce((sum, item) => sum + item.fixedBusinessWeight, 0),
    transportLagMs: expected.changes.map(item => Date.parse(item.availableAt) - Date.parse(item.occurredAt)),
    performancePassed: mapping.passed && obligation.passed && completion.passed && changeRecognition.passed
      && criticalMisses.length === 0 && falseCompletions.size === 0 && observed.violations.length === 0,
    basis: "REGISTERED_INDEPENDENT_LEDGER_RELATIVE", authorityGranted: false };
}
