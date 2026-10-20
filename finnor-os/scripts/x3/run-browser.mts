/** Disposable mounted Work fixture. Browser verdicts are recorded separately;
 * setup, control traffic and SQL readback are not themselves browser passes. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {configureTenantVertical,receiveWork,createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {startEnvironment,artifact,repo} from './environment.mts';
import {exceptionRegister} from './business-fixtures.mts';
import {startMountedFrontend} from './mounted-fixture.mts';

const evidence=resolve(process.env.FINNOR_X3_EVIDENCE_DIR!);
assert(process.env.FINNOR_X3_EVIDENCE_DIR&&evidence.startsWith('/'));
await mkdir(evidence,{recursive:true});
const e=await startEnvironment(evidence,{builtApi:true}),tenant=randomUUID(),principal=randomUUID(),reviewer=randomUUID();
const root={entityType:'external_organization' as const,entityId:randomUUID()},email=principal+'@x3.example.test';
let mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,worker:ChildProcess|undefined,delay:ReturnType<NonNullable<typeof e.http>['delay']>|undefined,reviewerRoleId='',reviewerGrantId='';
let closeControl:(()=>Promise<void>)|undefined;
let stop!:()=>void;
const stopped=new Promise<void>(yes=>stop=yes),workerRuns:unknown[]=[];
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X3 mounted disposable firm')",[tenant,randomUUID()]);
 for(const [id,name] of [[principal,'Operator'],[reviewer,'Independent reviewer']] as const){
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active',$4)",[id,tenant,id+'@x3.example.test',name]);
  e.http!.register(id,id+'@x3.example.test','x3-disposable-only');
 }
 const authPost=async(path:string,input:unknown,token?:string)=>{
  const response=await fetch(e.http!.authBase+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
 };
 const signed=await authPost('/auth/v1/token?grant_type=password',{email,password:'x3-disposable-only'});assert.equal(signed.status,200);
 const refreshed=await authPost('/auth/v1/token?grant_type=refresh_token',{refresh_token:signed.body.refresh_token});assert.equal(refreshed.status,200);
 assert(refreshed.body.access_token!==signed.body.access_token,'Access token did not rotate');assert(refreshed.body.refresh_token!==signed.body.refresh_token,'Refresh token did not rotate');
 const replay=await authPost('/auth/v1/token?grant_type=refresh_token',{refresh_token:signed.body.refresh_token});assert.equal(replay.status,400);
 const logout=await authPost('/auth/v1/logout',{},refreshed.body.access_token);assert.equal(logout.status,200);
 const afterLogout=await authPost('/auth/v1/token?grant_type=refresh_token',{refresh_token:refreshed.body.refresh_token});assert.equal(afterLogout.status,400);
 const authBaseline=e.http!.authObservations();
 await artifact(evidence,'auth-provider-calibration.json',{status:'PASS_DISPOSABLE_AUTH_PROTOCOL',signed:signed.status,refreshed:refreshed.status,replay:replay.status,logout:logout.status,afterLogout:afterLogout.status,counters:authBaseline,credentialsRetained:false});
 e.http!.setTokenLifetimeSeconds(180);
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
 const reviewerThread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:reviewer,title:'X3 independent partner application'});
 for(const [t,w] of [[thread,work],[otherThread,otherWork]] as const)await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:principal,threadId:t.id,activeWorkId:w.workId,activeReferences:[root]});
 await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:reviewer,threadId:reviewerThread.id,activeWorkId:work.workId,activeReferences:[root]});
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
 const authorityWrites:any[]=[];
 const changeFixtureAuthority=async(operation:string,write:()=>Promise<void>)=>{
  for(let attempt=1;attempt<=3;attempt++){
   try{await write();authorityWrites.push({operation,attempt,status:'COMMITTED'});await artifact(evidence,'fixture-authority-writes.json',authorityWrites);return;}
   catch(error){
    const detail=error as {code?:string;detail?:string;where?:string};
    authorityWrites.push({operation,attempt,status:'ROLLED_BACK',code:detail.code,detail:detail.detail,where:detail.where});
    await artifact(evidence,'fixture-authority-writes.json',authorityWrites);
    if(detail.code!=='40P01'||attempt===3)throw error;
   }
  }
 };
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
   if(['/delay-history','/delay-command','/delay-record'].includes(req.url??'')&&req.method==='POST'){
    const applications=(await e.admin.query('SELECT id FROM finnor_os.x3_applications WHERE tenant_id=$1',[tenant])).rows;assert.equal(applications.length,1);
    assert(!delay,'A disposable response gate is already armed');
    const operation=req.url==='/delay-history'?'application-history':req.url==='/delay-command'?'application-command':'application-record';
    delay=e.http!.delay(applications[0].id,operation);res.end('{}');return;
   }
   if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
   if(req.url==='/release'&&req.method==='POST'){delay?.release();delay=undefined;res.end('{}');return;}
   if(req.url==='/release-error'&&req.method==='POST'){delay?.release(true);delay=undefined;res.end('{}');return;}
   if(req.url==='/grant-reviewer'&&req.method==='POST'){
    await changeFixtureAuthority('grant-reviewer',async()=>{
     if(reviewerGrantId)await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=true WHERE id=$1',[reviewerGrantId]);
     else reviewerGrantId=(await e.admin.query('INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[tenant,principal,reviewerRoleId,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})])).rows[0].id;
    });
    res.end('{}');return;
   }
   if(req.url==='/remove-reviewer'&&req.method==='POST'){await changeFixtureAuthority('remove-reviewer',async()=>{await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE id=$1',[reviewerGrantId]);});res.end('{}');return;}
   if(req.url==='/auth-long-lived'&&req.method==='POST'){e.http!.setTokenLifetimeSeconds(3600);res.end('{}');return;}
   // 150s avoids refresh on Supabase's immediate tick, but reaches its three-
   // tick threshold at the next real 30s tick, inside the held HTTP deadline.
   if(req.url==='/auth-short-lived'&&req.method==='POST'){e.http!.setTokenLifetimeSeconds(150);res.end('{}');return;}
   if(req.url==='/auth-status'&&req.method==='GET'){res.end(JSON.stringify(e.http!.authObservations()));return;}
   if(req.url==='/revoke'&&req.method==='POST'){await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,principal]);res.end('{}');return;}
   if(req.url==='/observe'){
    const applications=(await e.admin.query('SELECT id,work_id,status,head_release_id,build_count,mutation_count,data_bytes,deadline_at FROM finnor_os.x3_applications WHERE tenant_id=$1 ORDER BY created_at',[tenant])).rows;
    const records=(await e.admin.query('SELECT id,application_id,state,values,concurrency_revision,release_id,origin_release_id FROM finnor_os.x3_records WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
    const events=(await e.admin.query('SELECT application_id,kind,actor_id,record_id,body FROM finnor_os.x3_events WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
    const observed={applications,records,events,workerRuns,auth:e.http!.authObservations()};await artifact(evidence,'sql-readback.json',observed);res.end(JSON.stringify(observed));return;
   }
   if(req.url==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
   res.writeHead(404);res.end('{}');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
 });
 await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const ca=control.address();assert(ca&&typeof ca!=='string');
 closeControl=async()=>{control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));};
 mounted=await startMountedFrontend(evidence,e.http!);
 const {base,csp}=mounted,url=(id:string)=>base+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(root));
 const data={qualification:'EMITTED_NEXT16_WORK_FRONTEND_AND_NEXT15_API_ORDINARY_RLS_LOCAL_SIGNED_AUTH_NOT_PRODUCTION_ACTIVATION',browserTransport:'SAME_ORIGIN_DISPOSABLE_AUTH_FRONT_DOOR_UNCHANGED_PRODUCTION_CSP',csp,base,url:url(thread.id),otherUrl:url(otherThread.id),reviewerUrl:url(reviewerThread.id),control:'http://127.0.0.1:'+ca.port,email,reviewerEmail:reviewer+'@x3.example.test',principal,reviewer,authBaseline,root,tenant,workId:work.workId,threadId:thread.id,specification,replacement,support,
  recordInput:{memo:'<script>window.x3Injected=true</script>',remediation:'Independent inventory and explicit follow-up',support},rerun:'FINNOR_X3_EVIDENCE_DIR=<new-absolute-directory> node --import=tsx scripts/x3/run-browser.mts; use named agent-browser session and the actual login form',
  focusedRerun:'Start a fresh run-browser.mts fixture, then FINNOR_X3_BROWSER_FOCUS=rotation-pagination FINNOR_X3_EVIDENCE_DIR=<same-new-absolute-directory> node --import=tsx scripts/x3/browser-checks.mts'};
 await artifact(evidence,'fixture.json',data);
 console.log(JSON.stringify({status:'X3_BROWSER_FIXTURE_READY',fixture:join(evidence,'fixture.json'),url:data.url,control:data.control}));
 const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
 try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);await closeControl();}
}finally{
 delay?.release();
 await closeControl?.();
 await mounted?.close();
 if(worker&&worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGTERM');await Promise.race([new Promise(yes=>worker!.once('exit',yes)),new Promise(yes=>setTimeout(yes,3000))]);if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');}
 await e.close();
}
