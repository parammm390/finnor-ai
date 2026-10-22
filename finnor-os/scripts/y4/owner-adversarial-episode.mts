/** Actual native commit barrier, never a production hook or fixture status. */
import {strict as assert} from 'node:assert';
import pg from 'pg';
import {artifact} from './environment.mjs';
const delay=(ms:number)=>new Promise(yes=>setTimeout(yes,ms));
const tables=['s5_proposals','s5_reservation_origins','s5_reservations','s5_consumptions',
 's5_consumption_states','s5_history','s6_obligation_origins','s6_owner_delivery_origins',
 's6_owner_delivery_states','domain_actions','business_effects'];
export async function ownerResponsibilitySnapshot(admin:any,tenant:string){
 const result:Record<string,unknown>={};
 for(const table of tables)result[table]=(await admin.query(
  `SELECT COALESCE(jsonb_agg(body ORDER BY body::text),'[]'::jsonb) body FROM
   (SELECT to_jsonb(t) body FROM finnor_os.${table} t WHERE tenant_id=$1) rows`,[tenant])).rows[0].body;
 return result;
}
export async function revokeAtNativeS6Commit(input:{
 appUrl:string;admin:any;tenant:string;principal:string;pending:unknown;evidence:string;privateDirectory:string;
 ownerCall:(owner:string,operation:string,body:unknown)=>Promise<any>;revoke:()=>Promise<unknown>;
}){
 const clients=[new pg.Client({connectionString:input.appUrl}),new pg.Client({connectionString:input.appUrl})];
 let active=0,finished=false,failure:unknown,response:any,pending:Promise<void>|undefined,
  revoking:Promise<void>|undefined,revocationFinished=false,revocationFailure:unknown;
 const barrier:number[]=[],steps:Array<{pid:number;query:string;portfolio:boolean}>=[];
 const stopAt=Date.now()+18000;
 try{
  for(const c of clients){
   await c.connect();
   await c.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",
    [input.tenant,input.principal]);
  await c.query("SET statement_timeout='8000ms'");
   barrier.push((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  }
  const begin=async(c:pg.Client)=>{await c.query('BEGIN');};
  const lock=(c:pg.Client)=>c.query('SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
   [input.tenant,input.principal]);
  await begin(clients[0]!);await lock(clients[0]!);
  pending=input.ownerCall('obligations','prepare',input.pending).then(
   r=>{response=r;finished=true;},e=>{failure=e;finished=true;});
  const waiters=async()=>(await input.admin.query(`SELECT a.pid,a.query,
    EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted
     AND l.classid::bigint=((hashtextextended($2,0)>>32)&4294967295)
     AND l.objid::bigint=(hashtextextended($2,0)&4294967295) AND l.objsubid=1) portfolio,
    EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted
     AND l.classid::bigint=((hashtextextended($3,5510)>>32)&4294967295)
     AND l.objid::bigint=(hashtextextended($3,5510)&4294967295) AND l.objsubid=1) source_mutex
    FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type='Lock'`,
    [barrier[active],`s5-portfolio:${input.tenant}`,input.tenant])).rows;
  let final:any,revoker:any;
  while(Date.now()<stopAt&&!finished){
   const blocked=await waiters();
   const waiter=blocked.find((r:any)=>!barrier.includes(r.pid));
   if(!waiter){await delay(5);continue;}
   steps.push(waiter);
   if(waiter.portfolio&&waiter.query==="SELECT id FROM finnor_os.users WHERE id=$1 AND tenant_id=$2 AND role='owner' AND status='active' FOR SHARE"){
    final=waiter;break;
   }
   const next=1-active;
   await begin(clients[next]!);
   // Queue the next exclusive lock behind this already observed native reader.
   // PostgreSQL grants that reader first, then our next barrier before later readers.
   const acquiring=lock(clients[next]!);
   let queued=false;
   while(Date.now()<stopAt){
    const b=(await input.admin.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[barrier[next]])).rows[0];
    if(b.blocked){queued=true;break;}
    await delay(5);
   }
   assert(queued,'Y4_NEXT_NATIVE_COMMIT_BARRIER_NOT_QUEUED');
   await clients[active]!.query('COMMIT');
   await acquiring;active=next;
  }
  assert(final&&!finished,'Y4_FINAL_S6_COMMIT_BARRIER_NOT_OBSERVED');
  const before=await ownerResponsibilitySnapshot(input.admin,input.tenant);
  revoking=input.revoke().then(()=>{revocationFinished=true;},error=>{
   revocationFailure=error;revocationFinished=true;
  });
  // Revocation also checks original owner authority. Observe its source mutex
  // before releasing the row barrier, so it serializes ahead of final S6 use.
  while(Date.now()<stopAt&&!revocationFinished){
   revoker=(await waiters()).find((r:any)=>r.pid!==final.pid&&!barrier.includes(r.pid)&&r.source_mutex);
   if(revoker)break;
   await delay(5);
  }
  assert(revoker&&!revocationFinished,'Y4_REVOCATION_SOURCE_MUTEX_BARRIER_NOT_OBSERVED');
  await clients[active]!.query('COMMIT');
  await revoking;if(revocationFailure)throw revocationFailure;
  await pending;if(failure)throw failure;
  assert(response&&response.status>=400,'Y4_S6_COMMITTED_AFTER_CONFIDENTIAL_REVOCATION');
  assert.deepEqual(await ownerResponsibilitySnapshot(input.admin,input.tenant),before,
   'Y4_REFUSED_COMMIT_REWROTE_ORIGINAL_NATIVE_RESPONSIBILITY');
  await artifact(input.privateDirectory,'s6-revocation-race.private.json',{before,steps,final,revoker,response});
  return {actualFinalS6CommitObserved:true,nativePortfolioMutexHeld:true,ordinaryOwnerRowBarrier:true,
   revocationSourceMutexObserved:true,revocationWaitedForOrdinaryBarrier:true,
   consentRevocationCommittedFirst:true,finalCommitRefused:true,
   existingReservationsConsumptionsEffectsAndHistoryUnchanged:true,executionAuthorityGranted:false};
 }catch(error){
  await artifact(input.privateDirectory,'s6-revocation-race-failure.private.json',
   {steps,finished,response,barrier,code:String((error as any)?.code??'Y4_NATIVE_COMMIT_RACE_UNPASSED')}).catch(()=>undefined);
  throw error;
 }finally{
  for(const c of clients)await c.query('ROLLBACK').catch(()=>undefined);
  await pending;
  await revoking;
  for(const c of clients)await c.end().catch(()=>undefined);
 }
}
