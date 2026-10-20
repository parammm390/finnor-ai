import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { proposeInstitutionModel } from "../../../packages/private-equity/src/institution-program/reconstruction";
const read = <T>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const profile = DigitalInstitutionProfile.parse(read<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
const original = read<OriginalInstitutionEvidence>("./reference/native-input.json");
const crm = original.sources.find((source) => source.sourceClass === "crm_deals")!;
const rows = [
  { id: "fund-7", fundNumber: "FUND-7", fundName: "Fund Seven" },
  { id: "vehicle-8", vehicleNumber: "VEH-8", vehicleName: "Vehicle Eight", fundNumber: "FUND-7",
    vehicleType: "feeder", effectiveFrom: "2026-09-01T00:00:00.000Z" },
];
crm.protocol = "json_records";
crm.rawUtf8 = JSON.stringify(rows);
crm.coverage = { complete: true, expectedObjectIds: rows.map((row) => row.id), readObjectIds: rows.map((row) => row.id) };
original.canonical.entities = [
  { ref: "pe_fund:11111111-1111-4111-8111-111111111111@v1", registrationId: "FUND-7",
    entityType: "fund", institutionId: original.institutionId },
  { ref: "pe_vehicle:22222222-2222-4222-8222-222222222222@v1", registrationId: "VEH-8",
    entityType: "vehicle", institutionId: original.institutionId },
];
original.canonical.revision = "creation-canonical-v1";
original.current.canonicalRevision = original.canonical.revision;
original.sources = [crm];
original.current.sourceRevisions = { [crm.id]: crm.revision };
original.current.sourceDigests = undefined;
original.mandate.rules = [];
original.current.authorizedOperations = [];
const candidate = await proposeInstitutionModel(original, profile);
assert.deepEqual(candidate.mappings.map((entry) => entry.registrationId).sort(), ["FUND-7", "VEH-8"]);
assert.deepEqual(candidate.relations?.map((entry) =>
  [entry.registrationId, entry.relation, entry.targetRegistrationId, entry.validFrom]),
  [["VEH-8", "fund_vehicle", "FUND-7", "2026-09-01T00:00:00.000Z"]]);
const checked = await independentlyCheckInstitutionModel(original, candidate, profile);
assert.equal(checked.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(checked));
// An independently typed Fund identifier may also occur on a Deal. The raw
// fundNumber/entity kind still identifies the Fund; a registration-only lookup
// must not turn it into ambiguity across distinct canonical vocabularies.
const crossKind=structuredClone(original);
crossKind.canonical.entities.push({ref:"pe_deal:33333333-3333-4333-8333-333333333333@v1",
  registrationId:"FUND-7",entityType:"deal",institutionId:original.institutionId});
const crossKindCandidate=structuredClone(candidate);
const crossKindCheck=await independentlyCheckInstitutionModel(crossKind,crossKindCandidate,profile);
console.log(JSON.stringify({case:"cross-kind identity",check:crossKindCheck}));
assert.equal(crossKindCheck.disposition,
  "ACCEPTED_DEVELOPMENT","typed original identity cannot be confused by another entity kind");
console.log(JSON.stringify({ case: "class-native fund/vehicle relation", disposition: checked.disposition }));
