import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ComputeCapacityUnavailableError} from '@finnor/db';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {sha,stable,tx,assertDependencies} from '../evidence-execution/store';
import {requestRow,assertProgramCurrent} from '../program-synthesis/store';
import {searchRow,append} from './store';
import type {SearchRow,UnitRow} from './contracts';
import type {Endpoint} from './endpoints';
import {currentModule} from '../deliberation/module';
/** One transaction admits all dimensions and original parent counters. A failed
 * quota admission commits no debit or physical intent. Submission is a separate
 * durable cut; after it, costs/liabilities never disappear on timeout/cancel. */
export async function admit(ctx:PeMutationContext,s:SearchRow,u:UnitRow,x:Readonly<JobExecutionContext>,steps:number,endpoint?:Endpoint,inputTokens=0){
 return tx(ctx,async c=>{
  // Same lock as S5 resource mutation/release; no physical I/O while held.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+s.tenant_id]);
  const locked=await searchRow(ctx,s.id,c,true),q=await requestRow(ctx,s.program_id,c);
  if(locked.generation!==s.generation||locked.status!=='RUNNING')throw Error('P2_SEARCH_ADMISSION_FENCED');
  await assertProgramCurrent(ctx,q,c,true);await assertDependencies(ctx,s.context.dependencies,c,true);
  const job=(await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_compute_search_unit_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=$5 FOR SHARE",[x.jobId,s.tenant_id,x.claimToken,x.claimFence,x.protocolVersion])).rows[0];if(!job)throw Error('P2_ACTUAL_JOB_CLAIM_REQUIRED');
  const current=(await c.query<UnitRow>('SELECT * FROM finnor_os.p2_units WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 FOR UPDATE',[u.id,s.tenant_id,s.principal_id])).rows[0];
  const perUnitBound=u.kind==='CONTROL_M2'&&locked.request.deliberation?Math.min(currentModule().body.config.maxRuns,q.proposed.bounds.maxAttempts):2;
  if(!current||!['QUEUED','RUNNING'].includes(current.status)||current.generation!==s.generation||current.attempts>=perUnitBound)throw Error('P2_UNIT_PHYSICAL_ATTEMPT_BOUND');
  if(current.digest!==u.digest||sha(current.body)!==u.digest)throw Error('P2_EXACT_ADMISSION_UNIT_BODY_REQUIRED');
  if((await c.query('SELECT id FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND delivery_id=$3',[s.tenant_id,s.principal_id,x.deliveryAttemptId])).rowCount)throw Error('P2_PHYSICAL_DELIVERY_ALREADY_ADMITTED');
  if(current.status==='RUNNING'&&current.claim_token!==x.claimToken)throw Error('P2_RECOVERY_RECONCILE_BEFORE_RETRY');
  if(u.body.prerequisites.length&&(await c.query("SELECT count(*)::int n FROM finnor_os.p2_units WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND principal_id=$3 AND search_id=$4 AND status='COMPLETED'",[u.body.prerequisites,s.tenant_id,s.principal_id,s.id])).rows[0]?.n!==u.body.prerequisites.length)throw Error('P2_PREREQUISITE_BARRIER_UNPASSED');
  const reservation=(await c.query('SELECT status,revocation_reason,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2 FOR SHARE',[s.tenant_id,s.request.computeGrant.contentDigest])).rows[0];
  if(!reservation||reservation.status==='RELEASED'||reservation.revocation_reason||stable(reservation.envelopes.find((e:any)=>e.resourceId===s.binding.resourceId))!==stable(s.binding.resourceEnvelope)||Date.parse(s.binding.validUntil)<=Date.now())throw Error('P2_S5_RESERVATION_REVOKED_OR_CHANGED');
  const resource=(await c.query('SELECT r.content_digest FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 AND r.resource_id=$2 FOR SHARE OF h,r',[s.tenant_id,s.binding.resourceId])).rows[0];
  if(resource?.content_digest!==s.binding.resourceRef.contentDigest)throw Error('P2_COMPUTE_RESOURCE_REVISION_CHANGED');
  if(endpoint){
   if(Date.parse(endpoint.expiresAt)<=Date.now())throw Error('P2_ENDPOINT_SNAPSHOT_EXPIRED');
   const minute=Math.floor(Date.now()/60000),day=Math.floor(Date.now()/86400000);
   await c.query('INSERT INTO finnor_os.p2_endpoint_windows(endpoint_key,config_digest,minute_start,day_start) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[endpoint.key,endpoint.digest,minute,day]);
   const w=(await c.query('SELECT * FROM finnor_os.p2_endpoint_windows WHERE endpoint_key=$1 FOR UPDATE',[endpoint.key])).rows[0];
   if(w.config_digest!==endpoint.digest)throw Error('P2_ENDPOINT_POLICY_REVISION_REQUIRES_RECONCILIATION');
   const requests=Number(w.minute_start)===minute?Number(w.requests):0,input=Number(w.minute_start)===minute?Number(w.input_tokens):0,output=Number(w.minute_start)===minute?Number(w.output_tokens):0,daily=Number(w.day_start)===day?Number(w.daily_tokens):0;
   const maxOutput=endpoint.limits.maxOutputTokens;
   if(Number(w.active)>=endpoint.limits.concurrency||requests+1>endpoint.limits.rpm||input+inputTokens>endpoint.limits.inputTpm||output+maxOutput>endpoint.limits.outputTpm||daily+inputTokens+maxOutput>endpoint.limits.tpd)throw new ComputeCapacityUnavailableError('p2-endpoint:'+endpoint.id,1000);
   await c.query('UPDATE finnor_os.p2_endpoint_windows SET minute_start=$2,day_start=$3,requests=$4,input_tokens=$5,output_tokens=$6,daily_tokens=$7,active=active+1 WHERE endpoint_key=$1',[endpoint.key,minute,day,requests+1,input+inputTokens,output+maxOutput,daily+inputTokens+maxOutput]);
  }
  await c.query('INSERT INTO finnor_os.p2_grant_usage(tenant_id,principal_id,grant_digest,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,s.request.computeGrant.contentDigest,s.binding.resourceId]);
  const debit=await c.query('UPDATE finnor_os.p2_grant_usage SET spent=spent+1 WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4 AND spent+1<=$5 RETURNING spent',[s.tenant_id,s.principal_id,s.request.computeGrant.contentDigest,s.binding.resourceId,s.binding.capacity]);if(!debit.rowCount)throw Error('P2_ORIGINAL_S5_COMPUTE_ENVELOPE_EXHAUSTED');
  const parent=await c.query('UPDATE finnor_os.p1_episodes SET steps_used=steps_used+$4,attempts_used=attempts_used+1 WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND steps_used+$4<=max_steps AND attempts_used+1<=max_attempts AND deadline_at>clock_timestamp() RETURNING attempts_used,steps_used',[q.episode_id,s.tenant_id,s.principal_id,steps]);if(!parent.rowCount)throw Error('P2_ORIGINAL_P1_EPISODE_EXHAUSTED');
  const id=randomUUID(),body={unitId:u.id,unitBodyDigest:u.digest,unitInvocation:current.attempts+1,workKind:u.kind,jobId:x.jobId,deliveryAttemptId:x.deliveryAttemptId,claimFence:x.claimFence,protocolVersion:x.protocolVersion,requestedRoute:endpoint?.id??'P1_NATIVE',requestedModel:endpoint?.model??null,quotaDigest:endpoint?.digest??null,inputReservation:inputTokens,outputReservation:endpoint?.limits.maxOutputTokens??null,grantDigest:s.request.computeGrant.contentDigest,resourceId:s.binding.resourceId,chargedNativeAttempts:1,originalEpisode:q.episode_id,steps,recovery:current.attempts>0&&u.kind!=='CONTROL_M2',controlContinuation:u.kind==='CONTROL_M2'&&current.attempts>0,costUSD:null,createdAt:new Date().toISOString()};
  await c.query("INSERT INTO finnor_os.p2_attempts(id,tenant_id,principal_id,search_id,unit_id,delivery_id,claim_fence,status,endpoint_key,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7,'INTENT',$8,$9::jsonb,$10)",[id,s.tenant_id,s.principal_id,s.id,u.id,x.deliveryAttemptId,x.claimFence,endpoint?.key??null,stable(body),sha(body)]);
  await c.query("UPDATE finnor_os.p2_units SET status='RUNNING',attempts=attempts+1,claim_token=$2,claim_fence=$3,job_id=$4,updated_at=clock_timestamp() WHERE id=$1",[u.id,x.claimToken,x.claimFence,x.jobId]);
  await append(ctx,s,'PHYSICAL_ATTEMPT_ADMITTED',{attemptId:id,...body,quotaPolicyOnly:!!endpoint,allDimensionsAdmitted:true},c);
  return {id,body};
 });
}
export async function updateAttempt(ctx:PeMutationContext,s:SearchRow,id:string,status:string,delta:any,c?:PoolClient){
 const action=async(client:PoolClient)=>{const r=(await client.query('SELECT body,status FROM finnor_os.p2_attempts WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 FOR UPDATE',[id,s.tenant_id,s.principal_id])).rows[0];if(!r)throw Error('P2_DURABLE_ATTEMPT_MISSING');const body={...r.body,...delta};
  await client.query('UPDATE finnor_os.p2_attempts SET status=$4,body=$5::jsonb,digest=$6,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3',[id,s.tenant_id,s.principal_id,status,stable(body),sha(body)]);
  await append(ctx,s,'PHYSICAL_ATTEMPT_'+status,{attemptId:id,priorStatus:r.status,...body},client);return body;};return c?action(c):tx(ctx,action);
}
