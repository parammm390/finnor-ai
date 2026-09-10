import { randomUUID } from "node:crypto";
import { attachWorkEntityTx } from "@finnor/db";
import { assertTransition } from "./state-machines";
import {
  assertPeText,
  assertPeUuid,
  createDealTx,
  insertPeRow,
  peProvenance,
  peTransaction,
  shapePeRow,
  type PeClient,
  type SqlRow,
  type CreateDealInput,
} from "./repository";
import {
  PeDomainError,
  type AssumptionValueType,
  type PeEntityRef,
  type PeLifecycleName,
  type PeMutationContext,
  type PeMutationResult,
  type PePartyRef,
  type PeWorldRootRef,
} from "./types";

type WorldLifecycle = Extract<PeLifecycleName, "strategy" | "opportunity" | "investment_case" | "thesis" | "assumption" | "decision">;

const WORLD_TABLES: Record<WorldLifecycle, string> = {
  strategy: "pe_strategies",
  opportunity: "pe_opportunities",
  investment_case: "pe_investment_cases",
  thesis: "pe_theses",
  assumption: "pe_assumptions",
  decision: "pe_decisions",
};

const IDENTIFIER = /^[a-z][a-z0-9_]{1,62}$/;

function quoted(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe internal PE identifier: ${value}`);
  return `"${value}"`;
}

function finiteDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PeDomainError("PE_INVALID_INPUT", `${label} must be a valid date`);
  }
}

export async function worldRowForUpdate(
  client: PeClient,
  ctx: PeMutationContext,
  lifecycle: WorldLifecycle,
  id: string,
): Promise<SqlRow> {
  assertPeUuid(id, `${lifecycle}Id`);
  const result = await client.query<SqlRow>(
    `SELECT * FROM finnor_os.${quoted(WORLD_TABLES[lifecycle])} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.auth.tenantId, id],
  );
  const row = result.rows[0];
  if (!row) throw new PeDomainError("PE_ENTITY_NOT_FOUND", `${lifecycle} was not found in the authenticated tenant`);
  return row;
}

async function transitionWorld(ctx: PeMutationContext, input: {
  lifecycle: WorldLifecycle;
  id: string;
  expectedVersion: number;
  targetState: string;
  updates?: Record<string, unknown>;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const current = await worldRowForUpdate(client, ctx, input.lifecycle, input.id);
    if (current.state === input.targetState) {
      return { row: shapePeRow(current), changed: false, idempotent: true };
    }
    if (Number(current.version) !== input.expectedVersion) {
      throw new PeDomainError("PE_STALE_VERSION", "PE world entity changed since it was read", {
        expectedVersion: input.expectedVersion,
        actualVersion: current.version,
      });
    }
    try {
      assertTransition(input.lifecycle, String(current.state), input.targetState);
    } catch {
      throw new PeDomainError(
        "PE_INVALID_TRANSITION",
        `Invalid ${input.lifecycle} transition ${String(current.state)} -> ${input.targetState}`,
      );
    }
    const entries = Object.entries(input.updates ?? {}).filter(([, value]) => value !== undefined);
    const assignments = ["state=$3", ...entries.map(([column], index) => `${quoted(column)}=$${index + 4}`), "version=version+1", "updated_at=now()"];
    const updated = await client.query<SqlRow>(
      `UPDATE finnor_os.${quoted(WORLD_TABLES[input.lifecycle])}
          SET ${assignments.join(",")}
        WHERE tenant_id=$1 AND id=$2 AND version=$${entries.length + 4}
        RETURNING *`,
      [ctx.auth.tenantId, input.id, input.targetState, ...entries.map(([, value]) => value), input.expectedVersion],
    );
    if (!updated.rows[0]) throw new PeDomainError("PE_STALE_VERSION", "PE world entity changed concurrently");
    return { row: shapePeRow(updated.rows[0]), changed: true, idempotent: false };
  });
}

export function creationValues(ctx: PeMutationContext): Record<string, unknown> {
  const source = peProvenance(ctx);
  return {
    tenant_id: ctx.auth.tenantId,
    source_system: source.sourceSystem,
    external_id: source.externalId,
    created_by: source.createdBy,
    observed_at: source.observedAt,
  };
}

async function createWorldRow(
  ctx: PeMutationContext,
  table: string,
  values: Record<string, unknown>,
): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => {
    const row = await insertPeRow(client, table, { id: values.id ?? randomUUID(), ...creationValues(ctx), ...values });
    return { row: shapePeRow(row), changed: true, idempotent: false };
  });
}

export async function createStrategy(ctx: PeMutationContext, input: {
  id?: string;
  name: string;
  description?: string;
  investmentCriteria?: Record<string, unknown>;
}): Promise<PeMutationResult> {
  assertPeText(input.name, "Strategy name");
  return createWorldRow(ctx, "pe_strategies", {
    id: input.id,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    investment_criteria: input.investmentCriteria ?? {},
  });
}

export function transitionStrategy(ctx: PeMutationContext, input: {
  strategyId: string;
  expectedVersion: number;
  targetState: "active" | "retired";
}): Promise<PeMutationResult> {
  return transitionWorld({ ...ctx }, {
    lifecycle: "strategy",
    id: input.strategyId,
    expectedVersion: input.expectedVersion,
    targetState: input.targetState,
    updates: input.targetState === "active" ? { activated_at: new Date() } : { retired_at: new Date() },
  });
}

export async function createOpportunity(ctx: PeMutationContext, input: {
  id?: string;
  strategyId: string;
  targetOrganizationId: string;
  name: string;
  summary?: string;
}): Promise<PeMutationResult> {
  assertPeUuid(input.strategyId, "strategyId");
  assertPeUuid(input.targetOrganizationId, "targetOrganizationId");
  assertPeText(input.name, "Opportunity name");
  return createWorldRow(ctx, "pe_opportunities", {
    id: input.id,
    strategy_id: input.strategyId,
    target_organization_id: input.targetOrganizationId,
    name: input.name.trim(),
    summary: input.summary?.trim() || null,
  });
}

export function transitionOpportunity(ctx: PeMutationContext, input: {
  opportunityId: string;
  expectedVersion: number;
  targetState: "screening" | "qualified" | "rejected";
  rejectionReason?: string;
}): Promise<PeMutationResult> {
  if (input.targetState === "rejected") assertPeText(input.rejectionReason ?? "", "Opportunity rejection reason");
  const now = new Date();
  const updates = input.targetState === "screening"
    ? { screening_started_at: now }
    : input.targetState === "qualified"
      ? { qualified_at: now }
      : { rejected_at: now, rejection_reason: input.rejectionReason!.trim() };
  return transitionWorld(ctx, {
    lifecycle: "opportunity",
    id: input.opportunityId,
    expectedVersion: input.expectedVersion,
    targetState: input.targetState,
    updates,
  });
}

export interface PromoteOpportunityResult {
  opportunity: Record<string, unknown>;
  deal: Record<string, unknown>;
  changed: boolean;
  idempotent: boolean;
}

export async function promoteOpportunityToDeal(ctx: PeMutationContext, input: {
  opportunityId: string;
  expectedVersion: number;
  deal: Omit<CreateDealInput, "targetOrganizationId">;
}): Promise<PromoteOpportunityResult> {
  assertPeUuid(input.opportunityId, "opportunityId");
  assertPeUuid(input.deal.dealLeadEmployeeId, "dealLeadEmployeeId");
  assertPeText(input.deal.name, "Deal name");
  finiteDate(input.deal.signedLoiAt, "signedLoiAt");
  finiteDate(input.deal.targetClosingAt, "targetClosingAt");
  return peTransaction(ctx, async (_db, client) => {
    const opportunity = await worldRowForUpdate(client, ctx, "opportunity", input.opportunityId);
    if (opportunity.state === "promoted") {
      const existing = await client.query<SqlRow>(
        "SELECT * FROM finnor_os.pe_deals WHERE tenant_id=$1 AND opportunity_id=$2",
        [ctx.auth.tenantId, input.opportunityId],
      );
      if (!existing.rows[0]) throw new PeDomainError("PE_PROMOTION_INCOMPLETE", "Promoted Opportunity has no canonical Deal");
      return { opportunity: shapePeRow(opportunity), deal: shapePeRow(existing.rows[0]), changed: false, idempotent: true };
    }
    if (opportunity.state !== "qualified") {
      throw new PeDomainError("PE_INVALID_TRANSITION", `Opportunity must be qualified before promotion; found ${String(opportunity.state)}`);
    }
    if (Number(opportunity.version) !== input.expectedVersion) {
      throw new PeDomainError("PE_STALE_VERSION", "Opportunity changed since it was read", {
        expectedVersion: input.expectedVersion,
        actualVersion: opportunity.version,
      });
    }
    const lead = await client.query<{ tenant_id: string | null }>(
      "SELECT finnor_os.pe_party_tenant('employee',$1::uuid)::text AS tenant_id",
      [input.deal.dealLeadEmployeeId],
    );
    if (lead.rows[0]?.tenant_id !== ctx.auth.tenantId) {
      throw new PeDomainError("PE_PARTY_NOT_RESOLVED", "Deal lead is missing, inactive, or outside the authenticated tenant");
    }
    const dealResult = await createDealTx(client, ctx, {
      ...input.deal,
      targetOrganizationId: String(opportunity.target_organization_id),
      opportunityId: input.opportunityId,
    });
    await client.query("SELECT set_config('app.pe_opportunity_transition','promote',true)");
    const promoted = await client.query<SqlRow>(
      `UPDATE finnor_os.pe_opportunities
          SET state='promoted',promoted_at=now(),version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING *`,
      [ctx.auth.tenantId, input.opportunityId, input.expectedVersion],
    );
    if (!promoted.rows[0]) throw new PeDomainError("PE_STALE_VERSION", "Opportunity changed concurrently during promotion");
    return { opportunity: shapePeRow(promoted.rows[0]), deal: dealResult.row, changed: true, idempotent: false };
  });
}

export async function createInvestmentCase(ctx: PeMutationContext, input: {
  id?: string;
  dealId: string;
  title: string;
  summary?: string;
}): Promise<PeMutationResult> {
  assertPeUuid(input.dealId, "dealId");
  assertPeText(input.title, "InvestmentCase title");
  return createWorldRow(ctx, "pe_investment_cases", {
    id: input.id,
    deal_id: input.dealId,
    title: input.title.trim(),
    summary: input.summary?.trim() || null,
  });
}

export const activateInvestmentCase = (ctx: PeMutationContext, input: { investmentCaseId: string; expectedVersion: number }) =>
  transitionWorld(ctx, { lifecycle: "investment_case", id: input.investmentCaseId, expectedVersion: input.expectedVersion,
    targetState: "active", updates: { activated_at: new Date() } });

export const supersedeInvestmentCase = (ctx: PeMutationContext, input: { investmentCaseId: string; expectedVersion: number }) =>
  transitionWorld(ctx, { lifecycle: "investment_case", id: input.investmentCaseId, expectedVersion: input.expectedVersion,
    targetState: "superseded", updates: { superseded_at: new Date() } });

export const archiveInvestmentCase = (ctx: PeMutationContext, input: { investmentCaseId: string; expectedVersion: number }) =>
  transitionWorld(ctx, { lifecycle: "investment_case", id: input.investmentCaseId, expectedVersion: input.expectedVersion,
    targetState: "archived", updates: { archived_at: new Date() } });

export async function createThesis(ctx: PeMutationContext, input: {
  id?: string;
  dealId: string;
  investmentCaseId: string;
  thesisType: string;
  title: string;
  statement: string;
}): Promise<PeMutationResult> {
  assertPeText(input.thesisType, "Thesis type");
  assertPeText(input.title, "Thesis title");
  assertPeText(input.statement, "Thesis statement");
  return createWorldRow(ctx, "pe_theses", {
    id: input.id,
    deal_id: input.dealId,
    investment_case_id: input.investmentCaseId,
    thesis_type: input.thesisType.trim(),
    title: input.title.trim(),
    statement: input.statement.trim(),
  });
}

export function transitionThesis(ctx: PeMutationContext, input: {
  thesisId: string;
  expectedVersion: number;
  targetState: "active" | "superseded" | "retired";
}): Promise<PeMutationResult> {
  const now = new Date();
  return transitionWorld(ctx, {
    lifecycle: "thesis",
    id: input.thesisId,
    expectedVersion: input.expectedVersion,
    targetState: input.targetState,
    updates: input.targetState === "active" ? { activated_at: now }
      : input.targetState === "superseded" ? { superseded_at: now } : { retired_at: now },
  });
}

function assertAssumptionValue(valueType: AssumptionValueType, value: unknown, currencyCode?: string): void {
  if (["number", "currency", "percent"].includes(valueType) && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", `${valueType} assumptions require a finite number`);
  }
  if (valueType === "boolean" && typeof value !== "boolean") throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", "boolean assumptions require a boolean");
  if (valueType === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", "date assumptions require YYYY-MM-DD text");
  }
  if (valueType === "text" && typeof value !== "string") throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", "text assumptions require text");
  if (valueType === "json" && (!value || typeof value !== "object")) throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", "json assumptions require an object or array");
  if (valueType === "currency" && !/^[A-Z]{3}$/.test(currencyCode ?? "")) {
    throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", "currency assumptions require a three-letter uppercase currency code");
  }
  if (valueType !== "currency" && currencyCode !== undefined) {
    throw new PeDomainError("PE_INVALID_ASSUMPTION_VALUE", "currencyCode is valid only for currency assumptions");
  }
}

export interface AssumptionInput {
  id?: string;
  dealId: string;
  investmentCaseId: string;
  assumptionKey: string;
  statement: string;
  valueType: AssumptionValueType;
  value: unknown;
  currencyCode?: string;
  unit?: string;
  materiality?: "low" | "medium" | "high" | "critical";
}

export async function createAssumption(ctx: PeMutationContext, input: AssumptionInput): Promise<PeMutationResult> {
  assertPeText(input.assumptionKey, "Assumption key");
  assertPeText(input.statement, "Assumption statement");
  assertAssumptionValue(input.valueType, input.value, input.currencyCode);
  return createWorldRow(ctx, "pe_assumptions", {
    id: input.id,
    deal_id: input.dealId,
    investment_case_id: input.investmentCaseId,
    assumption_key: input.assumptionKey.trim(),
    statement: input.statement.trim(),
    value_type: input.valueType,
    value: JSON.stringify(input.value),
    currency_code: input.currencyCode ?? null,
    unit: input.unit?.trim() || null,
    materiality: input.materiality ?? "medium",
  });
}

export async function reviseAssumption(ctx: PeMutationContext, input: {
  assumptionId: string;
  expectedVersion: number;
  replacement: Omit<AssumptionInput, "dealId" | "investmentCaseId" | "assumptionKey"> & { assumptionKey?: string };
}): Promise<PeMutationResult> {
  assertAssumptionValue(input.replacement.valueType, input.replacement.value, input.replacement.currencyCode);
  assertPeText(input.replacement.statement, "Assumption statement");
  return peTransaction(ctx, async (_db, client) => {
    const prior = await worldRowForUpdate(client, ctx, "assumption", input.assumptionId);
    if (prior.state !== "active") throw new PeDomainError("PE_INVALID_TRANSITION", "Only an active Assumption can be revised");
    if (Number(prior.version) !== input.expectedVersion) throw new PeDomainError("PE_STALE_VERSION", "Assumption changed since it was read");
    const superseded = await client.query(
      `UPDATE finnor_os.pe_assumptions SET state='superseded',superseded_at=now(),version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND version=$3`,
      [ctx.auth.tenantId, input.assumptionId, input.expectedVersion],
    );
    if (superseded.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "Assumption changed concurrently");
    const row = await insertPeRow(client, "pe_assumptions", {
      id: input.replacement.id ?? randomUUID(),
      ...creationValues(ctx),
      deal_id: prior.deal_id,
      investment_case_id: prior.investment_case_id,
      assumption_key: input.replacement.assumptionKey?.trim() || prior.assumption_key,
      statement: input.replacement.statement.trim(),
      value_type: input.replacement.valueType,
      value: JSON.stringify(input.replacement.value),
      currency_code: input.replacement.currencyCode ?? null,
      unit: input.replacement.unit?.trim() || null,
      materiality: input.replacement.materiality ?? prior.materiality,
      supersedes_assumption_id: prior.id,
    });
    return { row: shapePeRow(row), changed: true, idempotent: false };
  });
}

export function invalidateAssumption(ctx: PeMutationContext, input: {
  assumptionId: string;
  expectedVersion: number;
  reason: string;
}): Promise<PeMutationResult> {
  assertPeText(input.reason, "Assumption invalidation reason");
  return transitionWorld(ctx, {
    lifecycle: "assumption",
    id: input.assumptionId,
    expectedVersion: input.expectedVersion,
    targetState: "invalidated",
    updates: { invalidated_at: new Date(), invalidation_reason: input.reason.trim() },
  });
}

export async function recordDecision(ctx: PeMutationContext, input: {
  id?: string;
  dealId: string;
  investmentCaseId: string;
  decisionType: string;
  title: string;
  decision: string;
  rationale?: string;
  supersedesDecisionId?: string;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => recordDecisionTx(client, ctx, input));
}

/** P1-owned transaction form. P5 may compose this inside its serializable
 * finalization boundary, but the canonical insert remains implemented here. */
export async function recordDecisionTx(client: PeClient, ctx: PeMutationContext, input: {
  id?: string;
  dealId: string;
  investmentCaseId: string;
  decisionType: string;
  title: string;
  decision: string;
  rationale?: string;
  supersedesDecisionId?: string;
}): Promise<PeMutationResult> {
  assertPeText(input.decisionType, "Decision type");
  assertPeText(input.title, "Decision title");
  assertPeText(input.decision, "Decision");
  const row = await insertPeRow(client, "pe_decisions", {
    id: input.id ?? randomUUID(),
    ...creationValues(ctx),
    deal_id: input.dealId,
    investment_case_id: input.investmentCaseId,
    decision_type: input.decisionType.trim(),
    title: input.title.trim(),
    decision: input.decision.trim(),
    rationale: input.rationale?.trim() || null,
    supersedes_decision_id: input.supersedesDecisionId ?? null,
  });
  return { row: shapePeRow(row), changed: true, idempotent: false };
}

export async function finalizeDecision(ctx: PeMutationContext, input: {
  decisionId: string;
  expectedVersion: number;
  decidedBy: PePartyRef;
  decidedAt?: Date;
}): Promise<PeMutationResult> {
  return peTransaction(ctx, async (_db, client) => finalizeDecisionTx(client, ctx, input));
}

/** P1-owned transaction form used to keep P5 process linkage and the canonical
 * Decision atomic without granting P5 a second insert/transition owner. */
export async function finalizeDecisionTx(client: PeClient, ctx: PeMutationContext, input: {
  decisionId: string;
  expectedVersion: number;
  decidedBy: PePartyRef;
  decidedAt?: Date;
}): Promise<PeMutationResult> {
  const current = await worldRowForUpdate(client, ctx, "decision", input.decisionId);
  if (current.state === "final") return { row: shapePeRow(current), changed: false, idempotent: true };
  if (current.state !== "draft") throw new PeDomainError("PE_INVALID_TRANSITION", "Only a draft Decision can be finalized");
  if (Number(current.version) !== input.expectedVersion) throw new PeDomainError("PE_STALE_VERSION", "Decision changed since it was read");
  if (current.supersedes_decision_id) {
    const prior = await worldRowForUpdate(client, ctx, "decision", String(current.supersedes_decision_id));
    if (prior.state !== "final" || prior.deal_id !== current.deal_id || prior.investment_case_id !== current.investment_case_id) {
      throw new PeDomainError("PE_INVALID_SUPERSESSION", "Replacement Decision must supersede a final Decision in the same InvestmentCase");
    }
  }
  const finalized = await client.query<SqlRow>(
    `UPDATE finnor_os.pe_decisions
        SET state='final',decided_by_party_type=$3,decided_by_party_id=$4,decided_at=$5,version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND version=$6 RETURNING *`,
    [ctx.auth.tenantId, input.decisionId, input.decidedBy.partyType, input.decidedBy.partyId,
      input.decidedAt ?? new Date(), input.expectedVersion],
  );
  const row = finalized.rows[0];
  if (!row) throw new PeDomainError("PE_STALE_VERSION", "Decision changed concurrently");
  if (current.supersedes_decision_id) {
    await client.query("SELECT set_config('app.pe_decision_transition','supersede',true)");
    const prior = await client.query(
      `UPDATE finnor_os.pe_decisions
          SET state='superseded',superseded_at=now(),version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND state='final'`,
      [ctx.auth.tenantId, current.supersedes_decision_id],
    );
    if (prior.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "Superseded Decision changed concurrently");
  }
  return { row: shapePeRow(row), changed: true, idempotent: false };
}

export async function supersedeDecision(ctx: PeMutationContext, input: {
  decisionId: string;
  expectedVersion: number;
  replacementId?: string;
  decisionType: string;
  title: string;
  decision: string;
  rationale?: string;
  decidedBy: PePartyRef;
  decidedAt?: Date;
}): Promise<PeMutationResult> {
  assertPeText(input.decisionType, "Decision type");
  assertPeText(input.title, "Decision title");
  assertPeText(input.decision, "Decision");
  return peTransaction(ctx, async (_db, client) => {
    const prior = await worldRowForUpdate(client, ctx, "decision", input.decisionId);
    if (prior.state !== "final") throw new PeDomainError("PE_INVALID_TRANSITION", "Only a final Decision can be superseded");
    if (Number(prior.version) !== input.expectedVersion) throw new PeDomainError("PE_STALE_VERSION", "Decision changed since it was read");
    const source = peProvenance(ctx);
    let replacement = await insertPeRow(client, "pe_decisions", {
      id: input.replacementId ?? randomUUID(),
      tenant_id: ctx.auth.tenantId,
      deal_id: prior.deal_id,
      investment_case_id: prior.investment_case_id,
      decision_type: input.decisionType.trim(),
      title: input.title.trim(),
      decision: input.decision.trim(),
      rationale: input.rationale?.trim() || null,
      supersedes_decision_id: prior.id,
      source_system: source.sourceSystem,
      external_id: source.externalId,
      created_by: source.createdBy,
      observed_at: source.observedAt,
    });
    const finalized = await client.query<SqlRow>(
      `UPDATE finnor_os.pe_decisions
          SET state='final',decided_by_party_type=$3,decided_by_party_id=$4,decided_at=$5,version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND version=1 RETURNING *`,
      [ctx.auth.tenantId, replacement.id, input.decidedBy.partyType, input.decidedBy.partyId, input.decidedAt ?? new Date()],
    );
    replacement = finalized.rows[0]!;
    await client.query("SELECT set_config('app.pe_decision_transition','supersede',true)");
    const old = await client.query(
      `UPDATE finnor_os.pe_decisions
          SET state='superseded',superseded_at=now(),version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND version=$3`,
      [ctx.auth.tenantId, input.decisionId, input.expectedVersion],
    );
    if (old.rowCount !== 1) throw new PeDomainError("PE_STALE_VERSION", "Decision changed concurrently");
    return { row: shapePeRow(replacement), changed: true, idempotent: false };
  });
}

export async function linkDecisionEffects(ctx: PeMutationContext, input: {
  decisionId: string;
  effects: Array<{
    effectType: "work" | "domain_action" | "decision_receipt";
    effectId: string;
    relationship?: "implements" | "records" | "governs";
  }>;
}): Promise<Record<string, unknown>[]> {
  if (input.effects.length === 0 || input.effects.length > 100) {
    throw new PeDomainError("PE_INVALID_INPUT", "Decision effects must contain between 1 and 100 links");
  }
  return peTransaction(ctx, async (_db, client) => linkDecisionEffectsTx(client, ctx, input));
}

/** P1-owned transaction form for canonical Decision effect links. */
export async function linkDecisionEffectsTx(client: PeClient, ctx: PeMutationContext, input: {
  decisionId: string;
  effects: Array<{
    effectType: "work" | "domain_action" | "decision_receipt";
    effectId: string;
    relationship?: "implements" | "records" | "governs";
  }>;
}): Promise<Record<string, unknown>[]> {
  if (input.effects.length === 0 || input.effects.length > 100) {
    throw new PeDomainError("PE_INVALID_INPUT", "Decision effects must contain between 1 and 100 links");
  }
  const createdBy = peProvenance(ctx).createdBy;
  const rows: Record<string, unknown>[] = [];
  for (const effect of input.effects) {
    assertPeUuid(effect.effectId, "effectId");
    const result = await client.query<SqlRow>(
      `INSERT INTO finnor_os.pe_decision_effect_links
        (id,tenant_id,decision_id,effect_type,effect_id,relationship,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (decision_id,effect_type,effect_id,relationship) DO NOTHING
       RETURNING *`,
      [randomUUID(), ctx.auth.tenantId, input.decisionId, effect.effectType, effect.effectId,
        effect.relationship ?? "implements", createdBy],
    );
    const row = result.rows[0] ?? (await client.query<SqlRow>(
      `SELECT * FROM finnor_os.pe_decision_effect_links
        WHERE tenant_id=$1 AND decision_id=$2 AND effect_type=$3 AND effect_id=$4 AND relationship=$5`,
      [ctx.auth.tenantId, input.decisionId, effect.effectType, effect.effectId, effect.relationship ?? "implements"],
    )).rows[0];
    if (!row) throw new PeDomainError("PE_WRITE_FAILED", "Decision effect link was not persisted");
    rows.push(shapePeRow(row));
  }
  return rows;
}

export async function resolvePeWorldRoot(
  ctx: PeMutationContext,
  entity: PeEntityRef,
): Promise<{ root: PeWorldRootRef; dealId: string | null }> {
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<{ root_type: PeWorldRootRef["entityType"]; root_id: string; deal_id: string | null }>(
      "SELECT root_type,root_id::text,deal_id::text FROM finnor_os.pe_entity_world_root($1,$2::uuid)",
      [entity.entityType, entity.entityId],
    );
    const row = result.rows[0];
    if (!row) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE entity has no world root in the authenticated tenant");
    return { root: { entityType: row.root_type, entityId: row.root_id }, dealId: row.deal_id };
  }, { readOnly: true });
}

export async function attachWorkToWorldEntity(ctx: PeMutationContext, input: {
  workId: string;
  entity: PeEntityRef & { relationship?: "about" | "target" | "result" };
}): Promise<void> {
  await peTransaction(ctx, async (db, client) => {
    const root = await client.query("SELECT * FROM finnor_os.pe_entity_world_root($1,$2::uuid)", [input.entity.entityType, input.entity.entityId]);
    if (!root.rows[0]) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE Work anchor has no canonical world root");
    await attachWorkEntityTx(db, {
      tenantId: ctx.auth.tenantId,
      workId: input.workId,
      entity: {
        entityType: input.entity.entityType,
        entityId: input.entity.entityId,
        relationship: input.entity.relationship ?? "about",
        source: peProvenance(ctx).sourceSystem,
      },
    });
  });
}
