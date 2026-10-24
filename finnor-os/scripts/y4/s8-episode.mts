/** Actual emitted S8 lifecycle, real native proof and separate local ledger.
 * Its posthoc construction review is explicitly not a protected campaign. */
import {strict as assert} from 'node:assert';
import {randomUUID,sign,createHash,type KeyObject} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createEconomicLedger} from '../s7/ledger-fixture.mjs';
import {canonical,sha} from '../../packages/private-equity/src/confidential-computation/contracts';
import {digest} from '../../packages/capability-evolution/src/contracts';
import {makeConfidentialCandidate} from '../../packages/capability-evolution/src/confidential-port';
import {installedProcess} from './product-transport.mjs';
import {artifact} from './environment.mjs';
export async function confidentialS8Episode(input:{
 installation:string;privateDirectory:string;evidence:string;appUrl:string;admin:any;
 tenant:string;principal:string;evaluator:string;computationId:string;releaseId:string;deadlineAt:string;
 consumerPolicyKey:KeyObject;call:(operation:string,body:unknown)=>Promise<any>;
}){
 // Reuse only the disposable policy/key constructor, never its source server.
 const {createCapabilityLifecycle}=await import(new URL('../s8/lifecycle-fixture.mts',import.meta.url).href);
 const raw=await import(pathToFileURL(join(input.installation,
  'runtime/finnor-os/packages/capability-evolution/src/source-closure.ts')).href),
  closure=raw.confidentialSourcePaths?raw:raw.default;
 const sourcePins=await Promise.all((await closure.confidentialSourcePaths()).map(async(path:string)=>({
  path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
 assert(sourcePins.length<=256);
 const original=(await input.admin.query('SELECT request FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2',
  [input.tenant,input.computationId])).rows[0],rightsRef=sha(original.request.function.release),
  service=await createCapabilityLifecycle({tenant:input.tenant,principal:input.principal,evaluator:input.evaluator,
   promoter:randomUUID(),rightsRef,sourcePins});
 const names=['FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT'],
  previous=Object.fromEntries(names.map(k=>[k,process.env[k]])),cwd=process.cwd();
 let ledger:Awaited<ReturnType<typeof createEconomicLedger>>|undefined,
  host:Awaited<ReturnType<typeof installedProcess>>|undefined,proxy:Server|undefined,ledgerProxy:Server|undefined,
  proxyOrigin='',lostResponse=false,loseProposal=true,closed=false,ledgerDropRef:string|null=null,ledgerLostResponse=false;
 const close=async()=>{
  if(closed)return;closed=true;
  proxy?.closeAllConnections();if(proxy?.listening)await new Promise<void>(yes=>proxy!.close(()=>yes()));
  await host?.close();
  ledgerProxy?.closeAllConnections();if(ledgerProxy?.listening)await new Promise<void>(yes=>ledgerProxy!.close(()=>yes()));
  await ledger?.stop();await service.stop();
  for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
 };
 try{
  // This proxy can lose the inner ledger acknowledgement, before the native
  // lifecycle has any accepted-operation record, not just its outer response.
  ledgerProxy=createServer(async(req,res)=>{
   try{
    assert(ledger&&req.url?.startsWith('/')&&!req.url.startsWith('//'));
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){size+=chunk.length;assert(size<=262144);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),command=bytes.length?JSON.parse(bytes.toString()):null,
     upstream=await fetch(ledger.endpoint()+req.url,{method:req.method,
      headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},
      ...(bytes.length?{body:bytes}:{}),redirect:'error',signal:AbortSignal.timeout(10000)}),
     reply=Buffer.from(await upstream.arrayBuffer());
    assert(reply.length<=1048576);
    if(ledgerDropRef&&command?.reference?.id===ledgerDropRef&&upstream.status===200){
     ledgerDropRef=null;ledgerLostResponse=true;res.destroy();return;
    }
    res.writeHead(upstream.status,{'content-type':'application/json'});res.end(reply);
   }catch{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"code":"LOCAL_LEDGER_TRANSPORT_UNAVAILABLE"}');}
  });
  await new Promise<void>(yes=>ledgerProxy!.listen(0,'127.0.0.1',yes));
  const ledgerAddress=ledgerProxy.address();assert(ledgerAddress&&typeof ledgerAddress!=='string');
  // The ledger child and its pinned sources come from this installation too.
  try{
   process.chdir(join(input.installation,'runtime/finnor-os'));
   ledger=await createEconomicLedger(input.tenant,input.principal,randomUUID(),
    {capabilityLifecycle:true,rightsRef,financialPrincipal:input.evaluator,
     transportEndpoint:'http://127.0.0.1:'+ledgerAddress.port});
  }finally{process.chdir(cwd);}
 const configuration=JSON.parse(await readFile(service.configPath,'utf8')),
  validUntil=new Date(Math.min(Date.parse(service.until),Date.parse(input.deadlineAt))).toISOString();
 configuration.signedPolicy=service.signed({...service.policy,validUntil,
  actors:service.policy.actors.map((a:any)=>a.id==='proposer'?{...a,roles:['PROPOSER','CONSUMER']}:a)},'release');
 await writeFile(service.configPath,JSON.stringify(configuration),{mode:0o600});
 const tokenPath=join(service.root,'confidential-proposer.token'),configPath=join(input.privateDirectory,'s8-consumer-policy.json');
 await writeFile(tokenPath,service.tokens.proposer!,{mode:0o600});
 const bind=async()=>{
  const body={schema:'finnor.s8.confidential-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',
   tenantId:input.tenant,principalId:input.principal,rightsRef,endpoint:proxyOrigin,tokenPath,
   tokenHash:createHash('sha256').update(service.tokens.proposer!).digest('hex'),sourcePins,
   validAfter:service.after,validUntil,timeoutMs:10000};
  await writeFile(configPath,JSON.stringify({body,keyId:'y4-local-consumer-root',
   signature:sign(null,Buffer.from(canonical(body)),input.consumerPolicyKey).toString('base64')}),{mode:0o600});
 };
 const start=async()=>{
  host=await installedProcess('capability-service',input.installation,{
   DATABASE_URL:input.appUrl,FINNOR_S8_LIFECYCLE_CONFIG:service.configPath,FINNOR_S8_RELEASE_ROOT:service.pub('release'),
   FINNOR_S6_OWNER_TRANSPORT_CONFIG:process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG!,
   FINNOR_S6_OWNER_TRANSPORT_ROOT:process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT!,
  },input.privateDirectory);
  assert.equal(host.ready.actualEmittedCapabilityService,true);
 };
 const call=async(role:string,operation:string,body:unknown,requestId=randomUUID())=>{
  assert(host);const response=await fetch(host.ready.origin+'/command',{method:'POST',
   headers:{authorization:'Bearer '+service.tokens[role]!, 'content-type':'application/json'},
   body:JSON.stringify({operation,body,requestId}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json()};
 };
 const ok=(r:any)=>{assert.equal(r.status,200);return r.body;};
  await start();
  proxy=createServer(async(req,res)=>{
   try{
    assert(req.method==='POST'&&req.url==='/command'&&host);
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){size+=chunk.length;assert(size<=262144);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),command=JSON.parse(bytes.toString()),native=await fetch(host.ready.origin+'/command',{
     method:'POST',headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},
     body:bytes,redirect:'error',signal:AbortSignal.timeout(10000)}),reply=Buffer.from(await native.arrayBuffer());
    assert(reply.length<=262144);
    if(loseProposal&&command.operation==='CONFIDENTIAL_PROPOSE'&&native.status===200){
     loseProposal=false;lostResponse=true;res.destroy();return;
    }
    res.writeHead(native.status,{'content-type':'application/json'});res.end(reply);
   }catch{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"code":"LOCAL_S8_TRANSPORT_UNAVAILABLE"}');}
  });
  await new Promise<void>(yes=>proxy!.listen(0,'127.0.0.1',yes));
  const address=proxy.address();assert(address&&typeof address!=='string');proxyOrigin='http://127.0.0.1:'+address.port;
  await bind();
  const proposedInput={computationId:input.computationId,releaseId:input.releaseId,idempotencyKey:randomUUID()},
   lost=await input.call('confidential-s8-propose',proposedInput);
  assert(lost.status>=500);assert(lostResponse);
  const proposed=ok(await input.call('confidential-s8-propose',proposedInput)),candidate=proposed.candidate;
  assert.deepEqual(ok(await input.call('confidential-s8-propose',proposedInput)),proposed);
  const history=ok(await call('reader','READ',{}));
  assert.equal(history.history.filter((v:any)=>v.operation==='CONFIDENTIAL_PROPOSE').length,1);
  assert.equal(ok(await call('consumer','CONFIDENTIAL_CURRENT',{revisionRef:candidate.ref})).current,false);
  const basis=(await input.admin.query('SELECT correspondence,runtime_receipt FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2',
   [input.tenant,input.computationId])).rows[0],
   evidenceDigest=sha({payload:candidate.payload,correspondence:basis.correspondence,nativeReceipts:basis.runtime_receipt}),
   common={revisionRef:candidate.ref,evidenceDigest,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain)};
  const review={schema:'finnor.s8.confidential-review.v1',...common,evaluatorId:input.evaluator,
   registeredAt:new Date().toISOString(),qualification:'POSTHOC_NATIVE_CONSTRUCTION_REVIEW_NOT_PROTECTED_CAMPAIGN'};
  assert.equal((await call('proposer','CONFIDENTIAL_REGISTER',service.signed(review,'evaluator'))).status,403);
  const registered=ok(await call('evaluator','CONFIDENTIAL_REGISTER',service.signed(review,'evaluator'))),
   evaluation={schema:'finnor.s8.confidential-evaluation.v1',...common,protocolRef:registered.ref,
    evaluatorId:input.evaluator,completedAt:new Date().toISOString(),disposition:'CHECKED_CONSTRUCTION_ONLY',protectedAdmission:false};
  assert.equal((await call('proposer','CONFIDENTIAL_EVALUATE',service.signed(evaluation,'evaluator'))).status,403);
  assert.equal((await call('evaluator','CONFIDENTIAL_EVALUATE',service.signed({...evaluation,evidenceDigest:'0'.repeat(64)},'evaluator'))).status,409);
  const evaluated=ok(await call('evaluator','CONFIDENTIAL_EVALUATE',service.signed(evaluation,'evaluator'))),
   admissionBody={schema:'finnor.s8.confidential-admission.v1',...common,evaluationRef:evaluated.ref,
    protectionDomain:'DISPOSABLE_TEST_AUTHORITY',scope:'RECIPIENT_LOCAL_ANALYTICAL_CONSTRUCTION_ONLY',
    protectedAdmission:false,executionAuthorityGranted:false},
   signedAdmission=service.signed(admissionBody,'promoter'),admissionRequestId=randomUUID(),
   admitted=ok(await call('promoter','CONFIDENTIAL_ADMIT',signedAdmission,admissionRequestId)),
   request={computationId:input.computationId,releaseId:input.releaseId,revisionRef:candidate.ref};
  assert.equal(ok(await input.call('confidential-s8-current',request)).current,true);
  await host!.close();await start();
  assert.equal(ok(await input.call('confidential-s8-current',request)).current,true);
  const {ref:_,...candidateBody}=candidate,
   pendingCandidate=makeConfidentialCandidate({...candidateBody,proposedAt:new Date().toISOString(),
    domain:{...candidate.domain,validUntil:new Date(Math.min(Date.parse(validUntil),Date.now()+20000)).toISOString()}}),
   pendingRequestId=randomUUID();
  assert(Date.parse(pendingCandidate.domain.validUntil)>Date.now()+15000);
  ledgerDropRef=pendingCandidate.ref.id;
  const pending=await call('proposer','CONFIDENTIAL_PROPOSE',pendingCandidate,pendingRequestId);
  assert(pending.status>=500);assert(ledgerLostResponse);
  await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(pendingCandidate.domain.validUntil)-Date.now()+50)));
  await host!.close();await start();
  const recovered=ok(await call('reader','READ',{})).history.filter((v:any)=>v.requestId===pendingRequestId);
  assert.equal(recovered.length,1);assert.equal(recovered[0].operation,'CONFIDENTIAL_PROPOSE');
  assert.equal(ok(await call('consumer','CONFIDENTIAL_CURRENT',{revisionRef:pendingCandidate.ref})).current,false);
  assert((await call('proposer','CONFIDENTIAL_PROPOSE',pendingCandidate,pendingRequestId)).status>=400);
  assert.equal(ok(await input.call('confidential-s8-current',request)).current,true);
  const summary={actualEmittedService:true,actualSeparateLedger:true,sourcePins:sourcePins.length,
   actualNativeChecker:true,lostResponseAfterRealAcceptance:true,oneImmutableProposal:true,
   independentEvaluatorAndPromoterKeys:true,selfAdmissionDenied:true,substitutedEvidenceDenied:true,coldRestartCurrent:true,
   lostInnerLedgerAcknowledgementBeforeAcceptanceJournal:true,expiredAcceptedIntentRecoveredByExactReadback:true,
   recoveredHistoricalAcceptanceNeverGrantsCurrentUse:true,
   qualification:'POSTHOC_NATIVE_CONSTRUCTION_REVIEW_NOT_PROTECTED_CAMPAIGN',protectedAdmission:false,executionAuthorityGranted:false};
  await artifact(input.evidence,'s8-construction-review.json',{schema:'finnor.y4.s8-construction-e2e.v1',
   summary,candidateRef:candidate.ref,reviewRef:registered.ref,evaluationRef:evaluated.ref,admissionRef:admitted.ref});
  return {summary,close,afterNativeInvalidation:async()=>{
   assert((await input.call('confidential-s8-current',request)).status>=400);
   assert.equal(ok(await call('consumer','CONFIDENTIAL_CURRENT',{revisionRef:candidate.ref})).current,false);
   assert((await call('promoter','CONFIDENTIAL_ADMIT',signedAdmission,admissionRequestId)).status>=400);
   ok(await call('promoter','CONFIDENTIAL_REVOKE',service.signed({
    schema:'finnor.s8.confidential-revocation.v1',revisionRef:candidate.ref,expectedAdmissionRef:admitted.ref,
    reason:'Retain revoked native dependency; deny future construction admission'},'promoter')));
   await host!.close();await start();
   const current=ok(await call('consumer','CONFIDENTIAL_CURRENT',{revisionRef:candidate.ref}));
   assert.equal(current.current,false);assert.equal(current.candidate,null);
   return {nativeInvalidationDenied:true,staleAdmissionReplayDenied:true,stickyRevocationAfterColdRestart:true,
    historicalReviewRetained:true,protectedAdmission:false,executionAuthorityGranted:false};
  }};
 }catch(error){await close();throw error;}
}
