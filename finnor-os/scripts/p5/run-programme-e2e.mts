import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {receiveWork} from '@finnor/db';
import {createMetricSeries,recordMetricObservation,type PeMutationContext} from '@finnor/private-equity';
import {nativeFixture} from './native-fixture.mts';
import {evidence,target,atomic} from './test-support.mts';

const run=await evidence('programme'),e=await nativeFixture(),f=await target(run.directory);
const ctx:PeMutationContext={auth:{tenantId:e.tenant,userId:e.actor,employeeId:e.actor,role:'owner'},provenance:{createdBy:e.actor,sourceSystem:'P5_REGISTERED_PROGRAMME_FIXTURE'}};
let programId='',acquisitionId='',request:any,module:any,p3:any,work:any;
await run.story('actual-source-backed-P1-and-practiced-P5',[],async()=>{
 await e.admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p4',2,2,0,60,'Explicit disposable programme fixture, no S5 funding') ON CONFLICT DO NOTHING");
 await (await import('../../packages/orchestration/src/workforce-runtime')).configureAgentProfile(e.tenant,(await import('../../packages/orchestration/src/plugin-registry')).createDefaultPluginRegistry(),{
  key:'p5-programme-native',name:'Explicit disposable source-backed programme executor',actor:ctx.auth as any,
  capabilityGrants:[{kind:'query',capability:'query:harness_program_v1'},{kind:'check',capability:'check:objective_success'},{kind:'wait',capability:'wait:event'}],
  autonomyLimits:{maxActions:1,maxQueries:8,maxReplans:6,maxPlannerCalls:8,maxWallClockMs:180000},planningHints:{qualification:'DISPOSABLE_ORDINARY_UNMETERED_NO_PROTECTED_ADMISSION'}});
 const source=await createEvidenceSource(e.tenant,{sourceKey:'p5-price-reference',sourceType:'manual',title:'Independent permitted price source'}),
  version=await appendEvidenceVersion(e.tenant,source.id,{content:'Exact requested fee USD20',snapshot:{fee:'20',currency:'USD'},asOf:new Date('2025-01-01T00:00:00.000Z')}),
  series=await createMetricSeries(ctx,{subjectType:'external_organization',subjectId:e.root.entityId,metricKey:'fee',name:'Exact fee',unit:'currency',currencyCode:'USD',frequency:'annual'});
 await recordMetricObservation(ctx,{metricSeriesId:String(series.row.id),periodStart:new Date('2025-01-01T00:00:00.000Z'),periodEnd:new Date('2025-12-31T00:00:00.000Z'),
  value:{type:'number',value:'20'},evidence:{evidenceSourceId:source.id,evidenceVersionId:version.versionId}});
 const contract=(await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS;
 e.queue.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,contract.run_evidence_derivation_v1);
 e.queue.register('run_harness_program_v1',(await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob,contract.run_harness_program_v1);
 const instruction='Derive the exact source-backed fee and acquire its permitted disposable interface, with no live business effect';
 work=await e.work(f.origin,'API',instruction);
 const programRequest={schema:'finnor.harness-request.v1',instruction,root:e.root,
  workId:work.workId,workInputId:work.workInputId,idempotencyKey:randomUUID(),mode:'ordinary_disposable',validAt:'2026-01-01T00:00:00.000Z',
  sources:[{key:'fee',source:{kind:'metric',subject:e.root,metricKey:'fee',periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',
   unit:'currency',currencyCode:'USD',frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'}}],
  acceptance:{requiredSourceKeys:['fee'],targets:[{key:'fee',expression:{kind:'input',key:'fee'},unit:'currency',currencyCode:'USD'}],deliverable:{kind:'analytical_draft',title:'Permitted exact fee'}}};
 const accepted=await e.api('program-submit',programRequest);
 if(accepted.status!==202)try{await (await import('../../packages/private-equity/src/program-synthesis/api')).submitHarnessProgram(ctx,programRequest);}
 catch(error){await atomic(run.directory+'/setup-diagnostic.json',{qualification:'DIRECT_IDEMPOTENT_DISPOSABLE_DIAGNOSIS_NOT_ACCEPTANCE',message:(error as Error).message,stack:(error as Error).stack,cause:(error as {cause?:{code?:string}}).cause?.code??null});}
 assert.equal(accepted.status,202,JSON.stringify(accepted));programId=accepted.body.programId;
 let current:any;
 for(let i=0;i<30;i++){await e.queue.tick();current=await e.api('program-read',{programId});if(current.body.status==='TESTED')break;}
 assert.equal(current.body.status,'TESTED',JSON.stringify(current));assert.equal(current.body.program.result.values.fee.value,'20');
 const input={schema:'finnor.p5.acquisition-request.v1',root:e.root,workId:work.workId,sourceAccessId:work.accessId,programId,substrate:'API',mode:'ordinary_disposable',idempotencyKey:randomUUID(),
  operation:{meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()}};
 const acquired=await e.api('interface-acquire',input);assert.equal(acquired.status,202,JSON.stringify(acquired));acquisitionId=acquired.body.acquisitionId;
 const capability=await e.finish(acquisitionId);assert.equal(capability.status,'PRACTICED',JSON.stringify(capability));
 request={schema:'finnor.p1.interface-module-request.v1',programId,acquisitionId,outputKey:'fee'};
 return {programme:current.body,capability,independentReference:await f.reference()};
});
await run.story('typed-issued-module-real-P3-S6-pure-rehearsal',['P5-31','P5-33'],async()=>{
 const loaded=await e.api('program-interface-module',request);assert.equal(loaded.status,200,JSON.stringify(loaded));module=loaded.body.module;
 assert.equal(module.body.programRef.owner,'P1');assert.equal(module.body.capabilityRef.owner,'P5');assert.equal(module.body.sourceValue.value,'20');assert.equal(module.body.admission,null);
 p3=await import('../../packages/private-equity/src/branch-fabric/interface');
 const before=await f.reference(),rehearsal=await p3.rehearseProgrammeInterface(module,new AbortController().signal);
 assert.equal(rehearsal.receipt.isolated,false);assert.equal(rehearsal.receipt.observedStopped,true);assert.equal(rehearsal.protectedEligible,false);
 assert.equal(rehearsal.value.adapter.bound.path,'/ledgers/test-account/entries/C_01');assert.deepEqual(JSON.parse(rehearsal.value.adapter.bound.body),{quoted_minor:2000});
 assert.equal(rehearsal.value.observer.bound.method,'GET');assert.equal(rehearsal.value.observer.bound.body,null);
 assert.equal(rehearsal.value.adapter.receipt.authority,'NONE_OUTPUT_UNTRUSTED');
 const after=await f.reference();assert.equal(after.writes.length,1);assert.equal(after.records.C_01.price,2000);assert.equal(after.records.C_010.price,1000);
 assert.equal(after.requests.length,before.requests.length,'Pure rehearsal cannot perform even a target read');
 return {loaded,rehearsal,before,after,admission:'PENDING_INDEPENDENT_AUTHORITY'};
});
await run.story('module-integrity-limits-and-foreign-scope',['P5-09','P5-22','P5-26','P5-31','P5-34'],async()=>{
 assert.ok(module&&p3);
 const changed=structuredClone(module);changed.body.generated.adapterModule.bytes+=' ';
 await assert.rejects(()=>p3.rehearseProgrammeInterface(changed,new AbortController().signal),/MODULE|INTEGRITY/);
 await assert.rejects(()=>p3.rehearseProgrammeInterface(module,new AbortController().signal,{requiredAggregateLimits:{memoryBytes:1}}),/AGGREGATE/);
 await assert.rejects(()=>p3.rehearseProgrammeInterface(module,new AbortController().signal,{protectedExecution:true}),/PROTECTED/);
 const foreign=await e.api('program-interface-module',request,{tenant:e.foreignTenant,actor:e.foreignActor});assert.equal(foreign.status,404);assert.ok(!JSON.stringify(foreign).includes('2000'));
 const wrong=await e.api('program-interface-module',{...request,outputKey:'missing'});assert.equal(wrong.status,422);
 assert.equal((await f.reference()).writes.length,1);return {foreign,wrong,refusedBeforeExecution:true};
});
await run.story('current-interface-and-original-Work-dependencies',['P5-02','P5-21','P5-27','P5-31'],async()=>{
 await f.control({variant:'beta'});
 const stale=await e.api('program-interface-module',request);assert.equal(stale.status,422);assert.ok(!stale.body.module);
 await receiveWork({tenantId:e.tenant,userId:e.actor,workId:work.workId,instruction:'A genuinely different original Work input',channel:'console',idempotencyKey:randomUUID()});
 const old=await e.api('program-interface-module',request);assert.equal(old.status,422);assert.ok(!old.body.module);
 const retained=await f.reference();assert.equal(retained.writes.length,1);assert.equal(retained.records.C_010.price,1000);
 return {stale,old,retained,programmeContinuation:'PENDING_P7_COMMITTED_PORT'};
});
await f.close();await e.close();await run.finish();
