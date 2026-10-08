/** Role/domain/currentness story, not an independently equipped scientific gate. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {evidence,target,sha} from './test-support.mts';
import {requiredCapabilitySourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {createCapabilityLifecycle} from '../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {digest} from '../../packages/capability-evolution/src/contracts';
const run=await evidence('s8');
let port:any,compiler:any;
await run.story('interface-owner-port-before-implementation',[],async()=>{
 port=await import('../../packages/capability-evolution/src/interface-port');
 compiler=await import('../../packages/private-equity/src/interface-synthesis/compiler');
 return {resolved:true};
});
await run.story('real-interface-candidate-independent-role-and-current-reader',['P5-01','P5-02','P5-30','P5-34'],async()=>{
 assert.ok(port&&compiler,'Interface port unavailable');
 const f=await target(run.directory),tenant=randomUUID(),principal=randomUUID(),evaluator=randomUUID(),promoter=randomUUID();
 const pins=await Promise.all(requiredCapabilitySourcePaths.map(async path=>({path,sha256:sha(await readFile(path))})));
 const service=await createCapabilityLifecycle({tenant,principal,evaluator,promoter,rightsRef:'P5_DISPOSABLE_RIGHTS',sourcePins:pins});
 const ledger=await createEconomicLedger(tenant,principal,randomUUID(),{capabilityLifecycle:true,sealedEvaluation:true,financialPrincipal:evaluator,rightsRef:'P5_DISPOSABLE_RIGHTS'});
 try{
  await service.start();
  const call=async(role:string,operation:string,body:unknown,id=operation+':'+randomUUID())=>{
   const response=await fetch(service.endpoint()+'/command',{method:'POST',headers:{authorization:'Bearer '+service.tokens[role],'content-type':'application/json'},body:JSON.stringify({operation,requestId:id,body}),signal:AbortSignal.timeout(10000)});
   return {status:response.status,body:await response.json() as any};
  };
  const original={meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()};
  const generated=compiler.synthesizeApi(await (await fetch(f.origin+'/docs')).json(),original);
  const candidate=port.makeInterfaceCandidate({tenantId:tenant,principalId:principal,rightsRef:'P5_DISPOSABLE_RIGHTS',generated,
   domain:{account:'test-account',entities:['C_01'],field:'price',unit:'currency',currency:'USD',nullable:true,validAfter:service.after,validUntil:service.until},
   evidenceDigests:[digest('Public independent application state, not sealed admission')],dependencies:pins,proposedAt:new Date().toISOString()});
  const proposed=await call('proposer','INTERFACE_PROPOSE',candidate);assert.equal(proposed.status,200,JSON.stringify(proposed));
  const before=await call('consumer','INTERFACE_CURRENT',{revisionRef:candidate.ref});assert.equal(before.body.current,false);
  const denied=await call('proposer','INTERFACE_REGISTER',{});assert.equal(denied.status,403);
  const protocol={schema:'finnor.s8.interface-evaluation-protocol.v1',tenantId:tenant,principalId:principal,revisionRef:candidate.ref,evaluatorId:evaluator,registeredAt:new Date().toISOString(),
   domainDigest:digest(candidate.domain),payloadDigest:digest(candidate.payload),caseCommitments:[digest('exact'),digest('twenty-trap'),digest('null')],qualification:'PUBLIC_DEVELOPMENT_NOT_GATE_P5'};
  const registered=await call('evaluator','INTERFACE_REGISTER',service.signed(protocol,'evaluator'));assert.equal(registered.status,200,JSON.stringify(registered));
  const evaluation={schema:'finnor.s8.interface-evaluation.v1',tenantId:tenant,principalId:principal,revisionRef:candidate.ref,protocolRef:registered.body.ref,evaluatorId:evaluator,
   completedAt:new Date().toISOString(),payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),caseCommitments:protocol.caseCommitments,
   resultsDigest:digest('external public reference verdict'),disposition:'SUPPORTED_DISPOSABLE',falseVerifications:0,authorityViolations:0,protectedAdmission:false};
  const self=await call('proposer','INTERFACE_EVALUATE',service.signed(evaluation,'evaluator'));assert.equal(self.status,403);
  const evaluated=await call('evaluator','INTERFACE_EVALUATE',service.signed(evaluation,'evaluator'));assert.equal(evaluated.status,200,JSON.stringify(evaluated));
  const admitted=await call('promoter','INTERFACE_ADMIT',service.signed({schema:'finnor.s8.interface-admission.v1',revisionRef:candidate.ref,evaluationRef:evaluated.body.ref,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',executionAuthorityGranted:false},'promoter'));
  assert.equal(admitted.status,200,JSON.stringify(admitted));
  const current=await call('consumer','INTERFACE_CURRENT',{revisionRef:candidate.ref});assert.equal(current.body.current,true);assert.equal(current.body.protectedExecution,false);
  const substitution=structuredClone(candidate);substitution.payload.adapterModule.bytes+=' ';
  const bad=await call('proposer','INTERFACE_PROPOSE',substitution);assert.equal(bad.status,409);
  await service.stop();await service.start();
  const reload=await call('consumer','INTERFACE_CURRENT',{revisionRef:candidate.ref});assert.equal(reload.body.current,true);
  const revoked=await call('promoter','INTERFACE_REVOKE',service.signed({schema:'finnor.s8.interface-revocation.v1',revisionRef:candidate.ref,reason:'INTERFACE_DRIFT',expectedAdmissionRef:admitted.body.ref},'promoter'));assert.equal(revoked.status,200);
  const after=await call('consumer','INTERFACE_CURRENT',{revisionRef:candidate.ref});assert.equal(after.body.current,false);
  return {proposed,before,denied,registered,evaluated,admitted,current,bad,reload,revoked,after,qualification:'Disposable generated authority mechanics, not sealed evaluation or production trust'};
 }finally{await service.stop();await ledger.stop();await f.close();}
});
await run.finish();
