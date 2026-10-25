import { z } from "zod";
import { ClosingObservationSchema, ClosingOwnerRefSchema, ClosingSpecSchema, ClosingWorkContinuationSchema, type ClosingSpec } from "@finnor/shared-types";
import type { ClosingGraph, ClosingDisposition } from "@finnor/shared-types";

export const ClosingProfileSchema = z.object({
  schema: z.literal("finnor.closing-profile.v1"),
  environment: z.enum(["DEVELOPMENT", "REHEARSAL", "LIVE"]),
  checkerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  legalScope: z.string().min(1).max(160),
  issuers: z.array(z.object({
    id: z.string().min(1).max(160), publicKeyPem: z.string().min(1).max(4096),
    actorId: z.string().uuid(), status: z.enum(["ACTIVE", "REVOKED"]),
    qualifiedScopes: z.array(z.string().max(160)).max(64),
    kinds: z.array(ClosingObservationSchema.shape.kind).min(1).max(32),
    channels: z.array(z.string().max(160)).min(1).max(32),
    validUntil: z.string().datetime({ offset: true }),
    environment: z.enum(["DEVELOPMENT", "REHEARSAL", "LIVE"]),
    qualificationRef: ClosingOwnerRefSchema,
  }).strict()).min(1).max(128),
  roleBindings: z.array(z.object({
    ref: ClosingOwnerRefSchema, principalId: z.string().uuid(), assignmentId: z.string().uuid(),
    assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    roleDefinitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    legalEntityIds: z.array(z.string().uuid()).min(1).max(64),
  }).strict()).min(1).max(128),
  providers: z.array(z.object({
    id: z.string().min(1).max(160), origin: z.string().url().max(2048),
    accountId: z.string().min(1).max(256),
    integrationId: z.string().uuid(),
    credentialRef: z.string().min(1).max(512),
    allowedKinds: z.array(z.enum(["REQUEST_SIGNATURE", "DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE"])).min(1).max(5),
    observationIssuerIds: z.array(z.string().max(160)).min(1).max(32),
    qualificationRef: ClosingOwnerRefSchema,
  }).strict()).max(32),
  admission: z.unknown().nullable(),
  prerequisiteAdmissions: z.object({
    V1: ClosingOwnerRefSchema.nullable(), V2: ClosingOwnerRefSchema.nullable(),
  }).strict(),
  irreversibleOrdering: z.literal("EXPLICIT_DEPENDENCIES_WITH_RETAINED_EXPOSURE_NOT_ATOMIC"),
}).strict();
export type ClosingProfile = z.infer<typeof ClosingProfileSchema>;

export const ClosingIntakeSchema = z.object({
  spec: ClosingSpecSchema,
  expectedSpecDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedTermsEvidence: z.object({ sourceId: z.string().uuid(), versionId: z.string().uuid() }).strict(),
  legalAcceptance: ClosingObservationSchema,
  workId: z.string().uuid().optional(),
  continuation: ClosingWorkContinuationSchema.optional().describe("Exact original full-Work binding; requires workId and does not append an input or replace the goal"),
  acquisitionIcCaseId:z.string().uuid().optional().describe("Exact finalized committee case for a reviewed acquisition Work; independent closing authority remains required"),
  idempotencyKey: z.string().min(1).max(160),
}).strict();
const ProgrammeId = z.object({ programmeId: z.string().uuid() }).strict();
export const ClosingOperationSchemas = {
  submit: ClosingIntakeSchema, read: ProgrammeId,
  projection: z.object({ workId: z.string().uuid().optional(), transactionId: z.string().uuid().optional() }).strict(),
  observe: ProgrammeId.extend({ observation: ClosingObservationSchema }).strict(),
  stop: ProgrammeId, resume: ProgrammeId, ports: z.object({}).strict(),
} as const;
export interface ClosingProgrammeRow {
  id: string; tenant_id: string; transaction_id: string; principal_id: string;
  work_id: string; work_input_id: string; work_input_digest: string; plan_revision_id: string | null;
  profile_id: string; profile_digest: string; spec: ClosingSpec; spec_digest: string; graph: ClosingGraph;
  dependency_pins: Array<{ key: string; revision: number }>; authority_revision: number;
  intake_authority_decision_id: string; original_deadline_at: Date;
  accepted_terms_source_id: string; accepted_terms_version_id: string; approved_terms_revision: string;
  status: ClosingDisposition; generation: number; stopped_at: Date | null; reason: string | null;
  last_check_id: string | null; publication_action_id: string | null;
  intake_digest: string;
}
export class ClosingError extends Error {
  constructor(public readonly code: string, public readonly status = 422) { super(code); }
}
