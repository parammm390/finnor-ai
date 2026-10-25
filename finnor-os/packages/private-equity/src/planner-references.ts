import type {PoolClient} from 'pg';
import {PrimaryUnderwritingInputsSchema,EvidenceUnderwritingBindingSchema} from '@finnor/shared-types';
import type {PeMutationContext} from './types';
import {primaryActionIntake} from './primary-diligence/action';
import {validatePrimarySubmission} from './primary-diligence/api';
import {currentFinding} from './primary-diligence/store';
import {currentDerivation} from './evidence-execution/store';
import {assertReviewedAcquisitionAction} from './acquisition/reviewed-request';

/** Primary assertions are proposed records; finding and derivation references
 * belong to private evidence owners rather than the Deal graph registry. */
export async function groundOwnedPlannerReferences(ctx:PeMutationContext,actionType:string,payload:Record<string,unknown>,workId:string,client:PoolClient){
 await assertReviewedAcquisitionAction(ctx,actionType,payload,workId,client);
 const fields:Array<{field:string;status:'verified'}>=[];
 if(actionType==='start_primary_diligence'){
  await validatePrimarySubmission(ctx,primaryActionIntake(payload,workId,'planner-reference-check'),client);
  return {canonicalPayload:{dealId:payload.dealId},fields:[{field:'primaryIntake',status:'verified' as const}]};
 }
 if(actionType!=='create_underwriting_run'||!payload.primaryFindingInputs&&!payload.evidenceDerivationInputs)return null;
 if(payload.primaryFindingInputs){
  for(const [node,binding] of Object.entries(PrimaryUnderwritingInputsSchema.parse(payload.primaryFindingInputs))){
   const {programme}=await currentFinding(ctx,binding.findingId,client);
   if(programme.work_id!==workId)throw Error('PRIMARY_CONSUMER_EXACT_WORK_SCOPE_MISMATCH');
   fields.push({field:'primaryFindingInputs.'+node+'.findingId',status:'verified'});
  }
 }
 if(payload.evidenceDerivationInputs){
  for(const [node,value] of Object.entries(payload.evidenceDerivationInputs as Record<string,unknown>)){
   const binding=EvidenceUnderwritingBindingSchema.parse(value),derivation=await currentDerivation(ctx,binding.derivationId,client);
   if(derivation.work.id!==workId)throw Error('DERIVATION_CONSUMER_WORK_SCOPE_MISMATCH');
   fields.push({field:'evidenceDerivationInputs.'+node+'.derivationId',status:'verified'});
  }
 }
 const {primaryFindingInputs:_primary,evidenceDerivationInputs:_derivations,...canonicalPayload}=payload;
 return {canonicalPayload,fields};
}
