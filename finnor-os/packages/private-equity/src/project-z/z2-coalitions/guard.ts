import type { PoolClient } from "pg";
import { resolve } from "node:path";
import { digest, fail } from "../../interaction-synthesis/contracts";
import type { ProtocolRow, InteractionTerms } from "../../interaction-synthesis/product-contracts";
import { Z2_PRODUCT_LOCK, Z2_VERSION, LIMITS } from "../../../../epistemic-runtime/src/project-z/z2-coalitions/contracts";
import { ASSET_ROOT } from "../../../../epistemic-runtime/src/project-z/z2-coalitions/process";
import { coalitionProductRuntime } from "./runtime";
import type { CoalitionProductRuntime, CoalitionTermsContract, NativeCoalitionArtifact } from "./contracts";

export interface CoalitionMarker {
  schema: "finnor.project-z.z2.required.v1"; requestDigest: string; runtime: CoalitionProductRuntime;
  productLockDigest: string; nativeOwnerContract: string;
}
export async function coalitionMarkerTx(c: PoolClient, row: ProtocolRow): Promise<CoalitionMarker | null> {
  return (await c.query<{ body: CoalitionMarker }>(`SELECT body FROM finnor_os.y3_events
    WHERE tenant_id=$1 AND protocol_id=$2 AND event_key='z2-required' AND kind='Z2_REQUIRED' FOR SHARE`,
    [row.tenant_id, row.id])).rows[0]?.body ?? null;
}

/** No native store import: this hook can be installed at the original owner boundary without a store cycle. */
export async function coalitionChangesTx(c: PoolClient, row: ProtocolRow) {
  const marker = await coalitionMarkerTx(c, row), artifact = row.artifact as NativeCoalitionArtifact | null;
  if (!marker) return artifact?.coalition ? ["z2-required-marker"] : [];
  const changed: string[] = [], { digest: markerDigest, ...markerRuntime } = marker.runtime;
  if (marker.schema !== "finnor.project-z.z2.required.v1" || marker.requestDigest !== row.request_digest ||
    marker.productLockDigest !== Z2_PRODUCT_LOCK || digest(markerRuntime) !== markerDigest ||
    marker.nativeOwnerContract !== "INTERACTION_PROTOCOL_S4_EXACT_TERMS_CONSENT_S5_S6_V1") changed.push("z2-original-binding");
  if (marker.runtime.nativeSemanticDigest !== row.runtime.semanticDigest ||
    (await coalitionProductRuntime()).semanticDigest !== marker.runtime.semanticDigest) changed.push("z2-runtime");
  if (row.status === "CHECKED") {
    try { assertCoalitionCertificate(row, marker); } catch { changed.push("z2-certificate"); }
  }
  return changed;
}

function assertCoalitionCertificate(row: ProtocolRow, marker: CoalitionMarker) {
  const artifact = row.artifact as NativeCoalitionArtifact | null, proof = artifact?.coalition, check = proof?.check;
  if (row.status !== "CHECKED" || !proof || proof.schema !== "finnor.coalition-resilient-protocol.v1" ||
    proof.nativeProtocolId !== row.id || proof.originalRequestDigest !== row.request_digest ||
    proof.problemDigest !== digest(row.request.problem) || proof.candidateDigest !== digest(row.candidate) ||
    proof.runtime.semanticDigest !== marker.runtime.semanticDigest || proof.productLockDigest !== Z2_PRODUCT_LOCK ||
    digest(proof.nativeProtocolRef) !== digest(artifact.envelope.contentRef) ||
    proof.nativeOwnerContract !== "INTERACTION_PROTOCOL_S4_EXACT_TERMS_CONSENT_S5_S6_V1" ||
    proof.original.tenantId !== row.tenant_id || proof.original.principalId !== row.principal_id ||
    proof.original.workId !== row.work_id || proof.original.workInputId !== row.work_input_id ||
    proof.original.workInputDigest !== row.work_input_digest || digest(proof.original.root) !== digest(row.root) ||
    proof.original.episodeId !== row.episode_id || proof.original.deadlineAt !== row.deadline_at.toISOString() ||
    proof.original.rightsRevision !== row.rights_revision || proof.original.attemptsUsed > row.attempts_used ||
    proof.original.searchStepsOccupied > row.search_steps_used || proof.original.retainedBytes > row.retained_bytes ||
    proof.incentiveConcept !== LIMITS.concept || proof.coalitionLimit !== LIMITS.coalitionLimit ||
    digest(proof.excludedThreatClasses) !== digest(LIMITS.excluded) ||
    proof.construction.status !== "CANDIDATE" || digest(proof.construction.candidate) !== digest(row.candidate) ||
    proof.qualification.protectedAdmission !== false || proof.qualification.productionActivated !== false ||
    check?.status !== "CHECKED_CANDIDATE" || check.candidateDigest !== digest(row.candidate) ||
    check.constructionDigest !== digest(proof.construction) || check.problemDigest !== digest(row.request.problem) ||
    check.profileDigest !== marker.runtime.math.profileDigest || check.allModels !== true ||
    check.processDigest !== marker.runtime.math.assets.find(a => a.path === resolve(ASSET_ROOT, "checker.py"))?.sha256 ||
    check.allNonemptyCoalitions !== true || check.nativeFullSequentialAndCommonTremble !== true ||
    check.protectedQualification !== false || check.executionAuthorityGranted !== false)
    fail("Z2_CURRENT_INDEPENDENT_CERTIFICATE_REQUIRED");
  const { ref, ...body } = proof;
  if (ref.owner !== "Z2" || ref.version !== Z2_VERSION || ref.id !== "coalition:"+digest(body) ||
    ref.contentDigest !== digest(body)) fail("Z2_PRINCIPAL_ARTIFACT_PREIMAGE");
}

/** Coordinator calls this at the existing checkedProtocolTx owner boundary. */
export async function assertCoalitionCurrentTx(c: PoolClient, row: ProtocolRow) {
  const marker = await coalitionMarkerTx(c, row), artifact = row.artifact as NativeCoalitionArtifact | null;
  if (!marker) { if (artifact?.coalition) fail("Z2_REQUIRED_MARKER_MISSING"); return; }
  if ((await coalitionChangesTx(c, row)).length) fail("Z2_CURRENT_ORIGINAL_DEPENDENCIES_REQUIRED");
  assertCoalitionCertificate(row, marker);
}

/** Spread into the original S4 terms preimage, never a separate consent or grant. */
export function coalitionTermsBinding(row: ProtocolRow): { coalition?: CoalitionTermsContract } {
  const proof = (row.artifact as NativeCoalitionArtifact | null)?.coalition;
  if (!proof) return {};
  if (!proof.check.processDigest) fail("Z2_CHECKER_IDENTITY_REQUIRED");
  return { coalition: {
    schema: "finnor.project-z.z2.terms-contract.v1", certificateRef: proof.ref,
    nativeProtocolRef: proof.nativeProtocolRef, productLockDigest: proof.productLockDigest,
    runtimeSemanticDigest: proof.runtime.semanticDigest, checkerDigest: proof.check.processDigest,
    incentiveConcept: proof.incentiveConcept, coalitionLimit: proof.coalitionLimit,
    excludedThreatClasses: proof.excludedThreatClasses, modelStatus: "SUPPLIED_EXACT_MODELS_NOT_FIELD_IDENTIFICATION",
    actualCompliance: "UNKNOWN", privateProofDataIncluded: false, protectedAdmission: false,
    productionActivated: false, executionAuthorityGranted: false,
  } };
}

/** Coordinator installs this in the existing termsTx and visibleTerms boundaries. */
export function assertCoalitionTerms(row: ProtocolRow, terms: InteractionTerms) {
  const expected = coalitionTermsBinding(row).coalition;
  const actual = (terms as InteractionTerms & { coalition?: CoalitionTermsContract }).coalition;
  if (digest(expected ?? null) !== digest(actual ?? null)) fail("Z2_EXACT_COALITION_TERMS_REQUIRED");
}
