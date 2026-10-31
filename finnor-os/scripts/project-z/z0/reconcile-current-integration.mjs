/** Reconcile the fixed requested target with current coordinator bytes.
 * A receipt or exact missing delta is written only in owned evidence. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(coordinator|basis|output)=(\/.+)$/.exec(arg);
  if (!match) throw Error("Z0_ABSOLUTE_RECONCILIATION_ARGUMENT_REQUIRED");
  return [match[1], resolve(match[2])];
}));
if (Object.keys(options).length !== 3 || options.coordinator === root
  || !options.output.startsWith(resolve(root, "scope-z/phase-evidence/z0") + sep)
  || existsSync(options.output)) throw Error("Z0_NEW_OWNED_RECONCILIATION_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", options.coordinator, ...args],
  { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 ** 2 }).trimEnd();
const target = {
  "finnor-os/packages/private-equity/src/application-semantics/store.ts": "fc06aef01a7f4e82024793c76060967fbd4efecaa3834c0bcd3bdd9a74179770",
  "finnor-os/packages/private-equity/src/program-synthesis/institution.ts": "545637532bee1bd6584f8f278b204779c92744ab0271c3f3dbbe74d5d9f168cd",
  "finnor-os/packages/private-equity/src/program-synthesis/institution-continuation.ts": "17fc1fd0dd3f187dfb9e680622b41438395b4966193527b7ce0ca32ae01a1ed2",
};
const basisBytes = await readFile(resolve(options.basis, "manifest.json"));
const basis = JSON.parse(basisBytes);
if (basis.schema !== "finnor.project-z.z0.current-coordinator-owner-use-proposal.v1"
  || basis.patchSha256 !== "b8eb54cce30445d227b50ae94dbb463493dc9587f76a8de6817787cfbaf284f0"
  || sha(await readFile(resolve(options.basis, "owner-use.patch"))) !== basis.patchSha256
  || basis.paths.length !== Object.keys(target).length) throw Error("Z0_PINNED_TARGET_BASIS_REQUIRED");
const frozen = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  trackedDiffSha256: sha(git("diff", "--binary")) };
const observations = [], changes = [], pins = new Map();
for (const [path, digest] of Object.entries(target)) {
  const expected = basis.paths.find(item => item.path === path);
  const after = await readFile(resolve(options.basis, "postimages", path), "utf8");
  const before = await readFile(resolve(options.coordinator, path), "utf8");
  if (!expected || expected.postimageSha256 !== digest || sha(after) !== digest
    || ![digest, expected.preimageSha256].includes(sha(before))) throw Error("Z0_UNKNOWN_COORDINATOR_BYTES_REFUSED:" + path);
  pins.set(path, sha(before));
  observations.push({ path, currentSha256: sha(before), requestedTargetSha256: digest,
    disposition: sha(before) === digest ? "CURRENT_BYTES_MATCH_REQUESTED_TARGET" : "EXACT_MISSING_DELTA_PROPOSED" });
  if (sha(before) !== digest) changes.push({ path, before, after });
}
const ownedLeaves = [];
for (const name of ["institution-consumer.ts", "institution-origin.ts", "projection.ts"]) {
  const path = "finnor-os/packages/orchestration/src/project-z/z0-convergence/" + name;
  const current = await readFile(resolve(options.coordinator, path)), owned = await readFile(resolve(root, path));
  pins.set(path, sha(current));
  ownedLeaves.push({ path, currentCoordinatorSha256: sha(current), ownedSha256: sha(owned),
    disposition: sha(current) === sha(owned) ? "CURRENT_COORDINATOR_MATCHES_OWNED_TARGET" : "OWNED_DELTA_STILL_REQUIRES_COORDINATOR_REVIEW" });
}
const sqlPath = "finnor-os/packages/db/migrations/postz_z0_institution_application_bridge.sql";
const sqlSha256 = sha(await readFile(resolve(options.coordinator, sqlPath)));
if (sqlSha256 !== "1511609691eed81aee3f227d70a0a5b061adf604780d5c6ab16822cc47aa029a") throw Error("Z0_CURRENT_SQL_CHANGED");
pins.set(sqlPath, sqlSha256);
let patch = "";
for (const { path, before, after } of changes) {
  const oldLines = before.trimEnd().split("\n"), newLines = after.trimEnd().split("\n");
  patch += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
    + oldLines.map(line => "-" + line + "\n").join("") + newLines.map(line => "+" + line + "\n").join("");
}
for (const [path, digest] of pins) if (sha(await readFile(resolve(options.coordinator, path))) !== digest) {
  throw Error("Z0_COORDINATOR_CHANGED_DURING_RECONCILIATION:" + path);
}
if (git("rev-parse", "HEAD") !== frozen.head || sha(git("diff", "--binary")) !== frozen.trackedDiffSha256) {
  throw Error("Z0_COORDINATOR_SOURCE_CUT_CHANGED");
}
await mkdir(options.output, { mode: 0o700 });
for (const { path, before, after } of changes) for (const [population, body] of [["preimages", before], ["postimages", after]]) {
  const destination = resolve(options.output, population, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body, { flag: "wx" });
}
const manifest = {
  schema: "finnor.project-z.z0.current-coordinator-owner-use-proposal.v1", observedAt: new Date().toISOString(),
  coordinator: options.coordinator, coordinatorHead: frozen.head, coordinatorTree: frozen.tree,
  coordinatorTrackedDiffSha256: frozen.trackedDiffSha256, basisManifestSha256: sha(basisBytes),
  basisPatchSha256: basis.patchSha256, patchSha256: sha(patch),
  paths: changes.map(({ path, before, after }) => ({ path, preimageSha256: sha(before), postimageSha256: sha(after) })),
  sharedFilesWritten: false, reviewState: changes.length ? "EXACT_CURRENT_MISSING_DELTA_PROPOSED_NOT_APPLIED"
    : "CURRENT_COORDINATOR_MATCHES_REQUESTED_SHARED_TARGET_NO_NEW_SHARED_DELTA",
  observations, ownedLeaves, sqlReconciliation: { sha256: sqlSha256, changeRequested: false, executed: false },
  native: "NOT_RUN", installedNative: "NOT_RUN", slotReleased: false,
};
await writeFile(resolve(options.output, "owner-use.patch"), patch, { flag: "wx" });
await writeFile(resolve(options.output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(manifest));
