import type {CoalitionProblem} from "../../packages/shared-types/src/coalition-programme";
import type {AllocationResource,EconomicMandate} from "../../packages/shared-types/src";
import {table} from "../r2/fixtures.mts";
import {epistemicHash} from "../../packages/epistemic-runtime/src/source-precedence";
import {allocationRef} from "../../packages/epistemic-runtime/src/allocation-contracts";

/** Authored scientific inputs only. These are NOT actual S4/S5 receipts. */
export function canonicalFixture(source:CoalitionProblem):CoalitionProblem{
 const p=structuredClone(source),template=table(),periods=p.dates.length-1;
 if(!p.discountFactors.every(value=>value==="1"))throw Error("Declared canonical corpus uses original unit discounts only");
 p.owner.tenantId=template.owner.tenantId;p.owner.principalId=template.owner.principalId;
 const horizon={startAt:p.dates[0]!,periodMs:86400000,periods};
 const resources:AllocationResource[]=p.resources.map(original=>{
  const {ref:_ref,...source}=template.resources.resources[0]!;
  const body={...source,resourceId:original.id,tenantId:p.owner.tenantId,
   unit:original.unit,currency:null,kind:original.kind,resourceClass:"COMPUTE" as const,horizon,
   knowledgeAt:p.dates[0]!,asOf:p.dates[0]!,validUntil:"2031-01-01T00:00:00.000Z",
   availability:original.available[p.worlds[0]!.id]!.map(amount=>({amount,basis:"REPORTED_AVAILABLE" as const})),
   existingUse:p.dates.map(()=>"0")};
  return {...body,ref:allocationRef("S5","allocation-resource",body)};
 });
 for(const party of p.parties){
  const {ref:_ref,...templateBody}=resources[0]!;
  const body={...templateBody,resourceId:"cash-"+party.id,unit:p.unit,currency:p.currency,kind:"STOCK" as const,
   resourceClass:"CASH" as const,legalEntityRef:party.partyRef,
   availability:p.dates.map(()=>({amount:"100",basis:"REPORTED_AVAILABLE" as const}))};
  const resource={...body,ref:allocationRef("S5","allocation-resource",body)};
  resources.push(resource);party.fundingRef=resource.ref;
  p.resources.push({id:resource.resourceId,unit:resource.unit,sourceRef:resource.ref,kind:"CUMULATIVE_EXPENDITURE",
   available:Object.fromEntries(p.worlds.map(world=>[world.id,p.dates.map(()=>"100")]))});
 }
 for(const original of p.resources)original.sourceRef=resources.find(resource=>resource.resourceId===original.id)!.ref;
 for(const operator of p.grammar.operators)
  for(const grants of operator.grantChoices)
   for(const resource of p.resources)grants[resource.id]??=p.dates.map(()=>"0");
 const {ref:_mandate,...body}=structuredClone(template.mandate);
 const mandateBody={...body,horizon,knowledgeAt:p.dates[0]!,validUntil:"2031-01-01T00:00:00.000Z",utility:{...body.utility,
  unit:p.unit,discountFactors:p.dates.map(()=>1)},
  resources:{dimensions:[{id:"compute",unit:"native-attempt",resourceClass:"COMPUTE" as const,capacity:4,totalLimit:4}],couplings:[]},
  search:{...body.search,maxExpansions:50000,maxHumanSeconds:900}};
 const digest=epistemicHash(mandateBody);
 const mandate:EconomicMandate={...mandateBody,ref:{owner:"BUSINESS_OWNER",id:"mandate:"+digest,version:"economic-mandate-v1",contentDigest:digest}};
 p.objective.mandateRef=mandate.ref;
 p.controlDemand={schema:"finnor.r5.control-demand.v1",dimensions:[{dimensionId:"compute",totalResourceId:"compute",occupancyResourceId:null}],
  humanSecondsByOperator:Object.fromEntries(p.grammar.operators.map(operator=>[operator.id,"0"])),
  staffing:"NO_EXISTING_EMPLOYMENT_OR_BENEFIT_CHANGE",terminalLiabilityResourceId:null};
 p.canonicalAllocation={schema:"finnor.r5.canonical-allocation-basis.v1",mandate,resources,outstanding:[],
  snapshotDigest:epistemicHash({resources,outstanding:[]}),knowledgeAt:p.dates[0]!};
 return p;
}
export function resealCanonicalFixture(p:CoalitionProblem):void{
 const basis=p.canonicalAllocation!,{ref:_ref,...body}=basis.mandate,digest=epistemicHash(body);
 basis.mandate.ref={owner:"BUSINESS_OWNER",id:"mandate:"+digest,version:"economic-mandate-v1",contentDigest:digest};
 p.objective.mandateRef=basis.mandate.ref;
 for(const resource of basis.resources){
  const {ref:_resource,...body}=resource;resource.ref=allocationRef("S5","allocation-resource",body);
  p.resources.find(original=>original.id===resource.resourceId)!.sourceRef=resource.ref;
  for(const party of p.parties)if(resource.resourceId==="cash-"+party.id)party.fundingRef=resource.ref;
 }
 basis.snapshotDigest=epistemicHash({resources:basis.resources,outstanding:basis.outstanding});
}
