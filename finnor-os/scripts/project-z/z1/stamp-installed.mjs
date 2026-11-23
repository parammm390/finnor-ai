/** Whole-owner source binding for the explicit reconstruction, not a Git lookup,
 * environment-supplied commit label or assertion of native execution. */
import { readdir, readFile, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { runtimeIdentity, installedSourceIdentity } from "../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const base = resolve(root, "finnor-os/packages/private-equity/src/project-z/z1-shared-work");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const input = JSON.parse(await readFile(resolve(base, "reconstruction-input.json"), "utf8"));
if (input.schema !== "finnor.z1.reconstruction-input.v1" ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) || !/^[a-f0-9]{40}$/.test(input.sourceTree) ||
    !/^[a-f0-9]{64}$/.test(input.integrationPatchSha256) || !/^[a-f0-9]{64}$/.test(input.sourceArchiveSha256))
  throw Error("EXACT_DECLARED_RECONSTRUCTION_INPUT_REQUIRED");
const paths = [];
async function walk(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (["node_modules", ".git", "__pycache__", "dist", "coverage", "test-results", "playwright-report"].includes(entry.name) ||
        entry.name.startsWith(".next") || entry.name.startsWith(".env")) continue;
    const path = directory + "/" + entry.name;
    if (/\/installed-source(?:-files)?\.json$/.test(path) || /\/reconstruction-input\.json$/.test(path)) continue;
    if (entry.isSymbolicLink()) throw Error("DECLARED_OWNER_SOURCE_CANNOT_BORROW_A_SYMLINK");
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) paths.push(path);
  }
}
for (const directory of ["src", "scripts", "finnor-os/packages", "finnor-os/apps", "finnor-os/scripts"]) await walk(directory);
for (const prefix of ["", "finnor-os/"]) for (const file of [
  "package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", "next.config.mjs",
]) {
  const path = prefix + file;
  if ((await lstat(resolve(root, path)).catch(() => null))?.isFile()) paths.push(path);
}
paths.sort();
if (paths.length < 30 || paths.length > 20000 || new Set(paths).size !== paths.length)
  throw Error("FINITE_COMPLETE_WHOLE_OWNER_SOURCE_SET_REQUIRED");
const files = [];
for (const path of paths) {
  if (relative(root, resolve(root, path)) !== path || /[%?#\\\u0000-\u001f]/.test(path))
    throw Error("EXACT_RELATIVE_OWNER_SOURCE_PATH_REQUIRED");
  const bytes = await readFile(resolve(root, path));
  files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
}
const manifest = Buffer.from(JSON.stringify({ schema: "finnor.z1.native-source-files.v1", files }, null, 2) + "\n");
if (manifest.length > 8388608) throw Error("WHOLE_OWNER_MANIFEST_BYTE_BOUND");
const runtime = await runtimeIdentity(), sourceFilesManifestSha256 = sha(manifest);
const value = { schema: "finnor.z1.installed-source.v1", sourceCommit: input.sourceCommit,
  sourceTree: input.sourceTree, integrationPatchSha256: input.integrationPatchSha256,
  sourceFilesManifestSha256, sourceArchiveSha256: input.sourceArchiveSha256,
  nativeRuntimeDigest: runtime.digest, node: runtime.node,
  reconstructionReference: `z1-native:${input.sourceCommit}:${input.integrationPatchSha256}:${sourceFilesManifestSha256}`,
  scope: "SOURCE_AND_DECLARED_INTEGRATION_BINDING_NOT_NATIVE_OWNER_EXECUTION_OR_PROTECTED_ATTESTATION" };
await writeFile(resolve(base, "installed-source-files.json"), manifest, { mode: 0o600 });
await writeFile(resolve(base, "installed-source.json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
await installedSourceIdentity();
console.log(JSON.stringify({ status: "DECLARED_WHOLE_OWNER_SOURCE_VERIFIED", ...value, files: files.length }));
