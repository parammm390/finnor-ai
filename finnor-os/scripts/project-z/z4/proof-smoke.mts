/** Registered process-boundary E2E, not an isolated unit-test suite. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {produceExecutionProof,checkExecutionProof} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {nativeIdentity,runNative} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';
import {canonical,sha} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const target=process.argv[process.argv.indexOf('--evidence')+1];
if(!target?.startsWith('/'))throw Error('absolute --evidence required');
await mkdir(target,{recursive:false,mode:0o700});
const report:Record<string,unknown>={schema:'finnor.z4.native-smoke.v1',nativeOwner:false,protectedAdmission:'NOT_RUN',steps:[],status:'IN_PROGRESS'};
const save=async()=>writeFile(resolve(target,'report.json'),JSON.stringify(report,null,2)+'\n');
try{
 const raw=await readFile(resolve(repository,'scope-z/phase-evidence/z4/public-cases.pre-code.json'));
 const registrationHash=createHash('sha256').update(raw).digest('hex');
 if(registrationHash!=='3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94')throw Error('Z4_FROZEN_REGISTRATION_CHANGED');
 const c=JSON.parse(raw.toString()).cases[0],request={...c.request,binding:'0'.repeat(64)};
 report.registrationSha256=registrationHash;report.caseId=c.id;report.expectedFinal=c.expectedFinal;
 report.identity=await nativeIdentity();await save();
 const limits={deadlineAt:new Date(Date.now()+600000).toISOString(),maxMemoryBytes:2*1024*1024*1024,
  cpuSeconds:(op:string)=>op==='prove'?300:op==='verify'?90:10};
 const checked=await produceExecutionProof(request,limits);
 if(canonical(checked.statement.finalState)!==canonical(c.expectedFinal))throw Error('Z4_FROZEN_ORIGINAL_EXPECTED_VALUE_MISMATCH');
 await writeFile(resolve(target,'checked.json'),canonical(checked)+'\n',{mode:0o600,flag:'wx'});
 const audited=await checkExecutionProof(request,{statement:checked.statement,artifact:checked.artifact},limits);
 const wrong=structuredClone({statement:checked.statement,artifact:checked.artifact});
 wrong.statement.finalState[0]=(BigInt(wrong.statement.finalState[0]!)+1n).toString();
 let rejected=false;
 try{await runNative('verify',wrong,limits);}catch(error){rejected=/Z4_(PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH|CRYPTOGRAPHIC_VERIFIER_REJECTED)/.test(String((error as Error).message));report.negativePredicate=(error as Error).message;}
 if(!rejected)throw Error('Z4_CRITICAL_WRONG_OUTPUT_NOT_REJECTED');
 report.status='PASSED_OFFLINE_MECHANISM_ONLY';report.checkedDigest=sha(checked);
 report.observedFinal=checked.statement.finalState;report.audit=audited.verifier;
 report.processes=checked.processes.map(p=>({operation:p.operation,meters:p.meters,binarySha256:p.binarySha256,sourceDigest:p.sourceDigest}));
 report.proofBytes=checked.artifact.proofHex.length/2;
 await save();console.log(JSON.stringify({status:report.status,case:c.id,proofBytes:report.proofBytes,output:target}));
}catch(error){
 report.status='FAILED';report.error=String((error as Error).message);
 if(error&&typeof error==='object'&&'meters'in error)report.failureMeters=error.meters;
 await save();console.error(JSON.stringify({status:'FAILED',error:report.error,output:target}));process.exitCode=1;
}
