/** Loaded development-method closure, not a production image attestation. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredCapabilitySourcePaths, assertCapabilitySourceClosure } from "./source-closure";
import { digest, fault } from "./contracts";

const sourceRequire = createRequire(import.meta.url);
const own = ["specialist-domain.ts", "specialist-source.ts", "specialist-port.ts", "specialist-consumer.ts",
  "specialist-publication-protocol.ts", "specialist-publication-authority.ts",
  "specialist-publication-lifecycle.ts", "specialist-publication-consumer.ts"];
const native = ["specialist-contract.ts", "specialist-iam-session.ts", "executor-specialist.ts", "executor-specialist-linux.ts",
  "executor.ts", "executor-linux.ts", "linux-node-policy.ts", "protocol.ts", "specialist-publication-witness.ts",
  "specialist-native-clock.ts", "specialist-root-custody.ts", "specialist-clock-evidence.ts",
  "specialist-clock-issuer.ts", "specialist-clock-qualification.ts", "specialist-original-attempt.ts", "specialist-root-collector.ts",
  "specialist-origin-collector-client.ts", "specialist-origin-context.ts", "specialist-origin-contract.ts",
  "specialist-origin-custody.ts", "specialist-origin-failure.ts", "specialist-origin-journal.ts",
  "specialist-origin-native.ts", "specialist-origin-observers.ts", "specialist-origin-owning-fixture.ts",
  "specialist-origin-s8.ts", "specialist-origin-service.ts", "specialist-origin-source.ts",
  "specialist-origin-verification.ts"];
const workforce = ["contracts.ts", "dependencies.ts", "index.ts", "native-authority.ts", "participants.ts",
  "protected-child.ts", "runtime.ts", "specialist.ts", "specialist-publication.ts", "specialist-original-source.ts", "store.ts", "worker.ts"];
export const workforceSpecialistSourcePaths = [...new Set([
  ...requiredCapabilitySourcePaths,
  ...own.map(path => fileURLToPath(new URL(path, import.meta.url))),
  ...native.map(path => fileURLToPath(new URL("../../governed-execution/src/" + path, import.meta.url))),
  ...workforce.map(path => fileURLToPath(new URL("../../orchestration/src/workforce-execution/" + path, import.meta.url))),
  ...["linux-launcher.c", "linux-lifetime.h", "linux-specialist.h", "linux-clock-sampler.c", "linux-specialist-origin-watch.c"]
    .map(path => fileURLToPath(new URL("../../governed-execution/native/" + path, import.meta.url))),
  ...["../../tools/src/llm.ts", "../../tools/src/model-context.ts", "../../tools/src/langfuse.ts",
    "../../db/compute-governor.ts", "../../db/execution-deadline.ts", "../../db/migration-order.ts",
    "../../db/migrations/0204_postz_w2_specialist_publication_authority.sql",
    "../../../scripts/postz-w2/specialist-publication-service.mts",
    "../../../scripts/postz-w2/specialist-origin-producers.mts",
    "../../orchestration/src/workforce-execution/specialist-publication-service.ts",
    "../../../scripts/frontier5/x1/build-development.mjs",
    "../../private-equity/src/workforce-allocation.ts", "../../private-equity/src/allocation-store.ts",
    "../../private-equity/src/workforce-compensation.ts", "../../private-equity/src/workforce-compensation-payment.ts",
    "../../private-equity/src/workforce-compensation-closing.ts", "../../authority/src/index.ts", "../../workforce/src/execution-program/schema.ts",
    "../../workforce/src/execution-program/checker.ts", "../../workforce/src/execution-program/exact.ts",
    "../../../apps/worker/src/queue.ts", "../../../apps/worker/src/job-heartbeat.ts",
    "../../../scripts/r3/package-linux-jail.mjs", "../../../Dockerfile.worker", "../../../package.json", "../../../package-lock.json",
    "../../../../package.json", "../../../../package-lock.json"]
    .map(path => fileURLToPath(new URL(path, import.meta.url))),
  ...["@aws-sdk/client-bedrock-runtime", "@aws-sdk/core", "@smithy/core", "@smithy/node-http-handler"]
    .map(name => sourceRequire.resolve(name)),
])].sort();
type SourcePin = { path: string; sha256: string };
const runtimeBounds = { packages: 256, pending: 4096, directories: 8192, files: 4096,
  manifestBytes: 262144, fileBytes: 16777216, totalBytes: 67108864, sourceBytes: 67108864,
  nodeBytes: 268435456 };
async function pinnedRuntimeFile(path: string, maximum = runtimeBounds.fileBytes) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > maximum) fault("S8_SPECIALIST_RUNTIME_FILE_BOUND", 503);
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await fd.read(bytes, used, bytes.length - used, null);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    const after = await fd.stat();
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino || after.dev !== before.dev)
      fault("S8_SPECIALIST_RUNTIME_CHANGED_DURING_READ", 503);
    return bytes.subarray(0, used);
  } finally { await fd.close(); }
}
async function pinnedRuntimeDigest(path: string, maximum = runtimeBounds.fileBytes) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > maximum) fault("S8_SPECIALIST_RUNTIME_FILE_BOUND", 503);
    const chunk = Buffer.alloc(65536), hash = createHash("sha256"); let bytes = 0;
    while (bytes <= before.size) {
      const next = await fd.read(chunk, 0, Math.min(chunk.length, before.size - bytes + 1), null);
      if (!next.bytesRead) break;
      bytes += next.bytesRead; hash.update(chunk.subarray(0, next.bytesRead));
    }
    const after = await fd.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino || after.dev !== before.dev)
      fault("S8_SPECIALIST_RUNTIME_CHANGED_DURING_READ", 503);
    return { sha256: hash.digest("hex"), bytes };
  } finally { await fd.close(); }
}

/** Root entrypoint pins alone do not cover Smithy transport, deserializers or
 * credential providers. Bind the resolved installed dependency graph and all
 * its runtime files, including multiple installed versions and optional misses.
 * This is a bounded loaded-development snapshot, not a production image seal. */
async function runtimePackageClosure() {
  const pending = ["@aws-sdk/client-bedrock-runtime", "pg", "zod", "drizzle-orm/node-postgres"]
    .map(name => sourceRequire.resolve(name)), seen = new Set<string>();
  const packages: Array<{ path: string; name: string; version: string; optionalMissing: string[] }> = [];
  const files: Array<SourcePin & { bytes: number }> = [];
  let totalBytes = 0, directoryCount = 0;
  while (pending.length) {
    const entrypoint = await realpath(pending.shift()!);
    let root = dirname(entrypoint), manifest: Record<string, unknown> | undefined;
    for (;;) {
      try {
        const candidate = JSON.parse((await pinnedRuntimeFile(join(root, "package.json"), runtimeBounds.manifestBytes)).toString());
        // dist-es/package.json may only say {"type":"module"}. It is not
        // the package identity or the dependency-resolution root.
        if (candidate && typeof candidate.name === "string" && typeof candidate.version === "string") {
          manifest = candidate; break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(root);
      if (parent === root) fault("S8_SPECIALIST_RUNTIME_PACKAGE_UNAVAILABLE", 503);
      root = parent;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    if (seen.size > runtimeBounds.packages || !manifest || typeof manifest.name !== "string" || typeof manifest.version !== "string")
      fault("S8_SPECIALIST_RUNTIME_PACKAGE_BOUND", 503);
    const resolver = createRequire(join(root, "package.json")), optionalMissing: string[] = [];
    const dependencies = manifest.dependencies as Record<string, string> | undefined;
    const optional = manifest.optionalDependencies as Record<string, string> | undefined;
    const peers = manifest.peerDependencies as Record<string, string> | undefined;
    const peerMetadata = manifest.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined;
    for (const name of [...new Set([...Object.keys(dependencies ?? {}), ...Object.keys(optional ?? {}), ...Object.keys(peers ?? {})])].sort()) {
      let resolved: string | undefined;
      try { resolved = resolver.resolve(name); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND"
          || (!optional?.[name] && !peerMetadata?.[name]?.optional)) throw error;
        optionalMissing.push(name);
      }
      if (resolved) pending.push(resolved);
      if (pending.length > runtimeBounds.pending) fault("S8_SPECIALIST_RUNTIME_DEPENDENCY_BOUND", 503);
    }
    packages.push({ path: root, name: manifest.name, version: manifest.version, optionalMissing });
    const directories = [root];
    while (directories.length) {
      const directory = directories.pop()!;
      if (++directoryCount > runtimeBounds.directories) fault("S8_SPECIALIST_RUNTIME_DIRECTORY_BOUND", 503);
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === "dist-types" || entry.name === ".git") continue;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) fault("S8_SPECIALIST_RUNTIME_INTERIOR_SYMLINK_UNSUPPORTED", 503);
        if (entry.isDirectory()) { directories.push(path); continue; }
        if (!/\.(?:[cm]?js|json|node|wasm)$/.test(entry.name)) continue;
        if (!entry.isFile() || (await lstat(path)).isSymbolicLink())
          fault("S8_SPECIALIST_RUNTIME_FILE_CUSTODY_INVALID", 503);
        const observed = await pinnedRuntimeDigest(path);
        totalBytes += observed.bytes;
        if (totalBytes > runtimeBounds.totalBytes || files.length >= runtimeBounds.files)
          fault("S8_SPECIALIST_RUNTIME_CLOSURE_BOUND", 503);
        files.push({ path, ...observed });
      }
    }
  }
  packages.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { packages, files, totalBytes };
}
const readIdentity = async () => {
  const sources: SourcePin[] = []; let sourceBytes = 0;
  for (const path of workforceSpecialistSourcePaths) {
    const observed = await pinnedRuntimeDigest(path); sourceBytes += observed.bytes;
    if (sourceBytes > runtimeBounds.sourceBytes) fault("S8_SPECIALIST_SOURCE_BYTES_BOUND", 503);
    sources.push({ path, sha256: observed.sha256 });
  }
  const packages = await runtimePackageClosure(), packageClosureDigest = digest(packages);
  return { sources, sourceClosureDigest: digest(sources), packageClosureDigest,
    runtimeDigest: digest({ node: process.version, platform: process.platform, architecture: process.arch,
      executableSha256: (await pinnedRuntimeDigest(process.execPath, runtimeBounds.nodeBytes)).sha256, packageClosureDigest }) };
};
const loaded = readIdentity();
void loaded.catch(() => undefined);
export async function installedWorkforceSpecialistIdentity() {
  const original = await loaded, current = await readIdentity();
  if (digest(original) !== digest(current)) fault("S8_SPECIALIST_LOADED_METHOD_CHANGED", 503);
  return original;
}
export async function assertWorkforceSpecialistSourceClosure(pins: SourcePin[]) {
  if (pins.length > 256 || new Set(pins.map(pin => pin.path)).size !== pins.length)
    fault("S8_SPECIALIST_SOURCE_PIN_BOUND_OR_DUPLICATE", 503);
  await assertCapabilitySourceClosure(pins);
  const installed = await installedWorkforceSpecialistIdentity();
  if (digest(pins) !== installed.sourceClosureDigest)
    fault("S8_SPECIALIST_SOURCE_CLOSURE_CHANGED", 503);
}
