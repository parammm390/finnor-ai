import type {ExperimentRef} from '@finnor/shared-types';
import type {SolverCapsule,SolverRunInputs,SolverRunResult} from '../../../shared-types/src/solver-capsule';
import {R8_VERSION} from '../../../shared-types/src/solver-capsule';
import {synthesizeSolver} from '../../../epistemic-runtime/src/solver-synthesis/producer';
import {assertCoverage} from '../../../epistemic-runtime/src/solver-synthesis/checker';
import {assertLowering} from '../../../epistemic-runtime/src/solver-synthesis/lowering';
import {hash,SPECIFICATION,GRAMMAR} from '../../../epistemic-runtime/src/solver-synthesis/contracts';
import {OWNER_PREDICATE,type SolverProjection} from './projection';

export const solverRef=(kind:string,body:unknown):ExperimentRef=>({owner:'R8',id:kind+':'+hash(body),version:R8_VERSION,contentDigest:hash(body)});
export function validateCapsule(input:unknown):SolverCapsule {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('R8_CAPSULE_SCHEMA');
 const capsule=input as SolverCapsule,{ref,...body}=capsule;
 if(capsule.schema!=='finnor.solver-capsule.v1'||capsule.kind!=='SolverCapsule'||capsule.schemaRevision!==R8_VERSION||
  capsule.profile!==SPECIFICATION.profile||capsule.status!=='COMPLETE'||capsule.checkBasis!=='MODEL_RELATIVE_EXACT'||
  hash(ref)!==hash(solverRef('solver-capsule',body))||capsule.specificationDigest!==hash(SPECIFICATION)||
  capsule.grammarDigest!==hash(GRAMMAR)||capsule.tie!==SPECIFICATION.tie||
  capsule.applicability.predicateDigest!==hash(OWNER_PREDICATE)||capsule.protectedActivation!==false||
  capsule.executionAuthorityGranted!==false||capsule.s8AdmissionRef!==null)throw Error('R8_CAPSULE_CONTENT_OR_DOMAIN_IDENTITY');
 assertLowering(capsule.program,capsule.module);assertCoverage(capsule.receipt);
 if(capsule.receipt.programDigest!==hash(capsule.program)||capsule.receipt.moduleDigest!==capsule.module.compiledDigest||
  capsule.receipt.emittedDigest!==capsule.module.typescript.emittedDigest||
  capsule.receipt.compilerDigest!==hash(capsule.module.typescript.compiler)||capsule.receipt.runtimeDigest!==capsule.runtime.identityDigest||
  !capsule.trials.length||!capsule.counterexamples.length||
  !capsule.trials.some(trial=>trial.status==='ACCEPTED'&&hash(trial.program)===hash(capsule.program))||
  capsule.ownerOutputMapping.length!==3||new Set(capsule.ownerOutputMapping.map(m=>m.originalPolicyRef.id)).size!==3||
  capsule.ownerOutputMapping.some((m,i)=>m.slot!==i)||
  capsule.envelope.producer.codeDigest!==hash(capsule.envelope.producer.sourcePins)||
  capsule.module.runtime.closureDigest!==hash(capsule.semanticSourcePins))throw Error('R8_CAPSULE_RECEIPT_OR_OWNER_BINDING');
 return capsule;
}
export async function runSolverSynthesis(inputs:SolverRunInputs,projection:SolverProjection,
 options:Omit<Parameters<typeof synthesizeSolver>[0],'deadlineAt'>):Promise<SolverRunResult> {
 const envelope=inputs.envelope_inputs;
 if(hash(inputs.problem_ref)!==hash(envelope.problemRef)||hash(projection.problemRef)!==hash(inputs.problem_ref)||
  hash(inputs.existing_work_revision)!==hash(envelope.work)||hash(inputs.domain_profile_ref)!==hash(envelope.domainProfileRef)||
  hash(inputs.budget_grant_ref)!==hash(envelope.budgetGrantRef)||hash(inputs.cancellation_ref)!==hash(envelope.cancellationRef))
  throw Error('R8_COMMON_RUN_ENVELOPE_SUBSTITUTION');
 let result:Awaited<ReturnType<typeof synthesizeSolver>>;
 try{result=await synthesizeSolver({...options,deadlineAt:Date.parse(envelope.originalDeadlineAt)});}
 catch(error){
  const reason=error instanceof Error?error.message:'R8_CHECK_OR_PRODUCER_UNKNOWN';
  return {artifact:null,incumbent:null,status:/SOURCE|CURRENT|CHANGED|CANCEL/.test(reason)?'INVALIDATED':
   /BUDGET|ROUND|INTERRUPTED|DEADLINE/.test(reason)?'INCOMPLETE':'UNKNOWN',
   unresolvedClaims:[{claim:'COMPLETE_ORIGINAL_DOMAIN_AND_CURRENT_EXECUTABLE_IDENTITY',status:'UNKNOWN',reason}],
   resourceReceipts:[{originalDeadlineAt:envelope.originalDeadlineAt,finalPhysicalUsage:'OBSERVE_DURABLE_CHILD_CLOSE_HISTORY',
    usd:null,humanSeconds:null,aggregatePeakMemoryBytes:null}]};
 }
 const gaps:SolverCapsule['gaps']=[
  {claim:'INDEPENDENT_DOMAIN_AND_PROTECTED_S8_INSTALLATION',status:'BLOCKED_EXTERNAL',reason:'Exact immutable owner review and separately approved release/domain receipts are required'},
  {claim:'COMPARATIVE_AND_ECONOMIC_RELEASE',status:'UNKNOWN',reason:'Completed cumulative-X custody, complete billing/human/aggregate-memory meters and independently qualified H2 outcomes are absent'},
 ];
 const {inventory,...runtime}=result.runtime;
 const runtimePin={...runtime,identityDigest:hash(result.runtime),manifestRef:solverRef('scientific-runtime',result.runtime)};
 const body:Omit<SolverCapsule,'ref'>={
  schema:'finnor.solver-capsule.v1',kind:'SolverCapsule',schemaRevision:R8_VERSION,profile:SPECIFICATION.profile,
  status:'COMPLETE',checkBasis:'MODEL_RELATIVE_EXACT',envelope,program:result.program,module:result.module,runtime:runtimePin,
  receipt:result.receipt,semanticSourcePins:result.sourcePins,specificationDigest:hash(SPECIFICATION),grammarDigest:hash(GRAMMAR),tie:SPECIFICATION.tie,
  applicability:{predicateDigest:hash(OWNER_PREDICATE),predicate:'LOSSLESS_CURRENT_S4_S5_THREE_OPTIONAL_INTEGER_PROJECTS',
   excluded:[...OWNER_PREDICATE.excluded],currentProblemDigest:projection.digest,invalidationRefs:envelope.ownerInputs.map(i=>i.ref)},
  ownerOutputMapping:projection.policyRefs.map((ref,slot)=>({slot,originalPolicyRef:ref,demandDigest:projection.demandDigests[slot]!})),
  trials:result.trials,counterexamples:result.counterexamples,resources:[result.resources],
  fallback:{ref:solverRef('original-s5-full-method',{version:'s5-joint-finite-v1',source:'allocation-producer.ts',sourcePins:envelope.producer.sourcePins}),
   basis:'ORIGINAL_S5_CANONICAL_FULL_ROUTE_UNADMITTED',protectedAdmitted:false},
  s8AdmissionRef:null,protectedActivation:false,executionAuthorityGranted:false,gaps,
  monetary:{amount:null,currency:null,unit:'OWNER_WEALTH',valuationDate:null,ownerShare:null,timeBasis:null,discount:null,status:'UNKNOWN',reason:'Model utilities and local runtime intervals are not settled owner wealth or complete prices'},
  lifecycle:[{state:'DEVELOPMENT_VERIFIED',at:new Date().toISOString(),evidenceRef:solverRef('semantic-receipt',result.receipt)}],
 };
 const capsule=validateCapsule({...body,ref:solverRef('solver-capsule',body)});
 return {artifact:capsule,incumbent:capsule,status:'COMPLETE',unresolvedClaims:gaps,resourceReceipts:[result.resources]};
}
