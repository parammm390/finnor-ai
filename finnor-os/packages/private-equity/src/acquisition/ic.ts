import type {AcquisitionDecisionRead,AcquisitionResult} from '@finnor/shared-types';
import type {GroundedMemoSection} from '@finnor/artifacts';
import {semanticHash} from '@finnor/underwriting';
import {PeDomainError,type PeMutationContext} from '../types';
import {readAcquisitionDecision,readWorkAcquisitionDecision} from './decision';

export function acquisitionIcRunId(decision:AcquisitionDecisionRead):string|null{
 if(decision.status!=='TESTED'||!decision.result?.completeSearch)return null;
 if(decision.result.maximumBid.qualification==='NO_FEASIBLE_CANDIDATE')return decision.result.baseRunId;
 return decision.result.maximumBid.qualification==='MAXIMUM_IN_DECLARED_FINITE_DOMAIN'?decision.result.maximumBid.runId:null;
}
export interface AcquisitionIcBasis {decision:AcquisitionDecisionRead;result:AcquisitionResult;runId:string;resultDigest:string}
export async function readAcquisitionIcBasis(ctx:PeMutationContext,scope:{workId:string;dealId:string;decisionId?:string;underwritingRunId?:string}):Promise<AcquisitionIcBasis|null>{
 const decision=scope.decisionId?await readAcquisitionDecision(ctx,scope.decisionId):await readWorkAcquisitionDecision(ctx,scope);
 if(!decision)return null;
 if(decision.workId!==scope.workId||decision.request.dealId!==scope.dealId)throw new PeDomainError('ACQUISITION_IC_SCOPE_MISMATCH','The acquisition must belong to this exact Work and Deal');
 const runId=acquisitionIcRunId(decision);
 if(!runId||!decision.result)throw new PeDomainError('ACQUISITION_IC_CHECKED_RESULT_REQUIRED','IC needs the current completely checked acquisition result');
 if(scope.underwritingRunId&&scope.underwritingRunId!==runId)throw new PeDomainError('ACQUISITION_IC_RUN_MISMATCH','IC must pin the acquisition-selected run or its checked base when no bid is feasible');
 return {decision,result:decision.result,runId,resultDigest:semanticHash(decision.result)};
}

/** Copy the complete declared domain; a finite maximum is never an investment approval. */
export function acquisitionIcMemoSections(basis:AcquisitionIcBasis):GroundedMemoSection[]{
 const {decision,result}=basis,request=decision.request,ref='acquisition_decision:'+decision.decisionId;
 const fact=(text:string,runId?:string)=>({text,sourceRefs:[ref,...(runId?['underwriting_run:'+runId]:[])]});
 const groups=(heading:string,paragraphs:GroundedMemoSection['paragraphs']):GroundedMemoSection[]=>{
  const sections:GroundedMemoSection[]=[];for(let i=0;i<paragraphs.length;i+=64)sections.push({heading:heading+(i?' continued':''),paragraphs:paragraphs.slice(i,i+64)});return sections;
 };
 return [{heading:'Checked acquisition decision',paragraphs:[
  fact(`Acquisition decision ${decision.decisionId}; result ${basis.resultDigest}; Work ${decision.workId}. The checked financial basis is Underwriting Run ${basis.runId}.`,basis.runId),
  fact(result.maximumBid.qualification==='NO_FEASIBLE_CANDIDATE'
   ?'NO_FEASIBLE_CANDIDATE: no bid and financing combination in the declared finite domain satisfies every stated constraint. No bid is selected. The checked base is the IC source basis; an infeasible scenario is not a selected investment.'
   :`MAXIMUM_IN_DECLARED_FINITE_DOMAIN: ${result.maximumBid.value} ${request.bidDomain.currency}; financing ${result.maximumBid.financingCaseKey}; exact run ${result.maximumBid.runId}. This maximum applies only to the declared domain and stated model.`),
  fact('This analytical result grants no execution authority and establishes no realized profit. Unresolved material diligence and the committee decision remain separate obligations.'),
 ]},...groups('Declared acquisition constraints',request.constraints.map(c=>fact(`${c.outputNodeId}: ${c.operator} ${c.threshold} ${c.currency??c.unit}.`))),
 ...groups('Declared financing cases',request.financingCases.flatMap(f=>[
  fact(`${f.key}: ${f.name}.`),...f.overrides.map(o=>fact(`${f.key}: ${o.nodeId} = ${o.value}. Declared reason: ${o.reason}`)),
 ])),...groups('Complete bid and financing comparison',result.candidates.flatMap(c=>[
  fact(`Bid ${c.bid} ${request.bidDomain.currency}; financing ${c.financingCaseKey}; ${c.feasible===true?'FEASIBLE':c.feasible===false?'INFEASIBLE':'UNRESOLVED'}; exact run ${c.runId}; result ${c.resultHash}.`,c.runId),
  ...c.failedConstraints.map(key=>fact(`Bid ${c.bid}; financing ${c.financingCaseKey}; failed constraint ${key}.`,c.runId)),
  ...c.unresolved.map(reason=>fact(`Bid ${c.bid}; financing ${c.financingCaseKey}; unresolved ${reason}.`,c.runId)),
 ]))];
}
