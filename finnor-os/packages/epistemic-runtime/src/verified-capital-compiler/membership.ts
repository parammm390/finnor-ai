import {
  assertSnapshotMatchesModel, canonicalSerialize, d, sealInputSnapshot, semanticHash,
} from "../../../underwriting/src/index";
import type { UnderwritingInputSnapshot } from "../../../underwriting/src/types";
import type { R6CheckerReceipt } from "../../../shared-types/src/decision-proof";
import type { R6DomainMembership, R6ProofPacket } from "./contracts";
import { r6FixedInputMetadataDigest } from "./compiler";
import { assertR6NativeNumericPolicy } from "./native";

/** Pure mathematical applicability fence, not a proof-acceptance or authority
 * resolver. The caller must independently resolve the exact receipt and all
 * current owner dependencies. Even INSIDE permits no certified label/effect. */
export function checkDecisionProofDomainMembership(
  packet: R6ProofPacket,
  receipt: R6CheckerReceipt,
  actualSnapshot: UnderwritingInputSnapshot,
): R6DomainMembership {
  const domainDigest = semanticHash(packet.domain);
  let inputSnapshotDigest: string | null = null;
  const result = (status: R6DomainMembership["status"], reason: string | null): R6DomainMembership => ({
    status, reason, domainDigest, inputSnapshotDigest, certifiedLabelPermitted: false,
  });
  if (receipt.disposition !== "ACCEPTED" || !receipt.allInputEquivalence || !receipt.universallyValid
    || !receipt.nonemptyDomain || receipt.packetDigest !== semanticHash(packet)
    || receipt.proofDigest !== semanticHash(packet.proof)
    || receipt.nativeIdentityDigest !== semanticHash(packet.nativeIdentity)
    || receipt.checkerDigest !== packet.nativeIdentity.checkerDigest
    || packet.proof.domainDigest !== domainDigest) {
    return result("UNKNOWN", "No independently resolved accepted receipt binds this exact proof packet");
  }
  try {
    assertR6NativeNumericPolicy();
    const snapshot = sealInputSnapshot(actualSnapshot);
    inputSnapshotDigest = snapshot.semanticHash!;
    if (r6FixedInputMetadataDigest(snapshot) !== packet.domain.fixedInputMetadataDigest) {
      return result("OUTSIDE_DECLARED_DOMAIN", "Native owner/context/status/class/provenance/as-of metadata changed");
    }
    assertSnapshotMatchesModel(packet.compiledProgramme, snapshot);
    for (const binding of packet.domain.inputs) {
      const value = snapshot.values[binding.programmeNodeId]!.value;
      if (value === null) return result("OUTSIDE_DECLARED_DOMAIN", "A declared domain input is missing");
      const components: Record<string, unknown> = binding.shape === "scalar" ? { $scalar: value }
        : value as Record<string, unknown>;
      if (canonicalSerialize(Object.keys(components).sort())
        !== canonicalSerialize(Object.keys(binding.components).sort())) {
        return result("OUTSIDE_DECLARED_DOMAIN", "Actual series/period component coverage differs from D");
      }
      for (const [component, bound] of Object.entries(binding.components)) {
        const scalar = components[component];
        if (bound.kind === "DECIMAL_LATTICE") {
          if (typeof scalar !== "string") return result("OUTSIDE_DECLARED_DOMAIN", "A native decimal domain item is not a string");
          const quantity = d(scalar);
          if (quantity.lt(d(bound.minimum)) || quantity.gt(d(bound.maximum))
            || quantity.decimalPlaces() > bound.decimalPlaces) {
            return result("OUTSIDE_DECLARED_DOMAIN", "Actual quantity exceeds the proved bounds or decimal lattice");
          }
        } else if (!bound.values.some(allowed => typeof allowed === typeof scalar && allowed === scalar)) {
          return result("OUTSIDE_DECLARED_DOMAIN", "Actual enum value is not in D");
        }
      }
    }
    return result("INSIDE_DECLARED_DOMAIN", null);
  } catch (error) {
    return result("UNKNOWN", String(error));
  }
}
