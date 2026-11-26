import { canExerciseAuthorityBatch } from "@finnor/authority";
import {
  authorityApprovalRequests, authorityApprovalRequestSteps, businessEffects, domainActions, employeeVisibleWork,
  withTenantTransaction, workEvents, works,
} from "@finnor/db";
import type { AuthorityRequest, AuthorityResource, TenantContext } from "@finnor/shared-types";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requestEmployee } from "./work-access";

const evidenceCited = "evidence_version_cited";
const evidenceObserved = "evidence_version_observed";
const versionRecord = z.object({
  sourceId: z.string().uuid(), id: z.string().uuid(), versionNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i), asOf: z.string().datetime(),
});
type Version = Omit<z.infer<typeof versionRecord>, "sourceId">;

function evidenceFromWorkEvents(events: { type: string; version: unknown }[]) {
  const evidence = new Map<string, { cited: Version; current: Version }>();
  for (const event of events) {
    const record = versionRecord.safeParse(event.version);
    if (!record.success) continue;
    const { sourceId, ...version } = record.data;
    if (event.type === evidenceCited) {
      evidence.set(sourceId, { cited: version, current: version });
    } else {
      const item = evidence.get(sourceId);
      if (item && version.versionNumber > item.current.versionNumber) item.current = version;
    }
  }
  return Array.from(evidence, ([sourceId, item]) => ({
    sourceId, ...item, changed: item.current.versionNumber > item.cited.versionNumber,
  }));
}

export async function readEmployeeDesk(ctx: TenantContext, workId?: string) {
  const { tenantId } = ctx;
  const employeeId = requestEmployee(ctx);
  const visibility = and(eq(works.tenantId, tenantId), employeeVisibleWork(employeeId),
    workId ? eq(works.id, workId) : or(eq(works.currentOwnerId, employeeId), eq(works.assignedTo, employeeId)));
  const { rows, eventRows, evidenceRows, approvalRows } = await withTenantTransaction(
    tenantId, { userId: employeeId, readOnly: true, isolation: "repeatable read" }, async db => {
      const rows = await db.select({
        id: works.id, instruction: works.initialInstruction, status: works.status, updatedAt: works.updatedAt,
      }).from(works).where(visibility).orderBy(desc(works.updatedAt), desc(works.id)).limit(workId ? 1 : 20);
      if (!rows.length) return { rows, eventRows: [], evidenceRows: [], approvalRows: [] };
      const selected = inArray(works.id, rows.map(row => row.id));

      const recentEvents = db.select({
        sequence: workEvents.seq, type: workEvents.eventType, status: workEvents.toStatus, createdAt: workEvents.createdAt,
      }).from(workEvents)
        .where(and(eq(workEvents.tenantId, tenantId), eq(workEvents.workId, works.id)))
        .orderBy(desc(workEvents.seq)).limit(5).as("recent_event");
      const eventRows = await db.select({ workId: works.id, event: {
        sequence: recentEvents.sequence, type: recentEvents.type, status: recentEvents.status, createdAt: recentEvents.createdAt,
      } }).from(works)
        .innerJoinLateral(recentEvents, sql`true`).where(and(visibility, selected))
        .orderBy(desc(recentEvents.sequence));

      const evidenceEvents = db.select({
        sequence: workEvents.seq, type: workEvents.eventType,
        version: sql<unknown>`jsonb_build_object('sourceId', ${workEvents.payload}->'sourceId',
          'id', ${workEvents.payload}->'id', 'versionNumber', ${workEvents.payload}->'versionNumber',
          'contentHash', ${workEvents.payload}->'contentHash', 'asOf', ${workEvents.payload}->'asOf')`.as("version"),
      }).from(workEvents)
        .where(and(eq(workEvents.tenantId, tenantId), eq(workEvents.workId, works.id),
          inArray(workEvents.eventType, [evidenceCited, evidenceObserved])))
        .orderBy(desc(workEvents.seq)).limit(50).as("evidence_event");
      const evidenceRows = await db.select({ workId: works.id, type: evidenceEvents.type, version: evidenceEvents.version })
        .from(works).innerJoinLateral(evidenceEvents, sql`true`).where(and(visibility, selected))
        .orderBy(asc(evidenceEvents.sequence));

      const nextApproval = db.select({
        actionId: domainActions.id, actionType: domainActions.actionType, summary: domainActions.summary,
        sequence: authorityApprovalRequestSteps.sequence,
        approverCapability: authorityApprovalRequestSteps.approverCapability,
        authorityContext: domainActions.authorityContext,
        businessEffectId: domainActions.businessEffectId,
        effectHash: businessEffects.semanticHash,
        effectBound: sql<boolean>`(${domainActions.businessEffectId} IS NULL OR (
          ${businessEffects.semanticHash} IS NOT NULL
          AND ${authorityApprovalRequests.businessEffectId} IS NOT DISTINCT FROM ${domainActions.businessEffectId}
          AND ${authorityApprovalRequests.businessEffectHash} IS NOT DISTINCT FROM ${businessEffects.semanticHash}
        ))`.as("effect_bound"),
      }).from(domainActions)
        .innerJoin(authorityApprovalRequests, and(eq(authorityApprovalRequests.tenantId, tenantId),
          eq(authorityApprovalRequests.domainActionId, domainActions.id), eq(authorityApprovalRequests.status, "pending")))
        .innerJoin(authorityApprovalRequestSteps, and(eq(authorityApprovalRequestSteps.tenantId, tenantId),
          eq(authorityApprovalRequestSteps.approvalRequestId, authorityApprovalRequests.id),
          eq(authorityApprovalRequestSteps.sequence, authorityApprovalRequests.currentStep),
          eq(authorityApprovalRequestSteps.status, "pending")))
        .leftJoin(businessEffects, and(eq(businessEffects.id, domainActions.businessEffectId),
          eq(businessEffects.tenantId, tenantId)))
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, works.id),
          inArray(domainActions.status, ["pending", "needs_human_review"])))
        .orderBy(desc(authorityApprovalRequests.createdAt), desc(authorityApprovalRequests.id))
        .limit(5).as("next_approval");
      const approvalRows = await db.select({ workId: works.id, approval: {
        actionId: nextApproval.actionId, actionType: nextApproval.actionType, summary: nextApproval.summary,
        sequence: nextApproval.sequence, approverCapability: nextApproval.approverCapability,
      }, authorityContext: nextApproval.authorityContext, businessEffectId: nextApproval.businessEffectId,
        effectHash: nextApproval.effectHash, effectBound: nextApproval.effectBound }).from(works)
        .innerJoinLateral(nextApproval, sql`true`).where(and(visibility, selected))
        .orderBy(nextApproval.actionId);
      return { rows, eventRows, evidenceRows, approvalRows };
    });

  const pending = approvalRows.map(item => {
    const capability = item.approval.approverCapability.replaceAll("$action", item.approval.actionType);
    const context = item.authorityContext as Record<string, unknown> | null;
    const resources = Array.isArray(context?.resources) ? context.resources.filter(
      (value): value is AuthorityResource => Boolean(value && typeof value === "object" && typeof value.type === "string"),
    ) : [];
    const request: AuthorityRequest = {
      operation: "approval", capability, resources, workId: item.workId, domainActionId: item.approval.actionId,
      risk: context?.risk === "low" || context?.risk === "high" ? context.risk : "medium",
      amountUsd: typeof context?.amountUsd === "number" ? context.amountUsd : undefined,
      businessEffectId: item.businessEffectId ?? undefined,
      businessEffectHash: item.effectHash ?? undefined,
    };
    return { workId: item.workId, approval: { ...item.approval, approverCapability: capability }, request, bound: item.effectBound };
  });
  const eligible = await canExerciseAuthorityBatch(ctx, pending.map(item => item.request));
  const approvals = pending.map(({ workId, approval, bound }, index) => ({
    workId, approval: { ...approval, actorCanReview: bound && eligible[index] === true },
  }));
  return rows.map(row => ({
    ...row, href: `/centropy/desk/work?workId=${row.id}`,
    events: eventRows.filter(item => item.workId === row.id).map(item => item.event),
    evidence: evidenceFromWorkEvents(evidenceRows.filter(item => item.workId === row.id)),
    approvals: approvals.filter(item => item.workId === row.id).map(item => item.approval),
  }));
}
