import type {CoalitionProblem} from "../../../shared-types/src/coalition-programme";
import type {RationalMILP,RationalRow} from "../../../shared-types/src/robust-programme-search";
import type {CoalitionFamily} from "./programmes";
import {prepareAllocationResourceBasis,canonicalResourceUsage} from "../allocation-resource-check";
import {allocationNumber,allocationDecimal} from "../allocation-contracts";
import {epistemicHash} from "../source-precedence";
import {r2Quantity as q,r2String as text} from "../r2-rational";
import {requireCoalition} from "./guards";

type Terms=Array<[string,string]>;
type Column={optionId:string;variableId:string};
type Transfer={rule:number;partyId:string;variableId:string};
type Row=Omit<RationalRow,"id">;
const authored=(value:number)=>allocationDecimal(allocationNumber(value));
/** MILP correspondence only. Financial quantities and retained baselines use
 * the existing canonical S5 helper; this creates no separate resource ledger. */
export function canonicalCoalitionConstraints(p:CoalitionProblem,family:CoalitionFamily,
 columns:Column[],transfers:Transfer[],worldIds:string[]){
 const variables:RationalMILP["variables"]=[],rows:Row[]=[],canonical=p.canonicalAllocation;
 if(!canonical)return {variables,rows};
 const control=p.controlDemand;
 requireCoalition(control,"CANONICAL_ORIGINAL_CONTROL_MEANING");
 const {mandate,resources,outstanding}=canonical,periods=p.dates.length-1;
 requireCoalition(epistemicHash({resources,outstanding})===canonical.snapshotDigest&&
  epistemicHash(mandate.ref)===epistemicHash(p.objective.mandateRef)&&mandate.horizon.periods===periods&&
  resources.length===p.resources.length&&resources.every(resource=>p.resources.some(original=>
   original.id===resource.resourceId&&epistemicHash(original.sourceRef)===epistemicHash(resource.ref))),
  "CANONICAL_ORIGINAL_OWNER_PREIMAGES");
 const basis=prepareAllocationResourceBasis(resources,outstanding,periods,canonical.knowledgeAt);
 requireCoalition(!basis.initialReasons.length,"CANONICAL_RESOURCE_BASIS_UNRESOLVED:"+basis.initialReasons.join(","));
 // Preserve the existing selected-point refusal until a complete original
 // settlement/funding meaning exists. Missing meaning is not infeasibility.
 requireCoalition(mandate.utility.tail.terminalLiability===0&&!p.grammar.operators.some(operator=>
  [...operator.equations,...operator.costs].some(item=>item.kind==="LIABILITY")),"CANONICAL_TERMINAL_LIABILITY_UNBOUND");
 const ownerCash=new Map(p.parties.map(party=>{
  const cash=resources.find(resource=>epistemicHash(resource.ref)===epistemicHash(party.fundingRef));
  requireCoalition(cash?.resourceClass==="CASH"&&cash.unit===p.unit&&cash.currency===p.currency,"CANONICAL_PARTY_CASH_BINDING");
  return [party.id,cash.resourceId] as const;
 }));
 const covenantInventory=[...new Map(resources.flatMap(resource=>resource.covenants).map(covenant=>[covenant.id,covenant])).values()];
 const needsExactSign=new Set(covenantInventory.flatMap(covenant=>covenant.terms.filter(term=>q(term.coefficient).n<0n).map(term=>term.resourceId)));
 const payerColumns=new Map<string,string>();
 const row=(sense:Row["sense"],rhs:string,terms:Terms)=>rows.push({sense,rhs:text(q(rhs)),terms});
 for(const transfer of transfers){
  const [lo,hi]=p.transfers[transfer.rule]!.bounds[transfer.partyId]!.map(q);
  const name="out_"+transfer.variableId;payerColumns.set(transfer.variableId,name);
  const maximum=lo!.n<0n?text(q("0").sub(lo!)):"0";
  variables.push({id:name,kind:"CONTINUOUS",lower:"0",upper:maximum});
  if(lo!.n>=0n)continue;
  if(hi!.n<=0n){row("E","0",[[name,"1"],[transfer.variableId,"1"]]);continue;}
  row("G","0",[[name,"1"],[transfer.variableId,"1"]]);
  if(!needsExactSign.has(ownerCash.get(transfer.partyId)!))continue;
  const sign="sign_"+transfer.variableId;
  variables.push({id:sign,kind:"BINARY",lower:"0",upper:"1"});
  row("G","0",[[transfer.variableId,"1"],[sign,text(q("0").sub(lo!))]]);
  row("L",text(hi!),[[transfer.variableId,"1"],[sign,text(hi!)]]);
  row("L","0",[[name,"1"],[sign,text(lo!)]]);
  row("L",text(hi!),[[name,"1"],[transfer.variableId,"1"],[sign,text(hi!)]]);
 }
 const options=(coefficient:(index:number)=>string):Terms=>columns.map((column,index)=>[column.variableId,coefficient(index)]);
 const used=(worldId:string,resourceId:string,date:number):Terms=>{
  const resource=resources.find(resource=>resource.resourceId===resourceId)!;
  const prefix=resource.kind==="STOCK"||resource.kind==="CUMULATIVE_EXPENDITURE";
  const dates=prefix?Array.from({length:date+1},(_,i)=>i):[date];
  const terms=options(index=>{
   const option=family.options[index]!;
   let value=dates.reduce((sum,current)=>sum.add(q(option.resourceUse[resourceId]![current]!)),q("0"));
   for(const party of p.parties)if(ownerCash.get(party.id)===resourceId)
    value=dates.reduce((sum,current)=>sum.add(q(option.cashOutflows[worldId]![party.id]![current]!)),value);
   return text(value);
  });
  const world=p.worlds.find(world=>world.id===worldId)!;
  for(const transfer of transfers){
   const rule=p.transfers[transfer.rule]!;
   if(ownerCash.get(transfer.partyId)===resourceId&&dates.includes(rule.date)&&world.eventTokens[rule.eventId]===rule.token)
    terms.push([payerColumns.get(transfer.variableId)!,"1"]);
  }
  return terms;
 };
 for(const worldId of worldIds){
  const world=p.worlds.find(world=>world.id===worldId)!;
  for(const resource of resources)for(let date=0;date<=periods;date++){
   const fixed=canonicalResourceUsage(resource.kind,basis.baseline.get(resource.resourceId)!,date);
   const free=q(resource.availability[date]!.amount!).sub(q(resource.safetyMargin)).sub(q(allocationDecimal(fixed)));
   row("L",text(free),used(worldId,resource.resourceId,date));
  }
  for(const covenant of covenantInventory)for(const date of covenant.periods){
   requireCoalition(date<=periods,"CANONICAL_COVENANT_DATE");
   let limit=q(covenant.maximum).sub(q(covenant.safetyMargin));const terms:Terms=[];
   for(const term of covenant.terms){
    const resource=resources.find(resource=>resource.resourceId===term.resourceId);
    requireCoalition(resource,"CANONICAL_COVENANT_RESOURCE");
    const coefficient=q(term.coefficient),baseline=coefficient.n<0n?basis.minimumBaseline:basis.baseline;
    const fixed=canonicalResourceUsage(resource.kind,baseline.get(resource.resourceId)!,date);
    limit=limit.sub(coefficient.mul(q(allocationDecimal(fixed))));
    terms.push(...used(worldId,resource.resourceId,date).map(([id,value]):[string,string]=>[id,text(coefficient.mul(q(value)))]));
   }
   row("L",text(limit),terms);
  }
  const occupied=new Map<string,(date:number)=>Terms>();
  requireCoalition(control.dimensions.length===mandate.resources.dimensions.length,"CANONICAL_COMPLETE_DIMENSIONS");
  for(const dimension of mandate.resources.dimensions){
   const binding=control.dimensions.find(binding=>binding.dimensionId===dimension.id);
   requireCoalition(binding?.totalResourceId&&resources.find(resource=>resource.resourceId===binding.totalResourceId)?.unit===dimension.unit&&
    (binding.occupancyResourceId===null||resources.find(resource=>resource.resourceId===binding.occupancyResourceId)?.unit===dimension.unit),
    "CANONICAL_DIMENSION_DEMAND_UNIT");
   row("L",authored(dimension.totalLimit),options(index=>text(
    family.options[index]!.resourceUse[binding.totalResourceId!]!.reduce((sum,value)=>sum.add(q(value)),q("0")))));
   const occupancy=(date:number)=>options(index=>binding.occupancyResourceId===null?"0":family.options[index]!.resourceUse[binding.occupancyResourceId]![date]!);
   occupied.set(dimension.id,occupancy);
   for(let date=0;date<=periods;date++)row("L",authored(dimension.capacity),occupancy(date));
  }
  for(const coupling of mandate.resources.couplings)for(let date=0;date<=periods;date++){
   const terms=Object.entries(coupling.weights).flatMap(([id,weight])=>occupied.get(id)!(date)
    .map(([column,value]):[string,string]=>[column,text(q(authored(weight)).mul(q(value)))]));
   row("L",authored(coupling.maxPerPeriod),terms);
  }
  row("L",authored(mandate.search.maxHumanSeconds),options(index=>text(
   family.options[index]!.steps.reduce((sum,step)=>sum.add(q(control.humanSecondsByOperator[step.operatorId]!)),q("0")))));
  const utility=options(index=>text(p.parties.reduce((sum,party)=>sum.add(
   q(party.ownerObjectiveWeight).mul(q(family.options[index]!.grossPayoffs[worldId]![party.id]!))),q("0"))));
  for(const transfer of transfers){
   const rule=p.transfers[transfer.rule]!;
   if(world.eventTokens[rule.eventId]===rule.token){
    const party=p.parties.find(party=>party.id===transfer.partyId)!;
    utility.push([transfer.variableId,text(q(party.ownerObjectiveWeight).mul(q(p.discountFactors[rule.date]!)))]);
   }
  }
  row("G",authored(mandate.risk.minimumUtility),utility);
 }
 return {variables,rows};
}
