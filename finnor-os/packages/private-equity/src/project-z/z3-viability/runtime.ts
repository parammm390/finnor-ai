import { codeIdentity } from "../../evidence-execution/store";
import { hash, z3Fault } from "./contracts";
import { pinViabilityToolchain } from "./assets";

/** Includes the approved emitted producer, checker AND host interpreters.
 * Global source identity already covers the native owner/consumer TS leaves.
 * Assets are re-opened and checked before reuse or any boundary publication. */
export async function viabilityRuntimeIdentity() {
  const producerBundle = process.env.FINNOR_Z3_PRODUCER_BUNDLE?.trim() ?? "";
  const checkerSource = process.env.FINNOR_Z3_CHECKER_SOURCE?.trim() ?? "";
  if (!producerBundle || !checkerSource) z3Fault("Z3_PRODUCER_BUILD_UNPINNED");
  const toolchain = await pinViabilityToolchain({ producerBundle, checkerSource });
  await toolchain.revalidate();
  const source = await codeIdentity();
  return { digest: hash({ schema: "finnor.z3.loaded-runtime.v2",
    sourceDigest: source.digest, assets: toolchain.identity }),
    sourceDigest: source.digest, assets: toolchain.identity, toolchain };
}
