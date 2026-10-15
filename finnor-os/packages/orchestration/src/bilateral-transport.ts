import { withTenantTransaction } from "@finnor/db";
import type { SignedBilateralTransport, TenantContext } from "@finnor/shared-types";
import { SignedBilateralTransportSchema } from "@finnor/shared-types";
import { digest, verifySigned } from "../../governed-execution/src/canonical";
import { observeExternalEffect } from "@finnor/data-platform";
import { settleExternalEffectObservation } from "./external-observation";
import { recordObservedCommunicationAcceptance } from "../../domain-plugins/universal-actions/runtime";

/** A registered independent transport observer feeds the existing S6 terminal
 * boundary. ABSENT never licenses retry for this non-idempotent SMTP domain. */
export async function observeBilateralTransport(ctx: TenantContext, source: {
  publicKeyPem: string; maximumAgeMs: number; validUntil: string;
}, value: SignedBilateralTransport) {
  const signed = SignedBilateralTransportSchema.parse(value), o = signed.body;
  if (!verifySigned(o, signed.signature, source.publicKeyPem) || o.tenantId !== ctx.tenantId ||
    Date.parse(o.observedAt) > Date.now() || Date.now() >= Date.parse(o.expiresAt) ||
    Date.now() >= Date.parse(source.validUntil) || Date.now() - Date.parse(o.observedAt) > source.maximumAgeMs)
    throw Error("S6_BILATERAL_READBACK_DOMAIN_LIFETIME_OR_SIGNATURE_INVALID");
  const rows = await withTenantTransaction(ctx.tenantId, { userId: ctx.employeeId ?? ctx.userId, readOnly: true }, async (_db, c) => {
    const intent = (await c.query("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND action_id=$2 AND programme_owner='V1'",
      [ctx.tenantId, o.actionId])).rows[0];
    if (!intent || intent.programme_id !== o.programmeId || intent.company_id !== o.companyId ||
      intent.counterparty_id !== o.participantId || intent.payload.body && digest(intent.payload.body) !== o.bodyDigest ||
      digest(intent.payload.subject) !== o.subjectDigest ||
      intent.activity_binding.recipientAddressDigest !== o.recipientAddressDigest ||
      intent.activity_binding.senderAddressDigest !== o.senderAddressDigest ||
      intent.payload.communicationIdentityRef?.communicationIdentityId !== o.communicationIdentityId)
      throw Error("S6_EXACT_ORIGINAL_TRANSPORT_REQUEST_MISMATCH");
    const operations = (await c.query(`SELECT e.* FROM finnor_os.external_operations e
      WHERE e.tenant_id=$1 AND e.domain_action_id=$2 AND e.provider=$3 AND e.integration_id IS NOT NULL ORDER BY e.created_at`,
    [ctx.tenantId, o.actionId, o.provider])).rows;
    if (operations.length !== 1) throw Error("S6_ORIGINAL_CONTACT_MEMBER_OR_INTEGRATION_UNAVAILABLE");
    return { intent, operation: operations[0] };
  });
  const expected = { recipientAddressDigest: o.recipientAddressDigest, senderAddressDigest: o.senderAddressDigest,
    subjectDigest: o.subjectDigest, bodyDigest: o.bodyDigest, accepted: true };
  const observation = observeExternalEffect({
    tenantId: ctx.tenantId, businessEffectId: rows.operation.business_effect_id,
    integrationId: rows.operation.integration_id, provider: o.provider,
    externalObjectType: "sent_message", externalId: o.providerMessageRef ?? undefined,
    observedAt: o.observedAt, expected, observed: o.outcome === "ACCEPTED" ? expected : undefined,
    definitelyAbsent: false, evidence: { mechanism: "read_after_write" },
  });
  await settleExternalEffectObservation(observation, { domainActionId: o.actionId,
    externalOperationKey: rows.operation.operation_key, providerEventId: digest(signed) });
  await withTenantTransaction(ctx.tenantId, { userId: ctx.employeeId ?? ctx.userId }, async (_db, c) => {
    await c.query(`UPDATE finnor_os.s6_contact_intents SET status=$3,
      acknowledged_at=CASE WHEN $3='ACKNOWLEDGED' THEN COALESCE(acknowledged_at,clock_timestamp()) ELSE acknowledged_at END
      WHERE tenant_id=$1 AND action_id=$2`, [ctx.tenantId, o.actionId, o.outcome === "ACCEPTED" ? "ACKNOWLEDGED" : "UNKNOWN"]);
  });
  if (o.outcome === "ACCEPTED" && o.providerMessageRef) await recordObservedCommunicationAcceptance({
    tenantId: ctx.tenantId, actionId: o.actionId, recipientId: o.participantId, communicationIdentityId: o.communicationIdentityId,
    providerMessageRef: o.providerMessageRef, observation: { contract: o.contract, signedObservationDigest: digest(signed), meaning: o.meaning },
  });
  return { outcome: o.outcome === "ACCEPTED" ? "ACCEPTED" : "UNKNOWN", originalEffectRetained: true, retryAuthorized: false };
}
