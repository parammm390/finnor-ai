import type pg from 'pg';
import {createHash} from 'node:crypto';
import { withTenantTransaction } from '@finnor/db';
import type { AuthorityRequest, AllocationResource, AllocationResourceInput, AllocationReservation, AllocationConsumption, AllocationOutstandingCommitment, AllocationCertificate, CanonicalAllocationProblem, ExperimentRef, AllocationCheck, S5ExperienceEvent,DurableObligation } from '@finnor/shared-types';
import { AllocationContractError, allocationRef, sameAllocationRef, S5_VERSION, prepareS5Experience,allocationQuantity,allocationDerivedQuantity,allocationDecimal } from '../../epistemic-runtime/src/allocation-contracts';
import {LedgerFault} from '../../governed-execution/src/protocol';
import { epistemicHash } from '../../epistemic-runtime/src/source-precedence';
import { enqueueOwnerDeliveryInTransaction } from '../../governed-execution/src/owner-delivery-store';
import type { PeMutationContext } from './types';
import { canExerciseAuthorityTx, evaluateAuthorityTx, lockCurrentAuthorityTx, validateExactControlApprovalsTx } from '@finnor/authority';
import {planInstitutionDemandCharge,type InstitutionResourceDemand,type InstitutionChargeRequest} from './institution-program/resource-demand';
import {validateBeliefViewPin} from './enterprise-beliefs';
import {lockInstitutionSourceAuthority} from './institution-program/source-locks';
import {workforceAccountingFrontierTx} from './workforce-compensation-closing';

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const denied=()=>new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE','Permitted S5 context is unavailable');
const conflict=()=>new AllocationContractError('IDEMPOTENCY_CONFLICT','S5 idempotency key has a different semantic payload');
function bounded(value:unknown):void {if(Buffer.byteLength(JSON.stringify(value))>8*1024*1024)throw new AllocationContractError('LIMIT_EXCEEDED','S5 record exceeds 8 MiB');}
async function authorize(ctx:PeMutationContext,c:pg.PoolClient):Promise<void>{
  if(ctx.auth.role!=='owner'||actor(ctx)!==ctx.auth.userId)throw denied();
  const rows=await c.query("SELECT id FROM finnor_os.users WHERE id=$1 AND tenant_id=$2 AND status='active' AND role='owner' FOR SHARE",[ctx.auth.userId,ctx.auth.tenantId]);
  if(rows.rowCount!==1)throw denied();
  await lockCurrentAuthorityTx(ctx.auth,c);
}
export function allocationPermissionResources(resources:AllocationResource[]){
 return [...new Map(resources.map(resource=>({type:'allocation_resource',id:resource.scopeRef.id}))
  .map(resource=>[`${resource.type}:${resource.id}`,resource])).values()];
}
export function allocationAuthorityRequest(resources:AllocationResource[],check:AllocationCheck):AuthorityRequest{
 let amount=allocationQuantity('0');
 for(const envelope of check.envelopes){
  const resource=resources.find(r=>r.resourceId===envelope.resourceId)!;
  if(resource.currency!==null&&resource.currency!=='USD')throw new AllocationContractError('BLOCKED_AUTHORITY','Exact authority FX mapping is unavailable');
  if(resource.currency==='USD')for(const quantity of envelope.quantities)amount=amount.add(allocationQuantity(quantity));
 }
 return {operation:'action',capability:'action:allocate_resource',resources:allocationPermissionResources(resources),
  risk:'high',exactAmountUsd:allocationDecimal(amount)};
}
async function authorizeResources(ctx:PeMutationContext,c:pg.PoolClient,resources:AllocationResource[]){
 for(const resource of resources){
  const owner=await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",[ctx.auth.tenantId,resource.ownerRef.id]);
  if(owner.rowCount!==1||!await canExerciseAuthorityTx(ctx.auth,{operation:'query',capability:'query:allocation_resources',
   resource:{type:'allocation_resource',id:resource.scopeRef.id},risk:'low'},c))throw denied();
 }
}
type AllocationOrigin=AllocationResource|CanonicalAllocationProblem|AllocationCertificate|AllocationReservation|AllocationConsumption;
/** Only immutable native owner preimages are delivered; projections are never re-signed. */
async function enqueueAllocationOrigin(ctx:PeMutationContext,c:pg.PoolClient,value:AllocationOrigin,rightsRef:string):Promise<void>{
 const {ref,...content}=value;
 const prefix=value.schema==='finnor.allocation-resource.v1'?`allocation-resource:${value.resourceId}:${value.revision}`
  :value.schema==='finnor.allocation-problem.v1'?'allocation-problem'
  :value.schema==='finnor.allocation-certificate.v1'?'allocation-certificate'
  :value.schema==='finnor.allocation-reservation.v1'?'allocation-reservation':'allocation-consumption';
 if(!sameAllocationRef(ref,allocationRef('S5',prefix,content)))throw denied();
 if('tenantId' in value&&value.tenantId!==ctx.auth.tenantId||'principalId' in value&&value.principalId!==actor(ctx)
   )throw denied();
 if(value.schema==='finnor.allocation-resource.v1')await authorizeResources(ctx,c,[value]);
 await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},
  {kind:'REFERENCE',identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[rightsRef]}});
}
async function enqueueProposalOrigins(ctx:PeMutationContext,c:pg.PoolClient,problem:CanonicalAllocationProblem,certificate:AllocationCertificate){
 await enqueueAllocationOrigin(ctx,c,problem,certificate.rightsRef);
 await enqueueAllocationOrigin(ctx,c,certificate,certificate.rightsRef);
 for(const resource of problem.resources)await enqueueAllocationOrigin(ctx,c,resource,resource.rightsRef);
}
async function appendExperience(ctx:PeMutationContext,c:pg.PoolClient,events:S5ExperienceEvent[]):Promise<void>{
  for(const event of events){const {eventId,...body}=event;
    if(event.tenantId!==ctx.auth.tenantId||event.principalId!==actor(ctx)||eventId!==`s5-event:${epistemicHash(body)}`||event.protectedReceipt!==null||event.appendAuthorityGranted!==false)throw denied();bounded(event);
    await c.query('INSERT INTO finnor_os.s5_experience(tenant_id,principal_id,event_id,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(tenant_id,event_id) DO NOTHING',[ctx.auth.tenantId,actor(ctx),event.eventId,JSON.stringify(event)]);
    // Commit the original prepared event and its authenticated delivery intent
    // together. Foreign mandate/utility references remain their owner's duty;
    // missing ledger dependencies retain pending responsibility without forging
    // preimages or strengthening these immutable qualifications.
    await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},
      {kind:'EVENT',identity:event.eventId,payload:{event,references:[]}});
  }
}
/** Every aggregate mutation participates in one tenant-wide lock. READ
 * COMMITTED obtains fresh snapshots AFTER this lock; serializable/deadlock aborts
 * retry the complete transaction, never a partial resource acquisition. */
async function locked<T>(ctx:PeMutationContext,fn:(c:pg.PoolClient)=>Promise<T>,client?:pg.PoolClient):Promise<T>{
  if(client){
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);
    await authorize(ctx,client);return fn(client);
  }
  for(let attempt=0;;attempt++)try{return await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);await authorize(ctx,c);return fn(c);
  });}catch(e){if(attempt<2&&['40001','40P01'].includes((e as {code?:string}).code??''))continue;throw e;}
}
export { locked as withS5PortfolioTransaction };
export interface AllocationSnapshot {resources:AllocationResource[];outstanding:AllocationOutstandingCommitment[];snapshotDigest:string}
async function snapshot(c:pg.PoolClient,tenantId:string):Promise<AllocationSnapshot>{
  if((await c.query('SELECT finnor_os.y4_allocation_context_complete() complete')).rows[0]?.complete!==true)
    throw new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE','Current complete S5 context is unavailable');
  const resources=(await c.query('SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 ORDER BY r.resource_id LIMIT 17',[tenantId])).rows.map(r=>r.body as AllocationResource);
  const live=(await c.query('SELECT s.*,o.body,p.certificate FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id) JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest WHERE s.tenant_id=$1 AND s.status<>\'RELEASED\' AND p.demand IS NULL ORDER BY s.reservation_id LIMIT 257',[tenantId])).rows;
  if(resources.length>16||live.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','S5 registry/live commitment bound exceeded');
  const effectsByReservation=new Map<string,ExperimentRef[]>();
  if(live.length){
    const effects=(await c.query('SELECT co.reservation_id,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.reservation_id=ANY($2::text[]) AND st.effect_ref IS NOT NULL ORDER BY co.reservation_id,co.consumption_id',[tenantId,live.map(row=>row.reservation_id)])).rows;
    for(const effect of effects){const refs=effectsByReservation.get(effect.reservation_id)??[];refs.push(effect.effect_ref as ExperimentRef);effectsByReservation.set(effect.reservation_id,refs);}
  }
  const outstanding:AllocationOutstandingCommitment[]=[];
  for(const row of live){const origins=row.body as AllocationReservation,cert=row.certificate as AllocationCertificate;
    const effects=effectsByReservation.get(String(row.reservation_id))??[];
    outstanding.push({reservationRef:origins.ref,certificateRef:origins.certificateRef,envelopes:row.envelopes,status:row.status,policyRefs:cert.policyBindings.map(b=>b.policyRef),effectRefs:effects});
  }
  const typed=(await c.query(`SELECT * FROM finnor_os.s5_institution_outstanding()`)).rows;
  if(typed.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','S5 shared occupation bound exceeded');
  for(const row of typed)outstanding.push({reservationRef:row.reservation_ref,
    demandRef:row.demand_ref,envelopes:row.envelopes,status:row.status,
    policyRefs:[],effectRefs:[]});
  if(outstanding.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','S5 shared occupation bound exceeded');
  const value={resources,outstanding:await workforceAccountingFrontierTx(c,tenantId,outstanding)};bounded(value);return {...value,snapshotDigest:epistemicHash(value)};
}
export async function readAllocationSnapshot(ctx:PeMutationContext,client?:pg.PoolClient):Promise<AllocationSnapshot>{return locked(ctx,async c=>{
 const result=await snapshot(c,ctx.auth.tenantId);await authorizeResources(ctx,c,result.resources);return result;
},client);}

/** S5 ordinary fixed-cost acquisition specialization. No causal model or
 * contingent payoff is fabricated to reserve a known, owner-authorized read.
 * Unsupported covenants, noninteger units or uncertain capacity fail closed. */
export async function reserveFixedPrimaryBudget(ctx:PeMutationContext,input:{
 root:{entityType:string;entityId:string};resourceRefs:import('@finnor/shared-types').VReference[];
 maximumMicroUsd:string;maximumCpuMicros:string;idempotencyKey:string;validUntil:string;
 activityClass?:'BILATERAL_RESEARCH_AND_CONTACT';
}):Promise<{reservationRef:import('@finnor/shared-types').VReference;certificateRef:import('@finnor/shared-types').VReference}>{
 return locked(ctx,async c=>{
  const digest=epistemicHash(input),prior=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==digest)throw conflict();const origin=(await c.query('SELECT body FROM finnor_os.s5_reservation_origins WHERE tenant_id=$1 AND allocation_digest=$2',[ctx.auth.tenantId,prior.allocation_digest])).rows[0]?.body;
   if(!origin)throw denied();return {reservationRef:{owner:'S5',id:origin.ref.id,revision:origin.ref.version,contentDigest:origin.ref.contentDigest},certificateRef:{owner:'S5',id:origin.certificateRef.id,revision:origin.certificateRef.version,contentDigest:origin.certificateRef.contentDigest}};}
  if(!/^[1-9]\d{0,95}$/.test(input.maximumMicroUsd)||!/^[1-9]\d{0,95}$/.test(input.maximumCpuMicros)||input.resourceRefs.length!==2)throw new LedgerFault(422,'PRIMARY_FIXED_BUDGET_INVALID');
  const current=await snapshot(c,ctx.auth.tenantId),resources=input.resourceRefs.map(ref=>current.resources.find(r=>r.ref.id===ref.id&&r.ref.contentDigest===ref.contentDigest&&r.ref.version===ref.revision));
  if(resources.some(r=>!r)||current.outstanding.length>=256)throw new LedgerFault(422,'PRIMARY_ORIGINAL_RESOURCES_UNAVAILABLE');
  const actual=resources as AllocationResource[],cash=actual.find(r=>r.unit==='microUSD'&&r.resourceClass==='CASH'),cpu=actual.find(r=>r.unit==='cpu-microseconds'&&r.resourceClass==='COMPUTE');
  if(!cash||!cpu||actual.some(r=>r.revoked||!r.permittedRoots.some(root=>root.entityType===input.root.entityType&&root.entityId===input.root.entityId)||!['STOCK','CUMULATIVE_EXPENDITURE'].includes(r.kind)||Date.now()>=Date.parse(r.validUntil))||
   current.resources.some(r=>r.covenants.some(cv=>cv.terms.some(t=>actual.some(a=>a.resourceId===t.resourceId)))))throw new LedgerFault(422,'PRIMARY_FIXED_RESOURCE_DOMAIN_UNSUPPORTED');
  const until=new Date(Math.min(Date.parse(input.validUntil),...actual.map(r=>Date.parse(r.validUntil)))).toISOString();
  if(Date.now()>=Date.parse(until))throw new LedgerFault(422,'PRIMARY_FIXED_BUDGET_EXPIRED');
  const envelopes=actual.map(r=>{const amount=r===cash?input.maximumMicroUsd:input.maximumCpuMicros;
   if(r.availability.length!==r.existingUse.length||r.availability.length!==r.horizon.periods+1||r.existingUse.some(n=>!/^(0|[1-9]\d*)$/.test(n)))throw new LedgerFault(422,'PRIMARY_FIXED_RESOURCE_DOMAIN_UNSUPPORTED');
   let existing=0n;
   for(let period=0;period<r.availability.length;period++){
    const capacity=r.availability[period]!;
    if(capacity.basis!=='REPORTED_AVAILABLE'||capacity.amount===null||!/^(0|[1-9]\d*)$/.test(capacity.amount)||!/^(0|[1-9]\d*)$/.test(r.safetyMargin))throw new LedgerFault(422,'PRIMARY_FIXED_CAPACITY_UNKNOWN');
    existing+=BigInt(r.existingUse[period]!);let outstanding=0n;
    for(const held of current.outstanding)for(const env of held.envelopes.filter(e=>e.resourceId===r.resourceId)){
     if(env.unit!==r.unit||env.kind!==r.kind||epistemicHash(env.horizon)!==epistemicHash(r.horizon)||env.quantities.some(q=>!/^(0|[1-9]\d*)$/.test(q)))throw new LedgerFault(422,'PRIMARY_OUTSTANDING_ENVELOPE_INCOMPATIBLE');
     outstanding+=env.quantities.slice(0,period+1).reduce((a,b)=>a+BigInt(b),0n);
    }
    if(existing+outstanding+BigInt(amount)+BigInt(r.safetyMargin)>BigInt(capacity.amount))throw new LedgerFault(409,'ORIGINAL_PORTFOLIO_PRIMARY_CAPACITY_EXHAUSTED');
   }
   return {resourceId:r.resourceId,unit:r.unit,kind:r.kind,horizon:r.horizon,quantities:[amount,...Array(r.horizon.periods).fill('0')],minimumQuantities:[amount,...Array(r.horizon.periods).fill('0')]};
  });
  const problem={schema:input.activityClass?'finnor.s5.fixed-programme-problem.v1':'finnor.s5.fixed-primary-problem.v1',tenantId:ctx.auth.tenantId,principalId:actor(ctx),root:input.root,resources:actual,outstanding:current.outstanding,snapshotDigest:current.snapshotDigest,limits:input,policies:[],knowledgeAt:new Date().toISOString(),validUntil:until,
   qualification:input.activityClass?'EXACT_INTEGER_FIXED_ACTIVITY_RESERVATION_NO_EFFECT_AUTHORITY_OR_ECONOMIC_VALUE_CLAIM':'EXACT_INTEGER_FIXED_READ_RESERVATION_NO_CAUSAL_OR_ECONOMIC_VALUE_CLAIM'};
  const certificateBody={schema:'finnor.s5.fixed-primary-certificate.v1',semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx),problemRef:allocationRef('S5','primary-fixed-problem',problem,'s5-primary-fixed-v1'),
   policyBindings:[],resourceRefs:actual.map(r=>r.ref),rightsRef:cash.rightsRef,validUntil:until,check:{feasible:true,envelopes,arithmetic:'EXACT_INTEGER_EVERY_CANONICAL_PREFIX_AND_RETAINED_COMMITMENT'},
   protectedReceipt:null,executionAuthorityGranted:false};
  const certificate={...certificateBody,ref:allocationRef('S5','allocation-certificate',certificateBody,'s5-primary-fixed-v1')};
  const reservationBody={schema:'finnor.allocation-reservation.v1',certificateRef:certificate.ref,tenantId:ctx.auth.tenantId,principalId:actor(ctx),idempotencyKey:input.idempotencyKey,requestDigest:digest,createdAt:new Date().toISOString(),envelopes,status:'RESERVED',revocationReason:null,revision:1,executionAuthorityGranted:false,protectedReceipt:null};
  const reservation={...reservationBody,ref:allocationRef('S5','allocation-reservation',reservationBody,'s5-primary-fixed-v1')};
  bounded({problem,certificate,reservation});
  await c.query('INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[ctx.auth.tenantId,actor(ctx),certificate.ref.contentDigest,JSON.stringify(problem),JSON.stringify(certificate)]);
  await c.query('INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',[ctx.auth.tenantId,actor(ctx),reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(reservation)]);
  await c.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,'RESERVED',$4::jsonb)",[ctx.auth.tenantId,reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(envelopes)]);
  await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5)',[ctx.auth.tenantId,actor(ctx),input.idempotencyKey,digest,certificate.ref.contentDigest]);
  await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,1,'FIXED_PRIMARY_RESERVATION',$3::jsonb)",[ctx.auth.tenantId,reservation.ref.id,JSON.stringify({problem,certificate,reservation})]);
  return {reservationRef:{owner:'S5',id:reservation.ref.id,revision:reservation.ref.version,contentDigest:reservation.ref.contentDigest},certificateRef:{owner:'S5',id:certificate.ref.id,revision:certificate.ref.version,contentDigest:certificate.ref.contentDigest}};
 });
}

/** Factual acquisition debits an original S5 reservation, under the same portfolio
 * lock as every other consumer. A grant never creates resource availability. */
export async function reservePrimaryCharge(ctx:PeMutationContext,c:pg.PoolClient,input:{
 grant:import('@finnor/shared-types').PrimaryGrant|import('@finnor/shared-types').BilateralGrant;programmeId:string;requestId:string|null;
 programmeOwner?:'V1'|'V2';
 chargeKey:string;kind:import('@finnor/shared-types').PrimaryCostReceipt['kind'];microUsd:string;cpuMicros:string;
}){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);await authorize(ctx,c);
 const g=input.grant,r=(await c.query(`SELECT o.body origin,s.*,p.problem,p.certificate FROM finnor_os.s5_reservations s
 JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
 JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest
 WHERE s.tenant_id=$1 AND s.reservation_id=$2 AND o.principal_id=$3 FOR UPDATE OF s`,[ctx.auth.tenantId,g.reservationRef.id,actor(ctx)])).rows[0];
 const nonnegative=(v:string)=>/^(0|[1-9]\d{0,95})$/.test(v);
 if(![g.maximumMicroUsd,g.maximumNativeCpuMicros,input.microUsd,input.cpuMicros].every(nonnegative))throw Error('PRIMARY_RESOURCE_QUANTITY_INVALID');
 if(!r||r.status==='RELEASED'||r.revocation_reason||r.origin.ref.contentDigest!==g.reservationRef.contentDigest||r.origin.ref.owner!==g.reservationRef.owner||r.origin.ref.version!==g.reservationRef.revision||Date.now()>=Math.min(Date.parse(g.expiresAt),Date.parse(r.certificate.validUntil)))throw Error('PRIMARY_ORIGINAL_S5_RESERVATION_UNAVAILABLE');
 // Contingent policy reservations retain their own S5/S6 consumption ledger.
 // A factual read cannot spend their allowance through a second charge table.
 if((input.programmeOwner==='V1'?r.problem.schema!=='finnor.s5.fixed-programme-problem.v1'||r.problem.limits.activityClass!=='BILATERAL_RESEARCH_AND_CONTACT':r.problem.schema!=='finnor.s5.fixed-primary-problem.v1')||(await c.query('SELECT 1 FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND reservation_id=$2 LIMIT 1',[ctx.auth.tenantId,g.reservationRef.id])).rowCount)throw Error('PRIMARY_RESERVATION_HAS_ANOTHER_CONSUMPTION_CONTRACT');
 for(const resource of r.problem.resources as AllocationResource[]){
  const current=(await c.query('SELECT body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 AND r.resource_id=$2',[ctx.auth.tenantId,resource.resourceId])).rows[0]?.body;
  if(!current||!sameAllocationRef(current.ref,resource.ref)||current.revoked||Date.now()>=Date.parse(current.validUntil))throw Error('PRIMARY_RESOURCE_REVISION_CHANGED');
 }
 const envelopes=r.envelopes as import('@finnor/shared-types').AllocationEnvelope[];
 const limit=(unit:string,cls:string)=>{const values=envelopes.filter(e=>e.unit===unit&&r.problem.resources.some((v:AllocationResource)=>v.resourceId===e.resourceId&&v.resourceClass===cls));
  if(values.length!==1||values[0]!.quantities.some(v=>!/^(0|[1-9]\d*)$/.test(v)))throw Error('PRIMARY_S5_EXACT_RESOURCE_ENVELOPE_REQUIRED');
  return values[0]!.quantities.reduce((a,b)=>a+BigInt(b),0n);};
 const cashLimit=limit('microUSD','CASH'),cpuLimit=limit('cpu-microseconds','COMPUTE');
 const prior=(await c.query('SELECT * FROM finnor_os.s5_primary_charges WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3',[ctx.auth.tenantId,g.reservationRef.id,input.chargeKey])).rows[0];
 if(prior&&(prior.programme_id!==input.programmeId||prior.principal_id!==actor(ctx)||prior.grant_id!==g.grantId||
 prior.programme_owner!==(input.programmeOwner??'V2')||prior.request_id!==input.requestId||prior.kind!==input.kind||
 prior.reserved_micro_usd!==input.microUsd||prior.reserved_cpu_micros!==input.cpuMicros))throw Error('PRIMARY_CHARGE_IDENTITY_CONFLICT');
 const used=(await c.query(`WITH retained AS(SELECT *,CASE WHEN reconciled_at IS NOT NULL AND receipt->>'status'='RECONCILED'
  THEN actual_micro_usd+possible_additional_micro_usd ELSE GREATEST(reserved_micro_usd,COALESCE(actual_micro_usd,0)+possible_additional_micro_usd) END held_cash
  FROM finnor_os.s5_primary_charges WHERE tenant_id=$1 AND reservation_id=$2)
 SELECT COALESCE(sum(held_cash),0)::text cash,
 COALESCE(sum(COALESCE(actual_cpu_micros,reserved_cpu_micros)),0)::text cpu,
 COALESCE(sum(CASE WHEN grant_id=$3 THEN held_cash ELSE 0 END),0)::text grant_cash,
 COALESCE(sum(CASE WHEN grant_id=$3 THEN COALESCE(actual_cpu_micros,reserved_cpu_micros) ELSE 0 END),0)::text grant_cpu,
 count(*) FILTER(WHERE grant_id=$3 AND kind='ACQUISITION')::int requests
 FROM retained`,[ctx.auth.tenantId,g.reservationRef.id,g.grantId])).rows[0];
 const additionalCash=prior?0n:BigInt(input.microUsd),additionalCpu=prior?0n:BigInt(input.cpuMicros);
 if(BigInt(used.cash)+additionalCash>cashLimit||BigInt(used.cpu)+additionalCpu>cpuLimit||
 BigInt(used.grant_cash)+additionalCash>BigInt(g.maximumMicroUsd)||BigInt(used.grant_cpu)+additionalCpu>BigInt(g.maximumNativeCpuMicros)||
 !prior&&input.kind==='ACQUISITION'&&used.requests>=g.maximumRequests)throw Error('ORIGINAL_SHARED_PRIMARY_GRANT_EXHAUSTED');
 if(prior)return prior;
 await c.query(`INSERT INTO finnor_os.s5_programme_charges(tenant_id,principal_id,reservation_id,grant_id,charge_key,programme_id,request_id,kind,reserved_micro_usd,possible_additional_micro_usd,reserved_cpu_micros,programme_owner)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11)`,[ctx.auth.tenantId,actor(ctx),g.reservationRef.id,g.grantId,input.chargeKey,input.programmeId,input.requestId,input.kind,input.microUsd,input.cpuMicros,input.programmeOwner??'V2']);
 if(r.status==='RESERVED')await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",[ctx.auth.tenantId,g.reservationRef.id]);
 return {reserved_micro_usd:input.microUsd,reserved_cpu_micros:input.cpuMicros,charge_key:input.chargeKey};
}
/** Domain publishers join the canonical portfolio snapshot in their own
 * transaction, rather than copying availability into a second ledger. */
export async function readAllocationSnapshotTx(ctx:PeMutationContext,c:pg.PoolClient):Promise<AllocationSnapshot>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);
  await authorize(ctx,c);return snapshot(c,ctx.auth.tenantId);
}
type InstitutionReservation = {
  schema:'finnor.s5.institution-reservation.v1';ref:ExperimentRef;demandRef:ExperimentRef;
  tenantId:string;principalId:string;workId:string;demand:InstitutionResourceDemand;
  originalDeadline:string;rightsRevision:string;resources:ExperimentRef[];
  envelopes:CanonicalAllocationProblem['outstanding'][number]['envelopes'];
  status:'RESERVED'|'CONSUMPTION_PENDING'|'UNKNOWN_OUTCOME'|'RELEASED';
  revision?:number;revocationReason?:string|null;
  executionAuthorityGranted:false;protectedReceipt:null;
};
async function institutionState(ctx:PeMutationContext,c:pg.PoolClient,ref:ExperimentRef):Promise<InstitutionReservation>{
 const row=(await c.query(`SELECT o.body,s.status,s.revision,s.revocation_reason FROM finnor_os.s5_reservation_origins o
   JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
   JOIN finnor_os.s5_proposals p ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
   WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.reservation_id=$3 AND p.demand IS NOT NULL`,
   [ctx.auth.tenantId,actor(ctx),ref.id])).rows[0];
 if(!row||row.body.tenantId!==ctx.auth.tenantId||row.body.principalId!==actor(ctx)
   ||!sameAllocationRef(row.body.ref,ref))throw denied();
 return {...row.body,status:row.status,revision:row.revision,revocationReason:row.revocation_reason};
}
async function currentInstitutionMandate(ctx:PeMutationContext,c:pg.PoolClient,workId:string,institutionId:string,deadline:string){
 await lockInstitutionSourceAuthority(ctx,c,workId);
 const rows=(await c.query(`SELECT institution_id,rules FROM finnor_os.x1_work_mandates
    WHERE tenant_id=$1 AND work_id=$2 AND principal_id=$3 AND revoked_at IS NULL
      AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()
    ORDER BY valid_from DESC LIMIT 2`,[ctx.auth.tenantId,workId,actor(ctx)])).rows;
 if(rows.length!==1||rows[0].institution_id!==institutionId
   ||!Array.isArray(rows[0].rules)||rows[0].rules.length<1
   ||deadline!==rows[0].rules.map((rule:{deadlineAt:string})=>rule.deadlineAt).sort()[0])
   throw new AllocationContractError('STALE_INPUT','S5 institution original mandate deadline unavailable');
}
async function currentInstitution(ctx:PeMutationContext,c:pg.PoolClient,r:InstitutionReservation){
 await currentInstitutionMandate(ctx,c,r.workId,r.demand.institutionId,r.originalDeadline);
 const decision=await evaluateAuthorityTx(ctx.auth,{operation:'query',capability:'query:pe_world_state',risk:'low',
   workId:r.workId,resources:[{type:'work',id:r.workId}]},c);
 if(decision.outcome!=='allowed'||decision.reasonCode!=='grant_allows')
   throw new AllocationContractError('STALE_INPUT','S5 original institution current read authority unavailable');
 const currentness=(await c.query<{body:{authorityDecisionId:string;rightsRevision:string;executionAuthorityGranted:false}}>(
   'SELECT finnor_os.s5_assert_institution_current($1,$2) AS body',[r.ref.id,decision.id])).rows[0]!.body;
 const current=await snapshot(c,ctx.auth.tenantId);
 if(Date.now()>=Date.parse(r.originalDeadline)
   ||r.status==='RELEASED'||r.demand.tenantId!==ctx.auth.tenantId
   ||r.demand.principalId!==actor(ctx)||r.demand.workId!==r.workId
   ||r.resources.length!==current.resources.length
   ||r.resources.some(ref=>!current.resources.some(resource=>sameAllocationRef(resource.ref,ref)))
   ||current.resources.some(resource=>resource.revoked||Date.now()>=Date.parse(resource.validUntil)))
   throw new AllocationContractError('STALE_INPUT','S5 institution reservation rights, deadline or resource revision changed');
 for(const resource of current.resources)for(const pin of resource.beliefPins){
  if(pin.tenantId!==ctx.auth.tenantId||pin.principalId!==actor(ctx)
    ||(await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')
    throw new AllocationContractError('STALE_INPUT','S5 institution resource source or rights changed');
 }
 return {snapshot:current,currentness};
}
/** Institution demand enters the same S5 portfolio serializer and resource
 * occupancy population as finite S5 clearings; it is not an X1 budget row. */
export async function reserveInstitutionDemand(ctx:PeMutationContext,demand:InstitutionResourceDemand,rightsRevision:string,client?:pg.PoolClient){
 const reserve=async(c:pg.PoolClient)=>{
  if(demand.semanticOwner!=='S5'||demand.qualification!=='DECLARED_ACCOUNTING_NOT_FUNDING'
    ||demand.tenantId!==ctx.auth.tenantId||demand.principalId!==actor(ctx))throw denied();
  const requestDigest=epistemicHash(demand);
  const {demandDigest,...preimage}=demand;
  if(demandDigest!==epistemicHash(preimage))throw denied();
  await currentInstitutionMandate(ctx,c,demand.workId,demand.institutionId,demand.originalDeadline);
  if(demand.lines.every(line=>line.quantity==='0'))
    throw new AllocationContractError('INVALID_REQUEST','S5 cannot reserve an empty institution resource occupation');
  const prior=(await c.query(`SELECT o.body,s.status,p.demand FROM finnor_os.s5_reservation_origins o
    JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
    JOIN finnor_os.s5_proposals p ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
    WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.allocation_digest=$3 AND p.demand IS NOT NULL`,
    [ctx.auth.tenantId,actor(ctx),demand.demandDigest])).rows[0];
  if(prior){
   if(epistemicHash(prior.demand)!==requestDigest||prior.status==='RELEASED')throw conflict();
   const existing={...prior.body,status:prior.status} as InstitutionReservation;
   return {reservation:existing,semanticReplay:true,currentUseAllowed:false};
  }
  if(Date.now()>=Date.parse(demand.originalDeadline))
    throw new AllocationContractError('STALE_INPUT','S5 original mandate deadline passed');
  const rights=(await c.query('SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE',[ctx.auth.tenantId])).rows[0];
  if(String(rights?.revision)!==rightsRevision)throw new AllocationContractError('STALE_INPUT','S5 institution rights changed');
  const current=await snapshot(c,ctx.auth.tenantId);
  for(const resource of current.resources)for(const pin of resource.beliefPins){
   if(pin.tenantId!==ctx.auth.tenantId||pin.principalId!==actor(ctx)
     ||(await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')
     throw new AllocationContractError('STALE_INPUT','S5 institution resource source or rights changed');
  }
  const envelopes:InstitutionReservation['envelopes']=[];
  for(const line of demand.lines.filter(v=>v.quantity!=='0')){
   const eligible=current.resources.filter(r=>r.resourceClass===line.resourceClass
     && r.kind==='CUMULATIVE_EXPENDITURE'&&r.unit===line.unit&&r.currency===null
     && !r.revoked&&r.covenants.length===0&&Date.now()<Date.parse(r.validUntil)
     && r.availability.every(a=>a.basis==='REPORTED_AVAILABLE'&&a.amount!==null));
   if(eligible.length!==1)throw new AllocationContractError('STALE_INPUT','S5 institution resource unavailable or ambiguous');
   const resource=eligible[0]!,amount=allocationQuantity(line.quantity);
   for(let t=0;t<resource.availability.length;t++){
    const currentUse=allocationQuantity(resource.existingUse.slice(0,t+1).reduce((total,v)=>
      allocationDecimal(allocationQuantity(total).add(allocationQuantity(v))),'0'));
    const occupied=current.outstanding.reduce((total,commitment)=>{
      const bound=commitment.envelopes.find(e=>e.resourceId===resource.resourceId);
      return bound?total.add(allocationQuantity(bound.quantities.slice(0,t+1).reduce((sum,v)=>
        allocationDecimal(allocationQuantity(sum).add(allocationQuantity(v))),'0'))):total;
    },allocationQuantity('0'));
    const maximum=allocationQuantity(resource.availability[t]!.amount!).sub(allocationQuantity(resource.safetyMargin));
    if(currentUse.add(occupied).add(amount).compare(maximum)>0)
      throw new AllocationContractError('STALE_INPUT','S5 shared resource capacity exhausted');
   }
   envelopes.push({resourceId:resource.resourceId,unit:resource.unit,kind:resource.kind,horizon:resource.horizon,
     quantities:[line.quantity,...resource.availability.slice(1).map(()=>'0')],
     minimumQuantities:[line.quantity,...resource.availability.slice(1).map(()=>'0')]});
  }
  if(envelopes.length!==demand.lines.filter(v=>v.quantity!=='0').length)
    throw new AllocationContractError('STALE_INPUT','S5 institution resource funding incomplete');
  const ref=allocationRef('S5','institution-reservation',{tenantId:ctx.auth.tenantId,
    principalId:actor(ctx),workId:demand.workId,demandDigest:demand.demandDigest});
  const demandRef=allocationRef('S5','institution-demand',demand);
  const reservation:InstitutionReservation={schema:'finnor.s5.institution-reservation.v1',ref,demandRef,
    tenantId:ctx.auth.tenantId,principalId:actor(ctx),workId:demand.workId,demand,
    originalDeadline:demand.originalDeadline,rightsRevision,
    resources:current.resources.map(resource=>resource.ref),envelopes,status:'RESERVED',
    executionAuthorityGranted:false,protectedReceipt:null};
  await c.query('SELECT finnor_os.s5_reserve_institution($1::jsonb,$2::jsonb,$3::jsonb,$4)',
    [JSON.stringify(demand),JSON.stringify(reservation),JSON.stringify(envelopes),requestDigest]);
  return {reservation,semanticReplay:false,currentUseAllowed:true};
 };
 if(!client)return locked(ctx,reserve);
 // Parent publishers join this writer rather than waiting on another
 // connection while holding the same source-authority mutex. Acquire this
 // portfolio lock before domain/source locks, as in the standalone writer.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);
 await authorize(ctx,client);
 return reserve(client);
}
export async function chargeInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef,request:InstitutionChargeRequest){
 return locked(ctx,async c=>{
  const r=await institutionState(ctx,c,ref);
  if(!(await c.query<{allowed:boolean}>(
    'SELECT finnor_os.x1_s5_charge_authorized($1::jsonb,$2) AS allowed',
    [JSON.stringify(r),request.responsibilityIdentity])).rows[0]?.allowed)
    throw new AllocationContractError('BLOCKED_AUTHORITY','X1 charge has no current checked duty in the original Work envelope');
  // Original X1 Work reserves at most 520 compute + 900 human units. One-unit
  // records can require 1,420 immutable charges without enlarging that grant.
  const chargeLimit=r.demand.chargeScope?.kind==='ORIGINAL_WORK_EPISODE'?1420:512;
  const rows=(await c.query(`SELECT ch.body FROM finnor_os.s5_governed_resource_charges ch
    JOIN finnor_os.s5_consumptions co ON co.tenant_id=ch.tenant_id AND co.consumption_id=ch.consumption_id
    WHERE ch.tenant_id=$1 AND ch.reservation_id=$2 AND co.principal_id=$3 ORDER BY ch.created_at,ch.charge_key LIMIT $4`,
    [ctx.auth.tenantId,ref.id,actor(ctx),chargeLimit+1])).rows;
  if(rows.length>chargeLimit)throw new AllocationContractError('LIMIT_EXCEEDED','S5 institution charge population bound');
  const existing=rows.map(row=>row.body as {ref:ExperimentRef;reservationRef:ExperimentRef;
    chargeKey:string;requestDigest:string;phase:string;ordinal:number;units:number;resourceId:string;unit:string;physicalInvocationId?:string});
  const plan=planInstitutionDemandCharge({demand:r.demand,envelope:r.envelopes,existingCharges:existing,request});
  if(plan.status==='REFUSED')throw new AllocationContractError('STALE_INPUT',plan.reason);
  if(plan.status==='REPLAY')return {charge:existing.find(row=>row.chargeKey===plan.chargeKey)!,semanticReplay:true};
  const {currentness}=await currentInstitution(ctx,c,r);
  const preimage={schema:'finnor.s5.institution-consumption.v1',reservationRef:ref,
    originalDeadline:r.originalDeadline,parentWorkId:r.workId,chargeKey:plan.chargeKey,
    currentAuthorityDecisionId:currentness.authorityDecisionId,currentRightsRevision:currentness.rightsRevision,
    requestDigest:plan.requestDigest,...request,resourceId:plan.resourceId,unit:plan.unit,
    usedAfter:plan.usedAfter,costs:{money:null,status:'UNMETERED',releaseSufficient:false},
    executionAuthorityGranted:false};
  const body={...preimage,ref:allocationRef('S5','institution-consumption',preimage)};
  await c.query('SELECT finnor_os.s5_consume_institution($1,$2::jsonb)',
    [ref.id,JSON.stringify(body)]);
  return {charge:body,semanticReplay:false};
 });
}
export async function validateInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef){
 return locked(ctx,async c=>{
  const reservation=await institutionState(ctx,c,ref);
  try{
   const {currentness}=await currentInstitution(ctx,c,reservation);
   return {status:'CURRENT' as const,reservation,currentness,executionAuthorityGranted:false as const};
  }catch(error){
   if(error instanceof AllocationContractError && error.code==='STALE_INPUT')
    return {status:'STALE_INPUT' as const,reservation,reason:error.message,
      exposureRetained:reservation.status!=='RELEASED',executionAuthorityGranted:false as const};
   throw error;
  }
 });
}
export async function releaseUntouchedInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef){
 return locked(ctx,async c=>{
  const r=await institutionState(ctx,c,ref);
  const count=(await c.query('SELECT count(*)::int AS n FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,ref.id])).rows[0]?.n;
  if(count||r.status==='CONSUMPTION_PENDING'||r.status==='UNKNOWN_OUTCOME')
    throw new AllocationContractError('BLOCKED_AUTHORITY','S5 possible use retains original resource exposure');
  if(r.status==='RELEASED')return r;
  await c.query('SELECT finnor_os.s5_release_untouched_institution($1)',[ref.id]);
  return {...r,status:'RELEASED' as const};
 });
}
export async function putAllocationResource(ctx:PeMutationContext,input:AllocationResourceInput,expectedRef:ExperimentRef|null):Promise<AllocationResource>{
  return locked(ctx,async c=>{
    if(input.tenantId!==ctx.auth.tenantId||input.ownerRef.id!==actor(ctx)||input.ownerRef.owner!=='BUSINESS_OWNER')throw denied();
    const registry=await snapshot(c,ctx.auth.tenantId),current=registry.resources.find(r=>r.resourceId===input.resourceId);
    if(!current&&registry.resources.length>=16)throw new AllocationContractError('LIMIT_EXCEEDED','Canonical resource registry is full; existing revisions remain permitted');
    if(current?!expectedRef||!sameAllocationRef(current.ref,expectedRef):expectedRef!==null)throw new AllocationContractError('STALE_INPUT','Resource revision changed before mutation');
    if(current&&['unit','kind','resourceClass','currency','horizon','ownerRef','legalEntityRef','scopeRef'].some(k=>!sameAllocationRef((current as any)[k],(input as any)[k])))throw new AllocationContractError('INVALID_REQUEST','Outstanding resources cannot be reinterpreted; use a new canonical identity');
    const body={...input,revision:(current?.revision??0)+1,priorRef:current?.ref??null};
    const ref=allocationRef('S5',`allocation-resource:${input.resourceId}:${body.revision}`,body),resource={...body,ref};bounded(resource);
    await c.query('INSERT INTO finnor_os.s5_resources(tenant_id,resource_id,revision,content_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',[ctx.auth.tenantId,input.resourceId,body.revision,ref.contentDigest,JSON.stringify(resource)]);
    await c.query('INSERT INTO finnor_os.s5_resource_heads(tenant_id,resource_id,revision) VALUES($1,$2,$3) ON CONFLICT(tenant_id,resource_id) DO UPDATE SET revision=excluded.revision',[ctx.auth.tenantId,input.resourceId,body.revision]);
    await enqueueAllocationOrigin(ctx,c,resource,resource.rightsRef);
    // Invalidates clearance but never erases its durable accountable envelope.
    if(current){
      const finite=(await c.query(`UPDATE finnor_os.s5_reservations s SET
        revocation_reason='RESOURCE_REVISION_CHANGED',revision=s.revision+1,updated_at=clock_timestamp()
        FROM finnor_os.s5_proposals p WHERE s.tenant_id=$1 AND p.tenant_id=s.tenant_id
          AND p.content_digest=s.allocation_digest AND p.demand IS NULL AND s.status<>'RELEASED'
          AND s.envelopes @> $2::jsonb RETURNING s.allocation_digest,s.reservation_id,s.revision`,
        [ctx.auth.tenantId,JSON.stringify([{resourceId:input.resourceId}])])).rows;
      await c.query('SELECT * FROM finnor_os.s5_invalidate_institution_resource($1,$2::jsonb,$3::jsonb)',
        [input.resourceId,JSON.stringify(current.ref),JSON.stringify(ref)]);
      for(const old of finite){const proposal=(await c.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',[ctx.auth.tenantId,old.allocation_digest])).rows[0];
        const detail={resourceRef:ref,priorRef:current.ref,reservationRef:old.reservation_id,reservationRevision:old.revision,clearanceInvalidated:true,exposureRetained:true};
        if(proposal?.problem.schema==='finnor.s5.application-resource-problem.v1'&&proposal.certificate.schema==='finnor.s5.application-allocation.v1'){
          const content={schema:'finnor.s5.application-resource-invalidation.v1',tenantId:ctx.auth.tenantId,
            principalId:proposal.certificate.principalId,changedBy:actor(ctx),allocationRef:proposal.certificate.ref,...detail};
          const reference=allocationRef('S5','application-resource-invalidation',content);
          await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'APPLICATION_RESOURCE_REVISION',$4::jsonb)",
            [ctx.auth.tenantId,old.reservation_id,old.revision,JSON.stringify({...content,ref:reference})]);
          await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:proposal.certificate.principalId},
            {kind:'REFERENCE',identity:reference.id,payload:{reference:{...reference,content},rightsRefs:[proposal.certificate.rightsRef]}});
          continue;
        }
        if(proposal?.problem.schema==='finnor.s5.economic-rights-problem.v1'&&proposal.certificate.schema==='finnor.s5.economic-rights-allocation.v1'){
          await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'ECONOMIC_RESOURCE_INVALIDATION',$4::jsonb)",
            [ctx.auth.tenantId,old.reservation_id,old.revision,JSON.stringify({...detail,theoryId:proposal.certificate.theoryId,
              semanticOwner:'S5',obligationsRetained:true,executionAuthorityGranted:false})]);
          continue;
        }
        if(proposal?.problem.schema==='finnor.s5.workforce-resource-problem.v1'){
          await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'WORKFORCE_RESOURCE_INVALIDATION',$4::jsonb)",
            [ctx.auth.tenantId,old.reservation_id,old.revision,JSON.stringify({...detail,programmeId:proposal.problem.programmeId,clearanceInvalidated:true,exposureRetained:true,executionAuthorityGranted:false})]);
          continue;
        }
        if(['finnor.s5.fixed-primary-problem.v1','finnor.s5.fixed-programme-problem.v1'].includes(proposal.problem.schema)){
          await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'PRIMARY_RESOURCE_INVALIDATION',$4::jsonb)",[ctx.auth.tenantId,old.reservation_id,old.revision,JSON.stringify({resourceRef:ref,priorRef:current.ref,reservationId:old.reservation_id,clearanceInvalidated:true,exposureRetained:true})]);
          continue;
        }
        if(!proposal?.problem.mandate)throw denied();
        await appendExperience(ctx,c,[prepareS5Experience(proposal.problem.mandate,'REVISION',ref.id,detail,[current.ref.id,old.reservation_id],'H0')]);}
    }
    await c.query('INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,\'RESOURCE_REVISION\',$4::jsonb)',[ctx.auth.tenantId,ref.id,body.revision,JSON.stringify(resource)]);return resource;
  });
}
function validateStored(ctx:PeMutationContext,problem:CanonicalAllocationProblem,certificate:AllocationCertificate,ref:ExperimentRef):void {
  const {ref:actual,...body}=certificate;
  if(problem.tenantId!==ctx.auth.tenantId||problem.principalId!==actor(ctx)||certificate.tenantId!==ctx.auth.tenantId||certificate.principalId!==actor(ctx)||!sameAllocationRef(actual,ref)||!sameAllocationRef(actual,allocationRef('S5','allocation-certificate',body))||!sameAllocationRef(problem.ref,certificate.problemRef))throw denied();bounded({problem,certificate});
}
async function finiteStored(ctx:PeMutationContext,c:pg.PoolClient,value:ExperimentRef):Promise<{problem:CanonicalAllocationProblem;certificate:AllocationCertificate;reservation:AllocationReservation|null}>{
  if(value.owner!=='S5'||value.version!==S5_VERSION||value.id!==`allocation-certificate:${value.contentDigest}`)throw denied();
  const r=(await c.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',[ctx.auth.tenantId,actor(ctx),value.contentDigest])).rows[0];if(!r)throw denied();validateStored(ctx,r.problem,r.certificate,value);
  const projection=(await c.query('SELECT o.body,s.status,s.envelopes,s.revocation_reason,s.revision FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.allocation_digest=$3',[ctx.auth.tenantId,actor(ctx),value.contentDigest])).rows[0];
  let reservation:AllocationReservation|null=null;
  await enqueueProposalOrigins(ctx,c,r.problem,r.certificate);
  if(projection){const {ref,...origin}=projection.body as AllocationReservation;if(!sameAllocationRef(ref,allocationRef('S5','allocation-reservation',origin)))throw denied();await enqueueAllocationOrigin(ctx,c,projection.body,r.certificate.rightsRef);reservation={...projection.body,status:projection.status,envelopes:projection.envelopes,revocationReason:projection.revocation_reason,revision:projection.revision};}
  return {problem:r.problem,certificate:r.certificate,reservation};
}
async function stored(ctx:PeMutationContext,c:pg.PoolClient,value:ExperimentRef){
 if(value.id.startsWith('institution-reservation:')){
  const reservation=await institutionState(ctx,c,value);
  return {kind:'institution_responsibility_v1' as const,demand:reservation.demand,
    reservation,consumptions:await institutionConsumptions(ctx,c,reservation)};
 }
 return {kind:'finite_allocation_v1' as const,...await finiteStored(ctx,c,value)};
}
export async function persistAllocationProposal(ctx:PeMutationContext,problem:CanonicalAllocationProblem,certificate:AllocationCertificate):Promise<void>{
  validateStored(ctx,problem,certificate,certificate.ref);await locked(ctx,async c=>{const existing=(await c.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',[ctx.auth.tenantId,certificate.ref.contentDigest])).rows[0];
    if(existing){if(!sameAllocationRef(existing,{problem,certificate}))throw new AllocationContractError('INVALID_CANDIDATE','Conflicting immutable allocation proposal');await enqueueProposalOrigins(ctx,c,problem,certificate);return;}
    await c.query('INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[ctx.auth.tenantId,actor(ctx),certificate.ref.contentDigest,JSON.stringify(problem),JSON.stringify(certificate)]);
    await enqueueProposalOrigins(ctx,c,problem,certificate);
    await appendExperience(ctx,c,[prepareS5Experience(problem.mandate,'CANDIDATE',certificate.ref.id,{certificateRef:certificate.ref,check:certificate.check,optimization:certificate.optimization},[problem.ref.id]),prepareS5Experience(problem.mandate,'COST',certificate.compute.id,{compute:certificate.compute})]);
  });
}
export async function readStoredAllocation(ctx:PeMutationContext,ref:ExperimentRef,client?:pg.PoolClient){return locked(ctx,c=>stored(ctx,c,ref),client);}
export async function readAllocationReplay(ctx:PeMutationContext,key:string,digest:string){
  return locked(ctx,async c=>{const r=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key])).rows[0];
    if(r&&r.request_digest!==digest)throw conflict();if(r?.allocation_digest)return finiteStored(ctx,c,{owner:'S5',version:S5_VERSION,id:`allocation-certificate:${r.allocation_digest}`,contentDigest:r.allocation_digest});
    if(!r)await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest) VALUES($1,$2,$3,$4)',[ctx.auth.tenantId,actor(ctx),key,digest]);return null;});
}
export type AllocationCommitFence=(client:pg.PoolClient,problem:CanonicalAllocationProblem,certificate:AllocationCertificate)=>Promise<{
 authorityRequest:AuthorityRequest;approvalDecisionIds:string[];
}>;
export async function commitAllocationReservation(ctx:PeMutationContext,problem:CanonicalAllocationProblem,certificate:AllocationCertificate,key:string,digest:string,recheck:(resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[])=>Promise<AllocationCheck>,deadlineAt:number,fence?:AllocationCommitFence):Promise<AllocationReservation>{
  return locked(ctx,async c=>{
    if(performance.now()>=deadlineAt)throw new AllocationContractError('LIMIT_EXCEEDED','Whole allocation decision deadline exhausted during commitment contention');
    const req=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key])).rows[0];if(!req||req.request_digest!==digest)throw conflict();
    if(req.allocation_digest){const previous=await finiteStored(ctx,c,{owner:'S5',version:S5_VERSION,id:`allocation-certificate:${req.allocation_digest}`,contentDigest:req.allocation_digest});if(previous.reservation)return previous.reservation;throw denied();}
    const issued=await finiteStored(ctx,c,certificate.ref);if(!sameAllocationRef(issued.problem,problem)||!sameAllocationRef(issued.certificate,certificate))throw new AllocationContractError('INVALID_CANDIDATE','Candidate differs from persisted issuer');
    const current=await snapshot(c,ctx.auth.tenantId);
    if(current.snapshotDigest!==problem.snapshotDigest||Date.now()>=Date.parse(certificate.validUntil))throw new AllocationContractError('STALE_INPUT','Solved allocation snapshot expired or changed before commitment');
    if(current.outstanding.length>=256)throw new AllocationContractError('LIMIT_EXCEEDED','Live commitment registry is full; reconciliation and release remain permitted');
    const check=await recheck(current.resources,current.outstanding);if(!check.feasible||!sameAllocationRef(check,certificate.check))throw new AllocationContractError('INVALID_CANDIDATE','Independent current-state canonical check rejects allocation');
    await (await import('./confidential-computation/owner-consumer')).assertConfidentialAllocationCurrent(ctx,problem,c);
    await authorizeResources(ctx,c,current.resources);
    const nativeRequest=allocationAuthorityRequest(current.resources,check),authority=await evaluateAuthorityTx(ctx.auth,nativeRequest,c);
    if(authority.outcome==='denied'||authority.outcome==='approval_required'&&!fence)throw new AllocationContractError('BLOCKED_AUTHORITY','Current exact S1 allocation authority is required');
    // The caller's owner fence runs under this same aggregate/authority cut.
    // No nested pool read, and no signed/approved preview becomes a reservation.
    if(fence){
      const exact=await fence(c,problem,certificate);
      if(!exact.authorityRequest.controlBinding||exact.authorityRequest.capability!==nativeRequest.capability
        ||exact.authorityRequest.operation!==nativeRequest.operation||exact.authorityRequest.risk!==nativeRequest.risk
        ||exact.authorityRequest.exactAmountUsd!==nativeRequest.exactAmountUsd
        ||!sameAllocationRef(exact.authorityRequest.resources,nativeRequest.resources))
        throw new AllocationContractError('BLOCKED_AUTHORITY','Exact native allocation approval differs from current resources or quantities');
      // S1, not the caller callback, owns the standing/configured approval proof.
      await validateExactControlApprovalsTx(ctx.auth,exact.authorityRequest,exact.approvalDecisionIds,c);
    }
    if(performance.now()>=deadlineAt)throw new AllocationContractError('LIMIT_EXCEEDED','Whole allocation decision deadline exhausted during final exact check');
    const body:Omit<AllocationReservation,'ref'>={schema:'finnor.allocation-reservation.v1',certificateRef:certificate.ref,tenantId:ctx.auth.tenantId,principalId:actor(ctx),idempotencyKey:key,requestDigest:digest,createdAt:new Date().toISOString(),envelopes:check.envelopes,status:'RESERVED',revocationReason:null,revision:1,executionAuthorityGranted:false,protectedReceipt:null};
    const reservation={...body,ref:allocationRef('S5','allocation-reservation',body)};bounded(reservation);
    await c.query('INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',[ctx.auth.tenantId,actor(ctx),reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(reservation)]);
    await c.query('INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,\'RESERVED\',$4::jsonb)',[ctx.auth.tenantId,reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(check.envelopes)]);
    await c.query('UPDATE finnor_os.s5_requests SET allocation_digest=$4 WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key,certificate.ref.contentDigest]);
    await enqueueAllocationOrigin(ctx,c,reservation,certificate.rightsRef);
    await appendExperience(ctx,c,[prepareS5Experience(problem.mandate,'RESERVATION',reservation.ref.id,{reservation,certificateRef:certificate.ref},[certificate.ref.id],'H0')]);return reservation;
  });
}
async function consumptions(ctx:PeMutationContext,c:pg.PoolClient,ref:ExperimentRef):Promise<AllocationConsumption[]>{
  const issued=await finiteStored(ctx,c,ref);const rows=(await c.query('SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) JOIN finnor_os.s5_reservation_origins ro USING(tenant_id,reservation_id) WHERE co.tenant_id=$1 AND co.principal_id=$2 AND ro.allocation_digest=$3 ORDER BY co.consumption_id',[ctx.auth.tenantId,actor(ctx),ref.contentDigest])).rows;
  const result:AllocationConsumption[]=[];
  for(const row of rows){const {ref,...body}=row.body as AllocationConsumption;if(!sameAllocationRef(ref,allocationRef('S5','allocation-consumption',body)))throw denied();await enqueueAllocationOrigin(ctx,c,row.body,issued.certificate.rightsRef);result.push({...row.body,status:row.status,effectRef:row.effect_ref});}
  return result;
}
async function institutionConsumptions(ctx:PeMutationContext,c:pg.PoolClient,reservation:InstitutionReservation){
 const limit=reservation.demand.chargeScope?.kind==='ORIGINAL_WORK_EPISODE'?1420:512;
 const rows=(await c.query(`SELECT co.body,st.status,st.effect_ref
   FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
   WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.reservation_id=$3
   ORDER BY co.consumption_id LIMIT $4`,[ctx.auth.tenantId,actor(ctx),reservation.ref.id,limit+1])).rows;
 if(rows.length>limit)throw new AllocationContractError('LIMIT_EXCEEDED','S5 institution consumption bound exceeded');
 return rows.map(row=>({...row.body,status:row.status,effectRef:row.effect_ref}));
}
export async function readAllocationConsumptions(ctx:PeMutationContext,ref:ExperimentRef,client?:pg.PoolClient){
 return locked(ctx,async c=>ref.id.startsWith('institution-reservation:')
   ? institutionConsumptions(ctx,c,await institutionState(ctx,c,ref))
   : consumptions(ctx,c,ref),client);
}
export function recordAllocationConsumption(ctx:PeMutationContext,reservationRef:ExperimentRef,
  request:InstitutionChargeRequest):ReturnType<typeof chargeInstitutionDemand>;
export function recordAllocationConsumption(ctx:PeMutationContext,reservationRef:ExperimentRef,
  body:Omit<AllocationConsumption,'ref'>,compatibleScenarioIds:string[],
  recheck:(resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[])=>Promise<AllocationCheck>):Promise<AllocationConsumption>;
export async function recordAllocationConsumption(ctx:PeMutationContext,reservationRef:ExperimentRef,
  body:Omit<AllocationConsumption,'ref'>|InstitutionChargeRequest,compatibleScenarioIds?:string[],
  recheck?:(resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[])=>Promise<AllocationCheck>){
  if('responsibilityIdentity' in body)return chargeInstitutionDemand(ctx,reservationRef,body);
  if(!compatibleScenarioIds||!recheck)throw denied();
  return locked(ctx,async c=>{
    const issued=await finiteStored(ctx,c,body.certificateRef),reservation=issued.reservation;if(!reservation||!sameAllocationRef(reservation.ref,reservationRef)||reservation.status==='RELEASED'||reservation.revocationReason||Date.now()>=Date.parse(issued.certificate.validUntil))throw new AllocationContractError('STALE_INPUT','Current unrevoked reserved allocation required');
    if(body.status!=='INTENDED_PENDING_S6'||body.effectRef!==null)throw new AllocationContractError('INVALID_REQUEST','Consumption cannot invent S6 effect or settlement');
    const usedKey=(await c.query('SELECT request_digest,body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),body.idempotencyKey])).rows[0];
    if(usedKey&&(!sameAllocationRef(usedKey.body.certificateRef,body.certificateRef)||usedKey.request_digest!==body.requestDigest))throw conflict();
    const prior=await consumptions(ctx,c,body.certificateRef),key=prior.find(p=>p.idempotencyKey===body.idempotencyKey),node=prior.find(p=>sameAllocationRef(p.policyRef,body.policyRef)&&p.nodeId===body.nodeId);
    if(key){if(key.requestDigest!==body.requestDigest)throw conflict();return key;}if(node)throw new AllocationContractError('IDEMPOTENCY_CONFLICT','Policy node was already consumed under another key');
    let compatible=new Set(compatibleScenarioIds);for(const p of prior)compatible=new Set([...compatible].filter(id=>p.compatibleScenarioIds.includes(id)));
    if(!compatible.size)throw new AllocationContractError('INVALID_CANDIDATE','Consumption branches cannot coincide in a supported common path');
    const policy=issued.problem.policies.find(p=>sameAllocationRef(p.ref,body.policyRef)),selectedNode=policy?.nodes.find(n=>n.id===body.nodeId);
    if(!policy||!selectedNode)throw denied();
    for(let period=0;period<selectedNode.period;period++)if(!prior.some(use=>sameAllocationRef(use.policyRef,body.policyRef)&&policy.nodes.some(n=>n.id===use.nodeId&&n.period===period&&sameAllocationRef([...n.actionHistory,n.actionId],selectedNode.actionHistory.slice(0,period+1)))))throw new AllocationContractError('INVALID_CANDIDATE','Earlier policy branch consumption history is required before later intent');
    const current=await snapshot(c,ctx.auth.tenantId),check=await recheck(current.resources,current.outstanding);
    if(!check.feasible||!sameAllocationRef(check.envelopes,issued.certificate.check.envelopes)||check.objective!==issued.certificate.check.objective)throw new AllocationContractError('STALE_INPUT','Current resource check rejects consumption');
    if(!sameAllocationRef(body.reservationRef,reservation.ref)||!issued.certificate.policyBindings.some(p=>sameAllocationRef(p.policyRef,body.policyRef)&&p.demandDigest===body.demandDigest))throw denied();
    const consumption={...body,compatibleScenarioIds:[...compatible].sort(),ref:allocationRef('S5','allocation-consumption',{...body,compatibleScenarioIds:[...compatible].sort()})};bounded(consumption);
    await c.query('INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',[ctx.auth.tenantId,actor(ctx),consumption.ref.id,reservation.ref.id,body.policyRef.id,body.nodeId,body.idempotencyKey,body.requestDigest,JSON.stringify(consumption)]);
    await c.query('INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,\'INTENDED_PENDING_S6\',1)',[ctx.auth.tenantId,consumption.ref.id]);
    await c.query("UPDATE finnor_os.s5_reservations SET status=CASE WHEN status='RESERVED' THEN 'CONSUMPTION_PENDING' ELSE status END,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",[ctx.auth.tenantId,reservation.ref.id]);
    await enqueueAllocationOrigin(ctx,c,consumption,issued.certificate.rightsRef);
    await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'CONSUMPTION',consumption.ref.id,{consumption,actualConsumption:'UNKNOWN_PENDING_QUALIFIED_S6_ENFORCEMENT',responsibilityRetained:true},[body.decisionRef.id,reservation.ref.id],'H0')]);return consumption;
  });
}
export async function releaseUntouchedAllocation(ctx:PeMutationContext,ref:ExperimentRef,key:string):Promise<AllocationReservation>{
  return locked(ctx,async c=>{const issued=await finiteStored(ctx,c,ref),r=issued.reservation;if(!r)throw denied();
    const digest=epistemicHash({operation:'RELEASE_UNTOUCHED',ref}),prior=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key])).rows[0];if(prior&&prior.request_digest!==digest)throw conflict();
    const uses=await consumptions(ctx,c,ref);
    const primary=(await c.query('SELECT 1 FROM finnor_os.s5_primary_charges WHERE tenant_id=$1 AND reservation_id=$2 LIMIT 1',[ctx.auth.tenantId,r.ref.id])).rowCount;
    if(uses.length||primary)throw new AllocationContractError('BLOCKED_AUTHORITY','Pending/unknown external handoff requires qualified S6 reconciliation before release');
    if(!prior)await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5)',[ctx.auth.tenantId,actor(ctx),key,digest,ref.contentDigest]);
    if(r.status==='RELEASED')return r;
    await c.query('UPDATE finnor_os.s5_reservations SET status=\'RELEASED\',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,r.ref.id]);
    const released={...r,status:'RELEASED' as const,revision:r.revision+1};await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RELEASE',r.ref.id,{reservation:released,basis:'NO_S5_HANDOFF_INTENT_OR_EFFECT_EVER_RECORDED',externalCancellationClaimed:false},[ref.id],'H0')]);return released;
  });
}
export async function retainAllocationReconciliation(ctx:PeMutationContext,ref:ExperimentRef,expectedRevision:number,observations:Record<string,unknown>):Promise<AllocationReservation>{
  return locked(ctx,async c=>{const issued=await finiteStored(ctx,c,ref),r=issued.reservation;if(!r||r.revision!==expectedRevision)throw new AllocationContractError('STALE_INPUT','Reconciliation reservation revision changed');
    const uses=await consumptions(ctx,c,ref);if(!uses.length||r.status==='RELEASED')return r;
    if(r.status!=='UNKNOWN_OUTCOME')await c.query('UPDATE finnor_os.s5_reservations SET status=\'UNKNOWN_OUTCOME\',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,r.ref.id]);
    for(const use of uses.filter(u=>u.status==='INTENDED_PENDING_S6'))await c.query('UPDATE finnor_os.s5_consumption_states SET status=\'UNKNOWN_OUTCOME\',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2',[ctx.auth.tenantId,use.ref.id]);
    bounded(observations);const retained={...r,status:'UNKNOWN_OUTCOME' as const,revision:r.status==='UNKNOWN_OUTCOME'?r.revision:r.revision+1};
    await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RECONCILIATION',r.ref.id,{observations,reservation:retained,exposureRetained:true,qualifiedSettlement:null,requiredOwner:'S6'},[ref.id,...uses.map(u=>u.ref.id)],'H0')]);return retained;
  });
}
export async function persistAllocationExperience(ctx:PeMutationContext,events:S5ExperienceEvent[],client?:pg.PoolClient):Promise<void>{await locked(ctx,c=>appendExperience(ctx,c,events),client);}

/** Versioned owner adapters share the canonical lock/snapshot/history, not
 * another allocation ledger. Their own schema validators remain mandatory. */
export const withAllocationPortfolio=locked;
export const allocationSnapshotInTransaction=snapshot;
export const appendAllocationExperienceInTransaction=appendExperience;
/** Native closing binding, under the same aggregate lock and original S5
 * consumption. This is not the old numeric-field protected receipt class. */
export async function bindClosingAllocationAttempt(ctx:PeMutationContext,input:{
  allocationRef:ExperimentRef;consumptionRef:ExperimentRef;programmeId:string;nodeKey:string;effectId:string;
}) {
  return locked(ctx,async c=>{
    const issued=await finiteStored(ctx,c,input.allocationRef),r=issued.reservation;
    const use=(await consumptions(ctx,c,input.allocationRef)).find(u=>sameAllocationRef(u.ref,input.consumptionRef));
    const native=(await c.query(
      "SELECT q.spec,q.spec_digest,e.semantic_hash,e.effect,e.domain_action_id FROM finnor_os.pe_closing_programmes q JOIN finnor_os.pe_closing_node_links l ON l.tenant_id=q.tenant_id AND l.programme_id=q.id JOIN finnor_os.business_effects e ON e.tenant_id=l.tenant_id AND e.id=l.business_effect_id WHERE q.tenant_id=$1 AND q.id=$2 AND l.node_key=$3 AND e.id=$4",
      [ctx.auth.tenantId,input.programmeId,input.nodeKey,input.effectId],
    )).rows[0];
    if(!r||r.status==='RELEASED'||r.revocationReason||!use||!native)throw denied();
    const step=native.spec.steps.find((s:any)=>s.key===input.nodeKey);
    const strip=(ref:any)=>({owner:ref?.owner,id:ref?.id,version:ref?.version,contentDigest:ref?.contentDigest});
    if(!step||!sameAllocationRef(strip(step.allocationRef),input.allocationRef)
      ||!sameAllocationRef(strip(step.policyRef),use.policyRef)
      ||native.effect.delta.values.specDigest!==native.spec_digest
      ||native.effect.delta.values.nodeKey!==input.nodeKey
      ||issued.problem.episodeId!==native.spec.originalGrant.episodeRef.id)throw denied();
    const selectedPolicy=issued.problem.policies.find(policy=>sameAllocationRef(policy.ref,use.policyRef));
    const selectedNode=selectedPolicy?.nodes.find(node=>node.id===use.nodeId);
    const demand=selectedPolicy?.demand.branches.find(branch=>branch.nodeId===use.nodeId);
    if(!selectedPolicy||!selectedNode||!demand||selectedPolicy.demand.contentDigest!==use.demandDigest)throw denied();
    const resourceIds=new Set<string>();
    for(const binding of step.resourceBindings){
      const resource=issued.problem.resources.find(resource=>sameAllocationRef(resource.ref,strip(binding.resourceRef)));
      const envelope=use.envelope.find(e=>e.resourceId===resource?.resourceId);
      if(!resource||!envelope||resource.unit!==binding.unit||allocationQuantity(binding.quantity).n<=0n)throw denied();
      if(resourceIds.has(resource.resourceId))throw denied();resourceIds.add(resource.resourceId);
      const period=selectedNode.period;
      const covered=['STOCK','CUMULATIVE_EXPENDITURE'].includes(resource.kind)
        ?envelope.quantities.slice(0,period+1).reduce((sum,quantity)=>sum.add(allocationQuantity(quantity)),allocationQuantity('0'))
        :allocationQuantity(envelope.quantities[period]??'0');
      const selectedDemand=issued.problem.demandBindings.filter(bound=>sameAllocationRef(bound.policyRef,use.policyRef)&&bound.resourceId===resource.resourceId)
        .reduce((sum,bound)=>sum.add(allocationDerivedQuantity(String((bound.component==='TOTAL'?demand.total:demand.occupancy)[bound.dimensionId]??0))),allocationQuantity('0'));
      if(covered.compare(allocationQuantity(binding.quantity))<0||selectedDemand.compare(allocationQuantity(binding.quantity))<0)
        throw new AllocationContractError('INVALID_CANDIDATE','Original selected S5 policy/node/period cannot cover the exact closing use');
    }
    if(['DRAW_FUNDS','PAY_FUNDS'].includes(step.kind)){
      const requirement=(step.kind==='DRAW_FUNDS'?native.spec.funding:native.spec.fundsFlows).find((f:any)=>f.key===step.requirementKey);
      if(!requirement||!step.resourceBindings.length)throw denied();
      const financial=step.resourceBindings.filter((b:any)=>{
        const resource=issued.problem.resources.find(resource=>sameAllocationRef(resource.ref,strip(b.resourceRef)));
        return resource&&resource.currency===requirement.money.currency&&resource.legalEntityRef.id===requirement.money.entityId
          &&b.unit===requirement.money.currency
          &&(step.kind==='DRAW_FUNDS'?resource.resourceClass==='BORROWING_HEADROOM'||resource.resourceClass==='COMMITTED_CAPITAL'
            :resource.resourceClass==='CASH'||resource.resourceClass==='OTHER_RESTRICTED');
      });
      if(financial.reduce((sum:ReturnType<typeof allocationQuantity>,b:any)=>sum.add(allocationQuantity(b.quantity)),allocationQuantity('0')).compare(allocationDerivedQuantity(requirement.money.amount))<0)throw denied();
      if(step.kind==='DRAW_FUNDS'&&financial.some((b:any)=>issued.problem.resources.find(resource=>sameAllocationRef(resource.ref,strip(b.resourceRef)))!.sourceRef.contentDigest!==requirement.facilityDigest))throw denied();
    }
    const effectRef:ExperimentRef={owner:'S6',id:input.effectId,version:'finnor.business-effect.v1',contentDigest:native.semantic_hash};
    if(use.effectRef){if(!sameAllocationRef(use.effectRef,effectRef))throw conflict();return {consumption:use,reservation:r,semanticReplay:true};}
    await c.query("UPDATE finnor_os.s5_consumption_states SET effect_ref=$3::jsonb,status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2",[ctx.auth.tenantId,use.ref.id,JSON.stringify(effectRef)]);
    await c.query("UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",[ctx.auth.tenantId,r.ref.id]);
    await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'CONSUMPTION',use.ref.id,{programmeId:input.programmeId,nodeKey:input.nodeKey,effectRef,resourceEnvelopeRetained:true,physicalOutcome:'UNKNOWN_PENDING_S6_INDEPENDENT_OBSERVATION',protectedReceipt:null},[input.allocationRef.id,use.ref.id],'H0')]);
    return {consumption:{...use,status:'UNKNOWN_OUTCOME' as const,effectRef},reservation:{...r,status:'UNKNOWN_OUTCOME' as const},semanticReplay:false};
  });
}

export async function reconcileClosingAllocationObservation(ctx:PeMutationContext,input:{
  allocationRef:ExperimentRef;consumptionRef:ExperimentRef;effectId:string;evidenceVersionId:string;
}) {
  return locked(ctx,async c=>{
    const issued=await finiteStored(ctx,c,input.allocationRef),r=issued.reservation;
    const use=(await consumptions(ctx,c,input.allocationRef)).find(u=>sameAllocationRef(u.ref,input.consumptionRef));
    const observed=(await c.query(
      "SELECT e.semantic_hash,o.observation FROM finnor_os.business_effects e JOIN finnor_os.external_operations o ON o.tenant_id=e.tenant_id AND o.business_effect_id=e.id WHERE e.tenant_id=$1 AND e.id=$2 AND o.provider='finnor_closing_provider' AND o.verification_status='verified' AND o.observation->'closingEvidenceRef'->>'versionId'=$3",
      [ctx.auth.tenantId,input.effectId,input.evidenceVersionId],
    )).rows[0];
    if(!r||!use||!observed||use.effectRef?.id!==input.effectId||use.effectRef.contentDigest!==observed.semantic_hash)throw denied();
    if(use.status==='RECONCILED')return {consumption:use,reservation:r,semanticReplay:true,releaseGranted:false};
    const state=(await c.query("UPDATE finnor_os.s5_consumption_states SET status='RECONCILED',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2 RETURNING revision",[ctx.auth.tenantId,use.ref.id])).rows[0];
    const proof={effectRef:use.effectRef,evidenceVersionId:input.evidenceVersionId,observation:observed.observation,costs:{status:'UNMETERED',externalCost:null,recoveryCost:null,humanCost:null},resourceEnvelopeRetained:true,protectedReceipt:null,releaseGranted:false};
    await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'S6_SIGNED_CLOSING_OBSERVATION',$4::jsonb)",[ctx.auth.tenantId,use.ref.id,state.revision,JSON.stringify(proof)]);
    const uses=await consumptions(ctx,c,input.allocationRef);
    // A signed observation settles this original consumption, not unstarted
    // policies in the jointly reserved episode. Closing may still need its
    // original draw/payment/transfer/filing envelope after the signature settles.
    const pending=uses.some(next=>next.status!=='RECONCILED')
      ||issued.certificate.policyBindings.some(binding=>!uses.some(next=>
        sameAllocationRef(next.policyRef,binding.policyRef)&&next.status==='RECONCILED'));
    const reservationStatus=pending?'PARTIALLY_RECONCILED':'SETTLED_RETAINED';
    await c.query("UPDATE finnor_os.s5_reservations SET status=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",[ctx.auth.tenantId,r.ref.id,reservationStatus]);
    await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RECONCILIATION',use.ref.id,proof,[use.ref.id,input.evidenceVersionId],'H0')]);
    return {consumption:{...use,status:'RECONCILED' as const},reservation:{...r,status:reservationStatus},semanticReplay:false,releaseGranted:false};
  });
}

/** Consume authenticated S6 evidence under S5's existing portfolio lock. Costs and
 * released capacity are different claims: unmetered settlement retains occupation. */
export async function applyProtectedAllocationSettlement(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef;obligation:any;event:Record<string,any>;receipt:Record<string,any>}){
 return locked(ctx,async c=>{
  const issued=await finiteStored(ctx,c,input.allocationRef),r=issued.reservation,uses=await consumptions(ctx,c,input.allocationRef),use=uses.find(u=>sameAllocationRef(u.ref,input.consumptionRef));
  if(!r||r.status==='RELEASED'||!use||!sameAllocationRef(input.obligation.allocationRef,input.allocationRef)||!sameAllocationRef(input.obligation.consumptionRef,use.ref)||!sameAllocationRef(input.obligation.reservationRef,r.ref)||use.effectRef?.id!==input.obligation.effectRef.id||use.effectRef?.contentDigest!==input.obligation.effectRef.semanticHash)throw denied();
  const prior=(await c.query("SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='PROTECTED_S6_SETTLEMENT' ORDER BY revision DESC LIMIT 1",[ctx.auth.tenantId,use.ref.id])).rows[0];
  if(prior){if(prior.body.event.eventId!==input.event.eventId||!sameAllocationRef(prior.body.receipt,input.receipt))throw conflict();return {consumption:use,reservation:r,costs:prior.body.costs,releaseGranted:false as const,semanticReplay:true};}
  if(use.status==='RECONCILED')throw new AllocationContractError('BLOCKED_AUTHORITY','Reconciled consumption lacks matching protected settlement history');
  const state=(await c.query("UPDATE finnor_os.s5_consumption_states SET status='RECONCILED',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2 AND status IN ('INTENDED_PENDING_S6','UNKNOWN_OUTCOME') RETURNING revision",[ctx.auth.tenantId,use.ref.id])).rows[0];if(!state)throw denied();
  const costs={status:'UNMETERED' as const,externalCost:null,recoveryCost:null,humanCost:null,releaseSufficient:false};
  const proof={obligationRef:input.obligation.ref,event:input.event,receipt:input.receipt,costs,resourceEnvelopeRetained:true};bounded(proof);
  await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'PROTECTED_S6_SETTLEMENT',$4::jsonb)",[ctx.auth.tenantId,use.ref.id,state.revision,JSON.stringify(proof)]);
  await c.query("UPDATE finnor_os.business_effects SET status='verified',verification=$1::jsonb,observed_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3 AND semantic_hash=$4",[JSON.stringify({state:'verified',qualification:'EXACT_TARGET_FIELD_OPERATION_READBACK',settlementEventId:input.event.eventId,protectedReceipt:input.receipt,costs,causalAttributionGranted:false}),ctx.auth.tenantId,input.obligation.effectRef.id,input.obligation.effectRef.semanticHash]);
  await c.query("UPDATE finnor_os.domain_actions SET status='completed',execution_started_at=NULL WHERE tenant_id=$1 AND id=$2 AND business_effect_id=$3",[ctx.auth.tenantId,input.obligation.domainActionId,input.obligation.effectRef.id]);
  await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RECONCILIATION',use.ref.id,{obligationRef:input.obligation.ref,settlementEventId:input.event.eventId,receipt:input.receipt,qualifiedFieldSettlement:true,costs,resourceOccupationRetained:true,releaseGranted:false},[input.allocationRef.id,use.ref.id],'H0')]);
  return {consumption:{...use,status:'RECONCILED' as const},reservation:r,costs,releaseGranted:false as const,semanticReplay:false};
 });
}

export async function retainProtectedAllocationAttempt(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef;obligation:any;event:Record<string,any>;receipt:Record<string,any>}){
 return locked(ctx,async c=>{
  const issued=await finiteStored(ctx,c,input.allocationRef),r=issued.reservation,use=(await consumptions(ctx,c,input.allocationRef)).find(u=>sameAllocationRef(u.ref,input.consumptionRef));
  if(!r||r.status==='RELEASED'||!use||!sameAllocationRef(input.obligation.reservationRef,r.ref)||!sameAllocationRef(input.obligation.allocationRef,input.allocationRef)||!sameAllocationRef(input.obligation.consumptionRef,use.ref)||use.effectRef?.id!==input.obligation.effectRef.id||use.effectRef?.contentDigest!==input.obligation.effectRef.semanticHash)throw denied();
  const prior=(await c.query("SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='PROTECTED_S6_ATTEMPT' AND body->'event'->>'eventId'=$3 LIMIT 1",[ctx.auth.tenantId,use.ref.id,input.event.eventId])).rows[0];
  if(prior){if(!sameAllocationRef(prior.body.receipt,input.receipt))throw conflict();return {consumption:use,reservation:r,semanticReplay:true,releaseGranted:false as const};}
  const count=(await c.query("SELECT count(*)::int n FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='PROTECTED_S6_ATTEMPT'",[ctx.auth.tenantId,use.ref.id])).rows[0].n;if(count>=64)throw new AllocationContractError('LIMIT_EXCEEDED','Protected member attempt accounting bound exceeded');
  let reservation=r;
  if(use.status!=='RECONCILED'&&!['UNKNOWN_OUTCOME','SETTLED_RETAINED'].includes(r.status)){
   await c.query("UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",[ctx.auth.tenantId,r.ref.id]);reservation={...r,status:'UNKNOWN_OUTCOME',revision:r.revision+1};
  }
  const state=(await c.query("UPDATE finnor_os.s5_consumption_states SET status=CASE WHEN status='RECONCILED' THEN status ELSE 'UNKNOWN_OUTCOME' END,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2 RETURNING revision,status",[ctx.auth.tenantId,use.ref.id])).rows[0];if(!state)throw denied();
  const proof={obligationRef:input.obligation.ref,event:input.event,receipt:input.receipt,resourceEnvelopeRetained:true,qualifiedActualConsumption:null,qualifiedSettlement:null,costs:{status:'UNMETERED'},reservationTransition:{schema:'finnor.s5.retained-attempt-transition.v1',reservationRef:r.ref,before:{revision:r.revision,status:r.status,envelopes:r.envelopes},after:{revision:reservation.revision,status:reservation.status,envelopes:reservation.envelopes},consumptionEnvelope:use.envelope}};bounded(proof);
  await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'PROTECTED_S6_ATTEMPT',$4::jsonb)",[ctx.auth.tenantId,use.ref.id,state.revision,JSON.stringify(proof)]);
  await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RECONCILIATION',use.ref.id,{obligationRef:input.obligation.ref,attemptEventId:input.event.eventId,receipt:input.receipt,resourceOccupationRetained:true,qualifiedActualConsumption:null,qualifiedSettlement:null},[input.allocationRef.id,use.ref.id],'H0')]);
  return {consumption:{...use,status:state.status},reservation,semanticReplay:false,releaseGranted:false as const};
 });
}

export interface GovernedResourceUnitRequest {requestRef:ExperimentRef;memberId:string;phase:'EXECUTION'|'RECOVERY'|'HUMAN';ordinal:number;units:number}
async function governedBudgetSnapshot(ctx:PeMutationContext,c:pg.PoolClient,obligation:DurableObligation){
 await authorize(ctx,c);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);
 const row=(await c.query(`SELECT p.problem,p.certificate,r.status,r.envelopes,co.body AS consumption
  FROM finnor_os.s5_proposals p JOIN finnor_os.s5_reservations r ON r.tenant_id=p.tenant_id AND r.allocation_digest=p.content_digest
  JOIN finnor_os.s5_consumptions co ON co.tenant_id=r.tenant_id AND co.reservation_id=r.reservation_id
  WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.content_digest=$3 AND r.reservation_id=$4 AND co.consumption_id=$5 AND co.principal_id=$2 FOR UPDATE OF r`,
  [ctx.auth.tenantId,actor(ctx),obligation.allocationRef.contentDigest,obligation.reservationRef.id,obligation.consumptionRef.id])).rows[0];
 if(!row||row.status==='RELEASED'||!sameAllocationRef(row.certificate.ref,obligation.allocationRef)||!sameAllocationRef(row.consumption.ref,obligation.consumptionRef)||!sameAllocationRef(row.envelopes,obligation.resourceEnvelope))throw denied();
 const records=(await c.query('SELECT * FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY created_at,charge_key LIMIT 513',[ctx.auth.tenantId,obligation.reservationRef.id])).rows;
 if(records.length>512)throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_RECORD_BOUND');
 const origins=(await c.query('SELECT o.body FROM finnor_os.s6_obligation_origins o JOIN finnor_os.s5_consumptions co ON co.tenant_id=o.tenant_id AND co.consumption_id=o.consumption_id WHERE o.tenant_id=$1 AND o.principal_id=$2 AND co.reservation_id=$3 LIMIT 257',[ctx.auth.tenantId,actor(ctx),obligation.reservationRef.id])).rows.map(r=>r.body as DurableObligation);
 if(origins.length>256)throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_RECORD_BOUND');
 const charges:Array<{resource_id:string;unit:string;used:string}>=[];
 for(const record of records){
  const charge=record.body,{ref,...preimage}=charge,native=origins.find(origin=>sameAllocationRef(origin.ref,charge.obligationRef)),resource=row.problem.resources.find((r:AllocationResource)=>r.resourceId===record.resource_id&&r.unit===record.unit),units=Number(record.units);
  const reject=()=>{throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_HISTORY_INCONSISTENT');};
  if(!native||!resource||record.principal_id!==actor(ctx)||charge.schema!=='finnor.s5.governed-resource-charge.v1'||charge.semanticOwner!=='S5'||charge.tenantId!==ctx.auth.tenantId||charge.principalId!==actor(ctx)||!sameAllocationRef(ref,allocationRef('S5','allocation-governed-charge',preimage))||!sameAllocationRef(charge.allocationRef,obligation.allocationRef)||!sameAllocationRef(charge.reservationRef,obligation.reservationRef)||!sameAllocationRef(charge.consumptionRef,native.consumptionRef)||record.consumption_id!==charge.consumptionRef.id||record.charge_key!==charge.chargeKey||record.request_digest!==charge.requestDigest||record.phase!==charge.phase||record.resource_id!==charge.resourceId||record.unit!==charge.unit||units!==charge.units||charge.costs?.money!==null||charge.costs?.status!=='UNMETERED'||charge.costs?.releaseSufficient!==false)reject();
  if(!native||!resource)throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_HISTORY_INCONSISTENT');
  const request={requestRef:charge.requestRef,memberId:charge.memberId,phase:charge.phase,ordinal:charge.ordinal,units:charge.units};
  if(!['EXECUTION','RECOVERY','HUMAN'].includes(charge.phase)||!Number.isSafeInteger(charge.ordinal)||charge.ordinal<1||charge.ordinal>64||!Number.isSafeInteger(units)||units<1||units>100000||charge.phase==='EXECUTION'&&charge.ordinal!==1||resource.resourceClass!==(charge.phase==='HUMAN'?'HUMAN_ATTENTION':'COMPUTE')||resource.unit!==(charge.phase==='HUMAN'?'seconds':'request')||!native.intervention.channels.some(channel=>charge.memberId===`request-member:${epistemicHash([native.ref,channel.exposureId])}`)||charge.requestRef?.owner!=='S6'||charge.requestRef?.version!=='s6-conditional-json-v1'||charge.requestRef?.id!==`request-ir:${charge.requestRef?.contentDigest}`||charge.chargeKey!=='s6-unit:'+epistemicHash([native.ref,charge.requestRef,charge.memberId,charge.phase,charge.ordinal])||charge.requestDigest!==epistemicHash({...request,obligationRef:native.ref,allocationRef:native.allocationRef,consumptionRef:native.consumptionRef}))reject();
  let accumulated=charges.find(v=>v.resource_id===record.resource_id&&v.unit===record.unit);if(!accumulated){accumulated={resource_id:record.resource_id,unit:record.unit,used:'0'};charges.push(accumulated);}
  accumulated.used=allocationDecimal(allocationQuantity(accumulated.used).add(allocationQuantity(String(units))));
  if(charge.usedAfter!==accumulated.used)reject();
 }
 const budgets=row.problem.resources.filter((resource:AllocationResource)=>['COMPUTE','HUMAN_ATTENTION'].includes(resource.resourceClass)).map((resource:AllocationResource)=>{
  const envelope=obligation.resourceEnvelope.find(e=>e.resourceId===resource.resourceId&&e.unit===resource.unit);
  // Registered cumulative units share one retained upper bound across all members,
  // recovery processes and operator claims; no per-child or per-restart allowance.
  const limit=envelope?.kind==='CUMULATIVE_EXPENDITURE'?envelope.quantities.reduce((a,b)=>allocationQuantity(a).compare(allocationQuantity(b))>=0?a:b,'0'):'0';
  const used=charges.find((v:any)=>v.resource_id===resource.resourceId&&v.unit===resource.unit)?.used??'0';
  return {resourceId:resource.resourceId,resourceClass:resource.resourceClass,unit:resource.unit,limit,used,remaining:allocationDecimal(allocationQuantity(limit).sub(allocationQuantity(used)))};
 });
 return {row,budgets};
}
export async function readS5GovernedBudgets(ctx:PeMutationContext,obligation:DurableObligation){
 return withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
  const {budgets}=await governedBudgetSnapshot(ctx,c,obligation);
  return {schema:'finnor.s5.governed-resource-status.v1',obligationRef:obligation.ref,allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef,reservationRef:obligation.reservationRef,budgets,costs:{money:null,status:'UNMETERED',billingBound:'UNKNOWN',releaseSufficient:false},resourceReleaseOwner:'S5',executionAuthorityGranted:false};
 });
}
/** Reserve before possible work. Units are conservative occupation, not billing or
 * proof a physical request happened. Interrupted claims retain the same units. */
export async function recordS5GovernedResourceUnits(ctx:PeMutationContext,obligation:DurableObligation,input:GovernedResourceUnitRequest){
 if(!['EXECUTION','RECOVERY','HUMAN'].includes(input.phase)||!Number.isSafeInteger(input.ordinal)||input.ordinal<1||input.ordinal>64||!Number.isSafeInteger(input.units)||input.units<1||input.units>100000)throw new LedgerFault(400,'S5_EXECUTION_RESOURCE_UNITS_INVALID');
 const requestDigest=epistemicHash({...input,obligationRef:obligation.ref,allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef});
 const chargeKey='s6-unit:'+epistemicHash([obligation.ref,input.requestRef,input.memberId,input.phase,input.ordinal]);
 return withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
  const {row,budgets}=await governedBudgetSnapshot(ctx,c,obligation);
  const prior=(await c.query('SELECT request_digest,body FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3',[ctx.auth.tenantId,obligation.reservationRef.id,chargeKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)throw conflict();return {charge:prior.body,semanticReplay:true};}
  const resourceClass=input.phase==='HUMAN'?'HUMAN_ATTENTION':'COMPUTE',unit=input.phase==='HUMAN'?'seconds':'request';
  const eligible=budgets.filter((b:any)=>b.resourceClass===resourceClass&&b.unit===unit&&allocationQuantity(b.limit).compare(allocationQuantity('0'))>0);
  if(eligible.length!==1)throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_UNFUNDED_OR_AMBIGUOUS');
  const budget=eligible[0];if(allocationQuantity(String(input.units)).compare(allocationQuantity(budget.remaining))>0)throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_BUDGET_EXHAUSTED');
  const count=(await c.query('SELECT count(*)::int n FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,obligation.reservationRef.id])).rows[0].n;
  if(count>=512)throw new LedgerFault(409,'S5_EXECUTION_RESOURCE_RECORD_BOUND');
  const body={schema:'finnor.s5.governed-resource-charge.v1',semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx),knowledgeAt:new Date().toISOString(),obligationRef:obligation.ref,allocationRef:obligation.allocationRef,reservationRef:obligation.reservationRef,consumptionRef:obligation.consumptionRef,chargeKey,requestDigest,...input,resourceId:budget.resourceId,unit,limit:budget.limit,usedAfter:allocationDecimal(allocationQuantity(budget.used).add(allocationQuantity(String(input.units)))),qualification:input.phase==='HUMAN'?'AUTHENTICATED_OPERATOR_DECLARED_SECONDS_NOT_DEVICE_MEASUREMENT':'PRE_WORK_RESERVED_UNITS_NOT_PROVIDER_BILLING_OR_CONFIRMED_EGRESS',costs:{money:null,status:'UNMETERED',releaseSufficient:false},protectedReceipt:null,executionAuthorityGranted:false};
  const charge={...body,ref:allocationRef('S5','allocation-governed-charge',body)};
  await c.query('INSERT INTO finnor_os.s5_governed_resource_charges(tenant_id,principal_id,reservation_id,consumption_id,charge_key,phase,resource_id,unit,units,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',[ctx.auth.tenantId,actor(ctx),obligation.reservationRef.id,obligation.consumptionRef.id,chargeKey,input.phase,budget.resourceId,unit,input.units,requestDigest,JSON.stringify(charge)]);
  await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},{kind:'REFERENCE',identity:charge.ref.id,payload:{reference:{...charge.ref,content:body},rightsRefs:[obligation.rightsRef]}});
  await appendExperience(ctx,c,[prepareS5Experience(row.problem.mandate,'COST',charge.ref.id,{chargeRef:charge.ref,charge,conservativeOccupation:true,releaseGranted:false},[obligation.allocationRef.id,obligation.consumptionRef.id])]);
  return {charge,semanticReplay:false};
 });
}

/** Versioned original owners use the canonical portfolio lock and SQL snapshot. */
export async function withCanonicalAllocationSnapshot<T>(ctx:PeMutationContext,fn:(client:pg.PoolClient,value:AllocationSnapshot)=>Promise<T>):Promise<T>{
 return locked(ctx,async c=>fn(c,await snapshot(c,ctx.auth.tenantId)));
}
/** Same transaction and immutable canonical S5 event/outbox; no shadow ledger. */
export async function appendCanonicalAllocationExperience(ctx:PeMutationContext,c:pg.PoolClient,events:S5ExperienceEvent[]):Promise<void>{
 await authorize(ctx,c);await appendExperience(ctx,c,events);
}
