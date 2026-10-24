/** Freeze actual coordinator bytes + owned leaves + an exact proposed delta.
 * No dependency tree, .env, private fixture, Git object or service is borrowed. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const own = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(coordinator|proposal|output)=(\/.+)$/.exec(arg);
  if (!match) throw Error("Z0_ABSOLUTE_SNAPSHOT_ARGUMENT_REQUIRED");
  return [match[1], resolve(match[2])];
}));
if (Object.keys(options).length !== 3 || !options.output.startsWith(resolve(own, "scope-z/phase-evidence/z0") + sep)
  || existsSync(options.output) || options.coordinator === own) throw Error("Z0_NEW_OWNED_SNAPSHOT_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }).trimEnd();
const proposal = JSON.parse(await readFile(resolve(options.proposal, "manifest.json"), "utf8"));
if (proposal.schema !== "finnor.project-z.z0.current-coordinator-owner-use-proposal.v1"
  || proposal.sharedFilesWritten !== false || sha(await readFile(resolve(options.proposal, "owner-use.patch"))) !== proposal.patchSha256) {
  throw Error("Z0_EXACT_CURRENT_COORDINATOR_PROPOSAL_REQUIRED");
}
const runtime = resolve(options.output, "runtime");
await mkdir(runtime, { recursive: true, mode: 0o700 });
const source = new Map(), coordinatorPins = new Map(), ownedDeltas = [];
const tracked = git(options.coordinator, "ls-files", "-z").split("\0").filter(Boolean);
const allowed = path => (
  /^(?:finnor-os\/|src\/|e2e\/|scripts\/|vendor\/|public\/)/.test(path)
  || /^[^/]+\.(?:json|[cm]?js|ts)$/.test(path)
  || path === "infra/deployment/production.contract.json"
  || /^(?:docs\/centropy\/|docs\/workspace\/)/.test(path)
  || /^scope-[^/]+\/.+\/(?:profile|verification-plan|baselines)\.json$/.test(path)
) && !/(?:^|\/)(?:node_modules|\.git|\.env[^/]*|\.next[^/]*|evidence|test-results)(?:\/|$)/.test(path)
  && !/\.(?:log|tsbuildinfo|webm)$/.test(path);
async function save(path, bytes, origin, mode = 0o644) {
  if (path.startsWith("/") || path.split("/").includes("..")) throw Error("Z0_SNAPSHOT_PATH_INVALID");
  const destination = resolve(runtime, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode });
  source.set(path, { path, sha256: sha(bytes), bytes: bytes.length, mode, origin });
}
const frozen = {
  coordinatorHead: git(options.coordinator, "rev-parse", "HEAD"),
  coordinatorTree: git(options.coordinator, "rev-parse", "HEAD^{tree}"),
  coordinatorTrackedDiffSha256: sha(git(options.coordinator, "diff", "--binary")),
  ownHead: git(own, "rev-parse", "HEAD"), ownTree: git(own, "rev-parse", "HEAD^{tree}"),
  ownTrackedDiffSha256: sha(git(own, "diff", "--binary")),
};
for (const path of tracked.filter(allowed).sort()) {
  const original = resolve(options.coordinator, path), observed = await lstat(original);
  if (!observed.isFile()) throw Error("Z0_SOURCE_SYMLINK_OR_SPECIAL_FILE_REFUSED:" + path);
  const bytes = await readFile(original);
  coordinatorPins.set(path, sha(bytes));
  const change = proposal.paths.find(item => item.path === path);
  if (change && sha(bytes) !== change.preimageSha256) throw Error("Z0_PROPOSAL_COORDINATOR_PREIMAGE_DRIFT:" + path);
  const emitted = change ? await readFile(resolve(options.proposal, "postimages", path)) : bytes;
  if (change && sha(emitted) !== change.postimageSha256) throw Error("Z0_PROPOSAL_POSTIMAGE_DRIFT");
  await save(path, emitted, change ? "PROPOSED_CURRENT_COORDINATOR_DELTA_NOT_APPLIED" : "ACTUAL_COORDINATOR_SOURCE",
    observed.mode & 0o111 ? 0o755 : 0o644);
}
// These are the one declared new shared migration and this producer's leaves.
const migration = "finnor-os/packages/db/migrations/postz_z0_institution_application_bridge.sql";
const sql = await readFile(resolve(options.coordinator, migration));
const ownedSql = await readFile(resolve(own, "finnor-os/packages/orchestration/src/project-z/z0-convergence/s5-owner-adapter.sql"));
if (sha(sql) !== "1511609691eed81aee3f227d70a0a5b061adf604780d5c6ab16822cc47aa029a" || sha(sql) !== sha(ownedSql)) {
  throw Error("Z0_COORDINATOR_SQL_RECONCILIATION_MISMATCH");
}
coordinatorPins.set(migration, sha(sql));
if (source.has(migration)) {
  if (source.get(migration).sha256 !== sha(sql)) throw Error("Z0_TRACKED_COORDINATOR_MIGRATION_CHANGED");
} else await save(migration, sql, "ACTUAL_COORDINATOR_CORRECTED_MIGRATION_NOT_EXECUTED");
async function addOwned(prefix) {
  for (const entry of (await readdir(resolve(own, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + "/" + entry.name;
    if (entry.isDirectory()) await addOwned(path);
    else if (entry.isFile() && /\.(?:[cm]?ts|tsx|[cm]?js|json|sql|py|txt)$/.test(entry.name)) {
      const bytes = await readFile(resolve(own, path)), prior = source.get(path);
      if (prior) {
        if (prior.origin !== "ACTUAL_COORDINATOR_SOURCE"
          || sha(await readFile(resolve(runtime, path))) !== prior.sha256) throw Error("Z0_OWNED_OVERLAY_PREIMAGE_CHANGED");
        if (prior.sha256 !== sha(bytes)) {
          ownedDeltas.push({ path, coordinatorPreimageSha256: prior.sha256, ownedPostimageSha256: sha(bytes) });
          await writeFile(resolve(runtime, path), bytes);
          source.set(path, { ...prior, sha256: sha(bytes), bytes: bytes.length,
            origin: "CURRENT_OWNED_Z0_DELTA_OVER_ACTUAL_COORDINATOR", coordinatorPreimageSha256: prior.sha256 });
        }
      } else await save(path, bytes, "CURRENT_OWNED_Z0_IMPLEMENTATION");
    } else throw Error("Z0_UNDECLARED_OWNED_SOURCE_ASSET:" + path);
  }
}
await addOwned("finnor-os/packages/orchestration/src/project-z/z0-convergence");
await addOwned("finnor-os/scripts/project-z/z0");
for (const [path, hash] of coordinatorPins) if (sha(await readFile(resolve(options.coordinator, path))) !== hash) {
  throw Error("Z0_COORDINATOR_CHANGED_DURING_SNAPSHOT:" + path);
}
if (git(options.coordinator, "rev-parse", "HEAD") !== frozen.coordinatorHead
  || sha(git(options.coordinator, "diff", "--binary")) !== frozen.coordinatorTrackedDiffSha256) {
  throw Error("Z0_COORDINATOR_SOURCE_CUT_CHANGED");
}
const files = [...source.values()].sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  schema: "finnor.project-z.z0.converged-source-snapshot.v1", createdAt: new Date().toISOString(),
  runtime, frozen, proposalPatchSha256: proposal.patchSha256, sourcePopulationSha256: sha(JSON.stringify(files)),
  files, ownedDeltas, totalBytes: files.reduce((n, file) => n + file.bytes, 0),
  dependencyTreesCopied: false, localGitObjectsRequired: false, privateFixtureCopied: false,
  target: proposal.paths.length ? "PROPOSED_CONVERGED_SNAPSHOT_NOT_COORDINATOR_APPLIED_OR_NATIVE_QUALIFIED"
    : "ACTUAL_COORDINATOR_PRODUCT_WITH_OWNED_TOOLING_NOT_NATIVE_QUALIFIED",
  native: "NOT_RUN", installedNative: "NOT_RUN",
};
await writeFile(resolve(options.output, "source-snapshot.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...manifest, files: files.length, runtime: relative(own, runtime) }));
