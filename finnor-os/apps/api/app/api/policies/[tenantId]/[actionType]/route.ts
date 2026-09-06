// GET/PUT /api/policies/:tenantId/:actionType (§8). The tenantId path segment must
// match the caller's own tenant — cross-tenant policy access is a hard 403 before
// RLS would return empty anyway (defense in depth).

import { withTenant, domainPolicies, domainPolicyRevisions } from "@finnor/db";
import { UpsertPolicySchema } from "@finnor/policy-schema";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../../lib/auth";
import { isRetiredWaterAction } from "@finnor/shared-types";

type Params = { params: Promise<{ tenantId: string; actionType: string }> };

type PolicyBase = typeof domainPolicies.$inferSelect;
type PolicyRevision = typeof domainPolicyRevisions.$inferSelect;

function projectRevision(base: PolicyBase, revision: PolicyRevision): PolicyBase {
  return {
    ...base,
    actionType: revision.actionType,
    policy: revision.policy,
    requiresConfirmation: revision.requiresConfirmation,
    confirmationTemplate: revision.confirmationTemplate,
    modelProvider: revision.modelProvider,
    confirmationTimeoutHours: revision.confirmationTimeoutHours,
    version: revision.version,
    effectiveFrom: revision.effectiveFrom,
  };
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  try {
    const { tenantId, actionType } = await params;
    if (isRetiredWaterAction(actionType)) return Response.json({ error: "RETIRED_VERTICAL" }, { status: 410 });
    const ctx = await requireContext(req);
    if (ctx.tenantId !== tenantId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const policy = await withTenant(ctx.tenantId, async (db) => {
      const [base] = await db
        .select()
        .from(domainPolicies)
        .where(and(eq(domainPolicies.tenantId, ctx.tenantId), eq(domainPolicies.actionType, actionType)));
      if (!base) return null;
      const [current] = await db
        .select()
        .from(domainPolicyRevisions)
        .where(and(
          eq(domainPolicyRevisions.tenantId, ctx.tenantId),
          eq(domainPolicyRevisions.policyId, base.id),
          lte(domainPolicyRevisions.effectiveFrom, new Date()),
        ))
        .orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version))
        .limit(1);
      if (current) return projectRevision(base, current);
      // Compatibility fallback for pre-revision rows only. A first policy scheduled
      // for the future is not current merely because its parent row already exists.
      return base.effectiveFrom <= new Date() ? base : null;
    });
    if (!policy) return Response.json({ error: "No policy configured" }, { status: 404 });
    return Response.json({ policy });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  try {
    const { tenantId, actionType } = await params;
    if (isRetiredWaterAction(actionType)) return Response.json({ error: "RETIRED_VERTICAL" }, { status: 410 });
    const ctx = await requireContext(req);
    if (ctx.tenantId !== tenantId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (ctx.role !== "owner") {
      return Response.json({ error: "Only owners can edit policies" }, { status: 403 });
    }
    const body = UpsertPolicySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return Response.json(
        { error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }
    const effectiveFrom = body.data.effectiveFrom ? new Date(body.data.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.valueOf()) || effectiveFrom < new Date(Date.now() - 1_000)) {
      return Response.json({ error: "effectiveFrom must be now or in the future" }, { status: 400 });
    }
    const row = await withTenant(ctx.tenantId, async (db) => {
      // Serialize both first creation and every later revision for this exact policy.
      // Row locks alone cannot protect the no-row-yet case.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:${actionType}`}, 906))`);
      const [existing] = await db
        .select()
        .from(domainPolicies)
        .where(and(eq(domainPolicies.tenantId, ctx.tenantId), eq(domainPolicies.actionType, actionType)));
      if (existing) {
        const [latestRevision] = await db
          .select({ version: domainPolicyRevisions.version })
          .from(domainPolicyRevisions)
          .where(and(
            eq(domainPolicyRevisions.tenantId, ctx.tenantId),
            eq(domainPolicyRevisions.policyId, existing.id),
          ))
          .orderBy(desc(domainPolicyRevisions.version))
          .limit(1);
        const version = Math.max(existing.version, latestRevision?.version ?? 0) + 1;
        // A scheduled change must not replace the compatibility/base row early.
        // Effective reads use the immutable revision log and its activation time.
        if (effectiveFrom > new Date()) {
          const [scheduled] = await db.insert(domainPolicyRevisions).values({
            tenantId: ctx.tenantId, policyId: existing.id, actionType, version,
            policy: body.data.policy, requiresConfirmation: body.data.requiresConfirmation,
            confirmationTemplate: body.data.confirmationTemplate ?? null, modelProvider: body.data.modelProvider ?? null,
            confirmationTimeoutHours: body.data.confirmationTimeoutHours ?? null, effectiveFrom,
          }).returning();
          return projectRevision(existing, scheduled!);
        }
        const [updated] = await db
          .update(domainPolicies)
          .set({
            policy: body.data.policy,
            requiresConfirmation: body.data.requiresConfirmation,
            confirmationTemplate: body.data.confirmationTemplate ?? null,
            modelProvider: body.data.modelProvider ?? null,
            confirmationTimeoutHours: body.data.confirmationTimeoutHours ?? null,
            // §3.1: a real edit is a real new version — never caller-supplied (a
            // client can't be trusted to increment its own audit trail), always +1
            // from whatever's actually stored, regardless of what body.data.version says.
            version,
            effectiveFrom,
          })
          .where(eq(domainPolicies.id, existing.id))
          .returning();
        await db.insert(domainPolicyRevisions).values({
          tenantId: ctx.tenantId, policyId: updated!.id, actionType, version: updated!.version,
          policy: updated!.policy, requiresConfirmation: updated!.requiresConfirmation,
          confirmationTemplate: updated!.confirmationTemplate, modelProvider: updated!.modelProvider,
          confirmationTimeoutHours: updated!.confirmationTimeoutHours, effectiveFrom,
        });
        return updated!;
      }
      const [created] = await db
        .insert(domainPolicies)
        .values({
          tenantId: ctx.tenantId,
          actionType,
          policy: body.data.policy,
          requiresConfirmation: body.data.requiresConfirmation,
          confirmationTemplate: body.data.confirmationTemplate ?? null,
          modelProvider: body.data.modelProvider ?? null,
          confirmationTimeoutHours: body.data.confirmationTimeoutHours ?? null,
          effectiveFrom,
          // version omitted — column default (1) applies to a genuinely first-ever row.
        })
        .returning();
      await db.insert(domainPolicyRevisions).values({
        tenantId: ctx.tenantId, policyId: created!.id, actionType, version: created!.version,
        policy: created!.policy, requiresConfirmation: created!.requiresConfirmation,
        confirmationTemplate: created!.confirmationTemplate, modelProvider: created!.modelProvider,
        confirmationTimeoutHours: created!.confirmationTimeoutHours, effectiveFrom,
      });
      return created!;
    });
    return Response.json({ policy: row });
  } catch (err) {
    return errorResponse(err);
  }
}
