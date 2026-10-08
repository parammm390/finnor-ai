/** Failure-first real Work/API/SQL/queue stories. Registered before the joined M4 implementation. */
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {eq,sql} from 'drizzle-orm';
import {closePool, receiveWork, PRODUCTION_JOB_CONTRACTS,withDatabaseExecutionDeadline,
  withGovernedProviderInvocation,queryWithExecutionDeadline,getPool,DatabaseExecutionDeadlineError,
  acquireComputeResourceLeases,releaseComputeResourceLeases,withTenantTransaction,
  withTenantClientTransaction,works} from '@finnor/db';
import {migrate} from '../../packages/db/migrate';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';
import {JobQueue} from '../../apps/worker/src/queue';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {runCapitalProgramJob} from '../../packages/private-equity/src/capital-program/worker';
import {runCounterexampleSearchJob} from '../../packages/private-equity/src/counterexample-search/worker';
import {m3Query} from '../../packages/private-equity/src/capital-program/v2-store';
import {recheckCapitalOwners} from '../../packages/private-equity/src/capital-program/v2-owners';
import {economicDescriptors} from '../../packages/private-equity/src/capital-program/v2-grammar';
import {inM3Episode} from '../../packages/private-equity/src/capital-program/v2-budget';
import {handleCapitalProgramOperation,capitalProgramResponseError} from '../../packages/private-equity/src/capital-program/v2-api';
import {ChallengeError} from '../../packages/private-equity/src/counterexample-search/contracts';
import {capitalProgramResponseError as apiCapitalProgramResponseError,
  handleCapitalProgramOperation as apiHandleCapitalProgramOperation} from '@finnor/private-equity/src/capital-program/v2-api';
import * as challengeService from '../../packages/private-equity/src/counterexample-search/service';
import {writeEvidenceJson} from './evidence.mts';

const repo=resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output=process.env.FINNOR_COMPLETION_B_EVIDENCE_DIR!;
const selection=process.env.FINNOR_COMPLETION_B_CASE_FILTER?.split(',');
const startedAt=new Date().toISOString(),cases:any[]=[],calls:any[]=[],digests:Record<string,string>={};
async function artifact(name:string,value:unknown){
  const path=join(output,name),bytes=await writeEvidenceJson(path,value);
  if(name!=='results.json')digests[name]=createHash('sha256').update(bytes).digest('hex');return path;
}
async function save(){
  await artifact('results.json',{schema:'finnor.completion-b.e2e.v1',startedAt,finishedAt:new Date().toISOString(),
    cases,calls,selection:selection??'FULL_REGISTERED_DEVELOPMENT',unmatchedSelection:selection?.filter(id=>!cases.some(c=>c.id===id))??[],
    evidenceDigests:digests,qualification:'Generated H0/H1 development, real ordinary-role Work/API/queue/owners, no sealed gate or production authority',
    runtime:{node:process.version,platform:process.platform,architecture:process.arch},
    costs:{usd:null,status:'UNMETERED',liveCalls:0},rerunCwd:repo,
    rerun:'python3 finnor-os/scripts/completion-b/run-local.py'+
      (selection?' '+selection.map(id=>"'"+id.replaceAll("'","'\\''")+"'").join(' '):'')});
}
async function challenge(id:string,expected:string,invoke:()=>Promise<unknown>){
  if(selection&&!selection.includes(id))return;
  const begin=performance.now();
  try{
    const observed=await invoke();
    cases.push({id,expected,status:(observed as any)?.contractStatus==='PARTIAL_VALIDATION'?'PARTIAL_VALIDATION':'PASS',observed,elapsedMs:performance.now()-begin});
  }
  catch(error){cases.push({id,expected,status:'FAIL',observed:{message:String(error),stack:(error as Error).stack},elapsedMs:performance.now()-begin});}
  console.log(JSON.stringify({id,status:cases.at(-1).status}));await save();
}
async function api(scope:any,operation:string,body:unknown,handler=POST){
  const begin=performance.now(),response=await handler(new Request(`http://127.0.0.1/api/company-brain/${operation}`,{
    method:'POST',headers:{'content-type':'application/json','x-tenant-id':scope.tenant,'x-user-id':scope.principal},
    body:JSON.stringify(body),
  }),{params:Promise.resolve({operation})});
  const result={status:response.status,body:await response.json() as any};
  calls.push({operation,...result,elapsedMs:performance.now()-begin});return result;
}
function ok(r:any,status=200){assert.equal(r.status,status,JSON.stringify(r));return r.body;}
const dir=await mkdtemp(join(tmpdir(),'finnor-completion-b-'));
const port=await new Promise<number>((yes,no)=>{
  const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(!address||typeof address==='string')return no(Error('PORT_UNAVAILABLE'));
    server.close(()=>yes(address.port));
  });
});
const postgres=new EmbeddedPostgres({databaseDir:dir,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined;
const queue=new JobQueue('completion-b-'+randomUUID(),10);
queue.register('run_capital_program_v2',runCapitalProgramJob,PRODUCTION_JOB_CONTRACTS.run_capital_program_v2);
queue.register('run_counterexample_search_v1',runCounterexampleSearchJob,{protocolVersions:[1],retrySafety:'locally_idempotent'});
let f:any,request:any,program:any,queryId:string,searchId:string,result:any;
async function drain(id:string,operation:string,key:string,readMode?:'ISSUED_HISTORY'){
  let read:any;const timings:any[]=[];
  for(let tick=0;tick<32;tick++){
    const queueStartedAt=new Date().toISOString(),queueStarted=performance.now(),claimed=await queue.tick(),
      queueElapsedMs=performance.now()-queueStarted,readStarted=performance.now();
    const response=await api(f,operation,{[key]:id,...(readMode?{readMode}:{})});
    timings.push({tick,queueStartedAt,claimed,queueElapsedMs,readElapsedMs:performance.now()-readStarted,
      responseStatus:response.status,observedStatus:response.body.status??null,deadlineAt:response.body.deadlineAt??null});
    if(response.status!==200)await artifact('durable/'+id+'-refusal.json',{response,
      jobs:(await admin!.query("SELECT id,status,type,last_error FROM finnor_os.jobs WHERE payload->>'searchId'=$1 OR payload->>'queryId'=$1",[id])).rows,
      query:key==='queryId'?(await admin!.query('SELECT id,status,parent_query_id,result_digest,generation,deadline_at,attempted,generated,refinement_steps,failure FROM finnor_os.m3_queries WHERE id=$1',[id])).rows:[],
      publications:key==='queryId'?(await admin!.query('SELECT query_id,generation,result_digest FROM finnor_os.m3_publications WHERE query_id=$1',[id])).rows:[],
      events:key==='queryId'?(await admin!.query('SELECT attempt_id,kind,body,created_at FROM finnor_os.m3_events WHERE query_id=$1 ORDER BY created_at,id',[id])).rows:[]});
    read=ok(response);
    if(!['QUEUED','RUNNING'].includes(read.status))break;
  }
  await artifact('durable/'+id+'.json',{read,timings,jobs:(await admin!.query(
    "SELECT id,status,type,last_error FROM finnor_os.jobs WHERE payload->>'searchId'=$1 OR payload->>'queryId'=$1",[id])).rows,
    ...(key==='queryId'?{
      query:(await admin!.query('SELECT id,status,parent_query_id,result_digest,generation,deadline_at,attempted,generated,refinement_steps,failure FROM finnor_os.m3_queries WHERE id=$1',[id])).rows,
      events:(await admin!.query("SELECT attempt_id,kind,body-'claimToken' AS body,created_at FROM finnor_os.m3_events WHERE query_id=$1 ORDER BY created_at,id",[id])).rows,
    }:{})});
  return read;
}
async function challengeCurrent(limits:any={}){
  const accepted=ok(await api(f,'challenge-submit',{
    schema:'finnor.m4.challenge-request.v1',workId:f.workId,candidate:program.ref,idempotencyKey:randomUUID(),
    limits:{deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:16,maxWitnesses:16,maxBytes:4194304,...limits},
  }),202);
  const read=await drain(accepted.searchId,'counterexample-read','searchId');
  assert.equal(read.status,'COMPLETED',JSON.stringify(read));return {accepted,read};
}
try{
  await postgres.initialise();await appendFile(join(dir,'postgresql.conf'),'\ntrack_commit_timestamp=on\nmax_wal_size=64MB\nmin_wal_size=32MB\ncheckpoint_timeout=30s\n');
  await postgres.start();await postgres.createDatabase('completion_b');
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/completion_b`;
  await migrate(url);admin=new pg.Client({connectionString:url});await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("SET app.test_vertical_mode='explicit'");
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/completion_b`;await closePool();
  for(const [key,capacity]of [['provider:m1-native',2],['native:p4',2],['provider:m4-native',1]] as const)
    await admin.query(`INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source)
      VALUES($1,$2,$2,0,120,true,'Track B disposable ordinary capacity') ON CONFLICT(resource_key) DO NOTHING`,[key,capacity]);
  const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{
    input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});
  assert.equal(generated.status,0,generated.stderr);
  const day=86400000,support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,
    begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures:{},
    api:(scope:any,operation:string,body:unknown,handler=allocationPost)=>api(scope,operation,body,handler),artifact});
  f=await support.fixture('completion-b-native',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
  const incumbent=await support.policy(f,'incumbent',{cash:25});await support.resource(f,'cash','USD','STOCK',['200','200','200']);
  f.workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Construct and challenge exact current economic proposals without live effects',
    channel:'console',idempotencyKey:randomUUID()})).workId;
  request={schema:'finnor.capital-program-request.v2',workId:f.workId,idempotencyKey:randomUUID(),incumbentPolicyRef:incumbent.ref,purpose:'COMMERCIAL',
    permitted:{actionId:'programme-incumbent',exposureId:'price',unit:'fraction',terms:['0.15','0.3'],startPeriods:[0],
      structures:['IMMEDIATE','STAGED'],stageFractions:['0.5'],resourceRule:'SCALE_REGISTERED_ACTION_LINEAR',agreement:'UNILATERAL_PROPOSAL'},
    resource:{deadlineMs:30000,maxAttempts:8,maxGenerated:64,maxExpansions:50000,maxRefinementSteps:4096,maxRefinementDepth:6,maxModuleBytes:65536,maxResultBytes:8388608}};
  if(selection?.includes('m3-canonical-query-heartbeat'))await challenge('m3-canonical-query-heartbeat',
    'Actual M3 queue registers its exact current claim heartbeat and preserves legitimate publication/ACK, original clocks, costs and business state',async()=>{
      const {m3Heartbeat}=await import('./m3-heartbeat.mts');
      return m3Heartbeat({scope:f,request,admin,api,artifact});
    });
  if(selection?.includes('m3-canonical-heartbeat-cancel'))await challenge('m3-canonical-heartbeat-cancel',
    'Actual running M3 owner cancellation refuses its registered heartbeat and retains fenced costs, unchanged deadline and no publication',async()=>{
      const {m3Heartbeat}=await import('./m3-heartbeat.mts');
      return m3Heartbeat({scope:f,request,admin,api,artifact,cancelAfterRegistration:true});
    });
  if(selection?.includes('pe-orm-client-transaction-correspondence'))await challenge('pe-orm-client-transaction-correspondence',
    'Actual PE wrappers preserve ORM/raw backend, provenance, isolation, reflection, rollback, read-only and SQL deadline guards',async()=>{
      const {peCorrespondence}=await import('./lifecycle-controls.mts');
      return peCorrespondence({scope:f,request,admin,api,artifact});
    });
  if(selection?.includes('m3-live-lifecycle-projection-correspondence'))await challenge('m3-live-lifecycle-projection-correspondence',
    'Actual authenticated M3 lifecycle projection matches the live full row through queue/publication/cancellation and principal refusal',async()=>{
      const {queryLifecycleCorrespondence}=await import('./lifecycle-controls.mts');
      const own=await support.fixture('completion-b-lifecycle',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]),
        incumbent=await support.policy(own,'incumbent',{cash:25});
      await support.resource(own,'cash','USD','STOCK',['200','200','200']);
      own.workId=(await receiveWork({tenantId:own.tenant,userId:own.principal,
        instruction:'Inspect actual lifecycle SQL without changing another test principal',channel:'console',idempotencyKey:randomUUID()})).workId;
      return queryLifecycleCorrespondence({scope:own,request:{...structuredClone(request),workId:own.workId,
        incumbentPolicyRef:incumbent.ref},admin,api,artifact});
    });
  if(selection?.includes('authority-current-discovery-correspondence'))await challenge('authority-current-discovery-correspondence',
    'Actual ordinary-role authority discovery matches the unchanged final authorizer through grants, scopes, revocations and original SQL deadlines without appending decisions',async()=>{
      const {authorityCorrespondence}=await import('./authority-correspondence.mts');
      const own=await support.fixture('completion-b-authority',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
      own.workId=(await receiveWork({tenantId:own.tenant,userId:own.principal,
        instruction:'Inspect current discovery against the final authorizer without changing another story tenant',
        channel:'console',idempotencyKey:randomUUID()})).workId;
      return authorityCorrespondence({scope:own,admin,artifact});
    });
  if(selection?.includes('evidence-atomic-write-correspondence'))await challenge('evidence-atomic-write-correspondence',
    'Actual refused evidence replacement preserves previous complete bytes and restores an owned writer without temporary file leakage',async()=>{
      const {evidenceAtomicCorrespondence}=await import('./evidence-controls.mts');
      return evidenceAtomicCorrespondence(output,artifact);
    });
  await challenge('tenant-orm-client-transaction-correspondence','Raw client and ORM paths share exact RLS, backend, rollback, read-only and deadline semantics',async()=>{
    const observations:any[]=[],rollback=new Error('completion-b-owned-transaction-rollback'),
      before=(await admin!.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[f.workId])).rows[0],
      marker='completion-b-rollback:'+randomUUID();
    await assert.rejects(()=>withTenantTransaction(f.tenant,{userId:f.principal},async(db,client)=>{
      const raw=(await client.query('SELECT pg_backend_pid() pid,current_setting(\'app.tenant_id\') tenant,current_setting(\'app.user_id\') principal')).rows[0],
        orm=(await db.execute(sql`SELECT pg_backend_pid() pid,current_setting('app.tenant_id') tenant,current_setting('app.user_id') principal`)).rows[0];
      assert.deepEqual(orm,raw);assert.equal(raw.tenant,f.tenant);assert.equal(raw.principal,f.principal);
      const relational=await db.query.works.findFirst({where:eq(works.id,f.workId),columns:{id:true,tenantId:true}});
      assert.deepEqual(relational,{id:f.workId,tenantId:f.tenant});
      assert.equal(Reflect.get(db,'$client'),client);
      const prototype=Object.getPrototypeOf(db),keys=Reflect.ownKeys(db),spread={...db};
      assert.equal(prototype.constructor.name,'NodePgDatabase');
      assert(keys.includes('query')&&keys.includes('_')&&keys.includes('$client'));
      assert.equal(Reflect.get(spread,'query'),db.query);
      assert.equal(Object.getOwnPropertyDescriptor(db,'$client')?.value,client);
      const markerKey=Symbol('transaction-local-ORM-descriptor');
      Object.defineProperty(db,markerKey,{value:marker,writable:false,enumerable:false,configurable:false});
      assert.equal(Reflect.get(db,markerKey),marker);
      assert.equal(Object.getOwnPropertyDescriptor(db,markerKey)?.configurable,false);
      assert.equal(Reflect.deleteProperty(db,markerKey),false);
      await db.update(works).set({sessionId:marker}).where(eq(works.id,f.workId));
      assert.equal((await client.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[f.workId])).rows[0].session_id,marker);
      Object.freeze(db);assert(Object.isFrozen(db));assert.equal(Object.getPrototypeOf(db),prototype);
      assert.deepEqual((await db.execute(sql`SELECT pg_backend_pid() pid,current_setting('app.tenant_id') tenant,current_setting('app.user_id') principal`)).rows[0],raw);
      observations.push({guard:'ORM_AND_RAW_SAME_TRANSACTION',raw,relational,uncommittedMutationObserved:true,
        reflection:{prototype:prototype.constructor.name,ownKeys:keys.map(String),spreadSameQuery:true,
          exactScopedClient:true,nonconfigurableSymbol:true,frozenReadSameBackend:true}});
      throw rollback;
    }),error=>error===rollback);
    const after=(await admin!.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[f.workId])).rows[0];
    assert.deepEqual(after,before);observations.push({guard:'ACTUAL_ROLLBACK',unchanged:true});
    const raw=await withTenantClientTransaction(f.tenant,{userId:f.principal,readOnly:true},async client=>
      (await client.query('SELECT id::text,tenant_id::text FROM finnor_os.works WHERE id=$1',[f.workId])).rows);
    assert.deepEqual(raw,[{id:f.workId,tenant_id:f.tenant}]);
    const foreign=await withTenantClientTransaction(randomUUID(),{userId:f.principal,readOnly:true},async client=>
      (await client.query('SELECT id FROM finnor_os.works WHERE id=$1',[f.workId])).rows);
    assert.deepEqual(foreign,[]);observations.push({guard:'FOREIGN_TENANT_RLS',rows:foreign});
    const foreignOrm=await withTenantTransaction(randomUUID(),{userId:f.principal,readOnly:true,isolation:'serializable'},async(db,client)=>{
      const rows=await db.select({id:works.id}).from(works).where(eq(works.id,f.workId));
      const scope=(await client.query("SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only")).rows[0];
      assert.deepEqual(rows,[]);assert.equal(scope.isolation,'serializable');assert.equal(scope.read_only,'on');return {rows,scope};
    });
    observations.push({guard:'ORM_FOREIGN_RLS_ISOLATION_READONLY',...foreignOrm});
    await assert.rejects(()=>withTenantTransaction(f.tenant,{userId:f.principal,readOnly:true},db=>
      db.update(works).set({sessionId:marker}).where(eq(works.id,f.workId))),
      (error:any)=>{const code=error.code??error.cause?.code;observations.push({guard:'ORM_READ_ONLY',code});return code==='25006';});
    await assert.rejects(()=>withDatabaseExecutionDeadline(performance.now()+100,()=>
      withTenantTransaction(f.tenant,{userId:f.principal},async(db,client)=>{
        const raw=(await client.query('SELECT pg_backend_pid() pid')).rows[0];
        assert.equal(Number((await db.execute(sql`SELECT pg_backend_pid() pid`)).rows[0]?.pid),raw.pid);
        await db.execute(sql`SELECT pg_sleep(1)`);
      })),error=>{
        const actual=error instanceof DatabaseExecutionDeadlineError?error:(error as any).cause;
        observations.push({guard:'ORM_ORIGINAL_PHYSICAL_SQL_DEADLINE',name:actual?.name});
        return actual instanceof DatabaseExecutionDeadlineError;
      });
    await assert.rejects(()=>withTenantClientTransaction(f.tenant,{userId:f.principal,readOnly:true},client=>
      client.query('UPDATE finnor_os.works SET session_id=$2 WHERE id=$1',[f.workId,marker])),
      (error:any)=>{observations.push({guard:'READ_ONLY',code:error.code});return error.code==='25006';});
    await assert.rejects(()=>withDatabaseExecutionDeadline(performance.now()+100,()=>
      withTenantClientTransaction(f.tenant,{userId:f.principal},client=>client.query('SELECT pg_sleep(1)'))),
      error=>{observations.push({guard:'ORIGINAL_SQL_DEADLINE',name:(error as Error).name});return error instanceof DatabaseExecutionDeadlineError;});
    const independent=(await admin!.query('SELECT session_id FROM finnor_os.works WHERE id=$1',[f.workId])).rows[0];
    assert.deepEqual(independent,before);
    await artifact('tenant-orm-client-transaction-correspondence.json',{workId:f.workId,observations,independent,
      qualification:'Actual ordinary-role ORM, relational and raw SQL; no evidence or owner-currentness cache'});
    return observations;
  });
  await challenge('challenge-inclusive-transport-deadline','A stalled body is cancelled at the original request deadline, before any submission',async()=>{
    let cancelled=false;
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},
      cancel(){cancelled=true;}});
    const begin=performance.now(),response=await POST(new Request('http://127.0.0.1/api/company-brain/challenge-submit',{
      method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal,'x-challenge-deadline-ms':'100'},
      body,duplex:'half',
    } as RequestInit),{params:Promise.resolve({operation:'challenge-submit'})});
    const observed=await response.json() as any;
    assert.equal(response.status,413);assert.equal(observed.code,'LIMIT_EXCEEDED');assert(cancelled);
    assert(performance.now()-begin<1000);return {observed,cancelled,elapsedMs:performance.now()-begin};
  });
  await challenge('spent-business-clock-releases-only-owned-permit','A real ordinary-role provider releases its exact permit after expiry while ordinary SQL remains deadline-refused',async()=>{
    const ownerId='completion-b-cleanup:'+randomUUID(),started=performance.now(),refusals:any[]=[];
    await withDatabaseExecutionDeadline(performance.now()+150,async()=>{
      await withGovernedProviderInvocation({provider:'m4-native',tenantId:f.tenant,ownerId},async()=>{
        await new Promise(yes=>setTimeout(yes,170));
        await assert.rejects(()=>queryWithExecutionDeadline(getPool(),'SELECT 1'),
          (error:unknown)=>{refusals.push((error as Error).name);return error instanceof DatabaseExecutionDeadlineError;});
      });
      await assert.rejects(()=>queryWithExecutionDeadline(getPool(),'SELECT 1'),
        (error:unknown)=>{refusals.push((error as Error).name);return error instanceof DatabaseExecutionDeadlineError;});
    });
    const leases=(await admin!.query('SELECT resource_key,owner_id,released_at,release_reason FROM finnor_os.compute_resource_leases WHERE owner_id=$1',[ownerId])).rows;
    await artifact('spent-business-clock-permit-cleanup.json',{ownerId,leases,refusals,elapsedMs:performance.now()-started});
    assert.equal(leases.length,1);assert(leases[0].released_at,'An expired business clock stranded the actual owned capacity permit');
    assert.equal(leases[0].release_reason,'invocation_finished');assert.equal(refusals.length,2);
    return {ownerId,leases,refusals,elapsedMs:performance.now()-started};
  });
  await challenge('owned-permit-stale-fence-and-blocked-drain','Stale tokens, fences and owners cannot release a live successor; a blocked cleanup stays bounded and retains its actual lease',async()=>{
    const ownerId='completion-b-release-fence:'+randomUUID(),observed:any[]=[];
    const acquire=()=>acquireComputeResourceLeases({resourceKeys:['provider:m4-native'],
      requiredResourceKeys:['provider:m4-native'],tenantId:f.tenant,workloadClass:'INTERACTIVE',ownerId});
    const previous=await acquire();assert.equal(previous.length,1);
    const predecessor=previous[0];assert(predecessor);
    await releaseComputeResourceLeases(previous,'completion-b-previous-finished');
    const successor=await acquire();assert.equal(successor.length,1);
    const live=successor[0];assert(live);
    assert(live.fence>predecessor.fence);assert.notEqual(live.token,predecessor.token);
    const state=async()=>(await admin!.query(
      'SELECT resource_key,owner_id,lease_token,fence,released_at,release_reason FROM finnor_os.compute_resource_leases WHERE lease_token=$1',
      [live.token])).rows[0];
    try{
      for(const [guard,leases]of [
        ['STALE_PREDECESSOR',previous],
        ['WRONG_TOKEN',[{...live,token:predecessor.token}]],
        ['WRONG_FENCE',[{...live,fence:predecessor.fence}]],
        ['WRONG_OWNER',[{...live,ownerId:ownerId+':foreign'}]],
      ] as const){
        await releaseComputeResourceLeases([...leases],'completion-b-invalid-release');
        const row=await state();assert.equal(row.released_at,null);observed.push({guard,row});
      }
      await admin!.query('BEGIN');
      try{
        await admin!.query('SELECT id FROM finnor_os.compute_resource_leases WHERE lease_token=$1 FOR UPDATE',[live.token]);
        const began=performance.now();
        await assert.rejects(()=>withDatabaseExecutionDeadline(performance.now()-1,
          ()=>releaseComputeResourceLeases(successor,'completion-b-blocked-release')),
          (error:unknown)=>error instanceof DatabaseExecutionDeadlineError);
        const elapsedMs=performance.now()-began,row=await state();
        assert(elapsedMs<2000,'Owned-permit SQL cleanup exceeded its bounded drain');
        assert.equal(row.released_at,null);observed.push({guard:'BLOCKED_DRAIN_RETAINS_LEASE',elapsedMs,row});
      }finally{await admin!.query('ROLLBACK');}
      await new Promise(yes=>setTimeout(yes,100));
      const afterUnlock=await state();observed.push({guard:'NO_LATE_SERVER_RELEASE_AFTER_UNLOCK',row:afterUnlock});
      assert.equal(afterUnlock.released_at,null,'A timed-out cleanup committed after its independent lock was removed');
      await withDatabaseExecutionDeadline(performance.now()-1,async()=>{
        await releaseComputeResourceLeases(successor,'completion-b-owned-release');
        await assert.rejects(()=>queryWithExecutionDeadline(getPool(),'SELECT 1'),
          (error:unknown)=>error instanceof DatabaseExecutionDeadlineError);
      });
      const released=await state();assert(released.released_at);assert.equal(released.release_reason,'completion-b-owned-release');
      observed.push({guard:'EXACT_SUCCESSOR_RELEASE',row:released});
    }finally{
      await artifact('owned-permit-stale-fence-and-blocked-drain.json',{ownerId,previous,successor,observed,
        qualification:'Actual ordinary-role capacity and independent row-lock observer; no business-clock renewal or refunded usage'});
      await releaseComputeResourceLeases(successor,'completion-b-finally-owned-release');
    }
    return {ownerId,observed};
  });
  const accepted=ok(await api(f,'capital-program-submit',request),202);queryId=accepted.queryId;
  const capital=await drain(queryId,'capital-program-read','queryId');assert(capital.program,JSON.stringify(capital));program=capital.program;
  await artifact('input.json',{request,capital,oracle:'Exact immutable current M3 owner publication, not a caller-constructed CapitalProgram'});
  await challenge('absent-original-repair-handle','The ordinary authenticated API returns an opaque typed absence refusal without creating a repair query or job',async()=>{
    const replacement={...request,idempotencyKey:randomUUID(),permitted:{...request.permitted,terms:['0.45']},
      challengeEvidence:[{searchId:randomUUID(),resultRef:{owner:'M4',version:'m4-bounded-original-input-v1',
        id:'challenge-result:'+'a'.repeat(64),contentDigest:'a'.repeat(64)}}]},
      input={queryId,idempotencyKey:replacement.idempotencyKey,replacement},
      before=(await admin!.query('SELECT (SELECT count(*) FROM finnor_os.m3_queries)::int queries,(SELECT count(*) FROM finnor_os.jobs)::int jobs')).rows[0],
      denied=await api(f,'capital-program-recompile',input),diagnostics:any[]=[];
    for(const [route,handle] of [['RELATIVE',handleCapitalProgramOperation],['API_PACKAGE',apiHandleCapitalProgramOperation]] as const){
      try{await inM3Episode(30000,()=>handle(f.ctx,'capital-program-recompile',input));diagnostics.push({route,unexpectedAcceptance:true});}
      catch(error){diagnostics.push({route,name:(error as Error).name,code:(error as {code?:string}).code??null,
        message:(error as Error).message,stack:(error as Error).stack,
        staticChallengeClass:error instanceof ChallengeError,
        mappedCapitalResponse:capitalProgramResponseError(error),mappedApiCapitalResponse:apiCapitalProgramResponseError(error)});}
    }
    const after=(await admin!.query('SELECT (SELECT count(*) FROM finnor_os.m3_queries)::int queries,(SELECT count(*) FROM finnor_os.jobs)::int jobs')).rows[0];
    await artifact('absent-repair-handle.json',{input,denied,before,after,diagnostics,
      capitalMappersIdentical:capitalProgramResponseError===apiCapitalProgramResponseError});
    assert.equal(denied.status,404,JSON.stringify(denied));assert.equal(denied.body.code,'UNAVAILABLE');
    assert.deepEqual(after,before);assert(diagnostics.every(row=>row.code==='UNAVAILABLE'));
    return {denied,before,after,diagnostics};
  });
  await challenge('m3-original-clock-readback','Every durable physical attempt exposes its original SQL deadline as an ISO timestamp, never an empty canonical object',async()=>{
    const row=(await admin!.query('SELECT deadline_at FROM finnor_os.m3_queries WHERE id=$1',[queryId])).rows[0];
    assert(capital.attemptCosts.length>0);
    for(const cost of capital.attemptCosts){
      assert.equal(typeof cost.deadlineAt,'string',JSON.stringify(cost));
      assert.equal(cost.deadlineAt,row.deadline_at.toISOString());
      assert(Number.isFinite(Date.parse(cost.startedAt)));assert(cost.finishedAt&&Number.isFinite(Date.parse(cost.finishedAt)));
    }
    return {attemptCosts:capital.attemptCosts,sqlDeadline:row.deadline_at.toISOString()};
  });
  await challenge('original-m3-challenge-join','Current v2 M3 is challenged through authenticated Work/API/queue, original ChallengeResult not a diagnostic alias',async()=>{
    const ran=await challengeCurrent();searchId=ran.accepted.searchId;result=ran.read.report;
    assert.equal(result.schema,'finnor.m4.challenge-result.v1');assert.deepEqual(result.candidate,program.ref);
    assert(!('target'in result));assert(result.claims.length>0);assert(Array.isArray(result.independentWitnesses));
    for(const field of ['id','tenant','mandateOrChange','work','parents','inputs','rights','owners','producer','runtime','domain','invalidation','computeGrant','costs','state'])
      assert(field in result.envelope,'Missing original envelope field '+field);
    assert.equal(result.executionAuthorityGranted,false);
    assert.equal(ran.read.applicability.status,'CURRENT');return ran;
  });
  await challenge('wrong-candidate-work-version-digest','Wrong M3 Work/version/digest/id and foreign principal refuse before a search job',async()=>{
    const before=Number((await admin!.query('SELECT count(*) n FROM finnor_os.m4_searches')).rows[0].n),rows=[];
    const otherWork=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'A different Work is not candidate authority',channel:'console',idempotencyKey:randomUUID()})).workId;
    for(const patch of [{workId:otherWork},{candidate:{...program.ref,version:'capital-program-v1'}},
      {candidate:{...program.ref,contentDigest:'a'.repeat(64)}},{candidate:{...program.ref,id:'capital-program:'+'b'.repeat(64)}}]){
      const r=await api(f,'challenge-submit',{schema:'finnor.m4.challenge-request.v1',workId:f.workId,candidate:program.ref,
        idempotencyKey:randomUUID(),limits:{deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:16,maxWitnesses:16,maxBytes:4194304},...patch});
      assert([400,404,409].includes(r.status),JSON.stringify(r));assert.notEqual(r.body.code,'PENDING_M3_READER');rows.push(r);
    }
    assert.equal(Number((await admin!.query('SELECT count(*) n FROM finnor_os.m4_searches')).rows[0].n),before);return rows;
  });
  await challenge('challenge-source-claims-not-caller-assertions','Caller cannot replace frozen candidate claims, module inputs, bounds or checker context',async()=>{
    const rows=[];
    for(const field of ['claims','evaluations','domain','module','inputs','acceptance']){
      const r=await api(f,'challenge-submit',{schema:'finnor.m4.challenge-request.v1',workId:f.workId,candidate:program.ref,
        idempotencyKey:randomUUID(),limits:{deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:16,maxWitnesses:16,maxBytes:4194304},
        [field]:[]});
      assert.equal(r.status,400);rows.push(r);
    }return rows;
  });
  await challenge('challenge-new-revision-retains-history','A genuine new M3 revision replaces current use, never mutates the previous challenge/witness, and resolves authentic repair owners',async()=>{
    if(!searchId){const ran=await challengeCurrent();searchId=ran.accepted.searchId;result=ran.read.report;}
    const before=JSON.stringify(result),replacement={...request,idempotencyKey:randomUUID(),permitted:{...request.permitted,terms:['0.2']}};
    const newer=ok(await api(f,'capital-program-recompile',{queryId,idempotencyKey:replacement.idempotencyKey,replacement}),202);
    const next=await drain(newer.queryId,'capital-program-read','queryId');
    const events=(await admin!.query('SELECT attempt_id,kind,body,created_at FROM finnor_os.m3_events WHERE query_id=$1 ORDER BY created_at,id',[newer.queryId])).rows;
    await artifact('revision/'+newer.queryId+'-events.json',events);
    if(!next.program){
      // Diagnose only the failed ordinary owner boundary. This cannot admit a
      // query, replace an owner predicate, or change the worker's disposition.
      const context={auth:{tenantId:f.tenant,userId:f.principal,employeeId:f.principal,role:'owner' as const},
        provenance:{sourceSystem:'completion-b-private-diagnostic',createdBy:f.principal}};
      const diagnostic:Record<string,unknown>={queryId:newer.queryId,read:next};
      try{
        await inM3Episode(30000,async()=>{
          const retained=await m3Query(context,newer.queryId);
          await recheckCapitalOwners(context,retained.request,retained.acceptance);
          diagnostic.ownerRecheck='PASS';
          diagnostic.descriptors=economicDescriptors(retained.request,retained.acceptance.policy,retained.acceptance.model,retained.acceptance.protocols);
        });
      }catch(error){
        diagnostic.fault={name:(error as Error).name,code:(error as {code?:string}).code??null,
          message:(error as Error).message,stack:(error as Error).stack};
      }
      await artifact('revision/'+newer.queryId+'-owner-diagnostic.json',diagnostic);
    }
    assert(next.program,JSON.stringify(next));assert.notDeepEqual(next.program.ref,program.ref);
    const exact=spawnSync(process.env.FINNOR_S3_PYTHON!,['-I','-c',
      "from fractions import Fraction; import json; q=Fraction('25')*Fraction('0.2')/Fraction('0.3'); print(json.dumps({'numerator':q.numerator,'denominator':q.denominator}))"],
      {encoding:'utf8',timeout:1000});
    assert.equal(exact.status,0,exact.stderr);const independentScale=JSON.parse(exact.stdout);
    assert.deepEqual(independentScale,{numerator:50,denominator:3});
    assert(next.program.candidates.some((c:any)=>c.structure==='INCUMBENT'&&c.disposition==='CHECKED_MODEL_RELATIVE'));
    const unsupported=next.program.candidates.filter((c:any)=>c.terms.some((t:any)=>t.after==='0.2'));
    assert(unsupported.length>0);
    for(const c of unsupported){
      assert.equal(c.disposition,'BLOCKED');assert.equal(c.reason,'EXACT_RESOURCE_SCALE_UNREPRESENTABLE');
      assert.equal(c.policyRef,null);assert.equal(c.moduleRef,null);
    }
    await artifact('revision/'+newer.queryId+'-exact-scale.json',{independentScale,unsupported,qualification:'Exact nonterminating resource liability remains unresolved, not rounded or dropped'});
    assert(next.program.envelope.parents.some((p:any)=>p.contentDigest===program.ref.contentDigest));
    const historical=ok(await api(f,'counterexample-read',{searchId}));
    assert.equal(JSON.stringify(historical.report),before);assert.equal(historical.applicability.status,'STALE');
    const refused=await api(f,'challenge-submit',{schema:'finnor.m4.challenge-request.v1',workId:f.workId,candidate:program.ref,
      idempotencyKey:randomUUID(),limits:{deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:16,maxWitnesses:16,maxBytes:4194304}});
    assert.notEqual(refused.status,202);assert.notEqual(refused.body.code,'PENDING_M3_READER');
    return {newer,next,historical,refused};
  });
  await challenge('original-challenge-repair-loop','An original issued ChallengeResult binds a newly constructed M3 child and linked original rechallenge, preserving the old report and remaining parent resources',async()=>{
    const stages:any[]=[],identities:Record<string,string>={},loopStarted=performance.now(),callStart=calls.length;
    const stage=async<T,>(name:string,invoke:()=>Promise<T>)=>{
      const startedAt=new Date().toISOString(),begin=performance.now();let completed=false;
      try{const value=await invoke();completed=true;return value;}
      finally{stages.push({name,startedAt,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-begin,completed});}
    };
    try{
    const initial={...request,idempotencyKey:randomUUID(),permitted:{...request.permitted,terms:['0.15'],structures:['IMMEDIATE']}};
    const initialAccepted=ok(await stage('M3_INITIAL_SUBMIT',()=>api(f,'capital-program-submit',initial)),202);
    identities.initialQueryId=initialAccepted.queryId;
    const initialRead=await stage('M3_INITIAL_QUEUE_AND_CURRENT_READ',()=>drain(initialAccepted.queryId,'capital-program-read','queryId'));assert(initialRead.program);
    assert.deepEqual(initialRead.request,initial,'Authenticated reload omitted the exact accepted economic request');
    assert.equal(initialRead.deadlineAt,initialRead.program.envelope.grant.deadlineAt);
    const limits={deadlineMs:30000,maxTargets:16,maxCells:64,maxTrials:256,maxReductions:0,maxWitnesses:4,maxBytes:4194304};
    const challenged=ok(await stage('M4_ORIGINAL_SUBMIT',()=>api(f,'challenge-submit',{schema:'finnor.m4.challenge-request.v1',workId:f.workId,
      candidate:initialRead.program.ref,idempotencyKey:randomUUID(),limits})),202);
    identities.originalSearchId=challenged.searchId;
    const issued=await stage('M4_ORIGINAL_QUEUE_AND_ISSUED_READ',()=>drain(challenged.searchId,'counterexample-read','searchId','ISSUED_HISTORY'));
    assert.equal(issued.status,'COMPLETED',JSON.stringify(issued));assert.equal(issued.report.schema,'finnor.m4.challenge-result.v1');
    assert.equal(issued.applicability.status,'HISTORICAL_NOT_RECHECKED');
    const originalBytes=JSON.stringify(issued.report),before=(await admin!.query(
      'SELECT attempted,generated,refinement_steps,deadline_at FROM finnor_os.m3_queries WHERE id=$1',[initialAccepted.queryId])).rows[0];
    const replacement={...initial,idempotencyKey:randomUUID(),permitted:{...initial.permitted,terms:['0.45']},
      challengeEvidence:[{searchId:challenged.searchId,resultRef:issued.report.ref}]};
    const acceptedRepair=ok(await stage('M3_CHANGED_CHILD_SUBMIT',()=>api(f,'capital-program-recompile',{queryId:initialAccepted.queryId,
      idempotencyKey:replacement.idempotencyKey,replacement})),202);
    identities.changedQueryId=acceptedRepair.queryId;
    const repaired=await stage('M3_CHANGED_CHILD_QUEUE_AND_CURRENT_READ',()=>drain(acceptedRepair.queryId,'capital-program-read','queryId'));
    assert(repaired.program,JSON.stringify(repaired));
    assert.deepEqual(repaired.request,replacement);
    assert.equal(repaired.deadlineAt,initialRead.deadlineAt,'Repair readback renewed the original construction deadline');
    assert.deepEqual(repaired.program.challengeEvidence,[issued.report.ref]);
    assert(repaired.program.envelope.parents.some((r:any)=>r.contentDigest===issued.report.ref.contentDigest));
    assert(repaired.program.envelope.parents.some((r:any)=>r.contentDigest===initialRead.program.ref.contentDigest));
    assert(repaired.program.candidates.some((c:any)=>c.terms.some((t:any)=>t.after==='0.45')&&c.moduleRef&&c.changedResponseRecomputed));
    const after=(await admin!.query('SELECT attempted,generated,refinement_steps,deadline_at FROM finnor_os.m3_queries WHERE id=$1',[acceptedRepair.queryId])).rows[0];
    assert(after.deadline_at.getTime()<=before.deadline_at.getTime());
    assert(after.deadline_at.getTime()<=Date.parse(issued.deadlineAt));
    assert(before.attempted+after.attempted<=initial.resource.maxAttempts);
    assert(before.refinement_steps+after.refinement_steps<=initial.resource.maxRefinementSteps);
    const rechallengeRequest={schema:'finnor.m4.challenge-request.v1',workId:f.workId,candidate:repaired.program.ref,
      idempotencyKey:randomUUID(),limits};
    const rechallenged=ok(await stage('M4_LINKED_REPAIR_SUBMIT',()=>api(f,'counterexample-repair-request',{searchId:challenged.searchId,replacement:rechallengeRequest})),202);
    identities.linkedSearchId=rechallenged.searchId;
    const checked=await stage('M4_LINKED_QUEUE_AND_CURRENT_READ',()=>drain(rechallenged.searchId,'counterexample-read','searchId'));
    if(checked.status!=='COMPLETED')await artifact('repair-loop-refusal.json',{initialAccepted,initialRead,challenged,issued,
      acceptedRepair,repaired,rechallenged,checked,before,after,
      searches:(await admin!.query('SELECT id,status,parent_search_id,report_digest,trials,deadline_at,created_at FROM finnor_os.m4_searches WHERE id=ANY($1::uuid[])',
        [[challenged.searchId,rechallenged.searchId]])).rows,
      events:(await api(f,'counterexample-ledger',{searchId:rechallenged.searchId,readMode:'ISSUED_HISTORY'})).body});
    assert.equal(checked.status,'COMPLETED',JSON.stringify(checked));assert.equal(checked.report.schema,'finnor.m4.challenge-result.v1');
    assert.deepEqual(checked.report.parentResultRef,issued.report.ref);
    assert.deepEqual(checked.report.candidate,repaired.program.ref);
    assert.equal(checked.deadlineAt,issued.deadlineAt);
    const historical=ok(await api(f,'counterexample-read',{searchId:challenged.searchId}));
    assert.equal(JSON.stringify(historical.report),originalBytes);assert.equal(historical.applicability.status,'STALE');
    assert(checked.trials+issued.trials<=limits.maxTrials);
    // Security controls do not consume the positive path's construction time.
    // They still resolve historical exact evidence and must fail at absence,
    // not rely on an exhausted deadline or create any new query.
    const queryCount=Number((await admin!.query('SELECT count(*) n FROM finnor_os.m3_queries')).rows[0].n),refusals=[];
    for(const patch of [
      {searchId:randomUUID(),resultRef:issued.report.ref},
      {searchId:challenged.searchId,resultRef:{...issued.report.ref,contentDigest:'a'.repeat(64)}},
      {searchId:challenged.searchId,resultRef:{...issued.report.ref,id:'owner-artifact-diagnostic:'+issued.report.ref.contentDigest}},
    ]){
      const negative={...replacement,idempotencyKey:randomUUID(),challengeEvidence:[patch]},
        denied=await api(f,'capital-program-recompile',{queryId:initialAccepted.queryId,idempotencyKey:negative.idempotencyKey,replacement:negative});
      assert.equal(denied.status,404,JSON.stringify(denied));assert.equal(denied.body.code,'UNAVAILABLE');
      refusals.push({patch,denied});
    }
    assert.equal(Number((await admin!.query('SELECT count(*) n FROM finnor_os.m3_queries')).rows[0].n),queryCount);
    await artifact('repair-loop.json',{initialAccepted,initialRead,challenged,issued,acceptedRepair,repaired,rechallenged,checked,historical,
      before,after,refusals,qualification:'Original finite challenge and new economic construction; no fabricated failure, authority or refreshed parent grant'});
    return {initialAccepted,challenged,issuedRef:issued.report.ref,acceptedRepair,repairedRef:repaired.program.ref,rechallenged,
      resultRef:checked.report.ref,result:checked.report.result,before,after,oldReportUnchanged:true};
    }finally{
      await artifact('repair-loop-stage-timings.json',{stages,identities,elapsedMs:performance.now()-loopStarted,
        calls:calls.slice(callStart).map(call=>({operation:call.operation,status:call.status,elapsedMs:call.elapsedMs})),
        originalBudgetsUnchanged:true,completeOwnerReplayRetained:true,
        qualification:'ACTUAL_UNCHANGED_CLOCK_STAGE_OBSERVATIONS_NOT_CONTROLLED_SPEEDUP_OR_GATE_PROOF',usd:null});
    }
  });
  await challenge('issued-evidence-same-invocation-fences','Checked issued evidence is immutable and invocation-local, and live ciphertext, cancellation, principal and retention changes still refuse reuse',async()=>{
    const scoped=(challengeService as unknown as Record<string,any>).withIssuedCapitalChallengeRead;
    assert.equal(typeof scoped,'function','The bounded same-invocation issued-evidence reader is not implemented');
    const sent=ok(await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID(),
      permitted:{...request.permitted,structures:['IMMEDIATE'],terms:['0.15']}}),202);
    const current=await drain(sent.queryId,'capital-program-read','queryId');assert(current.program);
    program=current.program;
    const {accepted,read}=await challengeCurrent({maxReductions:0}),id=accepted.searchId,ref=read.report.ref,observed:any[]=[];
    const before=(await admin!.query('SELECT trials,retained_bytes,deadline_at FROM finnor_os.m4_searches WHERE id=$1',[id])).rows[0];
    const alterTag=async(digest:string,tag:Buffer)=>{
      await admin!.query('BEGIN');
      try{
        await admin!.query('SET LOCAL session_replication_role=replica');
        await admin!.query('UPDATE finnor_os.m4_payloads SET tag=$3 WHERE search_id=$1 AND digest=$2',[id,digest,tag]);
        await admin!.query('COMMIT');
      }catch(error){await admin!.query('ROLLBACK');throw error;}
    };
    const originalExpiry=(await admin!.query('SELECT expires_at FROM finnor_os.m4_searches WHERE id=$1',[id])).rows[0].expires_at;
    const alterExpiry=async(expiresAt:Date)=>{
      await admin!.query('BEGIN');
      try{
        await admin!.query('SET LOCAL session_replication_role=replica');
        await admin!.query('UPDATE finnor_os.m4_searches SET expires_at=$2 WHERE id=$1',[id,expiresAt]);
        await admin!.query('COMMIT');
      }catch(error){await admin!.query('ROLLBACK');throw error;}
    };
    await scoped(async()=>{
      const first=await challengeService.readIssuedCapitalChallenge(f.ctx,id,ref);
      (first.report as any).result='SAFE';
      const unchanged=await challengeService.readIssuedCapitalChallenge(f.ctx,id,ref);
      assert.deepEqual(unchanged.report,read.report);observed.push({guard:'RETURNED_REPORT_MUTATION',result:unchanged.report.result});
      for(const [guard,context,resultRef]of [
        ['FOREIGN_PRINCIPAL',{...f.ctx,auth:{...f.ctx.auth,employeeId:randomUUID(),userId:randomUUID()}},ref],
        ['FORGED_HANDLE',f.ctx,{...ref,contentDigest:'a'.repeat(64)}],
      ] as const){
        await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(context,id,resultRef),
          (error:any)=>{observed.push({guard,code:error.code});return error.code==='UNAVAILABLE';});
      }
      const payloads=(await admin!.query(`SELECT digest,tag FROM finnor_os.m4_payloads
        WHERE search_id=$1 AND digest IN(SELECT frozen_digest FROM finnor_os.m4_searches WHERE id=$1
          UNION ALL SELECT report_digest FROM finnor_os.m4_searches WHERE id=$1)`,[id])).rows;
      assert.equal(payloads.length,2);
      for(const payload of payloads){
        try{
          await alterTag(payload.digest,Buffer.alloc(16));
          await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
            (error:any)=>{observed.push({guard:'LIVE_PAYLOAD_TAG',digest:payload.digest,code:error.code});return error.code==='CHECK_FAILED';});
        }finally{await alterTag(payload.digest,payload.tag);}
      }
      assert.deepEqual((await challengeService.readIssuedCapitalChallenge(f.ctx,id,ref)).report,read.report);
      const originalKey=process.env.FINNOR_M4_STORAGE_KEY,originalKeyId=process.env.FINNOR_M4_STORAGE_KEY_ID;
      try{
        process.env.FINNOR_M4_STORAGE_KEY_ID='disposable-b-rotation-control';
        await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
          (error:any)=>{observed.push({guard:'LIVE_KEY_ID_ROTATION',code:error.code});return error.code==='CHECK_FAILED';});
        process.env.FINNOR_M4_STORAGE_KEY_ID=originalKeyId;
        process.env.FINNOR_M4_STORAGE_KEY=randomBytes(32).toString('base64');
        await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
          (error:any)=>{observed.push({guard:'LIVE_SAME_ID_KEY_ROTATION',code:error.code});return error.code==='CHECK_FAILED';});
      }finally{
        process.env.FINNOR_M4_STORAGE_KEY=originalKey;process.env.FINNOR_M4_STORAGE_KEY_ID=originalKeyId;
      }
      try{
        await alterExpiry(new Date(Date.now()-1000));
        await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
          (error:any)=>{observed.push({guard:'LIVE_RETENTION_EXPIRY',code:error.code});return error.code==='UNAVAILABLE';});
      }finally{await alterExpiry(originalExpiry);}
      assert.deepEqual((await challengeService.readIssuedCapitalChallenge(f.ctx,id,ref)).report,read.report);
    });
    let continueDetached!:()=>void,detached!:Promise<void>;
    const afterScope=new Promise<void>(yes=>{continueDetached=yes;});
    await scoped(async()=>{
      await challengeService.readIssuedCapitalChallenge(f.ctx,id,ref);
      detached=(async()=>{
        await afterScope;
        await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
          (error:any)=>{observed.push({guard:'DETACHED_CLOSED_SCOPE_FULL_AUTHENTICATION',code:error.code});return error.code==='CONFIGURATION_REQUIRED';});
      })();
    });
    const originalKeyId=process.env.FINNOR_M4_STORAGE_KEY_ID;
    try{
      process.env.FINNOR_M4_STORAGE_KEY_ID='disposable-b-detached-control';continueDetached();await detached;
    }finally{process.env.FINNOR_M4_STORAGE_KEY_ID=originalKeyId;}
    await scoped(async()=>{
      await challengeService.readIssuedCapitalChallenge(f.ctx,id,ref);
      ok(await api(f,'counterexample-cancel',{searchId:id}));
      await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
        (error:any)=>{observed.push({guard:'LIVE_CANCELLATION',code:error.code});return error.code==='CANCELLED';});
    });
    await assert.rejects(()=>challengeService.readIssuedCapitalChallenge(f.ctx,id,ref),
      (error:any)=>{observed.push({guard:'NEXT_INVOCATION_CANCELLED',code:error.code});return error.code==='CANCELLED';});
    const after=(await admin!.query('SELECT trials,retained_bytes,deadline_at FROM finnor_os.m4_searches WHERE id=$1',[id])).rows[0];
    assert.equal(after.trials,before.trials);assert.equal(after.deadline_at.getTime(),before.deadline_at.getTime());
    await artifact('issued-evidence-same-invocation-fences.json',{sent,accepted,ref,before,after,observed,
      qualification:'Real ordinary owners/encrypted SQL with disposable independent tag mutation, not cross-request currentness caching'});
    return {sent,accepted,ref,before,after,observed};
  });
  // Restoring user status cannot restore old owner rights pins. Run this last.
  const checkIssuedHistory=async()=>{
    const sent=ok(await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID()}),202);
    const current=await drain(sent.queryId,'capital-program-read','queryId');assert(current.program);program=current.program;
    const {accepted,read}=await challengeCurrent({maxReductions:0}),id=accepted.searchId;
    const accounting=async()=>(await admin!.query(`SELECT trials,retained_bytes,deadline_at,expires_at,
      (SELECT count(*)::int FROM finnor_os.m4_events WHERE search_id=$1) events,
      (SELECT count(*)::int FROM finnor_os.m4_allocations WHERE root_search_id=$1) allocations,
      (SELECT count(*)::int FROM finnor_os.jobs WHERE payload->>'searchId'=$1::text) jobs
      FROM finnor_os.m4_searches WHERE id=$1`,[id])).rows[0];
    const before=await accounting(),historical=ok(await api(f,'counterexample-ledger',{searchId:id,readMode:'ISSUED_HISTORY'}));
    assert.equal(historical.applicability.status,'HISTORICAL_NOT_RECHECKED');
    assert.deepEqual(historical.report,read.report);assert.deepEqual(await accounting(),before);
    const wrongMode=await api(f,'counterexample-read',{searchId:id,readMode:'SAFE'}),
      wrongOperation=await api(f,'counterexample-currentness',{searchId:id,readMode:'ISSUED_HISTORY'}),
      foreign=await api({...f,principal:randomUUID()},'counterexample-read',{searchId:id,readMode:'ISSUED_HISTORY'});
    assert.equal(wrongMode.status,400);assert.equal(wrongOperation.status,400);assert.equal(foreign.status,404);
    const user=(await admin!.query('SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[f.tenant,f.principal])).rows[0];
    let revoked:any;
    try{
      await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[f.tenant,f.principal]);
      revoked=await api(f,'counterexample-read',{searchId:id,readMode:'ISSUED_HISTORY'});
      assert([401,403,404].includes(revoked.status));assert.equal(revoked.body.report,undefined);
    }finally{await admin!.query('UPDATE finnor_os.users SET status=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,f.principal,user.status]);}
    ok(await api(f,'counterexample-cancel',{searchId:id}));
    const cancelled=ok(await api(f,'counterexample-read',{searchId:id,readMode:'ISSUED_HISTORY'}));
    assert.equal(cancelled.applicability.status,'CANCELLED');assert.deepEqual(cancelled.report,read.report);
    // Disposable independent clock advance only, not an application mutation.
    // The original application role still cannot rewrite retention identity.
    await admin!.query('BEGIN');
    try{
      await admin!.query('SET LOCAL session_replication_role=replica');
      await admin!.query("UPDATE finnor_os.m4_searches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
      await admin!.query('COMMIT');
    }catch(error){await admin!.query('ROLLBACK');throw error;}
    const expired=ok(await api(f,'counterexample-read',{searchId:id,readMode:'ISSUED_HISTORY'}));
    assert.equal(expired.applicability.status,'EXPIRED');assert.deepEqual(expired.report,read.report);
    const after=await accounting();
    assert.equal(after.trials,before.trials);assert.equal(after.allocations,before.allocations);
    assert.equal(after.jobs,before.jobs);assert.equal(after.deadline_at.getTime(),before.deadline_at.getTime());
    await artifact('issued-history-rights-and-side-effects.json',{accepted,read,before,historical,wrongMode,wrongOperation,foreign,
      revoked,cancelled,expired,after,qualification:'Retained history is not current applicability, repair admission, a new allowance, or SAFE'});
    return {searchId:id,ref:read.report.ref,before,after,historical:historical.applicability,cancelled:cancelled.applicability,
      expired:expired.applicability,foreignStatus:foreign.status,revokedStatus:revoked.status};
  };
  await challenge('current-capital-read-owner-race','A genuine S5 resource commit during a current M3 read prevents stale programme delivery',async()=>{
    const sent=ok(await api(f,'capital-program-submit',{...request,idempotencyKey:randomUUID()}),202),
      current=await drain(sent.queryId,'capital-program-read','queryId');
    assert(current.program);
    const began=performance.now();let readFinished:number|null=null;
    const reading=api(f,'capital-program-read',{queryId:sent.queryId}).then(value=>{readFinished=performance.now();return value;});
    await new Promise(yes=>setTimeout(yes,25));
    const {ref:expectedRef,revision:_revision,priorRef:_prior,...resource}=f.resources[0],
      changed=ok(await api(f,'resource',{expectedRef,resource:{...resource,
        availability:resource.availability.map((entry:any)=>({...entry,amount:'175'}))}},allocationPost)),
      mutated=performance.now(),observed=await reading,finished=readFinished!;
    await artifact('current-capital-read-owner-race.json',{sent,current,changed,observed,
      timing:{began,mutated,finished},qualification:'Real ordinary S5 mutation and API current-read fence, not a cached currentness flag'});
    assert(mutated<finished,'The fixture did not commit its real mutation during the current read');
    assert.equal(observed.status,200);assert.equal(observed.body.status,'INVALIDATED');assert.equal(observed.body.program,null);
    f.resources[0]=changed;
    return {sent,changed,observed,timing:{began,mutated,finished}};
  });
  await challenge('frozen-original-owner-change','A real S5 owner revision after original freeze refuses checking while retaining the immutable candidate and original deadline',async()=>{
    const initial={...request,idempotencyKey:randomUUID()};
    const sent=ok(await api(f,'capital-program-submit',initial),202),current=await drain(sent.queryId,'capital-program-read','queryId');
    assert(current.program);
    const limits={deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:16,maxWitnesses:16,maxBytes:4194304};
    const challenged=ok(await api(f,'challenge-submit',{schema:'finnor.m4.challenge-request.v1',workId:f.workId,
      candidate:current.program.ref,idempotencyKey:randomUUID(),limits}),202);
    const before=(await admin!.query('SELECT deadline_at,frozen_digest FROM finnor_os.m4_searches WHERE id=$1',[challenged.searchId])).rows[0];
    const {ref:expectedRef,revision:_revision,priorRef:_prior,...resource}=f.resources[0];
    const changed=ok(await api(f,'resource',{expectedRef,resource:{...resource,
      availability:resource.availability.map((entry:any)=>({...entry,amount:'150'}))}},allocationPost));
    await queue.tick();
    const observed=ok(await api(f,'counterexample-ledger',{searchId:challenged.searchId}));
    await artifact('frozen-original-owner-change.json',{sent,current,challenged,before,changed,observed});
    assert(['STALE','FAILED'].includes(observed.status),JSON.stringify(observed));
    assert.equal(observed.trials,0);assert.equal(observed.report,null);
    assert.equal(observed.deadlineAt,before.deadline_at.toISOString());
    assert(observed.ledger.some((e:any)=>e.kind==='FAILED'));
    return {challenged,changed,observed};
  });
  await challenge('issued-history-rights-and-side-effects','Explicit issued history preserves exact encrypted reports without currentness, trial debit, new grants, or revoked access',checkIssuedHistory);
  if(selection?.includes('mounted-original-challenge-repair-loop'))await challenge('mounted-original-challenge-repair-loop',
    'Trusted mounted Work/Canvas/proxy/authentication constructs an original challenge, changed economic repair and exact linked rechallenge with unchanged clocks and current owner witnesses',
    async()=>{
      const {mountedOriginalChallenge}=await import('./browser.mts');
      return mountedOriginalChallenge({repo,output,support,admin,queue,api,artifact});
    });
}catch(error){
  cases.push({id:'bootstrap',status:'FAIL',expected:'Actual disposable owner/SQL/worker closure',observed:{message:String(error),stack:(error as Error).stack}});
}finally{
  try{await save();}
  finally{
    try{await closePool();}
    finally{try{await admin?.end();}finally{await postgres.stop();}}
  }
}
process.exit(cases.length&&cases.every(c=>c.status==='PASS')?0:1);
