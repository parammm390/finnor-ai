import type {StrategicResponseProblem,StrategicResponseEpisode,StrategicResponseHypothesis,StrategicFittedSet,
 StrategicChoice,StrategicForecastRequest,StrategicPrediction} from '../../../shared-types/src/strategic-response';
import {PROFILE,PROFILE_DIGEST,digest,reference,fail,assertForecast} from './contracts';

/** Deliberately receives no world, peer private type or current peer choice. */
export function actorResponse(model:Pick<StrategicResponseHypothesis,'incentiveWeight'|'peerWeight'|'tie'>,input:{
 bias:number;ownOutsideOption:number;ownPreviousChoice:StrategicChoice;publicPeerCount:number;publicSignal:number;
 publicRule:StrategicResponseProblem['rules'][number]}):StrategicChoice {
 const r=input.publicRule,score=input.bias+model.incentiveWeight*r.incentive-input.ownOutsideOption+input.publicSignal+
  model.peerWeight*r.interaction*(r.peerDisclosure==='LAGGED_PEER_COUNT'?input.publicPeerCount:0);
 if(!Number.isSafeInteger(score))fail('Y2_EXACT_SCORE_DOMAIN');
 return score>0?1:score<0?0:model.tie==='PARTICIPATE'?1:model.tie==='DECLINE'?0:input.ownPreviousChoice;
}
export function jointStep(p:StrategicResponseProblem,m:StrategicResponseHypothesis,previous:Record<string,StrategicChoice>,
 r:StrategicResponseProblem['rules'][number],outside:Record<string,number>,signal:number){
 const total=Object.values(previous).reduce<number>((a,b)=>a+b,0);
 return Object.fromEntries(p.actors.map(a=>[a.id,actorResponse(m,{bias:m.bias[a.id]!,ownOutsideOption:outside[a.id]!,
  ownPreviousChoice:previous[a.id]!,publicPeerCount:total-previous[a.id]!,publicSignal:signal,publicRule:r})])) as Record<string,StrategicChoice>;
}
export function universe(p:StrategicResponseProblem):StrategicResponseHypothesis[]{
 let biases:Record<string,number>[]=[{}];
 for(const actor of p.actors)biases=biases.flatMap(b=>PROFILE.biasGrid.map(v=>({...b,[actor.id]:v})));
 return biases.flatMap(bias=>PROFILE.incentiveWeightGrid.flatMap(incentiveWeight=>PROFILE.sharedPeerWeightGrid.flatMap(peerWeight=>
  PROFILE.tieSelections.map(tie=>{
   const body={bias,incentiveWeight,peerWeight,tie:tie as StrategicResponseHypothesis['tie']};
   return {...body,id:reference('S3','response-hypothesis',body).id};
  })))).sort((a,b)=>a.id.localeCompare(b.id));
}
function eligible(p:StrategicResponseProblem,e:StrategicResponseEpisode){
 return Object.values(p.assumptions).every(Boolean)&&e.execution==='OBSERVED'&&e.origin!=='REQUESTED_EXPERIMENT'&&
  ['INCUMBENT_OBSERVATIONAL','PERMITTED_RANDOMIZED'].includes(e.assignment);
}
export function fitStrategicResponses(p:StrategicResponseProblem,deadlineAt:number):StrategicFittedSet {
 const models=universe(p),training=p.training.filter(e=>eligible(p,e)),rules=new Map(p.rules.map(r=>[r.id,r]));
 let semanticApplications=0;
 const matches=(m:StrategicResponseHypothesis,e:StrategicResponseEpisode)=>{
  let previous=e.initial;
  for(const row of e.rounds){
   semanticApplications+=p.actors.length;
   if(semanticApplications>PROFILE.maximumSemanticApplicationsPerAttempt||Date.now()>=deadlineAt)fail('Y2_FITTING_INCOMPLETE',503);
   const next=jointStep(p,m,previous,rules.get(row.ruleId)!,row.outsideOptions,row.commonSignal);
   if(p.actors.some(a=>next[a.id]!==row.choices[a.id]))return false;
   previous=next;
  }
  return true;
 };
 const hypotheses=models.filter(m=>training.every(e=>matches(m,e)));
 const holdout=p.holdout.filter(e=>e.execution==='OBSERVED'&&e.origin!=='REQUESTED_EXPERIMENT');
 const coveredCompleteJointTrajectories=holdout.filter(e=>hypotheses.some(m=>matches(m,e))).length;
 const assumptions=Object.values(p.assumptions).every(Boolean);
 return {schema:'finnor.strategic-fitted-set.v1',profileDigest:PROFILE_DIGEST,problemDigest:digest(p),
  status:!assumptions||training.length<PROFILE.minimumTrainingEpisodes?'UNIDENTIFIED':hypotheses.length?'FITTED':'NO_SUPPORTED_MODEL',
  hypotheses,universeSize:models.length,semanticApplications,
  training:{eligibleEpisodeIds:training.map(e=>e.id),ignoredEpisodeIds:p.training.filter(e=>!eligible(p,e)).map(e=>e.id)},
  holdout:{episodes:holdout.length,coveredCompleteJointTrajectories,empiricalCalibrationEstablished:false},
  identification:{structuralFamilies:[...new Set(hypotheses.map(m=>m.peerWeight))].sort((a,b)=>a-b),
   behaviorSelections:[...new Set(hypotheses.map(m=>m.tie))].sort(),
   basis:'FINITE_STRUCTURAL_CLASS_CONDITIONAL_ON_DECLARED_ASSUMPTIONS',pointIdentifiedInClass:hypotheses.length===1,fieldIdentificationEstablished:false},
  omittedModelGap:'UNKNOWN',probabilityWeights:null};
}
export function predictStrategicResponses(p:StrategicResponseProblem,model:StrategicFittedSet,q:StrategicForecastRequest):StrategicPrediction{
 assertForecast(p,q);
 if(model.problemDigest!==digest(p)||model.profileDigest!==PROFILE_DIGEST||model.status!=='FITTED'||!model.hypotheses.length)fail('Y2_CURRENT_FITTED_SET_REQUIRED');
 const count=model.hypotheses.length*q.jointPrivatePaths.length*q.sharedSignalPaths.length;
 if(count>PROFILE.maximumWorlds)fail('Y2_COMPLETE_JOINT_WORLD_BOUND',422);
 const rules=new Map(p.rules.map(r=>[r.id,r])),trajectories:StrategicPrediction['trajectories']=[];
 for(const m of model.hypotheses)for(const privatePath of q.jointPrivatePaths)for(const signal of q.sharedSignalPaths){
  let previous=q.initial;
  const rounds=q.ruleIds.map((ruleId,t)=>{
   const outside=Object.fromEntries(p.actors.map(a=>[a.id,privatePath.outsideOptions[a.id]![t]!]));
   const choices=jointStep(p,m,previous,rules.get(ruleId)!,outside,signal.values[t]!);previous=choices;
   return {ruleId,choices,jointPayoff:p.actors.every(a=>choices[a.id]===1)?p.payoff.jointPayoff:'0'};
  });
  trajectories.push({worldId:digest({hypothesisId:m.id,privatePathId:privatePath.id,signalPathId:signal.id}),
   hypothesisId:m.id,privatePathId:privatePath.id,signalPathId:signal.id,rounds});
 }
 return {schema:'finnor.strategic-prediction.v1',modelDigest:digest(model),queryDigest:digest(q),trajectories,
  probabilityWeights:null,qualification:'CONDITIONAL_JOINT_MODEL_SET_NOT_CALIBRATED_FIELD_PREDICTION'};
}
