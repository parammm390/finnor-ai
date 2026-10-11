/** Producer grammar/lowering validation. Acceptance has separate Python semantics. */
import {INPUT_ORDER,R8_PROFILE,GRAMMAR,type Choices,type IntegerExpr,type BooleanExpr,type Expr,type Statement,type IntegerProgram} from './contracts';

type Bound={kind:'int'|'bool';low:number;high:number};
const keys=(v:unknown,wanted:string[])=>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==wanted.sort().join(','))throw Error('R8_GRAMMAR_FIELDS');
};
export function validateProgram(value:unknown):IntegerProgram {
 if(Buffer.byteLength(JSON.stringify(value)??'')>GRAMMAR.bytes)throw Error('R8_GRAMMAR_BYTES');
 keys(value,['schema','profile','inputOrder','semantics','body','output','bounds']);
 const p=value as IntegerProgram;
 if(p.schema!=='finnor.r8.integer-program.v1'||p.profile!==R8_PROFILE||JSON.stringify(p.inputOrder)!==JSON.stringify(INPUT_ORDER)||p.semantics!=='EXACT_INTEGER')throw Error('R8_ORIGINAL_PROFILE');
 keys(p.bounds,['steps','integerAbs']);
 if(p.bounds.steps!==1024||p.bounds.integerAbs!==63)throw Error('R8_DECLARED_BOUNDS');
 let nodes=0,loops=0,counting=true;const names=new Set<string>();
 const tick=(depth:number)=>{if(counting)nodes++;if(nodes>512||depth>24)throw Error('R8_GRAMMAR_NODES_DEPTH');};
 const name=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(v))throw Error('R8_LOCAL_NAME');names.add(v);if(names.size>32)throw Error('R8_LOCAL_COUNT');};
 function expression(e:Expr,env:Map<string,Bound>,depth:number):Bound {
  tick(depth);if(!e||typeof e!=='object')throw Error('R8_EXPRESSION');
  if(e.op==='int'){keys(e,['op','value']);if(!Number.isSafeInteger(e.value)||e.value< -21||e.value>21)throw Error('R8_LITERAL');return {kind:'int',low:e.value,high:e.value};}
  if(e.op==='bool'){keys(e,['op','value']);if(typeof e.value!=='boolean')throw Error('R8_BOOLEAN_LITERAL');return {kind:'bool',low:0,high:1};}
  if(e.op==='input'){keys(e,['op','index']);if(!Number.isSafeInteger(e.index)||e.index<0||e.index>5)throw Error('R8_INPUT_REFERENCE');return {kind:'int',low:0,high:7};}
  if(e.op==='local'){keys(e,['op','name']);name(e.name);const bound=env.get(e.name);if(!bound)throw Error('R8_UNINITIALIZED_LOCAL');return bound;}
  if(e.op==='member'){keys(e,['op','mask','project']);const b=expression(e.mask,env,depth+1);if(b.kind!=='int'||b.low<0||b.high>7||!Number.isSafeInteger(e.project)||e.project<0||e.project>2)throw Error('R8_MEMBERSHIP');return {kind:'bool',low:0,high:1};}
  if(e.op==='not'){keys(e,['op','value']);if(expression(e.value,env,depth+1).kind!=='bool')throw Error('R8_BOOLEAN_TYPE');return {kind:'bool',low:0,high:1};}
  if(e.op==='if'){keys(e,['op','condition','then','else']);if(expression(e.condition,env,depth+1).kind!=='bool')throw Error('R8_BOOLEAN_TYPE');const a=expression(e.then,env,depth+1),b=expression(e.else,env,depth+1);if(a.kind!==b.kind)throw Error('R8_BRANCH_TYPE');return {kind:a.kind,low:Math.min(a.low,b.low),high:Math.max(a.high,b.high)};}
  if(!['add','sub','mul','lt','lte','eq','gte','gt','and','or'].includes(e.op))throw Error('R8_FORBIDDEN_OPERATION');
  keys(e,['op','left','right']);const a=expression(e.left,env,depth+1),b=expression(e.right,env,depth+1);
  if(e.op==='and'||e.op==='or'){if(a.kind!=='bool'||b.kind!=='bool')throw Error('R8_BOOLEAN_TYPE');return {kind:'bool',low:0,high:1};}
  if(a.kind!=='int'||b.kind!=='int')throw Error('R8_INTEGER_TYPE');
  if(['lt','lte','eq','gte','gt'].includes(e.op))return {kind:'bool',low:0,high:1};
  const values=e.op==='mul'?[a.low*b.low,a.low*b.high,a.high*b.low,a.high*b.high]:e.op==='add'?[a.low+b.low,a.high+b.high]:[a.low-b.high,a.high-b.low];
  const low=Math.min(...values),high=Math.max(...values);if(low< -63||high>63)throw Error('R8_INTEGER_GROWTH');return {kind:'int',low,high};
 }
 function statements(list:Statement[],env:Map<string,Bound>,depth:number):Map<string,Bound> {
  if(!Array.isArray(list)||list.length>32)throw Error('R8_STATEMENT_LIST');env=new Map(env);
  for(const s of list){tick(depth);if(!s||typeof s!=='object')throw Error('R8_STATEMENT');
   if(s.op==='set'){keys(s,['op','name','value']);name(s.name);const b=expression(s.value,env,depth+1);if(env.has(s.name)&&env.get(s.name)!.kind!==b.kind)throw Error('R8_ASSIGNMENT_TYPE');env.set(s.name,b);}
   else if(s.op==='if'){keys(s,['op','condition','then','else']);if(expression(s.condition,env,depth+1).kind!=='bool')throw Error('R8_BOOLEAN_TYPE');const a=statements(s.then,env,depth+1),b=statements(s.else,env,depth+1);for(const [key,left]of a){const right=b.get(key);if(right){if(left.kind!==right.kind)throw Error('R8_BRANCH_TYPE');env.set(key,{kind:left.kind,low:Math.min(left.low,right.low),high:Math.max(left.high,right.high)});}}}
   else if(s.op==='for'){keys(s,['op','name','from','to','step','body']);name(s.name);if(++loops>1||![s.from,s.to,s.step].every(v=>Number.isSafeInteger(v)&&v>=-21&&v<=21)||![1,-1].includes(s.step))throw Error('R8_LOOP_UPDATE');const n=Math.max(0,Math.ceil((s.to-s.from)/s.step));if(n<1||n>7)throw Error('R8_LOOP_ITERATIONS');const originalCounting=counting;for(let i=0,v=s.from;i<n;i++,v+=s.step){counting=originalCounting&&i===0;if(v<0||v>7)throw Error('R8_LOOP_ITERATIONS');env.set(s.name,{kind:'int',low:v,high:v});env=statements(s.body,env,depth+1);}counting=originalCounting;}
   else throw Error('R8_FORBIDDEN_STATEMENT');
  }return env;
 }
 const env=statements(p.body,new Map(),0);if(env.get(p.output)?.kind!=='int')throw Error('R8_OUTPUT_TYPE');return structuredClone(p);
}

export function programForChoices(c:Choices):IntegerProgram {
 if(c.enabled.length!==7||c.enabled.some(v=>typeof v!=='boolean')||![0,1].includes(c.costFamily)||![6,7,8].includes(c.capacity)||[c.netScore,c.inclusiveFeasibility,c.inclusiveImprovement,c.descending].some(v=>typeof v!=='boolean'))throw Error('R8_CHOICES_INVALID');
 const literal=(value:number):IntegerExpr=>({op:'int',value}),local=(name:string):IntegerExpr=>({op:'local',name});
 const sum=(offset:number):IntegerExpr=>[0,1,2].map((project):IntegerExpr=>({op:'if',condition:{op:'member',mask:local('mask'),project},then:{op:'input',index:project+offset},else:literal(0)}))
  .reduce((left,right):IntegerExpr=>({op:'add',left,right}),literal(0));
 const enabled:BooleanExpr=c.enabled.map((yes,i):BooleanExpr=>yes?{op:'eq',left:local('mask'),right:literal(i+1)}:{op:'bool',value:false})
  .reduce((left,right):BooleanExpr=>({op:'or',left,right}),{op:'bool',value:false});
 const score:IntegerExpr=c.netScore?{op:'sub',left:sum(3),right:sum(0)}:sum(3);
 const body:Statement[]=[
  {op:'set',name:'bestMask',value:literal(0)},{op:'set',name:'bestValue',value:literal(0)},
  {op:'for',name:'mask',from:c.descending?7:1,to:c.descending?0:8,step:c.descending?-1:1,body:[
   {op:'if',condition:enabled,then:[
    {op:'set',name:'cost',value:sum(c.costFamily===0?0:3)},{op:'set',name:'score',value:score},
    {op:'if',condition:{op:'and',left:{op:c.inclusiveFeasibility?'lte':'lt',left:local('cost'),right:literal(c.capacity)},
     right:{op:c.inclusiveImprovement?'gte':'gt',left:local('score'),right:local('bestValue')}},
     then:[{op:'set',name:'bestMask',value:local('mask')},{op:'set',name:'bestValue',value:local('score')}],else:[]},
   ],else:[]},
  ]},
 ];
 return validateProgram({schema:'finnor.r8.integer-program.v1',profile:R8_PROFILE,inputOrder:INPUT_ORDER,semantics:'EXACT_INTEGER',body,output:'bestMask',bounds:{steps:1024,integerAbs:63}});
}
