/** Ordinary native entry/physical-boundary refusal. This never grants protected authority. */
import {sql} from 'drizzle-orm';
import type {Db} from './index';
import {requireProtectedAdapter,type S6AdapterClass} from '../governed-execution/src/adapter-contract';
import type { PoolClient } from 'pg';

/** Private preparation and locked egress use the same authority projection.
 * Credentials themselves are not present in these governed metadata rows. */
export const NATIVE_APPLICATION_PROFILE_AUTHORITY_SQL = `jsonb_build_object(
 'profileId',p.id,'authProfileRef',p.auth_profile_ref,'accountId',p.application_account_id,
 'principalType',p.principal_type,'principalId',p.principal_id,'purpose',p.purpose,
 'scope',p.scope,'revision',p.connection_revision,'restrictions',p.restrictions,
 'requiredScopes',p.required_scopes,'grantedScopes',p.granted_scopes,'profileCapabilities',p.capabilities,
 'credentialProvider',p.credential_provider,'credentialRef',p.credential_ref,'credentialVersion',p.credential_version,
 'authMethod',p.auth_method,'profileStatus',p.status,'connectionRequired',p.connection_required,
 'connectionStatus',p.connection_status,'providerSubjectRef',p.provider_subject_ref,
 'tokenExpiresAt',p.token_expires_at,'updatedAt',p.updated_at,
 'application',a.application,'provider',a.provider,'providerAccountRef',a.provider_account_ref,
 'accountCapabilities',a.capabilities,'accountStatus',a.status
)`;

export async function assertNativeEffectAdapterAdmission(db:Db,tenantId:string,binding:{businessEffectId?:string|null;domainActionId?:string|null},adapter:S6AdapterClass){
 if(!binding.businessEffectId&&!binding.domainActionId)return;
 const found=await db.execute(sql`SELECT o.obligation_id FROM finnor_os.s6_obligation_origins o
  WHERE o.tenant_id=${tenantId}::uuid AND (${binding.businessEffectId??null}::uuid IS NOT NULL AND o.effect_id=${binding.businessEffectId??null}::uuid
   OR ${binding.domainActionId??null}::uuid IS NOT NULL AND o.domain_action_id=${binding.domainActionId??null}::uuid) LIMIT 1`);
 if(found.rows.length)requireProtectedAdapter(adapter);
}

/** Exact ordinary application-domain gate. The protected adapter rule above is
 * unchanged, including its refusal of generic BROWSER and application adapters. */
export async function assertNativeApplicationEffectAdapterBoundary(c: PoolClient, input: {
 tenantId: string; principalId: string; sessionId: string; requestId: string;
 effectId: string; actionId: string; wireDigest: string; profileId: string;
 jobId: string; claimToken: string; claimFence: number; generation: number;
}) {
 if(process.env.FINNOR_ENVIRONMENT!=='staging'||process.env.FINNOR_X2_PROFILE!=='ordinary_disposable')
  throw Error('S6_APPLICATION_PROTECTED_DOMAIN_UNADMITTED');
 const allowed=await c.query(`SELECT r.id FROM finnor_os.application_semantics_requests r
  JOIN finnor_os.application_semantics_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id AND s.principal_id=r.principal_id
  JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id AND o.principal_id=r.principal_id
  JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id AND e.domain_action_id=o.domain_action_id
  JOIN finnor_os.domain_actions d ON d.tenant_id=e.tenant_id AND d.id=e.domain_action_id
  JOIN finnor_os.auth_profiles p ON p.tenant_id=s.tenant_id AND p.id=$8
  JOIN finnor_os.application_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.application_account_id
  JOIN finnor_os.users u ON u.tenant_id=s.tenant_id AND u.id=s.principal_id
  JOIN finnor_os.jobs j ON j.tenant_id=s.tenant_id AND j.id=$9
  WHERE r.tenant_id=$1 AND r.principal_id=$2 AND s.id=$3 AND r.id=$4 AND e.id=$5 AND d.id=$6
   AND r.wire_digest=$7 AND NOT r.possible_egress AND r.status='PREPARED'
   AND r.body->>'schema'='finnor.s6.private-application-request.v2'
   AND r.body->'privateProfileBinding'=${NATIVE_APPLICATION_PROFILE_AUTHORITY_SQL}
   AND o.body->>'schema'='finnor.s6.application-obligation.v1'
   AND o.body->>'protectionDomain'='DISPOSABLE_TEST_AUTHORITY'
   AND o.body->'effectRef'->>'semanticHash'=e.semantic_hash
   AND e.status='compiled' AND d.status='draft' AND d.initiated_by=u.id
   AND p.status='active' AND p.auth_method='application_headers' AND p.connection_status IN ('active','degraded')
   AND (p.token_expires_at IS NULL OR p.token_expires_at>clock_timestamp())
   AND (p.restrictions->'applicationSemantics'->>'validUntil')::timestamptz>clock_timestamp()
   AND a.status='active' AND u.status='active' AND u.role='owner'
   AND s.generation=$12 AND s.cancel_requested_at IS NULL AND s.deadline_at>clock_timestamp()
   AND s.claim_token=$10 AND s.claim_fence=$11
   AND j.type='run_application_semantics_v1' AND j.protocol_version=1 AND j.status='running'
   AND j.claim_token=$10 AND j.claim_fence=$11 AND j.lease_expires_at>clock_timestamp()
   AND j.payload->>'sessionId'=s.id::text AND (j.payload->>'generation')::integer=s.generation
  FOR SHARE OF s,o,e,d,p,a,u,j`,[input.tenantId,input.principalId,input.sessionId,input.requestId,
  input.effectId,input.actionId,input.wireDigest,input.profileId,input.jobId,input.claimToken,input.claimFence,input.generation]);
 if(allowed.rowCount!==1)throw Error('S6_NATIVE_APPLICATION_ADAPTER_BOUNDARY_DENIED');
}
