import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {PeMutationContext} from '../types';
import {authorize,principal,unavailable} from '../owner-context';
import {withS5PortfolioTransaction} from '../allocation-store';
import {affectedClosure} from '../live-recompilation/contracts';
import {currentEconomicTheoryAdmissionTx} from '../../../capability-evolution/src/economic-theory-port';
import {workCutTx,developmentOnly as y1DevelopmentOnly} from '../economic-action-theory/store';
import {applyOperator,safe,inDomain,exact} from '../economic-action-theory/finite';
import {Rational,q} from './exact';
import {PROFILE_DIGEST,digest,fail} from './contracts';
import {LIMITS,same,reference,type ProtocolRow,type SubmitRequest,type InteractionJob,type SourceBinding} from './product-contracts';
import {productRuntimeIdentity} from './product-runtime';

export {principal,workCutTx};
export const transaction=<T>(ctx:PeMutationContext,fn:(c:PoolClient)=>Promise<T>)=>withS5PortfolioTransaction(ctx,fn);
export function developmentOnly(){
 if(process.env.FINNOR_Y3_PROFILE!=='ordinary_disposable'||process.env.FINNOR_ENVIRONMENT!=='ordinary_disposable'||
  Reflect.get(process.env,'NODE_ENV')==='production')fail('Y3_DISPOSABLE_DEVELOPMENT_ONLY',403);
 y1DevelopmentOnly();
}
export async function eventTx(c:PoolClient,row:Pick<ProtocolRow,'tenant_id'|'id'|'episode_id'|'principal_id'>,kind:string,key:string,body:unknown){
 await c.query(`INSERT INTO finnor_os.y3_events(tenant_id,protocol_id,episode_id,principal_id,kind,event_key,body)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,protocol_id,event_key) DO NOTHING`,
 [row.tenant_id,row.id,row.episode_id,row.principal_id,kind,key,JSON.stringify(body)]);
}
export async function enqueueTx(c:PoolClient,p:InteractionJob,key:string){
 return (await c.query<{id:string}>(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane)
  VALUES($1,'construct_interaction_protocol_v1',$2::jsonb,$3,1,4,'interactive')
  ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
 [p.tenantId,JSON.stringify(p),'y3:'+p.tenantId+':'+key])).rows[0]!.id;
}
export async function protocolTx(ctx:PeMutationContext,c:PoolClient,id:string,ownerOnly=true,lock=true):Promise<ProtocolRow>{
 const row=(await c.query<ProtocolRow>(`SELECT r.*,e.deadline_at,e.attempts_used,e.search_steps_used,e.retained_bytes::int
  FROM finnor_os.y3_requests r JOIN finnor_os.y3_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id
  WHERE r.tenant_id=$1 AND r.id=$2`+(ownerOnly?' AND r.principal_id=$3':'')+(lock?' FOR UPDATE OF r':''),
 ownerOnly?[ctx.auth.tenantId,id,principal(ctx)]:[ctx.auth.tenantId,id])).rows[0];
 if(!row||!row.request.problem.participants.some(p=>p.principalId===principal(ctx)))throw unavailable();
 const user=(await c.query<{status:string}>('SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE',
  [ctx.auth.tenantId,principal(ctx)])).rows[0];
 if(user?.status!=='active')fail('Y3_ACTIVE_PARTICIPANT_REQUIRED',403);
 await authorize(ctx,row.root,[{type:'work',id:row.work_id}],[],c);
 if(digest(row.request)!==row.request_digest)fail('Y3_ORIGINAL_REQUEST_PREIMAGE');
 return row;
}
export async function sourceClaimTx(ctx:PeMutationContext,c:PoolClient,root:SubmitRequest['root'],source:SourceBinding){
 await authorize(ctx,root,[],[source.sourceId],c);
 // Writers serialize new versions on this stable source. Acquire it before
 // taking the head-query snapshot, and hold it through the native effect.
 if(!(await c.query('SELECT id FROM finnor_os.evidence_sources WHERE tenant_id=$1 AND id=$2 FOR SHARE',
  [ctx.auth.tenantId,source.sourceId])).rowCount)return null;
 const head=(await c.query<{id:string;content_hash:string;snapshot:Record<string,unknown>}>(
  `SELECT id::text,content_hash,snapshot FROM finnor_os.evidence_source_versions
   WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1 FOR SHARE`,
 [ctx.auth.tenantId,source.sourceId])).rows[0];
 if(!head||head.id!==source.versionId||head.content_hash!==source.contentDigest)return null;
 const claims=head.snapshot?.interactionClaims;
 if(!Array.isArray(claims))fail('Y3_TYPED_CANONICAL_CLAIM_REQUIRED');
 const claim=claims.find((v:Record<string,unknown>)=>v.key===source.claimKey) as Record<string,unknown>|undefined;
 if(!claim||!same(source.ref,reference('S1','interaction-claim',claim)))fail('Y3_CANONICAL_CLAIM_PREIMAGE');
 return claim;
}
export async function sourceChangesTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest){
 const changes:string[]=[],models=new Set<string>();let specification=false;
 for(const source of request.sources){
  const claim=await sourceClaimTx(ctx,c,request.root,source);
  if(!claim){changes.push('source:'+source.sourceId);continue;}
  if(claim.profileDigest!==PROFILE_DIGEST||claim.protectionDomain!=='DISPOSABLE_LOCAL_DEVELOPMENT'||
   typeof claim.validUntil!=='string'||!Number.isFinite(Date.parse(claim.validUntil)))fail('Y3_EXACT_DEVELOPMENT_CLAIM_DOMAIN');
  if(Date.parse(claim.validUntil)<=Date.now()){changes.push('source:'+source.sourceId);continue;}
  if(claim.kind==='INTERACTION_SPECIFICATION'){
   if(!same(claim.problem,request.problem)||!same(claim.lowering,request.lowering))fail('Y3_ORIGINAL_SPECIFICATION_MEANING_REQUIRED');
   specification=true;
  }else if(claim.kind==='SUPPLIED_MODEL_QUALIFICATION'){
   const model=request.problem.models.find(m=>m.id===claim.modelId&&same(m.qualificationRef,source.ref));
   if(!model||claim.exactModelSemantics!=='SUPPLIED_NOT_EMPIRICALLY_IDENTIFIED')fail('Y3_QUALIFIED_SUPPLIED_MODEL_BINDING');
   models.add(model.id);
  }else fail('Y3_SOURCE_CLAIM_KIND');
 }
 if(!changes.length&&(!specification||request.problem.models.some(m=>!models.has(m.id))))fail('Y3_CANONICAL_SPECIFICATION_AND_MODELS_REQUIRED');
 const refs=request.problem.models.map(m=>m.qualificationRef);
 if(!same([...request.problem.actorModelRefs].sort((a,b)=>a.id.localeCompare(b.id)),[...refs].sort((a,b)=>a.id.localeCompare(b.id))))
  fail('Y3_EXACT_ACTOR_MODEL_SET_REQUIRED');
 for(const model of request.problem.models)for(const node of model.nodes)
  if(node.kind==='CHANCE'&&!refs.some(r=>same(r,node.probabilityBasis.identificationRef)))fail('Y3_CHANCE_IDENTIFICATION_SCOPE');
 return [...new Set(changes)];
}
export function sameResourceState(resources:Record<string,string>,state:Record<string,string>){
 return Object.keys(resources).length===Object.keys(state).length&&Object.entries(state).every(([id,value])=>
  resources[id]!==undefined&&q(resources[id]!).compare(new Rational(exact(value),1000000n))===0);
}
export async function fixedMeaningsTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest){
 const {row,admission}=await currentEconomicTheoryAdmissionTx(ctx,c,request.lowering.theoryId);
 if(row.work_id!==request.workId||!same(row.root,request.root)||!same(row.artifact!.envelope.contentRef,request.lowering.theoryRef)||
  !same(request.problem.fixedOperatorRefs,[request.lowering.theoryRef]))fail('Y3_FIXED_Y1_MEANING_SCOPE');
 if(request.problem.participants[0].principalId!==principal(ctx))fail('Y3_RESPONSIBLE_PARTICIPANT_REQUIRED',403);
 const seen=new Set<string>();
 for(const outcome of request.lowering.outcomes){
  const model=request.problem.models.find(m=>m.id===outcome.modelId),node=model?.nodes.find(n=>n.id===outcome.terminalNodeId),
   root=model?.nodes.find(n=>n.id===model.root),identity=outcome.modelId+':'+outcome.terminalNodeId;
  if(!node||node.kind!=='TERMINAL'||!root||outcome.terminalDigest!==digest(node)||seen.has(identity)||
   !sameResourceState(root.resources,outcome.before)||!sameResourceState(node.resources,outcome.after)||
   !safe(row.request.problem,outcome.before)||!safe(row.request.problem,outcome.after))fail('Y3_EXACT_ORIGINAL_TERMINAL_LOWERING');
  seen.add(identity);
  if(outcome.kind==='NO_EFFECT'){if(!same(outcome.before,outcome.after))fail('Y3_NO_EFFECT_STATE_MUST_NOT_CHANGE');}
  else{
   const operator=row.candidate!.operators.find(o=>o.id===outcome.operatorId);
   if(!operator||!inDomain(outcome.parameters,row.request.problem.parameters)||
    !same(applyOperator(row.request.problem,operator,outcome.before,outcome.parameters),outcome.after))
    fail('Y3_FIXED_OPERATOR_DENOTATION_REQUIRED');
  }
 }
 if(request.problem.models.some(m=>m.nodes.some(n=>n.kind==='TERMINAL'&&!seen.has(m.id+':'+n.id))))fail('Y3_ALL_ORIGINAL_TERMINAL_BINDINGS_REQUIRED');
 for(const quantity of row.request.problem.quantities){
  const basis=request.problem.resourceLimits[quantity.id]?.basis;
  if(!basis||basis.unit!==quantity.unit||basis.currency!==quantity.currency||basis.owner!==quantity.entityId||
   basis.timeBasis!==quantity.accountingBasis+':'+quantity.period.startAt+'/'+quantity.period.endAt)
   fail('Y3_RESOURCE_UNIT_CURRENCY_OWNER_TIME_BASIS');
 }
 return {theory:row,admission};
}
export async function currentChangesTx(ctx:PeMutationContext,c:PoolClient,row:ProtocolRow){
 const changes=await sourceChangesTx(ctx,c,row.request),work=await workCutTx(ctx,c,row.work_id),
  rights=await employeeAuthoritySnapshotTx(ctx.auth,c);
 if(work.id!==row.work_input_id||work.digest!==row.work_input_digest||!work.executable)changes.push('work');
 if(String(rights.revision)!==row.rights_revision||rights.validUntil&&Date.parse(rights.validUntil)<=Date.now())changes.push('authority');
 const runtime=await productRuntimeIdentity();
 if(runtime.semanticDigest!==row.runtime.semanticDigest)changes.push('runtime');
 try{await fixedMeaningsTx(ctx,c,row.request);}catch{changes.push('y1');}
 if(Date.now()>=row.deadline_at.getTime())changes.push('deadline');
 return [...new Set(changes)];
}
export function dependencyGraph(request:SubmitRequest){
 const sources=request.sources.map(s=>({id:'source:'+s.sourceId,dependsOn:[],digest:digest(s)})),
  base=[{id:'profile',dependsOn:[],digest:PROFILE_DIGEST},{id:'authority',dependsOn:[],digest:digest(request.problem.participants)},
   {id:'work',dependsOn:[],digest:digest(request.workId)},{id:'runtime',dependsOn:[],digest:digest('PINNED_RUNTIME')},
   {id:'deadline',dependsOn:[],digest:digest('ORIGINAL_EPISODE')},{id:'y1',dependsOn:[],digest:digest(request.lowering)}];
 const models=request.problem.models.map(m=>({id:'model:'+m.id,dependsOn:request.sources.filter(s=>
  same(s.ref,m.qualificationRef)||!request.problem.models.some(other=>same(s.ref,other.qualificationRef)))
  .map(s=>'source:'+s.sourceId),digest:digest(m)}));
 return [...base,...sources,...models,
  {id:'policy',dependsOn:[...base.map(b=>b.id),...models.map(m=>m.id)],digest:digest(request.problem.controls)},
  {id:'strategy',dependsOn:['policy',...models.map(m=>m.id)],digest:digest(request.problem)},
  ...models.map(m=>({id:'assessment:'+m.id,dependsOn:['strategy',m.id],digest:m.digest})),
  {id:'independent-check',dependsOn:['strategy',...models.map(m=>'assessment:'+m.id)],digest:digest(request.problem)},
  {id:'admission',dependsOn:['independent-check'],digest:digest('TYPED_DEVELOPMENT_ONLY')}];
}
export async function invalidateTx(c:PoolClient,row:ProtocolRow,changed:string[]){
 if(!changed.length||row.cancelled)return;
 const graph=row.artifact?.envelope.dependencies??[],seeds=changed.filter(id=>graph.some(n=>n.id===id)),
  closure=graph.length&&seeds.length?affectedClosure(graph,seeds):{affectedNodes:graph,keptNodes:[]};
 await eventTx(c,row,'P7_INVALIDATION','invalidation:'+digest(changed),{changed,...closure,originalEpisodeId:row.episode_id,
  oldArtifactsRetained:true,consentsNotRebound:true,reservationsRetained:true,unknownEffectsRetained:true});
 if(row.status!=='INVALIDATED')await c.query("UPDATE finnor_os.y3_requests SET status='INVALIDATED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[row.tenant_id,row.id]);
}
export async function checkedProtocolTx(ctx:PeMutationContext,c:PoolClient,id:string){
 const row=await protocolTx(ctx,c,id),artifact=row.artifact,check=artifact?.envelope.independentChecks.find(x=>x.status==='CHECKED');
 if(row.status!=='CHECKED'||row.cancelled||!artifact?.body||!check)fail('Y3_CURRENT_CHECKED_PROTOCOL_REQUIRED');
 if(!same(row.candidate,artifact.body)||check.candidateDigest!==digest(row.candidate)||check.problemDigest!==digest(row.request.problem)||
  check.profileDigest!==PROFILE_DIGEST||check.checkerDigest!==row.runtime.math.checkerDigest||check.maxRegret!=='0'||
  check.globalBeliefConsistency!==true||check.fullDeviationCoverage!==true||check.resourcesValid!==true||
  check.informationValid!==true||check.participationValid!==true||check.executionAuthorityGranted!==false||
  check.protectedQualification!==false)fail('Y3_INDEPENDENT_CHECK_BINDING');
 if((await currentChangesTx(ctx,c,row)).length)fail('Y3_PROTOCOL_DEPENDENCIES_CHANGED');
 return row;
}
export async function fallbackTx(ctx:PeMutationContext,c:PoolClient,request:SubmitRequest){
 const candidates=(await c.query<{id:string}>(`SELECT id FROM finnor_os.y3_requests WHERE tenant_id=$1 AND principal_id=$2
  AND work_id=$3 AND status='CHECKED' AND NOT cancelled AND admission IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 33`,
 [ctx.auth.tenantId,principal(ctx),request.workId])).rows;
 if(candidates.length>32)return null;
 for(const item of candidates){
  const row=await protocolTx(ctx,c,item.id);
  if(same(row.root,request.root)&&same(row.request.problem,request.problem)&&same(row.request.lowering,request.lowering)&&
   same(row.request.sources,request.sources)&&!(await currentChangesTx(ctx,c,row)).length)return row;
 }
 return null;
}
export async function submitProtocol(ctx:PeMutationContext,request:SubmitRequest){
 developmentOnly();
 if(Buffer.byteLength(JSON.stringify(request))>LIMITS.maxRequestBytes)fail('Y3_REQUEST_BYTE_BOUND',413);
 const runtime=await productRuntimeIdentity();
 return transaction(ctx,async c=>{
  await authorize(ctx,request.root,[{type:'work',id:request.workId}],[],c);
  const requestDigest=digest(request),old=(await c.query<{id:string;request_digest:string;status:string}>(
   'SELECT id,request_digest,status FROM finnor_os.y3_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(old){if(old.request_digest!==requestDigest)fail('Y3_IDEMPOTENCY_CONFLICT',409);return {protocolId:old.id,workId:request.workId,status:old.status,replayed:true};}
  if((await sourceChangesTx(ctx,c,request)).length)fail('Y3_CURRENT_SOURCE_VERSIONS_REQUIRED');
  const {theory}=await fixedMeaningsTx(ctx,c,request),work=await workCutTx(ctx,c,request.workId),
   authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
  if(!work.executable||work.id!==theory.work_input_id)fail('Y3_CURRENT_EXECUTABLE_WORK_REQUIRED');
  const original=(await c.query<{id:string;deadline_at:Date;attempts_used:number}>(
   'SELECT id,deadline_at,attempts_used FROM finnor_os.y3_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE',
   [ctx.auth.tenantId,principal(ctx),request.workId])).rows[0];
  if(original&&(original.deadline_at.getTime()<=Date.now()||original.attempts_used>=LIMITS.maxAttempts))fail('Y3_ORIGINAL_EPISODE_EXHAUSTED');
  const episodeId=original?.id??randomUUID(),id=randomUUID(),
   deadline=new Date(Math.min(Date.now()+LIMITS.maxEpisodeWallMs,theory.deadline_at.getTime()));
  if(!original)await c.query('INSERT INTO finnor_os.y3_episodes(tenant_id,id,principal_id,work_id,deadline_at) VALUES($1,$2,$3,$4,$5)',
   [ctx.auth.tenantId,episodeId,principal(ctx),request.workId,deadline]);
  if(request.parentProtocolId){
   const parent=await protocolTx(ctx,c,request.parentProtocolId);
   if(parent.work_id!==request.workId||parent.episode_id!==episodeId||!same(parent.root,request.root))fail('Y3_ORIGINAL_PARENT_SCOPE_REQUIRED');
  }
  const fallback=await fallbackTx(ctx,c,request);
  await c.query(`INSERT INTO finnor_os.y3_requests(tenant_id,id,principal_id,root,work_id,work_input_id,work_input_digest,
   episode_id,theory_id,request,request_digest,runtime,rights_revision,idempotency_key,fallback_id)
   VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15)`,
  [ctx.auth.tenantId,id,principal(ctx),JSON.stringify(request.root),request.workId,work.id,work.digest,episodeId,theory.id,
   JSON.stringify(request),requestDigest,JSON.stringify(runtime),String(authority.revision),request.idempotencyKey,fallback?.id??null]);
  const row=await protocolTx(ctx,c,id),jobId=await enqueueTx(c,{tenantId:row.tenant_id,principalId:row.principal_id,protocolId:id,generation:1},id+':1');
  await eventTx(c,row,'ACCEPTED','accepted',{requestDigest,profileDigest:PROFILE_DIGEST,runtime,jobId,
   originalEpisodeId:episodeId,fallbackId:fallback?.id??null,sourceParity:'UNKNOWN',protectedAuthorityCreated:false});
  return {protocolId:id,workId:request.workId,status:'QUEUED',jobId,replayed:false};
 });
}
