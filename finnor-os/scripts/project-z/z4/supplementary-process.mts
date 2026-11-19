/** Supplementary public process E2E. Never confers owner/protected admission. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical,validateRequest,type ExactRequest} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original';
import {checkCorrespondence} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/correspondence';
import {produceExecutionProof,checkExecutionProof,type ProofProduction} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {nativeIdentity,runNative,NativeFailure,type NativeReceipt} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';

const here=dirname(fileURLToPath(import.meta.url));
const arg=(name:string)=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const evidence=arg('--evidence'),family=arg('--family'),deadlineAt=arg('--deadline');
if(!evidence?.startsWith('/')||!family||!deadlineAt||!Number.isFinite(Date.parse(deadlineAt)))throw Error('Z4_SUPPLEMENT_ARGUMENTS');
interface Case {id:string;family:string;request:ExactRequest;expectedFinal:string[]}
interface Negative {id:string;request:ExactRequest;expectedRefusals:string[];
 expectedOriginalRefusals?:string[];expectedOriginalSchemaPath?:Array<string|number>}
interface Registry {schema:string;cases:Case[];negativeObligations:Negative[];proofRepresentatives:string[];positiveDenominator:number;frozenV1Sha256:string}
const raw=await readFile(resolve(here,'supplementary-positive.v3.json'));
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const registration=hash(raw);
if(registration!=='4479bce31a46945067d88b262bcb549040c20d91b2dc57e788e6b335bda4f163')throw Error('Z4_SUPPLEMENT_FROZEN_REGISTRATION_CHANGED');
const frozen=JSON.parse(raw.toString()) as Registry;
if(hash(await readFile(resolve(here,'public-cases.pre-code.json')))!==frozen.frozenV1Sha256)
 throw Error('Z4_SUPPLEMENT_ORIGINAL_REGISTRY_CHANGED');
const negativeV4=family==='negative-obligations-v4';
const negativeFamily=negativeV4||family==='negative-obligations';
let negativeCases=frozen.negativeObligations,negativeRegistration:string|null=null;
if(negativeV4){
 const negativeRaw=await readFile(resolve(here,'supplementary-negatives.v4.json'));
 negativeRegistration=hash(negativeRaw);
 if(negativeRegistration!=='8b88a2ad27212242e921446f11a53179682862cb07707ad149f94a3cf2d46ee1')
  throw Error('Z4_SUPPLEMENT_FROZEN_NEGATIVE_REGISTRATION_CHANGED');
 const registry=JSON.parse(negativeRaw.toString()) as {schema:string;positiveParentSha256:string;
  negativeDenominator:number;negativeObligations:Negative[]};
 if(registry.schema!=='finnor.z4.supplementary-negative-obligations.v4'||registry.positiveParentSha256!==registration
  ||registry.negativeDenominator!==12||registry.negativeObligations.length!==12)
  throw Error('Z4_SUPPLEMENT_NEGATIVE_REGISTRATION_DOMAIN');
 negativeCases=registry.negativeObligations;
}
await mkdir(evidence,{recursive:false,mode:0o700});
const cases=frozen.cases.filter(c=>c.family===family);
if(!negativeFamily&&cases.length!==8)throw Error('Z4_SUPPLEMENT_FAMILY_DENOMINATOR');
const rows:Array<Record<string,unknown>>=cases.map(c=>({id:c.id,kind:'useful-positive',status:'NOT_RUN',proofStatus:'NOT_RUN'}));
const report:Record<string,unknown>={schema:negativeV4?'finnor.z4.supplementary-process-e2e.v4':'finnor.z4.supplementary-process-e2e.v3',
 family,registrationSha256:registration,negativeRegistrationSha256:negativeRegistration,
 negativeDenominator:negativeFamily?negativeCases.length:0,
 status:'RUNNING',positiveDenominator:cases.length,rows,nativeOwner:'NOT_RUN',protectedAdmission:'NOT_RUN',eligibleReuseN:0,
 installedAcceptance:'NOT_RUN',physicalAuthenticatedRecovery:'NOT_RUN',executionAuthorityGranted:false,
 securityAdmission:'NOT_RUN',aggregateRSS:null,usd:null,humanSeconds:null};
const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const receipt=(p:NativeReceipt)=>({operation:p.operation,meters:p.meters,binarySha256:p.binarySha256,sourceDigest:p.sourceDigest});
const limits=()=>({deadlineAt,maxMemoryBytes:2*1024**3,cpuSeconds:(op:string)=>op==='prove'?180:op==='verify'?60:10});
type Candidate=Pick<ProofProduction,'statement'|'artifact'>;
async function rejects(name:string,action:()=>Promise<unknown>,expected:string[]){
 try{await action();}
 catch(error){
  const code=(error as Error).message;
  if(!expected.includes(code))throw error;
  return {name,expected,observed:code,status:'REJECTED_NAMED_FALSIFIER',
   meters:error instanceof NativeFailure?error.meters:null,
   physical:error instanceof NativeFailure?error.physical:null};
 }
 throw Error('Z4_SUPPLEMENT_FALSE_CANDIDATE_ACCEPTED:'+name);
}
function mutations(base:Candidate){
 const result:Array<{name:string;candidate:Candidate;expected:string[]}>=[];
 const add=(name:string,change:(c:Candidate)=>void,expected:string[])=>{
  const candidate=structuredClone(base);change(candidate);result.push({name,candidate,expected});
 };
 add('wrong-output',c=>{c.statement.finalState[0]=String(BigInt(c.statement.finalState[0]!)+1n);},['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH']);
 add('wrong-initial',c=>{c.statement.initial[0]=String(BigInt(c.statement.initial[0]!)+1n);},['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED']);
 add('wrong-input-commitment',c=>{
  const s=c.statement.inputCommitment;c.statement.inputCommitment=(parseInt(s.slice(0,2),16)^1).toString(16).padStart(2,'0')+s.slice(2);
 },['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH']);
 add('wrong-counter-length',c=>{c.statement.steps=c.statement.steps===1?2:1;},['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED']);
 add('changed-code-or-constant',c=>{
  const operand=c.statement.program.instructions.flatMap(i=>[i.a,i.b]).find(o=>'const'in o);
  if(operand&&'const'in operand)operand.const=String(BigInt(operand.const)+1n);
  else{const i=c.statement.program.instructions[0]!;i.op=i.op==='mul'?'add':'sub';}
 },['Z4_RELATION_CHANGED']);
 add('changed-unused-register-type',c=>{c.statement.program.registers[6]!.type='bool';},['Z4_RELATION_CHANGED']);
 add('changed-unused-register-unit',c=>{c.statement.program.registers[6]!.unit='USD_cent';},['Z4_RELATION_CHANGED']);
 add('changed-context-binding',c=>{const b=c.statement.binding;c.statement.binding=(b[0]==='0'?'1':'0')+b.slice(1);},['Z4_RELATION_CHANGED']);
 add('changed-parameters',c=>{const p=c.artifact.parameterHash;c.artifact.parameterHash=(p[0]==='0'?'1':'0')+p.slice(1);},['Z4_PARAMETER_IDENTITY']);
 return result;
}
try{
 report.identity=await nativeIdentity();report.node={version:process.version,executable:process.execPath};
 await save();
 for(let n=0;n<cases.length;n++){
  const c=cases[n]!,row=rows[n]!;row.status='RUNNING';row.request=c.request;row.expectedFinal=c.expectedFinal;
  await save();
  const request=validateRequest(c.request),original=originalExecution(request);
  const interpreted=await runNative<{finalState:string[]}>('interpret',request,limits());
  if(canonical(original.finalState)!==canonical(c.expectedFinal)||canonical(interpreted.data.finalState)!==canonical(c.expectedFinal))
   throw Error('Z4_SUPPLEMENT_FROZEN_EQUATION_MISMATCH:'+c.id);
  const plan=await runNative('plan',request,limits());
  const correspondence=checkCorrespondence(request.program,request.binding,plan.data);
  await writeFile(resolve(evidence,`case-${n}.native-plan.json`),canonical(plan.data)+'\n',{mode:0o600,flag:'wx'});
  row.original=original;row.observedFinal=interpreted.data.finalState;row.correspondence=correspondence;
  row.processes=[receipt(interpreted),receipt(plan)];row.status='PASSED_ORIGINAL_AND_PLAN_ONLY';
  if(frozen.proofRepresentatives.includes(c.id)){
   if(Date.now()+120000>=Date.parse(deadlineAt)){row.proofStatus='NOT_RUN_REMAINING_WALL';await save();continue;}
   row.proofStatus='RUNNING';await save();
   const checked=await produceExecutionProof(request,limits());
   if(canonical(checked.statement.finalState)!==canonical(c.expectedFinal))throw Error('Z4_SUPPLEMENT_PROOF_ORACLE_MISMATCH');
   await writeFile(resolve(evidence,`case-${n}.checked.json`),canonical(checked)+'\n',{mode:0o600,flag:'wx'});
   const audited=await checkExecutionProof(request,{statement:checked.statement,artifact:checked.artifact},limits());
   row.proofStatus='PASSED_PINNED_PROOF_AND_SEPARATE_AUDIT';row.proofBytes=checked.artifact.proofHex.length/2;
   row.proofProcesses=checked.processes.map(receipt);row.auditProcesses=audited.processes.map(receipt);
   row.constraintTranslation='ACTUALLY_SYNTHESIZED_BY_UNCHANGED_PROOF_RS_FOR_THIS_INSTANCE_NOT_A_THEOREM';
   row.originalExecutionReplayedByVerifier=audited.originalExecutionReplayed;
   row.mutations=[];
   for(const m of mutations({statement:checked.statement,artifact:checked.artifact})){
    await writeFile(resolve(evidence,`case-${n}.${m.name}.json`),canonical(m.candidate)+'\n',{mode:0o600,flag:'wx'});
    const observation=await rejects(m.name,()=>runNative('verify',m.candidate,limits()),m.expected);
    (row.mutations as unknown[]).push(observation);await save();
   }
   const changedInput=structuredClone(request);changedInput.inputs[0]![0]=String(BigInt(changedInput.inputs[0]![0]!)+1n);
   (row.mutations as unknown[]).push(await rejects('changed-original-input',
    ()=>checkExecutionProof(changedInput,{statement:checked.statement,artifact:checked.artifact},limits()),['Z4_ORIGINAL_STATEMENT_MISMATCH']));
   const changedPlan=structuredClone(plan.data) as {outputs:string[]};
   changedPlan.outputs[8]='z8';
   let planRejected=false;
   try{checkCorrespondence(request.program,request.binding,changedPlan);}
   catch(error){planRejected=(error as Error).message==='Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED';}
   if(!planRejected)throw Error('Z4_SUPPLEMENT_COUNTER_IMAGE_MUTATION_ACCEPTED');
   row.counterImageMutation='REJECTED_EXACT_CONSTRAINT_IMAGE';
  }
  await save();
 }
 if(negativeFamily){
  const negatives:Array<Record<string,unknown>>=[];report.negatives=negatives;
  for(const c of negativeCases){
   let originalRejected=false,originalError='',originalSchemaReasonMatched=false;
   try{originalExecution(c.request);}catch(error){
    originalRejected=true;originalError=error instanceof Error?error.message:'NON_ERROR_THROWN';
    if(error instanceof Error&&error.name==='ZodError'&&'issues'in error&&Array.isArray(error.issues)
     &&c.expectedOriginalSchemaPath){
     originalSchemaReasonMatched=error.issues.some((issue:unknown)=>issue!==null&&typeof issue==='object'
      &&'path'in issue&&canonical(issue.path)===canonical(c.expectedOriginalSchemaPath));
    }
   }
   if(!originalRejected)throw Error('Z4_SUPPLEMENT_ORIGINAL_NEGATIVE_ACCEPTED:'+c.id);
   const originalReasonMatched=Boolean(c.expectedOriginalRefusals?.includes(originalError)||originalSchemaReasonMatched);
   if(negativeV4&&!originalReasonMatched)throw Error('Z4_SUPPLEMENT_ORIGINAL_NEGATIVE_REASON_MISMATCH:'+c.id);
   const native=await rejects(c.id,()=>runNative('interpret',c.request,limits()),c.expectedRefusals);
   negatives.push({id:c.id,request:c.request,originalRejected,originalError,originalReasonMatched,native});await save();
  }
 }
 report.positivePassed=rows.filter(r=>r.status==='PASSED_ORIGINAL_AND_PLAN_ONLY').length;
 report.proofPassed=rows.filter(r=>r.proofStatus==='PASSED_PINNED_PROOF_AND_SEPARATE_AUDIT').length;
 report.proofNotRun=rows.filter(r=>String(r.proofStatus).startsWith('NOT_RUN')).length;
 report.status='PASSED_BOUNDED_PUBLIC_PROCESS_ONLY';
 await save();console.log(JSON.stringify({family,status:report.status,positives:report.positivePassed,proofs:report.proofPassed}));
}catch(error){
 report.status='FAILED_STOPPED_NO_RETRY';report.error=(error as Error).message;
 if(error instanceof NativeFailure){report.failureMeters=error.meters;report.physical=error.physical;}
 await save();process.exitCode=1;console.error(JSON.stringify({family,status:report.status,error:report.error}));
}
