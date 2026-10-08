import type {ControlProblem,ControlAction,InterventionModel,ContingentPolicy,ExperimentProtocol} from '@finnor/shared-types';
import {allocationQuantity,allocationDecimal,allocationNumber,AllocationContractError} from '../../../epistemic-runtime/src/allocation-contracts';
import {m3Hash,m3Blocker,CapitalProgramV2Error,type CapitalProgramV2Request} from './v2-contracts';

export interface EconomicDescriptor {
  semanticDigest:string;parentDigest:string;operator:string;structure:string;problem:ControlProblem;
  terms:Array<{exposureId:string;unit:string;before:string;after:string;period:number}>;
  blockers:Array<{code:string;owner:string;requirement:string}>;term:string;start:number;stageFraction:string|null;
}
export function economicDescriptors(request:CapitalProgramV2Request,policy:ContingentPolicy,model:InterventionModel,protocols:ExperimentProtocol[]=[]){
  const permission=request.permitted,base=policy.problem,action=base.actions.find(a=>a.id===permission.actionId),
    exposure=model.request.exposures.find(e=>e.id===permission.exposureId);
  if(!action||action.kind!=='INTERVENE'||!exposure||exposure.unit!==permission.unit||!action.exposures[exposure.id])
    throw new CapitalProgramV2Error('INVALID_REQUEST','Permitted term is not an actual incumbent S3 exposure/action/unit');
  if(base.continuation||base.obligations.some(o=>o.status!=='SETTLED'||o.terminalLiability!==0))
    throw new CapitalProgramV2Error('CHECK_FAILED','ACCOUNTED_S6_CONTINUATION_REQUIRED: pending history cannot be dropped or reinterpreted');
  const before=allocationDecimal(allocationNumber(action.exposures[exposure.id]![0]!)),parentDigest=m3Hash({
    mandate:policy.mandateRef,problem:base,model:model.ref,conventions:'S4_FIXED_JOINT_WORLDS_NO_PROBABILITIES'});
  const semantics=(problem:ControlProblem)=>({mandate:policy.mandateRef,model:model.ref,baseline:problem.baselineExposures,
    actions:problem.actions,observations:problem.observations,obligations:problem.obligations,
    agreement:permission.agreement,resourceRule:permission.resourceRule});
  const initial: EconomicDescriptor={semanticDigest:m3Hash({semantics:semantics(base)}),parentDigest,operator:'RETAIN_CHECKED_INCUMBENT',structure:'INCUMBENT',
    problem:structuredClone(base),terms:[],blockers:[],term:before,start:action.earliestPeriod,stageFraction:null};
  const descriptors=[initial],seen=new Set([initial.semanticDigest]);let omitted=0;
  function add(structure:string,term:string,start:number,fraction:string|null){
    const problem=structuredClone(base),target=problem.actions.find(a=>a.id===action!.id)!;
    const blockers:EconomicDescriptor['blockers']=[];
    if(start>=policy.mandate.horizon.periods)blockers.push(m3Blocker('BUSINESS_PERIOD_OUTSIDE_MANDATE','S4','Do not extend the original full horizon'));
    if(request.financial&&(start!==0||!['IMMEDIATE','WAIT_STOP'].includes(structure)))blockers.push(m3Blocker('NATIVE_FUNDING_TIMING_UNSUPPORTED','UNDERWRITING','Opening principal/entry inputs do not implement delayed facilities or tranches; request a supported financial schedule'));
    if(request.financial&&exposure!.operation!=='FINANCING_CHANGE'&&request.purpose==='FINANCING')
      blockers.push(m3Blocker('S3_FINANCING_CHANGE_EXPOSURE_REQUIRED','S3','Changed native financing requires an exact supported financing intervention'));
    if(structure==='WAIT_STOP')problem.actions=problem.actions.filter(a=>a.kind==='WAIT'||a.kind==='STOP');
    else {
      if(action!.exposures[exposure!.id]!.length!==1)blockers.push(m3Blocker('BASE_MULTI_PERIOD_PARAMETER_RULE_UNSUPPORTED','M3','A new schedule cannot guess the meaning of a multi-period original term'));
      const ratio=allocationQuantity(before).n===0n?null:allocationQuantity(term).div(allocationQuantity(before));
      if(!ratio||ratio.n<0n)blockers.push(m3Blocker('RESOURCE_TRANSFORMATION_UNSUPPORTED','S5','Linear registered resource scaling requires a nonzero same-sign original dose'));
      target.earliestPeriod=start;target.lastPeriod=start;
      target.exposures=Object.fromEntries(Object.entries(target.exposures).map(([id,doses])=>[id,[id===exposure!.id?Number(term):doses[0]!]]));
      if(structure==='STAGED'){
        if(start+2>policy.mandate.horizon.periods)blockers.push(m3Blocker('STAGE_MISSES_FULL_HORIZON','S4','Both committed exposure stages must fit the original consequence horizon'));
        for(const [id,doses] of Object.entries(target.exposures)){
          const original=id===exposure!.id?allocationQuantity(term):allocationNumber(doses[0]!),
            share=allocationQuantity(fraction!);
          target.exposures[id]=[Number(allocationDecimal(original.mul(share))),Number(allocationDecimal(original.mul(allocationQuantity('1').sub(share))))];
        }
      }
      if(ratio)try{
        // Prepare every exact amount before changing the owner-shaped problem.
        // A rational liability cannot be rounded into an executable proposal.
        const scale=(value:number)=>Number(allocationDecimal(allocationNumber(value).mul(ratio)));
        const resources=Object.fromEntries(Object.entries(target.resources).map(([id,value])=>[id,scale(value)])),
          occupancy=Object.fromEntries(Object.entries(target.occupancy).map(([id,value])=>[id,scale(value)])),
          cost=scale(target.cost),tailLiability=scale(target.tailLiability);
        Object.assign(target,{resources,occupancy,cost,tailLiability});
      }catch(error){
        if(!(error instanceof AllocationContractError)||
          !['Nonterminating accounting quantity','Accounting precision exceeds bounded checker'].includes(error.message))throw error;
        blockers.push(m3Blocker('EXACT_RESOURCE_SCALE_UNREPRESENTABLE','S5',
          'The proposed resource, occupancy, cost or tail amount has no supported exact bounded decimal; retain this blocked arrangement without rounding its liability or aborting other candidates'));
      }
      if(structure==='OBSERVABLE_STAGE'){
        const milestone=permission.milestone,instrument=problem.observations.find(i=>i.id===milestone?.instrumentId);
        if(!instrument||!milestone||milestone.tokens.some(token=>!instrument.bins.some(b=>b.category===token)))
          blockers.push(m3Blocker('MILESTONE_OBSERVATION_UNAVAILABLE','S2','Resolve the existing lawful instrument, exact tokens and availability, not a future forecast'));
        else if(!instrument.afterActionIds.includes(target.id))
          blockers.push(m3Blocker('MILESTONE_COMMITMENT_LINEAGE_UNAVAILABLE','S2/S4','The first actual commitment must produce the registered milestone observation'));
        else if(start+instrument.delayPeriods>=policy.mandate.horizon.periods)
          blockers.push(m3Blocker('MILESTONE_MISSES_FUNDING_DEADLINE','S4','Received information must precede the original last business period'));
        else if(problem.actions.length>=8)
          blockers.push(m3Blocker('OWNER_ACTION_CONSTRUCTOR_LIMIT','S4','A composed second commitment must fit the existing eight-action constructor'));
        else{
          const release=structuredClone(target),share=allocationQuantity(fraction!),rest=allocationQuantity('1').sub(share);
          release.id=`m3-release-${m3Hash({action:target.id,term,start,fraction,milestone}).slice(0,40)}`;
          release.earliestPeriod=start+instrument.delayPeriods;release.lastPeriod=release.earliestPeriod;
          release.precondition={afterActionIds:[target.id],observations:[{instrumentId:instrument.id,tokens:[...milestone.tokens]}]};
          for(const [id,doses]of Object.entries(target.exposures)){
            const total=allocationNumber(doses[0]!);
            target.exposures[id]=[Number(allocationDecimal(total.mul(share)))];
            release.exposures[id]=[Number(allocationDecimal(total.mul(rest)))];
          }
          for(const key of ['resources','occupancy'] as const)for(const [id,total]of Object.entries(target[key])){
            target[key][id]=Number(allocationDecimal(allocationNumber(total).mul(share)));
            release[key][id]=Number(allocationDecimal(allocationNumber(total).mul(rest)));
          }
          for(const key of ['cost','tailLiability','humanSeconds'] as const){
            const total=allocationNumber(target[key]);target[key]=Number(allocationDecimal(total.mul(share)));
            release[key]=Number(allocationDecimal(total.mul(rest)));
          }
          problem.actions.push(release);
        }
      }
      if(structure==='INQUIRY_OPTION'){
        const inquiry=problem.actions.find(a=>a.kind==='INQUIRE'&&a.id===permission.inquiryActionId),
          protocol=protocols.find(p=>p.id===inquiry?.protocolRef?.id&&p.contentDigest===inquiry.protocolRef.contentDigest);
        if(!inquiry||!protocol)blockers.push(m3Blocker('AUTHENTIC_INQUIRY_PROTOCOL_REQUIRED','S2','Reuse an exact actual current S2 inquiry action/protocol, conditional law, delay and complete costs'));
        else if(start<inquiry.earliestPeriod||start>inquiry.lastPeriod||start+inquiry.informationDelayPeriods>=policy.mandate.horizon.periods)
          blockers.push(m3Blocker('INQUIRY_MISSES_COMMITMENT_DEADLINE','S2/S4','The complete inquiry and received output must fit the original business horizon'));
        else{
          inquiry.earliestPeriod=start;inquiry.lastPeriod=start;
          target.earliestPeriod=start+inquiry.informationDelayPeriods;target.lastPeriod=target.earliestPeriod;
          const tokens=protocol.metrics.observations.map(o=>JSON.stringify({counts:o.counts,sampleSize:o.sampleSize,stop:o.stop}));
          target.precondition={afterActionIds:[inquiry.id],observations:[{instrumentId:protocol.id,tokens}]};
        }
      }
    }
    const terms=structure==='WAIT_STOP'?[]:[{exposureId:exposure!.id,unit:exposure!.unit,before,after:term,period:target.earliestPeriod}];
    const semanticDigest=m3Hash({semantics:semantics(problem),...(blockers.length?{attempted:{structure,term,start,fraction},blockers}:{})});problem.id=`m3-${semanticDigest.slice(0,48)}`;
    if(seen.has(semanticDigest))return;seen.add(semanticDigest);
    if(descriptors.length>=request.resource.maxGenerated){omitted++;return;}
    descriptors.push({semanticDigest,parentDigest,operator:'PERMITTED_TERM_STRUCTURE_NEIGHBORHOOD',structure,problem,terms,blockers,term,start,stageFraction:fraction});
  }
  for(const structure of permission.structures)for(const start of permission.startPeriods)for(const term of permission.terms){
    if(structure==='STAGED'||structure==='OBSERVABLE_STAGE')for(const fraction of permission.stageFractions)add(structure,term,start,fraction);
    else add(structure,term,start,null);
  }
  return {descriptors,omitted,domain:{semanticOwner:'S4/S3/S5',primitive:'FINITE_REGISTERED_EXPOSURE_PARAMETER',
    operation:exposure.operation,unit:exposure.unit,terms:permission.terms,startPeriods:permission.startPeriods,structures:permission.structures,
    staging:'STAGED_UPFRONT_TWO_PERIOD_EXPOSURE_OR_OBSERVABLE_SECOND_EXPOSURE_COMMITMENT_NOT_LIVE_PAYMENT',
    resourceLaw:'AUTHENTICATED_OWNER_SUPPLIED_LINEAR_SCALING_UNADMITTED',
    uncertainty:'FIXED_RETAINED_JOINT_WORLDS_NO_PROBABILITIES',liveAgreement:'PROPOSED_ONLY'}};
}
export function checkEconomicLowering(descriptor:EconomicDescriptor,output:unknown):void{
  if(m3Hash(output)!==m3Hash(descriptor.problem))throw new CapitalProgramV2Error('CHECK_FAILED','Emitted economic schedule/resources differ from the independently prepared descriptor');
}
export type PrimitiveAction=ControlAction;
