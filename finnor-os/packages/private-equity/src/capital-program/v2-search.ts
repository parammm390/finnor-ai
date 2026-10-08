import {compileUnderwritingModel,executeUnderwritingModel,applyScenario} from '@finnor/underwriting';
import type {ContingentPolicy,ExperimentRef} from '@finnor/shared-types';
import {synthesizeEnterpriseControlProposal} from '../enterprise-control';
import {proposeEnterpriseSameDealAlternatives} from '../enterprise-allocation';
import {compileDecisionSlice,readCurrentDecisionSlice,type CurrentSlice} from '../decision-slice/service';
import {inM1Episode} from '../decision-slice/budget';
import {evidenceDerivationRef,evidenceComputeRefs} from '../evidence-execution/consumer';
import type {PeMutationContext} from '../types';
import {economicDescriptors} from './v2-grammar';
import {refineEconomicModule} from './v2-refinement';
import {m3Event,writeM3Record,m3Tx,type M3QueryRow} from './v2-store';
import {m3CheckTime,m3Remaining} from './v2-budget';
import {m3Hash,m3Ref,m3Blocker,m3Bounded,CapitalProgramV2Error,CAPITAL_PROGRAM_V2_VERSION,
 type CapitalProgramV2,type CapitalProgramV2Candidate,type CapitalProgramV2Module} from './v2-contracts';
import {capitalPendingRequests} from './v2-pending';

const reason=(error:unknown)=>error instanceof CapitalProgramV2Error?error.message:
 error instanceof Error?/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'OWNER_OR_NATIVE_PREDICATE_UNPASSED':'OWNER_OR_NATIVE_PREDICATE_UNPASSED';
export async function searchCapitalProgram(ctx:PeMutationContext,q:M3QueryRow,attemptId:string,
 checkpoint:()=>Promise<void>):Promise<{program:CapitalProgramV2;evidence:CurrentSlice}>{
 const started=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss,binding=q.acceptance,
  acceptedRequest=q.request,request=binding.repairBudget?{...acceptedRequest,resource:binding.repairBudget.remaining}:acceptedRequest,
  {descriptors,omitted,domain}=economicDescriptors(request,binding.policy,binding.model,binding.protocols);
 const candidates:CapitalProgramV2Candidate[]=[],policies:ContingentPolicy[]=[],modules=new Map<string,CapitalProgramV2Module>(),
  blockers:CapitalProgramV2['blockers']=[],unknownAttemptIds:string[]=[];
 let steps=q.refinement_steps,expansions=0,attempted=q.attempted;
 await m3Tx(ctx,async c=>{await c.query('UPDATE finnor_os.m3_queries SET generated=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
  [q.tenant_id,q.principal_id,q.id,descriptors.length+omitted]);});
 for(const descriptor of descriptors){
  // Leave part of the same grant for the complete owner/evidence checks and
  // publication. Unvisited proposals stay in the denominator, never optimal.
  if(attempted>=request.resource.maxAttempts||m3Remaining()<Math.max(2000,Math.min(12000,Math.ceil(request.resource.deadlineMs/3))))break;
  await checkpoint();m3CheckTime();attempted++;
  await m3Tx(ctx,async c=>{
   await c.query('UPDATE finnor_os.m3_queries SET attempted=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
    [q.tenant_id,q.principal_id,q.id,attempted]);
   await m3Event(ctx,q.id,attemptId,'CANDIDATE',{phase:'STARTED',descriptor,domain,costUSD:null,generation:q.generation},c);
  });
  const candidate:CapitalProgramV2Candidate={semanticDigest:descriptor.semanticDigest,parentDigest:descriptor.parentDigest,
   operator:descriptor.operator,structure:descriptor.structure,terms:descriptor.terms,
   agreement:{status:'PROPOSED',targetDigest:m3Hash({terms:descriptor.terms,problem:descriptor.problem,domain}),
    requiredStanding:request.permitted.agreement==='COUNTERPARTY_REQUIRED'?'EXACT_NEW_TERM_PARTIES_ENTITY_AMOUNT_PERIOD_OPERATIVE_AMENDMENT_AND_RECEIVED_ACCEPTANCE':'AUTHENTICATED_UNILATERAL_PROPOSAL_NOT_AN_EFFECT',
    liveAgreementRef:null},disposition:'BLOCKED',reason:null,policyRef:null,demandDigest:null,moduleRef:null,moduleExecution:null,
   refinementSteps:0,valueBasis:'S4_ROBUST_FIXED_JOINT_WORLDS_NO_PROBABILITIES',valueBounds:null,
   changedResponseRecomputed:false,finitePolicyComplete:false,nativeFinance:null,blockers:descriptor.blockers};
  candidates.push(candidate);
  if(descriptor.blockers.length){candidate.reason=descriptor.blockers[0]!.code;blockers.push(...descriptor.blockers);
   await m3Event(ctx,q.id,attemptId,'CANDIDATE',{phase:'BLOCKED',candidate,costUSD:null});continue;}
  try{
   let reservedSteps=0;
   const lowered=await refineEconomicModule({descriptor,base:binding.policy.problem,request,
    remainingSteps:Math.max(0,request.resource.maxRefinementSteps-steps),onPrepared:async(preimage)=>{
     const prepared=preimage as {refinement:CapitalProgramV2Module['refinement']};
     reservedSteps=prepared.refinement.length;steps+=reservedSteps;candidate.refinementSteps=reservedSteps;
     await m3Tx(ctx,async c=>{
      await c.query('UPDATE finnor_os.m3_queries SET refinement_steps=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
       [q.tenant_id,q.principal_id,q.id,steps]);
      await m3Event(ctx,q.id,attemptId,'MODULE_PREPARED',{semanticDigest:descriptor.semanticDigest,preimage,costUSD:null},c);
     });
     await checkpoint();
    }});
   const {ref:moduleRef,...moduleBody}=lowered.module;await writeM3Record(ctx,'modules',moduleRef,moduleBody);
   modules.set(descriptor.semanticDigest,lowered.module);candidate.moduleRef=moduleRef;candidate.moduleExecution=lowered.module.execution;
   if(binding.nativeFinance){
    const finance=binding.nativeFinance,compiled=compileUnderwritingModel(finance.model),
     scenario=descriptor.structure==='INCUMBENT'||descriptor.structure==='WAIT_STOP'?undefined:{
      schemaVersion:'underwriting-scenario.v1' as const,name:'Proposed exact economic term',
      overrides:[{nodeId:request.financial!.nodeId,value:descriptor.term,
       reason:'Exact new-term numerical hypothetical only, not an agreed/funded financial offer'}]},
     snapshot=applyScenario(compiled,finance.input,scenario).snapshot,
     result=executeUnderwritingModel(compiled,finance.input,scenario);
    candidate.nativeFinance={modelRef:finance.modelRef,inputDigest:m3Hash(snapshot),resultDigest:m3Hash(result),result,
     qualification:'AUTHENTICATED_OWNER_BASE_DECIMAL_NATIVE_RECOMPUTATION_PROPOSED_TERMS_NOT_S4_UTILITY_OR_LIVE_FUNDING'};
    if(result.status!=='SUCCEEDED')throw new CapitalProgramV2Error('CHECK_FAILED','NATIVE_FINANCIAL_CONSEQUENCES_INVALID');
   }
   await checkpoint();
   if(descriptor.structure==='INCUMBENT'){
    candidate.policyRef=binding.policy.ref;candidate.demandDigest=binding.policy.demand.contentDigest;
    candidate.valueBounds=binding.policy.certificate.valueBounds;candidate.finitePolicyComplete=binding.policy.certificate.completeSearch;
    candidate.disposition='CHECKED_MODEL_RELATIVE';policies.push(binding.policy);
    await m3Event(ctx,q.id,attemptId,'CHECK',{candidate,reusedCurrentOriginalOwnerPolicy:true,costUSD:null});continue;
   }
   const remainingExpansions=request.resource.maxExpansions-expansions;
   if(remainingExpansions<1)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','SHARED_EXPANSION_BUDGET_EXHAUSTED');
   const produced=await synthesizeEnterpriseControlProposal(ctx,{incumbentPolicyRef:binding.policy.ref,problem:lowered.problem,
    remainingDeadlineMs:Math.min(binding.policy.mandate.search.deadlineMs,m3Remaining()),remainingExpansions});
   expansions+=produced.compute.usage.expansions;candidate.changedResponseRecomputed=true;
   if(!produced.policy){candidate.disposition='REJECTED';candidate.reason=produced.reasons[0]??produced.status;}
   else{
    candidate.policyRef=produced.policy.ref;candidate.demandDigest=produced.policy.demand.contentDigest;
    candidate.valueBounds=produced.policy.certificate.valueBounds;candidate.finitePolicyComplete=produced.policy.certificate.completeSearch;
    candidate.disposition=produced.policy.resultState==='POLICY_AVAILABLE'?'CHECKED_MODEL_RELATIVE':'BLOCKED';
    candidate.reason=produced.policy.resultState==='POLICY_AVAILABLE'?null:produced.reasons[0]??produced.policy.resultState;
    if(produced.policy.resultState==='POLICY_AVAILABLE')policies.push(produced.policy);
   }
   if(request.permitted.agreement==='COUNTERPARTY_REQUIRED'&&descriptor.structure!=='INCUMBENT'&&descriptor.structure!=='WAIT_STOP'){
    const blocker=m3Blocker('UNSUPPORTED_AGREEMENT_CONDITION','S4/S1','New exact offer has no current received agreement-state primitive or amendment/authorized-party standing; modeled policy is not activatable funding');
    candidate.blockers.push(blocker);blockers.push(blocker);
   }
   await m3Event(ctx,q.id,attemptId,'CHECK',{candidate,ownerCompute:produced.compute,costUSD:null});
  }catch(error){
   if(error instanceof CapitalProgramV2Error&&error.code==='STALE_INPUT')throw error;
   candidate.disposition='REJECTED';candidate.reason=reason(error);
   candidate.blockers.push(m3Blocker(candidate.reason,'M3/S3/S4/S5','No compiled or owner-supported new course is usable for this failed predicate'));
   blockers.push(...candidate.blockers);await m3Event(ctx,q.id,attemptId,'CHECK',{candidate,costUSD:null,failure:reason(error)});
  }
 }
 // Always retain the original checked owner incumbent. It is not treated as a
 // generated/effect-capable module if this episode cannot refine any bytes.
 if(!policies.length)policies.push(binding.policy);
 await checkpoint();
 let allocation:CapitalProgramV2['allocation']={problem:null,checks:[],qualification:'PURE_S5_PROPOSAL_UNAVAILABLE_NOT_PORTFOLIO_CLEARANCE',reservationCreated:false};
 const allocationTask=async()=>{
  await checkpoint();
  const proposal=await proposeEnterpriseSameDealAlternatives(ctx,{workId:request.workId,incumbentPolicyRef:binding.policy.ref,policyRefs:policies.map(p=>p.ref)});
  await m3Event(ctx,q.id,attemptId,'CHECK',{phase:'PURE_S5',problemRef:proposal.problem.ref,checks:proposal.checks,reservationCreated:false,costUSD:null});
  return proposal;
 };
 const evidenceTask=async()=>{
  await checkpoint();
  const compiled=await inM1Episode(m3Remaining(),()=>compileDecisionSlice(ctx,{schema:'finnor.decision-slice-request.v1',workId:request.workId,
   source:{kind:'POLICY',policyRefs:policies.map(p=>p.ref),incumbentRef:binding.policy.ref,
    ...(request.financial?{underwriting:{investmentCaseId:request.financial.investmentCaseId,modelVersionId:request.financial.modelVersionId,
     evidenceDerivationInputs:request.financial.evidenceDerivationInputs}}:{})},
   purpose:request.purpose==='COMMERCIAL'?'MODEL_EVIDENCE':request.purpose,
   financingChange:Boolean(request.financial||request.purpose==='FINANCING'),
   resource:{deadlineMs:m3Remaining(),maxNodes:10000,maxBytes:8388608,maxDemands:128}}));
  return inM1Episode(m3Remaining(),()=>readCurrentDecisionSlice(ctx,compiled.slice.ref));
 };
 // These owners share policy inputs, not each other's outputs. Drain both
 // under the same grant; the worker still performs full final owner replay.
 const [proposed,evidence]=await Promise.allSettled([allocationTask(),evidenceTask()]);
 if(proposed.status==='fulfilled')allocation={...proposed.value};
 else blockers.push(m3Blocker(reason(proposed.reason),'S5','Current complete joint resource/path/funding proposal remains unresolved, with no reservation'));
 if(evidence.status==='rejected')throw evidence.reason;
 await checkpoint();
 const m1=evidence.value;
 for(const gap of m1.slice.unresolvedCoverage)blockers.push(m3Blocker(gap.code,gap.requiredProducer,gap.requirement));
 const viable=candidates.filter(c=>c.policyRef&&c.disposition==='CHECKED_MODEL_RELATIVE'&&allocation.checks.some(k=>k.feasible&&k.selectedPolicyIds.length===1&&k.selectedPolicyIds[0]===c.policyRef!.id));
 let selected=viable.find(c=>c.structure==='INCUMBENT')??viable[0];
 for(const candidate of viable)if(!selected||candidate.valueBounds![0]>selected.valueBounds![0]+1e-8)selected=candidate;
 const primary=selected?.moduleRef?selected:candidates.find(c=>c.moduleRef),module=primary?modules.get(primary.semanticDigest):undefined;
 const graphBody={schema:'finnor.m3.owner-bound-economic-graph.v2',requestDigest:q.request_digest,work:binding.work,plan:binding.plan,
  acceptedDomain:domain,ownerVector:binding.ownerVector,
  programs:policies.map(p=>({policyRef:p.ref,mandateRef:p.mandateRef,modelRef:p.bindings.modelRef,dynamicsRef:p.bindings.dynamicsRef,
   nodes:p.nodes.map(n=>({node:n,action:p.problem.actions.find(a=>a.id===n.actionId),method:p.bindings.methodVersion,
    horizon:p.mandate.horizon,knowledgeAt:p.knowledgeAt,validUntil:p.validUntil,
    contracts:{costUnit:p.mandate.utility.unit,observationAvailability:'S2_OWNER_TOKEN_AND_PERIOD',agreement:'PROPOSED_NOT_LIVE',
     resources:p.demand,deadline:'ORIGINAL_MANDATE_BUSINESS_PERIODS',retry:'NONCONSEQUENTIAL_AT_MOST_ONCE_ACTION_HISTORY',
     recovery:'RECHECK_OR_LINK_ACCOUNTED_CONTINUATION',cancel:'FENCE_NEW_PROPOSALS_NOT_ACCEPTED_EFFECTS',failure:'KEEP_OWNER_STOP_OR_EXACT_BLOCKER'}}))})),
  evidenceSlice:m1.slice.ref,allocationProblemRef:allocation.problem?.ref??null,executionAuthorityGranted:false};
 const graphRef=m3Ref('owner-bound-graph',graphBody);await writeM3Record(ctx,'graphs',graphRef,graphBody);
 const remaining=descriptors.length+omitted-attempted,complete=remaining===0&&candidates.every(c=>c.finitePolicyComplete)&&!blockers.length,
  requestRef=m3Ref('capital-program-request',acceptedRequest);
 await writeM3Record(ctx,'requests',requestRef,acceptedRequest);
 const unresolvedBindings:CapitalProgramV2['unresolvedBindings']=[
  ...(!module?[{field:'programModule',requiredSchema:'finnor.m3.executable-economic-module.v2',owner:'M3',reason:'No emitted module passed refinement/type/execution within the original grant'}]:[]),
  ...(!allocation.problem?[{field:'allocationRequest',requiredSchema:'finnor.allocation-problem.v1',owner:'S5',reason:'Exact complete resource/response/funding proposal did not qualify'}]:[]),
 ];
 const unknown=await m3Tx(ctx,async c=>(await c.query<{attempt_id:string}>("SELECT DISTINCT attempt_id::text FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND body->>'unknownPhysicalCost'='true'",
  [q.tenant_id,q.principal_id,q.id])).rows.map(r=>r.attempt_id),true);unknownAttemptIds.push(...unknown);
 const usage=process.cpuUsage(cpu),body:Omit<CapitalProgramV2,'ref'>={
  schema:'finnor.capital-program.v2',producerVersion:CAPITAL_PROGRAM_V2_VERSION,originalCapability:'CapitalProgramSearch',deliveryAlias:'EconomicProgramSynthesis',
  state:module&&allocation.problem?'PROPOSED_TESTED':'PROPOSED_BLOCKED',executionAuthorityGranted:false,
  envelope:{tenantId:q.tenant_id,principalId:q.principal_id,sharingScope:'PRIVATE_PRINCIPAL',
   work:{id:binding.work.id,inputId:binding.work.inputId,inputDigest:binding.work.inputDigest},plan:binding.plan,
   parents:[binding.policy.ref,...(binding.nativeFinance?.derivations??[]).map(evidenceDerivationRef),
    ...(binding.recompilation?.parents??[])],
   recompilation:binding.recompilation??null,
   requestRef,inputDigest:m3Hash(binding),knowledgeAt:m1.slice.envelope.knowledgeAt,
   validAt:binding.policy.mandate.horizon.startAt,validUntil:binding.validUntil,
   ownerVector:[...binding.ownerVector,...m1.slice.envelope.ownerVector],sourceDigests:binding.code.files,schemaDigest:binding.schemaDigest,
   runtime:{node:process.version,platform:process.platform,architecture:process.arch,imageAttestation:null},
   grant:{limits:request.resource,qualification:'DURABLE_SHARED_LOGICAL_SEARCH_SQL_AND_SEATBELT_WALL_OUTPUT_LIMITS_NO_DOLLAR_FUNDING_OR_AGGREGATE_OS_GRANT',
    financialFundingRef:null,aggregatePhysicalLimits:'UNENFORCED',deadlineAt:q.deadline_at!.toISOString(),
    parentEpisodeQueryId:binding.repairBudget?.rootQueryId??null},
   invocationRefs:[attemptId,...policies.map(p=>p.compute.id),m1.slice.envelope.invocationRef.id],admission:{status:'BLOCKED_EXTERNAL',receipt:null}},
  mandate:binding.policy.mandateRef,valueUnit:binding.policy.mandate.utility.unit,
  programModule:module?.ref??null,ownerBoundGraph:graphRef,evidenceSlice:m1.slice.ref,
  mechanisms:[binding.model.ref],inquiries:binding.protocols.map(p=>({owner:'S2',id:p.id,version:p.version,contentDigest:p.contentDigest})),
  allocationRequest:allocation.problem?.ref??null,effectProposals:[],challengeEvidence:binding.challengeEvidence?.map(e=>e.resultRef)??[],candidates,allocation,
  incumbentAndSearchGap:{incumbentDigest:descriptors[0]!.semanticDigest,selectedDigest:selected?.semanticDigest??null,
   valueBounds:selected?.valueBounds??binding.policy.certificate.valueBounds,generatedDescriptors:descriptors.length+omitted,attemptedDescriptors:attempted,
   remainingDescriptors:remaining,finiteDomainComplete:complete,upperBound:null,globalOptimalityClaimed:false,
   modeledImprovement:selected?.valueBounds?selected.valueBounds[0]-binding.policy.certificate.valueBounds[0]:null,
   unsampledModelGap:'UNKNOWN',identificationGap:'UNKNOWN',selectionQualification:'MODEL_RELATIVE_CANDIDATE_ONLY_KEEP_ORIGINAL_INCUMBENT_PENDING_M1_AGREEMENT_S5_AND_AUTHORITY'},
  blockers:[...new Map(blockers.map(b=>[m3Hash(b),b])).values()],
  pendingRequests:capitalPendingRequests(request,[requestRef,graphRef,...(module?[module.ref]:[]),m1.slice.ref],q.deadline_at!.toISOString(),
   {...request.resource,deadlineMs:m3Remaining(),maxAttempts:Math.max(0,request.resource.maxAttempts-attempted),
    maxGenerated:Math.max(0,request.resource.maxGenerated-descriptors.length-omitted),
    maxRefinementSteps:Math.max(0,request.resource.maxRefinementSteps-steps),
    maxExpansions:unknownAttemptIds.length?0:Math.max(0,request.resource.maxExpansions-expansions)}),
  unresolvedBindings,
  costs:{money:null,status:'UNMETERED',wallMs:performance.now()-started,cpuUserMicros:usage.user,cpuSystemMicros:usage.system,
   rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,outputBytes:0,generated:descriptors.length+omitted,attempted,
   refinementSteps:steps,expansions,externalModelCalls:0,upstreamComputeRefs:[...new Set([binding.model.compute.id,binding.kernel.compute.id,
    binding.policy.compute.id,...m1.slice.envelope.cost.upstreamComputeRefs,
    ...(binding.nativeFinance?.derivations??[]).flatMap(evidenceComputeRefs)])],upstreamChargesDuplicated:false,unknownAttemptIds,
   failedAttemptCostsRetained:true},
  limitations:['H1 generated development mechanics, not original GateM3, independently sealed comparison, admission or economic gain.',
   'M1 currently withholds DECISION while material legal/coverage/model requirements remain unresolved.',
   'This financial/resource linear law is an authenticated allowed native proposal domain, not an identified intervention/resource law.',
   'Resource registry is complete and exact; model worlds/utility are finite FLOAT64, no probabilities or posterior uniform default.',
   'Staging is an upfront exposure commitment, not a conditional cash tranche. Missing observation/agreement primitives remain exact blockers.',
   'Dollars, aggregate physical limits, protected admission, hosted deployment and S7 field attribution remain unqualified.'],
 };
 body.costs.outputBytes=Buffer.byteLength(JSON.stringify(body));m3Bounded(body,request.resource.maxResultBytes);
 return {program:{...body,ref:m3Ref('capital-program',body)},evidence:m1};
}
