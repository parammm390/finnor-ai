/** Fresh disposable provider for unchanged native Work, identity, effect, compute,
 * underwriting, IC and queue integration tests. No parallel owner substitutes. */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, mkdir, appendFile, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const repo=resolve(import.meta.dirname,'../../..');
const output=join(repo,'scope-pm/phase-02-m1-decision-slice/scope-evidence',
  `owner-regressions-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(output,{recursive:true});
const files=[
  'tests/integration/queue.test.ts',
  'tests/integration/private-equity-p4-underwriting.test.ts',
  'tests/integration/private-equity-p5-ic-runtime.test.ts',
  'tests/integration/private-equity-p1-world-truth.test.ts',
  'tests/integration/scope2-effect-protocol.test.ts',
  'tests/integration/external-effect-observation.test.ts',
  'tests/integration/work-kernel.test.ts',
  'tests/integration/work-cases.test.ts',
  'tests/integration/identity-access-upgrade.test.ts',
  'tests/integration/auth-identity-bootstrap.test.ts',
  'tests/integration/company-brain-tenant-isolation.test.ts',
  'tests/unit/api-route-auth-boundary.test.ts',
];
const directory=await mkdtemp(join(tmpdir(),'finnor-m1-owner-regressions-'));
const startedAt=new Date().toISOString();
let postgres:EmbeddedPostgres|undefined;
try{
  const port=await new Promise<number>((yes,no)=>{
    const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{
      const address=server.address();if(!address||typeof address==='string')return no(Error('PORT_UNAVAILABLE'));
      server.close(()=>yes(address.port));
    });
  });
  postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,
    persistent:false,onLog:()=>undefined});
  await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');
  await postgres.start();await postgres.createDatabase('m1_owner_regressions');
  const identity=await Promise.all(files.map(async path=>({path:'finnor-os/'+path,
    sha256:createHash('sha256').update(await readFile(join(repo,'finnor-os',path))).digest('hex')})));
  const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,
    '--reporter=json','--outputFile='+join(output,'vitest-results.json')],{
    cwd:join(repo,'finnor-os'),env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','TMPDIR'].includes(key))),
      NODE_ENV:'test',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',
      DATABASE_URL:`postgres://finnor:finnor@127.0.0.1:${port}/m1_owner_regressions`},stdio:['ignore','pipe','pipe']});
  let text='';child.stdout.on('data',bytes=>text+=bytes);child.stderr.on('data',bytes=>text+=bytes);
  const code=await new Promise<number|null>(yes=>child.once('exit',yes));
  await writeFile(join(output,'console.log'),text);
  await writeFile(join(output,'run-manifest.json'),JSON.stringify({startedAt,endedAt:new Date().toISOString(),
    command:'node --import=tsx scripts/m1/run-owner-regressions.mts',cwd:join(repo,'finnor-os'),
    profile:'Fresh embedded PostgreSQL; unchanged existing tests select actual ordinary role themselves',
    environmentNames:['NODE_ENV','FINNOR_TEST_MANAGED_EXTENSIONS','DATABASE_URL'],files:identity,exitCode:code,
    dollarCost:null,costStatus:'LOCAL_COST_UNMETERED'},null,2)+'\n');
  process.exitCode=code===0?0:1;console.log(JSON.stringify({output,exitCode:code}));
}finally{
  await postgres?.stop().catch(()=>undefined);
  // Only this runner's mkdtemp-generated, nonpersistent provider is removed.
  await rm(directory,{recursive:true,force:true});
}
