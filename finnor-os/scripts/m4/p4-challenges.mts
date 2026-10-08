import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEvidenceSource,appendEvidenceVersion } from '@finnor/memory';
import { createMetricSeries,recordMetricObservation,restateMetricObservation } from '@finnor/private-equity';
import { PRODUCTION_JOB_CONTRACTS } from '@finnor/db/compute-contract';
import { JobQueue } from '../../apps/worker/src/queue';
import { runEvidenceDerivationJob } from '../../packages/private-equity/src/evidence-execution/worker';

/** Final cumulative source, real P4 producer and separate original SQL numeric
 * checks. This does not pretend the available M1 has its absent P4 consumer port. */
export async function p4Challenges(e:any){
  const {f,api,ok,challenge,artifact,request,queue}=e;
  await challenge('p4-final-source-replay','Actual final-source P4 output and source locator are challenged on the same current Work; source correction advances Work and requires fresh P4/M1',async()=>{
    const root={entityType:'external_organization',entityId:f.rootId},
      periodStart='2025-01-01T00:00:00.000Z',periodEnd='2025-12-31T00:00:00.000Z',validAt='2026-01-01T00:00:00.000Z';
    const source=await createEvidenceSource(f.tenant,{sourceKey:'m4:p4:'+randomUUID(),sourceType:'manual',title:'Generated original M4/P4 exact records'});
    const version=await appendEvidenceVersion(f.tenant,source.id,{content:'Exact C_01 value20 and C_010 value200 USD',snapshot:{C_01:'20',C_010:'200'},asOf:new Date(periodStart)});
    const evidence={evidenceSourceId:source.id,evidenceVersionId:version.versionId},observations:any={};
    for(const [metricKey,value]of Object.entries({C_01:'20',C_010:'200'})){
      const series=await createMetricSeries(f.ctx,{subjectType:'external_organization',subjectId:f.rootId,metricKey,
        name:'Exact generated original '+metricKey,unit:'currency',currencyCode:'USD',frequency:'annual'});
      observations[metricKey]=(await recordMetricObservation(f.ctx,{metricSeriesId:String(series.row.id),
        periodStart:new Date(periodStart),periodEnd:new Date(periodEnd),value:{type:'number',value},evidence})).row.id;
    }
    const descriptor=(metricKey:string)=>({kind:'metric',subject:root,metricKey,periodStart,periodEnd,unit:'currency',
      currencyCode:'USD',frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',
      instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'});
    const program={schema:'finnor.derivation-ir.v1',nodes:[{id:'rows',op:'source',inputId:'value'},
      {id:'value',op:'unique',input:'rows'}],outputs:['value']};
    const producerQueue=new JobQueue('m4-authentic-p4',30);
    producerQueue.register('run_evidence_derivation_v1',runEvidenceDerivationJob,PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
    const handles=ok(await api(f,'evidence-handles',{root,validAt,inputs:[{inputId:'value',source:descriptor('C_01')}]})).handles;
    const sent=ok(await api(f,'evidence-submit',{schema:'finnor.evidence-request.v1',
      question:'Return exact original C_01 amount, not C_010',root,validAt,idempotencyKey:randomUUID(),mode:'ordinary_disposable',
      inputs:handles.map((h:any)=>({inputId:h.inputId,handleId:h.id})),program,
      acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['value']}}),202);
    await producerQueue.tick();
    const produced=ok(await api(f,'evidence-read',{queryId:sent.queryId}));
    assert.equal(produced.status,'TESTED',JSON.stringify(produced));
    assert.equal(produced.derivation.result.outputs.value.value,'20');
    assert(produced.derivation.independentChecks.some((c:any)=>c.id==='numeric:value'&&c.status==='PASS'&&c.expected==='20'));
    const compile=()=>api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:sent.workId,
      source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
      resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}});
    const evaluate=(derivationId:string,expected:string)=>({kind:'P4_TERM',derivationId,output:'value',expected,unit:'currency',
      entityType:root.entityType,entityId:root.entityId,claimKind:'EXACT_SOURCE'});
    const execute=async(slice:any,derivationId:string,expected:string)=>{
      const submit=ok(await api(f,'counterexample-diagnostic-submit',{...request,workId:sent.workId,sliceRef:slice.ref,
        idempotencyKey:randomUUID(),evaluations:[evaluate(derivationId,expected)],domain:{parameters:[],maxCombination:1}}),202);
      await queue.tick();const read=ok(await api(f,'counterexample-read',{searchId:submit.searchId}));
      assert.equal(read.status,'COMPLETED',JSON.stringify(read));return {submit,read};
    };
    const slice=ok(await compile()).slice,failed=await execute(slice,produced.derivation.id,'200');
    assert.equal(failed.read.report.result,'FAILURE_WITNESS');
    assert.equal(failed.read.report.witnesses[0].validation.independent.observed,'20');
    await artifact('p4-original-challenge.json',{handles,sent,produced,slice,failed,observations});
    const closure=failed.read.report.repairDependencies;
    assert(closure.regions.some((r:any)=>r.nativeId==='value'&&r.ownerRef.id===produced.derivation.id),
      'Actual P4 output is absent from the affected fault dependency closure');
    assert(closure.regions.some((r:any)=>r.ownerRef.id===String(observations.C_01)),
      'Actual original source locator is absent from the affected fault dependency closure');
    const positive=await execute(slice,produced.derivation.id,'20');
    assert.equal(positive.read.report.result,'NO_WITNESS_WITHIN_BUDGET');
    const correction=await restateMetricObservation(f.ctx,{priorObservationId:String(observations.C_01),expectedVersion:1,
      replacement:{value:{type:'number',value:'21'},evidence}});
    const old=ok(await api(f,'counterexample-read',{searchId:failed.submit.searchId}));
    assert.equal(old.applicability.status,'STALE');assert.equal(old.report.result,'FAILURE_WITNESS');
    const staleReplay=await api(f,'counterexample-witness-replay',{searchId:failed.submit.searchId,witnessRef:old.report.witnesses[0].ref});
    assert.equal(staleReplay.status,409);
    const replay=ok(await api(f,'evidence-replay',{queryId:sent.queryId,idempotencyKey:randomUUID()}),202);
    await producerQueue.tick();const fresh=ok(await api(f,'evidence-read',{queryId:replay.queryId}));
    assert.equal(fresh.status,'TESTED',JSON.stringify(fresh));assert.equal(fresh.derivation.result.outputs.value.value,'21');
    assert.notEqual(fresh.derivation.id,produced.derivation.id);
    assert.notEqual(fresh.derivation.work.revision,produced.derivation.work.revision);
    const recompiled=ok(await compile()).slice,survives=await execute(recompiled,fresh.derivation.id,'21');
    assert.equal(survives.read.report.result,'NO_WITNESS_WITHIN_BUDGET');
    const observed={sent,produced,slice,failed,positive,correction,old,staleReplay,replay,fresh,recompiled,survives,
      qualification:'Authentic final-source P4/M1 resolved inputs; M1 has no installed P4 consumer port, genuine M3 remains pending'};
    await artifact('p4-final-source-replay.json',observed);return observed;
  });
}
