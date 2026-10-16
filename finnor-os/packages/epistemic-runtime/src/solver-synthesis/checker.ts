/** Independent acceptance transport. Expected answers are produced by Python,
 * never by Rosette, this producer grammar or the P1 native interpreter. */
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {JsonProcess} from './process';
import {openTypeScriptModuleBatch} from './emitted';
import type {NativeModule} from '../../../private-equity/src/program-synthesis/contracts';
import {assertLowering} from './lowering';
import {runtimeReadPaths,scientificPath,assertSourceIdentity,loadRuntime} from './runtime';
import {INPUT_COUNT,CHUNK_SIZE,INPUT_ORDER,SPECIFICATION,GRAMMAR,R8_PROFILE,hash,bytesHash,coordinates,
 type IntegerProgram,type RuntimeIdentity,type SourcePin,type CoverageChunk,type SemanticReceipt} from './contracts';

export interface Witness {
 input:number[];output:number;reference:{mask:number;value:number;optimalMasks:number[];rows:Array<{mask:number;cost:number;value:number;feasible:boolean}>};
 failures:string[];gap:number|null;steps:number;maximumIntegerAbs:number;emitted:number|null;
}
function canonicalChunkInputDigest(start:number,count:number) {
 const digest=createHash('sha256');
 for(let index=start;index<start+count;index++){
  let remaining=index;const coords=Array<number>(6);
  for(let position=5;position>=0;position--){coords[position]=remaining%8;remaining=Math.floor(remaining/8);}
  digest.update(JSON.stringify([index,coords])+'\n');
 }
 return digest.digest('hex');
}
interface ChunkReply {
 status:'PASS'|'FAIL';start:number;count:number;pairs:number;inputs:number[][];expected:number[];interpreted:number[];
 optimalSets:number[];inputDigest:string;outputDigest:string;steps:number;maximumIntegerAbs:number;witness?:Witness;index?:number;
}
export async function openReference(runtime:RuntimeIdentity,deadlineAt:number,signal?:AbortSignal) {
 const path=scientificPath('reference.py'),supervisor=scientificPath('supervise.py'),checkerDigest=bytesHash(await readFile(path));
 const child=await JsonProcess.open({executable:runtime.python.path,args:[supervisor,String(deadlineAt),await realpath(runtime.python.path),'-B','-u',path],
  readPaths:[...runtimeReadPaths(runtime),path,supervisor],deadlineAt,signal,
  environment:{PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
 return {
  checkerDigest,
  async query<T>(operation:'VALIDATE'|'WITNESS'|'CHUNK',program:IntegerProgram,input:unknown):Promise<T>{
   const result=await child.request({operation,program,input}) as {ok:boolean;result:T;reason?:string};
   if(!result.ok)throw Error('R8_INDEPENDENT_CHECKER:'+result.reason);return result.result;
  },
  close:()=>child.close(),
 };
}
export async function checkCounterexample(program:IntegerProgram,module:NativeModule,input:unknown,runtime:RuntimeIdentity,deadlineAt:number,signal?:AbortSignal) {
 const coords=coordinates(input);assertLowering(program,module);
 const childDeadline=Math.min(deadlineAt,Date.now()+60000);
 const reference=await openReference(runtime,childDeadline,signal);
 let native:Awaited<ReturnType<typeof openTypeScriptModuleBatch>>|undefined;
 try{
  // Startup itself belongs to custody. A refused native open must also close
  // the independent checker that was already started.
  native=await openTypeScriptModuleBatch(module,childDeadline,signal);
  const outputs=await native.execute([Object.fromEntries(INPUT_ORDER.map((key,i)=>[key,String(coords[i])]))],0);
  if(!/^[0-9]+$/.test(outputs[0]!.mask!))throw Error('R8_EMITTED_MASK_SERIALIZATION');
  const emitted=Number(outputs[0]!.mask),witness=await reference.query<Witness>('WITNESS',program,{coordinates:coords,emitted});
  if(witness.failures.includes('EMITTED_INTERPRETER_DISAGREEMENT'))throw Error('R8_COUNTEREXAMPLE_LOWERING_FAILURE');
  return {witness,emitted,resource:{native:await native.close(),checker:await reference.close()}};
 }catch(error){await Promise.allSettled([...(native?[native.close()]:[]),reference.close()]);throw error;}
}
export function assertCoverage(receipt:SemanticReceipt) {
 if(receipt.schema!=='finnor.r8.semantic-receipt.v1'||receipt.status!=='COMPLETE'||receipt.profile!==R8_PROFILE||
  receipt.specificationDigest!==hash(SPECIFICATION)||receipt.grammarDigest!==hash(GRAMMAR)||receipt.checkedInputs!==INPUT_COUNT||
  receipt.checkedPairs!==2097152||receipt.protectedAdmission!==false||receipt.chunkDigest!==hash(receipt.chunks)||
  receipt.basis!=='INDEPENDENT_PYTHON_INTEGER_AST_AND_FULL_ISOLATED_EMITTED_ENUMERATION'||receipt.chunks.length!==INPUT_COUNT/CHUNK_SIZE)throw Error('R8_COMPLETE_COVERAGE_IDENTITY');
 let next=0,pairs=0;
 for(const chunk of receipt.chunks){
  if(chunk.schema!=='finnor.r8.coverage-chunk.v1'||chunk.status!=='PASS'||chunk.start!==next||chunk.count!==CHUNK_SIZE||
   chunk.pairs!==chunk.count*8||chunk.programDigest!==receipt.programDigest||chunk.moduleDigest!==receipt.moduleDigest||
   chunk.emittedDigest!==receipt.emittedDigest||chunk.specificationDigest!==receipt.specificationDigest||chunk.checkerDigest!==receipt.checkerDigest||
   chunk.masks.length!==chunk.count||!/^[0-7]+$/.test(chunk.masks)||typeof chunk.optimalSets!=='string'||
   chunk.optimalSets.length!==chunk.count*2||!/^[a-f0-9]+$/.test(chunk.optimalSets)||
   [...Buffer.from(chunk.optimalSets,'hex')].some(v=>v<1)||hash([...chunk.masks].map(Number))!==chunk.outputDigest||
   hash([...Buffer.from(chunk.optimalSets,'hex')])!==chunk.optimalSetsDigest||chunk.steps<chunk.count||chunk.steps>chunk.count*1024||
   !Number.isSafeInteger(chunk.steps)||!Number.isSafeInteger(chunk.maximumIntegerAbs)||
   chunk.maximumIntegerAbs<0||chunk.maximumIntegerAbs>63||
   chunk.inputDigest!==canonicalChunkInputDigest(chunk.start,chunk.count)||
   [...chunk.masks].some((mask,i)=>{
    const alternatives=Number.parseInt(chunk.optimalSets.slice(i*2,i*2+2),16);
    return !(alternatives&(1<<Number(mask)))||(alternatives&((1<<Number(mask))-1))!==0;
   }))throw Error('R8_COVERAGE_OMISSION_DUPLICATION_OR_SUBSTITUTION');
  next+=chunk.count;pairs+=chunk.pairs;
 }
 if(next!==INPUT_COUNT||pairs!==2097152)throw Error('R8_ORIGINAL_DOMAIN_INCOMPLETE');
}
export async function verifyCompleteDomain(input:{
 program:IntegerProgram;module:NativeModule;runtime:RuntimeIdentity;sourcePins:SourcePin[];deadlineAt:number;signal?:AbortSignal;
 onChunk?:(chunk:CoverageChunk)=>Promise<void>;retainedChunks?:CoverageChunk[];
}):Promise<SemanticReceipt> {
 const began=performance.now();assertLowering(input.program,input.module);await assertSourceIdentity(input.sourcePins);
 const deadlineAt=Math.min(input.deadlineAt,Date.now()+600000);
 const reference=await openReference(input.runtime,deadlineAt,input.signal);
 let native:Awaited<ReturnType<typeof openTypeScriptModuleBatch>>|undefined;
 const chunks:CoverageChunk[]=[];
 // Resume may reuse only independently retained chunks with the same exact
 // identities. Full accepted coverage is checked again at completion.
 const retained=input.retainedChunks??[];
 try{
  native=await openTypeScriptModuleBatch(input.module,deadlineAt,input.signal);
  if(new Set(retained.map(chunk=>chunk.start)).size!==retained.length||
   retained.some(chunk=>!Number.isSafeInteger(chunk.start)||chunk.start<0||chunk.start>=INPUT_COUNT||chunk.start%CHUNK_SIZE!==0))
   throw Error('R8_RESUME_DUPLICATE_OR_OUT_OF_DOMAIN_CHUNK');
  await reference.query('VALIDATE',input.program,null);
  const resetInputs=[[0,0,0,0,0,0],[7,7,7,7,7,7],[1,2,3,3,2,1],[0,0,0,7,7,7]];
  const resetSequence=[...resetInputs,...[...resetInputs].reverse(),...resetInputs];
  const resets=await native.execute(resetSequence.map(coords=>Object.fromEntries(INPUT_ORDER.map((key,i)=>[key,String(coords[i])]))),0);
  for(let i=0;i<resets.length;i++){
   const coords=resetSequence[i]!;
   const witness=await reference.query<Witness>('WITNESS',input.program,{coordinates:coords,emitted:Number(resets[i]!.mask)});
   if(witness.failures.length)throw Error('R8_PERSISTENT_RESET_OR_SEMANTICS:'+hash(witness));
  }
  for(let start=0;start<INPUT_COUNT;start+=CHUNK_SIZE){
   if(Date.now()>=deadlineAt||input.signal?.aborted)throw Error('R8_VERIFICATION_INTERRUPTED_NO_WHOLE_DOMAIN_CLAIM');
   const prior=retained.find(c=>c.start===start);
   if(prior){
    if(prior.programDigest!==hash(input.program)||prior.moduleDigest!==input.module.compiledDigest||prior.emittedDigest!==input.module.typescript.emittedDigest||
     prior.checkerDigest!==reference.checkerDigest||prior.specificationDigest!==hash(SPECIFICATION))throw Error('R8_RESUME_CANDIDATE_OR_CHECKER_SUBSTITUTION');
    // The immutable owner record retains actual emitted outputs. Recompute its
    // independent reference and interpreter evidence before reusing those bytes.
    const checked=await reference.query<ChunkReply>('CHUNK',input.program,{start,count:CHUNK_SIZE});
    if(checked.status!=='PASS'||prior.status!=='PASS'||prior.count!==CHUNK_SIZE||prior.pairs!==CHUNK_SIZE*8||
     checked.inputDigest!==prior.inputDigest||checked.outputDigest!==prior.outputDigest||
     checked.expected.join('')!==prior.masks||checked.interpreted.join('')!==prior.masks||
     Buffer.from(checked.optimalSets).toString('hex')!==prior.optimalSets||
     hash(checked.optimalSets)!==prior.optimalSetsDigest||checked.steps!==prior.steps||
     checked.maximumIntegerAbs!==prior.maximumIntegerAbs)throw Error('R8_RESUME_ACCEPTED_CHUNK_EVIDENCE_CHANGED');
    chunks.push(prior);continue;
   }
   const result=await reference.query<ChunkReply>('CHUNK',input.program,{start,count:CHUNK_SIZE});
   if(result.status!=='PASS')throw Error('R8_ORIGINAL_DOMAIN_COUNTEREXAMPLE:'+JSON.stringify({index:result.index,witness:result.witness}));
   if(result.start!==start||result.count!==CHUNK_SIZE||result.pairs!==CHUNK_SIZE*8||result.inputs.length!==CHUNK_SIZE||
    result.expected.length!==CHUNK_SIZE||result.interpreted.length!==CHUNK_SIZE||result.optimalSets.length!==CHUNK_SIZE||
    hash(result.expected)!==result.outputDigest||result.inputDigest!==canonicalChunkInputDigest(start,CHUNK_SIZE)||
    result.inputs.some((coords,i)=>coords.length!==6||coords.some(value=>!Number.isSafeInteger(value)||value<0||value>7)||
     coords.reduce((index,value)=>index*8+value,0)!==start+i))
    throw Error('R8_CHECKER_CHUNK_CORRESPONDENCE');
   const outputs=await native.execute(result.inputs.map(coords=>Object.fromEntries(INPUT_ORDER.map((key,i)=>[key,String(coords[i])]))),start);
   const masks=outputs.map((output,i)=>{
    if(!/^[0-7]$/.test(output.mask??'')||Number(output.mask)!==result.expected[i]||Number(output.mask)!==result.interpreted[i])throw Error('R8_ACTUAL_EMITTED_REFERENCE_DISAGREEMENT:'+String(start+i));
    return output.mask!;
   }).join('');
   const chunk:CoverageChunk={schema:'finnor.r8.coverage-chunk.v1',start,count:CHUNK_SIZE,pairs:CHUNK_SIZE*8,
    programDigest:hash(input.program),moduleDigest:input.module.compiledDigest,emittedDigest:input.module.typescript.emittedDigest,
    checkerDigest:reference.checkerDigest,specificationDigest:hash(SPECIFICATION),inputDigest:result.inputDigest,outputDigest:result.outputDigest,
    optimalSetsDigest:hash(result.optimalSets),optimalSets:Buffer.from(result.optimalSets).toString('hex'),
    steps:result.steps,maximumIntegerAbs:result.maximumIntegerAbs,masks,status:'PASS'};
   chunks.push(chunk);await input.onChunk?.(chunk);
  }
  const resource={elapsedMs:performance.now()-began,native:await native.close(),checker:await reference.close(),usd:null,
   accounting:'ACTUAL_PERSISTENT_NATIVE_AND_SEPARATE_CHECKER_CHILD_INTERVALS_NOT_AGGREGATE_PEAK'};
  await assertSourceIdentity(input.sourcePins);if(hash(await loadRuntime())!==hash(input.runtime))throw Error('R8_RUNTIME_CHANGED_BEFORE_ACCEPTANCE');
  const receipt:SemanticReceipt={schema:'finnor.r8.semantic-receipt.v1',status:'COMPLETE',profile:R8_PROFILE,
   programDigest:hash(input.program),moduleDigest:input.module.compiledDigest,emittedDigest:input.module.typescript.emittedDigest,
   compilerDigest:hash(input.module.typescript.compiler),runtimeDigest:hash(input.runtime),specificationDigest:hash(SPECIFICATION),grammarDigest:hash(GRAMMAR),
   checkerDigest:reference.checkerDigest,checkedInputs:262144,checkedPairs:2097152,chunkDigest:hash(chunks),chunks,resetDigest:hash({resetInputs,resets}),
   resource,basis:'INDEPENDENT_PYTHON_INTEGER_AST_AND_FULL_ISOLATED_EMITTED_ENUMERATION',protectedAdmission:false};
  assertCoverage(receipt);return receipt;
 }catch(error){await Promise.allSettled([...(native?[native.close()]:[]),reference.close()]);throw error;}
}
