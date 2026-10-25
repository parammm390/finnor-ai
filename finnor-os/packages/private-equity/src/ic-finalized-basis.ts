import type {IcWorkspaceReadModel} from './ic-types';

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

export function hasFinalizedIcBasis(workspace:IcWorkspaceReadModel):boolean{
 const decision=record(workspace.decision),proposal=record(workspace.decisionProposal),proof=record(workspace.decisionProof);
 const receipt=record(proof.decisionReceipt),result=record(receipt.actualResult),authority=record(proof.authorityDecision);
 return workspace.case.state==='DECIDED'&&typeof decision.id==='string'&&decision.id===workspace.case.finalDecisionId
  &&decision.state==='final'&&decision.decisionType==='investment_committee'
  &&proof.icCaseId===workspace.case.id&&proof.decisionId===decision.id&&proof.decisionProposalId===proposal.id
  &&proposal.processStatus==='PROCESS_ELIGIBLE'&&proposal.memoId===workspace.case.currentMemoId
  &&proposal.recommendationId===workspace.case.currentRecommendationId&&proposal.underwritingRunId===workspace.case.primaryUnderwritingRunId
  &&receipt.id===proof.decisionReceiptId&&Number.isFinite(Date.parse(String(receipt.finalizedAt)))&&!receipt.failure
  &&result.icCaseId===workspace.case.id&&result.decisionId===decision.id&&result.decisionProposalId===proposal.id
  &&result.outcome===decision.decision&&result.provenanceHash===proposal.provenanceHash
  &&authority.id===proof.authorityDecisionId&&authority.outcome==='allowed'&&authority.capability==='ic:finalize_decision'
  &&authority.resourceType==='pe_ic_case'&&authority.resourceId===workspace.case.id&&authority.employeeId===proof.finalizedBy;
}
