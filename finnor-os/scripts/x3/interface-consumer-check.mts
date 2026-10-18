/** Genuine existing S8 INTERFACE consumer regression, not P5 qualification. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {target,sha} from '../p5/test-support.mts';
import {createCapabilityLifecycle} from '../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {requiredCapabilitySourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {digest} from '../../packages/capability-evolution/src/contracts';
import {makeInterfaceCandidate} from '../../packages/capability-evolution/src/interface-port';
import {interfaceConsumerPolicy,proposeInterfaceCandidate,currentInterfaceCandidate} from '../../packages/capability-evolution/src/interface-consumer';
import {synthesizeApi} from '../../packages/private-equity/src/interface-synthesis/compiler';
import {artifact} from './environment.mts';
import {lifecycleCall} from './s8-installed.mts';

const directory=process.env.FINNOR_X3_EVIDENCE_DIR;
assert(directory,'FINNOR_X3_EVIDENCE_DIR must name a new disposable evidence directory');
await mkdir(directory,{recursive:true});
const privateDirectory=await mkdtemp(join(tmpdir(),'x3-interface-consumer-')),f=await target(privateDirectory);
const tenant=randomUUID(),principal=randomUUID(),evaluator=randomUUID(),promoter=randomUUID(),rightsRef='X3_INTERFACE_TRANSPORT_DISPOSABLE_RIGHTS';
const pins=await Promise.all(requiredCapabilitySourcePaths.map(async path=>({path,sha256:sha(await readFile(path))})));
const service=await createCapabilityLifecycle({tenant,principal,evaluator,promoter,rightsRef,sourcePins:pins});
const ledger=await createEconomicLedger(tenant,principal,randomUUID(),{capabilityLifecycle:true,sealedEvaluation:true,financialPrincipal:evaluator,rightsRef});
try{
 const config=JSON.parse(await readFile(service.configPath,'utf8'));
 config.signedPolicy=service.signed({...service.policy,actors:service.policy.actors.map(actor=>actor.id==='proposer'?{...actor,roles:['PROPOSER','CONSUMER']}:actor)},'release');
 await writeFile(service.configPath,JSON.stringify(config),{mode:0o600});await service.start();
 const call=(role:string,operation:string,body:unknown)=>lifecycleCall(service,role,operation,body);
 const tokenPath=join(privateDirectory,'consumer.token'),policyPath=join(privateDirectory,'consumer.json');
 const bearer=service.tokens.proposer;assert(bearer);
 await writeFile(tokenPath,bearer,{mode:0o600});
 process.env.FINNOR_S8_INTERFACE_CONSUMER_CONFIG=policyPath;process.env.FINNOR_S8_INTERFACE_CONSUMER_ROOT=service.pub('release');
 const consumer=async()=>{
  const policy={schema:'finnor.s8.interface-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:tenant,principalId:principal,rightsRef,
   endpoint:service.endpoint(),tokenPath,tokenHash:sha(bearer),sourcePins:pins,validAfter:service.after,validUntil:service.until,timeoutMs:10000};
  await writeFile(policyPath,JSON.stringify(service.signed(policy,'release')),{mode:0o600});
  const parsed=await interfaceConsumerPolicy({tenantId:tenant,principalId:principal,rightsRef});assert(parsed);return parsed;
 };
 const generated=synthesizeApi(await (await fetch(f.origin+'/docs')).json(),{meaning:'set-record-field',account:'test-account',entity:'C_01',field:'price',
  unit:'currency',currency:'USD',value:'20.00',tolerance:'0',priorRevision:'"v1"',operationId:randomUUID()});
 const candidate=makeInterfaceCandidate({tenantId:tenant,principalId:principal,rightsRef,generated,
  domain:{account:'test-account',entities:['C_01'],field:'price',unit:'currency',currency:'USD',nullable:true,validAfter:service.after,validUntil:service.until},
  evidenceDigests:[digest('PUBLIC_TRANSPORT_NEGATIVE_AND_CURRENTNESS_MECHANICS_NOT_INDEPENDENT_QUALIFICATION')],dependencies:pins,proposedAt:new Date().toISOString()});
 const proposed=await proposeInterfaceCandidate(candidate,await consumer());assert.deepEqual(proposed,candidate.ref);
 const before=await currentInterfaceCandidate(candidate,await consumer(),randomUUID());assert.equal(before,null);
 const protocol={schema:'finnor.s8.interface-evaluation-protocol.v1',tenantId:tenant,principalId:principal,revisionRef:candidate.ref,evaluatorId:evaluator,
  registeredAt:new Date().toISOString(),domainDigest:digest(candidate.domain),payloadDigest:digest(candidate.payload),
  caseCommitments:[digest('public exact'),digest('public twenty-trap'),digest('public null')],qualification:'PUBLIC_DEVELOPMENT_NOT_GATE_P5'};
 const registered=await call('evaluator','INTERFACE_REGISTER',service.signed(protocol,'evaluator'));assert.equal(registered.status,200,JSON.stringify(registered));
 const evaluation={schema:'finnor.s8.interface-evaluation.v1',tenantId:tenant,principalId:principal,revisionRef:candidate.ref,protocolRef:registered.body.ref,
  evaluatorId:evaluator,completedAt:new Date().toISOString(),payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),
  caseCommitments:protocol.caseCommitments,resultsDigest:digest('PUBLIC_TRANSPORT_MECHANICS_ONLY'),disposition:'SUPPORTED_DISPOSABLE',
  falseVerifications:0,authorityViolations:0,protectedAdmission:false};
 const evaluated=await call('evaluator','INTERFACE_EVALUATE',service.signed(evaluation,'evaluator'));assert.equal(evaluated.status,200,JSON.stringify(evaluated));
 const admitted=await call('promoter','INTERFACE_ADMIT',service.signed({schema:'finnor.s8.interface-admission.v1',revisionRef:candidate.ref,
  evaluationRef:evaluated.body.ref,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),
  protectionDomain:'DISPOSABLE_TEST_AUTHORITY',executionAuthorityGranted:false},'promoter'));assert.equal(admitted.status,200,JSON.stringify(admitted));
 const current=await currentInterfaceCandidate(candidate,await consumer(),randomUUID());assert.deepEqual(current,admitted.body.ref);
 await service.stop();await service.start();
 const restarted=await currentInterfaceCandidate(candidate,await consumer(),randomUUID());assert.deepEqual(restarted,admitted.body.ref);
 const revoked=await call('promoter','INTERFACE_REVOKE',service.signed({schema:'finnor.s8.interface-revocation.v1',revisionRef:candidate.ref,
  reason:'INTERFACE_DRIFT',expectedAdmissionRef:admitted.body.ref},'promoter'));assert.equal(revoked.status,200,JSON.stringify(revoked));
 const after=await currentInterfaceCandidate(candidate,await consumer(),randomUUID());assert.equal(after,null);
 await artifact(directory,'result.json',{status:'PASS_EXISTING_INTERFACE_CONSUMER_TRANSPORT',proposed,before,registered,evaluated,admitted,current,restarted,revoked,after,
  sourcePins:pins.length,authBypass:false,qualification:'Disposable signed S8 transport and currentness mechanics only',
  independentApplicationPasses:0,protectedAdmission:false,executionAuthorityGranted:false,production:false});
 console.log('X3_INTERFACE_CONSUMER_COMPATIBILITY_PASS');
}finally{await service.stop();await ledger.stop();await f.close();}
