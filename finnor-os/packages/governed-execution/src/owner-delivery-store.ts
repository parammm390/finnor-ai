/** Recoverable ordinary transport outbox. It does not own business effect or allocation state. */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenantTransaction } from '@finnor/db';
import { LedgerFault } from './protocol.js';
import { ownerTransportRoute, ownerTransportHash, signOwnerDeliveryOrigin, verifyOwnerDeliveryOrigin, deliverOwnerTransportIntent, recoverOwnerTransportIntent,
 type OwnerTransportScope, type OwnerDeliveryEnvelope } from './owner-transport.js';

const fail=(code:string):never=>{throw new LedgerFault(503,code);};
const predicate='tenant_id=$1 AND principal_id=$2 AND semantic_owner=$3 AND kind=$4 AND identity=$5';
const identityArgs=(scope:OwnerTransportScope,kind:string,id:string)=>[scope.tenantId,scope.principalId,scope.semanticOwner,kind,id];
async function activeOwner(c:pg.PoolClient,identity:OwnerTransportScope){
 const result=await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",[identity.tenantId,identity.principalId]);
 if(result.rowCount!==1)fail('OWNER_TRANSPORT_PRINCIPAL_UNAVAILABLE');
}

/** Called inside the authentic semantic owner's transaction. Configuration absence confers nothing. */
export async function enqueueOwnerDeliveryInTransaction(c:pg.PoolClient,identity:OwnerTransportScope,input:{kind:'REFERENCE'|'EVENT';identity:string;payload:Record<string,any>}){
 const route=await ownerTransportRoute(identity);if(!route)return {status:'OWNER_TRANSPORT_UNCONFIGURED',protectedReceipt:null};
 await activeOwner(c,identity);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['s6-owner-transport',identity])]);
 const args=identityArgs(identity,input.kind,input.identity),payloadDigest=ownerTransportHash(input.payload);
 let prior=(await c.query(`SELECT * FROM finnor_os.s6_owner_delivery_origins WHERE ${predicate}`,args)).rows[0];
 if(!prior){
  const count=await c.query("SELECT count(*)::int n FROM finnor_os.s6_owner_delivery_states WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner=$3 AND status<>'ACCEPTED'",args.slice(0,3));
  if(count.rows[0].n>=256)fail('OWNER_TRANSPORT_UNRESOLVED_BACKLOG_LIMIT');
  const signed=await signOwnerDeliveryOrigin(route,{...identity,...input});
  await c.query('INSERT INTO finnor_os.s6_owner_delivery_origins(tenant_id,principal_id,semantic_owner,kind,identity,payload_digest,envelope,signature) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[...args,payloadDigest,JSON.stringify(signed.envelope),signed.signature]);
  prior={...signed,payload_digest:payloadDigest};
 }
 if(prior.payload_digest!==payloadDigest)fail('OWNER_TRANSPORT_IDENTITY_IMMUTABLE');
 verifyOwnerDeliveryOrigin(route,prior.envelope,prior.signature);
 await c.query("INSERT INTO finnor_os.s6_owner_delivery_states(tenant_id,principal_id,semantic_owner,kind,identity,status,attempts) VALUES($1,$2,$3,$4,$5,'PENDING',0) ON CONFLICT DO NOTHING",args);
 return {status:'AUTHENTICATED_OWNER_INTENT_PENDING_LEDGER',identity:input.identity,protectedReceipt:null};
}

interface ClaimedDelivery {kind:'REFERENCE'|'EVENT';identity:string;envelope:OwnerDeliveryEnvelope;signature:string;payload_digest:string;lease_token:string;lease_until:Date;attempts:number;delivery_mode:'APPEND'|'RECOVERY_READ';recovery_checks:number}
async function claimOne(identity:OwnerTransportScope,leaseMs:number):Promise<ClaimedDelivery|null>{
 return withTenantTransaction(identity.tenantId,{userId:identity.principalId},async(_db,c)=>{
  await activeOwner(c,identity);
  // A crash on the last read claim cannot erase responsibility or restart its budget.
  await c.query(`UPDATE finnor_os.s6_owner_delivery_states SET status='REQUIRES_OPERATOR',
   last_error='OWNER_TRANSPORT_RECOVERY_BUDGET_EXHAUSTED',updated_at=clock_timestamp()
   WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner=$3 AND status='CLAIMED'
    AND delivery_mode='RECOVERY_READ' AND recovery_checks=64 AND lease_until<=clock_timestamp()`,
   [identity.tenantId,identity.principalId,identity.semanticOwner]);
  const result=await c.query<ClaimedDelivery>(`SELECT o.kind,o.identity,o.envelope,o.signature,o.payload_digest,s.attempts
   FROM finnor_os.s6_owner_delivery_origins o JOIN finnor_os.s6_owner_delivery_states s
    USING(tenant_id,principal_id,semantic_owner,kind,identity)
   WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.semantic_owner=$3
    AND (s.delivery_mode='APPEND' AND s.attempts<64 OR s.attempts=64 AND s.recovery_checks<64)
    AND (s.status IN ('PENDING','RETRY') AND s.next_attempt_at<=clock_timestamp()
      OR s.status='CLAIMED' AND s.lease_until<=clock_timestamp())
   ORDER BY s.next_attempt_at,o.created_at,o.identity LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,[identity.tenantId,identity.principalId,identity.semanticOwner]);
  const row=result.rows[0];if(!row)return null;
  const token=randomUUID();
  const claimed=await c.query<Pick<ClaimedDelivery,'attempts'|'lease_until'|'delivery_mode'|'recovery_checks'>>(`UPDATE finnor_os.s6_owner_delivery_states SET status='CLAIMED',
   delivery_mode=CASE WHEN attempts=64 THEN 'RECOVERY_READ' ELSE 'APPEND' END,
   recovery_checks=recovery_checks+CASE WHEN attempts=64 THEN 1 ELSE 0 END,
   attempts=attempts+CASE WHEN attempts<64 THEN 1 ELSE 0 END,
   lease_token=$6::uuid,lease_until=clock_timestamp()+$7::integer*interval '1 millisecond',updated_at=clock_timestamp()
   WHERE ${predicate} RETURNING attempts,lease_until,delivery_mode,recovery_checks`,[...identityArgs(identity,row.kind,row.identity),token,leaseMs]);
  if(claimed.rowCount!==1)fail('OWNER_TRANSPORT_LEASE_LOST');
  return {...row,...claimed.rows[0]!,lease_token:token};
 });
}

function boundedError(error:unknown){
 return error instanceof LedgerFault&&/^[A-Z0-9_]{1,128}$/.test(error.code)?error.code:'OWNER_TRANSPORT_UNAVAILABLE';
}
async function persistReceipt(identity:OwnerTransportScope,claim:ClaimedDelivery,delivery:{receipt:Record<string,any>;requestDigest:string}){
 try{
  await withTenantTransaction(identity.tenantId,{userId:identity.principalId},async(_db,c)=>{
   const result=await c.query(`UPDATE finnor_os.s6_owner_delivery_states SET status='ACCEPTED',receipt=$7::jsonb,
    request_digest=$8,last_error=NULL,updated_at=clock_timestamp()
    WHERE ${predicate} AND status='CLAIMED' AND lease_token=$6::uuid AND lease_until>clock_timestamp()`,
    [...identityArgs(identity,claim.kind,claim.identity),claim.lease_token,JSON.stringify(delivery.receipt),delivery.requestDigest]);
   if(result.rowCount!==1)fail('OWNER_TRANSPORT_LEASE_LOST');
  });
 }catch(error){if(error instanceof LedgerFault)throw error;fail('RECEIPT_PERSISTENCE_UNAVAILABLE');}
}
async function retainFailure(identity:OwnerTransportScope,claim:ClaimedDelivery,code:string){
 // A successful protected commit followed by a failed local transaction retains
 // the actual lease. Recovery adopts the same receipt after expiry; never invent it.
 if(code==='RECEIPT_PERSISTENCE_UNAVAILABLE'||code==='OWNER_TRANSPORT_LEASE_LOST')return;
 const transientRead=code==='LEDGER_TRANSPORT_UNAVAILABLE'||code==='LEDGER_HTTP_UNAVAILABLE';
 const status=code.startsWith('OWNER_ORIGIN_')?'REFUSED_ORIGIN':claim.delivery_mode==='RECOVERY_READ'&&(!transientRead||claim.recovery_checks>=64)?'REQUIRES_OPERATOR':'RETRY';
 const budgetCount=claim.delivery_mode==='RECOVERY_READ'?claim.recovery_checks:claim.attempts;
 const delay=Math.min(300000,1000*2**Math.min(budgetCount-1,8));
 await withTenantTransaction(identity.tenantId,{userId:identity.principalId},async(_db,c)=>{
  await c.query(`UPDATE finnor_os.s6_owner_delivery_states SET status=$7,last_error=$8,
   next_attempt_at=clock_timestamp()+$9::integer*interval '1 millisecond',updated_at=clock_timestamp()
   WHERE ${predicate} AND status='CLAIMED' AND lease_token=$6::uuid AND lease_until>clock_timestamp()`,
   [...identityArgs(identity,claim.kind,claim.identity),claim.lease_token,status,code,delay]);
 });
}

export async function deliverOwnerTransportBatch(identity:OwnerTransportScope,options:{limit?:number}={}){
 const route=await ownerTransportRoute(identity)??fail('OWNER_TRANSPORT_ROUTE_UNAVAILABLE');
 const limit=options.limit??8;if(!Number.isInteger(limit)||limit<1||limit>32)fail('OWNER_TRANSPORT_BATCH_LIMIT_INVALID');
 const report:{inspected:number;accepted:number;failures:Array<{identity:string;code:string}>}={inspected:0,accepted:0,failures:[]};
 const begun=Date.now();
 for(let i=0;i<limit&&Date.now()-begun<30000;i++){
  // Claim just one request before work. A batch never starts leases for queued
  // entries that are waiting behind another request's full network deadline.
  const claim=await claimOne(identity,route.leaseMs);if(!claim)break;report.inspected++;
  try{
   verifyOwnerDeliveryOrigin(route,claim.envelope,claim.signature);
   if(claim.envelope.kind!==claim.kind||claim.envelope.identity!==claim.identity||ownerTransportHash(claim.envelope.payload)!==claim.payload_digest)fail('OWNER_ORIGIN_STORAGE_BINDING_INVALID');
   const deliver=claim.delivery_mode==='RECOVERY_READ'?recoverOwnerTransportIntent:deliverOwnerTransportIntent;
   const delivery=await deliver(identity,claim.envelope,claim.signature,{deadlineAt:claim.lease_until.getTime()});
   await persistReceipt(identity,claim,delivery);report.accepted++;
  }catch(error){
   const code=boundedError(error);report.failures.push({identity:claim.identity,code});
   try{await retainFailure(identity,claim,code);}catch{report.failures.push({identity:claim.identity,code:'OWNER_TRANSPORT_FAILURE_PERSISTENCE_UNAVAILABLE'});}
  }
 }
 return report;
}
