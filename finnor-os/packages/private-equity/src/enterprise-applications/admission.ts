import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {RefSchema} from '../../../capability-evolution/src/contracts';
import {applicationConsumerPolicy,proposeApplicationCandidate,currentApplicationCandidate} from '../../../capability-evolution/src/application-consumer';
import {makeApplicationCandidate,type ApplicationCandidate} from '../../../capability-evolution/src/application-port';
import {applicationDigest,assertApplicationData,ApplicationFault} from './contracts';
import {currentApplicationEnvironment,type ApplicationEnvironment} from './source-cut';
import {applicationTx,releaseTx,authorityTx,workCutTx,assertAllocation,priorEventTx,eventTx,tx,principal,fail,type ApplicationRow,type ReleaseBody} from './store';
export const ApplicationAdmissionProposeSchema=z.object({applicationId:z.string().uuid(),idempotencyKey:z.string().min(1).max(160)}).strict();
export const ApplicationAdmissionReadSchema=z.object({applicationId:z.string().uuid(),revisionRef:RefSchema}).strict();
function admissionValidityCurrent(candidate:ApplicationCandidate,policy:{validAfter:string;validUntil:string}){
 const now=Date.now();
 return now>=Math.max(Date.parse(candidate.domain.validAfter),Date.parse(policy.validAfter))&&
  now<Math.min(Date.parse(candidate.domain.validUntil),Date.parse(policy.validUntil));
}
async function admissionContextCurrentTx(ctx:PeMutationContext,c:PoolClient,a:ApplicationRow,release:ReleaseBody,environment:ApplicationEnvironment){
 const actor=await authorityTx(ctx,c,a),work=await workCutTx(c,a),p=release.package,now=Date.now();
 return a.status!=='CANCELLED'&&a.head_release_id===p.id&&p.rights.revision===Number(actor.authorityRevision)&&
  applicationDigest(release.environment)===applicationDigest(environment)&&work.id===p.work.revision&&work.digest===p.work.inputDigest&&
  now>=Date.parse(p.validity.validAfter)&&now<Date.parse(p.validity.validUntil);
}
export async function proposeApplicationAdmission(ctx:PeMutationContext,value:unknown){
 assertApplicationData(value,128*1024);const input=ApplicationAdmissionProposeSchema.parse(value),requestDigest=applicationDigest(input),environment=await currentApplicationEnvironment();
 const prepared=await tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:synthesize_enterprise_application');assertAllocation(a);if(a.owner_id!==principal(ctx))fail('APPLICATION_ADMISSION_OWNER_REQUIRED');
  const release=await releaseTx(c,a);
  if(!await admissionContextCurrentTx(ctx,c,a,release,environment))fail('APPLICATION_ADMISSION_CONTEXT_CHANGED');
  const prior=await priorEventTx(c,a,principal(ctx),'s8-propose:'+input.idempotencyKey,requestDigest);
  return {a,release,prior};
 });
 if(prepared.prior)return prepared.prior;
 const policy=await applicationConsumerPolicy({tenantId:prepared.a.tenant_id,principalId:prepared.a.owner_id,rightsRef:prepared.release.package.rights.ref});
 if(!policy)throw new ApplicationFault('APPLICATION_S8_CONSUMER_UNCONFIGURED','Independent S8 configuration is required; development installation grants no admission',503);
 const p=prepared.release.package;
 const candidate=makeApplicationCandidate({schema:'finnor.s8.application-candidate.v1',tenantId:p.tenantId,principalId:p.principalId,rightsRef:p.rights.ref,
  owningInterface:'x3-enterprise-application-v1',payload:{schema:'finnor.s8.application-payload.v1',applicationId:p.applicationId,releaseId:p.id,profile:'PE_FIRM_TYPED_APPLICATION_V1',
   specificationDigest:p.specification.contentDigest,programDigest:p.backend.digest,formsDigest:p.frontend.digest,sourceDigest:p.runtime.sourceDigest,lockDigest:p.runtime.lockDigest,checkerDigest:p.code.checkerDigest,schemaDigest:p.database.schemaDigest,
   runtime:'FINNOR_API_NODE_22_X3_STACK_V1',currentness:'EXACT_INSTALLED_RELEASE_REQUIRED',effects:'PREPARED_INTENT_ONLY'},
  domain:{root:p.validity.root,applicationId:p.applicationId,validAfter:new Date(Math.max(Date.parse(policy.validAfter),Date.parse(p.validity.validAfter))).toISOString(),validUntil:new Date(Math.min(Date.parse(policy.validUntil),Date.parse(p.validity.validUntil))).toISOString()},
  evidenceDigests:[p.proofs.digest],dependencies:policy.sourcePins,proposedAt:new Date().toISOString(),protectedAdmission:false,executionAuthorityGranted:false});
 const ref=await proposeApplicationCandidate(candidate,policy);
 const finalEnvironment=await currentApplicationEnvironment();
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId,'action:synthesize_enterprise_application');assertAllocation(a);
  if(a.head_release_id!==p.id)fail('APPLICATION_RELEASE_CHANGED');
  if(!admissionValidityCurrent(candidate,policy)||!await admissionContextCurrentTx(ctx,c,a,prepared.release,finalEnvironment))fail('APPLICATION_ADMISSION_CONTEXT_CHANGED');
  const result={candidate,revisionRef:ref,protectedAdmission:false,executionAuthorityGranted:false};
  const prior=await priorEventTx(c,a,principal(ctx),'s8-propose:'+input.idempotencyKey,requestDigest);if(prior)return prior;
  await eventTx(c,a,principal(ctx),'S8_PROPOSED','s8-propose:'+input.idempotencyKey,requestDigest,result);return result;
 });
}
export async function readApplicationAdmission(ctx:PeMutationContext,value:unknown){
 assertApplicationData(value,128*1024);const input=ApplicationAdmissionReadSchema.parse(value),environment=await currentApplicationEnvironment();
 const pinned=await tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId),release=await releaseTx(c,a);
  const rows=(await c.query<{body:{candidate:ApplicationCandidate}}>("SELECT body FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND kind='S8_PROPOSED' ORDER BY id DESC",[a.tenant_id,a.id])).rows;
  const candidate=rows.map(r=>r.body.candidate).find(x=>applicationDigest(x.ref)===applicationDigest(input.revisionRef));
  if(!candidate||candidate.payload.releaseId!==a.head_release_id||!await admissionContextCurrentTx(ctx,c,a,release,environment))return null;
  return {a,release,candidate};
 });
 if(!pinned)return {current:false,admission:null,protectedAdmission:false,executionAuthorityGranted:false};
 const policy=await applicationConsumerPolicy({tenantId:pinned.a.tenant_id,principalId:pinned.a.owner_id,rightsRef:pinned.release.package.rights.ref});
 if(!policy)throw new ApplicationFault('APPLICATION_S8_CONSUMER_UNCONFIGURED','Current S8 admission cannot be read',503);
 const admission=await currentApplicationCandidate(pinned.candidate,policy,'x3-current:'+crypto.randomUUID());
 const finalEnvironment=await currentApplicationEnvironment();
 return tx(ctx,async c=>{
  const a=await applicationTx(ctx,c,input.applicationId),current=!!admission&&admissionValidityCurrent(pinned.candidate,policy)&&await admissionContextCurrentTx(ctx,c,a,pinned.release,finalEnvironment);
  return {current,admission:current?admission:null,revisionRef:input.revisionRef,protectedAdmission:false,executionAuthorityGranted:false,productionActive:false};
 });
}
