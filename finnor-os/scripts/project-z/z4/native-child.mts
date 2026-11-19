/** Finite listener-free child using the real queue or authenticated native consumer. */
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {replayAuthority,refuse,ReplayRefusal,applyRuntimeEnvironment} from './replay-authority.mts';

const argv=process.argv.slice(2),arg=(key:string)=>argv[argv.indexOf(key)+1];
let pool:{end():Promise<void>}|undefined;
try{
 const a=await replayAuthority(arg('--repository')!,arg('--manifest')),index=Number(arg('--case')),sessionId=arg('--session')!,
  mode=arg('--mode'),c=a.scope.cases[index];
 applyRuntimeEnvironment(a,true);
 if(!process.send||!process.connected)refuse('Z4_OWNED_REPLAY_PARENT_CHANNEL_REQUIRED');
 // Let active native observers stop their recorded groups first. With no
 // active native call, the owned Node group still exits on channel loss.
 process.once('disconnect',()=>setImmediate(()=>process.kill(-process.pid,'SIGKILL')));
 if(!c||!['queue','consume'].includes(mode??'')||!/^[a-f0-9-]{36}$/i.test(sessionId))refuse('Z4_NATIVE_CHILD_EXACT_CASE_REQUIRED');
 const {submitSchema,acceptedDefinition,sha}=await import('../../../packages/private-equity/src/project-z/z4-execution-proof/contracts.ts');
 const request=submitSchema.parse(JSON.parse(await readFile(c!.requestFile,'utf8')));
 if(request.workId!==c!.workId||request.workInputId!==c!.workInputId)refuse('Z4_NATIVE_CHILD_ORIGINAL_WORK_MISMATCH');
 // Require the shared narrowing seam before using the lazily created DB pool.
 const queueModule=await import('../../../apps/worker/src/queue.ts') as unknown as {
  SCOPED_JOB_CLAIM_VERSION?:string;
  JobQueue:new(instance:string,lease:number,workloadClass:string,scope:{tenantId:string;jobId:string})=>{
   register(type:string,handler:unknown,contract:unknown):void;recoverExpiredRunningJobs():Promise<number>;tick():Promise<boolean>;
  };
 };
 if(queueModule.SCOPED_JOB_CLAIM_VERSION!=='original-job-scope-v1')refuse('Z4_SHARED_SCOPED_QUEUE_NOT_INSTALLED');
 const db=await import('../../../packages/db/index.ts');pool=db.getPool();
 const row=(await db.getPool().query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='prove_exact_execution_v1'
  AND payload->>'principalId'=$3 AND payload->>'workId'=$4 AND payload->>'workInputId'=$5
  AND payload->>'definitionDigest'=$6 AND payload->'workRevisionRef'->>'id'=$7`,
  [a.scope.tenantId,sessionId,a.scope.principalId,c!.workId,c!.workInputId,sha(acceptedDefinition(request)),request.workRevisionRef.id])).rows;
 if(row.length!==1)refuse('Z4_NATIVE_CHILD_ORIGINAL_JOB_REQUIRED');
 process.env.FINNOR_Z4_REPLAY_SESSION=sessionId;
 if(mode==='queue'){
  const {PRODUCTION_JOB_CONTRACTS}=await import('../../../apps/worker/src/job-contracts.ts');
  const contract=(PRODUCTION_JOB_CONTRACTS as Record<string,unknown>).prove_exact_execution_v1;
  if(!contract)refuse('Z4_SHARED_JOB_CONTRACT_NOT_INSTALLED');
  const {runExecutionProofJob}=await import('../../../packages/private-equity/src/project-z/z4-execution-proof/worker.ts');
  const queue=new queueModule.JobQueue('z4-owned-replay:'+process.pid+':'+sessionId,30,'HEAVY',
   {tenantId:a.scope.tenantId,jobId:sessionId});
  queue.register('prove_exact_execution_v1',runExecutionProofJob,contract);
  const end=Math.min(Date.parse(request.deadlineAt),Date.now()+120000);
  let done=false;
  while(Date.now()<end){
   // Canonical recovery refuses live claims and narrows every candidate to this job.
   await replayAuthority(a.repository,a.manifestPath);
   await queue.recoverExpiredRunningJobs();
   if(await queue.tick()){done=true;break;}
   await delay(500);
  }
  if(!done)throw Error('Z4_NATIVE_SCOPED_JOB_NOT_CLAIMED');
  console.log(JSON.stringify({schema:'finnor.z4.native-child.v1',mode,sessionId,status:'QUEUE_TICK_FINISHED'}));
 }else{
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of process.stdin){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>32768)throw Error('Z4_NATIVE_AUTH_CHANNEL_BOUND');chunks.push(b);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {bearer?:unknown;capsuleDigest?:unknown;idempotencyKey?:unknown};
  if(typeof input.bearer!=='string'||!/^Bearer [A-Za-z0-9._-]+$/.test(input.bearer))refuse('Z4_REAL_SIGNED_BEARER_REQUIRED');
  const {requireContext}=await import('../../../apps/api/lib/auth.ts');
  const auth=await requireContext(new Request(a.target.backendOrigin+'/api/company-brain/execution-proof-consume',
   {method:'POST',headers:{authorization:input.bearer}}));
  if(auth.tenantId!==a.scope.tenantId||(auth.employeeId??auth.userId)!==a.scope.principalId||auth.role!=='owner')
   refuse('Z4_NATIVE_CHILD_REAL_PRINCIPAL_MISMATCH');
  const {consumeProof}=await import('../../../packages/private-equity/src/project-z/z4-execution-proof/owner-consumer.ts');
  const result=await consumeProof({auth},{sessionId,capsuleDigest:input.capsuleDigest,idempotencyKey:input.idempotencyKey});
  console.log(JSON.stringify({schema:'finnor.z4.native-child.v1',mode,sessionId,nativeOwnerConsumed:result.nativeOwnerConsumed,
   replayed:result.replayed,executionAuthorityGranted:false}));
 }
}catch(error){
 const predicate=error instanceof ReplayRefusal?error.predicate:
  String((error as Error)?.message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'Z4_NATIVE_REPLAY_CHILD_FAILED';
 console.error(JSON.stringify({schema:'finnor.z4.native-child.v1',status:'FAILED',predicate}));
 process.exitCode=error instanceof ReplayRefusal?78:1;
}finally{await pool?.end();}
