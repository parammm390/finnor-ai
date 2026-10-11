import type {ExperimentRef} from "@finnor/shared-types";
import type {CoalitionProposedSchedule} from "../../../shared-types/src/coalition-programme";
import {R5_VERSION} from "../../../shared-types/src/coalition-programme";
import type {PeMutationContext} from "../types";
import {withAllocationPortfolio} from "../allocation-store";
import {readEnterpriseCoalitionAllocation,assertCoalitionPlanningProfile} from "./r5-allocation-owner";
import {readEnterpriseCoalitionSelection} from "../enterprise-control";
import {authorizeBeliefResources} from "../enterprise-beliefs";
import {readSourceObject} from "../deliberation/store";
import {resolveDecisionWork} from "../decision-slice/adapters";
import {DecisionSliceError} from "../decision-slice/contracts";
import {coalitionPartyRoot} from "./r5-owners";
import {allocationRef,sameAllocationRef as same,AllocationContractError} from "../../../epistemic-runtime/src/allocation-contracts";
import {enqueueOwnerDeliveryInTransaction} from "../../../governed-execution/src/owner-delivery-store";
import {m3Hash} from "./v2-contracts";
import {assertDependencies} from "../evidence-execution/store";
import {allocationSnapshotInTransaction} from "../allocation-store";
const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const denied=()=>new AllocationContractError("PERMITTED_CONTEXT_UNAVAILABLE","Permitted S6 coalition schedule is unavailable");
const ref=(kind:string,body:unknown)=>allocationRef("S6",kind,body,R5_VERSION);
function validate(ctx:PeMutationContext,schedule:CoalitionProposedSchedule,value:ExperimentRef){
 const {ref:actual,...body}=schedule;
 if(schedule.schema!=="finnor.s6.coalition-proposed-schedule.v1"||schedule.tenantId!==ctx.auth.tenantId||
  schedule.principalId!==actor(ctx)||!same(actual,value)||!same(actual,ref("coalition-proposed-schedule",body))||
  schedule.executionAuthorityGranted!==false||schedule.settlementEstablished!==false||schedule.protectedReceipt!==null)throw denied();
}
export async function prepareEnterpriseCoalitionSchedule(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef}):Promise<CoalitionProposedSchedule>{
 assertCoalitionPlanningProfile();
 const issued=await readEnterpriseCoalitionAllocation(ctx,input.allocationRef);
 if(!issued.reservation)throw denied();
 const selection=await readEnterpriseCoalitionSelection(ctx,issued.problem.selection.ref),original=selection.original;
 const digest=m3Hash(input);
 const body:Omit<CoalitionProposedSchedule,"ref">={schema:"finnor.s6.coalition-proposed-schedule.v1",
  tenantId:ctx.auth.tenantId,principalId:actor(ctx),workId:selection.workId,workRevision:selection.workRevision,rightsRef:selection.rightsRef,
  selectionRef:selection.ref,allocationRef:input.allocationRef,reservationRef:issued.reservation!.ref,consumptionRef:input.consumptionRef,
  proposalVersion:m3Hash({selectionRef:selection.ref,demandDigest:selection.demandDigest}),originalRef:selection.originalRef,
  candidateDigest:selection.checker.candidateDigest,validUntil:selection.validUntil,
  selectedProgrammes:selection.candidate.programmeOptions.filter(option=>selection.selectedOptionIds.includes(option.id)),
  payments:selection.candidate.division.map(division=>({event:original.events.find(event=>event.id===division.eventId)!,
   dateAt:original.dates[division.date]!,division,legs:original.parties.map(party=>({partyId:party.id,targetRef:party.partyRef,
    fundingRef:party.fundingRef,amount:division.amounts[party.id]!})),
   proposedEffectIdentity:"proposed-coalition-payment:"+m3Hash({selectionRef:selection.ref,division}),
   requiredObservation:"INDEPENDENT_CONTRACT_EVENT_AND_EXACT_PAYMENT_READBACK",
   admission:"PAYMENT_SIGNING_PROVIDER_OPERATION_UNADMITTED"})),
  accounting:{unit:original.unit,currency:original.currency,valuationDate:original.valuationDate,discountFactors:original.discountFactors},
  requiredConsents:original.parties.map(party=>({partyId:party.id,requirementRef:party.requiredConsentRef,status:"PROPOSED",acceptanceObserved:false})),
  status:"PROPOSED_UNADMITTED",executionAuthorityGranted:false,settlementEstablished:false,protectedReceipt:null};
 const schedule:CoalitionProposedSchedule={...body,ref:ref("coalition-proposed-schedule",body)};
 validate(ctx,schedule,schedule.ref);
 return withAllocationPortfolio(ctx,async c=>{
  const previous=(await c.query("SELECT body,input_digest FROM finnor_os.s6_coalition_schedule_origins WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3",
   [ctx.auth.tenantId,actor(ctx),input.consumptionRef.id])).rows[0];
  if(previous){if(previous.input_digest!==digest)throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Schedule retry changed its actual S5 joins");
   validate(ctx,previous.body,previous.body.ref);return previous.body;}
  const held=(await c.query("SELECT status,revocation_reason,revision,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2",
   [ctx.auth.tenantId,schedule.reservationRef.id])).rows[0];
  const used=(await c.query("SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.consumption_id=$3",
   [ctx.auth.tenantId,actor(ctx),input.consumptionRef.id])).rows[0];
  if(!held||held.revocation_reason||held.status!=="CONSUMPTION_PENDING"||!used||used.status!=="INTENDED_PENDING_S6"||
   used.effect_ref!==null||!same(used.body.ref,input.consumptionRef)||!same(used.body.certificateRef,input.allocationRef)||
   !same(used.body.policyRef,selection.ref)||!same(held.envelopes,issued.certificate.check.envelopes)||
   Date.now()>=Date.parse(schedule.validUntil))throw denied();
  await assertDependencies(ctx,selection.dependencies.filter(dependency=>dependency.key!=="m3:s5-complete"),c,true);
  const snapshot=await allocationSnapshotInTransaction(c,ctx.auth.tenantId);
  const baseline={resources:snapshot.resources,outstanding:snapshot.outstanding.filter(row=>!same(row.reservationRef,schedule.reservationRef))};
  if(m3Hash(baseline)!==issued.problem.snapshotDigest)throw new AllocationContractError("STALE_INPUT","Complete S5 baseline changed before proposed schedule recording");
  const count=(await c.query("SELECT count(*)::int n FROM finnor_os.s6_coalition_schedule_origins WHERE tenant_id=$1",[ctx.auth.tenantId])).rows[0].n;
  if(count>=256)throw new AllocationContractError("LIMIT_EXCEEDED","Ordinary coalition schedule bound exceeded");
  await c.query("INSERT INTO finnor_os.s6_coalition_schedule_origins(tenant_id,principal_id,schedule_id,consumption_id,input_digest,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
   [ctx.auth.tenantId,actor(ctx),schedule.ref.id,input.consumptionRef.id,digest,JSON.stringify(schedule)]);
  const {ref:reference,...content}=schedule;
  await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:"S6",tenantId:ctx.auth.tenantId,principalId:actor(ctx)},
   {kind:"REFERENCE",identity:reference.id,payload:{reference:{...reference,content},rightsRefs:[schedule.rightsRef]}});
  return schedule;
 });
}
export async function readEnterpriseCoalitionSchedule(ctx:PeMutationContext,value:ExperimentRef):Promise<CoalitionProposedSchedule>{
 const schedule=await withAllocationPortfolio(ctx,async c=>{
  const row=(await c.query("SELECT body FROM finnor_os.s6_coalition_schedule_origins WHERE tenant_id=$1 AND principal_id=$2 AND schedule_id=$3",
   [ctx.auth.tenantId,actor(ctx),value.id])).rows[0];
  if(!row)throw denied();validate(ctx,row.body,value);return row.body as CoalitionProposedSchedule;
 });
 await resolveDecisionWork(ctx,schedule.workId).catch(error=>{
  if(error instanceof DecisionSliceError&&error.code==="UNAVAILABLE")throw denied();
  throw error;
 });
 const issued=await readEnterpriseCoalitionAllocation(ctx,schedule.allocationRef);
 await authorizeBeliefResources(ctx,issued.problem.selection.original.parties.map(party=>{
  const root=coalitionPartyRoot(party.partyRef);return {type:root.entityType,id:root.entityId};
 }));
 return schedule;
}
type ConsentInput={scheduleRef:ExperimentRef;partyId:string;proposalVersion:string;
 reportedStatus:"NO_RESPONSE"|"DECLINED"|"WITHDRAWN"|"REPORTED_ACCEPTED";idempotencyKey:string;
 evidence?:{sourceId:string;versionId:string;contentDigest:string}};
export async function recordEnterpriseCoalitionConsent(ctx:PeMutationContext,input:ConsentInput){
 assertCoalitionPlanningProfile();
 const schedule=await readEnterpriseCoalitionSchedule(ctx,input.scheduleRef),issued=await readEnterpriseCoalitionAllocation(ctx,schedule.allocationRef);
 const party=issued.problem.selection.original.parties.find(party=>party.id===input.partyId);
 if(!party||input.proposalVersion!==schedule.proposalVersion)throw new AllocationContractError("STALE_INPUT","Consent report binds different party or proposal terms");
 if(input.reportedStatus!=="NO_RESPONSE"&&!input.evidence)throw new AllocationContractError("INVALID_REQUEST","Reported participant response requires permissioned source evidence");
 if(input.evidence){const source=await readSourceObject(ctx,coalitionPartyRoot(party.partyRef),input.evidence.sourceId,input.evidence.versionId);
  if(source.content_hash!==input.evidence.contentDigest)throw new AllocationContractError("STALE_INPUT","Consent report evidence bytes changed");}
 const digest=m3Hash(input);
 return withAllocationPortfolio(ctx,async c=>{
  const prior=(await c.query("SELECT body,request_digest FROM finnor_os.s6_coalition_consent_events WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==digest)throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Consent history retry changed payload");return prior.body;}
  const count=(await c.query("SELECT count(*)::int n FROM finnor_os.s6_coalition_consent_events WHERE tenant_id=$1 AND schedule_id=$2",[ctx.auth.tenantId,schedule.ref.id])).rows[0].n;
  if(count>=256)throw new AllocationContractError("LIMIT_EXCEEDED","Consent history bound exceeded");
  const body={schema:"finnor.s6.coalition-consent-report.v1",scheduleRef:schedule.ref,partyId:party.id,
   proposalVersion:schedule.proposalVersion,reportedStatus:input.reportedStatus,evidence:input.evidence??null,
   reportedBy:actor(ctx),recordedAt:new Date().toISOString(),acceptanceObserved:false,executionAuthorityGranted:false,
   qualification:"ORDINARY_OWNER_REPORT_NOT_PARTY_SIGNATURE_OR_INDEPENDENT_ACCEPTANCE"};
  const event={...body,ref:ref("coalition-consent-report",body)};
  await c.query("INSERT INTO finnor_os.s6_coalition_consent_events(tenant_id,principal_id,schedule_id,event_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
   [ctx.auth.tenantId,actor(ctx),schedule.ref.id,event.ref.id,input.idempotencyKey,digest,JSON.stringify(event)]);
  return event;
 });
}
export async function readEnterpriseCoalitionConsentHistory(ctx:PeMutationContext,value:ExperimentRef){
 const schedule=await readEnterpriseCoalitionSchedule(ctx,value);
 return withAllocationPortfolio(ctx,async c=>(await c.query("SELECT body FROM finnor_os.s6_coalition_consent_events WHERE tenant_id=$1 AND principal_id=$2 AND schedule_id=$3 ORDER BY recorded_at,event_id",
  [ctx.auth.tenantId,actor(ctx),schedule.ref.id])).rows.map(row=>row.body));
}
