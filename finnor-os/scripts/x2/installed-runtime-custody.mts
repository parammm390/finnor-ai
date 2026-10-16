/** Independent launcher integrity check, not a model/business oracle. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
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

/** Actual queued/claimed original use owns this check, not the identity reader. */
export async function verifyInstalledOriginalUseFences(input: {
  runtimeRoot: string; evidenceDirectory: string;
  prepare(name: string): Promise<{
    resume(): Promise<{ status: string; reason: string | null }>;
    close(): Promise<void>;
  }>;
  assertNoMutation(name: string): Promise<void>;
}) {
  const runtime = await realpath(input.runtimeRoot), evidence = await realpath(input.evidenceDirectory);
  assert.equal(runtime, resolve(input.runtimeRoot));
  assert(inside(dirname(dirname(runtime)), evidence) && !inside(runtime, evidence));
  const directory = join(runtime, "finnor-os/x2-runtime"), identityPath = join(directory, "identity.json");
  const assetPath = join(directory, "application-consumer.js");
  const identityBytes = await readFile(identityPath), assetBytes = await readFile(assetPath);
  const identityMode = (await lstat(identityPath)).mode & 0o777, assetMode = (await lstat(assetPath)).mode & 0o777;
  assert(!(identityMode & 0o222) && !(assetMode & 0o222));
  const identity = JSON.parse(identityBytes.toString());
  assert.equal(identity.schema, "finnor.x2.installed-asset-identity.v1");
  const cases = [
    ["changed-consumer-bytes", "X2_INSTALLED_RUNTIME_ASSET_CHANGED"],
    ["writable-consumer", "X2_INSTALLED_RUNTIME_UNSAFE_ASSET"],
    ["writable-identity", "X2_INSTALLED_RUNTIME_UNSAFE_ASSET"],
    ["duplicate-descriptor", "X2_INSTALLED_RUNTIME_AMBIGUOUS_ASSET"],
    ["missing-required-role", "X2_INSTALLED_RUNTIME_REQUIRED_ASSET_MISSING"],
    ["changed-node-identity", "X2_INSTALLED_NODE_IDENTITY_CHANGED"],
    ["symlink-identity", "X2_INSTALLED_RUNTIME_PATH_CHANGED"],
    ["missing-identity", "ENOENT"], ["missing-runtime-directory", "ENOENT"],
  ] as const;
  const observed: Array<Record<string, unknown>> = [];
  const rewrite = async (path: string, bytes: Buffer, mode: number) => {
    await chmod(path, 0o600); await writeFile(path, bytes); await chmod(path, mode);
  };
  for (const [name, expectedReason] of cases) {
    // Preparation observes the real blocked worker while all original assets
    // are intact. A missing entrypoint cannot masquerade as a currentness fence.
    const delivery = await input.prepare(name);
    let movedIdentity = false, movedDirectory = false, linkedIdentity = false;
    const heldIdentity = join(evidence, "installed-" + name + "-identity.json");
    const heldDirectory = join(evidence, "installed-" + name + "-runtime");
    let passed = false;
    try {
      if (name === "changed-consumer-bytes")
        await rewrite(assetPath, Buffer.concat([assetBytes, Buffer.from("\n// owned installed-byte probe\n")]), assetMode);
      else if (name === "writable-consumer") await chmod(assetPath, 0o644);
      else if (name === "writable-identity") await chmod(identityPath, 0o644);
      else if (name === "duplicate-descriptor" || name === "missing-required-role" || name === "changed-node-identity") {
        const changed = structuredClone(identity);
        if (name === "duplicate-descriptor") changed.emittedFiles.push(changed.emittedFiles[0]);
        else if (name === "missing-required-role")
          changed.emittedFiles = changed.emittedFiles.filter((file: Asset) => file.path !== "finnor-os/x2-runtime/application-consumer.js");
        else changed.nodeBinarySha256 = "0".repeat(64);
        await rewrite(identityPath, Buffer.from(JSON.stringify(changed)), identityMode);
      } else if (name === "missing-runtime-directory") {
        await rename(directory, heldDirectory); movedDirectory = true;
      } else {
        await rename(identityPath, heldIdentity); movedIdentity = true;
        if (name === "symlink-identity") { await symlink(heldIdentity, identityPath); linkedIdentity = true; }
      }
      const result = await delivery.resume();
      observed.push({ name, expectedReason, observed: result, status: "FAIL", originalDelivery: true });
      assert(["STALE", "FAILED"].includes(result.status), "TAMPERED_INSTALLED_USE_WAS_NOT_FENCED");
      assert.equal(result.reason, expectedReason, "INSTALLED_TAMPER_STOPPED_AT_THE_WRONG_BOUNDARY");
      await input.assertNoMutation(name);
      passed = true;
    } finally {
      if (movedDirectory) await rename(heldDirectory, directory);
      if (linkedIdentity) await rename(identityPath, join(evidence, "installed-" + name + "-retained.link"));
      if (movedIdentity) await rename(heldIdentity, identityPath);
      await rewrite(identityPath, identityBytes, identityMode);
      await rewrite(assetPath, assetBytes, assetMode);
      await delivery.close();
      assert.equal(sha(await readFile(identityPath)), sha(identityBytes));
      assert.equal(sha(await readFile(assetPath)), sha(assetBytes));
      assert.equal((await lstat(identityPath)).mode & 0o777, identityMode);
      assert.equal((await lstat(assetPath)).mode & 0o777, assetMode);
      const row = observed.at(-1);
      if (row?.name === name) { row.status = passed ? "PASS" : "FAIL"; row.originalBytesAndModesRestored = true; }
      await writeFile(join(evidence, "installed-original-use-fences.json"), JSON.stringify({
        schema: "finnor.x2.installed-original-use-fences.v1", expected: cases,
        status: passed && observed.length === cases.length ? "PASS" : "INCOMPLETE",
        originalIdentitySha256: sha(identityBytes), originalConsumerSha256: sha(assetBytes), observed,
        qualification: "CLAIMED_EMITTED_ORIGINAL_USE_WITH_INDEPENDENT_ZERO_EGRESS_ASSERTIONS",
        positiveFreshBusiness: "REQUIRED_SEPARATELY_AFTER_RESTORATION",
      }, null, 2) + "\n", { mode: 0o600 });
    }
  }
  return { cases: observed, originalIdentitySha256: sha(identityBytes), positiveFreshBusiness: "REQUIRED_AFTER_RESTORATION" };
}
