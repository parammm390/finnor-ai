import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {transactionDb,retainIdentificationEvidenceTx,isImmutableWorkStatus,type WorkStatus,type Db} from '@finnor/db';
import {employeeAuthoritySnapshotTx,canExerciseAuthorityTx} from '@finnor/authority';
import {createEvidenceSourceTx,appendEvidenceVersionTx} from '@finnor/memory';
import type {VReference,DigitalIdentificationCheckInput,IdentifiedSystemRelease} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {closingTx,authorize,unavailable,assertDependencies} from '../owner-context';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {lockPeDeal,requireActivePeDeal,shapePeRow} from '../repository';
import {digitalProviderTarget,requireDisposableIdentification} from '../../../tools/src/identification-provider';
import {sha,ConsentSchema,fail,type IdentificationRow,type ExperimentRow,type InstrumentRow,type FamilyRow,type ModelRow,type IdentificationJob} from './contracts';
import {currentIdentificationEnvironment} from './source-cut';
export {principal} from '../owner-context';
import {principal} from '../owner-context';
export const newId=()=>randomUUID();
export const rootOf=(a:IdentificationRow)=>({entityType:'pe_deal' as const,entityId:a.root_id});
export const vref=(owner:string,id:string,contentDigest:string,revision='1'):VReference=>({owner,id,revision,contentDigest});
export const allocationRef=(a:IdentificationRow)=>vref('S5_ORIGINAL_IDENTIFICATION_ALLOCATION',a.id,sha({requestDigest:a.request_digest,deadlineAt:a.deadline_at.toISOString(),limits:a.request.limits}));
export const snapshot=(value:unknown)=>JSON.parse(JSON.stringify(value));
export function tx<T>(ctx:PeMutationContext,fn:(c:PoolClient,db:Db)=>Promise<T>):Promise<T>{
 return closingTx(ctx,async(c,db)=>{
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c),result=await fn(c,db);
  if(authority.validUntil)await assertAuthorityTemporalBoundsTx(c,[authority.validUntil]);
  return result;
 });
}
export async function capabilityTx(ctx:PeMutationContext,c:PoolClient,root:ReturnType<typeof rootOf>,capability:string,resources:Array<{type:string;id:string}>=[]){
 await authorize(ctx,root,resources,[],c);
 if(!await canExerciseAuthorityTx(ctx.auth,{operation:capability.startsWith('query:')?'query':'action',capability,resource:{type:root.entityType,id:root.entityId},risk:'low'},c))throw unavailable();
}
export async function consentTx(ctx:PeMutationContext,c:PoolClient,id:string,rootId:string,current=true){
 const r=(await c.query<{body:unknown;body_digest:string;owner_id:string;root_id:string}>('SELECT * FROM finnor_os.x4_consents WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,id])).rows[0];
 if(!r||r.root_id!==rootId||sha(r.body)!==r.body_digest)throw unavailable();
 const body=ConsentSchema.parse(r.body);
 if(!body.actorIds.includes(principal(ctx)))throw unavailable();
 if(current){
  if(Date.parse(body.validUntil)<=Date.now()||(await c.query('SELECT consent_id FROM finnor_os.x4_consent_revocations WHERE tenant_id=$1 AND consent_id=$2',[ctx.auth.tenantId,id])).rowCount)fail('X4_EXPERIMENT_RIGHTS_REVOKED_OR_EXPIRED',403);
  await assertAuthorityTemporalBoundsTx(c,[body.validUntil]);
 }
 return {...r,body};
}
export async function identificationTx(ctx:PeMutationContext,c:PoolClient,id:string,capability='query:identified_system'){
 const a=(await c.query<IdentificationRow>('SELECT * FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.auth.tenantId,id])).rows[0];
 if(!a)throw unavailable();
 await capabilityTx(ctx,c,rootOf(a),capability,[{type:'work',id:a.work_id},{type:'pe_workstream',id:a.request.decision.workstreamId},{type:'pe_investment_case',id:a.request.decision.investmentCaseId}]);
 await consentTx(ctx,c,a.consent_id,a.root_id,false);
 return a;
}
export function assertAllocation(a:IdentificationRow){
 if(['CANCELLED','INVALIDATED'].includes(a.status))fail('X4_'+a.status);
 if(a.deadline_at.getTime()<=Date.now())fail('X4_ORIGINAL_DEADLINE_EXPIRED');
}
export async function assertRunCurrentTx(ctx:PeMutationContext,c:PoolClient,a:IdentificationRow){
 requireDisposableIdentification();assertAllocation(a);
 const environment=currentIdentificationEnvironment();void environment.catch(()=>undefined);
 requireActivePeDeal(await lockPeDeal(c,a.tenant_id,a.root_id));
 const canonicalWork=(await c.query<{status:WorkStatus}>('SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenant_id,a.work_id])).rows[0];
 if(!canonicalWork||isImmutableWorkStatus(canonicalWork.status))fail('X4_CANONICAL_WORK_NOT_EXECUTABLE');
 const work=await workCutTx(c,a);
 if(work.id!==a.work_input_id||work.digest!==a.work_input_digest)fail('X4_WORK_INPUT_CHANGED');
 const rights=await consentTx(ctx,c,a.consent_id,a.root_id);
 if(sha(rights.body.domain)!==sha(a.request.domain)||!rights.body.targetIds.includes(a.request.sourceTargetId)||!rights.body.targetIds.includes(a.request.replicationTargetId))fail('X4_EXACT_CONSENT_SCOPE_CHANGED');
 await assertDependencies(ctx,a.dependencies,c,true);
 const current=await environment;
 if(sha(current)!==sha(a.environment))fail('X4_DEPENDENCY_OR_RUNTIME_CHANGED');
 const targets=[];
 for(const targetId of [a.request.sourceTargetId,a.request.replicationTargetId]){
  let b;try{b=await digitalProviderTarget({tenantId:a.tenant_id,rootId:a.root_id,targetId});}catch{throw unavailable();}
  if(b.bindingDigest!==a.target_digests[targetId]||b.role!==a.request.domain.role||b.applicationVersion!==a.request.domain.applicationVersion)fail('X4_APPLICATION_ROLE_VERSION_OR_CREDENTIAL_CHANGED');
  targets.push(b);
 }
 const bounds=[a.deadline_at.toISOString(),rights.body.validUntil,...targets.map(t=>t.validUntil)];
 await assertAuthorityTemporalBoundsTx(c,bounds);
 return {rights,targets,bounds};
}
export async function eventTx(c:PoolClient,a:IdentificationRow,actor:string,kind:string,key:string,body:unknown){
 return (await c.query<{id:string}>('INSERT INTO finnor_os.x4_events(tenant_id,identification_id,actor_id,kind,idempotency_key,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,identification_id,idempotency_key) DO NOTHING RETURNING id::text',
  [a.tenant_id,a.id,actor,kind,key,JSON.stringify(body)])).rows[0]?.id;
}
export async function enqueueTx(c:PoolClient,p:IdentificationJob,key:string){
 return (await c.query<{id:string}>("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane) VALUES($1,'identify_digital_system_v1',$2::jsonb,$3,1,8,'interactive') ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id",
  [p.tenantId,JSON.stringify(p),key])).rows[0]!.id;
}
export async function familyTx(c:PoolClient,a:IdentificationRow){
 const r=(await c.query<FamilyRow>('SELECT * FROM finnor_os.x4_families WHERE tenant_id=$1 AND identification_id=$2',[a.tenant_id,a.id])).rows[0];
 if(!r||sha(r.body)!==r.body_digest)fail('X4_COMPLETE_FAMILY_UNAVAILABLE');
 return r!;
}
export async function experimentsTx(c:PoolClient,a:IdentificationRow){
 return (await c.query<ExperimentRow>('SELECT * FROM finnor_os.x4_experiments WHERE tenant_id=$1 AND identification_id=$2 ORDER BY created_at,id',[a.tenant_id,a.id])).rows;
}
export async function instrumentTx(c:PoolClient,a:IdentificationRow,id:string){
 const r=(await c.query<InstrumentRow>('SELECT * FROM finnor_os.x4_instruments WHERE tenant_id=$1 AND identification_id=$2 AND id=$3',[a.tenant_id,a.id,id])).rows[0];
 if(!r||sha(r.body)!==r.body_digest||r.body.disposition!=='VALIDATED_DEVELOPMENT')fail('X4_INDEPENDENTLY_VALIDATED_INSTRUMENT_REQUIRED');
 if(!await instrumentValidationTx(c,a,r))fail('X4_INDEPENDENTLY_VALIDATED_INSTRUMENT_REQUIRED');
 return r!;
}
export async function instrumentValidationTx(c:PoolClient,a:IdentificationRow,row:InstrumentRow){
 const receipt=(await c.query("SELECT body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND kind='INSTRUMENT_INDEPENDENTLY_VALIDATED' AND idempotency_key=$3",
  [a.tenant_id,a.id,'instrument-checked:'+row.id])).rows[0]?.body;
 if(!receipt)return false;
 if(receipt.instrumentId!==row.id||receipt.certificateDigest!==row.body_digest||receipt.checkerDigest!==a.environment.checkerDigest||receipt.controlsDigest!==sha(row.body.controls))fail('X4_INDEPENDENT_INSTRUMENT_RECEIPT_CHANGED');
 return true;
}
export async function evidenceTx(c:PoolClient,db:Db,a:IdentificationRow,actorId:string,key:string,title:string,body:unknown){
 const content=JSON.stringify(body);
 if(Buffer.byteLength(content)>262144)fail('X4_RAW_EVIDENCE_TRANSACTION_BOUND');
 const source=await createEvidenceSourceTx(db,a.tenant_id,{sourceKey:'x4:'+a.id+':'+key,sourceType:'x4_digital_observation',title,metadata:{identificationId:a.id,root:rootOf(a),developmentOnly:true}});
 const appended=await appendEvidenceVersionTx(db,a.tenant_id,source.id,{content,snapshot:{schema:'finnor.x4.evidence-snapshot.v1',identificationId:a.id,bodyDigest:sha(body),developmentOnly:true},
  entityRefs:[{type:'pe_deal',id:a.root_id},{type:'work',id:a.work_id}]});
 await retainIdentificationEvidenceTx(c,{tenantId:a.tenant_id,identificationId:a.id,principalId:actorId,sourceId:source.id,versionId:appended.versionId});
 return appended;
}
export async function rawCheckInputTx(c:PoolClient,a:IdentificationRow,onlyIds?:string[]):Promise<DigitalIdentificationCheckInput>{
 const family=await familyTx(c,a),experiments=(await experimentsTx(c,a)).filter(e=>e.status==='OBSERVED'&&e.phase!=='DECISION_USE'&&(!onlyIds||onlyIds.includes(e.id)));
 if(onlyIds&&(experiments.length!==onlyIds.length||sha(experiments.map(e=>e.id))!==sha(onlyIds)))fail('X4_CHECKED_EXPERIMENT_MEMBERSHIP_CHANGED');
 const raw=[];
 for(const e of experiments){
  if(sha(e.protocol)!==e.protocol_digest||!e.raw||!e.result)fail('X4_PROTOCOL_OR_RAW_EVIDENCE_INTEGRITY');
  const instrument=await instrumentTx(c,a,e.instrument_id);
  const effect=(await c.query<{id:string;request_hash:string;business_effect_id:string;execution_state:string;status:string}>(
   'SELECT id,request_hash,business_effect_id,execution_state,status FROM finnor_os.external_operations WHERE tenant_id=$1 AND domain_action_id=$2 AND operation_key=$3',
   [a.tenant_id,e.protocol.effect.domainActionId,e.protocol.effect.operationKey])).rows[0];
  if(!effect)fail('X4_CANONICAL_ORIGINAL_EFFECT_UNAVAILABLE');
  raw.push({protocol:e.protocol,registeredAt:e.created_at.toISOString(),raw:e.raw,instrument:instrument.body,
   effectObservation:{operationId:effect!.id,requestDigest:effect!.request_hash,domainActionId:e.protocol.effect.domainActionId,businessEffectId:effect!.business_effect_id,
    executionState:effect!.execution_state,status:effect!.status,trialId:e.id}});
 }
 return {domain:a.request.domain,family:family.body,experiments:raw,authorId:a.owner_id,requestedClaimClass:a.request.question.requestedClaimClass};
}
export async function modelTx(c:PoolClient,a:IdentificationRow,id=a.head_model_id){
 if(!id)fail('X4_MODEL_UNAVAILABLE');
 const r=(await c.query<ModelRow>('SELECT * FROM finnor_os.x4_models WHERE tenant_id=$1 AND identification_id=$2 AND id=$3',[a.tenant_id,a.id,id])).rows[0];
 if(!r||sha(r.body)!==r.body_digest)fail('X4_MODEL_INTEGRITY');
 return r!;
}
/** Live S1/S3/P7 check, never authority from a transported artifact or old grade. */
export async function assertModelCurrentTx(ctx:PeMutationContext,c:PoolClient,a:IdentificationRow,m:IdentifiedSystemRelease){
 const current=await assertRunCurrentTx(ctx,c,a);
 if(a.status!=='DEVELOPMENT_READY'||a.head_model_id!==m.id||Date.parse(m.validUntil)<=Date.now())fail('X4_MODEL_NOT_CURRENT');
 if((await c.query('SELECT id FROM finnor_os.x4_invalidations WHERE tenant_id=$1 AND identification_id=$2 AND (model_id IS NULL OR model_id=$3) LIMIT 1',[a.tenant_id,a.id,m.id])).rowCount)fail('X4_MODEL_INVALIDATED');
 if((await c.query("SELECT id FROM finnor_os.x4_assignments WHERE tenant_id=$1 AND identification_id=$2 AND status<>'COMPLETE' LIMIT 1",[a.tenant_id,a.id])).rowCount)fail('X4_REPLICATION_INCOMPLETE_OR_FAILED');
 const checkInput=await rawCheckInputTx(c,a,m.experimentRefs.map(r=>r.id));
 if(sha(checkInput)!==m.check.inputDigest||sha(m.check)!==m.checkDigest||m.check.disposition!=='SUPPORTED_DEVELOPMENT'||sha(m.check.analysis)!==sha(m.analysis))fail('X4_CHECKED_NATIVE_INPUT_CHANGED');
 const evidenceRefs=[...m.instrumentRefs,...m.observationRefs].filter(r=>r.owner==='CORE_EVIDENCE_VERSION');
 await authorize(ctx,rootOf(a),[],evidenceRefs.map(r=>r.id),c);
 for(const r of evidenceRefs){
  const v=(await c.query<{id:string;content_hash:string}>('SELECT id,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1',[a.tenant_id,r.id])).rows[0];
  if(!v||v.id!==r.revision||v.content_hash!==r.contentDigest)fail('X4_OBSERVATION_CORRECTED_OR_INVALIDATED');
 }
 const finding=(await c.query('SELECT * FROM finnor_os.pe_findings WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenant_id,m.canonicalFindingRef.id])).rows[0];
 if(!finding||sha(snapshot(shapePeRow(finding)))!==m.canonicalFindingRef.contentDigest)fail('X4_CANONICAL_FINDING_CHANGED');
 await assertAuthorityTemporalBoundsTx(c,[...current.bounds,m.validUntil]);
 return current;
}
