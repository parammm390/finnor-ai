/** R8-exclusive batching; the registered P1 emitter and its limits stay unchanged. */
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {P1_VERSION,type NativeModule} from '../../../private-equity/src/program-synthesis/contracts';
import {compileTypeScriptModule} from '../../../private-equity/src/program-synthesis/typescript';
import {sha,stable} from '../../../private-equity/src/evidence-execution/store';
import {JsonProcess} from './process';
const quote=(value:string)=>JSON.stringify(value);
/** A genuine bounded persistent checker/invocation transport. Generated compute
 * bytes are unchanged; all state is initialized anew by compute for each row. */
export async function openTypeScriptModuleBatch(module:NativeModule,deadlineAt:number,signal?:AbortSignal) {
 const m=module.typescript;
 if(module.runtime.version!==P1_VERSION||sha(module.compiled)!==module.compiledDigest||sha(module.source)!==module.sourceDigest||
  module.id!=='module:'+module.compiledDigest||!m||stable(compileTypeScriptModule(module.compiled,module.format))!==stable(m))throw Error('TYPESCRIPT_REGISTERED_BATCH_EMISSION_MISMATCH');
 // R4's emitter cache does not re-read declaration libraries. R8 must not reuse
 // a compiled preimage after those bytes change. Keep this guard exclusive.
 const librariesRoot=dirname(ts.getDefaultLibFilePath({target:ts.ScriptTarget.ES2022}));
 if(sha(m.compiler.libraries)!==m.compiler.librariesDigest||
  m.compiler.libraries.some(pin=>sha(readFileSync(resolve(librariesRoot,pin.file)))!==pin.sha256))
  throw Error('R8_TYPESCRIPT_LIBRARY_BYTES_CHANGED');
 if(deadlineAt<=Date.now()||deadlineAt-Date.now()>600000)throw Error('TYPESCRIPT_BATCH_ORIGINAL_DEADLINE');
 const parentPid=process.pid;
 const wrapper=m.emitted+`
import {createInterface} from 'node:readline';
const parent=${parentPid},deadline=${Math.floor(deadlineAt)};
const timer=setInterval(()=>{if(process.ppid!==parent||Date.now()>=deadline)process.exit(124);},50);
let frames=0,rows=0;
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 if(Buffer.byteLength(line)>262144||++frames>1024)throw Error('BATCH_FRAME_BOUND');
 const value=JSON.parse(line);
 if(Object.keys(value).sort().join(',')!=='inputs,start'||!Number.isSafeInteger(value.start)||value.start<0||
  !Array.isArray(value.inputs)||value.inputs.length<1||value.inputs.length>4096)throw Error('BATCH_INPUT_SCHEMA');
 const output=[];
 for(const input of value.inputs){
  if(++rows>524288||!input||typeof input!=='object'||Array.isArray(input)||
   Object.keys(input).sort().join(',')!==${quote([...module.inputKeys].sort().join(','))}||
   Object.values(input).some(v=>typeof v!=='string'||v.length>256))throw Error('BATCH_ROW_BOUND');
  output.push(compute(input));
 }
 process.stdout.write(JSON.stringify({start:value.start,outputs:output,moduleDigest:${quote(module.compiledDigest)},emittedDigest:${quote(m.emittedDigest)}})+'\\n');
}
clearInterval(timer);
process.stderr.write('P1_BATCH_USAGE:'+JSON.stringify({rows,frames,cpu:process.cpuUsage(),rss:process.resourceUsage().maxRSS,emittedDigest:${quote(m.emittedDigest)}})+'\\n');
`;
 const directory=await realpath(await mkdtemp(join(tmpdir(),'finnor-p1-batch-'))),script=join(directory,'transport.mjs');
 let child:JsonProcess;
 try{await writeFile(script,wrapper,{mode:0o400});child=await JsonProcess.open({executable:process.execPath,args:['--max-old-space-size=128',script],readPaths:[script],deadlineAt,signal});}
 catch(error){await rm(directory,{recursive:true,force:true});throw error;}
 let invocations=0;
 return {
  identity:{moduleId:module.id,emittedDigest:m.emittedDigest,wrapperDigest:sha(wrapper),compiler:m.compiler},
  async execute(inputs:Record<string,string>[],start:number){
   if(inputs.length<1||inputs.length>4096)throw Error('TYPESCRIPT_BATCH_SIZE');
   const response=await child.request({start,inputs}) as {start:number;outputs:Record<string,string>[];moduleDigest:string;emittedDigest:string};
   if(response.start!==start||response.moduleDigest!==module.compiledDigest||response.emittedDigest!==m.emittedDigest||
    !Array.isArray(response.outputs)||response.outputs.length!==inputs.length||response.outputs.some(output=>
     !output||Object.keys(output).length!==module.outputs.length||module.outputs.some(o=>typeof output[o.key]!=='string'||output[o.key]!.length>2048)))throw Error('TYPESCRIPT_BATCH_OUTPUT_BINDING');
   invocations+=inputs.length;return response.outputs;
  },
  async close(){try{return {...await child.close(),invocations,costUSD:null};}finally{await rm(directory,{recursive:true,force:true});}},
 };
}
