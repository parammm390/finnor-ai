import {
  COMPANY_BRAIN_RELATIONSHIP_KINDS,
  type CompanyBrainEdge,
  type CompanyBrainObjectRef,
  type CompanyBrainQualifiedType,
  type CompanyBrainRelationshipKind,
  type CompanyBrainRelationshipRegistration,
  type CompanyBrainSourceRef,
} from "./company-brain-types";

const q = (value: string): CompanyBrainQualifiedType => value as CompanyBrainQualifiedType;

const DEAL_CHILD_TYPES = [
  "private_equity:pe_deal_party", "private_equity:pe_workstream", "private_equity:pe_request",
  "private_equity:pe_deliverable", "private_equity:pe_finding", "private_equity:pe_deal_risk",
  "private_equity:pe_dependency", "private_equity:pe_milestone", "private_equity:pe_closing_condition",
  "private_equity:pe_closing_item", "private_equity:pe_document_link", "private_equity:pe_evidence_link",
  "private_equity:pe_finding_risk_link",
].map(q);

const IC_CHILD_TYPES = [
  "private_equity:pe_ic_memo", "private_equity:pe_ic_question", "private_equity:pe_ic_recommendation",
  "private_equity:pe_ic_vote", "private_equity:pe_ic_dissent", "private_equity:pe_ic_condition",
  "private_equity:pe_ic_decision_proposal",
].map(q);

const IC_SOURCE_TYPES = [
  "core:evidence_version", "core:document_version", "underwriting:underwriting_run",
  "private_equity:pe_ic_question", "private_equity:pe_deal_risk", "private_equity:pe_ic_condition",
  "private_equity:pe_strategy", "private_equity:pe_opportunity", "private_equity:pe_deal",
  "private_equity:pe_investment_case", "private_equity:pe_thesis", "private_equity:pe_assumption",
  "private_equity:pe_decision", "private_equity:pe_finding",
].map(q);

const registry: CompanyBrainRelationshipRegistration[] = [
  {
    kind: "strategy_opportunity", fromTypes: [q("private_equity:pe_strategy")], toTypes: [q("private_equity:pe_opportunity")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_opportunities", columns: ["id", "strategy_id"] }], resolver: "PeWorldState.opportunities.strategyId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "opportunity_deal", fromTypes: [q("private_equity:pe_opportunity")], toTypes: [q("private_equity:pe_deal")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_deals", columns: ["id", "opportunity_id"] }], resolver: "PeWorldState.deals.opportunityId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "deal_child", fromTypes: [q("private_equity:pe_deal")], toTypes: DEAL_CHILD_TYPES, direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [
      "pe_deal_parties", "pe_workstreams", "pe_requests", "pe_deliverables", "pe_findings", "pe_deal_risks",
      "pe_dependencies", "pe_milestones", "pe_closing_conditions", "pe_closing_items", "pe_document_links",
      "pe_evidence_links", "pe_finding_risk_links",
    ].map((table) => ({ table, columns: ["id", "deal_id"] })), resolver: "PeWorldState deal-scoped rows", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "deal_investment_case", fromTypes: [q("private_equity:pe_deal")], toTypes: [q("private_equity:pe_investment_case")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_investment_cases", columns: ["id", "deal_id"] }], resolver: "PeWorldState.investmentCases.dealId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "investment_case_thesis", fromTypes: [q("private_equity:pe_investment_case")], toTypes: [q("private_equity:pe_thesis")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_theses", columns: ["id", "investment_case_id"] }], resolver: "PeWorldState.theses.investmentCaseId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "investment_case_assumption", fromTypes: [q("private_equity:pe_investment_case")], toTypes: [q("private_equity:pe_assumption")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_assumptions", columns: ["id", "investment_case_id"] }], resolver: "PeWorldState.assumptions.investmentCaseId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "investment_case_decision", fromTypes: [q("private_equity:pe_investment_case")], toTypes: [q("private_equity:pe_decision")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_decisions", columns: ["id", "investment_case_id"] }], resolver: "PeWorldState.decisions.investmentCaseId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "decision_effect", fromTypes: [q("private_equity:pe_decision")], toTypes: [q("core:work"), q("core:domain_action"), q("core:decision_receipt")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_decision_effect_links", columns: ["id", "decision_id", "effect_type", "effect_id"] }], resolver: "PeWorldState.decisionEffectLinks", tenantRule: "authenticated_tenant_only", historyBehavior: "created_at_bounded", inspectionBehavior: "source_row",
  },
  {
    kind: "finding_risk", fromTypes: [q("private_equity:pe_finding")], toTypes: [q("private_equity:pe_deal_risk")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_finding_risk_links", columns: ["id", "finding_id", "deal_risk_id"] }], resolver: "PeWorldState.findingRiskLinks", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "dependency_blocks", fromTypes: DEAL_CHILD_TYPES, toTypes: DEAL_CHILD_TYPES, direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_dependencies", columns: ["id", "blocker_type", "blocker_id", "blocked_type", "blocked_id"] }], resolver: "PeWorldState.dependencies", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "document_link", fromTypes: [q("private_equity:pe_deal"), q("private_equity:pe_request"), q("private_equity:pe_deliverable"), q("private_equity:pe_finding"), q("private_equity:pe_closing_condition"), q("private_equity:pe_closing_item")], toTypes: [q("core:document")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_document_links", columns: ["id", "entity_type", "entity_id", "document_id"] }], resolver: "PeWorldState.documentLinks", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "evidence_link", fromTypes: [q("private_equity:pe_finding"), q("private_equity:pe_deal_risk"), q("private_equity:pe_closing_condition"), q("private_equity:pe_closing_item")], toTypes: [q("core:evidence_source"), q("core:evidence_version")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_evidence_links", columns: ["id", "entity_type", "entity_id", "evidence_source_id", "evidence_version_id"] }], resolver: "PeWorldState.evidenceLinks", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "document_version", fromTypes: [q("core:document")], toTypes: [q("core:document_version")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "document_versions", columns: ["id", "document_id"] }], resolver: "IcWorkspaceReadModel.artifacts", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "evidence_version", fromTypes: [q("core:evidence_source")], toTypes: [q("core:evidence_version")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "evidence_source_versions", columns: ["id", "source_id"] }], resolver: "PeWorldState.evidence", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "source_observation_evidence", fromTypes: [q("core:source_observation")], toTypes: [q("core:evidence_version")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "external_ref_observations", columns: ["id", "evidence_version_id"] }], resolver: "PeWorldState.observedEvidence", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "source_observation_object", fromTypes: [q("core:source_observation")], toTypes: [q("private_equity:pe_strategy"), q("private_equity:pe_opportunity"), q("private_equity:pe_deal"), ...DEAL_CHILD_TYPES], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "external_ref_observations", columns: ["id", "canonical_entity_type", "canonical_entity_id"] }], resolver: "PeWorldState.observedEvidence", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "work_entity_link", fromTypes: [q("private_equity:pe_strategy"), q("private_equity:pe_opportunity"), q("private_equity:pe_deal"), ...DEAL_CHILD_TYPES], toTypes: [q("core:work")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "work_entity_links", columns: ["id", "entity_type", "entity_id", "work_id"] }], resolver: "PeWorldState.workLinks", tenantRule: "authenticated_tenant_only", historyBehavior: "created_at_bounded", inspectionBehavior: "source_row",
  },
  {
    kind: "underwriting_model", fromTypes: [q("private_equity:pe_investment_case")], toTypes: [q("underwriting:underwriting_model")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "underwriting_models", columns: ["id", "investment_case_id"] }], resolver: "listUnderwritingWorkspace.models", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "underwriting_model_version", fromTypes: [q("underwriting:underwriting_model")], toTypes: [q("underwriting:underwriting_model_version")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "underwriting_model_versions", columns: ["id", "model_id"] }], resolver: "listUnderwritingWorkspace.modelVersions", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "underwriting_scenario", fromTypes: [q("private_equity:pe_investment_case")], toTypes: [q("underwriting:underwriting_scenario")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "underwriting_scenarios", columns: ["id", "investment_case_id"] }], resolver: "listUnderwritingWorkspace.scenarios", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "underwriting_run", fromTypes: [q("underwriting:underwriting_model_version")], toTypes: [q("underwriting:underwriting_run")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "underwriting_runs", columns: ["id", "model_version_id"] }], resolver: "listUnderwritingWorkspace.runs", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "underwriting_sensitivity", fromTypes: [q("private_equity:pe_investment_case"), q("underwriting:underwriting_model_version")], toTypes: [q("underwriting:underwriting_sensitivity")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "underwriting_sensitivities", columns: ["id", "investment_case_id", "model_version_id"] }], resolver: "listUnderwritingWorkspace.sensitivities", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "ic_case_investment_case", fromTypes: [q("private_equity:pe_ic_case")], toTypes: [q("private_equity:pe_investment_case")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_ic_cases", columns: ["id", "investment_case_id"] }], resolver: "IcWorkspaceReadModel.case.investmentCaseId", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "ic_case_child", fromTypes: [q("private_equity:pe_ic_case")], toTypes: IC_CHILD_TYPES, direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: ["pe_ic_memos", "pe_ic_questions", "pe_ic_recommendations", "pe_ic_votes", "pe_ic_dissents", "pe_ic_conditions", "pe_ic_decision_proposals"].map((table) => ({ table, columns: ["id", "ic_case_id"] })), resolver: "IcWorkspaceReadModel child collections", tenantRule: "authenticated_tenant_only", historyBehavior: "canonical_as_of", inspectionBehavior: "source_row",
  },
  {
    kind: "ic_source_link", fromTypes: IC_CHILD_TYPES, toTypes: IC_SOURCE_TYPES, direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_ic_source_links", columns: ["id", "owner_kind", "owner_id", "source_kind"] }], resolver: "IcWorkspaceReadModel child.sources", tenantRule: "authenticated_tenant_only", historyBehavior: "created_at_bounded", inspectionBehavior: "source_row",
  },
  {
    kind: "ic_final_decision", fromTypes: [q("private_equity:pe_ic_case")], toTypes: [q("private_equity:pe_decision")], direction: "outbound",
    sourceOwner: "@finnor/private-equity", persistedSources: [{ table: "pe_ic_decision_links", columns: ["id", "ic_case_id", "decision_id"] }], resolver: "IcWorkspaceReadModel.decisionProof", tenantRule: "authenticated_tenant_only", historyBehavior: "created_at_bounded", inspectionBehavior: "source_row",
  },
  {
    kind: "work_plan_revision", fromTypes: [q("core:work")], toTypes: [q("planning:plan_revision")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "work_plan_revisions", columns: ["id", "work_id"] }], resolver: "workAggregate.planRevisions", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "plan_revision_goal", fromTypes: [q("planning:plan_revision")], toTypes: [q("planning:goal")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "work_plan_revisions", columns: ["id", "goal_hash", "goal_spec"] }], resolver: "workPlanRevisions.goalHash", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_field",
  },
  {
    kind: "plan_revision_node", fromTypes: [q("planning:plan_revision")], toTypes: [q("planning:plan_node")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "work_plan_revisions", columns: ["id", "plan_graph.nodes"] }], resolver: "workPlanRevisions.planGraph.nodes", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_field",
  },
  {
    kind: "plan_dependency", fromTypes: [q("planning:plan_node")], toTypes: [q("planning:plan_node")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "work_plan_revisions", columns: ["id", "plan_graph.edges"] }], resolver: "workPlanRevisions.planGraph.edges", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_field",
  },
  {
    kind: "action_effect", fromTypes: [q("core:domain_action")], toTypes: [q("core:business_effect")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "business_effects", columns: ["id", "domain_action_id"] }], resolver: "workAggregate.businessEffects", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "effect_receipt", fromTypes: [q("core:business_effect")], toTypes: [q("core:decision_receipt")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "decision_receipts", columns: ["id", "business_effect_id"] }], resolver: "workAggregate.receipts", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "plan_completion_proof", fromTypes: [q("planning:plan_revision")], toTypes: [q("planning:completion_proof")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "work_plan_revisions", columns: ["id", "completion_proof"] }], resolver: "workPlanRevisions.completionProof", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_field",
  },
  {
    kind: "agent_revision", fromTypes: [q("workforce:agent_profile")], toTypes: [q("workforce:agent_revision")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "agent_profile_revisions", columns: ["id", "agent_profile_id"] }], resolver: "workforceStatus.workers.activeRevision", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "assignment_agent", fromTypes: [q("workforce:agent_assignment")], toTypes: [q("workforce:agent_profile")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "workforce_assignments", columns: ["id", "agent_profile_id"] }], resolver: "workforceStatus.assignments", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "assignment_work", fromTypes: [q("workforce:agent_assignment")], toTypes: [q("core:work")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "workforce_assignments", columns: ["id", "work_id"] }], resolver: "workforceStatus.assignments", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "assignment_plan_node", fromTypes: [q("workforce:agent_assignment")], toTypes: [q("planning:plan_node")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "workforce_assignments", columns: ["id", "plan_revision_id", "plan_node_id"] }], resolver: "workforceStatus.assignments", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
  {
    kind: "learning_revision_agent", fromTypes: [q("workforce:learning_revision")], toTypes: [q("workforce:agent_profile")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "learning_revisions", columns: ["id", "target_agent_profile_id"] }], resolver: "workforceStatus.learningRevisions", tenantRule: "authenticated_tenant_only", historyBehavior: "immutable", inspectionBehavior: "source_row",
  },
  {
    kind: "reassignment_previous", fromTypes: [q("workforce:agent_assignment")], toTypes: [q("workforce:agent_assignment")], direction: "outbound",
    sourceOwner: "@finnor/db", persistedSources: [{ table: "workforce_assignments", columns: ["id", "previous_assignment_id"] }], resolver: "workforceStatus.assignments.previousAssignmentId", tenantRule: "authenticated_tenant_only", historyBehavior: "current_only", inspectionBehavior: "source_row",
  },
];

if (registry.length !== COMPANY_BRAIN_RELATIONSHIP_KINDS.length
  || new Set(registry.map((entry) => entry.kind)).size !== COMPANY_BRAIN_RELATIONSHIP_KINDS.length) {
  throw new Error("Company Brain relationship registry must define every relationship kind exactly once");
}

export const COMPANY_BRAIN_RELATIONSHIP_REGISTRY = Object.freeze(registry);

export function qualifiedBrainType(ref: CompanyBrainObjectRef): CompanyBrainQualifiedType {
  return `${ref.namespace}:${ref.type}` as CompanyBrainQualifiedType;
}

export function relationshipRegistration(kind: CompanyBrainRelationshipKind): CompanyBrainRelationshipRegistration {
  const entry = COMPANY_BRAIN_RELATIONSHIP_REGISTRY.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`Unregistered Company Brain relationship: ${kind}`);
  return entry;
}

export function createCompanyBrainEdge(input: {
  kind: CompanyBrainRelationshipKind;
  fromRef: CompanyBrainObjectRef;
  toRef: CompanyBrainObjectRef;
  sourceRef: CompanyBrainSourceRef;
  asOf: string;
}): CompanyBrainEdge {
  const entry = relationshipRegistration(input.kind);
  const fromType = qualifiedBrainType(input.fromRef);
  const toType = qualifiedBrainType(input.toRef);
  if (!entry.fromTypes.includes(fromType)) throw new Error(`${input.kind} rejects source type ${fromType}`);
  if (!entry.toTypes.includes(toType)) throw new Error(`${input.kind} rejects target type ${toType}`);
  if (input.sourceRef.owner !== entry.sourceOwner) throw new Error(`${input.kind} rejects source owner ${input.sourceRef.owner}`);
  if (!entry.persistedSources.some((source) => source.table === input.sourceRef.table)) {
    throw new Error(`${input.kind} rejects unregistered persisted source ${input.sourceRef.table}`);
  }
  if (!input.sourceRef.id.trim()) throw new Error(`${input.kind} requires an exact persisted source ID`);
  if (!Number.isFinite(Date.parse(input.asOf))) throw new Error(`${input.kind} requires an ISO asOf timestamp`);
  return {
    fromRef: input.fromRef,
    toRef: input.toRef,
    relationship: input.kind,
    sourceRef: input.sourceRef,
    asOf: input.asOf,
  };
}
