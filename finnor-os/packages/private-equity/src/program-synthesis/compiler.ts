import { DerivationProgramSchema, type DerivationProgram, type FinancialSemantics } from '@finnor/shared-types';
import {compileTypeScriptModule} from './typescript';
import { sha,stable } from '../evidence-execution/store';
import { P1_VERSION, type Expression, type HarnessRequest, type Instruction, type NativeModule, type HarnessNode } from './contracts';

type Type={unit:FinancialSemantics['unit'];currencyCode:string|null;scope:string|null};
export function validateAcceptance(request:HarnessRequest) {
 const sources=new Map(request.sources.map(s=>[s.key,s.source]));
 if(sources.size!==request.sources.length||new Set(request.acceptance.targets.map(t=>t.key)).size!==request.acceptance.targets.length)throw Error('DUPLICATE_SOURCE_OR_TARGET');
 const used=new Set<string>();let steps=0,depth=0;
 function infer(e:Expression,d:number):Type {
  if(++steps>256||d>(request.limits?.maxDepth??12))throw Error('PROGRAM_EXPANSION_BOUND');depth=Math.max(depth,d);
  if(e.kind==='input'){const s=sources.get(e.key!);if(!s)throw Error('UNRESOLVED_INPUT_PORT');used.add(e.key!);if(s.kind==='derivation'||s.kind==='model')throw Error('SOURCE_SEMANTICS_REQUIRE_OWNER_RESOLUTION');return {unit:s.unit,currencyCode:s.currencyCode,scope:stable({...s,kind:undefined,metricKey:undefined,unit:undefined,currencyCode:undefined,layout:undefined,documentId:undefined,documentVersionId:undefined})};}
  if(e.kind==='literal'){if((e.unit==='currency')!==(e.currencyCode!==null))throw Error('LITERAL_UNIT_CURRENCY_MISMATCH');return {unit:e.unit!,currencyCode:e.currencyCode!,scope:null};}
  if(e.kind==='if'){
   const a=infer(e.condition!.left,d+1),b=infer(e.condition!.right,d+1),yes=infer(e.whenTrue!,d+1),no=infer(e.whenFalse!,d+1);
   if(a.unit!==b.unit||a.currencyCode!==b.currencyCode)throw Error('BRANCH_GUARD_UNIT_CURRENCY_MISMATCH');
   if(yes.unit!==no.unit||yes.currencyCode!==no.currencyCode)throw Error('BRANCH_OUTPUT_UNIT_CURRENCY_MISMATCH');
   const scopes=[a.scope,b.scope,yes.scope,no.scope].filter(Boolean);if(new Set(scopes).size>1)throw Error('BRANCH_ENTITY_PERIOD_CLOCK_MISMATCH');
   return {...yes,scope:yes.scope??no.scope??a.scope??b.scope};
  }
  const a=infer(e.left!,d+1),b=infer(e.right!,d+1);
  if(a.scope&&b.scope&&a.scope!==b.scope)throw Error('ENTITY_PERIOD_CLOCK_CONSOLIDATION_MISMATCH');
  if(e.kind==='ratio'){if(a.unit!==b.unit||a.currencyCode!==b.currencyCode)throw Error('RATIO_DIMENSION_MISMATCH');return {unit:'multiple',currencyCode:null,scope:a.scope??b.scope};}
  if(e.kind==='multiply'){const dimensionless=(v:Type)=>['multiple','ratio','rate','count'].includes(v.unit)&&v.currencyCode===null;if(!dimensionless(a)&&!dimensionless(b))throw Error('UNDEFINED_MULTIPLICATION_UNIT');return {...(dimensionless(b)?a:b),scope:a.scope??b.scope};}
  if(a.unit!==b.unit||a.currencyCode!==b.currencyCode)throw Error('FINANCIAL_UNIT_CURRENCY_MISMATCH');return {...a,scope:a.scope??b.scope};
 }
 for(const t of request.acceptance.targets){const type=infer(t.expression,1);if(type.unit!==t.unit||type.currencyCode!==t.currencyCode)throw Error('OUTPUT_UNIT_MISMATCH');}
 if(new Set(request.acceptance.requiredSourceKeys).size!==request.acceptance.requiredSourceKeys.length)throw Error('DUPLICATE_REQUIRED_SOURCE');
 for(const k of request.acceptance.requiredSourceKeys)if(!sources.has(k)||!used.has(k))throw Error('REQUIRED_SOURCE_UNCOVERED');
 for(const s of request.sources)if(!used.has(s.key))throw Error('UNUSED_MATERIAL_SOURCE');
 const operations=request.operations??[];if(new Set(operations.map(o=>o.key)).size!==operations.length)throw Error('DUPLICATE_OPERATION_NODE');
 for(const o of operations){if(o.op==='propose_effect'&&((o.operation==='clear'&&o.value!==null)||(o.operation==='set'&&o.value===null)))throw Error('EXACT_NULL_OPERATION_MISMATCH');if(o.op==='await_observation'&&(Date.parse(o.earliestAt)>Date.parse(o.deadlineAt)||Date.parse(o.deadlineAt)<=Date.now()))throw Error('WAIT_DEADLINE_IMPOSSIBLE');}
 return {steps,depth};
}

/** Two different executable representations: shared SSA registers vs per-output stack machines. */
export function constructModules(request:HarnessRequest,closureDigest:string):NativeModule[] {
 const bounds=validateAcceptance(request);
 const source=stable({acceptance:request.acceptance,sourceSchemas:request.sources,operations:request.operations??[]});
 const registers:Array<{id:string;expression:Record<string,unknown>;left?:string;right?:string;whenTrue?:string;whenFalse?:string}>=[],memo=new Map<string,string>();
 function lower(e:Expression):string {
  const digest=sha(e),old=memo.get(digest);if(old)return old;
  const left=e.kind==='if'?lower(e.condition!.left):e.left?lower(e.left):undefined,right=e.kind==='if'?lower(e.condition!.right):e.right?lower(e.right):undefined;
  const whenTrue=e.whenTrue?lower(e.whenTrue):undefined,whenFalse=e.whenFalse?lower(e.whenFalse):undefined,id='r'+registers.length;
  registers.push({id,expression:e.kind==='if'?{kind:'if',comparison:e.condition!.comparison}:{kind:e.kind,...(e.key?{key:e.key}:{}),...(e.value!==undefined?{value:e.value}:{})},...(left?{left}:{}),...(right?{right}:{}),...(whenTrue?{whenTrue}:{}),...(whenFalse?{whenFalse}:{})});memo.set(digest,id);return id;
 }
 const ssa={schema:'finnor.p1.ssa.v1',registers,outputs:request.acceptance.targets.map(t=>({key:t.key,register:lower(t.expression)}))};
 function emit(e:Expression):Instruction[]{
  if(e.kind==='input')return [{op:'input',key:e.key!}];if(e.kind==='literal')return [{op:'literal',value:e.value!}];
  if(e.kind==='if')return [{op:'branch',comparison:e.condition!.comparison,left:emit(e.condition!.left),right:emit(e.condition!.right),whenTrue:emit(e.whenTrue!),whenFalse:emit(e.whenFalse!)}];
  return [...emit(e.left!),...emit(e.right!),{op:e.kind}];
 }
 const instructionCount=(list:Instruction[]):number=>list.reduce((n,i)=>n+1+(i.op==='branch'?instructionCount(i.left)+instructionCount(i.right)+instructionCount(i.whenTrue)+instructionCount(i.whenFalse):0),0);
 const stack={schema:'finnor.p1.stack.v1',outputs:request.acceptance.targets.map(t=>({key:t.key,instructions:emit(t.expression)}))};
 return [ssa,stack].map((body,i)=>{const compiled=stable(body),digest=sha(compiled),format=i===0?'BOUNDED_SSA':'BOUNDED_STACK';return {schema:'finnor.harness-module.v1',id:'module:'+digest,sourceDigest:sha(source),compiledDigest:digest,structureDigest:sha({format,body}),source,compiled,format,typescript:compileTypeScriptModule(compiled,format),entrypoint:'compute',inputKeys:request.sources.map(s=>s.key),outputs:request.acceptance.targets.map(({key,unit,currencyCode})=>({key,unit,currencyCode})),bounds:{steps:i===0?ssa.registers.length:stack.outputs.reduce((n,o)=>n+instructionCount(o.instructions),0),depth:bounds.depth,bytes:Buffer.byteLength(compiled)},runtime:{kind:'REGISTERED_NATIVE_IR',version:P1_VERSION,closureDigest},checks:['P4_CURRENT_COMPLETE_SOURCE','FULL_SEMANTIC_TYPESCRIPT_COMPILATION','S6_ISOLATED_EMITTED_BYTES','POSTGRES_NUMERIC_ACCEPTANCE','NATIVE_ARTIFACT_REINTERPRETATION'],admission:null};});
}
export function evidenceSourceProgram(request:HarnessRequest):DerivationProgram {
 return DerivationProgramSchema.parse({schema:'finnor.derivation-ir.v1',nodes:request.sources.flatMap(s=>[{id:'source_'+sha(s.key).slice(0,24),op:'source',inputId:s.key},{id:s.key,op:'unique',input:'source_'+sha(s.key).slice(0,24)}]),outputs:request.sources.map(s=>s.key)});
}
export function constructGraph(request:HarnessRequest,modules:NativeModule[],deadlineAt:string):HarnessNode[] {
 const raw:Array<{op:HarnessNode['op'];owner:string;payload:unknown;inputs:string[];outputs:string[]}>=[
  {op:'derive',owner:'P4/S1',payload:evidenceSourceProgram(request),inputs:request.sources.map(s=>s.key),outputs:request.sources.map(s=>s.key)},
  {op:'search',owner:'P1_REGISTERED_NATIVE_PENDING_P2',payload:{policy:'FIXED_CHECKED_FEWEST_INSTRUCTIONS_V1',modules:modules.map(m=>m.id)},inputs:[],outputs:['selectedModule']},
  {op:'solve',owner:'REGISTERED_EXACT_FINANCIAL_ARITHMETIC_NO_S5_GRANT',payload:{moduleIds:modules.map(m=>m.id)},inputs:request.sources.map(s=>s.key),outputs:request.acceptance.targets.map(t=>t.key)},
  ...(request.operations??[]).map(o=>({op:o.op,owner:({propose_model:'S3_PROPOSAL_ONLY',design_inquiry:'S2',simulate:'S3_MODEL_RELATIVE',await_observation:'CORE_NATIVE_EVENT_WAIT',propose_effect:'S6_PROPOSAL_ONLY',stop:'S4_CHOICE_UNAVAILABLE'} as const)[o.op],payload:o,inputs:[],outputs:[o.key]})),
  {op:'compose_artifact',owner:'NATIVE_ANALYTICAL_DRAFT_NO_IC_PUBLICATION',payload:request.acceptance.deliverable,inputs:request.acceptance.targets.map(t=>t.key),outputs:['analyticalDraft']},
 ];
 if(raw.length>32)throw Error('PROGRAM_NODE_BOUND');const nodes:HarnessNode[]=[];
 for(const [i,n] of raw.entries()){const semanticDigest=sha({op:n.op,payload:n.payload,inputs:n.inputs,outputs:n.outputs});nodes.push({id:'p1node_'+semanticDigest.slice(0,24),op:n.op,dependsOn:i?[nodes[i-1]!.id]:[],inputPorts:n.inputs,outputPorts:n.outputs,semanticDigest,owner:n.owner,capabilityVersion:P1_VERSION,truthClass:n.op==='propose_effect'?'PROPOSED_EFFECT_NO_AUTHORITY':n.op==='simulate'?'MODEL_RELATIVE':'DERIVED_OR_PROPOSED_NOT_OBSERVED',preconditions:['CURRENT_WORK_INPUT','CURRENT_SOURCE_RIGHTS','ORIGINAL_EPISODE_GRANT'],postconditions:['FROZEN_ACCEPTANCE_UNCHANGED'],deadlineAt,maxAttempts:1,failure:'STOP_WITH_PREDICATE',cancellation:'FENCE_BEFORE_PUBLICATION',payload:n.payload});}
 if(new Set(nodes.map(n=>n.id)).size!==nodes.length)throw Error('DUPLICATE_NODE_SEMANTICS');return nodes;
}
