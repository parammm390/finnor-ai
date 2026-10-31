/** Read-only collector. No selection, admission, recovery, or checker imports. */
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function recoveryCut(admin:any,programId:string,searchId:string,label:string,directory:string){
 await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const one=async(sql:string,args:any[]=[])=>{const rows=(await admin.query(sql,args)).rows;
   if(rows.length!==1)throw Error('EXACT_SQL_ROW_REQUIRED:'+label);return rows[0];};
  const parent=await one('SELECT * FROM finnor_os.p1_requests WHERE id=$1',[programId]);
  const search=await one('SELECT * FROM finnor_os.p2_requests WHERE id=$1 AND tenant_id=$2 AND principal_id=$3',
   [searchId,parent.tenant_id,parent.principal_id]);
  if(search.program_id!==parent.id)throw Error('ORIGINAL_SEARCH_PARENT_REQUIRED');
  const scope=[parent.tenant_id,parent.principal_id,searchId],tenant=[parent.tenant_id];
  const scoped=async(table:string)=>(await admin.query(
   `SELECT * FROM finnor_os.${table} WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id`,scope)).rows;
  const units=await scoped('p2_units'),attempts=await scoped('p2_attempts'),events=await scoped('p2_events');
  const episode=await one('SELECT * FROM finnor_os.p1_episodes WHERE id=$1',[parent.episode_id]);
  const jobs=(await admin.query(`SELECT * FROM finnor_os.jobs
   WHERE tenant_id=$1 AND (payload->>'searchId'=$2 OR payload->>'programId'=$3 OR payload->>'queryId'=$4)
   ORDER BY run_at,id`,[parent.tenant_id,searchId,programId,parent.evidence_query_id])).rows;
  const deliveries=(await admin.query('SELECT * FROM finnor_os.job_delivery_attempts WHERE job_id=ANY($1::uuid[]) ORDER BY started_at,id',
   [jobs.map((j:any)=>j.id)])).rows;
  const leases=(await admin.query('SELECT * FROM finnor_os.compute_resource_leases WHERE tenant_key=$1 ORDER BY acquired_at,id',
   [parent.tenant_id])).rows;
  const usage=(await admin.query('SELECT * FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4',
   [parent.tenant_id,parent.principal_id,search.request.computeGrant.contentDigest,search.binding.resourceId])).rows;
  const sources=(await admin.query(`SELECT to_jsonb(s) series,to_jsonb(o) observation,o.value_numeric::text "valueNumeric"
   FROM finnor_os.pe_metric_series s JOIN finnor_os.pe_metric_observations o ON o.tenant_id=s.tenant_id AND o.metric_series_id=s.id
   WHERE s.tenant_id=$1 AND s.subject_type=$2 AND s.subject_id=$3 AND s.metric_key=ANY($4::text[])
   ORDER BY s.metric_key,o.period_start,o.revision,o.id`,
   [parent.tenant_id,parent.request.root.entityType,parent.request.root.entityId,parent.request.sources.map((s:any)=>s.key)])).rows;
  const sourceVersions=(await admin.query('SELECT * FROM finnor_os.evidence_source_versions WHERE id=ANY($1::uuid[]) ORDER BY id',
   [[...new Set(sources.map((r:any)=>r.observation.evidence_version_id))]])).rows;
  const inputs=(await admin.query('SELECT * FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id',
   [parent.tenant_id,parent.work_id])).rows;
  const work=await one('SELECT * FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',[parent.tenant_id,parent.work_id]);
  const programs=(await admin.query('SELECT * FROM finnor_os.p1_programs WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id',
   [parent.tenant_id,parent.principal_id,parent.id])).rows;
  const plans=(await admin.query('SELECT * FROM finnor_os.p2_plans WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY revision,id',scope)).rows;
  const p1Events=(await admin.query('SELECT * FROM finnor_os.p1_events WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id',
   [parent.tenant_id,parent.principal_id,parent.id])).rows;
  const derivations=(await admin.query('SELECT * FROM finnor_os.p4_derivations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
   [parent.tenant_id,parent.principal_id,search.context.derivationId])).rows;
  const reservations=(await admin.query('SELECT * FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2',
   [parent.tenant_id,search.request.computeGrant.contentDigest])).rows;
  const reservationOrigins=(await admin.query('SELECT * FROM finnor_os.s5_reservation_origins WHERE tenant_id=$1 AND allocation_digest=$2',
   [parent.tenant_id,search.request.computeGrant.contentDigest])).rows;
  const consumptions=(await admin.query(`SELECT c.*,to_jsonb(s) state FROM finnor_os.s5_consumptions c
   JOIN finnor_os.s5_consumption_states s USING(tenant_id,consumption_id) WHERE c.tenant_id=$1 ORDER BY c.consumption_id`,tenant)).rows;
  const effects=(await admin.query('SELECT * FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY id',tenant)).rows;
  const capsules=await scoped('w1_capsules');
  const responses=(await admin.query('SELECT * FROM finnor_os.w1_response_states WHERE tenant_id=$1 AND principal_id=$2 ORDER BY created_at,digest',
   [parent.tenant_id,parent.principal_id])).rows;
  const clock=await one('SELECT clock_timestamp() at,pg_backend_pid() observer_pid');
  const waits=(await admin.query(`SELECT pid,application_name,usename,state,wait_event_type,wait_event,
   pg_blocking_pids(pid) blockers,left(query,1024) query FROM pg_stat_activity
   WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' ORDER BY pid`)).rows;
  const locks=(await admin.query(`SELECT l.pid,l.locktype,l.mode,l.granted,l.classid::text,l.objid::text,l.objsubid,
   CASE WHEN l.relation IS NULL THEN NULL ELSE l.relation::regclass::text END relation
   FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database()
   AND (l.locktype='advisory' OR l.relation='finnor_os.p1_events'::regclass) ORDER BY l.pid,l.locktype,l.mode`)).rows;
  const result={label,clock,parent,search,episode,work,inputs,programs,plans,p1Events,derivations,units,attempts,events,jobs,deliveries,
   leases,usage,sources,sourceVersions,reservations,reservationOrigins,consumptions,effects,capsules,responses,waits,locks};
  await admin.query('COMMIT');
  await writeFile(join(directory,label+'.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  return result;
 }catch(error){await admin.query('ROLLBACK');throw error;}
}
