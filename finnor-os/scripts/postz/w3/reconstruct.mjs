/** Fresh packet reconstruction. Never borrows a donor checkout, Git objects or
 * dependency tree, never deletes an existing output and never claims field truth. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, readdirSync, statfsSync, openSync, closeSync } from "node:fs";
import { resolve, join, dirname, isAbsolute, basename, sep } from "node:path";

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === "--source" && args[2] === "--output"
  && isAbsolute(args[1]) && isAbsolute(args[3]), "W3_ABSOLUTE_SOURCE_PACKET_AND_NEW_OUTPUT_REQUIRED");
const packet = resolve(args[1]), output = resolve(args[3]);
assert(!existsSync(output), "W3_RECONSTRUCTION_OUTPUT_MUST_BE_NEW");
const source = JSON.parse(readFileSync(join(packet, "source.json"), "utf8"));
assert.equal(source.schema, "finnor.w3.source-preimage.v1");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.version, source.node.version);
assert.equal(hash(readFileSync(process.execPath)), source.node.binarySha256);
assert.equal(process.platform, source.node.platform); assert.equal(process.arch, source.node.arch);
const preimages = source.buildPrerequisites;
assert.equal(preimages?.schema, "finnor.w3.build-preimages.v1", "W3_PACKET_OWNED_BUILD_PREIMAGES_REQUIRED");
assert.equal(preimages.builder.path, "finnor-os/scripts/frontier5/x1/build-development.mjs");
assert(/^[a-f0-9]{64}$/.test(preimages.builder.sha256)
  && /^[a-f0-9]{40}$/.test(preimages.historical.commit) && /^[a-f0-9]{40}$/.test(preimages.historical.tree));
assert.equal(preimages.deduplicatedAgainstSourceTree, true); assert.equal(preimages.parentHistoryIncluded, false);
assert(Array.isArray(preimages.objects) && preimages.objects.length > 0 && preimages.objects.length <= 16384);
assert(preimages.objects.every(object => /^[a-f0-9]{40}$/.test(object.id)
  && ["blob", "tree", "commit"].includes(object.type) && Number.isSafeInteger(object.bytes) && object.bytes >= 0
  && (object.type !== "commit" || object.id === preimages.historical.commit)));
assert.equal(new Set(preimages.objects.map(object => object.id)).size, preimages.objects.length);
assert(preimages.objects.reduce((sum, object) => sum + object.bytes, 0) <= 64 * 1024 * 1024);
assert.equal(preimages.pack.path, "build-preimages.pack");
assert(Number.isSafeInteger(preimages.pack.bytes) && preimages.pack.bytes > 0 && preimages.pack.bytes <= 64 * 1024 * 1024);
for (const pin of [source.archive, source.commitObject, preimages.pack]) {
  assert.equal(basename(pin.path), pin.path);
  const bytes = readFileSync(join(packet, pin.path));
  assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
}
const object = readFileSync(join(packet, source.commitObject.path));
assert.equal(createHash("sha1").update(Buffer.concat([Buffer.from("commit " + object.length + "\0"), object])).digest("hex"), source.commit);
assert.equal(/^tree ([a-f0-9]{40})$/m.exec(object.toString())?.[1], source.tree);
const archive = join(packet, source.archive.path);
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 16777216 }).trim().split("\n");
assert(entries.every(path => path && !path.startsWith("/") && !path.includes("\\")
  && !path.split("/").some(part => ["..", ".git", "node_modules", ".next"].includes(part))));
const kinds = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 16777216 }).trim().split("\n");
assert(kinds.every(line => line.startsWith("-") || line.startsWith("d")), "W3_ONLY_REGULAR_SOURCE_PACKET_ENTRIES");
mkdirSync(output, { mode: 0o700 });
const checkout = join(output, "source"), evidence = join(output, "evidence"), temporary = join(output, "tmp");
for (const path of [checkout, evidence, temporary]) mkdirSync(path, { mode: 0o700 });
execFileSync("tar", ["-xzf", archive, "-C", checkout]);
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 16777216, timeout: 30000 }).trim();
git("init", "--quiet", "-b", "reconstructed-w3"); git("add", "--force", "--all");
assert.equal(git("write-tree"), source.tree, "W3_ARCHIVED_COMPLETE_TREE_PREIMAGE_REQUIRED");
assert.equal(execFileSync("git", ["-C", checkout, "hash-object", "-t", "commit", "-w", "--stdin"],
  { input: object, encoding: "utf8" }).trim(), source.commit);
const builder = readFileSync(join(checkout, preimages.builder.path));
assert.equal(hash(builder), preimages.builder.sha256, "W3_REUSED_BUILDER_PREIMAGE_CHANGED");
const references = [...builder.toString().matchAll(/^const base = '([a-f0-9]{40})';$/gm)];
assert.equal(references.length, 1);
assert.equal(references[0][1], preimages.historical.commit, "W3_HISTORICAL_BUILD_REFERENCE_CHANGED");
writeFileSync(join(checkout, ".git/shallow"), source.commit + "\n" + preimages.historical.commit + "\n", { flag: "wx" });
const imported = execFileSync("git", ["-C", checkout, "index-pack", "--stdin"], {
  input: readFileSync(join(packet, preimages.pack.path)), encoding: "utf8", maxBuffer: 16777216, timeout: 30000,
}).trim();
const packIdentity = /^pack\t([a-f0-9]{40})$/.exec(imported);
assert(packIdentity, "W3_EXACT_IMPORTED_BUILD_PACK_REQUIRED");
const packedObjects = git("verify-pack", "-v", ".git/objects/pack/pack-" + packIdentity[1] + ".idx")
  .split("\n").flatMap(line => {
    const match = /^([a-f0-9]{40})\s+(\S+)\s+([0-9]+)\s/.exec(line);
    return match ? [{ id: match[1], type: match[2], bytes: Number(match[3]) }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
assert.deepEqual(packedObjects, [...preimages.objects].sort((a, b) => a.id.localeCompare(b.id)),
  "W3_IMPORTED_BUILD_OBJECT_POPULATION_CHANGED");
assert.equal(git("rev-parse", preimages.historical.commit + "^{tree}"), preimages.historical.tree);
const closure = revision => new Set([revision, git("rev-parse", revision + "^{tree}"),
  ...git("ls-tree", "-r", "-t", revision).split("\n").filter(Boolean).map(line => {
    const match = /^[0-9]+ (?:blob|tree) ([a-f0-9]{40})\t/.exec(line);
    assert(match, "W3_REGULAR_HISTORICAL_SOURCE_POPULATION_REQUIRED");
    return match[1];
  })]);
const archivedObjects = closure(source.commit);
assert.deepEqual([...closure(preimages.historical.commit)].filter(id => !archivedObjects.has(id)).sort(),
  preimages.objects.map(object => object.id).sort(), "W3_EXACT_ADDITIONAL_BUILD_CLOSURE_REQUIRED");
git("update-ref", "refs/heads/reconstructed-w3", source.commit);
git("update-ref", "refs/build-preimages/retained-migrations", preimages.historical.commit);
assert(!existsSync(join(checkout, ".git/objects/info/alternates")));
assert.equal(git("status", "--porcelain=v1", "-uall"), "");
git("fsck", "--connectivity-only");
for (const pin of source.locks) assert.equal(hash(readFileSync(join(checkout, pin.path))), pin.sha256);
const backend = join(checkout, "finnor-os");
const limits = JSON.parse(readFileSync(join(checkout, "scope-postz/w3-real-world-fulfillment/verification-manifest.json"), "utf8")).limits;
const commands = [], meters = [], started = Date.now();
let passed = false;
const assets = {
  uv: process.env.FINNOR_W3_UV,
  uvCache: process.env.UV_CACHE_DIR,
  pythonInstall: process.env.UV_PYTHON_INSTALL_DIR,
  pythonBin: process.env.UV_PYTHON_BIN_DIR,
  npmCache: process.env.W3_NPM_CACHE,
  browser: process.env.PLAYWRIGHT_BROWSERS_PATH,
  donorDenials: process.env.W3_DONOR_DENIALS,
};
const scientificEnvironments = [];
const inherited = JSON.parse(readFileSync(join(checkout,
  "scope-frontier5/x1-institutional-programme-compiler/verification-plan.json"), "utf8")).limits;
const env = { PATH: dirname(process.execPath) + ":" + process.env.PATH, HOME: process.env.HOME, TMPDIR: temporary,
  NODE_ENV: "test", NODE_OPTIONS: "--max-old-space-size=1536", NEXT_TELEMETRY_DISABLED: "1",
  npm_config_cache: assets.npmCache, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
  UV_CACHE_DIR: assets.uvCache, UV_PYTHON_INSTALL_DIR: assets.pythonInstall, UV_PYTHON_BIN_DIR: assets.pythonBin,
  UV_OFFLINE: "true", UV_PYTHON_DOWNLOADS: "never",
  PLAYWRIGHT_BROWSERS_PATH: assets.browser, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
function meter(step) {
  const space = statfsSync(output, { bigint: true });
  const size = execFileSync("du", ["-sk", output], { encoding: "utf8", timeout: 30000 });
  const bytes = Number(size.split(/\s+/)[0]) * 1024;
  meters.push({ step, elapsedMs: Date.now() - started, bytes, availableBytes: String(space.bavail * space.bsize) });
  assert(space.bavail * space.bsize >= BigInt(limits.minimumFreeDiskGiB) * 1024n ** 3n, "W3_COLD_MINIMUM_FREE_DISK");
  assert(bytes <= limits.maximumGeneratedDiskGiB * 1024 ** 3, "W3_COLD_GENERATED_DISK_BOUND");
  assert(Date.now() - started < limits.coldSeconds * 1000, "W3_COLD_WALL_BOUND");
}
function run(name, command, args, cwd = backend, extra = {}) {
  meter(name);
  const log = join(evidence, String(commands.length + 1).padStart(2, "0") + "-" + name + ".log");
  const fd = openSync(log, "wx"), at = Date.now();
  let result;
  const seconds = name.includes("typecheck") ? inherited.wholeTypecheckWallSeconds
    : name === "complete-installed-product-build" ? inherited.finalBuildWallSeconds
      : name.startsWith("centropy-") || name === "owner-domain-boundary" || name.endsWith("-provenance")
        ? inherited.smallCheckWallSeconds : limits.integrationSeconds;
  try {
    result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", fd, fd],
      timeout: Math.min(seconds * 1000, limits.coldSeconds * 1000 - (Date.now() - started)) });
  } finally { closeSync(fd) }
  commands.push({ name, command, args, cwd, exitCode: result.status, signal: result.signal,
    elapsedMs: Date.now() - at, secondsLimit: seconds, log, sha256: hash(readFileSync(log)),
    error: result.error ? { code: result.error.code ?? null, message: result.error.message } : null });
  assert.equal(result.status, 0, "W3_RECONSTRUCTION_STEP_FAILED:" + name);
  meter(name + "-complete");
  console.log(JSON.stringify({ step: name, status: "PASS" }));
}
try {
  assert.equal(process.platform, "linux", "W3_COLD_PROCESS_LOCAL_CONFINEMENT_PLATFORM_REQUIRED");
  for (const [name, path] of Object.entries(assets))
    assert(typeof path === "string" && isAbsolute(path) && existsSync(path), "W3_DECLARED_COLD_ASSET_REQUIRED:" + name);
  run("root-fresh-npm-ci", "npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], checkout);
  run("backend-fresh-npm-ci", "npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"]);
  const namespace = join(backend, "node_modules/@finnor");
  for (const name of readdirSync(namespace)) {
    const path = join(namespace, name);
    if (lstatSync(path).isSymbolicLink()) assert(realpathSync(path).startsWith(checkout + sep), "W3_NO_FOREIGN_WORKSPACE_LINKS");
  }
  run("native-locked-dependency-rebuild", "npm", ["rebuild", "--offline", "fs-ext", "embedded-postgres",
    "@embedded-postgres/" + process.platform + "-" + process.arch]);
  run("scientific-S3-environment", assets.uv, ["venv", "--offline", "--python", "3.11.15", ".w3-venv"]);
  run("scientific-S5-environment", assets.uv, ["venv", "--offline", "--python", "3.12.13", ".w3-s5-venv"]);
  run("scientific-S3-fresh-dependencies", assets.uv, ["pip", "install", "--offline", "--link-mode", "copy",
    "--python", ".w3-venv/bin/python", "--requirement", "scripts/postz/w3/requirements-s3.lock"]);
  run("scientific-S5-fresh-dependencies", assets.uv, ["pip", "install", "--offline", "--link-mode", "copy",
    "--python", ".w3-s5-venv/bin/python", "--requirement", "packages/epistemic-runtime/src/requirements-s5.txt"]);
  for (const [name, directory, version, majorMinor] of [
    ["S3", ".w3-venv", "3.11.15", "3.11"], ["S5", ".w3-s5-venv", "3.12.13", "3.12"]]) {
    const python = join(backend, directory, "bin/python");
    run("scientific-" + name + "-provenance", python, ["-I", "-B", "-c",
      "import sys,os,json; print(json.dumps(dict(version=sys.version.split()[0],prefix=os.path.realpath(sys.prefix),base=os.path.realpath(sys.base_prefix))))"]);
    const actual = JSON.parse(readFileSync(commands.at(-1).log, "utf8"));
    assert.equal(actual.version, version); assert.equal(actual.prefix, realpathSync(join(backend, directory)));
    scientificEnvironments.push({ ...actual, name, python, majorMinor, reconstructedUnderOutput: true });
  }
  for (const [name, project] of [["backend", join(backend, "tsconfig.json")],
    ["proof", join(backend, "scripts/postz/w3/tsconfig.json")], ["frontend", join(checkout, "tsconfig.json")]])
    run(name + "-typecheck", process.execPath, ["scripts/postz/w3/typecheck.mjs", "--project", project,
      "--output", join(evidence, name + "-typecheck")]);
  for (const command of ["centropy:client:check", "centropy:manifest:check", "centropy:forms:check", "centropy:coverage:check"])
    run(command.replaceAll(":", "-"), "npm", ["run", command], checkout);
  run("owner-domain-boundary", "npm", ["run", "PE-DOMAIN-BOUNDARY"]);
  for (const pin of source.locks) assert.equal(hash(readFileSync(join(checkout, pin.path))), pin.sha256);
  assert.equal(git("status", "--porcelain=v1", "-uall"), "", "W3_RECONSTRUCTED_SOURCE_DRIFT");
  const installation = join(output, "installation");
  run("complete-installed-product-build", process.execPath, ["scripts/postz/w3/build.mjs", "--output", installation]);
  const denials = JSON.parse(readFileSync(assets.donorDenials, "utf8"));
  denials.push({ root: checkout, probe: join(checkout, "README.md") });
  for (const environment of scientificEnvironments) {
    denials.push({ root: environment.prefix,
      probe: join(environment.prefix, "lib/python" + environment.majorMinor + "/site-packages/numpy/__init__.py") });
    denials.push({ root: environment.base, probe: join(environment.base, "lib/python" + environment.majorMinor + "/abc.py") });
  }
  const denied = [...new Map(denials.map(entry => [realpathSync(entry.root), entry])).values()];
  const denialPath = join(evidence, "installed-donor-denials.json");
  writeFileSync(denialPath, JSON.stringify(denied, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const confined = join(evidence, "confined-installed");
  run("installed-native-journey", "xvfb-run", ["-a", process.execPath, "scripts/postz/w3/installed.mjs",
    "--installation", installation, "--output", confined, "--denied", denialPath], join(installation, "finnor-os"));
  const native = JSON.parse(readFileSync(join(confined, "native/result.json"), "utf8"));
  assert.equal(native.exitCode, 0);
  for (const id of ["W052-emitted-mounted-original-Work", "W052-mounted-native-continuation",
    "W052-real-offline-and-fresh-return", "W052-root-A-B-A-no-old-response", "W052-logout-principal-A-B-A",
    "W052-participant-exact-purpose-and-consent-revocation", "W052-wall-time-protocol-expiry",
    "W052-emitted-reopen-and-API-restart", "W052-revoked-authority-no-late-response",
    "W052-inbox-read-cannot-cross-consent-write", "W051-final-installed-byte-and-namespace-custody"])
    assert(native.results.some(result => result.id === id && result.status === "PASS"), "W3_COLD_MOUNTED_PREDICATE_REQUIRED:" + id);
  assert.equal(git("status", "--porcelain=v1", "-uall"), "", "W3_FINAL_RECONSTRUCTED_SOURCE_DRIFT");
  passed = true;
} finally {
  writeFileSync(join(evidence, "report.json"), JSON.stringify({
    schema: "finnor.w3.clean-reconstruction.v1", status: passed ? "PASS_CONTROLLED_INSTALLED_NATIVE_AND_MOUNTED_RECONSTRUCTION" : "FAILED_RETAINED",
    source, checkout, output, commands, meters, elapsedMs: Date.now() - started,
    archiveOnlySource: true, exactOriginalCommitObject: true, noGitAlternates: true,
    historicalBuildPreimages: { commit: preimages.historical.commit, tree: preimages.historical.tree,
      packSha256: preimages.pack.sha256, additionalObjects: preimages.objects.length,
      donorGitObjectsBorrowed: false, retainedMigrationComparisonSkipped: false },
    sourceDependenciesBorrowed: false, dependencyInstallMode: "FRESH_LOCKFILES_WITH_PACKAGE_CACHE_ALLOWED",
    declaredAssets: assets, scientificEnvironments, inheritedValidationLimits: inherited,
    runtimeConfinement: "PROCESS_LOCAL_INHERITED_LINUX_LANDLOCK_ABI2_DONOR_OPEN_DENIAL",
    mountedBrowserDependency: "DECLARED_HOST_PLAYWRIGHT_MANAGED_VISIBLE_CHROMIUM_WITH_FRESH_PROFILE",
    factoryOrPersonalBrowserAttached: false, savedBrowserSessionForwarded: false,
    frontendQualification: passed ? "EMITTED_NEXT_AND_ACTUAL_AUTHENTICATED_MOUNTED_PREDICATES_PASSED"
      : "INCOMPLETE_REFER_TO_RETAINED_STEP_AND_NATIVE_CASE_RECEIPTS",
    protectedQualification: false, admitted: false, productionActive: false, fieldValidated: false,
    unknownCosts: { money: null, humanSeconds: null, aggregateConcurrentPeakMemoryBytes: null },
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
