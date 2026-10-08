import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EvidenceRootSchema,type Phase2Envelope} from '@finnor/shared-types';
export const P5_VERSION='p5-interface-ir-v1' as const;
export const instant=z.string().datetime({offset:true}),hex=z.string().regex(/^[a-f0-9]{64}$/);
export const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const fieldName=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(k=>!['constructor','prototype','__proto__'].includes(k));
export const OperationSchema=z.object({meaning:z.literal('set-record-field'),account:identifier,entity:identifier,field:fieldName,
 unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),value:z.string().max(96).nullable(),tolerance:z.literal('0'),
 priorRevision:z.string().regex(/^"[^"\\\r\n]{1,120}"$/),operationId:identifier}).strict();
export type Operation=z.infer<typeof OperationSchema>;
export function canonical(v:unknown):string{
 if(v===null||typeof v!=='object')return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 return '{'+Object.entries(v).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>JSON.stringify(k)+':'+canonical(value)).join(',')+'}';
}
export const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
export function fail(code:string):never{throw Error(code);}
export function bounded(v:unknown,maxBytes=65536){
 const text=JSON.stringify(v);
 if(!text||Buffer.byteLength(text)>maxBytes)fail('P5_INPUT_BYTES');
 let nodes=0;const stack:Array<[unknown,number]>=[[v,0]];
 while(stack.length){
  const [value,depth]=stack.pop()!;
  if(++nodes>8192||depth>24)fail('P5_INPUT_DEPTH');
  if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){
   if(['__proto__','prototype','constructor'].includes(key))fail('P5_UNSAFE_KEY');
   if(/^(?:authorization|cookie|password|secret|accessToken|refreshToken|connectionString)$/i.test(key))fail('P5_SECRET_INPUT_FORBIDDEN');
   stack.push([child,depth+1]);
  }
 }
}
export function parseOperation(v:unknown):Operation{
 bounded(v,4096);
 const parsed=OperationSchema.safeParse(v);
 if(!parsed.success)fail('P5_OPERATION_DOMAIN_UNSUPPORTED');
 return parsed.data;
}
const path=z.string().regex(/^\/[A-Za-z0-9_/{\}.-]{1,511}$/).refine(v=>!v.includes('..')&&!v.startsWith('//'));
const mapping=z.object({account:fieldName,entity:fieldName,value:fieldName,revision:fieldName,operationId:fieldName,unit:fieldName,currency:fieldName}).strict();
export const HttpModuleSchema=z.object({schema:z.literal('finnor.p5.http-module.v1'),kind:z.enum(['ADAPTER','OBSERVER']),method:z.enum(['PATCH','GET']),
 path,parameters:z.object({account:fieldName,entity:fieldName}).strict(),
 valueField:fieldName,readFields:mapping,meaning:z.literal('set-record-field'),field:fieldName,unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),
 encoding:z.enum(['minor_integer','major_decimal_string']),decimalPlaces:z.number().int().min(0).max(6),nullable:z.boolean(),
 revisionHeader:z.literal('If-Match'),operationHeader:z.literal('X-Operation-Id'),
 history:z.object({path,accountParameter:fieldName,operationParameter:fieldName}).strict().nullable(),
 imports:z.tuple([]),entrypoint:z.literal('bind'),runtime:z.literal('S6_LOCAL_SEATBELT_PURE_IR'),
 maxResponseBytes:z.literal(65536),maxWallMs:z.literal(3000)}).strict();
export type HttpModule=z.infer<typeof HttpModuleSchema>;
export const UiModuleSchema=z.object({schema:z.literal('finnor.p5.ui-module.v1'),kind:z.literal('ADAPTER'),entrypoint:z.literal('interact'),
 formAttributes:z.tuple([z.literal('data-account'),z.literal('data-entity')]),fieldAttribute:z.literal('data-field'),
 controlName:fieldName,operationName:fieldName,explicitNull:z.boolean(),boundary:z.enum(['submit','autosave']),
 decimalPlaces:z.number().int().min(0).max(6),field:fieldName,unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),
 imports:z.tuple([]),runtime:z.literal('ORDINARY_DISPOSABLE_BROWSER'),maxActions:z.literal(6)}).strict();
export type UiModule=z.infer<typeof UiModuleSchema>;
export const ExecutableModuleSchema=z.object({format:z.enum(['BOUNDED_HTTP_IR','BOUNDED_UI_IR']),entrypoint:z.enum(['bind','interact']),bytes:z.string().min(1).max(8192),digest:hex}).strict();
export type ExecutableModule=z.infer<typeof ExecutableModuleSchema>;
export interface GeneratedInterface {
 schema:'finnor.p5.generated-interface.v1';substrate:'API'|'UI';sourceDigest:string;bindingDigest:string;semanticDigest:string;
 adapterModule:ExecutableModule;observerModule:ExecutableModule;interfaceVersion:string;qualification:string;
}
export const GeneratedInterfaceSchema=z.object({schema:z.literal('finnor.p5.generated-interface.v1'),substrate:z.enum(['API','UI']),sourceDigest:hex,bindingDigest:hex,semanticDigest:hex,
 adapterModule:ExecutableModuleSchema,observerModule:ExecutableModuleSchema,interfaceVersion:z.string().min(1).max(128),qualification:z.string().min(1).max(256)}).strict();
export function moduleFor(ir:HttpModule|UiModule):ExecutableModule{
 const parsed=ir.schema==='finnor.p5.http-module.v1'?HttpModuleSchema.parse(ir):UiModuleSchema.parse(ir),bytes=canonical(parsed);
 return {format:ir.schema==='finnor.p5.http-module.v1'?'BOUNDED_HTTP_IR':'BOUNDED_UI_IR',entrypoint:parsed.entrypoint,bytes,digest:hash(bytes)};
}
export function readModule(module:ExecutableModule):HttpModule|UiModule{
 if(!module||typeof module.bytes!=='string'||Buffer.byteLength(module.bytes)>8192||hash(module.bytes)!==module.digest)fail('P5_MODULE_INTEGRITY');
 let input:unknown;try{input=JSON.parse(module.bytes);}catch{fail('P5_MODULE_JSON');}
 const schema=module.format==='BOUNDED_HTTP_IR'?HttpModuleSchema:module.format==='BOUNDED_UI_IR'?UiModuleSchema:null;
 if(!schema)fail('P5_MODULE_FORMAT');
 const parsed=schema.safeParse(input);if(!parsed.success||module.entrypoint!==parsed.data.entrypoint||canonical(parsed.data)!==module.bytes)fail('P5_MODULE_CONTRACT');
 if(parsed.data.schema==='finnor.p5.http-module.v1'&&((parsed.data.kind==='ADAPTER')!==(parsed.data.method==='PATCH')))fail('P5_MODULE_OPERATION');
 return parsed.data;
}
export const RefSchema=z.object({owner:z.enum(['P5','S8']),id:z.string().min(1).max(256),version:z.string().min(1).max(128),contentDigest:hex}).strict();
export type InterfaceRef=z.infer<typeof RefSchema>;
export const reference=(name:string,body:unknown):InterfaceRef=>({owner:'P5',id:name+':'+hash(body),version:P5_VERSION,contentDigest:hash(body)});
export type CapabilityStatus='PROTOTYPE'|'PRACTICED'|'SUPPORTED_DISPOSABLE'|'UNKNOWN'|'DISCREPANCY'|'QUARANTINED'|'FAILED';
export interface InterfaceCapability extends Phase2Envelope<
 {version:typeof P5_VERSION;digest:string;schemaDigest:string},
 {kind:'BOUNDED_INTERFACE_CAPABILITY';admission:InterfaceRef|null},
 {entityScope:string[];interface:'p5-disposable-interface-v1';horizon:'H0';businessTruthCertified:false},
 CapabilityStatus,InterfaceRef|null
> {
 schema:'finnor.interface-capability.v1';id:string;operation:InterfaceRef;schemaOrUiVersion:InterfaceRef;adapterModule:InterfaceRef;requestBinding:InterfaceRef;
 observerModule:InterfaceRef;postcondition:InterfaceRef;retryAndUnknown:InterfaceRef;credentialClass:InterfaceRef;
 components:Record<'operation'|'schemaOrUiVersion'|'adapterModule'|'requestBinding'|'observerModule'|'postcondition'|'retryAndUnknown'|'credentialClass',unknown>;
 generated:GeneratedInterface;practice:PracticeResult|null;s8CandidateRef:InterfaceRef|null;
}
export interface Attempt {
 schema:'finnor.p5.attempt.v1';id:string;operationId:string;bindingDigest:string;sourceDigest:string;adapterDigest:string;observerDigest:string;
 possibleEgress:boolean;acknowledged:boolean;startedAt:string;
}
export interface Observation {
 account:string;entity:string;field:string;unit:string;currency:string;value:unknown;revision:string;operationId:string|null;observedAt:string;rawDigest:string;
}
export interface PracticeResult {
 status:'VERIFIED'|'DISCREPANCY'|'UNKNOWN';attempt:Attempt;observation:Observation|null;historyDigest:string|null;
 reason:string|null;admission:null;runtimeReceipts:unknown[];cost:{usd:null;status:'LOCAL_COST_UNMETERED';wallMs:number};
}
export const AcquisitionRequestSchema=z.object({schema:z.literal('finnor.p5.acquisition-request.v1'),root:EvidenceRootSchema,workId:z.string().uuid(),sourceAccessId:z.string().uuid(),
 substrate:z.enum(['API','UI']),operation:OperationSchema,idempotencyKey:z.string().min(1).max(160),mode:z.literal('ordinary_disposable'),
 programId:z.string().uuid().optional()}).strict();
export type AcquisitionRequest=z.infer<typeof AcquisitionRequestSchema>;
export const IdSchema=z.object({acquisitionId:z.string().uuid()}).strict();
export const ProjectionSchema=z.object({root:EvidenceRootSchema,workId:z.string().uuid()}).strict();
export const ModuleRequestSchema=IdSchema.extend({kind:z.enum(['ADAPTER','OBSERVER'])}).strict();
export const CatalogueRequestSchema=ProjectionSchema.extend({operation:OperationSchema}).strict();
export const InvocationRequestSchema=IdSchema.extend({operation:OperationSchema,idempotencyKey:z.string().min(1).max(160)}).strict();
export function verifyCapability(body:InterfaceCapability){
 bounded(body,262144);
 const names=['operation','schemaOrUiVersion','adapterModule','requestBinding','observerModule','postcondition','retryAndUnknown','credentialClass'] as const;
 if(body.schema!=='finnor.interface-capability.v1'||Object.keys(body.components).sort().join(',')!==[...names].sort().join(','))fail('P5_CAPABILITY_CODEC');
 for(const name of names){
  const preimage=name==='adapterModule'?body.generated.adapterModule.bytes:name==='observerModule'?body.generated.observerModule.bytes:body.components[name];
  if(hash(reference(name,preimage))!==hash(body[name]))fail('P5_REFERENCE_PREIMAGE_MISMATCH');
 }
 if(hash(body.components.adapterModule)!==hash(body.generated.adapterModule)||hash(body.components.observerModule)!==hash(body.generated.observerModule))fail('P5_MODULE_REFERENCE_MISMATCH');
 readModule(body.generated.adapterModule);readModule(body.generated.observerModule);
 if(body.admission!==null){const ref=RefSchema.safeParse(body.admission);if(!ref.success||ref.data.owner!=='S8')fail('P5_ADMISSION_OWNER');}
 return body;
}
