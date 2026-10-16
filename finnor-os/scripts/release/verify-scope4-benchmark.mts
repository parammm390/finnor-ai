/** Affected real database boundary only; does not replace full certification. */
import EmbeddedPostgres from 'embedded-postgres';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {closePool} from '@finnor/db';
import {MIGRATIONS} from '../../packages/db/migrations-bundle';
import {benchmark} from './run-scope4-digital-twin-certification';
const output=process.env.FINNOR_BENCHMARK_PROOF;
if(!output||process.env.NODE_ENV!=='test')throw Error('Owned evidence file and disposable test mode required');
const dir=await mkdtemp(join(tmpdir(),'finnor-scope4-repair-'));
const server=createServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
const port=(server.address() as {port:number}).port;await new Promise<void>(yes=>server.close(()=>yes()));
const postgres=new EmbeddedPostgres({databaseDir:dir,user:'finnor',password:'finnor',port,persistent:false,postgresFlags:['-c','track_commit_timestamp=on'],onLog:()=>undefined});
const receipt:any={schema:'finnor.scope4.benchmark-repair.v1',status:'FAIL',startedAt:new Date().toISOString(),
  qualification:'HISTORICAL_CORPUS_CURRENT_SCHEMA_QUERY_BENCHMARK_NOT_V3_CLOSE_ACCEPTANCE',
  sourceSha256:createHash('sha256').update(await readFile(new URL('./run-scope4-digital-twin-certification.ts',import.meta.url))).digest('hex'),
  migrations:MIGRATIONS.map(m=>({name:m.name,sha256:createHash('sha256').update(m.sql).digest('hex')})),
  rerun:'NODE_ENV=test FINNOR_BENCHMARK_PROOF=<fresh-file> node --import=tsx scripts/release/verify-scope4-benchmark.mts'};
process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';
try{await postgres.initialise();await postgres.start();await postgres.createDatabase('benchmark');
  receipt.observed=await benchmark('postgres://finnor:finnor@127.0.0.1:'+port+'/benchmark',MIGRATIONS);receipt.status='PASS';
}catch(error){receipt.error=String(error);receipt.stack=(error as Error).stack;process.exitCode=1;}
finally{await closePool().catch(()=>undefined);await postgres.stop().catch(()=>undefined);await rm(dir,{recursive:true,force:true});receipt.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:receipt.status,error:receipt.error,metrics:receipt.observed?.metrics}));
