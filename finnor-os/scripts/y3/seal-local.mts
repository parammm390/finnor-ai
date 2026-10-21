/** Bind honest, possibly incomplete engineering evidence to local source.
 * This is not a protected admission, production activation or value proof. */
import {strict as assert} from 'node:assert';
import {readFile,readdir,stat,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,isAbsolute,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {sourceCut,currentApiReceipt} from './runtime-custody.mjs';
import {runtimeIdentity} from '../../packages/private-equity/src/interaction-synthesis/process';
import {PROFILE_DIGEST,digest} from '../../packages/private-equity/src/interaction-synthesis/contracts';
const repo=resolve(import.meta.dirname,'../../..'),scope=join(repo,'scope-postx/y3-dynamic-interaction-synthesizer'),
 delivery=process.env.FINNOR_Y3_DELIVERY_ROOT,mathPath=process.env.FINNOR_Y3_MATH_REPORT,
 validationPath=process.env.FINNOR_Y3_VALIDATION_REPORT,packetPath=process.env.FINNOR_Y3_SOURCE_PACKET;
assert([delivery,mathPath,validationPath].every(p=>p&&isAbsolute(p)),'ABSOLUTE_DELIVERY_MATH_AND_VALIDATION_PATHS_REQUIRED');
const read=async(path:string)=>JSON.parse(await readFile(path,'utf8')),
 hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),
 cut=await sourceCut(),math=await read(mathPath!),identity=await runtimeIdentity(),validation=await read(validationPath!);
assert.equal(cut.dirty,false,'CLEAN_COMMITTED_SOURCE_REQUIRED');
assert.equal(math.status,'PASS');assert.equal(math.results.length,20);assert(math.results.every((r:any)=>r.status==='PASS'));
for(const field of ['profileDigest','producerDigest','checkerDigest','codeDigest'] as const)
 assert.equal(math.identity[field],identity[field],'CURRENT_MATHEMATICAL_CLOSURE_REQUIRED:'+field);
assert.equal(identity.profileDigest,PROFILE_DIGEST);
assert.equal(validation.schema,'finnor.y3.low-disk-validation.v1');
assert(validation.checks.length>0&&validation.checks.every((r:any)=>r.exitCode===0),'ALL_RECORDED_STATIC_CHECKS_MUST_PASS');
assert.equal(validation.sourcePreimageDigest,cut.preimageDigest,'STATIC_CHECK_SOURCE_PREIMAGE_STALE');
const requiredCases=[
 'F-authentication-contracts-and-restricted-migration','F-queued-original-input-to-independently-checked-protocol',
 'F-isolation-replay-download-and-comparison','E-exact-terms-revision-both-participant-consents-and-S5-contention',
 'F-lawful-local-observation-actions-and-exact-effect-intent','E-native-Y1-entrypoint-cannot-bypass-current-effect-consent',
 'F-fixed-lowering-native-S6-effect-separate-S7-observation',
 'E-observation-source-head-locks-through-native-commit-and-retains-corrected-readback',
 'G-prequeued-requests-share-exhausted-original-allocation-with-terminal-readback',
 'G-current-dynamic-incumbent-and-honest-UNKNOWN-fallback','G-physical-checker-death-checkpoint-and-original-resume',
 'G-physical-worker-death-stale-claim-native-redelivery','G-owner-commit-death-cancellation-and-original-S7-reconciliation',
 'E-source-model-replacement-selective-closure-and-Work-steering','E-checker-runtime-substitution-fences-unpublished-request',
 'E-database-immutability-budget-and-physical-lease-release','E-current-participant-revocation-and-production-refusal'];
const requiredBrowser=[
 'mounted-original-models-native-synthesis-global-beliefs-and-download',
 'spa-Work-switch-fences-delayed-participant-projection','logout-and-signed-peer-change-hide-owner-private-models-and-download',
 'nonparticipant-cannot-inspect-protocol','focus-during-held-native-mutation-releases-busy-latch-without-dropping-original',
 'delayed-success-across-real-token-refresh-original-replay','delayed-error-across-real-token-refresh-original-replay',
 'offline-in-flight-clears-private-state-and-recovers-original-without-stuck-busy',
 'mounted-two-principal-terms-local-knowledge-separate-effect-consents-fixed-native-effect-and-S7-readback',
 'Work-revision-invalidates-use-without-rebinding-old-consents','rights-revision-fences-mounted-private-results-and-new-use'];
async function optional(path:string|undefined,name:string){
 if(!path)return null;assert(isAbsolute(path),name+'_ABSOLUTE_PATH_REQUIRED');return read(path);
}
const installedDir=process.env.FINNOR_Y3_INSTALLED_EVIDENCE,browserDir=process.env.FINNOR_Y3_BROWSER_EVIDENCE,
 reconstructionDir=process.env.FINNOR_Y3_RECONSTRUCTION_EVIDENCE,
 installed=await optional(installedDir&&join(installedDir,'report.json'),'INSTALLED'),
 mounted=await optional(browserDir&&join(browserDir,'browser-results.json'),'MOUNTED'),
 rebuilt=await optional(reconstructionDir&&join(reconstructionDir,'report.json'),'RECONSTRUCTION');
let compiled=false,browser=false,reconstructed=false,apiReceipt:unknown=null;
if(installed){
 assert.equal(installed.status,'PASS_INSTALLED_Y3_DEVELOPMENT');assert.equal(installed.actualBuiltApi,true);
 assert(installed.cases.length>=requiredCases.length&&installed.cases.every((r:any)=>r.status==='PASS'));
 assert(requiredCases.every(id=>installed.cases.some((r:any)=>r.id===id)));
 const runtime=await read(join(installedDir!,'installed-runtime.json'));
 assert.equal(runtime.source.head,cut.head);assert.equal(runtime.source.preimageDigest,cut.preimageDigest);
 apiReceipt=await currentApiReceipt(cut);compiled=true;
}
if(mounted){
 assert.equal(mounted.status,'PASS_MOUNTED_EMITTED_Y3_DEVELOPMENT');
 assert(requiredBrowser.every(id=>mounted.steps.some((r:any)=>r.id===id)));
 assert.equal(mounted.protectedQualification,false);
 const runtime=await read(join(browserDir!,'installed-runtime.json'));
 assert.equal(runtime.source.head,cut.head);assert.equal(runtime.source.preimageDigest,cut.preimageDigest);
 const accessibility=await read(join(browserDir!,'mounted-accessibility.json'));
 assert.equal((accessibility.data?.violations??accessibility.data?.result?.violations)?.length,0);browser=true;
}
if(rebuilt){
 assert.equal(rebuilt.status,'PASS_FRESH_LOCKFILE_RECONSTRUCTION');assert.equal(rebuilt.commit,cut.head);assert.equal(rebuilt.tree,cut.tree);
 assert.equal(rebuilt.freshLockfileInstalls,2);assert.equal(rebuilt.borrowedDependenciesUsedForBuild,false);
 assert.equal(rebuilt.workspaceLinksWithinCheckout,true);assert.equal(rebuilt.noGitAlternates,true);
 assert.equal(rebuilt.temporaryStorageIncludedInMeters,true);assert(rebuilt.commands.every((r:any)=>r.exitCode===0));
 const independent=await read(join(rebuilt.installedEvidence,'report.json'));
 assert.equal(independent.status,'PASS_INSTALLED_Y3_DEVELOPMENT');assert.equal(independent.actualBuiltApi,true);
 assert(requiredCases.every(id=>independent.cases.some((r:any)=>r.id===id&&r.status==='PASS')));reconstructed=true;
}
const verified=compiled&&browser&&reconstructed;
assert(verified||process.env.FINNOR_Y3_ALLOW_INCOMPLETE_SEAL==='1','INCOMPLETE_EVIDENCE_CANNOT_EARN_VERIFIED_SEAL');
let sourcePacket:unknown=null;
if(packetPath){
 assert(isAbsolute(packetPath));const source=await read(join(packetPath,'source.json'));
 assert.equal(source.schema,'finnor.y3.source-preimage.v1');assert.equal(source.commit,cut.head);assert.equal(source.tree,cut.tree);
 for(const entry of [source.archive,source.commitObject]){
  assert.equal(basename(entry.path),entry.path);const bytes:Buffer=await readFile(join(packetPath,entry.path));
  assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);
 }
 sourcePacket={path:packetPath,manifest:source};
}
const files:Array<{path:string;bytes:number;sha256:string}>=[],failures:Array<{path:string;status:string}>=[];
let evidenceBytes=0;const seen=new Set<string>();
async function scan(directory:string){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);assert(!entry.isSymbolicLink(),'EVIDENCE_SYMLINK_REFUSED');
  if(entry.isDirectory())await scan(path);
  else if(entry.isFile()&&!seen.has(path)){
   seen.add(path);const info=await stat(path);evidenceBytes+=info.size;assert(evidenceBytes<=134217728,'FROZEN_EVIDENCE_STORAGE_BOUND');
   const bytes=await readFile(path);files.push({path,bytes:bytes.length,sha256:hash(bytes)});
   if(entry.name==='report.json'){
    const report=JSON.parse(bytes.toString());if(['FAIL','FAILED_RETAINED'].includes(report.status))failures.push({path,status:report.status});
   }
  }
 }
}
for(const path of [...new Set([delivery!,installedDir,browserDir,reconstructionDir].filter((p):p is string=>!!p))])await scan(path);
files.sort((a,b)=>a.path.localeCompare(b.path));
const worker=await read(join(repo,'finnor-os/dist-y3/manifest.json'));
assert.equal(worker.sourceCut.head,cut.head);assert.equal(worker.sourceCut.preimageDigest,cut.preimageDigest);
assert.equal(hash(await readFile(join(repo,'finnor-os/dist-y3',worker.worker.path))),worker.worker.sha256);
const release={schema:'finnor.y3.local-engineering-handoff.v1',commit:cut.head,tree:cut.tree,branch:cut.branch,
 sourceBase:{live:'b7b74b48efcb51bd6f1297a71f39cb9b4f117024',Y1:'e559705f42921c397acb5388d103809d03cab1b2',
  integration:'6b7f3748009358ad4849d4cc743e9da336fe08bc',Y2:'INSPECTED_NOT_ADOPTED',Y4:'PARALLEL_NOT_ADOPTED'},
 sourcePreimages:cut,sourcePacket,profileDigest:PROFILE_DIGEST,mathematics:{path:mathPath,status:'PASS',cases:20,identity},
 staticValidation:validation,emittedWorker:worker,compiledApi:apiReceipt,
 gates:{compiledOwner:compiled,mountedWork:browser,cleanReconstruction:reconstructed,protectedGames:false,equippedComparison:false},
 completion:{DESIGNED:true,CODE_COMPLETE:verified?'CONFIRMED_FOR_BOUNDED_PROFILE':'IMPLEMENTED_NOT_FINAL_RUNTIME_VERIFIED',
  E2E_DEV_VERIFIED:verified,DOMAIN_QUALIFIED:false,PRODUCTION_ACTIVE:false,
  governingSourceParity:'UNKNOWN',operational100x:false,financial100x:false,H0:false,H1:false,H2:'NOT_MATURE'},
 verificationStop:verified?null:{reason:'USER_REQUESTED_KEEP_DATABASES_AND_STOP_DISK_HEAVY_VERIFICATION',
  finalReviewRegressionsNotRun:true,earlierSourceDiagnosticsAreNotInstalledEvidence:true},
 evidence:{files,bytes:evidenceBytes,digest:digest(files),retainedFailedCampaigns:failures,databasesDeletedAfterUserRefusal:false},
 protectedGate:{independentGames:24,feasibleGames:16,requiredFeasibleSuccesses:15,infeasibleGoals:8,
  requiredInfeasibilityProofs:8,exactFullContinuationRegret:'0',oneCommonMixedLimitPerModel:true,submissions:0},
 limitations:['Original POST-X PRD, approved S lock, reviewed blueprint, full original R1 and boundary skill unavailable',
  'Bounded rational behavior grid is incomplete for general non-grid/algebraic equilibria and general nonunit synthesis',
  'Existing fixed Y1 adapter supports disposable internal reservation rights only, not payments, liabilities or settlement',
  'Inherited owner adapters require canonical source custody and freshly installed locked TS adapters',
  'No protected/equipped comparison, production census/activation, container image or financial efficacy proof',
  'Money, human time and aggregate concurrent peak memory remain unknown'],
 publication:{pushed:false,published:false,deployed:false},counters:{protectedSubmissions:0,realEconomicEffects:0}};
const output=join(scope,'handoff/release.json');await mkdir(join(scope,'handoff'),{recursive:true});
await writeFile(output,JSON.stringify(release,null,2)+'\n');
console.log(verified?'Y3_VERIFIED_LOCAL_DEVELOPMENT_HANDOFF':'Y3_INCOMPLETE_LOCAL_ENGINEERING_HANDOFF',output,hash(await readFile(output)));
