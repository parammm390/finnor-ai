import type {DiligenceValue,VReference} from './primary-diligence';

/** Ordinary artifact identity. Metadata is evidence, never delegated authority.
 * Additive until the unavailable X1/X2 handoff supplies a compatible common owner. */
export interface ApplicationReleaseBinding {
 tenantId:string;
 principalId:string;
 rights:{revision:number;ref:string;evaluatedAt:string};
 work:{id:string;revision:string;inputDigest:string};
 mandate:VReference|null;
 parents:VReference[];
 inputsDigest:string;
 code:{version:string;sourceDigest:string;checkerDigest:string;schemaDigest:string};
 runtime:{node:string;platform:string;architecture:string;imageDigest:string|null;sourceDigest:string;lockDigest:string;jobId:string;deliveryAttemptId:string;claimFence:number;workerId:string};
 validity:{profile:string;root:{entityType:string;entityId:string};validAfter:string;validUntil:string;production:false};
 resources:{allocationId:string;originalDeadlineAt:string;buildAttempts:number;wallMs:number;cpuMicros:number;peakProcessRSSBytes:number;aggregatePeakRSSBytes:null;inputBytes:number;outputBytes:number;usd:null;humanEffort:null;status:'LOCAL_COST_PARTIALLY_METERED'};
 proofs:{method:string;digest:string;caseIds:string[];criticalRequirements:string[];protectedCustody:false};
 admission:VReference|null;
 status:'STAGED'|'INSTALLED_DEVELOPMENT'|'INVALIDATED'|'CANCELLED';
 limitations:string[];
}
export interface EnterpriseApplicationRelease extends ApplicationReleaseBinding {
 schema:'finnor.enterprise-application-package.v1';
 id:string;
 applicationId:string;
 specification:VReference;
 sourceFiles:{path:string;digest:string;bytes:number;language:'json'|'html'}[];
 backend:{format:'X3_TYPED_STACK_V1';digest:string;entrypoint:'application-command'};
 frontend:{format:'FINNOR_HOST_TYPED_FORMS_V1';digest:string;entrypoint:'WORK_ENTERPRISE_APPLICATION'};
 database:{owner:'@finnor/db';migrationHead:string;schemaDigest:string;dataPreservation:'TRANSACTIONAL_VALIDATE_AND_RETAIN_ORIGINAL'};
 dependencies:{manifestDigest:string;hostContracts:string[];guestDependencies:[]};
 deployment:{mode:'ORDINARY_DEVELOPMENT';api:'NEXT_ROUTE_HANDLER';worker:'DURABLE_JOB_V1';productionActive:false};
 maintenance:{generation:number;priorReleaseId:string|null;changeClass:'INITIAL'|'BUSINESS_RULES_UNITS'|'IDENTITY_AUTHORIZATION_CONCURRENCY'|'DEPENDENCY_SCHEMA_DEPLOYMENT';rollback:'VALIDATE_REAL_DATA_AND_OUTSTANDING_OBLIGATIONS'};
}

type FrontierUnknown=Extract<DiligenceValue,{kind:'UNKNOWN'}>;
export interface FrontierEventCollectionReference {
 owner:'@finnor/db';
 table:'x3_events';
 tenantId:string;
 applicationId:string;
 eventKinds:string[];
 count:string;
 snapshotThroughEventId:string|null;
 read:{operation:'application-history';applicationId:string;before?:string;limit:100};
 referenceField:'body'|'body.obligationRef'|'body.leases';
}
export interface FrontierArtifactEnvelope {
 artifact_id:string;
 kind:'EnterpriseApplicationPackage';
 schema_revision:'finnor.frontier-artifact-envelope.v1';
 content_digest:string;
 content_digest_basis:'IMMUTABLE_X3_RELEASE_BODY_V1';
 tenant_ref:{owner:'@finnor/db';table:'tenants';id:string};
 principal_ref:{owner:'@finnor/db';table:'users';tenantId:string;id:string};
 work_ref:VReference;
 institutional_program_ref:FrontierUnknown;
 parent_artifact_refs:VReference[];
 producer_revision:VReference;
 baseline_manifest_ref:VReference;
 baseline_manifest_kind:'B_live';
 authority_grant_ref:FrontierUnknown;
 rights_revision:string;
 resource_grant_ref:VReference;
 resource_lease_refs:FrontierEventCollectionReference;
 source_refs:VReference[];
 source_revision_vector:Record<string,string>;
 knowledge_cut:{constructedAt:string;specification:VReference;workInput:VReference;meaning:'PINNED_CONSTRUCTION_INPUTS_NOT_BUSINESS_TRUTH'};
 admitted_domain_ref:FrontierUnknown;
 application_fingerprints:{applicationId:string;releaseId:string;backendDigest:string;frontendDigest:string;schemaDigest:string;hostSourceDigest:string};
 model_refs:VReference[];
 model_use:'NONE_TYPED_COMPILER';
 dependency_lock_digest:string;
 runtime_digest:string;
 observed_claims:{claim:string;basis:VReference|FrontierEventCollectionReference;scope:string}[];
 inferred_claims:never[];
 predicted_claims:never[];
 unresolved_claims:{claim:string;critical:false;value:FrontierUnknown}[];
 postcondition_contract_refs:VReference[];
 independent_check_refs:VReference[];
 S6_obligation_refs:FrontierEventCollectionReference;
 provider_observation_refs:FrontierUnknown;
 invalidation_dependencies:{refs:VReference[];rightsRevision:string;owner:'P7';currentOwnerChecksRequired:true};
 lifecycle_state:{applicationStatus:string;releaseState:'INSTALLED_DEVELOPMENT';immutableBuildState:ApplicationReleaseBinding['status'];productionActive:false};
 lifecycle_events:FrontierEventCollectionReference;
 build_learning_compute_cost_refs:{events:FrontierEventCollectionReference;aggregateMemory:FrontierUnknown;money:FrontierUnknown;failedAndInterruptedAttemptsRetained:true};
 attributable_human_work_refs:FrontierUnknown;
}
/** Current authenticated metadata projects existing owners without rewriting
 * the immutable release body named by envelope.content_digest. */
export interface EnterpriseApplicationPackage extends EnterpriseApplicationRelease {
 envelope:FrontierArtifactEnvelope;
}
