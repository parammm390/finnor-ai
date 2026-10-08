import {randomUUID} from 'node:crypto';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {assertDependencies} from '../evidence-execution/store';
import {m3Tx,m3Query,m3Lifecycle,m3Event,writeM3Record,type M3QueryRow} from './v2-store';
import {searchCapitalProgram} from './v2-search';
import {recheckCapitalOwners} from './v2-owners';
import {m3CheckTime,inM3Episode} from './v2-budget';
import {CapitalProgramV2Error,m3Hash,type CapitalProgramV2} from './v2-contracts';
import {withIssuedCapitalChallengeRead} from '../counterexample-search/service';

export async function runCapitalProgramJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
 if(!execution||execution.protocolVersion!==2||execution.tenantId!==payload.tenantId||
  typeof payload.queryId!=='string'||typeof payload.principalId!=='string'||typeof payload.tenantId!=='string')
  throw new CapitalProgramV2Error('UNAVAILABLE','Actual compatible durable capital programme claim required');
 const started=performance.now(),cpu=process.cpuUsage(),rssBeforeBytes=process.memoryUsage().rss,
  attemptCost=()=>{
   const used=process.cpuUsage(cpu);
   return {wallMs:performance.now()-started,cpuUserMicros:used.user,cpuSystemMicros:used.system,
    rssBeforeBytes,rssAfterBytes:process.memoryUsage().rss,money:null,status:'UNMETERED',
    accountingScope:'WORKER_HANDLER_BEFORE_TERMINAL_ACCOUNTING',aggregateChildUsageKnown:false};
  };
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},
  provenance:{sourceSystem:'M3:ordinary-native-worker',createdBy:payload.principalId}},
  attemptId=randomUUID();
 let q=await m3Query(ctx,payload.queryId);
 if(!['QUEUED','RUNNING'].includes(q.status)||q.generation!==payload.generation)return;
 if(process.env.FINNOR_M3_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production')
  throw new CapitalProgramV2Error('CONFIGURATION_REQUIRED','Protected funding/runtime/admission remain unavailable');
 async function claim(c:import('pg').PoolClient,lock=true){
  return (await c.query(`SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_capital_program_v2' AND status='running'
   AND claim_token=$3 AND claim_fence=$4 AND protocol_version=2 AND lease_expires_at>clock_timestamp()
   AND payload->>'queryId'=$5 AND payload->>'principalId'=$6 AND payload->>'generation'=$7`+(lock?' FOR SHARE':''),
   [execution!.jobId,ctx.auth.tenantId,execution!.claimToken,execution!.claimFence,q.id,ctx.auth.userId,String(q.generation)])).rows[0];
 }
 q=await m3Tx(ctx,async c=>{
  if(!await claim(c))throw new CapitalProgramV2Error('STALE_INPUT','Durable worker claim fenced');
  const current=await m3Query(ctx,q.id,c,true);
  if(!['QUEUED','RUNNING'].includes(current.status)||current.generation!==payload.generation)return current;
  const lost=(await c.query<{attempt_id:string}>("SELECT DISTINCT e.attempt_id::text FROM finnor_os.m3_events e WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.query_id=$3 AND e.kind='STARTED' AND NOT EXISTS(SELECT 1 FROM finnor_os.m3_events f WHERE f.tenant_id=e.tenant_id AND f.principal_id=e.principal_id AND f.query_id=e.query_id AND f.attempt_id=e.attempt_id AND f.kind IN('FINISHED','FAILED','FENCED'))",
   [q.tenant_id,q.principal_id,q.id])).rows;
  for(const abandoned of lost)await m3Event(ctx,q.id,abandoned.attempt_id,'FAILED',{code:'DURABLE_CLAIM_LOST',unknownPhysicalCost:true,money:null,
   originalDeadlineRetained:true,attempted:current.attempted,refinementSteps:current.refinement_steps},c);
  const updated=(await c.query<M3QueryRow>("UPDATE finnor_os.m3_queries SET status='RUNNING',first_started_at=coalesce(first_started_at,clock_timestamp()),deadline_at=coalesce(deadline_at,clock_timestamp()+($6::int||' milliseconds')::interval),active_claim_token=$4,active_claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 RETURNING *",
   [q.tenant_id,q.principal_id,q.id,execution!.claimToken,execution!.claimFence,q.request.resource.deadlineMs])).rows[0]!;
  await m3Event(ctx,q.id,attemptId,'STARTED',{jobId:execution!.jobId,deliveryAttemptId:execution!.deliveryAttemptId,claimToken:execution!.claimToken,
   claimFence:execution!.claimFence,workerId:execution!.workerId,deadlineAt:updated.deadline_at!.toISOString(),money:null,originalAcceptanceDigest:m3Hash(q.acceptance)},c);
  return updated;
 });
 if(q.status!=='RUNNING'||q.generation!==payload.generation)return;
 execution.registerHeartbeat(async()=>{
  try{
   // Claim maintenance is bounded lifecycle SQL, never a new search grant.
   return await inM3Episode(1000,()=>m3Tx(ctx,async c=>{
    const current=await m3Lifecycle(ctx,q.id,c);
    if(current.generation!==q.generation||current.active_claim_token!==execution.claimToken||
      String(current.active_claim_fence)!==String(execution.claimFence)||!await claim(c,false))return false;
    if(['PARTIAL','TESTED'].includes(current.status)&&current.result_digest){
     // Publication settles before ACK; a concurrent heartbeat must not fence it.
     return Boolean((await c.query(`SELECT query_id FROM finnor_os.m3_publications
      WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND generation=$4 AND result_digest=$5`,
      [q.tenant_id,q.principal_id,q.id,q.generation,current.result_digest])).rows[0]);
    }
    return current.status==='RUNNING'&&current.deadline_at!==null&&current.deadline_at.getTime()>Date.now();
   },true));
  }catch{return false;}
 });
 const checkpoint=async()=>{m3CheckTime();await m3Tx(ctx,async c=>{
  const current=await m3Lifecycle(ctx,q.id,c);
  if(current.status!=='RUNNING'||current.generation!==q.generation||current.active_claim_token!==execution!.claimToken||
   String(current.active_claim_fence)!==String(execution!.claimFence)||!await claim(c))
   throw new CapitalProgramV2Error('STALE_INPUT','Publication/query/job generation fenced');
 });};
 let program:CapitalProgramV2|null=null;
 try{
  const remaining=q.deadline_at!.getTime()-Date.now();
  if(remaining<=0)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original durable episode deadline exhausted');
  await withIssuedCapitalChallengeRead(()=>inM3Episode(remaining,async()=>{
   await checkpoint();await recheckCapitalOwners(ctx,q.request,q.acceptance);
   const searched=await searchCapitalProgram(ctx,q,attemptId,checkpoint);program=searched.program;
   await checkpoint();await recheckCapitalOwners(ctx,q.request,q.acceptance,searched.evidence);
   const {ref,...body}=program;await writeM3Record(ctx,'programs',ref,body);
   await m3Tx(ctx,async c=>{
    await assertDependencies(ctx,q.acceptance.dependencies,c,true);
    if(!await claim(c))throw new CapitalProgramV2Error('STALE_INPUT','Durable job claim fenced before publication');
    const current=await m3Lifecycle(ctx,q.id,c,true);
    if(current.generation!==q.generation||current.status!=='RUNNING'||current.active_claim_token!==execution!.claimToken||
     String(current.active_claim_fence)!==String(execution!.claimFence)||Date.now()>=q.deadline_at!.getTime())
     throw new CapitalProgramV2Error('STALE_INPUT','Capital programme publication is no longer eligible');
    await c.query('INSERT INTO finnor_os.m3_publications(tenant_id,principal_id,query_id,generation,result_digest) VALUES($1,$2,$3,$4,$5)',
     [q.tenant_id,q.principal_id,q.id,q.generation,ref.contentDigest]);
    const status=body.blockers.length||body.unresolvedBindings.length||body.incumbentAndSearchGap.remainingDescriptors>0?'PARTIAL':'TESTED';
    await c.query('UPDATE finnor_os.m3_queries SET status=$4,result_digest=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
     [q.tenant_id,q.principal_id,q.id,status,ref.contentDigest]);
    await m3Event(ctx,q.id,attemptId,'FINISHED',{status,resultRef:ref,costs:body.costs,attemptCost:attemptCost(),
     executionAuthorityGranted:false},c);
   });
  }));
 }catch(error){
  // This short, awaited accounting transaction never admits new search work or
  // changes the spent episode deadline. Host scheduling/cleanup overruns retain
  // their real measurement rather than receiving a renewed grant.
  await inM3Episode(1000,()=>m3Tx(ctx,async c=>{
   const current=await m3Lifecycle(ctx,q.id,c,true),fenced=current.status!=='RUNNING'||current.generation!==q.generation||
    current.active_claim_token!==execution!.claimToken;
   const code=error instanceof CapitalProgramV2Error?error.code:'OWNER_OR_STORAGE_FAILURE',
    requirement=error instanceof CapitalProgramV2Error?error.message:'Capital programme owner, compiler or immutable store predicate failed';
   if(!fenced)await c.query("UPDATE finnor_os.m3_queries SET status=$4,failure=$5::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
    [q.tenant_id,q.principal_id,q.id,code==='STALE_INPUT'?'INVALIDATED':'FAILED',JSON.stringify({code,requirement})]);
   await m3Event(ctx,q.id,attemptId,fenced?'FENCED':'FAILED',{code,requirement,computedResultDigest:program?.ref.contentDigest??null,
    attemptCost:attemptCost(),
    usableResult:false,physicalCostQualification:'PROCESS_INTERVAL_NOT_AGGREGATE_OS_GRANT',money:null,costsRetained:true},c);
  }));
 }
}
