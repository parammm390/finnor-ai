import {z} from 'zod';
import type {UnderwritingInputSnapshot} from '@finnor/underwriting';
import type {ClosingSpec} from '@finnor/shared-types';
import type {AcquisitionClosingContext} from '../../../shared-types/src/acquisition-closing';
import {PeDomainError,type PeMutationContext} from '../types';
import {peTransaction} from '../repository';
import {getIcWorkspace} from '../ic-repository';
import {hasFinalizedIcBasis} from '../ic-finalized-basis';
import {principal,revisions,sameRevisions} from '../owner-context';
import type {IcWorkspaceReadModel} from '../ic-types';
import {hash,currentFinding} from '../primary-diligence/store';
import {currentDerivation} from '../evidence-execution/store';
import {currentCheckedHarnessProgram} from '../program-synthesis/store';
import {readReviewedAcquisitionRequest} from './reviewed-request';
import {readAcquisitionIcBasis} from './ic';
import {getUnderwritingRun} from '../underwriting-repository';
import {ClosingError} from '../closing/contracts';

export const AcquisitionClosingContextSchema=z.object({workId:z.string().uuid(),icCaseId:z.string().uuid().optional()}).strict();
const unavailable=()=>new PeDomainError('PE_ENTITY_NOT_FOUND','Acquisition closing context is unavailable in the authenticated scope');
const basisDigest=(w:IcWorkspaceReadModel)=>hash({case:w.case,proof:w.decisionProof,conditions:w.conditions,memo:w.memo,runId:w.case.primaryUnderwritingRunId});
export async function readAcquisitionClosingContext(ctx:PeMutationContext,value:unknown):Promise<AcquisitionClosingContext>{
 const input=AcquisitionClosingContextSchema.parse(value);
 const owned=await peTransaction(ctx,async(_db,c)=>(await c.query('SELECT 1 FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND coalesce(current_owner_id,created_by)=$3',[ctx.auth.tenantId,input.workId,principal(ctx)])).rowCount,{readOnly:true});
 if(!owned)throw unavailable();
 const reviewed=await readReviewedAcquisitionRequest(ctx,input.workId);
 const empty:AcquisitionClosingContext={applicable:Boolean(reviewed),workId:input.workId,dealId:reviewed?.request.dealId??null,continuation:null,deadlineAt:null,validUntil:null,expectedSpecDigest:null,limits:null,acquisition:null,cases:[],selected:null,conditions:[],dependencies:[],eligible:false,blockers:[],authorityGranted:false};
 if(!reviewed)return empty;
 const {request}=reviewed;
 const {readClosingWorkContinuation}=await import('../../../orchestration/src/objective-loop');
 const original=await readClosingWorkContinuation({tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId:input.workId,transactionId:request.dealId});
 const acquisition=await readAcquisitionIcBasis(ctx,{workId:input.workId,dealId:request.dealId});
 const cases=await peTransaction(ctx,async(_db,c)=>(await c.query<{id:string;state:string;outcome:string|null}>(
  "SELECT DISTINCT i.id::text,i.state,d.decision outcome FROM finnor_os.work_entity_links l JOIN finnor_os.pe_ic_cases i ON i.tenant_id=l.tenant_id AND i.id=l.entity_id LEFT JOIN finnor_os.pe_decisions d ON d.tenant_id=i.tenant_id AND d.id=i.final_decision_id WHERE l.tenant_id=$1 AND l.work_id=$2 AND l.entity_type='pe_ic_case' AND i.deal_id=$3 AND i.investment_case_id=$4 ORDER BY i.id::text LIMIT 26",
  [ctx.auth.tenantId,input.workId,request.dealId,request.underwriting.investmentCaseId])).rows,{readOnly:true});
 if(cases.length>25)throw Error('ACQUISITION_CLOSING_CASE_BOUND');
 const context:AcquisitionClosingContext={...empty,...original,validUntil:original.deadlineAt,acquisition:acquisition?{decisionId:acquisition.decision.decisionId,runId:acquisition.runId,resultDigest:acquisition.resultDigest}:null,cases};
 if(!acquisition)context.blockers.push('ACQUISITION_IC_CHECKED_RESULT_REQUIRED');
 if(!input.icCaseId){context.blockers.push('ACQUISITION_IC_CASE_SELECTION_REQUIRED');return context;}
 if(!cases.some(c=>c.id===input.icCaseId))throw unavailable();
 const workspace=await getIcWorkspace(ctx,{icCaseId:input.icCaseId});
 if(!hasFinalizedIcBasis(workspace))context.blockers.push('ACQUISITION_IC_FINALIZED_PROOF_REQUIRED');
 if(!['INVEST','INVEST_WITH_CONDITIONS'].includes(String(workspace.decision?.decision)))context.blockers.push('ACQUISITION_IC_INVESTMENT_DECISION_REQUIRED');
 if(workspace.case.primaryUnderwritingRunId!==acquisition?.runId||workspace.underwriting?.run.workId!==input.workId||!workspace.underwriting?.eligibleUnderPinnedPolicy)context.blockers.push('ACQUISITION_IC_APPROVED_RUN_MISMATCH');
 if(!workspace.memo||workspace.memo.sourceCompleteness!=='COMPLETE'||!workspace.artifacts.memo||workspace.artifacts.memo.parseStatus!=='parsed'||workspace.readiness.blockers.length)context.blockers.push('ACQUISITION_IC_REVIEW_BASIS_REQUIRED');
 const discharged=new Set<string>();
 for(const condition of workspace.conditions.filter(c=>c.required===true)){
  if(condition.state==='FAILED'){context.blockers.push('ACQUISITION_IC_REQUIRED_CONDITION_FAILED:'+condition.id);continue;}
  if(condition.state==='SATISFIED'&&condition.sources.some(s=>s.relationship==='VERIFIES')){discharged.add(String(condition.id));continue;}
  if(condition.state==='WAIVED'){
   const valid=await peTransaction(ctx,async(_db,c)=>(await c.query(
    "SELECT 1 FROM finnor_os.decision_receipts r JOIN finnor_os.authority_decisions a ON a.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.id=$2 AND a.id=$3 AND r.finalized_at IS NOT NULL AND r.failure IS NULL AND r.proposed_action->>'icCaseId'=$4 AND r.actual_result->>'conditionId'=$5 AND r.actual_result->>'state'='WAIVED' AND a.outcome='allowed' AND a.capability='ic:waive_condition' AND a.resource_id=$4::uuid",
    [ctx.auth.tenantId,condition.waiverDecisionReceiptId,condition.waiverAuthorityDecisionId,input.icCaseId,condition.id])).rowCount,{readOnly:true});
   if(valid){discharged.add(String(condition.id));continue;}
  }
  if(condition.conditionType!=='MONITORING')context.blockers.push('ACQUISITION_IC_REQUIRED_CONDITION_UNRESOLVED:'+condition.id);
 }
 context.conditions=workspace.conditions.map(c=>({id:String(c.id),revision:Number(c.version),type:String(c.conditionType),state:String(c.state),required:c.required===true,discharged:discharged.has(String(c.id)),title:String(c.title),ownerEmployeeId:typeof c.ownerEmployeeId==='string'?c.ownerEmployeeId:null,workId:typeof c.workId==='string'?c.workId:null,dueAt:typeof c.dueAt==='string'?c.dueAt:null,contentDigest:hash(c)}));
 context.selected={icCaseId:input.icCaseId,state:String(workspace.case.state),outcome:typeof workspace.decision?.decision==='string'?workspace.decision.decision:null,decisionId:typeof workspace.decision?.id==='string'?workspace.decision.id:null,decisionReceiptId:typeof workspace.decisionProof?.decisionReceiptId==='string'?workspace.decisionProof.decisionReceiptId:null,basisDigest:basisDigest(workspace)};
 const keys=new Set(['ic-approval:'+input.icCaseId,'canonical:pe_decision:'+workspace.case.finalDecisionId,'document:'+workspace.memo?.documentId,...workspace.conditions.filter(c=>c.conditionType!=='MONITORING').map(c=>'canonical:pe_ic_condition:'+c.id)]);
 if(workspace.underwriting&&acquisition&&workspace.case.primaryUnderwritingRunId===acquisition.runId){
  const snapshot=(await getUnderwritingRun(ctx,acquisition.runId)).inputSnapshot as UnderwritingInputSnapshot;
  if(!snapshot?.values)throw Error('ACQUISITION_IC_INPUT_SNAPSHOT_REQUIRED');
  const refs=new Map(Object.values(snapshot.values).flatMap(v=>v.provenance).map(r=>[r.kind+':'+r.id,r]));
  for(const ref of refs.values()){
   if(ref.kind==='primary_finding'){
    const {finding}=await currentFinding(ctx,ref.id);for(const d of finding.invalidationDependencies)keys.add(d.key);
    context.validUntil=new Date(Math.min(Date.parse(context.validUntil!),Date.parse(finding.freshnessAndReacquisitionConditions.expiresAt))).toISOString();
   }
   if(ref.kind==='evidence_derivation')for(const d of (await currentDerivation(ctx,ref.id)).invalidationKeys)keys.add(d.key);
   if(ref.kind==='harness_program')for(const d of (await currentCheckedHarnessProgram(ctx,ref.id)).program.dependencies)keys.add(d.key);
  }
 }
 if(keys.size>1024)throw Error('ACQUISITION_CLOSING_DEPENDENCY_BOUND');
 const pins=await revisions(ctx,[...keys]),currentAcquisition=await readAcquisitionIcBasis(ctx,{workId:input.workId,dealId:request.dealId}),currentWorkspace=await getIcWorkspace(ctx,{icCaseId:input.icCaseId});
 if(currentAcquisition?.resultDigest!==acquisition?.resultDigest||basisDigest(currentWorkspace)!==context.selected.basisDigest||!sameRevisions(pins,await revisions(ctx,[...keys])))throw Error('ACQUISITION_CLOSING_SOURCE_CHANGED');
 context.dependencies=pins.map(({key,revision})=>({key,revision}));context.eligible=context.blockers.length===0;
 return context;
}

export async function requireAcquisitionClosingBasis(ctx:PeMutationContext,input:{workId:string;icCaseId?:string;spec:ClosingSpec}){
 const context=await readAcquisitionClosingContext(ctx,{workId:input.workId,...(input.icCaseId?{icCaseId:input.icCaseId}:{})});
 if(!context.applicable)return null;
 if(context.dealId!==input.spec.transactionId)throw new ClosingError('ACQUISITION_CLOSING_DEAL_MISMATCH',409);
 if(!context.eligible)throw new ClosingError(context.blockers[0]??'ACQUISITION_IC_APPROVAL_REQUIRED',409);
 for(const condition of context.conditions.filter(c=>c.required&&!c.discharged&&c.type==='MONITORING')){
  const duty=input.spec.continuingDuties.find(d=>d.obligationRef?.owner==='@finnor/private-equity'&&d.obligationRef.kind==='pe_ic_condition'&&d.obligationRef.id===condition.id&&d.obligationRef.version===String(condition.revision)&&d.obligationRef.contentDigest===condition.contentDigest);
  if(!duty||duty.ownerPrincipalId!==condition.ownerEmployeeId||condition.dueAt&&Date.parse(duty.dueAt)>Date.parse(condition.dueAt))throw new ClosingError('ACQUISITION_IC_MONITORING_HANDOFF_REQUIRED',409);
 }
 return context;
}
