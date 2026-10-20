import type {VReference} from './primary-diligence';
export interface LearningUnknown{kind:'UNKNOWN';reason:string}
export interface LearnedPolicyEventReference{
 owner:'@finnor/db';table:'x5_events';tenantId:string;compilationId:string;throughEventId:string|null;count:string;
 read:{operation:'learning-read';compilationId:string};
}
export interface LearnedPolicyEnvelope{
 artifact_id:string;kind:'LearnedPolicyCapsule';schema_revision:'finnor.frontier-artifact-envelope.v1';
 content_digest:string;content_digest_basis:'IMMUTABLE_X5_RELEASE_BODY_V1';
 tenant_ref:{owner:'@finnor/db';table:'tenants';id:string};
 work_ref:VReference;institutional_program_ref:LearningUnknown;parent_artifact_refs:VReference[];
 producer_revision:VReference;baseline_manifest_ref:VReference;authority_grant_ref:LearningUnknown;
 rights_revision:string;resource_grant_ref:VReference;source_refs:VReference[];source_revision_vector:Record<string,string>;
 knowledge_cut:{at:string;experienceCutDigest:string;qualification:string};
 admitted_domain_ref:VReference|LearningUnknown;application_fingerprints:VReference[];model_refs:VReference[];
 dependency_lock_digest:string;runtime_digest:string;
 observed_claims:{claim:string;basis:VReference;scope:string}[];inferred_claims:never[];predicted_claims:never[];
 unresolved_claims:{claim:string;value:LearningUnknown}[];postcondition_contract_refs:VReference[];
 independent_check_refs:VReference[];S6_obligation_refs:LearningUnknown;provider_observation_refs:LearningUnknown;
 invalidation_dependencies:{owner:'P7';refs:VReference[];currentOwnerChecksRequired:true};
 lifecycle_state:{state:string;developmentOnly:true;protectedAdmission:false;productionActive:false};lifecycle_events:LearnedPolicyEventReference;
 build_learning_compute_cost_refs:{events:LearnedPolicyEventReference;completeMoney:LearningUnknown;aggregateMemory:LearningUnknown;failedAttemptsRetained:true};
 attributable_human_work_refs:LearningUnknown;
}
export interface LearnedPolicyProcedure{
 schema:'finnor.x5.bounded-policy.v1';profile:'PE_FIRM_DELAYED_RECONCILIATION_V1';
 input:'CURRENT_NATIVE_X3_RECORD_AND_FRESH_SEMANTIC_BINDING';abstraction:'STRUCTURAL_BOOLEANS_8_V1';
 instructions:['OBSERVE_CURRENT_OWNER_STATE','LOAD_EXACT_CONTROLLER','CLASSIFY','ENFORCE_NATIVE_PRECONDITIONS','DISPATCH_RECONCILIATION_OR_WAIT','REQUIRE_CURRENT_INDEPENDENT_ACCEPTANCE'];
 operations:['X3_READ_CURRENT_RECORD','X3_EXACT_RECONCILIATION','X3_REQUEST_INDEPENDENT_APPROVAL'];
 preconditions:['CURRENT_TENANT_PRINCIPAL_WORK_RIGHTS','COMPLETE_OBSERVATIONS','EXACT_DIMENSIONS','NO_PENDING_EFFECT','ORIGINAL_RESOURCES'];
 postconditions:['MANDATORY_RECONCILIATION_PRECEDES_ACCEPTANCE','DISTINCT_CURRENT_NONAUTHOR_APPROVERS','NATIVE_EXACT_VALUES_UNCHANGED'];
 guard:'CURRENT_CONSENT_AND_SOURCE_CLOSURE_AND_SUPPORTED_BINDING_AND_NATIVE_INTERPRETER';
 failureMonitor:'NO_MODEL_AUTHORITY_NO_EFFECT_REPLAY_NO_FALSE_COMPLETION';
 fallback:'CURRENT_NATIVE_X3_INTERPRETER_OR_WAIT_BLOCK_STOP_WITHIN_ORIGINAL_GRANT';
 invalidation:'EVIDENCE_RIGHTS_PARTITIONS_POLICY_CHECKPOINT_OPERATIONS_CHECKER_RUNTIME_ADMISSION';
 bounds:{maxUses:number;deadlineAt:string;childWallMs:30000;childHeapMiB:256};
}
export interface LearnedControllerCheckpoint{
 schema:'finnor.x5.controller-checkpoint.v1';architecture:'LINEAR_SOFTMAX_F64_8X4_V1';
 featureOrder:['bias','quantitiesKnown','exactDimensionalAgreement','observationsCurrent','noPendingEffect','initialState','reconciledState','acceptedState'];
 classes:['WAIT','RECONCILE','REQUEST_INDEPENDENT_CHECK','STOP_ACCEPTED'];weights:number[];
 preprocessing:'HOST_OBSERVED_STRUCTURAL_BOOLEANS_NO_IDENTIFIERS_OR_TEXT';precision:'IEEE754_BINARY64';license:'PROJECT_SOURCE_NO_EXTERNAL_WEIGHTS';digest:string;
}
export interface LearnedPolicyCapsule{
 schema:'finnor.learned-policy-capsule.v1';envelope:LearnedPolicyEnvelope;
 independently_accepted_training_evidence_refs:VReference[];
 transferable_state_abstraction:{format:'STRUCTURAL_BOOLEANS_8_V1';features:string[];excludes:['IDENTIFIERS','PRIVATE_FACTS','CREDENTIALS','OLD_PERMISSIONS','EXACT_BUSINESS_AMOUNTS']};
 typed_policy_or_procedure_program:LearnedPolicyProcedure;
 application_and_institution_binding_requirements:{profile:'PE_FIRM_DELAYED_RECONCILIATION_V1';tenantBinding:'FRESH_CURRENT';operationBinding:'FRESH_NATIVE_X3_SEMANTICS';permissions:'CURRENT_OWNER_AUTHORITY_NOT_TRAINING_GRANTS';unsupported:string[]};
 trained_component_architecture_and_checkpoint:{original:LearnedControllerCheckpoint;trained:LearnedControllerCheckpoint;inference:'SAFE_JSON_F64_CPU';externalWeights:false};
 training_data_rights_and_partition_manifest:{rightsRefs:VReference[];partitionDigest:string;knowledgeCut:string;qualification:'PUBLIC_DEVELOPMENT_NOT_PROTECTED';noCausalReward:true};
 training_algorithm_and_resource_receipts:{algorithm:string;configuration:Record<string,string|number>;sampleCount:number;samplesDigest:string;parameterChange:{observable:boolean;changed:number;l2Distance:number};physicalJobRef:VReference;wallMs:number;cpuMicros:number;peakProcessRSSBytes:number;money:LearningUnknown;human:LearningUnknown};
 validity_guard_and_failure_monitor:{guard:LearnedPolicyProcedure['guard'];failureMonitor:LearnedPolicyProcedure['failureMonitor'];deadlineAt:string;currentnessRequired:true};
 accepted_action_and_effect_interfaces:{operations:LearnedPolicyProcedure['operations'];effectAuthorityGranted:false;pendingEffects:'BLOCK_NO_REPLAY'};
 independent_transfer_and_retention_results:VReference|LearningUnknown;
 procedure_and_parameter_ablation_results:VReference|LearningUnknown;
 amortization_and_invalidation_record:{eligibleDevelopmentDemand:32;horizon:'REGISTERED_FINITE_DEVELOPMENT_CAMPAIGN';completeLifecycleCost:LearningUnknown;reasoningConsumption:LearningUnknown;invalidation:'REVOKE_DEPENDENT_USE_NO_UNLEARNING_OR_EXTERNAL_EFFECT_ROLLBACK'};
 s8_admission_and_promotion_refs:{proposal:VReference|LearningUnknown;admission:VReference|LearningUnknown;protectedAdmission:false;productionActive:false};
}
