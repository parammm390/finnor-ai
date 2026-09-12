import { describe, expect, it } from "vitest";
import type { WorkforceStatusResult } from "@finnor/shared-types";
import type { WorkAggregate } from "@finnor/db";
import {
  COMPANY_BRAIN_RELATIONSHIP_KINDS,
  type CompanyBrainObjectRef,
  type CompanyBrainQualifiedType,
  type CompanyBrainSourceBundle,
} from "./company-brain-types";
import {
  COMPANY_BRAIN_RELATIONSHIP_REGISTRY,
  createCompanyBrainEdge,
} from "./company-brain-relationships";
import {
  companyBrainEvidenceLineage,
  companyBrainObject,
  companyBrainProvenance,
  companyBrainRefKey,
  mapCompanyBrainEpistemicWarning,
  parseCompanyBrainObjectRef,
  projectCompanyBrain,
  resolvePeOperatingContext,
  searchCompanyBrainProjection,
  traverseCompanyBrain,
} from "./company-brain";
import type { PeWorldState } from "./types";

const at = "2026-09-11T12:00:00.000Z";

function refFor(qualified: CompanyBrainQualifiedType, id = "11111111-1111-4111-8111-111111111111"): CompanyBrainObjectRef {
  const [namespace, type] = qualified.split(":");
  const owner = namespace === "private_equity" || namespace === "underwriting" ? "@finnor/private-equity" : "@finnor/db";
  const parsed = parseCompanyBrainObjectRef({ namespace, owner, type, id });
  if (!parsed) throw new Error(`Test could not construct ${qualified}`);
  return parsed;
}

describe("Company Brain relationship registry", () => {
  it("registers every declared relationship exactly once", () => {
    expect(COMPANY_BRAIN_RELATIONSHIP_REGISTRY.map((entry) => entry.kind)).toEqual(COMPANY_BRAIN_RELATIONSHIP_KINDS);
    expect(new Set(COMPANY_BRAIN_RELATIONSHIP_REGISTRY.map((entry) => entry.kind)).size).toBe(COMPANY_BRAIN_RELATIONSHIP_KINDS.length);
  });

  it.each(COMPANY_BRAIN_RELATIONSHIP_REGISTRY)("accepts only the exact persisted source for $kind", (registration) => {
    const fromRef = refFor(registration.fromTypes[0]!);
    const toRef = refFor(registration.toTypes[0]!, "22222222-2222-4222-8222-222222222222");
    const source = registration.persistedSources[0]!;
    const edge = createCompanyBrainEdge({
      kind: registration.kind,
      fromRef,
      toRef,
      sourceRef: { owner: registration.sourceOwner, table: source.table, id: "33333333-3333-4333-8333-333333333333" },
      asOf: at,
    });
    expect(edge.relationship).toBe(registration.kind);
    expect(edge.sourceRef.table).toBe(source.table);
    expect(() => createCompanyBrainEdge({
      kind: registration.kind,
      fromRef,
      toRef,
      sourceRef: { owner: registration.sourceOwner, table: "unregistered_source", id: "33333333-3333-4333-8333-333333333333" },
      asOf: at,
    })).toThrow(/unregistered persisted source/);
  });
});

function world(): PeWorldState {
  return {
    root: { entityType: "pe_deal", entityId: "10000000-0000-4000-8000-000000000003" },
    stateAt: at,
    temporalCompleteness: { status: "partial", baselineAt: "2026-01-01T00:00:00.000Z", unavailableEntityTypes: [], reasons: ["fixture partial"] },
    strategy: { id: "10000000-0000-4000-8000-000000000001", name: "Fund I", state: "active", version: 2 },
    opportunity: { id: "10000000-0000-4000-8000-000000000002", strategyId: "10000000-0000-4000-8000-000000000001", name: "Project Atlas", state: "qualified", version: 3 },
    deal: { id: "10000000-0000-4000-8000-000000000003", opportunityId: "10000000-0000-4000-8000-000000000002", name: "Atlas", status: "active", version: 4 },
    opportunities: [{ id: "10000000-0000-4000-8000-000000000002", strategyId: "10000000-0000-4000-8000-000000000001", name: "Project Atlas", state: "qualified", version: 3 }],
    deals: [{ id: "10000000-0000-4000-8000-000000000003", opportunityId: "10000000-0000-4000-8000-000000000002", name: "Atlas", status: "active", version: 4 }],
    investmentCases: [{ id: "10000000-0000-4000-8000-000000000004", dealId: "10000000-0000-4000-8000-000000000003", title: "Base case", state: "active", version: 1 }],
    theses: [], assumptions: [], decisions: [], decisionEffectLinks: [], dealParties: [], workstreams: [], requests: [], deliverables: [],
    findings: [
      { id: "10000000-0000-4000-8000-000000000005", dealId: "10000000-0000-4000-8000-000000000003", title: "Revenue quality", state: "open", version: 1 },
      { id: "10000000-0000-4000-8000-000000000006", dealId: "10000000-0000-4000-8000-000000000003", title: "Same label", state: "open", version: 1 },
    ],
    dealRisks: [{ id: "10000000-0000-4000-8000-000000000007", dealId: "10000000-0000-4000-8000-000000000003", title: "Same label", state: "open", version: 1 }],
    findingRiskLinks: [], dependencies: [], milestones: [], closingConditions: [], closingItems: [],
    documents: [{ id: "10000000-0000-4000-8000-000000000008", title: "QoE report", kind: "report", createdAt: at }],
    evidence: [{ sourceId: "10000000-0000-4000-8000-000000000009", versionId: "10000000-0000-4000-8000-000000000010", sourceType: "document", versionNumber: 1, contentHash: "hash", asOf: at, retrievedAt: at }],
    observedEvidence: [], sourceCoverage: [], sourceCoverageWarnings: [], unresolvedProviderObservations: 0, ambiguousProviderObservations: 0,
    providerFreshnessWarnings: [], providerEvidenceCompleteness: { status: "partial", absenceClaimsPermitted: false, reasons: ["coverage incomplete"] },
    documentLinks: [{ id: "10000000-0000-4000-8000-000000000011", dealId: "10000000-0000-4000-8000-000000000003", entityType: "pe_finding", entityId: "10000000-0000-4000-8000-000000000005", documentId: "10000000-0000-4000-8000-000000000008", linkRole: "source", createdAt: at }],
    evidenceLinks: [{ id: "10000000-0000-4000-8000-000000000012", dealId: "10000000-0000-4000-8000-000000000003", entityType: "pe_finding", entityId: "10000000-0000-4000-8000-000000000005", evidenceSourceId: "10000000-0000-4000-8000-000000000009", evidenceVersionId: "10000000-0000-4000-8000-000000000010", relationship: "supports", createdAt: at }],
    workLinks: [{ id: "10000000-0000-4000-8000-000000000013", entityType: "pe_deal", entityId: "10000000-0000-4000-8000-000000000003", workId: "10000000-0000-4000-8000-000000000014", createdAt: at }],
    taskLinks: [], businessEvents: [], authorityDecisions: [], approvalRequests: [], decisionReceipts: [], conflicts: [],
    epistemicWarnings: [{ propositionId: "pe:v1:pe_finding:10000000-0000-4000-8000-000000000005:state", predicate: "finding.state", status: "UNCERTAIN", reason: "source incomplete", evidenceRefs: [] }],
    provenance: [],
  };
}

function bundle(): CompanyBrainSourceBundle {
  const workId = "10000000-0000-4000-8000-000000000014";
  const planId = "10000000-0000-4000-8000-000000000015";
  const actionId = "10000000-0000-4000-8000-000000000016";
  const effectId = "10000000-0000-4000-8000-000000000017";
  const receiptId = "10000000-0000-4000-8000-000000000018";
  const aggregate = {
    work: { id: workId, status: "executing", initialInstruction: "Review Atlas", createdAt: at },
    planRevisions: [{ id: planId, workId, revision: 1, status: "active", goalHash: "goal-hash", goalSpec: { objective: "Complete diligence" }, planGraph: { nodes: [{ id: "node-a", kind: "query" }, { id: "node-b", kind: "check" }], edges: [{ from: "node-a", to: "node-b", kind: "causal_prerequisite" }] }, selectedAt: at, completionProof: { verified: true } }],
    actions: [{ id: actionId, workId, actionType: "pe.review", status: "authorized", createdAt: at }],
    businessEffects: [{ id: effectId, domainActionId: actionId, status: "executing", createdAt: at }],
    receipts: [{ id: receiptId, workId, businessEffectId: effectId, objective: "Review", finalizedAt: at, createdAt: at }],
  } as unknown as WorkAggregate;
  const workforce = {
    status: "ok",
    workers: [{ id: "10000000-0000-4000-8000-000000000019", key: "deal-review", name: "Deal Review", profileStatus: "enabled", runtimeStatus: "working", currentLoad: 1, activeRevision: { id: "10000000-0000-4000-8000-000000000020", revision: 1, createdAt: at }, latestAssignment: null, metrics: [] }],
    assignments: [{ id: "10000000-0000-4000-8000-000000000021", workId, planRevisionId: planId, planNodeId: "node-a", agentProfileId: "10000000-0000-4000-8000-000000000019", agentRevisionId: "10000000-0000-4000-8000-000000000020", capability: "query", nodeKind: "query", state: "running", attempt: 1, assignmentReason: "eligible", previousAssignmentId: null, reassignmentReason: null, domainActionId: null, startedAt: at, completedAt: null, failure: null, createdAt: at, updatedAt: at }],
    learningRevisions: [{ id: "10000000-0000-4000-8000-000000000022", targetAgentProfileId: "10000000-0000-4000-8000-000000000019", revision: 1, parentRevisionId: null, sourceProposalId: "10000000-0000-4000-8000-000000000023", semanticHash: "learning-hash", promotedBy: "10000000-0000-4000-8000-000000000024", createdAt: at }],
  } as unknown as WorkforceStatusResult;
  return { world: world(), underwriting: [], ic: [], works: [aggregate], workforce, attention: null };
}

describe("Company Brain projection", () => {
  it("composes source-backed P1/P6/P7 objects with exact facts and inspection targets", () => {
    const projection = projectCompanyBrain(bundle());
    expect(projection.temporal).toMatchObject({ support: "canonical_history", completeness: "partial" });
    expect(projection.nodes.length).toBeGreaterThan(10);
    expect(projection.nodes.every((node) => node.provenanceRefs.length > 0 && node.facts.every((fact) => fact.sourceRefs.length > 0) && Boolean(node.inspectionTarget))).toBe(true);
    expect(projection.edges.some((edge) => edge.relationship === "plan_dependency" && edge.sourceRef.fieldPath === "plan_graph.edges[0]")).toBe(true);
    expect(projection.edges.some((edge) => edge.relationship === "action_effect" && edge.sourceRef.table === "business_effects")).toBe(true);
    expect(projection.edges.some((edge) => edge.relationship === "effect_receipt" && edge.sourceRef.table === "decision_receipts")).toBe(true);
  });

  it("does not infer a relationship from matching labels or chronology", () => {
    const projection = projectCompanyBrain(bundle());
    const finding = { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_finding", id: "10000000-0000-4000-8000-000000000006" } as const;
    const risk = { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal_risk", id: "10000000-0000-4000-8000-000000000007" } as const;
    expect(projection.edges.some((edge) => companyBrainRefKey(edge.fromRef) === companyBrainRefKey(finding) && companyBrainRefKey(edge.toRef) === companyBrainRefKey(risk))).toBe(false);
  });

  it("preserves rich P1 warnings while deterministically mapping uncertainty", () => {
    const warning = mapCompanyBrainEpistemicWarning(world().epistemicWarnings[0]!);
    expect(warning).toMatchObject({ sourceStatus: "UNCERTAIN", mappedState: "UNKNOWN", reason: "source incomplete" });
    const projection = projectCompanyBrain(bundle());
    const node = companyBrainObject(projection, { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_finding", id: "10000000-0000-4000-8000-000000000005" });
    expect(node).toMatchObject({ epistemicState: "UNKNOWN", temporal: { completeness: "partial" } });
    expect(node?.epistemicWarnings[0]?.sourceStatus).toBe("UNCERTAIN");
  });

  it("bounds search and exact-edge traversal and returns source-backed provenance", () => {
    const projection = projectCompanyBrain(bundle());
    const dealRef = { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal", id: "10000000-0000-4000-8000-000000000003" } as const;
    expect(searchCompanyBrainProjection(projection, "Atlas", 1)).toHaveLength(1);
    const traversed = traverseCompanyBrain(projection, dealRef, { depth: 2, limit: 3 });
    expect(traversed.page.returned).toBeLessThanOrEqual(3);
    expect(traversed.edges.every((edge) => edge.sourceRef.id.length > 0)).toBe(true);
    const provenance = companyBrainProvenance(projection, dealRef);
    expect(provenance.sourceRefs.some((source) => source.table === "pe_deals")).toBe(true);
    const evidence = companyBrainEvidenceLineage(projection, { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_finding", id: "10000000-0000-4000-8000-000000000005" });
    expect(evidence.edges.some((edge) => edge.relationship === "evidence_link")).toBe(true);
  });

  it("fails closed when a selected object or Work is outside the projected root", () => {
    const projection = projectCompanyBrain(bundle());
    const foreign = { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal", id: "90000000-0000-4000-8000-000000000001" } as const;
    expect(companyBrainObject(projection, foreign)).toBeNull();
    expect(() => traverseCompanyBrain(projection, foreign)).toThrow(/authenticated root projection/);
    expect(() => companyBrainProvenance(projection, foreign)).toThrow(/authenticated root projection/);
    expect(() => resolvePeOperatingContext(projection, { root: projection.root, selectedObject: foreign, workId: null })).toThrow(/not related/);
    expect(() => resolvePeOperatingContext(projection, { root: projection.root, selectedObject: null, workId: "90000000-0000-4000-8000-000000000002" })).toThrow(/not linked/);
  });
});
