import type { EvidenceDerivation } from '@finnor/shared-types';
import type { ResolvedInput } from '@finnor/underwriting';
import { DatabaseExecutionDeadlineError } from '@finnor/db';
import { currentDerivation } from '../evidence-execution/store';
import { resolveEvidenceUnderwritingInputs } from '../evidence-execution/consumer';
import { PeDomainError, type PeMutationContext } from '../types';
import { p4Ref, unavailable, type DecisionSliceRequest, type WorkBinding } from './contracts';
import { checkEpisode } from './budget';

/** Only the installed P4 owner resolves results. No caller numbers, envelopes,
 * alternate extraction runtime or model-generated code enter this port. */
export async function resolveP4Inputs(ctx:PeMutationContext,request:DecisionSliceRequest,work:WorkBinding,knowledgeAt:string){
  const values:Record<string,ResolvedInput>={},derivations:EvidenceDerivation[]=[],failures:Record<string,string>={};
  if(request.source.kind!=='UNDERWRITING')return {values,derivations,failures};
  const source=request.source;
  for(const [nodeId,binding]of Object.entries(source.evidenceDerivationInputs??{})){
    checkEpisode();
    try{
      const derivation=await currentDerivation(ctx,binding.derivationId);
      if(derivation.schema!=='finnor.evidence-derivation.v1'||derivation.code.version!=='p4-native-v1'||
        derivation.status!=='TESTED'||derivation.failure||!derivation.result||
        derivation.coverage.status!=='COMPLETE_SELECTED_UNIVERSE'||!derivation.independentChecks.length||derivation.independentChecks.some(check=>check.status!=='PASS')||
        derivation.contradictions.length)throw Error('P4_CURRENT_COMPLETE_CHECKS_REQUIRED');
      if(derivation.work.id!==work.id||derivation.work.revision!==work.inputId)throw unavailable();
      if(Date.parse(derivation.knowledgeAt)>Date.parse(knowledgeAt))throw Error('P4_KNOWLEDGE_CUT_MISMATCH');
      const resolved=await resolveEvidenceUnderwritingInputs(ctx,source.investmentCaseId,source.modelVersionId,{[nodeId]:binding});
      values[nodeId]=resolved[nodeId]!;
      if(!derivations.some(d=>d.id===derivation.id))derivations.push(derivation);
    }catch(error){
      if(error instanceof PeDomainError||error instanceof DatabaseExecutionDeadlineError)throw error;
      if((error as {code?:string}).code==='UNAVAILABLE')throw error;
      checkEpisode();
      const predicate=error instanceof Error?error.message:'';
      failures[nodeId]=/ENTITY|PERIOD|UNIT|CURRENCY|PRECISION|SEMANTIC|SHADOW|TRUTH|TARGET|KNOWLEDGE_CUT/.test(predicate)
        ?'P4_SEMANTIC_INPUT_MISMATCH':'P4_CURRENT_CHECKED_INPUT_UNAVAILABLE';
    }
  }
  return {values,derivations,failures};
}
export async function recheckP4Derivations(ctx:PeMutationContext,derivations:EvidenceDerivation[]):Promise<void>{
  for(const original of derivations){
    checkEpisode();
    const current=await currentDerivation(ctx,original.id);
    if(p4Ref(current).contentDigest!==p4Ref(original).contentDigest)throw Error('P4_CURRENT_IMMUTABLE_PREIMAGE_CHANGED');
  }
}
