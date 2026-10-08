import {strict as assert} from 'node:assert';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from '../../packages/capability-evolution/src/contracts';
import {canonical} from '../../packages/governed-execution/src/protocol';
import {requiredCapabilitySourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {createCapabilityLifecycle} from '../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {evidence,target,sha} from './test-support.mts';
import {nativeFixture} from './native-fixture.mts';
const run=await evidence('consumer'),e=await nativeFixture(),f=await target(run.directory),evaluator=randomUUID(),promoter=randomUUID();
const pins=await Promise.all(requiredCapabilitySourcePaths.map(async path=>({path,sha256:sha(await readFile(path))})));
const service=await createCapabilityLifecycle({tenant:e.tenant,principal:e.actor,evaluator,promoter,rightsRef:'EXPLICIT_DISPOSABLE_TEST_ACCESS',sourcePins:pins});
const ledger=await createEconomicLedger(e.tenant,e.actor,randomUUID(),{capabilityLifecycle:true,sealedEvaluation:true,financialPrincipal:evaluator,rightsRef:'EXPLICIT_DISPOSABLE_TEST_ACCESS'});
let id='',candidate:any,admission:any,w:any,operation:any;
// The worker legitimately proposes and reads ordinary current status. It has
// neither evaluator nor promoter authority.
service.policy.actors.find(actor=>actor.id==='proposer')!.roles.push('CONSUMER');
await writeFile(service.configPath,JSON.stringify({signedPolicy:service.signed(service.policy,'release'),directory:join(service.root,'journal'),signerPath:join(service.root,'journal.pem')}),{mode:0o600});
await service.start();
const issuer=generateKeyPairSync('ed25519'),tokenPath=join(service.root,'p5-consumer-token'),policyPath=join(service.root,'p5-consumer-policy');
await writeFile(tokenPath,service.tokens.proposer,{mode:0o600});
const policy={schema:'finnor.s8.interface-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:e.tenant,principalId:e.actor,rightsRef:'EXPLICIT_DISPOSABLE_TEST_ACCESS',
 endpoint:service.endpoint(),tokenPath,tokenHash:sha(service.tokens.proposer),sourcePins:pins,validAfter:service.after,validUntil:service.until,timeoutMs:10000};
await writeFile(policyPath,JSON.stringify({body:policy,keyId:'disposable-interface-policy-root',signature:sign(null,Buffer.from(canonical(policy)),issuer.privateKey).toString('base64')}),{mode:0o600});
process.env.FINNOR_S8_INTERFACE_CONSUMER_CONFIG=policyPath;process.env.FINNOR_S8_INTERFACE_CONSUMER_ROOT=issuer.publicKey.export({type:'spki',format:'pem'}).toString();
const call=async(role:string,op:string,body:unknown)=>{
 const r=await fetch(service.endpoint()+'/command',{method:'POST',headers:{authorization:'Bearer '+service.tokens[role],'content-type':'application/json'},body:JSON.stringify({operation:op,requestId:op+':'+randomUUID(),body}),signal:AbortSignal.timeout(10000)});
 const reply={status:r.status,body:await r.json() as any};assert.equal(reply.status,200,JSON.stringify(reply));return reply.body;
};
await run.story('real-worker-proposal-consumer-policy-and-S8-attachment',['P5-01','P5-30'],async()=>{
 w=await e.work(f.origin);operation={meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()};
 const accepted=await e.api('interface-acquire',{schema:'finnor.p5.acquisition-request.v1',root:e.root,workId:w.workId,sourceAccessId:w.accessId,substrate:'API',mode:'ordinary_disposable',idempotencyKey:randomUUID(),operation});
 assert.equal(accepted.status,202);id=accepted.body.acquisitionId;const before=await e.finish(id);assert.equal(before.status,'PRACTICED',JSON.stringify(before));assert.equal(before.admission,null);
 candidate=(await e.admin.query('SELECT s8_candidate FROM finnor_os.p5_acquisitions WHERE id=$1',[id])).rows[0].s8_candidate;assert.ok(candidate?.ref);
 const oracle=await f.reference();assert.equal(oracle.records.C_01.price,2000);assert.equal(oracle.records.C_010.price,1000);assert.equal(oracle.writes.length,1);
 const protocol={schema:'finnor.s8.interface-evaluation-protocol.v1',tenantId:e.tenant,principalId:e.actor,revisionRef:candidate.ref,evaluatorId:evaluator,registeredAt:new Date().toISOString(),
  domainDigest:digest(candidate.domain),payloadDigest:digest(candidate.payload),caseCommitments:[digest('independent-disposable-target-state')],qualification:'PUBLIC_DEVELOPMENT_NOT_GATE_P5'};
 const registered=await call('evaluator','INTERFACE_REGISTER',service.signed(protocol,'evaluator'));
 const evaluated=await call('evaluator','INTERFACE_EVALUATE',service.signed({schema:'finnor.s8.interface-evaluation.v1',tenantId:e.tenant,principalId:e.actor,revisionRef:candidate.ref,protocolRef:registered.ref,evaluatorId:evaluator,
  completedAt:new Date().toISOString(),payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),caseCommitments:protocol.caseCommitments,resultsDigest:digest(oracle),
  disposition:'SUPPORTED_DISPOSABLE',falseVerifications:0,authorityViolations:0,protectedAdmission:false},'evaluator'));
 admission=await call('promoter','INTERFACE_ADMIT',service.signed({schema:'finnor.s8.interface-admission.v1',revisionRef:candidate.ref,evaluationRef:evaluated.ref,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),
  protectionDomain:'DISPOSABLE_TEST_AUTHORITY',executionAuthorityGranted:false},'promoter'));
 const attached=await e.api('interface-admission',{acquisitionId:id});assert.equal(attached.status,200,JSON.stringify(attached));assert.equal(attached.body.status,'SUPPORTED_DISPOSABLE');assert.equal(attached.body.admission.owner,'S8');
 return {before,registered,evaluated,admission,attached,oracle,qualification:'DISPOSABLE_SEPARATE_ROLE_TRANSPORT_NOT_SEALED_INDEPENDENT_ADMISSION'};
});
await run.story('catalogue-exact-refinement-and-live-preconditions',['P5-01','P5-12','P5-19','P5-29','P5-33'],async()=>{
 assert.ok(id&&operation);
 const catalogue=async(overrides:unknown)=>e.api('interface-catalogue',{root:e.root,workId:w.workId,operation:{...operation,priorRevision:'"v2"',operationId:randomUUID(),...overrides as object}});
 const compatible=await catalogue({value:'30.00'});assert.equal(compatible.status,200);assert.equal(compatible.body.reusable.length,1,JSON.stringify(compatible));
 const incompatible=[];
 for(const change of [{value:'20.001'},{value:'20,00'},{currency:'EUR'},{entity:'C_010'},{priorRevision:'"v1"'}]){
  const response=await catalogue(change);assert.equal(response.status,200);assert.equal(response.body.reusable.length,0,JSON.stringify({change,response}));incompatible.push({change,response});
 }
 const nullable=await catalogue({value:null});assert.equal(nullable.body.reusable.length,1);
 assert.equal((await f.reference()).writes.length,1);return {compatible,incompatible,nullable};
});
await run.story('S8-revocation-quarantines-P5-current-use',['P5-02','P5-21','P5-28','P5-30'],async()=>{
 assert.ok(candidate&&admission);
 const revoked=await call('promoter','INTERFACE_REVOKE',service.signed({schema:'finnor.s8.interface-revocation.v1',revisionRef:candidate.ref,reason:'DISPOSABLE_DOMAIN_REVOKED',expectedAdmissionRef:admission.ref},'promoter'));
 const read=await e.api('interface-read',{acquisitionId:id});assert.equal(read.status,200);assert.equal(read.body.status,'QUARANTINED');assert.equal(read.body.capability,null);
 const download=await e.api('interface-module',{acquisitionId:id,kind:'ADAPTER'});assert.equal(download.status,422);
 const retained=await f.reference();assert.equal(retained.writes.length,1);assert.equal(retained.records.C_010.price,1000);
 return {revoked,read,download,retained};
});
delete process.env.FINNOR_S8_INTERFACE_CONSUMER_CONFIG;delete process.env.FINNOR_S8_INTERFACE_CONSUMER_ROOT;
await service.stop();await ledger.stop();await f.close();await e.close();await run.finish();
