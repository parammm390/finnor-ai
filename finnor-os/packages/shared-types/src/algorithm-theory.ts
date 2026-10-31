export type UniformDecisionExpression =
  | {op:'FALSE'|'TRUE'|'NEGATIVE'|'NONPOSITIVE'|'POSITIVE'|'NONNEGATIVE'}
  | {op:'NOT';arg:UniformDecisionExpression};
export interface UniformProofPlan {local:number;uniform:number}
export interface UniformNativeReceipt {
  command:string[]; pid:number; exitCode:number|null; signal:string|null;
  wallMs:number; outputBytes:number; stdout:string; stderr:string;
  memoryLimitMiB:2048|null; memoryEnforcement:'LEAN_OPTION'|'DEADLINE_ONLY_REPLAY_MEMORY_UNQUALIFIED'; aggregatePeakBytes:null;
  isolation:'CLOSED_SYNTAX_SANITIZED_ENV_PROCESS_GROUP_NOT_OS_SANDBOX'|'DARWIN_SEATBELT_DENY_NETWORK_SCOPED_FILESYSTEM';
  sandboxPolicyDigest?:string;
  memorySample?:{scope:'CALLER_PROCESS_AND_DESCENDANTS_NOT_FULL_EPISODE';intervalMs:250;samples:number;failures:number;
   peakResidentSumBytes:number|null;observedLimitBytes:17179869184;hardEnforcement:false};
  supervision?:'INDEPENDENT_IPC_DEADLINE_GUARDIAN';guardianPid?:number;childCloseObserved?:true;
}
export interface UniformKernelReceipt {
  schema:'finnor.y5.kernel-check.v1'; exactType:true; kernelReplay:true;
  theorem:'Y5.uniform'; specificationDigest:string; sourceDigest:string;
  proofObjectDigest:string; runtimeDigest:string; importInventoryDigest:string;
  axioms:string[]; trustPolicyApproval:'NOT_ESTABLISHED';
  governance:'LOCAL_SEPARATE_PROCESS_NOT_PROTECTED_CUSTODY';
  native:UniformNativeReceipt[];
}
export interface UniformSearchAttempt {
  expression:UniformDecisionExpression; stage:'DEVELOPMENT'|'LOCAL_LEMMA'|'UNIFORM_PROOF';
  status:'REFUTED'|'REJECTED'|'PROVED'; counterexample?:unknown;
  proofPlan?:UniformProofPlan; native?:UniformNativeReceipt;
}
export interface AlgorithmTheoryCapsule {
  schema:'finnor.algorithm-theory-capsule.v1'; kind:'AlgorithmTheoryCapsule';
  digest:string;
  specification:{id:'INTEGER_ADDITIVE_BINARY_BOX_V1';source:string;digest:string;
    acceptance:'EXISTING_S5_SEMANTICS_DEVELOPMENT_REFINEMENT_NOT_PROTECTED_ACCEPTANCE'};
  structure:{hypothesis:'ADDITIVE_BOX_WITH_DOMINATING_SCENARIO';lemma:'Y5.discovered_lemma';
    nonempty:'EVERY_FINITE_INTEGER_LIST_HAS_ALL_FALSE_FEASIBLE_WITNESS';
    origin:'RUNTIME_EXPRESSION_AND_PROOF_SEARCH';newProtectedStructure:false};
  expression:UniformDecisionExpression; proofPlan:UniformProofPlan;
  algorithmSource:string; sourceDigest:string; proofObject:string; proofObjectDigest:string;
  theorem:{name:'Y5.uniform';statement:string;mathematicalSizes:'ALL_FINITE_LIST_LENGTHS';
    termination:'LEAN_STRUCTURAL_RECURSION';quality:'EXACT_MAXIMUM_WITH_FREE_ZERO_OMITTED';
    costModel:'ONE_COORDINATE_STEP_PER_ITEM_EXACT_INTEGER_PREDICATE_AS_PRIMITIVE';
    bitOrWallTimeBound:false};
  checker:UniformKernelReceipt;
  runtime:{version:'4.34.1';archiveDigest:string;inventoryDigest:string;identityDigest:string;
    profile:'NATIVE_DARWIN_ARM64_LEAN_INTERPRETER';maximumDecisions:128;maximumIntegerDigits:512};
  reuse:{definitions:true;genericTactics:true;successfulSuppliedFamilyProof:false;
    discoveryCredit:'PUBLIC_DEVELOPMENT_ONLY_NOT_PROTECTED_DISCOVERY'};
  search:{attempts:UniformSearchAttempt[];wallMs:number;completeMoney:null;completeHumanSeconds:null;aggregatePeakBytes:null};
  admission:{status:'UNADMITTED';protectedAdmission:false;productionActive:false;executionAuthorityGranted:false};
}
