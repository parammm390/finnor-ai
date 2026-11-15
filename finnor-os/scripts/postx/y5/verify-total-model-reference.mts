import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import type {TotalExpression,ResolvedTotalSpecification} from '../../../packages/shared-types/src/total-algorithm-theory';
import type {TotalTaskBinding} from '../../../packages/private-equity/src/allocation-total-task';
import {checkTotalTaskResult,evaluateTotalTaskModel,replayTotalTaskModel,totalReferenceBounds} from '../../../packages/private-equity/src/allocation-total-task';
import {digest} from '../../../packages/private-equity/src/uniform-algorithms/contracts';

const root=resolve(import.meta.dirname,'../../../..'),phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8);
assert(phase==='red'||phase==='green','EXPLICIT_RED_OR_GREEN_PHASE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-model-reference-correctness'));
await mkdir(evidence,{recursive:true,mode:0o700});
const file=join(root,'finnor-os/packages/private-equity/src/allocation-total-task.ts');
const sourceSha256=createHash('sha256').update(await readFile(file)).digest('hex');
const int=(value:string):TotalExpression=>({op:'INT',value}),v:TotalExpression={op:'VAR',index:0};
const binary=(op:'AND'|'OR'|'EQ'|'LE'|'MUL',left:TotalExpression,right:TotalExpression):TotalExpression=>({op,left,right});
const pair=(left:TotalExpression,right:TotalExpression):TotalExpression=>({op:'PAIR',left,right});
const list=(head:TotalExpression):TotalExpression=>({op:'CONS',left:head,right:{op:'EMPTY',element:'INT'}});
const not=(arg:TotalExpression):TotalExpression=>({op:'NOT',arg});
const nonnegative=binary('LE',int('0'),v),atLeastTwo=binary('LE',int('2'),v);
const productEqual=binary('EQ',pair(v,int('0')),pair(v,int('0')));
const singletonEqual=binary('EQ',list(v),list(v));
const nestedList=(last:boolean):TotalExpression=>({op:'CONS',
 left:pair(v,{op:'BOOL',value:last}),right:{op:'EMPTY',element:{product:['INT','BOOL']}}});
const nestedEqual=binary('EQ',nestedList(true),nestedList(true));
function input(safe:TotalExpression,values:string[],advance:TotalExpression={op:'ADD',left:v,right:{op:'VAR',index:1}}){
 const definition={schema:'finnor.y5.total-family-definition.v2' as const,input:'ALL_FINITE_INTEGER_LISTS' as const,
  output:'MATHEMATICAL_INTEGER' as const,semanticState:'INT' as const,safe,advance,
  objective:'LEAST_FEASIBLE_INITIAL_STATE' as const,prefixes:'INCLUDING_EMPTY_AND_COMPLETE' as const,
  numericalMeaning:'EXACT_UNBOUNDED_INTEGER' as const,tie:'EQUAL_INTEGER_OUTPUT' as const,
  costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2' as const};
 const sourceRef={owner:'WORK_INPUT',id:'00000000-0000-4000-8000-000000000001',version:'MODEL_ISOLATION',contentDigest:digest(definition)};
 const specification:ResolvedTotalSpecification={schema:'finnor.y5.resolved-specification.v2',sourceRef,definition,
  definitionDigest:digest(definition),acceptance:{status:'PUBLIC_DEVELOPMENT',reason:'NO_INDEPENDENT_ACCEPTANCE_RECEIPT',protectedFamilyCredit:false}};
 const task={schema:'finnor.s5.total-task-binding.v2',workId:'00000000-0000-4000-8000-000000000002',
  work:{id:'00000000-0000-4000-8000-000000000003',digest:digest(values)},specificationDigest:digest(specification),
  sourceRef:{...sourceRef,id:'00000000-0000-4000-8000-000000000003',contentDigest:digest(values)},
  instance:{schema:'finnor.s5.total-task-instance.v2',specificationRef:sourceRef,values},
  qualification:'MODEL_ISOLATION_SYNTHETIC_NOT_AUTHENTICATED'} as unknown as TotalTaskBinding;
 return {specification,task};
}
const observations:{name:string;input:unknown;actual:unknown;status:'PASS'|'FAIL';error?:string}[]=[];
function run(name:string,fixture:ReturnType<typeof input>,action:()=>unknown,check:(actual:any)=>void){
 let actual:unknown;
 try{actual=action();}catch(error){actual={threw:(error as Error).message};}
 try{check(actual);observations.push({name,input:fixture,actual,status:'PASS'});}
 catch(error){observations.push({name,input:fixture,actual,status:'FAIL',error:String(error)});}
}
function prefix(name:string,safe:TotalExpression,expected:boolean){
 const fixture=input(safe,['-2','1']);
 run(name,fixture,()=>checkTotalTaskResult(fixture.specification,fixture.task,'3'),actual=>{
  if(!expected){assert.equal(actual.threw,'Y5_TOTAL_ORIGINAL_OWNER_PREFIX_CHECK_FAILED');return;}
  assert.equal(actual.feasible,true);assert.equal(actual.includesEmptyPrefix,true);
  assert.deepEqual(actual.prefixes,[{length:0,state:'3',safe:true},{length:1,state:'1',safe:true},{length:2,state:'2',safe:true}]);
 });
}
prefix('product-equality-uses-values-not-identity',productEqual,true);
prefix('singleton-list-equality-uses-values-not-identity',singletonEqual,true);
prefix('nested-list-product-boolean-equality',nestedEqual,true);
prefix('not-equal-product-is-false',not(productEqual),false);
prefix('not-equal-list-is-false',not(singletonEqual),false);
prefix('not-unequal-product-is-true',not(binary('EQ',pair(v,int('0')),pair(v,int('1')))),true);
prefix('not-unequal-nested-boolean-is-true',not(binary('EQ',nestedList(true),nestedList(false))),true);
prefix('different-list-length-is-not-equal',binary('EQ',list(v),{op:'EMPTY',element:'INT'}),false);

function model(name:string,safe:TotalExpression,values:string[],check:(actual:any)=>void,advance?:TotalExpression,expired=false){
 const fixture=input(safe,values,advance);
 run(name,fixture,()=>evaluateTotalTaskModel(fixture.specification,fixture.task,
  expired?Date.now()-1:Date.now()+totalReferenceBounds.maxWallMs),check);
}
function exact(value:string,rejected:string[]){
 return (actual:any)=>{
  assert.equal(actual.status,'MODEL_ACCEPTED');assert.equal(actual.value,value);assert.equal(actual.reason,null);
  assert.deepEqual(actual.reference.rejected.map((r:any)=>r.value),rejected);
  assert(actual.reference.prefixes.every((p:any)=>p.safe));assert.equal(actual.reference.prefixes[0].length,0);
  assert.equal(actual.reference.candidatesExamined,rejected.length+1);
 };
}
for(const [name,safe] of [
 ['supported-left-product',binary('AND',nonnegative,productEqual)],
 ['supported-right-product',binary('AND',productEqual,nonnegative)],
 ['supported-left-list',binary('AND',nonnegative,singletonEqual)],
 ['supported-right-list',binary('AND',singletonEqual,nonnegative)],
] as const)model(name,safe,['-2','-1','4'],actual=>{
 exact('3',['0','1','2'])(actual);
 assert.deepEqual(actual.reference.prefixes.map((p:any)=>p.state),['3','1','0','4']);
});
model('both-supported-conjuncts-use-maximum-bound',binary('AND',nonnegative,atLeastTwo),['-2','-1','4'],actual=>{
 exact('5',['2','3','4'])(actual);assert.equal(actual.reference.lowerBound.value,'2');
});
for(const [name,safe] of [
 ['unsupported-or-right',binary('OR',nonnegative,productEqual)],
 ['unsupported-or-left',binary('OR',productEqual,nonnegative)],
 ['both-unsupported-and',binary('AND',productEqual,{op:'BOOL',value:true})],
] as const)model(name,safe,[],actual=>{
 assert.equal(actual.status,'REFUSED');assert.equal(actual.reason,'UNSUPPORTED_SAFE_LOWER_BOUND');assert.equal(actual.value,null);
});
model('product-comparison-work-is-charged',binary('AND',nonnegative,productEqual),[],actual=>{
 exact('0',[])(actual);assert.equal(actual.reference.expressionSteps,21);
});
model('list-comparison-work-is-charged',binary('AND',nonnegative,singletonEqual),[],actual=>{
 exact('0',[])(actual);assert.equal(actual.reference.expressionSteps,20);
});
const huge=int('9'.repeat(4096)),overflow=binary('LE',int('0'),binary('MUL',huge,huge));
for(const [name,safe] of [
 ['and-never-swallows-right-integer-limit',binary('AND',nonnegative,overflow)],
 ['and-never-swallows-left-integer-limit',binary('AND',overflow,nonnegative)],
] as const)model(name,safe,[],actual=>{
 assert.equal(actual.status,'UNKNOWN');assert.equal(actual.reason,'INTEGER_BOUND');assert.equal(actual.value,null);
});
model('expired-original-deadline-is-unknown',binary('AND',nonnegative,productEqual),[],actual=>{
 assert.equal(actual.status,'UNKNOWN');assert.equal(actual.reason,'TIME_BOUND');assert.equal(actual.value,null);
},undefined,true);
{
 const fixture=input(binary('AND',nonnegative,productEqual),['-2','-1','4']);
 run('replay-is-bounded-by-recorded-work-and-never-reads-the-clock',fixture,()=>{
  const original=evaluateTotalTaskModel(fixture.specification,fixture.task);
  const expired=evaluateTotalTaskModel(fixture.specification,fixture.task,Date.now()-1);
  const realNow=Date.now;let clockReads=0;
  Date.now=()=>{clockReads++;return realNow();};
  let replayed,withheld;
  try{
   replayed=replayTotalTaskModel(fixture.specification,fixture.task,original.reference.expressionSteps);
   withheld=replayTotalTaskModel(fixture.specification,fixture.task,original.reference.expressionSteps-1);
  }finally{Date.now=realNow;}
  return {original,expired,replayed,withheld,clockReads};
 },actual=>{
  assert.equal(actual.original.status,'MODEL_ACCEPTED');
  assert.equal(actual.expired.status,'UNKNOWN');assert.equal(actual.expired.reason,'TIME_BOUND');
  assert.equal(actual.replayed.status,'MODEL_ACCEPTED');
  assert.equal(digest(actual.replayed),digest(actual.original));
  assert.equal(actual.withheld.status,'UNKNOWN');assert.equal(actual.withheld.reason,'EVALUATION_BOUND');
  assert.equal(actual.clockReads,0);
 });
}
model('candidate-bound-is-not-unsolvable',nonnegative,['-5000'],actual=>{
 assert.equal(actual.status,'UNKNOWN');assert.equal(actual.reason,'CANDIDATE_BOUND');assert.equal(actual.value,null);
 assert.equal(actual.reference.candidatesExamined,4096);assert.equal(actual.reference.rejected.length,4096);
});
model('structural-work-respects-evaluation-or-earlier-time-bound',binary('AND',nonnegative,nestedEqual),Array(128).fill('0'),actual=>{
 assert.equal(actual.status,'UNKNOWN');assert(['EVALUATION_BOUND','TIME_BOUND'].includes(actual.reason));assert.equal(actual.value,null);
 assert(actual.reference.expressionSteps<=totalReferenceBounds.maxExpressionSteps+1);
 if(actual.reason==='EVALUATION_BOUND')assert.equal(actual.reference.expressionSteps,2000001);
},int('-1'));
assert.deepEqual(totalReferenceBounds,{maxCandidates:4096,maxExpressionSteps:2000000,maxWallMs:1000,
 maxEvidenceBytes:1048576,maxIntegerDigits:4096});
const failures=observations.filter(o=>o.status==='FAIL');
const report={phase,status:failures.length?'FAIL':'PASS',scope:'MODEL_ISOLATION_ONLY',sourceSha256,
 bindingsAuthenticated:false,independentAcceptance:false,protectedCredit:false,kernelQualification:false,
 notes:['Pure synthetic bindings deliberately do not satisfy the authenticated binding schema.',
  'Kernel-related quality tags returned by the prefix function are not established by this isolation check.',
  'No budget, exported function, private function or response was mocked.',
  'The replay case counts reads of the clock around replay only; time itself was never altered.'],
 bounds:totalReferenceBounds,failures:failures.map(f=>f.name),observations,
 rerun:'cd finnor-os && node --max-old-space-size=1280 --import=tsx scripts/postx/y5/verify-total-model-reference.mts --phase=green'};
await writeFile(join(evidence,phase+'.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({phase,status:report.status,cases:observations.length,failures:report.failures,evidence,sourceSha256}));
process.exitCode=failures.length?1:0;
