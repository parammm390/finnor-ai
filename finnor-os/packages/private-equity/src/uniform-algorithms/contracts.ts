import {z} from 'zod';
import {PE_WORLD_ROOT_TYPES} from '../types';
import {ExperimentRefSchema} from '../../../epistemic-runtime/src/experiments';
import {AllocationDemandBindingSchema,AllocationFundingSchema} from '../../../epistemic-runtime/src/allocation-contracts';
export {hash,jsonHash as digest} from '../../../epistemic-runtime/src/uniform-algorithms/syntax';
const text=z.string().min(1).max(256),id=z.string().uuid();
export class UniformOwnerError extends Error{constructor(readonly code:string,readonly status=409){super(code);this.name='UniformOwnerError';}}
export function fail(code:string,status=409):never{throw new UniformOwnerError(code,status);}
export function diagnosticProfile(){
 if(process.env.FINNOR_Y5_PROFILE!=='ORDINARY_NATIVE_DIAGNOSTIC'||process.env.FINNOR_ENVIRONMENT==='production'||
  process.env.NODE_ENV==='production'&&process.env.FINNOR_ENVIRONMENT!=='ordinary_disposable')fail('Y5_PROTECTED_OR_PRODUCTION_DOMAIN_UNADMITTED',503);
}
export const AllocationInputSchema=z.object({
 mandate:z.record(z.string(),z.unknown()),policyRefs:z.array(ExperimentRefSchema).max(128),resourceRefs:z.array(ExperimentRefSchema).max(16),jointModel:z.record(z.string(),z.unknown()),
 demandBindings:z.array(AllocationDemandBindingSchema).max(1024),
 funding:z.array(AllocationFundingSchema).max(128),
 idempotencyKey:text,
}).strict();
export const RootSchema=z.object({entityType:z.enum(PE_WORLD_ROOT_TYPES),entityId:id}).strict();
export const SubmitSchema=z.object({root:RootSchema,workId:id,allocation:AllocationInputSchema,idempotencyKey:text,
 limits:z.object({wallMs:z.number().int().min(30000).max(3600000),maxAttempts:z.number().int().min(1).max(2),maxUses:z.number().int().min(1).max(16)}).strict(),
 baselineManifestRef:ExperimentRefSchema.nullable(),
}).strict();
export const ReadSchema=z.object({discoveryId:id}).strict();
export const ListSchema=z.object({root:RootSchema,workId:id}).strict();
export const ConsumeSchema=z.object({discoveryId:id,allocation:AllocationInputSchema,idempotencyKey:text,fallback:z.enum(['NONE','EXISTING_S5_PRODUCER'])}).strict();
export const InvalidateSchema=z.object({discoveryId:id,dependency:z.enum(['specification','implementation','runtime','rights','instance','admission']),reason:text,idempotencyKey:text}).strict();
export const JobSchema=z.object({tenantId:id,principalId:id,discoveryId:id,generation:z.number().int().positive()}).strict();
export const OperationSchemas={submit:SubmitSchema,read:ReadSchema,list:ListSchema,consume:ConsumeSchema,cancel:ReadSchema,invalidate:InvalidateSchema} as const;
export type UniformJob=z.infer<typeof JobSchema>;
