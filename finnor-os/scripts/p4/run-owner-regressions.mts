/** Disposable provider for unchanged real integration tests; no reconstructed owners. */
import EmbeddedPostgres from 'embedded-postgres';
import {mkdtemp,mkdir,appendFile,writeFile,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=resolve(import.meta.dirname,'../../..'),output=join(repo,'scope-pm/phase-01-p4-evidence-execution/scope-evidence/owner-regression-consumer-queue');await mkdir(output,{recursive:true});
const files=['tests/integration/queue.test.ts','tests/integration/private-equity-p4-underwriting.test.ts','tests/integration/private-equity-p5-ic-runtime.test.ts'];
const directory=await mkdtemp(join(tmpdir(),'finnor-p4-regressions-')),startedAt=new Date().toISOString();let postgres:EmbeddedPostgres|undefined;
try{const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return no(Error('port'));s.close(()=>yes(a.port));});});
 postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('owner_regressions');
 const identity=await Promise.all(files.map(async path=>({path:'finnor-os/'+path,sha256:createHash('sha256').update(await readFile(join(repo,'finnor-os',path))).digest('hex')})));
 const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--reporter=json','--outputFile='+join(output,'vitest-results.json')],{cwd:join(repo,'finnor-os'),env:{...process.env,NODE_ENV:'test',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',DATABASE_URL:`postgres://finnor:finnor@127.0.0.1:${port}/owner_regressions`},stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);const code=await new Promise<number|null>(yes=>child.once('exit',yes));await writeFile(join(output,'console.log'),text);await writeFile(join(output,'run-manifest.json'),JSON.stringify({startedAt,endedAt:new Date().toISOString(),command:'node --import=tsx scripts/p4/run-owner-regressions.mts',cwd:join(repo,'finnor-os'),profile:'fresh embedded PostgreSQL provider; unchanged existing integration tests select actual ordinary role themselves',environmentNames:['NODE_ENV','FINNOR_TEST_MANAGED_EXTENSIONS','DATABASE_URL'],files:identity,exitCode:code,billingUSD:null,costStatus:'LOCAL_COST_UNMETERED'},null,2));process.exitCode=code===0?0:1;console.log(JSON.stringify({output,exitCode:code}));
}finally{await postgres?.stop().catch(()=>undefined);await rm(directory,{recursive:true,force:true});}
