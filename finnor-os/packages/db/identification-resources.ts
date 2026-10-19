/** S5 native digital-experiment allocation adapter. Counters are a projection of
 * append-only original-parent charges, never money or a replenishable grant. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
export type IdentificationResourceKind='EXPERIMENT'|'OBSERVATION'|'ANALYSIS'|'USE';
const columns={
 EXPERIMENT:['experiment_count','max_experiments'],OBSERVATION:['observation_count','max_observations'],
 ANALYSIS:['analysis_count','max_analysis'],USE:['use_count','max_uses'],
} as const;
export async function reserveIdentificationResourceTx(c:PoolClient,input:{
 tenantId:string;identificationId:string;principalId:string;kind:IdentificationResourceKind;idempotencyKey:string;detail:Record<string,unknown>;
}){
 const [used,max]=columns[input.kind];
 const prior=(await c.query<{id:string;kind:string;body:unknown}>('SELECT id,kind,body FROM finnor_os.s5_identification_charges WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=$3',
  [input.tenantId,input.identificationId,input.idempotencyKey])).rows[0];
 if(prior){if(prior.kind!==input.kind||JSON.stringify(prior.body)!==JSON.stringify(input.detail)){
   // JSONB key order differs from wire order. Compare semantic equality in SQL.
   const same=(await c.query('SELECT $1::jsonb=$2::jsonb ok',[JSON.stringify(prior.body),JSON.stringify(input.detail)])).rows[0]?.ok;
   if(prior.kind!==input.kind||!same)throw Error('X4_RESOURCE_IDEMPOTENCY_CONFLICT');
  }return prior.id;
 }
 const updated=await c.query(`UPDATE finnor_os.x4_identifications SET ${used}=${used}+1
  WHERE tenant_id=$1 AND id=$2 AND ${used}<${max} AND deadline_at>clock_timestamp() AND status NOT IN('CANCELLED','INVALIDATED')
  RETURNING id`,[input.tenantId,input.identificationId]);
 if(updated.rowCount!==1)throw Error('X4_ORIGINAL_'+input.kind+'_ALLOCATION_EXHAUSTED');
 const id=randomUUID();
 await c.query('INSERT INTO finnor_os.s5_identification_charges(tenant_id,id,identification_id,actor_id,kind,amount,idempotency_key,body) VALUES($1,$2,$3,$4,$5,1,$6,$7::jsonb)',
  [input.tenantId,id,input.identificationId,input.principalId,input.kind,input.idempotencyKey,JSON.stringify(input.detail)]);
 return id;
}
/** Canonical Evidence duplicates scientific payload into immutable versions and
 * searchable chunks. Charge those actual logical rows to the same original
 * parent too, once per version. This is not physical disk or financial metering. */
export async function retainIdentificationEvidenceTx(c:PoolClient,input:{
 tenantId:string;identificationId:string;principalId:string;sourceId:string;versionId:string;
}){
 const key='canonical-evidence:'+input.versionId;
 const prior=(await c.query('SELECT id,kind,body FROM finnor_os.s5_identification_charges WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=$3',
  [input.tenantId,input.identificationId,key])).rows[0];
 if(prior){
  if(prior.kind!=='RETAINED_BYTES'||prior.body.sourceId!==input.sourceId||prior.body.versionId!==input.versionId)throw Error('X4_RESOURCE_IDEMPOTENCY_CONFLICT');
  return prior.id as string;
 }
 const measured=(await c.query(`SELECT sum(octet_length(r.body::text))::int bytes FROM (
  SELECT to_jsonb(s) body FROM finnor_os.evidence_sources s WHERE s.tenant_id=$1 AND s.id=$2 AND s.metadata->>'identificationId'=$4
  UNION ALL SELECT to_jsonb(v) FROM finnor_os.evidence_source_versions v WHERE v.tenant_id=$1 AND v.source_id=$2 AND v.id=$3
  UNION ALL SELECT to_jsonb(k) FROM finnor_os.evidence_chunks k WHERE k.tenant_id=$1 AND k.source_id=$2 AND k.version_id=$3
 ) r`,[input.tenantId,input.sourceId,input.versionId,input.identificationId])).rows[0]?.bytes;
 if(!Number.isSafeInteger(measured)||measured<=0)throw Error('X4_CANONICAL_EVIDENCE_STORAGE_UNAVAILABLE');
 const reserved=await c.query(`UPDATE finnor_os.x4_identifications SET data_bytes=data_bytes+$3
  WHERE tenant_id=$1 AND id=$2 AND data_bytes<=16777216-$3 AND deadline_at>clock_timestamp()
   AND status NOT IN('CANCELLED','INVALIDATED') RETURNING id`,[input.tenantId,input.identificationId,measured]);
 if(reserved.rowCount!==1)throw Error('X4_ORIGINAL_RETAINED_BYTES_ALLOCATION_EXHAUSTED');
 const id=randomUUID();
 await c.query(`INSERT INTO finnor_os.s5_identification_charges(tenant_id,id,identification_id,actor_id,kind,amount,idempotency_key,body)
  VALUES($1,$2,$3,$4,'RETAINED_BYTES',$5,$6,$7::jsonb)`,[input.tenantId,id,input.identificationId,input.principalId,measured,key,
   JSON.stringify({sourceId:input.sourceId,versionId:input.versionId,unit:'CANONICAL_LOGICAL_RETAINED_BYTES_INCLUDING_CHUNKS',bytes:measured})]);
 return id;
}
