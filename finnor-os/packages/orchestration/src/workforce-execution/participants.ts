import { randomUUID } from "node:crypto";
import { workforceParticipantProposalSchema, workforceParticipantDispositionSchema } from "./contracts";
import type { TenantContext } from "@finnor/shared-types";
import { canExerciseWorkforceAuthorityTx as canExerciseAuthorityTx } from "@finnor/authority";
import { workforceDigest } from "../../../workforce/src/execution-program/exact";
import { activePrincipal, principal, reject, tx } from "./store";


export async function proposeWorkforceParticipant(ctx: TenantContext, value: unknown) {
  const input = workforceParticipantProposalSchema.parse(value);
  return tx(ctx, async c => {
    // One live binding per contact. The per-contact advisory lock serializes
    // concurrent proposals so the live check below can never race an INSERT;
    // it does not touch the shared contact row, so respondent flows are
    // unaffected and no lock-ordering cycle exists.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ctx.tenantId + ":" + input.contactId]);
    await activePrincipal(ctx, c);
    if (Date.parse(input.validUntil) <= Date.now() ||
        !await canExerciseAuthorityTx(ctx, { operation: "action", capability: "action:workforce_assign_contract",
          resource: { type: "external_contact", id: input.contactId }, risk: "low" }, c))
      reject("WORKFORCE_ENROLLMENT_CURRENT_AUTHORITY_REQUIRED", 403);
    const contact = (await c.query("SELECT id FROM finnor_os.external_contacts WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE",
      [ctx.tenantId, input.contactId])).rows[0];
    const recipient = (await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
      [ctx.tenantId, input.recipientPrincipalId])).rows[0];
    if (!contact || !recipient) reject("WORKFORCE_EXISTING_CONTACT_AND_PRINCIPAL_REQUIRED", 404);
    const digest = workforceDigest({ tenantId: ctx.tenantId, proposedBy: principal(ctx), ...input });
    const prior = (await c.query(`SELECT id,status,revision,proposal_digest FROM finnor_os.w2_contact_bindings
      WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE`,
    [ctx.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.proposal_digest !== digest) reject("WORKFORCE_ENROLLMENT_IDEMPOTENCY_CONFLICT");
      return { id: prior.id, status: prior.status, revision: prior.revision, proposalDigest: digest, semanticReplay: true };
    }
    // A binding whose validity has passed is EXPIRED by clock, exactly once,
    // before any new proposal for the same contact. The security-definer
    // sweep writes the exact durable expiry event from the row itself; expiry
    // is never a fabricated human revocation, releases no obligation and
    // grants no authority, and no private binding content becomes visible to
    // this principal.
    await c.query("SELECT finnor_os.w2_expire_contact_bindings($1,$2,$3)",
      [ctx.tenantId, input.contactId, principal(ctx)])
    const live = (await c.query(`SELECT id FROM finnor_os.w2_contact_bindings
      WHERE tenant_id=$1 AND contact_id=$2 AND status IN('PROPOSED','CONFIRMED') FOR UPDATE`,
    [ctx.tenantId, input.contactId])).rows[0];
    if (live) reject("WORKFORCE_ENROLLMENT_CURRENT_BINDING_EXISTS", 409);
    const id = randomUUID();
    const inserted = (await c.query(`INSERT INTO finnor_os.w2_contact_bindings(tenant_id,id,principal_id,contact_id,recipient_principal_id,
      purpose,valid_until,proposal_digest,idempotency_key,status,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PROPOSED',0)
      ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.tenantId, id, principal(ctx), input.contactId, input.recipientPrincipalId, input.purpose, input.validUntil, digest, input.idempotencyKey])).rows[0];
    // Another principal's live binding for this contact is private and
    // invisible under row security; the one-live-binding index is the exact
    // backstop and the conflict answer stays opaque.
    if (!inserted) reject("WORKFORCE_ENROLLMENT_CURRENT_BINDING_EXISTS", 409);
    await c.query(`INSERT INTO finnor_os.w2_contact_binding_events(tenant_id,binding_id,principal_id,event_key,body)
      VALUES($1,$2,$3,'proposal',$4::jsonb)`, [ctx.tenantId, id, principal(ctx), JSON.stringify({
      schema: "finnor.workforce-existing-contact-enrollment.v1", proposalDigest: digest, contactId: input.contactId,
      recipientPrincipalId: input.recipientPrincipalId, purpose: input.purpose, validUntil: input.validUntil,
      proposedBy: principal(ctx), contactSent: false, authorityGranted: false, voluntaryConsentEstablished: false })]);
    return { id, status: "PROPOSED", revision: 0, proposalDigest: digest, semanticReplay: false };
  });
}

export async function readWorkforceParticipants(ctx: TenantContext) {
  return tx(ctx, async c => {
    await activePrincipal(ctx, c);
    const data = (await c.query(`SELECT id,contact_id AS "contactId",recipient_principal_id AS "recipientPrincipalId",
      principal_id AS "proposedBy",purpose,valid_until AS "validUntil",proposal_digest AS "proposalDigest",status,revision
      FROM finnor_os.w2_contact_bindings WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 129`, [ctx.tenantId])).rows;
    if (data.length > 128) reject("WORKFORCE_ENROLLMENT_PROFILE_EXCEEDED");
    return { data, complete: true, authorityGranted: false, genuineHumanQualified: false };
  });
}

/** Acknowledges only the identity/purpose binding. Each external assignment
 * still needs its own later exact voluntary recipient disposition. */
export async function respondWorkforceParticipant(ctx: TenantContext, id: string, value: unknown) {
  const input = workforceParticipantDispositionSchema.parse(value);
  return tx(ctx, async c => {
    await activePrincipal(ctx, c);
    const row = (await c.query(`SELECT * FROM finnor_os.w2_contact_bindings WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.tenantId, id])).rows[0];
    if (!row) reject("WORKFORCE_ENROLLMENT_UNAVAILABLE", 404);
    const actual = principal(ctx);
    if (input.action === "CONFIRM" ? row.recipient_principal_id !== actual :
        ![row.recipient_principal_id, row.principal_id].includes(actual))
      reject("WORKFORCE_ENROLLMENT_EXACT_RECIPIENT_REQUIRED", 403);
    if (row.proposal_digest !== input.proposalDigest) reject("WORKFORCE_ENROLLMENT_EXACT_PROPOSAL_REQUIRED");
    const digest = workforceDigest(input), key = actual + ":" + input.idempotencyKey;
    const prior = (await c.query(`SELECT body FROM finnor_os.w2_contact_binding_events
      WHERE tenant_id=$1 AND binding_id=$2 AND event_key=$3`, [ctx.tenantId, id, key])).rows[0]?.body;
    if (prior) {
      if (prior.requestDigest !== digest || prior.authenticatedPrincipal !== actual)
        reject("WORKFORCE_ENROLLMENT_IDEMPOTENCY_CONFLICT");
      return { id, status: row.status, revision: row.revision, semanticReplay: true };
    }
    if (row.revision !== input.expectedRevision) reject("WORKFORCE_ENROLLMENT_REVISION_CHANGED");
    if (input.action === "CONFIRM") {
      if (row.status !== "PROPOSED" || new Date(row.valid_until).getTime() <= Date.now() ||
          !(await c.query("SELECT id FROM finnor_os.external_contacts WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE",
            [ctx.tenantId, row.contact_id])).rowCount ||
          !await canExerciseAuthorityTx(ctx, { operation: "action", capability: "action:workforce_respond_contract",
            resource: { type: "external_contact", id: row.contact_id }, risk: "low" }, c))
        reject("WORKFORCE_ENROLLMENT_CURRENT_RECIPIENT_AUTHORITY_REQUIRED", 403);
    } else if (row.status === "REVOKED") reject("WORKFORCE_ENROLLMENT_ALREADY_REVOKED");
    const status = input.action === "CONFIRM" ? "CONFIRMED" : "REVOKED";
    await c.query("UPDATE finnor_os.w2_contact_bindings SET status=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, id, status]);
    await c.query(`INSERT INTO finnor_os.w2_contact_binding_events(tenant_id,binding_id,principal_id,event_key,body)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [ctx.tenantId, id, row.principal_id, key, JSON.stringify({
      schema: "finnor.workforce-contact-binding-disposition.v1", action: input.action, requestDigest: digest,
      authenticatedPrincipal: actual, proposalDigest: row.proposal_digest, at: new Date().toISOString(),
      assignmentAcceptanceImplied: false, authorityGranted: false, obligationsReleased: false })]);
    return { id, status, revision: row.revision + 1, semanticReplay: false };
  });
}
