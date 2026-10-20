import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { proposeInstitutionModel } from "../../../packages/private-equity/src/institution-program/reconstruction";
import { checkInstitutionInSeparateProcess } from "../../../packages/private-equity/src/institution-program/checker-process";

const read = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const original = read<OriginalInstitutionEvidence>("./reference/native-input.json");
const expected = read<{ classes: Record<string, { protocol: string; object: string; identity: string; trigger?: string; relation?: string; relationTarget?: string }> }>("./reference/native-expectations.json");
const profile = DigitalInstitutionProfile.parse(read<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
assert.equal(original.sources.length, Object.keys(expected.classes).length);
for (const source of original.sources) {
  assert.equal(source.protocol, expected.classes[source.sourceClass]!.protocol);
  assert.deepEqual(source.coverage.expectedObjectIds, [expected.classes[source.sourceClass]!.object]);
  assert.doesNotMatch(source.rawUtf8, /X-Institution|registrationId|entityType|triggerKind|factKey|"kind"/i);
}
const candidate = await proposeInstitutionModel(original, profile);
const check = await independentlyCheckInstitutionModel(original, candidate, profile);
assert.equal(check.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(check));
const separated = checkInstitutionInSeparateProcess(original, candidate, profile);
assert.deepEqual(separated, check, "Separate original-byte checker must agree exactly on pinned development input");
assert.equal(candidate.obligations.length, 1, "Only the task and explicit mandate yield a duty");
assert.equal(candidate.obligations[0]?.trigger, "work-native/task-7");
assert.ok(candidate.relations?.some((item) => item.sourceId === "crm-native"
  && item.relation === "counterparty" && item.targetRef === "party:party-9@v1"));
assert.ok(candidate.processHypotheses?.some((item) => item.witness === "mail-native/mail-7" && !item.normative));
assert.ok(candidate.unresolved?.some((item) => item.witness === "mail-native/mail-7"), "Email request cannot grant approval");
console.log(JSON.stringify({ basis: "independent class-native corpus", classes: original.sources.map((item) => item.sourceClass),
  mappings: candidate.mappings.length, quantities: candidate.quantities.length, duties: candidate.obligations.length,
  unresolved: candidate.unresolved?.length, check }));
