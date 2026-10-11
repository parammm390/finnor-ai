import type { AllocationCheck, AllocationEnvelope, AllocationResource, ExperimentRef } from '../../../shared-types/src';
import type { AffineFamilySource } from '../../../shared-types/src/decision-atlas';
import type { AllocationSnapshot } from '../allocation-store';
import { allocationDerivedQuantity, parseAllocationResource, sameAllocationRef } from '../../../epistemic-runtime/src/allocation-contracts';
import { allocationResourceUsage, verifyCanonicalResourceSchedules } from '../../../epistemic-runtime/src/allocation-checker';
import { atlasHash, encode, evaluate, rational, Z, add, sub, type Q } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { lowerOriginal } from '../../../epistemic-runtime/src/policy-atlas/model';
import { R7Error } from './contracts';

export interface ExactAllocationCheck {
  schema:'finnor.s5.exact-affine-check.v1';feasible:boolean;reasons:string[];
  envelopes:AllocationEnvelope[];snapshotDigest:string;policyBindings:Array<{policyRef:ExperimentRef;demandDigest:string}>;
  witnesses:AllocationCheck['witnesses'];
  resourceChecker:'CANONICAL_RESOURCE_PATH_KERNEL_V1';
  numericalSemantics:'EXACT_RATIONAL_ZERO_TOLERANCE';executionAuthorityGranted:false;
}
const zeros=(n:number)=>Array.from({length:n},()=>Z);
export function exactAvailable(snapshot:AllocationSnapshot,r:AllocationResource,t:number):Q|null {
  if(r.availability[t]?.amount===null||r.availability[t]?.basis!=='REPORTED_AVAILABLE')return null;
  const h=r.horizon.periods,base=r.existingUse.map(allocationDerivedQuantity);
  for(const commitment of snapshot.outstanding)for(const e of commitment.envelopes)if(e.resourceId===r.resourceId){
    if(e.quantities.length!==h+1||!sameAllocationRef(e.horizon,r.horizon)||e.kind!==r.kind||e.unit!==r.unit)return null;
    e.quantities.forEach((q,i)=>base[i]=add(base[i]!,allocationDerivedQuantity(q)));
  }
  return sub(sub(allocationDerivedQuantity(r.availability[t]!.amount!),allocationDerivedQuantity(r.safetyMargin)),allocationResourceUsage(r.kind,base,t));
}
/** Business revisions never supply S5 coordinates. The canonical snapshot
 * supplies those values, including outstanding UNKNOWN occupation. */
export function currentExactParameterValues(source:AffineFamilySource,snapshot:AllocationSnapshot,values:string[]):string[]{
  return source.domain.parameters.map((p,i)=>{
    if(p.owner==='BUSINESS_OWNER')return values[i]!;
    const r=snapshot.resources.find(r=>r.resourceId===p.resourceId),m=source.mandate,
      available=r?exactAvailable(snapshot,r,p.resourcePeriod!):null;
    if(!r||available===null||r.unit!==p.unit||r.currency!==p.currency||r.revoked||
      r.tenantId!==m.tenantId||r.ownerRef.id!==m.principalId||r.rightsRef!==m.rightsRef||
      !sameAllocationRef(r.horizon,m.horizon)||Date.parse(r.knowledgeAt)>Date.now()||Date.parse(r.validUntil)<=Date.now())
      throw new R7Error('UNSUPPORTED','Registered S5 parameter is unavailable or incompatible');
    return encode(available);
  });
}
/** Reconstruct selected original whole-world schedules, not cached availability. */
export function checkExactAllocation(source:AffineFamilySource,snapshot:AllocationSnapshot,policyId:string,values:string[],root:{entityType:string;entityId:string},asOf=Date.now()):ExactAllocationCheck {
  const m=source.mandate,h=m.horizon.periods,point=values.map(v=>rational(v,256)),policy=source.policies.find(p=>p.id===policyId);
  const reasons:string[]=[];
  const failed=(reason:string)=>{if(!reasons.includes(reason))reasons.push(reason);};
  const modeled=source.domain.parameters.filter(p=>p.owner==='S5');
  const resources=new Map(snapshot.resources.map(r=>[r.resourceId,r]));
  for(const r of snapshot.resources){
    const {ref:_,revision:_r,priorRef:_p,...raw}=r;parseAllocationResource(raw);
    if(r.tenantId!==m.tenantId||r.ownerRef.id!==m.principalId||r.rightsRef!==m.rightsRef||!sameAllocationRef(r.horizon,m.horizon)||
      r.revoked||Date.parse(r.knowledgeAt)>asOf||Date.parse(r.validUntil)<=asOf||
      !r.permittedRoots.some(p=>sameAllocationRef(p,root)))failed('CURRENT_RESOURCE_SEMANTICS:'+r.resourceId);
    if(r.availability.some(a=>a.amount===null||a.basis!=='REPORTED_AVAILABLE'))failed('CURRENT_AVAILABILITY_UNKNOWN:'+r.resourceId);
  }
  if(!policy)failed('ORIGINAL_POLICY_MISSING');
  if(snapshot.outstanding.some(o=>o.policyRefs.some(ref=>ref.id===policy?.ref.id)))failed('ORIGINAL_POLICY_ALREADY_COMMITTED');
  for(const p of modeled){
    const r=resources.get(p.resourceId!),current=r?exactAvailable(snapshot,r,p.resourcePeriod!):null,i=source.domain.parameters.indexOf(p);
    if(!r||r.unit!==p.unit||r.currency!==p.currency||current===null||current.compare(point[i]!)!==0)failed('CURRENT_S5_PARAMETER_BINDING:'+p.id);
  }
  for(const d of m.dimensions){
    const r=resources.get(d.resourceId);
    if(!r||r.unit!==d.unit||r.resourceClass!==d.resourceClass||
      (d.component==='OCCUPANCY')!==Boolean(r&&['OCCUPANCY','EXPOSURE'].includes(r.kind)))failed('ORIGINAL_DIMENSION_RESOURCE_BINDING:'+d.id);
  }
  for(const [id,unit,klass]of [[m.funding.costResourceId,m.quantityBasis.unit,'CASH'],[m.funding.liabilityResourceId,m.quantityBasis.unit,'CASH'],
    [m.funding.humanResourceId,'seconds','HUMAN_ATTENTION']] as const)if(id!==null){
    const r=resources.get(id);if(!r||r.unit!==unit||r.resourceClass!==klass||!['STOCK','FLOW','CUMULATIVE_EXPENDITURE'].includes(r.kind))
      failed('ORIGINAL_FUNDING_RESOURCE_BINDING:'+id);
  }
  const originalPaths=policy?lowerOriginal({...source,policies:[policy]}).policies[0]!.demands:null;
  if(!originalPaths?.size)throw new R7Error('CHECK_FAILED','Original selected policy has no complete fixed-world paths');
  const paths=Array.from(originalPaths,([id,demands])=>{
    const increment=new Map<string,Q[]>(snapshot.resources.map(r=>[r.resourceId,zeros(h+1)]));
    for(const [resourceId,amounts]of demands){
      if(!resources.has(resourceId)){failed('CURRENT_RESOURCE_MISSING:'+resourceId);continue;}
      increment.set(resourceId,amounts.map(e=>evaluate(e,point)));
    }
    return {id,increment};
  });
  // Original source reconstruction stays R7-owned. Current financial envelope
  // arithmetic is the SAME canonical kernel used by verifyCanonicalAllocation.
  const canonical=verifyCanonicalResourceSchedules({horizon:m.horizon,knowledgeAt:new Date(asOf).toISOString(),
    resources:snapshot.resources,outstanding:snapshot.outstanding,paths});
  for(const reason of canonical.reasons)failed(reason);
  const {envelopes,witnesses}=canonical;
  return {schema:'finnor.s5.exact-affine-check.v1',feasible:!reasons.length,reasons,envelopes,snapshotDigest:snapshot.snapshotDigest,
    policyBindings:policy?[{policyRef:policy.ref,demandDigest:atlasHash(envelopes)}]:[],witnesses,
    resourceChecker:'CANONICAL_RESOURCE_PATH_KERNEL_V1',numericalSemantics:'EXACT_RATIONAL_ZERO_TOLERANCE',executionAuthorityGranted:false};
}
