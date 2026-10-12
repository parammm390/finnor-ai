import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { employeeAuthoritySnapshot } from "@finnor/authority";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { codeIdentity, principal, sha, stable, tx } from "../evidence-execution/store";
import { safePredicate } from "../program-synthesis/store";
import { submitInstitutionHarnessProgram } from "../program-synthesis/institution";
import { reserveInstitutionDemand, chargeInstitutionDemand, validateInstitutionDemand } from "../allocation-store";
import { buildInstitutionResourceDemand } from "./resource-demand";
import { reconstructAndAdmitInstitutionSources } from "./owner-admission";
import { readInstitutionMandate } from "./source-authority";
import { deriveInstitutionResponsibilities } from "./responsibility";
import { resolveInstitutionActions } from "./action-resolution";
import { buildInstitutionArtifact } from "./artifact";
import { withInstitutionMeter, persistInstitutionCompute } from "./meter";
import { observedInstitutionBaseline } from './baseline';
import type { Binding } from './contracts';
import { buildInstitutionDependencyGraph, compareInstitutionDependencies,
  type InstitutionDependencyGraph } from "../live-recompilation/institution-dependencies";
import { assertInstitutionCompilerCurrent, compilerEpisode, compilerEvent, compilerRow,
  loadInstitutionProfile, type CompilerRequestRow } from "./store";

async function liveClaim(ctx: PeMutationContext, q: CompilerRequestRow, execution: Readonly<JobExecutionContext>, c: import("pg").PoolClient) {
  const request = await compilerRow(ctx, q.id, c, true);
  const job = (await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
    AND type='run_x1_institution_compiler_v1' AND protocol_version=1 AND status='running'
    AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
  [q.tenant_id, execution.jobId, execution.claimToken, execution.claimFence])).rows[0];
  if (!job || request.generation !== q.generation || request.status === "CANCELLED"
      || (request.status === "RUNNING" && request.claim_token !== execution.claimToken
        && execution.claimFence <= Number(request.claim_fence)))
    throw Error("X1_COMPILER_PHYSICAL_CLAIM_FENCED");
  return request;
}

/** Registered actual worker entry. FINNOR performs reconstruction/checking and
 * native programme submission; Factory and callers provide no mappings. */
export async function runInstitutionCompilerJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  if (!execution || execution.protocolVersion !== 1 || execution.retrySafety !== "reconcilable"
      || typeof payload.tenantId !== "string" || typeof payload.principalId !== "string"
      || typeof payload.requestId !== "string" || payload.tenantId !== execution.tenantId)
    throw Error("X1_ACTUAL_COMPILER_JOB_REQUIRED");
  const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId,
    employeeId: payload.principalId, role: "owner" },
    provenance: { sourceSystem: "X1:institution-compiler", createdBy: payload.principalId } };
  let q = await compilerRow(ctx, payload.requestId);
  if (q.generation !== payload.generation || ["WAITING", "PARTIAL", "OBSERVED", "CHECK_REJECTED", "CANCELLED", "INVALIDATED"].includes(q.status)) return;
  const profile = loadInstitutionProfile(), started = performance.now(), startedAt = new Date().toISOString();
  let sourceAttempts=0,checkerAttempts=0;
  await assertInstitutionCompilerCurrent(ctx, q);
  q = await tx(ctx, async c => {
    const current = await liveClaim(ctx, q, execution, c), episode = await compilerEpisode(ctx, q.episode_id, c, true);
    if (Date.now() >= episode.wall_deadline.getTime() || episode.attempts >= 4) throw Error("X1_ORIGINAL_COMPILER_ENVELOPE_EXHAUSTED");
    await c.query("UPDATE finnor_os.x1_compiler_episodes SET attempts=attempts+1 WHERE tenant_id=$1 AND id=$2",
      [q.tenant_id, q.episode_id]);
    await c.query(`UPDATE finnor_os.x1_compiler_requests SET status='RUNNING',claim_token=$4,claim_fence=$5,
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [q.tenant_id, q.principal_id, q.id, execution.claimToken, execution.claimFence]);
    await compilerEvent(ctx, current, "COMPILER_PHYSICAL_DELIVERY_STARTED", { jobId: execution.jobId,
      deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
      originalEpisode: q.episode_id, parentReservation: episode.parent_reservation,
      costs: { usd: null, aggregateMemory: null } }, c);
    return { ...current, status: "RUNNING", claim_token: execution.claimToken, claim_fence: execution.claimFence };
  });
  try {
    let episode = await compilerEpisode(ctx, q.episode_id);
    if (!episode.parent_reservation || !episode.parent_demand) {
      const mandate = await readInstitutionMandate(ctx, q.work_id), rights = await employeeAuthoritySnapshot(ctx.auth);
      const demand = buildInstitutionResourceDemand({ tenantId: q.tenant_id, workId: q.work_id,
        principalId: q.principal_id, institutionId: mandate.institutionId,
        programmeDigest: sha(["x1-original-work-envelope-v1", episode.id, episode.profile_digest]),
        responsibilityIdentities: [`x1-compiler-episode:${episode.id}`],
        computeRequests: profile.bounds.authorizedAcquisitionCalls + profile.bounds.derivedObligations * 3 + 8,
        humanSeconds: profile.bounds.episodeHumanSeconds, originalDeadline: episode.original_deadline.toISOString(),
        chargeScope: { kind: "ORIGINAL_WORK_EPISODE", episodeId: episode.id }, profile });
      await tx(ctx, async c => {
        await liveClaim(ctx, q, execution, c);
        const parent = await compilerEpisode(ctx, q.episode_id, c, true);
        // Cancellation waits for this request lock. The owner reservation and
        // its durable parent binding must become visible together to control.
        const reservation = await reserveInstitutionDemand(ctx, demand, String(rights.revision));
        if (parent.parent_reservation && sha(parent.parent_reservation) !== sha(reservation.reservation.ref))
          throw Error("X1_ORIGINAL_PARENT_RESERVATION_CONFLICT");
        if (!parent.parent_reservation) await c.query(`UPDATE finnor_os.x1_compiler_episodes
          SET parent_reservation=$3::jsonb,parent_demand=$4::jsonb WHERE tenant_id=$1 AND id=$2`,
        [q.tenant_id, q.episode_id, stable(reservation.reservation.ref), stable(demand)]);
      });
      episode = await compilerEpisode(ctx, q.episode_id);
    }
    const parentRef = episode.parent_reservation!, parentDemand = episode.parent_demand!;
    if ((await validateInstitutionDemand(ctx, parentRef)).status !== "CURRENT") throw Error("X1_ORIGINAL_S5_PARENT_NOT_CURRENT");
    await chargeInstitutionDemand(ctx,parentRef,{responsibilityIdentity:`x1-compiler-episode:${episode.id}`,
      phase:"COMPILE",ordinal:episode.attempts,units:1});
    const result = await withInstitutionMeter({
      sourceAttempt: async grantId => {
        if (!q.grant_ids.includes(grantId)) throw Error("X1_METER_SOURCE_OUTSIDE_ORIGINAL_REQUEST");
        const ordinal = await tx(ctx, async c => {
          await liveClaim(ctx, q, execution, c);
          const result = await c.query<{ acquisition_calls: number }>(`UPDATE finnor_os.x1_compiler_episodes
            SET acquisition_calls=acquisition_calls+1 WHERE tenant_id=$1 AND id=$2
            AND acquisition_calls<128 AND wall_deadline>clock_timestamp() RETURNING acquisition_calls`,
          [q.tenant_id, q.episode_id]);
          if (!result.rows[0]) throw Error("X1_ORIGINAL_ACQUISITION_BOUND_EXHAUSTED");
          return result.rows[0].acquisition_calls;
        });
        await chargeInstitutionDemand(ctx, parentRef, { responsibilityIdentity: `x1-compiler-episode:${episode.id}`,
          phase: "ACQUISITION", ordinal, units: 1 });
        sourceAttempts++;
      },
      checkerAttempt: async () => {
        await chargeInstitutionDemand(ctx, parentRef, { responsibilityIdentity: `x1-compiler-episode:${episode.id}`,
          phase: "CHECK", ordinal: (episode.attempts-1)*2+(++checkerAttempts), units: 1 });
      },
    }, () => reconstructAndAdmitInstitutionSources(ctx, q.work_id, q.grant_ids, profile));
    await assertInstitutionCompilerCurrent(ctx, q, result.original.current);
    const accepted = result.check.disposition === "ACCEPTED_DEVELOPMENT";
    const lowered = accepted ? deriveInstitutionResponsibilities({ ...result, profile,
      admittedCanonicalRefs: result.mappings.map(m => m.canonicalRef),
      authorizedOperations: result.original.current.authorizedOperations }) : null;
    let admissionId: string | null = null;
    if (lowered) {
      admissionId = await tx(ctx, async c => {
        await liveClaim(ctx, q, execution, c);
        await assertInstitutionCompilerCurrent(ctx, q, result.original.current, c, true);
        const admission = (await c.query<{ id: string }>(`SELECT id::text FROM finnor_os.x1_mapping_admissions
          WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND original_digest=$4
          AND candidate_digest=$5 AND checker_digest=$6 AND duty_population_digest=$7
          ORDER BY published_at DESC,id DESC LIMIT 1`, [q.tenant_id, q.principal_id, q.work_id,
          lowered.programme.admission.originalDigest, lowered.programme.admission.candidateDigest,
          lowered.programme.admission.checkerDigest, lowered.programme.dutyPopulationDigest])).rows[0];
        if (!admission) throw Error("X1_ACTUAL_MAPPING_ADMISSION_REQUIRED");
        await c.query("SELECT finnor_os.x1_publish_checked_artifact($1,$2::jsonb,$3::jsonb,$4,$5::jsonb,$6::jsonb)",
          [admission.id, stable(result.candidate), stable(result.check), sha(result.check),
            stable(lowered.responsibilities), stable(lowered.unresolved)]);
        await c.query("UPDATE finnor_os.x1_compiler_requests SET admission_id=$4,input_manifest=$5::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [q.tenant_id, q.principal_id, q.id, admission.id, stable({ current: result.original.current })]);
        return admission.id;
      });
    }
    const resolved = lowered ? await resolveInstitutionActions(ctx, result.original, lowered.responsibilities, profile)
      : { actions: [], gaps: [] };
    const graph = lowered ? buildInstitutionDependencyGraph(result.candidate, lowered.responsibilities, profile)
      : { schema:"finnor.p7.institution-dependencies.v1" as const,nodes:[],edges:[] };
    const previousGraph = q.parent_request_id ? await tx(ctx, async c => (await c.query<{dependency_graph:InstitutionDependencyGraph}>(
      `SELECT a.dependency_graph FROM finnor_os.x1_compiler_artifacts a
       JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=a.tenant_id AND r.artifact_id=a.id
       WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3`,
      [q.tenant_id,q.principal_id,q.parent_request_id])).rows[0]?.dependency_graph??null,true) : null;
    const updatePlan = previousGraph ? compareInstitutionDependencies(previousGraph,graph,profile) : null;
    if (updatePlan) await compilerEvent(ctx,q,"P7_EXACT_AFFECTED_UPDATE",updatePlan);
    if (lowered) await tx(ctx, async c => {
      await liveClaim(ctx, q, execution, c);
      await assertInstitutionCompilerCurrent(ctx, q, result.original.current, c, true);
      await c.query(`UPDATE finnor_os.x1_compiler_requests SET programme_digest=$4,intent_digest=$5
        WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [q.tenant_id, q.principal_id, q.id, sha(lowered.programme), sha(resolved.actions)]);
    });
    let native: { programId: string; workRevision: string } | null = null;
    if (lowered?.responsibilities.length) {
      const rootRef = lowered.responsibilities[0]!.obligation.preconditions[0]!.ref;
      const match = /^pe_deal:([^@]+)@v\d+$/.exec(rootRef);
      if (!match) throw Error("X1_NATIVE_PROGRAMME_ROOT_UNRESOLVED");
      const instruction=await tx(ctx,async c=>(await c.query<{instruction_text:string}>(`SELECT i.instruction_text
        FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
        WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3 AND w.created_by=$4`,
        [q.tenant_id,q.work_id,q.work_input_id,q.principal_id])).rows[0]?.instruction_text??null,true);
      if(!instruction)throw Error("X1_EXACT_NATIVE_WORK_INSTRUCTION_REQUIRED");
      native = await submitInstitutionHarnessProgram(ctx, { schema: "finnor.harness-request.v1",
        kind: "institution_responsibility_v1", instruction,
        root: { entityType: "pe_deal", entityId: match[1]! }, workId: q.work_id, workInputId: q.work_input_id,
        idempotencyKey: `x1-compiler:${q.id}`, validAt: result.original.knowledgeCut, mode: "ordinary_disposable",
        institution: { programme: lowered.programme as any, responsibilities: lowered.responsibilities,
          unresolved: lowered.unresolved, demand: parentDemand, reservationRef: parentRef,
          actions: resolved.actions, compilerRequestId: q.id } });
    }
    const publicationStarted=performance.now(),publicationStartedAt=new Date().toISOString();
    const compute = await persistInstitutionCompute(ctx,{requestId:q.id,workId:q.work_id,episodeId:q.episode_id,
      jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,parentReservation:parentRef,
      rightsRevision:result.original.current.rightsRevision,startedAt,elapsedMs:publicationStarted-started,
      phase:"COMPILE",status:accepted?(native?"CHECKED_AND_NATIVE_SUBMITTED":"CHECKED_WITH_GAPS"):"CHECK_REJECTED",observedAcquisitionAttempts:sourceAttempts,
      observedCheckerAttempts:checkerAttempts});
    const code = await codeIdentity(), artifactId = randomUUID();
    const baseline=await observedInstitutionBaseline(ctx,{compilerId:q.id,workInputId:q.work_input_id,
      episodeId:q.episode_id,original:result.original,profile,producer:code,parentReservation:parentRef});
    const parents:Binding[]=q.parent_request_id?await tx(ctx,async c=>{
      const parent=(await c.query<{id:string;revision:number;body:unknown;body_digest:string}>(`SELECT a.id::text,r.revision,a.body,a.body_digest
        FROM finnor_os.x1_compiler_requests r JOIN finnor_os.x1_compiler_artifacts a
          ON a.tenant_id=r.tenant_id AND a.principal_id=r.principal_id AND a.id=r.artifact_id AND a.request_id=r.id
        WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4 AND r.id=$5`,
        [q.tenant_id,q.principal_id,q.work_id,q.episode_id,q.parent_request_id])).rows[0];
      if(!parent||sha(parent.body)!==parent.body_digest)throw Error('X1_IMMUTABLE_PARENT_ARTIFACT_REQUIRED');
      return [{status:'known',owner:'S4_P1',kind:'immutable_parent_institution_projection',ref:parent.id,
        revision:String(parent.revision),digest:parent.body_digest,tenantRef:q.tenant_id,
        institutionRef:result.original.institutionId,rightsRevision:result.original.current.rightsRevision,
        knowledgeCut:result.original.knowledgeCut}];
    },true):[];
    const artifact = buildInstitutionArtifact({ id: artifactId, revision: String(q.revision),
      workInput:{id:q.work_input_id,digest:q.work_input_digest}, ...result,
      lowered, admissionId, programme: native ? { id: native.programId, revision: native.workRevision,
        digest: sha(lowered!.programme) } : null, reservation: parentRef, producer: code,
      lockDigest: sha(readFileSync(fileURLToPath(new URL("../../../../package-lock.json", import.meta.url)))),
      baseline: {ref:'x1-baseline:'+artifactId,digest:baseline.digest}, parents, costRefs: [{status:"known",owner:"S7",kind:"physical_compute_attribution",
        ref:compute.record.ref.id,revision:compute.record.ref.version,digest:compute.record.ref.contentDigest,
        tenantRef:q.tenant_id,institutionRef:result.original.institutionId,
        rightsRevision:result.original.current.rightsRevision,knowledgeCut:result.original.knowledgeCut}],
      operationGaps: resolved.gaps, incrementalGraph:graph, updatePlan });
    await tx(ctx, async c => {
      await liveClaim(ctx, q, execution, c);
      await assertInstitutionCompilerCurrent(ctx, q, result.original.current, c, true);
      const status = !accepted ? "CHECK_REJECTED" : native ? "WAITING" : "PARTIAL";
      await c.query(`INSERT INTO finnor_os.x1_compiler_artifacts
        (id,tenant_id,principal_id,request_id,generation,candidate,check_result,body,body_digest,input_manifest,dependency_graph)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11::jsonb)`,
      [artifactId, q.tenant_id, q.principal_id, q.id, q.generation, stable(result.candidate), stable(result.check),
        stable(artifact), sha(artifact), stable({ current: result.original.current,baseline:baseline.body,baselineDigest:baseline.digest,
          originalDigest: accepted
          ? (result.check as { inputDigest: string }).inputDigest : null }), stable(graph)]);
      await c.query(`UPDATE finnor_os.x1_compiler_requests SET status=$4,artifact_id=$5,program_id=$6,
        failure=$7,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [q.tenant_id, q.principal_id, q.id, status, artifactId, native?.programId ?? null,
        accepted ? resolved.gaps.length ? "X1_EXACT_OPERATION_INTERPRETATION_REQUIRED" : null : "X1_INDEPENDENT_CHECK_REJECTED"]);
      await compilerEvent(ctx, q, "IMMUTABLE_INSTITUTION_PROGRAM_PUBLISHED", { artifactId, admissionId,
        programId: native?.programId ?? null, check: result.check, status, supportedDuties: resolved.actions.length,
        unresolvedDuties: (lowered?.unresolved.length ?? 0) + resolved.gaps.length,
        elapsedMs: performance.now() - started, jobId: execution.jobId, claimFence: execution.claimFence,
        parentReservation: parentRef, monetaryCost: null, independentCompletionRequired: true }, c);
    });
    try{
      const publication=await persistInstitutionCompute(ctx,{requestId:q.id,workId:q.work_id,episodeId:q.episode_id,
        jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,parentReservation:parentRef,
        rightsRevision:result.original.current.rightsRevision,startedAt:publicationStartedAt,
        elapsedMs:performance.now()-publicationStarted,phase:'PUBLICATION',status:'IMMUTABLE_ARTIFACT_PUBLISHED',
        observedAcquisitionAttempts:0,observedCheckerAttempts:0});
      await compilerEvent(ctx,q,'COMPILER_PUBLICATION_COMPUTE_ATTRIBUTED',{artifactId,compute:publication.record.ref,
        originalEpisode:q.episode_id,parentReservation:parentRef,intervalOverlap:false});
    }catch(error){
      await compilerEvent(ctx,q,'COMPILER_PUBLICATION_METER_GAP',{artifactId,jobId:execution.jobId,
        deliveryAttemptId:execution.deliveryAttemptId,originalEpisode:q.episode_id,predicate:safePredicate(error),
        alreadyPublishedArtifactRetained:true,monetaryCost:null});
    }
  } catch (error) {
    const predicate = safePredicate(error);
    let meterGap:string|null=null;
    try {
      const parent=await compilerEpisode(ctx,q.episode_id),rights=await employeeAuthoritySnapshot(ctx.auth);
      await persistInstitutionCompute(ctx,{requestId:q.id,workId:q.work_id,episodeId:q.episode_id,
        jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,parentReservation:parent.parent_reservation,
        rightsRevision:String(rights.revision),startedAt,elapsedMs:performance.now()-started,
        phase:"COMPILE",status:predicate,observedAcquisitionAttempts:sourceAttempts,observedCheckerAttempts:checkerAttempts});
    } catch (meterError) { meterGap=safePredicate(meterError); }
    await tx(ctx, async c => {
      const current = await compilerRow(ctx, q.id, c, true);
      await compilerEvent(ctx, current, "COMPILER_FAILED_OR_FENCED", { predicate,
        ...(predicate==="X1_CANONICAL_ENTITY_CHANGED_DURING_ADMISSION"
          &&(error as Error).cause&&(error as {cause?:{kind?:string}}).cause?.kind==="X1_CANONICAL_OWNER_MISMATCH"
          ?{ownerMismatch:(error as Error).cause}:{}),
        jobId: execution.jobId, claimFence: execution.claimFence, elapsedMs: performance.now() - started,
        originalEpisode: q.episode_id, possibleAdmissionsOrEffectsRetained: true, monetaryCost: null,
        physicalComputeAttribution:meterGap?"METER_GAP":"S7_ATTEMPT_RECORDED",meterGap }, c);
      if (current.generation === q.generation && current.status === "RUNNING"
          && current.claim_token === execution.claimToken) await c.query(`UPDATE finnor_os.x1_compiler_requests
        SET status=$4,failure=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [q.tenant_id, q.principal_id, q.id, /REVISION|REVOKED|SUPERSEDED|FENCED/.test(predicate) ? "INVALIDATED" : "UNKNOWN", predicate]);
    });
    throw error;
  }
}
