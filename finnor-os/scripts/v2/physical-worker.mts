/** Uses final worker registration and real queue claims in a separate process. */
import '../acquisition/original-request-proposer.mts';
import {createWorker} from '../../apps/worker/src/index';
import {closePool,getPool} from '@finnor/db';
import {ensureSecretsLoaded} from '@finnor/security';
if(process.env.NODE_ENV==='production')await ensureSecretsLoaded();
process.env.WORKER_JOB_LEASE_SECONDS='3';
const queue=createWorker();
try{
 const role=(await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
 if(role.current_user!=='finnor_worker'||role.rolsuper||role.rolbypassrls)throw Error('ORDINARY_SEPARATE_WORKER_ROLE_REQUIRED');
 if(!queue.registeredTypes().includes('advance_primary_diligence_v1'))throw Error('FINAL_V2_HANDLER_NOT_REGISTERED');
 await queue.recoverExpiredRunningJobs();
 const limit=process.argv.includes('--drain-ready')?(process.env.FINNOR_ORIGINAL_REQUEST_PROMPTS?128:16):1;let claims=0,drained=false;
 for(let pass=0;pass<limit;pass++){
  if(!await queue.tick()){drained=true;break;}
  claims++;
 }
 if(limit>1&&!drained)throw Error('DISPOSABLE_READY_QUEUE_DRAIN_BOUND');
 console.log(JSON.stringify({workerRole:role,registeredV2:true,claimed:claims>0,claims,drained,nodeEnvironment:process.env.NODE_ENV,secretsProvider:process.env.SECRETS_PROVIDER}));
}finally{await closePool();}
process.exit(0);
