import {closePool,getPool,PRODUCTION_JOB_CONTRACTS} from '@finnor/db';
import {JobQueue} from '../../apps/worker/src/queue';
import {runCapitalProgramJob,runRobustCapitalProgramJob} from '../../packages/private-equity/src/capital-program/worker';

// The API and global queue have different restricted database logins. This
// process uses the existing worker role; it cannot bypass tenant business RLS.
const identity=(await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
if(identity.current_user!=='finnor_worker'||identity.rolsuper||identity.rolbypassrls)throw Error('R2_WORKER_DATABASE_ROLE_REQUIRED');
process.env.WORKER_JOB_LEASE_SECONDS='30';
const legacy=process.argv.includes('--legacy'),queue=legacy?new JobQueue('r2-disposable-worker:'+process.pid,30):(await import('../../apps/worker/src/index')).createWorker();
if(legacy)queue.register('run_capital_program_v2',runCapitalProgramJob,PRODUCTION_JOB_CONTRACTS.run_capital_program_v2);
if(process.argv.includes('--wait')){
 console.log('R2_ACTUAL_WORKER_READY '+JSON.stringify({preparationCpu:process.cpuUsage(),preparationPeak:process.resourceUsage().maxRSS*1024,role:identity,registeredTypes:queue.registeredTypes()}));
 await new Promise<void>(yes=>process.stdin.once('data',()=>yes()));
 process.stdin.pause();
}
try{
 const recovered=process.argv.includes('--recover')?await queue.recoverExpiredRunningJobs():0;
 if(process.argv.includes('--loop')){
  const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
  console.log(JSON.stringify({schema:'finnor.r2.physical-worker-ready.v1',pid:process.pid,identity,recovered,registeredTypes:queue.registeredTypes()}));
  while(!stop.signal.aborted){const ran=await queue.tick(stop.signal);if(ran)console.log(JSON.stringify({schema:'finnor.r2.physical-worker-tick.v1',pid:process.pid,ran}));await new Promise(yes=>setTimeout(yes,250));}
 }else{const ran=await queue.tick();console.log(JSON.stringify({schema:'finnor.r2.physical-worker-tick.v1',pid:process.pid,identity,ran,recovered,registeredTypes:queue.registeredTypes()}));}
}finally{await closePool();}
