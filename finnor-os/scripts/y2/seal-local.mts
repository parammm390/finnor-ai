/** Bind local engineering evidence, never protected evaluator custody. */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {STRATEGIC_SEMANTIC_FILES} from '../../packages/epistemic-runtime/src/strategic-response/source-paths';
import {strategicRuntimeIdentity} from '../../packages/epistemic-runtime/src/strategic-response/process';
import {PROFILE_DIGEST,bytesDigest,digest} from '../../packages/private-equity/src/strategic-response/contracts';
const repo=resolve(import.meta.dirname,'../../..'),scope=join(repo,'scope-postx/y2-strategic-response-world-model'),
 directories=['FINNOR_Y2_INSTALLED_EVIDENCE','FINNOR_Y2_BROWSER_EVIDENCE','FINNOR_Y2_RECONSTRUCTION_EVIDENCE'].map(name=>{
  const path=process.env[name];assert(path&&isAbsolute(path),name+'_ABSOLUTE_PATH_REQUIRED');return path;
 });
const [installed,browser,reconstruction]=directories as [string,string,string],
 read=async(path:string)=>JSON.parse(await readFile(path,'utf8')),
 git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
assert.equal(git('status','--porcelain','--untracked-files=all'),'','CLEAN_COMMITTED_Y2_SOURCE_REQUIRED');
const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),identity=await strategicRuntimeIdentity();
assert(identity.assetsMatchEmitted);assert.deepEqual(identity.sourcePins.map(p=>p.path),[...STRATEGIC_SEMANTIC_FILES]);
const appCases=['01-authentication-migration-and-strict-body','02-durable-fitted-complete-model-set',
 '03-current-principal-root-evidence-and-replay','04-uninformative-labels-and-requested-experiments',
 '05-separate-admission-and-fresh-withheld-prediction','06-independent-mutations-are-rejected',
 '07-actual-s4-incumbent-and-identified-programme','08-actor-local-private-feedback-and-shared-paths',
 '09-unavailable-checker-original-resume-and-fallback','10-real-worker-checkpoint-death-and-fenced-recovery',
 '11-no-supported-model-and-untruncated-resource-refusal','12-cancellation-original-guards-and-Work-invalidation',
 '13-retained-y1-canonical-S5-S6-S7-preimage','14-transport-withdrawal-fences-new-use-retains-commitments',
 '15-authority-and-runtime-currentness','16-original-fit-and-durable-use-grants-exhaust',
 '17-production-profile-refuses-development-port'];
async function application(directory:string){
 const report=await read(join(directory,'summary.json'));assert.equal(report.status,'PASS');
 assert.equal(report.transport,'ACTUAL_BUILT_NEXT_API');assert.equal(report.emittedNativeWorker,true);
 assert.equal(report.authBypass,false);assert.equal(report.publicSyntheticOnly,true);
 assert.equal(report.protectedQualification,false);assert.equal(report.equippedXGainEstablished,false);
 assert.equal(report.financialEfficacyEstablished,false);
 assert.equal(report.cases.length,appCases.length);assert(report.cases.every((v:any)=>v.status==='PASS'));
 assert(appCases.every(id=>report.cases.some((v:any)=>v.id===id)));
 for(const id of appCases){
  const c=await read(join(directory,'cases',id+'.json'));assert.equal(c.id,id);assert.equal(c.status,'PASS');
 }
 const fit=(await read(join(directory,'cases',appCases[1]+'.json'))).observed,
  admission=(await read(join(directory,'cases',appCases[4]+'.json'))).observed.admission,
  runtime=await read(join(repo,'finnor-os/dist-y2/manifest.json'));
 assert.equal(fit.emittedWorker.sha256,runtime.worker.sha256);
 assert.equal(fit.independentCheck.checkerDigest,identity.checkerDigest);assert.equal(fit.independentCheck.profileDigest,PROFILE_DIGEST);
 assert.equal(admission.runtimeDigest,identity.semanticCodeDigest);assert.equal(admission.domain,'STRATEGIC_RESPONSE_MODEL_SET');
 assert.equal(admission.executionAuthorityGranted,false);assert.equal(admission.protectedAdmission,false);
 const production=(await read(join(directory,'cases',appCases[16]+'.json'))).observed;
 assert.equal(production.protectedProfile.status,403);assert.equal(production.refused.status,500);
 assert.equal(production.productionRefusalOwner,'CANONICAL_PRODUCTION_SECRETS_GUARD_BEFORE_Y2_DISPATCH');
 assert.equal(production.y2ReachedInProduction,false);
 const retained=(await read(join(directory,'cases',appCases[12]+'.json'))).observed,responsibility=retained.responsibility;
 assert.equal(retained.observed.status,'OBSERVED');
 assert.equal(retained.recovery.pendingAfter.status,'PREPARED');assert.equal(retained.recovery.pendingAfter.observedGoalDigest,null);
 assert.equal(retained.recovery.unresolved.status,'STALE_INPUT');
 assert.equal(retained.recovery.blindEffectReplay,false);assert.equal(retained.recovery.responsibilityStillRequiresOwner,true);
 assert(responsibility.pending.length>0&&responsibility.pending.every((v:any)=>v.status==='compiled'));
 assert.equal(responsibility.effectRowsFabricated,false);
 assert.equal(responsibility.canonical.status,'STALE_INPUT');assert.equal(responsibility.existingUse.current,false);
 assert.equal(responsibility.existingUse.status,'INVALIDATED');assert(responsibility.existingUse.artifact);
 assert.equal(responsibility.newProgramme.status,422);
 assert.equal(responsibility.newProgramme.body.code,'Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
 return report;
}
const browserCases=['mounted-learn-inspect-download-admit-predict-and-canonical-S4-incumbent',
 'mounted-unknown-prediction-resumes-original-use','real-token-refresh-late-success-exact-original-replay',
 'real-token-refresh-late-error-exact-original-replay','SPA-Work-fence-and-supported-coordination-with-original-S4-mandate',
 'mounted-executable-compatible-fallback-and-original-model-resume','mounted-queued-model-cancellation-without-checker-publication',
 'mounted-original-use-cancellation','mounted-canonical-Work-invalidation-fences-new-use',
 'SPA-root-change-fences-late-artifact-before-blob-creation','signed-principal-change-hides-late-private-model-and-download'];
async function mounted(directory:string){
 const report=await read(join(directory,'browser-results.json'));
 assert.equal(report.status,'PASS_MOUNTED_EMITTED_Y2_DEVELOPMENT');assert.equal(report.protectedQualification,false);
 assert(browserCases.every(id=>report.steps.some((v:any)=>v.id===id)));assert.equal(report.steps.length,browserCases.length);
 assert.equal((await read(join(directory,'browser-process.json'))).exitCode,0);
 assert.equal((await read(join(directory,'frontend-build.json'))).code,0);
 assert((await read(join(directory,'frontend-source.json'))).buildId);
 assert(report.sql.deliveries.length>0);assert(report.sql.uses.some((v:any)=>v.kind==='DECISION'&&v.artifact?.result?.policy));
 assert.equal(report.steps.find((v:any)=>v.id===browserCases[0]).admitted.runtimeDigest,identity.semanticCodeDigest);
 assert(report.sql.auth.refreshes>=2&&report.sql.auth.refreshedApiSuccesses>0);
 const download=report.steps.find((v:any)=>v.id===browserCases[0]).download,
  bytes=await readFile(join(directory,'downloads/checked-strategic-response.json'));
 assert.equal(bytesDigest(bytes),download.sha256);assert.equal(bytes.length,download.bytes);
 return {status:report.status,cases:report.steps.map((v:any)=>v.id),qualification:report.qualification};
}
const original=await application(installed),originalBrowser=await mounted(browser),rebuilt=await read(join(reconstruction,'reconstruction.json'));
assert.equal(rebuilt.status,'PASS_FRESH_LOCKFILE_RECONSTRUCTION');assert.equal(rebuilt.commit,commit);assert.equal(rebuilt.tree,tree);
assert.equal(rebuilt.freshLockfileInstalls,2);assert.equal(rebuilt.borrowedDependenciesUsedForBuild,false);
assert.equal(rebuilt.workspaceLinksWithinCheckout,true);assert.equal(rebuilt.compilerOutputStorageShared,false);
assert.equal(rebuilt.temporaryStorageIncludedInMeters,true);assert(rebuilt.commands.every((v:any)=>v.exitCode===0));
for(const name of ['root-fresh-npm-ci','backend-fresh-npm-ci','generated-and-owner-preflight','emitted-api-build',
 'emitted-worker-build','backend-typecheck','campaign-typecheck','installed-native-owner-campaign',
 'mounted-emitted-browser-campaign','frontend-typecheck'])assert(rebuilt.commands.some((v:any)=>v.name===name));
assert(rebuilt.meters.every((v:any)=>v.ownedBytes<=rebuilt.bounds.ownedBytes&&v.free.every((f:any)=>f.bytes>=rebuilt.bounds.minimumFreeBytes)));
assert(rebuilt.wallMs<rebuilt.bounds.wallMs);
const independent=await application(rebuilt.installedEvidence),independentBrowser=await mounted(rebuilt.browserEvidence),
 source=await read(join(rebuilt.sourcePacket,'source.json'));
assert.equal(source.commit,commit);assert.equal(source.tree,tree);
for(const entry of [source.archive,source.commitObject]){
 const bytes=await readFile(join(rebuilt.sourcePacket,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(bytesDigest(bytes),entry.sha256);
}
const manifest=await read(join(scope,'verification-manifest.json')),coverage=manifest.cases.filter((v:any)=>v.required).map((v:any)=>{
 const matching=original.cases.filter((c:any)=>c.claims.includes(v.id));
 const extra=v.id==='Y2-12'?originalBrowser.cases:v.id==='Y2-15'?['PASS_FRESH_LOCKFILE_RECONSTRUCTION']:v.id==='Y2-16'?['generated-and-owner-preflight']:[];
 assert(matching.length||extra.length,'MISSING_REQUIRED_Y2_OBLIGATION:'+v.id);
 return {id:v.id,claim:v.claim,status:'PASS_BOUNDED_DEVELOPMENT',applicationCases:matching.map((c:any)=>c.id),additionalEvidence:extra};
});
assert.equal(coverage.length,16);
const files:Array<{path:string;bytes:number;sha256:string}>=[],seen=new Set<string>(),failures:Array<{path:string;kind:string}>=[];
let evidenceBytes=0;
async function scan(path:string){
 for(const entry of await readdir(path,{withFileTypes:true})){
  const file=join(path,entry.name);assert(!entry.isSymbolicLink(),'NO_Y2_EVIDENCE_SYMLINKS');
  if(entry.isDirectory())await scan(file);
  else if(entry.isFile()&&!seen.has(file)){
   seen.add(file);const metadata=await stat(file);evidenceBytes+=metadata.size;
   assert(evidenceBytes<=268435456,'Y2_HANDOFF_EVIDENCE_STORAGE_BOUND');
   files.push({path:file,bytes:metadata.size,sha256:bytesDigest(await readFile(file))});
   if(entry.name==='browser-failure.json')failures.push({path:file,kind:'MOUNTED_BROWSER_FAILURE'});
   else if(entry.name==='summary.json'&&(await read(file)).status==='FAIL')failures.push({path:file,kind:'APPLICATION_CAMPAIGN_FAILURE'});
   else if(entry.name==='reconstruction.json'&&(await read(file)).status==='FAILED_RETAINED')failures.push({path:file,kind:'RECONSTRUCTION_FAILURE'});
  }
 }
}
for(const directory of [join(scope,'evidence'),...directories,rebuilt.sourcePacket])await scan(directory);
for(const entry of (await read(join(scope,'failure-ledger.json'))).entries){
 if(!entry.evidence)continue;
 const path=isAbsolute(entry.evidence)?entry.evidence:join(scope,entry.evidence);
 if(isAbsolute(entry.evidence)){try{await stat(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;failures.push({path,kind:'UNAVAILABLE_HISTORICAL_EVIDENCE'});continue;}}
 if(!seen.has(path)){const bytes=await readFile(path);seen.add(path);files.push({path,bytes:bytes.length,sha256:bytesDigest(bytes)});evidenceBytes+=bytes.length;}
}
assert(evidenceBytes<=268435456);files.sort((a,b)=>a.path.localeCompare(b.path));
const output=join(scope,'handoff/release.json'),packet={schema:'finnor.y2.local-engineering-handoff.v1',commit,tree,
 productionSource:'b7b74b48efcb51bd6f1297a71f39cb9b4f117024',completedY1:'e559705f42921c397acb5388d103809d03cab1b2',
 profileDigest:PROFILE_DIGEST,semanticRuntime:identity,sourcePacket:{path:rebuilt.sourcePacket,manifest:source,
 codec:'REUSED_UNCHANGED_Y1_EXACT_COMMIT_AND_COMPLETE_TREE_PREIMAGE'},coverage,
 originalInstalled:original,originalMounted:originalBrowser,reconstruction:rebuilt,independentInstalled:independent,independentMounted:independentBrowser,
 evidence:{files,bytes:evidenceBytes,digest:digest(files),retainedFailures:failures,historicalEpisodesCurrentAtSeal:'NOT_ASSERTED'},
 completion:{designed:true,codeComplete:true,finiteDevelopmentManifestVerified:true,freshLockReconstructionVerified:true,
  originalSourceClauseParity:'UNKNOWN',protectedQualification:false,qualifiedEquippedXComparison:false,protectedAdmission:false,
  productionActivated:false,operational100xEstablished:false,financialEfficacyEstablished:false},
 frontierDelta:{changed:'ACTOR_LOCAL_RESPONSE_IDENTIFIED_SETS_PUBLIC_RULE_MEANING_AND_POLICY_DEPENDENT_JOINT_PATHS',
  reused:'CANONICAL_S3_JOINT_DYNAMICS_S4_SEARCH_S5_S6_S8_P7_AUTH_WORK_AND_SOURCE_CUSTODY',
  novelQualifiedEconomicFamilies:0,operationalSpeedup:null,comparativeGain:null},
 limitations:['Only the frozen 2–3 actor, binary-choice, four-period deterministic class is implemented',
  'ORACLE.md mentions four/eight-actor development extensions outside the frozen profile; those are unsupported, not passed',
  'Original PRD, final S lock and reviewed R1 source bytes are unavailable',
  'All decisive economic observations are public synthetic, conditional on declared assumptions',
  'No probabilities, calibrated field predictions, equilibrium or unique behavioral-model claim',
  'Real randomized field evidence remains blocked pending separately qualified S2 authority',
  'Production secrets bootstrap refused before Y2 dispatch; no protected-production Y2 episode ran',
  'Source custody and locked workspace dependencies remain required; no Docker image is claimed',
  'Money, human time and aggregate concurrent peak memory are unknown'],
 counters:{protectedSubmissions:0,realEconomicEffects:0,newProtectedSigners:0},
 publication:{pushed:false,published:false,deployed:false}};
await mkdir(join(scope,'handoff'),{recursive:true});await writeFile(output,JSON.stringify(packet,null,2)+'\n',{flag:'wx'});
console.log('Y2_LOCAL_ENGINEERING_HANDOFF',output,bytesDigest(await readFile(output)));
