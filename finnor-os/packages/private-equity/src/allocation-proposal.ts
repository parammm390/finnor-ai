import {withTenantTransaction,executionDeadlineMilliseconds} from '@finnor/db';
import type {ContingentPolicy,ControlWorld,ControlObservation,ExperimentRef,CanonicalAllocationProblem,JointAllocationModel,
 AllocationDemandBinding,AllocationPolicyFunding,AllocationCheck} from '@finnor/shared-types';
import {allocationRef,allocationNumber,allocationDecimal,allocationQuantity,assertAllocationProblem,AllocationContractError,S5_VERSION,sameAllocationRef} from '../../epistemic-runtime/src/allocation-contracts';
import {verifyCanonicalAllocation} from '../../epistemic-runtime/src/allocation-checker';
import {restoreInterventionControlAdapter} from '../../epistemic-runtime/src/intervention-control';
import {controlObservationToken,controlInstrumentSupports} from '../../epistemic-runtime/src/control-observations';
import {readEnterpriseControlDecisionContext,readEnterpriseControlDecisionContexts} from './enterprise-control';
import {validateBeliefViewPin,authorizeBeliefResources} from './enterprise-beliefs';
import {readAllocationSnapshot} from './allocation-store';
import type {PeMutationContext} from './types';

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
function fail(reason:string):never{throw new AllocationContractError('INVALID_REQUEST',reason);}
const decimal=(value:number)=>allocationDecimal(allocationNumber(value));
/** S5's narrow pure adapter. The only supported composition is mutually
 * exclusive arrangements for this exact Work under one retained joint law.
 * Counterfactual payoffs are re-evaluated, not supplied by M3 or a model. */
export async function proposeEnterpriseSameDealAlternatives(ctx:PeMutationContext,input:{
 workId:string;incumbentPolicyRef:ExperimentRef;policyRefs:ExperimentRef[];
}):Promise<{problem:CanonicalAllocationProblem;checks:AllocationCheck[];reservationCreated:false;qualification:string}>{
 const started=performance.now(),limit=executionDeadlineMilliseconds()??30000,
  tick=()=>{if(performance.now()-started>=limit)throw new AllocationContractError('LIMIT_EXCEEDED','Whole pure S5 proposal budget exhausted');};
 if(ctx.auth.role!=='owner'||actor(ctx)!==ctx.auth.userId)throw new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE','Permitted S5 context is unavailable');
 await authorizeBeliefResources(ctx,[{type:'work',id:input.workId}]);
 const base=await readEnterpriseControlDecisionContext(ctx,input.incumbentPolicyRef),snapshot=await readAllocationSnapshot(ctx);
 if(!input.policyRefs.length||input.policyRefs.length>16)fail('Pure same-deal proposal supports one through sixteen owner policies');
 const policies:ContingentPolicy[]=[],contexts:Awaited<ReturnType<typeof readEnterpriseControlDecisionContext>>[]=[];
 const proposed=await readEnterpriseControlDecisionContexts(ctx,input.policyRefs.filter(ref=>!sameAllocationRef(ref,base.policy.ref)));
 for(const ref of input.policyRefs){
  tick();const context=sameAllocationRef(ref,base.policy.ref)?base:proposed.find(row=>sameAllocationRef(row.policy.ref,ref))!;
  if(!sameAllocationRef(context.policy.mandateRef,base.policy.mandateRef)||!sameAllocationRef(context.kernel.ref,base.kernel.ref)||
   !sameAllocationRef(context.model.ref,base.model.ref)||context.policy.resultState!=='POLICY_AVAILABLE')
   fail('Same-deal alternatives require the same original current S3/S4 world/mandate');
  policies.push(context.policy);contexts.push(context);
 }
 const m=base.policy.mandate,dynamics=restoreInterventionControlAdapter(base.model,base.kernel),h=m.horizon.periods;
 if(dynamics.initialWorlds.length>32)fail('S5 complete joint path constructor supports at most32 retained worlds, without subsampling');
 for(const resource of snapshot.resources)for(const pin of resource.beliefPins){
  tick();if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')throw new AllocationContractError('STALE_INPUT','S5 resource source/rights changed');
 }
 type Course={world:ControlWorld;schedule:Record<string,number[]>;utility:number;liability:number;pending:ControlObservation[];
  observations:ControlObservation[];inquiryTokens:Record<string,string>;nodeIds:string[];nodeId:string};
 function utility(world:ControlWorld,terms:typeof m.utility.periodTerms){
  return terms.reduce((value,t)=>value+t.coefficient*world.history.at(-1)!.states[t.variableId]!,0);
 }
 function value(course:Course){return course.utility+m.utility.discountFactors[h]!*(utility(course.world,m.utility.terminalTerms)-course.liability);}
 function baseline(world:ControlWorld){
  let next=structuredClone(world),v=0;
  // No-action means the declared exposure schedule, not zero future wealth.
  for(let t=0;t<h;t++){tick();next=dynamics.advance(next,Object.fromEntries(dynamics.exposureIds.map(id=>[id,base.policy.problem.baselineExposures[id]![t]!])),t);
   if(!next.supported)fail('NO_ACTION_BASELINE_OUTSIDE_OWNER_SUPPORT');
   v+=m.utility.discountFactors[t]!*utility(next,m.utility.periodTerms);}
  return v+m.utility.discountFactors[h]!*(utility(next,m.utility.terminalTerms)-m.utility.tail.terminalLiability);
 }
 function courses(policy:ContingentPolicy,world:ControlWorld,protocols:typeof base.protocols){
  const instruments=controlInstrumentSupports(protocols,base.model,m,policy.problem);
  let active:Course[]=[{world:structuredClone(world),schedule:structuredClone(policy.problem.baselineExposures),utility:0,
   liability:m.utility.tail.terminalLiability,pending:[],observations:[],inquiryTokens:{},nodeIds:[],nodeId:policy.rootNodeId}];
  for(let t=0;t<h;t++){
   const next:Course[]=[];
   for(const previous of active){
    tick();const course=structuredClone(previous),node=policy.nodes.find(n=>n.id===course.nodeId),action=policy.problem.actions.find(a=>a.id===node?.actionId);
    if(!node||!action||node.period!==t||!sameAllocationRef(node.observations,course.observations))fail('POLICY_PATH_DOES_NOT_MATCH_LAWFUL_OWNER_OBSERVATIONS');
    course.nodeIds.push(node.id);
    if(action.kind==='INTERVENE')for(const id of dynamics.exposureIds)for(let k=0;k<action.exposures[id]!.length;k++)course.schedule[id]![t+k]=action.exposures[id]![k]!;
    course.world=dynamics.advance(course.world,Object.fromEntries(dynamics.exposureIds.map(id=>[id,course.schedule[id]![t]!])),t);
    if(!course.world.supported)fail('CHANGED_ALLOCATION_TRAJECTORY_OUTSIDE_JOINT_SUPPORT');
    course.utility+=m.utility.discountFactors[t]!*(utility(course.world,m.utility.periodTerms)-action.cost);course.liability+=action.tailLiability;
    for(const instrument of policy.problem.observations.filter(i=>i.afterActionIds.includes(action.id))){
     const token=controlObservationToken(instrument,course.world);if(token===null)fail('ALLOCATION_OBSERVATION_OUTSIDE_SUPPORT');
     course.pending.push({instrumentId:instrument.id,token,availablePeriod:t+instrument.delayPeriods});
    }
    const inquiry=action.kind==='INQUIRE'?instruments.find(i=>sameAllocationRef(i.protocolRef,action.protocolRef)):undefined;
    const possibilities=inquiry?inquiry.tokensByMechanism[world.mechanismId]??[]:[null];
    if(!possibilities.length)fail('INQUIRY_JOINT_PATH_SUPPORT_UNAVAILABLE');
    for(const token of possibilities){
     const branch=structuredClone(course);
     if(inquiry&&token!==null){
      branch.pending.push({instrumentId:inquiry.protocolRef.id,token,availablePeriod:t+inquiry.delayPeriods});
      branch.inquiryTokens[`${inquiry.protocolRef.contentDigest}:${t}`]=token;
     }
     branch.observations.push(...branch.pending.filter(o=>o.availablePeriod===t+1));branch.pending=branch.pending.filter(o=>o.availablePeriod>t+1);
     if(t+1<h){const child=node.branches.find(b=>sameAllocationRef(JSON.parse(b.observationKey),branch.observations));if(!child)fail('OWNER_POLICY_MISSING_REACHABLE_BRANCH');branch.nodeId=child.childId;}
     next.push(branch);if(next.length>32)fail('Complete inquiry path count exceeds S5 proposal domain');
    }
   }active=next;
  }return active;
 }
 const scenarios:JointAllocationModel['scenarios']=[];
 for(const world of dynamics.initialWorlds){
  tick();const original=baseline(world),all=policies.map((p,i)=>courses(p,world,contexts[i]!.protocols));
  let combinations:Course[][]=[[]];for(const alternatives of all){combinations=combinations.flatMap(list=>alternatives.filter(path=>
   list.every(prior=>Object.entries(path.inquiryTokens).every(([key,token])=>prior.inquiryTokens[key]===undefined||prior.inquiryTokens[key]===token)))
   .map(path=>[...list,path]));
   if(combinations.length+scenarios.length>32)fail('All complete common paths exceed S5 native32 scenario constructor');}
  if(!combinations.length)fail('No complete compatible common inquiry information paths');
  for(const combination of combinations){
   const index=scenarios.length;
   scenarios.push({id:`retained-world-${index}`,sharedMechanismRef:base.kernel.ref,
    policyPaths:policies.map((p,i)=>({policyRef:p.ref,nodeIds:combination[i]!.nodeIds})),
    baseValue:decimal(original),terms:policies.map((p,i)=>({policyIds:[p.ref.id],
     value:allocationDecimal(allocationNumber(value(combination[i]!)).sub(allocationNumber(original))),evidenceRef:p.ref}))});
  }
 }
 const jointBody:Omit<JointAllocationModel,'ref'>={schema:'finnor.joint-allocation-model.v1',tenantId:ctx.auth.tenantId,principalId:actor(ctx),
  mandateRef:m.ref,rightsRef:m.rightsRef,sourceRefs:[base.model.ref,base.kernel.ref,...policies.map(p=>p.ref)],knowledgeAt:new Date().toISOString(),
  validUntil:new Date(Math.min(Date.parse(base.policy.validUntil),...policies.map(p=>Date.parse(p.validUntil)))).toISOString(),
  qualification:'SUPPLIED_JOINT_FINITE_SCENARIOS_UNADMITTED',ambiguity:'FIXED_COMPLETE_JOINT_PATHS_NO_PROBABILITIES',
  completeness:'ALL_MATERIAL_INTERFERENCE_AND_COMPATIBILITY_DECLARED',
  assumptions:['Authenticated owner proposal, derived from unchanged retained S3 worlds and exact S4 utility, without probabilities.',
   'Exactly one same-Work economic arrangement may be chosen. No independently summed overlapping deal wealth or cross-deal joint response is claimed.',
   'FLOAT64 trajectory values are represented as finite decimals. S5 resource checks are exact rational mechanics; this is not exact economic truth.'],
  omittedModelGap:'UNKNOWN',identificationGap:'UNKNOWN',scenarios,
  choiceConstraints:[{id:`same-deal:${input.workId}`,policyIds:policies.map(p=>p.ref.id),minimum:0,maximum:1,sourceRef:base.policy.mandateRef}]};
 const jointModel={...jointBody,ref:allocationRef('BUSINESS_OWNER','joint-allocation-model',jointBody,'s5-joint-model-v1')},
  demandBindings:AllocationDemandBinding[]=[],funding:AllocationPolicyFunding[]=[];
 for(const p of policies){
  for(const dimension of m.resources.dimensions)for(const component of ['TOTAL','OCCUPANCY'] as const){
   if(!p.nodes.some(n=>p.problem.actions.find(a=>a.id===n.actionId)![component==='TOTAL'?'resources':'occupancy'][dimension.id]!==0))continue;
   const matches=snapshot.resources.filter(r=>r.resourceId===dimension.id&&r.unit===dimension.unit&&r.resourceClass===dimension.resourceClass&&
    (component==='OCCUPANCY')===['OCCUPANCY','EXPOSURE'].includes(r.kind));
   if(matches.length!==1)fail(`EXACT_REGISTERED_RESOURCE_CLASS_KIND_UNIT_REQUIRED:${dimension.id}:${component}`);
   demandBindings.push({policyRef:p.ref,dimensionId:dimension.id,component,resourceId:matches[0]!.resourceId,conversion:'IDENTICAL_UNIT_NO_CONVERSION'});
  }
  function fundingResource(needed:boolean,unit:string,resourceClass:string):string|null{
   if(!needed)return null;
   const matches=snapshot.resources.filter(r=>r.unit===unit&&r.resourceClass===resourceClass&&['STOCK','FLOW','CUMULATIVE_EXPENDITURE'].includes(r.kind));
   if(matches.length!==1)fail(`EXPLICIT_UNAMBIGUOUS_OWNER_FUNDING_REQUIRED:${resourceClass}:${unit}`);
   return matches[0]!.resourceId;
  }
  funding.push({policyRef:p.ref,actionCostResourceId:fundingResource(p.problem.actions.some(a=>a.cost!==0),m.utility.unit,'CASH'),
   terminalLiabilityResourceId:fundingResource(m.utility.tail.terminalLiability!==0||p.problem.actions.some(a=>a.tailLiability!==0),m.utility.unit,'CASH'),
   humanSecondsResourceId:fundingResource(p.problem.actions.some(a=>a.humanSeconds!==0),'seconds','HUMAN_ATTENTION')});
 }
 const now=new Date().toISOString(),body:Omit<CanonicalAllocationProblem,'ref'>={schema:'finnor.allocation-problem.v1',tenantId:ctx.auth.tenantId,
  principalId:actor(ctx),episodeId:m.episodeId,mandate:m,policies,resources:snapshot.resources,jointModel,demandBindings,funding,
  outstanding:snapshot.outstanding,snapshotDigest:snapshot.snapshotDigest,knowledgeAt:now,
  validUntil:new Date(Math.min(Date.parse(jointModel.validUntil),...snapshot.resources.map(r=>Date.parse(r.validUntil)))).toISOString(),methodVersion:S5_VERSION};
 const problem={...body,ref:allocationRef('S5','allocation-problem',body)};assertAllocationProblem(problem);
 // Empty/single checks and every pair are a bounded certificate of same-deal
 // choice. No general allocator or pretend globally exhaustive optimizer.
 const selections:string[][]=[[],...policies.map(p=>[p.ref.id])];
 for(let a=0;a<policies.length;a++)for(let b=a+1;b<policies.length;b++)selections.push([policies[a]!.ref.id,policies[b]!.ref.id]);
 const checks=selections.map(selected=>{tick();return verifyCanonicalAllocation(problem,selected);});
 if((await readAllocationSnapshot(ctx)).snapshotDigest!==snapshot.snapshotDigest)throw new AllocationContractError('STALE_INPUT','S5 complete resources moved during proposal');
 tick();await readEnterpriseControlDecisionContexts(ctx,policies.map(p=>p.ref));
 await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
  await c.query('INSERT INTO finnor_os.s5_candidate_problems(tenant_id,principal_id,content_digest,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',
   [ctx.auth.tenantId,actor(ctx),problem.ref.contentDigest,JSON.stringify(problem)]);
 });
 return {problem,checks,reservationCreated:false,qualification:'S5_PURE_CURRENT_SAME_DEAL_EXACT_RESOURCES_FLOAT64_RETAINED_WORLD_VALUES_NO_CLEARANCE_OR_CERTIFICATE'};
}
export async function readEnterpriseAllocationCandidateProblem(ctx:PeMutationContext,ref:ExperimentRef,
 checkedPolicies?:readonly ContingentPolicy[]):Promise<CanonicalAllocationProblem>{
 const problem=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>{
  const row=(await c.query<{body:CanonicalAllocationProblem}>('SELECT body FROM finnor_os.s5_candidate_problems WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',
   [ctx.auth.tenantId,actor(ctx),ref.contentDigest])).rows[0];
  if(!row||!sameAllocationRef(row.body.ref,ref))throw new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE','Permitted S5 proposal is unavailable');
  return row.body;
 });
 assertAllocationProblem(problem);
 if(Date.now()>=Date.parse(problem.validUntil)||(await readAllocationSnapshot(ctx)).snapshotDigest!==problem.snapshotDigest)
  throw new AllocationContractError('STALE_INPUT','Pure allocation proposal is not current');
 // Internal same-call M1 readbacks already replayed these exact S4 preimages.
 // The public owner operation never accepts this argument or a currentness flag.
 if(checkedPolicies){
  for(const policy of problem.policies)if(!checkedPolicies.some(checked=>sameAllocationRef(checked,policy)))
   throw new AllocationContractError('STALE_INPUT','Checked owner policies differ from the original pure allocation proposal');
 }else await readEnterpriseControlDecisionContexts(ctx,problem.policies.map(p=>p.ref));
 for(const r of problem.resources)for(const pin of r.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')
  throw new AllocationContractError('STALE_INPUT','Pure allocation source/rights changed');
 return problem;
}
