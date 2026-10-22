import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Db} from '@finnor/db';
import {employeeAuthoritySnapshotTx,canExerciseAuthorityTx} from '@finnor/authority';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {closingTx,authorize,principal,unavailable} from '../owner-context';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {sha,fail,sourceHandleRefs,workPlanReference,type OpaqueSourceHandle,type ConfidentialJob,type ConfidentialEconomicComputation, type SubmitSchema} from './contracts';
import type {z} from 'zod';
import {currentEnvironment} from './process';
import {assertCompleteArtifact} from './artifact';

export {principal};
export const newId=randomUUID;
export interface ComputationRow {
 tenant_id:string;id:string;principal_id:string;root_type:PeWorldRootRef['entityType'];root_id:string;
 work_id:string;work_input_id:string;work_input_digest:string;request:z.infer<typeof SubmitSchema>;
 request_digest:string;environment:Record<string,unknown>;deadline_at:Date;max_attempts:number;attempt_count:number;
 generation:number;status:string;protocol:Record<string,any>|null;correspondence:Record<string,unknown>|null;
 session:Record<string,any>|null;runtime_receipt:Record<string,any>|null;data_bytes:string;cpu_reserved_seconds:number;
}
export interface ConsentRow {
 participant_id:string;principal_id:string;body:{
  request:{validUntil:string;certificateDigest:string;idempotencyKey:string};
  sourceCuts:Array<{handleId:string;digest:string;validUntil:string;sourceId:string}>;
  authorityRevision:string;functionDigest:string;participantId:string;
 };body_digest:string;
}
export function tx<T>(ctx:PeMutationContext,body:(c:PoolClient,db:Db)=>Promise<T>):Promise<T>{
 return closingTx(ctx,async(c,db)=>{
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
  // Same existing S1 source-owner mutex, never a replacement grant store.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5510))',[ctx.auth.tenantId]);
  const result=await body(c,db);
  if(authority.validUntil)await assertAuthorityTemporalBoundsTx(c,[authority.validUntil]);
  return result;
 });
}
export const rootOf=(q:ComputationRow)=>({entityType:q.root_type,entityId:q.root_id});
export async function computationTx(ctx:PeMutationContext,c:PoolClient,id:string,operation:'query'|'action'='query',lock=true){
 const q=(await c.query<ComputationRow>('SELECT * FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),
  [ctx.auth.tenantId,id])).rows[0];
 if(!q)throw unavailable();
 await authorize(ctx,rootOf(q),[{type:'work',id:q.work_id}],[],c);
 if(!await canExerciseAuthorityTx(ctx.auth,{operation,capability:operation==='query'?'query:pe_world_state':'action:confidential_economic_computation',
  resource:{type:q.root_type,id:q.root_id},risk:'low'},c,lock))throw unavailable();
 return q;
}
export async function workCurrentTx(c:PoolClient,q:ComputationRow,lock=true){
 const work=await workCutTx(c,q,lock);
 if(work.id!==q.work_input_id||work.digest!==q.work_input_digest)fail('Y4_WORK_INPUT_CHANGED');
 const revision=q.request.function.workRevisionRef;
 const plan=(await c.query(`SELECT id,revision,semantic_hash,work_input_id,status,completion_proof,constraint_set,goal_spec FROM finnor_os.work_plan_revisions
  WHERE tenant_id=$1 AND work_id=$2 AND id=$3`+(lock?' FOR SHARE':''),[q.tenant_id,q.work_id,revision.id])).rows[0];
 const completed=q.status==='COMPUTED'&&plan?.status==='completed'&&plan.completion_proof?.version===1
  &&plan.completion_proof.verified===true&&plan.completion_proof.planRevisionId===plan.id
  &&plan.completion_proof.finalPlanRevisionId===plan.id&&plan.completion_proof.planSemanticHash===plan.semantic_hash;
 if(revision.owner!=='WorkPlanRevision'||!plan||plan.status!=='active'&&!completed||plan.work_input_id!==q.work_input_id||String(plan.revision)!==revision.version
  ||sha(workPlanReference(plan))!==sha(revision))fail('Y4_CANONICAL_WORK_PLAN_REVISION_CHANGED');
 const {workRevisionRef:_,...definition}=q.request.function;
 const original=(await c.query(`SELECT instruction_text,context_snapshot,created_by FROM finnor_os.work_inputs
  WHERE tenant_id=$1 AND work_id=$2 AND id=$3`+(lock?' FOR SHARE':''),
 [q.tenant_id,q.work_id,q.work_input_id])).rows[0];
 if(!original||original.created_by!==q.principal_id||original.instruction_text!==q.request.function.purpose
  ||original.context_snapshot?.confidentialAcceptedRequestDigest!==sha({root:q.request.root,function:definition,limits:q.request.limits}))
  fail('Y4_ORIGINAL_TYPED_WORK_OBJECTIVE_REQUIRED');
 const required:Record<string,unknown>={status:'COMPUTED',definitionDigest:sha(definition),
  recipientReleaseImported:true,typedConsumerCurrent:true};
 for(const [field,expected] of Object.entries(required)){
  if(!Array.isArray(plan.goal_spec?.criteria)||!plan.goal_spec.criteria.some((item:any)=>{
   const criterion=item.criterion;
   return criterion?.kind==='canonical_query'&&criterion.request?.intent==='confidential_economic_computation_v1'
    &&criterion.request.workId===q.work_id&&criterion.assertion?.operator==='eq'
    &&criterion.assertion.path?.join('.')==='data.'+field&&criterion.assertion.expected===expected;
  }))fail('Y4_ORIGINAL_COMPLETION_CONDITION_NOT_REPLACEABLE');
 }
 const deadline=Date.parse(plan.constraint_set?.deadlineAt);
 if(!Number.isFinite(deadline)||q.deadline_at.getTime()>deadline||deadline<=Date.now())fail('Y4_ORIGINAL_WORK_PLAN_DEADLINE_EXCEEDED');
 const state=(await c.query('SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2'+(lock?' FOR SHARE':''),[q.tenant_id,q.work_id])).rows[0];
 if(!state||['cancelled','failed'].includes(state.status)||state.status==='completed'&&!completed)fail('Y4_ORIGINAL_WORK_NOT_ACTIVE');
}
export function allocated(q:ComputationRow){
 if(['CANCELLED','INVALIDATED','UNSUPPORTED'].includes(q.status))fail('Y4_'+q.status);
 if(q.deadline_at.getTime()<=Date.now())fail('Y4_ORIGINAL_DEADLINE_EXPIRED');
 if(Number(q.data_bytes)>q.request.limits.maxRetainedBytes)fail('Y4_ORIGINAL_RETAINED_BYTE_LIMIT');
}
/** Reserve conservative subprocess CPU ceilings before starting them. Crashes,
 * aborts and retries do not refund reservations or renew the original budget. */
export async function reserveCpuTx(c:PoolClient,q:ComputationRow,seconds:number){
 if(!Number.isSafeInteger(seconds)||seconds<1)fail('Y4_ORIGINAL_CPU_BUDGET_EXHAUSTED');
 const row=(await c.query<{cpu_reserved_seconds:number}>(`UPDATE finnor_os.y4_computations
  SET cpu_reserved_seconds=cpu_reserved_seconds+$3 WHERE tenant_id=$1 AND id=$2
   AND cpu_reserved_seconds+$3<=(request->'limits'->>'maxCpuSeconds')::integer
  RETURNING cpu_reserved_seconds`,[q.tenant_id,q.id,seconds])).rows[0];
 if(!row)fail('Y4_ORIGINAL_CPU_BUDGET_EXHAUSTED');
 q.cpu_reserved_seconds=row.cpu_reserved_seconds;
}
export async function captureSourcesTx(ctx:PeMutationContext,c:PoolClient,q:ComputationRow,participantId:string){
 const participant=q.request.function.participants.find(p=>p.id===participantId);
 if(!participant)throw unavailable();
 const sourceCuts=[];
 for(const input of q.request.function.inputs.filter(i=>i.participantId===participantId)){
  if(input.sourceStatus==='PRIMARY_CONFIRMED')fail('Y4_PRIMARY_INPUT_CONFIRMATION_NOT_ISSUED');
  if(!/^[a-f0-9-]{36}$/i.test(input.grantRef.id))fail('Y4_CANONICAL_SOURCE_GRANT_REQUIRED');
  const own=(await c.query<{grant_id:string;work_id:string}>(`SELECT h.grant_id,g.work_id
   FROM finnor_os.y4_source_handles h JOIN finnor_os.x1_source_grants g
    ON g.tenant_id=h.tenant_id AND g.id=h.grant_id
   WHERE h.tenant_id=$1 AND h.id=$2 AND h.principal_id=$3`,
  [q.tenant_id,input.grantRef.id,principal(ctx)])).rows[0];
  if(!own)throw unavailable();
  const handle=(await c.query<{handle:OpaqueSourceHandle}>('SELECT finnor_os.y4_issue_source_handle($1,$2) handle',
   [own.work_id,own.grant_id])).rows[0]?.handle;
  if(!handle||handle.id!==input.grantRef.id||handle.body.principalId!==principal(ctx)
   ||handle.body.institutionId!==participant.institutionId)throw unavailable();
  const refs=sourceHandleRefs(handle);
  if(sha(input.sourceRef)!==sha(refs.sourceRef)||sha(input.grantRef)!==sha(refs.grantRef)
   ||handle.body.purpose!==q.request.function.purpose)fail('Y4_EXACT_PURPOSE_SOURCE_OR_SUBJECT_RIGHTS_REQUIRED');
  sourceCuts.push({handleId:handle.id,digest:handle.digest,validUntil:handle.body.validUntil,sourceId:handle.body.sourceId});
 }
 if(!sourceCuts.length)fail('Y4_PARTICIPANT_LOCAL_INPUT_REQUIRED');
 return sourceCuts;
}
export async function consentsTx(c:PoolClient,q:ComputationRow){
 return (await c.query<ConsentRow>('SELECT participant_id,principal_id,body,body_digest FROM finnor_os.y4_consents WHERE tenant_id=$1 AND computation_id=$2 ORDER BY participant_id',
  [q.tenant_id,q.id])).rows;
}
export async function allCurrentTx(ctx:PeMutationContext,c:PoolClient,q:ComputationRow,requireAll=true,lock=true){
 allocated(q);await workCurrentTx(c,q,lock);
 if(sha(q.environment)!==sha(await currentEnvironment()))fail('Y4_DEPLOYMENT_PROFILE_OR_CHECKER_CHANGED');
 const consents=await consentsTx(c,q),bounds=[q.deadline_at.toISOString()];
 if(requireAll&&consents.length!==q.request.function.participants.length)fail('Y4_INDEPENDENT_PARTICIPANT_CONSENT_INCOMPLETE');
 const revision=(await c.query('SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=$1'+(lock?' FOR SHARE':''),[q.tenant_id])).rows[0]?.revision;
 if((await c.query('SELECT 1 FROM finnor_os.y4_revocations WHERE tenant_id=$1 AND computation_id=$2 LIMIT 1',[q.tenant_id,q.id])).rowCount)
  fail('Y4_PARTICIPANT_OR_DERIVATIVE_RIGHTS_REVOKED');
 for(const consent of consents){
  if(sha(consent.body)!==consent.body_digest||consent.body.functionDigest!==sha(q.request.function)
   ||consent.body.authorityRevision!==revision||Date.parse(consent.body.request.validUntil)<=Date.now())
   fail('Y4_PARTICIPANT_CONSENT_OR_AUTHORITY_CHANGED');
  const owner=(await c.query('SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2'+(lock?' FOR SHARE':''),[q.tenant_id,consent.principal_id])).rows[0];
  if(owner?.status!=='active')fail('Y4_PARTICIPANT_IDENTITY_NOT_CURRENT');
  bounds.push(consent.body.request.validUntil);
  for(const input of consent.body.sourceCuts){
   const current=(await c.query<{current:boolean}>('SELECT finnor_os.y4_source_handle_current($1,$2,$3) current',
    [q.id,consent.participant_id,input.handleId])).rows[0]?.current;
   if(current!==true)fail('Y4_SOURCE_SUBJECT_OR_GRANT_CHANGED');
   bounds.push(input.validUntil);
  }
 }
 for(const input of q.request.function.inputs){if(Date.parse(input.freshUntil)<=Date.now())fail('Y4_INPUT_FRESHNESS_EXPIRED');bounds.push(input.freshUntil);}
 await assertAuthorityTemporalBoundsTx(c,bounds);
 return consents;
}
export async function eventTx(c:PoolClient,q:ComputationRow,actor:string,kind:string,key:string,body:unknown){
 await c.query(`INSERT INTO finnor_os.y4_events(tenant_id,computation_id,actor_id,kind,idempotency_key,body)
  VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,computation_id,idempotency_key) DO NOTHING`,
 [q.tenant_id,q.id,actor,kind,key,JSON.stringify(body)]);
}
export async function enqueueTx(c:PoolClient,q:ComputationRow,stage:ConfidentialJob['stage'],key:string){
 const p:ConfidentialJob={tenantId:q.tenant_id,principalId:q.principal_id,computationId:q.id,generation:q.generation,stage};
 return (await c.query<{id:string}>(`INSERT INTO finnor_os.jobs
  (tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane)
  VALUES($1,'run_confidential_economic_computation_v1',$2::jsonb,$3,1,4,'interactive')
  ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
 [q.tenant_id,JSON.stringify(p),key])).rows[0]!.id;
}
export async function releaseTx(ctx:PeMutationContext,c:PoolClient,q:ComputationRow,id:string,lock=true){
 await allCurrentTx(ctx,c,q,true,lock);
 if(q.status!=='COMPUTED')fail('Y4_CURRENT_COMPLETED_MPC_REQUIRED');
 const row=(await c.query<{body:ConfidentialEconomicComputation;body_digest:string;principal_id:string}>(
  'SELECT body,body_digest,principal_id FROM finnor_os.y4_releases WHERE tenant_id=$1 AND computation_id=$2 AND id=$3 AND principal_id=$4',
  [q.tenant_id,q.id,id,principal(ctx)])).rows[0];
 if(!row||sha(row.body)!==row.body_digest)throw unavailable();
 assertCompleteArtifact(row.body);
 return row.body;
}
