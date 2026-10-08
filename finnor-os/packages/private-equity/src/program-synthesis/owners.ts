import {readHarnessDecisionSlice} from './decision-slice';
import {designEnterpriseExperiments} from '../enterprise-experiments';
import {queryEnterpriseInterventionModel} from '../enterprise-interventions';
import {readEnterpriseContingentPolicy,validateEnterpriseContingentPolicy} from '../enterprise-control';
import {readEnterpriseAllocation,validateEnterpriseAllocation} from '../enterprise-allocation';
import type {PeMutationContext} from '../types';
import {authorize,principal,sha,tx} from '../evidence-execution/store';
import type {HarnessRequest,OwnerOperation} from './contracts';
import type {ProgramRow} from './store';

export async function resolveEconomicBindings(ctx:PeMutationContext,request:HarnessRequest,cut:{programId:string;workId:string;inputId:string;validAt:string;knowledgeAt:string}){const refs=[];
 if(request.ownerBindings?.policyRef){const ref=request.ownerBindings.policyRef;const policy=await readEnterpriseContingentPolicy(ctx,ref);const validity=await validateEnterpriseContingentPolicy(ctx,ref);if(validity.status!=='CURRENT')throw Error('S4_POLICY_CURRENTNESS_UNPASSED');refs.push({owner:'S4',ref:policy.ref,validity,businessSelectionOwner:'S4',p1AuthorityGranted:false});}
 if(request.ownerBindings?.allocationRef){const ref=request.ownerBindings.allocationRef;const allocation=await readEnterpriseAllocation(ctx,ref);const validity=await validateEnterpriseAllocation(ctx,ref);if(validity.status!=='CURRENT')throw Error('S5_ALLOCATION_CURRENTNESS_UNPASSED');refs.push({owner:'S5',ref,allocation,validity,p1ReservationMinted:false});}
 if(request.ownerBindings?.decisionSliceRef)refs.push(await readHarnessDecisionSlice(ctx,request.ownerBindings.decisionSliceRef,cut));return refs;
}
export async function executeOwnerOperation(ctx:PeMutationContext,q:ProgramRow,operation:OwnerOperation):Promise<{status:'DONE'|'WAITING'|'STOP';value:unknown}>{
 if(operation.op==='propose_model')return {status:'DONE',value:{schema:'finnor.p1.model-proposal.v1',assumptions:operation.assumptions,units:operation.units,mechanism:operation.mechanism,sourceRefs:q.request.sources.map(s=>s.key),identification:'UNIDENTIFIED_PROPOSAL',validityOwner:'S3',admitted:false,observedFieldOutcome:false}};
 if(operation.op==='design_inquiry')return {status:'DONE',value:{proposal:await designEnterpriseExperiments(ctx,{root:q.request.root,request:operation.request}),measurementOrAssignmentExecuted:false,selectionOwner:'S4',resourceOwner:'S5',effectOwner:'S6'}};
 if(operation.op==='simulate')return {status:'DONE',value:{response:await queryEnterpriseInterventionModel(ctx,{modelRef:operation.modelRef,query:operation.query}),evidenceClass:'MODEL_RELATIVE',liveObservation:false}};
 if(operation.op==='propose_effect'){if(operation.policyRef)await readEnterpriseContingentPolicy(ctx,operation.policyRef);if(operation.reservationRef)await readEnterpriseAllocation(ctx,operation.reservationRef);return {status:'DONE',value:{schema:'finnor.p1.exact-effect-proposal.v1',...operation,requestDigest:sha({target:operation.target,operation:operation.operation,value:operation.value,unit:operation.unit,idempotencyKey:operation.idempotencyKey}),executionAuthorityGranted:false,dispatched:false,remainingPredicates:['S4_SELECTED_CURRENT_BEHAVIOR','S5_VALID_RESOURCE_RESERVATION','S6_EXACT_APPROVAL_AND_CREDENTIAL_EGRESS','S6_INDEPENDENT_OBSERVATION'],nullMeaning:operation.operation==='clear'?'EXPLICIT_CLEAR':'NON_NULL_SET'}};}
 if(operation.op==='stop')return {status:'STOP',value:{reason:operation.reason,remainingPredicates:operation.remainingPredicates,businessStopSelectedByS4:false,goalSuccess:false}};
 await authorize(ctx,q.request.root,[{type:'work',id:q.work_id},{type:operation.waitFor.resource.type,id:operation.waitFor.resource.id}]);
 const planNode=q.proposed.planGraph.nodes.find(n=>n.kind==='wait'&&sha(n.waitFor)===sha(operation.waitFor)&&Date.parse(n.earliestAt??'')===Date.parse(operation.earliestAt)&&Date.parse(n.deadlineAt??'')===Date.parse(operation.deadlineAt));
 if(!planNode)throw Error('ACTUAL_OWNER_AUTHORIZED_CONTINUATION_REQUIRED');
 const waiting=await tx(ctx,async c=>(await c.query<any>(`SELECT w.id,w.status,w.matched_event_id,w.deadline_at,w.objective_loop_id,w.objective_step_id,cl.id wake_claim_id,e.occurred_at,e.payload,e.content_treatment FROM finnor_os.work_event_waits w JOIN finnor_os.work_objective_loops l ON l.id=w.objective_loop_id AND l.tenant_id=w.tenant_id JOIN finnor_os.work_plan_revisions p ON p.id=w.plan_revision_id AND p.tenant_id=w.tenant_id LEFT JOIN finnor_os.work_wake_claims cl ON cl.wait_id=w.id AND cl.tenant_id=w.tenant_id LEFT JOIN finnor_os.integration_events e ON e.id=w.matched_event_id AND e.tenant_id=w.tenant_id WHERE w.tenant_id=$1 AND w.work_id=$2 AND w.plan_revision_id=$3 AND w.plan_node_id=$4 AND p.work_input_id=$5 AND l.created_by=$6 ORDER BY w.created_at DESC LIMIT 1`,[q.tenant_id,q.work_id,q.plan_revision_id,planNode.id,q.work_input_id,q.principal_id])).rows[0],true);
 if(operation.objectiveLoopId&&waiting?.objective_loop_id!==operation.objectiveLoopId||operation.objectiveStepId&&waiting?.objective_step_id!==operation.objectiveStepId)throw Error('ACTUAL_OWNER_AUTHORIZED_CONTINUATION_REQUIRED');
 // A bounded technical stop is possible before the native controller has
 // installed its wait. It must not fabricate a native timer/observation receipt.
 if(!waiting&&Date.now()>=Date.parse(operation.deadlineAt))return {status:'STOP',value:{status:'NATIVE_WAIT_INSTALL_DEADLINE_EXPIRED',remainingPredicate:operation.key,deadlineAt:operation.deadlineAt,observedAt:new Date().toISOString(),nativeWaitId:null,observationEstablished:false,goalSuccess:false}};
 if(waiting?.status==='satisfied'&&waiting.matched_event_id&&waiting.wake_claim_id)return {status:'DONE',value:{waitId:waiting.id,status:'SATISFIED_OWNER_CORRELATED_CUT',wakeClaimId:waiting.wake_claim_id,eventId:waiting.matched_event_id,occurredAt:waiting.occurred_at,contentTreatment:waiting.content_treatment,observationOwner:'CANONICAL_EVENT_FABRIC',scientificObservationEstablished:false}};
 if(waiting&&['timed_out','cancelled'].includes(waiting.status))return {status:'STOP',value:{waitId:waiting.id,status:waiting.status,remainingPredicate:operation.key,deadlineAt:operation.deadlineAt,goalSuccess:false}};
 return {status:'WAITING',value:{waitId:waiting?.id??null,status:waiting?.status??'NATIVE_WAIT_INSTALL_PENDING',remainingPredicate:operation.key,planNodeId:planNode.id,deadlineAt:operation.deadlineAt,goalSuccess:false}};
}
