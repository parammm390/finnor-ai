import {beginWorkPlannerAttempt,finishWorkPlannerAttempt,activeWorkPlanRevision,persistSelectedWorkPlan} from '@finnor/db';
import {DEFAULT_PLAN_BUDGETS,buildGoalSpec,buildConstraintSet,buildPlanningWorldSnapshot} from '../../../planning/src/builders';
import {compileAndSelectPlans,DETERMINISTIC_PLAN_COMPILER_VERSION} from '../../../planning/src/compiler';
import type {ExperimentRef,ContingentPolicy,InterventionModel,ExperimentProtocol,EvidenceDependency,EvidenceDerivation} from '@finnor/shared-types';
import type {InterventionControlSnapshot} from '../../../epistemic-runtime/src/intervention-control';
import {resolveDecisionWork,principal} from '../decision-slice/adapters';
import type {WorkBinding} from '../decision-slice/contracts';
import {readEnterpriseControlDecisionContext} from '../enterprise-control';
import {authorizeBeliefResources} from '../enterprise-beliefs';
import {listEnterpriseAllocationResources} from '../enterprise-allocation';
import type {AllocationSnapshot} from '../allocation-store';
import {prepareUnderwritingRun} from '../underwriting-repository';
import {codeIdentity,schemaIdentity,revisions,assertDependencies,currentDerivation} from '../evidence-execution/store';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {m3Tx,m3AuthorizePrincipal} from './v2-store';
import {m3Hash,m3Same,CapitalProgramV2Error,type CapitalProgramV2Request} from './v2-contracts';
import {m3CheckTime} from './v2-budget';
import {allocationQuantity} from '../../../epistemic-runtime/src/allocation-contracts';
import {readIssuedCapitalChallenge} from '../counterexample-search/service';
import type {CurrentSlice} from '../decision-slice/service';

export interface CapitalOwnerBinding {
 work:WorkBinding;plan:{id:string;semanticHash:string;workInputId:string};
 policy:ContingentPolicy;model:InterventionModel;kernel:InterventionControlSnapshot;protocols:ExperimentProtocol[];
 resources:AllocationSnapshot;outstandingEffects:Array<{id:string;status:string;semantic_hash:string}>;
 code:Awaited<ReturnType<typeof codeIdentity>>;schemaDigest:string;dependencies:EvidenceDependency[];
 ownerVector:Array<{key:string;digest:string}>;validUntil:string;
 recompilation?:{parentQueryId:string;parents:ExperimentRef[];
  changedDependencies:Array<{key:string;previousDigest:string|null;currentDigest:string|null}>};
 challengeEvidence?:Array<{searchId:string;resultRef:ExperimentRef;candidateRef:ExperimentRef;witnessRefs:ExperimentRef[];
  repairDependencyRef:ExperimentRef;deadlineAt:string}>;
 repairBudget?:import('./repair-budget').CapitalRepairBudget;
 nativeFinance:{modelRef:ExperimentRef;model:import('@finnor/underwriting').UnderwritingModelIR;
  input:import('@finnor/underwriting').UnderwritingInputSnapshot;inputDigest:string;derivations:EvidenceDerivation[]}|null;
}
async function bindCanonicalPlan(ctx:PeMutationContext,work:WorkBinding,policy:ContingentPolicy){
 const previous=await activeWorkPlanRevision(ctx.auth.tenantId,work.id);
 // Never replace another active plan simply to attach an economic proposal.
 if(previous?.workInputId===work.inputId)return {id:previous.id,semanticHash:previous.semanticHash,workInputId:work.inputId};
 const attempt=await beginWorkPlannerAttempt({tenantId:ctx.auth.tenantId,workId:work.id,workInputId:work.inputId,
  attemptKey:`m3-proposal:${work.inputDigest}`,decisionContext:{work,mandateRef:policy.mandateRef,modelRef:policy.bindings.modelRef}});
 const goal=buildGoalSpec({objective:'Inspect bounded capital programme alternatives, retaining owner blockers and no execution authority',
  workId:work.id,workInputId:work.inputId,successCondition:{source:'explicit',criteria:[{kind:'capital_program_proposal',status:'checked_or_blocked'}]},
  explicitNonGoals:['No reservation, provider dispatch, agreement, settlement or business authority is granted by search']});
 const constraints=buildConstraintSet({tenantId:ctx.auth.tenantId,verticalKey:'private_equity',
  allowedCapabilities:['query:pe_world_state','check:objective_success'],humanOnlyCapabilities:[],prohibitedCapabilities:[],
  authorityRevision:null,budgets:DEFAULT_PLAN_BUDGETS,softPreferences:[]});
 const root=policy.bindings.beliefPins[0]?.root;
 if(!root)throw new CapitalProgramV2Error('CHECK_FAILED','Owner policy lacks its actual S1 root binding');
 const snapshot=buildPlanningWorldSnapshot({workId:work.id,workInputId:work.inputId,plannerAttemptId:attempt.id,
  tenantId:ctx.auth.tenantId,verticalKey:'private_equity',capturedAt:new Date().toISOString(),decisionContextHash:work.inputDigest,
  canonicalStateHash:m3Hash(policy.bindings),authority:{employeeId:principal(ctx),revision:null,roles:['owner']},
  capabilities:[{capability:'query:pe_world_state',kind:'query',modelProposable:false,available:true,health:'available',risk:'low',
   irreversible:false,requiredReferences:[],effectClass:null,observationStrategy:'operational_query',reversibility:'read_only',
   supportedRecoveryModes:['retry'],externalSideEffect:false,authorityRequirement:'query'},
   {capability:'check:objective_success',kind:'check',modelProposable:false,available:true,health:'available',risk:'low',
   irreversible:false,requiredReferences:[],effectClass:null,observationStrategy:'objective_success',reversibility:'read_only',
   supportedRecoveryModes:['replan'],externalSideEffect:false,authorityRequirement:'query'}],
  currentEffects:[],sourceHealth:{status:'partial',missing:['Agreement/decision coverage/protected admission remain separate owner predicates']}});
 const candidate={version:1 as const,candidateKey:'m3-nonconsequential-proposal',nodes:[
  {key:'current-owner-context',kind:'query' as const,request:{intent:'pe_world_state',root},
   supports:goal.criteria.map(c=>c.id)},
  {key:'inspect-proposal',kind:'check' as const,dependsOn:['current-owner-context'],criterionId:goal.criteria[0]!.id,
   observation:{kind:'capital_program_proposal',status:'checked_or_blocked',executionAuthorityGranted:false}}]};
 const fact={registered:true,schemaValid:true,schemaErrors:[],grounded:true,crossTenant:false,stale:false,
  authority:'allowed' as const,health:'available' as const,risk:'low' as const,irreversible:false,
  preconditionsSatisfied:true,supportedRecoveryModes:['retry' as const,'replan' as const],estimatedCostMicros:null,estimatedLatencyMs:null};
 const compilation=compileAndSelectPlans({goal,constraints,snapshot,candidates:[candidate],
  facts:[{candidateKey:candidate.candidateKey,nodes:{'current-owner-context':fact,'inspect-proposal':fact}}]});
 if(!compilation.selected?.graph)throw new CapitalProgramV2Error('CHECK_FAILED','Canonical plan compiler refused proposal: '+JSON.stringify(compilation.candidates.flatMap(c=>c.violations)));
 try{
  const selected=compilation.selected,revision=await persistSelectedWorkPlan({tenantId:ctx.auth.tenantId,workId:work.id,
   workInputId:work.inputId,plannerAttemptId:attempt.id,parentRevisionId:previous?.id,reason:previous?'redirect':'initial',
   goalSpec:goal,constraintSet:constraints,planningSnapshot:snapshot,candidatePlans:[candidate],compilationResult:compilation,
   planGraph:selected.graph!,score:selected.score,semanticHash:selected.graph!.semanticHash,compilerVersion:DETERMINISTIC_PLAN_COMPILER_VERSION});
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'succeeded',
   plannerResult:{selectedPlanRevisionId:revision.id,compiler:DETERMINISTIC_PLAN_COMPILER_VERSION,noBusinessEffects:true}});
  return {id:revision.id,semanticHash:revision.semanticHash,workInputId:work.inputId};
 }catch(error){
  await finishWorkPlannerAttempt({tenantId:ctx.auth.tenantId,attemptId:attempt.id,status:'failed',failure:{code:'M3_PLAN_SELECTION_REFUSED'}});
  throw error;
 }
}
export async function resolveCapitalOwners(ctx:PeMutationContext,request:CapitalProgramV2Request,createPlan=false):Promise<CapitalOwnerBinding>{
 m3CheckTime();await m3AuthorizePrincipal(ctx);
 const work=await resolveDecisionWork(ctx,request.workId),{policy,model,kernel,protocols}=await readEnterpriseControlDecisionContext(ctx,request.incumbentPolicyRef),
  resources=await listEnterpriseAllocationResources(ctx);
 if(policy.tenantId!==ctx.auth.tenantId||policy.principalId!==principal(ctx)||policy.mandate.businessOwnerRef.id!==principal(ctx))
  throw new CapitalProgramV2Error('UNAVAILABLE','Permitted capital programme is unavailable');
 const plan=createPlan?await bindCanonicalPlan(ctx,work,policy):await (async()=>{
  const row=await activeWorkPlanRevision(ctx.auth.tenantId,work.id);
  if(!row||row.workInputId!==work.inputId)throw new CapitalProgramV2Error('STALE_INPUT','Canonical Work Plan/Input binding changed');
  return {id:row.id,semanticHash:row.semanticHash,workInputId:row.workInputId};
 })();
 const outstandingEffects=await m3Tx(ctx,async c=>{
  const rows=(await c.query<{id:string;status:string;semantic_hash:string}>("SELECT id::text,status,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated') ORDER BY id LIMIT 257",[ctx.auth.tenantId])).rows;
  if(rows.length>256)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Complete S6 liability membership exceeds supported bounded view');
  return rows;
 },true);
 let nativeFinance:CapitalOwnerBinding['nativeFinance']=null;
 const financialKeys:string[]=[],derivedDependencies:EvidenceDependency[]=[];
 if(request.financial){
  await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:request.financial.investmentCaseId},{type:'underwriting_model_version',id:request.financial.modelVersionId}]);
  const derivations=await Promise.all([...new Set(Object.values(request.financial.evidenceDerivationInputs??{}).map(b=>b.derivationId))]
   .map(id=>currentDerivation(ctx,id)));
  for(const derivation of derivations){
   if(derivation.work.id!==work.id||derivation.work.revision!==work.inputId)
    throw new CapitalProgramV2Error('STALE_INPUT','P4 financial input requires this exact current Work revision');
   derivedDependencies.push(...derivation.invalidationKeys);
  }
  const financialKnowledgeAt=new Date(Math.max(Date.parse(policy.knowledgeAt),...derivations.map(d=>Date.parse(d.knowledgeAt)))).toISOString();
  if(Date.parse(financialKnowledgeAt)>Date.now())throw new CapitalProgramV2Error('INVALID_REQUEST','Future P4 knowledge cannot bind financial consequences');
  const prepared=await prepareUnderwritingRun(ctx,{investmentCaseId:request.financial.investmentCaseId,modelVersionId:request.financial.modelVersionId,
   worldAt:financialKnowledgeAt,evidenceDerivationInputs:request.financial.evidenceDerivationInputs});
  const inputNode=prepared.compiled.nodeById[request.financial.nodeId],input=prepared.effectiveSnapshot;
  if(!inputNode||inputNode.kind!=='input'||inputNode.shape!=='scalar'||inputNode.valueType!=='decimal')
   throw new CapitalProgramV2Error('INVALID_REQUEST','Financial term must resolve an actual native scalar input and unit');
  if(prepared.compiled.model.runtime||prepared.compiled.model.nodes.some(node=>node.shape==='series'||node.kind==='schedule')){
   const horizon=policy.mandate.horizon,periods=prepared.compiled.periods,start=Date.parse(horizon.startAt);
   if(periods.length!==horizon.periods||periods.some((period,index)=>
    Date.parse(period.startDate)!==start+index*horizon.periodMs||
    Date.parse(period.endDate)+86400000!==start+(index+1)*horizon.periodMs))
    throw new CapitalProgramV2Error('INVALID_REQUEST','NATIVE_FINANCIAL_CALENDAR_GRID_MISMATCH: dated native consequences must use the exact original S3/S4 period edges, without resampling');
  }
  const financial=request.financial,meaning=financial.semantics,
   target=await m3Tx(ctx,async c=>(await c.query<{deal_id:string;target_id:string}>(
    'SELECT i.deal_id::text,d.target_organization_id::text target_id FROM finnor_os.pe_investment_cases i JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id WHERE i.tenant_id=$1 AND i.id=$2',
    [ctx.auth.tenantId,financial.investmentCaseId])).rows[0],true),
   exposure=model.request.exposures.find(e=>e.id===request.permitted.exposureId),
   action=policy.problem.actions.find(a=>a.id===request.permitted.actionId),
   unit=meaning.unit==='currency'?meaning.currencyCode:meaning.unit;
  if(!target||!exposure||!action||!inputNode.evidenceSemantics||!m3Same(inputNode.evidenceSemantics,meaning)||
   meaning.entityType!=='external_organization'||meaning.entityId!==target.target_id||!m3Same(exposure.root,{entityType:meaning.entityType,entityId:meaning.entityId})||
   meaning.scale!=='1'||meaning.sign!=='AS_RECORDED'||meaning.consolidation!=='OWNER_SUBJECT_ONLY'||
   meaning.frequency!=='instant'||Date.parse(meaning.periodStart)!==Date.parse(policy.mandate.horizon.startAt)||
   Date.parse(meaning.periodEnd)!==Date.parse(policy.mandate.horizon.startAt)+policy.mandate.horizon.periodMs*policy.mandate.horizon.periods||
   inputNode.unit!==(meaning.unit==='currency'?'money':meaning.unit)||inputNode.currency!==(meaning.currencyCode??undefined)||
   request.permitted.unit!==unit||exposure.unit!==unit||request.purpose==='FINANCING'&&exposure.operation!=='FINANCING_CHANGE')
   throw new CapitalProgramV2Error('INVALID_REQUEST','Exact immutable native entity/unit/currency/scale/sign/clock/instrument binding is required; no conversion or time resampling is inferred');
  if(Object.values(input.values).some(v=>v.status!=='KNOWN'||v.value===null))
   throw new CapitalProgramV2Error('CHECK_FAILED','NATIVE_INPUT_STANDING_UNRESOLVED: no unknown finance input becomes zero');
  const original=input.values[financial.nodeId];
  if(typeof original?.value!=='string'||!action.exposures[exposure.id]||
   allocationQuantity(original.value).compare(allocationQuantity(String(action.exposures[exposure.id]![0])))!==0)
   throw new CapitalProgramV2Error('INVALID_REQUEST','Incumbent financial input and S3 intervention must have the same exact registered parameter');
  financialKeys.push(`canonical:pe_investment_case:${financial.investmentCaseId}`,`canonical:pe_deal:${target.deal_id}`);
  for(const value of Object.values(input.values))for(const provenance of value.provenance){
   if(provenance.kind==='p1_assumption')financialKeys.push(`canonical:pe_assumption:${provenance.id}`);
   if(provenance.kind==='evidence_version')financialKeys.push(`source-version:${provenance.id}`);
  }
  nativeFinance={modelRef:{owner:'@finnor/underwriting',id:request.financial.modelVersionId,version:prepared.compiled.model.modelVersion,
   contentDigest:prepared.compiled.semanticHash},model:prepared.compiled.model,input,inputDigest:m3Hash(input),derivations};
 }
 const keys=['rights:tenant',`work-inputs:${work.id}`,`m3:plan:${work.id}`,'m3:s5-complete','m3:s6-effects',...financialKeys,
  ...model.request.roots.map(root=>`m3:root:${root.entityType}:${root.entityId}`),
  ...model.request.stateVariables.map(v=>`metric-observations:${v.seriesId}`),
  ...model.request.exposures.map(v=>`metric-observations:${v.seriesId}`),
  ...model.beliefBindings.map(b=>`canonical:${b.pin.root.entityType}:${b.pin.root.entityId}`)];
 await assertDependencies(ctx,derivedDependencies);
 const dependencyMap=new Map<string,EvidenceDependency>();
 for(const dependency of [...derivedDependencies,...await revisions(ctx,keys)]){
  const prior=dependencyMap.get(dependency.key);
  if(prior&&prior.revision!==dependency.revision)throw new CapitalProgramV2Error('STALE_INPUT','P4 and economic owner inputs do not share a current dependency cut');
  dependencyMap.set(dependency.key,dependency);
 }
 const dependencies=[...dependencyMap.values()].sort((a,b)=>a.key.localeCompare(b.key)),
  code=await codeIdentity(),schemaDigest=await schemaIdentity(ctx);
 const ownerVector=[
  {key:`work-input:${work.id}`,digest:work.inputDigest},{key:`plan:${plan.id}`,digest:plan.semanticHash},
  {key:'s4-authorized-unchanged-mandate',digest:m3Hash(policy.mandate)},
  {key:'s4-incumbent-retained-law-input',digest:m3Hash({policy,model,kernel,protocols})},
  {key:'s5-complete-registry-outstanding',digest:resources.snapshotDigest},
  {key:'s6-complete-accountable-effects',digest:m3Hash(outstandingEffects)},
  ...(nativeFinance?[{key:'native-finance-owner-input',digest:nativeFinance.inputDigest}]:[]),
 ].sort((a,b)=>a.key.localeCompare(b.key));
 return {work,plan,policy,model,kernel,protocols,resources,outstandingEffects,code,schemaDigest,dependencies,ownerVector,
  nativeFinance,validUntil:new Date(Math.min(Date.parse(policy.validUntil),...resources.resources.map(r=>Date.parse(r.validUntil)))).toISOString()};
}
export async function recheckCapitalOwners(ctx:PeMutationContext,request:CapitalProgramV2Request,binding:CapitalOwnerBinding,
 checkedEvidence?:CurrentSlice):Promise<void>{
 m3CheckTime();await assertDependencies(ctx,binding.dependencies);
 if(checkedEvidence&&!request.financial&&!binding.nativeFinance&&!binding.protocols.length){
  const evidence=checkedEvidence.binding,incumbent=evidence.policies.find(p=>m3Same(p.policy.ref,request.incumbentPolicyRef));
  if(evidence.tenantId!==ctx.auth.tenantId||evidence.principalId!==principal(ctx)||!m3Same(evidence.work,binding.work)||
   !incumbent||!m3Same(incumbent,{policy:binding.policy,model:binding.model,kernel:binding.kernel})||
   !evidence.resourceSnapshot||!m3Same(evidence.resourceSnapshot,binding.resources))
   throw new CapitalProgramV2Error('STALE_INPUT','Same-call M1 proof differs from the complete original capital owner preimages');
  const effects=await m3Tx(ctx,async c=>(await c.query(
   "SELECT id::text,status,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated') ORDER BY id LIMIT 257",
   [ctx.auth.tenantId])).rows,true);
  if(effects.length>256)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Complete S6 liability membership exceeds supported bounded view');
  if(!m3Same(effects,binding.outstandingEffects))
   throw new CapitalProgramV2Error('STALE_INPUT','Actual S6 accountable effect membership changed');
  await assertCapitalOwnerBinding(ctx,binding);return;
 }
 if(binding.challengeEvidence){
  for(const expected of binding.challengeEvidence){
   const issued=await readIssuedCapitalChallenge(ctx,expected.searchId,expected.resultRef);
   if(!m3Same(expected.resultRef,issued.report.ref)||!m3Same(expected.candidateRef,issued.report.candidate)||
    !m3Same(expected.witnessRefs,issued.report.independentWitnesses)||!m3Same(expected.repairDependencyRef,issued.report.repairDependencies)||
    expected.deadlineAt!==issued.deadlineAt)
    throw new CapitalProgramV2Error('CHECK_FAILED','Original challenge repair evidence changed');
  }
 }
 const next=await resolveCapitalOwners(ctx,request);
 if(!m3Same(binding.ownerVector,next.ownerVector)||binding.code.digest!==next.code.digest||
  binding.schemaDigest!==next.schemaDigest||Date.now()>=Date.parse(binding.validUntil))
  throw new CapitalProgramV2Error('STALE_INPUT','Capital programme Work/owner/source/method/resource binding changed');
}
/** Live fence over an already fully checked same-call or frozen owner input.
 * Never replaces the full owner replay at worker publication. */
export async function assertCapitalOwnerBinding(ctx:PeMutationContext,binding:CapitalOwnerBinding):Promise<CapitalOwnerBinding['code']>{
 m3CheckTime();await m3AuthorizePrincipal(ctx);await assertDependencies(ctx,binding.dependencies);
 const work=await resolveDecisionWork(ctx,binding.work.id),plan=await activeWorkPlanRevision(ctx.auth.tenantId,work.id);
 if(!m3Same(work,binding.work)||!plan||plan.id!==binding.plan.id||plan.semanticHash!==binding.plan.semanticHash||
  plan.workInputId!==binding.plan.workInputId||Date.now()>=Date.parse(binding.validUntil))
  throw new CapitalProgramV2Error('STALE_INPUT','Checked capital Work, plan, validity or owner revisions changed');
 if(binding.challengeEvidence)for(const expected of binding.challengeEvidence){
  const issued=await readIssuedCapitalChallenge(ctx,expected.searchId,expected.resultRef);
  if(!m3Same(expected.resultRef,issued.report.ref)||!m3Same(expected.candidateRef,issued.report.candidate)||
   !m3Same(expected.witnessRefs,issued.report.independentWitnesses)||!m3Same(expected.repairDependencyRef,issued.report.repairDependencies)||
   expected.deadlineAt!==issued.deadlineAt)
   throw new CapitalProgramV2Error('CHECK_FAILED','Original challenge repair evidence changed');
 }
 const checkedCode=await codeIdentity();
 if(binding.code.digest!==checkedCode.digest||binding.schemaDigest!==await schemaIdentity(ctx))
  throw new CapitalProgramV2Error('STALE_INPUT','Checked capital source or schema changed');
 m3CheckTime();
 return checkedCode;
}
