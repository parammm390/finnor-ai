import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { createGroundedMemoArtifact, getArtifact, instantiateArtifactTemplate, type GroundedMemoSection, type GroundedTemplateField } from "@finnor/artifacts";
import {
  authorityApprovalRequests,
  authorityDecisions,
  decisionReceipts,
  documents,
  evidenceSources,
  evidenceSourceVersions,
  withTenant,
} from "@finnor/db";
import {
  attachCanonicalEvidence,
  attachCanonicalDocument,
  attachWorkToDealGraph,
  attachIcQuestionSource,
  beginIcPreparation,
  buildPrivateEquityEpistemicSnapshot,
  createClosingCondition,
  createDealRisk,
  createDependency,
  createFinding,
  createIcCase,
  createIcRecommendation,
  createIcQuestion,
  createUnderwritingScenario,
  createUnderwritingRun,
  createRequest,
  createWorkstream,
  declareDealClosed,
  evaluateDealCloseEligibility,
  getIcWorkspace,
  getUnderwritingRun,
  groundIcCaseOpening,
  groundIcMemoDocumentVersion,
  groundIcSourceReference,
  groundIcUnderwritingRun,
  loadDealExecutionGraph,
  loadPrivateEquityAssertions,
  loadPrivateEquityAssertionsForEvidence,
  markIcReadyForReview,
  pePropositionId,
  pinPrivateEquityDecisionReadiness,
  peTransaction,
  PeDomainError,
  receiveDeliverable,
  removeDependency,
  resolveDealRisk,
  resolveFinding,
  prepareIcDecisionProposal,
  recordIcMetric,
  satisfyIcCondition,
  selectIcMemoVersion,
  selectPrimaryIcUnderwritingRun,
  satisfyClosingCondition,
  verifyClosingItem,
  waiveClosingCondition,
  type DealExecutionGraph,
  type GovernanceProof,
  type IcSourceLinkInput,
  type IcSourceRef,
  type PeEntityRef,
  type PeMutationContext,
  type PeMutationResult,
} from "@finnor/private-equity";
import type { UnderwritingScenario } from "@finnor/underwriting";
import { resolveParty } from "@finnor/read-models";
import type {
  DomainAction,
  DomainPolicy,
  DraftAction,
  ExecutionResult,
  PartyRef,
  ValidationResult,
} from "@finnor/shared-types";
import type { ToolRegistry } from "@finnor/tools";
import {
  ActionGroundingError,
  type DomainActionGrounding,
  type DomainEnginePlugin,
} from "../shared/plugin-interface";
import {
  PRIVATE_EQUITY_ACTION_SCHEMAS,
  PRIVATE_EQUITY_ACTION_TYPES,
  type PrivateEquityActionType,
} from "./schemas";

export * from "./schemas";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

export interface PrivateEquityActionContract {
  actionType: PrivateEquityActionType;
  canonicalMutationOwner: string;
  resultEntityType: PeEntityRef["entityType"] | "underwriting_run";
  idempotencyIdentity: "domain_action_id";
  verification: "canonical_return_and_reread";
  receiptPath: "core_durable_action_receipt";
}

/** Auditable one-to-one map: the plugin translates, while PE2 remains the only
 * owner of business truth and state-machine semantics. */
export const PRIVATE_EQUITY_ACTION_CONTRACTS: readonly PrivateEquityActionContract[] = [
  ["create_underwriting_run", "createUnderwritingRun", "underwriting_run"],
  ["open_ic_case", "createIcCase", "pe_ic_case"],
  ["begin_ic_preparation", "beginIcPreparation", "pe_ic_case"],
  ["create_ic_deck_draft", "instantiateArtifactTemplate + attachCanonicalDocument", "pe_document_link"],
  ["create_ic_memo_draft", "createGroundedMemoArtifact + attachCanonicalDocument", "pe_document_link"],
  ["select_ic_memo_version", "selectIcMemoVersion", "pe_ic_memo"],
  ["select_ic_underwriting_run", "selectPrimaryIcUnderwritingRun", "pe_ic_case"],
  ["create_ic_question", "createIcQuestion", "pe_ic_question"],
  ["attach_ic_question_evidence", "attachIcQuestionSource", "pe_ic_question"],
  ["request_ic_memo_review", "markIcReadyForReview", "pe_ic_case"],
  ["prepare_ic_recommendation", "createIcRecommendation", "pe_ic_recommendation"],
  ["satisfy_ic_condition", "satisfyIcCondition", "pe_ic_condition"],
  ["prepare_ic_decision_proposal", "prepareIcDecisionProposal", "pe_ic_decision_proposal"],
  ["open_workstream", "createWorkstream", "pe_workstream"],
  ["create_deal_request", "createRequest", "pe_request"],
  ["submit_deliverable", "receiveDeliverable", "pe_deliverable"],
  ["record_finding", "createFinding", "pe_finding"],
  ["resolve_finding", "resolveFinding", "pe_finding"],
  ["raise_deal_risk", "createDealRisk", "pe_deal_risk"],
  ["resolve_deal_risk", "resolveDealRisk", "pe_deal_risk"],
  ["link_deal_dependency", "createDependency", "pe_dependency"],
  ["mark_dependency_resolved", "removeDependency", "pe_dependency"],
  ["create_closing_condition", "createClosingCondition", "pe_closing_condition"],
  ["submit_condition_evidence", "attachCanonicalEvidence", "pe_evidence_link"],
  ["satisfy_closing_condition", "satisfyClosingCondition", "pe_closing_condition"],
  ["waive_closing_condition", "waiveClosingCondition", "pe_closing_condition"],
  ["verify_closing_item", "verifyClosingItem", "pe_closing_item"],
  ["declare_deal_closed", "declareDealClosed", "pe_deal"],
].map(([actionType, canonicalMutationOwner, resultEntityType]) => ({
  actionType: actionType as PrivateEquityActionType,
  canonicalMutationOwner: canonicalMutationOwner!,
  resultEntityType: resultEntityType as PrivateEquityActionContract["resultEntityType"],
  idempotencyIdentity: "domain_action_id" as const,
  verification: "canonical_return_and_reread" as const,
  receiptPath: "core_durable_action_receipt" as const,
}));

const CONTRACT_BY_ACTION = new Map(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => [row.actionType, row]));
const CREATE_ID_FIELD: Partial<Record<PrivateEquityActionType, string>> = {
  open_ic_case: "icCaseId",
  select_ic_memo_version: "memoSelectionId",
  create_ic_question: "questionId",
  prepare_ic_decision_proposal: "decisionProposalId",
  open_workstream: "workstreamId",
  create_deal_request: "requestId",
  record_finding: "findingId",
  raise_deal_risk: "dealRiskId",
  link_deal_dependency: "dependencyId",
  create_closing_condition: "closingConditionId",
};

const COLLECTION_BY_TYPE: Partial<Record<PeEntityRef["entityType"], keyof DealExecutionGraph>> = {
  pe_deal_party: "dealParties",
  pe_workstream: "workstreams",
  pe_request: "requests",
  pe_deliverable: "deliverables",
  pe_finding: "findings",
  pe_deal_risk: "dealRisks",
  pe_dependency: "dependencies",
  pe_milestone: "milestones",
  pe_closing_condition: "closingConditions",
  pe_closing_item: "closingItems",
  pe_document_link: "documentLinks",
  pe_evidence_link: "evidenceLinks",
  pe_finding_risk_link: "findingRiskLinks",
};

const IC_PLANNER_ACTIONS = new Set<PrivateEquityActionType>([
  "create_underwriting_run",
  "open_ic_case",
  "begin_ic_preparation",
  "create_ic_deck_draft",
  "create_ic_memo_draft",
  "select_ic_memo_version",
  "select_ic_underwriting_run",
  "create_ic_question",
  "attach_ic_question_evidence",
  "request_ic_memo_review",
  "prepare_ic_recommendation",
  "satisfy_ic_condition",
  "prepare_ic_decision_proposal",
]);

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

/** Present exact persisted decimals and period labels without serializing runtime envelopes. */
function memoValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "not recorded";
  const series = Object.entries(record(value));
  if (!series.length || series.some(([, amount]) => typeof amount !== "string" && typeof amount !== "number")) {
    throw new PeDomainError("IC_MEMO_UNDISPLAYABLE_VALUE", "A memo input or output is not a scalar or recorded period series");
  }
  return series.map(([period, amount]) => {
    const dates = period.split(":").filter((part) => /^\d{4}-\d{2}-\d{2}$/.test(part));
    return `${dates.length === 2 ? dates.join(" to ") : period}: ${String(amount)}`;
  }).join("; ");
}

function recordedOutput(outputs: Row, dependency: string): Row {
  const candidates = Object.values(outputs).map(record).filter((output) =>
    output.nodeId === dependency || output.calculation === `output(${dependency})`
    || (Array.isArray(output.directDependencies) && output.directDependencies.length === 1 && output.directDependencies[0] === dependency));
  return candidates.length === 1 ? candidates[0]! : record(outputs[dependency]);
}

function sourcedMemoSections(input: {
  caseId: string;
  run: Row;
  graph: DealExecutionGraph;
}): GroundedMemoSection[] {
  const runId = String(input.run.id);
  const runRef = `underwriting_run:${runId}`;
  const result = record(input.run.result);
  const outputs = record(result.outputs);
  const values = record(record(input.run.inputSnapshot).values);
  const revenue = record(values["operating.revenue_explicit"]);
  const riskRows = input.graph.dealRisks.filter((row) => row.archivedAt == null && ["open", "mitigating"].includes(String(row.state)));
  const findingRows = input.graph.findings.filter((row) => row.archivedAt == null && row.state === "open");
  const evidenceRows = input.graph.evidenceLinks.filter((row) => row.archivedAt == null);
  if (riskRows.length + findingRows.length + evidenceRows.length > 80) {
    throw new PeDomainError("IC_MEMO_SOURCE_LIMIT", "The Deal has too many current risk, finding, or evidence records for an unabridged memo");
  }
  const fact = (text: string, ...sourceRefs: string[]) => ({ text, sourceRefs });
  const growth = record(values["operating.revenue_growth"]);
  const inputText = revenue.value !== undefined
    ? `Recorded revenue series (${String(revenue.status ?? "status unavailable")}): ${memoValue(revenue.value)}.`
    : growth.value !== undefined
      ? `Recorded revenue growth (${String(growth.status ?? "status unavailable")}, decimal rate): ${memoValue(growth.value)}.`
      : "The Run does not expose an explicit revenue series or growth input in its snapshot.";
  if (inputText.length > 3_500) throw new PeDomainError("IC_MEMO_SOURCE_LIMIT", "The revenue input series exceeds the memo source limit");
  const highlightedOutputs = ["returns.gross_sponsor_irr", "returns.gross_sponsor_moic", "returns.sponsor_exit_proceeds", "exit.enterprise_value"]
    .flatMap((key) => {
      const output = recordedOutput(outputs, key);
      if (output.value === undefined) return [];
      const raw = memoValue(output.value);
      if (raw.length > 2_000) throw new PeDomainError("IC_MEMO_SOURCE_LIMIT", `Output ${key} exceeds the memo source limit`);
      return [fact(`${key.replaceAll(".", " ").replaceAll("_", " ")}: ${raw} (${String(output.unit ?? "unit not recorded")}; ${String(output.truthClass ?? "truth class unavailable")}).`, runRef)];
    });
  return [
    {
      heading: "Basis and source cutoff",
      paragraphs: [
        fact(`IC Case ${input.caseId} uses primary Underwriting Run ${runId}. The run status is ${String(input.run.status)} and validity is ${String(input.run.validity)}. Scenario ${String(input.run.scenarioId ?? "none recorded")}; Model Version ${String(input.run.modelVersionId)}.`, `pe_ic_case:${input.caseId}`, runRef),
        fact("This working memo copies recorded inputs and outputs. It does not resolve diligence findings or make the committee's investment decision.", `pe_ic_case:${input.caseId}`, runRef),
      ],
    },
    { heading: "Revenue assumption and underwriting", paragraphs: [fact(inputText, runRef), ...highlightedOutputs] },
    {
      heading: "Open Deal risks",
      paragraphs: riskRows.length ? riskRows.map((row) => fact(`${String(row.state).toUpperCase()} · ${String(row.severity)} · ${String(row.statement)}`, `pe_deal_risk:${String(row.id)}`))
        : [fact("No open or mitigating Deal risk is recorded in this Deal graph snapshot.", `pe_deal:${String(input.graph.deal.id)}`)],
    },
    {
      heading: "Open diligence findings",
      paragraphs: findingRows.length ? findingRows.map((row) => fact(`${String(row.state).toUpperCase()} · ${String(row.materiality)} · ${String(row.statement)}`, `pe_finding:${String(row.id)}`))
        : [fact("No open finding is recorded in this Deal graph snapshot.", `pe_deal:${String(input.graph.deal.id)}`)],
    },
    {
      heading: "Linked evidence inventory",
      paragraphs: evidenceRows.length ? evidenceRows.map((row) => fact(`Evidence Link ${String(row.id)} references Evidence Source ${String(row.evidenceSourceId)} and Version ${String(row.evidenceVersionId ?? "not pinned")}; relationship ${String(row.relationship ?? "not recorded")}.`, `pe_evidence_link:${String(row.id)}`))
        : [fact("No evidence link is recorded in this Deal graph snapshot.", `pe_deal:${String(input.graph.deal.id)}`)],
    },
  ];
}

function sourcedDeckFields(input: { workspace: Awaited<ReturnType<typeof getIcWorkspace>>; run: Row; graph: DealExecutionGraph }): Record<string, GroundedTemplateField> {
  const { workspace, run, graph } = input;
  const canonicalSource = (type: string, row: Row): GroundedTemplateField["sources"][number] => ({
    targetKind: "canonical_entity", targetEntityType: type, targetId: String(row.id),
    ...(row.version ? { targetAnchor: `version:${String(row.version)}` } : {}),
  });
  const caseSource = canonicalSource("pe_ic_case", workspace.case);
  const runSource = canonicalSource("underwriting_run", run);
  const field = (text: string, ...sources: GroundedTemplateField["sources"]): GroundedTemplateField => {
    if (!text.trim() || text.length > 3_500) throw new PeDomainError("IC_DECK_SOURCE_LIMIT", "Recorded deck content exceeds the template's bounded field size");
    return { text, sources };
  };
  const values = record(record(run.inputSnapshot).values);
  const outputs = record(record(run.result).outputs);
  const revenue = record(values["operating.revenue_explicit"]);
  const growth = record(values["operating.revenue_growth"]);
  const exit = record(values["exit.multiple"]);
  const revenueText = revenue.value !== undefined ? `Revenue (${String(revenue.unit ?? "unit not recorded")}): ${memoValue(revenue.value)}`
    : growth.value !== undefined ? `Revenue growth (decimal rate): ${memoValue(growth.value)}` : "Revenue input unavailable in this Run.";
  const returns = [
    ["returns.gross_sponsor_irr", "Sponsor IRR"], ["returns.gross_sponsor_moic", "Sponsor MOIC"],
    ["returns.sponsor_exit_proceeds", "Sponsor exit proceeds"], ["exit.enterprise_value", "Exit enterprise value"],
  ].map(([key, label]) => {
    // Model output identifiers are user defined. Resolve the recorded dependency
    // instead of assuming that an output has its underlying calculation's ID.
    const output = recordedOutput(outputs, key!);
    if (output.value === undefined) return `${label}: no unambiguous recorded output`;
    const numeric = typeof output.value === "string" || typeof output.value === "number" ? Number(output.value) : NaN;
    const amount = Number.isFinite(numeric) ? new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2,
      ...(output.unit === "rate" ? { style: "percent", minimumFractionDigits: 2 } : {}) }).format(numeric) : memoValue(output.value);
    const unit = output.unit === "rate" ? "" : output.unit === "multiple" ? "x" : ` ${String(output.currency ?? output.unit ?? "unit not recorded")}`;
    return `${label}: ${amount}${unit}`;
  }).join("\n");
  const risks = graph.dealRisks.filter((row) => row.archivedAt == null && ["open", "mitigating"].includes(String(row.state)));
  const findings = graph.findings.filter((row) => row.archivedAt == null && row.state === "open");
  const evidence = graph.evidenceLinks.filter((row) => row.archivedAt == null);
  if (risks.length + findings.length > 12 || evidence.length > 12) throw new PeDomainError("IC_DECK_SOURCE_LIMIT", "The current Deal sources need a larger registered presentation template");
  const risksText = [
    ...risks.map((row) => `${String(row.severity).toUpperCase()}: ${String(row.statement)}`),
    ...findings.map((row) => `${String(row.materiality).toUpperCase()}: ${String(row.statement)}`),
  ].join("\n") || "No open finding or open/mitigating risk is recorded in this Deal graph snapshot.";
  const recommendation = workspace.currentRecommendation;
  const recommendationSource = recommendation ? canonicalSource("pe_ic_recommendation", recommendation) : caseSource;
  const memo = workspace.memo;
  const memoSources: GroundedTemplateField["sources"] = memo ? [canonicalSource("pe_ic_memo", memo), { targetKind: "document_version", targetId: String(memo.documentVersionId) }] : [caseSource];
  const evidenceGroups = new Map<string, Row[]>();
  for (const row of evidence) {
    const key = String(row.evidenceVersionId ?? `unpinned:${row.evidenceSourceId}`);
    evidenceGroups.set(key, [...(evidenceGroups.get(key) ?? []), row]);
  }
  const evidenceText = [...evidenceGroups].map(([key, links]) => {
    const relationships = links.map((row) => `${String(row.relationship ?? "relationship not recorded")}: ${String(row.entityType).replace(/^pe_/, "").replaceAll("_", " ")}`);
    return `Evidence ${key.startsWith("unpinned:") ? "version not pinned" : key}\n${[...new Set(relationships)].join("; ")}`;
  }).join("\n\n");
  return {
    company_name: field(String(graph.deal.name ?? graph.deal.title ?? "Name not recorded"), canonicalSource("pe_deal", graph.deal)),
    decision_context: field(`IC working draft\nCase state: ${String(workspace.case.state)}\nCommittee decision: ${workspace.case.finalDecisionId ? "recorded separately" : "not recorded"}`, caseSource),
    recommendation: field(recommendation ? `${String(recommendation.outcome).replaceAll("_", " ")}\n${String(recommendation.rationale ?? "Rationale not recorded")}` : "Recommendation not recorded. Human committee review remains outstanding.", recommendationSource),
    source_cutoff: field(`Sources read at ${workspace.asOf}\nUnderwriting world cutoff: ${run.worldAt instanceof Date ? run.worldAt.toISOString() : new Date(String(run.worldAt)).toISOString()}`, caseSource, runSource),
    revenue_case: field(`${revenueText}\nExit multiple: ${exit.value === undefined ? "not recorded" : `${memoValue(exit.value)}x`}\nRun status: ${String(run.status)}, validity: ${String(run.validity)}`, runSource),
    returns: field(returns, runSource),
    risk_findings: field(risksText, ...(risks.length + findings.length ? [
      ...risks.map((row) => canonicalSource("pe_deal_risk", row)), ...findings.map((row) => canonicalSource("pe_finding", row)),
    ] : [canonicalSource("pe_deal", graph.deal)])),
    model_lineage: field(`Run ${String(run.id)}\nModel version ${String(run.modelVersionId)}\nScenario ${String(run.scenarioId ?? "none recorded")}\nInvestment Case ${String(run.investmentCaseId)}`, runSource),
    memo_basis: field(memo ? `Memo version ${String(memo.documentVersionId)}\nSource completeness: ${String(memo.sourceCompleteness)}\nRecommendation ${String(recommendation?.id ?? "not recorded")}` : "The IC Case has no selected memo version.", ...memoSources, recommendationSource),
    source_inventory: field(evidence.length ? evidenceText : "No linked evidence is recorded in this Deal graph snapshot.", ...(evidence.length ? evidence.flatMap((row) => [
      canonicalSource("pe_evidence_link", row), ...(row.evidenceVersionId ? [{ targetKind: "evidence_version" as const, targetId: String(row.evidenceVersionId) }] : []),
    ]) : [canonicalSource("pe_deal", graph.deal)])),
  };
}

function requiredString(payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new ActionGroundingError("PE_INVALID_REFERENCE", `${field} is required`);
  return value;
}

function currentRow(graph: DealExecutionGraph, entityType: PeEntityRef["entityType"], entityId: string): Row | null {
  if (entityType === "pe_deal") return String(graph.deal.id) === entityId ? graph.deal : null;
  const collection = COLLECTION_BY_TYPE[entityType];
  if (!collection) return null;
  const rows = graph[collection];
  return Array.isArray(rows) ? (rows as Row[]).find((row) => String(row.id) === entityId) ?? null : null;
}

function entityRef(field: string, entityType: PeEntityRef["entityType"], entityId: string) {
  return { field, entityType, entityId };
}

function icState(row: Row, allowed: string[], actionType: PrivateEquityActionType): void {
  const state = String(row.state ?? "");
  if (!allowed.includes(state)) {
    throw new ActionGroundingError("IC_INVALID_TRANSITION", `ICCase state ${state} is not valid for ${actionType}`, { state, allowed });
  }
}

function icExpectedVersion(row: Row, expected: unknown, label: string): void {
  if (Number(row.version) !== Number(expected)) {
    throw new ActionGroundingError("IC_STALE_PRECONDITION", `${label} changed since it was inspected`, {
      expectedVersion: Number(expected), actualVersion: Number(row.version),
    });
  }
}

async function groundIcPlannerAction(params: {
  actionType: PrivateEquityActionType;
  payload: Payload;
  ctx: PeMutationContext;
  dealId: string;
  workId: string;
  graph: DealExecutionGraph;
}): Promise<DomainActionGrounding> {
  const { actionType, payload, ctx, dealId, workId, graph } = params;
  const groundedPayload: DomainActionGrounding["groundedPayload"] = [
    { field: "dealId", status: "verified" },
    { field: "workId", status: "verified" },
  ];
  const entities: Array<{ entityType: string; entityId: string; state?: unknown; version?: unknown }> = [];
  try {
    if (actionType === "create_underwriting_run") {
      const investmentCaseId = requiredString(payload, "investmentCaseId");
      const modelVersionId = requiredString(payload, "modelVersionId");
      const scenarioId = typeof payload.scenarioId === "string" ? payload.scenarioId : null;
      const baseRunId = typeof payload.baseRunId === "string" ? payload.baseRunId : null;
      const grounded = await peTransaction(ctx, async (_db, client) => {
        const investment = (await client.query<{ id: string; deal_id: string; state: string; version: number }>(
          "SELECT id::text,deal_id::text,state,version FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2",
          [ctx.auth.tenantId, investmentCaseId],
        )).rows[0];
        if (!investment || investment.deal_id !== dealId || !["draft", "active"].includes(investment.state)) {
          throw new ActionGroundingError("PE_INVESTMENT_CASE_NOT_WRITABLE", "The Investment Case must be draft or active inside the exact grounded Deal");
        }
        const model = (await client.query<{ id: string; investment_case_id: string; semantic_hash: string; model_definition: unknown }>(
          "SELECT id::text,investment_case_id::text,semantic_hash,model_definition FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND id=$2",
          [ctx.auth.tenantId, modelVersionId],
        )).rows[0];
        if (!model || model.investment_case_id !== investmentCaseId) {
          throw new ActionGroundingError("MODEL_VERSION_NOT_FOUND", "The immutable Model Version must belong to the exact Investment Case");
        }
        if (payload.scenario && typeof payload.scenario === "object") {
          const proposed = payload.scenario as { overrides: Array<{ nodeId: string }> };
          const nodes = record(model.model_definition).nodes;
          const inputNodeIds = new Set(Array.isArray(nodes) ? nodes.filter((node) => record(node).kind === "input").map((node) => String(record(node).id)) : []);
          const seen = new Set<string>();
          for (const override of proposed.overrides) {
            if (!inputNodeIds.has(override.nodeId) || seen.has(override.nodeId)) {
              throw new ActionGroundingError("SCENARIO_INVALID_TARGET", "Every scenario override must target one distinct input node in the exact Model Version");
            }
            seen.add(override.nodeId);
          }
        }
        if (scenarioId) {
          const scenario = (await client.query<{ model_version_id: string; investment_case_id: string }>(
            "SELECT model_version_id::text,investment_case_id::text FROM finnor_os.underwriting_scenarios WHERE tenant_id=$1 AND id=$2",
            [ctx.auth.tenantId, scenarioId],
          )).rows[0];
          if (!scenario || scenario.model_version_id !== modelVersionId || scenario.investment_case_id !== investmentCaseId) {
            throw new ActionGroundingError("SCENARIO_INVALID_TARGET", "Scenario must belong to the exact Investment Case and Model Version");
          }
        }
        if (baseRunId) {
          const base = (await client.query<{ model_version_id: string; investment_case_id: string; scenario_id: string | null; world_at: Date }>(
            "SELECT model_version_id::text,investment_case_id::text,scenario_id::text,world_at FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2",
            [ctx.auth.tenantId, baseRunId],
          )).rows[0];
          if (!base || base.model_version_id !== modelVersionId || base.investment_case_id !== investmentCaseId || base.scenario_id !== null) {
            throw new ActionGroundingError("SCENARIO_INVALID_TARGET", "Base Run must be canonical for the exact Investment Case and Model Version");
          }
          payload.worldAt = base.world_at.toISOString();
        }
        return { investment, model };
      }, { readOnly: true });
      groundedPayload.push({ field: "investmentCaseId", status: "verified" }, { field: "modelVersionId", status: "verified" }, { field: "worldAt", status: "verified" });
      if (scenarioId) groundedPayload.push({ field: "scenarioId", status: "verified" });
      if (payload.scenario) groundedPayload.push({ field: "scenario.overrides", status: "verified" });
      if (baseRunId) groundedPayload.push({ field: "baseRunId", status: "verified" });
      entities.push({ entityType: "pe_investment_case", entityId: investmentCaseId, state: grounded.investment.state, version: grounded.investment.version });
      entities.push({ entityType: "underwriting_model_version", entityId: modelVersionId, state: grounded.model.semantic_hash });
      payload.grounding = {
        verticalKey: "private_equity",
        deal: { entityType: "pe_deal", entityId: dealId, state: graph.deal.status, version: graph.deal.version, graphVersion: graph.deal.graphVersion },
        work: { entityType: "work", entityId: workId },
        entities,
      };
      return { draft: { actionType, payload, summary: "", requiresConfirmation: false }, groundedPayload };
    }
    if (actionType === "open_ic_case") {
      const investment = await groundIcCaseOpening(ctx, {
        dealId,
        investmentCaseId: requiredString(payload, "investmentCaseId"),
        committeeConfigVersionId: requiredString(payload, "committeeConfigVersionId"),
        scheduledInternalEventId: payload.scheduledInternalEventId as string | undefined,
        primaryUnderwritingRunId: payload.primaryUnderwritingRunId as string | undefined,
        reconsidersDecisionId: payload.reconsidersDecisionId as string | undefined,
      });
      groundedPayload.push(
        { field: "investmentCaseId", status: "verified" },
        { field: "committeeConfigVersionId", status: "verified" },
        { field: "icCaseId", status: "verified" },
      );
      entities.push({ entityType: "pe_investment_case", entityId: String(investment.id), state: investment.state, version: investment.version });
      payload.grounding = {
        verticalKey: "private_equity",
        deal: { entityType: "pe_deal", entityId: dealId, state: graph.deal.status, version: graph.deal.version, graphVersion: graph.deal.graphVersion },
        work: { entityType: "work", entityId: workId },
        entities,
      };
      return { draft: { actionType, payload, summary: "", requiresConfirmation: false }, groundedPayload };
    }

    const workspace = await getIcWorkspace(ctx, { icCaseId: requiredString(payload, "icCaseId") });
    const process = workspace.case;
    if (process.dealId !== dealId) throw new ActionGroundingError("IC_ROOT_MISMATCH", "ICCase does not belong to the exact grounded Deal");
    groundedPayload.push({ field: "icCaseId", status: "verified" });
    entities.push({ entityType: "pe_ic_case", entityId: String(process.id), state: process.state, version: process.version });

    switch (actionType) {
      case "begin_ic_preparation":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["DRAFT"], actionType);
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" });
        break;
      case "create_ic_deck_draft": {
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE"], actionType);
        if (!process.primaryUnderwritingRunId) throw new ActionGroundingError("IC_UNDERWRITING_REQUIRED", "A sourced IC deck needs the Case's exact primary Underwriting Run");
        const template = await withTenant(ctx.auth.tenantId, async (db) => {
          const result = await db.execute<{ version_id: string; kind: string; status: string }>(sql`
            SELECT version_id::text,kind,status FROM finnor_os.artifact_templates
            WHERE tenant_id=${ctx.auth.tenantId}::uuid AND template_key=${String(payload.templateKey)}
            ORDER BY created_at DESC LIMIT 1
          `);
          return result.rows[0];
        });
        if (!template || template.status !== "active" || template.kind !== "pptx"
          || template.version_id !== payload.templateVersionId) {
          throw new ActionGroundingError("IC_DECK_TEMPLATE_NOT_GROUNDED", "The exact active PowerPoint template version must be registered in this tenant");
        }
        groundedPayload.push(
          { field: "expectedCaseVersion", status: "verified" },
          { field: "templateKey", status: "verified" },
          { field: "templateVersionId", status: "verified" },
        );
        entities.push({ entityType: "document_version", entityId: template.version_id, state: "active" });
        break;
      }
      case "create_ic_memo_draft":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"], actionType);
        if (!process.primaryUnderwritingRunId || !workspace.underwriting?.eligibleUnderPinnedPolicy) {
          throw new ActionGroundingError("IC_UNDERWRITING_REQUIRED", "A policy-eligible primary Underwriting Run must be pinned before drafting the memo");
        }
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" }, { field: "title", status: "verified" });
        entities.push({ entityType: "underwriting_run", entityId: String(process.primaryUnderwritingRunId), state: "eligible" });
        break;
      case "select_ic_memo_version":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE", "VOTING", "CONDITIONS_PENDING", "BLOCKED"], actionType);
        await groundIcMemoDocumentVersion(ctx, {
          icCaseId: String(process.id), documentId: requiredString(payload, "documentId"),
          documentVersionId: requiredString(payload, "documentVersionId"),
        });
        if (payload.underwritingRunId) await groundIcUnderwritingRun(ctx, { icCaseId: String(process.id), underwritingRunId: String(payload.underwritingRunId) });
        groundedPayload.push(
          { field: "expectedCaseVersion", status: "verified" },
          { field: "documentVersionId", status: "verified" },
          { field: "memoSelectionId", status: "verified" },
        );
        break;
      case "select_ic_underwriting_run":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["DRAFT", "PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE", "VOTING", "CONDITIONS_PENDING", "BLOCKED"], actionType);
        await groundIcUnderwritingRun(ctx, { icCaseId: String(process.id), underwritingRunId: requiredString(payload, "underwritingRunId") });
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" }, { field: "underwritingRunId", status: "verified" });
        break;
      case "create_ic_question":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"], actionType);
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" }, { field: "questionId", status: "verified" });
        break;
      case "attach_ic_question_evidence": {
        const question = workspace.questions.find((row) => row.id === payload.questionId);
        if (!question) throw new ActionGroundingError("IC_QUESTION_NOT_FOUND", "Question does not resolve inside the exact ICCase");
        icExpectedVersion(question, payload.expectedQuestionVersion, "IC Question");
        if (!["OPEN", "ANSWERED"].includes(String(question.state))) throw new ActionGroundingError("IC_INVALID_TRANSITION", "Only an open or answered Question can receive planner-attached evidence");
        const grounded = await groundIcSourceReference(ctx, { icCaseId: String(process.id), source: payload.source as IcSourceRef });
        groundedPayload.push({ field: "questionId", status: "verified" }, { field: "expectedQuestionVersion", status: "verified" }, { field: "source", status: "verified" });
        entities.push({ entityType: "pe_ic_question", entityId: String(question.id), state: question.state, version: question.version }, { entityType: grounded.sourceKind, entityId: grounded.sourceId });
        break;
      }
      case "request_ic_memo_review":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"], actionType);
        if (!workspace.memo) throw new ActionGroundingError("IC_MEMO_REQUIRED", "An exact P3 Memo DocumentVersion must be selected before review");
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" });
        break;
      case "prepare_ic_recommendation":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        icState(process, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"], actionType);
        if (process.currentMemoId !== payload.memoId || process.primaryUnderwritingRunId !== payload.underwritingRunId
          || !workspace.underwriting?.eligibleUnderPinnedPolicy) {
          throw new ActionGroundingError("IC_BASIS_MISMATCH", "Recommendation requires the exact current memo and eligible primary Underwriting Run");
        }
        if (workspace.memo?.sourceCompleteness !== "COMPLETE") {
          throw new ActionGroundingError("IC_MEMO_SOURCE_INCOMPLETE", "An incomplete or conflicting memo cannot support an autonomous diligence recommendation");
        }
        if (!graph.dealRisks.some((row) => row.archivedAt == null && ["open", "mitigating"].includes(String(row.state)) && ["high", "critical"].includes(String(row.severity)))
          && !graph.findings.some((row) => row.archivedAt == null && row.state === "open" && ["material", "critical"].includes(String(row.materiality)))) {
          throw new ActionGroundingError("IC_RECOMMENDATION_REQUIRES_JUDGMENT", "No unresolved material Deal risk or finding supports an automatic continue-diligence recommendation");
        }
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" }, { field: "memoId", status: "verified" }, { field: "underwritingRunId", status: "verified" });
        break;
      case "satisfy_ic_condition": {
        const condition = workspace.conditions.find((row) => row.id === payload.conditionId);
        if (!condition) throw new ActionGroundingError("IC_CONDITION_NOT_FOUND", "Condition does not resolve inside the exact ICCase");
        icExpectedVersion(condition, payload.expectedConditionVersion, "IC Condition");
        if (condition.state !== "ACTIVE") throw new ActionGroundingError("IC_INVALID_TRANSITION", "Only an ACTIVE IC Condition can be satisfied");
        const grounded = await groundIcSourceReference(ctx, { icCaseId: String(process.id), source: payload.source as IcSourceRef });
        groundedPayload.push({ field: "conditionId", status: "verified" }, { field: "expectedConditionVersion", status: "verified" }, { field: "source", status: "verified" });
        entities.push({ entityType: "pe_ic_condition", entityId: String(condition.id), state: condition.state, version: condition.version }, { entityType: grounded.sourceKind, entityId: grounded.sourceId });
        break;
      }
      case "prepare_ic_decision_proposal":
        icExpectedVersion(process, payload.expectedCaseVersion, "ICCase");
        if (Number(process.voteSetVersion) !== Number(payload.expectedVoteSetVersion)) {
          throw new ActionGroundingError("IC_STALE_PRECONDITION", "IC Vote set changed since it was inspected", { expectedVoteSetVersion: payload.expectedVoteSetVersion, actualVoteSetVersion: process.voteSetVersion });
        }
        icState(process, ["VOTING", "CONDITIONS_PENDING"], actionType);
        groundedPayload.push({ field: "expectedCaseVersion", status: "verified" }, { field: "expectedVoteSetVersion", status: "verified" }, { field: "decisionProposalId", status: "verified" });
        break;
      default:
        throw new ActionGroundingError("PE_UNHANDLED_ACTION", `No IC grounding contract exists for ${actionType}`);
    }
    payload.grounding = {
      verticalKey: "private_equity",
      deal: { entityType: "pe_deal", entityId: dealId, state: graph.deal.status, version: graph.deal.version, graphVersion: graph.deal.graphVersion },
      work: { entityType: "work", entityId: workId },
      icCase: { entityType: "pe_ic_case", entityId: process.id, state: process.state, version: process.version, voteSetVersion: process.voteSetVersion },
      entities,
    };
    return { draft: { actionType, payload, summary: "", requiresConfirmation: false }, groundedPayload };
  } catch (error) {
    if (error instanceof ActionGroundingError) throw error;
    if (error instanceof PeDomainError) throw new ActionGroundingError(error.code, error.message, record(error.details));
    throw error;
  }
}

function requiredEntityRefs(actionType: PrivateEquityActionType, payload: Payload): Array<ReturnType<typeof entityRef> & { states?: string[]; expectedVersion?: number }> {
  const ref = (field: string, entityType: PeEntityRef["entityType"], states?: string[], versionField?: string) => ({
    ...entityRef(field, entityType, requiredString(payload, field)),
    ...(states ? { states } : {}),
    ...(versionField ? { expectedVersion: Number(payload[versionField]) } : {}),
  });
  switch (actionType) {
    case "create_underwriting_run":
    case "open_ic_case":
    case "begin_ic_preparation":
    case "create_ic_deck_draft":
    case "create_ic_memo_draft":
    case "select_ic_memo_version":
    case "select_ic_underwriting_run":
    case "create_ic_question":
    case "attach_ic_question_evidence":
    case "request_ic_memo_review":
    case "prepare_ic_recommendation":
    case "satisfy_ic_condition":
    case "prepare_ic_decision_proposal":
      return [];
    case "open_workstream": return [];
    case "create_deal_request": return [ref("workstreamId", "pe_workstream", ["not_started", "active"]), ref("requestedFromDealPartyId", "pe_deal_party", ["active"])];
    case "submit_deliverable": return [ref("deliverableId", "pe_deliverable", ["expected", "rejected", "received"], "expectedVersion")];
    case "record_finding": return [
      ref("workstreamId", "pe_workstream", ["not_started", "active"]),
      ...(payload.relatedRequestId ? [ref("relatedRequestId", "pe_request")] : []),
      ...(payload.relatedDeliverableId ? [ref("relatedDeliverableId", "pe_deliverable")] : []),
    ];
    case "resolve_finding": return [ref("findingId", "pe_finding", ["open", "resolved"], "expectedVersion")];
    case "raise_deal_risk": return [
      ref("workstreamId", "pe_workstream", ["not_started", "active"]),
      ...((payload.originatingFindingIds as string[] | undefined) ?? []).map((id, index) => ({ ...entityRef(`originatingFindingIds[${index}]`, "pe_finding", id) })),
    ];
    case "resolve_deal_risk": return [ref("dealRiskId", "pe_deal_risk", ["open", "mitigating", "resolved"], "expectedVersion")];
    case "link_deal_dependency": {
      const blocker = record(payload.blocker);
      const blocked = record(payload.blocked);
      return [
        { ...entityRef("blocker.entityId", blocker.entityType as PeEntityRef["entityType"], String(blocker.entityId)) },
        { ...entityRef("blocked.entityId", blocked.entityType as PeEntityRef["entityType"], String(blocked.entityId)) },
      ];
    }
    case "mark_dependency_resolved": return [ref("dependencyId", "pe_dependency", undefined, "expectedVersion")];
    case "create_closing_condition": return [
      ref("workstreamId", "pe_workstream", ["not_started", "active"]),
      ...(payload.responsibleDealPartyId ? [ref("responsibleDealPartyId", "pe_deal_party", ["active"])] : []),
    ];
    case "submit_condition_evidence": return [ref("closingConditionId", "pe_closing_condition", ["open", "evidence_pending"])];
    case "satisfy_closing_condition": return [ref("closingConditionId", "pe_closing_condition", ["open", "evidence_pending", "satisfied"], "expectedVersion")];
    case "waive_closing_condition": return [ref("closingConditionId", "pe_closing_condition", ["open", "evidence_pending", "waived"], "expectedVersion")];
    case "verify_closing_item": return [ref("closingItemId", "pe_closing_item", ["ready", "verified"], "expectedVersion")];
    case "declare_deal_closed": return [{ ...entityRef("dealId", "pe_deal", requiredString(payload, "dealId")), states: ["active", "closed"], expectedVersion: Number(payload.expectedVersion) }];
  }
}

async function validateCoreRefs(tenantId: string, payload: Payload): Promise<string[]> {
  const failures: string[] = [];
  await withTenant(tenantId, async (db) => {
    if (typeof payload.documentId === "string") {
      const [row] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, payload.documentId))).limit(1);
      if (!row) failures.push("documentId");
    }
    if (typeof payload.evidenceSourceId === "string") {
      const [row] = await db.select({ id: evidenceSources.id }).from(evidenceSources).where(and(
        eq(evidenceSources.id, payload.evidenceSourceId),
        eq(evidenceSources.scope, "tenant"),
        eq(evidenceSources.tenantId, tenantId),
      )).limit(1);
      if (!row) failures.push("evidenceSourceId");
    }
    if (typeof payload.evidenceVersionId === "string") {
      const sourceId = typeof payload.evidenceSourceId === "string" ? payload.evidenceSourceId : randomUUID();
      const [row] = await db.select({ id: evidenceSourceVersions.id }).from(evidenceSourceVersions).where(and(
        eq(evidenceSourceVersions.id, payload.evidenceVersionId),
        eq(evidenceSourceVersions.sourceId, sourceId),
        eq(evidenceSourceVersions.scope, "tenant"),
        eq(evidenceSourceVersions.tenantId, tenantId),
      )).limit(1);
      if (!row) failures.push("evidenceVersionId");
    }
  });
  return failures;
}

async function validatePartyRef(tenantId: string, value: unknown, field: string, requesterEmployeeId?: string): Promise<void> {
  if (!value) return;
  const resolution = await resolveParty(tenantId, { ref: value as PartyRef }, { requesterEmployeeId });
  if (resolution.status !== "resolved") {
    throw new ActionGroundingError("PE_PARTY_NOT_RESOLVED", `${field} is missing, inactive, ambiguous, or outside this tenant`, { field, status: resolution.status });
  }
}

function decisionIdFor(actionType: PrivateEquityActionType, payload: Payload): string | null {
  if (actionType === "satisfy_closing_condition") return `pe:decision:closing-condition:${String(payload.closingConditionId)}`;
  if (actionType === "verify_closing_item") return `pe:decision:closing-item:${String(payload.closingItemId)}`;
  if (actionType === "declare_deal_closed") return `pe:decision:deal-close:${String(payload.dealId)}`;
  return null;
}

async function groundPrivateEquityAction(draft: DraftAction, action: DomainAction): Promise<DomainActionGrounding> {
  const actionType = action.actionType as PrivateEquityActionType;
  const payload: Payload = { ...draft.payload };
  const dealId = requiredString(payload, "dealId");
  const workId = action.workId;
  if (!workId) throw new ActionGroundingError("PE_WORK_REQUIRED", "A Private Equity mutation must belong to one durable Work item");
  const actorId = action.initiatedBy ?? "system:private-equity";
  const ctx: PeMutationContext = { auth: { tenantId: action.tenantId, userId: actorId, ...(action.initiatedBy ? { employeeId: action.initiatedBy } : {}), role: "owner" } };
  let graph: DealExecutionGraph;
  try {
    graph = await loadDealExecutionGraph(ctx, dealId);
  } catch (error) {
    if (error instanceof PeDomainError) throw new ActionGroundingError(error.code, error.message, record(error.details));
    throw error;
  }
  if (String(graph.deal.id) !== dealId) throw new ActionGroundingError("PE_DEAL_NOT_FOUND", "The exact Deal is not available in this tenant");
  if (!graph.workLinks.some((row) => String(row.workId) === workId)) {
    throw new ActionGroundingError("PE_WORK_DEAL_MISMATCH", "The durable Work item is not anchored to this exact Deal", { workId, dealId });
  }
  if (graph.deal.status !== "active" && !(actionType === "declare_deal_closed" && graph.deal.status === "closed")) {
    throw new ActionGroundingError("PE_DEAL_TERMINAL", "The exact Deal is no longer active", { dealId, state: graph.deal.status });
  }

  const createIdField = CREATE_ID_FIELD[actionType];
  if (createIdField) {
    if (typeof payload[createIdField] === "string" && payload[createIdField] !== action.id) {
      throw new ActionGroundingError(
        "PE_CREATE_ID_RESERVED",
        `${createIdField} is derived from the durable DomainAction identity and cannot be planner-selected`,
        { field: createIdField },
      );
    }
    payload[createIdField] = action.id;
  }
  payload.workId = workId;
  if (actionType === "create_underwriting_run") {
    // The durable DomainAction creation time is a stable world cutoff across
    // approval delays and retries; a planner cannot choose or advance it.
    if (!Number.isFinite(Date.parse(action.createdAt))) throw new ActionGroundingError("INVALID_PERIOD", "DomainAction has no valid creation time");
    payload.worldAt = new Date(action.createdAt).toISOString();
  }

  if (IC_PLANNER_ACTIONS.has(actionType)) {
    const grounded = await groundIcPlannerAction({ actionType, payload, ctx, dealId, workId, graph });
    return { ...grounded, draft: { ...draft, payload: grounded.draft.payload } };
  }

  if (actionType === "create_deal_request") {
    const requestId = String(payload.requestId);
    const requestText = String(payload.requestText).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    const equivalent = graph.requests.find((row) => (
      String(row.id) !== requestId
      && String(row.workstreamId) === String(payload.workstreamId)
      && String(row.requestedFromDealPartyId) === String(payload.requestedFromDealPartyId)
      && String(row.requestText).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === requestText
      && !["fulfilled", "cancelled"].includes(String(row.state))
    ));
    if (equivalent) {
      throw new ActionGroundingError(
        "PE_REQUEST_ALREADY_EXISTS",
        "An equivalent unresolved request already exists in this Deal workstream",
        { existingRequestId: String(equivalent.id), workstreamId: String(payload.workstreamId) },
      );
    }
  }

  const groundedPayload: DomainActionGrounding["groundedPayload"] = [
    { field: "dealId", status: "verified" },
    { field: "workId", status: "verified" },
  ];
  const snapshots: Array<{ entityType: string; entityId: string; state: unknown; version: unknown }> = [];
  for (const ref of requiredEntityRefs(actionType, payload)) {
    const row = currentRow(graph, ref.entityType, ref.entityId);
    if (!row) throw new ActionGroundingError("PE_ENTITY_NOT_FOUND", `${ref.field} does not resolve inside the exact Deal`, { field: ref.field, dealId });
    const state = row.state ?? row.status ?? (row.removedAt ? "removed" : "active");
    if (ref.states && !ref.states.includes(String(state))) {
      throw new ActionGroundingError("PE_INVALID_TRANSITION", `${ref.field} is in state ${String(state)}, which is not valid for ${actionType}`, { field: ref.field, state });
    }
    if (ref.expectedVersion !== undefined && Number(row.version) !== ref.expectedVersion) {
      throw new ActionGroundingError("PE_STALE_VERSION", `${ref.field} changed since it was inspected`, { field: ref.field, expectedVersion: ref.expectedVersion, actualVersion: row.version });
    }
    groundedPayload.push({ field: ref.field, status: "verified" });
    snapshots.push({ entityType: ref.entityType, entityId: ref.entityId, state, version: row.version ?? null });
  }
  if (createIdField) groundedPayload.push({ field: createIdField, status: "verified" });

  await validatePartyRef(action.tenantId, payload.owner, "owner", action.initiatedBy ?? undefined);
  if (payload.owner) groundedPayload.push({ field: "owner.partyId", status: "verified" });
  if (typeof payload.verifierEmployeeId === "string") {
    await validatePartyRef(action.tenantId, { partyType: "employee", partyId: payload.verifierEmployeeId }, "verifierEmployeeId", action.initiatedBy ?? undefined);
    groundedPayload.push({ field: "verifierEmployeeId", status: "verified" });
  }
  const invalidCoreRefs = await validateCoreRefs(action.tenantId, payload);
  if (invalidCoreRefs.length) throw new ActionGroundingError("PE_EVIDENCE_NOT_GROUNDED", "Evidence or Document references are not exact tenant-owned canonical records", { fields: invalidCoreRefs });
  for (const field of ["documentId", "evidenceSourceId", "evidenceVersionId"] as const) {
    if (payload[field]) groundedPayload.push({ field, status: "verified" });
  }

  const decisionId = decisionIdFor(actionType, payload);
  let decisionReadiness: { decisionId: string; ready: boolean; unresolvedPropositionIds: string[]; acquisitionOptions: unknown[] } | null = null;
  let durablePin: Awaited<ReturnType<typeof pinPrivateEquityDecisionReadiness>> | null = null;
  if (decisionId) {
    const eligibility = await evaluateDealCloseEligibility(ctx, dealId);
    const linkedAssertions = await loadPrivateEquityAssertions(ctx, dealId);
    const proposedAssertions = typeof payload.evidenceSourceId === "string"
      ? await loadPrivateEquityAssertionsForEvidence(
          ctx,
          dealId,
          payload.evidenceSourceId,
          payload.evidenceVersionId as string | undefined,
        )
      : [];
    const assertions = [...new Map([...linkedAssertions, ...proposedAssertions].map((row) => [`${row.propositionId}:${row.ref}`, row])).values()];
    const epistemic = buildPrivateEquityEpistemicSnapshot({
      tenantId: action.tenantId,
      principalId: actorId,
      dealId,
      graph,
      eligibility,
      assertions,
    });
    decisionReadiness = epistemic.decisions.find((row) => row.decisionId === decisionId) ?? null;
    // The P3 decision projection intentionally reserves "ready" for a canonical
    // post-mutation claim. P4's satisfaction action has a narrower precondition:
    // exact governed/durable evidence must freshly and unambiguously establish
    // evidence_sufficient=true. The PE2 transition then becomes canonical truth.
    if (actionType === "satisfy_closing_condition" && !decisionReadiness?.ready) {
      const propositionId = pePropositionId(dealId, "pe_closing_condition", String(payload.closingConditionId), "closing_condition.evidence_sufficient");
      const proposition = epistemic.state.propositions.find((row) => row.id === propositionId);
      const proposedRefs = new Set(proposedAssertions.map((row) => row.ref));
      const proposedEvidenceIds = new Set(epistemic.state.evidence
        .filter((row) => row.propositionId === propositionId && proposedRefs.has(row.provenance.sourceRef))
        .map((row) => row.id));
      const proposedEvidenceSelected = proposition?.evidenceRefs.some((ref) => proposedEvidenceIds.has(ref)) === true;
      const hasUnresolvedConflict = epistemic.state.conflicts.some((conflict) =>
        conflict.propositionId === propositionId && conflict.resolution === "UNRESOLVED");
      const evidenceReady = proposition?.status === "KNOWN"
        && proposition.value.kind === "DETERMINISTIC"
        && proposition.value.value === true
        && ["GOVERNED_OBSERVATION", "DURABLE_EVIDENCE", "CANONICAL_OWNER"].includes(String(proposition.sourceAuthority))
        && proposedEvidenceSelected
        && !hasUnresolvedConflict;
      if (evidenceReady && decisionReadiness) decisionReadiness = { ...decisionReadiness, ready: true, unresolvedPropositionIds: [], acquisitionOptions: [] };
    }
    if (!decisionReadiness?.ready) {
      throw new ActionGroundingError("PE_DECISION_NOT_READY", "Mandatory Private Equity DecisionRequirements are unresolved; acquire information, wait, or ask before mutating business truth", {
        decisionId,
        unresolvedPropositionIds: decisionReadiness?.unresolvedPropositionIds ?? [],
        acquisitionOptions: decisionReadiness?.acquisitionOptions ?? [],
      });
    }
    durablePin = await pinPrivateEquityDecisionReadiness({
      tenantId: action.tenantId,
      actionType,
      planRevisionId: action.planRevisionId,
      planNodeId: action.planNodeId,
      decisionId,
      requirements: epistemic.requirements,
    });
    if (!durablePin.allowed) {
      throw new ActionGroundingError("PE_EPISTEMIC_PIN_BLOCKED", "Durable epistemic requirements changed or are not ready for this exact PlanNode", {
        decisionId,
        graphVersionId: durablePin.graphVersionId ?? null,
        reasonCodes: durablePin.reasonCodes,
        propositionIds: epistemic.requirements.filter((row) => row.decisionId === decisionId).map((row) => row.propositionId).sort(),
      });
    }
  }

  payload.grounding = {
    verticalKey: "private_equity",
    deal: { entityType: "pe_deal", entityId: dealId, state: graph.deal.status, version: graph.deal.version, graphVersion: graph.deal.graphVersion },
    work: { entityType: "work", entityId: workId },
    entities: snapshots,
    ...(decisionReadiness ? { decisionReadiness } : {}),
    ...(durablePin ? { epistemicImpact: {
      mode: durablePin.mode,
      operational: durablePin.operational,
      graphVersionId: durablePin.graphVersionId ?? null,
      reasonCodes: durablePin.reasonCodes,
      pins: durablePin.pinned,
    } } : {}),
  };
  return { draft: { ...draft, payload }, groundedPayload };
}

function date(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

async function governanceProof(draft: DraftAction, tenantId: string, actorId: string): Promise<GovernanceProof> {
  if (!draft.domainActionId || !draft.businessEffect) {
    throw new PeDomainError("PE_GOVERNANCE_PROOF_MISSING", "The governed action is missing its exact authority or BusinessEffect identity");
  }
  const [approval, execution, receipt] = await withTenant(tenantId, async (db) => {
    const [approvedRequest] = await db.select({
      authorityDecisionId: authorityApprovalRequests.authorityDecisionId,
      capability: authorityDecisions.capability,
      businessEffectId: authorityApprovalRequests.businessEffectId,
      businessEffectHash: authorityApprovalRequests.businessEffectHash,
    }).from(authorityApprovalRequests).innerJoin(
      authorityDecisions,
      and(
        eq(authorityDecisions.id, authorityApprovalRequests.authorityDecisionId),
        eq(authorityDecisions.tenantId, authorityApprovalRequests.tenantId),
      ),
    ).where(and(
      eq(authorityApprovalRequests.tenantId, tenantId),
      eq(authorityApprovalRequests.domainActionId, draft.domainActionId!),
      eq(authorityApprovalRequests.status, "approved"),
      eq(authorityApprovalRequests.businessEffectId, draft.businessEffect!.id),
      eq(authorityApprovalRequests.businessEffectHash, draft.businessEffect!.semanticHash),
      eq(authorityDecisions.domainActionId, draft.domainActionId!),
      eq(authorityDecisions.capability, `action:${draft.actionType}`),
      eq(authorityDecisions.businessEffectId, draft.businessEffect!.id),
      eq(authorityDecisions.businessEffectHash, draft.businessEffect!.semanticHash),
    )).limit(1);
    const [allowedExecution] = await db.select({ id: authorityDecisions.id }).from(authorityDecisions).where(and(
      eq(authorityDecisions.tenantId, tenantId),
      eq(authorityDecisions.domainActionId, draft.domainActionId!),
      eq(authorityDecisions.employeeId, actorId),
      eq(authorityDecisions.operation, "execution"),
      eq(authorityDecisions.capability, `action:${draft.actionType}`),
      eq(authorityDecisions.outcome, "allowed"),
      eq(authorityDecisions.businessEffectId, draft.businessEffect!.id),
      eq(authorityDecisions.businessEffectHash, draft.businessEffect!.semanticHash),
    )).orderBy(desc(authorityDecisions.createdAt), desc(authorityDecisions.id)).limit(1);
    const [decisionReceipt] = await db.select({ id: decisionReceipts.id }).from(decisionReceipts).where(and(
      eq(decisionReceipts.tenantId, tenantId),
      eq(decisionReceipts.domainActionId, draft.domainActionId!),
      eq(decisionReceipts.businessEffectId, draft.businessEffect!.id),
      eq(decisionReceipts.authorizedEffectHash, draft.businessEffect!.semanticHash),
    )).orderBy(desc(decisionReceipts.createdAt)).limit(1);
    return [approvedRequest, allowedExecution, decisionReceipt] as const;
  });
  if (!approval) throw new PeDomainError("PE_APPROVAL_PROOF_MISSING", "The exact approved authority request is not available at execution");
  if (!execution) throw new PeDomainError("PE_EXECUTION_AUTHORITY_MISSING", "The exact allowed execution authority decision is not available");
  if (!receipt) throw new PeDomainError("PE_DECISION_RECEIPT_MISSING", "The exact authorized DecisionReceipt is not available at execution");
  // Closing owners require the approval_required decision that owns the human
  // approval. The IC opening owner requires the allowed execution decision.
  // Both exact proofs above remain mandatory before either reference is passed.
  const approvalOwned = draft.actionType === "waive_closing_condition" || draft.actionType === "declare_deal_closed";
  return { authorityDecisionId: approvalOwned ? approval.authorityDecisionId : execution.id, decisionReceiptId: receipt.id };
}

function existingCreateResult(graph: DealExecutionGraph, actionType: PrivateEquityActionType, payload: Payload): PeMutationResult | null {
  const field = CREATE_ID_FIELD[actionType];
  const contract = CONTRACT_BY_ACTION.get(actionType);
  if (!field || !contract || contract.resultEntityType === "underwriting_run" || typeof payload[field] !== "string") return null;
  const row = currentRow(graph, contract.resultEntityType, payload[field] as string);
  return row ? { row, changed: false, idempotent: true } : null;
}

async function executeMutation(actionType: PrivateEquityActionType, payload: Payload, ctx: PeMutationContext, draft: DraftAction): Promise<PeMutationResult> {
  const graph = await loadDealExecutionGraph(ctx, String(payload.dealId));
  const existing = existingCreateResult(graph, actionType, payload);
  if (existing) return existing;
  switch (actionType) {
    case "create_underwriting_run": {
      const scenario = payload.scenario as { name: string; overrides: UnderwritingScenario["overrides"] } | undefined;
      const createdScenario = scenario ? await createUnderwritingScenario(ctx, {
        investmentCaseId: String(payload.investmentCaseId), modelVersionId: String(payload.modelVersionId),
        scenario: { schemaVersion: "underwriting-scenario.v1", name: scenario.name, overrides: scenario.overrides },
      }) : null;
      const scenarioId = createdScenario ? String(createdScenario.id) : payload.scenarioId as string | undefined;
      const persisted = await createUnderwritingRun(ctx, {
        investmentCaseId: String(payload.investmentCaseId), modelVersionId: String(payload.modelVersionId),
        worldAt: String(payload.worldAt), idempotencyKey: String(draft.domainActionId),
        scenarioId, baseRunId: payload.baseRunId as string | undefined,
        workId: String(payload.workId),
      });
      const observed = await getUnderwritingRun(ctx, persisted.id);
      if (observed.workId !== payload.workId || observed.investmentCaseId !== payload.investmentCaseId
          || observed.modelVersionId !== payload.modelVersionId || (scenarioId && observed.scenarioId !== scenarioId)) {
        throw new PeDomainError("PE_RUN_READBACK_MISMATCH", "Persisted Underwriting Run does not match the exact Work and model scope");
      }
      return {
        row: {
          id: observed.id, investmentCaseId: observed.investmentCaseId, modelVersionId: observed.modelVersionId,
          scenarioId: observed.scenarioId, workId: observed.workId, worldAt: observed.worldAt,
          status: observed.status, validity: observed.validity, inputHash: observed.inputHash,
          resultHash: observed.resultHash, computedAt: observed.computedAt,
        },
        changed: !persisted.replayed, idempotent: persisted.replayed,
      };
    }
    case "open_ic_case": return createIcCase(ctx, {
      id: typeof payload.icCaseId === "string" ? payload.icCaseId : undefined,
      dealId: String(payload.dealId), investmentCaseId: String(payload.investmentCaseId),
      committeeConfigVersionId: String(payload.committeeConfigVersionId),
      scheduledInternalEventId: payload.scheduledInternalEventId as string | undefined,
      primaryUnderwritingRunId: payload.primaryUnderwritingRunId as string | undefined,
      reconsidersDecisionId: payload.reconsidersDecisionId as string | undefined,
      workId: String(payload.workId), idempotencyKey: String(draft.domainActionId), governance: await governanceProof(draft, ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId),
    });
    case "begin_ic_preparation": return beginIcPreparation(ctx, {
      icCaseId: String(payload.icCaseId), expectedVersion: Number(payload.expectedCaseVersion),
    });
    case "create_ic_deck_draft": {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(ctx.auth.userId)) {
        throw new PeDomainError("PE_ACTOR_REQUIRED", "An authenticated actor is required to create the IC deck draft");
      }
      const workspace = await getIcWorkspace(ctx, { icCaseId: String(payload.icCaseId) });
      icExpectedVersion(workspace.case, payload.expectedCaseVersion, "ICCase");
      icState(workspace.case, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE"], actionType);
      if (workspace.case.dealId !== payload.dealId) throw new PeDomainError("IC_ROOT_MISMATCH", "ICCase and Deal must match");
      const run = await getUnderwritingRun(ctx, String(workspace.case.primaryUnderwritingRunId ?? ""));
      if (run.status !== "SUCCEEDED" || run.validity !== "VALID" || run.investmentCaseId !== workspace.case.investmentCaseId) {
        throw new PeDomainError("IC_DECK_RUN_MISMATCH", "The IC deck requires its Case's exact valid primary Underwriting Run");
      }
      const actor = { tenantId: ctx.auth.tenantId, userId: ctx.auth.userId, role: "owner" as const };
      const created = await instantiateArtifactTemplate(actor, {
        templateKey: String(payload.templateKey),
        templateVersionId: String(payload.templateVersionId),
        title: String(payload.title),
        idempotencyKey: String(draft.domainActionId),
        fields: sourcedDeckFields({ workspace, run, graph }),
      });
      const observed = await getArtifact(actor, created.documentId, created.version.id);
      if (observed.ir.kind !== "pptx" || observed.document.external_id !== draft.domainActionId
        || observed.version.source_ref !== payload.templateVersionId) {
        throw new PeDomainError("IC_DECK_READBACK_MISMATCH", "The persisted draft does not match the authorized template version and action");
      }
      const link = await attachCanonicalDocument(ctx, {
        dealId: String(payload.dealId),
        entity: { entityType: "pe_ic_case", entityId: String(payload.icCaseId) },
        documentId: created.documentId,
        linkRole: "source",
      });
      if (String(link.row.documentId) !== created.documentId || String(link.row.dealId) !== payload.dealId) {
        throw new PeDomainError("IC_DECK_LINK_READBACK_MISMATCH", "The canonical Deal link does not point to the draft");
      }
      await attachWorkToDealGraph(ctx, {
        dealId: String(payload.dealId),
        workId: String(payload.workId),
        entities: [{ entityType: "pe_ic_case", entityId: String(payload.icCaseId), relationship: "target" }],
      });
      return {
        row: {
          ...link.row,
          documentVersionId: created.version.id,
          templateVersionId: String(payload.templateVersionId),
          templateKey: String(payload.templateKey),
          draftKind: "IC_DECK_DRAFT",
          sourceUnderwritingRunId: String(run.id),
          sourceMemoId: workspace.case.currentMemoId ?? null,
          sourceRecommendationId: workspace.case.currentRecommendationId ?? null,
          sourceCutoffAt: workspace.asOf,
        },
        changed: !created.replayed || link.changed,
        idempotent: created.replayed && link.idempotent,
      };
    }
    case "create_ic_memo_draft": {
      if (!/^[0-9a-f-]{36}$/i.test(ctx.auth.userId)) {
        throw new PeDomainError("PE_ACTOR_REQUIRED", "An authenticated actor is required to create the IC memo draft");
      }
      const workspace = await getIcWorkspace(ctx, { icCaseId: String(payload.icCaseId) });
      icExpectedVersion(workspace.case, payload.expectedCaseVersion, "ICCase");
      icState(workspace.case, ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"], actionType);
      const runId = String(workspace.case.primaryUnderwritingRunId ?? "");
      if (workspace.case.dealId !== payload.dealId || !runId || !workspace.underwriting?.eligibleUnderPinnedPolicy) {
        throw new PeDomainError("IC_UNDERWRITING_REQUIRED", "The exact IC Case requires a policy-eligible pinned Underwriting Run");
      }
      const run = await getUnderwritingRun(ctx, runId);
      if (run.status !== "SUCCEEDED" || run.validity !== "VALID" || run.workId !== payload.workId
        || run.investmentCaseId !== workspace.case.investmentCaseId) {
        throw new PeDomainError("IC_MEMO_RUN_MISMATCH", "Memo source must be the valid Run created by this Work for the exact Investment Case");
      }
      const actor = { tenantId: ctx.auth.tenantId, userId: ctx.auth.userId, role: "owner" as const };
      const created = await createGroundedMemoArtifact(actor, {
        actionId: String(draft.domainActionId), title: String(payload.title),
        sections: sourcedMemoSections({ caseId: String(payload.icCaseId), run, graph }),
      });
      const observed = await getArtifact(actor, created.documentId, created.version.id);
      if (observed.ir.kind !== "docx" || observed.document.external_id !== draft.domainActionId
        || observed.version.source_ref !== draft.domainActionId || observed.ir.semanticHash !== created.ir.semanticHash) {
        throw new PeDomainError("IC_MEMO_READBACK_MISMATCH", "The persisted source-backed memo does not match the governed action");
      }
      const link = await attachCanonicalDocument(ctx, {
        dealId: String(payload.dealId), entity: { entityType: "pe_ic_case", entityId: String(payload.icCaseId) },
        documentId: created.documentId, linkRole: "source",
      });
      if (String(link.row.documentId) !== created.documentId || String(link.row.dealId) !== payload.dealId) {
        throw new PeDomainError("IC_MEMO_LINK_READBACK_MISMATCH", "The canonical Deal link does not point to the memo draft");
      }
      await attachWorkToDealGraph(ctx, {
        dealId: String(payload.dealId), workId: String(payload.workId),
        entities: [{ entityType: "pe_ic_case", entityId: String(payload.icCaseId), relationship: "target" }],
      });
      return {
        row: { ...link.row, documentVersionId: created.version.id, sourceCompleteness: "COMPLETE", draftKind: "IC_MEMO_DRAFT" },
        changed: !created.replayed || link.changed,
        idempotent: created.replayed && link.idempotent,
      };
    }
    case "select_ic_memo_version": {
      const result = await selectIcMemoVersion(ctx, {
        id: String(payload.memoSelectionId), icCaseId: String(payload.icCaseId), expectedCaseVersion: Number(payload.expectedCaseVersion),
        artifactRole: payload.artifactRole as "MEMO" | "DECK", documentId: String(payload.documentId),
        documentVersionId: String(payload.documentVersionId), underwritingRunId: payload.underwritingRunId as string | undefined,
        evidenceCutoffAt: String(payload.evidenceCutoffAt), sourceCompleteness: payload.sourceCompleteness as never,
        changeClassification: payload.changeClassification as never, idempotencyKey: String(draft.domainActionId),
      });
      return { row: result.memo, changed: !result.idempotent, idempotent: result.idempotent };
    }
    case "select_ic_underwriting_run": return selectPrimaryIcUnderwritingRun(ctx, {
      icCaseId: String(payload.icCaseId), expectedCaseVersion: Number(payload.expectedCaseVersion),
      underwritingRunId: String(payload.underwritingRunId),
    });
    case "create_ic_question": {
      const result = await createIcQuestion(ctx, {
        id: String(payload.questionId), icCaseId: String(payload.icCaseId), expectedCaseVersion: Number(payload.expectedCaseVersion),
        question: String(payload.question), priority: payload.priority as never,
        requiredBeforeVote: payload.requiredBeforeVote as boolean | undefined,
        requiredBeforeDecision: payload.requiredBeforeDecision as boolean | undefined,
        workId: String(payload.workId), idempotencyKey: String(draft.domainActionId),
      });
      return { row: result.question, changed: !result.idempotent, idempotent: result.idempotent };
    }
    case "attach_ic_question_evidence": {
      const result = await attachIcQuestionSource(ctx, {
        icCaseId: String(payload.icCaseId), questionId: String(payload.questionId),
        expectedQuestionVersion: Number(payload.expectedQuestionVersion),
        link: {
          source: payload.source as IcSourceRef,
          relationship: payload.relationship as never,
          truthStatus: payload.truthStatus as never,
          idempotencyKey: String(draft.domainActionId),
        },
      });
      return { row: result.question, changed: !result.idempotent, idempotent: result.idempotent };
    }
    case "request_ic_memo_review": return markIcReadyForReview(ctx, {
      icCaseId: String(payload.icCaseId), expectedVersion: Number(payload.expectedCaseVersion),
    });
    case "prepare_ic_recommendation": {
      const workspace = await getIcWorkspace(ctx, { icCaseId: String(payload.icCaseId) });
      icExpectedVersion(workspace.case, payload.expectedCaseVersion, "ICCase");
      if (workspace.case.dealId !== payload.dealId || workspace.case.currentMemoId !== payload.memoId
        || workspace.case.primaryUnderwritingRunId !== payload.underwritingRunId
        || workspace.memo?.sourceCompleteness !== "COMPLETE" || !workspace.underwriting?.eligibleUnderPinnedPolicy) {
        throw new PeDomainError("IC_BASIS_MISMATCH", "Recommendation basis changed after grounding");
      }
      const materialRisks = graph.dealRisks.filter((row) => row.archivedAt == null && ["open", "mitigating"].includes(String(row.state))
        && ["high", "critical"].includes(String(row.severity)));
      const materialFindings = graph.findings.filter((row) => row.archivedAt == null && row.state === "open"
        && ["material", "critical"].includes(String(row.materiality)));
      if (materialRisks.length + materialFindings.length === 0 || materialRisks.length + materialFindings.length > 80) {
        throw new PeDomainError("IC_RECOMMENDATION_REQUIRES_JUDGMENT", "The current Deal graph cannot support a bounded automatic continue-diligence recommendation");
      }
      const sources: IcSourceLinkInput[] = [
        { source: { kind: "UNDERWRITING_RUN", underwritingRunId: String(payload.underwritingRunId) }, relationship: "REFERENCES", idempotencyKey: `${draft.domainActionId}:run` },
        ...materialRisks.map((row) => ({ source: { kind: "PE_RISK" as const, riskId: String(row.id) }, relationship: "REQUIRES" as const, idempotencyKey: `${draft.domainActionId}:risk:${String(row.id)}` })),
        ...materialFindings.map((row) => ({ source: { kind: "P1_WORLD" as const, entityType: "pe_finding" as const, entityId: String(row.id) }, relationship: "REQUIRES" as const, idempotencyKey: `${draft.domainActionId}:finding:${String(row.id)}` })),
      ];
      const unresolvedItems = [...materialRisks, ...materialFindings].map((row) => String(row.title ?? "Untitled recorded item")).join("; ");
      const rationale = `Continue diligence before an investment decision. The selected sourced memo and valid underwriting run record ${materialRisks.length} unresolved high or critical risk(s) and ${materialFindings.length} unresolved material or critical finding(s): ${unresolvedItems}. Committee review is required. The exact memo, run, and item references are attached to this recommendation.`;
      const result = await createIcRecommendation(ctx, {
        icCaseId: String(payload.icCaseId), expectedCaseVersion: Number(payload.expectedCaseVersion),
        outcome: "CONTINUE_DILIGENCE", rationale, memoId: String(payload.memoId),
        underwritingRunId: String(payload.underwritingRunId), sources,
        idempotencyKey: String(draft.domainActionId),
      });
      return { row: result.recommendation, changed: !result.idempotent, idempotent: result.idempotent };
    }
    case "satisfy_ic_condition": {
      const result = await satisfyIcCondition(ctx, {
        icCaseId: String(payload.icCaseId), conditionId: String(payload.conditionId),
        expectedConditionVersion: Number(payload.expectedConditionVersion),
        verification: { source: payload.source as IcSourceRef, relationship: "VERIFIES", idempotencyKey: String(draft.domainActionId) },
      });
      return { row: result.condition, changed: !result.idempotent, idempotent: result.idempotent };
    }
    case "prepare_ic_decision_proposal": {
      const result = await prepareIcDecisionProposal(ctx, {
        id: String(payload.decisionProposalId), icCaseId: String(payload.icCaseId),
        expectedCaseVersion: Number(payload.expectedCaseVersion), expectedVoteSetVersion: Number(payload.expectedVoteSetVersion),
        idempotencyKey: String(draft.domainActionId),
      });
      return { row: result.proposal, changed: !result.idempotent, idempotent: result.idempotent };
    }
    case "open_workstream": return createWorkstream(ctx, {
      id: String(payload.workstreamId), dealId: String(payload.dealId), kind: payload.kind as never,
      name: String(payload.name), owner: payload.owner as never,
    });
    case "create_deal_request": return createRequest(ctx, {
      id: String(payload.requestId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId),
      requestedFromDealPartyId: String(payload.requestedFromDealPartyId), owner: payload.owner as never,
      requestText: String(payload.requestText), requestedAt: date(payload.requestedAt), dueAt: date(payload.dueAt),
      requiresAcceptedDeliverable: payload.requiresAcceptedDeliverable as boolean | undefined,
    });
    case "submit_deliverable": return receiveDeliverable(ctx, {
      dealId: String(payload.dealId), deliverableId: String(payload.deliverableId), expectedVersion: Number(payload.expectedVersion),
      documentId: payload.documentId as string | undefined, supersedesLinkId: payload.supersedesLinkId as string | undefined,
    });
    case "record_finding": return createFinding(ctx, {
      id: String(payload.findingId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId),
      relatedRequestId: payload.relatedRequestId as string | undefined, relatedDeliverableId: payload.relatedDeliverableId as string | undefined,
      statement: String(payload.statement), severity: payload.severity as never, materiality: payload.materiality as never,
      owner: payload.owner as never, requiredForWorkstreamCompletion: payload.requiredForWorkstreamCompletion as boolean | undefined,
    });
    case "resolve_finding": return resolveFinding(ctx, { findingId: String(payload.findingId), expectedVersion: Number(payload.expectedVersion), disposition: String(payload.disposition) });
    case "raise_deal_risk": return createDealRisk(ctx, {
      id: String(payload.dealRiskId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId), statement: String(payload.statement),
      severity: payload.severity as never, owner: payload.owner as never, response: payload.response as string | undefined,
      requiredForWorkstreamCompletion: payload.requiredForWorkstreamCompletion as boolean | undefined,
      originatingFindingIds: payload.originatingFindingIds as string[] | undefined,
    });
    case "resolve_deal_risk": return resolveDealRisk(ctx, { dealRiskId: String(payload.dealRiskId), expectedVersion: Number(payload.expectedVersion), response: String(payload.response) });
    case "link_deal_dependency": return createDependency(ctx, {
      id: String(payload.dependencyId), dealId: String(payload.dealId), blocker: payload.blocker as never, blocked: payload.blocked as never,
    });
    case "mark_dependency_resolved": return removeDependency(ctx, { dependencyId: String(payload.dependencyId), expectedVersion: Number(payload.expectedVersion), reason: String(payload.reason) });
    case "create_closing_condition": return createClosingCondition(ctx, {
      id: String(payload.closingConditionId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId), conditionText: String(payload.conditionText),
      category: String(payload.category), requiredForClose: payload.requiredForClose as boolean | undefined, evidenceRequired: payload.evidenceRequired as boolean | undefined,
      waiverRequiresApproval: payload.waiverRequiresApproval as boolean | undefined, owner: payload.owner as never,
      responsibleDealPartyId: payload.responsibleDealPartyId as string | undefined, dueAt: date(payload.dueAt),
    });
    case "submit_condition_evidence": return attachCanonicalEvidence(ctx, {
      dealId: String(payload.dealId), entity: { entityType: "pe_closing_condition", entityId: String(payload.closingConditionId) },
      evidenceSourceId: String(payload.evidenceSourceId), evidenceVersionId: payload.evidenceVersionId as string | undefined,
      relationship: payload.relationship as "supports" | "verifies" | "authorizes",
    });
    case "satisfy_closing_condition": return satisfyClosingCondition(ctx, {
      dealId: String(payload.dealId), closingConditionId: String(payload.closingConditionId), expectedVersion: Number(payload.expectedVersion),
      documentId: payload.documentId as string | undefined, evidenceSourceId: payload.evidenceSourceId as string | undefined,
      evidenceVersionId: payload.evidenceVersionId as string | undefined,
    });
    case "waive_closing_condition": return waiveClosingCondition(ctx, {
      closingConditionId: String(payload.closingConditionId), expectedVersion: Number(payload.expectedVersion), reason: String(payload.reason),
      governance: await governanceProof(draft, ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId),
    });
    case "verify_closing_item": return verifyClosingItem(ctx, {
      dealId: String(payload.dealId), closingItemId: String(payload.closingItemId), expectedVersion: Number(payload.expectedVersion),
      verifierEmployeeId: payload.verifierEmployeeId as string | undefined, verificationSource: payload.verificationSource as string | undefined,
      documentId: payload.documentId as string | undefined, evidenceSourceId: payload.evidenceSourceId as string | undefined,
      evidenceVersionId: payload.evidenceVersionId as string | undefined,
    });
    case "declare_deal_closed": return declareDealClosed(ctx, {
      dealId: String(payload.dealId), expectedVersion: Number(payload.expectedVersion), expectedGraphVersion: Number(payload.expectedGraphVersion),
      governance: await governanceProof(draft, ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId),
    });
  }
}

function summary(actionType: PrivateEquityActionType, payload: Payload): string {
  const target = payload.decisionProposalId ?? payload.conditionId ?? payload.questionId ?? payload.memoSelectionId ?? payload.icCaseId
    ?? payload.closingConditionId ?? payload.closingItemId ?? payload.findingId ?? payload.dealRiskId
    ?? payload.dependencyId ?? payload.requestId ?? payload.workstreamId ?? payload.dealId;
  return `${actionType.replaceAll("_", " ")} on exact canonical target ${String(target)} in Deal ${String(payload.dealId)}.`;
}

export const privateEquityPlugin: DomainEnginePlugin = {
  name: "private-equity",
  // Kept literal at the registration seam so the static release registry can
  // independently discover the executable surface. A contract test proves this
  // list is exactly the schema-key set, preventing registration/schema drift.
  actionTypes: [
    "create_underwriting_run",
    "open_ic_case",
    "begin_ic_preparation",
    "create_ic_deck_draft",
    "create_ic_memo_draft",
    "select_ic_memo_version",
    "select_ic_underwriting_run",
    "create_ic_question",
    "attach_ic_question_evidence",
    "request_ic_memo_review",
    "prepare_ic_recommendation",
    "satisfy_ic_condition",
    "prepare_ic_decision_proposal",
    "open_workstream",
    "create_deal_request",
    "submit_deliverable",
    "record_finding",
    "resolve_finding",
    "raise_deal_risk",
    "resolve_deal_risk",
    "link_deal_dependency",
    "mark_dependency_resolved",
    "create_closing_condition",
    "submit_condition_evidence",
    "satisfy_closing_condition",
    "waive_closing_condition",
    "verify_closing_item",
    "declare_deal_closed",
  ],
  payloadSchemas: PRIVATE_EQUITY_ACTION_SCHEMAS,
  canHandle(actionType) {
    return PRIVATE_EQUITY_ACTION_TYPES.includes(actionType as PrivateEquityActionType);
  },
  validate(actionType, payload): ValidationResult {
    const schema = PRIVATE_EQUITY_ACTION_SCHEMAS[actionType as PrivateEquityActionType];
    if (!schema) return { valid: false, errors: [`unhandled action ${actionType}`] };
    const parsed = schema.safeParse(payload);
    return parsed.success ? { valid: true, errors: [] } : {
      valid: false,
      errors: parsed.error.issues.map((issue) => `payload.${issue.path.join(".")}: ${issue.message}`),
    };
  },
  draft(actionType, payload, policy: DomainPolicy): DraftAction {
    const typed = actionType as PrivateEquityActionType;
    const parsed = PRIVATE_EQUITY_ACTION_SCHEMAS[typed].parse(payload) as Payload;
    return {
      actionType,
      payload: parsed,
      summary: summary(typed, parsed),
      // Core hardening supplies irreversible floors for waiver and close; the
      // plugin may request more confirmation but can never lower that floor.
      requiresConfirmation: policy.requiresConfirmation,
    };
  },
  ground(draft, action) {
    return groundPrivateEquityAction(draft, action).catch((error) => {
      recordIcMetric({
        tenantId: action.tenantId,
        actorId: action.initiatedBy ?? undefined,
        icCaseId: typeof draft.payload.icCaseId === "string" ? draft.payload.icCaseId : undefined,
        operation: action.actionType,
        result: "failure",
      }, "pe_action_grounding_failures");
      throw error;
    });
  },
  simulate(actionType, payload) {
    const parsed = PRIVATE_EQUITY_ACTION_SCHEMAS[actionType as PrivateEquityActionType].parse(payload) as Payload;
    return {
      mode: "schema",
      summary: `${actionType.replaceAll("_", " ")} is schema-valid; exact Deal/Work/entity versions, evidence readiness, authority, and close eligibility remain execution-time facts.`,
      predicted: { actionType, fields: Object.keys(parsed).sort(), fieldChanges: [] },
    };
  },
  async execute(draft: DraftAction, tools: ToolRegistry): Promise<ExecutionResult> {
    const runtime = tools.runtimeContext();
    if (!runtime?.tenantId || !runtime.domainActionId) {
      return { status: "failure", output: {}, error: "Private Equity execution requires the trusted scoped runtime", errorKind: "validation" };
    }
    const actionType = draft.actionType as PrivateEquityActionType;
    const contract = CONTRACT_BY_ACTION.get(actionType);
    if (!contract) return { status: "failure", output: {}, error: `No PE action contract for ${draft.actionType}`, errorKind: "terminal" };
    const ctx: PeMutationContext = {
      auth: {
        tenantId: runtime.tenantId,
        userId: runtime.actorId ?? "system:private-equity",
        ...(runtime.actorId && /^[0-9a-f-]{36}$/i.test(runtime.actorId) ? { employeeId: runtime.actorId } : {}),
        role: "owner",
      },
      provenance: { sourceSystem: "@finnor/plugin-private-equity", externalId: runtime.domainActionId, createdBy: runtime.actorId ?? "system:private-equity" },
    };
    let mutationObserved = false;
    try {
      const result = await executeMutation(actionType, draft.payload, ctx, draft);
      mutationObserved = true;
      const entityId = String(result.row.id);
      const workId = String(draft.payload.workId);
      // Closing atomically makes the Deal graph immutable.  Its Work->Deal anchor
      // was required during grounding, so trying to add another link after close
      // would turn a successful close into a false plugin failure.
      // P5 registers memo/recommendation/proposal as canonical history, but
      // explicitly marks them non-attachable to the Deal Work graph. Their IC
      // Case is the durable Work target. Trying to attach a child result after
      // its repository mutation succeeds makes the action falsely fail.
      const icCaseChildResult = ["pe_ic_memo", "pe_ic_recommendation", "pe_ic_decision_proposal"].includes(contract.resultEntityType);
      if (actionType !== "declare_deal_closed" && actionType !== "create_ic_deck_draft" && actionType !== "create_ic_memo_draft"
        && !icCaseChildResult && contract.resultEntityType !== "underwriting_run") {
        await attachWorkToDealGraph(ctx, {
          dealId: String(draft.payload.dealId),
          workId,
          entities: [{ entityType: contract.resultEntityType, entityId, relationship: "result" }],
        });
      }
      if (result.idempotent) {
        recordIcMetric({
          tenantId: runtime.tenantId,
          actorId: runtime.actorId,
          icCaseId: typeof draft.payload.icCaseId === "string" ? draft.payload.icCaseId : undefined,
          operation: actionType,
          entityId,
          result: "recovered",
        }, "pe_action_recovery_attempts");
      }
      return {
        status: "success",
        output: {
          actionType,
          canonicalMutationOwner: contract.canonicalMutationOwner,
          idempotencyIdentity: runtime.domainActionId,
          entity: { entityType: contract.resultEntityType, entityId },
          canonicalState: result.row,
          changed: result.changed,
          idempotent: result.idempotent,
          canonicalObserved: true,
          verified: true,
          workAttachment: actionType === "declare_deal_closed" ? "preexisting_deal_anchor"
            : actionType === "create_underwriting_run" ? "underwriting_run_work_id"
              : actionType === "create_ic_deck_draft" || actionType === "create_ic_memo_draft" || icCaseChildResult
                ? "ic_case_target_linked" : "result_linked",
        },
        expected: { canonicalObserved: true, entityType: contract.resultEntityType, entityId },
      };
    } catch (error) {
      const code = error instanceof PeDomainError ? error.code : "PE_EXECUTION_FAILED";
      const message = error instanceof Error ? error.message : "Private Equity mutation failed";
      const metricContext = {
        tenantId: runtime.tenantId,
        actorId: runtime.actorId,
        icCaseId: typeof draft.payload.icCaseId === "string" ? draft.payload.icCaseId : undefined,
        operation: actionType,
        result: "failure" as const,
      };
      if (["PE_GOVERNANCE_PROOF_MISSING", "PE_APPROVAL_PROOF_MISSING", "PE_DECISION_RECEIPT_MISSING"].includes(code)) {
        recordIcMetric(metricContext, "pe_action_authority_failures");
      }
      if (mutationObserved) {
        recordIcMetric(metricContext, "pe_action_verification_failures");
        recordIcMetric({ ...metricContext, result: "recovered" }, "pe_action_recovery_attempts");
      }
      const conflict = code === "PE_STALE_VERSION" || code === "IC_STALE_PRECONDITION" || code === "IC_STALE_PROPOSAL"
        || code === "PE_DEAL_NOT_CLOSE_ELIGIBLE" || code === "PE_INVALID_TRANSITION" || code === "IC_INVALID_TRANSITION";
      return { status: "failure", output: { actionType, code }, error: message, errorKind: conflict ? "conflict" : "terminal" };
    }
  },
};

export default privateEquityPlugin;
