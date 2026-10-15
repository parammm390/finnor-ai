/** Separate finite artifact execution; this is not a mounted-browser retry. */
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runtimeArtifact,artifactWorker} from './runtime-artifact.mts';
import type {browserHttpFixture} from './browser-http-fixture.mts';
import {localManagedSecrets} from './local-managed-secrets.mts';
import type {verificationBudget} from './verification-budget.mts';

export async function packagedRuntime(p:{
 repo:string;output:string;platform:any;fixture:any;
 http:Awaited<ReturnType<typeof browserHttpFixture>>;
 call:(operation:string,body:unknown,status?:number)=>Promise<any>;
 sourceCalls:(fixture:any)=>Promise<any[]>;
 test:(id:string,input:unknown,invariant:string,fn:()=>Promise<unknown>)=>Promise<void>;
 budget:ReturnType<typeof verificationBudget>;
}){
 await p.test('packaged-relocated-final-worker-and-api',{profile:'relocated emitted production API and controlled development final-registry worker'},'actual acquisition/check/acceptance and production read execute only relocated assets, with no bypass; production and another principal cannot acquire/read private facts',async()=>{
  const began=Date.now(),accepted=await p.call('primary-submit',p.fixture.intake,202);
  const artifact=await runtimeArtifact(p.repo,p.platform.directory,p.output,p.budget);
  await artifactWorker(artifact,p.platform.workerUrl,p.output,p.budget);
  const current=await p.call('primary-read',{programmeId:accepted.programmeId});
  assert.equal(current.status,'COMPLETE',JSON.stringify(current));
  assert.equal(current.findings[0].conclusion,'SUPPORTED');
  assert.equal(current.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
  assert(current.costReceipts.some((cost:any)=>cost.kind==='NATIVE'&&cost.status==='RECONCILED'));
  const calls=await p.sourceCalls(p.fixture);assert.equal(calls.filter(call=>call.operation==='ACQUIRE').length,1);
  const port=await new Promise<number>((yes,no)=>{
   const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return no(Error('OWNED_ARTIFACT_PORT_REQUIRED'));server.close(()=>yes(address.port));});
  });
  assert(process.env.DATABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY,'ACTUAL_DISPOSABLE_APP_SECRETS_REQUIRED');
  const managed=await localManagedSecrets({DATABASE_URL:process.env.DATABASE_URL,SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY});
  const env:NodeJS.ProcessEnv={...process.env,...managed.environment,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',TSX_TSCONFIG_PATH:join(artifact.directory,'finnor-os/tsconfig.json')};
  for(const key of Object.keys(env))if(key.startsWith('AWS_'))delete env[key];
  Object.assign(env,managed.environment);
  delete env.AUTH_DEV_BYPASS;
  delete env.ALLOW_PLAINTEXT_ENV_SECRETS;delete env.AWS_SESSION_TOKEN;
  delete env.DATABASE_URL;delete env.SUPABASE_SERVICE_ROLE_KEY;
  const child=spawn(process.execPath,[join(artifact.directory,'finnor-os/node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:artifact.apiDirectory,env,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>{if(log.length<1048576)log+=b.toString();});child.stderr.on('data',b=>{if(log.length<1048576)log+=b.toString();});
  const stop=()=>child.kill('SIGKILL');p.budget.signal.addEventListener('abort',stop,{once:true});
  const origin='http://127.0.0.1:'+port,timer=setTimeout(stop,p.budget.remainingMs(Math.max(1,180000-(Date.now()-began))));
  try{
   const readyDeadline=Math.min(began+150000,Date.now()+60000);let ready=false;
   while(Date.now()<readyDeadline){
    if(child.exitCode!==null)throw Error('RELOCATED_API_EXIT_'+child.exitCode);
    try{const response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(2000)});if(response.status<500){ready=true;break;}}catch{}
    await new Promise(yes=>setTimeout(yes,250));
   }
   assert(ready,'RELOCATED_API_START_DEADLINE');
   const read=await p.http.call('primary-read',{programmeId:accepted.programmeId},'actor',origin);
   assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.body.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
   const other=await p.http.call('primary-read',{programmeId:accepted.programmeId},'other',origin);
   assert.equal(other.status,404);assert(!JSON.stringify(other.body).includes('5000000'));
   const guarded=await p.http.call('primary-submit',{...p.fixture.intake,idempotencyKey:crypto.randomUUID()},'actor',origin);
   assert.equal(guarded.status,422,JSON.stringify(guarded));assert.equal(guarded.body.predicate,'LIVE_PRIMARY_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
   assert(Date.now()-began<180000,'REGISTERED_PACKAGED_RUNTIME_BUDGET_EXHAUSTED');
   assert(managed.observed.includes('DATABASE_URL')&&managed.observed.includes('SUPABASE_SERVICE_ROLE_KEY'),'ACTUAL_MANAGED_PROVIDER_PROTOCOL_NOT_OBSERVED');
   return {read,other,guarded,calls,sourceFallback:false,relocatedArtifact:true,actualPackagedWorkerAcquisitionAndCheck:true,productionAuthBypass:false,plaintextEmergencyOverride:false,secretReadNames:managed.observed,managedProviderQualification:managed.qualification,elapsedMs:Date.now()-began,dependencies:'LOCK_MATCHING_COPIED_NOT_CLEAN_INSTALL',LinuxImageProof:'NOT_RUN'};
  }finally{
   clearTimeout(timer);p.budget.signal.removeEventListener('abort',stop);child.kill('SIGTERM');
   await writeFile(join(p.output,'relocated-api.log'),log.replace(/Bearer [^\s"]+/g,'Bearer [REDACTED]').replace(/postgres(?:ql)?:\/\/[^@\s]+@/g,'postgres://[REDACTED]@'));
   await managed.close();
  }
 });
}
