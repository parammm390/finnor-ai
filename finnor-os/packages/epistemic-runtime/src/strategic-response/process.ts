import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {StrategicIndependentCheck} from '../../../shared-types/src/strategic-response';
import {PROFILE,PROFILE_DIGEST,VERSION,digest,bytesDigest,fail,same} from './contracts';
import emitted from './source-manifest.generated';
import {STRATEGIC_SEMANTIC_FILES} from './source-paths';
export interface StrategicRuntimeIdentity {
 node:string;platform:string;architecture:string;profileDigest:string;semanticCodeDigest:string;checkerDigest:string;
 interpreter:{path:string;sha256:string|null};sourcePins:Array<{path:string;sha256:string}>;entrypointDigest:string|null;
 emittedSemanticCodeDigest:string;assetsMatchEmitted:boolean;
}
export const assetRoot=()=>process.env.FINNOR_Y2_ASSET_ROOT??fileURLToPath(new URL('.',import.meta.url));
export async function strategicRuntimeIdentity():Promise<StrategicRuntimeIdentity>{
 if(process.versions.node.split('.')[0]!=='22')fail('Y2_NODE_22_RUNTIME_REQUIRED',503);
 const sourcePins=await Promise.all(STRATEGIC_SEMANTIC_FILES.map(async path=>({path,sha256:bytesDigest(await readFile(join(assetRoot(),path)))})));
 if(digest(JSON.parse(await readFile(join(assetRoot(),'profile.json'),'utf8')))!==PROFILE_DIGEST)fail('Y2_FROZEN_PROFILE_ASSET_CHANGED',503);
 let interpreterDigest:string|null=null,entrypointDigest:string|null=null;
 try{interpreterDigest=bytesDigest(await readFile('/usr/bin/python3'));}catch{/* Missing checker is UNKNOWN, not infeasibility. */}
 if(process.argv[1])try{entrypointDigest=bytesDigest(await readFile(process.argv[1]));}catch{/* Explicitly unavailable image identity. */}
 return {node:process.version,platform:process.platform,architecture:process.arch,profileDigest:PROFILE_DIGEST,
  semanticCodeDigest:digest({version:VERSION,sourcePins}),checkerDigest:sourcePins.find(p=>p.path==='checker.py')!.sha256,
  interpreter:{path:'/usr/bin/python3',sha256:interpreterDigest},sourcePins,entrypointDigest,
  emittedSemanticCodeDigest:digest({version:VERSION,sourcePins:emitted.files}),assetsMatchEmitted:same(sourcePins,emitted.files)};
}
/** Data-only bounded checker. No inherited credentials, hooks or provider paths. */
export async function checkStrategicResponse(operation:StrategicIndependentCheck['operation'],input:unknown,candidate:unknown,
 deadlineAt:number,expected:StrategicRuntimeIdentity,signal?:AbortSignal):Promise<StrategicIndependentCheck>{
 const unknown=(reason:string):StrategicIndependentCheck=>({schema:'finnor.strategic-independent-check.v1',operation,status:'UNKNOWN',
  reason,executionAuthorityGranted:false,protectedQualification:false});
 const now=await strategicRuntimeIdentity();
 if(!now.assetsMatchEmitted||!expected.assetsMatchEmitted||now.semanticCodeDigest!==expected.semanticCodeDigest||
  now.emittedSemanticCodeDigest!==expected.emittedSemanticCodeDigest||now.checkerDigest!==expected.checkerDigest||
  !same(now.interpreter,expected.interpreter))return unknown('Y2_CHECKER_OR_METHOD_CHANGED');
 const timeout=Math.min(PROFILE.maximumCheckerWallMs,deadlineAt-Date.now());
 if(timeout<=0)return unknown('Y2_ORIGINAL_DEADLINE_EXPIRED');
 const python=process.env.FINNOR_Y2_PYTHON??expected.interpreter.path;
 if(!python.startsWith('/'))return unknown('Y2_ABSOLUTE_INTERPRETER_REQUIRED');
 let interpreterDigest:string;
 try{interpreterDigest=bytesDigest(await readFile(python));}catch{return unknown('Y2_CHECKER_UNAVAILABLE');}
 if(!expected.interpreter.sha256||interpreterDigest!==expected.interpreter.sha256)return unknown('Y2_INTERPRETER_IDENTITY_CHANGED');
 const request=JSON.stringify({operation,input,candidate});
 if(Buffer.byteLength(request)>8*1024*1024)return unknown('Y2_CHECKER_INPUT_BOUND');
 return new Promise(resolve=>{
  const child=spawn(python,['-I',join(assetRoot(),'checker.py')],{cwd:assetRoot(),stdio:['pipe','pipe','pipe'],
   env:{NODE_ENV:'test',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',PYTHONHASHSEED:'0'}});
  let out='',err='',killed:string|null=null,finished=false;
  const stop=(reason:string)=>{killed??=reason;child.kill('SIGKILL');},
   timer=setTimeout(()=>stop('Y2_CHECKER_TIMEOUT'),timeout),abort=()=>stop('Y2_CHECKER_ABORTED');
  const finish=(v:StrategicIndependentCheck)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(v);};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',b=>{out+=String(b);if(Buffer.byteLength(out)>PROFILE.maximumCheckerOutputBytes)stop('Y2_CHECKER_OUTPUT_BOUND');});
  child.stderr.on('data',b=>{err+=String(b);if(Buffer.byteLength(err)>16384)stop('Y2_CHECKER_DIAGNOSTIC_BOUND');});
  child.once('error',()=>finish(unknown('Y2_CHECKER_UNAVAILABLE')));
  child.once('close',code=>{
   if(killed||code!==0)return finish(unknown(killed??'Y2_CHECKER_PROCESS_FAILED'));
   try{
    const v=JSON.parse(out) as StrategicIndependentCheck;
    if(!['CHECKED','REJECTED','UNKNOWN'].includes(v.status)||v.operation!==operation||v.executionAuthorityGranted!==false||
     v.protectedQualification!==false||v.inputDigest!==digest(input)||v.candidateDigest!==digest(candidate)||
     v.profileDigest!==PROFILE_DIGEST||v.checkerDigest!==expected.checkerDigest||v.interpreterDigest!==interpreterDigest||
     typeof v.interpreterVersion!=='string'||!/^3\.\d+\.\d+$/.test(v.interpreterVersion))throw Error();
    finish(v);
   }catch{finish(unknown('Y2_CHECKER_REPLY_UNBOUND_OR_MALFORMED'));}
  });
  child.stdin.on('error',()=>undefined);child.stdin.end(request);
 });
}
