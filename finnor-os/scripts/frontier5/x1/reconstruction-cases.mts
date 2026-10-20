import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { proposeInstitutionModel } from "../../../packages/private-equity/src/institution-program/reconstruction";

const load = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const original = load<OriginalInstitutionEvidence>("./reference/original-input.json");
const profile = DigitalInstitutionProfile.parse(load<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
// Existing independent expectation ledger was fixed before the producer exists.
const ledger = load<{ denominators: { materialMappings: number; supportedObligations: number } }>("./reference/expected-ledger.json");
const proposal = await proposeInstitutionModel(original, profile);
assert.equal(proposal.coverage.length, original.sources.length);
assert.equal(proposal.mappings.length, ledger.denominators.materialMappings);
assert.equal(proposal.obligations.length, ledger.denominators.supportedObligations);
assert.equal(proposal.contradictions.length, 1);
assert.equal((await independentlyCheckInstitutionModel(original, proposal, profile)).disposition, "ACCEPTED_DEVELOPMENT");
const sameName = structuredClone(original);
sameName.canonical.entities[1]!.registrationId = "FIRM-100";
const uncertain = await proposeInstitutionModel(sameName, profile);
assert.equal(uncertain.mappings.length, 0, "Colliding identities must not become settled mappings");
assert.ok(uncertain.unresolved?.some((item) => item.reason === "AMBIGUOUS_CANONICAL_IDENTITY"));
console.log(JSON.stringify({ basis: "original source and independently frozen expectations",
  acceptedMappings: proposal.mappings.length, duties: proposal.obligations.length,
  unresolvedCollision: uncertain.unresolved?.length }));
