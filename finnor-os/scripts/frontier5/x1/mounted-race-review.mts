/** External disposable HTTP barriers. Every body comes from the real handler;
 * this controller has no producer/checker/completion substitute or product route. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';

const cases=['U2-older-refresh-cannot-replace-newer-programme',
 'U1-returned-Work-requires-new-owner-read','U3-navigation-fences-accepted-creation'] as const;
type Packet={caseId:string;path:string;method:string;requestId?:string};
export function mountedRaceReview(input:{evidence:string;sourceCommit:string;workId:string;
 origin:string;token:string;pauseWorker:()=>Promise<unknown>;guard:()=>void}){
 let gate:null|{packet:Packet;enteredAt:string|null;releasedAt:string|null;body:unknown;digest:string|null;
  promise:Promise<void>;release:()=>void;timer:ReturnType<typeof setTimeout>|null}=null;
 let failure:string|null=null,closed:unknown=null;
 const history:unknown[]=[],observations:Array<{at:string;path:string;method:string;status:number;
  observer:boolean;requestId:string|null;revision:number|null;digest:string}>=[];
 const save=async(name:string,value:unknown)=>writeFile(join(input.evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
 const api=async(operation:string,body:unknown)=>{
  const response=await fetch(input.origin+'/api/company-brain/'+operation,{method:'POST',
   headers:{authorization:'Bearer '+input.token,'content-type':'application/json','x-x1-observer':'1'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
 };
 const release=async(reason:string)=>{
  if(!gate||gate.releasedAt)return;
  gate.releasedAt=new Date().toISOString();if(gate.timer)clearTimeout(gate.timer);gate.release();
  history.push({event:'RELEASE',at:gate.releasedAt,caseId:gate.packet.caseId,digest:gate.digest,reason});
  await save('mounted-race-gates.json',history);
 };
 return {
  afterResponse:async(path:string,body:string,status:number,request:{method:string;observer:boolean})=>{
   let value:any;try{value=JSON.parse(body);}catch{return;}
   const digest=createHash('sha256').update(body).digest('hex');
   observations.push({at:new Date().toISOString(),path,method:request.method,status,observer:request.observer,
    requestId:value.requestId??value.request?.id??value.thread?.id??null,
    revision:value.revision??value.request?.revision??null,digest});
   if(!gate||gate.enteredAt||request.observer||path!==gate.packet.path||request.method!==gate.packet.method
    ||status<200||status>=300||gate.packet.requestId&&value.requestId!==gate.packet.requestId)return;
   gate.enteredAt=new Date().toISOString();gate.body=value;gate.digest=digest;
   history.push({event:'ENTER',at:gate.enteredAt,caseId:gate.packet.caseId,path,status,digest,
    actualHandlerCompleted:true,body:value});
   await save('mounted-race-gates.json',history);
   await save('mounted-race-held-'+gate.packet.caseId+'.json',{at:gate.enteredAt,path,status,body:value,digest});
   gate.timer=setTimeout(()=>{failure='MOUNTED_REAL_RESPONSE_HOLD_EXCEEDED_ORIGINAL_20_SECONDS';void release('ORIGINAL_HOLD_BOUND');},20_000);
   await gate.promise;
  },
  handle:async(req:IncomingMessage,res:ServerResponse)=>{
   const path=req.url??'';if(!path.startsWith('/review/'))return false;
   try{
    if(failure)throw Error(failure);
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)throw Error('MOUNTED_CONTROL_BODY_BOUND');}
    const body=JSON.parse(raw||'{}');
    if(path==='/review/status'){
     res.end(JSON.stringify({at:new Date().toISOString(),failure,closed:Boolean(closed),cases,
      gate:gate?{packet:gate.packet,enteredAt:gate.enteredAt,releasedAt:gate.releasedAt,body:gate.body,digest:gate.digest}:null,
      observations:observations.slice(-100)}));return true;
    }
    if(path==='/review/arm'&&req.method==='POST'){
     assert.ok([...cases,'U4-ready-principal-and-tenant-switch'].includes(body.caseId));
     assert.ok(['/api/company-brain/institution-read','/api/company-brain/institution-sources','/api/threads','/api/actions','/api/outcome-packs'].includes(body.path));
     assert.equal(body.method,'POST');assert.ok(!gate||gate.releasedAt,'one bounded physical barrier');
     let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve;});
     gate={packet:body,enteredAt:null,releasedAt:null,body:null,digest:null,promise,release:done,timer:null};
     history.push({event:'ARM',at:new Date().toISOString(),packet:body});await save('mounted-race-gates.json',history);res.end('{}');return true;
    }
    if(path==='/review/release'&&req.method==='POST'){await release('EXPLICIT_OBSERVER_RELEASE');res.end('{}');return true;}
    if(path==='/review/revise'&&req.method==='POST'){
     const sources=await api('institution-sources',{workId:input.workId});assert.equal(sources.status,200);assert.ok(sources.body.request);
     const revised=await api('institution-revise',{workId:input.workId,workInputId:sources.body.workInputId,
      parentRequestId:sources.body.request.id,grantIds:sources.body.grants.map((g:any)=>g.id),idempotencyKey:'x1-mounted-race:'+randomUUID()});
     assert.equal(revised.status,202,JSON.stringify(revised));
     await save('mounted-race-observer-revise.json',{at:new Date().toISOString(),sources,revised,actualBearerRequest:true});
     res.end(JSON.stringify(revised));return true;
    }
    if(path==='/review/pause-worker'&&req.method==='POST'){
     const observation=await input.pauseWorker();await save('mounted-race-physical-worker-pause.json',observation);res.end(JSON.stringify(observation));return true;
    }
    if(path==='/review/close'&&req.method==='POST'){
     assert.equal(body.sourceCommit,input.sourceCommit);assert.equal(body.workId,input.workId);
     assert.deepEqual(body.cases.map((c:any)=>c.id).sort(),[...cases].sort());
     assert.ok(body.cases.every((c:any)=>['PASS','FAIL','NOT_REACHED'].includes(c.status)&&c.evidence));
     await release('OBSERVER_CLOSE');closed=body;await save('mounted-races-observer-close.json',body);res.end('{}');return true;
    }
    res.writeHead(404);res.end('{}');return true;
   }catch(error){await save('mounted-race-control-failure.json',{at:new Date().toISOString(),predicate:(error as Error).message});
    res.writeHead(500);res.end(JSON.stringify({predicate:(error as Error).message}));return true;}
  },
  wait:async()=>{
   await save('mounted-race-browser-ready.json',{at:new Date().toISOString(),sourceCommit:input.sourceCommit,workId:input.workId,cases});
   for(;;){input.guard();if(failure)throw Error(failure);if(closed)break;
    await new Promise(resolve=>setTimeout(resolve,200));}
   const receipt=JSON.parse(await readFile(join(input.evidence,'mounted-races-observer-close.json'),'utf8'));
   await save('mounted-race-observations.json',observations);
   const traffic=JSON.parse(await readFile(join(input.evidence,'mounted-race-gates.json'),'utf8'));
   for(const c of receipt.cases){
    assert.ok(traffic.some((e:any)=>e.event==='ENTER'&&e.caseId===c.id),'actual successful server barrier '+c.id);
    const entered=traffic.find((e:any)=>e.event==='ENTER'&&e.caseId===c.id);
    const released=traffic.find((e:any)=>e.event==='RELEASE'&&e.caseId===c.id);
    assert.ok(released&&Date.parse(released.at)-Date.parse(entered.at)<=20000,'original response hold '+c.id);
   }
   return receipt;
  },
  close:async()=>{await release('OWNED_FIXTURE_SHUTDOWN');},
 };
}
