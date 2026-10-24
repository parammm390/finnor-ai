/** S5 specialization: partition and substitute rights inside one original
 * accountable envelope. No balance ledger, FX, capacity creation or release. */
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {evaluateAuthorityTx,canExerciseAuthorityTx} from '@finnor/authority';
import type {AllocationResource,AllocationEnvelope} from '@finnor/shared-types';
import type {PeMutationContext} from './types';
import {allocationSnapshotInTransaction,withS5PortfolioTransaction as transaction} from './allocation-store';
import {validateBeliefViewPin} from './enterprise-beliefs';
import {enqueueOwnerDeliveryInTransaction} from '../../governed-execution/src/owner-delivery-store';
import {economicSemanticModuleTx} from './program-synthesis/economic-module';
import {principal,developmentOnly,chargeOwnerStorageTx} from './economic-action-theory/store';
import {RefSchema,QuantityValue,digest,reference,same,fail,type EconomicRef,type State,type EconomicProblem} from './economic-action-theory/contracts';
import {exact,decimal,safe} from './economic-action-theory/finite';
export const EconomicReservationSchema=z.object({theoryId:z.string().uuid(),initialState:z.record(z.string(), QuantityValue),
 bindings:z.array(z.object({quantityId:z.string(),resourceRef:RefSchema}).strict()).min(1).max(6),
 idempotencyKey:z.string().min(1).max(128)}).strict();
export interface EconomicReservation {
 certificate:{ref:EconomicRef;schema:string;tenantId:string;principalId:string;theoryId:string;theoryRef:EconomicRef;
  rightsRef:string;root:{entityType:string;entityId:string};workId:string;validUntil:string;resourceRefs:EconomicRef[];
  policyBindings:Array<{policyRef:EconomicRef;demandDigest:string}>;check:{envelopes:AllocationEnvelope[];exactResourceCheck:true}};
 origin:{ref:EconomicRef;certificateRef:EconomicRef;tenantId:string;principalId:string;createdAt:string;
  envelopes:AllocationEnvelope[];economicState:{theoryId:string;bindings:Array<{quantityId:string;resourceId:string}>;state:State};
  executionAuthorityGranted:false;protectedReceipt:null};
 revision:number;status:string;revocationReason:string|null;resources:AllocationResource[];
 economicState:EconomicReservation['origin']['economicState'];
}
const amount=(value:string)=>exact(QuantityValue.parse(value));
export async function commitS5EconomicReferenceTx(ctx:PeMutationContext,c:PoolClient,value:{ref:EconomicRef},rightsRef:string){
 const {ref,...content}=value;
 if(ref.contentDigest!==digest(content))fail('S5_ECONOMIC_OWNER_PREIMAGE');
 await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:principal(ctx)},
  {kind:'REFERENCE',identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[rightsRef]}});
}
export async function readEconomicReservationTx(ctx:PeMutationContext,c:PoolClient,ref:EconomicRef,recovery=false):Promise<EconomicReservation>{
 if(ref.owner!=='S5'||ref.version!=='economic-action-theory-v1'||!ref.id.startsWith('economic-rights-reservation:'))fail('S5_ECONOMIC_RESERVATION_DOMAIN');
 const row=(await c.query<{certificate:EconomicReservation['certificate'];problem:{resources:AllocationResource[]};
  origin:EconomicReservation['origin'];revision:number;status:string;revocation_reason:string|null;economic_state:EconomicReservation['economicState']}>(
  `SELECT p.problem,p.certificate,o.body origin,r.revision,r.status,r.revocation_reason,r.economic_state
   FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations r USING(tenant_id,reservation_id)
   JOIN finnor_os.s5_proposals p ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
   WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.reservation_id=$3 FOR UPDATE OF r`,
  [ctx.auth.tenantId,principal(ctx),ref.id])).rows[0];
 if(!row||!same(row.origin.ref,ref))fail('S5_ECONOMIC_RESERVATION_UNAVAILABLE',404);
 const {ref:originRef,...origin}=row.origin,{ref:certRef,...cert}=row.certificate;
 if(originRef.contentDigest!==digest(origin)||certRef.contentDigest!==digest(cert)||!same(origin.certificateRef,certRef)||
  row.certificate.tenantId!==ctx.auth.tenantId||row.certificate.principalId!==principal(ctx)||
  !same(row.economic_state.bindings,row.origin.economicState.bindings)||row.economic_state.theoryId!==row.certificate.theoryId)
  fail('S5_ECONOMIC_RESERVATION_PREIMAGE');
 if(row.status==='RELEASED'||!recovery&&(row.revocation_reason||Date.parse(row.certificate.validUntil)<=Date.now()))fail('S5_ECONOMIC_RESERVATION_NOT_CURRENT');
 if(!recovery)for(const resource of row.problem.resources){
  const current=(await c.query<{body:AllocationResource}>('SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 AND r.resource_id=$2',[ctx.auth.tenantId,resource.resourceId])).rows[0]?.body;
  if(!current||!same(current,resource)||current.revoked||Date.parse(current.validUntil)<=Date.now())fail('S5_ECONOMIC_RESOURCE_REVISED');
  for(const pin of current.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')fail('S5_ECONOMIC_RESOURCE_SOURCE_CHANGED');
 }
 return {certificate:row.certificate,origin:row.origin,resources:row.problem.resources,revision:row.revision,status:row.status,
  revocationReason:row.revocation_reason,economicState:row.economic_state};
}
export const readEconomicReservation=(ctx:PeMutationContext,ref:EconomicRef)=>transaction(ctx,c=>readEconomicReservationTx(ctx,c,ref,true));
export function economicResourceTotals(bindings:EconomicReservation['economicState']['bindings'],state:State){
 const result=new Map<string,bigint>();
 for(const b of bindings)result.set(b.resourceId,(result.get(b.resourceId)??0n)+amount(state[b.quantityId]!));
 return result;
}
export async function reserveEconomicRights(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=EconomicReservationSchema.parse(raw);
 return transaction(ctx,async c=>{
  const {row,module}=await economicSemanticModuleTx(ctx,c,input.theoryId),problem=row.request.problem;
  const requestDigest=digest(input),key='y1-rights:'+input.idempotencyKey;
  const prior=(await c.query<{request_digest:string;allocation_digest:string}>('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),key])).rows[0];
  if(prior){
   if(prior.request_digest!==requestDigest)fail('S5_ECONOMIC_IDEMPOTENCY_CONFLICT',409);
   const old=(await c.query<{body:EconomicReservation['origin']}>('SELECT body FROM finnor_os.s5_reservation_origins WHERE tenant_id=$1 AND principal_id=$2 AND allocation_digest=$3',[ctx.auth.tenantId,principal(ctx),prior.allocation_digest])).rows[0];
   if(!old)fail('S5_ECONOMIC_ORIGINAL_ORIGIN_MISSING');
   return readEconomicReservationTx(ctx,c,old.body.ref,true);
  }
  if(!safe(problem,input.initialState)||input.bindings.length!==problem.quantities.length||
   new Set(input.bindings.map(b=>b.quantityId)).size!==input.bindings.length)fail('S5_ECONOMIC_EXACT_STATE_BINDINGS');
  const snapshot=await allocationSnapshotInTransaction(c,ctx.auth.tenantId),resources:AllocationResource[]=[],bindings:Array<{quantityId:string;resourceId:string}>=[];
  if(snapshot.outstanding.length>=256)fail('S5_ECONOMIC_PORTFOLIO_BOUND');
  for(const quantity of problem.quantities){
   const binding=input.bindings.find(b=>b.quantityId===quantity.id),resource=snapshot.resources.find(r=>same(r.ref,binding?.resourceRef));
   if(!resource||resource.ownerRef.id!==principal(ctx)||resource.kind!=='STOCK'||resource.revoked||resource.covenants.length||
    resource.unit!==quantity.unit||resource.currency!==quantity.currency||quantity.entityId!==row.root.entityId||
    !resource.permittedRoots.some(root=>same(root,row.root))||Date.parse(resource.validUntil)<row.deadline_at.getTime()||
    Date.parse(resource.horizon.startAt)>Date.now()||Date.parse(resource.horizon.startAt)+resource.horizon.periodMs*resource.horizon.periods<row.deadline_at.getTime()||
    quantity.period.startAt!==resource.horizon.startAt||Date.parse(quantity.period.endAt)!==Date.parse(resource.horizon.startAt)+resource.horizon.periodMs*resource.horizon.periods)
    fail('S5_ECONOMIC_EXACT_RESOURCE_DOMAIN');
   if(!await canExerciseAuthorityTx(ctx.auth,{operation:'query',capability:'query:allocation_resources',
    resource:{type:'allocation_resource',id:resource.scopeRef.id},risk:'low'},c))fail('S5_ECONOMIC_RESOURCE_AUTHORITY',403);
   for(const pin of resource.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')fail('S5_ECONOMIC_RESOURCE_SOURCE_CHANGED');
   if(!resources.some(r=>r.resourceId===resource.resourceId))resources.push(resource);
   bindings.push({quantityId:quantity.id,resourceId:resource.resourceId});
  }
  if(snapshot.resources.some(r=>r.covenants.some(cv=>cv.terms.some(t=>resources.some(selected=>selected.resourceId===t.resourceId)))))
   fail('S5_ECONOMIC_CROSS_RESOURCE_COVENANT_UNSUPPORTED');
  const totals=economicResourceTotals(bindings,input.initialState),envelopes:AllocationEnvelope[]=[];
  for(const resource of resources){
   let existing=0n;
   const total=totals.get(resource.resourceId)!;if(total<=0n)fail('S5_ECONOMIC_NONVACUOUS_RESERVATION');
   if(resource.availability.length!==resource.horizon.periods+1||resource.existingUse.length!==resource.availability.length)fail('S5_ECONOMIC_CAPACITY_COVERAGE');
   for(let period=0;period<resource.availability.length;period++){
    const available=resource.availability[period]!;
    if(available.basis!=='REPORTED_AVAILABLE'||available.amount===null)fail('S5_ECONOMIC_CAPACITY_UNKNOWN');
    existing+=amount(resource.existingUse[period]!);let held=0n;
    for(const outstanding of snapshot.outstanding)for(const e of outstanding.envelopes.filter(e=>e.resourceId===resource.resourceId)){
     if(e.kind!==resource.kind||e.unit!==resource.unit||!same(e.horizon,resource.horizon)||e.quantities.length!==resource.availability.length)fail('S5_ECONOMIC_OUTSTANDING_DOMAIN_UNSUPPORTED');
     held+=e.quantities.slice(0,period+1).reduce((sum,value)=>sum+amount(value),0n);
    }
    if(total+held+existing+amount(resource.safetyMargin)>amount(available.amount))fail('S5_ECONOMIC_SHARED_CAPACITY_EXHAUSTED',409);
   }
   envelopes.push({resourceId:resource.resourceId,unit:resource.unit,kind:resource.kind,horizon:resource.horizon,
    quantities:[decimal(total),...Array(resource.horizon.periods).fill('0')],
    minimumQuantities:[decimal(total),...Array(resource.horizon.periods).fill('0')]});
  }
  const exactAmountUsd=decimal(resources.reduce((sum,r)=>sum+(r.currency==='USD'?totals.get(r.resourceId)!:0n),0n));
  if(resources.some(r=>r.currency!==null&&r.currency!=='USD'))fail('S5_ECONOMIC_AUTHORITY_FX_UNSUPPORTED');
  const authority=await evaluateAuthorityTx(ctx.auth,{operation:'action',capability:'action:allocate_resource',
   resources:resources.map(r=>({type:'allocation_resource',id:r.scopeRef.id})),risk:'high',exactAmountUsd},c);
  if(authority.outcome!=='allowed')fail('S5_ECONOMIC_CURRENT_ALLOCATION_AUTHORITY_REQUIRED',403);
  const problemBody={schema:'finnor.s5.economic-rights-problem.v1',resources,initialState:input.initialState,bindings,theoryRef:row.artifact!.envelope.contentRef};
  const certBody={schema:'finnor.s5.economic-rights-allocation.v1',tenantId:row.tenant_id,principalId:row.principal_id,
   theoryId:row.id,theoryRef:row.artifact!.envelope.contentRef,rightsRef:'S1:'+row.rights_revision,root:row.root,workId:row.work_id,
   validUntil:row.deadline_at.toISOString(),resourceRefs:resources.map(r=>r.ref),policyBindings:[{policyRef:module.ref,demandDigest:digest(envelopes)}],
   check:{envelopes,exactResourceCheck:true as const}};
  const certificate={...certBody,ref:reference('S5','economic-rights-allocation',certBody)};
  const originBody={schema:'finnor.s5.economic-rights-reservation.v1',certificateRef:certificate.ref,tenantId:row.tenant_id,
   principalId:row.principal_id,createdAt:new Date().toISOString(),envelopes,
   economicState:{theoryId:row.id,bindings,state:input.initialState},executionAuthorityGranted:false as const,protectedReceipt:null};
  const origin={...originBody,ref:reference('S5','economic-rights-reservation',originBody)};
  await chargeOwnerStorageTx(c,row,[certificate,origin,problemBody,envelopes,origin.economicState]);
  await c.query('INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[row.tenant_id,row.principal_id,certificate.ref.contentDigest,JSON.stringify(problemBody),JSON.stringify(certificate)]);
  await c.query('INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',[row.tenant_id,row.principal_id,origin.ref.id,certificate.ref.contentDigest,JSON.stringify(origin)]);
  await c.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes,economic_state) VALUES($1,$2,$3,1,'RESERVED',$4::jsonb,$5::jsonb)",[row.tenant_id,origin.ref.id,certificate.ref.contentDigest,JSON.stringify(envelopes),JSON.stringify(origin.economicState)]);
  await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5)',[row.tenant_id,row.principal_id,key,requestDigest,certificate.ref.contentDigest]);
  await commitS5EconomicReferenceTx(ctx,c,certificate,certBody.rightsRef);await commitS5EconomicReferenceTx(ctx,c,origin,certBody.rightsRef);
  return readEconomicReservationTx(ctx,c,origin.ref);
 });
}
/** Only S6 calls this after checking its immutable native origin, current S4
 * programme, S8 admission, exact state and the original prepared consumption. */
export async function moveEconomicRightsTx(ctx:PeMutationContext,c:PoolClient,input:{
 reservationRef:EconomicRef;expectedRevision:number;before:State;after:State;problem:EconomicProblem;
 obligationRef:EconomicRef;effectRef:EconomicRef;consumptionRef:EconomicRef;
}){
 const held=await readEconomicReservationTx(ctx,c,input.reservationRef);
 if(held.revision!==input.expectedRevision||!same(held.economicState.state,input.before)||!safe(input.problem,input.after))fail('S5_ECONOMIC_TRANSITION_FENCE',409);
 const before=economicResourceTotals(held.economicState.bindings,input.before),after=economicResourceTotals(held.economicState.bindings,input.after);
 if([...before].some(([id,total])=>after.get(id)!==total))fail('S5_ECONOMIC_TOTAL_CAPACITY_MUST_NOT_CHANGE');
 const state={...held.economicState,state:input.after};
 await c.query('UPDATE finnor_os.s5_reservations SET economic_state=$3::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,input.reservationRef.id,JSON.stringify(state)]);
 await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'ECONOMIC_RIGHT_TRANSITION',$4::jsonb)",
  [ctx.auth.tenantId,input.reservationRef.id,held.revision+1,JSON.stringify({schema:'finnor.s5.economic-right-transition.v1',...input,problem:undefined,
   capacityDelta:'0',beforeTotals:Object.fromEntries([...before].map(([id,n])=>[id,decimal(n)])),afterTotals:Object.fromEntries([...after].map(([id,n])=>[id,decimal(n)])),
   accountableEnvelopeUnchanged:true})]);
 return held.revision+1;
}
