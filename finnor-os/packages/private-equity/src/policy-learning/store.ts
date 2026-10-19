import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {canExerciseAuthorityTx,employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,closingTx,principal,unavailable} from '../owner-context';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {sha,fail,SubmitSchema,ExecuteSchema,EvaluateSchema,type LearningJob} from './contracts';
import type {z} from 'zod';
import type {LearningRelease} from './types';
import type {LearningEnvironment} from './source-cut';
import {currentLearningEnvironment} from './source-cut';
import {currentLearningConsentTx,resolveAcceptedLearningExperienceTx} from '../../../capability-evolution/src/learning-experience';
import {loadController} from './controller';
import {PolicySchema} from './contracts';
/** A role lock cannot stop wall-clock expiry during a long native walk. The
 * authenticated caller's boundary applies to every X5 read/write transaction. */
export function tx<T>(ctx:PeMutationContext,body:(c:PoolClient)=>Promise<T>):Promise<T>{
 return closingTx(ctx,async c=>{
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
  const result=await body(c);
  if(authority.validUntil)await assertAuthorityTemporalBoundsTx(c,[authority.validUntil]);
  return result;
 });
}
export {principal};
export const newId=()=>randomUUID();
export interface CompilationRow{
 tenant_id:string;id:string;owner_id:string;root_type:PeWorldRootRef['entityType'];root_id:string;work_id:string;
 work_input_id:string;work_input_digest:string;request:z.infer<typeof SubmitSchema>;request_digest:string;environment:LearningEnvironment;
 deadline_at:Date;max_attempts:number;max_uses:number;attempt_count:number;use_count:number;data_bytes:string;generation:number;status:string;head_release_id:string|null;
}
export interface UseRow{
 tenant_id:string;id:string;compilation_id:string;release_id:string;principal_id:string;request:z.infer<typeof ExecuteSchema>;request_digest:string;
 checkpoint_digest:string;policy_digest:string;status:string;result:Record<string,unknown>|null;created_at:Date;
}
export interface EvaluationRow{
 tenant_id:string;id:string;compilation_id:string;release_id:string;evaluator_id:string;request:z.infer<typeof EvaluateSchema>;request_digest:string;
 status:string;result:Record<string,unknown>|null;created_at:Date;
}
export const rootOf=(a:CompilationRow)=>({entityType:a.root_type,entityId:a.root_id});
export async function compilationTx(ctx:PeMutationContext,c:PoolClient,id:string,capability='query:learned_policy'){
 const a=(await c.query<CompilationRow>('SELECT * FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.auth.tenantId,id])).rows[0];
 if(!a)throw unavailable();
 await authorize(ctx,rootOf(a),[{type:'work',id:a.work_id}],[],c);
 if(!await canExerciseAuthorityTx(ctx.auth,{operation:capability.startsWith('query:')?'query':'action',capability,resource:{type:a.root_type,id:a.root_id},risk:'low'},c))throw unavailable();
 return a;
}
export function assertAllocation(a:CompilationRow){
 if(['CANCELLED','INVALIDATED'].includes(a.status))fail('X5_'+a.status);
 if(a.deadline_at.getTime()<=Date.now())fail('X5_ORIGINAL_DEADLINE_EXPIRED');
}
export async function assertWorkTx(c:PoolClient,a:CompilationRow){
 const work=await workCutTx(c,a);
 if(work.id!==a.work_input_id||work.digest!==a.work_input_digest)fail('X5_WORK_INPUT_CHANGED');
}
export async function currentTrainingRequestTx(c:PoolClient,a:CompilationRow){
 const row=(await c.query<{body:{experience:CompilationRow['request']['experience'];knowledgeCut:string}}>(
  "SELECT body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND kind='RETRAIN_REQUESTED' ORDER BY id DESC LIMIT 1",
  [a.tenant_id,a.id])).rows[0];
 return row?.body??a.request;
}
export async function releaseTx(c:PoolClient,a:CompilationRow,id=a.head_release_id){
 if(!id)fail('X5_RELEASE_UNAVAILABLE');
 const r=(await c.query<{body:LearningRelease;body_digest:string}>('SELECT body,body_digest FROM finnor_os.x5_releases WHERE tenant_id=$1 AND compilation_id=$2 AND id=$3',[a.tenant_id,a.id,id])).rows[0];
 if(!r||sha(r.body)!==r.body_digest)fail('X5_RELEASE_INTEGRITY');
 const invalid=(await c.query("SELECT id FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 AND kind='RELEASE_REVOKED' AND body->>'releaseId'=$3 LIMIT 1",[a.tenant_id,a.id,id])).rowCount;
 if(invalid)fail('X5_RELEASE_REVOKED');
 return r.body;
}
export async function assertReleaseCurrentTx(ctx:PeMutationContext,c:PoolClient,a:CompilationRow,r:LearningRelease,targetApplicationId?:string){
 const temporalBounds=[a.deadline_at.toISOString()];
 assertAllocation(a);await assertWorkTx(c,a);
 if(sha(await currentLearningEnvironment())!==sha(r.environment)||sha(r.policy)!==r.policyDigest||sha(PolicySchema.parse(r.policy))!==r.policyDigest)fail('X5_POLICY_OR_RUNTIME_CHANGED');
 loadController(r.originalCheckpoint,r.originalCheckpoint.digest);loadController(r.checkpoint,r.checkpoint.digest);
 for(const s of r.selections)await currentLearningConsentTx(ctx,c,s.consentId,s.applicationId,targetApplicationId??s.applicationId,temporalBounds);
 const experience=await resolveAcceptedLearningExperienceTx(ctx,c,r.selections,r.experience.knowledgeCut,temporalBounds);
 if(experience.cutDigest!==r.experience.cutDigest||experience.acceptedCount!==r.experience.acceptedCount)fail('X5_ACCEPTED_EVIDENCE_CORRECTED_OR_INVALIDATED');
 await assertAuthorityTemporalBoundsTx(c,temporalBounds);
 return temporalBounds;
}
export async function eventTx(c:PoolClient,a:CompilationRow,actor:string,kind:string,key:string,body:unknown){
 return (await c.query<{id:string}>('INSERT INTO finnor_os.x5_events(tenant_id,compilation_id,actor_id,kind,idempotency_key,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,compilation_id,idempotency_key) DO NOTHING RETURNING id::text',[a.tenant_id,a.id,actor,kind,key,JSON.stringify(body)])).rows[0]?.id;
}
export async function enqueueTx(c:PoolClient,p:LearningJob,key:string){
 return (await c.query<{id:string}>("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane) VALUES($1,'compile_learned_policy_v1',$2::jsonb,$3,1,8,'interactive') ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id",[p.tenantId,JSON.stringify(p),key])).rows[0]!.id;
}
