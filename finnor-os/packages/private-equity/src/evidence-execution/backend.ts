import * as nativeModule from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {acquireComputeResourceLeases,releaseComputeResourceLeases,renewComputeResourceLeases} from '@finnor/db/compute-governor';
import {codeIdentity,sha} from './store';
// Resolve the child loader with Node. It is a subprocess entrypoint, not an
// ESM import to execute or rewrite inside the API bundle.
const resolveNativeImport=(specifier:string):string=>Reflect.apply(nativeModule.createRequire,undefined,[import.meta.url]).resolve(specifier);
export interface BackendReceipt {invocationId:string;childPid:number|null;codeDigest:string;node:string;route:'FIXED_CREDENTIAL_FREE_NATIVE_CHILD';imageDigest:null;leases:unknown[];wallMs:number;inputBytes:number;outputBytes:number;cpuMicros:number|null;peakRSSBytes:number|null;usd:null;costStatus:'LOCAL_COST_UNMETERED';ocr:{binaryDigest:string;sourceDigest:string}|null;exitCode:number|null;exitSignal:string|null;diagnosticDigest:string|null;diagnosticPredicate:string|null;nativeOperations:unknown[]}
export class NativeFailure extends Error {constructor(public predicate:string,public receipt:BackendReceipt){super(predicate);}}
export async function nativeBackend<T>(tenantId:string,mode:'program'|'document',payload:unknown,deadlineMs=30000,cancelled?:()=>Promise<boolean>,onStarted?:(receipt:BackendReceipt)=>Promise<unknown>):Promise<{data:T;receipt:BackendReceipt}>{
 const code=await codeIdentity(),invocationId=randomUUID(),started=performance.now(),serialized=JSON.stringify({mode,payload});if(Buffer.byteLength(serialized)>8388608)throw Error('NATIVE_INPUT_SERIALIZATION_BOUND');
 const leases=await acquireComputeResourceLeases({tenantId,resourceKeys:['native:p4'],requiredResourceKeys:['native:p4'],workloadClass:'INTERACTIVE',ownerId:'p4:'+invocationId});
 const receipt:BackendReceipt={invocationId,childPid:null,codeDigest:code.digest,node:process.version,route:'FIXED_CREDENTIAL_FREE_NATIVE_CHILD',imageDigest:null,leases,wallMs:0,inputBytes:Buffer.byteLength(serialized),outputBytes:0,cpuMicros:null,peakRSSBytes:null,usd:null,costStatus:'LOCAL_COST_UNMETERED',ocr:null,exitCode:null,exitSignal:null,diagnosticDigest:null,diagnosticPredicate:null,nativeOperations:[]};
 const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',NODE_ENV:'production'};
 if(process.env.FINNOR_P4_OCR_BINARY&&process.env.FINNOR_P4_OCR_SHA256){const actual=sha(await readFile(process.env.FINNOR_P4_OCR_BINARY));if(actual!==process.env.FINNOR_P4_OCR_SHA256){await releaseComputeResourceLeases(leases,'ocr-identity-refused');throw Error('OCR_RUNTIME_IDENTITY_MISMATCH');}env.FINNOR_P4_OCR_BINARY=process.env.FINNOR_P4_OCR_BINARY;env.FINNOR_P4_OCR_SHA256=actual;receipt.ocr={binaryDigest:actual,sourceDigest:sha(await readFile(new URL('./vision-ocr.m',import.meta.url)))};}
 try{return await new Promise((yes,no)=>{
  const child=spawn(process.execPath,['--max-old-space-size=512','--import='+resolveNativeImport('tsx'),fileURLToPath(new URL('./native-child.mts',import.meta.url))],{env,stdio:['pipe','pipe','pipe']});receipt.childPid=child.pid??null;let output='',bytes=0,errorBytes=0,diagnostic='',settled=false,reason:string|null=null;
  const terminate=(predicate:string)=>{if(settled)return;reason=predicate;child.kill('SIGKILL');};
  if(onStarted)void onStarted(receipt).catch(()=>terminate('NATIVE_INVOCATION_START_RECORD_UNAVAILABLE'));
  const timer=setTimeout(()=>terminate('NATIVE_DEADLINE_EXCEEDED'),deadlineMs);
  let checking=false;const poll=setInterval(()=>{if(checking||settled)return;checking=true;Promise.all([renewComputeResourceLeases(leases),cancelled?cancelled():Promise.resolve(false)]).then(([current,cancel])=>{if(!current)terminate('COMPUTE_LEASE_LOST');if(cancel)terminate('CANCELLED_OR_QUERY_FENCED');}).catch(()=>terminate('COMPUTE_OR_QUERY_CURRENTNESS_UNAVAILABLE')).finally(()=>{checking=false;});},200);
  child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>8388608)terminate('NATIVE_OUTPUT_BOUND');else output+=b.toString('utf8');});child.stderr.on('data',(b:Buffer)=>{errorBytes+=b.length;diagnostic+=b.toString('utf8');if(errorBytes>65536)terminate('NATIVE_DIAGNOSTIC_BOUND');});
  child.once('error',()=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);receipt.wallMs=performance.now()-started;no(new NativeFailure('NATIVE_CHILD_START_FAILED',receipt));});
  child.once('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);receipt.wallMs=performance.now()-started;receipt.outputBytes=bytes;receipt.exitCode=code;receipt.exitSignal=signal;receipt.diagnosticDigest=diagnostic?sha(diagnostic):null;receipt.diagnosticPredicate=/heap out of memory|allocation failed/i.test(diagnostic)?'NODE_HEAP_EXHAUSTED':null;
   if(reason||code!==0){no(new NativeFailure(reason??'NATIVE_CHILD_FAILED',receipt));return;}try{const frame=JSON.parse(output);receipt.nativeOperations=Array.isArray(frame.data?.nativeOperations)?frame.data.nativeOperations:[];receipt.cpuMicros=frame.usage?.cpuMicros??null;receipt.peakRSSBytes=frame.usage?.peakRSSBytes??null;if(!frame.ok){no(new NativeFailure(frame.predicate??'NATIVE_PROGRAM_FAILED',receipt));return;}yes({data:frame.data as T,receipt});}catch{no(new NativeFailure('NATIVE_PROTOCOL_INVALID',receipt));}});
  child.stdin.on('error',()=>undefined);child.stdin.end(serialized);
 });}finally{await releaseComputeResourceLeases(leases,'p4-native-finished');}
}
