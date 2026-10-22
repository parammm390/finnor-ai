/** A typed sibling, not a widening of financial, X4 or Y1 admission. */
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../../private-equity/src/types';
import {withS5PortfolioTransaction as transaction} from '../../private-equity/src/allocation-store';
import {checkedModelTx,developmentOnly,eventTx,principal} from '../../private-equity/src/strategic-response/store';
import {PROFILE_DIGEST,digest,same,reference,fail,type ModelRow,type StrategicAdmission} from '../../private-equity/src/strategic-response/contracts';
function verify(row:ModelRow,a:StrategicAdmission){
 const {ref,...body}=a,check=row.artifact!.envelope.independentChecks.find(v=>v.status==='CHECKED')!;
 if(!same(ref,reference('S8','strategic-response-admission',body))||a.domain!=='STRATEGIC_RESPONSE_MODEL_SET'||
  a.protectionDomain!=='DISPOSABLE_LOCAL_DEVELOPMENT'||a.tenantId!==row.tenant_id||a.principalId!==row.principal_id||
  a.modelId!==row.id||!same(a.modelRef,row.artifact!.envelope.contentRef)||a.profileDigest!==PROFILE_DIGEST||
  a.candidateDigest!==digest(row.candidate)||a.checkDigest!==digest(check)||a.runtimeDigest!==row.runtime.semanticCodeDigest||
  a.rightsRevision!==row.rights_revision||a.workInputDigest!==row.work_input_digest||Date.parse(a.validUntil)<=Date.now()||
  a.protectedAdmission!==false||a.productionActivated!==false||a.executionAuthorityGranted!==false)fail('S8_STRATEGIC_RESPONSE_ADMISSION_BINDING');
}
export async function currentStrategicAdmissionTx(ctx:PeMutationContext,c:PoolClient,id:string){
 developmentOnly();const row=await checkedModelTx(ctx,c,id);
 const a=(await c.query<{body:StrategicAdmission}>('SELECT body FROM finnor_os.s8_strategic_response_admissions WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3',
  [ctx.auth.tenantId,principal(ctx),id])).rows[0]?.body;
 if(!a)fail('S8_STRATEGIC_RESPONSE_UNADMITTED');
 verify(row,a);if(!same(row.admission,a))fail('S8_STRATEGIC_RESPONSE_HEAD_CHANGED');
 return {row,admission:a};
}
export async function admitStrategicResponse(ctx:PeMutationContext,id:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await checkedModelTx(ctx,c,id);
  if(row.admission)return (await currentStrategicAdmissionTx(ctx,c,id)).admission;
  const check=row.artifact!.envelope.independentChecks.find(v=>v.status==='CHECKED')!;
  if(check.nonVacuous!==true||!check.checkedWorlds||check.protectedQualification!==false)fail('S8_NONVACUOUS_RESPONSE_CHECK_REQUIRED');
  const body:Omit<StrategicAdmission,'ref'>={schema:'finnor.s8.strategic-response-admission.v1',domain:'STRATEGIC_RESPONSE_MODEL_SET',
   protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',tenantId:row.tenant_id,principalId:row.principal_id,modelId:row.id,
   modelRef:row.artifact!.envelope.contentRef,candidateDigest:digest(row.candidate),checkDigest:digest(check),profileDigest:PROFILE_DIGEST,
   runtimeDigest:row.runtime.semanticCodeDigest,rightsRevision:row.rights_revision,workInputDigest:row.work_input_digest,
   admittedAt:new Date().toISOString(),validUntil:row.deadline_at.toISOString(),protectedAdmission:false,productionActivated:false,executionAuthorityGranted:false};
  const admission:StrategicAdmission={...body,ref:reference('S8','strategic-response-admission',body)};
  await c.query('INSERT INTO finnor_os.s8_strategic_response_admissions(tenant_id,admission_id,principal_id,model_id,body) VALUES($1,$2,$3,$4,$5::jsonb)',
   [row.tenant_id,admission.ref.id,row.principal_id,row.id,JSON.stringify(admission)]);
  await c.query('UPDATE finnor_os.y2_models SET admission=$3::jsonb WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id,JSON.stringify(admission)]);
  await eventTx(c,row,'S8_TYPED_ADMISSION','s8-admission',{admissionRef:admission.ref,domain:admission.domain,protectedAdmission:false,executionAuthorityGranted:false});
  return admission;
 });
}
