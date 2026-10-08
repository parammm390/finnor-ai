/** Fresh-process public handler driver. Inputs are test artifacts, not production paths. */
import { readFile } from 'node:fs/promises';
import { closePool } from '@finnor/db';
import { POST } from '../../apps/api/app/api/company-brain/[operation]/route';
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const response = await POST(new Request(`http://127.0.0.1/api/company-brain/${input.operation}`, {
  method: 'POST',
  headers: {'content-type':'application/json','x-tenant-id':input.tenantId,'x-user-id':input.principalId},
  body: JSON.stringify(input.body),
}), {params:Promise.resolve({operation:input.operation})});
const result = {status:response.status,body:await response.json()};
if (process.send) process.send({kind:'RESULT',result});
else console.log(JSON.stringify(result));
await closePool();
if (input.pauseAfterResult) await new Promise(() => undefined);
