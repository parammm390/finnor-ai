import {z} from 'zod';

const scalar=z.union([z.string().max(4096),z.boolean()]);
export const UnderwritingModelValueSchema=z.union([scalar,z.record(z.string(), scalar).superRefine((value,context)=>{
 if(Object.keys(value).length>240)context.addIssue({code:z.ZodIssueCode.too_big,maximum:240,origin:'array',inclusive:true,message:'Series exceeds 240 values'});
})]);
const provenance=z.object({
 kind:z.enum(['p1_assumption','evidence_version','model_parameter','human_input','artifact_anchor']),
 id:z.string().min(1).max(2048),versionId:z.string().min(1).max(2048).optional(),anchorId:z.string().min(1).max(2048).optional(),
 semanticHash:z.string().min(1).max(160).optional(),effectiveAt:z.string().datetime({offset:true}).optional(),
 observedAt:z.string().datetime({offset:true}).optional(),retrievedAt:z.string().datetime({offset:true}).optional(),
}).strict();
export const UnderwritingExplicitInputSchema=z.object({
 value:UnderwritingModelValueSchema.nullable(),truthClass:z.enum(['OBSERVED_FACT','CANONICAL_ASSUMPTION','MODEL_PARAMETER']),
 status:z.enum(['KNOWN','UNKNOWN','STALE','CONFLICTING','UNSUPPORTED']).optional(),
 provenance:z.array(provenance).max(32).optional(),reason:z.string().max(1000).optional(),
}).strict();
