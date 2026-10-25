import {BACKEND,COMPILER,PROFILE,artifactSchema,assertStatement,canonical,fail,sha,validateRequest,type ExactRequest,type ProofArtifact,type Statement} from './contracts';
import {checkCorrespondence,originalConstraintContract} from './correspondence';
import {originalExecution} from './original';
import {runNative,type NativeReceipt} from './native';
export type ExecutionLimits=Parameters<typeof runNative>[2];
export interface ProofProduction {statement:Statement;artifact:ProofArtifact;meters:Record<string,unknown>}
export interface CheckedExecution {
 schema:'finnor.z4.checked-execution.v1';requestDigest:string;statement:Statement;artifact:ProofArtifact;
 correspondence:ReturnType<typeof checkCorrespondence>;original:ReturnType<typeof originalExecution>;
 verifier:NativeReceipt<{status:string;statementDigest:string;planHash:string;parameterHash:string;verifyMs:number;proofBytes:number;executionAuthorityGranted:false;securityAdmission:string}>;
 processes:NativeReceipt[];executionAuthorityGranted:false;securityAdmission:'NOT_RUN';protectedAdmission:'NOT_RUN';
}
export async function produceExecutionProof(raw:unknown,limits:ExecutionLimits){
 const request=validateRequest(raw),original=originalExecution(request);
 const plan=await runNative('plan',request,limits),correspondence=checkCorrespondence(request.program,request.binding,plan.data);
 const production=await runNative<ProofProduction>('prove',request,limits);
 const checked=await checkExecutionProof(request,production.data,limits);
 return {...checked,processes:[plan,production,...checked.processes]};
}
/** Audit/consumer entry always recomputes original meaning and the complete
 * constraint image. No producer receipt is an independent check. */
export async function checkExecutionProof(raw:unknown,candidate:unknown,limits:ExecutionLimits):Promise<CheckedExecution>{
 const r:ExactRequest=validateRequest(raw),c=candidate as ProofProduction;
 if(!c||typeof c!=='object')fail('Z4_PROOF_CANDIDATE_REQUIRED');
 const statement=assertStatement(c.statement),artifact=artifactSchema.parse(c.artifact);
 const original=originalExecution(r);
 const plan=await runNative('plan',r,limits);
 const correspondence=checkCorrespondence(r.program,r.binding,plan.data);
 const commitment=await runNative<{inputCommitment:string}>('commit',r,limits);
 const expected:Statement={profile:PROFILE,backend:BACKEND,compiler:COMPILER,program:r.program,binding:r.binding,
  initial:r.initial,finalState:original.finalState,steps:r.inputs.length,inputCommitment:commitment.data.inputCommitment};
 if(canonical(statement)!==canonical(expected))fail('Z4_ORIGINAL_STATEMENT_MISMATCH');
 if(artifact.planHash!==sha(originalConstraintContract(r.program,r.binding)))fail('Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED');
 const verifier=await runNative<CheckedExecution['verifier']['data']>('verify',{statement:expected,artifact},limits);
 if(verifier.data.status!=='VERIFIED_COMPUTATION_ONLY'||verifier.data.statementDigest!==sha(expected)
  ||verifier.data.planHash!==correspondence.planHash||verifier.data.parameterHash!==artifact.parameterHash
  ||verifier.data.executionAuthorityGranted!==false)fail('Z4_INDEPENDENT_VERIFIER_BINDING');
 return {schema:'finnor.z4.checked-execution.v1',requestDigest:sha(r),statement:expected,artifact,correspondence,original,verifier,
  processes:[plan,commitment,verifier],executionAuthorityGranted:false,securityAdmission:'NOT_RUN',protectedAdmission:'NOT_RUN'};
}
