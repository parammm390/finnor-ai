import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";

const read = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const baseline = read<OriginalInstitutionEvidence>("./reference/original-input.json");
const base = read<InstitutionCandidate>("./reference/base-candidate.json");
const profile = DigitalInstitutionProfile.parse(read<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
const frozen = read<{ adversarial: Record<string, string> }>("./reference/native-expectations.json").adversarial;
const copy = () => ({ original: structuredClone(baseline), candidate: structuredClone(base) });
const cases: Record<string, ReturnType<typeof copy>> = {};

{
  const test = copy(); const raw = JSON.parse(test.original.sources[0]!.rawUtf8);
  raw[0].id = "part/deal-A";
  test.original.sources[0]!.rawUtf8 = JSON.stringify(raw);
  test.original.sources[0]!.coverage = { complete: true, expectedObjectIds: ["part/deal-A", "deal-B"], readObjectIds: ["part/deal-A", "deal-B"] };
  test.candidate.mappings[0]!.sourceId = "crm-1/part";
  cases.sourceRecordCollision = test;
}
{
  const test = copy(); const source = test.original.sources[2]!;
  const rows = JSON.parse(source.rawUtf8);
  rows[0].id = "request-A#extra"; rows[1].id = "request-A"; source.rawUtf8 = JSON.stringify(rows);
  source.coverage = { complete: true, expectedObjectIds: ["request-A#extra", "request-A"], readObjectIds: ["request-A#extra", "request-A"] };
  test.original.mandate.rules[0]!.id = "rule";
  test.original.mandate.rules.push({ ...test.original.mandate.rules[0]!, id: "extra#rule" });
  test.candidate.obligations = [
    { ...base.obligations[0]!, trigger: "work-1/request-A#extra", ruleId: "extra#rule" },
    { ...base.obligations[1]!, trigger: "work-1/request-A", ruleId: "rule" },
    { ...base.obligations[1]!, trigger: "work-1/request-A", ruleId: "extra#rule" },
  ];
  cases.triggerRuleCollisionWithFourthDutyOmitted = test;
}
{
  const test = copy(), ledger = test.original.sources[1]!;
  const rows = JSON.parse(ledger.rawUtf8);
  for (const row of rows) { row.currency = 123; row.unit = 1; }
  ledger.rawUtf8 = JSON.stringify(rows);
  for (const row of test.candidate.quantities) { (row as unknown as { currency: unknown }).currency = 123; (row as unknown as { unit: unknown }).unit = 1; }
  cases.numericCurrencyAndUnit = test;
}
{
  const test = copy();
  const rows = Array.from({ length: 101 }, (_, i) => ({
    id: `op-${i}`, kind: "entity", entityType: "deal", registrationId: `CORP-${i}`,
  }));
  test.original.sources = [{ ...test.original.sources[0]!, rawUtf8: JSON.stringify(rows),
    coverage: { complete: true, expectedObjectIds: rows.map((row) => row.id), readObjectIds: rows.map((row) => row.id) } }];
  test.original.current.sourceRevisions = { "crm-1": "r1" };
  test.original.canonical.entities = rows.map((row) => ({
    ref: `pe_deal:${row.id}@v1`, entityType: "deal", registrationId: row.registrationId, institutionId: baseline.institutionId,
  }));
  test.original.mandate.rules = [];
  test.candidate.coverage = ["crm-1"]; test.candidate.dependencies.sourceRevisions = { "crm-1": "r1" };
  test.candidate.mappings = rows.map((row) => ({ sourceId: "crm-1", recordId: row.id,
    canonicalRef: `pe_deal:${row.id}@v1`, registrationId: row.registrationId }));
  test.candidate.quantities = []; test.candidate.obligations = []; test.candidate.contradictions = [];
  test.candidate.limits = Object.fromEntries(Object.keys(profile.bounds).map((name) => [name, 0]));
  // The measured population is 101, irrespective of the producer's counters.
  cases.canonical101Deals = test;
}
{
  const test = copy(); const reversed = Object.entries(test.candidate.dependencies.sourceRevisions).reverse();
  test.candidate.dependencies.sourceRevisions = Object.fromEntries(reversed);
  test.candidate.obligations = test.candidate.obligations.map((item) => Object.fromEntries(Object.entries(item).reverse()) as typeof item);
  cases.semanticKeyOrder = test;
}
{
  const test = copy();
  const refreshed = test.original.sources[0]!.rawUtf8.replace('"name":"Harbor"', '"name":"Harbor refreshed"');
  const sourceDigests = { "crm-1": createHash("sha256").update(refreshed).digest("hex") };
  test.original.sources[0]!.revision = "r2"; test.original.current.sourceRevisions["crm-1"] = "r2";
  test.candidate.dependencies.sourceRevisions["crm-1"] = "r2";
  test.original.current.sourceDigests = sourceDigests;
  test.candidate.dependencies.sourceDigests = sourceDigests;
  // Actual current owner byte pin differs despite refreshed, matching metadata labels.
  cases.staleOriginalWithRefreshedLabels = test;
}

const observations: Record<string, string> = {};
for (const [name, { original, candidate }] of Object.entries(cases)) {
  const check = await independentlyCheckInstitutionModel(original, candidate, profile);
  observations[name] = check.disposition === "REJECTED" ? check.guard : "ACCEPTED";
}
console.log(JSON.stringify({ basis: "independent checker-001 counterexamples", expected: frozen, observed: observations }));
for (const name of Object.keys(cases)) {
  assert.equal(observations[name], frozen[name], `${name} reached wrong boundary`);
}
