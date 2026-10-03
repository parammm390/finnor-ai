import { z } from 'zod';
import type { AllocationResource, AllocationResourceInput, CanonicalAllocationProblem, JointAllocationModel, S5ExperienceEvent, EconomicMandate, ExperimentRef } from '@finnor/shared-types';
import { ExperimentRefSchema } from './experiments';
import { parseEconomicMandate, assertContingentPolicy, immutableControl } from './control-contracts';
import { epistemicHash } from './source-precedence';
import { ExperimentRational, ER_ZERO } from './experiment-numerics';

export class AllocationContractError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'PERMITTED_CONTEXT_UNAVAILABLE' | 'STALE_INPUT' | 'LIMIT_EXCEEDED' | 'IDEMPOTENCY_CONFLICT' | 'BLOCKED_AUTHORITY' | 'INVALID_CANDIDATE', message: string) {
    super(message); this.name = 'AllocationContractError';
  }
}
export const S5_VERSION = 's5-joint-finite-v1' as const;
export const ALLOCATION_ADMISSION = Object.freeze({executionAuthorityGranted:false as const, appendAuthorityGranted:false as const, protectedReceipt:null, methodAdmitted:false as const});
const text = z.string().min(1).max(256), time = z.string().datetime({offset:true});
const quantity = z.string().max(48).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const nonnegative = quantity.refine(s => !s.startsWith('-'), 'Negative resource quantity');
const horizon = z.object({startAt:time,periodMs:z.number().int().positive().max(31536000000),periods:z.number().int().min(1).max(24)}).strict();
const pin = z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),root:z.object({entityType:text,entityId:text}).strict(),validAt:time,knowledgeAt:time,dependencyDigest:text,rightsRevision:z.number().int().nonnegative(),interpretationVersion:text}).strict();
const covenant = z.object({id:text,sourceRef:ExperimentRefSchema,rightsRef:text,unit:text,
  terms:z.array(z.object({resourceId:text,coefficient:quantity,coefficientUnit:text}).strict()).min(1).max(16),periods:z.array(z.number().int().min(0).max(24)).min(1).max(25),
  maximum:nonnegative,safetyMargin:nonnegative,basis:z.literal('CANONICAL_RESOURCE_USAGE')}).strict();
export const AllocationResourceInputSchema = z.object({schema:z.literal('finnor.allocation-resource.v1'),resourceId:z.string().min(1).max(80).regex(/^[A-Za-z0-9:_-]+$/),tenantId:z.string().uuid(),
  ownerRef:ExperimentRefSchema,legalEntityRef:ExperimentRefSchema,scopeRef:ExperimentRefSchema,permittedRoots:z.array(z.object({entityType:text,entityId:text}).strict()).min(1).max(32),rightsRef:text,unit:text,currency:z.string().regex(/^[A-Z]{3}$/).nullable(),kind:z.enum(['STOCK','FLOW','OCCUPANCY','CUMULATIVE_EXPENDITURE','EXPOSURE']),resourceClass:z.enum(['CASH','BORROWING_HEADROOM','COMMITTED_CAPITAL','OPERATIONAL_CAPACITY','HUMAN_ATTENTION','COMPUTE','INQUIRY_EXPOSURE','COUNTERPARTY_EXPOSURE','OTHER_RESTRICTED']),
  horizon,sourceRef:ExperimentRefSchema,asOf:time,knowledgeAt:time,validUntil:time,beliefPins:z.array(pin).max(32),
  availability:z.array(z.object({amount:nonnegative.nullable(),basis:z.enum(['REPORTED_AVAILABLE','UNCERTAIN_PROCEEDS','UNKNOWN'])}).strict()).min(2).max(25),
  existingUse:z.array(nonnegative).min(2).max(25),safetyMargin:nonnegative,covenants:z.array(covenant).max(32),revoked:z.boolean(),qualification:z.literal('AUTHENTICATED_OWNER_ASSERTION_UNADMITTED')}).strict();
export const AllocationDemandBindingSchema = z.object({policyRef:ExperimentRefSchema,dimensionId:text,component:z.enum(['TOTAL','OCCUPANCY']),resourceId:text,conversion:z.literal('IDENTICAL_UNIT_NO_CONVERSION')}).strict();
export const AllocationFundingSchema = z.object({policyRef:ExperimentRefSchema,actionCostResourceId:text.nullable(),terminalLiabilityResourceId:text.nullable(),humanSecondsResourceId:text.nullable()}).strict();
const jointModelSchema = z.object({schema:z.literal('finnor.joint-allocation-model.v1'),ref:ExperimentRefSchema,tenantId:z.string().uuid(),principalId:z.string().uuid(),mandateRef:ExperimentRefSchema,rightsRef:text,
  sourceRefs:z.array(ExperimentRefSchema).min(1).max(128),knowledgeAt:time,validUntil:time,qualification:z.literal('SUPPLIED_JOINT_FINITE_SCENARIOS_UNADMITTED'),ambiguity:z.literal('FIXED_COMPLETE_JOINT_PATHS_NO_PROBABILITIES'),
  completeness:z.literal('ALL_MATERIAL_INTERFERENCE_AND_COMPATIBILITY_DECLARED'),assumptions:z.array(z.string().min(1).max(2048)).min(1).max(64),omittedModelGap:z.literal('UNKNOWN'),identificationGap:z.literal('UNKNOWN'),
  scenarios:z.array(z.object({id:text,sharedMechanismRef:ExperimentRefSchema,policyPaths:z.array(z.object({policyRef:ExperimentRefSchema,nodeIds:z.array(text).min(1).max(24)}).strict()).min(1).max(32),
    baseValue:quantity,terms:z.array(z.object({policyIds:z.array(text).min(1).max(32),value:quantity,evidenceRef:ExperimentRefSchema}).strict()).max(512)}).strict()).min(1).max(32),
  choiceConstraints:z.array(z.object({id:text,policyIds:z.array(text).min(1).max(32),minimum:z.number().int().nonnegative().max(32),maximum:z.number().int().nonnegative().max(32),sourceRef:ExperimentRefSchema}).strict()).max(128)}).strict();

export const sameAllocationRef = (a:unknown,b:unknown):boolean => epistemicHash(a) === epistemicHash(b);
function observationKeyMatches(key:string,observations:unknown):boolean {try{return sameAllocationRef(JSON.parse(key),observations);}catch{return false;}}
export function allocationRef(owner:string,prefix:string,body:unknown,version:string=S5_VERSION):ExperimentRef {
  const digest=epistemicHash(body);return {owner,id:`${prefix}:${digest}`,version,contentDigest:digest};
}
export function allocationQuantity(s:string):ExperimentRational {
  if(!quantity.safeParse(s).success)throw new AllocationContractError('INVALID_REQUEST','Unsupported exact finite quantity');
  const negative=s.startsWith('-'),[w,f='']=s.replace('-','').split('.');
  const v=new ExperimentRational((negative?-1n:1n)*BigInt(w!+f),10n**BigInt(f.length));
  if((v.n<0n?-v.n:v.n)>1000000000000n*v.d)throw new AllocationContractError('LIMIT_EXCEEDED','Quantity magnitude exceeds registered domain');return v;
}
/** Derived sums/products keep separate limits from external supplied quantities. */
export function allocationDerivedQuantity(s:string):ExperimentRational {
  if(typeof s!=='string'||s.length>96||!/^[-]?(?:0|[1-9]\d*)(?:\.\d{1,48})?$/.test(s))throw new AllocationContractError('INVALID_CANDIDATE','Unsupported derived exact quantity');
  const negative=s.startsWith('-'),[whole,fraction='']=s.replace('-','').split('.');const q=new ExperimentRational((negative?-1n:1n)*BigInt(whole!+fraction),10n**BigInt(fraction.length));
  if((q.n<0n?-q.n:q.n)>10n**30n*q.d)throw new AllocationContractError('LIMIT_EXCEEDED','Derived accounting magnitude exceeds domain');return q;
}
export function allocationDecimal(v:ExperimentRational):string {
  let d=v.d,two=0,five=0;while(d%2n===0n){d/=2n;two++;}while(d%5n===0n){d/=5n;five++;}
  if(d!==1n)throw new AllocationContractError('INVALID_CANDIDATE','Nonterminating accounting quantity');
  const digits=Math.max(two,five);if(digits>48)throw new AllocationContractError('LIMIT_EXCEEDED','Accounting precision exceeds bounded checker');
  const scale=10n**BigInt(digits),n=(v.n<0n?-v.n:v.n)*(scale/v.d),s=n.toString().padStart(digits+1,'0');
  const f=digits?s.slice(-digits).replace(/0+$/,''):'';return `${v.n<0n&&n?'-':''}${digits?s.slice(0,-digits):s}${f?`.${f}`:''}`;
}
/** Conservatively rounded UP for a displayed normalized upper bound. */
export function allocationRatioUpper(n:ExperimentRational,d:ExperimentRational):string {
  if(n.n<0n||d.n<=0n)throw new AllocationContractError('INVALID_CANDIDATE','Invalid gap normalization');
  const scale=1000000000000n,num=n.n*d.d*scale,den=n.d*d.n;
  return allocationDecimal(new ExperimentRational((num+den-1n)/den,scale));
}
export function allocationNumber(v:number):ExperimentRational {
  if(!Number.isFinite(v))throw new AllocationContractError('INVALID_REQUEST','Nonfinite policy quantity');
  let s=String(v);if(/[eE]/.test(s)){
    const [mantissa,exponent]=s.toLowerCase().split('e'),negative=mantissa!.startsWith('-'),parts=mantissa!.replace('-','').split('.'),digits=parts.join(''),point=parts[0]!.length+Number(exponent);
    s=(negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
  }return allocationQuantity(s);
}
function unique(values:string[],reason:string):void {if(new Set(values).size!==values.length)throw new AllocationContractError('INVALID_REQUEST',reason);}
function parsed<T>(schema:z.ZodTypeAny,value:unknown):T {
  const result=schema.safeParse(value);if(!result.success)throw new AllocationContractError('INVALID_REQUEST','Unsupported or incomplete S5 contract');return result.data as T;
}
export function parseAllocationResource(value:unknown):AllocationResourceInput {
  const r=parsed<AllocationResourceInput>(AllocationResourceInputSchema,value),length=r.horizon.periods+1;
  if(r.ownerRef.owner!=='BUSINESS_OWNER'||r.availability.length!==length||r.existingUse.length!==length||Date.parse(r.asOf)>Date.parse(r.knowledgeAt)||Date.parse(r.validUntil)<=Date.parse(r.knowledgeAt))throw new AllocationContractError('INVALID_REQUEST','Resource owner, clocks or temporal schedules differ');
  if(r.currency!==null&&r.unit!==r.currency)throw new AllocationContractError('INVALID_REQUEST','Currency resource unit requires an explicit identical currency; conversion is unsupported');
  for(const q of [...r.existingUse,r.safetyMargin,...r.availability.flatMap(a=>a.amount===null?[]:[a.amount])])allocationQuantity(q);
  unique(r.covenants.map(c=>c.id),'Duplicate canonical covenant');
  for(const c of r.covenants){unique(c.periods.map(String),'Duplicate covenant period');unique(c.terms.map(t=>t.resourceId),'Duplicate covenant resource');
    if(c.periods.some(t=>t>r.horizon.periods)||c.rightsRef!==r.rightsRef)throw new AllocationContractError('INVALID_REQUEST','Covenant horizon or rights differ');
    for(const q of [c.maximum,c.safetyMargin,...c.terms.map(t=>t.coefficient)])allocationQuantity(q);
  }return immutableControl(r);
}
export function parseJointAllocationModel(value:unknown):JointAllocationModel {
  const m=parsed<JointAllocationModel>(jointModelSchema,value),{ref,...body}=m;
  if(!sameAllocationRef(ref,allocationRef('BUSINESS_OWNER','joint-allocation-model',body,'s5-joint-model-v1')))throw new AllocationContractError('INVALID_REQUEST','Joint model exact supplied unadmitted commitment differs');
  unique(m.scenarios.map(s=>s.id),'Duplicate joint scenario');unique(m.choiceConstraints.map(c=>c.id),'Duplicate joint choice constraint');
  for(const s of m.scenarios){unique(s.policyPaths.map(p=>p.policyRef.id),'Duplicate scenario policy');allocationQuantity(s.baseValue);
    unique(s.terms.map(t=>[...t.policyIds].sort().join('|')),'Duplicate joint value monomial');for(const t of s.terms){unique(t.policyIds,'Duplicate joint term policy');allocationQuantity(t.value);}}
  for(const c of m.choiceConstraints){unique(c.policyIds,'Duplicate choice policy');if(c.minimum>c.maximum||c.maximum>c.policyIds.length)throw new AllocationContractError('INVALID_REQUEST','Unsupported choice cardinality');}
  return immutableControl(m);
}
export function assertAllocationProblem(p:CanonicalAllocationProblem):void {
  const {ref,...body}=p;if(p.schema!=='finnor.allocation-problem.v1'||p.methodVersion!==S5_VERSION||!sameAllocationRef(ref,allocationRef('S5','allocation-problem',body)))throw new AllocationContractError('INVALID_REQUEST','Canonical problem commitment differs');
  const m=parseEconomicMandate(p.mandate),joint=parseJointAllocationModel(p.jointModel);
  if(p.snapshotDigest!==epistemicHash({resources:p.resources,outstanding:p.outstanding})||!Number.isFinite(Date.parse(p.knowledgeAt))||!Number.isFinite(Date.parse(p.validUntil))||Date.parse(p.knowledgeAt)<Date.parse(m.knowledgeAt)||Date.parse(p.validUntil)>Date.parse(m.validUntil))throw new AllocationContractError('INVALID_REQUEST','Original resource snapshot or mandate knowledge cut differs');
  if(p.tenantId!==m.tenantId||p.principalId!==m.principalId||p.episodeId!==m.episodeId||!sameAllocationRef(joint.mandateRef,m.ref)||joint.tenantId!==p.tenantId||joint.principalId!==p.principalId||joint.rightsRef!==m.rightsRef||m.ambiguity.kind!=='ROBUST_FIXED_JOINT_SCENARIOS')throw new AllocationContractError('INVALID_REQUEST','Joint mandate, identity or uncertainty semantics differ');
  if(!p.policies.length||p.policies.length>32||!p.resources.length||p.resources.length>16||p.outstanding.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','Canonical clearing cardinality exceeded');
  unique(p.policies.map(x=>x.ref.id),'Duplicate policy');unique(p.resources.map(x=>x.resourceId),'Duplicate resource');
  const policies=new Map(p.policies.map(x=>[x.ref.id,x])),resources=new Map(p.resources.map(x=>[x.resourceId,x]));
  for(const r of p.resources){const {ref:rr,revision,priorRef,...input}=r;parseAllocationResource(input);
    if(rr.owner!=='S5'||rr.version!==S5_VERSION||rr.contentDigest!==epistemicHash({...input,revision,priorRef})||rr.id!==`allocation-resource:${r.resourceId}:${revision}:${rr.contentDigest}`||r.tenantId!==p.tenantId||r.rightsRef!==m.rightsRef||!sameAllocationRef(r.horizon,m.horizon)||r.ownerRef.id!==m.businessOwnerRef.id)throw new AllocationContractError('INVALID_REQUEST','Resource revision, rights, owner or horizon differs');
    for(const c of r.covenants)for(const t of c.terms){const named=resources.get(t.resourceId);if(!named||t.coefficientUnit!==`${c.unit}/${named.unit}`)throw new AllocationContractError('INVALID_REQUEST','Covenant references unavailable resource or incompatible coefficient unit');}
  }
  for(const policy of p.policies){assertContingentPolicy(policy);
    if(policy.nodes.length>joint.scenarios.length*m.horizon.periods)throw new AllocationContractError('LIMIT_EXCEEDED','Complete common-path domain cannot cover this policy tree');
    if(policy.tenantId!==p.tenantId||policy.principalId!==p.principalId||!sameAllocationRef(policy.mandateRef,m.ref)||policy.bindings.rightsRef!==m.rightsRef||policy.resultState!=='POLICY_AVAILABLE')throw new AllocationContractError('INVALID_REQUEST','Policy is not a current qualified mutually consistent mandate');
    const {contentDigest,...demand}=policy.demand;if(epistemicHash(demand)!==contentDigest||!sameAllocationRef(demand.existingObligations,policy.problem.obligations)||!sameAllocationRef(demand.dimensions,m.resources.dimensions)||!sameAllocationRef(demand.couplings,m.resources.couplings))throw new AllocationContractError('INVALID_REQUEST','Demand commitment differs from original S4 policy');
    if(policy.problem.continuation)throw new AllocationContractError('INVALID_REQUEST','Continuation resource accounting requires linked qualified S6 reconciliation; initial full policies only');
    if(policy.problem.obligations.some(o=>o.status!=='SETTLED'||o.terminalLiability!==0))throw new AllocationContractError('INVALID_REQUEST','Policy obligations require exact qualified S6 resource and residual-liability accounting');
    unique(policy.nodes.map(n=>n.id),'Duplicate policy node');
    if(policy.nodes.length>50000||policy.demand.branches.length!==policy.nodes.length)throw new AllocationContractError('LIMIT_EXCEEDED','Policy demand topology incomplete or unbounded');
    const parentCounts=new Map<string,number>();
    for(const node of policy.nodes){const action=policy.problem.actions.find(a=>a.id===node.actionId),d=policy.demand.branches.find(b=>b.nodeId===node.id);
      if(!action||!d||d.actionId!==node.actionId||d.period!==node.period||!sameAllocationRef(d.total,action.resources)||!sameAllocationRef(d.occupancy,action.occupancy)||d.occupationPeriods!==action.occupationPeriods||node.actionHistory.length!==node.period||node.observations.some(o=>o.availablePeriod>node.period))throw new AllocationContractError('INVALID_REQUEST','Original S4 action/demand or lawful observation binding differs');
      if(node.period<action.earliestPeriod||node.period>action.lastPeriod||node.period>=m.horizon.periods)throw new AllocationContractError('INVALID_REQUEST','Policy action outside exact authorized time');
      for(const observation of node.observations){const instrument=policy.problem.observations.find(i=>i.id===observation.instrumentId),inquiry=policy.problem.actions.find(a=>a.protocolRef?.id===observation.instrumentId);
        const delay=instrument?.delayPeriods??inquiry?.informationDelayPeriods;
        if(delay===undefined||observation.availablePeriod<delay||!node.actionHistory[observation.availablePeriod-delay]||instrument&&(!instrument.afterActionIds.includes(node.actionHistory[observation.availablePeriod-delay]!)||!instrument.bins.some(b=>b.category===observation.token))||inquiry&&node.actionHistory[observation.availablePeriod-delay]!==inquiry.id)throw new AllocationContractError('INVALID_REQUEST','Policy contingency sees unregistered or premature private information');}
      for(const branch of node.branches){const child=policy.nodes.find(n=>n.id===branch.childId);parentCounts.set(branch.childId,(parentCounts.get(branch.childId)??0)+1);
        if(!child||child.period!==node.period+1||!sameAllocationRef(child.actionHistory,[...node.actionHistory,node.actionId])||!observationKeyMatches(branch.observationKey,child.observations)||!child.observations.every(o=>o.availablePeriod<=child.period)||!policy.demand.branches.some(d=>d.nodeId===child.id&&d.parentNodeId===node.id))throw new AllocationContractError('INVALID_REQUEST','Policy branch uses unsupported history or topology');}
      if((node.period===m.horizon.periods-1)!==(node.branches.length===0))throw new AllocationContractError('INVALID_REQUEST','Policy omits a full consequence horizon');
    }
    if(!policy.nodes.some(n=>n.id===policy.rootNodeId&&n.period===0)||policy.nodes.some(n=>n.id===policy.rootNodeId?parentCounts.has(n.id):parentCounts.get(n.id)!==1))throw new AllocationContractError('INVALID_REQUEST','Policy root or unique branch ownership differs');
  }
  unique(p.demandBindings.map(b=>`${b.policyRef.id}|${b.dimensionId}|${b.component}`),'Duplicate resource demand binding');
  for(const b of p.demandBindings){const policy=policies.get(b.policyRef.id),resource=resources.get(b.resourceId),dimension=m.resources.dimensions.find(d=>d.id===b.dimensionId);
    if(!policy||!sameAllocationRef(b.policyRef,policy.ref)||!resource||!dimension||dimension.unit!==resource.unit||!dimension.resourceClass||dimension.resourceClass!==resource.resourceClass||b.conversion!=='IDENTICAL_UNIT_NO_CONVERSION'||(b.component==='OCCUPANCY')!==['OCCUPANCY','EXPOSURE'].includes(resource.kind))throw new AllocationContractError('INVALID_REQUEST','Demand identity, semantic class, stock/occupancy or exact unit binding differs');
    if(!policy.bindings.beliefPins.length||policy.bindings.beliefPins.some(pin=>!resource.permittedRoots.some(root=>sameAllocationRef(root,pin.root))))throw new AllocationContractError('INVALID_REQUEST','Policy entity is outside the explicit permitted resource scope');}
  unique(p.funding.map(f=>f.policyRef.id),'Duplicate policy funding');
  if(p.funding.length!==p.policies.length)throw new AllocationContractError('INVALID_REQUEST','Every policy requires explicit cost/tail/human funding semantics');
  for(const policy of p.policies){const f=p.funding.find(f=>sameAllocationRef(f.policyRef,policy.ref));if(!f)throw new AllocationContractError('INVALID_REQUEST','Funding policy differs');
    const fundingPairs:Array<[string|null,string,number[]]>= [[f.actionCostResourceId,m.utility.unit,policy.problem.actions.map(a=>a.cost)],[f.terminalLiabilityResourceId,m.utility.unit,[m.utility.tail.terminalLiability,...policy.problem.actions.map(a=>a.tailLiability)]],[f.humanSecondsResourceId,'seconds',policy.problem.actions.map(a=>a.humanSeconds)]];
    for(const [id,unit,amounts]of fundingPairs){if(amounts.some(x=>x!==0)&&id===null)throw new AllocationContractError('INVALID_REQUEST','Positive cost, terminal liability or attention has no funding binding');
      if(id!==null){const r=resources.get(id);if(!r||r.unit!==unit||!['STOCK','FLOW','CUMULATIVE_EXPENDITURE'].includes(r.kind)||r.resourceClass!==(unit==='seconds'?'HUMAN_ATTENTION':'CASH')||policy.bindings.beliefPins.some(pin=>!r.permittedRoots.some(root=>sameAllocationRef(root,pin.root))))throw new AllocationContractError('INVALID_REQUEST','Explicit funding resource kind, entity scope or unit differs');}}
    for(const dimension of m.resources.dimensions)for(const component of ['TOTAL','OCCUPANCY'] as const){if(policy.nodes.some(n=>{const a=policy.problem.actions.find(a=>a.id===n.actionId)!;return (component==='TOTAL'?a.resources:a.occupancy)[dimension.id]!==0;})&&!p.demandBindings.some(b=>b.policyRef.id===policy.ref.id&&b.dimensionId===dimension.id&&b.component===component))throw new AllocationContractError('INVALID_REQUEST','Material S4 demand omitted from canonical clearing');}
  }
  for(const s of joint.scenarios){if(s.policyPaths.length!==p.policies.length)throw new AllocationContractError('INVALID_REQUEST','Joint path omits a simultaneous policy');
    const sharedObservations=new Map<string,string>();
    for(const path of s.policyPaths){const policy=policies.get(path.policyRef.id);if(!policy||!sameAllocationRef(path.policyRef,policy.ref)||path.nodeIds.length!==m.horizon.periods||path.nodeIds[0]!==policy.rootNodeId)throw new AllocationContractError('INVALID_REQUEST','Scenario does not bind an exact full S4 path');
      for(let t=0;t<path.nodeIds.length;t++){const node=policy.nodes.find(n=>n.id===path.nodeIds[t]);if(!node||node.period!==t||t>0&&!policy.nodes.find(n=>n.id===path.nodeIds[t-1])!.branches.some(b=>b.childId===node.id))throw new AllocationContractError('INVALID_REQUEST','Scenario path is not a lawful observable S4 branch');
        for(const observation of node.observations){const instrument=policy.problem.observations.find(i=>i.id===observation.instrumentId),source=instrument?.sourceRef??policy.bindings.protocolRefs.find(i=>i.id===observation.instrumentId)!;
          const key=`${epistemicHash(source)}|${observation.instrumentId}|${observation.availablePeriod}`,prior=sharedObservations.get(key);
          if(prior!==undefined&&prior!==observation.token)throw new AllocationContractError('INVALID_REQUEST','Common scenario contains incompatible shared observations');sharedObservations.set(key,observation.token);}
      }}
    if(s.terms.some(t=>t.policyIds.some(id=>!policies.has(id))))throw new AllocationContractError('INVALID_REQUEST','Joint value term references a foreign policy');
  }
  for(const policy of p.policies)if(policy.nodes.some(n=>!joint.scenarios.some(s=>s.policyPaths.find(q=>q.policyRef.id===policy.ref.id)!.nodeIds.includes(n.id))))throw new AllocationContractError('INVALID_REQUEST','Supplied joint model omits a reachable S4 contingency');
  if(joint.choiceConstraints.some(c=>c.policyIds.some(id=>!policies.has(id))))throw new AllocationContractError('INVALID_REQUEST','Choice constraint references a foreign policy');
  if(p.policies.some(policy=>!joint.sourceRefs.some(ref=>sameAllocationRef(ref,policy.bindings.modelRef))))throw new AllocationContractError('INVALID_REQUEST','Joint model omits qualified S3 policy model references');
  for(const r of p.resources)for(const c of r.covenants)for(const other of p.resources.flatMap(x=>x.covenants).filter(o=>o.id===c.id))if(!sameAllocationRef(c,other))throw new AllocationContractError('INVALID_REQUEST','Conflicting canonical shared covenant definitions');
}
export function prepareS5Experience(m:EconomicMandate,type:S5ExperienceEvent['type'],revisionRef:string,detail:Record<string,unknown>,parents:string[]=[],horizon:'H0'|'H1'='H1'):S5ExperienceEvent {
  const body={schema:'finnor.s5.experience.v1' as const,semanticOwner:'S5' as const,episodeId:m.episodeId,type,tenantId:m.tenantId,principalId:m.principalId,rightsRef:m.rightsRef,revisionRef,contentDigest:epistemicHash(detail),knowledgeAt:new Date().toISOString(),validAt:m.horizon.startAt,preparedParentRefs:parents,causalParents:[] as [],dependencyRefs:[m.ref.id,m.utilityRef.id],horizon,uncertainty:'MODEL_CONDITIONAL_UNADMITTED' as const,detail,protectedReceipt:null,appendAuthorityGranted:false as const};
  return immutableControl({...body,eventId:`s5-event:${epistemicHash(body)}`});
}

/** Shared runtime/OpenAPI operation schemas; semantic owner checks follow parsing. */
const allocationReferenceRequest=z.object({allocationRef:ExperimentRefSchema}).strict();
export const AllocationOperationSchemas={
 resource:z.object({resource:AllocationResourceInputSchema,expectedRef:ExperimentRefSchema.nullable().optional()}).strict(),
 resources:z.object({}).strict(),
 clear:z.object({mandate:z.unknown().describe('Exact EconomicMandate v1; validated by the S4 owner contract'),policyRefs:z.array(ExperimentRefSchema).min(1).max(32),resourceRefs:z.array(ExperimentRefSchema).min(1).max(16),jointModel:jointModelSchema,demandBindings:z.array(AllocationDemandBindingSchema).max(1024),funding:z.array(AllocationFundingSchema).min(1).max(32),idempotencyKey:text}).strict(),
 read:allocationReferenceRequest,validate:allocationReferenceRequest,reconcile:allocationReferenceRequest,
 settle:allocationReferenceRequest.extend({consumptionRef:ExperimentRefSchema,settlementEventId:z.string().regex(/^s6-event:[a-f0-9]{64}$/)}),
 consume:allocationReferenceRequest.extend({policyRef:ExperimentRefSchema,decision:z.unknown().describe('Exact current ControlDecisionInput; validated by S4'),measurements:z.array(z.object({protocol:z.unknown(),events:z.array(z.unknown()).max(4096)}).strict()).max(8).optional(),idempotencyKey:text}),
 release:allocationReferenceRequest.extend({idempotencyKey:text}),
 assessment:allocationReferenceRequest.extend({reason:z.string().min(1).max(2048),humanSeconds:z.number().finite().nonnegative().max(900),evidenceRefs:z.array(ExperimentRefSchema).max(32)})
};
