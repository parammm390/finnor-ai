import type { PoolClient } from "pg";
import { withTenantTransaction } from "@finnor/db";
import {
  BilateralAuthoritySchema, BilateralDomainSchema, BilateralGrantSchema, BilateralMandateSchema,
  BilateralSourceProfileSchema, BilateralTermsSchema, RelationshipPolicySchema,
  type BilateralIntake, type BusinessEffectSet, type VReference,
} from "@finnor/shared-types";
import { bilateralMechanics } from "../../epistemic-runtime/src/bilateral-mechanics";
import { digest, verifySigned } from "../../governed-execution/src/canonical";
import { checkRelationshipContact, relationshipLock, type ContactIntent } from "./relationship-policy";
import { bilateralContactPayload } from "./bilateral-template";

async function exactRecord(c: PoolClient, tenantId: string, ref: VReference) {
  const row = (await c.query(`SELECT v.body,v.digest,v.semantic_owner,h.state FROM finnor_os.primary_governance_versions v
    JOIN finnor_os.primary_governance_heads h USING(tenant_id,id,revision)
    WHERE v.tenant_id=$1 AND v.id=$2 AND v.revision=$3 FOR SHARE OF h`,
  [tenantId, ref.id, Number(ref.revision)])).rows[0];
  if (!row || row.state !== "CURRENT" || row.semantic_owner !== ref.owner ||
      row.digest !== ref.contentDigest || digest(row.body) !== row.digest) throw Error("S6_CURRENT_ACTIVITY_OWNER_BINDING_UNAVAILABLE");
  if (row.body.environment !== "DEVELOPMENT" || process.env.NODE_ENV === "production" ||
      process.env.FINNOR_V1_PROFILE !== "ordinary_disposable") throw Error("S6_BILATERAL_LIVE_PROFILE_NOT_ADMITTED");
  if (Date.now() < Date.parse(row.body.validFrom ?? "1970-01-01") || Date.now() >= Date.parse(row.body.expiresAt)) throw Error("S6_ACTIVITY_AUTHORITY_EXPIRED");
  return row.body;
}

/** S6 validates the exact prepared action against original current owner records.
 * It is not a V1 local permission flag and does not waive generic role denials. */
export async function validateStandingContactTx(c: PoolClient, tenantId: string, actionId: string, effect: BusinessEffectSet) {
  await relationshipLock(c, tenantId);
  const intent = (await c.query<ContactIntent>("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND action_id=$2 AND programme_owner='V1' FOR SHARE", [tenantId, actionId])).rows[0];
  if (!intent) throw Error("S6_ORIGINAL_STANDING_CONTACT_INTENT_UNAVAILABLE");
  const p = (await c.query(`SELECT p.*,u.role,u.status actor_status FROM finnor_os.v1_programmes p
    JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.principal_id
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.id=$3 FOR SHARE OF p,u`,
  [tenantId, intent.principal_id, intent.programme_id])).rows[0];
  if (!p || p.role !== "owner" || p.actor_status !== "active" || p.invalidated || p.cancellation_requested_at ||
      ["COMPLETE", "STOPPED", "FAILED", "BLOCKED"].includes(p.status)) throw Error("S6_BILATERAL_CURRENT_PROGRAMME_FENCED");
  const intake = p.intake as BilateralIntake;
  const authority = BilateralAuthoritySchema.parse(await exactRecord(c, tenantId, intake.authorityProfileRef));
  const mandate = BilateralMandateSchema.parse(await exactRecord(c, tenantId, intake.mandateRef));
  const source = BilateralSourceProfileSchema.parse(await exactRecord(c, tenantId, intake.sourceProfileRef));
  const domain = BilateralDomainSchema.parse(await exactRecord(c, tenantId, intake.domainProfileRef));
  const grant = BilateralGrantSchema.parse(await exactRecord(c, tenantId, intake.budgetGrantRef));
  const policy = RelationshipPolicySchema.parse(await exactRecord(c, tenantId, intake.relationshipPolicyRef));
  if (Date.now() >= Math.min(Date.parse(mandate.deadline), Date.parse(grant.originalProgrammeDeadline), Date.parse(source.retentionUntil))) throw Error("S6_ORIGINAL_BILATERAL_DEADLINE_EXHAUSTED");
  if (digest(mandate.authorityProfileRef) !== digest(intake.authorityProfileRef) ||
      digest(mandate.relationshipPolicyRef) !== digest(intake.relationshipPolicyRef) ||
      digest(authority.relationshipPolicyRef) !== digest(intake.relationshipPolicyRef) ||
      digest(mandate.domainProfileRef) !== digest(intake.domainProfileRef) ||
      policy.firmEntityId !== mandate.buyerEntityId || domain.grammar !== mandate.programmeGrammar) throw Error("S6_ACTIVITY_SCOPE_OR_GRAMMAR_MISMATCH");
  const row = (await c.query(`SELECT t.body,t.digest,t.id,t.revision,c.company_id,c.counterparty_id,c.current_terms_id,c.disposition
    FROM finnor_os.v1_terms t JOIN finnor_os.v1_candidates c ON c.tenant_id=t.tenant_id AND c.principal_id=t.principal_id AND c.id=t.candidate_id
    WHERE t.tenant_id=$1 AND t.principal_id=$2 AND t.candidate_id=$3 AND t.id::text=$4 FOR SHARE OF c`,
  [tenantId, intent.principal_id, intent.candidate_id, String((intent.activity_binding.termsRef as VReference)?.id)])).rows[0];
  if (!row || ["INVALIDATED", "DECLINED", "DISQUALIFIED", "STOPPED", "EXPIRED"].includes(row.disposition) ||
      row.current_terms_id !== row.id || row.company_id !== intent.company_id ||
      row.counterparty_id !== intent.counterparty_id || row.digest !== intent.terms_digest || digest(row.body) !== row.digest) throw Error("S6_EXACT_CURRENT_TERMS_REQUIRED");
  const terms = BilateralTermsSchema.parse(row.body), values = effect.delta.values;
  const persisted = (await c.query("SELECT id FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$2 AND semantic_hash=$3",
    [tenantId, effect.id, effect.semanticHash])).rows[0];
  if (effect.operation.name !== "send_message" || effect.source.domainActionId !== actionId ||
      !persisted || effect.source.actionType !== "send_message" ||
      digest(values) !== intent.payload_digest || digest(intent.payload) !== intent.payload_digest ||
      (values.recipient as { partyType?: string; partyId?: string })?.partyType !== "external_contact" ||
      (values.recipient as { partyId?: string })?.partyId !== intent.counterparty_id ||
      (values.communicationIdentityRef as { communicationIdentityId?: string })?.communicationIdentityId !== authority.communicationIdentityId ||
      (values.workRef as { workId?: string })?.workId !== p.work_id || values.channel !== "email" ||
      values.purpose !== "private-market-bilateral" ||
      !effect.approval.required || effect.approval.typedConfirmation) throw Error("S6_STANDING_EXACT_EFFECT_MISMATCH");
  if (bilateralMechanics(terms, mandate.bounds, mandate.buyerEntityId, mandate.currency).length ||
      bilateralMechanics(terms, authority.negotiationBounds, mandate.buyerEntityId, mandate.currency).length) throw Error("S6_TERMS_REQUIRE_EXACT_NEW_AUTHORITY");
  for (const activity of ["CONTACT", "DISCLOSE", "PROPOSE_NONBINDING", ...(intent.kind === "CONFIRM" ? ["NEGOTIATE_WITHIN_BOUNDS"] : [])]) {
    if (!authority.activities.some(a => a.activity === activity && a.actorIds.includes(intent.principal_id) && a.channel === "email")) throw Error("S6_REQUIRED_ACTIVITY_ACTOR_NOT_AUTHORIZED");
  }
  if (authority.professionalRequirements.length) throw Error("S6_DESIGNATED_PROFESSIONAL_ATTESTATION_REQUIRED");
  const snapshot = p.frozen_manifest?.snapshot;
  if (!snapshot || !verifySigned(snapshot.body, snapshot.signature, source.responsePublicKeyPem)) throw Error("S6_ORIGINAL_INDEPENDENT_SOURCE_UNAVAILABLE");
  const company = snapshot.body.companies.find((value: { companyId: string }) => value.companyId === intent.company_id);
  if (!company || company.counterpartyId !== intent.counterparty_id ||
      !["OWNER", "AUTHORIZED_REPRESENTATIVE"].includes(company.role) ||
      !company.representationActivities.includes("CONSIDER_NONBINDING_TRANSACTION")) throw Error("S6_COUNTERPARTY_REPRESENTATION_UNESTABLISHED");
  for (const d of [...p.frozen_manifest.dependencies, ...(p.frozen_manifest.candidateDependencies[intent.company_id] ?? [])]) {
    const revision = (await c.query("SELECT revision FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key=$2 FOR SHARE", [tenantId, d.key])).rows[0]?.revision ?? 0;
    if (Number(revision) !== d.revision) throw Error("S6_SOURCE_RIGHTS_IDENTITY_OR_METHOD_CHANGED");
  }
  const work = (await c.query(`SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w
    WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [tenantId, p.work_id])).rows[0];
  if (work?.id !== p.work_input_id || digest(work.body) !== p.work_input_digest) throw Error("S6_EXACT_WORK_INPUT_CHANGED");
  if (Buffer.byteLength(String(values.body)) > authority.maximumDisclosureBytes ||
      !String(values.body).includes(authority.automationDisclosure) ||
      !String(values.body).includes(authority.firmDisplayName)) throw Error("S6_EXACT_TRUTHFUL_DISCLOSURE_REQUIRED");
  if(!['INQUIRE','APPROACH','CONFIRM'].includes(intent.kind)||digest(values)!==digest(bilateralContactPayload({
    authority,terms,workId:p.work_id,programmeId:p.id,candidateId:intent.candidate_id,counterpartyId:intent.counterparty_id,
    actionId:intent.action_id,revision:row.revision,kind:intent.kind as 'INQUIRE'|'APPROACH'|'CONFIRM'})))throw Error('S6_APPROVED_TRUTHFUL_TEMPLATE_MISMATCH');
  await checkRelationshipContact(c, tenantId, intent);
  const count = (await c.query(`SELECT count(*)::int n FROM finnor_os.s6_contact_intents i
    JOIN finnor_os.v1_programmes v ON v.tenant_id=i.tenant_id AND v.id=i.programme_id
    WHERE i.tenant_id=$1 AND v.intake->'budgetGrantRef'->>'id'=$2 AND i.status<>'CANCELLED_BEFORE_DISPATCH'`,
  [tenantId, grant.grantId])).rows[0].n;
  if (count > grant.maximumContacts) throw Error("S6_ORIGINAL_SHARED_CONTACT_GRANT_EXHAUSTED");
  return { intent, p, authority, mandate, domain, source, grant, policy };
}
export async function validateStandingContact(tenantId: string, actionId: string, effect: BusinessEffectSet, actorId: string) {
  return withTenantTransaction(tenantId, {userId:actorId}, (_db, c) => validateStandingContactTx(c, tenantId, actionId, effect));
}
export async function hasStandingContactAuthorization(c: PoolClient, tenantId: string, actionId: string, effect: BusinessEffectSet) {
  const row = (await c.query("SELECT * FROM finnor_os.s6_standing_contact_authorizations WHERE tenant_id=$1 AND action_id=$2", [tenantId, actionId])).rows[0];
  if (!row) return false;
  const binding = await validateStandingContactTx(c, tenantId, actionId, effect);
  if (row.business_effect_id !== effect.id || row.effect_hash !== effect.semanticHash ||
      digest(row.authority_ref) !== digest(binding.p.intake.authorityProfileRef) ||
      row.binding_digest !== digest(binding.intent.activity_binding)) throw Error("S6_STANDING_AUTHORIZATION_BINDING_CHANGED");
  return true;
}
