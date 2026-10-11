import type {ControlObservation} from '@finnor/shared-types';
import type {ExactWorld,R2OriginalProblem,R2Action,R2Variant,R2Course,R2Decision,R2Encoding,RationalRow,R2Request,RationalMILP} from '@finnor/shared-types/src/robust-programme-search';
import {R2_VERSION} from '@finnor/shared-types/src/robust-programme-search';
import {canonicalJson,epistemicHash} from './source-precedence';
import {r2Quantity as q,r2String as s,r2Zero as zero,r2Sum as sum,r2Divide} from './r2-rational';
import type {ExperimentRational as Q} from './experiment-numerics';

const need=(ok:unknown,reason:string):void=>{if(!ok)throw Error(reason);};
type CourseState={history:ExactWorld['initialHistory'];actions:string[];observations:ControlObservation[];pending:ControlObservation[];
  schedule:Record<string,Q[]>;locks:Record<string,number>;utility:Q;liability:Q;stopped:boolean;spent:Record<string,Q>;
  occupancy:Record<string,Q[]>;human:Q;native:Record<string,Q[]>;decisions:R2Decision[];constraints:R2Course['constraints']};
const zeros=(n:number)=>Array.from({length:n},zero);

/** Full native P1/M3 constructor family. Search counters are not constructor bounds. */
export function lowerR2Grammar(o:R2OriginalProblem):R2Variant[]{
  const n=(path:string)=>s(q(o.source.quantities[path]!)),perm=o.permitted;
  need(perm.agreement==='UNILATERAL_PROPOSAL','R2_ACCEPTANCE_PRIMITIVE_UNAVAILABLE');
  need(o.resourceScopeRoots.length>0,'R2_CANONICAL_RESOURCE_SCOPE_ABSENT');
  const base:R2Action[]=o.problem.actions.map((a,i)=>({...structuredClone(a),cost:n(`/problem/actions/${i}/cost`),
    tailLiability:n(`/problem/actions/${i}/tailLiability`),humanSeconds:n(`/problem/actions/${i}/humanSeconds`),
    resources:Object.fromEntries(Object.keys(a.resources).map(id=>[id,n(`/problem/actions/${i}/resources/${id}`)])),
    occupancy:Object.fromEntries(Object.keys(a.occupancy).map(id=>[id,n(`/problem/actions/${i}/occupancy/${id}`)])),
    exposures:Object.fromEntries(Object.entries(a.exposures).map(([id,values])=>[id,values.map((_,j)=>n(`/problem/actions/${i}/exposures/${id}/${j}`))]))}));
  const original=base.find(a=>a.id===perm.actionId);
  need(original?.kind==='INTERVENE'&&original.exposures[perm.exposureId],'R2_ORIGINAL_TERM_BINDING');
  const variants:R2Variant[]=[],seen=new Set<string>();
  const add=(actions:R2Action[],structure:string,term:string|null=null,start:number|null=null,fraction:string|null=null)=>{
    need(actions.length>0&&actions.length<=8&&new Set(actions.map(a=>a.id)).size===actions.length,'R2_COMPOSED_ACTION_BOUND');
    const key=canonicalJson(actions);if(seen.has(key))return;seen.add(key);
    variants.push({id:`g${variants.length}`,structure,term,start,fraction,actions});
  };
  add(base,'INCUMBENT');
  for(const structure of perm.structures)for(const start of perm.startPeriods)for(const term of perm.terms)
    for(const fraction of ['STAGED','OBSERVABLE_STAGE'].includes(structure)?perm.stageFractions:[null]){
      if(structure==='WAIT_STOP'){add(base.filter(a=>['WAIT','STOP'].includes(a.kind)),structure,term,start,fraction);continue;}
      const actions=structuredClone(base),target=actions.find(a=>a.id===perm.actionId)!;
      need(Object.values(target.exposures).every(v=>v.length===1),'R2_ORIGINAL_MULTI_PERIOD_TERM_UNSUPPORTED');
      const before=q(target.exposures[perm.exposureId]![0]!);need(before.n!==0n&&start<o.mandate.horizon.periods,'R2_TERM_PERIOD_OR_SCALE');
      const ratio=r2Divide(q(term),before);need(ratio.n>=0n,'R2_TERM_SCALE_SIGN');
      target.earliestPeriod=start;target.lastPeriod=start;target.exposures[perm.exposureId]=[s(q(term))];
      for(const key of ['resources','occupancy'] as const)target[key]=Object.fromEntries(Object.entries(target[key]).map(([id,v])=>[id,s(q(v).mul(ratio))]));
      for(const key of ['cost','tailLiability'] as const)target[key]=s(q(target[key]).mul(ratio));
      if(structure==='STAGED'){
        const f=q(fraction!);need(f.n>0n&&f.compare(q('1'))<0&&start+2<=o.mandate.horizon.periods,'R2_STAGE_HORIZON');
        target.exposures=Object.fromEntries(Object.entries(target.exposures).map(([id,v])=>[id,[s(q(v[0]!).mul(f)),s(q(v[0]!).mul(q('1').sub(f)))]]));
      }else if(structure==='OBSERVABLE_STAGE'){
        const milestone=perm.milestone,instrument=o.problem.observations.find(i=>i.id===milestone?.instrumentId);
        need(instrument&&milestone&&instrument.afterActionIds.includes(target.id)&&start+instrument.delayPeriods<o.mandate.horizon.periods&&
          milestone.tokens.every(token=>instrument.bins.some(b=>b.category===token)),'R2_LAWFUL_OBSERVABLE_STAGE');
        const release=structuredClone(target),f=q(fraction!),rest=q('1').sub(f);
        release.id=`r2-release-${start}-${term.replaceAll('/','_')}-${fraction!.replaceAll('/','_')}`;
        release.earliestPeriod=start+instrument!.delayPeriods;release.lastPeriod=release.earliestPeriod;
        release.precondition={afterActionIds:[target.id],observations:[milestone!]};
        for(const [id,v]of Object.entries(target.exposures)){release.exposures[id]=[s(q(v[0]!).mul(rest))];target.exposures[id]=[s(q(v[0]!).mul(f))];}
        for(const key of ['resources','occupancy'] as const)for(const [id,v]of Object.entries(target[key])){release[key][id]=s(q(v).mul(rest));target[key][id]=s(q(v).mul(f));}
        for(const key of ['cost','tailLiability','humanSeconds'] as const){release[key]=s(q(target[key]).mul(rest));target[key]=s(q(target[key]).mul(f));}
        actions.push(release);
      }else if(structure==='INQUIRY_OPTION'){
        const inquiry=actions.find(a=>a.id===perm.inquiryActionId&&a.kind==='INQUIRE'),protocol=o.protocols.find(p=>canonicalJson(p.ref)===canonicalJson(inquiry?.protocolRef));
        need(inquiry&&protocol&&start+inquiry.informationDelayPeriods<o.mandate.horizon.periods,'R2_CURRENT_INQUIRY_OPTION');
        inquiry!.earliestPeriod=start;inquiry!.lastPeriod=start;target.earliestPeriod=start+inquiry!.informationDelayPeriods;target.lastPeriod=target.earliestPeriod;
        target.precondition={afterActionIds:[inquiry!.id],observations:[{instrumentId:protocol!.ref.id,tokens:[...new Set(Object.values(protocol!.tokensByMechanism).flat())].sort()}]};
      }else need(structure==='IMMEDIATE','R2_UNSUPPORTED_GRAMMAR_PRODUCTION');
      add(actions,structure,s(q(term)),start,fraction===null?null:s(q(fraction)));
    }
  return variants;
}

/** All lawful original courses, including constraint-infeasible courses in omitted
 * worlds. They remain in the full family; hard rows are activated in the master. */
export function constructR2Family(o:R2OriginalProblem,caps:R2Request['budget'],tick:()=>void):Pick<R2Encoding,'variants'|'courses'|'histories'|'coverage'>{
  const variants=lowerR2Grammar(o),courses:R2Course[]=[],histories=new Map<string,R2Encoding['histories'][number]>(),
    h=o.mandate.horizon.periods,start=o.problem.continuation?.elapsedPeriods??0,dimensions=o.mandate.resources.dimensions,
    n=(path:string)=>q(o.source.quantities[path]!),exp=o.source.exposureIds;
  const funding=(cls:string,unit:string)=>{
    const matches=o.resources.resources.filter(r=>r.resourceClass===cls&&r.unit===unit&&['STOCK','FLOW','CUMULATIVE_EXPENDITURE'].includes(r.kind));
    need(matches.length===1,`R2_EXACT_FUNDING_BINDING:${cls}`);scope(matches[0]!);return matches[0]!.resourceId;
  };
  const scope=(resource:R2OriginalProblem['resources']['resources'][number])=>{
    need(resource.tenantId===o.owner.tenantId&&o.resourceScopeRoots.every(root=>resource.permittedRoots.some(r=>canonicalJson(r)===canonicalJson(root))),'R2_CANONICAL_RESOURCE_SCOPE');
    need(resource.currency===(/^[A-Z]{3}$/.test(resource.unit)?resource.unit:null),'R2_CANONICAL_RESOURCE_CURRENCY');
  };
  const add=(state:CourseState,id:string,period:number,used:Q,limit:Q)=>state.constraints.push({id,period,used:s(used),limit:s(limit)});
  function initial(world:ExactWorld):CourseState{
    const continuation=o.problem.continuation,state:CourseState={history:structuredClone(world.initialHistory),actions:[...(continuation?.actionHistory??[])],
      observations:(continuation?.observations??[]).map(({instrumentId,token,availablePeriod})=>({instrumentId,token,availablePeriod})),pending:[],
      schedule:Object.fromEntries(exp.map(id=>[id,Array.from({length:h},(_,t)=>n(`/problem/baselineExposures/${id}/${t}`))])),locks:{},utility:q(world.accruedUtility),
      liability:n('/mandate/utility/tail/terminalLiability'),stopped:false,
      spent:Object.fromEntries(dimensions.map(d=>[d.id,continuation?n(`/problem/continuation/usedResources/${d.id}`):zero()])),
      occupancy:Object.fromEntries(dimensions.map(d=>[d.id,zeros(h+1)])),human:continuation?n('/problem/continuation/humanSeconds'):zero(),
      native:Object.fromEntries(o.resources.resources.map(r=>[r.resourceId,zeros(h+1)])),decisions:[],constraints:[]};
    need(start||state.utility.n===0n,'R2_UNJUSTIFIED_ACCRUED_UTILITY');
    o.problem.obligations.forEach((ob,i)=>{
      need(ob.terminalLiability!==null&&!['UNKNOWN','PARTIAL'].includes(ob.status),'R2_UNKNOWN_OBLIGATION');
      state.liability=state.liability.add(n(`/problem/obligations/${i}/terminalLiability`));
      if(ob.status!=='KNOWN_PENDING')return;
      need(ob.resources&&ob.occupancy&&ob.exposures&&ob.lockedExposureIds,'R2_INCOMPLETE_OBLIGATION');
      for(const d of dimensions){state.spent[d.id]=state.spent[d.id]!.add(n(`/problem/obligations/${i}/resources/${d.id}`));
        for(let t=0;t<Math.min(h+1,ob.occupationUntilPeriod);t++)state.occupancy[d.id]![t]=state.occupancy[d.id]![t]!.add(n(`/problem/obligations/${i}/occupancy/${d.id}`));
        // Original ControlObligation demand is incremental to prefix usage.
        // Preserve it after STOP and in the canonical S5 demand, once.
        for(const component of ['resources','occupancy'] as const){const value=n(`/problem/obligations/${i}/${component}/${d.id}`);if(!value.n)continue;
          const matches=o.resources.resources.filter(r=>r.resourceId===d.id&&r.unit===d.unit&&r.resourceClass===d.resourceClass&&
            (component==='occupancy')===['OCCUPANCY','EXPOSURE'].includes(r.kind));need(matches.length===1,'R2_CANONICAL_PENDING_RESOURCE_BINDING');
          scope(matches[0]!);const raw=state.native[matches[0]!.resourceId]!;
          for(let t=start;t<(component==='occupancy'?Math.min(h+1,ob.occupationUntilPeriod):start+1);t++)raw[t]=raw[t]!.add(value);
        }
      }
      for(const id of exp){const schedule=Array.from({length:h},(_,t)=>n(`/problem/obligations/${i}/exposures/${id}/${t}`));
        if(ob.lockedExposureIds!.includes(id)){need(!state.locks[id]||canonicalJson(state.schedule[id]!.map(s))===canonicalJson(schedule.map(s)),'R2_PENDING_CHANNEL_CONFLICT');
          state.schedule[id]=schedule;state.locks[id]=ob.occupationUntilPeriod;
        }else need(canonicalJson(state.schedule[id]!.map(s))===canonicalJson(schedule.map(s)),'R2_UNLOCKED_PENDING_CHANGE');}
    });return state;
  }
  const legal=(a:R2Action,t:number,state:CourseState)=>!(state.stopped&&a.kind!=='STOP')&&t>=a.earliestPeriod&&t<=a.lastPeriod&&
    !(a.atMostOnce&&(state.actions.includes(a.id)||o.problem.obligations.some(ob=>ob.actionId===a.id)))&&
    !(a.kind==='INTERVENE'&&(Object.values(a.exposures).some(v=>t+v.length>h)||exp.some(id=>(state.locks[id]??0)>t)))&&
    (a.precondition?.afterActionIds.every(id=>state.actions.includes(id))??true)&&
    (a.precondition?.observations.every(c=>state.observations.some(v=>v.instrumentId===c.instrumentId&&c.tokens.includes(v.token)&&v.availablePeriod<=t))??true);
  function clone(state:CourseState):CourseState{return {...state,history:structuredClone(state.history),actions:[...state.actions],observations:structuredClone(state.observations),
    pending:structuredClone(state.pending),schedule:Object.fromEntries(Object.entries(state.schedule).map(([id,v])=>[id,[...v]])),locks:{...state.locks},spent:{...state.spent},
    occupancy:Object.fromEntries(Object.entries(state.occupancy).map(([id,v])=>[id,[...v]])),native:Object.fromEntries(Object.entries(state.native).map(([id,v])=>[id,[...v]])),
    decisions:[...state.decisions],constraints:[...state.constraints]};}
  function advance(world:ExactWorld,state:CourseState,a:R2Action,t:number):CourseState{
    tick();const next=clone(state);
    for(const d of dimensions){next.spent[d.id]=next.spent[d.id]!.add(q(a.resources[d.id]!));for(let k=t;k<Math.min(h+1,t+a.occupationPeriods);k++)next.occupancy[d.id]![k]=next.occupancy[d.id]![k]!.add(q(a.occupancy[d.id]!));}
    next.human=next.human.add(q(a.humanSeconds));
    if(a.kind==='INTERVENE')for(const id of exp){a.exposures[id]!.forEach((v,k)=>{next.schedule[id]![t+k]=q(v);});next.locks[id]=t+a.exposures[id]!.length;}
    const exposures=Object.fromEntries(exp.map(id=>[id,next.schedule[id]![t]!])),mechanism=o.source.mechanisms.find(m=>m.id===world.mechanismId)!;
    need(mechanism&&world.coefficients.length===mechanism.equations.length&&world.shocks.length===h-start,'R2_WORLD_TRANSITION_COMPLETENESS');
    const atom=(f:Exclude<import('@finnor/shared-types').InterventionFeature,{kind:'PRODUCT'}>):Q=>{
      need(['CONSTANT','EXPOSURE','STATE'].includes(f.kind),'R2_UNSUPPORTED_MECHANISM_FEATURE');
      if(f.kind==='CONSTANT')return q('1');if(f.kind==='EXPOSURE'&&f.lag===0)return exposures[f.id]!;
      const row=next.history.at(-f.lag);need(row,'R2_FEATURE_HISTORY_COMPLETENESS');return q((f.kind==='STATE'?row!.states:row!.exposures)[f.id]!);
    };
    const states:Record<string,string>={};mechanism.equations.forEach((eq,j)=>{
      need(world.coefficients[j]!.length===eq.features.length&&world.shocks[t-start]!.length===mechanism.equations.length,'R2_WORLD_COEFFICIENT_COMPLETENESS');
      const value=sum(eq.features.map((f,k)=>(f.kind==='PRODUCT'?atom(f.left).mul(atom(f.right)):atom(f)).mul(q(world.coefficients[j]![k]!)))).add(q(world.shocks[t-start]![j]!));
      states[eq.variableId]=s(value);add(next,`state-upper:${eq.variableId}`,t,value,q(o.source.stateRanges[eq.variableId]![1]));
      add(next,`state-lower:${eq.variableId}`,t,zero().sub(value),zero().sub(q(o.source.stateRanges[eq.variableId]![0])));
    });
    next.history=[...next.history.slice(-2),{states,exposures:Object.fromEntries(Object.entries(exposures).map(([id,v])=>[id,s(v)]))}];
    const utility=sum(o.mandate.utility.periodTerms.map((term,j)=>q(states[term.variableId]!).mul(n(`/mandate/utility/periodTerms/${j}/coefficient`))));
    next.utility=next.utility.add(n(`/mandate/utility/discountFactors/${t}`).mul(utility.sub(q(a.cost))));next.liability=next.liability.add(q(a.tailLiability));
    o.problem.observations.forEach((instrument,i)=>{
      if(!instrument.afterActionIds.includes(a.id))return;const value=q(states[instrument.variableId]!),bins=instrument.bins.filter((b,j)=>
        value.compare(n(`/problem/observations/${i}/bins/${j}/lowerInclusive`))>=0&&value.compare(n(`/problem/observations/${i}/bins/${j}/upperExclusive`))<0);
      need(bins.length===1,'R2_OBSERVATION_COARSENING_COMPLETENESS');next.pending.push({instrumentId:instrument.id,token:bins[0]!.category,availablePeriod:t+instrument.delayPeriods});
    });
    if(a.kind==='INQUIRE'){
      const protocol=o.protocols.find(p=>canonicalJson(p.ref)===canonicalJson(a.protocolRef)),tokens=protocol&&world.inquiryTokens[protocol.ref.id];
      need(protocol&&protocol.delayPeriods===a.informationDelayPeriods&&q(protocol.completeCost).compare(q(a.cost))<=0&&tokens?.length===h-start&&
        protocol.tokensByMechanism[world.mechanismId]?.includes(tokens[t-start]!),'R2_CURRENT_FIXED_INQUIRY_WORLD');
      next.pending.push({instrumentId:protocol!.ref.id,token:tokens![t-start]!,availablePeriod:t+protocol!.delayPeriods});
    }
    next.observations.push(...next.pending.filter(v=>v.availablePeriod===t+1));next.pending=next.pending.filter(v=>v.availablePeriod>t+1);
    dimensions.forEach((d,i)=>{
      for(const component of ['resources','occupancy'] as const){const value=q(a[component][d.id]!);if(value.n===0n)continue;
        const matches=o.resources.resources.filter(r=>r.resourceId===d.id&&r.unit===d.unit&&r.resourceClass===d.resourceClass&&
          (component==='occupancy')===['OCCUPANCY','EXPOSURE'].includes(r.kind));need(matches.length===1,`R2_CANONICAL_RESOURCE_BINDING:${d.id}:${component}`);
        scope(matches[0]!);const raw=next.native[matches[0]!.resourceId]!;for(let k=t;k<(component==='occupancy'?Math.min(h+1,t+a.occupationPeriods):t+1);k++)raw[k]=raw[k]!.add(value);
      }
      add(next,`mandate-total:${d.id}`,t,next.spent[d.id]!,n(`/mandate/resources/dimensions/${i}/totalLimit`));
      for(let k=0;k<=h;k++)add(next,`mandate-occupancy:${d.id}:${k}`,t,next.occupancy[d.id]![k]!,n(`/mandate/resources/dimensions/${i}/capacity`));
    });
    add(next,'mandate-human',t,next.human,n('/mandate/search/maxHumanSeconds'));
    o.mandate.resources.couplings.forEach((c,i)=>{for(let k=0;k<=h;k++)add(next,`mandate-coupling:${c.id}:${k}`,t,
      sum(Object.keys(c.weights).map(id=>n(`/mandate/resources/couplings/${i}/weights/${id}`).mul(next.occupancy[id]![k]!))),n(`/mandate/resources/couplings/${i}/maxPerPeriod`));});
    if(q(a.cost).n){const raw=next.native[funding('CASH',o.mandate.utility.unit)]!;raw[t]=raw[t]!.add(q(a.cost));}
    if(q(a.humanSeconds).n){const raw=next.native[funding('HUMAN_ATTENTION','seconds')]!;raw[t]=raw[t]!.add(q(a.humanSeconds));}
    next.actions.push(a.id);next.stopped||=a.kind==='STOP';return next;
  }
  function terminal(state:CourseState):string{
    tick();const terminalUtility=sum(o.mandate.utility.terminalTerms.map((term,i)=>q(state.history.at(-1)!.states[term.variableId]!).mul(n(`/mandate/utility/terminalTerms/${i}/coefficient`)))),
      value=state.utility.add(n(`/mandate/utility/discountFactors/${h}`).mul(terminalUtility.sub(state.liability)));
    add(state,'worst-path-risk-floor',h,zero().sub(value),zero().sub(n('/mandate/risk/minimumUtility')));
    if(state.liability.n){const raw=state.native[funding('CASH',o.mandate.utility.unit)]!;raw[h]=raw[h]!.add(state.liability);}
    const baseline=Object.fromEntries(o.resources.resources.map(r=>[r.resourceId,r.existingUse.map(q)])),minimum=Object.fromEntries(o.resources.resources.map(r=>[r.resourceId,r.existingUse.map(q)]));
    for(const ob of o.resources.outstanding){need(!(ob.status==='RESERVED'&&ob.effectRefs.length),'R2_RESERVATION_EFFECT_STAGE');for(const envelope of ob.envelopes){
      const r=o.resources.resources.find(r=>r.resourceId===envelope.resourceId);need(r&&r.unit===envelope.unit&&r.kind===envelope.kind&&canonicalJson(r.horizon)===canonicalJson(envelope.horizon)&&
        envelope.quantities.length===h+1&&envelope.minimumQuantities?.length===h+1,'R2_COMPLETE_RESERVATION_ENVELOPE');
      for(let t=0;t<=h;t++){baseline[r!.resourceId]![t]=baseline[r!.resourceId]![t]!.add(q(envelope.quantities[t]!));minimum[r!.resourceId]![t]=minimum[r!.resourceId]![t]!.add(q(envelope.minimumQuantities![t]!));}
    }}
    const usage=(kind:string,v:Q[],t:number)=>['STOCK','CUMULATIVE_EXPENDITURE'].includes(kind)?sum(v.slice(0,t+1)):v[t]!;
    for(const r of o.resources.resources){need(!r.revoked&&canonicalJson(r.horizon)===canonicalJson(o.mandate.horizon)&&r.availability.length===h+1&&r.existingUse.length===h+1,'R2_CANONICAL_RESOURCE_CURRENT_COMPLETE');
      const total=state.native[r.resourceId]!.map((v,t)=>v.add(baseline[r.resourceId]![t]!));for(let t=0;t<=h;t++){
        need(r.availability[t]!.basis==='REPORTED_AVAILABLE'&&r.availability[t]!.amount!==null,'R2_UNRESOLVED_AVAILABILITY');
        need(usage(r.kind,minimum[r.resourceId]!,t).compare(usage(r.kind,baseline[r.resourceId]!,t))<=0,'R2_RESERVATION_MINIMUM_ENVELOPE');
        add(state,`resource:${r.resourceId}`,t,usage(r.kind,total,t),q(r.availability[t]!.amount!).sub(q(r.safetyMargin)));
      }
    }
    const covenants=new Map(o.resources.resources.flatMap(r=>r.covenants).map(c=>[c.id,c]));
    for(const c of covenants.values())for(const t of c.periods){const used=sum(c.terms.map(term=>{const r=o.resources.resources.find(r=>r.resourceId===term.resourceId)!;
      const prior=q(term.coefficient).n<0n?minimum:baseline;return q(term.coefficient).mul(usage(r.kind,state.native[r.resourceId]!.map((v,i)=>v.add(prior[r.resourceId]![i]!)),t));}));
      add(state,`covenant:${c.id}`,t,used,q(c.maximum).sub(q(c.safetyMargin)));
    }return s(value);
  }
  for(const variant of variants)for(const world of o.source.worlds){
    const visit=(state:CourseState,t:number):void=>{
      tick();need(courses.length<caps.maxPaths,'R2_CONSTRUCTION_PATH_CAP_INCOMPLETE');
      if(t===h){const utility=terminal(state);courses.push({id:`p${courses.length}`,worldId:world.id,variantId:variant.id,decisions:state.decisions,utility,
        constraints:state.constraints,terminalLiability:s(state.liability),resourceUse:Object.fromEntries(Object.entries(state.native).map(([id,v])=>[id,v.map(s)])),supported:true});return;}
      const available=variant.actions.filter(a=>legal(a,t,state)),key=variant.id+'|'+canonicalJson({period:t,actionHistory:state.actions,observations:state.observations}),
        row={key,variantId:variant.id,period:t,actionHistory:state.actions,observations:state.observations,actions:available.map(a=>a.id)};
      need(histories.size<caps.maxHistories||histories.has(key),'R2_CONSTRUCTION_HISTORY_CAP_INCOMPLETE');
      need(!histories.has(key)||canonicalJson(histories.get(key))===canonicalJson(row),'R2_HIDDEN_WORLD_ELIGIBILITY');histories.set(key,row);
      for(const a of available){const next=advance(world,state,a,t);next.decisions.push({key,period:t,actionHistory:state.actions,observations:state.observations,actionId:a.id});visit(next,t+1);}
    };visit(initial(world),start);
  }
  return {variants,courses,histories:[...histories.values()],coverage:{allWorlds:o.source.worlds.map(w=>w.id),allVariants:variants.map(v=>v.id),fullHistoriesFixed:true,bigMUsed:false,complete:true}};
}

export function encodeR2Master(o:R2OriginalProblem,family:ReturnType<typeof constructR2Family>,worlds:string[],caps:R2Request['budget']):R2Encoding{
  need(worlds.length&&new Set(worlds).size===worlds.length&&worlds.every(w=>family.coverage.allWorlds.includes(w)),'R2_RESTRICTED_WORLD_MEMBERSHIP');
  const variables:R2Encoding['variables']=[{id:'z',kind:'CONTINUOUS',lower:null,upper:null},...family.variants.map(v=>({id:`v${v.id}`,kind:'BINARY' as const,lower:'0',upper:'1'}))],
    choice=new Map<string,string>(),rows:RationalRow[]=[];
  family.histories.forEach((row,i)=>row.actions.forEach((a,j)=>{const id=`x${i}_${j}`;choice.set(row.key+'|'+a,id);variables.push({id,kind:'BINARY',lower:'0',upper:'1'});}));
  for(const c of family.courses)variables.push({id:c.id,kind:'BINARY',lower:'0',upper:'1'});
  const add=(sense:RationalRow['sense'],rhs:string,terms:Array<[string,string]>)=>{
    const combined=new Map<string,Q>();for(const [id,v]of terms)combined.set(id,(combined.get(id)??zero()).add(q(v)));
    rows.push({id:`c${rows.length}`,sense,rhs:s(q(rhs)),terms:[...combined].filter(([,v])=>v.n!==0n).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,v])=>[id,s(v)])});
  };
  add('E','1',family.variants.map(v=>[`v${v.id}`,'1']));
  for(const row of family.histories)add('E','0',[...row.actions.map(a=>[choice.get(row.key+'|'+a)!,'1'] as [string,string]),[`v${row.variantId}`,'-1']]);
  for(const variant of family.variants)for(const world of o.source.worlds)add('E','0',[
    ...family.courses.filter(c=>c.variantId===variant.id&&c.worldId===world.id).map(c=>[c.id,'1'] as [string,string]),[`v${variant.id}`,'-1']]);
  for(const c of family.courses)for(const d of c.decisions)add('L','0',[[c.id,'1'],[choice.get(d.key+'|'+d.actionId)!,'-1']]);
  for(const world of worlds){const courses=family.courses.filter(c=>c.worldId===world);
    add('L','0',[['z','1'],...courses.map(c=>[c.id,s(zero().sub(q(c.utility)))] as [string,string])]);
    for(const c of courses)if(c.constraints.some(v=>q(v.used).compare(q(v.limit))>0))add('L','0',[[c.id,'1']]);
  }
  need(variables.length<=caps.maxVariables&&rows.length<=caps.maxRows,'R2_ENCODING_CAP_INCOMPLETE');
  return {schema:'finnor.r2.milp.v1',originalDigest:epistemicHash(o),grammarDigest:epistemicHash({permitted:o.permitted,variants:family.variants}),worldDigest:epistemicHash(o.source.worlds),
    restrictedWorlds:[...worlds],variables,objective:{sense:'min',terms:[['z','-1']]},rows,...family};
}

/** SCIP's pinned exact LP reader accepts normalized rational literals through
 * SCIPrationalSetString. Preserve the original rows without denominator
 * amplification, which can exceed the native infinity threshold. The original
 * proof binder independently compares every resulting rational coefficient. */
export function r2Lp(encoding:RationalMILP):string{
  const linear=(terms:Array<[string,string]>)=>terms.map(([id,token])=>{const v=q(token);return `${v.n>=0n?'+':'-'} ${v.n<0n?-v.n:v.n}${v.d===1n?'':'/'+v.d} ${id}`;}).join(' ')||'0 z';
  const lines=['Minimize',' obj: '+linear(encoding.objective.terms),'Subject To'];
  for(const row of encoding.rows)lines.push(` ${row.id}: ${linear(row.terms)} ${row.sense==='E'?'=':row.sense==='L'?'<=':'>='} ${s(q(row.rhs))}`);
  lines.push('Bounds');
  for(const v of encoding.variables.filter(v=>v.kind==='CONTINUOUS')){
    if(v.lower===null&&v.upper===null)lines.push(` ${v.id} free`);
    else if(v.upper===null)lines.push(` ${s(q(v.lower!))} <= ${v.id}`);
    else lines.push(` ${v.lower===null?'-inf':s(q(v.lower))} <= ${v.id} <= ${s(q(v.upper))}`);
  }
  for(const v of encoding.variables)if(v.kind==='BINARY')lines.push(` 0 <= ${v.id} <= 1`);
  lines.push('Binary',...encoding.variables.filter(v=>v.kind==='BINARY').map(v=>' '+v.id),'End');return lines.join('\n')+'\n';
}

/** Exact second objective with a retained value floor. No epsilon enters value.
 * Incumbent constructor first, then fixed full-W information history/action
 * order. Inactive variants are zero; off-path decisions choose their first
 * action. A base-9 integer gives the same finite lexicographic order. */
export function encodeR2Tie(encoding:R2Encoding,minimumValue:string):R2Encoding{
 need(canonicalJson(encoding.restrictedWorlds)===canonicalJson(encoding.coverage.allWorlds),'R2_TIE_REQUIRES_FULL_W');
 const active=encoding.histories.map((row,i)=>({row,i})).filter(x=>x.row.actions.length>1),terms:Array<[string,string]>=[],scale=9n**BigInt(active.length);
 need(String(scale).length<=512,'R2_TIE_PRECISION_CAP_INCOMPLETE');
 encoding.variants.forEach((v,i)=>{if(i)terms.push([`v${v.id}`,String(BigInt(i)*scale)]);});
 active.forEach(({row,i},rank)=>{const weight=9n**BigInt(active.length-rank-1);row.actions.forEach((_,j)=>{if(j)terms.push([`x${i}_${j}`,String(BigInt(j)*weight)]);});});
 return {...encoding,objective:{sense:'min',terms},rows:[...encoding.rows,{id:`c${encoding.rows.length}`,sense:'G',rhs:s(q(minimumValue)),terms:[['z','1']]}],
  tieBreak:{basis:'ORIGINAL_VARIANT_THEN_FIXED_INFORMATION_HISTORY_ACTION_ORDER',minimumValue:s(q(minimumValue))}};
}

export function decodeR2Policy(encoding:R2Encoding,solution:Record<string,string>){
  const bit=(id:string)=>{const value=q(solution[id]??'0');need(value.n===0n||value.compare(q('1'))===0,'R2_EXACT_INTEGRAL_PRIMAL_REQUIRED');return value.n!==0n;};
  const variants=encoding.variants.filter(v=>bit(`v${v.id}`));need(variants.length===1,'R2_PRIMAL_VARIANT');
  const variant=variants[0]!,decisions:R2Decision[]=[];
  encoding.histories.forEach((row,i)=>{if(row.variantId!==variant.id)return;const selected=row.actions.filter((_,j)=>bit(`x${i}_${j}`));need(selected.length===1,'R2_PRIMAL_PURE_INFORMATION_HISTORY');
    const {key,period,actionHistory,observations}=row;decisions.push({key,period,actionHistory,observations,actionId:selected[0]!});});
  const worldCourses=encoding.coverage.allWorlds.map(worldId=>{
    const courses=encoding.courses.filter(c=>c.worldId===worldId&&c.variantId===variant.id&&bit(c.id));need(courses.length===1,'R2_PRIMAL_WORLD_COURSE');return courses[0]!;
  });return {variant,decisions,worldCourses};
}

export const R2_ENCODER_IDENTITY=R2_VERSION;
