import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {appendFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {migrate} from '../../packages/db/migrate';
import {closePool} from '@finnor/db';
export async function disposablePlatform(options:{preserveDirectory?:boolean}={}){
 process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';process.env.NODE_ENV='test';process.env.FINNOR_V2_PROFILE='ordinary_disposable';process.env.AUTH_DEV_BYPASS='0';
 const directory=await mkdtemp(join(tmpdir(),'finnor-v2-owned-')),server=createServer();
 const port=await new Promise<number>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')return no(Error('OWNED_PORT_REQUIRED'));server.close(()=>yes(a.port));});});
 const postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:options.preserveDirectory??false,onLog:()=>undefined});
 let admin:pg.Client|undefined;
 try{
  await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('v2_e2e');
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/v2_e2e`,applied=await migrate(url);
  admin=new pg.Client({connectionString:url});await admin.connect();await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'");await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p4',2,2,0,60,'explicit disposable V2 source/checker E2E, not production capacity')");
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/v2_e2e`;await closePool();
  const workerUrl=`postgres://finnor_worker:finnor_worker@127.0.0.1:${port}/v2_e2e`;
  return {admin,applied,directory,url,workerUrl,close:async()=>{await closePool();await admin!.end();await postgres.stop();if(!options.preserveDirectory)await rm(directory,{recursive:true,force:true});}};
 }catch(error){await admin?.end().catch(()=>undefined);await postgres.stop().catch(()=>undefined);if(!options.preserveDirectory)await rm(directory,{recursive:true,force:true});throw error;}
}
