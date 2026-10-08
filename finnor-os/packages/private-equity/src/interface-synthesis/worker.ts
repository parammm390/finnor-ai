import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {sha,stable,tx} from '../evidence-execution/store';
import {bounded,hash,type GeneratedInterface,type PracticeResult} from './contracts';
import {synthesizeApi} from './compiler';
import {boundedFetch,practiceHttp} from './runtime';
import {synthesizeUi,practiceUi} from './ui';
import {guardUiPage} from './browser';
import {acquisition,assertCurrent,append,attemptRow,practicePort,buildCapability,publish,type AcquisitionRow} from './store';
import {interfaceConsumerPolicy,proposeInterfaceCandidate,currentInterfaceCandidate} from '../../../capability-evolution/src/interface-consumer';
import {makeInterfaceCandidate} from '../../../capability-evolution/src/interface-port';
export async function runInterfaceAcquisitionJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
 if(!execution||execution.protocolVersion!==1||typeof payload.tenantId!=='string'||typeof payload.principalId!=='string'||typeof payload.acquisitionId!=='string'||
  execution.tenantId!==payload.tenantId||execution.retrySafety!=='reconcilable')throw Error('P5_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED');
 // PostgreSQL bigint fences arrive as strings despite the queue's declaration.
 // Validate and normalize the actual claim, never replace it with a caller fence.
 const claimFence=Number(execution.claimFence);
 if(!Number.isSafeInteger(claimFence)||claimFence<1)throw Error('P5_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED');
 execution=Object.freeze({...execution,claimFence});
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'}};
 let row=await acquisition(ctx,payload.acquisitionId);
 if(row.generation!==payload.generation||['CANCELLED','QUARANTINED','FAILED','PROTOTYPE','PRACTICED','SUPPORTED_DISPOSABLE','DISCREPANCY','UNKNOWN'].includes(row.status))return;
 let leases:Awaited<ReturnType<typeof acquireComputeResourceLeases>>=[],released=false;
 try{
  if(process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('P5_ORDINARY_RUNTIME_REQUIRED');
  const {grant}=await assertCurrent(ctx,row);
  leases=await acquireComputeResourceLeases({tenantId:row.tenant_id,resourceKeys:['native:p5'],requiredResourceKeys:['native:p5'],workloadClass:'INTERACTIVE',ownerId:'p5:'+execution.deliveryAttemptId});
  execution.registerHeartbeat(async()=>released||await renewComputeResourceLeases(leases));
  const prior=await attemptRow(ctx,row);
  if(prior?.possible_egress){
   await tx(ctx,async c=>{await c.query("UPDATE finnor_os.p5_acquisitions SET status='UNKNOWN',reason='P5_POSSIBLE_EGRESS_READ_ONLY_RECOVERY_REQUIRED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[row.tenant_id,row.principal_id,row.id]);await append(ctx,row,'REDELIVERY_RECONCILIATION_REQUIRED',{originalAttempt:prior.body,mutationReplay:false},c);});
   return;
  }
  row=await tx(ctx,async c=>{
   const locked=await acquisition(ctx,row.id,c,true);
   const job=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='run_interface_acquisition_v1' AND status='running' AND protocol_version=1 AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE",[row.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
   if(!job||locked.generation!==payload.generation||!['QUEUED','RUNNING'].includes(locked.status))throw Error('P5_JOB_CLAIM_OR_GENERATION_FENCED');
   await assertCurrent(ctx,locked,c);
   const debit=await c.query('UPDATE finnor_os.p5_episodes SET attempts_used=attempts_used+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND attempts_used<4 AND deadline_at>clock_timestamp() RETURNING id',[row.tenant_id,row.principal_id,row.episode_id]);
   if(!debit.rowCount)throw Error('P5_ORIGINAL_LEARNING_BOUND_EXHAUSTED');
   const updated=(await c.query<AcquisitionRow>("UPDATE finnor_os.p5_acquisitions SET status='RUNNING',claim_token=$4,claim_fence=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 RETURNING *",[row.tenant_id,row.principal_id,row.id,execution.claimToken,execution.claimFence])).rows[0]!;
   await append(ctx,updated,'LEARNING_ATTEMPT',{jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,usd:null,originalEpisode:row.episode_id},c);
   return updated;
  });
  const source=await boundedFetch(new URL(grant.document_path,grant.origin),'GET');bounded(source);
  const sourceDigest=hash(source);
  if(row.source_digest&&row.source_digest!==sourceDigest)throw Error('P5_INTERFACE_WITNESS_CHANGED_DURING_RECOVERY');
  const apiGenerated=synthesizeApi(source,row.request.operation);
  await tx(ctx,async c=>{
   const locked=await acquisition(ctx,row.id,c,true);if(locked.generation!==row.generation||locked.claim_token!==execution.claimToken)throw Error('P5_DISCOVERY_PUBLICATION_FENCED');
   await c.query('UPDATE finnor_os.p5_acquisitions SET source=$4::jsonb,source_digest=$5,generated=$6::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.id,stable(source),sourceDigest,stable(apiGenerated)]);
   await append(ctx,locked,'DISCOVERY_BOUND',{sourceDigest,officialAccessRef:grant.id,readOnly:true,substrate:row.request.substrate,adapterDigest:apiGenerated.adapterModule.digest,observerDigest:apiGenerated.observerModule.digest},c);
  });
  row=await acquisition(ctx,row.id);let generated:GeneratedInterface=apiGenerated,practice:PracticeResult|null=null;
  const port=practicePort(ctx,row,grant,execution);
  if(grant.permit_practice){
   if(row.request.substrate==='API')practice=await practiceHttp(generated,row.request.operation,port,prior?.body);
   else{
    if(!grant.ui_path)throw Error('P5_UI_TEST_ACCESS_UNAVAILABLE');
    const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});
    try{
     const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
     const guard=await guardUiPage(page,port,row.request.operation,grant.ui_path,event=>append(ctx,row,'UI_EGRESS_REFUSED',event).then(()=>{}));
     await page.goto(new URL(grant.ui_path,grant.origin).toString(),{timeout:3000,waitUntil:'networkidle'});
     if(guard.violations.length)throw Error('P5_UI_DISCOVERY_EGRESS_REFUSED');
     generated=await synthesizeUi(page,row.request.operation,apiGenerated);
     await tx(ctx,async c=>{const locked=await acquisition(ctx,row.id,c,true);if(locked.generation!==row.generation||locked.claim_token!==execution.claimToken)throw Error('P5_UI_PUBLICATION_FENCED');await c.query('UPDATE finnor_os.p5_acquisitions SET generated=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.id,stable(generated)]);await append(ctx,locked,'UI_BINDING',{witnessDigest:generated.sourceDigest,adapterDigest:generated.adapterModule.digest,protectedBrowser:false,inputQualification:'HEADLESS_BROWSER_ONLY'},c);});
     row=await acquisition(ctx,row.id);practice=await practiceUi(page,generated,row.request.operation,practicePort(ctx,row,grant,execution),prior?.body);
    }finally{await browser.close();}
   }
  }
  row=await acquisition(ctx,row.id);
  let admission=null;
  const s8=await interfaceConsumerPolicy({tenantId:row.tenant_id,principalId:row.principal_id});
  if(s8&&practice?.status==='VERIFIED'){
   const observer=JSON.parse(generated.observerModule.bytes);
   const candidate=makeInterfaceCandidate({tenantId:row.tenant_id,principalId:row.principal_id,rightsRef:s8.rightsRef,generated,
    domain:{account:grant.account,entities:[row.request.operation.entity],field:row.request.operation.field,unit:'currency',currency:row.request.operation.currency,nullable:observer.nullable,
     validAfter:s8.validAfter,validUntil:new Date(Math.min(grant.valid_until.getTime(),Date.parse(s8.validUntil))).toISOString()},
    evidenceDigests:[sha(practice)],dependencies:s8.sourcePins,proposedAt:new Date().toISOString()});
   await tx(ctx,async c=>{await c.query('UPDATE finnor_os.p5_acquisitions SET s8_candidate=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.id,stable(candidate)]);await append(ctx,row,'S8_CANDIDATE_INTENT',{ref:candidate.ref,qualification:'EXACT_DISPOSABLE_PROPOSAL_NOT_SELF_ADMISSION'},c);});
   await proposeInterfaceCandidate(candidate,s8);
   admission=await currentInterfaceCandidate(candidate,s8,'p5-after-propose:'+row.id);
   row=await acquisition(ctx,row.id);
  }else await append(ctx,row,'S8_PENDING',{predicate:!s8?'S8_AUTHENTICATED_INTERFACE_CONSUMER_CONFIG_REQUIRED':'INDEPENDENT_EXACT_PRACTICE_REQUIRED',admission:null});
  await assertCurrent(ctx,row,undefined,true);
  if(!await renewComputeResourceLeases(leases))throw Error('P5_COMPUTE_LEASE_FENCED');
  await tx(ctx,async c=>{
   const locked=await acquisition(ctx,row.id,c,true);
   await assertCurrent(ctx,locked,c);
   const job=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE",[row.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
   const counts=(await c.query('SELECT attempts_used,deadline_at FROM finnor_os.p5_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE',[row.tenant_id,row.principal_id,row.episode_id])).rows[0];
   if(!job||locked.generation!==row.generation||locked.status!=='RUNNING'||locked.claim_token!==execution.claimToken||Number(locked.claim_fence)!==execution.claimFence||counts.deadline_at.getTime()<=Date.now())throw Error('P5_CAPABILITY_PUBLICATION_FENCED');
   const body=buildCapability(locked,generated,practice,execution,counts.attempts_used,admission);
   await publish(ctx,locked,body,c);
  });
 }catch(error){
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  const reason=String((error as Error).message).match(/^P5_[A-Z0-9_]+$/)?.[0]??'P5_OWNER_OR_RUNTIME_UNAVAILABLE';
  await tx(ctx,async c=>{
   const locked=await acquisition(ctx,row.id,c,true),attempt=await attemptRow(ctx,locked,c);
   await append(ctx,locked,'FAILED_OR_FENCED',{reason,possibleEgress:attempt?.possible_egress??false,originalAttemptId:attempt?.body.id??null,
    receipt:(error as {receipt?:unknown}).receipt??null,diagnosticDigest:(error as {diagnosticDigest?:string}).diagnosticDigest??null,usd:null,liabilityReleased:false},c);
   if(locked.generation===row.generation&&locked.status!=='CANCELLED'&&(!locked.claim_token||locked.claim_token===execution.claimToken))
    await c.query('UPDATE finnor_os.p5_acquisitions SET status=$4,reason=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.id,attempt?.possible_egress?'UNKNOWN':'FAILED',reason]);
  });
 }finally{released=true;if(leases.length)await releaseComputeResourceLeases(leases,'p5_physical_process_completed');}
}
