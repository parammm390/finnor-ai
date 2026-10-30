import type pg from "pg";
import type {ExperimentRef,AllocationReservation,AllocationConsumption} from "@finnor/shared-types";
import type {CoalitionProblem,CoalitionSelection,CoalitionAllocationProblem,CoalitionAllocationCertificate} from "../../../shared-types/src/coalition-programme";
import {R5_VERSION} from "../../../shared-types/src/coalition-programme";
import type {PeMutationContext} from "../types";
import {withAllocationPortfolio,allocationSnapshotInTransaction,appendAllocationExperienceInTransaction,
  type AllocationSnapshot} from "../allocation-store";
import {readEnterpriseCoalitionSelection,readEnterpriseControlDecisionContext} from "../enterprise-control";
import {allocationRef,AllocationContractError,prepareS5Experience,sameAllocationRef as same} from "../../../epistemic-runtime/src/allocation-contracts";
import {assertDependencies} from "../evidence-execution/store";
import {enqueueOwnerDeliveryInTransaction} from "../../../governed-execution/src/owner-delivery-store";
import {checkCoalitionAllocationPoint} from "./r5-allocation";
import {m3Hash} from "./v2-contracts";
import {authorizeBeliefResources} from "../enterprise-beliefs";
import {coalitionPartyRoot} from "./r5-owners";
import {originalPortfolioPopulation,Z1_PORTFOLIO} from "../../../epistemic-runtime/src/project-z/z1-shared-work/portfolio-population";

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const denied=()=>new AllocationContractError("PERMITTED_CONTEXT_UNAVAILABLE","Permitted coalition S5 context is unavailable");
export function assertCoalitionPlanningProfile():void{
 if(process.env.FINNOR_M3_PROFILE!=="DISPOSABLE_NATIVE"||process.env.NODE_ENV==="production"||process.env.FINNOR_ENVIRONMENT==="production")
  throw new AllocationContractError("BLOCKED_AUTHORITY","R5 owner writes require the configured disposable native profile; protected activation is unavailable");
}
const reference=(prefix:string,body:unknown):ExperimentRef=>allocationRef("S5",prefix,body,R5_VERSION);
type Issued={problem:CoalitionAllocationProblem;certificate:CoalitionAllocationCertificate;reservation:AllocationReservation|null};
function validate(ctx:PeMutationContext,problem:CoalitionAllocationProblem,certificate:CoalitionAllocationCertificate,value:ExperimentRef):void{
 const {ref,...body}=certificate,{ref:problemRef,...original}=problem;
 if(problem.schema!=="finnor.s5.coalition-allocation-problem.v1"||certificate.schema!=="finnor.s5.coalition-allocation-certificate.v1"||
  problem.tenantId!==ctx.auth.tenantId||problem.principalId!==actor(ctx)||
  certificate.tenantId!==ctx.auth.tenantId||certificate.principalId!==actor(ctx)||
  !same(ref,value)||!same(ref,reference("coalition-allocation-certificate",body))||
  !same(problemRef,reference("coalition-allocation-problem",original))||!same(problemRef,certificate.problemRef)||
  !same(problem.selection.ref,certificate.selectionRef)||certificate.executionAuthorityGranted!==false||
  certificate.protectedReceipt!==null||!same(certificate.check,checkCoalitionAllocationPoint(problem.selection,problem.mandate,
   {resources:problem.resources,outstanding:problem.outstanding,snapshotDigest:problem.snapshotDigest}))||!certificate.check.feasible)
  throw denied();
 if(Buffer.byteLength(JSON.stringify({problem,certificate}))>8388608)
  throw new AllocationContractError("LIMIT_EXCEEDED","Coalition S5 origin exceeds 8 MiB");
}
async function deliver(ctx:PeMutationContext,c:pg.PoolClient,value:{ref:ExperimentRef},rightsRef:string):Promise<void>{
 const {ref,...content}=value;
 await enqueueOwnerDeliveryInTransaction(c,{semanticOwner:"S5",tenantId:ctx.auth.tenantId,principalId:actor(ctx)},
  {kind:"REFERENCE",identity:ref.id,payload:{reference:{...ref,content},rightsRefs:[rightsRef]}});
}
async function stored(ctx:PeMutationContext,c:pg.PoolClient,value:ExperimentRef):Promise<Issued>{
 if(value.owner!=="S5"||value.version!==R5_VERSION||value.id!=="coalition-allocation-certificate:"+value.contentDigest)throw denied();
 const row=(await c.query("SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3",
  [ctx.auth.tenantId,actor(ctx),value.contentDigest])).rows[0];
 if(!row)throw denied();validate(ctx,row.problem,row.certificate,value);
 try{await authorizeBeliefResources(ctx,row.problem.selection.original.parties.map((party:CoalitionProblem["parties"][number])=>{
  const root=coalitionPartyRoot(party.partyRef);return {type:root.entityType,id:root.entityId};
 }));}catch{throw denied();}
 const held=(await c.query("SELECT o.body,s.status,s.envelopes,s.revocation_reason,s.revision FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.allocation_digest=$3",
  [ctx.auth.tenantId,actor(ctx),value.contentDigest])).rows[0];
 if(held){const {ref,...body}=held.body as AllocationReservation;
  if(!same(ref,allocationRef("S5","allocation-reservation",body))||!same(body.certificateRef,value)||
   !same(body.envelopes,row.certificate.check.envelopes))throw denied();}
 return {problem:row.problem,certificate:row.certificate,reservation:held?
  {...held.body,status:held.status,envelopes:held.envelopes,revocationReason:held.revocation_reason,revision:held.revision}:null};
}
/** Only an actual immutable matching origin can explain a changed snapshot.
 * Foreign Works/other commitments remain in the complete resource basis. */
export async function coalitionSelectionSnapshot(ctx:PeMutationContext,selection:CoalitionSelection,current:AllocationSnapshot):Promise<AllocationSnapshot>{
 if(current.snapshotDigest===selection.resourceSnapshotDigest)return current;
 return withAllocationPortfolio(ctx,async c=>{
  const fresh=await allocationSnapshotInTransaction(c,ctx.auth.tenantId);
  const rows=(await c.query("SELECT content_digest FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND certificate->>'schema'='finnor.s5.coalition-allocation-certificate.v1' AND certificate->'selectionRef'->>'contentDigest'=$3 LIMIT 2",
   [ctx.auth.tenantId,actor(ctx),selection.ref.contentDigest])).rows;
  if(rows.length!==1)return fresh;
  const issued=await stored(ctx,c,referenceFromDigest(rows[0].content_digest));
  if(!same(issued.problem.selection,selection)||!issued.reservation)return fresh;
  const outstanding=fresh.outstanding.filter(row=>!same(row.reservationRef,issued.reservation!.ref));
  const body={resources:fresh.resources,outstanding};
  return {...body,snapshotDigest:m3Hash(body)};
 });
}
const referenceFromDigest=(digest:string):ExperimentRef=>({owner:"S5",id:"coalition-allocation-certificate:"+digest,version:R5_VERSION,contentDigest:digest});

export async function coalitionOriginalSnapshot(ctx:PeMutationContext,original:CoalitionProblem,sourceRef:ExperimentRef,current:AllocationSnapshot):Promise<AllocationSnapshot>{
 return withAllocationPortfolio(ctx,async c=>{
  const rows=(await c.query("SELECT content_digest FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND certificate->>'schema'='finnor.s5.coalition-allocation-certificate.v1' AND problem->'selection'->'originalRef'->>'contentDigest'=$3 LIMIT 2",
   [ctx.auth.tenantId,actor(ctx),sourceRef.contentDigest])).rows;
  if(rows.length!==1)return current;
  const issued=await stored(ctx,c,referenceFromDigest(rows[0].content_digest));
  if(!issued.reservation||!same(issued.problem.selection.original,original)||!same(issued.problem.selection.originalRef,sourceRef))return current;
  const body={resources:current.resources,outstanding:current.outstanding.filter(row=>!same(row.reservationRef,issued.reservation!.ref))};
  return {...body,snapshotDigest:m3Hash(body)};
 });
}

export async function clearEnterpriseCoalitionAllocation(ctx:PeMutationContext,input:{selectionRef:ExperimentRef;idempotencyKey:string}):Promise<Issued>{
 assertCoalitionPlanningProfile();
 const digest=m3Hash(input);
 const previous=await withAllocationPortfolio(ctx,async c=>{
  const row=(await c.query("SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(row&&row.request_digest!==digest)throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Coalition reservation retry changed payload");
  return row?.allocation_digest?stored(ctx,c,referenceFromDigest(row.allocation_digest)):null;
 });
 if(previous)return previous;
 const selection=await readEnterpriseCoalitionSelection(ctx,input.selectionRef);
 const {policy}=await readEnterpriseControlDecisionContext(ctx,selection.incumbentPolicyRef);
 return withAllocationPortfolio(ctx,async c=>{
  const replay=(await c.query("SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(replay){if(replay.request_digest!==digest)throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Coalition reservation payload changed");
   if(replay.allocation_digest)return stored(ctx,c,referenceFromDigest(replay.allocation_digest));}
  await assertDependencies(ctx,selection.dependencies,c,true);
  const latest=(await c.query("SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
   [ctx.auth.tenantId,selection.workId])).rows[0];
  if(latest?.id!==selection.workRevision||Date.now()>=Date.parse(selection.validUntil))
   throw new AllocationContractError("STALE_INPUT","Original coalition Work or validity changed during commitment");
  const pending=(await c.query("SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated')",[ctx.auth.tenantId])).rows[0].n;
  if(pending)throw new AllocationContractError("STALE_INPUT","Unaccounted S6 effects prevent coalition commitment");
  const snapshot=await allocationSnapshotInTransaction(c,ctx.auth.tenantId);
  if(snapshot.snapshotDigest!==selection.resourceSnapshotDigest)
   throw new AllocationContractError("STALE_INPUT","Original complete S5 snapshot changed before joint reservation");
  if(originalPortfolioPopulation(snapshot.outstanding).other>=Z1_PORTFOLIO.other)throw new AllocationContractError("LIMIT_EXCEEDED","Canonical generic commitment bound exceeded");
  const check=checkCoalitionAllocationPoint(selection,policy.mandate,snapshot);
  if(!check.feasible)throw new AllocationContractError("INVALID_CANDIDATE",check.reasons.join(";"));
  const problemBody:Omit<CoalitionAllocationProblem,"ref">={schema:"finnor.s5.coalition-allocation-problem.v1",
   tenantId:ctx.auth.tenantId,principalId:actor(ctx),selection,mandate:policy.mandate,...snapshot};
  const problem:CoalitionAllocationProblem={...problemBody,ref:reference("coalition-allocation-problem",problemBody)};
  const certificateBody:Omit<CoalitionAllocationCertificate,"ref">={schema:"finnor.s5.coalition-allocation-certificate.v1",
   tenantId:ctx.auth.tenantId,principalId:actor(ctx),selectionRef:selection.ref,problemRef:problem.ref,
   mandateRef:selection.mandateRef,rightsRef:selection.rightsRef,snapshotDigest:snapshot.snapshotDigest,
   validUntil:selection.validUntil,policyBindings:[{policyRef:selection.ref,demandDigest:selection.demandDigest}],check,
   qualification:"ORIGINAL_CANONICAL_POINT_NOT_CONSTRAINED_FAMILY_OPTIMUM",executionAuthorityGranted:false,protectedReceipt:null};
  const certificate:CoalitionAllocationCertificate={...certificateBody,ref:reference("coalition-allocation-certificate",certificateBody)};
  validate(ctx,problem,certificate,certificate.ref);
  const prior=(await c.query("SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==digest)throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Coalition reservation payload changed");
   if(prior.allocation_digest)return stored(ctx,c,referenceFromDigest(prior.allocation_digest));}
  await c.query("INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT(tenant_id,content_digest) DO NOTHING",
   [ctx.auth.tenantId,actor(ctx),certificate.ref.contentDigest,JSON.stringify(problem),JSON.stringify(certificate)]);
  const body:Omit<AllocationReservation,"ref">={schema:"finnor.allocation-reservation.v1",tenantId:ctx.auth.tenantId,principalId:actor(ctx),
   certificateRef:certificate.ref,idempotencyKey:input.idempotencyKey,requestDigest:digest,createdAt:new Date().toISOString(),
   envelopes:check.envelopes,status:"RESERVED",revocationReason:null,revision:1,executionAuthorityGranted:false,protectedReceipt:null};
  const reservation:AllocationReservation={...body,ref:allocationRef("S5","allocation-reservation",body)};
  await c.query("INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,principal_id,idempotency_key) DO UPDATE SET allocation_digest=excluded.allocation_digest",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey,digest,certificate.ref.contentDigest]);
  await c.query("INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)",
   [ctx.auth.tenantId,actor(ctx),reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(reservation)]);
  await c.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,'RESERVED',$4::jsonb)",
   [ctx.auth.tenantId,reservation.ref.id,certificate.ref.contentDigest,JSON.stringify(check.envelopes)]);
  await deliver(ctx,c,problem,selection.rightsRef);await deliver(ctx,c,certificate,selection.rightsRef);await deliver(ctx,c,reservation,selection.rightsRef);
  await appendAllocationExperienceInTransaction(ctx,c,[prepareS5Experience(policy.mandate,"RESERVATION",reservation.ref.id,
   {selectionRef:selection.ref,certificateRef:certificate.ref,reservation},[selection.ref.id],"H0")]);
  return {problem,certificate,reservation};
 });
}
export async function readEnterpriseCoalitionAllocation(ctx:PeMutationContext,value:ExperimentRef):Promise<Issued>{
 return withAllocationPortfolio(ctx,c=>stored(ctx,c,value));
}
export async function releaseEnterpriseCoalitionAllocation(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;idempotencyKey:string}):Promise<AllocationReservation>{
 assertCoalitionPlanningProfile();
 return withAllocationPortfolio(ctx,async c=>{
  const issued=await stored(ctx,c,input.allocationRef),reservation=issued.reservation;
  if(!reservation)throw denied();
  const count=(await c.query("SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND reservation_id=$2",
   [ctx.auth.tenantId,reservation.ref.id])).rows[0].n;
  if(count)throw new AllocationContractError("BLOCKED_AUTHORITY","Joint pending handoff must retain its complete S5 envelope");
  const digest=m3Hash({operation:"COALITION_RELEASE_UNTOUCHED",...input});
  const prior=(await c.query("SELECT request_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(prior&&prior.request_digest!==digest)throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Joint release retry changed payload");
  if(reservation.status==="RELEASED")return reservation;
  await c.query("INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey,digest,input.allocationRef.contentDigest]);
  await c.query("UPDATE finnor_os.s5_reservations SET status='RELEASED',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
   [ctx.auth.tenantId,reservation.ref.id]);
  const released:AllocationReservation={...reservation,status:"RELEASED",revision:reservation.revision+1};
  await appendAllocationExperienceInTransaction(ctx,c,[prepareS5Experience(issued.problem.mandate,"RELEASE",reservation.ref.id,
   {reservation:released,basis:"NO_JOINT_HANDOFF_INTENT_RECORDED",externalCancellationClaimed:false},[input.allocationRef.id],"H0")]);
  return released;
 });
}
export async function consumeEnterpriseCoalitionAllocation(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;idempotencyKey:string}):Promise<AllocationConsumption>{
 assertCoalitionPlanningProfile();
 const issued=await readEnterpriseCoalitionAllocation(ctx,input.allocationRef);
 await readEnterpriseCoalitionSelection(ctx,issued.problem.selection.ref);
 const digest=m3Hash(input);
 return withAllocationPortfolio(ctx,async c=>{
  const current=await stored(ctx,c,input.allocationRef),reservation=current.reservation;
  if(!reservation)throw denied();
  const prior=(await c.query("SELECT body,request_digest FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
   [ctx.auth.tenantId,actor(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==digest||!same(prior.body.certificateRef,input.allocationRef))
   throw new AllocationContractError("IDEMPOTENCY_CONFLICT","Joint consumption retry changed payload");return prior.body;}
  if(reservation.status!=="RESERVED"||reservation.revocationReason||Date.now()>=Date.parse(current.certificate.validUntil))
   throw new AllocationContractError("STALE_INPUT","Current untouched joint reservation required");
  const snapshot=await allocationSnapshotInTransaction(c,ctx.auth.tenantId);
  const baseline={resources:snapshot.resources,outstanding:snapshot.outstanding.filter(row=>!same(row.reservationRef,reservation.ref))};
  if(m3Hash(baseline)!==current.problem.snapshotDigest)
   throw new AllocationContractError("STALE_INPUT","Concurrent resources or retained commitments changed before joint consumption");
  await assertDependencies(ctx,current.problem.selection.dependencies.filter(dependency=>dependency.key!=="m3:s5-complete"),c,true);
  const check=checkCoalitionAllocationPoint(current.problem.selection,current.problem.mandate,
   {...baseline,snapshotDigest:m3Hash(baseline)});
  if(!check.feasible||!same(check,current.certificate.check))throw new AllocationContractError("STALE_INPUT","Original canonical joint envelope changed");
  const selection=current.problem.selection;
  const body:Omit<AllocationConsumption,"ref">={schema:"finnor.allocation-consumption.v1",reservationRef:reservation.ref,
   certificateRef:current.certificate.ref,policyRef:selection.ref,demandDigest:selection.demandDigest,
   nodeId:"joint-coalition-programme",decisionRef:selection.ref,idempotencyKey:input.idempotencyKey,requestDigest:digest,
   createdAt:new Date().toISOString(),status:"INTENDED_PENDING_S6",compatibleScenarioIds:selection.original.worlds.map(world=>world.id).sort(),
   effectRef:null,envelope:check.envelopes,executionAuthorityGranted:false,protectedReceipt:null};
  const consumption:AllocationConsumption={...body,ref:allocationRef("S5","allocation-consumption",body)};
  await c.query("INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
   [ctx.auth.tenantId,actor(ctx),consumption.ref.id,reservation.ref.id,selection.ref.id,body.nodeId,input.idempotencyKey,digest,JSON.stringify(consumption)]);
  await c.query("INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,'INTENDED_PENDING_S6',1)",[ctx.auth.tenantId,consumption.ref.id]);
  await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
   [ctx.auth.tenantId,reservation.ref.id]);
  await deliver(ctx,c,consumption,selection.rightsRef);
  await appendAllocationExperienceInTransaction(ctx,c,[prepareS5Experience(current.problem.mandate,"CONSUMPTION",consumption.ref.id,
   {consumption,actualConsumption:"UNKNOWN_PENDING_QUALIFIED_S6",responsibilityRetained:true},[selection.ref.id,reservation.ref.id],"H0")]);
  return consumption;
 });
}
