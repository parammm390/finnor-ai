import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Registered before the Daytona adapter. Existing local-seatbelt evidence does
 * not cover a hosted worker, accepted sandbox custody or remote result binding.
 * A remote route returning a guessed result, another Work or a local receipt
 * fails even if its arithmetic happens to be correct. */
export async function daytonaAnalysisE2E(e:any){
 const {test,create,complete,request,api,admin,tenant,evidence}=e;
 await test('daytona-source-bound-analysis',{
  expected:{netEquity:'43',leverage:'3.5'},executor:'DAYTONA_PRIVATE_ANALYSIS_V1',
 },'Actual API, queue and remote numerical module produce independently checked source-bound results in the original Work; output alone grants no financial effect',async()=>{
  assert.equal(process.env.FINNOR_P1_EXECUTOR,'daytona','A selected remote test requires the configured Daytona route');
  const accepted=await create(request());let done=await complete(accepted);
  if(process.env.FINNOR_DAYTONA_PROTOCOL_DRIFT==='local'){
   const physical=(await import('./daytona-protocol-fixture.mts')).daytonaFixtureSnapshot();
   await writeFile(join(evidence,'executor-selector-drift.json'),JSON.stringify({accepted,done,physical},null,2));
   assert.equal(done.status,'WAITING','An accepted remote analysis cannot silently continue on the local executor');
   assert.equal(done.reason,'P1_EXECUTOR_BOUND_CONFIGURATION_CHANGED');assert(!done.program?.result);
   assert.equal(physical.sandboxes.length,1);assert.equal(physical.sandboxes[0].commands.length,1);
   const prior=(await admin.query('SELECT episode_id,proposed FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2',[tenant,accepted.programId])).rows[0];
   process.env.FINNOR_P1_EXECUTOR='daytona';const resumed=await api('program-resume',{programId:accepted.programId});assert.equal(resumed.status,202,JSON.stringify(resumed));
   done=await complete(accepted);
   const after=(await admin.query('SELECT episode_id,proposed FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2',[tenant,accepted.programId])).rows[0];assert.equal(after.episode_id,prior.episode_id);assert.deepEqual(after.proposed.bounds,prior.proposed.bounds);
   await writeFile(join(evidence,'executor-selector-restored.json'),JSON.stringify({resumed,done,originalBounds:prior.proposed.bounds,sameEpisode:true},null,2));
  }
  const journal=(await admin.query("SELECT kind,body FROM finnor_os.p1_events WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,id",[tenant,accepted.programId])).rows;
  await writeFile(join(evidence,'daytona-owner-journal.json'),JSON.stringify({accepted,done,journal},null,2));
  assert.equal(done.status,'TESTED',JSON.stringify(done));assert.equal(done.workId,accepted.workId);
  assert.equal(done.program.result.values.netEquity.value,'43');assert.equal(done.program.result.values.leverage.value,'3.5');
  const isolated=done.program.costs.nativeInvocations.filter((v:any)=>v.execution?.provenance?.substrate==='DAYTONA_PRIVATE_ANALYSIS_V1');
  assert(isolated.length>0,'The completed result must identify the actual remote execution');
  for(const receipt of isolated){
   const p=receipt.execution.provenance;
   assert.equal(p.authority,'NONE_OUTPUT_UNTRUSTED');assert.equal(p.binding.workId,accepted.workId);
   assert.equal(p.binding.requestId,accepted.programId);assert.equal(p.binding.moduleDigest,receipt.moduleId.slice('module:'.length));
   assert.equal(p.cost.status,'UNMETERED');assert(p.sandboxId);assert(p.commandId);
  }
  assert(done.program.independentChecks.length>0&&done.program.independentChecks.every((c:any)=>c.status==='PASS'));
  if(process.env.FINNOR_DAYTONA_PROTOCOL_KILL==='1'){
   const physical:any=(await import('./daytona-protocol-fixture.mts')).daytonaFixtureSnapshot();assert(physical.interruptedPid,'The original FINNOR worker must actually have been killed');
   const intents=journal.filter((r:any)=>r.kind==='REMOTE_EXECUTOR_JOURNAL'&&r.body.stage==='INTENT');
   assert.equal(physical.sandboxes.length,intents.length,'A lost worker cannot create an extra charged sandbox');
   assert(physical.sandboxes.every((b:any)=>b.commands.length===1),'Each accepted physical command must execute once');
   const originalAttempt=intents[0].body.attemptKey;assert.equal(journal.filter((r:any)=>r.kind==='REMOTE_EXECUTOR_JOURNAL'&&r.body.attemptKey===originalAttempt&&r.body.stage==='INTENT').length,1);
   assert(journal.filter((r:any)=>r.kind==='DELIVERY_STARTED').length>=3,'The source continuation and cold recovery require distinct actual queue deliveries');
  }
  return {accepted,done,productionAuthenticationVerified:false,hostedRuntimeVerified:process.env.FINNOR_DAYTONA_PROTOCOL_FIXTURE!=='1',runtimeQualification:process.env.FINNOR_DAYTONA_PROTOCOL_FIXTURE==='1'?'REAL_SDK_HTTP_AND_NATIVE_PROCESSES_NOT_HOSTED_DAYTONA':'HOSTED_DAYTONA_WORKER'};
 });
}
