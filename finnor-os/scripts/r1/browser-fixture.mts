/** A mounted existing Work fixture backed by actual authenticated owners. */
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createEmployeeConversationThread,receiveWork,updateEmployeeConversationThreadContext} from '@finnor/db';
import {createDeal,attachWorkToDealGraph,restateMetricObservation} from '@finnor/private-equity';
import {prepareR1Owners,ok} from './owner-fixture.mts';
export async function browserFixture(e:any){
 let otherThread:any,otherWork:any,dealRoot!:{entityType:string;entityId:string};const otherPrincipal=randomUUID();
 const f=await prepareR1Owners(e,{name:'mounted-r1-owner',thread:true,programDeadlineMs:3600000,periodMs:3600000,beforeSource:async fixture=>{
  const deal=await createDeal(fixture.ctx,{targetOrganizationId:fixture.root.entityId,name:'R1 mounted original owner company',dealLeadEmployeeId:fixture.principal,signedLoiAt:new Date('2025-01-01'),targetClosingAt:new Date('2027-01-01')});dealRoot={entityType:'pe_deal',entityId:String(deal.row.id)};
  otherThread=await createEmployeeConversationThread({tenantId:fixture.tenant,ownerEmployeeId:fixture.principal,title:'R1 other Work scope'});
  otherWork=await receiveWork({tenantId:fixture.tenant,userId:fixture.principal,instruction:'Inspect a distinct original Work; no R1 claim or issued programme.',channel:'console',idempotencyKey:randomUUID()});
  for(const workId of [fixture.work.workId,otherWork.workId])await attachWorkToDealGraph(fixture.ctx,{dealId:dealRoot.entityId,workId,entities:[{entityType:'pe_deal',entityId:dealRoot.entityId}]});
  await updateEmployeeConversationThreadContext({tenantId:fixture.tenant,ownerEmployeeId:fixture.principal,threadId:fixture.thread.id,activeWorkId:fixture.work.workId,activeReferences:[dealRoot]});
  await updateEmployeeConversationThreadContext({tenantId:fixture.tenant,ownerEmployeeId:fixture.principal,threadId:otherThread.id,activeWorkId:otherWork.workId,activeReferences:[dealRoot]});
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','R1 other owner')",[otherPrincipal,fixture.tenant,otherPrincipal+'@r1.example.test']);e.http.register(otherPrincipal,otherPrincipal+'@r1.example.test');
 }});
 const out=join(e.evidence,'browser');await mkdir(out,{recursive:true});let stopped!:()=>void,closed=false,currentWorker:any=null,delay:any=null,checkerHeld:number|null=null;
 const stop=new Promise<void>(yes=>stopped=yes);
 async function ensureWorker(){
  if(currentWorker&&(currentWorker.child.exitCode!==null||currentWorker.child.signalCode!==null)){await currentWorker.stop();currentWorker=null;}
  if(!currentWorker)currentWorker=await e.worker();
  return currentWorker;
 }
 const control=createServer(async(req,res)=>{try{
  let input:any={};if(req.method==='POST'){let raw='';for await(const b of req){raw+=b;if(raw.length>8192)throw Error('R1_DISPOSABLE_CONTROL_BOUND');}input=JSON.parse(raw||'{}');}res.setHeader('content-type','application/json');
  if(req.url==='/start-worker'&&req.method==='POST'){const worker=await ensureWorker();res.end(JSON.stringify({pid:worker.child.pid}));return;}
  if(req.url==='/stop-worker'&&req.method==='POST'){if(currentWorker){await currentWorker.stop();currentWorker=null;}res.end('{}');return;}
  if(req.url==='/hold-next-checker'&&req.method==='POST'){
   const since=new Date().toISOString();await ensureWorker();let a:any;
   const start=performance.now();while(performance.now()-start<20000){a=(await e.admin.query("SELECT child_pid,id,run_id FROM finnor_os.r1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND stage='CHECK' AND status='SUBMITTED' AND created_at>=$3 ORDER BY created_at DESC LIMIT 1",[f.tenant,f.principal,since])).rows[0];if(a?.child_pid){process.kill(a.child_pid,'SIGSTOP');checkerHeld=a.child_pid;break;}await new Promise(yes=>setTimeout(yes,5));}if(!a)throw Error('R1_BROWSER_ACTUAL_CHECKER_NOT_OBSERVED');res.end(JSON.stringify({attempt:a,signal:'SIGSTOP'}));return;
  }
  if(req.url==='/kill-checker'&&req.method==='POST'){assert(checkerHeld);process.kill(checkerHeld,'SIGKILL');res.end(JSON.stringify({pid:checkerHeld,signal:'SIGKILL'}));checkerHeld=null;return;}
  if(req.url==='/delay-read'&&req.method==='POST'){delay=e.http.delay(input.workId??f.work.workId,input.operation??'r1-projection');res.end('{}');return;}
  if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
  if(req.url==='/release-read'&&req.method==='POST'){delay?.release();delay=null;res.end('{}');return;}
  if(req.url==='/correct'&&req.method==='POST'){const correction=await restateMetricObservation(f.ctx,{priorObservationId:String(f.observations.debt.row.id),expectedVersion:1,replacement:{value:{type:'number',value:'80'},evidence:f.evidence}});res.end(JSON.stringify({correction}));return;}
  if(req.url==='/revoke'&&req.method==='POST'){await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[f.tenant,f.principal]);res.end('{}');return;}
  if(req.url==='/observe'){const runs=(await e.admin.query('SELECT id,status,predicate,head_id,generation,decision_deadline_at,episode_id FROM finnor_os.r1_runs WHERE tenant_id=$1 AND principal_id=$2 ORDER BY created_at',[f.tenant,f.principal])).rows;res.end(JSON.stringify({runs,checkerHeld}));return;}
  if(req.url==='/stop'&&req.method==='POST'){closed=true;delay?.release();res.end('{}');stopped();return;}
  res.writeHead(404);res.end('{}');
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
 await new Promise<void>((yes,no)=>{control.once('error',no);control.listen(0,'127.0.0.1',yes);});const address=control.address();assert(address&&typeof address!=='string');
 const portServer=createServer();await new Promise<void>(yes=>portServer.listen(0,'127.0.0.1',yes));const pa=portServer.address();assert(pa&&typeof pa!=='string');const frontendPort=pa.port;await new Promise<void>(yes=>portServer.close(()=>yes()));
 const base='http://127.0.0.1:'+frontendPort;
 const url=(id:string)=>base+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(dealRoot));
 const frontendEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_OS_API_URL:e.http.apiBase,NEXT_PUBLIC_SUPABASE_URL:e.http.authBase,NEXT_PUBLIC_SUPABASE_ANON_KEY:'r1-disposable-local-auth-key',FINNOR_BUILD_ID:'R1_OWNED_DEVELOPMENT_WORK_REVIEW'};
 await writeFile(join(out,'frontend-env.json'),JSON.stringify(frontendEnv,null,2)+'\n');
 const logPath=join(out,'frontend.log');await writeFile(logPath,'');let logWrites=Promise.resolve();
 const frontend=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(frontendPort)],{cwd:e.repo,env:frontendEnv,stdio:['ignore','pipe','pipe']});
 for(const stream of [frontend.stdout!,frontend.stderr!])stream.on('data',b=>{logWrites=logWrites.then(()=>appendFile(logPath,b));});
 frontend.once('exit',(code,signal)=>{logWrites=logWrites.then(()=>writeFile(join(out,'frontend-exit.json'),JSON.stringify({pid:frontend.pid,at:new Date().toISOString(),code,signal},null,2)+'\n'));});
 const data={schema:'finnor.r1.mounted-fixture.v1',qualification:e.http.qualification,authBypass:false,profile:'ORDINARY_DISPOSABLE',base,url:url(f.thread.id),control:'http://127.0.0.1:'+address.port,email:f.principal+'@r1.example.test',password:'r1-disposable-only',workId:f.work.workId,programId:f.program.programId,originalEpisodeDeadlineMs:3600000,originalDecisionDeadlineMs:30000,root:f.root,dealRoot,threadId:f.thread.id,other:{url:url(otherThread.id),threadId:otherThread.id,workId:otherWork.workId},otherPrincipal:{email:otherPrincipal+'@r1.example.test',password:'r1-disposable-only'},expected:{value:{numerator:'7',denominator:'1'},rootAction:'choice1',laterAction:'stop',originalStates:13,quotientStates:8,exactCapital:'1/3',executionAuthority:false}};
 await writeFile(join(out,'fixture.json'),JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({kind:'BROWSER_FIXTURE_READY',fixture:join(out,'fixture.json'),url:data.url,frontendPid:frontend.pid}));
 const terminate=()=>{closed=true;delay?.release();stopped();};process.once('SIGINT',terminate);process.once('SIGTERM',terminate);
 try{await stop;const receipt=JSON.parse(await readFile(join(out,'results.json'),'utf8'));assert.equal(receipt.status,'PASS_LOCAL',JSON.stringify(receipt));assert.equal(receipt.steps.length,8);const sql=(await e.admin.query('SELECT id FROM finnor_os.r1_runs WHERE tenant_id=$1 AND principal_id=$2 ORDER BY created_at',[f.tenant,f.principal])).rows;assert.equal(sql.length,2);for(const row of sql)await e.snapshot(f,row.id);return {fixture:join(out,'fixture.json'),steps:receipt.steps,source:e.http.qualification};}
 finally{closed=true;delay?.release();if(checkerHeld)try{process.kill(checkerHeld,'SIGKILL');}catch{}if(currentWorker)await currentWorker.stop();frontend.kill('SIGTERM');await Promise.race([new Promise(yes=>frontend.once('exit',yes)),new Promise(yes=>setTimeout(yes,3000))]);if(frontend.exitCode===null&&frontend.signalCode===null)frontend.kill('SIGKILL');await logWrites;await new Promise<void>(yes=>{control.closeAllConnections();control.close(()=>yes());});process.off('SIGINT',terminate);process.off('SIGTERM',terminate);}
}
