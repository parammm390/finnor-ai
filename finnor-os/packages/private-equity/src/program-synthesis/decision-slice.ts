/** Exact frozen M1 reader join. Complete P4 scalar coverage is a different domain. */
import {readCurrentModelEvidenceForProgramme} from '../decision-slice/model-evidence-reader';
import {M1_VERSION} from '../decision-slice/contracts';
import {principal,sha} from '../evidence-execution/store';
import type {PeMutationContext} from '../types';
import type {HarnessRequest} from './contracts';
export async function readHarnessDecisionSlice(ctx:PeMutationContext,ref:NonNullable<HarnessRequest['ownerBindings']>['decisionSliceRef'],cut:{programId:string;workId:string;inputId:string;validAt:string;knowledgeAt:string}){
 if(!ref||ref.owner!=='M1'||ref.version!==M1_VERSION)throw Error('M1_AUTHENTIC_NATIVE_REFERENCE_REQUIRED');const begun=performance.now(),current=await readCurrentModelEvidenceForProgramme(ctx,ref as any,{tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId:cut.workId,workInputId:cut.inputId,programId:cut.programId}),{slice,binding}=current;
 if(binding.tenantId!==ctx.auth.tenantId||binding.principalId!==principal(ctx)||binding.work.id!==cut.workId||binding.work.inputId!==cut.inputId)throw Error('M1_EXACT_PROGRAMME_WORK_INPUT_PRINCIPAL_MISMATCH');
 if(slice.envelope.validAt!==cut.validAt||slice.envelope.knowledgeAt!==cut.knowledgeAt)throw Error('M1_PROGRAMME_VALID_KNOWLEDGE_CUT_MISMATCH');
 if(binding.request.purpose!=='MODEL_EVIDENCE')throw Error('M1_DECISION_SUFFICIENCY_OWNER_CONTINUATION_REQUIRED');
 if(slice.projectionSupport.check.status!=='CHECKED'||slice.projectionSupport.check.exactPreservation!==true)throw Error('M1_NATIVE_EXACT_PROJECTION_UNPASSED');
 return {owner:'M1',ref:slice.ref,readerVersion:M1_VERSION,completedModelReadContract:'M1_MODEL_EVIDENCE_READ_ONLY_V1',frozenProducerCommit:'32d7d6ba6e8bfe344a04a63ffee34e4904df654e',work:binding.work,validAt:slice.envelope.validAt,knowledgeAt:slice.envelope.knowledgeAt,projectionSupport:slice.projectionSupport,evidenceDemands:slice.evidenceDemands,unresolvedCoverage:slice.unresolvedCoverage,nativeBindingDigest:sha(binding),decisionSufficiencyEstablished:false,p4CompleteScalarCoverageClearsDecisionDemands:false,executionAuthorityGranted:false,usage:{elapsedMs:performance.now()-begun,money:null,status:'UNMETERED',scope:'LOCAL_OWNER_READER_INTERVAL'},qualification:'CURRENT_M1_NATIVE_MODEL_EVIDENCE_WITH_RETAINED_DECISION_GAPS'};
}
