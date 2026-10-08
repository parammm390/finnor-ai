/** Actual S6 unknown state, never a synthetic SQL liability fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { receiveWork } from '@finnor/db';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { proveGovernedDispatch } from '../s6/governed-dispatch-proof.mjs';
import { POST as allocationPost } from '../../apps/api/app/api/allocations/[operation]/route';
import { POST as policyPost } from '../../apps/api/app/api/policies/[operation]/route';
import { POST as obligationPost } from '../../apps/api/app/api/obligations/[operation]/route';
import { authorizedSearch } from '../../packages/private-equity/src/counterexample-search/service';

export async function liabilityChallenges(e:any){
  const {repo,admin,api,ok,artifact,challenge,request,queue}=e;
  await challenge('authentic-s6-unknown-liability-and-readonly-replay',
    'A real lost S6 provider response retains native responsibility; M4 replay/cancel/repair never PATCH and actual settlement invalidates the historical slice',async()=>{
    const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{
      input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:10000,maxBuffer:1048576});
    assert.equal(generated.status,0,generated.stderr);
    const day=86400000,support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,
      begin:new Date(Date.now()-128*day).toISOString(),day,fixtures:{},artifact,
      api:(f:any,op:string,body:unknown,handler=allocationPost)=>api(f,op,body,handler)});
    const f=await support.fixture('m4-s6-'+randomUUID().slice(0,8),2,[
      {id:'cash',unit:'USD',capacity:100,totalLimit:100},
      {id:'execution',unit:'request',capacity:200,totalLimit:200,resourceClass:'COMPUTE'},
      {id:'human',unit:'seconds',capacity:4,totalLimit:4,resourceClass:'HUMAN_ATTENTION'}]);
    const policy=await support.policy(f,'price',{cash:25,execution:130,human:4});
    await support.resource(f,'cash','USD','STOCK',['100','100','100']);
    await support.resource(f,'execution','request','CUMULATIVE_EXPENDITURE',['200','200','200']);
    await support.resource(f,'human','seconds','CUMULATIVE_EXPENDITURE',['4','4','4']);
    const allocated=ok(await api(f,'clear',support.clearing(f,{price:['100']}),allocationPost));
    assert.equal(allocated.status,'FEASIBLE');
    const handoff=ok(await api(f,'handoff',{policyRef:policy.ref,allocationRef:allocated.certificate.ref,
      decision:support.decision(f,allocated.certificate.ref)},policyPost));
    const obligation=ok(await api(f,'prepare',{preparationRef:handoff.preparationRef,
      allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef},obligationPost));
    const nativeState=async()=>(await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY reservation_id) FROM finnor_os.s5_reservations r WHERE tenant_id=$1) reservations,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY consumption_id) FROM finnor_os.s5_consumption_states r WHERE tenant_id=$1) consumptions,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM finnor_os.business_effects r WHERE tenant_id=$1) effects`,[f.tenant])).rows;
    let unknownRead:any,repairRead:any,unknownProof:any;
    const intercept=async(name:string,value:any)=>{
      await artifact('s6/'+name,value);
      if(name!=='dispatch-before-crash.json')return;
      assert.equal(value.accepted.body.status,'UNRESOLVED');
      const before=await nativeState();
      assert.equal(before[0].consumptions[0].status,'UNKNOWN_OUTCOME');
      assert.equal(before[0].reservations[0].status,'UNKNOWN_OUTCOME');
      assert.equal(value.requests.filter((r:any)=>r.method==='PATCH').length,1);
      const work=await receiveWork({tenantId:f.tenant,userId:f.principal,
        instruction:'Read-only challenge of original policy with authentic S6 unknown responsibility',channel:'console'});
      const slice=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:work.workId,
        source:{kind:'POLICY',policyRefs:[policy.ref]},purpose:'MODEL_EVIDENCE',
        resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
      const body={...request,workId:work.workId,sliceRef:slice.ref,idempotencyKey:randomUUID(),
        evaluations:[{kind:'POLICY_BOUND',policyId:policy.ref.id,minimum:'10000',unit:'USD',claimKind:'MODEL_WORST_CASE'}],
        domain:{parameters:[],maxCombination:1}};
      const sent=ok(await api(f,'counterexample-diagnostic-submit',body),202);
      await queue.tick();unknownRead=ok(await api(f,'counterexample-ledger',{searchId:sent.searchId}));
      await artifact('s6/m4-initial-read.json',unknownRead);
      assert.equal(unknownRead.status,'COMPLETED',JSON.stringify(unknownRead));
      assert.equal(unknownRead.report.result,'FAILURE_WITNESS');
      assert(unknownRead.report.unresolved.some((g:any)=>g.reason==='S6_OUTSTANDING_EFFECT_LIABILITY_UNKNOWN'));
      const {frozen}=await authorizedSearch(f.ctx,sent.searchId);
      assert(frozen.binding.obligations.some((o:any)=>o.id===obligation.effectRef.id));
      assert(frozen.binding.resourceSnapshot?.outstanding.some((o:any)=>o.status==='UNKNOWN_OUTCOME'));
      const regions=frozen.faultGraph.nodes;
      assert(frozen.graph.roots.some((r:any)=>r.criterion==='UNRECONCILED_NATIVE_EFFECT_LIABILITY'));
      assert(regions.some((r:any)=>r.qualification==='CROSS_MANDATE_RESERVATION_UNKNOWN_OUTCOME_AND_RECOVERY'));
      const replay=ok(await api(f,'counterexample-witness-replay',{searchId:sent.searchId,
        witnessRef:unknownRead.report.witnesses[0].ref}));
      assert(replay.reproduced);assert.equal(replay.effectReexecuted,false);
      const repaired=ok(await api(f,'counterexample-repair-request',{searchId:sent.searchId,
        replacement:{...body,idempotencyKey:randomUUID(),
          evaluations:[{...body.evaluations[0],minimum:'-1000'}]}}),202);
      await queue.tick();repairRead=ok(await api(f,'counterexample-read',{searchId:repaired.searchId}));
      await artifact('s6/m4-repair-read.json',repairRead);
      assert.equal(repairRead.status,'COMPLETED',JSON.stringify(repairRead));
      assert.equal(repairRead.report.result,'NO_WITNESS_WITHIN_BUDGET');
      assert(repairRead.report.unresolved.some((g:any)=>g.reason==='S6_OUTSTANDING_EFFECT_LIABILITY_UNKNOWN'));
      ok(await api(f,'counterexample-cancel',{searchId:repaired.searchId}));
      assert.deepEqual(await nativeState(),before,'M4 changed an authentic unknown business responsibility');
      assert.equal(value.requests.filter((r:any)=>r.method==='PATCH').length,1,'M4 re-executed the original native effect');
      unknownProof={before,slice,unknownRead,repairRead,replay,regions,
        qualification:'AUTHENTIC_S6_DISPOSABLE_PROTECTED_UNKNOWN; NO_LIVE_PROVIDER_OR_MONEY_ADMISSION'};
      await artifact('s6/m4-during-unknown.json',unknownProof);
    };
    const proof=await proveGovernedDispatch(f,obligation,api,admin,intercept);
    assert(unknownRead&&repairRead&&unknownProof,'The actual protected unknown window was not challenged');
    assert.equal(proof.requests.filter((r:any)=>r.method==='PATCH').length,1);
    const historical=ok(await api(f,'counterexample-read',{searchId:unknownRead.searchId}));
    assert.equal(historical.applicability.status,'STALE');
    assert.equal(historical.report.ref.contentDigest,unknownRead.report.ref.contentDigest);
    const refused=await api(f,'counterexample-witness-replay',{searchId:unknownRead.searchId,
      witnessRef:unknownRead.report.witnesses[0].ref});
    assert.equal(refused.status,409);
    await artifact('s6/m4-after-native-reconciliation.json',{historical,refused,
      patchCount:proof.requests.filter((r:any)=>r.method==='PATCH').length});
    return {historicalResult:historical.report.ref,applicability:historical.applicability,
      actualProviderPatches:1,nativeReconciliation:'VERIFIED_READ_ONLY',productionAdmission:'UNQUALIFIED'};
  });
}
