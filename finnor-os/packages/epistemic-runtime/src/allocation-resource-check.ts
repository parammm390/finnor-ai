import type {AllocationCheck,AllocationEnvelope,AllocationOutstandingCommitment,AllocationResource} from "@finnor/shared-types";
import {ExperimentRational,ER_ZERO} from "./experiment-numerics";
import {allocationDerivedQuantity as quantity,allocationDecimal as decimal,sameAllocationRef} from "./allocation-contracts";

export type AllocationSchedule=Map<string,ExperimentRational[]>;
const zeroes=(n:number)=>Array.from({length:n},()=>ER_ZERO);
const sum=(values:ExperimentRational[])=>values.reduce((a,b)=>a.add(b),ER_ZERO);
export function canonicalResourceUsage(kind:string,values:ExperimentRational[],period:number):ExperimentRational{
 return kind==="STOCK"||kind==="CUMULATIVE_EXPENDITURE"?sum(values.slice(0,period+1)):values[period]!;
}
export function allocationSchedule(resources:AllocationResource[],periods:number):AllocationSchedule{
 return new Map(resources.map(resource=>[resource.resourceId,zeroes(periods+1)]));
}

/** Common canonical quantities, including retained UNKNOWN liabilities and
 * lower envelopes used by negative covenant coefficients. No solver matrix. */
export function prepareAllocationResourceBasis(resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[],
 periods:number,knowledgeAt:string,additionalReasons:string[]=[]){
 const baseline=allocationSchedule(resources,periods),minimumBaseline=allocationSchedule(resources,periods),initialReasons:string[]=[];
 for(const resource of resources){
  baseline.set(resource.resourceId,resource.existingUse.map(quantity));
  minimumBaseline.set(resource.resourceId,resource.existingUse.map(quantity));
  if(resource.revoked)initialReasons.push(`RESOURCE_REVOKED:${resource.resourceId}`);
  if(Date.parse(resource.knowledgeAt)>Date.parse(knowledgeAt)||Date.parse(resource.validUntil)<=Date.parse(knowledgeAt))
   initialReasons.push(`RESOURCE_KNOWLEDGE_OR_EXPIRY:${resource.resourceId}`);
  if(resource.availability.some(availability=>availability.basis!=="REPORTED_AVAILABLE"||availability.amount===null))
   initialReasons.push(`RESOURCE_AVAILABILITY_UNRESOLVED:${resource.resourceId}`);
 }
 initialReasons.push(...additionalReasons);
 for(const commitment of outstanding){
  if(commitment.status==="RESERVED"&&commitment.effectRefs.length)initialReasons.push("RESERVATION_EFFECT_STAGE_INCONSISTENT");
  for(const envelope of commitment.envelopes){
   const resource=resources.find(resource=>resource.resourceId===envelope.resourceId);
   if(!resource||resource.unit!==envelope.unit||resource.kind!==envelope.kind||!sameAllocationRef(resource.horizon,envelope.horizon)||
    envelope.quantities.length!==periods+1||envelope.minimumQuantities?.length!==periods+1){
    initialReasons.push("OUTSTANDING_COMMITMENT_RESOURCE_SEMANTICS_UNRESOLVED");continue;
   }
   const raw=baseline.get(resource.resourceId)!,lower=minimumBaseline.get(resource.resourceId)!;
   for(let period=0;period<=periods;period++){
    raw[period]=raw[period]!.add(quantity(envelope.quantities[period]!));
    lower[period]=lower[period]!.add(quantity(envelope.minimumQuantities[period]!));
    if(canonicalResourceUsage(resource.kind,envelope.minimumQuantities.map(quantity),period)
     .compare(canonicalResourceUsage(resource.kind,envelope.quantities.map(quantity),period))>0)
     initialReasons.push("OUTSTANDING_COMMITMENT_LOWER_ENVELOPE_INVALID");
   }
  }
 }
 return {baseline,minimumBaseline,initialReasons};
}

export function checkAllocationResourcePath(resources:AllocationResource[],incremental:AllocationSchedule,
 basis:ReturnType<typeof prepareAllocationResourceBasis>,scenarioId:string,periods:number,withWitnesses=true){
 const reasons:string[]=[],witnesses:AllocationCheck["witnesses"]=[],total=allocationSchedule(resources,periods);
 for(const resource of resources){
  total.set(resource.resourceId,incremental.get(resource.resourceId)!.map((value,period)=>value.add(basis.baseline.get(resource.resourceId)![period]!)));
  for(let period=0;period<=periods;period++){
   const used=canonicalResourceUsage(resource.kind,total.get(resource.resourceId)!,period),availability=resource.availability[period]!;
   const maximum=availability.amount===null?ER_ZERO:quantity(availability.amount).sub(quantity(resource.safetyMargin)),margin=maximum.sub(used);
   if(margin.n<0n)reasons.push(`RESOURCE_LIMIT:${resource.resourceId}:${scenarioId}:${period}`);
   if(withWitnesses)witnesses.push({constraintId:`resource:${resource.resourceId}`,scenarioId,period,used:decimal(used),maximum:decimal(maximum),margin:decimal(margin)});
  }
 }
 for(const covenant of new Map(resources.flatMap(resource=>resource.covenants).map(covenant=>[covenant.id,covenant])).values())
  for(const period of covenant.periods){
   let used=ER_ZERO;
   for(const term of covenant.terms){
    const resource=resources.find(resource=>resource.resourceId===term.resourceId)!,coefficient=quantity(term.coefficient);
    const values=coefficient.n<0n?incremental.get(resource.resourceId)!.map((value,index)=>value.add(basis.minimumBaseline.get(resource.resourceId)![index]!)):total.get(resource.resourceId)!;
    used=used.add(coefficient.mul(canonicalResourceUsage(resource.kind,values,period)));
   }
   const maximum=quantity(covenant.maximum).sub(quantity(covenant.safetyMargin)),margin=maximum.sub(used);
   if(margin.n<0n)reasons.push(`COVENANT_LIMIT:${covenant.id}:${scenarioId}:${period}`);
   if(withWitnesses)witnesses.push({constraintId:`covenant:${covenant.id}`,scenarioId,period,used:decimal(used),maximum:decimal(maximum),margin:decimal(margin)});
  }
 return {reasons,witnesses};
}

export function allocationResourceEnvelopes(resources:AllocationResource[],increments:AllocationSchedule[],periods:number):AllocationEnvelope[]{
 return resources.map(resource=>{
  const quantities=zeroes(periods+1),minimumQuantities=zeroes(periods+1);let priorMaximum=ER_ZERO,priorMinimum=ER_ZERO;
  for(let period=0;period<=periods;period++){
   const usages=increments.map(raw=>canonicalResourceUsage(resource.kind,raw.get(resource.resourceId)!,period));
   const worst=usages.reduce((a,b)=>a.compare(b)>=0?a:b),least=usages.reduce((a,b)=>a.compare(b)<=0?a:b);
   if(resource.kind==="STOCK"||resource.kind==="CUMULATIVE_EXPENDITURE"){
    quantities[period]=worst.sub(priorMaximum);minimumQuantities[period]=least.sub(priorMinimum);priorMaximum=worst;priorMinimum=least;
   }else{quantities[period]=worst;minimumQuantities[period]=least;}
  }
  return {resourceId:resource.resourceId,unit:resource.unit,kind:resource.kind,horizon:resource.horizon,
   quantities:quantities.map(decimal),minimumQuantities:minimumQuantities.map(decimal)};
 });
}
