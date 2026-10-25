import {sql} from 'drizzle-orm';
import {withTenant} from '@finnor/db';
import {getArtifact} from '@finnor/artifacts';
import type {BusinessEffectSet} from '@finnor/shared-types';
import {getIcWorkspace} from './ic-repository';
import {loadDealExecutionGraph,peTransaction} from './repository';
import {readAcquisitionIcBasis} from './acquisition/ic';
import type {PeMutationContext} from './types';

export async function observeIcPreparationCreation(tenantId:string,effect:BusinessEffectSet):Promise<Record<string,unknown>|null>{
 const payload=effect.delta.values;
 const identity=await withTenant(tenantId,async db=>(await db.execute<{id:string;role:PeMutationContext['auth']['role']}>(sql`
  SELECT principal.id::text,principal.role FROM finnor_os.domain_actions action
  JOIN finnor_os.users principal ON principal.tenant_id=action.tenant_id AND principal.id=action.initiated_by
  WHERE action.tenant_id=${tenantId}::uuid AND action.id=${effect.source.domainActionId}::uuid
   AND action.work_id=${effect.source.workId}::uuid AND action.action_type=${effect.operation.name}
   AND action.business_effect_id=${effect.id}::uuid AND principal.status='active'
 `)).rows[0]);
 if(!identity)return null;
 const ctx:PeMutationContext={auth:{tenantId,userId:identity.id,employeeId:identity.id,role:identity.role}};
 const workspace=await getIcWorkspace(ctx,{icCaseId:String(payload.icCaseId)});
 const runId=String(workspace.case.primaryUnderwritingRunId??'');
 const prior=effect.before.find(snapshot=>snapshot.target.type==='pe_ic_case'&&snapshot.target.id===payload.icCaseId)?.values;
 if(workspace.case.dealId!==payload.dealId||!workspace.underwriting?.eligibleUnderPinnedPolicy
  ||workspace.underwriting.run.workId!==effect.source.workId||prior?.primaryUnderwritingRunId!==runId
  ||prior.version!==payload.expectedCaseVersion)return null;

 if(effect.operation.name==='create_ic_memo_draft'){
  const rows=await peTransaction(ctx,async(_db,client)=>(await client.query<{id:string;document_id:string;version_id:string}>(`
   SELECT link.id::text,document.id::text document_id,version.id::text version_id
   FROM finnor_os.documents document
   JOIN finnor_os.document_versions version ON version.tenant_id=document.tenant_id AND version.document_id=document.id
   JOIN finnor_os.pe_document_links link ON link.tenant_id=document.tenant_id AND link.document_id=document.id
   WHERE document.tenant_id=$1 AND document.id=$2 AND document.external_id=$2::text
    AND document.source_system='ic_memo_draft' AND document.archived_at IS NULL
    AND version.source_ref=$2::text AND link.deal_id=$3 AND link.entity_type='pe_ic_case'
    AND link.entity_id=$4 AND link.link_role='source' AND link.archived_at IS NULL LIMIT 2`,
   [tenantId,effect.source.domainActionId,payload.dealId,payload.icCaseId])).rows,{readOnly:true});
  if(rows.length!==1)return null;
  const row=rows[0]!,artifact=await getArtifact(ctx.auth,row.document_id,row.version_id);
  const title=String(payload.title).trim(),expectedTitle=/\.docx$/i.test(title)?title:title+'.docx';
  const text=artifact.ir.nodes.filter(node=>node.kind==='paragraph').map(node=>String(node.data.text)).join('\n');
  if(artifact.ir.kind!=='docx'||artifact.document.title!==expectedTitle||artifact.ir.warnings.length
   ||!text.includes('pe_ic_case:'+payload.icCaseId)||!text.includes('underwriting_run:'+runId))return null;
  const acquisition=await readAcquisitionIcBasis(ctx,{workId:effect.source.workId!,dealId:String(payload.dealId),underwritingRunId:runId});
  if(acquisition&&(!text.includes('acquisition_decision:'+acquisition.decision.decisionId)
   ||!text.includes(acquisition.resultDigest)||!text.includes(acquisition.result.maximumBid.qualification)))return null;
  return {id:row.id,documentId:row.document_id,documentVersionId:row.version_id,semanticHash:artifact.ir.semanticHash,underwritingRunId:runId,
   ...(acquisition?{acquisitionDecisionId:acquisition.decision.decisionId,acquisitionResultDigest:acquisition.resultDigest}:{})};
 }

 if(effect.operation.name!=='prepare_ic_recommendation')return null;
 const recommendation=workspace.currentRecommendation;
 if(!recommendation||recommendation.idempotencyKey!==effect.source.domainActionId||recommendation.authoredBy!==identity.id
  ||recommendation.outcome!=='CONTINUE_DILIGENCE'||recommendation.memoId!==payload.memoId
  ||recommendation.underwritingRunId!==payload.underwritingRunId||workspace.case.currentMemoId!==payload.memoId
  ||runId!==payload.underwritingRunId||workspace.memo?.sourceCompleteness!=='COMPLETE')return null;
 const links=await peTransaction(ctx,async(_db,client)=>(await client.query<{source_kind:string;underwriting_run_id:string;world_entity_type:string;world_entity_id:string;pe_risk_id:string;relationship:string}>(`
  SELECT source_kind,underwriting_run_id::text,world_entity_type,world_entity_id::text,pe_risk_id::text,relationship
  FROM finnor_os.pe_ic_source_links WHERE tenant_id=$1 AND ic_case_id=$2 AND owner_kind='RECOMMENDATION' AND owner_id=$3 LIMIT 101`,
  [tenantId,payload.icCaseId,recommendation.id])).rows,{readOnly:true});
 const graph=await loadDealExecutionGraph(ctx,String(payload.dealId));
 const risks=graph.dealRisks.filter(row=>row.archivedAt==null&&['open','mitigating'].includes(String(row.state))&&['high','critical'].includes(String(row.severity)));
 const findings=graph.findings.filter(row=>row.archivedAt==null&&row.state==='open'&&['material','critical'].includes(String(row.materiality)));
 if(!risks.length&&!findings.length||risks.length+findings.length>80||links.length>100
  ||!links.some(link=>link.source_kind==='UNDERWRITING_RUN'&&link.underwriting_run_id===runId&&link.relationship==='REFERENCES')
  ||risks.some(risk=>!links.some(link=>link.source_kind==='PE_RISK'&&link.pe_risk_id===risk.id&&link.relationship==='REQUIRES'))
  ||findings.some(finding=>!links.some(link=>link.source_kind==='P1_WORLD'&&link.world_entity_type==='pe_finding'&&link.world_entity_id===finding.id&&link.relationship==='REQUIRES')))return null;
 return {id:recommendation.id,icCaseId:payload.icCaseId,memoId:payload.memoId,underwritingRunId:runId,outcome:recommendation.outcome,materialRiskCount:risks.length,materialFindingCount:findings.length};
}
