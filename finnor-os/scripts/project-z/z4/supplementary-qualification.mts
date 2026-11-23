/** Public preparation/reference CLI and coordinator-bound qualification API.
 * Standalone commands never launch native code or infer execution authority. */
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical,sha,type ExactRequest} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original';
import {fullCostCrossover,measureExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/costs';
import {assertBoundQualificationAttempt,executeFreshQualification,publicProofSchedule,protectedDefinitionShape,releaseProtectedDefinitions,
 type CompilerFreeze,type QualificationHost,type ProtectedDefinitionSource} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/qualification';

const here=dirname(fileURLToPath(import.meta.url));
const POSITIVE='4479bce31a46945067d88b262bcb549040c20d91b2dc57e788e6b335bda4f163';
const NEGATIVE='8b88a2ad27212242e921446f11a53179682862cb07707ad149f94a3cf2d46ee1';
const OLD='3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function boundedInput(path:string){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=await f.stat();if(!s.isFile()||s.size>8*1024**2)throw Error('Z4_SUPPLEMENT_INPUT_BOUND');
  const raw=await f.readFile();if(raw.length>8*1024**2)throw Error('Z4_SUPPLEMENT_INPUT_BOUND');
  return {body:JSON.parse(raw.toString()) as Record<string,unknown>,sha256:hash(raw)};
 }finally{await f.close();}
}
async function frozenInputs(){
 const raw=await readFile(resolve(here,'supplementary-positive.v3.json'));
 if(hash(raw)!==POSITIVE||hash(await readFile(resolve(here,'public-cases.pre-code.json')))!==OLD)
  throw Error('Z4_SUPPLEMENT_FROZEN_REGISTRATION_CHANGED');
 return JSON.parse(raw.toString()) as unknown;
}
export async function prepareSupplementary(compiler:CompilerFreeze){
 return publicProofSchedule(await frozenInputs(),compiler);
}
/** Existing native host supplies its real original case, S5 limits and durable
 * consumed-attempt accounting. No grant, queue or owner is created here. */
export async function runBoundSupplementary(compiler:CompilerFreeze,host:QualificationHost,caseId?:string){
 const schedule=await prepareSupplementary(compiler);
 if(caseId){
  const selected=schedule.cases.filter(c=>c.id===caseId);
  if(selected.length!==1)throw Error('Z4_QUALIFICATION_CASE_SELECTION');
  return executeFreshQualification({...schedule,cases:selected},host);
 }
 return executeFreshQualification(schedule,host);
}
export async function prepareProtectedSupplementary(compiler:CompilerFreeze,source:ProtectedDefinitionSource){
 const publicSchedule=await prepareSupplementary(compiler);
 return releaseProtectedDefinitions(source,compiler,publicSchedule.cases);
}
export async function runBoundProtectedSupplementary(compiler:CompilerFreeze,source:ProtectedDefinitionSource,
 host:QualificationHost,caseId?:string){
 const schedule=await prepareProtectedSupplementary(compiler,source);
 if(!caseId)return executeFreshQualification(schedule,host);
 const cases=schedule.cases.filter(c=>c.id===caseId);
 if(cases.length!==1)throw Error('Z4_QUALIFICATION_CASE_SELECTION');
 return executeFreshQualification({...schedule,cases},host);
}
/** Keep the coordinator's versioned twelve exact negative predicates. */
export async function runBoundSupplementaryNegatives(compiler:CompilerFreeze,host:QualificationHost){
 const schedule=await prepareSupplementary(compiler),raw=await readFile(resolve(here,'supplementary-negatives.v4.json'));
 if(hash(raw)!==NEGATIVE)throw Error('Z4_SUPPLEMENT_FROZEN_NEGATIVE_REGISTRATION_CHANGED');
 const registry=JSON.parse(raw.toString()) as {positiveParentSha256:string;negativeDenominator:number;
  negativeObligations:Array<{id:string;request:ExactRequest;expectedRefusals:string[];
   expectedOriginalRefusals:string[];expectedOriginalSchemaPath?:Array<string|number>}>};
 if(registry.positiveParentSha256!==POSITIVE||registry.negativeDenominator!==12||registry.negativeObligations.length!==12)
  throw Error('Z4_SUPPLEMENT_NEGATIVE_REGISTRATION_DOMAIN');
 const results:Array<Record<string,unknown>>=[],attempts=new Set<string>();
 for(const c of registry.negativeObligations){
  let attemptId:string|null=null;
  try{
  const selected={id:c.id,family:'negative-obligations-v4',request:c.request,expectedFinal:[]};
  const b=await host.claim(selected,schedule);assertBoundQualificationAttempt(b,selected,schedule);
  attemptId=b.attemptId;
  if(attempts.has(attemptId))throw Error('Z4_QUALIFICATION_ATTEMPT_REUSED');
  attempts.add(attemptId);
  await host.retain({id:c.id,attemptId,status:'STARTED_NEGATIVE',requestDigest:b.requestDigest,
   compilerDigest:b.compilerDigest,targetDigest:b.targetDigest,ownerBindingDigest:b.ownerBindingDigest,
   originalReservationDigest:b.originalReservationDigest,originalDeadlineAt:b.originalDeadlineAt});
  if(await host.currentCompilerDigest()!==compiler.digest||!await b.limits.current!())throw Error('Z4_QUALIFICATION_SOURCE_OR_OWNER_CHANGED');
  let originalError='',schemaMatched=false;
  try{originalExecution(c.request);throw Error('Z4_SUPPLEMENT_ORIGINAL_NEGATIVE_ACCEPTED');}
  catch(error){
   originalError=(error as Error).message;
   if(error instanceof Error&&error.name==='ZodError'&&'issues'in error&&Array.isArray(error.issues)&&c.expectedOriginalSchemaPath)
    schemaMatched=error.issues.some((issue:unknown)=>issue!==null&&typeof issue==='object'&&'path'in issue&&canonical(issue.path)===canonical(c.expectedOriginalSchemaPath));
  }
  if(!c.expectedOriginalRefusals.includes(originalError)&&!schemaMatched)throw Error('Z4_SUPPLEMENT_ORIGINAL_NEGATIVE_REASON_MISMATCH');
  const {runNative,NativeFailure}=await import('../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native');
  let predicate='',failureObservation:Record<string,unknown>|null=null;
  try{
   await runNative('interpret',c.request,{...b.limits,
    deadlineAt:new Date(Math.min(Date.parse(b.originalDeadlineAt),Date.now()+600000)).toISOString(),
    current:async()=>await b.limits.current!()&&await host.currentCompilerDigest()===compiler.digest});
  }catch(error){
   if(error instanceof NativeFailure&&c.expectedRefusals.includes(error.message)){
    predicate=error.message;failureObservation={meters:error.meters,physical:error.physical??null};
   }else throw error;
  }
  if(!predicate)throw Error('Z4_SUPPLEMENT_FALSE_CANDIDATE_ACCEPTED');
  const row={id:c.id,attemptId:b.attemptId,status:'REJECTED_NAMED_FALSIFIER',request:c.request,
   originalError,originalSchemaReasonMatched:schemaMatched,expectedPredicates:c.expectedRefusals,predicate,failureObservation};
  await host.retain(row);results.push(row);
  }catch(error){
   await host.retain({id:c.id,attemptId,status:'FAILED_STOPPED_NO_RETRY',error:(error as Error).message,
    completedIds:results.map(r=>r.id),budgetReset:false});
   throw error;
  }
 }
 return {negativeDenominator:12,results,protectedAdmission:'NOT_RUN',eligibleReuseN:0};
}

async function cli(){
 const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
 const evidence=arg('--evidence'),mode=arg('--mode')??'prepare',input=arg('--input'),family=arg('--family'),caseId=arg('--case-id');
 if(!evidence?.startsWith('/'))throw Error('Z4_SUPPLEMENT_ABSOLUTE_EVIDENCE_REQUIRED');
 await mkdir(evidence,{recursive:false,mode:0o700});
 const report:Record<string,unknown>={schema:'finnor.z4.supplementary-source-process.v5',mode,status:'RUNNING',
  registrationSha256:POSITIVE,positiveDenominator:256,selectedFreshProofs:256,positivePassed:0,proofPassed:0,proofNotRun:256,
  nativeExecutions:0,retainedProofsImported:false,protectedAdmission:'NOT_RUN',nativeOwner:'NOT_RUN',
  eligibleReuseN:0,executionAuthorityGranted:false,securityAdmission:'NOT_RUN',usd:null,humanSeconds:null,
  startedAt:new Date().toISOString()};
 const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 try{
  const raw=await frozenInputs();
  const runtime='../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/';
  const native='../../../packages/epistemic-runtime/native/z4-execution-proof/';
  const files=['contracts.ts','original.ts','correspondence.ts','engine.ts','qualification.ts','costs.ts',
   'native.ts','process-groups.ts','runtime-paths.ts'].map(name=>runtime+name);
  files.push(...['src/main.rs','src/model.rs','src/plan.rs','src/proof.rs','src/field_falsifier.rs',
   'Cargo.toml','Cargo.lock','rust-toolchain.toml','supervise.py','build-identity.json','bin/z4-proof','bin/z4-field-falsifier'].map(name=>native+name));
  const source=await Promise.all(files.map(async name=>({name,sha256:hash(await readFile(resolve(here,name)))})));
  const compiler={digest:sha(source),frozenAt:new Date().toISOString()},schedule=publicProofSchedule(raw,compiler);
  report.compiler=compiler;report.compilerSource=source;
  const selected=schedule.cases.filter(c=>(!family||c.family===family)&&(!caseId||c.id===caseId));
  if(!selected.length)throw Error('Z4_QUALIFICATION_CASE_SELECTION');
  report.selectedCases=selected.length;
  const rows:Array<Record<string,unknown>>=selected.map(c=>({id:c.id,family:c.family,requestDigest:sha(c.request),
   status:'NOT_RUN',proofStatus:'NOT_RUN',proofRequired:true}));
  report.rows=rows;await save();
  if(mode==='prepare'){
   await writeFile(resolve(evidence,'fresh-proof-schedule.json'),canonical(schedule)+'\n',{flag:'wx',mode:0o600});
   report.status='PREPARED_FRESH_PROOFS_NOT_RUN';
  }else if(mode==='original'){
   await measureExecution('independent-original-public-population',async()=>{
    for(const [n,c] of selected.entries()){
     const original=originalExecution(c.request);
     if(canonical(original.finalState)!==canonical(c.expectedFinal))throw Error('Z4_SUPPLEMENT_FROZEN_EQUATION_MISMATCH:'+c.id);
     Object.assign(rows[n]!,{status:'PASSED_ORIGINAL_ONLY_NOT_PROOF',request:c.request,
      expectedFinal:c.expectedFinal,observedFinal:original.finalState,original});
    }
   },async interval=>{report.originalInterval=interval;});
   report.positivePassed=selected.length;report.status='PASSED_ORIGINAL_ONLY_NOT_PROOF';
  }else if(mode==='cost'||mode==='protected-shape'||mode==='protected-custody'){
   if(!input?.startsWith('/'))throw Error('Z4_SUPPLEMENT_ABSOLUTE_INPUT_REQUIRED');
   const payload=await boundedInput(input),body=payload.body;
   report.inputSha256=payload.sha256;
   if(mode==='cost')Object.assign(report,fullCostCrossover(body),{status:'COMPUTED_RECORD_ARITHMETIC_NOT_ACCEPTANCE'});
   else if(mode==='protected-shape'){
    const shape=protectedDefinitionShape(body,schedule.cases);
    report.functionDefinitions=shape.definitions.length;report.status='CHECKED_SHAPE_NOT_PROTECTED_ADMISSION';
   }else{
    const r=body as unknown as ProtectedDefinitionSource;
    await releaseProtectedDefinitions({compiler:r.compiler,release:r.release,verifyRelease:async()=>false,
     reveal:async()=>{throw Error('Z4_CUSTODY_REFUSED_BEFORE_REVEAL');}},r.compiler,schedule.cases);
   }
  }else throw Error('Z4_NATIVE_COORDINATOR_BOUND_HOST_REQUIRED');
  report.endedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({mode,status:report.status,positivePassed:report.positivePassed,proofPassed:0,nativeExecutions:0}));
 }catch(error){
  report.status='FAILED_STOPPED_NO_RETRY';report.error=(error as Error).message;await save();process.exitCode=1;
  console.error(JSON.stringify({mode,status:report.status,error:report.error}));
 }
}
// Importing the bound API does not start a CLI, read credentials or spawn.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await cli();
