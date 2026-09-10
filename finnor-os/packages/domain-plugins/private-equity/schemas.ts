import { z } from "zod";
import { PE_DEPENDENCY_ENDPOINT_TYPES, PE_ENTITY_TYPES, WORKSTREAM_KINDS } from "@finnor/private-equity";

const uuid = z.string().uuid();
const version = z.number().int().positive();
const dateTime = z.string().datetime({ offset: true });
const text = z.string().trim().min(1).max(10_000);
const shortText = z.string().trim().min(1).max(500);

const InternalPartyRefSchema = z.object({
  partyType: z.enum(["employee", "team"]),
  partyId: uuid,
}).strict();

const DependencyEndpointSchema = z.object({
  entityType: z.enum(PE_DEPENDENCY_ENDPOINT_TYPES),
  entityId: uuid,
}).strict();

const evidenceFields = {
  documentId: uuid.optional(),
  evidenceSourceId: uuid.optional(),
  evidenceVersionId: uuid.optional(),
};

export const IC_SOURCE_REFERENCE_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EVIDENCE_VERSION"), evidenceVersionId: uuid }).strict(),
  z.object({
    kind: z.literal("ARTIFACT_ANCHOR"), documentId: uuid, documentVersionId: uuid,
    anchorId: z.string().min(1).max(2_048), anchorHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({ kind: z.literal("UNDERWRITING_RUN"), underwritingRunId: uuid }).strict(),
  z.object({ kind: z.literal("P1_WORLD"), entityType: z.enum(PE_ENTITY_TYPES), entityId: uuid }).strict(),
  z.object({ kind: z.literal("IC_QUESTION"), questionId: uuid }).strict(),
  z.object({ kind: z.literal("PE_RISK"), riskId: uuid }).strict(),
  z.object({ kind: z.literal("IC_CONDITION"), conditionId: uuid }).strict(),
]);

export const PRIVATE_EQUITY_ACTION_SCHEMAS = {
  open_ic_case: z.object({
    dealId: uuid,
    icCaseId: uuid.optional(),
    investmentCaseId: uuid,
    committeeConfigVersionId: uuid,
    scheduledInternalEventId: uuid.optional(),
    primaryUnderwritingRunId: uuid.optional(),
    reconsidersDecisionId: uuid.optional(),
  }).strict(),
  begin_ic_preparation: z.object({
    dealId: uuid,
    icCaseId: uuid,
    expectedCaseVersion: version,
  }).strict(),
  select_ic_memo_version: z.object({
    dealId: uuid,
    icCaseId: uuid,
    memoSelectionId: uuid.optional(),
    expectedCaseVersion: version,
    artifactRole: z.enum(["MEMO", "DECK"]),
    documentId: uuid,
    documentVersionId: uuid,
    underwritingRunId: uuid.optional(),
    evidenceCutoffAt: dateTime,
    sourceCompleteness: z.enum(["COMPLETE", "INCOMPLETE", "CONFLICTING", "UNKNOWN"]),
    changeClassification: z.enum(["INITIAL", "MATERIAL", "NON_MATERIAL", "MANUAL_REVIEW_REQUIRED"]).optional(),
  }).strict(),
  select_ic_underwriting_run: z.object({
    dealId: uuid,
    icCaseId: uuid,
    expectedCaseVersion: version,
    underwritingRunId: uuid,
  }).strict(),
  create_ic_question: z.object({
    dealId: uuid,
    icCaseId: uuid,
    questionId: uuid.optional(),
    expectedCaseVersion: version,
    question: text,
    priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
    requiredBeforeVote: z.boolean().optional(),
    requiredBeforeDecision: z.boolean().optional(),
  }).strict(),
  attach_ic_question_evidence: z.object({
    dealId: uuid,
    icCaseId: uuid,
    questionId: uuid,
    expectedQuestionVersion: version,
    source: IC_SOURCE_REFERENCE_SCHEMA,
    relationship: z.enum(["SUPPORTS", "CONTRADICTS", "ANSWERS", "VERIFIES", "REQUIRES", "REFERENCES"]),
    truthStatus: z.enum(["ATTACHED", "CONFLICTING", "STALE", "UNKNOWN"]).optional(),
  }).strict(),
  request_ic_memo_review: z.object({
    dealId: uuid,
    icCaseId: uuid,
    expectedCaseVersion: version,
  }).strict(),
  satisfy_ic_condition: z.object({
    dealId: uuid,
    icCaseId: uuid,
    conditionId: uuid,
    expectedConditionVersion: version,
    source: IC_SOURCE_REFERENCE_SCHEMA,
  }).strict(),
  prepare_ic_decision_proposal: z.object({
    dealId: uuid,
    icCaseId: uuid,
    decisionProposalId: uuid.optional(),
    expectedCaseVersion: version,
    expectedVoteSetVersion: z.number().int().nonnegative(),
  }).strict(),
  open_workstream: z.object({
    dealId: uuid,
    workstreamId: uuid.optional(),
    kind: z.enum(WORKSTREAM_KINDS),
    name: shortText,
    owner: InternalPartyRefSchema,
  }).strict(),
  create_deal_request: z.object({
    dealId: uuid,
    requestId: uuid.optional(),
    workstreamId: uuid,
    requestedFromDealPartyId: uuid,
    owner: InternalPartyRefSchema,
    requestText: text,
    requestedAt: dateTime.optional(),
    dueAt: dateTime.optional(),
    requiresAcceptedDeliverable: z.boolean().optional(),
  }).strict(),
  submit_deliverable: z.object({
    dealId: uuid,
    deliverableId: uuid,
    expectedVersion: version,
    documentId: uuid.optional(),
    supersedesLinkId: uuid.optional(),
  }).strict(),
  record_finding: z.object({
    dealId: uuid,
    findingId: uuid.optional(),
    workstreamId: uuid,
    relatedRequestId: uuid.optional(),
    relatedDeliverableId: uuid.optional(),
    statement: text,
    severity: z.enum(["low", "medium", "high", "critical"]),
    materiality: z.enum(["immaterial", "non_material", "material", "critical"]),
    owner: InternalPartyRefSchema,
    requiredForWorkstreamCompletion: z.boolean().optional(),
  }).strict(),
  resolve_finding: z.object({
    dealId: uuid,
    findingId: uuid,
    expectedVersion: version,
    disposition: text,
  }).strict(),
  raise_deal_risk: z.object({
    dealId: uuid,
    dealRiskId: uuid.optional(),
    workstreamId: uuid,
    statement: text,
    severity: z.enum(["low", "medium", "high", "critical"]),
    owner: InternalPartyRefSchema,
    response: text.optional(),
    requiredForWorkstreamCompletion: z.boolean().optional(),
    originatingFindingIds: z.array(uuid).max(100).optional(),
  }).strict(),
  resolve_deal_risk: z.object({
    dealId: uuid,
    dealRiskId: uuid,
    expectedVersion: version,
    response: text,
  }).strict(),
  link_deal_dependency: z.object({
    dealId: uuid,
    dependencyId: uuid.optional(),
    blocker: DependencyEndpointSchema,
    blocked: DependencyEndpointSchema,
  }).strict(),
  mark_dependency_resolved: z.object({
    dealId: uuid,
    dependencyId: uuid,
    expectedVersion: version,
    reason: text,
  }).strict(),
  create_closing_condition: z.object({
    dealId: uuid,
    closingConditionId: uuid.optional(),
    workstreamId: uuid,
    conditionText: text,
    category: shortText,
    requiredForClose: z.boolean().optional(),
    evidenceRequired: z.boolean().optional(),
    waiverRequiresApproval: z.boolean().optional(),
    owner: InternalPartyRefSchema,
    responsibleDealPartyId: uuid.optional(),
    dueAt: dateTime.optional(),
  }).strict(),
  submit_condition_evidence: z.object({
    dealId: uuid,
    closingConditionId: uuid,
    evidenceSourceId: uuid,
    evidenceVersionId: uuid.optional(),
    relationship: z.enum(["supports", "verifies", "authorizes"]).default("supports"),
  }).strict(),
  satisfy_closing_condition: z.object({
    dealId: uuid,
    closingConditionId: uuid,
    expectedVersion: version,
    ...evidenceFields,
  }).strict().superRefine((value, context) => {
    if (!value.documentId && !value.evidenceSourceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "documentId or evidenceSourceId is required" });
    }
    if (value.evidenceVersionId && !value.evidenceSourceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "evidenceVersionId requires evidenceSourceId" });
    }
  }),
  waive_closing_condition: z.object({
    dealId: uuid,
    closingConditionId: uuid,
    expectedVersion: version,
    reason: text,
  }).strict(),
  verify_closing_item: z.object({
    dealId: uuid,
    closingItemId: uuid,
    expectedVersion: version,
    verifierEmployeeId: uuid.optional(),
    verificationSource: shortText.optional(),
    ...evidenceFields,
  }).strict().superRefine((value, context) => {
    if (!value.verifierEmployeeId && !value.verificationSource) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "verifierEmployeeId or verificationSource is required" });
    }
    if (!value.documentId && !value.evidenceSourceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "documentId or evidenceSourceId is required" });
    }
    if (value.evidenceVersionId && !value.evidenceSourceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "evidenceVersionId requires evidenceSourceId" });
    }
  }),
  declare_deal_closed: z.object({
    dealId: uuid,
    expectedVersion: version,
    expectedGraphVersion: version,
  }).strict(),
} as const;

export type PrivateEquityActionType = keyof typeof PRIVATE_EQUITY_ACTION_SCHEMAS;

export const PRIVATE_EQUITY_ACTION_TYPES = Object.freeze(Object.keys(PRIVATE_EQUITY_ACTION_SCHEMAS) as PrivateEquityActionType[]);
