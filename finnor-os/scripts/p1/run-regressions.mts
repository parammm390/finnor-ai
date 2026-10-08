/** Existing native runtime/artifact/IC regressions, isolated from every real DB. */
import EmbeddedPostgres from 'embedded-postgres';
import {mkdtemp,mkdir,writeFile,readFile,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {currentCodeIdentity} from '../../packages/private-equity/src/evidence-execution/store';
const backend=resolve(import.meta.dirname,'../..'),output=resolve(process.argv[2]??'../scope-pm/phase-04-p1-program-synthesis/scope-evidence/native-regressions');await mkdir(output,{recursive:false});
const selected=process.argv.slice(3),cases=selected.length?selected:[
 'tests/integration/phase6-plan-graph-runtime.test.ts','tests/integration/phase6-plan-concurrency.test.ts','tests/integration/queue.test.ts',
 'tests/integration/artifact-os.test.ts','tests/integration/private-equity-p4-underwriting.test.ts',
 'tests/integration/private-equity-p5-ic-runtime.test.ts','tests/integration/private-equity-p1-world-truth.test.ts','tests/planner-evals/replay.test.ts',
];
if(cases.some(p=>!/^tests\/(integration|planner-evals)\/[a-zA-Z0-9_.-]+\.test\.ts$/.test(p)))throw Error('REGISTERED_EXISTING_TEST_PATH_REQUIRED');
const sources=await Promise.all(cases.map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(backend,path))).digest('hex')}))),productionBefore=await currentCodeIdentity();
const directory=await mkdtemp(join(tmpdir(),'finnor-p1-regressions-')),port=await new Promise<number>((yes,no)=>{const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return no(Error('NO_LOCAL_PORT'));server.close(()=>yes(address.port));});});
const postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
const env:Record<string,string>={};for(const key of ['HOME','PATH','TMPDIR'])if(process.env[key])env[key]=process.env[key]!;Object.assign(env,{NODE_ENV:'test',CI:'1',LOG_LEVEL:'silent',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',DATABASE_URL:`postgres://finnor:finnor@127.0.0.1:${port}/p1_regressions`});
const args=['node_modules/vitest/vitest.mjs','run',...cases,'--reporter=json','--outputFile='+join(output,'vitest-results.json')],receipt:any={schema:'finnor.p1.existing-regressions.v1',startedAt:new Date().toISOString(),command:[process.execPath,...args],cwd:backend,environmentNames:Object.keys(env),sources,productionBefore,node:process.version,billingUSD:null,qualification:'EXISTING_NATIVE_INTEGRATION_AND_PLANNER_DIAGNOSTICS; NO_SEALED_OR_MODEL_COMPARISON'};
let started=false;try{await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();started=true;await postgres.createDatabase('p1_regressions');let log='';receipt.exitCode=await new Promise<number>((yes,no)=>{const child=spawn(process.execPath,args,{cwd:backend,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b.toString());child.stderr.on('data',b=>log+=b.toString());child.once('error',no);child.once('exit',n=>yes(n??1));});await writeFile(join(output,'runner.log'),log);const result=JSON.parse(await readFile(join(output,'vitest-results.json'),'utf8'));receipt.counts={total:result.numTotalTests,PASS:result.numPassedTests,FAIL:result.numFailedTests,NOT_RUN:result.numPendingTests};receipt.productionAfter=await currentCodeIdentity();receipt.productionUnchanged=receipt.productionAfter.digest===productionBefore.digest;if(!receipt.counts.PASS||receipt.counts.FAIL||!receipt.productionUnchanged)receipt.exitCode=receipt.exitCode||1;
}catch(error){receipt.exitCode=1;receipt.error=String(error);}finally{if(started)await postgres.stop();await rm(directory,{recursive:true,force:true});receipt.finishedAt=new Date().toISOString();await writeFile(join(output,'run-manifest.json'),JSON.stringify(receipt,null,2)+'\n');}
console.log(JSON.stringify({output,exitCode:receipt.exitCode,counts:receipt.counts,error:receipt.error}));process.exitCode=receipt.exitCode;
