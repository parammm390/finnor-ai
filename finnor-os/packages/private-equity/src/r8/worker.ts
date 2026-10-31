import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {acquireComputeResourceLeases,releaseComputeResourceLeases,renewComputeResourceLeases,withDatabaseExecutionDeadline} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {hash,SPECIFICATION,type Trial,type CoverageChunk,type SemanticReceipt} from '../../../epistemic-runtime/src/solver-synthesis/contracts';
import {assertDependencies} from '../evidence-execution/store';
import {assertSolverOwnersCurrent} from './owners';
import {tx,solverRow,record,readCapsule,type SolverRow} from './store';
import {unavailable} from '../evidence-execution/store';
import {originalGrant} from './api';
import {runSolverSynthesis,solverRef} from './capsule';
import {withScientificProcessObserver,observeProcessGroupClosed} from '../../../epistemic-runtime/src/solver-synthesis/process';
const payloadSchema=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),requestId:z.string().uuid(),
 generation:z.number().int().positive(),stage:z.literal('SYNTHESIZE')}).strict();
async function principalFence(row:SolverRow,c:import('pg').PoolClient,stage:'CURRENT'|'ACCEPTANCE'|'CAPSULE'='CURRENT'){
 const principal=(await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner' FOR SHARE /* R8_"+stage+"_PRINCIPAL_FENCE */",
  [row.tenant_id,row.principal_id])).rows[0];
 if(!principal)throw unavailable();
}
async function jobFence(ctx:PeMutationContext,row:SolverRow,execution:Readonly<JobExecutionContext>,c:import('pg').PoolClient){
 await principalFence(row,c);
 const claim=(await c.query('SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status=\'running\' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp()',
  [execution.jobId,row.tenant_id,execution.claimToken,Number(execution.claimFence)])).rows[0];
 if(!claim||row.status!=='RUNNING'||row.claim_token!==execution.claimToken||Number(row.claim_fence)!==Number(execution.claimFence))throw Error('R8_JOB_PUBLICATION_FENCED');
 await assertDependencies(ctx,row.binding.dependencies,c,true);
}
export async function runSolverSynthesisJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=payloadSchema.parse(payload);
 if(!execution||execution.protocolVersion!==1||execution.retrySafety!=='locally_idempotent'||execution.tenantId!==p.tenantId||
  !Number.isSafeInteger(Number(execution.claimFence)))throw Error('R8_ACTUAL_DURABLE_CLAIM_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 let row=await solverRow(ctx,p.requestId);if(row.generation!==p.generation||['COMPLETE','CANCELLED','INVALIDATED','UNSUPPORTED'].includes(row.status))return;
 const grant=await originalGrant(ctx,row),attempt=randomUUID(),abort=new AbortController(),cpu=process.cpuUsage(),start=performance.now();
 // Only the actual current queue claim may observe/release predecessor custody.
 await tx(ctx,async c=>{
  await principalFence(row,c);
  const claim=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE",
   [p.tenantId,execution.jobId,execution.claimToken,Number(execution.claimFence)])).rows[0];
  const current=await solverRow(ctx,row.id,c,true);
  if(!claim||current.generation!==p.generation||!['QUEUED','RUNNING','UNKNOWN'].includes(current.status))throw Error('R8_STALE_RECOVERY_CLAIM');
  await assertDependencies(ctx,current.binding.dependencies,c,true);
 });
 // Inspect durable child identities before recovery obtains another scientific
 // permit. Unknown physical custody is never reclassified as empty capacity.
 const leftovers=await tx(ctx,async c=>(await c.query<{body:{group:number;claim:string;ownerId:string;attempt:string};digest:string}>(
  `SELECT s.body,s.digest FROM finnor_os.r8_records s WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category='PROCESS'
   AND NOT EXISTS(SELECT 1 FROM finnor_os.r8_records f WHERE f.tenant_id=s.tenant_id AND f.principal_id=s.principal_id AND f.request_id=s.request_id
   AND f.category='RESOURCE' AND f.record_key=s.record_key)`,[p.tenantId,p.principalId,row.id])).rows,true);
 for(const old of leftovers){
  if(hash(old.body)!==old.digest)throw Error('R8_PHYSICAL_IDENTITY_SUBSTITUTION');
  try{await observeProcessGroupClosed(old.body.group,Date.now()+100);}
  catch{await tx(ctx,c=>c.query("UPDATE finnor_os.r8_requests SET status='UNKNOWN',failure='R8_PRIOR_CHILD_PHYSICALLY_UNOBSERVED',updated_at=clock_timestamp() WHERE id=$1",[row.id]));throw Error('R8_PRIOR_CHILD_PHYSICALLY_UNOBSERVED');}
  await record(ctx,row,'RESOURCE',old.body.claim+':'+old.body.group,{physicalGroupClosed:true,recoveredReadOnly:true,
   finalUsage:'UNKNOWN',usd:null,group:old.body.group});
 }
 // Recovery releases only the precise predecessor permits, after every retained
 // group has actually disappeared. Waiting for a 660-second lease expiry would
 // unnecessarily consume the unchanged Work deadline; resetting it is forbidden.
 const predecessors=await tx(ctx,async c=>(await c.query<{body:{ownerId:string;attempt:string;claim:string};digest:string}>(
  "SELECT body,digest FROM finnor_os.r8_records WHERE request_id=$1 AND category='PROCESS'",[row.id])).rows,true);
 for(const ownerId of new Set(predecessors.map(old=>{
  if(hash(old.body)!==old.digest||old.body.ownerId!=='r8:'+row.id+':'+old.body.attempt)throw Error('R8_PREDECESSOR_PERMIT_IDENTITY');
  return old.body.ownerId;
 }))){
  const owned=await tx(ctx,async c=>(await c.query<{resource_key:string;lease_token:string;fence:string;owner_id:string}>(
   "SELECT resource_key,lease_token,fence,owner_id FROM finnor_os.compute_resource_leases WHERE tenant_key=$1 AND owner_id=$2 AND released_at IS NULL",[p.tenantId,ownerId])).rows,true);
  await releaseComputeResourceLeases(owned.map(lease=>({resourceKey:lease.resource_key,token:lease.lease_token,
   fence:Number(lease.fence),ownerId:lease.owner_id,leaseSeconds:0})),'r8-recovered-predecessor-physical-close-observed');
 }
 if(Date.now()>=Date.parse(grant.deadline_at)||grant.attempts_used>=3){
  await tx(ctx,c=>c.query("UPDATE finnor_os.r8_requests SET status='INCOMPLETE',failure='R8_ORIGINAL_GRANT_EXHAUSTED',updated_at=clock_timestamp() WHERE id=$1",[row.id]));return;
 }
 const ownerId='r8:'+row.id+':'+attempt;
 const leases=await acquireComputeResourceLeases({tenantId:p.tenantId,ownerId,workloadClass:'HEAVY',
  resourceKeys:['provider:r8-scientific'],requiredResourceKeys:['provider:r8-scientific']});
 // Lease expiry must exceed the physical child deadline, even after actual
 // worker death. Renewal does not authorize a longer original Work deadline.
 if(leases.some(lease=>lease.leaseSeconds<630)){
  await releaseComputeResourceLeases(leases,'r8-policy-too-short');throw Error('R8_CAPACITY_LEASE_SHORTER_THAN_PHYSICAL_ORIGINAL_EPISODE');
 }
 let physicallyClosed=true,claimReady=false;const live=new Set<number>();let renewal:Promise<void>|null=null;
 const timer=setInterval(()=>{
  if(renewal)return;
  renewal=(async()=>{if(!await renewComputeResourceLeases(leases))throw Error('R8_CAPACITY_FENCE_LOST');
   if(!claimReady)return;
   const now=await solverRow(ctx,row.id);
   if(now.status==='COMPLETE'&&now.claim_token===execution.claimToken&&Number(now.claim_fence)===Number(execution.claimFence))return;
   if(now.status!=='RUNNING'||now.generation!==p.generation||now.claim_token!==execution.claimToken||
    Number(now.claim_fence)!==Number(execution.claimFence))throw Error('R8_WORK_OR_CLAIM_CHANGED');
  })().catch(error=>abort.abort(error)).finally(()=>{renewal=null;});
 },1000);
 try{
  await assertSolverOwnersCurrent(ctx,row.request,row.binding);
  await tx(ctx,async c=>{
   await principalFence(row,c);
   row=await solverRow(ctx,row.id,c,true);
   if(row.generation!==p.generation||!['QUEUED','RUNNING','UNKNOWN'].includes(row.status))throw Error('R8_STALE_DELIVERY');
   await assertDependencies(ctx,row.binding.dependencies,c,true);
   const debited=await c.query('UPDATE finnor_os.r8_grants SET attempts_used=attempts_used+1 WHERE id=$1 AND attempts_used<3 AND deadline_at>clock_timestamp() RETURNING id',[row.grant_id]);
   if(!debited.rowCount)throw Error('R8_ORIGINAL_ATTEMPT_DEBIT_EXHAUSTED');
   await c.query("UPDATE finnor_os.r8_requests SET status='RUNNING',claim_token=$2,claim_fence=$3,updated_at=clock_timestamp() WHERE id=$1",
    [row.id,execution.claimToken,Number(execution.claimFence)]);
   row={...row,status:'RUNNING',claim_token:execution.claimToken,claim_fence:Number(execution.claimFence)};
   await jobFence(ctx,row,execution,c);
  });
  claimReady=true;
  execution.registerHeartbeat(async()=>{
   try{return await tx(ctx,async c=>{const current=await solverRow(ctx,row.id,c);
    if(current.status==='COMPLETE'&&current.claim_token===execution.claimToken&&Number(current.claim_fence)===Number(execution.claimFence))return true;
    await jobFence(ctx,current,execution,c);return true;});}catch{abort.abort();return false;}
  }, { leaseSeconds: Math.min(...leases.map(lease => lease.leaseSeconds)) });
  let evidenceRequest=row.id;
  if(row.parent_request_id){
   const parent=await solverRow(ctx,row.parent_request_id);
   if(parent.work_id!==row.work_id||parent.grant_id!==row.grant_id)throw Error('R8_PARENT_ORIGINAL_GRANT_SUBSTITUTION');
   const accepted=await readCapsule(ctx,parent);
   if(accepted)evidenceRequest=parent.id;
  }
  const prior=await tx(ctx,async c=>(await c.query<{category:string;body:unknown;digest:string}>(
   "SELECT category,body,digest FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category IN('TRIAL','CANDIDATE','CHUNK','QUERY') ORDER BY created_at,record_key",
   [p.tenantId,p.principalId,evidenceRequest])).rows,true);
  for(const stored of prior)if(hash(stored.body)!==stored.digest)throw Error('R8_RETAINED_EVIDENCE_SUBSTITUTION');
  const retainedTrials=prior.filter(stored=>stored.category==='TRIAL').map(stored=>stored.body as Trial);
  const candidates=prior.filter(stored=>stored.category==='CANDIDATE').map(stored=>stored.body as Trial);
  const retainedCandidate=[...candidates].reverse().find(candidate=>!retainedTrials.some(trial=>trial.round===candidate.round));
  const retainedChunks=retainedCandidate?prior.filter(stored=>stored.category==='CHUNK').map(stored=>stored.body as CoverageChunk)
   .filter(chunk=>chunk.programDigest===hash(retainedCandidate.program)&&chunk.moduleDigest===retainedCandidate.module.compiledDigest):[];
  const receipts=prior.filter(stored=>stored.category==='QUERY').map(stored=>stored.body as {operation?:string;receipt?:SemanticReceipt})
   .filter(event=>event.operation==='WHOLE_DOMAIN_ACCEPTANCE'&&event.receipt).map(event=>event.receipt!);
  const acceptedTrials=retainedTrials.filter(trial=>trial.status==='ACCEPTED').sort((a,b)=>
   a.module.bounds.bytes-b.module.bounds.bytes||a.module.bounds.steps-b.module.bounds.steps||
   Buffer.byteLength(JSON.stringify(a.program))-Buffer.byteLength(JSON.stringify(b.program)));
  const acceptedTrial=acceptedTrials.find(trial=>receipts.some(receipt=>receipt.programDigest===hash(trial.program)));
  const retainedIncumbent=acceptedTrial?{trial:acceptedTrial,receipt:receipts.find(receipt=>receipt.programDigest===hash(acceptedTrial.program))!}:undefined;
  if(grant.rounds_used>=grant.max_rounds&&!retainedCandidate&&!retainedIncumbent)throw Error('R8_ORIGINAL_ROUND_DEBIT_EXHAUSTED');
  const work={id:row.work_id,revision:row.work_input_id,inputDigest:row.work_input_digest};
  const envelope={tenantId:p.tenantId,principalId:p.principalId,sharingScope:'PRIVATE_PRINCIPAL' as const,work,
   baselineManifest:{commit:'4a90ed33ca96afa252c51f511fea279e0034cddb',tree:'310a43fa2b7983bf33afc321795461c9678ce7f9'},
   producer:{sourcePins:row.binding.sourcePins,codeDigest:hash(row.binding.sourcePins),
    lockDigest:row.binding.sourcePins.find(pin=>pin.path.endsWith('/finnor-os/package-lock.json'))!.sha256,admission:null},
   ownerInputs:row.binding.ownerInputs,problemRef:row.binding.problem.ref,domainProfileRef:solverRef('domain-profile',SPECIFICATION),
   budgetGrantRef:solverRef('original-grant',{id:grant.id,deadlineAt:grant.deadline_at,maxRounds:grant.max_rounds}),cancellationRef:solverRef('cancellation-generation',{requestId:row.id,generation:row.generation}),
   originalDeadlineAt:grant.deadline_at,parentRequestId:row.parent_request_id};
  const current=async()=>{if(abort.signal.aborted)throw Error('R8_CANCEL_OR_CLAIM_ABORT');await assertSolverOwnersCurrent(ctx,row.request,row.binding);
   await tx(ctx,c=>jobFence(ctx,row,execution,c));};
  const retain=async(category:string,key:string,body:unknown)=>tx(ctx,async c=>{
   await principalFence(row,c);
   const locked=await solverRow(ctx,row.id,c,true);await jobFence(ctx,locked,execution,c);return record(ctx,row,category,key,body,c);
  });
  const result=await withScientificProcessObserver({
   started:async(group,identity)=>{physicallyClosed=false;live.add(group);
    await retain('PROCESS',execution.claimToken+':'+group,{group,claim:execution.claimToken,identity,originalDeadlineAt:grant.deadline_at,attempt,ownerId});},
   closed:async(group,resource)=>{await record(ctx,row,'RESOURCE',execution.claimToken+':'+group,{...resource,group});
    live.delete(group);physicallyClosed=live.size===0;},
  },()=>runSolverSynthesis({envelope_inputs:envelope,problem_ref:envelope.problemRef,existing_work_revision:work,
   domain_profile_ref:envelope.domainProfileRef,budget_grant_ref:envelope.budgetGrantRef,cancellation_ref:envelope.cancellationRef},
   row.binding.projection!,{signal:abort.signal,maximumRounds:grant.max_rounds-grant.rounds_used,retainedTrials,
    retainedCandidate,retainedChunks,retainedIncumbent,
    hooks:{current,onQuery:event=>retain('QUERY',attempt+':'+hash(event),event).then(()=>undefined),
     onCandidate:async trial=>{await tx(ctx,async c=>{await principalFence(row,c);
      const locked=await solverRow(ctx,row.id,c,true);await jobFence(ctx,locked,execution,c);
      const debited=await c.query('UPDATE finnor_os.r8_grants SET rounds_used=rounds_used+1 WHERE id=$1 AND rounds_used<max_rounds RETURNING id',[row.grant_id]);
      if(!debited.rowCount)throw Error('R8_ORIGINAL_ROUND_DEBIT_EXHAUSTED');await record(ctx,row,'CANDIDATE',String(trial.round),trial,c);});},
     onTrial:trial=>retain('TRIAL',String(trial.round),trial).then(()=>undefined),
     onAcceptance:async(trial,receipt)=>{await tx(ctx,async c=>{
      await principalFence(row,c,'ACCEPTANCE');
      const locked=await solverRow(ctx,row.id,c,true);await jobFence(ctx,locked,execution,c);
      const event={operation:'WHOLE_DOMAIN_ACCEPTANCE',programDigest:hash(trial.program),receipt};
      await record(ctx,row,'QUERY',attempt+':'+hash(event),event,c);
      await record(ctx,row,'TRIAL',String(trial.round),trial,c);
     });},
     onChunk:chunk=>retain('CHUNK',hash({program:chunk.programDigest,module:chunk.moduleDigest,checker:chunk.checkerDigest})+':'+String(chunk.start),chunk).then(()=>undefined)}}));
  await current();
  if(!result.artifact)throw Error('R8_'+result.status+':'+result.unresolvedClaims.map(gap=>gap.reason).join(',')+
   (physicallyClosed?'':':R8_PHYSICAL_LIABILITY_RETAINED'));
  if(!physicallyClosed)throw Error('R8_PUBLICATION_BEFORE_PHYSICAL_CLOSE');
  await tx(ctx,async c=>{
   await principalFence(row,c,'CAPSULE');
   const locked=await solverRow(ctx,row.id,c,true);await jobFence(ctx,locked,execution,c);
   const digest=await record(ctx,row,'CAPSULE',result.artifact!.ref.contentDigest,result.artifact,c);
   await record(ctx,row,'PUBLICATION',attempt,{capsuleRef:result.artifact!.ref,semantic:'DEVELOPMENT_MODEL_RELATIVE_PASS',
    domain:'UNQUALIFIED',admission:'SEPARATE_OWNER_REQUIRED',activation:'NOT_ACTIVATED',protected:false,
    cpu:process.cpuUsage(cpu),wallMs:performance.now()-start,usd:null,aggregatePeakMemoryBytes:null},c);
   await c.query("UPDATE finnor_os.r8_requests SET status='COMPLETE',capsule_digest=$2,failure=NULL,updated_at=clock_timestamp() WHERE id=$1",[row.id,digest]);
  });
 }catch(error){
  abort.abort();await withDatabaseExecutionDeadline(performance.now()+1000,()=>tx(ctx,async c=>{
   const locked=await solverRow(ctx,row.id,c,true);
   await record(ctx,row,'PUBLICATION','failed:'+attempt,{reason:error instanceof Error?error.message:'R8_FAILURE',
    outstandingProcessGroups:[...live],abortReason:abort.signal.reason instanceof Error?abort.signal.reason.message:null,
    finalPhysicalUsage:physicallyClosed?'OBSERVED':'UNKNOWN_RETAINED',cpu:process.cpuUsage(cpu),wallMs:performance.now()-start,usd:null},c);
   if(locked.status==='RUNNING'&&locked.claim_token===execution.claimToken&&Number(locked.claim_fence)===Number(execution.claimFence))
    await c.query("UPDATE finnor_os.r8_requests SET status=$2,failure=$3,updated_at=clock_timestamp() WHERE id=$1",
     [row.id,physicallyClosed?'INCOMPLETE':'UNKNOWN',error instanceof Error?error.message:'R8_FAILURE']);
  }));
 }finally{
  clearInterval(timer);abort.abort();if(renewal)await renewal;
  // An unobserved child leaves the original non-overlapping lease charged.
  if(physicallyClosed)await releaseComputeResourceLeases(leases,'r8-physical-close-observed');
 }
}
