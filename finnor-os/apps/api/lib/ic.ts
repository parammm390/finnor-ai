import {
  IC_CONDITION_TYPES,
  IC_RECOMMENDATION_OUTCOMES,
  IC_VOTE_CHOICES,
  PE_ENTITY_TYPES,
  PeDomainError,
  type IcSourceLinkInput,
  type PeMutationContext,
} from "@finnor/private-equity";
import type { TenantContext } from "@finnor/shared-types";
import { z } from "zod";
import { boundedJson } from "./artifacts";
import { errorResponse, requireContext } from "./auth";

export const IcUuidSchema = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(240);
const caseVersion = z.number().int().min(1);
const childVersion = z.number().int().min(1);
const voteSetVersion = z.number().int().min(0);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const timestamp = z.string().datetime({ offset: true });

const IcSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EVIDENCE_VERSION"), evidenceVersionId: IcUuidSchema }).strict(),
  z.object({
    kind: z.literal("ARTIFACT_ANCHOR"),
    documentId: IcUuidSchema,
    documentVersionId: IcUuidSchema,
    anchorId: boundedText(2_048),
    anchorHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({ kind: z.literal("UNDERWRITING_RUN"), underwritingRunId: IcUuidSchema }).strict(),
  z.object({ kind: z.literal("P1_WORLD"), entityType: z.enum(PE_ENTITY_TYPES), entityId: IcUuidSchema }).strict(),
  z.object({ kind: z.literal("IC_QUESTION"), questionId: IcUuidSchema }).strict(),
  z.object({ kind: z.literal("PE_RISK"), riskId: IcUuidSchema }).strict(),
  z.object({ kind: z.literal("IC_CONDITION"), conditionId: IcUuidSchema }).strict(),
]);

export const IcSourceLinkSchema = z.object({
  source: IcSourceSchema,
  relationship: z.enum(["SUPPORTS", "CONTRADICTS", "ANSWERS", "VERIFIES", "REQUIRES", "REFERENCES"]),
  truthStatus: z.enum(["ATTACHED", "CONFLICTING", "STALE", "UNKNOWN"]).optional(),
  idempotencyKey,
}).strict();

export const IcCommitteeConfigurationSchema = z.object({
  committeeOrgUnitId: IcUuidSchema,
  policyRevisionId: IcUuidSchema,
  members: z.array(z.object({
    employeeId: IcUuidSchema,
    memberRole: boundedText(120),
    votingEligible: z.boolean().optional(),
    chair: z.boolean().optional(),
    effectiveFrom: timestamp,
    effectiveUntil: timestamp.optional(),
  }).strict()).min(1).max(50),
  idempotencyKey,
}).strict();

export const IcCreateCaseSchema = z.object({
  dealId: IcUuidSchema,
  investmentCaseId: IcUuidSchema,
  committeeConfigVersionId: IcUuidSchema,
  scheduledInternalEventId: IcUuidSchema.optional(),
  primaryUnderwritingRunId: IcUuidSchema.optional(),
  reconsidersDecisionId: IcUuidSchema.optional(),
  workId: IcUuidSchema.optional(),
  idempotencyKey,
}).strict();

export const IcCaseTransitionSchema = z.object({ expectedVersion: caseVersion }).strict();

export const IcSelectMemoSchema = z.object({
  expectedCaseVersion: caseVersion,
  artifactRole: z.enum(["MEMO", "DECK"]),
  documentId: IcUuidSchema,
  documentVersionId: IcUuidSchema,
  underwritingRunId: IcUuidSchema.optional(),
  evidenceCutoffAt: timestamp,
  sourceCompleteness: z.enum(["COMPLETE", "INCOMPLETE", "CONFLICTING", "UNKNOWN"]),
  changeClassification: z.enum(["INITIAL", "MATERIAL", "NON_MATERIAL", "MANUAL_REVIEW_REQUIRED"]).optional(),
  semanticChecks: z.record(z.unknown()).optional(),
  idempotencyKey,
}).strict();

export const IcSelectUnderwritingRunSchema = z.object({
  expectedCaseVersion: caseVersion,
  underwritingRunId: IcUuidSchema,
}).strict();

export const IcCreateQuestionSchema = z.object({
  expectedCaseVersion: caseVersion,
  question: boundedText(10_000),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
  requiredBeforeVote: z.boolean().optional(),
  requiredBeforeDecision: z.boolean().optional(),
  workId: IcUuidSchema.optional(),
  idempotencyKey,
}).strict();

export const IcQuestionSourceSchema = z.object({
  expectedQuestionVersion: childVersion,
  link: IcSourceLinkSchema,
}).strict();

export const IcAnswerQuestionSchema = z.object({
  expectedQuestionVersion: childVersion,
  answer: boundedText(20_000),
}).strict();

export const IcResolveQuestionSchema = z.object({ expectedQuestionVersion: childVersion }).strict();
export const IcSupersedeQuestionSchema = IcResolveQuestionSchema;

export const IcWaiveQuestionSchema = z.object({
  expectedQuestionVersion: childVersion,
  reason: boundedText(10_000),
  idempotencyKey,
}).strict();

export const IcRecommendationSchema = z.object({
  expectedCaseVersion: caseVersion,
  outcome: z.enum(IC_RECOMMENDATION_OUTCOMES),
  rationale: boundedText(20_000),
  memoId: IcUuidSchema.optional(),
  underwritingRunId: IcUuidSchema.optional(),
  sources: z.array(IcSourceLinkSchema).max(100).optional(),
  idempotencyKey,
}).strict();

export const IcOpenVotingSchema = z.object({
  expectedCaseVersion: caseVersion,
  recommendationId: IcUuidSchema,
  memoId: IcUuidSchema,
  underwritingRunId: IcUuidSchema,
  idempotencyKey,
}).strict();

// Deliberately no voterId/memberId/actorId/tenantId: recordIcVote derives the
// canonical voter exclusively from the verified request context.
export const IcVoteSchema = z.object({
  recommendationId: IcUuidSchema,
  memoId: IcUuidSchema,
  underwritingRunId: IcUuidSchema,
  expectedVotingBasisVersion: caseVersion,
  choice: z.enum(IC_VOTE_CHOICES),
  rationale: z.string().trim().max(10_000).optional(),
  idempotencyKey,
}).strict();

export const IcDissentSchema = z.object({
  voteId: IcUuidSchema,
  rationale: boundedText(20_000),
  sources: z.array(IcSourceLinkSchema).max(100).optional(),
  idempotencyKey,
}).strict();

export const IcConditionSchema = z.object({
  expectedCaseVersion: caseVersion,
  sourceRecommendationId: IcUuidSchema.optional(),
  conditionType: z.enum(IC_CONDITION_TYPES),
  title: boundedText(500),
  description: boundedText(10_000),
  ownerEmployeeId: IcUuidSchema,
  workId: IcUuidSchema.optional(),
  dueAt: timestamp.optional(),
  required: z.boolean().optional(),
  evidenceRequired: z.boolean().optional(),
  idempotencyKey,
}).strict();

export const IcConditionTransitionSchema = z.object({ expectedConditionVersion: childVersion }).strict();

export const IcSatisfyConditionSchema = z.object({
  expectedConditionVersion: childVersion,
  verification: IcSourceLinkSchema.refine((link) => link.relationship === "VERIFIES", {
    message: "Condition satisfaction requires a VERIFIES source relationship",
  }),
}).strict();

export const IcWaiveConditionSchema = z.object({
  expectedConditionVersion: childVersion,
  reason: boundedText(10_000),
  idempotencyKey,
}).strict();

export const IcDecisionProposalSchema = z.object({
  expectedCaseVersion: caseVersion,
  expectedVoteSetVersion: voteSetVersion,
  idempotencyKey,
}).strict();

export const IcCloseVotingSchema = IcDecisionProposalSchema;

export const IcFinalizeDecisionSchema = z.object({
  decisionProposalId: IcUuidSchema,
  expectedCaseVersion: caseVersion,
  title: boundedText(500),
  rationale: boundedText(20_000),
  idempotencyKey,
}).strict();

export function icContext(auth: TenantContext): PeMutationContext {
  const developmentEmployeeId = process.env.NODE_ENV !== "production" && IcUuidSchema.safeParse(auth.userId).success
    ? auth.userId
    : undefined;
  const employeeId = auth.employeeId ?? developmentEmployeeId;
  return {
    auth: { ...auth, ...(employeeId ? { employeeId } : {}) },
    provenance: { sourceSystem: "@finnor/api", createdBy: employeeId ?? auth.userId },
  };
}

export async function requireIcContext(req: Request): Promise<PeMutationContext> {
  return icContext(await requireContext(req));
}

export async function parseIcBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await boundedJson(req, 1_048_576));
}

export async function handleIcPost<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
  operation: (ctx: PeMutationContext, body: z.infer<T>) => Promise<unknown>,
  successStatus = 200,
): Promise<Response> {
  try {
    const [ctx, body] = await Promise.all([requireIcContext(req), parseIcBody(req, schema)]);
    return icJson(await operation(ctx, body), successStatus);
  } catch (error) {
    return icErrorResponse(error);
  }
}

export async function handleIcGet(
  req: Request,
  operation: (ctx: PeMutationContext) => Promise<unknown>,
): Promise<Response> {
  try {
    return icJson(await operation(await requireIcContext(req)));
  } catch (error) {
    return icErrorResponse(error);
  }
}

export function icJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function icErrorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "Invalid IC request", code: "INVALID_REQUEST", issues: error.issues.slice(0, 20) }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof PeDomainError) {
    const status = /NOT_FOUND/.test(error.code) ? 404
      : /AUTHORITY|EMPLOYEE_REQUIRED/.test(error.code) ? 403
        : /LIMIT|TOO_LARGE/.test(error.code) ? 413
          : /STALE|CONFLICT|ALREADY_RECORDED|MISMATCH/.test(error.code) ? 409
            : /BLOCKED|PREREQUISITE|INVALID_TRANSITION|VOTING_NOT_OPEN|TERMINAL/.test(error.code) ? 422 : 400;
    return Response.json({ error: error.message, code: error.code, details: error.details }, { status, headers: { "cache-control": "no-store" } });
  }
  return errorResponse(error);
}

export type ParsedIcSourceLink = z.infer<typeof IcSourceLinkSchema> & IcSourceLinkInput;
