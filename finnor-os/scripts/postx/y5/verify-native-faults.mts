import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {native,toolIdentity} from '../../../packages/epistemic-runtime/src/uniform-algorithms/native';
import {verifyNativeParentLoss} from './verify-native-parent-loss.mts';
export async function verifyNativeFaults(evidence:string){
 const started=Date.now(),tool=await toolIdentity(),scratch=resolve(evidence,'physical-faults');await mkdir(scratch,{recursive:true});
 await writeFile(resolve(scratch,'Sleep.lean'),'import Init\ndef main : IO UInt32 := do\n  IO.sleep 60000\n  return 0\n');
 await writeFile(resolve(scratch,'Output.lean'),'import Init\ndef main : IO UInt32 := do\n  for _ in [0:200000] do\n    IO.println "Y5 bounded physical output"\n  return 0\n');
 let heartbeatCalls=0;const observations:unknown[]=[];
 for(const [name,file,milliseconds,guard] of [
  ['cancel','Sleep.lean',30000,'Y5_CLAIM_CANCELLED'],
  ['deadline','Sleep.lean',1000,'Y5_NATIVE_DEADLINE'],
  ['output','Output.lean',30000,'Y5_OUTPUT_BOUND'],
 ] as const){
  const deadlineAt=Date.now()+milliseconds;
  const budget={deadlineAt,scratch,...(name==='cancel'?{current:async()=>++heartbeatCalls===1}:{})};
  let failure:any;
  try{await native(tool,['lean','-M','2048','-T','200000','--run',file],budget,name);}catch(error){failure=error;}
  assert.equal(failure?.message,guard);assert(failure.receipt.pid>0);assert.equal(failure.receipt.signal,'SIGKILL');
  assert.throws(()=>process.kill(-failure.receipt.pid,0),(error:NodeJS.ErrnoException)=>error.code==='ESRCH');
  observations.push({case:'N2-physical-'+name,guard,originalDeadline:deadlineAt,processGroupClosed:true,receipt:failure.receipt});
 }
 const report={schema:'finnor.y5.native-supervisor-verification.v1',status:'PASS',wallMs:Date.now()-started,
  scope:'REAL_NATIVE_PROCESS_SUPERVISOR_NOT_DATABASE_WORKER_RECOVERY_OR_RESOURCE_QUALIFICATION',observations,
  parentLoss:await verifyNativeParentLoss(evidence),aggregatePeakBytes:null,completeMoney:null};
 await writeFile(resolve(evidence,'native-faults.json'),JSON.stringify(report,null,2)+'\n');return observations;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-native-faults');await mkdir(evidence,{recursive:true});
 try{await verifyNativeFaults(evidence);console.log(JSON.stringify({status:'PASS',evidence}));}
 catch(error){await writeFile(resolve(evidence,'failure.json'),JSON.stringify({status:'FAIL',error:String(error)})+'\n');throw error;}
}
