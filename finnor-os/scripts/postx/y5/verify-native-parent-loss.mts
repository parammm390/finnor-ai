import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {native,toolIdentity} from '../../../packages/epistemic-runtime/src/uniform-algorithms/native';
async function readUntil(path:string,deadlineAt:number):Promise<any>{
 for(;;){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(Date.now()>=deadlineAt)throw Error('Y5_PARENT_LOSS_WITNESS_DEADLINE:'+String(error));}
  await new Promise<void>(yes=>setTimeout(yes,20));
 }
}
export async function verifyNativeParentLoss(evidence:string){
 const scratch=join(evidence,'parent-loss');await mkdir(scratch,{mode:0o700});
 await writeFile(join(scratch,'Sleep.lean'),'import Init\ndef main : IO UInt32 := do\n  IO.sleep 60000\n  return 0\n');
 const child=spawn(process.execPath,['--import=tsx',fileURLToPath(import.meta.url),'--invocation-parent',scratch],{
  cwd:resolve(import.meta.dirname,'../../..'),stdio:['ignore','pipe','pipe'],
  env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test'},
 });
 const ended=new Promise<{code:number|null;signal:string|null}>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});
 for(const stream of [child.stdout,child.stderr])stream?.on('data',()=>undefined);
 try{
  const start=await readUntil(join(scratch,'parent-loss.started.json'),Date.now()+30000);
  assert(start.pid>0&&start.guardianPid>0);assert.notEqual(start.pid,child.pid);assert.notEqual(start.guardianPid,child.pid);
  process.kill(-start.pid,0);child.kill('SIGKILL');const parent=await ended;assert.equal(parent.signal,'SIGKILL');
  const receipt=await readUntil(join(scratch,'parent-loss.json'),Date.now()+10000);
  assert.equal(receipt.stopReason,'Y5_PARENT_LOST');assert.equal(receipt.childCloseObserved,true);assert.equal(receipt.signal,'SIGKILL');
  assert.equal(receipt.pid,start.pid);assert.equal(receipt.guardianPid,start.guardianPid);
  assert.throws(()=>process.kill(-start.pid,0),(error:NodeJS.ErrnoException)=>error.code==='ESRCH');
  const report={schema:'finnor.y5.native-parent-loss-verification.v1',status:'PASS',
   scope:'REAL_INVOKING_PROCESS_DEATH_NOT_DATABASE_RECOVERY_OR_SIMULTANEOUS_GUARDIAN_LOSS',
   invokingWorkerPid:child.pid,start,parent,receipt,independentlyObservedLiveChild:true,processGroupClosed:true,forgedRowsOrReceipts:false};
  await writeFile(join(evidence,'native-parent-loss.json'),JSON.stringify(report,null,2)+'\n');return report;
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}}
}
if(process.argv.includes('--invocation-parent')){
 const scratch=resolve(process.argv[3]!);const tool=await toolIdentity();
 await native(tool,['lean','-M','2048','-T','200000','--run','Sleep.lean'],{scratch,deadlineAt:Date.now()+20000},'parent-loss');
 throw Error('Y5_PARENT_LOSS_CHALLENGE_WAS_NOT_KILLED');
}else if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-native-parent-loss');await mkdir(evidence,{recursive:true});
 try{await verifyNativeParentLoss(evidence);console.log(JSON.stringify({status:'PASS',evidence}));}
 catch(error){await writeFile(join(evidence,'failure.json'),JSON.stringify({status:'FAIL',error:String(error)})+'\n');throw error;}
}
