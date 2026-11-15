import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,type ComputeResourceLease} from '@finnor/db';
import type {PeMutationContext} from '../types';
import type {CanonicalAllocationProblem,AllocationCheck} from '../../../shared-types/src/allocation';
import {resolveEnterpriseAllocationProblem,assertEnterpriseAllocationSourceVisibility} from '../enterprise-allocation';
import {produceAllocationCandidate} from '../../../epistemic-runtime/src/allocation-producer';
import {verifyCanonicalAllocation} from '../../../epistemic-runtime/src/allocation-checker';
import {executeUniformAlgorithm} from '../../../epistemic-runtime/src/uniform-algorithms';
import {recognizeUniformAllocation,uniformProblemIdentity,checkUniformAllocationResult} from '../../../epistemic-runtime/src/uniform-algorithms/applicability';
import {ConsumeSchema,diagnosticProfile,digest,fail} from './contracts';
import {uniformSourceRoot} from './source-cut';
import {tx,discoveryTx,currentTx,problemCutTx,capsuleTx,eventTx} from './store';
import {assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
type UniformUseBody=({
 status:'CHECKED';actualMethod:'Y5_SAME_LEAN_DEFINITION';
 result:ReturnType<typeof checkUniformAllocationResult>;execution:Awaited<ReturnType<typeof executeUniformAlgorithm>>;
}|{
 status:'CHECKED_FEASIBLE_ONLY'|'UNKNOWN';actualMethod:'EXISTING_S5_PRODUCER'|'NONE';
 result:{check:AllocationCheck}|null;
})&Record<string,unknown>;
type UniformCompletedUseMetadata={
 completion:'COMPLETE';schema:'finnor.s5.uniform-method-use.v1';semanticOwner:'S5';useId:string;discoveryId:string;
 originalProblem:CanonicalAllocationProblem;applicability:ReturnType<typeof recognizeUniformAllocation>;
 cost:{startedAt:string;originalDeadline:string;wallMs:number;completeMoney:null;completeHumanSeconds:null;aggregatePeakBytes:null;pricingStatus:'UNMETERED_NOT_ZERO';allNativeReceiptsRetained:true};
 protectedAdmission:false;productionActive:false;executionAuthorityGranted:false;reservationCreated:false;s6EffectsCreated:never[];
};
export type UniformCompletedUse=UniformUseBody&UniformCompletedUseMetadata&{digest:string};
export interface UniformInterruptedUse{
 completion:'INCOMPLETE';status:'UNKNOWN';useId:string;discoveryId:string;
 reason:'DURABLE_STARTED_USE_NO_COMPLETION_NO_AUTOMATIC_REEXECUTION';originalDeadline:string;
 automaticReexecution:false;unknownPhysicalCostPossible:true;executionAuthorityGranted:false;
}
export type UniformUseOutcome=UniformCompletedUse|UniformInterruptedUse;
export async function consumeUniformAlgorithm(ctx:PeMutationContext,value:unknown,invocationDeadlineAt=Date.now()+30000,evaluationUseKey?:string):Promise<UniformUseOutcome>{
 const startedAt=Date.now();invocationDeadlineAt=Math.min(invocationDeadlineAt,startedAt+30000);
 diagnosticProfile();const input=ConsumeSchema.parse(value);
 if(input.idempotencyKey.startsWith('independent-evaluation:')&&input.idempotencyKey!==evaluationUseKey)fail('Y5_RESERVED_EVALUATION_USE_KEY',403);
 await tx(ctx,c=>discoveryTx(ctx,c,input.discoveryId));
 const problem=await resolveEnterpriseAllocationProblem(ctx,input.allocation),applicability=recognizeUniformAllocation(problem);
 const prepared=await tx(ctx,async c=>{
  const a=await discoveryTx(ctx,c,input.discoveryId,true);await currentTx(ctx,c,a);
  if(a.status!=='CHECKED')fail('Y5_CHECKED_CAPSULE_REQUIRED');
  const prior=(await c.query('SELECT * FROM finnor_os.y5_uses WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND idempotency_key=$4',[a.tenant_id,a.principal_id,a.id,input.idempotencyKey])).rows[0];
  if(prior){
   if(prior.request_digest!==digest(input))fail('Y5_IDEMPOTENCY_CONFLICT');
   if(prior.body){const {digest:claimed,...body}=prior.body;if(body.completion!=='COMPLETE'||claimed!==prior.content_digest||digest(body)!==claimed)fail('Y5_IMMUTABLE_USE_INTEGRITY');}
   if(prior.body?.originalProblem&&uniformProblemIdentity(prior.body.originalProblem)!==uniformProblemIdentity(problem))fail('Y5_REPLAY_ORIGINAL_INSTANCE_CHANGED');
   const replay:UniformUseOutcome=prior.body?prior.body as UniformCompletedUse:{
    completion:'INCOMPLETE',status:'UNKNOWN',useId:prior.id,discoveryId:a.id,originalDeadline:prior.deadline_at.toISOString(),
    reason:'DURABLE_STARTED_USE_NO_COMPLETION_NO_AUTOMATIC_REEXECUTION',automaticReexecution:false,unknownPhysicalCostPossible:true,executionAuthorityGranted:false};
   return {a,capsule:null,replay};
  }
  if(a.use_count>=a.max_uses)fail('Y5_ORIGINAL_USES_EXHAUSTED');
  const capsule=await capsuleTx(c,a);if(!capsule)fail('Y5_CHECKED_CAPSULE_REQUIRED');
  const id=randomUUID(),deadlineAt=new Date(Math.min(a.deadline_at.getTime(),Date.parse(problem.validUntil),invocationDeadlineAt));
  if(Date.now()>=deadlineAt.getTime())fail('Y5_ORIGINAL_INVOCATION_DEADLINE');
  await c.query("INSERT INTO finnor_os.y5_uses(tenant_id,principal_id,id,discovery_id,idempotency_key,request_digest,request,deadline_at,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'STARTED')",[a.tenant_id,a.principal_id,id,a.id,input.idempotencyKey,digest(input),JSON.stringify(input),deadlineAt]);
  await c.query('UPDATE finnor_os.y5_discoveries SET use_count=use_count+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[a.tenant_id,a.principal_id,a.id]);
  await eventTx(c,a,'use-start:'+id,'USE_STARTED',{useId:id,originalProblemRef:problem.ref,problemIdentity:uniformProblemIdentity(problem),deadlineAt,
   methodDigest:capsule.digest,applicabilityDigest:applicability.digest,originalMandateRef:problem.mandate.ref,completeMoney:null,aggregatePeakBytes:null});
  return {a,capsule,id,deadlineAt,replay:null};
 });
 if(prepared.replay)return prepared.replay;
 const {a,capsule,id,deadlineAt}=prepared;
 if(!id||!capsule||!deadlineAt)fail('Y5_USE_REGISTRATION_REQUIRED');
 let leases:ComputeResourceLease[]=[],body:UniformUseBody,physicalCompletionUnknown=false;
 const current=async()=>tx(ctx,async c=>{const fresh=await discoveryTx(ctx,c,a.id);await currentTx(ctx,c,fresh);return fresh.generation===a.generation&&fresh.status==='CHECKED'&&Date.now()<deadlineAt!.getTime();});
 try{
  if(!await current())fail('Y5_ORIGINAL_INVOCATION_FENCE');
  if(!applicability.applicable){
   if(input.fallback==='NONE')body={status:'UNKNOWN',actualMethod:'NONE',result:null,reason:'UNIFORM_ASSUMPTIONS_NOT_ESTABLISHED',fallbacks:[]};
   else{
    const produced=await produceAllocationCandidate(problem,performance.now()+Math.max(0,deadlineAt!.getTime()-Date.now()));
    const check=produced.selectedPolicyIds?verifyCanonicalAllocation(problem,produced.selectedPolicyIds):null;
    body={status:check?.feasible?'CHECKED_FEASIBLE_ONLY':'UNKNOWN',actualMethod:'EXISTING_S5_PRODUCER',result:check?{check}:null,
     produced,fallbacks:[{from:'Y5_SAME_LEAN_DEFINITION',reason:'UNIFORM_ASSUMPTIONS_NOT_ESTABLISHED',originalDeadlineRetained:true}],uniformOptimalityClaimed:false};
   }
  }else{
   leases=await acquireComputeResourceLeases({tenantId:a.tenant_id,resourceKeys:['native:y5-proof'],requiredResourceKeys:['native:y5-proof'],workloadClass:'HEAVY',ownerId:'y5-use:'+id});
   const heartbeat=async()=>!!await renewComputeResourceLeases(leases)&&current(),root=await uniformSourceRoot();
   const execution=await executeUniformAlgorithm(capsule!,applicability.integerWeights,{deadlineAt:deadlineAt!.getTime(),scratch:join(root,'.y5-scratch','uses',id!),current:heartbeat});
   const result=checkUniformAllocationResult(problem,applicability,execution.selected);
   body={status:'CHECKED',actualMethod:'Y5_SAME_LEAN_DEFINITION',result,execution,fallbacks:[],
    optimalityCertificate:{schema:'finnor.s5.uniform-optimality.v1',semanticOwner:'S5',basis:'KERNEL_CHECKED_UNIFORM_ADDITIVE_V1',
     theoremDigest:capsule!.proofObjectDigest,implementationDigest:capsule!.sourceDigest,checker:execution.checker,
     originalProblemRef:problem.ref,originalProblemIdentity:uniformProblemIdentity(problem),applicabilityDigest:applicability.digest,
     exactLowerBound:result.check.objective,exactUpperBound:result.exactUpperBound,
     scope:'ORIGINAL_SUPPLIED_FINITE_SCENARIO_MODEL_WITH_CHECKED_UNIFORM_STRUCTURAL_ASSUMPTIONS',
     translationBasis:applicability.translationBasis,protectedAdmission:false}};
  }
  const fresh=await resolveEnterpriseAllocationProblem(ctx,input.allocation);
  if(uniformProblemIdentity(fresh)!==uniformProblemIdentity(problem)||!await current())fail('Y5_CONSUMPTION_ORIGINAL_INSTANCE_CHANGED');
 }catch(error){physicalCompletionUnknown=(error as {physicalCompletion?:string}).physicalCompletion==='UNKNOWN';body={status:'UNKNOWN',actualMethod:'NONE',result:null,error:(error as Error).message,
  nativeReceipt:(error as {receipt?:unknown}).receipt??null,physicalCompletionUnknown,automaticReexecution:false,unknownPhysicalCostPossible:true,fallbacks:[]};}
 finally{if(!physicalCompletionUnknown)await releaseComputeResourceLeases(leases,'y5_use_children_closed').catch(()=>undefined);}
 const resultCore:UniformCompletedUseMetadata&UniformUseBody={...body,completion:'COMPLETE',schema:'finnor.s5.uniform-method-use.v1',semanticOwner:'S5',useId:id,discoveryId:a.id,
  originalProblem:problem,applicability,cost:{startedAt:new Date(startedAt).toISOString(),originalDeadline:deadlineAt.toISOString(),wallMs:Date.now()-startedAt,completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,
   pricingStatus:'UNMETERED_NOT_ZERO',allNativeReceiptsRetained:true},protectedAdmission:false,productionActive:false,
  executionAuthorityGranted:false,reservationCreated:false,s6EffectsCreated:[]};
 const resultBody:UniformCompletedUse={...resultCore,digest:digest(resultCore)};
 await tx(ctx,async c=>{
  const fresh=await discoveryTx(ctx,c,a.id,true);
  if(resultBody.status==='CHECKED'||resultBody.status==='CHECKED_FEASIBLE_ONLY'){
   await currentTx(ctx,c,fresh);if(fresh.generation!==a.generation)fail('Y5_USE_PUBLICATION_GENERATION_CHANGED');
  }
  await c.query("UPDATE finnor_os.y5_uses SET status='COMPLETE',body=$4::jsonb,content_digest=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status='STARTED'",[a.tenant_id,a.principal_id,id,JSON.stringify(resultBody),resultBody.digest]);
  await eventTx(c,a,'use-complete:'+id,'USE_COMPLETED',{useId:id,status:resultBody.status,digest:resultBody.digest,actualMethod:resultBody.actualMethod,
   originalProblemIdentity:uniformProblemIdentity(problem),originalDeadline:deadlineAt,completeMoney:null,aggregatePeakBytes:null});
 });
 if(resultBody.status!=='CHECKED'&&resultBody.status!=='CHECKED_FEASIBLE_ONLY')try{
  const sourceCut=(authorityValidUntil?:string|null)=>tx(ctx,async(c,validUntil)=>{
   const fresh=await discoveryTx(ctx,c,a.id);
   const cut=digest(await problemCutTx(ctx,c,{entityType:fresh.root_type,entityId:fresh.root_id},fresh.work_id));
   if(authorityValidUntil)await assertAuthorityTemporalBoundsTx(c,[authorityValidUntil]);
   return {cut,authorityValidUntil:validUntil};
  }),before=await sourceCut();
  await assertEnterpriseAllocationSourceVisibility(ctx,problem);
  if((await sourceCut(before.authorityValidUntil)).cut!==before.cut)fail('Y5_FAILED_USE_SOURCE_PAYLOAD_WITHHELD');
 }catch{fail('Y5_FAILED_USE_SOURCE_PAYLOAD_WITHHELD');}
 return resultBody;
}
