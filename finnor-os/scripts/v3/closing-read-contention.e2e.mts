/** Ordinary-role owner reads against a private copy of the actual native fixture. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const owner=process.argv[2],output=process.argv[3];
const selected=process.argv[4]??'ordinary';
assert(owner?.startsWith('/')&&output?.startsWith('/')&&process.platform==='linux');
assert(['ordinary','fresh-correction','legacy-lease','lease'].includes(selected));
const input=JSON.parse(await readFile(join(owner,'runtime-identities.json'),'utf8'));
const original=resolve(input.database.directory);
assert(original.startsWith(resolve(owner,'../tmp')+'/')&&basename(original).startsWith('finnor-v3-runtime-pg-'));
assert.equal(await realpath(original),original,'Source fixture must not traverse a symlink');
assert(!resolve(output).startsWith(original+'/')&&!original.startsWith(resolve(output)+'/')&&resolve(output)!==original);
assert.equal(input.privateCredentialsIncluded,false);
await mkdir(output,{mode:0o700});
const cluster=join(output,'cluster');execFileSync('cp',['-a','--reflink=auto',original,cluster]);
// This test-only clone has no workers, provider, broker or external connections.
// Its local diagnostic connection changes no original role or runtime grant.
await writeFile(join(cluster,'pg_hba.conf'),'host all all 127.0.0.1/32 trust\n',{mode:0o600});
const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert(address&&typeof address!=='string');const port=address.port;
await new Promise<void>(resolve=>server.close(()=>resolve()));
const postgres=new EmbeddedPostgres({databaseDir:cluster,port,user:'finnor_v3',password:'unused-local-diagnostic',
 createPostgresUser:process.getuid?.()===0,persistent:true,
 postgresFlags:['-c','unix_socket_directories=','-c','listen_addresses=127.0.0.1','-c','track_commit_timestamp=on'],onLog:()=>{}});
const admin=new pg.Client({host:'127.0.0.1',port,database:input.database.name,user:'finnor_v3'});
const observations:any[]=[];let closePool:(()=>Promise<void>)|undefined,started=false,connected=false,exit=1;
try{
 await postgres.start();started=true;await admin.connect();connected=true;
 if(selected==='lease'){
  const fenceSql=`SELECT t.tgname,c.relname,pg_get_triggerdef(t.oid) definition
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgfoid='finnor_os.pe_v3_material_write_fence()'::regprocedure
    AND t.tgrelid<>'finnor_os.pe_closing_programmes'::regclass ORDER BY c.relname,t.tgname`;
  const aclSql=`SELECT c.relname,c.relacl::text acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='finnor_os' AND c.relkind IN('r','p') ORDER BY c.relname`;
  const fencesBefore=(await admin.query(fenceSql)).rows,aclBefore=JSON.stringify((await admin.query(aclSql)).rows);
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';
  const {migrate}=await import('../../packages/db/migrate');
  const applied=await migrate(`postgres://finnor_v3@127.0.0.1:${port}/${input.database.name}`);
  const replay=await migrate(`postgres://finnor_v3@127.0.0.1:${port}/${input.database.name}`);
  assert.equal(replay.length,0,'Official migration replay must be empty');
  assert(JSON.stringify((await admin.query(fenceSql)).rows)===JSON.stringify(fencesBefore),'Unrelated material fences changed');
  assert(JSON.stringify((await admin.query(aclSql)).rows)===aclBefore,'Existing table privileges changed');
  observations.push({case:'official-forward-migration',applied:applied.length,replay:replay.length,
   unrelatedMaterialFencesUnchanged:fencesBefore.length,existingTablePrivilegesUnchanged:true});
 }
 const databaseRole=selected.includes('lease')?'finnor_worker':'finnor_app';
 process.env.DATABASE_URL=`postgres://${databaseRole}@127.0.0.1:${port}/${input.database.name}`;
 process.env.DOTENV_CONFIG_PATH=join(output,'empty.env');await writeFile(process.env.DOTENV_CONFIG_PATH,'');
 const db=await import('@finnor/db');closePool=db.closePool;
 const {readClosingProgramme}=await import('../../packages/private-equity/src/closing/store');
 const q=(await admin.query('SELECT id,tenant_id,principal_id,transaction_id,last_check_id,status FROM finnor_os.pe_closing_programmes ORDER BY created_at LIMIT 1')).rows[0];assert(q);
 const ctx:any={auth:{tenantId:q.tenant_id,userId:q.principal_id,employeeId:null,role:'owner'}};
 const role=(await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',[databaseRole])).rows[0];
 assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
 const lockedRead=async(operation:()=>Promise<unknown>=()=>readClosingProgramme(ctx,q.id))=>{
  await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('v3-material-cut:' || $1::uuid::text,0))",[q.tenant_id]);
  let held=true,timer:NodeJS.Timeout|undefined;
  const began=performance.now();
  try{
   const pending=operation().then(value=>({value,completedWhileWriterHeld:held,elapsedMs:performance.now()-began}));
   timer=setTimeout(()=>{held=false;void admin.query('ROLLBACK')},1000);
   const read=await pending;clearTimeout(timer);
   if(held){held=false;await admin.query('ROLLBACK');}
   return read;
  }finally{if(timer)clearTimeout(timer);await admin.query('ROLLBACK');}
 };
 if(selected==='fresh-correction'){
 assert.equal(q.status,'CLOSED','Fresh correction requires a still-closed controlled fixture');
 // The retained native fixture's real checker validity has elapsed. Do not
 // patch immutable evidence, certificates, business truth or the system clock.
 const expiry=(await admin.query('SELECT valid_until<=clock_timestamp() expired FROM finnor_os.pe_closing_checks WHERE id=$1',[q.last_check_id])).rows[0];
 assert.equal(expiry?.expired,true,'An actually expired controlled owner fixture is required');
 const before=Number((await admin.query("SELECT count(*) n FROM finnor_os.pe_closing_events WHERE programme_id=$1 AND kind='REOPENED'",[q.id])).rows[0].n);
 const corrected=await Promise.all([readClosingProgramme(ctx,q.id),readClosingProgramme(ctx,q.id)]);
 assert(corrected.every(row=>row.status==='REOPENED'));
 const persisted=(await admin.query('SELECT status FROM finnor_os.pe_closing_programmes WHERE id=$1',[q.id])).rows[0];
 assert.equal(persisted.status,'REOPENED');
 const after=Number((await admin.query("SELECT count(*) n FROM finnor_os.pe_closing_events WHERE programme_id=$1 AND kind='REOPENED'",[q.id])).rows[0].n);
 assert.equal(after-before,1,'concurrent readers duplicated the currentness correction');
 observations.push({case:'concurrent-expired-certificate-correction',status:'REOPENED',correctionEvents:after-before});
 }
 if(selected==='ordinary'){
 // Preserve the canonical CLOSED transition guard. This copy can move only
 // toward a blocked state, never fabricate a new closed certificate.
 await admin.query("UPDATE finnor_os.pe_closing_programmes SET status='BLOCKED' WHERE id=$1",[q.id]);
 const open=await lockedRead();observations.push({case:'ordinary-read-with-concurrent-tenant-writer',
  completedWhileWriterHeld:open.completedWhileWriterHeld,elapsedMs:Math.round(open.elapsedMs)});
 assert(open.completedWhileWriterHeld,'ordinary read acquired the tenant material-cut writer lock');
 }
 if(selected.includes('lease')){
  const row=(await admin.query('SELECT id,tenant_id,generation FROM finnor_os.pe_closing_programmes WHERE id=$1',[q.id])).rows[0];
  const token=randomUUID();
  await admin.query("UPDATE finnor_os.pe_closing_programmes SET controller_lease_token=$2,controller_lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1",[q.id,token]);
  await admin.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[q.tenant_id,q.principal_id]);
  const before=(await admin.query('SELECT finnor_os.pe_closing_cut_digest($1,$2) digest',[q.tenant_id,q.id])).rows[0].digest;
  const budgetBefore=JSON.stringify((await admin.query('SELECT deadline_at,max_steps,max_actions,max_queries,step_count,action_count,query_count FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=(SELECT work_id FROM finnor_os.pe_closing_programmes WHERE id=$2)',[q.tenant_id,q.id])).rows);
  const legacy=async()=>{const {closingTx}=await import('../../packages/private-equity/src/owner-context');return closingTx(ctx,async c=>Boolean((await c.query("UPDATE finnor_os.pe_closing_programmes SET controller_lease_until=clock_timestamp()+interval '90 seconds' WHERE tenant_id=$1 AND id=$2 AND controller_lease_token=$3 AND generation=$4 RETURNING id",[row.tenant_id,row.id,token,row.generation])).rowCount));};
  const renew=selected==='legacy-lease'?null:(await import('../../packages/private-equity/src/closing/controller-lease')).renewClosingControllerLease;
  const heartbeat=await lockedRead(renew?()=>renew(ctx,row,token):legacy);
  observations.push({case:'heartbeat-with-concurrent-tenant-writer',completedWhileWriterHeld:heartbeat.completedWhileWriterHeld,elapsedMs:Math.round(heartbeat.elapsedMs),renewed:heartbeat.value});
  assert(heartbeat.completedWhileWriterHeld,'operational heartbeat acquired the material-cut writer lock');
  assert.equal(heartbeat.value,true);
  if(renew){
   assert.equal(await renew(ctx,row,randomUUID()),false,'stale nonce renewed a controller');
   assert.equal(await renew(ctx,{...row,generation:row.generation+1},token),false,'stale generation renewed a controller');
   await admin.query("UPDATE finnor_os.pe_closing_programmes SET controller_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[q.id]);
   assert.equal(await renew(ctx,row,token),false,'an expired controller lease was revived');
  }
  const after=(await admin.query('SELECT finnor_os.pe_closing_cut_digest($1,$2) digest',[q.tenant_id,q.id])).rows[0].digest;
  assert.equal(after,before,'operational lease changed the canonical material cut');
  const budgetAfter=JSON.stringify((await admin.query('SELECT deadline_at,max_steps,max_actions,max_queries,step_count,action_count,query_count FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=(SELECT work_id FROM finnor_os.pe_closing_programmes WHERE id=$2)',[q.tenant_id,q.id])).rows);
  assert.equal(budgetAfter,budgetBefore,'lease renewal changed original business allowance');
  observations.push({case:'lease-fences-and-unchanged-business-cut',staleNonceRefused:true,staleGenerationRefused:true,expiredLeaseRefused:true,materialCutUnchanged:true,budgetUnchanged:true});
  const missing=(await admin.query(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid='finnor_os.pe_closing_programmes'::regclass
    AND a.attnum>0 AND NOT a.attisdropped AND a.attname NOT IN('controller_lease_token','controller_lease_until')
    AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=a.attrelid AND t.tgname='aa_v3_material_statement_fence'
      AND (t.tgtype::int&2)=2 AND (t.tgtype::int&16)=16 AND a.attnum=ANY(t.tgattr::smallint[]))`)).rows;
  assert.deepEqual(missing,[],'Every current business column must retain its before-statement fence');
  const {tx}=await import('../../packages/private-equity/src/owner-context');
  const business=await lockedRead(async()=>{
   try{await tx(ctx,async c=>{await c.query("UPDATE finnor_os.pe_closing_programmes SET generation=generation+1,controller_lease_until=clock_timestamp()+interval '90 seconds' WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id]);throw Error('ROLLBACK_MATERIAL_FENCE_PROBE')});}
   catch(error){if(!(error instanceof Error)||error.message!=='ROLLBACK_MATERIAL_FENCE_PROBE')throw error;}
   return 'ROLLED_BACK';
  });
  assert.equal(business.completedWhileWriterHeld,false,'A mixed material/lease update escaped the business writer');
  assert.equal(business.value,'ROLLED_BACK');
  const restored=(await admin.query('SELECT finnor_os.pe_closing_cut_digest($1,$2) digest',[q.tenant_id,q.id])).rows[0].digest;
  assert.equal(restored,before);
  observations.push({case:'material-update-still-serialized',completedWhileWriterHeld:false,rolledBack:true,missingBusinessColumns:0});
 }
 exit=0;
}catch(error){exit=1;observations.push({case:'failure',message:error instanceof Error?error.message.slice(0,180):'UNKNOWN'});}
finally{
 await closePool?.();if(connected)await admin.end();if(started)await postgres.stop();
 const path='packages/private-equity/src/closing/store.ts',source=await readFile(path);
 const sources=['packages/private-equity/src/closing/store.ts','packages/private-equity/src/closing/worker.ts','packages/private-equity/src/owner-context.ts',
  ...(selected==='lease'?['packages/private-equity/src/closing/controller-lease.ts','packages/db/migrations/postz_zzzz_closing_operational_lease_fences.sql']:[])];
 const inputs=Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
 await writeFile(join(output,'result.json'),JSON.stringify({schema:'finnor.closing-read-contention-e2e.v1',status:exit===0?'PASS':'FAIL',
  sourceSha256:createHash('sha256').update(source).digest('hex'),observations,
  inputs,
  selected,freshCorrection:selected==='fresh-correction'?(exit===0?'PASS':'FAIL'):'NOT_RUN',
  qualification:'ACTUAL_NATIVE_FIXTURE_COPY_ORDINARY_POSTGRES_ROLE_AND_OWNER_READ_NOT_HTTP_OR_PHASE_ACCEPTANCE',
  rerun:'node --import=tsx scripts/v3/closing-read-contention.e2e.mts <original controlled owner directory> <new absolute output>'},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:exit===0?'PASS':'FAIL',observations}));process.exit(exit);
}
