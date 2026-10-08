import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import type {PeMutationContext} from '../types';
import {authorize,principal,sha,stable,tx,unavailable,assertDependencies,currentDerivation} from '../evidence-execution/store';
import {assertProgramCurrent,requestRow,episodeCosts,costWitness,type ProgramRow} from '../program-synthesis/store';
import type {SearchRow,UnitRow,ComputeSearchPlan,CheckedIncumbent} from './contracts';
import {P2_VERSION} from './contracts';
import {marginalWorkProtocol} from './calibration';
import {canonicalExact} from '../evidence-execution/exact';
import {recheckSearchOwners} from './owners';
import {readEndpointConfig,endpointProjection,nativeCapacitySnapshot} from './endpoints';
import {buildPolicy,persistPolicy,validateDeliberationBinding} from '../deliberation/store';
export async function searchRow(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<SearchRow>{
 const read=async(client:PoolClient)=>{const row=(await client.query<SearchRow>('SELECT * FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[ctx.auth.tenantId,principal(ctx),id])).rows[0];if(!row)throw unavailable();if(sha(row.request)!==row.request_digest)throw Error('P2_REQUEST_DIGEST_MISMATCH');return row;};return c?read(c):tx(ctx,read,true);
}
export async function searchForProgram(ctx:PeMutationContext,programId:string):Promise<SearchRow|null>{return tx(ctx,async c=>(await c.query<SearchRow>('SELECT * FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND program_id=$3',[ctx.auth.tenantId,principal(ctx),programId])).rows[0]??null,true);}
export async function units(ctx:PeMutationContext,s:SearchRow,c:PoolClient):Promise<UnitRow[]>{const rows=(await c.query<UnitRow>('SELECT * FROM finnor_os.p2_units WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id',[s.tenant_id,s.principal_id,s.id])).rows;
 for(const u of rows)if(sha(u.body)!==u.digest||u.result&&sha(u.result)!==u.result_digest)throw Error('P2_UNIT_OR_RESULT_DIGEST_MISMATCH');return rows;}
export async function append(ctx:PeMutationContext,s:SearchRow,kind:string,body:unknown,c:PoolClient){await c.query('INSERT INTO finnor_os.p2_events(tenant_id,principal_id,search_id,kind,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[s.tenant_id,s.principal_id,s.id,kind,stable(body),sha(body)]);}
export async function currentSearch(ctx:PeMutationContext,s:SearchRow,q?:ProgramRow){
 q??=await requestRow(ctx,s.program_id);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 if(['FAILED','PARTIAL','CANCELLED','INVALIDATED'].includes(q.status))throw Error('P2_PARENT_PROGRAM_WITHOUT_ACCEPTED_DELIVERY');
 if(['CANCELLED','INVALIDATED'].includes(s.status))throw Error('P2_TERMINAL_CURRENTNESS_FENCED');
 await assertProgramCurrent(ctx,q);
 await recheckSearchOwners(ctx,q,s);
 await validateDeliberationBinding(ctx,q,s.request);
 if(s.context){const d=await currentDerivation(ctx,s.context.derivationId);if(d.result?.digest!==s.context.sourceResultDigest||q.generation!==s.context.programGeneration)throw Error('P2_SOURCE_OR_PROGRAM_GENERATION_CHANGED');await assertDependencies(ctx,s.context.dependencies);if(s.context.physicalCapacity.digest!==(await nativeCapacitySnapshot(ctx,s.request.requestedKinds.includes('MODEL_REFINE'))).digest)throw Error('P2_SHARED_PHYSICAL_CAPACITY_POLICY_CHANGED');}
 const endpoints=await readEndpointConfig();
 for(const pinned of s.context?.endpoints??[])if(!endpoints.some(e=>e.id===pinned.id&&e.digest===pinned.digest))throw Error('P2_ENDPOINT_QUOTA_SNAPSHOT_CHANGED');
 return q;
}
export function incumbentOf(s:SearchRow,rows:UnitRow[]):CheckedIncumbent|null{
 const checked=rows.filter(u=>u.kind==='VERIFY_P1'&&u.status==='COMPLETED'&&u.body.sourceDigest===s.context?.sourceResultDigest&&u.body.inputDigest===s.context?.inputDigest&&u.result?.moduleId===u.body.moduleId&&u.result?.checks?.length===s.context?.program.acceptance.targets.length&&u.result.checks.length>0&&s.context.program.acceptance.targets.every((t:any)=>u.result.checks.filter((c:any)=>c.id==='numeric:'+t.key&&c.method==='POSTGRES_NUMERIC_ACCEPTED_EXPRESSION'&&c.status==='PASS'&&typeof c.expected==='string'&&typeof c.actual==='string'&&canonicalExact(c.expected)===canonicalExact(c.actual)&&c.actual===u.result.values?.[t.key]?.value&&c.unit===t.unit&&c.currencyCode===t.currencyCode).length===1));
 const chosen=checked.sort((a,b)=>a.result.completedAt-b.result.completedAt||a.id.localeCompare(b.id))[0];
 return chosen?{moduleId:chosen.result.moduleId,values:chosen.result.values,checks:chosen.result.checks,unitId:chosen.id,sourceResultDigest:s.context.sourceResultDigest,inputDigest:s.context.inputDigest,acceptanceDigest:s.context.acceptanceDigest}:null;
}
export async function snapshot(ctx:PeMutationContext,s:SearchRow,q:ProgramRow,c:PoolClient):Promise<ComputeSearchPlan>{
 const frontier=await units(ctx,s,c),all=(await c.query<any>('SELECT id,unit_id,status,body,endpoint_key,created_at FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id',[s.tenant_id,s.principal_id,s.id])).rows;
 for(const a of all){const digest=(await c.query('SELECT digest FROM finnor_os.p2_attempts WHERE id=$1',[a.id])).rows[0]?.digest;if(sha(a.body)!==digest)throw Error('P2_ATTEMPT_DIGEST_MISMATCH');}
 const terminal=['CANCELLED','INVALIDATED'].includes(s.status),incumbent=terminal?null:incumbentOf(s,frontier);
 const remaining=incumbent?['S4_MARGINAL_DECISION_LOSS_CONVERSION','INDEPENDENT_DEVELOPMENT_VALUE_LABELS','UNSEEN_MECHANISMS','INDEPENDENT_SEALED_GATE']:['INDEPENDENTLY_CHECKED_P1_INCUMBENT','S4_MARGINAL_DECISION_LOSS_CONVERSION'];
 const active=frontier.filter(u=>['RUNNING','QUEUED'].includes(u.status));
 const estimate=marginalWorkProtocol(s.binding);
 const plan:ComputeSearchPlan={schema:'finnor.compute-search-plan.v1',id:s.id,version:P2_VERSION,revision:s.revision+1,status:s.status,
  work:{id:q.work_id,revision:q.work_input_id,inputDigest:q.work_input_digest,planRevisionId:q.plan_revision_id},programId:q.id,
  policyRequest:s.request.policyRequest,computeGrant:s.request.computeGrant,
  frontier:frontier.map(u=>({id:u.id,kind:u.kind,status:u.status,moduleId:u.body.moduleId,prerequisites:u.body.prerequisites,mechanism:u.body.mechanism,correlationGroup:u.body.sourceDigest,marginalValue:{unit:s.binding.loss.unit,estimate:null,upper:null,support:'UNAVAILABLE_S4_CONVERSION_AND_INDEPENDENT_LABELS'},actualOutcome:terminal?null:u.result?{digest:u.result_digest,checks:u.result.checks??null}:null})),
  next:active.map(u=>({unitId:u.id,kind:u.kind,route:u.body.routeIds,prerequisites:u.body.prerequisites})),
  quotaProfile:[...(s.context?.physicalCapacity?[s.context.physicalCapacity]:[]),...(s.context?.endpoints??[]).map(endpointProjection)],incumbent,
  stop:{heuristic:true,reason:s.reason,lossUnit:s.binding.loss.unit,remainingPredicates:remaining},
  outstanding:all.filter(a=>['INTENT','SUBMITTED','UNKNOWN'].includes(a.status)).map(a=>({attemptId:a.id,unitId:a.unit_id,status:a.status,disposition:s.status==='RUNNING'?'AWAIT':'RECONCILE',liabilityRetained:true,mayRetry:false,submittedAt:a.body.submittedAt??null,endpointKey:a.endpoint_key})),
  costs:{usd:null,status:'UNMETERED',physicalAttempts:all.length,nativeAttempts:all.filter(a=>!a.endpoint_key).length,modelAttempts:all.filter(a=>a.endpoint_key).length,recoveryAttempts:all.filter(a=>a.body.recovery).length,usage:all.map(a=>({attemptId:a.id,status:a.status,actualProvider:a.body.actualProvider??null,actualModel:a.body.actualModel??null,usage:a.body.usage??null,elapsedMs:a.body.elapsedMs??null,costUSD:null,receiptDigest:sha(a.body)})),parent:costWitness(await episodeCosts(ctx,q,c)),accountingScope:'P2_PHYSICAL_ATTEMPTS_AND_NONADDITIVE_ORIGINAL_P1_EPISODE_WITNESS_OVERLAP_NOT_SUMMED'},
  bottleneck:{kind:incumbent?'EXPLORATION_OR_MODEL_AMBIGUITY':frontier.some(u=>u.kind==='VERIFY_P1'&&u.status==='FAILED')?'CHECKER_FAILURE':s.context?'VERIFICATION':'DATA_OR_SOURCE_UNCERTAINTY',source:'CURRENT_OWNER_AND_COMPLETED_UNIT_RESULTS',effectAuthority:false},
  topology:{strategy:s.request.strategy,maxParallel:s.request.limits.maxParallel,active:active.length,kind:active.length>1?'PARALLEL_INDEPENDENT':frontier.some(u=>u.body.prerequisites.length)?'COORDINATED_WITH_CHECK_BARRIER':'SEQUENTIAL',economicBenefit:null,selection:'VERSIONED_HEURISTIC_WITHOUT_CALIBRATED_VALUE'},
  bindings:{...s.binding,marginalWorkEstimate:estimate,sourceResultDigest:s.context?.sourceResultDigest??null,acceptanceDigest:q.proposed.acceptanceDigest,producer:q.proposed.producer,originalEpisode:q.episode_id},
  qualifications:['ORDINARY_EXECUTED_P1_SEARCH_NO_PROTECTED_ADMISSION','NO_MODEL_OPINION_COUNT_IS_INFORMATION','NATIVE_GRANT_DOES_NOT_FUND_DOLLARS_OR_TOKENS','COMPLETE_BILLING_AND_AGGREGATE_CONTAINER_BOUND_UNAVAILABLE','CALIBRATED_TOPOLOGY_AND_ROUTING_GATE_UNPASSED',...remaining]};
 const planId=randomUUID(),policy=s.request.deliberation?await buildPolicy(ctx,s,q,plan,planId,c):null;
 if(policy)plan.deliberationPolicyRef=policy.ref;
 const head=(await c.query('INSERT INTO finnor_os.p2_plans(id,tenant_id,principal_id,search_id,revision,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id',[planId,s.tenant_id,s.principal_id,s.id,plan.revision,stable(plan),sha(plan)])).rows[0].id;
 if(policy)await persistPolicy(ctx,s,policy,plan,head,c);
 await c.query('UPDATE finnor_os.p2_requests SET revision=$4,head_id=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,s.id,plan.revision,head]);return plan;
}
export async function readStoredPlan(ctx:PeMutationContext,s:SearchRow){if(!s.head_id)throw Error('P2_PLAN_HEAD_MISSING');return tx(ctx,async c=>{const row=(await c.query('SELECT body,digest FROM finnor_os.p2_plans WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,s.head_id])).rows[0];if(!row||sha(row.body)!==row.digest)throw Error('P2_PLAN_DIGEST_MISMATCH');return row.body as ComputeSearchPlan;},true);}
