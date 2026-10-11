import { z } from "zod";

export const X1_NATIVE_SOURCE_CONTRACT = "finnor.x1.native-source-interpretation.v1" as const;
export const X1_CHECKER_PROCESS_CONTRACT = "finnor.x1.checker-process.v1" as const;

/** Logical immutable artifact contracts. An owner reference is not an owner receipt. */
const NonEmpty = z.string().min(1);
const IsoInstant = z.string().datetime({ offset: true });
export const UnknownBinding = z.object({
  status: z.literal("unknown"),
  reason: NonEmpty,
  affectedRefs: z.array(NonEmpty),
  requiredOwnerOrInput: NonEmpty,
}).strict();
export const KnownBinding = z.object({
  status: z.literal("known"),
  owner: z.enum(["S1", "S4_P1", "S5", "S6", "S7", "S8", "P7", "Work", "source", "runtime"]),
  kind: NonEmpty,
  ref: NonEmpty,
  revision: NonEmpty,
  digest: NonEmpty,
  tenantRef: NonEmpty,
  institutionRef: NonEmpty,
  rightsRevision: NonEmpty,
  knowledgeCut: IsoInstant,
}).strict();
export const Binding = z.discriminatedUnion("status", [KnownBinding, UnknownBinding]);
export type Binding = z.infer<typeof Binding>;

const ClaimBase = z.object({
  statement: NonEmpty,
  witnessRefs: z.array(NonEmpty),
  domainRef: NonEmpty,
  occurrenceAt: IsoInstant.optional(),
  availableAt: IsoInstant.optional(),
  knowledgeCut: IsoInstant,
}).strict();
export const ObservedClaim = ClaimBase.extend({ basis: z.literal("observed"), sourceRef: NonEmpty }).strict();
export const InferredClaim = ClaimBase.extend({ basis: z.literal("inferred"), alternatives: z.array(NonEmpty), checkRef: Binding }).strict();
export const PredictedClaim = ClaimBase.extend({ basis: z.literal("predicted"), modelRef: Binding, falsifier: NonEmpty }).strict();
export const UnresolvedClaim = ClaimBase.extend({ basis: z.literal("unresolved"), reason: NonEmpty, requiredOwnerOrInput: NonEmpty, affectedRefs: z.array(NonEmpty) }).strict();
export const ExactQuantity = z.object({
  decimal: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
  currency: NonEmpty,
  unit: NonEmpty,
  canonicalEntity: Binding,
  period: NonEmpty,
  accountingBasis: NonEmpty,
  sourceWitness: Binding,
  occurrenceAt: IsoInstant,
  availableAt: IsoInstant,
  knowledgeCut: IsoInstant,
}).strict();
export const TemporalConstraint = z.object({
  identity: Binding,
  quantity: ExactQuantity.optional(),
  occurrenceAt: IsoInstant,
  availableAt: IsoInstant,
  knowledgeCut: IsoInstant,
  disposition: z.enum(["supported", "contradicted", "unresolved"]),
  counterevidenceRefs: z.array(NonEmpty),
}).strict();

const BindingList = z.array(Binding);
export const FrontierArtifactEnvelope = z.object({
  artifact_id: NonEmpty,
  kind: NonEmpty,
  schema_revision: NonEmpty,
  content_digest: NonEmpty,
  tenant_ref: Binding,
  work_ref: Binding,
  institutional_program_ref: Binding,
  parent_artifact_refs: BindingList,
  producer_revision: Binding,
  baseline_manifest_ref: Binding,
  authority_grant_ref: Binding,
  rights_revision: Binding,
  resource_grant_ref: Binding,
  source_refs: BindingList,
  source_revision_vector: z.record(NonEmpty),
  knowledge_cut: IsoInstant,
  admitted_domain_ref: Binding,
  application_fingerprints: BindingList,
  model_refs: BindingList,
  dependency_lock_digest: Binding,
  runtime_digest: Binding,
  observed_claims: z.array(ObservedClaim),
  inferred_claims: z.array(InferredClaim),
  predicted_claims: z.array(PredictedClaim),
  unresolved_claims: z.array(UnresolvedClaim),
  postcondition_contract_refs: BindingList,
  independent_check_refs: BindingList,
  S6_obligation_refs: BindingList,
  provider_observation_refs: BindingList,
  invalidation_dependencies: BindingList,
  lifecycle_state: z.enum(["PROPOSED", "CHECKED_DEVELOPMENT", "INVALIDATED", "UNKNOWN"]),
  lifecycle_events: z.array(z.object({ at: IsoInstant, state: NonEmpty, basis: Binding }).strict()),
  build_learning_compute_cost_refs: BindingList,
  attributable_human_work_refs: BindingList,
}).strict();
export type FrontierArtifactEnvelope = z.infer<typeof FrontierArtifactEnvelope>;

export const ObligationDerivation = z.object({
  stableIdentity: NonEmpty,
  derivationRevision: NonEmpty,
  triggerOccurrence: IsoInstant,
  triggeringEvidence: BindingList.min(1),
  normativeRule: Binding,
  condition: NonEmpty,
  materiality: NonEmpty,
  priority: NonEmpty,
  originalDeadline: IsoInstant,
  responsiblePrincipal: Binding,
  permissibleOperationClass: NonEmpty,
  preconditions: BindingList,
  postcondition: Binding,
  independentObserver: Binding,
  effectBinding: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ordinary"), effect: Binding }).strict(),
    z.object({ kind: z.literal("governed"), s6Obligation: Binding }).strict(),
    z.object({ kind: z.literal("none"), reason: NonEmpty }).strict(),
  ]),
}).strict();

/** Producer output is a proposal, never canonical truth or a check receipt. */
export const InstitutionCandidateRevision = z.object({
  envelope: FrontierArtifactEnvelope,
  mandate_ref: Binding,
  source_coverage: z.array(z.object({
    source: Binding,
    originalObjectRefs: BindingList,
    gaps: z.array(UnknownBinding),
    complete: z.boolean(),
  }).strict()),
  identity_and_relation_alternatives: z.array(z.object({
    originalWitness: Binding,
    candidates: BindingList,
    resolution: z.enum(["inferred", "unresolved"]),
    reason: NonEmpty,
  }).strict()),
  observed_claims: z.array(ObservedClaim),
  inferred_claims: z.array(InferredClaim),
  predicted_claims: z.array(PredictedClaim),
  unresolved_claims: z.array(UnresolvedClaim),
  proposed_quantity_and_time: z.array(TemporalConstraint),
  proposed_derivations: z.array(ObligationDerivation),
  process_hypotheses: z.array(InferredClaim),
  declared_dependencies: BindingList,
}).strict();
export type InstitutionCandidateRevision = z.infer<typeof InstitutionCandidateRevision>;

export const InstitutionProgram = z.object({
  envelope: FrontierArtifactEnvelope,
  mandate_ref: Binding,
  inferred_source_mapping_refs: BindingList,
  canonical_entity_and_relation_refs: BindingList,
  temporal_and_unit_constraints: z.array(TemporalConstraint),
  obligation_derivation_rules: z.array(ObligationDerivation),
  materiality_and_priority_contract: Binding,
  unresolved_interpretations: z.array(UnresolvedClaim),
  evidence_dependency_graph: Binding,
  incremental_update_rules: Binding,
  s4_programme_ref: Binding,
  s6_obligation_refs: BindingList,
  validity_and_invalidation_contract: Binding,
  independently_checked_model_revision: Binding,
}).strict();
export type InstitutionProgram = z.infer<typeof InstitutionProgram>;

const Bound = z.number().int().nonnegative();
export const InstitutionBounds = z.object({
  sourceInstances: Bound, observationReferences: Bound, rawBytes: Bound, objectBytes: Bound,
  tabularRowsPerObject: Bound, canonicalReferences: Bound, deals: Bound, people: Bound,
  s1AssertionsPerSlice: Bound, s1SnapshotBytes: Bound, derivedObligations: Bound,
  institutionDependencyNodes: Bound, institutionDependencyEdges: Bound,
  nativePlanNodes: Bound, nodePreconditionsOrDependencies: Bound, authorizedAcquisitionCalls: Bound,
  alternativesPerInterpretation: Bound, unresolvedInterpretations: Bound, clarificationRequests: Bound,
  concurrentSourceReads: Bound, concurrentCompilerEpisodes: Bound, initialResponseSeconds: Bound,
  episodeWallSeconds: Bound, episodeHumanSeconds: Bound, financialEpisodeUsd: Bound,
  inheritedAggregateMemoryBytes: Bound,
}).strict();
export const DigitalInstitutionProfile = z.object({
  schema: z.literal("finnor.digital-institution-profile.v1"),
  id: NonEmpty,
  revision: z.number().int().positive(),
  status: NonEmpty,
  domain: NonEmpty,
  sourceClasses: z.array(z.object({ id: NonEmpty, protocols: z.array(NonEmpty).min(1), semantics: NonEmpty }).strict()).min(1),
  acquisition: z.array(NonEmpty),
  roles: z.array(NonEmpty),
  workflowFamilies: z.array(NonEmpty),
  canonicalTypes: z.array(NonEmpty),
  ordinaryOperations: z.array(NonEmpty),
  effectClasses: z.array(NonEmpty),
  normativeBasis: z.array(NonEmpty),
  identityEvidence: z.array(NonEmpty),
  nonIdentityEvidence: z.array(NonEmpty),
  bounds: InstitutionBounds,
  overflowDisposition: NonEmpty,
  qualification: z.object({
    environments: z.number().int().positive(),
    minimumHeterogeneousSystemClassesPerEnvironment: z.number().int().positive(),
    replayDaysPerEnvironment: z.number().int().positive(),
    separateElapsedLiveSoakDaysPerEnvironment: z.number().int().positive(),
    materialMappingPrecisionMinimum: z.number().min(0).max(1),
    materialMappingRecallMinimum: z.number().min(0).max(1),
    supportedObligationPrecisionMinimum: z.number().min(0).max(1),
    supportedObligationRecallMinimum: z.number().min(0).max(1),
    withinDeadlineCompletionMinimum: z.number().min(0).max(1),
    actionableChangesWithin120SecondsMinimum: z.number().min(0).max(1),
    criticalMissesCannotBeAveragedAway: z.literal(true),
    unsafeOutcomeMaximumObserved: z.literal(0),
    protectedCustody: NonEmpty,
    fullPopulationMayNotBeReplacedByDevelopmentCases: z.literal(true),
  }).strict(),
  oracleCoverage: z.array(NonEmpty),
  unsupported: z.array(NonEmpty),
  economicExclusions: z.array(NonEmpty),
  freezeRule: NonEmpty,
}).strict();
export type DigitalInstitutionProfile = z.infer<typeof DigitalInstitutionProfile>;
