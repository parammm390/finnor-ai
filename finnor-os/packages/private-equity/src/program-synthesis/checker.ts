import type {PoolClient} from 'pg';
import {interpret} from '@finnor/artifacts';
import {sha} from '../evidence-execution/store';
import type {Expression,HarnessRequest,HarnessValue} from './contracts';
/** The independent oracle uses PostgreSQL arithmetic over frozen accepted
 * expressions, never native registers, bytecode or generated TypeScript. */
function acceptedSql(e:Expression,sources:Record<string,string>,params:string[],meter:()=>void):string{
 meter();if(e.kind==='input'||e.kind==='literal'){const value=e.kind==='input'?sources[e.key!]:e.value;if(value===undefined||!/^[-+]?\d+(?:\.\d+)?$/.test(value)||value.length>256)throw Error('ORACLE_INPUT_UNKNOWN');params.push(value);return '$'+params.length+'::numeric';}
 if(e.kind==='if')return '(CASE WHEN '+conditionSql(e.condition!,sources,params,meter)+' THEN '+acceptedSql(e.whenTrue!,sources,params,meter)+' ELSE '+acceptedSql(e.whenFalse!,sources,params,meter)+' END)';
 const a=acceptedSql(e.left!,sources,params,meter),b=acceptedSql(e.right!,sources,params,meter);if(e.kind==='min'||e.kind==='max')return `${e.kind==='min'?'LEAST':'GREATEST'}(${a},${b})`;const op={add:'+',subtract:'-',multiply:'*',ratio:'/'}[e.kind];if(!op)throw Error('ORACLE_OPERATOR_UNAVAILABLE');return '('+a+op+b+')';
}
function conditionSql(c:NonNullable<Expression['condition']>,sources:Record<string,string>,params:string[],meter:()=>void):string{const op={lt:'<',lte:'<=',eq:'=',gte:'>=',gt:'>'}[c.comparison];if(!op)throw Error('ORACLE_COMPARISON_UNAVAILABLE');return '('+acceptedSql(c.left,sources,params,meter)+op+acceptedSql(c.right,sources,params,meter)+')';}
export async function checkNumericalAcceptance(client:PoolClient,accepted:HarnessRequest['acceptance'],sources:Record<string,string>,values:Record<string,HarnessValue>){
 const checks=[];for(const target of accepted.targets){const params:string[]=[];let nodes=0;const expression=acceptedSql(target.expression,sources,params,()=>{if(++nodes>256)throw Error('ORACLE_EXPRESSION_BOUND');});params.push(values[target.key]?.value??'');const result=(await client.query<{ok:boolean;expected:string}>(`SELECT (${expression})=$${params.length}::numeric ok,(${expression})::text expected`,params)).rows[0]!;
  checks.push({id:'numeric:'+target.key,method:'POSTGRES_NUMERIC_ACCEPTED_EXPRESSION',status:result.ok?'PASS':'FAIL',expected:result.expected,actual:values[target.key]?.value??null,unit:target.unit,currencyCode:target.currencyCode,qualification:'FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION'});
 }return checks;
}
export async function observeAcceptedBranches(client:PoolClient,accepted:HarnessRequest['acceptance'],sources:Record<string,string>,witnessIds:string[]){
 const branches:unknown[]=[];let nodes=0;const meter=()=>{if(++nodes>1024)throw Error('ORACLE_BRANCH_EXPANSION_BOUND');};
 async function walk(e:Expression,path:string):Promise<void>{meter();if(e.kind==='if'){const params:string[]=[],sql=conditionSql(e.condition!,sources,params,meter),outcome=(await client.query<{outcome:boolean}>(`SELECT ${sql} outcome`,params)).rows[0]!.outcome;if(typeof outcome!=='boolean')throw Error('UNKNOWN_MATERIAL_BRANCH_GUARD');branches.push({id:'branch:'+sha({path,condition:e.condition}),path,condition:e.condition,conditionDigest:sha(e.condition),outcome:outcome?'TRUE':'FALSE',unknownBehavior:'STOP_WITH_MATERIAL_PREDICATE',selectedArmDigest:sha(outcome?e.whenTrue:e.whenFalse),method:'POSTGRES_ACCEPTED_GUARD',witnessIds,truthClass:'SOURCE_BOUND_DERIVED_GUARD_NOT_FIELD_OUTCOME'});await walk(e.condition!.left,path+'.guard.left');await walk(e.condition!.right,path+'.guard.right');await walk(outcome?e.whenTrue!:e.whenFalse!,path+(outcome?'.true':'.false'));}else{if(e.left)await walk(e.left,path+'.left');if(e.right)await walk(e.right,path+'.right');}}
 for(const target of accepted.targets)await walk(target.expression,target.key);return branches;
}
export async function checkDraftBytes(bytes:Buffer,binding:{values:Record<string,HarnessValue>;requiredSourceKeys:string[];sourceRef:string}){
 const ir=await interpret(bytes,{fileName:'analytical-draft.docx'});
 const paragraphs=ir.nodes.filter(n=>n.kind==='paragraph').map(n=>String(n.data.text??''));
 // Compare independently parsed paragraph values and complete source references.
 // A numeric prefix, heading mention or a second contradictory row is insufficient.
 const rows=Object.entries(binding.values).map(([key,value])=>key+': '+value.value+' '+value.semantics.unit+(value.semantics.currencyCode?' '+value.semantics.currencyCode:'')+'; DERIVED_VALUE; accepted required sources: '+binding.requiredSourceKeys.join(', ')+' [Sources: '+binding.sourceRef+']');
 const material=paragraphs.filter(text=>text.includes('; DERIVED_VALUE; accepted required sources:')||Object.keys(binding.values).some(key=>text.startsWith(key+': ')));
 const missing=rows.filter(row=>material.filter(text=>text===row).length!==1),unexpected=material.filter(text=>!rows.includes(text));
 const bound=rows.length>0&&binding.requiredSourceKeys.length>0&&/^evidence_derivation:[0-9a-f-]{36}$/.test(binding.sourceRef);
 return {id:'artifact:semantic',method:'NATIVE_DOCX_EXACT_BOUND_VALUE_SOURCE_ROWS_V1',status:ir.kind==='docx'&&!ir.warnings.length&&bound&&!missing.length&&!unexpected.length&&material.length===rows.length?'PASS':'FAIL',semanticHash:ir.semanticHash,missing,unexpected,sourceRef:binding.sourceRef,checkedRows:rows.length,warnings:ir.warnings};
}
