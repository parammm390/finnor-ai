import {exactPolicyActionQuantity} from './exact-allocation-adapter';
import type { AllocationCertificate, AllocationDualProposal, AllocationLagrangianProof, AllocationCheck, AllocationEnvelope, AllocationOptimizationCertificate, CanonicalAllocationProblem } from '@finnor/shared-types';
import { epistemicHash } from './source-precedence';
import { immutableControl } from './control-contracts';
import { ExperimentRational, ER_ZERO } from './experiment-numerics';
import { ALLOCATION_ADMISSION, allocationRef, AllocationContractError, allocationDecimal as decimal, allocationNumber as number, allocationDerivedQuantity as quantity, allocationQuantity, allocationRatioUpper, assertAllocationProblem, sameAllocationRef } from './allocation-contracts';

type Q = ExperimentRational;
type Schedule = Map<string,Q[]>;
interface Prepared {
  problem: CanonicalAllocationProblem; baseline: Schedule; minimumBaseline: Schedule;
  paths: Array<{ id:string; demands:Map<string,Schedule> }>;
  initialReasons: string[];
}
const zeroes = (n:number):Q[] => Array.from({length:n},()=>ER_ZERO);
const sum = (v:Q[]):Q => v.reduce((a,b)=>a.add(b),ER_ZERO);
const max = (a:Q,b:Q):Q => a.compare(b)>=0?a:b;
const min = (a:Q,b:Q):Q => a.compare(b)<=0?a:b;
const prefix = (values:Q[],t:number):Q => sum(values.slice(0,t+1));
function resourceUsage(kind:string,values:Q[],t:number):Q {
  return kind==='STOCK'||kind==='CUMULATIVE_EXPENDITURE'?prefix(values,t):values[t]!;
}
function schedule(problem:CanonicalAllocationProblem):Schedule {
  return new Map(problem.resources.map(r=>[r.resourceId,zeroes(problem.mandate.horizon.periods+1)]));
}
function prepare(problem:CanonicalAllocationProblem):Prepared {
  assertAllocationProblem(problem);
  const p=problem,h=p.mandate.horizon.periods,baseline=schedule(p),minimumBaseline=schedule(p),initialReasons:string[]=[];
  for(const r of p.resources){baseline.set(r.resourceId,r.existingUse.map(quantity));minimumBaseline.set(r.resourceId,r.existingUse.map(quantity));
    if(r.revoked)initialReasons.push(`RESOURCE_REVOKED:${r.resourceId}`);
    if(Date.parse(r.knowledgeAt)>Date.parse(p.knowledgeAt)||Date.parse(r.validUntil)<=Date.parse(p.knowledgeAt))initialReasons.push(`RESOURCE_KNOWLEDGE_OR_EXPIRY:${r.resourceId}`);
    if(r.availability.some(a=>a.basis!=='REPORTED_AVAILABLE'||a.amount===null))initialReasons.push(`RESOURCE_AVAILABILITY_UNRESOLVED:${r.resourceId}`);
  }
  if(Date.parse(p.jointModel.knowledgeAt)>Date.parse(p.knowledgeAt)||Date.parse(p.jointModel.validUntil)<=Date.parse(p.knowledgeAt)||p.policies.some(policy=>Date.parse(policy.knowledgeAt)>Date.parse(p.knowledgeAt)||Date.parse(policy.validUntil)<=Date.parse(p.knowledgeAt)))initialReasons.push('POLICY_OR_JOINT_MODEL_KNOWLEDGE_OR_EXPIRY');
  for(const outstanding of p.outstanding){if(outstanding.status==='RESERVED'&&outstanding.effectRefs.length)initialReasons.push('RESERVATION_EFFECT_STAGE_INCONSISTENT');
    for(const envelope of outstanding.envelopes){const r=p.resources.find(r=>r.resourceId===envelope.resourceId);
      if(!r||r.unit!==envelope.unit||r.kind!==envelope.kind||!sameAllocationRef(r.horizon,envelope.horizon)||envelope.quantities.length!==h+1||envelope.minimumQuantities?.length!==h+1){initialReasons.push('OUTSTANDING_COMMITMENT_RESOURCE_SEMANTICS_UNRESOLVED');continue;}
      const raw=baseline.get(r.resourceId)!,lower=minimumBaseline.get(r.resourceId)!;
      for(let t=0;t<=h;t++){raw[t]=raw[t]!.add(quantity(envelope.quantities[t]!));lower[t]=lower[t]!.add(quantity(envelope.minimumQuantities[t]!));
        if(resourceUsage(r.kind,envelope.minimumQuantities.map(quantity),t).compare(resourceUsage(r.kind,envelope.quantities.map(quantity),t))>0)initialReasons.push('OUTSTANDING_COMMITMENT_LOWER_ENVELOPE_INVALID');}
    }
  }
  if(p.mandate.utility.tail.terminalLiability!==0){const ids=new Set(p.funding.map(f=>f.terminalLiabilityResourceId));
    if(ids.size!==1||ids.has(null))initialReasons.push('MANDATE_TERMINAL_LIABILITY_FUNDING_UNRESOLVED');}
  const paths:Prepared['paths']=[];
  // This reconstruction reads original S4 action meaning, not backend rows or
  // producer-derived demand totals. Identity/topology was checked above.
  for(const scenario of p.jointModel.scenarios){const demands=new Map<string,Schedule>();
    for(const policy of p.policies){const raw=schedule(p),path=scenario.policyPaths.find(s=>s.policyRef.id===policy.ref.id)!,funding=p.funding.find(f=>f.policyRef.id===policy.ref.id)!;
      for(const nodeId of path.nodeIds){const node=policy.nodes.find(n=>n.id===nodeId)!,action=policy.problem.actions.find(a=>a.id===node.actionId)!;
        for(const binding of p.demandBindings.filter(b=>b.policyRef.id===policy.ref.id)){const amounts=raw.get(binding.resourceId)!;
          if(binding.component==='TOTAL')amounts[node.period]=amounts[node.period]!.add((exactPolicyActionQuantity(policy,action,'resources',binding.dimensionId)??number(action.resources[binding.dimensionId]!)));
          else for(let t=node.period;t<Math.min(h+1,node.period+action.occupationPeriods);t++)amounts[t]=amounts[t]!.add((exactPolicyActionQuantity(policy,action,'occupancy',binding.dimensionId)??number(action.occupancy[binding.dimensionId]!)));
        }
        if(funding.actionCostResourceId){const v=raw.get(funding.actionCostResourceId)!;v[node.period]=v[node.period]!.add((exactPolicyActionQuantity(policy,action,'cost')??number(action.cost)));}
        if(funding.humanSecondsResourceId){const v=raw.get(funding.humanSecondsResourceId)!;v[node.period]=v[node.period]!.add((exactPolicyActionQuantity(policy,action,'humanSeconds')??number(action.humanSeconds)));}
        if(funding.terminalLiabilityResourceId){const v=raw.get(funding.terminalLiabilityResourceId)!;v[h]=v[h]!.add((exactPolicyActionQuantity(policy,action,'tailLiability')??number(action.tailLiability)));}
      }demands.set(policy.ref.id,raw);
    }paths.push({id:scenario.id,demands});
  }
  return {problem:p,baseline,minimumBaseline,paths,initialReasons};
}
function evaluate(prepared:Prepared,selected:string[],withWitnesses=true):AllocationCheck {
  const {problem:p,baseline,minimumBaseline,paths}=prepared,h=p.mandate.horizon.periods,chosen=new Set(selected),reasons=[...prepared.initialReasons];
  if(chosen.size!==selected.length||selected.some(id=>!p.policies.some(policy=>policy.ref.id===id)))reasons.push('SELECTED_POLICY_IDENTITY_INVALID');
  if(p.outstanding.some(o=>o.policyRefs.some(policy=>chosen.has(policy.id))))reasons.push('POLICY_ALREADY_DURABLY_COMMITTED');
  const witnesses:AllocationCheck['witnesses']=[],scenarioValues:AllocationCheck['scenarioValues']=[],increments:Schedule[]=[];
  for(const constraint of p.jointModel.choiceConstraints){const count=constraint.policyIds.filter(id=>chosen.has(id)).length;if(count<constraint.minimum||count>constraint.maximum)reasons.push(`JOINT_CHOICE_CONSTRAINT:${constraint.id}`);}
  for(const path of paths){const incremental=schedule(p),total=schedule(p);
    // Mandate-wide terminal debt is part of the NEW durable envelope, even if
    // selection is empty. Future clears must see it in outstanding commitments.
    if(p.mandate.utility.tail.terminalLiability!==0&&!prepared.initialReasons.includes('MANDATE_TERMINAL_LIABILITY_FUNDING_UNRESOLVED')){
      incremental.get(p.funding[0]!.terminalLiabilityResourceId!)![h]=number(p.mandate.utility.tail.terminalLiability);}
    for(const r of p.resources){const raw=incremental.get(r.resourceId)!;
      for(const id of chosen){const demand=path.demands.get(id)?.get(r.resourceId);if(demand)for(let t=0;t<=h;t++)raw[t]=raw[t]!.add(demand[t]!);}
      total.set(r.resourceId,raw.map((v,t)=>v.add(baseline.get(r.resourceId)![t]!)));
      for(let t=0;t<=h;t++){const used=resourceUsage(r.kind,total.get(r.resourceId)!,t),a=r.availability[t]!,maximum=a.amount===null?ER_ZERO:quantity(a.amount).sub(quantity(r.safetyMargin)),margin=maximum.sub(used);
        if(margin.n<0n)reasons.push(`RESOURCE_LIMIT:${r.resourceId}:${path.id}:${t}`);
        if(withWitnesses)witnesses.push({constraintId:`resource:${r.resourceId}`,scenarioId:path.id,period:t,used:decimal(used),maximum:decimal(maximum),margin:decimal(margin)});
      }
    }
    const covenants=new Map(p.resources.flatMap(r=>r.covenants).map(c=>[c.id,c]));
    for(const c of covenants.values())for(const t of c.periods){let used=ER_ZERO;
      for(const term of c.terms){const r=p.resources.find(r=>r.resourceId===term.resourceId)!,coefficient=quantity(term.coefficient),values=coefficient.n<0n?incremental.get(r.resourceId)!.map((v,i)=>v.add(minimumBaseline.get(r.resourceId)![i]!)):total.get(r.resourceId)!;used=used.add(coefficient.mul(resourceUsage(r.kind,values,t)));}
      const maximum=quantity(c.maximum).sub(quantity(c.safetyMargin)),margin=maximum.sub(used);if(margin.n<0n)reasons.push(`COVENANT_LIMIT:${c.id}:${path.id}:${t}`);
      if(withWitnesses)witnesses.push({constraintId:`covenant:${c.id}`,scenarioId:path.id,period:t,used:decimal(used),maximum:decimal(maximum),margin:decimal(margin)});
    }
    // The authorized S4 envelope is also a portfolio constraint. It is never
    // widened because a separate resource registry permits a larger amount.
    const dimensions=new Map(p.mandate.resources.dimensions.map(d=>[d.id,{spent:ER_ZERO,occupied:zeroes(h+1)}]));let humanSeconds=ER_ZERO;
    for(const id of chosen){const policy=p.policies.find(policy=>policy.ref.id===id);if(!policy)continue;const nodes=p.jointModel.scenarios.find(s=>s.id===path.id)!.policyPaths.find(q=>q.policyRef.id===id)!.nodeIds;
      for(const nodeId of nodes){const node=policy.nodes.find(n=>n.id===nodeId)!,action=policy.problem.actions.find(a=>a.id===node.actionId)!;humanSeconds=humanSeconds.add((exactPolicyActionQuantity(policy,action,'humanSeconds')??number(action.humanSeconds)));
        for(const d of p.mandate.resources.dimensions){const usage=dimensions.get(d.id)!;usage.spent=usage.spent.add((exactPolicyActionQuantity(policy,action,'resources',d.id)??number(action.resources[d.id]!)));for(let t=node.period;t<Math.min(h+1,node.period+action.occupationPeriods);t++)usage.occupied[t]=usage.occupied[t]!.add((exactPolicyActionQuantity(policy,action,'occupancy',d.id)??number(action.occupancy[d.id]!)));}}
    }
    for(const d of p.mandate.resources.dimensions){const v=dimensions.get(d.id)!;if(v.spent.compare(number(d.totalLimit))>0||v.occupied.some(q=>q.compare(number(d.capacity))>0))reasons.push(`MANDATE_RESOURCE_ENVELOPE:${d.id}:${path.id}`);}
    if(humanSeconds.compare(number(p.mandate.search.maxHumanSeconds))>0)reasons.push(`MANDATE_HUMAN_BUDGET:${path.id}`);
    for(const c of p.mandate.resources.couplings)for(let t=0;t<=h;t++){const used=Object.entries(c.weights).reduce((v,[id,weight])=>v.add(number(weight).mul(dimensions.get(id)!.occupied[t]!)),ER_ZERO);if(used.compare(number(c.maxPerPeriod))>0)reasons.push(`MANDATE_COUPLING:${c.id}:${path.id}:${t}`);}
    const scenario=p.jointModel.scenarios.find(s=>s.id===path.id)!;
    const value=scenario.terms.reduce((v,term)=>term.policyIds.every(id=>chosen.has(id))?v.add(quantity(term.value)):v,quantity(scenario.baseValue));
    scenarioValues.push({scenarioId:path.id,value:decimal(value)});if(value.compare(number(p.mandate.risk.minimumUtility))<0)reasons.push(`FULL_HORIZON_RISK_FLOOR:${path.id}`);increments.push(incremental);
  }
  const envelopes:AllocationEnvelope[]=p.resources.map(r=>{
    const quantities:Q[]=zeroes(h+1),minimumQuantities:Q[]=zeroes(h+1);let priorMaximum=ER_ZERO,priorMinimum=ER_ZERO;
    for(let t=0;t<=h;t++){const usages=increments.map(raw=>resourceUsage(r.kind,raw.get(r.resourceId)!,t)),worst=usages.reduce(max),least=usages.reduce(min);
      if(r.kind==='STOCK'||r.kind==='CUMULATIVE_EXPENDITURE'){quantities[t]=worst.sub(priorMaximum);minimumQuantities[t]=least.sub(priorMinimum);priorMaximum=worst;priorMinimum=least;}else{quantities[t]=worst;minimumQuantities[t]=least;}}
    return {resourceId:r.resourceId,unit:r.unit,kind:r.kind,horizon:r.horizon,quantities:quantities.map(decimal),minimumQuantities:minimumQuantities.map(decimal)};
  });
  const feasible=reasons.length===0,objective=feasible?decimal(scenarioValues.map(s=>quantity(s.value)).reduce(min)):null;
  return {schema:'finnor.allocation-check.v1',problemRef:p.ref,selectedPolicyIds:[...selected].sort(),feasible,reasons:[...new Set(reasons)],objective,scenarioValues,envelopes,witnesses,numericalSemantics:'EXACT_DECIMAL_RATIONAL_ZERO_FEASIBILITY_TOLERANCE',executionAuthorityGranted:false};
}
export function verifyCanonicalAllocation(problem:CanonicalAllocationProblem,selectedPolicyIds:string[]):AllocationCheck {
  return immutableControl(evaluate(prepare(problem),selectedPolicyIds));
}
/** Exact box relaxation. No discrete optimum or LP scarcity-price inference. */
export function analyticAllocationUpperBound(problem:CanonicalAllocationProblem):string {
  const upper=problem.jointModel.scenarios.map(s=>s.terms.reduce((v,t)=>quantity(t.value).n>0n?v.add(quantity(t.value)):v,quantity(s.baseValue))).reduce(min);
  return decimal(upper);
}
/** Nonnegative numerical proposals become a proof only after original canonical
 * inequalities are reconstructed here. No producer matrix is consulted. */
function canonicalLagrangianBound(prepared:Prepared,proposal:AllocationDualProposal):AllocationLagrangianProof {
  const {problem:p}=prepared,h=p.mandate.horizon.periods,ids=p.policies.map(q=>q.ref.id);
  if(proposal?.schema!=='finnor.s5.dual-proposal.v1'||!Array.isArray(proposal.multipliers)||proposal.multipliers.length>30000)throw new AllocationContractError('INVALID_CANDIDATE','Unsupported dual proposal');
  const products=new Map<string,string[]>();for(const s of p.jointModel.scenarios)for(const term of s.terms)if(term.policyIds.length>1)products.set([...term.policyIds].sort().join('|'),[...term.policyIds].sort());
  const variable=(group:string[])=>group.length===1?`x:${group[0]}`:`y:${[...group].sort().join('|')}`;
  const variables=[...ids.map(id=>`x:${id}`),...[...products.keys()].map(key=>`y:${key}`)];
  type Row={a:Map<string,Q>;b:Q};const rows=new Map<string,Row>();
  const add=(id:string,a:Map<string,Q>,b:Q,lower:Q|null=null)=>{
    if(rows.has(`upper:${id}`))throw new AllocationContractError('INVALID_CANDIDATE','Canonical dual constraint identity collision');
    rows.set(`upper:${id}`,{a,b});if(lower!==null)rows.set(`lower:${id}`,{a:new Map([...a].map(([k,v])=>[k,v.mul(number(-1))])),b:lower.mul(number(-1))});
  };
  const coeff=(fn:(id:string)=>Q)=>new Map(ids.map(id=>[`x:${id}`,fn(id)]));
  for(const [key,group]of products){for(const id of group)add(`product:${key}:${id}`,new Map([[`y:${key}`,number(1)],[`x:${id}`,number(-1)]]),ER_ZERO);
    add(`product:${key}:lower`,new Map([[`y:${key}`,number(-1)],...group.map(id=>[`x:${id}`,number(1)] as const)]),number(group.length-1));}
  for(const c of p.jointModel.choiceConstraints)add(`choice:${c.id}`,new Map(c.policyIds.map(id=>[`x:${id}`,number(1)])),number(c.maximum),number(c.minimum));
  for(const id of new Set(p.outstanding.flatMap(o=>o.policyRefs.map(q=>q.id))))if(ids.includes(id))add(`already-committed:${id}`,new Map([[`x:${id}`,number(1)]]),ER_ZERO);
  const tailResource=p.mandate.utility.tail.terminalLiability!==0?p.funding[0]!.terminalLiabilityResourceId:null;
  const fixed=(r:CanonicalAllocationProblem['resources'][number],t:number,negative=false)=>resourceUsage(r.kind,(negative?prepared.minimumBaseline:prepared.baseline).get(r.resourceId)!,t).add(tailResource===r.resourceId&&t===h?number(p.mandate.utility.tail.terminalLiability):ER_ZERO);
  const objectives=new Map<string,{a:Map<string,Q>;base:Q}>();
  for(const path of prepared.paths){const s=p.jointModel.scenarios.find(q=>q.id===path.id)!;
    for(const r of p.resources)for(let t=0;t<=h;t++)add(`resource:${r.resourceId}:${s.id}:${t}`,coeff(id=>resourceUsage(r.kind,path.demands.get(id)!.get(r.resourceId)!,t)),quantity(r.availability[t]!.amount!).sub(quantity(r.safetyMargin)).sub(fixed(r,t)));
    for(const c of new Map(p.resources.flatMap(r=>r.covenants).map(c=>[c.id,c])).values())for(const t of c.periods){let b=quantity(c.maximum).sub(quantity(c.safetyMargin));const a=coeff(()=>ER_ZERO);
      for(const term of c.terms){const r=p.resources.find(r=>r.resourceId===term.resourceId)!,q=quantity(term.coefficient);b=b.sub(q.mul(fixed(r,t,q.n<0n)));for(const id of ids)a.set(`x:${id}`,a.get(`x:${id}`)!.add(q.mul(resourceUsage(r.kind,path.demands.get(id)!.get(r.resourceId)!,t))));}
      add(`covenant:${c.id}:${s.id}:${t}`,a,b);
    }
    const totals=new Map<string,Map<string,Q>>(),occupied=new Map<string,Map<string,Q[]>>();const human=coeff(()=>ER_ZERO);
    for(const d of p.mandate.resources.dimensions){totals.set(d.id,coeff(()=>ER_ZERO));occupied.set(d.id,new Map(ids.map(id=>[id,zeroes(h+1)])));}
    for(const policy of p.policies)for(const nodeId of s.policyPaths.find(q=>q.policyRef.id===policy.ref.id)!.nodeIds){const node=policy.nodes.find(q=>q.id===nodeId)!,action=policy.problem.actions.find(q=>q.id===node.actionId)!,id=policy.ref.id;
      human.set(`x:${id}`,human.get(`x:${id}`)!.add((exactPolicyActionQuantity(policy,action,'humanSeconds')??number(action.humanSeconds))));
      for(const d of p.mandate.resources.dimensions){const a=totals.get(d.id)!;a.set(`x:${id}`,a.get(`x:${id}`)!.add((exactPolicyActionQuantity(policy,action,'resources',d.id)??number(action.resources[d.id]!))));const v=occupied.get(d.id)!.get(id)!;for(let t=node.period;t<Math.min(h+1,node.period+action.occupationPeriods);t++)v[t]=v[t]!.add((exactPolicyActionQuantity(policy,action,'occupancy',d.id)??number(action.occupancy[d.id]!)));}
    }
    for(const d of p.mandate.resources.dimensions){add(`mandate-total:${d.id}:${s.id}`,totals.get(d.id)!,number(d.totalLimit));for(let t=0;t<=h;t++)add(`mandate-occupancy:${d.id}:${s.id}:${t}`,coeff(id=>occupied.get(d.id)!.get(id)![t]!),number(d.capacity));}
    for(const c of p.mandate.resources.couplings)for(let t=0;t<=h;t++)add(`mandate-coupling:${c.id}:${s.id}:${t}`,coeff(id=>sum(Object.entries(c.weights).map(([d,w])=>number(w).mul(occupied.get(d)!.get(id)![t]!)))),number(c.maxPerPeriod));
    add(`mandate-human:${s.id}`,human,number(p.mandate.search.maxHumanSeconds));
    const a=new Map(variables.map(key=>[key,ER_ZERO]));for(const term of s.terms){const key=variable(term.policyIds);a.set(key,a.get(key)!.add(quantity(term.value)));}
    objectives.set(s.id,{a,base:quantity(s.baseValue)});add(`risk-floor:${s.id}`,new Map([...a].map(([k,v])=>[k,v.mul(number(-1))])),quantity(s.baseValue).sub(number(p.mandate.risk.minimumUtility)));
  }
  const multipliers=new Map<string,Q>(),weights=new Map<string,Q>();let mass=ER_ZERO;
  for(const m of proposal.multipliers){if(!m||!['upper','lower'].includes(m.side)||typeof m.rowId!=='string')throw new AllocationContractError('INVALID_CANDIDATE','Invalid dual multiplier identity');const key=`${m.side}:${m.rowId}`;
    if(multipliers.has(key))throw new AllocationContractError('INVALID_CANDIDATE','Duplicate dual multiplier');const q=allocationQuantity(m.value);if(q.n<0n)throw new AllocationContractError('INVALID_CANDIDATE','Negative dual multiplier');multipliers.set(key,q);
    if(m.rowId.startsWith('worst-path:')){const id=m.rowId.slice('worst-path:'.length);if(m.side!=='upper'||!objectives.has(id))throw new AllocationContractError('INVALID_CANDIDATE','Unknown dual scenario');weights.set(id,q);mass=mass.add(q);}
    else if(!rows.has(key))throw new AllocationContractError('INVALID_CANDIDATE','Unknown canonical dual constraint');
  }
  if(mass.n<=0n)throw new AllocationContractError('INVALID_CANDIDATE','Dual scenario mass must be positive');
  let upper=ER_ZERO;const residual=new Map(variables.map(key=>[key,ER_ZERO]));
  for(const [id,w]of weights){const objective=objectives.get(id)!,lambda=w.div(mass);upper=upper.add(lambda.mul(objective.base));for(const [key,q]of objective.a)residual.set(key,residual.get(key)!.add(lambda.mul(q)));}
  for(const [key,w]of multipliers){const row=rows.get(key);if(!row)continue;const alpha=w.div(mass);upper=upper.add(alpha.mul(row.b));for(const [id,q]of row.a)residual.set(id,residual.get(id)!.sub(alpha.mul(q)));}
  upper=upper.add(sum([...residual.values()].filter(q=>q.n>0n)));if(upper.n.toString().length>512||upper.d.toString().length>512)throw new AllocationContractError('LIMIT_EXCEEDED','Dual rational precision bound exceeded');
  const scale=10n**12n,rounded=(upper.n*scale/upper.d)+(upper.n>0n&&upper.n*scale%upper.d!==0n?1n:0n);
  return {schema:'finnor.s5.lagrangian-bound.v1',problemRef:p.ref,proposal,exactUpper:{numerator:upper.n.toString(),denominator:upper.d.toString()},roundedUpper:decimal(new ExperimentRational(rounded,scale)),qualification:'EXACT_RATIONAL_CANONICAL_BOX_BOUND_NOT_SCARCITY_PRICE'};
}

export function certifyAllocationOptimization(problem:CanonicalAllocationProblem,selectedPolicyIds:string[],input:{deadlineAt:number;searchTermination:string;solverUpperBoundEstimate:number|null;dualProposal?:AllocationDualProposal|null}):{check:AllocationCheck;optimization:AllocationOptimizationCertificate} {
  const prepared=prepare(problem),check=evaluate(prepared,selectedPolicyIds);if(!check.feasible||check.objective===null)throw new AllocationContractError('INVALID_CANDIDATE','Original canonical constraints reject producer incumbent');
  const incumbent=quantity(check.objective);let upper=quantity(analyticAllocationUpperBound(problem)),checkedSubsets=0,complete=false,best:Q|null=null;
  const exclusionBest=new Map<string,Q|null>(problem.policies.map(policy=>[policy.ref.id,null]));
  // This is a capped proof checker for the registered tractable binary subclass,
  // not a replacement general-purpose optimization producer. Every subset is
  // evaluated against original constraints independently of the HiGHS matrix.
  if(problem.policies.length<=14){const ids=problem.policies.map(policy=>policy.ref.id),end=2**ids.length;
    for(let mask=0;mask<end;mask++){if(performance.now()>=input.deadlineAt)break;
      const chosen=ids.filter((_,i)=>Boolean(mask&(2**i))),candidate=evaluate(prepared,chosen,false);checkedSubsets++;
      if(candidate.feasible&&candidate.objective!==null){const value=quantity(candidate.objective);best=best===null?value:max(best,value);
        for(const id of ids.filter(id=>!chosen.includes(id))){const previous=exclusionBest.get(id)!;exclusionBest.set(id,previous===null?value:max(previous,value));}}
    }complete=checkedSubsets===end;if(complete){if(best===null)throw new AllocationContractError('INVALID_CANDIDATE','Claimed incumbent has no canonical feasible subset');upper=best;}
  }
  let boundProof:AllocationLagrangianProof|undefined,boundProposalDisposition:AllocationOptimizationCertificate['boundProposalDisposition']='NOT_PROVIDED';
  if(!complete&&input.dualProposal){try{const proof=canonicalLagrangianBound(prepared,input.dualProposal);boundProposalDisposition='CHECKED_NOT_STRONGER';if(quantity(proof.roundedUpper).compare(upper)<0){upper=quantity(proof.roundedUpper);boundProof=proof;boundProposalDisposition='CHECKED_ADOPTED';}}catch(e){if(!(e instanceof AllocationContractError))throw e;boundProposalDisposition='REJECTED_HINT_ANALYTIC_RETAINED';}}
  if(upper.compare(incumbent)<0)throw new AllocationContractError('INVALID_CANDIDATE','Upper bound contradicts an independently feasible incumbent');
  const gap=upper.sub(incumbent),normalization=number(problem.mandate.scoring.normalization);
  return immutableControl({check,optimization:{objectiveUnit:problem.mandate.utility.unit,incumbent:decimal(incumbent),upperBound:decimal(upper),gapUpperBound:decimal(gap),normalization:decimal(normalization),normalizedGapUpperBound:allocationRatioUpper(gap,normalization),
    boundProposalDisposition,strength:complete?'EXACT_COMPLETE_SUBSET_CHECK':boundProof?'EXACT_CANONICAL_LAGRANGIAN_BOUND':'EXACT_ANALYTIC_RELAXATION_BOUND',...(boundProof?{boundProof}:{}),checkedSubsets,completeSearch:complete,searchTermination:input.searchTermination,
    solverUpperBoundEstimate:input.solverUpperBoundEstimate,solverEstimateQualification:'FLOAT64_NUMERICAL_NOT_INDEPENDENT_PROOF',uncertaintyGap:'UNKNOWN',identificationGap:'UNKNOWN',omittedModelGap:'UNKNOWN',fieldEconomicValue:'UNKNOWN',
    opportunityCosts:check.selectedPolicyIds.map(policyId=>{const excluded=complete?exclusionBest.get(policyId):null;return {policyId,exclusionValue:excluded?decimal(excluded):null,displacement:complete&&best!==null&&excluded?decimal(best.sub(excluded)):null,basis:complete&&excluded?'EXACT_SAME_MODEL_EXCLUSION':'UNKNOWN'};})}});
}
const exactOptimizationReadCache=new Map<string,AllocationOptimizationCertificate>();
/** Production certificate checker, used on persistence/read/commit. A hash or
 * an agreement with a second solver cannot substitute for these checks. */
export function verifyAllocationCertificate(problem:CanonicalAllocationProblem,certificate:AllocationCertificate,deadlineMs=30000):AllocationCheck {
  const {ref,...body}=certificate;
  const selected=problem.policies.filter(p=>certificate.check.selectedPolicyIds.includes(p.ref.id));
  if(!sameAllocationRef(ref,allocationRef('S5','allocation-certificate',body))||certificate.schema!=='finnor.allocation-certificate.v1'||certificate.semanticOwner!=='S5'||certificate.version!==problem.methodVersion||certificate.tenantId!==problem.tenantId||certificate.principalId!==problem.principalId||certificate.episodeId!==problem.episodeId||!sameAllocationRef(certificate.problemRef,problem.ref)||!sameAllocationRef(certificate.mandateRef,problem.mandate.ref)||certificate.rightsRef!==problem.mandate.rightsRef||!sameAllocationRef(certificate.jointModelRef,problem.jointModel.ref)||!sameAllocationRef(certificate.resourceRefs,problem.resources.map(r=>r.ref))||certificate.snapshotDigest!==problem.snapshotDigest||!sameAllocationRef(certificate.policyBindings,selected.map(p=>({policyRef:p.ref,demandDigest:p.demand.contentDigest})))||certificate.validFrom!==problem.knowledgeAt||certificate.validUntil!==problem.validUntil||!sameAllocationRef(certificate.admission,ALLOCATION_ADMISSION)||certificate.compute.semanticOwner!=='S5'||!sameAllocationRef(certificate.compute.inputRef,problem.ref))throw new AllocationContractError('INVALID_CANDIDATE','Certificate original identity, authority or dependency binding differs');
  if(certificate.obligationsDigest!==epistemicHash({outstanding:problem.outstanding,existingUse:problem.resources.map(r=>({resourceRef:r.ref,existingUse:r.existingUse})),policyObligations:problem.policies.map(p=>p.problem.obligations)})||certificate.compute.tenantId!==problem.tenantId||certificate.compute.principalId!==problem.principalId||certificate.compute.rightsRef!==problem.mandate.rightsRef||!sameAllocationRef(certificate.compute.admission,{status:'BLOCKED_EXTERNAL',receipt:null})||certificate.compute.backend.deterministicReplayClaimed!==false)throw new AllocationContractError('INVALID_CANDIDATE','Certificate obligations or compute provenance differs');
  const check=verifyCanonicalAllocation(problem,certificate.check.selectedPolicyIds);
  if(!check.feasible||!sameAllocationRef(check,certificate.check)||certificate.optimization.incumbent!==check.objective||certificate.optimization.objectiveUnit!==problem.mandate.utility.unit||certificate.optimization.normalization!==decimal(number(problem.mandate.scoring.normalization)))throw new AllocationContractError('INVALID_CANDIDATE','Certificate canonical feasibility or objective witness differs');
  const claimed=certificate.optimization;
  if(!sameAllocationRef(claimed.opportunityCosts.map(c=>c.policyId).sort(),check.selectedPolicyIds)||claimed.solverUpperBoundEstimate!==null&&!Number.isFinite(claimed.solverUpperBoundEstimate))throw new AllocationContractError('INVALID_CANDIDATE','Optimization identity or numerical estimate differs');
  if(claimed.boundProof&&claimed.strength!=='EXACT_CANONICAL_LAGRANGIAN_BOUND'||claimed.boundProposalDisposition==='CHECKED_ADOPTED'&&claimed.strength!=='EXACT_CANONICAL_LAGRANGIAN_BOUND'||claimed.boundProposalDisposition&&!['CHECKED_ADOPTED','CHECKED_NOT_STRONGER','REJECTED_HINT_ANALYTIC_RETAINED','NOT_PROVIDED'].includes(claimed.boundProposalDisposition))throw new AllocationContractError('INVALID_CANDIDATE','Unsupported bound hint qualification');
  if(!['EXACT_COMPLETE_SUBSET_CHECK','EXACT_ANALYTIC_RELAXATION_BOUND','EXACT_CANONICAL_LAGRANGIAN_BOUND'].includes(claimed.strength)||claimed.completeSearch!==(claimed.strength==='EXACT_COMPLETE_SUBSET_CHECK')||certificate.status!=='PROPOSED_CHECKED'||certificate.qualification!=='MODEL_RELATIVE_FINITE_JOINT_PATHS_ORDINARY_RESERVATION')throw new AllocationContractError('INVALID_CANDIDATE','Unsupported optimization or clearance qualification');
  // Cache only the completed bounded mathematical recheck. Original identity,
  // canonical primal and CURRENT owner authorization/resource checks still run.
  // No admission, rights, freshness or execution authority is cached. Cold
  // processes verify independently; bounded64 entries do not grow with history.
  const cacheKey=epistemicHash({problemRef:problem.ref,selected:check.selectedPolicyIds});let known:AllocationOptimizationCertificate|null=null;
  if(claimed.strength==='EXACT_COMPLETE_SUBSET_CHECK'){known=exactOptimizationReadCache.get(cacheKey)??certifyAllocationOptimization(problem,check.selectedPolicyIds,{deadlineAt:performance.now()+deadlineMs,searchTermination:claimed.searchTermination,solverUpperBoundEstimate:claimed.solverUpperBoundEstimate}).optimization;
    if(known.completeSearch&&!exactOptimizationReadCache.has(cacheKey)){if(exactOptimizationReadCache.size>=64)exactOptimizationReadCache.delete(exactOptimizationReadCache.keys().next().value!);exactOptimizationReadCache.set(cacheKey,known);}}

  if(claimed.strength==='EXACT_COMPLETE_SUBSET_CHECK'&&!known?.completeSearch)throw new AllocationContractError('LIMIT_EXCEEDED','Independent certificate verification budget exhausted; accountability retained');
  if(claimed.strength==='EXACT_COMPLETE_SUBSET_CHECK'&&(!known?.completeSearch||claimed.checkedSubsets!==known!.checkedSubsets||claimed.upperBound!==known!.upperBound||!sameAllocationRef([...claimed.opportunityCosts].sort((a,b)=>a.policyId.localeCompare(b.policyId)),[...known!.opportunityCosts].sort((a,b)=>a.policyId.localeCompare(b.policyId)))))throw new AllocationContractError('INVALID_CANDIDATE','False exact optimization or opportunity-cost certificate');
  if(claimed.strength==='EXACT_ANALYTIC_RELAXATION_BOUND'&&claimed.upperBound!==analyticAllocationUpperBound(problem))throw new AllocationContractError('INVALID_CANDIDATE','Unsupported analytic upper bound');
  if(claimed.strength==='EXACT_CANONICAL_LAGRANGIAN_BOUND'){
    if(!claimed.boundProof||!sameAllocationRef(canonicalLagrangianBound(prepare(problem),claimed.boundProof.proposal),claimed.boundProof)||claimed.upperBound!==claimed.boundProof.roundedUpper)throw new AllocationContractError('INVALID_CANDIDATE','False canonical Lagrangian bound');
  }
  if(claimed.strength!=='EXACT_COMPLETE_SUBSET_CHECK'&&(claimed.opportunityCosts.some(c=>c.basis!=='UNKNOWN'||c.exclusionValue!==null||c.displacement!==null)||claimed.checkedSubsets<0||claimed.checkedSubsets>2**Math.min(14,problem.policies.length)))throw new AllocationContractError('INVALID_CANDIDATE','Unsupported displacement or search accounting');
  const upper=quantity(claimed.upperBound),incumbent=quantity(claimed.incumbent),gap=upper.sub(incumbent);
  if(gap.n<0n||claimed.gapUpperBound!==decimal(gap)||claimed.normalizedGapUpperBound!==allocationRatioUpper(gap,number(problem.mandate.scoring.normalization))||claimed.uncertaintyGap!=='UNKNOWN'||claimed.identificationGap!=='UNKNOWN'||claimed.omittedModelGap!=='UNKNOWN'||claimed.fieldEconomicValue!=='UNKNOWN')throw new AllocationContractError('INVALID_CANDIDATE','False gap or unsupported economic/scientific qualification');
  return check;
}
