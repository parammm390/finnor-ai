/** Task-owned, ordinary-role PostgreSQL fixture. It never changes Y3 assets. */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {appendFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,statfs,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {strict as assert} from 'node:assert';
import {migrate} from '../../packages/db/migrate';
import {closePool} from '@finnor/db';

const repo=resolve(import.meta.dirname,'../../..');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function artifact(directory:string,name:string,value:unknown){
 const path=join(directory,name);await mkdir(resolve(path,'..'),{recursive:true});
 await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
}
async function nativeLibraries(evidence:string){
 const configured=process.env.FINNOR_Y4_POSTGRES_PACKAGE;
 if(!configured||!isAbsolute(configured))throw Error('Y4_EXPLICIT_TASK_POSTGRES_PACKAGE_REQUIRED');
 const root=await realpath(configured),library=join(root,'native/lib');
 const links=join(evidence,'PRIVATE-NOT-FOR-HANDOFF','postgres-library-links');
 await mkdir(links,{mode:0o700});
 const metadata=JSON.parse(await readFile(join(root,'native/pg-symlinks.json'),'utf8')) as Array<{source:string;target:string}>;
 const files:Array<{name:string;bytes:number;sha256:string}>=[];
 for(const entry of metadata){
  const original=resolve(root,entry.source),target=resolve(root,entry.target);
  if(!original.startsWith(library+'/')||!target.startsWith(library+'/')
   ||relative(library,target).includes('/')||!(await lstat(original)).isFile())
   throw Error('Y4_CONTAINED_REGULAR_POSTGRES_LIBRARY_REQUIRED');
  const name=relative(library,target),bytes=await readFile(original);
  await symlink(original,join(links,name));
  files.push({name,bytes:bytes.length,sha256:hash(bytes)});
 }
 process.env.LD_LIBRARY_PATH=[links,library].join(':');
 await artifact(evidence,'postgres-library-closure.json',{schema:'finnor.y4.disposable-postgres-libraries.v1',
  files,materialization:'TASK_LOCAL_LINKS_NOT_INDEPENDENT',productionRuntime:false});
}
export async function startEnvironment(evidence:string,options:{migrationsOnly?:boolean;baseHead?:string}={}){
 await nativeLibraries(evidence);
 Object.assign(process.env,{NODE_ENV:'test',AUTH_DEV_BYPASS:'0'});
 process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';process.env.FINNOR_P4_PROFILE='ordinary_disposable';
 process.env.FINNOR_ENVIRONMENT='ordinary_disposable';
 const capacity=await statfs(tmpdir());
 if(Number(capacity.bavail)*Number(capacity.bsize)<64*1024*1024)throw Error('Y4_DISPOSABLE_DATABASE_CAPACITY_UNAVAILABLE');
 const directory=await mkdtemp(join(tmpdir(),'finnor-y4-')),password=randomBytes(24).toString('hex');
 const port=await new Promise<number>((yes,no)=>{
  const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{
   const address=server.address();if(!address||typeof address==='string')return no(Error('Y4_LOCAL_PORT_REQUIRED'));
   server.close(()=>yes(address.port));
  });
 });
 let logBytes=0;
 const onLog=(message:string)=>{
  const clean=message.replace(/postgres(?:ql)?:\/\/[^\s)]+/g,'[DATABASE_URL_REDACTED]')
   .replace(/PASSWORD\s+'[^']*'/gi,"PASSWORD '[REDACTED]'");
  logBytes+=Buffer.byteLength(clean);
  if(logBytes<=1024*1024)void appendFile(join(evidence,'PRIVATE-NOT-FOR-HANDOFF','postgres.log'),clean,{mode:0o600}).catch(()=>undefined);
 };
 const postgres=new EmbeddedPostgres({databaseDir:directory,user:'y4_admin',password,port,persistent:false,
  authMethod:'scram-sha-256',initdbFlags:['--wal-segsize=1'],
  postgresFlags:['-h','127.0.0.1','-k',directory,'-c','max_wal_size=16MB','-c','min_wal_size=2MB','-c','shared_buffers=16MB'],
  onLog,onError:()=>undefined});
 let admin:pg.Client|undefined,started=false,closed=false;
 const close=async()=>{
  if(closed)return;closed=true;
  await closePool();await admin?.end();
  if(started)await postgres.stop();
  await artifact(evidence,'database-lifecycle.json',{profile:'DISPOSABLE_LOCAL_POSTGRESQL',directory,port,status:'STOPPED',
   cleanupScope:'ONLY_THIS_INVOCATION_GENERATED_CLUSTER',hostedQualification:false});
 };
 try{
  await postgres.initialise();await postgres.start();started=true;await postgres.createDatabase('y4_e2e');
  const adminUrl=`postgres://y4_admin:${password}@127.0.0.1:${port}/y4_e2e`;
  const migrations=join(repo,'finnor-os/packages/db/migrations');
  const files=await Promise.all((await readdir(migrations)).filter(p=>p.endsWith('.sql')).sort()
   .map(async name=>({name,sql:await readFile(join(migrations,name),'utf8')})));
  const baseHead=options.baseHead??'0188_observation_source_version_binding.sql',prefix=files.filter(f=>f.name<=baseHead);
  assert.equal(prefix.at(-1)?.name,baseHead);
  const prior=await migrate(adminUrl,prefix);
  admin=new pg.Client({connectionString:adminUrl});await admin.connect();
  await admin.query("SET app.test_vertical_mode='explicit'");
  const old=(await admin.query(`INSERT INTO finnor_os.jobs(type,payload,idempotency_key,protocol_version,max_attempts)
   VALUES('release_probe','{}'::jsonb,'y4-retained-prior-job',1,1)
   RETURNING id,type,payload,status,protocol_version,attempts,claim_fence`)).rows[0];
  const historyTenant=randomUUID(),historyUser=randomUUID(),historyWork=randomUUID();
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y4 retained query history')",[historyTenant,randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Historical fixture')",
   [historyUser,historyTenant,historyUser+'@test.invalid']);
  await admin.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[historyTenant,historyUser]);
  await admin.query("SELECT finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'Y4:retained-history',NULL)",[historyTenant,historyUser]);
  await admin.query("INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by) VALUES($1,$2,'completed','console','Retained immutable query evidence',$3)",
   [historyWork,historyTenant,historyUser]);
  await admin.query(`INSERT INTO finnor_os.work_query_executions(tenant_id,work_id,intent,execution_key,status,result_summary)
   SELECT $1,$2,intent,'historical:intent:'||intent,'succeeded','{}'::jsonb
    FROM unnest(ARRAY['business_state','customer_lookup','inventory_status','money_summary','schedule_range']) intent`,
   [historyTenant,historyWork]);
  const historyBefore=(await admin.query('SELECT * FROM finnor_os.work_query_executions WHERE work_id=$1 ORDER BY intent',[historyWork])).rows;
  await admin.query("SELECT set_config('app.tenant_id','',false),set_config('app.user_id','',false)");
  const upgrade=await migrate(adminUrl,files),replay=await migrate(adminUrl,files);
  const retained=(await admin.query('SELECT id,type,payload,status,protocol_version,attempts,claim_fence FROM finnor_os.jobs WHERE id=$1',[old.id])).rows[0];
  assert.deepEqual(retained,old);assert.deepEqual(replay,[]);
  assert.deepEqual(upgrade,files.filter(f=>!prefix.some(p=>p.name===f.name)).map(f=>f.name));
  const historyAfter=(await admin.query('SELECT * FROM finnor_os.work_query_executions WHERE work_id=$1 ORDER BY intent',[historyWork])).rows;
  assert.deepEqual(historyAfter,historyBefore);
  assert.equal((await admin.query("SELECT convalidated FROM pg_constraint WHERE conrelid='finnor_os.work_query_executions'::regclass AND conname='work_query_executions_intent_check'")).rows[0].convalidated,true);
  await artifact(evidence,'migration-upgrade-replay.json',{prior,upgrade,replay,old,retained,
   retainedHistoricalQueryRows:historyAfter.length,historicalQueryRowsUnchanged:true,queryHistoryConstraintValidated:true,
   files:files.map(f=>({name:f.name,sha256:hash(f.sql)})),allPassed:true,managedExtensionsOmitted:true});
  const appPassword=randomBytes(24).toString('hex'),workerPassword=randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE finnor_app LOGIN PASSWORD '${appPassword}'`);
  await admin.query(`ALTER ROLE finnor_worker LOGIN PASSWORD '${workerPassword}'`);
  const appUrl=`postgres://finnor_app:${appPassword}@127.0.0.1:${port}/y4_e2e`;
  const workerUrl=`postgres://finnor_worker:${workerPassword}@127.0.0.1:${port}/y4_e2e`;
  process.env.DATABASE_URL=appUrl;await closePool();
  const roles=(await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname")).rows;
  assert.equal(roles.length,2);assert(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
  await artifact(evidence,'database-lifecycle.json',{profile:'DISPOSABLE_LOCAL_POSTGRESQL',directory,port,status:'RUNNING',roles,
   walSegmentMiB:1,fsyncDisabled:false,hostedQualification:false});
  return {admin,workerUrl,appUrl,adminUrl,directory,port,close};
 }catch(error){await close().catch(()=>undefined);throw error;}
}
