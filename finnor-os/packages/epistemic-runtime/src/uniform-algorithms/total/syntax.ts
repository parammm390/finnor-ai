import {z} from 'zod';
import type {TotalType,TotalExpression,TotalProgram,TotalFamilyDefinition,TotalProposition,TotalTerm,TotalWorkSpecification} from '../../../../shared-types/src/total-algorithm-theory';
import {jsonHash} from '../syntax';

export const grammar={
 revision:'CLOSED_TOTAL_FOLD_AST_V2_1',types:['INT','NAT','BOOL','PRODUCT','LIST'],
 binary:['ADD','SUB','MUL','MIN','MAX','LE','LT','EQ','AND','OR','PAIR','CONS'],
 unary:['NOT','FIRST','SECOND','HEAD','TAIL','LENGTH','IS_EMPTY'],
 constructors:['VAR','INT','NAT','BOOL','EMPTY','IF'],
 propositions:['TRUE','FALSE','FEASIBLE','SAFE','LE','LT','EQ','NOT','AND','OR','IMPLIES','IFF'],
 recursion:'RIGHT_STRUCTURAL_FOLD',maxDepth:16,maxNodes:512,maxTypeDepth:4,
 integerPrimitives:'EXACT_UNIT_COST_NOT_BIT_COMPLEXITY',emptyHead:'CANONICAL_ZERO_VALUE_OF_ELEMENT_TYPE',
 environmentLookupSteps:true,internalMinMaxDispatchComparisonBranchSteps:3,listLengthTraversalCharged:true,
} as const;
export const grammarDigest=jsonHash(grammar);
const integer=z.string().max(512).regex(/^(?:0|-?[1-9][0-9]*)$/);
const natural=z.string().max(512).regex(/^(?:0|[1-9][0-9]*)$/);
const text=z.string().min(1).max(256);
const typeSchema:z.ZodType<TotalType>=z.lazy(()=>z.union([
 z.enum(['INT','NAT','BOOL']),z.object({product:z.tuple([typeSchema,typeSchema])}).strict(),
 z.object({list:typeSchema}).strict(),
]));
const expressionSchema:z.ZodType<TotalExpression>=z.lazy(()=>z.union([
 z.object({op:z.literal('VAR'),index:z.number().int().min(0).max(7)}).strict(),
 z.object({op:z.literal('INT'),value:integer}).strict(),
 z.object({op:z.literal('NAT'),value:natural}).strict(),
 z.object({op:z.literal('BOOL'),value:z.boolean()}).strict(),
 z.object({op:z.enum(grammar.binary),left:expressionSchema,right:expressionSchema}).strict(),
 z.object({op:z.enum(grammar.unary),arg:expressionSchema}).strict(),
 z.object({op:z.literal('EMPTY'),element:typeSchema}).strict(),
 z.object({op:z.literal('IF'),condition:expressionSchema,then:expressionSchema,else:expressionSchema}).strict(),
]));
const termSchema:z.ZodType<TotalTerm>=z.union([
 z.object({op:z.enum(['INITIAL','OUTPUT','ZERO'])}).strict(),z.object({op:z.literal('INT'),value:integer}).strict(),
]);
const propositionSchema:z.ZodType<TotalProposition>=z.lazy(()=>z.union([
 z.object({op:z.enum(['TRUE','FALSE'])}).strict(),
 z.object({op:z.enum(['FEASIBLE','SAFE']),arg:termSchema}).strict(),
 z.object({op:z.enum(['LE','LT','EQ']),left:termSchema,right:termSchema}).strict(),
 z.object({op:z.literal('NOT'),arg:propositionSchema}).strict(),
 z.object({op:z.enum(['AND','OR','IMPLIES','IFF']),left:propositionSchema,right:propositionSchema}).strict(),
]));
const definitionSchema=z.object({
 schema:z.literal('finnor.y5.total-family-definition.v2'),input:z.literal('ALL_FINITE_INTEGER_LISTS'),
 output:z.literal('MATHEMATICAL_INTEGER'),semanticState:z.literal('INT'),safe:expressionSchema,advance:expressionSchema,
 objective:z.literal('LEAST_FEASIBLE_INITIAL_STATE'),prefixes:z.literal('INCLUDING_EMPTY_AND_COMPLETE'),
 numericalMeaning:z.literal('EXACT_UNBOUNDED_INTEGER'),tie:z.literal('EQUAL_INTEGER_OUTPUT'),
 costModel:z.literal('CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2'),
}).strict();
const receiptSchema=z.object({
 schema:z.literal('finnor.y5.semantic-acceptance.v2'),issuerId:text,keyId:text,receiptId:text,tenantId:z.string().uuid(),
 definitionDigest:z.string().regex(/^[a-f0-9]{64}$/),policyRevision:text,scope:text,
 acceptedAt:z.string().datetime(),validUntil:z.string().datetime(),signature:z.string().min(80).max(128).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

function invalid(reason:string):never{throw Error('Y5_TOTAL_'+reason);}
function bounded(value:unknown){
 const stack:{value:unknown;depth:number;exit?:boolean}[]=[{value,depth:0}],active=new WeakSet<object>();let nodes=0;
 while(stack.length){
  const item=stack.pop()!;
  if(item.exit){active.delete(item.value as object);continue;}
  if(++nodes>grammar.maxNodes||item.depth>grammar.maxDepth)invalid('SYNTAX_BOUND');
  if(item.value&&typeof item.value==='object'){
   if(active.has(item.value))invalid('CYCLIC_SYNTAX');
   active.add(item.value);stack.push({...item,exit:true});
   for(const child of Object.values(item.value))stack.push({value:child,depth:item.depth+1});
  }
 }
 if(Buffer.byteLength(JSON.stringify(value)??'')>32768)invalid('SYNTAX_BYTES');
}
export function sameType(a:TotalType,b:TotalType):boolean{return JSON.stringify(a)===JSON.stringify(b);}
export function typeDepth(t:TotalType):number{return typeof t==='string'?1:1+('list'in t?typeDepth(t.list):Math.max(...t.product.map(typeDepth)));}
function requireType(actual:TotalType,expected:TotalType){if(!sameType(actual,expected))invalid('TYPE_MISMATCH');}
export function parseTotalType(value:unknown):TotalType{
 bounded(value);const t=typeSchema.parse(value);if(typeDepth(t)>grammar.maxTypeDepth)invalid('TYPE_DEPTH');return t;
}
function listElement(t:TotalType){if(typeof t==='string'||!('list'in t))invalid('LIST_TYPE_REQUIRED');return t.list;}
function productElements(t:TotalType){if(typeof t==='string'||!('product'in t))invalid('PRODUCT_TYPE_REQUIRED');return t.product;}
export function expressionType(e:TotalExpression,context:TotalType[]):TotalType{
 switch(e.op){
  case 'VAR':{const t=context[e.index];if(!t)invalid('UNBOUND_TYPED_VARIABLE');return t;}
  case 'INT':case 'NAT':case 'BOOL':return e.op;
  case 'EMPTY':if(typeDepth(e.element)>grammar.maxTypeDepth)invalid('TYPE_DEPTH');return {list:e.element};
  case 'IF':{
   requireType(expressionType(e.condition,context),'BOOL');
   const a=expressionType(e.then,context);requireType(expressionType(e.else,context),a);return a;
  }
  case 'FIRST':return productElements(expressionType(e.arg,context))[0];
  case 'SECOND':return productElements(expressionType(e.arg,context))[1];
  case 'HEAD':return listElement(expressionType(e.arg,context));
  case 'TAIL':{const t=expressionType(e.arg,context);listElement(t);return t;}
  case 'LENGTH':case 'IS_EMPTY':listElement(expressionType(e.arg,context));return e.op==='LENGTH'?'NAT':'BOOL';
  case 'NOT':requireType(expressionType(e.arg,context),'BOOL');return 'BOOL';
  default:{
   const left=expressionType(e.left,context),right=expressionType(e.right,context);
   if(e.op==='PAIR')return {product:[left,right]};
   if(e.op==='CONS'){requireType(listElement(right),left);return right;}
   requireType(right,left);
   if(e.op==='AND'||e.op==='OR'){requireType(left,'BOOL');return 'BOOL';}
   if(e.op==='EQ'&&left==='BOOL')return 'BOOL';
   if(left!=='INT'&&left!=='NAT')invalid('NUMERIC_TYPE_REQUIRED');
   return e.op==='LE'||e.op==='LT'||e.op==='EQ'?'BOOL':left;
  }
 }
}
export function parseDefinition(value:unknown):TotalFamilyDefinition{
 bounded(value);const d=definitionSchema.parse(value);
 requireType(expressionType(d.safe,['INT']),'BOOL');requireType(expressionType(d.advance,['INT','INT']),'INT');return d;
}
export function parseWorkSpecification(value:unknown):TotalWorkSpecification{
 bounded(value);const s=z.object({schema:z.literal('finnor.y5.work-specification.v2'),
  definition:definitionSchema,acceptanceReceipt:receiptSchema.nullable()}).strict().parse(value);
 parseDefinition(s.definition);return s;
}
export function parseProgram(value:unknown):TotalProgram{
 bounded(value);const p=z.object({schema:z.literal('finnor.y5.total-program.v2'),
  recursion:z.literal('RIGHT_STRUCTURAL_FOLD'),stateType:typeSchema,initial:expressionSchema,step:expressionSchema,result:expressionSchema}).strict().parse(value);
 if(typeDepth(p.stateType)>grammar.maxTypeDepth)invalid('TYPE_DEPTH');
 requireType(expressionType(p.initial,[]),p.stateType);
 requireType(expressionType(p.step,['INT',p.stateType]),p.stateType);
 requireType(expressionType(p.result,[p.stateType]),'INT');return p;
}
export function parseProposition(value:unknown):TotalProposition{bounded(value);return propositionSchema.parse(value);}
function zeroSteps(t:TotalType):number{return typeof t==='string'||'list'in t?1:zeroSteps(t.product[0])+zeroSteps(t.product[1])+1;}
export function expressionNodeBound(e:TotalExpression,context:TotalType[]=[]):number{
 if(e.op==='VAR')return e.index+2;
 if(e.op==='LENGTH')invalid('TRAVERSAL_REQUIRES_NONCONSTANT_COST_PROOF');
 if('left'in e)return (e.op==='MIN'||e.op==='MAX'?3:1)+expressionNodeBound(e.left,context)+expressionNodeBound(e.right,context);
 if(e.op==='HEAD')return 1+zeroSteps(listElement(expressionType(e.arg,context)))+expressionNodeBound(e.arg,context);
 if('arg'in e)return 1+expressionNodeBound(e.arg,context);
 if(e.op==='IF')return 1+expressionNodeBound(e.condition,context)+expressionNodeBound(e.then,context)+expressionNodeBound(e.else,context);
 return 1;
}
export function programOperationBound(p:TotalProgram){
 return {coefficient:expressionNodeBound(p.step,['INT',p.stateType])+1,constant:expressionNodeBound(p.initial)+expressionNodeBound(p.result,[p.stateType])+2};
}
export type DevelopmentValue=bigint|boolean|DevelopmentValue[];
export class DevelopmentLimitError extends Error{constructor(){super('Y5_TOTAL_DEVELOPMENT_INTEGER_BOUND');}}
function checkedInteger(v:bigint):bigint{if(v.toString().replace('-','').length>2048)throw new DevelopmentLimitError();return v;}
function integerValue(v:DevelopmentValue):bigint{if(typeof v!=='bigint')invalid('DEVELOPMENT_INTEGER_TYPE');return v;}
function booleanValue(v:DevelopmentValue):boolean{if(typeof v!=='boolean')invalid('DEVELOPMENT_BOOLEAN_TYPE');return v;}
function sequenceValue(v:DevelopmentValue):DevelopmentValue[]{if(!Array.isArray(v))invalid('DEVELOPMENT_SEQUENCE_TYPE');return v;}
function zeroValue(t:TotalType):DevelopmentValue{
 if(t==='BOOL')return false;if(t==='INT'||t==='NAT')return 0n;
 return 'list'in t?[]:t.product.map(zeroValue);
}
function evaluate(e:TotalExpression,context:DevelopmentValue[],types:TotalType[]):DevelopmentValue{
 switch(e.op){
  case 'VAR':if(context[e.index]===undefined)invalid('UNBOUND_TYPED_VARIABLE');return context[e.index]!;
  case 'INT':case 'NAT':return BigInt(e.value);
  case 'BOOL':return e.value;
  case 'EMPTY':return [];
  case 'IF':return evaluate(booleanValue(evaluate(e.condition,context,types))?e.then:e.else,context,types);
  case 'NOT':return !booleanValue(evaluate(e.arg,context,types));
  case 'FIRST':return sequenceValue(evaluate(e.arg,context,types))[0]!;
  case 'SECOND':return sequenceValue(evaluate(e.arg,context,types))[1]!;
  case 'HEAD':return sequenceValue(evaluate(e.arg,context,types))[0]??zeroValue(listElement(expressionType(e.arg,types)));
  case 'TAIL':return sequenceValue(evaluate(e.arg,context,types)).slice(1);
  case 'LENGTH':return BigInt(sequenceValue(evaluate(e.arg,context,types)).length);
  case 'IS_EMPTY':return sequenceValue(evaluate(e.arg,context,types)).length===0;
  default:{
   const a=evaluate(e.left,context,types),b=evaluate(e.right,context,types);
   if(e.op==='PAIR')return [a,b];if(e.op==='CONS')return [a,...sequenceValue(b)];
   if(e.op==='AND')return booleanValue(a)&&booleanValue(b);
   if(e.op==='OR')return booleanValue(a)||booleanValue(b);
   if(e.op==='EQ')return a===b;
   const x=integerValue(a),y=integerValue(b);
   switch(e.op){
    case 'ADD':return checkedInteger(x+y);case 'SUB':return expressionType(e.left,types)==='NAT'&&x<y?0n:checkedInteger(x-y);
    case 'MUL':
     if(x===0n||y===0n)return 0n;
     if(x.toString().replace('-','').length+y.toString().replace('-','').length>2048)throw new DevelopmentLimitError();
     return checkedInteger(x*y);
    case 'MIN':return x<y?x:y;case 'MAX':return x>y?x:y;
    case 'LE':return x<=y;case 'LT':return x<y;
   }
  }
 }
}
export function evaluateDevelopmentProgram(value:TotalProgram,input:bigint[]):bigint{
 return compileDevelopmentProgram(value)(input);
}
export function developmentFeasible(value:TotalFamilyDefinition,input:bigint[],initial:bigint):boolean{
 return compileDevelopmentDefinition(value).feasible(input,initial);
}
export function compileDevelopmentProgram(value:TotalProgram){
 const p=parseProgram(value);
 return (input:bigint[]):bigint=>{
  let state=evaluate(p.initial,[],[]);
  for(let i=input.length-1;i>=0;i--)state=evaluate(p.step,[input[i]!,state],['INT',p.stateType]);
  return integerValue(evaluate(p.result,[state],[p.stateType]));
 };
}
export function compileDevelopmentDefinition(value:TotalFamilyDefinition){
 const d=parseDefinition(value),safe=(c:bigint)=>booleanValue(evaluate(d.safe,[c],['INT']));
 return {safe,feasible:(input:bigint[],initial:bigint):boolean=>{
  let state=initial;if(!safe(state))return false;
  for(const x of input){state=integerValue(evaluate(d.advance,[x,state],['INT','INT']));if(!safe(state))return false;}
  return true;
 }};
}
export function renderType(t:TotalType):string{
 return typeof t==='string'?'.'+t.toLowerCase():'list'in t?`(.list ${renderType(t.list)})`:`(.prod ${renderType(t.product[0])} ${renderType(t.product[1])})`;
}
function renderVariable(n:number):string{return n===0?'.here':`(.there ${renderVariable(n-1)})`;}
export function renderExpression(e:TotalExpression,context:TotalType[]):string{
 switch(e.op){
  case 'VAR':expressionType(e,context);return `(.var ${renderVariable(e.index)})`;
  case 'INT':return `(.intLit (${e.value}))`;case 'NAT':return `(.natLit ${e.value})`;case 'BOOL':return `(.boolLit ${e.value})`;
  case 'EMPTY':return `(.nil ${renderType(e.element)})`;
  case 'IF':return `(.ite ${renderExpression(e.condition,context)} ${renderExpression(e.then,context)} ${renderExpression(e.else,context)})`;
  case 'FIRST':case 'SECOND':case 'HEAD':case 'TAIL':case 'LENGTH':case 'IS_EMPTY':case 'NOT':{
   const names={FIRST:'fst',SECOND:'snd',HEAD:'head',TAIL:'tail',LENGTH:'length',IS_EMPTY:'isEmpty',NOT:'not'};
   return `(.${names[e.op]} ${renderExpression(e.arg,context)})`;
  }
  default:{
   let name:string;
   if(e.op==='PAIR'||e.op==='CONS'||e.op==='AND'||e.op==='OR')name=e.op.toLowerCase();
   else{
    const t=expressionType(e.left,context),suffix=e.op==='LE'?'LE':e.op==='LT'?'LT':e.op[0]!+e.op.slice(1).toLowerCase();
    name=(t==='INT'?'int':t==='NAT'?'nat':'bool')+suffix;
   }
   return `(.${name} ${renderExpression(e.left,context)} ${renderExpression(e.right,context)})`;
  }
 }
}
export function renderProgram(value:TotalProgram):string{
 const p=parseProgram(value);
 return `{ stateType := ${renderType(p.stateType)}, initial := ${renderExpression(p.initial,[])}, step := ${renderExpression(p.step,['INT',p.stateType])}, result := ${renderExpression(p.result,[p.stateType])} }`;
}
export function renderDefinition(value:TotalFamilyDefinition):string{
 const d=parseDefinition(value);return `{ safe := ${renderExpression(d.safe,['INT'])}, advance := ${renderExpression(d.advance,['INT','INT'])} }`;
}
function renderTerm(t:TotalTerm):string{return t.op==='INT'?`(.integer (${t.value}))`:t.op==='ZERO'?'(.integer 0)':'.'+t.op.toLowerCase();}
export function renderProposition(value:TotalProposition):string{
 const f=parseProposition(value);
 switch(f.op){
  case 'TRUE':case 'FALSE':return f.op==='TRUE'?'.truth':'.falsity';
  case 'FEASIBLE':case 'SAFE':return `(.${f.op.toLowerCase()} ${renderTerm(f.arg)})`;
  case 'LE':case 'LT':case 'EQ':return `(.${f.op.toLowerCase()} ${renderTerm(f.left)} ${renderTerm(f.right)})`;
  case 'NOT':return `(.not ${renderProposition(f.arg)})`;
  default:return `(.${f.op.toLowerCase()} ${renderProposition(f.left)} ${renderProposition(f.right)})`;
 }
}
