import {z} from 'zod';
import {ExperimentRefSchema} from '@finnor/epistemic-runtime';
import {PE_WORLD_ROOT_TYPES} from '@finnor/shared-types';
import {ApplicationDemandSchema} from '../../application-semantics/native-contracts';
import {digestSchema,integerSchema,programSchema,sha,validateProgram,exactInteger} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/contracts';
export {sha,canonical,fail} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/contracts';

export const VERSION='z4-execution-proof-v2-no-execution-replay' as const;
export const PRODUCT_LOCK='61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf';
export const JOB='prove_exact_execution_v1' as const;
export const rootSchema=z.object({entityType:z.enum(PE_WORLD_ROOT_TYPES),entityId:z.string().uuid()}).strict();
const columns=z.array(z.object({kind:z.enum(['STATE','EXPOSURE']),variableId:z.string().min(1).max(128),unit:z.string().min(1).max(64)}).strict()).min(1).max(8);
const history=z.object({modelRef:ExperimentRefSchema,periods:z.array(z.number().int().min(0).max(65535)).min(1).max(256),columns});
const guard=z.object({register:z.number().int().min(0).max(7),unit:z.string().min(1).max(64),minimum:integerSchema,maximum:integerSchema}).strict();
export const ownerContractSchema=z.discriminatedUnion('owner',[
 history.extend({owner:z.literal('S3'),query:z.record(z.unknown()),guard}).strict(),
 history.extend({owner:z.literal('S4'),policyRef:ExperimentRefSchema,decision:z.record(z.unknown()),allocationRef:ExperimentRefSchema.nullable(),guard}).strict(),
]);
const requestObject=z.object({
 schema:z.literal('finnor.z4.submit.v1'),mode:z.literal('ordinary_disposable'),root:rootSchema,workId:z.string().uuid(),
 workInputId:z.string().uuid(),workRevisionRef:ExperimentRefSchema,idempotencyKey:z.string().min(1).max(128),
 purpose:z.string().min(1).max(2000),
 program:programSchema,initial:z.array(integerSchema).min(1).max(8),ownerContract:ownerContractSchema,
 deadlineAt:z.string().datetime({offset:true}),resourceDemand:z.array(ApplicationDemandSchema).min(1).max(2),
 maxMemoryBytes:z.number().int().min(128*1024*1024).max(2*1024*1024*1024),
 maxCpuSeconds:z.number().int().min(30).max(3600),maxAttempts:z.number().int().min(1).max(3),
 maxRetainedBytes:z.number().int().min(1024*1024).max(64*1024*1024),
 qualification:z.object({schema:z.literal('finnor.z4.public-qualification.v1'),
  registrationSha256:z.literal('4479bce31a46945067d88b262bcb549040c20d91b2dc57e788e6b335bda4f163'),
  caseId:z.string().min(1).max(128),compilerFrozenAt:z.string().datetime({offset:true})}).strict().optional(),
}).strict();
export const intakeSchema=requestObject.omit({workId:true,workInputId:true,workRevisionRef:true});
export const planSchema=requestObject.omit({workRevisionRef:true});
export const submitSchema=requestObject.superRefine((value,ctx)=>{
 try{
  const p=validateProgram(value.program),g=value.ownerContract.guard;
  if(value.initial.length!==p.registers.length||p.inputCount!==value.ownerContract.columns.length||
   g.register>=p.registers.length||p.registers[g.register]!.unit!==g.unit||
   p.inputUnits.some((u,i)=>u!==value.ownerContract.columns[i]!.unit)||
   exactInteger(g.minimum)>exactInteger(g.maximum))throw Error('domain');
  value.initial.forEach(exactInteger);
  const ps=value.ownerContract.periods;
  if(ps.some((v,i)=>i>0&&ps[i-1]!>=v))throw Error('periods');
 }catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Z4_EXACT_NATIVE_RELATION_DOMAIN'});}
});
export const sessionSchema=z.object({sessionId:z.string().uuid()}).strict();
export const guardSchema=z.object({schema:z.literal('finnor.z4.owner-guard.v1'),sessionId:z.string().uuid(),useId:z.string().uuid(),capsuleDigest:digestSchema,
 owner:z.enum(['S3','S4']),targetDigest:digestSchema}).strict();
export const consumeSchema=sessionSchema.extend({capsuleDigest:digestSchema,idempotencyKey:z.string().min(1).max(128)}).strict();
export const listSchema=z.object({root:rootSchema,workId:z.string().uuid()}).strict();
export const OPERATION_SCHEMAS={
 'execution-proof-intake':intakeSchema,'execution-proof-plan':planSchema,
 'execution-proof-submit':submitSchema,'execution-proof-read':sessionSchema,'execution-proof-list':listSchema,
 'execution-proof-audit':sessionSchema,'execution-proof-consume':consumeSchema,'execution-proof-cancel':sessionSchema,
} as const;
export const EXECUTION_PROOF_OPERATIONS=Object.keys(OPERATION_SCHEMAS) as Array<keyof typeof OPERATION_SCHEMAS>;
export type Submit=z.infer<typeof submitSchema>;
export type Intake=z.infer<typeof intakeSchema>;
export function acceptedDefinition(value:Intake|Submit|z.infer<typeof planSchema>){
 const fields=Object.fromEntries(Object.keys(intakeSchema.shape).filter(k=>(value as Record<string,unknown>)[k]!==undefined)
  .map(k=>[k,(value as Record<string,unknown>)[k]]));
 const {idempotencyKey:_,...definition}=intakeSchema.parse(fields);
 return definition;
}
export function planReference(p:{id:string;revision:string|number;semantic_hash:string}){
 return {owner:'WorkPlanRevision',id:p.id,version:String(p.revision),contentDigest:digestSchema.parse(p.semantic_hash.replace(/^sha256:/,''))};
}
export type OwnerContract=z.infer<typeof ownerContractSchema>;
export function ownerTargetInput(c:OwnerContract){
 return c.owner==='S3'?{modelRef:c.modelRef,query:c.query}:
  {policyRef:c.policyRef,decision:c.decision,allocationRef:c.allocationRef,measurements:[]};
}
export type OwnerGuard=z.infer<typeof guardSchema>;
export const safePredicate=(e:unknown)=>String((e as Error)?.message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'Z4_PREDICATE_UNPASSED';
export const ref=(kind:string,body:unknown)=>({owner:'Z4',id:`${kind}:${sha(body)}`,version:VERSION,contentDigest:sha(body)});
export function developmentOnly(){
 if(process.env.FINNOR_ENVIRONMENT!=='staging'||process.env.FINNOR_Z4_PROFILE!=='ordinary_disposable'||
  process.env.VERCEL_ENV==='production')throw Error('Z4_ORDINARY_DISPOSABLE_AUTHORITY_REQUIRED');
}
