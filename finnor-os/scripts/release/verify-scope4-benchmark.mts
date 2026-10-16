/** Affected real database boundary only; does not replace full certification. */
import EmbeddedPostgres from 'embedded-postgres';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {closePool} from '@finnor/db';
import {MIGRATIONS} from '../../packages/db/migrations-bundle';
import {migrate} from '../../packages/db/migrate';
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
  const url='postgres://finnor:finnor@127.0.0.1:'+port+'/benchmark';
  const probeOnly=process.env.FINNOR_SOURCE_PAIR_PROBE_ONLY==='1';
  if(probeOnly){await migrate(url,MIGRATIONS);receipt.qualification='SOURCE_VERSION_FK_DATABASE_PROBE_ONLY_NO_BENCHMARK';}
  else receipt.observed=await benchmark(url,MIGRATIONS);
  const client=new pg.Client({connectionString:url});await client.connect();
  try {
    const tenant='60000000-0000-4000-8000-000000000001',principal='60000000-0000-4000-8000-000000000002',source='60000000-0000-4000-8000-000000000003',version='60000000-0000-4000-8000-000000000004',other=randomUUID();
    await client.query('SET search_path=pg_catalog');
    if(probeOnly){
      await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,'source-pair-probe','Source pair probe')",[tenant]);
      await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'original','document','Original source')",[source,tenant]);
      await client.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,as_of) VALUES($1,$2,'tenant',$3,1,$4,'Synthetic probe facts',now())",[version,source,tenant,'c'.repeat(64)]);
    }
    await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,$3,'document','Separate source')",[other,tenant,other]);
    const cases=[];
    for(const owner of ['primary','bilateral']) {
      const constraint='s1_'+owner+'_observation_source_version_fk';
      const catalog=(await client.query("SELECT convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2",['finnor_os.s1_'+owner+'_observations',constraint])).rows;
      assert.equal(catalog.length,1);assert.equal(catalog[0].convalidated,true);
      assert.equal(catalog[0].definition,'FOREIGN KEY (tenant_id, evidence_source_id, evidence_version_id) REFERENCES finnor_os.evidence_source_versions(tenant_id, source_id, id)');
      // Isolate the exact installed FK from unrelated missing programme parents.
      // This is a database-constraint probe, not an accepted V owner write.
      await client.query('CREATE TABLE public.source_pair_probe(tenant_id uuid,evidence_source_id uuid,evidence_version_id uuid,CONSTRAINT source_pair_fk '+catalog[0].definition+')');
      for(const mismatch of [false,true]) {
        let observed:any;try{await client.query('INSERT INTO public.source_pair_probe VALUES($1,$2,$3)',[tenant,mismatch?other:source,version]);}catch(error){observed=error;}
        if(mismatch){assert.equal(observed?.code,'23503');assert.equal(observed.constraint,'source_pair_fk');}else assert.equal(observed,undefined);
        cases.push({owner,mismatch,accepted:!observed,code:observed?.code??null,installedConstraint:constraint,validated:catalog[0].convalidated,
          qualification:'EXACT_INSTALLED_FK_ON_REAL_SOURCE_ROWS_ISOLATED_DATABASE_PROBE_NOT_V_OWNER_ACCEPTANCE'});
      }
      await client.query('DROP TABLE public.source_pair_probe');
    }
    receipt.sourceVersionBinding=cases;
  } finally {await client.end();}
  receipt.status='PASS';
}catch(error){receipt.error=String(error);receipt.stack=(error as Error).stack;process.exitCode=1;}
finally{await closePool().catch(()=>undefined);await postgres.stop().catch(()=>undefined);await rm(dir,{recursive:true,force:true});receipt.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:receipt.status,error:receipt.error,metrics:receipt.observed?.metrics}));
process.exit(receipt.status==='PASS'?0:1);
