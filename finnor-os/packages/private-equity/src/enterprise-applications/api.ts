import {acquireComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError,withDatabaseExecutionDeadline} from '@finnor/db';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import type {PeMutationContext} from '../types';
import {ApplicationFault} from './contracts';
import {submitApplication,maintainApplication,commandApplication,readApplication,readApplicationRecord,listApplications,
 applicationHistory,applicationAsset,cancelApplication,rollbackApplication,applicationImpact,uploadApplicationSpecification} from './service';
import {ApplicationSubmitSchema,ApplicationMaintainSchema,ApplicationCommandSchema,ApplicationReadSchema,ApplicationRecordReadSchema,
 ApplicationListSchema,ApplicationHistorySchema,ApplicationAssetSchema,ApplicationControlSchema,ApplicationRollbackSchema,ApplicationImpactSchema,ApplicationUploadSchema} from './service';
import {prepareApplicationEffect,ApplicationEffectSchema} from './effects';
import {proposeApplicationAdmission,readApplicationAdmission,ApplicationAdmissionProposeSchema,ApplicationAdmissionReadSchema} from './admission';
export const APPLICATION_OPERATIONS=[
 'application-submit','application-maintain','application-command','application-read','application-record','application-list',
 'application-history','application-asset','application-cancel','application-rollback','application-impact','application-upload',
 'application-prepare-effect','application-s8-propose','application-admission',
] as const;
type Operation=typeof APPLICATION_OPERATIONS[number];
export const APPLICATION_OPERATION_SCHEMAS:Record<Operation,z.ZodTypeAny>={
 'application-submit':ApplicationSubmitSchema,'application-maintain':ApplicationMaintainSchema,'application-command':ApplicationCommandSchema,
 'application-read':ApplicationReadSchema,'application-record':ApplicationRecordReadSchema,'application-list':ApplicationListSchema,
 'application-history':ApplicationHistorySchema,'application-asset':ApplicationAssetSchema,'application-cancel':ApplicationControlSchema,
 'application-rollback':ApplicationRollbackSchema,'application-impact':ApplicationImpactSchema,'application-upload':ApplicationUploadSchema,
 'application-prepare-effect':ApplicationEffectSchema,'application-s8-propose':ApplicationAdmissionProposeSchema,'application-admission':ApplicationAdmissionReadSchema,
};
const operations:Record<Operation,(ctx:PeMutationContext,body:unknown)=>Promise<unknown>>={
 'application-submit':submitApplication,'application-maintain':maintainApplication,'application-command':commandApplication,
 'application-read':readApplication,'application-record':readApplicationRecord,'application-list':listApplications,
 'application-history':applicationHistory,'application-asset':applicationAsset,'application-cancel':cancelApplication,
 'application-rollback':rollbackApplication,'application-impact':applicationImpact,'application-upload':uploadApplicationSpecification,
 'application-prepare-effect':prepareApplicationEffect,
 'application-s8-propose':proposeApplicationAdmission,'application-admission':readApplicationAdmission,
};
const readOnly=new Set(['application-read','application-record','application-list','application-history','application-asset','application-impact','application-admission']);
export async function readApplicationBody(req:Request){
 const limit=128*1024,deadline=Date.now()+15000;
 if(Number(req.headers.get('content-length')??0)>limit){await req.body?.cancel();throw new ApplicationFault('APPLICATION_REQUEST_BOUND','Request exceeds 128 KiB',413);}
 if(!req.body)throw new ApplicationFault('INVALID_APPLICATION_REQUEST','A JSON body is required',400);
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){
   if(req.signal.aborted)throw new ApplicationFault('APPLICATION_REQUEST_ABORTED','Request was cancelled',400);
   let timer:ReturnType<typeof setTimeout>|undefined;
   const next=await Promise.race([reader.read(),new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new ApplicationFault('APPLICATION_REQUEST_DEADLINE','Request body deadline exceeded',408)),Math.max(1,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
   if(next.done)break;
   size+=next.value.byteLength;if(size>limit)throw new ApplicationFault('APPLICATION_REQUEST_BOUND','Request exceeds 128 KiB',413);
   chunks.push(next.value);
  }
  const bytes=new Uint8Array(size);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ApplicationFault('INVALID_APPLICATION_REQUEST','A complete UTF-8 JSON body is required',400);}
 }catch(error){await reader.cancel().catch(()=>undefined);throw error;}finally{reader.releaseLock();}
}
export async function handleApplicationOperation(ctx:PeMutationContext,operation:string,body:unknown){
 if(!Object.hasOwn(operations,operation))throw new ApplicationFault('APPLICATION_OPERATION_NOT_FOUND','Unknown application operation',404);
 if(!readOnly.has(operation)&&(process.env.FINNOR_ENVIRONMENT==='production'||process.env.NODE_ENV==='production'&&!['development','ordinary_disposable'].includes(process.env.FINNOR_ENVIRONMENT??'')))
  throw new ApplicationFault('APPLICATION_PRODUCTION_UNADMITTED','Protected X3 qualification and production activation remain separate gates',403);
 return withDatabaseExecutionDeadline(performance.now()+20000,async()=>{
  const leases=await acquireComputeResourceLeases({tenantId:ctx.auth.tenantId,resourceKeys:['native:x3-client'],requiredResourceKeys:['native:x3-client'],workloadClass:'INTERACTIVE',ownerId:'x3-api:'+crypto.randomUUID()});
  try{
   const result=await operations[operation as Operation](ctx,body);
   if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw new ApplicationFault('APPLICATION_RESPONSE_BOUND','Response exceeds 8 MiB; request a smaller explicit page',413);
   return {body:result,status:operation==='application-submit'||operation==='application-maintain'?202:200};
  }finally{await releaseComputeResourceLeases(leases,'x3_api_finished');}
 });
}
export function applicationResponseError(error:unknown){
 if(error instanceof ApplicationFault)return {body:{code:error.code,error:error.message},status:error.status};
 if(error instanceof z.ZodError)return {body:{code:'INVALID_APPLICATION_REQUEST',error:'Request does not match the typed application contract'},status:400};
 if(error&&typeof error==='object'&&'constraint' in error&&error.constraint==='x3_applications_data_bytes_check')
  return {body:{code:'APPLICATION_STORAGE_BOUND',error:'Original retained-storage allocation exhausted'},status:413};
 if(error instanceof ComputeCapacityUnavailableError)return {body:{code:'APPLICATION_CAPACITY_UNAVAILABLE',retryAfterMs:error.retryAfterMs},status:503};
 return null;
}
