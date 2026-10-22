import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {isImmutableWorkStatus,type WorkStatus} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {authorize,principal,unavailable} from '../owner-context';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {affectedClosure} from '../live-recompilation/contracts';
import {strategicRuntimeIdentity} from '../../../epistemic-runtime/src/strategic-response/process';
import {assertForecast} from '../../../epistemic-runtime/src/strategic-response/contracts';
import {PROFILE,digest,same,reference,fail,type ModelRow,type UseRow,type SubmitRequest,type StrategicJob,type UseRequest} from './contracts';
export {principal,authorize};
export function developmentOnly(){
 if(process.env.FINNOR_Y2_PROFILE!=='ordinary_disposable'||process.env.FINNOR_ENVIRONMENT!=='ordinary_disposable'||
  Reflect.get(process.env,'NODE_ENV')==='production')fail('Y2_DISPOSABLE_DEVELOPMENT_ONLY',403);
}
export async function workCutTx(ctx:PeMutationContext,c:PoolClient,workId:string){
 const work=(await c.query<{status:WorkStatus}>('SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,workId])).rows[0];
 const input=(await c.query<{id:string;body:unknown}>('SELECT id::text,to_jsonb(i) body FROM finnor_os.work_inputs i WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.auth.tenantId,workId])).rows[0];
 if(!work||!input)throw unavailable();
 return {id:input.id,digest:digest(input.body),executable:!isImmutableWorkStatus(work.status)};
}
export async function eventTx(c:PoolClient,row:Pick<ModelRow,'tenant_id'|'id'|'episode_id'|'principal_id'>,kind:string,key:string,body:unknown){
 await c.query('INSERT INTO finnor_os.y2_events(tenant_id,model_id,episode_id,principal_id,kind,event_key,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,model_id,event_key) DO NOTHING',
  [row.tenant_id,row.id,row.episode_id,row.principal_id,kind,key,JSON.stringify(body)]);
}
export async function enqueueTx(c:PoolClient,p:StrategicJob,key:string){
 return (await c.query<{id:string}>(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane)
  VALUES($1,$2,$3::jsonb,$4,1,4,'interactive') ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
  [p.tenantId,p.useId?'evaluate_strategic_response_v1':'learn_strategic_response_model_v1',JSON.stringify(p),'y2:'+p.tenantId+':'+key])).rows[0]!.id;
}
export async function modelTx(ctx:PeMutationContext,c:PoolClient,id:string,lock=true):Promise<ModelRow>{
 const row=(await c.query<ModelRow>(`SELECT m.*,e.deadline_at,e.attempts_used,e.use_attempts_used,e.semantic_applications_used::text,e.retained_bytes::text,e.uses_used
  FROM finnor_os.y2_models m JOIN finnor_os.y2_episodes e ON e.tenant_id=m.tenant_id AND e.id=m.episode_id
  WHERE m.tenant_id=$1 AND m.principal_id=$2 AND m.id=$3`+(lock?' FOR UPDATE OF m':''),
  [ctx.auth.tenantId,principal(ctx),id])).rows[0];
 if(!row)throw unavailable();
 await authorize(ctx,row.root,[{type:'work',id:row.work_id}],[],c);
 if(digest(row.request)!==row.request_digest)fail('Y2_IMMUTABLE_REQUEST_INTEGRITY');
 return row;
}
export async function useTx(ctx:PeMutationContext,c:PoolClient,modelId:string,id:string):Promise<UseRow>{
 const row=(await c.query<UseRow>('SELECT *,check_result AS check FROM finnor_os.y2_uses WHERE tenant_id=$1 AND principal_id=$2 AND requested_model_id=$3 AND id=$4 FOR UPDATE',
  [ctx.auth.tenantId,principal(ctx),modelId,id])).rows[0];
 if(!row)throw unavailable();
 if(digest({kind:row.kind,request:row.request})!==row.request_digest)fail('Y2_IMMUTABLE_USE_INTEGRITY');
 return row;
}
/** S1 owns this typed observed/assumed preimage. A label or hash cannot supply
 * actor information, mechanism meaning, permission or experimental outcomes. */
async function evidenceChangesTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest){
 const pin=request.evidence;
 await authorize(ctx,request.root,[{type:'work',id:request.workId}],[pin.sourceId],c);
 const source=(await c.query<{id:string;content_hash:string;snapshot:Record<string,unknown>}>(
  'SELECT id::text,content_hash,snapshot FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1 FOR SHARE',
  [ctx.auth.tenantId,pin.sourceId])).rows[0];
 if(!source||source.id!==pin.versionId||source.content_hash!==pin.contentDigest)return ['source'];
 if(!same(source.snapshot.worldRoot,request.root)||!same(source.snapshot.strategicResponseProblem,request.problem)||
  !same(request.root,request.problem.payoff.entityRoot))fail('Y2_TYPED_CANONICAL_PROBLEM_MEANING_REQUIRED');
 if(source.snapshot.protectionDomain!=='DISPOSABLE_LOCAL_DEVELOPMENT'||source.snapshot.externalEffects!==false)fail('Y2_EXPLICIT_INTERNAL_DEVELOPMENT_SCOPE_REQUIRED');
 const experiments=source.snapshot.executedSyntheticExperimentIds;
 for(const e of request.problem.training.concat(request.problem.holdout)){
  if(e.execution==='OBSERVED'&&Date.parse(e.observedAt)>Date.now())fail('Y2_FUTURE_OBSERVATION_NOT_EVIDENCE');
  if(e.assignment==='PERMITTED_RANDOMIZED'&&e.execution==='OBSERVED'){
   // Field experiment qualification is an S2 external gate. This finite
   // development port cannot promote supplied assignment flags to a field fact.
   if(e.origin!=='SIMULATED')fail('Y2_CANONICAL_S2_FIELD_EXPERIMENT_QUALIFICATION_REQUIRED');
   if(!Array.isArray(experiments)||!experiments.includes(e.id))fail('Y2_EXECUTED_PERMITTED_EXPERIMENT_EVIDENCE_REQUIRED');
  }
 }
 return [];
}
export async function currentChangesTx(ctx:PeMutationContext,c:PoolClient,row:ModelRow){
 const changes=await evidenceChangesTx(ctx,c,row.request),cut=await workCutTx(ctx,c,row.work_id),
  rights=await employeeAuthoritySnapshotTx(ctx.auth,c),environment=await strategicRuntimeIdentity();
 if(cut.id!==row.work_input_id||cut.digest!==row.work_input_digest||!cut.executable)changes.push('work');
 if(String(rights.revision)!==row.rights_revision)changes.push('rights');
 if(!environment.assetsMatchEmitted||!row.runtime.assetsMatchEmitted||environment.semanticCodeDigest!==row.runtime.semanticCodeDigest||
  environment.emittedSemanticCodeDigest!==row.runtime.emittedSemanticCodeDigest||!same(environment.interpreter,row.runtime.interpreter))changes.push('method');
 if(row.request.problem.transport.status!=='CONDITIONAL'||Date.parse(row.request.problem.transport.validUntil)<=Date.now())changes.push('transport');
 if(row.deadline_at.getTime()<=Date.now())changes.push('episode');
 return [...new Set(changes)];
}
export function dependencyGraph(row:ModelRow){
 const n=(id:string,owner:string,dependsOn:string[],body:unknown)=>({id,owner,kind:id.toUpperCase(),dependsOn,digest:digest(body)});
 return [n('source','S1',[],row.request.evidence),n('work','P1',[],row.work_input_digest),n('rights','AUTHORITY',[],row.rights_revision),
  n('method','S3',[],row.runtime.semanticCodeDigest),n('transport','S3',['source'],row.request.problem.transport),
  n('episode','S3',[],row.deadline_at.toISOString()),n('model','S3',['source','work','rights','method','transport','episode'],row.candidate),
  n('predictions','S3',['model'],row.id),n('programmes','S4',['model','predictions'],row.id)];
}
export async function invalidateTx(c:PoolClient,row:ModelRow,changed:string[]){
 if(!changed.length||row.cancelled)return;
 const closure=affectedClosure(dependencyGraph(row),changed);
 await eventTx(c,row,'P7_INVALIDATION','invalidate:'+digest(changed),{changed,affected:closure.affectedNodes,kept:closure.keptNodes,
  originalEpisodeId:row.episode_id,priorCommitmentsRetained:true,observationsRewritten:false,allocationOrEffectsDeleted:false});
 if(row.status!=='INVALIDATED')await c.query("UPDATE finnor_os.y2_models SET status='INVALIDATED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
}
export async function checkedModelTx(ctx:PeMutationContext,c:PoolClient,id:string){
 const row=await modelTx(ctx,c,id),artifact=row.artifact,check=artifact?.envelope.independentChecks.find(v=>v.status==='CHECKED');
 if(row.status!=='CHECKED'||row.cancelled||!artifact||!check||!row.candidate||row.candidate.status!=='FITTED'||
  !same(row.candidate,artifact.body)||check.candidateDigest!==digest(row.candidate)||check.inputDigest!==digest({problem:row.request.problem})||
  check.checkerDigest!==row.runtime.checkerDigest||!same(artifact.envelope.contentRef,reference('S3','strategic-response-model',{problem:row.request.problem,body:row.candidate})))fail('Y2_CURRENT_INDEPENDENTLY_CHECKED_MODEL_REQUIRED');
 if((await currentChangesTx(ctx,c,row)).length)fail('Y2_MODEL_DEPENDENCIES_CHANGED');
 return row;
}
async function selectFallbackTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest,episodeId:string){
 const rows=(await c.query<{id:string}>(`SELECT id FROM finnor_os.y2_models WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
  AND status='CHECKED' AND NOT cancelled AND admission IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 33`,
  [ctx.auth.tenantId,principal(ctx),request.workId])).rows;
 if(rows.length>32)return null;
 for(const item of rows){
  const row=await modelTx(ctx,c,item.id,false);
  if(row.episode_id===episodeId&&same(row.root,request.root)&&same(row.request.evidence,request.evidence)&&same(row.request.problem,request.problem)&&
   !(await currentChangesTx(ctx,c,row)).length)return row;
 }
 return null;
}
export async function submitModel(ctx:PeMutationContext,request:SubmitRequest){
 developmentOnly();const runtime=await strategicRuntimeIdentity();
 if(!runtime.assetsMatchEmitted)fail('Y2_EMITTED_METHOD_ASSET_MISMATCH',503);
 if(Buffer.byteLength(JSON.stringify(request))>PROFILE.maximumRequestBytes)fail('Y2_REQUEST_BOUND',413);
 return transaction(ctx,async c=>{
  await authorize(ctx,request.root,[{type:'work',id:request.workId}],[],c);
  const requestDigest=digest(request),prior=(await c.query<{id:string;request_digest:string;status:string}>(
   'SELECT id,request_digest,status FROM finnor_os.y2_models WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('Y2_IDEMPOTENCY_CONFLICT',409);return {modelId:prior.id,workId:request.workId,status:prior.status,replayed:true};}
  if((await evidenceChangesTx(ctx,c,request)).length)fail('Y2_CURRENT_CANONICAL_EVIDENCE_REQUIRED');
  const cut=await workCutTx(ctx,c,request.workId),rights=await employeeAuthoritySnapshotTx(ctx.auth,c);
  if(!cut.executable||request.problem.transport.status!=='CONDITIONAL'||Date.parse(request.problem.transport.validUntil)<=Date.now())fail('Y2_CURRENT_EXECUTABLE_WORK_AND_TRANSPORT_REQUIRED');
  const original=(await c.query<{id:string;deadline_at:Date;attempts_used:number}>('SELECT id,deadline_at,attempts_used FROM finnor_os.y2_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE',
   [ctx.auth.tenantId,principal(ctx),request.workId])).rows[0];
  if(original&&(original.deadline_at.getTime()<=Date.now()||original.attempts_used>=PROFILE.maximumAttempts))fail('Y2_ORIGINAL_EPISODE_EXHAUSTED',409);
  const episodeId=original?.id??randomUUID(),id=randomUUID();
  if(!original)await c.query('INSERT INTO finnor_os.y2_episodes(tenant_id,id,principal_id,work_id,deadline_at) VALUES($1,$2,$3,$4,$5)',
   [ctx.auth.tenantId,episodeId,principal(ctx),request.workId,new Date(Math.min(Date.now()+PROFILE.maximumEpisodeWallMs,Date.parse(request.problem.transport.validUntil)))]);
  if(request.parentModelId){
   const parent=await modelTx(ctx,c,request.parentModelId);
   if(parent.work_id!==request.workId||parent.episode_id!==episodeId||!same(parent.root,request.root))fail('Y2_ORIGINAL_PARENT_SCOPE_REQUIRED');
  }
  const fallback=await selectFallbackTx(ctx,c,request,episodeId);
  await c.query(`INSERT INTO finnor_os.y2_models(tenant_id,id,principal_id,root,work_id,work_input_id,work_input_digest,episode_id,
   request,request_digest,runtime,rights_revision,idempotency_key,fallback_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14)`,
   [ctx.auth.tenantId,id,principal(ctx),JSON.stringify(request.root),request.workId,cut.id,cut.digest,episodeId,JSON.stringify(request),requestDigest,
    JSON.stringify(runtime),String(rights.revision),request.idempotencyKey,fallback?.id??null]);
  const row=await modelTx(ctx,c,id),jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,modelId:id,generation:1},id+':1');
  await eventTx(c,row,'ACCEPTED','accepted',{requestDigest,runtime,profile:PROFILE,originalEpisodeId:episodeId,jobId,fallbackId:fallback?.id??null,
   protectedAuthorityCreated:false,publicSyntheticEvidenceNotFieldQualification:true});
  return {modelId:id,workId:row.work_id,status:'QUEUED',jobId,replayed:false};
 });
}
export async function resolveCurrentModelTx(ctx:PeMutationContext,c:PoolClient,id:string,allowFallback=false){
 const requested=await modelTx(ctx,c,id);
 if(requested.cancelled||requested.status==='INVALIDATED'||(await currentChangesTx(ctx,c,requested)).length)fail('Y2_REQUESTED_MODEL_SCOPE_NOT_CURRENT');
 let selected=requested;
 if(requested.status!=='CHECKED'&&allowFallback&&requested.fallback_id){
  const fallback=await modelTx(ctx,c,requested.fallback_id);
  if(!same(fallback.request.problem,requested.request.problem)||!same(fallback.request.evidence,requested.request.evidence)||
   fallback.episode_id!==requested.episode_id||fallback.work_input_digest!==requested.work_input_digest||
   fallback.rights_revision!==requested.rights_revision||fallback.runtime.semanticCodeDigest!==requested.runtime.semanticCodeDigest)fail('Y2_FALLBACK_COMPATIBILITY_CHANGED');
  selected=fallback;
 }
 const {currentStrategicAdmissionTx}=await import('../../../capability-evolution/src/strategic-response-port');
 const admitted=await currentStrategicAdmissionTx(ctx,c,selected.id);
 return {...admitted,requestedModelId:id,fallbackUsed:selected.id!==id};
}
export async function queueUse(ctx:PeMutationContext,kind:UseRow['kind'],request:UseRequest){
 developmentOnly();
 return transaction(ctx,async c=>{
  const requestDigest=digest({kind,request}),prior=(await c.query<{id:string;requested_model_id:string;request_digest:string;status:string}>(
   'SELECT id,requested_model_id,request_digest,status FROM finnor_os.y2_uses WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('Y2_USE_IDEMPOTENCY_CONFLICT',409);return {modelId:prior.requested_model_id,useId:prior.id,status:prior.status,replayed:true};}
  const selected=await resolveCurrentModelTx(ctx,c,request.modelId,true),row=selected.row;
  assertForecast(row.request.problem,request.query);
  if(row.uses_used>=PROFILE.maximumUses)fail('Y2_ORIGINAL_USE_LIMIT',409);
  const id=randomUUID();
  await c.query('UPDATE finnor_os.y2_episodes SET uses_used=uses_used+1 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.episode_id]);
  await c.query(`INSERT INTO finnor_os.y2_uses(tenant_id,id,model_id,requested_model_id,principal_id,episode_id,kind,request,request_digest,
   idempotency_key,model_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
   [row.tenant_id,id,row.id,request.modelId,row.principal_id,row.episode_id,kind,JSON.stringify(request),requestDigest,request.idempotencyKey,row.generation]);
  const jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,modelId:row.id,useId:id,generation:1},id+':1');
  await eventTx(c,row,'DURABLE_USE_ACCEPTED','use:'+id,{useId:id,jobId,kind,requestedModelId:request.modelId,executedModelId:row.id,
   fallbackUsed:selected.fallbackUsed,originalEpisodeId:row.episode_id,mandateReinterpreted:false,externalEffects:false});
  return {modelId:request.modelId,useId:id,status:'QUEUED',jobId,executedModelId:row.id,fallbackUsed:selected.fallbackUsed,replayed:false};
 });
}
export async function assertStrategicPolicyCurrent(ctx:PeMutationContext,policy:import('../../../shared-types/src/contingent-control').ContingentPolicy){
 developmentOnly();
 return transaction(ctx,async c=>{
  if(await (await import('../enterprise-control')).unresolvedEffects(ctx,c))
   fail('Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
  const binding=(await c.query<{id:string;requested_model_id:string}>(`SELECT id,requested_model_id FROM finnor_os.y2_uses
   WHERE tenant_id=$1 AND principal_id=$2 AND kind='DECISION' AND status='CHECKED' AND NOT cancelled
    AND artifact->'result'->'policy'->'ref'=$3::jsonb ORDER BY created_at DESC,id DESC LIMIT 1`,
   [ctx.auth.tenantId,principal(ctx),JSON.stringify(policy.ref)])).rows[0];
  if(!binding)fail('Y2_DURABLE_CHECKED_POLICY_PUBLICATION_REQUIRED');
  const requested=await modelTx(ctx,c,binding.requested_model_id);
  if(requested.cancelled||['INVALIDATED','CANCELLED'].includes(requested.status))fail('Y2_REQUESTED_MODEL_NOT_CURRENT');
  const use=await useTx(ctx,c,binding.requested_model_id,binding.id),selected=await resolveCurrentModelTx(ctx,c,use.model_id);
  const candidate=use.candidate as {policy?:unknown}|null,artifact=use.artifact as {result?:{policy?:unknown}}|null;
  if(!use.check||use.check.status!=='CHECKED'||use.check.candidateDigest!==digest(policy)||!same(candidate?.policy,policy)||
   !same(artifact?.result?.policy,policy)||use.model_generation!==selected.row.generation||
   !same(policy.bindings.modelRef,selected.row.artifact!.envelope.contentRef)||policy.episodeId!==selected.row.episode_id||
   Date.parse(policy.validUntil)<=Date.now())fail('Y2_STRATEGIC_POLICY_CHECKED_BINDING_CHANGED');
  return {modelId:selected.row.id,useId:use.id,originalEpisodeId:use.episode_id,model:selected.row,request:use.request,executionAuthorityGranted:false};
 });
}
