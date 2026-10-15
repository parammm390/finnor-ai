/** Actual disposable worker/source deadline boundary, not a financial PASS. */
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const repo=resolve(import.meta.dirname,'../../..'),output=join(repo,'scope-v/v2-primary-reality-due-diligence/evidence','deadline-probe-'+new Date().toISOString().replace(/[:.]/g,'-'));
const plan=JSON.parse(await readFile(join(repo,'scope-v/v2-primary-reality-due-diligence/qualification-phase-plan.json'),'utf8')),startedAt=new Date().toISOString();
assert(Date.now()<Date.parse(plan.hardStop));await mkdir(output,{recursive:true});
const child=spawn(process.execPath,['--import=tsx',join(import.meta.dirname,'run-local.mts')],{cwd:join(repo,'finnor-os'),env:{...process.env,FINNOR_V2_QUALIFICATION:'1',FINNOR_V2_CASE_FILTER:'primary-liability',FINNOR_V2_SHORTER_DEADLINE_MS:'25000'},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',bytes=>{if(log.length<1048576)log+=bytes.toString();});child.stderr.on('data',bytes=>{if(log.length<1048576)log+=bytes.toString();});
const timer=setTimeout(()=>child.kill('SIGKILL'),Math.min(60000,Date.parse(plan.hardStop)-Date.now()));
let result:any;
try{
 const [code,signal]=await once(child,'exit');clearTimeout(timer);await writeFile(join(output,'runner.log'),log);
 assert.equal(signal,null);assert.equal(code,1);
 const report=log.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).reverse().find((row:any)=>row.evidence&&Array.isArray(row.cases));assert(report,'ACTUAL_RUNNER_LEDGER_REQUIRED');
 const ledger=JSON.parse(await readFile(join(report.evidence,'results.json'),'utf8')),trace=JSON.parse(await readFile(join(report.evidence,'actual-queue-source-meter-trace.json'),'utf8'));
 const stopped=ledger.cases.find((row:any)=>row.id==='primary-liability');assert.equal(stopped.status,'FAIL');assert.match(stopped.failure.message,/REGISTERED_VERIFICATION_DEADLINE_EXHAUSTED/);
 assert(ledger.cases.every((row:any)=>row.status!=='PASS'||Date.parse(row.finishedAt)<Date.parse(ledger.effectiveDeadlineAt)));
 const acquired=trace.source.calls.filter((call:any)=>call.operation==='ACQUIRE');assert.equal(acquired.length,1,'PHYSICAL_EGRESS_PREREQUISITE_NOT_REACHED');
 const anchor=ledger.deadlineShorteningEvents?.[0];assert(anchor,'ACTUAL_ACCEPTANCE_ANCHOR_REQUIRED');
 assert.equal(anchor.requestId,acquired[0].requestId);assert(Date.parse(anchor.effectiveDeadlineAt)<=Date.parse(anchor.previousDeadlineAt));
 assert(Date.parse(anchor.effectiveDeadlineAt)<=Date.parse(anchor.observedAt)+1000);
 const exposure=trace.costs.filter((cost:any)=>cost.actual_micro_usd===null&&(BigInt(cost.reserved_micro_usd)>0n||BigInt(cost.possible_additional_micro_usd)>0n));assert(exposure.length>0,'ORIGINAL_UNSETTLED_EXPOSURE_MUST_REMAIN');
 assert.equal(trace.observations.length,0);assert(Date.now()<Date.parse(plan.hardStop));
 result={schema:'finnor.v2.deadline-probe.v1',status:'PASS_ACTUAL_HARNESS_DEADLINE_BOUNDARY',startedAt,finishedAt:new Date().toISOString(),childEvidence:report.evidence,stopped,actualAcceptanceDerivedEarlierCut:anchor,physicalAcquisitions:acquired.length,unsettledExposure:exposure,noFinancialQualification:true,noOriginalGrantOrDeadlineExtended:true};
}catch(error){result={schema:'finnor.v2.deadline-probe.v1',status:'FAIL',startedAt,finishedAt:new Date().toISOString(),failure:(error as Error).message};process.exitCode=1;}
finally{clearTimeout(timer);}
await writeFile(join(output,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,evidence:output}));
