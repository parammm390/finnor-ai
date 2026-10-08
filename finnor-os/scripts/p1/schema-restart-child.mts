/** A physically fresh process rederives through the existing P4 API and queue. */
import {readFile,writeFile} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {closePool} from '@finnor/db';
import {JobQueue} from '../../apps/worker/src/queue';
import {PRODUCTION_JOB_CONTRACTS} from '../../packages/db/compute-contract';
import {runEvidenceDerivationJob} from '../../packages/private-equity/src/evidence-execution/worker';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {currentCodeIdentity,schemaIdentity} from '../../packages/private-equity/src/evidence-execution/store';
if(process.env.NODE_ENV!=='test'||!process.env.DATABASE_URL)throw Error('DISPOSABLE_NATIVE_RESTART_REQUIRED');
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const ctx:any={auth:{tenantId:input.tenant,userId:input.actor,employeeId:input.actor,role:'owner'}};
async function api(operation:string,body:unknown){const response=await POST(new Request('http://localhost/api/company-brain/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':input.tenant,'x-user-id':input.actor},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});return {status:response.status,body:await response.json()};}
try{
 const frozen={schema:'finnor.p1.catalogue-restart-freeze.v1',pid:process.pid,node:process.version,code:await currentCodeIdentity(),schemaDigest:await schemaIdentity(ctx)};
 await writeFile(input.freeze,JSON.stringify(frozen,null,2));
 const handles=await api('evidence-handles',{root:input.root,validAt:input.validAt,inputs:input.descriptors});assert.equal(handles.status,200,JSON.stringify(handles));
 const submitted=await api('evidence-submit',{...input.request,idempotencyKey:randomUUID(),inputs:handles.body.handles.map((h:any)=>({inputId:h.inputId,handleId:h.id}))});assert.equal(submitted.status,202,JSON.stringify(submitted));
 const queue=new JobQueue('p1-catalogue-restart-'+process.pid,3);queue.register('run_evidence_derivation_v1',runEvidenceDerivationJob,PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
 let current:any;for(let i=0;i<16;i++){await queue.tick();current=await api('evidence-read',{queryId:submitted.body.queryId});assert.equal(current.status,200,JSON.stringify(current));if(['TESTED','FAILED','INVALIDATED','PARTIAL','CANCELLED'].includes(current.body.status))break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(current.body.status,'TESTED',JSON.stringify(current));assert.equal(current.body.derivation.code.schemaDigest,frozen.schemaDigest);
 await writeFile(input.output,JSON.stringify({schema:'finnor.p1.catalogue-restart-result.v1',pid:process.pid,frozen,handles,submitted,current,resources:process.resourceUsage(),billingUSD:null},null,2));
 console.log(JSON.stringify({pid:process.pid,status:current.body.status,queryId:submitted.body.queryId,output:input.output}));
}finally{await closePool();}
