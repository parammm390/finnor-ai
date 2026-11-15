import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {createServer as netServer} from 'node:net';
import {mkdir,readFile,readdir,writeFile,appendFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {receiveWork,createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import type {ResolvedTotalSpecification} from '../../../packages/shared-types/src/total-algorithm-theory';
type MountedSeed={name:string;title:string;principalId:string;workId:string;threadId:string;root:{entityType:string;entityId:string}};
const pause=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms));
async function port(){
 const socket=netServer();await new Promise<void>((yes,no)=>{socket.once('error',no);socket.listen(0,'127.0.0.1',yes);});
 const address=socket.address();assert(address&&typeof address!=='string');await new Promise<void>(yes=>socket.close(()=>yes()));return address.port;
}
export async function seedMountedWork(f:{tenant:string;principal:string;root:{entityType:string;entityId:string}},workId:string,evaluator:string){
 const fresh=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',instruction:'Inspect another empty disposable Work, without reusing the other Work capsule.',
  idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:mounted-fresh'}]});
 const other=await receiveWork({tenantId:f.tenant,userId:evaluator,channel:'console',instruction:'Inspect my own disposable Work, not another principal private capsule.',
  idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:mounted-other'}]});
 const seeds:MountedSeed[]=[];
 for(const [name,principalId,id] of [['checked',f.principal,workId],['fresh',f.principal,fresh.workId],['other',evaluator,other.workId]] as const){
  const title='Y5 '+name+' '+randomUUID(),thread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:principalId,title});
  await updateEmployeeConversationThreadContext({tenantId:f.tenant,ownerEmployeeId:principalId,threadId:thread.id,activeReferences:[f.root],activeWorkId:id});
  seeds.push({name,title,principalId,workId:id,threadId:thread.id,root:f.root});
 }
 return seeds;
}
export async function seedTotalMountedWork(f:{tenant:string;principal:string;root:{entityType:string;entityId:string};
 workId:string;evaluator:string;loginEmail:string;specification:ResolvedTotalSpecification;
 tasks:{workId:string;values:string[];expected:string}[];
 resolveSpecification:(workId:string)=>Promise<ResolvedTotalSpecification>;
 recordTaskEpisode:(workId:string,taskWorkId:string,idempotencyKey:string)=>Promise<{
  result:{status:string;value:string|null};requestRef:unknown;resultRef:unknown;protectedReceipt:unknown;
  businessCompletionAccepted:boolean;reservationCreated:boolean;s6EffectsCreated:unknown[];executionAuthorityGranted:boolean}>}){
 assert.equal(f.tasks.length,2);assert(f.tasks.every(task=>task.workId!==f.workId));
 const seeds=await seedMountedWork(f,f.workId,f.evaluator);
 const cancelWork=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
  instruction:JSON.stringify({schema:'finnor.y5.work-specification.v2',definition:f.specification.definition,acceptanceReceipt:null}),
  idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:mounted-cancellation-specification'}]});
 const cancelSpecification=await f.resolveSpecification(cancelWork.workId);
 assert.deepEqual(cancelSpecification.definition,f.specification.definition);
 assert.notDeepEqual(cancelSpecification.sourceRef,f.specification.sourceRef,'CANCELLATION_SPECIFICATION_HAS_ITS_OWN_IMMUTABLE_SOURCE');
 const cancellationDevelopment=[];
 for(const [values,expected] of [[['-1','1'],'1'],[['-2','-1','4'],'3']] as const){
  const developmentTask=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
   instruction:JSON.stringify({schema:'finnor.s5.total-task-instance.v2',specificationRef:cancelSpecification.sourceRef,values}),
   idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'S5:mounted-cancellation-development-task'}]});
  const recorded=await f.recordTaskEpisode(cancelWork.workId,developmentTask.workId,'mounted-cancel-development-'+developmentTask.workId);
  assert.equal(recorded.result.status,'MODEL_ACCEPTED');assert.equal(recorded.result.value,expected);
  assert(recorded.requestRef&&recorded.resultRef);assert.equal(recorded.protectedReceipt,null);
  assert.equal(recorded.businessCompletionAccepted,false);assert.equal(recorded.reservationCreated,false);
  assert.deepEqual(recorded.s6EffectsCreated,[]);assert.equal(recorded.executionAuthorityGranted,false);
  cancellationDevelopment.push({workId:developmentTask.workId,values,recorded});
 }
 const cancelTask=await receiveWork({tenantId:f.tenant,userId:f.principal,channel:'console',
  instruction:JSON.stringify({schema:'finnor.s5.total-task-instance.v2',specificationRef:cancelSpecification.sourceRef,values:f.tasks[0]!.values}),
  idempotencyKey:randomUUID(),entityAttachments:[{...f.root,source:'Y5:mounted-cancellation-task'}]});
 for(const [name,workId] of [...f.tasks.map((task,i)=>['task-'+(i+1),task.workId]),['cancel',cancelWork.workId]]){
  const title='Y5 total '+name+' '+randomUUID(),thread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title});
  await updateEmployeeConversationThreadContext({tenantId:f.tenant,ownerEmployeeId:f.principal,threadId:thread.id,activeReferences:[f.root],activeWorkId:workId!});
  seeds.push({name:name!,title,principalId:f.principal,workId:workId!,threadId:thread.id,root:f.root});
 }
 return {seeds,typed:{schema:'finnor.y5.total-mounted-context.v1' as const,loginEmail:f.loginEmail,
  specification:f.specification,tasks:f.tasks,cancel:{workId:cancelWork.workId,taskWorkId:cancelTask.workId,
   specification:cancelSpecification,developmentTasks:cancellationDevelopment,
   qualification:'AUTHENTIC_PUBLIC_S5_MODEL_ACCEPTANCE_NOT_INDEPENDENT_BUSINESS_QUALIFICATION' as const},
  cancellationScope:'QUEUED_BEFORE_NATIVE_CLAIM_NOT_RUNNING_PROCESS_CANCELLATION' as const}};
}
export async function startMountedSession(f:{root:string;evidence:string;env:any;tenant:string;principal:string;evaluator:string;
 discoveryId:string;seeds:Awaited<ReturnType<typeof seedMountedWork>>;typed?:Awaited<ReturnType<typeof seedTotalMountedWork>>['typed'];
 artifact:(name:string,value:unknown)=>Promise<void>}){
 const sessionDeadline=Date.now()+1200000;
 if(f.typed){assert(process.argv.includes('--built-api')&&process.argv.includes('--installed-worker'),'Y5_TOTAL_MOUNTED_INSTALLED_MODES_REQUIRED');
  assert(f.env.http.builtBase(),'Y5_TOTAL_MOUNTED_BUILT_API_REQUIRED');}
 const identity=JSON.parse(await readFile(join(f.root,'finnor-os/y5-runtime/identity.json'),'utf8')),frontend=identity.frontend;
 assert(frontend?.origin&&frontend.serverPath);const origin=new URL(frontend.origin);
 assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert(origin.port);
 const privateDirectory=join(f.evidence,'mounted-private'),controlDirectory=join(f.evidence,'mounted-control');
 await mkdir(privateDirectory,{mode:0o700});await mkdir(controlDirectory,{mode:0o700});
 const internalPort=await port(),log=join(f.evidence,'mounted-frontend.log');
 await writeFile(log,'',{mode:0o600});
 const child=spawn(process.execPath,[join(f.root,frontend.serverPath)],{cwd:join(f.root,'.next-x1-install/standalone'),detached:true,stdio:['ignore','pipe','pipe'],
  env:{PATH:process.env.PATH,HOME:privateDirectory,TMPDIR:privateDirectory,LANG:'C',TZ:'UTC',NODE_ENV:'production',
   NEXT_TELEMETRY_DISABLED:'1',HOSTNAME:'127.0.0.1',PORT:String(internalPort),NODE_OPTIONS:'--max-old-space-size=2048',
   FINNOR_OS_API_URL:f.env.http.apiBase,FINNOR_ENVIRONMENT:'ordinary_disposable'}});
 let logs='',flush=Promise.resolve(),logFailure:unknown;
 child.once('error',error=>{logs+=' '+String(error);});
 for(const stream of [child.stdout!,child.stderr!])stream.on('data',bytes=>{
  logs=(logs+bytes.toString()).slice(-16384);flush=flush.then(()=>appendFile(log,bytes)).catch(error=>{logFailure=error;});
 });
 const ended=new Promise<void>(yes=>child.once('close',()=>yes()));
 let edge:ReturnType<typeof httpServer>|undefined,held:ReturnType<typeof f.env.http.delay>|undefined,closed=false,sequence=0;
 let suspended=false,transportSequence=0,observationError:unknown;
 const transport:{sequence:number;path:string;input:unknown;startedAt:string;status:number|null;responseBytes:number;complete:boolean}[]=[];
 const seen=new Set<string>();
 const close=async()=>{
  if(closed)return;closed=true;held?.release();
  let restorationError:unknown;
  if(suspended)try{await f.env.admin.query('UPDATE finnor_os.users SET status=$1 WHERE tenant_id=$2 AND id=$3',['active',f.tenant,f.principal]);suspended=false;}
  catch(error){restorationError=error;}
  if(edge)await new Promise<void>(yes=>{edge!.closeAllConnections();edge!.close(()=>yes());});
  if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid!,'SIGTERM');}catch{}
   await Promise.race([ended,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid!,'SIGKILL');}catch{}await ended;}}
  await flush;if(logFailure)throw logFailure;
  await f.artifact('mounted-runtime-close.json',{status:restorationError?'FAIL_PRINCIPAL_RESTORATION':'CLOSED',exitCode:child.exitCode,signal:child.signalCode,
   desktopBrowserClosed:false,principalStillSuspended:suspended,restorationError:restorationError?String(restorationError):null});
  if(restorationError)throw restorationError;
  if(observationError)throw observationError;
 };
 const snapshot=async(checkpoint:string)=>{
  const discovery=(await f.env.admin.query('SELECT id,work_id,principal_id,status,attempt_count,use_count,deadline_at,result_digest FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,f.discoveryId])).rows[0];
  const uses=(await f.env.admin.query('SELECT id,status,body FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2 ORDER BY created_at,id',[f.tenant,f.discoveryId])).rows;
  const effects=(await f.env.admin.query('SELECT id,status,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY id',[f.tenant])).rows;
  const reservations=(await f.env.admin.query('SELECT reservation_id,status,revision,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',[f.tenant])).rows;
  const principals=(await f.env.admin.query('SELECT id,status,role FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.tenant,[f.principal,f.evaluator]])).rows;
  const threads=(await f.env.admin.query('SELECT id,owner_employee_id,active_work_id,active_references FROM finnor_os.employee_conversation_threads WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.tenant,f.seeds.map(s=>s.threadId)])).rows;
  const relatedDiscoveries=f.typed?(await f.env.admin.query('SELECT id,work_id,status,generation,attempt_count,use_count,max_attempts,max_uses,deadline_at FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY id',[f.tenant,f.principal,f.typed.cancel.workId])).rows:[];
  const cancellationEvents=f.typed?(await f.env.admin.query("SELECT discovery_id,kind,body FROM finnor_os.y5_events WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=ANY($3::uuid[]) AND kind IN ('CANCELLED','CANCEL_OBSERVED_TERMINAL') ORDER BY id",[f.tenant,f.principal,relatedDiscoveries.map((row:any)=>row.id)])).rows:[];
  if(observationError)throw observationError;
  const extra=f.typed?{relatedDiscoveries,cancellationEvents,transport,transportSequence}:{};
  await f.artifact(`mounted-canonical-${++sequence}-${checkpoint}.json`,{checkpoint,source:'CANONICAL_SQL',discovery,uses,effects,reservations,principals,threads,
   heldResponseWaiting:held?.waiting()??false,auth:f.env.http.authObservations(),...extra});
  return {discovery,uses,effects,reservations,principals,threads,heldResponseWaiting:held?.waiting()??false,...extra};
 };
 try{
  const until=Date.now()+30000;
  while(!logs.includes('Ready in')){assert(child.exitCode===null&&child.signalCode===null,'Y5_MAINTAINED_FRONTEND_EXITED:'+logs);assert(Date.now()<until,'Y5_MAINTAINED_FRONTEND_START_DEADLINE');await pause(30);}
  const auth=new URL(f.env.http.authBase);
  edge=httpServer((req,res)=>{
   const path=new URL(req.url??'/','http://127.0.0.1').pathname;
   const observe=f.typed&&req.method==='POST'&&/^\/api\/centropy\/uniform-algorithms\/(?:read|list|specification|consume-total|submit-total|cancel)$/.test(path);
   const entry=observe?{sequence:++transportSequence,path,input:null as unknown,startedAt:new Date().toISOString(),status:null as number|null,responseBytes:0,complete:false}:null;
   if(entry){
    if(transport.length>=2048)observationError=Error('Y5_TOTAL_MOUNTED_TRANSPORT_BOUND');else transport.push(entry);
    const chunks:Buffer[]=[];let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size<=32768)chunks.push(Buffer.from(chunk));else observationError=Error('Y5_TOTAL_MOUNTED_REQUEST_OBSERVATION_BOUND');});
    req.on('end',()=>{try{entry.input=JSON.parse(Buffer.concat(chunks).toString());}catch{observationError=Error('Y5_TOTAL_MOUNTED_REQUEST_JSON');}});
   }
   const target=(req.url??'/').startsWith('/auth/v1/')?auth:new URL('http://127.0.0.1:'+internalPort);
   const proxy=httpRequest({hostname:'127.0.0.1',port:target.port,path:req.url,method:req.method,headers:{...req.headers,host:target.host}},reply=>{
    if(entry){entry.status=reply.statusCode??502;reply.on('data',bytes=>{entry.responseBytes+=bytes.length;});reply.on('end',()=>{entry.complete=true;});}
    res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);
   });
   proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>proxy.destroy());req.pipe(proxy);
  });
  await new Promise<void>((yes,no)=>{edge!.once('error',no);edge!.listen(Number(origin.port),'127.0.0.1',yes);});
  const response=await fetch(origin.origin+'/centropy/login',{redirect:'manual',signal:AbortSignal.timeout(30000)});await response.arrayBuffer();assert.equal(response.status,200);
  await f.artifact('mounted-ready.json',{status:'READY_FOR_ASSIGNED_VISIBLE_BROWSER',origin:origin.origin,seeds:f.seeds,tenant:f.tenant,principal:f.principal,evaluator:f.evaluator,
   discoveryId:f.discoveryId,productionFrontend:true,serverPath:frontend.serverPath,frontendIdentity:frontend,
   controlDirectory,authentication:'REAL_SUPABASE_SDK_TO_TRANSPARENT_SAME_ORIGIN_LOCAL_GOTRUE_FIXTURE',productionCspChanged:false,
   authBypass:false,hostedAuthQualified:false,projectionHost:false,...(f.typed?{typed:f.typed,sessionDeadline:new Date(sessionDeadline).toISOString()}: {})});
  await snapshot('ready');
  return {close,snapshot,wait:async(phase:'current'|'withdrawn')=>{
   await f.artifact('mounted-phase.json',{phase,status:'WAITING_FOR_EXPLICIT_BROWSER_CHECKS',origin:origin.origin,controlDirectory});
   const deadline=f.typed?sessionDeadline:Date.now()+1200000;
   for(;;){
    assert(Date.now()<deadline,'Y5_MOUNTED_CONTROL_DEADLINE');assert(child.exitCode===null&&child.signalCode===null,'Y5_MOUNTED_FRONTEND_LOST');
    for(const name of (await readdir(controlDirectory)).filter(name=>/^[a-z0-9-]+\.json$/.test(name)&&!name.endsWith('.result.json')).sort()){
     if(seen.has(name))continue;seen.add(name);
     const raw=await readFile(join(controlDirectory,name),'utf8');assert(Buffer.byteLength(raw)<=1024,'Y5_CONTROL_BOUND');
     const command=JSON.parse(raw),checkpoint=name.slice(0,-5);let done=false;
     assert(['snapshot','hold-read','release-read','suspend-principal','resume-principal','finish-phase',...(f.typed?['await-polls','await-held','await-late-read']:[])].includes(command.operation),'Y5_EXPLICIT_CONTROL_OPERATION_REQUIRED');
     if(command.operation==='hold-read'){assert(!held,'Y5_ALREADY_HELD');held=f.env.http.delay(f.discoveryId,'read');}
     if(command.operation==='release-read'){held?.release();held=undefined;}
     if(command.operation==='await-polls'||command.operation==='await-late-read'){
      assert(Number.isSafeInteger(command.after)&&command.after>=0,'Y5_TOTAL_POLL_WATERMARK_REQUIRED');
      const until=Math.min(deadline,Date.now()+15000);
      while(transport.filter(entry=>entry.sequence>command.after&&entry.path.endsWith('/read')&&entry.complete&&entry.status===200&&
       (entry.input as any)?.discoveryId===f.discoveryId&&!(entry.input as any)?.includeCapsule&&!(entry.input as any)?.includeHistory).length<(command.operation==='await-polls'?2:1)){
       assert(Date.now()<until,'Y5_TOTAL_TWO_REAL_LIGHTWEIGHT_POLLS_REQUIRED');await pause(50);
      }
     }
     if(command.operation==='await-held'){
      const until=Math.min(deadline,Date.now()+15000);
      while(!held?.waiting()){assert(Date.now()<until,'Y5_TOTAL_ACTUAL_OWNER_RESPONSE_HOLD_REQUIRED');await pause(50);}
     }
     if(command.operation==='suspend-principal'||command.operation==='resume-principal'){
      assert.equal(phase,'withdrawn','NATIVE_REVOCATION_ONLY_AFTER_ORIGINAL_S8_P7_AND_S6_CHECKS');
      if(command.operation==='suspend-principal')suspended=true;
      await f.env.admin.query('UPDATE finnor_os.users SET status=$1 WHERE tenant_id=$2 AND id=$3',[command.operation==='suspend-principal'?'suspended':'active',f.tenant,f.principal]);
      suspended=command.operation==='suspend-principal';
     }
     if(command.operation==='finish-phase'){if(f.typed)assert(!held&&!suspended,'Y5_TOTAL_RESTORE_FAULTS_BEFORE_PHASE_FINISH');done=true;}
     const canonical=await snapshot(checkpoint);
     const pendingResult=join(controlDirectory,checkpoint+'.result.pending');
     await writeFile(pendingResult,JSON.stringify({operation:command.operation,phase,status:'OBSERVED_NOT_BROWSER_QUALIFICATION',canonical},null,2)+'\n',{mode:0o600,flag:'wx'});
     await rename(pendingResult,join(controlDirectory,checkpoint+'.result.json'));
     if(done)return;
    }
    await pause(100);
   }
  }};
 }catch(error){await close();throw error;}
}
