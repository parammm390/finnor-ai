import {createHash} from 'node:crypto';
import type {R2OriginalProblem,R2Request} from '../../packages/shared-types/src/robust-programme-search';
import {R2_VERSION,R2_PROFILE} from '../../packages/shared-types/src/robust-programme-search';
import {canonicalJson} from '../../packages/epistemic-runtime/src/source-precedence';
export const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export const ref=(id:string,owner='S1')=>({owner,id,version:'r2-dev-fixture-v1',contentDigest:hash({id,owner})});
export const caps:R2Request['budget']={maxPaths:50000,maxHistories:50000,maxVariables:100000,maxRows:300000,
 maxProofBytes:8388608,cpuMs:30000,memoryMiB:512,maxNativeCalls:128};
export function originalDecimal(value:number):string{
 if(!Number.isFinite(value))throw Error('Original numeric input is nonfinite');
 const token=String(value);if(!/[eE]/.test(token))return token;
 const [mantissa,exponent]=token.split(/[eE]/),negative=mantissa!.startsWith('-'),[whole,fraction='']=mantissa!.replace(/^-/,'').split('.'),digits=whole!+fraction,point=whole!.length+Number(exponent);
 return (negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
}
export function quantities(value:unknown,prefix='',result:Record<string,string>={}):Record<string,string>{
 if(typeof value==='number')result[prefix]=originalDecimal(value);
 else if(Array.isArray(value))value.forEach((x,i)=>quantities(x,prefix+'/'+i,result));
 else if(value&&typeof value==='object')for(const [key,x]of Object.entries(value))quantities(x,prefix+'/'+key.replaceAll('~','~0').replaceAll('/','~1'),result);
 return result;
}
/** Original PRD table represented by a supplied exact polynomial response.
 * No fitted/bootstrap output is reused as an exact parameter. */
export function table(revised=false):R2OriginalProblem{
 const now='2026-10-10T00:00:00.000Z',until='2027-10-10T00:00:00.000Z',horizon={startAt:now,periodMs:86400000,periods:1},
 tenantId='11111111-1111-4111-8111-111111111111',principalId='22222222-2222-4222-8222-222222222222';
 const mandate:any={schema:'finnor.economic-mandate.v1',ref:ref('mandate','S4'),tenantId,principalId,episodeId:'table',knowledgeAt:now,validUntil:until,
  businessOwnerRef:ref('business-owner'),rightsRef:'owner',utilityRef:ref('utility','S4'),horizon,
  utility:{unit:'USD',accountingConventionRef:ref('accounting'),periodTerms:[{variableId:'payoff',unit:'USD',coefficient:1}],
   discountFactors:[1,1],terminalTerms:[],tail:{status:'SUPPLIED_COMPLETE_FINITE_HORIZON',terminalLiability:0,ref:ref('tail')}},
  risk:{kind:'HARD_WORST_PATH_UTILITY_FLOOR',minimumUtility:-100},ambiguity:{kind:'ROBUST_FIXED_JOINT_SCENARIOS',authorizationRef:ref('worlds')},
  resources:{dimensions:[{id:'capital',unit:'capital',resourceClass:'COMMITTED_CAPITAL',capacity:4,totalLimit:4}],couplings:[]},
  search:{maxExpansions:100000,deadlineMs:30000,maxWorlds:32,maxPolicyNodes:10000,maxHumanSeconds:0},scoring:{normalization:10,maxRegret:0},
  authorization:{basis:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED',protectedReceipt:null}};
 const action=(id:string,exposure:number,capital:number,kind='INTERVENE')=>({id,kind,cost:0,costUnit:'USD',resources:{capital},occupancy:{capital:0},
  occupationPeriods:1,tailLiability:0,earliestPeriod:0,lastPeriod:0,atMostOnce:kind==='INTERVENE',exposures:kind==='INTERVENE'?{dose:[exposure]}:{},
  protocolRef:null,informationDelayPeriods:0,humanSeconds:0});
 const modelRef=ref('original-model','S3'),problem:any={schema:'finnor.control-problem.v1',id:'table',episodeId:'table',modelRef,context:'exact-dev',regime:'table',
  baselineExposures:{dose:[0]},actions:[action('wait',0,0,'WAIT'),action('Immediate',1,4),action('Staged',.5,3)],observations:[],obligations:[],validUntil:until};
 const exposure={kind:'EXPOSURE',id:'dose',lag:0},mechanisms:any=[{id:'declared',equations:[{variableId:'payoff',features:[exposure,{kind:'PRODUCT',left:exposure,right:exposure}]}]}],
  modelHistory=[{states:{payoff:0},exposures:{dose:0}}],modelRequest:any={mechanisms,stateVariables:[{id:'payoff',unit:'USD',range:[-100,100]}],exposures:[{id:'dose',unit:'dose'}]};
 const source:any={schema:'finnor.s3.exact-control-source.v1',qualification:'SUPPLIED_EXACT_FINITE_MODEL_UNADMITTED',mandateRef:mandate.ref,problemDigest:hash(problem),modelRef,
  quantities:quantities({mandate,problem,history:modelHistory}),accounting:{ref:mandate.utility.accountingConventionRef,entityRef:ref('entity'),unit:'USD',currency:'USD',valuationDate:now,
   ownerShare:'1',timeBasis:horizon,discountConvention:'ORIGINAL_OWNER_FACTORS'},mechanisms,stateUnits:{payoff:'USD'},stateRanges:{payoff:['-100','100']},exposureIds:['dose'],
  worlds:[['A',['12','-4']],['B',['5','-2']],['C',revised?['-4','0']:['8','-12']]].map(([id,c])=>({id,mechanismId:'declared',initialHistory:[{states:{payoff:'0'},exposures:{dose:'0'}}],coefficients:[c],shocks:[['0']],inquiryTokens:{},accruedUtility:'0'})),
  completeWorldDeclaration:'ALL_DECLARED_JOINT_WORLDS_NO_PROBABILITIES'};
 const resourceScopeRoots=[{entityType:'fixture_entity',entityId:'entity'}];
 const resource:any={schema:'finnor.allocation-resource.v1',resourceId:'capital',tenantId,ownerRef:ref('owner'),legalEntityRef:ref('entity'),scopeRef:ref('scope'),permittedRoots:resourceScopeRoots,rightsRef:'owner',unit:'capital',currency:null,
  kind:'STOCK',resourceClass:'COMMITTED_CAPITAL',horizon,sourceRef:ref('capital-source'),asOf:now,knowledgeAt:now,validUntil:until,beliefPins:[],
  availability:[{amount:'4',basis:'REPORTED_AVAILABLE'},{amount:'4',basis:'REPORTED_AVAILABLE'}],existingUse:['0','0'],safetyMargin:'0',covenants:[],revoked:false,
  qualification:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED',ref:ref('capital','S5'),revision:1,priorRef:null};
 return {schema:'finnor.r2.original.v1',version:R2_VERSION,profile:R2_PROFILE,source,sourceRef:ref('exact-source'),mandate,problem,modelRequest,modelHistory,
  incumbentPolicyRef:ref('old-policy','S4'),resourceScopeRoots,permitted:{actionId:'Immediate',exposureId:'dose',unit:'dose',terms:['1'],startPeriods:[0],structures:['IMMEDIATE'],stageFractions:[],resourceRule:'SCALE_REGISTERED_ACTION_LINEAR',agreement:'UNILATERAL_PROPOSAL'},protocols:[],
  resources:{resources:[resource],outstanding:[],snapshotDigest:hash(resource)},owner:{tenantId,principalId,workId:'33333333-3333-4333-8333-333333333333',inputId:'44444444-4444-4444-8444-444444444444',inputDigest:hash('input'),planId:'55555555-5555-4555-8555-555555555555',planDigest:hash('plan'),ownerVector:[],dependencies:[],knowledgeAt:now,validUntil:until,outstandingEffects:[]}};
}
export function reseal(o:R2OriginalProblem):R2OriginalProblem{
 o.source.mandateRef=o.mandate.ref;o.source.problemDigest=hash(o.problem);o.source.modelRef=o.problem.modelRef;
 o.source.quantities=quantities({mandate:o.mandate,problem:o.problem,history:o.modelHistory});return o;
}
export function contingent():R2OriginalProblem{
 const o=table();o.mandate.horizon.periods=2;o.mandate.utility.discountFactors=[1,1,1];o.problem.baselineExposures.dose=[0,0];
 o.problem.actions=o.problem.actions.filter(a=>a.id!=='Staged');o.problem.actions.find(a=>a.id==='wait')!.lastPeriod=1;
 const stop=structuredClone(o.problem.actions[0]!);stop.id='stop';stop.kind='STOP';o.problem.actions.push(stop);
 o.problem.observations=[{schema:'finnor.s2.control-observation.v1',id:'outcome',sourceRef:ref('public-bins','S2'),variableId:'payoff',unit:'USD',
  delayPeriods:1,afterActionIds:['Immediate'],bins:[{category:'LOW',lowerInclusive:-100,upperExclusive:4},{category:'HIGH',lowerInclusive:4,upperExclusive:101}],qualification:'SUPPLIED_DETERMINISTIC_COARSENING_UNVERIFIED'}];
 o.permitted.structures=['OBSERVABLE_STAGE'];o.permitted.stageFractions=['0.5'];o.permitted.milestone={instrumentId:'outcome',tokens:['HIGH']};
 o.source.worlds=o.source.worlds.filter(w=>w.id!=='B');for(const w of o.source.worlds)w.shocks=[['0'],['0']];
 for(const resource of o.resources.resources){resource.horizon=structuredClone(o.mandate.horizon);resource.availability.push(structuredClone(resource.availability[0]!));resource.existingUse.push('0');}
 o.source.accounting.timeBasis=structuredClone(o.mandate.horizon);return reseal(o);
}
export function boundary():R2OriginalProblem{
 const o=contingent(),h=24;o.mandate.horizon.periods=h;o.mandate.utility.discountFactors=Array(h+1).fill(1);o.problem.baselineExposures.dose=Array(h).fill(0);
 const immediate=o.problem.actions.find(a=>a.id==='Immediate')!;immediate.precondition={afterActionIds:['Immediate'],observations:[]};
 o.problem.actions.find(a=>a.id==='wait')!.lastPeriod=22;o.problem.actions.find(a=>a.id==='stop')!.earliestPeriod=23;o.problem.actions.find(a=>a.id==='stop')!.lastPeriod=23;
 while(o.problem.actions.length<8){const a=structuredClone(immediate);a.id='blocked-'+o.problem.actions.length;a.precondition={afterActionIds:[a.id],observations:[]};o.problem.actions.push(a);}
 o.problem.observations=Array.from({length:8},(_,i)=>({...structuredClone(o.problem.observations[0]!),id:'instrument-'+i}));
 o.permitted.structures=['IMMEDIATE'];o.permitted.stageFractions=[];delete o.permitted.milestone;
 o.source.worlds=Array.from({length:32},(_,i)=>({...structuredClone(o.source.worlds[0]!),id:'world-'+i,shocks:Array.from({length:h},()=>['0'])}));
 for(const resource of o.resources.resources){resource.horizon=structuredClone(o.mandate.horizon);resource.availability=Array.from({length:h+1},()=>({amount:'4',basis:'REPORTED_AVAILABLE'}));resource.existingUse=Array(h+1).fill('0');}
 o.source.accounting.timeBasis=structuredClone(o.mandate.horizon);return reseal(o);
}

export function delayedInquiry():R2OriginalProblem{
 const o=contingent();o.problem.observations=[];o.permitted.structures=['INQUIRY_OPTION'];o.permitted.stageFractions=[];delete o.permitted.milestone;
 const immediate=o.problem.actions.find(a=>a.id==='Immediate')!;immediate.earliestPeriod=immediate.lastPeriod=1;
 const reverse=structuredClone(immediate);reverse.id='Reverse';reverse.exposures.dose=[-1];o.problem.actions.push(reverse);
 const inquiry=structuredClone(o.problem.actions.find(a=>a.kind==='WAIT')!);inquiry.id='inquire';inquiry.kind='INQUIRE';inquiry.atMostOnce=true;inquiry.earliestPeriod=inquiry.lastPeriod=0;inquiry.informationDelayPeriods=1;inquiry.protocolRef=ref('fixed-inquiry','S2');
 o.problem.actions.push(inquiry);o.permitted.inquiryActionId=inquiry.id;
 o.protocols=[{ref:inquiry.protocolRef,tokensByMechanism:{declared:['HIGH','LOW']},delayPeriods:1,completeCost:'0'}];
 for(const w of o.source.worlds){w.coefficients=[[w.id==='A'?'8':'-4','0']];w.inquiryTokens={[inquiry.protocolRef.id]:[w.id==='A'?'HIGH':'LOW',w.id==='A'?'HIGH':'LOW']};}
 return reseal(o);
}
export function continuationAccrual():R2OriginalProblem{
 const o=contingent();o.permitted.structures=['IMMEDIATE'];o.permitted.startPeriods=[1];o.permitted.stageFractions=[];delete o.permitted.milestone;o.problem.observations=[];
 o.problem.actions.find(a=>a.id==='Immediate')!.earliestPeriod=1;o.problem.actions.find(a=>a.id==='Immediate')!.lastPeriod=1;
 o.problem.continuation={elapsedPeriods:1,actionHistory:['wait'],observations:[],accruedUtility:{value:0,unit:'USD',sourceRef:ref('original-accrual')},usedResources:{capital:0},humanSeconds:0,accountingRef:o.mandate.utility.accountingConventionRef};
 for(const w of o.source.worlds){w.shocks=[['0']];w.accruedUtility=w.id==='A'?'0':'10';}
 return reseal(o);
}
export function pendingAfterStop():R2OriginalProblem{
 const o=contingent();o.problem.observations=[];o.permitted.structures=['IMMEDIATE'];o.permitted.stageFractions=[];delete o.permitted.milestone;
 o.problem.actions.sort((a,b)=>(a.kind==='STOP'?-1:b.kind==='STOP'?1:0));
 o.problem.obligations=[{ref:ref('known-pending','S6'),effectRef:ref('hypothetical-original-effect','S6'),actionId:'old-commitment',status:'KNOWN_PENDING',exposures:{dose:[.5,.5]},resources:{capital:3},occupancy:{capital:0},lockedExposureIds:['dose'],occupationUntilPeriod:2,terminalLiability:1}];
 for(const w of o.source.worlds)w.coefficients=[['4','0']];
 const cash=structuredClone(o.resources.resources[0]!);cash.resourceId='cash';cash.unit='USD';cash.currency='USD';cash.resourceClass='CASH';cash.availability=Array.from({length:3},()=>({amount:'1',basis:'REPORTED_AVAILABLE'}));cash.existingUse=['0','0','0'];cash.ref=ref('cash','S5');o.resources.resources.push(cash);
 return reseal(o);
}
export function fixedCorrelation():R2OriginalProblem{
 const o=contingent();o.problem.observations=[];o.permitted.structures=['IMMEDIATE'];o.permitted.stageFractions=[];delete o.permitted.milestone;
 const plus=o.problem.actions.find(a=>a.id==='Immediate')!;plus.lastPeriod=1;plus.atMostOnce=false;
 const minus=structuredClone(plus);minus.id='Reverse';minus.exposures.dose=[-1];o.problem.actions.push(minus);
 o.mandate.resources.dimensions[0]!.totalLimit=8;o.mandate.resources.dimensions[0]!.capacity=8;
 for(const resource of o.resources.resources)resource.availability=Array.from({length:3},()=>({amount:'8',basis:'REPORTED_AVAILABLE'}));
 for(const w of o.source.worlds)w.coefficients=[[w.id==='A'?'1':'-1','0']];
 return reseal(o);
}
