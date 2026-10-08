import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { POST } from '../../apps/api/app/api/company-brain/[operation]/route';
import { authorizedSearch } from '../../packages/private-equity/src/counterexample-search/service';
import { independentReference } from '../../packages/private-equity/src/counterexample-search/reference';
import { inChallengeEpisode } from '../../packages/private-equity/src/counterexample-search/budget';

export async function boundaryChallenges(e:any){
  const {f,admin,api,ok,queue,request,challenge,artifact}=e;
  const compile=async()=>ok(await api(f,'decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:f.workId,
    source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
    resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
  await challenge('deadline-auth-body-and-locked-db','Actual auth/body/SQL boundaries obey one deadline and real trusted reference abort reaps its child',async()=>{
    const slice=await compile(),observations:any[]=[],route='counterexample-diagnostic-submit';
    const invoke=async(req:Request)=>{
      const start=performance.now(),response=await POST(req,{params:Promise.resolve({operation:route})});
      const observed={status:response.status,body:await response.json(),wallMs:performance.now()-start};
      observations.push(observed);assert(observed.wallMs<1500,'Transport refusal exceeded its bounded local tolerance');return observed;
    };
    const address='http://127.0.0.1/api/company-brain/'+route,headers={
      'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal,'x-challenge-deadline-ms':'200'};
    assert.equal((await invoke(new Request(address,{method:'POST',body:'{}'}))).status,401);
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"schema":'));},
      cancel(){cancelled=true;}});
    assert.equal((await invoke(new Request(address,{method:'POST',headers,body:stream,duplex:'half'} as RequestInit))).status,413);
    assert(cancelled,'Stalled body was not cancelled after its deadline');
    assert.equal((await invoke(new Request(address,{method:'POST',headers:{...headers,'content-length':'65537'},body:'{}'}))).status,413);
    await admin.query('BEGIN');
    try{
      await admin.query('LOCK TABLE finnor_os.works IN ACCESS EXCLUSIVE MODE');
      assert.equal((await invoke(new Request(address,{method:'POST',headers,body:JSON.stringify({...request,sliceRef:slice.ref,
        idempotencyKey:randomUUID()})}))).status,413);
    }finally{await admin.query('ROLLBACK');}
    const before=(await admin.query(
      "SELECT (SELECT count(*) FROM finnor_os.m4_searches WHERE tenant_id=$1)::int searches,(SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1)::int jobs",
      [f.tenant])).rows[0];
    await admin.query('BEGIN');
    try{
      await admin.query('LOCK TABLE finnor_os.works IN ACCESS EXCLUSIVE MODE');
      const pending=invoke(new Request(address,{method:'POST',headers:{...headers,'x-challenge-deadline-ms':'1000'},
        body:JSON.stringify({...request,sliceRef:slice.ref,idempotencyKey:randomUUID()})}));
      let blocked:any;
      for(let i=0;i<80;i++){
        blocked=(await admin.query(`SELECT pid,query,wait_event FROM pg_stat_activity WHERE datname=current_database()
          AND usename='finnor_app' AND wait_event_type='Lock' AND pid<>pg_backend_pid() LIMIT 1`)).rows[0];
        if(blocked)break;
        await new Promise(yes=>setTimeout(yes,10));
      }
      assert(blocked,'Direct connection-loss control never reached its actual locked ordinary-role backend');
      const terminated=(await admin.query('SELECT pg_terminate_backend($1) terminated',[blocked.pid])).rows[0].terminated;
      const refused=await pending;
      await artifact('boundary/physical-connection-loss.json',{blocked,terminated,refused,
        expected:'Bounded failure, no worker-process crash; next canonical operation must recover'});
      assert.equal(terminated,true);
      assert(refused.status>=400,'A physically lost query cannot publish a successful submission');
    }finally{await admin.query('ROLLBACK');}
    const after=(await admin.query(
      "SELECT (SELECT count(*) FROM finnor_os.m4_searches WHERE tenant_id=$1)::int searches,(SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1)::int jobs",
      [f.tenant])).rows[0];
    assert.deepEqual(after,before,'Physical connection loss admitted a search or durable job');
    const sent=ok(await api(f,route,{...request,sliceRef:slice.ref,idempotencyKey:randomUUID(),
      domain:{parameters:[],maxCombination:1}}),202);
    const {frozen}=await authorizedSearch(f.ctx,sent.searchId),candidate=frozen.binding.underwriting[0]!,abort=new AbortController();
    abort.abort();
    const reference=await inChallengeEpisode(1000,()=>independentReference({operation:'MODEL',model:candidate.definition,
      snapshot:candidate.input,components:[],candidateId:candidate.candidateId,nodeId:'score'},abort.signal));
    assert.equal(reference.status,'UNRESOLVED');assert.equal(reference.reason,'CANCELLED');
    assert.equal((reference.invocation as any).signal,'SIGKILL');assert.equal((reference.invocation as any).childReaped,true);
    ok(await api(f,'counterexample-cancel',{searchId:sent.searchId}));await queue.tick();
    await artifact('boundary/deadlines.json',{observations,bodyCancelled:cancelled,reference,before,after,
      recoveredSearchId:sent.searchId,processSurvivedAndCanonicalSubmissionRecovered:true});
    return {observations,bodyCancelled:cancelled,reference,before,after,recoveredSearchId:sent.searchId};
  });
  await challenge('capacity-refusal-and-parent-witness-cap','Native resource refusals are explicit and root witness exhaustion cannot hide a newly accepted failure',async()=>{
    const slice=await compile(),body={...request,sliceRef:slice.ref,domain:{parameters:[],maxCombination:1}};
    const sent=ok(await api(f,'counterexample-diagnostic-submit',{...body,idempotencyKey:randomUUID()}),202);
    await admin.query("UPDATE finnor_os.compute_resource_policies SET enabled=false WHERE resource_key='provider:m4-native'");
    let blocked:any;
    try{await queue.tick();blocked=ok(await api(f,'counterexample-ledger',{searchId:sent.searchId}));}
    finally{await admin.query("UPDATE finnor_os.compute_resource_policies SET enabled=true WHERE resource_key='provider:m4-native'");}
    await artifact('boundary/capacity-refusal.json',blocked);
    assert.equal(blocked.status,'COMPLETED');assert.equal(blocked.report.result,'BLOCKED');
    assert(blocked.report.unresolved.some((gap:any)=>gap.reason==='REQUIRED_NATIVE_CAPACITY_UNAVAILABLE'));
    assert.equal(blocked.report.coverage.checkedCells,0);assert(blocked.deliveryHistory.length);
    const effect=(fixture:string)=>({kind:'EFFECT_FIXTURE',fixture,request:{entityId:'C_01',field:'credit_limit',operation:'SET',
      value:'20',unit:'USD',currency:'USD',idempotencyKey:randomUUID()},claimKind:'EXACT_EFFECT'});
    const root=ok(await api(f,'counterexample-diagnostic-submit',{...body,idempotencyKey:randomUUID(),
      evaluations:[effect('WRONG_AMOUNT')],limits:{...request.limits,maxWitnesses:1}}),202);
    await queue.tick();const initial=ok(await api(f,'counterexample-read',{searchId:root.searchId}));assert.equal(initial.report.result,'FAILURE_WITNESS');
    const child=ok(await api(f,'counterexample-repair-request',{searchId:root.searchId,replacement:{...body,idempotencyKey:randomUUID(),
      evaluations:[effect('WRONG_TARGET')],limits:{...request.limits,maxWitnesses:1}}}),202);
    await queue.tick();const limited=ok(await api(f,'counterexample-ledger',{searchId:child.searchId}));
    await artifact('boundary/parent-witness-limit.json',{initial,limited});
    assert.equal(limited.report.result,'BLOCKED');assert.equal(limited.report.coverage.checkedCells,0);
    assert(limited.report.unresolved.some((gap:any)=>gap.reason==='WITNESS_ALLOCATION_EXHAUSTED'));
    assert(!limited.ledger.some((entry:any)=>entry.kind==='VALID_ORIGINAL'),'Accepted failure could not fit its parent witness allocation');
    assert.equal(ok(await api(f,'counterexample-read',{searchId:root.searchId})).report.result,'FAILURE_WITNESS');
    return {blocked:blocked.report.ref,limited:limited.report.ref,priorFailure:initial.report.ref};
  });
}
