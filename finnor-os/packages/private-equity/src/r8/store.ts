import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {tx,principal,unavailable,assertDependencies} from '../evidence-execution/store';
import {hash} from '../../../epistemic-runtime/src/solver-synthesis/contracts';
import type {SolverRequest,SolverCapsule} from '../../../shared-types/src/solver-capsule';
import {assertSolverOwnersCurrent,type SolverOwnerBinding} from './owners';
import {validateCapsule} from './capsule';
export {tx};
export interface SolverRow {id:string;tenant_id:string;principal_id:string;work_id:string;work_input_id:string;work_input_digest:string;
 grant_id:string;generation:number;status:string;request:SolverRequest;binding:SolverOwnerBinding;capsule_digest:string|null;
 claim_token:string|null;claim_fence:number|null;failure:string|null;parent_request_id:string|null}
export async function solverRow(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<SolverRow>{
 const read=async(client:PoolClient)=>{const row=(await client.query<SolverRow>(
  'SELECT * FROM finnor_os.r8_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),
  [ctx.auth.tenantId,principal(ctx),id])).rows[0];if(!row)throw unavailable();return row;};
 return c?read(c):tx(ctx,read,true);
}
export async function record(ctx:PeMutationContext,row:SolverRow,category:string,key:string,body:unknown,c?:PoolClient){
 const digest=hash(body),write=async(client:PoolClient)=>{
  const prior=(await client.query<{digest:string}>('SELECT digest FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category=$4 AND record_key=$5',
   [row.tenant_id,row.principal_id,row.id,category,key])).rows[0];
  if(prior){if(prior.digest!==digest)throw Error('R8_APPEND_IDENTITY_CONFLICT');return digest;}
  await client.query('INSERT INTO finnor_os.r8_records(tenant_id,principal_id,request_id,category,record_key,digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
   [row.tenant_id,row.principal_id,row.id,category,key,digest,JSON.stringify(body)]);return digest;
 };
 return c?write(c):tx(ctx,write);
}
export async function currentSolverRow(ctx:PeMutationContext,id:string){
 const row=await solverRow(ctx,id);await assertSolverOwnersCurrent(ctx,row.request,row.binding);
 await assertDependencies(ctx,row.binding.dependencies);return row;
}
export async function readCapsule(ctx:PeMutationContext,row:SolverRow):Promise<SolverCapsule|null>{
 if(!row.capsule_digest)return null;
 const stored=await tx(ctx,async c=>(await c.query<{body:SolverCapsule;digest:string}>(
  "SELECT body,digest FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category='CAPSULE' AND digest=$4",
  [row.tenant_id,row.principal_id,row.id,row.capsule_digest])).rows[0],true);
 if(!stored||hash(stored.body)!==stored.digest)throw Error('R8_DURABLE_CAPSULE_SUBSTITUTION');
 return validateCapsule(stored.body);
}
export async function enqueueSolver(ctx:PeMutationContext,row:SolverRow,stage:string,c?:PoolClient){
 const write=(client:PoolClient)=>client.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
  VALUES($1,'run_solver_synthesis_v1',$2::jsonb,$3,'batch',1,'locally_idempotent') ON CONFLICT(idempotency_key) DO NOTHING`,
 [row.tenant_id,JSON.stringify({tenantId:row.tenant_id,principalId:row.principal_id,requestId:row.id,generation:row.generation,stage}),
  'r8:'+row.id+':'+row.generation+':'+stage]);
 return c?write(c):tx(ctx,write);
}
