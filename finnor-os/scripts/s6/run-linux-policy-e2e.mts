import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {release} from 'node:os';
import {nodeFilter} from '../../packages/governed-execution/src/linux-node-policy.js';

const qualification='KERNEL_POLICY_COMPONENT_PROOF_NOT_FULL_JAIL';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.argv[2];
assert(output&&isAbsolute(output),'Pass a new absolute evidence directory');
assert.equal(process.platform,'linux');
assert(process.arch==='x64'||process.arch==='arm64');
assert.notEqual(process.getuid?.(),0);
await mkdir(output,{mode:0o700});
const sources=[
  'packages/governed-execution/src/linux-node-policy.ts',
  'packages/governed-execution/src/executor-linux.ts',
  'packages/governed-execution/native/linux-launcher.c',
  'packages/governed-execution/native/linux-lifetime.h',
  'scripts/r3/package-linux-jail.mjs',
  'scripts/s6/linux-policy-failure-model.md',
  'scripts/s6/linux-policy-probe.c',
  'scripts/s6/linux-policy-positive.mjs',
  'scripts/s6/run-linux-policy-e2e.mts',
];
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
async function snapshot(copy:boolean){
  return Promise.all(sources.map(async path=>{
    const bytes=await readFile(join(root,path));
    if(copy){const target=join(output!,'sources',path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o400});}
    return {path,bytes:bytes.length,sha256:hash(bytes)};
  }));
}
const startedAt=new Date().toISOString(),begun=performance.now(),before=await snapshot(true);
interface Evidence {name:string;status:'PASS'|'FAIL';expected:unknown;observed:unknown}
const results:Evidence[]=[],commands:unknown[]=[];
function command(name:string,binary:string,args:string[],cwd=root,timeout=10000){
  const started=performance.now();
  const result=spawnSync(binary,args,{cwd,encoding:'utf8',timeout,maxBuffer:4*1024*1024,
    env:{PATH:process.env.PATH,HOME:cwd,TMPDIR:cwd,LANG:'C',TZ:'UTC',NODE_ENV:'production'}});
  commands.push({name,binary,args,cwd,timeout,durationMs:performance.now()-started,
    status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr});
  return result;
}
function check(name:string,expected:unknown,observed:unknown,verify:()=>void){
  try{verify();results.push({name,status:'PASS',expected,observed});}
  catch(error){results.push({name,status:'FAIL',expected,observed:{value:observed,error:String(error)}});}
}
function record(value:unknown):Record<string,unknown>{
  assert(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;
}
// Foreign-architecture argument coverage supplements the real kernel campaign.
// This interprets the Linux cBPF wire format, not the production policy builder.
function action(bytes:Buffer,nr:number,audit:number,args:bigint[]=[]):number{
  const data=Buffer.alloc(64);data.writeUInt32LE(nr>>>0,0);data.writeUInt32LE(audit>>>0,4);
  args.forEach((value,index)=>data.writeBigUInt64LE(BigInt.asUintN(64,value),16+index*8));
  let accumulator=0,pc=0;
  for(let steps=0;steps<4096;steps++){
    assert(pc>=0&&pc*8<bytes.length,'cBPF branch left the program');
    const at=pc*8,code=bytes.readUInt16LE(at),yes=bytes[at+2]!,no=bytes[at+3]!,value=bytes.readUInt32LE(at+4);
    if(code===0x20){accumulator=data.readUInt32LE(value);pc++;}
    else if(code===0x15)pc+=1+(accumulator===value?yes:no);
    else if(code===0x45)pc+=1+((accumulator&value)!==0?yes:no);
    else if(code===0x54){accumulator=(accumulator&value)>>>0;pc++;}
    else if(code===0x06)return value;
    else throw Error('Unsupported cBPF opcode '+code);
  }
  throw Error('cBPF did not terminate');
}
function architectureArguments(bytes:Buffer,architecture:'x64'|'arm64'){
  const arm=architecture==='arm64',audit=arm?0xc00000b7:0xc000003e;
  const deny=0x00050001,allow=0x7fff0000;
  const vector=(name:string,nr:number,args:bigint[],expected:number)=>{
    const actual=action(bytes,nr,audit,args);
    check('abi-vector-'+architecture+'-'+name,expected,{actual,nr,args:args.map(String),
      classification:'STATIC_ABI_SUPPLEMENT_NOT_E2E'},()=>assert.equal(actual,expected));
  };
  // Independent Linux UAPI numbers: unistd_64.h and asm-generic/unistd.h.
  const forbidden=arm
    ? [138,240,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,238,239,241,272,440,448]
    : [129,297,29,30,31,64,65,66,67,68,69,70,71,220,240,241,242,243,244,245,256,279,298,312,440,448];
  for(const nr of forbidden)vector('unneeded-process-or-ipc-'+nr,nr,[],deny);
  for(const nr of arm?[261,118,119,122,274]:[302,142,144,203,314]){
    vector('peer-'+nr,nr,[123n],deny);
    vector('self-'+nr,nr,[0n],allow);
    vector('noncanonical-pid-'+nr,nr,[0x100000000n],deny);
  }
  const priority=arm?140:141,ioPriority=arm?30:251;
  vector('priority-self',priority,[0n,0n],allow);
  vector('priority-peer',priority,[0n,123n],deny);
  vector('priority-group',priority,[1n,0n],deny);
  vector('priority-user',priority,[2n,0n],deny);
  vector('ioprio-self',ioPriority,[1n,0n],allow);
  vector('ioprio-peer',ioPriority,[1n,123n],deny);
  vector('ioprio-group',ioPriority,[2n,0n],deny);
  vector('ioprio-user',ioPriority,[3n,0n],deny);
  const fcntl=arm?25:72,ioctl=arm?29:16;
  for(const cmd of [8,15,10,1024,1026])vector('fcntl-signal-control-'+cmd,fcntl,[3n,BigInt(cmd),123n],deny);
  vector('fcntl-asynchronous',fcntl,[3n,4n,0x2000n],deny);
  vector('fcntl-nonblocking',fcntl,[3n,4n,0x800n],allow);
  for(const cmd of [0x8901,0x8902,0x5452,0x5410,0x40045436])vector('ioctl-signal-control-'+cmd,ioctl,[3n,BigInt(cmd),0n],deny);
  vector('ioctl-nonblocking',ioctl,[3n,0x5421n,0n],allow);
  vector('parent-death-reset',arm?167:157,[1n],deny);
  vector('privilege-query',arm?167:157,[39n],allow);
  vector('clone-process',arm?220:56,[0n],deny);
  vector('clone-thread',arm?220:56,[0x10f00n],allow);
  vector('clone3',435,[],0x00050026);
  vector('read-only-truncation',arm?56:257,[0n,0n,0x200n],deny);
  vector('ordinary-write',arm?56:257,[0n,0n,0x201n],allow);
}
const binary=join(output,'policy-probe'),controlled=join(output,'controlled');
await mkdir(controlled,{mode:0o700});
let fatal:unknown=null;
try{
  const compile=command('compile-native-probe','cc',['-std=c11','-O2','-Wall','-Wextra','-Werror',
    '-fstack-protector-strong','-D_FORTIFY_SOURCE=2','-Wl,-z,relro,-z,now',
    '-o',binary,join(root,'scripts/s6/linux-policy-probe.c'),'-lrt','-pthread'],root,30000);
  assert.equal(compile.status,0,compile.stderr);
  command('compiler-identity','cc',['--version']);
  const node=await realpath(process.execPath);
  await writeFile(join(output,'runtime.json'),JSON.stringify({node,version:process.version,sha256:hash(await readFile(node)),
    kernel:release(),architecture:process.arch,uid:process.getuid?.(),qualification},null,2)+'\n',{flag:'wx'});
  for(const architecture of ['x64','arm64'] as const){
    const bytes=nodeFilter(architecture),path=join(output,architecture+'.bpf');
    await writeFile(path,bytes,{flag:'wx',mode:0o400});
    architectureArguments(bytes,architecture);
    const result=command('kernel-compile-'+architecture,binary,[path,'verify']);
    const native=architecture===process.arch;
    check('kernel-compile-'+architecture,native?'EXIT_ZERO':'SIGSYS_WRONG_AUDIT_ABI',
      {status:result.status,signal:result.signal,filterSha256:hash(bytes),bytes:bytes.length},()=>{
        if(native)assert.equal(result.status,0,result.stderr);
        else assert.equal(result.signal,'SIGSYS',result.stderr);
      });
  }
  const native=join(output,process.arch+'.bpf');
  if(process.arch==='x64'){
    const result=command('x32-refusal',binary,[native,'x32']);
    check('x32-refusal','SIGSYS',result,()=>assert.equal(result.signal,'SIGSYS'));
  }
  const kernel=command('controlled-native-operations',binary,[native,'cases',controlled],controlled,90000);
  await writeFile(join(output,'kernel-native.jsonl'),kernel.stdout??'',{flag:'wx'});
  check('native-controller-exit',0,{status:kernel.status,signal:kernel.signal,stderr:kernel.stderr},()=>assert.equal(kernel.status,0,kernel.stderr));
  const rows=(kernel.stdout??'').trim().split('\n').filter(Boolean).map(line=>record(JSON.parse(line)));
  const observations=rows.filter(row=>row.kind==='case');
  assert.equal(observations.length,43,'Every original operation and POSIX queue operation must execute');
  const positives=new Set(['prlimit-self-get','prlimit-self-set','priority-self','sched-self']);
  for(const row of observations){
    assert.equal(typeof row.name,'string');
    const name=row.name as string;
    check(name,positives.has(name)?'SELF_OPERATION_SUCCEEDS':'EPERM_AND_UNCHANGED_SACRIFICIAL_TARGET',row,()=>{
      if(positives.has(name)){assert.equal(row.errno,0);assert.equal(row.result,0);}
      else {assert.equal(row.errno,1,'Must be policy EPERM, not unrelated EINVAL/ENOSYS');assert.equal(row.result,-1);}
      assert.deepEqual(row.after,row.before,'Controlled peer/IPC changed');
    });
  }
  const cleanup=rows.find(row=>row.kind==='cleanup');
  check('exact-owned-cleanup',{ownedIPCRemoved:true,allChildrenReaped:true},cleanup,()=>{
    assert.equal(cleanup?.ownedIPCRemoved,true);assert.equal(cleanup?.allChildrenReaped,true);
  });
  for(const original of [true,false]){
    const name=original?'original-task-guard-threaded-reexec-escape':'trusted-guardian-threaded-reexec-lifetime';
    const executed=command(name,binary,[native,original?'lifetime-original':'lifetime'],controlled,10000);
    let observed:Record<string,unknown>|null=null;
    try{observed=record(JSON.parse(executed.stdout));}catch{/* Completeness below retains the actual failure. */}
    check(name,{aliveAfterSupervisorDeath:original,allOwnedChildrenReaped:true},
      {status:executed.status,signal:executed.signal,observed,stderr:executed.stderr},()=>{
        assert.equal(executed.status,0,executed.stderr);
        assert.equal(observed?.originalMechanism,original);
        assert.notEqual(observed?.preExecPid,observed?.preExecTid);
        assert.equal(observed?.postExecPid,observed?.postExecTid);
        assert.equal(observed?.postExecParentDeathSignal,0,'The guest must actually reach threaded re-exec');
        assert.equal(observed?.aliveAfterSupervisorDeath,original);
        assert.equal(observed?.allOwnedChildrenReaped,true);
      });
  }
  const positive=command('node-positive-under-policy',binary,[native,'node',node,join(root,'scripts/s6/linux-policy-positive.mjs')],controlled,10000);
  check('node-startup-private-io-crypto-worker',{value:42,privateReadWrite:true,asyncCrypto:true,workerThread:true},
    {status:positive.status,signal:positive.signal,stdout:positive.stdout,stderr:positive.stderr},()=>{
      assert.equal(positive.status,0,positive.stderr);
      assert.deepEqual(JSON.parse(positive.stdout),{value:42,privateReadWrite:true,asyncCrypto:true,workerThread:true});
    });
}catch(error){fatal=String(error);results.push({name:'runner-completeness',status:'FAIL',expected:'All registered stages finish',observed:fatal});}
const after=await snapshot(false),sourceUnchanged=JSON.stringify(before)===JSON.stringify(after);
check('source-freeze',true,sourceUnchanged,()=>assert(sourceUnchanged));
check('finite-component-runtime','<=120000 ms',performance.now()-begun,()=>assert(performance.now()-begun<=120000));
await writeFile(join(output,'results.json'),JSON.stringify({
  schema:'finnor.s6.kernel-policy-e2e.v1',qualification,startedAt,finishedAt:new Date().toISOString(),
  durationMs:performance.now()-begun,status:results.every(result=>result.status==='PASS')?'PASS':'FAIL',
  before,after,sourceUnchanged,results,commands,fatal,
  architectureCoverage:{native:process.arch,bothFilters:'KERNEL_VERIFIED',otherArchitecture:'WRONG_ABI_KILL_NOT_NATIVE_BEHAVIORAL_PROOF'},
  limitations:['No launcher or privileged setup','No chroot/Landlock/capability/FD/full-jail/owning-W proof',
    'Hard aggregate resource limits remain unsupported','Native arm64 behavior requires an arm64 kernel'],
  rerun:`cd ${root} && node --import=tsx scripts/s6/run-linux-policy-e2e.mts <new-absolute-evidence-directory>`,
},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,qualification,passed:results.filter(result=>result.status==='PASS').length,
  failed:results.filter(result=>result.status==='FAIL').map(result=>result.name)}));
if(results.some(result=>result.status==='FAIL'))process.exitCode=1;
