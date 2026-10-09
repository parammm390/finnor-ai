import type {ExactInformationModel,ExactInformationState,ExactControlAction} from '@finnor/shared-types';
import {ControlFraction as Q,CQ_ZERO,CQ_ONE,controlCanonical as canonical,ExactControlError,R1_LIMITS,controlMeter,type ExactControlBudget} from './exact';
import {readOriginalExactJson} from './source-json';
function fail(predicate:string):never{throw new ExactControlError('UNSUPPORTED',predicate);}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const unique=(v:unknown[],p:string)=>{if(new Set(v).size!==v.length)fail(p);};
const nonnegative=(v:unknown,p:string)=>{if(Q.read(v).compare(CQ_ZERO)<0)fail(p);};
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function originalInformationKey(s:ExactInformationState){return canonical({period:s.period,history:s.history,observations:s.observations});}
export function enabledExactActions(model:ExactInformationModel,s:ExactInformationState):ExactControlAction[]{
 if(s.period===model.horizon.periods)return [];
 return model.actions.filter(a=>(!s.semantics.stopped||a.kind==='STOP')&&s.period>=a.earliestPeriod&&s.period<=a.lastPeriod&&(!a.atMostOnce||!s.history.includes(a.id))&&a.precondition.afterActionIds.every(id=>s.history.includes(id))&&a.precondition.observations.every(g=>s.observations.some(o=>o.instrumentId===g.instrumentId&&g.tokens.includes(o.token))));
}
export function exactStateLabel(model:ExactInformationModel,s:ExactInformationState):unknown{
 const relevant=new Set(model.actions.flatMap(a=>[...(a.atMostOnce?[a.id]:[]),...a.precondition.afterActionIds]));
 return {period:s.period,observations:s.observations,worlds:s.worlds,semantics:s.semantics,
  sufficientHistory:model.actions.filter(a=>relevant.has(a.id)).map(a=>({actionId:a.id,occurred:s.history.includes(a.id)})),
  enabled:enabledExactActions(model,s).map(a=>a.id)};
}
/** Validate the supplied original model, before partitioning. No truncation or
 * conversion from learned coefficients/printed floating-point values is made. */
export function parseExactInformationModel(bytes:string,budget:ExactControlBudget):ExactInformationModel {
 const meter=controlMeter(budget);meter.step();
 if(typeof bytes!=='string'||Buffer.byteLength(bytes)>R1_LIMITS.inputBytes)fail('ORIGINAL_MODEL_BYTE_BOUND');
 const m=readOriginalExactJson(bytes,budget) as ExactInformationModel;
 if(!object(m)||m.schema!=='finnor.s3.exact-information-model.v1'||m.profile!=='finite-information-rational-v1'||!object(m.encoding)||m.encoding.kind!=='EXACT_RATIONAL_SOURCE'||m.encoding.originalNumericModelRef!==null)fail('EXACT_SOURCE_PROFILE_REQUIRED');
 if(!object(m.horizon)||!Number.isSafeInteger(m.horizon.periods)||m.horizon.periods<1||m.horizon.periods>12||!Number.isSafeInteger(m.horizon.periodMs)||m.horizon.periodMs<1||!Number.isFinite(Date.parse(m.horizon.startAt)))fail('EXACT_ORIGINAL_HORIZON');
 for(const field of ['id','tenantId','principalId','rightsRef'])if(typeof (m as any)[field]!=='string'||!(m as any)[field].length||(m as any)[field].length>256)fail('EXACT_OWNER_IDENTITY');
 const ref=(v:unknown)=>object(v)&&['owner','id','version'].every(k=>typeof v[k]==='string'&&v[k].length>0&&v[k].length<=256)&&typeof v.contentDigest==='string'&&/^[a-f0-9]{64}$/.test(v.contentDigest);
 const names=(v:unknown,n=128):v is string[]=>Array.isArray(v)&&v.length<=n&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=256);
 if(!object(m.root)||!ref(m.mandateRef)||!Array.isArray(m.sourceRefs)||!m.sourceRefs.length||m.sourceRefs.length>128||m.sourceRefs.some(r=>!ref(r))||!Array.isArray(m.assumptions)||!m.assumptions.length||m.assumptions.length>64||m.assumptions.some(a=>typeof a!=='string'||!a.length||a.length>2048))fail('EXACT_OWNER_BINDINGS');
 if(!Array.isArray(m.states)||!m.states.length||m.states.length>128||!Array.isArray(m.actions)||!m.actions.length||m.actions.length>8||!Array.isArray(m.roots)||!m.roots.length)fail('FINITE_MODEL_CARDINALITY');
 if(!object(m.uncertainty)||!['FIXED_COMPLETE_WORLDS','EXACT_PROBABILITY_LAW'].includes(m.uncertainty.kind)||!Array.isArray(m.uncertainty.worlds)||!m.uncertainty.worlds.length||m.uncertainty.worlds.length>512)fail('COMPLETE_WORLD_SUPPORT_REQUIRED');
 unique(m.uncertainty.worlds,'DUPLICATE_WORLD');unique(m.actions.map(a=>a.id),'DUPLICATE_ACTION');unique(m.states.map(s=>s.id),'DUPLICATE_STATE');unique(m.roots,'DUPLICATE_ROOT');
 if(!object(m.units)||!object(m.units.resources)||!Object.keys(m.units.resources).length||Object.keys(m.units.resources).length>8||typeof m.units.utility!=='string')fail('EXACT_UNITS_REQUIRED');
 const money=m.units.money;if(!object(money)||!ref(money.discountConventionRef))fail('EXACT_OWNER_BINDINGS');
 if(typeof money.currency!=='string'||!/^[A-Z]{3}$/.test(money.currency)||money.unit!==m.units.utility||!Number.isFinite(Date.parse(money.valuationAt))||money.timeBasis!=='DECLARED_FINITE_PERIODS'||money.qualification!=='SUPPLIED_OWNER_ASSERTION_UNADMITTED'||Q.read(money.ownerShare).compare(CQ_ZERO)<0||Q.read(money.ownerShare).compare(CQ_ONE)>0)fail('COMPLETE_EXACT_MONEY_CONTEXT_REQUIRED');
 const dimensions=Object.keys(m.units.resources).sort(),h=m.horizon.periods,vector=(v:unknown,p:string)=>{if(!object(v)||Object.keys(v).sort().join('|')!==dimensions.join('|'))fail(p);for(const x of Object.values(v))Q.read(x);};
 if(!object(m.economics)||!Array.isArray(m.economics.discountFactors)||m.economics.discountFactors.length!==h+1)fail('EXACT_ACCOUNTING_CONVENTION');
 Q.read(m.economics.minimumUtility);nonnegative(m.economics.terminalLiability,'NEGATIVE_TAIL');if(Q.read(m.economics.normalization).compare(CQ_ZERO)<=0)fail('EXACT_NORMALIZATION');
 for(const q of m.economics.discountFactors)nonnegative(q,'NEGATIVE_DISCOUNT');
 if(m.uncertainty.kind==='FIXED_COMPLETE_WORLDS'){if(m.uncertainty.lawRef!==null||m.uncertainty.qualificationRef!==null||Object.keys(m.uncertainty.worldWeights).length)fail('FIXED_WORLD_PROBABILITY_RELABEL');}
 else {if(!ref(m.uncertainty.lawRef)||m.uncertainty.qualificationRef!==null&&!ref(m.uncertainty.qualificationRef)||Object.keys(m.uncertainty.worldWeights).sort().join('|')!==[...m.uncertainty.worlds].sort().join('|'))fail('PROBABILITY_LAW_IDENTITY');
  let sum=CQ_ZERO;for(const q of Object.values(m.uncertainty.worldWeights)){nonnegative(q,'NEGATIVE_PROBABILITY');sum=sum.add(Q.read(q));}if(sum.compare(CQ_ONE)!==0)fail('PROBABILITY_ROOT_MASS');}
 if(!Array.isArray(m.observationInstruments)||m.observationInstruments.length>8)fail('OBSERVATION_DOMAIN');unique(m.observationInstruments.map(i=>i.id),'DUPLICATE_INSTRUMENT');
 for(const i of m.observationInstruments){if(!object(i)||typeof i.id!=='string'||!i.id.length||i.id.length>256||i.rightsRef!==m.rightsRef||!Number.isSafeInteger(i.delayPeriods)||i.delayPeriods<1||i.delayPeriods>h||!names(i.tokens)||!i.tokens.length||!names(i.afterActionIds,8)||i.afterActionIds.some(id=>!m.actions.some(a=>a.id===id))||!ref(i.sourceRef))fail('INSTRUMENT_RIGHTS_OR_DELAY');unique(i.tokens,'DUPLICATE_OBSERVATION_TOKEN');
  if(i.measurement){const x=i.measurement;if(x.schema!=='finnor.s2.exact-recorded-coarsening.v1'||!object(x.root)||typeof x.seriesId!=='string'||typeof x.unit!=='string'||!Array.isArray(x.bins)||!x.bins.length||x.bins.length>128||x.bins.some(b=>!i.tokens.includes(b.token)||Q.read(b.lowerInclusive).compare(Q.read(b.upperExclusive))>=0))fail('EXACT_MEASUREMENT_COARSENING');unique(x.bins.map(b=>b.token),'DUPLICATE_MEASUREMENT_BIN');for(let j=1;j<x.bins.length;j++)if(Q.read(x.bins[j-1]!.upperExclusive).compare(Q.read(x.bins[j]!.lowerInclusive))>0)fail('OVERLAPPING_MEASUREMENT_BIN');}}
 for(const a of m.actions){meter.step();if(!object(a)||typeof a.id!=='string'||!a.id.length||a.id.length>128||!['INQUIRE','INTERVENE','WAIT','STOP'].includes(a.kind)||typeof a.atMostOnce!=='boolean'||!Number.isSafeInteger(a.earliestPeriod)||!Number.isSafeInteger(a.lastPeriod)||a.earliestPeriod<0||a.lastPeriod<a.earliestPeriod||a.lastPeriod>=h||!object(a.precondition)||!Array.isArray(a.precondition.afterActionIds)||!Array.isArray(a.precondition.observations)||a.costUnit!==m.units.utility||!Number.isSafeInteger(a.occupationPeriods)||a.occupationPeriods<0||a.occupationPeriods>h+1)fail('EXACT_ACTION_CONTRACT');
  vector(a.resources,'ACTION_RESOURCE_UNITS');vector(a.occupancy,'ACTION_OCCUPANCY_UNITS');for(const x of [...Object.values(a.resources),...Object.values(a.occupancy),a.cost,a.tailLiability,a.humanSeconds])nonnegative(x,'NEGATIVE_ACTION_DEMAND');
  if(!object(a.exposures))fail('EXPOSURE_CONTRACT');for(const schedule of Object.values(a.exposures)){if(!Array.isArray(schedule)||schedule.length>h)fail('EXPOSURE_HORIZON');for(const q of schedule)Q.read(q);}
  if(!names(a.precondition.afterActionIds,8)||a.precondition.afterActionIds.some(id=>!m.actions.some(x=>x.id===id))||a.precondition.observations.length>8||a.precondition.observations.some(g=>!names(g.tokens)||!g.tokens.length||!m.observationInstruments.some(i=>i.id===g.instrumentId&&g.tokens.every(t=>i.tokens.includes(t)))))fail('ACTION_GUARD_SOURCE');
  if(a.protocolRef!==null&&!ref(a.protocolRef))fail('ACTION_PROTOCOL_BINDING');
  if(a.kind==='INQUIRE'&&(!a.protocolRef||!m.observationInstruments.some(i=>i.id===a.protocolRef!.id&&i.delayPeriods===a.informationDelayPeriods&&i.afterActionIds.includes(a.id))))fail('INQUIRY_INSTRUMENT_REQUIRED');
 }
 const states=new Map(m.states.map(s=>[s.id,s])),keys=new Set<string>();
 const semanticFields=['rights','pendingObservations','maturity','optionConditions','exposureSchedules','exposureLocks','resources','liquidity','covenants','humanUsed','humanLimit','computeUsed','computeLimit','staffing','compensation','employeeBenefits','obligations','accruedUtility','terminalLiabilities','terminalUtility','stopped'];
 for(const s of m.states){meter.step();if(!object(s)||typeof s.id!=='string'||!s.id.length||s.id.length>256||!Number.isSafeInteger(s.period)||s.period<0||s.period>h||!Array.isArray(s.history)||s.history.length!==s.period||s.history.some(id=>!m.actions.some(a=>a.id===id))||!Array.isArray(s.observations)||!Array.isArray(s.worlds)||!s.worlds.length||!object(s.semantics)||semanticFields.some(k=>!Object.hasOwn(s.semantics,k)))fail('COMPLETE_INFORMATION_STATE_REQUIRED');
  unique(s.worlds,'DUPLICATE_STATE_WORLD');if(s.worlds.some(w=>!m.uncertainty.worlds.includes(w)))fail('UNDECLARED_WORLD');
  const key=originalInformationKey(s);if(keys.has(key))fail('NON_MARKOV_CONTROLLER_INFORMATION');keys.add(key);
  const c=s.semantics;if(!object(c.rights)||c.rights.rightsRef!==m.rightsRef||!Number.isSafeInteger(c.rights.revision)||c.rights.revision<0||!Array.isArray(c.rights.availableInstruments)||!Array.isArray(c.pendingObservations)||typeof c.stopped!=='boolean')fail('STATE_RIGHTS_AND_PENDING_INFORMATION');
  for(const o of s.observations){const i=m.observationInstruments.find(i=>i.id===o.instrumentId);if(!i||!i.tokens.includes(o.token)||!c.rights.availableInstruments.includes(i.id)||!Number.isSafeInteger(o.availablePeriod)||o.availablePeriod>s.period||o.availablePeriod<i.delayPeriods||!i.afterActionIds.includes(s.history[o.availablePeriod-i.delayPeriods]!))fail('OBSERVATION_AVAILABILITY_OR_RIGHTS');}
  unique(s.observations.map(o=>o.instrumentId+':'+o.availablePeriod),'DUPLICATE_AVAILABLE_OBSERVATION');
  for(const pending of c.pendingObservations){const i=m.observationInstruments.find(i=>i.id===pending.instrumentId);if(!i||pending.availablePeriod<=s.period||pending.availablePeriod>h||!pending.tokens.length||pending.tokens.some(t=>!i.tokens.includes(t))||!equal(pending.sourceRef,i.sourceRef)||pending.availablePeriod-i.delayPeriods<0||pending.availablePeriod-i.delayPeriods>=s.period||!i.afterActionIds.includes(s.history[pending.availablePeriod-i.delayPeriods]!))fail('PENDING_OBSERVATION_SOURCE_OR_DELAY');}
  if(!object(c.resources)||!object(c.resources.worldUse)||!object(c.resources.occupancy)||!Array.isArray(c.resources.couplings)||c.resources.couplings.length>32||!Array.isArray(c.obligations)||c.obligations.length>256)fail('COMPLETE_RESOURCE_OBLIGATION_STATE');
  for(const row of c.resources.couplings){if(!object(row)||typeof row.id!=='string'||!object(row.weights)||!Object.keys(row.weights).length||Object.keys(row.weights).some(d=>!dimensions.includes(d)))fail('COUPLED_RESOURCE_DIMENSIONS');nonnegative(row.maximum,'NEGATIVE_COUPLED_CAPACITY');for(const q of Object.values(row.weights))nonnegative(q,'NEGATIVE_COUPLED_WEIGHT');}
  if(!object(c.exposureSchedules)||Object.values(c.exposureSchedules).some(a=>!Array.isArray(a)||a.length!==h+1)||!names(c.exposureLocks))fail('EXACT_EXPOSURE_SCHEDULE');
  for(const v of [c.resources.capacity,c.resources.totalLimit,c.resources.used,c.resources.reserved]){vector(v,'STATE_RESOURCE_DIMENSIONS');for(const q of Object.values(v))nonnegative(q,'NEGATIVE_STATE_RESOURCE');}
  for(const name of ['maturity','optionConditions','exposureLocks','liquidity','covenants','staffing','compensation','employeeBenefits','obligations'] as const)if(!Array.isArray(c[name]))fail('COMPLETE_SEMANTIC_COLLECTION');
  for(const q of [c.humanUsed,c.humanLimit,c.computeUsed,c.computeLimit])nonnegative(q,'NEGATIVE_ATTENTION_OR_COMPUTE');
  for(const o of c.obligations)if(!object(o)||!ref(o.ref)||!ref(o.effectRef)||!['KNOWN_PENDING','UNKNOWN','PARTIAL','SETTLED'].includes(o.status))fail('S6_OBLIGATION_IDENTITY');
  for(const v of [c.accruedUtility,c.terminalLiabilities,c.terminalUtility,c.resources.worldUse])if(!object(v)||Object.keys(v).sort().join('|')!==[...s.worlds].sort().join('|'))fail('COMPLETE_PER_WORLD_LABEL');
  for(const world of s.worlds){Q.read(c.accruedUtility[world]);Q.read(c.terminalUtility[world]);if(c.terminalLiabilities[world]!==null)Q.read(c.terminalLiabilities[world]);const u=c.resources.worldUse[world]!;vector(u.used,'WORLD_RESOURCE_DIMENSIONS');Q.read(u.humanUsed);Q.read(u.computeUsed);for(const d of dimensions){if(!Array.isArray(u.occupancy[d]!)||u.occupancy[d]!.length!==h+1||!Array.isArray(c.resources.occupancy[d]!)||c.resources.occupancy[d]!.length!==h+1)fail('FULL_RESOURCE_OCCUPANCY_HORIZON');for(const q of [...u.occupancy[d]!,...c.resources.occupancy[d]!])nonnegative(q,'NEGATIVE_OCCUPANCY');}}
  if(!Array.isArray(s.transitions)||s.transitions.length>8||!equal(s.transitions.map(t=>t.actionId),enabledExactActions(m,s).map(a=>a.id)))fail('COMPLETE_ADMISSIBLE_ACTION_CATALOGUE');
  // Traverses every semantic rational, including constraints not selected by a
  // particular policy. Numeric integers are metadata; economic fields use Q.
  canonical(c);
 }
 for(const root of m.roots)if(!states.has(root))fail('ROOT_MAPPING');
 for(const s of m.states)for(const t of s.transitions){meter.step();const a=m.actions.find(a=>a.id===t.actionId)!;
  if(!Array.isArray(t.outcomes)||!t.outcomes.length||t.outcomes.length>m.uncertainty.worlds.length*128)fail('COMPLETE_TRANSITION_SUPPORT');
  const mass=new Map(s.worlds.map(w=>[w,CQ_ZERO])),children=new Map<string,Set<string>>();
  for(const o of t.outcomes){meter.step();const child=states.get(o.successor);if(!child||child.period!==s.period+1||!s.worlds.includes(o.worldId)||!child.worlds.includes(o.worldId)||!equal(child.history,[...s.history,a.id]))fail('WORLD_IDENTITY_TEMPORAL_OR_HISTORY_CLOSURE');
   nonnegative(o.mass,'NEGATIVE_TRANSITION_MASS');mass.set(o.worldId,mass.get(o.worldId)!.add(Q.read(o.mass)));
   if(m.uncertainty.kind==='FIXED_COMPLETE_WORLDS'&&Q.read(o.mass).compare(CQ_ONE)!==0)fail('FIXED_WORLD_TRANSITION_MASS');
   const set=children.get(child.id)??new Set<string>();set.add(o.worldId);children.set(child.id,set);
   vector(o.resourceDelta,'TRANSITION_RESOURCE_UNITS');if(!equal(o.resourceDelta,a.resources)||!equal(o.humanDelta,a.humanSeconds)||!equal(o.obligations,child.semantics.obligations)||!equal(s.semantics.obligations,child.semantics.obligations))fail('ORIGINAL_ACTION_RESOURCE_OR_S6_OBLIGATION');
   if(Q.read(o.immediateUtility).compare(Q.read(o.grossUtility).sub(Q.read(a.cost)).mul(Q.read(m.economics.discountFactors[s.period])))!==0)fail('IMMEDIATE_ACCOUNTING_CONVENTION');
   let value=Q.read(s.semantics.accruedUtility[o.worldId]).add(Q.read(o.immediateUtility));
   if(child.period===h&&child.semantics.terminalLiabilities[o.worldId]!==null)value=value.add(Q.read(child.semantics.terminalUtility[o.worldId]).sub(Q.read(child.semantics.terminalLiabilities[o.worldId])).mul(Q.read(m.economics.discountFactors[h])));
   if(child.semantics.terminalLiabilities[o.worldId]!==null&&value.compare(Q.read(child.semantics.accruedUtility[o.worldId]))!==0)fail('COMPLETE_WORLD_ACCRUED_VALUE');
   const before=s.semantics.resources.worldUse[o.worldId]!,after=child.semantics.resources.worldUse[o.worldId]!;
   for(const d of dimensions){if(Q.read(before.used[d]).add(Q.read(o.resourceDelta[d])).compare(Q.read(after.used[d]))!==0)fail('WORLD_RESOURCE_PROPAGATION');
    if(!Array.isArray(o.occupancyDelta[d]!)||o.occupancyDelta[d]!.length!==h+1)fail('TRANSITION_OCCUPANCY_HORIZON');
    for(let period=0;period<=h;period++){const increment=period>=s.period&&period<s.period+a.occupationPeriods?Q.read(a.occupancy[d]):CQ_ZERO;
     if(increment.compare(Q.read(o.occupancyDelta[d]![period]))!==0||Q.read(before.occupancy[d]![period]).add(increment).compare(Q.read(after.occupancy[d]![period]))!==0)fail('EXACT_OCCUPANCY_PROPAGATION');}}
   if(Q.read(before.humanUsed).add(Q.read(a.humanSeconds)).compare(Q.read(after.humanUsed))!==0||Q.read(before.computeUsed).compare(Q.read(after.computeUsed))!==0)fail('HUMAN_OR_COMPUTE_PROPAGATION');
   const debt=s.semantics.terminalLiabilities[o.worldId],next=child.semantics.terminalLiabilities[o.worldId];
   if((debt===null)!==(next===null)||debt!==null&&Q.read(debt).add(Q.read(a.tailLiability)).compare(Q.read(next))!==0)fail('RETAINED_TERMINAL_LIABILITY');
   if(child.semantics.stopped!==(s.semantics.stopped||a.kind==='STOP'))fail('STOP_LIFECYCLE');
   for(const observed of s.observations)if(!child.observations.some(x=>equal(x,observed)))fail('OBSERVATION_HISTORY_DROPPED');
   for(const observed of child.observations.filter(x=>!s.observations.some(y=>equal(x,y)))){const instrument=m.observationInstruments.find(i=>i.id===observed.instrumentId)!;
    const pending=s.semantics.pendingObservations.some(p=>p.instrumentId===observed.instrumentId&&p.availablePeriod===child.period&&p.tokens.includes(observed.token));
    if(!pending&&!(instrument.afterActionIds.includes(a.id)&&instrument.delayPeriods===1&&observed.availablePeriod===child.period))fail('UNAUTHORIZED_NEW_OBSERVATION');}
   for(const pending of s.semantics.pendingObservations){if(pending.availablePeriod>child.period&&!child.semantics.pendingObservations.some(p=>equal(p,pending)))fail('PENDING_OBSERVATION_DROPPED');if(pending.availablePeriod===child.period&&!child.observations.some(o=>o.instrumentId===pending.instrumentId&&o.availablePeriod===child.period&&pending.tokens.includes(o.token)))fail('PENDING_OBSERVATION_DELIVERY');}
  }
  if([...mass.values()].some(v=>v.compare(CQ_ONE)!==0))fail('COMPLETE_TRANSITION_MASS');
  for(const [child,worlds]of children)if([...worlds].sort().join('|')!==[...states.get(child)!.worlds].sort().join('|'))fail('SUCCESSOR_INFORMATION_WORLD_SUPPORT');
 }
 return m;
}
export function stateFeasible(m:ExactInformationModel,s:ExactInformationState):boolean{
 const c=s.semantics;if(c.obligations.some(o=>o.status==='UNKNOWN'||o.status==='PARTIAL')||Object.values(c.terminalLiabilities).some(q=>q===null))return false;
 // Opaque constraints cannot become feasibility through a trusted boolean.
 for(const name of ['optionConditions','liquidity','covenants','staffing','compensation','employeeBenefits'] as const)for(const row of c[name]){
  if(!object(row)||row.schema!=='finnor.exact-state-constraint.v1'||typeof row.id!=='string'||!['LE','GE','EQ'].includes(row.relation)||!object(row.left)||!object(row.right))throw new ExactControlError('UNSUPPORTED','UNIMPLEMENTED_EXACT_'+name.toUpperCase()+'_CONSTRAINT');
  const cmp=Q.read(row.left).compare(Q.read(row.right));if(row.relation==='LE'?cmp>0:row.relation==='GE'?cmp<0:cmp!==0)return false;
 }
 if(Q.read(c.humanUsed).compare(Q.read(c.humanLimit))>0||Q.read(c.computeUsed).compare(Q.read(c.computeLimit))>0)return false;
 // Controller summaries and per-world counters describe inclusive totals;
 // both are checked. They are not independent additive resource ledgers.
 for(const d of Object.keys(m.units.resources)){if(Q.read(c.resources.used[d]).add(Q.read(c.resources.reserved[d])).compare(Q.read(c.resources.totalLimit[d]))>0)return false;for(const v of c.resources.occupancy[d]!)if(Q.read(v).compare(Q.read(c.resources.capacity[d]))>0)return false;}
 for(const world of s.worlds){const u=c.resources.worldUse[world]!;if(Q.read(u.humanUsed).compare(Q.read(c.humanLimit))>0||Q.read(u.computeUsed).compare(Q.read(c.computeLimit))>0)return false;
  for(const d of Object.keys(m.units.resources)){if(Q.read(u.used[d]).add(Q.read(c.resources.reserved[d])).compare(Q.read(c.resources.totalLimit[d]))>0)return false;for(const v of u.occupancy[d]!)if(Q.read(v).compare(Q.read(c.resources.capacity[d]))>0)return false;}
  for(const coupling of c.resources.couplings)for(let t=0;t<=m.horizon.periods;t++){let use=CQ_ZERO;for(const [d,weight]of Object.entries(coupling.weights))use=use.add(Q.read(u.occupancy[d]![t]).mul(Q.read(weight)));if(use.compare(Q.read(coupling.maximum))>0)return false;}
 }
 return true;
}
