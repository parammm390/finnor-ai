/** The persisted recipient artifact, not a second evidence or authority store. */
import {z} from 'zod';
import {UnknownBinding} from '../institution-program/contracts';
import {RefSchema,hex,sha,fail,type ConfidentialReleaseFields,type ConfidentialRef} from './contracts';
import type {ComputationRow,ConsentRow} from './store';

const text=z.string().min(1),instant=z.string().datetime({offset:true});
export const ArtifactBindingSchema=z.union([
 z.object({status:z.literal('known'),reference:RefSchema,
  basis:z.enum(['SUPPLIED_REFERENCE','OWNER_ROW_OBSERVED','RUNTIME_OBSERVED'])}).strict(),
 UnknownBinding,
]);
type Binding=z.infer<typeof ArtifactBindingSchema>;
const bindings=z.array(ArtifactBindingSchema);
export const PostXArtifactEnvelopeSchema=z.object({
 artifact_id:text,kind:z.literal('ConfidentialEconomicComputation'),schema_revision:z.literal('2'),content_digest:hex,
 work_and_revision_refs:bindings,
 tenant_and_participant_scope:z.object({tenantId:text,recipientId:text,participants:z.array(z.object({
  participantId:text,institutionId:text,authorityRef:RefSchema,
 }).strict())}).strict(),
 baseline_manifest_ref:ArtifactBindingSchema,
 producer_code_dependency_model_and_runtime_refs:bindings,
 source_revision_vector:z.record(RefSchema),knowledge_cut:instant,effective_time:instant,
 rights_and_authority_revision_refs:bindings,mandate_ref:ArtifactBindingSchema,
 economic_semantics_and_domain_refs:bindings,claim_basis_and_independent_checker_refs:bindings,
 unresolved_assumptions_and_excluded_claims:z.array(text),
 resource_reservation_and_complete_cost_refs:bindings,invalidation_dependencies:bindings,
 admission_and_release_refs:bindings,external_observation_and_s6_obligation_refs:bindings,
}).strict();
export type PostXArtifactEnvelope=z.infer<typeof PostXArtifactEnvelopeSchema>;
export interface CompleteConfidentialEconomicComputation extends ConfidentialReleaseFields {
 schema:'finnor.confidential-economic-computation.v2';
 envelope:PostXArtifactEnvelope;
 admitted_function_and_exact_numerical_semantics:Record<string,unknown>;
 participant_local_input_and_rights_contracts:Record<string,unknown>;
 input_commitment_freshness_and_validation_refs:Record<string,unknown>;
 compiled_circuit_or_protocol_identity:Record<string,unknown>;
 corruption_and_trust_profile:Record<string,unknown>;
 permitted_output_and_leakage_contract:Record<string,unknown>;
 preprocessing_key_and_execution_receipts:Record<string,unknown>;
 independently_checked_result_basis:Record<string,unknown>;
 query_release_and_revocation_conditions:Record<string,unknown>;
 participant_abort_and_reconciliation_state:Record<string,unknown>;
}
const unknown=(reason:string,requiredOwnerOrInput:string,affectedRefs:string[]):Binding=>
 ({status:'unknown',reason,requiredOwnerOrInput,affectedRefs});
const known=(reference:ConfidentialRef,basis:'SUPPLIED_REFERENCE'|'OWNER_ROW_OBSERVED'|'RUNTIME_OBSERVED'='SUPPLIED_REFERENCE'):Binding=>
 ({status:'known',reference,basis});
const observed=(owner:string,id:string,version:string,value:unknown):Binding=>
 known({owner,id,version,contentDigest:sha(value)},'OWNER_ROW_OBSERVED');

export function completeConfidentialArtifact(q:ComputationRow,consents:ConsentRow[],
 commitments:Array<{body:Record<string,unknown>;body_digest:string}>,
 recipientId:string,release:ConfidentialReleaseFields,at:string):CompleteConfidentialEconomicComputation{
 if(!q.protocol||!q.correspondence||!q.session||!q.runtime_receipt||q.status!=='COMPUTED')
  fail('Y4_COMPLETED_OWNER_BASIS_REQUIRED');
 const f=q.request.function,profile=q.environment.profile as Record<string,unknown>,
  runtime=observed('runtime',q.id,'installed-source-cut-v1',q.environment),
  checker=observed('Y4_CORRESPONDENCE',q.id,q.protocol.profileDigest,q.correspondence),
  execution=observed('Y4_EXECUTION',q.session.sessionId,'native-receipts-v1',q.runtime_receipt),
  work=known({owner:'Work',id:q.work_id,version:q.work_input_id,
   contentDigest:hex.parse(q.work_input_digest.replace(/^sha256:/,''))},'OWNER_ROW_OBSERVED'),
  costs=unknown('Complete money, human, storage, transport, maintenance and simultaneous-memory meters are not present',
   'S7/complete lifecycle cost owner',[q.id]),
  admission=unknown('No typed Y4 S8 admission receipt has been issued','S8/confidential computation admission',[q.id]),
  resultCheck=unknown('No independently administered protected result-check receipt has been issued',
   'independent authorized result checker',[q.id]),
  grants=f.inputs.map(p=>known(p.grantRef)),sources=f.inputs.map(p=>known(p.sourceRef)),
  rights=consents.map(c=>observed('Y4_CONSENT',q.id+':'+c.participant_id,c.body.authorityRevision,c.body));
 const envelope:PostXArtifactEnvelope=PostXArtifactEnvelopeSchema.parse({
  artifact_id:release.releaseId,kind:'ConfidentialEconomicComputation',schema_revision:'2',content_digest:'0'.repeat(64),
  work_and_revision_refs:[work,known(f.workRevisionRef)],tenant_and_participant_scope:{
   tenantId:q.tenant_id,recipientId,participants:f.participants.map(p=>({
    participantId:p.id,institutionId:p.institutionId,authorityRef:p.authorityRef,
   }))},
  baseline_manifest_ref:unknown('The supplied baseline pointer is not a qualified B_X_release receipt',
   'qualified X release/comparator owner',[f.baselineManifestRef.id]),
  producer_code_dependency_model_and_runtime_refs:[runtime,
   unknown('No model is used by this bounded compiler','not applicable: no model',[q.id])],
  source_revision_vector:Object.fromEntries(f.inputs.map(p=>[p.key,p.sourceRef])),
  knowledge_cut:at,effective_time:at,rights_and_authority_revision_refs:[...grants,...rights],
  mandate_ref:known(f.mandateRef),economic_semantics_and_domain_refs:[known(f.jointSemanticsRef),
   observed('Y4_PROFILE','finnor.postx-y4-profile',String(profile.revision),profile)],
  claim_basis_and_independent_checker_refs:[checker,execution,resultCheck],
  unresolved_assumptions_and_excluded_claims:[
   'LOCAL_ENGINEERING_ONLY; at least one honest participant; active-malicious n-1 with abort under the pinned protocol assumptions',
   'No fairness, guaranteed completion, common-host-operator confidentiality or separately administered qualification',
   'Source references, range validity and authenticated commitments do not prove primary-source financial truth',
   'CHECKED is not protected admission, legal efficacy, settlement, production activation or effect authority',
   'No protected corpus, qualified comparative increment, operational 100x or financial owner-value claim',
  ],
  resource_reservation_and_complete_cost_refs:[
   observed('Y4_RESOURCE_RESERVATION',q.id,String(q.generation),{
    originalLimits:q.request.limits,cpuReservedSeconds:q.cpu_reserved_seconds,retainedDatabaseBytesAtRelease:q.data_bytes,
   }),costs],
  invalidation_dependencies:[work,known(f.workRevisionRef),runtime,...sources,...grants,...rights,
   known(f.release.policyRef),known(f.release.termsRef)],
  admission_and_release_refs:[admission,known({owner:'Y4_RECIPIENT_RELEASE',id:release.releaseId,
   version:release.sessionId,contentDigest:release.outputCommitment},'RUNTIME_OBSERVED')],
  external_observation_and_s6_obligation_refs:[
   unknown('This computation issues no external economic effect or S6 authority; unrelated obligations retain their original owners',
    'S6/current separately authorized obligation and observation owners',[q.work_id])],
 });
 const body:CompleteConfidentialEconomicComputation={
  ...release,schema:'finnor.confidential-economic-computation.v2',envelope,
  admitted_function_and_exact_numerical_semantics:{
   canonicalFunction:f,canonicalExpression:profile.canonicalExpression,numericalOwner:profile.numericalOwner,
   profile,checkedFunctionDigest:q.protocol.functionDigest,baselineManifestSupplied:f.baselineManifestRef,
  },
  participant_local_input_and_rights_contracts:{participants:f.participants,consents:consents.map(c=>({
   participantId:c.participant_id,principalId:c.principal_id,consentDigest:c.body_digest,contract:c.body,
  })),participantLedgersMerged:false,globalCredentialGranted:false},
  input_commitment_freshness_and_validation_refs:{commitments,inputs:f.inputs.map(p=>({
   key:p.key,sourceRef:p.sourceRef,grantRef:p.grantRef,validationRef:p.validationRef,
   primaryEvidenceRef:p.primaryEvidenceRef,sourceStatus:p.sourceStatus,freshUntil:p.freshUntil,
  })),sourceTruthProven:false},
  compiled_circuit_or_protocol_identity:{protocolDigest:release.protocolDigest,
   functionDigest:release.functionDigest,profileDigest:release.profileDigest,program:q.runtime_receipt.program,runtime},
  corruption_and_trust_profile:{backend:profile.backend,localEngineeringOnly:true,
   deploymentSecurityReview:unknown('The shipped deployment has no issued security review','deployment security reviewer',[q.id])},
  permitted_output_and_leakage_contract:{policy:f.release,outputs:f.outputs.map(o=>({
   key:o.key,recipients:o.recipients,semantics:o.semantics,
  })),publicMetadata:['function/profile identities','participant identities','input commitments','validity/abort classes',
   'message sizes','progress','timing','MPC-authenticated hiding output commitments'],privateValuesInSharedWork:false,
   cumulativeRule:profile.outputPolicy},
  preprocessing_key_and_execution_receipts:{executionReceipt:q.runtime_receipt,
   preprocessing:'FRESH_LIVE_NO_FILE_REUSE',privateKeysOrPreprocessingExported:false,unsafeReplayPermitted:false},
  independently_checked_result_basis:{originalFunctionCorrespondence:q.correspondence,
   independentlyReconstructedNativeReceipts:q.runtime_receipt.nativeVerifications,
   authenticatedRecipientOutputCommitment:release.outputCommitment,protectedIndependentResultCheck:resultCheck,
   proofScope:'ORDERED_GRAPH_CORRESPONDENCE_AND_PINNED_BACKEND_ASSUMPTIONS_NOT_A_GENERAL_CRYPTOGRAPHIC_OR_TRANSLATION_THEOREM'},
  query_release_and_revocation_conditions:{policy:f.release,originalDeadlineAt:q.deadline_at.toISOString(),
   cryptographicDeadlineAt:q.session.deadlineAt,historyOwner:{table:'y4_events',computationId:q.id},
   currentnessRecheckedAtRelease:true,prospectiveUseAndDerivativeRevocation:true,priorKnowledgeRecallClaimed:false},
  participant_abort_and_reconciliation_state:{state:'COMPLETED',receipts:q.runtime_receipt.receipts,
   originalSessionId:q.session.sessionId,originalEconomicEffects:'UNCHANGED_BY_MPC_STATE',
   automaticReservationRefund:false,automaticUnsafeRestart:false,plaintextFallback:false},
 };
 const {content_digest:_,...header}=envelope;
 body.envelope={...envelope,content_digest:sha({...body,envelope:header})};
 return body;
}

export function assertCompleteArtifact(value:CompleteConfidentialEconomicComputation):void{
 if(value.schema!=='finnor.confidential-economic-computation.v2')fail('Y4_COMPLETE_ARTIFACT_SCHEMA_REQUIRED');
 const header=PostXArtifactEnvelopeSchema.parse(value.envelope),{content_digest,...preimage}=header;
 if(sha({...value,envelope:preimage})!==content_digest)fail('Y4_COMPLETE_ARTIFACT_CONTENT_CHANGED');
}

export function constructionObservation(q:ComputationRow,current:boolean,artifact?:CompleteConfidentialEconomicComputation){
 return {
  ...(artifact?{artifact_ref:{owner:'Y4_RECIPIENT_RELEASE',id:artifact.releaseId,version:artifact.schema,
   contentDigest:artifact.envelope.content_digest}}:{}),
  result:!current?'UNKNOWN' as const:q.status==='UNSUPPORTED'?'UNSUPPORTED' as const:
   artifact?'CHECKED' as const:['FAILED','RECONCILIATION_REQUIRED','CANCELLED','INVALIDATED'].includes(q.status)?
    'INCOMPLETE' as const:'CANDIDATE' as const,
  claim_and_gap_refs:[unknown('Development computation is not source truth, protected qualification or production activation',
   'S1/V2, S8 and deployment authority',[q.id])],
  independent_check_refs:q.correspondence?[observed('Y4_CORRESPONDENCE',q.id,'ordered-graph-v1',q.correspondence)]:[],
  cost_and_outstanding_obligation_refs:[
   unknown('Complete costs and external obligations require their actual owners','S7/S6',[q.id,q.work_id])],
 };
}
