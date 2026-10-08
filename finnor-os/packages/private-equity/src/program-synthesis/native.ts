import {exactBinary,exactCompare,canonicalExact} from '../evidence-execution/exact';
import {sha} from '../evidence-execution/store';
import {P1_VERSION,type NativeModule,type Expression,type Instruction,type Comparison} from './contracts';
export function compareExact(op:Comparison,a:string,b:string):boolean{const c=exactCompare(a,b);switch(op){case 'lt':return c<0;case 'lte':return c<=0;case 'eq':return c===0;case 'gte':return c>=0;case 'gt':return c>0;default:throw Error('BRANCH_COMPARISON_UNAVAILABLE');}}
export function executeNativeModule(module:NativeModule,input:Record<string,string>,meter:()=>void):Record<string,string>{
 if(module.runtime.version!==P1_VERSION||sha(module.compiled)!==module.compiledDigest||sha(module.source)!==module.sourceDigest||module.id!=='module:'+module.compiledDigest)throw Error('EXECUTABLE_MODULE_BYTE_OR_VERSION_MISMATCH');
 if(Buffer.byteLength(module.compiled)>65536||Object.keys(input).some(k=>!module.inputKeys.includes(k)))throw Error('MODULE_INPUT_OR_BYTE_BOUND');
 const body=JSON.parse(module.compiled),outputs:Record<string,string>={};
 const read=(key:string)=>{if(!Object.hasOwn(input,key))throw Error('MATERIAL_INPUT_UNKNOWN');return canonicalExact(input[key]!);};
 const binary=(op:Expression['kind'],a:string,b:string)=>op==='min'?(exactCompare(a,b)<=0?a:b):op==='max'?(exactCompare(a,b)>=0?a:b):exactBinary(op as 'add'|'subtract'|'multiply'|'ratio',a,b);
 if(module.format==='BOUNDED_SSA'){
  if(body.schema!=='finnor.p1.ssa.v1'||!Array.isArray(body.registers)||body.registers.length>256)throw Error('SSA_MODULE_BOUND');const declarations=new Map<string,any>(),cache=new Map<string,string>();
  for(const r of body.registers){if(declarations.has(r.id))throw Error('DUPLICATE_REGISTER');if(!['input','literal'].includes(r.expression.kind)&&(!declarations.has(r.left)||!declarations.has(r.right)))throw Error('NON_TOPOLOGICAL_MODULE');if(r.expression.kind==='if'&&(!declarations.has(r.whenTrue)||!declarations.has(r.whenFalse)))throw Error('NON_TOPOLOGICAL_BRANCH');declarations.set(r.id,r);}
  function evaluate(id:string):string{const cached=cache.get(id);if(cached!==undefined)return cached;const r=declarations.get(id);if(!r)throw Error('UNRESOLVED_REGISTER');meter();const e=r.expression;const value=e.kind==='input'?read(e.key):e.kind==='literal'?canonicalExact(e.value):e.kind==='if'?evaluate(compareExact(e.comparison,evaluate(r.left),evaluate(r.right))?r.whenTrue:r.whenFalse):binary(e.kind,evaluate(r.left),evaluate(r.right));cache.set(id,value);return value;}
  for(const o of body.outputs)outputs[o.key]=evaluate(o.register);
 }else{
  if(body.schema!=='finnor.p1.stack.v1'||!Array.isArray(body.outputs)||body.outputs.length>16)throw Error('STACK_MODULE_BOUND');
  function evaluate(instructions:Instruction[],depth=0):string{const stack:string[]=[];if(!Array.isArray(instructions)||instructions.length>256||depth>12)throw Error('STACK_STEP_OR_DEPTH_BOUND');for(const ins of instructions){meter();if(ins.op==='input')stack.push(read(ins.key));else if(ins.op==='literal')stack.push(canonicalExact(ins.value));else if(ins.op==='branch')stack.push(evaluate(compareExact(ins.comparison,evaluate(ins.left,depth+1),evaluate(ins.right,depth+1))?ins.whenTrue:ins.whenFalse,depth+1));else{const b=stack.pop(),a=stack.pop();if(a===undefined||b===undefined)throw Error('STACK_UNDERFLOW');stack.push(binary(ins.op,a,b));}}if(stack.length!==1)throw Error('STACK_OUTPUT_ARITY');return stack[0]!;}
  for(const o of body.outputs)outputs[o.key]=evaluate(o.instructions);
 }
 if(Object.keys(outputs).length!==module.outputs.length||module.outputs.some(o=>!Object.hasOwn(outputs,o.key)))throw Error('MODULE_OUTPUT_SCHEMA_MISMATCH');return outputs;
}
