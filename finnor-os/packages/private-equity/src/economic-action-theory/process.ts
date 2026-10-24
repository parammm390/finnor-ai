import {spawn} from 'node:child_process';
import {readFile,open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {PROFILE,PROFILE_DIGEST,Y1_VERSION,byteDigest,digest,fail,type IndependentCheck,type RuntimeIdentity,type EconomicProblem,type EconomicTheoryBody} from './contracts';
export const assetRoot=()=>process.env.FINNOR_Y1_ASSET_ROOT??fileURLToPath(new URL('.',import.meta.url));
const semanticFiles=['contracts.ts','finite.ts','compiler.ts','constructor-process.ts','constructor-thread.mjs','constructor.generated.mjs','process.ts','checker.py','profile.json','store.ts','api.ts','worker.ts','programme-worker.ts',
 '../types.ts','../economic-allocation.ts','../economic-control.ts','../economic-obligations.ts','../economic-observation.ts',
 '../program-synthesis/economic-module.ts','../program-synthesis/economic-plan.ts','../program-synthesis/economic-query.ts',
 '../program-synthesis/economic-native.ts',
 '../allocation-store.ts','../../../capability-evolution/src/economic-theory-port.ts',
 '../../../db/migrations/0195a_postx_y1_temporal_binding.sql'];
const fileDigests=new Map<string,{stamp:string;sha256:string}>();
async function unchangedFileDigest(path:string){
 const fd=await open(path,'r');
 try{
  const before=await fd.stat(),stamp=[before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(':');
  const cached=fileDigests.get(path);if(cached?.stamp===stamp)return cached.sha256;
  const bytes=await fd.readFile(),after=await fd.stat();
  if(stamp!==[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':'))fail('Y1_RUNTIME_ASSET_CHANGED');
  const sha256=byteDigest(bytes);fileDigests.set(path,{stamp,sha256});return sha256;
 }finally{await fd.close();}
}
export async function runtimeIdentity():Promise<RuntimeIdentity>{
 if(process.versions.node.split('.')[0]!=='22')fail('Y1_NODE_22_RUNTIME_REQUIRED',503);
 const sourcePins=await Promise.all(semanticFiles.map(async path=>({path,sha256:await unchangedFileDigest(join(assetRoot(),path))})));
 if(digest(JSON.parse(await readFile(join(assetRoot(),'profile.json'),'utf8')))!==PROFILE_DIGEST)fail('Y1_FROZEN_PROFILE_ASSET_CHANGED',503);
 let entrypointDigest:string|null=null;
 if(process.argv[1])try{entrypointDigest=await unchangedFileDigest(process.argv[1]);}catch{/* Runtime image identity remains explicitly unavailable. */}
 let interpreterDigest:string|null=null;
 try{interpreterDigest=await unchangedFileDigest('/usr/bin/python3');}catch{/* Availability is an UNKNOWN check, never infeasibility. */}
 return {node:process.version,platform:process.platform,architecture:process.arch,profileDigest:PROFILE_DIGEST,
  checkerInterpreter:{path:'/usr/bin/python3',sha256:interpreterDigest},
  checkerDigest:sourcePins.find(p=>p.path==='checker.py')!.sha256,semanticCodeDigest:digest({version:Y1_VERSION,sourcePins}),entrypointDigest,sourcePins};
}
/** A data-only independent process. Ambient credentials, loader hooks, paths and
 * provider configuration are not inherited. The oracle imposes OS rlimits. */
export async function independentlyCheck(problem:EconomicProblem,candidate:EconomicTheoryBody|null,deadlineAt:number,
 expected:RuntimeIdentity,signal?:AbortSignal):Promise<IndependentCheck>{
 const current=await runtimeIdentity();
 if(current.semanticCodeDigest!==expected.semanticCodeDigest||current.checkerDigest!==expected.checkerDigest)fail('Y1_CHECKER_OR_SEMANTIC_SOURCE_CHANGED');
 const request=JSON.stringify({operation:candidate?'CHECK':'INFEASIBLE',problem,candidate,profile:PROFILE});
 if(Buffer.byteLength(request)>8*1024*1024)fail('Y1_CHECKER_INPUT_BOUND');
 const timeout=Math.min(PROFILE.maxCheckerWallMs,deadlineAt-Date.now());if(timeout<=0)fail('Y1_ORIGINAL_DEADLINE_EXPIRED');
 const python=process.env.FINNOR_Y1_PYTHON??expected.checkerInterpreter.path;
 const unknown=(reason:string):IndependentCheck=>({schema:'finnor.economic-theory-check.v1',status:'UNKNOWN',reason,interpreterPath:python,executionAuthorityGranted:false});
 if(!python.startsWith('/'))return unknown('ABSOLUTE_CHECKER_INTERPRETER_REQUIRED');
 let interpreterDigest:string;
 try{interpreterDigest=byteDigest(await readFile(python));}catch{return unknown('CHECKER_PROCESS_UNAVAILABLE');}
 if(!expected.checkerInterpreter.sha256||interpreterDigest!==expected.checkerInterpreter.sha256)return unknown('CHECKER_INTERPRETER_CHANGED');
 return new Promise<IndependentCheck>((resolve)=>{
  const child=spawn(python,['-I',join(assetRoot(),'checker.py')],{stdio:['pipe','pipe','pipe'],
   env:{NODE_ENV:'test',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',PYTHONHASHSEED:'0'},cwd:assetRoot()});
  let out='',err='',finished=false,killed:string|null=null;
  const stop=(reason:string)=>{killed??=reason;child.kill('SIGKILL');};
  const timer=setTimeout(()=>stop('CHECKER_TIMEOUT'),timeout),abort=()=>stop('CHECKER_ABORTED');
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',b=>{out+=String(b);if(Buffer.byteLength(out)>PROFILE.maxCheckerOutputBytes)stop('CHECKER_OUTPUT_BOUND');});
  child.stderr.on('data',b=>{err+=String(b);if(Buffer.byteLength(err)>16384)stop('CHECKER_DIAGNOSTIC_BOUND');});
  const finish=(result:IndependentCheck)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(result);};
  child.once('error',()=>finish({schema:'finnor.economic-theory-check.v1',status:'UNKNOWN',reason:'CHECKER_PROCESS_UNAVAILABLE',executionAuthorityGranted:false}));
  child.once('close',code=>{
   if(killed||code!==0)return finish({schema:'finnor.economic-theory-check.v1',status:'UNKNOWN',reason:killed??'CHECKER_PROCESS_FAILED',executionAuthorityGranted:false});
   try{
    const check=JSON.parse(out) as IndependentCheck;
    if(!['CHECKED','INFEASIBLE','REJECTED','INCOMPLETE','UNKNOWN'].includes(check.status)||check.executionAuthorityGranted!==false)throw Error();
    if(['CHECKED','INFEASIBLE'].includes(check.status)&&(check.problemDigest!==digest(problem)||check.profileDigest!==PROFILE_DIGEST||
     check.interpreterExecutableDigest!==interpreterDigest||typeof check.interpreterVersion!=='string'||!/^3\.\d+\.\d+$/.test(check.interpreterVersion)||
     check.checkerDigest!==expected.checkerDigest||candidate&&check.candidateDigest!==digest(candidate)))throw Error();
    finish({...check,interpreterPath:python});
   }catch{finish({schema:'finnor.economic-theory-check.v1',status:'UNKNOWN',reason:'CHECKER_REPLY_UNBOUND_OR_MALFORMED',executionAuthorityGranted:false});}
  });
  child.stdin.on('error',()=>undefined);child.stdin.end(request);
 });
}
