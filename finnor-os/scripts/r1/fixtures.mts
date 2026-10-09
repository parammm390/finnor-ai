/** Supplied finite fixtures authored before R1 product implementation.
 * They establish model-relative contracts, never enterprise economic evidence. */
import {createHash,randomUUID} from 'node:crypto';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const rational=(n:number|string,d:number|string=1)=>({numerator:String(n),denominator:String(d)});
export const reference=(id:string,owner='SUPPLIED')=>({owner,id,version:'supplied-exact-v1',contentDigest:hash(id)});
export function finiteFixture(id='equivalent-histories',periods=3,actionCount=4,upper=false):any{
 const tenantId=randomUUID(),principalId=randomUUID(),startAt=new Date(Date.now()-1000).toISOString();
 const actions=Array.from({length:actionCount},(_,i)=>({id:i===actionCount-1?'stop':i===actionCount-2?'wait':'choice'+i,kind:i===actionCount-1?'STOP':i===actionCount-2?'WAIT':'INTERVENE',earliestPeriod:0,lastPeriod:i<actionCount-1?0:periods-1,atMostOnce:false,precondition:{afterActionIds:[],observations:[]},protocolRef:null,informationDelayPeriods:1,resources:{capital:rational(0)},occupancy:{capital:rational(0)},occupationPeriods:1,cost:rational(0),costUnit:'USD',tailLiability:rational(0),humanSeconds:rational(0),exposures:{}}));
 const model:any={schema:'finnor.s3.exact-information-model.v1',profile:'finite-information-rational-v1',id,tenantId,principalId,rightsRef:'supplied-owner-rights',root:{entityType:'external_organization',entityId:randomUUID()},mandateRef:reference(id+':mandate','BUSINESS_OWNER'),sourceRefs:[reference(id+':source','S1')],assumptions:['Complete declared finite table and full horizon payoffs are supplied assumptions. No learned model conversion or field identification is asserted.'],encoding:{kind:'EXACT_RATIONAL_SOURCE',originalNumericModelRef:null},horizon:{startAt,periodMs:1000,periods},units:{utility:'USD',resources:{capital:'USD'}},economics:{minimumUtility:rational(-100000),discountFactors:Array.from({length:periods+1},()=>rational(1)),terminalLiability:rational(0),normalization:rational(100)},uncertainty:{kind:'FIXED_COMPLETE_WORLDS',worlds:['world-a','world-b'],lawRef:null,qualificationRef:null,worldWeights:{}},actions,observationInstruments:[],roots:['root'],states:[]};
 model.units.money={currency:'USD',unit:'USD',valuationAt:startAt,ownerShare:rational(1),timeBasis:'DECLARED_FINITE_PERIODS',discountConventionRef:reference(id+':discount-convention','BUSINESS_OWNER'),qualification:'SUPPLIED_OWNER_ASSERTION_UNADMITTED'};
 model.assumptions.push('The hypothetical fixture explicitly supplies USD, the stated valuation date and full owner share; these are inputs, not enterprise ownership or economic qualification.');
 function state(sid:string,period:number,history:string[],value:any,stopped:boolean){
  const accruedUtility={'world-a':value,'world-b':value};return {id:sid,period,history,observations:[],worlds:['world-a','world-b'],semantics:{rights:{rightsRef:model.rightsRef,revision:0,availableInstruments:[]},pendingObservations:[],maturity:[],optionConditions:[],exposureSchedules:{},exposureLocks:[],resources:{capacity:{capital:rational(100000)},totalLimit:{capital:rational(100000)},used:{capital:rational(0)},reserved:{capital:rational(0)},occupancy:{capital:Array.from({length:periods+1},()=>rational(0))},couplings:[],worldUse:Object.fromEntries(['world-a','world-b'].map(w=>[w,{used:{capital:rational(0)},occupancy:{capital:Array.from({length:periods+1},()=>rational(0))},humanUsed:rational(0),computeUsed:rational(0)}]))},liquidity:[],covenants:[],humanUsed:rational(0),humanLimit:rational(900),computeUsed:rational(0),computeLimit:rational(4000000),staffing:[],compensation:[],employeeBenefits:[],obligations:[],accruedUtility,terminalLiabilities:{'world-a':rational(0),'world-b':rational(0)},terminalUtility:{'world-a':rational(0),'world-b':rational(0)},stopped},transitions:[]};
 }
 const root=state('root',0,[],rational(0),false);model.states.push(root);
 for(let i=0;i<actions.length;i++){
  const a=actions[i],value=i<actionCount-2?rational(7):rational(0),chain=[];
  for(let t=1;t<=periods;t++){
   const history=[a.id,...Array(t-1).fill('stop')],s=state('arm'+i+':'+t,t,history,value,a.kind==='STOP'||t>1);model.states.push(s);chain.push(s);
   if(t<periods)s.transitions=[{actionId:'stop',outcomes:model.uncertainty.worlds.map((worldId:string)=>({worldId,mass:rational(1),grossUtility:rational(0),immediateUtility:rational(0),resourceDelta:{capital:rational(0)},occupancyDelta:{capital:Array.from({length:periods+1},()=>rational(0))},humanDelta:rational(0),obligations:s.semantics.obligations,successor:'arm'+i+':'+(t+1)}))}];
  }
  root.transitions.push({actionId:a.id,outcomes:model.uncertainty.worlds.map((worldId:string)=>({worldId,mass:rational(1),grossUtility:value,immediateUtility:value,resourceDelta:{capital:rational(0)},occupancyDelta:{capital:Array.from({length:periods+1},()=>rational(0))},humanDelta:rational(0),obligations:[],successor:chain[0].id}))});
 }
 if(upper){model.observationInstruments=[{id:'unreachable-audit',sourceRef:reference('unreachable-audit','S2'),delayPeriods:1,afterActionIds:['stop'],tokens:Array.from({length:31},(_,i)=>'u'+i),rightsRef:model.rightsRef}];while(model.states.length<128){const j=model.states.length,s=state('unreachable:'+j,periods,Array(periods).fill('stop'),rational(j),true);s.observations=[{instrumentId:'unreachable-audit',token:'u'+(j-97),availablePeriod:periods}];s.semantics.rights.availableInstruments=['unreachable-audit'];model.states.push(s);}}
 return model;
}
export function registeredModels(){
 const equivalent=finiteFixture();
 const exact=finiteFixture('exact-near-equality',2);exact.states.filter((s:any)=>s.id.startsWith('arm0:')).forEach((s:any)=>s.semantics.accruedUtility={'world-a':rational('700000000000000000001','100000000000000000000'),'world-b':rational('700000000000000000001','100000000000000000000')});exact.states[0].transitions[0].outcomes.forEach((o:any)=>{o.immediateUtility=rational('700000000000000000001','100000000000000000000');o.grossUtility=o.immediateUtility;});
 const vectors=finiteFixture('equal-worst-different-world-vector',2);for(const s of vectors.states.filter((s:any)=>s.id.startsWith('arm0:')))s.semantics.accruedUtility={'world-a':rational(7),'world-b':rational(9)};vectors.states[0].transitions[0].outcomes[1].immediateUtility=rational(9);vectors.states[0].transitions[0].outcomes[1].grossUtility=rational(9);
 const encoded=finiteFixture('equivalent-rational-encoding',2);for(const s of encoded.states.filter((s:any)=>s.id.startsWith('arm1:')))s.semantics.accruedUtility={'world-a':rational(14,2),'world-b':rational(21,3)};encoded.states[0].transitions[1].outcomes[0].immediateUtility=rational(14,2);encoded.states[0].transitions[1].outcomes[1].immediateUtility=rational(21,3);for(const o of encoded.states[0].transitions[1].outcomes)o.grossUtility=o.immediateUtility;
 const tail=finiteFixture('retained-stop-tail-liability',2);for(const s of tail.states){s.semantics.terminalLiabilities={'world-a':rational(3),'world-b':rational(3)};if(s.period===2)for(const key of Object.keys(s.semantics.accruedUtility)){const v=s.semantics.accruedUtility[key];s.semantics.accruedUtility[key]=rational(String(Number(v.numerator)-3),v.denominator);}}
 return [equivalent,exact,vectors,encoded,tail,finiteFixture('profile-upper-bounds',12,8,true)];
}
/** Complete small lawful histories: later tied choices and delivered observations
 * are declared in original inputs, not copied from the production answer. */
export function completeTreeFixture(id='later-optimal-ties',observed=false):any{
 const m=finiteFixture(id,2),template=structuredClone(m.states[0]),zero=rational(0),worlds=['world-a','world-b'];m.states=[];
 if(observed){
  m.actions[0].id='probe';m.actions[0].kind='INQUIRE';m.actions[0].lastPeriod=0;m.actions[0].protocolRef=reference('signal','S2');
  m.actions[1].id='raise';m.actions[1].earliestPeriod=1;m.actions[1].lastPeriod=1;m.actions[1].precondition={afterActionIds:['probe'],observations:[{instrumentId:'signal',tokens:['HIGH','LOW']}]};
  m.observationInstruments=[{id:'signal',sourceRef:reference('signal','S2'),delayPeriods:1,afterActionIds:['probe'],tokens:['HIGH','LOW'],rightsRef:m.rightsRef}];
 }else {m.actions[0].lastPeriod=1;m.actions[1].lastPeriod=1;}
 m.actions[2].lastPeriod=1;
 function visit(history:string[],observations:any[],support:string[],accrued:Record<string,number>,stopped:boolean):any{
  const period=history.length,s=structuredClone(template);s.id=period===0?'root':'node:'+m.states.length;s.period=period;s.history=history;s.observations=observations;s.worlds=support;s.transitions=[];
  s.semantics.stopped=stopped;s.semantics.rights.availableInstruments=observations.length?['signal']:[];
  for(const name of ['accruedUtility','terminalUtility','terminalLiabilities'])s.semantics[name]=Object.fromEntries(support.map(w=>[w,rational(name==='accruedUtility'?accrued[w]!:0)]));
  s.semantics.resources.worldUse=Object.fromEntries(support.map(w=>[w,structuredClone(template.semantics.resources.worldUse[w])]));
  m.states.push(s);if(period===2)return s;
  let enabled:string[];
  if(stopped)enabled=['stop'];else if(observed)enabled=period===0?['probe','wait','stop']:observations.length?['raise','wait','stop']:['wait','stop'];else enabled=['choice0','choice1','wait','stop'];
  for(const actionId of enabled){
   const action=m.actions.find((a:any)=>a.id===actionId),groups=actionId==='probe'?support.map(w=>({support:[w],observations:[{instrumentId:'signal',token:w==='world-a'?'HIGH':'LOW',availablePeriod:1}]})):[{support,observations}];
   const gross=(w:string)=>observed?(actionId==='probe'?7:actionId==='raise'&&w==='world-a'?1:0):(period===0?(action.kind==='INTERVENE'?7:0):actionId==='choice0'?(w==='world-b'?1:0):actionId==='choice1'?(w==='world-a'?1:0):0);
   const outcomes:any[]=[];
   for(const g of groups){const next=Object.fromEntries(g.support.map(w=>[w,accrued[w]!+gross(w)])),child=visit([...history,actionId],g.observations,g.support,next,stopped||action.kind==='STOP');
    for(const w of g.support)outcomes.push({worldId:w,mass:rational(1),grossUtility:rational(gross(w)),immediateUtility:rational(gross(w)),resourceDelta:{capital:rational(0)},occupancyDelta:{capital:Array.from({length:3},()=>rational(0))},humanDelta:rational(0),obligations:[],successor:child.id});
   }
   s.transitions.push({actionId,outcomes});
  }return s;
 }
 visit([],[],worlds,Object.fromEntries(worlds.map(w=>[w,0])),false);return m;
}
export function extendedRegisteredModels(){
 const base=registeredModels(),identity=finiteFixture('identity-quotient',2);
 for(const s of identity.states)if(s.history.length)s.semantics.maturity=[{id:'original-commitment-'+s.history[0],duePeriod:2,amount:rational(1),unit:'USD'}];
 const correlation=finiteFixture('fixed-world-correlation',2);
 correlation.states[0].transitions[0].outcomes.forEach((o:any,i:number)=>{o.grossUtility=rational(i===0?10:0);o.immediateUtility=o.grossUtility;});
 for(const s of correlation.states.filter((s:any)=>s.id.startsWith('arm0:'))){
  s.semantics.accruedUtility={'world-a':rational(10),'world-b':rational(s.period===2?10:0)};
  for(const t of s.transitions)for(const o of t.outcomes){o.grossUtility=rational(o.worldId==='world-b'?10:0);o.immediateUtility=o.grossUtility;}
 }
 const constraints=finiteFixture('complete-financial-employee-constraints',2);
 for(const s of constraints.states.filter((s:any)=>s.history[0]==='choice1'))for(const field of ['liquidity','covenants','staffing','compensation','employeeBenefits'])s.semantics[field]=[{schema:'finnor.exact-state-constraint.v1',id:'original-'+field,relation:field==='staffing'?'GE':'LE',left:rational(1),right:rational(0),sourceRef:reference('supplied-'+field,'BUSINESS_OWNER')}];
 const occupied=finiteFixture('committed-occupancy-not-free-after-stop',2),a=occupied.actions[0];a.occupancy.capital=rational(2);a.occupationPeriods=3;
 for(const s of occupied.states){s.semantics.resources.capacity.capital=rational(1);if(s.history[0]==='choice0'){s.semantics.resources.occupancy.capital=Array.from({length:3},()=>rational(2));for(const w of s.worlds)s.semantics.resources.worldUse[w].occupancy.capital=Array.from({length:3},()=>rational(2));}}
 occupied.states[0].transitions[0].outcomes.forEach((o:any)=>o.occupancyDelta.capital=Array.from({length:3},()=>rational(2)));
 return [...base,identity,correlation,constraints,occupied,completeTreeFixture(),completeTreeFixture('delivered-information-and-global-later-ties',true)];
}
