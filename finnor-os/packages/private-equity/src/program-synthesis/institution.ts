import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import { validateInstitutionDemand } from '../allocation-store';
import { verifyInstitutionDutyPopulation } from '../institution-program/responsibility';
import type { PeMutationContext } from '../types';
import { authorize, codeIdentity, principal, schemaIdentity, sha, stable, tx } from '../evidence-execution/store';
import { P1_VERSION, isInstitutionRequest, type InstitutionHarnessRequest, type InstitutionHarnessProgram } from './contracts';
import { selectHarnessPlan } from './plan';
import { assertProgramCurrent, durableNode, enqueueProgram, episodeCosts, nativeRequestRow, persistProgrammeHead, trace,
 type InstitutionProgramRow } from './store';
import { executeOwnerOperation, resolveEconomicBindings } from './owners';
import { continueInstitutionProgram } from './institution-continuation';

/** Admission checks existing owner receipts and the original S5 reservation,
 * rather than accepting a caller's `LOWERED` label as owner authority. */
export async function submitInstitutionHarnessProgram(ctx:PeMutationContext,request:InstitutionHarnessRequest){
 const {programme,responsibilities,unresolved,demand,reservationRef,actions=[],compilerRequestId}=request.institution;
 let originalCompilerDeadline:string|null=null;
 if(process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')
  throw Error('HARNESS_PROTECTED_FUNDING_ADMISSION_AND_RUNTIME_UNAVAILABLE');
 verifyInstitutionDutyPopulation(programme,responsibilities,unresolved);
 if(request.workId!==programme.workId||request.workId!==demand.workId
   ||programme.tenantId!==ctx.auth.tenantId||demand.tenantId!==ctx.auth.tenantId
   ||programme.principalId!==principal(ctx)||demand.principalId!==principal(ctx)
   ||(!compilerRequestId&&sha(programme)!==demand.programmeDigest)
   ||(!compilerRequestId&&programme.parentEnvelope.deadlineAt!==demand.originalDeadline)
   ||responsibilities.length+unresolved.length>128
   ||new Set([...responsibilities.map(r=>r.obligation.stableIdentity),
      ...unresolved.map(r=>r.stableIdentity)]).size!==responsibilities.length+unresolved.length
   ||(!compilerRequestId&&stable(demand.responsibilityIdentities)!==stable(responsibilities.map(r=>r.obligation.stableIdentity).sort()))
   ||responsibilities.some(r=>(!compilerRequestId&&r.obligation.responsiblePrincipal!==principal(ctx))
     ||Date.parse(r.obligation.originalDeadline)<Date.parse(demand.originalDeadline))
   ||actions.some(a=>!responsibilities.some(r=>r.obligation.stableIdentity===a.responsibilityIdentity
     &&r.obligation.permissibleOperationClass===a.operation))
   ||new Set(actions.map(a=>a.responsibilityIdentity)).size!==actions.length)
  throw Error('X1_P1_ORIGINAL_PROGRAMME_BINDING_MISMATCH');
 await authorize(ctx,request.root,[{type:'work',id:request.workId}]);
 const resource=await validateInstitutionDemand(ctx,reservationRef);
 if(resource.status!=='CURRENT'||resource.reservation.demand.demandDigest!==demand.demandDigest
   ||stable(resource.reservation.demand)!==stable(demand))throw Error('X1_P1_S5_PARENT_NOT_CURRENT');
 const admission=await tx(ctx,async c=>(await c.query(`SELECT id FROM finnor_os.x1_mapping_admissions
   WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND original_digest=$4
     AND candidate_digest=$5 AND checker_digest=$6 AND duty_population_digest=$7`,
  [ctx.auth.tenantId,principal(ctx),request.workId,programme.admission.originalDigest,
   programme.admission.candidateDigest,programme.admission.checkerDigest,
   programme.dutyPopulationDigest])).rows[0],true);
 if(!admission)throw Error('X1_P1_CHECKED_OWNER_ADMISSION_REQUIRED');
 if(compilerRequestId){
  const {compilerRow,compilerEpisode,assertInstitutionCompilerCurrent}=await import('../institution-program/store');
  const owner=await compilerRow(ctx,compilerRequestId),episode=await compilerEpisode(ctx,owner.episode_id);
  if(!['RUNNING','WAITING','PARTIAL'].includes(owner.status)||owner.work_id!==request.workId
    ||owner.work_input_id!==request.workInputId||owner.admission_id!==admission.id
    ||!episode.parent_reservation||stable(episode.parent_reservation)!==stable(reservationRef)
    ||!episode.parent_demand||stable(episode.parent_demand)!==stable(demand)
    ||demand.chargeScope?.episodeId!==episode.id||owner.programme_digest!==sha(programme)
    ||owner.intent_digest!==sha(actions))throw Error('X1_P1_ORIGINAL_COMPILER_BINDING_REQUIRED');
  await assertInstitutionCompilerCurrent(ctx,owner,owner.input_manifest?.current);
  originalCompilerDeadline=episode.wall_deadline.toISOString();
 }
 const mandate=await tx(ctx,async c=>(await c.query<{revision:string;rules:Array<{
  id:string;operation:string;deadlineAt:string;principalId:string;actionPayload?:unknown;
  expectedEntityId?:string;postconditionDigest?:string;
 }>}>(`SELECT revision,rules FROM finnor_os.x1_work_mandates
   WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND institution_id=$4
     AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()
   ORDER BY valid_from DESC LIMIT 2`,[ctx.auth.tenantId,principal(ctx),request.workId,
    demand.institutionId])).rows,true);
 if(mandate.length!==1||responsibilities.some(r=>r.obligation.rule.mandateRevision!==mandate[0]!.revision
   ||!mandate[0]!.rules.some(rule=>rule.id===r.obligation.rule.id
     &&rule.operation===r.obligation.permissibleOperationClass
     &&rule.principalId===r.obligation.responsiblePrincipal
     &&rule.deadlineAt===r.obligation.originalDeadline))
   ||(!compilerRequestId&&actions.some(action=>{
    const duty=responsibilities.find(r=>r.obligation.stableIdentity===action.responsibilityIdentity);
    const rule=mandate[0]!.rules.find(r=>r.id===duty?.obligation.rule.id);
    return !rule?.actionPayload||stable(rule.actionPayload)!==stable(action.payload)
      ||rule.expectedEntityId!==action.expectedEntityId
      ||rule.postconditionDigest!==action.postconditionDigest;
   })))throw Error('X1_P1_FROZEN_MANDATE_ACTION_NOT_ESTABLISHED');
 const digest=sha(request),code=await codeIdentity(),schemaDigest=await schemaIdentity(ctx);
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4401))',
   [ctx.auth.tenantId+':'+principal(ctx)+':'+request.idempotencyKey]);
  const old=(await c.query<InstitutionProgramRow>(`SELECT * FROM finnor_os.p1_requests
    WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
    [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(old){if(old.request_digest!==digest)throw Error('IDEMPOTENCY_REQUEST_CONFLICT');
   return {programId:old.id,workId:old.work_id,workRevision:old.work_input_id,status:old.status,replayed:true};}
  const work=(await c.query<{id:string;body:unknown}>(`SELECT id::text,to_jsonb(w) body
    FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2
    ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.auth.tenantId,request.workId])).rows[0];
  if(work?.id!==request.workInputId)throw Error('EXACT_WORK_REVISION_CHANGED');
  const inputDigest=sha(work.body),id=(await import('node:crypto')).randomUUID();
  const parentPlan=(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.work_plan_revisions
    WHERE tenant_id=$1 AND work_id=$2 ORDER BY (status='active') DESC,revision DESC LIMIT 1`,
    [ctx.auth.tenantId,request.workId])).rows[0];
  const episodeDeadline=originalCompilerDeadline??new Date(Math.min(Date.parse(demand.originalDeadline),Date.now()+3600000)).toISOString();
  const selected=await selectHarnessPlan(ctx,request,{programId:id,workId:request.workId,
   inputId:work.id,inputDigest,parentRevisionId:parentPlan?.id??null,
   rightsRevision:Number(resource.reservation.rightsRevision),deadlineAt:episodeDeadline});
  const previous=(await c.query(`SELECT * FROM finnor_os.p1_episodes
    WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`,
    [ctx.auth.tenantId,principal(ctx),request.workId])).rows[0];
  const episodeId=previous?.id??(await import('node:crypto')).randomUUID();
  if(!previous)await c.query(`INSERT INTO finnor_os.p1_episodes
    (id,tenant_id,principal_id,work_id,max_steps,max_attempts,deadline_at,max_candidates,max_depth,candidates_used)
    VALUES($1,$2,$3,$4,1024,4,$5,8,12,0)`,
    [episodeId,ctx.auth.tenantId,principal(ctx),request.workId,episodeDeadline]);
  const nodes=responsibilities.map(r=>({id:'p1node_'+sha([r.obligation.stableIdentity,r.obligation.derivationRevision]).slice(0,24),
   stableIdentity:r.obligation.stableIdentity,derivationRevision:r.obligation.derivationRevision,
   operation:r.obligation.permissibleOperationClass,deadlineAt:r.obligation.originalDeadline,
   postconditionRef:r.obligation.postcondition.contractRef,
   observerRef:r.obligation.independentObserver.ref,
   action:actions.find(a=>a.responsibilityIdentity===r.obligation.stableIdentity)??null}));
  const head:InstitutionHarnessProgram={schema:'finnor.institution-harness-program.v1',
   kind:'institution_responsibility_v1',id,tenantId:ctx.auth.tenantId,principalId:principal(ctx),
   work:{id:request.workId,revision:work.id,inputDigest,planRevisionId:selected.planRevisionId},
   producer:{version:P1_VERSION,codeDigest:code.digest,schemaDigest},goal:selected.goal,planGraph:selected.planGraph,
   acceptanceDigest:sha(request.institution),institution:request.institution,nodes,
   admission:programme.admission,reservationRef,
   bounds:{episodeId,deadlineAt:episodeDeadline,reservation:reservationRef},
   costs:{usd:null,status:'UNMETERED',attempts:0,steps:0,wallMs:0,modelInvocations:[],nativeInvocations:[]},
   runtime:{node:process.version,imageDigest:null,jobId:null,workerId:null,deliveryAttemptId:null,claimFence:null},
   status:'PROPOSED',observedPostconditions:[],executionAuthorityGranted:false};
  await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',
   [ctx.auth.tenantId,request.workId]);
  const current=(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.work_inputs
    WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.auth.tenantId,request.workId])).rows[0];
  if(current?.id!==work.id)throw Error('EXACT_WORK_REVISION_CHANGED');
  await c.query(`INSERT INTO finnor_os.p1_requests
    (id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,episode_id,
     plan_revision_id,idempotency_key,request_digest,request,proposed)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
    [id,ctx.auth.tenantId,principal(ctx),request.workId,work.id,inputDigest,episodeId,
     selected.planRevisionId,request.idempotencyKey,digest,stable(request),stable(head)]);
  const row=await nativeRequestRow(ctx,id,c);
  await trace(ctx,row,'INSTITUTION_RESPONSIBILITY_BOUND',{work:head.work,nodes,unresolved,
   originalDeadline:demand.originalDeadline,reservationRef,admission:programme.admission,
   checkedAdmissionId:admission.id,completion:'INDEPENDENT_CANONICAL_OBSERVATION_REQUIRED'},c);
  await enqueueProgram(ctx,row,'initial',c);
  return {programId:id,workId:request.workId,workRevision:work.id,status:'QUEUED',replayed:false};
 });
}

export async function readInstitutionHarnessProgram(ctx:PeMutationContext,id:string){
 const q=await nativeRequestRow(ctx,id);
 if(!isInstitutionRow(q))throw Error('X1_P1_TYPED_HEAD_REQUIRED');
 await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 if(['CANCELLED','INVALIDATED'].includes(q.status))
  return {programId:id,workId:q.work_id,workRevision:q.work_input_id,status:q.status,
   program:null,reason:q.failure,incurredCosts:await episodeCosts(ctx,q)};
 await assertProgramCurrent(ctx,q);
 const program=q.head_id?await tx(ctx,async c=>{
  const row=(await c.query<{body:InstitutionHarnessProgram;digest:string}>(`SELECT body,digest
    FROM finnor_os.p1_programs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
   [q.tenant_id,q.principal_id,q.head_id])).rows[0];
  if(!row||row.body.schema!=='finnor.institution-harness-program.v1'
    ||sha(row.body)!==row.digest)throw Error('PROGRAM_IMMUTABLE_DIGEST_MISMATCH');
  return row.body;
 },true):q.proposed;
 if(q.status==='TESTED'||q.status==='OBSERVED'&&program.observedPostconditions.length!==program.nodes.length)
  throw Error('X1_P1_INDEPENDENT_CANONICAL_POSTCONDITION_REQUIRED');
 await resolveEconomicBindings(ctx,q.request,{programId:q.id,workId:q.work_id,
  inputId:q.work_input_id,validAt:q.request.validAt,knowledgeAt:q.request.validAt});
 await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 return {programId:id,workId:q.work_id,workRevision:q.work_input_id,status:q.status,
  program,reason:q.failure,incurredCosts:await episodeCosts(ctx,q),
  canResume:['WAITING','PARTIAL','FAILED'].includes(q.status)};
}
function isInstitutionRow(q:Awaited<ReturnType<typeof nativeRequestRow>>):q is InstitutionProgramRow{
 return isInstitutionRequest(q.request)&&q.proposed.schema==='finnor.institution-harness-program.v1';
}

export async function runInstitutionHarnessJob(ctx:PeMutationContext,q:InstitutionProgramRow,execution:Readonly<JobExecutionContext>){
 // A published head is durable progress even if the previous claimant died
 // after setting RUNNING. Recovery must never clone the initial proposal.
 if(q.head_id)return continueInstitutionProgram(ctx,q,execution);
 let current=q;
 await assertProgramCurrent(ctx,q);
 const valid=await validateInstitutionDemand(ctx,q.proposed.reservationRef);
 if(valid.status!=='CURRENT')throw Error('X1_P1_S5_PARENT_NOT_CURRENT');
 current=await tx(ctx,async c=>{
  const row=await nativeRequestRow(ctx,q.id,c,true);
  const claim=(await c.query(`SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2
    AND type IN('run_harness_program_v1','run_x1_institution_continuation_v1')
    AND status='running' AND claim_token=$3
    AND claim_fence=$4 AND protocol_version=1 FOR SHARE`,
   [execution.jobId,q.tenant_id,execution.claimToken,execution.claimFence])).rows[0];
  if(!claim||row.generation!==q.generation)throw Error('PROGRAM_JOB_CLAIM_FENCED');
  const charged=await c.query(`UPDATE finnor_os.p1_episodes SET steps_used=steps_used+1,
    attempts_used=attempts_used+1 WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
    AND steps_used+1<=max_steps AND attempts_used+1<=max_attempts
    AND deadline_at>clock_timestamp() RETURNING id`,
   [q.episode_id,q.tenant_id,q.principal_id]);
  if(!charged.rowCount)throw Error('ORIGINAL_EPISODE_GRANT_EXHAUSTED');
  await c.query(`UPDATE finnor_os.p1_requests SET status='RUNNING',claim_token=$4,claim_fence=$5
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
   [q.tenant_id,q.principal_id,q.id,execution.claimToken,execution.claimFence]);
  await trace(ctx,row,'DELIVERY_STARTED',{jobId:execution.jobId,claimFence:execution.claimFence,
   originalEpisode:q.episode_id,reservationRef:q.proposed.reservationRef},c);
  return {...row,status:'RUNNING',claim_token:execution.claimToken,claim_fence:execution.claimFence} as InstitutionProgramRow;
 });
 try{
 const head:InstitutionHarnessProgram=structuredClone(q.proposed);
 head.runtime={node:process.version,imageDigest:null,jobId:execution.jobId,
  workerId:execution.workerId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence};
 const bindings=await resolveEconomicBindings(ctx,q.request,{programId:q.id,workId:q.work_id,
  inputId:q.work_input_id,validAt:q.request.validAt,knowledgeAt:q.request.validAt});
 for(const node of head.nodes){
  await assertProgramCurrent(ctx,current);
  const outcome=await executeOwnerOperation(ctx,current,{op:'institution_duty',node});
  await durableNode(ctx,current,node.id,outcome);
  if(outcome.status==='STOP'){
   node.action=null;
   head.interventions=[...(head.interventions??[]),{stableIdentity:node.stableIdentity,
    predicate:String((outcome.value as {reason?:string}).reason??'X1_EXACT_OPERATION_INTERPRETATION_REQUIRED'),possibleEffect:false}];
  }
  await trace(ctx,current,'INSTITUTION_OWNER_OPERATION',{nodeId:node.id,
   outcome,originalDeadline:node.deadlineAt,reservationRef:head.reservationRef,
   bindings,completed:false,executionAuthorityGranted:false});
 }
 head.status=head.nodes.some(n=>n.action)?'WAITING':'PARTIAL';
 // Neither a P1 node nor an analytical TESTED result may publish OBSERVED.
 await tx(ctx,async(c,db)=>{
  await c.query(`SELECT l.id FROM finnor_os.work_objective_loops l
    JOIN finnor_os.work_plan_revisions p ON p.objective_loop_id=l.id AND p.tenant_id=l.tenant_id
    WHERE l.tenant_id=$1 AND p.id=$2 FOR UPDATE OF l`,[q.tenant_id,q.plan_revision_id]);
  await assertProgramCurrent(ctx,current,c,true);
  const claim=(await c.query(`SELECT id FROM finnor_os.jobs
    WHERE tenant_id=$1 AND id=$2 AND status='running'
      AND claim_token=$3 AND claim_fence=$4 FOR SHARE`,
   [q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
  if(!claim)throw Error('ATOMIC_PROGRAM_PUBLICATION_FENCED');
  await persistProgrammeHead(ctx,current,head,head.status,
   head.status==='PARTIAL'?'X1_EXACT_ACTION_PAYLOAD_OR_OBSERVER_MISSING':null,c);
  if(head.status==='WAITING'){
   await enqueueProgram(ctx,current,'first-canonical-observation',c);
   await (await import('../../../orchestration/src/objective-loop'))
    .schedulePreparedHarnessObjectiveTx(db,{tenantId:q.tenant_id,workId:q.work_id,planRevisionId:q.plan_revision_id});
  }
 });
 }catch(error){
  await tx(ctx,async c=>{
   const row=await nativeRequestRow(ctx,q.id,c,true);
   await trace(ctx,row,'FAILED_OR_FENCED',{predicate:String((error as Error).message),
    claimFence:execution.claimFence,originalDeadline:q.request.institution.demand.originalDeadline,
    reservationRef:q.proposed.reservationRef,exposureRetained:true},c);
   if(row.generation===q.generation&&row.status==='RUNNING'
     &&row.claim_token===execution.claimToken){
    await c.query(`UPDATE finnor_os.p1_requests
      SET status='FAILED',failure=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
     [q.tenant_id,q.principal_id,q.id,
      /^X1_[A-Z0-9_]+$/.test(String((error as Error).message))
        ?(error as Error).message:'X1_P1_OWNER_FAILURE']);
   }
  });
  throw error;
 }
}
