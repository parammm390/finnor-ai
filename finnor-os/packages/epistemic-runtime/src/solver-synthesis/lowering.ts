/** Checked static loop unrolling into the existing registered P1 instruction set. */
import {compileTypeScriptModule} from '../../../private-equity/src/program-synthesis/typescript';
import {P1_VERSION,type NativeModule} from '../../../private-equity/src/program-synthesis/contracts';
import {validateProgram} from './grammar';
import {INPUT_ORDER,hash,bytesHash,type Expr,type IntegerProgram,type Statement} from './contracts';
import {canonical} from '../../../governed-execution/src/protocol';

type Value={constant?:number|boolean;register?:string;kind:'int'|'bool'};
export function lowerProgram(input:IntegerProgram,closureDigest:string):NativeModule {
 const program=validateProgram(input),registers:Array<Record<string,unknown>>=[],memo=new Map<string,string>();
 const literal=(v:number):Value=>({constant:v,kind:'int'});
 function register(expression:Record<string,unknown>,links:Record<string,string>={}):Value {
  const descriptor={expression,...links},key=hash(descriptor),prior=memo.get(key);
  if(prior)return {register:prior,kind:'int'};
  if(registers.length>=256)throw Error('R8_P1_REGISTER_BOUND');
  const id='r'+registers.length;registers.push({id,...descriptor});memo.set(key,id);return {register:id,kind:'int'};
 }
 function id(v:Value):string {if(v.register)return v.register;if(v.constant===undefined)throw Error('R8_LOWERING_INTEGER');return register({kind:'literal',value:String(Number(v.constant))}).register!;}
 function branch(condition:Value,yes:Value,no:Value):Value {
  if(typeof condition.constant==='boolean')return condition.constant?yes:no;
  if(id(yes)===id(no))return yes;
  return register({kind:'if',comparison:'eq'},{left:id(condition),right:id(literal(1)),whenTrue:id(yes),whenFalse:id(no)});
 }
 function expression(e:Expr,env:Map<string,Value>):Value {
  if(e.op==='int')return literal(e.value);
  if(e.op==='bool')return {constant:e.value,kind:'bool'};
  if(e.op==='input')return register({kind:'input',key:INPUT_ORDER[e.index]!});
  if(e.op==='local'){const value=env.get(e.name);if(!value)throw Error('R8_LOWERING_UNINITIALIZED');return value;}
  if(e.op==='member'){const mask=expression(e.mask,env);if(typeof mask.constant!=='number')throw Error('R8_STATIC_MEMBERSHIP_REQUIRED');return {kind:'bool',constant:Boolean(mask.constant&(1<<e.project))};}
  if(e.op==='if')return branch(expression(e.condition,env),expression(e.then,env),expression(e.else,env));
  if(e.op==='not'){const v=expression(e.value,env);if(typeof v.constant==='boolean')return {kind:'bool',constant:!v.constant};const result=branch(v,literal(0),literal(1));return {...result,kind:'bool'};}
  const a=expression(e.left,env),b=expression(e.right,env);
  if(e.op==='and'||e.op==='or'){if(typeof a.constant==='boolean')return e.op==='and'?(a.constant?b:a):(a.constant?a:b);const result=branch(a,e.op==='and'?b:literal(1),e.op==='and'?literal(0):b);return {...result,kind:'bool'};}
  if(a.constant!==undefined&&b.constant!==undefined){
   const x=Number(a.constant),y=Number(b.constant);
   if(e.op==='add')return literal(x+y);if(e.op==='sub')return literal(x-y);if(e.op==='mul')return literal(x*y);
   const value=e.op==='lt'?x<y:e.op==='lte'?x<=y:e.op==='eq'?x===y:e.op==='gte'?x>=y:x>y;
   return {kind:'bool',constant:value};
  }
  if(e.op==='add'||e.op==='sub'||e.op==='mul')return register({kind:e.op==='sub'?'subtract':e.op==='mul'?'multiply':'add'},{left:id(a),right:id(b)});
  const v=register({kind:'if',comparison:e.op},{left:id(a),right:id(b),whenTrue:id(literal(1)),whenFalse:id(literal(0))});return {...v,kind:'bool'};
 }
 function statements(list:Statement[],initial:Map<string,Value>):Map<string,Value> {
  let env=new Map(initial);
  for(const s of list){
   if(s.op==='set')env.set(s.name,expression(s.value,env));
   else if(s.op==='for')for(let v=s.from;s.step>0?v<s.to:v>s.to;v+=s.step){env.set(s.name,literal(v));env=statements(s.body,env);}
   else{const condition=expression(s.condition,env);if(typeof condition.constant==='boolean'){env=statements(condition.constant?s.then:s.else,env);continue;}
    const yes=statements(s.then,env),no=statements(s.else,env);for(const [name,value]of yes){const other=no.get(name);if(other)env.set(name,branch(condition,value,other));}
   }
  }return env;
 }
 const env=statements(program.body,new Map()),output=env.get(program.output);if(!output)throw Error('R8_LOWERING_OUTPUT');
 const compiled=canonical({schema:'finnor.p1.ssa.v1',registers,outputs:[{key:'mask',register:id(output)}]}),source=canonical(program);
 if(Buffer.byteLength(compiled)>65536)throw Error('R8_P1_COMPILED_BYTE_BOUND');
 const compiledDigest=bytesHash(compiled);
 // The supplied skeleton's lazy branches are represented by P1 SSA memoized
 // registers, not flattened eager host operations.
 return {schema:'finnor.harness-module.v1',id:'module:'+compiledDigest,source,sourceDigest:bytesHash(source),
  compiled,compiledDigest,structureDigest:hash({program,format:'BOUNDED_SSA'}),format:'BOUNDED_SSA',entrypoint:'compute',
  inputKeys:[...INPUT_ORDER],outputs:[{key:'mask',unit:'count',currencyCode:null}],
  bounds:{steps:registers.length,depth:24,bytes:Buffer.byteLength(compiled)},
  runtime:{kind:'REGISTERED_NATIVE_IR',version:P1_VERSION,closureDigest},checks:['R8_STATIC_TYPED_LOOP_UNROLLING','P1_REGISTERED_SEMANTIC_EMISSION'],admission:null,
  typescript:compileTypeScriptModule(compiled,'BOUNDED_SSA')};
}
export function assertLowering(program:IntegerProgram,module:NativeModule,closureDigest=module.runtime.closureDigest):void {
 const expected=lowerProgram(program,closureDigest);
 if(hash(expected)!==hash(module))throw Error('R8_AST_IR_EMITTED_COMPILER_CORRESPONDENCE');
}
