import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { InstitutionHarnessProgram } from "./contracts";
import { frozenRequestExpectation, observeExactCreatedRequest } from "./request-observer";
import { canonicalInstitutionJson } from "../institution-program/canonical-json";

type Node = InstitutionHarnessProgram["nodes"][number];
type Row = Record<string, unknown>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const iso = (value: unknown) => value instanceof Date || typeof value === "string"
  ? Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null : null;
const entities = { create_deal_request: "pe_request", open_workstream: "pe_workstream", record_finding: "pe_finding" } as const;

/** Native PE grounding adds only owner-generated Work/graph witnesses. Preserve
 * every business field, and verify those witnesses instead of treating native
 * enrichment as a different intent or blindly discarding arbitrary fields. */
export function matchesFrozenInstitutionIntent(intent: Record<string, unknown>, actual: unknown, workId: string, grounded = false) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const payload = actual as Record<string, unknown>, { workId: actualWork, grounding, ...business } = payload;
  if (actualWork === undefined && grounding === undefined) return !grounded
    && canonicalInstitutionJson(payload) === canonicalInstitutionJson(intent);
  if (actualWork !== workId || !grounding || typeof grounding !== "object" || Array.isArray(grounding)) return false;
  const g = grounding as { verticalKey?: unknown; work?: { entityType?: unknown; entityId?: unknown };
    deal?: { entityType?: unknown; entityId?: unknown } };
  return g.verticalKey === "private_equity" && g.work?.entityType === "work" && g.work.entityId === workId
    && g.deal?.entityType === "pe_deal" && g.deal.entityId === intent.dealId
    && canonicalInstitutionJson(business) === canonicalInstitutionJson(intent);
}

/** The frozen intent and each owner's canonical reader determine completion.
 * DomainAction/BusinessEffect receipts are prerequisites, never this observer. */
export function frozenDutyExpectation(tenantId: string, node: Node) {
  const action = node.action;
  if (!action || action.operation !== node.operation || !(node.operation in entities)
      || !text(action.payload.dealId) || !Number.isFinite(Date.parse(node.deadlineAt))) {
    throw Error("X1_FROZEN_ORDINARY_DUTY_REQUIRED");
  }
  if (node.operation === "create_deal_request") {
    const request = frozenRequestExpectation(tenantId, node);
    return { entityType: "pe_request", entityId: request.requestId, dealId: request.dealId,
      operation: "create_deal_request", request, fields: null, deadlineAt: node.deadlineAt } as const;
  }
  const p = action.payload;
  const owner = p.owner as Record<string, unknown> | undefined;
  if (!owner || !["employee", "team"].includes(String(owner.partyType)) || !text(owner.partyId)) {
    throw Error("X1_FROZEN_INTERNAL_OWNER_REQUIRED");
  }
  const shared = { tenant_id: tenantId, id: action.expectedEntityId, deal_id: p.dealId,
    owner_party_type: owner.partyType, owner_party_id: owner.partyId, archived_at: null };
  if (node.operation === "open_workstream") {
    if (p.workstreamId !== action.expectedEntityId || !text(p.name)
        || !["financial_diligence", "legal", "tax", "commercial", "technology", "financing",
          "insurance", "regulatory", "closing", "custom"].includes(String(p.kind))) {
      throw Error("X1_FROZEN_WORKSTREAM_FIELDS_REQUIRED");
    }
    return { entityType: "pe_workstream", entityId: action.expectedEntityId, dealId: String(p.dealId),
      operation: "open_workstream", request: null, deadlineAt: node.deadlineAt,
      fields: { ...shared, kind: p.kind, name: p.name.trim(), state: "not_started",
        completed_at: null, cancelled_at: null } } as const;
  }
  if (p.findingId !== action.expectedEntityId || !text(p.workstreamId) || !text(p.statement)
      || !["low", "medium", "high", "critical"].includes(String(p.severity))
      || !["immaterial", "non_material", "material", "critical"].includes(String(p.materiality))
      || typeof p.requiredForWorkstreamCompletion !== "boolean") {
    throw Error("X1_FROZEN_FINDING_FIELDS_REQUIRED");
  }
  return { entityType: "pe_finding", entityId: action.expectedEntityId, dealId: String(p.dealId),
    operation: "record_finding", request: null, deadlineAt: node.deadlineAt,
    fields: { ...shared, workstream_id: p.workstreamId,
      related_request_id: p.relatedRequestId ?? null, related_deliverable_id: p.relatedDeliverableId ?? null,
      statement: p.statement.trim(), severity: p.severity, materiality: p.materiality,
      required_for_workstream_completion: p.requiredForWorkstreamCompletion,
      state: "open", disposition: null, resolved_at: null, accepted_at: null, superseded_at: null } } as const;
}

export function observeExactCreatedDuty(expected: ReturnType<typeof frozenDutyExpectation>, row: Row | null) {
  if (expected.request) return observeExactCreatedRequest(expected.request,
    row as Parameters<typeof observeExactCreatedRequest>[1]);
  const createdAt = row ? iso(row.created_at) : null;
  const timely = createdAt !== null && Date.parse(createdAt) <= Date.parse(expected.deadlineAt);
  const fields = row && Object.fromEntries(Object.keys(expected.fields!).map(key => [key, row[key]]));
  const observed = Boolean(timely && fields && Object.entries(expected.fields!).every(([key, value]) => fields[key] === value));
  return { observed, observerDigest: observed ? digest({ fields, createdAt }) : null };
}

export async function readCanonicalDuty(c: PoolClient, tenantId: string, node: Node) {
  const expected = frozenDutyExpectation(tenantId, node);
  // Only this closed operation registry selects a table; no caller SQL names.
  const table = expected.entityType === "pe_request" ? "pe_requests"
    : expected.entityType === "pe_workstream" ? "pe_workstreams" : "pe_findings";
  const row = (await c.query<Row>(`SELECT *,clock_timestamp() AS x1_observed_at,
    CASE WHEN current_setting('track_commit_timestamp')='on'
      THEN pg_xact_commit_timestamp(xmin) ELSE NULL END AS x1_committed_at FROM finnor_os.${table}
    WHERE tenant_id=$1 AND id=$2 AND deal_id=$3 FOR SHARE`,
  [tenantId, expected.entityId, expected.dealId])).rows[0] ?? null;
  const structural=observeExactCreatedDuty(expected,row);
  const observedAt=row?iso(row.x1_observed_at):null,committedAt=row?iso(row.x1_committed_at):null;
  // A backdated creation column cannot establish visibility before a deadline.
  // A within-deadline independent read or actual commit timestamp can.
  const timelyVisibility=observedAt!==null&&(Date.parse(observedAt)<=Date.parse(expected.deadlineAt)
    ||committedAt!==null&&Date.parse(committedAt)<=Date.parse(expected.deadlineAt));
  return { observed:structural.observed&&timelyVisibility,
    observerDigest:structural.observed&&timelyVisibility?digest({structural:structural.observerDigest,observedAt,committedAt}):null,
    observedAt,committedAt,
    canonicalRef: `${expected.entityType}:${expected.entityId}` };
}
