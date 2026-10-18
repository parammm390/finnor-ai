/** Disposable mounted Work fixture. Browser verdicts are recorded separately;
 * setup, control traffic and SQL readback are not themselves browser passes. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import {appendFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {configureTenantVertical,receiveWork,createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {startEnvironment,artifact,repo} from './environment.mts';
import {exceptionRegister} from './business-fixtures.mts';

const evidence=resolve(process.env.FINNOR_X3_EVIDENCE_DIR!);
assert(process.env.FINNOR_X3_EVIDENCE_DIR&&evidence.startsWith('/'));
await mkdir(evidence,{recursive:true});
const e=await startEnvironment(evidence,{builtApi:true}),tenant=randomUUID(),principal=randomUUID(),reviewer=randomUUID();
const root={entityType:'external_organization' as const,entityId:randomUUID()},email=principal+'@x3.example.test';
let frontend:ChildProcess|undefined,worker:ChildProcess|undefined,delay:ReturnType<NonNullable<typeof e.http>['delay']>|undefined,reviewerRoleId='',reviewerGrantId='';
let closeControl:(()=>Promise<void>)|undefined;
let closeFrontdoor:(()=>Promise<void>)|undefined;
let logWrites=Promise.resolve(),stop!:()=>void;
const stopped=new Promise<void>(yes=>stop=yes),workerRuns:unknown[]=[];
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X3 mounted disposable firm')",[tenant,randomUUID()]);
 for(const [id,name] of [[principal,'Operator'],[reviewer,'Independent reviewer']] as const){
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active',$4)",[id,tenant,id+'@x3.example.test',name]);
  e.http!.register(id,id+'@x3.example.test','x3-disposable-only');
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'x3-mounted-firm','X3 disposable firm operations','other')",[root.entityId,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'X3:mounted-disposable'});
 for(const [id,key] of [[principal,'x3_analyst'],[reviewer,'x3_partner']] as const){
  const role=(await e.admin.query('INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,$2,$2) RETURNING id',[tenant,key])).rows[0];
  if(key==='x3_partner')reviewerRoleId=role.id;
  await e.admin.query('INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)',[tenant,id,role.id,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})]);
 }
 const work=await receiveWork({tenantId:tenant,userId:principal,channel:'console',instruction:'Construct and maintain the independently declared firm control-exception application. Development only, no dispatch.',idempotencyKey:randomUUID(),entityAttachments:[{...root,source:'X3:browser-fixture'}]});
 const otherWork=await receiveWork({tenantId:tenant,userId:principal,channel:'console',instruction:'Separate original Work with no installed application.',idempotencyKey:randomUUID(),entityAttachments:[{...root,source:'X3:browser-fixture'}]});
 const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:principal,title:'X3 maintained firm application'}),otherThread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:principal,title:'X3 separate Work'});
 for(const [t,w] of [[thread,work],[otherThread,otherWork]] as const)await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:principal,threadId:t.id,activeWorkId:w.workId,activeReferences:[root]});
 const source=await createEvidenceSource(tenant,{sourceKey:'x3-mounted-support',sourceType:'manual',title:'Disposable access review'});
 const version=await appendEvidenceVersion(tenant,source.id,{content:'Independent development access inventory, no production claim.',snapshot:{qualification:'DECLARED_DEVELOPMENT_INPUT'},asOf:new Date()});
 const row=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[version.versionId])).rows[0];
 const support={kind:'EVIDENCE',sourceId:source.id,versionId:version.versionId,contentDigest:row.content_hash};
 const specification=exceptionRegister(tenant,root.entityId);
 specification.title='Firm controls <img src=x onerror="window.x3Injected=true">';
 specification.model.entities[0]!.fields.push(
  {id:'uncertainText',title:'Unresolved text',type:'text',required:false,allowUnknown:true,maxLength:200},
  {id:'uncertainFlag',title:'Unresolved boolean',type:'boolean',required:false,allowUnknown:true},
  {id:'uncertainCategory',title:'Unresolved category',type:'enum',options:['OPEN','REVIEWED'],required:false,allowUnknown:true});
 specification.actions.find(action=>action.id==='create')!.inputFields.push('uncertainText','uncertainFlag','uncertainCategory');
 const replacement=structuredClone(specification);replacement.version='2';
 replacement.actions.find(a=>a.id==='document')!.title='Document revised remediation';
 const control=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   if(req.url==='/worker'&&req.method==='POST'){
    if(worker&&worker.exitCode===null&&worker.signalCode===null)throw Error('PHYSICAL_WORKER_ALREADY_RUNNING');
    worker=spawn(process.execPath,['--import=tsx','scripts/x3/worker-once.mts'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe']});
    const started=new Date().toISOString();let logs='';
    for(const stream of [worker.stdout!,worker.stderr!])stream.on('data',b=>logs+=b);
    const result=await new Promise(yes=>worker!.once('close',(code,signal)=>yes({pid:worker!.pid,started,code,signal,logs})));
    assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(logs));workerRuns.push(result);
    res.end(JSON.stringify(result));return;
   }
   if(req.url==='/delay'&&req.method==='POST'){delay=e.http!.delay(work.workId,'application-list');res.end('{}');return;}
   if(req.url==='/delay-history'&&req.method==='POST'){
    const applications=(await e.admin.query('SELECT id FROM finnor_os.x3_applications WHERE tenant_id=$1',[tenant])).rows;assert.equal(applications.length,1);
    delay=e.http!.delay(applications[0].id,'application-history');res.end('{}');return;
   }
   if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
   if(req.url==='/release'&&req.method==='POST'){delay?.release();delay=undefined;res.end('{}');return;}
   if(req.url==='/release-error'&&req.method==='POST'){delay?.release(true);delay=undefined;res.end('{}');return;}
   if(req.url==='/grant-reviewer'&&req.method==='POST'){
    if(reviewerGrantId)await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=true WHERE id=$1',[reviewerGrantId]);
    else reviewerGrantId=(await e.admin.query('INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[tenant,principal,reviewerRoleId,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})])).rows[0].id;
    res.end('{}');return;
   }
   if(req.url==='/remove-reviewer'&&req.method==='POST'){await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE id=$1',[reviewerGrantId]);res.end('{}');return;}
   if(req.url==='/revoke'&&req.method==='POST'){await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,principal]);res.end('{}');return;}
   if(req.url==='/observe'){
    const applications=(await e.admin.query('SELECT id,work_id,status,head_release_id,build_count,mutation_count,data_bytes,deadline_at FROM finnor_os.x3_applications WHERE tenant_id=$1 ORDER BY created_at',[tenant])).rows;
    const records=(await e.admin.query('SELECT id,application_id,state,values,concurrency_revision,release_id,origin_release_id FROM finnor_os.x3_records WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
    const events=(await e.admin.query('SELECT application_id,kind,record_id,body FROM finnor_os.x3_events WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
    const observed={applications,records,events,workerRuns};await artifact(evidence,'sql-readback.json',observed);res.end(JSON.stringify(observed));return;
   }
   if(req.url==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
   res.writeHead(404);res.end('{}');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
 });
 await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const ca=control.address();assert(ca&&typeof ca!=='string');
 closeControl=async()=>{control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));};
 const portServer=createServer();await new Promise<void>(yes=>portServer.listen(0,'127.0.0.1',yes));const pa=portServer.address();assert(pa&&typeof pa!=='string');await new Promise<void>(yes=>portServer.close(()=>yes()));
 const frontendBase='http://127.0.0.1:'+pa.port;
 // Production CSP deliberately refuses a different plaintext auth origin.
 // Put only the disposable auth transport behind this same-origin front door;
 // forward emitted pages/headers unchanged, without a CSP or auth bypass.
 const frontdoor=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/',frontendBase),target=url.pathname.startsWith('/auth/v1/')?e.http!.authBase:frontendBase;
   const headers=new Headers();
   for(const [key,value] of Object.entries(req.headers))if(typeof value==='string'&&!['connection','content-length','accept-encoding'].includes(key))headers.set(key,value);
   headers.set('accept-encoding','identity');
   const chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;assert(bytes<=8*1024*1024);chunks.push(chunk);}
   const response=await fetch(target+url.pathname+url.search,{method:req.method,headers,
    body:['GET','HEAD'].includes(req.method??'GET')?undefined:Buffer.concat(chunks),redirect:'manual',signal:AbortSignal.timeout(30000)});
   const output:Record<string,string>={};
   response.headers.forEach((value,key)=>{if(!['connection','content-length','content-encoding','transfer-encoding'].includes(key))output[key]=value;});
   res.writeHead(response.status,output);
   if(response.body)await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),res);else res.end();
  }catch{if(!res.headersSent)res.writeHead(502);if(!res.writableEnded)res.end('Disposable frontend transport unavailable');}
 });
 await new Promise<void>(yes=>frontdoor.listen(0,'127.0.0.1',yes));const fa=frontdoor.address();assert(fa&&typeof fa!=='string');
 closeFrontdoor=async()=>{frontdoor.closeAllConnections();if(frontdoor.listening)await new Promise<void>(yes=>frontdoor.close(()=>yes()));};
 const base='http://127.0.0.1:'+fa.port,url=(id:string)=>base+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(root));
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=4096',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_OS_API_URL:e.http!.apiBase,NEXT_PUBLIC_SUPABASE_URL:base,NEXT_PUBLIC_SUPABASE_ANON_KEY:'r1-disposable-local-auth-key'};
 // Exercise the emitted frontend as well as the emitted API. Each fixture
 // builds with its own disposable public transport addresses; no HMR, copied
 // browser state, synthetic forms or test-auth bypass is involved.
 const buildStarted=Date.now();
 frontend=spawn(process.execPath,['node_modules/next/dist/bin/next','build'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [frontend.stdout!,frontend.stderr!])stream.on('data',b=>{logWrites=logWrites.then(()=>appendFile(join(evidence,'frontend-build.log'),b));});
 const build=await new Promise<{code:number|null;signal:string|null}>((yes,no)=>{frontend!.once('error',no);frontend!.once('close',(code,signal)=>yes({code,signal}));});
 await artifact(evidence,'frontend-build.json',{...build,wallMs:Date.now()-buildStarted,qualification:'EMITTED_NEXT16_FRONTEND_WITH_DISPOSABLE_PUBLIC_TRANSPORT_ONLY'});
 assert.equal(build.code,0,'EMITTED_FRONTEND_BUILD_FAILED');
 frontend=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(pa.port)],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [frontend.stdout!,frontend.stderr!])stream.on('data',b=>{logWrites=logWrites.then(()=>appendFile(join(evidence,'frontend.log'),b));});
 const readyUntil=Date.now()+30000;
 for(;;){
  try{if((await fetch(frontendBase+'/centropy/login',{signal:AbortSignal.timeout(1500)})).ok)break;}catch{/* Wait only for this task-owned listener. */}
  assert(Date.now()<readyUntil,'EMITTED_FRONTEND_LISTENER_UNAVAILABLE');await new Promise(yes=>setTimeout(yes,100));
 }
 const csp=(await fetch(base+'/centropy/login')).headers.get('content-security-policy');assert(csp?.includes("connect-src 'self' https: wss:"));
 const data={qualification:'EMITTED_NEXT16_WORK_FRONTEND_AND_NEXT15_API_ORDINARY_RLS_LOCAL_SIGNED_AUTH_NOT_PRODUCTION_ACTIVATION',browserTransport:'SAME_ORIGIN_DISPOSABLE_AUTH_FRONT_DOOR_UNCHANGED_PRODUCTION_CSP',csp,base,url:url(thread.id),otherUrl:url(otherThread.id),control:'http://127.0.0.1:'+ca.port,email,reviewerEmail:reviewer+'@x3.example.test',root,tenant,workId:work.workId,threadId:thread.id,specification,replacement,support,
  recordInput:{memo:'<script>window.x3Injected=true</script>',remediation:'Independent inventory and explicit follow-up',support},rerun:'FINNOR_X3_EVIDENCE_DIR=<new-absolute-directory> node --import=tsx scripts/x3/run-browser.mts; use named agent-browser session and the actual login form'};
 await artifact(evidence,'fixture.json',data);
 console.log(JSON.stringify({status:'X3_BROWSER_FIXTURE_READY',fixture:join(evidence,'fixture.json'),url:data.url,control:data.control}));
 const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
 try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);await closeControl();}
}finally{
 delay?.release();
 await closeControl?.();
 await closeFrontdoor?.();
 for(const child of [worker,frontend])if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(yes=>child.once('exit',yes)),new Promise(yes=>setTimeout(yes,3000))]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 await logWrites;await e.close();
}
