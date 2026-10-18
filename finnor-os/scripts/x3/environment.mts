/** Disposable installed-boundary driver. No product routes, identity or queue
 * behavior are replaced. Credentials remain in memory, never in evidence. */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {strict as assert} from 'node:assert';
import {migrate} from '../../packages/db/migrate';
import {closePool} from '@finnor/db';
import {startR1HttpFixture} from '../r1/http-fixture.mts';

export const repo=resolve(import.meta.dirname,'../../..');
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function artifact(directory:string,name:string,value:unknown){
 const path=join(directory,name);await mkdir(resolve(path,'..'),{recursive:true});
 await writeFile(path,JSON.stringify(value,null,2)+'\n');
}
export async function startEnvironment(evidence:string,options:{builtApi?:boolean;migrationsOnly?:boolean}={}){
 await mkdir(evidence,{recursive:true});
 process.env.NODE_ENV='test';process.env.AUTH_DEV_BYPASS='0';
 process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';process.env.FINNOR_P4_PROFILE='ordinary_disposable';
 process.env.FINNOR_ENVIRONMENT='ordinary_disposable';
 const directory=await mkdtemp(join(tmpdir(),'finnor-x3-')),password=randomBytes(24).toString('hex');
 const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return no(Error('X3_LOCAL_PORT'));s.close(()=>yes(a.port));});});
 const postgres=new EmbeddedPostgres({databaseDir:directory,user:'x3_admin',password,port,persistent:false,onLog:()=>undefined});
 let admin:pg.Client|undefined,http:Awaited<ReturnType<typeof startR1HttpFixture>>|undefined,started=false;
 const close=async()=>{
  await http?.close();await closePool();await admin?.end();
  if(started)await postgres.stop();
  await artifact(evidence,'database-lifecycle.json',{profile:'DISPOSABLE_LOCAL_POSTGRESQL',directory,port,status:'STOPPED',hostedQualification:false});
 };
 try{
  await postgres.initialise();await postgres.start();started=true;await postgres.createDatabase('x3_e2e');
  const adminUrl=`postgres://x3_admin:${password}@127.0.0.1:${port}/x3_e2e`;
  const migrations=join(repo,'finnor-os/packages/db/migrations');
  const files=await Promise.all((await readdir(migrations)).filter(p=>p.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(join(migrations,name),'utf8')})));
  const prefix=files.filter(f=>f.name<='0188_observation_source_version_binding.sql');
  assert.equal(prefix.at(-1)?.name,'0188_observation_source_version_binding.sql');
  const prior=await migrate(adminUrl,prefix);
  admin=new pg.Client({connectionString:adminUrl});await admin.connect();
  await admin.query("SET app.test_vertical_mode='explicit'");
  const old=(await admin.query("INSERT INTO finnor_os.jobs(type,payload,idempotency_key,protocol_version,max_attempts) VALUES('release_probe','{}'::jsonb,'x3-retained-prior-job',1,1) RETURNING id,type,payload,status,protocol_version,attempts,claim_fence")).rows[0];
  const upgrade=await migrate(adminUrl,files),replay=await migrate(adminUrl,files);
  const retained=(await admin.query('SELECT id,type,payload,status,protocol_version,attempts,claim_fence FROM finnor_os.jobs WHERE id=$1',[old.id])).rows[0];
  assert.deepEqual(retained,old);assert.deepEqual(replay,[]);
  assert.deepEqual(upgrade,files.filter(f=>!prefix.some(p=>p.name===f.name)).map(f=>f.name));
  await artifact(evidence,'migration-upgrade-replay.json',{prior,upgrade,replay,old,retained,files:files.map(f=>({name:f.name,sha256:hash(f.sql)})),allPassed:true});
  const appPassword=randomBytes(24).toString('hex'),workerPassword=randomBytes(24).toString('hex');
  // Values are generated hexadecimal credentials, not user-controlled SQL.
  await admin.query(`ALTER ROLE finnor_app LOGIN PASSWORD '${appPassword}'`);
  await admin.query(`ALTER ROLE finnor_worker LOGIN PASSWORD '${workerPassword}'`);
  const appUrl=`postgres://finnor_app:${appPassword}@127.0.0.1:${port}/x3_e2e`;
  const workerUrl=`postgres://finnor_worker:${workerPassword}@127.0.0.1:${port}/x3_e2e`;
  process.env.DATABASE_URL=appUrl;await closePool();
  const roles=(await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname")).rows;
  assert.equal(roles.length,2);assert(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
  await artifact(evidence,'database-lifecycle.json',{profile:'DISPOSABLE_LOCAL_POSTGRESQL',directory,port,status:'RUNNING',roles,hostedQualification:false});
  if(!options.migrationsOnly)http=await startR1HttpFixture(repo,evidence,{builtApi:options.builtApi});
  return {admin,http,workerUrl,appUrl,adminUrl,directory,port,close};
 }catch(error){await close().catch(()=>undefined);throw error;}
}
