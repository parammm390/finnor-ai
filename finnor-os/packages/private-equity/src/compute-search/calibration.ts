import {z} from 'zod';
import {sha} from '../evidence-execution/store';

export const MARGINAL_ESTIMATOR_VERSION='p2-marginal-work-v1';
const label=z.object({id:z.string().min(1).max(128),split:z.enum(['TRAIN','HELD_OUT']),company:z.string().min(1).max(128),timeBlock:z.string().min(1).max(80),taskStratum:z.string().min(1).max(80),regime:z.string().min(1).max(80),ancestry:z.string().min(1).max(128),mechanism:z.string().min(1).max(128),route:z.string().min(1).max(128),frontierDigest:z.string().regex(/^[a-f0-9]{64}$/),evidenceDigest:z.string().regex(/^[a-f0-9]{64}$/),observationDigest:z.string().regex(/^[a-f0-9]{64}$/),completed:z.boolean().nullable(),independentlyAccepted:z.boolean().nullable(),elapsedMs:z.number().finite().min(0),costUSD:z.number().finite().min(0).nullable()}).strict();
export const DevelopmentCalibrationSchema=z.object({schema:z.literal('finnor.p2.development-calibration.v1'),source:z.literal('PUBLIC_DEVELOPMENT_MECHANICS'),frozenCodeDigest:z.string().regex(/^[a-f0-9]{64}$/),predeclaredBinFields:z.tuple([z.literal('taskStratum'),z.literal('regime'),z.literal('mechanism'),z.literal('route')]),labels:z.array(label).max(4096)}).strict();
type Label=z.infer<typeof label>;
const bin=(r:Label)=>[r.taskStratum,r.regime,r.mechanism,r.route].join('\0');
function interval(successes:number,n:number){
 if(!n)return null;
 // Predeclared two-sided binomial score interval. This is sampling uncertainty
 // for public completion diagnostics, never a financial loss or stopping gap.
 const z2=1.96**2,p=successes/n,denominator=1+z2/n,center=(p+z2/(2*n))/denominator,half=1.96*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/denominator;
 return {lower:Math.max(0,center-half),upper:Math.min(1,center+half)};
}
/** A replayable development protocol. This adapter accepts public mechanical
 * observations only; their labels cannot qualify owner decision economics.
 * Missing outcomes remain in coverage, and shared ancestry cannot be promoted
 * into independent held-out support. No sealed dataset enters this interface. */
export function calibrateDevelopment(raw:unknown){
 const data=DevelopmentCalibrationSchema.parse(raw),train=data.labels.filter(r=>r.split==='TRAIN'),held=data.labels.filter(r=>r.split==='HELD_OUT');
 if(new Set(data.labels.map(r=>r.id)).size!==data.labels.length)throw Error('P2_CALIBRATION_DUPLICATE_OBSERVATION');
 const leakage=[];
 for(const field of ['company','timeBlock','ancestry'] as const){const used=new Set(train.map(r=>r[field]));for(const row of held)if(used.has(row[field]))leakage.push({field,id:row.id});}
 if(leakage.length)return {schema:'finnor.p2.calibration-report.v1',version:MARGINAL_ESTIMATOR_VERSION,datasetDigest:sha(data),status:'REFUSED_SPLIT_LEAKAGE',leakage,decisionValue:null,productionRoutingAdmitted:false};
 const bins=[...new Set(train.map(bin))].sort().map(key=>{
  const population=train.filter(r=>bin(r)===key),known=population.filter(r=>r.completed!==null),success=known.filter(r=>r.completed).length;
  return {key,population:population.length,known:known.length,missing:population.length-known.length,empiricalCompletion:known.length?success/known.length:null,samplingInterval:interval(success,known.length),independentAncestry:new Set(population.map(r=>r.ancestry)).size,supported:known.length>=20&&new Set(population.map(r=>r.ancestry)).size>=20};
 });
 let squared=0,scored=0,unsupported=0,missing=0;
 const observations=held.map(row=>{const fitted=bins.find(b=>b.key===bin(row));if(row.completed===null){missing++;return {id:row.id,status:'MISSING_OUTCOME',prediction:null};}if(!fitted||fitted.empiricalCompletion===null){unsupported++;return {id:row.id,status:'OUT_OF_DOMAIN',prediction:null};}const prediction=fitted.empiricalCompletion;squared+=(prediction-Number(row.completed))**2;scored++;return {id:row.id,status:fitted.supported?'SUPPORTED_PUBLIC_COMPLETION_ONLY':'SPARSE_PUBLIC_DIAGNOSTIC',prediction,completed:row.completed,independentlyAccepted:row.independentlyAccepted};});
 return {schema:'finnor.p2.calibration-report.v1',version:MARGINAL_ESTIMATOR_VERSION,status:scored?'PUBLIC_DIAGNOSTIC_UNQUALIFIED':'INSUFFICIENT_HELD_OUT_SUPPORT',datasetDigest:sha(data),codeDigest:data.frozenCodeDigest,training:{population:train.length,bins},heldOut:{population:held.length,scored,unsupported,missing,brierScore:scored?squared/scored:null,observations},decisionValue:null,productionRoutingAdmitted:false,remaining:['CURRENT_S4_MARGINAL_AND_DELAY_CONVERSION','INDEPENDENTLY_PERMITTED_DECISION_LOSS_LABELS','INDEPENDENT_FIELD_STRATA_AND_CALIBRATION','CURRENT_DOMAIN_AND_ESTIMATOR_ADMISSION'],qualification:'COMPLETION_DIAGNOSTICS_ARE_NOT_PAYOFF_VERIFICATION_RELIABILITY_OR_ECONOMIC_ROUTING'};
}

/** Versioned P2 interface for the existing scheduler extension path. Later M2
 * can consume this same evidence contract; this does not emit DeliberationPolicy.
 * Current S4 lacks both conversions and no independent label reader exists on
 * this cumulative base, so routing and stop remain a declared heuristic. */
export function marginalWorkProtocol(binding:any){
 return {schema:'finnor.p2.marginal-work-estimate.v1',version:MARGINAL_ESTIMATOR_VERSION,policyRequest:binding.policyRequest,utilityRef:binding.utilityRef,lossUnit:binding.loss.unit,horizon:binding.loss.horizon,status:'UNAVAILABLE_OWNER_CONVERSION_AND_INDEPENDENT_LABELS',expectedLossReduction:null,completionProbability:null,incrementalCostInLossUnits:null,delayOpportunityLoss:null,netValue:null,upper:null,calibratedEstimatorRef:null,trainingDatasetRef:null,heldOutReportRef:null,uncertainty:'UNIDENTIFIED',scope:'EXACT_CURRENT_OWNER_CUT',fallback:'BOUNDED_CHECK_BOTTLENECK_AND_DISTINCT_MECHANISM_HEURISTIC',required:['CURRENT_S4_MARGINAL_LOSS_CONVERSION','CURRENT_S4_DELAY_LOSS_CONVERSION','PERMITTED_INDEPENDENT_DEVELOPMENT_LABEL_READER','FROZEN_STRATIFIED_HELD_OUT_CALIBRATION']};
}
