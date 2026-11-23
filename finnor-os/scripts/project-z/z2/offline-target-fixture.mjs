#!/usr/bin/env node
// Z2 guarded native replay — offline binding-validation fixture generator.
//
// Emits a schema-valid native-replay target whose cryptographic bindings
// (source-final map, build receipt hash, install receipt digests) are taken
// verbatim from a real whole-owner evidence directory, and whose operational
// fields (actors, cases, reservations, process identities, ports, issuers)
// are inert fixture bytes. The generated target exists ONLY to exercise the
// offline `--validate-target` binding path of native-replay.mjs, which never
// starts services, never touches a database, Auth, Work, or any port.
//
// This file is not authorization: validationOnly is mandatory and all five
// execution grants are false. The driver refuses these bytes in execution
// mode before any operational lookup. See the offline isolation/rebuild
// failure contract for the exact non-claims.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { resolve, isAbsolute, relative, dirname, basename } from "node:path";

const args = process.argv.slice(2), option = name => args[args.indexOf(name)+1];
const dir = args.includes("--whole-owner") && option("--whole-owner");
const output = args.includes("--output") && option("--output");
const expiresIn = Number(args.includes("--expires-in-seconds") ? option("--expires-in-seconds") : 7200);
assert(dir && isAbsolute(dir), "Z2_OFFLINE_FIXTURE_WHOLE_OWNER_REQUIRED");
assert(output && isAbsolute(output), "Z2_OFFLINE_FIXTURE_ABSOLUTE_OUTPUT_REQUIRED");
assert(Number.isSafeInteger(expiresIn) && expiresIn >= 60 && expiresIn <= 86400, "Z2_OFFLINE_FIXTURE_EXPIRY_BOUND");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) :
  Array.isArray(value) ? "["+value.map(canonical).join(",")+"]" :
    "{"+Object.keys(value).sort().map(key => JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}";
const digest = value => hash(canonical(value));

const root = await realpath(resolve(dir));
const pack = await realpath(resolve(root, "pack"));
const outputPath = resolve(await realpath(dirname(output)), basename(output));
const outputRelative = relative(pack, outputPath);
const insidePack = !isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith("../");
assert(!insidePack, "Z2_OFFLINE_FIXTURE_OUTPUT_OUTSIDE_PACK_REQUIRED");
assert((await stat(resolve(root, "install-report.json"))).isFile(), "Z2_OFFLINE_FIXTURE_RECEIPT_REQUIRED");

const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const receipt = await readJson(resolve(root, "install-report.json"));
assert.equal(receipt.schema, "finnor.project-z.z2.whole-owner-install.v1", "Z2_OFFLINE_FIXTURE_RECEIPT_SCHEMA");
assert.equal(receipt.engineeringStatus, "PASSED", "Z2_OFFLINE_FIXTURE_RECEIPT_NOT_PASSED");
assert.equal(await realpath(receipt.installedRoot), pack, "Z2_OFFLINE_FIXTURE_INSTALLED_ROOT_MISMATCH");
const sourceFinal = await readJson(resolve(root, "source-final-sha256.json"));
assert.equal(Object.keys(sourceFinal).length, receipt.sourceFileCount, "Z2_OFFLINE_FIXTURE_SOURCE_COUNT_MISMATCH");
assert.equal(digest(sourceFinal), receipt.sourceDigest, "Z2_OFFLINE_FIXTURE_SOURCE_DIGEST_BINDING");

const fixtureDigest = label => hash("z2-offline-binding-fixture:"+label);
const u = n => `0f2a00${String(n).padStart(2, "0")}-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const actors = [1, 2, 3, 4].map(n => ({ userId: u(10+n), principalId: u(20+n),
  emailEnvironmentName: `Z2_OFFLINE_FIXTURE_ACTOR_${n}_EMAIL`,
  passwordEnvironmentName: `Z2_OFFLINE_FIXTURE_ACTOR_${n}_PASSWORD` }));
const kinds = ["CLAIM", "CHECKPOINT", "ARTIFACT", "PARTIAL_CONSENT"];
const cases = kinds.map((kind, index) => {
  const request = { workId: u(30+index), fixture: "z2-offline-binding-validation",
    note: `Offline binding validation fixture case for ${kind}; no live Work object exists.` };
  return { id: `offline-${kind.toLowerCase().replaceAll("_", "-")}`, recovery: kind, request,
    originalRequestDigest: digest(request),
    expectedOriginalUtilitiesDigest: fixtureDigest(`utilities-${kind}`),
    expectedInternalEffectDigest: fixtureDigest(`effect-${kind}`),
    expectedInternalEffectKind: "NO_EFFECT",
    reservation: { ref: { owner: "z2-offline-fixture", id: `reservation-${kind.toLowerCase()}`, version: "1",
      contentDigest: fixtureDigest(`reservation-${kind}`) }, expectedRevision: 1 },
    actionByInformationKey: { "0": "z2-offline-fixture-action" },
    canonicalObservations: [{ actorIndex: index, observation: { date: 0, key: "fixture-presence",
      value: "observed", classification: "SOURCED_FACT",
      source: { kind: "z2-offline-fixture", note: "offline binding validation only; no live claim" } } }] };
});
const preexistingNegativeCases = [
  { kind: "STALE_SOURCE", actorIndex: 0, operation: "interaction-admit",
    input: { fixture: "stale-source" }, httpStatuses: [409], expectedCodeOrStatus: "Z2_OFFLINE_FIXTURE_STALE_SOURCE" },
  { kind: "REVOKED_RIGHTS", actorIndex: 1, operation: "interaction-action",
    input: { fixture: "revoked-rights" }, httpStatuses: [403], expectedCodeOrStatus: "Z2_OFFLINE_FIXTURE_REVOKED_RIGHTS" },
  { kind: "CROSS_TENANT", actorIndex: 2, operation: "interaction-read",
    input: { fixture: "cross-tenant" }, httpStatuses: [404], expectedCodeOrStatus: "Z2_OFFLINE_FIXTURE_CROSS_TENANT" },
  { kind: "RESOURCE_BOUND", actorIndex: 3, operation: "coalition-submit",
    input: { fixture: "resource-bound" }, httpStatuses: [422], expectedCodeOrStatus: "Z2_OFFLINE_FIXTURE_RESOURCE_BOUND" },
  { kind: "UNSUPPORTED", actorIndex: 0, operation: "interaction-read",
    input: { protocolId: u(40) }, httpStatuses: [200], expectedCodeOrStatus: "UNSUPPORTED" },
  { kind: "INCOMPLETE", actorIndex: 1, operation: "interaction-read",
    input: { protocolId: u(41) }, httpStatuses: [200], expectedCodeOrStatus: "INCOMPLETE" }
];
const target = {
  schema: "finnor.project-z.z2.native-replay-target.v1",
  validationOnly: true,
  authorization: { explicitDisposableExecution: false, noDatabaseInitialization: true,
    noGrantsOrProvisioning: true, noExternalOrFinancialEffects: true, realAuthOnly: true,
    ownedWorkerKillAndSameBuildRestart: false, exclusiveNativeReplayDatabase: false,
    consumeOriginalRemainingConstructionBudget: false, leaveOwnedWorkerStoppedAfterReplay: false,
    expiresAt: new Date(Date.now()+expiresIn*1000).toISOString() },
  origin: "http://127.0.0.1:38710", apiOrigin: "http://127.0.0.1:38711",
  frontendAuthIssuer: "https://z2-offline-fixture.invalid/", apiAuthIssuer: "https://z2-offline-fixture.invalid/",
  sourceRoot: pack, sourceSha256: sourceFinal,
  buildReceiptPath: resolve(root, "install-report.json"),
  buildReceiptSha256: hash(await readFile(resolve(root, "install-report.json"))),
  tenantId: u(0),
  database: { environmentName: "Z2_OFFLINE_FIXTURE_DATABASE_URL", host: "127.0.0.1", port: 55439,
    name: "z2_offline_fixture" },
  worker: { pid: 2, startTicks: "0", cmdlineSha256: fixtureDigest("worker-cmdline"), coupledSupervisor: false },
  processes: { api: { pid: 2, startTicks: "0", cmdlineSha256: fixtureDigest("api-cmdline") },
    frontend: { pid: 2, startTicks: "0", cmdlineSha256: fixtureDigest("frontend-cmdline") } },
  actors, cases, preexistingNegativeCases
};
await writeFile(outputPath, JSON.stringify(target, null, 2)+"\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ output: outputPath, pack, sourceDigest: receipt.sourceDigest,
  sourceFileCount: receipt.sourceFileCount, expiresAt: target.authorization.expiresAt,
  offlineOnly: true, executionAuthority: false }, null, 2));
