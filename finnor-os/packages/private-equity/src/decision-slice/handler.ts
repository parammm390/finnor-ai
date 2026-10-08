import { z } from 'zod';
import { PeDomainError, type PeMutationContext } from '../types';
import { RefSchema, RequestSchema, assertBounded, unavailable } from './contracts';
import { compileDecisionSlice, readCurrentDecisionSlice, decisionSliceContext, decisionSlicePatch, cancelDecisionSlice,
  recompileDecisionSlice, inspectDependencyChanges, measuredM1, retainedDecisionWorkId } from './service';
import { consumeDecisionSlice, decisionSliceWitness } from './consumer';
import { inM1Episode } from './budget';
const ReadSchema=z.object({sliceRef:RefSchema}).strict();
const PatchRequest=z.object({sliceRef:RefSchema,expectedContextRef:RefSchema,patch:z.unknown()}).strict();
const WitnessSchema=z.object({sliceRef:RefSchema,variableId:z.string().min(1).max(1024)}).strict();
const ConsumeSchema=z.object({sliceRef:RefSchema,use:z.enum(['DECISION','NUMERICAL_ONLY']),decision:z.unknown().optional()}).strict();
export const M1OperationSchemas={
  'decision-slice-compile':RequestSchema,'decision-slice-read':ReadSchema,'decision-slice-view':ReadSchema,
  'decision-slice-context':ReadSchema,'decision-slice-patch':PatchRequest,'decision-slice-witness':WitnessSchema,
  'decision-slice-consume':ConsumeSchema,'decision-slice-cancel':ReadSchema,'decision-slice-recompile':ReadSchema,
  'decision-slice-changes':ReadSchema,
} as const;
export const M1_OPERATIONS=new Set(['decision-slice-compile','decision-slice-read','decision-slice-context','decision-slice-patch',
  'decision-slice-witness','decision-slice-consume','decision-slice-cancel','decision-slice-recompile','decision-slice-changes','decision-slice-view']);
export async function handleDecisionSliceOperation(ctx:PeMutationContext,operation:string,body:unknown):Promise<unknown>{
  const requested=(body as {resource?:{deadlineMs?:unknown}})?.resource?.deadlineMs;
  const deadline=typeof requested==='number'&&Number.isInteger(requested)&&requested>0?Math.min(requested,30000):30000;
  return inM1Episode(deadline,async()=>{
    try{
      const workId=operation==='decision-slice-compile'?RequestSchema.parse(body).workId:
        await retainedDecisionWorkId(ctx,(body as {sliceRef?:unknown})?.sliceRef);
      return await measuredM1(ctx,operation,workId,deadline,async()=>{
        const result=await dispatch(ctx,operation,body);assertBounded(result);return result;
      });
    }
    catch(error){
      if(error instanceof PeDomainError&&error.code==='PE_ENTITY_NOT_FOUND')throw unavailable();
      throw error;
    }
  });
}
async function dispatch(ctx:PeMutationContext,operation:string,body:unknown):Promise<unknown>{
  switch(operation){
    case 'decision-slice-compile':return compileDecisionSlice(ctx,body);
    case 'decision-slice-read':{
      const current=await readCurrentDecisionSlice(ctx,ReadSchema.parse(body).sliceRef);
      return {slice:current.slice,projectionInput:current.projectionInput,executionAuthorityGranted:false};
    }
    case 'decision-slice-view':{
      const {slice}=await readCurrentDecisionSlice(ctx,ReadSchema.parse(body).sliceRef);
      return {slice,executionAuthorityGranted:false};
    }
    case 'decision-slice-context':return decisionSliceContext(ctx,ReadSchema.parse(body).sliceRef);
    case 'decision-slice-patch':{const input=PatchRequest.parse(body);return decisionSlicePatch(ctx,input.sliceRef,input.expectedContextRef,input.patch);}
    case 'decision-slice-witness':{const input=WitnessSchema.parse(body);return decisionSliceWitness(ctx,input.sliceRef,input.variableId);}
    case 'decision-slice-consume':{const input=ConsumeSchema.parse(body);return consumeDecisionSlice(ctx,input.sliceRef,input.use,input.decision);}
    case 'decision-slice-cancel':return cancelDecisionSlice(ctx,ReadSchema.parse(body).sliceRef);
    case 'decision-slice-recompile':return recompileDecisionSlice(ctx,ReadSchema.parse(body).sliceRef);
    case 'decision-slice-changes':return inspectDependencyChanges(ctx,ReadSchema.parse(body).sliceRef);
    default:throw new Error('Unsupported registered M1 operation');
  }
}
