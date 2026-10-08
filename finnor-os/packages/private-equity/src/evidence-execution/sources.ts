import {randomUUID} from 'node:crypto';
import type {BeliefView,EvidenceDependency,EvidenceHandle,EvidenceSource,EvidenceWitness,FinancialRow,FinancialSemantics} from '@finnor/shared-types';
import {loadEnterpriseBeliefView} from '../enterprise-beliefs';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,assertDependencies,currentDerivation,principal,revisions,sameRevisions,sha,stable,tx,unavailable} from './store';
import {canonicalExact,exactScale} from './exact';
import {extractDocumentRows} from './documents';
import {NativeFailure} from './backend';
import {readModelSource} from './model-sources';

export interface LoadedSource {nativeInvocations:import('./backend').BackendReceipt[];rows:FinancialRow[];witnesses:EvidenceWitness[];view:BeliefView;dependencies:EvidenceDependency[];coverage:EvidenceHandle['coverage'];sourceCounts:Array<{id:string;expected:number;actual:number}>;contradictions:unknown[]}
const instant=(v:string|Date)=>new Date(v).toISOString();
export function rowFields(metricKey:string,value:string,semantics:FinancialSemantics,recordId:string){return {recordId,metricKey,value,...Object.fromEntries(Object.entries(semantics).map(([k,v])=>[k,v]))} as Record<string,string|null>;}
export async function loadSource(ctx:PeMutationContext,root:PeWorldRootRef,source:EvidenceSource,times:{validAt?:string;knowledgeAt?:string}={}):Promise<LoadedSource>{
 await authorize(ctx,root);let subject=root;let keys=['rights:tenant',`canonical:${root.entityType}:${root.entityId}`];
 if('periodStart' in source&&Date.parse(source.periodStart)>Date.parse(source.periodEnd))throw Error('EXACT_ORDERED_FINANCIAL_PERIOD_REQUIRED');
 if(source.kind!=='derivation'){subject=source.subject as PeWorldRootRef;await authorize(ctx,subject,source.kind==='artifact'?[{type:'document',id:source.documentId}]:[]);
  if(source.kind==='metric'){if(source.calendar!=='OWNER_RECORDED'||source.consolidation!=='OWNER_SUBJECT_ONLY'||source.instrument!=='UNSPECIFIED'||source.scale!=='1'||source.sign!=='AS_RECORDED')throw Error('CANONICAL_CALENDAR_CONSOLIDATION_INSTRUMENT_SCALE_SIGN_ATTESTATION_UNAVAILABLE');
   keys.push(`metric-series:${subject.entityType}:${subject.entityId}:${source.metricKey}`);
   const series=await tx(ctx,c=>c.query<{id:string}>('SELECT id::text FROM finnor_os.pe_metric_series WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND ($4=\'*\' OR metric_key=$4) ORDER BY id LIMIT 65',[ctx.auth.tenantId,subject.entityType,subject.entityId,source.metricKey]),true);if(series.rows.length>64)throw Error('METRIC_SERIES_CANDIDATE_BOUND');keys.push(...series.rows.flatMap(s=>['metric-observations:'+s.id,'canonical:pe_metric_series:'+s.id]));
  }else if(source.kind==='artifact')keys.push('document:'+source.documentId,'document-binding:'+source.documentVersionId);
  else keys.push('model-version:'+source.modelVersionId,'model-run:'+source.runId);
 }else keys.push('derivation:'+source.derivationId);
 keys.push(`canonical:${subject.entityType}:${subject.entityId}`);
 const before=await revisions(ctx,keys);const view=await loadEnterpriseBeliefView(ctx,{root:subject,validAt:times.validAt,knowledgeAt:times.knowledgeAt,maxClaims:1000});
 // Refine only selected immutable numeric records. Preserve S1's partial
 // auxiliary Work/Document status and every candidate/byte/history restriction.
 if(view.coverage.truncated||view.coverage.canonicalStatus==='UNAVAILABLE_BEFORE_BASELINE')throw Error('S1_PERMITTED_CANONICAL_COVERAGE_UNAVAILABLE');
 if(view.coverage.canonicalStatus==='PARTIAL'){
  const auxiliary=/^(Core Work relationship metadata has no temporal version|Core Document metadata has no temporal version|Task .* changed after stateAt|Core approval requests have no temporal versions|Core DecisionReceipts have no temporal versions|No provider source coverage existed)/;
  if(view.coverage.reasons.some(reason=>!auxiliary.test(reason)))throw Error('S1_PERMITTED_CANONICAL_COVERAGE_UNAVAILABLE');
  const required=[...new Set(source.kind==='metric'?[subject.entityType,'pe_metric_series','pe_metric_observation']:[subject.entityType])];
  const coverage=await tx(ctx,c=>c.query<{complete:boolean}>("SELECT current_setting('track_commit_timestamp')='on' AND (SELECT count(*) FROM finnor_os.canonical_history_coverage WHERE entity_type=ANY($1::text[]) AND coverage_started_at<=$2)=cardinality($1::text[]) complete",[required,view.knowledgeAt]),true);
  if(!coverage.rows[0]?.complete)throw Error('SELECTED_CANONICAL_HISTORY_OR_COMMIT_VISIBILITY_UNAVAILABLE');
 }
 if(Buffer.byteLength(stable(view))>8388608)throw Error('S1_SERIALIZATION_BOUND');
 let nativeInvocations:import('./backend').BackendReceipt[]=[];let rows:FinancialRow[]=[],witnesses:EvidenceWitness[]=[],sourceCounts:LoadedSource['sourceCounts']=[],reasons:string[]=[];
 if(source.kind==='metric'){
  const permitted=view.claims.filter(c=>['pe_metric_series','pe_metric_observation'].includes(c.ownerRef.entityType)).map(c=>({entity_type:c.ownerRef.entityType,entity_id:c.ownerRef.id,entity_version:Number(c.ownerRef.revisionId.split(':').at(-1)),snapshot_hash:c.ownerRef.contentDigest}));
  const selected=await tx(ctx,c=>c.query<{id:string;entity_version:number;snapshot_hash:string;value:string;period_start:string;period_end:string;metric_key:string;source_id:string;version_id:string;total:string}>(`WITH selected AS (
   SELECT h.* FROM finnor_os.canonical_entity_versions h JOIN jsonb_to_recordset($2::jsonb) p(entity_type text,entity_id uuid,entity_version integer,snapshot_hash text)
    ON h.entity_type=p.entity_type AND h.entity_id=p.entity_id AND h.entity_version=p.entity_version AND h.snapshot_hash=p.snapshot_hash WHERE h.tenant_id=$1
  ), series AS(SELECT * FROM selected WHERE entity_type='pe_metric_series' AND snapshot->>'subject_type'=$3 AND snapshot->>'subject_id'=$4 AND ($5='*' OR snapshot->>'metric_key'=$5)
   AND snapshot->>'unit'=$6 AND snapshot->>'currency_code' IS NOT DISTINCT FROM $7::text AND snapshot->>'frequency'=$8)
  SELECT o.entity_id::text id,o.entity_version,o.snapshot_hash,o.snapshot->>'value_numeric' value,o.snapshot->>'period_start' period_start,o.snapshot->>'period_end' period_end,
   s.snapshot->>'metric_key' metric_key,o.snapshot->>'evidence_source_id' source_id,o.snapshot->>'evidence_version_id' version_id,count(*) OVER()::text total
  FROM selected o JOIN series s ON s.entity_id::text=o.snapshot->>'metric_series_id'
  WHERE o.entity_type='pe_metric_observation' AND o.snapshot->>'superseded_at' IS NULL AND o.snapshot->>'value_type'='number'
   AND (o.snapshot->>'period_start')::timestamptz=$9 AND (o.snapshot->>'period_end')::timestamptz=$10 ORDER BY o.entity_id LIMIT 1001`,
   [ctx.auth.tenantId,stable(permitted),subject.entityType,subject.entityId,source.metricKey,source.unit,source.currencyCode,source.frequency,source.periodStart,source.periodEnd]),true);
  if(selected.rows.length>1000||Number(selected.rows[0]?.total??0)>1000)throw Error('SELECTED_SOURCE_ROW_BOUND');
  const sourceIds=[...new Set(selected.rows.map(r=>r.source_id).filter(Boolean))];await authorize(ctx,subject,selected.rows.map(r=>({type:'pe_metric_observation',id:r.id})),sourceIds);
  for(const r of selected.rows){if(r.value===null)throw Error('CANONICAL_NUMERIC_FIELD_UNAVAILABLE');const semantics:FinancialSemantics={entityType:subject.entityType,entityId:subject.entityId,periodStart:instant(r.period_start),periodEnd:instant(r.period_end),unit:source.unit,currencyCode:source.currencyCode,frequency:source.frequency,calendar:source.calendar,consolidation:source.consolidation,instrument:source.instrument,scale:'1',sign:'AS_RECORDED'};
   const value=canonicalExact(r.value),id='canonical:'+r.id+':'+r.entity_version+':value_numeric';witnesses.push({id,sourceKind:'canonical',owner:'S1_CANONICAL_POSTGRES',recordId:r.id,version:String(r.entity_version),contentDigest:r.snapshot_hash,field:'value_numeric',rawValue:r.value,anchor:{},semantics,modulePath:['S1:canonical_entity_versions','P4:exact-field-selection'],uncertainty:['OWNER_RECORD_INTEGRITY_IS_NOT_BUSINESS_TRUTH']});rows.push({recordId:r.id,metricKey:r.metric_key,value,semantics,witnessIds:[id],fields:rowFields(r.metric_key,value,semantics,r.id)});}
  sourceCounts.push({id:'selected:'+source.metricKey,expected:Number(selected.rows[0]?.total??0),actual:rows.length});if(!rows.length)reasons.push('EXACT_SUBJECT_METRIC_PERIOD_UNIT_CURRENCY_UNAVAILABLE');
 }else if(source.kind==='artifact'){
  const extraction=await extractDocumentRows(ctx,root,source,{knowledgeAt:view.knowledgeAt});rows=extraction.rows;witnesses=extraction.witnesses;reasons=extraction.reasons;sourceCounts=extraction.sourceCounts;nativeInvocations=extraction.nativeInvocations;
 }else if(source.kind==='model'){
  const model=await readModelSource(ctx,source,{knowledgeAt:view.knowledgeAt,validAt:view.validAt});rows=[model.row];witnesses=model.witnesses;keys.push(...model.keys);before.push(...model.dependencies.filter(d=>!before.some(b=>b.key===d.key)));sourceCounts.push({id:'model:'+source.runId+':'+source.output,expected:1,actual:1});
 }else{
  const derivation=await currentDerivation(ctx,source.derivationId),output=derivation.result?.outputs[source.output];if(!output||output.kind!=='scalar'||output.value===null||!output.semantics)throw Error('PRIOR_MATERIAL_DERIVATION_OUTPUT_UNAVAILABLE');
  rows=[{recordId:derivation.id,metricKey:source.output,value:output.value,semantics:output.semantics,witnessIds:output.witnessIds,fields:rowFields(source.output,output.value,output.semantics,derivation.id)}];witnesses=derivation.witnesses.filter(w=>output.witnessIds.includes(w.id)).map(w=>({...w,modulePath:[...w.modulePath,'P4:derivation:'+derivation.id]}));keys.push(...derivation.invalidationKeys.map(d=>d.key));
  const additional=derivation.invalidationKeys.filter(d=>!before.some(b=>b.key===d.key));before.push(...additional);sourceCounts.push({id:'prior:'+derivation.id,expected:1,actual:1});
 }
 const after=await revisions(ctx,keys);if(!sameRevisions(before,after))throw Error('SOURCE_CHANGED_DURING_PERMISSIONED_READ');
 await authorize(ctx,root);await authorize(ctx,subject);
 const dependencies=after.map(d=>({...d,digest:d.key.startsWith('canonical:')?view.claims.find(c=>`canonical:${c.ownerRef.entityType}:${c.ownerRef.id}`===d.key)?.ownerRef.contentDigest??null:null}));
 const groups=new Map<string,FinancialRow[]>();for(const row of rows){const key=stable({metricKey:row.metricKey,semantics:row.semantics});groups.set(key,[...(groups.get(key)??[]),row]);}
 const contradictions=[...groups].filter(([,v])=>new Set(v.map(r=>r.value)).size>1).map(([logicalKey,v])=>({logicalKey,values:v.map(r=>r.value),witnessIds:v.flatMap(r=>r.witnessIds),resolution:'UNRESOLVED'}));
 return {nativeInvocations,rows,witnesses,view,dependencies,coverage:{status:reasons.length?'PARTIAL':'COMPLETE',rowCount:rows.length,reasons},sourceCounts,contradictions};
}
export function sourceDigest(loaded:LoadedSource){return sha({rows:loaded.rows,witnesses:loaded.witnesses,coverage:loaded.coverage});}
export async function createHandle(ctx:PeMutationContext,root:PeWorldRootRef,inputId:string,source:EvidenceSource,times:{validAt?:string;knowledgeAt?:string}={}){const acquiredAt=Date.now();let loaded:LoadedSource;try{loaded=await loadSource(ctx,root,source,times);}catch(error){const receipt=error instanceof NativeFailure?error.receipt:null;await tx(ctx,c=>c.query('INSERT INTO finnor_os.p4_acquisition_attempts(id,tenant_id,principal_id,body) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),ctx.auth.tenantId,principal(ctx),stable({root,sourceDigest:sha(source),times,status:'FAILED',predicate:String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'SOURCE_OR_INTERPRETATION_UNAVAILABLE',wallMs:Date.now()-acquiredAt,receipt,costUSD:null,costStatus:'LOCAL_COST_UNMETERED',workRevision:null})]));throw error;}const handle:EvidenceHandle={schema:'finnor.evidence-handle.v1',id:randomUUID(),inputId,tenantId:ctx.auth.tenantId,principalId:principal(ctx),root,source,acquisitionInvocations:loaded.nativeInvocations,rightsRevision:loaded.view.rights.revision,validAt:loaded.view.validAt,knowledgeAt:loaded.view.knowledgeAt,expiresAt:new Date(Date.now()+15*60*1000).toISOString(),digest:sourceDigest(loaded),dependencies:loaded.dependencies,coverage:loaded.coverage};await tx(ctx,c=>c.query('INSERT INTO finnor_os.p4_handles(id,tenant_id,principal_id,body,digest) VALUES($1,$2,$3,$4::jsonb,$5)',[handle.id,ctx.auth.tenantId,principal(ctx),stable(handle),sha(handle)]));return handle;}
export async function loadHandle(ctx:PeMutationContext,id:string,root:PeWorldRootRef){await authorize(ctx,root);const row=await tx(ctx,async c=>(await c.query<{body:EvidenceHandle;digest:string}>('SELECT body,digest FROM finnor_os.p4_handles WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,principal(ctx),id])).rows[0],true);if(!row||sha(row.body)!==row.digest||stable(row.body.root)!==stable(root)||Date.parse(row.body.expiresAt)<=Date.now())throw unavailable();await assertDependencies(ctx,row.body.dependencies);return row.body;}
export async function materializeHandle(ctx:PeMutationContext,handle:EvidenceHandle){const loaded=await loadSource(ctx,handle.root as PeWorldRootRef,handle.source,{validAt:handle.validAt,knowledgeAt:handle.knowledgeAt});await assertDependencies(ctx,handle.dependencies);if(sourceDigest(loaded)!==handle.digest)throw Error('PINNED_SOURCE_DIGEST_CHANGED');return loaded;}
