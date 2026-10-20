import {PROFILE,PROFILE_DIGEST,canonical,digest,EconomicFault,type EconomicProblem,type EconomicOperator,type EconomicTheoryBody,
 type Term,type SemanticRow,type State,type ConstructionResult} from './contracts';
import {Meter,dimension,applyOperator,validateProblem,semanticFootprint,wordDenotation,rowValue,exact} from './finite';

function combinations<T>(items:T[],length:number):T[][] {
 if(!length)return [[]];
 const result:T[][]=[];
 for(let i=0;i<=items.length-length;i++)for(const tail of combinations(items.slice(i+1),length-1))result.push([items[i]!,...tail]);
 return result;
}
function signVectors(length:number):Array<Array<-1|1>>{
 return length?signVectors(length-1).flatMap(v=>[[-1,...v] as Array<-1|1>,[1,...v] as Array<-1|1>]):[[]];
}
function rowAlternatives(problem:EconomicProblem,op:EconomicProblem['operators'][number],target:EconomicProblem['quantities'][number],meter:Meter){
 const tokens:Array<Omit<Term,'coefficient'>>=[
  ...problem.quantities.filter(q=>dimension(q)===dimension(target)).map(q=>({input:'STATE' as const,id:q.id})),
  ...problem.parameters.filter(p=>dimension(p)===dimension(target)).map(p=>({input:'PARAM' as const,id:p.id})),
  {input:'ONE',id:'one'}];
 const alternatives:Term[][]=[];
 for(let n=0;n<=PROFILE.maxTermsPerRow;n++)for(const selection of combinations(tokens,n))for(const signs of signVectors(n)){
  meter.tick('SEARCH');
  const terms=selection.map((token,i)=>({...token,coefficient:signs[i]!})),row={output:target.id,terms};
  if(op.examples.filter(e=>e.after!==null).every(e=>rowValue(row,e.before,e.parameters)===exact(e.after![target.id]!)))alternatives.push(terms);
 }
 return alternatives.sort((a,b)=>a.length-b.length||canonical(a).localeCompare(canonical(b),'en'));
}
interface Choice {cost:number;indices:number[]}
function compareChoices(a:Choice,b:Choice){return a.cost-b.cost||a.indices.reduce((prior,n,i)=>prior||n-b.indices[i]!,0);}
function solveOperator(problem:EconomicProblem,op:EconomicProblem['operators'][number],states:State[],parameters:State[],meter:Meter):
 {status:'CANDIDATE';operator:EconomicOperator}|{status:'INFEASIBLE'}|{status:'UNIDENTIFIED';trace:NonNullable<ConstructionResult['distinguishingTrace']>} {
 const alternatives=problem.quantities.map(q=>rowAlternatives(problem,op,q,meter));
 if(alternatives.some(rows=>!rows.length))return {status:'INFEASIBLE'};
 const cost=(indices:number[])=>indices.reduce((sum,n,i)=>sum+alternatives[i]![n]!.length,0);
 const initial=problem.quantities.map(()=>0),queue:Choice[]=[{indices:initial,cost:cost(initial)}],seen=new Set([initial.join(',')]);
 let best:number|null=null,count=0;
 const meanings=new Map<string,{operator:EconomicOperator;trace:Array<State|null>}>();
 while(queue.length){
  queue.sort(compareChoices);const choice=queue.shift()!;
  if(best!==null&&choice.cost>best)break;
  meter.tick('BODY');if(++count>PROFILE.maxBodyCombinations)throw new EconomicFault('Y1_FROZEN_BODY_COMBINATION_BOUND');
  const rows:SemanticRow[]=problem.quantities.map((q,i)=>({output:q.id,terms:alternatives[i]![choice.indices[i]!]!}));
  const operator:EconomicOperator={id:op.id,rows,guard:{kind:'MAXIMAL_FINITE_SAFE_PREIMAGE',invariantDigest:digest(problem.invariants)},
   requirements:op.requirements,...semanticFootprint(rows)};
  if(op.examples.every(e=>canonical(applyOperator(problem,operator,e.before,e.parameters,meter))===canonical(e.after))){
   const trace=states.flatMap(s=>parameters.map(p=>applyOperator(problem,operator,s,p,meter)));
   if(trace.some(x=>x!==null)){best=choice.cost;if(!meanings.has(digest(trace)))meanings.set(digest(trace),{operator,trace});}
  }
  for(let i=0;i<choice.indices.length;i++){
   const indices=choice.indices.map((n,j)=>n+(i===j?1:0)),key=indices.join(',');
   if(indices[i]!<alternatives[i]!.length&&!seen.has(key)){seen.add(key);queue.push({indices,cost:cost(indices)});}
  }
 }
 if(!meanings.size)return {status:'INFEASIBLE'};
 if(meanings.size>1){
  const found=[...meanings.values()],index=found[0]!.trace.findIndex((v,i)=>found.some(f=>canonical(f.trace[i])!==canonical(v)));
  return {status:'UNIDENTIFIED',trace:{operatorId:op.id,before:states[Math.floor(index/parameters.length)]!,
   parameters:parameters[index%parameters.length]!,alternatives:found.slice(0,4).map(f=>f.trace[index]!)}};
 }
 return {status:'CANDIDATE',operator:[...meanings.values()][0]!.operator};
}
/** No operator label, supplied transition body, procedure capsule or named proof
 * template participates in this search. Examples constrain an explicit space. */
export function construct(problem:EconomicProblem,deadline?:number):ConstructionResult {
 const meter=new Meter(deadline),result=(status:ConstructionResult['status'],candidate:EconomicTheoryBody|null,reasons:string[],
  extra:Partial<ConstructionResult>={}):ConstructionResult=>({status,candidate,reasons,searchSteps:meter.searchSteps,
   semanticApplications:meter.semanticApplications,bodyCombinations:meter.bodyCombinations,
   exhaustiveWithinFrozenHypothesis:false,...extra});
 try{
  const {states,parameters}=validateProblem(problem),needed=new Set([
   ...problem.quantities.concat(problem.parameters).map(q=>q.meaningKey),...problem.invariants.map(i=>i.meaningKey),
   ...problem.operators.flatMap(o=>o.requirements.filter(r=>r.kind!=='AUTHORITY').map(r=>r.key))]);
  const missing=[...needed].filter(key=>{const m=problem.meanings.find(m=>m.key===key);return !m?.sourceId||!m.versionId||!m.contentDigest;});
  if(missing.length)return result('UNIDENTIFIED',null,missing.map(key=>'MISSING_MEANING:'+key));
  if(problem.operators.some(o=>!o.requirements.some(r=>r.kind==='OBSERVATION')))return result('UNIDENTIFIED',null,['MISSING_CANONICAL_OPERATOR_OBSERVATION_REQUIREMENT']);
  const operators:EconomicOperator[]=[];
  for(const op of problem.operators){
   const solved=solveOperator(problem,op,states,parameters,meter);
   if(solved.status==='INFEASIBLE')return result('CANDIDATE',null,['FINITE_HYPOTHESIS_EXHAUSTED_REQUIRES_INDEPENDENT_CHECK'],{exhaustiveWithinFrozenHypothesis:true});
   if(solved.status==='UNIDENTIFIED')return result('UNIDENTIFIED',null,['DISTINCT_MINIMUM_COST_SEMANTIC_DENOTATIONS'],{distinguishingTrace:solved.trace,exhaustiveWithinFrozenHypothesis:true});
   operators.push(solved.operator);
  }
  const words:string[][]=[[],...operators.map(o=>[o.id]),...operators.flatMap(a=>operators.map(b=>[a.id,b.id]))],
   groups=new Map<string,Array<{word:string[];denotation:ReturnType<typeof wordDenotation>}>>();
  for(const word of words){
   const denotation=wordDenotation(problem,operators,word,states,parameters,meter);
   if(denotation.enabledWitnesses<PROFILE.minimumLawEnabledWitnesses)continue;
   const group=groups.get(denotation.denotationDigest)??[];group.push({word,denotation});groups.set(denotation.denotationDigest,group);
  }
  const laws:EconomicTheoryBody['laws']=[];
  for(const group of groups.values())for(let i=1;i<group.length;i++){
   if(laws.length>=PROFILE.maxLaws)throw new EconomicFault('Y1_FROZEN_LAW_BOUND');
   const a=group[0]!,b=group[i]!;laws.push({left:a.word,right:b.word,denotationDigest:a.denotation.denotationDigest,
    enabledWitnesses:a.denotation.enabledWitnesses,witness:a.denotation.witness!});
  }
  return result('CANDIDATE',{schema:'finnor.economic-action-theory-body.v1',problemDigest:digest(problem),
   profileDigest:PROFILE_DIGEST,operators,laws},[],{exhaustiveWithinFrozenHypothesis:true});
 }catch(error){
  if(error instanceof EconomicFault)return result(/FROZEN_/.test(error.code)?'INCOMPLETE':'UNSUPPORTED',null,[error.code]);
  throw error;
 }
}
