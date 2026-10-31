/** Disposable PostgreSQL check of the owner execution-deadline client: the per-transaction statement_timeout is
 * re-armed only when its slack could matter, and a statement that outlives the deadline is still ended by the
 * server within that slack. No product route, tenant or migration is involved. */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {connectWithExecutionDeadline,withDatabaseExecutionDeadline,DatabaseExecutionDeadlineError} from '../../../packages/db/execution-deadline';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-execution-deadline');
await mkdir(evidence,{recursive:true});
const started=Date.now(),observations:Record<string,unknown>[]=[];
const slackMs=100,armPattern=/^SET LOCAL statement_timeout/;
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const directory=await mkdtemp(join(tmpdir(),'finnor-y5-deadline-')),password=randomBytes(24).toString('hex');
const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{
 const a=s.address();if(!a||typeof a==='string')return no(Error('Y5_DEADLINE_PROBE_PORT'));s.close(()=>yes(a.port));});});
const postgres=new EmbeddedPostgres({databaseDir:directory,user:'probe_admin',password,port,persistent:false,onLog:()=>undefined});
let pool:pg.Pool|undefined,observer:pg.Client|undefined,running=false;
try{
 await postgres.initialise();await postgres.start();running=true;await postgres.createDatabase('deadline_probe');
 const url=`postgres://probe_admin:${password}@127.0.0.1:${port}/deadline_probe`;
 pool=new pg.Pool({connectionString:url,max:4});observer=new pg.Client({connectionString:url});await observer.connect();
 const sent:string[]=[],connect=pool.connect.bind(pool);
 // Record every statement that actually leaves the owner client, after the deadline wrapper has added its own.
 (pool as any).connect=async()=>{
  const client:any=await connect();
  if(!client.__spied){const query=client.query.bind(client);client.query=(...args:any[])=>{sent.push(typeof args[0]==='string'?args[0]:args[0]?.text);return query(...args);};client.__spied=true;}
  return client;
 };
 const armed=()=>sent.filter(text=>armPattern.test(text)).length;
 const within=<T,>(ms:number,work:()=>Promise<T>)=>withDatabaseExecutionDeadline(performance.now()+ms,work);

 // 1. A burst of fast statements in one transaction arms the timeout a handful of times, not once per statement.
 sent.length=0;
 const burstStart=performance.now();
 await within(20000,async()=>{
  const client=await connectWithExecutionDeadline(pool!);
  try{await client.query('BEGIN');for(let i=0;i<300;i++)await client.query('SELECT $1::int AS n',[i]);await client.query('COMMIT');}finally{client.release();}
 });
 const burstMs=performance.now()-burstStart;
 assert(armed()>=1,'timeout must be armed at least once');
 assert(armed()<=Math.ceil(burstMs/slackMs)+2,`armed ${armed()} times in ${burstMs} ms`);
 observations.push({case:'burst',statements:sent.length,armed:armed(),elapsedMs:Math.round(burstMs),previousBehaviour:'one arm per statement'});

 // 2. Once more than the slack has passed, the next statement re-arms with the smaller remaining time.
 sent.length=0;
 await within(20000,async()=>{
  const client=await connectWithExecutionDeadline(pool!);
  try{
   await client.query('BEGIN');await client.query('SELECT 1');const before=armed();
   await sleep(slackMs+150);await client.query('SELECT 2');
   assert.equal(armed(),before+1,'a statement after the slack must re-arm');
   await client.query('COMMIT');
  }finally{client.release();}
 });
 observations.push({case:'re-arm-after-slack',armed:armed()});

 // 3. A new transaction on the same checkout is armed again, and statements outside a transaction are not.
 sent.length=0;
 await within(20000,async()=>{
  const client=await connectWithExecutionDeadline(pool!);
  try{
   for(let round=0;round<2;round++){await client.query('BEGIN');await client.query('SELECT 1');await client.query('COMMIT');}
   await client.query('SELECT 3');
  }finally{client.release();}
 });
 assert.equal(armed(),2,'each transaction is armed once and autocommit statements are not');
 observations.push({case:'new-transaction-and-autocommit',armed:armed()});

 const timeoutMs=async(client:pg.PoolClient)=>{
  const shown=(await client.query<{statement_timeout:string}>('SHOW statement_timeout')).rows[0]!.statement_timeout;
  const milliseconds=/ms$/.test(shown)?Number(shown.slice(0,-2)):/s$/.test(shown)?Number(shown.slice(0,-1))*1000:NaN;
  assert(Number.isFinite(milliseconds),`unrecognised statement_timeout ${shown}`);
  return milliseconds;
 };

 // 4. A caller's explicit SET LOCAL statement_timeout is still replaced by the remaining time.
 await within(20000,async()=>{
  const client=await connectWithExecutionDeadline(pool!);
  try{
   await client.query('BEGIN');await client.query('SET LOCAL statement_timeout = 10000');
   const milliseconds=await timeoutMs(client);
   assert(milliseconds>10000&&milliseconds<=20000,`expected the remaining time, saw ${milliseconds} ms`);
   observations.push({case:'explicit-set-local-replaced',statementTimeoutMs:milliseconds});
   await client.query('COMMIT');
  }finally{client.release();}
 });

 // 4b. A nested scope with a different deadline re-arms at once, in both directions, on the same transaction.
 await within(20000,async()=>{
  const client=await connectWithExecutionDeadline(pool!);
  try{
   await client.query('BEGIN');await client.query('SELECT 1');
   const outer=await timeoutMs(client),inner=await within(500,()=>timeoutMs(client)),after=await timeoutMs(client);
   assert(outer>10000,`outer scope saw ${outer} ms`);
   assert(inner<=500,`inner scope saw ${inner} ms, so its tighter deadline was not applied`);
   assert(after>10000,`outer scope saw ${after} ms after the inner scope, so its shorter timeout was reused`);
   observations.push({case:'nested-deadline-rearms',outerMs:outer,innerMs:inner,afterInnerMs:after});
   await client.query('COMMIT');
  }finally{client.release();}
 });

 // 5. A statement that outlives the deadline is ended by the server no later than the deadline plus the slack,
 // even when it starts inside the slack window and the client has already abandoned it.
 const remainingMs=700,deadlineAt=performance.now()+remainingMs,wallDeadline=Date.now()+remainingMs;
 let clientErrorAt=0,failure:unknown;
 const waiter=within(remainingMs,async()=>{
  const client=await connectWithExecutionDeadline(pool!);
  try{
   await client.query('BEGIN');await client.query('SELECT 1');
   await client.query("SELECT pg_sleep(30), 'deadline-probe-sleep' AS marker");
  }catch(error){failure=error;clientErrorAt=Date.now();}
  finally{client.release();}
 });
 let serverGoneAt=0,seenRunning=false;
 const watch=(async()=>{
  for(;;){
   const rows=(await observer!.query("SELECT 1 FROM pg_stat_activity WHERE query LIKE '%deadline-probe-sleep%' AND pid<>pg_backend_pid() AND state='active'")).rowCount;
   if(rows){seenRunning=true;}else if(seenRunning){serverGoneAt=Date.now();return;}
   if(Date.now()>wallDeadline+5000)return;
   await sleep(20);
  }
 })();
 await Promise.all([waiter,watch]);
 assert(failure instanceof DatabaseExecutionDeadlineError,`expected the deadline error, saw ${String(failure)}`);
 assert(seenRunning&&serverGoneAt>0,'the sleeping statement must have run and then ended on the server');
 const serverOverrunMs=serverGoneAt-wallDeadline;
 assert(serverOverrunMs<=slackMs+400,`server ended the statement ${serverOverrunMs} ms after the deadline`);
 observations.push({case:'server-ends-statement-near-deadline',remainingMs,clientErrorAfterDeadlineMs:clientErrorAt-wallDeadline,
  serverEndedAfterDeadlineMs:serverOverrunMs,slackMs,toleranceMs:400,deadlineAtMonotonic:Math.round(deadlineAt)});

 const report={schema:'finnor.y5.execution-deadline-verification.v1',status:'PASS',wallMs:Date.now()-started,
  scope:'DISPOSABLE_LOCAL_POSTGRESQL_DEADLINE_CLIENT_ONLY_NOT_OWNER_FLOW_OR_QUALIFICATION',observations};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:report.wallMs}));
}catch(error){
 await writeFile(resolve(evidence,'failure.json'),JSON.stringify({status:'FAIL',wallMs:Date.now()-started,error:String(error),observations},null,2)+'\n');
 throw error;
}finally{
 await observer?.end().catch(()=>undefined);await pool?.end().catch(()=>undefined);
 if(running)await postgres.stop().catch(()=>undefined);
 await rm(directory,{recursive:true,force:true}).catch(()=>undefined);
}
