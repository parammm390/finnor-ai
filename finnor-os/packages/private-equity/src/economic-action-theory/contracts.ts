import {createHash} from 'node:crypto';
import {z} from 'zod';
import profile from './profile.json';
import {PE_WORLD_ROOT_TYPES} from '../../../shared-types/src/private-equity';

export const Y1_VERSION='economic-action-theory-v1' as const;
export const PROFILE=Object.freeze(profile);
export function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const byteDigest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const PROFILE_DIGEST=digest(PROFILE);
export class EconomicFault extends Error {
 constructor(readonly code:string,readonly status=422){super(code);}
}
export function fail(code:string,status=422):never {throw new EconomicFault(code,status);}
/** Read deployment state at runtime. Next replaces literal NODE_ENV accesses
 * during emission, even when the installed API runs in a disposable harness. */
export function ordinaryDisposableEconomicRuntime(){
 const convergedStaging=process.env.FINNOR_ENVIRONMENT==='staging'&&
  process.env.FINNOR_Z2_CONVERGED_DEVELOPMENT==='1'&&process.env.FINNOR_Y3_PROFILE==='ordinary_disposable';
 return process.env.FINNOR_Y1_PROFILE==='ordinary_disposable'&&
  (process.env.FINNOR_ENVIRONMENT==='ordinary_disposable'||convergedStaging)&&
  Reflect.get(process.env,'NODE_ENV')!=='production'&&process.env.VERCEL_ENV!=='production';
}
const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),hex=z.string().regex(/^[a-f0-9]{64}$/);
export const QuantityValue=z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{0,5}[1-9])?$/).refine(v=>v!=='-0');
export const RefSchema=z.object({owner:z.string().min(1).max(64),id:z.string().min(1).max(256),version:z.string().min(1).max(64),contentDigest:hex}).strict();
export type EconomicRef=z.infer<typeof RefSchema>;
export function reference(owner:string,kind:string,body:unknown):EconomicRef {
 const hash=digest(body);return {owner,id:kind+':'+hash,version:Y1_VERSION,contentDigest:hash};
}
export const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
export const RootSchema=z.object({entityType:z.enum(PE_WORLD_ROOT_TYPES),entityId:z.string().uuid()}).strict();
const Period=z.object({startAt:z.string().datetime({offset:true}),endAt:z.string().datetime({offset:true})}).strict()
 .refine(p=>Date.parse(p.endAt)>Date.parse(p.startAt),'Exact nonempty accounting interval required');
const Quantity=z.object({id,unit:z.string().min(1).max(64),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 entityId:z.string().uuid(),accountingBasis:z.string().min(1).max(128),period:Period,meaningKey:id,
 values:z.array(QuantityValue).min(1).max(PROFILE.maxValuesPerQuantity)}).strict();
const Meaning=z.object({key:id,kind:z.enum(['INTERPRETATION','CONSENT','OBSERVATION']),
 subjectId:z.string().uuid(),sourceId:z.string().uuid().nullable(),versionId:z.string().uuid().nullable(),
 contentDigest:hex.nullable()}).strict();
const Requirement=z.object({key:id,kind:z.enum(['AUTHORITY','CONSENT','INTERPRETATION','OBSERVATION']),subjectId:z.string().uuid()}).strict();
const State=z.record(z.string(), QuantityValue);
export const ProblemSchema=z.object({schema:z.literal('finnor.economic-construction-problem.v1'),
 goal:z.object({id,title:z.string().min(1).max(512)}).strict(),
 quantities:z.array(Quantity).min(1).max(PROFILE.maxQuantities),
 parameters:z.array(Quantity).max(PROFILE.maxParameters),meanings:z.array(Meaning).max(64),
 invariants:z.array(z.object({id,terms:z.array(z.object({quantityId:id,coefficient:z.union([z.literal(-1),z.literal(1)])}).strict()).min(1).max(6),
  relation:z.enum(['EQ','LE']),constant:QuantityValue,meaningKey:id}).strict()).max(32),
 operators:z.array(z.object({id,title:z.string().min(1).max(256),
  examples:z.array(z.object({before:State,parameters:State,after:State.nullable()}).strict()).min(1).max(PROFILE.maxExamplesPerOperator),
  requirements:z.array(Requirement).max(32)}).strict()).min(1).max(PROFILE.maxOperators)}).strict();
export type EconomicProblem=z.infer<typeof ProblemSchema>;
export type Quantity=z.infer<typeof Quantity>;
export type State=Record<string,string>;
export type Requirement=z.infer<typeof Requirement>;
export type ConstructionStatus='CANDIDATE'|'CHECKED'|'INCOMPLETE'|'INFEASIBLE'|'UNIDENTIFIED'|'UNSUPPORTED'|'UNKNOWN';
export interface Term {input:'STATE'|'PARAM'|'ONE';id:string;coefficient:-1|1}
export interface SemanticRow {output:string;terms:Term[]}
export interface EconomicOperator {
 id:string;rows:SemanticRow[];guard:{kind:'MAXIMAL_FINITE_SAFE_PREIMAGE';invariantDigest:string};
 requirements:Requirement[];reads:string[];writes:string[];
}
export interface CompositionLaw {
 left:string[];right:string[];denotationDigest:string;enabledWitnesses:number;
 witness:{before:State;parameters:State;after:State};
}
export interface EconomicTheoryBody {
 schema:'finnor.economic-action-theory-body.v1';problemDigest:string;profileDigest:string;
 operators:EconomicOperator[];laws:CompositionLaw[];
}
export interface ConstructionResult {
 status:ConstructionStatus;candidate:EconomicTheoryBody|null;reasons:string[];
 searchSteps:number;semanticApplications:number;bodyCombinations:number;
 distinguishingTrace?:{operatorId:string;before:State;parameters:State;alternatives:Array<State|null>};
 exhaustiveWithinFrozenHypothesis:boolean;
}
export interface IndependentCheck {
 schema:'finnor.economic-theory-check.v1';status:'CHECKED'|'INFEASIBLE'|'INCOMPLETE'|'REJECTED'|'UNKNOWN';
 problemDigest?:string;candidateDigest?:string;profileDigest?:string;checkerDigest?:string;
 searchSteps?:number;semanticApplications?:number;operatorCount?:number;lawCount?:number;
 stateCount?:number;parameterCount?:number;traceCount?:number;nonVacuous?:boolean;
 exhaustiveWithinFrozenHypothesis?:boolean;reason?:string;wallMs?:number;cpuMs?:number;peakRssBytes?:number;
 executionAuthorityGranted:false;protectedQualification?:false;
 interpreterVersion?:string;interpreterExecutableDigest?:string;interpreterPath?:string;
}
export interface RuntimeIdentity {
 node:string;platform:string;architecture:string;profileDigest:string;checkerDigest:string;
 checkerInterpreter:{path:string;sha256:string|null};
 semanticCodeDigest:string;entrypointDigest:string|null;sourcePins:Array<{path:string;sha256:string}>;
}
export interface PostXArtifactEnvelope {
 schema:'finnor.postx-artifact-envelope.v1';artifactKind:'EconomicActionTheory';id:string;
 tenantId:string;principalId:string;contentRef:EconomicRef;parents:EconomicRef[];
 work:{id:string;inputId:string;inputDigest:string};goal:{id:string;digest:string};
 sourceBindings:EconomicProblem['meanings'];rights:{revision:string;principalId:string};
 validityDomain:{profileId:string;profileDigest:string;problemDigest:string;finiteOnly:true;validUntil:string};
 provenance:{producerVersion:typeof Y1_VERSION;runtime:RuntimeIdentity;checkerDigest:string;profileFrozenBeforeEvaluation:true};
 dependencies:Array<{id:string;dependsOn:string[];digest:string}>;
 resourceEnvelope:{episodeId:string;maxAttempts:number;deadlineAt:string;maxSearchSteps:number;maxSemanticApplications:number;
  attemptsUsed:number;searchStepsUsed:number;semanticApplicationsUsed:number;retainedBytes:number};
 independentChecks:IndependentCheck[];
 admission:{domain:'ECONOMIC_ACTION_THEORY';status:'UNADMITTED'|'ADMITTED_DEVELOPMENT'|'REVOKED';ref:EconomicRef|null;
  protectedAdmission:false;executionAuthorityGranted:false};
 lowering:{owningInterfaces:['P1','S4','S5','S6','S7'];adapter:'S5_RESERVATION_RIGHT_TRANSITION_V1';externalEffectsSupported:false};
 recovery:{originalEpisodeRetained:true;unknownEffectsRetained:true;replayIdentity:'ORIGINAL_REQUEST_AND_OWNER_KEYS'};
 uncertainty:{missingMeaningKeys:string[];externalSettlement:'UNESTABLISHED';financialEfficacy:'UNESTABLISHED'};
 comparison:{classification:'CONSTRUCTED_DEVELOPMENT_UNQUALIFIED'|'REUSED';protectedNoveltyEstablished:false;baselineQualification:'UNESTABLISHED'};
 costs:{wallMs:number;cpuMs:number;peakRssBytes:number;moneyUsd:null;humanSeconds:null;aggregatePeakMemoryBytes:null;
  status:'PARTIALLY_METERED';attemptsRetained:true};
 status:ConstructionStatus;qualifications:string[];createdAt:string;
}
export interface EconomicActionTheory {
 schema:'finnor.economic-action-theory.v1';envelope:PostXArtifactEnvelope;problem:EconomicProblem;
 body:EconomicTheoryBody|null;construction:ConstructionResult;
}
export const SubmitSchema=z.object({schema:z.literal('finnor.economic-theory-request.v1'),root:RootSchema,workId:z.string().uuid(),
 problem:ProblemSchema,idempotencyKey:z.string().min(1).max(128),parentTheoryId:z.string().uuid().optional()}).strict();
export type SubmitRequest=z.infer<typeof SubmitSchema>;
export const JobSchema=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),theoryId:z.string().uuid(),
 generation:z.number().int().positive()}).strict();
export type EconomicJob=z.infer<typeof JobSchema>;
export interface TheoryRow {
 tenant_id:string;id:string;principal_id:string;root:SubmitRequest['root'];work_id:string;work_input_id:string;work_input_digest:string;
 episode_id:string;request:SubmitRequest;request_digest:string;runtime:RuntimeIdentity;rights_revision:string;
 status:string;generation:number;candidate:EconomicTheoryBody|null;construction:ConstructionResult|null;artifact:EconomicActionTheory|null;
 admission:Record<string,unknown>|null;created_at:Date;deadline_at:Date;attempts_used:number;search_steps_used:number;
 semantic_applications_used:number;retained_bytes:number;fallback_id:string|null;cancelled:boolean;
}
