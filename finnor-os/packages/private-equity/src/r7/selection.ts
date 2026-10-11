import type { AllocationReservation, AllocationConsumption, ExperimentRef } from '../../../shared-types/src';
import type { PeMutationContext } from '../types';
import { principal } from '../decision-slice/adapters';
import { withCanonicalAllocationSnapshot, appendCanonicalAllocationExperience } from '../allocation-store';
import { allocationRef, prepareS5Experience } from '../../../epistemic-runtime/src/allocation-contracts';
import { atlasHash, atlasRef } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { enqueueOwnerDeliveryInTransaction } from '../../../governed-execution/src/owner-delivery-store';
import { assertDependencies } from '../evidence-execution/store';
import { r7Authorize, r7Build, r7Family, r7Parameters } from './store';
import { assertR7Owner } from './owners';
import { checkExactAllocation } from './allocation';
import { R7Error, type R7Query, type R7Selection } from './contracts';

/** Current S5 reservation/intent consumes the actual persisted S4 query, not a
 * submitted action body. All fallible S4 preparation precedes this transaction. */
export async function consumeEnterpriseExactAllocation(ctx:PeMutationContext,query:R7Query,idempotencyKey:string):Promise<R7Selection>{
  const family=await r7Family(ctx,query.familyRef),choice=query.choice;
  if(!choice||choice.ref.owner!=='S4')throw new R7Error('UNSUPPORTED','No permitted original S4 choice to consume');
  await assertR7Owner(ctx,family);
  const requestDigest=atlasHash({queryRef:query.ref,idempotencyKey}),m=family.input.source.mandate;
  return withCanonicalAllocationSnapshot(ctx,async(c,current)=>{
    await r7Authorize(ctx,c);await assertDependencies(ctx,family.input.dependencies,c,true);await assertR7Owner(ctx,family,c);
    const build=await r7Build(ctx,query.buildId,c,true),parameters=await r7Parameters(ctx,family,c);
    const head=(await c.query<{content_digest:string}>(
      'SELECT content_digest FROM finnor_os.r7_family_heads WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root_type=$4 AND root_id=$5 FOR SHARE',
      [ctx.auth.tenantId,principal(ctx),query.workId,family.root.entityType,family.root.entityId])).rows[0];
    if(!['COMPLETE','INCOMPLETE'].includes(build.status)||build.deadline_at.getTime()<=Date.now()||
      head?.content_digest!==family.ref.contentDigest||atlasHash(parameters.ref)!==atlasHash(query.parameterRef))
      throw new R7Error('STALE_INPUT','Original atlas/parameters/family fenced before current S5 use');
    const prior=(await c.query<{request_digest:string;body:AllocationConsumption;status:AllocationConsumption['status'];effect_ref:ExperimentRef|null}>(
      'SELECT co.request_digest,co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.idempotency_key=$3',
      [ctx.auth.tenantId,principal(ctx),idempotencyKey])).rows[0];
    if(prior){
      if(prior.request_digest!==requestDigest)throw new R7Error('CONFLICT','Exact S5 semantic key differs');
      const reserved=(await c.query<{body:AllocationReservation;status:AllocationReservation['status'];revision:number;revocation_reason:string|null}>(
        'SELECT o.body,s.status,s.revision,s.revocation_reason FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.reservation_id=$2',
        [ctx.auth.tenantId,prior.body.reservationRef.id])).rows[0]!;
      return {choice,reservation:{...reserved.body,status:reserved.status,revision:reserved.revision,revocationReason:reserved.revocation_reason},
        consumption:{...prior.body,status:prior.status,effectRef:prior.effect_ref},qualification:'ORDINARY_CURRENT_EXACT_S4_S5_INTENT_NOT_EFFECT_AUTHORITY',executionAuthorityGranted:false};
    }
    if(current.outstanding.length>=256)throw new R7Error('LIMIT_EXCEEDED','Canonical live commitment registry full');
    if(current.snapshotDigest!==query.resourceSnapshotDigest)throw new R7Error('STALE_INPUT','Canonical commitments changed after lookup; current full-family query required');
    const check=checkExactAllocation(family.input.source,current,choice.policyId,choice.parameters,family.root);
    if(!check.feasible||atlasHash(check.envelopes)!==atlasHash(choice.exactDemand))throw new R7Error('STALE_INPUT','Actual current S5 exact check rejects original demand');
    // Lock parameter head during consumption to make a racing owner edit wait.
    const parameterHead=(await c.query<{content_digest:string}>(
      'SELECT content_digest FROM finnor_os.r7_parameter_heads WHERE tenant_id=$1 AND principal_id=$2 AND family_digest=$3 FOR SHARE',
      [ctx.auth.tenantId,principal(ctx),family.ref.contentDigest])).rows[0];
    if(parameterHead?.content_digest!==parameters.ref.contentDigest)throw new R7Error('STALE_INPUT');
    const preparationBody={choiceRef:choice.ref,queryRef:query.ref,plannedConsumptionKey:idempotencyKey,
      originalPolicyRef:choice.originalPolicyRef,mandateRef:m.ref,executionAuthorityGranted:false},
      preparationRef=atlasRef('S4','exact-handoff-preparation',preparationBody);
    await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S4',tenantId:ctx.auth.tenantId,principalId:principal(ctx)},
      {kind:'REFERENCE',identity:preparationRef.id,payload:{reference:{...preparationRef,content:preparationBody},rightsRefs:[m.rightsRef]}});
    const problemBody={schema:'finnor.s5.exact-affine-problem.v1',tenantId:ctx.auth.tenantId,principalId:principal(ctx),mandate:m,
      sourceRef:family.input.sourceRef,originalPolicyRef:choice.originalPolicyRef,choiceRef:choice.ref,queryRef:query.ref,
      resources:current.resources,outstanding:current.outstanding,snapshotDigest:current.snapshotDigest,parameters:choice.parameters},
      problem={...problemBody,ref:atlasRef('S5','exact-allocation-problem',problemBody)},
      certificateBody={schema:'finnor.s5.exact-affine-certificate.v1',version:'r7-exact-affine-v1',tenantId:ctx.auth.tenantId,principalId:principal(ctx),
        mandateRef:m.ref,rightsRef:m.rightsRef,policyBindings:check.policyBindings,problemRef:problem.ref,check,
        snapshotDigest:current.snapshotDigest,validUntil:m.validUntil,executionAuthorityGranted:false,protectedReceipt:null},
      certificate={...certificateBody,ref:atlasRef('S5','exact-allocation-certificate',certificateBody)};
    if(Buffer.byteLength(JSON.stringify({problem,certificate}))>8388608)throw new R7Error('LIMIT_EXCEEDED','Canonical S5 proposal exceeds original 8 MiB bound');
    await c.query('INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',
      [ctx.auth.tenantId,principal(ctx),certificate.ref.contentDigest,JSON.stringify(problem),JSON.stringify(certificate)]);
    const rBody:Omit<AllocationReservation,'ref'>={schema:'finnor.allocation-reservation.v1',certificateRef:certificate.ref,tenantId:ctx.auth.tenantId,
      principalId:principal(ctx),idempotencyKey,requestDigest,createdAt:new Date().toISOString(),envelopes:check.envelopes,
      status:'RESERVED',revocationReason:null,revision:1,executionAuthorityGranted:false,protectedReceipt:null},
      reservation:AllocationReservation={...rBody,ref:allocationRef('S5','allocation-reservation',rBody)};
    await c.query('INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',
      [ctx.auth.tenantId,principal(ctx),reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(reservation)]);
    await c.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,'RESERVED',$4::jsonb)",
      [ctx.auth.tenantId,reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(check.envelopes)]);
    const cBody:Omit<AllocationConsumption,'ref'>={schema:'finnor.allocation-consumption.v1',reservationRef:reservation.ref,certificateRef:certificate.ref,
      policyRef:choice.originalPolicyRef,demandDigest:atlasHash(choice.exactDemand),nodeId:choice.nodeId,decisionRef:choice.ref,
      idempotencyKey,requestDigest,createdAt:new Date().toISOString(),status:'INTENDED_PENDING_S6',
      compatibleScenarioIds:family.input.source.worlds.map(w=>w.id),effectRef:null,envelope:check.envelopes,
      executionAuthorityGranted:false,protectedReceipt:null},
      consumption:AllocationConsumption={...cBody,ref:allocationRef('S5','allocation-consumption',cBody)};
    await c.query('INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [ctx.auth.tenantId,principal(ctx),consumption.ref.id,reservation.ref.id,choice.originalPolicyRef.id,choice.nodeId,idempotencyKey,requestDigest,JSON.stringify(consumption)]);
    await c.query("INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,'INTENDED_PENDING_S6',1)",
      [ctx.auth.tenantId,consumption.ref.id]);
    await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
      [ctx.auth.tenantId,reservation.ref.id]);
    for(const record of [choice,problem,certificate,reservation,consumption]){
      const {ref,...content}=record;const owner=record===choice?'S4':'S5';
      await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:owner,tenantId:ctx.auth.tenantId,principalId:principal(ctx)},
        {kind:'REFERENCE',identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[m.rightsRef]}});
    }
    await appendCanonicalAllocationExperience(ctx,c,[
      prepareS5Experience(m,'RESERVATION',reservation.ref.id,{reservation,version:'r7-exact-affine-v1'},[certificate.ref.id],'H0'),
      prepareS5Experience(m,'CONSUMPTION',consumption.ref.id,{consumption,actualConsumption:'UNKNOWN_PENDING_QUALIFIED_S6_ENFORCEMENT',
        responsibilityRetained:true,preparationRef},[choice.ref.id,reservation.ref.id],'H0')]);
    return {choice,reservation:{...reservation,status:'CONSUMPTION_PENDING',revision:2},consumption,
      qualification:'ORDINARY_CURRENT_EXACT_S4_S5_INTENT_NOT_EFFECT_AUTHORITY',executionAuthorityGranted:false};
  });
}
