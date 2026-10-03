/** E2E process entry point around the real compatible queue/production handler. */
import {JobQueue} from '../../apps/worker/src/queue.js';
import {runWorkflowStep} from '../../apps/worker/src/handlers/run-workflow-step.js';
import {closePool} from '@finnor/db';
import {recoverStaleSteps} from '@finnor/workflow-runtime';
const queue=new JobQueue(`s6-schedule-e2e:${process.pid}`);
queue.register('run_workflow_step_v3',runWorkflowStep,{protocolVersions:[3],retrySafety:'durably_effect_guarded',allowedClasses:['INTERACTIVE']});
try{const recovered=await queue.recoverExpiredRunningJobs();const steps=process.env.FINNOR_S6_TEST_TENANT_ID?await recoverStaleSteps(process.env.FINNOR_S6_TEST_TENANT_ID):null;const worked=await queue.tick();console.log(JSON.stringify({pid:process.pid,worked,recovered,steps,node:process.version}));}
finally{await closePool();}
