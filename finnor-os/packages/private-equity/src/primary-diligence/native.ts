import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {acquireComputeResourceLeases,releaseComputeResourceLeases,renewComputeResourceLeases} from '@finnor/db/compute-governor';
import type {PrimaryClaimCheck,PrimaryGrant} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {reservePrimaryCharge} from '../allocation-store';
import {priceCeiling} from '../exact-price';
import {actor,canonical,event,methodIdentity,newId,tx,type Programme} from './store';
export {priceCeiling};
export interface NativeReceipt {invocationId:string;childPid:number|null;cpuMicros:number|null;peakMemoryBytes:number|null;wallMs:number;inputBytes:number;outputBytes:number;status:string;exitCode:number|null;exitSignal:string|null}
export class PrimaryNativeFailure extends Error{constructor(public predicate:string,public receipt:NativeReceipt){super(predicate);}}
export async function independentPrimaryCheck(ctx:PeMutationContext,p:Programme,grant:PrimaryGrant,frame:unknown,cancelled:()=>Promise<boolean>){
 const payload=canonical(frame);if(Buffer.byteLength(payload)>8388608)throw Error('PRIMARY_CHECK_INPUT_BOUND');
 if(BigInt(grant.maximumMemoryBytes)<268435456n)throw Error('PRIMARY_NATIVE_MEMORY_GRANT_TOO_NARROW');
 const invocationId=newId(),cpuReserve='5000000',reserved=priceCeiling(grant.pricebook.cpuMicroUsdPerSecond.numerator,grant.pricebook.cpuMicroUsdPerSecond.denominator,5n);
 await tx(ctx,async c=>{await reservePrimaryCharge(ctx,c,{grant,programmeId:p.id,requestId:null,chargeKey:'native:'+invocationId,kind:'NATIVE',microUsd:reserved,cpuMicros:cpuReserve});await event(ctx,p,'P2','NATIVE_INTENDED',{invocationId,checker:(await methodIdentity()).checker,originalGrantRef:p.intake.budgetGrantRef,reservedCpuMicros:cpuReserve,reservedMicroUsd:reserved},c);});
 const leases=await acquireComputeResourceLeases({tenantId:ctx.auth.tenantId,resourceKeys:['native:p4'],requiredResourceKeys:['native:p4'],workloadClass:'INTERACTIVE',ownerId:'v2:'+invocationId});
 const receipt:NativeReceipt={invocationId,childPid:null,cpuMicros:null,peakMemoryBytes:null,wallMs:0,inputBytes:Buffer.byteLength(payload),outputBytes:0,status:'UNKNOWN',exitCode:null,exitSignal:null},start=performance.now();
 try{return await new Promise<{check:PrimaryClaimCheck;receipt:NativeReceipt}>((yes,no)=>{
  const child=spawn(process.execPath,['--max-old-space-size=128','--import='+createRequire(import.meta.url).resolve('tsx'),fileURLToPath(new URL('./checker.mts',import.meta.url))],
   {env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',NODE_ENV:'production'},stdio:['pipe','pipe','pipe']});
  receipt.childPid=child.pid??null;let output='',diagnosticBytes=0,settled=false,reason:string|null=null,checking=false;
  const stop=(predicate:string)=>{if(settled)return;reason=predicate;child.kill('SIGKILL');};
  const timer=setTimeout(()=>stop('PRIMARY_CHECKER_DEADLINE'),10000);
  const poll=setInterval(()=>{if(checking||settled)return;checking=true;Promise.all([renewComputeResourceLeases(leases),cancelled()]).then(([valid,cancel])=>{if(!valid||cancel)stop('PRIMARY_CHECKER_CLAIM_OR_LEASE_LOST');}).catch(()=>stop('PRIMARY_CHECKER_CURRENTNESS_UNAVAILABLE')).finally(()=>{checking=false;});},200);
  child.stdout.on('data',(b:Buffer)=>{receipt.outputBytes+=b.length;if(receipt.outputBytes>8388608)stop('PRIMARY_CHECKER_OUTPUT_BOUND');else output+=b.toString('utf8');});
  child.stderr.on('data',(b:Buffer)=>{diagnosticBytes+=b.length;if(diagnosticBytes>65536)stop('PRIMARY_CHECKER_DIAGNOSTIC_BOUND');});
  const finish=()=>{clearTimeout(timer);clearInterval(poll);receipt.wallMs=performance.now()-start;settled=true;};
  child.once('error',()=>{if(settled)return;finish();receipt.status='METER_GAP';no(new PrimaryNativeFailure('PRIMARY_CHECKER_START_FAILED',receipt));});
  child.once('close',(code,signal)=>{if(settled)return;finish();receipt.exitCode=code;receipt.exitSignal=signal;
   try{const parsed=JSON.parse(output),meter=(v:unknown)=>typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v)&&BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER)?Number(v):null;
    receipt.cpuMicros=meter(parsed.usage?.cpuMicros);receipt.peakMemoryBytes=meter(parsed.usage?.peakRSSBytes);
    if(reason||code!==0||!parsed.ok||receipt.cpuMicros===null||receipt.peakMemoryBytes===null||receipt.cpuMicros>Number(cpuReserve)||BigInt(receipt.peakMemoryBytes)>BigInt(grant.maximumMemoryBytes)){
     receipt.status=receipt.cpuMicros===null?'METER_GAP':'FAILED';no(new PrimaryNativeFailure(reason??parsed.predicate??'PRIMARY_CHECKER_RESOURCE_OR_PROTOCOL_FAILED',receipt));return;
    }
    receipt.status='RECONCILED';yes({check:parsed.data as PrimaryClaimCheck,receipt});
   }catch{receipt.status='METER_GAP';no(new PrimaryNativeFailure(reason??'PRIMARY_CHECKER_PROTOCOL_INVALID',receipt));}});
  child.stdin.on('error',()=>undefined);
  void event(ctx,p,'P2','NATIVE_STARTED',{...receipt,leases,environment:'CREDENTIAL_FREE_FIXED_NODE',memoryEnforcement:'NODE_HEAP_BOUND_AND_MEASURED_RSS_NOT_CONTAINER_ATTESTATION'}).then(()=>child.stdin.end(payload)).catch(()=>stop('PRIMARY_NATIVE_START_RECORD_UNAVAILABLE'));
 });}finally{await releaseComputeResourceLeases(leases,'v2-check-finished');}
}
export async function settleNative(ctx:PeMutationContext,p:Programme,grant:PrimaryGrant,receipt:NativeReceipt){
 const usd=receipt.cpuMicros===null?null:priceCeiling(grant.pricebook.cpuMicroUsdPerSecond.numerator,(BigInt(grant.pricebook.cpuMicroUsdPerSecond.denominator)*1000000n).toString(),BigInt(receipt.cpuMicros));
 await tx(ctx,async c=>{
  const cost={id:receipt.invocationId,owner:'P2',requestId:null,kind:'NATIVE',microUsd:usd,reservedMicroUsd:priceCeiling(grant.pricebook.cpuMicroUsdPerSecond.numerator,grant.pricebook.cpuMicroUsdPerSecond.denominator,5n),possibleAdditionalMicroUsd:'0',
   cpuMicros:receipt.cpuMicros?.toString()??null,wallMs:receipt.wallMs,peakMemoryBytes:receipt.peakMemoryBytes?.toString()??null,bytes:receipt.inputBytes+receipt.outputBytes,humanSeconds:0,pricebookRef:grant.pricebook.ref,status:receipt.cpuMicros===null?'METER_GAP':'RECONCILED',reasons:receipt.cpuMicros===null?['PHYSICAL_CHECK_CHILD_DIED_FINAL_USAGE_UNKNOWN']:[]};
  await c.query('UPDATE finnor_os.s5_primary_charges SET actual_micro_usd=$4,actual_cpu_micros=$5,receipt=$6::jsonb,reconciled_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3 AND reconciled_at IS NULL',[ctx.auth.tenantId,grant.reservationRef.id,'native:'+receipt.invocationId,usd,receipt.cpuMicros?.toString()??null,canonical(cost)]);
  await event(ctx,p,'S5','NATIVE_COST_RECORDED',{cost,physical:receipt},c);
 });
}
