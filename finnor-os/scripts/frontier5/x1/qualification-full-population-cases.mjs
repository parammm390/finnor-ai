import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function exerciseFullPopulation({repo,root,locked}) {
assert.ok([repo,root,locked].every(p=>p?.startsWith('/')));
await mkdir(root,{mode:0o700});await mkdir(join(root,'inputs'),{mode:0o700});
const began=performance.now(),sha=x=>createHash('sha256').update(x).digest('hex');
const hex=label=>sha('PUBLIC_NONAUTHORITATIVE_CHALLENGE:'+label);
const uuid=label=>{const h=hex(label);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
const save=async(name,value)=>{assert.ok(performance.now()-began<180000);const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
 await writeFile(join(root,name),bytes,{flag:'wx',mode:0o600});return {path:join(root,name),sha256:sha(bytes)};};
const pin=async path=>({path,sha256:sha(await readFile(path))});
const classes=['crm_deals','financial_ledger','document_dms','email','calendar','work_tracking','approval_records','lender_portal'];
assert.equal((await pin(locked)).sha256,'2288bb54a3f6a91ed2673c220e7d844842ace9de5f6ee1b6674e8a48980ff415','exact retained locked source required');
const profilePath=join(repo,'scope-frontier5/x1-institutional-programme-compiler/profile.json');
const generationInstant='2026-10-01T00:00:00.000Z',deadline='2026-10-02T00:00:00.000Z';
const {generateIndependentPopulation}=await import(pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-population.mts')));
const {validateQualificationRegistration,assessInstitutionQualification}=await import(pathToFileURL(join(repo,'finnor-os/packages/private-equity/src/institution-qualification/administration.ts')));
const {digest}=await import(pathToFileURL(join(repo,'finnor-os/packages/capability-evolution/src/contracts.ts')));
const seed=hex('EXPOSED_SEED_NOT_UNSEEN_CUSTODY'),seedVariable='FINNOR_X1_QUAL_SEED_PUBLIC_CONTRACT';
assert.equal(process.env[seedVariable],undefined);process.env[seedVariable]=seed;
const control={schema:'finnor.x1.independent-population-generator-control.v1',protocolId:'PUBLIC_OFFLINE_CONTRACT_ONLY',
 seedEnvironmentVariable:seedVariable,generationInstant,candidateCutDigest:hex('candidate'),allocationConventionDigest:hex('allocation'),
 seedCommitment:sha(Buffer.from(seed,'hex')),previouslyExposedSeedCommitments:[],profile:await pin(profilePath),
 lockedSpecification:await pin(locked),ownerInputs:[]};
for(let ordinal=0;ordinal<10;ordinal++){
 const environmentId='public-environment-'+ordinal,institutionId='public-institution-'+ordinal,
  tenantId=uuid(environmentId+'/tenant'),principalId=uuid(environmentId+'/principal'),workId=uuid(environmentId+'/work'),
  originalEpisodeId=uuid(environmentId+'/episode'),grant=hex(environmentId+'/NONAUTHORITATIVE_PARENT');
 const owner={origin:'http://127.0.0.1:9',tenantId,principalId,tokenEnvironmentVariable:'FINNOR_X1_QUAL_NO_SERVICE_TOKEN'};
 const read={path:'/api/company-brain/institution-status',method:'POST',body:{requestId:uuid(environmentId+'/request')},readOnly:true,
  admittedOwnerReadReceiptDigest:hex('NOT_AN_ADMITTED_READ_RECEIPT'),responseIdentityPath:['workId'],expectedOwnerIdentity:workId,
  appliedStatePredicates:[{path:['replicaAt'],equals:'GENERATED_REPLICA_INSTANT'}]};
 const event=(label,day)=>{const key='public-contract:'+environmentId+':'+label;
  return {id:environmentId+':'+label,workId,replicaAt:'2026-09-01T00:00:00.000Z',
   occurredAt:'2026-09-01T00:00:00.000Z',availableAt:'2026-09-01T00:00:00.000Z',dependsOn:[],originalIdempotencyKey:key,
   owner,request:{path:'/api/public-contract-challenge',method:'POST',body:{idempotencyKey:key,
    originals:Object.fromEntries(classes.map(c=>[c,'GENERATED_ORIGINAL_BASE64']))}},reconciliation:structuredClone(read),
   clockOwner:owner,clockRequest:{path:'/api/public-contract-clock',method:'POST',body:{replicaAt:'GENERATED_REPLICA_INSTANT'}},
   clockObservation:structuredClone(read),clockReplicaPath:['replicaAt'],clockReceiptPath:['receiptDigest'],
   originalEpisodeId,originalGrantDigest:grant,originalDeadline:deadline};};
 const bindings=Array.from({length:30},(_,day)=>({day,originalIdempotencyKey:'public-contract:'+environmentId+':source-'+day,
  originalEpisodeId,originalGrantDigest:grant,originalDeadline:deadline,event:event('source-'+day,day),
  clockReplicaWritePath:['replicaAt'],sourcePayloadBindings:classes.map(sourceClass=>({sourceClass,bodyPath:['originals',sourceClass]}))}));
 const patterns=Array.from({length:2},(_,pattern)=>({events:Array.from({length:30},(_,day)=>
  ['REVOKE_SOURCE_RIGHT','RESTORE_CURRENT_SOURCE_RIGHT'].map(faultKind=>({day,faultKind,
   clockReplicaWritePath:['replicaAt'],event:event('permission-'+pattern+'-'+day+'-'+faultKind,day)}))).flat()}));
 const soak={mappings:[{identity:environmentId+'/soak-entity',semanticDigest:hex(environmentId+'/entity')}],
  obligations:[{identity:environmentId+'/soak-duty',semanticDigest:hex(environmentId+'/duty'),postconditionDigest:hex(environmentId+'/postcondition'),
   deadlineAt:deadline,critical:true,businessAssignmentId:environmentId+'/soak-assignment',fixedBusinessWeight:1}],
  changes:[{identity:environmentId+'/soak-change',occurredAt:'2026-09-01T00:00:00.000Z',availableAt:'2026-09-01T00:00:00.000Z'}]};
 const publicOwnerHandles=await save('inputs/'+ordinal+'-handles.json',{publicNonExecutingChallenge:true,
  owner,workId,actualServiceInstalled:false,actualAuthorityOrCustody:false});
 const assets=[0,1].map(i=>({kind:'deal',registrationId:environmentId+'/deal-'+i,
  canonicalRef:'pe_deal:'+uuid(environmentId+'/deal-'+i)+'@v1',ownerSnapshotDigest:hex('NOT_CURRENT_OWNER_SNAPSHOT')}));
 control.ownerInputs.push({environmentId,institutionId,tenantId,principalId,workId,originalEpisodeId,
  originalGrantDigest:grant,originalDeadline:deadline,existingOwnerSnapshotDigest:hex('NOT_CURRENT_OWNER_SNAPSHOT'),
  custodyReceiptDigest:hex(environmentId+'/NO_PROTECTED_CUSTODY'),nativeAssets:assets,
  mandateRules:[{id:'standing-public-rule',triggerKind:'public_evidence_needed',operation:'create_deal_request',principalId,
   deadlineAt:deadline,materiality:'material',postconditionRef:'x1:pe-request-created:v1',observerRef:'x1:pe-request-creation-observer:v1',
   targetRegistrationIds:assets.map(a=>a.registrationId),fixedBusinessWeight:1,critical:true,
   triggerFields:{workstreamExternalId:'public-stream',requestedFromExternalId:'public-party',requestText:'Public original evidence',requiresAcceptedDeliverable:true},
   postconditionFields:{workstream_id:uuid(environmentId+'/stream'),requested_from_deal_party_id:uuid(environmentId+'/party')}}],
  sourceGrants:classes.map(sourceClass=>({id:uuid(environmentId+'/'+sourceClass),sourceId:environmentId+'/'+sourceClass,sourceClass,
   rightsRevision:'PUBLIC_CHALLENGE_NOT_CURRENT_RIGHTS',expiresAt:'2026-11-01T00:00:00.000Z',ownerReceiptDigest:hex('NOT_OWNER_RECEIPT')})),
  publicOwnerHandles,permissionEventRequests:await save('inputs/'+ordinal+'-permission-patterns.json',patterns),
  ownerEventBindings:await save('inputs/'+ordinal+'-day-bindings.json',bindings),
  soakExpectedEnvironment:await save('inputs/'+ordinal+'-soak-expected.json',soak),
  originalEpisodeCatalog:[{workId,originalEpisodeId,originalGrantDigest:grant,originalDeadline:deadline,
   businessAssignmentRegistrationId:environmentId+'/public-assignment',ownerReceiptDigest:hex('NOT_OWNER_RECEIPT')}]});
}
await save('public-control.json',control);
await save('freeze.json',{sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo,encoding:'utf8'}).trim(),runtime:process.version,
 profile:control.profile,lockedSpecification:control.lockedSpecification,
 oracle:'finnor-os/scripts/frontier5/x1/reference/qualification-full-native-review-contract.md',publicNonExecutingChallenge:true,protectedQualification:false,
 expected:{environments:10,initialSources:80,dayEntries:300,executionEvents:938,obligations:91},
 limits:{wallSeconds:180,nodeHeapMiB:768,outputBytes:64*1024*1024}});
const generated=await generateIndependentPopulation(control,{publicRoot:join(root,'public'),withheldRoot:join(root,'withheld')});
assert.equal(generated.initialOnly,false);assert.equal(generated.environments.length,10);
assert.equal(new Set(generated.environments.map(e=>e.structuralDigest)).size,10);
let sources=0,dayEntries=0,eventCount=0,obligations=0;
assert.equal((await readdir(join(root,'public'))).filter(n=>n.includes('execution-journal')).length,0,'withheld journal is not published to candidate');
const journal=JSON.parse(await readFile(join(root,'withheld','execution-journal-draft.json'),'utf8'));
for(const e of generated.environments){
 assert.deepEqual([...e.systemClasses].sort(),[...classes].sort());assert.equal(e.replayDays,30);assert.equal(e.separateElapsedLiveDaysRequired,7);
 const original=JSON.parse(await readFile(join(root,'public',e.publicPin.name),'utf8')),
  ledger=JSON.parse(await readFile(join(root,'withheld',e.oraclePin.name),'utf8'));
 sources+=original.sources.length;dayEntries+=ledger.journal.length;obligations+=ledger.expectedObligations.length;
 assert.deepEqual(ledger.journal.map(d=>d.day),Array.from({length:30},(_,i)=>i));
 assert.equal(ledger.protectedCustodyEstablished,false);assert.equal(ledger.signature,null);
 const events=journal.environments.find(j=>j.id===e.environmentId);assert.ok(events);
 assert.equal(Date.parse(events.replicaEnd)-Date.parse(events.replicaStart),30*86400000);eventCount+=events.events.length;
}
assert.deepEqual({sources,dayEntries,eventCount,obligations},{sources:80,dayEntries:300,eventCount:938,obligations:91});
const profile=JSON.parse(await readFile(profilePath,'utf8')),key={id:'PUBLIC_PLACEHOLDER_NOT_AUTHORITY',principalId:'custodian',
 publicKey:'NO_PRIVATE_OR_PUBLIC_SIGNING_KEY_CREATED',validAfter:'2020-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',revoked:false};
const policy={schema:'finnor.x1.qualification-trust-policy.v1',policyId:'PUBLIC_CHALLENGE_NO_AUTHORIZED_POLICY',
 custodianKeys:[key],observerKeys:[{...key,principalId:'observer'}],independentlyManagedCustodyReceiptDigest:hex('NO_CUSTODY'),
 candidateCannotReadOracleReceiptDigest:hex('NO_ISOLATION_CLAIM'),policyValidUntil:key.validUntil,profileDigest:digest(profile)};
const envelope={ref:'PUBLIC_NONAUTHORITATIVE_ENVELOPE',digest:hex('envelope'),maxCostUsd:10000,maxHumanSeconds:288000,
 maxAggregatePeakMemoryBytes:16*1024**3,maxAcquisitionCalls:1000000,maxNativeDeliveries:1000000,maxWallSeconds:604800};
const protocol={schema:'finnor.x1.qualification-protocol.v1',id:'PUBLIC_OFFLINE_CONTRACT_ONLY',candidatePrincipalId:'candidate',
 custodianPrincipalId:'custodian',observerPrincipalId:'observer',registeredAt:'2026-09-01T00:00:00.000Z',candidateExposureAt:'2026-09-02T00:00:00.000Z',
 profileDigest:digest(profile),candidateCut:{commit:'0'.repeat(40),tree:'0'.repeat(40),dependencyLockDigest:hex('lock'),
 compilerMethodDigest:hex('method'),runtimeDigest:hex('NOT_INSTALLED')},environments:control.ownerInputs.map(e=>({id:e.environmentId,
 oracleDigest:hex(e.environmentId+'/oracle'),unseenCustodyCommitment:hex(e.environmentId+'/NO_CUSTODY'),publicInputDigest:hex(e.environmentId+'/input'),
 systems:classes.map(c=>({id:e.environmentId+'/'+c,sourceClass:c,protocol:profile.sourceClasses.find(s=>s.id===c).protocols[0],applicationFingerprint:hex(e.environmentId+'/'+c)})),
 randomization:Object.fromEntries(['identifiers','schemaOrganization','dateConventions','permissions','processVariants'].map(c=>[c,hex(e.environmentId+'/'+c)])),
 replayJournalCommitment:hex(e.environmentId+'/journal')})),envelopes:{setup:envelope,replay:envelope,soak:envelope,validation:envelope},
 allocationConventionDigest:hex('allocation'),originalFinancialAndComparatorContractsDigest:control.lockedSpecification.sha256,
 replayDays:30,elapsedLiveDays:7,scoringRevision:'finnor.x1.environment-score.v1',qualificationDoesNotAdmitOrActivate:true};
const signed={body:protocol,keyId:'MISSING_EXISTING_AUTHORITY',signature:'UNSIGNED_PUBLIC_CHALLENGE'},registration={protocol:signed,trustPolicy:policy,profile};
const results=[{id:'full-initialOnly-false-generator',status:'PASS',observed:{sources,dayEntries,eventCount,obligations}}];
for(const [id,fn,predicate] of [
 ['registration-missing-authorized-signature',()=>validateQualificationRegistration(registration),'INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID'],
 ['assessment-missing-authorized-signature',()=>assessInstitutionQualification({...registration,oracles:[],observationPackets:[]}),'INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID'],
 ['registration-candidate-is-custodian',()=>validateQualificationRegistration({...registration,protocol:{...signed,body:{...protocol,candidatePrincipalId:'custodian'}}}),'X1_QUALIFICATION_CUSTODY_OR_PROFILE_UNAVAILABLE'],
 ['registration-setup-cost-limit',()=>validateQualificationRegistration({...registration,protocol:{...signed,body:{...protocol,envelopes:{...protocol.envelopes,setup:{...envelope,maxCostUsd:10001}}}}}),'X1_QUALIFICATION_CUSTODY_OR_PROFILE_UNAVAILABLE'],
 ['registration-profile-substitution',()=>validateQualificationRegistration({...registration,protocol:{...signed,body:{...protocol,profileDigest:hex('wrong-profile')}}}),'X1_QUALIFICATION_CUSTODY_OR_PROFILE_UNAVAILABLE'],
 ]){let observed;try{fn();throw Error('EXPECTED_REFUSAL_NOT_OBSERVED');}catch(error){observed=error.code??error.message;assert.equal(observed,predicate);}results.push({id,status:'PASS',observed});}
const changePinned=async(x,field,id,mutate)=>{
 const value=JSON.parse(await readFile(x.ownerInputs[0][field].path,'utf8'));mutate(value);
 x.ownerInputs[0][field]=await save('inputs/negative-'+id+'.json',value);
};
const negatives=[
 ['reused-public-seed',async x=>{x.previouslyExposedSeedCommitments.push(x.seedCommitment);},'INDEPENDENT_UNEXPOSED_SEED_COMMITMENT_REQUIRED'],
 ['profile-preimage-substitution',async x=>{x.profile.sha256=hex('wrong-profile');},'INDEPENDENT_GENERATOR_PREIMAGE_CHANGED'],
 ['locked-source-preimage-substitution',async x=>{x.lockedSpecification.sha256=hex('wrong-locked-source');},'ORIGINAL_LOCKED_SPECIFICATION_CHANGED'],
 ['missing-thirtieth-day',async x=>changePinned(x,'ownerEventBindings','missing-day',a=>{a.pop();}),'THIRTY_ACTUAL_OWNER_DAY_BINDINGS_AND_PERMISSION_EVENTS_REQUIRED'],
 ['original-parent-substitution',async x=>changePinned(x,'ownerEventBindings','wrong-parent',a=>{a[0].event.originalGrantDigest=hex('different-parent');}),'ACTUAL_EVENT_OWNER_OR_ORIGINAL_IDENTITY_CHANGED'],
 ['clock-write-preimage-substitution',async x=>changePinned(x,'ownerEventBindings','wrong-clock',a=>{a[0].event.clockRequest.body.replicaAt='unregistered-clock-value';}),'ORIGINAL_OWNER_REQUEST_FIELD_PREIMAGE_CHANGED'],
 ['missing-source-payload-binding',async x=>changePinned(x,'ownerEventBindings','missing-source',a=>{a[0].sourcePayloadBindings.pop();}),'ACTUAL_OWNER_SOURCE_PAYLOAD_BINDINGS_REQUIRED'],
 ['duplicate-original-assignment',async x=>{x.ownerInputs[0].originalEpisodeCatalog.push({...x.ownerInputs[0].originalEpisodeCatalog[0],originalEpisodeId:uuid('another-episode')});},'INDEPENDENT_ORIGINAL_ASSIGNMENT_CATALOG_REQUIRED'],
 ['missing-permission-fault',async x=>changePinned(x,'permissionEventRequests','missing-permission',a=>{for(const p of a)p.events=p.events.filter(e=>e.faultKind!=='REVOKE_SOURCE_RIGHT');}),'ACTUAL_SELECTED_PERMISSION_FAULT_BINDING_REQUIRED'],
 ['causal-cycle',async x=>changePinned(x,'ownerEventBindings','cycle',a=>{a[0].event.dependsOn=[a[0].event.id];}),'SELECTED_PERMISSION_OR_SOURCE_CAUSAL_GRAPH_INVALID'],
 ['candidate-withheld-directory-overlap',async()=>{},'SEPARATE_CUSTODIAN_AND_CANDIDATE_DIRECTORIES_REQUIRED'],
];
for(const [id,mutate,expected]of negatives){const x=structuredClone(control);await mutate(x);
 const attempt=join(root,'negative-'+id);await mkdir(attempt,{mode:0o700});
 await save('negative-'+id+'-control.json',x);let observed;
 try{await generateIndependentPopulation(x,{publicRoot:join(attempt,'public'),
   withheldRoot:join(attempt,id==='candidate-withheld-directory-overlap'?'public':'withheld')});throw Error('EXPECTED_GENERATOR_REFUSAL_NOT_OBSERVED');}
 catch(error){observed=error.message;assert.equal(observed,expected,id);}
 await save('negative-'+id+'-result.json',{expected,observed,protectedQualification:false});results.push({id,status:'PASS',observed});
}
await save('result.json',{status:'PASS_PUBLIC_OFFLINE_GENERATOR_AND_REACHED_AUTHORITY_GUARDS',results,elapsedMs:performance.now()-began,
 notReached:['protected-signed-registration-positive','protected-signed-assessment-positive','history-and-clock-predicates-behind-signature'],
 actualTestServiceExecution:false,protectedQualification:false,fullEngineeringCompletion:false});
delete process.env[seedVariable];console.log(JSON.stringify({status:'PASS_PUBLIC_OFFLINE_GENERATOR_AND_REACHED_AUTHORITY_GUARDS',cases:results.length,sources,dayEntries,eventCount,obligations}));

return {control,generated,results,evidenceRoot:root};
}
