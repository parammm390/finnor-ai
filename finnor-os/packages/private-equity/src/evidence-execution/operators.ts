import type {DerivationProgram,EvidenceValue,FinancialRow,FinancialSemantics} from '@finnor/shared-types';
import {canonicalExact,exactBinary,exactCompare} from './exact';
import {nodeDigest,type ReusableNode} from './node-reuse';

export interface NativeInput {program:DerivationProgram;sources:Record<string,FinancialRow[]>;maxRows:number;maxBytes:number;cacheKeys?:Record<string,string>;reusable?:Record<string,ReusableNode>}
export interface NativeExecution {outputs:Record<string,EvidenceValue>;nodes:Record<string,EvidenceValue>;operations:Array<{id:string;op:string;operands:string[];actual:string|null;witnessIds:string[]}>;contradictions:unknown[];recomputation:Array<{id:string;cacheKey:string;state:'KEPT'|'COMPUTED';originDerivationId:string|null;originNodeId:string|null;oldDigest:string|null;newDigest:string;validityReason:string}>}
const digestKey=(r:FinancialRow)=>JSON.stringify([r.metricKey,r.semantics]);
const refs=(values:Array<{witnessIds:string[]}>)=>[...new Set(values.flatMap(v=>v.witnessIds))];
const table=(rows:FinancialRow[]):EvidenceValue=>({kind:'table',value:null,rows,semantics:null,truthClass:'DERIVED_VALUE',witnessIds:refs(rows),qualification:['EXACT_SELECTED_ROWS']});
const scalar=(value:string,semantics:FinancialSemantics,witnessIds:string[],qualification:string[]=[]):EvidenceValue=>({kind:'scalar',value:canonicalExact(value),semantics,truthClass:'DERIVED_VALUE',witnessIds,qualification});
export function validateProgram(program:DerivationProgram,inputIds:Set<string>):void{
 const seen=new Map<string,number>();
 for(const node of program.nodes){if(seen.has(node.id))throw Error('DUPLICATE_NODE_ID');const parents='input' in node?[node.input]:'left' in node?[node.left,node.right]:[];for(const p of parents)if(!seen.has(p))throw Error('FINITE_TOPOLOGICAL_PROGRAM_REQUIRED');
  const depth=1+Math.max(0,...parents.map(p=>seen.get(p)!));if(depth>16)throw Error('PROGRAM_DEPTH_BOUND');if(node.op==='source'&&!inputIds.has(node.inputId))throw Error('SOURCE_INPUT_UNAVAILABLE');seen.set(node.id,depth);}
 for(const id of program.outputs)if(!seen.has(id))throw Error('OUTPUT_NODE_UNAVAILABLE');
}
function semanticCompatibility(a:FinancialSemantics,b:FinancialSemantics,op:string):void{
 if(a.entityType!==b.entityType||a.entityId!==b.entityId)throw Error('ENTITY_SCOPE_MISMATCH');
 if(op!=='growth'&&(a.periodStart!==b.periodStart||a.periodEnd!==b.periodEnd))throw Error('PERIOD_MISMATCH');
 if(a.frequency!==b.frequency||a.calendar!==b.calendar)throw Error('PERIOD_CALENDAR_MISMATCH');
 if(op==='growth'&&(Date.parse(a.periodStart)<=Date.parse(b.periodStart)||Date.parse(a.periodEnd)<=Date.parse(b.periodEnd)))throw Error('GROWTH_PERIOD_ORDER_REQUIRED');
 if(a.unit!==b.unit&&op!=='multiply')throw Error('UNIT_MISMATCH');
 if(a.currencyCode!==b.currencyCode)throw Error('CURRENCY_MISMATCH_MISSING_FX_WITNESS');
 if(a.consolidation!==b.consolidation)throw Error('CONSOLIDATION_SCOPE_MISMATCH');
 if(a.instrument!==b.instrument)throw Error('INSTRUMENT_MISMATCH');
 if(a.scale!=='1'||b.scale!=='1'||a.sign!=='AS_RECORDED'||b.sign!=='AS_RECORDED')throw Error('NORMALIZED_SCALE_SIGN_REQUIRED');
 if(op==='multiply'&&a.unit==='currency'&&b.unit==='currency')throw Error('UNSUPPORTED_CURRENCY_SQUARED_DIMENSION');
}
export function runNativeProgram(input:NativeInput):NativeExecution{
 validateProgram(input.program,new Set(Object.keys(input.sources)));const nodes:Record<string,EvidenceValue>={},operations:NativeExecution['operations']=[],contradictions:unknown[]=[],recomputation:NativeExecution['recomputation']=[];
 const get=(id:string)=>{const v=nodes[id];if(!v)throw Error('NODE_UNAVAILABLE');return v;};
 const rows=(id:string)=>{const v=get(id);if(v.kind!=='table'||!v.rows)throw Error('TABLE_REQUIRED');return v.rows;};
 const number=(id:string)=>{const v=get(id);if(v.kind!=='scalar'||v.value===null||!v.semantics)throw Error('MATERIAL_SCALAR_REQUIRED');return v;};
 const reconcile=(source:FinancialRow[])=>{const groups=new Map<string,FinancialRow[]>();for(const row of source)groups.set(digestKey(row),[...(groups.get(digestKey(row))??[]),row]);const reconciled:FinancialRow[]=[];
  for(const [key,group] of groups){const distinct=[...new Set(group.map(r=>canonicalExact(r.value)))];if(distinct.length!==1){contradictions.push({logicalKey:key,values:distinct,witnessIds:refs(group)});throw Error('UNRESOLVED_SOURCE_CONFLICT');}reconciled.push({...group[0]!,value:distinct[0]!,witnessIds:refs(group)});}return reconciled;};
 for(const node of input.program.nodes){let output:EvidenceValue;const cacheKey=input.cacheKeys?.[node.id]??'',cached=cacheKey?input.reusable?.[cacheKey]:undefined;
  if(cached){if(nodeDigest(cached.value)!==cached.digest||cached.value.truthClass!=='DERIVED_VALUE')throw Error('IMMUTABLE_NODE_CACHE_DIGEST_MISMATCH');output=cached.value;}
  else if(node.op==='source')output=table(input.sources[node.inputId]??[]);
  else if(node.op==='reconcile')output=table(reconcile(rows(node.input)));
  else if(node.op==='unique'){const selected=reconcile(rows(node.input));if(selected.length!==1)throw Error(selected.length?'AMBIGUOUS_MATERIAL_VALUE':'MATERIAL_INPUT_UNAVAILABLE');output=scalar(selected[0]!.value,selected[0]!.semantics,selected[0]!.witnessIds);operations.push({id:node.id,op:node.op,operands:[selected[0]!.value],actual:output.value,witnessIds:output.witnessIds});}
  else if(node.op==='filter'){output=table(rows(node.input).filter(r=>{const a=r.fields[node.field]??null;if(a===null)return false;const c=node.field==='value'?exactCompare(a,node.value):a.localeCompare(node.value);return node.predicate==='eq'?c===0:node.predicate==='neq'?c!==0:node.predicate==='lt'?c<0:node.predicate==='lte'?c<=0:node.predicate==='gt'?c>0:c>=0;}));}
  else if(node.op==='project'){output=table(rows(node.input).map(r=>({...r,fields:Object.fromEntries(node.fields.map(f=>[f,r.fields[f]??null]))})));}
  else if(node.op==='join'){const l=rows(node.left),right=rows(node.right),joined:FinancialRow[]=[];const index=new Map<string,FinancialRow[]>();for(const row of right){const key=JSON.stringify(node.on.map(f=>row.fields[f]??null));index.set(key,[...(index.get(key)??[]),row]);}
   for(const row of l)for(const match of index.get(JSON.stringify(node.on.map(f=>row.fields[f]??null)))??[]){semanticCompatibility(row.semantics,match.semantics,'join');if(joined.length>=input.maxRows)throw Error('JOIN_ROW_BOUND');joined.push({...row,witnessIds:refs([row,match]),fields:{...row.fields,...Object.fromEntries(Object.entries(match.fields).map(([k,v])=>['right_'+k,v]))}});}output=table(joined);}
  else if(node.op==='aggregate'){const source=reconcile(rows(node.input)),groups=new Map<string,FinancialRow[]>();for(const row of source){const key=JSON.stringify(node.groupBy.map(f=>row.fields[f]??null));groups.set(key,[...(groups.get(key)??[]),row]);}const grouped:FinancialRow[]=[];
   for(const [key,group] of groups){const first=group[0]!;for(const row of group)semanticCompatibility(first.semantics,row.semantics,'add');let value=node.method==='count'?String(group.length):first.value;for(const row of group.slice(1))if(node.method==='sum')value=exactBinary('add',value,row.value);else if(node.method==='min'&&exactCompare(row.value,value)<0||node.method==='max'&&exactCompare(row.value,value)>0)value=row.value;
    const semantics={...first.semantics,...(node.method==='count'?{unit:'count' as const,currencyCode:null}:{})};grouped.push({...first,recordId:'group:'+key,metricKey:node.method,value,semantics,witnessIds:refs(group),fields:{...first.fields,value,unit:semantics.unit,currencyCode:semantics.currencyCode,metricKey:node.method,recordId:'group:'+key}});operations.push({id:node.id+':'+key,op:node.method,operands:group.map(r=>r.value),actual:value,witnessIds:refs(group)});}
   output=table(grouped);}
  else {const left=number(node.left),right=number(node.right);semanticCompatibility(left.semantics!,right.semantics!,node.op);const semantics={...left.semantics!,...(node.op==='ratio'?{unit:'multiple' as const,currencyCode:null}:node.op==='growth'?{unit:'rate' as const,currencyCode:null}:{})};output=scalar(exactBinary(node.op,left.value!,right.value!,node.decimalPlaces),semantics,refs([left,right]));operations.push({id:node.id,op:node.op,operands:[left.value!,right.value!],actual:output.value,witnessIds:output.witnessIds});}
  recomputation.push({id:node.id,cacheKey,state:cached?'KEPT':'COMPUTED',originDerivationId:cached?.originDerivationId??null,originNodeId:cached?.originNodeId??null,oldDigest:cached?.digest??null,newDigest:nodeDigest(output),validityReason:cached?'CURRENT_AUTHORIZED_SOURCE_MEMBERSHIP_WITNESSES_CODE_SCHEMA_AND_OPERATOR_IDENTITY_MATCH':'NATIVE_OPERATOR_EXECUTED_ON_CURRENT_AUTHORIZED_SOURCES'});
  if(output.rows&&output.rows.length>input.maxRows)throw Error('INTERMEDIATE_ROW_BOUND');nodes[node.id]=output;if(Buffer.byteLength(JSON.stringify(nodes))>input.maxBytes)throw Error('INTERMEDIATE_SERIALIZATION_BOUND');
 }
 return {outputs:Object.fromEntries(input.program.outputs.map(id=>[id,get(id)])),nodes,operations,contradictions,recomputation};
}
