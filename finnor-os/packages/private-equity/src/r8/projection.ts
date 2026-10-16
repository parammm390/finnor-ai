/** Current owner projection, not a replacement allocator or financial model.
 * All eight original selections are checked by the existing independent S5
 * checker. No producer matrix, learned coefficient or sampled policy is used. */
import type {CanonicalAllocationProblem,ExperimentRef} from '@finnor/shared-types';
import {assertAllocationProblem,allocationDerivedQuantity as quantity} from '../../../epistemic-runtime/src/allocation-contracts';
import {verifyCanonicalAllocation} from '../../../epistemic-runtime/src/allocation-checker';
import {hash,SPECIFICATION} from '../../../epistemic-runtime/src/solver-synthesis/contracts';

export const OWNER_PREDICATE={
 schema:'finnor.r8.owner-projection.v1',profile:SPECIFICATION.profile,
 projectOrder:'LEXICOGRAPHIC_IMMUTABLE_ORIGINAL_POLICY_ID',periods:1,worlds:1,base:'0',
 costs:'ORIGINAL_ACTION_TOTAL_IDENTICAL_UNIT_INTEGER_0_TO_7',values:'ORIGINAL_SUPPLIED_SINGLETON_TERMS_INTEGER_0_TO_7',
 remainingCapacity:'EXACTLY_7_AFTER_EXISTING_AND_ALL_CURRENT_COMMITMENTS',subsets:8,
 noLearnedFloatCoefficientClaim:true,tie:SPECIFICATION.tie,
 excluded:['MULTIPLE_WORLDS','INTERACTIONS','CHOICE_RESTRICTIONS','UNKNOWN_OBLIGATIONS','TAIL_LIABILITY',
  'ADDITIONAL_DIMENSIONS','NONINTEGER_TERMS','PROTECTED_METHOD_AUTHORITY','FIELD_CAUSAL_OR_WEALTH_VALIDITY'],
} as const;
export interface SolverProjection {
 profile:typeof SPECIFICATION.profile;problemRef:ExperimentRef;input:number[];policyRefs:ExperimentRef[];demandDigests:string[];
 predicateDigest:string;resourceRef:ExperimentRef;unit:string;utilityUnit:string;
 checks:Array<{mask:number;feasible:boolean;cost:string;value:string;checkDigest:string}>;
 digest:string;
}
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=7;
const exactInput=(value:string)=>/^(?:0|[1-7])$/.test(value)?Number(value):null;
export function projectSolverProblem(problem:CanonicalAllocationProblem):{projection:SolverProjection|null;reasons:string[]} {
 assertAllocationProblem(problem);
 const reasons:string[]=[];const reject=(reason:string)=>{reasons.push(reason);};
 const p=problem,m=p.mandate,world=p.jointModel.scenarios[0],resource=p.resources[0],dimension=m.resources.dimensions[0];
 if(p.policies.length!==3||m.horizon.periods!==1||p.jointModel.scenarios.length!==1||
  p.resources.length!==1||m.resources.dimensions.length!==1||!world||!resource||!dimension) return {projection:null,reasons:['R8_EXACT_STRUCTURAL_PROFILE_REQUIRED']};
 if(world.baseValue!=='0'||world.terms.length!==3||world.terms.some(t=>t.policyIds.length!==1)||
  p.jointModel.choiceConstraints.length||m.resources.couplings.length||m.utility.tail.terminalLiability!==0||
  m.utility.discountFactors.length!==2||m.utility.discountFactors.some(v=>v!==1)||m.risk.minimumUtility>0)reject('R8_OBJECTIVE_TIME_RISK_OR_INTERACTION_UNSUPPORTED');
 if(resource.kind!=='STOCK'&&resource.kind!=='CUMULATIVE_EXPENDITURE')reject('R8_ADDITIVE_CAPACITY_KIND_UNSUPPORTED');
 if(resource.unit!==dimension.unit||resource.horizon.periods!==1||resource.covenants.length||resource.revoked||
  resource.availability.some(a=>a.amount===null||a.basis!=='REPORTED_AVAILABLE')||
  dimension.totalLimit<7||dimension.capacity<0)reject('R8_RESOURCE_UNIT_OR_CONSTRAINT_UNSUPPORTED');
 if(p.outstanding.some(o=>!['RESERVED','SETTLED_RETAINED'].includes(o.status)||
  o.policyRefs.some(ref=>p.policies.some(policy=>policy.ref.id===ref.id))))reject('R8_CURRENT_OBLIGATION_OR_ALREADY_SELECTED_POLICY_UNSUPPORTED');
 for(let t=0;t<2;t++){
  let remaining=quantity(resource.availability[t]!.amount??'0').sub(quantity(resource.safetyMargin));
  for(let k=0;k<=t;k++)remaining=remaining.sub(quantity(resource.existingUse[k]!));
  for(const outstanding of p.outstanding)for(const envelope of outstanding.envelopes){
   if(envelope.resourceId!==resource.resourceId||envelope.unit!==resource.unit||
    envelope.kind!==resource.kind||hash(envelope.horizon)!==hash(resource.horizon)||
    envelope.quantities.length!==2||hash(envelope.quantities)!==hash(envelope.minimumQuantities))reject('R8_OUTSTANDING_ENVELOPE_UNRESOLVED');
   else for(let k=0;k<=t;k++)remaining=remaining.sub(quantity(envelope.quantities[k]!));
  }
  if(remaining.compare(quantity('7'))!==0)reject('R8_REMAINING_CAPACITY_NOT_SEVEN');
 }
 const policies=[...p.policies].sort((a,b)=>a.ref.id<b.ref.id?-1:a.ref.id>b.ref.id?1:0),costs:number[]=[],values:number[]=[];
 for(const policy of policies){
  const path=world.policyPaths.find(path=>hash(path.policyRef)===hash(policy.ref));
  const binding=p.demandBindings.filter(b=>hash(b.policyRef)===hash(policy.ref));
  const funding=p.funding.find(f=>hash(f.policyRef)===hash(policy.ref));
  const term=world.terms.find(t=>t.policyIds.length===1&&t.policyIds[0]===policy.ref.id),value=term?exactInput(term.value):null;
  if(policy.nodes.length!==1||!path||path.nodeIds.length!==1||path.nodeIds[0]!==policy.rootNodeId||
   policy.problem.obligations.length||policy.problem.continuation||policy.problem.observations.length||
   !funding||funding.actionCostResourceId!==null||funding.humanSecondsResourceId!==null||funding.terminalLiabilityResourceId!==null||
   binding.length>1||binding.length===1&&(binding[0]!.dimensionId!==dimension.id||binding[0]!.resourceId!==resource.resourceId||
   binding[0]!.component!=='TOTAL'||binding[0]!.conversion!=='IDENTICAL_UNIT_NO_CONVERSION')||value===null){reject('R8_ORIGINAL_POLICY_DEMAND_OR_EXACT_VALUE_UNSUPPORTED');continue;}
  const node=policy.nodes[0]!,action=policy.problem.actions.find(a=>a.id===node.actionId);
  if(!action||node.period!==0||node.branches.length||action.precondition||action.cost!==0||action.tailLiability!==0||
   action.humanSeconds!==0||Object.keys(action.resources).length!==1||Object.keys(action.occupancy).length!==1||
   !integer(action.resources[dimension.id])||action.occupancy[dimension.id]!==0||action.costUnit!==m.utility.unit||
   action.kind==='INQUIRE'){reject('R8_ORIGINAL_ACTION_MEANING_UNSUPPORTED');continue;}
  if(!binding.length&&action.resources[dimension.id]!==0){reject('R8_MATERIAL_ORIGINAL_DEMAND_MAPPING_ABSENT');continue;}
  costs.push(action.resources[dimension.id]!);values.push(value);
 }
 if(reasons.length||costs.length!==3)return {projection:null,reasons:[...new Set(reasons)]};
 const checks:SolverProjection['checks']=[];
 for(let mask=0;mask<8;mask++){
  const selected=policies.filter((_,i)=>Boolean(mask&(1<<i))),cost=costs.reduce((sum,v,i)=>sum+(mask&(1<<i)?v:0),0),
   value=values.reduce((sum,v,i)=>sum+(mask&(1<<i)?v:0),0),checked=verifyCanonicalAllocation(p,selected.map(policy=>policy.ref.id));
  if(checked.feasible!==(cost<=7)||checked.scenarioValues.length!==1||checked.scenarioValues[0]!.value!==String(value)||
   checked.feasible&&checked.objective!==String(value)||checked.envelopes.length!==1||
   hash(checked.envelopes[0]!.quantities)!==hash([String(cost),'0']))reject('R8_ALL_SUBSET_OWNER_EQUIVALENCE_FAILED');
  checks.push({mask,feasible:checked.feasible,cost:String(cost),value:String(value),checkDigest:hash(checked)});
 }
 if(reasons.length)return {projection:null,reasons:[...new Set(reasons)]};
 const body={profile:SPECIFICATION.profile,problemRef:p.ref,input:[...costs,...values],policyRefs:policies.map(policy=>policy.ref),
  demandDigests:policies.map(policy=>policy.demand.contentDigest),
  predicateDigest:hash(OWNER_PREDICATE),resourceRef:resource.ref,unit:resource.unit,utilityUnit:m.utility.unit,checks};
 return {projection:{...body,digest:hash(body)},reasons:[]};
}
