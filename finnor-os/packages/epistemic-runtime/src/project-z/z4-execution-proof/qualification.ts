import {z} from 'zod';
import {BACKEND,COMPILER,PROFILE,assertStatement,canonical,digestSchema,fail,sha,validateProgram,validateRequest,
 type ExactRequest,type ProofArtifact,type Statement} from './contracts';
import {originalExecution} from './original';
import {checkCorrespondence} from './correspondence';
import {measureExecution,type ExecutionInterval} from './costs';
import type {ExecutionLimits} from './engine';

export interface QualificationCase {id:string;family:string;request:ExactRequest;expectedFinal:string[]}
export interface CompilerFreeze {digest:string;frozenAt:string}
export interface QualificationSchedule {
 schema:'finnor.z4.fresh-proof-schedule.v1';kind:'PUBLIC'|'CUSTODIAN_RELEASED';
 compiler:CompilerFreeze;registrationDigest:string;cases:QualificationCase[];
 selectedFreshProofs:number;proofPassed:0;retainedProofsImported:false;protectedAdmission:'NOT_RUN';
}
function definition(raw:unknown):QualificationCase{
 const c=raw as QualificationCase;
 if(!c||typeof c.id!=='string'||!c.id||typeof c.family!=='string')fail('Z4_QUALIFICATION_CASE_ID');
 const request=validateRequest(c.request);
 assertStatement({profile:PROFILE,backend:BACKEND,compiler:COMPILER,program:request.program,binding:request.binding,
  initial:request.initial,finalState:c.expectedFinal,steps:request.inputs.length,inputCommitment:'0'.repeat(64)});
 return {id:c.id,family:c.family,request,expectedFinal:c.expectedFinal};
}
function freeze(raw:CompilerFreeze){
 digestSchema.parse(raw.digest);
 if(!Number.isFinite(Date.parse(raw.frozenAt))||Date.parse(raw.frozenAt)>Date.now())fail('Z4_WITHHELD_COMPILER_NOT_FROZEN');
 return raw;
}
export function publicProofSchedule(raw:unknown,compiler:CompilerFreeze):QualificationSchedule{
 const r=raw as {cases:unknown[];positiveDenominator:number};
 if(!r||!Array.isArray(r.cases))fail('Z4_QUALIFICATION_PUBLIC_DENOMINATOR');
 const cases=r.cases.map(definition);
 const families=new Map<string,number>(),ids=new Set<string>(),requests=new Set<string>();
 for(const c of cases){
  if(ids.has(c.id)||requests.has(sha(c.request)))fail('Z4_QUALIFICATION_DUPLICATE_CASE');
  ids.add(c.id);requests.add(sha(c.request));families.set(c.family,(families.get(c.family)??0)+1);
 }
 if(r.positiveDenominator!==256||cases.length!==256||families.size!==32||[...families.values()].some(n=>n!==8))
  fail('Z4_QUALIFICATION_PUBLIC_DENOMINATOR');
 return {schema:'finnor.z4.fresh-proof-schedule.v1',kind:'PUBLIC',compiler:freeze(compiler),registrationDigest:sha(raw),
  cases,selectedFreshProofs:cases.length,proofPassed:0,retainedProofsImported:false,protectedAdmission:'NOT_RUN'};
}
const releaseSchema=z.object({custodianDigest:digestSchema,receiptDigest:digestSchema,
 revealedAt:z.string().datetime({offset:true}),definitionsDigest:digestSchema}).strict();
const frozenSchema=z.object({digest:digestSchema,frozenAt:z.string().datetime({offset:true})}).strict();
const protectedSchema=z.object({schema:z.literal('finnor.z4.protected-definitions.v1'),compiler:frozenSchema,
 release:releaseSchema,definitions:z.array(z.unknown()).max(4096)}).strict();

/** Shape checks are public equipment, not proof of independent custody. */
export function protectedDefinitionShape(raw:unknown,publicDefinitions:readonly QualificationCase[]){
 const r=protectedSchema.parse(raw);
 if(Date.parse(r.release.revealedAt)<=Date.parse(r.compiler.frozenAt)||Date.parse(r.release.revealedAt)>Date.now())
  fail('Z4_WITHHELD_COMPILER_NOT_FROZEN');
 if(r.definitions.length<40)fail('Z4_WITHHELD_COUNT');
 const known=new Set(publicDefinitions.map(c=>sha(c.request.program))),seen=new Set<string>(),ids=new Set<string>();
 const definitions=r.definitions.map(value=>{
  const c=definition(value),digest=sha(c.request.program);
  if(known.has(digest))fail('Z4_WITHHELD_PUBLIC_FUNCTION');
  if(seen.has(digest)||ids.has(c.id))fail('Z4_WITHHELD_DUPLICATE_FUNCTION');
  seen.add(digest);ids.add(c.id);return c;
 });
 return {compiler:r.compiler,release:r.release,definitions,protectedAdmission:'NOT_RUN' as const,
  custody:'NOT_VERIFIED_BY_SHAPE_CHECK' as const};
}
export interface ProtectedDefinitionSource {
 compiler:CompilerFreeze;release:z.infer<typeof releaseSchema>;
 /** Legacy shape only. No such trusted S8 release verifier is installed here;
  * a caller callback cannot unlock the native release boundary. */
 verifyRelease:(freeze:CompilerFreeze,release:z.infer<typeof releaseSchema>)=>Promise<boolean>;
 reveal:()=>Promise<unknown[]>;
}
export async function releaseProtectedDefinitions(source:ProtectedDefinitionSource,compiler:CompilerFreeze,
 publicDefinitions:readonly QualificationCase[]):Promise<QualificationSchedule>{
 freeze(compiler);const release=releaseSchema.parse(source.release);
 if(canonical(source.compiler)!==canonical(compiler)||Date.parse(release.revealedAt)<=Date.parse(compiler.frozenAt)||
  Date.parse(release.revealedAt)>Date.now())
  fail('Z4_WITHHELD_COMPILER_NOT_FROZEN');
 // The existing source-custody package binds local module bytes, not an
 // independently authenticated withheld-function admission/release. Until
 // that real S8 contract is wired, neither a supplied true nor reveal may run.
 void publicDefinitions;
 return fail('Z4_WITHHELD_INDEPENDENT_CUSTODY_REQUIRED');
}

type Candidate={statement:Statement;artifact:ProofArtifact};
const alternative=(s:string,bool=false)=>bool?(s==='0'?'1':'0'):String(BigInt(s)===(1n<<63n)-1n?BigInt(s)-1n:BigInt(s)+1n);
export function criticalProofMutations(base:Candidate){
 const result:Array<{name:string;candidate:Candidate;expected:string[]}>=[];
 const add=(name:string,change:(c:Candidate)=>void,expected:string[],program=false)=>{
  const candidate=structuredClone(base);change(candidate);
  if(program){
   try{validateProgram(candidate.statement.program);}
   catch(error){
    const code=(error as Error).message;
    if(!/^Z4_[A-Z0-9_]+$/.test(code))throw error;
    expected=[code]; // Independently predicted static integer guard, not an observed verifier result.
   }
  }
  result.push({name,candidate,expected});
 };
 add('wrong-output',c=>{c.statement.finalState[0]=alternative(c.statement.finalState[0]!,c.statement.program.registers[0]!.type==='bool');},
  ['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH']);
 add('wrong-initial',c=>{c.statement.initial[0]=alternative(c.statement.initial[0]!,c.statement.program.registers[0]!.type==='bool');},
  ['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED']);
 add('wrong-input-commitment',c=>{
  const s=c.statement.inputCommitment;c.statement.inputCommitment=(parseInt(s.slice(0,2),16)^1).toString(16).padStart(2,'0')+s.slice(2);
 },['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH']);
 add('wrong-counter-length',c=>{c.statement.steps=c.statement.steps===1?2:1;},['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED']);
 add('changed-code-or-constant',c=>{
  const operand=c.statement.program.instructions.flatMap(i=>[i.a,i.b]).find(o=>'const'in o);
  if(operand&&'const'in operand)operand.const=alternative(operand.const);
  else{const i=c.statement.program.instructions[0]!;i.op=i.op==='lt'?'eq':i.op==='eq'?'lt':i.op==='add'?'sub':'add';}
 },['Z4_RELATION_CHANGED'],true);
 add('changed-register-type',c=>{const r=c.statement.program.registers[Math.min(6,c.statement.program.registers.length-1)]!;
  r.type=r.type==='bool'?'i64':'bool';},['Z4_RELATION_CHANGED'],true);
 add('changed-register-unit',c=>{const r=c.statement.program.registers[Math.min(6,c.statement.program.registers.length-1)]!;
  r.unit=r.unit==='USD_cent'?'1':'USD_cent';},['Z4_RELATION_CHANGED'],true);
 add('changed-context-binding',c=>{const b=c.statement.binding;c.statement.binding=(b[0]==='0'?'1':'0')+b.slice(1);},['Z4_RELATION_CHANGED']);
 add('changed-parameters',c=>{const p=c.artifact.parameterHash;c.artifact.parameterHash=(p[0]==='0'?'1':'0')+p.slice(1);},['Z4_PARAMETER_IDENTITY']);
 return result;
}

export interface BoundQualificationAttempt {
 attemptId:string;requestDigest:string;compilerDigest:string;targetDigest:string;ownerBindingDigest:string;
 originalReservationDigest:string;originalDeadlineAt:string;limits:ExecutionLimits;
}
export interface QualificationHost {
 /** Actual target/owner integration must consume the EXISTING attempt and S5
  * budget. This interface neither creates an owner nor grants/replenishes it. */
 claim:(c:QualificationCase,schedule:QualificationSchedule)=>Promise<BoundQualificationAttempt>;
 currentCompilerDigest:()=>Promise<string>;
 retain:(row:Record<string,unknown>)=>Promise<void>;
}
export function assertBoundQualificationAttempt(b:BoundQualificationAttempt,c:QualificationCase,s:QualificationSchedule){
 for(const v of [b.attemptId,b.targetDigest,b.ownerBindingDigest,b.originalReservationDigest])digestSchema.parse(v);
 if(b.requestDigest!==sha(c.request)||b.compilerDigest!==s.compiler.digest)fail('Z4_QUALIFICATION_ORIGINAL_BINDING');
 const limits=b.limits;
 if(limits.deadlineAt!==b.originalDeadlineAt||!Number.isFinite(Date.parse(b.originalDeadlineAt))||
  Date.parse(b.originalDeadlineAt)<=Date.now())fail('Z4_QUALIFICATION_ORIGINAL_DEADLINE');
 if(!limits.current||!limits.charge||!limits.capacity||!limits.observed||!limits.processGroup)fail('Z4_QUALIFICATION_BOUND_S5_LIMITS_REQUIRED');
 if(!Number.isSafeInteger(limits.maxMemoryBytes)||limits.maxMemoryBytes<128*1024**2||limits.maxMemoryBytes>2*1024**3)fail('Z4_PROCESS_MEMORY_BOUND');
 for(const op of ['plan','commit','prove','verify']){
  const cpu=typeof limits.cpuSeconds==='function'?limits.cpuSeconds(op):limits.cpuSeconds;
  if(!Number.isSafeInteger(cpu)||cpu!<1||cpu!>600)fail('Z4_QUALIFICATION_CHILD_BOUND');
 }
}

/** Complete fresh-proof path for the existing coordinator-bound native host.
 * No CLI, credential inference, retained-proof input, fallback or retry. */
export async function executeFreshQualification(schedule:QualificationSchedule,host:QualificationHost){
 const completed:string[]=[],attempts=new Set<string>();
 for(const c of schedule.cases){
  let binding:BoundQualificationAttempt|undefined;
  const intervals:ExecutionInterval[]=[];
  try{
   binding=await host.claim(c,schedule);assertBoundQualificationAttempt(binding,c,schedule);
   const b=binding;
   if(attempts.has(b.attemptId))fail('Z4_QUALIFICATION_ATTEMPT_REUSED');attempts.add(b.attemptId);
   if(await host.currentCompilerDigest()!==schedule.compiler.digest||!await b.limits.current!())fail('Z4_QUALIFICATION_SOURCE_OR_OWNER_CHANGED');
   await host.retain({id:c.id,status:'STARTED',binding:{attemptId:b.attemptId,requestDigest:b.requestDigest,
    compilerDigest:b.compilerDigest,targetDigest:b.targetDigest,ownerBindingDigest:b.ownerBindingDigest,
    originalReservationDigest:b.originalReservationDigest,originalDeadlineAt:b.originalDeadlineAt}});
   const {produceExecutionProof,checkExecutionProof}=await import('./engine');
   const {runNative,NativeFailure}=await import('./native');
   const limits:ExecutionLimits={...b.limits,
    deadlineAt:new Date(Math.min(Date.parse(b.originalDeadlineAt),Date.now()+595000)).toISOString(),
    current:async()=>await b.limits.current!()&&await host.currentCompilerDigest()===schedule.compiler.digest};
   const stage=async<T>(label:string,run:(l:ExecutionLimits)=>Promise<T>)=>
    measureExecution(label,observe=>run({...limits,observed:async r=>{observe(r.meters);await b.limits.observed!(r);}}),
     async interval=>{intervals.push(interval);await host.retain({id:c.id,attemptId:b.attemptId,interval});});
   const original=(await stage('independent-original-reference',async l=>{
    await l.charge!('ORIGINAL_INTEGER_REFERENCE',1);return originalExecution(c.request);
   })).value;
   if(canonical(original.finalState)!==canonical(c.expectedFinal))fail('Z4_QUALIFICATION_ORIGINAL_ORACLE_MISMATCH');
   const produced=await stage('fresh-production',l=>produceExecutionProof(c.request,l)),checked=produced.value;
   if(canonical(checked.statement.finalState)!==canonical(c.expectedFinal))fail('Z4_QUALIFICATION_PROOF_ORACLE_MISMATCH');
   const audit=await stage('separate-full-proof-check',l=>checkExecutionProof(c.request,checked,l));
   if(audit.value.originalExecutionReplayed!==false)fail('Z4_QUALIFICATION_VERIFIER_REPLAY');
   const rejected:Array<{name:string;predicate:string}>=[];
   for(const m of criticalProofMutations(checked)){
    await host.retain({id:c.id,attemptId:b.attemptId,mutation:m.name,candidate:m.candidate,expectedPredicates:m.expected});
    let predicate='';
    try{await stage(m.name,l=>runNative('verify',m.candidate,l));}
    catch(error){if(error instanceof NativeFailure&&m.expected.includes(error.message))predicate=error.message;else throw error;}
    if(!predicate)fail('Z4_QUALIFICATION_FALSE_CANDIDATE_ACCEPTED');
    rejected.push({name:m.name,predicate});
   }
   const changed=structuredClone(c.request),v=BigInt(changed.inputs[0]![0]!);
   changed.inputs[0]![0]=String(v===(1n<<31n)-1n?v-1n:v+1n);
   await host.retain({id:c.id,attemptId:b.attemptId,mutation:'changed-original-input',request:changed,
    expectedPredicates:['Z4_ORIGINAL_STATEMENT_MISMATCH']});
   try{await stage('changed-original-input',l=>checkExecutionProof(changed,checked,l));fail('Z4_QUALIFICATION_CHANGED_INPUT_ACCEPTED');}
   catch(error){if((error as Error).message!=='Z4_ORIGINAL_STATEMENT_MISMATCH')throw error;}
   const plan=structuredClone(checked.processes[0]!.data) as {outputs:string[]};plan.outputs[8]='z8';
   await host.retain({id:c.id,attemptId:b.attemptId,mutation:'counter-plan-image',plan,
    expectedPredicates:['Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED']});
   try{checkCorrespondence(c.request.program,c.request.binding,plan);fail('Z4_QUALIFICATION_COUNTER_IMAGE_ACCEPTED');}
   catch(error){if((error as Error).message!=='Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED')throw error;}
   if(!await limits.current!()||sha(c.request)!==b.requestDigest)fail('Z4_QUALIFICATION_SOURCE_OR_OWNER_CHANGED');
   await host.retain({id:c.id,status:'FRESH_PROOF_AND_SEPARATE_AUDIT_COMPLETE',attemptId:b.attemptId,
    requestDigest:sha(c.request),checked,rejected,changedOriginalInput:'REJECTED',counterImage:'REJECTED',
    intervals,eligibleReuseN:0,protectedAdmission:'NOT_RUN',executionAuthorityGranted:false});
   completed.push(c.id);
  }catch(error){
   await host.retain({id:c.id,status:'FAILED_STOPPED_NO_RETRY',attemptId:binding?.attemptId??null,
    error:(error as Error).message,intervals,completedIds:completed,unvisitedCasesRemain:'NOT_RUN',budgetReset:false});
   throw error;
  }
 }
 return {schema:'finnor.z4.fresh-qualification-result.v1',freshProofs:completed.length,completedIds:completed,
  retainedProofsImported:false,protectedAdmission:'NOT_RUN',eligibleReuseN:0,executionAuthorityGranted:false};
}
