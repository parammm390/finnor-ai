import type { ControlDynamicsAdapter, ControlWorld, InterventionFeature, InterventionModel, S3ModelComputeInvocation } from '@finnor/shared-types';
import { assertInterventionModel, assessInterventionIdentification, InterventionContractError } from './interventions';
import { invokeInterventionBackend } from './intervention-backend';
import { epistemicHash } from './source-precedence';

type Hull={available:boolean;reason?:string;rank:number;center?:number[];basis?:number[][];range?:number[];halfspaces?:number[][]};
type MechanismKernel={mechanismId:string;equations:Array<{variableId:string;features:InterventionFeature[]}>;support:Hull[];scenarios:Array<{id:string;coefficients:number[][];shocks:number[][]}>};
export interface InterventionControlSnapshot {schema:'finnor.s3.control-kernel-snapshot.v1';ref:ControlDynamicsAdapter['ref'];modelRef:InterventionModel['ref'];request:{context:string;regime:string;horizon:number;pathsPerMechanism:number;seed:number};mechanisms:MechanismKernel[];compute:S3ModelComputeInvocation}
function feature(f:InterventionFeature,history:ControlWorld['history'],exposures:Record<string,number>):number {
 const atom=(a:Exclude<InterventionFeature,{kind:'PRODUCT'}>):number=>{
  if(a.kind==='CONSTANT')return 1;if(a.kind==='EXPOSURE'&&a.lag===0)return exposures[a.id]!;
  const row=history.at(-a.lag);return row?(a.kind==='STATE'?row.states:row.exposures)[a.id]!:NaN;
 };
 return f.kind==='PRODUCT'?atom(f.left)*atom(f.right):atom(f);
}
function supported(h:Hull,x:number[]):boolean {
 if(!h.available||!h.center||!h.basis||x.some(v=>!Number.isFinite(v)))return false;
 const delta=x.map((v,i)=>v-h.center![i]!),projected=Array.from({length:h.rank},(_,j)=>delta.reduce((s,v,i)=>s+v*h.basis![i]![j]!,0));
 if(delta.some((v,i)=>Math.abs(v-projected.reduce((s,p,j)=>s+p*h.basis![i]![j]!,0))>1e-8))return false;
 if(h.rank===0)return true;if(h.rank===1)return projected[0]!>=h.range![0]!-1e-8&&projected[0]!<=h.range![1]!+1e-8;
 return h.halfspaces!.every(row=>row.at(-1)!+projected.reduce((s,p,j)=>s+p*row[j]!,0)<=1e-8);
}
/** Executes S3's learned complete joint transition law, with one parameter draw
 * and shared residual block per full scenario. Mechanisms have no weights. */
export async function createInterventionControlAdapter(model:InterventionModel,request:{context:string;regime:string;horizon:number;pathsPerMechanism:number;seed:number},remainingDeadlineMs?:number):Promise<{adapter:ControlDynamicsAdapter|null;compute:S3ModelComputeInvocation|null;reason:string|null;snapshot:InterventionControlSnapshot|null}> {
 assertInterventionModel(model);
 if(!Number.isInteger(request.horizon)||request.horizon<1||request.horizon>model.request.validity.maximumHorizon||!Number.isInteger(request.pathsPerMechanism)||request.pathsPerMechanism<1||request.pathsPerMechanism>64||!Number.isInteger(request.seed)||request.seed<0||request.seed>4294967295)throw new InterventionContractError('INVALID_REQUEST','Unsupported bounded S3 control kernel request');
 if(!model.request.validity.contexts.includes(request.context)||!model.request.validity.regimes.includes(request.regime))return {adapter:null,compute:null,reason:'UNSUPPORTED_CONTEXT_OR_REGIME_TRANSPORT',snapshot:null};
 const identification=assessInterventionIdentification(model);
 if(identification.status!=='CONDITIONALLY_IDENTIFIED')return {adapter:null,compute:null,reason:`UNRESOLVED_IDENTIFICATION:${identification.reasons.join(',')}`,snapshot:null};
 const result=await invokeInterventionBackend({operation:'control-kernel',model,request},{tenantId:model.tenantId,principalId:model.principalId,rightsRefs:model.beliefBindings.map(b=>b.rightsRef),seed:request.seed,...(remainingDeadlineMs===undefined?{}:{timeoutMs:remainingDeadlineMs})});
 if(result.reason||!result.result?.mechanisms)return {adapter:null,compute:result.compute,reason:result.reason??'JOINT_KERNEL_UNAVAILABLE',snapshot:null};
 const mechanisms=result.result.mechanisms as MechanismKernel[];
 if(mechanisms.some(m=>m.support.some(h=>!h.available)))return {adapter:null,compute:result.compute,reason:'S3_JOINT_SUPPORT_GEOMETRY_UNQUALIFIED',snapshot:null};
 const body={schema:'finnor.s3.control-kernel-snapshot.v1' as const,modelRef:model.ref,request,mechanisms,compute:result.compute},digest=epistemicHash(body);
 const snapshot:InterventionControlSnapshot={...body,ref:{owner:'S3',id:`control-kernel:${digest}`,version:'s3-control-kernel-v1',contentDigest:digest}};
 return {adapter:restoreInterventionControlAdapter(model,snapshot),compute:result.compute,reason:null,snapshot};
}
/** Replay consumes the retained exact numerical output, not just a seed or an
 * unversioned backend alias. This grants no protected integrity or admission. */
export function restoreInterventionControlAdapter(model:InterventionModel,snapshot:InterventionControlSnapshot):ControlDynamicsAdapter {
 assertInterventionModel(model);const {ref,...body}=snapshot;
 if(snapshot.schema!=='finnor.s3.control-kernel-snapshot.v1'||ref.owner!=='S3'||ref.version!=='s3-control-kernel-v1'||ref.contentDigest!==epistemicHash(body)||ref.id!==`control-kernel:${ref.contentDigest}`||epistemicHash(snapshot.modelRef)!==epistemicHash(model.ref))throw new InterventionContractError('INVALID_MODEL','S3 joint kernel snapshot commitment differs');
 const {mechanisms}=snapshot;
 const initial=model.history.rows.slice(-3).map(r=>({states:r.states,exposures:r.exposures}));
 const scenarios=new Map(mechanisms.flatMap(m=>m.scenarios.map(s=>[s.id,{m,s}] as const)));
 const adapter:ControlDynamicsAdapter={ref,stateUnits:Object.fromEntries(model.request.stateVariables.map(v=>[v.id,v.unit])),stateRanges:Object.fromEntries(model.request.stateVariables.map(v=>[v.id,v.range])),exposureIds:model.request.exposures.map(e=>e.id),qualification:'S3_LEARNED_BOOTSTRAP_FINITE_SCENARIOS_UNADMITTED',initialWorlds:mechanisms.flatMap(m=>m.scenarios.map(s=>({id:s.id,mechanismId:m.mechanismId,history:structuredClone(initial),supported:true}))),
  advance(world,exposures,period){const entry=scenarios.get(world.id);if(!entry)throw new InterventionContractError('INVALID_MODEL','S3 scenario identity unavailable');const {m,s}=entry,states:Record<string,number>={};let support=world.supported;
   m.equations.forEach((e,j)=>{const x=e.features.map(f=>feature(f,world.history,exposures));support&&=supported(m.support[j]!,x);const value=x.reduce((sum,v,i)=>sum+v*s.coefficients[j]![i]!,0)+s.shocks[period]![j]!;
    if(!Number.isFinite(value))throw new InterventionContractError('INVALID_MODEL','Nonfinite S3 control trajectory');states[e.variableId]=value;const range=adapter.stateRanges![e.variableId]!;support&&=value>=range[0]&&value<=range[1];});
   return {id:world.id,mechanismId:world.mechanismId,history:[...world.history.slice(-2),{states,exposures:{...exposures}}],supported:support};},
  limitations:['Conditional learned joint law; bootstrap scenarios are not posterior samples','Finite scenario search has unknown gap to unsampled dynamics and field identification','No automatic transport, scientific admission or calibrated temporal instrument error','S3 support/roundoff/weak-dependence/range assumptions inherited'],computeRefs:[snapshot.compute.id]};
 return adapter;
}
