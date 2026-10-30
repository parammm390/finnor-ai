import {z} from 'zod';
import {receiveWork,attachWorkEntityTx} from '@finnor/db';
import {PrimaryIntakeSchema,PrimaryAdvanceSchema,PrimaryGovernanceSchema,VReferenceSchema,EvidenceRootSchema} from '@finnor/shared-types';
import {loadEnterpriseBeliefView} from '../enterprise-beliefs';
import {PeDomainError,type PeMutationContext,type PeWorldRootRef} from '../types';
import {actor,authorize,canonical,costReceipts,currentActor,currentFinding,event,exactWork,hash,newId,programme,putGovernance,reference,revisions,revokeGovernance,rightsBinding,tx,unavailable,type Programme} from './store';
import {ownerBindings} from './governance';
import {PrimaryConsumeSchema,consumePrimaryUnderwriting} from './consumer';
import {selectPrimaryPlan} from './plan';
import {reserveFixedPrimaryBudget} from '../allocation-store';
import {resolveBilateralPredecessor} from '../bilateral-opportunities/handoff';

export const PRIMARY_OPERATIONS=['primary-context','primary-open-work','primary-reserve-budget','primary-governance-put','primary-governance-revoke','primary-submit','primary-read','primary-advance','primary-cancel','primary-consume','primary-plan'] as const;
const rooted=z.object({root:EvidenceRootSchema}).strict(),identified=z.object({programmeId:z.string().uuid()}).strict();
export const PrimaryOperationSchemas={
 'primary-context':rooted,'primary-open-work':rooted.extend({instruction:z.string().min(1).max(2000),idempotencyKey:z.string().min(1).max(200),investigation:z.object({threadId:z.string().uuid(),expectedRevision:z.number().int().nonnegative()}).strict().optional()}).strict(),
 'primary-reserve-budget':rooted.extend({resourceRefs:z.array(VReferenceSchema).length(2),maximumMicroUsd:z.string().regex(/^[1-9]\d{0,95}$/),maximumCpuMicros:z.string().regex(/^[1-9]\d{0,95}$/),idempotencyKey:z.string().min(1).max(200),validUntil:z.string().datetime({offset:true})}).strict(),
 'primary-governance-put':z.object({root:EvidenceRootSchema,body:PrimaryGovernanceSchema,expectedRef:VReferenceSchema.nullable()}).strict(),
 'primary-governance-revoke':rooted.extend({ref:VReferenceSchema,reason:z.string().min(1).max(1000)}).strict(),
 'primary-submit':PrimaryIntakeSchema,'primary-read':identified,'primary-advance':PrimaryAdvanceSchema,'primary-cancel':identified,
 'primary-consume':PrimaryConsumeSchema,'primary-plan':PrimaryIntakeSchema,
} as const;
export const programmeRef=(p:Programme)=>reference('V2',p.id,p.revision,{intakeDigest:p.intake_digest,startingEvidenceDigest:p.starting_digest});
async function enqueue(ctx:PeMutationContext,p:Programme,c:import('pg').PoolClient){
 await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety)
 VALUES($1,'advance_primary_diligence_v1',$2::jsonb,$3,'interactive',0,1,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING`,
 [ctx.auth.tenantId,canonical({tenantId:ctx.auth.tenantId,principalId:actor(ctx),programmeId:p.id,revision:p.revision}),'v2:'+p.id+':'+p.revision]);
}
export async function submitPrimary(ctx:PeMutationContext,value:unknown){
 const intake=PrimaryIntakeSchema.parse(value);await authorize(ctx,intake.root as PeWorldRootRef,intake.workId);
 if(intake.mode!=='ordinary_disposable'||process.env.NODE_ENV==='production'||process.env.FINNOR_V2_PROFILE!=='ordinary_disposable')throw Error('LIVE_PRIMARY_SOURCE_AUTHORITY_AND_S8_ADMISSION_UNAVAILABLE');
 await resolveBilateralPredecessor(ctx,intake);
 if(new Set(intake.assertions.map(a=>a.assertionId)).size!==intake.assertions.length)throw Error('DUPLICATE_FROZEN_ASSERTION_ID');
 const digest=hash(intake);
 const prior=await tx(ctx,async c=>(await c.query<Programme>('SELECT * FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),intake.idempotencyKey])).rows[0],true);
 if(prior){if(prior.intake_digest!==digest)throw Error('PRIMARY_IDEMPOTENCY_CONFLICT');return {programmeId:prior.id,workId:prior.work_id,ref:programmeRef(prior),status:prior.status,replayed:true};}
 const view=await loadEnterpriseBeliefView(ctx,{root:intake.root as PeWorldRootRef,maxClaims:1000});
 for(const a of intake.assertions)if(a.startingSupportRefs.some(r=>!intake.startingEvidenceRefs.some(s=>hash(r)===hash(s))))throw Error('STARTING_SUPPORT_NOT_IN_REGISTERED_MANIFEST');
 return tx(ctx,async (c,db)=>{
  await currentActor(ctx,c);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72))',[ctx.auth.tenantId+':'+actor(ctx)+':'+intake.idempotencyKey]);
  const existing=(await c.query<Programme>('SELECT * FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),intake.idempotencyKey])).rows[0];
  if(existing){if(existing.intake_digest!==digest)throw Error('PRIMARY_IDEMPOTENCY_CONFLICT');return {programmeId:existing.id,workId:existing.work_id,ref:programmeRef(existing),status:existing.status,replayed:true};}
  const work=(await c.query("SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[ctx.auth.tenantId,intake.workId])).rows[0];
  if(!work||work.id!==intake.expectedWorkInputId)throw Error('EXPECTED_CURRENT_WORK_INPUT_REQUIRED');
  const predecessor=await resolveBilateralPredecessor(ctx,intake,c);
  const target=(await c.query("SELECT target_organization_id::text target FROM finnor_os.pe_opportunities WHERE tenant_id=$1 AND id=$2 UNION ALL SELECT target_organization_id::text target FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2",[ctx.auth.tenantId,intake.root.entityId])).rows[0]?.target??(intake.root.entityType==='external_organization'?intake.root.entityId:null);
  if(!target||!intake.assertions.every(a=>a.semantics.legalEntityId===target))throw Error('PRIMARY_CANONICAL_INVESTMENT_TARGET_MISMATCH');
  const cut=(await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString(),evidence:unknown[]=[];
  for(const ref of intake.startingEvidenceRefs){
   if(ref.owner!=='S1')throw Error('STARTING_EVIDENCE_OWNER_UNSUPPORTED');
   const row=(await c.query('SELECT id::text,source_id::text,version_number,content_hash,content,snapshot,created_at FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2 AND created_at<=$3',[ctx.auth.tenantId,ref.id,cut])).rows[0];
   if(!row||row.content_hash!==ref.contentDigest||String(row.version_number)!==ref.revision)throw Error('STARTING_EVIDENCE_EXACT_REVISION_UNAVAILABLE');
   evidence.push(row);
  }
  const keys=['rights:tenant','work-inputs:'+intake.workId,'canonical:'+intake.root.entityType+':'+intake.root.entityId,'canonical:external_organization:'+target,
   ...[...intake.sourceProfileRefs,...intake.consentRefs,...intake.referenceSemanticsRefs,intake.mandateRef,intake.authorityProfileRef,intake.budgetGrantRef].map(r=>'primary-governance:'+r.id),
   ...evidence.map(e=>'evidence:'+(e as {source_id:string}).source_id)];
  if(predecessor)keys.push(predecessor.dependencyKey);
  const grant=await (await import('./store')).governance<import('@finnor/shared-types').PrimaryGrant>(ctx,intake.budgetGrantRef,'finnor.primary-grant.v1',c);
  const original=(await c.query('SELECT p.problem FROM finnor_os.s5_proposals p JOIN finnor_os.s5_reservations s ON s.tenant_id=p.tenant_id AND s.allocation_digest=p.content_digest WHERE s.tenant_id=$1 AND s.reservation_id=$2',[ctx.auth.tenantId,grant.reservationRef.id])).rows[0];
  if(!original)throw Error('PRIMARY_ORIGINAL_S5_RESERVATION_UNAVAILABLE');
  keys.push(...original.problem.resources.map((r:{resourceId:string})=>'s5-resource:'+r.resourceId),'primary-reservation-authority:'+grant.reservationRef.id);
  const dependencies=await revisions(ctx,keys,c,true),manifest={knowledgeCut:cut,refs:intake.startingEvidenceRefs,evidence,canonicalBeliefPin:view.pin,legitimatelyKnownClaims:view.claims,dependencies,
   ...(predecessor?{predecessorRef:intake.predecessorRef,opportunityId:predecessor.artifact.opportunityId,remainingUnderwritingGaps:predecessor.artifact.remainingUnderwritingGaps}:{})};
  const id=newId();
  await c.query(`INSERT INTO finnor_os.v2_programmes(tenant_id,principal_id,id,work_id,work_input_id,work_input_digest,root,intake,intake_digest,starting_manifest,starting_digest,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12)`,[ctx.auth.tenantId,actor(ctx),id,intake.workId,work.id,hash(work.body),canonical(intake.root),canonical(intake),digest,canonical(manifest),hash(manifest),intake.idempotencyKey]);
  const p=await programme(ctx,id,c);await ownerBindings(ctx,p,c);
  await attachWorkEntityTx(db,{tenantId:ctx.auth.tenantId,workId:intake.workId,entity:{...intake.root,source:'V2:accepted-primary-assertion'}});
  if(predecessor)await c.query("UPDATE finnor_os.work_programme_occupations SET status='COMPLETE',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND work_id=$2 AND owner='V1_HANDOFF' AND programme_id=$3",[ctx.auth.tenantId,p.work_id,predecessor.artifact.artifactId]);
  for(const a of intake.assertions)await c.query('INSERT INTO finnor_os.v2_assertions(tenant_id,principal_id,programme_id,assertion_id,revision,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[ctx.auth.tenantId,actor(ctx),id,a.assertionId,a.revision,canonical(a),hash(a)]);
  await event(ctx,p,'S1','FROZEN_STARTING_CUT',{startingEvidenceDigest:p.starting_digest,knowledgeCut:cut,assertionRefs:intake.assertions.map(a=>reference('V2',a.assertionId,a.revision,a)),workId:p.work_id,workInputId:p.work_input_id,predecessorRef:intake.predecessorRef,
   ...(predecessor?{sameCanonicalOpportunityId:predecessor.artifact.opportunityId,unchangedUnresolvedGapTransfer:true}:{} )},c);
  await enqueue(ctx,p,c);return {programmeId:id,workId:p.work_id,ref:programmeRef(p),status:'PROGRESS',replayed:false};
 });
}
export async function readPrimary(ctx:PeMutationContext,id:string){
 const p=await programme(ctx,id);await authorize(ctx,p.root,p.work_id);
 // Current owner rights, consent and retention precede private readback. A
 // revocation is not permission to export immutable private historical bytes.
 const grant=await (await import('./store')).governance<import('@finnor/shared-types').PrimaryGrant>(ctx,p.intake.budgetGrantRef,'finnor.primary-grant.v1').catch(()=>{throw unavailable();});
 const rows=await tx(ctx,async c=>(await c.query("SELECT DISTINCT ON(assertion_id) id::text FROM finnor_os.v2_findings WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY assertion_id,created_at DESC,id DESC",[ctx.auth.tenantId,actor(ctx),p.id])).rows,true);
 const findings:import('@finnor/shared-types').IndependentlyEstablishedFinding[]=[];let stale=p.invalidated;
 for(const row of rows)try{findings.push((await currentFinding(ctx,row.id)).finding);}catch{stale=true;}
 const costs=await costReceipts(ctx,p,grant);
 const fullScopeCurrent=await ownerBindings(ctx,p).then(()=>true).catch(()=>false);
 return {programmeId:p.id,root:p.root,ref:programmeRef(p),workId:p.work_id,workRevision:p.work_input_id,status:stale?'BLOCKED':p.status,reason:stale?'FINDING_DEPENDENCY_OR_FRESHNESS_CHANGED':p.reason,
  principalArtifactRef:findings.find(f=>f.artifactId===p.principal_artifact_id)?reference('V2',p.principal_artifact_id!,1,findings.find(f=>f.artifactId===p.principal_artifact_id)!):null,
  findings,assertions:rows.length||!fullScopeCurrent?p.intake.assertions.filter(a=>findings.some(f=>f.assertionRef.id===a.assertionId)):p.intake.assertions,startingEvidenceDigest:p.starting_digest,knowledgeCut:p.starting_manifest.knowledgeCut,
  advanceBindings:{mandateRef:p.intake.mandateRef,authorityProfileRef:p.intake.authorityProfileRef,budgetGrantRef:p.intake.budgetGrantRef,domainProfileRef:p.intake.referenceSemanticsRefs[0],evidenceRevisionVector:(await revisions(ctx,p.starting_manifest.dependencies.map(d=>d.key))).map(d=>({key:d.key,revision:d.revision}))},
  nextObligationRefs:p.next_obligations,requiredApprovalRefs:p.required_approvals,costReceipts:costs,
  qualification:{engineering:'DEVELOPMENT',domain:'NOT_QUALIFIED',S8:'NOT_ADMITTED',live:'NOT_AUTHORIZED',auditOpinion:false}};
}
export async function handlePrimaryOperation(ctx:PeMutationContext,operation:string,value:unknown):Promise<{status:number;body:unknown}>{
 try{
  if(operation==='primary-context'){const input=rooted.parse(value);await authorize(ctx,input.root as PeWorldRootRef);const rights=await rightsBinding(ctx,input.root as PeWorldRootRef);
   const registered=await tx(ctx,async c=>(await c.query('SELECT v.body,v.id,v.revision,v.semantic_owner FROM finnor_os.primary_governance_versions v JOIN finnor_os.primary_governance_heads h USING(tenant_id,id,revision) WHERE v.tenant_id=$1 AND v.issuer_id=$2 AND h.state=\'CURRENT\' ORDER BY v.created_at LIMIT 129',[ctx.auth.tenantId,actor(ctx)])).rows,true);
   if(registered.length>128)throw Error('PRIMARY_OWNER_REGISTRY_BOUND');
   return {status:200,body:{root:input.root,...rights,profiles:registered.map(r=>({ref:reference(r.semantic_owner,r.id,r.revision,r.body),body:r.body})),liveAcquisition:'BLOCKED_EXTERNAL'}};}
  if(operation==='primary-open-work'){const input=PrimaryOperationSchemas['primary-open-work'].parse(value);await authorize(ctx,input.root as PeWorldRootRef);
   const work=await receiveWork({tenantId:ctx.auth.tenantId,userId:actor(ctx),instruction:input.instruction,channel:'console',idempotencyKey:'v2:'+actor(ctx)+':'+(input.investigation?.threadId??'standalone')+':'+input.idempotencyKey,
    activeContext:{entityType:input.root.entityType,entityId:input.root.entityId,entityRefs:[input.root],...(input.investigation?{employeeThreadId:input.investigation.threadId}:{})},
    employeeThreadContext:input.investigation,requireExactIntake:true,
    entityAttachments:[{...input.root,source:'V2:accepted-assertion-work'}],
    authorityContext:{principalId:actor(ctx),producer:'V2_ORDINARY_PRIMARY_DILIGENCE_NOT_LIVE_PERMISSION'}});
   return {status:201,body:{workId:work.workId,workInputId:work.workInputId}};}
  if(operation==='primary-governance-put'){const input=PrimaryOperationSchemas['primary-governance-put'].parse(value);await authorize(ctx,input.root as PeWorldRootRef);return {status:201,body:{ref:await putGovernance(ctx,input.body,input.expectedRef),qualification:'AUTHENTICATED_DEVELOPMENT_OWNER_RECORD_NOT_LIVE_OR_PROFESSIONAL_ADMISSION'}};}
  if(operation==='primary-governance-revoke'){const input=PrimaryOperationSchemas['primary-governance-revoke'].parse(value);await authorize(ctx,input.root as PeWorldRootRef);return {status:200,body:await revokeGovernance(ctx,input.ref,input.reason)};}
  if(operation==='primary-submit')return {status:202,body:await submitPrimary(ctx,value)};
  if(operation==='primary-reserve-budget'){const input=PrimaryOperationSchemas['primary-reserve-budget'].parse(value);await authorize(ctx,input.root as PeWorldRootRef);
   if(process.env.NODE_ENV==='production'||process.env.FINNOR_V2_PROFILE!=='ordinary_disposable')throw Error('PRIMARY_PROTECTED_FIXED_BUDGET_UNAVAILABLE');
   return {status:201,body:await reserveFixedPrimaryBudget(ctx,input)};}
  if(operation==='primary-read')return {status:200,body:await readPrimary(ctx,identified.parse(value).programmeId)};
  if(operation==='primary-cancel'){const input=identified.parse(value),p=await programme(ctx,input.programmeId);await authorize(ctx,p.root,p.work_id);
   await tx(ctx,async c=>{const current=await programme(ctx,p.id,c,true);if(!current.cancellation_requested_at){await c.query("UPDATE finnor_os.v2_programmes SET cancellation_requested_at=clock_timestamp(),status='RECONCILING',reason='CANCELLATION_REQUESTED_RESPONSIBILITY_RETAINED',revision=revision+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),p.id]);await event(ctx,p,'S6','CANCEL_REQUESTED',{releaseGranted:false},c);await enqueue(ctx,await programme(ctx,p.id,c),c);}});
   return {status:202,body:{programmeId:p.id,status:'RECONCILING',releaseGranted:false}};}
  if(operation==='primary-advance'){const input=PrimaryAdvanceSchema.parse(value),p=await programme(ctx,input.programmeRef.id);await authorize(ctx,p.root,p.work_id);
   await tx(ctx,async c=>{const current=await programme(ctx,p.id,c,true);await exactWork(ctx,current,c);
    if(current.revision!==input.expectedRevision||hash(programmeRef(current))!==hash(input.programmeRef))throw Error('PRIMARY_ADVANCE_REVISION_CONFLICT');
    if([['mandateRef',input.mandateRef],['authorityProfileRef',input.authorityProfileRef],['budgetGrantRef',input.budgetGrantRef]].some(([key,ref])=>hash(current.intake[key as 'mandateRef'])!==hash(ref))||!current.intake.referenceSemanticsRefs.some(r=>hash(r)===hash(input.domainProfileRef)))throw Error('PRIMARY_ADVANCE_OWNER_BINDING_CHANGED');
    const bindings=await ownerBindings(ctx,current,c);if(Date.now()>=Date.parse(bindings.mandate.stopping.deadline))throw Error('ORIGINAL_PRIMARY_DEADLINE_EXHAUSTED');
    const vector=await revisions(ctx,current.starting_manifest.dependencies.map(d=>d.key),c,true);
    if(new Set(input.evidenceRevisionVector.map(d=>d.key)).size!==input.evidenceRevisionVector.length||hash(input.evidenceRevisionVector.slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0))!==hash(vector.map(d=>({key:d.key,revision:d.revision}))))throw Error('PRIMARY_ADVANCE_EVIDENCE_VECTOR_CHANGED');
    if(current.cancellation_requested_at||current.invalidated)throw Error('PRIMARY_ADVANCE_CURRENT_OWNER_OR_CANCELLATION_FENCE');
    await c.query("UPDATE finnor_os.v2_programmes SET revision=revision+1,status='PROGRESS',reason=null WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND cancellation_requested_at IS NULL",[ctx.auth.tenantId,actor(ctx),p.id]);
    const updated=await programme(ctx,p.id,c);await event(ctx,updated,'P7','LINKED_ADVANCE',{triggerRef:input.triggerRef,originalGrantRef:current.intake.budgetGrantRef,originalDeadline:bindings.mandate.stopping.deadline,releaseGranted:false},c);await enqueue(ctx,updated,c);
   });return {status:202,body:await readPrimary(ctx,p.id)};}
  if(operation==='primary-consume')return {status:200,body:await consumePrimaryUnderwriting(ctx,value)};
  if(operation==='primary-plan')return {status:201,body:await selectPrimaryPlan(ctx,value)};
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if(error instanceof PeDomainError&&error.code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'PE_ENTITY_NOT_FOUND',error:'Primary evidence is unavailable in the authenticated scope'}};
  if(error instanceof z.ZodError)return {status:400,body:{code:'PRIMARY_SCHEMA_INVALID',error:'An exact bounded primary-evidence request is required'}};
  const predicate=String((error as Error).message).match(/^[A-Z][A-Z0-9_:]{0,159}$/)?.[0]??'PRIMARY_OWNER_PREDICATE_UNPASSED';
  return {status:422,body:{code:'PRIMARY_OWNER_PREDICATE_UNPASSED',predicate}};
 }
}
