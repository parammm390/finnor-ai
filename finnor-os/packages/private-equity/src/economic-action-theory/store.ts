import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {isImmutableWorkStatus,type WorkStatus} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {authorize,principal,unavailable} from '../owner-context';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {affectedClosure} from '../live-recompilation/contracts';
import {runtimeIdentity} from './process';
import {PROFILE,digest,same,fail,ordinaryDisposableEconomicRuntime,type EconomicJob,type TheoryRow,type SubmitRequest,type EconomicProblem} from './contracts';

export function developmentOnly(){
 if(!ordinaryDisposableEconomicRuntime())fail('Y1_DISPOSABLE_DEVELOPMENT_ONLY',403);
}
export {principal};
export async function workCutTx(ctx:PeMutationContext,c:PoolClient,workId:string){
 const work=(await c.query<{status:WorkStatus}>('SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,workId])).rows[0];
 const row=(await c.query<{id:string;body:unknown}>('SELECT id::text,to_jsonb(i) body FROM finnor_os.work_inputs i WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.auth.tenantId,workId])).rows[0];
 if(!work||!row)throw unavailable();
 return {id:row.id,digest:digest(row.body),status:work.status,executable:!isImmutableWorkStatus(work.status)};
}
export async function eventTx(c:PoolClient,row:Pick<TheoryRow,'tenant_id'|'id'|'principal_id'|'episode_id'>,kind:string,key:string,body:unknown){
 await c.query('INSERT INTO finnor_os.y1_events(tenant_id,theory_id,episode_id,principal_id,kind,event_key,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,theory_id,event_key) DO NOTHING',
  [row.tenant_id,row.id,row.episode_id,row.principal_id,kind,key,JSON.stringify(body)]);
}
export async function enqueueTx(c:PoolClient,p:EconomicJob,key:string){
 return (await c.query<{id:string}>("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane) VALUES($1,'construct_economic_action_theory_v1',$2::jsonb,$3,1,4,'interactive') ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id",
  [p.tenantId,JSON.stringify(p),'y1:'+p.tenantId+':'+key])).rows[0]!.id;
}
export async function theoryTx(ctx:PeMutationContext,c:PoolClient,id:string,lock=true):Promise<TheoryRow>{
 const row=(await c.query<TheoryRow>(`SELECT r.*,e.deadline_at,e.attempts_used,e.search_steps_used,
  e.semantic_applications_used::int,e.retained_bytes::int FROM finnor_os.y1_requests r JOIN finnor_os.y1_episodes e
  ON e.tenant_id=r.tenant_id AND e.id=r.episode_id WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3`+
  (lock?' FOR UPDATE OF r':''),[ctx.auth.tenantId,principal(ctx),id])).rows[0];
 if(!row)throw unavailable();
 await authorize(ctx,row.root,[{type:'work',id:row.work_id}],[],c);
 if(digest(row.request)!==row.request_digest)fail('Y1_IMMUTABLE_REQUEST_INTEGRITY');
 return row;
}
function fieldsForMeaning(problem:EconomicProblem,key:string){
 return problem.quantities.concat(problem.parameters).filter(q=>q.meaningKey===key).map(q=>({
  unit:q.unit,currency:q.currency,entityId:q.entityId,accountingBasis:q.accountingBasis,period:q.period}));
}
/** Canonical evidence versions carry supplied meaning. An opaque hash, text
 * mention or source label is not a unit, consent or observed event. */
export async function meaningChangesTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest){
 const changes:string[]=[];
 const sources=request.problem.meanings.filter(m=>m.sourceId).map(m=>m.sourceId!);
 if(sources.length)await authorize(ctx,request.root,[{type:'work',id:request.workId}],sources,c);
 for(const meaning of request.problem.meanings){
  if(!meaning.sourceId||!meaning.versionId||!meaning.contentDigest)continue;
  const row=(await c.query<{id:string;content_hash:string;snapshot:Record<string,unknown>}>(
   'SELECT id::text,content_hash,snapshot FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1',
   [ctx.auth.tenantId,meaning.sourceId])).rows[0];
  if(!row||row.id!==meaning.versionId||row.content_hash!==meaning.contentDigest){changes.push('meaning:'+meaning.key);continue;}
  const claims=row.snapshot?.economicMeanings;
  if(!Array.isArray(claims))fail('Y1_TYPED_CANONICAL_MEANING_REQUIRED');
  const claim=claims.find((v:Record<string,unknown>)=>v.key===meaning.key&&v.kind===meaning.kind&&v.subjectId===meaning.subjectId) as Record<string,unknown>|undefined;
  if(!claim)fail('Y1_EXACT_MEANING_SCOPE_REQUIRED');
  for(const fields of fieldsForMeaning(request.problem,meaning.key))
   if(!Array.isArray(claim.dimensions)||!claim.dimensions.some(d=>same(d,fields)))fail('Y1_EXACT_UNIT_CURRENCY_ENTITY_BASIS_TIME_REQUIRED');
  for(const invariant of request.problem.invariants.filter(i=>i.meaningKey===meaning.key)){
   if(!Array.isArray(claim.invariants)||!claim.invariants.some(v=>same(v,{id:invariant.id,digest:digest(invariant)})))
    fail('Y1_CANONICAL_INVARIANT_MEANING_REQUIRED');
  }
  for(const operator of request.problem.operators.filter(o=>o.requirements.some(r=>r.key===meaning.key&&r.kind==='OBSERVATION'))){
   if(!Array.isArray(claim.operatorExamples)||!claim.operatorExamples.some(v=>same(v,{operatorId:operator.id,examplesDigest:digest(operator.examples)})))
    fail('Y1_CANONICAL_OPERATOR_OBSERVATIONS_REQUIRED');
  }
  if(meaning.kind==='CONSENT'){
   if(claim.protectionDomain!=='DISPOSABLE_LOCAL_DEVELOPMENT'||claim.externalEffects!==false||
    typeof claim.validUntil!=='string'||!Number.isFinite(Date.parse(claim.validUntil)))fail('Y1_EXPLICIT_BOUNDED_INTERNAL_CONSENT_REQUIRED');
   if(Date.parse(claim.validUntil)<=Date.now()){changes.push('meaning:'+meaning.key);continue;}
   for(const operator of request.problem.operators.filter(o=>o.requirements.some(r=>r.key===meaning.key&&r.kind==='CONSENT')))
    if(!Array.isArray(claim.permittedOperatorIds)||!claim.permittedOperatorIds.includes(operator.id))fail('Y1_EXACT_OPERATOR_CONSENT_REQUIRED');
  }
 }
 for(const op of request.problem.operators)for(const requirement of op.requirements){
  if(requirement.kind==='AUTHORITY')continue;
  const meaning=request.problem.meanings.find(m=>m.key===requirement.key);
  if(meaning&&(meaning.kind!==requirement.kind||meaning.subjectId!==requirement.subjectId))fail('Y1_REQUIREMENT_MEANING_SUBSTITUTION');
 }
 return [...new Set(changes)];
}
export async function currentChangesTx(ctx:PeMutationContext,c:PoolClient,row:TheoryRow){
 const changes=await meaningChangesTx(ctx,c,row.request),cut=await workCutTx(ctx,c,row.work_id);
 if(cut.id!==row.work_input_id||cut.digest!==row.work_input_digest||!cut.executable)changes.push('authority');
 const rights=await employeeAuthoritySnapshotTx(ctx.auth,c);
 const accepted=(await c.query<{authority:{employeeId:string;revision:string;validUntil:string|null}|null}>(
  "SELECT body->'authority' authority FROM finnor_os.y1_events WHERE tenant_id=$1 AND theory_id=$2 AND event_key='accepted' AND kind='ACCEPTED'",
  [row.tenant_id,row.id])).rows[0]?.authority;
 if(String(rights.revision)!==row.rights_revision||!accepted||accepted.employeeId!==row.principal_id||
  accepted.revision!==row.rights_revision||accepted.validUntil!==null&&
  (typeof accepted.validUntil!=='string'||!Number.isFinite(Date.parse(accepted.validUntil))||Date.now()>=Date.parse(accepted.validUntil)))
  changes.push('authority');
 const environment=await runtimeIdentity();
 if(environment.semanticCodeDigest!==row.runtime.semanticCodeDigest||environment.checkerDigest!==row.runtime.checkerDigest||
  !same(environment.checkerInterpreter,row.runtime.checkerInterpreter))changes.push('authority');
 if(Date.now()>=row.deadline_at.getTime())changes.push('authority');
 return [...new Set(changes)];
}
export async function invalidateTx(c:PoolClient,row:TheoryRow,changed:string[]){
 if(!changed.length||row.cancelled)return;
 const graph=row.artifact?.envelope.dependencies??[];
 const seeds=changed.filter(id=>graph.some(n=>n.id===id));
 const closure=graph.length&&seeds.length?affectedClosure(graph,seeds):{affectedNodes:graph,keptNodes:[]};
 await eventTx(c,row,'P7_INVALIDATION','invalidate:'+digest(changed),{changed,affected:closure.affectedNodes,kept:closure.keptNodes,
  originalEpisodeId:row.episode_id,obligationsRetained:true,reservationsRetained:true,observationsRewritten:false});
 if(row.status!=='INVALIDATED')await c.query("UPDATE finnor_os.y1_requests SET status='INVALIDATED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
}
/** Conservative occupation for canonical owner rows outside the Y1 artifact
 * tables. Future observation storage is reserved before creating an effect. */
export async function chargeOwnerStorageTx(c:PoolClient,row:TheoryRow,values:unknown[],futureBytes=0){
 const bytes=Buffer.byteLength(JSON.stringify(values))*2+4096+futureBytes;
 await c.query('UPDATE finnor_os.y1_episodes SET retained_bytes=retained_bytes+$3 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.episode_id,bytes]);
}
export async function checkedTheoryTx(ctx:PeMutationContext,c:PoolClient,id:string){
 const row=await theoryTx(ctx,c,id);
 if(row.status!=='CHECKED'||row.cancelled||!row.artifact?.body||row.artifact.envelope.status!=='CHECKED')fail('Y1_CURRENT_CHECKED_THEORY_REQUIRED');
 const artifact=row.artifact,check=artifact.envelope.independentChecks.find(x=>x.status==='CHECKED');
 if(!check||check.candidateDigest!==digest(artifact.body)||check.problemDigest!==digest(row.request.problem)||
  check.checkerDigest!==row.runtime.checkerDigest||!same(artifact.body,row.candidate))fail('Y1_CHECKED_ARTIFACT_BINDING');
 const changed=await currentChangesTx(ctx,c,row);if(changed.length)fail('Y1_THEORY_DEPENDENCIES_CHANGED');
 return row;
}
export async function selectFallbackTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest){
 const rows=(await c.query<{id:string}>("SELECT id FROM finnor_os.y1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND status='CHECKED' AND NOT cancelled AND admission IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 33",
  [ctx.auth.tenantId,principal(ctx),request.workId])).rows;
 if(rows.length>32)return null;
 const candidates:TheoryRow[]=[];
 for(const item of rows){
  const row=await theoryTx(ctx,c,item.id,false);
  if(!same(row.request.problem,request.problem)||!same(row.root,request.root)||!same(row.request.problem.quantities,request.problem.quantities)||
   !same(row.request.problem.parameters,request.problem.parameters)||!same(row.request.problem.invariants,request.problem.invariants)||
   !same(row.request.problem.operators.map(o=>({id:o.id,requirements:o.requirements})),request.problem.operators.map(o=>({id:o.id,requirements:o.requirements}))))continue;
  if(!(await currentChangesTx(ctx,c,row)).length)candidates.push(row);
 }
 candidates.sort((a,b)=>(b.artifact?.body?.laws.length??0)-(a.artifact?.body?.laws.length??0)||b.created_at.getTime()-a.created_at.getTime());
 return candidates[0]??null;
}
export async function submitTheory(ctx:PeMutationContext,request:SubmitRequest){
 developmentOnly();const runtime=await runtimeIdentity();
 if(Buffer.byteLength(JSON.stringify(request))>PROFILE.maxRequestBytes)fail('Y1_REQUEST_BOUND');
 return transaction(ctx,async c=>{
  await authorize(ctx,request.root,[{type:'work',id:request.workId}],[],c);
  const hash=digest(request),prior=(await c.query<{id:string;request_digest:string;status:string}>(
   'SELECT id,request_digest,status FROM finnor_os.y1_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==hash)fail('Y1_IDEMPOTENCY_CONFLICT',409);return {theoryId:prior.id,workId:request.workId,status:prior.status,replayed:true};}
  if((await meaningChangesTx(ctx,c,request)).length)fail('Y1_CURRENT_MEANING_VERSION_REQUIRED');
  const work=await workCutTx(ctx,c,request.workId);if(!work.executable)fail('Y1_EXECUTABLE_WORK_REQUIRED');
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c),id=randomUUID();
  const original=(await c.query<{id:string;deadline_at:Date;attempts_used:number}>('SELECT id,deadline_at,attempts_used FROM finnor_os.y1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE',[ctx.auth.tenantId,principal(ctx),request.workId])).rows[0];
  if(original&&(original.deadline_at.getTime()<=Date.now()||original.attempts_used>=PROFILE.maxAttempts))fail('Y1_ORIGINAL_EPISODE_EXHAUSTED');
  const episodeId=original?.id??randomUUID(),deadline=new Date(Date.now()+PROFILE.maxEpisodeWallMs);
  if(!original)await c.query('INSERT INTO finnor_os.y1_episodes(tenant_id,id,principal_id,work_id,deadline_at) VALUES($1,$2,$3,$4,$5)',[ctx.auth.tenantId,episodeId,principal(ctx),request.workId,deadline]);
  if(request.parentTheoryId){
   const parent=await theoryTx(ctx,c,request.parentTheoryId);
   if(parent.work_id!==request.workId||parent.episode_id!==episodeId||!same(parent.root,request.root))fail('Y1_ORIGINAL_PARENT_SCOPE_REQUIRED');
  }
  const fallback=await selectFallbackTx(ctx,c,request);
  await c.query(`INSERT INTO finnor_os.y1_requests(tenant_id,id,principal_id,root,work_id,work_input_id,work_input_digest,
   episode_id,request,request_digest,runtime,rights_revision,idempotency_key,fallback_id)
   VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14)`,
   [ctx.auth.tenantId,id,principal(ctx),JSON.stringify(request.root),request.workId,work.id,work.digest,episodeId,JSON.stringify(request),hash,
    JSON.stringify(runtime),String(authority.revision),request.idempotencyKey,fallback?.id??null]);
  const row=await theoryTx(ctx,c,id);
  await eventTx(c,row,'ACCEPTED','accepted',{profile:PROFILE,runtime,requestDigest:hash,originalEpisodeId:episodeId,
   authority:{employeeId:authority.employeeId,revision:String(authority.revision),validUntil:authority.validUntil},
   fallbackId:fallback?.id??null,protectedAuthorityCreated:false});
  const jobId=await enqueueTx(c,{tenantId:ctx.auth.tenantId,principalId:principal(ctx),theoryId:id,generation:1},id+':1');
  return {theoryId:id,workId:request.workId,status:'QUEUED',jobId,replayed:false};
 });
}
