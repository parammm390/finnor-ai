import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { tx, principal } from "../evidence-execution/store";
import { hash, stable } from "./exact";
import { append, artifact, profile, runRow, currentLocal, costs } from "./store";
import { currentOwners, retainFallback } from "./owners";
import { nativeWork } from "./native";
import type { R4Artifact, R4RunRow } from "./contracts";

const Payload = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), runId: z.string().uuid(),
  generation: z.number().int().positive() }).strict();
export async function runIdentificationPlan(payload: Record<string, unknown>, x?: Readonly<JobExecutionContext>) {
  const data = Payload.parse(payload);
  if (!x || x.tenantId !== data.tenantId || x.protocolVersion !== 1) throw Error("R4_ACTUAL_VERSIONED_QUEUE_REQUIRED");
  const ctx: PeMutationContext = { auth: { tenantId: data.tenantId, userId: data.principalId, employeeId: data.principalId, role: "owner" } };
  let run = await runRow(ctx, data.runId), p = await profile(ctx, run.profile_id);
  if (run.generation !== data.generation || ["COMPLETE", "CANCELLED", "INVALIDATED"].includes(run.status)) return;
  try {
  await currentOwners(ctx, p);
  const claimed = await tx(ctx, async c => {
    const locked = await runRow(ctx, data.runId, c, true);
    const attempts = (await c.query("SELECT id FROM finnor_os.r4_attempts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3",
      [ctx.auth.tenantId, principal(ctx), run.id])).rows;
    if (attempts.length) {
      await c.query("UPDATE finnor_os.r4_runs SET status='UNKNOWN',failure='R4_DUPLICATE_OR_ABANDONED_NATIVE_NO_RETRY' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status NOT IN('COMPLETE','CANCELLED','INVALIDATED')", [ctx.auth.tenantId, principal(ctx), run.id]);
      await append(ctx, run.id, "DUPLICATE_FENCED_NO_PHYSICAL_RETRY", { deliveryAttemptId: x.deliveryAttemptId, retainedAttempts: attempts.map(a => a.id) }, c);
      return false;
    }
    if (locked.status !== "QUEUED" || locked.generation !== data.generation) return false;
    await currentLocal(ctx, p, c, true);
    await c.query("UPDATE finnor_os.r4_runs SET status='RUNNING',claim_token=$4,claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, principal(ctx), run.id, x.claimToken, x.claimFence]);
    await append(ctx, run.id, "CLAIMED", { jobId: x.jobId, deliveryAttemptId: x.deliveryAttemptId, claimToken: x.claimToken, claimFence: x.claimFence,
      protocolVersion: x.protocolVersion, originalEpisode: run.episode_id }, c);
    return true;
  });
  if (!claimed) return;
  run = await runRow(ctx, data.runId);
    await currentOwners(ctx, p);
    const produced = await nativeWork(ctx, p, run, x, "PRODUCER", { problem: p.problem });
    const candidateRef = await artifact(ctx, run.id, "CANDIDATE", produced.value);
    await append(ctx, run.id, "CANDIDATE_PROVISIONAL", { ref: candidateRef, nativeReceipt: produced.receipt,
      checked: false, effectEstimate: null, executionAuthorityGranted: false });
    if (!produced.value.plan) throw Error("R4_NATIVE_" + (produced.value.status ?? "UNKNOWN"));
    await currentOwners(ctx, p);
    const checked = await nativeWork(ctx, p, run, x, "CHECKER", { problem: p.problem, candidate: produced.value });
    const checkerRef = await artifact(ctx, run.id, "CHECK", checked.value);
    await append(ctx, run.id, "INDEPENDENT_CHECK_RETURNED", { ref: checkerRef, nativeReceipt: checked.receipt, status: checked.value.status });
    if (checked.value.status !== "ACCEPTED" || checked.value.inputDigest !== hash(p.problem) ||
        checked.value.candidateDigest !== hash(produced.value) || checked.value.planDigest !== hash(produced.value.plan))
      throw Error("R4_INDEPENDENT_CHECK_REJECTED");
    await currentOwners(ctx, p);
    const unresolved = produced.value.plan.minimality.status !== "PROVED";
    const status = unresolved
      ? !produced.value.plan.selected && produced.value.plan.pairs.some((pair: { data: string }) => pair.data === "UNSUPPORTED")
        ? "UNSUPPORTED" : "INCOMPLETE"
      : "COMPLETE";
    const gap = status === "UNSUPPORTED" ? "R4_AVAILABLE_PROBLEM_UNSUPPORTED"
      : status === "INCOMPLETE" ? "R4_UNRESOLVED_CHEAPER_COMPETITOR" : null;
    const body: R4Artifact = {
      schema: "finnor.r4.artifact.v1", id: randomUUID(), revision: 1,
      tenantId: ctx.auth.tenantId, principalId: principal(ctx),
      work: { id: p.workId, revision: p.workInputId, inputDigest: p.workInputDigest },
      profileRef: p.ref, baselineManifest: p.problem.baseline,
      producer: { codeDigest: p.runtime.digest, lockDigest: p.runtime.files.find(f => f.path.endsWith("requirements.lock"))?.sha256,
        method: produced.value.method, admission: null },
      ownerInputs: p.ownerBinding, domain: p.problem.profile, assumptions: produced.value.plan.assumptions,
      claims: { candidateRef, checkerRef, basis: "MODEL_RELATIVE_EXACT", graphTruthEstablished: false, fieldIdentified: false },
      checker: checked.value, plan: produced.value.plan,
      gaps: [...(gap ? [gap, ...produced.value.plan.minimality.unresolvedMasks.map((mask: number) => "R4_UNRESOLVED_MASK_" + mask)] : []),
        "PROTECTED_S3_GRAPH_DATA_SUPPORT_DOMAIN_UNQUALIFIED", "S8_ADMISSION_UNAVAILABLE",
        "ACTUAL_PROSPECTIVE_COLLECTION_NOT_OBSERVED", "COMPLETE_DOLLAR_AND_AGGREGATE_CONTAINER_METERS_UNAVAILABLE"],
      resources: { ...await costs(ctx, run.id), originalGrant: p.ownerBinding.S5.allocationRef, originalEpisode: run.episode_id },
      invalidationDependencies: p.dependencies, lifecycle: "development-verified", scientificAdmission: null, active: false,
    };
    await tx(ctx, async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + ctx.auth.tenantId]);
      const locked = await runRow(ctx, run.id, c, true);
      if (locked.status !== "RUNNING" || locked.generation !== run.generation || locked.claim_token !== x.claimToken)
        throw Error("R4_PUBLICATION_RUN_FENCED");
      await currentLocal(ctx, p, c, true);
      const job = (await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE",
        [x.jobId, ctx.auth.tenantId, x.claimToken, x.claimFence])).rows[0];
      if (!job) throw Error("R4_PUBLICATION_QUEUE_FENCED");
      const reservation = (await c.query("SELECT status,revocation_reason FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2 FOR SHARE",
        [ctx.auth.tenantId, p.ownerBinding.S5.allocationRef.contentDigest])).rows[0];
      if (!reservation || reservation.status === "RELEASED" || reservation.revocation_reason) throw Error("R4_PUBLICATION_S5_FENCED");
      const episode = (await c.query("SELECT deadline_at>clock_timestamp() current FROM finnor_os.r4_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE",
        [ctx.auth.tenantId, principal(ctx), run.episode_id])).rows[0];
      if (!episode?.current) throw Error("R4_PUBLICATION_ORIGINAL_DEADLINE_EXHAUSTED");
      const ref = await artifact(ctx, run.id, "PLAN", body, c);
      await c.query("UPDATE finnor_os.r4_runs SET status=$5,head_id=$4,failure=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.auth.tenantId, principal(ctx), run.id, ref.id, status, gap]);
      await append(ctx, run.id, "DEVELOPMENT_VERIFIED", { artifactRef: ref, originalEpisode: run.episode_id,
        checkedMasks: checked.value.checks.masks, checkedPairs: checked.value.checks.pairs, status,
        minimumProved: !unresolved, currentRecommendationGranted: status === "COMPLETE" && Boolean(produced.value.plan.selected),
        admission: null, activationGranted: false }, c);
    });
    if (gap) await retainFallback(ctx, p, run, gap);
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const predicate = /^[A-Z][A-Z0-9_]{0,180}$/.test(raw) ? raw : "R4_OWNER_NATIVE_OR_CHECK_BOUNDARY_UNPASSED";
    await tx(ctx, async c => {
      const locked = await runRow(ctx, run.id, c, true);
      if (locked.status === "QUEUED" && locked.generation === data.generation) {
        await c.query("UPDATE finnor_os.r4_runs SET status='INVALIDATED',generation=generation+1,failure=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [ctx.auth.tenantId, principal(ctx), run.id, predicate]);
      }
      if (locked.status === "RUNNING" && locked.claim_token === x.claimToken) {
        const status = predicate.includes("UNSUPPORTED") ? "UNSUPPORTED" : predicate.includes("EXHAUSTED") ? "INCOMPLETE" : "UNKNOWN";
        await c.query("UPDATE finnor_os.r4_runs SET status=$4,failure=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [ctx.auth.tenantId, principal(ctx), run.id, status, predicate]);
      }
      await append(ctx, run.id, "FAILED_RETAINED", { predicate, originalEpisode: run.episode_id,
        costUSD: null, physicalRetryGranted: false }, c);
    });
    await retainFallback(ctx, p, run, predicate);
  }
}
