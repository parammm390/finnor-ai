import {constants} from 'node:fs';
import {readFile,writeFile,open,mkdir,lstat,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ExperimentRef} from '@finnor/shared-types';
import type {R2CheckReceipt,R2Encoding,R2OriginalProblem,R2Request,RationalMILP} from '@finnor/shared-types/src/robust-programme-search';
import {R2_VERSION} from '@finnor/shared-types/src/robust-programme-search';
import {canonicalJson} from '../../../epistemic-runtime/src/source-precedence';
import {r2Lp} from '../../../epistemic-runtime/src/r2-encoding';
import {m3Hash,CapitalProgramV2Error} from './v2-contracts';
import {m3Remaining} from './v2-budget';

export const r2Repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
const checkerPath=join(r2Repository,'finnor-os/packages/epistemic-runtime/python/r2_check.py');
const supervisorPath=join(r2Repository,'finnor-os/packages/epistemic-runtime/python/r2_supervise.py');
const completionPath=join(r2Repository,'finnor-os/packages/epistemic-runtime/python/r2_complete.py');
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function binaryDigest(path:string){
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const before=await fd.stat();if(!before.isFile())refuse('Scientific identity is not a regular file');
  const hash=createHash('sha256'),buffer=Buffer.alloc(1048576);let offset=0;
  for(;;){const {bytesRead}=await fd.read(buffer,0,buffer.length,offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
  const after=await fd.stat();if(offset!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)refuse('Scientific identity changed while hashing');return hash.digest('hex');
 }finally{await fd.close();}
}
export const r2Ref=(kind:string,body:unknown,owner='R2'):ExperimentRef=>{const contentDigest=m3Hash(body);return {owner,id:`${kind}:${contentDigest}`,version:R2_VERSION,contentDigest};};
const refuse=(message:string):never=>{throw new CapitalProgramV2Error('CHECK_FAILED',message);};
export interface R2RuntimeManifest {
 schema:'finnor.r2.native-runtime.v1';scipCommit:string;viprCommit:string;soplexCommit:string;
 configuration:{exact:true;presolve:false;cuts:false;threads:1};
 files:Array<{path:string;sha256:string}>;licenses:Array<{component:string;path:string;sha256:string;license:string}>;
 build:{platform:string;architecture:string;compiler:string;cmake:string;startedAt:string|null;finishedAt:string|null;money:null;costStatus:'UNMETERED'};
}
export interface R2Runtime {root:string;scip:string;vipr:string;python:string;manifest:R2RuntimeManifest;ref:ExperimentRef;
 checkerIdentity:Array<{path:string;sha256:string}>}
async function boundedFile(path:string,maximum=8388608):Promise<string>{
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await fd.stat();if(!st.isFile()||st.size>maximum)refuse('R2 artifact byte or regular-file predicate failed');
  const bytes=await fd.readFile();if(bytes.length!==st.size||(await fd.stat()).mtimeMs!==st.mtimeMs)refuse('R2 artifact changed during read');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 }finally{await fd.close();}
}
export const readR2Artifact=boundedFile;
export async function loadR2Runtime():Promise<R2Runtime>{
 const configured=process.env.FINNOR_R2_RUNTIME,configuredPython=process.env.FINNOR_R2_PYTHON;
 if(!configured||!configuredPython)throw new CapitalProgramV2Error('CONFIGURATION_REQUIRED','Pinned exact solver/checker runtime and Python interpreter are not configured');
 const root=resolve(configured),python=await realpath(configuredPython);if(await realpath(root)!==root)refuse('R2 runtime symbolic ancestor differs');
 const manifest=JSON.parse(await boundedFile(join(root,'manifest.json'),262144)) as R2RuntimeManifest;
 if(manifest.schema!=='finnor.r2.native-runtime.v1'||manifest.scipCommit!=='0c80fdd8e91d7d9f23c0c7a55b68884209d5f27c'||
  manifest.viprCommit!=='30f2951d1e90e47afa821bdd1b12b82246656c42'||manifest.soplexCommit!=='2207cfb274dbce5c2644911dd621438535733607'||
  canonicalJson(manifest.configuration)!==canonicalJson({exact:true,presolve:false,cuts:false,threads:1}))refuse('R2 scientific runtime pin or configuration differs');
 const resolvedInventory=[];for(const file of [...manifest.files,...manifest.licenses]){
  if(!/^[a-zA-Z0-9_./+-]+$/.test(file.path)||file.path.split('/').includes('..')||file.path.startsWith('/')||!/^[a-f0-9]{64}$/.test(file.sha256))refuse('R2 runtime inventory path differs');
  const path=await realpath(join(root,file.path));if(!path.startsWith(root+'/'))refuse('R2 runtime dependency alias escaped its pinned root');
  if(await binaryDigest(path)!==file.sha256)refuse('R2 runtime binary, dependency or license changed');resolvedInventory.push({path:file.path,resolvedPath:path.slice(root.length+1),sha256:file.sha256});
 }
 if(!['bin/scip','bin/viprchk'].every(path=>manifest.files.some(f=>f.path===path)))refuse('R2 native executable inventory absent');
 const checkerIdentity=await Promise.all([checkerPath,supervisorPath,completionPath].map(async path=>({path:path.slice(r2Repository.length+1),sha256:sha(await readFile(path))})));
 return {root,scip:join(root,'bin/scip'),vipr:join(root,'bin/viprchk'),python,manifest,
  ref:r2Ref('native-runtime',{manifest,resolvedInventory,checkerIdentity,pythonSha256:await binaryDigest(python),nodeSha256:await binaryDigest(await realpath(process.execPath)),platform:process.platform,architecture:process.arch}),checkerIdentity};
}
export interface PhysicalReceipt {schema:'finnor.r2.physical-child.v1';pid:number;exitCode:number|null;termination:string;physicalExitObserved:boolean;
 wallMs:number;cpuMs:number;peakMemoryBytes:number;aggregatePeakMemoryBytes:number;memoryAccountingScope:string;upstreamMemoryReservationBytes:number;originalDeadlineAtMs:number;cpuReservationMs:number;memoryReservationMiB:number;money:null;moneyStatus:'UNMETERED'}
export async function coalitionCheckerIdentity(){
 const script=join(r2Repository,'finnor-os/scripts/r5/reference.py');
 const dependency=join(r2Repository,'finnor-os/scripts/r5/canonical_allocation.py');
 return {path:script.slice(r2Repository.length+1),sha256:await binaryDigest(script),
  dependencies:[{path:dependency.slice(r2Repository.length+1),sha256:await binaryDigest(dependency)}]};
}
export class R2NativeSession {
 private coalitionCheckerIdentity:{path:string;sha256:string}|null=null;
 bindCoalitionChecker(identity:{path:string;sha256:string}):void{
  if(this.coalitionCheckerIdentity&&canonicalJson(this.coalitionCheckerIdentity)!==canonicalJson(identity))
   refuse('Original coalition checker cannot be rebound');
  this.coalitionCheckerIdentity={...identity};
 }
 readonly receipts:Array<PhysicalReceipt&{phase:string;ref:ExperimentRef}>=[];
 private cpuUsed=0;private live:ReturnType<typeof spawn>|null=null;private calls=0;private parentPeak=process.memoryUsage().rss;
 get aggregatePeakMemoryBytes(){return Math.max(this.upstreamMemoryReservationBytes+this.parentPeak+Math.max(0,...this.receipts.map(r=>r.peakMemoryBytes)),...this.receipts.map(r=>r.aggregatePeakMemoryBytes));}
 private readonly parentCpu=process.cpuUsage();
 get chargedCpuMs(){const parent=process.cpuUsage(this.parentCpu);return this.cpuUsed+(parent.user+parent.system)/1000;}
 constructor(readonly runtime:R2Runtime,readonly directory:string,readonly deadlineAt:number,readonly caps:R2Request['budget'],readonly checkpoint:()=>Promise<void>,
    readonly onPhysical?:(event:{state:'INTENT'|'STARTED'|'EXITED'|'UNKNOWN';phase:string;invocationId:string;supervisorPid:number|null;receipt:PhysicalReceipt|null})=>Promise<void>,
    readonly heartbeat:()=>Promise<void>=checkpoint,readonly initialCpuMs=0,readonly upstreamMemoryReservationBytes=0){this.cpuUsed=initialCpuMs;}
 async cancel():Promise<void>{const child=this.live;if(!child)return;child.kill('SIGTERM');await new Promise<void>(yes=>{if(child.exitCode!==null||child.signalCode!==null)return yes();child.once('close',()=>yes());});}
 private async run(phase:string,argv:string[],input='',node=false,workingDirectory=this.directory):Promise<{stdout:string;stdoutPath:string;receipt:PhysicalReceipt;ref:ExperimentRef}>{
  await this.heartbeat();if(this.calls>=this.caps.maxNativeCalls||this.chargedCpuMs>=this.caps.cpuMs)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','R2 original aggregate native/parent CPU/call grant exhausted');
  if(process.memoryUsage().rss+this.upstreamMemoryReservationBytes>=this.caps.memoryMiB*1048576)
   throw new CapitalProgramV2Error('LIMIT_EXCEEDED','R2 original aggregate owner/native memory grant exhausted');
  const id=randomUUID(),base=join(workingDirectory,`${this.calls++}-${phase}-${id}`),stdoutPath=base+'.stdout',stderrPath=base+'.stderr',receiptPath=base+'.receipt.json';
  await this.onPhysical?.({state:'INTENT',phase,invocationId:id,supervisorPid:null,receipt:null});
  const config={argv,cwd:workingDirectory,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC',HOME:workingDirectory,TMPDIR:workingDirectory},input,node,
    deadlineAtMs:Math.min(this.deadlineAt,Date.now()+m3Remaining()),cpuMs:Math.max(1,Math.floor(this.caps.cpuMs-this.chargedCpuMs)),memoryMiB:this.caps.memoryMiB,
    outputBytes:this.caps.maxProofBytes,stdoutPath,stderrPath,receiptPath,upstreamMemoryReservationBytes:this.upstreamMemoryReservationBytes};
  const child=spawn(this.runtime.python,[supervisorPath],{cwd:this.directory,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC',NODE_ENV:'development'}});this.live=child;
  const exited=new Promise<void>((yes,no)=>{child.once('error',no);child.once('close',()=>yes());});
  child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>undefined);child.stdin.end(JSON.stringify(config));
  await this.onPhysical?.({state:'STARTED',phase,invocationId:id,supervisorPid:child.pid??null,receipt:null});
  let timer:ReturnType<typeof setInterval>|undefined,busy=false;
  timer=setInterval(()=>{this.parentPeak=Math.max(this.parentPeak,process.memoryUsage().rss);if(busy)return;busy=true;void this.heartbeat().catch(()=>child.kill('SIGTERM')).finally(()=>{busy=false;});},100);
  try{await exited;}finally{clearInterval(timer);this.live=null;}
  let receipt:PhysicalReceipt;try{receipt=JSON.parse(await boundedFile(receiptPath,16384)) as PhysicalReceipt;}
  catch{await this.onPhysical?.({state:'UNKNOWN',phase,invocationId:id,supervisorPid:child.pid??null,receipt:null});throw new CapitalProgramV2Error('CHECK_FAILED','Physical child exit/meter receipt is absent; liability remains UNKNOWN');}
  const ref=r2Ref('physical-child',{phase,invocationId:id,receipt});this.receipts.push({...receipt,phase,ref});this.cpuUsed+=receipt.cpuMs;
  await this.onPhysical?.({state:'EXITED',phase,invocationId:id,supervisorPid:child.pid??null,receipt});
  if(!receipt.physicalExitObserved)refuse('Physical child release was not observed');
  if(receipt.exitCode!==0){let reason=receipt.termination;
   if(phase.startsWith('check-')){try{const rejected=JSON.parse(await boundedFile(stdoutPath,this.caps.maxProofBytes));if(rejected.disposition==='REJECTED'&&typeof rejected.reason==='string')reason+=':'+rejected.reason.slice(0,1024);}catch{}}
   throw new CapitalProgramV2Error(receipt.termination==='ORIGINAL_DEADLINE'?'LIMIT_EXCEEDED':'CHECK_FAILED',`R2 ${phase} rejected or stopped: ${reason}`);
  }
  await this.heartbeat();return {stdout:await boundedFile(stdoutPath,this.caps.maxProofBytes),stdoutPath,receipt,ref};
 }
 async executeProgramme(javascript:string,histories:unknown[],maximumBytes:number){
  await this.checkpoint();
  if(process.platform!=='darwin')throw new CapitalProgramV2Error('CONFIGURATION_REQUIRED','P1 exact programme isolation profile requires qualified macOS Seatbelt; other substrates are unqualified');
  if(Buffer.byteLength(javascript)>maximumBytes)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original P1 module byte grant exhausted');
  const scratch=join(this.directory,'programme-'+randomUUID());await mkdir(scratch,{mode:0o700});
  const node=await realpath(process.execPath),script=join(scratch,'programme.mjs'),profilePath=join(scratch,'enforced.sb'),quote=(v:string)=>JSON.stringify(v),
   ancestors=[...new Set([node,scratch].flatMap(path=>{const result=[];for(let parent=dirname(path);;parent=dirname(parent)){result.push(parent);if(parent==='/')break;}return result;}))],
   profile=['(version 1)','(deny default)','(import "dyld-support.sb")','(allow syscall*)',`(allow process-exec (literal ${quote(node)}))`,'(deny process-fork)','(allow sysctl-read)',
    `(allow file-read* (literal ${quote(node)}) (subpath "/System/Library") (subpath "/usr/lib") (subpath ${quote(scratch)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-read-metadata ${ancestors.map(path=>`(literal ${quote(path)})`).join(' ')})`].join('\n');
  await writeFile(script,javascript,{flag:'wx',mode:0o400});await writeFile(profilePath,profile,{flag:'wx',mode:0o400});
  const run=await this.run('p1-programme',['/usr/bin/sandbox-exec','-f',profilePath,node,'--max-old-space-size=128',script],JSON.stringify({histories}),true,scratch);
  await this.checkpoint();
  return {outputs:JSON.parse(run.stdout),physicalRef:run.ref,profileSha256:sha(profile),nodeSha256:sha(await readFile(node)),dyldProfileSha256:sha(await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb')),
   authority:'NONE_OUTPUT_UNTRUSTED' as const,substrate:'LOCAL_MACOS_SEATBELT' as const};
 }
 async build(original:R2OriginalProblem){
  await this.checkpoint();
  const input=join(this.directory,'original.json'),output=join(this.directory,'family.json');
  await writeFile(input,canonicalJson({original,caps:this.caps}),{flag:'wx',mode:0o400});
  await this.run('construction',[process.execPath,`--max-old-space-size=${Math.max(64,this.caps.memoryMiB-64)}`,'--import',join(r2Repository,'finnor-os/node_modules/tsx/dist/loader.mjs'),
    join(r2Repository,'finnor-os/packages/epistemic-runtime/src/r2-build-child.mts'),input,output,String(this.deadlineAt)],'',true);
  return JSON.parse(await boundedFile(output,this.caps.maxProofBytes)) as Pick<R2Encoding,'variants'|'courses'|'histories'|'coverage'>;
 }
 async check(original:R2OriginalProblem,operation:'encoding'|'proof'|'policy'|'s5',extra:Record<string,unknown>):Promise<R2CheckReceipt&{minimizationLower?:string;infeasibleProof?:boolean}>{
  const encoding=extra.encoding as R2Encoding|undefined;
  const raw=await this.run(`check-${operation}`,[this.runtime.python,checkerPath],JSON.stringify({original,caps:this.caps,operation,...extra,
   canonical:{original:canonicalJson(original),problem:canonicalJson(original.problem),grammar:canonicalJson({permitted:original.permitted,variants:encoding?.variants??[]}),worlds:canonicalJson(original.source.worlds)}}));
  const parsed=JSON.parse(raw.stdout) as Omit<R2CheckReceipt,'schema'|'ref'|'originalDigest'|'encodingDigest'|'policyDigest'|'objectiveSense'>;
  if(parsed.disposition!=='ACCEPTED'||parsed.checkerVersion!==R2_VERSION)refuse(`Independent original checker refused: ${parsed.reason}`);
  // Expensive complete source/runtime hashing occurs at claim acceptance,
  // rather than twice for every producer/completer helper. Live SQL fencing
  // continues before, during and after every physical child.
  await this.checkpoint();
  const body={...parsed,schema:'finnor.r2.independent-check.v1' as const,originalDigest:m3Hash(original),encodingDigest:extra.encoding?m3Hash(extra.encoding):null,
    policyDigest:extra.policy?m3Hash(extra.policy):null,objectiveSense:encoding?.tieBreak?'lexicographic_original_owner_order' as const:'max_z_from_min_negative_z' as const,
    provenance:{runtimeRef:this.runtime.ref,physicalRef:raw.ref,checkerIdentity:this.runtime.checkerIdentity}};
  return {...body,ref:r2Ref('independent-check',body)};
 }
 /** Versioned R5 adapter: the same original physical grant supervises the
  * independent coalition checker. This is not an R2-domain acceptance receipt. */
 async checkCoalition(original:unknown,operation:'encoding'|'proof'|'candidate'|'separate'|'tie'|'programme',extra:Record<string,unknown>){
  const script=join(r2Repository,'finnor-os/scripts/r5/reference.py');
  const checkerIdentity=await coalitionCheckerIdentity();
  if(this.coalitionCheckerIdentity&&canonicalJson(this.coalitionCheckerIdentity)!==canonicalJson(checkerIdentity))refuse('Original admitted coalition checker changed');
  this.bindCoalitionChecker(checkerIdentity);
  const raw=await this.run(`check-r5-${operation}`,[this.runtime.python,script],JSON.stringify({...extra,original,operation}));
  const result=JSON.parse(raw.stdout) as Record<string,unknown>;
  if(result.disposition!=='ACCEPTED')refuse('Independent original coalition checker refused');
  await this.checkpoint();
  if(canonicalJson(await coalitionCheckerIdentity())!==canonicalJson(checkerIdentity))refuse('Coalition checker changed during invocation');
  return {result,physicalRef:raw.ref,checkerIdentity,runtimeRef:this.runtime.ref,stdoutPath:raw.stdoutPath,stdoutSha256:sha(raw.stdout)};
 }
 async solve(encoding:RationalMILP&{schema:string;originalDigest:string},index:number):Promise<{solution:Record<string,string>|null;proofPath:string;proofSha256:string|null;modelSha256:string;proofRef:ExperimentRef|null;viprRef:ExperimentRef|null;proofError:string|null}>{
  const base=join(this.directory,`master-${index}`),modelPath=base+'.lp',rawProofPath=base+'.vipr',proofPath=base+'.complete.vipr',solutionPath=base+'.sol';
  const model=r2Lp(encoding);await writeFile(modelPath,model,{flag:'wx',mode:0o400});
  const cmds=['set exact enable TRUE','set presolving maxrounds 0','set presolving maxrestarts 0',
    'set separating maxrounds 0','set separating maxroundsroot 0','set propagating maxrounds 0','set propagating maxroundsroot 0',
    'set parallel maxnthreads 1',`set limits time ${Math.max(.001,(this.deadlineAt-Date.now()-1500)/1000)}`,
    `set limits memory ${this.caps.memoryMiB}`,`set certificate filename ${rawProofPath}`,`set certificate maxfilesize ${this.caps.maxProofBytes/1048576}`,
    `read ${modelPath}`,'optimize',`write solution ${solutionPath}`,'quit'];
  let proofSha256:string|null=null,proofRef:ExperimentRef|null=null,viprRef:ExperimentRef|null=null,proofError:string|null=null;
  try{
   await this.run('master', [this.runtime.scip,...cmds.flatMap(c=>['-c',c])]);
   await this.run('proof-completion',[this.runtime.python,completionPath,rawProofPath,proofPath]);
   const proof=await boundedFile(proofPath,this.caps.maxProofBytes);proofSha256=sha(proof);
   proofRef=r2Ref('vipr-proof',{sha256:proofSha256,encodingDigest:m3Hash(encoding),runtimeRef:this.runtime.ref});
   const checked=await this.run('vipr',[this.runtime.vipr,proofPath]);
   if(!/Successfully verified (?:infeasibility|optimal value range)/.test(checked.stdout))refuse('VIPR did not confirm a complete derivation');
   viprRef=r2Ref('vipr-acceptance',{proofRef,physicalRef:checked.ref,runtimeRef:this.runtime.ref,stdoutSha256:sha(checked.stdout)});
  }catch(error){
   if(error instanceof CapitalProgramV2Error&&error.code==='STALE_INPUT')throw error;
   proofError=error instanceof Error?error.message:'Upper proof predicate unpassed';
  }
  let solution:Record<string,string>|null=null;
  const text=await boundedFile(solutionPath,this.caps.maxProofBytes).catch(()=>null);
  if(text&&!text.includes('no solution available')){solution={};for(const line of text.split('\n')){const match=line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+([-+]?\d+(?:\.\d+)?(?:\/\d+)?)(?:\s|$)/);if(match)solution[match[1]!]=match[2]!;}}
  return {solution,proofPath,proofSha256,modelSha256:sha(model),proofRef,viprRef,proofError};
 }
}
export async function createR2PrivateDirectory(tenantId:string,principalId:string,queryId:string):Promise<string>{
 const configured=process.env.FINNOR_M3_STORE;if(!configured)throw new CapitalProgramV2Error('CONFIGURATION_REQUIRED','Private capital programme store is not configured');
 const root=resolve(configured);await mkdir(root,{recursive:true,mode:0o700});if(await realpath(root)!==root)refuse('R2 private store symbolic ancestor');
 let path=root;for(const part of [tenantId,principalId,'r2-native',queryId,randomUUID()]){if(!/^[a-z0-9-]+$/i.test(part))refuse('R2 private identity path');path=join(path,part);await mkdir(path,{recursive:true,mode:0o700});
  const st=await lstat(path);if(st.isSymbolicLink()||!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)refuse('R2 private directory permission');
 }return path;
}
