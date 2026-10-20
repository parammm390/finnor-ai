import {z} from 'zod';
import {ProblemSchema,ForecastSchema,Root,SourcePin,Id} from '../../../epistemic-runtime/src/strategic-response/contracts';
import type {StrategicRuntimeIdentity} from '../../../epistemic-runtime/src/strategic-response/process';
import type {StrategicFittedSet,StrategicResponseModel,StrategicIndependentCheck} from '../../../shared-types/src/strategic-response';
export {PROFILE,PROFILE_DIGEST,VERSION,digest,same,bytesDigest,reference,fail,StrategicFault} from '../../../epistemic-runtime/src/strategic-response/contracts';
export const SubmitSchema=z.object({schema:z.literal('finnor.strategic-response-request.v1'),root:Root,workId:z.string().uuid(),
 evidence:SourcePin,problem:ProblemSchema,idempotencyKey:z.string().min(1).max(128),parentModelId:z.string().uuid().optional()}).strict();
export type SubmitRequest=z.infer<typeof SubmitSchema>;
export const ModelId=z.object({modelId:z.string().uuid()}).strict(),UseId=z.object({modelId:z.string().uuid(),useId:z.string().uuid()}).strict();
export const ForecastRequest=ModelId.extend({query:ForecastSchema,idempotencyKey:z.string().min(1).max(128)}).strict();
export const DecisionRequest=ForecastRequest.extend({mandate:z.unknown(),problem:z.unknown(),
 actionRules:z.array(z.object({actionId:Id,ruleIds:z.array(Id).min(1).max(4)}).strict()).max(8)}).strict();
export type UseRequest=z.infer<typeof ForecastRequest>|z.infer<typeof DecisionRequest>;
export const ModelList=z.object({root:Root,workId:z.string().uuid()}).strict();
export const JobSchema=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),modelId:z.string().uuid(),
 generation:z.number().int().positive(),useId:z.string().uuid().optional()}).strict();
export type StrategicJob=z.infer<typeof JobSchema>;
export const StrategicOperations=['response-model-submit','response-model-list','response-model-read','response-model-admit',
 'response-model-resume','response-model-cancel','response-model-artifact','response-model-compare',
 'response-forecast','response-programme','response-use-read','response-use-resume','response-use-cancel'] as const;
export const StrategicOperationSchemas={
 'response-model-submit':SubmitSchema,'response-model-list':ModelList,'response-model-read':ModelId,'response-model-admit':ModelId,
 'response-model-resume':ModelId,'response-model-cancel':ModelId,'response-model-artifact':ModelId,'response-model-compare':ModelId,
 'response-forecast':ForecastRequest,'response-programme':DecisionRequest,'response-use-read':UseId,'response-use-resume':UseId,'response-use-cancel':UseId,
} satisfies Record<typeof StrategicOperations[number],z.ZodTypeAny>;
export interface ModelRow {
 tenant_id:string;id:string;principal_id:string;root:SubmitRequest['root'];work_id:string;work_input_id:string;work_input_digest:string;
 episode_id:string;request:SubmitRequest;request_digest:string;runtime:StrategicRuntimeIdentity;rights_revision:string;idempotency_key:string;
 status:string;generation:number;candidate:StrategicFittedSet|null;artifact:StrategicResponseModel|null;
 admission:StrategicAdmission|null;fallback_id:string|null;cancelled:boolean;created_at:Date;
 deadline_at:Date;attempts_used:number;use_attempts_used:number;semantic_applications_used:string;retained_bytes:string;uses_used:number;
}
export interface StrategicAdmission {
 schema:'finnor.s8.strategic-response-admission.v1';domain:'STRATEGIC_RESPONSE_MODEL_SET';
 ref:ReturnType<typeof import('../../../epistemic-runtime/src/strategic-response/contracts')['reference']>;
 protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT';tenantId:string;principalId:string;modelId:string;
 modelRef:StrategicResponseModel['envelope']['contentRef'];candidateDigest:string;checkDigest:string;profileDigest:string;
 runtimeDigest:string;rightsRevision:string;workInputDigest:string;admittedAt:string;validUntil:string;
 protectedAdmission:false;productionActivated:false;executionAuthorityGranted:false;
}
export interface UseRow {
 tenant_id:string;id:string;model_id:string;requested_model_id:string;principal_id:string;episode_id:string;kind:'PREDICT'|'DECISION';
 request:UseRequest;request_digest:string;idempotency_key:string;generation:number;model_generation:number;status:string;
 candidate:unknown|null;check:StrategicIndependentCheck|null;artifact:Record<string,unknown>|null;attempts_used:number;cancelled:boolean;created_at:Date;
}
