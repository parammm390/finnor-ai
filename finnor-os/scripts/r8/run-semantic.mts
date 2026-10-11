/** Registered isolated mathematical E2E, with repeatable raw evidence.
 * See pre-implementation failure-model.md and verification-plan.json. */
import {strict as assert} from 'node:assert';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {synthesizeSolver} from '../../packages/epistemic-runtime/src/solver-synthesis/producer';
import {programForChoices,validateProgram} from '../../packages/epistemic-runtime/src/solver-synthesis/grammar';
import {lowerProgram,assertLowering} from '../../packages/epistemic-runtime/src/solver-synthesis/lowering';
import {assertCoverage,checkCounterexample,openReference} from '../../packages/epistemic-runtime/src/solver-synthesis/checker';
import {loadRuntime} from '../../packages/epistemic-runtime/src/solver-synthesis/runtime';
import {hash,SPECIFICATION,type Choices} from '../../packages/epistemic-runtime/src/solver-synthesis/contracts';
import {canonical} from '../../packages/governed-execution/src/protocol';

const output=resolve(process.env.FINNOR_R8_EVIDENCE_DIR??'/tmp/finnor-r8-semantic-'+randomUUID());
await mkdir(output,{recursive:true,mode:0o700});
const startedAt=new Date().toISOString(),cases:Array<Record<string,unknown>>=[];
async function save(name:string,value:unknown){await writeFile(resolve(output,name),JSON.stringify(value)+'\n',{mode:0o600});}
async function challenge(id:string,expected:string,run:()=>Promise<unknown>){
 const began=performance.now();
 try{cases.push({id,expected,status:'PASS',observed:await run(),elapsedMs:performance.now()-began});}
 catch(error){cases.push({id,expected,status:'FAIL',observed:{message:error instanceof Error?error.message:String(error)},elapsedMs:performance.now()-began});}
 await save('results.json',{schema:'finnor.r8.semantic-e2e.v1',startedAt,finishedAt:new Date().toISOString(),cases,
  specification:SPECIFICATION,rerun:'FINNOR_R8_RUNTIME_MANIFEST=<sealed-runtime.json> FINNOR_R8_EVIDENCE_DIR=<new-private-dir> node --import=tsx finnor-os/scripts/r8/run-semantic.mts',
  qualification:'Independent exact full-domain mathematics and ordinary local execution; not S8 admission, business truth, gain or economics'});
 console.log(JSON.stringify(cases.at(-1)));
}
let synthesis:Awaited<ReturnType<typeof synthesizeSolver>>|null=null;
await challenge('actual-cegis-and-full-original-domain','A real deficient Rosette candidate, independently checked CE, later repair, 262144 actual emitted/interpreted rows and 2097152 reference pairs',async()=>{
 // Match the decisive failed owner's original cap, not a new one-hour episode.
 const deadlineAt=Date.now()+574739,acceptances:Array<{trial:unknown;receipt:unknown}>=[];
 await save('original-budget.json',{deadlineAt,wallMs:574739,maxRounds:16,resetAllowed:false});
 synthesis=await synthesizeSolver({deadlineAt,hooks:{
  onQuery:async value=>{await save('query-'+hash(value)+'.json',value);},
  onTrial:async value=>{await save('trial-'+value.round+'.json',value);},
  onChunk:async value=>{await save('chunk-'+value.programDigest+'-'+String(value.start).padStart(6,'0')+'.json',value);console.log(JSON.stringify({program:value.programDigest,coverage:value.start+value.count}));},
  onAcceptance:async(trial,receipt)=>{assertCoverage(receipt);acceptances.push({trial,receipt});
   await save('acceptance-'+hash(trial.program)+'.json',{trial,receipt});await save('trial-'+trial.round+'.json',trial);},
 }});
 assert(synthesis.counterexamples.length>0);assert(synthesis.trials.some(t=>t.status==='REJECTED'));
 assert.equal(synthesis.receipt.checkedInputs,262144);assert.equal(synthesis.receipt.checkedPairs,2097152);
 assertCoverage(synthesis.receipt);await save('synthesis.json',synthesis);
 assert.equal(synthesis.resources.optimization.status,'COMPLETE');
 assert.equal(synthesis.resources.optimization.selected,true);
 assert.equal(synthesis.resources.optimization.globalCheapestClaim,false);
 assert.equal(acceptances.length,2,'Incumbent and alternative require independent whole-domain acceptances');
 assert(Date.now()<=deadlineAt,'No original deadline extension');
 return {rounds:synthesis.trials.length,counterexamples:synthesis.counterexamples.length,
  receiptDigest:hash(synthesis.receipt),checkedInputs:262144,checkedPairs:2097152,
  independentAcceptances:acceptances.length,originalDeadlineAt:new Date(deadlineAt).toISOString(),resources:synthesis.resources};
});

await challenge('semantic-mutations-reach-original-oracle','Changed enumeration, objective, cost, capacity and tie fail the relevant predicate on actual emitted bytes',async()=>{
 const runtime=await loadRuntime();
 const exact:Choices={enabled:Array(7).fill(true),costFamily:0,netScore:false,capacity:7,inclusiveFeasibility:true,inclusiveImprovement:false,descending:false};
 const mutations=[
  {id:'omitted-combination',choices:{...exact,enabled:[true,true,false,true,false,false,false]},input:[1,1,1,3,3,3]},
  {id:'utility-minus-cost',choices:{...exact,netScore:true},input:[7,7,7,7,0,0]},
  {id:'utility-is-capacity-cost',choices:{...exact,costFamily:1 as const},input:[1,1,1,3,3,3]},
  {id:'capacity-six',choices:{...exact,capacity:6 as const},input:[7,7,7,7,0,0]},
  {id:'capacity-eight',choices:{...exact,capacity:8 as const},input:[4,4,7,7,7,0]},
  {id:'strict-capacity',choices:{...exact,inclusiveFeasibility:false},input:[7,7,7,7,0,0]},
  {id:'wrong-zero-tie',choices:{...exact,inclusiveImprovement:true},input:[0,0,0,0,0,0]},
  {id:'wrong-descending-tie',choices:{...exact,descending:true},input:[7,7,7,7,7,7]},
 ];
 const observed=[];
 for(const mutation of mutations){
  const program=programForChoices(mutation.choices),module=lowerProgram(program,'0'.repeat(64));
  const result=await checkCounterexample(program,module,mutation.input,runtime,Date.now()+60000);
  assert(result.witness.failures.length>0,mutation.id);observed.push({id:mutation.id,...result});
 }
 await save('semantic-mutations.json',observed);return observed.map(v=>({id:v.id,failures:v.witness.failures}));
});
await challenge('grammar-arithmetic-termination-and-domain-mutations','Hidden I/O, overflow, false loops/fuel, fractional input reference and altered domain reject independently',async()=>{
 const exact=programForChoices({enabled:Array(7).fill(true),costFamily:0,netScore:false,capacity:7,inclusiveFeasibility:true,inclusiveImprovement:false,descending:false});
 const variants:Array<{id:string;program:unknown}>=[
  {id:'hidden-io',program:{...exact,body:[{op:'readFile',path:'/tmp/private'}]}},
  {id:'false-loop-step',program:{...exact,body:[{op:'for',name:'i',from:0,to:7,step:0,body:[]}]}},
  {id:'fuel-lie',program:{...exact,bounds:{steps:1,integerAbs:63}}},
  {id:'overflow-growth',program:{...exact,body:[{op:'set',name:'mask',value:{op:'mul',left:{op:'int',value:21},right:{op:'int',value:21}}}],output:'mask'}},
  {id:'fractional-coercion',program:{...exact,body:[{op:'set',name:'mask',value:{op:'int',value:.5}}],output:'mask'}},
  {id:'domain-filter',program:{...exact,assume:{input0:0}}},
  {id:'swapped-order',program:{...exact,inputOrder:['v1','v2','v3','c1','c2','c3']}},
 ];
 const runtime=await loadRuntime(),reference=await openReference(runtime,Date.now()+60000),observed=[];
 try{for(const variant of variants){
  let producerRefusal='',checkerRefusal='';
  try{validateProgram(variant.program);}catch(error){producerRefusal=String(error);}
  try{await reference.query('VALIDATE',variant.program as typeof exact,null);}catch(error){checkerRefusal=String(error);}
  assert(producerRefusal&&checkerRefusal.startsWith('Error: R8_INDEPENDENT_CHECKER:'),variant.id);
  observed.push({id:variant.id,producerRefusal,checkerRefusal});
 }}finally{await reference.close();}
 await save('structural-mutations.json',observed);return observed;
});
await challenge('lowering-compiler-emitted-and-coverage-substitution','Rehashed altered AST/IR/emitted/compiler and missing/duplicated/mixed chunks cannot inherit a receipt',async()=>{
 assert(synthesis,'Prior real semantic acceptance required');
 const observed=[];
 for(const variant of ['ast','ir','emitted','compiler']){
  const program=structuredClone(synthesis.program),module=structuredClone(synthesis.module);
  if(variant==='ast')program.output='bestValue';
  if(variant==='ir'){const ir=JSON.parse(module.compiled);ir.outputs[0].register='r0';module.compiled=canonical(ir);}
  if(variant==='emitted')module.typescript.emitted='export function compute(){return {mask:"0"}}';
  if(variant==='compiler')module.typescript.compiler.optionsDigest='0'.repeat(64);
  let refusal='';try{assertLowering(program,module);}catch(error){refusal=String(error);}assert(refusal,variant);observed.push({variant,refusal});
 }
 for(const variant of ['omission','duplicate','candidate','checker','output','pairs']){
  const receipt=structuredClone(synthesis.receipt);
  if(variant==='omission')receipt.chunks.pop();
  if(variant==='duplicate')receipt.chunks[1]=receipt.chunks[0]!;
  if(variant==='candidate')receipt.chunks[0]!.moduleDigest='0'.repeat(64);
  if(variant==='checker')receipt.chunks[0]!.checkerDigest='0'.repeat(64);
  if(variant==='output')receipt.chunks[0]!.masks='0'.repeat(4096);
  if(variant==='pairs')receipt.chunks[0]!.pairs=4096;
  receipt.chunkDigest=hash(receipt.chunks);
  let refusal='';try{assertCoverage(receipt);}catch(error){refusal=String(error);}assert(refusal,variant);observed.push({variant,refusal});
 }
 await save('identity-mutations.json',observed);return observed;
});
console.log(JSON.stringify({output,status:cases.every(c=>c.status==='PASS')?'PASS':'FAIL'}));
if(cases.some(c=>c.status!=='PASS'))process.exitCode=1;
