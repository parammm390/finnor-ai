import type {CanonicalAllocationProblem,S5ComputeInvocation} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {produceAllocationCandidate} from '../../../epistemic-runtime/src/allocation-producer';
import {verifyCanonicalAllocation} from '../../../epistemic-runtime/src/allocation-checker';
import {certifyAllocationOptimizationAsync} from '../../../epistemic-runtime/src/allocation-verifier';
import {hash} from '../../../epistemic-runtime/src/solver-synthesis/contracts';
import {loadRuntime,sourceIdentity} from '../../../epistemic-runtime/src/solver-synthesis/runtime';
import {checkCounterexample} from '../../../epistemic-runtime/src/solver-synthesis/checker';
import {acquireSolverCapability,recheckSolverCapability} from './s8/consumer';
import {currentSolverRow,readCapsule,record,type SolverRow} from './store';
import {assertSolverOwnersCurrent} from './owners';
import {projectSolverProblem} from './projection';

export interface SolverSelectionOptions {requestId:string;mode:'DIAGNOSTIC';forceNative?:boolean;allowFallback?:boolean}
/** One candidate-production seam used by the real S5 clearing owner and Work's
 * nonconsequential diagnostic. Normal S5 calls retain the original full route.
 * A disposable admission can never reserve or authorize a business action. */
export async function selectEnterpriseAllocationCandidate(ctx:PeMutationContext,problem:CanonicalAllocationProblem,
 deadlineAt:number,options?:SolverSelectionOptions):Promise<Awaited<ReturnType<typeof produceAllocationCandidate>>>{
 if(!options)return produceAllocationCandidate(problem,deadlineAt);
 const epochDeadline=Date.now()+Math.max(0,deadlineAt-performance.now()),start=performance.now(),
  cpuBefore=process.cpuUsage(),rssBefore=process.memoryUsage().rss;let row:SolverRow|undefined;
 try{
  row=await currentSolverRow(ctx,options.requestId);
  if(row.status!=='COMPLETE')throw Error('R8_CURRENT_COMPLETE_CAPSULE_REQUIRED');
  const grant=await import('./api').then(m=>m.originalGrant(ctx,row!));
  const originalDeadline=Math.min(epochDeadline,Date.parse(grant.deadline_at),Date.parse(problem.validUntil));
  if(Date.now()>=originalDeadline)throw Error('R8_ORIGINAL_EPISODE_EXHAUSTED');
  if(options.forceNative)throw Error('R8_EXPLICIT_MATCHED_NATIVE_ROUTE');
  const capsule=await readCapsule(ctx,row);if(!capsule)throw Error('R8_CAPSULE_UNAVAILABLE');
  const current=await assertSolverOwnersCurrent(ctx,row.request,row.binding),projection=projectSolverProblem(problem).projection;
  if(!projection||!row.binding.projection||capsule.applicability.currentProblemDigest!==row.binding.projection.digest||
   hash(projection.input)!==hash(row.binding.projection.input)||
   hash(projection.policyRefs)!==hash(capsule.ownerOutputMapping.map(slot=>slot.originalPolicyRef))||
   hash(projection.demandDigests)!==hash(capsule.ownerOutputMapping.map(slot=>slot.demandDigest)))throw Error('R8_CURRENT_OWNER_DOMAIN_OR_MAPPING_MISMATCH');
  const lease=await acquireSolverCapability({capsule,tenantId:ctx.auth.tenantId,principalId:row.principal_id,
   rightsRef:row.binding.problem.mandate.rightsRef,inputDigest:hash(projection.input),workInputDigest:current.work.inputDigest,deadlineAt:originalDeadline});
  if(!lease)throw Error('R8_SEPARATE_S8_ADMISSION_AND_ACTIVATION_REQUIRED');
  // An absent ordinary admission cannot spend the full runtime inventory check
  // and starve the compatible full fallback. A granted diagnostic lease still
  // cannot execute until every actual runtime/checker byte has been checked.
  const runtime=await loadRuntime();
  if(hash(runtime)!==capsule.runtime.identityDigest||hash(await sourceIdentity())!==hash(capsule.semanticSourcePins))throw Error('R8_CURRENT_EMITTED_RUNTIME_OR_CHECKER_CHANGED');
  const input={coordinates:projection.input,capsule:capsule.ref.contentDigest};
  const answer=await checkCounterexample(capsule.program,capsule.module,projection.input,runtime,originalDeadline);
  const mask=answer.emitted,physical=answer.resource;
  if(!Number.isSafeInteger(mask)||mask<0||mask>7||answer.witness.failures.length||
   answer.witness.steps>capsule.program.bounds.steps)throw Error('R8_ACTUAL_EMITTED_OUTPUT_OR_FUEL_REFUSED');
  const selectedPolicyIds=projection.policyRefs.filter((_,i)=>Boolean(mask!&(1<<i))).map(ref=>ref.id);
  const checked=verifyCanonicalAllocation(problem,selectedPolicyIds);
  if(!checked.feasible)throw Error('R8_CANONICAL_OWNER_REJECTED_EMITTED_CANDIDATE');
  await recheckSolverCapability({tenantId:ctx.auth.tenantId,principalId:row.principal_id,rightsRef:problem.mandate.rightsRef},capsule,lease,originalDeadline);
  await assertSolverOwnersCurrent(ctx,row.request,row.binding);
  const cpu=process.cpuUsage(cpuBefore);
  const compute:S5ComputeInvocation={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S5',
   id:'model-compute:'+hash({capsule:capsule.ref,input,lease,answer,physical}),tenantId:problem.tenantId,principalId:problem.principalId,
   rightsRef:problem.mandate.rightsRef,inputRef:problem.ref,outputRefs:['emitted-output:'+hash(answer)],
   requestedRoute:'R8_SOLVER_CAPSULE',actualRoute:'R8_ACTUAL_EMITTED_BYTES',fallbacks:[],
   backend:{name:'BoundedIntegerProgram/P1 emitted Node',version:capsule.schemaRevision,pythonVersion:runtime.python.version,
    scipyVersion:null,numpyVersion:null,sourceDigests:capsule.semanticSourcePins,deterministicReplayClaimed:false},
   harness:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,configuration:{domain:'s5-joint-finite-v1',
    decisionDeadlineMs:problem.mandate.search.deadlineMs,nodeLimit:problem.mandate.search.maxExpansions,threads:1,
    memoryCeilingBytes:16*1024**3,memoryEnforcement:'STRUCTURAL_LIMITS_AND_MEASURED_USAGE_NO_CONTAINER_LIMIT'}},
   attempts:[{startedAt:new Date(Date.now()-(performance.now()-start)).toISOString(),finishedAt:new Date().toISOString(),status:'COMPLETED_EMITTED_AND_RECHECKED'}],
   usage:{elapsedMs:performance.now()-start,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,rssBeforeBytes:rssBefore,
    rssAfterBytes:process.memoryUsage().rss,backend:{termination:'R8_MODEL_RELATIVE_EXACT',solverLease:lease,physical,
     originalDeadlineAt:new Date(originalDeadline).toISOString(),ordinary:true,protected:false},accountingScope:'PROCESS_AND_CHILD_INTERVAL_NOT_CONTAINER_PEAK'},
   cost:{money:null,pricebookRef:null,status:'LOCAL_COST_UNMETERED',externalCalls:0},admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
  await record(ctx,row,'INVOCATION',compute.id,{compute,mask,selectedPolicyIds,check:checked,protectedExecution:false,reservation:null});
  return {status:'FEASIBLE',selectedPolicyIds,reasons:[],compute,solverUpperBoundEstimate:Number(checked.objective),dualProposal:null};
 }catch(error){
  const reason=error instanceof Error?error.message:'R8_USE_REFUSED';
  if(options.allowFallback===false)throw error;
  // The original full owner route receives only time still available under the
  // accepted Work grant. No grammar timeout grants a new native episode.
  const original=row?await import('./api').then(m=>m.originalGrant(ctx,row!)):null;
  const remaining=original?Math.min(deadlineAt,performance.now()+Date.parse(original.deadline_at)-Date.now()):deadlineAt;
  const native=await produceAllocationCandidate(problem,remaining);
  native.compute.requestedRoute='R8_SOLVER_CAPSULE';native.compute.fallbacks.push(reason);
  native.compute.usage.backend.r8Fallback={reason,actualRoute:native.compute.actualRoute,
   originalDeadlineAt:original?.deadline_at??null,protectedFallbackAdmitted:false};
  if(row)await record(ctx,row,'FALLBACK','native:'+hash(native.compute),{reason,...native,protectedExecution:false,executionAuthorityGranted:false});
  return native;
 }
}
export async function diagnosticSolverSelection(ctx:PeMutationContext,id:string,forceNative=false){
 const row=await currentSolverRow(ctx,id),grant=await import('./api').then(m=>m.originalGrant(ctx,row));
 const current=await assertSolverOwnersCurrent(ctx,row.request,row.binding),start=performance.now();
 const deadlineAt=start+Math.max(0,Math.min(Date.parse(grant.deadline_at)-Date.now(),current.problem.mandate.search.deadlineMs));
 const produced=await selectEnterpriseAllocationCandidate(ctx,current.problem,deadlineAt,{requestId:id,mode:'DIAGNOSTIC',forceNative,allowFallback:true});
 const certified=produced.selectedPolicyIds?await certifyAllocationOptimizationAsync(current.problem,produced.selectedPolicyIds,
  {deadlineAt,searchTermination:String(produced.compute.usage.backend.termination??produced.status),solverUpperBoundEstimate:produced.solverUpperBoundEstimate,dualProposal:produced.dualProposal}):null;
 await assertSolverOwnersCurrent(ctx,row.request,row.binding);
 return {schema:'finnor.r8.diagnostic-selection.v1',requestId:id,status:produced.status,actualRoute:produced.compute.actualRoute,
  candidate:produced.selectedPolicyIds,independentS5:certified,compute:produced.compute,wholeOwnerElapsedMs:performance.now()-start,
  reservation:null,executionAuthorityGranted:false,protectedReceipt:null,qualification:'CURRENT_S4_S5_CHECKED_DISPOSABLE_METHOD_NO_EFFECT_AUTHORITY'};
}
