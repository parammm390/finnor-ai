import {join} from 'node:path';
import type {PoolClient} from 'pg';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,
 ComputeCapacityUnavailableError,type ComputeResourceLease} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {ApplicationFault} from '../enterprise-applications/contracts';
import {JobSchema,sha,fail,minimumNativeCpu,type ConfidentialJob} from './contracts';
import {currentEnvironment,runPublicChild,runtimeConfiguration} from './process';
import {tx,computationTx,allCurrentTx,allocated,workCurrentTx,eventTx,reserveCpuTx,type ComputationRow} from './store';

async function physical(c:PoolClient,e:Readonly<JobExecutionContext>,p:ConfidentialJob){
 const result=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type='run_confidential_economic_computation_v1'
   AND j.status='running' AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
   AND d.id=$5 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.outcome='running'
   AND j.payload=$6::jsonb FOR SHARE OF j,d`,
 [e.jobId,p.tenantId,e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p)]);
 if(result.rowCount!==1)fail('Y4_PHYSICAL_DELIVERY_FENCE_LOST');
}
async function owned(ctx:PeMutationContext,c:PoolClient,p:ConfidentialJob,e:Readonly<JobExecutionContext>){
 const q=await computationTx(ctx,c,p.computationId,'action');await physical(c,e,p);
 if(q.principal_id!==p.principalId)fail('Y4_ORIGINAL_JOB_OWNER_REQUIRED');
 if(q.generation!==p.generation||['CANCELLED','INVALIDATED','COMPUTED','UNSUPPORTED'].includes(q.status))return null;
 if(p.stage==='RECONCILE')return q;
 if(p.stage==='EXECUTE'){
  if(q.status==='RECONCILIATION_REQUIRED')return null;
  if(!['READY','RUNNING'].includes(q.status))return null;
  await allCurrentTx(ctx,c,q);
 }else{
  allocated(q);await workCurrentTx(c,q);
  if(sha(await currentEnvironment())!==sha(q.environment))fail('Y4_LOADED_DEPENDENCY_CUT_CHANGED');
  if(!['QUEUED','COMPILING'].includes(q.status))return null;
 }
 return q;
}
async function publicBundle(c:PoolClient,q:ComputationRow){
 if(!q.protocol||!q.session)fail('Y4_PREPARED_CHECKED_SESSION_REQUIRED');
 const rows=(await c.query('SELECT body,body_digest FROM finnor_os.y4_commitments WHERE tenant_id=$1 AND computation_id=$2 ORDER BY participant_id',[q.tenant_id,q.id])).rows;
 if(rows.length!==q.request.function.participants.length||rows.some(r=>sha(r.body)!==r.body_digest))fail('Y4_ACCEPTED_COMMITMENT_INTEGRITY_FAILED');
 return {protocol:q.protocol,binding:{session:q.session,inputs:rows.flatMap(r=>r.body.inputs)}};
}
export async function runConfidentialEconomicJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=JobSchema.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('Y4_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 let leases:ComputeResourceLease[]=[],dispatched=false;
 try{
  if(process.env.FINNOR_ENVIRONMENT==='production'||process.env.NODE_ENV==='production'
   &&!['development','ordinary_disposable'].includes(process.env.FINNOR_ENVIRONMENT??''))fail('Y4_PRODUCTION_UNADMITTED',403);
  if(!await tx(ctx,c=>owned(ctx,c,p,e)))return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:y4-confidential'],
   requiredResourceKeys:['native:y4-confidential'],workloadClass:'INTERACTIVE',ownerId:'y4:'+e.deliveryAttemptId});
  dispatched=true;
  const heartbeat=async()=>!!await renewComputeResourceLeases(leases)&&!!await tx(ctx,c=>owned(ctx,c,p,e));
  e.registerHeartbeat(heartbeat, { leaseSeconds: Math.min(...leases.map(lease => lease.leaseSeconds)) });
  if(p.stage==='COMPILE'){
   const start=await tx(ctx,async c=>{
    const q=await owned(ctx,c,p,e);if(!q)return null;
    if(q.attempt_count>=q.max_attempts)fail('Y4_ORIGINAL_COMPILER_ATTEMPTS_EXHAUSTED');
    // Compilation and the fresh-process correspondence check each receive
    // an eight-second ceiling. Both consume the original allocation.
    await reserveCpuTx(c,q,16);
    await c.query("UPDATE finnor_os.y4_computations SET status='COMPILING',attempt_count=attempt_count+1 WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id]);
    await eventTx(c,q,p.principalId,'COMPILER_STARTED','compile-start:'+e.deliveryAttemptId,
     {jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,attempt:q.attempt_count+1,deadlineAt:q.deadline_at.toISOString(),moneyUSD:null,humanSeconds:null});
    return q;
   });if(!start)return;
   const compileLimits={...start.request.limits,maxCpuSeconds:8};
   const result=await runPublicChild({action:'compile',function:start.request.function,limits:compileLimits},
    start.deadline_at.getTime(),heartbeat);
   if(result.status!=='CHECKED'||sha(result.protocol?.function)!==sha(start.request.function)
    ||result.protocol?.functionDigest!==sha(start.request.function)||result.correspondence?.status!=='CHECKED')
    fail('Y4_INDEPENDENT_CORRESPONDENCE_NOT_PASSED');
   // The checker runs again in a fresh process before publication.
   await runPublicChild({action:'check',function:start.request.function,protocol:result.protocol,limits:compileLimits},
    start.deadline_at.getTime(),heartbeat);
   if(!await heartbeat())fail('Y4_PHYSICAL_OR_AUTHORITY_FENCE_LOST');
   await tx(ctx,async c=>{
    const q=await owned(ctx,c,p,e);if(!q)return;
    await c.query(`UPDATE finnor_os.y4_computations SET status='AWAITING_PARTICIPANTS',
     protocol=$3::jsonb,correspondence=$4::jsonb WHERE tenant_id=$1 AND id=$2`,
    [q.tenant_id,q.id,JSON.stringify(result.protocol),JSON.stringify(result.correspondence)]);
    await eventTx(c,q,p.principalId,'CORRESPONDENCE_CHECKED','checked:'+e.deliveryAttemptId,
     {protocolDigest:sha(result.protocol),correspondence:result.correspondence,protectedAdmission:false,executionAuthorityGranted:false});
   });
  }else{
   const start=await tx(ctx,async c=>{
    const q=await owned(ctx,c,p,e);if(!q)return null;
    if(p.stage==='EXECUTE'&&q.status==='RUNNING'){
     // A redelivery cannot repeat any session that may have accepted input.
     await c.query("UPDATE finnor_os.y4_computations SET status='RECONCILIATION_REQUIRED' WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id]);
     await eventTx(c,q,p.principalId,'POSSIBLE_INPUT_DELIVERY','uncertain:'+e.deliveryAttemptId,
      {automaticResubmission:false,disclosureRefunded:false,requiresReadOnlyParticipantStatus:true});
     return null;
    }
    const bundle=await publicBundle(c,q),configuration=await runtimeConfiguration(q.tenant_id,q.request.function.participants);
    const remaining=q.request.limits.maxCpuSeconds-q.cpu_reserved_seconds;
    const cpuReservation=p.stage==='EXECUTE'?Math.floor(remaining*0.9):Math.min(remaining,32);
    const minimum=minimumNativeCpu(configuration.agents.length);
    if(cpuReservation<(p.stage==='EXECUTE'?minimum:4))fail('Y4_ORIGINAL_CPU_BUDGET_EXHAUSTED');
    await reserveCpuTx(c,q,cpuReservation);
    if(p.stage==='EXECUTE')await c.query("UPDATE finnor_os.y4_computations SET status='RUNNING' WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id]);
    await eventTx(c,q,p.principalId,p.stage==='EXECUTE'?'NATIVE_STARTED':'RECONCILIATION_STARTED','native:'+p.stage+':'+e.deliveryAttemptId,
     {jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,sessionId:q.session!.sessionId,
      originalDeadlineAt:q.deadline_at.toISOString(),automaticResubmission:false,leases:leases.map(({token:_,...l})=>l)});
    return {q,bundle,configuration,cpuReservation};
   });if(!start)return;
   const request={action:p.stage==='RECONCILE'?'reconcile':'execute',bundle:start.bundle,backend:start.configuration.backend,
    agents:start.configuration.agents,output:join(start.configuration.scratch,start.q.tenant_id,start.q.id,'session-'+start.q.session!.sessionId),
    portBase:29000,limits:{...start.q.request.limits,maxCpuSeconds:start.cpuReservation}};
   const result=await runPublicChild(request,p.stage==='RECONCILE'?Date.now()+15000:start.q.deadline_at.getTime(),heartbeat);
   if(result.status!=='COMPUTED'){
    if(p.stage!=='RECONCILE')fail('Y4_NATIVE_DID_NOT_COMPLETE');
    await tx(ctx,async c=>{const q=await owned(ctx,c,p,e);if(q)await eventTx(c,q,p.principalId,'RECONCILIATION_UNRESOLVED','reconcile-result:'+e.deliveryAttemptId,
     {state:result.status,automaticResubmission:false,disclosureRefunded:false,originalResponsibilityRetained:true});});
    return;
   }
   if(result.receipts?.length!==start.q.request.function.participants.length||result.outputs!=='RECIPIENT_LOCAL_ONLY'
    ||new Set(result.receipts.map((r:any)=>r.participantId)).size!==result.receipts.length
    ||result.receipts.some((r:any)=>r.state!=='COMPLETED'||r.sessionId!==start.q.session!.sessionId
     ||!start.q.request.function.participants.some(p=>p.id===r.participantId)
     ||r.bindingDigest!==sha(start.bundle.binding)||r.programDigest!==sha(result.program)
     ||r.functionDigest!==start.q.protocol!.functionDigest||r.physicalProcessStopped!==true||r.preprocessingReusePermitted!==false
     ||r.nativeIndependentlyReconstructed!==true||!/^[a-f0-9]{64}$/.test(r.nativeVerificationDigest??'')))
    fail('Y4_COMPLETE_AUTHENTICATED_PARTICIPANT_RECEIPTS_REQUIRED');
   const common=result.receipts[0].outputCommitments;
   const recipients=start.q.request.function.participants.filter(p=>start.q.request.function.outputs.some(o=>o.recipients.includes(p.id))).map(p=>p.id);
   if(!common||sha(Object.keys(common).sort())!==sha([...recipients].sort())
    ||Object.values(common).some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))
    ||result.receipts.some((r:any)=>sha(r.outputCommitments)!==sha(common)||r.outputCommitment!==(common[r.participantId]??null)))
    fail('Y4_ALL_PARTICIPANTS_MUST_AUTHENTICATE_OUTPUT_COMMITMENTS');
   if(!await heartbeat())fail('Y4_PHYSICAL_OR_AUTHORITY_FENCE_LOST');
   await tx(ctx,async c=>{
    const q=await owned(ctx,c,p,e);if(!q)return;
    await allCurrentTx(ctx,c,q);
    await c.query("UPDATE finnor_os.y4_computations SET status='COMPUTED',runtime_receipt=$3::jsonb WHERE tenant_id=$1 AND id=$2",
     [q.tenant_id,q.id,JSON.stringify(result)]);
    await eventTx(c,q,p.principalId,'NATIVE_COMPUTED','computed:'+e.deliveryAttemptId,
     {sessionId:q.session!.sessionId,programDigest:sha(result.program),outputRecipientsOnly:true,wallSeconds:result.wallSeconds,
      moneyUSD:null,humanSeconds:null,aggregatePeakMemoryBytes:null,qualification:'LOCAL_ENGINEERING_ONLY',protectedAdmission:false});
   });
  }
 }catch(error){
  if(error instanceof ComputeCapacityUnavailableError&&!dispatched){
   await tx(ctx,async c=>{
    const q=await owned(ctx,c,p,e);if(!q)return;
    await eventTx(c,q,p.principalId,'PHYSICAL_CAPACITY_DEFERRED','capacity-deferred:'+e.deliveryAttemptId,
     {jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,stage:p.stage,
      computationStatus:q.status,generation:q.generation,handlerDispatched:false,
      cpuReservedSeconds:q.cpu_reserved_seconds,inputDelivered:false});
   });
   throw error;
  }
  try{await tx(ctx,async c=>{
   await physical(c,e,p);
   const q=(await c.query<ComputationRow>('SELECT * FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[p.tenantId,p.computationId])).rows[0];
   if(!q||q.generation!==p.generation||['CANCELLED','INVALIDATED','COMPUTED'].includes(q.status))return;
   const message=error instanceof Error?error.message:'';
   const code=error instanceof ApplicationFault?error.code:/^Y4_[A-Z0-9_]+$/.test(message)?message:'Y4_HOST_OPERATION_FAILED';
   const status=q.session?'RECONCILIATION_REQUIRED':'FAILED';
   await c.query('UPDATE finnor_os.y4_computations SET status=$3 WHERE tenant_id=$1 AND id=$2',[q.tenant_id,q.id,status]);
   await eventTx(c,q,p.principalId,'FAILED_OR_UNCERTAIN','failure:'+e.deliveryAttemptId,
    {stage:p.stage,error:code,status,unknownEarlierPhysicalCostPossible:true,originalAllocationRetained:true,
     disclosureRefunded:false,unrelatedS6Effects:'RETAINED',automaticResubmission:false});
  });}catch{/* A lost delivery may not publish over its successor. */}
  throw error;
 }finally{await releaseComputeResourceLeases(leases,'y4_operation_finished').catch(()=>undefined);}
}
