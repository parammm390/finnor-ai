import { randomUUID } from "node:crypto";
import type pg from "pg";
import { evaluateAuthority } from "@finnor/authority";
import { attachWorkEntityTx, withTenantTransaction, type Db } from "@finnor/db";
import { resolveParty } from "@finnor/read-models";
import type { PartyRef } from "@finnor/shared-types";
import { assertTransition, isMilestoneLate, isRequestOverdue } from "./state-machines";
import {
  DEAL_PARTY_ROLES,
  PE_DEPENDENCY_ENDPOINT_TYPES,
  PRIVATE_EQUITY_VERTICAL_KEY,
  WORKSTREAM_KINDS,
  DealCloseRejectedError,
  PeDomainError,
  type ClosingConditionState,
  type ClosingItemState,
  type DealCloseEligibility,
  type DealExecutionGraph,
  type DealPartyRole,
  type DeliverableState,
  type FindingState,
  type GovernanceProof,
  type InternalPartyRef,
  type MilestoneState,
  type PeDependencyEndpoint,
  type PeDependencyEndpointType,
  type PeEntityRef,
  type PeLifecycleName,
  type PeMutationContext,
  type PeMutationResult,
  type PePartyRef,
  type PeWorldRootRef,
  type RequestState,
  type WorkstreamKind,
  type WorkstreamState,
} from "./types";

export type SqlRow = Record<string, unknown>;
export type PeClient = pg.PoolClient;
type Client = PeClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9_]{1,62}$/;
const DEPENDENCY_TYPES = new Set<string>(PE_DEPENDENCY_ENDPOINT_TYPES);
const DEAL_PARTY_ROLE_SET = new Set<string>(DEAL_PARTY_ROLES);
const WORKSTREAM_KIND_SET = new Set<string>(WORKSTREAM_KINDS);

const LIFECYCLE_TABLES = {
  deal_party: "pe_deal_parties",
  workstream: "pe_workstreams",
  request: "pe_requests",
  deliverable: "pe_deliverables",
  finding: "pe_findings",
  deal_risk: "pe_deal_risks",
  milestone: "pe_milestones",
  closing_condition: "pe_closing_conditions",
  closing_item: "pe_closing_items",
} as const;

export function assertPeUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new PeDomainError("PE_INVALID_REFERENCE", `${label} must be a UUID`, { value });
}

export function assertPeText(value: string, label: string): void {
  if (!value.trim()) throw new PeDomainError("PE_INVALID_INPUT", `${label} is required`);
}

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export function shapePeRow(row: SqlRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camelKey(key), value]));
}

export function peProvenance(ctx: PeMutationContext): {
  sourceSystem: string;
  externalId: string | null;
  createdBy: string;
  observedAt: Date | null;
} {
  const createdBy = ctx.provenance?.createdBy ?? ctx.auth.employeeId ?? ctx.auth.userId;
  assertPeText(createdBy, "createdBy");
  return {
    sourceSystem: ctx.provenance?.sourceSystem?.trim() || "@finnor/private-equity",
    externalId: ctx.provenance?.externalId?.trim() || null,
    createdBy,
    observedAt: ctx.provenance?.observedAt ?? null,
  };
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code) return code;
  }
  return "cause" in error ? pgCode((error as { cause?: unknown }).cause) : undefined;
}

export async function peTransaction<T>(
  ctx: PeMutationContext,
  fn: (db: Db, client: Client) => Promise<T>,
  options: { readOnly?: boolean; isolation?: "read committed" | "repeatable read" | "serializable" } = {},
): Promise<T> {
  const source = peProvenance(ctx);
  const maxAttempts = options.readOnly ? 1 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTenantTransaction(ctx.auth.tenantId, {
        userId: ctx.auth.userId,
        isolation: options.isolation ?? (options.readOnly ? "repeatable read" : "serializable"),
        readOnly: options.readOnly,
      }, async (db, client) => {
        await client.query("SELECT set_config('app.pe_actor', $1, true), set_config('app.pe_source', $2, true)", [
          source.createdBy,
          source.sourceSystem,
        ]);
        const active = await client.query<{ vertical_key: string | null }>(
          "SELECT finnor_os.active_tenant_vertical($1::uuid) AS vertical_key",
          [ctx.auth.tenantId],
        );
        if (active.rows[0]?.vertical_key !== PRIVATE_EQUITY_VERTICAL_KEY) {
          throw new PeDomainError(
            "PE_VERTICAL_INACTIVE",
            `Private Equity is not the authenticated tenant's active vertical`,
            { activeVertical: active.rows[0]?.vertical_key ?? null },
          );
        }
        return fn(db, client);
      });
    } catch (error) {
      if (attempt < maxAttempts && (pgCode(error) === "40001" || pgCode(error) === "40P01")) continue;
      throw error;
    }
  }
  throw new PeDomainError("PE_TRANSACTION_RETRY_EXHAUSTED", "PE transaction retry exhausted");
}

function quotedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe internal SQL identifier: ${value}`);
  return `"${value}"`;
}

export async function insertPeRow(client: Client, table: string, values: Record<string, unknown>): Promise<SqlRow> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  const columns = entries.map(([column]) => quotedIdentifier(column)).join(",");
  const placeholders = entries.map((_entry, index) => `$${index + 1}`).join(",");
  const result = await client.query<SqlRow>(
    `INSERT INTO finnor_os.${quotedIdentifier(table)} (${columns}) VALUES (${placeholders}) RETURNING *`,
    entries.map(([, value]) => value),
  );
  const row = result.rows[0];
  if (!row) throw new PeDomainError("PE_WRITE_FAILED", `Insert into ${table} returned no canonical row`);
  return row;
}

export async function lockPeDeal(client: Client, tenantId: string, dealId: string): Promise<SqlRow> {
  assertPeUuid(dealId, "dealId");
  const result = await client.query<SqlRow>(
    "SELECT * FROM finnor_os.pe_deals WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    [tenantId, dealId],
  );
  const row = result.rows[0];
  if (!row) throw new PeDomainError("PE_DEAL_NOT_FOUND", "Deal was not found in the authenticated tenant");
  return row;
}

export function requireActivePeDeal(row: SqlRow): void {
  if (row.status !== "active") {
    throw new PeDomainError("PE_DEAL_TERMINAL", "A closed or terminated Deal graph is immutable", { status: row.status });
  }
}

async function getLifecycleRowForUpdate(
  client: Client,
  tenantId: string,
  table: string,
  id: string,
): Promise<SqlRow> {
  assertPeUuid(id, "entityId");
  const first = await client.query<{ deal_id: string }>(
    `SELECT deal_id FROM finnor_os.${quotedIdentifier(table)} WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, id],
  );
  const dealId = first.rows[0]?.deal_id;
  if (!dealId) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE entity was not found in the authenticated tenant");
  requireActivePeDeal(await lockPeDeal(client, tenantId, dealId));
  const locked = await client.query<SqlRow>(
    `SELECT * FROM finnor_os.${quotedIdentifier(table)} WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
    [tenantId, id],
  );
  const row = locked.rows[0];
  if (!row) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE entity was not found in the authenticated tenant");
  return row;
}

async function transitionTx(params: {
  client: Client;
  ctx: PeMutationContext;
  lifecycle: keyof typeof LIFECYCLE_TABLES;
  id: string;
  expectedVersion: number;
  targetState: string;
  updates?: Record<string, unknown>;
}): Promise<PeMutationResult> {
  const table = LIFECYCLE_TABLES[params.lifecycle];
  const row = await getLifecycleRowForUpdate(params.client, params.ctx.auth.tenantId, table, params.id);
  const currentState = String(row.state);
  if (currentState === params.targetState) {
    return { row: shapePeRow(row), changed: false, idempotent: true };
  }
  if (Number(row.version) !== params.expectedVersion) {
    throw new PeDomainError("PE_STALE_VERSION", "PE entity changed since it was read", {
      expectedVersion: params.expectedVersion,
      actualVersion: row.version,
    });
  }
  try {
    assertTransition(params.lifecycle, currentState, params.targetState);
  } catch {
    throw new PeDomainError("PE_INVALID_TRANSITION", `Invalid ${params.lifecycle} transition ${currentState} -> ${params.targetState}`);
  }

  const entries = Object.entries(params.updates ?? {}).filter(([, value]) => value !== undefined);
  const assignments = ["state=$3", ...entries.map(([column], index) => `${quotedIdentifier(column)}=$${index + 4}`)];
  assignments.push("version=version+1", "updated_at=now()");
  const result = await params.client.query<SqlRow>(
    `UPDATE finnor_os.${quotedIdentifier(table)} SET ${assignments.join(",")}
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND version=${params.expectedVersion} RETURNING *`,
    [params.ctx.auth.tenantId, params.id, params.targetState, ...entries.map(([, value]) => value)],
  );
  const updated = result.rows[0];
  if (!updated) throw new PeDomainError("PE_STALE_VERSION", "PE entity changed concurrently");
  return { row: shapePeRow(updated), changed: true, idempotent: false };
}

async function transition(params: Omit<Parameters<typeof transitionTx>[0], "client">): Promise<PeMutationResult> {
  return peTransaction(params.ctx, (_db, client) => transitionTx({ ...params, client }));
}

async function createChild(
  ctx: PeMutationContext,
  table: string,
  dealId: string,
  values: Record<string, unknown>,
): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    requireActivePeDeal(await lockPeDeal(client, ctx.auth.tenantId, dealId));
    const source = peProvenance(ctx);
    const row = await insertPeRow(client, table, {
      id: values.id ?? randomUUID(),
      tenant_id: ctx.auth.tenantId,
      deal_id: dealId,
      ...values,
      source_system: source.sourceSystem,
      external_id: source.externalId,
      created_by: source.createdBy,
      observed_at: source.observedAt,
    });
    return { row: shapePeRow(row), changed: true, idempotent: false };
  });
}

async function ensureParty(ctx: PeMutationContext, ref: PartyRef, allowed: readonly string[]): Promise<void> {
  if (!allowed.includes(ref.partyType)) {
    throw new PeDomainError("PE_PARTY_TYPE_UNSUPPORTED", `Party type ${ref.partyType} is not valid for this PE relationship`);
  }
  const resolution = await resolveParty(ctx.auth.tenantId, { ref }, { requesterEmployeeId: ctx.auth.employeeId });
  if (resolution.status !== "resolved" || !resolution.party
      || resolution.party.ref.partyType !== ref.partyType || resolution.party.ref.partyId !== ref.partyId) {
    throw new PeDomainError("PE_PARTY_NOT_RESOLVED", "PartyRef is missing, inactive, or outside the authenticated tenant", {
      partyType: ref.partyType,
      status: resolution.status,
    });
  }
}

export async function attachDocumentTx(client: Client, ctx: PeMutationContext, params: {
  dealId: string | null;
  worldRoot?: PeWorldRootRef;
  entity: PeEntityRef;
  documentId: string;
  linkRole: "source" | "submission" | "accepted" | "rejected" | "superseded" | "governing" | "verification";
  supersedesLinkId?: string;
}): Promise<PeMutationResult> {
  const worldRoot = params.worldRoot ?? (params.dealId ? { entityType: "pe_deal", entityId: params.dealId } as const : null);
  if (!worldRoot) throw new PeDomainError("PE_WORLD_ROOT_REQUIRED", "A PE Document link requires an explicit world root");
  if (worldRoot.entityType === "pe_deal") {
    if (params.dealId !== worldRoot.entityId) throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "Deal link root must equal dealId");
    requireActivePeDeal(await lockPeDeal(client, ctx.auth.tenantId, params.dealId));
  } else if (params.dealId !== null) {
    throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "Pre-Deal link roots cannot carry a synthetic dealId");
  }
  assertPeUuid(params.documentId, "documentId");
  const source = peProvenance(ctx);
  const result = await client.query<SqlRow>(
    `INSERT INTO finnor_os.pe_document_links
      (id,tenant_id,deal_id,world_root_type,world_root_id,entity_type,entity_id,document_id,link_role,supersedes_link_id,source_system,external_id,created_by,observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (entity_type,entity_id,document_id,link_role) DO NOTHING RETURNING *`,
    [randomUUID(), ctx.auth.tenantId, params.dealId, worldRoot.entityType, worldRoot.entityId,
      params.entity.entityType, params.entity.entityId, params.documentId, params.linkRole, params.supersedesLinkId ?? null, source.sourceSystem,
      source.externalId, source.createdBy, source.observedAt],
  );
  if (result.rows[0]) return { row: shapePeRow(result.rows[0]), changed: true, idempotent: false };
  const existing = await client.query<SqlRow>(
    `SELECT * FROM finnor_os.pe_document_links
      WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 AND document_id=$4 AND link_role=$5`,
    [ctx.auth.tenantId, params.entity.entityType, params.entity.entityId, params.documentId, params.linkRole],
  );
  const row = existing.rows[0];
  if (!row) throw new PeDomainError("PE_DOCUMENT_LINK_FAILED", "Canonical Document link was not persisted");
  if (row.world_root_type !== worldRoot.entityType || row.world_root_id !== worldRoot.entityId
      || (row.deal_id ?? null) !== params.dealId) {
    throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "Existing PE Document link belongs to a different world root");
  }
  return { row: shapePeRow(row), changed: false, idempotent: true };
}

export async function attachEvidenceTx(client: Client, ctx: PeMutationContext, params: {
  dealId: string | null;
  worldRoot?: PeWorldRootRef;
  entity: PeEntityRef;
  evidenceSourceId: string;
  evidenceVersionId?: string;
  relationship: "supports" | "verifies" | "authorizes";
}): Promise<PeMutationResult> {
  const worldRoot = params.worldRoot ?? (params.dealId ? { entityType: "pe_deal", entityId: params.dealId } as const : null);
  if (!worldRoot) throw new PeDomainError("PE_WORLD_ROOT_REQUIRED", "A PE Evidence link requires an explicit world root");
  if (worldRoot.entityType === "pe_deal") {
    if (params.dealId !== worldRoot.entityId) throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "Deal link root must equal dealId");
    requireActivePeDeal(await lockPeDeal(client, ctx.auth.tenantId, params.dealId));
  } else if (params.dealId !== null) {
    throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "Pre-Deal link roots cannot carry a synthetic dealId");
  }
  assertPeUuid(params.evidenceSourceId, "evidenceSourceId");
  if (params.evidenceVersionId) assertPeUuid(params.evidenceVersionId, "evidenceVersionId");
  const existing = await client.query<SqlRow>(
    `SELECT * FROM finnor_os.pe_evidence_links
      WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 AND evidence_source_id=$4
        AND evidence_version_id IS NOT DISTINCT FROM $5::uuid AND relationship=$6 AND archived_at IS NULL`,
    [ctx.auth.tenantId, params.entity.entityType, params.entity.entityId, params.evidenceSourceId,
      params.evidenceVersionId ?? null, params.relationship],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.world_root_type !== worldRoot.entityType || row.world_root_id !== worldRoot.entityId
        || (row.deal_id ?? null) !== params.dealId) {
      throw new PeDomainError("PE_WORLD_ROOT_MISMATCH", "Existing PE Evidence link belongs to a different world root");
    }
    return { row: shapePeRow(row), changed: false, idempotent: true };
  }
  const source = peProvenance(ctx);
  const row = await insertPeRow(client, "pe_evidence_links", {
    id: randomUUID(), tenant_id: ctx.auth.tenantId, deal_id: params.dealId,
    world_root_type: worldRoot.entityType, world_root_id: worldRoot.entityId,
    entity_type: params.entity.entityType, entity_id: params.entity.entityId,
    evidence_source_id: params.evidenceSourceId, evidence_version_id: params.evidenceVersionId ?? null,
    relationship: params.relationship, source_system: source.sourceSystem, external_id: source.externalId,
    created_by: source.createdBy, observed_at: source.observedAt,
  });
  return { row: shapePeRow(row), changed: true, idempotent: false };
}

async function governanceProof(ctx: PeMutationContext, params: {
  capability: "private_equity:waive_closing_condition" | "private_equity:close_deal" | "private_equity:terminate_deal";
  resourceType: "pe_closing_condition" | "pe_deal";
  resourceId: string;
  supplied?: GovernanceProof;
  policyRequiresApproval?: boolean;
}): Promise<GovernanceProof> {
  if (params.supplied) {
    assertPeUuid(params.supplied.authorityDecisionId, "authorityDecisionId");
    if (params.supplied.decisionReceiptId) assertPeUuid(params.supplied.decisionReceiptId, "decisionReceiptId");
    return params.supplied;
  }
  const decision = await evaluateAuthority(ctx.auth, {
    operation: "action",
    capability: params.capability,
    resource: { type: params.resourceType, id: params.resourceId },
    risk: "high",
    policyRequiresApproval: params.policyRequiresApproval,
  });
  if (decision.outcome === "denied") {
    throw new PeDomainError("PE_AUTHORITY_DENIED", "Existing FINNOR authority denied the PE mutation", decision);
  }
  if (decision.outcome === "approval_required") {
    throw new PeDomainError(
      "PE_APPROVAL_REQUIRED",
      "Existing FINNOR approval must complete before this PE mutation can be retried with its DecisionReceipt",
      decision,
    );
  }
  return { authorityDecisionId: decision.id };
}

export interface CreateDealInput {
  id?: string;
  targetOrganizationId: string;
  name: string;
  codeName?: string;
  dealLeadEmployeeId: string;
  signedLoiAt: Date;
  signedLoiDocumentId?: string;
  targetClosingAt: Date;
}

export async function createDealTx(
  client: Client,
  ctx: PeMutationContext,
  input: CreateDealInput & { opportunityId?: string },
): Promise<PeMutationResult> {
  const source = peProvenance(ctx);
  const row = await insertPeRow(client, "pe_deals", {
    id: input.id ?? randomUUID(), tenant_id: ctx.auth.tenantId,
    opportunity_id: input.opportunityId ?? null,
    target_organization_id: input.targetOrganizationId, name: input.name.trim(),
    code_name: input.codeName?.trim() || null, deal_lead_employee_id: input.dealLeadEmployeeId,
    signed_loi_at: input.signedLoiAt, signed_loi_document_id: input.signedLoiDocumentId ?? null,
    target_closing_at: input.targetClosingAt, source_system: source.sourceSystem,
    external_id: source.externalId, created_by: source.createdBy, observed_at: source.observedAt,
  });
  if (input.signedLoiDocumentId) {
    await attachDocumentTx(client, ctx, {
      dealId: String(row.id), entity: { entityType: "pe_deal", entityId: String(row.id) },
      documentId: input.signedLoiDocumentId, linkRole: "governing",
    });
  }
  const refreshed = await client.query<SqlRow>("SELECT * FROM finnor_os.pe_deals WHERE id=$1", [row.id]);
  return { row: shapePeRow(refreshed.rows[0] ?? row), changed: true, idempotent: false };
}

export async function createDeal(ctx: PeMutationContext, input: CreateDealInput): Promise<PeMutationResult> {
  assertPeText(input.name, "Deal name");
  await ensureParty(ctx, { partyType: "external_organization", partyId: input.targetOrganizationId }, ["external_organization"]);
  await ensureParty(ctx, { partyType: "employee", partyId: input.dealLeadEmployeeId }, ["employee"]);
  return peTransaction(ctx, async (_db, client) => createDealTx(client, ctx, input));
}

export async function addDealParty(ctx: PeMutationContext, input: {
  id?: string; dealId: string; party: PePartyRef; role: DealPartyRole; roleLabel?: string;
}): Promise<PeMutationResult> {
  if (!DEAL_PARTY_ROLE_SET.has(input.role)) throw new PeDomainError("PE_INVALID_ROLE", `Unsupported DealParty role ${input.role}`);
  await ensureParty(ctx, input.party, ["employee", "team", "external_organization", "external_contact"]);
  return createChild(ctx, "pe_deal_parties", input.dealId, {
    id: input.id, party_type: input.party.partyType, party_id: input.party.partyId,
    role: input.role, role_label: input.roleLabel?.trim() || null,
  });
}

export const removeDealParty = (ctx: PeMutationContext, input: { dealPartyId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "deal_party", id: input.dealPartyId, expectedVersion: input.expectedVersion,
    targetState: "removed", updates: { removed_at: new Date() } });

export async function createWorkstream(ctx: PeMutationContext, input: {
  id?: string; dealId: string; kind: WorkstreamKind; name: string; owner: InternalPartyRef;
}): Promise<PeMutationResult> {
  if (!WORKSTREAM_KIND_SET.has(input.kind)) throw new PeDomainError("PE_INVALID_WORKSTREAM_KIND", `Unsupported Workstream kind ${input.kind}`);
  assertPeText(input.name, "Workstream name");
  return createChild(ctx, "pe_workstreams", input.dealId, {
    id: input.id, kind: input.kind, name: input.name.trim(),
    owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId,
  });
}

export const startWorkstream = (ctx: PeMutationContext, input: { workstreamId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "workstream", id: input.workstreamId, expectedVersion: input.expectedVersion, targetState: "active" });
export const completeWorkstream = (ctx: PeMutationContext, input: { workstreamId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "workstream", id: input.workstreamId, expectedVersion: input.expectedVersion,
    targetState: "complete", updates: { completed_at: new Date() } });
export const cancelWorkstream = (ctx: PeMutationContext, input: { workstreamId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "workstream", id: input.workstreamId, expectedVersion: input.expectedVersion,
    targetState: "cancelled", updates: { cancelled_at: new Date() } });

export async function createRequest(ctx: PeMutationContext, input: {
  id?: string; dealId: string; workstreamId: string; requestedFromDealPartyId: string;
  owner: InternalPartyRef; requestText: string; requestedAt?: Date; dueAt?: Date;
  requiresAcceptedDeliverable?: boolean;
}): Promise<PeMutationResult> {
  assertPeText(input.requestText, "Request text");
  return createChild(ctx, "pe_requests", input.dealId, {
    id: input.id, workstream_id: input.workstreamId, requested_from_deal_party_id: input.requestedFromDealPartyId,
    owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId,
    request_text: input.requestText.trim(), requested_at: input.requestedAt ?? new Date(), due_at: input.dueAt ?? null,
    requires_accepted_deliverable: input.requiresAcceptedDeliverable ?? false,
  });
}

export const acknowledgeRequest = (ctx: PeMutationContext, input: { requestId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "request", id: input.requestId, expectedVersion: input.expectedVersion,
    targetState: "acknowledged", updates: { acknowledged_at: new Date() } });
export const fulfillRequest = (ctx: PeMutationContext, input: { requestId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "request", id: input.requestId, expectedVersion: input.expectedVersion,
    targetState: "fulfilled", updates: { fulfilled_at: new Date() } });
export const cancelRequest = (ctx: PeMutationContext, input: { requestId: string; expectedVersion: number; reason: string }) => {
  assertPeText(input.reason, "Request cancellation reason");
  return transition({ ctx, lifecycle: "request", id: input.requestId, expectedVersion: input.expectedVersion,
    targetState: "cancelled", updates: { cancelled_at: new Date(), cancellation_reason: input.reason.trim() } });
};

export async function createDeliverable(ctx: PeMutationContext, input: {
  id?: string; dealId: string; workstreamId: string; requestId?: string;
  responsibleDealPartyId: string; description: string; kind: string; dueAt?: Date;
  requiresDocument?: boolean; requiredForWorkstreamCompletion?: boolean;
}): Promise<PeMutationResult> {
  assertPeText(input.description, "Deliverable description");
  assertPeText(input.kind, "Deliverable kind");
  return createChild(ctx, "pe_deliverables", input.dealId, {
    id: input.id, workstream_id: input.workstreamId, request_id: input.requestId ?? null,
    responsible_deal_party_id: input.responsibleDealPartyId, description: input.description.trim(),
    kind: input.kind.trim(), due_at: input.dueAt ?? null, requires_document: input.requiresDocument ?? true,
    required_for_workstream_completion: input.requiredForWorkstreamCompletion ?? true,
  });
}

export async function receiveDeliverable(ctx: PeMutationContext, input: {
  dealId: string; deliverableId: string; expectedVersion: number; documentId?: string; supersedesLinkId?: string;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const current = await getLifecycleRowForUpdate(client, ctx.auth.tenantId, "pe_deliverables", input.deliverableId);
    if (current.state === "received") return { row: shapePeRow(current), changed: false, idempotent: true };
    if (current.requires_document && !input.documentId) {
      throw new PeDomainError("PE_DELIVERABLE_DOCUMENT_REQUIRED", "This Deliverable requires a canonical Document before receipt");
    }
    if (input.documentId) await attachDocumentTx(client, ctx, {
      dealId: input.dealId, entity: { entityType: "pe_deliverable", entityId: input.deliverableId },
      documentId: input.documentId, linkRole: "submission", supersedesLinkId: input.supersedesLinkId,
    });
    return transitionTx({ client, ctx, lifecycle: "deliverable", id: input.deliverableId,
      expectedVersion: input.expectedVersion, targetState: "received",
      updates: { received_at: new Date(), rejected_at: null, rejection_reason: null } });
  });
}

export async function acceptDeliverable(ctx: PeMutationContext, input: {
  dealId: string; deliverableId: string; expectedVersion: number; documentId?: string; supersedesLinkId?: string;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const current = await getLifecycleRowForUpdate(client, ctx.auth.tenantId, "pe_deliverables", input.deliverableId);
    if (current.state === "accepted") return { row: shapePeRow(current), changed: false, idempotent: true };
    if (current.requires_document && !input.documentId) {
      throw new PeDomainError("PE_DELIVERABLE_DOCUMENT_REQUIRED", "This Deliverable requires an accepted canonical Document link");
    }
    if (input.documentId) {
      await attachDocumentTx(client, ctx, {
        dealId: input.dealId, entity: { entityType: "pe_deliverable", entityId: input.deliverableId },
        documentId: input.documentId, linkRole: "accepted", supersedesLinkId: input.supersedesLinkId,
      });
    }
    return transitionTx({ client, ctx, lifecycle: "deliverable", id: input.deliverableId,
      expectedVersion: input.expectedVersion, targetState: "accepted", updates: { accepted_at: new Date() } });
  });
}

export const rejectDeliverable = (ctx: PeMutationContext, input: { deliverableId: string; expectedVersion: number; reason: string }) => {
  assertPeText(input.reason, "Deliverable rejection reason");
  return transition({ ctx, lifecycle: "deliverable", id: input.deliverableId, expectedVersion: input.expectedVersion,
    targetState: "rejected", updates: { rejected_at: new Date(), rejection_reason: input.reason.trim() } });
};
export const supersedeDeliverable = (ctx: PeMutationContext, input: { deliverableId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "deliverable", id: input.deliverableId, expectedVersion: input.expectedVersion,
    targetState: "superseded", updates: { superseded_at: new Date() } });
export const cancelDeliverable = (ctx: PeMutationContext, input: { deliverableId: string; expectedVersion: number; reason: string }) => {
  assertPeText(input.reason, "Deliverable cancellation reason");
  return transition({ ctx, lifecycle: "deliverable", id: input.deliverableId, expectedVersion: input.expectedVersion,
    targetState: "cancelled", updates: { cancelled_at: new Date(), cancellation_reason: input.reason.trim() } });
};

export async function createFinding(ctx: PeMutationContext, input: {
  id?: string; dealId: string; workstreamId: string; relatedRequestId?: string; relatedDeliverableId?: string;
  statement: string; severity: "low" | "medium" | "high" | "critical";
  materiality: "immaterial" | "non_material" | "material" | "critical"; owner: InternalPartyRef;
  requiredForWorkstreamCompletion?: boolean;
}): Promise<PeMutationResult> {
  assertPeText(input.statement, "Finding statement");
  return createChild(ctx, "pe_findings", input.dealId, {
    id: input.id, workstream_id: input.workstreamId, related_request_id: input.relatedRequestId ?? null,
    related_deliverable_id: input.relatedDeliverableId ?? null, statement: input.statement.trim(),
    severity: input.severity, materiality: input.materiality,
    owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId,
    required_for_workstream_completion: input.requiredForWorkstreamCompletion ?? false,
  });
}

function findingDisposition(ctx: PeMutationContext, input: { findingId: string; expectedVersion: number; disposition: string }, targetState: FindingState) {
  assertPeText(input.disposition, "Finding disposition");
  const timeColumn = targetState === "resolved" ? "resolved_at" : targetState === "accepted" ? "accepted_at" : "superseded_at";
  return transition({ ctx, lifecycle: "finding", id: input.findingId, expectedVersion: input.expectedVersion,
    targetState, updates: { disposition: input.disposition.trim(), [timeColumn]: new Date() } });
}
export const resolveFinding = (ctx: PeMutationContext, input: { findingId: string; expectedVersion: number; disposition: string }) =>
  findingDisposition(ctx, input, "resolved");
export const acceptFinding = (ctx: PeMutationContext, input: { findingId: string; expectedVersion: number; disposition: string }) =>
  findingDisposition(ctx, input, "accepted");
export const supersedeFinding = (ctx: PeMutationContext, input: { findingId: string; expectedVersion: number; disposition: string }) =>
  findingDisposition(ctx, input, "superseded");

export async function createDealRisk(ctx: PeMutationContext, input: {
  id?: string; dealId: string; workstreamId: string; statement: string;
  severity: "low" | "medium" | "high" | "critical"; owner: InternalPartyRef;
  response?: string; requiredForWorkstreamCompletion?: boolean; originatingFindingIds?: string[];
}): Promise<PeMutationResult> {
  assertPeText(input.statement, "Deal Risk statement");
  return peTransaction(ctx, async (_db, client) => {
    requireActivePeDeal(await lockPeDeal(client, ctx.auth.tenantId, input.dealId));
    const source = peProvenance(ctx);
    const row = await insertPeRow(client, "pe_deal_risks", {
      id: input.id ?? randomUUID(), tenant_id: ctx.auth.tenantId, deal_id: input.dealId,
      workstream_id: input.workstreamId, statement: input.statement.trim(), severity: input.severity,
      owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId,
      response: input.response?.trim() || null,
      required_for_workstream_completion: input.requiredForWorkstreamCompletion ?? false,
      source_system: source.sourceSystem, external_id: source.externalId,
      created_by: source.createdBy, observed_at: source.observedAt,
    });
    for (const findingId of input.originatingFindingIds ?? []) {
      await insertPeRow(client, "pe_finding_risk_links", {
        id: randomUUID(), tenant_id: ctx.auth.tenantId, deal_id: input.dealId,
        finding_id: findingId, deal_risk_id: row.id, source_system: source.sourceSystem,
        external_id: source.externalId, created_by: source.createdBy, observed_at: source.observedAt,
      });
    }
    return { row: shapePeRow(row), changed: true, idempotent: false };
  });
}

export const startMitigatingDealRisk = (ctx: PeMutationContext, input: { dealRiskId: string; expectedVersion: number; response?: string }) =>
  transition({ ctx, lifecycle: "deal_risk", id: input.dealRiskId, expectedVersion: input.expectedVersion,
    targetState: "mitigating", updates: { mitigating_at: new Date(), response: input.response?.trim() || null } });
function disposeDealRisk(ctx: PeMutationContext, input: { dealRiskId: string; expectedVersion: number; response: string }, targetState: "resolved" | "accepted") {
  assertPeText(input.response, "Deal Risk response");
  return transition({ ctx, lifecycle: "deal_risk", id: input.dealRiskId, expectedVersion: input.expectedVersion,
    targetState, updates: { response: input.response.trim(), [targetState === "resolved" ? "resolved_at" : "accepted_at"]: new Date() } });
}
export const resolveDealRisk = (ctx: PeMutationContext, input: { dealRiskId: string; expectedVersion: number; response: string }) =>
  disposeDealRisk(ctx, input, "resolved");
export const acceptDealRisk = (ctx: PeMutationContext, input: { dealRiskId: string; expectedVersion: number; response: string }) =>
  disposeDealRisk(ctx, input, "accepted");

export async function linkFindingToDealRisk(ctx: PeMutationContext, input: {
  dealId: string; findingId: string; dealRiskId: string;
}): Promise<PeMutationResult> {
  return createChild(ctx, "pe_finding_risk_links", input.dealId, {
    finding_id: input.findingId, deal_risk_id: input.dealRiskId,
  });
}

export async function createDependency(ctx: PeMutationContext, input: {
  id?: string; dealId: string; blocker: PeDependencyEndpoint; blocked: PeDependencyEndpoint;
}): Promise<PeMutationResult> {
  if (!DEPENDENCY_TYPES.has(input.blocker.entityType) || !DEPENDENCY_TYPES.has(input.blocked.entityType)) {
    throw new PeDomainError("PE_DEPENDENCY_TYPE_UNSUPPORTED", "Dependency endpoints must be bounded PE execution objects");
  }
  return peTransaction(ctx, async (_db, client) => {
    requireActivePeDeal(await lockPeDeal(client, ctx.auth.tenantId, input.dealId));
    const source = peProvenance(ctx);
    const result = await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_dependencies
        (id,tenant_id,deal_id,blocker_type,blocker_id,blocked_type,blocked_id,relation,source_system,external_id,created_by,observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'blocks',$8,$9,$10,$11)
       ON CONFLICT (deal_id,blocker_type,blocker_id,blocked_type,blocked_id) WHERE removed_at IS NULL
       DO NOTHING RETURNING *`,
      [input.id ?? randomUUID(), ctx.auth.tenantId, input.dealId, input.blocker.entityType,
        input.blocker.entityId, input.blocked.entityType, input.blocked.entityId,
        source.sourceSystem, source.externalId, source.createdBy, source.observedAt],
    );
    if (result.rows[0]) return { row: shapePeRow(result.rows[0]), changed: true, idempotent: false };
    const existing = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_dependencies WHERE deal_id=$1 AND blocker_type=$2 AND blocker_id=$3
        AND blocked_type=$4 AND blocked_id=$5 AND removed_at IS NULL`,
      [input.dealId, input.blocker.entityType, input.blocker.entityId, input.blocked.entityType, input.blocked.entityId],
    );
    const row = existing.rows[0];
    if (!row) throw new PeDomainError("PE_DEPENDENCY_WRITE_FAILED", "Dependency was not persisted");
    return { row: shapePeRow(row), changed: false, idempotent: true };
  });
}

export async function removeDependency(ctx: PeMutationContext, input: {
  dependencyId: string; expectedVersion: number; reason: string;
}): Promise<PeMutationResult> {
  assertPeText(input.reason, "Dependency removal reason");
  return peTransaction(ctx, async (_db, client) => {
    const row = await getLifecycleRowForUpdate(client, ctx.auth.tenantId, "pe_dependencies", input.dependencyId);
    if (row.removed_at) return { row: shapePeRow(row), changed: false, idempotent: true };
    if (Number(row.version) !== input.expectedVersion) throw new PeDomainError("PE_STALE_VERSION", "Dependency changed concurrently");
    const source = peProvenance(ctx);
    const result = await client.query<SqlRow>(
      `UPDATE finnor_os.pe_dependencies SET removed_at=now(),removed_by=$3,removal_reason=$4,
        version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [ctx.auth.tenantId, input.dependencyId, source.createdBy, input.reason.trim(), input.expectedVersion],
    );
    const updated = result.rows[0];
    if (!updated) throw new PeDomainError("PE_STALE_VERSION", "Dependency changed concurrently");
    return { row: shapePeRow(updated), changed: true, idempotent: false };
  });
}

export async function createMilestone(ctx: PeMutationContext, input: {
  id?: string; dealId: string; name: string; kind: string; owner: InternalPartyRef; targetAt: Date;
}): Promise<PeMutationResult> {
  assertPeText(input.name, "Milestone name"); assertPeText(input.kind, "Milestone kind");
  return createChild(ctx, "pe_milestones", input.dealId, {
    id: input.id, name: input.name.trim(), kind: input.kind.trim(),
    owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId, target_at: input.targetAt,
  });
}
export const achieveMilestone = (ctx: PeMutationContext, input: { milestoneId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "milestone", id: input.milestoneId, expectedVersion: input.expectedVersion,
    targetState: "achieved", updates: { achieved_at: new Date() } });
export const cancelMilestone = (ctx: PeMutationContext, input: { milestoneId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "milestone", id: input.milestoneId, expectedVersion: input.expectedVersion,
    targetState: "cancelled", updates: { cancelled_at: new Date() } });

export async function createClosingCondition(ctx: PeMutationContext, input: {
  id?: string; dealId: string; workstreamId: string; conditionText: string; category: string;
  requiredForClose?: boolean; evidenceRequired?: boolean; waiverRequiresApproval?: boolean;
  owner: InternalPartyRef; responsibleDealPartyId?: string; dueAt?: Date;
}): Promise<PeMutationResult> {
  assertPeText(input.conditionText, "Closing Condition"); assertPeText(input.category, "Closing Condition category");
  return createChild(ctx, "pe_closing_conditions", input.dealId, {
    id: input.id, workstream_id: input.workstreamId, condition_text: input.conditionText.trim(),
    category: input.category.trim(), required_for_close: input.requiredForClose ?? true,
    evidence_required: input.evidenceRequired ?? true, waiver_requires_approval: input.waiverRequiresApproval ?? true,
    owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId,
    responsible_deal_party_id: input.responsibleDealPartyId ?? null, due_at: input.dueAt ?? null,
  });
}

export const markClosingConditionEvidencePending = (ctx: PeMutationContext, input: { closingConditionId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "closing_condition", id: input.closingConditionId,
    expectedVersion: input.expectedVersion, targetState: "evidence_pending" });

export async function satisfyClosingCondition(ctx: PeMutationContext, input: {
  dealId: string; closingConditionId: string; expectedVersion: number;
  documentId?: string; evidenceSourceId?: string; evidenceVersionId?: string;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const current = await getLifecycleRowForUpdate(client, ctx.auth.tenantId, "pe_closing_conditions", input.closingConditionId);
    if (current.state === "satisfied") return { row: shapePeRow(current), changed: false, idempotent: true };
    if (current.evidence_required && !input.documentId && !input.evidenceSourceId) {
      throw new PeDomainError("PE_EVIDENCE_REQUIRED", "Closing Condition satisfaction requires canonical Document or Evidence support");
    }
    if (input.documentId) await attachDocumentTx(client, ctx, {
      dealId: input.dealId, entity: { entityType: "pe_closing_condition", entityId: input.closingConditionId },
      documentId: input.documentId, linkRole: "verification",
    });
    if (input.evidenceSourceId) await attachEvidenceTx(client, ctx, {
      dealId: input.dealId, entity: { entityType: "pe_closing_condition", entityId: input.closingConditionId },
      evidenceSourceId: input.evidenceSourceId, evidenceVersionId: input.evidenceVersionId, relationship: "verifies",
    });
    return transitionTx({ client, ctx, lifecycle: "closing_condition", id: input.closingConditionId,
      expectedVersion: input.expectedVersion, targetState: "satisfied", updates: { satisfied_at: new Date() } });
  });
}

export async function waiveClosingCondition(ctx: PeMutationContext, input: {
  closingConditionId: string; expectedVersion: number; reason: string; governance?: GovernanceProof;
}): Promise<PeMutationResult> {
  assertPeText(input.reason, "Waiver reason");
  const current = await getPeEntity(ctx, "pe_closing_conditions", input.closingConditionId);
  if (current.state === "waived") return { row: current, changed: false, idempotent: true };
  const proof = await governanceProof(ctx, {
    capability: "private_equity:waive_closing_condition", resourceType: "pe_closing_condition",
    resourceId: input.closingConditionId, supplied: input.governance,
    policyRequiresApproval: Boolean(current.waiverRequiresApproval),
  });
  return transition({ ctx, lifecycle: "closing_condition", id: input.closingConditionId,
    expectedVersion: input.expectedVersion, targetState: "waived", updates: {
      waived_at: new Date(), waiver_reason: input.reason.trim(), waiver_authority_decision_id: proof.authorityDecisionId,
      waiver_decision_receipt_id: proof.decisionReceiptId ?? null,
    } });
}

export const failClosingCondition = (ctx: PeMutationContext, input: { closingConditionId: string; expectedVersion: number; reason: string }) => {
  assertPeText(input.reason, "Closing Condition failure reason");
  return transition({ ctx, lifecycle: "closing_condition", id: input.closingConditionId,
    expectedVersion: input.expectedVersion, targetState: "failed",
    updates: { failed_at: new Date(), failure_reason: input.reason.trim() } });
};

export async function createClosingItem(ctx: PeMutationContext, input: {
  id?: string; dealId: string; workstreamId: string; itemText: string; category: string;
  requiredForClose?: boolean; verificationEvidenceRequired?: boolean; owner: InternalPartyRef;
  responsibleDealPartyId?: string; dueAt?: Date;
}): Promise<PeMutationResult> {
  assertPeText(input.itemText, "Closing Item"); assertPeText(input.category, "Closing Item category");
  return createChild(ctx, "pe_closing_items", input.dealId, {
    id: input.id, workstream_id: input.workstreamId, item_text: input.itemText.trim(), category: input.category.trim(),
    required_for_close: input.requiredForClose ?? true,
    verification_evidence_required: input.verificationEvidenceRequired ?? true,
    owner_party_type: input.owner.partyType, owner_party_id: input.owner.partyId,
    responsible_deal_party_id: input.responsibleDealPartyId ?? null, due_at: input.dueAt ?? null,
  });
}
export const markClosingItemReady = (ctx: PeMutationContext, input: { closingItemId: string; expectedVersion: number }) =>
  transition({ ctx, lifecycle: "closing_item", id: input.closingItemId, expectedVersion: input.expectedVersion,
    targetState: "ready", updates: { ready_at: new Date() } });

export async function verifyClosingItem(ctx: PeMutationContext, input: {
  dealId: string; closingItemId: string; expectedVersion: number; verifierEmployeeId?: string;
  verificationSource?: string; documentId?: string; evidenceSourceId?: string; evidenceVersionId?: string;
}): Promise<PeMutationResult> {
  if (!input.verifierEmployeeId && !input.verificationSource?.trim()) {
    throw new PeDomainError("PE_VERIFIER_REQUIRED", "Closing Item verification requires an exact verifier identity or source");
  }
  return peTransaction(ctx, async (_db, client) => {
    const current = await getLifecycleRowForUpdate(client, ctx.auth.tenantId, "pe_closing_items", input.closingItemId);
    if (current.state === "verified") return { row: shapePeRow(current), changed: false, idempotent: true };
    if (current.verification_evidence_required && !input.documentId && !input.evidenceSourceId) {
      throw new PeDomainError("PE_EVIDENCE_REQUIRED", "Closing Item verification requires canonical Document or Evidence support");
    }
    if (input.documentId) await attachDocumentTx(client, ctx, {
      dealId: input.dealId, entity: { entityType: "pe_closing_item", entityId: input.closingItemId },
      documentId: input.documentId, linkRole: "verification",
    });
    if (input.evidenceSourceId) await attachEvidenceTx(client, ctx, {
      dealId: input.dealId, entity: { entityType: "pe_closing_item", entityId: input.closingItemId },
      evidenceSourceId: input.evidenceSourceId, evidenceVersionId: input.evidenceVersionId, relationship: "verifies",
    });
    return transitionTx({ client, ctx, lifecycle: "closing_item", id: input.closingItemId,
      expectedVersion: input.expectedVersion, targetState: "verified", updates: {
        verified_at: new Date(), verified_by_employee_id: input.verifierEmployeeId ?? null,
        verification_source: input.verificationSource?.trim() || null,
      } });
  });
}

export const cancelClosingItem = (ctx: PeMutationContext, input: { closingItemId: string; expectedVersion: number; reason: string }) => {
  assertPeText(input.reason, "Closing Item cancellation reason");
  return transition({ ctx, lifecycle: "closing_item", id: input.closingItemId, expectedVersion: input.expectedVersion,
    targetState: "cancelled", updates: { cancelled_at: new Date(), cancellation_reason: input.reason.trim() } });
};

export async function attachCanonicalDocument(ctx: PeMutationContext, input: {
  dealId: string; entity: PeEntityRef; documentId: string;
  linkRole: "source" | "submission" | "accepted" | "rejected" | "superseded" | "governing" | "verification";
  supersedesLinkId?: string;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, (_db, client) => attachDocumentTx(client, ctx, input));
}

export async function attachCanonicalEvidence(ctx: PeMutationContext, input: {
  dealId: string; entity: PeEntityRef; evidenceSourceId: string; evidenceVersionId?: string;
  relationship: "supports" | "verifies" | "authorizes";
}): Promise<PeMutationResult> {
  return peTransaction(ctx, (_db, client) => attachEvidenceTx(client, ctx, input));
}

export async function attachCanonicalDocumentToWorld(ctx: PeMutationContext, input: {
  worldRoot: Exclude<PeWorldRootRef, { entityType: "pe_deal" }>;
  entity: PeEntityRef;
  documentId: string;
  linkRole: "source" | "submission" | "accepted" | "rejected" | "superseded" | "governing" | "verification";
  supersedesLinkId?: string;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, (_db, client) => attachDocumentTx(client, ctx, { ...input, dealId: null }));
}

export async function attachCanonicalEvidenceToWorld(ctx: PeMutationContext, input: {
  worldRoot: Exclude<PeWorldRootRef, { entityType: "pe_deal" }>;
  entity: PeEntityRef;
  evidenceSourceId: string;
  evidenceVersionId?: string;
  relationship: "supports" | "verifies" | "authorizes";
}): Promise<PeMutationResult> {
  return peTransaction(ctx, (_db, client) => attachEvidenceTx(client, ctx, { ...input, dealId: null }));
}

export async function attachWorkToDealGraph(ctx: PeMutationContext, input: {
  dealId: string; workId: string;
  entities: Array<PeEntityRef & { relationship?: "about" | "target" | "result" }>;
}): Promise<void> {
  if (input.entities.length === 0) throw new PeDomainError("PE_WORK_LINK_EMPTY", "At least one PE Work attachment is required");
  await peTransaction(ctx, async (db, client) => {
    requireActivePeDeal(await lockPeDeal(client, ctx.auth.tenantId, input.dealId));
    const work = await client.query("SELECT 1 FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, input.workId]);
    if (!work.rows[0]) throw new PeDomainError("PE_WORK_NOT_FOUND", "Work was not found in the authenticated tenant");
    for (const entity of input.entities) {
      const result = await client.query<{ deal_id: string | null }>(
        "SELECT finnor_os.pe_entity_deal($1,$2::uuid) AS deal_id",
        [entity.entityType, entity.entityId],
      );
      if (result.rows[0]?.deal_id !== input.dealId) {
        throw new PeDomainError("PE_WORK_CROSS_DEAL", "All Work attachments must belong to the exact Deal");
      }
      await attachWorkEntityTx(db, {
        tenantId: ctx.auth.tenantId, workId: input.workId,
        entity: { entityType: entity.entityType, entityId: entity.entityId,
          relationship: entity.relationship ?? "about", source: peProvenance(ctx).sourceSystem },
      });
    }
  });
}

function eligibilityShape(value: unknown): DealCloseEligibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PeDomainError("PE_ELIGIBILITY_INVALID", "Database returned an invalid close eligibility result");
  }
  const result = value as DealCloseEligibility;
  const arrays = [result.blockingConditions, result.failedConditions, result.unverifiedClosingItems,
    result.blockingDependencies, result.invalidWaivers, result.integrityErrors];
  if (typeof result.eligible !== "boolean" || arrays.some((item) => !Array.isArray(item))) {
    throw new PeDomainError("PE_ELIGIBILITY_INVALID", "Database returned an incomplete close eligibility result");
  }
  return result;
}

export async function evaluateDealCloseEligibility(ctx: PeMutationContext, dealId: string): Promise<DealCloseEligibility> {
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<{ eligibility: unknown }>(
      "SELECT finnor_os.pe_evaluate_deal_close_eligibility($1::uuid,$2::uuid) AS eligibility",
      [ctx.auth.tenantId, dealId],
    );
    return eligibilityShape(result.rows[0]?.eligibility);
  }, { readOnly: true });
}

export async function declareDealClosed(ctx: PeMutationContext, input: {
  dealId: string; expectedVersion?: number; expectedGraphVersion?: number; governance?: GovernanceProof;
}): Promise<PeMutationResult & { eligibility: DealCloseEligibility }> {
  const before = await getDeal(ctx, input.dealId);
  if (before.status === "closed") {
    const eligibility = await evaluateDealCloseEligibility(ctx, input.dealId);
    return { row: before, changed: false, idempotent: true, eligibility };
  }
  const eligibility = await evaluateDealCloseEligibility(ctx, input.dealId);
  if (!eligibility.eligible) throw new DealCloseRejectedError(eligibility);
  const proof = await governanceProof(ctx, {
    capability: "private_equity:close_deal", resourceType: "pe_deal", resourceId: input.dealId,
    supplied: input.governance,
  });
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<{ result: unknown }>(
      `SELECT finnor_os.pe_declare_deal_closed($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8) AS result`,
      [ctx.auth.tenantId, input.dealId, input.expectedVersion ?? eligibility.dealVersion,
        input.expectedGraphVersion ?? eligibility.graphVersion, proof.authorityDecisionId,
        proof.decisionReceiptId ?? null, peProvenance(ctx).sourceSystem, peProvenance(ctx).createdBy],
    );
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PeDomainError("PE_CLOSE_INVALID_RESULT", "Close boundary returned no result");
    const shaped = value as { changed: boolean; idempotent: boolean; rejected?: boolean; row: SqlRow; eligibility: unknown };
    const currentEligibility = eligibilityShape(shaped.eligibility);
    if (shaped.rejected) throw new DealCloseRejectedError(currentEligibility);
    return { row: shapePeRow(shaped.row), changed: shaped.changed, idempotent: shaped.idempotent, eligibility: currentEligibility };
  });
}

export async function terminateDeal(ctx: PeMutationContext, input: {
  dealId: string; expectedVersion: number; reason: string; governance?: GovernanceProof;
}): Promise<PeMutationResult> {
  assertPeText(input.reason, "Deal termination reason");
  const before = await getDeal(ctx, input.dealId);
  if (before.status === "terminated") return { row: before, changed: false, idempotent: true };
  const proof = await governanceProof(ctx, {
    capability: "private_equity:terminate_deal", resourceType: "pe_deal", resourceId: input.dealId,
    supplied: input.governance,
  });
  return peTransaction(ctx, async (_db, client) => {
    const source = peProvenance(ctx);
    const result = await client.query<{ result: unknown }>(
      "SELECT finnor_os.pe_terminate_deal($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8) AS result",
      [ctx.auth.tenantId, input.dealId, input.expectedVersion, input.reason.trim(), proof.authorityDecisionId,
        proof.decisionReceiptId ?? null, source.sourceSystem, source.createdBy],
    );
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PeDomainError("PE_TERMINATE_INVALID_RESULT", "Termination boundary returned no result");
    const shaped = value as { changed: boolean; idempotent: boolean; row: SqlRow };
    return { row: shapePeRow(shaped.row), changed: shaped.changed, idempotent: shaped.idempotent };
  });
}

async function getPeEntity(ctx: PeMutationContext, table: string, id: string): Promise<Record<string, unknown>> {
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.${quotedIdentifier(table)} WHERE tenant_id=$1 AND id=$2`,
      [ctx.auth.tenantId, id],
    );
    const row = result.rows[0];
    if (!row) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE entity was not found in the authenticated tenant");
    return shapePeRow(row);
  }, { readOnly: true });
}

export const getDeal = (ctx: PeMutationContext, dealId: string) => getPeEntity(ctx, "pe_deals", dealId);

export async function loadDealExecutionGraph(ctx: PeMutationContext, dealId: string, now = new Date()): Promise<DealExecutionGraph> {
  return peTransaction(ctx, async (_db, client) => {
    const dealResult = await client.query<SqlRow>("SELECT * FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, dealId]);
    const deal = dealResult.rows[0];
    if (!deal) throw new PeDomainError("PE_DEAL_NOT_FOUND", "Deal was not found in the authenticated tenant");
    const table = async (name: string): Promise<Record<string, unknown>[]> => {
      const result = await client.query<SqlRow>(`SELECT * FROM finnor_os.${quotedIdentifier(name)} WHERE tenant_id=$1 AND deal_id=$2 ORDER BY created_at,id`, [ctx.auth.tenantId, dealId]);
      return result.rows.map(shapePeRow);
    };
    const dealParties = await table("pe_deal_parties");
    const workstreams = await table("pe_workstreams");
    const requestsRaw = await table("pe_requests");
    const deliverables = await table("pe_deliverables");
    const findings = await table("pe_findings");
    const dealRisks = await table("pe_deal_risks");
    const findingRiskLinks = await table("pe_finding_risk_links");
    const dependencies = await table("pe_dependencies");
    const milestonesRaw = await table("pe_milestones");
    const closingConditions = await table("pe_closing_conditions");
    const closingItems = await table("pe_closing_items");
    const documentLinks = await table("pe_document_links");
    const evidenceLinks = await table("pe_evidence_links");
    const businessEvents = await client.query<SqlRow>(
      `SELECT e.* FROM finnor_os.business_events e
       WHERE e.tenant_id=$1 AND e.entity_type LIKE 'pe\\_%' ESCAPE '\\'
         AND finnor_os.pe_entity_deal(e.entity_type,e.entity_id)=$2::uuid
       ORDER BY e.occurred_at,e.id`, [ctx.auth.tenantId, dealId],
    );
    const authorityDecisions = await client.query<SqlRow>(
      `SELECT ad.* FROM finnor_os.authority_decisions ad
       WHERE ad.tenant_id=$1 AND (
         (ad.resource_type='pe_deal' AND ad.resource_id=$2::uuid)
         OR EXISTS (
           SELECT 1 FROM finnor_os.pe_closing_conditions c
           WHERE c.tenant_id=$1 AND c.deal_id=$2::uuid
             AND ad.resource_type='pe_closing_condition' AND ad.resource_id=c.id
         )
       )
       ORDER BY ad.created_at,ad.id`, [ctx.auth.tenantId, dealId],
    );
    const approvalRequests = await client.query<SqlRow>(
      `SELECT ar.* FROM finnor_os.authority_approval_requests ar
       WHERE ar.tenant_id=$1 AND EXISTS (
         SELECT 1 FROM finnor_os.authority_decisions ad
         WHERE ad.tenant_id=$1 AND ad.id=ar.authority_decision_id
           AND (
             (ad.resource_type='pe_deal' AND ad.resource_id=$2::uuid)
             OR EXISTS (
               SELECT 1 FROM finnor_os.pe_closing_conditions c
               WHERE c.tenant_id=$1 AND c.deal_id=$2::uuid
                 AND ad.resource_type='pe_closing_condition' AND ad.resource_id=c.id
             )
           )
       )
       ORDER BY ar.created_at,ar.id`, [ctx.auth.tenantId, dealId],
    );
    const decisionReceipts = await client.query<SqlRow>(
      `SELECT r.* FROM finnor_os.decision_receipts r
       WHERE r.tenant_id=$1 AND (
         r.id IN (
           SELECT d.close_decision_receipt_id FROM finnor_os.pe_deals d
           WHERE d.tenant_id=$1 AND d.id=$2::uuid AND d.close_decision_receipt_id IS NOT NULL
           UNION ALL
           SELECT d.termination_decision_receipt_id FROM finnor_os.pe_deals d
           WHERE d.tenant_id=$1 AND d.id=$2::uuid AND d.termination_decision_receipt_id IS NOT NULL
           UNION ALL
           SELECT c.waiver_decision_receipt_id FROM finnor_os.pe_closing_conditions c
           WHERE c.tenant_id=$1 AND c.deal_id=$2::uuid AND c.waiver_decision_receipt_id IS NOT NULL
         )
         OR EXISTS (
           SELECT 1 FROM finnor_os.authority_decisions ad
           WHERE ad.tenant_id=$1 AND ad.domain_action_id=r.domain_action_id
             AND (
               (ad.resource_type='pe_deal' AND ad.resource_id=$2::uuid)
               OR EXISTS (
                 SELECT 1 FROM finnor_os.pe_closing_conditions c
                 WHERE c.tenant_id=$1 AND c.deal_id=$2::uuid
                   AND ad.resource_type='pe_closing_condition' AND ad.resource_id=c.id
               )
             )
         )
       )
       ORDER BY r.created_at,r.id`, [ctx.auth.tenantId, dealId],
    );
    const work = await client.query<SqlRow>(
      `SELECT l.* FROM finnor_os.work_entity_links l
       JOIN finnor_os.canonical_truth_registry r ON r.entity_type=l.entity_type AND r.vertical_key='private_equity'
       WHERE l.tenant_id=$1 AND finnor_os.pe_entity_deal(l.entity_type,l.entity_id)=$2::uuid
       ORDER BY l.created_at,l.id`, [ctx.auth.tenantId, dealId],
    );
    const tasks = await client.query<SqlRow>(
      `SELECT t.* FROM finnor_os.tasks t
       JOIN finnor_os.canonical_truth_registry r ON r.entity_type=t.subject_type AND r.vertical_key='private_equity'
       WHERE t.tenant_id=$1 AND finnor_os.pe_entity_deal(t.subject_type,t.subject_id)=$2::uuid
       ORDER BY t.created_at,t.id`, [ctx.auth.tenantId, dealId],
    );
    const clock = await client.query<{ as_of: Date }>("SELECT transaction_timestamp() AS as_of");
    return {
      deal: shapePeRow(deal), dealParties, workstreams,
      requests: requestsRaw.map((row) => ({ ...row, overdue: isRequestOverdue({ state: String(row.state), dueAt: row.dueAt as Date | null }, now) })),
      deliverables, findings, dealRisks, findingRiskLinks, dependencies,
      milestones: milestonesRaw.map((row) => ({ ...row, late: isMilestoneLate({ state: String(row.state), targetAt: row.targetAt as Date }, now) })),
      closingConditions, closingItems, documentLinks, evidenceLinks,
      workLinks: work.rows.map(shapePeRow), taskLinks: tasks.rows.map(shapePeRow),
      businessEvents: businessEvents.rows.map(shapePeRow),
      authorityDecisions: authorityDecisions.rows.map(shapePeRow),
      approvalRequests: approvalRequests.rows.map(shapePeRow),
      decisionReceipts: decisionReceipts.rows.map(shapePeRow),
      asOf: (clock.rows[0]?.as_of ?? now).toISOString(),
    };
  }, { readOnly: true });
}

export async function listDealHistory(ctx: PeMutationContext, dealId: string): Promise<Record<string, unknown>[]> {
  return peTransaction(ctx, async (_db, client) => {
    const exists = await client.query("SELECT 1 FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, dealId]);
    if (!exists.rows[0]) throw new PeDomainError("PE_DEAL_NOT_FOUND", "Deal was not found in the authenticated tenant");
    const result = await client.query<SqlRow>(
      `SELECT * FROM finnor_os.business_events
       WHERE tenant_id=$1 AND ((entity_type='pe_deal' AND entity_id=$2::uuid) OR payload->>'dealId'=$2::text)
       ORDER BY occurred_at,id`, [ctx.auth.tenantId, dealId],
    );
    return result.rows.map(shapePeRow);
  }, { readOnly: true });
}

// Compile-time anchors: the exported API has dedicated methods, while these state
// aliases make accidental widening visible to TypeScript and transition tests.
void (null as unknown as WorkstreamState);
void (null as unknown as RequestState);
void (null as unknown as DeliverableState);
void (null as unknown as MilestoneState);
void (null as unknown as ClosingConditionState);
void (null as unknown as ClosingItemState);
void (null as unknown as PeDependencyEndpointType);
