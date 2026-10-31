import {z} from 'zod';
import type {TotalType,TotalExpression,TotalProgram,TotalFamilyDefinition,TotalProposition,TotalTerm,TotalSearchAttempt} from '../../../../shared-types/src/total-algorithm-theory';
import type {NativeBudget} from '../native';
import {jsonHash} from '../syntax';
import {parseDefinition,parseProgram,sameType,expressionType,programOperationBound,compileDevelopmentDefinition,
 compileDevelopmentProgram,DevelopmentLimitError} from './syntax';

export const searchGrammar={revision:'TOTAL_ENUMERATION_V2_1',maxExpressionNodes:5,maxExpressionsPerTypeAndSize:2048,
 maxInitialExpressions:3,maxResultExpressions:8,maxStateTypes:5,maxRankedPropositions:128,
 developmentIntegerDigits:2048,constantPool:5,propositionDepth:'ATOMS_NEGATION_AND_ALL_BINARY_CONNECTIVES'} as const;
export interface TotalSearchLimits{maxPrograms:number;maxPropositions:number;maxProofAttempts:number;maxRetainedBytes:number}
export interface TotalSearchState{
 programsExamined:number;propositionsExamined:number;proofAttempts:number;retainedBytes:number;
 attempts:TotalSearchAttempt[];stateTypesExamined:TotalType[];developmentLimits:number;
 stopReason:string|null;propositionFrontierTruncated:boolean;
}
export function newSearchState():TotalSearchState{return {programsExamined:0,propositionsExamined:0,proofAttempts:0,
 retainedBytes:0,attempts:[],stateTypesExamined:[],developmentLimits:0,stopReason:null,propositionFrontierTruncated:false};}
export const totalSearchLimitsSchema=z.object({maxPrograms:z.number().int().min(1).max(20000),maxPropositions:z.number().int().min(1).max(10000),
 maxProofAttempts:z.number().int().min(1).max(12),maxRetainedBytes:z.number().int().min(1024).max(8388608)}).strict();
export function retainAttempt(state:TotalSearchState,limits:TotalSearchLimits,value:Omit<TotalSearchAttempt,'ordinal'>):boolean{
 const attempt={ordinal:state.attempts.length+1,...value},bytes=Buffer.byteLength(JSON.stringify(attempt))+(state.attempts.length?1:2);
 if(state.retainedBytes+bytes>limits.maxRetainedBytes){state.stopReason='RETAINED_ATTEMPT_BYTE_LIMIT';return false;}
 state.attempts.push(attempt);state.retainedBytes+=bytes;return true;
}
async function available(budget:NativeBudget,state:TotalSearchState){
 if(state.stopReason)return false;
 if(!Number.isFinite(budget.deadlineAt)||Date.now()>=budget.deadlineAt){state.stopReason='ORIGINAL_DEADLINE';return false;}
 await new Promise<void>(yes=>setImmediate(yes));
 if(budget.current&&!await budget.current()){state.stopReason='CLAIM_OR_AUTHORITY_CHANGED';return false;}
 return true;
}
function inputs(value:string[][]){
 if(!Array.isArray(value)||value.length===0||value.length>64||value.some(xs=>!Array.isArray(xs)||xs.length>12||
  xs.some(x=>typeof x!=='string'||x.length>513||!/^(?:0|-?[1-9][0-9]*)$/.test(x))))throw Error('Y5_TOTAL_DEVELOPMENT_INPUT_BOUND');
 return value.map(xs=>xs.map(BigInt));
}
function constantPool(d:TotalFamilyDefinition,cases:bigint[][]):string[]{
 const values=['0','1','-1'],visit=(e:TotalExpression)=>{
  if(e.op==='INT')values.push(e.value);
  if('left'in e){visit(e.left);visit(e.right);}if('arg'in e)visit(e.arg);
  if(e.op==='IF'){visit(e.condition);visit(e.then);visit(e.else);}
 };
 visit(d.safe);visit(d.advance);for(const xs of cases)values.push(...xs.map(String));
 return [...new Set(values)].slice(0,searchGrammar.constantPool);
}
function stateTypes():TotalType[]{
 const base:TotalType[]=['INT','NAT','BOOL'];
 return [...base,...base.flatMap(t=>[{product:[t,t]} as TotalType,{list:t} as TotalType]),
  ...base.flatMap(a=>base.filter(b=>!sameType(a,b)).map(b=>({product:[a,b]} as TotalType)))].slice(0,searchGrammar.maxStateTypes);
}
function typeKey(t:TotalType){return JSON.stringify(t);}
function expressionFrontier(context:TotalType[],state:TotalType,constants:string[]){
 const types:TotalType[]=['INT','NAT','BOOL'];
 const addType=(t:TotalType)=>{if(!types.some(a=>sameType(a,t)))types.push(t);};
 const visitType=(t:TotalType)=>{addType(t);if(typeof t!=='string'){if('product'in t)t.product.forEach(visitType);else visitType(t.list);}};
 visitType(state);context.forEach(visitType);
 const levels=new Map<number,Map<string,TotalExpression[]>>(),seen=new Set<string>();
 const get=(n:number,t:TotalType)=>levels.get(n)?.get(typeKey(t))??[];
 const put=(size:number,e:TotalExpression)=>{
  let t:TotalType;try{t=expressionType(e,context);}catch{return;}
  if(!types.some(a=>sameType(a,t)))return;
  const key=JSON.stringify(e);if(seen.has(key))return;
  const level=levels.get(size)??new Map<string,TotalExpression[]>(),group=level.get(typeKey(t))??[];
  if(group.length>=searchGrammar.maxExpressionsPerTypeAndSize)return;
  group.push(e);seen.add(key);level.set(typeKey(t),group);levels.set(size,level);
 };
 for(const value of constants)put(1,{op:'INT',value});
 for(const value of ['0','1'])put(1,{op:'NAT',value});
 for(const value of [false,true])put(1,{op:'BOOL',value});
 for(const t of types)if(typeof t!=='string'&&'list'in t)put(1,{op:'EMPTY',element:t.list});
 context.forEach((_,index)=>put(1,{op:'VAR',index}));
 const built=new Set([1]);
 const build=(size:number)=>{
  if(built.has(size))return;
  for(let n=1;n<size;n++)build(n);
  for(const t of types)for(const arg of get(size-1,t)){
   if(t==='BOOL')put(size,{op:'NOT',arg});
   if(typeof t!=='string'&&'product'in t){put(size,{op:'FIRST',arg});put(size,{op:'SECOND',arg});}
   if(typeof t!=='string'&&'list'in t)for(const op of ['HEAD','TAIL','LENGTH','IS_EMPTY'] as const)put(size,{op,arg});
  }
  for(let leftSize=1;leftSize<size-1;leftSize++){
   const rightSize=size-leftSize-1;
   for(const t of ['INT','NAT'] as const)for(const left of get(leftSize,t))for(const right of get(rightSize,t)){
    for(const op of ['ADD','SUB','MUL','MIN','MAX','LE','LT','EQ'] as const)put(size,{op,left,right});
   }
   for(const left of get(leftSize,'BOOL'))for(const right of get(rightSize,'BOOL'))
    for(const op of ['AND','OR','EQ'] as const)put(size,{op,left,right});
   for(const t of types)if(typeof t!=='string'){
    if('product'in t)for(const left of get(leftSize,t.product[0]))for(const right of get(rightSize,t.product[1]))put(size,{op:'PAIR',left,right});
    else for(const left of get(leftSize,t.list))for(const right of get(rightSize,t))put(size,{op:'CONS',left,right});
   }
  }
  for(let conditionSize=1;conditionSize<size-2;conditionSize++)for(let leftSize=1;leftSize<size-conditionSize-1;leftSize++){
   const rightSize=size-conditionSize-leftSize-1;
   for(const condition of get(conditionSize,'BOOL')){
    if(condition.op==='BOOL')continue;
    for(const t of types)for(const a of get(leftSize,t))for(const b of get(rightSize,t))put(size,{op:'IF',condition,then:a,else:b});
   }
  }
  built.add(size);
 };
 return {get:(size:number,t:TotalType)=>{if(size>0)build(size);return get(size,t);}};
}
function hasVariable(e:TotalExpression):boolean{
 if(e.op==='VAR')return true;if('left'in e)return hasVariable(e.left)||hasVariable(e.right);
 if('arg'in e)return hasVariable(e.arg);
 return e.op==='IF'&&(hasVariable(e.condition)||hasVariable(e.then)||hasVariable(e.else));
}
function initialProbes(output:bigint){return [...new Set(Array.from({length:17},(_,i)=>String(i-8)).concat([String(output-1n),String(output),String(output+1n)]))].map(BigInt);}
function counterexample(d:ReturnType<typeof compileDevelopmentDefinition>,run:ReturnType<typeof compileDevelopmentProgram>,cases:bigint[][]){
 for(const xs of cases){
  const output=run(xs);
  if(!d.feasible(xs,output))return {input:xs.map(String),output:output.toString(),violation:'OUTPUT_INFEASIBLE'};
  for(const c of initialProbes(output))if(c<output&&d.feasible(xs,c))return {
   input:xs.map(String),output:output.toString(),feasibleSmallerInitial:c.toString(),violation:'NOT_LEAST'};
 }
 return null;
}
export async function* programCandidates(definition:TotalFamilyDefinition,developmentInputs:string[][],
 limits:TotalSearchLimits,budget:NativeBudget,state:TotalSearchState):AsyncGenerator<TotalProgram>{
 limits=totalSearchLimitsSchema.parse(limits);const meaning=parseDefinition(definition),cases=inputs(developmentInputs),
  constants=constantPool(meaning,cases),d=compileDevelopmentDefinition(meaning),seen=new Set<string>();
 if(!await available(budget,state))return;
 const prepared=stateTypes().map(stateType=>{
  state.stateTypesExamined.push(stateType);
  const initial=expressionFrontier([],stateType,constants),step=expressionFrontier(['INT',stateType],stateType,constants),
   result=expressionFrontier([stateType],stateType,constants);
  const initials=[1,2,3].flatMap(n=>initial.get(n,stateType)).slice(0,searchGrammar.maxInitialExpressions);
  const results=[1,2,3,4].flatMap(n=>result.get(n,'INT')).slice(0,searchGrammar.maxResultExpressions);
  return {stateType,step,pairs:initials.flatMap(a=>results.map(b=>({initial:a,result:b})))};
 });
 const pruned=new Set<string>();
 for(let nodes=1;nodes<=searchGrammar.maxExpressionNodes;nodes++)for(const family of prepared){
  if(!await available(budget,state))return;
  for(const step of family.step.get(nodes,family.stateType))for(const pair of family.pairs){
   const pairKey=jsonHash({stateType:family.stateType,...pair});if(pruned.has(pairKey))continue;
   const program=parseProgram({schema:'finnor.y5.total-program.v2',recursion:'RIGHT_STRUCTURAL_FOLD',stateType:family.stateType,step,...pair});
   const programDigest=jsonHash(program);if(seen.has(programDigest))continue;seen.add(programDigest);
   if(state.programsExamined>=limits.maxPrograms){state.stopReason='PROGRAM_LIMIT';return;}
   if(state.programsExamined%64===0&&!await available(budget,state))return;
   state.programsExamined++;
   let cex:ReturnType<typeof counterexample>;
   try{
    programOperationBound(program);
    const run=compileDevelopmentProgram(program);
    cex=counterexample(d,run,cases);
    if(cex&&(!hasVariable(pair.result)||cex.input.length===0))pruned.add(pairKey);
   }catch(error){
    if(error instanceof DevelopmentLimitError||String(error).includes('TRAVERSAL_REQUIRES_NONCONSTANT_COST_PROOF')){
     state.developmentLimits++;if(!retainAttempt(state,limits,{stage:'PROGRAM_DEVELOPMENT',programDigest,status:'UNPROVED'}))return;
     continue;
    }
    throw error;
   }
   if(!retainAttempt(state,limits,{stage:'PROGRAM_DEVELOPMENT',programDigest,status:cex?'REFUTED':'UNPROVED',...(cex?{counterexample:cex}:{})}))return;
   if(!cex)yield program;
  }
 }
}
interface PropositionCase{input:bigint[];initial:bigint;output:bigint}
export async function* propositionCandidates(definition:TotalFamilyDefinition,program:TotalProgram,developmentInputs:string[][],
 limits:TotalSearchLimits,budget:NativeBudget,state:TotalSearchState):AsyncGenerator<TotalProposition>{
 limits=totalSearchLimitsSchema.parse(limits);if(!await available(budget,state))return;
 const d=compileDevelopmentDefinition(definition),run=compileDevelopmentProgram(program),cases:PropositionCase[]=[];
 for(const input of inputs(developmentInputs)){const output=run(input);for(const initial of initialProbes(output))cases.push({input,output,initial});}
 const all=(1n<<BigInt(cases.length))-1n,terms:TotalTerm[]=[{op:'INITIAL'},{op:'OUTPUT'},{op:'ZERO'}];
 const atoms:TotalProposition[]=[{op:'TRUE'},{op:'FALSE'}];
 for(const arg of terms)for(const op of ['FEASIBLE','SAFE'] as const)atoms.push({op,arg});
 for(const left of terms)for(const right of terms)for(const op of ['LE','LT','EQ'] as const)atoms.push({op,left,right});
 const term=(t:TotalTerm,c:PropositionCase)=>t.op==='INT'?BigInt(t.value):t.op==='INITIAL'?c.initial:t.op==='OUTPUT'?c.output:0n;
 const atomic=(f:TotalProposition,c:PropositionCase)=>{
  switch(f.op){
   case 'TRUE':return true;case 'FALSE':return false;
   case 'FEASIBLE':return d.feasible(c.input,term(f.arg,c));case 'SAFE':return d.safe(term(f.arg,c));
   case 'LE':return term(f.left,c)<=term(f.right,c);case 'LT':return term(f.left,c)<term(f.right,c);case 'EQ':return term(f.left,c)===term(f.right,c);
   default:throw Error('Y5_TOTAL_EXPECTED_ATOM');
  }
 };
 const entries=atoms.map(formula=>({formula,mask:cases.reduce((mask,c,i)=>atomic(formula,c)?mask|(1n<<BigInt(i)):mask,0n)}));
 const masks=new Map(entries.map(e=>[jsonHash(e.formula),e.mask]));
 const information=(f:TotalProposition):number=>{
  if(f.op==='NOT')return information(f.arg);
  if(f.op==='AND'||f.op==='OR'||f.op==='IFF'||f.op==='IMPLIES')return information(f.left)+information(f.right);
  const mask=masks.get(jsonHash(f));return mask!==undefined&&mask!==0n&&mask!==all?10:0;
 };
 const candidates:{formula:TotalProposition;score:number;key:string}[]=[],programDigest=jsonHash(program),seen=new Set<string>();
 const consider=(formula:TotalProposition,mask:bigint)=>{
  if(state.propositionsExamined>=limits.maxPropositions){state.propositionFrontierTruncated=true;return false;}
  const key=jsonHash(formula);if(seen.has(key))return true;seen.add(key);state.propositionsExamined++;
  if(mask!==all){
   let index=0;while((mask&(1n<<BigInt(index)))!==0n)index++;
   const c=cases[index]!;
   return retainAttempt(state,limits,{stage:'CONJECTURE_DEVELOPMENT',programDigest,propositionDigest:key,status:'REFUTED',
    counterexample:{input:c.input.map(String),initial:c.initial.toString(),output:c.output.toString(),propositionFalse:true}});
  }
  const source=JSON.stringify(formula),score=(source.includes('"OUTPUT"')?20:0)+(source.includes('"INITIAL"')?20:0)+
   (source.includes('"FEASIBLE"')?20:0)+(formula.op==='IFF'?4:0)+(formula.op==='AND'?2:0)+information(formula)-source.length/10000;
  candidates.push({formula,score,key});return true;
 };
 for(const entry of entries)if(!consider(entry.formula,entry.mask))break;
 for(const entry of entries)if(!consider({op:'NOT',arg:entry.formula},(~entry.mask)&all))break;
 outer:for(const op of ['AND','OR','IMPLIES','IFF'] as const)for(const a of entries)for(const b of entries){
  if(state.propositionsExamined%128===0&&!await available(budget,state))return;
  const mask=op==='AND'?a.mask&b.mask:op==='OR'?a.mask|b.mask:op==='IMPLIES'?((~a.mask)|b.mask)&all:(~(a.mask^b.mask))&all;
  if(!consider({op,left:a.formula,right:b.formula},mask))break outer;
 }
 for(const candidate of candidates.sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key)).slice(0,searchGrammar.maxRankedPropositions)){
  if(!await available(budget,state))return;yield candidate.formula;
 }
}
