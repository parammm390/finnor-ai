/** Executes the preregistered actual owner/API/SQL/physical-child campaign.
 * Expected mathematical values come from the independent Fraction reference.
 * Administrative setup configures only this disposable database and faults.
 */
import assert from 'node:assert/strict';
import { appendFile,mkdir,mkdtemp,readFile,readdir,writeFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn,spawnSync,type ChildProcess } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { closePool,configureTenantVertical,receiveWork,withTenantTransaction } from '@finnor/db';
import { createMetricSeries,attachCanonicalEvidenceToWorld,loadEnterpriseBeliefView } from '@finnor/private-equity';
import { createEvidenceSource } from '@finnor/memory';
import { migrate } from '../../packages/db/migrate';
import { CURRENT_MIGRATION_HEAD } from '../../packages/db/migration-head';
import { MIGRATIONS } from '../../packages/db/migrations-bundle';
import type { PeMutationContext } from '../../packages/private-equity/src/types';
import type { R7Family,R7Parameters,R7Query } from '../../packages/private-equity/src/r7/contracts';
import type { AffineFamilySource } from '../../packages/shared-types/src/decision-atlas';
import type { AllocationResource } from '../../packages/shared-types/src/allocation';
import type { DomainAction } from '../../packages/shared-types/src';
import { ensureBusinessEffect } from '../../packages/orchestration/src/compiler';
import { defaultPolicy } from '../../packages/orchestration/src';
import { fixtureSource,fixtureRef,fixtureInformation } from './fixtures.mts';
import { localHost,type LocalActor } from './local-host.mts';
import { mountedAtlas } from './mounted.mts';
import { matchedReuse } from './cost.mts';

const repo=resolve(import.meta.dirname,'../../..'),os=join(repo,'finnor-os');
const output=resolve(process.env.FINNOR_R7_EVIDENCE_DIR??join(repo,'scope-r/r7-policy-atlas-compiler/evidence/owner-initial'));
assert(process.env.FINNOR_R7_EVIDENCE_DIR&&!output.startsWith(repo+'/'),'Raw owner evidence must be explicitly outside the source cut');
const selected=process.env.FINNOR_R7_CASE_FILTER?.split(','),begun=new Date().toISOString(),cases:unknown[]=[],calls:unknown[]=[],traffic:unknown[]=[];
const compatibility=!selected||selected.includes('runtime-schema-compatibility');
const serialSchemaPath=process.env.FINNOR_R7_SERIAL_SCHEMA;
assert(!serialSchemaPath||!compatibility,'An unnumbered serial DDL projection is NOT release migration compatibility');
const r7Migrations=MIGRATIONS.filter(m=>/^\d+_r7_policy_atlas\.sql$/.test(m.name));
if(compatibility)assert.equal(r7Migrations.length,1,'Serial integrator must supply exactly one uniquely numbered R7 migration');
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const files:string[]=[];
async function scan(dir:string){for(const e of await readdir(join(repo,dir),{withFileTypes:true})){
  const path=dir+'/'+e.name;if(e.isDirectory())await scan(path);else if(/\.(ts|mts|mjs|py|sql)$/.test(e.name))files.push(path);
}}
await scan('finnor-os/packages/private-equity/src/r7');await scan('finnor-os/packages/epistemic-runtime/src/policy-atlas');await scan('finnor-os/scripts/r7');
files.push('finnor-os/packages/shared-types/src/decision-atlas.ts',
  'finnor-os/packages/db/migrations-bundle.ts','finnor-os/packages/private-equity/src/allocation-store.ts','finnor-os/packages/epistemic-runtime/src/allocation-contracts.ts',
  'finnor-os/packages/epistemic-runtime/src/allocation-checker.ts','finnor-os/packages/db/compute-contract.ts',
  'finnor-os/apps/api/app/api/allocations/[operation]/route.ts','finnor-os/apps/api/app/api/decision-atlases/[operation]/route.ts',
  'package-lock.json','finnor-os/package-lock.json');
if(serialSchemaPath)files.push(serialSchemaPath);
else files.push(...(await readdir(join(os,'packages/db/migrations'))).filter(p=>/^\d+_r7_policy_atlas\.sql$/.test(p)).map(p=>'finnor-os/packages/db/migrations/'+p));
if(process.argv.includes('--browser'))files.push('src/components/centropy/canvas/DecisionAtlasReview.tsx');
const sourceIdentity=await Promise.all(files.sort().map(async path=>({path,sha256:sha(await readFile(resolve(repo,path)))})));
const artifact=async(name:string,value:unknown)=>{const path=join(output,name);await mkdir(dirname(path),{recursive:true});
  await writeFile(path,JSON.stringify(value,null,2)+'\n');return path;};
async function save(){await artifact('results.json',{schema:'finnor.r7.owner-e2e.v1',begun,finishedAt:new Date().toISOString(),cases,calls,traffic,sourceIdentity,
  runtime:{node:process.version,platform:process.platform,architecture:process.arch},
  profile:serialSchemaPath?'R7_SERIAL_PROPOSALS_CHECKED_NOT_RELEASE_MIGRATION':'DISPOSABLE_NATIVE_REAL_BEARER_HTTP_ORDINARY_ROLE_SQL_QUEUE_BUILDER_CHECKER_S4_S5',
  qualification:'Conditional supplied affine hypotheses. Not hosted Supabase, protected method/fallback admission, effects, or H2 wealth evidence.',
  costs:{money:null,humanSeconds:null,aggregatePeakMemoryBytes:null},selected:selected??'ALL_REGISTERED',
  rerun:'cd finnor-os && FINNOR_R7_EVIDENCE_DIR=<new-evidence-directory> node --import=tsx scripts/r7/run-owner.mts'});}
async function challenge(id:string,invariant:string,fn:()=>Promise<unknown>){
  if(selected&&!selected.includes(id))return;
  const begin=performance.now();let status='PASS',observed:unknown;
  try{observed=await fn();}catch(error){status='FAIL';observed={predicate:String(error),stack:(error as Error).stack};}
  cases.push({id,invariant,status,wallMs:performance.now()-begin,observed});console.log(JSON.stringify({id,status}));await save();
}
const directory=await mkdtemp(join(tmpdir(),'finnor-r7-owner-')),port=await new Promise<number>((yes,no)=>{
  const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();assert(a&&typeof a!=='string');s.close(()=>yes(a.port));});
});
const postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined,host:Awaited<ReturnType<typeof localHost>>|undefined;
const children=new Set<ChildProcess>(),actors:LocalActor[]=[];
export type OwnerFixture={tenant:string;principal:string;ctx:PeMutationContext;root:{entityType:'external_organization';entityId:string};workId:string;evidenceVersionId:string;
  source:AffineFamilySource;family?:R7Family;parameters?:R7Parameters;resource?:AllocationResource};
type F=OwnerFixture;
async function call(f:F,op:string,body:unknown,family='decision-atlases',token?:string){
  const actor=actors.find(a=>a.id===f.principal)!;const started=performance.now();
  const response=await fetch(host!.apiUrl+'/api/'+family+'/'+op,{method:'POST',headers:{'content-type':'application/json',
    authorization:'Bearer '+(token??host!.issue(actor))},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const result={status:response.status,body:await response.json() as any};
  calls.push({op,family,tenant:f.tenant,principal:f.principal,status:response.status,wallMs:performance.now()-started,cacheControl:response.headers.get('cache-control')});
  return result;
}
const ok=(r:{status:number;body:any},status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
async function fixture(name:string,kind='diagnostic',n=1,count=3,w=2,h=1,prepare?:(source:AffineFamilySource)=>void):Promise<F>{
  const tenant=randomUUID(),principal=randomUUID(),root={entityType:'external_organization' as const,entityId:randomUUID()},email=principal+'@r7.test.invalid';
  const ctx:PeMutationContext={auth:{tenantId:tenant,userId:principal,employeeId:principal,role:'owner'},provenance:{createdBy:principal,sourceSystem:'R7:disposable-setup'}};
  await admin!.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,$3)",[tenant,randomUUID(),name]);
  await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[principal,tenant,email]);
  await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",[root.entityId,tenant,name]);
  actors.push({id:principal,email});
  await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'R7:disposable'});
  const workId=(await receiveWork({tenantId:tenant,userId:principal,instruction:'Review the immutable original exact affine finite family',
    channel:'console',idempotencyKey:randomUUID(),activeContext:{entityRefs:[root]}})).workId;
  const source=fixtureSource(kind,n,count,w,h,{tenantId:tenant,principalId:principal});
  if(kind!=='maximal'){
    // Exact nonterminating demand, independent original binding is recomputed.
    const a=source.policies.find(p=>p.id==='A')!;
    a.actions[0]!.resources.cash={a:Array(n).fill('0/1'),b:'1/3'};
    const {ref:_,...body}=a;a.ref=fixtureRef('S4','exact-affine-policy:'+sha(canonical(body)),body,'s4-exact-affine-v1');
  }
  prepare?.(source);
  const sourceId=(await createEvidenceSource(tenant,{sourceKey:'r7:'+name,sourceType:'pe_document_claim',title:'Supplied synthetic exact affine owner hypothesis'})).id;
  const evidenceVersionId=randomUUID(),snapshot={worldRoot:root,decisionAtlasSource:source,claims:[{propositionId:'r7-supplied-law',predicate:'hypothesis',value:'Synthetic finite complete affine original paths'}]};
  await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,$7,clock_timestamp(),clock_timestamp())",
    [evidenceVersionId,sourceId,tenant,sha(JSON.stringify(snapshot)),'Supplied hypothesis, business adequacy unqualified',JSON.stringify(snapshot),source.mandate.knowledgeAt]);
  const metric=await createMetricSeries(ctx,{subjectType:root.entityType,subjectId:root.entityId,metricKey:'r7-law',name:'Original affine law',unit:'USD',frequency:'daily'});
  await attachCanonicalEvidenceToWorld(ctx,{worldRoot:root,entity:{entityType:'pe_metric_series',entityId:String(metric.row.id)},
    evidenceSourceId:sourceId,evidenceVersionId,relationship:'supports'});
  const f:F={tenant,principal,ctx,root,workId,evidenceVersionId,source};await artifact(name+'/original.json',{...f,ctx:undefined});return f;
}
function canonical(v:unknown):string{return v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':
  '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';}
async function bind(f:F){
  const r=ok(await call(f,'register',{workId:f.workId,root:f.root,evidenceVersionId:f.evidenceVersionId,expectedFamilyRef:f.family?.ref??null}));
  f.family=r.family;f.parameters=r.parameters;return r;
}
async function reviseSource(f:F,change?:(source:AffineFamilySource)=>void){
  const row=(await admin!.query('SELECT source_id::text,version_number,snapshot FROM finnor_os.evidence_source_versions WHERE id=$1 AND tenant_id=$2',
    [f.evidenceVersionId,f.tenant])).rows[0],version=randomUUID();
  f.source=structuredClone(f.source);f.source.modelKey+='-revised';
  if(change)change(f.source);
  else for(const w of f.source.worlds)for(const path of w.paths)if(path.policyId==='B')for(let t=1;t<path.states.length;t++)path.states[t]!.net!.b='3/8';
  const snapshot={...row.snapshot,decisionAtlasSource:f.source};
  await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,$4,$5,$6,$7::jsonb,$8,clock_timestamp(),clock_timestamp())",
    [version,row.source_id,f.tenant,row.version_number+1,sha(JSON.stringify(snapshot)),'Revised supplied affine hypothesis, unadmitted',JSON.stringify(snapshot),f.source.mandate.knowledgeAt]);
  const entity=(await admin!.query("SELECT id::text FROM finnor_os.pe_metric_series WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 LIMIT 1",
    [f.tenant,f.root.entityType,f.root.entityId])).rows[0];
  await attachCanonicalEvidenceToWorld(f.ctx,{worldRoot:f.root,entity:{entityType:'pe_metric_series',entityId:entity.id},
    evidenceSourceId:row.source_id,evidenceVersionId:version,relationship:'supports'});
  f.evidenceVersionId=version;await resource(f);await bind(f);
  return {evidenceVersionId:version,familyRef:f.family!.ref,originalEpisodeId:f.family!.episodeId};
}
async function resource(f:F,amount='1'){
  const m=f.source.mandate,pin=(await loadEnterpriseBeliefView(f.ctx,{root:f.root})).pin;
  const body={schema:'finnor.allocation-resource.v1',resourceId:'cash',tenantId:f.tenant,ownerRef:m.businessOwnerRef,
    legalEntityRef:fixtureRef('S1',f.root.entityId),scopeRef:fixtureRef('BUSINESS_OWNER','r7-cash'),permittedRoots:[f.root],
    rightsRef:m.rightsRef,unit:'USD',currency:'USD',kind:'STOCK',resourceClass:'CASH',horizon:m.horizon,
    sourceRef:fixtureRef('BUSINESS_OWNER','cash-source'),asOf:m.knowledgeAt,knowledgeAt:m.knowledgeAt,validUntil:m.validUntil,beliefPins:[pin],
    availability:Array(m.horizon.periods+1).fill(null).map(()=>({amount,basis:'REPORTED_AVAILABLE'})),
    existingUse:Array(m.horizon.periods+1).fill('0'),safetyMargin:'0',covenants:[],revoked:false,qualification:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED'};
  const result=ok(await call(f,'resource',{resource:body,expectedRef:f.resource?.ref??null},'allocations'));f.resource=result;return result;
}
function buildBody(f:F,budget?:unknown){const family=f.family!;return {envelope_inputs:{familyRef:family.ref},problem_ref:family.input.familyRef,
  existing_work_revision:family.input.work.inputId,domain_profile_ref:family.input.domainRef,budget_grant_ref:family.grantRef,
  cancellation_ref:family.cancellationRef,idempotencyKey:randomUUID(),...(budget?{budget}:{})};}
function startWorker(productionRegistry=false){
  const workerUrl=new URL(process.env.DATABASE_URL!);workerUrl.username='finnor_worker';workerUrl.password='disposable_worker';
  const child=spawn(process.execPath,['--import=tsx',join(os,'scripts/r7/worker-once.mts')],{cwd:os,
    env:{...process.env,DATABASE_URL:workerUrl.href,FINNOR_R7_WORKER_REGISTRY:productionRegistry?'PRODUCTION_ALL':'R7_ONLY'},stdio:['ignore','pipe','pipe']});
  children.add(child);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise<{code:number|null;signal:string|null}>( (yes,no)=>{child.once('error',no);child.once('close',async(code,signal)=>{
    children.delete(child);const exit={code,signal};await artifact('workers/'+child.pid+'.json',{pid:child.pid,exit,stdout,stderr});yes(exit);
  });});
  return {child,done};
}
async function worker(productionRegistry=false){
  const {done}=startWorker(productionRegistry),exit=await done;assert.equal(exit.code,0);return exit;
}
async function waitFor<T>(predicate:()=>Promise<T|false>,limit=30000):Promise<T>{
  const deadline=Date.now()+limit;
  while(Date.now()<deadline){const result=await predicate();if(result)return result;await new Promise(yes=>setTimeout(yes,50));}
  throw Error('REGISTERED_OBSERVATION_BOUNDARY_TIMEOUT');
}
async function pausePublication(tenant:string,table:'r7_atlases'|'r7_events',kind='CHECK_ACCEPTED'){
  await admin!.query(`CREATE FUNCTION finnor_os.r7_fixture_hold() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.tenant_id='${tenant}'::uuid ${table==='r7_events'?`AND NEW.kind='${kind}'`:''} THEN PERFORM pg_advisory_xact_lock(707777); END IF; RETURN NEW; END $$`);
  await admin!.query(`CREATE TRIGGER r7_fixture_hold BEFORE INSERT ON finnor_os.${table} FOR EACH ROW EXECUTE FUNCTION finnor_os.r7_fixture_hold()`);
  await admin!.query('SELECT pg_advisory_lock(707777)');
}
async function removePause(table:'r7_atlases'|'r7_events'){
  await admin!.query('SELECT pg_advisory_unlock(707777)');
  await admin!.query(`DROP TRIGGER r7_fixture_hold ON finnor_os.${table}`);await admin!.query('DROP FUNCTION finnor_os.r7_fixture_hold()');
}
async function rows(f:F,id:string){
  return {build:(await admin!.query('SELECT * FROM finnor_os.r7_builds WHERE tenant_id=$1 AND id=$2',[f.tenant,id])).rows,
    events:(await admin!.query('SELECT * FROM finnor_os.r7_events WHERE tenant_id=$1 AND build_id=$2 ORDER BY created_at,id',[f.tenant,id])).rows,
    jobs:(await admin!.query("SELECT id,type,status,attempts,claim_token,claim_fence,lease_expires_at,protocol_version,payload FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'buildId'=$2",[f.tenant,id])).rows,
    episodes:(await admin!.query('SELECT * FROM finnor_os.r7_episodes WHERE tenant_id=$1',[f.tenant])).rows};
}
async function build(f:F,budget?:unknown){
  const request=buildBody(f,budget),accepted=ok(await call(f,'build',request),202);
  await worker();const read=ok(await call(f,'read',{buildId:accepted.buildId}));
  await artifact('builds/'+accepted.buildId+'.json',{request,accepted,read,rows:await rows(f,accepted.buildId)});
  assert(read.atlas,JSON.stringify(read));return {request,accepted,read};
}
async function parameters(f:F,values:string[]){
  const p=ok(await call(f,'parameters',{familyRef:f.family!.ref,expectedRef:f.parameters!.ref,values}));f.parameters=p;return p;
}
async function query(f:F,id:string,fallback='REQUIRE_ADMITTED'):Promise<R7Query>{
  const q=ok(await call(f,'query',{buildId:id,parameterRef:f.parameters!.ref,idempotencyKey:randomUUID(),fallback}));
  await artifact('queries/'+q.ref.contentDigest+'.json',q);return q;
}
function reference(f:F,values:string[]){
  const r=spawnSync(process.env.FINNOR_R7_PYTHON??'/usr/bin/python3',[join(os,'scripts/r7/reference.py')],{
    input:JSON.stringify({source:f.source,points:[values]}),encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
let f:F|undefined,trial:Awaited<ReturnType<typeof build>>|undefined,selection:any,retainedJobId:string|undefined,futureJobId:string|undefined;
try{
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';process.env.NODE_ENV='test';process.env.FINNOR_R7_PROFILE='DISPOSABLE_NATIVE';
  await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();
  await postgres.createDatabase('r7_owner');const url=`postgres://finnor:finnor@127.0.0.1:${port}/r7_owner`;
  const priorMigrations=await migrate(url,compatibility?MIGRATIONS.filter(m=>!r7Migrations.includes(m)):undefined);
  admin=new pg.Client({connectionString:url});await admin.connect();
  if(compatibility){
    const commit=process.env.FINNOR_COMMIT_SHA??spawnSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).stdout?.trim();
    assert(commit&&/^[a-f0-9]{40}$/.test(commit),'Actual parent Git commit or explicitly supplied installed-image commit pin');
    process.env.FINNOR_COMMIT_SHA=commit;process.env.FINNOR_BUILD_ID='finnor-'+commit.slice(0,12);
    process.env.FINNOR_VERSION='0.1.0+'+commit.slice(0,12);
    process.env.FINNOR_ENVIRONMENT='r7-disposable';process.env.FINNOR_RELEASE_SOURCE='WORKING_TREE_COMPATIBILITY_NOT_RELEASE';
    retainedJobId=randomUUID();futureJobId=randomUUID();
    for(const [id,protocol]of [[retainedJobId,1],[futureJobId,2]] as const)
      await admin.query("INSERT INTO finnor_os.jobs(id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety) VALUES($1::uuid,'release_probe',$2::jsonb,$1::text,'interactive',100,$3,'pure')",
        [id,JSON.stringify({commitSha:process.env.FINNOR_COMMIT_SHA}),protocol]);
  }
  const upgradeMigrations=compatibility?await migrate(url,MIGRATIONS):[],migrations=[...priorMigrations,...upgradeMigrations];
  if(serialSchemaPath)await admin.query(await readFile(resolve(serialSchemaPath),'utf8'));
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'disposable_worker'");await admin.query("SET app.test_vertical_mode='explicit'");
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/r7_owner`;await closePool();
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:r7',2,2,0,15,true,'R7 explicitly configured disposable ordinary capacity, unmetered') ON CONFLICT DO NOTHING");
  host=await localHost(repo,actors,traffic,process.argv.includes('--browser'));
  await artifact('runtime.json',{head:CURRENT_MIGRATION_HEAD,migrations,roles:(await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor','finnor_app')")).rows,
    serialSchema:serialSchemaPath?{path:serialSchemaPath,sha256:sha(await readFile(serialSchemaPath)),qualification:'UNNUMBERED_DISPOSABLE_PROPOSAL_NOT_RELEASE_MIGRATION'}:null,
    bundleEqualDisk:await Promise.all(MIGRATIONS.map(async m=>({name:m.name,equal:m.sql===await readFile(join(os,'packages/db/migrations',m.name),'utf8')}))),
    node:process.version,python:spawnSync(process.env.FINNOR_R7_PYTHON??'/usr/bin/python3',['--version'],{encoding:'utf8'}).stdout});
  f=await fixture('r7-positive');await resource(f);await bind(f);
  await challenge('runtime-schema-compatibility','Actual pre-R7 schema/job retained through the forward migration and cold production handler registry; restart skips all migrations, future protocol is not claimed, installed R7 still builds and queries',async()=>{
    assert(retainedJobId&&futureJobId);assert.deepEqual(upgradeMigrations,r7Migrations.map(m=>m.name));
    const before=(await admin!.query('SELECT id,type,status,protocol_version,payload FROM finnor_os.jobs WHERE id=ANY($1::uuid[]) ORDER BY protocol_version',
      [[retainedJobId,futureJobId]])).rows;
    assert.deepEqual(before.map(r=>r.status),['queued','queued']);
    const physicalWorker=await worker(true),after=(await admin!.query('SELECT id,type,status,attempts,protocol_version,payload FROM finnor_os.jobs WHERE id=ANY($1::uuid[]) ORDER BY protocol_version',
      [[retainedJobId,futureJobId]])).rows;
    assert.equal(after[0].status,'completed');assert.equal(after[0].protocol_version,1);
    assert.equal(after[1].status,'queued');assert.equal(after[1].attempts,0);
    assert.deepEqual(await migrate(url,MIGRATIONS),[]);
    const b=await build(f!),q=await query(f!,b.accepted.buildId);
    assert.equal(q.choice!.policyId,'A');assert.equal(q.costs.fullFamilyEvaluations,0);
    const retained=ok(await call(f!,'read',{buildId:b.accepted.buildId}));
    assert.equal(retained.atlas.ref.contentDigest,b.read.atlas.ref.contentDigest);
    const roles=(await admin!.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname")).rows;
    assert(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
    return {priorMigrations,upgradeMigrations,restartMigrations:[],before,after,physicalWorker,roles,build:b.accepted,query:q,retained,
      releaseProbeBasis:'Current Git parent plus separately recorded working-tree source digests, not a release or deployment claim'};
  });
  await challenge('owner-full-profile','Actual immutable S1/S3/S4 4-parameter,32-policy,64-world,12-period family crosses HTTP, durable queue and separate checker; both bounded S4 batches and exact original projection retain all members',async()=>{
    const p=await fixture('r7-owner-maximal','maximal',4,32,64,12);await resource(p);const registered=await bind(p);
    const {readEnterpriseAffinePolicyFamily}=await import('../../packages/private-equity/src/r7/owners'),
      coherent=await readEnterpriseAffinePolicyFamily(p.ctx,p.family!.ref),b=await build(p),q=await query(p,b.accepted.buildId);
    assert.equal(coherent.batchLimit,16);assert.equal(coherent.policies.length,32);
    assert.equal(q.choice!.policyId,'p31');assert.equal(q.choice!.robustValue,'34/1');assert.equal(q.choice!.worstWorldIds.length,64);
    assert.equal(q.costs.fullFamilyEvaluations,0);assert.equal(b.read.atlas.proposal.coverage,'COMPLETE');
    return {registered:registered.family.ref,coherent:{members:coherent.policies.length,batchLimit:coherent.batchLimit,revisionVector:coherent.coherentRevisionVector},
      build:b.accepted,query:q,physical:b.read.atlas.physical,check:b.read.atlas.check};
  });
  await challenge('original-policy-information','Actual authenticated S1 source registration rejects hidden-world/reordered duplicate policy states and conflicting event tokens; legitimate two-inquiry branches preserve both original fixed worlds through separate whole-cell checking',async()=>{
    const observations=[];
    for(const kind of ['unobserved','reordered','conflicting'] as const){
      const p=await fixture('r7-information-'+kind,'diagnostic',1,3,2,3,source=>fixtureInformation(source,kind));
      await resource(p);
      const rejected=await call(p,'register',{workId:p.workId,root:p.root,evidenceVersionId:p.evidenceVersionId,expectedFamilyRef:null});
      assert.equal(rejected.status,422);assert.equal(rejected.body.code,'R7_UNSUPPORTED');
      assert.equal(rejected.body.requirement,kind==='conflicting'?'OBSERVATION_EVENT_IDENTITY':'NONANTICIPATIVE_POLICY');
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.r7_families WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
      observations.push({kind,rejected});
    }
    const positive=await fixture('r7-information-positive','diagnostic',1,3,2,3,source=>fixtureInformation(source,'positive'));
    await resource(positive);await bind(positive);const b=await build(positive),q=await query(positive,b.accepted.buildId);
    assert.equal(b.read.atlas.check.status,'ACCEPTED');assert.equal(q.choice!.action.kind,'INQUIRE');
    assert.deepEqual(q.choice!.worstWorldIds,['w0','w1']);assert.equal(q.costs.fullFamilyEvaluations,0);
    return {observations,positive:{build:b.accepted,query:q,check:b.read.atlas.check},actualS2ContinuationQualified:false};
  });
  await challenge('authenticated-owner-runtime','Actual bearer HTTP → immutable S1/S3/S4 family → durable claim → distinct builder/checker → accepted persisted atlas; exact lookup bypasses full optimizer',async()=>{
    trial=await build(f!);const q=await query(f!,trial.accepted.buildId),oracle=reference(f!,['1/2']);
    assert.equal(q.disposition,'COVERED');assert.equal(q.choice!.policyId,'A');assert.equal(q.choice!.robustValue,'1/2');
    assert.deepEqual(q.choice!.worstWorldIds,['w0','w1']);assert.equal(q.costs.fullFamilyEvaluations,0);
    assert.equal(q.choice!.exactDemand[0]!.quantities[0],'1/3');
    const physical=trial.read.atlas.physical;assert.equal(physical.length,2);assert(physical.every((r:any)=>r.pid!==r.parentPid&&r.exitCode===0));
    assert.notEqual(physical[0].pid,physical[1].pid);assert.equal(trial.read.atlas.check.status,'ACCEPTED');
    assert.equal((await rows(f!,trial.accepted.buildId)).jobs[0].status,'completed');
    return {build:trial.accepted,query:q,oracle,physical,fullFamilyOptimizerInvoked:false};
  });
  await challenge('typed-boundary-reuse','Typed owner revisions cross ranking/worst-world/feasibility boundaries; current exact ties and values match independent direct reference without optimizer rerun',async()=>{
    assert(trial);const observations=[];
    for(const x of ['1/4','1/2','2/3','666666666666666667/1000000000000000000','3/4']){
      await parameters(f!,[x]);const q=await query(f!,trial.accepted.buildId),oracle=reference(f!,[x]);
      const expected=x==='1/4'?['A','B']:x==='1/2'||x==='2/3'?['A']:['B'];
      assert.deepEqual([...q.choice!.tiedPolicyIds].sort(),expected);assert.equal(q.costs.fullFamilyEvaluations,0);
      assert.equal(q.choice!.policyId,oracle.queries[0].winner);assert.equal(q.choice!.robustValue,oracle.queries[0].value);
      observations.push({x,q,oracle});
    }
    return observations;
  });
  await challenge('actual-s4-s5-intent','Actual original root action and arbitrary-rational demand produce current canonical S5 reservation/intent once; no business effect is created',async()=>{
    assert(trial);await parameters(f!,['1/2']);const q=await query(f!,trial.accepted.buildId),key=randomUUID();
    const selected=ok(await call(f!,'select',{buildId:trial.accepted.buildId,queryRef:q.ref,idempotencyKey:key}));
    selection={...selected,queryRef:q.ref};
    assert.equal(selected.choice.action.id,'A-action');assert.equal(selected.consumption.status,'INTENDED_PENDING_S6');
    assert.equal(selected.reservation.envelopes[0].quantities[0],'1/3');assert.equal(selected.executionAuthorityGranted,false);
    const replay=ok(await call(f!,'select',{buildId:trial.accepted.buildId,queryRef:q.ref,idempotencyKey:key}));
    assert.equal(replay.consumption.ref.contentDigest,selected.consumption.ref.contentDigest);
    const snapshot=ok(await call(f!,'resources',{},'allocations'));assert(snapshot.outstanding.some((o:any)=>o.reservationRef.id===selected.reservation.ref.id));
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[f!.tenant])).rows[0].n,0);
    const durable=ok(await call(f!,'read',{allocationRef:selected.consumption.certificateRef},'allocations'));
    assert.equal(durable.consumptions[0].ref.contentDigest,selected.consumption.ref.contentDigest);
    assert.equal(ok(await call(f!,'validate',{allocationRef:selected.consumption.certificateRef},'allocations')).status,'CURRENT');
    return {query:q,selected,replay,snapshot,durable};
  });
  await challenge('current-s5-and-fallback','New shared commitments invalidate the cached winner, execute actual full-family fallback and independent point checker under the original episode; UNKNOWN remains occupied',async()=>{
    assert(trial);const q=await query(f!,trial.accepted.buildId,'DEVELOPMENT_EXACT');
    assert.equal(q.disposition,'FULL_FAMILY_CHECKED');assert.equal(q.choice!.policyId,'B');assert(q.fallback?.physical.length===2);
    assert.equal(q.choice!.ownerChecks.fullFamilyOptimizerInvoked,true);
    assert.equal(q.fallback!.admitted,false);assert.equal(q.costs.fullFamilyEvaluations,3);
    assert(selection);
    const unknown=ok(await call(f!,'reconcile',{allocationRef:selection.consumption.certificateRef},'allocations'));
    assert.equal(unknown.status,'UNKNOWN_OUTCOME_RETAINED');
    const replay=ok(await call(f!,'select',{buildId:trial.accepted.buildId,queryRef:selection.queryRef,
      idempotencyKey:selection.consumption.idempotencyKey}));
    assert.equal(replay.reservation.status,'UNKNOWN_OUTCOME');assert.equal(replay.consumption.status,'UNKNOWN_OUTCOME');
    const release=await call(f!,'release',{allocationRef:selection.consumption.certificateRef,idempotencyKey:randomUUID()},'allocations');
    assert.equal(release.status,422);
    const again=await query(f!,trial.accepted.buildId,'DEVELOPMENT_EXACT');assert.equal(again.choice!.policyId,'B');
    const admitted=await query(f!,trial.accepted.buildId);
    assert.equal(admitted.disposition,'UNRESOLVED');assert(admitted.reasons.includes('S8_COMPATIBLE_FULL_FAMILY_METHOD_DOMAIN_GRANT_ADMISSION_PORT_UNAVAILABLE'));
    return {q,unknown,replay,release,again,admitted,rows:await rows(f!,trial.accepted.buildId)};
  });
  await challenge('partial-and-outside-fallback','Explicit partial gaps and exact outside-domain point execute real development full-family children, not interpolation; no whole-domain completion claimed',async()=>{
    const p=await fixture('r7-partial');await resource(p);await bind(p);
    const b=await build(p,{maxNodes:1,maxDepth:256,maxFacets:256,maxBases:200000,maxTotalBases:2000000,maxBytes:33554432,deadlineMs:30000});
    assert.equal(b.read.status,'INCOMPLETE');const gap=await query(p,b.accepted.buildId,'DEVELOPMENT_EXACT');assert.equal(gap.disposition,'FULL_FAMILY_CHECKED');
    assert.equal(gap.atlasCoverage,'PARTIAL');await parameters(p,['5/4']);const outside=await query(p,b.accepted.buildId,'DEVELOPMENT_EXACT');
    assert.equal(outside.choice!.policyId,'B');assert(outside.reasons.includes('ATLAS_OUTSIDE_DOMAIN'));
    return {b:b.accepted,gap,outside};
  });
  await challenge('strict-auth-private-storage','Actual signed bearer verification, current SQL authority, strict reference decoder, principal RLS and immutable storage distinguish intended boundaries',async()=>{
    assert(trial);const bad=await call(f!,'read',{buildId:trial.accepted.buildId},'decision-atlases','invalid-token');assert.equal(bad.status,401);
    const foreign=await fixture('r7-foreign');const missing=await call(foreign,'read',{buildId:randomUUID()}),privateRead=await call(foreign,'read',{buildId:trial.accepted.buildId});
    assert.deepEqual(privateRead,missing);
    const decoder=await call(f!,'query',{buildId:trial.accepted.buildId,parameterRef:f!.parameters!.ref,idempotencyKey:randomUUID(),coefficients:[1]});
    assert.equal(decoder.status,400);
    await assert.rejects(()=>withTenantTransaction(f!.tenant,{userId:f!.principal},(_db,c)=>c.query("UPDATE finnor_os.r7_atlases SET body='{}'::jsonb")),/permission denied|immutable/i);
    return {bad,missing,privateRead,decoder};
  });
  await challenge('queued-cancel-original-grant','Cancellation fences real queue worker and retains immutable original episode/deadline with no child invocation or grant renewal',async()=>{
    const p=await fixture('r7-cancel');await resource(p);await bind(p);
    const b=ok(await call(p,'build',buildBody(p)),202),before=await rows(p,b.buildId);
    assert.equal(ok(await call(p,'cancel',{buildId:b.buildId})).status,'CANCELLED');await worker();
    const read=ok(await call(p,'read',{buildId:b.buildId})),after=await rows(p,b.buildId);assert.equal(read.status,'CANCELLED');
    assert.equal(after.episodes[0].invocations,before.episodes[0].invocations);assert.equal(+after.episodes[0].deadline_at,+before.episodes[0].deadline_at);
    assert.equal(after.events.filter(e=>e.kind==='CHILD_STARTED').length,0);return {b,read,before,after};
  });
  await challenge('terminal-build-current-context','Actual completed-build cancellation removes current recommendation while retaining immutable original query/atlas history, physical counts, grant and deadline',async()=>{
    const p=await fixture('r7-terminal-context');await resource(p);await bind(p);
    const b=await build(p),q=await query(p,b.accepted.buildId),before=await rows(p,b.accepted.buildId),
      initial=ok(await call(p,'context',{workId:p.workId,root:p.root}));
    assert.equal(initial.lastQuery.ref.contentDigest,q.ref.contentDigest);
    const cancelled=ok(await call(p,'cancel',{buildId:b.accepted.buildId})),
      current=ok(await call(p,'context',{workId:p.workId,root:p.root})),
      selection=await call(p,'select',{buildId:b.accepted.buildId,queryRef:q.ref,idempotencyKey:randomUUID()}),
      after=await rows(p,b.accepted.buildId),
      historical=(await admin!.query('SELECT body FROM finnor_os.r7_queries WHERE tenant_id=$1 AND content_digest=$2',
        [p.tenant,q.ref.contentDigest])).rows[0]?.body;
    const observed={initial,cancelled,current,selection,historical,before,after};
    await artifact('terminal-context/observed.json',observed);
    assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.atlas,null);
    assert.equal(current.lastQuery,null,'Canceled historical recommendation must not be returned as current');
    assert.equal(selection.status,409);assert.equal(historical.ref.contentDigest,q.ref.contentDigest);
    assert.equal(after.episodes[0].invocations,before.episodes[0].invocations);
    assert.equal(+after.episodes[0].deadline_at,+before.episodes[0].deadline_at);
    assert.equal(after.events.filter(e=>e.kind==='CHILD_STARTED').length,before.events.filter(e=>e.kind==='CHILD_STARTED').length);
    return observed;
  });
  await challenge('structural-and-work-invalidation','Actual Work revision invalidates dependent atlas and pending selection while immutable accepted history and consumed costs remain',async()=>{
    const p=await fixture('r7-structure');await resource(p);await bind(p);const b=await build(p);
    await receiveWork({tenantId:p.tenant,userId:p.principal,workId:p.workId,instruction:'Changed current actual Work revision',channel:'console',idempotencyKey:randomUUID()});
    const read=ok(await call(p,'read',{buildId:b.accepted.buildId}));assert.equal(read.status,'INVALIDATED');assert.equal(read.atlas,null);
    const prior=(await admin!.query('SELECT body FROM finnor_os.r7_atlases WHERE tenant_id=$1 AND build_id=$2',[p.tenant,b.accepted.buildId])).rows;
    assert.equal(prior.length,1);return {read,historicalRef:prior[0].body.ref,rows:await rows(p,b.accepted.buildId)};
  });
  await challenge('world-and-tie-invalidation','Actual immutable S1 world identity and original owner tie revisions invalidate old queries and pending selection, retain exact history/resources, and rebuild the reversed boundary tie under the same episode',async()=>{
    const observations=[];
    for(const kind of ['world','tie'] as const){
      const p=await fixture('r7-invalidation-'+kind);await resource(p);await bind(p);
      const b=await build(p);await parameters(p,['1/4']);const q=await query(p,b.accepted.buildId),before=await rows(p,b.accepted.buildId);
      assert.equal(q.choice!.policyId,'A');
      const revision=await reviseSource(p,source=>{
        if(kind==='tie')source.tieOrder=['B','A','WAIT'];
        else{
          source.worlds[0]!.id='revised-world';
          for(const predicate of source.hardPredicates)if(predicate.worldId==='w0')predicate.worldId='revised-world';
        }
      });
      const read=ok(await call(p,'read',{buildId:b.accepted.buildId})),
        staleQuery=await call(p,'query',{buildId:b.accepted.buildId,parameterRef:q.parameterRef,idempotencyKey:randomUUID(),fallback:'DEVELOPMENT_EXACT'}),
        staleSelection=await call(p,'select',{buildId:b.accepted.buildId,queryRef:q.ref,idempotencyKey:randomUUID()}),after=await rows(p,b.accepted.buildId);
      assert.equal(read.status,'INVALIDATED');assert.equal(read.atlas,null);
      assert.equal(staleQuery.status,409);assert.equal(staleQuery.body.code,'R7_STALE_INPUT');
      assert.equal(staleSelection.status,409);assert.equal(staleSelection.body.code,'R7_STALE_INPUT');
      assert.equal(after.episodes[0].invocations,before.episodes[0].invocations);
      assert.equal(+after.episodes[0].deadline_at,+before.episodes[0].deadline_at);
      const historical=(await admin!.query('SELECT body FROM finnor_os.r7_atlases WHERE tenant_id=$1 AND build_id=$2',[p.tenant,b.accepted.buildId])).rows[0].body;
      assert.equal(historical.ref.contentDigest,b.read.atlas.ref.contentDigest);
      let rebuilt;
      if(kind==='tie'){await parameters(p,['1/4']);const next=await build(p),lookup=await query(p,next.accepted.buildId);
        assert.equal(lookup.choice!.policyId,'B');assert.deepEqual(lookup.choice!.tiedPolicyIds,['B','A']);
        assert.equal(lookup.costs.fullFamilyEvaluations,0);rebuilt={build:next.accepted,query:lookup};}
      observations.push({kind,revision,read,staleQuery,staleSelection,before,after,historicalRef:historical.ref,rebuilt});
    }
    return observations;
  });
  await challenge('method-runtime-invalidation','A real configured interpreter change fences old authenticated lookup and selection at the loaded method identity; history, counters and original deadline remain unchanged',async()=>{
    const p=await fixture('r7-method-drift');await resource(p);await bind(p);
    const b=await build(p),q=await query(p,b.accepted.buildId),before=await rows(p,b.accepted.buildId),
      prior=process.env.FINNOR_R7_PYTHON,next=process.env.FINNOR_R7_ALT_PYTHON??join(repo,'.r7-scratch/science/bin/python3');
    assert.equal(next,resolve(next),'Explicit absolute alternate actual interpreter asset required');
    const pinned=process.env.FINNOR_R7_PYTHON??'/usr/bin/python3';
    assert.notEqual(sha(await readFile(pinned)),sha(await readFile(next)),'Two actual different interpreter binaries required');
    process.env.FINNOR_R7_PYTHON=next;
    let refusedQuery,refusedSelection;
    try{
      refusedQuery=await call(p,'query',{buildId:b.accepted.buildId,parameterRef:p.parameters!.ref,idempotencyKey:randomUUID(),fallback:'REQUIRE_ADMITTED'});
      refusedSelection=await call(p,'select',{buildId:b.accepted.buildId,queryRef:q.ref,idempotencyKey:randomUUID()});
      for(const result of [refusedQuery,refusedSelection]){
        assert.equal(result.status,409);assert.equal(result.body.code,'R7_STALE_INPUT');
        assert.equal(result.body.requirement,'Loaded R7 method/checker/runtime changed');
      }
    }finally{if(prior===undefined)delete process.env.FINNOR_R7_PYTHON;else process.env.FINNOR_R7_PYTHON=prior;}
    const after=await rows(p,b.accepted.buildId),historical=ok(await call(p,'read',{buildId:b.accepted.buildId}));
    assert.equal(historical.atlas.ref.contentDigest,b.read.atlas.ref.contentDigest);
    assert.deepEqual(after.episodes,before.episodes);assert.deepEqual(after.build,before.build);assert.deepEqual(after.jobs,before.jobs);
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.r7_queries WHERE tenant_id=$1',[p.tenant])).rows[0].n,1);
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
    return {query:q.ref,changedInterpreter:{path:next,sha256:sha(await readFile(next))},refusedQuery,refusedSelection,before,after,historicalRef:historical.atlas.ref};
  });
  await challenge('native-obligation-invalidation','An actual native compiled unexecuted Business Effect fences old authenticated atlas lookup and selection at S6 responsibility without changing history, counters or deadline',async()=>{
    const p=await fixture('r7-native-obligation');await resource(p);await bind(p);
    const b=await build(p),q=await query(p,b.accepted.buildId),before=await rows(p,b.accepted.buildId),actionId=randomUUID(),
      action:DomainAction={id:actionId,tenantId:p.tenant,actionType:'create_task',payload:{title:'Ordinary unexecuted local responsibility input'},
        policyId:null,status:'draft',createdAt:new Date().toISOString(),workId:p.workId,initiatedBy:p.principal};
    await admin!.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,summary,initiated_by,work_id) VALUES($1,$2,$3,$4::jsonb,'draft',$5,$6,$7)",
      [action.id,p.tenant,action.actionType,JSON.stringify(action.payload),'R7 currentness input, no authorization or execution',p.principal,p.workId]);
    const effect=await ensureBusinessEffect({action,draft:{actionType:action.actionType,payload:action.payload,
      summary:'Unexecuted native intent only',requiresConfirmation:true},policy:defaultPolicy(p.tenant,action.actionType),
      approval:{requiresConfirmation:true,typedConfirmation:false}});
    assert(effect,'Actual existing native compiler must persist the pending intent');
    const native=(await admin!.query('SELECT id,semantic_hash,status,authorized_at,execution_started_at,observed_result FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$2',
      [p.tenant,effect.id])).rows[0];
    assert.equal(native.status,'compiled');assert.equal(native.semantic_hash,effect.semanticHash);
    assert.equal(native.authorized_at,null);assert.equal(native.execution_started_at,null);assert.equal(native.observed_result,null);
    const refusedQuery=await call(p,'query',{buildId:b.accepted.buildId,parameterRef:p.parameters!.ref,idempotencyKey:randomUUID(),fallback:'REQUIRE_ADMITTED'}),
      refusedSelection=await call(p,'select',{buildId:b.accepted.buildId,queryRef:q.ref,idempotencyKey:randomUUID()});
    const dependency=(await admin!.query("SELECT key,revision::text FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key='m3:s6-effects'",[p.tenant])).rows[0],
      pinnedDependency=p.family!.input.dependencies.find(d=>d.key==='m3:s6-effects')!;
    await artifact('native-obligation/boundary.json',{effect,native,dependency,pinnedDependency,refusedQuery,refusedSelection,before});
    assert.equal(dependency.key,'m3:s6-effects');assert(BigInt(dependency.revision)>BigInt(pinnedDependency.revision));
    for(const result of [refusedQuery,refusedSelection]){
      assert.equal(result.status,409);assert.equal(result.body.code,'R7_STALE_INPUT');
      assert.equal(result.body.requirement,'Original source, rights, membership, Work or obligation interpretation changed');
    }
    const after=await rows(p,b.accepted.buildId),historical=ok(await call(p,'read',{buildId:b.accepted.buildId}));
    assert.equal(historical.status,'INVALIDATED');assert.equal(historical.atlas,null);
    const retained=await withTenantTransaction(p.tenant,{userId:p.principal,readOnly:true},async(_db,c)=>
      (await c.query('SELECT body FROM finnor_os.r7_atlases WHERE tenant_id=$1 AND principal_id=$2 AND build_id=$3',
        [p.tenant,p.principal,b.accepted.buildId])).rows[0]);
    assert.deepEqual(retained.body,b.read.atlas,'Retained original atlas must survive current obligation invalidation');
    assert.deepEqual(after.episodes,before.episodes);assert.deepEqual(after.build,before.build);assert.deepEqual(after.jobs,before.jobs);
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.r7_queries WHERE tenant_id=$1',[p.tenant])).rows[0].n,1);
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
    assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.decision_receipts WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
    return {query:q.ref,effect,native,dependency,pinnedDependency,refusedQuery,refusedSelection,before,after,historicalRef:retained.body.ref,historical,
      qualification:'ACTUAL_NATIVE_COMPILED_INTENT_NOT_AUTHORIZATION_EXECUTION_PROVIDER_OR_SETTLEMENT_EVIDENCE'};
  });
  await challenge('original-continuation','Current exact S4 follows the original selected WAIT history with retained S5 reservation, no family reoptimization; forged and skipped history refuse at their intended owner',async()=>{
    const p=await fixture('r7-continuation','diagnostic',1,3,2,2,source=>{
      // Freeze original input before S1 persistence. No effect/observation
      // receipt is supplied; the real clock must reach the original period.
      for(const world of source.worlds)for(const path of world.paths)if(path.policyId==='WAIT')for(const state of path.states)
        state.net={a:['0/1'],b:'2/1'};
      const {ref:_m,...mandate}=source.mandate;
      mandate.horizon={...mandate.horizon,startAt:new Date(Date.now()+5000).toISOString(),periodMs:1000};
      source.mandate={...mandate,ref:fixtureRef('BUSINESS_OWNER','exact-affine-mandate:'+sha(canonical(mandate)),mandate,'economic-mandate-exact-affine-v1')};
    });
    await resource(p);await bind(p);const b=await build(p),q=await query(p,b.accepted.buildId);
    assert.equal(q.choice!.policyId,'WAIT');
    const selected=ok(await call(p,'select',{buildId:b.accepted.buildId,queryRef:q.ref,idempotencyKey:randomUUID()}));
    const at=Date.parse(p.source.mandate.horizon.startAt)+p.source.mandate.horizon.periodMs;
    if(at>Date.now())await new Promise(yes=>setTimeout(yes,at-Date.now()));
    const decision={knowledgeAt:new Date().toISOString(),period:1,actionHistory:['WAIT-action'],observations:[],
      rightsRef:p.source.mandate.rightsRef,obligations:[],allocationRefs:[selected.consumption.certificateRef]},
      request={consumptionRef:selected.consumption.ref,decision,idempotencyKey:randomUUID()};
    const wrong=await call(p,'continue',{...request,decision:{...decision,actionHistory:['A-action']}});assert.equal(wrong.status,422);
    const observation=await call(p,'continue',{...request,decision:{...decision,observations:[{instrumentId:'unlawful',token:'private',availablePeriod:1,
      knowledgeAt:decision.knowledgeAt,sourceRef:fixtureRef('S2','fabricated')}]}});assert.equal(observation.status,422);
    const next=ok(await call(p,'continue',request));assert.equal(next.choice.action.kind,'WAIT');assert.equal(next.choice.nodeId,'WAIT-1');
    const replay=ok(await call(p,'continue',request));assert.equal(replay.consumption.ref.contentDigest,next.consumption.ref.contentDigest);
    assert.equal(next.guaranteeBasis,'ORIGINAL_WHOLE_HORIZON_NOT_NEW_CONDITIONAL_OPTIMUM');
    return {q,selected,wrong,observation,next,replay};
  });
  await challenge('s5-owned-parameter-reuse','Mixed-owner revisions edit only business coordinates; exact current canonical S5 availability selects checked cells without optimizer reuse or editable money',async()=>{
    const p=await fixture('r7-s5-parameters','diagnostic',2,3,2,1,source=>{
      source.domain.parameters[1]={id:'cashAvailable',unit:'USD',currency:'USD',owner:'S5',valueSource:'CURRENT_S5_AVAILABLE',
        resourceId:'cash',resourcePeriod:0,lower:'0/1',upper:'1/1'};
      source.parameterValues[1]='1/1';
      for(const world of source.worlds)source.hardPredicates.push({id:'A-current-cash-'+world.id,policyId:'A',worldId:world.id,period:0,
        expression:{a:['0/1','-1/1'],b:'1/3'},relation:'LE',unit:'USD',owner:'S5',sourceRef:fixtureRef('BUSINESS_OWNER','cash-source')});
    });
    await resource(p);await bind(p);const b=await build(p),initial=await query(p,b.accepted.buildId);
    assert.equal(initial.choice!.policyId,'A');assert.deepEqual(initial.choice!.parameters,['1/2','1/1']);
    await parameters(p,['3/4','1/1']);const edited=await query(p,b.accepted.buildId);assert.equal(edited.choice!.policyId,'B');
    await resource(p,'0.2');
    const forged=await call(p,'parameters',{familyRef:p.family!.ref,expectedRef:p.parameters!.ref,values:['1/2','1/1']});
    assert.equal(forged.status,422);assert.equal(forged.body.code,'R7_UNSUPPORTED');
    await parameters(p,['1/2','1/5']);const current=await query(p,b.accepted.buildId),oracle=reference(p,['1/2','1/5']);
    assert.equal(current.choice!.policyId,'B');assert.deepEqual(current.choice!.parameters,['1/2','1/5']);
    assert.equal(current.choice!.policyId,oracle.queries[0].winner);assert.equal(current.costs.fullFamilyEvaluations,0);
    const context=ok(await call(p,'context',{workId:p.workId,root:p.root}));
    assert.deepEqual(context.effectiveValues,['1/2','1/5']);
    assert.equal(context.parameterSources[1].ref.contentDigest,p.resource!.ref!.contentDigest);
    const stale=await call(p,'select',{buildId:b.accepted.buildId,queryRef:initial.ref,idempotencyKey:randomUUID()});
    assert.equal(stale.status,409);
    const {ref:resourceRef,revision:_revision,priorRef:_prior,...resourceBody}=p.resource!;
    p.resource=ok(await call(p,'resource',{resource:{...resourceBody,revoked:true},expectedRef:resourceRef},'allocations'));
    const revoked=await call(p,'query',{buildId:b.accepted.buildId,parameterRef:p.parameters!.ref,idempotencyKey:randomUUID(),fallback:'DEVELOPMENT_EXACT'});
    assert.equal(revoked.status,422);assert.equal(revoked.body.code,'R7_UNSUPPORTED');
    return {b:b.accepted,initial,edited,forged,current,oracle,context,stale,revoked};
  });
  await challenge('current-s5-query-publication-race','Actual canonical resource revision after physical full-family evaluation fences query publication; the consumed children remain charged and no stale query row appears',async()=>{
    const p=await fixture('r7-query-resource-race');await pausePublication(p.tenant,'r7_events','FALLBACK_EVALUATED');
    try{
      await resource(p);await bind(p);
      const b=await build(p,{maxNodes:1,maxDepth:256,maxFacets:256,maxBases:200000,maxTotalBases:2000000,maxBytes:33554432,deadlineMs:30000}),
        request=call(p,'query',{buildId:b.accepted.buildId,parameterRef:p.parameters!.ref,idempotencyKey:randomUUID(),fallback:'DEVELOPMENT_EXACT'});
      const waiting=await waitFor(async()=>{const row=(await admin!.query(
        "SELECT pid,query,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO finnor_os.r7_events%'")).rows[0];return row??false;});
      await resource(p,'0.2');await admin!.query('SELECT pg_advisory_unlock(707777)');
      const refused=await request;assert.equal(refused.status,409);assert.equal(refused.body.code,'R7_STALE_INPUT');
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.r7_queries WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
      const beforeRetry=await rows(p,b.accepted.buildId),retry=await query(p,b.accepted.buildId,'DEVELOPMENT_EXACT');
      assert.equal(retry.choice!.policyId,'B');assert.equal(retry.choice!.ownerChecks.fullFamilyOptimizerInvoked,true);
      assert.equal(beforeRetry.episodes[0].invocations,4);
      return {b:b.accepted,waiting,refused,beforeRetry,retry};
    }finally{await removePause('r7_events').catch(()=>undefined);}
  });
  await challenge('shared-work-reservation-race','Two actual Works share original episode and canonical portfolio lock; only one simultaneous checked query consumes scarce cash, remaining full-family fallback chooses original WAIT',async()=>{
    const p=await fixture('r7-two-works','diagnostic',1,3,2,1,source=>{
      const b=source.policies.find(p=>p.id==='B')!;b.actions[0]!.resources.cash={a:['0/1'],b:'1/3'};
      const {ref:_old,...body}=b;b.ref=fixtureRef('S4','exact-affine-policy:'+sha(canonical(body)),body,'s4-exact-affine-v1');
    }),secondWork=(await receiveWork({tenantId:p.tenant,userId:p.principal,instruction:'Competing original second Work',channel:'console',
      idempotencyKey:randomUUID(),activeContext:{entityRefs:[p.root]}})).workId,
      other:F={...p,workId:secondWork,family:undefined,parameters:undefined};
    await resource(p,'0.5');await bind(p);await bind(other);await parameters(other,['3/4']);
    assert.equal(p.family!.episodeId,other.family!.episodeId);
    const first=await build(p),second=await build(other),a=await query(p,first.accepted.buildId),b=await query(other,second.accepted.buildId);
    assert.equal(a.choice!.policyId,'A');assert.equal(b.choice!.policyId,'B');
    const selections=await Promise.all([[p,first,a],[other,second,b]].map(async([actor,built,q]:any[])=>
      call(actor,'select',{buildId:built.accepted.buildId,queryRef:q.ref,idempotencyKey:randomUUID()})));
    assert.equal(selections.filter(r=>r.status===200).length,1);assert.equal(selections.filter(r=>r.status===409).length,1);
    const snapshot=ok(await call(p,'resources',{},'allocations'));assert.equal(snapshot.outstanding.length,1);
    assert.equal(snapshot.outstanding[0].envelopes[0].quantities[0],'1/3');
    const fallback=await query(other,second.accepted.buildId,'DEVELOPMENT_EXACT');assert.equal(fallback.choice!.policyId,'WAIT');
    return {first:first.accepted,second:second.accepted,selections,snapshot,fallback,rows:await rows(p,first.accepted.buildId)};
  });
  await challenge('physical-accepted-recovery','SIGKILL actual worker after durable independent acceptance and before publication/ack; expired claim recovery reauthorizes accepted bytes with no extra physical invocation and retained unknown supervisor cost',async()=>{
    const p=await fixture('r7-kill-accepted');await pausePublication(p.tenant,'r7_atlases');await resource(p);await bind(p);
    const accepted=ok(await call(p,'build',buildBody(p)),202);
    const running=startWorker();
    try{
      const waiting=await waitFor(async()=>{const r=(await admin!.query("SELECT pid,query,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO finnor_os.r7_atlases%'")).rows[0];return r??false;});
      const before=await rows(p,accepted.buildId);assert(before.events.some(e=>e.kind==='CHECK_ACCEPTED'&&e.body.check.status==='ACCEPTED'));
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.r7_atlases WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
      running.child.kill('SIGKILL');assert.equal((await running.done).signal,'SIGKILL');
      await admin!.query('SELECT pg_advisory_unlock(707777)');
      await waitFor(async()=>!(await admin!.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[waiting.pid])).rows.length,15000);
      await waitFor(async()=>Boolean((await admin!.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'buildId'=$2 AND lease_expires_at<clock_timestamp()",[p.tenant,accepted.buildId])).rows.length),15000);
      await worker();const read=ok(await call(p,'read',{buildId:accepted.buildId})),after=await rows(p,accepted.buildId);
      assert.equal(read.status,'COMPLETE');assert.equal(after.episodes[0].invocations,before.episodes[0].invocations);
      assert.equal(+after.episodes[0].deadline_at,+before.episodes[0].deadline_at);
      assert(after.events.some(e=>e.kind==='FAILED'&&e.body.predicate==='DURABLE_WORKER_LOST'));
      assert(after.events.some(e=>e.kind==='FINISHED'&&e.body.reusedAcceptedChild));
      assert.equal(read.atlas.envelope.costs.attempts,2);assert.equal(read.atlas.envelope.costs.unreconciledAttemptIds.length,1);
      assert.equal(after.jobs[0].status,'completed');return {accepted,waiting,workerPid:running.child.pid,before,after,read};
    }finally{
      if(running.child.exitCode===null&&running.child.signalCode===null)running.child.kill('SIGKILL');
      await running.done;await removePause('r7_atlases').catch(()=>undefined);
    }
  });
  await challenge('actual-principal-publication-race','Real principal FOR UPDATE revocation wins against publication FOR SHARE after actual checker acceptance; no atlas publishes and costs/accepted history remain',async()=>{
    const p=await fixture('r7-principal-race');await pausePublication(p.tenant,'r7_events');await resource(p);await bind(p);
    const accepted=ok(await call(p,'build',buildBody(p)),202);
    const locker=new pg.Client({connectionString:url});await locker.connect();const running=startWorker();
    try{
      await waitFor(async()=>Boolean((await admin!.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO finnor_os.r7_events%'")).rows.length));
      await locker.query('BEGIN');await locker.query('SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[p.tenant,p.principal]);
      await admin!.query('SELECT pg_advisory_unlock(707777)');
      const blocked=await waitFor(async()=>{
        const event=(await admin!.query("SELECT body FROM finnor_os.r7_events WHERE tenant_id=$1 AND build_id=$2 AND kind='CHECK_ACCEPTED'",[p.tenant,accepted.buildId])).rows[0];
        const wait=(await admin!.query("SELECT pid,query,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%finnor_os.users%'")).rows[0];
        return event&&wait?{event,wait}:false;
      });
      assert.equal(blocked.event.body.check.status,'ACCEPTED');
      await locker.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[p.tenant,p.principal]);await locker.query('COMMIT');
      await running.done;await removePause('r7_events');
      const after=await rows(p,accepted.buildId),read=await call(p,'read',{buildId:accepted.buildId});
      assert.notEqual(read.status,200);assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.r7_atlases WHERE tenant_id=$1',[p.tenant])).rows[0].n,0);
      assert.equal(after.episodes[0].invocations,2);return {accepted,blocked,after,read};
    }finally{
      await locker.query('ROLLBACK').catch(()=>undefined);await locker.end();
      if(running.child.exitCode===null&&running.child.signalCode===null)running.child.kill('SIGKILL');
      await running.done;await removePause('r7_events').catch(()=>undefined);
    }
  });
  await challenge('physical-cancel-and-original-deadline','Actual in-flight Node child stops on cancellation and releases physical lease; original episode expiry cannot renew invocation counters or deadline',async()=>{
    const p=await fixture('r7-inflight','maximal',4,32,64,12);await resource(p);await bind(p);
    const accepted=ok(await call(p,'build',buildBody(p)),202),running=startWorker();
    const start=await waitFor(async()=>(await admin!.query("SELECT body FROM finnor_os.r7_events WHERE tenant_id=$1 AND build_id=$2 AND kind='CHILD_STARTED' AND body->>'mode'='BUILD'",[p.tenant,accepted.buildId])).rows[0]?.body??false);
    await call(p,'cancel',{buildId:accepted.buildId});await running.done;
    const after=await rows(p,accepted.buildId),leases=(await admin!.query("SELECT released_at,expires_at,release_reason FROM finnor_os.compute_resource_leases WHERE owner_id=$1",['r7:'+start.invocationId])).rows;
    assert.equal(after.build[0].status,'CANCELLED');assert(leases.every(l=>l.released_at!==null));assert.equal(after.episodes[0].invocations,1);
    assert.throws(()=>process.kill(start.pid,0));
    const expired=await fixture('r7-expired');
    await admin!.query("INSERT INTO finnor_os.r7_episodes(tenant_id,principal_id,episode_id,deadline_at,max_invocations) VALUES($1,$2,$3,clock_timestamp()-interval '1 second',64)",
      [expired.tenant,expired.principal,expired.source.mandate.episodeId]);
    await resource(expired);await bind(expired);
    const refusal=await call(expired,'build',buildBody(expired));assert.equal(refusal.status,422);assert.equal(refusal.body.code,'R7_LIMIT_EXCEEDED');
    const episode=(await admin!.query('SELECT * FROM finnor_os.r7_episodes WHERE tenant_id=$1',[expired.tenant])).rows[0];assert.equal(episode.invocations,0);
    return {accepted,start,after,leases,refusal,episode};
  });
  await challenge('actual-compute-capacity','Actual occupied native:r7 governor slots refuse a third child, retain the original invocation charge and do not publish; releasing the actual leases permits a new build under the same episode',async()=>{
    const {acquireComputeResourceLeases,releaseComputeResourceLeases}=await import('@finnor/db/compute-governor'),
      p=await fixture('r7-native-capacity');await resource(p);await bind(p);
    const leases=await Promise.all([0,1].map(i=>acquireComputeResourceLeases({tenantId:p.tenant,resourceKeys:['native:r7'],
      requiredResourceKeys:['native:r7'],workloadClass:'INTERACTIVE',ownerId:'r7-disposable-held-'+p.tenant+':'+i})));
    let accepted:any,before:any,read:any;
    try{
      accepted=ok(await call(p,'build',buildBody(p)),202);await worker();
      before=await rows(p,accepted.buildId);read=ok(await call(p,'read',{buildId:accepted.buildId}));
      assert.equal(read.status,'FAILED');assert.equal(read.atlas,null);
      assert(!before.events.some((e:{kind:string})=>e.kind==='CHILD_STARTED'));assert.equal(before.episodes[0].invocations,1);
      assert.equal(read.failure.code,'LIMIT_EXCEEDED');
      assert.equal(read.failure.requirement,'Shared compute capacity is unavailable for native:r7');
    }finally{await releaseComputeResourceLeases(leases.flat(),'r7-disposable-capacity-proof-complete');}
    const repaired=await build(p),after=await rows(p,repaired.accepted.buildId);
    assert.equal(after.episodes[0].episode_id,before.episodes[0].episode_id);
    assert.equal(+after.episodes[0].deadline_at,+before.episodes[0].deadline_at);
    assert.equal(after.episodes[0].invocations,3);
    return {accepted,before,read,held:leases.map(ls=>ls.map(l=>({resourceKey:l.resourceKey,ownerId:l.ownerId,fence:l.fence}))),
      repaired:repaired.accepted,after};
  });
  await challenge('physical-parent-loss-watchdog','SIGKILL the actual supervisor during synchronous maximal geometry; the physical child exits independently, its lease expires without a fabricated release and consumed original invocation/deadline remain',async()=>{
    const p=await fixture('r7-orphan','maximal',4,32,64,12);await resource(p);await bind(p);
    const accepted=ok(await call(p,'build',buildBody(p)),202),running=startWorker();
    try{
      const start=await waitFor(async()=>(await admin!.query("SELECT body FROM finnor_os.r7_events WHERE tenant_id=$1 AND build_id=$2 AND kind='CHILD_STARTED' AND body->>'mode'='BUILD'",
        [p.tenant,accepted.buildId])).rows[0]?.body??false);
      const live=spawnSync('ps',['-p',String(start.pid),'-o','pid=,ppid=,comm='],{encoding:'utf8'});
      assert.equal(live.status,0);assert(live.stdout.includes(String(running.child.pid)));
      const before=await rows(p,accepted.buildId);running.child.kill('SIGKILL');
      assert.equal((await running.done).signal,'SIGKILL');
      await waitFor(async()=>{const s=spawnSync('ps',['-p',String(start.pid),'-o','stat='],{encoding:'utf8'});
        return s.status!==0||s.stdout.trim().startsWith('Z');},5000);
      const lease=await waitFor(async()=>{
        const row=(await admin!.query("SELECT owner_id,released_at,expires_at,clock_timestamp() observed_at FROM finnor_os.compute_resource_leases WHERE owner_id=$1",
          ['r7:'+start.invocationId])).rows[0];return row&&row.expires_at<row.observed_at?row:false;
      },20000),after=await rows(p,accepted.buildId);
      assert.equal(lease.released_at,null);assert.equal(after.episodes[0].invocations,1);
      assert.equal(+after.episodes[0].deadline_at,+before.episodes[0].deadline_at);
      assert(!after.events.some(e=>e.kind==='BUILD_RETURNED'||e.kind==='CHECK_ACCEPTED'||e.kind==='FINISHED'));
      return {accepted,workerPid:running.child.pid,start,liveProcess:live.stdout.trim(),before,after,lease,
        costQualification:'Actual child start, no result or acknowledged child CPU/RSS after physical parent loss; unreconciled cost remains UNKNOWN'};
    }finally{if(running.child.exitCode===null&&running.child.signalCode===null)running.child.kill('SIGKILL');await running.done;}
  });
  if(process.argv.includes('--cost'))await challenge('matched-reuse','The frozen 128-point original full-family batch and real checked atlas queries preserve all exact outcomes and charge complete observed phases, fallback and structural rebuild under the same original episode',async()=>{
    return matchedReuse({repo,admin:admin!,fixture,resource,bind,build,parameters,query,call,reviseSource,artifact});
  });
  if(process.argv.includes('--browser'))await challenge('mounted-capital-work','Actual existing Capital Work binds/builds/queries, crosses owner parameter boundaries, reloads and clears delayed private output on Work/principal change',async()=>{
    return mountedAtlas({repo,output,admin:admin!,host:host!,fixture,resource,worker,call,artifact});
  });
}catch(error){cases.push({id:'campaign-setup',status:'FAIL',observed:{predicate:String(error),stack:(error as Error).stack}});await save();console.error(String(error));}
finally{
  if(cases.some((c:any)=>c.status==='FAIL'))process.exitCode=1;
  for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');
  await save();await host?.close();await closePool();await admin?.end();await postgres.stop().catch(()=>undefined);
}
// embedded-postgres's inherited async-exit-hook maps beforeExit to zero.
// Explicitly preserve this campaign's recorded failure after bounded cleanup.
process.exit(cases.some((c:any)=>c.status==='FAIL')?1:0);
