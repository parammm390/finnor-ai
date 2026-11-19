import type {ControlDynamicsAdapter,ControlProblem,ControlWorld} from '../../../shared-types/src/contingent-control';
import type {StrategicResponseProblem,StrategicFittedSet,StrategicForecastRequest,StrategicChoice} from '../../../shared-types/src/strategic-response';
import {assertForecast,PROFILE,digest,reference,same,fail} from './contracts';
import {jointStep} from './learner';
export interface StrategicActionRule {actionId:string;ruleIds:string[]}
export function assertStrategicControlDomain(p:StrategicResponseProblem,q:StrategicForecastRequest,control:ControlProblem,bindings:StrategicActionRule[]){
 assertForecast(p,q);
 if(control.schema!=='finnor.control-problem.v1'||control.continuation||control.observations.length||
  control.actions.some(a=>a.kind==='INQUIRE'||a.precondition?.observations.length))fail('Y2_S4_INFORMATION_PROFILE_UNSUPPORTED');
 const interventions=control.actions.filter(a=>a.kind==='INTERVENE');
 if(new Set(bindings.map(b=>b.actionId)).size!==bindings.length||bindings.length!==interventions.length)fail('Y2_COMPLETE_PUBLIC_POLICY_BINDINGS_REQUIRED');
 const matches=(ids:string[],exposures:Record<string,number[]>)=>
  same(Object.keys(exposures).sort(),['incentive','interaction'])&&ids.length===exposures.incentive?.length&&
  ids.every((id,t)=>{const rule=p.rules.find(r=>r.id===id);return rule&&rule.incentive===exposures.incentive![t]&&rule.interaction===exposures.interaction![t];});
 if(!matches(q.ruleIds,control.baselineExposures))fail('Y2_BASELINE_RULE_MEANING_DIFFERS');
 for(const action of interventions){
  const b=bindings.find(b=>b.actionId===action.id);
  if(!b||!b.ruleIds.length||!matches(b.ruleIds,action.exposures))fail('Y2_CANDIDATE_PUBLIC_RULE_MEANING_DIFFERS');
 }
 // Pending strategic schedules require the original public rule identity, not
 // inferred meaning from two numerical doses. Do not drop their obligations.
 if(control.obligations.some(o=>o.status!=='SETTLED'||o.terminalLiability===null))fail('Y2_PENDING_STRATEGIC_RULE_IDENTITY_REQUIRES_S6_RECONCILIATION');
}
export function ruleForActionHistory(q:StrategicForecastRequest,control:ControlProblem,bindings:StrategicActionRule[],history:string[],period:number):string{
 let id=q.ruleIds[period]!;
 history.forEach((actionId,t)=>{
  const b=bindings.find(b=>b.actionId===actionId);
  if(b&&period>=t&&period-t<b.ruleIds.length)id=b.ruleIds[period-t]!;
 });
 if(history.some(id=>!control.actions.some(a=>a.id===id)))fail('Y2_ACTUAL_POLICY_ACTION_UNBOUND');
 return id;
}
/** S3 strategic family lowers to the existing S4 evaluator. Only public
 * participation and gross payoff enter world history. Private paths and
 * preference alternatives remain inside the joint kernel closure. */
export function createStrategicControlAdapter(p:StrategicResponseProblem,model:StrategicFittedSet,q:StrategicForecastRequest,
 control:ControlProblem,bindings:StrategicActionRule[]):ControlDynamicsAdapter {
 assertStrategicControlDomain(p,q,control,bindings);
 if(model.status!=='FITTED'||model.problemDigest!==digest(p)||!model.hypotheses.length)fail('Y2_SUPPORTED_FITTED_MODEL_REQUIRED');
 const entries=model.hypotheses.flatMap(m=>q.jointPrivatePaths.flatMap(privatePath=>q.sharedSignalPaths.map(signal=>({
  id:digest({hypothesisId:m.id,privatePathId:privatePath.id,signalPathId:signal.id}),m,privatePath,signal}))));
 if(entries.length>PROFILE.maximumWorlds)fail('Y2_COMPLETE_JOINT_WORLD_BOUND');
 const worlds=new Map(entries.map(e=>[e.id,e])),units=Object.fromEntries(p.actors.map(a=>['actor_'+a.id,'participation']));
 units.joint_payoff=p.payoff.unit;
 const publicStates=(choices:Record<string,StrategicChoice>)=>({...Object.fromEntries(p.actors.map(a=>['actor_'+a.id,choices[a.id]!])),
  joint_payoff:p.actors.every(a=>choices[a.id]===1)?Number(p.payoff.jointPayoff):0});
 const ref=reference('S3','strategic-control-kernel',{modelDigest:digest(model),query:q,controlDigest:digest(control),actionRules:bindings});
 return {ref,stateUnits:units,stateRoots:Object.fromEntries(Object.keys(units).map(id=>[id,p.payoff.entityRoot])),
  stateRanges:{...Object.fromEntries(p.actors.map(a=>['actor_'+a.id,[0,1] as [number,number]])),joint_payoff:[0,Number(p.payoff.jointPayoff)]},
  exposureIds:['incentive','interaction'],qualification:'S3_STRATEGIC_RESPONSE_FINITE_IDENTIFIED_SET_UNADMITTED',
  initialWorlds:entries.map(e=>({id:e.id,mechanismId:e.m.id,history:[{states:publicStates(q.initial),exposures:{incentive:0,interaction:0}}],supported:true})),
  advance(world,exposures,period,context):ControlWorld {
   const e=worlds.get(world.id);
   if(!e||!context||context.problemId!==control.id||context.actionHistory.length!==period)fail('Y2_ACTUAL_POLICY_CONTEXT_REQUIRED');
   const history=[...context.actionHistory,context.actionId],ruleId=ruleForActionHistory(q,control,bindings,history,period),
    rule=p.rules.find(r=>r.id===ruleId);
   if(!rule||!same(exposures,{incentive:rule.incentive,interaction:rule.interaction}))fail('Y2_ACTUAL_POLICY_RULE_BINDING_CHANGED');
   const previous=Object.fromEntries(p.actors.map(a=>[a.id,world.history.at(-1)!.states['actor_'+a.id]!])) as Record<string,StrategicChoice>,
    outside=Object.fromEntries(p.actors.map(a=>[a.id,e.privatePath.outsideOptions[a.id]![period]!])),
    choices=jointStep(p,e.m,previous,rule,outside,e.signal.values[period]!);
   return {id:world.id,mechanismId:world.mechanismId,history:[...world.history,{states:publicStates(choices),exposures:{...exposures}}],supported:world.supported};
  },
  limitations:['Learned finite actor-local structural model SET, no probability weights or equilibrium uniqueness claim',
   'Private types remain in the kernel closure; actors see only own types and permitted public lagged information',
   'Canonical declared identification and rule-transport assumptions are not established field identification',
   'Joint private and shared regime paths remain complete, coupled and fixed across the horizon',
   'Safe integer canonical ResourceQuantity bridge, no rounding; omitted model and empirical calibration gaps UNKNOWN'],
  computeRefs:['strategic-fit:'+digest(model)]};
}
