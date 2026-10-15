/** Local controls operate only the generated, disposable V2 fixture. */
import {strict as assert} from 'node:assert';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import type {browserHttpFixture} from './browser-http-fixture.mts';
import {runtimeArtifact,artifactWorker} from './runtime-artifact.mts';
import {localManagedSecrets} from './local-managed-secrets.mts';
import {verificationBudget} from './verification-budget.mts';

export async function mountedController(p:{
 repo:string;output:string;platform:any;ctx:any;root:any;fixture:any;
 http:Awaited<ReturnType<typeof browserHttpFixture>>;
 worker:()=>Promise<void>;sourceCalls:(f:any)=>Promise<any[]>;
 call:(operation:string,body:unknown,status?:number)=>Promise<any>;
 test:(id:string,input:unknown,invariant:string,fn:()=>Promise<unknown>)=>Promise<void>;
 budget:ReturnType<typeof verificationBudget>;
}){
 const f=p.fixture,owned=new Set<ChildProcess>(),started=Date.now();
 let activeBudget=p.budget;
 const qualification=process.env.FINNOR_V2_KEYBOARD_RECOVERY==='1'||process.env.FINNOR_V2_SESSION_RECOVERY==='1'||process.env.FINNOR_V2_UI_RECOVERY==='1'||process.env.FINNOR_V2_QUALIFICATION==='1',continuation=qualification||process.env.FINNOR_V2_CONTINUATION==='1',closure=continuation||process.env.FINNOR_V2_CLOSURE==='1';
 let artifact:Awaited<ReturnType<typeof runtimeArtifact>>|undefined,artifactBegan=0;
 if(qualification){artifactBegan=Date.now();artifact=await runtimeArtifact(p.repo,p.platform.directory,p.output,p.budget);}
 assert(!JSON.stringify(f.intake).includes('5000000'));assert(!JSON.stringify(f.intake).includes('additional-facility-1'));
 const thread=await createEmployeeConversationThread({tenantId:p.ctx.auth.tenantId,ownerEmployeeId:p.ctx.auth.userId,title:'V2 mounted primary evidence'});
 await updateEmployeeConversationThreadContext({tenantId:p.ctx.auth.tenantId,ownerEmployeeId:p.ctx.auth.userId,threadId:thread.id,activeReferences:[p.root],activeWorkId:closure?null:f.intake.workId});
 const sibling=await p.call('primary-open-work',{root:p.root,instruction:'Separate canonical Work, no right to display another Work programme',idempotencyKey:crypto.randomUUID()},201);
 const otherThread=await createEmployeeConversationThread({tenantId:p.ctx.auth.tenantId,ownerEmployeeId:p.ctx.auth.userId,title:'V2 separate Work scope'});
 await updateEmployeeConversationThreadContext({tenantId:p.ctx.auth.tenantId,ownerEmployeeId:p.ctx.auth.userId,threadId:otherThread.id,activeReferences:[p.root],activeWorkId:sibling.workId});
 async function freePort(){
  activeBudget.assertCurrent();
  const server=netServer();return new Promise<number>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')return no(Error('OWNED_PORT_REQUIRED'));server.close(()=>yes(a.port));});});
 }
 async function startNext(id:string,cwd:string,script:string,command:string,env:NodeJS.ProcessEnv){
  const startupBudget=activeBudget,port=await freePort();startupBudget.assertCurrent();
  const child=spawn(process.execPath,[script,command,'-H','127.0.0.1','-p',String(port)],{cwd,env,stdio:['ignore','pipe','pipe']});
  const stop=()=>child.kill('SIGKILL');startupBudget.signal.addEventListener('abort',stop,{once:true});
  owned.add(child);let log='';const append=(b:Buffer)=>{if(log.length<1048576)log+=b.toString();};
  child.stdout!.on('data',append);child.stderr!.on('data',append);
  child.once('exit',()=>{startupBudget.signal.removeEventListener('abort',stop);owned.delete(child);void writeFile(join(p.output,id+'.log'),log.replace(/Bearer [^\s"]+/g,'Bearer [REDACTED]').replace(/postgres(?:ql)?:\/\/[^@\s]+@/g,'postgres://[REDACTED]@'));});
  const origin='http://127.0.0.1:'+port,deadline=Math.min(startupBudget.deadlineAt,Date.now()+90000);
  while(Date.now()<deadline){
   startupBudget.assertCurrent();
   if(child.exitCode!==null)throw Error('OWNED_'+id.toUpperCase()+'_EXIT_'+child.exitCode);
   try{const response=await fetch(origin+'/centropy/login',{signal:AbortSignal.timeout(startupBudget.remainingMs(3000))});if(response.status<500){startupBudget.assertCurrent();return {origin,child};}}catch(error){if(startupBudget.signal.aborted)throw error;}
   await new Promise(yes=>setTimeout(yes,250));
  }
  throw Error('OWNED_NEXT_START_DEADLINE');
 }
 const front=await startNext('mounted-frontend',p.repo,join(p.repo,'node_modules/next/dist/bin/next'),'dev',{
  ...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_SUPABASE_URL:p.http.authOrigin,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-publishable-not-live',FINNOR_OS_API_URL:p.http.origin,
 });
 const packet=Object.fromEntries(['assertions','startingEvidenceRefs','mandateRef','authorityProfileRef','budgetGrantRef','sourceProfileRefs','consentRefs','referenceSemanticsRefs'].map(key=>[key,f.intake[key]]));
 const browserLimitSeconds=continuation?900:closure?600:300,mountedBudget=verificationBudget(Math.min(p.budget.deadlineAt,Date.now()+browserLimitSeconds*1000));
 activeBudget=mountedBudget;
 const test=(id:string,input:unknown,invariant:string,fn:()=>Promise<unknown>)=>p.test(id,input,invariant,async()=>{
  mountedBudget.assertCurrent();const result=await fn();mountedBudget.assertCurrent();return result;
 });
 const descriptor={schema:'finnor.v2.mounted-fixture.v1',frontendOrigin:front.origin,loginEmail:p.http.loginEmail,root:p.root,workId:closure?null:f.intake.workId,threadId:thread.id,otherWorkId:sibling.workId,otherThreadId:otherThread.id,packet,evidence:p.output,browserLimitSeconds,deadlineAt:new Date(mountedBudget.deadlineAt).toISOString()};
 await writeFile(join(p.output,'mounted-inputs.json'),JSON.stringify(descriptor,null,2)+'\n');
 async function state(){
  const row=(await p.platform.admin.query("SELECT id::text FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND principal_id=$2 AND intake->'budgetGrantRef'->>'id'=$3 ORDER BY created_at DESC LIMIT 1",[p.ctx.auth.tenantId,p.ctx.auth.userId,f.intake.budgetGrantRef.id])).rows[0];
  return {programmeId:row?.id??null,read:row?await p.call('primary-read',{programmeId:row.id}):null,calls:await p.sourceCalls(f),authRefreshRequests:p.http.observed.refreshRequests};
 }
 let ended:()=>void=()=>undefined;
 const done=new Promise<void>(yes=>{ended=yes;});
 const control=httpServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   const path=new URL(req.url??'/','http://127.0.0.1').pathname;
   if(path!=='/finish')mountedBudget.assertCurrent();
   if(req.method==='GET'&&path==='/descriptor'){res.end(JSON.stringify(descriptor));return;}
   if(req.method==='GET'&&path==='/state'){res.end(JSON.stringify(await state()));return;}
   if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
   if(path==='/tick'){
    await test('mounted-actual-acquisition',{workId:f.intake.workId},'one actual final-registry worker independently accepts the absent scoped facility',async()=>{
     const before=await state();assert(before.programmeId);assert.equal(before.read.findings.length,0);assert.equal(before.calls.length,0);
     if(closure){
      if(!artifact){artifactBegan=Date.now();artifact=await runtimeArtifact(p.repo,p.platform.directory,p.output,mountedBudget);}
      await artifactWorker(artifact,p.platform.workerUrl,p.output,mountedBudget);
     }else await p.worker();
     const after=await state();assert.equal(after.read.status,'COMPLETE',JSON.stringify(after.read));
     assert.equal(after.read.findings[0].conclusion,'SUPPORTED');assert.equal(after.read.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
     assert.equal(after.calls.filter(c=>c.operation==='ACQUIRE').length,1);return {before,after};
    });
    res.end(JSON.stringify(await state()));return;
   }
   if(path==='/continuity'){
    await test('mounted-canonical-work-link',{threadId:thread.id},'actual newly created Work is persisted at the owned Investigation owner',async()=>{
     const current=await state();assert(current.read?.workId);
     const row=(await p.platform.admin.query('SELECT active_work_id::text,revision FROM finnor_os.employee_conversation_threads WHERE tenant_id=$1 AND owner_employee_id=$2 AND id=$3',[p.ctx.auth.tenantId,p.ctx.auth.userId,thread.id])).rows[0];
     assert.equal(row.active_work_id,current.read.workId);return {thread:row,workId:current.read.workId};
    });res.end(JSON.stringify(await state()));return;
   }
   if(path==='/revoke'){await p.call('primary-governance-revoke',{root:p.root,ref:f.consentRef,reason:'MOUNTED_ACTUAL_OWNER_CONSENT_REVOKED'});res.end(JSON.stringify(await state()));return;}
   if(path==='/packaged'){
    await test('packaged-api-owner-read',{profile:'production API, actual signed auth, development finding'},'emitted API bytes read the exact accepted finding and retain the production acquisition guard',async()=>{
     const began=Date.now(),apiDirectory=artifact?.apiDirectory??join(p.repo,'finnor-os/apps/api'),runtimeRoot=artifact?.directory??p.repo;
     const tracePath=join(apiDirectory,'.next/server/app/api/company-brain/[operation]/route.js.nft.json');
     const trace=JSON.parse(await readFile(tracePath,'utf8'));
     const assets=['checker.mts','checker-spec.md','store.ts','primary-records.ts','source-custody/index.cjs'].map(suffix=>{
      const matches=(trace.files as string[]).filter(file=>file.endsWith(suffix));assert(matches.length>0,'PACKAGED_ASSET_MISSING_'+suffix);return {suffix,matches};
     });
     assert(process.env.DATABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY,'ACTUAL_DISPOSABLE_APP_SECRETS_REQUIRED');
     const managed=await localManagedSecrets({DATABASE_URL:process.env.DATABASE_URL,SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY});
     const productionEnv:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'};
     for(const key of Object.keys(productionEnv))if(key.startsWith('AWS_'))delete productionEnv[key];
     Object.assign(productionEnv,managed.environment);
     // Production correctly rejects the mere presence of this development flag,
     // including "0". Do not weaken that boot guard for an artifact check.
     delete productionEnv.AUTH_DEV_BYPASS;
     delete productionEnv.ALLOW_PLAINTEXT_ENV_SECRETS;delete productionEnv.DATABASE_URL;delete productionEnv.SUPABASE_SERVICE_ROLE_KEY;
     let packaged:Awaited<ReturnType<typeof startNext>>|undefined;
     try{
      packaged=await startNext('packaged-api',apiDirectory,join(runtimeRoot,'finnor-os/node_modules/next/dist/bin/next'),'start',productionEnv);
      const current=await state();assert(current.programmeId);
      const read=await p.http.call('primary-read',{programmeId:current.programmeId},'actor',packaged.origin);
      assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.body.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
      const refused=await p.http.call('primary-submit',{...f.intake,idempotencyKey:crypto.randomUUID()},'actor',packaged.origin);
      assert.equal(refused.status,422,JSON.stringify(refused));assert.equal(refused.body.predicate,'LIVE_PRIMARY_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
      const bytes=await readFile(join(apiDirectory,'.next/server/app/api/company-brain/[operation]/route.js'));
      assert(Date.now()-began<=180000,'REGISTERED_PACKAGED_BUDGET_EXHAUSTED');
      assert(managed.observed.includes('DATABASE_URL')&&managed.observed.includes('SUPABASE_SERVICE_ROLE_KEY'),'ACTUAL_MANAGED_PROVIDER_PROTOCOL_NOT_OBSERVED');
      return {read,refused,assets,routeSha256:createHash('sha256').update(bytes).digest('hex'),elapsedMs:Date.now()-began,artifactPreparationAndWorkerElapsedMs:artifactBegan?Date.now()-artifactBegan:null,relocatedArtifact:!!artifact,packagedWorkerProof:artifact?'ACTUAL_DEVELOPMENT_ACQUISITION_CHECK_AND_ACCEPTANCE':'NOT_RUN',managedProviderQualification:managed.qualification,secretReadNames:managed.observed,LinuxImageProof:'NOT_RUN'};
     }finally{packaged?.child.kill('SIGTERM');await managed.close();}
    });
    res.end(JSON.stringify({recorded:true}));return;
   }
   if(path==='/finish'){
    await test('mounted-browser-readback',{evidence:'browser-results.json'},'all registered mounted observations have retained actual DOM evidence',async()=>{
     const report=JSON.parse(await readFile(join(p.output,'browser-results.json'),'utf8'));
     assert.equal(report.status,'PASS_MOUNTED_PREREGISTERED_BOUNDARIES');return report;
    });
    await writeFile(join(p.output,'mounted-owner-trace.json'),JSON.stringify({auth:p.http.observed,state:await state(),elapsedMs:Date.now()-started},null,2)+'\n');
    res.end(JSON.stringify({recorded:true,evidence:p.output}));ended();return;
   }
   res.writeHead(404);res.end('{}');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({failure:error instanceof Error?error.message:'OWNED_MOUNTED_FAILURE'}));}
 });
 await new Promise<void>((yes,no)=>{control.once('error',no);control.listen(0,'127.0.0.1',yes);});
 const address=control.address();if(!address||typeof address==='string')throw Error('OWNED_CONTROL_PORT_REQUIRED');
 console.log(JSON.stringify({mountedReady:true,controlOrigin:'http://127.0.0.1:'+address.port,...descriptor}));
 const stop=()=>ended();mountedBudget.signal.addEventListener('abort',stop,{once:true});p.budget.signal.addEventListener('abort',stop,{once:true});
 try{await done;}
 finally{mountedBudget.dispose();mountedBudget.signal.removeEventListener('abort',stop);p.budget.signal.removeEventListener('abort',stop);control.closeAllConnections();await new Promise<void>(yes=>control.close(()=>yes()));for(const child of owned)child.kill('SIGTERM');}
}
