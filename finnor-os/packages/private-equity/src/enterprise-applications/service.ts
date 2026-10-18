import {z} from 'zod';
import {receiveWork} from '@finnor/db';
import {canExerciseAuthorityTx} from '@finnor/authority';
import {EvidenceRootSchema} from '@finnor/shared-types';
import {VReferenceSchema} from '../../../shared-types/src/primary-diligence';
import {authorize,unavailable} from '../owner-context';
import {affectedClosure} from '../live-recompilation/contracts';
import type {PeMutationContext} from '../types';
import {BusinessSpecificationSchema,ApplicationValueSchema,ApplicationValuesSchema,parseBusinessSpecification,validateValuesAgainstModel,applicationDigest,applicationCanonical,applicationBytesDigest,assertApplicationData,ApplicationFault,type ApplicationExecutionContext} from './contracts';
import {runApplicationProgram} from './compiler';
import {currentApplicationEnvironment,assertApplicationEnvironment} from './source-cut';
import {applicationTx,recordTx,recordSnapshot,recordSetDigest,releaseTx,workCutTx,authorityTx,approverAuthoritiesTx,actionLiterals,factsTx,valueSetsFactsTx,evidenceCurrentness,assertAllocation,eventTx,priorEventTx,recordReference,rootOf,tx,principal,fail,newId,enqueueBuildTx,type ApplicationRow,type BuildRow,type RecordRow} from './store';
const key=z.string().min(1).max(160),uuid=z.string().uuid(),id=z.object({applicationId:uuid}).strict();
const SpecificationInput={specification:BusinessSpecificationSchema.optional(),specificationUploadId:uuid.optional()};
export const ApplicationSubmitSchema=z.object({schema:z.literal('finnor.x3.application-request.v1'),root:EvidenceRootSchema,
 workId:uuid.optional(),workInputId:uuid.optional(),...SpecificationInput,idempotencyKey:key,
 limits:z.object({deadlineMs:z.number().int().min(1000).max(3600000),maxBuilds:z.number().int().min(1).max(16),maxMutations:z.number().int().min(1).max(10000)}).strict(),
 installNotBefore:z.string().datetime({offset:true}).optional()}).strict();
export const ApplicationMaintainSchema=id.extend({...SpecificationInput,idempotencyKey:key,expectedReleaseId:uuid.nullable(),
 changeClass:z.enum(['BUSINESS_RULES_UNITS','IDENTITY_AUTHORIZATION_CONCURRENCY','DEPENDENCY_SCHEMA_DEPLOYMENT']),
 migration:z.array(z.object({kind:z.literal('ADD_FIELD'),entityId:z.string().min(1).max(120),field:z.string().min(1).max(120),value:ApplicationValueSchema}).strict()).max(32),
 expectedEnvironment:z.object({sourceDigest:z.string(),lockDigest:z.string(),schemaDigest:z.string()}).strict().optional(),
 installNotBefore:z.string().datetime({offset:true}).optional()}).strict();
export const ApplicationCommandSchema=id.extend({entityId:z.string().min(1).max(120),actionId:z.string().min(1).max(120),
 recordId:uuid.optional(),expectedRevision:z.number().int().positive().optional(),expectedReference:VReferenceSchema.optional(),
 input:ApplicationValuesSchema,approvalRole:z.string().min(1).max(120).optional(),idempotencyKey:key}).strict();
export const ApplicationReadSchema=id.extend({cursor:uuid.optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const ApplicationRecordReadSchema=id.extend({recordId:uuid}).strict();
export const ApplicationHistorySchema=id.extend({recordId:uuid.optional(),before:z.string().regex(/^\d{1,19}$/).optional(),limit:z.number().int().min(1).max(100).default(20)}).strict();
export const ApplicationControlSchema=id.extend({expectedReleaseId:uuid.nullable(),idempotencyKey:key}).strict();
export const ApplicationRollbackSchema=ApplicationControlSchema.extend({releaseId:uuid}).strict();
export const ApplicationListSchema=z.object({root:EvidenceRootSchema,workId:uuid}).strict();
export const ApplicationAssetSchema=id.extend({releaseId:uuid,path:z.string().min(1).max(256)}).strict();
export const ApplicationUploadSchema=z.object({root:EvidenceRootSchema,uploadId:uuid,part:z.number().int().min(0).max(7),totalParts:z.number().int().min(1).max(8),digest:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.string().max(49152)}).strict();
export const ApplicationImpactSchema=id.extend({changed:z.array(z.enum(['business','sources','identity','schema','dependencies','checker','runtime'])).min(1).max(7)}).strict();
const parse=<S extends z.ZodTypeAny>(schema:S,value:unknown):z.output<S>=>{assertApplicationData(value,128*1024);const r=schema.safeParse(value);if(!r.success)throw new ApplicationFault('INVALID_APPLICATION_REQUEST','Request does not match the typed application contract',400);return r.data;};
async function manage(ctx:PeMutationContext,a:ApplicationRow){
 if(principal(ctx)!==a.owner_id)throw unavailable();
 assertAllocation(a);
}
async function specificationTx(ctx:PeMutationContext,c:import('pg').PoolClient,input:{specification?:unknown;specificationUploadId?:string}){
 if((input.specification===undefined)===(input.specificationUploadId===undefined))fail('EXACTLY_ONE_SPECIFICATION_REQUIRED','Supply an explicit contract or a completed upload',400);
 let value=input.specification;
 if(input.specificationUploadId){
  const rows=(await c.query<{part:number;total_parts:number;digest:string;bytes:string}>('SELECT part,total_parts,digest,bytes FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2 AND upload_id=$3 ORDER BY part',[ctx.auth.tenantId,principal(ctx),input.specificationUploadId])).rows;
  if(!rows.length||rows.length!==rows[0]!.total_parts||rows.some((r,i)=>r.part!==i||r.total_parts!==rows.length||r.digest!==rows[0]!.digest))fail('SPECIFICATION_UPLOAD_INCOMPLETE');
  const bytes=rows.map(r=>r.bytes).join('');if(Buffer.byteLength(bytes)>256*1024||applicationBytesDigest(bytes)!==rows[0]!.digest)fail('SPECIFICATION_UPLOAD_INTEGRITY');
  try{value=JSON.parse(bytes);}catch{fail('SPECIFICATION_UPLOAD_INVALID_JSON','Complete specification must be JSON',400);}
 }
 const spec=parseBusinessSpecification(value);
 if(spec.owner.id!==ctx.auth.tenantId)fail('SPECIFICATION_CANONICAL_TENANT_OWNER_REQUIRED','Specification owner must name the authenticated firm',403);
 return spec;
}
async function consumeUploadTx(ctx:PeMutationContext,c:import('pg').PoolClient,uploadId?:string){
 if(uploadId)await c.query('DELETE FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2 AND upload_id=$3',[ctx.auth.tenantId,principal(ctx),uploadId]);
}
export async function uploadApplicationSpecification(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationUploadSchema,value);
 if(Buffer.byteLength(input.bytes)>49152)fail('SPECIFICATION_FRAGMENT_BOUND','Fragment exceeds 48 KiB',413);
 return tx(ctx,async c=>{
  await authorize(ctx,input.root,[],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:synthesize_enterprise_application',resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['x3-upload:'+ctx.auth.tenantId+':'+principal(ctx)]);
  // Fragments are temporary transport, not immutable application history.
  // Whole abandoned uploads expire from their first part, without refunds to
  // any accepted application's cumulative storage or build allocation.
  await c.query(`DELETE FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2 AND upload_id IN(
   SELECT upload_id FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2
   GROUP BY upload_id HAVING min(created_at)<clock_timestamp()-interval '1 hour')`,[ctx.auth.tenantId,principal(ctx)]);
  const rows=(await c.query('SELECT * FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2',[ctx.auth.tenantId,principal(ctx)])).rows;
  const upload=rows.filter(r=>r.upload_id===input.uploadId),prior=upload.find(r=>r.part===input.part);
  if(prior&&(prior.bytes!==input.bytes||prior.digest!==input.digest||prior.total_parts!==input.totalParts))fail('APPLICATION_IDEMPOTENCY_CONFLICT');
  if(upload.some(r=>r.digest!==input.digest||r.total_parts!==input.totalParts))fail('SPECIFICATION_UPLOAD_INTEGRITY');
  if(!upload.length&&new Set(rows.map(r=>r.upload_id)).size>=8||upload.reduce((n,r)=>n+Buffer.byteLength(r.bytes),0)+(prior?0:Buffer.byteLength(input.bytes))>256*1024)fail('SPECIFICATION_UPLOAD_ALLOCATION_BOUND');
  if(!prior)await c.query('INSERT INTO finnor_os.x3_spec_fragments(tenant_id,principal_id,upload_id,part,total_parts,digest,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.auth.tenantId,principal(ctx),input.uploadId,input.part,input.totalParts,input.digest,input.bytes]);
  return {uploadId:input.uploadId,part:input.part,stored:true};
 });
}
export async function submitApplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationSubmitSchema,value),environment=await currentApplicationEnvironment(),requestDigest=applicationDigest(input);
 const replay=await tx(ctx,async c=>{
  await authorize(ctx,input.root,[],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:synthesize_enterprise_application',resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  const prior=(await c.query<ApplicationRow>('SELECT * FROM finnor_os.x3_applications WHERE tenant_id=$1 AND owner_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(!prior)return null;
  if(prior.request_digest!==requestDigest)fail('APPLICATION_IDEMPOTENCY_CONFLICT');
  await applicationTx(ctx,c,prior.id);
  await consumeUploadTx(ctx,c,input.specificationUploadId);
  return {applicationId:prior.id,workId:prior.work_id,status:prior.status,replayed:true};
 });
 if(replay)return replay;
 const spec=await tx(ctx,c=>specificationTx(ctx,c,input));
 // Canonical intake is idempotent even if the following application transaction
 // is interrupted. No planner or generated code is involved in accepting Work.
 const work=input.workId?{workId:input.workId,workInputId:input.workInputId}:await receiveWork({
  tenantId:ctx.auth.tenantId,userId:principal(ctx),channel:'console',
  instruction:`Construct ${spec.title}. Explicit business contract ${applicationDigest(spec)}. Development only; no external execution.`,
  idempotencyKey:'x3-work:'+principal(ctx)+':'+input.idempotencyKey,requireExactIntake:true,
  activeContext:{entityRefs:[input.root],applicationSpecificationDigest:applicationDigest(spec)},
  entityAttachments:[{...input.root,source:'X3:business-contract'}],
 });
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['x3-submit:'+ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
  const prior=(await c.query<ApplicationRow>('SELECT * FROM finnor_os.x3_applications WHERE tenant_id=$1 AND owner_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('APPLICATION_IDEMPOTENCY_CONFLICT');await applicationTx(ctx,c,prior.id);return {applicationId:prior.id,workId:prior.work_id,status:prior.status,replayed:true};}
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'query',capability:'query:pe_world_state',resource:{type:'work',id:work.workId},risk:'low'},c))throw unavailable();
  const current=await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:work.workId});
  if(work.workInputId&&current.id!==work.workInputId)fail('CANONICAL_WORK_INPUT_CHANGED');
  const deadline=new Date(Date.now()+input.limits.deadlineMs),notBefore=input.installNotBefore?new Date(input.installNotBefore):new Date();
  if(notBefore>deadline)fail('INSTALLATION_EXCEEDS_ORIGINAL_DEADLINE');
  const applicationId=newId(),buildId=newId();
  const a=(await c.query<ApplicationRow>("INSERT INTO finnor_os.x3_applications(tenant_id,id,owner_id,root_type,root_id,work_id,idempotency_key,request_digest,deadline_at,max_builds,max_mutations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
   [ctx.auth.tenantId,applicationId,principal(ctx),input.root.entityType,input.root.entityId,work.workId,input.idempotencyKey,requestDigest,deadline,input.limits.maxBuilds,input.limits.maxMutations])).rows[0]!;
  await authorize(ctx,input.root,[{type:'work',id:work.workId}],[],c);
  const b=(await c.query<BuildRow>("INSERT INTO finnor_os.x3_builds(tenant_id,id,application_id,generation,specification,specification_digest,change_class,work_input_id,work_input_digest,environment,install_not_before) VALUES($1,$2,$3,1,$4::jsonb,$5,'INITIAL',$6,$7,$8::jsonb,$9) RETURNING *",
   [a.tenant_id,buildId,a.id,JSON.stringify(spec),applicationDigest(spec),current.id,current.digest,JSON.stringify(environment),notBefore])).rows[0]!;
  const jobId=await enqueueBuildTx(c,a,b,'BUILD'),result={applicationId:a.id,buildId,jobId,workId:a.work_id,workInputId:current.id,status:'QUEUED',replayed:false};
  await eventTx(c,a,principal(ctx),'SUBMITTED','submit',requestDigest,result,null,b.id);
  await consumeUploadTx(ctx,c,input.specificationUploadId);
  return result;
 });
}
export async function maintainApplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationMaintainSchema,value),environment=await currentApplicationEnvironment(),digest=applicationDigest(input);
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:synthesize_enterprise_application');await manage(ctx,a);
  const prior=await priorEventTx(c,a,principal(ctx),'maintain:'+input.idempotencyKey,digest);
  if(prior){await consumeUploadTx(ctx,c,input.specificationUploadId);return {...prior.result,replayed:true};}
  if(a.head_release_id!==input.expectedReleaseId)fail('APPLICATION_RELEASE_CHANGED');
  if(['QUEUED','BUILDING','INSTALLING'].includes(a.status))fail('APPLICATION_BUILD_ALREADY_PENDING');
  if(a.release_count>=8||a.build_count>=a.max_builds)fail('ORIGINAL_APPLICATION_BUILD_BOUND');
  if(input.expectedEnvironment&&Object.entries(input.expectedEnvironment).some(([k,v])=>environment[k as keyof typeof input.expectedEnvironment]!==v))fail('APPLICATION_DEPENDENCY_OR_DEPLOYMENT_MISMATCH');
  const spec=await specificationTx(ctx,c,input),current=await workCutTx(c,a),notBefore=input.installNotBefore?new Date(input.installNotBefore):new Date();
  if(notBefore>a.deadline_at)fail('INSTALLATION_EXCEEDS_ORIGINAL_DEADLINE');
  for(const m of input.migration){
   const entity=spec.model.entities.find(e=>e.id===m.entityId),field=entity?.fields.find(f=>f.id===m.field);
   if(!field)fail('MIGRATION_TARGET_FIELD_UNAVAILABLE');
  }
  a.generation++;
  const b=(await c.query<BuildRow>('INSERT INTO finnor_os.x3_builds(tenant_id,id,application_id,generation,specification,specification_digest,base_release_id,change_class,work_input_id,work_input_digest,environment,migration,install_not_before) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13) RETURNING *',
   [a.tenant_id,newId(),a.id,a.generation,JSON.stringify(spec),applicationDigest(spec),a.head_release_id,input.changeClass,current.id,current.digest,JSON.stringify(environment),JSON.stringify(input.migration),notBefore])).rows[0]!;
  await c.query("UPDATE finnor_os.x3_applications SET generation=$3,status='QUEUED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,a.generation]);
  const jobId=await enqueueBuildTx(c,a,b,'BUILD'),result={applicationId:a.id,buildId:b.id,jobId,generation:a.generation,status:'QUEUED',replayed:false};
  await eventTx(c,a,principal(ctx),'MAINTENANCE_REQUESTED','maintain:'+input.idempotencyKey,digest,{result,changeClass:input.changeClass,specificationDigest:b.specification_digest,migration:input.migration},null,b.id);
  await consumeUploadTx(ctx,c,input.specificationUploadId);
  return result;
 });
}
export async function commandApplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationCommandSchema,value),digest=applicationDigest(input),environment=await currentApplicationEnvironment();
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:operate_enterprise_application');assertAllocation(a);
  const prior=await priorEventTx(c,a,principal(ctx),'command:'+input.idempotencyKey,digest);
  if(prior)return {...prior.result,replayed:true};
  const release=await releaseTx(c,a),action=release.specification.actions.find(x=>x.id===input.actionId&&x.entityId===input.entityId);
  assertApplicationEnvironment(release.environment,environment);
  const currentWork=await workCutTx(c,a);
  if(currentWork.id!==release.package.work.revision||currentWork.digest!==release.package.work.inputDigest)fail('APPLICATION_WORK_CHANGED');
  if(!action)fail('UNKNOWN_ACTION','Action is not in the installed application',422);
  const creating=action.kind==='create';
  if(creating&&(input.recordId||input.expectedReference||input.expectedRevision)||!creating&&(!input.recordId||!input.expectedReference||!input.expectedRevision))fail('EXACT_RECORD_PRECONDITION_REQUIRED','Record identity, content reference and concurrency revision are required',400);
  const record=creating?null:await recordTx(c,a,input.recordId!);
  if(record?.pending_effect_id)fail('CANONICAL_EFFECT_PREPARATION_PENDING');
  if(record&&record.concurrency_revision!==input.expectedRevision)fail('COMMIT_CONFLICT');
  if(creating){
   const count=(await c.query<{n:number}>('SELECT count(*)::integer n FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2',[a.tenant_id,a.id])).rows[0]!.n;
   if(count>=1000)fail('APPLICATION_RECORD_BOUND');
  }
  const actor=await authorityTx(ctx,c,a);
  const values={...record?.values,...input.input},literals=actionLiterals(release.built.program,input.actionId,input.entityId);
  const facts=await valueSetsFactsTx(ctx,c,a,[record?.values??{},values,literals]);
  const currentAuthorities=await approverAuthoritiesTx(ctx,c,a,release.specification,record?.approvals??[],actor);
  const rebasing=!!record&&action.kind==='update'&&record.release_id!==a.head_release_id;
  const context:ApplicationExecutionContext={
   entityId:input.entityId,actionId:input.actionId,installedReleaseId:a.head_release_id!,tenantId:a.tenant_id,scopeId:a.root_id,actor,
   ...(record?{record:{entityId:record.entity_id,state:record.state,values:rebasing?validateValuesAgainstModel(release.specification.model,record.entity_id,values):record.values,
    authorPrincipalId:record.author_id,recordDigest:record.content_digest,reference:recordReference(record),releaseId:rebasing?a.head_release_id!:record.release_id},
    expectedRecordDigest:input.expectedReference!.contentDigest,expectedRecordReference:input.expectedReference}:{}),
   input:input.input,...(input.approvalRole?{approvalRole:input.approvalRole}:{}),approvals:action.kind==='update'?[]:record?.approvals??[],
   currentAuthorities,currentEvidence:facts.currentEvidence,currentRelations:facts.currentRelations,
  };
  const decision=runApplicationProgram(release.built.program,context),recordId=record?.id??newId();
  let stored=record,currentness=evidenceCurrentness(record?.values??values,facts.currentEvidence);
  if(decision.allowed){
   if(!decision.values||!decision.nextState)fail('APPLICATION_DECISION_INCOMPLETE');
   const finalFacts=await factsTx(ctx,c,a,decision.values);currentness=finalFacts.currentness;
   const approvals=decision.resetApprovals?[]:decision.approval?.receipts??record?.approvals??[];
   const changed=!record||applicationCanonical(record.values)!==applicationCanonical(decision.values)||action.kind==='update';
   const revision=record?record.content_revision+(changed?1:0):1;
   const contentDigest=changed?applicationDigest({applicationId:a.id,entityId:input.entityId,recordId,revision,authorId:record?.author_id??principal(ctx),values:decision.values}):record!.content_digest;
   const prepared=decision.preparedEffectIntent??(decision.resetApprovals?null:record?.prepared_intent??null);
   if(creating){
    stored=(await c.query<RecordRow>('INSERT INTO finnor_os.x3_records(tenant_id,id,application_id,entity_id,author_id,origin_release_id,release_id,schema_release_id,state,values,content_digest,approvals,prepared_intent) VALUES($1,$2,$3,$4,$5,$6,$6,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb) RETURNING *',
     [a.tenant_id,recordId,a.id,input.entityId,principal(ctx),a.head_release_id,decision.nextState,JSON.stringify(decision.values),contentDigest,JSON.stringify(approvals),JSON.stringify(prepared)])).rows[0]!;
   }else{
    stored=(await c.query<RecordRow>('UPDATE finnor_os.x3_records SET state=$4,values=$5::jsonb,content_digest=$6,content_revision=$7,concurrency_revision=concurrency_revision+1,approvals=$8::jsonb,prepared_intent=$9::jsonb,release_id=$10,schema_release_id=$11,updated_at=clock_timestamp() WHERE tenant_id=$1 AND application_id=$2 AND id=$3 RETURNING *',
     [a.tenant_id,a.id,recordId,decision.nextState,JSON.stringify(decision.values),contentDigest,revision,JSON.stringify(approvals),JSON.stringify(prepared),rebasing?a.head_release_id:record!.release_id,a.head_release_id])).rows[0]!;
   }
  }
  const result={applicationId:a.id,decision,record:stored?projectRecord(stored,currentness,a.head_release_id):null,replayed:false};
  await eventTx(c,a,principal(ctx),decision.allowed?'BUSINESS_COMMAND':'BUSINESS_COMMAND_REFUSED','command:'+input.idempotencyKey,digest,
   {result,input,before:record?projectRecord(record,evidenceCurrentness(record.values,facts.currentEvidence),a.head_release_id):null},stored?.id??null,null,true);
  return result;
 });
}
export function projectRecord(r:RecordRow,currentness:'CURRENT'|'STALE',head:string|null){
 return {id:r.id,entityId:r.entity_id,authorPrincipalId:r.author_id,state:r.state,values:r.values,reference:recordReference(r),
  revision:r.concurrency_revision,releaseId:r.release_id,originReleaseId:r.origin_release_id,schemaReleaseId:r.schema_release_id,
  approvals:r.approvals,preparedIntent:r.prepared_intent,currentness,releaseCurrent:r.release_id===head,pendingEffectId:r.pending_effect_id};
}
export async function readApplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationReadSchema,value);
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId),release=a.head_release_id?await releaseTx(c,a):null;
  const rows=(await c.query<RecordRow>('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4',[a.tenant_id,a.id,input.cursor??null,input.limit+1])).rows;
  const page=rows.slice(0,input.limit),facts=await valueSetsFactsTx(ctx,c,a,page.map(r=>r.values));
  const records=page.map(r=>projectRecord(r,evidenceCurrentness(r.values,facts.currentEvidence),a.head_release_id));
  const builds=(await c.query('SELECT id,generation,change_class,status,attempt_count,failure,created_at FROM finnor_os.x3_builds WHERE tenant_id=$1 AND application_id=$2 ORDER BY generation DESC LIMIT 16',[a.tenant_id,a.id])).rows;
  const releases=(await c.query("SELECT id,build_id,body->'package'->'maintenance' AS maintenance FROM finnor_os.x3_releases WHERE tenant_id=$1 AND application_id=$2 ORDER BY created_at DESC,id DESC",[a.tenant_id,a.id])).rows;
  return {applicationId:a.id,status:a.status,headReleaseId:a.head_release_id,workId:a.work_id,root:rootOf(a),generation:a.generation,
   installation:{status:a.head_release_id?'INSTALLED_DEVELOPMENT':'NOT_INSTALLED',productionActive:false},
   package:release?.package??null,frontend:release?.built.frontend??null,specification:release?.specification??null,records,
   nextCursor:rows.length>input.limit?rows[input.limit-1]!.id:null,builds,releases,
   counters:{builds:a.build_count,mutations:a.mutation_count,dataBytes:Number(a.data_bytes),releases:a.release_count,deadlineAt:a.deadline_at.toISOString()},
   controls:{canManage:a.owner_id===principal(ctx)&&a.status!=='CANCELLED'&&a.deadline_at.getTime()>Date.now()},protectedAdmission:false};
 });
}
export async function readApplicationRecord(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationRecordReadSchema,value);return tx(ctx,async c=>{const a=await applicationTx(ctx,c,input.applicationId),r=await recordTx(c,a,input.recordId),f=await factsTx(ctx,c,a,r.values);return projectRecord(r,f.currentness,a.head_release_id);});
}
export async function applicationHistory(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationHistorySchema,value);return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId);if(input.recordId)await recordTx(c,a,input.recordId);
  return {events:(await c.query('SELECT id::text,record_id,build_id,actor_id,kind,body,created_at FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND ($3::uuid IS NULL OR record_id=$3) AND ($4::bigint IS NULL OR id<$4) ORDER BY id DESC LIMIT $5',[a.tenant_id,a.id,input.recordId??null,input.before??null,input.limit])).rows};
 });
}
export async function listApplications(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationListSchema,value);return tx(ctx,async c=>{
  await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'query',capability:'query:enterprise_application',resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  return {applications:(await c.query('SELECT id,status,head_release_id,generation,deadline_at FROM finnor_os.x3_applications WHERE tenant_id=$1 AND root_type=$2 AND root_id=$3 AND work_id=$4 ORDER BY created_at DESC,id DESC LIMIT 100',[ctx.auth.tenantId,input.root.entityType,input.root.entityId,input.workId])).rows};
 });
}
export async function applicationAsset(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationAssetSchema,value);return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId),r=await releaseTx(c,a,input.releaseId),asset=r.built.sources.find(s=>s.path===input.path);
  if(!asset||applicationBytesDigest(asset.bytes)!==asset.digest)throw unavailable();
  return {...asset,qualification:'INERT_DATA_ONLY_AUTHENTICATED_HOST_RENDERING'};
 });
}
export async function cancelApplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationControlSchema,value),digest=applicationDigest(input);
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:synthesize_enterprise_application');
  if(a.owner_id!==principal(ctx))throw unavailable();
  const prior=await priorEventTx(c,a,principal(ctx),'cancel:'+input.idempotencyKey,digest);if(prior)return prior;
  if(a.head_release_id!==input.expectedReleaseId)fail('APPLICATION_RELEASE_CHANGED');
  await c.query("UPDATE finnor_os.x3_applications SET status='CANCELLED',generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
  await c.query("UPDATE finnor_os.x3_builds SET status='CANCELLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND application_id=$2 AND status IN('QUEUED','BUILDING','STAGED')",[a.tenant_id,a.id]);
  const result={status:'CANCELLED',dataRetained:true,obligationsRetained:true,resourcesReplenished:false};
  await eventTx(c,a,principal(ctx),'CANCELLED','cancel:'+input.idempotencyKey,digest,result);return result;
 });
}
export async function rollbackApplication(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationRollbackSchema,value),digest=applicationDigest(input),environment=await currentApplicationEnvironment();
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:synthesize_enterprise_application');await manage(ctx,a);
  const prior=await priorEventTx(c,a,principal(ctx),'rollback:'+input.idempotencyKey,digest);if(prior)return prior;
  if(a.head_release_id!==input.expectedReleaseId)fail('APPLICATION_RELEASE_CHANGED');
  if(['QUEUED','BUILDING','INSTALLING'].includes(a.status))fail('APPLICATION_BUILD_ALREADY_PENDING');
  const target=await releaseTx(c,a,input.releaseId),reasons:string[]=[];
  if(applicationDigest(target.environment)!==applicationDigest(environment))reasons.push('APPLICATION_DEPENDENCY_OR_DEPLOYMENT_CHANGED');
  const work=await workCutTx(c,a);
  if(work.id!==target.package.work.revision||work.digest!==target.package.work.inputDigest)reasons.push('APPLICATION_WORK_CHANGED');
  if(!(await c.query("SELECT 1 FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND kind='INSTALLED_DEVELOPMENT' AND body->>'releaseId'=$3 LIMIT 1",[a.tenant_id,a.id,input.releaseId])).rowCount)reasons.push('DESTINATION_NOT_PREVIOUSLY_INSTALLED');
  const records=(await c.query<RecordRow>('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 ORDER BY id FOR UPDATE',[a.tenant_id,a.id])).rows;
  for(const r of records){
   try{validateValuesAgainstModel(target.specification.model,r.entity_id,r.values);if(!target.specification.model.entities.find(e=>e.id===r.entity_id)?.states.includes(r.state))reasons.push('INCOMPATIBLE_REAL_RECORD_STATE:'+r.id);}
   catch{reasons.push('INCOMPATIBLE_REAL_RECORD_SCHEMA:'+r.id);}
   if(r.pending_effect_id)reasons.push('UNRESOLVED_CANONICAL_EFFECT:'+r.id);
  }
  if((await c.query("SELECT 1 FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND kind='S6_BOUND' LIMIT 1",[a.tenant_id,a.id])).rowCount)reasons.push('CANONICAL_OBLIGATION_HISTORY_REQUIRES_FORWARD_REPAIR');
  if(reasons.length){
   const result={status:'ROLLBACK_BLOCKED',reasons,forwardRepairAllowed:true,dataRetained:true};
   await eventTx(c,a,principal(ctx),'ROLLBACK_REFUSED','rollback:'+input.idempotencyKey,digest,result);return result;
  }
  await c.query("UPDATE finnor_os.x3_applications SET head_release_id=$3,generation=generation+1,status='INSTALLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,input.releaseId]);
  const result={status:'ROLLED_BACK_DEVELOPMENT',releaseId:input.releaseId,dataDigest:recordSetDigest(records.map(recordSnapshot)),dataRetained:true,externalEffectsUndone:false};
  await eventTx(c,a,principal(ctx),'ROLLED_BACK','rollback:'+input.idempotencyKey,digest,result);return result;
 });
}
export async function applicationImpact(ctx:PeMutationContext,value:unknown){
 const input=parse(ApplicationImpactSchema,value);
 return tx(ctx,async c=>{
  await applicationTx(ctx,c,input.applicationId);
  const graph=[...['business','sources','identity','schema','dependencies','checker','runtime'].map(id=>({id,dependsOn:[] as string[]})),
   {id:'program',dependsOn:['business','schema','dependencies','checker','runtime']},{id:'forms',dependsOn:['business','schema','runtime']},
   {id:'decisions',dependsOn:['program','sources','identity']},{id:'installation',dependsOn:['program','forms','decisions']},
   {id:'s8-admission',dependsOn:['installation','checker','runtime','identity']},{id:'prepared-actions',dependsOn:['decisions','installation']}];
  return {...affectedClosure(graph,input.changed),authorityGranted:false,reuseRequiresCurrentOwnerPredicates:true};
 });
}
