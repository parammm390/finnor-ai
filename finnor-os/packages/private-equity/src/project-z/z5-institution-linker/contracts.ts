import { z } from "zod";
import type { ExperimentRef } from "@finnor/shared-types";
import { PE_WORLD_ROOT_TYPES, type PeWorldRootRef } from "../../types";
import type { Certificate, Input, Component, State } from "../../../../epistemic-runtime/src/project-z/z5-institution-linker/kernel";
export { canonical, digest, parseInput, Z5_VERSION, PREORDER } from "../../../../epistemic-runtime/src/project-z/z5-institution-linker/kernel";
export type { Certificate, Input, Component, State };

export const PRODUCT_LOCK = "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf";
export const PACK_LOCK = "4419731d2544d1c07fe275ec8071d5d783273942ca9947eda2ff6b4e2dffb9db";
export const CONSUMER_VERSION = "z5-s4-s8-declared-contract-consumer-v1";
export const JOB_TYPE = "link_institution_components_v1";
export const RefSchema = z.object({ owner: z.string().min(1).max(128), id: z.string().min(1).max(4096),
  version: z.string().min(1).max(192), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const RootSchema = z.object({ entityType: z.enum(PE_WORLD_ROOT_TYPES),
  entityId: z.string().uuid() }).strict();
export const SubmitSchema = z.object({
  workId: z.string().uuid(), root: RootSchema, idempotencyKey: z.string().min(1).max(128),
  profileRef: RefSchema, preparationRef: RefSchema, policyRef: RefSchema, allocationRef: RefSchema,
  consumptionRef: RefSchema, mandateRef: RefSchema, assignmentRef: RefSchema,
  parentReservation: RefSchema, responsibilityIdentity: z.string().min(1).max(256),
  obligationRefs: z.array(RefSchema).max(64), originalDeadline: z.string().datetime({ offset: true }),
}).strict();
export type Submit = z.infer<typeof SubmitSchema>;
export const ProjectionSchema = z.object({ workId: z.string().uuid(), root: RootSchema }).strict();
export const RequestSchema = z.object({ requestId: z.string().uuid(), workId: z.string().uuid(), root: RootSchema }).strict();
export const UseSchema = RequestSchema.extend({ artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(128) }).strict();
export const RegisterSchema = z.object({ root: RootSchema, workId: z.string().uuid(), sourceRef: RefSchema }).strict();
export const RevokeSchema = z.object({ root: RootSchema, workId: z.string().uuid(), profileRef: RefSchema,
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{1,159}$/) }).strict();
export const Z5_OPERATIONS = ["institution-contract-register", "institution-link-submit", "institution-link-read",
  "institution-link-projection", "institution-link-cancel", "institution-link-admit", "institution-link-use",
  "institution-contract-revoke"] as const;
export const Z5_SCHEMAS = {
  "institution-contract-register": RegisterSchema, "institution-link-submit": SubmitSchema,
  "institution-link-read": RequestSchema, "institution-link-projection": ProjectionSchema,
  "institution-link-cancel": RequestSchema, "institution-link-admit": RequestSchema,
  "institution-link-use": UseSchema, "institution-contract-revoke": RevokeSchema,
} as const;
export interface Profile {
  schema: "finnor.s8.fixed-institution-components.v1"; domain: "ORDINARY_DEVELOPMENT";
  tenantId: string; principalId: string; workId: string; root: PeWorldRootRef;
  validUntil: string; rightsRevision: string; sourceRef: ExperimentRef;
  contract: Input; componentAdmissionRefs: ExperimentRef[];
  sourceDependencies: { key: string; revision: number; nodeIds: string[]; digest: null }[];
  nativeLocals: { component: string; owner: "S4_PREPARATION" | "S5_RESERVATION" | "S6_EFFECT";
    states: Record<string, string> }[];
  nativeCells: { cell: string; meaning: "POLICY_DIGEST" | "RESERVATION_ID" | "OBLIGATION_DIGEST"
    | "RESOURCE_ENVELOPE_DIGEST" | "RIGHTS_REVISION" | "UNKNOWN_FLAG"; values: Record<string, string> }[];
  protectedAdmission: false; executionAuthorityGranted: false;
}
export interface Build {
  schema: "finnor.z5.loaded-source.v1"; sourceCommit: string; sourceTree: string; sourceDigest: string;
  node: string; files: { path: string; sha256: string }[]; installedBuildId: string | null;
}
export interface OwnerCut {
  workInputId: string; workInputDigest: string; rightsRevision: string; dependencies: Profile["sourceDependencies"];
  live: State; liveDigest: string; originalObligationRefs: ExperimentRef[];
  nativeDigest: string; exposureRetained: true; effectAuthority: false;
  independentObservationDigest: string; estimandRef: ExperimentRef; rightsRef: string;
}
export interface SessionRow {
  id: string; tenant_id: string; principal_id: string; work_id: string; root: PeWorldRootRef;
  request: Submit; request_digest: string; input: Input; cut: OwnerCut; profile_ref: ExperimentRef;
  work_input_id: string; work_input_digest: string; rights_revision: string; source_digest: string;
  generation: number; status: string; deadline_at: Date; deliveries: number; cancel_requested: boolean;
  claim_token: string | null; claim_fence: number | null; artifact_digest: string | null; admission: Admission | null;
}
export interface Artifact {
  schema: "finnor.z5.native-artifact.v1";
  payload: { requestId: string; generation: number; input: Input; certificate: Certificate; check: IndependentCheck;
    ownerCut: OwnerCut; originalRequest: Submit; producerBuild: Build };
  envelope: {
    schemaVersion: string; phase: "Z5"; principalOutputType: "InstitutionCompositionCertificate";
    immutableArtifactDigest: string; productLockDigest: string; sourceCommit: string; sourceTree: string;
    producerBuildIdentity: Build; originalTenant: string; principal: string;
    Work: { id: string; inputId: string; inputDigest: string; root: PeWorldRootRef };
    mandate: ExperimentRef; assignment: ExperimentRef; parentReservation: ExperimentRef; originalDeadline: string;
    remainingBudgetReference: ExperimentRef; unresolvedObligationReferences: ExperimentRef[];
    inputSemanticsAndRevisionReferences: ExperimentRef[]; rightsAndPermittedUseFingerprint: string;
    supportedDomain: string; unsupportedConditions: string[]; claimAndEvidenceClasses: string[];
    checkerIdentityAndResultReferences: { checkerSha256: string; result: IndependentCheck };
    currentnessDependencies: OwnerCut; securityAndConfidentialityProfile: Record<string, unknown>;
    ownerConsumerContractVersion: string; costAndResourceReceiptReferences: ExperimentRef[];
    gaps: string[]; reconstructionReference: string;
  }; certificate: Certificate; ref: ExperimentRef;
}
export interface IndependentCheck {
  schema: string; checker: string; checked: boolean; inputDigest: string; claimDigest: string;
  disposition: string; protectedAdmission: false; executionAuthorityGranted: false; scope: string; operations: number;
}
export interface Admission {
  schema: "finnor.s8.institution-composition-admission.v1"; ref: ExperimentRef; tenantId: string; principalId: string;
  requestId: string; artifactDigest: string; inputDigest: string; checkerDigest: string; sourceDigest: string;
  liveDigest: string; rightsRevision: string; validUntil: string; domain: "ORDINARY_DEVELOPMENT";
  nativeS8Reference: ExperimentRef; nativeS8PolicyDigest: string;
  protectedAdmission: false; executionAuthorityGranted: false; productionActivated: false;
}
export function ordinaryDevelopment() {
  if (process.env.NODE_ENV === "production" || process.env.FINNOR_Z5_PROFILE !== "ordinary_disposable"
    || process.env.FINNOR_ENVIRONMENT !== "ordinary_disposable" || process.env.AUTH_DEV_BYPASS === "1")
    throw Error("Z5_ORDINARY_DEVELOPMENT_PROFILE_REQUIRED");
}
