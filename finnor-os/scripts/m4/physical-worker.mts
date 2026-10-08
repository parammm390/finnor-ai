import { readFile } from 'node:fs/promises';
import { closePool } from '@finnor/db';
import { JobQueue } from '../../apps/worker/src/queue';
import { runCounterexampleSearchJob } from '../../packages/private-equity/src/counterexample-search/worker';
const input=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const queue=new JobQueue(input.workerId,3);
let selected=false;
console.log(JSON.stringify({kind:'READY',workerId:input.workerId,searchId:input.searchId,at:new Date().toISOString()}));
queue.register('run_counterexample_search_v1',async(payload,execution)=>{
  console.log(JSON.stringify({kind:'CLAIMED',workerId:input.workerId,searchId:payload.searchId,
    jobId:execution?.jobId,at:new Date().toISOString()}));
  if(payload.searchId===input.searchId)selected=true;
  await runCounterexampleSearchJob(payload,execution);
},{protocolVersions:[1],retrySafety:'locally_idempotent'});
try{
  for(let count=0;count<16&&!selected;count++)if(!await queue.tick())break;
  if(!selected)throw Error('The canonical queue did not claim the selected physical-test search');
}
finally{await closePool();}
