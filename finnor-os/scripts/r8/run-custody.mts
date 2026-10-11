/** Preregistered artifact-producing E2E of actual isolated child custody.
 * No business route, lease release, checker answer or semantic receipt is mocked. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonProcess,withScientificProcessObserver,observeProcessGroupClosed} from '../../packages/epistemic-runtime/src/solver-synthesis/process';
import {checkCounterexample,verifyCompleteDomain} from '../../packages/epistemic-runtime/src/solver-synthesis/checker';
import {programForChoices} from '../../packages/epistemic-runtime/src/solver-synthesis/grammar';
import {lowerProgram} from '../../packages/epistemic-runtime/src/solver-synthesis/lowering';
import {loadRuntime,sourceIdentity,runtimeReadPaths,scientificPath} from '../../packages/epistemic-runtime/src/solver-synthesis/runtime';
import {hash} from '../../packages/epistemic-runtime/src/solver-synthesis/contracts';

const output=resolve(process.env.FINNOR_R8_EVIDENCE_DIR??'/tmp/finnor-r8-custody-'+randomUUID());
await mkdir(output,{recursive:true,mode:0o700});
const startedAt=new Date().toISOString(),runtime=await loadRuntime(),pins=await sourceIdentity();
const program=programForChoices({enabled:Array(7).fill(true),costFamily:0,netScore:false,capacity:7,
  inclusiveFeasibility:true,inclusiveImprovement:false,descending:false});
const module=lowerProgram(program,hash(pins));
const fixture=fileURLToPath(new URL('./custody-child.mjs',import.meta.url));
const cases:Array<Record<string,unknown>>=[];
const delay=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms));
type Custody={started:Array<{group:number;identity:Record<string,unknown>}>;
  closed:Array<{group:number;result:Record<string,unknown>}>;forcedCleanup:number[]};

async function challenge(id:string,predicate:string,run:(custody:Custody)=>Promise<unknown>){
  const custody:Custody={started:[],closed:[],forcedCleanup:[]},began=performance.now();
  let observed:unknown,status='PASS';
  try{observed=await run(custody);}
  catch(error){status='FAIL';observed={message:String(error),stack:(error as Error).stack};}
  finally{
    // Evaluate the assertion before this safety cleanup. It cannot manufacture
    // a product close event or turn an unobserved scientific group green.
    for(const child of custody.started){
      if(custody.closed.some(row=>row.group===child.group))continue;
      try{
        process.kill(-child.group,0);
        custody.forcedCleanup.push(child.group);
        process.kill(-child.group,'SIGKILL');
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      await observeProcessGroupClosed(child.group,Date.now()+5000);
    }
  }
  if(custody.forcedCleanup.length)status='FAIL';
  cases.push({id,predicate,status,observed,custody,elapsedMs:performance.now()-began});
  await writeFile(resolve(output,'results.json'),JSON.stringify({
    schema:'finnor.r8.physical-custody-e2e.v1',startedAt,finishedAt:new Date().toISOString(),
    runtimeDigest:hash(runtime),sourcePins:pins,cases,
    rerun:'FINNOR_R8_RUNTIME_MANIFEST=<sealed-runtime> FINNOR_R8_EVIDENCE_DIR=<new-private-directory> node --import=tsx scripts/r8/run-custody.mts',
    qualification:'ACTUAL_MACOS_SEATBELT_PROCESS_CUSTODY_NOT_OWNER_QUEUE_LEASE_OR_PROTECTED_QUALIFICATION',
  },null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({id,status,observed,forcedCleanup:custody.forcedCleanup}));
}

for(const boundary of ['witness','full-domain'] as const){
  await challenge(boundary+'-startup-custody',
    'Native startup refusal closes the already-started independent checker before rejection',
    async custody=>{
      const deadlineAt=Date.now()+10000;
      let refusal='';
      await withScientificProcessObserver({
        started:async(group,identity)=>{
          custody.started.push({group,identity});
          if((identity.args as string[]).some(arg=>arg.endsWith('/transport.mjs')))
            throw Error('REGISTERED_NATIVE_STARTUP_REFUSAL');
        },
        closed:async(group,result)=>{custody.closed.push({group,result});},
      },async()=>{
        try{
          if(boundary==='witness')await checkCounterexample(program,module,[1,1,1,3,3,3],runtime,deadlineAt);
          else await verifyCompleteDomain({program,module,runtime,sourcePins:pins,deadlineAt});
        }catch(error){refusal=String(error);}
      });
      assert.match(refusal,/REGISTERED_NATIVE_STARTUP_REFUSAL/);
      assert.equal(custody.started.length,2,'Must reach actual reference and native startup');
      assert.equal(custody.closed.length,custody.started.length,'No outstanding checker may escape rejection');
      for(const row of custody.closed){
        assert.equal(row.result.physicalGroupClosed,true);
        await observeProcessGroupClosed(row.group,Date.now()+200);
      }
      return {refusal,deadlineAt,productClosed:custody.closed.length};
    });
}

await challenge('backpressure-original-deadline',
  'A nonreading bounded child rejects a backpressured frame under its original deadline, without an unhandled rejection',
  async custody=>{
    const deadlineAt=Date.now()+700,unhandled:string[]=[];
    const onUnhandled=(error:unknown)=>{unhandled.push(String(error));};
    process.on('unhandledRejection',onUnhandled);
    let child:JsonProcess|undefined;
    try{
      await withScientificProcessObserver({
        started:async(group,identity)=>{custody.started.push({group,identity});},
        closed:async(group,result)=>{custody.closed.push({group,result});},
      },async()=>{
        child=await JsonProcess.open({executable:runtime.node.path,args:[fixture,'NONREADING'],
          readPaths:[fixture],deadlineAt});
        const pending=child.request({boundedPayload:'x'.repeat(240000)}).then(
          value=>({status:'RESOLVED',value}),error=>({status:'REJECTED',reason:String(error)}));
        const observed=await Promise.race([pending,delay(1600).then(()=>({status:'PENDING_PAST_ORIGINAL_DEADLINE'}))]);
        await child.close();
        await delay(20);
        assert.equal(observed.status,'REJECTED',JSON.stringify({observed,unhandled}));
        assert.equal(unhandled.length,0,JSON.stringify(unhandled));
      });
      return {deadlineAt,unhandled,productClosed:custody.closed.length};
    }finally{await child?.close();process.removeListener('unhandledRejection',onUnhandled);}
  });

await challenge('pre-aborted-no-child',
  'Already-cancelled scientific work refuses before creating any physical child',
  async custody=>{
    const abort=new AbortController();abort.abort(Error('REGISTERED_PRE_CANCELLED'));
    let child:JsonProcess|undefined,refusal='';
    await withScientificProcessObserver({
      started:async(group,identity)=>{custody.started.push({group,identity});},
      closed:async(group,result)=>{custody.closed.push({group,result});},
    },async()=>{
      try{child=await JsonProcess.open({executable:runtime.node.path,args:[fixture,'ECHO'],
        readPaths:[fixture],deadlineAt:Date.now()+3000,signal:abort.signal});}
      catch(error){refusal=String(error);}
      finally{await child?.close();}
    });
    assert.match(refusal,/R8_CANCELLED_OR_CAPACITY_LOST/);
    assert.equal(custody.started.length,0);
    return {refusal,started:custody.started.length};
  });

await challenge('normal-supervised-physical-close',
  'The real supervisor reaps its child; close records group disappearance, not only parent exit',
  async custody=>{
    const deadlineAt=Date.now()+10000;
    return withScientificProcessObserver({
      started:async(group,identity)=>{custody.started.push({group,identity});},
      closed:async(group,result)=>{custody.closed.push({group,result});},
    },async()=>{
      const supervisor=scientificPath('supervise.py');
      const child=await JsonProcess.open({executable:runtime.python.path,
        args:[supervisor,String(deadlineAt),runtime.node.path,fixture,'ECHO'],
        readPaths:[...runtimeReadPaths(runtime),supervisor,runtime.node.path,fixture],deadlineAt});
      try{
        const response=await child.request({input:'actual-child-response'}) as {observed:unknown;pid:number};
        assert.deepEqual(response.observed,{input:'actual-child-response'});
        assert(Number.isSafeInteger(response.pid));
        const closed=await child.close();assert.equal(closed.code,0);assert.equal(closed.physicalGroupClosed,true);
        assert.equal(custody.closed.length,1);
        await observeProcessGroupClosed(custody.started[0]!.group,Date.now()+200);
        return {response,closed,deadlineAt};
      }finally{await child.close();}
    });
  });

// Separately registered negative close predicate. Forced safety cleanup here
// cannot satisfy any of the five original product-closure assertions above.
const refusedCustody:Custody={started:[],closed:[],forcedCleanup:[]};
const realKill=process.kill;
let refusalProbe:Record<string,unknown>={status:'FAIL'},refusedChild:JsonProcess|undefined;
try{
 await withScientificProcessObserver({
  started:async(group,identity)=>{refusedCustody.started.push({group,identity});},
  closed:async(group,result)=>{refusedCustody.closed.push({group,result});},
 },async()=>{
  const deadlineAt=Date.now()+1200;
  refusedChild=await JsonProcess.open({executable:runtime.node.path,args:[fixture,'NONREADING'],
   readPaths:[fixture],deadlineAt});
  const group=refusedCustody.started[0]!.group;
  process.kill=((pid,signal)=>{
   if(pid===-group&&signal==='SIGKILL')throw Object.assign(Error('REGISTERED_SIGNAL_REFUSAL'),{code:'EPERM'});
   return realKill.call(process,pid,signal);
  }) as typeof process.kill;
  const began=performance.now();
  const result=await Promise.race([
   refusedChild.close().then(()=>({status:'CLOSED',reason:''}),error=>({status:'REFUSED',reason:String(error)})),
   delay(6500).then(()=>({status:'PENDING_PAST_REGISTERED_GRACE',reason:''})),
  ]);
  const elapsedMs=performance.now()-began,aliveBeforeTestCleanup=process.kill(-group,0);
  refusalProbe={status:'FAIL',result,elapsedMs,deadlineAt,aliveBeforeTestCleanup,
   productClosedBeforeTestCleanup:refusedCustody.closed.length,physicalCloseProven:false,capacityReleaseProven:false};
  assert.equal(result.status,'REFUSED');
  assert.match(result.reason,/R8_PHYSICAL_GROUP_CLOSE_UNOBSERVED/);
  assert.match(result.reason,/R8_PHYSICAL_GROUP_SIGNAL_REFUSED.*REGISTERED_SIGNAL_REFUSAL/);
  assert(elapsedMs<=5750,'Registered 5000-ms grace plus observer tolerance, not a new child budget');
  assert.equal(aliveBeforeTestCleanup,true);
  assert.equal(refusedCustody.closed.length,0);
  refusalProbe.status='PASS_EXPECTED_BOUNDED_REFUSAL_NOT_PHYSICAL_CLOSE';
 });
}catch(error){refusalProbe={...refusalProbe,status:'FAIL',error:String(error)};}
finally{
 process.kill=realKill;
 for(const child of refusedCustody.started){
  try{
   process.kill(-child.group,0);refusedCustody.forcedCleanup.push(child.group);
   process.kill(-child.group,'SIGKILL');
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  await observeProcessGroupClosed(child.group,Date.now()+5000);
 }
 await refusedChild?.close().catch(()=>undefined);
 await writeFile(resolve(output,'close-refusal-probe.json'),JSON.stringify({
  schema:'finnor.r8.negative-close-bound-e2e.v1',...refusalProbe,custody:refusedCustody,
  qualification:'ACTUAL_SIGNAL_REFUSAL_RETAINED_TEST_CLEANUP_NOT_PRODUCT_CLOSE_QUEUE_LEASE_RELEASE_OR_PROTECTED_PROOF',
 },null,2)+'\n',{mode:0o600});
}
const passed=cases.every(row=>row.status==='PASS')&&refusalProbe.status==='PASS_EXPECTED_BOUNDED_REFUSAL_NOT_PHYSICAL_CLOSE';
console.log(JSON.stringify({output,status:passed?'PASS':'FAIL',originalCases:cases.length,negativeClosePredicate:refusalProbe.status}));
if(!passed)process.exitCode=1;
