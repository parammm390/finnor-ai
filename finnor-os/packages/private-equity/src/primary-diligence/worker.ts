import {createEvidenceSourceTx,appendEvidenceVersionTx} from '@finnor/memory';
import {recordBusinessEvent} from '@finnor/data-platform';
import {ComputeCapacityUnavailableError,DatabaseExecutionDeadlineError,ingestIntegrationEventTx} from '@finnor/db';
import type pg from 'pg';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {DiligenceAssertion,IndependentlyEstablishedFinding,PrimaryClaimCheck,PrimaryCostReceipt,PrimaryObservation,PrimaryRequest,VReference} from '@finnor/shared-types';
import {PrimaryRequestSchema} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {assessPrimaryMeasurement,selectPrimaryConsent} from '../enterprise-experiments';
import {choosePrimaryAcquisition} from '../enterprise-control';
import {reservePrimaryCharge} from '../allocation-store';
import {invokePrimaryInterface,primaryInterface} from '../interface-synthesis/primary-adapter';
import {actor,assertClaim,assertDependencies,authorize,canonical,costReceipts,event,exactWork,hash,methodIdentity,newId,observations,programme,primaryCompletionEvent,reference,revisions,tx,type Programme} from './store';
import {ownerBindings,retainedStatusBindings,type OwnerBindings} from './governance';
import {assertPrimaryRuntimeMode} from './profile';
import {reconcilePrimary} from './reconcile';
import {independentPrimaryCheck,PrimaryNativeFailure,priceCeiling,settleNative} from './native';

interface RequestRow {id:string;body:PrimaryRequest;digest:string;status:string;source_profile_id:string;source_version:number;consent_id:string;consent_version:number;next_cursor:string|null;pages_received:number;revalidation_of:string|null}
const safe=(error:unknown)=>String((error as Error).message).match(/^[A-Z][A-Z0-9_:]{0,159}$/)?.[0]??'PRIMARY_RUNTIME_PREDICATE_UNPASSED';
async function reconcileProviderCharge(ctx:PeMutationContext,p:Programme,b:OwnerBindings,row:RequestRow,
 cost:PrimaryObservation['raw']['body']['providerCost'],c:pg.PoolClient,retainedBytes?:number){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);
 const prior=(await c.query(`SELECT * FROM finnor_os.s5_primary_charges WHERE tenant_id=$1 AND principal_id=$2
  AND reservation_id=$3 AND programme_id=$4 AND charge_key=$5 FOR UPDATE`,
  [ctx.auth.tenantId,actor(ctx),b.grant.reservationRef.id,p.id,'request:'+row.id])).rows[0];
 if(!prior||prior.grant_id!==b.grant.grantId||prior.programme_owner!=='V2'||prior.request_id!==row.id||prior.kind!=='ACQUISITION')throw Error('PRIMARY_ORIGINAL_CHARGE_UNAVAILABLE');
 const bytes=retainedBytes??Number(prior.bytes);
 if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('PRIMARY_STORAGE_ACCOUNTING_BYTES_INVALID');
 const usd=(BigInt(cost.microUsd)+BigInt(priceCeiling(b.grant.pricebook.storageMicroUsdPerByte.numerator,
  b.grant.pricebook.storageMicroUsdPerByte.denominator,BigInt(bytes)))).toString();
 const source=b.sources.find(s=>s.profileId===row.source_profile_id)!;
 const receipt:PrimaryCostReceipt={id:cost.receiptId,owner:'S6',requestId:row.id,kind:'ACQUISITION',microUsd:usd,
  reservedMicroUsd:prior.reserved_micro_usd,possibleAdditionalMicroUsd:cost.possibleAdditionalMicroUsd,
  cpuMicros:null,wallMs:Date.now()-Date.parse(row.body.requestedAt),peakMemoryBytes:null,bytes,humanSeconds:0,
  pricebookRef:source.price.pricebookRef,status:cost.final?'RECONCILED':'UNKNOWN',
  reasons:cost.final?[]:['PROVIDER_PAYMENT_OUTCOME_NOT_FINAL']};
 await c.query(`UPDATE finnor_os.s5_primary_charges SET actual_micro_usd=$4,possible_additional_micro_usd=$5,
  bytes=$6,receipt=$7::jsonb,reconciled_at=CASE WHEN $8 THEN clock_timestamp() ELSE NULL END
  WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3`,
  [ctx.auth.tenantId,b.grant.reservationRef.id,'request:'+row.id,usd,cost.possibleAdditionalMicroUsd,bytes,canonical(receipt),cost.final]);
 return {receipt,prior};
}
async function requests(ctx:PeMutationContext,p:Programme){return tx(ctx,async c=>(await c.query<RequestRow>('SELECT * FROM finnor_os.s6_primary_requests WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY created_at,id LIMIT 257',[ctx.auth.tenantId,actor(ctx),p.id])).rows,true);}
async function transition(ctx:PeMutationContext,p:Programme,execution:Readonly<JobExecutionContext>,status:Programme['status'],reason:string,next:VReference[]=[],approval:VReference[]=[]){
 await tx(ctx,async(c,db)=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,904))',[ctx.auth.tenantId]);
  const current=await programme(ctx,p.id,c,true);
  await assertClaim(ctx,current,execution,c,status!=='COMPLETE');
  if(current.revision!==p.revision)throw Error('PRIMARY_REVISION_FENCED');
  if(status==='COMPLETE')await ownerBindings(ctx,current,c);
  const saved=await c.query('UPDATE finnor_os.v2_programmes SET status=$4,reason=$5,next_obligations=$6::jsonb,required_approvals=$7::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND revision=$8 AND active_claim_token=$9 AND active_claim_fence=$10',[ctx.auth.tenantId,actor(ctx),p.id,status,reason,canonical(next),canonical(approval),p.revision,execution.claimToken,execution.claimFence]);
  if(saved.rowCount!==1)throw Error('PRIMARY_PROGRESSION_FENCED');
  await event(ctx,p,'S4','PROGRESSION',{status,reason,nextObligationRefs:next,requiredApprovalRefs:approval,releaseGranted:false},c);
  if(['COMPLETE','STOPPED','BLOCKED','FAILED'].includes(status))await ingestIntegrationEventTx(db,{tenantId:ctx.auth.tenantId,source:'primary_worker',sourceEventId:'primary:'+p.id+':'+p.revision+':terminal',...primaryCompletionEvent(p),workId:p.work_id,
   payload:{status,reason,workInputId:p.work_input_id,revision:p.revision},evidenceRefs:[],trustClass:'trusted_runtime'});
 });
}
async function requestPrimary(ctx:PeMutationContext,p:Programme,b:OwnerBindings,a:DiligenceAssertion,sourceId:string,execution:JobExecutionContext,revalidationOf:string|null){
 const s=b.sources.find(s=>s.profileId===sourceId)!,sem=b.semantics.find(m=>m.profileId===a.semantics.basisRef.id);
 const consent=sem?selectPrimaryConsent(ctx,{assertion:a,source:s,consents:b.consents,authority:b.authority,semantics:sem,at:new Date().toISOString()}):undefined;
 if(!consent||!sem)throw Error('PRIMARY_MATCHING_CONSENT_OR_SEMANTICS_MISSING');
 const assessment=assessPrimaryMeasurement(ctx,{assertion:a,source:s,consent,authority:b.authority,semantics:sem,at:new Date().toISOString()});if(!assessment.eligible)throw Error('PRIMARY_MEASUREMENT_ADMISSION_CHANGED');
 const rule=sem.rules.find(r=>r.field===a.field)!,fields=[...new Set([a.field,...rule.requiredWitnessFields])].sort();
 const id=newId(),body=PrimaryRequestSchema.parse({schema:'finnor.primary-request.v1',requestId:id,tenantId:ctx.auth.tenantId,principalId:actor(ctx),programmeId:p.id,
  assertionRefs:[reference('V2',a.assertionId,a.revision,a)],sourceProfileRef:p.intake.sourceProfileRefs.find(r=>r.id===s.profileId)!,consentRef:p.intake.consentRefs.find(r=>r.id===consent.consentId)!,
  authorityRef:p.intake.authorityProfileRef,mandateRef:p.intake.mandateRef,grantRef:p.intake.budgetGrantRef,semanticsRef:a.semantics.basisRef,
  legalEntityId:a.semantics.legalEntityId,accountOrParticipantIds:a.semantics.accountOrParticipantIds,purpose:s.purpose,product:s.products.find(v=>consent.products.includes(v))!,
  fieldNames:fields,periodStart:a.semantics.periodStart,periodEnd:a.semantics.periodEnd,cutoff:a.semantics.cutoff,populationId:a.requiredCoverage.populationId,populationRevision:a.requiredCoverage.populationRevision,
  requiredMembers:a.requiredCoverage.members,economicRecordIds:a.economicRecordIds,knowledgeCut:p.starting_manifest.knowledgeCut,requestedAt:new Date().toISOString(),
  expiresAt:new Date(Math.min(Date.parse(b.mandate.stopping.deadline),Date.parse(s.expiresAt),Date.parse(consent.expiresAt))).toISOString()});
 await tx(ctx,async c=>{
  const current=await programme(ctx,p.id,c,true);await assertClaim(ctx,current,execution,c);if(current.revision!==p.revision)throw Error('PRIMARY_REVISION_FENCED');await ownerBindings(ctx,current,c);
  const count=(await c.query(`SELECT count(*)::int n,max(possible_egress_at) last FROM finnor_os.s6_primary_requests
   WHERE tenant_id=$1 AND body->'authorityRef'->>'id'=$2`,[ctx.auth.tenantId,b.authority.profileId])).rows[0];
  if(count.n>=b.authority.contactLimits.maximumRequests||count.last&&Date.now()-new Date(count.last).getTime()<b.authority.contactLimits.minimumSpacingMs)throw Error('PRIMARY_ORIGINAL_CONTACT_LIMIT_EXHAUSTED');
  const storageReserve=priceCeiling(b.grant.pricebook.storageMicroUsdPerByte.numerator,b.grant.pricebook.storageMicroUsdPerByte.denominator,262144n);
  const reserve=(BigInt(s.price.maximumRequestMicroUsd)+BigInt(storageReserve)).toString();
  if(BigInt(reserve)>BigInt(b.authority.exposureLimitMicroUsd))throw Error('PRIMARY_AUTHORITY_EXPOSURE_LIMIT');
  await reservePrimaryCharge(ctx,c,{grant:b.grant,programmeId:p.id,requestId:id,chargeKey:'request:'+id,kind:'ACQUISITION',microUsd:reserve,cpuMicros:'0'});
  await c.query(`INSERT INTO finnor_os.s6_primary_requests(tenant_id,principal_id,programme_id,id,source_profile_id,source_version,consent_id,consent_version,body,digest,operation_key,revalidation_of)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,[ctx.auth.tenantId,actor(ctx),p.id,id,s.profileId,s.revision,consent.consentId,consent.revision,canonical(body),hash(body),p.id+':'+a.assertionId+':'+s.profileId+':'+(revalidationOf??'initial'),revalidationOf]);
  await event(ctx,p,'S2','MEASUREMENT_ADMISSIBILITY',{assertionRef:body.assertionRefs[0],sourceProfileRef:body.sourceProfileRef,assessment},c);
  await event(ctx,p,'S6','REQUEST_INTENDED',{requestRef:reference('S6',id,1,body),interface:primaryInterface(s),grantRef:body.grantRef,consentRef:body.consentRef,possibleEgress:false},c);
 });
 return {id,body,digest:hash(body),status:'INTENDED',source_profile_id:s.profileId,source_version:s.revision,consent_id:consent.consentId,consent_version:consent.revision,next_cursor:null,pages_received:0,revalidation_of:revalidationOf} satisfies RequestRow;
}
async function retrieve(ctx:PeMutationContext,p:Programme,b:OwnerBindings,row:RequestRow,execution:JobExecutionContext,cancelled=false):Promise<boolean>{
 const s=b.sources.find(s=>s.profileId===row.source_profile_id)!,consent=b.consents.find(c=>c.consentId===row.consent_id)!;
 if(!s||!consent||hash(row.body)!==row.digest)throw Error('PRIMARY_DURABLE_REQUEST_BINDING_INVALID');
 const statusOnly=cancelled||b.retainedOnly;
 const operation: 'ACQUIRE'|'STATUS'|'PAGE'|'READ_RESULT'=statusOnly||['POSSIBLE_EGRESS','UNKNOWN'].includes(row.status)?'STATUS':row.status==='INTENDED'?'ACQUIRE':row.next_cursor?'PAGE':row.status==='ACKNOWLEDGED'?'READ_RESULT':'STATUS';
 if(cancelled&&row.status==='INTENDED'){await tx(ctx,c=>c.query("UPDATE finnor_os.s6_primary_requests SET status='CANCELLED_BEFORE_DISPATCH' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id]));return true;}
 const statusKey='status:'+row.id+':'+newId();
 await tx(ctx,async c=>{
  const current=await programme(ctx,p.id,c,true);await assertClaim(ctx,current,execution,c,statusOnly);if(current.revision!==p.revision)throw Error('PRIMARY_REVISION_FENCED');if(!b.retainedOnly)await ownerBindings(ctx,current,c);
  if(operation!=='ACQUIRE'&&!(b.retainedOnly&&s.price.statusReadMicroUsd==='0'))await reservePrimaryCharge(ctx,c,{grant:b.grant,programmeId:p.id,requestId:row.id,chargeKey:statusKey,kind:'STATUS_READ',microUsd:s.price.statusReadMicroUsd,cpuMicros:'0'});
  if(operation==='ACQUIRE')await c.query("UPDATE finnor_os.s6_primary_requests SET status='POSSIBLE_EGRESS',possible_egress_at=COALESCE(possible_egress_at,clock_timestamp()) WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id]);
  await event(ctx,p,'S6',operation==='ACQUIRE'?'POSSIBLE_EGRESS':'READ_ONLY_RECOVERY_INTENDED',{requestId:row.id,operation,cursor:row.next_cursor,originalRequestDigest:row.digest,releaseGranted:false},c);
 });
 let actual:Awaited<ReturnType<typeof invokePrimaryInterface>>;
 try{actual=await invokePrimaryInterface(s,row.body,{operation,...(operation==='PAGE'?{cursor:row.next_cursor!}:{}),deadlineAt:operation==='STATUS'?Date.now()+10000:Math.min(Date.now()+10000,Date.parse(b.mandate.stopping.deadline))});}
 catch(error){await tx(ctx,async c=>{await c.query("UPDATE finnor_os.s6_primary_requests SET status='UNKNOWN',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id]);await event(ctx,p,'S6','UNKNOWN',{requestId:row.id,predicate:safe(error),responsibilityRetained:true},c);});return false;}
 if(operation!=='ACQUIRE')await tx(ctx,c=>c.query("UPDATE finnor_os.s5_primary_charges SET actual_micro_usd=reserved_micro_usd,actual_cpu_micros=0,reconciled_at=clock_timestamp(),receipt=$4::jsonb WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3",[ctx.auth.tenantId,b.grant.reservationRef.id,statusKey,canonical({id:statusKey,owner:'S6',requestId:row.id,kind:'STATUS_READ',microUsd:s.price.statusReadMicroUsd,reservedMicroUsd:s.price.statusReadMicroUsd,possibleAdditionalMicroUsd:'0',cpuMicros:null,wallMs:0,peakMemoryBytes:null,bytes:0,humanSeconds:0,pricebookRef:s.price.pricebookRef,status:'RECONCILED',reasons:['REGISTERED_STATUS_TARIFF_NOT_SEPARATE_PROVIDER_BILL']})]));
 if(actual.requestStatus){
  const status=actual.requestStatus.body,cost=status.providerCost;
  if(cost.pricebookDigest!==s.price.pricebookRef.contentDigest||BigInt(cost.microUsd)<0n||BigInt(cost.possibleAdditionalMicroUsd)<0n)throw Error('PRIMARY_PROVIDER_COST_BINDING_INVALID');
  await tx(ctx,async c=>{
   const {receipt,prior}=await reconcileProviderCharge(ctx,p,b,row,cost,c);
   await event(ctx,p,'S6','SIGNED_REQUEST_STATUS_OBSERVED',{requestId:row.id,status:actual.requestStatus,receipt,
    priorReceipt:prior.receipt,transportDigest:actual.transportDigest,privatePayloadRead:false,retainedOnly:b.retainedOnly},c);
  });
  if(BigInt(cost.microUsd)+BigInt(cost.possibleAdditionalMicroUsd)>BigInt(s.price.maximumRequestMicroUsd))throw Error('PRIMARY_PROVIDER_EXPOSURE_EXCEEDS_ORIGINAL_GRANT');
  if(status.outcome==='UNKNOWN'||!cost.final)return false;
  if(statusOnly){await tx(ctx,c=>c.query("UPDATE finnor_os.s6_primary_requests SET status='ACKNOWLEDGED',acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id]));return true;}
  const present=await tx(ctx,async c=>(await c.query('SELECT 1 FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 LIMIT 1',[ctx.auth.tenantId,actor(ctx),row.id])).rowCount,true);
  await tx(ctx,c=>c.query("UPDATE finnor_os.s6_primary_requests SET status=$4,acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id,present?'OBSERVED':'ACKNOWLEDGED']));
  if(present&&!row.next_cursor)return true;
  if(!status.resultAvailable)return false;
  return retrieve(ctx,p,b,{...row,status:'ACKNOWLEDGED'},execution,false);
 }
 if(!actual.response){await event(ctx,p,'S6','REQUEST_STATUS_ABSENT',{requestId:row.id,blindRetryAllowed:false,recoveryContract:s.recovery});return false;}
 const raw=actual.response,cost=raw.body.providerCost,storageBytes=Buffer.byteLength(canonical(raw));
 if(storageBytes>262144)throw Error('PRIMARY_CANONICAL_RAW_PAGE_BOUND');
 if(cost.pricebookDigest!==s.price.pricebookRef.contentDigest||BigInt(cost.microUsd)<0n||BigInt(cost.possibleAdditionalMicroUsd)<0n)throw Error('PRIMARY_PROVIDER_COST_BINDING_INVALID');
 // Payment reconciliation survives publication refusal. It is not a source fact.
 const receipt=await tx(ctx,async c=>{
  const {receipt,prior}=await reconcileProviderCharge(ctx,p,b,row,cost,c);
  await event(ctx,p,'S5','PROVIDER_COST_RECONCILIATION',{receipt,priorReceipt:prior.receipt,
   providerCost:cost,responseDigest:hash(raw),transportDigest:actual.transportDigest,additionalStorageCommitted:false},c);
  return receipt;
 });
 if(BigInt(cost.microUsd)+BigInt(cost.possibleAdditionalMicroUsd)>BigInt(s.price.maximumRequestMicroUsd))throw Error('PRIMARY_PROVIDER_EXPOSURE_EXCEEDS_ORIGINAL_GRANT');
 if(cancelled){await tx(ctx,c=>c.query("UPDATE finnor_os.s6_primary_requests SET status=$4,acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id,raw.body.status==='UNKNOWN'?'UNKNOWN':'ACKNOWLEDGED']));await event(ctx,p,'S6','CANCELLED_REQUEST_RECONCILED',{requestId:row.id,responseDigest:hash(raw),receipt,rawPrivatePayloadPublished:false});return cost.final&&raw.body.status!=='UNKNOWN';}
 const observationId=newId(),retrievedAt=new Date().toISOString(),observation:PrimaryObservation={observationId,sourceRef:reference('S1',observationId,raw.body.sourceRevision,raw),request:row.body,requestDigest:row.digest,raw,rawDigest:hash(raw),retrievedAt,sourceProfile:s,consent,authority:b.authority,actualAcquisition:true,sourceClass:s.sourceClass,instructionEligible:false};
 await tx(ctx,async(c,db)=>{
  const current=await programme(ctx,p.id,c,true);await assertClaim(ctx,current,execution,c);if(current.revision!==p.revision)throw Error('PRIMARY_REVISION_FENCED');await ownerBindings(ctx,current,c);
  await c.query("SELECT set_config('app.primary_programme_id',$1,true),set_config('app.primary_data_purpose',$2,true)",[p.id,row.body.purpose]);
  const retained=(await c.query('SELECT page_id,source_revision,body FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 LIMIT 129',[ctx.auth.tenantId,actor(ctx),row.id])).rows;
  const pageCount=(await c.query('SELECT pages_received FROM finnor_os.s6_primary_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,actor(ctx),row.id])).rows[0]?.pages_received;
  if(retained.length>128||retained.length!==pageCount)throw Error('PRIMARY_RETAINED_STORAGE_VISIBILITY_OR_PAGE_BOUND_INVALID');
  const old=retained.find(o=>o.page_id===raw.body.coverage.pageId&&o.source_revision===raw.body.sourceRevision);
  if(old&&hash({...old.body.raw.body,providerCost:null})!==hash({...raw.body,providerCost:null}))throw Error('CONFLICTING_PRIMARY_PAGE');
  const uniqueBytes=retained.reduce((sum,o)=>sum+Buffer.byteLength(canonical(o.body.raw)),old?0:storageBytes);
  const settled=await reconcileProviderCharge(ctx,p,b,row,cost,c,uniqueBytes);
  await reservePrimaryCharge(ctx,c,{grant:b.grant,programmeId:p.id,requestId:row.id,chargeKey:'request:'+row.id,
   kind:'ACQUISITION',microUsd:settled.prior.reserved_micro_usd,cpuMicros:settled.prior.reserved_cpu_micros});
  await event(ctx,p,'S5','RETAINED_STORAGE_RECONCILED',{requestId:row.id,receipt:settled.receipt,
   priorReceipt:settled.prior.receipt,priorBytes:Number(settled.prior.bytes),providerCost:cost,
   uniqueStoredPages:retained.length+(old?0:1),basis:'UNIQUE_CANONICAL_PRIMARY_RESPONSE_BYTES',replayed:!!old},c);
  if(old){
   await c.query("UPDATE finnor_os.s6_primary_requests SET status=$4,next_cursor=$5,acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id,cost.final?'OBSERVED':'UNKNOWN',raw.body.coverage.nextCursor]);return;}
  const stored=(await c.query('SELECT COALESCE(sum(octet_length(body::text)),0)::text bytes FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3',[ctx.auth.tenantId,actor(ctx),p.id])).rows[0].bytes;
  if(BigInt(stored)+BigInt(Buffer.byteLength(canonical(observation)))>BigInt(b.grant.maximumStoredBytes))throw Error('ORIGINAL_PRIMARY_STORAGE_GRANT_EXHAUSTED');
  const source=await createEvidenceSourceTx(db,ctx.auth.tenantId,{sourceKey:'primary:'+s.profileId+':'+row.body.sourceProfileRef.revision+':'+row.body.sourceProfileRef.contentDigest,sourceType:'primary_record',title:'Primary evidence, '+s.system,publisher:s.issuer,canonicalUrl:s.endpoint,metadata:{sourceProfileRef:row.body.sourceProfileRef,instructionEligible:false,evidenceTrust:'untrusted_evidence',sourceClass:s.sourceClass}});
  const version=await appendEvidenceVersionTx(db,ctx.auth.tenantId,source.id,{content:canonical(raw),snapshot:{requestId:row.id,sourceRevision:raw.body.sourceRevision,sourceClass:s.sourceClass,instructionEligible:false},asOf:new Date(raw.body.observedAt),retrievedAt:new Date(retrievedAt),entityRefs:[{type:'external_organization',id:s.legalEntityId}],timeRefs:[{kind:'source-observation',occurredAt:raw.body.observedAt}]});
  await c.query(`INSERT INTO finnor_os.s1_primary_observations(tenant_id,principal_id,programme_id,id,request_id,page_id,source_revision,evidence_source_id,evidence_version_id,body,digest,retrieved_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,[ctx.auth.tenantId,actor(ctx),p.id,observationId,row.id,raw.body.coverage.pageId,raw.body.sourceRevision,source.id,version.versionId,canonical(observation),hash(observation),retrievedAt]);
  await c.query("UPDATE finnor_os.s6_primary_requests SET status=$4,next_cursor=$5,pages_received=pages_received+1,acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[ctx.auth.tenantId,actor(ctx),row.id,!cost.final?'UNKNOWN':raw.body.status==='OBSERVED'||raw.body.status==='NO_RECORD'?'OBSERVED':raw.body.status==='NONRESPONSE'?'NONRESPONSE':raw.body.status==='UNKNOWN'?'UNKNOWN':'UNAVAILABLE',raw.body.coverage.nextCursor]);
  await event(ctx,p,'S1','PRIMARY_OBSERVATION_VERSIONED',{observationRef:observation.sourceRef,evidenceSourceId:source.id,evidenceVersionId:version.versionId,requestId:row.id,sourceClass:s.sourceClass,instructionEligible:false,actualAcquisition:true},c);
 });return raw.body.status!=='UNKNOWN';
}
async function publish(ctx:PeMutationContext,p:Programme,b:OwnerBindings,execution:JobExecutionContext,a:DiligenceAssertion,check:PrimaryClaimCheck,raw:PrimaryObservation[],reconciliationId:string,reconciliationDigest:string){
 if(check.result==='REJECT')throw Error('INDEPENDENT_PRODUCER_RECONCILIATION_REJECTED');
 const identity=await methodIdentity(),id=newId(),now=new Date().toISOString(),selected=raw.filter(o=>o.request.assertionRefs.some(r=>r.id===a.assertionId)),scopeDigest=hash(selected.map(o=>o.sourceRef));
 const sourceIds=await tx(ctx,async c=>(await c.query('SELECT DISTINCT evidence_source_id::text id FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND id=ANY($4::uuid[])',[ctx.auth.tenantId,actor(ctx),p.id,selected.map(o=>o.observationId)])).rows.map(r=>r.id),true);
 const neededGovernance=new Set([p.intake.mandateRef,p.intake.authorityProfileRef,p.intake.budgetGrantRef,a.semantics.basisRef,...selected.flatMap(o=>[o.request.sourceProfileRef,o.request.consentRef])].map(r=>'primary-governance:'+r.id));
 const startingSources=new Set((p.starting_manifest.evidence as Array<{id:string;source_id:string}>).filter(e=>a.startingSupportRefs.some(r=>r.id===e.id)).map(e=>'evidence:'+e.source_id));
 const keys=p.starting_manifest.dependencies.map(d=>d.key).filter(key=>key.startsWith('primary-governance:')?neededGovernance.has(key):key.startsWith('evidence:')?startingSources.has(key):true);
 const deps=await revisions(ctx,[...keys,...sourceIds.map(id=>'evidence:'+id),'primary-method:'+identity.checker.contentDigest]);
 const costs=await costReceipts(ctx,p,b.grant) as PrimaryCostReceipt[];
 if(hash(check.checkerIdentity)!==hash(identity.checker)||check.producerReconciliationDigest!==reconciliationDigest)throw Error('PRIMARY_CHECKER_RUNTIME_OR_RECONCILIATION_BINDING_INVALID');
 const checkRef=reference('P4',check.checkId,1,check),reconciliationRef={owner:'P4',id:reconciliationId,revision:'1',contentDigest:reconciliationDigest},planRefs=await tx(ctx,async c=>(await c.query('SELECT id::text,digest FROM finnor_os.v2_plans WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3',[ctx.auth.tenantId,actor(ctx),p.id])).rows.map(r=>({owner:'S4',id:r.id,revision:'1',contentDigest:r.digest})),true);
 const expiry=new Date(Math.min(...[b.authority,b.mandate,b.grant,...b.consents,...b.sources,...b.semantics].map(v=>Date.parse(v.expiresAt)),...b.consents.map(v=>Date.parse(v.retention.derivativesUntil)))).toISOString();
 const preimage:Omit<IndependentlyEstablishedFinding,'contentDigest'>={artifactId:id,artifactKind:'IndependentlyEstablishedFinding',schemaRevision:'finnor.v2.finding.v1',tenantRef:ctx.auth.tenantId,workRef:p.work_id,workRevision:p.work_input_id,
  producerDigest:identity.code.digest,dependencyLockDigest:identity.lockDigest,admissionRef:null,baselineManifestRef:reference('V2','baseline:517003a4396bc8101a90be4b425ee01de9446740',1,{commit:'517003a4396bc8101a90be4b425ee01de9446740',tree:'07ba69b8e96f05944c2f9f14a74b2c400eb89e42'}),
  domainProfileRef:a.semantics.basisRef,mandateRef:p.intake.mandateRef,authorityProfileRef:p.intake.authorityProfileRef,budgetGrantRef:p.intake.budgetGrantRef,sourceRefs:selected.map(o=>o.sourceRef),sourceRevisionVector:deps.map(d=>({key:d.key,revision:d.revision})),rightsRevision:b.rights.rightsRevision,
  effectiveTime:a.semantics.cutoff,knowledgeTime:now,observationTime:selected.map(o=>o.raw.body.observedAt).sort().at(-1)??null,acceptedClaims:check.result==='ACCEPT'?[check.assertionRef]:[],unresolvedClaims:check.conclusion==='UNRESOLVED'?[check.assertionRef]:[],contradictionRefs:check.conclusion==='CONTRADICTED'?[checkRef]:[],
  independentCheckRefs:[checkRef,identity.checker],effectObligationRefs:costs.filter(c=>c.status!=='RECONCILED'||c.possibleAdditionalMicroUsd!=='0').map(c=>reference('S5',c.id,1,c)),externalEventRefs:selected.map(o=>reference('S6',o.request.requestId,1,o.request)),costReceipts:costs,humanInterventionReceipts:[],invalidationDependencies:deps.map(d=>({key:d.key,revision:d.revision})),
  lifecycleEvents:[{state:'proposed',at:p.starting_manifest.knowledgeCut,evidenceRef:reference('V2',p.id,p.revision,{startingEvidenceDigest:p.starting_digest})},{state:'development-verified',at:now,evidenceRef:checkRef}],assertionRef:check.assertionRef,startingEvidenceDigest:p.starting_digest,
  acquisitionPlanAndConsentRefs:[...planRefs,...p.intake.consentRefs],actualPrimaryObservationRefs:selected.map(o=>o.sourceRef),sourceAuthorityAndIndependenceBasis:selected.map(o=>({sourceRef:o.sourceRef,sourceClass:o.sourceClass,sourceControl:o.sourceProfile.sourceControl,authorityRefs:o.sourceProfile.authorityEvidenceRefs,issuer:o.sourceProfile.issuer,respondentId:o.sourceProfile.respondentId,intermediary:o.sourceProfile.intermediary})),
  observedPopulationAndCoverage:check.independentReconciliation,normalizedReconciliationAndCheckerRefs:[reconciliationRef,checkRef],conclusion:check.conclusion,establishedValueOrInterval:check.establishedValue,unobservedRemainderAndMaterialGaps:check.independentReconciliation.gaps,downstreamInvalidationRefs:[],
  freshnessAndReacquisitionConditions:{expiresAt:expiry,conditions:['SOURCE_REVISION','RIGHTS_CONSENT_AUTHORITY','WORK_OR_OPPORTUNITY_REVISION','REFERENCE_MEANING','CHECKER_METHOD','EXPIRY_REQUIRES_ACTUAL_REACQUISITION']},
  evidenceLabels:check.conclusion==='UNRESOLVED'?['UNRESOLVED','COMPUTATION_CHECKED']:check.conclusion==='CONTRADICTED'?['CONTRADICTED','COMPUTATION_CHECKED']:selected.some(o=>o.sourceClass==='DIRECT_EXTERNAL_CONFIRMATION')?['EXTERNALLY_CONFIRMED','COMPUTATION_CHECKED']:['SOURCE_ASSERTED','COMPUTATION_CHECKED'],environment:b.mandate.environment,auditOpinion:false};
 const finding:IndependentlyEstablishedFinding={...preimage,contentDigest:hash(preimage)};
 await tx(ctx,async(c,db)=>{
  const current=await programme(ctx,p.id,c,true);await assertClaim(ctx,current,execution,c);if(current.revision!==p.revision)throw Error('PRIMARY_REVISION_FENCED');await ownerBindings(ctx,current,c);await assertDependencies(ctx,deps,c,true);await exactWork(ctx,p,c);
  if((await methodIdentity()).code.digest!==identity.code.digest)throw Error('PRIMARY_LOADED_METHOD_CHANGED');
  const old=(await c.query('SELECT id FROM finnor_os.v2_findings WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND assertion_id=$4 AND assertion_revision=$5 AND evidence_digest=$6 AND checker_digest=$7',[ctx.auth.tenantId,actor(ctx),p.id,a.assertionId,a.revision,scopeDigest,identity.checker.contentDigest])).rows[0];if(old)return;
  await c.query('INSERT INTO finnor_os.v2_claim_checks(tenant_id,principal_id,programme_id,id,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[ctx.auth.tenantId,actor(ctx),p.id,check.checkId,canonical(check),hash(check)]);
  await c.query(`INSERT INTO finnor_os.v2_findings(tenant_id,principal_id,programme_id,id,assertion_id,assertion_revision,evidence_digest,checker_digest,body,digest)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[ctx.auth.tenantId,actor(ctx),p.id,id,a.assertionId,a.revision,scopeDigest,identity.checker.contentDigest,canonical(finding),hash(finding)]);
  for(const d of deps)await c.query('INSERT INTO finnor_os.v2_dependencies(tenant_id,principal_id,programme_id,finding_id,key,revision) VALUES($1,$2,$3,$4,$5,$6)',[ctx.auth.tenantId,actor(ctx),p.id,id,d.key,d.revision]);
  await c.query('UPDATE finnor_os.v2_programmes SET principal_artifact_id=COALESCE(principal_artifact_id,$4),updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,actor(ctx),p.id,id]);
  await recordBusinessEvent(db,{tenantId:ctx.auth.tenantId,entityType:'v2_independently_established_finding',entityId:id,eventType:'primary_finding_development_checked',payload:{programmeId:p.id,workId:p.work_id,workRevision:p.work_input_id,assertionRef:check.assertionRef,conclusion:check.conclusion,contentDigest:finding.contentDigest,checkerRef:identity.checker,admission:null,auditOpinion:false},source:'@finnor/private-equity'});
  await event(ctx,p,'P4','INDEPENDENT_FINDING_RECORDED',{findingRef:reference('V2',id,1,finding),checkRef},c);
 });
}
export async function advancePrimaryDiligenceJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
 if(!execution||typeof payload.tenantId!=='string'||typeof payload.principalId!=='string'||typeof payload.programmeId!=='string'||typeof payload.revision!=='number'||execution.protocolVersion!==1||execution.tenantId!==payload.tenantId)throw Error('ACTUAL_PRIMARY_DURABLE_CLAIM_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},provenance:{sourceSystem:'V2:primary-diligence-worker',createdBy:payload.principalId}};
 const p=await programme(ctx,payload.programmeId);await authorize(ctx,p.root,p.work_id);if(p.revision!==payload.revision||['FAILED','COMPLETE','STOPPED'].includes(p.status))return;
 assertPrimaryRuntimeMode(p.intake.mode);
 await tx(ctx,async c=>{const current=await programme(ctx,p.id,c,true);
  const claimed=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE",[ctx.auth.tenantId,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];
  if(!claimed||current.revision!==p.revision)throw Error('PRIMARY_CLAIM_FENCED');
  await c.query('UPDATE finnor_os.v2_programmes SET active_claim_token=$4,active_claim_fence=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,actor(ctx),p.id,execution.claimToken,execution.claimFence]);
  await event(ctx,p,'S6','CLAIM_STARTED',{jobId:execution.jobId,workerId:execution.workerId,claimFence:execution.claimFence,revision:p.revision,responsibilityRetained:true},c);
 });p.active_claim_token=execution.claimToken;p.active_claim_fence=execution.claimFence;
 let bindings:OwnerBindings;
 try{
  const prior=await requests(ctx,p);if(prior.length>256)throw Error('PRIMARY_REQUEST_LEDGER_BOUND');
  try{bindings=await ownerBindings(ctx,p);}catch(error){
   if(!prior.some(r=>['POSSIBLE_EGRESS','UNKNOWN','ACKNOWLEDGED'].includes(r.status))&&!p.cancellation_requested_at)throw error;
   bindings=await retainedStatusBindings(ctx,p);
  }
  for(const r of prior.filter(r=>['INTENDED','POSSIBLE_EGRESS','UNKNOWN','ACKNOWLEDGED'].includes(r.status)||r.next_cursor)){
   if(!await retrieve(ctx,p,bindings,r,execution as JobExecutionContext,!!p.cancellation_requested_at)){await transition(ctx,p,execution,'RECONCILING','PRIOR_PHYSICAL_REQUEST_OUTCOME_UNKNOWN',[reference('S6',r.id,1,r.body)]);return;}
  }
  if(p.cancellation_requested_at){await transition(ctx,p,execution,'STOPPED','CANCELLED_RECONCILED_RESPONSIBILITY_RETAINED');return;}
  if(bindings.retainedOnly){await transition(ctx,p,execution,'BLOCKED','RETAINED_REQUEST_STATUS_RECONCILED_NEW_PRIMARY_PERMISSION_UNAVAILABLE',[],[p.intake.authorityProfileRef]);return;}
  let currentRequests=await requests(ctx,p);
  for(let i=currentRequests.length;i<Math.min(bindings.mandate.stopping.maxAcquisitions,128);i++){
   const currentRaw=await observations(ctx,p),checkedAt=new Date().toISOString(),reconciliations=new Map(p.intake.assertions.map(a=>[a.assertionId,reconcilePrimary(a,currentRaw,bindings.semantics.find(m=>m.profileId===a.semantics.basisRef.id)!,{checkedAt,authorityRef:p.intake.authorityProfileRef})]));
   const candidates=[];
   for(const a of p.intake.assertions)for(const s of bindings.sources){
    const prior=currentRequests.filter(r=>r.source_profile_id===s.profileId&&r.body.assertionRefs.some(ref=>ref.id===a.assertionId)),reconciliation=reconciliations.get(a.assertionId)!;
    const needsRevalidation=!!reconciliation.discrepancy||reconciliation.gaps.some(g=>g.startsWith('SUSPICIOUS_REVALIDATION_REQUIRED:')),revalidated=prior.some(r=>r.revalidation_of&&r.status==='OBSERVED'&&!r.next_cursor);
    if(bindings.mandate.stopping.stopOnRequiredCoverage&&reconciliation.observedValue.kind!=='UNKNOWN'&&(!needsRevalidation||currentRequests.some(r=>r.body.assertionRefs.some(ref=>ref.id===a.assertionId)&&r.revalidation_of&&r.status==='OBSERVED'&&!r.next_cursor)))continue;
    if(prior.length&&(!needsRevalidation||revalidated||prior.some(r=>r.revalidation_of)))continue;
    const semantics=bindings.semantics.find(m=>m.profileId===a.semantics.basisRef.id);
    const consent=semantics?selectPrimaryConsent(ctx,{assertion:a,source:s,consents:bindings.consents,authority:bindings.authority,semantics,at:new Date().toISOString()}):undefined;
    candidates.push({assertionId:a.assertionId,sourceProfileId:s.profileId,eligible:Boolean(consent),materialObligations:a.requiredCoverage.members.length+a.knownGaps.length,reservedMicroUsd:s.price.maximumRequestMicroUsd,revalidation:needsRevalidation,revalidationOf:prior[0]?.id??null});
   }
   const choice=choosePrimaryAcquisition({candidates,remainingRequests:bindings.mandate.stopping.maxAcquisitions-currentRequests.length,deadline:bindings.mandate.stopping.deadline,at:new Date().toISOString()});
   const plan={schema:'finnor.primary-acquisition-plan.v1',programmeRef:{id:p.id,revision:p.revision},choice,candidates,grantRef:p.intake.budgetGrantRef,deadline:bindings.mandate.stopping.deadline,at:new Date().toISOString()},planId=newId();
   await tx(ctx,async c=>{await c.query('INSERT INTO finnor_os.v2_plans(tenant_id,principal_id,programme_id,id,programme_revision,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[ctx.auth.tenantId,actor(ctx),p.id,planId,p.revision,canonical(plan),hash(plan)]);await event(ctx,p,'S4','ACQUISITION_SELECTED',{planRef:reference('S4',planId,1,plan),choice},c);});
   if(!choice.selected)break;
   const a=p.intake.assertions.find(a=>a.assertionId===choice.selected!.assertionId)!,candidate=candidates.find(c=>c.assertionId===a.assertionId&&c.sourceProfileId===choice.selected!.sourceProfileId)!,r=await requestPrimary(ctx,p,bindings,a,choice.selected.sourceProfileId,execution as JobExecutionContext,candidate.revalidation?candidate.revalidationOf:null);
   if(!await retrieve(ctx,p,bindings,r,execution as JobExecutionContext)){await transition(ctx,p,execution,'RECONCILING','PHYSICAL_REQUEST_OUTCOME_UNKNOWN',[reference('S6',r.id,1,r.body)]);return;}
   currentRequests=await requests(ctx,p);
   const paged=currentRequests.find(v=>v.id===r.id)!;
   for(let page=1;paged.next_cursor&&page<256;page++){
    if(!await retrieve(ctx,p,bindings,paged,execution as JobExecutionContext)){await transition(ctx,p,execution,'RECONCILING','PRIMARY_PAGE_OUTCOME_UNKNOWN',[reference('S6',r.id,1,r.body)]);return;}
    Object.assign(paged,(await requests(ctx,p)).find(v=>v.id===r.id));
   }
  }
  const raw=await observations(ctx,p),identity=await methodIdentity();let unresolved=0;
  for(const a of p.intake.assertions){
   const sem=bindings.semantics.find(m=>m.profileId===a.semantics.basisRef.id);if(!sem)throw Error('PRIMARY_ASSERTION_REFERENCE_SEMANTICS_MISSING');
   const checkedAt=new Date().toISOString(),proposed=reconcilePrimary(a,raw,sem,{checkedAt,authorityRef:p.intake.authorityProfileRef}),reconciliationId=newId();
   if((proposed.discrepancy||proposed.gaps.some(g=>g.startsWith('SUSPICIOUS_REVALIDATION_REQUIRED:')))&&!currentRequests.some(r=>r.body.assertionRefs.some(ref=>ref.id===a.assertionId)&&r.revalidation_of&&r.status==='OBSERVED'&&!r.next_cursor))throw Error('PRIMARY_REQUIRED_REVALIDATION_UNPASSED');
   await tx(ctx,c=>c.query('INSERT INTO finnor_os.v2_reconciliations(tenant_id,principal_id,programme_id,id,assertion_id,assertion_revision,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[ctx.auth.tenantId,actor(ctx),p.id,reconciliationId,a.assertionId,a.revision,canonical(proposed),hash(proposed)]));
   const result=await independentPrimaryCheck(ctx,p,bindings.grant,{assertion:a,assertionRef:reference('V2',a.assertionId,a.revision,a),semantics:sem,observations:raw.filter(o=>o.request.assertionRefs.some(r=>r.id===a.assertionId)),proposed,startingEvidenceDigest:p.starting_digest,knowledgeCut:p.starting_manifest.knowledgeCut,checkedAt,currentBindings:{sourceProfileRefs:p.intake.sourceProfileRefs,consentRefs:p.intake.consentRefs,authorityRef:p.intake.authorityProfileRef,semanticsRef:a.semantics.basisRef}},async()=>{const current=await programme(ctx,p.id);return !!current.cancellation_requested_at||current.revision!==p.revision||current.active_claim_token!==execution.claimToken;});
   await settleNative(ctx,p,bindings.grant,result.receipt);await event(ctx,p,'P4','INDEPENDENT_CHECK_OBSERVED',{check:result.check,checker:identity.checker,receipt:result.receipt,producerReconciliationDigest:hash(proposed)});
   if(result.check.conclusion==='UNRESOLVED')unresolved++;
   await publish(ctx,p,bindings,execution as JobExecutionContext,a,result.check,raw,reconciliationId,hash(proposed));
  }
  const obligation=reference('S4',p.id+':remaining-coverage',p.revision,{assertions:p.intake.assertions.map(a=>a.assertionId),unresolved,deadline:bindings.mandate.stopping.deadline,remainingGrantRef:p.intake.budgetGrantRef,reachableNewOpportunity:'NONE_CURRENTLY_REGISTERED'});
  await transition(ctx,p,execution,unresolved?(Date.now()>=Date.parse(bindings.mandate.stopping.waitUntil)?'STOPPED':'WAITING'):'COMPLETE',unresolved?'REGISTERED_MATERIAL_REMAINDER_UNRESOLVED':'EXACT_REGISTERED_CLAIMS_INDEPENDENTLY_CHECKED',unresolved?[obligation]:[]);
 }catch(error){
  if(error instanceof ComputeCapacityUnavailableError||error instanceof DatabaseExecutionDeadlineError)throw error;
  if(error instanceof PrimaryNativeFailure){try{const b=await ownerBindings(ctx,p);await settleNative(ctx,p,b.grant,error.receipt);}catch{await event(ctx,p,'S5','NATIVE_METER_UNAVAILABLE',{receipt:error.receipt,responsibilityRetained:true});}}
  const predicate=safe(error);await event(ctx,p,'S6','CLAIM_FAILURE',{predicate,responsibilityRetained:true,releaseGranted:false});
  await transition(ctx,p,execution,/GRANT|BUDGET|LIMIT|AUTHORITY|GOVERNANCE|REVISION|FENCED|RETENTION/.test(predicate)?'BLOCKED':'FAILED',predicate,[],[reference('S4',p.id+':approval',p.revision,{predicate,originalGrantRef:p.intake.budgetGrantRef,permissionToExecute:false})]);
 }
}
