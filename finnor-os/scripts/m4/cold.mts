import { readFile } from 'node:fs/promises';
import { closePool } from '@finnor/db';
import { POST } from '../../apps/api/app/api/company-brain/[operation]/route';
const input=JSON.parse(await readFile(process.argv[2]!,'utf8'));
try{
  const response=await POST(new Request('http://127.0.0.1/api/company-brain/counterexample-read',{method:'POST',
    headers:{'content-type':'application/json','x-tenant-id':input.tenantId,'x-user-id':input.principalId},
    body:JSON.stringify({searchId:input.searchId})}),{params:Promise.resolve({operation:'counterexample-read'})});
  const body={status:response.status,body:await response.json()};
  if(process.send)await new Promise<void>((yes,no)=>process.send!(body,error=>error?no(error):yes()));
}finally{await closePool();if(process.connected)process.disconnect();}
