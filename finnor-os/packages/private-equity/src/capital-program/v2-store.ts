import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,link,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {withTenantClientTransaction} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {canonicalJson} from '../../../epistemic-runtime/src/source-precedence';
import {principal} from '../decision-slice/adapters';
import {CapitalProgramV2RefSchema} from '@finnor/shared-types/src/capital-program';
import {m3Hash,m3Same,m3Bounded,m3Unavailable,CapitalProgramV2Error,CAPITAL_PROGRAM_V2_VERSION,
  type CapitalProgramV2Ref,type CapitalProgramV2Request,type CapitalProgramV2Status} from './v2-contracts';
import type {CapitalOwnerBinding} from './v2-owners';
import {m3CheckTime} from './v2-budget';

export const m3Tx=<T>(ctx:PeMutationContext,invoke:(client:PoolClient)=>Promise<T>,readOnly=false)=>
  withTenantClientTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly},invoke);
export interface M3QueryRow {
 id:string;tenant_id:string;principal_id:string;work_id:string;work_input_id:string;work_input_digest:string;
 plan_id:string;plan_digest:string;request:CapitalProgramV2Request;request_digest:string;acceptance:CapitalOwnerBinding;
 parent_query_id:string|null;generation:number;status:CapitalProgramV2Status;result_digest:string|null;
 active_claim_token:string|null;active_claim_fence:number|null;first_started_at:Date|null;deadline_at:Date|null;
 attempted:number;generated:number;refinement_steps:number;failure:{code:string;requirement:string}|null;
}
export interface M3LifecycleRow extends Omit<M3QueryRow,'request'|'acceptance'> {
 idempotency_key:string;created_at:Date;updated_at:Date;
}
export async function m3AuthorizePrincipal(ctx:PeMutationContext,c?:PoolClient):Promise<void>{
 if(ctx.auth.role!=='owner'||principal(ctx)!==ctx.auth.userId)throw m3Unavailable();
 const check=async(c:PoolClient)=>{
  const row=(await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner'",
    [ctx.auth.tenantId,principal(ctx)])).rows[0];if(!row)throw m3Unavailable();
 };
 if(c)await check(c);else await m3Tx(ctx,check,true);
}
const lifecycleColumns='id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,plan_id,plan_digest,'+
 'idempotency_key,request_digest,parent_query_id,generation,status,result_digest,active_claim_token,active_claim_fence,'+
 'first_started_at,deadline_at,attempted,generated,refinement_steps,failure,created_at,updated_at';
async function queryRow<T extends M3QueryRow|M3LifecycleRow>(
 ctx:PeMutationContext,id:string,columns:string,c?:PoolClient,lock=false):Promise<T>{
 const read=async(c:PoolClient)=>{
  await m3AuthorizePrincipal(ctx,c);
  const row=(await c.query<T>('SELECT '+columns+' FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),
   [ctx.auth.tenantId,principal(ctx),id])).rows[0];if(!row)throw m3Unavailable();
  return row;
 };
 return c?read(c):m3Tx(ctx,read,true);
}
export const m3Query=(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false)=>
 queryRow<M3QueryRow>(ctx,id,'*',c,lock);
/** Live lifecycle SQL only. Search and owner replay still read full immutable inputs. */
export const m3Lifecycle=(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false)=>
 queryRow<M3LifecycleRow>(ctx,id,lifecycleColumns,c,lock);
export async function m3Event(ctx:PeMutationContext,queryId:string,attemptId:string,kind:string,body:unknown,c?:PoolClient):Promise<void>{
 m3Bounded(body);const append=async(c:PoolClient)=>{await c.query('INSERT INTO finnor_os.m3_events(tenant_id,principal_id,query_id,attempt_id,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
  [ctx.auth.tenantId,principal(ctx),queryId,attemptId,kind,canonicalJson(body)]);};
 if(c)await append(c);else await m3Tx(ctx,append);
}
type Category='programs'|'modules'|'graphs'|'requests'|'allocation-proposals'|'branch-reviews';
async function privateDirectory(path:string):Promise<void>{
 await mkdir(path,{recursive:true,mode:0o700});const st=await lstat(path);
 if(st.isSymbolicLink()||!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)
  throw new CapitalProgramV2Error('CHECK_FAILED','Private capital programme store permissions or descriptor are invalid');
}
async function pathFor(ctx:PeMutationContext,category:Category,digest:string):Promise<string>{
 if(!/^[a-f0-9]{64}$/.test(digest)||![ctx.auth.tenantId,principal(ctx)].every(id=>/^[a-f0-9-]{36}$/i.test(id)))throw m3Unavailable();
 if(!process.env.FINNOR_M3_STORE)throw new CapitalProgramV2Error('CONFIGURATION_REQUIRED','Capital programme private store is not configured');
 const root=resolve(process.env.FINNOR_M3_STORE);await privateDirectory(root);
 if(await realpath(root)!==root)throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme store has a symbolic ancestor');
 let path=root;for(const part of [ctx.auth.tenantId,principal(ctx),category]){path=join(path,part);await privateDirectory(path);}
 return join(path,digest+'.json');
}
async function readBytes(path:string,max:number):Promise<string>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await file.stat();
  if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o077)!==0||before.size>max)
   throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme immutable file is not a permitted bounded regular file');
  // A fixed allocation, not readFile on a growing FIFO or adversarial file.
  const bytes=Buffer.alloc(before.size+1);let count=0;
  while(count<bytes.length){m3CheckTime();const read=await file.read(bytes,count,bytes.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
  const after=await file.stat();
  if(count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)
   throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme file changed during bounded read');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count));
 }finally{await file.close();}
}
export async function writeM3Record(ctx:PeMutationContext,category:Category,ref:CapitalProgramV2Ref,body:unknown):Promise<void>{
 if(ref.owner!=='M3'||ref.version!==CAPITAL_PROGRAM_V2_VERSION||m3Hash(body)!==ref.contentDigest)throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme immutable preimage differs');
 const value={ref,body};m3Bounded(value);const path=await pathFor(ctx,category,ref.contentDigest),directory=resolve(path,'..'),
   temporary=join(directory,`.${randomUUID()}.tmp`),bytes=canonicalJson(value);
 const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 try{
  try{await link(temporary,path);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await readBytes(path,8388608)!==bytes)throw new CapitalProgramV2Error('CONFLICT','Immutable capital programme bytes already differ');}
  const dir=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
 }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export async function readM3Record<T>(ctx:PeMutationContext,category:Category,value:unknown):Promise<{body:T;bytes:string;sha256:string}>{
 const ref=CapitalProgramV2RefSchema.parse(value);
 if(ref.owner!=='M3'||ref.version!==CAPITAL_PROGRAM_V2_VERSION||!ref.id.endsWith(':'+ref.contentDigest))throw m3Unavailable();
 try{
  const bytes=await readBytes(await pathFor(ctx,category,ref.contentDigest),8388608),stored=JSON.parse(bytes) as {ref:CapitalProgramV2Ref;body:T};
  if(!m3Same(stored.ref,ref)||m3Hash(stored.body)!==ref.contentDigest)
   throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme immutable bytes do not match their original reference');
  return {body:stored.body,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
 }catch(error){if(error instanceof CapitalProgramV2Error)throw error;throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme immutable file is unavailable or corrupt');}
}
