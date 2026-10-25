/** P1 owns the journal in its existing immutable event stream. No second Work
 * lifecycle or remote result publication path is introduced. */
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {sha,stable,tx,currentDerivation} from '../evidence-execution/store';
import {assertProgramCurrent,requestRow,trace,type ProgramRow} from './store';
import {HarnessExecutorBindingSchema,type HarnessExecutorBinding,type NativeModule} from './contracts';
import type {ExecutorJournalEntry,ExecutorJournalStage,IsolatedExecutionCustody,IsolatedExecutionOptions} from '../../../governed-execution/src/executor-custody';
import {reconcileDaytonaExecution,daytonaExecutionConfigurationDigest} from '../../../governed-execution/src/executor-daytona';
import {currentCapsule} from '../procedure-induction/store';
import {searchRow,currentSearch,units} from '../compute-search/store';

export type ProcedureExecutionComponent={owner:'P6';capsuleId:string;capsuleDigest:string;compositionDigest:string;component:'CORE'|'RESIDUAL'};
export type SearchExecutionUnit={owner:'P2';searchId:string;searchGeneration:number;unitId:string;unitBodyDigest:string;attemptId:string};

/** The same server selector gates admission and dispatch. Configured does not
 * mean that the provider, snapshot or physical runtime has been qualified. */
export function p1ExecutionConfiguration(){
 const selected=process.env.FINNOR_P1_EXECUTOR??'local';
 const backend=selected==='local'||selected==='daytona'?selected:null;
 let reason:string|null=backend?null:'P1_EXECUTOR_BACKEND_UNAVAILABLE',configurationDigest:string|null=backend==='local'?sha({backend,profile:'S6_SOURCE_BOUND_OUTPUT_ONLY_V1'}):null;
 if(backend==='daytona')try{configurationDigest=daytonaExecutionConfigurationDigest();}catch(error){
  const message=error instanceof Error?error.message:'';
  reason=['DAYTONA_CREDENTIAL_UNAVAILABLE','DAYTONA_ENDPOINT_INVALID','DAYTONA_PINNED_PROFILE_REQUIRED','DAYTONA_PINNED_PROFILE_INVALID'].includes(message)?message:'P1_EXECUTOR_CONFIGURATION_UNAVAILABLE';
 }
 if(backend&&configurationDigest&&!reason){const binding:HarnessExecutorBinding={schema:'finnor.p1.executor-binding.v1',backend,configurationDigest};return {backend,configurationReady:true as const,reason:null,binding,providerQualification:'UNVERIFIED' as const};}
 return {backend,configurationReady:false as const,reason:reason??'P1_EXECUTOR_CONFIGURATION_UNAVAILABLE',binding:null,providerQualification:'UNVERIFIED' as const};
}
export function assertP1ExecutionBinding(value:unknown):HarnessExecutorBinding{
 const original=HarnessExecutorBindingSchema.safeParse(value);if(!original.success)throw Error('P1_EXECUTOR_ORIGINAL_BINDING_REQUIRED');
 const current=p1ExecutionConfiguration();if(!current.configurationReady||stable(current.binding)!==stable(original.data))throw Error('P1_EXECUTOR_BOUND_CONFIGURATION_CHANGED');
 return original.data;
}

function journal(ctx:PeMutationContext,q:ProgramRow,attemptKey:string,assertCurrent:()=>Promise<void>,initialBinding?:IsolatedExecutionCustody['binding']):IsolatedExecutionCustody{
 const unavailable=()=>{throw Error('DAYTONA_ORIGINAL_BINDING_UNAVAILABLE');};
 // Filled from immutable INTENT on cleanup, before any provider lookup.
 let binding=initialBinding,originalDeadlineAt=q.proposed.bounds.deadlineAt;
 async function entries(client?:import('pg').PoolClient){
  const read=async(c:import('pg').PoolClient)=>{
   const rows=(await c.query<{body:any}>("SELECT body FROM finnor_os.p1_events WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND generation=$4 AND kind='REMOTE_EXECUTOR_JOURNAL' AND body->>'attemptKey'=$5 ORDER BY created_at,id LIMIT 9",[q.tenant_id,q.principal_id,q.id,q.generation,attemptKey])).rows;
   if(rows.length>7||rows.some(r=>sha(r.body.data)!==r.body.digest)||new Set(rows.map(r=>r.body.stage)).size!==rows.length)throw Error('DAYTONA_JOURNAL_INTEGRITY_FAILED');
   const intent=rows.find(r=>r.body.stage==='INTENT')?.body;
   if(intent){binding=intent.binding;originalDeadlineAt=intent.originalDeadlineAt;if(binding?.requestId!==q.id||binding.workId!==q.work_id||binding.workInputId!==q.work_input_id||binding.generation!==q.generation||binding.tenantId!==q.tenant_id||binding.principalId!==q.principal_id||sha({binding,originalDeadlineAt})!==attemptKey)throw Error('DAYTONA_JOURNAL_SCOPE_MISMATCH');}
   return rows.map(r=>({stage:r.body.stage,body:r.body.data})) as ExecutorJournalEntry[];
  };return client?read(client):tx(ctx,read,true);
 }
 return {
  attemptKey,get binding(){return binding??unavailable();},get originalDeadlineAt(){return originalDeadlineAt;},read:()=>entries(),assertCurrent,
  async record(stage:ExecutorJournalStage,body:Record<string,unknown>){
   return tx(ctx,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4610))',[q.tenant_id+':'+attemptKey]);
    const prior=(await entries(c)).find(e=>e.stage===stage);
    if(prior){if(stage!=='INTENT'&&stable(prior.body)!==stable(body))throw Error('DAYTONA_JOURNAL_STAGE_CONFLICT');return {created:false,body:prior.body};}
    if(stage==='INTENT'||stage==='DISPATCH_INTENT')await assertCurrent();
    await trace(ctx,q,'REMOTE_EXECUTOR_JOURNAL',{attemptKey,stage,data:body,digest:sha(body),...(stage==='INTENT'?{binding,originalDeadlineAt}:{})},c);
    if(stage==='INTENT')await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at) VALUES($1,'reconcile_analytical_executor_v1',$2::jsonb,$3,'batch',1,'locally_idempotent',$4) ON CONFLICT(idempotency_key) DO NOTHING",[q.tenant_id,stable({tenantId:q.tenant_id,principalId:q.principal_id,programId:q.id,generation:q.generation,attemptKey}),'p1-executor-cleanup:'+attemptKey,new Date(String(body.recoveryDeadlineAt))]);
    return {created:true,body};
   });
  },
 };
}
export async function p1IsolatedExecution(ctx:PeMutationContext,q:ProgramRow,x:Readonly<JobExecutionContext>,module:NativeModule,input:Record<string,string>,derivationId:string,sourceDigest:string,component?:ProcedureExecutionComponent|SearchExecutionUnit):Promise<IsolatedExecutionOptions>{
 const {backend}=assertP1ExecutionBinding(q.proposed.executionBinding);
 const binding:IsolatedExecutionCustody['binding']={owner:'P1',tenantId:q.tenant_id,principalId:q.principal_id,requestId:q.id,generation:q.generation,workId:q.work_id,workInputId:q.work_input_id,moduleDigest:module.compiledDigest,sourceDigest,inputDigest:sha(input),...(component?{consumer:{owner:component.owner,id:component.owner==='P2'?component.attemptId:component.capsuleId+':'+component.component,digest:sha(component)}}:{})},originalDeadlineAt=q.proposed.bounds.deadlineAt;
 const key=sha({binding,originalDeadlineAt});
 const assertCurrent=async()=>{
  assertP1ExecutionBinding(q.proposed.executionBinding);
  await assertProgramCurrent(ctx,q);const d=await currentDerivation(ctx,derivationId);if(d.result?.digest!==sourceDigest)throw Error('DAYTONA_SOURCE_CUT_CHANGED');
  if(component?.owner==='P6'&&(q.request.procedure?.capsuleId!==component.capsuleId||sha(await currentCapsule(ctx,component.capsuleId))!==component.capsuleDigest))throw Error('P6_EXECUTION_CAPSULE_CHANGED');
  if(component?.owner==='P2'){
   const s=await searchRow(ctx,component.searchId);await currentSearch(ctx,s);
   if(s.program_id!==q.id||s.generation!==component.searchGeneration||!['RUNNING','WAITING'].includes(s.status)||s.context?.derivationId!==derivationId||s.context?.sourceResultDigest!==sourceDigest||s.context?.inputDigest!==sha(input))throw Error('P2_REMOTE_OWNER_BINDING_CHANGED');
   await tx(ctx,async c=>{
    const current=await requestRow(ctx,q.id,c),u=(await units(ctx,s,c)).find(v=>v.id===component.unitId);
    const a=(await c.query<{body:any;digest:string;status:string}>('SELECT body,digest,status FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND unit_id=$4 AND id=$5',[q.tenant_id,q.principal_id,s.id,component.unitId,component.attemptId])).rows[0];
    if(current.generation!==q.generation||current.status!=='WAITING'||!u||u.kind!=='EXECUTE_P1'||u.body.moduleId!==module.id||u.digest!==component.unitBodyDigest||u.generation!==s.generation||u.status!=='RUNNING'||u.job_id!==x.jobId||u.claim_token!==x.claimToken||Number(u.claim_fence)!==x.claimFence||!a||!['SUBMITTED','UNKNOWN'].includes(a.status)||sha(a.body)!==a.digest||a.body.unitBodyDigest!==u.digest||a.body.workKind!=='EXECUTE_P1'||a.body.chargedNativeAttempts!==1||a.body.originalEpisode!==q.episode_id||a.body.grantDigest!==s.request.computeGrant.contentDigest)throw Error('P2_REMOTE_UNIT_CLAIM_FENCED');
    if(!(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='run_compute_search_unit_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=$5 AND lease_expires_at>clock_timestamp() AND payload->>'searchId'=$6 AND payload->>'unitId'=$7 AND payload->>'principalId'=$8 AND payload->>'generation'=$9 FOR SHARE",[q.tenant_id,x.jobId,x.claimToken,x.claimFence,x.protocolVersion,s.id,u.id,q.principal_id,String(s.generation)])).rows[0])throw Error('DAYTONA_DURABLE_JOB_CLAIM_FENCED');
   });return;
  }
  await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c);if(current.generation!==q.generation||current.status!=='RUNNING'||current.claim_token!==x.claimToken||Number(current.claim_fence)!==x.claimFence)throw Error('DAYTONA_NATIVE_OWNER_CLAIM_FENCED');
   if(!(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='run_harness_program_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE",[q.tenant_id,x.jobId,x.claimToken,x.claimFence])).rows[0])throw Error('DAYTONA_DURABLE_JOB_CLAIM_FENCED');});
 };
 await assertCurrent();if(backend==='local')return {backend};
 return {backend:'daytona',custody:journal(ctx,q,key,assertCurrent,binding)};
}
export async function readAnalyticalExecutorJournal(ctx:PeMutationContext,q:ProgramRow,attemptKey:string){
 const custody=journal(ctx,q,attemptKey,async()=>{throw Error('DAYTONA_JOURNAL_READER_HAS_NO_EXECUTION_AUTHORITY');});
 const entries=await custody.read();return {binding:custody.binding,originalDeadlineAt:custody.originalDeadlineAt,entries};
}
export async function reconcileAnalyticalExecutorJob(payload:Record<string,unknown>,x?:Readonly<JobExecutionContext>){
 if(!x||x.protocolVersion!==1||x.tenantId!==payload.tenantId||typeof payload.tenantId!=='string'||typeof payload.principalId!=='string'||typeof payload.programId!=='string'||typeof payload.attemptKey!=='string'||!Number.isInteger(payload.generation))throw Error('DAYTONA_CLEANUP_DURABLE_CLAIM_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},provenance:{sourceSystem:'P1:remote-cleanup',createdBy:payload.principalId}};
 await tx(ctx,async c=>{if(!(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='reconcile_analytical_executor_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE",[payload.tenantId,x.jobId,x.claimToken,x.claimFence])).rows[0])throw Error('DAYTONA_CLEANUP_JOB_FENCED');});
 const q=await requestRow(ctx,payload.programId);
 // A newer logical generation cannot discard the earlier physical liability.
 const original={...q,generation:Number(payload.generation)};
 const custody=journal(ctx,original,payload.attemptKey,async()=>{throw Error('DAYTONA_CLEANUP_HAS_NO_EXECUTION_AUTHORITY');});
 await custody.read();await reconcileDaytonaExecution(custody);
}
