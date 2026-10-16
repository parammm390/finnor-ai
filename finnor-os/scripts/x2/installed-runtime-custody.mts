/** Independent launcher integrity check, not a model/business oracle. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

type Asset = { path: string; bytes?: number; sha256?: string; kind?: "link"; target?: string };
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string) => path === root || path.startsWith(root + "/");
export async function inspectInstalledRuntime(runtimeRoot: string) {
  const started = performance.now(), runtime = await realpath(runtimeRoot), output = dirname(runtime);
  assert.equal(runtime, resolve(runtimeRoot), "CANONICAL_INSTALLED_RUNTIME_REQUIRED");
  const manifest = JSON.parse(await readFile(join(output, "build-manifest.json"), "utf8"));
  const identityBytes = await readFile(join(runtime, "finnor-os/x2-runtime/identity.json"));
  const identity = JSON.parse(identityBytes.toString());
  assert.equal(manifest.schema, "finnor.x2.installed-asset-identity.v1");
  assert.equal(manifest.runtime, runtime);
  for (const key of ["node", "platform", "architecture", "nodeBinarySha256", "buildId",
    "apiAssetsDigest", "dependencyAssetsDigest", "sourceInputsDigest"]) assert.equal(identity[key], manifest[key]);
  assert.equal(manifest.node, process.version); assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.architecture, process.arch);
  assert.equal(sha(await readFile(process.execPath)), manifest.nodeBinarySha256);
  async function inventory(directories: string[]) {
    const assets: Asset[] = [];
    const pending: Array<{ index: number; path: string }> = [];
    async function visit(directory: string) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".cache", ".vite"].includes(entry.name)
          || directory === join(runtime, "finnor-os/apps/api/.next") && entry.name === "cache") continue;
        const path = join(directory, entry.name), name = relative(runtime, path);
        if (entry.isSymbolicLink()) {
          const target = await realpath(path);
          assert(inside(runtime, target), "INSTALLED_DEPENDENCY_RESOLUTION_ESCAPED");
          assets.push({ path: name, kind: "link", target: relative(runtime, target) });
        } else if (entry.isDirectory()) await visit(path);
        else {
          assert(entry.isFile(), "UNSUPPORTED_INSTALLED_ASSET");
          pending.push({ index: assets.length, path });
          assets.push({ path: name });
        }
      }
    }
    for (const directory of directories) await visit(join(runtime, directory));
    let cursor = 0, failed = false;
    await Promise.all(Array.from({ length: 8 }, async () => {
      try {
        while (!failed && cursor < pending.length) {
          const { index, path } = pending[cursor++]!;
          const bytes = await readFile(path);
          assets[index] = { path: assets[index]!.path, bytes: bytes.length, sha256: sha(bytes) };
        }
      } catch (error) { failed = true; throw error; }
    }));
    return assets;
  }
  const groups = [
    { name: "dependency", paths: ["node_modules", "finnor-os/node_modules"] },
    { name: "api", paths: ["finnor-os/apps/api/.next"] },
  ];
  const checked: Array<{ name: string; count: number; digest: string }> = [];
  for (const group of groups) {
    const expected = JSON.parse(await readFile(join(output, group.name + "-assets.json"), "utf8")) as Asset[];
    const expectedDigest = group.name === "api" ? manifest.apiAssetsDigest : manifest.dependencyAssetsDigest;
    assert.equal(sha(JSON.stringify(expected)), expectedDigest, "INSTALLED_ASSET_INVENTORY_CHANGED");
    const actual = await inventory(group.paths);
    assert.equal(sha(JSON.stringify(actual)), expectedDigest, "ACTUAL_INSTALLED_ASSET_BYTES_OR_RESOLUTION_CHANGED");
    checked.push({ name: group.name, count: actual.length, digest: expectedDigest });
  }
  for (const asset of manifest.emittedFiles as Asset[]) {
    const path = resolve(runtime, asset.path);
    assert(inside(join(runtime, "finnor-os/x2-runtime"), path));
    assert.equal(await realpath(path), path);
    const info = await lstat(path), bytes = await readFile(path);
    assert(info.isFile() && !(info.mode & 0o222), "READ_ONLY_EMITTED_ASSET_REQUIRED");
    assert.equal(bytes.length, asset.bytes); assert.equal(sha(bytes), asset.sha256);
  }
  for (const lock of manifest.locks as Array<{ path: string; sha256: string }>)
    assert.equal(sha(await readFile(join(runtime, lock.path))), lock.sha256, "INSTALLED_DEPENDENCY_LOCK_CHANGED");
  return { schema: "finnor.x2.installed-integrity-inspection.v1", status: "PASS", runtime, buildId: manifest.buildId,
    emittedFiles: manifest.emittedFiles, installedIdentityDigest: sha(identityBytes), checked,
    wallMs: performance.now() - started, sourceLoadedAdapters: manifest.sourceLoadedAdapters,
    qualification: "ACTUAL_ARTIFACT_INTEGRITY_NOT_BUSINESS_OR_PROTECTED_QUALIFICATION" };
}
