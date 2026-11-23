import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Build } from "./contracts";
import { digest } from "./contracts";
const execute = promisify(execFile);
const declaredRoot = process.env.FINNOR_Z5_SOURCE_ROOT;
if (declaredRoot && !path.isAbsolute(declaredRoot)) throw Error("Z5_ABSOLUTE_DECLARED_SOURCE_ROOT_REQUIRED");
export const REPOSITORY = declaredRoot ? path.resolve(declaredRoot) : fileURLToPath(new URL("../../../../../../", import.meta.url));
const prefixes = ["epistemic-runtime", "private-equity", "orchestration"].map(p =>
  `finnor-os/packages/${p}/src/project-z/z5-institution-linker`);
const owners = [
  "package-lock.json", "finnor-os/package-lock.json",
  "finnor-os/packages/private-equity/src/owner-context.ts", "finnor-os/packages/private-equity/src/enterprise-beliefs.ts",
  "finnor-os/packages/private-equity/src/enterprise-control.ts", "finnor-os/packages/private-equity/src/enterprise-allocation.ts",
  "finnor-os/packages/private-equity/src/allocation-store.ts", "finnor-os/packages/private-equity/src/enterprise-obligations.ts",
  "finnor-os/packages/private-equity/src/economic-store.ts", "finnor-os/packages/private-equity/src/enterprise-economic-assignments.ts",
  "finnor-os/packages/authority/src/index.ts", "finnor-os/apps/worker/src/queue.ts",
  "finnor-os/packages/db/compute-contract.ts", "finnor-os/apps/worker/src/index.ts",
  "finnor-os/packages/capability-evolution/src/lifecycle.ts",
  "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts",
  "finnor-os/packages/governed-execution/src/owner-transport.ts",
];
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(REPOSITORY, directory), { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw Error("Z5_SOURCE_ASSET_SYMLINK");
    const relative = directory + "/" + entry.name;
    if (entry.isDirectory()) results.push(...await files(relative));
    else if (/\.(tsx?|mts|mjs|py|sql)$/.test(entry.name)) results.push(relative);
  }
  return results;
}
export async function currentBuild(): Promise<Build> {
  const paths = [...new Set([...owners, ...(await Promise.all(prefixes.map(files))).flat()])].sort();
  const pins: Build["files"] = [];
  for (const relative of paths) {
    pins.push({ path: relative, sha256: createHash("sha256").update(await readFile(path.join(REPOSITORY, relative))).digest("hex") });
  }
  let commit: string, tree: string, installedBuildId: string | null = null;
  try {
    const top = await execute("git", ["-C", REPOSITORY, "rev-parse", "--show-toplevel"], { timeout: 5000 });
    if (path.resolve(top.stdout.trim()) !== path.resolve(REPOSITORY)) throw Error("Z5_PARENT_GIT_IDENTITY_FORBIDDEN");
    const identity = await execute("git", ["-C", REPOSITORY, "rev-parse", "HEAD", "HEAD^{tree}"], { timeout: 5000 });
    [commit, tree] = identity.stdout.trim().split("\n") as [string, string];
  } catch {
    if (process.env.FINNOR_Z5_DECLARED_RECONSTRUCTION !== "EXACT_MANIFEST")
      throw Error("Z5_EXPLICIT_NO_GIT_RECONSTRUCTION_MEMBERSHIP_REQUIRED");
    const release = JSON.parse(await readFile(path.join(REPOSITORY, "scope-z/phase-evidence/z5/reconstruction/source-manifest.json"), "utf8")) as {
      sourceHead: string; sourceTree: string; files: Build["files"];
    };
    if (!Array.isArray(release.files) || new Set(release.files.map(p => p.path)).size !== release.files.length
      || pins.some(pin => !release.files.some(p => p.path === pin.path && p.sha256 === pin.sha256)))
      throw Error("Z5_INSTALLED_SOURCE_MEMBERSHIP_MISMATCH");
    commit = release.sourceHead; tree = release.sourceTree;
  }
  const applicationBuilds = await Promise.all([".next/BUILD_ID", "finnor-os/apps/api/.next/BUILD_ID"].map(async relative => {
    try { return { path: relative, id: (await readFile(path.join(REPOSITORY, relative), "utf8")).trim() }; }
    catch { return null; }
  }));
  if (applicationBuilds.every(build => build?.id)) installedBuildId = digest(applicationBuilds);
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw Error("Z5_SOURCE_IDENTITY_UNAVAILABLE");
  return { schema: "finnor.z5.loaded-source.v1", sourceCommit: commit, sourceTree: tree,
    sourceDigest: digest({ pins, node: process.version, platform: process.platform, arch: process.arch, installedBuildId }),
    node: process.version, files: pins, installedBuildId };
}
const loaded = currentBuild();
// A disabled/unpackaged Z5 feature must not crash unrelated API operations.
// Keep the original rejected preimage, so a later Z5 use still fails closed.
void loaded.catch(() => undefined);
export async function loadedBuild() {
  const original = await loaded, current = await currentBuild();
  if (original.sourceDigest !== current.sourceDigest || original.sourceCommit !== current.sourceCommit
    || original.sourceTree !== current.sourceTree || original.installedBuildId !== current.installedBuildId)
    throw Error("Z5_LOADED_SOURCE_CHANGED");
  return original;
}
