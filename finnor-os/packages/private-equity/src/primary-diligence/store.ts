import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {PrimaryGovernanceSchema,type PrimaryGovernance,type PrimaryIntake,type PrimaryProgrammeStatus,type VReference,type PrimaryObservation,type IndependentlyEstablishedFinding} from '@finnor/shared-types';
import {authorizeBeliefResources,authorizeBeliefSourceScopes,loadEnterpriseBeliefView} from '../enterprise-beliefs';
import {PeDomainError,type PeMutationContext,type PeWorldRootRef} from '../types';
import {assertDependencies,revisions,codeIdentity,schemaIdentity} from '../evidence-execution/store';
import {canonical,digest as hash} from '../../../governed-execution/src/canonical';
import {principal as actor,tx} from '../owner-context';
export {actor,tx};
export {canonical,hash};
export const unavailable=()=>new PeDomainError('PE_ENTITY_NOT_FOUND','Primary evidence is unavailable in the authenticated scope');
export function reference(owner:string,id:string,revision:string|number,body:unknown):VReference{return {owner,id,revision:String(revision),contentDigest:hash(body)};}
export async function currentActor(ctx:PeMutationContext,c?:PoolClient){
 const action=async(client:PoolClient)=>{if(ctx.auth.role!=='owner'||actor(ctx)!==ctx.auth.userId)throw unavailable();const readOnly=(await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only==='on';const row=(await client.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND role='owner' AND status='active'"+(readOnly?'':' FOR SHARE'),[ctx.auth.tenantId,actor(ctx)])).rows[0];if(!row)throw unavailable();};
 return c?action(c):tx(ctx,action);
}
export async function authorize(ctx:PeMutationContext,root:PeWorldRootRef,workId?:string,c?:PoolClient){
 await currentActor(ctx,c);try{await authorizeBeliefResources(ctx,[{type:root.entityType,id:root.entityId},...(workId?[{type:'work',id:workId}]:[])],c);}catch{throw unavailable();}
}
const ownerBySchema={'finnor.primary-source-profile.v1':'S1','finnor.primary-authority.v1':'S6','finnor.primary-consent.v1':'S1','finnor.primary-reference-semantics.v1':'S2','finnor.primary-mandate.v1':'S4','finnor.primary-grant.v1':'S5'} as const;
export function governanceIdentity(body:PrimaryGovernance):{id:string;revision:number;owner:string}{
 return {id:'profileId' in body?body.profileId:'consentId' in body?body.consentId:'grantId' in body?body.grantId:body.mandateId,revision:body.revision,owner:ownerBySchema[body.schema]};
}
export async function putGovernance(ctx:PeMutationContext,value:unknown,expectedRef:VReference|null){
 const body=PrimaryGovernanceSchema.parse(value);await currentActor(ctx);
 if(body.environment!=='DEVELOPMENT'||process.env.NODE_ENV==='production'||process.env.FINNOR_V2_PROFILE!=='ordinary_disposable')throw Error('LIVE_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
 if('issuingPrincipalId' in body&&body.issuingPrincipalId!==actor(ctx)||'authorizedActorId' in body&&body.authorizedActorId!==actor(ctx)||'acceptedBy' in body&&body.acceptedBy!==actor(ctx))throw unavailable();
 return putOwnerRecord(ctx,body,governanceIdentity(body),expectedRef);
}
/** Shared append-only owner registry. Callers validate their registered schema and
 * activity domain before entry; this helper never grants live/effect authority. */
export async function putOwnerRecord(ctx:PeMutationContext,body:{schema:string;revision:number},
 identity:{id:string;revision:number;owner:string},expectedRef:VReference|null){
 const ref=reference(identity.owner,identity.id,identity.revision,body);
 return tx(ctx,async c=>{
  await currentActor(ctx,c);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72))',[ctx.auth.tenantId+':'+identity.id]);
  const old=(await c.query('SELECT v.*,h.state FROM finnor_os.primary_governance_heads h JOIN finnor_os.primary_governance_versions v USING(tenant_id,id,revision) WHERE h.tenant_id=$1 AND h.id=$2 FOR UPDATE OF h',[ctx.auth.tenantId,identity.id])).rows[0];
  if(old?.revision===identity.revision&&old.digest===ref.contentDigest&&old.state==='CURRENT')return ref;
  if(old?old.issuer_id!==actor(ctx)||!expectedRef||hash(expectedRef)!==hash(reference(old.semantic_owner,old.id,old.revision,old.body))||identity.revision!==old.revision+1:expectedRef!==null||identity.revision!==1)throw Error('GOVERNANCE_REVISION_OR_ISSUER_CONFLICT');
  await c.query('INSERT INTO finnor_os.primary_governance_versions(tenant_id,id,revision,semantic_owner,schema_name,issuer_id,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[ctx.auth.tenantId,identity.id,identity.revision,identity.owner,body.schema,actor(ctx),canonical(body),ref.contentDigest]);
  await c.query("INSERT INTO finnor_os.primary_governance_heads(tenant_id,id,revision,state) VALUES($1,$2,$3,'CURRENT') ON CONFLICT(tenant_id,id) DO UPDATE SET revision=excluded.revision,state='CURRENT',reason=null",[ctx.auth.tenantId,identity.id,identity.revision]);return ref;
 });
}
export async function ownerRecord(ctx:PeMutationContext,ref:VReference,c?:PoolClient,retained=false):Promise<unknown>{
 const action=async(client:PoolClient)=>{
  const row=(await client.query(`SELECT v.*,h.state,h.revision current_revision FROM finnor_os.primary_governance_versions v
   JOIN finnor_os.primary_governance_heads h ON h.tenant_id=v.tenant_id AND h.id=v.id
   WHERE v.tenant_id=$1 AND v.id=$2 AND v.revision=$3`,[ctx.auth.tenantId,ref.id,Number(ref.revision)])).rows[0];
  if(!row||row.semantic_owner!==ref.owner||row.digest!==ref.contentDigest||hash(row.body)!==row.digest||
   !retained&&(row.state!=='CURRENT'||row.current_revision!==row.revision))throw Error('CURRENT_EXACT_GOVERNANCE_UNAVAILABLE');
  return row.body;
 };return c?action(c):tx(ctx,action,true);
}
export async function governance<T extends PrimaryGovernance>(ctx:PeMutationContext,ref:VReference,schema:T['schema']|null,c?:PoolClient):Promise<T>{
 const action=async(client:PoolClient)=>{const row=(await client.query('SELECT v.*,h.state FROM finnor_os.primary_governance_versions v JOIN finnor_os.primary_governance_heads h USING(tenant_id,id,revision) WHERE v.tenant_id=$1 AND v.id=$2 AND v.revision=$3',[ctx.auth.tenantId,ref.id,Number(ref.revision)])).rows[0];
  if(!row||row.state!=='CURRENT'||schema!==null&&row.schema_name!==schema||row.semantic_owner!==ref.owner||hash(row.body)!==row.digest||row.digest!==ref.contentDigest)throw Error('CURRENT_EXACT_GOVERNANCE_UNAVAILABLE');
  const body=PrimaryGovernanceSchema.parse(row.body);if(body.schema!==row.schema_name||ownerBySchema[body.schema]!==ref.owner)throw Error('CURRENT_EXACT_GOVERNANCE_UNAVAILABLE');if(body.environment!=='DEVELOPMENT')throw Error('LIVE_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');return body as T;};
 return c?action(c):tx(ctx,action,true);
}
/** A retained issued obligation is not a current permission. Only the S6
 * cost/status recovery path may use this historical governance payload. */
export async function retainedGovernance<T extends PrimaryGovernance>(ctx:PeMutationContext,ref:VReference,schema:T['schema']):Promise<T>{
 return tx(ctx,async c=>{await currentActor(ctx,c);const row=(await c.query('SELECT * FROM finnor_os.primary_governance_versions WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND issuer_id=$4',[ctx.auth.tenantId,ref.id,Number(ref.revision),actor(ctx)])).rows[0];
  if(!row||row.schema_name!==schema||row.semantic_owner!==ref.owner||row.digest!==ref.contentDigest||hash(row.body)!==row.digest)throw unavailable();
  const body=PrimaryGovernanceSchema.parse(row.body);if(body.environment!=='DEVELOPMENT')throw unavailable();return body as T;});
}
export async function revokeGovernance(ctx:PeMutationContext,ref:VReference,reason:string){
 return tx(ctx,async c=>{await currentActor(ctx,c);const body=(await c.query('SELECT v.*,h.state FROM finnor_os.primary_governance_heads h JOIN finnor_os.primary_governance_versions v USING(tenant_id,id,revision) WHERE h.tenant_id=$1 AND h.id=$2 FOR UPDATE OF h',[ctx.auth.tenantId,ref.id])).rows[0];
  if(!body||body.issuer_id!==actor(ctx)||hash(reference(body.semantic_owner,body.id,body.revision,body.body))!==hash(ref))throw unavailable();
  await c.query("UPDATE finnor_os.primary_governance_heads SET state='REVOKED',reason=$3 WHERE tenant_id=$1 AND id=$2",[ctx.auth.tenantId,ref.id,reason]);return {ref,state:'REVOKED',derivativeAccess:'DENIED',responsibility:'RETAINED'};});
}
export interface Programme {
 id:string;tenant_id:string;principal_id:string;root:PeWorldRootRef;work_id:string;work_input_id:string;work_input_digest:string;
 intake:PrimaryIntake;intake_digest:string;starting_manifest:{knowledgeCut:string;refs:VReference[];evidence:unknown[];dependencies:Array<{key:string;revision:number;nodeIds:string[];digest:null}>};starting_digest:string;
 revision:number;status:PrimaryProgrammeStatus;invalidated:boolean;cancellation_requested_at:Date|null;
 active_claim_token:string|null;active_claim_fence:number|null;principal_artifact_id:string|null;reason:string|null;
 next_obligations:VReference[];required_approvals:VReference[];
}
export async function programme(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<Programme>{
 const action=async(client:PoolClient)=>{const row=(await client.query<Programme>('SELECT * FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[ctx.auth.tenantId,actor(ctx),id])).rows[0];if(!row)throw unavailable();if(hash(row.intake)!==row.intake_digest||hash(row.starting_manifest)!==row.starting_digest)throw Error('FROZEN_PROGRAMME_DIGEST_MISMATCH');return row;};
 return c?action(c):tx(ctx,action,true);
}
export async function event(ctx:PeMutationContext,p:Programme|{id:string},owner:string,kind:string,body:unknown,c?:PoolClient){
 const action=(client:PoolClient)=>client.query('INSERT INTO finnor_os.v2_events(tenant_id,principal_id,programme_id,semantic_owner,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[ctx.auth.tenantId,actor(ctx),p.id,owner,kind,canonical(body)]);
 return c?action(c):tx(ctx,action);
}
export async function exactWork(ctx:PeMutationContext,p:Pick<Programme,'work_id'|'work_input_id'|'work_input_digest'>,c:PoolClient){
 const row=(await c.query("SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[ctx.auth.tenantId,p.work_id])).rows[0];
 if(!row||row.id!==p.work_input_id||hash(row.body)!==p.work_input_digest)throw Error('EXACT_WORK_REVISION_CHANGED');
}
export async function assertClaim(ctx:PeMutationContext,p:Programme,execution:{jobId:string;claimToken:string;claimFence:number},c:PoolClient,allowCancelled=false){
 await currentActor(ctx,c);const row=(await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE",[execution.jobId,ctx.auth.tenantId,execution.claimToken,execution.claimFence])).rows[0];
 if(!row||p.active_claim_token!==execution.claimToken||Number(p.active_claim_fence)!==execution.claimFence||(!allowCancelled&&(p.cancellation_requested_at||p.invalidated)))throw Error('PRIMARY_JOB_OR_PROGRAMME_FENCED');
}
export async function observations(ctx:PeMutationContext,p:Programme):Promise<PrimaryObservation[]>{
 return tx(ctx,async c=>{const rows=(await c.query('SELECT body,digest FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY retrieved_at,id LIMIT 129',[ctx.auth.tenantId,actor(ctx),p.id])).rows;
  if(rows.length>128)throw Error('OBSERVATION_BOUND_EXHAUSTED');return rows.map(r=>{if(hash(r.body)!==r.digest)throw Error('CANONICAL_RAW_OBSERVATION_DIGEST_MISMATCH');return r.body as PrimaryObservation;});},true);
}
export async function methodIdentity(){
 const code=await codeIdentity();const checker=await readFile(new URL('./checker.mts',import.meta.url)),spec=await readFile(new URL('./checker-spec.md',import.meta.url));
 return {code,checker:reference('P4','primary-raw-evidence-checker','1',{code:hash(checker),specification:hash(spec)}),lockDigest:hash(await readFile(new URL('../../../../../package-lock.json',import.meta.url)))};
}
export async function rightsBinding(ctx:PeMutationContext,root:PeWorldRootRef,c?:PoolClient){
 // Inside an owner transaction only the current rights witness is needed.
 // Reuse S1's transaction-aware policy/source checks, not another pool lease
 // or an unrelated world reconstruction/ExperienceLedger publication.
 if(c){const rights=await authorizeBeliefResources(ctx,[{type:root.entityType,id:root.entityId}],c);
  await authorizeBeliefSourceScopes(ctx,root,[],c);
  return {rightsRef:reference('S1','rights:'+ctx.auth.tenantId,rights.revision,{tenantId:ctx.auth.tenantId,rightsRevision:rights.revision}),rightsRevision:rights.revision,pin:null};}
 const view=await loadEnterpriseBeliefView(ctx,{root,maxClaims:1000});
 return {rightsRef:reference('S1','rights:'+ctx.auth.tenantId,view.rights.revision,{tenantId:ctx.auth.tenantId,rightsRevision:view.rights.revision}),rightsRevision:view.rights.revision,pin:view.pin};
}
export async function currentFinding(ctx:PeMutationContext,id:string,client?:PoolClient,lock=false):Promise<{finding:IndependentlyEstablishedFinding;programme:Programme}>{
 const action=async(c:PoolClient)=>{const row=(await c.query('SELECT body,digest,programme_id FROM finnor_os.v2_findings WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,actor(ctx),id])).rows[0];if(!row)throw unavailable();
  const finding=row.body as IndependentlyEstablishedFinding,p=await programme(ctx,row.programme_id,c);await authorize(ctx,p.root,p.work_id,c);
  if(hash(finding)!==row.digest)throw Error('FINDING_DIGEST_MISMATCH');const {contentDigest,...preimage}=finding;if(hash(preimage)!==contentDigest)throw Error('FINDING_CONTENT_DIGEST_MISMATCH');
  // A changed sibling finding invalidates programme progression, not an
  // otherwise current independent scope. Its own exact dependency vector fences it.
  if(p.cancellation_requested_at||Date.now()>=Date.parse(finding.freshnessAndReacquisitionConditions.expiresAt))throw Error('FINDING_INVALIDATED_EXPIRED_OR_CANCELLED');
  if(p.intake.predecessorRef)await (await import('../bilateral-opportunities/handoff')).resolveBilateralPredecessor(ctx,p.intake,c);
  const identity=await methodIdentity();if(finding.producerDigest!==identity.code.digest||finding.dependencyLockDigest!==identity.lockDigest||!finding.independentCheckRefs.some(r=>r.contentDigest===identity.checker.contentDigest))throw Error('FINDING_METHOD_OR_CHECKER_CHANGED');
  await assertDependencies(ctx,finding.invalidationDependencies.map(d=>({...d,nodeIds:[],digest:null})),c,lock);await exactWork(ctx,p,c);
  const used=(await c.query('SELECT body FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND id=ANY($4::uuid[])',[ctx.auth.tenantId,actor(ctx),p.id,finding.actualPrimaryObservationRefs.map(r=>r.id)])).rows.map(r=>r.body as PrimaryObservation);
  if(used.length!==finding.actualPrimaryObservationRefs.length)throw Error('PRIMARY_FINDING_ASSIGNED_OBSERVATION_MISSING');
  const ownerRefs=[...new Map([...used.flatMap(o=>[o.request.consentRef,o.request.sourceProfileRef]),finding.domainProfileRef,p.intake.authorityProfileRef,p.intake.mandateRef,p.intake.budgetGrantRef].map(ref=>[hash(ref),ref])).values()];
  for(const ref of ownerRefs){
   const body=await governance(ctx,ref,null,c);if(Date.now()>=Date.parse(body.expiresAt))throw Error('GOVERNANCE_EXPIRED');
   if('retention' in body&&Date.now()>=Date.parse(body.retention.derivativesUntil))throw Error('DERIVATIVE_RETENTION_EXPIRED');
  }
  return {finding,programme:p};};
 // The predecessor uses this exact scoped client, including read-only reads.
 // Final persistence additionally locks this consumer's dependency vector.
 return client?action(client):tx(ctx,action,!lock);
}
export async function costReceipts(ctx:PeMutationContext,p:Programme,grant:import('@finnor/shared-types').PrimaryGrant){
 return tx(ctx,async c=>(await c.query('SELECT * FROM finnor_os.s5_primary_charges WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY created_at,charge_key',[ctx.auth.tenantId,actor(ctx),p.id])).rows.map(r=>r.receipt??({
  id:r.charge_key,owner:'S5',requestId:r.request_id,kind:r.kind,microUsd:r.actual_micro_usd,reservedMicroUsd:r.reserved_micro_usd,possibleAdditionalMicroUsd:r.possible_additional_micro_usd,
  cpuMicros:r.actual_cpu_micros,wallMs:0,peakMemoryBytes:null,bytes:Number(r.bytes),humanSeconds:r.human_seconds,pricebookRef:grant.pricebook.ref,status:'UNKNOWN',reasons:['INTENT_RETAINED_PHYSICAL_OUTCOME_OR_FINAL_METER_UNKNOWN'],
 } as import('@finnor/shared-types').PrimaryCostReceipt)),true);
}
export {assertDependencies,revisions,schemaIdentity};
export const newId=()=>randomUUID();
