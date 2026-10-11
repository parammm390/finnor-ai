import type { AllocationConsumption } from '../../../shared-types/src';
import type { PeMutationContext } from '../types';
import { principal } from '../decision-slice/adapters';
import { projectEnterpriseExperiment } from '../enterprise-experiments';
import { assertExperimentProtocol } from '@finnor/epistemic-runtime';
import { withCanonicalAllocationSnapshot, appendCanonicalAllocationExperience } from '../allocation-store';
import { parseControlDecision } from '../../../epistemic-runtime/src/control-contracts';
import { allocationRef, prepareS5Experience } from '../../../epistemic-runtime/src/allocation-contracts';
import { atlasHash } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { enqueueOwnerDeliveryInTransaction } from '../../../governed-execution/src/owner-delivery-store';
import { readExactAllocationLocked } from './accounting';
import { checkExactAllocation } from './allocation';
import { assertR7Owner } from './owners';
import { projectR7Choice } from './projection';
import { r7Authorize, r7Build, r7Parameters, r7Tx } from './store';
import { OperationSchemas, R7Error } from './contracts';

/** Real S4 continuation of the already selected policy. S2 supplies observations;
 * S5 retains the original whole-horizon reservation. Unknown prior effects can
 * never be promoted to executed history or replayed by a new atlas. */
export async function continueEnterpriseAtlasBranch(ctx:PeMutationContext,value:unknown){
  if(process.env.FINNOR_R7_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production')
    throw new R7Error('CONFIGURATION_REQUIRED','Protected exact continuation activation is not granted');
  const request=OperationSchemas.continue.parse(value),decision=parseControlDecision(request.decision);
  const origin=await r7Tx(ctx,async c=>{
    await r7Authorize(ctx,c);const row=(await c.query<{body:AllocationConsumption}>(
      'SELECT body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3',
      [ctx.auth.tenantId,principal(ctx),request.consumptionRef.id])).rows[0];
    if(!row||atlasHash(row.body.ref)!==atlasHash(request.consumptionRef))throw new R7Error('UNAVAILABLE');return row.body;
  });
  // All S2 projection and fallible preparation happens before the short S5 lock.
  for(const observation of decision.observations){
    if(observation.availablePeriod>decision.period||Date.parse(observation.knowledgeAt)>Date.parse(decision.knowledgeAt))
      throw new R7Error('UNSUPPORTED','Observation is not yet lawful decision information');
    let matched=false;
    for(const measurement of request.measurements){
      const protocol=measurement.protocol;assertExperimentProtocol(protocol);
      const projected=await projectEnterpriseExperiment(ctx,{protocol,events:measurement.events}),r=projected.realization;
      if(!r.analysis.valid||r.unknownOutcomes.length||observation.sourceRef.owner!=='S2'||observation.sourceRef.id!==r.id||
        observation.sourceRef.contentDigest!==r.contentDigest||Date.parse(r.knowledgeAt)>Date.parse(decision.knowledgeAt))continue;
      if(protocol.id===observation.instrumentId&&protocol.metrics.observations.some(o=>
        observation.token===JSON.stringify({counts:o.counts,sampleSize:o.sampleSize,stop:o.stop})))matched=true;
    }
    if(!matched)throw new R7Error('UNSUPPORTED','Original observation requires a current actual S2 realization; unsupported temporal transports remain unresolved');
  }
  return withCanonicalAllocationSnapshot(ctx,async(c,snapshot)=>{
    const issued=await readExactAllocationLocked(ctx,c,origin.certificateRef),family=issued.family,m=family.input.source.mandate,
      policy=family.input.source.policies.find(p=>p.id===issued.query.choice!.policyId)!;
    await assertR7Owner(ctx,family,c);
    const build=await r7Build(ctx,issued.query.buildId,c,true),parameters=await r7Parameters(ctx,family,c),r=issued.reservation;
    if(!r||r.status!=='CONSUMPTION_PENDING'||r.revocationReason||!['COMPLETE','INCOMPLETE'].includes(build.status)||
      Date.now()>=build.deadline_at.getTime()||atlasHash(parameters.ref)!==atlasHash(issued.query.parameterRef)||
      decision.rightsRef!==m.rightsRef||Date.parse(decision.knowledgeAt)>Date.now()||decision.obligations.length||
      !decision.allocationRefs.some(ref=>atlasHash(ref)===atlasHash(r.certificateRef))||
      Date.parse(decision.knowledgeAt)<Date.parse(m.horizon.startAt)+decision.period*m.horizon.periodMs)
      throw new R7Error('STALE_INPUT','Original current allocation, time, parameters and obligation interpretation required');
    const matches=policy.nodes.filter(n=>n.period===decision.period&&atlasHash(n.actionHistory)===atlasHash(decision.actionHistory)&&
      atlasHash(n.observations)===atlasHash(decision.observations.map(({instrumentId,token,availablePeriod})=>({instrumentId,token,availablePeriod}))));
    if(matches.length!==1)throw new R7Error('UNSUPPORTED','Lawful original history must identify exactly one continuation node');
    const node=matches[0]!,keyDigest=atlasHash({consumptionRef:request.consumptionRef,decision,idempotencyKey:request.idempotencyKey});
    const prior=(await c.query<{body:AllocationConsumption;request_digest:string}>(
      'SELECT body,request_digest FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
    if(prior){if(prior.request_digest!==keyDigest)throw new R7Error('CONFLICT');return {consumption:prior.body,semanticReplay:true,executionAuthorityGranted:false};}
    if(issued.consumptions.some(u=>u.nodeId===node.id))throw new R7Error('CONFLICT','Original policy node already has an intent');
    for(let t=0;t<node.period;t++){
      const previous=issued.consumptions.find(u=>policy.nodes.some(n=>n.id===u.nodeId&&n.period===t&&
        atlasHash([...n.actionHistory,n.actionId])===atlasHash(node.actionHistory.slice(0,t+1))));
      const kind=policy.actions.find(a=>a.id===node.actionHistory[t])!.kind;
      if(!previous||['INTERVENE','INQUIRE'].includes(kind)&&previous.status!=='RECONCILED')
        throw new R7Error('UNSUPPORTED','Earlier action responsibility requires qualified S6 reconciliation before continuation');
    }
    const compatible=family.input.source.worlds.filter(w=>w.paths.find(p=>p.policyId===policy.id)!.nodeIds.includes(node.id)&&
      issued.consumptions.every(u=>u.compatibleScenarioIds.includes(w.id))).map(w=>w.id);
    if(!compatible.length)throw new R7Error('CHECK_FAILED','Continuation has no compatible original fixed complete world');
    const other=snapshot.outstanding.filter(o=>atlasHash(o.reservationRef)!==atlasHash(r.ref)),
      check=checkExactAllocation(family.input.source,{...snapshot,outstanding:other},policy.id,issued.query.choice!.parameters,family.root);
    if(!check.feasible||atlasHash(check.envelopes)!==atlasHash(r.envelopes))throw new R7Error('STALE_INPUT','Current exact retained reservation no longer supports continuation');
    const initial=issued.query.choice!,point={disposition:'COVERED' as const,cellId:issued.query.cellId,value:initial.robustValue,
      costs:{wallMs:0,membershipPredicates:0,fullFamilyEvaluations:0},label:{
        policies:[{policyId:policy.id,feasible:true,violatedConstraintId:null,worstWorldIds:initial.worstWorldIds,bindingConstraintIds:[]}],
        winnerPolicyId:policy.id,tiedPolicyIds:initial.tiedPolicyIds,value:null,disposition:'NAMED_FAMILY_OPTIMUM' as const}},
      choice=projectR7Choice(family,issued.query.parameterRef,initial.parameters,point,r.envelopes,node.id)!;
    const {ref:_originRef,...originBody}=origin;
    const body:Omit<AllocationConsumption,'ref'>={...originBody,nodeId:node.id,decisionRef:choice.ref,idempotencyKey:request.idempotencyKey,
      requestDigest:keyDigest,createdAt:new Date().toISOString(),compatibleScenarioIds:compatible,status:'INTENDED_PENDING_S6',effectRef:null};
    const consumption:AllocationConsumption={...body,ref:allocationRef('S5','allocation-consumption',body)};
    await c.query('INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [ctx.auth.tenantId,principal(ctx),consumption.ref.id,r.ref.id,policy.ref.id,node.id,request.idempotencyKey,keyDigest,JSON.stringify(consumption)]);
    await c.query("INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,'INTENDED_PENDING_S6',1)",
      [ctx.auth.tenantId,consumption.ref.id]);
    for(const record of [choice,consumption]){
      const {ref,...content}=record;await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:record===choice?'S4':'S5',tenantId:ctx.auth.tenantId,principalId:principal(ctx)},
        {kind:'REFERENCE',identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[m.rightsRef]}});
    }
    await appendCanonicalAllocationExperience(ctx,c,[prepareS5Experience(m,'CONSUMPTION',consumption.ref.id,
      {consumption,choice,guaranteeBasis:'ORIGINAL_WHOLE_HORIZON_NOT_NEW_CONDITIONAL_OPTIMUM',actualConsumption:'UNKNOWN_PENDING_QUALIFIED_S6_ENFORCEMENT'},
      [initial.ref.id,r.ref.id],'H0')]);
    return {choice,consumption,semanticReplay:false,guaranteeBasis:'ORIGINAL_WHOLE_HORIZON_NOT_NEW_CONDITIONAL_OPTIMUM',executionAuthorityGranted:false};
  });
}
