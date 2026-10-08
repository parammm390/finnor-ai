import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DatabaseExecutionDeadlineError} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {authorize,principal,sha,stable,tx,unavailable} from '../evidence-execution/store';
import {requestRow,assertProgramCurrent,enqueueProgram} from '../program-synthesis/store';
import {resolveSearchOwners} from './owners';
import {ComputeSearchRequestSchema,SearchIdSchema,SearchProjectionSchema,boundedDecode} from './contracts';
import {searchRow,currentSearch,append,snapshot,readStoredPlan,units} from './store';
import {replan} from './controller';
import {validateDeliberationBinding} from '../deliberation/store';
export const COMPUTE_SEARCH_OPERATIONS=['compute-search-submit','compute-search-read','compute-search-projection','compute-search-cancel','compute-search-resume','compute-search-reconcile'] as const;
export async function readComputeSearch(ctx:PeMutationContext,id:string){
 let s=await searchRow(ctx,id);const q=await requestRow(ctx,s.program_id);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 if(!['CANCELLED','INVALIDATED'].includes(s.status)){
  try{await currentSearch(ctx,s,q);}catch(error){
   // Authorization failure remains indistinguishable from an absent private resource.
   if((error as any).code==='PE_ENTITY_NOT_FOUND')throw unavailable();
   if(error instanceof DatabaseExecutionDeadlineError)throw error;
   const reason=String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'P2_OWNER_CURRENTNESS_UNPASSED';
   await tx(ctx,async c=>{const locked=await searchRow(ctx,s.id,c,true);if(locked.status!=='CANCELLED'){
    locked.status='INVALIDATED';locked.reason=reason;locked.generation++;
    await c.query("UPDATE finnor_os.p2_requests SET status='INVALIDATED',reason=$4,generation=generation+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[s.tenant_id,s.principal_id,s.id,reason]);
    await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status IN('PENDING','QUEUED')",[s.tenant_id,s.principal_id,s.id]);
    await append(ctx,locked,'INVALIDATED',{predicate:reason,priorHead:s.head_id,exposureRetained:true},c);await snapshot(ctx,locked,q,c);
   }});s=await searchRow(ctx,id);
  }
 }
 const plan=await readStoredPlan(ctx,s);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 return {schema:'finnor.p2.current-reader.v1',searchId:s.id,programId:q.id,status:s.status,reason:s.reason,plan,protectedAdmission:false};
}
export async function handleComputeSearchOperation(ctx:PeMutationContext,operation:string,body:unknown):Promise<{status:number;body:unknown}>{
 try{
  boundedDecode(body);
  if(operation==='compute-search-submit'){
   const request=ComputeSearchRequestSchema.parse(body),q=await requestRow(ctx,request.programId);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
   await validateDeliberationBinding(ctx,q,request);
   if(request.mode!=='ordinary_disposable'||process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('P2_PROTECTED_FUNDING_AND_RUNTIME_UNAVAILABLE');
   const binding=await resolveSearchOwners(ctx,q,request),digest=sha(request);
   const accepted=await tx(ctx,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4702))',[ctx.auth.tenantId+':'+principal(ctx)+':'+request.idempotencyKey]);
    const prior=(await c.query('SELECT * FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
    if(prior){if(prior.request_digest!==digest)throw Error('P2_IDEMPOTENCY_REQUEST_CONFLICT');return {searchId:prior.id,programId:q.id,status:prior.status,replayed:true};}
    const locked=await requestRow(ctx,q.id,c,true);if(!(locked.status==='QUEUED'||locked.status==='WAITING'&&locked.request.computeSearch==='P2_REQUIRED')||locked.evidence_query_id||locked.generation!==1)throw Error('P2_ATTACH_BEFORE_P1_EXECUTION_REQUIRED');
    if((await c.query('SELECT id FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND program_id=$3',[q.tenant_id,q.principal_id,q.id])).rowCount)throw Error('P2_ORIGINAL_PROGRAM_SEARCH_ALREADY_BOUND');
    const id=randomUUID();await c.query('INSERT INTO finnor_os.p2_requests(id,tenant_id,principal_id,program_id,idempotency_key,request_digest,request,binding) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',[id,q.tenant_id,q.principal_id,q.id,request.idempotencyKey,digest,stable(request),stable(binding)]);
    const s=await searchRow(ctx,id,c,true);if(locked.status==='WAITING')await enqueueProgram(ctx,locked,'p2-attached:'+id,c);await append(ctx,s,'ACCEPTED',{originalEpisode:q.episode_id,programId:q.id,workInputId:q.work_input_id,computeGrant:binding.computeGrant,resourceEnvelope:binding.resourceEnvelope,loss:binding.loss,ownerBound:true,admissionGranted:false},c);await snapshot(ctx,s,q,c);
    return {searchId:id,programId:q.id,workId:q.work_id,workRevision:q.work_input_id,status:'ACCEPTED',replayed:false};
   });return {status:202,body:accepted};
  }
  if(operation==='compute-search-projection'){
   const input=SearchProjectionSchema.parse(body);await authorize(ctx,input.root as any,[{type:'work',id:input.workId}]);
   const ids=await tx(ctx,async c=>(await c.query('SELECT s.id FROM finnor_os.p2_requests s JOIN finnor_os.p1_requests p ON p.id=s.program_id AND p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id WHERE s.tenant_id=$1 AND s.principal_id=$2 AND p.work_id=$3 ORDER BY s.created_at DESC LIMIT 20',[ctx.auth.tenantId,principal(ctx),input.workId])).rows,true),searches=[];
   for(const row of ids){const s=await searchRow(ctx,row.id);if(input.methodOwner&&(s.request.deliberation?'M2':'P2')!==input.methodOwner)continue;const q=await requestRow(ctx,s.program_id);if(stable(q.request.root)===stable(input.root))searches.push(await readComputeSearch(ctx,s.id));}
   const candidates=await tx(ctx,async c=>(await c.query("SELECT id FROM finnor_os.p1_requests p WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND status IN('QUEUED','WAITING') AND evidence_query_id IS NULL AND NOT EXISTS(SELECT 1 FROM finnor_os.p2_requests s WHERE s.tenant_id=p.tenant_id AND s.principal_id=p.principal_id AND s.program_id=p.id) ORDER BY created_at DESC LIMIT 20",[ctx.auth.tenantId,principal(ctx),input.workId])).rows,true),eligiblePrograms=[];
   for(const row of candidates){const p=await requestRow(ctx,row.id);if(stable(p.request.root)!==stable(input.root)||!p.request.ownerBindings?.policyRef||!p.request.ownerBindings.allocationRef)continue;await assertProgramCurrent(ctx,p);eligiblePrograms.push({programId:p.id,status:p.status,workRevision:p.work_input_id,policyRequest:p.request.ownerBindings.policyRef,computeGrant:p.request.ownerBindings.allocationRef});}
   await authorize(ctx,input.root as any,[{type:'work',id:input.workId}]);return {status:200,body:{schema:'finnor.p2.work-projection.v1',workId:input.workId,searches,eligiblePrograms}};
  }
  const id=SearchIdSchema.parse(body).searchId;
  if(operation==='compute-search-read')return {status:200,body:await readComputeSearch(ctx,id)};
  const s=await searchRow(ctx,id),q=await requestRow(ctx,s.program_id);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
  if(operation==='compute-search-cancel'){
   await tx(ctx,async c=>{const locked=await searchRow(ctx,id,c,true);if(['CANCELLED','INVALIDATED','STOPPED'].includes(locked.status))return;
    await c.query("UPDATE finnor_os.p1_requests SET status='PARTIAL',generation=generation+1,claim_token=NULL,failure='P2_COMPUTE_CANCELLED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status NOT IN('TESTED','CANCELLED','INVALIDATED')",[q.tenant_id,q.principal_id,q.id]);
    locked.status='CANCELLED';locked.reason='USER_CANCELLED_COMPUTE_ONLY';locked.generation++;
    await c.query("UPDATE finnor_os.p2_requests SET status='CANCELLED',reason=$4,generation=generation+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[s.tenant_id,s.principal_id,s.id,locked.reason]);
    await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status IN('PENDING','QUEUED')",[s.tenant_id,s.principal_id,s.id]);
    await append(ctx,locked,'CANCELLED',{requestedBy:principal(ctx),outstandingDisposition:'RECONCILE_SUBMITTED_DO_NOT_REFUND',businessWorkCancelled:false},c);await snapshot(ctx,locked,q,c);
   });return {status:200,body:await readComputeSearch(ctx,id)};
  }
  if(operation==='compute-search-reconcile'||operation==='compute-search-resume'){
   if(operation==='compute-search-resume'&&['CANCELLED','INVALIDATED','STOPPED'].includes(s.status))throw Error('P2_TERMINAL_SEARCH_CANNOT_RENEW');
   if(!['CANCELLED','INVALIDATED','STOPPED'].includes(s.status))await currentSearch(ctx,s,q);
   const result=await tx(ctx,async c=>{const locked=await searchRow(ctx,id,c,true);const attempts=(await c.query('SELECT a.*,j.status job_status FROM finnor_os.p2_attempts a JOIN finnor_os.jobs j ON j.id=(a.body->>\'jobId\')::uuid WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.search_id=$3 ORDER BY a.created_at,a.id',[s.tenant_id,s.principal_id,s.id])).rows;
    let preAdmissionRecovered=false;
    if(locked.request.deliberation){
     // A failed actual queue delivery can precede admission itself. Prove the
     // absence of physical intent for this exact failed delivery, of any
     // outstanding physical attempt and of any live current delivery. Retain
     // completed historical invocation costs. This does not classify SUBMITTED as failed,
     // refund charges, revive a terminal search, or weaken protocol1 recovery.
     const cuts=(await c.query(`SELECT u.id,j.id job_id,j.status job_status
       FROM finnor_os.p2_units u JOIN finnor_os.jobs j
         ON j.tenant_id=u.tenant_id AND j.payload->>'unitId'=u.id::text
       WHERE u.tenant_id=$1 AND u.principal_id=$2 AND u.search_id=$3
         AND u.generation=$4 AND u.status='QUEUED'
         AND j.type='run_compute_search_unit_v1' AND j.protocol_version=2
         AND j.payload->>'principalId'=u.principal_id::text
         AND j.payload->>'searchId'=u.search_id::text
         AND j.payload->>'generation'=u.generation::text
         AND j.idempotency_key='p2:'||u.search_id::text||':'||u.generation::text||':'||u.id::text||':admission:'||u.attempts::text
         AND j.status IN('quarantined','failed','cancelled','dead_letter')
         AND NOT EXISTS(SELECT 1 FROM finnor_os.p2_attempts a
           WHERE a.tenant_id=u.tenant_id AND a.principal_id=u.principal_id AND a.unit_id=u.id AND a.body->>'jobId'=j.id::text)
         AND NOT EXISTS(SELECT 1 FROM finnor_os.p2_attempts outstanding
           WHERE outstanding.tenant_id=u.tenant_id AND outstanding.principal_id=u.principal_id
             AND outstanding.unit_id=u.id AND outstanding.status IN('INTENT','SUBMITTED','UNKNOWN'))
         AND NOT EXISTS(SELECT 1 FROM finnor_os.jobs live
           WHERE live.tenant_id=u.tenant_id AND live.type='run_compute_search_unit_v1'
             AND live.payload->>'unitId'=u.id::text AND live.payload->>'generation'=u.generation::text
             AND live.status IN('queued','running'))
       ORDER BY u.id,j.run_at,j.id FOR UPDATE OF u`,[s.tenant_id,s.principal_id,s.id,locked.generation])).rows;
     const recovered=new Set<string>();
     for(const cut of cuts){if(recovered.has(cut.id))continue;recovered.add(cut.id);
      const disposition={predicate:'P2_PRE_ADMISSION_DELIVERY_FAILED',jobId:cut.job_id,jobStatus:cut.job_status,physicalCallProvenAbsent:true,attemptChargeApplied:false,localWorkerCostUSD:null,originalEpisode:q.episode_id,originalGrantRetained:true};
      await c.query("UPDATE finnor_os.p2_units SET status='FAILED',result=$2::jsonb,result_digest=$3,claim_token=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='QUEUED'",[cut.id,stable(disposition),sha(disposition)]);
      await append(ctx,locked,'M2_PRE_ADMISSION_DELIVERY_RECONCILED',{unitId:cut.id,...disposition},c);preAdmissionRecovered=true;
     }
    }
    for(const a of attempts.filter(a=>['INTENT','SUBMITTED'].includes(a.status)&&!['queued','running'].includes(a.job_status))){
     // INTENT precedes the durable SUBMITTED cut; no physical call can begin
     // before that cut. Charges stay spent, but unused endpoint occupancy ends.
     const unknown=a.status==='SUBMITTED',body={...a.body,recoveryObservedAt:new Date().toISOString(),physicalOutcome:unknown?'UNKNOWN':'PROVEN_NOT_SUBMITTED_DURABLE_CUT',liabilityRetained:true};
     await c.query('UPDATE finnor_os.p2_attempts SET status=$2,body=$3::jsonb,digest=$4 WHERE id=$1',[a.id,unknown?'UNKNOWN':'FAILED',stable(body),sha(body)]);
     if(!unknown&&a.endpoint_key)await c.query('UPDATE finnor_os.p2_endpoint_windows SET active=active-1 WHERE endpoint_key=$1 AND active>0',[a.endpoint_key]);
     await c.query("UPDATE finnor_os.p2_units SET status=CASE WHEN $2 THEN 'UNKNOWN' WHEN attempts>=CASE WHEN kind='CONTROL_M2' THEN 32 ELSE 2 END THEN 'FAILED' ELSE 'PENDING' END,claim_token=NULL WHERE id=$1 AND status IN('RUNNING','QUEUED')",[a.unit_id,unknown]);
     await append(ctx,locked,'RECOVERY_RECONCILED',{attemptId:a.id,unitId:a.unit_id,unknown,grantChargesRetained:true,unsafeResubmission:false},c);
    }
    if((await units(ctx,locked,c)).some(u=>u.status==='UNKNOWN')){if(['CANCELLED','INVALIDATED','STOPPED'].includes(locked.status))return snapshot(ctx,locked,q,c);locked.status='WAITING';locked.reason='UNKNOWN_PHYSICAL_OUTCOME_REQUIRES_OWNER_PROVIDER_EVIDENCE';await c.query("UPDATE finnor_os.p2_requests SET status='WAITING',reason=$2 WHERE id=$1",[locked.id,locked.reason]);return snapshot(ctx,locked,q,c);}
    if(preAdmissionRecovered&&locked.context&&!['CANCELLED','INVALIDATED','STOPPED','FAILED'].includes(locked.status))return replan(ctx,locked,q,c);
    if(operation==='compute-search-resume'&&locked.context){locked.status='RUNNING';locked.reason=null;await c.query("UPDATE finnor_os.p2_requests SET status='RUNNING',reason=NULL WHERE id=$1",[locked.id]);return replan(ctx,locked,q,c);}
    if(operation==='compute-search-resume'&&!locked.context)await enqueueProgram(ctx,q,'p2-resume:'+locked.id+':'+locked.revision,c);
    return snapshot(ctx,locked,q,c);
   });return {status:operation==='compute-search-resume'?202:200,body:{searchId:id,status:result.status,plan:result,originalGrantRetained:true}};
  }
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if(error instanceof DatabaseExecutionDeadlineError)throw error;
  if((error as any).code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'PE_ENTITY_NOT_FOUND',error:'Compute search unavailable in authenticated scope'}};
  if(error instanceof z.ZodError)return {status:400,body:{code:'P2_SCHEMA_INVALID',predicate:'BOUNDED_TYPED_COMPUTE_SEARCH_REQUIRED'}};
  const predicate=String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'P2_OWNER_OR_CHECK_PREDICATE_UNPASSED';return {status:422,body:{code:'P2_PREDICATE_UNPASSED',predicate}};
 }
}
