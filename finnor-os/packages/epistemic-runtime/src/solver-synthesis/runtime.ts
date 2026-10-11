import {readFile,realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
import {bytesHash,hash,type RuntimeIdentity,type SourcePin} from './contracts';

export const scientificPath=(name:string)=>fileURLToPath(new URL('./'+name,import.meta.url));
export const R8_SOURCE_PATHS=[
 './contracts.ts','./grammar.ts','./lowering.ts','./runtime.ts','./checker.ts','./producer.ts','./engine.rkt','./reference.py','./supervise.py',
 './process.ts','./emitted.ts',
 '../../../private-equity/src/program-synthesis/contracts.ts','../../../private-equity/src/program-synthesis/typescript.ts',
 '../../../private-equity/src/program-synthesis/native.ts','../../../private-equity/src/evidence-execution/exact.ts',
 '../../../private-equity/src/evidence-execution/store.ts',
 '../../../governed-execution/src/protocol.ts',
 '../../../../package-lock.json',
].map(path=>fileURLToPath(new URL(path,import.meta.url))).concat(createRequire(import.meta.url).resolve('typescript'));
export async function sourceIdentity():Promise<SourcePin[]> {
 return Promise.all(R8_SOURCE_PATHS.map(async path=>({path,sha256:bytesHash(await readFile(path))})));
}
export async function assertSourceIdentity(pins:readonly SourcePin[]) {
 if(pins.length!==R8_SOURCE_PATHS.length||new Set(pins.map(p=>p.path)).size!==pins.length||hash(pins)!==hash(await sourceIdentity()))throw Error('R8_LOADED_SOURCE_CLOSURE_CHANGED');
}
export async function loadRuntime():Promise<RuntimeIdentity> {
 const path=process.env.FINNOR_R8_RUNTIME_MANIFEST;
 if(!path)throw Error('R8_PINNED_SCIENTIFIC_RUNTIME_UNAVAILABLE');
 const bytes=await readFile(path);if(bytes.length>16*1024*1024)throw Error('R8_RUNTIME_MANIFEST_BOUND');
 const runtime=JSON.parse(bytes.toString()) as RuntimeIdentity;
 if(runtime.schema!=='finnor.r8.scientific-runtime.v1'||runtime.platform!==process.platform||runtime.architecture!==process.arch||
  runtime.rosette.commit!=='373c8c35e4a7667f38fce10cf0b74ae17de07f1d'||runtime.node.version!==process.version||
  !Array.isArray(runtime.inventory)||runtime.inventory.length>100000||hash(runtime.inventory)!==runtime.inventoryDigest||
  !runtime.licenses.length||runtime.solver.options.join(',')!=='-smt2,-in,:timeout=40000,:random-seed=0,current-bitwidth=#f')throw Error('R8_RUNTIME_IDENTITY_INVALID');
 if(await realpath(runtime.node.path)!==await realpath(process.execPath))throw Error('R8_ACTUAL_NODE_RUNTIME_SUBSTITUTED');
 for(const executable of [runtime.node,runtime.python,runtime.racket,runtime.solver])if(bytesHash(await readFile(executable.path))!==executable.sha256)throw Error('R8_EXECUTABLE_BYTES_CHANGED');
 // Check the actual transitive bytes once per acceptance/use, not only a declared
 // package name. Full checking costs are retained, not hidden as warm reuse.
 for(let start=0;start<runtime.inventory.length;start+=16)await Promise.all(runtime.inventory.slice(start,start+16).map(async pin=>{
  if(!pin.path.startsWith('/')||!Number.isSafeInteger(pin.bytes)||pin.bytes<0||pin.bytes>128*1024*1024)throw Error('R8_RUNTIME_PIN_INVALID');
  const st=await stat(pin.path);if(!st.isFile()||st.size!==pin.bytes||bytesHash(await readFile(pin.path))!==pin.sha256)throw Error('R8_TRANSITIVE_RUNTIME_CHANGED');
 }));
 return runtime;
}
export function runtimeReadPaths(runtime:RuntimeIdentity):string[] {
 const roots=new Set<string>([dirname(dirname(runtime.racket.path)),dirname(dirname(runtime.python.path)),runtime.userHome]);
 for(const path of runtime.inventory.map(p=>p.path)){
  if(path.includes('/rosette/'))roots.add(path.slice(0,path.indexOf('/rosette/')+8));
  if(path.includes('/cpython-')){const end=path.indexOf('/',path.indexOf('/cpython-')+1);if(end>0)roots.add(path.slice(0,end));}
 }
 return [...roots];
}
