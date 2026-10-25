/**
 * Evidence-only adapter for the coordinator's named, reviewed receipt.
 * No product files, modules, Git objects, services or canonical registries
 * are written. --verify checks the frozen input without refreshing its cut.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const own = "/home/factory-user/repos/finnor-z0";
const coordinator = "/home/factory-user/repos/finnor-z-coordinator";
const integration = coordinator + "/scope-z/orchestration/evidence/coordinator-integration-04";
const productCommit = "5ad4e8d75c61b9cc1ee273cc14f8d8068d5ebd41";
const expectedCut = {
  coordinatorHead: "9f3edfd3b4c6758832c53139da0773218062191e",
  coordinatorTree: "2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9",
  coordinatorTrackedDiffSha256: "45557d982b550ac355e945d4ddf80434cc4d8f107f01646f1919dae1a06d6b05",
};
const receiptPin = "aa97d0ff34a38d818fde1d79298e767d4639a993875678c133a37de7f3b57911";
const collectorPin = "67f93374367af4d0c87a1df3ac9c5517cf8e1e45287f1fc6402413548a7bc15c";
const mode = process.argv.slice(2);
if (mode.length !== 1 || !["--emit", "--verify"].includes(mode[0])) throw Error("EXACT_EMIT_OR_VERIFY_REQUIRED");
if (realpathSync(here) !== here || !here.startsWith(own + "/scope-z/phase-evidence/z0/")) throw Error("OWNED_EVIDENCE_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = path => readFileSync(path);
const json = path => JSON.parse(bytes(path));
const serialized = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const git = (root, ...args) => execFileSync("/usr/bin/git", ["-C", root, ...args],
  { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 ** 2 }).trimEnd();
const assert = (ok, reason) => { if (!ok) throw Error(reason); };
const cut = () => ({
  coordinatorHead: git(coordinator, "rev-parse", "HEAD"),
  coordinatorTree: git(coordinator, "rev-parse", "HEAD^{tree}"),
  coordinatorTrackedDiffSha256: sha(git(coordinator, "diff", "--binary")),
});
assert(JSON.stringify(cut()) === JSON.stringify(expectedCut), "COORDINATOR_CUT_CHANGED_REVIEW_REQUIRED");
const receiptPath = integration + "/build-inventory-preflight-01.json";
const applicationPath = integration + "/z3-v3-application-01/application.json";
const driverPath = integration + "/build-combined.py";
const collectorPath = own + "/finnor-os/scripts/project-z/z0/prepare-converged-source.mjs";
const receiptBytes = bytes(receiptPath), receipt = JSON.parse(receiptBytes), application = json(applicationPath);
assert(sha(receiptBytes) === receiptPin, "REVIEWED_RECEIPT_CHANGED");
assert(sha(bytes(collectorPath)) === collectorPin, "COLLECTOR_INTERFACE_CHANGED");
assert(sha(bytes(driverPath)) === receipt.driverSha256, "COORDINATOR_DRIVER_CHANGED");
assert(receipt.state === "PASSED_INVENTORY_PREFLIGHT_NOT_BUILD" && receipt.files.length === 170
  && receipt.additionalProductPaths === 170 && sha(JSON.stringify(receipt.files)) === receipt.membershipSha256,
"REVIEWED_MEMBERSHIP_CHANGED");
assert(application.state === "APPLIED_SOURCE_NOT_ACCEPTANCE" && application.problems.length === 0
  && application.ownedCommit === "ae8d1f68e201c23044be9cf7b7fec2c19a71750c"
  && application.ownedFiles.length === 22 && application.sharedRequests.length === 4, "Z3_REVIEW_CHANGED");

// This is the pinned collector's allowlist, not an untracked-file discovery.
const allowed = path => (
  /^(?:finnor-os\/|src\/|e2e\/|scripts\/|vendor\/|public\/)/.test(path)
  || /^[^/]+\.(?:json|[cm]?js|ts)$/.test(path)
  || path === "infra/deployment/production.contract.json"
  || /^(?:docs\/centropy\/|docs\/workspace\/)/.test(path)
  || /^scope-[^/]+\/.+\/(?:profile|verification-plan|baselines)\.json$/.test(path)
) && !/(?:^|\/)(?:node_modules|\.git|\.env[^/]*|\.next[^/]*|evidence|test-results)(?:\/|$)/.test(path)
  && !/\.(?:log|tsbuildinfo|webm)$/.test(path);
function observed(root, path) {
  const absolute = resolve(root, path), metadata = lstatSync(absolute);
  assert(relative(root, absolute) === path && metadata.isFile() && realpathSync(absolute) === absolute, "REGULAR_CONTAINED_SOURCE_REQUIRED:" + path);
  const data = bytes(absolute);
  return { path, sha256: sha(data), bytes: data.length, mode: metadata.mode & 0o111 ? 0o755 : 0o644 };
}
const seen = new Set(), additional = [];
for (const item of receipt.files) {
  assert(allowed(item.path) && !seen.has(item.path) && [0o644, 0o755].includes(item.mode), "INVALID_REVIEWED_MEMBER:" + item.path);
  seen.add(item.path);
  const row = observed(coordinator, item.path);
  assert(row.sha256 === item.sha256 && row.mode === item.mode && (lstatSync(resolve(coordinator, item.path)).mode & 0o777) === item.mode
    && row.bytes <= 16 * 1024 ** 2, "REVIEWED_POSTIMAGE_CHANGED:" + item.path);
  additional.push(row);
}
assert(additional.reduce((n, row) => n + row.bytes, 0) <= 64 * 1024 ** 2, "ADDITIONAL_BYTE_BOUND");
for (const item of [...application.ownedFiles, ...application.sharedRequests]) {
  const row = additional.find(file => file.path === item.path);
  assert(row && row.sha256 === (item.actualPostimageSha256 ?? item.postimageSha256), "Z3_POSTIMAGE_NOT_REVIEWED:" + item.path);
  // Shared "mode" describes patch composition, not a POSIX file mode.
  // Its file mode is pinned by the reviewed receipt and live lstat above.
  if (application.ownedFiles.includes(item)) {
    assert(/^[0-7]{6}$/.test(item.mode) && row.mode === (parseInt(item.mode, 8) & 0o777), "Z3_MODE_CHANGED:" + item.path);
  }
}
const newZ3 = application.ownedFiles.filter(item => item.status === "A");
assert(newZ3.length === 17 && newZ3.every(item => seen.has(item.path)), "Z3_NEW_LEAVES_OMITTED");
const tracked = git(coordinator, "ls-files", "-z").split("\0").filter(Boolean);
const source = new Map(tracked.filter(allowed).sort().map(path => {
  const row = observed(coordinator, path);
  return [path, { ...row, origin: "ACTUAL_COORDINATOR_SOURCE" }];
}));
for (const row of additional) {
  const prior = source.get(row.path);
  assert(!prior || (prior.sha256 === row.sha256 && prior.bytes === row.bytes && prior.mode === row.mode), "TRACKED_ADDITIONAL_CONFLICT");
  if (!prior) source.set(row.path, { ...row, origin: "ACTUAL_COORDINATOR_SOURCE" });
}
const migration = "finnor-os/packages/db/migrations/postz_z0_institution_application_bridge.sql";
const sql = observed(coordinator, migration);
assert(sql.sha256 === "1511609691eed81aee3f227d70a0a5b061adf604780d5c6ab16822cc47aa029a", "CANONICAL_SQL_CHANGED");
if (!source.has(migration)) source.set(migration, { ...sql, origin: "ACTUAL_COORDINATOR_CORRECTED_MIGRATION_NOT_EXECUTED" });
const owned = [];
function checkOwned(prefix) {
  for (const entry of readdirSync(resolve(own, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + "/" + entry.name;
    if (entry.isDirectory()) checkOwned(path);
    else {
      assert(entry.isFile() && /\.(?:[cm]?ts|tsx|[cm]?js|json|sql|py|txt)$/.test(entry.name), "UNDECLARED_OWNED_ASSET");
      const row = observed(own, path), prior = source.get(path);
      const committed = execFileSync("/usr/bin/git", ["-C", own, "show", productCommit + ":" + path], { maxBuffer: 16 * 1024 ** 2 });
      assert(sha(committed) === row.sha256, "LOCAL_PRODUCT_COMMIT_DRIFT:" + path);
      assert(prior?.origin === "ACTUAL_COORDINATOR_SOURCE" && prior.sha256 === row.sha256 && prior.mode === row.mode, "OWNED_ADOPTION_DRIFT:" + path);
      owned.push(row);
    }
  }
}
checkOwned("finnor-os/packages/orchestration/src/project-z/z0-convergence");
checkOwned("finnor-os/scripts/project-z/z0");
assert(owned.length === 36, "OWNED_MEMBERSHIP_CHANGED");
for (const row of source.values()) assert(JSON.stringify(observed(coordinator, row.path)) === JSON.stringify({
  path: row.path, sha256: row.sha256, bytes: row.bytes, mode: row.mode,
}), "SOURCE_CHANGED_DURING_REFERENCE:" + row.path);
assert(sha(bytes(receiptPath)) === receiptPin && JSON.stringify(cut()) === JSON.stringify(expectedCut), "SOURCE_BARRIER_CHANGED");
const files = [...source.values()].sort((a, b) => a.path.localeCompare(b.path));
const index = {
  schema: "finnor.project-z.z0.additional-coordinator-source-index.v1",
  coordinatorRoot: coordinator, ...expectedCut, sourceOnly: true, databaseAuthOrServices: false, files: additional,
};
const reference = {
  schema: "finnor.project-z.z0.metadata-only-converged-source-reference.v1",
  authority: "NAMED_COORDINATOR_REVIEW_INPUT_NOT_NEW_PRODUCT_TRUTH",
  coordinatorRoot: coordinator, ...expectedCut, ownProductCommit: productCommit,
  reviewedInput: { path: receiptPath, bytes: receiptBytes.length, sha256: receiptPin, membershipSha256: receipt.membershipSha256 },
  collectorSha256: collectorPin, sourcePopulationSha256: sha(JSON.stringify(files)),
  files, totalBytes: files.reduce((n, file) => n + file.bytes, 0), ownedFiles: owned,
  ownedDeltas: [], additionalDeclared: additional.length,
  additionalActuallyUntracked: additional.filter(item => !tracked.includes(item.path)).length,
  z3Owned: 22, z3Shared: 4, z3NewLeaves: 17,
  productBytesCopied: false, dependencyTreesCopied: false, localGitObjectsRequiredForArchiveReplay: false,
  native: "NOT_RUN", installedNative: "NOT_RUN", currentStrictBuild: "NOT_RUN_RESOURCE_GUARD",
};
const proposal = {
  schema: "finnor.project-z.z0.current-coordinator-owner-use-proposal.v1",
  sharedFilesWritten: false, patchSha256: sha(Buffer.alloc(0)), paths: [],
  meaning: "NO_NEW_SHARED_DELTA_ADOPTED_SOURCE_ALREADY_PRESENT",
};
const outputs = new Map([
  ["additional-coordinator-source-index.json", serialized(index)],
  ["current-combined-source-reference.json", serialized(reference)],
  ["current-adopted-proposal/manifest.json", serialized(proposal)],
  ["current-adopted-proposal/owner-use.patch", Buffer.alloc(0)],
  ["inputs/build-inventory-preflight-01.json", receiptBytes],
  ["inputs/z3-application.json", bytes(applicationPath)],
  ["inputs/coordinator-resume-06.prompt.md", bytes(coordinator + "/scope-z/orchestration/continuity/evidence/Z0/coordinator-resume-06.prompt.md")],
  ["inputs/validation-03-report.json", bytes(integration + "/validation-03/report.json")],
  ["inputs/build-01-report.json", bytes(integration + "/build-01/report.json")],
]);
if (mode[0] === "--emit") {
  for (const name of outputs.keys()) assert(!existsSync(resolve(here, name)), "NEW_METADATA_OUTPUT_REQUIRED:" + name);
  for (const [name, data] of outputs) {
    const path = resolve(here, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { flag: "wx", mode: 0o644 });
  }
} else {
  for (const [name, data] of outputs) assert(bytes(resolve(here, name)).equals(data), "FROZEN_METADATA_CHANGED:" + name);
}
const disk = statfsSync(own);
console.log(JSON.stringify({
  state: "PASSED_EXPLICIT_MEMBERSHIP_METADATA_ONLY_NOT_BUILD_OR_NATIVE", mode: mode[0], observedAt: new Date().toISOString(),
  ...expectedCut, sourcePopulationSha256: reference.sourcePopulationSha256, files: files.length, totalBytes: reference.totalBytes,
  additionalDeclared: 170, additionalActuallyUntracked: reference.additionalActuallyUntracked, ownedParity: 36, ownedDeltas: [],
  z3Owned: 22, z3Shared: 4, z3NewLeaves: 17, availableBytes: disk.bavail * disk.bsize, combinedBuildGuardBytes: 4 * 1024 ** 3,
  buildExecuted: false, databaseActions: 0, nativeExecuted: false,
  outputs: [...outputs].map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) })),
}));
