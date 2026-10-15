import type { ExperimentRef } from "./experiments";

export interface ExactApplicationQuantity {
  kind: "quantity";
  decimal: string;
  currency: string;
  entity: string;
  unit: string;
  time: string;
  basis: string;
}
export interface ScopedApplicationIdentity {
  kind: "identity";
  application: string;
  account: string;
  entity: string;
  id: string;
}
export type ApplicationScalar = string | boolean | null | ExactApplicationQuantity | ScopedApplicationIdentity;
export type ApplicationState = Record<string, ApplicationScalar>;
export type ApplicationOperand =
  | { kind: "literal"; value: ApplicationScalar }
  | { kind: "parameter"; name: string };
export type ApplicationAssignmentOperand = ApplicationOperand | { kind: "field"; field: string };
export interface ApplicationPredicate {
  all: Array<{ field: string; operator: "present" | "eq" | "neq" | "in"; values: ApplicationOperand[] }>;
}
export interface ApplicationParameter {
  name: string;
  kind: "text" | "boolean" | "enum" | "quantity" | "identity";
  required: boolean;
  values: ApplicationScalar[];
  maxLength: number;
  quantityContext: {
    currencies: string[]; units: string[]; bases: string[]; maxDecimalPlaces: number;
    entityBinding: "CURRENT_AUTHORIZED_TARGET"; timeBinding: "EXACT_CALLER_BINDING";
  } | null;
  schemaEvidence: ExperimentRef[];
}
export interface ApplicationField {
  path: string;
  kind: "text" | "boolean" | "enum" | "quantity" | "identity";
  nullable: boolean;
  observedValues: ApplicationScalar[];
  observationRefs: ExperimentRef[];
}
export interface ApplicationScope {
  tenantId: string;
  principalId: string;
  application: string;
  account: string;
  role: string;
  grantRef: ExperimentRef;
  rightsRef: string;
}
/** Authenticated S4 projection, not the private preimage or a new authority. */
export interface ApplicationFreshAuthorityView {
  schema: "finnor.x2.application-fresh-authority-view.v1";
  ref: ExperimentRef;
  sessionId: string;
  parentId: string;
  tenantId: string;
  principalId: string;
  workId: string;
  originalParentRef: ExperimentRef;
  modelRef: ExperimentRef;
  checkRef: ExperimentRef;
  rightsRef: string;
  target: ScopedApplicationIdentity;
  deadlineAt: string;
  bindings: Array<{
    profileId: string;
    role: string;
    applicationAccountId: string;
    originalGrantRef: ExperimentRef;
    currentGrantRef: ExperimentRef;
    operationIds: string[];
  }>;
  qualification: "AUTHENTICATED_CANONICAL_S4_PROJECTION_NOT_AN_AUTHORITY_GRANT";
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  protectedAdmission: false;
  executionAuthorityGranted: false;
}
export interface ApplicationSnapshot {
  schema: "finnor.x2.application-snapshot.v1";
  scope: ApplicationScope;
  target: ScopedApplicationIdentity;
  applicationRevision: string;
  recordRevision: string;
  schemaDigest: string;
  sourceRef: ExperimentRef;
  observedAt: string;
  state: ApplicationState;
  unavailableFields: string[];
  observationQualification: "LAWFUL_INDEPENDENT_READBACK" | "PERMITTED_DISCOVERY_OBSERVATION";
  structuralWitness?: ApplicationStructuralWitness;
}
/** Original observable structure, not invented descendants or effect semantics. */
export interface ApplicationStructuralWitness {
  schema: "finnor.x2.structural-observation-witness.v1";
  observerContractRef: ExperimentRef;
  publishedSchemaDigest: string | null;
  leaves: Record<string, unknown>;
  leafKinds: Record<string, ApplicationField["kind"]>;
  availablePaths: string[];
  unavailablePaths: string[];
  nullPrefixes: string[];
  optionalAbsentPaths: string[];
}
export interface ApplicationTransitionEvidence {
  schema: "finnor.x2.transition-evidence.v1";
  ref: ExperimentRef;
  originalParentRef: ExperimentRef;
  operationId: string;
  parameters: ApplicationState;
  before: ApplicationSnapshot;
  after: ApplicationSnapshot | null;
  disposition: "OBSERVED" | "REJECTED" | "PENDING" | "UNKNOWN";
  responseRef: ExperimentRef;
  effectRef: ExperimentRef | null;
  obligationRef: ExperimentRef | null;
  chargeRefs: ExperimentRef[];
  failureCode: string | null;
  possibleEgress: boolean;
  prediction: ApplicationState | null;
  independentOutcome: "ESTABLISHED" | "DENIED" | "UNAVAILABLE";
}
export interface LearnedApplicationOperation {
  id: string;
  label: string;
  parameters: ApplicationParameter[];
  /** Evidence-derived fresh readback bindings, never demonstration identities. */
  observedParameterBindings: Record<string, string>;
  precondition: ApplicationPredicate;
  postcondition: {
    assignments: Array<{ field: string; value: ApplicationAssignmentOperand }>;
    unchanged: string[];
    completion: "INDEPENDENT_OBSERVATION_REQUIRED";
    asynchronous: boolean;
    unknownFields: string[];
    alternatives: ApplicationState[];
  };
  reads: string[];
  writes: string[];
  effects: {
    classification: "OBSERVATION" | "STATE_MUTATION" | "POSSIBLY_CONSEQUENTIAL";
    replay: "NEVER_AFTER_POSSIBLE_EGRESS";
    observationFields: string[];
  };
  authorization: {
    role: string;
    grantRef: ExperimentRef;
    commitment: "CURRENT_NATIVE_AND_EXTERNAL_AUTHORITY_REQUIRED";
  };
  resources: { originalParentRequired: true; maximumInteractions: number; unresolvedEffects: number };
  observerContractRef: ExperimentRef;
  privateBindingRef: ExperimentRef;
  semanticRevision: string;
  renderingDigest: string;
  dependencies: ExperimentRef[];
  evidenceRefs: ExperimentRef[];
  uncertainty: {
    identification: "EVIDENCE_SUPPORTED" | "PARTIALLY_IDENTIFIED" | "UNKNOWN";
    assumptions: string[];
    unobservedCases: string[];
    falsifierRefs: ExperimentRef[];
  };
}
export interface FrontierArtifactEnvelope {
  schema: "finnor.frontier-artifact-envelope.v1";
  frontier: "FRONTIER5.X2";
  owningInterface: "application-operation-v1";
  artifact_id: string;
  kind: "ApplicationActionModel";
  schema_revision: string;
  content_digest: string;
  tenant_ref: ExperimentRef;
  work_ref: ExperimentRef;
  institutional_program_ref: ExperimentRef | null;
  parent_artifact_refs: ExperimentRef[];
  producer_revision: ExperimentRef;
  baseline_manifest_ref: ExperimentRef;
  authority_grant_ref: ExperimentRef;
  rights_revision: string;
  resource_grant_ref: ExperimentRef;
  source_refs: ExperimentRef[];
  source_revision_vector: Record<string, string>;
  knowledge_cut: string;
  admitted_domain_ref: ExperimentRef | null;
  application_fingerprints: Record<string, string>;
  model_refs: ExperimentRef[];
  dependency_lock_digest: string;
  runtime_digest: string;
  observed_claims: ExperimentRef[];
  inferred_claims: ExperimentRef[];
  predicted_claims: ExperimentRef[];
  unresolved_claims: Array<{ code: string; reference: ExperimentRef | null }>;
  postcondition_contract_refs: ExperimentRef[];
  independent_check_refs: ExperimentRef[];
  S6_obligation_refs: ExperimentRef[];
  provider_observation_refs: ExperimentRef[];
  invalidation_dependencies: ExperimentRef[];
  lifecycle_state: "GENERATED" | "CHECKED" | "CURRENT" | "STALE" | "REVOKED" | "UNKNOWN";
  lifecycle_events: ExperimentRef[];
  build_learning_compute_cost_refs: ExperimentRef[];
  attributable_human_work_refs: ExperimentRef[];
  revisionRef: ExperimentRef;
  parentRefs: ExperimentRef[];
  sourceRefs: ExperimentRef[];
  evidenceRefs: ExperimentRef[];
  grammarRef: ExperimentRef;
  checkerRef: ExperimentRef;
  runtimeRef: ExperimentRef;
  dependencyPins: Array<{ path: string; sha256: string }>;
  originalParentRef: ExperimentRef;
  validAfter: string;
  validUntil: string;
  supportedDomain: {
    substrates: Array<"API" | "UI" | "HYBRID">;
    maxOperations: number;
    maxStateFields: number;
    maxParameters: number;
    maxExplorationInteractions: number;
    maxObservations: number;
    maxCompositionOperations: number;
    maxSearchNodes: number;
    maxBranches: number;
    maxUnresolvedEffects: number;
    quantityArithmetic: "EXACT_DECIMAL_TEXT_AND_CONTEXT";
    freshTargets: "CURRENT_AUTHORIZED_BINDING_REQUIRED";
  };
  provenance: {
    observationsSeparatedFromPredictions: true;
    externalConformance: "EMPIRICAL_WITHIN_RETAINED_EVIDENCE_NOT_UNIVERSAL";
    privateFactsAndCredentialsExported: false;
  };
  executionAuthorityGranted: false;
  protectedAdmission: false;
}
export interface ApplicationActionModel {
  schema: "finnor.x2.application-action-model.v1";
  ref: ExperimentRef;
  envelope: FrontierArtifactEnvelope;
  scope: ApplicationScope;
  application_identity_and_version_evidence: ExperimentRef[];
  observable_state_schema: ApplicationField[];
  operation_signatures: Array<{ operationId: string; parameters: ApplicationParameter[] }>;
  parameter_and_unit_constraints: ExperimentRef[];
  precondition_predicates: Array<{ operationId: string; predicate: ApplicationPredicate }>;
  effect_and_obligation_contracts: ExperimentRef[];
  postcondition_observers: ExperimentRef[];
  transition_model_and_uncertainty: ExperimentRef[];
  compositional_rules: ExperimentRef[];
  permitted_exploration_record: ExperimentRef[];
  drift_detectors: ExperimentRef[];
  held_out_execution_evidence: ExperimentRef[];
  supported_domain: FrontierArtifactEnvelope["supportedDomain"];
  stateSchema: ApplicationField[];
  operations: LearnedApplicationOperation[];
  source_observations: ExperimentRef[];
  declared_type_signatures: ExperimentRef[];
  inferred_preconditions: ExperimentRef[];
  inferred_postconditions: ExperimentRef[];
  generated_interaction_code: ExperimentRef[];
  checker_results: ExperimentRef[];
  falsifier_tests: ExperimentRef[];
  actual_independent_outcomes: ExperimentRef[];
  validities: {
    scope: "PRINCIPAL_ACCOUNT_ROLE_GRANT_BOUND";
    rendering: "LAWFUL_PRIVATE_BINDING_REVALIDATION_REQUIRED";
    semantic: "FENCE_MINIMAL_SOUND_DEPENDENCY_CLOSURE";
    missingEvidence: "UNKNOWN";
  };
}
export interface ApplicationModelCheck {
  schema: "finnor.x2.model-check.v1";
  ref: ExperimentRef;
  modelRef: ExperimentRef;
  originalEvidenceRefs: ExperimentRef[];
  checkerRef: ExperimentRef;
  checkedAt: string;
  disposition: "ACCEPTED_EVIDENCED_DOMAIN" | "COUNTEREXAMPLE" | "UNKNOWN" | "UNSUPPORTED";
  falseValid: number;
  falseInvalid: number;
  counterexamples: Array<{ operationId: string; evidenceRef: ExperimentRef; code: string }>;
  acceptedOperationIds: string[];
  externalUniversalProof: false;
}
export interface CheckedApplicationComposition {
  schema: "finnor.x2.checked-composition.v1";
  ref: ExperimentRef;
  modelRef: ExperimentRef;
  checkRef: ExperimentRef;
  originalParentRef: ExperimentRef;
  scope: ApplicationScope;
  target: ScopedApplicationIdentity;
  initialObservationRef: ExperimentRef;
  goal: ApplicationState;
  steps: Array<{ id: string; operationId: string; parameters: ApplicationState; parameterObservations: Record<string, string>; expectedState: ApplicationState; conditionalState: ApplicationState; observationRequired: true }>;
  exploredNodes: number;
  gaps: Array<{ stepId: string; code: string; observationRequired: true }>;
  disposition: "COMPOSED_WITH_REQUIRED_OBSERVATIONS" | "UNKNOWN" | "UNSUPPORTED";
  deadlineAt: string;
  executionAuthorityGranted: false;
}

export type ApplicationResourceEnvelope = import("./allocation").AllocationEnvelope;
export interface ApplicationAllocationCertificate {
  schema: "finnor.s5.application-allocation.v1";
  ref: ExperimentRef;
  tenantId: string;
  principalId: string;
  originalParentRef: ExperimentRef;
  preparationRef: ExperimentRef;
  rightsRef: string;
  workId: string;
  deadlineAt: string;
  createdAt: string;
  resourceRefs: ExperimentRef[];
  policyBindings: Array<{ policyRef: ExperimentRef; demandDigest: string }>;
  check: { envelopes: ApplicationResourceEnvelope[]; exactResourceCheck: true };
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  executionAuthorityGranted: false;
}
export interface ApplicationAllocationConsumption {
  schema: "finnor.s5.application-consumption.v1";
  ref: ExperimentRef;
  originalParentRef: ExperimentRef;
  certificateRef: ExperimentRef;
  reservationRef: ExperimentRef;
  preparationRef: ExperimentRef;
  operationRef: ExperimentRef;
  nodeId: string;
  idempotencyKey: string;
  requestDigest: string;
  createdAt: string;
  predecessorObservationRef: ExperimentRef;
  envelope: ApplicationResourceEnvelope[];
  status: "INTENDED_PENDING_S6" | "UNKNOWN_OUTCOME" | "RECONCILED";
  effectRef: ExperimentRef | null;
  executionAuthorityGranted: false;
}
export interface ApplicationOperationObligation {
  schema: "finnor.s6.application-obligation.v1";
  ref: ExperimentRef;
  tenantId: string;
  principalId: string;
  rightsRef: string;
  workId: string;
  originalParentRef: ExperimentRef;
  allocationRef: ExperimentRef;
  reservationRef: ExperimentRef;
  consumptionRef: ExperimentRef;
  preparationRef: ExperimentRef;
  modelRef: ExperimentRef | null;
  checkRef: ExperimentRef | null;
  operationRef: ExperimentRef;
  privateBindingRef: ExperimentRef;
  observerContractRef: ExperimentRef;
  target: ScopedApplicationIdentity;
  parameters: ApplicationState;
  before: ApplicationSnapshot;
  effectRef: { id: string; semanticHash: string; schemaVersion: 1 };
  domainActionId: string;
  resourceEnvelope: ApplicationResourceEnvelope[];
  deadlineAt: string;
  preparedAt: string;
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  replay: "NEVER_AFTER_POSSIBLE_EGRESS";
  executionAuthorityGranted: false;
  protectedReceipt: null;
}
