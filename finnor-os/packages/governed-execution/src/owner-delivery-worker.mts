/** One externally configured owner workload. Logs never include credentials or record bodies. */
import { closePool } from '@finnor/db';
import { LedgerFault } from './protocol.js';
import { deliverOwnerTransportBatch } from './owner-delivery-store.js';
const identity={semanticOwner:process.env.FINNOR_S6_OWNER_TRANSPORT_OWNER??'',tenantId:process.env.FINNOR_S6_OWNER_TRANSPORT_TENANT??'',principalId:process.env.FINNOR_S6_OWNER_TRANSPORT_PRINCIPAL??''};
let closing=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing=true;});
try{
 while(!closing){
  try{const report=await deliverOwnerTransportBatch(identity);if(report.inspected)console.log(JSON.stringify(report));}
  catch(error){console.log(JSON.stringify({status:'OWNER_TRANSPORT_UNAVAILABLE',code:error instanceof LedgerFault?error.code:'OWNER_TRANSPORT_RUNTIME_UNAVAILABLE'}));}
  if(!closing)await new Promise(done=>setTimeout(done,1000));
 }
}finally{await closePool();}
