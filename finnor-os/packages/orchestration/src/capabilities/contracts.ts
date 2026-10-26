import { z } from "zod";
import { ExperimentRefSchema } from "../../../epistemic-runtime/src/experiments";

const uuid = z.string().uuid();
export const DocumentSourceSchema = z.object({ documentId: uuid, versionId: uuid }).strict();
export const FrozenDocumentSourceSchema = DocumentSourceSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string(), sizeBytes: z.number().int().nonnegative() }).strict();
const dataset = DocumentSourceSchema.extend({ name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), format: z.enum(["csv", "json", "parquet"]) }).strict();
const envelope = { idempotencyKey: z.string().min(1).max(128), timeoutMs: z.number().int().min(100).max(300_000).default(60_000) };
export const PywhyAssessmentRequestSchema = z.object({ ...envelope, kind: z.literal("pywhy_assess"), dataset, treatment: z.string().min(1).max(128), outcome: z.string().min(1).max(128), commonCauses: z.array(z.string().min(1).max(128)).min(1).max(32), effectModifiers: z.array(z.string().min(1).max(128)).max(16).default([]), estimator: z.enum(["linear", "double_ml", "causal_forest"]), assumptions: z.array(z.object({ statement: z.string().min(1).max(2000), evidenceRef: z.string().min(1).max(1024) }).strict()).min(1).max(32), seed: z.number().int().min(0).max(2_147_483_647).default(0), interventionModelRef: ExperimentRefSchema.optional() }).strict();
export const CapabilityRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("duckdb_query"), datasets: z.array(dataset).min(1).max(8), query: z.string().min(1).max(50_000), maxRows: z.number().int().min(1).max(10_000).default(1000) }).strict(),
  z.object({ ...envelope, kind: z.literal("docling_extract"), source: DocumentSourceSchema, forceOcr: z.boolean().default(false) }).strict(),
  z.object({ ...envelope, kind: z.literal("pageindex_index"), source: DocumentSourceSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("pageindex_retrieve"), indexRunIds: z.array(uuid).min(1).max(8).refine(ids => new Set(ids).size === ids.length, "DUPLICATE_INDEX_RUN"), question: z.string().min(1).max(10_000) }).strict(),
  PywhyAssessmentRequestSchema,
  z.object({ ...envelope, kind: z.literal("gepa_optimize"), dataset: DocumentSourceSchema, maxMetricCalls: z.number().int().min(4).max(256).default(16), seed: z.number().int().min(0).max(2_147_483_647).default(0) }).strict(),
  z.object({ ...envelope, kind: z.literal("shinka_evolve"), problemSet: DocumentSourceSchema, generations: z.number().int().min(1).max(32).default(4), seed: z.number().int().min(0).max(2_147_483_647).default(0) }).strict(),
  z.object({ ...envelope, kind: z.literal("modal_execute"), code: z.string().min(1).max(100_000), sources: z.array(DocumentSourceSchema).max(8).default([]), stdin: z.string().max(100_000).default("") }).strict(),
  z.object({ ...envelope, kind: z.literal("modal_control"), executionRunId: uuid, operation: z.enum(["status", "terminate"]) }).strict(),
  z.object({ ...envelope, kind: z.literal("nango_sync"), integrationId: uuid, sourceScopeId: uuid, model: z.string().min(1).max(128) }).strict(),
  z.object({ ...envelope, kind: z.literal("parallel_task"), input: z.string().min(1).max(10_000), outputSchema: z.record(z.string(), z.unknown()), processor: z.enum(["lite", "base", "core", "pro", "ultra"]).default("core") }).strict(),
  z.object({ ...envelope, kind: z.literal("parallel_find"), objective: z.string().min(1).max(10_000), entityType: z.enum(["companies", "people", "products", "other"]), matchConditions: z.array(z.object({ name: z.string().min(1).max(128), description: z.string().min(1).max(2000) }).strict()).min(1).max(16), matchLimit: z.number().int().min(5).max(100).default(10), generator: z.enum(["core", "preview"]).default("core") }).strict(),
  z.object({ ...envelope, kind: z.literal("parallel_monitor"), query: z.string().min(1).max(10_000), cadence: z.enum(["hourly", "daily", "weekly"]).default("daily") }).strict(),
  z.object({ ...envelope, kind: z.literal("parallel_monitor_control"), monitorRunId: uuid, operation: z.enum(["status", "events", "cancel"]), eventGroupId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional() }).strict(),
]);
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;
export type CapabilityKind = CapabilityRequest["kind"];
export type CapabilityStatus = "QUEUED" | "RUNNING" | "WAITING_PROVIDER" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED";
export interface CapabilityActor { tenantId: string; userId: string; role: "owner"; employeeId?: string; correlationId?: string }
export interface FrozenDocumentSource { documentId: string; versionId: string; sha256: string; mediaType: string; sizeBytes: number }
export interface CapabilityRun {
  id: string; tenantId: string; principalId: string; kind: CapabilityKind; status: CapabilityStatus;
  request: CapabilityRequest; requestDigest: string; sources: FrozenDocumentSource[];
  result: Record<string, unknown> | null; resultDigest: string | null; failureCode: string | null;
  remoteState: Record<string, unknown>; deadlineAt: string; correlationId: string;
}

export function parallelMonitorRemoteId(run: CapabilityRun): string | null {
  if (run.kind !== "parallel_monitor") return null;
  const state = z.object({ provider: z.literal("parallel"), phase: z.literal("accepted"), remoteId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) });
  const direct = state.safeParse(run.remoteState);
  if (direct.success) return direct.data.remoteId;
  const late = state.safeParse(run.remoteState.acceptedReceipt);
  return late.success ? late.data.remoteId : null;
}

export const CapabilityRunRowSchema = z.object({
  id: uuid, tenant_id: uuid, principal_id: uuid, kind: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "WAITING_PROVIDER", "SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"]),
  request: CapabilityRequestSchema, request_digest: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(FrozenDocumentSourceSchema),
  result: z.record(z.string(), z.unknown()).nullable(), result_digest: z.string().nullable(), failure_code: z.string().nullable(),
  remote_state: z.record(z.string(), z.unknown()), deadline_at: z.coerce.date(), correlation_id: z.string(),
}).refine(row => row.kind === row.request.kind, "CAPABILITY_KIND_MISMATCH")
  .refine(row => row.status === "SUCCEEDED" ? row.result !== null && row.result_digest !== null : row.result === null, "CAPABILITY_RESULT_STATE_MISMATCH");

export function documentSources(request: CapabilityRequest): Array<z.infer<typeof DocumentSourceSchema>> {
  switch (request.kind) {
    case "duckdb_query": return request.datasets;
    case "docling_extract": case "pageindex_index": return [request.source];
    case "pywhy_assess": return [request.dataset];
    case "gepa_optimize": return [request.dataset];
    case "shinka_evolve": return [request.problemSet];
    case "modal_execute": return request.sources;
    case "pageindex_retrieve": case "nango_sync": case "modal_control": case "parallel_task": case "parallel_find": case "parallel_monitor": case "parallel_monitor_control": return [];
    default: { const exhaustive: never = request; return exhaustive; }
  }
}

export const CAPABILITY_PROVIDERS: Record<CapabilityKind, { provider: string; remote: boolean }> = {
  duckdb_query: { provider: "duckdb", remote: false }, docling_extract: { provider: "docling", remote: false },
  pageindex_index: { provider: "pageindex", remote: true }, pageindex_retrieve: { provider: "pageindex", remote: true },
  pywhy_assess: { provider: "pywhy", remote: false }, gepa_optimize: { provider: "gepa", remote: true },
  shinka_evolve: { provider: "shinka", remote: true }, modal_execute: { provider: "modal", remote: true },
  modal_control: { provider: "modal", remote: true },
  nango_sync: { provider: "nango", remote: false }, parallel_task: { provider: "parallel", remote: true },
  parallel_find: { provider: "parallel", remote: true }, parallel_monitor: { provider: "parallel", remote: true },
  parallel_monitor_control: { provider: "parallel", remote: true },
};
