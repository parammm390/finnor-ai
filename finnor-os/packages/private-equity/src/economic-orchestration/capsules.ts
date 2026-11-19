import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import type { SearchRow, UnitRow } from "../compute-search/contracts";
import type { ProgramRow } from "../program-synthesis/store";
import { sha, stable, tx } from "../evidence-execution/store";
import { checkMetalevelPolicy } from "../../../epistemic-runtime/src/metalevel-policy/checker";
import { nativeCapsuleSchema, nativeProposalSchema, developmentCheckSchema, nativeDeadlineAt, W1_NATIVE_VERSION, W1_NATIVE_LIMITS,
  type OrchestrationPolicyCapsule, type EconomicDevelopmentCheck } from "./contracts";
import { nativeControlSnapshotTx } from "./snapshot";
import { compileNativePolicy, nativeMaterialDigest, verifyNativeContinuationFit } from "./policy";
import { beginNativeMeter } from "./meter";
import { persistNativeGapTx } from "./gaps";

const capsuleRowSchema = z.object({ id: z.string().uuid(), body: nativeCapsuleSchema, digest: z.string() }).passthrough();
export async function storedEconomicCapsuleTx(s: SearchRow, digest: string, c: PoolClient): Promise<OrchestrationPolicyCapsule> {
  const raw = (await c.query("SELECT id,body,digest FROM finnor_os.w1_capsules WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND digest=$4", [s.tenant_id, s.principal_id, s.id, digest])).rows[0];
  if (!raw) throw Error("W1_CANONICAL_CAPSULE_UNAVAILABLE");
  const row = capsuleRowSchema.parse(raw);
  if (sha(row.body) !== row.digest || row.body.id !== row.id) throw Error("W1_IMMUTABLE_CAPSULE_DIGEST_MISMATCH");
  return row.body;
}
/** P2 calls this only after its durable SUBMITTED cut and physical admission. */
export async function executeEconomicControl(ctx: PeMutationContext, s: SearchRow, u: UnitRow, q: ProgramRow,
  attempt: { id: string }, execution: Readonly<JobExecutionContext>) {
  const finish = beginNativeMeter();
  const input = await tx(ctx, c => nativeControlSnapshotTx(ctx, s, q, c, { ignoreAttemptId: attempt.id }));
  let proposal = compileNativePolicy(input);
  // Pretty JSON is a conservative upper envelope for jsonb's separator spaces.
  // Refuse a too-large whole capsule, never truncate its tree or source table.
  if (Buffer.byteLength(JSON.stringify({ input, proposal }, null, 1)) > 4194304 - 16384)
    proposal = nativeProposalSchema.parse({ schema: "finnor.w1.native-policy-proposal.v1", status: "FALLBACK_REQUIRED",
      reason: "W1_WHOLE_CAPSULE_BYTE_BOUND", inputDigest: proposal.inputDigest, materialDigest: proposal.materialDigest,
      authorityGranted: false, protectedAdmission: false });
  const meter = finish();
  const capsule = await tx(ctx, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + s.tenant_id]);
    await c.query("SELECT id FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE", [s.tenant_id, s.principal_id, s.id]);
    const revision = Number((await c.query("SELECT coalesce(max(revision),0)+1 revision FROM finnor_os.w1_capsules WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3", [s.tenant_id, s.principal_id, s.id])).rows[0]?.revision);
    const body = nativeCapsuleSchema.parse({
      schema: "finnor.orchestration-policy-capsule.v1", version: W1_NATIVE_VERSION, id: randomUUID(), searchId: s.id, revision,
      input, proposal, execution: { attemptId: attempt.id, unitId: u.id, unitBodyDigest: u.digest,
        deliveryAttemptId: execution.deliveryAttemptId, jobId: execution.jobId, claimFence: execution.claimFence,
        originalEpisode: q.episode_id, originalDeadline: q.proposed.bounds.deadlineAt },
      meter,
      qualifications: ["ORDINARY_CANONICAL_P2_CONSUMER_NOT_PROTECTED_ADMISSION", "ORIGINAL_P1_OUTCOME_AND_SQL_ACCEPTANCE_UNCHANGED",
        "NATIVE_FITTED_RESPONSE_IS_ASSOCIATIONAL_NOT_CAUSAL", "ORIGINAL_S5_GRANT_AND_PHYSICAL_LEASE_REQUIRED",
        "S6_EFFECT_IDENTITIES_AND_UNKNOWN_RECONCILIATION_UNCHANGED", "ROOT_PROCESS_CPU_MEMORY_NOT_COMPLETE_CHILD_USAGE",
        "S7_MONETARY_COST_UNKNOWN_NO_ECONOMIC_GAIN_CLAIM"],
      authorityGranted: false,
    });
    if (!body.input.dependencyState) throw Error("W1_COMPLETE_NATIVE_DEPENDENCY_SNAPSHOT_REQUIRED");
    await c.query("INSERT INTO finnor_os.w1_capsules(id,tenant_id,principal_id,search_id,revision,unit_id,attempt_id,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
      [body.id, s.tenant_id, s.principal_id, s.id, revision, u.id, attempt.id, stable(body), sha(body)]);
    for (const missing of proposal.status === "CHECKED_POLICY" ? proposal.continuation?.unidentified ?? [] : [proposal.reason])
      await persistNativeGapTx(ctx, s, c, { kind: "CONDITIONAL_ACTION_OR_CHECK_UNSUPPORTED", subjectRef: sha(missing),
        contextRef: input.continuation?.ref ?? "NATIVE_CONTINUATION_UNAVAILABLE", evidenceRefs: ["w1-capsule:" + sha(body)],
        detail: typeof missing === "string" ? missing : stable(missing) });
    const dependencies = z.array(z.object({ key: z.string(), revision: z.number().int().nonnegative() }).passthrough()).parse(
      z.object({ dependencies: z.unknown() }).passthrough().parse(s.context).dependencies);
    for (const dependency of dependencies) await c.query(
      "INSERT INTO finnor_os.w1_dependencies(tenant_id,principal_id,search_id,capsule_digest,dependency_key,revision,facet) VALUES($1,$2,$3,$4,$5,$6,'SOURCE_RIGHTS_WORK') ON CONFLICT DO NOTHING",
      [s.tenant_id, s.principal_id, s.id, sha(body), dependency.key, dependency.revision]);
    return body;
  });
  return { w1CapsuleId: capsule.id, w1CapsuleDigest: sha(capsule), w1ProposalStatus: capsule.proposal.status, w1Meter: meter };
}
/** Actual S8's additive typed port calls this; it returns a check, never a grant. */
export async function prepareEconomicDevelopmentCheckTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, digest: string, c: PoolClient): Promise<EconomicDevelopmentCheck> {
  if (process.env.NODE_ENV === "production" || process.env.FINNOR_P4_PROFILE !== "ordinary_disposable") throw Error("W1_DEVELOPMENT_PROFILE_REQUIRED");
  const capsule = await storedEconomicCapsuleTx(s, digest, c);
  if (capsule.proposal.status !== "CHECKED_POLICY") throw Error("W1_CHECKED_NATIVE_POLICY_REQUIRED");
  const check = checkMetalevelPolicy(capsule.proposal.modelBytes, capsule.proposal.policy,
    { deadlineAt: Math.min(nativeDeadlineAt(capsule.input), Date.now() + 1000), maxSteps: W1_NATIVE_LIMITS.kernelSteps });
  if (check.status !== "VALID" || stable(check) !== stable(capsule.proposal.check)) throw Error("W1_S8_ORIGINAL_MODEL_CHECK_REQUIRED");
  if (!verifyNativeContinuationFit(capsule.input, capsule.proposal)) throw Error("W1_S8_ACTUAL_CONDITIONAL_FIT_REQUIRED");
  const now = await nativeControlSnapshotTx(ctx, s, q, c, { pinnedContinuationRef: capsule.proposal.responseRef,
    ignoreAttemptId: capsule.execution.attemptId });
  if (nativeMaterialDigest(now) !== capsule.proposal.materialDigest) throw Error("W1_S8_CURRENT_MATERIAL_BINDING_REQUIRED");
  const actual = (await c.query(
    "SELECT unit_id,delivery_id,claim_fence,status,body,digest FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND id=$4 FOR SHARE",
    [s.tenant_id, s.principal_id, s.id, capsule.execution.attemptId],
  )).rows[0];
  const attempt = z.object({ unit_id: z.string(), delivery_id: z.string(), claim_fence: z.coerce.number(), status: z.enum(["SUBMITTED", "COMPLETED"]),
    body: z.object({ workKind: z.literal("CONTROL_W1"), originalEpisode: z.string(), unitBodyDigest: z.string(), jobId: z.string(), protocolVersion: z.literal(3) }).passthrough(), digest: z.string() }).passthrough().parse(actual);
  if (sha(attempt.body) !== attempt.digest || attempt.unit_id !== capsule.execution.unitId || attempt.delivery_id !== capsule.execution.deliveryAttemptId ||
      attempt.claim_fence !== capsule.execution.claimFence || attempt.body.originalEpisode !== q.episode_id || attempt.body.jobId !== capsule.execution.jobId ||
      attempt.body.unitBodyDigest !== capsule.execution.unitBodyDigest) throw Error("W1_ACTUAL_CONTROL_ATTEMPT_REQUIRED");
  return developmentCheckSchema.parse({
    schema: "finnor.w1.s8-development-check.v1", domain: "ECONOMIC_ORCHESTRATION", protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT",
    tenantId: s.tenant_id, principalId: s.principal_id, workId: q.work_id, searchId: s.id, candidateDigest: digest,
    modelDigest: capsule.proposal.check.modelSha256, checkerRef: now.pins.checkerRef, runtimeRef: now.pins.runtimeRef,
    materialDigest: nativeMaterialDigest(now), validUntil: new Date(nativeDeadlineAt(now)).toISOString(), status: "CHECKED",
    protectedAdmission: false, productionActivated: false, executionAuthorityGranted: false,
  });
}
export async function currentEconomicDevelopmentCheckTx(ctx: PeMutationContext, s: SearchRow, capsule: OrchestrationPolicyCapsule, c: PoolClient): Promise<EconomicDevelopmentCheck> {
  const row = (await c.query(
    "SELECT body,digest FROM finnor_os.w1_development_checks WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND candidate_digest=$4",
    [s.tenant_id, s.principal_id, s.id, sha(capsule)],
  )).rows[0];
  if (!row || sha(row.body) !== row.digest) throw Error("W1_TYPED_S8_DEVELOPMENT_CHECK_REQUIRED");
  const check = developmentCheckSchema.parse(row.body);
  if (capsule.proposal.status !== "CHECKED_POLICY" || check.candidateDigest !== sha(capsule) ||
      check.modelDigest !== capsule.proposal.check.modelSha256 || check.materialDigest !== capsule.proposal.materialDigest ||
      check.tenantId !== ctx.auth.tenantId || check.principalId !== s.principal_id || check.searchId !== s.id ||
      check.workId !== capsule.input.binding.workId || check.validUntil !== new Date(nativeDeadlineAt(capsule.input)).toISOString() ||
      check.checkerRef !== capsule.input.pins.checkerRef || check.runtimeRef !== capsule.input.pins.runtimeRef ||
      Date.parse(check.validUntil) <= Date.now())
    throw Error("W1_TYPED_S8_DEVELOPMENT_CHECK_BINDING_UNPASSED");
  return check;
}
export async function latestPublishedEconomicCapsuleTx(ctx: PeMutationContext, s: SearchRow, c: PoolClient,
  options: { historical?: boolean } = {}): Promise<OrchestrationPolicyCapsule | null> {
  const row = (await c.query(
    `SELECT p.body,p.digest,a.body attempt,a.digest attempt_digest,a.unit_id,a.delivery_id,a.claim_fence
     FROM finnor_os.w1_capsules p JOIN finnor_os.p2_attempts a
       ON a.tenant_id=p.tenant_id AND a.principal_id=p.principal_id AND a.search_id=p.search_id AND a.id=p.attempt_id
     WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.search_id=$3 AND a.status='COMPLETED'
       AND a.body->>'w1CapsuleDigest'=p.digest ORDER BY p.revision DESC LIMIT 1`,
    [s.tenant_id, s.principal_id, s.id],
  )).rows[0];
  if (!row) return null;
  const capsule = nativeCapsuleSchema.parse(row.body), execution = capsule.execution;
  const actual = z.object({ workKind: z.literal("CONTROL_W1"), protocolVersion: z.literal(3),
    originalEpisode: z.string(), unitBodyDigest: z.string(), jobId: z.string(), deliveryAttemptId: z.string(),
    claimFence: z.number().int().positive() }).passthrough().parse(row.attempt);
  if (sha(capsule) !== row.digest || sha(row.attempt) !== row.attempt_digest || execution.unitId !== row.unit_id ||
      execution.deliveryAttemptId !== row.delivery_id || execution.claimFence !== Number(row.claim_fence) ||
      execution.jobId !== actual.jobId || execution.originalEpisode !== actual.originalEpisode ||
      execution.unitBodyDigest !== actual.unitBodyDigest || execution.claimFence !== actual.claimFence ||
      execution.deliveryAttemptId !== actual.deliveryAttemptId) throw Error("W1_PHYSICAL_PUBLICATION_RECEIPT_MISMATCH");
  // Currentness failure is not historical-byte erasure, nor an exception that
  // prevents the original owner from checking a remaining-budget fallback.
  if (!options.historical) {
    if (capsule.version !== W1_NATIVE_VERSION || nativeDeadlineAt(capsule.input) <= Date.now() ||
        capsule.input.continuation && Date.parse(capsule.input.continuation.context.validUntil) <= Date.now() ||
        (await c.query("SELECT capsule_digest FROM finnor_os.w1_invalidations WHERE tenant_id=$1 AND principal_id=$2 AND capsule_digest=$3 LIMIT 1",
          [s.tenant_id, s.principal_id, sha(capsule)])).rowCount) return null;
    if (capsule.proposal.status === "CHECKED_POLICY") await currentEconomicDevelopmentCheckTx(ctx, s, capsule, c);
  }
  return capsule;
}
