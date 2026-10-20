import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export async function exerciseStorageResume({repo,previous,root}) {await mkdir(root,{mode:0o700});
const sha=b=>createHash('sha256').update(b).digest('hex'),began=performance.now();
const freeze=JSON.parse(await readFile(join(previous,'freeze.json'),'utf8')),input=freeze.input;
const {readQualificationCursor}=await import(pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-state-journal.mts')));
const {executeLiveObservationSlice}=await import(pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-runtime.mts')));
const before=await readQualificationCursor(input.cursorPath),originalSegmentDigest=sha(JSON.stringify(before.segments));
const firstRef=before.segments[0].receiptRefs.find(r=>r.path.startsWith('live-owner-')),
 first=JSON.parse(await readFile(join(previous,firstRef.path),'utf8')),row=first.response.body.rows[0],
 endpoint=input.projections[0].owner,variable=endpoint.tokenEnvironmentVariable,token='PUBLIC_DISPOSABLE_STORAGE_PROBE_TOKEN';
assert.equal(process.env[variable],undefined);process.env[variable]=token;
const traffic=[];let reads=0;
const server=createServer((req,res)=>{
 res.setHeader('content-type','application/json');if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
 const path=new URL(req.url,endpoint.origin).pathname;
 if(path==='/api/me'){traffic.push({at:new Date().toISOString(),path,status:200});res.end(JSON.stringify({tenantId:endpoint.tenantId,userId:endpoint.principalId,role:'owner'}));return;}
 if(path==='/api/works'){
  reads++;const status=reads===1?503:200;traffic.push({at:new Date().toISOString(),path,status});res.writeHead(status);
  res.end(JSON.stringify(status===503?{error:'PUBLIC_PHYSICAL_UNKNOWN_CHALLENGE'}:
   {tenantId:endpoint.tenantId,rows:[{...row,value:'actual-material-change'}, {...row,value:'actual-material-change'}]}));return;
 }res.writeHead(404);res.end('{}');
});
await new Promise((yes,no)=>{server.once('error',no);server.listen(Number(new URL(endpoint.origin).port),'127.0.0.1',yes);});
const source={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo,encoding:'utf8'}).trim(),
 dirty:execFileSync('git',['status','--porcelain=v1','-uall'],{cwd:repo,encoding:'utf8'}),
 pins:await Promise.all(['qualification-runtime.mts','qualification-state-journal.mts'].map(async path=>({path,sha256:sha(await readFile(join(repo,'finnor-os/scripts/frontier5/x1',path)))})))};
await writeFile(join(root,'freeze.json'),JSON.stringify({source,input,originalSegmentDigest,originalResources:before.resources,
 publicTransportStorageTestOnly:true,protectedQualification:false,actualElapsedLiveDaysEstablished:false},null,2)+'\n',{mode:0o600});
let result;
try{result=await executeLiveObservationSlice({...input,durationSeconds:3});}
finally{delete process.env[variable];await new Promise(resolve=>server.close(resolve));}
await writeFile(join(root,'actual-transport-calls.json'),JSON.stringify(traffic,null,2)+'\n',{mode:0o600});
const after=await readQualificationCursor(input.cursorPath);
assert.equal(after.segments.length,before.segments.length+1);assert.equal(after.resources.slices.length,before.resources.slices.length+1);
assert.equal(sha(JSON.stringify(after.segments.slice(0,before.segments.length))),originalSegmentDigest,'immutable prior physical observations');
const reservedButUnissued=after.resources.acquisitionExposures-before.resources.acquisitionExposures-traffic.length,
 unacknowledged=traffic.length-(after.resources.acknowledgedAcquisitions-before.resources.acknowledgedAcquisitions);
assert.ok(reservedButUnissued>=0&&reservedButUnissued<=1);assert.ok(unacknowledged>=0&&unacknowledged<=1);
if(reservedButUnissued||unacknowledged)assert.ok(after.segments.at(-1).observations.some(o=>o.status==='UNKNOWN'));
assert.ok(after.resources.outputBytes>before.resources.outputBytes);assert.deepEqual(after.resources.limits,before.resources.limits);
assert.ok(after.segments.at(-1).observations.some(o=>o.status==='UNKNOWN'));
const materialRefs=after.segments.at(-1).receiptRefs.filter(r=>r.path.startsWith('live-owner-'));
for(const ref of materialRefs){const draft=JSON.parse(await readFile(join(previous,ref.path),'utf8'));
 assert.equal(draft.observations.length,2);assert.equal(draft.observations[0].identity,draft.observations[1].identity);}
assert.equal(materialRefs.length,10,'new material snapshot and duplicate multiplicity, not one receipt per unchanged poll');
const pointerBefore=await readFile(input.cursorPath),journalsBefore=await Promise.all((await readdir(previous)).filter(n=>n.endsWith('.journal')).map(async n=>({path:n,sha256:sha(await readFile(join(previous,n)))})));
process.env[variable]=token;
try{await assert.rejects(()=>executeLiveObservationSlice({...input,durationSeconds:1,limits:{...input.limits,maxAcquisitionCalls:input.limits.maxAcquisitionCalls+1}}),
 /ORIGINAL_AGGREGATE_EXECUTION_LIMITS_OR_COUNTERS_CHANGED/);}finally{delete process.env[variable];}
assert.deepEqual(await readFile(input.cursorPath),pointerBefore);
for(const entry of journalsBefore)assert.equal(sha(await readFile(join(previous,entry.path))),entry.sha256,'refused limit enlargement did not rewrite original journal');
let actual=pointerBefore.length;
for(const name of await readdir(previous))if(name.endsWith('.journal')||new Set(after.segments.flatMap(s=>s.receiptRefs).map(r=>r.path)).has(name))actual+=(await stat(join(previous,name))).size;
assert.equal(after.resources.outputBytes,actual);
await writeFile(join(root,'actual-transport-calls.json'),JSON.stringify(traffic,null,2)+'\n',{mode:0o600});
const receipt={status:'PASS_ACTUAL_SAME_CURSOR_RESUME_WITH_FAILURE_MATERIAL_CHANGE_AND_DUPLICATE',
 previousActualCalls:before.resources.acquisitionExposures,resumeActualCalls:traffic.length,reservedButUnissued,unacknowledged,totalRecordedExposures:after.resources.acquisitionExposures,
 originalLimitsRetained:true,oldPhysicalObservationsImmutable:true,actualUnknownRetained:true,materialDuplicateSnapshots:materialRefs.length,
 actualRecordedOutputBytes:actual,limitEnlargementRefusedWithoutJournalMutation:true,elapsedMs:performance.now()-began,
 protectedQualification:false,actualBusinessOwnerCompletion:false,actualElapsedLiveDaysEstablished:false};
await writeFile(join(root,'result.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));

return {receipt,evidenceRoot:root};
}
