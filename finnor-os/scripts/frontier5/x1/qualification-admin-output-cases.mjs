/** Actual admin command/output accounting with an explicitly public test policy.
 * No policy is installed in a service and no business/custody claim is made. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {createHash,createPrivateKey,sign,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function exerciseAdminOutput({repo,corpusRoot,root,bootstrap=true}) {await mkdir(root,{mode:0o700});
const began=performance.now(),sha=b=>createHash('sha256').update(b).digest('hex');
const {digest}=await import(pathToFileURL(join(repo,'finnor-os/packages/capability-evolution/src/contracts.ts')));
const {canonical}=await import(pathToFileURL(join(repo,'finnor-os/packages/governed-execution/src/protocol.ts')));
const {executeLiveObservationSlice}=await import(pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-runtime.mts')));
const {readQualificationCursor}=await import(pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-state-journal.mts')));
const protocolSigned=JSON.parse(await readFile(join(corpusRoot,'assessment/public-fixture-protocol.json'),'utf8')),
 policy=JSON.parse(await readFile(join(corpusRoot,'assessment/public-fixture-policy.json'),'utf8')),
 protocol=protocolSigned.body,envs=protocol.environments;
const vectors=JSON.parse(await readFile(join(repo,'finnor-os/scripts/frontier5/x1/reference/public-ed25519-test-vectors.json'),'utf8')).vectors;
const keys=vectors.map(v=>createPrivateKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',d:Buffer.from(v.seedHex,'hex').toString('base64url'),x:Buffer.from(v.publicHex,'hex').toString('base64url')}}));
const signed=(body,i)=>({body,keyId:policy[i?'observerKeys':'custodianKeys'][0].id,
 signature:sign(null,Buffer.from(canonical(body)),keys[i]).toString('base64')});
const pin=async(name,body)=>{const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');const path=join(root,name);await writeFile(path,bytes,{flag:'wx',mode:0o600});return {path,sha256:sha(bytes)};};
const tenantId=randomUUID(),principalId=randomUUID(),object=randomUUID(),token='PUBLIC_ADMIN_STORAGE_TOKEN',variable='FINNOR_X1_QUAL_PUBLIC_ADMIN_STORAGE';
const traffic=[];
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
 if(path==='/api/me'){traffic.push({at:new Date().toISOString(),path});res.end(JSON.stringify({tenantId,userId:principalId,role:'owner'}));return;}
 if(path==='/api/works'){traffic.push({at:new Date().toISOString(),path});res.end(JSON.stringify({tenantId,rows:[{id:object,value:'PUBLIC_TRANSPORT_NOT_BUSINESS_TRUTH',accepted:true}]}));return;}
 res.writeHead(404);res.end('{}');});
await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
const owner={origin:'http://127.0.0.1:'+server.address().port,tenantId,principalId,tokenEnvironmentVariable:variable};
const projections=envs.map(e=>({schema:'finnor.x1.independent-owner-read-projection.v1',environmentId:e.id,owner,
 request:{path:'/api/works',method:'GET',readOnly:true,admittedOwnerReadReceiptDigest:sha('PUBLIC_NO_ADMITTED_OWNER_AUTHORITY'),
 responseIdentityPath:['tenantId'],expectedOwnerIdentity:tenantId,appliedStatePredicates:[{path:['rows',0,'accepted'],equals:true}]},
 rowsPath:['rows'],identityPath:['id'],semanticFields:[['value']],kind:'MAPPING_CLAIMS',acceptance:[{path:['accepted'],equals:true}]}));
const executionRoot=join(root,'execution');await mkdir(executionRoot,{mode:0o700});const cursorPath=join(executionRoot,'cursor.json'),
 envelope=protocol.envelopes.validation,limits={ref:envelope.ref,registrationDigest:digest(envelope),maxAcquisitionCalls:envelope.maxAcquisitionCalls,
 maxAggregateWallMs:envelope.maxWallSeconds*1000,maxOutputBytes:64*1024*1024};
process.env[variable]=token;
const input={projections,evidenceRoot:executionRoot,cursorPath,protocolDigest:digest(protocol),candidateCutDigest:digest(protocol.candidateCut),
 allocationConventionDigest:protocol.allocationConventionDigest,durationSeconds:1,pollIntervalMs:60000,limits};
const size=async directory=>{let n=0;for(const e of await readdir(directory,{withFileTypes:true})){const path=join(directory,e.name);n+=e.isDirectory()?await size(path):(await stat(path)).size;}return n;};
const results=[];
try{
 if(bootstrap)await executeLiveObservationSlice(input);
 const generation=JSON.parse(await readFile(join(corpusRoot,'generator/withheld/generation-manifest.json'),'utf8'));
 const oracleLedgers=[];
 for(const [i,e]of generation.environments.entries()){
  const draft=JSON.parse(await readFile(join(corpusRoot,'generator/withheld',e.scoringOraclePin.name),'utf8'));
  oracleLedgers.push(await pin('public-oracle-'+i+'.json',signed(draft.body,0)));
 }
 const control={schema:'finnor.x1.qualification-control.v1',registration:await pin('public-registration.json',signed(protocol,0)),
 trustPolicy:await pin('public-policy.json',policy),publicInputs:await pin('public-inputs.json',{publicNonexecutingChallenge:true}),
 oracleLedgers,observationPackets:[],privateEvidenceRoot:root,independentReadProjections:await pin('public-projections.json',projections),
 executionEvidenceRoot:executionRoot,executionCursorPath:cursorPath};
 const controlPin=await pin('public-control.json',control);
 await pin('freeze.json',{input,controlPin,oracle:'finnor-os/scripts/frontier5/x1/reference/qualification-admin-output-native-review-contract.md',
  sourcePins:await Promise.all(['qualification-admin.mts','qualification-runtime.mts','qualification-state-journal.mts'].map(async path=>
   ({path,sha256:sha(await readFile(join(repo,'finnor-os/scripts/frontier5/x1',path)))}))),
  publicRFC8032PolicyOnly:true,protectedPolicyInstalled:false,actualBusinessOwnerOrCustody:false});
 for(let ordinal=1;ordinal<=2;ordinal++){
  let before;try{before=await readQualificationCursor(cursorPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  const beforeFiles=await size(executionRoot),out=join(root,'actual-admin-command-'+ordinal),
   argv=['--max-old-space-size=768','--import=tsx','scripts/frontier5/x1/qualification-admin.mts','collect','--control',controlPin.path,
    '--evidence',out,'--trust-sha256',control.trustPolicy.sha256,'--seconds','1'];
  const child=spawn('/usr/local/bin/node',argv,{cwd:join(repo,'finnor-os'),env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
   HOME:root,TMPDIR:'/tmp',NODE_ENV:'test',LOG_LEVEL:'silent',[variable]:token},stdio:['ignore','pipe','pipe']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;if(output.length>1024*1024)child.kill('SIGTERM');});
  const ending=await new Promise((yes,no)=>{const timer=setTimeout(()=>child.kill('SIGTERM'),30000);child.once('error',no);child.once('close',(code,signal)=>{clearTimeout(timer);yes({code,signal});});});
  await writeFile(join(root,'actual-admin-command-'+ordinal+'.log'),output,{flag:'wx',mode:0o600});
  assert.equal(ending.code,0,output);assert.equal(ending.signal,null);
  const after=await readQualificationCursor(cursorPath),executionByteGrowth=(await size(executionRoot))-beforeFiles,commandBytes=await size(out),
   recordedDelta=after.resources.outputBytes-(before?.resources.outputBytes??0),expectedDelta=executionByteGrowth+commandBytes;
  if(before){assert.deepEqual(after.phasePin,before.phasePin);assert.deepEqual(after.resources.limits,before.resources.limits);}
  else{assert.equal(after.phasePin.protocolDigest,digest(protocol));assert.deepEqual(after.resources.limits,limits);}
  results.push({id:'actual-admin-output-'+ordinal,status:recordedDelta===expectedDelta?'PASS':'FAIL',argv,
   actualExitCode:ending.code,recordedDelta,executionByteGrowth,commandBytes,expectedDelta,
   missingCommandOutputCharge:expectedDelta-recordedDelta,originalPhaseAndLimitsRetained:true});
 }
}finally{delete process.env[variable];await new Promise(resolve=>server.close(resolve));}
await pin('actual-transport-calls.json',traffic);
const receipt={status:results.every(r=>r.status==='PASS')?'PASS_ACTUAL_ADMIN_OUTPUT_EXACTLY_ONCE':'FAIL_ACTUAL_ADMIN_OUTPUT_ACCOUNTING',
 results,actualHTTPCalls:traffic.length,elapsedMs:performance.now()-began,protectedQualification:false,
 actualBusinessOwnerCompletion:false,actualElapsedLiveDaysEstablished:false,protectedPolicyOrServiceChanged:false};
await pin('result.json',receipt);console.log(JSON.stringify(receipt));if(receipt.status.startsWith('FAIL'))process.exitCode=1;

return {receipt,evidenceRoot:root};
}
