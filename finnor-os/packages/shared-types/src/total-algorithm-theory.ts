import type {ExperimentRef} from './experiments';
import type {UniformNativeReceipt} from './algorithm-theory';

export type TotalType='INT'|'NAT'|'BOOL'|{product:[TotalType,TotalType]}|{list:TotalType};
export type TotalExpression=
 |{op:'VAR';index:number}
 |{op:'INT'|'NAT';value:string}
 |{op:'BOOL';value:boolean}
 |{op:'ADD'|'SUB'|'MUL'|'MIN'|'MAX'|'LE'|'LT'|'EQ'|'AND'|'OR'|'PAIR'|'CONS';left:TotalExpression;right:TotalExpression}
 |{op:'NOT'|'FIRST'|'SECOND'|'HEAD'|'TAIL'|'LENGTH'|'IS_EMPTY';arg:TotalExpression}
 |{op:'EMPTY';element:TotalType}
 |{op:'IF';condition:TotalExpression;then:TotalExpression;else:TotalExpression};
export interface TotalProgram{
 schema:'finnor.y5.total-program.v2';recursion:'RIGHT_STRUCTURAL_FOLD';
 stateType:TotalType;initial:TotalExpression;step:TotalExpression;result:TotalExpression;
}
export interface TotalFamilyDefinition{
 schema:'finnor.y5.total-family-definition.v2';
 input:'ALL_FINITE_INTEGER_LISTS';output:'MATHEMATICAL_INTEGER';semanticState:'INT';
 safe:TotalExpression;advance:TotalExpression;
 objective:'LEAST_FEASIBLE_INITIAL_STATE';prefixes:'INCLUDING_EMPTY_AND_COMPLETE';
 numericalMeaning:'EXACT_UNBOUNDED_INTEGER';tie:'EQUAL_INTEGER_OUTPUT';
 costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2';
}
export interface TotalSemanticReceipt{
 schema:'finnor.y5.semantic-acceptance.v2';issuerId:string;keyId:string;receiptId:string;
 tenantId:string;definitionDigest:string;policyRevision:string;scope:string;
 acceptedAt:string;validUntil:string;signature:string;
}
export interface TotalWorkSpecification{
 schema:'finnor.y5.work-specification.v2';definition:TotalFamilyDefinition;
 acceptanceReceipt:TotalSemanticReceipt|null;
}
export type TotalSemanticAcceptance=
 |{status:'PUBLIC_DEVELOPMENT';reason:'NO_INDEPENDENT_ACCEPTANCE_RECEIPT';protectedFamilyCredit:false}
 |{status:'PUBLIC_DEVELOPMENT';reason:'DISPOSABLE_POLICY_NOT_INDEPENDENT_ACCEPTANCE';protectedFamilyCredit:false;
   policyDigest:string;receiptDigest:string;validUntil:string}
 |{status:'ACCEPTED';issuerId:string;receiptId:string;scope:string;policyRevision:string;
   policyDigest:string;policyApprovalRef:ExperimentRef;validUntil:string;protectedFamilyCredit:false;
   qualification:'SIGNATURE_UNDER_EXTERNALLY_CONFIGURED_POLICY_NOT_PROTECTED_CAMPAIGN_CUSTODY'};
export interface ResolvedTotalSpecification{
 schema:'finnor.y5.resolved-specification.v2';sourceRef:ExperimentRef;definition:TotalFamilyDefinition;
 definitionDigest:string;acceptance:TotalSemanticAcceptance;
}
export type TotalSpecificationResolution=
 |{status:'ACCEPTED'|'PUBLIC_DEVELOPMENT';specification:ResolvedTotalSpecification}
 |{status:'UNAVAILABLE';reason:'TYPED_OWNER_SPECIFICATION_UNAVAILABLE'|'SEMANTIC_ACCEPTANCE_NOT_ESTABLISHED'};
export type TotalTerm={op:'INITIAL'|'OUTPUT'|'ZERO'}|{op:'INT';value:string};
export type TotalProposition=
 |{op:'TRUE'|'FALSE'}
 |{op:'FEASIBLE'|'SAFE';arg:TotalTerm}
 |{op:'LE'|'LT'|'EQ';left:TotalTerm;right:TotalTerm}
 |{op:'NOT';arg:TotalProposition}
 |{op:'AND'|'OR'|'IMPLIES'|'IFF';left:TotalProposition;right:TotalProposition};
export interface TotalProofPlan{induction:number;uniform:number}
export interface TotalSearchAttempt{
 ordinal:number;stage:'PROGRAM_DEVELOPMENT'|'CONJECTURE_DEVELOPMENT'|'CONJECTURE_PROOF'|'UNIFORM_PROOF';
 programDigest:string;propositionDigest?:string;status:'REFUTED'|'UNPROVED'|'PROVED';
 counterexample?:unknown;native?:UniformNativeReceipt;proofPlan?:TotalProofPlan;sourceDigest?:string;failureCode?:string;
}
export interface TotalKernelReceipt{
 schema:'finnor.y5.total-kernel-check.v2';exactOwnerExpectedType:true;suppliedProofObjectReplayed:true;
 loadBearingLemmaInProof:true;countedDenotationAgreement:true;allSizeOperationBound:true;
 definitionDigest:string;programDigest:string;propositionDigest:string;sourceDigest:string;
 proofObjectDigest:string;interpreterDigest:string;interpreterProofObjectDigest:string;runtimeDigest:string;
 modelSourceCorrespondence:'FROZEN_SOURCE_COMPILED_PIN_REHASHED_AND_REPLAYED';modelSourcePinDigest:string;sharedModelSetupRef:ExperimentRef;
 importInventoryDigest:string;imports:string[];axioms:string[];
 native:UniformNativeReceipt[];independentImplementation:false;protectedCustody:false;trustPolicyApproval:'NOT_ESTABLISHED';
}
export interface TotalAlgorithmTheoryCapsule{
 schema:'finnor.algorithm-theory-capsule.v2';kind:'AlgorithmTheoryCapsule';digest:string;
 specification:ResolvedTotalSpecification;program:TotalProgram;invariant:TotalProposition;proofPlan:TotalProofPlan;
 grammarDigest:string;interpreterSource:string;interpreterDigest:string;interpreterProofObjectDigest:string;
 algorithmSource:string;sourceDigest:string;proofObject:string;proofObjectDigest:string;
 theorem:{name:'Y5Total.uniform';statement:string;domain:'ALL_FINITE_INTEGER_LISTS';
   nonemptyEachSize:true;feasibleWitnessEveryInput:true;quality:'EXACT_LEAST_INITIAL_STATE';
   prefixCorrespondence:true;operationBound:{coefficient:number;constant:number};bitOrWallTimeBound:false};
 checker:TotalKernelReceipt;
 runtime:{version:'4.34.1';archiveDigest:string;inventoryDigest:string;identityDigest:string;
   profile:'NATIVE_DARWIN_ARM64_TOTAL_CLOSED_AST';maximumInputItems:128;maximumIntegerDigits:512};
 origin:{episodeCutDigest:string|null;selectionRule:'ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL'|'PUBLIC_LIBRARY_DEVELOPMENT_INPUTS_NOT_OWNER_CENSUS';
   developmentExamplesDigest:string;newProtectedStructure:false};
 search:{attempts:TotalSearchAttempt[];programsExamined:number;propositionsExamined:number;proofAttempts:number;
   stateTypesExamined:TotalType[];developmentInputs:string[][];
   limits:{maxPrograms:number;maxPropositions:number;maxProofAttempts:number;maxRetainedBytes:number};
   nativePreparation:UniformNativeReceipt[];
   sharedModelSetupRef:ExperimentRef;
   wallMs:number;completeMoney:null;completeHumanSeconds:null;aggregatePeakBytes:null};
 admission:{status:'UNADMITTED';protectedAdmission:false;productionActive:false;executionAuthorityGranted:false};
}
