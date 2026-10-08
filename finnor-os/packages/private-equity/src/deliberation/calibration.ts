import {z} from 'zod';
import {sha} from '../evidence-execution/store';
import {RefSchema,boundedObject} from './contracts';
const word=z.string().min(1).max(128),time=z.string().datetime({offset:true});
const row=z.object({id:word,split:z.enum(['TRAIN','CALIBRATION','HELD_OUT']),company:word,timeBlock:word,sourceLineage:word,checkerLineage:word,ancestry:word,modelLineage:word,regime:word,taskStratum:word,mechanism:word,route:word,featuresKnownAt:time,outcomeKnownAt:time.nullable(),beforeLoss:z.number().finite().min(0).max(1e9),afterLoss:z.number().finite().min(0).max(1e9).nullable(),completed:z.boolean().nullable(),independentlyAccepted:z.boolean().nullable(),elapsedMs:z.number().finite().nonnegative(),nativeAttempts:z.number().int().min(0).max(8),costUSD:z.number().finite().nonnegative().nullable(),oracleRef:RefSchema}).strict();
export const DecisionLossDatasetSchema=z.object({schema:z.literal('finnor.m2.public-decision-loss-dataset.v1'),scope:z.literal('PUBLIC_FINITE_MECHANICS_UNADMITTED'),lossUnit:word,objectiveRef:RefSchema,predeclaredBinFields:z.tuple([z.literal('taskStratum'),z.literal('regime'),z.literal('mechanism'),z.literal('route')]),rows:z.array(row).min(1).max(256)}).strict();
type Row=z.infer<typeof row>;
const bin=(r:Row)=>[r.taskStratum,r.regime,r.mechanism,r.route].join('|');
const mean=(v:number[])=>v.length?v.reduce((s,n)=>s+n,0)/v.length:null;
const quantile=(v:number[],coverage:number)=>{if(!v.length)return null;const ordered=[...v].sort((a,b)=>a-b);return ordered[Math.min(ordered.length-1,Math.ceil((ordered.length+1)*coverage)-1)]!;};
const levels=[.5,.8,.9,.95];
export const ESTIMATOR_CONFIG=Object.freeze({version:'m2-stratified-eventual-loss-v1',binFields:['taskStratum','regime','mechanism','route'],minimumSuppliedLineages:20,coverageLevels:levels,target:'BEFORE_MINUS_EVENTUAL_AFTER_SAME_OBJECTIVE',censoring:'UNKNOWN_REMAINS_UNSCORED_IN_COVERAGE',routingAdmission:'PUBLIC_DIAGNOSTIC_ONLY_NOT_FIELD_OR_PROTECTED'});
/** Fit train means, calibrate untouched residuals, then evaluate held-out once.
 * Supplied oracle refs are traceability, never self-issued independent authority. */
export function calibrateDecisionLoss(raw:unknown){
 boundedObject(raw,1048576);const data=DecisionLossDatasetSchema.parse(raw),splits=['TRAIN','CALIBRATION','HELD_OUT'] as const;
 if(new Set(data.rows.map(r=>r.id)).size!==data.rows.length)throw Error('M2_DUPLICATE_LABEL');
 if(data.rows.some(r=>r.outcomeKnownAt&&Date.parse(r.featuresKnownAt)>=Date.parse(r.outcomeKnownAt)||r.afterLoss!==null&&r.outcomeKnownAt===null||r.independentlyAccepted===true&&r.completed!==true))throw Error('M2_FUTURE_LABEL_OR_ACCEPTANCE_WITHOUT_COMPLETION');
 const leakage:Array<{field:string;rowId:string;otherSplit:string}>=[];
 for(const field of ['company','timeBlock','sourceLineage','checkerLineage','ancestry','modelLineage'] as const){const used=new Map<string,string>();for(const split of splits)for(const r of data.rows.filter(r=>r.split===split)){const prior=used.get(r[field]);if(prior&&prior!==split)leakage.push({field,rowId:r.id,otherSplit:prior});else used.set(r[field],split);}}
 const base={schema:'finnor.m2.calibration-report.v1',version:ESTIMATOR_CONFIG.version,datasetDigest:sha(data),configDigest:sha(ESTIMATOR_CONFIG),objectiveRef:data.objectiveRef,lossUnit:data.lossUnit,scope:data.scope,fieldRoutingAdmitted:false,independentEvaluator:null,sealedEvaluationRef:null};
 if(leakage.length)return {...base,status:'REFUSED_SPLIT_LEAKAGE',leakage,training:null,calibration:null,heldOut:null,bins:[]};
 const train=data.rows.filter(r=>r.split==='TRAIN'),cal=data.rows.filter(r=>r.split==='CALIBRATION'),held=data.rows.filter(r=>r.split==='HELD_OUT');
 const bins=[...new Set(train.map(bin))].sort().map(key=>{
  const rows=train.filter(r=>bin(r)===key),known=rows.filter(r=>r.afterLoss!==null),complete=rows.filter(r=>r.completed!==null),accepted=rows.filter(r=>r.independentlyAccepted!==null);
  const predictedGain=mean(known.map(r=>r.beforeLoss-r.afterLoss!)),completionProbability=mean(complete.map(r=>Number(r.completed))),acceptanceProbability=mean(accepted.map(r=>Number(r.independentlyAccepted)));
  const residuals=cal.filter(r=>bin(r)===key&&r.afterLoss!==null&&predictedGain!==null).map(r=>Math.abs(r.beforeLoss-r.afterLoss!-predictedGain!));
  const lineages=new Set(rows.map(r=>r.ancestry)).size,qualifiedPublicDiagnostic=known.length>=20&&lineages>=ESTIMATOR_CONFIG.minimumSuppliedLineages&&residuals.length>=20;
  const beforeLoss=rows.length&&rows.every(r=>r.beforeLoss===rows[0]!.beforeLoss)?rows[0]!.beforeLoss:null;
  return {key,beforeLoss,population:rows.length,knownLoss:known.length,censored:rows.length-known.length,suppliedLineages:lineages,qualifiedPublicDiagnostic,predictedGain,completionProbability,acceptanceProbability,meanElapsedMs:mean(rows.map(r=>r.elapsedMs)),meanNativeAttempts:mean(rows.map(r=>r.nativeAttempts)),costUSD:rows.every(r=>r.costUSD!==null)?mean(rows.map(r=>r.costUSD!)):null,intervals:levels.map(level=>({level,radius:quantile(residuals,level)})),calibrationPopulation:residuals.length};
 });
 let squared=0,completionSquared=0,acceptedSquared=0,scored=0,completionScored=0,acceptedScored=0,missing=0,unsupported=0;
 const coverage=levels.map(level=>({level,covered:0,scored:0,totalWidth:0}));
 const observations=held.map(r=>{
  const fit=bins.find(b=>b.key===bin(r));if(!fit){unsupported++;return {id:r.id,status:'OUT_OF_DOMAIN',gainPrediction:null};}
  if(r.afterLoss===null){missing++;return {id:r.id,status:'CENSORED_LOSS_RETAINED',gainPrediction:fit.predictedGain,completed:r.completed,independentlyAccepted:r.independentlyAccepted};}
  const actualGain=r.beforeLoss-r.afterLoss;
  if(fit.predictedGain!==null){squared+=(actualGain-fit.predictedGain)**2;scored++;for(const observed of coverage){const radius=fit.intervals.find(i=>i.level===observed.level)?.radius;if(radius!==null&&radius!==undefined){observed.scored++;observed.totalWidth+=2*radius;if(Math.abs(actualGain-fit.predictedGain)<=radius)observed.covered++;}}}
  if(r.completed!==null&&fit.completionProbability!==null){completionSquared+=(Number(r.completed)-fit.completionProbability)**2;completionScored++;}
  if(r.independentlyAccepted!==null&&fit.acceptanceProbability!==null){acceptedSquared+=(Number(r.independentlyAccepted)-fit.acceptanceProbability)**2;acceptedScored++;}
  return {id:r.id,status:fit.qualifiedPublicDiagnostic?'SUPPORTED_PUBLIC_DIAGNOSTIC':'SPARSE_PUBLIC_DIAGNOSTIC',gainPrediction:fit.predictedGain,actualGain,completed:r.completed,independentlyAccepted:r.independentlyAccepted,oracleRef:r.oracleRef,elapsedMs:r.elapsedMs,costUSD:r.costUSD};
 });
 return {...base,status:scored?'PUBLIC_MODEL_RELATIVE_DIAGNOSTIC':'INSUFFICIENT_HELD_OUT_SUPPORT',leakage:[],bins,
  training:{population:train.length},calibration:{population:cal.length},heldOut:{population:held.length,scored,missing,unsupported,failed:held.filter(r=>r.completed===false||r.independentlyAccepted===false).length,decisionLossScore:scored?squared/scored:null,completionBrier:completionScored?completionSquared/completionScored:null,acceptanceBrier:acceptedScored?acceptedSquared/acceptedScored:null,coverage:coverage.map(c=>({...c,observedCoverage:c.scored?c.covered/c.scored:null,meanWidth:c.scored?c.totalWidth/c.scored:null})),observations},
  remaining:['INDEPENDENT_PERMITTED_FIELD_LOSS_LABELS','INDEPENDENT_SEALED_EVALUATOR','OWNER_RISK_AND_MATERIALITY','FIELD_DOMAIN_CALIBRATION','ACTUAL_RECONCILED_PRICES'],qualification:'SUPPLIED_FINITE_REFERENCE_ROWS_AND_LINEAGES_ARE_NOT_INDEPENDENT_FIELD_EVIDENCE'};
}
