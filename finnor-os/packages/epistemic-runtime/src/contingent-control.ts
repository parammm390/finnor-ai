import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BeliefViewPin, ContingentPolicy, ControlAction, ControlDecision, ControlDecisionInput, ControlDynamicsAdapter, ControlInstrumentSupport,
 ControlObservation, ControlProblem, ControlWorld, EconomicMandate, ExperimentRef, PolicyNode, PolicyResultState, ResolvedPolicyAllocation, S4ComputeInvocation, S4ExperienceEvent } from '@finnor/shared-types';
import { epistemicHash } from './source-precedence';
import { CONTROL_ADMISSION, ControlContractError, assertContingentPolicy, immutableControl, parseControlDecision, parseControlProblem, parseEconomicMandate } from './control-contracts';
import { controlObservationToken, validateControlObservationInstruments } from './control-observations';

const files=['./contingent-control.ts','./control-contracts.ts','./control-observations.ts','./intervention-control.ts','../../shared-types/src/contingent-control.ts','../../private-equity/src/enterprise-control.ts','../../private-equity/src/enterprise-experiments.ts','../../private-equity/src/enterprise-interventions.ts','../../../apps/api/app/api/policies/[operation]/route.ts'].map(p=>fileURLToPath(new URL(p,import.meta.url)));
const loadedSources=Promise.all(files.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
void loadedSources.catch(()=>undefined);
export async function controlSourcesCurrent(expected:S4ComputeInvocation['backend']['sourceDigests']):Promise<boolean>{try{return epistemicHash(await loadedSources)===epistemicHash(expected)&&(await Promise.all(expected.map(async s=>createHash('sha256').update(await readFile(s.path)).digest('hex')===s.sha256))).every(Boolean);}catch{return false;}}
export function prepareS4Experience(m:EconomicMandate,type:S4ExperienceEvent['type'],revisionRef:string,detail:Record<string,unknown>,parents:string[]=[],knowledgeAt=new Date().toISOString()):S4ExperienceEvent {
 const body={schema:'finnor.s4.experience.v1' as const,semanticOwner:'S4' as const,episodeId:m.episodeId,type,tenantId:m.tenantId,principalId:m.principalId,rightsRef:m.rightsRef,revisionRef,contentDigest:epistemicHash(detail),knowledgeAt,validAt:m.horizon.startAt,preparedParentRefs:parents,causalParents:[] as [],dependencyRefs:[m.ref.id,m.utilityRef.id],horizon:'H1' as const,uncertainty:'MODEL_CONDITIONAL_UNADMITTED' as const,detail,protectedReceipt:null,appendAuthorityGranted:false as const};
 return immutableControl({...body,eventId:`s4-event:${epistemicHash(body)}`});
}
type Path={world:ControlWorld;utility:number;liability:number;spent:Record<string,number>;occupancy:Record<string,number[]>;humanSeconds:number;
 schedule:Record<string,number[]>;locks:Record<string,number>;pending:ControlObservation[];observations:ControlObservation[]};
type Tree={node:PolicyNode;children:Tree[];value:number};
class Exhausted extends Error {}
class Unsupported extends Error {}
const observationKey=(observations:ControlObservation[])=>JSON.stringify(observations);
const same=(a:unknown,b:unknown)=>epistemicHash(a)===epistemicHash(b);
const pendingDelivery=(p:Path,period:number):Path=>({...p,observations:[...p.observations,...p.pending.filter(o=>o.availablePeriod===period)],pending:p.pending.filter(o=>o.availablePeriod>period)});

export async function synthesizeContingentControl(input:{mandate:unknown;problem:unknown;dynamics:ControlDynamicsAdapter;instruments:ControlInstrumentSupport[];
 now?:string;beliefPins?:BeliefViewPin[];priorPolicyRef?:ExperimentRef|null;validUntilCap?:string;inputArtifactRef?:ExperimentRef|null;budgetStartedAt?:number;
 remainingExpansions?:number}):Promise<{schema:'finnor.s4.policy-result.v1';status:PolicyResultState;policy:ContingentPolicy|null;reasons:string[];compute:S4ComputeInvocation;experience:S4ExperienceEvent[]}> {
 const m=parseEconomicMandate(input.mandate),p=parseControlProblem(input.problem),d=input.dynamics,now=input.now??new Date().toISOString();
 const start=input.budgetStartedAt??performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss,startedAt=new Date().toISOString();
 const expansionLimit=input.remainingExpansions??m.search.maxExpansions;
 if(!Number.isSafeInteger(expansionLimit)||expansionLimit<1||expansionLimit>m.search.maxExpansions)
  throw new ControlContractError('INVALID_REQUEST','Remaining search grant may only attenuate the original mandate');
 let expansions=0,transitions=0,unsupportedSeen=false,uncertaintySeen=false,exhausted=false,policy:ContingentPolicy|null=null,status:PolicyResultState='POLICY_AVAILABLE',reasons:string[]=[];
 const sourceDigests=await loadedSources.catch(()=>[]);
 const compute:S4ComputeInvocation={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S4',id:'',tenantId:m.tenantId,principalId:m.principalId,rightsRef:m.rightsRef,inputRef:`s4-input:${epistemicHash({mandate:m,problem:p,dynamicsRef:d.ref,instruments:input.instruments,now,priorPolicyRef:input.priorPolicyRef??null})}`,outputRefs:[],requestedRoute:'LOCAL_FIXED_SCENARIO_SEARCH',actualRoute:'LOCAL_FIXED_SCENARIO_SEARCH',fallbacks:[],backend:{name:'finnor-nonanticipative-scenario-search',version:'s4-finite-contingent-v1',sourceDigests,nodeVersion:process.version,deterministicReplayClaimed:false},attempts:[],usage:{elapsedMs:0,cpuUserMicros:0,cpuSystemMicros:0,rssBeforeBytes:rss,rssAfterBytes:rss,expansions:0,transitionEvaluations:0,accountingScope:'PROCESS_INTERVAL_INCLUSIVE_NOT_CONTAINER_PEAK'},cost:{money:null,pricebookRef:null,status:'LOCAL_COST_UNMETERED',externalCalls:0},upstreamComputeRefs:d.computeRefs??[],admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
 const dim=m.resources.dimensions.map(x=>x.id),h=m.horizon.periods,unit=m.utility.unit,startPeriod=p.continuation?.elapsedPeriods??0,initialHistory=p.continuation?.actionHistory??[];
 const fail=(s:PolicyResultState,reason:string)=>{status=s;reasons.push(reason);};
 const tick=()=>{if(performance.now()-start>=m.search.deadlineMs)throw new Exhausted('DECISION_DEADLINE');};
 const completeKeys=(a:Record<string,unknown>,keys:string[])=>Object.keys(a).length===keys.length&&keys.every(k=>Object.hasOwn(a,k));
 const atState=(path:Path)=>path.world.history.at(-1)!.states;
 const utility=(states:Record<string,number>,terms:EconomicMandate['utility']['periodTerms'])=>terms.reduce((s,t)=>s+t.coefficient*states[t.variableId]!,0);
 let best:Tree|null=null;
 try{
  if(sourceDigests.length!==files.length)fail('NUMERICAL_FAILURE','LOADED_CONTROL_SOURCE_IDENTITY_UNAVAILABLE');
  else if(!Number.isFinite(Date.parse(now))||Date.parse(m.knowledgeAt)>Date.parse(now)||Date.parse(m.validUntil)<=Date.parse(now)||Date.parse(p.validUntil)<=Date.parse(now))fail('STALE_INPUT','MANDATE_OR_PROBLEM_KNOWLEDGE_EXPIRY');
  else if(Date.parse(now)>=Date.parse(m.horizon.startAt)+(startPeriod+1)*m.horizon.periodMs||startPeriod>0&&Date.parse(now)<Date.parse(m.horizon.startAt)+startPeriod*m.horizon.periodMs)fail('STALE_INPUT','BUSINESS_PERIOD_ELAPSED_REQUIRES_ACCOUNTED_LINKED_CONTINUATION');
  else if(m.ambiguity.kind!=='ROBUST_FIXED_JOINT_SCENARIOS')fail('UNCERTAINTY_UNRESOLVED','MANDATE_HAS_NO_AUTHORIZED_AMBIGUITY_SEMANTICS');
  else if(p.episodeId!==m.episodeId||p.actions.some(a=>a.costUnit!==unit)||!completeKeys(p.baselineExposures,d.exposureIds)||Object.values(p.baselineExposures).some(x=>x.length!==h))throw new ControlContractError('INVALID_REQUEST','Economic unit, episode or full baseline exposure schedule differs');
  else if([...m.utility.periodTerms,...m.utility.terminalTerms].some(t=>d.stateUnits[t.variableId]!==t.unit))throw new ControlContractError('INVALID_REQUEST','Utility term is not bound to an S3 state/unit');
  else if(p.actions.some(a=>!completeKeys(a.resources,dim)||!completeKeys(a.occupancy,dim)||a.lastPeriod>=h||a.kind==='INTERVENE'&&(!completeKeys(a.exposures,d.exposureIds)||new Set(Object.values(a.exposures).map(x=>x.length)).size!==1)))throw new ControlContractError('INVALID_REQUEST','Action resource, deadline or joint dose meaning is incomplete');
  else if(p.obligations.some(o=>o.status==='UNKNOWN'||o.status==='PARTIAL'||o.terminalLiability===null||o.status!=='SETTLED'&&(!o.exposures||!o.resources||!o.occupancy||o.lockedExposureIds===null)))fail('UNCERTAINTY_UNRESOLVED','UNKNOWN_OR_PARTIALLY_SETTLED_EFFECT_REQUIRES_S6_RECONCILIATION');
  else if(p.continuation&&(startPeriod>=h||initialHistory.length!==startPeriod||initialHistory.some(id=>!p.actions.some(a=>a.id===id))||p.continuation.accruedUtility.unit!==unit||!completeKeys(p.continuation.usedResources,dim)||p.continuation.observations.some(o=>o.availablePeriod>startPeriod||Date.parse(o.knowledgeAt)>Date.parse(now))))throw new ControlContractError('INVALID_REQUEST','Continuation history, known costs, elapsed time or lawful observations are incomplete');
  else if(!d.initialWorlds.length||d.initialWorlds.some(w=>!w.supported)||d.initialWorlds.length>m.search.maxWorlds)fail(d.initialWorlds.length>m.search.maxWorlds?'SEARCH_EXHAUSTED':'MODEL_UNSUPPORTED','JOINT_WORLD_SUPPORT_OR_RESOURCE_ENVELOPE_UNAVAILABLE');
  else{
   validateControlObservationInstruments(p.observations,p);
   if(p.observations.some(i=>d.stateUnits[i.variableId]!==i.unit))throw new ControlContractError('INVALID_REQUEST','Instrument unit is not a modeled observable state');
   const known=p.obligations.filter(o=>o.status==='KNOWN_PENDING');
   if(known.some(o=>!completeKeys(o.resources!,dim)||!completeKeys(o.occupancy!,dim)||!completeKeys(o.exposures!,d.exposureIds)||Object.values(o.exposures!).some(x=>x.length!==h)||o.lockedExposureIds!.some(id=>!d.exposureIds.includes(id))))throw new ControlContractError('INVALID_REQUEST','Outstanding obligation schedule/resources are incomplete');
   const observed=p.continuation?.observations??[];
   if(observed.some(o=>!input.instruments.some(i=>i.protocolRef.id===o.instrumentId)&&!p.observations.some(i=>i.id===o.instrumentId)))throw new ControlContractError('INVALID_REQUEST','Continuation has an unresolved observation instrument revision');
   const conditionedWorlds=d.initialWorlds.filter(world=>observed.every(o=>{const instrument=input.instruments.find(i=>i.protocolRef.id===o.instrumentId);if(instrument)return instrument.tokensByMechanism[world.mechanismId]?.includes(o.token)??false;
    const temporal=p.observations.find(i=>i.id===o.instrumentId)!;const lag=startPeriod-(o.availablePeriod-temporal.delayPeriods)-1;if(lag<0||lag>=world.history.length)return false;return controlObservationToken(temporal,{...world,history:world.history.slice(0,world.history.length-lag)})===o.token;}));
   if(!conditionedWorlds.length)throw new Unsupported('OBSERVED_HISTORY_OUTSIDE_JOINT_MODEL_SUPPORT');
   const initial:Path[]=conditionedWorlds.map(world=>{const schedule=structuredClone(p.baselineExposures),locks:Record<string,number>={},occupancy:Record<string,number[]>=Object.fromEntries(dim.map(id=>[id,Array(h).fill(0)])),spent=Object.fromEntries(dim.map(id=>[id,p.continuation?.usedResources[id]??0]));
    for(const o of known){for(const id of dim){spent[id]!+=o.resources![id]!;for(let t=0;t<Math.min(h,o.occupationUntilPeriod);t++)occupancy[id]![t]!+=o.occupancy![id]!;}
     for(const id of d.exposureIds){if(!o.lockedExposureIds!.includes(id)){if(!same(p.baselineExposures[id],o.exposures![id]))throw new ControlContractError('INVALID_REQUEST','Pending obligation cannot overwrite an unlocked exposure channel');continue;}if(locks[id]&&!same(schedule[id],o.exposures![id]))throw new ControlContractError('INVALID_REQUEST','Conflicting outstanding exposure schedules');schedule[id]=[...o.exposures![id]!];locks[id]=Math.max(locks[id]??0,o.occupationUntilPeriod);}}
    return {world:structuredClone(world),utility:p.continuation?.accruedUtility.value??0,liability:m.utility.tail.terminalLiability+p.obligations.reduce((s,o)=>s+o.terminalLiability!,0),spent,occupancy,humanSeconds:p.continuation?.humanSeconds??0,schedule,locks,pending:[],observations:p.continuation?.observations.map(({instrumentId,token,availablePeriod})=>({instrumentId,token,availablePeriod}))??[]};});
   function resourceValid(path:Path):boolean {return m.resources.dimensions.every(r=>path.spent[r.id]!<=r.totalLimit&&path.occupancy[r.id]!.every(v=>v<=r.capacity))&&m.resources.couplings.every(c=>Array.from({length:h},(_,t)=>Object.entries(c.weights).reduce((s,[id,w])=>s+w*path.occupancy[id]![t]!,0)).every(v=>v<=c.maxPerPeriod));}
   function eligible(action:ControlAction,period:number,history:string[],stopped:boolean,observations:ControlObservation[]):string|null {
    if(stopped&&action.kind!=='STOP')return 'BUSINESS_STOP_PRESERVES_PENDING_EFFECTS';
    if(period<action.earliestPeriod||period>action.lastPeriod)return 'OPTION_NOT_YET_AVAILABLE_OR_EXPIRED';
    if(action.atMostOnce&&(history.includes(action.id)||p.obligations.some(o=>o.actionId===action.id)))return 'COMMITMENT_ALREADY_CHOSEN_OR_OUTSTANDING';
    if(action.kind==='INTERVENE'&&Object.values(action.exposures).some(x=>period+x.length>h))return 'INTERVENTION_DURATION_EXCEEDS_COMPLETE_HORIZON';
    if(action.precondition?.afterActionIds.some(id=>!history.includes(id)))return 'PRIOR_COMMITMENT_NOT_IN_LAWFUL_HISTORY';
    if(action.precondition?.observations.some(condition=>!observations.some(o=>o.instrumentId===condition.instrumentId&&
     condition.tokens.includes(o.token)&&o.availablePeriod<=period)))return 'REQUIRED_OBSERVATION_NOT_AVAILABLE_OR_TOKEN_REFUSED';
    return null;
   }
   function advance(paths:Path[],action:ControlAction,t:number):Path[] {
    const output:Path[]=[];
    for(const old of paths){tick();const path:Path={...old,world:old.world,schedule:structuredClone(old.schedule),locks:{...old.locks},spent:{...old.spent},occupancy:structuredClone(old.occupancy),pending:[...old.pending],observations:[...old.observations]};
     for(const id of dim){path.spent[id]!+=action.resources[id]!;for(let k=t;k<Math.min(h,t+action.occupationPeriods);k++)path.occupancy[id]![k]!+=action.occupancy[id]!;}
     path.humanSeconds+=action.humanSeconds;
     if(!resourceValid(path)||path.humanSeconds>m.search.maxHumanSeconds)throw new Unsupported('RESOURCE_OR_HUMAN_ENVELOPE_INFEASIBLE');
     if(action.kind==='INTERVENE')for(const id of d.exposureIds){if((path.locks[id]??0)>t)throw new Unsupported('UNSETTLED_COMMITMENT_CHANNEL_CONFLICT');for(let k=0;k<action.exposures[id]!.length;k++)path.schedule[id]![t+k]=action.exposures[id]![k]!;path.locks[id]=t+action.exposures[id]!.length;}
     path.liability+=action.tailLiability;
     const exposures=Object.fromEntries(d.exposureIds.map(id=>[id,path.schedule[id]![t]!]));
     path.world=d.advance(path.world,exposures,t-startPeriod);transitions++;
     if(!path.world.supported){unsupportedSeen=true;throw new Unsupported('MODEL_TRAJECTORY_OUTSIDE_JOINT_SUPPORT');}
     path.utility+=m.utility.discountFactors[t]!*(utility(atState(path),m.utility.periodTerms)-action.cost);
     if(!Number.isFinite(path.utility))throw new Error('NONFINITE_UTILITY');
     for(const instrument of p.observations.filter(i=>i.afterActionIds.includes(action.id))){const token=controlObservationToken(instrument,path.world);if(token===null){unsupportedSeen=true;throw new Unsupported('OBSERVATION_COARSENING_HAS_UNSUPPORTED_MASS');}path.pending.push({instrumentId:instrument.id,token,availablePeriod:t+instrument.delayPeriods});}
     if(action.kind==='INQUIRE'){
      const instrument=input.instruments.find(i=>same(i.protocolRef,action.protocolRef));if(!instrument||instrument.delayPeriods!==action.informationDelayPeriods||instrument.completeCost>action.cost)throw new Unsupported('INQUIRY_LAW_COST_OR_DELAY_UNRESOLVED');
      const tokens=instrument.tokensByMechanism[path.world.mechanismId];if(!tokens?.length)throw new Unsupported('INQUIRY_MECHANISM_SUPPORT_UNRESOLVED');
      for(const token of tokens)output.push({...path,pending:[...path.pending,{instrumentId:instrument.protocolRef.id,token,availablePeriod:t+instrument.delayPeriods}]});
     }else output.push(path);
     if(output.length>m.search.maxWorlds)throw new Exhausted('OBSERVATION_BRANCH_WORLD_BUDGET');
    }
    return output;
   }
   function terminal(paths:Path[]):number {
    const values=paths.map(path=>path.utility+m.utility.discountFactors[h]!*(utility(atState(path),m.utility.terminalTerms)-path.liability));
    if(values.some(v=>!Number.isFinite(v)))throw new Error('NONFINITE_TERMINAL_VALUE');
    if(values.some(v=>v<m.risk.minimumUtility))throw new Unsupported('FULL_HORIZON_HARD_RISK_FLOOR_INFEASIBLE');
    return Math.min(...values);
   }
   function finish(paths:Path[],action:ControlAction,t:number,history:string[],stopped:boolean,onlyStop=false):Tree {
    const advanced=advance(paths,action,t),groups=new Map<string,Path[]>();
    for(const path of advanced){const next=pendingDelivery(path,t+1),key=observationKey(next.observations);const group=groups.get(key)??[];group.push(next);groups.set(key,group);}
    const children:Tree[]=[];
    let value:number;
    if(t+1===h)value=terminal(advanced);
    else {for(const group of groups.values()){const child=search(group,t+1,[...history,action.id],stopped||action.kind==='STOP',onlyStop);if(!child)throw new Unsupported('NO_FEASIBLE_CONTINUATION');children.push(child);}value=Math.min(...children.map(c=>c.value));}
    const observations=paths[0]!.observations;
    const node:PolicyNode={id:`policy-node:${epistemicHash({period:t,history,observations,actionId:action.id})}`,period:t,actionHistory:[...history],observations:structuredClone(observations),actionId:action.id,valueBounds:[value,value],branches:children.map(c=>({observationKey:observationKey(c.node.observations),childId:c.node.id})),alternatives:[]};
    return {node,children,value};
   }
   function search(paths:Path[],t:number,history:string[],stopped:boolean,onlyStop=false):Tree|null {
    tick();let incumbent:Tree|null=null;const alternatives:PolicyNode['alternatives']=[];
    for(const action of p.actions){if(onlyStop&&action.kind!=='STOP')continue;
     const reason=eligible(action,t,history,stopped,paths[0]!.observations);if(reason){alternatives.push({actionId:action.id,status:'INFEASIBLE',valueBounds:null,reasons:[reason]});continue;}
     if(!onlyStop&&++expansions>expansionLimit)throw new Exhausted('SEARCH_EXPANSION_BUDGET');
     try{const candidate=finish(paths,action,t,history,stopped,onlyStop);alternatives.push({actionId:action.id,status:'POLICY_AVAILABLE',valueBounds:[candidate.value,candidate.value],reasons:[]});
      if(!incumbent||candidate.value>incumbent.value)incumbent=candidate;
      if(t===startPeriod&&(!best||candidate.value>best.value))best=candidate;
     }catch(e){if(e instanceof Unsupported){if(/UNRESOLVED/.test(e.message))uncertaintySeen=true;alternatives.push({actionId:action.id,status:/UNRESOLVED/.test(e.message)?'UNCERTAINTY_UNRESOLVED':/SUPPORT/.test(e.message)?'MODEL_UNSUPPORTED':'INFEASIBLE',valueBounds:null,reasons:[e.message]});}else throw e;}
    }
    if(incumbent)incumbent.node.alternatives=alternatives;
    return incumbent;
   }
   // A full-horizon STOP incumbent is checked before general search. It retains
   // scheduled effects, resource occupancy, liabilities and hard risk limits.
   // Its transitions, CPU and deadline are included in the same invocation.
   try{const fallback=search(initial,startPeriod,initialHistory,initialHistory.some(id=>p.actions.find(a=>a.id===id)?.kind==='STOP'),true);if(fallback){best=fallback;compute.fallbacks.push('INDEPENDENTLY_REEVALUATABLE_FULL_HORIZON_STOP');}}catch(e){if(e instanceof Exhausted){exhausted=true;}else throw e;}
   if(!exhausted)try{const searched=search(initial,startPeriod,initialHistory,initialHistory.some(id=>p.actions.find(a=>a.id===id)?.kind==='STOP'));if(searched)best=searched;}catch(e){if(e instanceof Exhausted){exhausted=true;reasons.push(e.message);}else throw e;}
   if(exhausted)fail('SEARCH_EXHAUSTED','INCOMPLETE_SEARCH_GAP_RETAINED');
   else if(uncertaintySeen)fail('UNCERTAINTY_UNRESOLVED','CANDIDATE_OBSERVATION_LAW_OR_COST_UNRESOLVED_GAP_RETAINED');
   else if(unsupportedSeen)fail('MODEL_UNSUPPORTED','CANDIDATE_TRAJECTORY_SUPPORT_UNRESOLVED_OPTIMALITY_GAP_RETAINED');
   else if(!best)fail('INFEASIBLE','NO_FULL_HORIZON_FEASIBLE_POLICY');
   if(best){
    const nodes:PolicyNode[]=[],parent=new Map<string,string|null>();
    const visit=(tree:Tree,prior:string|null)=>{if(nodes.length>=m.search.maxPolicyNodes)throw new Exhausted('POLICY_IR_NODE_BUDGET');nodes.push(tree.node);parent.set(tree.node.id,prior);for(const child of tree.children)visit(child,tree.node.id);};
    visit(best,null);
    if(Buffer.byteLength(JSON.stringify(nodes))>4*1024*1024)throw new Exhausted('POLICY_IR_BYTE_BUDGET');
    const demandBody={schema:'finnor.contingent-resource-demand.v1' as const,semanticOwner:'S4' as const,mandateRef:m.ref,rightsRef:m.rightsRef,existingObligations:p.obligations,dimensions:m.resources.dimensions,couplings:m.resources.couplings,branches:nodes.map(n=>{const a=p.actions.find(a=>a.id===n.actionId)!;const prior=parent.get(n.id)!;return {nodeId:n.id,parentNodeId:prior,actionId:a.id,period:n.period,total:a.resources,occupancy:a.occupancy,occupationPeriods:a.occupationPeriods,mutuallyExclusiveSiblings:prior?nodes.find(q=>q.id===prior)!.branches.filter(b=>b.childId!==n.id).map(b=>b.childId):[]};}),reservationGranted:false as const,portfolioFeasibilityEstablished:false as const};
    const ranges=d.stateRanges;
    let upper:number=Infinity;
    if(ranges){const maxTerm=(terms:EconomicMandate['utility']['periodTerms'])=>terms.reduce((s,t)=>s+t.coefficient*ranges[t.variableId]![t.coefficient>=0?1:0],0);upper=(p.continuation?.accruedUtility.value??0)+m.utility.discountFactors.slice(startPeriod,h).reduce((s,discount)=>s+discount*maxTerm(m.utility.periodTerms),0)+m.utility.discountFactors[h]!*(maxTerm(m.utility.terminalTerms)-m.utility.tail.terminalLiability);}
    const complete=!exhausted&&!unsupportedSeen&&!uncertaintySeen;
    // For finite reference adapters without state ranges, incomplete bounds
    // remain null in transport below instead of inventing an economic cap.
    if(complete)upper=best.value;
    const lower=best.value;
    const certificate:ContingentPolicy['certificate']={basis:'MODEL_RELATIVE_FINITE_ENUMERATION_FLOAT64',ambiguity:'FIXED_COMPLETE_SCENARIOS_NO_PROBABILITIES',valueBounds:[lower,lower],optimalBounds:[lower,Number.isFinite(upper)?Math.max(lower,upper):null],normalizedRegretBounds:[0,Number.isFinite(upper)?Math.max(0,upper-lower)/m.scoring.normalization:null],completeSearch:complete,finiteScenarioGapOnly:true,distributionAndIdentificationGap:'UNKNOWN',numericalTolerance:1e-8,feasibleIncumbentChecked:true,worlds:initial.length,riskSemantics:m.risk};
    const usedCpu=process.cpuUsage(cpu);Object.assign(compute.usage,{elapsedMs:performance.now()-start,cpuUserMicros:usedCpu.user,cpuSystemMicros:usedCpu.system,rssAfterBytes:process.memoryUsage().rss,expansions:Math.min(expansions,expansionLimit),transitionEvaluations:transitions});
    compute.outputRefs=[`policy-program:${epistemicHash({nodes,certificate,demand:demandBody})}`];
    compute.attempts=[{startedAt,finishedAt:new Date().toISOString(),status}];compute.id=`model-compute:${epistemicHash(compute)}`;
    const body:Omit<ContingentPolicy,'ref'>={schema:'finnor.contingent-policy.v1',semanticOwner:'S4',version:'s4-finite-contingent-v1',tenantId:m.tenantId,principalId:m.principalId,episodeId:m.episodeId,knowledgeAt:now,validUntil:new Date(Math.min(Date.parse(m.validUntil),Date.parse(p.validUntil),input.validUntilCap?Date.parse(input.validUntilCap):Infinity)).toISOString(),mandateRef:m.ref,mandate:m,problem:p,priorPolicyRef:input.priorPolicyRef??null,resultState:status,bindings:{modelRef:p.modelRef,dynamicsRef:d.ref,rightsRef:m.rightsRef,beliefPins:input.beliefPins??[],protocolRefs:input.instruments.map(i=>i.protocolRef),inputArtifactRef:input.inputArtifactRef??null,methodVersion:'s4-finite-contingent-v1',obligationsDigest:epistemicHash(p.obligations),allocationRefs:[]},rootNodeId:best.node.id,nodes,demand:{...demandBody,contentDigest:epistemicHash(demandBody)},certificate,compute:immutableControl(compute),limitations:[...d.limitations,'Robust finite scenario value is not an expected monetary value or realized value','Unsampled distribution, identification and temporal instrument calibration gaps UNKNOWN','Local FLOAT64 completeness is not a formal roundoff or field-optimality proof','Local costs unmetered; protected mandate/history/allocation/method/authority unavailable'],admission:CONTROL_ADMISSION};
    policy=immutableControl({...body,ref:{owner:'S4',id:`contingent-policy:${epistemicHash(body)}`,version:body.version,contentDigest:epistemicHash(body)}});
   }
  }
 }catch(e){if(e instanceof ControlContractError)throw e;if(e instanceof Exhausted)fail('SEARCH_EXHAUSTED',e.message);else if(e instanceof Unsupported)fail('MODEL_UNSUPPORTED',e.message);else fail('NUMERICAL_FAILURE',e instanceof Error?e.message:'CONTROL_BACKEND_FAILURE');}
 if(!policy){const usedCpu=process.cpuUsage(cpu);Object.assign(compute.usage,{elapsedMs:performance.now()-start,cpuUserMicros:usedCpu.user,cpuSystemMicros:usedCpu.system,rssAfterBytes:process.memoryUsage().rss,expansions:Math.min(expansions,expansionLimit),transitionEvaluations:transitions});compute.attempts=[{startedAt,finishedAt:new Date().toISOString(),status}];compute.id=`model-compute:${epistemicHash(compute)}`;}
 const revisionRef=policy?.ref.id??compute.inputRef;
 const experience=[prepareS4Experience(m,policy?'POLICY_SEARCH':'REJECTION',revisionRef,{status,reasons,policyRef:policy?.ref??null,certificate:policy?.certificate??null,consideredChoices:policy?.nodes.map(n=>({nodeId:n.id,alternatives:n.alternatives}))??[],transitionEvaluations:transitions},input.priorPolicyRef?[input.priorPolicyRef.id]:[],now),prepareS4Experience(m,'COMPUTE',revisionRef,{compute},[],now)];
 if(input.priorPolicyRef)experience.push(prepareS4Experience(m,'POLICY_REVISION',revisionRef,{priorPolicyRef:input.priorPolicyRef,policyRef:policy?.ref??null,status},[input.priorPolicyRef.id],now));
 return immutableControl({schema:'finnor.s4.policy-result.v1',status,policy,reasons,compute,experience});
}

export function decideContingentPolicy(policy:ContingentPolicy,value:unknown,allocation:ResolvedPolicyAllocation|null=null):ControlDecision {
 assertContingentPolicy(policy);const input=parseControlDecision(value);let status:PolicyResultState='POLICY_AVAILABLE',node:PolicyNode|undefined,reasons:string[]=[];
 const rootPeriod=policy.problem.continuation?.elapsedPeriods??0;
 if(Date.parse(input.knowledgeAt)<Math.max(Date.parse(policy.knowledgeAt)+(input.period-rootPeriod)*policy.mandate.horizon.periodMs,Date.parse(policy.mandate.horizon.startAt)+input.period*policy.mandate.horizon.periodMs)||Date.parse(input.knowledgeAt)>=Math.min(Date.parse(policy.validUntil),Date.parse(policy.mandate.horizon.startAt)+(input.period+1)*policy.mandate.horizon.periodMs)||input.period<rootPeriod||input.period>=policy.mandate.horizon.periods||input.actionHistory.length!==input.period||input.observations.some(o=>Date.parse(o.knowledgeAt)>Date.parse(input.knowledgeAt)||o.availablePeriod>input.period)) {status='STALE_INPUT';reasons.push('KNOWLEDGE_TIME_ELAPSED_TIME_OR_OBSERVATION_AVAILABILITY_INVALID');}
 else if(input.rightsRef!==policy.bindings.rightsRef){status='BLOCKED_AUTHORITY';reasons.push('RIGHTS_REVISION_CHANGED');}
 else if(allocation&&checkPolicyAllocation(policy,allocation,input.knowledgeAt).status==='BLOCKED_ALLOCATION'){status='BLOCKED_ALLOCATION';reasons.push('ALLOCATION_REVOKED_EXPIRED_OR_INCONSISTENT');}
 else if(!same(input.obligations,policy.problem.obligations)||!same(input.allocationRefs,[...policy.bindings.allocationRefs,...(allocation?[allocation.ref]:[])])){status='STALE_INPUT';reasons.push('OBLIGATION_OR_ALLOCATION_REVISION_REQUIRES_LINKED_REPLAN');}
 else if(policy.resultState!=='POLICY_AVAILABLE'){status=policy.resultState;reasons.push('POLICY_RESULT_UNRESOLVED_ACTIVATION_WITHHELD_CHECKED_INCUMBENT_RETAINED');}
 else{const observations=input.observations.map(({instrumentId,token,availablePeriod})=>({instrumentId,token,availablePeriod}));node=policy.nodes.find(n=>n.period===input.period&&same(n.actionHistory,input.actionHistory)&&same(n.observations,observations));if(!node){status='MODEL_UNSUPPORTED';reasons.push('UNREGISTERED_OBSERVATION_OR_ACTION_HISTORY_NO_SAFE_BRANCH');}
  else{const action=policy.problem.actions.find(a=>a.id===node!.actionId);
   if(!action||action.precondition?.afterActionIds.some(id=>!input.actionHistory.includes(id))||
    action.precondition?.observations.some(c=>!observations.some(o=>o.instrumentId===c.instrumentId&&c.tokens.includes(o.token)&&o.availablePeriod<=input.period))){
    status='MODEL_UNSUPPORTED';reasons.push('COMMITMENT_PRECONDITION_NOT_IN_RECEIVED_LAWFUL_HISTORY');node=undefined;
   }
  }
 }
 const contextDigest=epistemicHash({input,policyRef:policy.ref,bindings:policy.bindings,resolvedAllocationRef:allocation?.ref??null});const body={schema:'finnor.s4.branch-choice.v1' as const,policyRef:policy.ref,status,nodeId:node?.id??null,actionId:node?.actionId??null,contextDigest,reasons,executionAuthorityGranted:false as const};
 return immutableControl({...body,ref:{owner:'S4',id:`branch-choice:${epistemicHash(body)}`,version:policy.version,contentDigest:epistemicHash(body)}});
}
export function checkPolicyAllocation(policy:ContingentPolicy,allocation:ResolvedPolicyAllocation|null,knowledgeAt:string):{status:PolicyResultState;reasons:string[];executionAuthorityGranted:false} {
 assertContingentPolicy(policy);
 if(!Number.isFinite(Date.parse(knowledgeAt))||!allocation||allocation.owner!=='S5'||allocation.ref.owner!=='S5'||allocation.revoked||!Number.isFinite(Date.parse(allocation.validUntil))||Date.parse(allocation.validUntil)<=Date.parse(knowledgeAt)||Date.parse(policy.validUntil)<=Date.parse(knowledgeAt)||!same(allocation.policyRef,policy.ref)||!same(allocation.mandateRef,policy.mandateRef)||allocation.demandDigest!==policy.demand.contentDigest||allocation.rightsRef!==policy.bindings.rightsRef)return {status:'BLOCKED_ALLOCATION',reasons:['S5_CURRENT_OWNER_RESOLVED_POLICY_MANDATE_DEMAND_RIGHTS_CLEARANCE_REQUIRED'],executionAuthorityGranted:false};
 return {status:'BLOCKED_AUTHORITY',reasons:['MATCHED_ALLOCATION_IS_NOT_PROTECTED_S6_AUTHORITY_OR_METHOD_ADMISSION'],executionAuthorityGranted:false};
}
