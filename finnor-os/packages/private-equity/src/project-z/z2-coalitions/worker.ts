import { acquireComputeResourceLeases, renewComputeResourceLeases, releaseComputeResourceLeases,
  type ComputeResourceLease } from "@finnor/db";
import type { PoolClient } from "pg";
import type { JobExecutionContext, JobQueue, JobHandlerContract } from "../../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../../types";
import { withS5PortfolioTransaction as transaction } from "../../allocation-store";
import { constructInteractionProtocolJob } from "../../interaction-synthesis/worker";
import { independentlyCheck } from "../../interaction-synthesis/process";
import { productRuntimeIdentity } from "../../interaction-synthesis/product-runtime";
import { Y3_VERSION, PROFILE_DIGEST, digest, fail, type Check } from "../../interaction-synthesis/contracts";
import { JobSchema, LIMITS, reference, type InteractionJob, type ProtocolRow,
  type InteractionProtocol } from "../../interaction-synthesis/product-contracts";
import { developmentOnly, protocolTx, currentChangesTx, invalidateTx, eventTx, dependencyGraph } from "../../interaction-synthesis/store";
import { constructCoalitions, independentlyCheckCoalitions } from "../../../../epistemic-runtime/src/project-z/z2-coalitions/process";
import { Z2_VERSION, Z2_PRODUCT_LOCK, LIMITS as Z2_LIMITS, type CoalitionCheck,
  type CoalitionConstruction } from "../../../../epistemic-runtime/src/project-z/z2-coalitions/contracts";
import { coalitionProductRuntime } from "./runtime";
import { coalitionMarkerTx, coalitionChangesTx, type CoalitionMarker } from "./guard";
import type { CoalitionCheckpoint, CoalitionResilientProtocol, NativeCoalitionArtifact } from "./contracts";

/** Restrict an explicitly owned replay worker, never relax native authority. */
export function z2ReplayWorkerMode() {
  if (process.env.FINNOR_Z2_DISPOSABLE_REPLAY_WORKER === undefined) return false;
  developmentOnly();
  if (process.env.FINNOR_Z2_DISPOSABLE_REPLAY_WORKER !== "1" ||
    process.env.FINNOR_Z2_EXCLUSIVE_REPLAY_DATABASE !== "1" ||
    process.env.NODE_ENV !== "test" || process.env.PORT || process.env.FINNOR_WORKLOAD_CLASS ||
    Object.hasOwn(process.env, "AUTH_DEV_BYPASS") || process.env.SECRETS_PROVIDER !== "env" ||
    !/^[a-f0-9-]{36}$/.test(process.env.FINNOR_Z2_REPLAY_TENANT_ID ?? ""))
    fail("Z2_EXCLUSIVE_DISPOSABLE_REPLAY_WORKER_REQUIRED", 403);
  const works: unknown = JSON.parse(process.env.FINNOR_Z2_REPLAY_WORK_IDS ?? "null");
  if (!Array.isArray(works) || !works.length || works.length > 256 ||
    works.some(v => typeof v !== "string" || !/^[a-f0-9-]{36}$/.test(v)) ||
    new Set(works).size !== works.length) fail("Z2_EXACT_REPLAY_WORK_SET_REQUIRED", 403);
  return true;
}
export function configureZ2ReplayWorker(queue: JobQueue, contract: JobHandlerContract) {
  if (!z2ReplayWorkerMode()) return false;
  queue.register("construct_interaction_protocol_v1", dispatchInteractionProtocolJob, contract);
  return true;
}

async function physical(c: PoolClient, p: InteractionJob, e: Readonly<JobExecutionContext>, leases: ComputeResourceLease[]) {
  const live = await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d
    ON d.tenant_id=j.tenant_id AND d.job_id=j.id WHERE j.id=$1 AND j.tenant_id=$2
    AND j.type='construct_interaction_protocol_v1' AND j.status='running' AND j.payload=$3::jsonb
    AND j.claim_token=$4 AND j.claim_fence=$5 AND j.lease_expires_at>clock_timestamp()
    AND d.id=$6 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence
    AND d.finished_at IS NULL FOR SHARE OF j,d`,
    [e.jobId, p.tenantId, JSON.stringify(p), e.claimToken, e.claimFence, e.deliveryAttemptId]);
  if (live.rowCount !== 1) fail("Z2_PHYSICAL_DELIVERY_FENCE");
  for (const lease of leases) {
    const liveLease = await c.query(`SELECT resource_key FROM finnor_os.compute_resource_leases
      WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL
      AND expires_at>clock_timestamp() FOR SHARE`, [lease.resourceKey, lease.token, lease.fence, lease.ownerId]);
    if (liveLease.rowCount !== 1) fail("Z2_PHYSICAL_COMPUTE_FENCE");
  }
}

/** Explicit disposable-only physical recovery equipment. Normal deliveries
 * never pause. The committed event makes a same-build restart skip this pause. */
async function recoveryBoundary(ctx: PeMutationContext, row: ProtocolRow, e: Readonly<JobExecutionContext>,
  boundary: "CLAIM" | "CHECKPOINT" | "ARTIFACT") {
  if (process.env.FINNOR_Z2_ENABLE_PHYSICAL_RECOVERY !== "1") return;
  developmentOnly();
  if (process.env.FINNOR_Z2_RECOVERY_WORK_ID !== row.work_id ||
    process.env.FINNOR_Z2_RECOVERY_BOUNDARY !== boundary) return;
  const nonce = process.env.FINNOR_Z2_RECOVERY_NONCE;
  if (!nonce || !/^[a-f0-9]{64}$/.test(nonce)) fail("Z2_EXPLICIT_RECOVERY_NONCE_REQUIRED");
  const stop = await transaction(ctx, async c => {
    await physical(c, JobSchema.parse({ tenantId: row.tenant_id, principalId: row.principal_id,
      protocolId: row.id, generation: row.generation }), e, []);
    const key = "z2-recovery:"+boundary+":"+digest(nonce);
    if ((await c.query("SELECT 1 FROM finnor_os.y3_events WHERE tenant_id=$1 AND protocol_id=$2 AND event_key=$3",
      [row.tenant_id, row.id, key])).rowCount) return false;
    await eventTx(c, row, "Z2_PHYSICAL_RECOVERY_BOUNDARY", key, {
      boundary, nonceDigest: digest(nonce), jobId: e.jobId, deliveryAttemptId: e.deliveryAttemptId,
      claimFence: e.claimFence, originalWorkId: row.work_id, originalEpisodeId: row.episode_id,
      originalDeadline: row.deadline_at.toISOString(), responsibilityRetained: true,
      hardKillCostTail: "UNKNOWN", executionAuthorityGranted: false });
    return true;
  });
  if (stop) process.kill(process.pid, "SIGSTOP");
}

/** Additive dispatch on the existing registered native job type; no new queue. */
export async function dispatchInteractionProtocolJob(raw: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  developmentOnly();
  const p = JobSchema.parse(raw), ctx: PeMutationContext = {
    auth: { tenantId: p.tenantId, userId: p.principalId, employeeId: p.principalId, role: "owner" }
  };
  if (!execution || execution.tenantId !== p.tenantId || execution.protocolVersion !== 1)
    fail("Z2_PHYSICAL_EXECUTION_REQUIRED");
  const { marker, row } = await transaction(ctx, async c => {
    const row = await protocolTx(ctx, c, p.protocolId);
    await physical(c, p, execution, []);
    if (z2ReplayWorkerMode() && (p.tenantId !== process.env.FINNOR_Z2_REPLAY_TENANT_ID ||
      !(JSON.parse(process.env.FINNOR_Z2_REPLAY_WORK_IDS!) as string[]).includes(row.work_id)))
      fail("Z2_ORIGINAL_REPLAY_DELIVERY_SCOPE", 403);
    return { row, marker: await coalitionMarkerTx(c, row) };
  });
  if (!marker) return constructInteractionProtocolJob(raw, execution);
  return constructCoalitionProtocolJob(p, ctx, execution, marker, row);
}

async function constructCoalitionProtocolJob(
  p: InteractionJob, ctx: PeMutationContext, e: Readonly<JobExecutionContext>, marker: CoalitionMarker,
  costRow: ProtocolRow
) {
  const started = performance.now(), cpu = process.cpuUsage(), abort = new AbortController();
  let leases: ComputeResourceLease[] = [], original: ProtocolRow | undefined,
    nativeCheck: Check | undefined, coalitionCheck: CoalitionCheck | undefined,
    producerMeters: CoalitionConstruction["meters"], registered = false, disposition = "UNKNOWN";

  async function owned(c: PoolClient, allowOwnPublication = false) {
    const row = await protocolTx(ctx, c, p.protocolId);
    await physical(c, p, e, leases);
    if (row.generation !== p.generation || row.cancelled || ["INVALIDATED", "CANCELLED"].includes(row.status))
      return null;
    if (row.artifact) {
      if (!allowOwnPublication) return null;
      const receipt = await c.query(`SELECT id FROM finnor_os.y3_events WHERE tenant_id=$1 AND protocol_id=$2
        AND kind='Z2_DURABLE_ARTIFACT' AND event_key='z2-published' AND body->>'deliveryAttemptId'=$3
        AND body->>'jobId'=$4 AND body->>'claimFence'=$5::text FOR SHARE`,
        [row.tenant_id, row.id, e.deliveryAttemptId, e.jobId, e.claimFence]);
      if (receipt.rowCount !== 1) return null;
    }
    const changes = [...await currentChangesTx(ctx, c, row), ...await coalitionChangesTx(c, row)];
    if (changes.length) { await invalidateTx(c, row, changes); return null; }
    const currentMarker = await coalitionMarkerTx(c, row);
    if (!currentMarker || digest(currentMarker) !== digest(marker)) fail("Z2_ORIGINAL_MARKER_CHANGED");
    return row;
  }
  async function heartbeat() {
    try {
      if (!await renewComputeResourceLeases(leases)) { abort.abort(); return false; }
      const live = await transaction(ctx, async c => !!await owned(c, true));
      if (!live) abort.abort();
      return live;
    } catch { abort.abort(); return false; }
  }
  function checkpoint(construction: CoalitionConstruction): CoalitionCheckpoint {
    return {
      status: construction.status === "CANDIDATE" ? "CANDIDATE" :
        construction.status === "CHECKED_INFEASIBLE" ? "INFEASIBLE" : construction.status,
      candidate: construction.candidate, reasons: [construction.reason, "Z2_ADDITIONAL_COALITION_PREDICATE"],
      search: { ...construction.search, steps: construction.search.steps ?? 0, policies: construction.search.policies ?? 0,
        profiles: construction.search.profiles ?? 0, complete: construction.search.complete },
      z2: { construction, runtimeDigest: marker.runtime.semanticDigest }
    };
  }
  try {
    if (!await transaction(ctx, c => owned(c))) return;
    leases = await acquireComputeResourceLeases({ tenantId: p.tenantId, resourceKeys: ["native:y3-construction"],
      requiredResourceKeys: ["native:y3-construction"], workloadClass: "INTERACTIVE", ownerId: "z2:"+e.deliveryAttemptId });
    e.registerHeartbeat(heartbeat);
    original = await transaction(ctx, async c => {
      const row = await owned(c);
      if (!row) return undefined;
      if (row.attempts_used >= LIMITS.maxAttempts) {
        await c.query("UPDATE finnor_os.y3_requests SET status='INCOMPLETE' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
        await eventTx(c, row, "Z2_ATTEMPT_NOT_STARTED", "z2-exhausted:"+e.deliveryAttemptId,
          { originalEpisodeId: row.episode_id, predicate: "Z2_ORIGINAL_ATTEMPT_BOUND", newBudget: false });
        disposition = "INCOMPLETE";
        return undefined;
      }
      if (row.candidate && !(row.construction as CoalitionCheckpoint | null)?.z2) fail("Z2_ORIGINAL_CHECKPOINT_REQUIRED");
      await c.query(`UPDATE finnor_os.y3_episodes SET attempts_used=attempts_used+1,search_steps_used=search_steps_used+$3
        WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, row.episode_id, row.candidate ? 0 : LIMITS.maxSearchSteps]);
      await c.query("UPDATE finnor_os.y3_requests SET status=$3 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id, row.candidate ? "CHECKING" : "CONSTRUCTING"]);
      await eventTx(c, row, "Z2_DURABLE_CLAIM", "z2-claim:"+e.deliveryAttemptId, {
        jobId: e.jobId, claimFence: e.claimFence, deliveryAttemptId: e.deliveryAttemptId,
        originalEpisodeId: row.episode_id, originalDeadline: row.deadline_at, checkpointReused: !!row.candidate,
        searchOccupation: row.candidate ? 0 : LIMITS.maxSearchSteps, occupationIsNotBilling: true,
        hardKillCostTail: "UNKNOWN_UNLESS_TERMINAL_COST_RECORDED"
      });
      registered = true;
      return protocolTx(ctx, c, row.id);
    });
    if (!original) return;
    await recoveryBoundary(ctx, original, e, "CLAIM");
    const nativeRuntime = await productRuntimeIdentity(), z2Runtime = await coalitionProductRuntime();
    if (nativeRuntime.semanticDigest !== original.runtime.semanticDigest || z2Runtime.semanticDigest !== marker.runtime.semanticDigest)
      fail("Z2_RUNTIME_CHANGED_AT_CLAIM");
    const prior = original.construction as CoalitionCheckpoint | null,
      construction = original.candidate && prior?.z2 ? prior.z2.construction :
        await constructCoalitions(original.request.problem, original.deadline_at.getTime(), z2Runtime.math, abort.signal);
    if (!original.candidate) producerMeters = construction.meters;
    if (prior?.z2 && original.candidate && (prior.z2.runtimeDigest !== marker.runtime.semanticDigest ||
      digest(construction.candidate) !== digest(original.candidate))) fail("Z2_CHECKPOINT_BINDING");
    if (original.candidate) await transaction(ctx, async c => {
      const row = await owned(c);
      if (!row) fail("Z2_CHECKPOINT_FENCED");
      const saved = (await c.query<{ body: { candidateDigest: string; constructionDigest: string; originalEpisodeId: string } }>(
        `SELECT body FROM finnor_os.y3_events WHERE tenant_id=$1 AND protocol_id=$2
          AND kind='Z2_CANDIDATE_CHECKPOINT' AND event_key=$3 FOR SHARE`,
        [row.tenant_id, row.id, "z2-candidate:"+digest(row.candidate)])).rows[0]?.body;
      if (!saved || saved.candidateDigest !== digest(row.candidate) || saved.constructionDigest !== digest(construction) ||
        saved.originalEpisodeId !== row.episode_id) fail("Z2_IMMUTABLE_CHECKPOINT_PREIMAGE");
    });
    if (!original.candidate && construction.candidate) await transaction(ctx, async c => {
      const row = await owned(c);
      if (!row) fail("Z2_CHECKPOINT_FENCED");
      await c.query(`UPDATE finnor_os.y3_requests SET candidate=$3::jsonb,construction=$4::jsonb,status='CHECKING'
        WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, JSON.stringify(construction.candidate), JSON.stringify(checkpoint(construction))]);
      await eventTx(c, row, "Z2_CANDIDATE_CHECKPOINT", "z2-candidate:"+digest(construction.candidate),
        { candidateDigest: digest(construction.candidate), constructionDigest: digest(construction),
          originalEpisodeId: row.episode_id, protectedAdmission: false, executionAuthorityGranted: false });
    });
    if (construction.candidate) await recoveryBoundary(ctx, original, e, "CHECKPOINT");
    if (construction.status === "CANDIDATE" || construction.status === "CHECKED_INFEASIBLE") {
      if (!await heartbeat()) fail("Z2_CHECK_DISPATCH_FENCED");
      if (construction.candidate) {
        nativeCheck = await independentlyCheck(original.request.problem, construction.candidate,
          original.deadline_at.getTime(), nativeRuntime.math, abort.signal);
        if (nativeCheck.status !== "CHECKED") fail("Z2_FRESH_NATIVE_FULL_Y3_CHECK_REQUIRED");
      }
      coalitionCheck = await independentlyCheckCoalitions(original.request.problem, construction,
        original.deadline_at.getTime(), z2Runtime.math, abort.signal);
    }
    const accepted = coalitionCheck?.status === "CHECKED_CANDIDATE",
      impossible = coalitionCheck?.status === "CHECKED_INFEASIBLE";
    disposition = accepted ? "CHECKED" : impossible ? "INFEASIBLE" : construction.status === "UNSUPPORTED" ? "UNSUPPORTED" : "INCOMPLETE";
    await transaction(ctx, async c => {
      const row = await owned(c);
      if (!row) fail("Z2_PUBLICATION_FENCED");
      const legacy = checkpoint(construction);
      if (!accepted && !impossible) {
        await c.query("UPDATE finnor_os.y3_requests SET status=$3,construction=$4::jsonb WHERE tenant_id=$1 AND id=$2",
          [row.tenant_id, row.id, disposition, JSON.stringify(legacy)]);
        await eventTx(c, row, "Z2_ATTEMPT_CHECK", "z2-check:"+e.deliveryAttemptId, {
          status: disposition, check: coalitionCheck ?? null, producerReason: construction.reason,
          originalEpisodeId: row.episode_id, checkpointRetained: !!construction.candidate
        });
        return;
      }
      const body = construction.candidate, usage = process.cpuUsage(cpu);
      const envelope: InteractionProtocol["envelope"] = {
        schema: "finnor.postx-artifact-envelope.v1", artifactKind: "InteractionProtocol", id: row.id,
        tenantId: row.tenant_id, principalId: row.principal_id,
        contentRef: reference("Y3", "interaction-protocol", { problem: row.request.problem, body }), parents: [],
        work: { id: row.work_id, inputId: row.work_input_id, inputDigest: row.work_input_digest },
        goal: { id: row.request.problem.id, digest: digest(row.request.problem.goal) },
        validityDomain: { profileDigest: PROFILE_DIGEST, problemDigest: digest(row.request.problem),
          validUntil: row.deadline_at.toISOString(), finiteOnly: true },
        provenance: { producerVersion: Y3_VERSION, runtime: row.runtime, executionRuntime: nativeRuntime.math,
          profileFrozenBeforeEvaluation: true, governingOriginalSourceParity: "UNKNOWN" },
        sourceBindings: row.request.sources, rights: { revision: row.rights_revision, principalId: row.principal_id },
        dependencies: [...dependencyGraph(row.request), { id: "z2-runtime", dependsOn: [], digest: z2Runtime.digest },
          { id: "z2-coalitions", dependsOn: ["independent-check", "z2-runtime"], digest: digest(construction) }],
        independentChecks: nativeCheck ? [nativeCheck] : [],
        resourceEnvelope: { episodeId: row.episode_id, deadlineAt: row.deadline_at.toISOString(),
          maxAttempts: LIMITS.maxAttempts, attemptsUsed: row.attempts_used,
          searchStepsOccupied: row.search_steps_used, retainedBytes: row.retained_bytes },
        admission: { domain: "INTERACTION_PROTOCOL", status: "UNADMITTED", protectedAdmission: false, executionAuthorityGranted: false },
        lowering: { ownerInterfaces: ["S1", "S4", "S5", "S6", "S7", "S8", "P7"], adapter: "S5_RESERVATION_RIGHT_TRANSITION_V1",
          fixedY1TheoryRef: row.request.lowering.theoryRef, externalEffectsSupported: false },
        recovery: { originalEpisodeRetained: true, unknownEffectsRetained: true,
          replayIdentity: "ORIGINAL_REQUEST_TERMS_AND_NATIVE_EFFECT" },
        comparison: { classification: "CONSTRUCTED_DEVELOPMENT_UNQUALIFIED", protectedNoveltyEstablished: false,
          equippedBaseline: "UNESTABLISHED" },
        costs: { wallMs: performance.now()-started,
          cpuMs: (usage.user+usage.system)/1000+(producerMeters?.cpuMs ?? 0)+
            (coalitionCheck?.meters?.cpuMs ?? 0)+(nativeCheck?.cpuMs ?? 0),
          peakProcessRssBytes: process.resourceUsage().maxRSS*1024, moneyUsd: null, humanSeconds: null,
          aggregatePeakMemoryBytes: null, status: "PARTIALLY_METERED", failedAttemptsRetained: true },
        status: disposition, qualifications: [
          "FULL_NATIVE_Y3_PLUS_EX_ANTE_CORRELATED_COALITION_PREDICATE", "SUPPLIED_MODELS_NOT_FIELD_COMPLIANCE",
          "NO_INTERIM_OR_ARBITRARY_LATER_COALITION_GUARANTEE", "Z2_FAMILY_INFEASIBILITY_NOT_Y3_ONLY_NONEXISTENCE",
          "NO_PROTECTED_ADMISSION_OR_EXECUTION_AUTHORITY", "PARTICIPANT_LOCAL_NATIVE_TERMS_CONSENTS_REMAIN_REQUIRED"
        ], createdAt: new Date().toISOString()
      };
      const principalBody: Omit<CoalitionResilientProtocol, "ref"> = {
        schema: "finnor.coalition-resilient-protocol.v1", nativeProtocolId: row.id, nativeProtocolRef: envelope.contentRef,
        productLockDigest: Z2_PRODUCT_LOCK, originalRequestDigest: row.request_digest,
        problemDigest: digest(row.request.problem), candidateDigest: body ? digest(body) : null, runtime: z2Runtime,
        original: { tenantId: row.tenant_id, principalId: row.principal_id, workId: row.work_id,
          workInputId: row.work_input_id, workInputDigest: row.work_input_digest, root: row.root, episodeId: row.episode_id,
          deadlineAt: row.deadline_at.toISOString(), rightsRevision: row.rights_revision, attemptsUsed: row.attempts_used,
          searchStepsOccupied: row.search_steps_used, retainedBytes: row.retained_bytes },
        incentiveConcept: Z2_LIMITS.concept, coalitionLimit: Z2_LIMITS.coalitionLimit,
        excludedThreatClasses: [...Z2_LIMITS.excluded],
        construction, check: coalitionCheck!, nativeOwnerContract: "INTERACTION_PROTOCOL_S4_EXACT_TERMS_CONSENT_S5_S6_V1",
        qualification: { protectedAdmission: false, productionActivated: false, equippedIncrement: "NOT_RUN",
          operational100x: "NOT_RUN", financial100x: "NOT_RUN", actualCompliance: "UNKNOWN" },
        gaps: ["PROTECTED_MODEL_IDENTIFICATION_NOT_ESTABLISHED",
          "MANDATE_ASSIGNMENT_PARENT_RESERVATION_AND_REMAINING_BUDGET_REQUIRE_NATIVE_OWNER_PROOF",
          "AGGREGATE_MEMORY_MONEY_HUMAN_AND_S7_ATTRIBUTION_NOT_FULLY_METERED",
          "AUTHENTICATED_INSTALLED_MOUNT_AND_PHYSICAL_RECOVERY_REQUIRE_SEPARATE_EVIDENCE"]
      }, ref = { owner: "Z2", id: "coalition:"+digest(principalBody), version: Z2_VERSION, contentDigest: digest(principalBody) };
      const artifact: NativeCoalitionArtifact = {
        schema: "finnor.interaction-protocol.v1", problem: row.request.problem, body, construction: legacy, envelope,
        coalition: { ...principalBody, ref }
      };
      if (Buffer.byteLength(JSON.stringify(artifact)) > Z2_LIMITS.maxArtifactBytes) fail("Z2_NATIVE_ARTIFACT_BYTE_BOUND");
      await c.query(`UPDATE finnor_os.y3_requests SET status=$3,construction=$4::jsonb,artifact=$5::jsonb
        WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, disposition, JSON.stringify(legacy), JSON.stringify(artifact)]);
      await eventTx(c, row, "Z2_DURABLE_ARTIFACT", "z2-published", {
        status: coalitionCheck!.status, nativeRef: envelope.contentRef, coalitionRef: ref,
        constructionDigest: digest(construction), checkDigest: digest(coalitionCheck),
        jobId: e.jobId, deliveryAttemptId: e.deliveryAttemptId, claimFence: e.claimFence,
        originalEpisodeId: row.episode_id, originalDeadline: row.deadline_at, executionAuthorityGranted: false
      });
    });
    if (accepted || impossible) await recoveryBoundary(ctx, original, e, "ARTIFACT");
  } catch (error) {
    disposition = error instanceof Error && /^Z2_[A-Z0-9_]+$/.test(error.message) ? error.message : "Z2_NATIVE_FAILURE";
    await transaction(ctx, async c => {
      await eventTx(c, costRow, "Z2_NATIVE_FAILURE", "z2-failure:"+e.deliveryAttemptId, {
        predicate: disposition, originalEpisodeId: costRow.episode_id, constructionAttemptReserved: registered,
        checkpointRetained: true, unknownEffectsRetained: true
      });
      if (original) await c.query(`UPDATE finnor_os.y3_requests SET status='UNKNOWN' WHERE tenant_id=$1 AND id=$2 AND generation=$3
        AND NOT cancelled AND artifact IS NULL AND status IN('CONSTRUCTING','CHECKING')
        AND EXISTS(SELECT 1 FROM finnor_os.jobs WHERE id=$4 AND claim_token=$5 AND claim_fence=$6
          AND lease_expires_at>clock_timestamp())`,
        [p.tenantId, p.protocolId, p.generation, e.jobId, e.claimToken, e.claimFence]);
    });
    throw error;
  } finally {
    abort.abort();
    try {
      await transaction(ctx, async c => {
        const usage = process.cpuUsage(cpu);
        await eventTx(c, costRow, "Z2_COST", "z2-cost:"+e.deliveryAttemptId, {
          disposition, originalEpisodeId: costRow.episode_id, deliveryAttemptId: e.deliveryAttemptId,
          constructionAttemptReserved: registered, dispatcherOverheadIncluded: false, meterStatus: "PARTIALLY_METERED",
          wallMs: performance.now()-started, nodeCpuMs: (usage.user+usage.system)/1000,
          producer: producerMeters ?? null, priorCheckpointProducerCostNotBilledAgain: !!original?.candidate,
          nativeChecker: nativeCheck ? { cpuMs: nativeCheck.cpuMs, peakRssBytes: nativeCheck.peakRssBytes } : null,
          coalitionChecker: coalitionCheck?.meters ?? null, moneyUsd: null, humanSeconds: null,
          aggregatePeakMemoryBytes: null, failedAttemptsRetained: true, hardKillTail: "UNKNOWN_IF_NO_TERMINAL_RECEIPT"
        });
      });
    } finally { await releaseComputeResourceLeases(leases, "z2_native_delivery_finished"); }
  }
}
