import type { PoolClient } from 'pg';
import type { AllocationConsumption, AllocationReservation, ExperimentRef } from '../../../shared-types/src';
import type { PeMutationContext } from '../types';
import { principal } from '../decision-slice/adapters';
import { authorizeBeliefResources, validateBeliefViewPin } from '../enterprise-beliefs';
import { withCanonicalAllocationSnapshot, appendCanonicalAllocationExperience, type AllocationSnapshot } from '../allocation-store';
import { allocationRef, prepareS5Experience } from '../../../epistemic-runtime/src/allocation-contracts';
import { atlasHash, atlasRef } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { checkExactAllocation } from './allocation';
import { r7Authorize, r7Family, r7QueryRecord } from './store';
import { assertR7Owner } from './owners';
import { R7Error, type R7AllocationCertificate, type R7AllocationProblem } from './contracts';

/** Exact schema dispatch is inside the real S5 owner and canonical portfolio
 * lock. Historical liabilities remain readable even when the atlas is stale. */
export async function readExactAllocationLocked(ctx:PeMutationContext,c:PoolClient,ref:ExperimentRef){
  await r7Authorize(ctx,c);
  if(ref.owner!=='S5'||ref.version!=='r7-exact-affine-v1'||ref.id!==`exact-allocation-certificate:${ref.contentDigest}`)
    throw new R7Error('UNAVAILABLE');
  const stored=(await c.query<{problem:R7AllocationProblem;certificate:R7AllocationCertificate}>(
    'SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',
    [ctx.auth.tenantId,principal(ctx),ref.contentDigest])).rows[0];
  if(!stored)throw new R7Error('UNAVAILABLE');
  const {ref:pr,...pb}=stored.problem,{ref:cr,...cb}=stored.certificate;
  if(pb.schema!=='finnor.s5.exact-affine-problem.v1'||cb.schema!=='finnor.s5.exact-affine-certificate.v1'||
    atlasHash(ref)!==atlasHash(cr)||atlasHash(cr)!==atlasHash(atlasRef('S5','exact-allocation-certificate',cb))||
    atlasHash(pr)!==atlasHash(atlasRef('S5','exact-allocation-problem',pb))||atlasHash(cb.problemRef)!==atlasHash(pr)||
    pb.tenantId!==ctx.auth.tenantId||pb.principalId!==principal(ctx)||cb.tenantId!==ctx.auth.tenantId||cb.principalId!==principal(ctx)||
    cb.executionAuthorityGranted!==false||cb.protectedReceipt!==null)
    throw new R7Error('CHECK_FAILED','Exact canonical S5 original binding differs');
  const query=await r7QueryRecord(ctx,pb.queryRef,c),family=await r7Family(ctx,query.familyRef,c);
  await authorizeBeliefResources(ctx,[{type:family.root.entityType,id:family.root.entityId},
    {type:'evidence_source_version',id:family.evidenceVersionId}]);
  if(!query.choice||atlasHash(query.choice.ref)!==atlasHash(pb.choiceRef)||atlasHash(pb.originalPolicyRef)!==atlasHash(query.choice.originalPolicyRef)||
    atlasHash(pb.mandate)!==atlasHash(family.input.source.mandate)||atlasHash(pb.sourceRef)!==atlasHash(family.input.sourceRef)||
    atlasHash(cb.mandateRef)!==atlasHash(pb.mandate.ref)||cb.rightsRef!==pb.mandate.rightsRef||
    pb.snapshotDigest!==atlasHash({resources:pb.resources,outstanding:pb.outstanding})||cb.snapshotDigest!==pb.snapshotDigest||
    atlasHash(checkExactAllocation(family.input.source,{resources:pb.resources,outstanding:pb.outstanding,snapshotDigest:pb.snapshotDigest},
      query.choice.policyId,pb.parameters,family.root,Date.parse(query.createdAt)))!==atlasHash(cb.check)||
    atlasHash(cb.policyBindings)!==atlasHash(cb.check.policyBindings)||!cb.check.feasible)
    throw new R7Error('CHECK_FAILED','Original exact S5 demand/check correspondence differs');
  const projected=(await c.query<{body:AllocationReservation;status:AllocationReservation['status'];envelopes:AllocationReservation['envelopes'];
    revision:number;revocation_reason:string|null}>(
    'SELECT o.body,s.status,s.envelopes,s.revision,s.revocation_reason FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.allocation_digest=$3',
    [ctx.auth.tenantId,principal(ctx),ref.contentDigest])).rows[0];
  let reservation:AllocationReservation|null=null;
  if(projected){
    const {ref:r,...body}=projected.body;
    if(atlasHash(r)!==atlasHash(allocationRef('S5','allocation-reservation',body))||
      atlasHash(body.certificateRef)!==atlasHash(ref)||atlasHash(body.envelopes)!==atlasHash(cb.check.envelopes)||
      atlasHash(projected.envelopes)!==atlasHash(body.envelopes))throw new R7Error('CHECK_FAILED','Retained S5 envelope changed');
    reservation={...projected.body,status:projected.status,envelopes:projected.envelopes,revision:projected.revision,revocationReason:projected.revocation_reason};
  }
  const rows=(await c.query<{body:AllocationConsumption;status:AllocationConsumption['status'];effect_ref:ExperimentRef|null}>(
    "SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.reservation_id=$3 ORDER BY (co.body->>'createdAt')::timestamptz,co.consumption_id LIMIT 257",
    [ctx.auth.tenantId,principal(ctx),reservation?.ref.id??''])).rows;
  if(rows.length>256)throw new R7Error('LIMIT_EXCEEDED');
  const consumptions=rows.map(row=>{
    const {ref:r,...body}=row.body;
    if(atlasHash(r)!==atlasHash(allocationRef('S5','allocation-consumption',body))||
      atlasHash(body.certificateRef)!==atlasHash(ref)||atlasHash(body.reservationRef)!==atlasHash(reservation?.ref)||
      body.executionAuthorityGranted!==false||body.protectedReceipt!==null)throw new R7Error('CHECK_FAILED','Canonical S5 consumption original differs');
    return {...row.body,status:row.status,effectRef:row.effect_ref};
  });
  return {...stored,reservation,consumptions,query,family,executionAuthorityGranted:false as const,protectedReceipt:null};
}
export const readEnterpriseExactAllocation=(ctx:PeMutationContext,ref:ExperimentRef)=>
  withCanonicalAllocationSnapshot(ctx,c=>readExactAllocationLocked(ctx,c,ref));
async function currentExact(ctx:PeMutationContext,issued:Awaited<ReturnType<typeof readExactAllocationLocked>>,snapshot:AllocationSnapshot){
  const reasons:string[]=[];
  try{await assertR7Owner(ctx,issued.family);}catch{reasons.push('ORIGINAL_FAMILY_SOURCE_RIGHTS_METHOD_CHANGED');}
  if(!issued.reservation||issued.reservation.status==='RELEASED')reasons.push('DURABLE_RESERVATION_REQUIRED');
  if(issued.reservation?.revocationReason)reasons.push(issued.reservation.revocationReason);
  if(Date.now()>=Date.parse(issued.certificate.validUntil))reasons.push('CERTIFICATE_EXPIRED_EXPOSURE_RETAINED');
  for(const r of snapshot.resources)for(const pin of r.beliefPins)
    if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')reasons.push('CURRENT_RESOURCE_SOURCE_OR_RIGHTS_CHANGED');
  const other=snapshot.outstanding.filter(o=>atlasHash(o.reservationRef)!==atlasHash(issued.reservation?.ref)),
    check=checkExactAllocation(issued.family.input.source,{...snapshot,outstanding:other},issued.query.choice!.policyId,issued.problem.parameters,issued.family.root);
  if(!check.feasible||atlasHash(check.envelopes)!==atlasHash(issued.certificate.check.envelopes))
    reasons.push(...(check.reasons.length?check.reasons:['CURRENT_EXACT_ENVELOPE_CHANGED']));
  return reasons;
}
export async function validateEnterpriseExactAllocation(ctx:PeMutationContext,ref:ExperimentRef){
  return withCanonicalAllocationSnapshot(ctx,async(c,snapshot)=>{
    const issued=await readExactAllocationLocked(ctx,c,ref),reasons=await currentExact(ctx,issued,snapshot);
    return {status:reasons.length?'STALE_INPUT':'CURRENT',reasons,allocationRef:ref,reservationRef:issued.reservation?.ref??null,
      conditionalClearance:!reasons.length,executionAuthorityGranted:false,protectedReceipt:null};
  });
}
export async function reconcileEnterpriseExactAllocation(ctx:PeMutationContext,ref:ExperimentRef){
  return withCanonicalAllocationSnapshot(ctx,async c=>{
    const issued=await readExactAllocationLocked(ctx,c,ref),r=issued.reservation;
    if(!r)throw new R7Error('UNAVAILABLE');
    if(!issued.consumptions.length||r.status==='RELEASED')return {status:'NO_HANDOFF_RECORDED',reservation:r,executionAuthorityGranted:false};
    const updated=r.status==='UNKNOWN_OUTCOME'?r:{...r,status:'UNKNOWN_OUTCOME' as const,revision:r.revision+1};
    if(r.status!=='UNKNOWN_OUTCOME')await c.query("UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
      [ctx.auth.tenantId,r.ref.id]);
    await c.query("UPDATE finnor_os.s5_consumption_states SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=ANY($2::text[]) AND status='INTENDED_PENDING_S6'",
      [ctx.auth.tenantId,issued.consumptions.map(u=>u.ref.id)]);
    await appendCanonicalAllocationExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RECONCILIATION',r.ref.id,
      {reservation:updated,exposureRetained:true,qualifiedSettlement:null,requiredOwner:'S6',version:'r7-exact-affine-v1'},[ref.id],'H0')]);
    return {status:'UNKNOWN_OUTCOME_RETAINED',reservation:updated,qualifiedActualConsumption:null,qualifiedSettlement:null,requiredOwner:'S6',executionAuthorityGranted:false};
  });
}
export async function releaseEnterpriseExactAllocation(ctx:PeMutationContext,ref:ExperimentRef){
  return withCanonicalAllocationSnapshot(ctx,async c=>{
    const issued=await readExactAllocationLocked(ctx,c,ref),r=issued.reservation;
    if(!r)throw new R7Error('UNAVAILABLE');
    if(issued.consumptions.length)throw new R7Error('UNSUPPORTED','Pending or UNKNOWN exact intent requires qualified S6 reconciliation; occupation retained');
    throw new R7Error('UNSUPPORTED','Exact initial consumption atomically prepares intent; no untouched reservation is issued');
  });
}
