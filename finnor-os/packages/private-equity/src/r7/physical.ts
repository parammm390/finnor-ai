import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireComputeResourceLeases, releaseComputeResourceLeases, renewComputeResourceLeases, ComputeCapacityUnavailableError } from '@finnor/db/compute-governor';
import type { PeMutationContext } from '../types';
import type { AtlasPhysicalReceipt } from '../../../shared-types/src/decision-atlas';
import { r7Identity, r7CheckerPath } from './runtime';
import { spendR7Invocation } from './store';
import { R7Error } from './contracts';

export class R7PhysicalFailure extends R7Error {
  constructor(predicate:string,readonly receipt:AtlasPhysicalReceipt){super('CHECK_FAILED',predicate);}
}
export async function r7Physical<T>(ctx:PeMutationContext,episodeId:string,mode:AtlasPhysicalReceipt['mode'],frame:unknown,
  deadlineMs:number,cancelled:()=>Promise<boolean>,event:(receipt:AtlasPhysicalReceipt)=>Promise<unknown>):Promise<{data:T;receipt:AtlasPhysicalReceipt}>{
  const grant=await spendR7Invocation(ctx,episodeId),remaining=Math.min(deadlineMs,grant.deadline_at.getTime()-Date.now(),30000);
  if(remaining<=0)throw new R7Error('LIMIT_EXCEEDED','Original episode deadline exhausted');
  const identity=await r7Identity(),serialized=JSON.stringify(frame),started=performance.now(),invocationId=randomUUID();
  if(Buffer.byteLength(serialized)>33554432)throw new R7Error('LIMIT_EXCEEDED','Physical original input exceeds 32 MiB');
  const leases=await acquireComputeResourceLeases({tenantId:ctx.auth.tenantId,resourceKeys:['native:r7'],requiredResourceKeys:['native:r7'],
    workloadClass:'INTERACTIVE',ownerId:'r7:'+invocationId}).catch(error=>{
      if(error instanceof ComputeCapacityUnavailableError)throw new R7Error('LIMIT_EXCEEDED',error.message);
      throw error;
    });
  const receipt:AtlasPhysicalReceipt={invocationId,mode,pid:null,parentPid:process.pid,wallMs:0,cpuMicros:null,peakRSSBytes:null,
    inputBytes:Buffer.byteLength(serialized),outputBytes:0,exitCode:null,signal:null,predicate:null,
    interpreterDigest:mode==='CHECK'?identity.pythonDigest:identity.nodeDigest,sourceDigest:mode==='CHECK'?identity.checkerDigest:identity.digest,
    leases,money:null,costStatus:'LOCAL_COST_UNMETERED'};
  let leaseReleased=false;
  try{
    const command=mode==='CHECK'?identity.pythonPath:process.execPath,
      args=mode==='CHECK'?[r7CheckerPath]:['--max-old-space-size=512','--import='+createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('./native-child.mts',import.meta.url))];
    return await new Promise((resolve,reject)=>{
      const child=spawn(command,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',NODE_ENV:'production',FINNOR_R7_PARENT_PID:String(process.pid),
        FINNOR_R7_CHILD_DEADLINE_AT:String(Date.now()+remaining)},
        stdio:['pipe','pipe','pipe']});
      receipt.pid=child.pid??null;
      let output:Buffer[]=[],outputBytes=0,errorBytes=0,reason:string|null=null,settled=false,checking=false;
      const terminate=(predicate:string)=>{if(settled)return;reason=predicate;child.kill('SIGKILL');};
      const timer=setTimeout(()=>terminate('ORIGINAL_PHYSICAL_DEADLINE'),remaining);
      const poll=setInterval(()=>{if(settled||checking)return;checking=true;
        Promise.all([renewComputeResourceLeases(leases),cancelled()]).then(([current,cancel])=>{
          if(!current)terminate('PHYSICAL_LEASE_LOST');if(cancel)terminate('CANCELLED_OR_FENCED');
        }).catch(()=>terminate('CURRENTNESS_OR_LEASE_UNKNOWN')).finally(()=>{checking=false;});},200);
      void event(structuredClone(receipt)).then(()=>child.stdin.end(serialized)).catch(()=>terminate('INVOCATION_START_NOT_DURABLE'));
      child.stdout.on('data',(b:Buffer)=>{outputBytes+=b.length;if(outputBytes>33554432)terminate('PHYSICAL_OUTPUT_BOUND');else output.push(b);});
      child.stderr.on('data',(b:Buffer)=>{errorBytes+=b.length;if(errorBytes>65536)terminate('PHYSICAL_DIAGNOSTIC_BOUND');});
      child.once('error',()=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);
        receipt.wallMs=performance.now()-started;receipt.predicate='PHYSICAL_CHILD_START';reject(new R7PhysicalFailure(receipt.predicate,receipt));});
      child.once('close',async(code,signal)=>{
        if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);
        receipt.wallMs=performance.now()-started;receipt.outputBytes=outputBytes;receipt.exitCode=code;receipt.signal=signal;
        try{
          await releaseComputeResourceLeases(leases,'r7-child-physically-exited');leaseReleased=true;
          if(reason||code!==0)throw new Error(reason??'PHYSICAL_CHILD_EXIT');
          const result=JSON.parse(Buffer.concat(output).toString('utf8'));
          receipt.cpuMicros=result.usage?.cpuMicros??null;receipt.peakRSSBytes=result.usage?.peakRSSBytes??null;
          if(!result.ok)throw new Error(result.predicate??'PHYSICAL_PROTOCOL_REJECTED');
          resolve({data:result.data as T,receipt});
        }catch(error){receipt.predicate=error instanceof Error?error.message:'PHYSICAL_PROTOCOL_INVALID';reject(new R7PhysicalFailure(receipt.predicate,receipt));}
        finally{output=[];}
      });
      child.stdin.on('error',()=>undefined);
    });
  }finally{if(!leaseReleased)await releaseComputeResourceLeases(leases,'r7-spawn-or-physical-failure');}
}
