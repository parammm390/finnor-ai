import type {ControlQuotient,ControlQuotientReceipt,ExactControlEvaluation,ExactInformationState,ControlRational} from '@finnor/shared-types';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ControlFraction as Q,CQ_ZERO,controlCanonical as canonical,controlBytesDigest,controlMeter,ExactControlError,R1_LIMITS,type ExactControlBudget} from './certified-state-reduction/exact';
import {parseExactInformationModel,exactStateLabel,stateFeasible} from './certified-state-reduction/model';
import {exactTransitionSignature} from './certified-state-reduction/producer';

type Answer={actionId:string|null;worldValues:Record<string,ControlRational>;children:Record<string,number>};
/** S4's supplied exact-table continuation path. R1 changes only its reuse key.
 * Complete vectors/families are retained, including dominated vectors: those
 * can still belong to globally tied robust root policies. */
export function evaluateExactContingentControl(bytes:string,budget:ExactControlBudget & {reuse:{candidate:ControlQuotient;receipt:ControlQuotientReceipt}|null}):ExactControlEvaluation {
 budget={...budget,account:budget.account??{steps:0}};
 const meter=controlMeter(budget),digest=controlBytesDigest(bytes);
 const out:ExactControlEvaluation={schema:'finnor.s4.exact-continuation.v2',status:'INCOMPLETE',modelDigest:digest,values:{},optimalActions:{},selectedActions:{},selectedWorldValues:{},family:{},selectedFamily:{},root:'',stats:{steps:0,continuationEvaluations:0,reuseHits:0,classesEvaluated:0,policyAlternatives:0},reasons:[],arithmetic:'EXACT_BOUNDED_BIGINT_RATIONAL',completeSearch:false,incumbent:null};
 try{
  const m=parseExactInformationModel(bytes,budget),states=new Map(m.states.map(s=>[s.id,s]));out.root=m.roots[0]!;
  if(m.roots.length!==1)throw new ExactControlError('UNSUPPORTED','MULTIPLE_INITIAL_INFORMATION_SETS_REQUIRE_OWNER_SELECTION');
  if(m.uncertainty.kind!=='FIXED_COMPLETE_WORLDS')throw new ExactControlError('UNSUPPORTED','CURRENT_QUALIFIED_S3_PROBABILITY_LAW_REQUIRED');
  if(m.states.some(s=>s.semantics.obligations.some(o=>o.status==='UNKNOWN'||o.status==='PARTIAL')||Object.values(s.semantics.terminalLiabilities).some(q=>q===null)))throw new ExactControlError('UNKNOWN','S6_UNKNOWN_OR_PARTIAL_LIABILITY_RETAINED');
  const stopActions:Record<string,string>={};
  // A full-horizon STOP is checked under this original meter before optional
  // reuse. Stopping still advances retained schedules, constraints and debt.
  function stopped(s:ExactInformationState):Record<string,Q>|null{
   meter.step();if(!stateFeasible(m,s))return null;
   if(s.period===m.horizon.periods)return Object.fromEntries(Object.entries(s.semantics.accruedUtility).map(([w,v])=>[w,Q.read(v)]));
   const edge=s.transitions.find(t=>m.actions.find(a=>a.id===t.actionId)?.kind==='STOP');if(!edge)return null;
   stopActions[s.id]=edge.actionId;const children=new Map<string,Record<string,Q>>();
   for(const o of edge.outcomes){meter.step();if(!children.has(o.successor)){const v=stopped(states.get(o.successor)!);if(!v)return null;children.set(o.successor,v);}}
   const v:Record<string,Q>=Object.fromEntries(s.worlds.map(w=>[w,CQ_ZERO]));for(const o of edge.outcomes)v[o.worldId]=v[o.worldId]!.add(Q.read(o.mass).mul(children.get(o.successor)![o.worldId]!));return v;
  }
  const stopValues=stopped(states.get(out.root)!);if(stopValues&&Object.values(stopValues).every(q=>q.compare(Q.read(m.economics.minimumUtility))>=0))out.incumbent={kind:'FULL_HORIZON_STOP',worldValues:Object.fromEntries(Object.entries(stopValues).map(([w,v])=>[w,v.wire()])),actions:stopActions,checked:true};
  const mapping:Record<string,string>=budget.reuse?budget.reuse.candidate.stateToBlock:Object.fromEntries(m.states.map(s=>[s.id,s.id]));
  if(budget.reuse){
   const {candidate:c,receipt:r}=budget.reuse,checkerDigest=controlBytesDigest(readFileSync(fileURLToPath(new URL('./certified-state-reduction/checker.py',import.meta.url))));
   if(r.status!=='COMPLETE'||!r.relationComplete||r.modelDigest!==digest||c.modelDigest!==digest||r.candidateDigest!==controlBytesDigest(JSON.stringify(c))||r.checkerDigest!==checkerDigest||r.checkerVersion!=='r1-python-fraction-v1'||r.executionAuthorityGranted!==false||r.profile!==m.profile||c.producerVersion!=='r1-native-refinement-v1')throw new ExactControlError('UNSUPPORTED','CURRENT_INDEPENDENT_ACCEPTANCE_REQUIRED');
   const members=c.blocks.flatMap(b=>b.members);if(members.length!==m.states.length||new Set(members).size!==members.length||m.states.some(s=>!members.includes(s.id))||Object.keys(mapping).length!==m.states.length)throw new ExactControlError('UNSUPPORTED','CONSUMER_RELATION_COVERAGE');
   // Defense at consumption, in addition to the independent checker.
   for(const b of c.blocks){const label=canonical(b.label),edges=canonical(b.transitions);for(const member of b.members){meter.step();const s=states.get(member);if(!s||mapping[member]!==b.id||label!==canonical(exactStateLabel(m,s))||edges!==canonical(exactTransitionSignature(s,mapping)))throw new ExactControlError('UNSUPPORTED','CONSUMER_ACCEPTED_RELATION_CHANGED');}}
  }
  const memo=new Map<string,Answer[]>(),answers=new Map<string,Answer[]>(),counter={alternatives:0};
  const childStates=(s:ExactInformationState,action:string)=>[...new Set(s.transitions.find(t=>t.actionId===action)!.outcomes.map(o=>o.successor))].map(id=>states.get(id)!).sort((a,b)=>{const ka=canonical([a.observations,a.worlds]),kb=canonical([b.observations,b.worlds]);return ka<kb?-1:ka>kb?1:0;});
  function solve(s:ExactInformationState):Answer[]{
   meter.step();const block=mapping[s.id]!;
   if(budget.reuse&&memo.has(block)){out.stats.reuseHits++;const result=memo.get(block)!;answers.set(s.id,result);return result;}
   out.stats.continuationEvaluations++;const family:Answer[]=[];
   if(stateFeasible(m,s)){
    if(s.period===m.horizon.periods){if(Object.values(s.semantics.accruedUtility).every(v=>Q.read(v).compare(Q.read(m.economics.minimumUtility))>=0))family.push({actionId:null,worldValues:Object.fromEntries(Object.entries(s.semantics.accruedUtility).map(([w,v])=>[w,Q.read(v).wire()])),children:{}});}
    else for(const transition of s.transitions){
     const children=childStates(s,transition.actionId),families=children.map(solve);
     function combine(index:number,selection:number[]){
      meter.step();
      if(index<families.length){for(let choice=0;choice<families[index]!.length;choice++)combine(index+1,[...selection,choice]);return;}
      const values:Record<string,Q>=Object.fromEntries(s.worlds.map(w=>[w,CQ_ZERO]));
      for(const edge of transition.outcomes){meter.step();const childIndex=children.findIndex(c=>c.id===edge.successor),answer=families[childIndex]![selection[childIndex]!]!;values[edge.worldId]=values[edge.worldId]!.add(Q.read(edge.mass).mul(Q.readDerived(answer.worldValues[edge.worldId])));}
      if(Object.values(values).some(v=>v.compare(Q.read(m.economics.minimumUtility))<0))return;
      if(++counter.alternatives>R1_LIMITS.policyNodes)throw new ExactControlError('INCOMPLETE','EXACT_CONTINUATION_FAMILY_BOUND');
      family.push({actionId:transition.actionId,worldValues:Object.fromEntries(Object.entries(values).map(([w,v])=>[w,v.wire()])),children:Object.fromEntries(selection.map((choice,i)=>['slot:'+i,choice]))});
     }
     combine(0,[]);
    }
   }
   if(budget.reuse)memo.set(block,family);answers.set(s.id,family);return family;
  }
  const score=(a:Answer):Q=>Object.values(a.worldValues).map(Q.readDerived).reduce((a,b)=>a.compare(b)<0?a:b);
  const family=solve(states.get(out.root)!);
  if(!family.length){out.status='INFEASIBLE';out.completeSearch=true;out.reasons=['COMPLETE_SUPPLIED_POLICY_FAMILY_INFEASIBLE'];return out;}
  const maximum=family.map(score).reduce((a,b)=>a.compare(b)>0?a:b),winners=family.map((a,i)=>score(a).compare(maximum)===0?i:-1).filter(i=>i>=0);
  const visited=new Set<string>();
  function lift(s:ExactInformationState,choice:number,selected:boolean){
   meter.step();const family=answers.get(s.id)??solve(s),answer=family[choice]!;if(!answer)throw new ExactControlError('UNKNOWN','ORIGINAL_POLICY_LIFT_MISSING');
   const visit=s.id+':'+choice+':'+selected;if(visited.has(visit))return;visited.add(visit);
   out.family[s.id]=family.map(a=>({actionId:a.actionId,worldValues:a.worldValues,children:a.children}));
   const best=family.length?family.map(score).reduce((a,b)=>a.compare(b)>0?a:b):null;out.values[s.id]=best?.wire()??null;
   if(answer.actionId===null)return;
   const actions=out.optimalActions[s.id]??[];if(!actions.includes(answer.actionId))actions.push(answer.actionId);out.optimalActions[s.id]=m.actions.filter(a=>actions.includes(a.id)).map(a=>a.id);
   if(selected){out.selectedActions[s.id]=answer.actionId;out.selectedFamily[s.id]=choice;}
   const children=childStates(s,answer.actionId);for(let i=0;i<children.length;i++)lift(children[i]!,answer.children['slot:'+i]!,selected);
  }
  for(const winner of winners)lift(states.get(out.root)!,winner,winner===winners[0]);
  out.values[out.root]=maximum.wire();out.selectedWorldValues=family[winners[0]!]!.worldValues;out.status='COMPLETE';out.completeSearch=true;
  out.stats.classesEvaluated=memo.size;out.stats.policyAlternatives=counter.alternatives;
 }catch(error){
  if(error instanceof ExactControlError){out.status=error.disposition;out.reasons=[error.predicate];}
  else {out.status='UNKNOWN';out.reasons=['EXACT_OWNER_CONTRACT_OR_PROCESS_FAILURE'];}
 }finally{out.stats.steps=meter.steps;}
 return out;
}
