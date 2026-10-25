import type {PrimaryAuthorityProfile,PrimaryConsent,PrimaryGrant,PrimaryIntake,PrimaryMandate,PrimaryReferenceSemantics,PrimarySourceProfile} from '@finnor/shared-types';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {actor,governance,retainedGovernance,rightsBinding,hash,exactWork,assertDependencies,tx,type Programme} from './store';
import {resolveBilateralPredecessor} from '../bilateral-opportunities/handoff';
import {assertPrimaryRuntimeMode,assertPrimarySourceAdmission} from './profile';

export async function intakeBindings(ctx:PeMutationContext,intake:PrimaryIntake,c?:PoolClient){
 const environment=assertPrimaryRuntimeMode(intake.mode);
 await resolveBilateralPredecessor(ctx,intake,c);
 // A supplied transaction client is one serial SQL connection, not a pool.
 const mandate=await governance<PrimaryMandate>(ctx,intake.mandateRef,'finnor.primary-mandate.v1',c);
 const authority=await governance<PrimaryAuthorityProfile>(ctx,intake.authorityProfileRef,'finnor.primary-authority.v1',c);
 const grant=await governance<PrimaryGrant>(ctx,intake.budgetGrantRef,'finnor.primary-grant.v1',c);
 const sources:PrimarySourceProfile[]=[],consents:PrimaryConsent[]=[],semantics:PrimaryReferenceSemantics[]=[];
 for(const ref of intake.sourceProfileRefs)sources.push(await governance<PrimarySourceProfile>(ctx,ref,'finnor.primary-source-profile.v1',c));
 for(const ref of intake.consentRefs)consents.push(await governance<PrimaryConsent>(ctx,ref,'finnor.primary-consent.v1',c));
 for(const ref of intake.referenceSemanticsRefs)semantics.push(await governance<PrimaryReferenceSemantics>(ctx,ref,'finnor.primary-reference-semantics.v1',c));
 if([mandate,authority,grant,...sources,...consents,...semantics].some(v=>v.environment!==environment))throw Error('PRIMARY_EXECUTION_PROFILE_MISMATCH');
 for(const source of sources)await assertPrimarySourceAdmission(ctx,source);
 const now=Date.now();
 if([mandate,authority,grant,...sources,...consents,...semantics].some(v=>now>=Date.parse(v.expiresAt)||'validFrom' in v&&now<Date.parse(v.validFrom)))throw Error('PRIMARY_GOVERNANCE_EXPIRED_OR_NOT_YET_VALID');
 if(mandate.issuingPrincipalId!==actor(ctx)||authority.issuingPrincipalId!==actor(ctx)||grant.issuingPrincipalId!==actor(ctx)||grant.mandateId!==mandate.mandateId||mandate.authorityProfileId!==authority.profileId||grant.legalEntityId!==mandate.legalEntityId)throw Error('PRIMARY_MANDATE_AUTHORITY_GRANT_BINDING_INVALID');
 if(mandate.assertionIds.length!==intake.assertions.length||!intake.assertions.every(a=>mandate.assertionIds.includes(a.assertionId)&&a.semantics.legalEntityId===mandate.legalEntityId&&hash(a.materiality.decisionRef)===hash(mandate.decisionRef))||
 !sources.every(s=>mandate.sourceProfileIds.includes(s.profileId)&&s.purpose===mandate.permittedPurpose))throw Error('PRIMARY_FROZEN_MANDATE_SCOPE_INVALID');
 const rights=await rightsBinding(ctx,intake.root,c);
 if([...sources,...consents].some(s=>hash(s.rightsRef)!==hash(rights.rightsRef)))throw Error('PRIMARY_CURRENT_S1_RIGHTS_MISMATCH');
 if(consents.some(v=>now>=Date.parse(v.retention.rawUntil)||now>=Date.parse(v.retention.derivativesUntil)))throw Error('PRIMARY_RETENTION_EXPIRED');
 if(consents.some(v=>!v.retention.retainAfterRevocation))throw Error('PRIMARY_IMMUTABLE_STORAGE_RETENTION_CONTRACT_UNSUPPORTED');
 const reservation=async(client:PoolClient)=>{
  const row=(await client.query(`SELECT s.*,o.body origin,p.problem,p.certificate FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
   JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest
   WHERE s.tenant_id=$1 AND s.reservation_id=$2 AND o.principal_id=$3`,[ctx.auth.tenantId,grant.reservationRef.id,actor(ctx)])).rows[0];
  if(!row||row.status==='RELEASED'||row.revocation_reason||row.origin.ref.contentDigest!==grant.reservationRef.contentDigest||row.origin.ref.version!==grant.reservationRef.revision||Date.now()>=Date.parse(row.certificate.validUntil))throw Error('PRIMARY_ORIGINAL_S5_RESERVATION_UNAVAILABLE');
  return row.problem.resources.map((r:{resourceId:string})=>'s5-resource:'+r.resourceId) as string[];
 };
 const resourceKeys=c?await reservation(c):await tx(ctx,reservation,true);
 return {mandate,authority,grant,sources,consents,semantics,rights,resourceKeys,retainedOnly:false as boolean};
}
export async function ownerBindings(ctx:PeMutationContext,p:Programme,c?:PoolClient){
 const bindings=await intakeBindings(ctx,p.intake,c);
 if(c){await exactWork(ctx,p,c);await assertDependencies(ctx,p.starting_manifest.dependencies,c,true);}
 return bindings;
}
export type OwnerBindings=Awaited<ReturnType<typeof ownerBindings>>;
export async function retainedStatusBindings(ctx:PeMutationContext,p:Programme):Promise<OwnerBindings>{
 const [mandate,authority,grant,sources,consents,semantics,rights]=await Promise.all([
  retainedGovernance<PrimaryMandate>(ctx,p.intake.mandateRef,'finnor.primary-mandate.v1'),
  retainedGovernance<PrimaryAuthorityProfile>(ctx,p.intake.authorityProfileRef,'finnor.primary-authority.v1'),
  retainedGovernance<PrimaryGrant>(ctx,p.intake.budgetGrantRef,'finnor.primary-grant.v1'),
  // A revoked/changed issuer key cannot settle a bill or release allowance.
  Promise.all(p.intake.sourceProfileRefs.map(r=>governance<PrimarySourceProfile>(ctx,r,'finnor.primary-source-profile.v1'))),
  Promise.all(p.intake.consentRefs.map(r=>retainedGovernance<PrimaryConsent>(ctx,r,'finnor.primary-consent.v1'))),
  Promise.all(p.intake.referenceSemanticsRefs.map(r=>retainedGovernance<PrimaryReferenceSemantics>(ctx,r,'finnor.primary-reference-semantics.v1'))),
  rightsBinding(ctx,p.root),
 ]);
 if(mandate.issuingPrincipalId!==actor(ctx)||authority.issuingPrincipalId!==actor(ctx)||grant.issuingPrincipalId!==actor(ctx)||grant.mandateId!==mandate.mandateId)throw Error('PRIMARY_RETAINED_ISSUANCE_BINDING_INVALID');
 return {mandate,authority,grant,sources,consents,semantics,rights,resourceKeys:[],retainedOnly:true};
}
