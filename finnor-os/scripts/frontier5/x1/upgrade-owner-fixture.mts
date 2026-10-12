import { execFileSync } from 'node:child_process';
import { createHash,randomUUID,randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../../packages/db/migrate';
import { closePool,configureTenantVertical,receiveWork,withTenantTransaction,enqueueJob } from '@finnor/db';
import { createDocument,appendDocumentVersion } from '@finnor/data-platform';

const base='517003a4396bc8101a90be4b425ee01de9446740';
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export async function prepareExistingOwnerUpgrade(input:{repo:string;databaseUrl:string;applicationUrl:string;
  workerUrl:string;workerPassword:string;appPassword:string;commit:string;expectedMigrationCount:number}){
  const prefix='finnor-os/packages/db/migrations/';
  const files=execFileSync('git',['ls-tree','-r','--name-only',base,'--',prefix],
    {cwd:input.repo,encoding:'utf8',timeout:5000}).trim().split('\n').filter(path=>path.endsWith('.sql')).sort();
  assert.equal(files.at(-1),prefix+'0171_runtime_database_role_isolation.sql');
  const retained=[];
  for(const path of files){
    const sql=execFileSync('git',['show',base+':'+path],{cwd:input.repo,encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024});
    assert.equal(digest(await readFile(join(input.repo,path))),digest(sql),'immutable retained migration '+path);
    retained.push({name:path.slice(prefix.length),sql});
  }
  const oldMigrations=await migrate(input.databaseUrl,retained);
  const tenantId=randomUUID(),userId=randomUUID();
  const c=new pg.Client({connectionString:input.databaseUrl});await c.connect();
  try{
    await c.query('ALTER ROLE finnor_app LOGIN PASSWORD '+c.escapeLiteral(input.appPassword));
    await c.query('ALTER ROLE finnor_worker LOGIN PASSWORD '+c.escapeLiteral(input.workerPassword));
    await c.query("SET app.test_vertical_mode='explicit'");
    await c.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Preserved pre-X1 institution')",[tenantId,randomUUID()]);
    await c.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[userId,tenantId,userId+'@test.invalid']);
  }finally{await c.end();}
  process.env.DATABASE_URL=input.applicationUrl;await closePool();
  await configureTenantVertical({tenantId,verticalKey:'private_equity',expectedVersion:0,createdBy:userId,sourceSystem:'X1:pre-upgrade-owner-fixture'});
  const work=await receiveWork({tenantId,userId,channel:'console',idempotencyKey:'old-work:'+randomUUID(),
    instruction:'Preserve this existing authorized institution Work and its original evidence across X1 upgrade',
    authorityContext:{principalId:userId,scope:'READ_ONLY_LEGACY_UPGRADE_WITNESS'}});
  const bytes=randomBytes(513);
  const version=await withTenantTransaction(tenantId,{userId},async db=>{
    const doc=await createDocument(db,{tenantId,kind:'evidence',title:'Original pre-X1 binary evidence',
      provenance:{sourceSystem:'existing-owner-upgrade-fixture',externalId:randomUUID(),createdBy:userId}});
    return appendDocumentVersion(db,{tenantId,documentId:doc.documentId,bytes,mediaType:'application/octet-stream',
      format:'unknown',origin:'manual_upload',actor:userId,sourceSystem:'existing-owner-upgrade-fixture',
      providerVersionId:'before-X1'});
  });
  const probeKey='old-release-probe:'+randomUUID();
  // Global maintenance enqueue belongs to the existing independent worker
  // role. The application role's inherited global-probe refusal is retained in
  // the first failed run; no policy or role membership is relaxed here.
  process.env.DATABASE_URL=input.workerUrl;await closePool();
  await enqueueJob('release_probe',{commitSha:input.commit},probeKey);
  const admin=new pg.Client({connectionString:input.databaseUrl});await admin.connect();
  try{
    const probe=(await admin.query('SELECT id FROM finnor_os.jobs WHERE idempotency_key=$1',[probeKey])).rows[0];
    const retired=(await admin.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key)
      VALUES($1,'scheduled_reminder',$2::jsonb,$3) RETURNING id`,[tenantId,JSON.stringify({tenantId,legacy:true}),
      'old-retired-job:'+randomUUID()])).rows[0];
    const starting=await observePreservedUpgradeOwners(admin,{tenantId,userId,workId:work.workId,documentVersionId:version.id});
    const added=await migrate(input.databaseUrl),again=await migrate(input.databaseUrl);
    assert.equal(oldMigrations.length+added.length,input.expectedMigrationCount);assert.equal(again.length,0);
    assert.ok(added.every(name=>!oldMigrations.includes(name)));
    assert.deepEqual(await observePreservedUpgradeOwners(admin,{tenantId,userId,workId:work.workId,documentVersionId:version.id}),starting);
    return {base,oldHead:'0171_runtime_database_role_isolation.sql',sourceMigrations:retained.map(row=>({name:row.name,sha256:digest(row.sql)})),
      oldMigrations,additiveMigrations:added,secondPassApplied:again,tenantId,userId,workId:work.workId,
      documentVersionId:version.id,originalByteSha256:digest(bytes),probeId:probe.id,retiredId:retired.id,starting,
      legacyGlobalJobPublisherRole:'finnor_worker',applicationWorkerMembershipGranted:false};
  }finally{await admin.end();await closePool();}
}

export async function observePreservedUpgradeOwners(c:pg.Client,input:{tenantId:string;userId:string;
  workId:string;documentVersionId:string}){
  const rows=async(sql:string,values:unknown[])=>JSON.parse(JSON.stringify((await c.query(sql,values)).rows));
  return {users:await rows('SELECT * FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.userId]),
    works:await rows('SELECT * FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.workId]),
    documentVersions:await rows('SELECT * FROM finnor_os.document_versions WHERE tenant_id=$1 AND id=$2',[input.tenantId,input.documentVersionId]),
    documentContents:await rows('SELECT * FROM finnor_os.document_version_contents WHERE tenant_id=$1 AND version_id=$2',[input.tenantId,input.documentVersionId])};
}
