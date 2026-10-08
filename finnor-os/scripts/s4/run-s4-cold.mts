/** Separate-process reference API consumer. No hidden simulator state. */
import { readFile } from 'node:fs/promises';
import { POST } from '../../apps/api/app/api/policies/[operation]/route';
import { closePool } from '@finnor/db';
const input=JSON.parse(await readFile(process.argv[2]!,'utf8'));
try {
 const response=await POST(new Request(`http://localhost/api/policies/${input.operation}`,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':input.tenantId,'x-user-id':input.principalId},body:JSON.stringify(input.body)}),{params:Promise.resolve({operation:input.operation})});
 console.log(JSON.stringify({status:response.status,body:await response.json()}));
} finally {await closePool();}
