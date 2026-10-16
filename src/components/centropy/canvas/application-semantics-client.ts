"use client"

import { z } from "zod"
import {
  CENTROPY_GET_TIMEOUT_MS,
  CentropyApiError,
  centropyGet,
  centropyPost,
} from "@/components/centropy/lib/api"
import {
  getCurrentAccessToken,
  getCurrentSessionKey,
} from "@/components/centropy/lib/centropy-auth"
import type {
  ApplicationActionModel,
  ApplicationField,
  ApplicationFreshAuthorityView,
  ApplicationModelCheck,
  ApplicationParameter,
  ApplicationPredicate,
  ApplicationScope,
  ApplicationState,
  CheckedApplicationComposition,
  FrontierArtifactEnvelope,
  LearnedApplicationOperation,
} from "../../../../finnor-os/packages/shared-types/src/application-semantics"

// Frozen before integration changes: CanvasDocument's maintained work_execution
// instrument owns the mount. /me supplies native identity; every read binds
// tenant/principal/root/Work and original-parent/model/check/composition lineage.
// The public codecs retain field-copy assignments, correlated alternatives,
// observation bindings, exact decimal/context strings, actual SQL effects and
// original S5 charges. Missing billing stays UNKNOWN; no authority is invented.
// Acquisition uses the original request; execution uses a distinct fresh Work;
// cancellation binds root/Work. No response or toast is business completion.
// Auth/token/scope/access/offline/visibility invalidation clears private views
// and inputs, aborts reads, and fences delayed responses. Aborting presentation
// does not undo a possibly accepted native mutation. Mounted lifecycle,
// pointer/keyboard and independent-outcome acceptance remain main-owned.
export interface ApplicationSemanticsScope {
  root: { entityType: string; entityId: string }
  workId: string
  tenantId: string
  principalId: string
  authorityEpoch: string
}
export type ApplicationWorkSelection = Pick<ApplicationSemanticsScope, "root" | "workId">

const label = z.string().min(1).max(256)
const text = z.string().max(8192)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.string().datetime({ offset: true })
const decimal = z.string().max(96).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
const unsignedInteger = z.string().max(96).regex(/^(?:0|[1-9]\d*)$/)
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"])
const credentialName = /password|passwd|passphrase|secret|credential|authorization|bearer|apikey|accesskey|privatekey|clientkey|token|cookie|sessionkey|login/i
const credentialValue = /(?:-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk[-_](?:live[-_]|test[-_]|proj[-_])?[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|[?&](?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)=\S+|\b(?:password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+)/i
const browserHandle = /(?:\bwss?:\/\/|\b(?:cdp|devtools):\/\/|\b(?:browser|steel|cdp)[ _-]?(?:session|profile|handle|endpoint)[ _-]?(?:id|url)?\s*[:=]\s*\S+)/i
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
  .refine(value => !unsafeKeys.has(value))
const rootSchema = z.object({
  entityType: z.enum([
    "pe_strategy", "pe_opportunity", "pe_deal", "pe_fund", "pe_vehicle",
    "external_organization", "pe_portfolio_holding",
  ]),
  entityId: z.string().uuid(),
}).strict()

export const ApplicationReferenceSchema = z.object({
  owner: label,
  id: z.string().min(1).max(1024),
  version: label,
  contentDigest: digest,
}).strict()
export type ApplicationReference = z.infer<typeof ApplicationReferenceSchema>
const references = z.array(ApplicationReferenceSchema).max(256)
const fields = z.array(field).max(16)
const observationBindings = z.record(field, field)
  .refine(value => Object.keys(value).length <= 8)

const quantitySchema = z.object({
  kind: z.literal("quantity"),
  decimal,
  currency: z.string().regex(/^[A-Z]{3}$/),
  entity: label,
  unit: label,
  time: label,
  basis: label,
}).strict()

const identitySchema = z.object({
  kind: z.literal("identity"),
  application: label,
  account: label,
  entity: label,
  id: label,
}).strict()

const scalarSchema = z.union([z.string().max(2048), z.boolean(), z.null(), quantitySchema, identitySchema])
const stateSchema: z.ZodType<ApplicationState> = z.record(
  field,
  scalarSchema,
).superRefine((state, context) => {
  if (Object.keys(state).length > 16 || Object.keys(state).some(key => credentialName.test(key))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Application state keys are unsupported." })
  }
})

const operandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: scalarSchema }).strict(),
  z.object({ kind: z.literal("parameter"), name: field }).strict(),
])
const assignmentOperandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: scalarSchema }).strict(),
  z.object({ kind: z.literal("parameter"), name: field }).strict(),
  z.object({ kind: z.literal("field"), field }).strict(),
])
const predicateSchema: z.ZodType<ApplicationPredicate> = z.object({
  all: z.array(z.object({
    field,
    operator: z.enum(["present", "eq", "neq", "in"]),
    values: z.array(operandSchema).max(32),
  }).strict().superRefine((atom, context) => {
    if ((atom.operator === "present" && atom.values.length !== 0)
      || (["eq", "neq"].includes(atom.operator) && atom.values.length !== 1)
      || (atom.operator === "in" && atom.values.length === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Application predicate arity is invalid." })
    }
  })).max(16),
}).strict()

const parameterSchema: z.ZodType<ApplicationParameter> = z.object({
  name: field,
  kind: z.enum(["text", "boolean", "enum", "quantity", "identity"]),
  required: z.boolean(),
  values: z.array(scalarSchema).max(32),
  maxLength: count.min(1).max(2048),
  quantityContext: z.object({
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(32),
    units: z.array(label).min(1).max(32),
    bases: z.array(label).min(1).max(32),
    maxDecimalPlaces: count.max(32),
    entityBinding: z.literal("CURRENT_AUTHORIZED_TARGET"),
    timeBinding: z.literal("EXACT_CALLER_BINDING"),
  }).strict().nullable(),
  schemaEvidence: references.min(1).max(32),
}).strict()

const fieldSchema: z.ZodType<ApplicationField> = z.object({
  path: field,
  kind: z.enum(["text", "boolean", "enum", "quantity", "identity"]),
  nullable: z.boolean(),
  observedValues: z.array(scalarSchema).max(32),
  observationRefs: references.min(1),
}).strict()

const applicationScopeSchema: z.ZodType<ApplicationScope> = z.object({
  tenantId: label,
  principalId: label,
  application: label,
  account: label,
  role: label,
  grantRef: ApplicationReferenceSchema,
  rightsRef: label,
}).strict()

const supportedDomainSchema = z.object({
  substrates: z.array(z.enum(["API", "UI", "HYBRID"])).min(1).max(3),
  maxOperations: z.literal(16),
  maxStateFields: z.literal(16),
  maxParameters: z.literal(8),
  maxExplorationInteractions: z.literal(64),
  maxObservations: z.literal(256),
  maxCompositionOperations: z.literal(8),
  maxSearchNodes: z.literal(64),
  maxBranches: z.literal(8),
  maxUnresolvedEffects: z.literal(1),
  quantityArithmetic: z.literal("EXACT_DECIMAL_TEXT_AND_CONTEXT"),
  freshTargets: z.literal("CURRENT_AUTHORIZED_BINDING_REQUIRED"),
}).strict()

const operationSchema: z.ZodType<LearnedApplicationOperation> = z.object({
  id: label,
  label,
  parameters: z.array(parameterSchema).max(8),
  observedParameterBindings: observationBindings,
  precondition: predicateSchema,
  postcondition: z.object({
    assignments: z.array(z.object({ field, value: assignmentOperandSchema }).strict()).max(16),
    unchanged: fields,
    completion: z.literal("INDEPENDENT_OBSERVATION_REQUIRED"),
    asynchronous: z.boolean(),
    unknownFields: fields,
    alternatives: z.array(stateSchema).max(8),
  }).strict(),
  reads: fields,
  writes: fields,
  effects: z.object({
    classification: z.enum(["OBSERVATION", "STATE_MUTATION", "POSSIBLY_CONSEQUENTIAL"]),
    replay: z.literal("NEVER_AFTER_POSSIBLE_EGRESS"),
    observationFields: fields.min(1),
  }).strict(),
  authorization: z.object({
    role: label,
    grantRef: ApplicationReferenceSchema,
    commitment: z.literal("CURRENT_NATIVE_AND_EXTERNAL_AUTHORITY_REQUIRED"),
  }).strict(),
  resources: z.object({
    originalParentRequired: z.literal(true),
    maximumInteractions: count.min(1).max(64),
    unresolvedEffects: count.max(1),
  }).strict(),
  observerContractRef: ApplicationReferenceSchema,
  privateBindingRef: ApplicationReferenceSchema,
  semanticRevision: label,
  renderingDigest: digest,
  dependencies: references.min(1).max(128),
  evidenceRefs: references.min(1),
  uncertainty: z.object({
    identification: z.enum(["EVIDENCE_SUPPORTED", "PARTIALLY_IDENTIFIED", "UNKNOWN"]),
    assumptions: z.array(z.string().min(1).max(2048)).max(64),
    unobservedCases: z.array(z.string().min(1).max(2048)).max(64),
    falsifierRefs: references,
  }).strict(),
}).strict()

// Parse the whole public contract without strip-mode type loss. Rendering below
// still selects evidence metadata only; private source/binding bodies have no
// field in this versioned contract and are rejected rather than exposed.
const envelopeSchema: z.ZodType<FrontierArtifactEnvelope> = z.object({
  schema: z.literal("finnor.frontier-artifact-envelope.v1"),
  frontier: z.literal("FRONTIER5.X2"),
  owningInterface: z.literal("application-operation-v1"),
  artifact_id: label,
  kind: z.literal("ApplicationActionModel"),
  schema_revision: label,
  content_digest: digest,
  tenant_ref: ApplicationReferenceSchema,
  work_ref: ApplicationReferenceSchema,
  institutional_program_ref: ApplicationReferenceSchema.nullable(),
  parent_artifact_refs: references.max(32),
  producer_revision: ApplicationReferenceSchema,
  baseline_manifest_ref: ApplicationReferenceSchema,
  authority_grant_ref: ApplicationReferenceSchema,
  rights_revision: label,
  resource_grant_ref: ApplicationReferenceSchema,
  source_refs: references,
  knowledge_cut: timestamp,
  admitted_domain_ref: ApplicationReferenceSchema.nullable(),
  application_fingerprints: z.record(field, digest),
  source_revision_vector: z.record(field, label),
  model_refs: references.max(32),
  dependency_lock_digest: digest,
  runtime_digest: digest,
  observed_claims: references,
  inferred_claims: references,
  predicted_claims: references,
  unresolved_claims: z.array(z.object({
    code: label,
    reference: ApplicationReferenceSchema.nullable(),
  }).strict()).max(256),
  postcondition_contract_refs: references,
  independent_check_refs: references,
  S6_obligation_refs: references,
  provider_observation_refs: references,
  invalidation_dependencies: references,
  lifecycle_state: z.enum(["GENERATED", "CHECKED", "CURRENT", "STALE", "REVOKED", "UNKNOWN"]),
  lifecycle_events: references,
  build_learning_compute_cost_refs: references,
  attributable_human_work_refs: references,
  revisionRef: ApplicationReferenceSchema,
  parentRefs: references.max(32),
  sourceRefs: references,
  evidenceRefs: references,
  grammarRef: ApplicationReferenceSchema,
  checkerRef: ApplicationReferenceSchema,
  runtimeRef: ApplicationReferenceSchema,
  dependencyPins: z.array(z.object({
    path: z.string().min(1).max(4096),
    sha256: digest,
  }).strict()).min(1).max(128),
  originalParentRef: ApplicationReferenceSchema,
  validAfter: timestamp,
  validUntil: timestamp,
  supportedDomain: supportedDomainSchema,
  provenance: z.object({
    observationsSeparatedFromPredictions: z.literal(true),
    externalConformance: z.literal("EMPIRICAL_WITHIN_RETAINED_EVIDENCE_NOT_UNIVERSAL"),
    privateFactsAndCredentialsExported: z.literal(false),
  }).strict(),
  executionAuthorityGranted: z.literal(false),
  protectedAdmission: z.literal(false),
}).strict()

export type ApplicationModelView = ApplicationActionModel
const modelSchema: z.ZodType<ApplicationModelView> = z.object({
  schema: z.literal("finnor.x2.application-action-model.v1"),
  ref: ApplicationReferenceSchema,
  envelope: envelopeSchema,
  scope: applicationScopeSchema,
  application_identity_and_version_evidence: references.min(1),
  observable_state_schema: z.array(fieldSchema).min(1).max(16),
  operation_signatures: z.array(z.object({
    operationId: label,
    parameters: z.array(parameterSchema).max(8),
  }).strict()).min(1).max(16),
  parameter_and_unit_constraints: references,
  precondition_predicates: z.array(z.object({
    operationId: label,
    predicate: predicateSchema,
  }).strict()).min(1).max(16),
  effect_and_obligation_contracts: references,
  postcondition_observers: references,
  transition_model_and_uncertainty: references,
  compositional_rules: references,
  permitted_exploration_record: references.min(1),
  drift_detectors: references,
  held_out_execution_evidence: references,
  supported_domain: supportedDomainSchema,
  stateSchema: z.array(fieldSchema).min(1).max(16),
  operations: z.array(operationSchema).min(1).max(16),
  source_observations: references.min(1),
  declared_type_signatures: references,
  inferred_preconditions: references,
  inferred_postconditions: references,
  generated_interaction_code: references,
  checker_results: references,
  falsifier_tests: references,
  actual_independent_outcomes: references,
  validities: z.object({
    scope: z.literal("PRINCIPAL_ACCOUNT_ROLE_GRANT_BOUND"),
    rendering: z.literal("LAWFUL_PRIVATE_BINDING_REVALIDATION_REQUIRED"),
    semantic: z.literal("FENCE_MINIMAL_SOUND_DEPENDENCY_CLOSURE"),
    missingEvidence: z.literal("UNKNOWN"),
  }).strict(),
}).strict()

const checkSchema: z.ZodType<ApplicationModelCheck> = z.object({
  schema: z.literal("finnor.x2.model-check.v1"),
  ref: ApplicationReferenceSchema,
  modelRef: ApplicationReferenceSchema,
  originalEvidenceRefs: references.min(1),
  checkerRef: ApplicationReferenceSchema,
  checkedAt: timestamp,
  disposition: z.enum(["ACCEPTED_EVIDENCED_DOMAIN", "COUNTEREXAMPLE", "UNKNOWN", "UNSUPPORTED"]),
  falseValid: count,
  falseInvalid: count,
  counterexamples: z.array(z.object({
    operationId: label,
    evidenceRef: ApplicationReferenceSchema,
    code: label,
  }).strict()).max(256),
  acceptedOperationIds: z.array(label).max(16),
  externalUniversalProof: z.literal(false),
}).strict()

const compositionSchema: z.ZodType<CheckedApplicationComposition> = z.object({
  schema: z.literal("finnor.x2.checked-composition.v1"),
  ref: ApplicationReferenceSchema,
  modelRef: ApplicationReferenceSchema,
  checkRef: ApplicationReferenceSchema,
  originalParentRef: ApplicationReferenceSchema,
  scope: applicationScopeSchema,
  target: identitySchema,
  initialObservationRef: ApplicationReferenceSchema,
  goal: stateSchema,
  steps: z.array(z.object({
    id: label,
    operationId: label,
    parameters: stateSchema,
    parameterObservations: observationBindings,
    expectedState: stateSchema,
    conditionalState: stateSchema,
    observationRequired: z.literal(true),
  }).strict()).max(8),
  exploredNodes: count.max(64),
  gaps: z.array(z.object({
    stepId: label,
    code: label,
    observationRequired: z.literal(true),
  }).strict()).max(8),
  disposition: z.enum(["COMPOSED_WITH_REQUIRED_OBSERVATIONS", "UNKNOWN", "UNSUPPORTED"]),
  deadlineAt: timestamp,
  executionAuthorityGranted: z.literal(false),
}).strict()

const freshAuthoritySchema: z.ZodType<ApplicationFreshAuthorityView> = z.object({
  schema: z.literal("finnor.x2.application-fresh-authority-view.v1"),
  ref: ApplicationReferenceSchema,
  sessionId: z.string().uuid(), parentId: z.string().uuid(),
  tenantId: label, principalId: label, workId: z.string().uuid(),
  originalParentRef: ApplicationReferenceSchema, modelRef: ApplicationReferenceSchema, checkRef: ApplicationReferenceSchema,
  rightsRef: label, target: identitySchema, deadlineAt: timestamp,
  bindings: z.array(z.object({
    profileId: z.string().uuid(), role: label, applicationAccountId: z.string().uuid(),
    originalGrantRef: ApplicationReferenceSchema, currentGrantRef: ApplicationReferenceSchema,
    operationIds: z.array(label).min(1).max(16),
  }).strict()).min(1).max(8),
  qualification: z.literal("AUTHENTICATED_CANONICAL_S4_PROJECTION_NOT_AN_AUTHORITY_GRANT"),
  protectionDomain: z.literal("DISPOSABLE_TEST_AUTHORITY"),
  protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict()

const verificationSchema = z.object({
  state: z.enum(["verified", "unverified", "reconciliation_required"]),
  basis: text,
  evidenceRef: ApplicationReferenceSchema,
  requestObservationRef: ApplicationReferenceSchema.nullable(),
  checkedAt: timestamp,
  qualification: z.literal("INDEPENDENT_DISPOSABLE_APPLICATION_READBACK_NOT_PROTECTED"),
  costs: z.object({
    money: z.null(), status: z.literal("UNMETERED"), releaseSufficient: z.literal(false),
  }).strict(),
  protectedReceipt: z.null(),
}).strict()

const effectSchema = z.object({
  request_id: z.string().uuid(),
  status: z.enum(["PREPARED", "POSSIBLE_EGRESS", "PENDING", "VERIFIED", "UNKNOWN", "DENIED"]),
  possible_egress: z.boolean(),
  observation_ref: ApplicationReferenceSchema.nullable(),
  obligation_ref: ApplicationReferenceSchema,
  effect_id: z.string().uuid(),
  effect_status: z.enum([
    "compiled", "authorized", "executing", "executed", "verified", "partially_verified",
    "unverified", "divergent", "reconciliation_required", "failed", "cancelled", "compensated",
  ]),
  verification: verificationSchema.nullable(),
  action_status: z.enum([
    "draft", "pending", "approved", "rejected", "executing", "completed", "failed",
    "needs_human_review", "blocked_integration_unavailable", "cancelled",
  ]),
}).strict()

const chargeSchema = z.object({
  schema: z.literal("finnor.s5.application-resource-charge.v1"),
  semanticOwner: z.literal("S5"),
  tenantId: label,
  principalId: label,
  originalParentRef: ApplicationReferenceSchema,
  allocationRef: ApplicationReferenceSchema,
  reservationRef: ApplicationReferenceSchema,
  consumptionRef: ApplicationReferenceSchema,
  requestRef: ApplicationReferenceSchema,
  phase: z.enum([
    "ACQUISITION", "CHECKING", "COMPOSITION", "EXECUTION", "RECOVERY", "OBSERVATION", "MAINTENANCE", "HUMAN",
  ]),
  chargeKey: label,
  requestDigest: digest,
  units: count.min(1).max(2048),
  resourceId: label,
  unit: z.enum(["request", "seconds"]),
  limit: unsignedInteger,
  usedAfter: unsignedInteger,
  createdAt: timestamp,
  costs: z.object({
    money: z.null(), status: z.literal("UNMETERED"), releaseSufficient: z.literal(false),
  }).strict(),
  qualification: z.literal("CONSERVATIVE_ORIGINAL_OCCUPATION_NOT_BILLING"),
  executionAuthorityGranted: z.literal(false),
  protectedReceipt: z.null(),
  ref: ApplicationReferenceSchema,
}).strict()

const sessionSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid(),
  status: z.enum([
    "QUEUED", "ACQUIRING", "MODEL_READY", "PLANNING", "EXECUTING",
    "WAITING_OBSERVATION", "COMPLETED", "UNKNOWN", "BLOCKED",
    "CANCELLED", "STALE", "FAILED",
  ]),
  reason: text.nullable(),
  model: modelSchema.nullable(),
  check: checkSchema.nullable(),
  composition: compositionSchema.nullable(),
  freshAuthority: freshAuthoritySchema.nullable(),
  originalParentRef: ApplicationReferenceSchema,
  deadlineAt: timestamp,
  effects: z.array(effectSchema).max(64),
  charges: z.array(chargeSchema).max(2048),
  billing: z.literal("UNKNOWN"),
  resourceReleaseGranted: z.literal(false),
  generation: count.min(1),
  protectedAdmission: z.literal(false),
  cancelledAt: timestamp.nullable(),
}).strict()
export type ApplicationSession = z.infer<typeof sessionSchema>

export const ApplicationWorkProjectionSchema = z.object({
  schema: z.literal("finnor.x2.work-projection.v1"),
  tenantId: label,
  principalId: label,
  workId: z.string().uuid(),
  root: rootSchema,
  sessions: z.array(sessionSchema).max(16),
}).strict()
export type ApplicationWorkProjection = z.infer<typeof ApplicationWorkProjectionSchema>

const expectedScopeSchema = z.object({
  root: rootSchema,
  workId: z.string().uuid(),
  tenantId: label,
  principalId: label,
  authorityEpoch: z.string().min(1).max(8192),
}).strict()

export class ApplicationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApplicationInputError"
  }
}

export class ApplicationProjectionError extends Error {
  constructor() {
    super("The current application projection or its scoped references could not be verified.")
    this.name = "ApplicationProjectionError"
  }
}

function sameRoot(left: ApplicationSemanticsScope["root"], right: ApplicationSemanticsScope["root"]) {
  return left.entityType === right.entityType && left.entityId === right.entityId
}

export function applicationReferencesMatch(left: ApplicationReference, right: ApplicationReference) {
  return left.owner === right.owner && left.id === right.id
    && left.version === right.version && left.contentDigest === right.contentDigest
}

function sameApplicationIdentity(left: ApplicationScope, right: ApplicationScope) {
  return left.tenantId === right.tenantId && left.principalId === right.principalId
    && left.application === right.application && left.account === right.account
    && left.role === right.role
}

function assertPublicView(value: unknown, depth = 0): void {
  if (depth > 32 || (typeof value === "string"
    && (credentialValue.test(value) || browserHandle.test(value)))) throw new ApplicationProjectionError()
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (unsafeKeys.has(key)) throw new ApplicationProjectionError()
      assertPublicView(child, depth + 1)
    }
  }
}

export function parseApplicationProjection(value: unknown, expected: ApplicationSemanticsScope): ApplicationWorkProjection {
  const scope = expectedScopeSchema.safeParse(expected)
  const parsed = ApplicationWorkProjectionSchema.safeParse(value)
  if (!scope.success || !parsed.success) throw new ApplicationProjectionError()
  const data = parsed.data
  assertPublicView(data)
  if (data.tenantId !== expected.tenantId || data.principalId !== expected.principalId
    || data.workId !== expected.workId || !sameRoot(data.root, expected.root)
    || new Set(data.sessions.map(session => session.id)).size !== data.sessions.length) {
    throw new ApplicationProjectionError()
  }

  for (const session of data.sessions) {
    const { model, check, composition, freshAuthority } = session
    if (!model && (check || composition)) throw new ApplicationProjectionError()
    if (model) {
      if (model.scope.tenantId !== expected.tenantId || model.scope.principalId !== expected.principalId
        || !applicationReferencesMatch(model.envelope.originalParentRef, session.originalParentRef)
        || JSON.stringify(model.supported_domain) !== JSON.stringify(model.envelope.supportedDomain)
        || JSON.stringify(model.observable_state_schema) !== JSON.stringify(model.stateSchema)
        || new Set(model.operations.map(operation => operation.id)).size !== model.operations.length
        || Date.parse(model.envelope.validUntil) <= Date.parse(model.envelope.validAfter)) {
        throw new ApplicationProjectionError()
      }
      // Tenant/Work references are content-addressed commitments, not UUIDs.
      // Their private preimages are checked by the canonical owner, not invented
      // from ref.id here. Fresh child Works intentionally reuse the parent model.
      const operationIds = new Set(model.operations.map(operation => operation.id))
      if (check && (!applicationReferencesMatch(check.modelRef, model.ref)
        || !applicationReferencesMatch(check.checkerRef, model.envelope.checkerRef)
        || new Set(check.acceptedOperationIds).size !== check.acceptedOperationIds.length
        || check.acceptedOperationIds.some(id => !operationIds.has(id)))) {
        throw new ApplicationProjectionError()
      }
    }
    if (freshAuthority) {
      if (!model || !check || session.id === session.parentId
        || freshAuthority.ref.owner !== "S4"
        || freshAuthority.sessionId !== session.id || freshAuthority.parentId !== session.parentId
        || freshAuthority.tenantId !== expected.tenantId || freshAuthority.principalId !== expected.principalId
        || freshAuthority.workId !== expected.workId || freshAuthority.deadlineAt !== session.deadlineAt
        || freshAuthority.rightsRef !== model.envelope.rights_revision
        || !applicationReferencesMatch(freshAuthority.originalParentRef, session.originalParentRef)
        || !applicationReferencesMatch(freshAuthority.modelRef, model.ref)
        || !applicationReferencesMatch(freshAuthority.checkRef, check.ref)
        || new Set(freshAuthority.bindings.map(binding => binding.role)).size !== freshAuthority.bindings.length
        || new Set(freshAuthority.bindings.map(binding => binding.profileId)).size !== freshAuthority.bindings.length
        || freshAuthority.bindings.some(binding =>
          new Set(binding.operationIds).size !== binding.operationIds.length
          || binding.operationIds.some(id => !model.operations.some(operation => operation.id === id
            && operation.authorization.role === binding.role
            && applicationReferencesMatch(operation.authorization.grantRef, binding.originalGrantRef))))
        || model.operations.some(operation => !freshAuthority.bindings.some(binding => binding.operationIds.includes(operation.id)))) {
        throw new ApplicationProjectionError()
      }
    } else if (session.id !== session.parentId && model) throw new ApplicationProjectionError()
    if (composition) {
      if (!model || !check
        || !applicationReferencesMatch(composition.modelRef, model.ref)
        || !applicationReferencesMatch(composition.checkRef, check.ref)
        || !applicationReferencesMatch(composition.originalParentRef, session.originalParentRef)
        || !sameApplicationIdentity(composition.scope, model.scope)
        || (freshAuthority
          ? JSON.stringify(composition.target) !== JSON.stringify(freshAuthority.target)
            || !freshAuthority.bindings.some(binding => binding.role === composition.scope.role
              && applicationReferencesMatch(binding.currentGrantRef, composition.scope.grantRef))
          : composition.scope.rightsRef !== model.scope.rightsRef
            || !applicationReferencesMatch(composition.scope.grantRef, model.scope.grantRef))
        || composition.target.application !== model.scope.application
        || composition.target.account !== model.scope.account
        || Date.parse(composition.deadlineAt) > Date.parse(session.deadlineAt)
        || composition.steps.some(step => !check.acceptedOperationIds.includes(step.operationId))
        || (composition.disposition === "COMPOSED_WITH_REQUIRED_OBSERVATIONS" && !composition.steps.length)) {
        throw new ApplicationProjectionError()
      }
    }
    if (new Set(session.effects.map(effect => effect.request_id)).size !== session.effects.length
      || new Set(session.charges.map(charge => charge.chargeKey)).size !== session.charges.length) {
      throw new ApplicationProjectionError()
    }
    for (const effect of session.effects) {
      if (effect.status === "VERIFIED" && (!effect.observation_ref || !effect.verification
        || effect.effect_status !== "verified" || effect.action_status !== "completed"
        || effect.verification.state !== "verified"
        || !applicationReferencesMatch(effect.observation_ref, effect.verification.evidenceRef))) {
        throw new ApplicationProjectionError()
      }
    }
    for (const charge of session.charges) {
      if (charge.tenantId !== expected.tenantId || charge.principalId !== expected.principalId
        || !applicationReferencesMatch(charge.originalParentRef, session.originalParentRef)
        || (model && !applicationReferencesMatch(charge.reservationRef, model.envelope.resource_grant_ref))
        || charge.unit !== (charge.phase === "HUMAN" ? "seconds" : "request")
        || BigInt(charge.usedAfter) > BigInt(charge.limit)) throw new ApplicationProjectionError()
    }
  }
  return data
}

function aborted() {
  return new DOMException("The authenticated application read is no longer current.", "AbortError")
}

function assertCurrentSession(sessionKey: string, signal?: AbortSignal) {
  if (signal?.aborted || !sessionKey || getCurrentSessionKey() !== sessionKey || !getCurrentAccessToken()
    || (typeof navigator !== "undefined" && !navigator.onLine)) {
    throw aborted()
  }
}

export interface ApplicationCurrentUse {
  /** This is only a transport fence, never the native principal or tenant. */
  sessionKey: string
  signal?: AbortSignal
}

const nativeIdentitySchema = z.object({
  userId: z.string().uuid(),
  employeeId: z.string().uuid().nullable(),
  tenantId: z.string().uuid(),
  role: z.literal("owner"),
  authority: z.object({
    employeeId: z.string().uuid(), revision: count, roles: z.array(label).max(256),
  }).strict().nullable(),
}).strict()

export async function readApplicationScope(
  selection: ApplicationWorkSelection,
  currentUse: ApplicationCurrentUse,
): Promise<ApplicationSemanticsScope> {
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  const parsed = nativeIdentitySchema.safeParse(await centropyGet<unknown>("me"))
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  if (!parsed.success) throw new ApplicationProjectionError()
  const identity = parsed.data
  const principalId = identity.employeeId ?? identity.userId
  if (identity.authority && identity.authority.employeeId !== principalId) throw new ApplicationProjectionError()
  const scope = expectedScopeSchema.safeParse({
    root: selection.root, workId: selection.workId, tenantId: identity.tenantId, principalId,
    authorityEpoch: JSON.stringify([identity.userId, identity.employeeId, identity.authority?.revision ?? null, identity.role]),
  })
  if (!scope.success) throw new ApplicationProjectionError()
  return scope.data
}

export async function readApplicationProjection(
  expected: ApplicationSemanticsScope,
  currentUse: ApplicationCurrentUse,
): Promise<ApplicationWorkProjection> {
  if (!expectedScopeSchema.safeParse(expected).success) throw new ApplicationProjectionError()
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  const token = getCurrentAccessToken()
  const controller = new AbortController()
  const abortRead = () => controller.abort()
  currentUse.signal?.addEventListener("abort", abortRead, { once: true })
  let timedOut = false
  const timeout = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, CENTROPY_GET_TIMEOUT_MS)
  try {
    // api.ts currently cannot take a caller AbortSignal. This read-only transport
    // uses its maintained proxy, token getter, no-store policy, error type and
    // read timeout. Actual mutations stay on centropyPost below.
    const response = await fetch("/api/centropy/company-brain/application-projection", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ root: expected.root, workId: expected.workId }),
      signal: controller.signal,
    })
    assertCurrentSession(currentUse.sessionKey, currentUse.signal)
    if (!response.ok) {
      throw new CentropyApiError("The current application projection is unavailable.", response.status)
    }
    const body = await response.text()
    assertCurrentSession(currentUse.sessionKey, currentUse.signal)
    if (body.length > 64 * 1024 * 1024) throw new ApplicationProjectionError()
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      throw new ApplicationProjectionError()
    }
    return parseApplicationProjection(value, expected)
  } catch (error) {
    if (currentUse.signal?.aborted || getCurrentSessionKey() !== currentUse.sessionKey) throw aborted()
    if (timedOut) throw new CentropyApiError("The current application projection timed out.", 504)
    if (error instanceof CentropyApiError || error instanceof ApplicationProjectionError) throw error
    throw new CentropyApiError("The current application projection could not be read.", 503)
  } finally {
    globalThis.clearTimeout(timeout)
    currentUse.signal?.removeEventListener("abort", abortRead)
  }
}

function assertNoCredentials(value: unknown, depth = 0, arrays = false): void {
  if (depth > 8) throw new ApplicationInputError("Nested application input exceeds the supported JSON shape.")
  if (typeof value === "number") {
    throw new ApplicationInputError("JSON Numbers are not allowed. Supply exact quantities as decimal strings with their full context.")
  }
  if (typeof value === "string") {
    if (credentialValue.test(value) || browserHandle.test(value)) {
      throw new ApplicationInputError("Credentials, browser handles or secret material are not accepted in this panel.")
    }
    return
  }
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    if (!arrays) throw new ApplicationInputError("Application states do not accept arrays. Use text, boolean, null, exact quantity, or scoped identity values.")
    for (const child of value) assertNoCredentials(child, depth + 1, arrays)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (unsafeKeys.has(key) || credentialName.test(key.replace(/[^a-z0-9]/gi, ""))) {
      throw new ApplicationInputError("Secret, credential, or unsafe object fields are not accepted in application input.")
    }
    assertNoCredentials(child, depth + 1, arrays)
  }
}

function assertUniqueJsonKeys(json: string): void {
  // JSON.parse validates syntax first. This bounded lexical pass rejects keys
  // that JSON.parse would silently overwrite, including escaped duplicate names.
  const objects: Array<Set<string> | null> = []
  for (let index = 0; index < json.length; index++) {
    const character = json[index]
    if (character === "{" || character === "[") {
      objects.push(character === "{" ? new Set<string>() : null)
      if (objects.length > 8) throw new ApplicationInputError("Application JSON is nested too deeply.")
    } else if (character === "}" || character === "]") {
      objects.pop()
    } else if (character === '"') {
      const start = index
      index++
      while (index < json.length) {
        if (json[index] === "\\") index += 2
        else if (json[index] === '"') break
        else index++
      }
      let next = index + 1
      while (next < json.length && /\s/.test(json[next])) next++
      const keys = objects[objects.length - 1]
      if (json[next] === ":" && keys) {
        const key: string = JSON.parse(json.slice(start, index + 1))
        if (keys.has(key)) throw new ApplicationInputError("Duplicate JSON object keys are not accepted; no exact value may be silently overwritten.")
        keys.add(key)
      }
    }
  }
}

function parseApplicationJsonInput(json: string, kind: string, arrays = false): unknown {
  if (!json.trim() || json.length > 65536) {
    throw new ApplicationInputError(`${kind} must be strict JSON of at most 65,536 characters.`)
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new ApplicationInputError(`${kind} must be strict JSON, not JavaScript or an expression.`)
  }
  assertUniqueJsonKeys(json)
  assertNoCredentials(value, 0, arrays)
  return value
}

export function parseApplicationStateInput(json: string, kind: "Goal" | "Parameters"): ApplicationState {
  const value = parseApplicationJsonInput(json, kind)
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApplicationInputError(`${kind} must have at most 16 supported fields, containing text, boolean, null, full exact quantities or scoped identities.`)
  }
  return parsed.data
}

const acquisitionRequestSchema = z.object({
  root: rootSchema, workId: z.string().uuid(),
  profileIds: z.array(z.string().uuid()).min(1).max(8),
  targets: z.array(identitySchema).min(2).max(16),
  resourceDemand: z.array(z.object({
    resourceId: label, unit: z.enum(["request", "seconds"]),
    amount: z.string().regex(/^(?:0|[1-9][0-9]{0,3})$/),
  }).strict()).min(1).max(2),
  deadlineAt: timestamp, idempotencyKey: label,
}).strict()
export type ApplicationAcquisitionRequest = z.infer<typeof acquisitionRequestSchema>
export interface ApplicationAcquisitionDraft {
  profileIdsJson: string
  targetsJson: string
  resourceDemandJson: string
  deadlineAt: string
}
export function buildApplicationAcquisitionRequest(
  scope: ApplicationSemanticsScope, draft: ApplicationAcquisitionDraft, idempotencyKey: string,
): ApplicationAcquisitionRequest {
  if (!expectedScopeSchema.safeParse(scope).success) throw new ApplicationInputError("The native Work scope is not valid.")
  const parsed = acquisitionRequestSchema.safeParse({
    root: scope.root, workId: scope.workId,
    profileIds: parseApplicationJsonInput(draft.profileIdsJson, "Profile IDs", true),
    targets: parseApplicationJsonInput(draft.targetsJson, "Discovery targets", true),
    resourceDemand: parseApplicationJsonInput(draft.resourceDemandJson, "Original resource demand", true),
    deadlineAt: draft.deadlineAt, idempotencyKey,
  })
  if (!parsed.success) throw new ApplicationInputError("Supply 1–8 profile UUIDs, 2–16 scoped targets, 1–2 exact resource demands and an ISO deadline with its offset.")
  const body = parsed.data
  if (new Set(body.profileIds).size !== body.profileIds.length
    || new Set(body.targets.map(target => target.id)).size !== body.targets.length) {
    throw new ApplicationInputError("Discovery profile IDs and target IDs must be distinct.")
  }
  const end = Date.parse(body.deadlineAt), now = Date.now()
  if (end <= now || end > now + 3_600_000) throw new ApplicationInputError("The native development deadline must be in the future and within one hour. It is not automatically renewed.")
  return body
}
const applicationRegistrationSchema = z.object({ sessionId: z.string().uuid() })

export async function acquireApplication(
  scope: ApplicationSemanticsScope, request: ApplicationAcquisitionRequest, currentUse: ApplicationCurrentUse,
): Promise<{ sessionId: string }> {
  const body = acquisitionRequestSchema.parse(request)
  if (body.workId !== scope.workId || !sameRoot(body.root, scope.root)) throw new ApplicationProjectionError()
  assertNoCredentials(body.targets, 0, true)
  assertNoCredentials(body.resourceDemand, 0, true)
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  const response = await centropyPost<unknown>("company-brain/application-acquire", body)
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  return applicationRegistrationSchema.parse(response)
}

const executionRequestSchema = z.object({
  root: rootSchema,
  workId: z.string().uuid(),
  sessionId: z.string().uuid(),
  executionProfileId: z.string().uuid(),
  targetId: label,
  goal: stateSchema,
  parameters: stateSchema,
  idempotencyKey: z.string().min(1).max(256),
}).strict()
export type ApplicationExecutionRequest = z.infer<typeof executionRequestSchema>

export interface ApplicationExecutionDraft {
  freshWorkId: string
  executionProfileId: string
  targetId: string
  goalJson: string
  parametersJson: string
}

export function buildApplicationExecutionRequest(
  scope: ApplicationSemanticsScope,
  sessionId: string,
  draft: ApplicationExecutionDraft,
  idempotencyKey: string,
): ApplicationExecutionRequest {
  if (!expectedScopeSchema.safeParse(scope).success) throw new ApplicationInputError("The native Work scope is not valid.")
  assertNoCredentials(draft.targetId)
  const parsed = executionRequestSchema.safeParse({
    root: scope.root,
    workId: draft.freshWorkId,
    sessionId,
    executionProfileId: draft.executionProfileId,
    targetId: draft.targetId,
    goal: parseApplicationStateInput(draft.goalJson, "Goal"),
    parameters: parseApplicationStateInput(draft.parametersJson, "Parameters"),
    idempotencyKey,
  })
  if (!parsed.success) {
    throw new ApplicationInputError("Supply an existing fresh Work UUID, execution-profile UUID and scoped target identifier. This is not credential entry.")
  }
  if (parsed.data.workId === scope.workId) throw new ApplicationInputError("Fresh execution must use a different existing Work from the frozen acquisition Work.")
  return parsed.data
}

export async function executeApplication(
  scope: ApplicationSemanticsScope,
  request: ApplicationExecutionRequest,
  currentUse: ApplicationCurrentUse,
): Promise<{ sessionId: string }> {
  const body = executionRequestSchema.parse(request)
  if (body.workId === scope.workId || !sameRoot(body.root, scope.root)) throw new ApplicationProjectionError()
  assertNoCredentials(body.goal)
  assertNoCredentials(body.parameters)
  assertNoCredentials(body.targetId)
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  const response = await centropyPost<unknown>("company-brain/application-execute", body)
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  // Acknowledgement is not a receipt; only a fresh Work projection is rendered.
  return applicationRegistrationSchema.parse(response)
}

export async function cancelApplication(
  scope: ApplicationSemanticsScope,
  currentUse: ApplicationCurrentUse,
): Promise<void> {
  const current = expectedScopeSchema.parse(scope)
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
  await centropyPost<unknown>("company-brain/application-cancel", { root: current.root, workId: current.workId })
  assertCurrentSession(currentUse.sessionKey, currentUse.signal)
}

export function applicationUseBlockReason(session: ApplicationSession, now: number): string | null {
  if (session.cancelledAt || session.id !== session.parentId) {
    return "Fresh execution consumes a non-cancelled frozen acquisition parent, not a child session."
  }
  if (session.effects.some(effect => ["POSSIBLE_EGRESS", "PENDING", "UNKNOWN"].includes(effect.status))) {
    return "An original effect may be outstanding. Do not replay it or treat cancellation as compensation."
  }
  if (session.effects.some(effect => effect.status === "PREPARED"
    || (effect.status === "VERIFIED" && effect.observation_ref === null))) {
    return "An original preparation or missing independent observation is unresolved. A status label is not effect closure."
  }
  if (session.status !== "MODEL_READY") return "The native acquisition parent has not frozen a MODEL_READY model."
  if (!session.model || !session.check) return "A bound logical model and its independent model check are not yet supplied."
  if (session.check.disposition !== "ACCEPTED_EVIDENCED_DOMAIN" || session.check.falseValid
    || session.check.falseInvalid || session.check.counterexamples.length
    || session.check.acceptedOperationIds.length !== session.model.operations.length) {
    return "The independent check does not accept this complete retained operation domain without reported predicate failures."
  }
  // Native envelopes remain GENERATED: MODEL_READY plus the separate check
  // freezes the model. Do not invent a promotion/relabel requirement or grant.
  if (["STALE", "REVOKED", "UNKNOWN"].includes(session.model.envelope.lifecycle_state)) {
    return "Artifact validity is stale, revoked or UNKNOWN; current use must be resolved natively."
  }
  if (now < Date.parse(session.model.envelope.validAfter)
    || now >= Date.parse(session.model.envelope.validUntil)
    || now >= Date.parse(session.deadlineAt)) {
    return "The model validity window or original Work deadline does not allow current use."
  }
  return null
}
