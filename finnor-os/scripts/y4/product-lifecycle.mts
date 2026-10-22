/** Original-owner setup and actual installed F1/E1 episode. This administrator
 * knows synthetic originals, so this is not independent institutional custody. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import pg from 'pg';
import {configureTenantVertical,receiveWork,withTenantTransaction,
 acquireComputeResourceLeases,releaseComputeResourceLeases} from '@finnor/db';
import {employeeAuthoritySnapshot} from '@finnor/authority';
import {configureAgentProfile} from '../../packages/orchestration/src/workforce-runtime';
import {createDefaultPluginRegistry} from '../../packages/orchestration/src/plugin-registry';
import {createDocument,appendDocumentVersion} from '@finnor/data-platform';
import {createDeal,createInvestmentCase,createUnderwritingModel,createUnderwritingModelVersion,
 type PeMutationContext} from '@finnor/private-equity';
import type {UnderwritingModelIR} from '@finnor/underwriting';
import {configureInstitutionMandate,registerInstitutionCoreSource} from '../../packages/private-equity/src/institution-program/inputs';
import {canonical,sha,quantity,type ConfidentialFunction} from '../../packages/private-equity/src/confidential-computation/contracts';
import {artifact,startEnvironment} from './environment.mjs';
import {localAuth,installedProcess} from './product-transport.mjs';
import {mountedWorkBrowser} from './browser-episode.mjs';
import {ownerSetup,ownerConsumption} from './owner-episode.mjs';
import {confidentialS8Episode} from './s8-episode.mjs';
import {canonicalCrashAndReconcile,cancellationDisposal} from './recovery-episode.mjs';
import {effectPreservation} from './effect-episode.mjs';
import {ownerFixtureReference} from '../s5/owner-fixture.mjs';
import {revokeAtNativeS6Commit,ownerResponsibilitySnapshot} from './owner-adversarial-episode.mjs';

const exec=promisify(execFile);
type Environment=Awaited<ReturnType<typeof startEnvironment>>;
type Recorder=(id:string,predicate:string,run:()=>Promise<unknown>)=>Promise<void>;
export type OriginalOwners={tenant:string;foreignTenant:string;principals:string[];foreign:string;target:string;
 institutions:string[];states:string[];deadlineAt:string;sourceExpiry:string};

export async function lifecycleEpisode(e:Environment,evidence:string,caseName:string,record:Recorder,reuse?:OriginalOwners){
 const ownerCase=caseName==='lifecycle'||caseName==='owner-commit-race';
 const installation=process.env.FINNOR_Y4_INSTALLATION,backend=process.env.FINNOR_Y4_BACKEND;
 if(!installation||!backend||![installation,backend].every(isAbsolute))throw Error('Y4_INSTALLED_PRODUCT_AND_BACKEND_REQUIRED');
 const privateDirectory=join(evidence,'PRIVATE-NOT-FOR-HANDOFF'),registry=join(privateDirectory,'participant-registry.json'),
  scratch=join(privateDirectory,'native'),assets=join(installation,'runtime/finnor-os/packages/private-equity/src/confidential-computation');
 const tenant=reuse?.tenant??randomUUID(),foreignTenant=reuse?.foreignTenant??randomUUID(),
  principals=reuse?.principals??Array.from({length:4},()=>randomUUID()),
  foreign=reuse?.foreign??randomUUID(),target=reuse?.target??randomUUID(),
  institutions=reuse?.institutions??principals.slice(0,3).map(()=>randomUUID());
 const purpose='LOCAL_Y4_ORIGINAL_JOINT_LIQUIDITY_ANALYSIS_NO_APPROVAL_OR_ECONOMIC_EFFECT',
  deadlineAt=reuse?.deadlineAt??new Date(Date.now()+3500_000).toISOString(),
  sourceExpiry=reuse?.sourceExpiry??new Date(Date.now()+3550_000).toISOString(),
  worldAt=new Date().toISOString(),periodStart='2026-10-01T00:00:00Z',periodEnd='2026-10-31T00:00:00Z';
 const contexts=principals.map(userId=>({auth:{tenantId:tenant,userId,employeeId:userId,role:'owner' as const},
  provenance:{sourceSystem:'Y4:disposable-original-owner',createdBy:userId}} satisfies PeMutationContext));
 const ref=(owner:string,id:string)=>({owner,id,version:'local-owner-v1',contentDigest:sha({owner,id})});
 const root={entityType:'external_organization' as const,entityId:target};
 const semantics={entityType:'external_organization',entityId:target,periodStart,periodEnd,unit:'currency' as const,
  currencyCode:'USD',frequency:'monthly' as const,calendar:'GREGORIAN' as const,consolidation:'CONSOLIDATED' as const,
  instrument:'EXPLICIT_JOINT_TERMS',scale:'1' as const,sign:'AS_RECORDED' as const};
 const values=reuse?['15.00','8.00','3.00']:['12.00','6.00','2.00'],
  sources:Array<any>=[],http:Array<Record<string,unknown>>=[];
 let commonEnvironment:Record<string,string>={},participantAuthorities:string[]=[];
 let auth:Awaited<ReturnType<typeof localAuth>>|undefined,apiHost:Awaited<ReturnType<typeof installedProcess>>|undefined,
  worker:Awaited<ReturnType<typeof installedProcess>>|undefined,definition:Omit<ConfidentialFunction,'workRevisionRef'>,
  intake:any,planned:any,submitted:any,prepared:any,release:any,consumed:any,consumeRequest:any;
 let browser:Awaited<ReturnType<typeof mountedWorkBrowser>>|undefined,expectedPrivateQuantity:string|undefined,
  originalOpening:any,upstream:Awaited<ReturnType<typeof ownerSetup>>|undefined,
  ownerContinuation:Awaited<ReturnType<typeof ownerConsumption>>|undefined,
  s8:Awaited<ReturnType<typeof confidentialS8Episode>>|undefined;
 let nonrecipientControlSessionId:string|undefined;
 const consumerPolicyKey=generateKeyPairSync('ed25519');
 const firstState=process.env.FINNOR_Y4_PRODUCT_FIRST_PARTICIPANT_STATE;
 if(firstState&&(!isAbsolute(firstState)||!firstState.includes('/PRIVATE-NOT-FOR-HANDOFF/')))
  throw Error('Y4_EXPLICIT_PRIVATE_DISPOSABLE_PARTICIPANT_PATH_REQUIRED');
 if(firstState)await mkdir(dirname(firstState),{recursive:true,mode:0o700});
 const states=reuse?.states??principals.slice(0,3).map((_,i)=>i===0&&firstState?firstState:join(privateDirectory,'p'+i)),
  certificates:Record<string,string>={};
 const api=async(operation:string,body:unknown,principal:string|null=principals[0]!)=>{
  if(!apiHost||!auth)throw Error('Y4_INSTALLED_API_NOT_READY');
  const at=performance.now(),response=await fetch(apiHost.ready.origin+'/api/company-brain/'+operation,{
   method:'POST',headers:{'content-type':'application/json',...(principal?{authorization:'Bearer '+auth.tokens.get(principal)}:{})},
   body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const result=await response.json();
  http.push({operation,principalId:principal,status:response.status,wallMs:performance.now()-at,
   authenticated:principal!==null,privatePayloadRecorded:false});
  if(response.status>=400)await writeFile(join(privateDirectory,'api-response-'+http.length+'.private.json'),
   JSON.stringify({status:response.status,body:result}),{mode:0o600});
  return {status:response.status,body:result};
 };
 const checked=async(operation:string,body:unknown,expected=200,principal=principals[0]!)=>{
  const response=await api(operation,body,principal);
  if(response.status!==expected){
   await writeFile(join(privateDirectory,'unexpected-'+operation+'.json'),JSON.stringify(response,null,2)+'\n',{mode:0o600});
   throw Error('Y4_EXPECTED_INSTALLED_'+operation.toUpperCase().replace(/-/g,'_')+'_'+expected);
  }
  return response.body;
 };
 const ownerCall=async(owner:string,operation:string,body:unknown,principal:string=principals[0]!)=>{
  if(!apiHost||!auth)throw Error('Y4_INSTALLED_API_NOT_READY');
  const at=performance.now(),response=await fetch(apiHost.ready.origin+'/api/'+owner+(operation?'/'+operation:''),{
   method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth.tokens.get(principal)},
   body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
  const result={status:response.status,body:await response.json()};
  http.push({operation:owner+':'+operation,principalId:principal,status:response.status,wallMs:performance.now()-at,
   authenticated:true,privatePayloadRecorded:false});
  if(response.status!==200)await writeFile(join(privateDirectory,'owner-response-'+http.length+'.private.json'),
   JSON.stringify(result,null,2)+'\n',{mode:0o600});
  return result;
 };
 const readNativeRun=async(id:string,principal=principals[0]!)=>{
  if(!apiHost||!auth)throw Error('Y4_INSTALLED_API_NOT_READY');
  const at=performance.now(),response=await fetch(apiHost.ready.origin+'/api/underwriting/runs/'+id,{
   headers:{authorization:'Bearer '+auth.tokens.get(principal)},signal:AbortSignal.timeout(25000)});
  const body=await response.json();
  http.push({operation:'GET:/api/underwriting/runs/[id]',principalId:principal,status:response.status,
   wallMs:performance.now()-at,authenticated:true,privatePayloadRecorded:false});
  if(response.status!==200)await writeFile(join(privateDirectory,'native-run-read-'+http.length+'.json'),
   JSON.stringify({status:response.status,body}),{mode:0o600});
  return {status:response.status,body};
 };
 const scope=async(userId:string,run:(client:pg.Client)=>Promise<unknown>,tenantId=tenant)=>{
  const client=new pg.Client({connectionString:e.appUrl});await client.connect();
  try{await client.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[tenantId,userId]);
   return await run(client);
  }finally{await client.end();}
 };
 const row=async()=>{assert(submitted?.computationId);return (await e.admin.query(
  'SELECT id,status,generation,attempt_count,cpu_reserved_seconds,session,runtime_receipt FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2',
  [tenant,submitted.computationId])).rows[0];};
 const advance=async(predicate:()=>Promise<boolean>,limit=8)=>{
  assert(worker);
  const observations:Array<Record<string,unknown>>=[];
  for(let i=0;i<limit;i++){
   if(await predicate())return observations;
   const tick:{claimed:boolean;workerId:string;leaseSeconds:number;wallMs:number}=await worker.tick(Date.parse(deadlineAt));
   observations.push({claimed:tick.claimed,workerId:tick.workerId,leaseSeconds:tick.leaseSeconds,wallMs:tick.wallMs});
   const current=await row();
   if(['FAILED','RECONCILIATION_REQUIRED','CANCELLED','INVALIDATED','UNSUPPORTED'].includes(current.status))
    throw Object.assign(Error('Y4_PRODUCT_TRANSITION_STOPPED_'+current.status),{code:'Y4_PRODUCT_TRANSITION_STOPPED_'+current.status});
   // An ordinary queue can legitimately be idle or in its two-second empty
   // probe backoff. The persisted owner transition, not an assumed claim,
   // remains the completion predicate.
   if(!tick.claimed)await new Promise(yes=>setTimeout(yes,Math.min(2100,Math.max(0,Date.parse(deadlineAt)-Date.now()))));
  }
  if(!await predicate()){
   const diagnostic=(await e.admin.query(`SELECT jsonb_build_object(
    'work',(SELECT to_jsonb(w) FROM finnor_os.works w WHERE w.tenant_id=$1 AND w.id=$2),
    'loops',(SELECT jsonb_agg(to_jsonb(l)) FROM finnor_os.work_objective_loops l WHERE l.tenant_id=$1 AND l.work_id=$2),
    'plans',(SELECT jsonb_agg(to_jsonb(p)) FROM finnor_os.work_plan_revisions p WHERE p.tenant_id=$1 AND p.work_id=$2),
    'steps',(SELECT jsonb_agg(to_jsonb(s)) FROM finnor_os.work_objective_steps s WHERE s.tenant_id=$1 AND s.work_id=$2),
    'assignments',(SELECT jsonb_agg(to_jsonb(a)) FROM finnor_os.workforce_assignments a WHERE a.tenant_id=$1 AND a.work_id=$2)
   ) diagnostic`,[tenant,intake.workId])).rows[0].diagnostic;
   await writeFile(join(privateDirectory,'native-owner-transition-'+Date.now()+'.private.json'),
    canonical({observations,diagnostic}),{mode:0o600});
   assert.fail('Y4_EXPECTED_NATIVE_OWNER_TRANSITION');
  }
  return observations;
 };
 try{
  await record('original-owner-preparation','three distinct ordinary principals register owned Core originals through existing source owners',async()=>{
   if(!reuse){
   await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y4 disposable joint analysis'),($3,$4,'Y4 separate tenant')",
    [tenant,randomUUID(),foreignTenant,randomUUID()]);
   for(const [userId,tenantId] of [...principals.map(id=>[id,tenant]),[foreign,foreignTenant]])await e.admin.query(
    "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Disposable Y4 owner')",
    [userId,tenantId,userId+'@test.invalid']);
   await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principals[0]!,sourceSystem:'Y4:disposable'});
   await configureTenantVertical({tenantId:foreignTenant,verticalKey:'private_equity',expectedVersion:0,createdBy:foreign,sourceSystem:'Y4:disposable'});
   await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Y4 synthetic analytical target','other')",
    [target,tenant,'y4-'+randomUUID()]);
   }else{
    assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status=$3',
     [tenant,principals,'active'])).rows[0].n,principals.length);
   }
   for(let i=0;i<3;i++){
    const ctx=contexts[i]!,sourceWork=await receiveWork({tenantId:tenant,userId:principals[i]!,instruction:purpose,
     channel:'console',idempotencyKey:'y4-original:'+randomUUID(),activeContext:{focusedEntity:root}});
    await configureInstitutionMandate(ctx,{workId:sourceWork.workId,institutionId:institutions[i],expiresAt:sourceExpiry,
     rules:[{id:'local-source-responsibility',triggerKind:'evidence_request_needed',operation:'create_deal_request',
      principalId:principals[i],deadlineAt:sourceExpiry,materiality:'LOCAL_SOURCE_SCOPE_ONLY_NO_DISPATCH'}]});
    const original=Buffer.from(JSON.stringify([{id:'original-'+i,kind:'quantity',registrationId:'y4-target',
     factKey:'available_liquidity',value:values[i],currency:'USD',unit:'dollars',period:'2026-10',
     basis:'owner_asserted',occurredAt:worldAt,availableAt:worldAt}]));
    const version=await withTenantTransaction(tenant,{userId:principals[i]},async db=>{
     const document=await createDocument(db,{tenantId:tenant,kind:'source_export',title:'Synthetic participant-owned financial original',
      provenance:{sourceSystem:'Y4:synthetic-original',externalId:'y4-source-'+randomUUID(),createdBy:principals[i]!}});
     return appendDocumentVersion(db,{tenantId:tenant,documentId:document.documentId,bytes:original,
      mediaType:'application/json',format:'unknown',origin:'manual_upload',actor:principals[i]!,
      sourceSystem:'Y4:synthetic-original',sourceRef:'p'+i,providerVersionId:'owner-revision-1'});
    });
    const grant=await registerInstitutionCoreSource(ctx,{workId:sourceWork.workId,documentId:version.document_id,
     documentVersionId:version.id,sourceClass:'financial_ledger',protocol:'json_records',purpose,expiresAt:sourceExpiry});
    sources.push({sourceWork,grant,originalSha256:createHash('sha256').update(original).digest('hex')});
   }
   auth=await localAuth([...principals,foreign]);
   const common={SUPABASE_URL:auth.origin,SUPABASE_SERVICE_ROLE_KEY:auth.serviceKey,FINNOR_Y4_BACKEND:backend,
    FINNOR_Y4_PARTICIPANT_REGISTRY:registry,FINNOR_Y4_SCRATCH:scratch,WORKER_JOB_LEASE_SECONDS:'15',
    FINNOR_S8_CONFIDENTIAL_CONSUMER_CONFIG:join(privateDirectory,'s8-consumer-policy.json'),
    FINNOR_S8_CONFIDENTIAL_CONSUMER_ROOT:consumerPolicyKey.publicKey.export({type:'spki',format:'pem'}).toString(),
    ...(process.env.FINNOR_S3_PYTHON?{FINNOR_S3_PYTHON:process.env.FINNOR_S3_PYTHON,
     FINNOR_S5_PYTHON:process.env.FINNOR_S3_PYTHON,
     FINNOR_S3_MODEL_STORE:join(privateDirectory,'scientific-models'),FINNOR_S4_POLICY_STORE:join(privateDirectory,'control-policies')}:{})};
   commonEnvironment=common;
   apiHost=await installedProcess('api-host',installation,{...common,DATABASE_URL:e.appUrl},privateDirectory);
   worker=await installedProcess('worker-loop',installation,{...common,DATABASE_URL:e.workerUrl},privateDirectory);
   assert.equal(apiHost.ready.actualEmittedRoute,true);assert.equal(worker.ready.productionWorkerFactory,true);
   assert(worker.ready.registeredTypes.includes('run_confidential_economic_computation_v1'));
   // This migration fixture has not activated a production class cutover.
   return {principals:principals.slice(0,3),institutions,originalsRegistered:3,sourceTruthProven:false,
    separatelyAdministered:false,ordinaryRoles:true,installedRoute:true,realWorkerFactory:true,
    installationDigest:apiHost.installationDigest,computeClassActivation:false};
  });
  await record('opaque-source-authority','real issuer denies cross-owner and cross-tenant access and returns no original-byte hash',async()=>{
   for(let i=0;i<3;i++){
    const input={workId:sources[i].sourceWork.workId,grantId:sources[i].grant.id},
     handle=await checked('confidential-source-handle',input,200,principals[i]);
    const replay=await checked('confidential-source-handle',input,200,principals[i]);
    assert.equal(handle.id,replay.id);assert.equal(handle.digest,replay.digest);
    assert(!JSON.stringify(handle).includes(sources[i].originalSha256));
    assert(!Object.hasOwn(handle.body,'originalSha256'));assert(!Object.hasOwn(handle.body,'private_cut'));
    sources[i].handle=handle;
    const other=await api('confidential-source-handle',input,principals[(i+1)%3]);
    assert(other.status>=400);assert(!JSON.stringify(other.body).includes(sources[i].originalSha256));
   }
   const denied=await api('confidential-source-handle',{workId:sources[0].sourceWork.workId,grantId:sources[0].grant.id},foreign);
   assert(denied.status>=400);
   await scope(principals[1]!,async c=>{
    assert.equal((await c.query('SELECT id FROM finnor_os.y4_source_handles WHERE id=$1',[sources[0].handle.id])).rowCount,0);
    let code='';try{await c.query('SELECT finnor_os.y4_private_source_cut($1,$2)',[tenant,sources[0].grant.id]);}catch(error){code=String((error as any).code);}
    assert.equal(code,'42501');
   });
   return {handles:sources.map(s=>({id:s.handle.id,digest:s.handle.digest})),crossOwnerDenied:true,
    crossTenantDenied:true,privateComparisonNotExecutable:true,rawOwnerRowHidden:true,
    originalByteHashesAbsent:true,executionAuthorityGranted:false};
  });
  if(ownerCase)await record('ordinary-live-control-before-private-reservation',
   'the authenticated nonrecipient opens its own ordinary control session before any private native S5 reservation exists',async()=>{
    const complete=await scope(principals[1]!,async c=>(await c.query('SELECT finnor_os.y4_allocation_context_complete() complete')).rows[0].complete);
    assert.equal(complete,true);
    const opened=await ownerCall('live-controls','',{operation:'open',input:{workId:sources[1].sourceWork.workId,
     root,focus:{type:'external_organization',id:target}}},principals[1]!);
    assert.equal(opened.status,200);nonrecipientControlSessionId=opened.body.sessionId;assert(nonrecipientControlSessionId);
    return {sessionId:nonrecipientControlSessionId,allocationContextComplete:true,actualInstalledHttpStatus:opened.status,financialMutation:false};
   });
  await record('ordinary-read-only-workforce','the disposable owner configures only registered analytical reader/check routing, never action authority',async()=>{
   const configured=await configureAgentProfile(tenant,createDefaultPluginRegistry(),{
    key:'y4-local-analytical-reader-'+sources[0].sourceWork.workId,
    name:'Local confidential metadata verifier',actor:contexts[0]!.auth,
    modelRoute:{provider:'orchestration_runtime',model:null,purpose:'objective_execution'},
    capabilityGrants:[{kind:'query',capability:'query:confidential_economic_computation_v1'},
     {kind:'check',capability:'check:objective_success'}],maxConcurrentAssignments:4,
    autonomyLimits:{maxActions:1,maxQueries:8,maxWallClockMs:3500_000},
   });
   const grants=configured.revision.capabilityGrants as Array<{kind:string;capability:string}>;
   assert(grants.every(grant=>grant.kind!=='action'));
   return {profileId:configured.profile.id,revisionId:configured.revision.id,modelProvider:'orchestration_runtime',
    grants:configured.revision.capabilityGrants,actionCapabilities:0,originalObjectiveMaxActions:0,
    disposableTenantOnly:true,newS1GrantsOrSigners:false,externalExecutionAuthority:false};
  });
  if(caseName==='owner-context')await record('actual-upstream-owner-context',
   'existing S3 fits generated ordinary observations and actual S4/S5 owners prepare the original mandate, policy and resources before confidential intake',
   async()=>{
    upstream=await ownerSetup({admin:e.admin,privateDirectory,tenant,principal:principals[0]!,
     nonrecipient:principals[1]!,root,deadlineAt,call:ownerCall});
    return {actualS3Fitted:true,actualS4Policy:true,actualS5Resource:true,
     suppliedSyntheticObservations:true,causalQualification:false,notConfidentialInputOrOutput:true,executionAuthorityGranted:false};
   });
  if(caseName==='owner-context')return;
  const authority=await Promise.all(contexts.slice(0,3).map(ctx=>employeeAuthoritySnapshot(ctx.auth)));
  definition={schema:'finnor.confidential-function.v1',functionRef:ref('P1','local-joint-liquidity-'+randomUUID()),
   baselineManifestRef:ref('P1','local-installed-'+apiHost!.installationDigest),objectiveRef:ref('S4','local-analytical-objective'),
   mandateRef:ref('S6','LOCAL_DECLARATION_NOT_EXECUTION_AUTHORITY'),
   jointSemanticsRef:ownerCase
    ?ownerFixtureReference('declared-complete-cost-net-utility','BUSINESS_OWNER'):ref('P1','local-explicit-joint-terms'),
   purpose,participants:institutions.map((institutionId,i)=>({id:'p'+i,institutionId,
    authorityRef:{owner:'S1',id:principals[i]!,version:String(authority[i]!.revision),
     contentDigest:sha({tenantId:tenant,principalId:principals[i],revision:authority[i]!.revision})}})),
   inputs:sources.map((source,i)=>({key:['a','b','c'][i]!,participantId:'p'+i,semantics,lower:'-100',upper:'100',
    decimalPlaces:2,sourceRef:source.handle.sourceRef,grantRef:source.handle.grantRef,
    validationRef:ref('Y4_LOCAL_OWNER_VALIDATION_NOT_PRIMARY','local-validation-'+i),
    primaryEvidenceRef:null,sourceStatus:'OWNER_ASSERTED',freshUntil:deadlineAt,rounding:'EXACT_OR_REJECT'})),
   outputs:[{key:'joint_liquidity',expression:{kind:'subtract',left:{kind:'add',left:{kind:'input',key:'a'},
    right:{kind:'input',key:'b'}},right:{kind:'input',key:'c'}},semantics,recipients:['p0']}],
   release:{familyId:'local-original-family-'+randomUUID(),policyRef:ref('S1','one-prepared-source-use'),
    termsRef:ref('S6','local-output-consent-not-dispatch'),maxDistinctFunctions:1}};
  const limits={deadlineAt,maxAttempts:2,maxCpuSeconds:3600,maxMemoryBytes:8*1024**3,maxRetainedBytes:16*1024*1024},
   original={schema:'finnor.y4.intake.v1',root,function:definition,limits,idempotencyKey:randomUUID()};
  await record('original-intake-selected-plan','authenticated exact intake selects the native goal without rewriting an existing Work input',async()=>{
   const missing=await api('confidential-intake',original,null);assert.equal(missing.status,401);
   intake=await checked('confidential-intake',original);
   const replay=await checked('confidential-intake',original);assert.equal(replay.workId,intake.workId);
   assert.equal(replay.workInputId,intake.workInputId);
   const planInput={schema:'finnor.y4.plan.v1',root,workId:intake.workId,workInputId:intake.workInputId,function:definition,limits};
   planned=await checked('confidential-plan',planInput);
   const planReplay=await checked('confidential-plan',planInput);assert.deepEqual(planned.workRevisionRef,planReplay.workRevisionRef);
   const native=(await e.admin.query(`SELECT i.instruction_text,i.context_snapshot,p.goal_spec,p.constraint_set FROM finnor_os.work_inputs i
    JOIN finnor_os.work_plan_revisions p ON p.tenant_id=i.tenant_id AND p.work_input_id=i.id
    WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3 AND p.id=$4`,
   [tenant,intake.workId,intake.workInputId,planned.workRevisionRef.id])).rows[0];
   assert.equal(native.instruction_text,purpose);
   assert.equal(native.context_snapshot.confidentialAcceptedRequestDigest,sha({root,function:definition,limits}));
   assert.equal(native.goal_spec.criteria.length,4);assert.equal(native.constraint_set.budgets.maxActions,0);
   return {workId:intake.workId,workInputId:intake.workInputId,planRevisionId:planned.workRevisionRef.id,
    exactIntakeReplayed:true,exactPlanReplayed:true,unauthenticatedDenied:true,originalCriteria:4,maxActions:0,originalDeadlineAt:deadlineAt};
  });
  await record('durable-queue-independent-compilation','the actual worker claims the API-created job and publishes checked original semantics',async()=>{
   const input={schema:'finnor.y4.submit.v1',root,workId:intake.workId,workInputId:intake.workInputId,
    function:{...definition,workRevisionRef:planned.workRevisionRef},limits,idempotencyKey:randomUUID()};
   submitted=await checked('confidential-submit',input,202);
   const replay=await checked('confidential-submit',input,202);
   assert.equal(replay.computationId,submitted.computationId);assert.equal(replay.replayed,true);
   const permits=await acquireComputeResourceLeases({tenantId:tenant,resourceKeys:['native:y4-confidential'],
    requiredResourceKeys:['native:y4-confidential'],workloadClass:'INTERACTIVE',ownerId:'y4-disposable-contention:'+randomUUID()});
   let deferred:any;
   try{
    for(let i=0;i<12;i++){
     await worker!.tick(Date.parse(deadlineAt));
     deferred=(await e.admin.query(`SELECT status,attempts,capacity_defer_count,run_at FROM finnor_os.jobs WHERE id=$1`,
      [submitted.jobId])).rows[0];
     if(deferred.capacity_defer_count>0)break;
    }
    assert.equal(deferred.status,'queued');assert.equal(deferred.attempts,0);assert.equal(deferred.capacity_defer_count,1);
    assert.equal((await row()).status,'QUEUED');assert.equal((await row()).cpu_reserved_seconds,0);
    assert.equal((await e.admin.query(`SELECT 1 FROM finnor_os.y4_events WHERE tenant_id=$1 AND computation_id=$2
     AND kind IN('COMPILER_STARTED','NATIVE_STARTED')`,[tenant,submitted.computationId])).rowCount,0);
   }finally{await releaseComputeResourceLeases(permits,'y4_disposable_contention_finished');}
   await new Promise(yes=>setTimeout(yes,Math.max(0,deferred.run_at.getTime()-Date.now()+50)));
   const ticks=await advance(async()=>(await row()).status==='AWAITING_PARTICIPANTS');
   const read=await checked('confidential-read',{computationId:submitted.computationId});
   assert.equal(read.correspondence.status,'CHECKED');assert.equal((await row()).cpu_reserved_seconds,16);
   const deliveries=(await e.admin.query(`SELECT d.outcome,d.claim_fence,j.type,j.status,j.attempts
    FROM finnor_os.job_delivery_attempts d JOIN finnor_os.jobs j ON j.id=d.job_id
    WHERE j.id=$1 ORDER BY d.started_at`,[submitted.jobId])).rows;
   assert.equal(deliveries.length,2);assert.equal(deliveries[0].outcome,'capacity_deferred');
   assert.equal(deliveries[1].outcome,'completed');assert.equal(deliveries[1].attempts,1);
   return {computationId:submitted.computationId,jobId:submitted.jobId,ticks,deliveries,
    correspondenceChecked:true,compileAndCheckCpuReservationSeconds:16,duplicateDidNotEnqueue:true,
    actualSharedCapacityDeferredBeforeDispatch:true,noCapacityRetryChargeOrInputDelivery:true};
  });
  await record('participant-local-consent-and-commitments','three local owners bind originals and TLS identities without delivering plaintext to the API',async()=>{
   const current=await checked('confidential-read',{computationId:submitted.computationId});
   // The protocol is published by the real worker, not reconstructed here.
   const protocol=(await e.admin.query('SELECT protocol FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2',
    [tenant,submitted.computationId])).rows[0].protocol;
   for(let i=0;i<3;i++){
    await mkdir(join(states[i]!,'Player-Data'),{recursive:true,mode:0o700});
    if(!reuse)await exec('openssl',['req','-newkey','rsa:2048','-nodes','-x509','-days','1','-out',
     join(states[i]!,'Player-Data',`P${i}.pem`),'-keyout',join(states[i]!,'Player-Data',`P${i}.key`),'-subj',`/CN=P${i}`],
    {timeout:15000,maxBuffer:65536});
    certificates['p'+i]=createHash('sha256').update(await readFile(join(states[i]!,'Player-Data',`P${i}.pem`))).digest('hex');
   }
   for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(i!==j&&!reuse)await copyFile(
    join(states[j]!,'Player-Data',`P${j}.pem`),join(states[i]!,'Player-Data',`P${j}.pem`));
   const authorityDirectories=reuse?principals.slice(0,3).map((_,i)=>join(privateDirectory,'fresh-authority-p'+i)):states;
   for(const path of authorityDirectories)await mkdir(path,{recursive:true,mode:0o700});
   const agents=states.map((stateDirectory,i)=>({tenantId:tenant,institutionId:institutions[i],participantId:'p'+i,
    principalId:principals[i],authorityPath:join(authorityDirectories[i]!,'authority.json'),stateDirectory}));
   participantAuthorities=agents.map(a=>a.authorityPath);
   await writeFile(registry,JSON.stringify(agents),{mode:0o600,flag:'wx'});
   for(let i=0;i<3;i++)await checked('confidential-consent',{computationId:submitted.computationId,participantId:'p'+i,
    certificateDigest:certificates['p'+i],validUntil:deadlineAt,idempotencyKey:randomUUID(),
    scope:'THIS_EXACT_FUNCTION_INPUT_CUT_AND_LISTED_RECIPIENTS_ONLY',
    retention:'RETAIN_AUDIT_DENY_FUTURE_DERIVATIVES_NO_RETROACTIVE_UNLEARNING'},200,principals[i]);
   await scope(principals[0]!,async c=>{
    for(let i=0;i<3;i++)assert.equal((await c.query('SELECT finnor_os.y4_source_handle_current($1,$2,$3) current',
     [submitted.computationId,'p'+i,sources[i].handle.id])).rows[0].current,true);
   });
   await scope(principals[3]!,async c=>assert.equal((await c.query('SELECT finnor_os.y4_source_handle_current($1,$2,$3) current',
    [submitted.computationId,'p0',sources[0].handle.id])).rows[0].current,false));
   prepared=await checked('confidential-prepare',{computationId:submitted.computationId});
   assert.deepEqual(prepared.protocol,protocol);assert.equal(current.current,true);
   const prepareBundle=join(privateDirectory,'participant-prepare-bundle.json');
   await writeFile(prepareBundle,canonical({protocol,session:prepared.session}),{mode:0o600,flag:'wx'});
   for(let i=0;i<3;i++){
    const port=protocol.function.inputs[i],participant=protocol.function.participants[i],records={
     [port.key]:{key:port.key,value:values[i],sourceRef:port.sourceRef,validationRef:port.validationRef}};
    const cut={schema:'finnor.y4.local-owner-cut.v1',participantId:'p'+i,institutionId:institutions[i],
     authorityRef:participant.authorityRef,functionDigest:protocol.functionDigest,purpose,releasePolicyRef:definition.release.policyRef,
     revoked:false,epoch:1,expiresAt:deadlineAt,sourceRefs:[port.sourceRef],grantRefs:[port.grantRef],validationRefs:[port.validationRef],
     recordDigests:Object.fromEntries(Object.entries(records).map(([key,value])=>[key,sha(value)])),
     outputRecipients:{joint_liquidity:['p0']}};
    const recordsPath=join(authorityDirectories[i]!,'records.private.json');
    await writeFile(agents[i]!.authorityPath,canonical(cut),{mode:0o600,flag:'wx'});
    await writeFile(recordsPath,canonical(records),{mode:0o600,flag:'wx'});
    const result=await exec('/usr/bin/python3',['-B',join(assets,'participant.py'),'prepare','--bundle',prepareBundle,
     '--participant','p'+i,'--authority',agents[i]!.authorityPath,'--state',states[i]!,'--records',recordsPath],
    {timeout:15000,maxBuffer:1024*1024});
    const commitment=JSON.parse(result.stdout);
    assert(!JSON.stringify(commitment).includes('recordDigests'));
    await checked('confidential-commit',{computationId:submitted.computationId,participantId:'p'+i,
     idempotencyKey:randomUUID(),commitment},200,principals[i]);
   }
   const q=await row();assert.equal(q.status,'READY');
   await writeFile(join(privateDirectory,'authorized-rerun-fixture.json'),canonical({original,sources,values,intake,planned,submitted,prepared}),{mode:0o600});
   return {participants:3,coordinatorCanVerifyConsentedCuts:true,unconsentedVerifierDenied:true,
    independentNativeReconstructionStillRequired:true,publicCommitmentsOnly:true,
    preparedSessionId:q.session.sessionId,status:q.status,sourceTruthProven:false,commonAdministrator:true};
  });
  if(process.env.FINNOR_Y4_BROWSER==='1')await record('mounted-world-original-state',
   'the actual authenticated WORLD projection opens the retained original Work and confidential panel before MPC',async()=>{
    browser=await mountedWorkBrowser({evidence,privateDirectory,sourceRepository:join(installation,'runtime'),
     apiOrigin:apiHost!.ready.origin,auth:auth!,root,workId:intake.workId,recipient:principals[0]!,nonrecipient:principals[1]!});
    return browser.initialEvidence;
   });
  if(caseName==='authority')return;
  const owners:OriginalOwners={tenant,foreignTenant,principals,foreign,target,institutions,states,deadlineAt,sourceExpiry};
  const facts=()=>({owners,computationId:submitted.computationId,workId:intake.workId,sessionId:prepared.session.sessionId,
   sourceIds:definition.inputs.map(port=>port.sourceRef.id)});
  const restartWorker=async()=>{
   await worker!.close();
   worker=await installedProcess('worker-loop',installation,{...commonEnvironment,DATABASE_URL:e.workerUrl},privateDirectory);
   return worker;
  };
  const crash=()=>canonicalCrashAndReconcile({admin:e.admin,tenant,computationId:submitted.computationId,states,deadlineAt,
   evidence,privateDirectory,worker:worker!,restartWorker,call:api});
  if(caseName==='cancellation-disposal'){
   await record('bounded-all-owner-cancellation-disposal',
    'actual API cancellation aborts later verified owners while the earlier owner writer lock is held, then burns every original session without input delivery or refunds',
    ()=>cancellationDisposal({admin:e.admin,tenant,computationId:submitted.computationId,states,deadlineAt,
     evidence,privateDirectory,worker:worker!,call:api}));
   return facts();
  }
  if(caseName==='recovery'){
   let recovery:Awaited<ReturnType<typeof canonicalCrashAndReconcile>>|undefined;
   await record('canonical-worker-crash-and-read-only-reconciliation',
    'actual native input delivery is physically stopped; the expired original job is quarantined and the authenticated queued reconciliation never reruns input',
    async()=>{recovery=await crash();return recovery.summary;});
   assert(recovery);return {...facts(),recovery};
  }
  if(caseName==='effect-preservation'){
   await record('actual-unrelated-effect-preservation',
    'a separately authorized synthetic loopback S6 operation and UNKNOWN_OUTCOME liabilities survive a real Y4 worker crash and cancellation, then recover without duplicate mutation',
    ()=>effectPreservation({admin:e.admin,privateDirectory,evidence,foreignTenant,foreign,deadlineAt,
     installation,ownerCall,call:api,computationId:submitted.computationId,crash,
     restartApi:async()=>{
      await apiHost!.close();
      const transport=Object.fromEntries(['FINNOR_S6_CURRENT_OWNER_SIGNER','FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT']
       .flatMap(name=>process.env[name]?[[name,process.env[name]!]]:[]));
      apiHost=await installedProcess('api-host',installation,{...commonEnvironment,...transport,DATABASE_URL:e.appUrl},privateDirectory);
     }}));
   return facts();
  }
  await record('installed-native-mpc','the real durable worker runs fresh malicious-secure MPC and all three participants reconstruct native tapes',async()=>{
   const ticks=await advance(async()=>(await row()).status==='COMPUTED',4),q=await row();
   assert.equal(q.runtime_receipt.receipts.length,3);
   assert(q.runtime_receipt.receipts.every((r:any)=>r.state==='COMPLETED'&&r.nativeIndependentlyReconstructed===true));
   assert.equal(q.runtime_receipt.outputs,'RECIPIENT_LOCAL_ONLY');
   return {ticks,status:q.status,participants:3,independentNativeRebuilds:3,authenticatedOutputCommitments:true,
    sourceTruthProven:false,aggregatePeakMemoryBytes:null,originalDeadlineAt:deadlineAt,cpuReservedSeconds:q.cpu_reserved_seconds};
  });
  await record('recipient-release','only the designated recipient can import a complete MPC-authenticated opening',async()=>{
   const q=(await e.admin.query('SELECT protocol,session FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2',
    [tenant,submitted.computationId])).rows[0],
    commitments=(await e.admin.query('SELECT body FROM finnor_os.y4_commitments WHERE tenant_id=$1 AND computation_id=$2 ORDER BY participant_id',
     [tenant,submitted.computationId])).rows,
    bundle={protocol:q.protocol,binding:{session:q.session,inputs:commitments.flatMap(r=>r.body.inputs)}},
    bundlePath=join(privateDirectory,'recipient-export-bundle.json');
   await writeFile(bundlePath,canonical(bundle),{mode:0o600,flag:'wx'});
   const exported=await exec('/usr/bin/python3',['-B',join(assets,'participant.py'),'export','--bundle',bundlePath,
    '--participant','p0','--authority',participantAuthorities[0]!,'--state',states[0]!],{timeout:15000,maxBuffer:1024*1024});
   const opening=JSON.parse(exported.stdout),input={computationId:submitted.computationId,participantId:'p0',
    releaseNonce:opening.releaseNonce,outputs:opening.outputs,idempotencyKey:randomUUID()};
   originalOpening=opening;
   const forged=await api('confidential-import-release',{...input,releaseNonce:'0'.repeat(32)});assert.equal(forged.status,409);
   const other=await api('confidential-import-release',input,principals[1]);assert(other.status>=400);
   release=await checked('confidential-import-release',input);
   const replay=await checked('confidential-import-release',input);assert.equal(replay.releaseId,release.releaseId);
   const recipient=await checked('confidential-read',{computationId:submitted.computationId});
   const nonrecipient=await checked('confidential-read',{computationId:submitted.computationId},200,principals[1]);
   assert.equal(recipient.releases.length,1);assert.equal(nonrecipient.releases.length,0);
   assert(!JSON.stringify(nonrecipient).includes(opening.releaseNonce));
   const complete=recipient.releases[0].body;
   assert.equal(complete.schema,'finnor.confidential-economic-computation.v2');
   assert.equal(complete.envelope.artifact_id,release.releaseId);
   assert.equal(complete.envelope.tenant_and_participant_scope.recipientId,'p0');
   assert.equal(complete.envelope.baseline_manifest_ref.status,'unknown');
   assert(complete.envelope.admission_and_release_refs.some((b:any)=>b.status==='unknown'&&b.requiredOwnerOrInput.includes('S8')));
   assert.equal(complete.independently_checked_result_basis.protectedIndependentResultCheck.status,'unknown');
   assert.equal(recipient.construction.result,'CHECKED');assert.equal(nonrecipient.construction.result,'CANDIDATE');
   const artifactPath=join(states[0]!,'complete-recipient-artifact.private.json');
   await writeFile(artifactPath,JSON.stringify(complete),{mode:0o600,flag:'wx'});
   const artifactOracle=await exec('/usr/bin/python3',['-B','-c',
    "import hashlib,json,sys; a=json.load(open(sys.argv[1])); d=a['envelope'].pop('content_digest'); " +
    "assert hashlib.sha256(json.dumps(a,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()==d; " +
    "print('COMPLETE_ARTIFACT_DIGEST_MATCH')",artifactPath],{timeout:15000,maxBuffer:65536});
   assert.equal(artifactOracle.stdout.trim(),'COMPLETE_ARTIFACT_DIGEST_MATCH');
   const actual=quantity(opening.outputs[0]),oracle=(await e.admin.query(
    'SELECT $1::numeric=$2::numeric+$3::numeric-$4::numeric matches',[actual,...values])).rows[0].matches;
   assert.equal(oracle,true);
   expectedPrivateQuantity=actual;
   return {releaseId:release.releaseId,forgedOpeningDenied:true,nonrecipientImportDenied:true,
    completePrincipalArtifact:true,independentPythonEnvelopeDigest:true,independentPostgresNumericMatch:true};
  });
  if(ownerCase)await record('actual-upstream-owner-context',
   'actual S3/S4/S5 owners resolve the completed original source/Work cut, retaining the function original accounting terms and deadline',
   async()=>{
    upstream=await ownerSetup({admin:e.admin,privateDirectory,tenant,principal:principals[0]!,
     nonrecipient:principals[1]!,root,deadlineAt,call:ownerCall});
    assert.deepEqual(upstream.f.mandate.utility.accountingConventionRef,definition.jointSemanticsRef);
    return {actualS3Fitted:true,actualS4Policy:true,actualS5Resource:true,
     suppliedSyntheticObservations:true,causalQualification:false,notConfidentialInputOrOutput:true,
     originalJointTermsRetained:true,originalDeadlineRetained:true,executionAuthorityGranted:false};
   });
  if(ownerCase)await record('actual-recipient-s4-s5-s6-continuation',
   'the exact released quantity reaches real S4 choice, S5 optimization/check/reservation/consumption and S6 preparation before unrelated underwriting writes change S1',
   async()=>{
    assert(upstream&&originalOpening);
    ownerContinuation=await ownerConsumption({setup:upstream,admin:e.admin,tenant,principal:principals[0]!,
     nonrecipient:principals[1]!,semantics,workId:intake.workId,computationId:submitted.computationId,releaseId:release.releaseId,
     opening:originalOpening,call:api,ownerCall,scope});
    return ownerContinuation.summary;
   });
  if(ownerCase)await record('private-native-allocation-is-not-zero-capacity',
   'after real recipient S4/S5/S6 continuation, the same ordinary nonrecipient session refuses an incomplete global allocation cut instead of publishing filtered capacity',async()=>{
    assert(ownerContinuation&&nonrecipientControlSessionId);
    const complete=await scope(principals[1]!,async c=>(await c.query('SELECT finnor_os.y4_allocation_context_complete() complete')).rows[0].complete);
    assert.equal(complete,false);
    const denied=await ownerCall('live-controls','',{operation:'snapshot',input:{sessionId:nonrecipientControlSessionId}},principals[1]!);
    assert.equal(denied.status,404);assert.equal(denied.body.code,'PERMITTED_CONTEXT_UNAVAILABLE');
    assert(!JSON.stringify(denied.body).includes(originalOpening.releaseNonce));
    return {sessionId:nonrecipientControlSessionId,allocationContextComplete:false,actualInstalledHttpStatus:denied.status,
     refusalCode:denied.body.code,actualNativePrivateReservation:true,privacyFilteredCapacityNotPublished:true};
   });
  if(caseName==='owner-commit-race'){
   await record('actual-native-s6-revocation-commit-race',
    'a separately observed real final S6 commit refuses consent revocation before unrelated underwriting changes the original owner source pins',
    async()=>{
     assert(ownerContinuation);
     const race=await revokeAtNativeS6Commit({appUrl:e.appUrl,admin:e.admin,tenant,principal:principals[0]!,
      pending:ownerContinuation.pendingS6,evidence,privateDirectory,ownerCall,
      revoke:()=>checked('confidential-revoke',{computationId:submitted.computationId,participantId:'p1',
       reason:'Local native final-commit race',idempotencyKey:randomUUID()},200,principals[1])});
     return {...race,computationId:submitted.computationId};
    });
   return facts();
  }
  await record('recipient-release-and-native-consumer','the recipient uses the exact accepted output in the actual native underwriting model',async()=>{
   assert(expectedPrivateQuantity&&originalOpening);
   const actual=expectedPrivateQuantity,opening=originalOpening;
   const deal=await createDeal(contexts[0]!,{targetOrganizationId:target,name:'Local Y4 analytical consumer',
    dealLeadEmployeeId:principals[0]!,signedLoiAt:new Date(worldAt),targetClosingAt:new Date(Date.parse(worldAt)+86400_000)});
   const investment=await createInvestmentCase(contexts[0]!,{dealId:String(deal.row.id),title:'Recipient-only local analysis'}),
    investmentCaseId=String(investment.row.id),modelKey='y4-local-'+randomUUID();
   const model=await createUnderwritingModel(contexts[0]!,{investmentCaseId,modelKey,name:'Explicit confidential analytical input'});
   const modelDefinition:UnderwritingModelIR={schemaVersion:'underwriting-model-ir.v1',modelKey,modelVersion:'1',
    financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',
    periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
     {id:'confidential_value',kind:'input',dependencies:[],valueType:'decimal',unit:'money',currency:'USD',shape:'scalar',
      required:true,allowedTruthClasses:['DERIVED_VALUE'],evidenceSemantics:semantics},
     {id:'answer',kind:'output',dependencies:['confidential_value'],sourceNodeId:'confidential_value',
      valueType:'decimal',unit:'money',currency:'USD',shape:'scalar'}]};
   const version=await createUnderwritingModelVersion(contexts[0]!,{modelId:String(model.id),definition:modelDefinition});
   consumeRequest={investmentCaseId,modelVersionId:String(version.id),worldAt,
    workId:intake.workId,idempotencyKey:randomUUID(),
    bindings:{confidential_value:{computationId:submitted.computationId,releaseId:release.releaseId,output:'joint_liquidity'}}};
   consumed=await checked('confidential-underwriting',consumeRequest);
   assert.equal(consumed.result.status,'SUCCEEDED');assert.equal(consumed.result.validity,'VALID');
   assert.equal((await e.admin.query('SELECT $1::numeric=$2::numeric matches',[consumed.result.outputs.answer.value,actual])).rows[0].matches,true);
   assert(consumed.result.confidentialCommitmentSalt);assert(consumed.inputSnapshot.confidentialCommitmentSalt);
   const nativeRead=await readNativeRun(consumed.id);assert.equal(nativeRead.status,200);
   assert.equal(nativeRead.body.id,consumed.id);
   assert.equal((await readNativeRun(consumed.id,principals[1]!)).status,404);
   await scope(principals[1]!,async c=>assert.equal((await c.query('SELECT id FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',
    [tenant,consumed.id])).rowCount,0));
   const descriptorResponse=await fetch(apiHost!.ready.origin+'/api/live-controls',{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth!.tokens.get(principals[0]!)},
    body:JSON.stringify({operation:'open',input:{workId:intake.workId,root,focus:{type:'pe_investment_case',id:investmentCaseId}}}),
    signal:AbortSignal.timeout(25000)});
   const descriptor=await descriptorResponse.json();
   assert.equal(descriptorResponse.status,404);assert.equal(descriptor.code,'PERMITTED_CONTEXT_UNAVAILABLE');
   assert.equal((await e.admin.query(`SELECT count(*)::int n FROM finnor_os.v5_sessions
    WHERE tenant_id=$1 AND work_id=$2 AND focus->>'id'=$3`,[tenant,intake.workId,investmentCaseId])).rows[0].n,1);
   assert(!JSON.stringify(descriptor).includes(opening.releaseNonce));
   const events=(await e.admin.query("SELECT payload FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_type='underwriting_run' AND entity_id=$2",
    [tenant,consumed.id])).rows;
   assert(events.length>0);
   assert(!JSON.stringify(events).includes(opening.releaseNonce));
   assert(events.every(event=>!Object.hasOwn(event.payload,'validity')));
   return {releaseId:release.releaseId,runId:consumed.id,independentPostgresNumericMatch:true,nativeRunSucceeded:true,
    nativeRunValid:true,forgedOpeningDenied:true,nonrecipientImportDenied:true,nonrecipientRunHiddenByRls:true,
    recipientNativeOwnerRead:true,nonrecipientNativeOwnerReadDenied:true,
    privateHidingContextPresent:true,genericBusinessEvents:true,sourceTruthProven:false,onwardAdmission:false,
    completePrincipalArtifact:true,independentPythonEnvelopeDigest:true,missingQualificationAndCostsExplicit:true,
    unadmittedLiveControlDescriptorDeniedAfterRealSessionOpen:true};
  });
  await record('canonical-work-completion','only ordinary controller delivery records the original four-criterion Work completion proof',async()=>{
   const readCompletion=async()=>(await e.admin.query(`SELECT w.status work_status,l.state objective_state,l.success_verification,
    p.status plan_status,p.completion_proof FROM finnor_os.works w
    JOIN finnor_os.work_objective_loops l ON l.tenant_id=w.tenant_id AND l.work_id=w.id
    JOIN finnor_os.work_plan_revisions p ON p.tenant_id=w.tenant_id AND p.work_id=w.id
    WHERE w.tenant_id=$1 AND w.id=$2 AND p.id=$3`,[tenant,intake.workId,planned.workRevisionRef.id])).rows[0];
   const ticks=await advance(async()=>(await readCompletion())?.work_status==='completed',12),completion=await readCompletion();
   assert.equal(completion.objective_state,'completed');assert.equal(completion.success_verification.state,'verified');
   assert.equal(completion.plan_status,'completed');assert.equal(completion.completion_proof.verified,true);
   assert.equal(completion.completion_proof.finalPlanRevisionId,planned.workRevisionRef.id);
   await artifact(evidence,'native-work-completion.json',completion);
   const reread=await checked('confidential-read',{computationId:submitted.computationId});assert.equal(reread.current,true);
   const replay=await checked('confidential-underwriting',consumeRequest);
   assert.equal(replay.id,consumed.id);assert.deepEqual(await readCompletion(),completion);
   return {ticks,workId:intake.workId,originalWorkCompleted:true,originalInputRetained:true,
    originalPlanCompleted:true,successVerification:'verified',proof:'native-work-completion.json',
    noFixtureCompletionWrites:true,terminalConsumeReplaySafe:true,completionProofUnchangedOnReplay:true,executionAuthorityGranted:false};
  });
  if(browser)await record('mounted-recipient-scope-and-reload',
   'stored recipient evidence survives authorized reload but clears offline and across delayed principal changes',async()=>{
    assert(expectedPrivateQuantity);
    return browser!.verifyRecipient(expectedPrivateQuantity);
   });
  if(caseName==='fresh-authorized')return facts();
  await record('actual-typed-s8-construction-review',
   'real S8 native-proof review uses separate evaluator/promoter keys, real ledger, lost-response replay and cold restart without claiming protected qualification',
   async()=>{
    s8=await confidentialS8Episode({installation,privateDirectory,evidence,appUrl:e.appUrl,admin:e.admin,
     tenant,principal:principals[0]!,evaluator:principals[2]!,computationId:submitted.computationId,
     releaseId:release.releaseId,deadlineAt,consumerPolicyKey:consumerPolicyKey.privateKey,call:api});
    return s8.summary;
   });
  await record('revocation-and-recipient-derivative-fence','consent revocation suppresses prior releases and native derivatives without refunding disclosure or allocations',async()=>{
   const before=await row(),disclosuresBefore=(await e.admin.query(
    'SELECT count(*)::int n FROM finnor_os.y4_disclosures WHERE tenant_id=$1 AND computation_id=$2',[tenant,submitted.computationId])).rows[0].n;
   const revoke=()=>checked('confidential-revoke',{computationId:submitted.computationId,participantId:'p1',
    reason:'Local end-to-end revocation',idempotencyKey:randomUUID()},200,principals[1]);
   const responsibilityBefore=await ownerResponsibilitySnapshot(e.admin,tenant);
   await revoke();
   assert.deepEqual(await ownerResponsibilitySnapshot(e.admin,tenant),responsibilityBefore);
   const reading=await checked('confidential-read',{computationId:submitted.computationId});
   assert.equal(reading.current,false);assert.equal(reading.releases.length,0);
   assert.equal((await readNativeRun(consumed.id)).status,404);
   await scope(principals[0]!,async c=>{
    assert.equal((await c.query('SELECT id FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',[tenant,consumed.id])).rowCount,0);
    assert.equal((await c.query("SELECT finnor_os.y4_recipient_snapshot_scope($1,'{\"values\":{}}') allowed",[tenant])).rows[0].allowed,true);
   });
   const after=await row();assert.equal(after.cpu_reserved_seconds,before.cpu_reserved_seconds);
   assert.equal(after.session.sessionId,before.session.sessionId);
   assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.y4_disclosures WHERE tenant_id=$1 AND computation_id=$2',
    [tenant,submitted.computationId])).rows[0].n,disclosuresBefore);
   return {futureReleaseDenied:true,recipientDerivativeHidden:true,legacyNonconfidentialScopeUnchanged:true,
    disclosureReservationsRetained:disclosuresBefore,cpuAllocationNotRefunded:true,originalSessionRetained:true,
    historicalCompletionNotRewritten:true,priorKnowledgeNotUnlearned:true};
  });
  await record('native-owner-and-s8-revocation-fences',
   'revocation denies future S4/S5/S6/S8 current use while retaining original native reservations, consumption, compiled effect and review history',
   async()=>{
    assert(upstream&&ownerContinuation&&s8);
    const allocationRef=ownerContinuation.allocated.certificate.ref,obligationRef=ownerContinuation.prepared.obligation.ref,
     before=(await e.admin.query(`SELECT r.status,r.envelopes,r.revision,s.status consumption_status,
      s.effect_ref,e.status effect_status,d.status action_status FROM finnor_os.s5_reservations r
      JOIN finnor_os.s5_consumptions c USING(tenant_id,reservation_id)
      JOIN finnor_os.s5_consumption_states s USING(tenant_id,consumption_id)
      JOIN finnor_os.s6_obligation_origins o USING(tenant_id,consumption_id)
      JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
      JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id
      WHERE r.tenant_id=$1 AND r.reservation_id=$2`,[tenant,ownerContinuation.allocated.reservation.ref.id])).rows;
    const validation=await ownerCall('allocations','validate',{allocationRef});
    assert.equal(validation.status,200);assert.equal(validation.body.status,'STALE_INPUT');
    const obligation=await ownerCall('obligations','validate',{obligationRef});
    assert(obligation.status>=400||obligation.body.status!=='CURRENT');
    const guard=await api('confidential-control-choice',{policyRef:upstream.policy.ref,
     decision:{...upstream.support.decision(upstream.f,null),allocationRefs:[]},
     confidentialGuard:{binding:{computationId:submitted.computationId,releaseId:release.releaseId,output:'joint_liquidity'},
      semantics,minimum:'0',maximum:'100',qualification:'RECIPIENT_LOCAL_DERIVED_ADMISSIBILITY_NOT_S2_OBSERVATION'}});
    assert(guard.status>=400);
    const after=(await e.admin.query(`SELECT r.status,r.envelopes,r.revision,s.status consumption_status,
      s.effect_ref,e.status effect_status,d.status action_status FROM finnor_os.s5_reservations r
      JOIN finnor_os.s5_consumptions c USING(tenant_id,reservation_id)
      JOIN finnor_os.s5_consumption_states s USING(tenant_id,consumption_id)
      JOIN finnor_os.s6_obligation_origins o USING(tenant_id,consumption_id)
      JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
      JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id
      WHERE r.tenant_id=$1 AND r.reservation_id=$2`,[tenant,ownerContinuation.allocated.reservation.ref.id])).rows;
    assert.equal(before.length,1);assert.deepEqual(after,before);
    return {futureControlGuardDenied:true,allocationClearanceStale:true,obligationNotCurrent:true,
     reservationAndConsumptionRetained:true,nativeCompiledEffectUnchanged:true,dispatchGranted:false,
     s8:await s8.afterNativeInvalidation()};
   });
  if(browser)await record('mounted-revocation-fence','the actual mounted panel clears the revoked recipient output',
   ()=>browser!.afterRevocation());
  return facts();
 }finally{
  await artifact(evidence,'installed-http-metadata.json',{profile:'ACTUAL_EMITTED_ROUTE_LOCAL_AUTH_SERVICE',calls:http,
   requestAndResponseBodiesOmitted:true,hostedAuthQualified:false,separatelyAdministered:false});
  await s8?.close();await browser?.close();await worker?.close();await apiHost?.close();await auth?.close();
 }
}
