import {z} from 'zod';
import limits from './profile.json';
import {ProblemSchema,RefSchema,Y3_VERSION,digest,type InteractionProblem,type InteractionCandidate,
 type ConstructionResult,type Check,type RuntimeIdentity,type Y3Ref} from './contracts';
import {RootSchema,QuantityValue} from '../economic-action-theory/contracts';

export const LIMITS=Object.freeze(limits);
export const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
export function reference(owner:string,kind:string,body:unknown):Y3Ref{
 const contentDigest=digest(body);return {owner,id:kind+':'+contentDigest,version:Y3_VERSION,contentDigest};
}
const key=z.string().min(1).max(160),hex=z.string().regex(/^[a-f0-9]{64}$/);
export const SourceSchema=z.object({sourceId:z.string().uuid(),versionId:z.string().uuid(),
 contentDigest:hex,claimKey:key,ref:RefSchema}).strict();
const State=z.record(QuantityValue),terminal={modelId:key,terminalNodeId:key,terminalDigest:hex,before:State,after:State};
export const OutcomeSchema=z.discriminatedUnion('kind',[
 z.object({...terminal,kind:z.literal('NO_EFFECT')}).strict(),
 z.object({...terminal,kind:z.literal('RIGHT_TRANSITION'),operatorId:key,parameters:State}).strict(),
]);
export const LoweringSchema=z.object({schema:z.literal('finnor.y3.fixed-y1-lowering.v1'),theoryId:z.string().uuid(),
 theoryRef:RefSchema,outcomes:z.array(OutcomeSchema).min(1).max(8192)}).strict();
export const SubmitSchema=z.object({schema:z.literal('finnor.interaction-request.v1'),root:RootSchema,
 workId:z.string().uuid(),problem:ProblemSchema,lowering:LoweringSchema,
 sources:z.array(SourceSchema).min(2).max(32),idempotencyKey:z.string().min(1).max(128),
 parentProtocolId:z.string().uuid().optional()}).strict();
export type SubmitRequest=z.infer<typeof SubmitSchema>;
export type Outcome=z.infer<typeof OutcomeSchema>;
export type SourceBinding=z.infer<typeof SourceSchema>;
export const JobSchema=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),protocolId:z.string().uuid(),
 generation:z.number().int().positive()}).strict();
export type InteractionJob=z.infer<typeof JobSchema>;
export interface ProductRuntime {
 math:RuntimeIdentity;semanticDigest:string;ownerSourcePins:Array<{path:string;sha256:string}>;
}
export interface InteractionProtocol {
 schema:'finnor.interaction-protocol.v1';problem:InteractionProblem;body:InteractionCandidate|null;
 construction:ConstructionResult;envelope:{
  schema:'finnor.postx-artifact-envelope.v1';artifactKind:'InteractionProtocol';id:string;tenantId:string;principalId:string;
  contentRef:Y3Ref;parents:Y3Ref[];work:{id:string;inputId:string;inputDigest:string};goal:{id:string;digest:string};
  validityDomain:{profileDigest:string;problemDigest:string;validUntil:string;finiteOnly:true};
  provenance:{producerVersion:typeof Y3_VERSION;runtime:ProductRuntime;executionRuntime:RuntimeIdentity;
   profileFrozenBeforeEvaluation:true;governingOriginalSourceParity:'UNKNOWN'};
  sourceBindings:SourceBinding[];rights:{revision:string;principalId:string};
  dependencies:Array<{id:string;dependsOn:string[];digest:string}>;
  independentChecks:Check[];resourceEnvelope:{episodeId:string;deadlineAt:string;maxAttempts:number;attemptsUsed:number;
   searchStepsOccupied:number;retainedBytes:number};
  admission:{domain:'INTERACTION_PROTOCOL';status:'UNADMITTED';protectedAdmission:false;executionAuthorityGranted:false};
  lowering:{ownerInterfaces:string[];adapter:'S5_RESERVATION_RIGHT_TRANSITION_V1';fixedY1TheoryRef:Y3Ref;externalEffectsSupported:false};
  recovery:{originalEpisodeRetained:true;unknownEffectsRetained:true;replayIdentity:'ORIGINAL_REQUEST_TERMS_AND_NATIVE_EFFECT'};
  comparison:{classification:'CONSTRUCTED_DEVELOPMENT_UNQUALIFIED'|'REUSED';protectedNoveltyEstablished:false;equippedBaseline:'UNESTABLISHED'};
  costs:{wallMs:number;cpuMs:number;peakProcessRssBytes:number;moneyUsd:null;humanSeconds:null;aggregatePeakMemoryBytes:null;
   status:'PARTIALLY_METERED';failedAttemptsRetained:true};
  status:string;qualifications:string[];createdAt:string;
 };
}
export interface ProtocolRow {
 tenant_id:string;id:string;principal_id:string;root:SubmitRequest['root'];work_id:string;work_input_id:string;work_input_digest:string;
 episode_id:string;theory_id:string;request:SubmitRequest;request_digest:string;runtime:ProductRuntime;rights_revision:string;
 status:string;generation:number;candidate:InteractionCandidate|null;construction:ConstructionResult|null;artifact:InteractionProtocol|null;
 admission:Record<string,unknown>|null;fallback_id:string|null;current_terms_id:string|null;cancelled:boolean;created_at:Date;
 deadline_at:Date;attempts_used:number;search_steps_used:number;retained_bytes:number;
}
export const ProtocolId=z.object({protocolId:z.string().uuid()}).strict();
export const RunId=z.object({runId:z.string().uuid()}).strict();
export const TermsSchema=ProtocolId.extend({reservationRef:RefSchema,expectedRevision:z.number().int().positive(),
 idempotencyKey:z.string().min(1).max(128)}).strict();
export const ConsentSchema=ProtocolId.extend({termsRef:RefSchema,scope:z.enum(['TERMS','EFFECT']),subjectDigest:hex,
 decision:z.enum(['ACCEPT','WITHDRAW']),idempotencyKey:z.string().min(1).max(128)}).strict();
export const StartSchema=ProtocolId.extend({termsRef:RefSchema,idempotencyKey:z.string().min(1).max(128)}).strict();
export const ActionSchema=RunId.extend({expectedRevision:z.number().int().positive(),viewDigest:hex,
 actionId:key,idempotencyKey:z.string().min(1).max(128)}).strict();
export const ObserveSchema=RunId.extend({expectedRevision:z.number().int().positive(),date:z.number().int().min(0).max(2),
 key,value:z.string().max(4096),classification:z.enum(['SOURCED_FACT','AUTHENTICATED_ASSERTION','MODEL_RELATIVE_STATEMENT','UNRESOLVED_CLAIM']),
 source:SourceSchema.optional(),idempotencyKey:z.string().min(1).max(128)}).strict();
export const MaterializeSchema=RunId.extend({intentRef:RefSchema,idempotencyKey:z.string().min(1).max(128)}).strict();
export interface InteractionTerms {
 schema:'finnor.s4.interaction-terms.v1';ref:Y3Ref;id:string;protocolId:string;protocolRef:Y3Ref;candidateDigest:string;
 admissionRef:Y3Ref;tenantId:string;principalId:string;workId:string;episodeId:string;revision:number;
 participants:InteractionProblem['participants'];reservationRef:Y3Ref;reservationRevision:number;initialState:Record<string,string>;
 lowering:SubmitRequest['lowering'];modelRefs:Y3Ref[];sourceBindings:SourceBinding[];rightsRevision:string;
 validUntil:string;createdAt:string;externalEffects:false;financialSettlement:false;executionAuthorityGranted:false;
}
export interface InteractionIntent {
 schema:'finnor.s4.interaction-effect-intent.v1';ref:Y3Ref;protocolRef:Y3Ref;termsRef:Y3Ref;runId:string;
 historyDigest:string;reservationRef:Y3Ref;reservationRevision:number;outcome:Outcome;matchingTerminalDigests:string[];
 actualActorActions:Array<{participant:'P0'|'P1';principalId:string;informationKey:string;actionId:string}>;
 validUntil:string;externalEffects:false;executionAuthorityGranted:false;
}
export interface InteractionRun {
 tenant_id:string;id:string;principal_id:string;protocol_id:string;terms_id:string;episode_id:string;
 body:{schema:'finnor.s4.interaction-run.v1';ref:Y3Ref;protocolRef:Y3Ref;termsRef:Y3Ref;id:string;createdAt:string};
 revision:number;status:'ACTIVE'|'READY'|'MATERIALIZED'|'UNKNOWN';intent:InteractionIntent|null;programme_id:string|null;
}
export interface InteractionHistory {
 id:string;event_id:string;principal_id:string;kind:'OBSERVATION'|'ACTION';
 body:{participant:'P0'|'P1';principalId:string;informationKey?:string;actionId?:string;date?:number;key?:string;value?:string;
  classification?:z.infer<typeof ObserveSchema>['classification'];source?:SourceBinding;effective?:boolean;viewDigest?:string};
}
export interface ProgrammeBinding {
 schema:'finnor.s4.interaction-programme-binding.v1';ref:Y3Ref;protocolId:string;protocolRef:Y3Ref;termsRef:Y3Ref;runId:string;
 programmeId:string;programmeRef:Y3Ref;intent:InteractionIntent;termsConsentIds:string[];effectConsentIds:string[];
 originalEpisodeId:string;externalEffects:false;executionAuthorityGranted:false;
}
export const InteractionOperations=[
 'interaction-submit','interaction-read','interaction-list','interaction-admit','interaction-resume','interaction-cancel',
 'interaction-artifact','interaction-compare','interaction-terms','interaction-local','interaction-consent','interaction-start',
 'interaction-run-read','interaction-observe','interaction-action','interaction-materialize','interaction-run','interaction-reconcile',
] as const;
