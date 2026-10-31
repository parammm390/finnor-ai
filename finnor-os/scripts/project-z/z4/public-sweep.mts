/** Frozen public process E2E. No DB/Auth/native-owner qualification is implied. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical,sha,validateRequest,type ExactRequest} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original';
import {produceExecutionProof,type CheckedExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {nativeIdentity,runNative,NativeFailure,type NativeReceipt} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const arg=(n:string)=>process.argv[process.argv.indexOf(n)+1];
const evidence=arg('--evidence'),family=arg('--family');
if(!evidence?.startsWith('/')||!family)throw Error('Z4_ABSOLUTE_EVIDENCE_AND_FAMILY_REQUIRED');
await mkdir(evidence,{recursive:false,mode:0o700});
const raw=await readFile(resolve(repository,'scope-z/phase-evidence/z4/public-cases.pre-code.json'));
const registration=createHash('sha256').update(raw).digest('hex');
if(registration!=='3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94')throw Error('Z4_FROZEN_REGISTRATION_CHANGED');
interface Case {id:string;family:string;kind:string;request:Omit<ExactRequest,'binding'>;expectedFinal:string[]}
const frozen=JSON.parse(raw.toString()) as {families:string[];cases:Case[]};
const cases=frozen.cases.filter(c=>c.family===family);
if(!frozen.families.includes(family)||cases.length!==8)throw Error('Z4_FROZEN_FAMILY_DENOMINATOR');
const report:Record<string,unknown>={schema:'finnor.z4.public-family-e2e.v1',family,registrationSha256:registration,
 nativeOwner:false,protectedAdmission:'NOT_RUN',eligibleReuseN:0,executionAuthorityGranted:false,rows:[],status:'RUNNING'};
const rows=report.rows as Array<Record<string,unknown>>;
const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const meters=(p:NativeReceipt)=>({operation:p.operation,meters:p.meters,binarySha256:p.binarySha256,sourceDigest:p.sourceDigest});
const limits=()=>({deadlineAt:new Date(Date.now()+900000).toISOString(),maxMemoryBytes:2*1024*1024*1024,
 cpuSeconds:(op:string)=>op==='prove'?300:op==='verify'?90:10});
async function refuse(action:()=>Promise<unknown>,allowed:string[]){
 try{await action();}catch(error){
  const code=String((error as Error).message);
  if(!allowed.includes(code))throw error;
  return {predicate:code,meters:error instanceof NativeFailure?error.meters:null,
   physical:error instanceof NativeFailure?error.physical??null:null};
 }
 throw Error('Z4_NAMED_FALSIFIER_WAS_ACCEPTED');
}
let base:CheckedExecution|undefined;
try{
 report.identity=await nativeIdentity();await save();
 for(const c of cases){
  const row:Record<string,unknown>={id:c.id,kind:c.kind,requestDigest:sha(c.request),expectedFinal:c.expectedFinal,
   nativeOwnerQualified:false,status:'RUNNING'};
  rows.push(row);await save();
  try{
   const request=validateRequest({...c.request,binding:'0'.repeat(64)});
   const original=originalExecution(request),native=await runNative<{finalState:string[]}>('interpret',request,limits());
   if(canonical(original.finalState)!==canonical(c.expectedFinal)||canonical(native.data.finalState)!==canonical(c.expectedFinal))
    throw Error('Z4_FROZEN_LITERAL_ORIGINAL_MEANING_MISMATCH');
   row.original=original;row.nativeOriginal=meters(native);row.observedFinal=native.data.finalState;
   if(['positive-a','positive-b','wrong-result','currentness'].includes(c.kind)){
    const checked=await produceExecutionProof(request,limits());
    if(canonical(checked.statement.finalState)!==canonical(c.expectedFinal))throw Error('Z4_FROZEN_PROOF_MEANING_MISMATCH');
    await writeFile(resolve(evidence,c.kind+'.checked.json'),canonical(checked)+'\n',{mode:0o600,flag:'wx'});
    row.checkedDigest=sha(checked);row.processes=checked.processes.map(meters);row.proofBytes=checked.artifact.proofHex.length/2;
    if(c.kind==='positive-a')base=checked;
    if(c.kind==='wrong-result'){
     const bad=structuredClone({statement:checked.statement,artifact:checked.artifact});
     bad.statement.finalState[0]=(BigInt(bad.statement.finalState[0]!)+1n).toString();
     row.falsifier=await refuse(()=>runNative('verify',bad,limits()),['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH']);
    }else if(c.kind==='currentness'){
     const bad=structuredClone({statement:checked.statement,artifact:checked.artifact}),i=bad.statement.program.instructions[0]!;
     i.op=i.op==='lt'?'eq':i.op==='eq'?'lt':i.op==='add'?'sub':'add';
     row.falsifier=await refuse(()=>runNative('verify',bad,limits()),['Z4_RELATION_CHANGED']);
     row.scope='CRYPTOGRAPHIC_CODE_BINDING_ONLY_NOT_NATIVE_CURRENTNESS';
    }
    row.status='PASSED_PROCESS_MECHANISM_ONLY';
   }else if(c.kind==='unsupported'){
    const bad=structuredClone(request) as unknown as {program:{instructions:Array<{op:string;dst:number}>}};
    bad.program.instructions[0]!.op='div';bad.program.instructions[0]!.dst=0;
    row.falsifier=await refuse(()=>runNative('interpret',bad,limits()),['Z4_UNSUPPORTED_OPCODE']);
    row.status='PASSED_UNSUPPORTED_REFUSAL';
   }else if(c.kind==='authority'){
    if(!base)throw Error('Z4_POSITIVE_PROOF_PRECONDITION');
    const bad=structuredClone({statement:base.statement,artifact:base.artifact});
    bad.statement.binding=sha({prior:bad.statement.binding,tenantPrincipalRightsPurposeMutation:c.id});
    row.falsifier=await refuse(()=>runNative('verify',bad,limits()),['Z4_RELATION_CHANGED']);
    row.diagnosticSourceCase=family+':positive-a';row.status='PASSED_BINDING_DIAGNOSTIC_ONLY';
    row.scope='BINDING_MUTATION_NOT_AUTHORIZATION_OR_PRIVATE_DISCLOSURE_PROOF';
   }else if(c.kind==='budget'){
    row.falsifier=await refuse(()=>runNative('interpret',request,{...limits(),deadlineAt:'2000-01-01T00:00:00.000Z'}),
     ['Z4_ORIGINAL_DEADLINE_EXHAUSTED']);
    row.status='PASSED_DEADLINE_DIAGNOSTIC_ONLY';row.scope='NO_S5_NATIVE_RESERVATION_AUTHORITY';
   }else{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),300);
    try{row.falsifier=await refuse(()=>runNative('prove',request,{...limits(),signal:controller.signal}),['Z4_PROCESS_CANCELLED']);}
    finally{clearTimeout(timer);}
    const p=(row.falsifier as {physical?:{pid:number|null;exitCode:number|null}}).physical;
    if(!p?.pid||p.exitCode===0)throw Error('Z4_PHYSICAL_INTERRUPTION_NOT_OBSERVED');
    row.status='PASSED_PHYSICAL_PROCESS_INTERRUPT_ONLY';row.scope='NO_NATIVE_WORK_CHECKPOINT_OR_DELIVERY_RECOVERY_CLAIM';
   }
  }catch(error){
   row.status='FAILED';row.error=String((error as Error).message);
   if(error instanceof NativeFailure){row.failureMeters=error.meters;row.physical=error.physical??null;}
  }
  await save();
 }
 report.processPositiveDenominator=2;report.processPositivePassed=rows.filter(r=>String(r.kind).startsWith('positive')&&r.status==='PASSED_PROCESS_MECHANISM_ONLY').length;
 report.nativeAuthorityCurrentnessRecovery='NOT_RUN_NO_AUTHORIZED_TARGET';
 report.status=rows.some(r=>r.status==='FAILED')?'FAILED':'PASSED_OFFLINE_MECHANISM_ONLY';
 await save();console.log(JSON.stringify({family,status:report.status,rows:rows.length,output:evidence}));
 if(report.status==='FAILED')process.exitCode=1;
}catch(error){report.status='FAILED';report.error=String((error as Error).message);await save();process.exitCode=1;}
