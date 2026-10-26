import { sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant, type Db } from "@finnor/db";
import { evaluateAuthority } from "@finnor/authority";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { readCapabilityRun, appendCapabilityEvent } from "./repository";
import { capabilityDigest, requireActiveCapabilityPrincipal, assertCapabilityAuthorityRevision } from "./policy";
import type { CapabilityActor } from "./contracts";
import { plannerCandidateEnvironment, plannerCandidateEnvironmentDigest } from "./planner-environment";

const fields = { expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128), reviewNote: z.string().trim().min(16).max(4000) };
export const PlannerActivationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...fields, operation: z.literal("activate"), runId: z.string().uuid(), reviewedResultDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...fields, operation: z.literal("disable") }).strict(),
]);
const rowSchema = z.object({ id: z.string().uuid(), revision: z.coerce.number().int().positive(), operation: z.enum(["activate", "disable"]), run_id: z.string().uuid().nullable(),
  result_digest: z.string().nullable(), request_digest: z.string(), authority_revision: z.coerce.number().int().nonnegative(), review_note: z.string(), created_at: z.coerce.date() });
const qualifiedCandidate = z.object({ schema: z.literal("finnor.gepa-planner-candidate.v1"), candidate: z.object({ instruction: z.string().min(1).max(12_000) }).strict(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  plannerEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  holdout: z.object({ baseline: z.number().finite().min(0).max(1), candidate: z.number().finite().min(0).max(1), tasks: z.number().int().min(2), disposition: z.literal("IMPROVED_ON_THIS_HELDOUT_CUT") }),
  holdoutAvailableToOptimizer: z.literal(false), executionAuthorityGranted: z.literal(false) }).passthrough();
async function latest(db: Db, actor: CapabilityActor) {
  const result = await db.execute(sql`SELECT * FROM finnor_os.capability_planner_activations WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid ORDER BY revision DESC LIMIT 1`);
  return result.rows[0] ? rowSchema.parse(result.rows[0]) : null;
}
async function authority(actor: CapabilityActor) {
  const decision = await evaluateAuthority(actor, { operation: "execution", capability: "capability:gepa_activate", resource: { type: "planner", id: "background" }, risk: "high" });
  if (decision.outcome !== "allowed") throw new CapabilityEngineError("PLANNER_ACTIVATION_DENIED"); return decision;
}
function projection(row: z.infer<typeof rowSchema> | null) {
  return row ? { id: row.id, revision: row.revision, operation: row.operation, runId: row.run_id, reviewedResultDigest: row.result_digest, reviewNote: row.review_note, createdAt: row.created_at.toISOString() }
    : { id: null, revision: 0, operation: "disable" as const, runId: null, reviewedResultDigest: null, reviewNote: null, createdAt: null };
}
export async function readPlannerActivation(actor: CapabilityActor) {
  const decision = await authority(actor);
  const environment = await plannerCandidateEnvironment();
  return withTenant(actor.tenantId, async db => { await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision); return { activation: projection(await latest(db, actor)), channel: "background", environment, environmentDigest: capabilityDigest(environment), businessAuthorityGranted: false }; }, actor.userId);
}
export async function changePlannerActivation(actor: CapabilityActor, input: unknown) {
  const request = PlannerActivationRequestSchema.parse(input), decision = await authority(actor);
  if (request.operation === "activate") {
    if (process.env.FINNOR_GEPA_PLANNER_CANDIDATES_ENABLED !== "1") throw new CapabilityEngineError("PLANNER_CANDIDATE_ACTIVATION_NOT_ENABLED");
    const run = await readCapabilityRun(actor, request.runId);
    if (!run || run.kind !== "gepa_optimize" || run.status !== "SUCCEEDED" || run.resultDigest !== request.reviewedResultDigest || capabilityDigest(run.result) !== request.reviewedResultDigest)
      throw new CapabilityEngineError("PLANNER_CANDIDATE_RESULT_MISMATCH");
    const result = qualifiedCandidate.parse(run.result);
    if (capabilityDigest(result.candidate) !== result.candidateDigest || result.holdout.candidate <= result.holdout.baseline) throw new CapabilityEngineError("PLANNER_CANDIDATE_QUALIFICATION_FAILED");
    if (result.plannerEnvironmentDigest !== await plannerCandidateEnvironmentDigest()) throw new CapabilityEngineError("PLANNER_CANDIDATE_ENVIRONMENT_MISMATCH");
  }
  const digest = capabilityDigest(request);
  return withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`planner-activation:${actor.tenantId}:${actor.userId}`},0))`);
    const previous = await db.execute(sql`SELECT * FROM finnor_os.capability_planner_activations WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND idempotency_key=${request.idempotencyKey}`);
    if (previous.rows[0]) { const prior = rowSchema.parse(previous.rows[0]); if (prior.request_digest !== digest) throw new CapabilityEngineError("PLANNER_ACTIVATION_IDEMPOTENCY_CONFLICT"); return { activation: projection(prior), replayed: true }; }
    const current = await latest(db, actor);
    if ((current?.revision ?? 0) !== request.expectedRevision) throw new CapabilityEngineError("PLANNER_ACTIVATION_REVISION_CONFLICT");
    const inserted = await db.execute(sql`INSERT INTO finnor_os.capability_planner_activations(tenant_id,principal_id,revision,operation,run_id,result_digest,request_digest,idempotency_key,authority_revision,review_note)
      VALUES(${actor.tenantId}::uuid,${actor.userId}::uuid,${request.expectedRevision + 1},${request.operation},${request.operation === "activate" ? request.runId : null}::uuid,
      ${request.operation === "activate" ? request.reviewedResultDigest : null},${digest},${request.idempotencyKey},${decision.authorityRevision},${request.reviewNote}) RETURNING *`);
    if (request.operation === "activate") await appendCapabilityEvent(db, actor.tenantId, request.runId, "PROVIDER_OBSERVED", { plannerActivation: { revision: request.expectedRevision + 1, reviewedResultDigest: request.reviewedResultDigest, channel: "background", reviewerPrincipalId: actor.userId, scope: "PROPOSAL_HEURISTIC_ONLY", businessAuthorityGranted: false } });
    return { activation: projection(rowSchema.parse(inserted.rows[0])), replayed: false };
  }, actor.userId);
}

/** Only an explicit reviewed preference can affect production proposals. An
 * authority change makes the preference inactive until an owner reviews again. */
export async function loadActivePlannerHeuristic(actor: CapabilityActor) {
  if (process.env.FINNOR_GEPA_PLANNER_CANDIDATES_ENABLED !== "1") return null;
  const setting = await withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor); const row = await latest(db, actor); if (!row || row.operation !== "activate") return null;
    const current = await db.execute(sql`SELECT revision FROM finnor_os.authority_states WHERE tenant_id=${actor.tenantId}::uuid`);
    return Number(current.rows[0]?.revision) === row.authority_revision ? row : null;
  }, actor.userId);
  if (!setting?.run_id) return null;
  const run = await readCapabilityRun(actor, setting.run_id);
  if (!run || run.kind !== "gepa_optimize" || run.status !== "SUCCEEDED" || run.resultDigest !== setting.result_digest) throw new CapabilityEngineError("PLANNER_ACTIVE_RESULT_MISMATCH");
  const result = qualifiedCandidate.parse(run.result);
  if (capabilityDigest(run.result) !== setting.result_digest || capabilityDigest(result.candidate) !== result.candidateDigest) throw new CapabilityEngineError("PLANNER_ACTIVE_DIGEST_MISMATCH");
  if (result.plannerEnvironmentDigest !== await plannerCandidateEnvironmentDigest()) return null;
  const decision = await authority(actor);
  return withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    const current = await latest(db, actor); if (current?.id !== setting.id || current.authority_revision !== decision.authorityRevision) return null;
    return { instruction: result.candidate.instruction, runId: run.id, candidateDigest: result.candidateDigest, activationRevision: setting.revision };
  }, actor.userId);
}
