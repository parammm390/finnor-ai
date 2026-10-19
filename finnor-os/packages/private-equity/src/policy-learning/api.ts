import {z} from 'zod';
import {performance} from 'node:perf_hooks';
import {acquireComputeResourceLeases,releaseComputeResourceLeases,withDatabaseExecutionDeadline} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {ConsentBodySchema,ConsentRevokeSchema,SubmitSchema,ReadSchema,ListSchema,ExecuteSchema,EvaluateSchema,AssignmentSchema,ControlSchema,RetrainSchema,RollbackSchema,AdmissionSchema,CurrentSchema,parse,fail} from './contracts';
import {grantTrainingRights,revokeTrainingRights,inspectLearningExperience,submitLearning,submitLearningUse,submitLearningEvaluation,retrainLearning,readLearning,listLearning,controlLearning,rollbackLearning} from './service';
import {proposeLearningAdmission,readLearningAdmission} from './admission';
import {registerNativeLearningAssignment} from './assignments';
export const LEARNING_OPERATION_SCHEMAS={
 'learning-consent':ConsentBodySchema,'learning-revoke-consent':ConsentRevokeSchema,'learning-experience':SubmitSchema.pick({experience:true,knowledgeCut:true}),
 'learning-submit':SubmitSchema,'learning-read':ReadSchema,'learning-list':ListSchema,'learning-execute':ExecuteSchema,'learning-evaluate':EvaluateSchema,
 'learning-cancel':ControlSchema,'learning-invalidate':ControlSchema,'learning-retry':ControlSchema,'learning-rollback':RollbackSchema,
 'learning-s8-propose':AdmissionSchema,'learning-admission':CurrentSchema,
 'learning-register-assignment':AssignmentSchema,
 'learning-retrain':RetrainSchema,
};
export const LEARNING_OPERATIONS=[
 'learning-consent','learning-revoke-consent','learning-experience','learning-submit','learning-read','learning-list','learning-execute','learning-evaluate',
 'learning-cancel','learning-invalidate','learning-retry','learning-rollback','learning-s8-propose','learning-admission',
 'learning-register-assignment',
 'learning-retrain',
] as const;
const operations:Record<keyof typeof LEARNING_OPERATION_SCHEMAS,(ctx:PeMutationContext,v:unknown)=>Promise<unknown>>={
 'learning-consent':grantTrainingRights,'learning-revoke-consent':revokeTrainingRights,'learning-experience':inspectLearningExperience,'learning-submit':submitLearning,
 'learning-read':readLearning,'learning-list':listLearning,'learning-execute':submitLearningUse,'learning-evaluate':submitLearningEvaluation,
 'learning-cancel':(ctx,v)=>controlLearning(ctx,v,'CANCEL'),'learning-invalidate':(ctx,v)=>controlLearning(ctx,v,'INVALIDATE'),'learning-retry':(ctx,v)=>controlLearning(ctx,v,'RETRY'),
 'learning-rollback':rollbackLearning,'learning-s8-propose':proposeLearningAdmission,'learning-admission':readLearningAdmission,
 'learning-register-assignment':(ctx,v)=>registerNativeLearningAssignment(ctx,parse(AssignmentSchema,v)),
 'learning-retrain':retrainLearning,
};
const readOnly=new Set(['learning-read','learning-list','learning-experience','learning-admission']);
export async function handleLearningOperation(ctx:PeMutationContext,operation:string,body:unknown){
 if(!Object.hasOwn(operations,operation))fail('X5_OPERATION_NOT_FOUND',404);
 if(!readOnly.has(operation)&&(process.env.FINNOR_ENVIRONMENT==='production'||process.env.NODE_ENV==='production'&&!['development','ordinary_disposable'].includes(process.env.FINNOR_ENVIRONMENT??'')))fail('X5_PRODUCTION_UNADMITTED',403);
 return withDatabaseExecutionDeadline(performance.now()+20000,async()=>{
  const leases=await acquireComputeResourceLeases({tenantId:ctx.auth.tenantId,resourceKeys:['native:x5-client'],requiredResourceKeys:['native:x5-client'],workloadClass:'INTERACTIVE',ownerId:'x5-api:'+crypto.randomUUID()});
  try{
   const result=await operations[operation as keyof typeof operations](ctx,body);
   if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)fail('X5_RESPONSE_BOUND',413);
   return {body:result,status:['learning-submit','learning-execute','learning-evaluate','learning-retry','learning-retrain'].includes(operation)?202:200};
  }finally{await releaseComputeResourceLeases(leases,'x5_api_finished');}
 });
}
