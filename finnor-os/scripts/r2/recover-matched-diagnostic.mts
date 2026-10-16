/** Recover the failed final SQL timing projection from retained real owner rows.
 * No new solver/checker/authority/episode is invoked or receipt supplied. */
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {m3Hash,m3Ref} from '../../packages/private-equity/src/capital-program/v2-contracts';
const dir=resolve(process.argv[2]??'');assert(process.argv[2],'Retained owner evidence directory required');
const records=await Promise.all((await readdir(join(dir,'durable'))).map(async f=>JSON.parse(await readFile(join(dir,'durable',f),'utf8'))));
const selected=records.filter(r=>['r2-owner-positive','matched-all-worlds'].includes(r.query[0].request.idempotencyKey));assert.equal(selected.length,2);
const values=[];
for(const retained of selected){const q=retained.query[0],path=join(dir,'store',q.tenant_id,q.principal_id,'programs',q.result_digest+'.json'),bytes=await readFile(path),program=JSON.parse(bytes.toString());
 assert.equal(program.ref.contentDigest,q.result_digest);assert.deepEqual(program.ref,m3Ref('capital-program',program.body));
 const c=program.body.jointSearchCertificate;assert.equal(c.status,'COMPLETE');assert.equal(c.lower,'100');assert.equal(c.upper,'100');assert.equal(c.normalizedGap,'0');assert.equal(c.exactOptimalityClaimed,true);assert(c.consumer.s5.current&&c.consumer.s5.feasible);assert(program.body.programModule&&program.body.ownerBoundGraph);
 assert(retained.jobs.some((j:any)=>j.status==='completed'));assert(retained.events.some((e:any)=>e.kind==='FINISHED'));
 values.push({key:q.request.idempotencyKey,query:q,certificate:c,programRef:program.ref,programFileSha256:createHash('sha256').update(bytes).digest('hex'),jobs:retained.jobs.map((j:any)=>({id:j.id,acceptedAt:j.accepted_at,startedAt:j.started_at,completedAt:j.completed_at,status:j.status,attempts:j.attempts})),attemptCosts:retained.events.filter((e:any)=>e.kind==='FINISHED').map((e:any)=>e.body.attemptCost)});
}
const on=values.find(v=>v.key==='r2-owner-positive')!,off=values.find(v=>v.key==='matched-all-worlds')!;
const domain=(c:any)=>{const o=c.incumbent.original;return {mandate:o.mandate,problem:o.problem,source:o.source,modelRequest:o.modelRequest,modelHistory:o.modelHistory,permitted:o.permitted,resources:o.resources,protocols:o.protocols,resourceScopeRoots:o.resourceScopeRoots,ownerVector:o.owner.ownerVector,dependencies:o.owner.dependencies,workId:o.owner.workId,inputDigest:o.owner.inputDigest};};
assert.deepEqual(domain(on.certificate),domain(off.certificate));assert.deepEqual(on.certificate.envelope.budget,off.certificate.envelope.budget);assert.deepEqual(on.certificate.incumbent.worldCourses,off.certificate.incumbent.worldCourses);
const result={schema:'finnor.r2.matched-owner-diagnostic-reconstruction.v1',status:'PASS_RETAINED_REAL_OWNER_EVIDENCE',evidenceDir:dir,on,off,domainDigest:m3Hash(domain(on.certificate)),noQualityGain:true,adapterGainNotCredited:true,protectedGain:'NOT_RUN',money:null,moneyStatus:'UNMETERED',originalFailure:'The final timing SELECT used nonexistent jobs.created_at/finished_at. All semantic/bound/consumer assertions had passed; durable real job rows provide accepted_at/completed_at.',qualification:'Recovered historical authenticated owner/API/SQL/worker/SCIP/VIPR/Fraction/S4/S5/P1 matched flows. No new currentness, live effect, protected comparison or economic qualification is inferred.'};
await writeFile(join(dir,'matched-diagnostic-reconstruction.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,output:join(dir,'matched-diagnostic-reconstruction.json'),onNativeCalls:on.certificate.costs.nativeCalls,offNativeCalls:off.certificate.costs.nativeCalls,onWallMs:on.certificate.costs.wallMs,offWallMs:off.certificate.costs.wallMs}));
