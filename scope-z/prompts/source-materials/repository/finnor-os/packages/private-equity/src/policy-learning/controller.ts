import {CheckpointBodySchema,CheckpointSchema,FeaturesSchema,SampleSchema,FEATURE_ORDER,CONTROLLER_CLASSES,X5_LIMITS,sha,fail,type Checkpoint,type StructuralSample} from './contracts';

export const TRAINING_CONFIGURATION=Object.freeze({
 algorithm:'FULL_BATCH_SOFTMAX_CROSS_ENTROPY_GRADIENT_DESCENT',epochs:600,learningRate:0.4,l2:0.0001,
 ordering:'CANONICAL_EVIDENCE_AND_STATE_ORDER',seed:'ZERO_INITIALIZATION_NO_RANDOMNESS',tieBreak:'FIRST_CLASS',precision:'IEEE754_BINARY64',
});
export function sealCheckpoint(weights:readonly number[]):Checkpoint{
 const body=CheckpointBodySchema.parse({schema:'finnor.x5.controller-checkpoint.v1',architecture:'LINEAR_SOFTMAX_F64_8X4_V1',
  featureOrder:[...FEATURE_ORDER],classes:[...CONTROLLER_CLASSES],weights:[...weights],
  preprocessing:'HOST_OBSERVED_STRUCTURAL_BOOLEANS_NO_IDENTIFIERS_OR_TEXT',precision:'IEEE754_BINARY64',license:'PROJECT_SOURCE_NO_EXTERNAL_WEIGHTS'});
 return {...body,digest:sha(body)};
}
export const originalCheckpoint=()=>sealCheckpoint(Array<number>(32).fill(0));
/** Only validated numeric arrays load. The closure uses these exact immutable
 * coefficients, and returns their recomputed identity with each inference. */
export function loadController(input:unknown,expectedDigest:string){
 const checkpoint=CheckpointSchema.parse(input),{digest,...body}=checkpoint;
 if(digest!==expectedDigest||sha(body)!==expectedDigest)fail('X5_CHECKPOINT_SUBSTITUTION');
 const weights=Object.freeze([...checkpoint.weights]),loadedDigest=sha({...body,weights:[...weights]});
 return Object.freeze({digest:loadedDigest,infer(value:unknown){
  const features=FeaturesSchema.parse(value),logits=CONTROLLER_CLASSES.map((_,c)=>features.reduce((s,x,j)=>s+x*weights[c*8+j]!,0));
  const maximum=Math.max(...logits),exps=logits.map(x=>Math.exp(x-maximum)),sum=exps.reduce((a,b)=>a+b,0),probabilities=exps.map(v=>v/sum);
  const index=probabilities.indexOf(Math.max(...probabilities));
  return {decision:CONTROLLER_CLASSES[index]!,probabilities,loadedCheckpointDigest:loadedDigest,featuresDigest:sha(features)};
 }});
}
export function trainController(raw:unknown,deadline:number){
 const samples=SampleSchema.array().min(8).max(X5_LIMITS.samples).parse(raw);
 const original=originalCheckpoint(),weights=[...original.weights],config=TRAINING_CONFIGURATION;
 const started=performance.now(),losses:number[]=[];
 const loss=(rows:StructuralSample[])=>{
  const model=loadController(sealCheckpoint(weights),sealCheckpoint(weights).digest);
  return rows.reduce((n,s)=>n-Math.log(Math.max(1e-15,model.infer(s.features).probabilities[CONTROLLER_CLASSES.indexOf(s.label)]!)),0)/rows.length;
 };
 losses.push(loss(samples));
 for(let epoch=0;epoch<config.epochs;epoch++){
  if(Date.now()>=deadline)fail('X5_TRAINING_DEADLINE');
  const gradient=Array<number>(32).fill(0);
  for(const sample of samples){
   const logits=CONTROLLER_CLASSES.map((_,c)=>sample.features.reduce((n,x,j)=>n+x*weights[c*8+j]!,0)),maximum=Math.max(...logits);
   const e=logits.map(v=>Math.exp(v-maximum)),sum=e.reduce((a,b)=>a+b,0),target=CONTROLLER_CLASSES.indexOf(sample.label);
   for(let c=0;c<4;c++)for(let j=0;j<8;j++)gradient[c*8+j]=gradient[c*8+j]!+(e[c]!/sum-+(c===target))*sample.features[j]!/samples.length;
  }
  for(let i=0;i<weights.length;i++)weights[i]=weights[i]!-config.learningRate*(gradient[i]!+config.l2*weights[i]!);
 }
 const checkpoint=sealCheckpoint(weights);losses.push(loss(samples));
 if(checkpoint.digest===original.digest||!weights.some((v,i)=>v!==original.weights[i]))fail('X5_NO_PARAMETER_CHANGE');
 return {original,checkpoint,configuration:config,samplesDigest:sha(samples),sampleCount:samples.length,
  evidenceDigests:[...new Set(samples.map(s=>s.evidenceDigest))],losses,trainingWallMs:performance.now()-started,
  parameterChange:{observable:true,changed:weights.filter((v,i)=>v!==original.weights[i]).length,l2Distance:Math.sqrt(weights.reduce((n,v,i)=>n+(v-original.weights[i]!)**2,0))},
  taskLevelAcceptance:'REQUIRES_FRESH_INDEPENDENT_OUTCOMES_NOT_LOSS'};
}
