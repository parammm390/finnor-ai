import type pg from 'pg';
import { withTenantTransaction } from '@finnor/db';
import type { AllocationResource, AllocationResourceInput, AllocationReservation, AllocationConsumption, AllocationOutstandingCommitment, AllocationCertificate, CanonicalAllocationProblem, ExperimentRef, AllocationCheck, S5ExperienceEvent,DurableObligation } from '@finnor/shared-types';
import { AllocationContractError, allocationRef, sameAllocationRef, S5_VERSION, prepareS5Experience,allocationQuantity,allocationDecimal } from '../../epistemic-runtime/src/allocation-contracts';
import {LedgerFault} from '../../governed-execution/src/protocol';
import { epistemicHash } from '../../epistemic-runtime/src/source-precedence';
import { enqueueOwnerDeliveryInTransaction } from '../../governed-execution/src/owner-delivery-store';
import type { PeMutationContext } from './types';

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const denied=()=>new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE','Permitted S5 context is unavailable');
const conflict=()=>new AllocationContractError('IDEMPOTENCY_CONFLICT','S5 idempotency key has a different semantic payload');
function bounded(value:unknown):void {if(Buffer.byteLength(JSON.stringify(value))>8*1024*1024)throw new AllocationContractError('LIMIT_EXCEEDED','S5 record exceeds 8 MiB');}
async function authorize(ctx:PeMutationContext,c:pg.PoolClient):Promise<void>{
  if(ctx.auth.role!=='owner'||actor(ctx)!==ctx.auth.userId)throw denied();
  const rows=await c.query("SELECT id FROM finnor_os.users WHERE id=$1 AND tenant_id=$2 AND status='active' AND role='owner' FOR SHARE",[ctx.auth.userId,ctx.auth.tenantId]);
  if(rows.rowCount!==1)throw denied();
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
   ||value.schema==='finnor.allocation-resource.v1'&&value.ownerRef.id!==actor(ctx))throw denied();
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
async function locked<T>(ctx:PeMutationContext,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
  for(let attempt=0;;attempt++)try{return await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx)},async(_db,c)=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`s5-portfolio:${ctx.auth.tenantId}`]);await authorize(ctx,c);return fn(c);
  });}catch(e){if(attempt<2&&['40001','40P01'].includes((e as {code?:string}).code??''))continue;throw e;}
}
export interface AllocationSnapshot {resources:AllocationResource[];outstanding:AllocationOutstandingCommitment[];snapshotDigest:string}
async function snapshot(c:pg.PoolClient,tenantId:string):Promise<AllocationSnapshot>{
  const resources=(await c.query('SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 ORDER BY r.resource_id LIMIT 17',[tenantId])).rows.map(r=>r.body as AllocationResource);
  const live=(await c.query('SELECT s.*,o.body,p.certificate FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id) JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest WHERE s.tenant_id=$1 AND s.status<>\'RELEASED\' ORDER BY s.reservation_id LIMIT 257',[tenantId])).rows;
  if(resources.length>16||live.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','S5 registry/live commitment bound exceeded');
  const outstanding:AllocationOutstandingCommitment[]=[];
  for(const row of live){const origins=row.body as AllocationReservation,cert=row.certificate as AllocationCertificate;
    const effects=(await c.query('SELECT st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND st.effect_ref IS NOT NULL',[tenantId,row.reservation_id])).rows.map(r=>r.effect_ref as ExperimentRef);
    outstanding.push({reservationRef:origins.ref,certificateRef:origins.certificateRef,envelopes:row.envelopes,status:row.status,policyRefs:cert.policyBindings.map(b=>b.policyRef),effectRefs:effects});
  }const value={resources,outstanding};bounded(value);return {...value,snapshotDigest:epistemicHash(value)};
}
export async function readAllocationSnapshot(ctx:PeMutationContext):Promise<AllocationSnapshot>{return locked(ctx,c=>snapshot(c,ctx.auth.tenantId));}
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
    if(current){const invalidated=(await c.query("UPDATE finnor_os.s5_reservations SET revocation_reason='RESOURCE_REVISION_CHANGED',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND status<>'RELEASED' AND envelopes @> $2::jsonb RETURNING allocation_digest,reservation_id,revision",[ctx.auth.tenantId,JSON.stringify([{resourceId:input.resourceId}])])).rows;
      for(const old of invalidated){const proposal=(await c.query('SELECT problem FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',[ctx.auth.tenantId,old.allocation_digest])).rows[0];
        await appendExperience(ctx,c,[prepareS5Experience(proposal.problem.mandate,'REVISION',ref.id,{resourceRef:ref,priorRef:current.ref,reservationRef:old.reservation_id,reservationRevision:old.revision,clearanceInvalidated:true,exposureRetained:true},[current.ref.id,old.reservation_id],'H0')]);}}
    await c.query('INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,\'RESOURCE_REVISION\',$4::jsonb)',[ctx.auth.tenantId,ref.id,body.revision,JSON.stringify(resource)]);return resource;
  });
}
function validateStored(ctx:PeMutationContext,problem:CanonicalAllocationProblem,certificate:AllocationCertificate,ref:ExperimentRef):void {
  const {ref:actual,...body}=certificate;
  if(problem.tenantId!==ctx.auth.tenantId||problem.principalId!==actor(ctx)||certificate.tenantId!==ctx.auth.tenantId||certificate.principalId!==actor(ctx)||!sameAllocationRef(actual,ref)||!sameAllocationRef(actual,allocationRef('S5','allocation-certificate',body))||!sameAllocationRef(problem.ref,certificate.problemRef))throw denied();bounded({problem,certificate});
}
async function stored(ctx:PeMutationContext,c:pg.PoolClient,value:ExperimentRef):Promise<{problem:CanonicalAllocationProblem;certificate:AllocationCertificate;reservation:AllocationReservation|null}>{
  if(value.owner!=='S5'||value.version!==S5_VERSION||value.id!==`allocation-certificate:${value.contentDigest}`)throw denied();
  const r=(await c.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',[ctx.auth.tenantId,actor(ctx),value.contentDigest])).rows[0];if(!r)throw denied();validateStored(ctx,r.problem,r.certificate,value);
  const projection=(await c.query('SELECT o.body,s.status,s.envelopes,s.revocation_reason,s.revision FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id) WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.allocation_digest=$3',[ctx.auth.tenantId,actor(ctx),value.contentDigest])).rows[0];
  let reservation:AllocationReservation|null=null;
  await enqueueProposalOrigins(ctx,c,r.problem,r.certificate);
  if(projection){const {ref,...origin}=projection.body as AllocationReservation;if(!sameAllocationRef(ref,allocationRef('S5','allocation-reservation',origin)))throw denied();await enqueueAllocationOrigin(ctx,c,projection.body,r.certificate.rightsRef);reservation={...projection.body,status:projection.status,envelopes:projection.envelopes,revocationReason:projection.revocation_reason,revision:projection.revision};}
  return {problem:r.problem,certificate:r.certificate,reservation};
}
export async function persistAllocationProposal(ctx:PeMutationContext,problem:CanonicalAllocationProblem,certificate:AllocationCertificate):Promise<void>{
  validateStored(ctx,problem,certificate,certificate.ref);await locked(ctx,async c=>{const existing=(await c.query('SELECT problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',[ctx.auth.tenantId,certificate.ref.contentDigest])).rows[0];
    if(existing){if(!sameAllocationRef(existing,{problem,certificate}))throw new AllocationContractError('INVALID_CANDIDATE','Conflicting immutable allocation proposal');await enqueueProposalOrigins(ctx,c,problem,certificate);return;}
    await c.query('INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[ctx.auth.tenantId,actor(ctx),certificate.ref.contentDigest,JSON.stringify(problem),JSON.stringify(certificate)]);
    await enqueueProposalOrigins(ctx,c,problem,certificate);
    await appendExperience(ctx,c,[prepareS5Experience(problem.mandate,'CANDIDATE',certificate.ref.id,{certificateRef:certificate.ref,check:certificate.check,optimization:certificate.optimization},[problem.ref.id]),prepareS5Experience(problem.mandate,'COST',certificate.compute.id,{compute:certificate.compute})]);
  });
}
export async function readStoredAllocation(ctx:PeMutationContext,ref:ExperimentRef){return locked(ctx,c=>stored(ctx,c,ref));}
export async function readAllocationReplay(ctx:PeMutationContext,key:string,digest:string){
  return locked(ctx,async c=>{const r=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key])).rows[0];
    if(r&&r.request_digest!==digest)throw conflict();if(r?.allocation_digest)return stored(ctx,c,{owner:'S5',version:S5_VERSION,id:`allocation-certificate:${r.allocation_digest}`,contentDigest:r.allocation_digest});
    if(!r)await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest) VALUES($1,$2,$3,$4)',[ctx.auth.tenantId,actor(ctx),key,digest]);return null;});
}
export async function commitAllocationReservation(ctx:PeMutationContext,problem:CanonicalAllocationProblem,certificate:AllocationCertificate,key:string,digest:string,recheck:(resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[])=>Promise<AllocationCheck>,deadlineAt:number):Promise<AllocationReservation>{
  return locked(ctx,async c=>{
    if(performance.now()>=deadlineAt)throw new AllocationContractError('LIMIT_EXCEEDED','Whole allocation decision deadline exhausted during commitment contention');
    const req=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key])).rows[0];if(!req||req.request_digest!==digest)throw conflict();
    if(req.allocation_digest){const previous=await stored(ctx,c,{owner:'S5',version:S5_VERSION,id:`allocation-certificate:${req.allocation_digest}`,contentDigest:req.allocation_digest});if(previous.reservation)return previous.reservation;throw denied();}
    const issued=await stored(ctx,c,certificate.ref);if(!sameAllocationRef(issued.problem,problem)||!sameAllocationRef(issued.certificate,certificate))throw new AllocationContractError('INVALID_CANDIDATE','Candidate differs from persisted issuer');
    const current=await snapshot(c,ctx.auth.tenantId);
    if(current.snapshotDigest!==problem.snapshotDigest||Date.now()>=Date.parse(certificate.validUntil))throw new AllocationContractError('STALE_INPUT','Solved allocation snapshot expired or changed before commitment');
    if(current.outstanding.length>=256)throw new AllocationContractError('LIMIT_EXCEEDED','Live commitment registry is full; reconciliation and release remain permitted');
    const check=await recheck(current.resources,current.outstanding);if(!check.feasible||!sameAllocationRef(check,certificate.check))throw new AllocationContractError('INVALID_CANDIDATE','Independent current-state canonical check rejects allocation');
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
  const issued=await stored(ctx,c,ref);const rows=(await c.query('SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) JOIN finnor_os.s5_reservation_origins ro USING(tenant_id,reservation_id) WHERE co.tenant_id=$1 AND co.principal_id=$2 AND ro.allocation_digest=$3 ORDER BY co.consumption_id',[ctx.auth.tenantId,actor(ctx),ref.contentDigest])).rows;
  const result:AllocationConsumption[]=[];
  for(const row of rows){const {ref,...body}=row.body as AllocationConsumption;if(!sameAllocationRef(ref,allocationRef('S5','allocation-consumption',body)))throw denied();await enqueueAllocationOrigin(ctx,c,row.body,issued.certificate.rightsRef);result.push({...row.body,status:row.status,effectRef:row.effect_ref});}
  return result;
}
export async function readAllocationConsumptions(ctx:PeMutationContext,ref:ExperimentRef){return locked(ctx,c=>consumptions(ctx,c,ref));}
export async function recordAllocationConsumption(ctx:PeMutationContext,reservationRef:ExperimentRef,body:Omit<AllocationConsumption,'ref'>,compatibleScenarioIds:string[],recheck:(resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[])=>Promise<AllocationCheck>):Promise<AllocationConsumption>{
  return locked(ctx,async c=>{
    const issued=await stored(ctx,c,body.certificateRef),reservation=issued.reservation;if(!reservation||!sameAllocationRef(reservation.ref,reservationRef)||reservation.status==='RELEASED'||reservation.revocationReason||Date.now()>=Date.parse(issued.certificate.validUntil))throw new AllocationContractError('STALE_INPUT','Current unrevoked reserved allocation required');
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
  return locked(ctx,async c=>{const issued=await stored(ctx,c,ref),r=issued.reservation;if(!r)throw denied();
    const digest=epistemicHash({operation:'RELEASE_UNTOUCHED',ref}),prior=(await c.query('SELECT request_digest,allocation_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,actor(ctx),key])).rows[0];if(prior&&prior.request_digest!==digest)throw conflict();
    const uses=await consumptions(ctx,c,ref);if(uses.length)throw new AllocationContractError('BLOCKED_AUTHORITY','Pending/unknown external handoff requires qualified S6 reconciliation before release');
    if(!prior)await c.query('INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5)',[ctx.auth.tenantId,actor(ctx),key,digest,ref.contentDigest]);
    if(r.status==='RELEASED')return r;
    await c.query('UPDATE finnor_os.s5_reservations SET status=\'RELEASED\',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,r.ref.id]);
    const released={...r,status:'RELEASED' as const,revision:r.revision+1};await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RELEASE',r.ref.id,{reservation:released,basis:'NO_S5_HANDOFF_INTENT_OR_EFFECT_EVER_RECORDED',externalCancellationClaimed:false},[ref.id],'H0')]);return released;
  });
}
export async function retainAllocationReconciliation(ctx:PeMutationContext,ref:ExperimentRef,expectedRevision:number,observations:Record<string,unknown>):Promise<AllocationReservation>{
  return locked(ctx,async c=>{const issued=await stored(ctx,c,ref),r=issued.reservation;if(!r||r.revision!==expectedRevision)throw new AllocationContractError('STALE_INPUT','Reconciliation reservation revision changed');
    const uses=await consumptions(ctx,c,ref);if(!uses.length||r.status==='RELEASED')return r;
    if(r.status!=='UNKNOWN_OUTCOME')await c.query('UPDATE finnor_os.s5_reservations SET status=\'UNKNOWN_OUTCOME\',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,r.ref.id]);
    for(const use of uses.filter(u=>u.status==='INTENDED_PENDING_S6'))await c.query('UPDATE finnor_os.s5_consumption_states SET status=\'UNKNOWN_OUTCOME\',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2',[ctx.auth.tenantId,use.ref.id]);
    bounded(observations);const retained={...r,status:'UNKNOWN_OUTCOME' as const,revision:r.status==='UNKNOWN_OUTCOME'?r.revision:r.revision+1};
    await appendExperience(ctx,c,[prepareS5Experience(issued.problem.mandate,'RECONCILIATION',r.ref.id,{observations,reservation:retained,exposureRetained:true,qualifiedSettlement:null,requiredOwner:'S6'},[ref.id,...uses.map(u=>u.ref.id)],'H0')]);return retained;
  });
}
export async function persistAllocationExperience(ctx:PeMutationContext,events:S5ExperienceEvent[]):Promise<void>{await locked(ctx,c=>appendExperience(ctx,c,events));}

/** Consume authenticated S6 evidence under S5's existing portfolio lock. Costs and
 * released capacity are different claims: unmetered settlement retains occupation. */
export async function applyProtectedAllocationSettlement(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef;obligation:any;event:Record<string,any>;receipt:Record<string,any>}){
 return locked(ctx,async c=>{
  const issued=await stored(ctx,c,input.allocationRef),r=issued.reservation,uses=await consumptions(ctx,c,input.allocationRef),use=uses.find(u=>sameAllocationRef(u.ref,input.consumptionRef));
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
  const issued=await stored(ctx,c,input.allocationRef),r=issued.reservation,use=(await consumptions(ctx,c,input.allocationRef)).find(u=>sameAllocationRef(u.ref,input.consumptionRef));
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
