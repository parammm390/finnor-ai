import {JobQueue} from '../../apps/worker/src/queue';
import {closePool,withTenant} from '@finnor/db';
import {sql} from 'drizzle-orm';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {assertDisposableDatabaseTarget} from '../../packages/db/production-target-guard';
import {runObjectiveIteration} from '../../apps/worker/src/handlers/run-objective-iteration';
import {runWorkforceAssignment} from '../../apps/worker/src/handlers/run-workforce-assignment';
import {runWorkflowStep} from '../../apps/worker/src/handlers/run-workflow-step';
const tenantId=process.env.FINNOR_IC_CONTROLLER_TENANT,loopId=process.env.FINNOR_IC_CONTROLLER_LOOP;
if(process.env.NODE_ENV!=='test'||!tenantId||!loopId||!process.env.DATABASE_URL)throw Error('DISPOSABLE_NATIVE_IC_CONTROLLER_SCOPE_REQUIRED');
assertDisposableDatabaseTarget(process.env.DATABASE_URL,'Native acquisition IC controller');
const queue=new JobQueue('acquisition-ic-controller-'+process.pid,30);
queue.register('run_objective_iteration',runObjectiveIteration,PRODUCTION_JOB_CONTRACTS.run_objective_iteration);
queue.register('run_workforce_assignment',runWorkforceAssignment,PRODUCTION_JOB_CONTRACTS.run_workforce_assignment);
queue.register('run_workflow_step',runWorkflowStep,PRODUCTION_JOB_CONTRACTS.run_workflow_step);
queue.register('run_workflow_step_v2',runWorkflowStep,PRODUCTION_JOB_CONTRACTS.run_workflow_step_v2);
queue.register('run_workflow_step_v3',runWorkflowStep,PRODUCTION_JOB_CONTRACTS.run_workflow_step_v3);
try{
 let worked=0,idle=0,state:Record<string,unknown>|undefined;
 for(let tick=0;tick<100;tick++){
  await queue.recoverExpiredRunningJobs();
  if(await queue.tick()){worked++;idle=0;}else idle++;
  state=(await withTenant(tenantId,db=>db.execute<Record<string,unknown>>(sql`SELECT loop.state,loop.step_count,loop.action_count,loop.query_count,loop.reason,
   EXISTS(SELECT 1 FROM finnor_os.domain_actions action WHERE action.tenant_id=loop.tenant_id AND action.work_id=loop.work_id AND action.status='pending') pending_approval
   FROM finnor_os.work_objective_loops loop WHERE loop.tenant_id=${tenantId}::uuid AND loop.id=${loopId}::uuid`))).rows[0];
  if(!state||['completed','cancelled','failed','blocked'].includes(String(state.state))||state.state==='awaiting_approval'&&state.pending_approval===true||idle>=10)break;
  await new Promise(r=>setTimeout(r,100));
 }
 console.log(JSON.stringify({workerPid:process.pid,node:process.version,worked,state,qualification:'ACTUAL_QUEUE_AND_PRODUCTION_CONTROLLER_WORKFORCE_WORKFLOW_HANDLERS'}));
}finally{await closePool();}
