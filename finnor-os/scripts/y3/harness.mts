/** Disposable E2E control only. Success comes from real bearer routes, native
 * queue delivery and canonical SQL, not direct handler or receipt insertion. */
import {strict as assert} from 'node:assert';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {configureTenantVertical} from '@finnor/db';
import {startEnvironment,artifact,repo,hash} from '../x3/environment.mts';
import {publicProblem,bindCanonicalInputs,resourceInput} from '../y1/business-fixtures.mts';
import {interactionInput,observationSource} from './business-fixtures.mts';
import type {InteractionProblem} from '../../packages/private-equity/src/interaction-synthesis/contracts';
import {sourceCut,currentApiReceipt} from './runtime-custody.mjs';

export async function until(predicate:()=>Promise<boolean>,name:string,timeout=30000){
 const end=Date.now()+timeout;
 while(!await predicate()){assert(Date.now()<end,name);await new Promise(yes=>setTimeout(yes,10));}
}
export async function startHarness(evidence:string,built:boolean){
 await mkdir(evidence,{recursive:true});
 process.env.FINNOR_Y3_PROFILE='ordinary_disposable';process.env.FINNOR_Y1_PROFILE='ordinary_disposable';
 const directory=join(repo,'finnor-os/dist-y3'),runtime=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 assert.equal(hash(await readFile(join(directory,runtime.worker.path))),runtime.worker.sha256);
 for(const pin of runtime.assets)assert.equal(hash(await readFile(join(directory,pin.path))),pin.sha256,pin.path);
 const cut=await sourceCut();assert.equal(runtime.sourceCut?.preimageDigest,cut.preimageDigest,'Y3_EMITTED_WORKER_SOURCE_PREIMAGE_STALE');
 const apiReceipt=built?await currentApiReceipt(cut):null;
 await artifact(evidence,'installed-runtime.json',{schema:'finnor.y3.executed-runtime-custody.v1',
  source:cut,manifest:runtime,api:built?'EMITTED_NEXT15':'SOURCE_TRANSPORT_DIAGNOSTIC_ONLY',
  apiReceipt,worker:'EMITTED_ESM_WITH_ACTUAL_CREATE_WORKER',protectedQualification:false,productionActivated:false});
 process.env.FINNOR_Y3_ASSET_ROOT=join(directory,runtime.assetRoot);
 process.env.FINNOR_Y3_OWNER_ASSET_ROOT=join(directory,runtime.ownerAssetRoot);
 process.env.FINNOR_Y1_ASSET_ROOT=join(directory,runtime.y1AssetRoot);
 const e=await startEnvironment(evidence,{builtApi:built,baseHead:'0195_postx_y1_economic_action_theory.sql',keepDatabase:true});
 try{
 let worker:ChildProcess|null=null,logs='',sequence=0;
 const pending=new Map<number,{yes:(v:any)=>void;no:(err:Error)=>void}>();
 function launch(){
  assert(!worker);logs='';
  const child=worker=spawn(process.execPath,[join(directory,runtime.worker.path)],{
   cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of [child.stdout!,child.stderr!])stream.on('data',b=>{
   logs+=b;if(Buffer.byteLength(logs)>1048576)child.kill('SIGKILL');
  });
  child.on('message',(out:any)=>{
   const p=pending.get(out.id);if(p){pending.delete(out.id);out.error?p.no(Error(out.error)):p.yes(out);}
  });
  child.once('error',error=>{for(const p of pending.values())p.no(error);pending.clear();});
  child.once('close',(code,signal)=>{for(const p of pending.values())p.no(Error('Y3_WORKER_EXIT:'+code+':'+signal));pending.clear();});
  return child;
 }
 async function stopWorker(kill=false){
  const child=worker;if(!child)return;
  if(child.exitCode===null&&child.signalCode===null){
   const closed=new Promise<void>(yes=>child.once('close',()=>yes()));
   if(kill)child.kill('SIGKILL');else child.send({id:++sequence,operation:'STOP'});
   const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await closed;clearTimeout(timer);
  }
  worker=null;assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(logs),'CREDENTIAL_FREE_WORKER_EVIDENCE');
  await artifact(evidence,'workers/stopped-'+sequence+'-'+Date.now()+'.json',
   {pid:child.pid,code:child.exitCode,signal:child.signalCode,logs});logs='';
 }
 async function tick(retryEmpty=true):Promise<any>{
  if(!worker)launch();const id=++sequence;
  const value=await new Promise<any>((yes,no)=>{
   const timer=setTimeout(()=>{pending.delete(id);worker?.kill('SIGKILL');no(Error('Y3_ORIGINAL_TICK_DEADLINE'));},180000);
   pending.set(id,{yes:v=>{clearTimeout(timer);yes(v);},no:err=>{clearTimeout(timer);no(err);}});
   worker!.send({id,operation:'TICK'});
  });
  assert.equal(value.productionWorkerFactory,true);await artifact(evidence,'workers/tick-'+id+'.json',value);
  if(!value.claimed&&retryEmpty){await new Promise(yes=>setTimeout(yes,2100));return tick(false);}
  return value;
 }
 const tenant=randomUUID(),principal=randomUUID(),peer=randomUUID(),outsider=randomUUID(),
  root={entityType:'external_organization',entityId:randomUUID()},
  horizon={startAt:new Date(Date.now()-3600000).toISOString(),periodMs:7200000,periods:1},
  period={startAt:horizon.startAt,endAt:new Date(Date.parse(horizon.startAt)+horizon.periodMs).toISOString()};
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y3 disposable public firm')",[tenant,randomUUID()]);
 const emails=new Map<string,string>(),tokens=new Map<string,string>();
 for(const id of [principal,peer,outsider]){
  const email=id+'@y3.example.test';emails.set(id,email);
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,email]);
  e.http!.register(id,email);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'y3-public','Y3 public finite context','other')",[root.entityId,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'Y3:disposable'});
 for(const id of [principal,peer,outsider])tokens.set(id,await e.http!.login(id));
 const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;},
  api=(operation:string,input:unknown,who:string=principal)=>e.http!.api(tokens.get(who)!,'company-brain',operation,input),
  read=(id:string)=>api('interaction-read',{protocolId:id}).then(r=>ok(r));
 async function fixture(label:string,change?:(p:InteractionProblem)=>void){
  const input=await bindCanonicalInputs(e.admin,tenant,principal,root,publicProblem(root,period,label),label),
   accepted=ok(await api('economic-theory-submit',input.request),202);
  let view:any;
  for(let i=0;i<6;i++){
   await tick();view=ok(await api('economic-theory-read',{theoryId:accepted.theoryId}));
   if(!['QUEUED','CONSTRUCTING','CHECKING'].includes(view.status))break;
  }
  assert.equal(view.status,'CHECKED',JSON.stringify(view));ok(await api('economic-theory-admit',{theoryId:accepted.theoryId}));
  const theory={...input,accepted,view},interaction=await interactionInput(e.admin,tenant,principal,peer,root,theory,label,change);
  return {...theory,...interaction,theory};
 }
 async function compile(f:any){
  const accepted=ok(await api('interaction-submit',f.request),202);
  for(let i=0;i<6;i++){
   await tick();const view=await read(accepted.protocolId);
   if(!['QUEUED','CONSTRUCTING','CHECKING'].includes(view.status))return {...f,accepted,view};
  }
  throw Error('Y3_DURABLE_CONSTRUCTION_DID_NOT_FINISH');
 }
 async function reserve(f:any,label:string){
  const owned=ok(await e.http!.api(tokens.get(principal)!,'allocations','resource',
   {resource:resourceInput(tenant,principal,root,horizon,label)})),
   request={theoryId:f.theory.accepted.theoryId,initialState:{available:'3',committed:'2'},
    bindings:f.theory.request.problem.quantities.map((q:any)=>({quantityId:q.id,resourceRef:owned.ref})),idempotencyKey:randomUUID()},
   held=ok(await api('economic-reservation-create',request));
  return {owned,held,request};
 }
 async function terms(f:any,held:any){
  return ok(await api('interaction-terms',{protocolId:f.accepted.protocolId,reservationRef:held.origin.ref,
   expectedRevision:held.revision,idempotencyKey:randomUUID()}));
 }
 async function consent(f:any,terms:any,who:string,scope:'TERMS'|'EFFECT'='TERMS',subjectDigest=terms.ref.contentDigest,decision='ACCEPT'){
  return ok(await api('interaction-consent',{protocolId:f.accepted.protocolId,termsRef:terms.ref,scope,subjectDigest,decision,
   idempotencyKey:randomUUID()},who));
 }
 async function begin(f:any,terms:any){
  return ok(await api('interaction-start',{protocolId:f.accepted.protocolId,termsRef:terms.ref,idempotencyKey:randomUUID()}));
 }
 const runRead=(id:string,who:string=principal)=>api('interaction-run-read',{runId:id},who).then(r=>ok(r));
 async function observe(f:any,run:any,who:string=principal,key='market',value='0',date:0|1|2=0){
  const source=await observationSource(e.admin,tenant,root,f.request,who===principal?'P0':'P1',date,key,value);
  return ok(await api('interaction-observe',{runId:run.runId,expectedRevision:run.local.revision,date,key,value,
   classification:'SOURCED_FACT',source,idempotencyKey:randomUUID()},who));
 }
 async function action(run:any,actionId:string,who:string=principal){
  return ok(await api('interaction-action',{runId:run.runId,expectedRevision:run.local.revision,
   viewDigest:run.local.viewDigest,actionId,idempotencyKey:randomUUID()},who));
 }
 async function prepare(f:any,label:string){
  assert.equal(f.view.status,'CHECKED');const admission=ok(await api('interaction-admit',{protocolId:f.accepted.protocolId})),
   reservation=await reserve(f,label),exactTerms=await terms(f,reservation.held);
  await consent(f,exactTerms,principal);await consent(f,exactTerms,peer);
  let run=await begin(f,exactTerms);run=await observe(f,run);run=await action(run,'engage');
  const peerView=await runRead(run.runId,peer);run=await action(peerView,'accept',peer);
  assert.equal(run.status,'READY');assert(run.intent);
  return {f,admission,...reservation,terms:exactTerms,run};
 }
 async function materialize(p:any){
  await consent(p.f,p.terms,principal,'EFFECT',p.run.intent.ref.contentDigest);
  await consent(p.f,p.terms,peer,'EFFECT',p.run.intent.ref.contentDigest);
  return ok(await api('interaction-materialize',{runId:p.run.runId,intentRef:p.run.intent.ref,idempotencyKey:randomUUID()}));
 }
 return {e,runtime,tenant,principal,peer,outsider,root,horizon,period,emails,tokens,evidence,api,ok,read,
  fixture,compile,reserve,terms,consent,begin,runRead,observe,action,prepare,materialize,tick,launch,stopWorker,
  worker:()=>worker,close:async()=>{await stopWorker();await e.close();}};
 }catch(error){await e.close();throw error;}
}
