import {randomUUID,createPrivateKey,sign} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {withTenantTransaction} from '@finnor/db';
import {submitCommand,cancelRun} from '@finnor/workflow-runtime';
import type pg from 'pg';
import type {DurableObligation,ExperimentRef,BusinessEffectSet} from '@finnor/shared-types';
import {epistemicHash,immutableControl,ExperimentRefSchema} from '@finnor/epistemic-runtime';
import {compileContingentInterventionIntent} from '../../orchestration/src/compiler';
import {compileGovernedRequestProposal} from '../../orchestration/src/request-compiler';
import {ObligationOperationSchemas} from './obligation-contracts';
import {readEnterpriseContingentHandoffPreparation,readEnterpriseContingentPolicy} from './enterprise-control';
import {readEnterpriseAllocation,validateEnterpriseAllocation,assessEnterpriseAllocationContinuation} from './enterprise-allocation';
import {PeDomainError,type PeMutationContext} from './types';
import {enqueueOwnerDeliveryInTransaction} from '../../governed-execution/src/owner-delivery-store';
import {readOwnerTransportReference,dispatchOwnerTransportRequest,readOwnerTransportExecutionHandoff} from '../../governed-execution/src/owner-transport';
import {LedgerFault} from '../../governed-execution/src/protocol';
import {brokerPrivateFile,brokerSourceDigests} from '../../governed-execution/src/broker-io';
import {canonical} from '../../governed-execution/src/protocol';
import {s6AdapterContract} from '../../governed-execution/src/adapter-contract';
import {readS5GovernedBudgets,recordS5GovernedResourceUnits} from './allocation-store';
const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const denied=()=>new PeDomainError('PE_ENTITY_NOT_FOUND','Permitted S6 obligation context is unavailable');
const same=(a:unknown,b:unknown)=>epistemicHash(a)===epistemicHash(b);
const authoritySourcePaths=()=>['enterprise-obligations.ts','enterprise-allocation.ts','enterprise-control.ts','enterprise-beliefs.ts','allocation-store.ts','obligation-contracts.ts'].map(name=>fileURLToPath(new URL(name,import.meta.url))).concat(fileURLToPath(new URL('../../../apps/api/app/api/obligations/[operation]/route.ts',import.meta.url)));
async function signOwnerAssessment(body:Record<string,unknown>){
 const signerPath=process.env.FINNOR_S6_CURRENT_OWNER_SIGNER;if(!signerPath)throw new LedgerFault(503,'CURRENT_OWNER_SIGNER_UNAVAILABLE');const key=createPrivateKey(await brokerPrivateFile(signerPath));if(key.asymmetricKeyType!=='ed25519')throw new LedgerFault(503,'CURRENT_OWNER_SIGNER_INVALID');
 return {...body,signature:sign(null,Buffer.from(canonical(body)),key).toString('base64')};
}
async function authorize(ctx:PeMutationContext,c:pg.PoolClient){if(ctx.auth.role!=='owner'||actor(ctx)!==ctx.auth.userId)throw denied();const rows=await c.query("SELECT id FROM finnor_os.users WHERE id=$1 AND tenant_id=$2 AND role='owner' AND status='active' FOR SHARE",[ctx.auth.userId,ctx.auth.tenantId]);if(rows.rowCount!==1)throw denied();}
function parsedInput(input:unknown){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==3||Object.keys(input).some(k=>!['preparationRef','allocationRef','consumptionRef'].includes(k)))throw denied();const i=input as Record<string,unknown>;return {preparationRef:ExperimentRefSchema.parse(i.preparationRef),allocationRef:ExperimentRefSchema.parse(i.allocationRef),consumptionRef:ExperimentRefSchema.parse(i.consumptionRef)};}
function verifyBody(ctx:PeMutationContext,body:DurableObligation){const {ref,...origin}=body;if(body.schema!=='finnor.durable-obligation.v1'||body.tenantId!==ctx.auth.tenantId||body.principalId!==actor(ctx)||ref.owner!=='S6'||ref.version!=='s6-obligation-v1'||ref.id!==`durable-obligation:${ref.contentDigest}`||epistemicHash(origin)!==ref.contentDigest||body.protectedReceipt!==null||body.executionAuthorityGranted!==false)throw denied();}
async function enqueueObligation(ctx:PeMutationContext,c:pg.PoolClient,body:DurableObligation){
 const {ref,...content}=body;
 await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:'S6',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},
  {kind:'REFERENCE',identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[body.rightsRef]}});
}

const pendingPreparations=new Map<string,{inputDigest:string;promise:Promise<DurableObligation>}>();
/** Coalesce identical local deliveries inside the existing checker concurrency budget.
 * Every caller authenticates independently; SQL remains the cross-process identity owner. */
export async function prepareEnterpriseDurableObligation(ctx:PeMutationContext,input:unknown):Promise<DurableObligation>{
 const refs=parsedInput(input),inputDigest=epistemicHash(refs);
 await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>authorize(ctx,c));
 const key=JSON.stringify([ctx.auth.tenantId,actor(ctx),refs.consumptionRef.id]);const pending=pendingPreparations.get(key);
 if(pending){if(pending.inputDigest!==inputDigest)throw denied();return pending.promise;}
 if(pendingPreparations.size>=64)throw new Error('S6_PREPARATION_CONCURRENCY_BOUND');
 const promise=prepareOwnedObligation(ctx,refs);pendingPreparations.set(key,{inputDigest,promise});
 try{return await promise;}finally{if(pendingPreparations.get(key)?.promise===promise)pendingPreparations.delete(key);}
}

/** No lifecycle ledger is created: native effect/workflow/provider owners keep attempts and settlement. */
async function prepareOwnedObligation(ctx:PeMutationContext,input:unknown):Promise<DurableObligation>{
 const refs=parsedInput(input),inputDigest=epistemicHash(refs);
 const retry=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{await authorize(ctx,c);const row=(await c.query('SELECT body,input_digest FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3',[ctx.auth.tenantId,actor(ctx),refs.consumptionRef.id])).rows[0];if(row){if(row.input_digest!==inputDigest)throw denied();verifyBody(ctx,row.body);await enqueueObligation(ctx,c,row.body);return row.body as DurableObligation;}return null;});if(retry)return immutableControl(retry);
 const preparation=await readEnterpriseContingentHandoffPreparation(ctx,refs.preparationRef),handoff=preparation.handoff,policy=await readEnterpriseContingentPolicy(ctx,handoff.policyRef);
 const issued=await readEnterpriseAllocation(ctx,refs.allocationRef),validation=await validateEnterpriseAllocation(ctx,refs.allocationRef),consumption=issued.consumptions.find(c=>same(c.ref,refs.consumptionRef));
 if(consumption?.effectRef){const concurrent=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{await authorize(ctx,c);const row=(await c.query('SELECT body,input_digest FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3',[ctx.auth.tenantId,actor(ctx),refs.consumptionRef.id])).rows[0];if(!row||row.input_digest!==inputDigest)throw denied();verifyBody(ctx,row.body);await enqueueObligation(ctx,c,row.body);return row;});return immutableControl(concurrent.body as DurableObligation);}
 if(validation.status!=='CURRENT'||!issued.reservation||!consumption||consumption.status!=='INTENDED_PENDING_S6'||consumption.effectRef!==null||!handoff.intervention||!handoff.interventionRef||!same(handoff.allocationRef,refs.allocationRef)||!same(consumption.policyRef,handoff.policyRef)||!same(consumption.reservationRef,issued.reservation.ref)||consumption.nodeId!==handoff.decision.nodeId||!same(consumption.decisionRef,handoff.decision.ref)||consumption.demandDigest!==handoff.demandDigest||consumption.idempotencyKey!==preparation.plannedConsumptionKey)throw denied();
 const node=policy.nodes.find(n=>n.id===consumption.nodeId);if(!node||handoff.intervention.channels.length<1||handoff.intervention.channels.length>64||handoff.intervention.channels.some(channel=>channel.permittedRefinements.length!==0)||!same(policy.mandateRef,issued.certificate.mandateRef)||policy.bindings.rightsRef!==issued.certificate.rightsRef)throw denied();
 const actionId=randomUUID(),effectId=randomUUID(),preparedAt=new Date().toISOString();
 const effect=compileContingentInterventionIntent({actionId,effectId,intervention:handoff.intervention,preparationRef:refs.preparationRef,consumptionRef:refs.consumptionRef,compiledAt:preparedAt});
 const body:Omit<DurableObligation,'ref'>={schema:'finnor.durable-obligation.v1',semanticOwner:'S6',tenantId:ctx.auth.tenantId,principalId:actor(ctx),episodeId:policy.episodeId,preparedAt,...refs,mandateRef:policy.mandateRef,rightsRef:policy.bindings.rightsRef,policyRef:policy.ref,decisionRef:handoff.decision.ref,nodeId:node.id,demandDigest:policy.demand.contentDigest,reservationRef:issued.reservation.ref,effectRef:{id:effect.id,semanticHash:effect.semanticHash,schemaVersion:1},domainActionId:actionId,interventionRef:handoff.interventionRef,intervention:handoff.intervention,resourceEnvelope:consumption.envelope,preconditions:{beliefPins:policy.bindings.beliefPins,reservationRevision:issued.reservation.revision,allocationValidUntil:issued.certificate.validUntil,policyValidUntil:policy.validUntil,interventionDigest:epistemicHash(handoff.intervention)},deadline:{businessStartAt:handoff.intervention.timing.startAt,businessPeriodEndAt:new Date(Date.parse(handoff.intervention.timing.startAt)+handoff.intervention.timing.periodMs).toISOString(),authorityExpiresAt:new Date(Math.min(Date.parse(policy.validUntil),Date.parse(issued.certificate.validUntil))).toISOString()},method:{status:'UNADMITTED',requestIRVersion:'s6-intervention-intent-v1',providerBinding:null,admissionReceipt:null},settlement:{kind:'INDEPENDENT_EXACT_TARGET_CHANNEL_DOSE_OBSERVATION',memberCount:handoff.intervention.channels.length,providerAcknowledgmentSufficient:false,executorSuccessSufficient:false},responsibility:{unknownOutcome:'RECONCILE_BEFORE_RETRY',cancellation:'RETAIN_POSSIBLE_EFFECTS_AND_S5_LIABILITIES',resourceReleaseOwner:'S5'},executionAuthorityGranted:false,protectedReceipt:null,status:'PREPARED_UNADMITTED'};
 const digest=epistemicHash(body),obligation:DurableObligation={...body,ref:{owner:'S6',id:`durable-obligation:${digest}`,version:'s6-obligation-v1',contentDigest:digest}};
 if(Buffer.byteLength(JSON.stringify(obligation))>8*1024*1024)throw denied();
 return withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
  // Joins participate in the existing S5 portfolio serialization boundary.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);await authorize(ctx,c);
  const prior=(await c.query('SELECT body,input_digest FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND consumption_id=$2',[ctx.auth.tenantId,refs.consumptionRef.id])).rows[0];if(prior){if(prior.input_digest!==inputDigest)throw denied();verifyBody(ctx,prior.body);await enqueueObligation(ctx,c,prior.body);return immutableControl(prior.body as DurableObligation);}
  const held=(await c.query('SELECT revision,status,revocation_reason FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR SHARE',[ctx.auth.tenantId,issued.reservation!.ref.id])).rows[0];
  const consumed=(await c.query('SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.consumption_id=$2 FOR SHARE',[ctx.auth.tenantId,refs.consumptionRef.id])).rows[0];
  if(!held||held.revision!==issued.reservation!.revision||held.revocation_reason||held.status==='RELEASED'||!consumed||consumed.status!=='INTENDED_PENDING_S6'||consumed.effect_ref!==null||!same(consumed.body.ref,refs.consumptionRef)||Date.now()>=Date.parse(body.deadline.authorityExpiresAt))throw denied();
  const count=(await c.query('SELECT count(*)::int n FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1',[ctx.auth.tenantId])).rows[0].n;if(count>=256)throw new Error('S6_OBLIGATION_BOUND_REQUIRES_ACCOUNTABLE_ARCHIVAL');
  await c.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,summary,initiated_by) VALUES($1,$2,'execute_contingent_intervention',$3::jsonb,'draft',$4,$5)",[actionId,ctx.auth.tenantId,JSON.stringify(effect.delta.values),'S4 exact intervention intent; method/IR/admission unresolved',actor(ctx)]);
  await c.query("INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status) VALUES($1,$2,$3,$4,$5,'operational_change',$6::jsonb,'compiled')",[effectId,ctx.auth.tenantId,actionId,effect.semanticHash,effect.scopeHash,JSON.stringify(effect)]);
  await c.query('UPDATE finnor_os.domain_actions SET business_effect_id=$1 WHERE tenant_id=$2 AND id=$3',[effectId,ctx.auth.tenantId,actionId]);
  await c.query('INSERT INTO finnor_os.s6_obligation_origins(tenant_id,principal_id,obligation_id,consumption_id,effect_id,domain_action_id,input_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[ctx.auth.tenantId,actor(ctx),obligation.ref.id,refs.consumptionRef.id,effectId,actionId,inputDigest,JSON.stringify(obligation)]);
  // Binding is ordinary intent only, not S5 actual consumption or release authority.
  await c.query('UPDATE finnor_os.s5_consumption_states SET effect_ref=$1::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND consumption_id=$3',[JSON.stringify({owner:'S6',id:effectId,version:'business-effect-v1',contentDigest:effect.semanticHash}),ctx.auth.tenantId,refs.consumptionRef.id]);
  await enqueueObligation(ctx,c,obligation);
  return immutableControl(obligation);
 });
}
export async function readEnterpriseDurableObligation(ctx:PeMutationContext,value:unknown):Promise<DurableObligation>{
 const ref=ExperimentRefSchema.parse(value);return withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{await authorize(ctx,c);const row=(await c.query('SELECT o.body,e.effect,e.semantic_hash,e.domain_action_id FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.obligation_id=$3',[ctx.auth.tenantId,actor(ctx),ref.id])).rows[0];if(!row||!same(row.body.ref,ref))throw denied();verifyBody(ctx,row.body);const effect=row.effect as BusinessEffectSet;if(effect.id!==row.body.effectRef.id||effect.semanticHash!==row.body.effectRef.semanticHash||effect.semanticHash!==row.semantic_hash||effect.source.domainActionId!==row.body.domainActionId||row.domain_action_id!==row.body.domainActionId||!same(effect.delta.values.intervention,row.body.intervention))throw denied();return immutableControl(row.body as DurableObligation);});
}
/** Resolve the authenticated native origin before obtaining its separate content commitment. */
export async function readEnterpriseDurableObligationCommitment(ctx:PeMutationContext,value:unknown){
 const obligation=await readEnterpriseDurableObligation(ctx,value);
 const accepted=await readOwnerTransportReference({semanticOwner:'S6',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},obligation.ref.id);
 const {ref,...content}=obligation;
 if(!same(accepted.reference,{...ref,content})||accepted.receipt.semanticOwner!=='S6'||accepted.receipt.principalId!==actor(ctx)){
  throw new LedgerFault(503,'OBLIGATION_COMMITMENT_BINDING_INVALID');
 }
 return {
  obligationRef:ref,
  commitmentReceipt:accepted.receipt,
  executionAuthorityGranted:false as const,
  settlementEstablished:false as const,
  qualification:accepted.qualification,
 };
}
export async function validateEnterpriseDurableObligation(ctx:PeMutationContext,value:unknown){
 const obligation=await readEnterpriseDurableObligation(ctx,value),reasons:string[]=[];try{await readEnterpriseContingentPolicy(ctx,obligation.policyRef);}catch{reasons.push('POLICY_OR_UPSTREAM_SOURCE_RIGHTS_CHANGED');}try{const allocation=await validateEnterpriseAllocation(ctx,obligation.allocationRef);if(allocation.status!=='CURRENT')reasons.push(...allocation.reasons);}catch{reasons.push('ALLOCATION_CONTEXT_UNAVAILABLE');}if(Date.now()>=Date.parse(obligation.deadline.authorityExpiresAt))reasons.push('AUTHORITY_EXPIRED_RESPONSIBILITY_RETAINED');
 reasons.push('PROTECTED_METHOD_IR_PROVIDER_BINDING_AND_RELEASE_UNADMITTED');return {obligationRef:obligation.ref,status:reasons.length>1?'STALE_INPUT':'PREPARED_UNADMITTED',reasons,executionAuthorityGranted:false as const,protectedReceipt:null};
}
export async function compileEnterpriseDurableObligationRequest(ctx:PeMutationContext,input:unknown){
 const parsed=ObligationOperationSchemas['compile-request'].parse(input);
 const obligation=await readEnterpriseDurableObligation(ctx,parsed.obligationRef);
 return compileGovernedRequestProposal(obligation,parsed.bindings);
}

export async function readEnterpriseDurableObligationExecutionHandoff(ctx:PeMutationContext,input:unknown){
 const parsed=ObligationOperationSchemas['read-execution-handoff'].parse(input),obligation=await readEnterpriseDurableObligation(ctx,parsed.obligationRef);
 return readOwnerTransportExecutionHandoff({semanticOwner:'S6',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},obligation.ref.id);
}
export async function readEnterpriseDurableObligationBudgets(ctx:PeMutationContext,input:unknown){
 const parsed=ObligationOperationSchemas['budget-status'].parse(input),obligation=await readEnterpriseDurableObligation(ctx,parsed.obligationRef);
 return readS5GovernedBudgets(ctx,obligation);
}
/** S5 issues conservative occupation before work. This assessment grants no
 * mutation, release, provider billing or independent settlement authority. */
export async function assessEnterpriseDurableObligationBudget(ctx:PeMutationContext,input:unknown){
 const parsed=ObligationOperationSchemas['check-budget'].parse(input),obligation=await readEnterpriseDurableObligation(ctx,parsed.obligationRef);
 if(!obligation.intervention.channels.some(channel=>parsed.memberId===`request-member:${epistemicHash([obligation.ref,channel.exposureId])}`)||parsed.phase==='EXECUTION'&&parsed.ordinal!==1)throw denied();
 const {obligationRef:_ref,nonce,...units}=parsed,result=await recordS5GovernedResourceUnits(ctx,obligation,units),checkedAt=new Date().toISOString();
 return signOwnerAssessment({schema:'finnor.s6.resource-owner-assessment.v1',status:'RESERVED',tenantId:obligation.tenantId,principalId:obligation.principalId,rightsRef:obligation.rightsRef,obligationRef:obligation.ref,requestRef:parsed.requestRef,memberId:parsed.memberId,phase:parsed.phase,ordinal:parsed.ordinal,units:parsed.units,nonce,effectRef:obligation.effectRef,allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef,reservationRef:obligation.reservationRef,charge:result.charge,semanticReplay:result.semanticReplay,checkedAt,validUntil:new Date(Date.parse(checkedAt)+5000).toISOString(),sourceDigests:await brokerSourceDigests(authoritySourcePaths()),executionAuthorityGranted:false});
}

/** Authenticated handler for the canonical contingent action, preserving its
 * original prepared record and resolving stronger evidence separately. */
export async function executeEnterpriseDurableObligationRequest(ctx:PeMutationContext,input:unknown,reconcile=false){
 const parsed=ObligationOperationSchemas[reconcile?'reconcile-request':'execute-request'].parse(input);
 const obligation=await readEnterpriseDurableObligation(ctx,parsed.request.ir.obligationRef);
 if(parsed.request.ir.tenantId!==obligation.tenantId||parsed.request.ir.principalId!==obligation.principalId||!same(parsed.request.ir.effectRef,obligation.effectRef)||!same(parsed.request.ir.consumptionRef,obligation.consumptionRef))throw denied();
 if(!reconcile&&!('delivery' in parsed&&parsed.delivery))await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>{const scheduled=await c.query("SELECT id FROM finnor_os.workflow_steps WHERE tenant_id=$1 AND business_effect_id=$2 AND step_type='execute_governed_obligation' LIMIT 1",[ctx.auth.tenantId,obligation.effectRef.id]);if(scheduled.rowCount)throw new LedgerFault(409,'SCHEDULE_REQUIRES_CURRENT_CLAIM');});
 const outcome=await dispatchOwnerTransportRequest({semanticOwner:'S6',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},parsed,reconcile);
 if(outcome.status==='UNRESOLVED'){
  const {recordEnterpriseAllocationAttempt}=await import('./enterprise-allocation');
  const allocationResponsibility=await recordEnterpriseAllocationAttempt(ctx,{allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef,executionEventId:outcome.receipt.identity});return {...outcome,allocationResponsibility};
 }
 return outcome;
}

/** Persist the exact request once in the existing durable command graph. Queueing
 * establishes delivery responsibility; method and business signatures remain
 * subject to protected verification at the due-time egress boundary. */
export function governedScheduledDelegation(obligation:DurableObligation,requestRef:ExperimentRef){
 return {schema:'finnor.s6.scheduled-delegation.v1',executorContract:s6AdapterContract('SCHEDULER'),version:'s6-executor-contract-v1',tenantId:obligation.tenantId,principalId:obligation.principalId,parentObligationRef:obligation.ref,parentEffectRef:obligation.effectRef,requestRef,rightsRef:obligation.rightsRef,targets:obligation.intervention.channels.map(channel=>({exposureId:channel.exposureId,target:channel.target,operation:channel.operation,unit:channel.unit,doses:channel.doses,permittedRefinements:channel.permittedRefinements})),requiredMembers:obligation.intervention.channels.map(channel=>`request-member:${epistemicHash([obligation.ref,channel.exposureId])}`),allocationRef:obligation.allocationRef,reservationRef:obligation.reservationRef,consumptionRef:obligation.consumptionRef,resourceEnvelope:obligation.resourceEnvelope,sharedBudgetOwner:'S5',childMayCreateNewAllowance:false,parentRetainsUnresolvedResponsibility:true,parentRequiresAllOriginalMemberSettlement:true,executionAuthorityGranted:false};
}
export async function scheduleEnterpriseDurableObligationRequest(ctx:PeMutationContext,input:unknown){
 const execution=ObligationOperationSchemas['schedule-request'].parse(input),obligation=await readEnterpriseDurableObligation(ctx,execution.request.ir.obligationRef);
 if(execution.request.ir.tenantId!==obligation.tenantId||execution.request.ir.principalId!==obligation.principalId||!same(execution.request.ir.effectRef,obligation.effectRef)||!same(execution.request.ir.consumptionRef,obligation.consumptionRef)||execution.request.ref.contentDigest!==epistemicHash(execution.request.ir)||execution.request.ref.id!==`request-ir:${execution.request.ref.contentDigest}`)throw denied();
 const payload={schema:'finnor.s6.scheduled-delivery.v1',obligationRef:obligation.ref,notBefore:obligation.deadline.businessStartAt,delegation:governedScheduledDelegation(obligation,execution.request.ref),execution};
 const scheduled=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(db,c)=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);await authorize(ctx,c);
  const native=(await c.query('SELECT e.status AS effect_status,d.status AS action_status FROM finnor_os.business_effects e JOIN finnor_os.domain_actions d ON d.tenant_id=e.tenant_id AND d.id=e.domain_action_id WHERE e.tenant_id=$1 AND e.id=$2 AND d.id=$3 FOR SHARE',[ctx.auth.tenantId,obligation.effectRef.id,obligation.domainActionId])).rows[0];
  if(!native||native.effect_status!=='compiled'||native.action_status!=='draft'||Date.now()>=Date.parse(obligation.deadline.authorityExpiresAt))throw new LedgerFault(409,'NATIVE_SCHEDULE_NO_LONGER_ELIGIBLE');
  return submitCommand(db,{tenantId:ctx.auth.tenantId,commandType:'execute_contingent_intervention',workflowType:'single_action',payload,steps:[{stepType:'execute_governed_obligation',payload}],idempotencyKey:`governed-obligation:${obligation.ref.id}`,requestedBy:actor(ctx),domainActionId:obligation.domainActionId,businessEffectId:obligation.effectRef.id,authorizedEffectHash:obligation.effectRef.semanticHash,executionClass:'operational_change',protocolVersion:3});
 });
 return {status:'QUEUED_REQUIRES_PROTECTED_REVALIDATION',obligationRef:obligation.ref,requestRef:execution.request.ref,commandId:scheduled.commandId,workflowRunId:scheduled.workflowRunId,workflowStepId:scheduled.stepIds[0],semanticReplay:scheduled.alreadyExisted,notBefore:payload.notBefore,executionAuthorityGranted:false,settlementEstablished:false};
}
export async function cancelEnterpriseDurableObligationDelivery(ctx:PeMutationContext,input:unknown){
 const parsed=ObligationOperationSchemas['cancel-delivery'].parse(input),obligation=await readEnterpriseDurableObligation(ctx,parsed.obligationRef);
 await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{await authorize(ctx,c);const owned=await c.query("SELECT s.id FROM finnor_os.workflow_steps s JOIN finnor_os.workflow_runs r ON r.tenant_id=s.tenant_id AND r.id=s.workflow_run_id WHERE s.tenant_id=$1 AND r.id=$2 AND s.business_effect_id=$3 AND s.domain_action_id=$4 AND s.step_type='execute_governed_obligation' AND s.payload->'obligationRef'=$5::jsonb",[ctx.auth.tenantId,parsed.workflowRunId,obligation.effectRef.id,obligation.domainActionId,JSON.stringify(obligation.ref)]);if(owned.rowCount!==1)throw denied();});
 return cancelRun(ctx.auth.tenantId,parsed.workflowRunId,parsed.expectedVersion,actor(ctx));
}

/** Ordinary owner facts, separately signed for a protected nonce challenge.
 * This is not method admission, business authorization or a settlement assertion. */
export async function assessEnterpriseDurableObligationDispatch(ctx:PeMutationContext,input:unknown){
 const parsed=ObligationOperationSchemas['check-dispatch'].parse(input),obligation=await readEnterpriseDurableObligation(ctx,parsed.obligationRef);
 if(!obligation.intervention.channels.some(channel=>parsed.memberId===`request-member:${epistemicHash([obligation.ref,channel.exposureId])}`))throw denied();
 const reasons:string[]=[];
 let reservationRevision=obligation.preconditions.reservationRevision,reservationAttemptEventId:string|null=null;
 if(parsed.delivery&&'kind' in parsed.delivery){
  try{const issued=await readEnterpriseAllocation(ctx,obligation.allocationRef);if(issued.reservation?.revision!==reservationRevision){const retained=await assessEnterpriseAllocationContinuation(ctx,obligation);reservationRevision=retained.reservationRevision;reservationAttemptEventId=retained.attemptEventId;}}
  catch{reasons.push('S5_RETAINED_MEMBER_CONTINUATION_NOT_CURRENT');}
 }
 let physicalClaimExpiresAt=Number.POSITIVE_INFINITY;
 try{const policy=await readEnterpriseContingentPolicy(ctx,obligation.policyRef);if(!same(policy.mandateRef,obligation.mandateRef)||policy.bindings.rightsRef!==obligation.rightsRef)reasons.push('POLICY_MANDATE_OR_RIGHTS_CHANGED');}catch{reasons.push('POLICY_OR_S1_SOURCE_RIGHTS_CHANGED');}
 try{const validation=await validateEnterpriseAllocation(ctx,obligation.allocationRef);if(validation.status!=='CURRENT')reasons.push(...validation.reasons);}catch{reasons.push('ALLOCATION_CURRENT_CONTEXT_UNAVAILABLE');}
 if(Date.now()<Date.parse(obligation.deadline.businessStartAt)||Date.now()>=Date.parse(obligation.deadline.businessPeriodEndAt)||Date.now()>=Date.parse(obligation.deadline.authorityExpiresAt))reasons.push('S4_TIME_OR_AUTHORITY_EXPIRED');
 await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);await authorize(ctx,c);
  const held=(await c.query('SELECT revision,status,revocation_reason FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR SHARE',[ctx.auth.tenantId,obligation.reservationRef.id])).rows[0];
  const consumed=(await c.query('SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.consumption_id=$2 FOR SHARE',[ctx.auth.tenantId,obligation.consumptionRef.id])).rows[0];
  const native=(await c.query('SELECT e.status AS effect_status,e.semantic_hash,d.status AS action_status FROM finnor_os.business_effects e JOIN finnor_os.domain_actions d ON d.tenant_id=e.tenant_id AND d.id=e.domain_action_id WHERE e.tenant_id=$1 AND e.id=$2 AND d.id=$3 FOR SHARE',[ctx.auth.tenantId,obligation.effectRef.id,obligation.domainActionId])).rows[0];
  if(!held||held.revision!==reservationRevision||held.revocation_reason||held.status==='RELEASED'||!consumed||!same(consumed.body.ref,obligation.consumptionRef)||consumed.effect_ref?.id!==obligation.effectRef.id||consumed.effect_ref?.contentDigest!==obligation.effectRef.semanticHash||consumed.status==='RECONCILED')reasons.push('S5_CURRENT_RESERVATION_CONSUMPTION_FENCE_CHANGED');
  if(!native||native.semantic_hash!==obligation.effectRef.semanticHash||native.effect_status!=='compiled'||native.action_status!=='draft')reasons.push('NATIVE_EFFECT_STATE_NOT_ELIGIBLE');
  const scheduled=(await c.query("SELECT s.*,r.status AS run_status,r.version AS run_version,co.status AS command_status,co.payload AS command_payload,co.authorized_effect_hash FROM finnor_os.workflow_steps s JOIN finnor_os.workflow_runs r ON r.tenant_id=s.tenant_id AND r.id=s.workflow_run_id JOIN finnor_os.commands co ON co.tenant_id=r.tenant_id AND co.id=r.command_id WHERE s.tenant_id=$1 AND s.business_effect_id=$2 AND s.step_type='execute_governed_obligation' FOR SHARE OF s,r,co",[ctx.auth.tenantId,obligation.effectRef.id])).rows;
  const d=parsed.delivery;
  if(scheduled.length||d){
   const s=scheduled[0];
   if(scheduled.length!==1||!d||s.id!==d.workflowStepId||Number(s.claim_fence)!==d.claimFence||s.dispatch_generation!==d.dispatchGeneration||s.run_version!==d.runVersion||s.run_status!=='running'||s.command_status!=='running'||s.cancellation_requested_at||s.authorized_effect_hash!==obligation.effectRef.semanticHash||s.domain_action_id!==obligation.domainActionId||!same(s.payload.obligationRef,obligation.ref)||!same(s.payload.execution?.request?.ref,parsed.requestRef)||!same(s.payload,s.command_payload)||s.payload.notBefore!==obligation.deadline.businessStartAt||!same(s.payload.delegation,governedScheduledDelegation(obligation,parsed.requestRef)))reasons.push('WORKFLOW_DELIVERY_FENCE_NOT_CURRENT');
   else if('kind' in d){
    if(s.status!=='waiting_observation'||!s.effect_commit_at||!['awaiting_observation','reconciling'].includes(s.execution_state)||s.claim_token!==null)reasons.push('WORKFLOW_RECOVERY_POSITION_NOT_CURRENT');
    const claimed=await c.query("SELECT j.lease_expires_at FROM finnor_os.job_delivery_attempts ja JOIN finnor_os.jobs j ON j.tenant_id=ja.tenant_id AND j.id=ja.job_id WHERE ja.tenant_id=$1 AND ja.id=$2 AND j.id=$3 AND j.type='run_workflow_step_v3' AND j.protocol_version=3 AND j.status='running' AND j.claim_token=$4 AND j.claim_fence=$5 AND ja.claim_token=j.claim_token AND ja.claim_fence=j.claim_fence AND j.lease_expires_at>clock_timestamp() AND ja.finished_at IS NULL AND j.payload->>'workflowStepId'=$6 AND (j.payload->>'workflowStepGeneration')::int=$7 FOR SHARE OF ja,j",[ctx.auth.tenantId,d.jobDeliveryAttemptId,d.jobId,d.jobClaimToken,d.jobClaimFence,d.workflowStepId,d.dispatchGeneration]);
    if(claimed.rowCount!==1)reasons.push('PHYSICAL_JOB_DELIVERY_NOT_CURRENT');else physicalClaimExpiresAt=claimed.rows[0].lease_expires_at.getTime();
   }
   else{
    if(s.claim_token!==d.claimToken||s.status!=='leased'||s.execution_state!=='commit_started'||!s.lease_expires_at||s.lease_expires_at.getTime()<=Date.now())reasons.push('WORKFLOW_DELIVERY_FENCE_NOT_CURRENT');
    else{const claimed=await c.query("SELECT sc.id,j.lease_expires_at FROM finnor_os.workflow_step_claims sc JOIN finnor_os.job_delivery_attempts ja ON ja.tenant_id=sc.tenant_id AND ja.id=sc.job_delivery_attempt_id JOIN finnor_os.jobs j ON j.tenant_id=ja.tenant_id AND j.id=ja.job_id WHERE sc.tenant_id=$1 AND sc.workflow_step_id=$2 AND sc.claim_token=$3 AND sc.claim_fence=$4 AND sc.dispatch_generation=$5 AND sc.finished_at IS NULL AND j.type='run_workflow_step_v3' AND j.protocol_version=3 AND j.status='running' AND j.claim_token=ja.claim_token AND j.claim_fence=ja.claim_fence AND j.lease_expires_at>clock_timestamp() AND ja.finished_at IS NULL FOR SHARE OF sc,ja,j",[ctx.auth.tenantId,d.workflowStepId,d.claimToken,d.claimFence,d.dispatchGeneration]);if(claimed.rowCount!==1)reasons.push('PHYSICAL_JOB_DELIVERY_NOT_CURRENT');else physicalClaimExpiresAt=Math.min(s.lease_expires_at.getTime(),claimed.rows[0].lease_expires_at.getTime());}
   }
  }
 });
 const paths=authoritySourcePaths();
 const sourceDigests=await brokerSourceDigests(paths),checkedAt=new Date().toISOString();
 if(physicalClaimExpiresAt<=Date.parse(checkedAt))reasons.push('PHYSICAL_CLAIM_EXPIRED_BEFORE_ASSESSMENT');
 const body={schema:'finnor.s6.current-owner-assessment.v1',status:reasons.length?'STALE_INPUT':'CURRENT',reasons,tenantId:obligation.tenantId,principalId:obligation.principalId,rightsRef:obligation.rightsRef,obligationRef:obligation.ref,requestRef:parsed.requestRef,memberId:parsed.memberId,nonce:parsed.nonce,effectRef:obligation.effectRef,allocationRef:obligation.allocationRef,consumptionRef:obligation.consumptionRef,reservationRevision,reservationAttemptEventId,delivery:parsed.delivery??null,checkedAt,validUntil:new Date(Math.min(Date.parse(checkedAt)+5000,Date.parse(obligation.deadline.authorityExpiresAt),physicalClaimExpiresAt)).toISOString(),sourceDigests,executionAuthorityGranted:false};
 return signOwnerAssessment(body);
}
