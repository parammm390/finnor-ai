import type {ControlQuotient,ExactInformationModel,ExactInformationState} from '@finnor/shared-types';
import {parseExactInformationModel,exactStateLabel} from './model';
import {ControlFraction as Q,CQ_ZERO,controlCanonical as canonical,controlBytesDigest,controlMeter,type ExactControlBudget} from './exact';
/** Include original world, observation, reward and resource labels before
 * aggregating probability mass into a class. Fixed worlds never re-sample. */
export function exactTransitionSignature(s:ExactInformationState,map:Record<string,string>):unknown{
 return s.transitions.map(t=>{
  const grouped=new Map<string,{label:unknown;mass:Q}>();
  for(const o of t.outcomes){const {successor,mass,...rest}=o,label={...rest,successorBlock:map[successor]},key=canonical(label),prior=grouped.get(key);grouped.set(key,{label,mass:(prior?.mass??CQ_ZERO).add(Q.read(mass))});}
  return {actionId:t.actionId,outcomes:[...grouped.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>({label:JSON.parse(canonical(v.label)),mass:v.mass.wire()}))};
 });
}
function partition(model:ExactInformationModel,signatures:Map<string,string>):Array<{id:string;members:string[]}>{
 const groups=new Map<string,string[]>();for(const s of model.states){const key=signatures.get(s.id)!,members=groups.get(key)??[];members.push(s.id);groups.set(key,members);}
 return [...groups.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,members],i)=>({id:'block:'+i,members:members.sort()}));
}
export function proposeControlQuotient(bytes:string,budget:ExactControlBudget):ControlQuotient {
 budget={...budget,account:budget.account??{steps:0}};
 const model=parseExactInformationModel(bytes,budget),meter=controlMeter(budget);
 const labels=new Map(model.states.map(s=>[s.id,canonical(exactStateLabel(model,s))]));
 let blocks=partition(model,labels),iterations=0,map:Record<string,string>={};
 for(;;){meter.step(model.states.length);map=Object.fromEntries(blocks.flatMap(b=>b.members.map(id=>[id,b.id])));
  const signatures=new Map(model.states.map(s=>{meter.step(s.transitions.reduce((n,t)=>n+t.outcomes.length,1));return [s.id,canonical({label:JSON.parse(labels.get(s.id)!),transitions:exactTransitionSignature(s,map)})];}));
  const next=partition(model,signatures);iterations++;
  const relation=(v:typeof blocks)=>canonical(v.map(b=>b.members).sort((a,b)=>a[0]!<b[0]!?-1:1));
  if(relation(next)===relation(blocks)){blocks=next;break;}blocks=next;
 }
 map=Object.fromEntries(blocks.flatMap(b=>b.members.map(id=>[id,b.id])));
 return {schema:'finnor.control-quotient.v1',producerVersion:'r1-native-refinement-v1',modelDigest:controlBytesDigest(bytes),profile:model.profile,
  blocks:blocks.map(b=>{const original=model.states.find(s=>s.id===b.members[0])!;return {...b,label:JSON.parse(labels.get(original.id)!),transitions:JSON.parse(canonical(exactTransitionSignature(original,map)))};}),
  stateToBlock:map,roots:model.roots.map(id=>map[id]!),
  lift:model.states.map(s=>({stateId:s.id,blockId:map[s.id]!,period:s.period,history:s.history,observations:s.observations})),
  witness:{kind:'COMPLETE_LABELLED_INFORMATION_BISIMULATION',iterations,checkedStates:model.states.length,qualification:'SUPPLIED_MODEL_RELATIVE_NO_AUTHORITY'}};
}
