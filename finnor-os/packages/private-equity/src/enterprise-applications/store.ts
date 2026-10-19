import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {canExerciseAuthorityTx,employeeScopedRoleKeysTx} from '@finnor/authority';
import type {EnterpriseApplicationRelease} from '@finnor/shared-types';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,principal,revisions,closingTx as tx,unavailable} from '../owner-context';
import {applicationDigest,applicationCanonical,ApplicationFault,type BusinessSpecification,type ApplicationExecutionContext,type ApplicationValues,type ApplicationApprovalReceipt} from './contracts';
import type {BuiltApplication} from './compiler';
import type {ApplicationCheck} from './checker';
import type {ApplicationEnvironment} from './source-cut';
export {tx,principal};
export function fail(code:string,message=code,status=409):never{throw new ApplicationFault(code,message,status);}
export interface ApplicationRow{
 tenant_id:string;id:string;owner_id:string;root_type:PeWorldRootRef['entityType'];root_id:string;work_id:string;
 generation:number;status:string;head_release_id:string|null;deadline_at:Date;max_builds:number;max_mutations:number;
 build_count:number;mutation_count:number;release_count:number;data_bytes:string;request_digest:string;
}
export interface BuildRow{
 tenant_id:string;id:string;application_id:string;generation:number;specification:BusinessSpecification;specification_digest:string;
 base_release_id:string|null;change_class:EnterpriseApplicationRelease['maintenance']['changeClass'];
 work_input_id:string;work_input_digest:string;environment:ApplicationEnvironment;migration:MigrationStep[];
 status:string;attempt_count:number;install_not_before:Date;
}
export type MigrationStep={kind:'ADD_FIELD';entityId:string;field:string;value:ApplicationValues[string]};
export interface ReleaseBody{package:EnterpriseApplicationRelease;built:BuiltApplication;check:ApplicationCheck;specification:BusinessSpecification;environment:ApplicationEnvironment;migration:MigrationStep[]}
export interface RecordRow{
 id:string;tenant_id:string;application_id:string;entity_id:string;author_id:string;origin_release_id:string;release_id:string;schema_release_id:string;
 content_revision:number;concurrency_revision:number;state:string;values:ApplicationValues;content_digest:string;
 approvals:ApplicationApprovalReceipt[];prepared_intent:unknown;pending_effect_id:string|null;
}
export const rootOf=(a:ApplicationRow):PeWorldRootRef=>({entityType:a.root_type,entityId:a.root_id});
export const recordReference=(r:RecordRow)=>({owner:'X3',id:r.id,revision:String(r.content_revision),contentDigest:r.content_digest});
/** PostgreSQL timestamps are Date objects; durable evidence is JSON with ISO
 * timestamps. This does not parse, round or otherwise transform quantities. */
export const recordSnapshot=(r:RecordRow):unknown=>JSON.parse(JSON.stringify(r));
/** Hash bounded records separately so a legal dataset does not inherit the
 * single-contract JSON node ceiling. Array order and every preimage are bound. */
export function recordSetDigest(records:readonly unknown[]):string{
 if(records.length>1000)fail('APPLICATION_RECORD_BOUND');
 return applicationDigest({schema:'finnor.x3.record-set-digest.v1',records:records.map(r=>applicationDigest(r,1024*1024))});
}
export function assertAllocation(a:ApplicationRow){
 if(a.status==='CANCELLED')fail('APPLICATION_CANCELLED');
 if(a.deadline_at.getTime()<=Date.now())fail('ORIGINAL_APPLICATION_DEADLINE_EXPIRED');
}
export async function applicationTx(ctx:PeMutationContext,c:PoolClient,id:string,capability='query:enterprise_application'){
 const a=(await c.query<ApplicationRow>('SELECT * FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.auth.tenantId,id])).rows[0];
 if(!a)throw unavailable();
 await authorize(ctx,rootOf(a),[],[],c);
 if(!await canExerciseAuthorityTx(ctx.auth,{operation:capability.startsWith('query:')?'query':'action',capability,resource:{type:a.root_type,id:a.root_id},risk:'low'},c))throw unavailable();
 return a;
}
export async function releaseTx(c:PoolClient,a:ApplicationRow,id=a.head_release_id){
 if(!id)fail('APPLICATION_NOT_INSTALLED');
 const row=(await c.query<{body:ReleaseBody;body_digest:string}>('SELECT body,body_digest FROM finnor_os.x3_releases WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[a.tenant_id,a.id,id])).rows[0];
 if(!row||applicationDigest(row.body,16*1024*1024)!==row.body_digest)fail('APPLICATION_RELEASE_INTEGRITY');
 return row.body;
}
export async function recordTx(c:PoolClient,a:ApplicationRow,id:string){
 const r=(await c.query<RecordRow>('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND id=$3 FOR UPDATE',[a.tenant_id,a.id,id])).rows[0];
 if(!r)throw unavailable();return r;
}
export async function workCutTx(c:PoolClient,a:Pick<ApplicationRow,'tenant_id'|'work_id'>){
 await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenant_id,a.work_id]);
 const r=(await c.query('SELECT id,instruction_text,context_snapshot,context_snapshot_hash FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[a.tenant_id,a.work_id])).rows[0];
 if(!r)fail('CANONICAL_WORK_INPUT_REQUIRED');return {id:r.id as string,digest:applicationDigest(r)};
}
export async function authorityTx(ctx:PeMutationContext,c:PoolClient,a:ApplicationRow,employee=principal(ctx),temporalBounds?:string[]){
 const auth={...ctx.auth,userId:employee,employeeId:employee};
 const snapshot=await employeeScopedRoleKeysTx(auth,[{type:a.root_type,id:a.root_id}],c);
 if(snapshot.validUntil)temporalBounds?.push(snapshot.validUntil);
 const current=await canExerciseAuthorityTx(auth,{operation:'action',capability:'action:operate_enterprise_application',resource:{type:a.root_type,id:a.root_id},risk:'low'},c);
 return {principalId:employee,canonicalRoles:snapshot.roles,authorityRevision:String(snapshot.revision),authorityCurrent:current,tenantId:a.tenant_id,scopeId:a.root_id};
}
/** Authority locks prevent edits, not the passage of an assignment's original
 * expiry. Check its owner-provided boundary after writes, before committing. */
export async function assertAuthorityTemporalBoundsTx(c:PoolClient,temporalBounds:readonly string[]){
 if(!temporalBounds.length)return;
 const boundary=Math.min(...temporalBounds.map(value=>Date.parse(value)));
 if(!Number.isFinite(boundary))fail('APPLICATION_AUTHORITY_EXPIRED');
 const current=(await c.query<{still_current:boolean}>('SELECT clock_timestamp()<$1::timestamptz AS still_current',[new Date(boundary).toISOString()])).rows[0];
 if(!current?.still_current)fail('APPLICATION_AUTHORITY_EXPIRED');
}
/** Cache only inside this transaction. Each later command/effect stage obtains
 * a new current owner snapshot, never authority from a previous stage. */
export async function approverAuthoritiesTx(ctx:PeMutationContext,c:PoolClient,a:ApplicationRow,spec:BusinessSpecification,
 receipts:ApplicationApprovalReceipt[],actor:Awaited<ReturnType<typeof authorityTx>>,temporalBounds?:string[]){
 const authorities=new Map<string,Awaited<ReturnType<typeof authorityTx>>|null>([[actor.principalId,actor]]);
 const current:ApplicationExecutionContext['currentAuthorities']=[];
 for(const receipt of receipts){
  if(!authorities.has(receipt.principalId)){
   try{authorities.set(receipt.principalId,await authorityTx(ctx,c,a,receipt.principalId,temporalBounds));}catch{authorities.set(receipt.principalId,null);}
  }
  const authority=authorities.get(receipt.principalId),canonicalRole=spec.model.roles.find(r=>r.id===receipt.role)?.canonicalRole;
  if(canonicalRole&&!current.some(x=>x.principalId===receipt.principalId&&x.canonicalRole===canonicalRole))current.push({
   principalId:receipt.principalId,canonicalRole,authorityRevision:authority?.authorityRevision??'UNAVAILABLE',
   current:!!authority?.authorityCurrent&&authority.canonicalRoles.includes(canonicalRole),tenantId:a.tenant_id,scopeId:a.root_id});
 }
 return current;
}
export function evidenceCurrentness(values:ApplicationValues,currentEvidence:ApplicationExecutionContext['currentEvidence']){
 return Object.values(values).every(v=>typeof v!=='object'||!('kind' in v)||v.kind!=='EVIDENCE'||
  currentEvidence.some(e=>applicationCanonical(e)===applicationCanonical(v)))?'CURRENT' as const:'STALE' as const;
}
/** The same compiled literals participate in command and effect currentness.
 * Referenced approval rules and entity invariants are part of that action. */
export function actionLiterals(program:BuiltApplication['program'],actionId:string,entityId:string):ApplicationValues{
 const action=program.actions.find(x=>x.id===actionId&&x.entityId===entityId);
 if(!action)fail('UNKNOWN_ACTION');
 const approvalSource=action.approval?action:program.actions.find(x=>x.id===action.requiresApprovalsFrom);
 const codes=[...action.assignments.map(x=>x.code),...action.guards.map(x=>x.code),
  ...(approvalSource?.approval?.requirements.map(x=>x.code)??[]),...program.invariants.filter(x=>x.entityId===entityId).map(x=>x.code)];
 const literals:ApplicationValues={};let count=0;
 for(const code of codes)for(const instruction of code)if(instruction.op==='PUSH')literals['literal'+count++]=instruction.value;
 return literals;
}
/** All source/rights/Work locks are the existing P4 owner keys. The source's
 * insert trigger must commit after our decision or be visible before it. */
export async function valueSetsFactsTx(ctx:PeMutationContext,c:PoolClient,a:ApplicationRow,valueSets:readonly ApplicationValues[]){
 const evidence=new Set<string>(),relations=new Map<string,ApplicationExecutionContext['currentRelations'][number]>();
 for(const values of valueSets)for(const v of Object.values(values)){
  if(typeof v!=='object')continue;
  if('kind' in v&&v.kind==='EVIDENCE')evidence.add(v.sourceId);
  if('kind' in v&&v.kind==='RELATION')relations.set(applicationCanonical(v),v);
  const qs='kind' in v&&v.kind==='QUANTITY'?[v]:'kind' in v&&v.kind==='QUANTITY_LIST'?v.entries:[];
  for(const q of qs)if(q.entity.id!==a.root_id)fail('QUANTITY_ENTITY_SCOPE_MISMATCH','Quantity entity must be the authorized application root',422);
 }
 const sourceIds=[...evidence].sort();
 if(sourceIds.some(s=>!/^[a-f0-9-]{36}$/i.test(s)))fail('CANONICAL_EVIDENCE_REFERENCE_REQUIRED','Evidence IDs must resolve in the canonical source owner',422);
 await revisions(ctx,['rights:tenant','work-inputs:'+a.work_id,...sourceIds.map(id=>'evidence:'+id)],c,true);
 await authorize(ctx,rootOf(a),[],sourceIds,c);
 const currentEvidence:ApplicationExecutionContext['currentEvidence']=[];
 if(sourceIds.length){
  const sources=(await c.query(`SELECT s.id AS source_id,v.id,v.content_hash FROM finnor_os.evidence_sources s
   LEFT JOIN LATERAL(SELECT id,content_hash FROM finnor_os.evidence_source_versions
    WHERE tenant_id=s.tenant_id AND source_id=s.id ORDER BY version_number DESC,id DESC LIMIT 1)v ON true
   WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY s.id`,[a.tenant_id,sourceIds])).rows;
  if(sources.length!==sourceIds.length)throw unavailable();
  for(const v of sources)if(v.id)currentEvidence.push({kind:'EVIDENCE',sourceId:v.source_id,versionId:v.id,contentDigest:v.content_hash});
 }
 const currentRelations:ApplicationExecutionContext['currentRelations']=[];
 const relationIds=[...new Set([...relations.values()].filter(r=>r.reference.owner==='X3'&&/^[a-f0-9-]{36}$/i.test(r.reference.id)).map(r=>r.reference.id))].sort();
 if(relationIds.length){
  const rows=(await c.query<RecordRow>('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND id=ANY($3::uuid[])',[a.tenant_id,a.id,relationIds])).rows;
  const byId=new Map(rows.map(r=>[r.id,r]));
  for(const relation of relations.values()){
   const r=relation.reference.owner==='X3'?byId.get(relation.reference.id):undefined;
   if(r&&r.entity_id===relation.entityId&&applicationCanonical(recordReference(r))===applicationCanonical(relation.reference))currentRelations.push(relation);
  }
 }
 return {currentEvidence,currentRelations};
}
export async function factsTx(ctx:PeMutationContext,c:PoolClient,a:ApplicationRow,values:ApplicationValues){
 const facts=await valueSetsFactsTx(ctx,c,a,[values]);
 return {...facts,currentness:evidenceCurrentness(values,facts.currentEvidence)};
}
export async function priorEventTx(c:PoolClient,a:ApplicationRow,actor:string,key:string,digest:string){
 const row=(await c.query<{body:any;request_digest:string}>('SELECT body,request_digest FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND actor_id=$3 AND idempotency_key=$4',[a.tenant_id,a.id,actor,key])).rows[0];
 if(row&&row.request_digest!==digest)fail('APPLICATION_IDEMPOTENCY_CONFLICT');
 return row?.body??null;
}
export async function eventTx(c:PoolClient,a:ApplicationRow,actor:string,kind:string,key:string,digest:string,body:unknown,recordId:string|null=null,buildId:string|null=null,mutation=false){
 const bytes=Buffer.byteLength(applicationCanonical(body));
 if(bytes>1024*1024||Number(a.data_bytes)+bytes>16*1024*1024)fail('APPLICATION_STORAGE_BOUND');
 if(mutation&&a.mutation_count>=a.max_mutations)fail('ORIGINAL_APPLICATION_MUTATION_BOUND');
 await c.query('INSERT INTO finnor_os.x3_events(tenant_id,application_id,record_id,build_id,actor_id,kind,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',[a.tenant_id,a.id,recordId,buildId,actor,kind,key,digest,JSON.stringify(body)]);
 const charged=(await c.query<{data_bytes:string}>('UPDATE finnor_os.x3_applications SET mutation_count=mutation_count+$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING data_bytes',[a.tenant_id,a.id,mutation?1:0])).rows[0]!;
 a.data_bytes=charged.data_bytes;if(mutation)a.mutation_count++;
}
export async function enqueueBuildTx(c:PoolClient,a:ApplicationRow,b:BuildRow,stage:'BUILD'|'INSTALL'){
 return (await c.query<{id:string}>("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane,run_at) VALUES($1,'build_enterprise_application_v1',$2::jsonb,$3,1,16,'interactive',$4) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id",
  [a.tenant_id,JSON.stringify({tenantId:a.tenant_id,principalId:a.owner_id,applicationId:a.id,buildId:b.id,generation:b.generation,stage}),`x3:${b.id}:${stage}`,stage==='INSTALL'?b.install_not_before:new Date()])).rows[0]!.id;
}
export const newId=()=>randomUUID();
