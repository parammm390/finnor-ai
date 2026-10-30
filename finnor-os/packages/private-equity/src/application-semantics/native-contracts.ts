import { z } from "zod";
import { InstitutionApplicationSelectorSchema } from "../../../orchestration/src/project-z/z0-convergence/semantics";
import { EvidenceRootSchema } from "@finnor/shared-types";
import {
  ApplicationStateSchema, ScopedApplicationIdentitySchema, X2RefSchema,
} from "./contracts";

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const key = z.string().min(1).max(256);
export const ApplicationDemandSchema = z.object({
  resourceId: key, unit: z.enum(["request", "seconds"]),
  amount: z.string().regex(/^(?:0|[1-9][0-9]{0,3})$/),
}).strict();
export const ApplicationAcquireSchema = z.object({
  root: EvidenceRootSchema, workId: uuid,
  profileIds: z.array(uuid).min(1).max(8),
  targets: z.array(ScopedApplicationIdentitySchema).min(2).max(16),
  resourceDemand: z.array(ApplicationDemandSchema).min(1).max(2),
  deadlineAt: instant, idempotencyKey: key,
  institutionalOrigin: InstitutionApplicationSelectorSchema.optional(),
}).strict();
export const ApplicationExecuteSchema = z.object({
  root: EvidenceRootSchema, workId: uuid, sessionId: uuid,
  executionProfileId: uuid, targetId: key,
  goal: ApplicationStateSchema, parameters: ApplicationStateSchema,
  idempotencyKey: key,
}).strict();
export const ApplicationProjectionSchema = z.object({
  root: EvidenceRootSchema, workId: uuid,
}).strict();
export const ApplicationSessionIdSchema = z.object({ sessionId: uuid }).strict();
export const ApplicationComposeOwnerSchema = z.object({
  sessionId: uuid, target: ScopedApplicationIdentitySchema,
  goal: ApplicationStateSchema, parameters: ApplicationStateSchema,
}).strict();
export const ApplicationContinuationOwnerSchema = z.object({
  sessionId: uuid, compositionRef: X2RefSchema, idempotencyKey: key,
}).strict();
export const ApplicationFreshRoleBindingSchema = z.object({
  profileId: uuid, role: key, applicationAccountId: uuid,
  originalGrantRef: X2RefSchema, currentGrantRef: X2RefSchema,
  privateProfileBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationIds: z.array(key).min(1).max(16),
}).strict();
export const ApplicationFreshAuthorityBodySchema = z.object({
  schema: z.literal("finnor.s4.application-fresh-authority.v1"),
  sessionId: uuid, parentId: uuid, tenantId: uuid, principalId: uuid, workId: uuid,
  workInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  originalParentRef: X2RefSchema, modelRef: X2RefSchema, checkRef: X2RefSchema,
  rightsRef: key, target: ScopedApplicationIdentitySchema, deadlineAt: instant,
  bindings: z.array(ApplicationFreshRoleBindingSchema).min(1).max(8),
  protectionDomain: z.literal("DISPOSABLE_TEST_AUTHORITY"),
  protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict();
export type ApplicationFreshAuthority = z.infer<typeof ApplicationFreshAuthorityBodySchema>;
export type ApplicationAcquireRequest = z.infer<typeof ApplicationAcquireSchema>;
export type ApplicationExecuteRequest = z.infer<typeof ApplicationExecuteSchema>;
export type ApplicationResourceDemand = z.infer<typeof ApplicationDemandSchema>;
export type ApplicationPhase = "ACQUISITION" | "CHECKING" | "COMPOSITION" | "EXECUTION"
  | "RECOVERY" | "OBSERVATION" | "MAINTENANCE" | "HUMAN";
