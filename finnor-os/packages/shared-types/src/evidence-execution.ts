import {z} from 'zod';
import type {BeliefView} from './enterprise-beliefs';
import {PE_WORLD_ROOT_TYPES} from './private-equity';

/** Ordinary P4 producer data. This envelope does not grant authority and does
 * not replace or extend any S1–S8 semantic owner's receipt. */
export interface Phase2Envelope<
 Code={version:'p4-native-v1';digest:string;schemaDigest:string},
 Capability={kind:'BOUNDED_FINANCIAL_DERIVATION';admission:null},
 Domain={entityScope:string[];financialSemantics:'OWNER_RECORDED_AND_EXPLICIT_TABULAR';horizon:'H0';businessTruthCertified:false},
 Status='PROPOSED'|'TESTED'|'PARTIAL'|'INVALIDATED'|'FAILED',
 Admission=null
> {
 tenantId:string; principalId:string; sharing:{scope:'PRINCIPAL';policy:'CURRENT_S1_AUTHORIZATION'};
 rights:{revision:number;ref:string;evaluatedAt:string};
 work:{id:string;revision:string;inputDigest:string}; mandate:null;
 parents:string[];inputsDigest:string;validAt:string;knowledgeAt:string;
 code:Code;capability:Capability;
 runtime:{node:string;imageDigest:null;fabricInvocationId:string|null;workerId:string;jobId:string;deliveryAttemptId:string;claimFence:number;childPid:number|null;leases:unknown[]};
 domain:Domain;
 dependencyRefs:string[];costs:{wallMs:number;cpuMicros:number|null;peakRSSBytes:number|null;inputBytes:number;outputBytes:number;modelCalls:0;usd:null;status:'LOCAL_COST_UNMETERED';attempts:number;nativeInvocations:unknown[];unreconciledAttemptIds:string[]};
 status:Status;admission:Admission;funding:null;
 unavailableBindings:string[];
}
export const EvidenceRootSchema=z.object({entityType:z.enum(PE_WORLD_ROOT_TYPES),entityId:z.string().uuid()}).strict();
const instant=z.string().datetime({offset:true});
export const FinancialSemanticsSchema=z.object({entityType:z.string().max(64),entityId:z.string().uuid(),periodStart:instant,periodEnd:instant,
 unit:z.enum(['currency','count','ratio','multiple','rate']),currencyCode:z.string().regex(/^[A-Z]{3}$/).nullable(),frequency:z.enum(['annual','quarterly','monthly','instant','daily','weekly','event']),
 calendar:z.enum(['OWNER_RECORDED','GREGORIAN']),consolidation:z.enum(['OWNER_SUBJECT_ONLY','CONSOLIDATED','STANDALONE']),instrument:z.string().max(128),scale:z.enum(['1','1000','1000000']),sign:z.enum(['AS_RECORDED','NEGATE'])}).strict();
export type FinancialSemantics=z.infer<typeof FinancialSemanticsSchema>;
export const EvidenceUnderwritingBindingSchema=z.object({derivationId:z.string().uuid(),output:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)}).strict();
export const EvidenceUnderwritingInputsSchema=z.record(z.string().min(1).max(128),EvidenceUnderwritingBindingSchema)
 .refine(bindings=>Object.keys(bindings).length<=16,'At most sixteen exact derived inputs are supported');
export type EvidenceUnderwritingBinding=z.infer<typeof EvidenceUnderwritingBindingSchema>;
const semanticInput=FinancialSemanticsSchema.omit({entityType:true,entityId:true});
const MetricSourceSchema=semanticInput.extend({kind:z.literal('metric'),subject:EvidenceRootSchema,metricKey:z.string().min(1).max(128)}).strict();
const columns=z.object({entityId:z.string().max(32),metricKey:z.string().max(32),value:z.string().max(32),periodStart:z.string().max(32),periodEnd:z.string().max(32),currencyCode:z.string().max(32),frequency:z.string().max(32),unit:z.string().max(32),calendar:z.string().max(32),consolidation:z.string().max(32),instrument:z.string().max(32),scale:z.string().max(32),sign:z.string().max(32)}).strict();
const ArtifactSourceSchema=semanticInput.extend({kind:z.literal('artifact'),subject:EvidenceRootSchema,documentId:z.string().uuid(),documentVersionId:z.string().uuid(),metricKey:z.string().min(1).max(128),
 layout:z.object({format:z.enum(['xlsx','pdf','image']),sheet:z.string().max(128).optional(),headerRow:z.number().int().min(1).max(100).default(1),columns:columns.optional(),delimiter:z.literal('|').optional()}).strict()}).strict();
const DerivationSourceSchema=z.object({kind:z.literal('derivation'),derivationId:z.string().uuid(),output:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)}).strict();
const ModelSourceSchema=z.object({kind:z.literal('model'),subject:EvidenceRootSchema,modelVersionId:z.string().uuid(),runId:z.string().uuid(),output:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)}).strict();
export const EvidenceSourceSchema=z.discriminatedUnion('kind',[MetricSourceSchema,ArtifactSourceSchema,DerivationSourceSchema,ModelSourceSchema]);
export type EvidenceSource=z.infer<typeof EvidenceSourceSchema>;
const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const field=z.enum(['entityId','entityType','metricKey','periodStart','periodEnd','frequency','unit','currencyCode','calendar','consolidation','instrument','value','recordId']);
const sourceNode=z.object({id,op:z.literal('source'),inputId:id}).strict();
const uniqueNode=z.object({id,op:z.literal('unique'),input:id}).strict();
const reconcileNode=z.object({id,op:z.literal('reconcile'),input:id}).strict();
const filterNode=z.object({id,op:z.literal('filter'),input:id,field,predicate:z.enum(['eq','neq','lt','lte','gt','gte']),value:z.string().max(128)}).strict();
const projectNode=z.object({id,op:z.literal('project'),input:id,fields:z.array(field).min(1).max(14)}).strict();
const joinNode=z.object({id,op:z.literal('join'),left:id,right:id,on:z.array(field).min(1).max(8)}).strict();
const aggregateNode=z.object({id,op:z.literal('aggregate'),input:id,groupBy:z.array(field).max(8).default([]),method:z.enum(['sum','count','min','max'])}).strict();
const arithmetic=(op:'add'|'subtract'|'multiply'|'ratio'|'growth')=>z.object({id,op:z.literal(op),left:id,right:id,decimalPlaces:z.number().int().min(0).max(34).default(18)}).strict();
export const DerivationNodeSchema=z.discriminatedUnion('op',[sourceNode,uniqueNode,reconcileNode,filterNode,projectNode,joinNode,aggregateNode,arithmetic('add'),arithmetic('subtract'),arithmetic('multiply'),arithmetic('ratio'),arithmetic('growth')]);
export const DerivationProgramSchema=z.object({schema:z.literal('finnor.derivation-ir.v1'),nodes:z.array(DerivationNodeSchema).min(1).max(64),outputs:z.array(id).min(1).max(16)}).strict();
export type DerivationProgram=z.infer<typeof DerivationProgramSchema>;
export const EvidenceHandlesRequestSchema=z.object({root:EvidenceRootSchema,validAt:instant.optional(),knowledgeAt:instant.optional(),inputs:z.array(z.object({inputId:id,source:EvidenceSourceSchema}).strict()).max(16)}).strict();
export const EvidenceRequestSchema=z.object({schema:z.literal('finnor.evidence-request.v1'),question:z.string().min(1).max(4000),root:EvidenceRootSchema,workId:z.string().uuid().optional(),validAt:instant.optional(),knowledgeAt:instant.optional(),
 idempotencyKey:z.string().min(1).max(200),mode:z.enum(['ordinary_disposable','protected']),inputs:z.array(z.object({inputId:id,handleId:z.string().uuid()}).strict()).min(1).max(16),program:DerivationProgramSchema,
 acceptance:z.object({selectedUniverse:z.literal('COMPLETE'),absoluteTolerance:z.literal('0'),materialOutputs:z.array(id).min(1).max(16)}).strict(),
 limits:z.object({maxRows:z.number().int().min(1).max(1000).default(1000),maxBytes:z.number().int().min(1024).max(8388608).default(8388608),deadlineMs:z.number().int().min(25).max(30000).default(30000)}).strict().optional()}).strict();
export type EvidenceRequest=z.infer<typeof EvidenceRequestSchema>;
export interface EvidenceDependency {key:string;revision:number;nodeIds:string[];digest:string|null}
export interface EvidenceWitness {id:string;sourceKind:'canonical'|'xlsx'|'pdf'|'image'|'derivation'|'model';owner:string;recordId:string;version:string;contentDigest:string;field:string;rawValue:string;anchor:{sheet?:string;cell?:string;page?:number;quote?:string;region?:number[]};semantics:FinancialSemantics;modulePath:string[];uncertainty:string[]}
export interface FinancialRow {recordId:string;metricKey:string;value:string;semantics:FinancialSemantics;witnessIds:string[];fields:Record<string,string|null>}
export interface EvidenceValue {kind:'scalar'|'table';value:string|null;rows?:FinancialRow[];semantics:FinancialSemantics|null;truthClass:'DERIVED_VALUE';witnessIds:string[];qualification:string[]}
export interface IndependentCheck {id:string;method:'POSTGRES_NUMERIC'|'SQL_SOURCE_COUNT'|'SEMANTIC_EDGE'|'COVERAGE';status:'PASS'|'FAIL';expected:string|null;actual:string|null;predicate:string;witnessIds:string[]}
export interface EvidenceHandle {id:string;inputId:string;tenantId:string;principalId:string;root:z.infer<typeof EvidenceRootSchema>;source:EvidenceSource;rightsRevision:number;validAt:string;knowledgeAt:string;expiresAt:string;digest:string;dependencies:EvidenceDependency[];coverage:{status:'COMPLETE'|'PARTIAL';rowCount:number;reasons:string[]};schema:'finnor.evidence-handle.v1';acquisitionInvocations:unknown[]}
export interface EvidenceDerivation extends Phase2Envelope {schema:'finnor.evidence-derivation.v1';id:string;queryId:string;generation:number;beliefView:BeliefView;queryProgram:DerivationProgram;sourceHandles:EvidenceHandle[];
 recomputation:{mode:'INCREMENTAL'|'FULL';nodes:Array<{id:string;cacheKey:string;state:'KEPT'|'COMPUTED';originDerivationId:string|null;originNodeId:string|null;oldDigest:string|null;newDigest:string;validityReason:string}>};
 result:{outputs:Record<string,EvidenceValue>;digest:string}|null;witnesses:EvidenceWitness[];coverage:{status:'COMPLETE_SELECTED_UNIVERSE'|'PARTIAL';globalAbsenceClaimsPermitted:false;reasons:string[]};contradictions:unknown[];invalidationKeys:EvidenceDependency[];independentChecks:IndependentCheck[];failure:{predicate:string;detail:string}|null}
