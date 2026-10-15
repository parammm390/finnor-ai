import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ApplicationActionModel, ApplicationModelCheck, ApplicationScalar,
  ApplicationSnapshot, ApplicationTransitionEvidence, CheckedApplicationComposition,
  ExperimentRef, FrontierArtifactEnvelope,
} from "@finnor/shared-types";
import { canonical, LedgerFault } from "../../../governed-execution/src/protocol";

export const X2_VERSION = "application-operation-v1";
export const X2_LIMITS = Object.freeze({
  maxOperations: 16, maxStateFields: 16, maxParameters: 8,
  maxExplorationInteractions: 64, maxObservations: 256,
  maxCompositionOperations: 8, maxSearchNodes: 64, maxBranches: 8,
  maxUnresolvedEffects: 1, maxModelBytes: 2 * 1024 * 1024,
  maxSourceBytes: 32 * 1024, maxTextLength: 2048,
});
export const x2Digest = (body: unknown) => createHash("sha256").update(canonical(body)).digest("hex");
export const x2ByteDigest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
export const applicationRuntimeIdentity = () => ({
  node: process.version, platform: process.platform, architecture: process.arch,
  authorityEnvironment: process.env.FINNOR_ENVIRONMENT ?? null,
  applicationProfile: process.env.FINNOR_X2_PROFILE ?? null,
});
export function x2Fault(code: string, status = 409): never { throw new LedgerFault(status, code); }
export function applicationFailureReason(error: unknown) {
  const value = error && typeof error === "object" && "code" in error ? String(error.code)
    : error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{1,159}$/.test(value) ? value : "X2_NATIVE_OWNER_OR_RUNTIME_PREDICATE_UNPASSED";
}
export function applicationDatabaseDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  const identifier = (field: string) => typeof value[field] === "string" && /^[a-zA-Z0-9_.]{1,160}$/.test(value[field] as string) ? value[field] : null;
  const where = typeof value.where === "string" ? /^PL\/pgSQL function ([a-zA-Z0-9_.]+)\(/.exec(value.where)?.[1] ?? null : null;
  return { code: identifier("code"), constraint: identifier("constraint"), table: identifier("table"),
    databaseFunction: where, routine: identifier("routine") };
}
export function x2Ref(owner: string, kind: string, body: unknown, version = X2_VERSION): ExperimentRef {
  const contentDigest = x2Digest(body);
  return { owner, id: `${kind}:${contentDigest}`, version, contentDigest };
}
export function applicationWireCorrelation(obligationRef: ExperimentRef, originalKey: string) {
  return { obligationId: `finnor_obligation_${obligationRef.contentDigest}`,
    idempotencyKey: `finnor_${x2Digest({ obligationRef, originalKey })}` };
}
export const sameX2Ref = (left: ExperimentRef, right: ExperimentRef) => x2Digest(left) === x2Digest(right);
export const sameApplicationScalar = (left: ApplicationScalar | undefined, right: ApplicationScalar | undefined) => {
  if (left === undefined || right === undefined) x2Fault("X2_UNAVAILABLE_SCALAR_COMPARISON");
  return x2Digest(left) === x2Digest(right);
};

const text = z.string().min(1).max(256);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value));
const refs = (maximum = 256) => z.array(X2RefSchema).max(maximum);
export const X2RefSchema = z.object({
  owner: text, id: z.string().min(1).max(1024), version: text, contentDigest: hex,
}).strict();
export const ExactApplicationQuantitySchema = z.object({
  kind: z.literal("quantity"),
  decimal: z.string().max(96).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
  currency: z.string().regex(/^[A-Z]{3}$/), entity: text, unit: text, time: text, basis: text,
}).strict();
export const ScopedApplicationIdentitySchema = z.object({
  kind: z.literal("identity"), application: text, account: text, entity: text, id: text,
}).strict();
export const ApplicationScalarSchema = z.union([
  z.string().max(X2_LIMITS.maxTextLength), z.boolean(), z.null(),
  ExactApplicationQuantitySchema, ScopedApplicationIdentitySchema,
]);
export const ApplicationStateSchema = z.record(field, ApplicationScalarSchema)
  .refine((value) => Object.keys(value).length <= X2_LIMITS.maxStateFields, "X2_STATE_FIELD_BOUND");
export const ApplicationOperandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: ApplicationScalarSchema }).strict(),
  z.object({ kind: z.literal("parameter"), name: field }).strict(),
]);
export const ApplicationAssignmentOperandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: ApplicationScalarSchema }).strict(),
  z.object({ kind: z.literal("parameter"), name: field }).strict(),
  z.object({ kind: z.literal("field"), field }).strict(),
]);
const AtomSchema = z.object({
  field, operator: z.enum(["present", "eq", "neq", "in"]),
  values: z.array(ApplicationOperandSchema).max(32),
}).strict().superRefine((atom, context) => {
  if ((atom.operator === "present" && atom.values.length !== 0)
    || (["eq", "neq"].includes(atom.operator) && atom.values.length !== 1)
    || (atom.operator === "in" && atom.values.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "X2_ATOM_ARITY" });
  }
});
export const ApplicationPredicateSchema = z.object({ all: z.array(AtomSchema).max(16) }).strict();
export const ApplicationParameterSchema = z.object({
  name: field, kind: z.enum(["text", "boolean", "enum", "quantity", "identity"]),
  required: z.boolean(), values: z.array(ApplicationScalarSchema).max(32),
  maxLength: z.number().int().min(1).max(X2_LIMITS.maxTextLength),
  quantityContext: z.object({
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(32),
    units: z.array(text).min(1).max(32), bases: z.array(text).min(1).max(32),
    maxDecimalPlaces: z.number().int().min(0).max(32),
    entityBinding: z.literal("CURRENT_AUTHORIZED_TARGET"),
    timeBinding: z.literal("EXACT_CALLER_BINDING"),
  }).strict().nullable(),
  schemaEvidence: refs(32).min(1),
}).strict();
export const ApplicationFieldSchema = z.object({
  path: field, kind: z.enum(["text", "boolean", "enum", "quantity", "identity"]),
  nullable: z.boolean(), observedValues: z.array(ApplicationScalarSchema).max(32),
  observationRefs: refs().min(1),
}).strict();
export const ApplicationScopeSchema = z.object({
  tenantId: text, principalId: text, application: text, account: text, role: text,
  grantRef: X2RefSchema, rightsRef: text,
}).strict();
export const ApplicationStructuralWitnessSchema = z.object({
  schema: z.literal("finnor.x2.structural-observation-witness.v1"),
  observerContractRef: X2RefSchema, publishedSchemaDigest: hex.nullable(),
  leaves: z.record(field, z.unknown()).refine(value => Object.keys(value).length <= 16),
  leafKinds: z.record(field, z.enum(["text", "boolean", "enum", "quantity", "identity"]))
    .refine(value => Object.keys(value).length <= 16),
  availablePaths: z.array(field).max(32), unavailablePaths: z.array(field).max(32),
  nullPrefixes: z.array(field).max(32), optionalAbsentPaths: z.array(field).max(32),
}).strict();
export const ApplicationSnapshotSchema = z.object({
  schema: z.literal("finnor.x2.application-snapshot.v1"), scope: ApplicationScopeSchema,
  target: ScopedApplicationIdentitySchema, applicationRevision: text, recordRevision: text,
  schemaDigest: hex, sourceRef: X2RefSchema, observedAt: instant,
  state: ApplicationStateSchema, unavailableFields: z.array(field).max(16),
  observationQualification: z.enum(["LAWFUL_INDEPENDENT_READBACK", "PERMITTED_DISCOVERY_OBSERVATION"]),
  structuralWitness: ApplicationStructuralWitnessSchema.optional(),
}).strict() satisfies z.ZodType<ApplicationSnapshot>;
export const ApplicationTransitionBodySchema = z.object({
  schema: z.literal("finnor.x2.transition-evidence.v1"),
  originalParentRef: X2RefSchema, operationId: text, parameters: ApplicationStateSchema,
  before: ApplicationSnapshotSchema, after: ApplicationSnapshotSchema.nullable(),
  disposition: z.enum(["OBSERVED", "REJECTED", "PENDING", "UNKNOWN"]),
  responseRef: X2RefSchema, effectRef: X2RefSchema.nullable(), obligationRef: X2RefSchema.nullable(), chargeRefs: refs(),
  failureCode: text.nullable(), possibleEgress: z.boolean(),
  prediction: ApplicationStateSchema.nullable(),
  independentOutcome: z.enum(["ESTABLISHED", "DENIED", "UNAVAILABLE"]),
}).strict();
export const ApplicationTransitionSchema = ApplicationTransitionBodySchema.extend({ ref: X2RefSchema }) satisfies z.ZodType<ApplicationTransitionEvidence>;
export const LearnedApplicationOperationSchema = z.object({
  id: text, label: text, parameters: z.array(ApplicationParameterSchema).max(8),
  observedParameterBindings: z.record(field, field).refine((value) => Object.keys(value).length <= 8),
  precondition: ApplicationPredicateSchema,
  postcondition: z.object({
    assignments: z.array(z.object({ field, value: ApplicationAssignmentOperandSchema }).strict()).max(16),
    unchanged: z.array(field).max(16), completion: z.literal("INDEPENDENT_OBSERVATION_REQUIRED"),
    asynchronous: z.boolean(), unknownFields: z.array(field).max(16),
    alternatives: z.array(ApplicationStateSchema).max(8),
  }).strict(),
  reads: z.array(field).max(16), writes: z.array(field).max(16),
  effects: z.object({
    classification: z.enum(["OBSERVATION", "STATE_MUTATION", "POSSIBLY_CONSEQUENTIAL"]),
    replay: z.literal("NEVER_AFTER_POSSIBLE_EGRESS"), observationFields: z.array(field).min(1).max(16),
  }).strict(),
  authorization: z.object({
    role: text, grantRef: X2RefSchema, commitment: z.literal("CURRENT_NATIVE_AND_EXTERNAL_AUTHORITY_REQUIRED"),
  }).strict(),
  resources: z.object({
    originalParentRequired: z.literal(true), maximumInteractions: z.number().int().min(1).max(64),
    unresolvedEffects: z.number().int().min(0).max(1),
  }).strict(),
  observerContractRef: X2RefSchema, privateBindingRef: X2RefSchema,
  semanticRevision: text, renderingDigest: hex, dependencies: refs(128).min(1), evidenceRefs: refs().min(1),
  uncertainty: z.object({
    identification: z.enum(["EVIDENCE_SUPPORTED", "PARTIALLY_IDENTIFIED", "UNKNOWN"]),
    assumptions: z.array(z.string().min(1).max(2048)).max(64),
    unobservedCases: z.array(z.string().min(1).max(2048)).max(64), falsifierRefs: refs(),
  }).strict(),
}).strict();
export const SupportedApplicationDomainSchema = z.object({
  substrates: z.array(z.enum(["API", "UI", "HYBRID"])).min(1).max(3),
  maxOperations: z.literal(16), maxStateFields: z.literal(16), maxParameters: z.literal(8),
  maxExplorationInteractions: z.literal(64), maxObservations: z.literal(256),
  maxCompositionOperations: z.literal(8), maxSearchNodes: z.literal(64), maxBranches: z.literal(8),
  maxUnresolvedEffects: z.literal(1), quantityArithmetic: z.literal("EXACT_DECIMAL_TEXT_AND_CONTEXT"),
  freshTargets: z.literal("CURRENT_AUTHORIZED_BINDING_REQUIRED"),
}).strict();
export const FrontierArtifactEnvelopeSchema = z.object({
  schema: z.literal("finnor.frontier-artifact-envelope.v1"), frontier: z.literal("FRONTIER5.X2"),
  owningInterface: z.literal("application-operation-v1"),
  artifact_id: text, kind: z.literal("ApplicationActionModel"), schema_revision: text, content_digest: hex,
  tenant_ref: X2RefSchema, work_ref: X2RefSchema, institutional_program_ref: X2RefSchema.nullable(),
  parent_artifact_refs: refs(32), producer_revision: X2RefSchema, baseline_manifest_ref: X2RefSchema,
  authority_grant_ref: X2RefSchema, rights_revision: text, resource_grant_ref: X2RefSchema,
  source_refs: refs(), source_revision_vector: z.record(field, text), knowledge_cut: instant,
  admitted_domain_ref: X2RefSchema.nullable(), application_fingerprints: z.record(field, hex),
  model_refs: refs(32), dependency_lock_digest: hex, runtime_digest: hex,
  observed_claims: refs(), inferred_claims: refs(), predicted_claims: refs(),
  unresolved_claims: z.array(z.object({ code: text, reference: X2RefSchema.nullable() }).strict()).max(256),
  postcondition_contract_refs: refs(), independent_check_refs: refs(), S6_obligation_refs: refs(),
  provider_observation_refs: refs(), invalidation_dependencies: refs(), lifecycle_state:
    z.enum(["GENERATED", "CHECKED", "CURRENT", "STALE", "REVOKED", "UNKNOWN"]),
  lifecycle_events: refs(), build_learning_compute_cost_refs: refs(), attributable_human_work_refs: refs(),
  revisionRef: X2RefSchema, parentRefs: refs(32), sourceRefs: refs(), evidenceRefs: refs(),
  grammarRef: X2RefSchema, checkerRef: X2RefSchema, runtimeRef: X2RefSchema,
  dependencyPins: z.array(z.object({
    path: z.string().min(1).max(4096), sha256: hex,
  }).strict()).min(1).max(128),
  originalParentRef: X2RefSchema, validAfter: instant, validUntil: instant,
  supportedDomain: SupportedApplicationDomainSchema,
  provenance: z.object({
    observationsSeparatedFromPredictions: z.literal(true),
    externalConformance: z.literal("EMPIRICAL_WITHIN_RETAINED_EVIDENCE_NOT_UNIVERSAL"),
    privateFactsAndCredentialsExported: z.literal(false),
  }).strict(),
  executionAuthorityGranted: z.literal(false), protectedAdmission: z.literal(false),
}).strict() satisfies z.ZodType<FrontierArtifactEnvelope>;
export const ApplicationActionModelBodySchema = z.object({
  schema: z.literal("finnor.x2.application-action-model.v1"),
  envelope: FrontierArtifactEnvelopeSchema, scope: ApplicationScopeSchema,
  application_identity_and_version_evidence: refs().min(1),
  observable_state_schema: z.array(ApplicationFieldSchema).min(1).max(16),
  operation_signatures: z.array(z.object({
    operationId: text, parameters: z.array(ApplicationParameterSchema).max(8),
  }).strict()).min(1).max(16),
  parameter_and_unit_constraints: refs(), precondition_predicates:
    z.array(z.object({ operationId: text, predicate: ApplicationPredicateSchema }).strict()).min(1).max(16),
  effect_and_obligation_contracts: refs(), postcondition_observers: refs(),
  transition_model_and_uncertainty: refs(), compositional_rules: refs(),
  permitted_exploration_record: refs().min(1), drift_detectors: refs(),
  held_out_execution_evidence: refs(), supported_domain: SupportedApplicationDomainSchema,
  stateSchema: z.array(ApplicationFieldSchema).min(1).max(16),
  operations: z.array(LearnedApplicationOperationSchema).min(1).max(16),
  source_observations: refs().min(1), declared_type_signatures: refs(),
  inferred_preconditions: refs(), inferred_postconditions: refs(), generated_interaction_code: refs(),
  checker_results: refs(), falsifier_tests: refs(), actual_independent_outcomes: refs(),
  validities: z.object({
    scope: z.literal("PRINCIPAL_ACCOUNT_ROLE_GRANT_BOUND"),
    rendering: z.literal("LAWFUL_PRIVATE_BINDING_REVALIDATION_REQUIRED"),
    semantic: z.literal("FENCE_MINIMAL_SOUND_DEPENDENCY_CLOSURE"),
    missingEvidence: z.literal("UNKNOWN"),
  }).strict(),
}).strict();
export const ApplicationActionModelSchema = ApplicationActionModelBodySchema.extend({ ref: X2RefSchema }) satisfies z.ZodType<ApplicationActionModel>;
export const ApplicationModelCheckBodySchema = z.object({
  schema: z.literal("finnor.x2.model-check.v1"), modelRef: X2RefSchema,
  originalEvidenceRefs: refs().min(1), checkerRef: X2RefSchema, checkedAt: instant,
  disposition: z.enum(["ACCEPTED_EVIDENCED_DOMAIN", "COUNTEREXAMPLE", "UNKNOWN", "UNSUPPORTED"]),
  falseValid: z.number().int().min(0), falseInvalid: z.number().int().min(0),
  counterexamples: z.array(z.object({ operationId: text, evidenceRef: X2RefSchema, code: text }).strict()).max(256),
  acceptedOperationIds: z.array(text).max(16), externalUniversalProof: z.literal(false),
}).strict();
export const ApplicationModelCheckSchema = ApplicationModelCheckBodySchema.extend({ ref: X2RefSchema }) satisfies z.ZodType<ApplicationModelCheck>;
export const CheckedApplicationCompositionBodySchema = z.object({
  schema: z.literal("finnor.x2.checked-composition.v1"), modelRef: X2RefSchema, checkRef: X2RefSchema,
  originalParentRef: X2RefSchema, scope: ApplicationScopeSchema, target: ScopedApplicationIdentitySchema,
  initialObservationRef: X2RefSchema, goal: ApplicationStateSchema,
  steps: z.array(z.object({
    id: text, operationId: text, parameters: ApplicationStateSchema,
    parameterObservations: z.record(field, field).refine((value) => Object.keys(value).length <= 8),
    expectedState: ApplicationStateSchema, conditionalState: ApplicationStateSchema, observationRequired: z.literal(true),
  }).strict()).max(8),
  exploredNodes: z.number().int().min(0).max(64),
  gaps: z.array(z.object({ stepId: text, code: text, observationRequired: z.literal(true) }).strict()).max(8),
  disposition: z.enum(["COMPOSED_WITH_REQUIRED_OBSERVATIONS", "UNKNOWN", "UNSUPPORTED"]),
  deadlineAt: instant, executionAuthorityGranted: z.literal(false),
}).strict();
export const CheckedApplicationCompositionSchema = CheckedApplicationCompositionBodySchema.extend({ ref: X2RefSchema }) satisfies z.ZodType<CheckedApplicationComposition>;

export function boundedX2(input: unknown, maximum = X2_LIMITS.maxModelBytes): void {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); }
  catch { x2Fault("X2_NON_JSON_INPUT", 400); }
  if (bytes! > maximum) x2Fault("X2_INPUT_BYTE_BOUND", 413);
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) x2Fault("X2_INPUT_DEPTH_BOUND", 413);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) x2Fault("X2_UNSAFE_INPUT_KEY", 400);
      visit(child, depth + 1);
    }
  };
  visit(input, 0);
}
export function parseApplicationModel(input: unknown): ApplicationActionModel {
  boundedX2(input);
  const model = ApplicationActionModelSchema.parse(input);
  const { ref, ...body } = model;
  if (!sameX2Ref(ref, x2Ref("S4", "application-model", body))) x2Fault("X2_MODEL_CONTENT_IDENTITY");
  if (new Set(model.operations.map((operation) => operation.id)).size !== model.operations.length
    || new Set(model.stateSchema.map((item) => item.path)).size !== model.stateSchema.length
    || x2Digest(model.observable_state_schema) !== x2Digest(model.stateSchema)
    || x2Digest(model.supported_domain) !== x2Digest(model.envelope.supportedDomain)
    || Date.parse(model.envelope.validUntil) <= Date.parse(model.envelope.validAfter)) x2Fault("X2_MODEL_DOMAIN_OR_ALIAS_SUBSTITUTION");
  return model;
}
export function parseTransitionEvidence(input: unknown): ApplicationTransitionEvidence {
  boundedX2(input);
  const evidence = ApplicationTransitionSchema.parse(input);
  const { ref, ...body } = evidence;
  if (!sameX2Ref(ref, x2Ref("S6", "application-transition", body))) x2Fault("X2_ORIGINAL_EVIDENCE_IDENTITY");
  return evidence;
}
export function parseApplicationCheck(input: unknown): ApplicationModelCheck {
  boundedX2(input);
  const result = ApplicationModelCheckSchema.parse(input);
  const { ref, ...body } = result;
  if (!sameX2Ref(ref, x2Ref("S4", "application-model-check", body))) x2Fault("X2_CHECK_CONTENT_IDENTITY");
  return result;
}
export function parseApplicationComposition(input: unknown): CheckedApplicationComposition {
  boundedX2(input);
  const composition = CheckedApplicationCompositionSchema.parse(input);
  const { ref, ...body } = composition;
  if (!sameX2Ref(ref, x2Ref("S4", "application-composition", body))) x2Fault("X2_COMPOSITION_CONTENT_IDENTITY");
  if (composition.disposition === "COMPOSED_WITH_REQUIRED_OBSERVATIONS" && composition.steps.length === 0) {
    x2Fault("X2_VACUOUS_COMPOSITION");
  }
  return composition;
}
