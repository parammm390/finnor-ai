import { createHash } from "node:crypto";
import type { InstitutionHarnessProgram } from "./contracts";

type Action = NonNullable<InstitutionHarnessProgram["nodes"][number]["action"]>;
type RequestRow = {
  tenant_id: string; id: string; deal_id: string; workstream_id: string;
  requested_from_deal_party_id: string; owner_party_type: string; owner_party_id: string;
  request_text: string; requested_at: Date | string; due_at: Date | string | null;
  requires_accepted_deliverable: boolean; state: string; acknowledged_at: Date | null;
  fulfilled_at: Date | null; cancelled_at: Date | null; archived_at: Date | null;
  created_at: Date | string;
};
type Expected = {
  tenantId: string; requestId: string; dealId: string; workstreamId: string;
  requestedFromDealPartyId: string; owner: { partyType: string; partyId: string };
  requestText: string; requestedAt: string; dueAt: string;
  requiresAcceptedDeliverable: boolean; originalDeadline: string;
};
const instant = (value: Date | string | null) => value === null ? null :
  Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compare the independent canonical PE reader against the *frozen* requested
 * creation state. A receipt, charge or mere row existence cannot satisfy this. */
export function observeExactCreatedRequest(expected: Expected, row: RequestRow | null) {
  const fields = row && {
    tenantId: row.tenant_id, requestId: row.id, dealId: row.deal_id,
    workstreamId: row.workstream_id, requestedFromDealPartyId: row.requested_from_deal_party_id,
    owner: { partyType: row.owner_party_type, partyId: row.owner_party_id },
    requestText: row.request_text, requestedAt: instant(row.requested_at), dueAt: instant(row.due_at),
    requiresAcceptedDeliverable: row.requires_accepted_deliverable,
    state: row.state, acknowledgedAt: row.acknowledged_at, fulfilledAt: row.fulfilled_at,
    cancelledAt: row.cancelled_at, archivedAt: row.archived_at,
  };
  const desired = {
    tenantId: expected.tenantId, requestId: expected.requestId, dealId: expected.dealId,
    workstreamId: expected.workstreamId, requestedFromDealPartyId: expected.requestedFromDealPartyId,
    owner: { partyType: expected.owner.partyType, partyId: expected.owner.partyId },
    requestText: expected.requestText, requestedAt: instant(expected.requestedAt),
    dueAt: instant(expected.dueAt), requiresAcceptedDeliverable: expected.requiresAcceptedDeliverable,
    state: "open", acknowledgedAt: null, fulfilledAt: null, cancelledAt: null, archivedAt: null,
  };
  const validDeadline = Number.isFinite(Date.parse(expected.originalDeadline))
    && desired.requestedAt !== null && desired.dueAt !== null
    && desired.requestedAt <= desired.dueAt && desired.dueAt <= instant(expected.originalDeadline)!;
  // requested_at is business input and can describe an earlier date. Only the
  // canonical owner's creation timestamp establishes when the effect happened.
  const createdAt = row ? instant(row.created_at) : null;
  const timelyCreation = createdAt !== null && validDeadline
    && createdAt <= instant(expected.originalDeadline)!;
  return { observed: Boolean(row && timelyCreation && JSON.stringify(fields) === JSON.stringify(desired)),
    observerDigest: row && timelyCreation ? digest({ ...fields, createdAt }) : null };
}

export function frozenRequestExpectation(tenantId: string, node: InstitutionHarnessProgram["nodes"][number]): Expected {
  const action: Action | null = node.action;
  if (node.operation !== "create_deal_request" || !action || action.operation !== node.operation
    || !action.payload || Array.isArray(action.payload)) throw Error("X1_EXACT_REQUEST_ACTION_REQUIRED");
  const p = action.payload;
  if (typeof p.dealId !== "string" || typeof p.requestId !== "string"
    || p.requestId !== action.expectedEntityId
    || typeof p.workstreamId !== "string" || typeof p.requestedFromDealPartyId !== "string"
    || typeof p.requestText !== "string" || !p.requestText.trim()
    || typeof p.requestedAt !== "string" || typeof p.dueAt !== "string"
    || typeof p.requiresAcceptedDeliverable !== "boolean"
    || !p.owner || Array.isArray(p.owner) || typeof p.owner !== "object"
    || typeof (p.owner as Record<string, unknown>).partyType !== "string"
    || typeof (p.owner as Record<string, unknown>).partyId !== "string"
    || !Number.isFinite(Date.parse(p.requestedAt)) || !Number.isFinite(Date.parse(p.dueAt))
    || !Number.isFinite(Date.parse(node.deadlineAt))) throw Error("X1_REQUEST_FROZEN_FIELDS_REQUIRED");
  const owner = p.owner as { partyType: string; partyId: string };
  if (!["employee", "team"].includes(owner.partyType)
    || Date.parse(node.deadlineAt) < Date.parse(p.dueAt)
    || Date.parse(p.dueAt) < Date.parse(p.requestedAt))
    throw Error("X1_REQUEST_DEADLINE_OR_OWNER_MISMATCH");
  return { tenantId, requestId: p.requestId, dealId: p.dealId,
    workstreamId: p.workstreamId, requestedFromDealPartyId: p.requestedFromDealPartyId,
    owner, requestText: p.requestText.trim(), requestedAt: p.requestedAt, dueAt: p.dueAt,
    requiresAcceptedDeliverable: p.requiresAcceptedDeliverable, originalDeadline: node.deadlineAt };
}
