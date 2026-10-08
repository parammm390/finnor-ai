import type { ControlObservationInstrument, ControlInstrumentSupport, ControlProblem, EconomicMandate, ExperimentProtocol, InterventionModel, ControlWorld } from '@finnor/shared-types';
import { assertExperimentProtocol } from './experiments';
import { epistemicHash } from './source-precedence';
import { ControlContractError, ControlObservationSchema } from './control-contracts';

/** S2-owned versioned temporal interface. No finite IID projection is made. */
export function validateControlObservationInstruments(instruments:ControlObservationInstrument[],problem:ControlProblem,model?:InterventionModel):void {
 for(const instrument of instruments){if(!ControlObservationSchema.safeParse(instrument).success||instrument.sourceRef.owner!=='S2')throw new ControlContractError('INVALID_REQUEST','Temporal instrument meaning is unavailable');
  const bins=[...instrument.bins].sort((a,b)=>a.lowerInclusive-b.lowerInclusive);
  if(new Set(bins.map(b=>b.category)).size!==bins.length||bins.some((b,i)=>b.lowerInclusive>=b.upperExclusive||(i>0&&bins[i-1]!.upperExclusive>b.lowerInclusive))||instrument.afterActionIds.some(id=>!problem.actions.some(a=>a.id===id)))throw new ControlContractError('INVALID_REQUEST','Temporal observation bins or actions are ambiguous');
  if(model){const state=model.request.stateVariables.find(v=>v.id===instrument.variableId);
   if(!state||state.unit!==instrument.unit||state.role==='COUNTERPARTY')throw new ControlContractError('INVALID_REQUEST','Observation cannot acquire unregistered or private counterparty state');}
 }
}
export function controlObservationToken(instrument:ControlObservationInstrument,world:ControlWorld):string|null {
 const value=world.history.at(-1)?.states[instrument.variableId];if(value===undefined||!Number.isFinite(value))return null;
 return instrument.bins.find(b=>value>=b.lowerInclusive&&value<b.upperExclusive)?.category??null;
}
export function controlInstrumentSupports(protocols:ExperimentProtocol[],model:InterventionModel,mandate:EconomicMandate,problem:ControlProblem):ControlInstrumentSupport[] {
 validateControlObservationInstruments(problem.observations,problem,model);
 const result:ControlInstrumentSupport[]=[];
 for(const action of problem.actions.filter(a=>a.kind==='INQUIRE')){
  const protocol=protocols.find(p=>p.id===action.protocolRef?.id&&p.contentDigest===action.protocolRef.contentDigest);
  if(!protocol)throw new ControlContractError('INVALID_REQUEST','S4 inquiry requires an actual S2 protocol');assertExperimentProtocol(protocol);
  if(protocol.tenantId!==mandate.tenantId||protocol.principalId!==mandate.principalId||epistemicHash(protocol.mandateRef)!==epistemicHash(mandate.ref)||epistemicHash(protocol.decisionContext.utilityRef)!==epistemicHash(mandate.utilityRef)||protocol.decisionContext.lossUnit!==mandate.utility.unit)throw new ControlContractError('INVALID_REQUEST','Inquiry solves a different mandate, utility, rights or unit');
  if(protocol.candidate.likelihood.status!=='SUPPLIED_CONDITIONAL'||protocol.candidate.process.reactivity!=='NONE'||protocol.candidate.process.dependence!=='CONDITIONAL_IID'||protocol.candidate.process.interference!=='NONE'||!['NONE','EXPLICIT_OUTCOME'].includes(protocol.candidate.process.missingness))throw new ControlContractError('INVALID_REQUEST','Unsupported inquiry uncertainty or dependence');
  const cost=protocol.candidate.costEstimate.money;
  if(!cost||cost.unit!==mandate.utility.unit||!Number.isFinite(Number(cost.value))||action.cost<Number(cost.value))throw new ControlContractError('INVALID_REQUEST','Complete inquiry economic cost is unknown or omitted');
  const minimumDelay=Math.max(1,Math.ceil((protocol.candidate.costEstimate.elapsedMs??Infinity)/mandate.horizon.periodMs));
  if(action.informationDelayPeriods<minimumDelay||action.humanSeconds<(protocol.candidate.costEstimate.humanSeconds??Infinity))throw new ControlContractError('INVALID_REQUEST','Inquiry delay or human cost omitted');
  const exposure=Number(protocol.candidate.exposure.unitsPerSample)*protocol.candidate.samples,privacy=Number(protocol.candidate.exposure.privacyUnitsPerSample)*protocol.candidate.samples;
  if(!Number.isFinite(exposure)||!Number.isFinite(privacy)||(exposure>0&&(action.resources.exposure??-1)<exposure)||(privacy>0&&(action.resources.privacy??-1)<privacy))throw new ControlContractError('INVALID_REQUEST','Inquiry exposure or privacy resource omitted');
  const tokensByMechanism:Record<string,string[]>={};
  for(const mechanism of model.request.mechanisms){const digest=epistemicHash({modelRef:model.ref,mechanism});const hypothesisIndex=protocol.hypotheses.findIndex(h=>h.ref.id===`mechanism:${digest}`&&h.ref.contentDigest===digest);
   if(hypothesisIndex<0)throw new ControlContractError('INVALID_REQUEST','Instrument mechanism is not the S3-owned hypothesis');
   const probabilities=protocol.candidate.likelihood.probabilities[hypothesisIndex]!;
   // Exact decimal zero detection: tiny positive support must not underflow
   // into an impossible outcome and grant fictitious information.
   const zero=(decimal:string)=>/^[-+]?0*(?:\.0*)?$/.test(decimal);
   tokensByMechanism[mechanism.id]=protocol.metrics.observations.filter(o=>o.counts.every((n,i)=>n===0||!zero(probabilities[i]!))).map(o=>JSON.stringify({counts:o.counts,sampleSize:o.sampleSize,stop:o.stop}));
   if(!tokensByMechanism[mechanism.id]!.length)throw new ControlContractError('INVALID_REQUEST','Instrument has no justified support');
  }
  result.push({protocolRef:action.protocolRef!,tokensByMechanism,qualification:'SUPPLIED_CONDITIONAL_UNCALIBRATED',delayPeriods:action.informationDelayPeriods,completeCost:action.cost,exposure});
 }
 for(const action of problem.actions)for(const condition of action.precondition?.observations??[]){
  if(problem.observations.some(i=>i.id===condition.instrumentId))continue;
  const support=result.find(i=>i.protocolRef.id===condition.instrumentId);
  if(!support||condition.tokens.some(token=>!Object.values(support.tokensByMechanism).some(tokens=>tokens.includes(token))))
   throw new ControlContractError('INVALID_REQUEST','Commitment precondition is not a supported token of the actual S2 protocol');
 }
 return result;
}
