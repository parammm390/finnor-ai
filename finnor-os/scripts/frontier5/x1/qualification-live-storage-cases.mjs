/** Transport/storage exercise, not a FINNOR business-owner completion fixture. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
export async function exerciseLiveStorage({repo,root}) {await mkdir(root,{mode:0o700});
const sha=s=>createHash('sha256').update(s).digest('hex'),began=performance.now(),startedAt=new Date().toISOString();
const tenant=randomUUID(),principal=randomUUID(),objectId=randomUUID(),token='PUBLIC_DISPOSABLE_STORAGE_PROBE_TOKEN';
const traffic=[];
const server=createServer(async(req,res)=>{
 const accepted=req.headers.authorization==='Bearer '+token;res.setHeader('content-type','application/json');
 if(!accepted){res.writeHead(401);res.end('{}');return;}
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(path==='/api/me'){traffic.push({at:new Date().toISOString(),path,status:200});res.end(JSON.stringify({tenantId:tenant,userId:principal,role:'owner'}));return;}
 if(path==='/api/works'){traffic.push({at:new Date().toISOString(),path,status:200});res.end(JSON.stringify({tenantId:tenant,rows:[{id:objectId,value:'storage-transport-only',accepted:true}]}));return;}
 res.writeHead(404);res.end('{}');
});
await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
const origin='http://127.0.0.1:'+server.address().port,variable='FINNOR_X1_QUAL_PUBLIC_STORAGE_PROBE';
assert.equal(process.env[variable],undefined);process.env[variable]=token;
const projections=Array.from({length:10},(_,i)=>({schema:'finnor.x1.independent-owner-read-projection.v1',environmentId:'public-storage-selector-'+i,
 owner:{origin,tenantId:tenant,principalId:principal,tokenEnvironmentVariable:variable},
 request:{path:'/api/works',method:'GET',readOnly:true,admittedOwnerReadReceiptDigest:sha('PUBLIC_TEST_NOT_ADMITTED_AUTHORITY'),
 responseIdentityPath:['tenantId'],expectedOwnerIdentity:tenant,appliedStatePredicates:[{path:['rows',0,'accepted'],equals:true}]},
 rowsPath:['rows'],identityPath:['id'],semanticFields:[['value']],kind:'MAPPING_CLAIMS',acceptance:[{path:['accepted'],equals:true}]}));
const limits={ref:'PUBLIC_STORAGE_TEST_ORIGINAL_64_MIB',registrationDigest:sha('PUBLIC_TEST_NOT_PROTECTED_GRANT'),
 maxAcquisitionCalls:1000000,maxOutputBytes:64*1024*1024,maxAggregateWallMs:7*86400000};
const input={projections,evidenceRoot:root,cursorPath:join(root,'live-cursor.json'),protocolDigest:sha('public-protocol'),
 candidateCutDigest:sha('public-candidate'),allocationConventionDigest:sha('public-allocation'),durationSeconds:30,pollIntervalMs:250,limits};
const {executeLiveObservationSlice}=await import(pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-runtime.mts')));
await writeFile(join(root,'freeze.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo,encoding:'utf8'}).trim(),runtime:process.version,input,startedAt,
 oracle:'finnor-os/scripts/frontier5/x1/reference/qualification-journal-native-review-contract.md',service:'PUBLIC_TRANSPORT_RECORDING_FIXTURE_NOT_BUSINESS_OWNER',
 protectedQualification:false,actualElapsedLiveDays:0},null,2)+'\n',{mode:0o600});
let result,failure;
try{result=await executeLiveObservationSlice(input);}catch(error){failure={predicate:error.message,stack:error.stack};}
finally{delete process.env[variable];await new Promise(resolve=>server.close(resolve));}
await writeFile(join(root,'actual-transport-calls.json'),JSON.stringify(traffic,null,2)+'\n',{mode:0o600});
let cursor;try{cursor=JSON.parse(await readFile(input.cursorPath,'utf8'));}catch{}
const size=async p=>{let sum=0;for(const e of await readdir(p,{withFileTypes:true})){const f=join(p,e.name);sum+=e.isDirectory()?await size(f):(await stat(f)).size;}return sum;};
const receipt={status:failure?'FAIL_REPRODUCTION_RETAINED':'PASS_FINITE_PHYSICAL_STORAGE_PROBE',failure:failure??null,
 actualPhysicalCalls:traffic.length,authCalls:traffic.filter(e=>e.path==='/api/me').length,readCalls:traffic.filter(e=>e.path==='/api/works').length,
 recordedResources:result?.state.resources??cursor?.resources,segment:result?.segment??null,
 elapsedMs:performance.now()-began,actualRetainedBytes:await size(root),actualBusinessOrOwnerCompletion:false,
 protectedQualification:false,actualElapsedLiveDaysEstablished:false};
await writeFile(join(root,'result.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({...receipt,segment:receipt.segment?{polls:receipt.segment.polls,observations:receipt.segment.observations.length}:null}));
if(failure)process.exitCode=1;

return {receipt,evidenceRoot:root,input};
}
