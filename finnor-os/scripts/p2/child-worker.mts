/** Separate process at the real queue/claim/recovery boundary. No synthetic claims. */
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runComputeSearchUnitJob} from '../../packages/private-equity/src/compute-search/worker';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {closePool} from '@finnor/db';
if(process.env.NODE_ENV!=='test'||!process.env.DATABASE_URL)throw Error('DISPOSABLE_CHILD_REQUIRED');
const queue=new JobQueue('p2-cold-'+process.pid,3);
queue.register('run_compute_search_unit_v1',runComputeSearchUnitJob,PRODUCTION_JOB_CONTRACTS.run_compute_search_unit_v1);
let stopping=false;process.on('message',message=>{if(message==='stop')stopping=true;});
console.log(JSON.stringify({kind:'READY',pid:process.pid,node:process.version,mode:process.env.FINNOR_P2_CHILD_MODE??'WORKER'}));
try{
 if(process.env.FINNOR_P2_CHILD_MODE==='RECONCILE'){
  const recovered=await queue.recoverExpiredRunningJobs(3),body=JSON.parse(process.env.FINNOR_P2_CHILD_INPUT!);
  const results=[];
  for(const operation of ['compute-search-reconcile','compute-search-resume','compute-search-read']){
   const response=await POST(new Request('http://localhost/api/company-brain/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':body.tenant,'x-user-id':body.actor},body:JSON.stringify({searchId:body.searchId})}),{params:Promise.resolve({operation})});
   results.push({operation,status:response.status,body:await response.json()});
  }
  console.log(JSON.stringify({kind:'COLD_RECONCILIATION',pid:process.pid,recovered,results}));
 }else{
  let worked=0;
  for(let i=0;i<400&&!stopping;i++){if(await queue.tick())worked++;await new Promise(r=>setTimeout(r,25));}
  console.log(JSON.stringify({kind:'COMPLETE',pid:process.pid,worked,resources:process.resourceUsage(),billingUSD:null}));
 }
}finally{await closePool();process.disconnect?.();}
