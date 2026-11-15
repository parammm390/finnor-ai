import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {startEnvironment} from '../../x3/environment.mts';
import {createUpstreamFixtureSupport} from '../../s5/owner-fixture.mts';
import {POST as s3Post} from '../../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../../apps/api/app/api/policies/[operation]/route';
import {allocationRef} from '../../../packages/epistemic-runtime/src/allocation-contracts';
import {readAllocationEpisodeCut} from '../../../packages/private-equity/src/allocation-experience';

const root=resolve(import.meta.dirname,'../../../..'),evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-episode-cut'));
await mkdir(evidence,{recursive:true,mode:0o700});
const started=Date.now(),observations:unknown[]=[],tokens=new Map<string,string>();
const artifact=async(name:string,value:unknown)=>{const path=join(evidence,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
process.env.FINNOR_S3_MODEL_STORE=join(evidence,'s3-owner');
process.env.FINNOR_S4_POLICY_STORE=join(evidence,'s4-owner');
const env=await startEnvironment(evidence,{commitClock:true});
try{
 const python=process.env.FINNOR_S3_PYTHON;assert(python);
 const generated=spawnSync(python,[join(root,'finnor-os/scripts/s3/reference.py')],{
  input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});
 assert.equal(generated.status,0,generated.stderr);
 const exchange=async(f:any,family:string,operation:string,body:unknown)=>{
  const response=await env.http!.api(tokens.get(f.principal)!,family,operation,body);
  observations.push({family,operation,status:response.status,ownerStatus:response.body?.status});
  assert.equal(response.status,200,JSON.stringify(response.body));return response;
 };
 const call=async(f:any,family:string,operation:string,body:unknown)=>(await exchange(f,family,operation,body)).body;
 const support=createUpstreamFixtureSupport({admin:()=>env.admin,generatedRows:JSON.parse(generated.stdout).rows,
  begin:new Date(Math.floor(Date.now()/86400000)*86400000-128*86400000).toISOString(),day:86400000,fixtures:{},artifact,
  api:(f:any,op:string,body:unknown,handler?:unknown)=>exchange(f,handler===s3Post?'interventions':handler===s4Post?'policies':'allocations',op,body)});
 const f=await support.fixture('y5-episode-census',1,[{id:'cash',unit:'USD',capacity:1000,totalLimit:1000}],{
  beforeFit:async f=>{env.http!.register(f.principal,f.name+'@s5.example.test');tokens.set(f.principal,await env.http!.login(f.principal));}});
 await support.policy(f,'negative',{cash:1});await support.policy(f,'positive',{cash:1});
 await support.resource(f,'cash','USD','STOCK',['1000','1000']);
 const beforeRequests=new Date().toISOString(),input=support.clearing(f,{negative:['-3'],positive:['5']});
 const accepted=await call(f,'allocations','clear',input);assert.equal(accepted.status,'FEASIBLE');
 const rejectedInput=structuredClone(input),{ref:_,...joint}=rejectedInput.jointModel,ids=input.policyRefs.map((r:any)=>r.id);
 const impossible={...joint,choiceConstraints:[
  {id:'require-one',policyIds:ids,minimum:1,maximum:ids.length,sourceRef:input.mandate.businessOwnerRef},
  {id:'allow-none',policyIds:ids,minimum:0,maximum:0,sourceRef:input.mandate.businessOwnerRef}]};
 rejectedInput.jointModel={...impossible,ref:allocationRef('BUSINESS_OWNER','joint-allocation-model',impossible,'s5-joint-model-v1')};
 rejectedInput.idempotencyKey='same-episode-adverse-sibling';
 const refused=await call(f,'allocations','clear',rejectedInput);assert.equal(refused.status,'INFEASIBLE');
 const request={knowledgeCut:new Date().toISOString()};
 const cut=await readAllocationEpisodeCut(f.ctx,request);
 assert.equal(cut.semanticOwner,'S5');assert.equal(cut.episodes.length,1);
 assert(cut.records.some(r=>r.kind==='REFUSAL'));assert(cut.records.some(r=>r.kind==='COST'));
 assert(cut.records.filter(r=>r.kind==='REQUEST').length>=2);
 assert(cut.acceptedAllocations.some(p=>p.certificate.ref.contentDigest===accepted.certificate.ref.contentDigest));
 assert.equal(cut.protectedReceipt,null);assert.equal(cut.businessCompletionAccepted,false);
 assert.equal((await readAllocationEpisodeCut(f.ctx,request)).cutDigest,cut.cutDigest);
 const historical=await readAllocationEpisodeCut(f.ctx,{...request,knowledgeCut:beforeRequests});
 assert(historical.futureKnowledgeExcluded.length>0);assert.equal(historical.acceptedAllocations.length,0);
 await assert.rejects(()=>readAllocationEpisodeCut(f.ctx,{...request,knowledgeCut:new Date(Date.now()+60000).toISOString()}),/KNOWLEDGE_CUT/);
 await assert.rejects(()=>readAllocationEpisodeCut(f.ctx,{...request,episodeIds:['caller-selected-head']}),/EPISODE/);
 await assert.rejects(()=>readAllocationEpisodeCut({...f.ctx,auth:{...f.ctx.auth,tenantId:randomUUID()}},request));
 await artifact('results.json',{status:'PASS',scope:'PUBLIC_SOURCE_AUTHENTICATED_ORIGINAL_S5_CENSUS_NOT_PROTECTED_SPEC_ACCEPTANCE',
  wallMs:Date.now()-started,request,accepted,refused,cut,historical,observations,
  rerun:'FINNOR_S3_PYTHON=<pinned-python> FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-episode-cut.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){await artifact('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,observations});throw error;}
finally{await env.close();}
