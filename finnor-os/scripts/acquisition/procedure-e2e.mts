import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ingestArtifact,bindArtifact} from '@finnor/artifacts';
import {dataRoomWorkbook,dataRoomContext} from '../p4/data-room-fixtures.mts';

export async function acquisitionProcedureFixture(e:any,analysis:any){
 const {ctx,api,runWorker,evidence}=e;
 const {companies}=e.browserFixtureContext;
 const selected=process.env.FINNOR_P1_EXECUTOR,training:any[]=[];
 try{
  process.env.FINNOR_P1_EXECUTOR='local';
  for(const [company,revenue,expected] of [['B','1000','930000'],['C','1200','1130000']]){
   const root={entityType:'external_organization',entityId:companies[company!]};
   const name='P4 '+company,bytes=dataRoomWorkbook({company:name,revenue});
   const actor={tenantId:ctx.auth.tenantId,userId:ctx.auth.userId,employeeId:ctx.auth.userId,role:'owner' as const};
   const file=await ingestArtifact(actor,{title:name+' procedure income.xlsx',bytes,origin:'manual_upload',sourceSystem:'acquisition:procedure-history'}),anchor=file.ir.nodes[0];assert(anchor);
   await bindArtifact(actor,file.documentId,{versionId:file.version.id,anchorId:anchor.id,anchorHash:anchor.hash,targetKind:'canonical_entity',targetEntityType:root.entityType,targetId:root.entityId});
   await writeFile(join(evidence,file.version.id+'.xlsx'),bytes);
   const sources=analysis.sources.map((s:any)=>({key:s.key,source:{...s.source,subject:root,documentId:file.documentId,documentVersionId:file.version.id,layout:{...s.source.layout,selection:{...s.source.layout.selection,context:dataRoomContext(name)}}}}));
   const request={schema:'finnor.harness-request.v1',instruction:analysis.instruction,root,validAt:analysis.validAt,mode:'production_analysis',sources,acceptance:analysis.acceptance,idempotencyKey:randomUUID()};
   const accepted=await api('program-submit',request);
   await writeFile(join(evidence,'procedure-history-'+company+'-admission.json'),JSON.stringify({request,accepted},null,2));
   assert.equal(accepted.status,202,JSON.stringify(accepted));
   await runWorker(20);
   const done=await api('program-read',{programId:accepted.body.programId});assert.equal(done.status,200,JSON.stringify(done));assert.equal(done.body.status,'TESTED',JSON.stringify(done));
   assert.equal(done.body.program.result.values.operatingProfit.value,expected);
   training.push({request,accepted:accepted.body,done:done.body});
  }
  const request={schema:'finnor.p6.induction-request.v1',root:training[0].request.root,workId:training[0].accepted.workId,programIds:training.map(t=>t.accepted.programId),knowledgeCut:new Date().toISOString(),mode:'production_analysis',idempotencyKey:randomUUID()};
  const accepted=await api('procedure-induce',request);
  await writeFile(join(evidence,'procedure-acquisition-training.json'),JSON.stringify({training,request,accepted},null,2));
  assert.equal(accepted.status,202,JSON.stringify(accepted));await runWorker(10);
  const done=await api('procedure-induction-read',{inductionId:accepted.body.inductionId});assert.equal(done.status,200,JSON.stringify(done));assert.equal(done.body.state,'TESTED',JSON.stringify(done));assert.equal(done.body.capsuleIds.length,1);
  const capsule=await api('procedure-read',{capsuleId:done.body.capsuleIds[0]});assert.equal(capsule.status,200,JSON.stringify(capsule));assert.equal(capsule.body.capsule.support.companies.length,2);
  await writeFile(join(evidence,'procedure-acquisition-capsule.json'),JSON.stringify({accepted,done,capsule},null,2));
  return {capsuleId:done.body.capsuleIds[0],mode:'production_analysis'};
 }finally{if(selected===undefined)delete process.env.FINNOR_P1_EXECUTOR;else process.env.FINNOR_P1_EXECUTOR=selected;}
}
