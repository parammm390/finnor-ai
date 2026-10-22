/** S4 composes independently checked economic operators against the current
 * canonical S5 state, then persists an immutable native Work programme. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from './types';
import {authorize} from './owner-context';
import {economicSemanticModuleTx} from './program-synthesis/economic-module';
import {selectEconomicProgrammePlanTx} from './program-synthesis/economic-plan';
import type {EconomicStep} from './program-synthesis/economic-native';
import {readEconomicReservationTx,economicResourceTotals} from './economic-allocation';
import {withS5PortfolioTransaction as transaction} from './allocation-store';
import {principal,developmentOnly,eventTx,theoryTx} from './economic-action-theory/store';
import {PROFILE,RefSchema,QuantityValue,digest,reference,same,fail,type EconomicRef,type State} from './economic-action-theory/contracts';
import {applyOperator,inDomain,safe} from './economic-action-theory/finite';
export const EconomicProgrammeSchema=z.object({theoryId:z.string().uuid(),reservationRef:RefSchema,expectedRevision:z.number().int().positive(),
 goalState:z.record(QuantityValue),parameters:z.record(QuantityValue),idempotencyKey:z.string().min(1).max(128)}).strict();
export interface EconomicProgramme {
 schema:'finnor.s4.economic-programme.v1';ref:EconomicRef;id:string;tenantId:string;principalId:string;theoryId:string;
 theoryRef:EconomicRef;moduleRef:EconomicRef;admissionRef:EconomicRef;workId:string;workInputId:string;episodeId:string;
 planRevisionId:string;root:{entityType:string;entityId:string};reservationRef:EconomicRef;initialRevision:number;initialState:State;goalState:State;
 steps:Array<EconomicStep&{planNodeId:string}>;rightsRevision:string;validUntil:string;createdAt:string;
 externalEffects:false;executionAuthorityGranted:false;
}
export async function programmeTx(ctx:PeMutationContext,c:PoolClient,id:string,current=true){
 const found=(await c.query<{body:EconomicProgramme}>('SELECT body FROM finnor_os.s4_economic_programmes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
  [ctx.auth.tenantId,principal(ctx),id])).rows[0]?.body;
 if(!found)fail('S4_ECONOMIC_PROGRAMME_UNAVAILABLE',404);
 const {ref,...body}=found;
 if(!same(ref,reference('S4','economic-programme',body))||body.tenantId!==ctx.auth.tenantId||body.principalId!==principal(ctx))fail('S4_ECONOMIC_PROGRAMME_PREIMAGE');
 await authorize(ctx,found.root as Parameters<typeof authorize>[1],[{type:'work',id:found.workId}],[],c);
 if(current){
  const {row,module,admission}=await economicSemanticModuleTx(ctx,c,body.theoryId);
  if(!same(module.ref,body.moduleRef)||!same(row.artifact!.envelope.contentRef,body.theoryRef)||!same(admission.ref,body.admissionRef)||
   row.work_input_id!==body.workInputId||row.episode_id!==body.episodeId||Date.parse(body.validUntil)<=Date.now())fail('S4_ECONOMIC_PROGRAMME_CURRENTNESS');
  const plan=await c.query(`SELECT id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2
   AND id=$3 AND work_input_id=$4 AND status='active' FOR SHARE`,
   [body.tenantId,body.workId,body.planRevisionId,body.workInputId]);
  if(plan.rowCount!==1)fail('S4_ECONOMIC_SELECTED_PLAN_NOT_CURRENT');
 }
 return found;
}
export async function createEconomicProgramme(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=EconomicProgrammeSchema.parse(raw);
 return transaction(ctx,async c=>{
  const hash=digest(input),prior=(await c.query<{id:string;request_digest:string}>('SELECT id,request_digest FROM finnor_os.s4_economic_programmes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==hash)fail('S4_ECONOMIC_IDEMPOTENCY_CONFLICT',409);return programmeTx(ctx,c,prior.id);}
  const {row,module,admission}=await economicSemanticModuleTx(ctx,c,input.theoryId),problem=row.request.problem,
   held=await readEconomicReservationTx(ctx,c,input.reservationRef);
  if(held.revision!==input.expectedRevision||held.certificate.theoryId!==row.id||!same(held.certificate.theoryRef,row.artifact!.envelope.contentRef))
   fail('S4_ECONOMIC_EXACT_RESERVATION_REQUIRED',409);
  if(!safe(problem,input.goalState)||!inDomain(input.parameters,problem.parameters))fail('S4_ECONOMIC_GOAL_OR_PARAMETER_DOMAIN');
  if(same(input.goalState,held.economicState.state))fail('S4_ECONOMIC_GOAL_ALREADY_OBSERVED');
  const pending=(await c.query(`SELECT 1 FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
   WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND st.status<>'RECONCILED' LIMIT 1`,[row.tenant_id,input.reservationRef.id])).rows[0];
  if(pending)fail('S4_ECONOMIC_UNRESOLVED_RESPONSIBILITY_RETAINED');
  const start=held.economicState.state,queue:Array<{state:State;steps:EconomicStep[]}>=[{state:start,steps:[]}],seen=new Set([digest(start)]);
  let selected:EconomicStep[]|undefined,expansions=0,depthBound=false;
  while(queue.length){
   const next=queue.shift()!;if(++expansions>PROFILE.maxStateProduct)fail('S4_ECONOMIC_FINITE_SEARCH_BOUND');
   if(next.steps.length>=PROFILE.maxProgrammeSteps){depthBound=true;continue;}
   for(const operator of module.body.operators){
    if(operator.requirements.some(r=>r.kind==='AUTHORITY'&&r.subjectId!==row.root.entityId))continue;
    const after=applyOperator(problem,operator,next.state,input.parameters);if(!after)continue;
    const beforeTotals=economicResourceTotals(held.economicState.bindings,next.state),afterTotals=economicResourceTotals(held.economicState.bindings,after);
    if([...beforeTotals].some(([id,total])=>afterTotals.get(id)!==total))continue;
    const steps=[...next.steps,{operatorId:operator.id,parameters:input.parameters,before:next.state,after}];
    if(same(after,input.goalState)){selected=steps;break;}
    if(!seen.has(digest(after))){seen.add(digest(after));queue.push({state:after,steps});}
   }
   if(selected)break;
  }
  if(!selected)fail(depthBound?'S4_ECONOMIC_COMPOSITION_DEPTH_INCOMPLETE':'S4_ECONOMIC_GOAL_UNREACHABLE_IN_CURRENT_FINITE_ADAPTER');
  const episode=(await c.query<{uses_used:number}>('UPDATE finnor_os.y1_episodes SET uses_used=uses_used+1 WHERE tenant_id=$1 AND id=$2 AND uses_used<$3 RETURNING uses_used',
   [row.tenant_id,row.episode_id,PROFILE.maxProgrammeUses])).rows[0];
  if(!episode)fail('S4_ECONOMIC_ORIGINAL_USE_BOUND');
  const id=randomUUID(),plan=await selectEconomicProgrammePlanTx(ctx,c,row,id,input.reservationRef,input.goalState,selected);
  const body:Omit<EconomicProgramme,'ref'>={schema:'finnor.s4.economic-programme.v1',id,tenantId:row.tenant_id,principalId:row.principal_id,
   theoryId:row.id,theoryRef:row.artifact!.envelope.contentRef,moduleRef:module.ref,admissionRef:admission.ref,workId:row.work_id,
   workInputId:row.work_input_id,episodeId:row.episode_id,planRevisionId:plan.id,root:row.root,reservationRef:input.reservationRef,
   initialRevision:held.revision,initialState:start,goalState:input.goalState,steps:plan.economicSteps,rightsRevision:row.rights_revision,
   validUntil:row.deadline_at.toISOString(),createdAt:new Date().toISOString(),externalEffects:false,executionAuthorityGranted:false};
  const programme:EconomicProgramme={...body,ref:reference('S4','economic-programme',body)};
  await c.query('INSERT INTO finnor_os.s4_economic_programmes(tenant_id,id,principal_id,theory_id,work_id,episode_id,body,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
   [row.tenant_id,id,row.principal_id,row.id,row.work_id,row.episode_id,JSON.stringify(programme),hash,input.idempotencyKey]);
  await eventTx(c,row,'P1_S4_SEMANTIC_MODULE_CONSUMED','programme:'+id,{programmeRef:programme.ref,moduleRef:module.ref,
   admissionRef:admission.ref,planRevisionId:plan.id,composedOperatorIds:selected.map(s=>s.operatorId),goalDigest:digest(input.goalState),
   originalEpisodeId:row.episode_id,expansions,authorityGranted:false});
  return programme;
 });
}
export async function readEconomicProgramme(ctx:PeMutationContext,id:string){
 return transaction(ctx,async c=>{
  const programme=await programmeTx(ctx,c,id,false),row=await theoryTx(ctx,c,programme.theoryId,false);
  const obligations=(await c.query(`SELECT o.body,e.status,e.observed_result,e.verification FROM finnor_os.s6_economic_obligation_origins o
   JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
   WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.programme_id=$3 ORDER BY o.step_index`,[ctx.auth.tenantId,principal(ctx),id])).rows;
  const held=await readEconomicReservationTx(ctx,c,programme.reservationRef,true);
  const observed=obligations.length===programme.steps.length&&obligations.every(o=>o.status==='verified'&&o.verification?.canonicalObservationRef);
  const unknown=obligations.some(o=>['executing','reconciliation_required','unverified','executed'].includes(o.status));
  return {schema:'finnor.s4.economic-programme-projection.v1',programme,status:observed?'OBSERVED':unknown?'UNKNOWN':
   row.cancelled?'CANCELLED_RESPONSIBILITY_RETAINED':row.status==='INVALIDATED'?'INVALIDATED_RESPONSIBILITY_RETAINED':'PREPARED',
   currentRightState:held.economicState.state,reservationRevision:held.revision,obligations,
   observedGoalDigest:observed?digest(programme.goalState):null,financialEfficacyEstablished:false,externalSettlementEstablished:false};
 });
}
