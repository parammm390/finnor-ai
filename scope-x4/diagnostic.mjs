#!/usr/bin/env node
/** Summarize retained real arms. Never score an unequipped native incumbent or
 * turn partial process counters into a financial/performance denominator. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [root,activeName,passiveName,out]=process.argv.slice(2);
assert(root&&isAbsolute(root)&&activeName&&passiveName&&out&&isAbsolute(out),
 'Usage: node scope-x4/diagnostic.mjs <absolute evidence root> <active directory> <passive directory> <new absolute output directory>');
const sha=v=>createHash('sha256').update(v).digest('hex'),read=async(path)=>JSON.parse(await readFile(path,'utf8'));
async function arm(name){
 const dir=join(root,name),[inputs,discovery,events,receipt,allocation,experiments]=await Promise.all([
  read(join(dir,'inputs.json')),read(join(dir,'discovery.json')),read(join(dir,'canonical/events.json')),
  read(join(dir,'receipt.json')),read(join(dir,'original-allocation-proof.json')),read(join(dir,'canonical/experiments.json'))]);
 assert.equal(receipt.allPassed,true);
 const firstReplica=events.findIndex(v=>v.kind==='INDEPENDENT_REPLICATION_ASSIGNED');
 const beforeReplica=events.slice(0,firstReplica<0?events.length:firstReplica);
 const analyses=beforeReplica.filter(v=>v.kind==='HYPOTHESES_UPDATED').map(v=>v.body.analysis);
 const ordinary=analyses.find(v=>v.analyzedExperimentIds.length===1),last=analyses.at(-1);assert(ordinary&&last);
 const sizes=a=>({inclusionClasses:a.predicateIds.length,numericProgrammes:a.numericIds.length,
  cartesianProduct:a.predicateIds.length*a.numericIds.length,refutations:a.refutations.length});
 const baseline=experiments.find(v=>v.phase==='BASELINE');assert(baseline?.result);
 const normalizedBaseline={controls:baseline.protocol.trial.controls,
  inputs:baseline.protocol.trial.records.map(({features,value})=>({features,value})),
  observed:baseline.result.records.map(r=>({position:baseline.protocol.trial.records.findIndex(v=>v.id===r.id),value:r.value})).sort((a,b)=>a.position-b.position)};
 const resources=beforeReplica.filter(v=>v.kind==='CHILD_RESOURCES').map(v=>v.body);
 return {inputs,discovery,receipt,summary:{name,identificationId:receipt.identificationId,sourceCutDigest:receipt.sourceCutDigest,mode:inputs.request.mode,
  initialAfterOrdinaryObservation:sizes(ordinary),afterDiscovery:sizes(last),discoveryStatus:discovery.status,guardAtDiscovery:discovery.guard,
  normalizedBaseline,originalAllocation:inputs.request.limits,spentAtDiscovery:discovery.limits.spent,
  measuredScientificChildren:{count:resources.length,cpuMicros:resources.reduce((n,r)=>n+r.cpuMicros,0),
   wallMsSum:resources.reduce((n,r)=>n+r.wallMs,0),supervisorWallMsSum:resources.reduce((n,r)=>n+r.supervisorWallMs,0),
   maxSingleChildProcessRSSBytes:Math.max(0,...resources.map(r=>r.peakProcessRSSBytes))},
  wholeRunActualAcceptedExperiments:receipt.physicalExperiments,wholeRunAllocation:allocation,
  protectedAdmission:false,productionActive:false}};
}
const [a,p]=await Promise.all([arm(activeName),arm(passiveName)]);
assert.equal(a.receipt.sourceCutDigest,p.receipt.sourceCutDigest);assert.deepEqual(a.inputs.request.domain,p.inputs.request.domain);
assert.deepEqual(a.inputs.request.question,p.inputs.request.question);assert.deepEqual(a.inputs.request.limits,p.inputs.request.limits);
assert.deepEqual(a.summary.normalizedBaseline,p.summary.normalizedBaseline);
assert(a.summary.initialAfterOrdinaryObservation.cartesianProduct>1);assert(p.summary.afterDiscovery.cartesianProduct>1);
assert.equal(p.discovery.status,'OBSERVATION_ONLY_PARTIAL');assert.equal(p.discovery.model,null);
assert.equal(a.discovery.status,'AWAITING_REPLICATION');
const nativePaths=['finnor-os/packages/epistemic-runtime/src/experiments.ts','finnor-os/packages/epistemic-runtime/src/interventions.ts',
 'finnor-os/packages/private-equity/src/enterprise-experiments.ts','finnor-os/packages/private-equity/src/enterprise-interventions.ts'];
const nativeContracts=await Promise.all(nativePaths.map(async path=>({path,sha256:sha(await readFile(join(repo,path)))})));
const unknown=reason=>({kind:'UNKNOWN',reason});
const report={schema:'finnor.x4.development-diagnostic.v1',status:'RECORDED_DEVELOPMENT_ABLATION_NOT_MATCHED_STRONGEST_INCUMBENT',
 question:a.inputs.request.question,domainDigest:sha(JSON.stringify(a.inputs.request.domain)),sourceCutDigest:a.receipt.sourceCutDigest,
 sharedQuestionDomainLimitsAndOrdinaryExposureVerified:true,arms:[a.summary,p.summary],
 activeOutcome:{checkedModelsAndFreshReplication:'See actual canonical model/replication artifacts in the active arm',actualDecision:'See decision.json; a queued acknowledgment is not completion'},
 strongestNativePath:{status:'NOT_EQUIPPED_FOR_A_MATCHED_AUTONOMOUS_FINITE_EXPORT_COMPARISON',executedMatchedComparison:false,nativeContracts,
  reason:'Existing S2 requires supplied finite-IID priors/instrument laws; S3 requires supplied temporal equations and recorded history and correctly projects null priors/UNKNOWN S2 laws. No calibrated laws, equipped matched native request or qualified B_ref was supplied. A malformed request or invented probabilities would not be a legitimate comparator.'},
 B_ref:{status:'BLOCKED_NOT_SUPPLIED',scored:false},observationOnlyIsStrongestIncumbent:false,
 qualifyingGain:unknown('No equipped strongest matched incumbent and no complete lifecycle cost denominator. No ratio or amortization is computed.'),
 unmeasuredCosts:{money:unknown('Provider billing and complete independent money denominator absent'),humanWork:unknown('Engineering, domain and operator work not independently metered'),
  aggregatePeakMemory:unknown('Per-child peaks do not measure the simultaneous API/worker/provider/database process tree'),
  fullCampaignWallTime:unknown('These arm artifacts do not meter all design, failed iterations, installs, builds and independent qualification')},
 qualification:'BUILDER_CONTROLLED_DEVELOPMENT_ONLY_NOT_ORIGINAL_POPULATION',protectedAdmission:false,productionActive:false,financialSuccessEstablished:false,operational100xEstablished:false};
await mkdir(out,{recursive:false});await writeFile(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');
console.log('X4_DIAGNOSTIC_RECORDED',JSON.stringify({sourceCutDigest:report.sourceCutDigest,arms:report.arms.map(v=>({mode:v.mode,ordinary:v.initialAfterOrdinaryObservation,after:v.afterDiscovery,spent:v.spentAtDiscovery})),matchedStrongestIncumbent:false,out}));
