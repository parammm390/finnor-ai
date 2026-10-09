/** Preregistered release/upgrade rehearsal using real SQL and owner routes. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {appendFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {migrate,type MigrationFile} from '../../packages/db/migrate';
import {MIGRATIONS} from '../../packages/db/migrations-bundle';
import {CURRENT_MIGRATION_HEAD,closePool,configureTenantVertical,receiveWork,withTenantTransaction} from '@finnor/db';
import {loadPrivateEquityWorldState} from '@finnor/private-equity';
import {CapitalProgramV2Operations} from '@finnor/shared-types';
import {M1_OPERATIONS} from '../../packages/private-equity/src/decision-slice/handler';
import {EVIDENCE_OPERATIONS} from '../../packages/private-equity/src/evidence-execution/api';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';

const repo=resolve(import.meta.dirname,'../../..'),output=process.env.FINNOR_M3_EVIDENCE_DIR!;
assert(output&&output.startsWith(join(repo,'scope-pm/phase-05-m3-capital-program/scope-evidence/')));
const begun=new Date().toISOString(),cases:any[]=[],steps:any[]=[],sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const names=(await readdir(join(repo,'finnor-os/packages/db/migrations'))).filter(name=>name.endsWith('.sql')).sort();
const disk:MigrationFile[]=await Promise.all(names.map(async name=>({name,sql:await readFile(join(repo,'finnor-os/packages/db/migrations',name),'utf8')})));
const releaseFiles=['finnor-os/scripts/m3/run-install-e2e.mts','finnor-os/packages/db/migration-head.ts','finnor-os/packages/db/migrations-bundle.ts',
 'finnor-os/scripts/generate-openapi.ts','finnor-os/openapi.json','scripts/centropy/generate-capability-manifest.mjs',
 'src/lib/centropy/capability-manifest.generated.json','src/components/centropy/canvas/CapitalProgramPanel.tsx',
 'src/components/centropy/canvas/capital-program-view.ts','src/components/centropy/canvas/capital-program.css',
 'scope-pm/phase-05-m3-capital-program/continuation-contracts.md'];
const sourceIdentity=await Promise.all(releaseFiles.map(async path=>({path,sha256:sha(await readFile(join(repo,path)))})));
async function artifact(name:string,value:unknown){const path=join(output,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');}
async function save(){await artifact('results.json',{schema:'finnor.m3.install-e2e.v1',begun,finishedAt:new Date().toISOString(),cases,steps,sourceIdentity,
 migrations:disk.map(file=>({name:file.name,sha256:sha(file.sql)})),head:CURRENT_MIGRATION_HEAD,
 runtime:{node:process.version,platform:process.platform,architecture:process.arch},
 profile:'DISPOSABLE_GENERATED_BUNDLE_ORIGINAL_0155_AND_CURRENT_0164_POPULATED_UPGRADES_PHYSICAL_P6_INTERRUPTION',
 qualification:'Generated H0/H1 release rehearsal. Not production upgrade, hosted auth, clean dependency installation, independent seal or GateM3.',
 costs:{money:null,status:'UNMETERED',externalModelCalls:0},
 rerun:'python3 finnor-os/scripts/m3/run-owner-local.py --install'});}
async function challenge(id:string,expected:string,fn:()=>Promise<unknown>){
 const start=performance.now();try{cases.push({id,expected,status:'PASS',observed:await fn(),wallMs:performance.now()-start});}
 catch(error){cases.push({id,expected,status:'FAIL',observed:{message:String(error),stack:(error as Error).stack},wallMs:performance.now()-start});}
 console.log(JSON.stringify({id,status:cases.at(-1)!.status}));await save();
}
const temporary=await mkdtemp(join(tmpdir(),'finnor-m3-install-')),admins:pg.Client[]=[];
const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();assert(a&&typeof a!=='string');s.close(()=>yes(a.port));});});
const postgres=new EmbeddedPostgres({databaseDir:temporary,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
async function client(database:string){const c=new pg.Client({connectionString:`postgres://finnor:finnor@127.0.0.1:${port}/${database}`});await c.connect();admins.push(c);return c;}
async function application(database:string){await closePool();process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/${database}`;}
async function fixture(admin:pg.Client,database:string){
 const tenant=randomUUID(),principal=randomUUID(),company=randomUUID();
 await admin.query("SET app.test_vertical_mode='explicit'");
 await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'M3 install fixture')",[tenant,randomUUID()]);
 await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','M3 fixture')",[principal,tenant,`${principal}@test.invalid`]);
 await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'M3 install company','other')",[company,tenant,'m3-'+company]);
 await application(database);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'m3:install'});
 const ctx:any={auth:{tenantId:tenant,userId:principal,employeeId:principal,role:'owner'},provenance:{sourceSystem:'m3:install',createdBy:principal}};
 const root={entityType:'external_organization' as const,entityId:company};
 const received=await receiveWork({tenantId:tenant,userId:principal,instruction:'Actual Core root attachment',channel:'console',idempotencyKey:randomUUID(),activeContext:{entityRefs:[root]}});
 const link=(await admin.query('SELECT id::text FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 AND entity_id=$3',[tenant,received.workId,company])).rows[0];
 assert(link);return {tenant,principal,ctx,root,workId:received.workId,linkId:link.id};
}
async function call(f:any,operation:string,body:unknown){
 const r=await POST(new Request('http://127.0.0.1/api/company-brain/'+operation,{method:'POST',
 headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});
 return {status:r.status,body:await r.json()};
}
async function facts(c:pg.Client){
 return (await c.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='finnor_os' AND c.relname IN('m3_queries','m3_events','m3_publications','m3_dependencies','m3_branch_reviews','s5_candidate_problems') ORDER BY c.relname`)).rows;
}
try{
 await challenge('bundle-head-byte-identity','Release readiness, bundle and disk contain all 173 exact unique migrations; all 166 earlier SQL bodies match the committed predecessor',async()=>{
  assert.equal(CURRENT_MIGRATION_HEAD,'0171_runtime_database_role_isolation.sql');assert.equal(names.at(-1),CURRENT_MIGRATION_HEAD);
  assert.equal(disk.length,173);assert.equal(disk.filter(file=>file.name<'0165').length,166);
  assert.deepEqual(MIGRATIONS,disk);
  const forward=names.filter(name=>name>='0165');
  assert.equal(new Set(forward.map(name=>name.split('_')[0])).size,7);
  for(const file of disk.filter(file=>file.name<'0165')){
   const committed=spawnSync('git',['-C',repo,'show',`e1125cb75:finnor-os/packages/db/migrations/${file.name}`],{encoding:'utf8'});
   assert.equal(committed.status,0,committed.stderr);assert.equal(sha(file.sql),sha(committed.stdout));
  }
  return {head:CURRENT_MIGRATION_HEAD,count:names.length,earlierSqlUnchanged:true};
 });
 await postgres.initialise();await appendFile(join(temporary,'postgresql.conf'),'\ntrack_commit_timestamp=on\nmax_wal_size=64MB\nmin_wal_size=32MB\n');await postgres.start();
 await postgres.createDatabase('m3_fresh');await postgres.createDatabase('m3_upgrade');
 const freshApplied=await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/m3_fresh`,MIGRATIONS);
 const predecessor=disk.filter(file=>file.name<'0156');
 const oldApplied=await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/m3_upgrade`,predecessor);
 const fresh=await client('m3_fresh'),upgrade=await client('m3_upgrade');
 await fresh.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
 const old=await fixture(upgrade,'m3_upgrade');
 const oldSnapshot=(await upgrade.query('SELECT to_jsonb(l) body FROM finnor_os.work_entity_links l WHERE id=$1',[old.linkId])).rows[0].body;
 const preUpgradeAt=(await upgrade.query('SELECT clock_timestamp() at FROM pg_sleep(0.004)')).rows[0].at.toISOString();
 const upgradeApplied=await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/m3_upgrade`,disk);
 steps.push({action:'Actual fresh bundled install',applied:freshApplied},{action:'Actual committed-through-0155 install',applied:oldApplied},
  {action:'Actual populated predecessor upgrade',applied:upgradeApplied,preUpgradeAt,retainedWorkId:old.workId});
 await challenge('fresh-and-populated-upgrade','Both actual install paths contain all RLS M3 tables, preserve earlier Work/root rows, and idempotently skip already applied SQL',async()=>{
  assert.deepEqual(upgradeApplied,disk.filter(file=>file.name>='0156').map(file=>file.name));
  assert.deepEqual(await facts(fresh),await facts(upgrade));assert.equal((await facts(fresh)).length,6);
  assert((await facts(fresh)).every(row=>row.relrowsecurity&&row.relforcerowsecurity));
  assert.deepEqual((await upgrade.query('SELECT to_jsonb(l) body FROM finnor_os.work_entity_links l WHERE id=$1',[old.linkId])).rows[0].body,oldSnapshot);
  assert.deepEqual(await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/m3_fresh`,MIGRATIONS),[]);
  assert.deepEqual(await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/m3_upgrade`,disk),[]);
  const policies=(await upgrade.query("SELECT job_type FROM finnor_os.compute_job_type_policies WHERE job_type IN('run_evidence_derivation_v1','run_capital_program_v2') ORDER BY job_type")).rows;
  assert.equal(policies.length,2);return {tables:await facts(upgrade),policies,oldSnapshot};
 });
 await challenge('current-populated-166-migration-upgrade','Actual current predecessor preserves a real accepted Work/root row and installs only the six forward allocations',async()=>{
  await postgres.createDatabase('m3_current_upgrade');
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/m3_current_upgrade`;
  assert.equal((await migrate(url,disk.filter(file=>file.name<'0165'))).length,166);
  const current=await client('m3_current_upgrade'),f=await fixture(current,'m3_current_upgrade');
  const snapshot=(await current.query('SELECT to_jsonb(l) body FROM finnor_os.work_entity_links l WHERE id=$1',[f.linkId])).rows[0].body;
  const applied=await migrate(url,MIGRATIONS);
  assert.deepEqual(applied,disk.filter(file=>file.name>='0165').map(file=>file.name));
  assert.deepEqual((await current.query('SELECT to_jsonb(l) body FROM finnor_os.work_entity_links l WHERE id=$1',[f.linkId])).rows[0].body,snapshot);
  assert.equal((await current.query('SELECT count(*)::int n FROM finnor_os._migrations')).rows[0].n,173);
  assert.deepEqual(await migrate(url,MIGRATIONS),[]);
  return {applied,retainedWorkId:f.workId,retainedLinkId:f.linkId,totalMigrations:173};
 });
 await challenge('physical-p6-ddl-tracker-interruption','Terminating the exact backend during tracker insertion rolls back both P6 DDL and tracker row; unchanged retry commits both',async()=>{
  await postgres.createDatabase('m3_interrupted');
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/m3_interrupted`,registered='0170_p6_procedure_induction.sql';
  await migrate(url,disk.filter(file=>file.name<registered));
  const interrupted=await client('m3_interrupted');
  await interrupted.query(`CREATE FUNCTION finnor_os.rehearsal_p6_tracker_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name='0170_p6_procedure_induction.sql' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$;
    CREATE TRIGGER rehearsal_p6_tracker_delay BEFORE INSERT ON finnor_os._migrations
    FOR EACH ROW EXECUTE FUNCTION finnor_os.rehearsal_p6_tracker_delay()`);
  const applicationName='p6-interruption-'+randomUUID(),migrationUrl=new URL(url);
  migrationUrl.searchParams.set('application_name',applicationName);
  const code=`import {migrate} from ${JSON.stringify(pathToFileURL(join(repo,'finnor-os/packages/db/migrate.ts')).href)};await migrate(process.env.DATABASE_URL);`;
  const child=spawn(process.execPath,['--import=tsx','--input-type=module','-e',code],{
    cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:migrationUrl.href},stdio:'ignore',
  }),closed=new Promise<{code:number|null;signal:string|null}>((yes,no)=>{
    child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));
  });
  let pid:number|undefined;
  try{
    const until=performance.now()+15000;
    while(performance.now()<until){
      pid=(await interrupted.query(`SELECT pid FROM pg_stat_activity WHERE datname='m3_interrupted'
        AND application_name=$1 AND wait_event='PgSleep' AND query LIKE 'INSERT INTO finnor_os._migrations%'`,[applicationName])).rows[0]?.pid;
      if(pid)break;await new Promise(yes=>setTimeout(yes,20));
    }
    assert(pid,'Exact owned migration backend must reach the tracker delay');
    assert.equal((await interrupted.query('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0].terminated,true);
    const exit=await closed;assert.notEqual(exit.code,0);
    const after=(await interrupted.query(`SELECT to_regclass('finnor_os.p6_capsules')::text ddl,
      (SELECT count(*)::int FROM finnor_os._migrations WHERE name=$1) tracker`,[registered])).rows[0];
    assert.deepEqual(after,{ddl:null,tracker:0});
    await interrupted.query('DROP TRIGGER rehearsal_p6_tracker_delay ON finnor_os._migrations;DROP FUNCTION finnor_os.rehearsal_p6_tracker_delay()');
    const retry=[registered,CURRENT_MIGRATION_HEAD];
    assert.deepEqual(await migrate(url,MIGRATIONS),retry);
    assert((await interrupted.query("SELECT to_regclass('finnor_os.p6_capsules') table_name")).rows[0].table_name);
    assert.deepEqual(await migrate(url,MIGRATIONS),[]);
    return {mechanism:'EXACT_OWNED_POSTGRES_BACKEND_TERMINATED_AT_TRACKER_INSERT',pid,exit,after,retry};
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await closed;}}
 });
 await challenge('truthful-core-upgrade-baseline','Preexisting Core link receives an exact migration baseline, but prior knowledge does not inherit that current payload',async()=>{
  await application('m3_upgrade');
  const coverage=(await upgrade.query("SELECT coverage_started_at FROM finnor_os.canonical_history_coverage WHERE entity_type='work_entity_link'")).rows[0];
  const versions=(await upgrade.query("SELECT entity_version,snapshot,origin,recorded_at FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='work_entity_link' AND entity_id=$2",[old.tenant,old.linkId])).rows;
  assert.equal(versions.length,1);assert.equal(versions[0].origin,'baseline');assert(versions[0].recorded_at>=coverage.coverage_started_at);
  assert.deepEqual(versions[0].snapshot,{...oldSnapshot,history_deleted:false});
  const current=await loadPrivateEquityWorldState(old.ctx,old.root),earlier=await loadPrivateEquityWorldState(old.ctx,old.root,{knowledgeAt:preUpgradeAt});
  assert.equal(current.temporalCompleteness.status,'complete');assert(current.workLinks.some(row=>row.id===old.linkId));
  assert.equal(earlier.temporalCompleteness.status,'partial');assert(!earlier.workLinks.some(row=>row.id===old.linkId));
  return {coverage,versions,current:current.temporalCompleteness,earlier:earlier.temporalCompleteness};
 });
 await challenge('core-rollback-and-concurrent-history','Ordinary owning SQL rollback appends nothing; two genuine concurrent updates serialize exact immutable predecessor versions',async()=>{
  await application('m3_upgrade');
  const before=(await upgrade.query("SELECT count(*)::int n FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='work_entity_link' AND entity_id=$2",[old.tenant,old.linkId])).rows[0].n;
  await assert.rejects(()=>withTenantTransaction(old.tenant,{userId:old.principal},async(_db,c)=>{
   await c.query("UPDATE finnor_os.work_entity_links SET source='rollback-probe' WHERE id=$1",[old.linkId]);throw Error('ACTUAL_ROLLBACK');
  }),/ACTUAL_ROLLBACK/);
  assert.equal((await upgrade.query("SELECT count(*)::int n FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='work_entity_link' AND entity_id=$2",[old.tenant,old.linkId])).rows[0].n,before);
  const a=await client('m3_upgrade'),b=await client('m3_upgrade');
  for(const c of [a,b]){
   await c.query('BEGIN');await c.query('SET LOCAL ROLE finnor_app');
   await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[old.tenant,old.principal]);
  }
  await a.query("UPDATE finnor_os.work_entity_links SET source='first-concurrent-owner' WHERE id=$1",[old.linkId]);
  const pending=b.query("UPDATE finnor_os.work_entity_links SET source='second-concurrent-owner' WHERE id=$1",[old.linkId]);
  await a.query('COMMIT');await pending;await b.query('COMMIT');
  const versions=(await upgrade.query("SELECT id::text,entity_version,previous_version_id::text,snapshot FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='work_entity_link' AND entity_id=$2 ORDER BY entity_version",[old.tenant,old.linkId])).rows;
  assert.equal(versions.length,before+2);assert.equal(versions[1].previous_version_id,versions[0].id);assert.equal(versions[2].previous_version_id,versions[1].id);
  assert.equal(versions[1].snapshot.source,'first-concurrent-owner');assert.equal(versions[2].snapshot.source,'second-concurrent-owner');
  await assert.rejects(()=>withTenantTransaction(old.tenant,{userId:old.principal},(_db,c)=>c.query("UPDATE finnor_os.work_entity_links SET id=$2 WHERE id=$1",[old.linkId,randomUUID()])),/identity is immutable/);
  const world=await loadPrivateEquityWorldState(old.ctx,old.root);assert.equal(world.workLinks.find(row=>row.id===old.linkId)?.source,'second-concurrent-owner');
  return {before,versions,rollbackRetainedNoVersion:true};
 });
 await challenge('ordinary-role-private-and-immutable','Actual application role is not privileged; foreign principal reads are empty and immutable history writes refuse',async()=>{
  await application('m3_upgrade');
  await assert.rejects(()=>withTenantTransaction(old.tenant,{userId:old.principal},(_db,c)=>c.query(
   "UPDATE finnor_os.canonical_entity_versions SET snapshot='{}'::jsonb WHERE tenant_id=$1 AND entity_type='work_entity_link'",[old.tenant])),/permission denied|immutable|append.only/i);
  return withTenantTransaction(old.tenant,{userId:old.principal},async(_db,c)=>{
   const role=(await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
   assert.equal(role.current_user,'finnor_app');assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
   assert.equal((await c.query("SELECT has_table_privilege(current_user,'finnor_os.m3_events','UPDATE') mutable")).rows[0].mutable,false);
   assert.equal((await c.query("SELECT has_table_privilege(current_user,'finnor_os.m3_branch_reviews','DELETE') mutable")).rows[0].mutable,false);
   await c.query("SELECT set_config('app.user_id',$1,true)",[randomUUID()]);
   assert.equal((await c.query('SELECT * FROM finnor_os.m3_events')).rowCount,0);
   return {role,foreignPrivateRows:0,policies:await facts(upgrade)};
  });
 });
 await challenge('preserved-authenticated-owner-routes','Authentic current Core, M1, P4 and M3 routes still dispatch; bounded invalid requests do not become unknown operations',async()=>{
  await application('m3_fresh');const f=await fixture(fresh,'m3_fresh');
  const roots=await call(f,'roots',{}),handles=await call(f,'evidence-handles',{root:f.root,inputs:[]});
  const m1=await call(f,'decision-slice-compile',{}),m3=await call(f,'capital-program-submit',{});
  assert.equal(roots.status,200);assert.equal(handles.status,200);assert.equal(m1.status,400);assert.equal(m3.status,400);
  return {roots,handles,m1,m3};
 });
 await challenge('discovery-and-openapi-identity','M1/P4/M3 exact operations remain uniquely discoverable and each has its current strict OpenAPI schema',async()=>{
  const manifest=JSON.parse(await readFile(join(repo,'src/lib/centropy/capability-manifest.generated.json'),'utf8'));
  const entries=manifest.capabilities??manifest.httpCapabilities??manifest.entries;
  assert(Array.isArray(entries),'Actual manifest capabilities must be present');
  assert.equal(new Set(entries.map((entry:any)=>entry.capabilityId)).size,entries.length);
  const openapi=JSON.parse(await readFile(join(repo,'finnor-os/openapi.json'),'utf8'));
  const operations=[...M1_OPERATIONS,...EVIDENCE_OPERATIONS,...Object.keys(CapitalProgramV2Operations)];
  for(const operation of operations){
   assert(entries.some((entry:any)=>entry.routePattern===`company-brain/${operation}`),`Missing discovery ${operation}`);
   const route=openapi.paths[`/api/company-brain/${operation}`];assert(route?.post?.requestBody,`Missing exact OpenAPI ${operation}`);
   assert(route.post.security?.length);assert(route.post.requestBody.content['application/json'].schema);
  }
  return {operations,capabilityCount:entries.length,openapiPaths:Object.keys(openapi.paths).length};
 });
 if(process.argv.includes('--verify-generators')){
 await challenge('repeat-generated-byte-identity','Two actual regeneration passes are byte-identical and retain all release artifacts',async()=>{
  const paths=['finnor-os/packages/db/migrations-bundle.ts','finnor-os/openapi.json','src/lib/centropy/capability-manifest.generated.json','docs/release/generated/action-manifest.json'];
  const before=await Promise.all(paths.map(async path=>({path,sha256:sha(await readFile(join(repo,path)))})));
  for(let i=0;i<2;i++){
   for(const [cwd,args]of [[join(repo,'finnor-os'),['--import=tsx','scripts/bundle-migrations.ts']],
    [join(repo,'finnor-os'),['--import=tsx','scripts/generate-openapi.ts']],[repo,['scripts/centropy/generate-capability-manifest.mjs']]] as const){
    const run=spawnSync(process.execPath,args,{cwd,env:process.env,encoding:'utf8',timeout:60000});assert.equal(run.status,0,run.stderr);
    steps.push({action:'Actual generator',cwd,args,exitCode:run.status,stdout:run.stdout});
   }
   assert.deepEqual(await Promise.all(paths.map(async path=>({path,sha256:sha(await readFile(join(repo,path)))}))),before);
  }
  return before;
 });
 await challenge('duplicate-migration-generator-refusal','An actual duplicate 0165 join refuses before writing the release bundle; historical suffixed IDs remain unchanged',async()=>{
  const target=join(repo,'finnor-os/packages/db/migrations/0165_m3_rehearsal_duplicate.sql'),
   bundle=join(repo,'finnor-os/packages/db/migrations-bundle.ts'),before=sha(await readFile(bundle));
  await writeFile(target,'-- Deliberate local duplicate-ID rehearsal, never application SQL.\n',{flag:'wx'});
  try{
   const run=spawnSync(process.execPath,['--import=tsx','scripts/bundle-migrations.ts'],{cwd:join(repo,'finnor-os'),env:process.env,encoding:'utf8',timeout:60000});
   assert.notEqual(run.status,0,'Duplicate migration ID must refuse before generation');
   assert.match(run.stderr,/Duplicate migration ID.*0165/i);assert.equal(sha(await readFile(bundle)),before);
   return {exitCode:run.status,stderr:run.stderr,bundleSha256:before};
  }finally{await rm(target);}
 });
 }
}catch(error){cases.push({id:'rehearsal-setup',status:'FAIL',observed:{message:String(error),stack:(error as Error).stack}});}
finally{await save();await closePool();for(const c of admins)await c.end().catch(()=>undefined);await postgres.stop().catch(()=>undefined);await rm(temporary,{recursive:true,force:true});}
process.exit(cases.length&&cases.every(row=>row.status==='PASS')?0:1);
