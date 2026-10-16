/** Actual P1 subprocess boundary only: no solver, owner or production claim. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R2NativeSession,type R2Runtime} from '../../packages/private-equity/src/capital-program/r2-native';

const output=process.argv[2],configured=process.env.FINNOR_R2_PYTHON;
if(!output||!isAbsolute(output)||!configured)throw Error('Fresh absolute evidence directory and FINNOR_R2_PYTHON required');
await mkdir(output,{mode:0o700});
const python=await realpath(configured),root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const sourcePaths=['finnor-os/packages/private-equity/src/capital-program/r2-native.ts','finnor-os/packages/epistemic-runtime/python/r2_supervise.py','finnor-os/packages/governed-execution/src/executor-linux.ts','finnor-os/scripts/r5/run-programme-isolation-e2e.mts'];
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const snapshot=()=>Promise.all(sourcePaths.map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
const before=await snapshot(),results:unknown[]=[];
// executeProgramme consumes only Python. Missing scientific fields deliberately
// cannot masquerade as loadR2Runtime/SCIP/VIPR qualification.
const runtime={python} as R2Runtime;
async function challenge(id:string,body:(session:R2NativeSession,directory:string)=>Promise<unknown>,wallMs=5000){
 const directory=join(output,id);await mkdir(directory,{mode:0o700});
 const deadline=Date.now()+wallMs,events:unknown[]=[];
 const caps={cpuMs:10000,memoryMiB:2048,maxNativeCalls:4,maxProofBytes:131072} as R2NativeSession['caps'];
 const checkpoint=async()=>{if(Date.now()>=deadline)throw Error('ORIGINAL_DEADLINE');};
 const session=new R2NativeSession(runtime,directory,deadline,caps,checkpoint,async event=>{events.push(event);},checkpoint);
 let result:unknown;
 try{result={id,status:'PASS',observed:await body(session,directory)};}
 catch(error){result={id,status:'FAIL',error:String(error)};process.exitCode=1;}
 finally{await session.cancel();await writeFile(join(directory,'physical.json'),JSON.stringify({deadline,caps,events,receipts:session.receipts},null,2)+'\n');}
 results.push(result);console.log(JSON.stringify(result));
 await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.r5.p1-isolation-e2e.v1',results,platform:process.platform,node:process.version,python,pythonSha256:sha(await readFile(python)),before,
 qualification:'ACTUAL_P1_SUPERVISED_SUBPROCESS_ONLY_NO_SOLVER_OWNER_OR_PRODUCTION_ACCEPTANCE',
 rerun:'FINNOR_R2_PYTHON=<python> node --import=tsx scripts/r5/run-programme-isolation-e2e.mts <fresh-absolute-directory>'},null,2)+'\n');
}
await challenge('input-output-and-physical-accounting',async(session)=>{
 const script="let s='';for await(const b of process.stdin)s+=b;const x=JSON.parse(s);console.log(JSON.stringify({value:x.histories[0]*6,credential:process.env.DATABASE_URL??null}));";
 const result=await session.executeProgramme(script,[7],1048576);
 assert.deepEqual(result.outputs,{value:42,credential:null});assert.equal(result.authority,'NONE_OUTPUT_UNTRUSTED');
 assert.equal(session.receipts.length,1);assert.equal(session.receipts[0]!.physicalExitObserved,true);
 assert(session.receipts[0]!.cpuMs>0);assert(session.receipts[0]!.aggregatePeakMemoryBytes>0);
 return result;
});
await challenge('readonly-files-network-process-and-fd-boundary',async(session,directory)=>{
 const sentinel='PRIVATE_P1_SENTINEL',secret=join(directory,'private-secret');await writeFile(secret,sentinel,{mode:0o600});
 const script=`import fs from 'node:fs';import {connect} from 'node:net';import {spawnSync} from 'node:child_process';const errors={};for(const [name,fn] of [['outside',()=>fs.readFileSync(${JSON.stringify(secret)})],['scratch',()=>fs.writeFileSync('forbidden','x')]]){try{fn();errors[name]=null;}catch(e){errors[name]=e.code;}}try{errors.fd3Regular=fs.fstatSync(3).isFile();}catch(e){if(e.code!=='EBADF')throw e;errors.fd3Regular=false;}errors.child=spawnSync(process.execPath,['-e','process.exit(0)']).status;errors.network=await new Promise(resolve=>{const s=connect(9,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(null)});s.once('error',e=>resolve(e.code));});console.log(JSON.stringify(errors));`;
 const result=await session.executeProgramme(script,[],1048576),observed=result.outputs;
 assert(observed.outside);assert(observed.scratch);assert.notEqual(observed.child,0);
 assert(['EPERM','EACCES'].includes(observed.network));
 // Node may reuse descriptor 3 for its event loop; it must never expose the filter.
 assert.equal(observed.fd3Regular,false);
 assert.equal(await readFile(secret,'utf8'),sentinel);
 return result;
});
await challenge('original-deadline-kills-and-reaps',async(session)=>{
 await assert.rejects(()=>session.executeProgramme('while(true){}',[],1048576));
 assert.equal(session.receipts.length,1);assert.equal(session.receipts[0]!.physicalExitObserved,true);
 assert(['ORIGINAL_DEADLINE','CANCELLED'].includes(session.receipts[0]!.termination));
 return session.receipts;
},750);
await challenge('explicit-cancellation-kills-and-reaps',async(session,directory)=>{
 const running=session.executeProgramme("console.log('P1_CHILD_READY');while(true){}",[],1048576);
 // Observe actual programme execution, not Node's earlier supervisor-spawn
 // event. A cancellation before Python installs its handlers legitimately
 // leaves UNKNOWN and does not exercise the accepted-child reaping boundary.
 let failure:unknown,ready=false;
 void running.catch(error=>{failure=error;});
 while(!ready&&Date.now()<session.deadlineAt){
  if(failure)throw failure;
  for(const path of await readdir(directory,{recursive:true}))if(path.endsWith('.stdout'))
   ready=(await readFile(join(directory,path),'utf8')).includes('P1_CHILD_READY')||ready;
  if(!ready)await new Promise(done=>setTimeout(done,20));
 }
 assert(ready,'Original deadline elapsed before actual P1 child execution');
 await session.cancel();await assert.rejects(()=>running);
 assert.equal(session.receipts.length,1);assert.equal(session.receipts[0]!.physicalExitObserved,true);
 assert.equal(session.receipts[0]!.termination,'CANCELLED');return session.receipts;
});
const after=await snapshot();assert.deepEqual(after,before,'Source changed during physical run');
await writeFile(join(output,'source-freeze.json'),JSON.stringify({before,after,unchanged:true},null,2)+'\n');
