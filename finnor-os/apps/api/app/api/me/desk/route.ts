import {
  authorityApprovalRequests, authorityApprovalRequestSteps, domainActions, employeeVisibleWork,
  withTenantTransaction, workEvents, works,
} from "@finnor/db";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";

const EMPLOYEE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers = { "cache-control": "private, no-store" };
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

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const tenantId = ctx.tenantId;
    const employeeId = ctx.employeeId ?? ctx.userId;
    if (!EMPLOYEE_UUID.test(employeeId)) {
      return Response.json({ error: "Canonical employee required" }, { status: 403, headers });
    }
    const responsibility = and(eq(works.tenantId, tenantId), employeeVisibleWork(employeeId),
      or(eq(works.currentOwnerId, employeeId), eq(works.assignedTo, employeeId)));
    return await withTenantTransaction(tenantId, { userId: employeeId, readOnly: true, isolation: "repeatable read" }, async db => {
      const rows = await db.select({
        id: works.id, instruction: works.initialInstruction, status: works.status, updatedAt: works.updatedAt,
      }).from(works).where(responsibility).orderBy(desc(works.updatedAt), desc(works.id)).limit(20);
      if (!rows.length) return Response.json({ works: [] }, { headers });
      const selected = inArray(works.id, rows.map(row => row.id));

      const recentEvents = db.select({
        sequence: workEvents.seq, type: workEvents.eventType, status: workEvents.toStatus, createdAt: workEvents.createdAt,
      }).from(workEvents)
        .where(and(eq(workEvents.tenantId, tenantId), eq(workEvents.workId, works.id)))
        .orderBy(desc(workEvents.seq)).limit(5).as("recent_event");
      const eventRows = await db.select({ workId: works.id, event: {
        sequence: recentEvents.sequence, type: recentEvents.type, status: recentEvents.status, createdAt: recentEvents.createdAt,
      } }).from(works)
        .innerJoinLateral(recentEvents, sql`true`).where(and(responsibility, selected))
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
        .from(works).innerJoinLateral(evidenceEvents, sql`true`).where(and(responsibility, selected))
        .orderBy(asc(evidenceEvents.sequence));

      const nextApproval = db.select({
        actionId: domainActions.id, actionType: domainActions.actionType, summary: domainActions.summary,
        sequence: authorityApprovalRequestSteps.sequence,
        approverCapability: authorityApprovalRequestSteps.approverCapability,
      }).from(domainActions)
        .innerJoin(authorityApprovalRequests, and(eq(authorityApprovalRequests.tenantId, tenantId),
          eq(authorityApprovalRequests.domainActionId, domainActions.id), eq(authorityApprovalRequests.status, "pending")))
        .innerJoin(authorityApprovalRequestSteps, and(eq(authorityApprovalRequestSteps.tenantId, tenantId),
          eq(authorityApprovalRequestSteps.approvalRequestId, authorityApprovalRequests.id),
          eq(authorityApprovalRequestSteps.sequence, authorityApprovalRequests.currentStep),
          eq(authorityApprovalRequestSteps.status, "pending")))
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, works.id),
          inArray(domainActions.status, ["pending", "needs_human_review"])))
        .orderBy(desc(authorityApprovalRequests.createdAt), desc(authorityApprovalRequests.id))
        .limit(5).as("next_approval");
      const approvalRows = await db.select({ workId: works.id, approval: {
        actionId: nextApproval.actionId, actionType: nextApproval.actionType, summary: nextApproval.summary,
        sequence: nextApproval.sequence, approverCapability: nextApproval.approverCapability,
      } }).from(works)
        .innerJoinLateral(nextApproval, sql`true`).where(and(responsibility, selected))
        .orderBy(nextApproval.actionId);

      return Response.json({ works: rows.map(row => ({
        ...row, href: `/centropy/workforce?workId=${row.id}`,
        events: eventRows.filter(item => item.workId === row.id).map(item => item.event),
        evidence: evidenceFromWorkEvents(evidenceRows.filter(item => item.workId === row.id)),
        approvals: approvalRows.filter(item => item.workId === row.id).map(({ approval }) => ({
          ...approval, approverCapability: approval.approverCapability.replaceAll("$action", approval.actionType),
        })),
      })) }, { headers });
    });
  } catch (err) {
    const response = errorResponse(err);
    response.headers.set("cache-control", headers["cache-control"]);
    return response;
  }
}
