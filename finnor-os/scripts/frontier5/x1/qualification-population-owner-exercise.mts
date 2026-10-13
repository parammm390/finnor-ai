/** Generated original bytes through actual owners. Expectations precede exposure. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {generateIndependentInitialPopulation} from './qualification-population.mts';
import {instantiateGeneratedOriginals} from './qualification-native-inputs.mts';
import type {OwnerEndpoint} from './qualification-runtime.mts';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
type SourceBinding={sourceId:string;sourceClass:string;grantId:string;versionId:string;documentId:string};
export async function exerciseGeneratedPopulation(input:{repo:string;evidenceRoot:string;owner:OwnerEndpoint;token:string;
  admin:pg.Client;workId:string;parentRequestId:string;institutionId:string;rule:Record<string,unknown>;
  sourceBindings:SourceBinding[];targetRegistrationId:string;workstreamExternalId:string;recipientExternalId:string;
  requestPrefix:string;api:(operation:string,body:unknown)=>Promise<{status:number;body:any}>;
  assertWorker:()=>void;pauseWorker:()=>Promise<void>;resumeWorker:()=>Promise<void>}){
  const root=join(input.evidenceRoot,'generated-population');await mkdir(root,{mode:0o700});
  const save=async(name:string,body:unknown)=>{const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');
    const path=join(root,name);await writeFile(path,bytes,{flag:'wx',mode:0o600});return {path,sha256:sha(bytes)};};
  const tenant=input.owner.tenantId,principal=input.owner.principalId;
  const episode=async()=>(await input.admin.query(`SELECT e.id::text,e.original_deadline,e.parent_reservation,e.profile_digest
    FROM finnor_os.x1_compiler_episodes e JOIN finnor_os.x1_compiler_requests r
      ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
    WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3`,[tenant,principal,input.parentRequestId])).rows[0];
  const original=await episode();assert.ok(original?.parent_reservation);
  const native=(await input.admin.query(`SELECT id::text,external_id,version FROM finnor_os.pe_deals
    WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY id`,[tenant])).rows;
  const target=native.find(row=>row.external_id===input.targetRegistrationId);assert.ok(target);
  const stream=(await input.admin.query(`SELECT id::text FROM finnor_os.pe_workstreams
    WHERE tenant_id=$1 AND deal_id=$2 AND external_id=$3 AND archived_at IS NULL AND state NOT IN('complete','cancelled')`,
    [tenant,target.id,input.workstreamExternalId])).rows[0];
  const party=(await input.admin.query(`SELECT id::text FROM finnor_os.pe_deal_parties
    WHERE tenant_id=$1 AND deal_id=$2 AND external_id=$3 AND state='active' AND removed_at IS NULL`,
    [tenant,target.id,input.recipientExternalId])).rows[0];assert.ok(stream);assert.ok(party);
  const snapshotDigest=sha(JSON.stringify(native)),classes=['crm_deals','financial_ledger','document_dms','email',
    'calendar','work_tracking','approval_records','lender_portal'];
  const originals=classes.map(sourceClass=>{const binding=input.sourceBindings.find(s=>s.sourceClass===sourceClass);
    assert.ok(binding,'existing original source class '+sourceClass);return binding;});
  const grants=(await input.admin.query(`SELECT id::text,source_id,source_class,revision,expires_at,to_jsonb(g) body
    FROM finnor_os.x1_source_grants g WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=ANY($4::uuid[])
      AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[tenant,principal,input.workId,originals.map(s=>s.grantId)])).rows;
  assert.equal(grants.length,8);
  const publicHandles=await save('public-owner-handles.json',{workId:input.workId,owner:input.owner,
    existingOriginalEpisodeId:original.id,originalDeadline:original.original_deadline.toISOString()});
  const generationInstant=new Date().toISOString(),profilePath=join(input.repo,'scope-frontier5/x1-institutional-programme-compiler/profile.json');
  const lockedPath=process.env.FINNOR_X1_LOCKED_SPECIFICATION;
  if(!lockedPath?.startsWith('/'))throw Error('EXACT_ORIGINAL_LOCKED_SPECIFICATION_PATH_REQUIRED');
  const seed=randomBytes(32),seedVariable='FINNOR_X1_QUAL_SEED_DISPOSABLE_FORMAT_EXERCISE';
  if(process.env[seedVariable]||process.env[input.owner.tokenEnvironmentVariable])throw Error('ORIGINAL_EXERCISE_BINDING_COLLISION');
  const control={schema:'finnor.x1.independent-initial-population-control.v1',protocolId:'LOCAL_FORMAT_AND_OWNER_EXECUTION_'+randomUUID(),
    seedEnvironmentVariable:seedVariable,generationInstant,candidateCutDigest:sha(await readFile(join(input.evidenceRoot,'freeze.json'))),
    allocationConventionDigest:sha('ORIGINAL_VALIDATOR_INTERVAL_CONTAINS_COMPONENTS'),seedCommitment:sha(seed),
    previouslyExposedSeedCommitments:[],profile:{path:profilePath,sha256:sha(await readFile(profilePath))},
    lockedSpecification:{path:lockedPath,sha256:sha(await readFile(lockedPath))},
    ownerInputs:Array.from({length:10},(_,ordinal)=>({environmentId:'local-format-partition-'+ordinal,institutionId:input.institutionId,
      tenantId:tenant,principalId:principal,workId:input.workId,originalEpisodeId:original.id,
      originalGrantDigest:sha(JSON.stringify(original.parent_reservation)),originalDeadline:original.original_deadline.toISOString(),
      existingOwnerSnapshotDigest:snapshotDigest,custodyReceiptDigest:sha('DEVELOPMENT_ONLY_NO_PROTECTED_CUSTODY'),
      nativeAssets:native.map(row=>({kind:'deal',registrationId:row.external_id,canonicalRef:'pe_deal:'+row.id+'@v'+row.version,
        ownerSnapshotDigest:snapshotDigest})),
      mandateRules:[{...input.rule,targetRegistrationIds:[input.targetRegistrationId],fixedBusinessWeight:1,critical:true,
        triggerFields:{workstreamExternalId:input.workstreamExternalId,requestedFromExternalId:input.recipientExternalId,
          requestText:input.requestPrefix,requiresAcceptedDeliverable:true},
        postconditionFields:{request_text:'GENERATED_FIELD:requestText',state:'open',fulfilled_at:null,
          deal_id:target.id,workstream_id:stream.id,requested_from_deal_party_id:party.id,
          owner_party_type:'employee',owner_party_id:principal,requires_accepted_deliverable:true}}],
      sourceGrants:grants.map(g=>({id:g.id,sourceId:g.source_id,sourceClass:g.source_class,rightsRevision:g.revision,
        expiresAt:g.expires_at.toISOString(),ownerReceiptDigest:sha(JSON.stringify(g.body))})),publicOwnerHandles:publicHandles}))};
  await save('generation-control.json',control);
  process.env[seedVariable]=seed.toString('hex');process.env[input.owner.tokenEnvironmentVariable]=input.token;
  try{
    const publicRoot=join(root,'public'),withheldRoot=join(root,'withheld');
    const generated=await generateIndependentInitialPopulation(control,{publicRoot,withheldRoot});
    assert.equal(generated.environments.length,10);assert.equal(new Set(generated.environments.map(e=>e.structuralDigest)).size,10);
    for(const environment of generated.environments)assert.deepEqual([...environment.systemClasses].sort(),[...classes].sort());
    const selected=generated.environments[0]!,packetPath=join(publicRoot,selected.publicPin.name);
    const packet=JSON.parse(await readFile(packetPath,'utf8')),oracle=JSON.parse(await readFile(join(withheldRoot,selected.oraclePin.name),'utf8'));
    assert.equal(oracle.expectedObligations.length,1);
    await input.pauseWorker();
    const sourceExpiry=new Date(Date.now()+3600000).toISOString();
    const mandate=await input.api('institution-mandate',{workId:input.workId,institutionId:input.institutionId,
      rules:packet.mandateRules,expiresAt:sourceExpiry});
    assert.equal(mandate.status,200,JSON.stringify(mandate));
    const instantiated=await instantiateGeneratedOriginals({control:{schema:'finnor.x1.generated-original-instantiation.v1',
      publicPacket:{path:packetPath,sha256:selected.publicPin.sha256},workId:input.workId,purpose:'standing evidence responsibility',
      expiresAt:sourceExpiry,originals:originals.map(s=>({sourceId:s.sourceId,grantId:s.grantId,
        documentId:s.documentId,parentVersionId:s.versionId,sourceClass:s.sourceClass}))},owner:input.owner,deadlineAt:Date.now()+60000});
    await save('native-original-instantiation.json',instantiated);
    for(const observation of instantiated.observations){
      assert.notEqual(observation.grant.id,observation.originalGrantId);assert.equal(observation.grant.original_sha256,observation.byteSha256);
      const version=(await input.admin.query(`SELECT c.bytes,v.parent_version_id FROM finnor_os.document_versions v
        JOIN finnor_os.document_version_contents c ON c.tenant_id=v.tenant_id AND c.version_id=v.id
        WHERE v.tenant_id=$1 AND v.document_id=$2 AND v.id=$3`,[tenant,observation.version.document_id,observation.version.id])).rows[0];
      assert.ok(version);assert.equal(sha(version.bytes),observation.byteSha256);assert.equal(version.parent_version_id,observation.originalVersionId);
    }
    const metadata=await input.api('institution-sources',{workId:input.workId});assert.equal(metadata.status,200);
    const body={workId:input.workId,workInputId:metadata.body.workInputId,grantIds:input.sourceBindings.map(source=>
      instantiated.observations.find(o=>o.sourceId===source.sourceId)?.grant.id??source.grantId),
      parentRequestId:input.parentRequestId,idempotencyKey:'generated-original-revision:'+randomUUID()};
    const accepted=await input.api('institution-revise',body);await save('authenticated-generated-revision.json',{mandate,metadata,body,accepted});
    assert.equal(accepted.status,202,JSON.stringify(accepted));
    await input.resumeWorker();
    let ending:any,observedRequestId=accepted.body.requestId;
    const ownerObservations=[];
    for(let poll=0;poll<120;poll++){
      input.assertWorker();const current=await input.api('institution-sources',{workId:input.workId});assert.equal(current.status,200,JSON.stringify(current));
      if(current.body.request?.id&&current.body.request.id!==observedRequestId){
        const lineage=(await input.admin.query(`SELECT id,episode_id,work_id,parent_request_id FROM finnor_os.x1_compiler_requests
          WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,[tenant,principal,current.body.request.id])).rows[0];
        assert.ok(lineage);assert.equal(lineage.episode_id,original.id);assert.equal(lineage.work_id,input.workId);assert.ok(lineage.parent_request_id);
        ownerObservations.push({supersededRequestId:observedRequestId,currentOwnerRequest:current.body.request,lineage});observedRequestId=lineage.id;
      }
      const read=await input.api('institution-read',{requestId:observedRequestId});
      ownerObservations.push({requestId:observedRequestId,statusCode:read.status,status:read.body.status,reason:read.body.reason??read.body.predicate??null});
      if(read.status!==200){
        await save('generated-refused-owner-read-'+poll+'.json',read);
        const latest=await input.api('institution-sources',{workId:input.workId});
        if(latest.status===200&&latest.body.request?.id&&latest.body.request.id!==observedRequestId)continue;
        assert.equal(read.status,200,JSON.stringify(read));
      }
      ending=read.body;if(['OBSERVED','FAILED','UNKNOWN','INVALIDATED','CHECK_REJECTED','PARTIAL'].includes(ending.status))break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    await save('generated-owner-observations.json',ownerObservations);
    await save('generated-ending-owner-read.json',ending);assert.equal(ending?.status,'OBSERVED',JSON.stringify({status:ending?.status,reason:ending?.reason,check:ending?.check}));
    const actual=(await input.admin.query(`SELECT a.receipts FROM finnor_os.x1_mapping_admissions a
      JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=a.tenant_id AND r.admission_id=a.id WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenant,observedRequestId])).rows[0];assert.ok(actual);
    for(const mapping of oracle.expectedMappings){
      const [sourceId,recordId]=mapping.identity.split('/'),receipt=actual.receipts.find((r:any)=>r.sourceId===sourceId&&r.recordId===recordId);
      assert.ok(receipt,'independent generated original mapping '+mapping.identity);assert.equal(receipt.canonicalRef,mapping.targetCanonicalRef);
      if(mapping.kind==='quantity'){
        const version=(await input.admin.query('SELECT snapshot FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',
          [tenant,receipt.evidenceVersionId])).rows[0];const q=version?.snapshot.sourceQuantity;assert.ok(q);
        for(const field of ['factKey','value','currency','unit','period','basis','occurredAt','availableAt'])
          assert.equal(q[field],mapping.originalFields[field],'independent generated quantity '+field);
      }
    }
    const duty=oracle.expectedObligations[0],nativeRows=(await input.admin.query(`SELECT r.*,a.status action_status,e.status effect_status
      FROM finnor_os.pe_requests r JOIN finnor_os.domain_actions a ON a.tenant_id=r.tenant_id AND a.id=r.id
      JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id
      WHERE r.tenant_id=$1 AND r.request_text=$2 AND a.work_id=$3`,[tenant,duty.originalRecord.requestText,input.workId])).rows;
    assert.equal(nativeRows.length,1);for(const [key,value]of Object.entries(duty.completionFields))assert.equal(nativeRows[0][key],value);
    assert.equal(nativeRows[0].action_status,'completed');assert.equal(nativeRows[0].effect_status,'verified');
    assert.equal(new Date(nativeRows[0].requested_at).toISOString(),new Date(duty.originalRecord.occurredAt).toISOString());
    assert.equal(new Date(nativeRows[0].due_at).toISOString(),duty.deadlineAt);assert.ok(Date.parse(nativeRows[0].created_at)<=Date.parse(duty.deadlineAt));
    assert.deepEqual(await episode(),original);assert.deepEqual(ending.costs.parentReservation,original.parent_reservation);
    const result={schema:'finnor.x1.generated-population-owner-evidence.v1',generated,selectedPacket:selected.publicPin,
      originalEpisode:original,accepted,observedRequestId,ownerObservations,admission:actual,nativeRows,originalsInstalled:instantiated.observations.length,
      independentlyExpectedMappingCount:oracle.expectedMappings.length,independentlyExpectedObligationCount:oracle.expectedObligations.length,
      actualIndependentInstitutions:1,formatPartitions:10,thirtyDayExecutionEstablished:false,sevenElapsedDaysEstablished:false,
      protectedCustodyEstablished:false,qualificationEstablished:false};await save('result.json',result);return result;
  }finally{delete process.env[seedVariable];delete process.env[input.owner.tokenEnvironmentVariable];seed.fill(0);}
}
