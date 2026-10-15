import type { FrontierArtifactEnvelope } from "@finnor/shared-types";
import type { ApplicationModelEnvelopeInput } from "./ports";
import { FrontierArtifactEnvelopeSchema } from "./contracts";

export function buildApplicationEnvelope(input: ApplicationModelEnvelopeInput): FrontierArtifactEnvelope {
  const { parent, semanticRevisionRef: revision } = input;
  const domain = {
    substrates: [input.substrate], maxOperations: 16, maxStateFields: 16,
    maxParameters: 8, maxExplorationInteractions: 64, maxObservations: 256,
    maxCompositionOperations: 8, maxSearchNodes: 64, maxBranches: 8,
    maxUnresolvedEffects: 1, quantityArithmetic: "EXACT_DECIMAL_TEXT_AND_CONTEXT",
    freshTargets: "CURRENT_AUTHORIZED_BINDING_REQUIRED",
  };
  return FrontierArtifactEnvelopeSchema.parse({
    schema: "finnor.frontier-artifact-envelope.v1", frontier: "FRONTIER5.X2",
    owningInterface: "application-operation-v1", artifact_id: revision.id,
    kind: "ApplicationActionModel", schema_revision: "1", content_digest: revision.contentDigest,
    tenant_ref: parent.tenantRef, work_ref: parent.workRef,
    institutional_program_ref: parent.institutionalProgramRef,
    parent_artifact_refs: [parent.originalParentRef], producer_revision: parent.producerRef,
    baseline_manifest_ref: parent.baselineManifestRef, authority_grant_ref: parent.authorityGrantRef,
    rights_revision: parent.rightsRevision, resource_grant_ref: parent.resourceGrantRef,
    source_refs: input.sourceRefs, source_revision_vector: { application: revision.contentDigest },
    knowledge_cut: new Date().toISOString(), admitted_domain_ref: null,
    application_fingerprints: { source: revision.contentDigest },
    model_refs: [revision], dependency_lock_digest: parent.dependencyLockDigest,
    runtime_digest: parent.runtimeDigest, observed_claims: input.evidenceRefs,
    inferred_claims: input.inferredRefs, predicted_claims: [],
    unresolved_claims: [
      { code: "FINITE_EVIDENCE_DOES_NOT_IDENTIFY_UNIVERSAL_EXTERNAL_BEHAVIOR", reference: null },
      { code: "PROTECTED_S8_APPLICATION_DOMAIN_NOT_ADMITTED", reference: null },
      ...(parent.institutionalProgramRef ? [] : [{ code: "STANDALONE_X2_WORK_NOT_X1_INSTITUTIONAL_PROGRAM", reference: null }]),
    ],
    postcondition_contract_refs: input.observerRefs, independent_check_refs: [],
    S6_obligation_refs: input.obligationRefs, provider_observation_refs: input.evidenceRefs,
    invalidation_dependencies: input.dependencies, lifecycle_state: "GENERATED", lifecycle_events: [],
    build_learning_compute_cost_refs: parent.costRefs, attributable_human_work_refs: parent.humanWorkRefs,
    revisionRef: revision, parentRefs: [parent.originalParentRef], sourceRefs: input.sourceRefs,
    evidenceRefs: input.evidenceRefs, grammarRef: parent.grammarRef, checkerRef: parent.checkerRef,
    runtimeRef: parent.runtimeRef, dependencyPins: parent.dependencyPins,
    originalParentRef: parent.originalParentRef, validAfter: parent.validAfter, validUntil: parent.deadlineAt,
    supportedDomain: domain,
    provenance: {
      observationsSeparatedFromPredictions: true,
      externalConformance: "EMPIRICAL_WITHIN_RETAINED_EVIDENCE_NOT_UNIVERSAL",
      privateFactsAndCredentialsExported: false,
    },
    executionAuthorityGranted: false, protectedAdmission: false,
  });
}
