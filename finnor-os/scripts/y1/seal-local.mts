/** Engineering evidence binding only. This tool cannot confer qualification. */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {readFile,readdir,stat,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {runtimeIdentity} from '../../packages/private-equity/src/economic-action-theory/process';
import {byteDigest,digest,PROFILE_DIGEST} from '../../packages/private-equity/src/economic-action-theory/contracts';
const repo=resolve(import.meta.dirname,'../../..'),scope=join(repo,'scope-postx/y1-economic-action-theory'),
 output=join(scope,'handoff/release.json');
const directories=['FINNOR_Y1_INSTALLED_EVIDENCE','FINNOR_Y1_BROWSER_EVIDENCE','FINNOR_Y1_RECONSTRUCTION_EVIDENCE']
 .map(key=>{const path=process.env[key];assert(path&&isAbsolute(path),key+'_ABSOLUTE_PATH_REQUIRED');return path;});
const [installed,browser,reconstruction]=directories as [string,string,string],read=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
assert.equal(git('status','--porcelain','--untracked-files=all'),'','CLEAN_COMMITTED_SOURCE_REQUIRED');
const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),identity=await runtimeIdentity();
async function installedReport(directory:string){
 const report=await read(join(directory,'report.json')),runtime=await read(join(directory,'installed-runtime.json'));
 assert.equal(report.allExecutedPassed,true);assert.equal(report.builtApi,true);assert(report.results.length>=24);
 assert(report.results.every((v:any)=>v.status==='PASS'));
 const required=['A-durable-construction-and-laws','A-logical-negative-dispositions','B-independent-body-law-and-certificate-mutations',
  'C-principal-and-work-isolation','D-checkpoint-death-and-original-fenced-recovery',
  'D-owner-commit-death-cancel-and-original-effect-recovery','E-native-programme-effect-and-observation',
  'E-canonical-query-preserves-original-Work','E-substitution-reuse-and-stale-state','E-shared-capacity-contention',
  'F-selective-closure-and-unaffected-semantic-preimages','F-current-admitted-fallback-and-original-episode',
  'C-emitted-production-bootstrap-refuses-unprotected-secrets'];
 assert(required.every(name=>report.results.some((v:any)=>v.name===name)));
 assert.equal(runtime.api,'EMITTED_NEXT15');assert.equal(runtime.worker,'EMITTED_ESM_WITH_ACTUAL_CREATE_WORKER');
 assert.equal(runtime.manifest.source.semanticCodeDigest,identity.semanticCodeDigest);
 assert.equal(runtime.manifest.profileDigest,PROFILE_DIGEST);
 assert.equal(report.protectedQualification,false);assert.equal(report.unseenProtectedFamilies,0);assert.equal(report.qualifiedEquippedBaseline,false);
 return {cases:report.results.map((v:any)=>({name:v.name,status:v.status,wallMs:v.wallMs})),wallMs:report.wallMs,runtime};
}
const original=await installedReport(installed),mounted=await read(join(browser,'browser-results.json')),
 rebuilt=await read(join(reconstruction,'reconstruction.json'));
assert.equal(mounted.status,'PASS_MOUNTED_EMITTED_Y1_DEVELOPMENT');assert.equal(mounted.protectedQualification,false);
const browserCases=['mounted-construct-admit-reserve-compose-native-effect-canonical-observation-and-download',
 'held-success-across-real-token-refresh-exact-original-replay','held-error-across-real-token-refresh-exact-original-replay',
 'spa-Work-switch-fences-actual-delayed-private-read-and-constructs-separate-Work',
 'signed-principal-change-hides-old-private-theory-and-download','mounted-current-Work-invalidation-disables-use-and-download'];
assert(browserCases.every(id=>mounted.steps.some((v:any)=>v.id===id)));
assert.equal(rebuilt.status,'PASS_FRESH_LOCKFILE_RECONSTRUCTION');assert.equal(rebuilt.commit,commit);assert.equal(rebuilt.tree,tree);
assert.equal(rebuilt.borrowedDependenciesUsedForBuild,false);assert.equal(rebuilt.workspaceLinksWithinCheckout,true);
assert.equal(rebuilt.freshLockfileInstalls,2);assert(rebuilt.commands.every((v:any)=>v.exitCode===0));
const independent=await installedReport(rebuilt.installedEvidence);
const independentBrowser=await read(join(rebuilt.browserEvidence,'browser-results.json'));
assert.equal(independentBrowser.status,'PASS_MOUNTED_EMITTED_Y1_DEVELOPMENT');
assert(browserCases.every(id=>independentBrowser.steps.some((v:any)=>v.id===id)));
assert.equal(digest(await read(join(scope,'profile.json'))),PROFILE_DIGEST);
assert(isAbsolute(rebuilt.sourcePacket));
const source=await read(join(rebuilt.sourcePacket,'source.json'));
assert.equal(source.commit,commit);assert.equal(source.tree,tree);
for(const entry of [source.archive,source.commitObject]){
 const bytes=await readFile(join(rebuilt.sourcePacket,entry.path));
 assert.equal(bytes.length,entry.bytes);assert.equal(byteDigest(bytes),entry.sha256);
}
const files:Array<{path:string;bytes:number;sha256:string}>=[];
let evidenceBytes=0;const seen=new Set<string>();
async function scan(root:string,path=root){
 for(const entry of await readdir(path,{withFileTypes:true})){
  const file=join(path,entry.name);assert(!entry.isSymbolicLink(),'NO_EVIDENCE_SYMLINKS');
  if(entry.isDirectory())await scan(root,file);
  else if(entry.isFile()){
   if(seen.has(file))continue;seen.add(file);
   const metadata=await stat(file);evidenceBytes+=metadata.size;
   assert(evidenceBytes<=67108864,'FROZEN_EVIDENCE_STORAGE_BOUND');
   files.push({path:file,bytes:metadata.size,sha256:byteDigest(await readFile(file))});
  }
 }
}
for(const directory of [join(scope,'evidence'),...directories,rebuilt.installedEvidence])await scan(directory);
files.sort((a,b)=>a.path.localeCompare(b.path));
const retainedFailures:Array<{path:string;kind:string}>=[];
for(const file of files){
 if(file.path.endsWith('/browser-failure.json'))retainedFailures.push({path:file.path,kind:'BROWSER_FAILURE'});
 else if(file.path.endsWith('/report.json')&&(await read(file.path)).allExecutedPassed===false)
  retainedFailures.push({path:file.path,kind:'ENGINEERING_CAMPAIGN_FAILURE'});
}
const packet={schema:'finnor.y1.local-engineering-handoff.v1',commit,tree,sourceBase:'07e5a6a182dae37c3b0f3ec056c1d604a684be2b',
 profileDigest:PROFILE_DIGEST,semanticRuntime:identity,sourcePacket:{path:rebuilt.sourcePacket,manifest:source},originalInstalled:original,
 mounted:{status:mounted.status,cases:mounted.steps.map((v:any)=>v.id),qualification:mounted.qualification},
 reconstruction:rebuilt,independentInstalled:independent,
 independentMounted:{status:independentBrowser.status,cases:independentBrowser.steps.map((v:any)=>v.id)},
 evidence:{files,bytes:evidenceBytes,digest:digest(files),retainedFailures},
 completion:{engineering:'VERIFIED_BOUNDED_ORDINARY_DEVELOPMENT',protectedQualification:'NOT_ESTABLISHED',
  protectedFamiliesSubmitted:0,qualifiedEquippedBaseline:false,signedProtectedAdmission:false,productionActivated:false,
  financialEfficacyEstablished:false,comparativeGainEstablished:false},
 protectedGate:{unseenFamilies:20,minimumAccepted:18,minimumTracesPerFamily:200,minimumIncrementalFamilies:5,independentCustodyRequired:true},
 limitations:['Unavailable governing POST-X PRD/final S lock/blueprint source bytes',
  'Public fixtures prove safety, not protected novelty','No production Y1 execution beyond the earlier protected-secrets bootstrap refusal',
  'Legacy dynamic owner adapters require delivered source custody and tsx','Docker image was not built or deployed',
  'Money, human time and aggregate concurrent peak memory are unknown'],
 counters:{protectedSubmissions:0,realEconomicEffects:0},publication:{pushed:false,published:false,deployed:false}};
await mkdir(join(scope,'handoff'),{recursive:true});await writeFile(output,JSON.stringify(packet,null,2)+'\n');
console.log('Y1_LOCAL_ENGINEERING_HANDOFF',relative(repo,output),byteDigest(await readFile(output)));
