import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  actionLog,
  beginWorkQueryExecution,
  domainActions,
  externalContacts,
  externalOrganizations,
  finishWorkQueryExecution,
  orgUnitMemberships,
  orgUnits,
  tasks,
  tenantLocations,
  tenants,
  users,
  withTenant,
  workflowRuns,
  works,
  type WorkQueryIntent,
} from "@finnor/db";
import {
  CANONICAL_ENTITY_TYPES,
  OPERATIONAL_QUERY_VERSION,
  canonicalEntityRefToPartyRef,
  isRetiredWaterCanonicalEntity,
  isRetiredWaterQuery,
  partyRefToCanonicalEntityRef,
  type AgentActivityRequest,
  type AgentActivityResult,
  type AttentionQueueRequest,
  type CanonicalEntityNode,
  type CanonicalEntityRef,
  type CanonicalOperationalQueryRequest,
  type CompanyContext,
  type CompanyContextRequest,
  type CompanyContextResult,
  type CoreOperationalQueryRequest,
  type OperationalLocalDateRange,
  type OperationalQueryExecutionRef,
  type OperationalQueryPageInfo,
  type OperationalQueryResult,
  type OperationalQueryResultFor,
  type PartyContextRequest,
  type PartyLookupRequest,
  type TeamRosterRequest,
  type WorkforceStatusRequest,
  type WorkListRequest,
  type WorkListResult,
} from "@finnor/shared-types";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { executePartyOperationalQuery, type PartyReadExecutionContext } from "./party-queries";
import { resolveParty } from "./party-resolver";
import { executeAttentionQueueQuery } from "./attention-query";
import { workforceStatus } from "./workforce-status";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ACTIVE_ENTITY_TYPES = new Set<string>(CANONICAL_ENTITY_TYPES);

export interface OperationalQueryOptions {
  workId?: string;
  workInputId?: string | null;
  executionKey?: string;
  now?: (() => Date) | Date;
  maxRows?: number;
  employeeId?: string;
  userId?: string;
  /** Resolved by the tenant-aware dispatcher. Direct read-model callers may omit
   * it; attention_queue then resolves canonical tenant vertical truth itself. */
  verticalKey?: string;
}

function nowFor(options: OperationalQueryOptions): Date {
  const value = typeof options.now === "function" ? options.now() : options.now ?? new Date();
  if (Number.isNaN(value.getTime())) throw new Error("Operational query clock returned an invalid date");
  return value;
}

function limitFor(page: { limit?: number } | undefined, options: OperationalQueryOptions): number {
  const requested = page?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(requested) || requested < 1) throw new Error("Operational query page limit must be positive");
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.maxRows ?? requested)));
}

function page(limit: number, returned: number): OperationalQueryPageInfo {
  return { limit, returned, totalCount: returned, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false };
}

function base<I extends CoreOperationalQueryRequest["intent"]>(
  intent: I,
  tables: string[],
  limit: number,
  returned: number,
  asOf: string,
) {
  const source = { kind: "canonical_postgres" as const, tables: [...new Set(tables)].sort() };
  const pageInfo = page(limit, returned);
  return {
    kind: "operational_query_result" as const,
    status: "ok" as const,
    data: {},
    version: OPERATIONAL_QUERY_VERSION,
    intent,
    source,
    asOf,
    count: returned,
    truncated: false,
    page: pageInfo,
    meta: { version: OPERATIONAL_QUERY_VERSION, source, asOf },
  };
}

function toDateRange(request: AgentActivityRequest, now: Date): { start: Date; end: Date; range: { start: string; end: string } } {
  const end = request.range ? new Date(request.range.end) : now;
  const start = request.range ? new Date(request.range.start) : new Date(end.getTime() - 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw new Error("Invalid operational query range");
  return { start, end, range: { start: start.toISOString(), end: end.toISOString() } };
}

async function workList(tenantId: string, request: WorkListRequest, options: OperationalQueryOptions, now: Date): Promise<WorkListResult> {
  const limit = limitFor(request.page, options);
  const statuses = request.statuses?.length ? request.statuses : null;
  const result = await withTenant(tenantId, async (db) => {
    const workRows = request.section === "tasks" ? [] : await db.select({
      id: works.id, status: works.status, channel: works.initialChannel, sessionId: works.sessionId,
      createdAt: works.createdAt, updatedAt: works.updatedAt,
    }).from(works).where(and(
      eq(works.tenantId, tenantId),
      request.recordId ? eq(works.id, request.recordId) : undefined,
      request.openOnly ? inArray(works.status, ["received", "understanding", "planning", "ready", "actionable", "awaiting_approval", "executing", "waiting", "blocked", "recovery"]) : undefined,
      statuses ? inArray(works.status, statuses as Array<(typeof works.$inferSelect)["status"]>) : undefined,
    )).orderBy(desc(works.updatedAt)).limit(limit);
    const taskRows = request.section === "works" ? [] : await db.select({
      id: tasks.id, subjectType: tasks.subjectType, subjectId: tasks.subjectId, title: tasks.title,
      dueAt: tasks.dueAt, assignedPartyType: tasks.assignedPartyType, assignedPartyId: tasks.assignedPartyId,
      status: tasks.status, priority: tasks.priority, createdAt: tasks.createdAt,
    }).from(tasks).where(and(
      eq(tasks.tenantId, tenantId),
      request.recordId ? eq(tasks.id, request.recordId) : undefined,
      request.openOnly ? eq(tasks.status, "open") : undefined,
      statuses ? inArray(tasks.status, statuses as Array<(typeof tasks.$inferSelect)["status"]>) : undefined,
    )).orderBy(desc(tasks.createdAt)).limit(limit);
    return { workRows, taskRows };
  });
  const worksResult = result.workRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  const tasksResult = result.taskRows.map((row) => ({ ...row, dueAt: row.dueAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }));
  const total = worksResult.length + tasksResult.length;
  const value = base("work_list", ["works", "tasks"], limit, total, now.toISOString());
  return {
    ...value,
    works: worksResult,
    tasks: tasksResult,
    sectionPages: { works: page(limit, worksResult.length), tasks: page(limit, tasksResult.length) },
    data: { works: worksResult, tasks: tasksResult },
  };
}

async function agentActivity(tenantId: string, request: AgentActivityRequest, options: OperationalQueryOptions, now: Date): Promise<AgentActivityResult> {
  const limit = limitFor(request.page, options);
  const { start, end, range } = toDateRange(request, now);
  const [tenant] = await withTenant(tenantId, (db) => db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1));
  const rows = await withTenant(tenantId, async (db) => {
    const [employeeRows, actionRows, workflowRows] = await Promise.all([
      db.select({ id: users.id, displayName: users.displayName, role: users.role, createdAt: users.createdAt }).from(users)
        .where(and(eq(users.tenantId, tenantId), gte(users.createdAt, start), lt(users.createdAt, end))).orderBy(desc(users.createdAt)).limit(limit),
      db.select({ id: actionLog.id, actionType: domainActions.actionType, status: domainActions.status, step: actionLog.step, occurredAt: actionLog.timestamp })
        .from(actionLog).innerJoin(domainActions, and(eq(domainActions.tenantId, actionLog.tenantId), eq(domainActions.id, actionLog.domainActionId)))
        .where(and(eq(actionLog.tenantId, tenantId), gte(actionLog.timestamp, start), lt(actionLog.timestamp, end)))
        .orderBy(desc(actionLog.timestamp)).limit(limit),
      db.select({ id: workflowRuns.id, workflowType: workflowRuns.workflowType, status: workflowRuns.status, occurredAt: workflowRuns.createdAt })
        .from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), gte(workflowRuns.createdAt, start), lt(workflowRuns.createdAt, end)))
        .orderBy(desc(workflowRuns.createdAt)).limit(limit),
    ]);
    return { employeeRows, actionRows, workflowRows };
  });
  const employeeRows = rows.employeeRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  const actionRows = rows.actionRows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
  const workflowRows = rows.workflowRows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
  const total = employeeRows.length + actionRows.length + workflowRows.length;
  const value = base("agent_activity", ["users", "action_log", "domain_actions", "workflow_runs"], limit, total, now.toISOString());
  return {
    ...value,
    range,
    timeZone: tenant?.timezone ?? "UTC",
    ...(request.localDateRange ? { localDateRange: request.localDateRange as OperationalLocalDateRange } : {}),
    users: employeeRows,
    actions: actionRows,
    workflows: workflowRows,
    sectionPages: { users: page(limit, employeeRows.length), actions: page(limit, actionRows.length), workflows: page(limit, workflowRows.length) },
    data: { users: employeeRows, actions: actionRows, workflows: workflowRows },
  };
}

async function nodeFor(tenantId: string, ref: CanonicalEntityRef): Promise<CanonicalEntityNode | null> {
  if (isRetiredWaterCanonicalEntity(ref.entityType) || !ACTIVE_ENTITY_TYPES.has(ref.entityType)) {
    throw new Error("Canonical entity type is unavailable in the active runtime");
  }
  return withTenant(tenantId, async (db) => {
    if (ref.entityType === "user") {
      const [row] = await db.select({ id: users.id, label: users.displayName, status: users.status, at: users.createdAt }).from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.status, occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "org_unit") {
      const [row] = await db.select({ id: orgUnits.id, label: orgUnits.name, active: orgUnits.active, at: orgUnits.createdAt }).from(orgUnits)
        .where(and(eq(orgUnits.tenantId, tenantId), eq(orgUnits.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.active ? "active" : "inactive", occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "tenant_location") {
      const [row] = await db.select({ id: tenantLocations.id, label: tenantLocations.name, active: tenantLocations.active, at: tenantLocations.createdAt }).from(tenantLocations)
        .where(and(eq(tenantLocations.tenantId, tenantId), eq(tenantLocations.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.active ? "active" : "inactive", occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "external_organization") {
      const [row] = await db.select({ id: externalOrganizations.id, label: externalOrganizations.name, active: externalOrganizations.active, at: externalOrganizations.createdAt }).from(externalOrganizations)
        .where(and(eq(externalOrganizations.tenantId, tenantId), eq(externalOrganizations.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.active ? "active" : "inactive", occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "external_contact") {
      const [row] = await db.select({ id: externalContacts.id, label: externalContacts.name, active: externalContacts.active, at: externalContacts.createdAt }).from(externalContacts)
        .where(and(eq(externalContacts.tenantId, tenantId), eq(externalContacts.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.active ? "active" : "inactive", occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "work") {
      const [row] = await db.select({ id: works.id, status: works.status, at: works.updatedAt }).from(works)
        .where(and(eq(works.tenantId, tenantId), eq(works.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: "Work", status: row.status, occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "task") {
      const [row] = await db.select({ id: tasks.id, label: tasks.title, status: tasks.status, at: tasks.createdAt }).from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.status, occurredAt: row.at.toISOString() } : null;
    }
    if (ref.entityType === "domain_action") {
      const [row] = await db.select({ id: domainActions.id, label: domainActions.actionType, status: domainActions.status, at: domainActions.createdAt }).from(domainActions)
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, ref.entityId))).limit(1);
      return row ? { entityType: ref.entityType, entityId: row.id, label: row.label, status: row.status, occurredAt: row.at.toISOString() } : null;
    }
    return { entityType: ref.entityType, entityId: ref.entityId, label: null, status: null, occurredAt: null };
  });
}

export async function companyContext(tenantId: string, anchor: CompanyContextRequest["anchor"]): Promise<CompanyContext | null> {
  if (!anchor) return null;
  const canonical = "partyType" in anchor ? partyRefToCanonicalEntityRef(anchor) : anchor;
  const node = await nodeFor(tenantId, canonical);
  if (!node) return null;
  const party = canonicalEntityRefToPartyRef(canonical);
  const related = party ? await resolveParty(tenantId, { ref: party }) : null;
  const sourceTables = canonical.entityType === "user" ? ["users"]
    : canonical.entityType === "org_unit" ? ["org_units", "org_unit_memberships"]
      : canonical.entityType === "tenant_location" ? ["tenant_locations"]
        : canonical.entityType === "external_organization" ? ["external_organizations"]
          : canonical.entityType === "external_contact" ? ["external_contacts", "external_organizations"]
            : [canonical.entityType === "domain_action" ? "domain_actions" : `${canonical.entityType}s`];
  return {
    anchor,
    nodes: [node],
    relationships: [],
    truncated: false,
    source: { kind: "canonical_postgres", tables: sourceTables },
    asOf: new Date().toISOString(),
    ...(related ? {} : {}),
  };
}

async function companyContextQuery(tenantId: string, request: CompanyContextRequest, options: OperationalQueryOptions, now: Date): Promise<CompanyContextResult> {
  let anchor = request.anchor;
  let resolution: CompanyContextResult["resolution"] = anchor ? "exact" : "not_found";
  if (!anchor && request.query) {
    const party = await resolveParty(tenantId, { query: request.query }, { requesterEmployeeId: options.employeeId, workId: options.workId });
    resolution = party.status === "resolved" ? "unique" : party.status;
    anchor = party.party?.ref;
  }
  const context = anchor ? await companyContext(tenantId, anchor) : null;
  if (anchor && !context) resolution = "not_found";
  const value = base("company_context", context?.source.tables ?? [], 1, context ? 1 : 0, now.toISOString());
  return {
    ...value,
    status: resolution === "exact" || resolution === "unique" ? "ok" : resolution,
    resolution,
    context,
    data: { context },
  };
}

async function runCoreQuery(
  tenantId: string,
  request: CoreOperationalQueryRequest,
  options: OperationalQueryOptions,
  now: Date,
): Promise<OperationalQueryResult> {
  if (request.intent === "work_list") return workList(tenantId, request, options, now);
  if (request.intent === "attention_queue") return executeAttentionQueueQuery(tenantId, request as AttentionQueueRequest, options, now);
  if (request.intent === "agent_activity") return agentActivity(tenantId, request, options, now);
  if (request.intent === "workforce_status") return workforceStatus(tenantId, request as WorkforceStatusRequest, now);
  if (request.intent === "company_context") return companyContextQuery(tenantId, request, options, now);
  const context: PartyReadExecutionContext = {
    employeeId: options.employeeId,
    userId: options.userId,
    workId: options.workId,
    now,
    maxRows: options.maxRows,
  };
  return executePartyOperationalQuery(tenantId, request as PartyLookupRequest | PartyContextRequest | TeamRosterRequest, context);
}

function executionKey(request: CoreOperationalQueryRequest): string {
  return `core-query:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
}

export async function executeOperationalQuery<T extends CanonicalOperationalQueryRequest>(
  tenantId: string,
  request: T,
  options: OperationalQueryOptions = {},
): Promise<OperationalQueryResultFor<T>> {
  if (!tenantId.trim()) throw new Error("tenantId is required from authenticated context");
  if (Object.prototype.hasOwnProperty.call(request, "tenantId")) throw new Error("Operational query request must not contain tenantId");
  if (isRetiredWaterQuery(request.intent)) throw new Error("Operational query intent is retired");
  const active = new Set(["work_list", "attention_queue", "agent_activity", "workforce_status", "company_context", "party_lookup", "party_context", "team_roster"]);
  if (!active.has(request.intent)) throw new Error("Query belongs to a vertical-specific dispatcher");
  if (options.workInputId && !options.workId) throw new Error("workInputId requires workId");
  const now = nowFor(options);
  const started = performance.now();
  let claim: Awaited<ReturnType<typeof beginWorkQueryExecution>> | undefined;
  if (options.workId) {
    claim = await beginWorkQueryExecution({
      tenantId,
      workId: options.workId,
      workInputId: options.workInputId ?? null,
      intent: request.intent as WorkQueryIntent,
      request: request as unknown as Record<string, unknown>,
      executionKey: options.executionKey ?? executionKey(request as CoreOperationalQueryRequest),
    });
  }
  try {
    const result = await runCoreQuery(tenantId, request as CoreOperationalQueryRequest, options, now);
    if (!claim) return result as OperationalQueryResultFor<T>;
    await finishWorkQueryExecution({
      tenantId,
      executionId: claim.id,
      status: "succeeded",
      rowCount: result.count,
      durationMs: Math.max(0, performance.now() - started),
      resultSummary: { intent: result.intent, returned: result.count, truncated: result.truncated },
    });
    const execution: OperationalQueryExecutionRef = {
      id: claim.id,
      workId: claim.workId,
      workInputId: claim.workInputId,
      executionKey: claim.executionKey,
      status: "succeeded",
    };
    return { ...result, execution } as OperationalQueryResultFor<T>;
  } catch (error) {
    if (claim) await finishWorkQueryExecution({
      tenantId,
      executionId: claim.id,
      status: "failed",
      rowCount: 0,
      durationMs: Math.max(0, performance.now() - started),
      failure: { code: "CORE_QUERY_FAILED" },
    }).catch(() => undefined);
    throw error;
  }
}
