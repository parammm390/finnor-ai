import { restoreInterventionControlAdapter } from '../../../epistemic-runtime/src/intervention-control';
import { controlObservationToken } from '../../../epistemic-runtime/src/control-observations';
import type { PolicyBinding } from '../decision-slice/contracts';
import { hash } from './contracts';
import { checkBudget } from './budget';

/** Model rehearsal only. Controller decisions see histories, never the joint world's ID. */
export function replayOriginalWorld(binding:PolicyBinding,worldId:string){
  const {policy,model,kernel}=binding;
  if(policy.nodes.length>2048||policy.problem.continuation||policy.problem.obligations.length||
    policy.problem.actions.some(a=>a.kind==='INQUIRE'))return {status:'UNRESOLVED' as const,reason:'CONTINUATION_INQUIRY_OR_LIABILITY_REFERENCE_UNSUPPORTED'};
  const dynamics=restoreInterventionControlAdapter(model,kernel),initial=dynamics.initialWorlds.find(w=>w.id===worldId);
  if(!initial)return {status:'UNRESOLVED' as const,reason:'ORIGINAL_JOINT_WORLD_UNAVAILABLE'};
  const h=policy.mandate.horizon.periods,schedule=structuredClone(policy.problem.baselineExposures);
  let world=structuredClone(initial),value=0,liability=policy.mandate.utility.tail.terminalLiability;
  const observations:Array<{instrumentId:string;token:string;availablePeriod:number}>=[],pending:typeof observations=[],
    history:string[]=[],trace:unknown[]=[],spent:Record<string,number>={},occupied:Record<string,number[]>={};
  for(const d of policy.mandate.resources.dimensions){spent[d.id]=0;occupied[d.id]=Array(h).fill(0);}
  let human=0,stopped=false;
  for(let t=0;t<h;t++){
    checkBudget();
    observations.push(...pending.filter(o=>o.availablePeriod===t));
    const nodes=policy.nodes.filter(n=>n.period===t&&hash(n.actionHistory)===hash(history)&&hash(n.observations)===hash(observations));
    if(nodes.length!==1)return {status:'UNRESOLVED' as const,reason:'LAWFUL_OBSERVABLE_BRANCH_UNAVAILABLE'};
    const node=nodes[0]!,action=policy.problem.actions.find(a=>a.id===node.actionId);
    if(!action||node.observations.some(o=>o.availablePeriod>t)||action.atMostOnce&&history.includes(action.id)||
      t<action.earliestPeriod||t>action.lastPeriod||stopped&&action.kind!=='STOP')
      return {status:'UNRESOLVED' as const,reason:'ORIGINAL_CONTROLLER_INFORMATION_OR_TIMING_INVALID'};
    if(action.kind==='STOP')stopped=true;
    for(const [id,doses]of Object.entries(action.exposures))for(let offset=0;offset<doses.length;offset++){
      if(t+offset>=h)return {status:'UNRESOLVED' as const,reason:'EXPOSURE_HORIZON'};
      schedule[id]![t+offset]=doses[offset]!;
    }
    for(const d of policy.mandate.resources.dimensions){
      spent[d.id]!+=action.resources[d.id]!;
      for(let k=t;k<Math.min(h,t+action.occupationPeriods);k++)occupied[d.id]![k]!+=action.occupancy[d.id]!;
    }
    human+=action.humanSeconds;
    const exposures=Object.fromEntries(dynamics.exposureIds.map(id=>[id,schedule[id]![t]!]));
    world=dynamics.advance(world,exposures,t);
    if(!world.supported)return {status:'UNRESOLVED' as const,reason:'OUTSIDE_ORIGINAL_S3_SUPPORT'};
    const states=world.history.at(-1)!.states;
    value+=policy.mandate.utility.discountFactors[t]!*(policy.mandate.utility.periodTerms.reduce(
      (v,term)=>v+term.coefficient*states[term.variableId]!,0)-action.cost);
    liability+=action.tailLiability;
    for(const instrument of policy.problem.observations.filter(i=>i.afterActionIds.includes(action.id))){
      const token=controlObservationToken(instrument,world);
      if(token===null)return {status:'UNRESOLVED' as const,reason:'OBSERVATION_SUPPORT_UNAVAILABLE'};
      pending.push({instrumentId:instrument.id,token,availablePeriod:t+instrument.delayPeriods});
    }
    trace.push({period:t,nodeId:node.id,actionId:action.id,observations:structuredClone(observations),states,exposures});
    history.push(action.id);
  }
  const states=world.history.at(-1)!.states;
  value+=policy.mandate.utility.discountFactors[h]!*(policy.mandate.utility.terminalTerms.reduce(
    (v,term)=>v+term.coefficient*states[term.variableId]!,0)-liability);
  if(!Number.isFinite(value))return {status:'UNRESOLVED' as const,reason:'NONFINITE_ORIGINAL_WORLD_RESULT'};
  const resourceReasons=policy.mandate.resources.dimensions.flatMap(d=>spent[d.id]!>d.totalLimit||
    occupied[d.id]!.some(v=>v>d.capacity)?['MANDATE_RESOURCE:'+d.id]:[]);
  if(human>policy.mandate.search.maxHumanSeconds)resourceReasons.push('MANDATE_HUMAN');
  for(const c of policy.mandate.resources.couplings)if(Array.from({length:h},(_,t)=>Object.entries(c.weights).reduce(
    (v,[id,w])=>v+w*occupied[id]![t]!,0)).some(v=>v>c.maxPerPeriod))resourceReasons.push('MANDATE_COUPLING:'+c.id);
  return {status:'CHECKED' as const,value,trace,resourceReasons};
}
