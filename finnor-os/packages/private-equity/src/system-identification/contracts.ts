import {z} from 'zod';
import {assertApplicationData,ApplicationFault} from '../enterprise-applications/contracts';
import {digitalConditions,conditionMatches,identificationDigest,identificationCanonical,IDENTIFICATION_LIMITS} from '../../../epistemic-runtime/src/identification';
import type {DigitalIdentificationDomain,IdentifiedSystemRelease,DigitalExperimentProtocol,DigitalInstrumentCertificate,DigitalObservation,DigitalHttpReceipt,IdentificationFamily} from '../../../shared-types/src/identified-system';
export {identificationDigest as sha,identificationCanonical as canonical,IDENTIFICATION_LIMITS as LIMITS};
export const unknown=(reason:string)=>({kind:'UNKNOWN' as const,reason});
export function fail(code:string,status=409):never{throw new ApplicationFault(code,code,status);}
export function parse<S extends z.ZodTypeAny>(schema:S,value:unknown):z.output<S>{assertApplicationData(value,128*1024);return schema.parse(value);}
export const uuid=z.string().uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/),key=z.string().min(1).max(160),instant=z.string().datetime({offset:true});
export const RootSchema=z.object({entityType:z.literal('pe_deal'),entityId:uuid}).strict();
const timing=z.union([z.literal(-1),z.literal(1),z.literal(3)]),page=z.union([z.literal(1),z.literal(2),z.literal(4)]),bit=z.union([z.literal(0),z.literal(1)]);
const integer=z.string().regex(/^(0|-?[1-9][0-9]{0,6})$/).refine(v=>BigInt(v)>=-1000000n&&BigInt(v)<=1000000n);
const condition=z.object({updateTiming:timing,pageSize:page,visibility:bit}).strict();
export const DomainSchema=z.object({
 schema:z.literal('finnor.x4.digital-domain.v1'),profile:z.literal('PE_FIRM_DIGITAL_RELATION_V1'),
 applicationVersion:z.string().min(1).max(128),role:z.enum(['analyst','auditor']),
 records:z.array(z.object({value:integer,update:z.enum(['PREEXISTING','CONTROLLED']),visibility:z.enum(['PUBLIC','CONTROLLED']),
  features:z.object({cohort:z.number().int().min(-3).max(3).optional(),flag:z.number().int().min(-3).max(3).optional()}).strict()}).strict()).min(2).max(16),
 interventions:z.object({updateTiming:z.array(timing).min(1).max(3),pageSize:z.array(page).min(1).max(3),visibility:z.array(bit).min(1).max(2)}).strict(),
 ordinary:condition,withheld:condition,costUnits:z.number().int().min(1).max(1000000),
 assumptions:z.object({deterministic:z.literal(true),isolatedFreshRecords:z.literal(true),noInterference:z.literal(true),
  completePermittedObservations:z.literal(true),sameHostClock:z.literal(true),replicaVersionInvariant:z.literal(true)}).strict(),
}).strict();
export function assertDomain(d:DigitalIdentificationDomain){
 const conditions=digitalConditions(d);
 if(!conditions.some(c=>conditionMatches(c,d.ordinary))||!conditions.some(c=>conditionMatches(c,d.withheld))||identificationDigest(d.ordinary)===identificationDigest(d.withheld))fail('X4_REGISTERED_ORDINARY_AND_WITHHELD_REQUIRED',400);
 if(d.role==='auditor'&&d.interventions.visibility.some(v=>v!==1))fail('X4_ROLE_VISIBILITY_INTERVENTION_UNSUPPORTED',400);
 const features=Object.keys(d.records[0]!.features).sort().join('|');
 if(d.records.some(r=>Object.keys(r.features).sort().join('|')!==features))fail('X4_INCOMPLETE_FEATURE_MEMBERSHIP',400);
}
export const ConsentSchema=z.object({
 schema:z.literal('finnor.x4.experiment-rights.v1'),root:RootSchema,domain:DomainSchema,
 targetIds:z.array(uuid).min(2).max(4),actorIds:z.array(uuid).min(2).max(8),
 purposes:z.tuple([z.literal('EXPERIMENT'),z.literal('OBSERVE'),z.literal('REPLICATE'),z.literal('DERIVE_FINDING'),z.literal('USE_IN_DECISION')]),
 retention:z.literal('RETAIN_AUDIT_REVOKE_FUTURE_USE_NO_EFFECT_ROLLBACK'),
 validUntil:instant,idempotencyKey:key,
}).strict();
export const RevokeSchema=z.object({consentId:uuid,reason:z.string().min(1).max(500),idempotencyKey:key}).strict();
export const SubmitSchema=z.object({
 schema:z.literal('finnor.x4.identification-request.v1'),root:RootSchema,workId:uuid.optional(),workInputId:uuid.optional(),
 consentId:uuid,sourceTargetId:uuid,replicationTargetId:uuid,
 question:z.object({text:z.string().min(10).max(4000),target:z.string().min(1).max(500),affectedDecision:z.string().min(1).max(2000),
  requestedClaimClass:z.enum(['PREDICTIVE','INTERVENTION_IDENTIFIED','MECHANISM_SPECIFIC'])}).strict(),
 decision:z.object({workstreamId:uuid,investmentCaseId:uuid}).strict(),domain:DomainSchema,
 limits:z.object({deadlineMs:z.number().int().min(1000).max(3600000),maxExperiments:z.number().int().min(1).max(64),
  maxObservationCalls:z.number().int().min(16).max(256),maxAnalysisJobs:z.number().int().min(1).max(64),maxUses:z.number().int().min(1).max(16)}).strict(),
 mode:z.enum(['ACTIVE','OBSERVATION_ONLY']).default('ACTIVE'),idempotencyKey:key,
}).strict();
export const ReadSchema=z.object({identificationId:uuid}).strict();
export const ExperimentReadSchema=ReadSchema.extend({experimentId:uuid}).strict();
export const HistorySchema=ReadSchema.extend({before:z.string().regex(/^\d{1,19}$/).optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const ListSchema=z.object({root:RootSchema,workId:uuid}).strict();
export const TargetSchema=z.object({root:RootSchema}).strict();
export const ReplicateSchema=ReadSchema.extend({expectedModelId:uuid.nullable(),idempotencyKey:key}).strict();
export const UseSchema=ReadSchema.extend({modelId:uuid,idempotencyKey:key}).strict();
export const ControlSchema=ReadSchema.extend({reason:z.string().min(1).max(500),idempotencyKey:key}).strict();
export const InvalidateSchema=ControlSchema.extend({changed:z.array(z.enum(['domain','instrument','observations','hypotheses','replication','rights','work','checker','runtime'])).min(1).max(9)}).strict();
export const AdmissionSchema=ReadSchema.extend({modelId:uuid,idempotencyKey:key}).strict();
export const CurrentSchema=ReadSchema.extend({modelId:uuid,revisionRef:z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:hex}).strict()}).strict();
export const JobSchema=z.discriminatedUnion('stage',[
 z.object({stage:z.literal('DISCOVER'),tenantId:uuid,principalId:uuid,identificationId:uuid,generation:z.number().int().positive()}).strict(),
 z.object({stage:z.literal('REPLICATE'),tenantId:uuid,principalId:uuid,identificationId:uuid,generation:z.number().int().positive(),assignmentId:uuid}).strict(),
 z.object({stage:z.literal('USE'),tenantId:uuid,principalId:uuid,identificationId:uuid,generation:z.number().int().positive(),useId:uuid}).strict(),
]);
export type IdentificationJob=z.infer<typeof JobSchema>;
export type IdentificationRequest=z.infer<typeof SubmitSchema>;
export interface IdentificationRow{
 tenant_id:string;id:string;owner_id:string;root_id:string;work_id:string;work_input_id:string;work_input_digest:string;
 consent_id:string;request:IdentificationRequest;request_digest:string;authority_binding:{id:string;digest:string;revision:number};environment:IdentificationEnvironment;dependencies:import('@finnor/shared-types').EvidenceDependency[];
 target_digests:Record<string,string>;deadline_at:Date;max_experiments:number;max_observations:number;max_analysis:number;max_uses:number;
 experiment_count:number;observation_count:number;analysis_count:number;use_count:number;data_bytes:string;
 status:string;generation:number;head_model_id:string|null;idempotency_key:string;created_at:Date;
}
export interface IdentificationEnvironment{
 schema:'finnor.x4.runtime-cut.v1';files:Array<{path:string;sha256:string}>;sourceDigest:string;checkerDigest:string;
 instrumentDigest:string;lockDigest:string;schemaDigest:string;migrationHead:string;
 node:string;platform:string;architecture:string;runtimeDigest:string;imageDigest:null;
}
export interface ExperimentRow{
 tenant_id:string;id:string;identification_id:string;actor_id:string;phase:DigitalExperimentProtocol['phase'];
 protocol:DigitalExperimentProtocol;protocol_digest:string;status:string;result:DigitalObservation|null;
 evidence_source_id:string|null;evidence_version_id:string|null;evidence_digest:string|null;
 raw:{readbacks:DigitalHttpReceipt[];pages:DigitalHttpReceipt[]}|null;created_at:Date;instrument_id:string;
}
export interface InstrumentRow {tenant_id:string;id:string;identification_id:string;body:DigitalInstrumentCertificate;body_digest:string;evidence_source_id:string;evidence_version_id:string;evidence_digest:string}
export interface FamilyRow {id:string;body:IdentificationFamily;body_digest:string}
export interface ModelRow {tenant_id:string;id:string;identification_id:string;body:IdentifiedSystemRelease;body_digest:string;dependencies:import('@finnor/shared-types').EvidenceDependency[];created_at:Date}
