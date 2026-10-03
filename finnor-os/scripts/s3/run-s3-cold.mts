/** Fresh-process use through the same actual authenticated handler/store. */
import { readFile } from 'node:fs/promises';
import { POST } from '../../apps/api/app/api/interventions/[operation]/route';
import { closePool } from '@finnor/db';
const input=JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const response=await POST(new Request(`http://localhost/api/interventions/${input.operation}`, {method:'POST',
  headers:{'content-type':'application/json','x-tenant-id':input.tenantId,'x-user-id':input.principalId},body:JSON.stringify(input.body)}),
  {params:Promise.resolve({operation:input.operation})});
console.log(JSON.stringify({status:response.status,body:await response.json()}));
await closePool();
// Imported application libraries may retain non-owned background timers. This
// isolated handler probe ends after its response and owned DB pool are closed;
// it does not certify whole-service graceful shutdown.
process.exit(0);
