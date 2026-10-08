/** Real S1/S3/S4/S5 owners and P1 continuation; public mechanics, no admission. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {createMetricSeries,recordMetricObservation} from '@finnor/private-equity';
import {receiveWork} from '@finnor/db';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mjs';
import {publicReference} from '../m1/reference.mjs';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as modelPost} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as companyPost} from '../../apps/api/app/api/company-brain/[operation]/route';

export async function capitalOwnerComposition(e:{admin:any;queue:any;evidence:string;repo:string}){
 const {admin,queue,evidence,repo}=e,output=join(evidence,'capital');await mkdir(output,{recursive:true});
 const artifact=async(path:string,body:unknown)=>{const target=join(output,path);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,JSON.stringify(body,null,2)+'\n');};
 const api=async(f:any,op:string,body:unknown,handler=companyPost)=>{const response=await handler(new Request('http://localhost/api/'+(handler===allocationPost?'allocations/':'company-brain/')+op,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation:op})});return {status:response.status,body:await response.json()};};
 const success=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 const day=86400000,fixtures:Record<string,any>={},periodStart='2025-01-01T00:00:00.000Z',periodEnd='2025-12-31T00:00:00.000Z';
 const visible={A:{EV:'120',EBITDA:'20',debt:'70',payoff:'20'},B:{EV:'100',EBITDA:'25',debt:'50',payoff:'18'},C:{EV:'90',EBITDA:'15',debt:'45',payoff:'14'}};
 const support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures,artifact,
  api:async(f:any,op:string,body:any,handler=allocationPost)=>{
   if(op==='fit'&&!f.financial){
    f.fitRequest=body.request;f.work=await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Produce the current owner bound baseline planned capital analytical draft with capped debt, equity, leverage and S5 selected payoff; no acquisition/effect authority.',channel:'console',idempotencyKey:randomUUID()});
 await (await import('../../packages/orchestration/src/workforce-runtime')).configureAgentProfile(f.tenant,(await import('../../packages/orchestration/src/plugin-registry')).createDefaultPluginRegistry(),{key:'p1-capital-native',name:'Explicit disposable capital draft executor',actor:f.ctx.auth,capabilityGrants:[{kind:'query',capability:'query:harness_program_v1'},{kind:'check',capability:'check:objective_success'},{kind:'wait',capability:'wait:event'}],autonomyLimits:{maxActions:1,maxQueries:8,maxReplans:6,maxPlannerCalls:8,maxWallClockMs:3600000}});

    const source=await createEvidenceSource(f.tenant,{sourceKey:'p1-capital-visible',sourceType:'manual',title:'Owner supplied planned capital alternatives; no acquisition execution'}),version=await appendEvidenceVersion(f.tenant,source.id,{content:JSON.stringify(visible),snapshot:{worldRoot:f.root,visible,leverageCaps:['3.5','3.0'],qualification:'PUBLIC_HYPOTHETICAL_CANDIDATES'},asOf:new Date(periodStart)});
    f.financial={};const entries=Object.entries(visible).flatMap(([name,row])=>Object.entries(row).map(([key,value])=>({key:name+'_'+key,value,unit:'currency',currencyCode:'USD'}))).concat([{key:'cap35',value:'3.5',unit:'multiple',currencyCode:null},{key:'cap30',value:'3.0',unit:'multiple',currencyCode:null}] as any);
    for(const entry of entries){const series=await createMetricSeries(f.ctx,{subjectType:f.root.entityType,subjectId:f.root.entityId,metricKey:entry.key,name:entry.key,unit:entry.unit,currencyCode:entry.currencyCode??undefined,frequency:'annual'});const observation=await recordMetricObservation(f.ctx,{metricSeriesId:String(series.row.id),periodStart:new Date(periodStart),periodEnd:new Date(periodEnd),value:{type:'number',value:entry.value},evidence:{evidenceSourceId:source.id,evidenceVersionId:version.versionId}});f.financial[entry.key]={seriesId:series.row.id,observationId:observation.row.id,...entry};}
   }
   if(op==='resource'){const response=await api(f,op,{...body,expectedRef:f.currentResource?.ref??null},handler);if(response.status===200)f.currentResource=response.body;return response;}
   return api(f,op,body,handler);
  }});
 const owner=await support.fixture('p1-capital-'+randomUUID(),1,[{id:'cash',unit:'USD',capacity:95,totalLimit:95}]);

 const input=(key:string)=>({kind:'input',key}),binary=(kind:string,left:any,right:any)=>({kind,left,right});
 let first:any,previous:any,currentWork:string|undefined,previousAllocation:any,lastRequest:any;
 const observations:any[]=[];
 for(const [name,cap,reserved]of[['baseline',35n,0n],['tightened',30n,0n],['reserved',35n,25n]] as const){
  const released=previousAllocation?success(await api(owner,'release',{allocationRef:previousAllocation,idempotencyKey:'release-untouched-'+name},allocationPost)):null;
  if(released)assert.equal(released.reservation.status,'RELEASED');
  const instruction='Produce the current owner bound '+name+' planned capital analytical draft with capped debt, equity, leverage and S5 selected payoff; no acquisition/effect authority.';
  const steering=currentWork?await receiveWork({tenantId:owner.tenant,userId:owner.principal,workId:currentWork,instruction,channel:'console',idempotencyKey:randomUUID()}):owner.work;
  if(currentWork){const refreshed=success(await api(owner,'fit',{request:owner.fitRequest},modelPost));assert.equal(refreshed.status,'FITTED');owner.model=refreshed.model;}
  owner.policies=[];owner.labels={};const oracle=publicReference(cap,reserved);

  for(const row of oracle.rows)await support.policy(owner,row.id,{cash:Number(row.equity)});
  owner.resources=[];await support.resource(owner,'cash','USD','STOCK',['95','95']);
  let reserve:any=null;if(reserved){const hold=await support.policy(owner,'R',{cash:25});reserve=success(await api(owner,'clear',support.clearing(owner,{R:['1']},[],[],[hold]),allocationPost));assert.equal(reserve.status,'FEASIBLE');}
  const policies=owner.policies.filter((p:any)=>owner.labels[p.ref.id]!=='R'),clear=success(await api(owner,'clear',support.clearing(owner,{A:['20'],B:['18'],C:['14']},[],[],policies),allocationPost));assert.equal(clear.status,'FEASIBLE',JSON.stringify(clear));
  const selected=clear.certificate.check.selectedPolicyIds.map((id:string)=>owner.labels[id]).sort();assert.deepEqual(selected,oracle.selected);assert.equal(clear.certificate.optimization.incumbent,oracle.payoff);
  const capKey=cap===35n?'cap35':'cap30',keys=Object.keys(owner.financial).filter(k=>!k.startsWith('cap')),sources=[...keys,'leverageCap'].map(key=>{const entry=owner.financial[key==='leverageCap'?capKey:key];return {key,source:{kind:'metric',subject:owner.root,metricKey:entry.key,periodStart,periodEnd,unit:entry.unit,currencyCode:entry.currencyCode,frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'}};});
  const targets:any[]=[];for(const label of ['A','B','C']){const debt=binary('min',input(label+'_debt'),binary('multiply',input(label+'_EBITDA'),input('leverageCap')));targets.push({key:label+'_cappedDebt',expression:debt,unit:'currency',currencyCode:'USD'},{key:label+'_equity',expression:binary('subtract',input(label+'_EV'),debt),unit:'currency',currencyCode:'USD'},{key:label+'_leverage',expression:binary('ratio',debt,input(label+'_EBITDA')),unit:'multiple',currencyCode:null},{key:label+'_payoff',expression:input(label+'_payoff'),unit:'currency',currencyCode:'USD'});}
  targets.push({key:'selectedPayoff',expression:selected.map((label:string)=>input(label+'_payoff')).reduce((a:any,b:any)=>binary('add',a,b)),unit:'currency',currencyCode:'USD'});
  const request={schema:'finnor.harness-request.v1',root:owner.root,mode:'ordinary_disposable',instruction,validAt:new Date().toISOString(),idempotencyKey:randomUUID(),...(steering?{workId:steering.workId,workInputId:steering.workInputId,...(previous?{parentProgramId:previous.programId}:{})}:{}),sources,acceptance:{requiredSourceKeys:sources.map(s=>s.key),targets,deliverable:{kind:'analytical_draft',title:'Planned capital '+name+'; S4/S5 owned selection'}},ownerBindings:{policyRef:policies[0].ref,allocationRef:clear.certificate.ref},limits:{maxCandidates:8,maxAttempts:8,maxSteps:4096,deadlineMs:1800000}};
  const p=success(await api(owner,'program-submit',request),202);currentWork=p.workId;let read:any;
  for(let i=0,until=Date.now()+180000;i<600&&Date.now()<until;i++){await queue.tick();read=success(await api(owner,'program-read',{programId:p.programId}));if(['TESTED','FAILED','INVALIDATED','PARTIAL'].includes(read.status))break;await new Promise(r=>setTimeout(r,50));}
  const ownerBoundary:any={read,jobs:(await admin.query("SELECT id,type,status,attempts,last_error,claim_fence FROM finnor_os.jobs WHERE payload->>'workId'=$1 OR payload->>'programId'=$2",[p.workId,p.programId])).rows,activity:(await admin.query("SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blocking,query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows,events:(await admin.query('SELECT kind,body FROM finnor_os.p1_events WHERE request_id=$1 ORDER BY created_at,id',[p.programId])).rows};for(const [label,module,method,ref]of [['S4','../../packages/private-equity/src/enterprise-control','validateEnterpriseContingentPolicy',policies[0].ref],['S5','../../packages/private-equity/src/enterprise-allocation','validateEnterpriseAllocation',clear.certificate.ref]] as const){try{ownerBoundary[label]=await (await import(module))[method](owner.ctx,ref);}catch(error){ownerBoundary[label]={message:String(error),cause:(error as any).cause?.message??null};}}await artifact(name+'-boundary.json',ownerBoundary);
  assert.equal(read.status,'TESTED',JSON.stringify({status:read.status,reason:read.reason}));assert.equal(read.program.result.values.selectedPayoff.value,oracle.payoff);
  for(const row of oracle.rows){assert.equal(read.program.result.values[row.id+'_cappedDebt'].value,row.debt);assert.equal(read.program.result.values[row.id+'_equity'].value,row.equity);}
  for(const bound of ['S4','S5'])assert(read.program.semanticBindings.some((b:any)=>b.owner===bound&&b.validity.status==='CURRENT'));
  const delivered=success(await api(owner,'program-artifact',{programId:p.programId})),bytes=Buffer.from(delivered.bytesBase64,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),delivered.sha256);await writeFile(join(output,name+'.docx'),bytes);const ir=await (await import('@finnor/artifacts')).interpret(bytes);assert(JSON.stringify(ir).includes(oracle.payoff));
  if(first){assert.equal(read.program.bounds.episodeId,first.program.bounds.episodeId);assert.equal(read.program.bounds.deadlineAt,first.program.bounds.deadlineAt);assert(read.program.costs.attempts>first.program.costs.attempts);assert.deepEqual(read.program.parents,[previous.programId]);const stale=success(await api(owner,'program-read',{programId:previous.programId}));assert.equal(stale.status,'INVALIDATED');assert.equal(stale.program,null);}
  first??=read;previous=p;previousAllocation=clear.certificate.ref;lastRequest=request;observations.push({name,oracle,selected,clear,reserve,released,request,p,read,artifact:{...delivered,bytesBase64:undefined},ir});await artifact(name+'.json',observations.at(-1));
 }
 const episode=(await admin.query('SELECT max_candidates,candidates_used,max_attempts,attempts_used,max_steps,steps_used,deadline_at FROM finnor_os.p1_episodes WHERE id=$1',[first.program.bounds.episodeId])).rows[0];assert.equal(episode.max_candidates,8);assert.equal(episode.candidates_used,6);assert(episode.attempts_used<=8);
 const history=(await admin.query('SELECT status,revision FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',[owner.tenant])).rows;assert(history.filter((r:any)=>r.status==='RELEASED').length>=2);assert(history.some((r:any)=>r.status==='RESERVED'));
 await artifact('episode-and-reservation-history.json',{episode,history,workId:currentWork,qualification:'PUBLIC_MECHANICAL_COMPOSITION_NO_ACQUISITIONS_OR_P7_PUBLICATION'});
 const allOwnerOperations=await (await import('./owner-operations-fixture.mts')).runOwnerOperations(e,owner,lastRequest,api,artifact);
 return {allOwnerOperations,owner:{tenant:owner.tenant,principal:owner.principal,root:owner.root,modelRef:owner.model.ref},observations,episode,history};
}
