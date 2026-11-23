import type { PoolClient } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import { canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import { organizationDigest } from "./compiler";
import { organizationMethodPins } from "./dependencies";
import { orgFail, principal } from "./store";

export interface OrganizationSelfOffer {
  request_id: string; principal_id: string; participant_id: string; role_id: string;
  alternative_id: string; terms_digest: string; terms: unknown; disclosure: Record<string, unknown>;
  expires_at: Date; revoked_at: Date | null;
}
interface SelfHead {
  work_id: string; owner_id: string; phase: string; revision: number; current_terms: boolean | null;
  method_pins: Array<{ path: string; digest: string }>;
  pending_native: boolean; terms_digest: string; alternative_id: string;
}

/** The SQL port exposes only an exact self offer's guarded head, never the
 * private parent graph. Authority evaluation remains the canonical owner port. */
export async function organizationSelfContractTx(ctx: TenantContext, offer: OrganizationSelfOffer, c: PoolClient) {
  const invalid = { status: "INVALIDATED" as const, phase: null, revision: null, pendingNativeWork: true };
  if (offer.participant_id !== principal(ctx) || organizationDigest(offer.terms) !== offer.terms_digest)
    return invalid;
  await c.query(`SELECT set_config('lock_timeout',(CASE WHEN setting::bigint<=0 THEN 1000
    ELSE least(setting::bigint,1000) END)::text||'ms',true) FROM pg_settings WHERE name='lock_timeout'`);
  const head = (await c.query<SelfHead>("SELECT * FROM finnor_os.w5_participant_head($1,$2)",
    [offer.request_id, offer.role_id])).rows[0];
  if (!head || head.current_terms !== true || head.work_id !== offer.disclosure.workId ||
      head.owner_id !== offer.principal_id || head.terms_digest !== offer.terms_digest ||
      head.alternative_id !== offer.alternative_id) return invalid;
  const methods = new Map(organizationMethodPins().map(pin => [pin.id, pin.digest]));
  if (!Array.isArray(head.method_pins) || head.method_pins.length !== methods.size ||
      new Set(head.method_pins.map(pin => pin.path)).size !== methods.size ||
      head.method_pins.some(pin => methods.get(pin.path) !== pin.digest)) return invalid;
  const resource = { type: "work" as const, id: head.work_id };
  if (!await canExerciseWorkforceAuthorityTx(ctx, { operation: "action", capability: "action:workforce_respond_contract",
    workId: head.work_id, resource: { type: "workforce_assignment", id: offer.request_id + ":" + offer.role_id },
    risk: "low" }, c)) return invalid;
  // A read-only check of the unchanged delegator's actual canonical authority,
  // not execution under that identity or a grant to the recipient.
  const owner: TenantContext = { tenantId: ctx.tenantId, userId: head.owner_id,
    employeeId: head.owner_id, role: "owner" };
  if (!await canExerciseWorkforceAuthorityTx(owner, { operation: "action", capability: "action:workforce_assign_contract",
    workId: head.work_id, resource, risk: "low" }, c)) return invalid;
  return { status: "CURRENT" as const, phase: head.phase, revision: head.revision, pendingNativeWork: head.pending_native };
}

export async function projectOrganizationSelfOffersTx(ctx: TenantContext, offers: OrganizationSelfOffer[], c: PoolClient) {
  if (offers.length > 128) orgFail("W5_PARTICIPANT_OFFER_BOUND");
  const result = [];
  for (const offer of offers) {
    const currentness = await organizationSelfContractTx(ctx, offer, c);
    result.push({ request_id: offer.request_id, role_id: offer.role_id, alternative_id: offer.alternative_id,
      terms_digest: offer.terms_digest, expires_at: offer.expires_at, revoked_at: offer.revoked_at,
      disclosure: currentness.status === "CURRENT" ? offer.disclosure : null, currentness,
      availableDecisions: currentness.status === "CURRENT" ? ["ADOPT", "DECLINE", "REVOKE"] : ["REVOKE"] });
  }
  return result;
}
