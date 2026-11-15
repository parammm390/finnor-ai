import type {PoolClient} from 'pg';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError,type ComputeResourceLease} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {currentLearningEnvironment} from './source-cut';
import {JobSchema,CheckpointSchema,sha,fail} from './contracts';
import type {LearningJob} from './contracts';
import {compilePolicy} from './abstraction';
import {loadController,type trainController} from './controller';
import {resolveAcceptedLearningExperienceTx} from '../../../capability-evolution/src/learning-experience';
import {tx,compilationTx,releaseTx,assertAllocation,assertWorkTx,assertReleaseCurrentTx,currentTrainingRequestTx,eventTx,newId,type CompilationRow,type UseRow,type EvaluationRow} from './store';
import {runLearningChild} from './process';
import {executeLearnedUse} from './consumer';
import {evaluateNativeLearningOutcomes} from './evaluation';
import type {LearningRelease} from './types';
import {ApplicationFault} from '../enterprise-applications/contracts';
import {assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';

async function physical(c:PoolClient,e:Readonly<JobExecutionContext>,p:LearningJob){
 const rows=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type='compile_learned_policy_v1' AND j.status='running'
   AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
   AND d.id=$5 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.outcome='running'
   AND j.payload=$6::jsonb FOR SHARE OF j,d`,[e.jobId,p.tenantId,e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p)]);
 if(rows.rowCount!==1)fail('X5_PHYSICAL_DELIVERY_FENCE');
}
async function owned(ctx:PeMutationContext,c:PoolClient,p:LearningJob,e:Readonly<JobExecutionContext>){
 const capability=p.stage==='TRAIN'?'action:compile_learned_policy':p.stage==='EXECUTE'?'action:execute_learned_policy':'action:evaluate_learned_policy';
 const a=await compilationTx(ctx,c,p.compilationId,capability);await physical(c,e,p);
 if(a.generation!==p.generation||['CANCELLED','INVALIDATED'].includes(a.status))return null;
 assertAllocation(a);await assertWorkTx(c,a);
 if(p.stage==='TRAIN'){
  if(a.owner_id!==p.principalId)fail('X5_JOB_OWNER_MISMATCH');
  if(a.status==='DEVELOPMENT_READY'||a.status==='FAILED')return null;
 }else if(p.stage==='EXECUTE'){
  const row=(await c.query<UseRow>('SELECT * FROM finnor_os.x5_uses WHERE tenant_id=$1 AND compilation_id=$2 AND id=$3 FOR UPDATE',[p.tenantId,a.id,p.useId])).rows[0];
  if(!row||row.principal_id!==p.principalId)fail('X5_JOB_USE_MISMATCH');
  if(!['QUEUED','RUNNING'].includes(row.status))return null;
 }else{
  const row=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND compilation_id=$2 AND id=$3 FOR UPDATE',[p.tenantId,a.id,p.evaluationId])).rows[0];
  if(!row||row.evaluator_id!==p.principalId)fail('X5_JOB_EVALUATOR_MISMATCH');
  if(!['QUEUED','RUNNING'].includes(row.status))return null;
 }
 return a;
}
export async function compileLearnedPolicyJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=JobSchema.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('X5_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 let leases:ComputeResourceLease[]=[];
 try{
  if(process.env.FINNOR_ENVIRONMENT==='production'||process.env.NODE_ENV==='production'&&!['development','ordinary_disposable'].includes(process.env.FINNOR_ENVIRONMENT??''))fail('X5_PRODUCTION_UNADMITTED',403);
  const current=await tx(ctx,c=>owned(ctx,c,p,e));if(!current)return;
  const environment=await currentLearningEnvironment();
  if(sha(environment)!==sha(current.environment))fail('X5_DEPENDENCY_OR_DEPLOYMENT_CHANGED');
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:x5-learning'],requiredResourceKeys:['native:x5-learning'],workloadClass:'INTERACTIVE',ownerId:'x5:'+e.deliveryAttemptId});
  const heartbeat=async()=>!!await renewComputeResourceLeases(leases)&&tx(ctx,async c=>!!await owned(ctx,c,p,e));
  e.registerHeartbeat(heartbeat, { leaseSeconds: Math.min(...leases.map(lease => lease.leaseSeconds)) });
  if(p.stage==='TRAIN'){
   const started=await tx(ctx,async c=>{
    const a=await owned(ctx,c,p,e);if(!a)return null;
    if(a.attempt_count>=a.max_attempts)fail('X5_ORIGINAL_TRAINING_ATTEMPTS_EXHAUSTED');
    await c.query("UPDATE finnor_os.x5_compilations SET status='TRAINING',attempt_count=attempt_count+1 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);a.attempt_count++;
    await eventTx(c,a,p.principalId,'TRAINING_STARTED','train-start:'+e.deliveryAttemptId,{jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,attempt:a.attempt_count,deadlineAt:a.deadline_at.toISOString(),money:null,aggregatePeakMemory:null,leases:leases.map(({token:_,...v})=>v)});
    return a;
   });if(!started)return;
   const prepared=await tx(ctx,async c=>{
    const a=await owned(ctx,c,p,e);if(!a)return null;
    const request=await currentTrainingRequestTx(c,a),experience=await resolveAcceptedLearningExperienceTx(ctx,c,request.experience,request.knowledgeCut);
    if(experience.acceptedCount<8)fail('X5_MINIMUM_INDEPENDENT_NATIVE_EXPERIENCE_REQUIRED');
    await eventTx(c,a,p.principalId,'EXPERIENCE_RESOLVED','experience:'+e.deliveryAttemptId,{knowledgeCut:experience.knowledgeCut,experienceCutDigest:experience.cutDigest,partitionDigest:experience.partitionDigest,sampleCount:experience.samples.length});
    return {a,experience,request};
   });if(!prepared)return;
   const result=await runLearningChild({operation:'TRAIN',samples:prepared.experience.samples,deadline:Math.min(prepared.a.deadline_at.getTime(),Date.now()+30000)},prepared.a.deadline_at.getTime(),heartbeat);
   await tx(ctx,async c=>{const a=await owned(ctx,c,p,e);if(a)await eventTx(c,a,p.principalId,'TRAINING_METRICS','train-metrics:'+e.deliveryAttemptId,{...result.resources,error:result.error??null,unknownEarlierPhysicalCostPossible:a.attempt_count>1});});
   if(!result.ok||!result.result)fail(result.error??'X5_TRAINING_CHILD_FAILED');
   const trained=result.result as ReturnType<typeof trainController>;
   CheckpointSchema.parse(trained.original);CheckpointSchema.parse(trained.checkpoint);
   loadController(trained.original,trained.original.digest);loadController(trained.checkpoint,trained.checkpoint.digest);
   if(trained.original.digest===trained.checkpoint.digest||trained.samplesDigest!==sha(prepared.experience.samples)||trained.parameterChange.changed<1)fail('X5_TRAINING_NOT_BOUND_TO_REAL_PARAMETERS');
   if(sha(await currentLearningEnvironment())!==sha(environment)||!await renewComputeResourceLeases(leases))fail('X5_PUBLICATION_RUNTIME_OR_COMPUTE_CHANGED');
   await tx(ctx,async c=>{
    const a=await owned(ctx,c,p,e);if(!a)return;
    const request=await currentTrainingRequestTx(c,a),temporalBounds=[a.deadline_at.toISOString()],experience=await resolveAcceptedLearningExperienceTx(ctx,c,request.experience,request.knowledgeCut,temporalBounds);
    if(experience.cutDigest!==prepared.experience.cutDigest)fail('X5_EXPERIENCE_CHANGED_DURING_TRAINING');
    const policy=compilePolicy(a.deadline_at.toISOString(),a.max_uses),id=newId(),release:LearningRelease={
     schema:'finnor.x5.immutable-learning-release.v1',id,compilationId:a.id,tenantId:a.tenant_id,principalId:a.owner_id,policy,policyDigest:sha(policy),
     originalCheckpoint:trained.original,checkpoint:trained.checkpoint,training:trained,experience,selections:request.experience,environment,resources:result.resources,
     createdAt:new Date().toISOString(),job:{jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,workerId:e.workerId},
     developmentOnly:true,protectedAdmission:false,productionActive:false};
    await c.query('INSERT INTO finnor_os.x5_releases(tenant_id,id,compilation_id,attempt,body,body_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[a.tenant_id,id,a.id,a.attempt_count,JSON.stringify(release),sha(release)]);
    await c.query("UPDATE finnor_os.x5_compilations SET status='DEVELOPMENT_READY',head_release_id=$3 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,id]);
    await eventTx(c,a,p.principalId,'RELEASE_PUBLISHED_DEVELOPMENT','published:'+id,{releaseId:id,releaseDigest:sha(release),policyDigest:release.policyDigest,checkpointDigest:trained.checkpoint.digest,originalCheckpointDigest:trained.original.digest,protectedAdmission:false,productionActive:false});
    await assertAuthorityTemporalBoundsTx(c,temporalBounds);
   });
  }else if(p.stage==='EXECUTE'){
   const start=await tx(ctx,async c=>{
    const a=await owned(ctx,c,p,e);if(!a)return null;
    const u=(await c.query<UseRow>('SELECT * FROM finnor_os.x5_uses WHERE tenant_id=$1 AND id=$2',[a.tenant_id,p.useId])).rows[0]!,r=await releaseTx(c,a,u.release_id);
    await assertReleaseCurrentTx(ctx,c,a,r,u.request.applicationId);
    await c.query("UPDATE finnor_os.x5_uses SET status='RUNNING' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,u.id]);return {a,u,r};
   });if(!start)return;
   await executeLearnedUse(ctx,start.a,start.u,start.r,async c=>{if(!await owned(ctx,c,p,e))fail('X5_INVOCATION_ABORTED_OR_FENCED');},heartbeat);
  }else{
   await tx(ctx,async c=>{
    const a=await owned(ctx,c,p,e);if(!a)return;
    const evaluation=(await c.query<EvaluationRow>('SELECT * FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[a.tenant_id,p.evaluationId])).rows[0]!,r=await releaseTx(c,a,evaluation.release_id);
    const temporalBounds=await assertReleaseCurrentTx(ctx,c,a,r);
    const result=await evaluateNativeLearningOutcomes(ctx,c,a,r,evaluation,temporalBounds);
    await physical(c,e,p);assertAllocation(a);
    await c.query("UPDATE finnor_os.x5_evaluations SET status='COMPLETE',result=$3::jsonb WHERE tenant_id=$1 AND id=$2",[a.tenant_id,evaluation.id,JSON.stringify(result)]);
    await eventTx(c,a,p.principalId,'EVALUATION_COMPLETED','evaluation-completed:'+evaluation.id,{evaluationId:evaluation.id,resultsDigest:sha(result),disposition:result.disposition,physicalJobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,completeLifecycleCost:result.completeLifecycleCost});
    await assertAuthorityTemporalBoundsTx(c,temporalBounds);
   });
  }
 }catch(error){
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  try{await tx(ctx,async c=>{
   await physical(c,e,p);
   const a=(await c.query<CompilationRow>('SELECT * FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[p.tenantId,p.compilationId])).rows[0];
   if(!a||a.generation!==p.generation||['CANCELLED','INVALIDATED'].includes(a.status))return;
   const failure=error as {message?:string;physicalPid?:number;exitCode?:number|null;signal?:string|null;supervisorWallMs?:number;sampledPeakRSSBytes?:number;outputBytes?:number};
   const code=error instanceof ApplicationFault?error.code:/^X5_[A-Z_]+$/.test(failure.message??'')?failure.message!:'X5_HOST_OPERATION_FAILED';
   const physicalReceipt=failure.physicalPid?{pid:failure.physicalPid,exitCode:failure.exitCode??null,signal:failure.signal??null,
    supervisorWallMs:failure.supervisorWallMs??null,sampledPeakRSSBytes:failure.sampledPeakRSSBytes??null,outputBytes:failure.outputBytes??null}:null;
   if(p.stage==='TRAIN')await c.query("UPDATE finnor_os.x5_compilations SET status='FAILED' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
   else await c.query(p.stage==='EXECUTE'?"UPDATE finnor_os.x5_uses SET status='FAILED',result=$3::jsonb WHERE tenant_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING')":"UPDATE finnor_os.x5_evaluations SET status='FAILED',result=$3::jsonb WHERE tenant_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING')",[a.tenant_id,p.stage==='EXECUTE'?p.useId:p.evaluationId,JSON.stringify({error:code,originalIdentityRetained:true,unknownPhysicalCostPossible:true})]);
   await eventTx(c,a,p.principalId,'OPERATION_FAILED','failure:'+e.deliveryAttemptId,{stage:p.stage,error:code,physicalReceipt,unknownPhysicalCostPossible:true,originalAllocationRetained:true});
  });}catch{/* A lost physical delivery cannot overwrite its successor. */}
  throw error;
 }finally{await releaseComputeResourceLeases(leases,'x5_operation_finished').catch(()=>undefined);}
}
