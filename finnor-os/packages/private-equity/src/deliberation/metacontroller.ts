/** Frozen ordinary module: it has no imports, credentials or effect channel.
 * P2 compiles these bytes and admits proposed work under the original grant. */
interface FiniteUnit {
 id:string;kind:string;status:string;prerequisites:string[];mechanism:string;
 steps:number;durationMs:number|null;correlationGroup:string;
}
interface PublicFit {
 mechanism:string;beforeLoss:number|null;predictedGain:number|null;
 completionProbability:number|null;acceptanceProbability:number|null;
 meanElapsedMs:number|null;qualifiedPublicDiagnostic:boolean;
 intervals:Array<{level:number;radius:number|null}>;
}
interface FiniteSnapshot {
 units:FiniteUnit[];incumbentQualified:boolean;lossGap:number|null;
 nativeAttemptCost:number|null;delayMsCost:number|null;
 remainingAttempts:number;remainingMs:number;maxParallel:number;strategy:string;
 active:number;sourceObligation:boolean;sourcePremiseChanged:boolean;unknownAttempt:boolean;
 valueModel:null|{bins:PublicFit[]};
}
interface Chain {
 unitIds:string[];conditionalGain:number|null;incrementalCost:number|null;
 delayLoss:number|null;netUpper:number|null;completionProbability:number|null;
 acceptanceProbability:number|null;expectedGain:number|null;expectedNet:number|null;
 futureControllerCalls:number;predictedCompletionDelayMs:number|null;
 costSupport:'KNOWN_NATIVE_MINIMUM_FORWARD_CONTROLLER_TIME_AND_BILLING_UNKNOWN';
 gainInterval:null|{lower:number;upper:number;nominalCoverage:.9;kind:'EMPIRICAL_PUBLIC_RESIDUAL_DIAGNOSTIC'};
 support:'PUBLIC_MODEL_RELATIVE_DIAGNOSTIC'|'UNAVAILABLE';
}
function deliberate(input:FiniteSnapshot){
 if(input.units.length>8||input.maxParallel>2||input.remainingAttempts<0)throw Error('M2_MODULE_INPUT_BOUND');
 const candidates=input.units.filter(u=>['PENDING','QUEUED','RUNNING'].includes(u.status));
 const completed=new Set(input.units.filter(u=>u.status==='COMPLETED').map(u=>u.id));
 const chains:Chain[]=[];let visited=0;
 for(let mask=0;mask<(1<<candidates.length);mask++){
  if(++visited>256)throw Error('M2_MODULE_CHAIN_BOUND');
  const chain=candidates.filter((_,i)=>(mask&(1<<i))!==0),selected=new Set(chain.map(u=>u.id));
  if(chain.some(u=>u.prerequisites.some(id=>!selected.has(id)&&!completed.has(id))))continue;
  const depth=(u:FiniteUnit,seen:string[]):number=>{
   if(seen.includes(u.id))throw Error('M2_MODULE_DEPENDENCY_CYCLE');
   return 1+Math.max(0,...u.prerequisites.filter(id=>selected.has(id)).map(id=>depth(chain.find(v=>v.id===id)!,[...seen,u.id])));
  };
  // Current invocation is sunk. Include the minimum future controller calls
  // through the final check/stop; do not hide them as free computation.
  const controllerCalls=Math.max(0,...chain.map(u=>depth(u,[])));
  if(chain.length+controllerCalls>input.remainingAttempts)continue;
  const verifies=chain.some(u=>u.kind==='VERIFY_P1');
  const inspected=!input.sourceObligation||chain.some(u=>u.kind==='INSPECT_SOURCE')||input.units.some(u=>u.kind==='INSPECT_SOURCE'&&u.status==='COMPLETED');
  // Equivalent representations satisfy one acceptance and one premise. A
  // complementary chain receives that gain once, never one gain per opinion.
  const gain=input.sourcePremiseChanged||input.lossGap===null?null:input.incumbentQualified?0:verifies&&inspected?input.lossGap:0;
  const cost=input.nativeAttemptCost===null?null:(chain.length+controllerCalls)*input.nativeAttemptCost;
  const mechanism=chain.length===2&&verifies&&chain.some(u=>u.kind==='EXECUTE_P1')?'EXECUTE_CHECK_CHAIN':
   chain.length===1&&chain[0]!.kind==='EXECUTE_P1'?'UNVERIFIED_EXECUTION':null;
  const fit=mechanism&&!input.sourcePremiseChanged?input.valueModel?.bins.find(b=>b.mechanism===mechanism&&b.qualifiedPublicDiagnostic&&b.beforeLoss===input.lossGap):undefined;
  // Mean before-minus-after loss includes failure/non-completion. Multiplying
  // it by completion or acceptance would count those failures twice.
  const expectedGain=input.incumbentQualified?0:fit?.predictedGain??null;
  const duration=fit?.meanElapsedMs??(chain.some(u=>u.durationMs===null)?null:chain.reduce((n,u)=>n+u.durationMs!,0));
  const delay=input.delayMsCost===0?0:input.delayMsCost===null||duration===null?null:duration*input.delayMsCost;
  // Mean duration is a diagnostic estimate, never a worst-case deadline proof.
  // Nonnegative delay has a zero lower bound for the finite net upper bound.
  const netUpper=gain===null||cost===null||input.delayMsCost===null?null:gain-cost;
  const expectedNet=expectedGain===null||cost===null||delay===null?null:expectedGain-cost-delay;
  const radius=fit?.intervals.find(i=>i.level===.9)?.radius;
  const gainInterval=expectedGain===null||radius===null||radius===undefined||input.lossGap===null?null:
   {lower:Math.max(0,expectedGain-radius),upper:Math.min(input.lossGap,expectedGain+radius),nominalCoverage:.9 as const,kind:'EMPIRICAL_PUBLIC_RESIDUAL_DIAGNOSTIC' as const};
  chains.push({unitIds:chain.map(u=>u.id).sort(),conditionalGain:gain,incrementalCost:cost,delayLoss:delay,netUpper,
   completionProbability:fit?.completionProbability??null,acceptanceProbability:fit?.acceptanceProbability??null,
   expectedGain,expectedNet,gainInterval,futureControllerCalls:controllerCalls,predictedCompletionDelayMs:duration,
   costSupport:'KNOWN_NATIVE_MINIMUM_FORWARD_CONTROLLER_TIME_AND_BILLING_UNKNOWN',support:fit?'PUBLIC_MODEL_RELATIVE_DIAGNOSTIC':'UNAVAILABLE'});
 }
 const ready=input.units.filter(u=>u.status==='PENDING'&&u.prerequisites.every(id=>completed.has(id)));
 const rank=(u:FiniteUnit)=>u.kind==='VERIFY_P1'?0:u.kind==='INSPECT_SOURCE'?1:u.kind==='MODEL_REFINE'?2:3;
 ready.sort((a,b)=>rank(a)-rank(b)||a.steps-b.steps||a.id.localeCompare(b.id));
 const order=(a:Chain,b:Chain)=>a.unitIds.length-b.unitIds.length||a.unitIds.join().localeCompare(b.unitIds.join());
 const diagnostic=chains.filter(c=>c.support==='PUBLIC_MODEL_RELATIVE_DIAGNOSTIC'&&c.expectedNet!==null).sort((a,b)=>b.expectedNet!-a.expectedNet!||order(a,b));
 const upper=chains.filter(c=>c.netUpper!==null).sort((a,b)=>b.netUpper!-a.netUpper!||order(a,b));
 const best=diagnostic[0]?.expectedNet!>0?diagnostic[0]:upper[0]?.netUpper!>0?upper[0]:null;
 let ordered=ready;
 if(input.strategy==='ADAPTIVE'&&best){const selected=new Set(best.unitIds);ordered=[...ready.filter(u=>selected.has(u.id)),...ready.filter(u=>!selected.has(u.id))];}
 const equivalent=ordered.every(u=>['EXECUTE_P1','VERIFY_P1'].includes(u.kind));
 const parallel=input.strategy==='FIXED_SEQUENTIAL'?1:input.strategy==='FIXED_WIDE'?input.maxParallel:equivalent?1:input.maxParallel;
 const unresolvedSource=input.sourceObligation&&!input.units.some(u=>u.kind==='INSPECT_SOURCE'&&u.status==='COMPLETED');
 const knownUpper=!input.sourcePremiseChanged&&!unresolvedSource&&chains.length>0&&chains.every(c=>c.netUpper!==null)?Math.max(0,...chains.map(c=>c.netUpper!)):null;
 const finiteBound=input.incumbentQualified&&!input.sourcePremiseChanged?0:knownUpper;
 const exhausted=input.remainingAttempts===0||input.remainingMs<=0;
 const valueStop=input.strategy==='ADAPTIVE'&&finiteBound===0;
 const stop=!input.sourcePremiseChanged&&!input.active&&!input.unknownAttempt&&(exhausted||valueStop||input.strategy==='ADAPTIVE'&&input.incumbentQualified||!ready.length&&!candidates.length);
 const reason=input.unknownAttempt?'UNKNOWN_PHYSICAL_ATTEMPT_REQUIRES_RECONCILIATION':exhausted?'ORIGINAL_BUDGET_OR_DEADLINE_EXHAUSTED':
  stop?finiteBound===0?'FINITE_ACCEPTED_OUTPUT_BOUND_ZERO':input.incumbentQualified?'CHECKED_INCUMBENT_REMAINING_VALUE_UNKNOWN':'NO_INDEPENDENTLY_CHECKED_P1_INCUMBENT':null;
 return {schema:'finnor.m2.module-proposal.v1',selectedUnitIds:stop||input.sourcePremiseChanged?[]:ordered.slice(0,Math.max(0,Math.min(parallel-input.active,input.remainingAttempts))).map(u=>u.id),
  chains,visited,parallel,stop,reason:input.sourcePremiseChanged?'M2_MATERIAL_SOURCE_PREMISE_REQUIRES_S4_RECOMPUTATION':reason,ownerWait:input.sourcePremiseChanged,heuristic:finiteBound===null,boundUpper:finiteBound,
  selection:diagnostic.length?'PUBLIC_DIAGNOSTIC_EVENTUAL_LOSS_SELECTION':input.lossGap===null?'CHECK_BOTTLENECK_DISTINCT_MECHANISM_HEURISTIC':'EXHAUSTIVE_FINITE_CONDITIONAL_CHAIN_UPPER_BOUND',
  completionAndAcceptanceAreSeparate:true,opinionCountIsInformation:false,businessSelectionOwner:'S4'};
}
