import { z } from "zod";
import { organizationTransformationInput, organizationReference, liveOrganizationObligation } from "./contracts";

const id = z.string().uuid(), key = z.string().min(1).max(160), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const organizationResources = z.object({
  resourceRefs: z.array(organizationReference).min(1).max(16),
  schedules: z.array(z.object({ resourceId: key, quantities: z.array(z.string().min(1).max(192)).min(1).max(1025) }).strict()).min(1).max(16),
}).strict();
export const nativeOrganizationOriginal = organizationTransformationInput.omit({
  tenantId: true, principalId: true, workId: true, workInputId: true,
}).extend({ resources: organizationResources }).strict();
export const organizationIntake = z.object({
  workId: id, idempotencyKey: key, original: nativeOrganizationOriginal,
}).strict();
export const organizationSubmit = z.object({ workId: id, workInputId: id, idempotencyKey: key,
  original: nativeOrganizationOriginal.optional() }).strict();
export const organizationSource = z.object({
  workId: id, idempotencyKey: key, sourceClass: z.enum(["CONTROLLED", "FIELD"]),
  observedAt: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }),
  kind: z.enum(["MEASUREMENT", "ORGANIZATION_SLICE", "MANDATE", "OPERATING_OBSERVATION", "COST", "ASSISTANCE"]),
  body: z.record(z.string(), z.unknown()),
}).strict().superRefine((v, ctx) => {
  if (Buffer.byteLength(JSON.stringify(v)) > 2 * 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "W5 source exceeds the original byte bound" });
  if (Date.parse(v.observedAt) > Date.now() || Date.parse(v.validUntil) <= Date.now() ||
      Date.parse(v.validUntil) <= Date.parse(v.observedAt))
    ctx.addIssue({ code: "custom", message: "A current, nonfuture source interval is required" });
});
export const organizationOwnerCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SELECT"), alternativeId: key }).strict(),
  z.object({ kind: z.literal("MIGRATE"), stage: z.enum(["TRIAL", "ACTIVE"]) }).strict(),
  z.object({ kind: z.literal("ROLLBACK") }).strict(),
  z.object({ kind: z.literal("CANCEL") }).strict(),
  z.object({ kind: z.literal("RECONCILE") }).strict(),
  z.object({ kind: z.literal("BIND_OBLIGATION"), obligation: liveOrganizationObligation }).strict(),
]);
export const organizationAction = z.object({ requestId: id, expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: key, action: organizationOwnerCommand }).strict();
export const organizationSelfDecision = z.object({ requestId: id, roleId: key, alternativeId: key,
  termsDigest: sha, decision: z.enum(["ADOPT", "DECLINE", "REVOKE"]), idempotencyKey: key }).strict();
export const organizationProcessUse = z.object({ requestId: id, workId: id, processId: key, roleId: key,
  idempotencyKey: key, trialAssignmentRef: organizationReference.optional(),
  evidence: z.array(z.object({ field: key, ref: organizationReference }).strict()).max(64) }).strict();
export const organizationEffectObservation = z.object({ requestId: id, processId: key, workId: id,
  useKey: z.string().min(1).max(240), obligationId: key }).strict();
export const organizationEffectContinuation = organizationEffectObservation.extend({
  expectedRevision: z.number().int().nonnegative(), idempotencyKey: key }).strict();
export const organizationPacketQuery = z.object({ requestId: id.optional(), workId: id.optional() }).strict();
export const organizationPacketRead = z.object({
  requestId: id, useKey: z.string().min(1).max(240), controlId: key, termsDigest: sha,
  packetRef: organizationReference, disclosureDigest: sha, idempotencyKey: key,
}).strict();
export const organizationReadQuery = z.object({ requestId: id.optional(), workId: id.optional(),
  workInputId: id.optional() }).strict().refine(value => !!value.requestId || !!value.workId);
export const organizationInputQuery = z.object({ workId: id }).strict();
export const organizationOffersQuery = z.object({ workId: id.optional() }).strict();
export const organizationEvaluationQuery = z.object({ requestId: id }).strict();
export const organizationEvaluation = organizationEvaluationQuery.extend({ idempotencyKey: key }).strict();
const organizationTrialIdentity = z.object({ requestId: id }).strict();
export const organizationTrialQuery = organizationTrialIdentity.extend({ audience: z.literal("SELF").optional() }).strict();
export const organizationTrialRegistration = organizationTrialIdentity.extend({
  expectedRevision: z.number().int().nonnegative(), idempotencyKey: key,
  units: z.array(z.object({ workId: id, workInputId: id, enrollmentRef: organizationReference }).strict()).min(40).max(512),
}).strict();
export const organizationTrialObservation = organizationTrialIdentity.extend({
  assignmentRef: organizationReference, evidenceRef: organizationReference, idempotencyKey: key,
}).strict();
export const organizationObligationComposition = z.object({
  companyId: id, obligationRef: organizationReference, reservationRef: organizationReference,
  accountableRoleId: key, processId: key, nodeId: key,
}).strict();
export const organizationResourceConstraintComposition = z.object({
  companyId: id, reservationRef: organizationReference,
}).strict();
export type OrganizationObligationComposition = z.infer<typeof organizationObligationComposition>;
export type OrganizationResourceConstraintComposition = z.infer<typeof organizationResourceConstraintComposition>;
export type NativeOrganizationOriginal = z.infer<typeof nativeOrganizationOriginal>;
export type OrganizationOwnerCommand = z.infer<typeof organizationOwnerCommand>;

export const ORGANIZATION_GET_OPERATIONS = ["input", "read", "offers", "packets", "continuation", "evaluation", "trial"] as const;
export const ORGANIZATION_POST_OPERATIONS = ["source", "intake", "submit", "action", "adoption", "process-use",
  "compose-obligation", "compose-resource-constraint", "packet-read", "continuation", "evaluation", "trial", "trial-observation"] as const;
export const OrganizationGetSchemas = {
  input: organizationInputQuery, read: organizationReadQuery, offers: organizationOffersQuery, packets: organizationPacketQuery,
  continuation: organizationEffectObservation,
  evaluation: organizationEvaluationQuery,
  trial: organizationTrialQuery,
} satisfies Record<(typeof ORGANIZATION_GET_OPERATIONS)[number], z.ZodType>;
export const OrganizationPostSchemas = {
  source: organizationSource, intake: organizationIntake, submit: organizationSubmit, action: organizationAction,
  adoption: organizationSelfDecision, "process-use": organizationProcessUse,
  "compose-obligation": organizationObligationComposition, "compose-resource-constraint": organizationResourceConstraintComposition,
  "packet-read": organizationPacketRead, continuation: organizationEffectContinuation, evaluation: organizationEvaluation,
  trial: organizationTrialRegistration, "trial-observation": organizationTrialObservation,
} satisfies Record<(typeof ORGANIZATION_POST_OPERATIONS)[number], z.ZodType>;
