/** Full semantic TypeScript compilation for finite, task-specific modules.
 * Only the registered IR emits source. Caller strings never become host code. */
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha,stable} from '../evidence-execution/store';
import {P1_VERSION,type NativeModule,type TypeScriptModule} from './contracts';
import {launchIsolatedNodeExecutor} from '../../../governed-execution/src/executor';

const runtimeSource=String.raw`
type Decimal = { n: bigint; s: number };
function pow(s:number):bigint { if(!Number.isInteger(s)||s<0||s>512)throw Error('DECIMAL_EXPONENT_BOUND');return 10n**BigInt(s); }
function parse(v:string):Decimal {
 if(typeof v!=='string'||v.length>256||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d{1,3})?$/.test(v))throw Error('EXACT_DECIMAL_REQUIRED');
 const [mantissa,exp='0']=v.split(/[eE]/);const exponent=Number(exp);if(Math.abs(exponent)>100)throw Error('DECIMAL_EXPONENT_BOUND');
 const negative=mantissa!.startsWith('-'),clean=mantissa!.replace(/^[-+]/,''),[whole,fraction='']=clean.split('.');
 let n=BigInt((whole||'0')+fraction)*(negative?-1n:1n),s=fraction.length-exponent;
 if(s<0){n*=pow(-s);s=0;}while(s>0&&n%10n===0n){n/=10n;s--;}return {n,s};
}
function format(v:Decimal):string {
 let {n,s}=v;while(s>0&&n%10n===0n){n/=10n;s--;}const negative=n<0n;n=negative?-n:n;let digits=n.toString();
 if(digits.length+s>2048)throw Error('DECIMAL_OUTPUT_BOUND');if(s){digits=digits.padStart(s+1,'0');digits=digits.slice(0,-s)+'.'+digits.slice(-s);}return (negative?'-':'')+digits;
}
function read(input:Readonly<Record<string,string>>,key:string):string { if(!Object.hasOwn(input,key))throw Error('MATERIAL_INPUT_UNKNOWN');return format(parse(input[key]!)); }
function compare(op:'lt'|'lte'|'eq'|'gte'|'gt',a:string,b:string):boolean {const x=parse(a),y=parse(b),s=Math.max(x.s,y.s),d=x.n*pow(s-x.s)-y.n*pow(s-y.s);switch(op){case 'lt':return d<0n;case 'lte':return d<=0n;case 'eq':return d===0n;case 'gte':return d>=0n;case 'gt':return d>0n;}}
function binary(op:'add'|'subtract'|'multiply'|'ratio'|'min'|'max',a:string,b:string):string {
 const x=parse(a),y=parse(b),s=Math.max(x.s,y.s);
 if(op==='min'||op==='max'){const d=x.n*pow(s-x.s)-y.n*pow(s-y.s);return op==='min'?(d<=0n?a:b):(d>=0n?a:b);}
 if(op==='multiply')return format({n:x.n*y.n,s:x.s+y.s});
 if(op==='add'||op==='subtract')return format({n:x.n*pow(s-x.s)+(op==='add'?1n:-1n)*y.n*pow(s-y.s),s});
 if(y.n===0n)throw Error('ZERO_DENOMINATOR');const n=x.n*pow(y.s+18),denominator=y.n*pow(x.s);
 if(n%denominator!==0n)throw Error('NON_TERMINATING_RATIO_AT_DECLARED_PRECISION');return format({n:n/denominator,s:18});
}
`;
const cache=new Map<string,TypeScriptModule>();
const quote=(v:string)=>JSON.stringify(v);
const safeKey=(v:unknown):string=>{if(typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v))throw Error('TYPESCRIPT_IR_KEY_INVALID');return v;};
const safeOperator=(v:unknown):string=>{if(typeof v!=='string'||!['add','subtract','multiply','ratio','min','max'].includes(v))throw Error('TYPESCRIPT_IR_OPERATOR_INVALID');return v;};
const safeComparison=(v:unknown):string=>{if(typeof v!=='string'||!['lt','lte','eq','gte','gt'].includes(v))throw Error('TYPESCRIPT_IR_COMPARISON_INVALID');return v;};
export function compileTypeScriptModule(compiled:string,format:NativeModule['format']):TypeScriptModule {
 if(Buffer.byteLength(compiled)>65536)throw Error('TYPESCRIPT_IR_BYTE_BOUND');const body=JSON.parse(compiled),lines:string[]=[],keys:string[]=[];
 if(format==='BOUNDED_SSA'){
  if(body.schema!=='finnor.p1.ssa.v1'||!Array.isArray(body.registers)||body.registers.length>256||!Array.isArray(body.outputs)||body.outputs.length>16)throw Error('TYPESCRIPT_SSA_BOUND');
  const declared=new Set<string>();lines.push('const cached=new Map<string,string>();','function memo(key:string,fn:()=>string):string {const v=cached.get(key);if(v!==undefined)return v;const next=fn();cached.set(key,next);return next;}');
  for(const r of body.registers){const id=safeKey(r.id);if(!/^r\d+$/.test(id)||declared.has(id))throw Error('TYPESCRIPT_REGISTER_INVALID');const e=r.expression;let code:string;
   if(e.kind==='input')code=`read(input,${quote(safeKey(e.key))})`;else if(e.kind==='literal'){if(typeof e.value!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(e.value)||e.value.length>96)throw Error('TYPESCRIPT_LITERAL_INVALID');code=`format(parse(${quote(e.value)}))`;}
   else {if(!declared.has(r.left)||!declared.has(r.right))throw Error('TYPESCRIPT_NON_TOPOLOGICAL_IR');
    if(e.kind==='if'){if(!declared.has(r.whenTrue)||!declared.has(r.whenFalse))throw Error('TYPESCRIPT_NON_TOPOLOGICAL_BRANCH');code=`compare(${quote(safeComparison(e.comparison))},${r.left}(),${r.right}())?${r.whenTrue}():${r.whenFalse}()`;}
    else code=`binary(${quote(safeOperator(e.kind))},${r.left}(),${r.right}())`;
   }
   lines.push(`function ${id}():string {return memo(${quote(id)},()=>(${code}));}`);declared.add(id);
  }
  for(const o of body.outputs){const key=safeKey(o.key);if(!declared.has(o.register)||keys.includes(key))throw Error('TYPESCRIPT_OUTPUT_INVALID');keys.push(key);lines.push(`output[${quote(key)}]=${o.register}();`);}
 }else if(format==='BOUNDED_STACK'){
  if(body.schema!=='finnor.p1.stack.v1'||!Array.isArray(body.outputs)||body.outputs.length>16)throw Error('TYPESCRIPT_STACK_BOUND');let serial=0,total=0;
  function lower(instructions:any[],depth=0):string{
   if(!Array.isArray(instructions)||instructions.length>256||depth>12)throw Error('TYPESCRIPT_STACK_BOUND');const stack:string[]=[],local:string[]=[];
   for(const ins of instructions){if(++total>1024)throw Error('TYPESCRIPT_STACK_EXPANSION_BOUND');const id='s'+serial++;let code:string;
    if(ins.op==='input')code=`read(input,${quote(safeKey(ins.key))})`;else if(ins.op==='literal'){if(typeof ins.value!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(ins.value)||ins.value.length>96)throw Error('TYPESCRIPT_LITERAL_INVALID');code=`format(parse(${quote(ins.value)}))`;}
    else if(ins.op==='branch')code=`compare(${quote(safeComparison(ins.comparison))},${lower(ins.left,depth+1)},${lower(ins.right,depth+1)})?${lower(ins.whenTrue,depth+1)}:${lower(ins.whenFalse,depth+1)}`;
    else{const b=stack.pop(),a=stack.pop();if(!a||!b)throw Error('TYPESCRIPT_STACK_UNDERFLOW');code=`binary(${quote(safeOperator(ins.op))},${a},${b})`;}
    local.push(`const ${id}:string=(${code});`);stack.push(id);
   }
   if(stack.length!==1)throw Error('TYPESCRIPT_STACK_ARITY');return `(()=>{${local.join('\n')}return ${stack[0]};})()`;
  }
  for(const o of body.outputs){const key=safeKey(o.key);if(keys.includes(key))throw Error('TYPESCRIPT_STACK_OUTPUT_INVALID');keys.push(key);lines.push(`output[${quote(key)}]=${lower(o.instructions)};`);}
 }else throw Error('TYPESCRIPT_MODULE_FORMAT_INVALID');
 const source=`// Finite module IR sha256:${sha(compiled)}\n${runtimeSource}\nexport function compute(input:Readonly<Record<string,string>>):Record<string,string> {\nconst output:Record<string,string>={};\n${lines.join('\n')}\nreturn output;\n}\n`,sourceDigest=sha(source),cached=cache.get(sourceDigest);if(cached)return structuredClone(cached);
 const file=resolve('finnor-p1.generated.ts'),options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,lib:['lib.es2022.d.ts'],types:[],strict:true,noUncheckedIndexedAccess:true,noEmitOnError:true,skipLibCheck:false};
 const host=ts.createCompilerHost(options),getSourceFile=host.getSourceFile.bind(host),fileExists=host.fileExists.bind(host),readFile=host.readFile.bind(host);let emitted='';
 host.getSourceFile=(name,language,onError,shouldCreate)=>name===file?ts.createSourceFile(name,source,language,true):getSourceFile(name,language,onError,shouldCreate);
 host.fileExists=name=>name===file||fileExists(name);host.readFile=name=>name===file?source:readFile(name);host.writeFile=(name,data)=>{if(name.endsWith('.js'))emitted=data;};
 const program=ts.createProgram([file],options,host),diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({code:d.code,category:ts.DiagnosticCategory[d.category],file:d.file?.fileName??null,start:d.start??null,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
 const emission=program.emit();diagnostics.push(...emission.diagnostics.map(d=>({code:d.code,category:ts.DiagnosticCategory[d.category],file:d.file?.fileName??null,start:d.start??null,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')})));
 if(diagnostics.length||emission.emitSkipped||!emitted)throw Error('TYPESCRIPT_SEMANTIC_DIAGNOSTICS_UNPASSED');
 const libraries=program.getSourceFiles().filter(f=>f.fileName!==file).map(f=>({file:f.fileName.split('/').pop()!,sha256:sha(readFileSync(f.fileName))})).sort((a,b)=>a.file.localeCompare(b.file));
 const result:TypeScriptModule={source,sourceDigest,emitted,emittedDigest:sha(emitted),irDigest:sha(compiled),compiler:{name:'typescript',version:ts.version,optionsDigest:sha(options),libraries,librariesDigest:sha(libraries)},diagnostics};
 if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(sourceDigest,result);return structuredClone(result);
}
export async function executeTypeScriptModule(module:NativeModule,input:Record<string,string>,remainingMs:number){
 if(module.runtime.version!==P1_VERSION||sha(module.compiled)!==module.compiledDigest||sha(module.source)!==module.sourceDigest||module.id!=='module:'+module.compiledDigest)throw Error('EXECUTABLE_MODULE_BYTE_OR_VERSION_MISMATCH');
 const m=module.typescript;if(!m||m.compiler.version!==ts.version||sha(m.source)!==m.sourceDigest||sha(m.emitted)!==m.emittedDigest||m.irDigest!==module.compiledDigest||sha(m.compiler.libraries)!==m.compiler.librariesDigest||m.diagnostics.length)throw Error('TYPESCRIPT_SELECTED_BYTE_OR_COMPILER_MISMATCH');
 // A caller-rehashed manifest is not evidence of semantic compilation. Rebuild
 // the registered finite emission and compare its exact source/compiler bytes.
 if(stable(compileTypeScriptModule(module.compiled,module.format))!==stable(m))throw Error('TYPESCRIPT_REGISTERED_EMISSION_MISMATCH');
 if(!Number.isFinite(remainingMs)||remainingMs<1)throw Error('ORIGINAL_EPISODE_DEADLINE_EXHAUSTED');
 const script=m.emitted+`\nimport {readFileSync} from 'node:fs';\nconst supplied=JSON.parse(readFileSync(0,'utf8'));\nprocess.stdout.write(JSON.stringify({outputs:compute(supplied),moduleDigest:${quote(module.compiledDigest)},emittedDigest:${quote(m.emittedDigest)}}));\n`;
 const execution=await launchIsolatedNodeExecutor({script,input,wallTimeMs:Math.min(10000,Math.floor(remainingMs)),protectedExecution:false});let outputs:Record<string,string>|null=null;
 if(execution.exitCode===0&&execution.termination==='EXITED'){
  let raw:unknown;try{raw=JSON.parse(execution.stdout);}catch{throw Error('TYPESCRIPT_EXECUTOR_OUTPUT_INVALID');}
  const value=raw as {outputs?:unknown;moduleDigest?:unknown;emittedDigest?:unknown};if(value?.moduleDigest!==module.compiledDigest||value.emittedDigest!==m.emittedDigest||!value.outputs||typeof value.outputs!=='object'||Array.isArray(value.outputs))throw Error('TYPESCRIPT_EXECUTOR_OUTPUT_BINDING_INVALID');
  const entries=Object.entries(value.outputs);if(entries.length!==module.outputs.length||entries.some(([key,v])=>!module.outputs.some(o=>o.key===key)||typeof v!=='string'||v.length>2048))throw Error('TYPESCRIPT_EXECUTOR_OUTPUT_SCHEMA_INVALID');outputs=value.outputs as Record<string,string>;
 }
 return {invocationId:randomUUID(),owner:'S6',operation:'P1_TYPESCRIPT_MODULE',moduleId:module.id,sourceDigest:m.sourceDigest,emittedDigest:m.emittedDigest,scriptDigest:sha(script),compiler:m.compiler,execution,outputs,costUSD:null,qualification:'LOCAL_ISOLATED_OUTPUT_REQUIRES_INDEPENDENT_OWNER_CHECK'};
}
