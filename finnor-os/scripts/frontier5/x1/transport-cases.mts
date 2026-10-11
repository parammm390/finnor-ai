import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { checkInstitutionInSeparateProcess } from "../../../packages/private-equity/src/institution-program/checker-process";

const load = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const profile = DigitalInstitutionProfile.parse(load<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
const original = load<OriginalInstitutionEvidence>("./reference/original-input.json");
const base = load<InstitutionCandidate>("./reference/base-candidate.json");
// Six individually valid original JSON objects jointly occupy the exact
// registered 32 MiB raw population. Newlines demand JSON escaping, while
// the canonical snapshot consumes exactly 8 MiB in the same process call.
const size = profile.bounds.rawBytes;
original.sources = Array.from({ length: 6 }, (_, index) => {
  const length = Math.floor(size / 6) + (index < size % 6 ? 1 : 0);
  return { ...original.sources[0]!, id: `source-${index}`, sourceClass: "crm_deals", protocol: "json_records",
    rawUtf8: "[]" + "\n".repeat(length - 2),
    coverage: { complete: true, expectedObjectIds: [], readObjectIds: [] } };
});
original.canonical.entities = [{ ref: "",
  entityType: "deal", registrationId: "FIRM-100", institutionId: original.institutionId }];
original.canonical.entities[0]!.ref = "x".repeat(profile.bounds.s1SnapshotBytes
  - Buffer.byteLength(JSON.stringify(original.canonical)));
assert.equal(Buffer.byteLength(JSON.stringify(original.canonical)), profile.bounds.s1SnapshotBytes);
original.mandate.rules = [];
original.current.sourceRevisions = Object.fromEntries(original.sources.map((item) => [item.id, item.revision]));
const candidate: InstitutionCandidate = { ...base, coverage: original.sources.map((item) => item.id),
  mappings: [], quantities: [], contradictions: [], obligations: [], receipt: null,
  limits: Object.fromEntries(Object.keys(profile.bounds).map((key) => [key, null])),
  dependencies: { ...original.current, sourceRevisions: original.current.sourceRevisions } };
const encodedBytes = Buffer.byteLength(JSON.stringify({ original, candidate, profile }));
assert.ok(encodedBytes > 48 * 1024 * 1024, "This case must exceed the defective framing bound");
const result = checkInstitutionInSeparateProcess(original, candidate, profile);
assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
console.log(JSON.stringify({ basis: "full frozen original raw and canonical populations, separate pinned checker",
  rawBytes: size, canonicalBytes: profile.bounds.s1SnapshotBytes, encodedBytes, disposition: result.disposition }));
