import { createCipheriv,createDecipheriv,randomBytes,randomUUID } from 'node:crypto';
import { withTenantClientTransaction } from '@finnor/db';
import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';
import { principal } from '../decision-slice/adapters';
import { canonicalJson } from '../../../epistemic-runtime/src/source-precedence';
import { hash,unavailable,ChallengeError,assertBounded,reportWitnesses,reportClaims,type DiagnosticRequest,type FrozenDiagnostic,type SearchReport } from './contracts';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';

export const tx=<T>(ctx:PeMutationContext,fn:(c:PoolClient)=>Promise<T>,readOnly=false)=>
  withTenantClientTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly},fn);
export const TERMINAL_EVIDENCE_RESERVE=65536;
const ordinaryEvidenceLimit=8388608-TERMINAL_EVIDENCE_RESERVE;
export interface SearchRow {
  id:string;tenant_id:string;principal_id:string;work_id:string;work_input_id:string;work_input_digest:string;
  idempotency_key:string;request_digest:string;frozen_digest:string;report_digest:string|null;parent_search_id:string|null;
  limits:DiagnosticRequest['limits'];status:string;job_id:string|null;active_claim_token:string|null;active_claim_fence:number|null;
  trials:number;retained_bytes:string;deadline_at:Date;expires_at:Date;created_at:Date;
}
function key(){
  const encoded=process.env.FINNOR_M4_STORAGE_KEY,id=process.env.FINNOR_M4_STORAGE_KEY_ID;
  if(!encoded||!/^[A-Za-z0-9+/]{43}=$/.test(encoded)||!id||!/^[A-Za-z0-9_-]{1,80}$/.test(id))
    throw new ChallengeError('CONFIGURATION_REQUIRED','M4 requires a durable 256-bit encryption key and nonsecret key ID');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length!==32)throw new ChallengeError('CONFIGURATION_REQUIRED','M4 encryption configuration is invalid');
  return {bytes,id};
}
export function storageConfigured():void{key();}
const aad=(ctx:PeMutationContext,searchId:string,digest:string)=>Buffer.from(canonicalJson({
  schema:'finnor.m4.encrypted-record.v1',tenantId:ctx.auth.tenantId,principalId:principal(ctx),searchId,digest,
}));
export async function searchRow(ctx:PeMutationContext,id:string,client?:PoolClient,lock=false):Promise<SearchRow>{
  const action=async(c:PoolClient)=>{
    const row=(await c.query<SearchRow>('SELECT * FROM finnor_os.m4_searches WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+
      (lock?' FOR UPDATE':''),[ctx.auth.tenantId,principal(ctx),id])).rows[0];
    if(!row)throw unavailable();return row;
  };return client?action(client):tx(ctx,action,true);
}
export async function budgetRoot(ctx:PeMutationContext,row:SearchRow,c:PoolClient):Promise<SearchRow>{
  let root=row;
  for(let depth=0;root.parent_search_id;depth++){
    if(depth>=8)throw new ChallengeError('LIMIT_EXCEEDED','Repair lineage exceeds the frozen bounded depth');
    root=await searchRow(ctx,root.parent_search_id,c,true);
  }
  return root;
}
export async function episodeCancelled(ctx:PeMutationContext,row:SearchRow,client?:PoolClient,lock=false):Promise<boolean>{
  const action=async(c:PoolClient)=>{
    let current=row;
    for(let depth=0;;depth++){
      if(current.status==='CANCELLED')return true;
      if(!current.parent_search_id)return false;
      if(depth>=8)throw new ChallengeError('LIMIT_EXCEEDED','Repair lineage exceeds the frozen bounded depth');
      current=await searchRow(ctx,current.parent_search_id,c,lock);
    }
  };
  return client?action(client):tx(ctx,action,true);
}
/** A distinct cell/reduction/failure never receives a new allocation on retry or repair. */
export async function allocate(ctx:PeMutationContext,row:SearchRow,kind:'CELL'|'REDUCTION'|'WITNESS',identity:string,c:PoolClient){
  const root=await budgetRoot(ctx,row,c),key=hash(identity);
  const prior=await c.query('SELECT allocation_key FROM finnor_os.m4_allocations WHERE tenant_id=$1 AND principal_id=$2 AND root_search_id=$3 AND kind=$4 AND allocation_key=$5',
    [ctx.auth.tenantId,principal(ctx),root.id,kind,key]);
  if(prior.rowCount)return;
  const maximum=kind==='CELL'?root.limits.maxCells:kind==='REDUCTION'?root.limits.maxReductions:root.limits.maxWitnesses;
  const count=Number((await c.query<{count:string}>('SELECT count(*)::text count FROM finnor_os.m4_allocations WHERE tenant_id=$1 AND principal_id=$2 AND root_search_id=$3 AND kind=$4',
    [ctx.auth.tenantId,principal(ctx),root.id,kind])).rows[0]!.count);
  if(count>=maximum)throw new ChallengeError('LIMIT_EXCEEDED','One parent '+kind.toLowerCase()+' allocation exhausted');
  await c.query('INSERT INTO finnor_os.m4_allocations(tenant_id,principal_id,root_search_id,kind,allocation_key) VALUES($1,$2,$3,$4,$5)',
    [ctx.auth.tenantId,principal(ctx),root.id,kind,key]);
}
/** Reserve no resource. Stop unretainable new claims before any checker runs. */
export async function witnessCapacity(ctx:PeMutationContext,row:SearchRow,identity:string,c:PoolClient){
  const root=await budgetRoot(ctx,row,c),key=hash(identity);
  const r=await c.query<{count:string;existing:boolean}>(`SELECT count(*)::text count,
    coalesce(bool_or(allocation_key=$4),false) existing FROM finnor_os.m4_allocations
    WHERE tenant_id=$1 AND principal_id=$2 AND root_search_id=$3 AND kind='WITNESS'`,
    [ctx.auth.tenantId,principal(ctx),root.id,key]);
  return r.rows[0]!.existing||Number(r.rows[0]!.count)<root.limits.maxWitnesses;
}
export async function retain(ctx:PeMutationContext,row:SearchRow,kind:string,body:unknown,c:PoolClient,terminal=false):Promise<string>{
  const text=canonicalJson(body),plain=Buffer.from(text),digest=hash(body);
  if(plain.length>row.limits.maxBytes||plain.length>4194304)throw new ChallengeError('LIMIT_EXCEEDED','M4 record byte ceiling exceeded');
  const existing=await c.query('SELECT digest FROM finnor_os.m4_records WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND digest=$4',
    [ctx.auth.tenantId,principal(ctx),row.id,digest]);
  if(existing.rowCount)return digest;
  const root=await budgetRoot(ctx,row,c);
  const ceiling=terminal?8388608:ordinaryEvidenceLimit;
  if(root.id!==row.id){
    const charged=await c.query('UPDATE finnor_os.m4_searches SET retained_bytes=retained_bytes+$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND retained_bytes+$4<=$5 RETURNING id',
      [ctx.auth.tenantId,principal(ctx),root.id,plain.length,ceiling]);
    if(!charged.rowCount)throw new ChallengeError('LIMIT_EXCEEDED','One parent durable evidence envelope exceeded');
  }
  const updated=await c.query('UPDATE finnor_os.m4_searches SET retained_bytes=retained_bytes+$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND retained_bytes+$4<=$5 RETURNING id',
    [ctx.auth.tenantId,principal(ctx),row.id,plain.length,ceiling]);
  if(!updated.rowCount)throw new ChallengeError('LIMIT_EXCEEDED','One parent durable evidence envelope exceeded');
  const k=key(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k.bytes,nonce);cipher.setAAD(aad(ctx,row.id,digest));
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  await c.query('INSERT INTO finnor_os.m4_records(tenant_id,principal_id,search_id,digest,kind,plaintext_bytes) VALUES($1,$2,$3,$4,$5,$6)',
    [ctx.auth.tenantId,principal(ctx),row.id,digest,kind,plain.length]);
  await c.query('INSERT INTO finnor_os.m4_payloads(tenant_id,principal_id,search_id,digest,key_id,nonce,tag,ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [ctx.auth.tenantId,principal(ctx),row.id,digest,k.id,nonce,cipher.getAuthTag(),ciphertext,row.expires_at]);
  return digest;
}
export async function load<T>(ctx:PeMutationContext,searchId:string,digest:string,client?:PoolClient):Promise<T>{
  const action=async(c:PoolClient)=>{
    const r=(await c.query<{key_id:string;nonce:Buffer;tag:Buffer;ciphertext:Buffer;plaintext_bytes:number}>(
      'SELECT p.key_id,p.nonce,p.tag,p.ciphertext,r.plaintext_bytes FROM finnor_os.m4_records r JOIN finnor_os.m4_payloads p USING(tenant_id,principal_id,search_id,digest) WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.search_id=$3 AND r.digest=$4',
      [ctx.auth.tenantId,principal(ctx),searchId,digest])).rows[0];
    if(!r)throw unavailable();
    try{
      const k=key();if(k.id!==r.key_id)throw new ChallengeError('CONFIGURATION_REQUIRED','Retained evidence encryption key version is unavailable');
      if(r.ciphertext.length>4194304)throw Error('RECORD_TOO_LARGE');
      const decipher=createDecipheriv('aes-256-gcm',k.bytes,r.nonce);decipher.setAAD(aad(ctx,searchId,digest));decipher.setAuthTag(r.tag);
      const plain=Buffer.concat([decipher.update(r.ciphertext),decipher.final()]);
      if(plain.length!==r.plaintext_bytes)throw Error('RECORD_LENGTH');
      const value=JSON.parse(plain.toString('utf8'));
      if(hash(value)!==digest)throw Error('RECORD_DIGEST');
      return value as T;
    }catch(error){
      if(error instanceof ChallengeError)throw error;
      throw new ChallengeError('CHECK_FAILED','Retained M4 evidence authentication failed');
    }
  };return client?action(client):tx(ctx,action,true);
}
export interface Event {id:string;attemptId:string|null;kind:string;body:any;createdAt:string}
export async function events(ctx:PeMutationContext,row:SearchRow,kinds?:string[],limit=2048):Promise<Event[]>{
  return tx(ctx,async c=>{
    const records=(await c.query<{id:string;attempt_id:string|null;kind:string;record_digest:string;created_at:Date}>(
      'SELECT id,attempt_id,kind,record_digest,created_at FROM finnor_os.m4_events WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND ($4::text[] IS NULL OR kind=ANY($4::text[])) ORDER BY created_at,id LIMIT $5',
      [ctx.auth.tenantId,principal(ctx),row.id,kinds??null,limit])).rows;
    if(records.length===limit)throw new ChallengeError('LIMIT_EXCEEDED','Complete event read exceeds its bounded envelope');
    const found:Event[]=[];for(const r of records)found.push({id:r.id,attemptId:r.attempt_id,kind:r.kind,
      body:await load(ctx,row.id,r.record_digest,c),createdAt:r.created_at.toISOString()});return found;
  },true);
}
export async function event(ctx:PeMutationContext,row:SearchRow,attemptId:string|null,kind:string,body:unknown,c:PoolClient){
  const terminal=['FAILED','FENCED','REFUSED','CANCELLED_ATTEMPT','CANCELLED'].includes(kind);
  const recordBody={attemptId,kind,body,recordId:randomUUID()},digest=await retain(ctx,row,'EVENT',recordBody,c,terminal);
  await c.query('INSERT INTO finnor_os.m4_events(tenant_id,principal_id,search_id,attempt_id,kind,record_digest) VALUES($1,$2,$3,$4,$5,$6)',
    [ctx.auth.tenantId,principal(ctx),row.id,attemptId,kind,digest]);
}
export function eventValue<T>(e:Event):T{return e.body.body as T;}
/** Real queue row, delivery and unexpired lease. Shape-compatible execution JSON is not authority. */
export async function fence(ctx:PeMutationContext,row:SearchRow,execution:Readonly<JobExecutionContext>,c:PoolClient,publication=false){
  if(await episodeCancelled(ctx,row,c,true))
    throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
  const claim=(await c.query(
    `SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.id=$7
     WHERE j.id=$1 AND j.tenant_id=$2 AND j.status='running' AND j.type='run_counterexample_search_v1'
       AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_owner=$5 AND j.protocol_version=1
       AND j.lease_expires_at>clock_timestamp() AND a.claim_token=$3 AND a.claim_fence=$4
       AND a.worker_id=$5 AND a.outcome='running' AND a.finished_at IS NULL
       AND j.payload->>'searchId'=$6 AND j.payload->>'principalId'=$8 FOR SHARE OF j`,
    [execution.jobId,ctx.auth.tenantId,execution.claimToken,execution.claimFence,execution.workerId,row.id,
      execution.deliveryAttemptId,principal(ctx)])).rows[0];
  if(!claim||row.job_id!==execution.jobId||['CANCELLED','FAILED','EXPIRED','STALE','COMPLETED'].includes(row.status)||
    publication&&(row.active_claim_token!==execution.claimToken||Number(row.active_claim_fence)!==execution.claimFence))
    throw new ChallengeError('CANCELLED','Actual queue claim or search publication fence is unavailable');
  if(row.deadline_at.getTime()<=Date.now())throw new ChallengeError('LIMIT_EXCEEDED','One parent deadline, including queue waiting, is exhausted');
}
export async function frozenRecord(ctx:PeMutationContext,row:SearchRow):Promise<FrozenDiagnostic>{
  const frozen=await load<FrozenDiagnostic>(ctx,row.id,row.frozen_digest);
  if(!['finnor.m4.frozen-diagnostic.v1','finnor.m4.frozen-challenge.v1'].includes(frozen.schema)||frozen.request.workId!==row.work_id||
    hash(frozen.capital?.submission??frozen.request)!==row.request_digest||
    (frozen.schema==='finnor.m4.frozen-challenge.v1')!==!!frozen.capital)
    throw new ChallengeError('CHECK_FAILED','Frozen request binding differs');
  return frozen;
}
export async function reportRecord(ctx:PeMutationContext,row:SearchRow,checkedFrozen?:FrozenDiagnostic):Promise<SearchReport|null>{
  if(!row.report_digest)return null;
  const value=await load<SearchReport>(ctx,row.id,row.report_digest),{ref:identity,...body}=value;
  if(!['finnor.m4.owner-artifact-diagnostic.v1','finnor.m4.challenge-result.v1'].includes(value.schema)||identity.contentDigest!==hash(body)||
    value.identity.tenantId!==ctx.auth.tenantId||value.identity.principalId!==principal(ctx)||value.identity.workId!==row.work_id||
    value.executionAuthorityGranted!==false||
    reportWitnesses(value).some(w=>{
      const {ref:identity,...body}=w;
      return identity.contentDigest!==hash(body)||w.validation.status!=='VALID'||!w.validation.material||
        w.contextDigest!==value.identity.contextDigest||!reportClaims(value).some(c=>hash(c.ref)===hash(w.claimRef));
    })||!['FAILURE_WITNESS','NO_WITNESS_WITHIN_BUDGET','BLOCKED'].includes(value.result))
    throw new ChallengeError('CHECK_FAILED','Retained search result invariant failed');
  if(value.schema==='finnor.m4.challenge-result.v1'){
    if(checkedFrozen&&hash(checkedFrozen)!==row.frozen_digest)
      throw new ChallengeError('CHECK_FAILED','Checked original frozen preimage differs from its immutable publication');
    const frozen=checkedFrozen??await frozenRecord(ctx,row);
    if(!frozen.capital||hash(value.candidate)!==hash(frozen.capital.context.program.ref)||
      hash(value.claims)!==hash(value.claimRecords.map(c=>c.ref))||
      hash(value.independentWitnesses)!==hash(value.witnessRecords.map(w=>w.ref))||
      hash(value.unresolved)!==hash(value.coverageGaps.map(g=>g.ref))||
      hash(value.repairDependencies)!==hash(value.repairClosure.ref)||
      hash(value.searchedDomain)!==hash(frozen.domainRef)||hash(value.claimRecords)!==hash(frozen.claims)||
      value.envelope.id!==row.id||value.envelope.state!=='TESTED'||
      hash(value.envelope.inputs.candidate)!==hash(value.candidate)||
      value.envelope.work.inputDigest!==row.work_input_digest||value.envelope.tenant.id!==row.tenant_id||
      value.envelope.tenant.principalId!==row.principal_id||value.envelope.computeGrant.deadlineAt!==row.deadline_at.toISOString())
      throw new ChallengeError('CHECK_FAILED','Original ChallengeResult differs from its frozen candidate/claims/Work/domain');
  }else if('candidate'in value)throw new ChallengeError('CHECK_FAILED','A diagnostic cannot inhabit the original candidate contract');
  return value;
}
export async function purgeExpiredPayloads(ctx:PeMutationContext){
  return tx(ctx,async c=>{
    const r=await c.query(`WITH expired AS MATERIALIZED(
      SELECT p.tenant_id,p.principal_id,p.search_id,p.digest FROM finnor_os.m4_payloads p
      WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.expires_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM finnor_os.data_retention_holds h WHERE h.tenant_id=$1 AND h.released_at IS NULL AND
          ((h.resource_type='m4_search' AND h.resource_id=p.search_id) OR (h.resource_type='work' AND h.resource_id=(
            SELECT work_id FROM finnor_os.m4_searches WHERE tenant_id=$1 AND principal_id=$2 AND id=p.search_id))))
        AND NOT EXISTS(SELECT 1 FROM finnor_os.tenant_retention_policies t WHERE t.tenant_id=$1 AND t.data_class='m4_evidence' AND t.legal_hold)
      ORDER BY p.expires_at,p.digest LIMIT 128 FOR UPDATE SKIP LOCKED)
      DELETE FROM finnor_os.m4_payloads p USING expired e
      WHERE (p.tenant_id,p.principal_id,p.search_id,p.digest)=(e.tenant_id,e.principal_id,e.search_id,e.digest)`,
      [ctx.auth.tenantId,principal(ctx)]);
    return {purgedPayloads:r.rowCount,immutableMetadataRetained:true,limit:128};
  });
}
