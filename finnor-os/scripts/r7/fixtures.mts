/** Registered original synthetic inputs, no producer/checker dependencies. */
import { createHash, randomUUID } from 'node:crypto';
import type { AffineFamilySource, AtlasAffine, AtlasOriginalPolicy } from '../../packages/shared-types/src/decision-atlas';

const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):
  Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export const fixtureRef=(owner:string,id:string,body:unknown= id,version='synthetic-input-v1')=>({owner,id,version,contentDigest:hash(body)});
export function fixtureInformation(source:AffineFamilySource,kind:'positive'|'unobserved'|'reordered'|'conflicting'){
  const policy=source.policies.find(p=>p.id==='A')!;
  const original=policy.actions[0]!,probe1=fixtureRef('S2','probe-one'),probe2=fixtureRef('S2','probe-two');
  policy.actions.push({...structuredClone(original),id:'probe-one-action',kind:'INQUIRE',exposures:{},protocolRef:probe1},
    {...structuredClone(original),id:'probe-two-action',kind:'INQUIRE',exposures:{},protocolRef:probe2},
    {...structuredClone(original),id:'alternative-action'});
  const first={instrumentId:probe1.id,token:'seen',availablePeriod:1},
    second={instrumentId:probe2.id,token:'left',availablePeriod:2};
  policy.nodes=[
    {id:'A-0',period:0,actionId:'probe-one-action',actionHistory:[],observations:[],children:['A-1']},
    {id:'A-1',period:1,actionId:'probe-two-action',actionHistory:['probe-one-action'],
      observations:kind==='unobserved'?[]:[first],children:['A-left','A-right']},
    {id:'A-left',period:2,actionId:original.id,actionHistory:['probe-one-action','probe-two-action'],
      observations:kind==='unobserved'?[]:[first,second],children:[]},
    {id:'A-right',period:2,actionId:'alternative-action',actionHistory:['probe-one-action','probe-two-action'],
      observations:kind==='unobserved'?[]:kind==='reordered'?[second,first]:[first,{...second,token:'right'}],children:[]},
  ];
  if(kind==='conflicting')policy.nodes[2]!.observations.push({...second,token:'right'});
  for(const [i,world]of source.worlds.entries())world.paths.find(p=>p.policyId==='A')!.nodeIds=['A-0','A-1',i?'A-right':'A-left'];
  const {ref:_,...body}=policy;policy.ref=fixtureRef('S4','exact-affine-policy:'+hash(body),body,'s4-exact-affine-v1');
}
export function fixtureSource(kind:string,n=1,count=3,w=2,h=1,identity:{tenantId:string;principalId:string}={tenantId:randomUUID(),principalId:randomUUID()}):AffineFamilySource {
  // Original fixture literals are reduced independently, not via producer math.
  const reduced=(q:string)=>{let [a,b]=q.split('/').map(BigInt) as [bigint,bigint],x=a<0n?-a:a,y=b;
    while(y){const r=x%y;x=y;y=r;}return `${a/x}/${b/x}`;};
  const affine=(b:string,a:string[]=[])=>({a:Array.from({length:n},(_,i)=>reduced(a[i]??'0/1')),b:reduced(b)});
  const zero=()=>affine('0/1'),now=new Date(Date.now()-1000).toISOString(),until=new Date(Date.now()+3600000).toISOString();
  const labels=kind==='maximal'?Array.from({length:count},(_,i)=>'p'+i):
    ['competitor','nonmin','horizon','infeasible'].includes(kind)?(kind==='competitor'?['WAIT','C']:['WAIT','A']):kind==='multi'?['WAIT','B','A','C']:['WAIT','B','A'];
  const policy=(id:string):AtlasOriginalPolicy=>{
    const body: Omit<AtlasOriginalPolicy,'ref'>={id,rootNodeId:id+'-0',actions:[{id:id+'-action',kind:(id==='WAIT'?'WAIT':'INTERVENE') as 'WAIT'|'INTERVENE',
      cost:zero(),costUnit:'USD',tailLiability:zero(),humanSeconds:zero(),resources:{cash:zero()},occupancy:{cash:zero()},
      exposures:id==='WAIT'?{}:{dose:{unit:'fraction',doses:[affine('1/1')]}},occupationPeriods:1,earliestPeriod:0,lastPeriod:h-1,
      atMostOnce:false,protocolRef:null,informationDelayPeriods:1,precondition:{afterActionIds:[],observations:[]}}],
      nodes:Array.from({length:h},(_,t)=>({id:id+'-'+t,period:t,actionId:id+'-action',actionHistory:Array(t).fill(id+'-action'),observations:[],
        children:t<h-1?[id+'-'+(t+1)]:[]}))};
    return {...body,ref:fixtureRef('S4','exact-affine-policy:'+hash(body),body,'s4-exact-affine-v1')};
  };
  const policies=labels.map(policy);
  function payoff(id:string,world:number,t:number):AtlasAffine {
    if(kind==='maximal')return affine(`${Number(id.slice(1))+1}/${h}`,['1/'+h,'1/'+h,'1/'+h,'1/'+h]);
    if(id==='WAIT')return zero();
    if(kind==='competitor')return affine('2/1');
    if(kind==='nonmin')return affine(world?'5/1':'1/1');
    if(kind==='horizon')return affine((world===0?t===0: t===1)?'10/1':'0/1');
    if(kind==='infeasible')return affine('1/1');
    if(kind==='point')return id==='A'?affine('-1/1',['2/1']):zero();
    if(id==='B')return affine(kind==='narrow'?'1/4000000000000000000000000000000':kind==='multi'?'1/6':'1/4');
    if(kind==='multi'){
      if(id==='C')return affine('0/1',['-1/2','1/2']);
      return world===0?affine('0/1',['1/2','0/1']):world===1?affine('0/1',['0/1','1/2']):affine('1/2',['-1/2','-1/2']);
    }
    const width=kind==='narrow'?'1/1000000000000000000000000000000':'1/1';
    return world===0?affine('0/1',['1/1']):affine(width,['-1/1']);
  }
  const hard:AffineFamilySource['hardPredicates']=[];
  function add(id:string,policyId:string,worldId:string,period:number,e:AtlasAffine,relation:'LE'|'LT'|'EQ'='LE'){
    hard.push({id,policyId,worldId,period,expression:e,relation,unit:'USD',owner:'BUSINESS_OWNER',sourceRef:fixtureRef('BUSINESS_OWNER','hard:'+id)});
  }
  for(let world=0;world<w;world++){
    if(['diagnostic','line','point','strict','empty'].includes(kind))add('A-limit-'+world,'A','w'+world,0,affine('-2/3',['1/1']));
    if(kind==='narrow')add('A-limit-'+world,'A','w'+world,0,affine('-2/3000000000000000000000000000000',['1/1']));
    if(kind==='competitor')add('C-entry-'+world,'C','w'+world,0,affine('3/4',['-1/1']));
    if(kind==='nonmin'&&world===1)add('nonmin-hard','A','w1',0,affine('1/1'));
    if(kind==='infeasible')for(const id of labels)add('impossible-'+id+world,id,'w'+world,0,affine('1/1'));
    if(kind==='multi')add('A-joint-'+world,'A','w'+world,1,affine('-1/1',['1/1','1/1']));
  }
  const unitRef=fixtureRef('BUSINESS_OWNER','unit-convention');
  const mBody={schema:'finnor.economic-mandate.exact-affine.v1' as const,...identity,episodeId:randomUUID(),rightsRef:'r7-synthetic-owner-rights',
    knowledgeAt:now,validUntil:until,businessOwnerRef:fixtureRef('BUSINESS_OWNER',identity.principalId),utilityRef:unitRef,accountingConventionRef:unitRef,
    horizon:{startAt:now,periodMs:86400000,periods:h},quantityBasis:{unit:'USD',currency:'USD',ownershipRef:unitRef,valuationAt:now,discountBasisRef:unitRef},
    utility:{periodTerms:[{variableId:'net',unit:'USD',coefficient:'1/1',coefficientUnit:'USD/USD'}],terminalTerms:[],discountFactors:Array(h+1).fill('1/1'),terminalLiability:'0/1'},
    minimumUtility:'-1000/1',maxHumanSeconds:'900/1',dimensions:[{id:'cash',unit:'USD',resourceClass:'CASH',capacity:'1000/1',totalLimit:'1000/1',resourceId:'cash',component:'TOTAL' as const}],
    couplings:[],funding:{costResourceId:'cash',liabilityResourceId:'cash',humanResourceId:null},
    ambiguity:'ROBUST_FIXED_COMPLETE_WORLDS_NO_PROBABILITIES' as const,authorization:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED' as const};
  const facets:AffineFamilySource['domain']['facets']=[];
  if(kind==='line')facets.push({expression:affine('0/1',['1/1','-1/1']),relation:'EQ'});
  if(kind==='point')facets.push({expression:affine('-1/2',['1/1']),relation:'EQ'});
  if(kind==='empty')facets.push({expression:affine('1/1'),relation:'LE'});
  if(kind==='strict'){facets.push({expression:affine('0/1',['-1/1']),relation:'LT'});
    facets.push({expression:affine('-1/1',['1/1']),relation:'LE'},{expression:affine('-2/1',['2/1']),relation:'LE'});}
  return {schema:'finnor.s3.affine-family-source.v1',modelKey:'synthetic-'+kind,familyKey:'synthetic-'+kind,
    representation:'SUPPLIED_COMPLETE_AFFINE_PATH_HYPOTHESIS',domain:{parameters:Array.from({length:n},(_,i)=>({id:'x'+i,unit:'fraction',currency:null,
      owner:'BUSINESS_OWNER',valueSource:'AUTHENTICATED_OWNER_REVISION',resourceId:null,resourcePeriod:null,
      lower:'0/1',upper:kind==='narrow'?'1/1000000000000000000000000000000':'1/1'})),facets},
    mandate:{...mBody,ref:fixtureRef('BUSINESS_OWNER','exact-affine-mandate:'+hash(mBody),mBody,'economic-mandate-exact-affine-v1')},
    stateUnits:{net:'USD'},policies,worlds:Array.from({length:w},(_,world)=>({id:'w'+world,mechanismRef:fixtureRef('S3','mechanism-'+world),
      supportRef:fixtureRef('BUSINESS_OWNER','complete-world-'+world),paths:policies.map(p=>({policyId:p.id,nodeIds:p.nodes.map(node=>node.id),
        states:[{net:zero()},...Array.from({length:h},(_,t)=>({net:payoff(p.id,world,t)}))]}))})),
    hardPredicates:hard,tieOrder:labels.filter(id=>id!=='WAIT').reverse().concat('WAIT').filter(id=>labels.includes(id)),
    assumptions:['Exact supplied finite trajectories and policy correspondence are model hypotheses, not learned or field identified.',
      'Declared complete worlds preserve correlation and the full original horizon; business adequacy and admission remain UNKNOWN.'],
    qualification:'MODEL_RELATIVE_EXACT_UNADMITTED',parameterValues:Array(n).fill(kind==='narrow'?'1/2000000000000000000000000000000':'1/2')};
}
