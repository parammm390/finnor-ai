/** Actual old/new installed artifact readers, not reconstructed current authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2), options = {};
assert.equal(argv.length, 8, "EXACT_COMPATIBILITY_ARGUMENTS_REQUIRED");
for (let index = 0; index < argv.length; index += 2) {
  assert(["--packet", "--fresh-installation", "--fresh-native", "--output"].includes(argv[index]));
  assert(!options[argv[index]] && argv[index + 1]?.startsWith("/"));
  options[argv[index]] = argv[index + 1];
}
const hash = async path => {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
};
const json = async path => JSON.parse(await readFile(path, "utf8"));
const inside = (root, name) => {
  assert(typeof name === "string" && name && !name.startsWith("/") && !name.includes("\\"));
  assert(name.split("/").every(part => part && part !== "." && part !== ".."), "CANONICAL_INSTALLED_PATH_REQUIRED");
  const path = resolve(root, name);
  assert(!relative(root, path).split(sep).includes(".."), "DECLARED_INSTALLATION_PATH_REQUIRED");
  return path;
};
const report = { schema: "finnor.w2.installed-artifact-compatibility.v1", status: "FAIL", directions: [],
  qualification: "HISTORICAL_ARTIFACT_READER_COMPATIBILITY_NOT_FRESH_CURRENT_USE_AUTHORITY",
  nativeSemanticValidity: "ORIGINAL_AUTHENTICATED_RUNTIME_RECEIPTS_ONLY",
  compilerInputFabricated: false, genuineHumanQualified: false, protectedQualification: false };
try {
  const packetPath = options["--packet"], packet = await json(packetPath);
  assert.equal(packet.schema, "finnor.w2.sealed-cold-packet.v1");
  const oldRoot = await realpath(packet.baseline.installationRoot);
  const freshRoot = await realpath(options["--fresh-installation"]);
  assert.notEqual(oldRoot, freshRoot, "TWO_DISTINCT_ACTUAL_INSTALLATIONS_REQUIRED");
  const load = async (root, native, expectedManifestHash) => {
    const manifestPath = join(root, "finnor-os/w2-development-installation.json");
    const manifest = await json(manifestPath), manifestHash = await hash(manifestPath);
    assert.equal(manifest.schema, "finnor.postz.w2.development-installation.v1");
    assert.equal(manifest.productionActive, false);
    if (expectedManifestHash) assert.equal(manifestHash, expectedManifestHash);
    const [receipt, freeze, positive, cleanup, custody] = await Promise.all([
      json(join(native, "report.json")), json(join(native, "freeze.json")),
      json(join(native, "positive-original-owner-chain.json")), json(join(native, "cleanup.json")),
      json(join(native, "installed-source-custody-byte-change-and-restoration.json")),
    ]);
    assert.equal(receipt.status, "PASS"); assert.equal(receipt.installedRuntime, true);
    assert.equal(receipt.actualOrdinaryAuthentication, true); assert.equal(receipt.actualRestrictedRoles, true);
    assert(receipt.results.length && receipt.results.every(row => row.status === "PASS"));
    assert.equal(freeze.installation?.manifestSha256, manifestHash);
    for (const name of ["commit", "tree"]) assert.equal(freeze.source[name], manifest.source[name]);
    assert.equal(cleanup.status, "PASS"); assert(cleanup.steps.length && cleanup.steps.every(row => row.status === "PASS"));
    assert.equal(positive.completed?.currentCheck?.valid, true);
    const original = manifest.files.find(row => row.path === custody.target);
    assert(original && original.sha256 === custody.originalSha256, "ORIGINAL_INSTALLED_CUSTODY_PIN_REQUIRED");
    assert.equal(custody.refusalStatus, 503); assert.equal(custody.restoredStatus, 200);
    assert.equal(custody.sourceRestoredExactly, true); assert.equal(custody.originalManifestUnchanged, true);
    assert(receipt.results.some(row => row.id === "installed-owner-byte-mismatch-refusal-and-exact-restoration"
      && row.status === "PASS"), "ACTUAL_NATIVE_CUSTODY_CONTROL_PASS_REQUIRED");
    assert(positive.completed.program.assignments.length
      && positive.completed.program.assignments.every(row => row.state.kind === "CLOSED"));
    for (const name of manifest.checkerPins) {
      const entry = manifest.files.find(row => row.path === name);
      assert(entry, "CHECKER_PIN_DECLARATION_REQUIRED");
      const file = inside(root, name), mode = await lstat(file);
      assert(mode.isFile() && !mode.isSymbolicLink());
      assert.equal(await hash(file), entry.sha256);
    }
    const entry = inside(root, manifest.entrypoints.checker);
    assert(manifest.files.some(row => row.path === manifest.entrypoints.checker));
    const reader = await import(pathToFileURL(entry).href);
    for (const name of ["parseWorkforceExecutionProgram", "workforceDigest", "workforceProgramGraph"])
      assert.equal(typeof reader[name], "function", "ACTUAL_INSTALLED_READER_EXPORT_REQUIRED");
    return { reader, program: positive.completed.program, manifestHash, source: manifest.source,
      nativePositiveHash: await hash(join(native, "positive-original-owner-chain.json")) };
  };
  // The baseline receipts were copied and individually pinned during sealing.
  // Materialize their original names in a new private interchange-only folder.
  const { mkdir, copyFile } = await import("node:fs/promises");
  const baseline = join(options["--output"], "baseline-receipts");
  await mkdir(baseline, { mode: 0o700 });
  for (const [key, name] of [["nativeReport", "report.json"], ["nativeFreeze", "freeze.json"],
    ["nativePositive", "positive-original-owner-chain.json"], ["nativeCleanup", "cleanup.json"],
    ["nativeCustody", "installed-source-custody-byte-change-and-restoration.json"]]) {
    const path = inside(resolve(packetPath, ".."), packet.baseline[key].path);
    assert.equal(await hash(path), packet.baseline[key].sha256);
    await copyFile(path, join(baseline, name), 1);
  }
  const old = await load(oldRoot, baseline, packet.baseline.manifest.sha256);
  const fresh = await load(freshRoot, options["--fresh-native"]);
  for (const name of ["commit", "tree"]) assert.equal(fresh.source[name], packet.source.identity[name]);
  for (const [label, producer] of [["OLD", old], ["FRESH", fresh]]) {
    const parsedOld = old.reader.parseWorkforceExecutionProgram(producer.program);
    const parsedFresh = fresh.reader.parseWorkforceExecutionProgram(producer.program);
    assert.deepEqual(parsedOld, parsedFresh, "ACTUAL_ARTIFACT_READERS_DISAGREE");
    const oldDigest = old.reader.workforceDigest(parsedOld), freshDigest = fresh.reader.workforceDigest(parsedFresh);
    assert.equal(oldDigest, freshDigest, "ACTUAL_ARTIFACT_DIGEST_CODEC_DISAGREES");
    assert.deepEqual(old.reader.workforceProgramGraph(parsedOld), fresh.reader.workforceProgramGraph(parsedFresh));
    for (const reader of [old.reader, fresh.reader])
      assert.throws(() => reader.parseWorkforceExecutionProgram({ ...producer.program,
        schema: "finnor.workforce-execution-program.v999" }), "ACTUAL_VERSION_REFUSAL_REQUIRED");
    report.directions.push({ producer: label, oldReader: "PASS", freshReader: "PASS",
      programmeDigest: oldDigest, graphEqual: true, changedVersionRejectedByBoth: true,
      nativePositiveSha256: producer.nativePositiveHash });
  }
  report.installations = { old: old.manifestHash, fresh: fresh.manifestHash };
  report.status = "PASS";
} catch (error) {
  report.failure = { type: error?.name ?? "Error", code: "ACTUAL_INSTALLED_READER_COMPATIBILITY_FAILED" };
  process.exitCode = 1;
}
await writeFile(join(options["--output"], "compatibility.json"), JSON.stringify(report, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: report.status, directions: report.directions.length,
  qualification: report.qualification }));
