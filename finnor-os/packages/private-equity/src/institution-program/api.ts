import { z } from "zod";
import type { PeMutationContext } from "../types";
import { tx, principal, sha } from "../evidence-execution/store";
import { safePredicate } from "../program-synthesis/store";
import { readInstitutionHarnessProgram } from "../program-synthesis/institution";
import { handleProgramOperation } from "../program-synthesis/api";
import { InstitutionProgram } from "./contracts";
import { configureInstitutionMandate,registerInstitutionCoreSource,readInstitutionInputs,setInstitutionSelfConsent } from './inputs';
import { INSTITUTION_COMPLETION_CONTRACTS } from "./completion-contracts";
import { readInstitutionComputeCosts,persistInstitutionApiCompute,persistInstitutionWorkPreparationCompute } from "./meter";
import {releaseUntouchedInstitutionDemand} from "../allocation-store";
import { authorizeInstitutionWork, assertInstitutionCompilerCurrent, compilerRow, compilerEvent,
  compilerEpisode, enqueueInstitutionCompiler, submitInstitutionCompiler,reconcileInstitutionCompilerDelivery } from "./store";

export const INSTITUTION_OPERATIONS = ["institution-submit", "institution-revise", "institution-read",
  "institution-status", "institution-cancel", "institution-resume", "institution-witness", "institution-sources",
  'institution-inputs','institution-mandate','institution-register-source','institution-consent'] as const;
const id = z.object({ requestId: z.string().uuid() }).strict();
const submit = z.object({ workId: z.string().uuid(), workInputId: z.string().uuid(),
  grantIds: z.array(z.string().uuid()).min(1).max(16), idempotencyKey: z.string().min(1).max(160) }).strict();

export async function readInstitutionCompiler(ctx: PeMutationContext, requestId: string) {
  let q = await compilerRow(ctx, requestId);
  await authorizeInstitutionWork(ctx, q.work_id);
  q=await reconcileInstitutionCompilerDelivery(ctx,q);
  const episode = await compilerEpisode(ctx, q.episode_id);
  const costs = { parentReservation: episode.parent_reservation, originalDeadline: episode.original_deadline.toISOString(),
    wallDeadline: episode.wall_deadline.toISOString(), acquisitionCalls: episode.acquisition_calls,
    compilerAttempts: episode.attempts, monetaryCost: null, monetaryCostStatus: "UNKNOWN",
    coordinationCalls: episode.coordination_calls,
    physicalCompute: await readInstitutionComputeCosts(ctx, q.work_id, episode.id),
    aggregatePeakMemoryBytes: null, humanSeconds: null };
  if (["CANCELLED", "INVALIDATED"].includes(q.status)) return { requestId: q.id, workId: q.work_id,
    workRevision: q.work_input_id, revision: q.revision, status: q.status, artifact: null,
    programme: null, reason: q.failure, costs, exposureRetained: true };
  const artifact = q.artifact_id ? await tx(ctx, async c => (await c.query<{
    body: unknown; body_digest: string; input_manifest: any; candidate: unknown; check_result: unknown;
  }>(`SELECT body,body_digest,input_manifest,candidate,check_result FROM finnor_os.x1_compiler_artifacts
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4`,
  [q.tenant_id, q.principal_id, q.artifact_id, q.id])).rows[0], true) : null;
  try {
    await assertInstitutionCompilerCurrent(ctx, q, artifact?.input_manifest?.current);
    if (artifact && sha(artifact.body) !== artifact.body_digest) throw Error("X1_IMMUTABLE_ARTIFACT_DIGEST_MISMATCH");
    if(artifact){
      const parsed=InstitutionProgram.parse(artifact.body),baseline=artifact.input_manifest?.baseline;
      if(!baseline||sha(baseline)!==artifact.input_manifest.baselineDigest
        ||parsed.envelope.baseline_manifest_ref.status!=='known'
        ||parsed.envelope.baseline_manifest_ref.ref!=='x1-baseline:'+q.artifact_id
        ||parsed.envelope.baseline_manifest_ref.digest!==artifact.input_manifest.baselineDigest)
        throw Error('X1_IMMUTABLE_BASELINE_BINDING_MISMATCH');
      if(q.parent_request_id){
        const parent=await tx(ctx,async c=>(await c.query<{id:string;body:unknown;body_digest:string}>(`SELECT a.id::text,a.body,a.body_digest
          FROM finnor_os.x1_compiler_requests r JOIN finnor_os.x1_compiler_artifacts a
            ON a.tenant_id=r.tenant_id AND a.principal_id=r.principal_id AND a.id=r.artifact_id AND a.request_id=r.id
          WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4 AND r.id=$5`,
          [q.tenant_id,q.principal_id,q.work_id,q.episode_id,q.parent_request_id])).rows[0],true);
        const binding=parsed.envelope.parent_artifact_refs[0];
        if(!parent||sha(parent.body)!==parent.body_digest||parsed.envelope.parent_artifact_refs.length!==1
          ||binding?.status!=='known'||binding.ref!==parent.id||binding.digest!==parent.body_digest)
          throw Error('X1_IMMUTABLE_PARENT_BINDING_MISMATCH');
      }else if(parsed.envelope.parent_artifact_refs.length)throw Error('X1_UNEXPECTED_PARENT_ARTIFACT');
    }
  } catch (error) {
    const reason = safePredicate(error);
    await tx(ctx, async c => {
      const current = await compilerRow(ctx, q.id, c, true);
      if (current.status !== "CANCELLED") {
        await c.query(`UPDATE finnor_os.x1_compiler_requests SET status='INVALIDATED',failure=$4,
          generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
        [q.tenant_id, q.principal_id, q.id, reason]);
        await compilerEvent(ctx, current, "CURRENT_PROJECTION_WITHDRAWN", { reason, priorArtifactId: q.artifact_id,
          priorProgramId: q.program_id, costsRetained: true, possibleEffectsRetained: true }, c);
      }
    });
    return { requestId: q.id, workId: q.work_id, workRevision: q.work_input_id, revision: q.revision,
      status: "INVALIDATED", reason, artifact: null, programme: null, costs, exposureRetained: true };
  }
  const programme = q.program_id ? await readInstitutionHarnessProgram(ctx, q.program_id) : null;
  if(programme&&["OBSERVED","PARTIAL","INVALIDATED"].includes(programme.status)&&programme.status!==q.status)
    await tx(ctx,async c=>{await c.query(`UPDATE finnor_os.x1_compiler_requests SET status=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND generation=$5 AND status NOT IN('CANCELLED','INVALIDATED')`,
      [q.tenant_id,q.principal_id,q.id,programme.status,q.generation]);});
  return { requestId: q.id, workId: q.work_id, workRevision: q.work_input_id, revision: q.revision,
    status: programme?.status ?? q.status, artifact: artifact ? InstitutionProgram.parse(artifact.body) : null,
    check: artifact?.check_result ?? null, programme, reason: q.failure, costs,
    sourceCoverage:{gaps:(artifact?.candidate as {sourceCoverageGaps?:unknown[]}|undefined)?.sourceCoverageGaps??[],
      normativePopulation:!artifact||(artifact.candidate as {sourceCoverageGaps?:unknown[]}).sourceCoverageGaps?.length?'UNKNOWN':'KNOWN_MODEL_RELATIVE'},
    canResume: ["FAILED", "UNKNOWN", "PARTIAL", "WAITING"].includes(q.status),
    canRevise: !["QUEUED", "RUNNING"].includes(q.status),
    executionAuthorityGranted: false, protectedQualification: "UNAVAILABLE" };
}

async function handleInstitutionOperationBody(ctx: PeMutationContext, operation: string, body: unknown) {
  try {
    if(operation==='institution-inputs'){
      const {workId}=z.object({workId:z.string().uuid()}).strict().parse(body);
      return {status:200,body:await readInstitutionInputs(ctx,workId)};
    }
    if(operation==='institution-mandate')return {status:200,body:await configureInstitutionMandate(ctx,body)};
    if(operation==='institution-register-source')return {status:200,body:await registerInstitutionCoreSource(ctx,body)};
    if(operation==='institution-consent')return {status:200,body:await setInstitutionSelfConsent(ctx,body)};
    if (operation === "institution-submit") return { status: 202, body: await submitInstitutionCompiler(ctx, submit.parse(body)) };
    if (operation === "institution-revise") {
      const parsed = submit.extend({ parentRequestId: z.string().uuid() }).strict().parse(body);
      return { status: 202, body: await submitInstitutionCompiler(ctx, parsed) };
    }
    if (operation === "institution-sources") {
      const { workId } = z.object({ workId: z.string().uuid() }).strict().parse(body);
      await authorizeInstitutionWork(ctx, workId);
      return { status: 200, body: await tx(ctx, async c => {
        const grants = (await c.query(`SELECT id::text,source_id,source_class,protocol,revision,expires_at
          FROM finnor_os.x1_source_grants g WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
          AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_source_grants n WHERE n.tenant_id=g.tenant_id
            AND n.work_id=g.work_id AND n.principal_id=g.principal_id AND n.source_id=g.source_id AND n.version>g.version)
          ORDER BY source_id LIMIT 17`, [ctx.auth.tenantId, principal(ctx), workId])).rows;
        const work = (await c.query("SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [ctx.auth.tenantId, workId])).rows[0];
        const request = (await c.query("SELECT id::text,status,revision FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1",
          [ctx.auth.tenantId, principal(ctx), workId])).rows[0] ?? null;
        return { workId, workInputId: work?.id ?? null, grants, request,
          completionContracts:INSTITUTION_COMPLETION_CONTRACTS };
      }, true) };
    }
    const { requestId } = id.parse(body);let q = await compilerRow(ctx, requestId);
    await authorizeInstitutionWork(ctx, q.work_id);
    if(operation==='institution-resume')q=await reconcileInstitutionCompilerDelivery(ctx,q);
    if (["institution-read", "institution-status", "institution-witness"].includes(operation))
      return { status: 200, body: await readInstitutionCompiler(ctx, requestId) };
    if (operation === "institution-cancel") {
      // Cancellation remains available after source-grant invalidation. This
      // historical status only decides whether to preserve an already completed
      // native owner; it supplies no current readiness or execution permission.
      const nativeStatus=q.program_id?await tx(ctx,async c=>(await c.query<{status:string}>(`SELECT status
        FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=$4`,
        [q.tenant_id,q.principal_id,q.work_id,q.program_id])).rows[0]?.status??null,true):null;
      await tx(ctx, async c => {
        // Serialize with manual/automatic acceptance. Stopping a stale revision
        // must not falsely claim that a newer current head has been cancelled.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5510))',[q.tenant_id]);
        const current = await compilerRow(ctx, q.id, c, true);
        const head=(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.x1_compiler_requests
          WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1`,
          [q.tenant_id,q.principal_id,q.work_id])).rows[0];
        if(head?.id!==current.id)throw Error('X1_COMPILER_REVISION_SUPERSEDED');
        if (current.status!=="CANCELLED") {
          await c.query(`UPDATE finnor_os.x1_compiler_requests SET status='CANCELLED',generation=generation+1,
            failure='X1_FUTURE_CONTINUATION_CANCELLED',updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [q.tenant_id, q.principal_id, q.id]);
          await compilerEvent(ctx, current, "CANCELLED_RECONCILIATION_RETAINED", {
            parentEpisode: q.episode_id, parentReservationRetained: true, possibleEffectsRetained: true,
            priorStatus:current.status,priorProgrammeId:current.program_id,priorArtifactId:current.artifact_id,
            futureCompilerContinuationStopped:true,priorNativeObservationsRetained:true }, c);
        }
      });
      if (q.program_id&&nativeStatus!=="OBSERVED")
        await handleProgramOperation(ctx, "program-cancel", { programId: q.program_id });
      let exposureRetained=true;
      const parent=await compilerEpisode(ctx,q.episode_id);
      if(!parent.parent_reservation)exposureRetained=false;
      else if(!q.program_id){
        try{await releaseUntouchedInstitutionDemand(ctx,parent.parent_reservation);exposureRetained=false;}
        catch{ /* Consumed/possible use retains the original exposure. */ }
      }
      return { status: 200, body: { requestId, status: "CANCELLED", exposureRetained } };
    }
    if (operation === "institution-resume") {
      await assertInstitutionCompilerCurrent(ctx, q);
      const episode = await compilerEpisode(ctx, q.episode_id);
      if (Date.now() >= episode.wall_deadline.getTime()) throw Error("X1_ORIGINAL_EPISODE_EXPIRED");
      if (q.program_id) return handleProgramOperation(ctx, "program-resume", { programId: q.program_id });
      if (!["FAILED", "UNKNOWN"].includes(q.status)) throw Error("X1_COMPILER_NOT_RESUMABLE");
      await tx(ctx, async c => {
        const current = await compilerRow(ctx, q.id, c, true);
        if (!["FAILED", "UNKNOWN"].includes(current.status)) throw Error("X1_RESUME_STATE_CHANGED");
        await c.query("UPDATE finnor_os.x1_compiler_requests SET status='QUEUED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [q.tenant_id, q.principal_id, q.id]);
        await enqueueInstitutionCompiler(ctx, current, `resume-${episode.attempts}`, c);
      });
      return { status: 202, body: { requestId, status: "QUEUED", originalParentRetained: true } };
    }
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { code: "X1_BOUNDED_REQUEST_REQUIRED" } };
    if ((error as any).code === "PE_ENTITY_NOT_FOUND" || (error as Error).message.includes("authenticated scope"))
      return { status: 404, body: { code: "PE_ENTITY_NOT_FOUND", error: "Institution responsibility is unavailable in the authenticated scope" } };
    return { status: 422, body: { code: "X1_PREDICATE_UNPASSED", predicate: safePredicate(error) } };
  }
}

export async function handleInstitutionOperation(ctx:PeMutationContext,operation:string,body:unknown){
  const started=performance.now(),startedAt=new Date().toISOString();
  const response=await handleInstitutionOperationBody(ctx,operation,body);let elapsedMs=performance.now()-started;
  const handles=body&&typeof body==='object'&&!Array.isArray(body)?body as {workId?:unknown;requestId?:unknown}:{};
  const valid=(value:unknown):value is string=>typeof value==='string'&&z.string().uuid().safeParse(value).success;
  let attribution:Awaited<ReturnType<typeof compilerRow>>|null=null;
  let preparationWorkId:string|null=null;
  try{
    if(valid(handles.requestId))attribution=await compilerRow(ctx,handles.requestId);
    else if(valid(handles.workId)){
      await authorizeInstitutionWork(ctx,handles.workId);
      preparationWorkId=handles.workId;
      const latest=await tx(ctx,async c=>(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.x1_compiler_requests
        WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1`,
        [ctx.auth.tenantId,principal(ctx),handles.workId])).rows[0],true);
      if(latest)attribution=await compilerRow(ctx,latest.id);
    }
    if(attribution){
      await authorizeInstitutionWork(ctx,attribution.work_id);
      const episode=await compilerEpisode(ctx,attribution.episode_id);
      const rights=await tx(ctx,async c=>(await c.query<{revision:string}>('SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=$1',
        [ctx.auth.tenantId])).rows[0],true);
      elapsedMs=performance.now()-started;
      await persistInstitutionApiCompute(ctx,{workId:attribution.work_id,requestId:attribution.id,episodeId:episode.id,
        parentReservation:episode.parent_reservation,rightsRevision:rights?.revision??'UNKNOWN',operation,
        statusCode:response.status,startedAt,elapsedMs});
    }else if(preparationWorkId){
      const rights=await tx(ctx,async c=>(await c.query<{revision:string}>(
        'SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=$1',[ctx.auth.tenantId])).rows[0],true);
      elapsedMs=performance.now()-started;
      await persistInstitutionWorkPreparationCompute(ctx,{workId:preparationWorkId,rightsRevision:rights?.revision??'UNKNOWN',
        operation,statusCode:response.status,startedAt,elapsedMs});
    }
  }catch(error){
    // A revoked/unavailable principal cannot write a private meter. Retain a
    // failed writer for an otherwise available owner without replacing the
    // real API disposition or erasing any observed effect.
    if(attribution)await compilerEvent(ctx,attribution,'API_COMPUTE_METER_GAP',{operation,statusCode:response.status,
      startedAt,elapsedMs,predicate:safePredicate(error),originalEpisode:attribution.episode_id}).catch(()=>undefined);
  }
  return response;
}
