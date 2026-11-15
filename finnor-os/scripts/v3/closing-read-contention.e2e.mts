/** Ordinary-role owner reads against a private copy of the actual native fixture. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const owner=process.argv[2],output=process.argv[3];
const selected=process.argv[4]??'ordinary';
assert(owner?.startsWith('/')&&output?.startsWith('/')&&process.platform==='linux');
assert(['ordinary','fresh-correction'].includes(selected));
const input=JSON.parse(await readFile(join(owner,'runtime-identities.json'),'utf8'));
const original=resolve(input.database.directory);
assert(original.startsWith('/workspace/scratch/')&&original.includes('/finnor-v3-runtime-pg-'));
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
 process.env.DATABASE_URL=`postgres://finnor_app@127.0.0.1:${port}/${input.database.name}`;
 process.env.DOTENV_CONFIG_PATH=join(output,'empty.env');await writeFile(process.env.DOTENV_CONFIG_PATH,'');
 const db=await import('@finnor/db');closePool=db.closePool;
 const {readClosingProgramme}=await import('../../packages/private-equity/src/closing/store');
 const q=(await admin.query('SELECT id,tenant_id,principal_id,transaction_id,last_check_id,status FROM finnor_os.pe_closing_programmes ORDER BY created_at LIMIT 1')).rows[0];assert(q);
 const ctx:any={auth:{tenantId:q.tenant_id,userId:q.principal_id,employeeId:null,role:'owner'}};
 const role=(await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='finnor_app'")).rows[0];
 assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
 const lockedRead=async()=>{
  await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('v3-material-cut:' || $1::uuid::text,0))",[q.tenant_id]);
  let held=true,timer:NodeJS.Timeout|undefined;
  const began=performance.now();
  try{
   const pending=readClosingProgramme(ctx,q.id).then(value=>({value,completedWhileWriterHeld:held,elapsedMs:performance.now()-began}));
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
 exit=0;
}catch(error){exit=1;observations.push({case:'failure',message:error instanceof Error?error.message.slice(0,180):'UNKNOWN'});}
finally{
 await closePool?.();if(connected)await admin.end();if(started)await postgres.stop();
 const path='packages/private-equity/src/closing/store.ts',source=await readFile(path);
 await writeFile(join(output,'result.json'),JSON.stringify({schema:'finnor.closing-read-contention-e2e.v1',status:exit===0?'PASS':'FAIL',
  sourceSha256:createHash('sha256').update(source).digest('hex'),observations,
  selected,freshCorrection:selected==='fresh-correction'?(exit===0?'PASS':'FAIL'):'NOT_RUN',
  qualification:'ACTUAL_NATIVE_FIXTURE_COPY_ORDINARY_POSTGRES_ROLE_AND_OWNER_READ_NOT_HTTP_OR_PHASE_ACCEPTANCE',
  rerun:'node --import=tsx scripts/v3/closing-read-contention.e2e.mts <original controlled owner directory> <new absolute output>'},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:exit===0?'PASS':'FAIL',observations}));process.exit(exit);
}
