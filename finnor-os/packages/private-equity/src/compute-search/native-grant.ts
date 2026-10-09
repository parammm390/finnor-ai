import type {PoolClient} from 'pg';
/** Shared original S5 native-attempt usage. P2 and R1 use this same counter
 * beneath the caller-held canonical S5 portfolio lock; no competing ledger. */
export async function chargeOriginalNativeGrant(c:PoolClient,input:{tenantId:string;principalId:string;grantDigest:string;resourceId:string;capacity:number;predicate:string}){
 if(!Number.isSafeInteger(input.capacity)||input.capacity<1)throw Error(input.predicate);
 await c.query('INSERT INTO finnor_os.p2_grant_usage(tenant_id,principal_id,grant_digest,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.tenantId,input.principalId,input.grantDigest,input.resourceId]);
 const debit=await c.query('UPDATE finnor_os.p2_grant_usage SET spent=spent+1 WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4 AND spent+1<=$5 RETURNING spent',[input.tenantId,input.principalId,input.grantDigest,input.resourceId,input.capacity]);if(!debit.rowCount)throw Error(input.predicate);return Number(debit.rows[0].spent);
}
