/** Real disposable canonical DB/Work/API/queue. No owner receipt is mocked. */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdtemp,realpath,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrate} from '../../packages/db/migrate';
import {closePool,configureTenantVertical,receiveWork,attachWorkEntity} from '@finnor/db';
import {physicalNativeQueue} from './native-worker-client.mts';
import {ownDisposablePostgres,closeDisposablePostgres} from '../postz-w1/disposable-postgres.mjs';
export async function nativeFixture(){
 process.env.NODE_ENV='test';process.env.AUTH_DEV_BYPASS='1';
 process.env.FINNOR_P4_PROFILE='ordinary_disposable';
 process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';
 const directory=await realpath(await mkdtemp(join(tmpdir(),'p5-native-db-')));
 const disposable=ownDisposablePostgres(directory,directory,process.env.FINNOR_P5_EVIDENCE_DIR
  ?join(process.env.FINNOR_P5_EVIDENCE_DIR,'disposable-postgres-cleanup.json'):undefined);
 let admin:pg.Client|undefined;
 let queue:Awaited<ReturnType<typeof physicalNativeQueue>>|undefined;
 try{
  const port=await new Promise<number>((yes,no)=>{const socket=createServer();socket.once('error',no);socket.listen(0,'127.0.0.1',()=>{const address=socket.address();if(!address||typeof address==='string')return no(Error('PORT_UNAVAILABLE'));socket.close(()=>yes(address.port));});});
  const database=disposable.attach(new EmbeddedPostgres({databaseDir:directory,user:'p5_test',password:'p5_test',port,persistent:true,onLog:()=>{}}));
  await database.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await database.start();await database.createDatabase('p5_test');
  const url=`postgres://p5_test:p5_test@127.0.0.1:${port}/p5_test`;
  const migrations=await migrate(url);
  admin=new pg.Client({connectionString:url});await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'p5_disposable'");
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'p5_disposable_worker'");
  await admin.query("SET app.test_vertical_mode='explicit'");
  const tenant=randomUUID(),actor=randomUUID(),foreignTenant=randomUUID(),foreignActor=randomUUID(),company=randomUUID();
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P5 disposable'),($3,$4,'P5 foreign')",[tenant,randomUUID(),foreignTenant,randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P5 owner'),($4,$5,$6,'owner','active','Foreign owner')",[actor,tenant,actor+'@test.invalid',foreignActor,foreignTenant,foreignActor+'@test.invalid']);
  await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'p5-target-company','P5 company','other')",[company,tenant]);
  await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p5',2,2,0,60,'explicit local P5 development capacity, not S5 funding')");
  process.env.DATABASE_URL=`postgres://finnor_app:p5_disposable@127.0.0.1:${port}/p5_test`;await closePool();
  process.env.FINNOR_P5_WORKER_DATABASE_URL=`postgres://finnor_worker:p5_disposable_worker@127.0.0.1:${port}/p5_test`;
  await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:actor,sourceSystem:'P5:test'});
  await configureTenantVertical({tenantId:foreignTenant,verticalKey:'private_equity',expectedVersion:0,createdBy:foreignActor,sourceSystem:'P5:test'});
  const root={entityType:'external_organization' as const,entityId:company};
  const post=(await import('../../apps/api/app/api/company-brain/[operation]/route')).POST;
  const api=async(operation:string,body:unknown,identity={tenant,actor})=>{
   const r=await post(new Request('http://localhost/api/company-brain/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':identity.tenant,'x-user-id':identity.actor},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});
   return {status:r.status,body:await r.json() as any};
  };
  queue=await physicalNativeQueue(process.env.FINNOR_P5_WORKER_DATABASE_URL,process.env.FINNOR_P5_EVIDENCE_DIR??directory);
  const work=async(origin:string,substrate='API',instruction='Acquire permitted disposable lender interface, no live business effect')=>{
   const intake=await receiveWork({tenantId:tenant,userId:actor,instruction,
    channel:'console',idempotencyKey:'p5:'+randomUUID(),activeContext:root,authorityContext:{principalId:actor,producer:'P5_NONCONSEQUENTIAL'}});
   await attachWorkEntity(tenant,intake.workId,{...root,source:'P5:original-acquisition'});
   const accessId=randomUUID();
   await admin!.query("INSERT INTO finnor_os.p5_test_access(id,tenant_id,principal_id,work_id,origin,account,document_path,ui_path,rights_ref,valid_until,permit_practice) VALUES($1,$2,$3,$4,$5,'test-account','/docs',$6,'EXPLICIT_DISPOSABLE_TEST_ACCESS',clock_timestamp()+interval '3 minutes',true)",[accessId,tenant,actor,intake.workId,origin,substrate==='UI'?'/ui':null]);
   return {...intake,accessId};
  };
  const finish=async(id:string)=>{
   for(let i=0;i<12;i++){
    await queue!.tick();const r=await api('interface-read',{acquisitionId:id});
    if(r.status!==200)throw Error('CURRENT_READER_FAILED:'+JSON.stringify(r));
    if(['PROTOTYPE','PRACTICED','SUPPORTED_DISPOSABLE','UNKNOWN','DISCREPANCY','FAILED','CANCELLED','QUARANTINED'].includes(r.body.status))return r.body;
   }
   throw Error('QUEUE_DID_NOT_COMPLETE');
  };
  return {admin,database,directory,tenant,actor,foreignTenant,foreignActor,root,migrations,api,queue,work,finish,
   close:async()=>closeDisposablePostgres(disposable,[()=>queue!.close(),closePool,()=>admin!.end()])};
 }catch(error){
  try{await closeDisposablePostgres(disposable,[async()=>queue?.close(),closePool,async()=>admin?.end()]);}
  catch(cleanupError){throw new AggregateError([error,cleanupError],'P5_FIXTURE_SETUP_AND_CLEANUP_FAILED');}
  throw error;
 }
}
