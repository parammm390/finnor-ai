/** Z3 ViabilityStrategy native contracts. Owned leaf: no shared registry, type
 * barrel, schema or migration is modified here; integration is delivered as
 * exact preimage-bound coordinator patches. */
import { z } from "zod";
import { PE_WORLD_ROOT_TYPES } from "@finnor/shared-types";
import { ExperimentRefSchema } from "@finnor/epistemic-runtime";
import { hash, parseArena, parseBinding, Z3_VERSION, Z3_NONCONFLICTING_VERSION,
  type Candidate, type CheckReceipt, type IncompleteCandidate } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";

export const Z3_NATIVE_VERSION = "z3-native-v2" as const;
export const Z3_PRODUCE_JOB = "run_z3_viability_synthesis_v1" as const;
export const Z3_RECOVER_JOB = "run_z3_viability_recovery_v1" as const;
export const Z3_COMPUTE_SCHEMA = "finnor.z3.viability-compute.v1" as const;
export const Z3_OPERATIONS = ["viability-submit", "viability-read", "viability-recover"] as const;

export class Z3NativeFault extends Error {
  constructor(readonly code: string) { super(code); this.name = "Z3NativeFault"; }
}
export function z3Fault(code: string): never { throw new Z3NativeFault(code); }

/** Terminal verdicts are the independent checker's own vocabulary: a checked
 * session ends VIABLE or UNREALIZABLE, never a bare "done". UNKNOWN is not
 * terminal; STALE records lost currentness; FAILED records a rejected or
 * faulted delivery with responsibilities retained. */
export type ViabilitySessionStatus =
  | "INTAKE" | "PRODUCING" | "CHECKING"
  | "VIABLE" | "UNREALIZABLE" | "UNKNOWN" | "STALE" | "FAILED";
export type ViabilityBoundaryPoint = "CLAIM" | "STRATEGY" | "OBSERVATION";

/** Z3's own reference space. S-owned reference identities are never minted here. */
export interface ViabilityRef {
  owner: "Z3"; id: string; version: typeof Z3_NATIVE_VERSION; contentDigest: string;
}
export const z3Ref = (kind: string, body: unknown): ViabilityRef => {
  const contentDigest = hash(body);
  return { owner: "Z3", id: `z3-${kind}:${contentDigest}`, version: Z3_NATIVE_VERSION, contentDigest };
};

export interface ViabilityCheckpoint {
  point: ViabilityBoundaryPoint; jobId: string; deliveryAttemptId: string;
  claimFence: number; jobClaimFence: number; at: string;
}

/** A recovery job has its own physical fence. It is never overwritten by the
 * monotonic session overlay, including when a fresh job starts at fence 1. */
export interface ViabilityDelivery {
  physical: Readonly<import("../../../../../apps/worker/src/queue").JobExecutionContext>;
  jobType: typeof Z3_PRODUCE_JOB | typeof Z3_RECOVER_JOB;
}
export interface ViabilityClaim extends ViabilityDelivery { sessionFence: number }

export interface ViabilitySessionRow {
  id: string; tenant_id: string; principal_id: string;
  work_id: string; work_input_id: string; original_parent_id: string;
  arena_digest: string; binding_digest: string;
  arena: unknown; binding: unknown; reservation_ref: unknown;
  status: ViabilitySessionStatus; reason: string | null; generation: number;
  active_claim_token: string | null; active_claim_fence: string | number | null;
  checkpoint: unknown;
  candidate: unknown; candidate_digest: string | null;
  check_receipt: unknown; check_digest: string | null;
  s4_consumed: boolean; obligation_refs: unknown;
  deadline_at: string; created_at: string; updated_at: string;
}

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const RootSchema = z.object({
  entityType: z.enum(PE_WORLD_ROOT_TYPES), entityId: z.string().uuid(),
}).strict();

/** Only an original Work and idempotency key are selectors. Legacy fields
 * remain optional expected-value assertions, never source/authority inputs. */
export const SubmitSchema = z.object({
  workId: z.string().uuid(),
  arena: z.unknown().optional(),
  originalParentId: z.string().trim().min(1).max(256).optional(),
  sourceRevision: z.string().trim().min(1).max(256).optional(),
  mandateDigest: Hex64.optional(), observationDigest: Hex64.optional(), resourceDigest: Hex64.optional(),
  deadlineAt: z.string().datetime({ offset: true }).optional(),
  reservationRef: ExperimentRefSchema.nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(256),
}).strict();
export const ReadSchema = z.object({
  sessionId: z.string().uuid().optional(),
  workId: z.string().uuid().optional(),
  root: RootSchema.nullable(),
}).strict().refine(
  (value) => (value.sessionId ? 1 : 0) + (value.workId ? 1 : 0) === 1,
  { message: "Z3_EXACTLY_ONE_SESSION_OR_WORK" },
);
export const RecoverSchema = z.object({
  sessionId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(256),
  root: RootSchema.nullable(),
}).strict();
export const JobPayloadSchema = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), sessionId: z.string().uuid(),
  workId: z.string().uuid(),
}).strict();
export type ViabilityJobPayload = z.infer<typeof JobPayloadSchema>;

/** Semantic digest excludes meter floats, exactly like the independent checker. */
export const stripMetrics = <T extends object>(value: T): unknown =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== "metrics"));
export const candidateDigestOf = (candidate: Candidate): string => hash(stripMetrics(candidate));
export const receiptDigestOf = (receipt: CheckReceipt): string => hash(stripMetrics(receipt));

export function parseStoredCandidate(value: unknown): Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) z3Fault("Z3_CANDIDATE_PREIMAGE_INVALID");
  const c = value as Record<string, unknown>;
  const legacy = c.schema === "finnor.z3.viability-candidate.v1" && c.version === Z3_VERSION;
  const nonconflicting = c.schema === "finnor.z3.viability-candidate.v2" && c.version === Z3_NONCONFLICTING_VERSION;
  if (!legacy && !nonconflicting) z3Fault("Z3_CANDIDATE_VERSION");
  if (c.disposition === "COMPLETE") return value as Candidate;
  const partial = value as IncompleteCandidate;
  if (legacy && (c.disposition === "UNKNOWN" || c.disposition === "UNSUPPORTED")
    && partial.certificate === null && partial.strategy === null) return value as Candidate;
  z3Fault("Z3_CANDIDATE_PREIMAGE_INVALID");
}

export function parseStoredReceipt(value: unknown): CheckReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) z3Fault("Z3_CHECK_PREIMAGE_INVALID");
  const r = value as Record<string, unknown>;
  if (r.schema !== "finnor.z3.independent-check.v1"
    || !["VIABLE", "UNREALIZABLE", "UNKNOWN", "REJECTED", "UNSUPPORTED"].includes(String(r.status))) {
    z3Fault("Z3_CHECK_PREIMAGE_INVALID");
  }
  if (typeof r.reason !== "string" || !r.reason.length || r.reason.length > 256
    || typeof r.ordinaryComplete !== "boolean") z3Fault("Z3_CHECK_PREIMAGE_INVALID");
  if (r.nonconflictingComplete !== undefined && typeof r.nonconflictingComplete !== "boolean") {
    z3Fault("Z3_CHECK_PREIMAGE_INVALID");
  }
  if (r.nonconflictingComplete === true && (!["WINNING", "UNREALIZABLE"].includes(String(r.nonconflictingStatus))
    || !Array.isArray(r.nonconflictingRegion) || r.nonconflictingRegion.length > 256
    || r.nonconflictingRegion.some((v, i, values) => !Number.isSafeInteger(v) || v < 0 || v >= 256
      || i > 0 && v <= values[i - 1]))) z3Fault("Z3_CHECK_COMPLETENESS_MISSING");
  if (r.status === "VIABLE" && (r.ordinaryComplete !== true || r.ordinaryStatus !== "WINNING"
    || r.safety !== true || r.liveness !== true || r.nonconflicting !== true
    || r.originalAssumptionsSatisfiable !== true || r.nonconflictingComplete === false
    || r.nonconflictingComplete === true && r.nonconflictingStatus !== "WINNING")) z3Fault("Z3_CHECK_VIABLE_OBLIGATIONS_MISSING");
  if (r.status === "UNREALIZABLE" && (r.ordinaryComplete !== true
    || r.ordinaryStatus !== "UNREALIZABLE"
      && !(r.nonconflictingComplete === true && r.nonconflictingStatus === "UNREALIZABLE"))) z3Fault("Z3_CHECK_COMPLETENESS_MISSING");
  return value as CheckReceipt;
}

export { hash, parseArena, parseBinding };
