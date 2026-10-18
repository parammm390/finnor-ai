/** Independent installed-package expectations frozen in completion-plan.md.
 * Reads actual SQL and HTTP output, never the candidate's projection helpers. */
import {strict as assert} from 'node:assert';
import type {startEnvironment} from './environment.mts';
import {hash,artifact} from './environment.mts';

const required=`artifact_id kind schema_revision content_digest tenant_ref work_ref institutional_program_ref
parent_artifact_refs producer_revision baseline_manifest_ref authority_grant_ref rights_revision resource_grant_ref
source_refs source_revision_vector knowledge_cut admitted_domain_ref application_fingerprints model_refs
dependency_lock_digest runtime_digest observed_claims inferred_claims predicted_claims unresolved_claims
postcondition_contract_refs independent_check_refs S6_obligation_refs provider_observation_refs
invalidation_dependencies lifecycle_state lifecycle_events build_learning_compute_cost_refs attributable_human_work_refs`.split(/\s+/);
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:unknown)=>hash(canonical(value));
export async function checkInstalledEnvelope(e:Awaited<ReturnType<typeof startEnvironment>>,view:any,tenant:string,evidence:string){
 const p=view.package,envelope=p.envelope;
 assert(envelope,'The actual application-read response must deliver the full common envelope');
 assert(required.every(key=>Object.hasOwn(envelope,key)));
 const row=(await e.admin.query('SELECT body,body_digest FROM finnor_os.x3_releases WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[tenant,view.applicationId,view.headReleaseId])).rows[0];
 const allocation=(await e.admin.query('SELECT tenant_id,id,request_digest,deadline_at,max_builds,max_mutations FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2',[tenant,view.applicationId])).rows[0];
 assert(!Object.hasOwn(row.body.package,'envelope'),'Current metadata must not rewrite the immutable package');
 assert.equal(envelope.content_digest,digest(row.body));assert.equal(envelope.content_digest,row.body_digest);
 assert.equal(envelope.content_digest_basis,'IMMUTABLE_X3_RELEASE_BODY_V1');
 assert.equal(envelope.artifact_id,view.headReleaseId);assert.equal(envelope.kind,'EnterpriseApplicationPackage');
 assert.deepEqual(envelope.tenant_ref,{owner:'@finnor/db',table:'tenants',id:tenant});
 assert.equal(envelope.principal_ref.id,row.body.package.principalId);assert.equal(envelope.principal_ref.tenantId,tenant);
 assert.deepEqual(envelope.work_ref,{owner:'WORK',id:view.workId,revision:row.body.package.work.revision,contentDigest:row.body.package.work.inputDigest});
 assert.equal(envelope.producer_revision.contentDigest,row.body.environment.sourceDigest);
 assert.equal(envelope.baseline_manifest_kind,'B_live');assert.equal(envelope.baseline_manifest_ref.contentDigest,digest(row.body.environment));
 assert.equal(envelope.runtime_digest,digest(row.body.environment));assert.equal(envelope.dependency_lock_digest,row.body.environment.lockDigest);
 assert.equal(envelope.rights_revision,String(row.body.package.rights.revision));
 assert.deepEqual(envelope.resource_grant_ref,{owner:'X3_ALLOCATION',id:view.applicationId,revision:'ORIGINAL_APPLICATION_ALLOCATION_V1',contentDigest:digest({
  tenantId:allocation.tenant_id,applicationId:allocation.id,requestDigest:allocation.request_digest,deadlineAt:allocation.deadline_at.toISOString(),maxBuilds:allocation.max_builds,maxMutations:allocation.max_mutations,
 })});
 for(const source of row.body.environment.files){
  const ref=envelope.source_refs.find((r:any)=>r.owner==='SOURCE'&&r.id===source.path);
  assert(ref);assert.equal(ref.revision,source.sha256);assert.equal(ref.contentDigest,source.sha256);
  assert.equal(envelope.source_revision_vector['SOURCE:'+source.path],source.sha256);
  assert(envelope.invalidation_dependencies.refs.some((r:any)=>r.owner==='SOURCE'&&r.id===source.path&&r.contentDigest===source.sha256));
 }
 assert.equal(envelope.source_refs.length,row.body.environment.files.length+2);
 assert.deepEqual(envelope.knowledge_cut.specification,row.body.package.specification);
 assert.equal(envelope.knowledge_cut.meaning,'PINNED_CONSTRUCTION_INPUTS_NOT_BUSINESS_TRUTH');
 assert.equal(envelope.application_fingerprints.releaseId,view.headReleaseId);
 assert.equal(envelope.application_fingerprints.applicationId,view.applicationId);
 assert.equal(envelope.independent_check_refs[0].contentDigest,digest(row.body.check));
 assert.equal(row.body.check.status,'PASS');
 assert.equal(envelope.postcondition_contract_refs.length,row.body.specification.acceptanceCases.length);
 for(const [i,test] of row.body.specification.acceptanceCases.entries()){
  assert.equal(envelope.postcondition_contract_refs[i].contentDigest,digest(test));
  assert.equal(envelope.postcondition_contract_refs[i].revision,String(row.body.package.maintenance.generation)+':'+test.id);
 }
 for(const field of ['institutional_program_ref','authority_grant_ref','admitted_domain_ref','provider_observation_refs','attributable_human_work_refs']){
  assert.equal(envelope[field].kind,'UNKNOWN');assert(envelope[field].reason.length>0);
 }
 for(const field of ['aggregateMemory','money'])assert.equal(envelope.build_learning_compute_cost_refs[field].kind,'UNKNOWN');
 assert(envelope.unresolved_claims.every((claim:any)=>claim.critical===false&&claim.value.kind==='UNKNOWN'&&claim.value.reason));
 assert.deepEqual(envelope.model_refs,[]);assert.equal(envelope.model_use,'NONE_TYPED_COMPILER');
 assert.deepEqual(envelope.inferred_claims,[]);assert.deepEqual(envelope.predicted_claims,[]);
 assert.equal(envelope.lifecycle_state.applicationStatus,view.status);assert.equal(envelope.lifecycle_state.releaseState,'INSTALLED_DEVELOPMENT');
 assert.equal(envelope.lifecycle_state.immutableBuildState,'STAGED');assert.equal(envelope.lifecycle_state.productionActive,false);
 const through=envelope.lifecycle_events.snapshotThroughEventId;
 const events=(await e.admin.query('SELECT id::text,kind,body FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND id<=$3::bigint ORDER BY id',[tenant,view.applicationId,through])).rows;
 assert(events.some(event=>event.kind==='INSTALLED_DEVELOPMENT'&&event.body.releaseId===view.headReleaseId));
 for(const ref of [envelope.lifecycle_events,envelope.resource_lease_refs,envelope.S6_obligation_refs,envelope.build_learning_compute_cost_refs.events,...envelope.observed_claims.map((claim:any)=>claim.basis).filter((basis:any)=>basis.table==='x3_events')]){
  assert.equal(ref.owner,'@finnor/db');assert.equal(ref.table,'x3_events');assert.equal(ref.tenantId,tenant);assert.equal(ref.applicationId,view.applicationId);
  assert.equal(ref.snapshotThroughEventId,through);assert.equal(ref.count,String(events.filter(event=>!ref.eventKinds.length||ref.eventKinds.includes(event.kind)).length));
  assert.deepEqual(ref.read,{operation:'application-history',applicationId:view.applicationId,before:(BigInt(through)+1n).toString(),limit:100});
 }
 assert.equal(envelope.S6_obligation_refs.referenceField,'body.obligationRef');
 const obligations=events.filter(event=>event.kind==='S6_BOUND').map(event=>event.body.obligationRef);
 assert(obligations.every(ref=>ref&&ref.id&&ref.contentDigest),'An obligation collection must resolve real owner references');
 for(const source of row.body.built.sources){
  assert.equal(hash(source.bytes),source.digest);
  assert(p.sourceFiles.some((file:any)=>file.path===source.path&&file.digest===source.digest));
 }
 assert.equal(p.sourceFiles.length,row.body.built.sources.length);
 const records=(await e.admin.query('SELECT id,entity_id,author_id,origin_release_id,release_id,schema_release_id,state,values,content_digest,content_revision,concurrency_revision,approvals,prepared_intent,pending_effect_id FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 ORDER BY id',[tenant,view.applicationId])).rows;
 const retained='release-snapshots/'+p.id+'/'+through+'.json';
 await artifact(evidence,retained,{schema:'finnor.x3.installed-release-export.v1',tenantId:tenant,applicationId:view.applicationId,
  releaseId:p.id,contentDigest:row.body_digest,releaseBody:row.body,envelope,records,lifecycleEvents:events,
  custody:'DISPOSABLE_DEVELOPMENT_NOT_PROTECTED',restorationAuthorityGranted:false});
 return {applicationId:view.applicationId,releaseId:view.headReleaseId,contentDigest:row.body_digest,requiredFields:required.length,
  sourcePins:row.body.environment.files.length,lifecycleEvents:String(events.length),obligationRefs:obligations,immutableReleaseUnchanged:true,unknownsDisclosed:true,retained};
}
