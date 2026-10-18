import type {VReference} from './primary-diligence';

/** Ordinary artifact identity. Metadata is evidence, never delegated authority.
 * Additive until the unavailable X1/X2 handoff supplies a compatible common owner. */
export interface FrontierArtifactEnvelope {
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
export interface EnterpriseApplicationPackage extends FrontierArtifactEnvelope {
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
