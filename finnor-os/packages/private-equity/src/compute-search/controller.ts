import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {sha,stable,tx} from '../evidence-execution/store';
import {enqueueProgram,requestRow,type ProgramRow} from '../program-synthesis/store';
import type {HarnessProgram,NativeModule} from '../program-synthesis/contracts';
import {searchForProgram,searchRow,currentSearch,units,incumbentOf,append,snapshot,readStoredPlan} from './store';
import {readEndpointConfig,nativeCapacitySnapshot} from './endpoints';
import type {SearchRow,UnitRow} from './contracts';
import {controlSnapshot,controlState,latestControl} from '../deliberation/store';
/** A failed source preparation has no unit delivery that could close the search.
 * Persist its disposition in the original P1 failure transaction. Initialized
 * searches retain their physical attempt reconciliation and current-reader fence. */
export async function invalidateUnstartedProgramSearch(ctx:PeMutationContext,q:ProgramRow,c:PoolClient){
 const row=(await c.query<SearchRow>('SELECT * FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND program_id=$3 FOR UPDATE',[q.tenant_id,q.principal_id,q.id])).rows[0];
 if(!row||row.context||['CANCELLED','INVALIDATED'].includes(row.status))return;
 row.status='INVALIDATED';row.reason='P2_PARENT_PROGRAM_WITHOUT_ACCEPTED_DELIVERY';row.generation++;
 await c.query("UPDATE finnor_os.p2_requests SET status='INVALIDATED',reason=$2,generation=generation+1 WHERE id=$1",[row.id,row.reason]);
 await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE search_id=$1 AND status IN('PENDING','QUEUED')",[row.id]);
 await append(ctx,row,'PARENT_PREPARATION_FAILED',{programId:q.id,originalEpisode:q.episode_id,predicate:row.reason,attemptCostsRetained:true},c);await snapshot(ctx,row,q,c);
}
export async function addCandidateUnits(ctx:PeMutationContext,s:SearchRow,module:NativeModule,c:PoolClient) {
 const current=await units(ctx,s,c);if(current.some(u=>u.kind==='EXECUTE_P1'&&u.body.moduleId===module.id))return;
 if(current.length+2>s.request.limits.maxUnits)throw Error('P2_ORIGINAL_UNIT_FRONTIER_BOUND');
 const executionId=randomUUID(),verificationId=randomUUID(),inspection=current.find(u=>u.kind==='INSPECT_SOURCE');
 for(const [id,kind,prerequisites] of [[executionId,'EXECUTE_P1',[]],[verificationId,'VERIFY_P1',[executionId,...(inspection?[inspection.id]:[])]]] as const){
  const body={moduleId:module.id,prerequisites:[...prerequisites],mechanism:module.format,sourceDigest:s.context.sourceResultDigest,inputDigest:s.context.inputDigest,routeIds:[]};
  await c.query('INSERT INTO finnor_os.p2_units(id,tenant_id,principal_id,search_id,generation,kind,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[id,s.tenant_id,s.principal_id,s.id,s.generation,kind,stable(body),sha(body)]);
 }
}
/** Completion driven scheduling. No handler waits for sibling promises or a
 * submission-ordered batch. Completed checks can change the next topology. */
export async function replan(ctx:PeMutationContext,s:SearchRow,q:ProgramRow,c:PoolClient){
 if(['CANCELLED','INVALIDATED','STOPPED','FAILED'].includes(s.status))return snapshot(ctx,s,q,c);
 let frontier=await units(ctx,s,c);
 for(const u of frontier.filter(u=>u.status==='PENDING'&&u.body.prerequisites.some(id=>frontier.some(p=>p.id===id&&['FAILED','CANCELLED'].includes(p.status)))))await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE id=$1",[u.id]);
 frontier=await units(ctx,s,c);
 if(frontier.some(u=>u.status==='UNKNOWN')){s.status='WAITING';s.reason='UNKNOWN_PHYSICAL_ATTEMPT_REQUIRES_RECONCILIATION';}
 else if(s.request.deliberation){
  // M2 is executed as ordinary P2 work. This branch applies a current bounded
  // proposal or resumes one ongoing CONTROL_M2 through the same job/admission
  // path. It does not run host work while holding this transaction.
  const state=await controlSnapshot(ctx,s,c),incumbent=incumbentOf(s,frontier),last=await latestControl(ctx,s,c);
  const controls=frontier.filter(u=>u.kind==='CONTROL_M2'&&['QUEUED','RUNNING'].includes(u.status));
  const suspended=frontier.filter(u=>u.kind==='CONTROL_M2'&&u.status==='PENDING');
  if(suspended.length>1)throw Error('M2_ONE_ONGOING_CONTROL_PROGRAM_REQUIRED');
  const ongoing=suspended[0];
  const current=last&&controlState(last.input)===controlState(state)&&last.input.remainingAttempts<=state.remainingAttempts;
  if(s.status==='WAITING'&&s.reason==='M2_MATERIAL_SOURCE_PREMISE_REQUIRES_S4_RECOMPUTATION'){/* retain owner request and liabilities; no fresh grant or dispatch */}
  else if(current){
   const proposal=last.output;
   if(proposal.ownerWait){s.status='WAITING';s.reason=proposal.reason;s.generation++;await c.query('UPDATE finnor_os.p2_requests SET generation=generation+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,s.id]);await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE search_id=$1 AND status IN('PENDING','QUEUED')",[s.id]);await append(ctx,s,'M2_OWNER_PREMISE_RECOMPUTATION_REQUIRED',{sourceRef:s.request.deliberation.sourceInspectionRef,originalGrantRetained:true,originalEpisode:q.episode_id,authorityGranted:false},c);}
   else if(proposal.stop){s.status=incumbent?'STOPPED':'FAILED';s.reason=proposal.reason;
    if(ongoing)await c.query("UPDATE finnor_os.p2_units SET status='COMPLETED',updated_at=clock_timestamp() WHERE id=$1 AND status='PENDING'",[ongoing.id]);
    await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status='PENDING'",[s.tenant_id,s.principal_id,s.id]);
   }else{
    const selected=proposal.selectedUnitIds.filter((id:string)=>frontier.some(u=>u.id===id&&u.status==='PENDING'&&u.body.prerequisites.every(p=>frontier.some(v=>v.id===p&&v.status==='COMPLETED')))).slice(0,Math.max(0,Math.min(state.remainingAttempts,s.request.limits.maxParallel-state.active)));
    for(const id of selected){const u=frontier.find(u=>u.id===id)!;
     await c.query("UPDATE finnor_os.p2_units SET status='QUEUED',updated_at=clock_timestamp() WHERE id=$1",[u.id]);
     await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_compute_search_unit_v1',$2::jsonb,$3,'interactive',2,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING",[s.tenant_id,stable({tenantId:s.tenant_id,principalId:s.principal_id,searchId:s.id,unitId:u.id,generation:s.generation,originalDeadlineAt:q.proposed.bounds.deadlineAt}),'p2:'+s.id+':'+s.generation+':'+u.id+':admission:'+u.attempts]);
     await append(ctx,s,'M2_NEXT_WORK_APPLIED',{unitId:u.id,kind:u.kind,moduleRunDigest:sha(last),inputDigest:last.inputDigest,selection:proposal.selection,conditionalChains:proposal.chains,expectedDecisionValue:proposal.chains.filter((chain:any)=>chain.unitIds.includes(u.id)&&chain.support==='PUBLIC_MODEL_RELATIVE_DIAGNOSTIC'),valueScope:'PUBLIC_DIAGNOSTIC_CHAIN_GAIN_NOT_ADDITIVE_PER_UNIT_OR_FIELD_WEALTH',businessSelection:false},c);
    }
    s.status='RUNNING';s.reason=null;
   }
  }else if(!controls.length){
   if((!ongoing&&frontier.length>=s.request.limits.maxUnits)||(ongoing&&ongoing.attempts>=32)||state.remainingAttempts===0||state.remainingMs<=0){s.status=incumbent?'STOPPED':'FAILED';s.reason='M2_ORIGINAL_CONTROL_FRONTIER_BUDGET_OR_DEADLINE_EXHAUSTED';if(ongoing)await c.query("UPDATE finnor_os.p2_units SET status='COMPLETED',updated_at=clock_timestamp() WHERE id=$1 AND status='PENDING'",[ongoing.id]);await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED' WHERE search_id=$1 AND status='PENDING'",[s.id]);}
   else{
    const id=ongoing?.id??randomUUID(),body=ongoing?{...ongoing.body,controlStateDigest:controlState(state),controlContinuation:ongoing.attempts}:{moduleId:s.request.deliberation.moduleRef.id,prerequisites:[],mechanism:'EXECUTED_M2_METACONTROLLER',sourceDigest:s.context.sourceResultDigest,inputDigest:s.context.inputDigest,routeIds:[],controlStateDigest:controlState(state),logicalControlRevision:frontier.filter(u=>u.kind==='CONTROL_M2').length+1,controlContinuation:0};
    if(ongoing)await c.query("UPDATE finnor_os.p2_units SET status='QUEUED',body=$2::jsonb,digest=$3,updated_at=clock_timestamp() WHERE id=$1 AND status='PENDING'",[id,stable(body),sha(body)]);
    else await c.query("INSERT INTO finnor_os.p2_units(id,tenant_id,principal_id,search_id,generation,kind,status,body,digest) VALUES($1,$2,$3,$4,$5,'CONTROL_M2','QUEUED',$6::jsonb,$7)",[id,s.tenant_id,s.principal_id,s.id,s.generation,stable(body),sha(body)]);
    await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_compute_search_unit_v1',$2::jsonb,$3,'interactive',2,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING",[s.tenant_id,stable({tenantId:s.tenant_id,principalId:s.principal_id,searchId:s.id,unitId:id,generation:s.generation,originalDeadlineAt:q.proposed.bounds.deadlineAt}),'p2:'+s.id+':'+s.generation+':'+id+':admission:'+(ongoing?.attempts??0)]);
    await append(ctx,s,ongoing?'M2_CONTROL_CONTINUATION_QUEUED':'M2_CONTROL_QUEUED',{unitId:id,moduleRef:s.request.deliberation.moduleRef,logicalControlRevision:body.logicalControlRevision,nextInvocation:(ongoing?.attempts??0)+1,originalEpisode:q.episode_id,originalGrant:s.request.computeGrant,controlOverheadHasPhysicalAdmission:true,logicalUnitReused:!!ongoing,completedOrUnknownReplayed:false},c);s.status='RUNNING';s.reason=null;
   }
  }else {s.status='RUNNING';s.reason=null;}
 }
 else {
  const incumbent=incumbentOf(s,frontier),active=frontier.filter(u=>['RUNNING','QUEUED'].includes(u.status));
  const modelPending=frontier.some(u=>u.kind==='MODEL_REFINE'&&!['COMPLETED','FAILED','CANCELLED'].includes(u.status));
  const newCandidatePending=frontier.some(u=>u.kind==='VERIFY_P1'&&!q.proposed.modules.some(m=>m.id===u.body.moduleId)&&!['COMPLETED','FAILED','CANCELLED'].includes(u.status));
  if(incumbent&&s.request.strategy==='ADAPTIVE'&&!modelPending&&!newCandidatePending&&!active.length){
   s.status='STOPPED';s.reason='CHECKED_NATIVE_INCUMBENT_HEURISTIC_REMAINING_VALUE_UNKNOWN';
   await c.query("UPDATE finnor_os.p2_units SET status='CANCELLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND status='PENDING'",[s.tenant_id,s.principal_id,s.id]);
  }else{
   const ready=frontier.filter(u=>u.status==='PENDING'&&u.body.prerequisites.every(id=>frontier.some(p=>p.id===id&&p.status==='COMPLETED')));
   // The independent checker is the current bottleneck after an execution. A
   // new representation is preferred over correlated model opinions after failure.
   const rank=(u:UnitRow)=>u.kind==='VERIFY_P1'?0:u.kind==='MODEL_REFINE'?1:2;
   ready.sort((a,b)=>rank(a)-rank(b)||(s.context.program.modules.find((m:NativeModule)=>m.id===a.body.moduleId)?.bounds.steps??0)-(s.context.program.modules.find((m:NativeModule)=>m.id===b.body.moduleId)?.bounds.steps??0)||a.id.localeCompare(b.id));
   const parallel=s.request.strategy==='FIXED_SEQUENTIAL'?1:s.request.strategy==='FIXED_WIDE'?s.request.limits.maxParallel:ready.some(u=>u.kind==='MODEL_REFINE')?s.request.limits.maxParallel:1;
   for(const u of ready.slice(0,Math.max(0,parallel-active.length))){
    await c.query("UPDATE finnor_os.p2_units SET status='QUEUED',updated_at=clock_timestamp() WHERE id=$1",[u.id]);
    await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_compute_search_unit_v1',$2::jsonb,$3,'interactive',1,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING",[s.tenant_id,stable({tenantId:s.tenant_id,principalId:s.principal_id,searchId:s.id,unitId:u.id,generation:s.generation}),'p2:'+s.id+':'+s.generation+':'+u.id+':admission:'+u.attempts]);
    await append(ctx,s,'NEXT_UNIT_SELECTED',{unitId:u.id,kind:u.kind,prerequisites:u.body.prerequisites,priorityBasis:'OWNER_CHECK_BOTTLENECK_THEN_DISTINCT_MECHANISM_HEURISTIC',marginalEconomicValue:null,lossUnit:s.binding.loss.unit,correlatedVoteCountUsed:false},c);
   }
   if(!active.length&&!ready.length){s.status=incumbent?'STOPPED':'FAILED';s.reason=incumbent?'FINITE_REGISTERED_CANDIDATES_CHECKED_REMAINING_MECHANISMS_UNKNOWN':'NO_INDEPENDENTLY_CHECKED_P1_INCUMBENT';}
   else {s.status='RUNNING';s.reason=null;}
  }
 }
 await c.query('UPDATE finnor_os.p2_requests SET status=$4,reason=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,s.id,s.status,s.reason]);
 const plan=await snapshot(ctx,s,q,c);
 if(s.status==='STOPPED'||s.status==='FAILED')await enqueueProgram(ctx,q,'p2-completed:'+s.id+':'+plan.revision,c);
 await append(ctx,s,'FRONTIER_RECONSIDERED',{revision:plan.revision,status:s.status,incumbentUnit:plan.incumbent?.unitId??null,outstanding:plan.outstanding,stop:plan.stop,topology:plan.topology},c);
 return plan;
}
/** Called only by actual P1 after its authentic current P4 derivation. P2 owns
 * compute order; P1 keeps frozen acceptance and final artifact authority. */
export async function advanceProgramSearch(ctx:PeMutationContext,q:ProgramRow,program:HarnessProgram,input:Record<string,string>,d:any) {
 const s=await searchForProgram(ctx,q.id);if(!s)return null;
 await currentSearch(ctx,s,q);
 if(s.status==='STOPPED'){
  const plan=await readStoredPlan(ctx,s);if(!plan.incumbent||plan.incumbent.inputDigest!==sha(input)||plan.incumbent.sourceResultDigest!==d.result.digest||plan.incumbent.acceptanceDigest!==program.acceptanceDigest)throw Error('P2_CURRENT_CHECKED_INCUMBENT_REQUIRED');
  const modules=s.context.program.modules as NativeModule[];
  return {waiting:false,selected:plan.incumbent,modules,plan};
 }
 if(['FAILED','CANCELLED','INVALIDATED','WAITING'].includes(s.status))throw Error('P2_SEARCH_STOP_WITH_UNPASSED_PREDICATE');
 const endpoints=await readEndpointConfig();
 const physicalCapacity=await nativeCapacitySnapshot(ctx,s.request.requestedKinds.includes('MODEL_REFINE'));
 await tx(ctx,async c=>{
  const locked=await searchRow(ctx,s.id,c,true);if(!['ACCEPTED','RUNNING'].includes(locked.status))throw Error('P2_INITIALIZATION_FENCED');
  if(!locked.context){
   const selected=endpoints.filter(e=>locked.request.routeIds.includes(e.id));if(locked.request.requestedKinds.length&&(!selected.length||selected.length!==locked.request.routeIds.length))throw Error('P2_CONFIGURED_ROUTE_SNAPSHOT_REQUIRED');
   const context={program:structuredClone(program),programGeneration:q.generation,derivationId:d.id,sourceResultDigest:d.result.digest,inputDigest:sha(input),input,acceptanceDigest:program.acceptanceDigest,dependencies:d.invalidationKeys,endpoints:selected,physicalCapacity};
   locked.context=context;await c.query('UPDATE finnor_os.p2_requests SET context=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,s.id,stable(context)]);
   if(locked.request.deliberation?.sourceInspectionRef){const body={prerequisites:[],mechanism:'EXACT_AUTHORIZED_SOURCE_OBJECT_INSPECTION',sourceDigest:d.result.digest,inputDigest:sha(input),routeIds:[]};await c.query("INSERT INTO finnor_os.p2_units(id,tenant_id,principal_id,search_id,generation,kind,body,digest) VALUES($1,$2,$3,$4,$5,'INSPECT_SOURCE',$6::jsonb,$7)",[randomUUID(),s.tenant_id,s.principal_id,s.id,s.generation,stable(body),sha(body)]);}
   for(const module of program.modules)await addCandidateUnits(ctx,locked,module,c);
   if(locked.request.requestedKinds.includes('MODEL_REFINE')){
    if((await units(ctx,locked,c)).length>=locked.request.limits.maxUnits)throw Error('P2_ORIGINAL_UNIT_FRONTIER_BOUND');
    const body={prerequisites:[],mechanism:'MODEL_STRUCTURE_PROPOSAL_NOT_BELIEF',sourceDigest:d.result.digest,inputDigest:sha(input),routeIds:locked.request.routeIds};
    await c.query("INSERT INTO finnor_os.p2_units(id,tenant_id,principal_id,search_id,generation,kind,body,digest) VALUES($1,$2,$3,$4,$5,'MODEL_REFINE',$6::jsonb,$7)",[randomUUID(),s.tenant_id,s.principal_id,s.id,s.generation,stable(body),sha(body)]);
   }
   await append(ctx,locked,'P1_PRODUCER_JOINED',{programId:q.id,workId:q.work_id,workInputId:q.work_input_id,acceptanceDigest:program.acceptanceDigest,sourceResultDigest:d.result.digest,originalEpisode:q.episode_id,modules:program.modules.map(m=>({id:m.id,structureDigest:m.structureDigest,format:m.format})),genericP4CoverageIsDecisionSufficiency:false},c);
  }else if(locked.context.inputDigest!==sha(input)||locked.context.sourceResultDigest!==d.result.digest)throw Error('P2_SOURCE_CUT_CHANGED');
  await c.query("UPDATE finnor_os.p1_requests SET status='WAITING' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND generation=$4 AND claim_token=$5",[q.tenant_id,q.principal_id,q.id,q.generation,q.claim_token]);
  await replan(ctx,locked,q,c);
 });
 return {waiting:true,selected:null,modules:program.modules,plan:null};
}
