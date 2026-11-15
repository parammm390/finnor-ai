import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';

export async function verifyTotalEpisodes({call,task,request,specification,save}){
 const observed=[];
 const exchange=async(operation,body)=>{
  const r=await call(operation,body);observed.push({operation,status:r.status,body:r.body});return r;
 };
 const owner=async(taskWorkId,idempotencyKey)=>exchange('record-task-episode',{
  root:request.root,workId:request.workId,taskWorkId,idempotencyKey});
 const rejected=async(key)=>{
  const r=await exchange('submit-total',{...request,idempotencyKey:key});
  assert.equal(r.status,409,JSON.stringify(r.body));
  assert.equal(r.body.code,'Y5_TOTAL_TWO_DISTINCT_SAME_MEANING_MODEL_ACCEPTED_TASKS_REQUIRED');
 };
 try{
  await rejected('allocation-context-is-not-typed-acceptance');
  const first=await task(['-1','1']),second=await task(['-2','-1','4']),bounded=await task(['-5000']);
  const a=await owner(first.workId,'typed-development-a');
  assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(a.body.result.status,'MODEL_ACCEPTED');
  assert.equal(a.body.result.value,'1');assert(a.body.result.reference.prefixes.every(p=>p.safe));
  assert.equal(a.body.result.reference.prefixes[0].length,0);
  await rejected('one-task-is-not-recurring');
  const b=await owner(second.workId,'typed-development-b');
  assert.equal(b.status,200,JSON.stringify(b.body));assert.equal(b.body.result.status,'MODEL_ACCEPTED');
  assert.equal(b.body.result.value,'3');assert.equal(b.body.result.reference.rejected.length,3);
  const u=await owner(bounded.workId,'typed-development-unknown');
  assert.equal(u.status,200,JSON.stringify(u.body));assert.equal(u.body.result.status,'UNKNOWN');
  assert.equal(u.body.result.value,null);assert.equal(u.body.result.reason,'CANDIDATE_BOUND');
  const replay=await owner(first.workId,'typed-development-a');
  assert.equal(replay.status,200);assert.equal(replay.body.requestRef.id,a.body.requestRef.id);
  assert.equal(replay.body.resultRef.id,a.body.resultRef.id);assert.equal(replay.body.replayed,true);
  for(const extra of [{values:['0']},{answer:'0'},{accepted:true}]){
   assert.equal((await exchange('record-task-episode',{root:request.root,workId:request.workId,
    taskWorkId:first.workId,idempotencyKey:'inline-not-permitted',...extra})).status,400);
  }
  const submitted=await exchange('submit-total',{...request,idempotencyKey:'matching-typed-recurrence'});
  assert.equal(submitted.status,202,JSON.stringify(submitted.body));
  const read=await exchange('read',{discoveryId:submitted.body.discoveryId,includeCapsule:true,includeHistory:true});
  assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.current,true);
  const records=read.body.episodeCut.records;
  const matching=records.filter(r=>r.kind==='TOTAL_TASK_REQUEST'&&
   isDeepStrictEqual(r.body.detail.specification.sourceRef,specification.sourceRef));
  assert.equal(matching.length,3);
  assert(records.some(r=>r.kind==='TOTAL_TASK_RESULT'&&r.body.detail.result.status==='UNKNOWN'));
  assert(records.some(r=>r.kind==='TOTAL_TASK_COST'));
  assert(records.some(r=>r.kind==='REQUEST'),'allocation compatibility context retained');
  assert(records.some(r=>r.kind==='REFUSAL'),'allocation adverse context retained');
  for(const r of [a,b,u]){
   assert.equal(r.body.protectedReceipt,null);assert.equal(r.body.businessCompletionAccepted,false);
   assert.equal(r.body.reservationCreated,false);assert.deepEqual(r.body.s6EffectsCreated,[]);
   assert.equal(r.body.cost.money,null);assert.equal(r.body.cost.aggregatePeakBytes,null);
  }
  const result={status:'PASS',scope:'PUBLIC_FIXTURES_MODEL_ONLY_NOT_INDEPENDENT_QUALIFICATION',
   tasks:{first,second,bounded},accepted:[a.body,b.body],unknown:u.body,read:read.body,observed,
   remaining:'Parent queue/kernel/use campaign, stale/revoked source cases and independent review remain separate gates.'};
  await save('typed-recurring-boundary.json',result);
  return {submitted:submitted.body,first,second,bounded,records};
 }catch(error){
  await save('typed-recurring-failure.json',{status:'FAIL',error:String(error),stack:error.stack,observed});throw error;
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.argv.includes('--source-only'),'Use the exported driver with the authenticated parent fixture.');
 const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)));
 const owner=await readFile(join(root,'finnor-os/packages/private-equity/src/uniform-algorithms/total-owner.ts'),'utf8');
 const contract=await readFile(join(root,'finnor-os/packages/private-equity/src/uniform-algorithms/total-contracts.ts'),'utf8');
 const episodes=await readFile(join(root,'finnor-os/packages/private-equity/src/allocation-total-episodes.ts'),'utf8');
 const oldProjection=owner.includes('EXACT_SCALED_SCENARIO_TERMS_AS_DEVELOPMENT_DATA_NOT_S5_OBJECTIVE_EQUIVALENCE');
 const oldGate=contract.includes('new Set(cut.acceptedAllocations.map(a=>a.problem.episodeId)).size<2');
 const baseline=process.argv.includes('--expect-gap');
 if(baseline)assert(oldProjection&&oldGate,'Baseline must expose the observed allocation-only bridge.');
 else{
  assert(!oldProjection&&!oldGate,'Allocation evidence must not qualify the typed gate.');
  assert(episodes.includes('export function matchingTotalTaskRequests(')&&contract.includes('matchingTotalTaskRequests(cut.records,task)'));
  assert(contract.includes('Y5_TOTAL_TWO_DISTINCT_SAME_MEANING_MODEL_ACCEPTED_TASKS_REQUIRED'));
 }
 const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-recurring-task-static'));
 await mkdir(evidence,{recursive:true,mode:0o700});
 const result={status:baseline?'BASELINE_GAP_CONFIRMED':'SOURCE_DELTA_PRESENT_NOT_RUNTIME_VERIFIED',
  baselineTree:'3b89abb78fe9c0fa5987265535783299ebb35e88',oldProjection,oldGate,
  observedAt:new Date().toISOString(),publicBoundary:'UNRUN_HEAVY_SLOT_RESERVED',
  rerun:'node finnor-os/scripts/postx/y5/verify-total-episodes.mjs --source-only'};
 await writeFile(join(evidence,baseline?'baseline.json':'source-check.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({...result,evidence}));
}
