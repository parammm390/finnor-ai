/** Public preimplementation mechanism oracle. Never imports the learner,
 * adapter or checker to manufacture expected observations or success labels. */
import {randomUUID} from 'node:crypto';
import {createEvidenceSource,appendEvidenceVersionTx} from '@finnor/memory';
import {receiveWork,withTenant} from '@finnor/db';
import {epistemicHash} from '../../packages/epistemic-runtime/src/source-precedence';
import type {StrategicResponseProblem,StrategicResponseEpisode,StrategicForecastRequest} from '../../packages/shared-types/src/strategic-response';
export const ownerRef=(id:string,owner='BUSINESS_OWNER')=>({owner,id,version:'public-y2-owner-input-v1',contentDigest:epistemicHash({id,owner})});
const observed=(incentive:number,outside:number,peer:number,interaction:number,common:number)=>Number(1+incentive+2*interaction*peer-outside+common>=0) as 0|1;
export function publicProblem(root:StrategicResponseProblem['payoff']['entityRoot'],informative=false):StrategicResponseProblem{
 const rules:StrategicResponseProblem['rules']=[...[-1,0,1,2].map((incentive,i)=>({id:'inc'+i,incentive,interaction:0,
  peerDisclosure:'LAGGED_PEER_COUNT' as const,settlement:'ALL_ACTORS_PARTICIPATE' as const,
  allocation:'JOINT_ALL_OR_NONE' as const,transfer:'DECLARED_FIXED_INCENTIVE' as const})),
  {id:'probe',incentive:0,interaction:1,peerDisclosure:'LAGGED_PEER_COUNT',settlement:'ALL_ACTORS_PARTICIPATE',allocation:'JOINT_ALL_OR_NONE',transfer:'DECLARED_FIXED_INCENTIVE'},
  {id:'withheld',incentive:1,interaction:1,peerDisclosure:'LAGGED_PEER_COUNT',settlement:'ALL_ACTORS_PARTICIPATE',allocation:'JOINT_ALL_OR_NONE',transfer:'DECLARED_FIXED_INCENTIVE'},
  {id:'undisclosed',incentive:1,interaction:1,peerDisclosure:'NONE',settlement:'ALL_ACTORS_PARTICIPATE',allocation:'JOINT_ALL_OR_NONE',transfer:'DECLARED_FIXED_INCENTIVE'}];
 const episode=(id:string,ruleId:string,outsideA:number,outsideB:number,initialA:0|1,initialB:0|1,common=0):StrategicResponseEpisode=>{
  const rule=rules.find(r=>r.id===ruleId)!;
  return {id,origin:'SIMULATED',assignment:rule.interaction?'PERMITTED_RANDOMIZED':'INCUMBENT_OBSERVATIONAL',execution:'OBSERVED',
   observedAt:new Date(Date.now()-60000).toISOString(),initial:{lender:initialA,capital:initialB},
   rounds:[{ruleId,outsideOptions:{lender:outsideA,capital:outsideB},commonSignal:common,choices:{
    lender:observed(rule.incentive,outsideA,initialB,rule.interaction,common),
    capital:observed(rule.incentive,outsideB,initialA,rule.interaction,common)}}]};
 };
 const training:StrategicResponseEpisode[]=[];
 for(let r=0;r<4;r++)for(let a=0;a<4;a++)for(let b=0;b<4;b++){
  const i=training.length;training.push(episode('train'+i,'inc'+r,a,b,i%2 as 0|1,Math.floor(i/2)%2 as 0|1));
 }
 if(informative)training.push(episode('executed_probe','probe',2,1,1,1));
 const holdout=Array.from({length:20},(_,i)=>episode('holdout'+i,'inc'+i%4,(i+2)%5,(i+3)%5,i%2 as 0|1,(i+1)%2 as 0|1,i%2?1:-1));
 return {schema:'finnor.strategic-response-problem.v1',actors:[
  {id:'lender',role:'LENDER',privateInformation:'OWN_OUTSIDE_OPTION_AND_OWN_PREVIOUS_CHOICE',outcomeVisibility:'PUBLIC'},
  {id:'capital',role:'CAPITAL_PROVIDER',privateInformation:'OWN_OUTSIDE_OPTION_AND_OWN_PREVIOUS_CHOICE',outcomeVisibility:'PUBLIC'}],
  rules,training,holdout,assumptions:{sequentialExogeneity:true,completeActorInformation:true,stablePreferences:true},
  transport:{status:'CONDITIONAL',contexts:['firm_financing'],outsideOptionRange:[0,8],commonSignalRange:[-2,2],
   validUntil:new Date(Date.now()+3600000).toISOString(),omittedModelGap:'UNKNOWN'},
  payoff:{unit:'USD',currency:'USD',scale:'1',entityRoot:root,accountingBasis:'GROSS_JOINT_PAYOFF_BEFORE_ACTION_COSTS',jointPayoff:'20'}};
}
export async function bindCanonicalInputs(admin:any,tenant:string,principal:string,root:any,problem:StrategicResponseProblem,label:string,workId?:string){
 const source=await createEvidenceSource(tenant,{sourceKey:'y2:'+label+':'+randomUUID(),sourceType:'manual',title:'Public own-firm response evidence '+label}),
  snapshot={worldRoot:root,strategicResponseProblem:problem,protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',externalEffects:false,
   executedSyntheticExperimentIds:problem.training.concat(problem.holdout).filter(e=>e.origin==='SIMULATED'&&e.assignment==='PERMITTED_RANDOMIZED'&&e.execution==='OBSERVED').map(e=>e.id),
   qualification:'PUBLIC_SYNTHETIC_FIXTURE_NOT_PROTECTED_OR_FIELD_EVIDENCE'};
 const version=await withTenant(tenant,db=>appendEvidenceVersionTx(db,tenant,source.id,{content:JSON.stringify(problem),snapshot,asOf:new Date()}));
 const contentDigest=(await admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,version.versionId])).rows[0].content_hash;
 const work=workId?{workId}:await receiveWork({tenantId:tenant,userId:principal,channel:'console',instruction:'Own-firm finite financing response '+label,
  idempotencyKey:randomUUID(),entityAttachments:[{...root,source:'Y2:public-development'}]});
 return {sourceId:source.id,versionId:version.versionId,snapshot,work,request:{schema:'finnor.strategic-response-request.v1',root,workId:work.workId,
  evidence:{sourceId:source.id,versionId:version.versionId,contentDigest},problem,idempotencyKey:randomUUID()}};
}
export function oracleQuery(periods=1):StrategicForecastRequest{
 return {context:'firm_financing',ruleIds:Array(periods).fill('withheld'),initial:{lender:1,capital:1},
  jointPrivatePaths:[{id:'jointOutside',outsideOptions:{lender:Array(periods).fill(3),capital:Array(periods).fill(2)}}],
  sharedSignalPaths:[{id:'sharedCalm',values:Array(periods).fill(0)}]};
}
export function decisionInput(view:any,tenant:string,principal:string,periods=1){
 const query={...oracleQuery(periods),ruleIds:Array(periods).fill('inc2')},now=new Date().toISOString(),
  horizon={startAt:new Date(Date.now()-3600000).toISOString(),periodMs:7200000,periods};
 const mandateBody={schema:'finnor.economic-mandate.v1',tenantId:tenant,principalId:principal,episodeId:view.counters.episodeId,knowledgeAt:now,
  validUntil:view.counters.deadlineAt,businessOwnerRef:ownerRef(principal),rightsRef:'S1:current-owner-assertion',utilityRef:ownerRef('joint-payoff'),
  horizon,utility:{unit:'USD',accountingConventionRef:ownerRef('gross-before-costs'),periodTerms:[{variableId:'joint_payoff',unit:'USD',coefficient:1}],
   discountFactors:Array(periods+1).fill(1),terminalTerms:[],tail:{status:'SUPPLIED_COMPLETE_FINITE_HORIZON',terminalLiability:0,ref:ownerRef('tail')}},
  risk:{kind:'HARD_WORST_PATH_UTILITY_FLOOR',minimumUtility:-100},ambiguity:{kind:'ROBUST_FIXED_JOINT_SCENARIOS',authorizationRef:ownerRef('robust-set')},
  resources:{dimensions:[{id:'cash',unit:'USD',capacity:2,totalLimit:2}],couplings:[]},
  search:{maxExpansions:10000,deadlineMs:30000,maxWorlds:512,maxPolicyNodes:10000,maxHumanSeconds:60},
  scoring:{normalization:100,maxRegret:1},authorization:{basis:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED',protectedReceipt:null}};
 const contentDigest=epistemicHash(mandateBody),mandate={...mandateBody,ref:{owner:'BUSINESS_OWNER',id:'mandate:'+contentDigest,version:'economic-mandate-v1',contentDigest}};
 const action=(id:string,kind:string,cost:number,resources:number,exposures:Record<string,number[]>)=>({id,kind,cost,costUnit:'USD',
  resources:{cash:resources},occupancy:{cash:0},occupationPeriods:1,tailLiability:0,earliestPeriod:0,lastPeriod:periods-1,atMostOnce:kind==='INTERVENE',
  exposures,protocolRef:null,informationDelayPeriods:1,humanSeconds:0});
 return {modelId:view.modelId,query,mandate,problem:{schema:'finnor.control-problem.v1',id:'own-firm-financing',episodeId:view.counters.episodeId,
  modelRef:view.artifact.envelope.contentRef,context:query.context,regime:'joint_response',
  baselineExposures:{incentive:Array(periods).fill(1),interaction:Array(periods).fill(0)},
  actions:[action('stop','STOP',0,0,{}),action('wait','WAIT',0,0,{}),
   action('coordinate','INTERVENE',2,2,{incentive:Array(periods).fill(1),interaction:Array(periods).fill(1)})],
  observations:[],obligations:[],validUntil:view.counters.deadlineAt},
  actionRules:[{actionId:'coordinate',ruleIds:Array(periods).fill('withheld')}],idempotencyKey:randomUUID()};
}
