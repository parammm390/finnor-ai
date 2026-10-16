import type {AllocationCheck,EconomicMandate} from "@finnor/shared-types";
import type {CoalitionSelection} from "../../../shared-types/src/coalition-programme";
import type {AllocationSnapshot} from "../allocation-store";
import {prepareAllocationResourceBasis,allocationSchedule,checkAllocationResourcePath,allocationResourceEnvelopes,
  type AllocationSchedule} from "../../../epistemic-runtime/src/allocation-resource-check";
import {allocationDerivedQuantity as q,allocationNumber as authored,allocationDecimal as text,allocationRef,
  sameAllocationRef,AllocationContractError} from "../../../epistemic-runtime/src/allocation-contracts";
import {ER_ZERO} from "../../../epistemic-runtime/src/experiment-numerics";
import {m3Hash} from "./v2-contracts";

/** Consume independently reconstructed original option quantities through the
 * SAME S5 financial constraints and retained envelope semantics as legacy S4.
 * This point check does not manufacture a new full-family optimization proof. */
export function checkCoalitionAllocationPoint(selection:CoalitionSelection,mandate:EconomicMandate,snapshot:AllocationSnapshot):AllocationCheck{
 const original=selection.original,candidate=selection.candidate,control=original.controlDemand;
 if(!control)throw new AllocationContractError("INVALID_CANDIDATE","Original S4 dimension/human/staffing/tail demand meaning is absent");
 if(!sameAllocationRef(mandate.ref,selection.mandateRef)||mandate.rightsRef!==selection.rightsRef||
  original.dates.length!==mandate.horizon.periods+1||snapshot.snapshotDigest!==selection.resourceSnapshotDigest||
  original.resources.length!==snapshot.resources.length||
  !original.resources.every(resource=>snapshot.resources.some(current=>sameAllocationRef(resource.sourceRef,current.ref)))||
  selection.checker.candidateDigest!==m3Hash(candidate)||!selection.checker.feasible||!selection.checker.provenance)
  throw new AllocationContractError("STALE_INPUT","Exact joint source/mandate/checker/resource preimages differ");
 const periods=mandate.horizon.periods,resources=snapshot.resources;
 const basis=prepareAllocationResourceBasis(resources,snapshot.outstanding,periods,selection.knowledgeAt);
 const reasons=[...basis.initialReasons],witnesses:AllocationCheck["witnesses"]=[],scenarioValues:AllocationCheck["scenarioValues"]=[];
 if(control.dimensions.length!==mandate.resources.dimensions.length||
  !mandate.resources.dimensions.every(dimension=>control.dimensions.some(binding=>binding.dimensionId===dimension.id)))
  throw new AllocationContractError("INVALID_CANDIDATE","Original authorized dimension mapping is incomplete");
 for(const binding of control.dimensions){
  const dimension=mandate.resources.dimensions.find(dimension=>dimension.id===binding.dimensionId)!;
  if(binding.totalResourceId===null)
   throw new AllocationContractError("INVALID_CANDIDATE","No independently bound zero-total-demand basis for an authorized dimension");
  for(const id of [binding.totalResourceId,binding.occupancyResourceId])if(id!==null&&resources.find(resource=>resource.resourceId===id)?.unit!==dimension.unit)
   throw new AllocationContractError("INVALID_CANDIDATE","Original S4/S5 dimension units differ");
 }
 const selected=candidate.programmeOptions.filter(option=>candidate.selectedOptionIds.includes(option.id));
 if(selected.length!==candidate.selectedOptionIds.length)throw new AllocationContractError("INVALID_CANDIDATE","Original selected option identity differs");
 for(const option of selected)for(const step of option.steps){
  const operator=original.grammar.operators.find(operator=>operator.id===step.operatorId)!;
  if([...operator.equations,...operator.costs].some(equation=>equation.kind==="LIABILITY"&&option.itemIds.includes(equation.itemId)))
   throw new AllocationContractError("INVALID_CANDIDATE","Original terminal liability value needs an explicit owner settlement/funding binding");
 }
 if(snapshot.outstanding.some(commitment=>commitment.policyRefs.some(ref=>sameAllocationRef(ref,selection.ref))))
  reasons.push("POLICY_ALREADY_DURABLY_COMMITTED");
 const increments:AllocationSchedule[]=[];
 for(const world of original.worlds){
  const raw=allocationSchedule(resources,periods);
  for(const resource of resources)for(let date=0;date<=periods;date++)
   raw.get(resource.resourceId)![date]=selected.reduce((sum,option)=>sum.add(q(option.resourceUse[resource.resourceId]![date]!)),ER_ZERO);
  for(const party of original.parties){
   const resource=resources.find(resource=>sameAllocationRef(resource.ref,party.fundingRef));
   if(!resource||resource.resourceClass!=="CASH"||resource.currency!==original.currency||resource.unit!==original.unit)
    throw new AllocationContractError("INVALID_CANDIDATE","Named original paying cash resource is unavailable");
   for(let date=0;date<=periods;date++){
    const out=selected.reduce((sum,option)=>sum.add(q(option.cashOutflows[world.id]![party.id]![date]!)),ER_ZERO);
    raw.get(resource.resourceId)![date]=raw.get(resource.resourceId)![date]!.add(out);
   }
  }
  for(const transfer of candidate.division)if(world.eventTokens[transfer.eventId]===transfer.token)
   for(const party of original.parties){
    const amount=q(transfer.amounts[party.id]!);
    if(amount.n<0n){const resource=resources.find(resource=>sameAllocationRef(resource.ref,party.fundingRef))!;
     raw.get(resource.resourceId)![transfer.date]=raw.get(resource.resourceId)![transfer.date]!.sub(amount);}
   }
  if(mandate.utility.tail.terminalLiability!==0){
   const resource=resources.find(resource=>resource.resourceId===control.terminalLiabilityResourceId);
   if(!resource||resource.resourceClass!=="CASH"||resource.unit!==original.unit||resource.currency!==original.currency)
    reasons.push("MANDATE_TERMINAL_LIABILITY_FUNDING_UNRESOLVED");
   else raw.get(resource.resourceId)![periods]=raw.get(resource.resourceId)![periods]!.add(authored(mandate.utility.tail.terminalLiability));
  }
  const resourceCheck=checkAllocationResourcePath(resources,raw,basis,world.id,periods);
  reasons.push(...resourceCheck.reasons);witnesses.push(...resourceCheck.witnesses);increments.push(raw);
  const occupied=new Map<string,ReturnType<typeof q>[]>();
  for(const dimension of mandate.resources.dimensions){
   const binding=control.dimensions.find(binding=>binding.dimensionId===dimension.id)!;
   const spent=binding.totalResourceId===null?ER_ZERO:selected.reduce((total,option)=>option.resourceUse[binding.totalResourceId!]!.reduce((sum,value)=>sum.add(q(value)),total),ER_ZERO);
   const values=Array.from({length:periods+1},(_,date)=>binding.occupancyResourceId===null?ER_ZERO:
    selected.reduce((sum,option)=>sum.add(q(option.resourceUse[binding.occupancyResourceId!]![date]!)),ER_ZERO));
   occupied.set(dimension.id,values);
   if(spent.compare(authored(dimension.totalLimit))>0||values.some(value=>value.compare(authored(dimension.capacity))>0))
    reasons.push(`MANDATE_RESOURCE_ENVELOPE:${dimension.id}:${world.id}`);
  }
  for(const coupling of mandate.resources.couplings)for(let date=0;date<=periods;date++){
   const used=Object.entries(coupling.weights).reduce((sum,[id,weight])=>sum.add(authored(weight).mul(occupied.get(id)![date]!)),ER_ZERO);
   if(used.compare(authored(coupling.maxPerPeriod))>0)reasons.push(`MANDATE_COUPLING:${coupling.id}:${world.id}:${date}`);
  }
  const human=selected.reduce((sum,option)=>option.steps.reduce((sum,step)=>sum.add(q(control.humanSecondsByOperator[step.operatorId]!)),sum),ER_ZERO);
  if(human.compare(authored(mandate.search.maxHumanSeconds))>0)reasons.push(`MANDATE_HUMAN_BUDGET:${world.id}`);
  const value=original.parties.reduce((sum,party)=>{
   const gross=selected.reduce((sum,option)=>sum.add(q(option.grossPayoffs[world.id]![party.id]!)),ER_ZERO);
   const transfer=candidate.division.filter(transfer=>world.eventTokens[transfer.eventId]===transfer.token)
    .reduce((sum,transfer)=>sum.add(q(transfer.amounts[party.id]!).mul(q(original.discountFactors[transfer.date]!))),ER_ZERO);
   return sum.add(q(party.ownerObjectiveWeight).mul(gross.add(transfer)));
  },ER_ZERO);
  if(value.compare(authored(mandate.risk.minimumUtility))<0)reasons.push(`FULL_HORIZON_RISK_FLOOR:${world.id}`);
  scenarioValues.push({scenarioId:world.id,value:text(value)});
 }
 const objective=original.objective;
 const value=objective.kind==="ROBUST"?scenarioValues.map(value=>q(value.value)).reduce((a,b)=>a.compare(b)<=0?a:b):
  scenarioValues.reduce((sum,value)=>sum.add(q(objective.probabilities[value.scenarioId]!).mul(q(value.value))),ER_ZERO);
 if(value.compare(q(selection.value))!==0)reasons.push("ORIGINAL_S4_JOINT_OBJECTIVE_DIFFERS");
 const feasible=reasons.length===0;
 return {schema:"finnor.allocation-check.v1",problemRef:allocationRef("S5","coalition-allocation-point",
  {selectionRef:selection.ref,snapshotDigest:snapshot.snapshotDigest},selection.version),
  selectedPolicyIds:[selection.ref.id],feasible,reasons:[...new Set(reasons)],objective:feasible?text(value):null,
  scenarioValues,envelopes:allocationResourceEnvelopes(resources,increments,periods),witnesses,
  numericalSemantics:"EXACT_DECIMAL_RATIONAL_ZERO_FEASIBILITY_TOLERANCE",executionAuthorityGranted:false};
}
