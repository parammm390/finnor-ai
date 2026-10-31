import { ExperimentRefSchema } from "@finnor/epistemic-runtime";
import { CapabilityRequestSchema, PywhyAssessmentRequestSchema } from "../packages/orchestration/src/capabilities/contracts";
import { NangoConnectInputSchema } from "../packages/orchestration/src/capabilities/nango-bindings";
import { PlannerActivationRequestSchema } from "../packages/orchestration/src/capabilities/planner-activation";
// OpenAPI is generated from the active Phase-5 boundary schemas only. Historical
// Water webhook payloads are intentionally opaque quarantine receipts and never
// regain an executable public schema here.
import {createHash} from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import {
  SubmitInstructionSchema,
  StartObjectiveSchema,
  ControlObjectiveSchema,
  HandoffWorkSchema,
  StartOutcomePackSchema,
  SetOutcomePackEnabledSchema,
  ConfirmActionSchema,
  RejectActionSchema,
  EscalateActionSchema,
  CreateAutonomyGrantSchema,
  UpsertPolicySchema,
  VapiWebhookSchema,
} from "@finnor/policy-schema";
import {
  UnderwritingArtifactComparisonSchema,
  UnderwritingCreateArtifactBindingSchema,
  UnderwritingCreateModelSchema,
  UnderwritingCreateModelVersionSchema,
  UnderwritingCreateRunSchema,
  UnderwritingCreateScenarioSchema,
  UnderwritingCreateSensitivitySchema,
  UnderwritingProjectionSchema,
} from "../apps/api/lib/underwriting";
import {
  IcAnswerQuestionSchema,
  IcCaseTransitionSchema,
  IcCloseVotingSchema,
  IcCommitteeConfigurationSchema,
  IcConditionSchema,
  IcConditionTransitionSchema,
  IcCreateCaseSchema,
  IcCreateQuestionSchema,
  IcDecisionProposalSchema,
  IcDissentSchema,
  IcFinalizeDecisionSchema,
  IcOpenVotingSchema,
  IcQuestionSourceSchema,
  IcRecommendationSchema,
  IcReviewedDeckLinkSchema,
  IcResolveQuestionSchema,
  IcSatisfyConditionSchema,
  IcSelectMemoSchema,
  IcSelectUnderwritingRunSchema,
  IcSupersedeQuestionSchema,
  IcVoteSchema,
  IcWaiveConditionSchema,
  IcWaiveQuestionSchema,
} from "../apps/api/lib/ic";
import { PeDigitalTwinRequestSchema } from "../apps/api/lib/pe-digital-twin";
import { OperatingProfileUpdateSchema } from "../apps/api/lib/operating-profile";
import { UserPreferencesPatchSchema } from "../apps/api/lib/user-preferences";
import { WorkflowRunControlSchema } from "../apps/api/lib/run-control-route";
import { CreateThreadSchema, DeletePushSubscriptionSchema, EmptyProductControlSchema, GoogleConnectionStartSchema, HumanClosingActionSchema, InitiateCompensationSchema, PushSubscriptionSchema, ResolveReconciliationSchema, SubmitCorrectionSchema } from "../apps/api/lib/product-control-schemas";
import { PE_ENTITY_TYPES, PE_WORLD_ROOT_TYPES } from "@finnor/private-equity";
import { EVIDENCE_OPERATIONS, EvidenceOperationSchemas } from "../packages/private-equity/src/evidence-execution/api";
import { PRIMARY_OPERATIONS, PrimaryOperationSchemas } from "../packages/private-equity/src/primary-diligence/api";
import { BilateralOperationSchemas } from "../packages/private-equity/src/bilateral-opportunities/api";
import { PROGRAM_OPERATIONS } from "../packages/private-equity/src/program-synthesis/api";
import { COMPUTE_SEARCH_OPERATIONS } from "../packages/private-equity/src/compute-search/api";
import { INTERFACE_OPERATIONS } from "../packages/private-equity/src/interface-synthesis/api";
import { APPLICATION_OPERATIONS, APPLICATION_OPERATION_SCHEMAS } from "../packages/private-equity/src/enterprise-applications/api";
import {LEARNING_OPERATION_SCHEMAS,LEARNING_OPERATIONS} from "../packages/private-equity/src/policy-learning/api";
import {IDENTIFICATION_OPERATION_SCHEMAS,IDENTIFICATION_OPERATIONS} from "../packages/private-equity/src/system-identification/api";
import {EconomicOperationSchemas,EconomicOperations} from "../packages/private-equity/src/economic-action-theory/api";
import {StrategicOperationSchemas,StrategicOperations} from "../packages/private-equity/src/strategic-response/api";
import {CONFIDENTIAL_OPERATION_SCHEMAS,CONFIDENTIAL_OPERATIONS} from "../packages/private-equity/src/confidential-computation/api";
import {InteractionOperationSchemas,InteractionOperations} from "../packages/private-equity/src/interaction-synthesis/api";
import { ApplicationExpressionSchema } from "../packages/private-equity/src/enterprise-applications/contracts";
import { M1_OPERATIONS, M1OperationSchemas } from "../packages/private-equity/src/decision-slice/handler";
import { CapitalProgramV2Operations } from "@finnor/shared-types";
import { M4Operations } from "../packages/private-equity/src/counterexample-search/handler";
import { CAPITAL_FORMATION_OPERATIONS } from "../packages/private-equity/src/capital-formation/contracts";
import { CONTINUATION_OPERATIONS } from "../packages/private-equity/src/live-recompilation/api";
import { ClosingOperationSchemas } from "../packages/private-equity/src/closing/contracts";
import { OpportunityHandoffSchema } from "../packages/private-equity/src/opportunity-handoff";
import { PROCEDURE_OPERATIONS, PROCEDURE_OPERATION_SCHEMAS } from "../packages/private-equity/src/procedure-induction/api";
import { APPLICATION_OPERATIONS as APPLICATION_SEMANTICS_OPERATIONS, APPLICATION_OPERATION_SCHEMAS as APPLICATION_SEMANTICS_OPERATION_SCHEMAS } from "../packages/private-equity/src/application-semantics/api";
import { INSTITUTION_OPERATIONS } from "../packages/private-equity/src/institution-program/api";
import { DELIBERATION_OPERATIONS } from "../packages/private-equity/src/deliberation/api";
import { ElicitationOperationSchemas } from "../packages/epistemic-runtime/src/incentive-rule-synthesis/contracts";
import { R3OwnerOperationSchemas, R3WorkReviewSchema } from "../packages/epistemic-runtime/src/incentive-rule-synthesis/output-contracts";
import { ObligationOperationSchemas } from "../packages/private-equity/src/obligation-contracts";
import { ComputeSearchRequestSchema, SearchIdSchema, SearchProjectionSchema } from "../packages/private-equity/src/compute-search/contracts";
import { R4_OPERATIONS, R4_OPERATION_SCHEMAS } from "../packages/private-equity/src/r4/contracts";
import { OperationSchemas as DecisionAtlasOperationSchemas } from "../packages/private-equity/src/r7/contracts";
import { CalibrationRequestSchema, DeliberationRequestSchema, DeliberationEvidenceReadSchema, DeliberationCurrentReaderSchema, DeliberationProjectionSchema, DeliberationModuleReaderSchema } from "../packages/private-equity/src/deliberation/contracts";
import { LIVE_CONTROL_OPERATION_SCHEMAS } from "../packages/private-equity/src/live-controls/contracts";
import {OperationSchemas as UniformAlgorithmOperationSchemas} from "../packages/private-equity/src/uniform-algorithms/contracts";
import {AssignSchema as UniformAssignSchema,EvaluateSchema as UniformEvaluateSchema,AdmissionRequestSchema as UniformAdmissionRequestSchema,AdmissionCurrentSchema as UniformAdmissionCurrentSchema} from "../packages/private-equity/src/uniform-algorithms/admission";
import {SpecificationReadSchema} from "../packages/private-equity/src/uniform-algorithms/specification";
import {TotalSubmitSchema,TotalConsumeSchema,TotalReadSchema} from "../packages/private-equity/src/uniform-algorithms/total-contracts";
import {RecordTotalTaskSchema} from "../packages/private-equity/src/allocation-total-episodes";

const uniformAlgorithmOperations={
 ...UniformAlgorithmOperationSchemas,
 specification:SpecificationReadSchema,
 'record-task-episode':RecordTotalTaskSchema,
 'submit-total':TotalSubmitSchema,'consume-total':TotalConsumeSchema,
 read:TotalReadSchema,
 'assign-evaluation':UniformAssignSchema,evaluate:UniformEvaluateSchema,
 's8-propose':UniformAdmissionRequestSchema,admission:UniformAdmissionCurrentSchema,
};

const page = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(4096).optional() }).strict();
const workforcePage = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional() }).strict();
const range = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict();
const localRange = z.object({
  startDate: z.string().regex(/^(?:today|tomorrow|\d{4}-\d{2}-\d{2})$/),
  endDate: z.string().regex(/^(?:today|tomorrow|\d{4}-\d{2}-\d{2})$/).optional(),
}).strict();
const partyRef = z.object({
  partyType: z.enum(["employee", "team", "location", "external_organization", "external_contact"]),
  partyId: z.string().uuid(),
}).strict();
const entityRef = z.object({
  entityType: z.enum(["work", "task", "user", "org_unit", "tenant_location", "external_organization", "external_contact", "document", "domain_action", "workflow_run", "workflow_step", ...PE_ENTITY_TYPES]),
  entityId: z.string().uuid(),
}).strict();
const deal = { dealId: z.string().uuid(), page: page.optional() } as const;
const peWorldRoot = z.object({
  entityType: z.enum(PE_WORLD_ROOT_TYPES),
  entityId: z.string().uuid(),
}).strict();
const queryEnvelope = {
  workId: z.string().uuid().optional(),
  executionKey: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
} as const;

const MicrosoftConnectionAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("federated_workload"),
    awsRegion: z.string().trim().min(1).max(40),
    federationAudience: z.string().trim().min(1).max(512),
    federationConfigId: z.string().trim().min(1).max(256),
    signingAlgorithm: z.enum(["ES384", "RS256"]),
    identityTokenDurationSeconds: z.number().int().min(60).max(3_600).optional(),
  }).strict(),
  z.object({
    kind: z.literal("managed_certificate"),
    credentialRef: z.string().trim().min(1).max(1_024),
    credentialVersion: z.string().trim().min(1).max(256).optional(),
    certificateFallbackAcknowledged: z.literal(true),
  }).strict(),
]);
const MicrosoftConnectionStartSchema = z.object({
  directoryTenantId: z.string().uuid(),
  applicationClientId: z.string().uuid(),
  requestedPermissions: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
  auth: MicrosoftConnectionAuthSchema,
  redirectUri: z.string().url().max(2_048).optional(),
}).strict();
const MicrosoftSourceKindSchema = z.enum([
  "outlook_mail_folder",
  "outlook_calendar_view",
  "teams_channel",
  "teams_chat",
  "teams_user_chat_feed",
  "teams_transcript_organizer",
  "sharepoint_drive",
  "sharepoint_list",
]);
const MicrosoftSourceScopeSchema = z.object({
  sourceKind: MicrosoftSourceKindSchema,
  permissionMode: z.enum(["SCOPED", "BROAD"]),
  configuration: z.record(z.string(), z.unknown()),
  negativeProbeConfiguration: z.record(z.string(), z.unknown()).nullable().optional(),
  acknowledgeBroadAccess: z.boolean().optional(),
  rootBinding: z.object({ type: z.enum(PE_WORLD_ROOT_TYPES), id: z.string().uuid() }).strict().nullable().optional(),
  freshnessPolicy: z.object({
    maxAgeSeconds: z.number().int().min(60).max(604_800),
    criticality: z.enum(["informational", "operational", "consequential"]),
    staleBehavior: z.enum(["allow_with_warning", "refresh_then_degrade", "refresh_then_block"]),
  }).strict().optional(),
}).strict();
const MicrosoftGraphNotificationSchema = z.object({
  value: z.array(z.object({
    subscriptionId: z.string().min(1).max(512),
    clientState: z.string().min(1).max(128),
    tenantId: z.string().uuid(),
    resource: z.string().min(1).max(4_096).optional(),
    changeType: z.enum(["created", "updated", "deleted"]).optional(),
    lifecycleEvent: z.enum(["reauthorizationRequired", "subscriptionRemoved", "missed"]).optional(),
    subscriptionExpirationDateTime: z.string().datetime({ offset: true }).optional(),
  }).passthrough()).min(1).max(100),
}).strict();

const ArtifactKindSchema = z.enum(["xlsx", "docx", "pptx"]);
const ArtifactCreateSchema = z.object({ kind: ArtifactKindSchema, title: z.string().trim().min(1).max(500) }).strict();
const ArtifactDraftSchema = z.object({ baseVersionId: z.string().uuid() }).strict();
const ArtifactPatchSchema = z.object({
  baseVersionId: z.string().uuid(),
  draftKey: z.string().min(1).max(512),
  operations: z.array(z.record(z.string(), z.unknown())).min(1).max(1_000),
  expectedSemanticHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
const ArtifactCommentSchema = z.object({
  versionId: z.string().uuid(),
  anchorId: z.string().min(1).max(2_048),
  anchorHash: z.string().regex(/^[0-9a-f]{64}$/),
  body: z.string().trim().min(1).max(10_000),
  parentCommentId: z.string().uuid().optional(),
}).strict();
const ArtifactReviewSchema = z.object({
  versionId: z.string().uuid(),
  state: z.enum(["requested", "approved", "changes_requested", "withdrawn", "comment_resolved"]),
  commentId: z.string().uuid().optional(),
}).strict();
const ArtifactBindingSchema = z.object({
  versionId: z.string().uuid(),
  anchorId: z.string().min(1).max(2_048),
  anchorHash: z.string().regex(/^[0-9a-f]{64}$/),
  targetKind: z.enum(["evidence_version", "canonical_entity", "document_version"]),
  targetId: z.string().uuid(),
  targetEntityType: z.string().min(1).max(160).optional(),
  targetAnchor: z.string().min(1).max(2_048).optional(),
}).strict();
const ArtifactLineageSchema = z.object({
  sourceVersionId: z.string().uuid(),
  targetVersionId: z.string().uuid(),
  relation: z.enum(["supersedes", "derived_from", "copied_from", "template_instantiation", "rendered_from", "merged_from"]),
}).strict();
const ArtifactPublishSchema = z.object({
  localVersionId: z.string().uuid(),
  baseVersionId: z.string().uuid(),
  mode: z.enum(["APP_ONLY_FILE_REPLACE", "DELEGATED_FILE_REPLACE"]),
}).strict();
const ArtifactProviderCreateSchema = z.object({
  localVersionId: z.string().uuid(),
  integrationId: z.string().uuid(),
  sourceScopeId: z.string().uuid(),
  driveId: z.string().trim().min(1).max(1_024),
  parentItemId: z.string().trim().min(1).max(1_024),
  name: z.string().trim().min(1).max(255),
  mode: z.enum(["APP_ONLY_FILE_CREATE", "DELEGATED_FILE_CREATE"]),
  conflictBehavior: z.literal("fail"),
}).strict();
const ArtifactRecalculateSchema = z.object({
  versionId: z.string().uuid(),
  ranges: z.array(z.object({ worksheetId: z.string().min(1).max(512), address: z.string().min(1).max(512) }).strict()).max(100),
}).strict();
const ArtifactTemplateSchema = z.object({ documentId: z.string().uuid(), versionId: z.string().uuid(), templateKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,158}[a-z0-9]$/) }).strict();
const ArtifactTemplateInstantiateSchema = z.object({ title: z.string().trim().min(1).max(500) }).strict();

const OperationalQuerySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("work_list"), ...queryEnvelope, section: z.enum(["all", "works", "tasks"]).optional(), openOnly: z.boolean().optional(), statuses: z.array(z.string().min(1).max(80)).max(20).optional(), recordId: z.string().uuid().optional(), page: page.optional() }).strict(),
  // Employee/tenant identity is injected from the authenticated context. In
  // particular, this branch deliberately exposes no selector that could turn
  // the causal attention projection into a cross-employee read.
  z.object({ intent: z.literal("attention_queue"), ...queryEnvelope, page: page.optional() }).strict(),
  z.object({ intent: z.literal("agent_activity"), ...queryEnvelope, range: range.optional(), localDateRange: localRange.optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("workforce_status"), ...queryEnvelope, page: workforcePage.optional() }).strict(),
  z.object({ intent: z.literal("company_context"), ...queryEnvelope, anchor: z.union([entityRef, partyRef]).optional(), query: z.string().trim().min(1).max(300).optional() }).strict(),
  z.object({ intent: z.literal("party_lookup"), ...queryEnvelope, ref: partyRef.optional(), query: z.string().trim().min(1).max(300).optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("party_context"), ...queryEnvelope, ref: partyRef.optional(), query: z.string().trim().min(1).max(300).optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("team_roster"), ...queryEnvelope, teamRef: partyRef.optional(), query: z.string().trim().min(1).max(300).optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("pe_world_state"), ...queryEnvelope, root: peWorldRoot, at: z.string().datetime({ offset: true }).optional(), validAt: z.string().datetime({ offset: true }).optional(), knowledgeAt: z.string().datetime({ offset: true }).optional() }).strict(),
  z.object({ intent: z.literal("deal_context"), ...queryEnvelope, ...deal }).strict(),
  z.object({ intent: z.literal("deal_workstreams"), ...queryEnvelope, ...deal, states: z.array(z.string().min(1).max(80)).max(20).optional(), owner: partyRef.optional() }).strict(),
  z.object({ intent: z.literal("open_requests"), ...queryEnvelope, ...deal, workstreamId: z.string().uuid().optional(), requestedFrom: partyRef.optional(), dueState: z.enum(["any", "overdue", "not_overdue"]).optional() }).strict(),
  z.object({ intent: z.literal("open_findings"), ...queryEnvelope, ...deal, workstreamId: z.string().uuid().optional(), severities: z.array(z.enum(["low", "medium", "high", "critical"])).optional() }).strict(),
  z.object({ intent: z.literal("open_deal_risks"), ...queryEnvelope, ...deal, workstreamId: z.string().uuid().optional(), severities: z.array(z.enum(["low", "medium", "high", "critical"])).optional() }).strict(),
  z.object({ intent: z.literal("critical_dependencies"), ...queryEnvelope, ...deal, includeResolved: z.boolean().optional() }).strict(),
  z.object({ intent: z.literal("closing_readiness"), ...queryEnvelope, ...deal }).strict(),
]);
const WorkforceCapabilityGrantSchema = z.object({ capability: z.string().trim().min(1).max(240), kind: z.enum(["query", "action", "wait", "check"]) }).strict();
const WorkforceConfigureProfileSchema = z.object({
  profileId: z.string().uuid().optional(),
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  name: z.string().trim().min(1).max(160),
  status: z.enum(["enabled", "disabled"]).optional(),
  modelRoute: z.object({ provider: z.string().trim().min(1).max(120), model: z.string().trim().min(1).max(240).nullable().optional(), purpose: z.literal("objective_execution") }).strict().optional(),
  capabilityGrants: z.array(WorkforceCapabilityGrantSchema).min(1).max(512),
  maxConcurrentAssignments: z.number().int().min(1).max(32).optional(),
  autonomyLimits: z.object({
    maxActions: z.number().int().min(1).max(4).optional(),
    maxQueries: z.number().int().min(1).max(11).optional(),
    maxReplans: z.number().int().min(1).max(8).optional(),
    maxPlannerCalls: z.number().int().min(1).max(11).optional(),
    maxWallClockMs: z.number().int().min(1_000).max(604_799_999).optional(),
    maxKnownCostUsd: z.number().nonnegative().finite().nullable().optional(),
    maxKnownTokens: z.number().int().nonnegative().nullable().optional(),
  }).strict().optional(),
  planningHints: z.record(z.string(), z.unknown()).optional(),
  learningRevisionId: z.string().uuid().nullable().optional(),
}).strict();
const WorkforceReviewProposalSchema = z.object({ decision: z.enum(["promote", "reject"]) }).strict();
const WorkforceReassignSchema = z.object({ note: z.string().trim().min(1).max(2_000).optional() }).strict();

const RawActivityItemSchema = z.object({
  source: z.enum(["action_log", "workflow_step", "computer_step", "work_event", "call"]),
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  detail: z.record(z.string(), z.unknown()),
}).strict();
const RawActivityPageSchema = z.object({
  items: z.array(RawActivityItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
}).strict();
const SemanticActivityInputSchema = z.object({
  root: peWorldRoot,
  asOf: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
}).strict();

const s = (schema: z.ZodTypeAny) => z.toJSONSchema(schema, { io: "input", target: "draft-07", reused: "inline" });
const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema: s(schema) } } });
// Named components preserve the recursive expression language. Inlining it
// with refStrategy "none" would silently turn nested expressions into "any".
const applicationSchema=(schema:z.core.$ZodType)=>{
 // This installed converter has no 3.1 target. Its JSON Schema vocabulary
 // supplies numeric exclusive bounds and null unions, unlike openApi3 (3.0).
 const converted=z.toJSONSchema(schema,{io:"input",target:"draft-07",reused:"inline",
  override:({zodSchema,jsonSchema})=>{
   if(Object.is(zodSchema,ApplicationExpressionSchema)){
    for(const key of Object.keys(jsonSchema))delete jsonSchema[key];
    jsonSchema.$ref="#/components/schemas/X3Expression";
   }
  }});
 // These compatible keywords inherit the document's OpenAPI 3.1 dialect.
 // Retain the converter scope marker until document-local references are rebased.
 return converted;
};
const applicationComponents={schemas:Object.fromEntries([
 ["X2ApplicationCancel",applicationSchema(APPLICATION_SEMANTICS_OPERATION_SCHEMAS["application-cancel"])],
 ...Object.entries(APPLICATION_OPERATION_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(LEARNING_OPERATION_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(IDENTIFICATION_OPERATION_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(EconomicOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(StrategicOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(CONFIDENTIAL_OPERATION_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(InteractionOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(uniformAlgorithmOperations).map(([name,schema])=>['Y5Uniform-'+name,applicationSchema(schema)]),
 ["X3Expression",applicationSchema((ApplicationExpressionSchema instanceof z.ZodLazy ? ApplicationExpressionSchema.unwrap() : ApplicationExpressionSchema))],
])};
const secured = [{ bearerAuth: [] }];
const documentIdParameter = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } } as const;
const workforcePageParameters = [
  { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
  { name: "cursor", in: "query", required: false, schema: { type: "string", format: "uuid" } },
] as const;
const artifactVersionQueryParameter = { name: "versionId", in: "query", required: true, schema: { type: "string", format: "uuid" } } as const;
const icCaseIdParameter = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } } as const;
const icQuestionIdParameter = { name: "questionId", in: "path", required: true, schema: { type: "string", format: "uuid" } } as const;
const icConditionIdParameter = { name: "conditionId", in: "path", required: true, schema: { type: "string", format: "uuid" } } as const;
const icMutation = (schema: z.ZodTypeAny, description: string, parameters: readonly Record<string, unknown>[] = [icCaseIdParameter]) => ({
  security: secured,
  parameters,
  requestBody: json(schema),
  responses: {
    "200": { description },
    "400": { description: "Strict request schema rejected unknown or invalid input" },
    "403": { description: "Authenticated employee lacks the required Core Authority capability" },
    "409": { description: "Version, identity, or idempotency precondition conflict" },
    "422": { description: "Pinned IC policy or lifecycle prerequisite blocks the transition" },
  },
});
const paths = {
  "/api/interventions/assess-pywhy": { post: { security: secured, requestBody: json(PywhyAssessmentRequestSchema.extend({ interventionModelRef: ExperimentRefSchema }).strict()), responses: { "202": { description: "S3-bound conditional assessment accepted into the canonical HEAVY queue; temporal model remains unchanged" }, "200": { description: "Original assessment submission replayed" }, "404": { description: "Current permitted S3 model is unavailable" } } } },
  "/api/interventions/read-pywhy-assessment": { post: { security: secured, requestBody: json(z.object({ runId: z.string().uuid() }).strict()), responses: { "200": { description: "Current-authorized S3-bound PyWhy result with separate estimator/assumption/diagnostic qualification; no temporal model compatibility or admission" }, "404": { description: "Owned S3 assessment or its current model context is unavailable" } } } },
  "/api/capabilities/runs": {
    get: { security: secured, parameters: [
      { name: "documentId", in: "query", schema: { type: "string", format: "uuid" }, description: "Requires versionId for exact document scope" },
      { name: "versionId", in: "query", schema: { type: "string", format: "uuid" } },
      { name: "kind", in: "query", schema: { type: "string" } },
      { name: "cursor", in: "query", schema: { type: "string", format: "uuid" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 25 } },
    ], responses: { "200": { description: "Owned, currently authorized metadata page; no result payloads" } } },
    post: { security: secured, requestBody: json(CapabilityRequestSchema), responses: { "202": { description: "Canonical HEAVY computation accepted; not a completed result or business authority" }, "200": { description: "Same request replayed under its original idempotency key" }, "403": { description: "Current source or capability authority denied" }, "409": { description: "Idempotency or immutable source identity conflict" } } },
  },
  "/api/capabilities/runs/{id}": { get: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Owned run with current source rights; typed result, failure, retained remote identity or uncertain outcome" }, "404": { description: "Owned accessible run not found" }, "403": { description: "Current source or capability authority denied" } } } },
  "/api/capabilities/nango/connect": { post: { security: secured, requestBody: json(NangoConnectInputSchema), responses: { "201": { description: "Prepared owner-bound authorization session; credential returned once and never stored" }, "409": { description: "Session intent idempotency conflict" } } } },
  "/api/capabilities/nango/sources": { get: { security: secured, responses: { "200": { description: "Server-approved read-only catalog and current-authorized source bindings/checkpoints" } } } },
  "/api/capabilities/planner/activation": {
    get: { security: secured, responses: { "200": { description: "Reviewed background planner preference and expected revision" } } },
    post: { security: secured, requestBody: json(PlannerActivationRequestSchema), responses: { "200": { description: "Immutable reviewed candidate activation or incumbent restoration; no business execution authority" }, "409": { description: "Reviewed digest, environment, expected revision or idempotency conflict" }, "403": { description: "Planner activation authority denied" } } },
  },
  "/api/webhooks/nango": { post: { parameters: [{ name: "x-nango-hmac-sha256", in: "header", required: true, schema: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } }], requestBody: { content: { "application/json": { schema: { type: "object", description: "Raw bytes verified with the distinct webhook HMAC key before parsing or prepared-identity routing" } } } }, responses: { "202": { description: "Prepared binding or bounded source-sync wake accepted; webhook records not applied" }, "403": { description: "Exact-byte HMAC invalid" } } } },
  "/api/live-controls": {
    post: { security: secured, requestBody: json(z.union([
      z.object({ operation: z.literal("begin"), input: LIVE_CONTROL_OPERATION_SCHEMAS.open.omit({ workId: true }).extend({ idempotencyKey: z.string().uuid() }).strict() }).strict(),
      z.object({ operation: z.literal("end-delivery"), input: z.object({}).strict() }).strict(),
      ...Object.entries(LIVE_CONTROL_OPERATION_SCHEMAS).map(([operation, schema]) => z.object({ operation: z.literal(operation), input: schema }).strict()),
    ])), responses: {
      "200": { description: "Recipient-bound control snapshot or original owner disposition. A preview is hypothetical and reserves nothing; delivery termination never cancels effects." },
      "401": { description: "A verified current provider session is required." }, "403": { description: "Current native S1 authority or actor profile denied." },
      "404": { description: "The permitted control context is unavailable." }, "409": { description: "Material version, exact approval, recipient cut or idempotency conflict." },
      "413": { description: "Finite input bound exceeded." }, "422": { description: "Native semantics, current model or original grant unavailable." },
    } },
  },
  "/api/outcome-packs/control": {
    post: { security: secured, requestBody: json(SetOutcomePackEnabledSchema), responses: { "200": { description: "Owner recorded exact mission enablement; runtime authority remains enforced for every effect" }, "403": { description: "Only a human owner can change mission enablement" } } },
  },
  "/api/actions/human": {
    post: { security: secured, requestBody: json(HumanClosingActionSchema), responses: { "201": { description: "Exact human-authored closing decision drafted in canonical Work and Thread, awaiting effect review" }, "200": { description: "Same exact intake replayed without a second action" }, "403": { description: "Canonical human identity or verifier identity rejected" }, "409": { description: "Intake key belongs to a different decision" }, "422": { description: "Canonical grounding or authority rejects the decision" } } },
  },
  "/api/computer/runs/{id}/cancel": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(EmptyProductControlSchema), responses: { "200": { description: "Durable cancellation requested for the exact computer run" }, "403": { description: "Actor cannot cancel this run" } } },
  },
  "/api/connections/{ref}": {
    get: { security: secured, parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Canonical provider connection status" } } },
    delete: { security: secured, parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Connection revoked by its owning security service" } } },
  },
  "/api/connections/{ref}/verify": {
    post: { security: secured, parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }], requestBody: json(EmptyProductControlSchema), responses: { "200": { description: "Provider readback confirms a usable connection" }, "409": { description: "Provider connection is not usable" } } },
  },
  "/api/connections/google/start": {
    post: { security: secured, requestBody: json(GoogleConnectionStartSchema), responses: { "200": { description: "PKCE authorization URL and HTTP-only state cookie issued" }, "409": { description: "Canonical auth profile or provider configuration is unavailable" } } },
  },
  "/api/reconciliation/{id}/resolve": { post: icMutation(ResolveReconciliationSchema, "Evidence-bearing resolution recorded by the canonical workflow owner") },
  "/api/workflows/steps/{id}/compensate": { post: icMutation(InitiateCompensationSchema, "Canonical compensation requested after legal-state and authority checks") },
  "/api/private-equity/ic/cases/{id}/reviewed-deck-link": { post: icMutation(IcReviewedDeckLinkSchema, "Exact approved deck version linked and independently read back in its Deal-root IC case") },
  "/api/push-subscriptions": {
    post: { security: secured, requestBody: json(PushSubscriptionSchema), responses: { "201": { description: "Authenticated browser's actual Web Push subscription recorded" } } },
    delete: { security: secured, requestBody: json(DeletePushSubscriptionSchema), responses: { "204": { description: "Own device subscription removed" } } },
  },
  "/api/operating-profile": {
    get: { security: secured, responses: { "200": { description: "Own employee profile and canonical tenant operating profile with owner editability" } } },
    put: { security: secured, requestBody: json(OperatingProfileUpdateSchema), responses: { "200": { description: "Own employee or owner-authorized company profile saved" }, "403": { description: "Company profile edit requires owner authority" } } },
  },
  "/api/user-prefs": {
    get: { security: secured, responses: { "200": { description: "Authenticated employee preferences" } } },
    put: { security: secured, requestBody: json(UserPreferencesPatchSchema), responses: { "200": { description: "Own validated preferences saved" } } },
    delete: { security: secured, responses: { "200": { description: "Own preferences reset to canonical defaults" } } },
  },
  "/api/threads": {
    post: { security: secured, requestBody: json(CreateThreadSchema), responses: {
      "201": { description: "Private Investigation created, or the caller's existing exact Work Investigation reused with its current Objective. No Work or business execution is created." },
      "400": { description: "Strict title or Work reference rejected" },
      "401": { description: "Current authenticated bearer required" },
      "403": { description: "Active canonical human principal required" },
      "404": { description: "Work is absent or outside the authenticated tenant" },
    } },
  },
  "/api/outcome-packs/grants": {
    get: { security: secured, responses: { "200": { description: "Owner-visible tenant autonomy grants" } } },
    post: { security: secured, requestBody: json(CreateAutonomyGrantSchema), responses: { "201": { description: "Human owner created the bounded autonomy grant" } } },
  },
  "/api/outcome-packs/grants/{id}": { delete: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Human owner revoked the exact autonomy grant" } } } },
  "/api/actions": { post: { security: secured, responses: { "201": { description: "Instruction accepted into governed Work" } } } },
  "/api/actions/pending": { get: { security: secured, responses: { "200": { description: "Tenant-scoped pending action page" } } } },
  "/api/employees": { get: { security: secured, responses: { "200": { description: "Tenant-scoped employee list" } } } },
  "/api/events": { get: { security: secured, responses: { "200": { description: "Tenant-scoped business events" } } } },
  "/api/operational-deltas": { get: { security: secured, parameters: [
    { name: "cursor", in: "query", required: false, schema: { type: "string" } },
    { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 250 } },
  ], responses: { "200": { description: "Bounded tenant-scoped operational delta page" }, "400": { description: "Invalid cursor or limit" }, "409": { description: "Cursor tenant scope mismatch" } } } },
  "/api/read-models/{view}": { get: { security: secured, parameters: [{ name: "view", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Named tenant-scoped read model" } } } },
  "/api/insights": { get: { security: secured, responses: { "200": { description: "Tenant-scoped insights" } } } },
  "/api/setup/status": { get: { security: secured, responses: { "200": { description: "Source-backed setup status" } } } },
  "/api/integrations/status": { get: { security: secured, responses: { "200": { description: "Source-backed integration status" } } } },
  "/api/audit": { get: { security: secured, responses: { "200": { description: "Tenant-scoped audit records" } } } },
  "/api/receipts": { get: { security: secured, responses: { "200": { description: "Tenant-scoped decision receipts" } } } },
  "/api/receipts/{id}": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact decision receipt" } } } },
  "/api/me": { get: { security: secured, responses: { "200": { description: "Authenticated employee context" } } } },
  "/api/dlq": { get: { security: secured, responses: { "200": { description: "Tenant-scoped dead-letter page" } } } },
  "/api/dlq/{id}": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact dead-letter record" } } } },
  "/api/dlq/{id}/replay": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized dead-letter replay requested" } } } },
  "/api/dlq/{id}/discard": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized dead-letter discard recorded" } } } },
  "/api/corrections": { get: { security: secured, responses: { "200": { description: "Tenant-scoped corrections" } } }, post: { security: secured, requestBody: json(SubmitCorrectionSchema), responses: { "201": { description: "Receipt-linked human correction recorded" } } } },
  "/api/vitals": { get: { security: secured, responses: { "200": { description: "Queue and runtime vitals" } } } },
  "/api/activity": { get: { security: secured, responses: { "200": { description: "Tenant-scoped raw diagnostic activity", ...json(RawActivityPageSchema) } } } },
  "/api/semantic-activity": { post: { security: secured, requestBody: json(SemanticActivityInputSchema), responses: { "200": { description: "Deterministic tenant-scoped PE semantic activity from P1-P7 canonical records" }, "400": { description: "Strict request schema rejected unknown or invalid input" }, "404": { description: "PE root absent from the authenticated tenant" } } } },
  "/api/company-brain/{operation}": { post: { security: secured, parameters: [{ name: "operation", in: "path", required: true, schema: { type: "string", enum: ["opportunity-promote", "belief-view", "belief-pin", "roots", "projection", "search", "object", "traverse", "provenance", "history", "evidence-lineage", "decision-lineage", "available-actions", "context", ...EVIDENCE_OPERATIONS, ...PROGRAM_OPERATIONS, ...COMPUTE_SEARCH_OPERATIONS, ...INTERFACE_OPERATIONS, ...M1_OPERATIONS, ...CONTINUATION_OPERATIONS, ...PROCEDURE_OPERATIONS, ...DELIBERATION_OPERATIONS, ...Object.keys(CAPITAL_FORMATION_OPERATIONS)] } }], responses: { "200": { description: "Tenant-scoped Company Brain operation. Owner request schemas and current authority are checked by each delegated handler." }, "400": { description: "Strict request schema rejected unknown or invalid input" }, "404": { description: "Root or object absent from the authenticated tenant" } } } },
  "/api/private-equity/digital-twin": { post: { security: secured, requestBody: json(PeDigitalTwinRequestSchema), responses: { "200": { description: "Tenant-scoped PE Digital Twin query or transition" }, "201": { description: "Evidence-backed canonical PE fact, identity, observation, or exact relation created" }, "400": { description: "Strict request schema rejected unknown or invalid input" }, "404": { description: "Canonical reference absent from the authenticated tenant" }, "409": { description: "Expected version or concurrent canonical truth conflict" }, "422": { description: "Canonical invariant rejected the requested fact" } } } },
  "/api/workflows/runs": { get: { security: secured, responses: { "200": { description: "Tenant-scoped workflow runs" } } } },
  "/api/workflows/runs/{id}/pause": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkflowRunControlSchema), responses: { "200": { description: "Authorized workflow pause" } } } },
  "/api/workflows/runs/{id}/resume": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkflowRunControlSchema), responses: { "200": { description: "Authorized workflow resume" } } } },
  "/api/workflows/runs/{id}/cancel": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkflowRunControlSchema), responses: { "200": { description: "Authorized workflow cancellation" } } } },
  "/api/workflows/runs/{id}/retry": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkflowRunControlSchema), responses: { "200": { description: "Authorized workflow retry" } } } },
  "/api/workflows/runs/{id}/escalate": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkflowRunControlSchema), responses: { "200": { description: "Authorized workflow escalation" } } } },
  "/api/instructions/{id}": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact instruction lifecycle" } } } },
  "/api/instructions/{id}/events": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact instruction event stream page" } } } },
  "/api/stream": { get: { security: secured, parameters: [{ name: "instructionId", in: "query", required: true, schema: { type: "string", format: "uuid" } }], responses: {
    "200": { description: "EventSource stream for one instruction lifecycle" },
    "400": { description: "instructionId is missing" },
    "401": { description: "Bad auth" },
    "404": { description: "Instruction not found" },
  } } },
  "/api/works/{id}/execution": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact Work execution projection" } } } },
  "/api/works/{id}/replay": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact Work causal replay" } } } },
  "/api/works/{id}/objective": { get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact Work objective state" } } }, post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Objective control recorded" } } } },
  "/api/private-equity/ic/committee-configurations": {
    post: icMutation(IcCommitteeConfigurationSchema, "Immutable committee membership and Core policy revision snapshot created", []),
  },
  "/api/private-equity/ic/cases": {
    post: icMutation(IcCreateCaseSchema, "ICCase opened against one exact P1 InvestmentCase and committee configuration", []),
    get: { security: secured, responses: { "200": { description: "Bounded tenant-scoped IC Case list with exact P1, P3, P4, Recommendation, and Decision references" } } },
  },
  "/api/private-equity/ic/cases/{id}": {
    get: { security: secured, parameters: [icCaseIdParameter, { name: "asOf", in: "query", required: false, schema: { type: "string", format: "date-time" } }], responses: { "200": { description: "One deterministic no-hindsight IC aggregate read model" }, "404": { description: "ICCase absent in this tenant or at the requested time" } } },
  },
  "/api/private-equity/ic/cases/{id}/decision-proof": {
    get: { security: secured, parameters: [icCaseIdParameter], responses: { "200": { description: "Canonical P1 Decision, immutable DecisionProposal, Core Authority decision, and Core DecisionReceipt proof" } } },
  },
  "/api/private-equity/ic/cases/{id}/begin-preparation": { post: icMutation(IcCaseTransitionSchema, "ICCase entered PREPARING") },
  "/api/private-equity/ic/cases/{id}/ready-for-review": { post: icMutation(IcCaseTransitionSchema, "ICCase entered READY_FOR_REVIEW") },
  "/api/private-equity/ic/cases/{id}/open-questions": { post: icMutation(IcCaseTransitionSchema, "ICCase entered QUESTIONS_OPEN") },
  "/api/private-equity/ic/cases/{id}/ready-for-vote": { post: icMutation(IcCaseTransitionSchema, "ICCase entered READY_FOR_VOTE after deterministic prerequisites") },
  "/api/private-equity/ic/cases/{id}/withdraw": { post: icMutation(IcCaseTransitionSchema, "ICCase entered terminal WITHDRAWN") },
  "/api/private-equity/ic/cases/{id}/memos": { post: icMutation(IcSelectMemoSchema, "Exact P3 Memo or Deck DocumentVersion revision selected") },
  "/api/private-equity/ic/cases/{id}/underwriting-run": { post: icMutation(IcSelectUnderwritingRunSchema, "Exact immutable P4 UnderwritingRun selected as the primary run") },
  "/api/private-equity/ic/cases/{id}/questions": { post: icMutation(IcCreateQuestionSchema, "First-class IC Question opened, optionally linked to Core Work") },
  "/api/private-equity/ic/cases/{id}/questions/{questionId}/sources": {
    post: icMutation(IcQuestionSourceSchema, "Exact Evidence, P3 anchor, P4 Run, or canonical source attached to the Question", [icCaseIdParameter, icQuestionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/questions/{questionId}/answer": {
    post: icMutation(IcAnswerQuestionSchema, "Authenticated employee answer recorded without implying resolution", [icCaseIdParameter, icQuestionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/questions/{questionId}/resolve": {
    post: icMutation(IcResolveQuestionSchema, "Answered Question deterministically resolved", [icCaseIdParameter, icQuestionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/questions/{questionId}/waive": {
    post: icMutation(IcWaiveQuestionSchema, "Question waived under pinned policy, Core Authority, and Core DecisionReceipt", [icCaseIdParameter, icQuestionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/questions/{questionId}/supersede": {
    post: icMutation(IcSupersedeQuestionSchema, "Question explicitly superseded without rewriting its immutable history", [icCaseIdParameter, icQuestionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/recommendations": { post: icMutation(IcRecommendationSchema, "Immutable Recommendation revision pinned to exact Memo and P4 Run") },
  "/api/private-equity/ic/cases/{id}/voting/open": { post: icMutation(IcOpenVotingSchema, "Voting opened on one immutable basis under Core Authority") },
  "/api/private-equity/ic/cases/{id}/votes": { post: icMutation(IcVoteSchema, "Authenticated member's one immutable effective Vote recorded; voter identity is never accepted in the body") },
  "/api/private-equity/ic/cases/{id}/dissents": { post: icMutation(IcDissentSchema, "Authenticated member's first-class Dissent attached to their own Vote") },
  "/api/private-equity/ic/cases/{id}/conditions": { post: icMutation(IcConditionSchema, "Governed IC Condition created; it is not a P1 closing condition") },
  "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/activate": {
    post: icMutation(IcConditionTransitionSchema, "IC Condition activated", [icCaseIdParameter, icConditionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/satisfy": {
    post: icMutation(IcSatisfyConditionSchema, "IC Condition satisfied only with an exact verification source", [icCaseIdParameter, icConditionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/waive": {
    post: icMutation(IcWaiveConditionSchema, "IC Condition waived under pinned policy, Core Authority, and Core DecisionReceipt", [icCaseIdParameter, icConditionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/fail": {
    post: icMutation(IcConditionTransitionSchema, "IC Condition explicitly failed without rewriting its prior states", [icCaseIdParameter, icConditionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/supersede": {
    post: icMutation(IcConditionTransitionSchema, "IC Condition explicitly superseded without becoming a P1 closing condition", [icCaseIdParameter, icConditionIdParameter]),
  },
  "/api/private-equity/ic/cases/{id}/decision-proposals": { post: icMutation(IcDecisionProposalSchema, "Deterministic immutable DecisionProposal prepared from the exact vote set") },
  "/api/private-equity/ic/cases/{id}/voting/close": { post: icMutation(IcCloseVotingSchema, "Voting atomically closed and exact DecisionProposal frozen under Core Authority") },
  "/api/private-equity/ic/cases/{id}/finalize": { post: icMutation(IcFinalizeDecisionSchema, "P1 owner finalized the sole canonical investment Decision from exact IC proof") },
  "/api/investment-cases": {
    get: { security: secured, responses: { "200": { description: "Tenant-scoped P1 InvestmentCases with P4 model/run counts" } } },
  },
  "/api/investment-cases/{id}/underwriting": {
    get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Truthful Underwriting Workspace projection for one exact P1 InvestmentCase" }, "404": { description: "InvestmentCase not found in the authenticated tenant" } } },
  },
  "/api/underwriting/models": {
    post: { security: secured, requestBody: json(UnderwritingCreateModelSchema), responses: { "201": { description: "Logical deterministic model attached to the canonical P1 InvestmentCase" } } },
  },
  "/api/underwriting/models/{id}/versions": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(UnderwritingCreateModelVersionSchema), responses: { "201": { description: "Immutable compiled ModelIR version created" }, "409": { description: "Model version identity conflict" } } },
  },
  "/api/underwriting/scenarios": {
    post: { security: secured, requestBody: json(UnderwritingCreateScenarioSchema), responses: { "201": { description: "Immutable explicit scenario override set created without mutating P1 Assumptions" } } },
  },
  "/api/underwriting/runs": {
    post: { security: secured, requestBody: json(UnderwritingCreateRunSchema), responses: { "201": { description: "Immutable deterministic UnderwritingRun completed" }, "200": { description: "Idempotent replay returned the exact prior Run" }, "422": { description: "Required input is unknown, stale, conflicting, missing, or non-convergent" } } },
  },
  "/api/underwriting/runs/{id}": {
    get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact historical Run, InputSnapshot, checks, outputs, engine version, and hashes" }, "404": { description: "Run not found in the authenticated tenant" } } },
  },
  "/api/underwriting/runs/{id}/explain": {
    get: { security: secured, parameters: [documentIdParameter, { name: "nodeId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 240 } }], responses: { "200": { description: "Deterministic recursive calculation and exact source lineage" } } },
  },
  "/api/underwriting/runs/diff": {
    get: { security: secured, parameters: [
      { name: "left", in: "query", required: true, schema: { type: "string", format: "uuid" } },
      { name: "right", in: "query", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Deterministic Run/input/output/check diff with dependency-graph attribution" } } },
  },
  "/api/underwriting/model-versions/{id}/affected": {
    get: { security: secured, parameters: [documentIdParameter, { name: "nodeId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 240 } }], responses: { "200": { description: "Exact downstream dependency impact for one ModelVersion node" } } },
  },
  "/api/underwriting/model-versions/diff": {
    get: { security: secured, parameters: [
      { name: "left", in: "query", required: true, schema: { type: "string", format: "uuid" } },
      { name: "right", in: "query", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Semantic ModelIR node/version diff" } } },
  },
  "/api/underwriting/sensitivities": {
    post: { security: secured, requestBody: json(UnderwritingCreateSensitivitySchema), responses: { "201": { description: "Bounded deterministic sensitivity with an immutable Run per cell" }, "200": { description: "Idempotent sensitivity replay" } } },
  },
  "/api/underwriting/sensitivities/{id}": {
    get: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Exact sensitivity definition and provenance-retaining cell Runs" } } },
  },
  "/api/underwriting/artifact-bindings": {
    post: { security: secured, requestBody: json(UnderwritingCreateArtifactBindingSchema), responses: { "201": { description: "Thin exact P4 node to P3 SpreadsheetIR anchor binding created" }, "409": { description: "Artifact anchor/version conflict" } } },
  },
  "/api/underwriting/projections": {
    post: { security: secured, requestBody: json(UnderwritingProjectionSchema), responses: { "201": { description: "Outputs projected through a P3 typed patch into a new local DocumentVersion" }, "200": { description: "Idempotent projection replay" }, "409": { description: "P3 version or anchor conflict" } } },
  },
  "/api/underwriting/comparisons": {
    post: { security: secured, requestBody: json(UnderwritingArtifactComparisonSchema), responses: { "200": { description: "Independent P4 decimal outputs compared with exact P3/Excel values under declared policies" } } },
  },
  "/api/instructions": { post: { security: secured, requestBody: json(SubmitInstructionSchema), responses: { "201": { description: "Work accepted" }, "400": { description: "Invalid or retired request" } } } },
  "/api/objectives": { post: { security: secured, requestBody: json(StartObjectiveSchema), responses: { "201": { description: "Objective accepted" } } } },
  "/api/objectives/{id}/control": { post: { security: secured, parameters: [{name:"id",in:"path",required:true,schema:{type:"string",format:"uuid"}}], requestBody: json(ControlObjectiveSchema), responses: { "200": { description: "Control recorded" } } } },
  "/api/works/{id}/handoff": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(HandoffWorkSchema), responses: { "200": { description: "Handoff recorded" } } } },
  "/api/outcome-packs": { post: { security: secured, requestBody: json(StartOutcomePackSchema), responses: { "201": { description: "Outcome pack started" } } } },
  "/api/queries": { post: { security: secured, requestBody: json(OperationalQuerySchema), responses: { "201": { description: "Canonical query completed" }, "400": { description: "Invalid or retired query" } } } },
  "/api/read-models/workforce-status": { get: { security: secured, parameters: workforcePageParameters, responses: { "200": { description: "Source-backed configured AI workforce, assignments, verified metrics, governed learning state, truthful truncation, and a next cursor" } } } },
  "/api/workforce/profiles": {
    get: { security: secured, parameters: workforcePageParameters, responses: { "200": { description: "Source-backed governed workforce state with truthful bounded-page metadata" } } },
    post: { security: secured, requestBody: json(WorkforceConfigureProfileSchema), responses: { "200": { description: "New immutable configuration revision created" }, "201": { description: "AgentProfile and first immutable revision created" }, "400": { description: "Invalid capability or bounded configuration" }, "403": { description: "Authenticated employee lacks workforce governance authority" } } },
  },
  "/api/workforce/proposals/{id}": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkforceReviewProposalSchema), responses: { "200": { description: "Learning proposal human review recorded; promotion creates immutable LearningRevision and AgentProfileRevision" }, "400": { description: "Invalid proposal review" }, "403": { description: "Authenticated employee lacks workforce learning-review authority" } } } },
  "/api/workforce/assignments/{id}/reassign": { post: { security: secured, parameters: [documentIdParameter], requestBody: json(WorkforceReassignSchema), responses: { "200": { description: "Active assignment relinquished with immutable operator provenance; normal deterministic assignment resumes the exact P6 node" }, "400": { description: "Invalid assignment or note" }, "403": { description: "Authenticated employee lacks workforce reassignment authority" } } } },
  "/api/actions/{id}/confirm": { post: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: json(ConfirmActionSchema), responses: { "200": { description: "Approval recorded" } } } },
  "/api/actions/{id}/reject": { post: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: json(RejectActionSchema), responses: { "200": { description: "Rejection recorded" } } } },
  "/api/actions/{id}/escalate": { post: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: json(EscalateActionSchema), responses: { "200": { description: "Escalation recorded" } } } },
  "/api/policies/{tenantId}/{actionType}": { put: { security: secured, parameters: [{ name: "tenantId", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "actionType", in: "path", required: true, schema: { type: "string" } }], requestBody: json(UpsertPolicySchema), responses: { "200": { description: "Active policy saved" } } } },
  "/api/webhooks/vapi": { post: { requestBody: json(VapiWebhookSchema), responses: { "200": { description: "Employee voice event received" } } } },
  "/api/webhooks/ghl": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/webhooks/marketing": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/webhooks/payment": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/webhooks/esign": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/connections/microsoft-graph/start": {
    post: { security: secured, requestBody: json(MicrosoftConnectionStartSchema), responses: {
      "201": { description: "One-time Microsoft app-only admin-consent configuration started" },
      "403": { description: "Integration administration denied" },
      "409": { description: "Connection or capability conflict" },
    } },
  },
  "/api/connections/microsoft-graph/callback": {
    get: {
      parameters: [
        { name: "state", in: "query", required: true, schema: { type: "string", maxLength: 512 } },
        { name: "tenant", in: "query", required: false, schema: { type: "string", format: "uuid" } },
        { name: "admin_consent", in: "query", required: false, schema: { type: "boolean" } },
        { name: "error", in: "query", required: false, schema: { type: "string", maxLength: 128 } },
      ],
      responses: { "303": { description: "One-time consent state consumed and browser redirected to connection status" } },
    },
  },
  "/api/connections/microsoft-graph/status": {
    get: { security: secured, responses: { "200": { description: "Microsoft app identity, consent, permission, capability, and health status" } } },
  },
  "/api/integrations/microsoft-graph/source-scopes": {
    get: { security: secured, responses: { "200": { description: "Configured Microsoft source scopes with coverage and freshness" } } },
    post: { security: secured, requestBody: json(MicrosoftSourceScopeSchema), responses: {
      "201": { description: "Exact source scope verified; subscription-first baseline queued" },
      "403": { description: "Coverage administration denied" },
      "409": { description: "Effective access not verified or broad access not acknowledged" },
    } },
  },
  "/api/integrations/microsoft-graph/source-scopes/{id}": {
    get: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Exact source-scope status" }, "404": { description: "Source scope not found in the authenticated tenant" } } },
    delete: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Source disabled; observations, evidence, and coverage history retained" }, "403": { description: "Coverage administration denied" } } },
  },
  "/api/integrations/microsoft-graph/coverage": {
    get: { security: secured, responses: { "200": { description: "As-of provider coverage, freshness, recovery, unresolved counts, and integration health" } } },
  },
  "/api/webhooks/microsoft-graph": {
    post: {
      requestBody: json(MicrosoftGraphNotificationSchema),
      responses: {
        "200": { description: "Validation token echoed exactly as text/plain" },
        "202": { description: "Authenticated notifications durably enqueued before acknowledgement" },
        "400": { description: "Malformed notification envelope" },
        "401": { description: "clientState, directory, or resource mismatch" },
        "503": { description: "Durable enqueue failed; no false success" },
      },
    },
  },
  "/api/artifacts": {
    post: { security: secured, requestBody: json(ArtifactCreateSchema), responses: { "201": { description: "Core Document and first immutable local DocumentVersion created" } } },
  },
  "/api/documents/{id}/artifact": {
    get: { security: secured, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Artifact summary, immutable version timeline, distinct heads, semantic status, and pinned context" } } },
  },
  "/api/documents/{id}/artifact/versions/{versionId}": {
    get: { security: secured, parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Exact immutable version metadata and semantic status" } } },
  },
  "/api/documents/{id}/artifact/ir/{versionId}": {
    get: { security: secured, parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "id", in: "query", required: false, schema: { type: "array", maxItems: 200, items: { type: "string" } } },
      { name: "kind", in: "query", required: false, schema: { type: "array", maxItems: 20, items: { type: "string" } } },
      { name: "search", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
      { name: "sheetId", in: "query", required: false, schema: { type: "string", maxLength: 512 } },
      { name: "address", in: "query", required: false, schema: { type: "string", maxLength: 128 } },
      { name: "range", in: "query", required: false, schema: { type: "string", maxLength: 256 } },
      { name: "dependencyOf", in: "query", required: false, schema: { type: "string", maxLength: 2_048 } },
      { name: "dependentOf", in: "query", required: false, schema: { type: "string", maxLength: 2_048 } },
      { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } },
    ], responses: { "200": { description: "Bounded semantic IR slice; never a fabricated Office rendering" } } },
  },
  "/api/documents/{id}/artifact/diff": {
    get: { security: secured, parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "left", in: "query", required: true, schema: { type: "string", format: "uuid" } },
      { name: "right", in: "query", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Semantic diff between two immutable versions" } } },
  },
  "/api/documents/{id}/artifact/drafts": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactDraftSchema), responses: { "201": { description: "Actor-owned local draft head created from an exact version" }, "409": { description: "Stale version or head" } } },
  },
  "/api/documents/{id}/artifact/patches": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactPatchSchema), responses: { "201": { description: "Atomic typed patch appended one immutable version" }, "409": { description: "Stale head or anchor precondition" } } },
  },
  "/api/documents/{id}/artifact/comments": {
    get: { security: secured, parameters: [documentIdParameter, artifactVersionQueryParameter], responses: { "200": { description: "Version-pinned artifact comments" } } },
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactCommentSchema), responses: { "201": { description: "Version and anchor-pinned comment created" } } },
  },
  "/api/documents/{id}/artifact/reviews": {
    get: { security: secured, parameters: [documentIdParameter, artifactVersionQueryParameter], responses: { "200": { description: "Version-pinned editorial review history" } } },
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactReviewSchema), responses: { "201": { description: "Editorial review event recorded; it grants no execution authority" } } },
  },
  "/api/documents/{id}/artifact/bindings": {
    get: { security: secured, parameters: [documentIdParameter, artifactVersionQueryParameter], responses: { "200": { description: "Exact version and anchor bindings" } } },
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactBindingSchema), responses: { "201": { description: "Version-specific Evidence, entity, or DocumentVersion binding created" } } },
  },
  "/api/documents/{id}/artifact/lineage": {
    get: { security: secured, parameters: [documentIdParameter, artifactVersionQueryParameter], responses: { "200": { description: "Artifact version lineage" } } },
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactLineageSchema), responses: { "201": { description: "Exact cross-version lineage edge created" } } },
  },
  "/api/documents/{id}/artifact/publish": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactPublishSchema), responses: { "200": { description: "Conditional Microsoft replace read back and semantically verified" }, "409": { description: "Provider head conflict; no blind overwrite" } } },
  },
  "/api/documents/{id}/artifact/publish-new": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactProviderCreateSchema), responses: { "200": { description: "New Microsoft file created at explicit target, read back, and semantically verified" }, "409": { description: "Name conflict under mandatory fail policy" } } },
  },
  "/api/documents/{id}/artifact/publications/{publicationId}": {
    get: { security: secured, parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "publicationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Truthful replacement publication state" }, "404": { description: "Publication not found" } } },
  },
  "/api/documents/{id}/artifact/provider-creations/{creationId}": {
    get: { security: secured, parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "creationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Truthful provider-create state" }, "404": { description: "Provider creation not found" } } },
  },
  "/api/documents/{id}/artifact/context": {
    get: { security: secured, parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      { name: "versionId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
    ], responses: { "200": { description: "Version-pinned comments, review, bindings, lineage, remaps, and external operation state" } } },
  },
  "/api/documents/{id}/artifact/recalculate": {
    post: { security: secured, parameters: [documentIdParameter], requestBody: json(ArtifactRecalculateSchema), responses: { "200": { description: "Delegated Excel calculation requested and required ranges read back" }, "409": { description: "Provider or authorization precondition failed; calculation remains stale" } } },
  },
  "/api/artifact-templates": {
    get: { security: secured, responses: { "200": { description: "Active immutable artifact templates" } } },
    post: { security: secured, requestBody: json(ArtifactTemplateSchema), responses: { "201": { description: "Exact DocumentVersion registered as a template" } } },
  },
  "/api/artifact-templates/{key}/instantiate": {
    post: { security: secured, parameters: [{ name: "key", in: "path", required: true, schema: { type: "string", minLength: 3, maxLength: 160 } }], requestBody: json(ArtifactTemplateInstantiateSchema), responses: { "201": { description: "New Core Document and first immutable version instantiated with lineage" } } },
  },
} satisfies Record<string, unknown>;

paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum.push(...APPLICATION_OPERATIONS);
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...APPLICATION_SEMANTICS_OPERATIONS.filter(operation=>operation!=="application-cancel"),...INSTITUTION_OPERATIONS);
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...LEARNING_OPERATIONS);
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...IDENTIFICATION_OPERATIONS);
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...EconomicOperations);
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...StrategicOperations);
for(const operation of StrategicOperations){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
  security:secured,requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
  responses:{"200":{description:"Current scoped response model set, development admission, exact artifact or retained use history. No field qualification or effects."},
   "202":{description:"Original durable learning, joint prediction or actual S4 programme evaluation accepted. Not completion."},
   "400":{description:"Strict data-only model or original S4 contract required."},"401":{description:"Current signed bearer required before body read."},
   "403":{description:"Current authority or disposable development profile unavailable."},"404":{description:"Absent or unauthorized tenant/principal/root/Work resource."},
   "408":{description:"Authenticated body deadline exceeded."},"409":{description:"Original episode, currentness, cumulative limits or idempotency conflict."},
   "413":{description:"Bounded request or retained resources exceeded."},"422":{description:"Canonical meaning, model alternatives, checking, typed admission or transport prerequisite failed."},
   "503":{description:"Pinned checker or runtime unavailable."}},
 }}});
}
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...InteractionOperations);
for(const operation of InteractionOperations){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
  security:secured,requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
  responses:{
   "200":{description:"Exact Work and participant-local dynamic protocol, development admission, terms, consent or retained native responsibility. No protected qualification or financial efficacy."},
   "202":{description:"Original bounded construction or guarded native programme accepted. Not completion."},
   "400":{description:"Strict data-only contract required."},"401":{description:"Current signed bearer required."},
   "403":{description:"Current canonical participant rights or disposable profile missing."},
   "404":{description:"Unavailable or unauthorized exact participant, Work or root."},
   "408":{description:"Bounded authenticated body deadline exceeded."},
   "409":{description:"Original history, terms, resource revision or idempotency changed."},
   "413":{description:"Frozen request bound exceeded."},
   "422":{description:"Exact mathematical, consent, source or native owner prerequisite failed."},
   "503":{description:"Pinned runtime or native capacity unavailable."},
  },
 }}});
}
for(const operation of EconomicOperations){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
  security:secured,requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
  responses:{
   "200":{description:"Current principal/Work-scoped finite economic theory, typed development admission, canonical reservation, programme or retained history. Not protected qualification or financial efficacy."},
   "202":{description:"Original bounded construction or guarded internal programme accepted by the durable queue. Acceptance is not completion or an observed effect."},
   "400":{description:"Strict bounded data-only contract rejected."},"401":{description:"Current signed bearer required."},
   "403":{description:"Current authority missing or ordinary disposable development profile unavailable."},
   "404":{description:"Absent or unauthorized principal/root/Work-scoped owner record."},
   "408":{description:"Authenticated request body deadline exceeded."},
   "409":{description:"Original episode, exact state, resource capacity, Work revision or idempotency preimage changed."},
   "413":{description:"Original request or retained-resource bound exceeded."},
   "422":{description:"Finite semantic, independent-check, admission, source or owner-lowering prerequisite failed."},
   "503":{description:"Pinned checker/runtime or native capacity unavailable."},
  },
 }}});
}
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...CONFIDENTIAL_OPERATIONS);
for(const operation of CONFIDENTIAL_OPERATIONS){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{security:secured,
  requestBody:{content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
  responses:{"200":{description:"Current scoped local-engineering evidence or recipient-authorized release. Not primary truth, protected admission, production or effects."},
   "202":{description:"Original durable Work queued. Not accepted computation or completion."},
   "400":{description:"Strict typed contract refused."},"401":{description:"Current signed bearer required."},
   "403":{description:"Current authority unavailable or production unadmitted."},"404":{description:"Unavailable in current identity and scope."},
   "409":{description:"Original rights, source cut, deadline, disclosure, physical fence or reconciliation premise unpassed."},
   "413":{description:"Original bounded request, response or retention exceeded."}}}}});
}
for(const operation of IDENTIFICATION_OPERATIONS){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{security:secured,requestBody:{content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},responses:{
  "200":{description:"Current scoped development rights, raw experiments, scientific model, decision use or retained history. Not protected admission or production."},
  "202":{description:"Original finite Work allocation queued for physical experiments, independent replication or actual guarded decision use. Not completion."},
  "400":{description:"Strict bounded request or unsupported domain rejected."},"401":{description:"Current signed bearer required."},
  "403":{description:"Current rights, separate principal or canonical authority missing."},
  "404":{description:"Absent or unauthorized scoped owner record."},
  "409":{description:"Original allocation, Work, source, observation, consent or exact recovery identity changed."},
  "413":{description:"Original finite request, response, storage or resource bound exceeded."},
  "503":{description:"Native capacity or independently configured lifecycle owner unavailable."},
 }}}});
}
for(const operation of LEARNING_OPERATIONS){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{security:secured,requestBody:{content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},responses:{
  "200":{description:"Current authorized X5 development history, structural rights or capsule. Not protected admission, reward, production or effects."},
  "202":{description:"Original bounded allocation queued for physical learning, exact pinned native use or independent outcome evaluation. No success label accepted."},
  "400":{description:"Invalid bounded typed learning contract."},"401":{description:"Current signed bearer required."},
  "403":{description:"Current training/reuse or activity authority absent; no production activation."},
  "409":{description:"Evidence, consent, source/runtime identity, native CAS, history, partition or original allocation is no longer current."},
  "503":{description:"Independent S8 configuration, native commit clock or canonical capacity is unavailable."},
 }}}});
}
for(const operation of APPLICATION_OPERATIONS){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{security:secured,requestBody:{content:{"application/json":{schema:operation==="application-cancel"
  ?{oneOf:[{$ref:"#/components/schemas/application-cancel"},{$ref:"#/components/schemas/X2ApplicationCancel"}]}
  :{$ref:"#/components/schemas/"+operation}}}},responses:{
  "200":{description:"Current authenticated development application, immutable business history or exact prepared-intent binding. Not protected admission or dispatch."},
  "202":{description:"Original finite allocation accepted for durable physical compilation and independent checking; no installed success yet."},
  "400":{description:"Strict bounded business contract or exact record precondition rejected."},
  "401":{description:"Current authenticated bearer required."},
  "403":{description:"Current authority missing or production not separately activated."},
  "404":{description:"Absent or unauthorized scoped Work, application, record or canonical evidence."},
  "409":{description:"Record CAS, release, Work, source, rights, dependency, cancellation or original allocation changed."},
  "413":{description:"Original request, response, storage or finite resource bound exceeded."},
  "422":{description:"Unsupported business semantics or independently checked construction failed."},
  "503":{description:"Native capacity or independent owner configuration unavailable. Retry never renews resources."},
 }}}});
}

for (const operation of Object.keys(uniformAlgorithmOperations)) {
 const submission=operation==='submit'||operation==='submit-total';
 Object.assign(paths,{['/api/uniform-algorithms/'+operation]:{post:{
  security:secured,requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Y5Uniform-'+operation}}}},
  responses:{
   [submission?'202':'200']:{description:submission
    ?'Original principal/Work-bound finite discovery accepted for durable native proof search. No checked result or admission yet.'
    :operation==='record-task-episode'
     ?'Canonical S5 model-only task request, result and cost episode recorded or replayed from authenticated specification/task Work references under the original invocation deadline. No inline values, answer, acceptance, protected family credit, reservation or S6 effects.'
    :operation==='specification'
     ?'Current authenticated specification Work resolved to its immutable typed definition and separately qualified semantic acceptance. Public development is not protected family credit.'
     :operation==='read'
      ?'Current authorized lightweight status by default for v2. Capsule and retained history require explicit includeCapsule/includeHistory; bound payloads are withheld when source authorization is unavailable.'
      :operation==='consume-total'
       ?'Same kernel-checked typed definition applied to a separate original S5 task Work under the original finite use allowance. No inline values, algorithm, reservation, S6 effects or protected admission.'
       :'Current authorized development theorem, same-definition original S5 use, retained history or typed disposable S8 state. No reservation, S6 effects or production authority.'},
   '400':{description:'Strict bounded request or original S4/S5 semantic contract rejected.'},
   '401':{description:'Current signed bearer required.'},
   '403':{description:'Current owner or distinct evaluator authority absent.'},
   '404':{description:'Absent or unauthorized private owner, Work or assignment.'},
   '408':{description:'Original authenticated body or 28.5-second invocation deadline exceeded; no renewed compute allowance.'},
   '409':{description:'Original source, rights, Work, generation, instance, deadline or idempotency preimage changed.'},
   '413':{description:'Original request, storage or finite resource bound exceeded.'},
   '422':{description:'Required original semantic-owner predicate unavailable.'},
   '503':{description:'Native capacity, diagnostic profile or independently configured S8 owner unavailable.'},
  },
 }}});
}

for (const [operation,schema] of Object.entries(DecisionAtlasOperationSchemas)) {
  Object.assign(paths, { ["/api/decision-atlases/" + operation]: { post: {
    security: secured, requestBody: json(schema), responses: {
      "200": { description: "Current original-family exact model-relative atlas, owner revision, query or S4/S5 intent. No effect authority or admission." },
      "202": { description: "Original episode-bound durable build accepted; output remains provisional until independently checked." },
      "400": { description: "Strict bounded request schema or exact reference rejected." },
      "401": { description: "Current authenticated caller required." },
      "404": { description: "Absent or unauthorized private owner reference." },
      "409": { description: "Original source, Work, rights, method, grant or idempotency preimage changed." },
      "422": { description: "Unsupported affine semantics, exceeded declared bound or unavailable admitted fallback. No grant or effect authority renewed." },
      "503": { description: "Required ordinary native profile configuration unavailable." },
    },
  } } });
}

for (const operation of R4_OPERATIONS) {
  Object.assign(paths, { ["/api/identification-plans/" + operation]: { post: {
    security: secured, requestBody: json(R4_OPERATION_SCHEMAS[operation]), responses: {
      "200": { description: "Current principal/Work-scoped owner declaration, checked model-relative plan, immutable history or planning disposition. No collection, reservation, field truth or effect authority." },
      "202": { description: "Original owner/grant-bound durable search accepted; all output remains provisional pending independent checking." },
      "400": { description: "Strict bounded request or exact owner/scientific premise rejected." },
      "401": { description: "Authenticated caller required." },
      "404": { description: "Absent or unauthorized private reference." },
      "409": { description: "Original Work, profile, source, method, grant or idempotency preimage revised." },
      "413": { description: "Registered request byte bound exceeded; no silent truncation." },
    },
  } } });
}

for (const operation of COMPUTE_SEARCH_OPERATIONS) {
  const schema = operation === "compute-search-submit" ? ComputeSearchRequestSchema : operation === "compute-search-projection" ? SearchProjectionSchema : SearchIdSchema;
  Object.assign(paths, { ["/api/company-brain/" + operation]: { post: {
    security: secured, requestBody: json(schema), responses: {
      "200": { description: "Current principal-scoped plan or durable control receipt" },
      "202": { description: "Original owner-bound computation accepted without protected authority" },
      "400": { description: "Bounded strict request rejected" },
      "404": { description: "Indistinguishable absent or unauthorized private resource" },
      "422": { description: "Current owner, grant, input, route or terminal predicate unpassed" },
    },
  } } });
}

for (const operation of PROCEDURE_OPERATIONS) {
  Object.assign(paths, { ["/api/company-brain/" + operation]: { post: {
    security: secured, requestBody: json(PROCEDURE_OPERATION_SCHEMAS[operation]), responses: {
      "200": { description: "Authorized ordinary procedure preimage or lifecycle receipt; no admission" },
      "202": { description: "Bounded ordinary induction accepted on original Work" },
      "400": { description: "Strict bounded procedure schema rejected" },
      "404": { description: "Absent or unauthorized principal-scoped procedure resource" },
      "422": { description: "Rights, currentness, grant or unsupported protected-port predicate unpassed" },
    },
  } } });
}

for (const operation of DELIBERATION_OPERATIONS) {
  const schema = operation === "deliberation-submit" ? DeliberationRequestSchema :
    operation === "deliberation-projection" ? SearchProjectionSchema :
    operation === "deliberation-calibrate" ? CalibrationRequestSchema :
    operation === "deliberation-evidence-read" ? DeliberationEvidenceReadSchema : SearchIdSchema;
  const result = operation === "deliberation-projection" ? DeliberationProjectionSchema :
    operation === "deliberation-module-read" ? DeliberationModuleReaderSchema :
    ["deliberation-read", "deliberation-cancel", "deliberation-resume", "deliberation-reconcile"].includes(operation) ? DeliberationCurrentReaderSchema : null;
  Object.assign(paths, { ["/api/company-brain/" + operation]: { post: {
    security: secured, parameters: [{ in: "header", name: "x-deliberation-deadline-ms", required: false,
      description: "Whole transport time attenuation; never a new compute or funding grant",
      schema: { type: "integer", minimum: 1, maximum: 30000, default: 30000 } }],
    requestBody: json(schema), responses: {
      "200": { description: "Exact authenticated current M2 artifact or bounded development receipt", ...(result ? json(result) : {}) },
      "202": { description: "Original owner-bound ordinary work accepted without protected authority" },
      "400": { description: "Strict bounded contract or deadline rejected" },
      "404": { description: "Indistinguishable absent or unauthorized private resource" },
      "413": { description: "Whole deadline exhausted; underlying SQL/body IO cancelled where supported" },
      "422": { description: "Current source, owner, module, grant, or supported-domain predicate unpassed" },
    },
  } } });
}

for (const [operation,schema] of [
  ...Object.entries(M1OperationSchemas),...Object.entries(EvidenceOperationSchemas),
  ...Object.entries(PrimaryOperationSchemas),
  ...Object.entries(BilateralOperationSchemas),
  ...Object.entries(CapitalProgramV2Operations),
  ...Object.entries(CAPITAL_FORMATION_OPERATIONS),
  ["opportunity-promote", OpportunityHandoffSchema] as const,
  ...Object.entries(APPLICATION_SEMANTICS_OPERATION_SCHEMAS).filter(([operation])=>operation!=="application-cancel"),
]) {
  Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
    security:secured,requestBody:json(schema),responses:{
      "200":{description:"Authenticated current owner result; model evidence is not execution authority."},
      "202":{description:"Accepted bounded durable Work computation, not admission, reservation or consent."},
      "400":{description:"Strict owner request schema rejected invalid or unknown input."},
      "404":{description:"Exact permitted owner reference unavailable."},
      "409":{description:"Currentness, idempotency or handoff prerequisite changed."},
      "413":{description:"Whole-request byte or resource bound exhausted."},
      "422":{description:"Required owner port, verified evidence or protected authority unavailable."},
    },
  }}});
}
for (const [operation,{schema}] of Object.entries(M4Operations)) {
  Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
    security:secured,requestBody:json(schema),responses:{
      "200":{description:"Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission."},
      "202":{description:"Accepted bounded challenge or new economic repair request; no renewed parent resources or admission."},
      "400":{description:"Strict challenge request schema rejected invalid or unknown input."},
      "404":{description:"Exact permitted search, owner result or custody reference unavailable."},
      "409":{description:"Current owner, rights, custody, lease or cancellation predicate changed, or authentic M3 reader pending."},
      "413":{description:"Inherited request resource or byte bound exhausted."},
      "422":{description:"Authentic owner checks rejected the requested challenge."},
      "503":{description:"Required authentic runtime configuration unavailable."},
    },
  }}});
}

for (const [operation,schema] of Object.entries(ElicitationOperationSchemas)) {
 Object.assign(paths,{["/api/elicitation-protocols/"+operation]:{post:{security:secured,requestBody:json(schema),
  responses:{"200":{description:"Current exact proposed finite mechanism, owner receipt or historical responsibility. Not private truth, consent, admission or settlement.",
    ...(["read","status"].includes(operation)?json(R3WorkReviewSchema):{})},
   "400":{description:"Strict bounded input rejected"},"401":{description:"Bearer identity required"},
   "403":{description:"Exact reporting or owner principal unavailable"},"404":{description:"Permitted Work/reference unavailable"},
   "409":{description:"Original revision, deadline, grant, closure or idempotency fenced"},"413":{description:"Byte/resource bound"},
   "422":{description:"Precise unsupported domain or required protected authority unavailable"}}}}});
}
for (const [family,operations] of Object.entries({...R3OwnerOperationSchemas,obligations:ObligationOperationSchemas})) {
 for (const [operation,schema] of Object.entries(operations)) Object.assign(paths,{["/api/"+family+"/"+operation]:{post:{
  security:secured,requestBody:json(schema),responses:{
   "200":{description:"Original semantic-owner result under its current authority. Exact proposed R3 schedules do not grant agreement or settlement."},
   "400":{description:"Strict owner request rejected"},"401":{description:"Real bearer identity required"},
   "403":{description:"Current owner authority absent"},"404":{description:"Permitted original reference unavailable"},
   "409":{description:"Currentness, immutable identity, resource or attempt responsibility fenced"},
   "413":{description:"Original byte/resource bound"},"422":{description:"Unsupported operation or required protected admission absent"}
  }}}});
}
for (const [operation, schema] of Object.entries(ClosingOperationSchemas)) {
  Object.assign(paths, { [`/api/closing/${operation}`]: { post: {
    security: secured, requestBody: json(schema),
    responses: {
      "200": { description: "Exact canonical closing projection, retained control result or qualified-port status. Development is excluded from live counts." },
      "201": { description: "Legally accepted ClosingSpec bound to original Work, authority, terms, finite grant and durable recovery intent." },
      "202": { description: "Accepted original Work remains in an explicit recoverable native-owner phase." },
      "400": { description: "Strict operation schema rejected invalid or unknown input." },
      "401": { description: "Authenticated identity required." },
      "403": { description: "Exact principal or activity authority denied." },
      "404": { description: "Programme, Deal or Work absent from the authenticated scope." },
      "409": { description: "Original idempotency, authority, effect or currentness binding changed." },
      "413": { description: "Bounded request or read history exceeded." },
      "422": { description: "Exact independent acceptance, qualified interface or original owner predicate failed." },
      "503": { description: "Required canonical runtime unavailable; no qualification or external effect claimed." },
    },
  } } });
}

const document = {
  openapi: "3.1.0",
  info: { title: "FINNOR Private Equity API", version: "6.0.0", description: "Private Equity is the only active product vertical. P1 owns temporal InvestmentCase, Assumption, and canonical investment Decision truth; P2 owns Microsoft Source Truth; P3 owns immutable artifacts; P4 owns deterministic underwriting math; P5 owns governed Investment Committee truth; P6 adds deterministic selected PlanGraphs and authenticated employee-specific causal attention without duplicating Core Work, Authority, DomainAction, BusinessEffect, DecisionReceipt, ObjectiveLoop, or prior truth owners. Historical Water payloads remain receipt-only quarantine inputs." },
  components: { schemas:applicationComponents.schemas,securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  paths,
};

// The tracked root contract is the release artifact consumed by tests and clients.
// Writing a second ignored copy allowed a stale Water-era schema to survive earlier
// generations, so there is deliberately one owner and one destination.
// Each conversion is a standalone JSON Schema. Rebase its local definitions
// after embedding so recursive references resolve inside the OpenAPI document.
function rebaseSchemaReferences(node:unknown,path:string[]=[],scope="#") {
 if(!node||typeof node!=="object")return;
 if(Array.isArray(node)){node.forEach((child,index)=>rebaseSchemaReferences(child,[...path,String(index)],scope));return;}
 const value=node as Record<string,unknown>;
 if(typeof value.$schema==="string"){
  scope="#/"+path.map(part=>part.replace(/~/g,"~0").replace(/\//g,"~1")).join("/");
  delete value.$schema;
 }
 if(typeof value.$ref==="string"&&value.$ref.startsWith("#")&&!value.$ref.startsWith("#/components/"))
  value.$ref=scope+value.$ref.slice(1);
 for(const [key,child] of Object.entries(value))rebaseSchemaReferences(child,[...path,key],scope);
}
rebaseSchemaReferences(document);
// OpenAPI clients expose named components, not nested JSON Schema definitions.
// Hoist each standalone converter definition while retaining its recursive graph.
const definitionTargets=new Map<string,string>();
const hoisted:Record<string,unknown>={};
function hoistDefinitions(node:unknown,path:string[]=[]) {
 if(!node||typeof node!=="object")return;
 if(Array.isArray(node)){node.forEach((child,index)=>hoistDefinitions(child,[...path,String(index)]));return;}
 const value=node as Record<string,unknown>;
 for(const keyword of ["definitions","$defs"]){
  const definitions=value[keyword];
  if(definitions&&typeof definitions==="object"){
   for(const [name,schema] of Object.entries(definitions)){
    const pointer="#/"+[...path,keyword,name].map(part=>part.replace(/~/g,"~0").replace(/\//g,"~1")).join("/");
    const component="Generated_"+createHash("sha256").update(pointer).digest("hex").slice(0,24);
    definitionTargets.set(pointer,"#/components/schemas/"+component);
    hoistDefinitions(schema,[...path,keyword,name]);hoisted[component]=schema;
   }
   delete value[keyword];
  }
 }
 for(const [key,child] of Object.entries(value))hoistDefinitions(child,[...path,key]);
}
hoistDefinitions(document);
Object.assign(document.components.schemas,hoisted);
function rewriteDefinitionReferences(node:unknown){
 if(!node||typeof node!=="object")return;
 if(Array.isArray(node)){node.forEach(rewriteDefinitionReferences);return;}
 const value=node as Record<string,unknown>;
 if(typeof value.$ref==="string"){
  const reference=value.$ref;
  for(const [source,target] of definitionTargets)if(reference===source||reference.startsWith(source+"/")){
   value.$ref=target+reference.slice(source.length);break;
  }
 }
 Object.values(value).forEach(rewriteDefinitionReferences);
}
rewriteDefinitionReferences(document);

writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
console.log(`Generated openapi.json with ${Object.keys(paths).length} active/quarantine paths.`);
