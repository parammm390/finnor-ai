/** Fresh authenticated emitted-owner/physical-service boundary per case. The
 * preregistered A–G defects require specific native reasons, not any failure. */
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {mkdir,open,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {artifact,hash,repo} from '../x3/environment.mts';
assert.equal(process.env.FINNOR_X4_BUILT_API,'1');
assert(process.env.FINNOR_X4_EVIDENCE_DIR);
const evidence=resolve(process.env.FINNOR_X4_EVIDENCE_DIR);
await mkdir(evidence,{recursive:true});
const cases:Array<{id:string;env:Record<string,string>}>=[
 ...['cancel','revoke','deadline','observations','experiments','analysis','role','version','authority','work','work-cancel'].map(id=>({id:'boundary-'+id,env:{FINNOR_X4_BOUNDARY:id,FINNOR_X4_PHASE:'discovery'}})),
 ...['duplicate','missing','wrong-unit','stale','truncated'].map(id=>({id:'instrument-'+id,env:{FINNOR_X4_INSTRUMENT_FAULT:id,FINNOR_X4_PHASE:'discovery'}})),
 ...['snapshot-start','page-truncate','role-filter','combined','affine'].map(id=>({id:'mechanism-'+id,env:{FINNOR_X4_CASE:id}})),
 {id:'unrepresentable',env:{FINNOR_X4_CASE:'unrepresentable',FINNOR_X4_PHASE:'discovery'}},
 {id:'observation-only',env:{FINNOR_X4_PASSIVE:'1',FINNOR_X4_PHASE:'discovery'}},
 {id:'mechanism-claim-not-supported',env:{FINNOR_X4_CLAIM:'MECHANISM_SPECIFIC'}},
 {id:'failed-independent-replica',env:{FINNOR_X4_REPLICA_FAILURE:'1'}},
 {id:'actual-exposure-mismatch',env:{FINNOR_X4_EXPOSURE_MISMATCH:'1',FINNOR_X4_PHASE:'discovery'}},
 {id:'physical-response-loss',env:{FINNOR_X4_RESPONSE_LOSS:'1'}},
 {id:'new-immutable-model-on-repeat-replication',env:{FINNOR_X4_CASE:'affine',FINNOR_X4_REPEAT_REPLICA:'1'}},
 {id:'real-queue-concurrent-claim',env:{FINNOR_X4_RECOVERY:'concurrent',FINNOR_X4_PHASE:'discovery'}},
 {id:'cancel-after-physical-acceptance',env:{FINNOR_X4_RECOVERY:'inflight-cancel',FINNOR_X4_PHASE:'discovery'}},
 {id:'worker-death-api-restart-original-lease-recovery',env:{FINNOR_X4_RECOVERY:'crash',FINNOR_X4_PHASE:'discovery'}},
 {id:'expired-physical-provider-actual-canonical-wait',env:{FINNOR_X4_CASE:'snapshot-request',FINNOR_X4_DECISION_AFTER_EXPIRY:'1'}},
 {id:'retained-instrument-still-requires-independent-check',env:{FINNOR_X4_INSTRUMENT_FAULT:'wrong-event',FINNOR_X4_PHASE:'discovery'}},
 {id:'canonical-work-cancel-after-checked-model',env:{FINNOR_X4_CASE:'affine',FINNOR_X4_CANONICAL_WORK_CANCEL:'1',FINNOR_X4_S8:'1'}},
];
const selected=process.env.FINNOR_X4_MATRIX_CASES?.split(',');
const registered=selected?cases.filter(c=>selected.includes(c.id)):cases;
assert(registered.length&&(!selected||selected.length===registered.length));
const sourceCutDigest=hash(await readFile(join(repo,'finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts')));
const verificationPaths=[
 ...(await readdir(join(repo,'finnor-os/scripts/x4'))).filter(p=>p.endsWith('.mts')).map(p=>'finnor-os/scripts/x4/'+p),
 'finnor-os/scripts/x3/environment.mts','finnor-os/scripts/x3/mounted-fixture.mts','finnor-os/scripts/r1/http-fixture.mts',
 'finnor-os/scripts/s8/lifecycle-fixture.mts','scope-x4/acceptance/specification.md','scope-x4/acceptance/additional-boundaries.md','scope-x4/acceptance/provider-cases.json',
].sort();
const verificationFiles=()=>Promise.all(verificationPaths.map(async path=>({path,sha256:hash(await readFile(join(repo,path)))})));
const frozenVerification=await verificationFiles();await artifact(evidence,'verification-files.json',frozenVerification);
const results:any[]=[];
await artifact(evidence,'registration.json',{schema:'finnor.x4.development-boundary-matrix.v1',cases:registered,sourceCutDigest,verificationDigest:hash(JSON.stringify(frozenVerification)),originalAcceptance:'scope-x4/acceptance/specification.md',qualification:'DEVELOPMENT_NOT_ORIGINAL_POPULATION'});
for(const c of registered){
 assert.equal(hash(await readFile(join(repo,'finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts'))),sourceCutDigest);
 assert.deepEqual(await verificationFiles(),frozenVerification);
 const directory=join(evidence,c.id);await mkdir(directory,{recursive:true});
 const log=await open(join(directory,'process.log'),'wx'),started=Date.now();
 const child=spawn(process.execPath,['--import=tsx','scripts/x4/run-installed.mts'],{cwd:join(repo,'finnor-os'),
  env:{...process.env,...c.env,FINNOR_X4_EVIDENCE_DIR:directory},stdio:['ignore',log.fd,log.fd]});
 const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
 const outcome=await new Promise<{code:number|null;signal:string|null}>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});
 clearTimeout(timer);await log.close();
 let receipt:unknown;try{receipt=JSON.parse(await readFile(join(directory,outcome.code===0?'receipt.json':'failure.json'),'utf8'));}catch{}
 results.push({id:c.id,env:c.env,...outcome,wallMs:Date.now()-started,receipt,allPassed:outcome.code===0});
 await artifact(evidence,'results.json',{sourceCutDigest,results,complete:results.length===registered.length,allPassed:results.every(r=>r.allPassed)});
 console.log('X4_MATRIX_CASE',c.id,outcome.code===0?'PASS':'FAIL');
}
assert(results.every(r=>r.allPassed),'X4_MATRIX_FAILURES_RETAINED');
console.log('X4_MATRIX_PASS',results.length);
