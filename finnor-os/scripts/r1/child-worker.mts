/** Disposable external driver of the actual registered queue handler. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runCertifiedStateReductionJob} from '../../packages/private-equity/src/r1/worker';
import {runProgrammeContinuationJob} from '../../packages/private-equity/src/live-recompilation/worker';
import {closePool} from '@finnor/db';
import {releaseProbe} from '../../apps/worker/src/handlers/release-probe';
if(process.env.NODE_ENV!=='test'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('R1_DISPOSABLE_CHILD_REQUIRED');
const queue=new JobQueue('r1-cold-'+process.pid,3);
if(process.env.FINNOR_R1_CHILD_MODE==='COMPATIBILITY_OLD')queue.register('release_probe',releaseProbe,PRODUCTION_JOB_CONTRACTS.release_probe);
else{
 queue.register('run_certified_state_reduction_v1',runCertifiedStateReductionJob,PRODUCTION_JOB_CONTRACTS.run_certified_state_reduction_v1);
 queue.register('run_r1_dependency_continuation_v1',runProgrammeContinuationJob,PRODUCTION_JOB_CONTRACTS.run_r1_dependency_continuation_v1);
}
// Only this disposable driver supports an IPC admission barrier. Prepare its
// imports before accepting a bounded decision, then explicitly release queue
// polling after the old/future protocol refusal probes. No owner clock moves.
let stopping=false,released=process.env.FINNOR_R1_CHILD_MODE!=='RUN_HELD',wake:(()=>void)|undefined;
process.on('message',message=>{if(message==='stop'){stopping=true;wake?.();}if(message==='start'){released=true;wake?.();}});
process.on('disconnect',()=>{stopping=true;wake?.();});
console.log(JSON.stringify({kind:'READY',pid:process.pid,node:process.version,dispatch:released?'AUTOMATIC':'HELD'}));
try{
 if(process.env.FINNOR_R1_CHILD_MODE==='RECONCILE')console.log(JSON.stringify({kind:'COLD_QUEUE_RECONCILIATION',pid:process.pid,recovered:await queue.recoverExpiredRunningJobs(3)}));
 else {if(!released&&!stopping)await new Promise<void>(yes=>{wake=yes;});let worked=0;for(let i=0;i<1200&&!stopping;i++){if(await queue.tick())worked++;await new Promise(yes=>setTimeout(yes,25));}console.log(JSON.stringify({kind:'RETURNED',pid:process.pid,worked,resourceUsage:process.resourceUsage(),usd:null}));}
}finally{await closePool();process.disconnect?.();}
