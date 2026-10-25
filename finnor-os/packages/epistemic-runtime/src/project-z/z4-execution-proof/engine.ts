import {BACKEND,COMPILER,PROFILE,artifactSchema,assertStatement,canonical,fail,sha,validateRequest,type ExactRequest,type ProofArtifact,type Statement} from './contracts';
import {checkCorrespondence} from './correspondence';
import {originalExecution} from './original';
import {runNative,type NativeReceipt} from './native';
export type ExecutionLimits=Parameters<typeof runNative>[2];
export interface ProofProduction {statement:Statement;artifact:ProofArtifact;meters:Record<string,unknown>}
export interface CheckedExecution {
 schema:'finnor.z4.checked-execution.v2';requestDigest:string;statement:Statement;artifact:ProofArtifact;
 correspondence:ReturnType<typeof checkCorrespondence>;
 verificationMode:'ORIGINAL_RELATION_AND_INPUT_COMMITMENT_THEN_PINNED_PROOF';originalExecutionReplayed:false;
 inputBinding:{source:'INDEPENDENT_ORIGINAL_REQUEST';inputCommitment:string;inputRows:number;fullInputPass:true};
 verifier:NativeReceipt<{status:string;statementDigest:string;planHash:string;parameterHash:string;verifyMs:number;proofBytes:number;executionAuthorityGranted:false;securityAdmission:string}>;
 processes:NativeReceipt[];executionAuthorityGranted:false;securityAdmission:'NOT_RUN';protectedAdmission:'NOT_RUN';
}
export async function produceExecutionProof(raw:unknown,limits:ExecutionLimits){
 const request=validateRequest(raw),original=originalExecution(request);
 const plan=await runNative('plan',request,limits),correspondence=checkCorrespondence(request.program,request.binding,plan.data);
 const production=await runNative<ProofProduction>('prove',request,limits);
 const checked=await checkExecutionProof(request,production.data,limits);
 if(canonical(checked.statement.finalState)!==canonical(original.finalState))fail('Z4_ORIGINAL_STATEMENT_MISMATCH');
 return {...checked,referenceAudit:original,processes:[plan,production,...checked.processes]};
}
/** Verify the original relation and input binding, never its execution trace.
 * A claimed output is accepted only by the separate pinned native verifier. */
export async function checkExecutionProof(raw:unknown,candidate:unknown,limits:ExecutionLimits):Promise<CheckedExecution>{
 const r:ExactRequest=validateRequest(raw),c=candidate as ProofProduction;
 if(!c||typeof c!=='object')fail('Z4_PROOF_CANDIDATE_REQUIRED');
 const statement=assertStatement(c.statement),artifact=artifactSchema.parse(c.artifact);
 const plan=await runNative('plan',r,limits);
 const correspondence=checkCorrespondence(r.program,r.binding,plan.data);
 const commitment=await runNative<{inputCommitment:string}>('commit',r,limits);
 const expected:Statement={profile:PROFILE,backend:BACKEND,compiler:COMPILER,program:r.program,binding:r.binding,
  initial:r.initial,finalState:statement.finalState,steps:r.inputs.length,inputCommitment:commitment.data.inputCommitment};
 if(canonical(statement)!==canonical(expected))fail('Z4_ORIGINAL_STATEMENT_MISMATCH');
 if(artifact.planHash!==correspondence.planHash)fail('Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED');
 const verifier=await runNative<CheckedExecution['verifier']['data']>('verify',{statement:expected,artifact},limits);
 if(verifier.data.status!=='VERIFIED_COMPUTATION_ONLY'||verifier.data.statementDigest!==sha(expected)
  ||verifier.data.planHash!==correspondence.planHash||verifier.data.parameterHash!==artifact.parameterHash
  ||verifier.data.executionAuthorityGranted!==false)fail('Z4_INDEPENDENT_VERIFIER_BINDING');
 return {schema:'finnor.z4.checked-execution.v2',requestDigest:sha(r),statement:expected,artifact,correspondence,verifier,
  verificationMode:'ORIGINAL_RELATION_AND_INPUT_COMMITMENT_THEN_PINNED_PROOF',originalExecutionReplayed:false,
  inputBinding:{source:'INDEPENDENT_ORIGINAL_REQUEST',inputCommitment:commitment.data.inputCommitment,inputRows:r.inputs.length,fullInputPass:true},
  processes:[plan,commitment,verifier],executionAuthorityGranted:false,securityAdmission:'NOT_RUN',protectedAdmission:'NOT_RUN'};
}
