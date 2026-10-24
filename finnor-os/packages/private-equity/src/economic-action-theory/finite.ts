import {createHash} from 'node:crypto';
import {PROFILE,canonical,digest,fail,type EconomicProblem,type EconomicOperator,type SemanticRow,type State,type Quantity,type CompositionLaw} from './contracts';
const SCALE=1000000n;
export function exact(value:string):bigint {
 const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');
 return (BigInt(whole!)*SCALE+BigInt(fraction.padEnd(6,'0')))*(negative?-1n:1n);
}
export function decimal(value:bigint):string {
 const negative=value<0n,n=negative?-value:value,fraction=(n%SCALE).toString().padStart(6,'0').replace(/0+$/,'');
 return (negative?'-':'')+(n/SCALE).toString()+(fraction?'.'+fraction:'');
}
export function dimension(q:Quantity){return canonical([q.unit,q.currency,q.accountingBasis,q.period]);}
export function product(items:Quantity[],limit:number):State[] {
 let rows:State[]=[{}];
 for(const item of items){
  if(rows.length*item.values.length>limit)fail('Y1_CARTESIAN_DOMAIN_UNSUPPORTED');
  rows=rows.flatMap(row=>item.values.map(value=>({...row,[item.id]:value})));
 }
 return rows;
}
export class Meter {
 searchSteps=0;semanticApplications=0;bodyCombinations=0;readonly started=performance.now();
 constructor(readonly deadline=performance.now()+PROFILE.maxCheckerWallMs){}
 tick(kind:'SEARCH'|'APPLY'|'BODY'){
  if(kind==='SEARCH')this.searchSteps++;
  if(kind==='APPLY')this.semanticApplications++;
  if(kind==='BODY')this.bodyCombinations++;
  if(this.searchSteps>PROFILE.maxSearchSteps||this.semanticApplications>PROFILE.maxSemanticApplications||
   performance.now()>this.deadline)fail('Y1_FROZEN_CONSTRUCTION_BOUND');
 }
}
export function inDomain(state:State,items:Quantity[]){
 return Object.keys(state).length===items.length&&items.every(q=>q.values.includes(state[q.id]!));
}
export function safe(problem:EconomicProblem,state:State):boolean {
 if(!inDomain(state,problem.quantities))return false;
 return problem.invariants.every(invariant=>{
  const value=invariant.terms.reduce((sum,t)=>sum+BigInt(t.coefficient)*exact(state[t.quantityId]!),0n),limit=exact(invariant.constant);
  return invariant.relation==='EQ'?value===limit:value<=limit;
 });
}
export function rowValue(row:SemanticRow,state:State,args:State):bigint {
 return row.terms.reduce((sum,t)=>sum+BigInt(t.coefficient)*(t.input==='ONE'?SCALE:exact((t.input==='STATE'?state:args)[t.id]!)),0n);
}
export function applyOperator(problem:EconomicProblem,operator:Pick<EconomicOperator,'rows'>,state:State,args:State,meter?:Meter):State|null {
 meter?.tick('APPLY');
 if(!safe(problem,state)||!inDomain(args,problem.parameters))return null;
 const result=Object.fromEntries(operator.rows.map(row=>[row.output,decimal(rowValue(row,state,args))]));
 return safe(problem,result)?result:null;
}
export function validateProblem(problem:EconomicProblem) {
 const unique=(values:string[])=>new Set(values).size===values.length;
 if(!unique(problem.quantities.map(q=>q.id))||!unique(problem.parameters.map(q=>q.id))||
  !unique(problem.operators.map(o=>o.id))||!unique(problem.meanings.map(m=>m.key)))fail('Y1_DUPLICATE_SEMANTIC_MEMBER');
 for(const q of [...problem.quantities,...problem.parameters])if(!unique(q.values)||q.values.some(v=>exact(v)<0n))fail('Y1_NONNEGATIVE_DISTINCT_DOMAIN_REQUIRED');
 const states=product(problem.quantities,PROFILE.maxStateProduct),parameters=product(problem.parameters,PROFILE.maxParameterProduct);
 for(const invariant of problem.invariants){
  const quantities=invariant.terms.map(t=>problem.quantities.find(q=>q.id===t.quantityId));
  if(quantities.some(q=>!q)||quantities.some(q=>dimension(q!)!==dimension(quantities[0]!))||
   !unique(invariant.terms.map(t=>t.quantityId)))fail('Y1_INVARIANT_DIMENSION_UNSUPPORTED');
 }
 if(!states.some(s=>safe(problem,s)))fail('Y1_EMPTY_VALID_STATE_DOMAIN');
 for(const op of problem.operators){
  if(!unique(op.requirements.map(r=>r.key))||!op.examples.some(e=>e.after!==null))fail('Y1_NONVACUOUS_OBSERVATION_REQUIRED');
  for(const e of op.examples)if(!safe(problem,e.before)||!inDomain(e.parameters,problem.parameters)||e.after!==null&&!safe(problem,e.after))
   fail('Y1_EXAMPLE_OUTSIDE_DECLARED_DOMAIN');
 }
 return {states,parameters};
}
export function wordDenotation(problem:EconomicProblem,operators:EconomicOperator[],word:string[],states:State[],parameters:State[],meter:Meter){
 const h=createHash('sha256'),byId=new Map(operators.map(o=>[o.id,o]));let enabledWitnesses=0,witness:CompositionLaw['witness']|null=null;
 const requirements=[...new Set(word.flatMap(id=>byId.get(id)!.requirements.map(r=>canonical(r))))].sort();
 for(const state of states)for(const args of parameters){
  let current:State|null=safe(problem,state)?state:null;
  for(const id of word)if(current)current=applyOperator(problem,byId.get(id)!,current,args,meter);
  const result=current?{state:current,requirements}:null;
  if(current){enabledWitnesses++;witness??={before:state,parameters:args,after:current};}
  h.update(canonical([state,args,result])+'\n');
 }
 return {denotationDigest:h.digest('hex'),enabledWitnesses,witness};
}
export function semanticFootprint(rows:SemanticRow[]){
 return {reads:[...new Set(rows.flatMap(r=>r.terms.filter(t=>t.input==='STATE').map(t=>t.id)))].sort(),
  writes:rows.filter(r=>canonical(r.terms)!==canonical([{input:'STATE',id:r.output,coefficient:1}])).map(r=>r.output).sort()};
}
export function dependencyGraph(problem:EconomicProblem,body:{operators:EconomicOperator[];laws:CompositionLaw[]}){
 const meanings=problem.meanings.map(m=>({id:'meaning:'+m.key,dependsOn:[],digest:digest(m)}));
 const authority={id:'authority',dependsOn:[],digest:digest(problem.operators.map(o=>o.requirements.filter(r=>r.kind==='AUTHORITY')))};
 const invariants={id:'invariants',dependsOn:[...new Set(problem.invariants.map(i=>'meaning:'+i.meaningKey))],digest:digest(problem.invariants)};
 const operators=body.operators.map(o=>({id:'operator:'+o.id,
  dependsOn:[...new Set(['invariants','authority',...problem.quantities.concat(problem.parameters).map(q=>'meaning:'+q.meaningKey),
   ...o.requirements.filter(r=>r.kind!=='AUTHORITY').map(r=>'meaning:'+r.key)])],digest:digest(o)}));
 const laws=body.laws.map((law,index)=>({id:'law:'+index,dependsOn:[...new Set([...law.left,...law.right].map(id=>'operator:'+id))],digest:digest(law)}));
 return [...meanings,authority,invariants,...operators,...laws];
}
