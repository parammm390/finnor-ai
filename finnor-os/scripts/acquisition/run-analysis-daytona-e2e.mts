import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {daytonaProtocolFixture} from '../p1/daytona-protocol-fixture.mts';
const evidence=process.env.FINNOR_P4_EVIDENCE_DIR;if(!evidence)throw Error('EXTERNAL_EVIDENCE_DIRECTORY_REQUIRED');
const fixture=await daytonaProtocolFixture(resolve(evidence));
Object.assign(process.env,fixture.environment,{FINNOR_ACQUISITION_ANALYSIS_E2E:'1',FINNOR_P4_RUN_PROFILE:'production_analysis',FINNOR_P4_CASE_FILTER:'ordinary-data-room-to-acquisition'});
let failure:unknown;
try{
 const child=await promisify(execFile)(process.execPath,['--import=tsx','scripts/p4/run-evidence-e2e.mts'],{cwd:process.cwd(),env:process.env,timeout:300000,maxBuffer:8388608});
 await writeFile(join(evidence,'sdk-acquisition-runner.log'),child.stdout+child.stderr);
}catch(error){failure=error;await writeFile(join(evidence,'sdk-acquisition-runner.log'),String((error as any).stdout??'')+String((error as any).stderr??''));}finally{await fixture.close();}
const result=JSON.parse(await readFile(join(evidence,'results.json'),'utf8'));
if(result.results.some((r:any)=>r.status==='FAIL'))failure??=Error('ACQUISITION_BOUNDARY_FAILED');
try{
 const physical=JSON.parse(await readFile(join(evidence,'daytona-protocol.json'),'utf8'));
 assert.equal(physical.sandboxes.length,2);assert(physical.sandboxes.every((s:any)=>s.state==='destroyed'&&s.commands.length===1&&s.commands[0].exitCode===0));
 const proof=JSON.parse(await readFile(join(evidence,'same-acquisition-analysis-proof.json'),'utf8'));
 const remote=proof.program.body.program.costs.nativeInvocations.filter((r:any)=>r.execution?.provenance?.substrate==='DAYTONA_PRIVATE_ANALYSIS_V1');
 assert.equal(remote.length,2);assert(remote.every((r:any)=>r.remoteExecutionResponsibility?.cleanupRequired===false));
 assert.equal(proof.program.body.program.result.values.operatingProfit.value,'930000');
 await writeFile(join(evidence,'daytona-same-acquisition-verdict.json'),JSON.stringify({status:'PASS_LOCAL',sdkHttpAndRealNativeProcesses:true,hostedDaytonaQualified:false,modelInferenceQualified:false,financialValue:'930000',decisionId:proof.observed.body.decisionId,workId:proof.work.workId,maximumBid:proof.observed.body.result.maximumBid,physicalSandboxes:physical.sandboxes.length,physicalCommands:physical.sandboxes.map((s:any)=>s.commands.length),billingUSD:null},null,2));
}catch(error){failure??=error;}
if(failure)await writeFile(join(evidence,'daytona-same-acquisition-verdict.json'),JSON.stringify({status:'FAIL',message:String(failure),stack:(failure as Error).stack},null,2));
process.exit(failure?1:0);
