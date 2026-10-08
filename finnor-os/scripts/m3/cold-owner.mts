import {readFile} from 'node:fs/promises';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {closePool} from '@finnor/db';
const spec=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const response=await POST(new Request('http://127.0.0.1/api/company-brain/capital-program-read',{
  method:'POST',headers:{'content-type':'application/json','x-tenant-id':spec.tenant,'x-user-id':spec.principal},body:JSON.stringify({queryId:spec.queryId}),
}),{params:Promise.resolve({operation:'capital-program-read'})});
const bytes=JSON.stringify(await response.json())+'\n';
await new Promise<void>((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve()));
await closePool();process.exit(response.ok?0:1);
