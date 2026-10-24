import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EvidenceRootSchema,FinancialSemanticsSchema,type FinancialSemantics} from '@finnor/shared-types';
import {ExpressionSchema,key,type Expression} from '../program-synthesis/contracts';
import {assertApplicationData,ApplicationFault} from '../enterprise-applications/contracts';
import type {CompleteConfidentialEconomicComputation} from './artifact';
import {BoundedReferenceSchema as RefSchema} from '../bounded-reference';
export {RefSchema};

export const hex=z.string().regex(/^[a-f0-9]{64}$/);
const uuid=z.string().uuid(),instant=z.string().datetime({offset:true}),idempotency=z.string().min(1).max(160);
export type ConfidentialRef=z.infer<typeof RefSchema>;
/** Core stores its digest with a sha256: label; Y4's wire encoding is hex. */
export function workPlanReference(plan:{id:string;revision:number|string;semantic_hash:string}):ConfidentialRef{
 return {owner:'WorkPlanRevision',id:plan.id,version:String(plan.revision),
  contentDigest:hex.parse(plan.semantic_hash.replace(/^sha256:/,''))};
}
export const InputSchema=z.object({
 key,participantId:key,semantics:FinancialSemanticsSchema,
 lower:z.string().regex(/^[+-]?\d+(?:\.\d+)?$/).max(96),upper:z.string().regex(/^[+-]?\d+(?:\.\d+)?$/).max(96),
 decimalPlaces:z.number().int().min(0).max(18),sourceRef:RefSchema,grantRef:RefSchema,validationRef:RefSchema,
 primaryEvidenceRef:RefSchema.nullable(),sourceStatus:z.enum(['PRIMARY_CONFIRMED','OWNER_ASSERTED','ESTIMATED']),
 freshUntil:instant,rounding:z.literal('EXACT_OR_REJECT'),
}).strict();
export const FunctionSchema=z.object({
 schema:z.literal('finnor.confidential-function.v1'),functionRef:RefSchema,workRevisionRef:RefSchema,
 baselineManifestRef:RefSchema,objectiveRef:RefSchema,mandateRef:RefSchema,jointSemanticsRef:RefSchema,
 purpose:z.string().min(1).max(1000),
 participants:z.array(z.object({id:key,institutionId:uuid,authorityRef:RefSchema}).strict()).min(3).max(8),
 inputs:z.array(InputSchema).min(1).max(16),
 outputs:z.array(z.object({key,expression:ExpressionSchema,semantics:FinancialSemanticsSchema,
  recipients:z.array(key).min(1).max(8)}).strict()).min(1).max(16),
 release:z.object({familyId:z.string().min(1).max(200),policyRef:RefSchema,termsRef:RefSchema,
  maxDistinctFunctions:z.literal(1)}).strict(),
}).strict();
export type ConfidentialFunction=z.infer<typeof FunctionSchema>;
const LimitsSchema=z.object({
 deadlineAt:instant,maxAttempts:z.number().int().min(1).max(4),
 maxCpuSeconds:z.number().int().min(1).max(3600),maxMemoryBytes:z.number().int().min(1024**3).max(8*1024**3),
 maxRetainedBytes:z.number().int().min(65536).max(16*1024*1024),
}).strict();
export const PlanSchema=z.object({
 schema:z.literal('finnor.y4.plan.v1'),root:EvidenceRootSchema,workId:uuid,workInputId:uuid,
 function:FunctionSchema.omit({workRevisionRef:true}),limits:LimitsSchema,
}).strict();
export const IntakeSchema=PlanSchema.omit({schema:true,workId:true,workInputId:true}).extend({
 schema:z.literal('finnor.y4.intake.v1'),idempotencyKey:idempotency,
}).strict();
export const SourceHandleSchema=z.object({workId:uuid,grantId:uuid}).strict();
export interface OpaqueSourceHandle{
 id:string;digest:string;body:{schema:'finnor.y4.opaque-source-handle.v1';id:string;
 principalId:string;institutionId:string;sourceId:string;sourceRevision:string;grantVersion:number;
 purpose:string;validUntil:string;sourceTruthProven:false;executionAuthorityGranted:false};
}
export function sourceHandleRefs(handle:OpaqueSourceHandle){
 if(handle.body.schema!=='finnor.y4.opaque-source-handle.v1'||handle.id!==handle.body.id
  ||!hex.safeParse(handle.digest).success||handle.body.sourceTruthProven!==false
  ||handle.body.executionAuthorityGranted!==false)fail('Y4_OWNER_ISSUED_OPAQUE_SOURCE_HANDLE_REQUIRED');
 return {
  sourceRef:{owner:'Y4_SOURCE_VERSION_IDENTITY',id:handle.body.sourceId,
   version:handle.body.sourceRevision,contentDigest:handle.digest},
  grantRef:{owner:'Y4_SOURCE_AUTHORITY_HANDLE',id:handle.id,
   version:String(handle.body.grantVersion),contentDigest:handle.digest},
 };
}
export type ConfidentialExpression=Expression;
export type ConfidentialFinancialSemantics=FinancialSemantics;
export const SubmitSchema=z.object({
 schema:z.literal('finnor.y4.submit.v1'),root:EvidenceRootSchema,workId:uuid,workInputId:uuid,
 function:FunctionSchema,idempotencyKey:idempotency,
 limits:LimitsSchema,
}).strict();
export const ReadSchema=z.object({computationId:uuid}).strict();
export const ListSchema=z.object({root:EvidenceRootSchema,workId:uuid}).strict();
export const ConsentSchema=ReadSchema.extend({
 participantId:key,certificateDigest:hex,validUntil:instant,idempotencyKey:idempotency,
 scope:z.literal('THIS_EXACT_FUNCTION_INPUT_CUT_AND_LISTED_RECIPIENTS_ONLY'),
 retention:z.literal('RETAIN_AUDIT_DENY_FUTURE_DERIVATIVES_NO_RETROACTIVE_UNLEARNING'),
}).strict();
export const ControlSchema=ReadSchema.extend({reason:z.string().min(1).max(500),idempotencyKey:idempotency}).strict();
export const RevokeSchema=ControlSchema.extend({participantId:key}).strict();
export const CommitmentSchema=ReadSchema.extend({participantId:key,idempotencyKey:idempotency,
 commitment:z.object({participantId:key,sessionId:z.string().regex(/^[a-f0-9]{32}$/),functionDigest:hex,
  inputs:z.array(z.object({key,bindingPrefix:z.string().regex(/^[a-f0-9]{32}$/),commitment:hex}).strict()).min(1).max(16),
  ownerCutDigest:hex,qualification:z.literal('LOCAL_ENGINEERING_ONLY'),sourceTruthProven:z.literal(false),
  executionAuthority:z.literal(false)}).strict(),
}).strict();
export const ImportSchema=ReadSchema.extend({participantId:key,idempotencyKey:idempotency,
 releaseNonce:z.string().regex(/^[a-f0-9]{32}$/),
 outputs:z.array(z.object({key,mantissa:z.string().regex(/^-?(0|[1-9]\d*)$/).max(26),
  scale:z.number().int().min(0).max(36)}).strict()).max(16),
}).strict();
export const JobSchema=z.object({tenantId:uuid,principalId:uuid,computationId:uuid,generation:z.number().int().positive(),
 stage:z.enum(['COMPILE','EXECUTE','RECONCILE'])}).strict();
export type ConfidentialJob=z.infer<typeof JobSchema>;
export const OutputBindingSchema=z.object({computationId:uuid,releaseId:uuid,output:key}).strict();
export type ConfidentialOutputBinding=z.infer<typeof OutputBindingSchema>;
const exactDecimal=z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,36})?$/).max(96);
export const ConfidentialGuardSchema=z.object({
 binding:OutputBindingSchema,semantics:FinancialSemanticsSchema,minimum:exactDecimal,maximum:exactDecimal,
 qualification:z.literal('RECIPIENT_LOCAL_DERIVED_ADMISSIBILITY_NOT_S2_OBSERVATION'),
}).strict();
export type ConfidentialGuard=z.infer<typeof ConfidentialGuardSchema>;
export const ControlConsumeSchema=z.object({policyRef:RefSchema,decision:z.unknown(),
 allocationRef:RefSchema.optional(),confidentialGuard:ConfidentialGuardSchema}).strict();
export const AllocationConsumeSchema=z.object({
 input:z.unknown(),bindings:z.array(z.object({scenarioId:key,termIndex:z.number().int().min(0).max(511),
  binding:OutputBindingSchema,semantics:FinancialSemanticsSchema}).strict()).min(1).max(16),
}).strict();
export const ObligationConsumeSchema=z.object({policyRef:RefSchema,decision:z.unknown(),allocationRef:RefSchema,
 confidentialGuard:ConfidentialGuardSchema,workId:uuid}).strict();
export const ConsumeSchema=z.object({
 investmentCaseId:uuid,modelVersionId:uuid,worldAt:instant,workId:uuid,idempotencyKey:idempotency,
 bindings:z.record(z.string(), OutputBindingSchema).refine(v=>Object.keys(v).length>=1&&Object.keys(v).length<=16),
}).strict();
export type ReleasedQuantity={key:string;mantissa:string;scale:number;semantics:FinancialSemantics};
export interface ConfidentialReleaseFields {
 id:string;tenantId:string;principalId:string;workId:string;workInputId:string;functionDigest:string;
 protocolDigest:string;profileDigest:string;runtimeIdentity:Record<string,unknown>;
 correspondence:Record<string,unknown>;
 releaseNonce:string;outputCommitment:string;
 sessionId:string;releaseId:string;releasePolicy:ConfidentialFunction['release'];participantIds:string[];
 outputs:ReleasedQuantity[];inputSourceStatus:Array<{key:string;status:string;primaryEvidenceRef:ConfidentialRef|null}>;
 currentness:'CURRENT';truthClass:'DERIVED_VALUE';sourceTruthProven:false;
 qualification:'LOCAL_ENGINEERING_ONLY';protectedAdmission:false;productionActive:false;executionAuthorityGranted:false;
}
export type ConfidentialEconomicComputation=CompleteConfidentialEconomicComputation;

export function fail(code:string,status=409):never{throw new ApplicationFault(code,code,status);}
export const minimumNativeCpu=(count:number)=>(2*count+1)*10+5*count+2*(count+1);
export function parse<S extends z.ZodTypeAny>(schema:S,value:unknown):z.output<S>{
 assertApplicationData(value,262144);return schema.parse(value);
}
/** ASCII-escaped canonical JSON matches Python and has no locale-sensitive key ordering. */
function encoded(value:unknown):string{
 if(value===null||typeof value!=='object'){
  const result=JSON.stringify(value);
  if(result===undefined)fail('Y4_NON_JSON_VALUE',400);
  return result.replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 }
 if(Array.isArray(value))return '['+value.map(encoded).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>encoded(k)+':'+encoded((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const canonical=encoded;
export const sha=(value:unknown)=>createHash('sha256').update(encoded(value)).digest('hex');
/** Reconstruct the native MPC commitment encoding, not the economic function. */
export function recipientOutputCommitment(protocol:Record<string,any>,binding:Record<string,unknown>,participantId:string,
 nonce:string,outputs:Array<{key:string;mantissa:string;scale:number}>):string{
 if(!/^[a-f0-9]{32}$/.test(nonce))fail('Y4_EXACT_PRIVATE_OUTPUT_NONCE_REQUIRED');
 const layout=(protocol.outputs as Array<{key:string;scale:number;register:number;recipients:string[]}>)
  .filter(output=>output.recipients.includes(participantId)).map(output=>{
   const node=protocol.nodes[output.register] as {low:string;high:string};
   const span=BigInt(node.high)-BigInt(node.low);
   if(span<0n)fail('Y4_CHECKED_OUTPUT_DOMAIN_REQUIRED');
   return {key:output.key,scale:output.scale,low:node.low,high:node.high,
    bytes:Math.max(1,Math.ceil((span===0n?0:span.toString(2).length)/8))};
  });
 if(outputs.length!==layout.length||new Set(outputs.map(o=>o.key)).size!==layout.length)
  fail('Y4_EXACT_RECIPIENT_OUTPUT_TUPLE_REQUIRED');
 const prefix=sha({schema:'finnor.y4.output-binding.v1',protocolDigest:sha(protocol),
  bindingDigest:sha(binding),participantId,outputs:layout}).slice(0,32);
 const pieces=[Buffer.from(prefix,'hex'),Buffer.from(nonce,'hex')];
 for(const port of layout){
  const output=outputs.find(o=>o.key===port.key);
  if(!output||output.scale!==port.scale)fail('Y4_EXACT_RECIPIENT_OUTPUT_SCALE_REQUIRED');
  quantity(output);
  const value=BigInt(output.mantissa),low=BigInt(port.low),high=BigInt(port.high);
  if(value<low||value>high)fail('Y4_RECIPIENT_OUTPUT_DOMAIN_REQUIRED');
  pieces.push(Buffer.from((value-low).toString(16).padStart(port.bytes*2,'0'),'hex'));
 }
 return createHash('sha256').update(Buffer.concat(pieces)).digest('hex');
}
export function quantity(value:Pick<ReleasedQuantity,'mantissa'|'scale'>):string{
 if(!/^-?(0|[1-9]\d*)$/.test(value.mantissa)||!Number.isSafeInteger(value.scale)||value.scale<0||value.scale>36)
  fail('Y4_RELEASE_NUMERICAL_ENCODING_INVALID');
 const n=BigInt(value.mantissa),negative=n<0n,absolute=(negative?-n:n).toString().padStart(value.scale+1,'0');
 if((negative?-n:n)>=2n**80n)fail('Y4_RELEASE_RANGE_INVALID');
 const text=value.scale?absolute.slice(0,-value.scale)+'.'+absolute.slice(-value.scale):absolute;
 return (negative?'-':'')+text;
}
