/** Registered original-owner E2E families. Fixture setup may clear only in this
 * disposable database; the M4 search itself must leave every owner state intact. */
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { receiveWork } from '@finnor/db';
import { allocationRef,verifyCanonicalAllocation,compileAllocationMilp } from '@finnor/epistemic-runtime';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { POST as allocationPost } from '../../apps/api/app/api/allocations/[operation]/route';
import { POST as policyPost } from '../../apps/api/app/api/policies/[operation]/route';

export async function ownerChallenges(e:any){
  const {repo,admin,api,ok,artifact,challenge,request,queue}=e;
  const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{
    input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:10000,maxBuffer:1048576});
  assert.equal(generated.status,0,generated.stderr);
  const day=86400000,fixtures:Record<string,any>={};
  const support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,
    begin:new Date(Date.now()-128*day).toISOString(),day,fixtures,artifact,
    api:(f:any,op:string,body:unknown,handler=allocationPost)=>api(f,op,body,handler)});
  const suppliedRef=(id:string)=>({owner:'BUSINESS_OWNER',id,version:'fixture-v1',contentDigest:createHash('sha256').update(id).digest('hex')});
  const state=async(f:any)=>(await admin.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY reservation_id) FROM finnor_os.s5_reservations r WHERE tenant_id=$1) reservations,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY consumption_id) FROM finnor_os.s5_consumption_states r WHERE tenant_id=$1) consumptions,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM finnor_os.business_effects r WHERE tenant_id=$1) effects`,
    [f.tenant])).rows;
  const run=async(f:any,evaluations:any[],allocation:any)=>{
    const work=await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'M4 original owner diagnostic, no live effects',channel:'console'});
    const slice=ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:work.workId,
      source:allocation?{kind:'ALLOCATION',allocationRef:allocation.certificate.ref}:{kind:'POLICY',policyRefs:f.policies.map((p:any)=>p.ref)},
      purpose:'MODEL_EVIDENCE',resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
    const before=await state(f),sent=ok(await api(f,'counterexample-diagnostic-submit',{...request,workId:work.workId,sliceRef:slice.ref,
      idempotencyKey:randomUUID(),evaluations,domain:{parameters:[],maxCombination:1}}),202);
    await queue.tick();const read=ok(await api(f,'counterexample-read',{searchId:sent.searchId}));
    await artifact('owners/search-'+sent.searchId+'.json',{slice,sent,read,before,after:await state(f)});
    if(read.status!=='COMPLETED')await artifact('owners/refused-'+sent.searchId+'.json',{
      ledger:await api(f,'counterexample-ledger',{searchId:sent.searchId}),
      job:(await admin.query("SELECT status,attempts,started_at,completed_at FROM finnor_os.jobs WHERE payload->>'searchId'=$1",
        [sent.searchId])).rows,
    });
    assert.equal(read.status,'COMPLETED',JSON.stringify(read));assert.deepEqual(await state(f),before,'Dry M4 changed S4/S5/S6 responsibility');
    return read.report;
  };
  const selected=(f:any,labels:string[])=>f.policies.filter((p:any)=>labels.includes(f.labels[p.ref.id])).map((p:any)=>p.ref.id);
  const selection=(ids:string[])=>({kind:'ALLOCATION_SELECTION',selectedPolicyIds:ids,claimKind:'UNIVERSAL_DETERMINISTIC'});
  const clear=async(f:any,input:any)=>{const result=ok(await api(f,'clear',input,allocationPost));assert.equal(result.status,'FEASIBLE',JSON.stringify(result));return result;};

  await challenge('original-s5-covenant-and-bound','Original A debt70 violates 3×EBITDA20; B+C gives32; native and separate Fraction ignore hostile omitted rows and false bound',async()=>{
    const f=await support.fixture('m4-abc',1,[{id:'cash',unit:'USD',capacity:200,totalLimit:200},
      ...['A','B','C'].map(id=>({id:'debt_'+id,unit:'debt-unit',capacity:200,totalLimit:200}))]);
    const original=[{id:'A',ev:'120',ebitda:'20',debt:70,equity:50,payoff:'20'},
      {id:'B',ev:'100',ebitda:'25',debt:50,equity:50,payoff:'18'},
      {id:'C',ev:'90',ebitda:'15',debt:45,equity:45,payoff:'14'}];
    for(const row of original)await support.policy(f,row.id,{cash:row.equity,['debt_'+row.id]:row.debt});
    const correctedA=await support.policy(f,'A60',{cash:60,debt_A:60}),hold=await support.policy(f,'R',{cash:25});
    await support.resource(f,'cash','USD','STOCK',['95','95']);
    for(const row of original)await support.resource(f,'debt_'+row.id,'debt-unit','CUMULATIVE_EXPENDITURE',['200','200'],undefined,[{
      id:row.id+'-original-leverage',sourceRef:suppliedRef(row.id+'-3x-'+row.ebitda),rightsRef:f.mandate.rightsRef,unit:'debt-unit',
      terms:[{resourceId:'debt_'+row.id,coefficient:'1',coefficientUnit:'debt-unit/debt-unit'}],periods:[0,1],
      maximum:String(3*Number(row.ebitda)),safetyMargin:'0',basis:'CANONICAL_RESOURCE_USAGE'}]);
    const candidates=f.policies.filter((p:any)=>f.labels[p.ref.id]!=='R');
    const input=support.clearing(f,{A:['20'],A60:['20'],B:['18'],C:['14']},[],
      [{id:'A-financing-version',labels:['A','A60'],maximum:1}],candidates),cleared=await clear(f,input);
    assert.deepEqual(cleared.certificate.check.selectedPolicyIds.map((id:string)=>f.labels[id]).sort(),['B','C']);
    assert.equal(cleared.certificate.optimization.upperBound,'32');
    const issued=ok(await api(f,'read',{allocationRef:cleared.certificate.ref},allocationPost));
    const invalid=verifyCanonicalAllocation(issued.problem,selected(f,['A','C']));
    assert.equal(invalid.feasible,false);assert(invalid.witnesses.some((w:any)=>w.constraintId==='covenant:A-original-leverage'&&w.used==='70'&&w.maximum==='60'));
    const hostile=compileAllocationMilp(issued.problem,10000);hostile.input.rows=hostile.input.rows.filter((r:any)=>!r.id.startsWith('covenant:'));
    hostile.policyColumns.forEach((id:string,i:number)=>{hostile.input.lowerBounds[i]=hostile.input.upperBounds[i]=selected(f,['A','C']).includes(id)?'1':'0';});
    const numerical=spawnSync(process.env.FINNOR_S5_PYTHON!,[join(repo,'finnor-os/packages/epistemic-runtime/src/allocation-solver.py')],{
      input:JSON.stringify(hostile.input),encoding:'utf8',timeout:10000,maxBuffer:1048576});
    assert.equal(numerical.status,0,numerical.stderr);assert.equal(JSON.parse(numerical.stdout).status,'OPTIMAL_NUMERICAL');
    const failed=await run(f,[selection(selected(f,['A','C'])),{kind:'ALLOCATION_BOUND',bound:'31',claimKind:'UNIVERSAL_DETERMINISTIC'}],cleared);
    assert.equal(failed.result,'FAILURE_WITNESS');assert.equal(failed.witnesses.length,2);
    assert(failed.witnesses.every((w:any)=>w.validation.independent.checker==='M4_FRACTION_ORIGINAL_S5_V1'));
    const proof=failed.witnesses.find((w:any)=>w.validation.predicate.relation==='FEASIBLE');
    assert(proof.validation.independent.trace.witnesses.some((w:any)=>w.constraintId==='covenant:A-original-leverage'&&w.used==='70'&&w.maximum==='60'));
    const valid=await run(f,[selection(selected(f,['B','C'])),{kind:'ALLOCATION_BOUND',bound:'32',claimKind:'UNIVERSAL_DETERMINISTIC'}],cleared);
    assert.equal(valid.result,'NO_WITNESS_WITHIN_BUDGET');
    ok(await api(f,'release',{allocationRef:cleared.certificate.ref,idempotencyKey:randomUUID()},allocationPost));
    const reserved=await clear(f,support.clearing(f,{R:['1']},[],[],[hold]));
    const remaining=await clear(f,support.clearing(f,{A60:['20'],B:['18'],C:['14']},[],[],
      candidates.filter((p:any)=>p!==candidates.find((p:any)=>f.labels[p.ref.id]==='A'))));
    assert.deepEqual(remaining.certificate.check.selectedPolicyIds,[correctedA.ref.id]);assert.equal(remaining.certificate.optimization.upperBound,'20');
    const withReserve=await run(f,[selection(selected(f,['B','C'])),selection([correctedA.ref.id])],remaining);
    assert.equal(withReserve.result,'FAILURE_WITNESS');
    assert(withReserve.repairDependencies.regions.some((r:any)=>r.kind==='OUTSTANDING_COMMITMENT'));
    await artifact('owners/abc-original.json',{original,correctedA,input,cleared,issued,hostileInput:hostile.input,
      hostileOutput:JSON.parse(numerical.stdout),invalid,failed,valid,reserved,remaining,withReserve,
      qualification:'Original canonical 3x EBITDA covenants and cash95; owner-proposed H1, not agreed financing or CapitalProgram'});
    return {failed:failed.ref,valid:valid.ref,exactOptimum:'32'};
  });

  await challenge('dated-signed-resource-semantics','Actual dated S5 semantics preserve future cash, signed outstanding minima, flow/stock, occupation, terminal liability and unknown responsibility',async()=>{
    const observations:any[]=[];
    const f=await support.fixture('m4-dated',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
    await support.policy(f,'immediate',{cash:60});await support.policy(f,'delayed',{cash:60},{},{period:1});
    await support.resource(f,'cash','USD','STOCK',['50','90','90'],['20','10','0']);
    const delayed=await clear(f,support.clearing(f,{immediate:['100'],delayed:['100']},[],[{id:'choose-timing',labels:['immediate','delayed'],maximum:1}]));
    assert.deepEqual(delayed.certificate.check.selectedPolicyIds,selected(f,['delayed']));
    const timed=await run(f,[selection(selected(f,['immediate'])),selection(selected(f,['delayed']))],delayed);
    assert.equal(timed.result,'FAILURE_WITNESS');
    assert(timed.witnesses[0].validation.independent.trace.witnesses.some((w:any)=>w.constraintId==='resource:cash'&&w.period===0&&w.used==='80'&&w.maximum==='50'));
    observations.push({name:'dated',timed});
    const signed=await support.fixture('m4-signed',2,[{id:'cash',unit:'USD',capacity:100,totalLimit:100},
      {id:'leverage',unit:'debt-unit',capacity:100,totalLimit:100}],{nonlinear:true});
    const q=await support.policy(signed,'Q',{}, {},{contingent:{HIGH:20,LOW:40}}),r=await support.policy(signed,'R',{leverage:60});
    await support.resource(signed,'cash','USD','STOCK',['100','100','100']);
    await support.resource(signed,'leverage','debt-unit','CUMULATIVE_EXPENDITURE',['100','100','100'],undefined,[{
      id:'signed-covenant',sourceRef:suppliedRef('signed-original'),rightsRef:signed.mandate.rightsRef,unit:'covenant-unit',
      terms:[{resourceId:'leverage',coefficient:'1',coefficientUnit:'covenant-unit/debt-unit'},
        {resourceId:'cash',coefficient:'-1',coefficientUnit:'covenant-unit/USD'}],periods:[1],maximum:'30',
      safetyMargin:'0',basis:'CANONICAL_RESOURCE_USAGE'}]);
    const held=await clear(signed,support.clearing(signed,{Q:['100']},[],[],[q]));
    const empty=await clear(signed,support.clearing(signed,{R:['100']},[],[],[r]));
    assert.equal(empty.certificate.check.selectedPolicyIds.length,0);
    const wrong=await run(signed,[selection([r.ref.id])],empty);
    assert.equal(wrong.result,'FAILURE_WITNESS');
    const reference=wrong.witnesses[0].validation.independent.trace;
    assert(reference.witnesses.some((w:any)=>w.constraintId==='covenant:signed-covenant'&&w.used==='40'&&w.maximum==='30'));
    observations.push({name:'signed',held,empty,wrong});
    const flow=await support.fixture('m4-flow-tail',3,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
    const a=await support.policy(flow,'A',{cash:60}),b=await support.policy(flow,'B',{cash:60},{},{period:1}),
      t=await support.policy(flow,'T',{cash:95},{},{tail:10});
    await support.resource(flow,'cash','USD','FLOW',['100','100','100','100']);
    await support.resource(flow,'stockcash','USD','STOCK',['100','100','100','100'],undefined,[],{resourceClass:'CASH'});
    const flowInput=support.clearing(flow,{A:['20'],B:['30']},[],[],[a,b]),flowClear=await clear(flow,flowInput);
    const positive=await run(flow,[selection([a.ref.id,b.ref.id])],flowClear);assert.equal(positive.result,'NO_WITNESS_WITHIN_BUDGET');
    ok(await api(flow,'release',{allocationRef:flowClear.certificate.ref,idempotencyKey:randomUUID()},allocationPost));
    const stockInput=structuredClone(flowInput);stockInput.demandBindings.forEach((d:any)=>d.resourceId='stockcash');stockInput.idempotencyKey=randomUUID();
    const stockClear=await clear(flow,stockInput),stock=await run(flow,[selection([a.ref.id,b.ref.id])],stockClear);
    assert.equal(stock.result,'FAILURE_WITNESS');assert(stock.witnesses[0].validation.independent.trace.witnesses.some((w:any)=>w.constraintId==='resource:stockcash'&&w.period===1&&w.used==='120'));
    ok(await api(flow,'release',{allocationRef:stockClear.certificate.ref,idempotencyKey:randomUUID()},allocationPost));
    const tailInput=support.clearing(flow,{T:['100']},[],[],[t]);tailInput.demandBindings.forEach((d:any)=>d.resourceId='stockcash');tailInput.funding[0].terminalLiabilityResourceId='stockcash';
    const tailClear=await clear(flow,tailInput),tail=await run(flow,[selection([t.ref.id])],tailClear);
    assert.equal(tail.result,'FAILURE_WITNESS');assert(tail.witnesses[0].validation.independent.trace.witnesses.some((w:any)=>w.constraintId==='resource:stockcash'&&w.period===3&&w.used==='105'));
    observations.push({name:'flow-stock-tail',positive,stock,tail});
    await artifact('owners/dated-signed.json',observations);return observations.map(v=>({name:v.name}));
  });

  await challenge('lawful-s3-s4-common-worlds','Original joint S3 kernel and observable S4 histories reproduce model-relative loss, not probabilities or hidden-world decisions',async()=>{
    const f=await support.fixture('m4-worlds',2,[{id:'cash',unit:'USD',capacity:100,totalLimit:100}],{nonlinear:true});
    const p=await support.policy(f,'P',{}, {},{contingent:{HIGH:70,LOW:50},probe:10});
    const failed=await run(f,[{kind:'POLICY_BOUND',policyId:p.ref.id,minimum:'10000',unit:'USD',claimKind:'MODEL_WORST_CASE'}],null);
    assert.equal(failed.result,'FAILURE_WITNESS');assert(failed.witnesses.some((w:any)=>w.class==='POLICY_WORLD'));
    const histories=new Map<string,string>();
    for(const w of failed.witnesses){
      assert.equal(w.validation.independent.checker,'M4_ORIGINAL_KERNEL_REFERENCE_V1');
      assert(Math.abs(w.validation.native.observed-w.validation.independent.observed)<=p.certificate.numericalTolerance);
      for(const row of w.validation.independent.trace.trace){
        assert(row.observations.every((o:any)=>o.availablePeriod<=row.period));
        if(row.period===0){assert.equal(row.actionId,'probe');assert.deepEqual(row.observations,[]);}
        const history=JSON.stringify({period:row.period,observations:row.observations});
        if(histories.has(history))assert.equal(row.actionId,histories.get(history));else histories.set(history,row.actionId);
      }
    }
    const positive=await run(f,[{kind:'POLICY_BOUND',policyId:p.ref.id,minimum:'-1000',unit:'USD',claimKind:'MODEL_WORST_CASE'}],null);
    assert.equal(positive.result,'NO_WITNESS_WITHIN_BUDGET');assert(positive.coverage.checkedCells>0);
    const decision={knowledgeAt:new Date().toISOString(),period:0,actionHistory:[],observations:[{
      instrumentId:'public-signal',token:'HIGH',availablePeriod:1,knowledgeAt:new Date().toISOString(),sourceRef:suppliedRef('not-observed')}],
      rightsRef:f.mandate.rightsRef,obligations:[],allocationRefs:[]};
    const hidden=await api(f,'decide',{policyRef:p.ref,decision},policyPost);
    assert.equal(hidden.status,400);assert.match(hidden.body.error,/Observation lies beyond/);
    const before=await state(f);
    // The authenticated disposable owner, not M4, requests this linked fallback.
    const fallback=ok(await api(f,'replan',{mandate:p.mandate,problem:{...p.problem,
      id:p.problem.id+'-stop-after-challenge',actions:p.problem.actions.filter((a:any)=>a.kind==='STOP'),observations:[]},
      protocols:[],scenarios:{pathsPerMechanism:4,seed:20261002},priorPolicyRef:p.ref,
      reason:'Owner STOP-only fallback after '+failed.ref.id},policyPost));
    assert(fallback.policy);assert.equal(fallback.policy.priorPolicyRef.contentDigest,p.ref.contentDigest);
    const chosen=ok(await api(f,'decide',{policyRef:fallback.policy.ref,
      decision:{knowledgeAt:new Date().toISOString(),period:0,actionHistory:[],observations:[],
        rightsRef:p.mandate.rightsRef,obligations:[],allocationRefs:[]}},policyPost));
    assert.equal(chosen.status,'POLICY_AVAILABLE');assert.equal(chosen.actionId,'stop');
    assert.equal(chosen.executionAuthorityGranted,false);
    assert.deepEqual(await state(f),before,'S4 choice dispatched or released business responsibility');
    await artifact('owners/worlds.json',{p,failed,positive,hidden,histories:[...histories],fallback,chosen,before,after:await state(f)});
    return {failed:failed.ref,positive:positive.ref,hidden,fallback:fallback.policy.ref,chosen};
  });
}
