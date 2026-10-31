import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { z } from "zod";
import { lockTenantMaterialCutTx, withDatabaseExecutionDeadline, withTenantTransaction } from "@finnor/db";
import { EvidenceRootSchema } from "@finnor/shared-types";
import { authorizeBeliefResources, authorizeBeliefSourceScopes } from "../enterprise-beliefs";
import { PeDomainError, type PeMutationContext } from "../types";
import { beginNativeMeter } from "./meter";

/** Explicit extractive research, not a claim to interpret arbitrary documents.
 * This port only reads the existing canonical source/authority owners. */
export const PRIMARY_RESEARCH_LIMITS = Object.freeze({
  requirements: 6, parallel: 2, snapshotBytes: 65536, valueBytes: 8192, requestMs: 30000,
});
const key = z.string().min(1).max(128);
const path = z.array(z.string().min(1).max(128).refine(part =>
  !["__proto__", "prototype", "constructor"].includes(part))).min(1).max(8);
export const PrimaryResearchRequestSchema = z.object({
  schema: z.literal("finnor.w1.primary-research-request.v1"),
  mode: z.literal("ordinary_disposable"),
  root: EvidenceRootSchema,
  workId: z.string().uuid(),
  workInputId: z.string().uuid(),
  question: z.string().trim().min(1).max(4096),
  deadlineAt: z.string().datetime({ offset: true }),
  maxParallel: z.number().int().min(1).max(PRIMARY_RESEARCH_LIMITS.parallel).default(1),
  requirements: z.array(z.object({
    id: key, question: z.string().trim().min(1).max(1024),
    sourceId: z.string().uuid(), path,
    valueType: z.enum(["string", "number", "boolean"]),
    dependsOn: z.array(key).max(PRIMARY_RESEARCH_LIMITS.requirements).default([]),
  }).strict()).min(1).max(PRIMARY_RESEARCH_LIMITS.requirements),
}).strict().superRefine((request, context) => {
  const ids = request.requirements.map(requirement => requirement.id);
  const complete = new Set<string>();
  if (new Set(ids).size !== ids.length || request.requirements.some(requirement =>
    new Set(requirement.dependsOn).size !== requirement.dependsOn.length ||
    requirement.dependsOn.some(id => !ids.includes(id) || id === requirement.id))) {
    context.addIssue({ code: "custom", message: "Unique original requirements and known prerequisites required" });
    return;
  }
  for (let round = 0; round < ids.length; round++)
    for (const requirement of request.requirements)
      if (requirement.dependsOn.every(id => complete.has(id))) complete.add(requirement.id);
  if (complete.size !== ids.length)
    context.addIssue({ code: "custom", message: "Cyclic original research prerequisites unsupported" });
});
type Request = z.infer<typeof PrimaryResearchRequestSchema>;
type Requirement = Request["requirements"][number];
type Status = "ANSWERED" | "MISSING_EVIDENCE" | "DEPENDENCY_MISSING" | "SOURCE_CHANGED" |
  "DEADLINE" | "UNSUPPORTED_SOURCE_BYTES" | "UNSUPPORTED_VALUE" | "TYPE_MISMATCH";
type Witness = {
  sourceId: string; versionId: string; contentHash: string; snapshotSha256: string; asOf: string;
};
type Answer = {
  id: string; question: string; sourceId: string; path: string[]; status: Status;
  value: string | number | boolean | null; witness: Witness | null;
};
type SourceRow = {
  source_id: string; version_id: string; content_hash: string; source_as_of: Date;
  snapshot_text: string | null; snapshot_bytes: number;
};
type Branch = {
  sourceId: string; requirementIds: string[]; startedAt: string; finishedAt: string;
  elapsedMs: number; bytes: number; witness: Witness | null; status: Status;
};
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const unavailable = () => new PeDomainError("PE_ENTITY_NOT_FOUND", "The authenticated research source is unavailable.");
const missing = (requirement: Requirement, status: Status): Answer => ({
  id: requirement.id, question: requirement.question, sourceId: requirement.sourceId,
  path: requirement.path, status, value: null, witness: null,
});
async function currentWork(client: PoolClient, ctx: PeMutationContext, request: Request) {
  const input = (await client.query<{ id: string; digest_preimage: string }>(
    `SELECT i.id::text,to_jsonb(i)::text AS digest_preimage
     FROM finnor_os.works w
     JOIN LATERAL(SELECT * FROM finnor_os.work_inputs original
       WHERE original.tenant_id=w.tenant_id AND original.work_id=w.id
       ORDER BY original.created_at DESC,original.id DESC LIMIT 1) i ON true
     WHERE w.tenant_id=$1 AND w.id=$2
       AND (w.created_by=$3 OR w.current_owner_id=$3)
       AND w.status<>'cancelled'`,
    [ctx.auth.tenantId, request.workId, ctx.auth.employeeId ?? ctx.auth.userId])).rows[0];
  if (!input || input.id !== request.workInputId) throw unavailable();
  return sha(input.digest_preimage);
}
async function authorize(client: PoolClient, ctx: PeMutationContext, request: Request) {
  const authority = await authorizeBeliefResources(ctx, [
    { type: request.root.entityType, id: request.root.entityId }, { type: "work", id: request.workId },
  ], client);
  await authorizeBeliefSourceScopes(ctx, request.root, request.requirements.map(row => row.sourceId), client);
  return { rightsRevision: authority.revision, inputDigest: await currentWork(client, ctx, request) };
}
/** Root/version linkage is required, not a tenant-wide evidence scan. The same
 * predicate is repeated during the final currentness cut. */
async function sources(client: PoolClient, ctx: PeMutationContext, request: Request,
  sourceIds: string[], includeBytes: boolean): Promise<SourceRow[]> {
  return (await client.query<SourceRow>(
    `SELECT e.id::text source_id,v.id::text version_id,v.content_hash,v.as_of source_as_of,
       octet_length(v.snapshot::text)::int snapshot_bytes,
       CASE WHEN $5::boolean AND octet_length(v.snapshot::text)<=$6::int THEN v.snapshot::text ELSE NULL END snapshot_text
     FROM finnor_os.evidence_sources e
     JOIN LATERAL(SELECT original.* FROM finnor_os.evidence_source_versions original
       WHERE original.tenant_id=e.tenant_id AND original.scope='tenant' AND original.source_id=e.id
       ORDER BY original.version_number DESC LIMIT 1) v ON true
     WHERE e.tenant_id=$1 AND e.scope='tenant' AND e.id=ANY($2::uuid[])
       AND v.as_of<=clock_timestamp()
       AND EXISTS(SELECT 1 FROM finnor_os.pe_evidence_links l
         WHERE l.tenant_id=e.tenant_id AND l.evidence_source_id=e.id AND l.archived_at IS NULL
           AND l.world_root_type=$3 AND l.world_root_id=$4
           AND (l.evidence_version_id IS NULL OR l.evidence_version_id=v.id))`,
    [ctx.auth.tenantId, sourceIds, request.root.entityType, request.root.entityId,
      includeBytes, PRIMARY_RESEARCH_LIMITS.snapshotBytes])).rows;
}
function extract(requirement: Requirement, snapshot: unknown, witness: Witness): Answer {
  let value: unknown = snapshot;
  for (const part of requirement.path) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part))
      return missing(requirement, "MISSING_EVIDENCE");
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    return missing(requirement, "UNSUPPORTED_VALUE");
  if (typeof value === "number" && !Number.isFinite(value) ||
      Buffer.byteLength(JSON.stringify(value)) > PRIMARY_RESEARCH_LIMITS.valueBytes)
    return missing(requirement, "UNSUPPORTED_VALUE");
  if (typeof value !== requirement.valueType) return missing(requirement, "TYPE_MISMATCH");
  return { ...missing(requirement, "ANSWERED"), value: value as string | number | boolean, witness };
}
export async function readPrimaryResearch(ctx: PeMutationContext, raw: unknown) {
  const request = PrimaryResearchRequestSchema.parse(raw), admittedAt = Date.now(), started = performance.now();
  const finishMeter = beginNativeMeter();
  if (process.env.NODE_ENV === "production" || process.env.FINNOR_P4_PROFILE !== "ordinary_disposable")
    throw Error("W1_RESEARCH_PROTECTED_OR_PRODUCTION_ADMISSION_UNAVAILABLE");
  const deadline = Date.parse(request.deadlineAt);
  // A client can attenuate this read, not buy unbounded connection occupancy.
  if (deadline > admittedAt + PRIMARY_RESEARCH_LIMITS.requestMs)
    throw Error("W1_RESEARCH_ORIGINAL_DEADLINE_BOUND_UNSUPPORTED");
  const branches: Branch[] = [], answers = new Map<string, Answer>();
  const cached = new Map<string, { row?: SourceRow; witness: Witness | null; snapshot: unknown; status: Status }>();
  const transaction = <T>(invoke: (client: PoolClient) => Promise<T>) =>
    withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, (_db, client) => invoke(client));
  type Cut = Awaited<ReturnType<typeof authorize>>;
  let maxObservedParallel = 0, roundCount = 0;
  // The DB deadline owner also bounds pool acquisition and cancels in-flight SQL;
  // Promise.race is deliberately not used to abandon a still-running query.
  const current: Cut = await withDatabaseExecutionDeadline(performance.now() + Math.max(0, deadline - Date.now()), async () => {
    const admitted = await transaction(client => authorize(client, ctx, request));
    while (answers.size < request.requirements.length) {
      if (Date.now() >= deadline) break;
      const ready = request.requirements.filter(requirement => !answers.has(requirement.id) &&
        requirement.dependsOn.every(id => answers.get(id)?.status === "ANSWERED"));
      if (!ready.length) break;
      const selected = [...new Set(ready.filter(requirement => !cached.has(requirement.sourceId))
        .map(requirement => requirement.sourceId))].slice(0, request.maxParallel);
      maxObservedParallel = Math.max(maxObservedParallel, selected.length);
      roundCount++;
      const results = await Promise.allSettled(selected.map(async sourceId => {
        const begin = performance.now(), startedAt = new Date().toISOString();
        const row = await transaction(async client => {
          const cut = await authorize(client, ctx, request);
          if (cut.rightsRevision !== admitted.rightsRevision || cut.inputDigest !== admitted.inputDigest)
            throw unavailable();
          return (await sources(client, ctx, request, [sourceId], true))[0];
        });
        const witness: Witness | null = row?.snapshot_text ? {
          sourceId, versionId: row.version_id, contentHash: row.content_hash,
          snapshotSha256: sha(row.snapshot_text), asOf: row.source_as_of.toISOString(),
        } : null;
        const status: Status = !row ? "MISSING_EVIDENCE" : !witness ? "UNSUPPORTED_SOURCE_BYTES" : "ANSWERED";
        cached.set(sourceId, { row, witness, status, snapshot: row?.snapshot_text ? JSON.parse(row.snapshot_text) : null });
        branches.push({ sourceId, requirementIds: request.requirements.filter(row => row.sourceId === sourceId).map(row => row.id),
          startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - begin,
          bytes: row?.snapshot_text ? Buffer.byteLength(row.snapshot_text) : 0, witness, status });
      }));
      // All sibling connections have settled before any error is returned.
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      let progress = false;
      for (const requirement of ready) {
        const retrieved = cached.get(requirement.sourceId);
        if (!retrieved) continue;
        answers.set(requirement.id, retrieved.witness ?
          extract(requirement, retrieved.snapshot, retrieved.witness) : missing(requirement, retrieved.status));
        progress = true;
      }
      if (!progress || roundCount > PRIMARY_RESEARCH_LIMITS.requirements)
        throw Error("W1_RESEARCH_ORIGINAL_REQUIREMENT_PROGRESS_UNPASSED");
    }
    // A fresh read rechecks rights AND exact source/root/version availability.
    // No source bytes escape if either the principal or original Work changed.
    return withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId }, async (db, client) => {
      // Use the mutation owners' same-client fence only for the final cut.
      // Source retrieval never holds this fence while waiting on a sibling.
      await lockTenantMaterialCutTx(db, ctx.auth.tenantId);
      // Canonical appendEvidenceVersion[Tx] takes FOR UPDATE on these same
      // source rows. Keep its established lock order; do not introduce a late
      // global fence into transactions that already hold another owner's S5.
      await client.query(`SELECT id FROM finnor_os.evidence_sources
        WHERE tenant_id=$1 AND scope='tenant' AND id=ANY($2::uuid[])
        ORDER BY id FOR SHARE`, [ctx.auth.tenantId, [...cached.keys()].sort()]);
      const cut = await authorize(client, ctx, request);
      if (cut.rightsRevision !== admitted.rightsRevision || cut.inputDigest !== admitted.inputDigest)
        throw unavailable();
      const latestRows = await sources(client, ctx, request, [...cached.keys()], false);
      for (const [sourceId, retrieved] of cached) {
        const latest = latestRows.find(row => row.source_id === sourceId);
        if (latest?.version_id !== retrieved.row?.version_id || latest?.content_hash !== retrieved.row?.content_hash) {
          for (const requirement of request.requirements.filter(row => row.sourceId === sourceId))
            answers.set(requirement.id, missing(requirement, "SOURCE_CHANGED"));
          for (const branch of branches.filter(row => row.sourceId === sourceId)) {
            branch.status = "SOURCE_CHANGED"; branch.witness = null;
          }
        }
      }
      const final = await authorize(client, ctx, request);
      if (final.rightsRevision !== cut.rightsRevision || final.inputDigest !== cut.inputDigest) throw unavailable();
      return final;
    });
  });
  if (Date.now() >= deadline) throw Error("W1_RESEARCH_ORIGINAL_DEADLINE_EXHAUSTED");
  for (const requirement of request.requirements)
    if (!answers.has(requirement.id))
      answers.set(requirement.id, missing(requirement, Date.now() >= deadline ? "DEADLINE" : "DEPENDENCY_MISSING"));
  // Invalidate dependent extracts too: a late source correction cannot leave a
  // downstream path marked complete from an invalid prerequisite.
  for (let round = 0; round < request.requirements.length; round++)
    for (const requirement of request.requirements)
      if (answers.get(requirement.id)?.status === "ANSWERED" &&
          requirement.dependsOn.some(id => answers.get(id)?.status !== "ANSWERED"))
        answers.set(requirement.id, missing(requirement, "DEPENDENCY_MISSING"));
  const ordered = request.requirements.map(requirement => answers.get(requirement.id)!);
  const answered = ordered.filter(answer => answer.status === "ANSWERED");
  const witnesses = [...new Map(answered.map(answer => [answer.witness!.versionId, answer.witness!])).values()];
  return {
    schema: "finnor.w1.primary-research-outcome.v1", workId: request.workId, workInputId: request.workInputId,
    question: request.question, observedAt: new Date().toISOString(), originalDeadlineAt: request.deadlineAt,
    coverage: { scope: "ORIGINAL_EXPLICIT_SOURCE_EXTRACTS_ONLY", status: answered.length === ordered.length ? "COMPLETE" : "INCOMPLETE",
      required: ordered.map(row => row.id), answered: answered.map(row => row.id),
      missing: ordered.filter(row => row.status !== "ANSWERED").map(row => ({ id: row.id, reason: row.status })) },
    answers: ordered, witnesses, branches, currentCut: current,
    allocation: { owner: "EXISTING_TENANT_READ_POOL", policy: "BOUNDED_MISSING_SOURCE_READ_WITH_PREREQUISITE_BARRIERS",
      originalMaxParallel: request.maxParallel, maxObservedParallel, rounds: roundCount,
      physicalSourceReads: branches.length, distinctSourceVersions: witnesses.length,
      simultaneousPhysicalDbOccupancy: null,
      duplicatePathsAreIndependentVotes: false, independenceProbability: null },
    costs: { elapsedMs: performance.now() - started, rootProcessInterval: finishMeter(),
      physicalSourceReads: branches.length, finalSourceCutQueries: 1,
      returnedSnapshotBytes: branches.reduce((sum, branch) => sum + branch.bytes, 0),
      usd: null, completeChildUsage: null, supervisorySeconds: null,
      status: "OBSERVED_READ_COUNTS_AND_REQUEST_WALL_NOT_COMPLETE_COST",
      missing: ["EXCLUSIVE_CPU_AND_DB_USAGE", "MONETARY_BILLING", "SUPERVISORY_COST", "FIELD_VALUE"],
      missingCostIsZero: false },
    sourceTreatment: "UNTRUSTED_QUOTED_SNAPSHOT_DATA_NOT_INSTRUCTIONS",
    qualification: "BOUNDED_EXTRACTIVE_DEVELOPMENT_PROFILE_NOT_GENERAL_RESEARCH_OR_ECONOMIC_QUALIFICATION",
    authorityGranted: false, protectedAdmission: false, productionActivated: false,
  };
}
