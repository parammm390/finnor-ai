import {performance} from 'node:perf_hooks';
import {withDatabaseExecutionDeadline,acquireComputeResourceLeases,releaseComputeResourceLeases,ExactWorkIntakeConflict} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {applicationResponseError} from '../enterprise-applications/api';
import {ConsentSchema,RevokeSchema,SubmitSchema,ReplicateSchema,UseSchema,ReadSchema,HistorySchema,ListSchema,TargetSchema,ControlSchema,InvalidateSchema,AdmissionSchema,CurrentSchema,ExperimentReadSchema,fail} from './contracts';
import {grantIdentificationRights,revokeIdentificationRights,submitIdentification,submitIdentificationReplication,submitIdentificationUse,readIdentification,
 listIdentifications,identificationHistory,identificationTargets,controlIdentification,readIdentificationExperiment} from './service';
import {proposeIdentificationAdmission,readIdentificationAdmission} from './admission';
import {requireDisposableIdentification} from '../../../tools/src/identification-provider';
export const IDENTIFICATION_OPERATION_SCHEMAS={
 'identification-targets':TargetSchema,'identification-consent':ConsentSchema,'identification-revoke-consent':RevokeSchema,
 'identification-submit':SubmitSchema,'identification-read':ReadSchema,'identification-list':ListSchema,'identification-history':HistorySchema,
 'identification-experiment':ExperimentReadSchema,'identification-replicate':ReplicateSchema,'identification-use':UseSchema,
 'identification-cancel':ControlSchema,'identification-invalidate':InvalidateSchema,'identification-retry':ControlSchema,
 'identification-s8-propose':AdmissionSchema,'identification-admission':CurrentSchema,
};
export const IDENTIFICATION_OPERATIONS=[
 'identification-targets','identification-consent','identification-revoke-consent','identification-submit',
 'identification-read','identification-list','identification-history','identification-experiment',
 'identification-replicate','identification-use','identification-cancel','identification-invalidate','identification-retry',
 'identification-s8-propose','identification-admission',
] as const satisfies readonly (keyof typeof IDENTIFICATION_OPERATION_SCHEMAS)[];
const operations:Record<keyof typeof IDENTIFICATION_OPERATION_SCHEMAS,(ctx:PeMutationContext,body:unknown)=>Promise<unknown>>={
 'identification-targets':identificationTargets,'identification-consent':grantIdentificationRights,'identification-revoke-consent':revokeIdentificationRights,
 'identification-submit':submitIdentification,'identification-read':readIdentification,'identification-list':listIdentifications,'identification-history':identificationHistory,
 'identification-experiment':readIdentificationExperiment,'identification-replicate':submitIdentificationReplication,'identification-use':submitIdentificationUse,
 'identification-cancel':(ctx,v)=>controlIdentification(ctx,v,'CANCEL'),'identification-invalidate':(ctx,v)=>controlIdentification(ctx,v,'INVALIDATE'),
 'identification-retry':(ctx,v)=>controlIdentification(ctx,v,'RETRY'),'identification-s8-propose':proposeIdentificationAdmission,'identification-admission':readIdentificationAdmission,
};
const reads=new Set(['identification-targets','identification-read','identification-list','identification-history','identification-experiment','identification-admission']);
export async function handleIdentificationOperation(ctx:PeMutationContext,operation:string,body:unknown){
 if(!Object.hasOwn(operations,operation))fail('X4_OPERATION_NOT_FOUND',404);
 if(!reads.has(operation))requireDisposableIdentification();
 return withDatabaseExecutionDeadline(performance.now()+20000,async()=>{
  const leases=await acquireComputeResourceLeases({tenantId:ctx.auth.tenantId,resourceKeys:['native:x4-client'],requiredResourceKeys:['native:x4-client'],workloadClass:'INTERACTIVE',ownerId:'x4-api:'+crypto.randomUUID()});
  try{
   const result=await operations[operation as keyof typeof operations](ctx,body);
   if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)fail('X4_RESPONSE_BOUND_REQUEST_EXPLICIT_PAGE',413);
   return {body:result,status:['identification-submit','identification-replicate','identification-use','identification-retry'].includes(operation)?202:200};
  }finally{await releaseComputeResourceLeases(leases,'x4_api_finished');}
 });
}
export function identificationResponseError(error:unknown){
 const known=applicationResponseError(error);if(known)return known;
 if(error instanceof ExactWorkIntakeConflict)return {body:{code:'X4_IDEMPOTENCY_CONFLICT',error:'The original Work intake is bound to a different exact input'},status:409};
 if(error instanceof Error&&/^X4_[A-Z0-9_]+$/.test(error.message))return {body:{code:error.message,error:error.message},status:/REQUIRED|UNADMITTED|UNAVAILABLE|UNSAFE|REVOKED/.test(error.message)?403:409};
 if(error&&typeof error==='object'&&'constraint'in error&&error.constraint==='x4_identifications_data_bytes_check')return {body:{code:'X4_ORIGINAL_STORAGE_EXHAUSTED'},status:413};
 return null;
}
