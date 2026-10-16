import type { AtlasProjectedChoice } from '../../../shared-types/src/decision-atlas';
import type { AtlasPointResult } from '../../../epistemic-runtime/src/policy-atlas/query';
import { atlasRef, encode, evaluate, rational } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { R7Error, type R7Family, type R7Query } from './contracts';

/** Project an original checked policy node without numeric conversion or search.
 * Continuation preserves the original whole-horizon guarantee. It does not
 * relabel that guarantee as a new conditional optimum after observation. */
export function projectR7Choice(family:R7Family,parameterRef:R7Query['parameterRef'],values:string[],point:AtlasPointResult,
  demand:AtlasProjectedChoice['exactDemand'],nodeId?:string):AtlasProjectedChoice|null {
  if(!point.label?.winnerPolicyId||point.value===null)return null;
  const policy=family.input.source.policies.find(p=>p.id===point.label!.winnerPolicyId),
    node=policy?.nodes.find(n=>n.id===(nodeId??policy.rootNodeId)),original=policy?.actions.find(a=>a.id===node?.actionId);
  if(!policy||!node||!original)throw new R7Error('CHECK_FAILED','Original executable policy node is missing');
  const q=values.map(v=>rational(v,256)),ev=(e:Parameters<typeof evaluate>[0])=>encode(evaluate(e,q)),
    {cost,tailLiability,humanSeconds,resources,occupancy,exposures,...rest}=original,
    action={...rest,cost:ev(cost),tailLiability:ev(tailLiability),humanSeconds:ev(humanSeconds),
      resources:Object.fromEntries(Object.entries(resources).map(([k,v])=>[k,ev(v)])),
      occupancy:Object.fromEntries(Object.entries(occupancy).map(([k,v])=>[k,ev(v)])),
      exposures:Object.fromEntries(Object.entries(exposures).map(([k,v])=>[k,{unit:v.unit,doses:v.doses.map(ev)}]))};
  const body:Omit<AtlasProjectedChoice,'ref'>={schema:'finnor.s4.exact-affine-choice.v1',familyRef:family.ref,originalPolicyRef:policy.ref,
    policyId:policy.id,nodeId:node.id,action,parameterRef,parameters:values,robustValue:point.value,tiedPolicyIds:point.label.tiedPolicyIds,
    worstWorldIds:point.label.policies.find(p=>p.policyId===policy.id)!.worstWorldIds,exactDemand:demand,
    history:{period:node.period,actionHistory:node.actionHistory,observations:node.observations},
    ownerChecks:{current:true,fullFamilyOptimizerInvoked:point.costs.fullFamilyEvaluations>0},executionAuthorityGranted:false,protectedReceipt:null};
  return {...body,ref:atlasRef('S4','exact-affine-choice',body)};
}
