import { withTenantTransaction } from "@finnor/db";
import { evaluateAuthority } from "@finnor/authority";
import { validateStandingContactTx } from "../../authority/src/standing-contact";
import { canonical, digest } from "../../governed-execution/src/canonical";
import type { BusinessEffectSet, TenantContext } from "@finnor/shared-types";
import { authorizeActionExecutionTx } from "./runtime-bridge";

/** Existing S6 authorization owner instantiates an exact contact from one granted
 * envelope. This writes a standing-authority event, never a fabricated human
 * confirmation, and preserves the REQUIRED send_message approval floor. */
export async function authorizeStandingContact(ctx: TenantContext, actionId: string) {
  const loaded = await withTenantTransaction(ctx.tenantId, { userId: ctx.employeeId ?? ctx.userId, readOnly: true }, async (_db, c) =>
    (await c.query(`SELECT a.*,e.effect,e.semantic_hash FROM finnor_os.domain_actions a
      JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.id=a.business_effect_id
      WHERE a.tenant_id=$1 AND a.id=$2`, [ctx.tenantId, actionId])).rows[0]);
  if (!loaded || loaded.initiated_by !== (ctx.employeeId ?? ctx.userId)) throw Error("S6_STANDING_CONTACT_INITIATOR_MISMATCH");
  const effect = loaded.effect as BusinessEffectSet;
  const resources = effect.targets.map(t => ({ type: t.type, ...(/^[a-f0-9-]{36}$/i.test(t.id) ? { id: t.id } : {}) }));
  const execution = await evaluateAuthority(ctx, { operation: "execution", capability: "action:send_message",
    resources, risk: effect.authority.risk, workId: loaded.work_id, domainActionId: actionId,
    businessEffectId: effect.id, businessEffectHash: effect.semanticHash });
  if (execution.outcome !== "allowed") throw Error("S6_STANDING_CANNOT_OVERRIDE_CURRENT_ROLE_AUTHORITY");
  const approval = await evaluateAuthority(ctx, { operation: "approval", capability: "approve:send_message",
    resources, risk: effect.authority.risk, workId: loaded.work_id, domainActionId: actionId,
    businessEffectId: effect.id, businessEffectHash: effect.semanticHash });
  if (approval.outcome !== "allowed") throw Error("S6_STANDING_ISSUER_APPROVAL_CAPABILITY_MISSING");
  return withTenantTransaction(ctx.tenantId, { userId: ctx.employeeId ?? ctx.userId }, async (db, c) => {
    const binding = await validateStandingContactTx(c, ctx.tenantId, actionId, effect);
    if (binding.authority.issuingPrincipalId !== (ctx.employeeId ?? ctx.userId)) throw Error("S6_STANDING_ISSUER_MISMATCH");
    const action = (await c.query("SELECT status,business_effect_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [ctx.tenantId, actionId])).rows[0];
    if (!action || action.business_effect_id !== effect.id || !["pending", "needs_human_review", "approved", "executing"].includes(action.status)) throw Error("S6_STANDING_ACTION_NOT_CURRENT");
    const old = (await c.query("SELECT effect_hash FROM finnor_os.s6_standing_contact_authorizations WHERE tenant_id=$1 AND action_id=$2", [ctx.tenantId, actionId])).rows[0];
    if (old && old.effect_hash !== effect.semanticHash) throw Error("S6_STANDING_EFFECT_IDENTITY_CONFLICT");
    if (!old) {
      await c.query(`INSERT INTO finnor_os.s6_standing_contact_authorizations(tenant_id,action_id,business_effect_id,
        effect_hash,authority_ref,binding_digest,authority_decision_id,issuer_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [ctx.tenantId,actionId,effect.id,effect.semanticHash,
        canonical(binding.p.intake.authorityProfileRef),digest(binding.intent.activity_binding),approval.id,binding.authority.issuingPrincipalId]);
      await c.query(`INSERT INTO finnor_os.action_log(tenant_id,domain_action_id,step,input,output)
        VALUES($1,$2,'standing_contact_authorized',$3::jsonb,$4::jsonb)`, [ctx.tenantId,actionId,
        canonical({ source:"standing_authority",issuerId:binding.authority.issuingPrincipalId,authorityRef:binding.p.intake.authorityProfileRef }),
        canonical({ businessEffectId:effect.id,authorizedEffectHash:effect.semanticHash,standingAuthority:true,freshHumanApproval:false })]);
    }
    await c.query("UPDATE finnor_os.domain_actions SET status='approved' WHERE tenant_id=$1 AND id=$2 AND status IN('pending','needs_human_review')", [ctx.tenantId, actionId]);
    await c.query("UPDATE finnor_os.s6_contact_intents SET status='AUTHORIZED' WHERE tenant_id=$1 AND action_id=$2 AND status='INTENDED'", [ctx.tenantId,actionId]);
    return authorizeActionExecutionTx(db,{tenantId:ctx.tenantId,actionId,approvedBy:binding.authority.issuingPrincipalId,
      authorityDecisionId:approval.id,authorityRevision:approval.authorityRevision,authorizationSource:"standing_authority"});
  });
}
