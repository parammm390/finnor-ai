import { z } from 'zod';
import {ProcedureUseSchema} from '../procedure-induction/use-contracts';
import { EvidenceRootSchema, EvidenceSourceSchema, FinancialSemanticsSchema, type EvidenceDependency, type EvidenceWitness, type FinancialSemantics } from '@finnor/shared-types';
import type { GoalSpec, PlanGraph } from '@finnor/planning';

export const P1_VERSION = 'p1-bounded-native-v1';
export const OPERATIONS = ['derive','propose_model','design_inquiry','search','simulate','solve','compose_artifact','await_observation','propose_effect','stop'] as const;
export const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const uuid = z.string().uuid(), instant = z.string().datetime({offset:true});
const unit = FinancialSemanticsSchema.shape.unit;
export type Comparison='lt'|'lte'|'eq'|'gte'|'gt';
export interface ExpressionCondition {comparison:Comparison;left:Expression;right:Expression}
export interface Expression { kind:'input'|'literal'|'add'|'subtract'|'multiply'|'ratio'|'min'|'max'|'if';condition?:ExpressionCondition;whenTrue?:Expression;whenFalse?:Expression; key?:string; value?:string; unit?:FinancialSemantics['unit']; currencyCode?:string|null; left?:Expression; right?:Expression }
export const ExpressionSchema:z.ZodType<Expression> = z.lazy(()=>z.union([
  z.object({kind:z.literal('input'),key}).strict(),
  z.object({kind:z.literal('literal'),value:z.string().regex(/^[+-]?\d+(?:\.\d+)?$/).max(96),unit,currencyCode:z.string().regex(/^[A-Z]{3}$/).nullable()}).strict(),
  z.object({kind:z.enum(['add','subtract','multiply','ratio','min','max']),left:ExpressionSchema,right:ExpressionSchema}).strict(),
  z.object({kind:z.literal('if'),condition:z.object({comparison:z.enum(['lt','lte','eq','gte','gt']),left:ExpressionSchema,right:ExpressionSchema}).strict(),whenTrue:ExpressionSchema,whenFalse:ExpressionSchema}).strict(),
]));
const ownerRef=z.object({owner:z.string().min(1).max(128),id:z.string().min(1).max(512),version:z.string().min(1).max(128),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const jsonObject=z.record(z.unknown());
const correlation=z.object({eventType:z.string().min(1).max(200),resource:z.object({type:z.string().min(1).max(128),id:uuid}).strict(),correlationId:z.string().min(1).max(128),provider:z.string().max(128).optional()}).strict();
export const OwnerOperationSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('propose_model'),key,assumptions:z.array(z.string().min(1).max(1000)).min(1).max(16),units:z.array(z.string().min(1).max(128)).min(1).max(16),mechanism:z.string().min(1).max(4000)}).strict(),
 z.object({op:z.literal('design_inquiry'),key,request:jsonObject}).strict(),
 z.object({op:z.literal('simulate'),key,modelRef:ownerRef,query:jsonObject}).strict(),
 z.object({op:z.literal('await_observation'),key,objectiveLoopId:uuid.optional(),objectiveStepId:uuid.optional(),waitFor:correlation,earliestAt:instant,deadlineAt:instant}).strict(),
 z.object({op:z.literal('propose_effect'),key,target:z.object({account:z.string().min(1).max(128),recordId:z.string().min(1).max(128),field:z.string().min(1).max(128),version:z.string().min(1).max(128)}).strict(),operation:z.enum(['set','clear']),value:z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()]),unit:z.string().min(1).max(128),idempotencyKey:z.string().min(1).max(200),policyRef:ownerRef.nullable(),reservationRef:ownerRef.nullable(),observation:z.object({resourceId:uuid,eventType:z.string().min(1).max(200),correlationId:z.string().min(1).max(128)}).strict()}).strict(),
 z.object({op:z.literal('stop'),key,reason:z.string().min(1).max(1000),remainingPredicates:z.array(key).max(32)}).strict(),
]);
export const HarnessRequestSchema=z.object({schema:z.literal('finnor.harness-request.v1'),instruction:z.string().min(1).max(4000),root:EvidenceRootSchema,
 threadId:uuid.optional(),workId:uuid.optional(),workInputId:uuid.optional(),parentProgramId:uuid.optional(),idempotencyKey:z.string().min(1).max(160),validAt:instant,knowledgeAt:instant.optional(),mode:z.enum(['ordinary_disposable','protected']),
 sources:z.array(z.object({key,source:EvidenceSourceSchema}).strict()).min(1).max(16),
 acceptance:z.object({requiredSourceKeys:z.array(key).min(1).max(16),targets:z.array(z.object({key,expression:ExpressionSchema,unit,currencyCode:z.string().regex(/^[A-Z]{3}$/).nullable()}).strict()).min(1).max(16),deliverable:z.object({kind:z.literal('analytical_draft'),title:z.string().min(1).max(300)}).strict()}).strict(),
 operations:z.array(OwnerOperationSchema).max(12).optional(),ownerBindings:z.object({policyRef:ownerRef.optional(),allocationRef:ownerRef.optional(),decisionSliceRef:ownerRef.optional()}).strict().optional(),
 procedure:ProcedureUseSchema.optional(),
 computeSearch:z.literal('P2_REQUIRED').optional(),
 proposalSource:z.enum(['REGISTERED_NATIVE','GOVERNED_MODEL']).default('REGISTERED_NATIVE'),
 limits:z.object({maxSteps:z.number().int().min(8).max(4096).default(1024),maxDepth:z.number().int().min(1).max(12).default(12),maxAttempts:z.number().int().min(1).max(8).default(4),maxCandidates:z.number().int().min(2).max(8).default(8),deadlineMs:z.number().int().min(1000).max(3600000).default(300000),requiredAggregateLimits:z.record(z.number().positive()).optional()}).strict().optional(),
}).strict();
export type HarnessRequest=z.infer<typeof HarnessRequestSchema>;
export type OwnerOperation=z.infer<typeof OwnerOperationSchema>;
export type Instruction={op:'input';key:string}|{op:'literal';value:string}|{op:'add'|'subtract'|'multiply'|'ratio'|'min'|'max'}|{op:'branch';comparison:Comparison;left:Instruction[];right:Instruction[];whenTrue:Instruction[];whenFalse:Instruction[]};
export interface TypeScriptModule {source:string;sourceDigest:string;emitted:string;emittedDigest:string;irDigest:string;compiler:{name:'typescript';version:string;optionsDigest:string;libraries:Array<{file:string;sha256:string}>;librariesDigest:string};diagnostics:Array<{code:number;category:string;file:string|null;start:number|null;message:string}>}
export interface NativeModule {typescript:TypeScriptModule;schema:'finnor.harness-module.v1';id:string;sourceDigest:string;compiledDigest:string;structureDigest:string;source:string;compiled:string;format:'BOUNDED_SSA'|'BOUNDED_STACK';entrypoint:'compute';inputKeys:string[];outputs:Array<{key:string;unit:string;currencyCode:string|null}>;bounds:{steps:number;depth:number;bytes:number};runtime:{kind:'REGISTERED_NATIVE_IR';version:typeof P1_VERSION;closureDigest:string};checks:string[];admission:null}
export interface HarnessNode {id:string;op:typeof OPERATIONS[number];dependsOn:string[];inputPorts:string[];outputPorts:string[];semanticDigest:string;owner:string;capabilityVersion:string;truthClass:string;preconditions:string[];postconditions:string[];deadlineAt:string;maxAttempts:1;failure:'STOP_WITH_PREDICATE';cancellation:'FENCE_BEFORE_PUBLICATION';payload:unknown}
export interface HarnessValue {value:string;semantics:FinancialSemantics;truthClass:'DERIVED_VALUE';witnessIds:string[]}
export interface HarnessProgram {
 schema:'finnor.harness-program.v1';id:string;tenantId:string;principalId:string;sharing:{scope:'PRINCIPAL';policy:'CURRENT_S1_AUTHORIZATION'};
 work:{id:string;revision:string;inputDigest:string;planRevisionId:string};parents:string[];acceptance:HarnessRequest['acceptance'];acceptanceDigest:string;goal:GoalSpec;
 rights:{revision:number;ref:string;evaluatedAt:string};validAt:string;knowledgeAt:string;producer:{version:typeof P1_VERSION;codeDigest:string;schemaDigest:string};
 graph:HarnessNode[];planGraph:PlanGraph;modules:NativeModule[];candidates:Array<{id:string;moduleId:string;structureDigest:string;status:'PROPOSED'|'CHECKED'|'REJECTED';counterexamples:unknown[]}>;
 semanticBindings:unknown[];observableBranches:unknown[];effectProposals:unknown[];dependencies:EvidenceDependency[];witnesses:EvidenceWitness[];
 bounds:{episodeId:string;maxSteps:number;maxDepth:number;maxAttempts:number;maxCandidates:number;deadlineAt:string;reservation:null};fallback:{status:'UNAVAILABLE';predicate:string};
 result:{values:Record<string,HarnessValue>;digest:string;artifact:{documentId:string;versionId:string;sha256:string;semanticHash:string}}|null;
 independentChecks:unknown[];costs:{usd:null;status:'UNMETERED';attempts:number;steps:number;wallMs:number;modelInvocations:unknown[];nativeInvocations:unknown[]};runtime:{node:string;imageDigest:null;jobId:string|null;workerId:string|null;deliveryAttemptId:string|null;claimFence:number|null};
 status:'PROPOSED'|'TESTED'|'PARTIAL'|'FAILED'|'INVALIDATED';admission:null;funding:null;unavailableBindings:string[];projection:{kind:'program_synthesis';workId:string;inspect:'program-read';run:'program-resume';download:'program-artifact'};
}

/** Bound shape before recursive schema decoding; even invalid input cannot exhaust the host stack. */
export function parseHarnessRequest(value:unknown):HarnessRequest {
 if(Buffer.byteLength(JSON.stringify(value)??'')>65536)throw Error('PROGRAM_REQUEST_BYTE_BOUND');
 let count=0;const todo:Array<[unknown,number]>=[[value,0]];
 while(todo.length){const [v,d]=todo.pop()!;if(++count>4096||d>32)throw Error('PROGRAM_DECODE_BOUND');if(v&&typeof v==='object')for(const child of Object.values(v))todo.push([child,d+1]);}
 return HarnessRequestSchema.parse(value);
}
