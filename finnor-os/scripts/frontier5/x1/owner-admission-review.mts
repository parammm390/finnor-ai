/** Frozen native-review owner challenges. Real restricted publisher, authenticated
 * Source Truth owner and disposable SQL; expected guards precede the repairs. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {reconstructAndAdmitInstitutionSources} from '../../../packages/private-equity/src/institution-program/owner-admission';
import {loadInstitutionProfile} from '../../../packages/private-equity/src/institution-program/store';
import type {PeMutationContext} from '../../../packages/private-equity/src/types';
import {admissionMailFixture} from './admission-mail-fixture.mts';
import {withTenantTransaction} from '@finnor/db';
import {persistProviderObservationTx,sourceTruthHash} from '@finnor/data-platform';
export class OwnerAdmissionReviewFinished extends Error {}
export async function reviewOwnerAdmission(input:{ctx:PeMutationContext;admin:pg.Client;adminUrl:string;
  origin:string;token:string;workId:string;institutionId:string;registrationA:string;occurredAt:string;grantIds:string[];firstDealId:string;secondDealId:string;
  save:(name:string,value:unknown)=>Promise<unknown>;results:any[]}){
 const {ctx,admin,workId,save,results}=input,tenant=ctx.auth.tenantId;
 const profile=loadInstitutionProfile(),ids=[...input.grantIds];
 const mail=await admissionMailFixture(input);ids.push(mail.grantId);
 try{
 const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const observe=async()=>({
  admissions:(await admin.query('SELECT id,original_digest,candidate_digest,checker_digest,duty_population_digest,receipts FROM finnor_os.x1_mapping_admissions WHERE tenant_id=$1 AND work_id=$2 ORDER BY id',[tenant,workId])).rows,
  links:(await admin.query('SELECT id,entity_type,entity_id,evidence_source_id,evidence_version_id,archived_at FROM finnor_os.pe_evidence_links WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
  truth:(await admin.query('SELECT id,entity,internal_id,mapping_status,candidate_canonical_ids,tombstoned_at FROM finnor_os.external_refs WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
 });
 const run=()=>reconstructAndAdmitInstitutionSources(ctx,workId,ids,profile);
 const report=(id:string,expected:unknown,observed:unknown,passed:boolean)=>results.push({id,status:passed?'PASS':'FAIL',expected,observed,
  basis:'ACTUAL_RESTRICTED_ORIGINAL_SOURCE_PUBLISHER_AUTHENTICATED_OWNER_SQL_READBACK_NO_PROTECTED_AUTHORITY'});
 // The actual owner locks Work while publishing. A competing new version
 // must serialize behind that lock; retain physical lock and commit evidence.
 const before=await observe(),blocker=new pg.Client({connectionString:input.adminUrl}),writer=new pg.Client({connectionString:input.adminUrl});
 await blocker.connect();await writer.connect();
 let publishing:Promise<any>|null=null,writing:Promise<any>|null=null,barrier:any,writerBarrier:any;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,input.firstDealId]);
  const blockerPid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  publishing=run().then(value=>({value,error:null})).catch(error=>({value:null,error:{message:String(error.message),code:error.code??null}}));
  for(let poll=0;poll<100;poll++){
   const waiting=(await admin.query(`SELECT pid,query,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity
    WHERE datname=current_database() AND usename='finnor_app' AND state='active' AND $1=ANY(pg_blocking_pids(pid))`,[blockerPid])).rows;
   barrier=waiting.find(row=>/pe_deals/.test(row.query)&&/FOR UPDATE/.test(row.query));if(barrier)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(barrier,'Actual admission must reach the canonical row publication barrier');
  const originalGrant=(await admin.query(`SELECT * FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND work_id=$2 AND source_id='crm-original' AND id=ANY($3::uuid[])`,[tenant,workId,ids])).rows[0];assert.ok(originalGrant);
  const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  writing=writer.query(`INSERT INTO finnor_os.x1_source_grants SELECT (jsonb_populate_record(NULL::finnor_os.x1_source_grants,
   $1::jsonb||jsonb_build_object('id',$2::text,'version',$3::int,'created_at',clock_timestamp()))).* RETURNING *`,
   [JSON.stringify(originalGrant),randomUUID(),originalGrant.version+1]);
  for(let poll=0;poll<100;poll++){
   writerBarrier=(await admin.query('SELECT pid,query,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1 AND $2=ANY(pg_blocking_pids(pid))',[writerPid,barrier.pid])).rows[0];
   if(writerBarrier)break;await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(writerBarrier,'The competing grant FK must physically wait for the publisher Work lock');
  await blocker.query('ROLLBACK');
  const outcome=await publishing,replacement=(await writing).rows[0];
  const commits=(await admin.query(`SELECT 'admission' kind,id::text,pg_xact_commit_timestamp(xmin) committed_at FROM finnor_os.x1_mapping_admissions WHERE tenant_id=$1 AND work_id=$2
   UNION ALL SELECT 'new_grant',id::text,pg_xact_commit_timestamp(xmin) FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND id=$3`,[tenant,workId,replacement.id])).rows;
  let stale:any;try{stale={value:await run(),error:null};}catch(error){stale={value:null,error:String((error as Error).message)};}
  const after=await observe();
  await save('admission-concurrent-grant-publication-serialization.json',{before,barrier,writerBarrier,replacement,outcome,commits,stale,after,
   originalExactPublicationGuardObserved:false,originalFailedAttemptRetained:'native-review-owner-admission-pre-repair-002',
   expected:'Old publication commits before competing new grant; old grant acquisition then refuses',externalFixtureInputVersionOnly:true});
  const admissionCommit=commits.find(row=>row.kind==='admission'),grantCommit=commits.find(row=>row.kind==='new_grant');
  assert.ok(admissionCommit?.committed_at&&grantCommit?.committed_at);
  const passed=outcome.value?.check.disposition==='ACCEPTED_DEVELOPMENT'&&after.admissions.length===before.admissions.length+1
   &&new Date(admissionCommit.committed_at).valueOf()<=new Date(grantCommit.committed_at).valueOf()
   &&stale.value?.check.disposition==='REJECTED'&&stale.value?.check.guard==='SOURCE_AUTHORITY'
   &&stale.value.mappings.length===0&&stale.value.original.sources.some((source:any)=>
     source.id==='crm-original'&&source.ownerCoverageGap?.reason==='SOURCE_GRANT_SUPERSEDED');
  report('C-owner-concurrent-grant-publication-serialization','No stale admission after a committed newer source head',{outcome,commits,stale},passed);
  ids[ids.indexOf(originalGrant.id)]=replacement.id;
 }finally{await blocker.query('ROLLBACK').catch(()=>{});await blocker.end();await publishing;await writing;await writer.end();}
 // Freeze a real stable admission. No candidate/check or accepted mapping is
 // supplied by the fixture: every iteration executes the separate checker.
 const steady:any[]=[];let accepted:any,stable=false;
 for(let attempt=0;attempt<4;attempt++){
  accepted=await run();assert.equal(accepted.check.disposition,'ACCEPTED_DEVELOPMENT',JSON.stringify(accepted.check));
  const snapshot=await observe();steady.push({check:accepted.check,mappings:accepted.mappings,original:accepted.original,candidate:accepted.candidate,snapshot});
  if(attempt>0&&digest(steady.at(-1).snapshot)===digest(steady.at(-2).snapshot)
    &&accepted.check.inputDigest===steady.at(-2).check.inputDigest&&accepted.check.candidateDigest===steady.at(-2).check.candidateDigest){stable=true;break;}
 }
 await save('admission-intact-replay-control.json',{steady,stable,expectedIdentityMappings:3,expectedQuantityAssertions:1,
  sourceBindingsSuppliedByOwner:true,candidateOrMappingsSuppliedByCaller:false});
 assert.ok(stable,'Actual exact admission replay must stabilize without a new receipt or entity revision');
 assert.equal(accepted.mappings.filter((m:any)=>m.assertionKind!=='QUANTITY').length,3);
 assert.equal(accepted.mappings.filter((m:any)=>m.assertionKind==='QUANTITY').length,1);
 report('C-owner-mapped-intact-admission-replay','Identical original/candidate/receipt readback with no new row',steady,true);
 const intact=await observe(),stored=intact.admissions.find(row=>row.original_digest===accepted.check.inputDigest&&row.candidate_digest===accepted.check.candidateDigest);
 assert.ok(stored);
 const corruptDigest=async(value:string)=>{
  await admin.query('BEGIN');
  try{await admin.query("SET LOCAL session_replication_role='replica'");
   await admin.query('UPDATE finnor_os.x1_mapping_admissions SET checker_digest=$3 WHERE tenant_id=$1 AND id=$2',[tenant,stored.id,value]);
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
 };
 let digestReplay:any;
 try{
  await corruptDigest('0'.repeat(64));const beforeDigest=await observe();
  try{digestReplay={value:await run(),error:null};}catch(error){digestReplay={value:null,error:String((error as Error).message)};}
  const afterDigest=await observe();
  await save('admission-stored-digest-corruption-replay.json',{stored,beforeDigest,digestReplay,afterDigest,
   fault:'DISPOSABLE_ADMIN_TRANSACTION_LOCAL_CORRUPTION_OF_ORDINARY_STORED_CHECKER_DIGEST',
   originalSourcesCheckerAndTrustPolicyUnchanged:true,expected:'X1_ADMISSION_REPLAY_DIGEST_MISMATCH'});
  report('C-owner-changed-digest-admission-replay','X1_ADMISSION_REPLAY_DIGEST_MISMATCH',digestReplay,
   digestReplay.error==='X1_ADMISSION_REPLAY_DIGEST_MISMATCH'&&digest(beforeDigest)===digest(afterDigest));
 }finally{await corruptDigest(stored.checker_digest);}
 assert.equal(digest(await observe()),digest(intact),'Exact original owner rows restored after the recorded corruption fault');
 const receipt=accepted.mappings.find((m:any)=>m.sourceId==='mail-original'&&m.recordId==='mail-A');assert.ok(receipt?.sourceTruthLinkId,'Actual mapped Source Truth link required');
 const truth=async()=>(await admin.query('SELECT * FROM finnor_os.external_refs WHERE tenant_id=$1 AND id=$2',[tenant,receipt.sourceTruthLinkId])).rows[0];
 const initial=await truth();assert.equal(initial.mapping_status,'mapped');assert.equal(initial.internal_id,input.firstDealId);
 const api=async(body:unknown)=>{
  const response=await fetch(input.origin+'/api/private-equity/digital-twin',{method:'POST',headers:{authorization:'Bearer '+input.token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  return {status:response.status,body:await response.json()};
 };
 const oldRef={entityType:'pe_deal',entityId:input.firstDealId},otherRef={entityType:'pe_deal',entityId:input.secondDealId};
 const resolve=async(kind:'split'|'correction',toRefs:typeof oldRef[])=>api({operation:'record-identity-resolution',decisionId:'x1-native-review:'+randomUUID(),sourceLinkId:receipt.sourceTruthLinkId,
  expectedObservedHash:(await truth()).observed_hash,kind,fromRefs:[oldRef],toRefs,
  decision:kind==='split'?'Original source identity now has two unresolved owner candidates':'Restore the original exact mapped owner for the intact replay control',
  authority:{basis:'CURRENT_AUTHENTICATED_DISPOSABLE_SOURCE_IDENTITY_OWNER',protectedAdmission:false},
  evidence:{evidenceSourceId:receipt.evidenceSourceId,evidenceVersionId:receipt.evidenceVersionId}});
 const split=await resolve('split',[oldRef,otherRef]);assert.equal(split.status,201,JSON.stringify(split));
 const ambiguous=await truth();assert.equal(ambiguous.mapping_status,'ambiguous');assert.equal(ambiguous.internal_id,null);
 assert.ok(ambiguous.candidate_canonical_ids.includes(input.firstDealId));
 const beforeReplay=await observe();let replay:any;
 try{replay={value:await run(),error:null};}catch(error){replay={value:null,error:String((error as Error).message)};}
 const afterReplay=await observe();
 await save('admission-ambiguous-source-truth-replay.json',{initial,split,ambiguous,beforeReplay,replay,afterReplay,
  expectedPredicate:'X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED',sourceBytesAndCanonicalRowsNotChanged:true});
 report('C-owner-ambiguous-source-truth-replay','X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED',replay,
  replay.error==='X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED'&&digest(beforeReplay)===digest(afterReplay));
 const restored=await resolve('correction',[oldRef]);assert.equal(restored.status,201,JSON.stringify(restored));
 const final=await run();assert.equal(final.check.disposition,'ACCEPTED_DEVELOPMENT');
 await save('admission-restored-source-truth-control.json',{restored,final,ending:await truth(),allPriorObservationsRetained:true});
 report('C-owner-source-truth-restored-control','Mapped exact internal_id resumes idempotent readback',{restored,check:final.check},true);
 const remapped=await resolve('correction',[otherRef]);assert.equal(remapped.status,201,JSON.stringify(remapped));
 const beforeRemap=await observe();let remapReplay:any;
 try{remapReplay={value:await run(),error:null};}catch(error){remapReplay={value:null,error:String((error as Error).message)};}
 const afterRemap=await observe();
 await save('admission-remapped-source-truth-replay.json',{remapped,beforeRemap,remapReplay,afterRemap,
  expectedPredicate:'X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED',actualAuthenticatedOwnerMutation:true});
 report('C-owner-remapped-source-truth-replay','X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED',remapReplay,
  remapReplay.error==='X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED'&&digest(beforeRemap)===digest(afterRemap));
 const finalRestore=await resolve('correction',[oldRef]);assert.equal(finalRestore.status,201,JSON.stringify(finalRestore));
 const live=await truth();
 const scope=(await admin.query('SELECT id FROM finnor_os.integration_source_scopes WHERE tenant_id=$1 AND integration_id=$2 AND scope_key=$3',
  [tenant,live.integration_id,mail.sourceScope])).rows[0];assert.ok(scope);
 const deletionAt=new Date().toISOString(),payload={externalObjectId:live.external_id,deleted:true};
 const deleted=await withTenantTransaction(tenant,{userId:ctx.auth.userId},db=>persistProviderObservationTx(db,{
  observation:{tenantId:tenant,integrationId:live.integration_id,provider:'microsoft_graph',sourceScopeId:scope.id,
   resourceKind:'outlook_mail',externalObjectType:live.external_object_type,externalObjectId:live.external_id,
   providerParentRefs:[],providerVersion:'r2-deleted',observedAt:deletionAt,retrievedAt:deletionAt,deleted:true,
   payload,payloadHash:sourceTruthHash(payload),providerMetadata:{originalBytesNotAltered:true},ingestionMode:'incremental',
   traceId:'authorized-disposable-provider-deletion:'+randomUUID()},
  evidenceSourceId:receipt.evidenceSourceId,evidenceVersionId:receipt.evidenceVersionId,
  canonicalTarget:{entityType:'pe_deal',entityId:input.firstDealId},rootMappingStatus:'mapped',
 }));
 const tombstone=await truth();assert.equal(tombstone.mapping_status,'tombstoned');assert.ok(tombstone.tombstoned_at);
 const beforeTombstone=await observe();let tombstoneReplay:any;
 try{tombstoneReplay={value:await run(),error:null};}catch(error){tombstoneReplay={value:null,error:String((error as Error).message)};}
 const afterTombstone=await observe();
 await save('admission-tombstoned-source-truth-replay.json',{live,deleted,tombstone,beforeTombstone,tombstoneReplay,afterTombstone,
  actualCanonicalSourceOwner:true,rawSqlTombstoneWrite:false,expected:'X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED'});
 report('C-owner-tombstoned-source-truth-replay','X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED',tombstoneReplay,
  tombstoneReplay.error==='X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED'&&digest(beforeTombstone)===digest(afterTombstone));
 throw new OwnerAdmissionReviewFinished('Only the frozen owner-admission review predicates were selected; native execution/lifecycle not part of this episode');
 }finally{await mail.close();}
}
