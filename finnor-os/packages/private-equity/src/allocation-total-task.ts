import {z} from 'zod';
import type {ResolvedTotalSpecification,TotalExpression,TotalType} from '../../shared-types/src/total-algorithm-theory';
import {ExperimentRefSchema} from '../../epistemic-runtime/src/experiments';
import {expressionType} from '../../epistemic-runtime/src/uniform-algorithms/total/syntax';
import type {PeMutationContext,PeWorldRootRef} from './types';
import {unavailable} from './owner-context';
import {workCutTx} from './enterprise-applications/store';
import {tx,authorizeTx,principal} from './uniform-algorithms/store';
import {digest,fail} from './uniform-algorithms/contracts';

export const TotalTaskInstanceSchema=z.object({schema:z.literal('finnor.s5.total-task-instance.v2'),
 specificationRef:ExperimentRefSchema,values:z.array(z.string().regex(/^(?:0|-?[1-9][0-9]*)$/)
  .refine(s=>s.replace('-','').length<=512)).max(128)}).strict();
export interface TotalTaskBinding{
 schema:'finnor.s5.total-task-binding.v2';workId:string;work:{id:string;digest:string};
 specificationDigest:string;
 sourceRef:z.infer<typeof ExperimentRefSchema>;instance:z.infer<typeof TotalTaskInstanceSchema>;
 qualification:'AUTHENTICATED_RECORDED_TASK_NOT_FIELD_MEASUREMENT_OR_ALLOCATION_CERTIFICATE';
}
export const TotalTaskBindingSchema=z.object({schema:z.literal('finnor.s5.total-task-binding.v2'),
 workId:z.string().uuid(),work:z.object({id:z.string().uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 specificationDigest:z.string().regex(/^[a-f0-9]{64}$/),sourceRef:ExperimentRefSchema,instance:TotalTaskInstanceSchema,
 qualification:z.literal('AUTHENTICATED_RECORDED_TASK_NOT_FIELD_MEASUREMENT_OR_ALLOCATION_CERTIFICATE')}).strict();
export async function resolveTotalTask(ctx:PeMutationContext,root:PeWorldRootRef,workId:string,
 specification:ResolvedTotalSpecification):Promise<TotalTaskBinding>{
 return tx(ctx,async c=>{
  await authorizeTx(ctx,c,root,workId);
  const work=await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:workId});
  const row=(await c.query<{id:string;instruction_text:string;created_by:string;context_snapshot:unknown;
   context_snapshot_hash:string;status:string;current_owner_id:string|null}>(
   `SELECT i.id,i.instruction_text,i.created_by,i.context_snapshot,i.context_snapshot_hash,w.status,w.current_owner_id
    FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
    WHERE i.tenant_id=$1 AND i.work_id=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 1 FOR SHARE OF w`,
   [ctx.auth.tenantId,workId])).rows[0];
  if(!row||row.created_by!==principal(ctx))throw unavailable();
  if(['failed','cancelled','completed'].includes(row.status)||row.current_owner_id&&row.current_owner_id!==principal(ctx))
   fail('Y5_TOTAL_TASK_WORK_NOT_CURRENT');
  let instance:z.infer<typeof TotalTaskInstanceSchema>;
  try{
   if(Buffer.byteLength(row.instruction_text)>131072)fail('Y5_TOTAL_TASK_BYTES_BOUND');
   instance=TotalTaskInstanceSchema.parse(JSON.parse(row.instruction_text));
  }catch{fail('Y5_TOTAL_TASK_INSTANCE_UNAVAILABLE');}
  if(digest(instance.specificationRef)!==digest(specification.sourceRef))fail('Y5_TOTAL_TASK_SPECIFICATION_REF_CHANGED');
  const {status:_,current_owner_id:__,...source}=row;
  return {schema:'finnor.s5.total-task-binding.v2',workId,work,specificationDigest:digest(specification),
   sourceRef:{owner:'WORK_INPUT',id:row.id,version:'s5-total-task-instance-v2',contentDigest:digest(source)},
   instance,qualification:'AUTHENTICATED_RECORDED_TASK_NOT_FIELD_MEASUREMENT_OR_ALLOCATION_CERTIFICATE'};
 });
}

type ReferenceValue=bigint|boolean|ReferenceValue[];
function number(v:ReferenceValue):bigint{if(typeof v!=='bigint')fail('Y5_TOTAL_REFERENCE_INTEGER_TYPE');return v;}
function boolean(v:ReferenceValue):boolean{if(typeof v!=='boolean')fail('Y5_TOTAL_REFERENCE_BOOLEAN_TYPE');return v;}
function list(v:ReferenceValue):ReferenceValue[]{if(!Array.isArray(v))fail('Y5_TOTAL_REFERENCE_SEQUENCE_TYPE');return v;}
function zero(t:TotalType):ReferenceValue{
 return t==='BOOL'?false:typeof t==='string'?0n:'list'in t?[]:t.product.map(zero);
}
function checked(v:bigint){if(v.toString().replace('-','').length>4096)fail('Y5_TOTAL_REFERENCE_INTEGER_BOUND');return v;}
interface ReferenceBudget{step:()=>void}
function referenceEqual(a:ReferenceValue,b:ReferenceValue,budget?:ReferenceBudget):boolean{
 budget?.step();
 if(Array.isArray(a)){
  if(!Array.isArray(b)||a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(!referenceEqual(a[i]!,b[i]!,budget))return false;
  return true;
 }
 return !Array.isArray(b)&&a===b;
}
function reference(e:TotalExpression,env:ReferenceValue[],types:TotalType[],budget?:ReferenceBudget):ReferenceValue{
 budget?.step();
 const evaluate=(child:TotalExpression)=>reference(child,env,types,budget);
 switch(e.op){
  case 'VAR':{const v=env[e.index];if(v===undefined)fail('Y5_TOTAL_REFERENCE_VARIABLE');return v;}
  case 'INT':case 'NAT':return BigInt(e.value);
  case 'BOOL':return e.value;
  case 'EMPTY':return [];
  case 'IF':return evaluate(boolean(evaluate(e.condition))?e.then:e.else);
  case 'NOT':return !boolean(evaluate(e.arg));
  case 'FIRST':return list(evaluate(e.arg))[0]!;
  case 'SECOND':return list(evaluate(e.arg))[1]!;
  case 'HEAD':{
   const xs=list(evaluate(e.arg));
   if(xs.length)return xs[0]!;
   const type=expressionType(e.arg,types);
   if(typeof type==='string'||!('list'in type))fail('Y5_TOTAL_REFERENCE_SEQUENCE_TYPE');
   return zero(type.list);
  }
  case 'TAIL':return list(evaluate(e.arg)).slice(1);
  case 'LENGTH':return BigInt(list(evaluate(e.arg)).length);
  case 'IS_EMPTY':return list(evaluate(e.arg)).length===0;
  default:{
   const a=evaluate(e.left),b=evaluate(e.right);
   if(e.op==='PAIR')return [a,b];if(e.op==='CONS')return [a,...list(b)];
   if(e.op==='AND')return boolean(a)&&boolean(b);if(e.op==='OR')return boolean(a)||boolean(b);
   if(e.op==='EQ')return referenceEqual(a,b,budget);
   const x=number(a),y=number(b);
   switch(e.op){
    case 'ADD':return checked(x+y);case 'SUB':return expressionType(e.left,types)==='NAT'&&x<y?0n:checked(x-y);
    case 'MUL':return checked(x*y);case 'MIN':return x<y?x:y;case 'MAX':return x>y?x:y;
    case 'LE':return x<=y;case 'LT':return x<y;
   }
  }
 }
}
function taskPrefixes(specification:ResolvedTotalSpecification,task:TotalTaskBinding,value:string,budget?:ReferenceBudget){
 if(!/^(?:0|-?[1-9][0-9]*)$/.test(value)||value.replace('-','').length>2048)fail('Y5_TOTAL_RESULT_INTEGER_BOUND');
 let state=BigInt(value);
 const safe=(s:bigint)=>boolean(reference(specification.definition.safe,[s],['INT'],budget));
 const prefixes=[{length:0,state:state.toString(),safe:safe(state)}];
 for(const x of task.instance.values){
  state=number(reference(specification.definition.advance,[BigInt(x),state],['INT','INT'],budget));
  prefixes.push({length:prefixes.length,state:state.toString(),safe:safe(state)});
 }
 return prefixes;
}
export function checkTotalTaskResult(specification:ResolvedTotalSpecification,task:TotalTaskBinding,value:string){
 const prefixes=taskPrefixes(specification,task,value);
 const feasible=prefixes.every(p=>p.safe);
 if(!feasible)fail('Y5_TOTAL_ORIGINAL_OWNER_PREFIX_CHECK_FAILED');
 return {schema:'finnor.s5.total-task-reference-check.v2' as const,semanticOwner:'S5' as const,
  taskRef:task.sourceRef,specificationRef:specification.sourceRef,feasible,prefixes,includesEmptyPrefix:true as const,
  quality:'EXACT_LEAST_INITIAL_STATE_BY_KERNEL_CHECKED_OWNER_EXPECTED_TYPE' as const,
  referenceScope:'INDEPENDENT_TASK_MEANING_PREFIX_INTERPRETATION_NOT_ALGORITHM_EXECUTION' as const,
  allocationOptimalityClaimed:false as const,fieldMeasurementClaimed:false as const};
}

export const totalReferenceBounds=Object.freeze({maxCandidates:4096,maxExpressionSteps:2000000,
 maxWallMs:1000,maxEvidenceBytes:1048576,maxIntegerDigits:4096});
const referenceMethod='S5_BOUNDED_EXHAUSTIVE_INTEGER_V1' as const;
class ReferenceLimit extends Error{}
type RejectedCandidate={value:string;firstUnsafePrefix:number;state:string};
export interface TotalTaskReference{
 schema:'finnor.s5.total-task-exhaustive-reference.v2';method:typeof referenceMethod;
 bounds:typeof totalReferenceBounds;lowerBound:null|{value:string;safeExpressionDigest:string;
  rule:'NECESSARY_AFFINE_EMPTY_PREFIX_SAFETY_LOWER_BOUND'};
 rejected:RejectedCandidate[];prefixes:{length:number;state:string;safe:boolean}[];
 candidatesExamined:number;expressionSteps:number;includesEmptyPrefix:true;
 scope:'FINITE_TASK_MEANING_INTERPRETATION_NOT_DISCOVERED_ALGORITHM';
}
export type TotalTaskModelResult=
 |{status:'MODEL_ACCEPTED';value:string;reason:null;reference:TotalTaskReference}
 |{status:'UNKNOWN'|'REFUSED';value:null;reason:string;reference:TotalTaskReference};

function safetyLowerBound(expression:TotalExpression,budget:ReferenceBudget):bigint{
 const unsupported=():never=>{throw new ReferenceLimit('UNSUPPORTED_SAFE_LOWER_BOUND');};
 const affine=(e:TotalExpression):[bigint,bigint]=>{
  budget.step();
  if(e.op==='VAR'&&e.index===0)return [1n,0n];
  if(e.op==='INT'||e.op==='NAT')return [0n,checked(BigInt(e.value))];
  if(e.op==='ADD'||e.op==='SUB'||e.op==='MUL'){
   const [a,b]=affine(e.left),[c,d]=affine(e.right);
   if(e.op==='ADD')return [checked(a+c),checked(b+d)];
   if(e.op==='SUB'){
    if(expressionType(e.left,['INT'])==='NAT')return unsupported();
    return [checked(a-c),checked(b-d)];
   }
   if(a!==0n&&c!==0n)return unsupported();
   return [checked(a*d+b*c),checked(b*d)];
  }
  return unsupported();
 };
 budget.step();
 if(expression.op==='AND'){
  const necessary=(child:TotalExpression):bigint|null=>{
   try{return safetyLowerBound(child,budget);}
   catch(error){
    if(error instanceof ReferenceLimit&&error.message==='UNSUPPORTED_SAFE_LOWER_BOUND')return null;
    throw error;
   }
  };
  const a=necessary(expression.left),b=necessary(expression.right);
  if(a===null)return b===null?unsupported():b;
  return b===null||a>b?a:b;
 }
 if(expression.op==='OR'){
  const a=safetyLowerBound(expression.left,budget),b=safetyLowerBound(expression.right,budget);
  return a<b?a:b;
 }
 if(expression.op!=='LE'&&expression.op!=='LT'&&expression.op!=='EQ')return unsupported();
 const [a,b]=affine(expression.left),[c,d]=affine(expression.right);
 let coefficient=checked(c-a),constant=checked(d-b);
 if(expression.op==='EQ'&&coefficient<0n){coefficient=-coefficient;constant=-constant;}
 if(coefficient<=0n)return unsupported();
 const numerator=checked((expression.op==='LT'?1n:0n)-constant),q=numerator/coefficient,r=numerator%coefficient;
 return checked(q+(r>0n?1n:0n));
}

/** No recurrence, candidate program, supplied answer, or successful proof enters this reference. */
export function evaluateTotalTaskModel(specification:ResolvedTotalSpecification,task:TotalTaskBinding,
 deadlineAt=Date.now()+totalReferenceBounds.maxWallMs):TotalTaskModelResult{
 return runTotalTaskModel(specification,task,{stopAt:Math.min(deadlineAt,Date.now()+totalReferenceBounds.maxWallMs),
  maxSteps:totalReferenceBounds.maxExpressionSteps});
}

/**
 * Rechecks a recorded MODEL_ACCEPTED result. The work it recorded bounds the replay, and the host clock never does:
 * a stalled process must not turn an accepted record into a failed recheck.
 */
export function replayTotalTaskModel(specification:ResolvedTotalSpecification,task:TotalTaskBinding,recordedSteps:number){
 return runTotalTaskModel(specification,task,{stopAt:Infinity,
  maxSteps:Math.min(recordedSteps,totalReferenceBounds.maxExpressionSteps)});
}

function runTotalTaskModel(specification:ResolvedTotalSpecification,task:TotalTaskBinding,
 limits:{stopAt:number;maxSteps:number}):TotalTaskModelResult{
 const referenceEvidence:TotalTaskReference={schema:'finnor.s5.total-task-exhaustive-reference.v2',method:referenceMethod,
  bounds:totalReferenceBounds,lowerBound:null,rejected:[],prefixes:[],candidatesExamined:0,expressionSteps:0,
  includesEmptyPrefix:true,scope:'FINITE_TASK_MEANING_INTERPRETATION_NOT_DISCOVERED_ALGORITHM'};
 const budget={step:()=>{
  if(limits.stopAt<Infinity&&Date.now()>=limits.stopAt)throw new ReferenceLimit('TIME_BOUND');
  if(++referenceEvidence.expressionSteps>limits.maxSteps)throw new ReferenceLimit('EVALUATION_BOUND');
 }};
 let bytes=0;
 try{
  if(task.specificationDigest!==digest(specification)||digest(task.instance.specificationRef)!==digest(specification.sourceRef))
   throw new ReferenceLimit('SPECIFICATION_BINDING_MISMATCH');
  const lower=safetyLowerBound(specification.definition.safe,budget);
  referenceEvidence.lowerBound={value:lower.toString(),safeExpressionDigest:digest(specification.definition.safe),
   rule:'NECESSARY_AFFINE_EMPTY_PREFIX_SAFETY_LOWER_BOUND'};
  bytes=Buffer.byteLength(JSON.stringify(referenceEvidence));
  for(let n=0;n<totalReferenceBounds.maxCandidates;n++){
   budget.step();const candidate=checked(lower+BigInt(n)).toString();
   const prefixes=taskPrefixes(specification,task,candidate,budget);
   referenceEvidence.candidatesExamined++;
   const bad=prefixes.find(p=>!p.safe);
   if(!bad){
    referenceEvidence.prefixes=prefixes;
    if(Buffer.byteLength(JSON.stringify(referenceEvidence))>totalReferenceBounds.maxEvidenceBytes)throw new ReferenceLimit('BYTES_BOUND');
    return {status:'MODEL_ACCEPTED',value:candidate,reason:null,reference:referenceEvidence};
   }
   const witness={value:candidate,firstUnsafePrefix:bad.length,state:bad.state};
   bytes+=Buffer.byteLength(JSON.stringify(witness))+1;
   if(bytes>totalReferenceBounds.maxEvidenceBytes)throw new ReferenceLimit('BYTES_BOUND');
   referenceEvidence.rejected.push(witness);
  }
  throw new ReferenceLimit('CANDIDATE_BOUND');
 }catch(error){
  const reason=error instanceof ReferenceLimit?error.message:
   error instanceof Error&&/INTEGER_BOUND/.test(error.message)?'INTEGER_BOUND':null;
  if(!reason)throw error;
  referenceEvidence.prefixes=[];
  return {status:reason==='UNSUPPORTED_SAFE_LOWER_BOUND'||reason==='SPECIFICATION_BINDING_MISMATCH'?'REFUSED':'UNKNOWN',
   value:null,reason,reference:referenceEvidence};
 }
}
