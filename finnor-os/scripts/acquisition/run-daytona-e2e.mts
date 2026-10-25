import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {daytonaProtocolFixture} from '../p1/daytona-protocol-fixture.mts';

/** Compose the existing native acquisition story with the actual SDK protocol
 * fixture. The financial expected values remain in the independent owner story;
 * this driver checks the physical lifecycle that a local executor cannot prove. */
const root=process.env.FINNOR_P4_EVIDENCE_DIR;if(!root)throw Error('EXTERNAL_EVIDENCE_DIRECTORY_REQUIRED');
const evidence=resolve(root);await mkdir(evidence,{recursive:true});
const fixture=await daytonaProtocolFixture(evidence),execute=promisify(execFile);
let code=0;
try{
 const env:Record<string,string>=Object.fromEntries(['HOME','PATH','TMPDIR','FINNOR_M1_PROFILE','FINNOR_M1_STORE','FINNOR_S3_MODEL_STORE','FINNOR_S3_PYTHON','FINNOR_S4_POLICY_STORE','FINNOR_S5_PYTHON'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]!]));
 Object.assign(env,fixture.environment,{NODE_ENV:'test',CI:'1',LOG_LEVEL:'silent',AUTH_DEV_BYPASS:'1',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',FINNOR_P4_EVIDENCE_DIR:evidence,FINNOR_P4_RUN_PROFILE:'production_analysis',FINNOR_P4_CASE_FILTER:'ordinary-data-room-to-acquisition',FINNOR_ACQUISITION_ANALYSIS_E2E:'1',FINNOR_ACQUISITION_READ_PROBE:'daytona-final',RATE_LIMIT_PER_MINUTE:'100000',P3_GOVERNORS:'1'});
 if(['procedure','search'].includes(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT??''))env.FINNOR_ACQUISITION_ANALYSIS_VARIANT=process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT!;
 for(const name of ['FINNOR_DAYTONA_PROTOCOL_LOST_ACK','FINNOR_DAYTONA_PROTOCOL_KILL','FINNOR_ACQUISITION_SEARCH_ROOT_REFUSAL','FINNOR_ACQUISITION_IC_E2E','FINNOR_ACQUISITION_IC_CONTROLLER_E2E'])if(process.env[name]==='1')env[name]='1';
 try{
  const running=execute(process.execPath,['--import=tsx','scripts/p4/run-evidence-e2e.mts'],{cwd:resolve(import.meta.dirname,'../..'),env,timeout:600000,maxBuffer:4194304});
  if(process.env.FINNOR_DAYTONA_PROTOCOL_KILL==='1'){assert(running.child.pid);fixture.registerWorkerParent(running.child.pid);}
  const child=await running;
  await writeFile(join(evidence,'sdk-acquisition-runner.log'),child.stdout+child.stderr);
 }catch(error:any){await writeFile(join(evidence,'sdk-acquisition-runner.log'),String(error.stdout??'')+String(error.stderr??''));throw error;}
}catch(error){code=1;console.error(error instanceof Error?error.message:String(error));}
finally{await fixture.close();}
try{
 const scored=JSON.parse(await readFile(join(evidence,'results.json'),'utf8'));
 assert.equal(scored.status,'PASS_LOCAL');
 assert(scored.results.filter((r:any)=>r.status==='PASS').length>=2);
 const protocol=JSON.parse(await readFile(join(evidence,'daytona-protocol.json'),'utf8'));
 if(process.env.FINNOR_ACQUISITION_SEARCH_ROOT_REFUSAL==='1'){
  const refused=JSON.parse(await readFile(join(evidence,'acquisition-search-root-refusal.json'),'utf8'));assert.equal(protocol.sandboxes.length,0);assert.equal(refused.refused.code,'P2_COMPUTE_RESOURCE_ROOT_NOT_PERMITTED');assert.deepEqual(refused.after,{decisions:0,programs:0,searches:0,spent:0});
  await writeFile(join(evidence,'daytona-same-acquisition-verdict.json'),JSON.stringify({status:'PASS_LOCAL',qualifiedRefusal:true,physicalSandboxes:0,physicalCommands:0,newAnalysisOrSpend:0},null,2));
 }else{
 assert.equal(protocol.sandboxes.length,process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='search'?1:2);assert(protocol.sandboxes.every((s:any)=>s.state==='destroyed'&&s.commands.length===1));
 if(process.env.FINNOR_DAYTONA_PROTOCOL_KILL==='1'){
  assert(protocol.interruptedPid,'The provider fixture must observe an actual original worker SIGKILL after accepting its command');
  const search=JSON.parse(await readFile(join(evidence,'search-same-acquisition-proof.json'),'utf8'));
  assert.equal(search.ledger[0].spent,2);assert.equal(search.attempts.length,2);
  assert.equal(search.remote[0].execution.provenance.commandId,protocol.sandboxes[0].commands[0].id);
  assert(search.reconciliationJobs.some((j:any)=>j.status==='completed'&&Number(j.claim_fence)>0));
 }
 if(process.env.FINNOR_DAYTONA_PROTOCOL_LOST_ACK==='1'){
  assert(protocol.lostCommandAcknowledgement,'Provider must actually lose the acknowledgement of an accepted native command');
  const journal=JSON.parse(await readFile(join(evidence,'acquisition-analysis-owner-journal.json'),'utf8'));
  if(process.env.FINNOR_ACQUISITION_ANALYSIS_VARIANT==='search'){
   const search=JSON.parse(await readFile(join(evidence,'search-same-acquisition-proof.json'),'utf8'));
   assert.equal(search.ledger[0].spent,2);assert.equal(search.attempts.length,2);assert.equal(journal.owner.attempts_used,3);
   assert.equal(search.remote[0].execution.provenance.commandId,protocol.lostCommandAcknowledgement.commandId);
  }else{
   assert.equal(journal.journal.filter((e:any)=>e.kind==='REMOTE_EXECUTION_WAIT').length,1);
   assert.equal(journal.journal.filter((e:any)=>e.kind==='P6_COMPONENTS_ADMITTED').length,1);
   assert.equal(journal.journal.filter((e:any)=>e.kind==='P6_FRESH_FALLBACK').length,0);
   assert.equal(journal.owner.attempts_used,2);
  }
  const original=protocol.sandboxes.find((s:any)=>s.id===protocol.lostCommandAcknowledgement.sandboxId);
  assert.equal(original.commands[0].id,protocol.lostCommandAcknowledgement.commandId);
 }
 const owner=JSON.parse(await readFile(join(evidence,'same-acquisition-analysis-proof.json'),'utf8'));
 assert.equal(owner.program.body.program.result.values.operatingProfit.value,'930000');
 assert.equal(owner.observed.body.workId,owner.work.workId);assert.equal(owner.observed.body.result.maximumBid.qualification,'NO_FEASIBLE_CANDIDATE');
 await writeFile(join(evidence,'daytona-same-acquisition-verdict.json'),JSON.stringify({status:'PASS_LOCAL',financialValue:'930000',workId:owner.work.workId,decisionId:owner.observed.body.decisionId,physicalSandboxes:protocol.sandboxes.length,physicalCommands:protocol.sandboxes.map((s:any)=>s.commands.length),allDestroyed:true,sdkHttpAndRealNativeProcesses:true,hostedDaytonaQualified:false,modelInferenceQualified:false,billingUSD:null},null,2));
 }
}catch(error){code=1;console.error(error instanceof Error?error.message:String(error));}
await new Promise<void>(yes=>process.stdout.write(JSON.stringify({evidence,status:code?'FAIL':'PASS_LOCAL'})+'\n',()=>yes()));
process.exit(code);
