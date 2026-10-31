import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coalitionRuntimeIdentity, coalitionSemanticIdentity } from "../../../../epistemic-runtime/src/project-z/z2-coalitions/process";
import { productRuntimeIdentity } from "../../interaction-synthesis/product-runtime";
import { byteDigest, digest, fail } from "../../interaction-synthesis/contracts";
import type { CoalitionProductRuntime } from "./contracts";
export const OWNER_ROOT = resolve(process.env.FINNOR_Z2_OWNER_ASSET_ROOT ?? dirname(fileURLToPath(import.meta.url)));
const OWNER_ASSETS = ["contracts.ts", "runtime.ts", "store.ts", "guard.ts", "worker.ts", "api.ts",
  "participant-work.ts", "participant-work-guard.ts",
  "../../../../orchestration/src/project-z/z2-coalitions/participant-work.ts",
  "../../../../../../src/components/centropy/canvas/InteractionProtocolPanel.tsx"];
export async function coalitionProductRuntime(): Promise<CoalitionProductRuntime> {
  const math = await coalitionRuntimeIdentity(), native = await productRuntimeIdentity();
  const ownerPins: CoalitionProductRuntime["ownerPins"] = [];
  const executionPath = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
    paths = [...OWNER_ASSETS.map(p => resolve(OWNER_ROOT, p)), executionPath];
  let executionOwnerPin: CoalitionProductRuntime["executionOwnerPin"] | undefined;
  for (const path of [...new Set(paths)]) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await fd.stat(), bytes = await fd.readFile(), after = await fd.stat();
      if (!before.isFile() || before.size > (path === executionPath ? 128*1048576 : 1048576) || before.ino !== after.ino ||
        before.size !== after.size || bytes.length !== before.size || before.mtimeMs !== after.mtimeMs)
        fail("Z2_OWNER_ASSET_CHANGED");
      const sha256 = byteDigest(bytes), index = OWNER_ASSETS.findIndex(p => resolve(OWNER_ROOT, p) === path);
      if (index >= 0) ownerPins.push({ path: OWNER_ASSETS[index]!, sha256 });
      if (path === executionPath) executionOwnerPin = { path, sha256 };
    } finally { await fd.close(); }
  }
  if (!executionOwnerPin) fail("Z2_EXECUTING_OWNER_PIN_REQUIRED");
  const semanticDigest = digest({ math: coalitionSemanticIdentity(math), nativeSemanticDigest: native.semanticDigest, ownerPins }),
    body = { schema: "finnor.project-z.z2.product-runtime.v1" as const, math,
      nativeSemanticDigest: native.semanticDigest, ownerPins, executionOwnerPin, semanticDigest };
  return { ...body, digest: digest(body) };
}
