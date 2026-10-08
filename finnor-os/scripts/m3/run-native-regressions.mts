/** Disposable provider for unchanged queue/underwriting/IC integration tests. */
import EmbeddedPostgres from 'embedded-postgres';
import {appendFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const repo=resolve(import.meta.dirname,'../../..'),args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--evidence'||!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(args[1]!))
 throw Error('Use --evidence <unique lowercase basename>');
const output=join(repo,'scope-pm/phase-05-m3-capital-program/scope-evidence',args[1]!);
await mkdir(output);
const files=['tests/integration/queue.test.ts','tests/integration/private-equity-p4-underwriting.test.ts',
 'tests/integration/private-equity-p5-ic-runtime.test.ts'],
 identities=await Promise.all(files.map(async path=>({path:'finnor-os/'+path,
  sha256:createHash('sha256').update(await readFile(join(repo,'finnor-os',path))).digest('hex')}))),
 directory=await mkdtemp(join(tmpdir(),'finnor-m3-native-regression-'));
let postgres:EmbeddedPostgres|undefined,exitCode=1;
try{
 const port=await new Promise<number>((yes,no)=>{
  const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{
   const address=server.address();if(!address||typeof address==='string')return no(Error('Port unavailable'));
   server.close(()=>yes(address.port));
  });
 });
 postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
 await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');
 await postgres.start();await postgres.createDatabase('m3_native_regressions');
 const command=['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1','--fileParallelism=false',
  '--reporter=json','--outputFile='+join(output,'vitest-results.json')],startedAt=new Date().toISOString(),
  child=spawn(process.execPath,command,{cwd:join(repo,'finnor-os'),env:{...process.env,NODE_ENV:'test',
   FINNOR_TEST_MANAGED_EXTENSIONS:'omit',DATABASE_URL:`postgres://finnor:finnor@127.0.0.1:${port}/m3_native_regressions`},
   stdio:['ignore','pipe','pipe']});
 let text='';child.stdout.on('data',chunk=>text+=chunk);child.stderr.on('data',chunk=>text+=chunk);
 const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('exit',yes);});
 await writeFile(join(output,'console.log'),text,{flag:'wx'});
 const result=JSON.parse(await readFile(join(output,'vitest-results.json'),'utf8'));
 exitCode=code===0&&result.success&&result.numTotalTests>0&&result.numPendingTests===0&&result.numFailedTests===0?0:1;
 await writeFile(join(output,'run-manifest.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),
  command,cwd:join(repo,'finnor-os'),files:identities,childExitCode:code,exitCode,
  selection:{total:result.numTotalTests,passed:result.numPassedTests,failed:result.numFailedTests,pending:result.numPendingTests},
  qualification:'UNCHANGED_ORIGINAL_TESTS_ON_FRESH_DISPOSABLE_DATABASE',money:null},null,2)+'\n',{flag:'wx'});
}finally{
 await postgres?.stop();await rm(directory,{recursive:true,force:true});
}
process.exit(exitCode);
