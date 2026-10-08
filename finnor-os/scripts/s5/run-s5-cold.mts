/** Real independent process. Pause/kill controls belong solely to this harness. */
import { readFile } from 'node:fs/promises';
import { POST as allocationPost } from '../../apps/api/app/api/allocations/[operation]/route';
import { POST as policyPost } from '../../apps/api/app/api/policies/[operation]/route';
import { closePool } from '@finnor/db';
const input=JSON.parse(await readFile(process.argv[2]!,'utf8'));
try {
  if(input.waitForStart)await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  const handler=input.owner==='S4'?policyPost:allocationPost;
  const begun=performance.now();const response=await handler(new Request(`http://localhost/api/${input.owner==='S4'?'policies':'allocations'}/${input.operation}`,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':input.tenantId,'x-user-id':input.principalId},body:JSON.stringify(input.body)}),{params:Promise.resolve({operation:input.operation})});
  const result={status:response.status,body:await response.json(),elapsedMs:performance.now()-begun};
  console.log(JSON.stringify(result));process.send?.({kind:'RESULT',result});
  if(input.pauseAfterResult)await new Promise<void>(()=>setInterval(()=>undefined,1000));
}finally{await closePool();}
