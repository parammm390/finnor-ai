/** Additive typed S8 domain. This ordinary local admission is deliberately not a
 * financial allocation-method receipt or a protected release/signature. */
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../../private-equity/src/types';
import {checkedTheoryTx,developmentOnly,eventTx,transaction,principal} from '../../private-equity/src/economic-action-theory/store';
import {PROFILE_DIGEST,digest,reference,same,fail,type EconomicRef,type TheoryRow} from '../../private-equity/src/economic-action-theory/contracts';
export interface EconomicTheoryAdmission {
 schema:'finnor.s8.economic-theory-admission.v1';domain:'ECONOMIC_ACTION_THEORY';ref:EconomicRef;
 protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT';tenantId:string;principalId:string;theoryId:string;theoryRef:EconomicRef;
 candidateDigest:string;checkDigest:string;profileDigest:string;runtimeDigest:string;rightsRevision:string;workInputDigest:string;
 admittedAt:string;validUntil:string;protectedAdmission:false;productionActivated:false;executionAuthorityGranted:false;
}
function verify(row:TheoryRow,admission:EconomicTheoryAdmission){
 const {ref,...body}=admission,check=row.artifact!.envelope.independentChecks.find(c=>c.status==='CHECKED')!;
 if(!same(ref,reference('S8','economic-theory-admission',body))||admission.domain!=='ECONOMIC_ACTION_THEORY'||
  admission.protectionDomain!=='DISPOSABLE_LOCAL_DEVELOPMENT'||admission.tenantId!==row.tenant_id||admission.principalId!==row.principal_id||
  admission.theoryId!==row.id||!same(admission.theoryRef,row.artifact!.envelope.contentRef)||admission.profileDigest!==PROFILE_DIGEST||
  admission.candidateDigest!==digest(row.candidate)||admission.checkDigest!==digest(check)||admission.runtimeDigest!==row.runtime.semanticCodeDigest||
  admission.rightsRevision!==row.rights_revision||admission.workInputDigest!==row.work_input_digest||Date.parse(admission.validUntil)<=Date.now()||
  admission.protectedAdmission!==false||admission.productionActivated!==false||admission.executionAuthorityGranted!==false)
  fail('S8_ECONOMIC_THEORY_ADMISSION_BINDING');
}
export async function currentEconomicTheoryAdmissionTx(ctx:PeMutationContext,c:PoolClient,theoryId:string){
 developmentOnly();const row=await checkedTheoryTx(ctx,c,theoryId);
 const admission=(await c.query<{body:EconomicTheoryAdmission}>('SELECT body FROM finnor_os.s8_economic_theory_admissions WHERE tenant_id=$1 AND principal_id=$2 AND theory_id=$3',
  [ctx.auth.tenantId,principal(ctx),theoryId])).rows[0]?.body;
 if(!admission)fail('S8_ECONOMIC_THEORY_UNADMITTED');
 verify(row,admission);
 if(!same(row.admission,admission))fail('S8_ECONOMIC_THEORY_NATIVE_HEAD_CHANGED');
 return {row,admission};
}
export async function admitEconomicTheory(ctx:PeMutationContext,theoryId:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await checkedTheoryTx(ctx,c,theoryId);
  if(row.admission)return (await currentEconomicTheoryAdmissionTx(ctx,c,theoryId)).admission;
  const check=row.artifact!.envelope.independentChecks.find(c=>c.status==='CHECKED')!;
  if(check.nonVacuous!==true||!check.traceCount||check.protectedQualification!==false)fail('S8_ECONOMIC_THEORY_INDEPENDENT_CHECK_REQUIRED');
  const body:Omit<EconomicTheoryAdmission,'ref'>={schema:'finnor.s8.economic-theory-admission.v1',domain:'ECONOMIC_ACTION_THEORY',
   protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',tenantId:row.tenant_id,principalId:row.principal_id,theoryId:row.id,
   theoryRef:row.artifact!.envelope.contentRef,candidateDigest:digest(row.candidate),checkDigest:digest(check),profileDigest:PROFILE_DIGEST,
   runtimeDigest:row.runtime.semanticCodeDigest,rightsRevision:row.rights_revision,workInputDigest:row.work_input_digest,
   admittedAt:new Date().toISOString(),validUntil:row.deadline_at.toISOString(),protectedAdmission:false,productionActivated:false,executionAuthorityGranted:false};
  const admission:EconomicTheoryAdmission={...body,ref:reference('S8','economic-theory-admission',body)};
  await c.query('INSERT INTO finnor_os.s8_economic_theory_admissions(tenant_id,admission_id,principal_id,theory_id,body) VALUES($1,$2,$3,$4,$5::jsonb)',
   [row.tenant_id,admission.ref.id,row.principal_id,row.id,JSON.stringify(admission)]);
  await c.query('UPDATE finnor_os.y1_requests SET admission=$3::jsonb WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id,JSON.stringify(admission)]);
  await eventTx(c,row,'S8_TYPED_ADMISSION','s8-admission',{admissionRef:admission.ref,domain:admission.domain,protectedAdmission:false,productionActivated:false});
  return admission;
 });
}
