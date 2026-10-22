/** A checked interaction is not an S5 allocation method, a protected release,
 * participant consent or execution authority. */
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../../private-equity/src/types';
import {PROFILE_DIGEST,digest,fail,type Y3Ref} from '../../private-equity/src/interaction-synthesis/contracts';
import {reference,same,type ProtocolRow} from '../../private-equity/src/interaction-synthesis/product-contracts';
import {withS5PortfolioTransaction as transaction} from '../../private-equity/src/allocation-store';
import {checkedProtocolTx,developmentOnly,eventTx,principal} from '../../private-equity/src/interaction-synthesis/store';
export interface InteractionAdmission{
 schema:'finnor.s8.interaction-admission.v1';domain:'INTERACTION_PROTOCOL';ref:Y3Ref;
 protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT';tenantId:string;principalId:string;protocolId:string;protocolRef:Y3Ref;
 candidateDigest:string;checkDigest:string;profileDigest:string;runtimeDigest:string;rightsRevision:string;workInputDigest:string;
 admittedAt:string;validUntil:string;protectedAdmission:false;productionActivated:false;executionAuthorityGranted:false;
}
function verify(row:ProtocolRow,admission:InteractionAdmission){
 const {ref,...body}=admission,check=row.artifact!.envelope.independentChecks.find(c=>c.status==='CHECKED')!;
 if(!same(ref,reference('S8','interaction-admission',body))||body.domain!=='INTERACTION_PROTOCOL'||
  body.protectionDomain!=='DISPOSABLE_LOCAL_DEVELOPMENT'||body.tenantId!==row.tenant_id||body.principalId!==row.principal_id||
  body.protocolId!==row.id||!same(body.protocolRef,row.artifact!.envelope.contentRef)||body.profileDigest!==PROFILE_DIGEST||
  body.candidateDigest!==digest(row.candidate)||body.checkDigest!==digest(check)||body.runtimeDigest!==row.runtime.semanticDigest||
  body.rightsRevision!==row.rights_revision||body.workInputDigest!==row.work_input_digest||Date.parse(body.validUntil)<=Date.now()||
  body.protectedAdmission!==false||body.productionActivated!==false||body.executionAuthorityGranted!==false)
  fail('S8_INTERACTION_ADMISSION_BINDING');
}
export async function currentInteractionAdmissionTx(ctx:PeMutationContext,c:PoolClient,protocolId:string){
 developmentOnly();const row=await checkedProtocolTx(ctx,c,protocolId),
  admission=(await c.query<{body:InteractionAdmission}>(`SELECT body FROM finnor_os.s8_interaction_admissions
   WHERE tenant_id=$1 AND principal_id=$2 AND protocol_id=$3`,[ctx.auth.tenantId,principal(ctx),protocolId])).rows[0]?.body;
 if(!admission)fail('S8_INTERACTION_UNADMITTED');
 verify(row,admission);
 if(!same(row.admission,admission))fail('S8_INTERACTION_NATIVE_HEAD_CHANGED');
 return {row,admission};
}
export async function admitInteraction(ctx:PeMutationContext,protocolId:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await checkedProtocolTx(ctx,c,protocolId);
  if(row.admission)return (await currentInteractionAdmissionTx(ctx,c,protocolId)).admission;
  const check=row.artifact!.envelope.independentChecks.find(c=>c.status==='CHECKED')!;
  if(check.nontrivial!==true||!Array.isArray(check.models)||check.models.length!==row.request.problem.models.length)
   fail('S8_NONTRIVIAL_ALL_MODEL_INTERACTION_CHECK_REQUIRED');
  const body:Omit<InteractionAdmission,'ref'>={schema:'finnor.s8.interaction-admission.v1',domain:'INTERACTION_PROTOCOL',
   protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',tenantId:row.tenant_id,principalId:row.principal_id,protocolId:row.id,
   protocolRef:row.artifact!.envelope.contentRef,candidateDigest:digest(row.candidate),checkDigest:digest(check),profileDigest:PROFILE_DIGEST,
   runtimeDigest:row.runtime.semanticDigest,rightsRevision:row.rights_revision,workInputDigest:row.work_input_digest,
   admittedAt:new Date().toISOString(),validUntil:row.deadline_at.toISOString(),protectedAdmission:false,
   productionActivated:false,executionAuthorityGranted:false};
  const admission={...body,ref:reference('S8','interaction-admission',body)};
  await c.query(`INSERT INTO finnor_os.s8_interaction_admissions(tenant_id,admission_id,principal_id,protocol_id,episode_id,body)
   VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[row.tenant_id,admission.ref.id,row.principal_id,row.id,row.episode_id,JSON.stringify(admission)]);
  await c.query('UPDATE finnor_os.y3_requests SET admission=$3::jsonb WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id,JSON.stringify(admission)]);
  await eventTx(c,row,'S8_TYPED_ADMISSION','s8-admission',{admissionRef:admission.ref,domain:admission.domain,
   protectedAdmission:false,productionActivated:false,executionAuthorityGranted:false});
  return admission;
 });
}
