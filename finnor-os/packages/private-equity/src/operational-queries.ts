import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  beginWorkQueryExecution,
  finishWorkQueryExecution,
  withTenantTransaction,
  type WorkQueryIntent,
} from "@finnor/db";
import type { OperationalQueryOptions } from "@finnor/read-models";
import {
  OPERATIONAL_QUERY_VERSION,
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  type CanonicalOperationalQueryRequest,
  type ClosingReadinessResult,
  type CriticalDependenciesResult,
  type DealContextResult,
  type DealWorkstreamsResult,
  type OpenDealRisksResult,
  type OpenFindingsResult,
  type OpenRequestsResult,
  type PeWorldStateResult,
  type OperationalQueryExecutionRef,
  type OperationalQueryPageInfo,
  type OperationalQueryResultFor,
  type PrivateEquityOperationalQueryIntent,
  type PrivateEquityEpistemicWarning,
  type PartyRef,
} from "@finnor/shared-types";
import { buildPrivateEquityEpistemicSnapshot } from "./epistemic";
import { evaluateDealCloseEligibility, loadDealExecutionGraph } from "./repository";
import { loadPrivateEquityWorldState } from "./world-state";
import { isPositiveDependencyResolution } from "./state-machines";
import { loadPrivateEquityAssertions } from "./source-mapping";
import { PeDomainError, type DealCloseEligibility, type DealExecutionGraph, type PeMutationContext } from "./types";

export type PrivateEquityOperationalQueryRequest = Extract<CanonicalOperationalQueryRequest, { intent: PrivateEquityOperationalQueryIntent }>;
type DealScopedPrivateEquityOperationalQueryRequest = Exclude<PrivateEquityOperationalQueryRequest, { intent: "pe_world_state" }>;
export type PrivateEquityOperationalQueryResult =
  | PeWorldStateResult
  | DealContextResult
  | DealWorkstreamsResult
  | OpenRequestsResult
  | OpenFindingsResult
  | OpenDealRisksResult
  | CriticalDependenciesResult
  | ClosingReadinessResult;

const PE_INTENTS = new Set<string>(PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS);
const MAX_ROWS = 100;
const DEFAULT_ROWS = 50;
const MAX_DEPENDENCY_DEPTH = 16;

interface PageCursor {
  v: 1;
  intent: PrivateEquityOperationalQueryIntent;
  dealId: string;
  graphVersion: number;
  offset: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pick(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => row[field] === undefined ? [] : [[field, row[field]]]));
}

const DEAL_FIELDS = [
  "id", "name", "codeName", "status", "targetOrganizationId", "dealLeadEmployeeId", "signedLoiAt",
  "targetClosingAt", "version", "graphVersion", "createdAt", "updatedAt",
  "actualCloseAt", "closeAuthorityDecisionId", "closeDecisionReceiptId",
] as const;
const WORKSTREAM_FIELDS = [
  "id", "dealId", "kind", "name", "state", "ownerPartyType", "ownerPartyId", "targetAt", "dueAt",
  "requiredForClose", "requiredForWorkstreamCompletion", "createdAt", "updatedAt",
] as const;
const REQUEST_FIELDS = [
  "id", "dealId", "workstreamId", "requestText", "requestedFromDealPartyId", "ownerPartyType", "ownerPartyId",
  "dueAt", "state", "requiresAcceptedDeliverable", "createdAt", "updatedAt",
] as const;
const FINDING_FIELDS = [
  "id", "dealId", "workstreamId", "relatedRequestId", "statement", "severity", "materiality", "ownerPartyType",
  "ownerPartyId", "state", "createdAt", "updatedAt",
] as const;
const RISK_FIELDS = [
  "id", "dealId", "workstreamId", "statement", "severity", "ownerPartyType", "ownerPartyId", "response", "state",
  "createdAt", "updatedAt",
] as const;

function resultPage(limit: number, returned: number, total: number, offset: number, cursor: string | null): OperationalQueryPageInfo {
  const hasMore = offset + returned < total;
  return {
    limit,
    returned,
    totalCount: total,
    totalCountExact: true,
    hasMore,
    nextCursor: hasMore ? cursor : null,
    truncated: hasMore,
  };
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, request: DealScopedPrivateEquityOperationalQueryRequest, graphVersion: number): number {
  if (!value) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PageCursor;
    if (decoded.v !== 1 || decoded.intent !== request.intent || decoded.dealId !== request.dealId
        || decoded.graphVersion !== graphVersion || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error("mismatch");
    }
    return decoded.offset;
  } catch {
    throw new Error("Invalid or stale PE operational query cursor");
  }
}

function pageRows<T>(rows: T[], request: DealScopedPrivateEquityOperationalQueryRequest, graphVersion: number, options: OperationalQueryOptions): {
  rows: T[];
  page: OperationalQueryPageInfo;
} {
  const requested = request.page?.limit ?? DEFAULT_ROWS;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Operational query page limit must be positive");
  const callerCap = options.maxRows === undefined ? MAX_ROWS : Math.max(1, Math.min(MAX_ROWS, Math.floor(options.maxRows)));
  const limit = Math.min(callerCap, Math.floor(requested));
  const offset = decodeCursor(request.page?.cursor, request, graphVersion);
  const selected = rows.slice(offset, offset + limit);
  const nextCursor = encodeCursor({ v: 1, intent: request.intent, dealId: request.dealId, graphVersion, offset: offset + selected.length });
  return { rows: selected, page: resultPage(limit, selected.length, rows.length, offset, nextCursor) };
}

function base<I extends PrivateEquityOperationalQueryIntent>(intent: I, tables: string[], asOf: string, page: OperationalQueryPageInfo) {
  const source = { kind: "canonical_postgres" as const, tables: [...new Set(tables)].sort() };
  return {
    kind: "operational_query_result" as const,
    status: "ok" as const,
    data: {},
    version: OPERATIONAL_QUERY_VERSION,
    intent,
    source,
    asOf,
    count: page.returned,
    truncated: page.truncated,
    page,
    meta: { version: OPERATIONAL_QUERY_VERSION, source, asOf },
  };
}

function groupCount(rows: Array<Record<string, unknown>>, field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function authContext(tenantId: string, options: OperationalQueryOptions): PeMutationContext {
  return {
    auth: {
      tenantId,
      userId: options.userId ?? options.employeeId ?? tenantId,
      employeeId: options.employeeId,
      role: "owner",
    },
    provenance: { sourceSystem: "operational_query:private_equity", createdBy: options.userId ?? options.employeeId ?? tenantId },
  };
}

async function consistentDealRead(ctx: PeMutationContext, dealId: string, now: Date): Promise<{ graph: DealExecutionGraph; eligibility: DealCloseEligibility }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const graph = await loadDealExecutionGraph(ctx, dealId, now);
    const eligibility = await evaluateDealCloseEligibility(ctx, dealId);
    if (Number(graph.deal.graphVersion) === eligibility.graphVersion) return { graph, eligibility };
  }
  throw new PeDomainError("PE_GRAPH_CHANGED_DURING_READ", "Deal graph changed during the bounded read; retry the query");
}

function entityState(graph: DealExecutionGraph): Map<string, string> {
  const result = new Map<string, string>();
  for (const [type, rows] of [
    ["pe_workstream", graph.workstreams], ["pe_request", graph.requests], ["pe_deliverable", graph.deliverables],
    ["pe_finding", graph.findings], ["pe_deal_risk", graph.dealRisks], ["pe_milestone", graph.milestones],
    ["pe_closing_condition", graph.closingConditions], ["pe_closing_item", graph.closingItems],
  ] as const) for (const row of rows) result.set(`${type}:${String(row.id)}`, String(row.state));
  return result;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function entityMetadata(graph: DealExecutionGraph): Map<string, { state: string | null; dueAt: string | null; owner?: { partyType: string; partyId: string } }> {
  const metadata = new Map<string, { state: string | null; dueAt: string | null; owner?: { partyType: string; partyId: string } }>();
  const add = (entityType: string, rows: readonly Record<string, unknown>[], dueFields: readonly string[] = []) => {
    for (const row of rows) {
      const owner = typeof row.ownerPartyType === "string" && typeof row.ownerPartyId === "string"
        ? { partyType: row.ownerPartyType, partyId: row.ownerPartyId }
        : undefined;
      const dueAt = dueFields.map((field) => isoOrNull(row[field])).find((value): value is string => value !== null) ?? null;
      metadata.set(`${entityType}:${String(row.id)}`, { state: typeof row.state === "string" ? row.state : null, dueAt, ...(owner ? { owner } : {}) });
    }
  };
  add("pe_workstream", graph.workstreams, ["dueAt", "targetAt"]);
  add("pe_request", graph.requests, ["dueAt"]);
  add("pe_deliverable", graph.deliverables, ["dueAt"]);
  add("pe_finding", graph.findings);
  add("pe_deal_risk", graph.dealRisks);
  add("pe_milestone", graph.milestones, ["targetAt"]);
  add("pe_closing_condition", graph.closingConditions);
  add("pe_closing_item", graph.closingItems);
  return metadata;
}

function dependencyRows(graph: DealExecutionGraph, includeResolved: boolean): CriticalDependenciesResult["rows"] {
  const states = entityState(graph);
  const metadata = entityMetadata(graph);
  const workByEntity = new Map<string, Array<{ workId: string; entityType: string; entityId: string }>>();
  for (const link of graph.workLinks) {
    const entityType = String(link.entityType);
    const entityId = String(link.entityId);
    const item = { workId: String(link.workId), entityType, entityId };
    const key = `${entityType}:${entityId}`;
    workByEntity.set(key, [...(workByEntity.get(key) ?? []), item]);
  }
  const dependencies = graph.dependencies.map((row) => {
    const blocker = { entityType: String(row.blockerType), entityId: String(row.blockerId) };
    const blocked = { entityType: String(row.blockedType), entityId: String(row.blockedId) };
    const resolved = Boolean(row.removedAt) || isPositiveDependencyResolution(blocker.entityType, states.get(`${blocker.entityType}:${blocker.entityId}`) ?? "");
    const blockerMeta = metadata.get(`${blocker.entityType}:${blocker.entityId}`);
    const blockedMeta = metadata.get(`${blocked.entityType}:${blocked.entityId}`);
    const ownerRefs = [blockerMeta?.owner, blockedMeta?.owner]
      .filter((owner): owner is { partyType: string; partyId: string } => owner !== undefined
      && ["employee", "team", "location", "external_organization", "external_contact"].includes(owner.partyType))
      .map((owner) => ({ partyType: owner.partyType as PartyRef["partyType"], partyId: owner.partyId }));
    const workRefs = [...(workByEntity.get(`${blocker.entityType}:${blocker.entityId}`) ?? []), ...(workByEntity.get(`${blocked.entityType}:${blocked.entityId}`) ?? [])]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.workId === item.workId && candidate.entityType === item.entityType && candidate.entityId === item.entityId) === index)
      .slice(0, MAX_ROWS);
    return {
      dependencyId: String(row.id),
      blocker,
      blocked,
      resolved,
      blockerState: blockerMeta?.state ?? null,
      blockedState: blockedMeta?.state ?? null,
      blockerDueAt: blockerMeta?.dueAt ?? null,
      blockedDueAt: blockedMeta?.dueAt ?? null,
      workRefs,
      ownerRefs,
    };
  });
  const active = dependencies.filter((row) => !row.resolved);
  const outgoing = new Map<string, typeof active>();
  for (const edge of active) {
    const key = `${edge.blocker.entityType}:${edge.blocker.entityId}`;
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  const pathsFrom = (edge: typeof active[number]): Array<Array<{ entityType: string; entityId: string }>> => {
    const first = [edge.blocker, edge.blocked];
    const paths: Array<Array<{ entityType: string; entityId: string }>> = [];
    const visit = (path: typeof first, seen: Set<string>): void => {
      const tail = path[path.length - 1]!;
      const key = `${tail.entityType}:${tail.entityId}`;
      if (path.length >= MAX_DEPENDENCY_DEPTH || tail.entityType === "pe_closing_condition" || tail.entityType === "pe_closing_item") {
        paths.push(path);
        return;
      }
      const next = outgoing.get(key)?.filter((candidate) => !seen.has(candidate.dependencyId)) ?? [];
      if (!next.length) {
        paths.push(path);
        return;
      }
      for (const candidate of next.slice(0, MAX_ROWS)) visit([...path, candidate.blocked], new Set(seen).add(candidate.dependencyId));
    };
    visit(first, new Set([edge.dependencyId]));
    return paths.slice(0, MAX_ROWS);
  };
  return dependencies.filter((row) => includeResolved || !row.resolved).map((row) => ({ ...row, paths: row.resolved ? [] : pathsFrom(row) }));
}

function warningsForEntity(
  warnings: readonly PrivateEquityEpistemicWarning[],
  dealId: string,
  entityType: "pe_finding" | "pe_deal_risk",
  entityId: string,
  predicate: "finding.current" | "deal_risk.current",
): PrivateEquityEpistemicWarning[] {
  const propositionId = `pe:v1:${dealId}:${entityType}:${entityId}:${predicate}`;
  return warnings.filter((warning) => warning.propositionId === propositionId).slice(0, MAX_ROWS);
}

function findings(graph: DealExecutionGraph, warnings: readonly PrivateEquityEpistemicWarning[] = []): OpenFindingsResult["rows"] {
  return graph.findings.filter((row) => row.state === "open").map((row) => ({
    ...pick(row, FINDING_FIELDS),
    id: String(row.id),
    state: String(row.state),
    evidenceRefs: graph.evidenceLinks.filter((link) => link.entityType === "pe_finding" && link.entityId === row.id && !link.archivedAt).map((link) => String(link.evidenceVersionId ?? link.evidenceSourceId)).sort(),
    riskRefs: graph.findingRiskLinks.filter((link) => link.findingId === row.id).map((link) => String(link.dealRiskId)).sort(),
    epistemicWarnings: warningsForEntity(warnings, String(graph.deal.id), "pe_finding", String(row.id), "finding.current"),
  }));
}

function risks(graph: DealExecutionGraph, warnings: readonly PrivateEquityEpistemicWarning[] = []): OpenDealRisksResult["rows"] {
  return graph.dealRisks.filter((row) => ["open", "mitigating"].includes(String(row.state))).map((row) => ({
    ...pick(row, RISK_FIELDS),
    id: String(row.id),
    state: String(row.state),
    evidenceRefs: graph.evidenceLinks.filter((link) => link.entityType === "pe_deal_risk" && link.entityId === row.id && !link.archivedAt).map((link) => String(link.evidenceVersionId ?? link.evidenceSourceId)).sort(),
    findingRefs: graph.findingRiskLinks.filter((link) => link.dealRiskId === row.id).map((link) => String(link.findingId)).sort(),
    epistemicWarnings: warningsForEntity(warnings, String(graph.deal.id), "pe_deal_risk", String(row.id), "deal_risk.current"),
  }));
}

function filterRequest(request: PrivateEquityOperationalQueryRequest, graph: DealExecutionGraph, warnings: readonly PrivateEquityEpistemicWarning[] = []): Record<string, unknown>[] {
  if (request.intent === "deal_workstreams") {
    return graph.workstreams.filter((row) => (!request.states?.length || request.states.includes(String(row.state)))
      && (!request.owner || (row.ownerPartyType === request.owner.partyType && row.ownerPartyId === request.owner.partyId)));
  }
  if (request.intent === "open_requests") {
    return graph.requests.filter((row) => ["open", "acknowledged"].includes(String(row.state))
      && (!request.workstreamId || row.workstreamId === request.workstreamId)
      && (request.dueState === undefined || request.dueState === "any" || (request.dueState === "overdue") === Boolean(row.overdue))
      && (!request.requestedFrom || graph.dealParties.some((party) => party.id === row.requestedFromDealPartyId
        && party.partyType === request.requestedFrom!.partyType && party.partyId === request.requestedFrom!.partyId)));
  }
  if (request.intent === "open_findings") {
    return findings(graph, warnings).filter((row) => (!request.workstreamId || row.workstreamId === request.workstreamId)
      && (!request.severities?.length || request.severities.includes(row.severity as never)));
  }
  if (request.intent === "open_deal_risks") {
    return risks(graph, warnings).filter((row) => (!request.workstreamId || row.workstreamId === request.workstreamId)
      && (!request.severities?.length || request.severities.includes(row.severity as never)));
  }
  return [];
}

async function targetAndLead(tenantId: string, graph: DealExecutionGraph, options: OperationalQueryOptions) {
  return withTenantTransaction(tenantId, { userId: options.userId, readOnly: true }, async (_db, client) => {
    const result = await client.query<{ target_id: string; target_name: string; lead_id: string; lead_name: string }>(
      `SELECT o.id::text target_id,o.name target_name,u.id::text lead_id,coalesce(u.display_name,u.email) lead_name
         FROM finnor_os.external_organizations o
         JOIN finnor_os.users u ON u.tenant_id=o.tenant_id AND u.id=$3::uuid
        WHERE o.tenant_id=$1 AND o.id=$2::uuid LIMIT 1`,
      [tenantId, graph.deal.targetOrganizationId, graph.deal.dealLeadEmployeeId],
    );
    const row = result.rows[0];
    return row ? { target: { id: row.target_id, name: row.target_name }, lead: { id: row.lead_id, name: row.lead_name } } : { target: null, lead: null };
  });
}

async function runQuery(
  tenantId: string,
  request: PrivateEquityOperationalQueryRequest,
  options: OperationalQueryOptions,
  now: Date,
): Promise<PrivateEquityOperationalQueryResult> {
  const ctx = authContext(tenantId, options);
  if (request.intent === "pe_world_state") {
    const world = await loadPrivateEquityWorldState(ctx, request.root, request.at);
    const page = resultPage(1, 1, 1, 0, null);
    return {
      ...base("pe_world_state", [
        "canonical_entity_versions", "canonical_history_coverage", "pe_strategies", "pe_opportunities",
        "pe_deals", "pe_investment_cases", "pe_theses", "pe_assumptions", "pe_decisions",
        "pe_deal_parties", "pe_workstreams", "pe_requests", "pe_deliverables", "pe_findings",
        "pe_deal_risks", "pe_dependencies", "pe_milestones", "pe_closing_conditions", "pe_closing_items",
        "pe_document_links", "pe_evidence_links", "evidence_source_versions", "business_events",
        "authority_decisions", "decision_receipts", "external_ref_observations",
        "integration_source_scopes", "integration_source_coverage_history",
      ], world.stateAt, page),
      ...world,
    };
  }
  const { graph, eligibility } = await consistentDealRead(ctx, request.dealId, now);
  const graphVersion = Number(graph.deal.graphVersion);
  const asOf = now.toISOString();

  const needsEpistemic = request.intent === "deal_context"
    || request.intent === "open_findings"
    || request.intent === "open_deal_risks"
    || request.intent === "closing_readiness";
  const epistemic = needsEpistemic
    ? buildPrivateEquityEpistemicSnapshot({
        tenantId,
        principalId: options.employeeId ?? options.userId ?? tenantId,
        dealId: request.dealId,
        graph,
        eligibility,
        assertions: await loadPrivateEquityAssertions(ctx, request.dealId, 200, now),
        asOf,
      })
    : null;

  if (request.intent === "deal_workstreams") {
    const unresolved = new Set(dependencyRows(graph, false).flatMap((row) => [
      `${row.blocker.entityType}:${row.blocker.entityId}`,
      `${row.blocked.entityType}:${row.blocked.entityId}`,
    ]));
    const all = filterRequest(request, graph).map((row) => ({ ...pick(row, WORKSTREAM_FIELDS), id: String(row.id), state: String(row.state), blocking: unresolved.has(`pe_workstream:${String(row.id)}`) }));
    const selected = pageRows(all, request, graphVersion, options);
    return { ...base("deal_workstreams", ["pe_workstreams", "pe_dependencies"], asOf, selected.page), rows: selected.rows };
  }
  if (request.intent === "open_requests") {
    const all = filterRequest(request, graph).map((row) => ({ ...pick(row, REQUEST_FIELDS), id: String(row.id), state: String(row.state), overdue: Boolean(row.overdue) }));
    const selected = pageRows(all, request, graphVersion, options);
    return { ...base("open_requests", ["pe_requests", "pe_deal_parties"], asOf, selected.page), rows: selected.rows };
  }
  if (request.intent === "open_findings") {
    const all = filterRequest(request, graph, epistemic?.warnings ?? []) as OpenFindingsResult["rows"];
    const selected = pageRows(all, request, graphVersion, options);
    return { ...base("open_findings", ["pe_findings", "pe_evidence_links", "pe_finding_risk_links"], asOf, selected.page), rows: selected.rows, epistemicWarnings: epistemic?.warnings.slice(0, MAX_ROWS) ?? [] };
  }
  if (request.intent === "open_deal_risks") {
    const all = filterRequest(request, graph, epistemic?.warnings ?? []) as OpenDealRisksResult["rows"];
    const selected = pageRows(all, request, graphVersion, options);
    return { ...base("open_deal_risks", ["pe_deal_risks", "pe_evidence_links", "pe_finding_risk_links"], asOf, selected.page), rows: selected.rows, epistemicWarnings: epistemic?.warnings.slice(0, MAX_ROWS) ?? [] };
  }
  if (request.intent === "critical_dependencies") {
    const all = dependencyRows(graph, request.includeResolved ?? false);
    const selected = pageRows(all, request, graphVersion, options);
    return { ...base("critical_dependencies", ["pe_dependencies", "pe_closing_conditions", "pe_closing_items"], asOf, selected.page), rows: selected.rows };
  }

  if (!epistemic) throw new Error("PE epistemic snapshot was not prepared for this query");
  if (request.intent === "deal_context") {
    const identity = await targetAndLead(tenantId, graph, options);
    const workRefs = graph.workLinks.slice(0, MAX_ROWS).map((link) => ({ workId: String(link.workId), relationship: String(link.relationship) }));
    const singleton = pageRows([graph.deal], request, graphVersion, options);
    return {
      ...base("deal_context", ["pe_deals", "pe_workstreams", "pe_requests", "pe_findings", "pe_deal_risks", "work_entity_links"], asOf, singleton.page),
      deal: pick(graph.deal, DEAL_FIELDS),
      ...identity,
      counts: {
        workstreams: groupCount(graph.workstreams, "state"),
        requests: groupCount(graph.requests, "state"),
        deliverables: groupCount(graph.deliverables, "state"),
        findings: groupCount(graph.findings, "state"),
        dealRisks: groupCount(graph.dealRisks, "state"),
        closingConditions: groupCount(graph.closingConditions, "state"),
        closingItems: groupCount(graph.closingItems, "state"),
      },
      workRefs,
      epistemicWarnings: epistemic.warnings.slice(0, MAX_ROWS),
    };
  }
  const critical = dependencyRows(graph, false).slice(0, MAX_ROWS);
  const relevantFindings = findings(graph, epistemic?.warnings ?? []).slice(0, MAX_ROWS);
  const relevantDealRisks = risks(graph, epistemic?.warnings ?? []).slice(0, MAX_ROWS);
  const singleton = pageRows([eligibility], request, graphVersion, options);
  return {
    ...base("closing_readiness", [
      "pe_deals", "pe_closing_conditions", "pe_closing_items", "pe_dependencies", "pe_findings",
      "pe_deal_risks", "pe_evidence_links", "evidence_source_versions",
    ], asOf, singleton.page),
    dealId: request.dealId,
    eligible: eligibility.eligible,
    eligibility: asRecord(eligibility),
    blockingConditions: eligibility.blockingConditions.slice(0, MAX_ROWS).map((row) => ({ ...row })),
    failedConditions: eligibility.failedConditions.slice(0, MAX_ROWS).map((row) => ({ ...row })),
    unverifiedClosingItems: eligibility.unverifiedClosingItems.slice(0, MAX_ROWS).map((row) => ({ ...row })),
    blockingDependencies: eligibility.blockingDependencies.slice(0, MAX_ROWS).map((row) => ({ ...row })),
    invalidWaivers: eligibility.invalidWaivers.slice(0, MAX_ROWS).map((row) => ({ ...row })),
    integrityErrors: eligibility.integrityErrors.slice(0, MAX_ROWS),
    criticalDependencies: critical,
    relevantFindings,
    relevantDealRisks,
    epistemicWarnings: epistemic.warnings.slice(0, MAX_ROWS),
    decisionReadiness: epistemic.decisions.slice(0, MAX_ROWS),
    queryTrace: ["closing_readiness", "critical_dependencies", "open_findings", "open_deal_risks"],
  };
}

function executionKey(request: PrivateEquityOperationalQueryRequest): string {
  return `pe-query:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
}

export function isPrivateEquityOperationalQuery(request: CanonicalOperationalQueryRequest): request is PrivateEquityOperationalQueryRequest {
  return PE_INTENTS.has(request.intent);
}

export async function executePrivateEquityOperationalQuery<T extends PrivateEquityOperationalQueryRequest>(
  tenantId: string,
  request: T,
  options: OperationalQueryOptions = {},
): Promise<OperationalQueryResultFor<T>> {
  if (!tenantId.trim()) throw new Error("tenantId is required from authenticated context");
  if (Object.prototype.hasOwnProperty.call(request, "tenantId")) throw new Error("Operational query request must not contain tenantId");
  if (!PE_INTENTS.has(request.intent)) throw new Error("Unsupported private-equity operational query intent");
  const now = typeof options.now === "function" ? options.now() : options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Operational query clock returned an invalid date");
  if (options.workInputId && !options.workId) throw new Error("workInputId requires workId");
  const started = performance.now();
  let claim: Awaited<ReturnType<typeof beginWorkQueryExecution>> | undefined;
  if (options.workId) {
    claim = await beginWorkQueryExecution({
      tenantId,
      workId: options.workId,
      workInputId: options.workInputId ?? null,
      intent: request.intent as WorkQueryIntent,
      request: request as unknown as Record<string, unknown>,
      executionKey: options.executionKey ?? executionKey(request),
    });
  }
  try {
    const result = await runQuery(tenantId, request, options, now);
    if (!claim) return result as OperationalQueryResultFor<T>;
    await finishWorkQueryExecution({
      tenantId,
      executionId: claim.id,
      status: "succeeded",
      rowCount: result.count,
      durationMs: Math.max(0, performance.now() - started),
      resultSummary: {
        intent: result.intent,
        returned: result.count,
        truncated: result.truncated,
        ...(request.intent === "pe_world_state" ? { root: request.root, stateAt: result.asOf } : { dealId: request.dealId }),
      },
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
      failure: { code: error instanceof PeDomainError ? error.code : "PE_QUERY_FAILED" },
    }).catch(() => undefined);
    throw error;
  }
}

export interface PrivateEquityDealCandidate {
  dealId: string;
  name: string;
  codeName: string | null;
  targetName: string;
  lifecycleState: string;
}

export type PrivateEquityDealResolution =
  | { status: "resolved"; dealId: string; matchedBy: "work" | "id" | "name" | "only_active_deal"; candidates: [PrivateEquityDealCandidate] }
  | { status: "ambiguous"; candidates: PrivateEquityDealCandidate[] }
  | { status: "not_found"; candidates: [] };

/** Resolves Deal identity before natural-language query interpretation. Work
 * anchors are authoritative and exact; text is only a bounded disambiguation aid. */
export async function resolvePrivateEquityDealReference(
  tenantId: string,
  instruction: string,
  options: { workId?: string; userId?: string } = {},
): Promise<PrivateEquityDealResolution> {
  return withTenantTransaction(tenantId, { userId: options.userId, readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const candidatesForIds = async (ids?: string[]) => {
      const result = await client.query<{
        deal_id: string; name: string; code_name: string | null; target_name: string; lifecycle_state: string;
      }>(
        `SELECT d.id::text deal_id,d.name,d.code_name,o.name target_name,d.status lifecycle_state
           FROM finnor_os.pe_deals d
           JOIN finnor_os.external_organizations o ON o.tenant_id=d.tenant_id AND o.id=d.target_organization_id
          WHERE d.tenant_id=$1 AND ($2::uuid[] IS NULL OR d.id=ANY($2::uuid[]))
          ORDER BY d.target_closing_at,d.id LIMIT 101`,
        [tenantId, ids?.length ? ids : null],
      );
      return result.rows.map((row): PrivateEquityDealCandidate => ({
        dealId: row.deal_id,
        name: row.name,
        codeName: row.code_name,
        targetName: row.target_name,
        lifecycleState: row.lifecycle_state,
      }));
    };

    if (options.workId) {
      const anchored = await client.query<{ deal_id: string }>(
        `SELECT DISTINCT finnor_os.pe_entity_deal(l.entity_type,l.entity_id)::text deal_id
           FROM finnor_os.work_entity_links l
           JOIN finnor_os.canonical_truth_registry r ON r.entity_type=l.entity_type AND r.vertical_key='private_equity'
          WHERE l.tenant_id=$1 AND l.work_id=$2::uuid
            AND finnor_os.pe_entity_deal(l.entity_type,l.entity_id) IS NOT NULL
          ORDER BY deal_id LIMIT 3`,
        [tenantId, options.workId],
      );
      const rows = await candidatesForIds(anchored.rows.map((row) => row.deal_id));
      if (rows.length === 1) return { status: "resolved", dealId: rows[0]!.dealId, matchedBy: "work", candidates: [rows[0]!] };
      if (rows.length > 1) return { status: "ambiguous", candidates: rows };
    }

    const explicitId = instruction.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
    if (explicitId) {
      const rows = await candidatesForIds([explicitId]);
      return rows[0]
        ? { status: "resolved", dealId: rows[0].dealId, matchedBy: "id", candidates: [rows[0]] }
        : { status: "not_found", candidates: [] };
    }

    const all = await candidatesForIds();
    const normalized = instruction.toLocaleLowerCase();
    const matches = all.filter((candidate) => [candidate.name, candidate.codeName, candidate.targetName]
      .filter((value): value is string => Boolean(value?.trim()))
      .some((value) => normalized.includes(value.toLocaleLowerCase())));
    if (matches.length === 1) return { status: "resolved", dealId: matches[0]!.dealId, matchedBy: "name", candidates: [matches[0]!] };
    if (matches.length > 1) return { status: "ambiguous", candidates: matches.slice(0, 10) };
    const active = all.filter((candidate) => candidate.lifecycleState === "active");
    if (active.length === 1) return { status: "resolved", dealId: active[0]!.dealId, matchedBy: "only_active_deal", candidates: [active[0]!] };
    return active.length > 1 ? { status: "ambiguous", candidates: active.slice(0, 10) } : { status: "not_found", candidates: [] };
  });
}

export type PrivateEquityQuestionInterpretation =
  | { route: "fast_read"; request: PrivateEquityOperationalQueryRequest; resolution: PrivateEquityDealResolution }
  | { route: "clarify"; reason: "ambiguous_deal" | "deal_not_found"; resolution: PrivateEquityDealResolution }
  | { route: "planner"; reason: "not_pe_question" | "mutation_or_advice" };

export async function interpretPrivateEquityQuestion(
  tenantId: string,
  instruction: string,
  options: { workId?: string; userId?: string } = {},
): Promise<PrivateEquityQuestionInterpretation> {
  const normalized = instruction.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 500) return { route: "planner", reason: "not_pe_question" };
  if (/\b(?:create|update|change|mark|send|email|call|approve|accept|waive|satisfy|verify|close|terminate|cancel|assign|execute|draft|write)\b/i.test(normalized)
      && !/^\s*(?:what|which|why|how|can|could|would|is|are|show|list|tell|summarize|explain)\b/i.test(normalized)) {
    return { route: "planner", reason: "mutation_or_advice" };
  }
  const peMention = /\b(?:deal|closing|close|workstream|request|deliverable|finding|risk|dependency|milestone|loi|lender|diligence|block|stop|waiting|readiness)\b/i.test(normalized);
  // An exact Work attachment is stronger than NLP. This deliberately lets
  // "what's still missing here?" resolve through its Deal/condition anchors.
  if (!peMention && !options.workId) return { route: "planner", reason: "not_pe_question" };
  const resolution = await resolvePrivateEquityDealReference(tenantId, normalized, options);
  if (resolution.status === "ambiguous") return { route: "clarify", reason: "ambiguous_deal", resolution };
  if (resolution.status === "not_found") return { route: "clarify", reason: "deal_not_found", resolution };
  const dealId = resolution.dealId;
  let request: PrivateEquityOperationalQueryRequest;
  if (/\b(?:closing|close|readiness|block|stop|waiting|missing|lender)\b/i.test(normalized)) request = { intent: "closing_readiness", dealId };
  else if (/\bdependenc/i.test(normalized)) request = { intent: "critical_dependencies", dealId };
  else if (/\brequest/i.test(normalized)) request = { intent: "open_requests", dealId };
  else if (/\bfinding/i.test(normalized)) request = { intent: "open_findings", dealId };
  else if (/\brisk/i.test(normalized)) request = { intent: "open_deal_risks", dealId };
  else if (/\bworkstream/i.test(normalized)) request = { intent: "deal_workstreams", dealId };
  else request = { intent: "deal_context", dealId };
  return { route: "fast_read", request, resolution };
}
