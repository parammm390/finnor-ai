import { z } from "zod";
import type { BeliefViewPin, ExperimentRef } from "@finnor/shared-types";
import { ExperimentRefSchema } from "@finnor/epistemic-runtime";
import { IdentificationProblemSchema, type IdentificationProblem } from "../../../shared-types/src/identification-plan";
import { PE_WORLD_ROOT_TYPES, type PeWorldRootRef } from "../types";

export const R4_VERSION = "r4-identification-plan-v1";
export const R4_METHOD = "y0-0.2.11-current-kernel-trace-v1";
export const R4_CHECKER = "r4-independent-v1";
const uuid = z.string().uuid();
const root = z.object({ entityType: z.enum(PE_WORLD_ROOT_TYPES), entityId: uuid }).strict();
export const ProfileRegistrationSchema = z.object({
  root,
  workId: uuid, workInputId: uuid, modelRef: ExperimentRefSchema,
  estimandId: z.string().min(1).max(240), targetRecordId: z.string().min(1).max(240),
  policyRef: ExperimentRefSchema, allocationRef: ExperimentRefSchema,
  problem: IdentificationProblemSchema,
  priorProfileId: uuid.nullable(),
}).strict();
export type ProfileRegistration = z.infer<typeof ProfileRegistrationSchema>;
export const SubmitSchema = z.object({
  schema: z.literal("finnor.r4.run-request.v1"),
  envelope_inputs: z.object({ profileId: uuid }).strict(),
  problem_ref: ExperimentRefSchema,
  existing_work_revision: uuid, domain_profile_ref: ExperimentRefSchema,
  budget_grant_ref: ExperimentRefSchema, cancellation_ref: uuid,
  idempotencyKey: z.string().min(1).max(160),
}).strict();
export const RunSchema = z.object({ runId: uuid }).strict();
export const ConsumeSchema = RunSchema.extend({
  disposition: z.enum(["PROPOSE", "DECLINE", "WAIT"]),
}).strict();
export const WorkReadSchema = z.object({ root, workId: uuid }).strict();
export const R4_OPERATIONS = ["register", "submit", "work", "read", "status", "history", "cancel", "consume"] as const;
export const R4_READ_OPERATIONS = ["work", "read", "status", "history"] as const;
export const R4_OPERATION_SCHEMAS = {
  register: ProfileRegistrationSchema, submit: SubmitSchema, work: WorkReadSchema,
  read: RunSchema, status: RunSchema, history: RunSchema, cancel: RunSchema, consume: ConsumeSchema,
} as const;
export interface R4Profile {
  id: string; ref: ExperimentRef; revision: number;
  tenantId: string; principalId: string; root: PeWorldRootRef;
  workId: string; workInputId: string; workInputDigest: string;
  registration: ProfileRegistration; problem: IdentificationProblem;
  ownerBinding: any; beliefPins: BeliefViewPin[];
  dependencies: Array<{ key: string; revision: number }>;
  runtime: { digest: string; files: Array<{ path: string; sha256: string }>; python: string; executableDigest: string };
  schemaDigest: string; knowledgeAt: string;
  qualification: "AUTHENTICATED_OWNER_DECLARATIONS_UNADMITTED";
}
export interface R4RunRow {
  id: string; tenant_id: string; principal_id: string; profile_id: string;
  episode_id: string; work_id: string; status: string; generation: number;
  request: z.infer<typeof SubmitSchema>; request_digest: string;
  head_id: string | null; failure: string | null;
  claim_token: string | null; claim_fence: number | null;
}
export interface R4Artifact {
  schema: "finnor.r4.artifact.v1"; id: string; revision: number; tenantId: string; principalId: string;
  work: { id: string; revision: string; inputDigest: string }; profileRef: ExperimentRef;
  baselineManifest: IdentificationProblem["baseline"];
  producer: any; ownerInputs: any; domain: string; assumptions: string[];
  claims: any; checker: any; plan: import("../../../shared-types/src/identification-plan").IdentificationPlan;
  gaps: string[]; resources: any; invalidationDependencies: R4Profile["dependencies"];
  lifecycle: "development-verified"; scientificAdmission: null; active: false;
}
