/** Approved assets are part of the loaded source, never caller-supplied pins.
 * Verified bytes, rather than their mutable paths, go to the child process. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { PROFILE } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { z3Fault } from "./contracts";

export const Z3_APPROVED_ASSETS = Object.freeze({
  producerBundleDigest: "0925012e866e2195bae5ae2173c5863fe8b9294ac7ce6966d0100e98e0ec4793",
  checkerDigest: "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e",
  checkerAdapterDigest: "a7e1a84fdd1b8116e97b97d98afa9fd7913ae41282390ab3f3176da8696ba2b9",
});
export const Z3_APPROVED_HOST = Object.freeze({
  nodeVersion: "v22.23.4",
  nodeExecutableDigest: "94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90",
  pythonExecutableDigest: "e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f",
});
export interface ViabilityBuildIdentity {
  producerBundleDigest: string; checkerDigest: string; checkerAdapterDigest: string;
  nodeVersion: string; nodeExecutableDigest: string;
  pythonExecutable: string; pythonExecutableDigest: string;
}
export interface PinnedViabilityToolchain {
  producer: { path: string; source: string };
  checker: { path: string; source: string };
  pythonExecutable: string; identity: ViabilityBuildIdentity;
  revalidate(): Promise<void>;
}

async function boundedAsset(path: string, limit: number): Promise<Buffer> {
  if (!isAbsolute(path)) z3Fault("Z3_BUILD_ABSOLUTE_PATH_REQUIRED");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) z3Fault("Z3_BUILD_ARTIFACT_BOUND");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await fd.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await fd.stat();
    if (bytes.length !== before.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) z3Fault("Z3_BUILD_CHANGED_DURING_READ");
    return bytes;
  } finally { await fd.close(); }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function approved(path: string, expected: string, code: string) {
  const bytes = await boundedAsset(path, PROFILE.artifactBytes);
  if (digest(bytes) !== expected) z3Fault(code);
  return bytes.toString("utf8");
}

/** Linux first native profile. Host interpreters are trusted installation
 * dependencies, not replacement solvers. Their actual bytes are pinned on
 * module load and bound into every session and retained receipt. */
const hostIdentity = (async () => {
  if (process.platform !== "linux" || process.version !== Z3_APPROVED_HOST.nodeVersion) z3Fault("Z3_NATIVE_HOST_UNSUPPORTED");
  const pythonExecutable = await realpath("/usr/bin/python3");
  const identity = Object.freeze({
    nodeVersion: process.version,
    nodeExecutable: await realpath(process.execPath),
    nodeExecutableDigest: digest(await boundedAsset(await realpath(process.execPath), 256 * 1024 * 1024)),
    pythonExecutable,
    pythonExecutableDigest: digest(await boundedAsset(pythonExecutable, 64 * 1024 * 1024)),
  });
  if (identity.nodeExecutableDigest !== Z3_APPROVED_HOST.nodeExecutableDigest
    || identity.pythonExecutableDigest !== Z3_APPROVED_HOST.pythonExecutableDigest) z3Fault("Z3_HOST_INTERPRETER_NOT_APPROVED");
  return identity;
})();
// Keep a rejected startup promise observed until an actual caller awaits it.
void hostIdentity.catch(() => undefined);

export async function pinViabilityToolchain(paths: {
  producerBundle: string; checkerSource: string; checkerAdapterSource?: string;
}): Promise<PinnedViabilityToolchain> {
  if (process.env.FINNOR_Z3_PYTHON) z3Fault("Z3_CALLER_SELECTED_INTERPRETER_UNSUPPORTED");
  const host = await hostIdentity;
  const producer = { path: paths.producerBundle, source: await approved(paths.producerBundle,
    Z3_APPROVED_ASSETS.producerBundleDigest, "Z3_PRODUCER_ASSET_NOT_APPROVED") };
  const originalSource = await approved(paths.checkerSource,
    Z3_APPROVED_ASSETS.checkerDigest, "Z3_CHECKER_ASSET_NOT_APPROVED");
  const adapterPath = paths.checkerAdapterSource ?? join(dirname(paths.checkerSource), "nonconflicting-checker.py");
  const adapterSource = await approved(adapterPath,
    Z3_APPROVED_ASSETS.checkerAdapterDigest, "Z3_CHECKER_ADAPTER_ASSET_NOT_APPROVED");
  // Both sources are captured verified bytes. The child cannot re-import a
  // mutable adjacent path, and the original checker file stays unchanged.
  const checker = { path: paths.checkerSource, source: [
    "import base64 as _z3_b64, types as _z3_types",
    "_original_checker = _z3_types.ModuleType('finnor_z3_original_checker')",
    `exec(compile(_z3_b64.b64decode("${Buffer.from(originalSource).toString("base64")}"), "<approved-original-checker>", "exec"), _original_checker.__dict__)`,
    adapterSource,
  ].join("\n") };
  const identity: ViabilityBuildIdentity = Object.freeze({
    ...Z3_APPROVED_ASSETS, nodeVersion: host.nodeVersion,
    nodeExecutableDigest: host.nodeExecutableDigest,
    pythonExecutable: host.pythonExecutable, pythonExecutableDigest: host.pythonExecutableDigest,
  });
  return {
    producer, checker, pythonExecutable: host.pythonExecutable, identity,
    async revalidate() {
      if (process.env.FINNOR_Z3_PYTHON) z3Fault("Z3_CALLER_SELECTED_INTERPRETER_UNSUPPORTED");
      await approved(producer.path, identity.producerBundleDigest, "Z3_PRODUCER_ASSET_NOT_APPROVED");
      await approved(checker.path, identity.checkerDigest, "Z3_CHECKER_ASSET_NOT_APPROVED");
      await approved(adapterPath, identity.checkerAdapterDigest, "Z3_CHECKER_ADAPTER_ASSET_NOT_APPROVED");
      if (await realpath("/usr/bin/python3") !== host.pythonExecutable
        || digest(await boundedAsset(host.pythonExecutable, 64 * 1024 * 1024)) !== host.pythonExecutableDigest
        || digest(await boundedAsset(host.nodeExecutable, 256 * 1024 * 1024)) !== host.nodeExecutableDigest) {
        z3Fault("Z3_HOST_INTERPRETER_CHANGED");
      }
    },
  };
}
