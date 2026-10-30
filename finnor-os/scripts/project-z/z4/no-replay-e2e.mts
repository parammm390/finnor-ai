/** Actual proof E2E with an unavailable original interpreter, not a fake oracle. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {checkExecutionProof} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {canonical,sha,validateRequest} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original';
import {NativeFailure,nativeIdentity} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';

const arg=(name:string)=>process.argv[process.argv.indexOf(name)+1];
const evidence=arg('--evidence'),input=arg('--input');
if(!evidence||!input||!isAbsolute(evidence)||!isAbsolute(input))throw Error('Z4_ABSOLUTE_E2E_INPUT_AND_EVIDENCE_REQUIRED');
await mkdir(evidence,{recursive:false,mode:0o700});
const rows:Array<Record<string,unknown>>=[];
const report:Record<string,unknown>={schema:'finnor.z4.no-replay-proof-e2e.v1',status:'RUNNING',rows,
 nativeOwner:'NOT_RUN',authenticatedSourceOwner:'NOT_RUN',authenticatedInstalledOwner:'NOT_RUN',
 securityAdmission:'NOT_RUN',protectedAdmission:'NOT_RUN',eligibleReuseN:0};
const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const trap=()=>Number((globalThis as unknown as Record<symbol,unknown>)[Symbol.for('finnor.z4.no-replay-interpreter-trap')]??0);
const limits=()=>({deadlineAt:new Date(Date.now()+180000).toISOString(),maxMemoryBytes:2*1024**3,cpuSeconds:90});
try{
 const bytes=await readFile(input),fixture=JSON.parse(bytes.toString());
 if(fixture.schema!=='finnor.z4.no-replay-public-input.v1'||fixture.classification!=='PUBLIC_BUILDER_AUTHORED_NOT_PROTECTED'||
  canonical(fixture.expectedFinal)!==canonical(['618']))throw Error('Z4_NO_REPLAY_PUBLIC_ORACLE_REQUIRED');
 const request=validateRequest(fixture.request),candidate=fixture.candidate;
 report.inputSha256=sha(bytes);report.identity=await nativeIdentity();report.request=request;
 report.candidate=candidate;report.expectedFinal=fixture.expectedFinal;
 let active=false;
 try{originalExecution(request);}catch(error){active=(error as Error).message==='Z4_NO_REPLAY_INTERPRETER_TRAP_CALLED';}
 if(!active||trap()!==1)throw Error('Z4_NO_REPLAY_FAULT_LOADER_NOT_ACTIVE');
 report.interpreterTrapExercised=true;
 const checked=await checkExecutionProof(request,candidate,limits());
 if(trap()!==1||canonical(checked.statement.finalState)!==canonical(fixture.expectedFinal)||
  checked.verifier.data.status!=='VERIFIED_COMPUTATION_ONLY'||checked.executionAuthorityGranted!==false)
  throw Error('Z4_NO_REPLAY_VALID_PROOF_CONTRACT');
 const observed=checked as unknown as Record<string,unknown>;
 if(observed.originalExecutionReplayed!==false||observed.verificationMode!=='ORIGINAL_RELATION_AND_INPUT_COMMITMENT_THEN_PINNED_PROOF')
  throw Error('Z4_NO_REPLAY_RESULT_SCOPE_REQUIRED');
 report.checked=checked;
 rows.push({name:'valid-real-proof-with-interpreter-trap',status:'PASSED',extraInterpreterCalls:trap()-1});
 const negatives:Array<[string,string[],(r:typeof request,c:typeof candidate)=>void]>=[
  ['wrong-output',['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH'],(_r,c)=>{c.statement.finalState[0]='619';}],
  ['wrong-relation',['Z4_ORIGINAL_STATEMENT_MISMATCH'],(_r,c)=>{c.statement.program.instructions[0].b={const:'12'};}],
  ['wrong-initial',['Z4_ORIGINAL_STATEMENT_MISMATCH'],(_r,c)=>{c.statement.initial[0]='6';}],
  ['wrong-length',['Z4_ORIGINAL_STATEMENT_MISMATCH'],(_r,c)=>{c.statement.steps=1;}],
  ['wrong-input-commitment',['Z4_ORIGINAL_STATEMENT_MISMATCH'],(_r,c)=>{c.statement.inputCommitment='0'.repeat(64);}],
  ['changed-original-inputs',['Z4_ORIGINAL_STATEMENT_MISMATCH'],(r)=>{r.inputs[0]![0]='2';}],
  ['wrong-parameter',['Z4_PARAMETER_IDENTITY'],(_r,c)=>{c.artifact.parameterHash='0'.repeat(64);}],
 ];
 for(const [name,expected,mutate] of negatives){
  const r=structuredClone(request),c=structuredClone(candidate);mutate(r,c);
  let refusal:string|undefined,meters:unknown;
  try{await checkExecutionProof(r,c,limits());}catch(error){
   refusal=(error as Error).message;if(error instanceof NativeFailure)meters=error.meters;
  }
  const status=refusal&&expected.includes(refusal)&&trap()===1?'PASSED_NAMED_REFUSAL':'FAILED';
  rows.push({name,expected,observed:refusal??'ACCEPTED',status,meters,extraInterpreterCalls:trap()-1});
  if(status==='FAILED')throw Error('Z4_NO_REPLAY_CRITICAL_FALSE_RELATION:'+name);
  await save();
 }
 report.originalVmCallsDuringVerification=trap()-1;
 report.status='PASSED_NO_REPLAY_NATIVE_PROOF_E2E_ONLY';await save();
}catch(error){
 report.status='FAILED_NO_REPLAY_CONTRACT';report.failure=(error as Error).message;
 report.observedInterpreterCalls=trap();await save();process.exitCode=1;
}
console.log(JSON.stringify({status:report.status,evidence,failure:report.failure??null,rows:rows.length}));
