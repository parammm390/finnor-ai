// OpenAPI is generated from the active Phase-5 boundary schemas only. Historical
// Water webhook payloads are intentionally opaque quarantine receipts and never
// regain an executable public schema here.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  SubmitInstructionSchema,
  StartObjectiveSchema,
  ControlObjectiveSchema,
  HandoffWorkSchema,
  StartOutcomePackSchema,
  ConfirmActionSchema,
  RejectActionSchema,
  EscalateActionSchema,
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
  IcResolveQuestionSchema,
  IcSatisfyConditionSchema,
  IcSelectMemoSchema,
  IcSelectUnderwritingRunSchema,
  IcSupersedeQuestionSchema,
  IcVoteSchema,
  IcWaiveConditionSchema,
  IcWaiveQuestionSchema,
} from "../apps/api/lib/ic";

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
  entityType: z.enum(["work", "task", "user", "org_unit", "tenant_location", "external_organization", "external_contact", "document", "domain_action", "workflow_run", "workflow_step", "pe_strategy", "pe_opportunity", "pe_deal", "pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision", "pe_deal_party", "pe_workstream", "pe_request", "pe_deliverable", "pe_finding", "pe_deal_risk", "pe_dependency", "pe_milestone", "pe_closing_condition", "pe_closing_item", "pe_document_link", "pe_evidence_link", "pe_finding_risk_link"]),
  entityId: z.string().uuid(),
}).strict();
const deal = { dealId: z.string().uuid(), page: page.optional() } as const;
const peWorldRoot = z.object({
  entityType: z.enum(["pe_strategy", "pe_opportunity", "pe_deal"]),
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
  configuration: z.record(z.unknown()),
  negativeProbeConfiguration: z.record(z.unknown()).nullable().optional(),
  acknowledgeBroadAccess: z.boolean().optional(),
  rootBinding: z.object({ type: z.enum(["pe_strategy", "pe_opportunity", "pe_deal"]), id: z.string().uuid() }).strict().nullable().optional(),
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
  operations: z.array(z.record(z.unknown())).min(1).max(1_000),
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
  z.object({ intent: z.literal("pe_world_state"), ...queryEnvelope, root: peWorldRoot, at: z.string().datetime({ offset: true }).optional() }).strict(),
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

const s = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none" });
const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema: s(schema) } } });
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
  "/api/corrections": { get: { security: secured, responses: { "200": { description: "Tenant-scoped corrections" } } }, post: { security: secured, responses: { "201": { description: "Correction recorded" } } } },
  "/api/vitals": { get: { security: secured, responses: { "200": { description: "Queue and runtime vitals" } } } },
  "/api/activity": { get: { security: secured, responses: { "200": { description: "Tenant-scoped operational activity" } } } },
  "/api/workflows/runs": { get: { security: secured, responses: { "200": { description: "Tenant-scoped workflow runs" } } } },
  "/api/workflows/runs/{id}/pause": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized workflow pause" } } } },
  "/api/workflows/runs/{id}/resume": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized workflow resume" } } } },
  "/api/workflows/runs/{id}/cancel": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized workflow cancellation" } } } },
  "/api/workflows/runs/{id}/retry": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized workflow retry" } } } },
  "/api/workflows/runs/{id}/escalate": { post: { security: secured, parameters: [documentIdParameter], responses: { "200": { description: "Authorized workflow escalation" } } } },
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
  "/api/objectives/{id}/control": { post: { security: secured, requestBody: json(ControlObjectiveSchema), responses: { "200": { description: "Control recorded" } } } },
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
  "/api/actions/{id}/confirm": { post: { security: secured, requestBody: json(ConfirmActionSchema), responses: { "200": { description: "Approval recorded" } } } },
  "/api/actions/{id}/reject": { post: { security: secured, requestBody: json(RejectActionSchema), responses: { "200": { description: "Rejection recorded" } } } },
  "/api/actions/{id}/escalate": { post: { security: secured, requestBody: json(EscalateActionSchema), responses: { "200": { description: "Escalation recorded" } } } },
  "/api/policies/{tenantId}/{actionType}": { put: { security: secured, requestBody: json(UpsertPolicySchema), responses: { "200": { description: "Active policy saved" } } } },
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

const document = {
  openapi: "3.1.0",
  info: { title: "FINNOR Private Equity API", version: "6.0.0", description: "Private Equity is the only active product vertical. P1 owns temporal InvestmentCase, Assumption, and canonical investment Decision truth; P2 owns Microsoft Source Truth; P3 owns immutable artifacts; P4 owns deterministic underwriting math; P5 owns governed Investment Committee truth; P6 adds deterministic selected PlanGraphs and authenticated employee-specific causal attention without duplicating Core Work, Authority, DomainAction, BusinessEffect, DecisionReceipt, ObjectiveLoop, or prior truth owners. Historical Water payloads remain receipt-only quarantine inputs." },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  paths,
};

// The tracked root contract is the release artifact consumed by tests and clients.
// Writing a second ignored copy allowed a stale Water-era schema to survive earlier
// generations, so there is deliberately one owner and one destination.
writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
console.log(`Generated openapi.json with ${Object.keys(paths).length} active/quarantine paths.`);
