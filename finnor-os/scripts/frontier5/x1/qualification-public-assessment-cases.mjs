/** Public RFC8032 test material only. Never install this policy in a service.
 * No real custody, source authority, qualification or elapsed live time is claimed. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function exercisePublicAssessment({repo,previous,root}) {
assert.ok([repo,previous,root].every(p=>p?.startsWith('/')));
await mkdir(root,{mode:0o700});const began=performance.now(),sha=s=>createHash('sha256').update(s).digest('hex');
let bytesWritten=0;
const save=async(name,body)=>{const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');bytesWritten+=bytes.length;
 assert.ok(bytesWritten<=64*1024*1024&&performance.now()-began<180000);await writeFile(join(root,name),bytes,{flag:'wx',mode:0o600});};
const {validateQualificationRegistration,assessInstitutionQualification}=await import(pathToFileURL(join(repo,'finnor-os/packages/private-equity/src/institution-qualification/administration.ts')));
const {digest}=await import(pathToFileURL(join(repo,'finnor-os/packages/capability-evolution/src/contracts.ts')));
const {canonical}=await import(pathToFileURL(join(repo,'finnor-os/packages/governed-execution/src/protocol.ts')));
const h=s=>sha('PUBLIC_NONAUTHORITATIVE_CONTRACT:'+s);
const corpusBytes=await readFile(join(repo,'finnor-os/scripts/frontier5/x1/reference/public-ed25519-test-vectors.json')),
 corpus=JSON.parse(corpusBytes.toString('utf8'));
assert.equal(corpus.sourceDocumentSha256,'ed63657ff389301282b169b0abde9b5dd2c7e4d524fdfa5da6ff3094fc93c4c3');
assert.equal(corpus.publicNonAuthoritativeTestMaterial,true);assert.equal(corpus.mustNeverBeInstalledAsAuthority,true);
const vectors=corpus.vectors.map(({seedHex:seed,publicHex})=>{
 assert.equal(seed.length,64);assert.equal(publicHex.length,64);
 const key=createPrivateKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',d:Buffer.from(seed,'hex').toString('base64url'),x:Buffer.from(publicHex,'hex').toString('base64url')}});
 assert.equal(createPublicKey(key).export({format:'jwk'}).x,Buffer.from(publicHex,'hex').toString('base64url'));
 return {key,publicKey:createPublicKey(key).export({format:'pem',type:'spki'}).toString(),publicHex};});
assert.equal(sign(null,Buffer.alloc(0),vectors[0].key).toString('hex'),
 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
const control=JSON.parse(await readFile(join(previous,'public-control.json'),'utf8')),
 manifest=JSON.parse(await readFile(join(previous,'withheld/generation-manifest.json'),'utf8')),
 profile=JSON.parse(await readFile(control.profile.path,'utf8'));
const oracleBodies=await Promise.all(manifest.environments.map(async e=>JSON.parse(await readFile(join(previous,'withheld',e.scoringOraclePin.name),'utf8')).body));
const publicInputs=await Promise.all(manifest.environments.map(async e=>JSON.parse(await readFile(join(previous,'public',e.publicPin.name),'utf8'))));
const key=(i,principalId)=>({id:'PUBLIC_RFC8032_TEST_VECTOR_'+(i+1),principalId,publicKey:vectors[i].publicKey,
 validAfter:'2020-01-01T00:00:00.000Z',validUntil:'2030-01-01T00:00:00.000Z',revoked:false});
const policy={schema:'finnor.x1.qualification-trust-policy.v1',policyId:'PUBLIC_TEST_POLICY_NOT_A_PROTECTED_TRUST_BINDING',
 custodianKeys:[key(0,'public-test-custodian')],observerKeys:[key(1,'public-test-observer')],
 independentlyManagedCustodyReceiptDigest:h('NO_PROTECTED_CUSTODY'),candidateCannotReadOracleReceiptDigest:h('NO_PROTECTED_ISOLATION'),
 policyValidUntil:'2030-01-01T00:00:00.000Z',profileDigest:digest(profile)};
const envelope={ref:'PUBLIC_SYNTHETIC_MEASUREMENT_ENVELOPE',digest:h('envelope'),maxCostUsd:10000,maxHumanSeconds:288000,
 maxAggregatePeakMemoryBytes:16*1024**3,maxAcquisitionCalls:1000000,maxNativeDeliveries:1000000,maxWallSeconds:7000000};
const protocol={schema:'finnor.x1.qualification-protocol.v1',id:control.protocolId,candidatePrincipalId:'public-test-candidate',
 custodianPrincipalId:'public-test-custodian',observerPrincipalId:'public-test-observer',registeredAt:'2026-10-01T00:00:00.000Z',
 candidateExposureAt:'2026-10-01T00:00:00.000Z',profileDigest:digest(profile),
 candidateCut:{commit:'0'.repeat(40),tree:'0'.repeat(40),dependencyLockDigest:h('public-lock'),compilerMethodDigest:h('public-method'),runtimeDigest:h('NOT_INSTALLED_RUNTIME')},
 environments:manifest.environments.map((e,i)=>({id:e.environmentId,oracleDigest:digest(oracleBodies[i]),unseenCustodyCommitment:oracleBodies[i].unseenCustodyCommitment,
  publicInputDigest:e.publicPin.sha256,systems:publicInputs[i].sources.map(s=>({id:s.sourceId,sourceClass:s.sourceClass,protocol:s.protocol,applicationFingerprint:s.sha256})),
  randomization:e.randomizationCommitments,replayJournalCommitment:oracleBodies[i].replayJournalCommitment})),
 envelopes:{setup:envelope,replay:envelope,soak:envelope,validation:envelope},allocationConventionDigest:control.allocationConventionDigest,
 originalFinancialAndComparatorContractsDigest:control.lockedSpecification.sha256,replayDays:30,elapsedLiveDays:7,
 scoringRevision:'finnor.x1.environment-score.v1',qualificationDoesNotAdmitOrActivate:true};
const observed=expected=>({mappings:structuredClone(expected.mappings),obligations:expected.obligations.map(o=>({identity:o.identity,semanticDigest:o.semanticDigest})),
 completions:expected.obligations.map(o=>({identity:o.identity,disposition:'OBSERVED',postconditionDigest:o.postconditionDigest,observedAt:o.deadlineAt,witnessDigest:h('SYNTHETIC_NOT_PROVIDER:'+o.identity)})),
 changes:expected.changes.map(c=>({identity:c.identity,recognizedAt:new Date(Date.parse(c.availableAt)+60000).toISOString(),witnessDigest:h('SYNTHETIC_NOT_CHANGE_OBSERVATION:'+c.identity)})),violations:[]});
const resource=wallSeconds=>({moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,acquisitionCalls:1,nativeDeliveries:1,
 wallSeconds,costReceiptDigests:[],completeLifecycleCoverage:false});
const packetBodies=oracleBodies.map((o,i)=>({schema:'finnor.x1.qualification-observation.v1',protocolId:protocol.id,environmentId:o.environmentId,
 revision:1,previousPacketDigest:null,observerPrincipalId:protocol.observerPrincipalId,observedAt:'2026-10-10T00:00:00.000Z',candidateCut:protocol.candidateCut,
 observed:{replay:observed(o.expected.replay),soak:observed(o.expected.soak)},
 replay:{replicaStart:'2026-09-01T00:00:00.000Z',replicaEnd:'2026-10-01T00:00:00.000Z',journalCommitment:o.replayJournalCommitment,
  completeExpectedEventCoverage:true,independentReceiptDigest:h('SYNTHETIC_NO_REPLAY_EXECUTION')},
 live:{segments:[{id:'SYNTHETIC_CLOCK_NOT_ELAPSED_TEST_'+i,startedAt:'2026-10-01T00:00:00.000Z',endedAt:'2026-10-08T00:00:00.000Z',
  monotonicElapsedMs:7*86400000,serviceFingerprint:h('NO_LIVE_SERVICE'),independentlyObservedUnattended:true,receiptDigest:h('SYNTHETIC_CLOCK')}],liveClockIndependentOfReplica:true},
 resources:{replay:resource(1),soak:resource(604800)},originalEpisodes:[{id:control.ownerInputs[i].originalEpisodeId,
  originalGrantDigest:control.ownerInputs[i].originalGrantDigest,originalDeadline:control.ownerInputs[i].originalDeadline,moneyUsd:null,humanSeconds:null,
  aggregatePeakMemoryBytes:null,initialResponseMs:null,wallMs:null,receipts:[h('SYNTHETIC_EPISODE_BINDING')]}],
 completionObservationsIndependentOfProducer:true,expectedAndObservedPopulationComplete:true}));
const signed=(body,i)=>({body,keyId:policy[i?'observerKeys':'custodianKeys'][0].id,signature:sign(null,Buffer.from(canonical(body)),vectors[i].key).toString('base64')});
const base={protocol,policy,oracleBodies,packetBodies};
const input=x=>({protocol:signed(x.protocol,0),trustPolicy:x.policy,profile,oracles:x.oracleBodies.map(o=>signed(o,0)),observationPackets:x.packetBodies.map(p=>signed(p,1))});
await save('freeze.json',{oracle:'finnor-os/scripts/frontier5/x1/reference/qualification-public-assessment-native-review-contract.md',rfcSourceSha256:corpus.sourceDocumentSha256,publicVectorCorpusSha256:sha(corpusBytes),publicVectorKeys:vectors.map(v=>v.publicHex),
 sourceInputs:previous,sourceProfile:control.profile,sourceLockedSpecification:control.lockedSpecification,
 allTimestampsAndBusinessObservationsAreSyntheticContractInputs:true,actualLiveDaysObserved:0,actualServiceCalls:0,
 protectedQualification:false,actualCustodyEstablished:false,protectedPolicyOrServiceModified:false});
await save('public-fixture-protocol.json',signed(protocol,0));await save('public-fixture-policy.json',policy);
await save('public-fixture-packets.json',packetBodies.map(p=>signed(p,1)));
const registered=validateQualificationRegistration(input(base));assert.equal(registered.protocol.environments.length,10);
const positive=assessInstitutionQualification(input(base));
assert.equal(positive.environments.length,10);assert.ok(positive.environments.every(e=>e.clock.passed&&e.score.replay.performancePassed&&e.score.soak.performancePassed));
assert.equal(positive.registeredGatesPassed,false);assert.equal(positive.disposition,'INCOMPLETE');assert.equal(positive.resourceCosts.complete,false);
await save('public-positive-assessment.json',positive);
const results=[{id:'public-rfc8032-vectors-and-complete-contract',status:'PASS',encodedClockEnvironments:10,
 protectedQualification:false,actualElapsedDaysEstablished:false,actualAssessmentDisposition:positive.disposition}];
const clone=()=>structuredClone(base);
const history=(x,oldMutation=()=>{},newMutation=()=>{})=>{
 const old=x.packetBodies[0],next=structuredClone(old);oldMutation(old);next.revision=2;next.observedAt='2026-10-11T00:00:00.000Z';
 next.previousPacketDigest=digest(old);newMutation(next);x.packetBodies.push(next);return x;
};
const cases=[
 ['future-registration',x=>{x.protocol.registeredAt='2099-01-01T00:00:00.000Z';},'X1_QUALIFICATION_REGISTRATION_IN_FUTURE'],
 ['fewer-eight-distinct-classes',x=>{x.protocol.environments[0].systems[0].sourceClass=x.protocol.environments[0].systems[1].sourceClass;},'X1_QUALIFICATION_EIGHT_HETEROGENEOUS_CLASSES_REQUIRED'],
 ['fewer-eight-distinct-application-fingerprints',x=>{x.protocol.environments[0].systems[0].applicationFingerprint=x.protocol.environments[0].systems[1].applicationFingerprint;},'X1_QUALIFICATION_EIGHT_HETEROGENEOUS_CLASSES_REQUIRED'],
 ['oracle-commitment-changed',x=>{x.protocol.environments[0].oracleDigest=h('wrong-oracle');},'X1_PROTECTED_ORACLE_COMMITMENT_OR_EXPOSURE_CHANGED'],
 ['future-observation',x=>{x.packetBodies[0].observedAt='2099-01-01T00:00:00.000Z';},'X1_OBSERVATION_TIMESTAMP_IN_FUTURE'],
 ['candidate-runtime-substitution',x=>{x.packetBodies[0].candidateCut={...x.protocol.candidateCut,runtimeDigest:h('different-runtime')};},'X1_OBSERVER_SOURCE_OR_HISTORY_CHAIN_CHANGED'],
 ['clock-duration-mismatch',x=>{x.packetBodies[0].live.segments[0].monotonicElapsedMs=1;},'X1_LIVE_CLOCK_MEASUREMENT_INVALID'],
 ['duplicate-clock-segment',x=>{x.packetBodies[0].live.segments.push(structuredClone(x.packetBodies[0].live.segments[0]));},'X1_LIVE_CLOCK_SEGMENT_DUPLICATE'],
 ['history-claim-multiplicity-removed',x=>history(x,p=>p.observed.replay.mappings.push(structuredClone(p.observed.replay.mappings[0]))),'X1_ORIGINAL_MATERIAL_CLAIM_HISTORY_OMITTED'],
 ['history-resource-counter-reset',x=>history(x,p=>{p.resources.replay.acquisitionCalls=2;}),'X1_ORIGINAL_QUALIFICATION_COST_OR_VIOLATION_RESET'],
 ['history-unsafe-violation-removed',x=>history(x,p=>{p.observed.replay.violations.push('UNAUTHORIZED_EFFECT');}),'X1_ORIGINAL_QUALIFICATION_COST_OR_VIOLATION_RESET'],
 ['history-original-episode-removed',x=>history(x,p=>{p.originalEpisodes.push({...p.originalEpisodes[0],id:'PUBLIC_EXTRA_ORIGINAL_EPISODE'});}),'X1_ORIGINAL_EPISODE_COST_GRANT_OR_DEADLINE_RESET'],
 ['history-original-episode-measurement-reset',x=>history(x,p=>{p.originalEpisodes[0].moneyUsd=1;}),'X1_ORIGINAL_EPISODE_COST_GRANT_OR_DEADLINE_RESET'],
 ['history-original-grant-substitution',x=>history(x,()=>{},p=>{p.originalEpisodes[0].originalGrantDigest=h('different-grant');}),'X1_ORIGINAL_EPISODE_COST_GRANT_OR_DEADLINE_RESET'],
 ['history-original-deadline-substitution',x=>history(x,()=>{},p=>{p.originalEpisodes[0].originalDeadline='2026-10-03T00:00:00.000Z';}),'X1_ORIGINAL_EPISODE_COST_GRANT_OR_DEADLINE_RESET'],
 ['history-live-clock-segment-removed',x=>history(x,()=>{},p=>{p.live.segments[0].id='replacement-segment';}),'X1_ORIGINAL_LIVE_CLOCK_HISTORY_OMITTED'],
 ['history-previous-digest-substitution',x=>history(x,()=>{},p=>{p.previousPacketDigest=h('wrong-previous');}),'X1_OBSERVER_SOURCE_OR_HISTORY_CHAIN_CHANGED'],
 ['history-revision-gap',x=>history(x,()=>{},p=>{p.revision=3;}),'X1_OBSERVER_SOURCE_OR_HISTORY_CHAIN_CHANGED'],
];
for(const [id,mutate,expected]of cases){const x=clone();mutate(x);const wire=input(x);let observed;
 try{assessInstitutionQualification(wire);throw Error('EXPECTED_OWNER_REFUSAL_NOT_OBSERVED');}catch(error){observed=error.code??error.message;assert.equal(observed,expected,id);}
 await save(id+'.json',{expected,observed,inputDigest:digest(wire),mutationRecipe:String(mutate),protectedQualification:false});results.push({id,status:'PASS',observed});}
for(const kind of ['short-replay','accelerated-replay-not-live','unattended-not-established']){
 const x=clone(),p=x.packetBodies[0];let gap;
 if(kind==='short-replay'){p.replay.replicaEnd='2026-09-30T00:00:00.000Z';gap='X1_FULL_30_DAY_REPLAY_PENDING';}
 if(kind==='accelerated-replay-not-live'){p.live.segments[0].endedAt='2026-10-01T00:00:01.000Z';p.live.segments[0].monotonicElapsedMs=1000;gap='X1_SEPARATE_7_ELAPSED_LIVE_DAYS_PENDING';}
 if(kind==='unattended-not-established'){p.live.segments[0].independentlyObservedUnattended=false;gap='X1_UNATTENDED_LIVE_OBSERVATION_UNAVAILABLE';}
 const assessment=assessInstitutionQualification(input(x));assert.ok(assessment.environments[0].clock.gaps.includes(gap));assert.equal(assessment.registeredGatesPassed,false);
 await save(kind+'.json',{expectedGap:gap,assessment,syntheticClockInput:true,actualElapsedDaysEstablished:false});results.push({id:kind,status:'PASS',observed:gap});}
const x=clone();history(x,p=>{p.observed.replay.completions[0].postconditionDigest=h('false-completion');});
const retained=assessInstitutionQualification(input(x));assert.equal(retained.disposition,'REFUSED');
assert.ok(retained.retainedHistoricalViolations.some(v=>v.startsWith('X1_FALSE_COMPLETION:')));
await save('retained-false-completion.json',retained);results.push({id:'prior-false-completion-survives-correction',status:'PASS'});
const tampered=input(base);tampered.observationPackets[0].signature=Buffer.alloc(64).toString('base64');
assert.throws(()=>assessInstitutionQualification(tampered),e=>e.code==='INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID');
results.push({id:'corrupted-public-signature',status:'PASS'});
await save('result.json',{status:'PASS_PUBLIC_FULL_ASSESSMENT_CONTRACT',results,elapsedMs:performance.now()-began,outputBytes:bytesWritten,
 actualServiceCalls:0,actualElapsedLiveDaysObserved:0,protectedQualification:false,independentProtectedCustody:false,
 currentAuthorizedSignersOrGrantsCreated:false,protectedS8Admission:false,engineeringCompletion:false});
console.log(JSON.stringify({status:'PASS_PUBLIC_FULL_ASSESSMENT_CONTRACT',cases:results.length,protectedQualification:false,actualElapsedLiveDaysObserved:0}));

return {results,evidenceRoot:root};
}
