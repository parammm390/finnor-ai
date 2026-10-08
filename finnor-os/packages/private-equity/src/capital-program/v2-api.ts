import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {PeDomainError} from '../types';
import {listEnterpriseControlPolicies,readEnterpriseControlDecisionContext,chooseEnterpriseControlBranch,
 readEnterpriseControlBranchChoice} from '../enterprise-control';
import {resolveDecisionWork,principal} from '../decision-slice/adapters';
import {readCurrentDecisionSlice,type CurrentSlice} from '../decision-slice/service';
import {consumeDecisionSlice} from '../decision-slice/consumer';
import {inM1Episode} from '../decision-slice/budget';
import {DecisionSliceError} from '../decision-slice/contracts';
import {ChallengeError} from '../counterexample-search/contracts';
import {readIssuedCapitalChallenge,withIssuedCapitalChallengeRead} from '../counterexample-search/service';
import {readEnterpriseAllocationCandidateProblem} from '../enterprise-allocation';
import {assertDependencies,revisions} from '../evidence-execution/store';
import {verifyCanonicalAllocation} from '../../../epistemic-runtime/src/allocation-checker';
import {AllocationContractError} from '../../../epistemic-runtime/src/allocation-contracts';
import {m3Tx,m3Query,m3Event,m3AuthorizePrincipal,readM3Record,writeM3Record,type M3QueryRow} from './v2-store';
import {resolveCapitalOwners,recheckCapitalOwners,assertCapitalOwnerBinding} from './v2-owners';
import {capitalPendingRequests} from './v2-pending';
import {m3CheckTime,m3Remaining,inM3Episode} from './v2-budget';
import {capitalRepairBudget} from './repair-budget';
import {m3Unavailable,m3Hash,m3Ref,m3Same,CapitalProgramV2Error,CapitalProgramV2Operations,CapitalProgramV2RequestSchema,
 CAPITAL_PROGRAM_V2_VERSION,type CapitalProgramV2,type CapitalProgramV2Module,type CapitalProgramV2Request,type CapitalProgramV2QueryView,
 type CapitalProgramV2BranchReview,type CapitalProgramV2AttemptCost} from './v2-contracts';
export const CAPITAL_PROGRAM_V2_OPERATIONS=new Set(Object.keys(CapitalProgramV2Operations));
const view=(q:M3QueryRow,program:CapitalProgramV2|null=null,branchReviews:CapitalProgramV2BranchReview[]=[],attemptCosts:CapitalProgramV2AttemptCost[]=[]):CapitalProgramV2QueryView=>({
 queryId:q.id,workId:q.work_id,status:q.status,program,progress:{attempted:q.attempted,generated:q.generated,refinementSteps:q.refinement_steps},
 request:structuredClone(q.request),deadlineAt:q.deadline_at?.toISOString()??null,
 failure:q.failure,parentQueryId:q.parent_query_id,executionAuthorityGranted:false,branchReviews,attemptCosts,
});
export async function submitCapitalProgram(ctx:PeMutationContext,value:unknown,parentQueryId:string|null=null){
 const request=CapitalProgramV2RequestSchema.parse(value);await m3AuthorizePrincipal(ctx);await resolveDecisionWork(ctx,request.workId);
 if(process.env.FINNOR_M3_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production')
  throw new CapitalProgramV2Error('CONFIGURATION_REQUIRED','Capital programme requires the configured disposable native profile; protected funding/runtime/admission are not available');
 const parent=parentQueryId?await m3Query(ctx,parentQueryId):null;
 if(parent&&parent.work_id!==request.workId)throw m3Unavailable();
 if(request.challengeEvidence&&!parent)
  throw new CapitalProgramV2Error('INVALID_REQUEST','Original challenge evidence requires its exact linked M3 parent');
 const digest=m3Hash(request);
 const prior=await m3Tx(ctx,async c=>(await c.query<{id:string;request_digest:string;status:string;parent_query_id:string|null}>(
  'SELECT id,request_digest,status,parent_query_id FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
  [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0],true);
 if(prior){if(prior.request_digest!==digest||prior.parent_query_id!==parentQueryId)throw new CapitalProgramV2Error('CONFLICT','Idempotency key binds different economic terms, resources or immutable parent');
  return {queryId:prior.id,workId:request.workId,status:prior.status,replayed:true};}
 const binding=await resolveCapitalOwners(ctx,request,true);
 if(parent){
  if(!m3Same(parent.acceptance.policy.mandate,binding.policy.mandate))
   throw new CapitalProgramV2Error('INVALID_REQUEST','Recompilation cannot change the original economic mandate, utility, horizon or risk');
  const parentRequestRef=m3Ref('capital-program-request',parent.request);
  await readM3Record(ctx,'requests',parentRequestRef);
  const parents:CapitalProgramV2['envelope']['parents']=[parentRequestRef];
  if(parent.result_digest){
   const parentRef={owner:'M3' as const,id:`capital-program:${parent.result_digest}`,version:CAPITAL_PROGRAM_V2_VERSION,contentDigest:parent.result_digest},
    retained=await readM3Record<Omit<CapitalProgramV2,'ref'>>(ctx,'programs',parentRef);
   const published=await m3Tx(ctx,async c=>(await c.query(
    'SELECT result_digest FROM finnor_os.m3_publications WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND result_digest=$4',
    [ctx.auth.tenantId,principal(ctx),parent.id,parent.result_digest])).rows[0],true);
   if(!published||retained.body.envelope.work.inputDigest!==parent.work_input_digest)
    throw new CapitalProgramV2Error('CHECK_FAILED','Immutable parent programme has no matching original publication or Work preimage');
   parents.push(parentRef);
  }
  const {idempotencyKey:_oldKey,...oldRequest}=parent.request,{idempotencyKey:_newKey,...newRequest}=request,
   before=new Map([...parent.acceptance.ownerVector,{key:'method:code',digest:parent.acceptance.code.digest},
    {key:'method:schema',digest:parent.acceptance.schemaDigest},{key:'request:semantic-domain',digest:m3Hash(oldRequest)}].map(row=>[row.key,row.digest])),
   after=new Map([...binding.ownerVector,{key:'method:code',digest:binding.code.digest},
    {key:'method:schema',digest:binding.schemaDigest},{key:'request:semantic-domain',digest:m3Hash(newRequest)}].map(row=>[row.key,row.digest])),
   changedDependencies=[...new Set([...before.keys(),...after.keys()])].sort().flatMap(key=>{
    const previousDigest=before.get(key)??null,currentDigest=after.get(key)??null;
    return previousDigest===currentDigest?[]:[{key,previousDigest,currentDigest}];
   });
  if(!changedDependencies.length)throw new CapitalProgramV2Error('CONFLICT','Unchanged recompilation cannot replenish the original episode grant');
  binding.recompilation={parentQueryId:parent.id,parents,changedDependencies};
  if(request.challengeEvidence){
   if(!parent.result_digest)throw new CapitalProgramV2Error('CHECK_FAILED','Original challenge repair lacks a published M3 parent');
   const evidence:NonNullable<typeof binding.challengeEvidence>=[];
   for(const supplied of request.challengeEvidence){
    const issued=await readIssuedCapitalChallenge(ctx,supplied.searchId,supplied.resultRef),report=issued.report;
    if(report.candidate.contentDigest!==parent.result_digest||report.envelope.work.id!==request.workId||
     !m3Same(report.envelope.mandateOrChange,binding.policy.mandateRef))
     throw new CapitalProgramV2Error('INVALID_REQUEST','Original challenge must bind this exact parent Work, candidate and unchanged mandate');
    evidence.push({searchId:supplied.searchId,resultRef:report.ref,candidateRef:report.candidate,
     witnessRefs:report.independentWitnesses,repairDependencyRef:report.repairDependencies,deadlineAt:issued.deadlineAt});
   }
   binding.challengeEvidence=evidence;
   binding.recompilation.parents.push(...evidence.map(e=>e.resultRef));
   binding.repairBudget=await capitalRepairBudget(ctx,parent,request,evidence.map(e=>e.deadlineAt));
  }
 }
 await writeM3Record(ctx,'requests',m3Ref('capital-program-request',request),request);
 return m3Tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5583))',[ctx.auth.tenantId+':'+principal(ctx)+':'+request.workId]);
  await m3AuthorizePrincipal(ctx,c);
  const existing=(await c.query<{id:string;request_digest:string;status:string;parent_query_id:string|null}>(
   'SELECT id,request_digest,status,parent_query_id FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(existing){if(existing.request_digest!==digest||existing.parent_query_id!==parentQueryId)throw new CapitalProgramV2Error('CONFLICT','Idempotency key binds different economic terms, resources or immutable parent');
   return {queryId:existing.id,workId:request.workId,status:existing.status,replayed:true};}
  if(binding.repairBudget&&parent){
   const fresh=await capitalRepairBudget(ctx,parent,request,binding.challengeEvidence!.map(e=>e.deadlineAt),c);
   if(fresh.consumptionDigest!==binding.repairBudget.consumptionDigest)
    throw new CapitalProgramV2Error('STALE_INPUT','Original repair resource consumption changed before admission');
   binding.repairBudget=fresh;
  }
  await assertDependencies(ctx,binding.dependencies,c,true);
  const input=(await c.query<{id:string}>('SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
   [ctx.auth.tenantId,request.workId])).rows[0];
  if(input?.id!==binding.work.inputId)throw new CapitalProgramV2Error('STALE_INPUT','Exact Work input changed before request admission');
  // The predecessor M1 has one current head per Work. Supersession is explicit,
  // not a race between several queries publishing incompatible evidence heads.
  await c.query("UPDATE finnor_os.m3_queries SET status='INVALIDATED',generation=generation+1,updated_at=clock_timestamp(),failure=jsonb_build_object('code','NEW_WORK_PROPOSAL','requirement','An immutable newer economic query owns this Work') WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND status IN('QUEUED','RUNNING','TESTED','PARTIAL')",
   [ctx.auth.tenantId,principal(ctx),request.workId]);
  const id=randomUUID();
  await c.query('INSERT INTO finnor_os.m3_queries(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,plan_id,plan_digest,idempotency_key,request_digest,request,acceptance,parent_query_id,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)',
   [id,ctx.auth.tenantId,principal(ctx),request.workId,binding.work.inputId,binding.work.inputDigest,binding.plan.id,binding.plan.semanticHash,
    request.idempotencyKey,digest,JSON.stringify(request),JSON.stringify(binding),parentQueryId,binding.repairBudget?.deadlineAt??null]);
  for(const dependency of binding.dependencies)await c.query('INSERT INTO finnor_os.m3_dependencies(tenant_id,principal_id,query_id,key,revision) VALUES($1,$2,$3,$4,$5)',
   [ctx.auth.tenantId,principal(ctx),id,dependency.key,dependency.revision]);
  await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety) VALUES($1,'run_capital_program_v2',$2::jsonb,$3,'interactive',0,2,'locally_idempotent')",
   [ctx.auth.tenantId,JSON.stringify({tenantId:ctx.auth.tenantId,principalId:principal(ctx),queryId:id,generation:1}),`m3:${id}:1`]);
  return {queryId:id,workId:request.workId,status:'QUEUED',replayed:false};
 });
}
async function invalidate(ctx:PeMutationContext,q:M3QueryRow,code:string){
 return m3Tx(ctx,async c=>{
  const current=await m3Query(ctx,q.id,c,true);
  if(['QUEUED','RUNNING','TESTED','PARTIAL'].includes(current.status)){
   await c.query("UPDATE finnor_os.m3_queries SET status='INVALIDATED',generation=generation+1,updated_at=clock_timestamp(),failure=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
    [ctx.auth.tenantId,principal(ctx),q.id,JSON.stringify({code,requirement:'Current Work, owner, source, method or resource binding changed; retained original bytes are historical'})]);
   await m3Event(ctx,q.id,randomUUID(),'INVALIDATED',{code,resultDigest:q.result_digest,costsRetained:true},c);
  }return view({...current,status:current.status==='CANCELLED'?'CANCELLED':'INVALIDATED'});
 });
}
type Inspection={kind:'WITNESS';candidateDigest:string}|{kind:'MODULE';moduleDigest:string};
async function readCapitalProgramWithInspection(ctx:PeMutationContext,id:string,inspection?:Inspection){
 return withIssuedCapitalChallengeRead(()=>readCheckedCapitalProgram(ctx,id,inspection));
}
async function readCheckedCapitalProgram(ctx:PeMutationContext,id:string,inspection?:Inspection){
 const q=await m3Query(ctx,id);
 const attemptCosts=await readAttemptCosts(ctx,q),
  result=(current:CapitalProgramV2QueryView,details:unknown=null,evidence:CurrentSlice|null=null)=>({current:{...current,attemptCosts},details,evidence});
 // Reauthorize current Work even for historical/cancelled private queries.
 await resolveDecisionWork(ctx,q.work_id);
 if(['INVALIDATED','CANCELLED','FAILED'].includes(q.status))return result(view(q));
 try{await assertCapitalOwnerBinding(ctx,q.acceptance);}
 catch(error){
  if(error instanceof CapitalProgramV2Error&&error.code==='UNAVAILABLE'||error instanceof PeDomainError&&/NOT_FOUND/.test(error.code)||
   error instanceof DecisionSliceError&&error.code==='UNAVAILABLE')throw m3Unavailable();
  if(error instanceof CapitalProgramV2Error&&error.code==='LIMIT_EXCEEDED')throw error;
  return result(await invalidate(ctx,q,'WORK_OWNER_SOURCE_OR_METHOD_CHANGED'));
 }
 if(!q.result_digest){
  await recheckCapitalOwners(ctx,q.request,q.acceptance);return result(view(q));
 }
 const ref={owner:'M3' as const,id:`capital-program:${q.result_digest}`,version:CAPITAL_PROGRAM_V2_VERSION,contentDigest:q.result_digest},
  record=await readM3Record<Omit<CapitalProgramV2,'ref'>>(ctx,'programs',ref),program={...record.body,ref};
 if(program.schema!=='finnor.capital-program.v2'||program.executionAuthorityGranted!==false||program.envelope.tenantId!==q.tenant_id||
  program.envelope.principalId!==q.principal_id||program.envelope.work.inputDigest!==q.work_input_digest)
  throw new CapitalProgramV2Error('CHECK_FAILED','Immutable capital programme identity/authority differs');
 for(const parent of q.acceptance.recompilation?.parents??[]){
  if(parent.owner==='M3'&&(parent.id.startsWith('capital-program-request:')||parent.id.startsWith('capital-program:')))
   await readM3Record(ctx,parent.id.startsWith('capital-program-request:')?'requests':'programs',parent);
  else if(parent.owner==='M4'){
   const accepted=q.acceptance.challengeEvidence?.find(e=>m3Same(e.resultRef,parent));
   if(!accepted)throw new CapitalProgramV2Error('CHECK_FAILED','Original challenge parent lacks its exact accepted owner handle');
   const issued=await readIssuedCapitalChallenge(ctx,accepted.searchId,parent);
   if(!m3Same(issued.report.candidate,accepted.candidateRef)||issued.report.envelope.work.id!==q.work_id)
    throw new CapitalProgramV2Error('CHECK_FAILED','Original challenge parent differs from its accepted candidate or Work');
  }else throw new CapitalProgramV2Error('CHECK_FAILED','Unsupported immutable recompilation parent owner or kind');
 }
 const published=await m3Tx(ctx,async c=>(await c.query('SELECT result_digest FROM finnor_os.m3_publications WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND generation=$4',
  [ctx.auth.tenantId,principal(ctx),q.id,q.generation])).rows[0],true);
 if(published?.result_digest!==q.result_digest)throw new CapitalProgramV2Error('CHECK_FAILED','Prepared programme has no exact durable publication');
 let details:unknown=null,evidence:CurrentSlice|null=null,branchReviews:CapitalProgramV2BranchReview[]=[];
 try{
  if(!program.evidenceSlice)throw new CapitalProgramV2Error('CHECK_FAILED','Programme evidence binding unresolved');
  evidence=await readCurrentDecisionSlice(ctx,program.evidenceSlice);
  await recheckCapitalOwners(ctx,q.request,q.acceptance,evidence);
  if(program.allocationRequest)await readEnterpriseAllocationCandidateProblem(ctx,program.allocationRequest,evidence.binding.policies.map(p=>p.policy));
  const candidate=inspection?.kind==='WITNESS'?program.candidates.find(c=>c.semanticDigest===inspection.candidateDigest):
   inspection?.kind==='MODULE'?program.candidates.find(c=>c.moduleRef?.contentDigest===inspection.moduleDigest):undefined;
  if(inspection&&!candidate)throw m3Unavailable();
  for(const item of program.candidates)if(item.moduleRef){
   const module=await readM3Record(ctx,'modules',item.moduleRef);
   if(inspection?.kind==='MODULE'&&item.moduleRef.contentDigest===inspection.moduleDigest)
    details={ref:item.moduleRef,bytes:module.bytes,sha256:module.sha256,contentType:'application/json',executionAuthorityGranted:false};
  }
  if(inspection?.kind==='WITNESS'&&candidate){
   const context=candidate.policyRef?await readEnterpriseControlDecisionContext(ctx,candidate.policyRef):null;
   details={candidate,policy:context?.policy??null,model:context?.model??null,kernel:context?.kernel??null,
    checks:program.allocation.checks.filter(c=>candidate.policyRef&&c.selectedPolicyIds.includes(candidate.policyRef.id)),
    evidenceSlice:evidence.slice,executionAuthorityGranted:false};
  }
  const retained=await m3Tx(ctx,async c=>(await c.query<{body:CapitalProgramV2BranchReview}>(
   'SELECT body FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 ORDER BY created_at, idempotency_key LIMIT 17',
   [ctx.auth.tenantId,principal(ctx),q.id])).rows,true);
  if(retained.length>16)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Native branch review readback exceeds sixteen records');
  for(const row of retained)branchReviews.push(await checkedBranchReview(ctx,program,row.body));
  await assertCapitalOwnerBinding(ctx,q.acceptance);
 }catch(error){
  if(error instanceof CapitalProgramV2Error&&['CHECK_FAILED','UNAVAILABLE'].includes(error.code))throw error;
  if(error instanceof CapitalProgramV2Error&&error.code==='LIMIT_EXCEEDED')throw error;
  return result(await invalidate(ctx,q,'MATERIAL_EVIDENCE_OR_OWNER_PROPOSAL_CHANGED'));
 }
 const after=await m3Query(ctx,id);
 return after.status===q.status&&after.generation===q.generation?result(view(after,program,branchReviews),details,evidence):result(view(after));
}
async function readAttemptCosts(ctx:PeMutationContext,q:M3QueryRow):Promise<CapitalProgramV2AttemptCost[]>{
 const rows=await m3Tx(ctx,async c=>(await c.query<{attempt_id:string;kind:string;body:Record<string,any>;created_at:Date}>(
  "SELECT attempt_id::text,kind,body,created_at FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND kind IN('STARTED','FINISHED','FAILED','FENCED') ORDER BY created_at,id LIMIT 129",
  [ctx.auth.tenantId,principal(ctx),q.id])).rows,true);
 if(rows.length>128)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Physical attempt readback requires bounded owner pagination');
 const costs=new Map<string,CapitalProgramV2AttemptCost>();
 for(const row of rows){
  if(row.kind==='STARTED'){
   if(typeof row.body.deadlineAt!=='string'||!Number.isFinite(Date.parse(row.body.deadlineAt))||
    row.body.deadlineAt!==q.deadline_at?.toISOString())
    throw new CapitalProgramV2Error('CHECK_FAILED','Retained physical attempt lacks its exact original SQL deadline');
   costs.set(row.attempt_id,{attemptId:row.attempt_id,state:'RUNNING',startedAt:row.created_at.toISOString(),
    finishedAt:null,deadlineAt:row.body.deadlineAt,physicalCostStatus:'PENDING_READBACK',
    wallMs:null,cpuUserMicros:null,cpuSystemMicros:null,money:null,aggregateChildUsageKnown:false,
    accountingScope:'WORKER_HANDLER_BEFORE_TERMINAL_ACCOUNTING'});
  }
  else{
   const prior=costs.get(row.attempt_id);
   if(!prior)throw new CapitalProgramV2Error('CHECK_FAILED','Terminal cost has no original physical attempt');
   const measured=row.body.attemptCost,known=measured&&row.body.unknownPhysicalCost!==true;
   costs.set(row.attempt_id,{...prior,state:row.kind as CapitalProgramV2AttemptCost['state'],
    finishedAt:row.created_at.toISOString(),physicalCostStatus:known?'MEASURED_SUPERVISOR_INTERVAL':'UNKNOWN',
    wallMs:known?measured.wallMs:null,cpuUserMicros:known?measured.cpuUserMicros:null,
    cpuSystemMicros:known?measured.cpuSystemMicros:null});
  }
 }
 return [...costs.values()];
}
export async function readCapitalProgram(ctx:PeMutationContext,id:string):Promise<CapitalProgramV2QueryView>{
 return (await readCapitalProgramWithInspection(ctx,id)).current;
}
/** Reuse only this invocation's actual checked M1 readback, never a cache or a
 * caller assertion of currentness. The ordinary public view stays unchanged. */
export async function readCapitalProgramOwnerEvidence(ctx:PeMutationContext,id:string){
 const {current,evidence}=await readCapitalProgramWithInspection(ctx,id);
 return {current,evidence};
}
async function requireProgram(ctx:PeMutationContext,id:string){
 const current=await readCapitalProgram(ctx,id);if(!current.program)throw new CapitalProgramV2Error('STALE_INPUT','Current checked capital programme required');
 return current.program;
}
async function checkedBranchReview(ctx:PeMutationContext,program:CapitalProgramV2,review:CapitalProgramV2BranchReview){
 const {ref,...body}=review,candidate=program.candidates.find(c=>c.semanticDigest===review.candidateDigest);
 if(!m3Same(m3Ref('native-branch-review',body),ref)||!m3Same(review.programRef,program.ref)||
   !candidate?.policyRef||!m3Same(candidate.policyRef,review.policyRef)||!m3Same(review.mandateRef,program.mandate)||
   !m3Same(review.evidenceSlice,program.evidenceSlice)||review.executionAuthorityGranted!==false||
   review.decisionCoverageGranted!==false||review.reservationCreated!==false||review.effectRef!==null)
  throw new CapitalProgramV2Error('CHECK_FAILED','Native branch review differs from its exact checked programme');
 const retained=await readM3Record(ctx,'branch-reviews',ref),
  choice=await readEnterpriseControlBranchChoice(ctx,review.choice.ref);
 if(!m3Same(retained.body,body)||!m3Same(choice,review.choice)||!m3Same(choice.policyRef,candidate.policyRef))
  throw new CapitalProgramV2Error('CHECK_FAILED','Native branch review owner preimage differs');
 return review;
}
async function reviewNativeBranch(ctx:PeMutationContext,input:{queryId:string;candidateDigest:string;idempotencyKey:string;intent:string},
 program:CapitalProgramV2){
 const candidate=program.candidates.find(c=>c.semanticDigest===input.candidateDigest);
 if(!candidate?.policyRef||candidate.disposition!=='CHECKED_MODEL_RELATIVE'||!candidate.finitePolicyComplete||!program.evidenceSlice)
  throw new CapitalProgramV2Error('BLOCKED_SELECTION','Current complete owner policy required for a reference-model branch review');
 const requestDigest=m3Hash(input),q=await m3Query(ctx,input.queryId),
  previous=await m3Tx(ctx,async c=>(await c.query<{request_digest:string;body:CapitalProgramV2BranchReview}>(
   'SELECT request_digest,body FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0],true);
 if(previous){
  if(previous.request_digest!==requestDigest)throw new CapitalProgramV2Error('CONFLICT','Native branch review key binds a different exact candidate');
  return {review:await checkedBranchReview(ctx,program,previous.body),replayed:true};
 }
 const {policy}=await readEnterpriseControlDecisionContext(ctx,candidate.policyRef);
 if(policy.problem.continuation||!m3Same(policy.mandateRef,program.mandate))
  throw new CapitalProgramV2Error('BLOCKED_SELECTION','Accounted continuation cannot be replaced by an initial branch review');
 const decision={knowledgeAt:new Date().toISOString(),period:0,actionHistory:[],observations:[],
  rightsRef:policy.bindings.rightsRef,obligations:policy.problem.obligations,allocationRefs:policy.bindings.allocationRefs},
  choice=await chooseEnterpriseControlBranch(ctx,{policyRef:policy.ref,decision});
 if(choice.status!=='POLICY_AVAILABLE'||choice.nodeId!==policy.rootNodeId)
  throw new CapitalProgramV2Error('BLOCKED_SELECTION','Initial native S4 branch is not currently available: '+choice.reasons.join(','));
 const body:Omit<CapitalProgramV2BranchReview,'ref'>={schema:'finnor.m3.native-branch-review.v2',status:'MODEL_BRANCH_REVIEWED',
  queryId:q.id,programRef:program.ref,candidateDigest:candidate.semanticDigest,policyRef:policy.ref,mandateRef:policy.mandateRef,
  evidenceSlice:program.evidenceSlice,decision,choice,qualification:'CURRENT_NATIVE_S4_REFERENCE_BRANCH_NOT_BUSINESS_SELECTION',
  executionAuthorityGranted:false,decisionCoverageGranted:false,reservationCreated:false,effectRef:null},
  review={...body,ref:m3Ref('native-branch-review',body)};
 await writeM3Record(ctx,'branch-reviews',review.ref,body);await requireProgram(ctx,q.id);
 return m3Tx(ctx,async c=>{
  await assertDependencies(ctx,q.acceptance.dependencies,c,true);
  const current=await m3Query(ctx,q.id,c,true);
  if(current.generation!==q.generation||!['TESTED','PARTIAL'].includes(current.status)||current.result_digest!==program.ref.contentDigest)
   throw new CapitalProgramV2Error('STALE_INPUT','Native branch review publication was fenced');
  const prior=(await c.query<{request_digest:string;body:CapitalProgramV2BranchReview}>(
   'SELECT request_digest,body FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)throw new CapitalProgramV2Error('CONFLICT','Native branch review key binds a different exact candidate');
   return {review:prior.body,replayed:true};}
  const count=(await c.query<{n:number}>('SELECT count(*)::int n FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3',
   [ctx.auth.tenantId,principal(ctx),q.id])).rows[0]!.n;
  if(count>=16)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','At most sixteen immutable native branch reviews per programme');
  await c.query('INSERT INTO finnor_os.m3_branch_reviews(tenant_id,principal_id,query_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
   [ctx.auth.tenantId,principal(ctx),q.id,input.idempotencyKey,requestDigest,JSON.stringify(review)]);
  await m3Event(ctx,q.id,randomUUID(),'SELECTION',{intent:input.intent,reviewRef:review.ref,choiceRef:choice.ref,
   reservationCreated:false,executionAuthorityGranted:false},c);
  return {review,replayed:false};
 });
}
export async function handleCapitalProgramOperation(ctx:PeMutationContext,operation:string,value:unknown):Promise<{status:number;body:unknown}>{
 const schema=CapitalProgramV2Operations[operation as keyof typeof CapitalProgramV2Operations];
 if(!schema)throw m3Unavailable();const input=schema.parse(value);
 switch(operation){
  case 'capital-program-submit':return {status:202,body:await inM3Episode(Math.min((input as CapitalProgramV2Request).resource.deadlineMs,m3Remaining()),()=>submitCapitalProgram(ctx,input))};
  case 'capital-program-read':return {status:200,body:await readCapitalProgram(ctx,(input as {queryId:string}).queryId)};
  case 'capital-program-list':{
   const {workId,limit=16}=input as {workId:string;limit?:number};await m3AuthorizePrincipal(ctx);await resolveDecisionWork(ctx,workId);
   const ids=await m3Tx(ctx,async c=>(await c.query<{id:string}>('SELECT id FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT $4',
    [ctx.auth.tenantId,principal(ctx),workId,limit])).rows,true);
   const queries=[];for(const row of ids){m3CheckTime();queries.push(await readCapitalProgram(ctx,row.id));}return {status:200,body:{workId,queries}};
  }
  case 'capital-program-context':{
   const {workId,root}=input as {workId:string;root:PeWorldRootRef};await m3AuthorizePrincipal(ctx);await resolveDecisionWork(ctx,workId);
   return {status:200,body:{workId,policies:await listEnterpriseControlPolicies(ctx,root),executionAuthorityGranted:false}};
  }
  case 'capital-program-ports':{
   const {workId}=input as {workId:string};await m3AuthorizePrincipal(ctx);await resolveDecisionWork(ctx,workId);
   const q=await m3Tx(ctx,async c=>(await c.query<M3QueryRow>('SELECT * FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',
    [ctx.auth.tenantId,principal(ctx),workId])).rows[0],true);
   if(!q)throw new CapitalProgramV2Error('STALE_INPUT','An accepted permitted economic domain is required for exact pending ports');
   // A port lookup is not an active-worker budget checkpoint or a new grant.
   // Terminal and not-yet-started episodes cannot transfer unused limits.
   return {status:200,body:{requests:capitalPendingRequests(q.request,[m3Ref('capital-program-request',q.request)],q.deadline_at?.toISOString()??null,
    {...q.request.resource,deadlineMs:0,maxAttempts:0,maxGenerated:0,maxExpansions:0,maxRefinementSteps:0})}};
  }
  case 'capital-program-witness':{
   const {queryId,candidateDigest}=input as {queryId:string;candidateDigest:string},
    inspected=await readCapitalProgramWithInspection(ctx,queryId,{kind:'WITNESS',candidateDigest});
   if(!inspected.current.program)throw new CapitalProgramV2Error('STALE_INPUT','Current checked capital programme required');
   return {status:200,body:inspected.details};
  }
  case 'capital-program-module':{
   const {queryId,moduleDigest}=input as {queryId:string;moduleDigest:string},
    inspected=await readCapitalProgramWithInspection(ctx,queryId,{kind:'MODULE',moduleDigest});
   if(!inspected.current.program)throw new CapitalProgramV2Error('STALE_INPUT','Current checked capital programme required');
   return {status:200,body:inspected.details};
  }
  case 'capital-program-cancel':{
   const {queryId}=input as {queryId:string},q=await m3Query(ctx,queryId);await resolveDecisionWork(ctx,q.work_id);
   const current=await m3Tx(ctx,async c=>{
    const row=await m3Query(ctx,q.id,c,true);if(!['QUEUED','RUNNING'].includes(row.status))return view(row);
    await c.query("UPDATE finnor_os.m3_queries SET status='CANCELLED',generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
     [ctx.auth.tenantId,principal(ctx),q.id]);
    await m3Event(ctx,q.id,randomUUID(),'CANCELLED',{generation:row.generation,requestedBy:principal(ctx),acceptedEffectsNotErased:true,physicalCostsUnknownUntilWorkerReadback:true},c);
    return view({...row,status:'CANCELLED'});
   });return {status:200,body:current};
  }
  case 'capital-program-resume':{
   const {queryId}=input as {queryId:string},q=await m3Query(ctx,queryId);await resolveDecisionWork(ctx,q.work_id);
   // Durable lease recovery already resumes RUNNING. There is no resource
   // renewal for an explicitly cancelled, invalidated or spent episode.
   throw new CapitalProgramV2Error('CONFLICT','Cancelled/terminal episodes cannot renew their grant; active durable jobs recover with the original deadline');
  }
  case 'capital-program-recompile':{
   const {queryId,idempotencyKey,replacement}=input as {queryId:string;idempotencyKey:string;replacement?:CapitalProgramV2Request},
    q=await m3Query(ctx,queryId);
   if(replacement&&(replacement.workId!==q.work_id||replacement.idempotencyKey!==idempotencyKey))
    throw new CapitalProgramV2Error('INVALID_REQUEST','Exact replacement Work and idempotency identity are required');
   return {status:202,body:await submitCapitalProgram(ctx,replacement??{...q.request,idempotencyKey},q.id)};
  }
  case 'capital-program-select':{
   const selected=input as {queryId:string;candidateDigest:string;idempotencyKey:string;intent:string},
    {queryId,candidateDigest}=selected,program=await requireProgram(ctx,queryId),
    candidate=program.candidates.find(c=>c.semanticDigest===candidateDigest);
   if(!candidate)throw m3Unavailable();
   if(selected.intent==='MODEL_BRANCH_REVIEW')return {status:200,body:await reviewNativeBranch(ctx,selected,program)};
   if(candidate.blockers.length||!candidate.policyRef||!program.evidenceSlice)
    throw new CapitalProgramV2Error('BLOCKED_SELECTION','AGREEMENT_OR_OWNER_BINDING_INCOMPLETE: no reservation or effect created');
   const covered=await inM1Episode(m3Remaining(),()=>consumeDecisionSlice(ctx,program.evidenceSlice,'DECISION'));
   if(covered.status==='INSUFFICIENT_DECISION_COVERAGE')
    throw new CapitalProgramV2Error('BLOCKED_SELECTION','INSUFFICIENT_DECISION_COVERAGE: exact current M1 legal/response/authority closure is required before S5/S4 handoff');
   // M1's current declared contract always retains material native coverage
   // gaps. Even a future zero-gap result requires an admitted selection port.
   throw new CapitalProgramV2Error('BLOCKED_SELECTION','S4_SELECTION_AUTHORITY_INCOMPLETE: no admitted agreement/funding/effect selection port was supplied');
  }
 }
 throw m3Unavailable();
}
export function capitalProgramResponseError(error:unknown):{status:number;body:{error:string;code:string}}|null{
 if(error instanceof z.ZodError)return {status:400,body:{error:'Bounded typed capital programme request required',code:'INVALID_REQUEST'}};
 if(error instanceof PeDomainError&&/NOT_FOUND/.test(error.code)||error instanceof DecisionSliceError&&error.code==='UNAVAILABLE'||
  error instanceof AllocationContractError&&error.code==='PERMITTED_CONTEXT_UNAVAILABLE'||
  error instanceof ChallengeError&&error.code==='UNAVAILABLE')error=m3Unavailable();
 if(error instanceof ChallengeError)error=new CapitalProgramV2Error(
  error.code==='CANCELLED'?'STALE_INPUT':error.code==='PENDING_M3_READER'?'CONFIGURATION_REQUIRED':error.code,
  'Original challenge evidence cannot support this repair');
 if(error instanceof CapitalProgramV2Error){
  const status=error.code==='UNAVAILABLE'?404:error.code==='INVALID_REQUEST'?400:error.code==='LIMIT_EXCEEDED'?413:
   ['CONFLICT','STALE_INPUT','BLOCKED_SELECTION'].includes(error.code)?409:error.code==='CONFIGURATION_REQUIRED'?503:422;
  return {status,body:{error:error.message,code:error.code}};
 }return null;
}
