import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closePool,
  configureTenantVertical,
  receiveWork,
  workAggregate,
} from "@finnor/db";
import {
  addDealParty,
  attachCanonicalDocument,
  attachWorkToDealGraph,
  acknowledgeRequest,
  cancelRequest,
  createClosingCondition,
  createClosingItem,
  createDeal,
  createDealRisk,
  createDependency,
  createFinding,
  createRequest,
  createWorkstream,
  fulfillRequest,
  interpretPrivateEquityQuestion,
  markClosingConditionEvidencePending,
  markClosingItemReady,
  pePropositionId,
  recordPrivateEquityDocumentClaim,
  recordPrivateEquityProviderAcknowledgement,
  recordPrivateEquitySourceObservation,
  startWorkstream,
  type PeMutationContext,
  type PrivateEquityObservationReceipt,
} from "@finnor/private-equity";
import {
  FinnorOrchestrator,
  assembleOperatingContext,
  executeTenantOperationalQuery,
  operationalQueryIntentsForVertical,
} from "@finnor/orchestration";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const AS_OF = new Date("2026-09-05T12:00:00.000Z");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const databaseAvailable = await canConnect(SUPER_URL);

describe.skipIf(!databaseAvailable)("Private Equity Phase 3 truth and cognition", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const retirementBoundaryTenant = randomUUID();
  const leadA = randomUUID();
  const leadB = randomUUID();
  const targetA = randomUUID();
  const targetB = randomUUID();
  const portalIntegration = randomUUID();
  const archiveIntegration = randomUUID();
  const foreignIntegration = randomUUID();
  const lenderDocument = randomUUID();
  const findingDocument = randomUUID();
  const foreignDocument = randomUUID();
  const ctxA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: leadA, employeeId: leadA, role: "owner" },
    provenance: { sourceSystem: "integration:pe3", createdBy: leadA, observedAt: AS_OF },
  };
  const ctxB: PeMutationContext = {
    auth: { tenantId: tenantB, userId: leadB, employeeId: leadB, role: "owner" },
    provenance: { sourceSystem: "integration:pe3", createdBy: leadB, observedAt: AS_OF },
  };

  let admin: pg.Client;
  let dealId: string;
  let financingWorkstreamId: string;
  let legalWorkstreamId: string;
  let openRequestId: string;
  let acknowledgedRequestId: string;
  let findingId: string;
  let riskId: string;
  let financingConditionId: string;
  let missingConditionId: string;
  let closingItemId: string;
  let directWork: Awaited<ReturnType<typeof receiveWork>>;
  let anchoredWork: Awaited<ReturnType<typeof receiveWork>>;
  let acknowledgementSnapshot: Record<string, unknown>;
  let firstObservation: PrivateEquityObservationReceipt;
  let duplicateObservation: PrivateEquityObservationReceipt;
  let olderObservation: PrivateEquityObservationReceipt;
  let staleObservation: PrivateEquityObservationReceipt;
  let tombstoneObservation: PrivateEquityObservationReceipt;
  let documentEvidence: Awaited<ReturnType<typeof recordPrivateEquityDocumentClaim>>;
  let conditionBeforeEvidence: Record<string, unknown>;
  let conditionAfterEvidence: Record<string, unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
        ($1,$2,'PE3 Atlas Tenant'),($3,$4,'PE3 Foreign Tenant'),($5,$6,'PE3 Retirement Boundary')`,
      [tenantA, `pe3-a-${randomUUID()}`, tenantB, `pe3-b-${randomUUID()}`, retirementBoundaryTenant, `pe3-retired-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name) VALUES
        ($1,$2,$3,'owner','Atlas Deal Lead'),($4,$5,$6,'owner','Foreign Deal Lead')`,
      [leadA, tenantA, `pe3-a-${randomUUID()}@test.invalid`, leadB, tenantB, `pe3-b-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
        ($1,$2,'pe3-atlas','Atlas Software','other'),($3,$4,'pe3-foreign','Foreign Target','other')`,
      [targetA, tenantA, targetB, tenantB],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES
        ($1,$4,'financing','Lender commitment evidence','integration:pe3',$5),
        ($2,$4,'commercial','Customer concentration source','integration:pe3',$5),
        ($3,$6,'financing','Foreign lender document','integration:pe3',$7)`,
      [lenderDocument, findingDocument, foreignDocument, tenantA, leadA, tenantB, leadB],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES
        ($1,$4,'documents','synthetic_lender_portal','emulator'),
        ($2,$4,'esign','synthetic_archive','emulator'),
        ($3,$5,'documents','synthetic_foreign','emulator')`,
      [portalIntegration, archiveIntegration, foreignIntegration, tenantA, tenantB],
    );

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0, createdBy: leadA, sourceSystem: "integration:pe3" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0, createdBy: leadB, sourceSystem: "integration:pe3" });

    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA,
      name: "Atlas Software acquisition",
      codeName: "Atlas",
      dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-01T12:00:00.000Z"),
      targetClosingAt: new Date("2026-09-11T17:00:00.000Z"),
    });
    dealId = String(deal.row.id);
    const financing = await createWorkstream(ctxA, {
      dealId, kind: "financing", name: "Financing", owner: { partyType: "employee", partyId: leadA },
    });
    const legal = await createWorkstream(ctxA, {
      dealId, kind: "legal", name: "Legal", owner: { partyType: "employee", partyId: leadA },
    });
    financingWorkstreamId = String(financing.row.id);
    legalWorkstreamId = String(legal.row.id);
    await startWorkstream(ctxA, { workstreamId: financingWorkstreamId, expectedVersion: 1 });
    await startWorkstream(ctxA, { workstreamId: legalWorkstreamId, expectedVersion: 1 });
    const lender = await addDealParty(ctxA, {
      dealId,
      party: { partyType: "external_organization", partyId: targetA },
      role: "lender",
    });
    const requestBase = {
      dealId,
      workstreamId: financingWorkstreamId,
      requestedFromDealPartyId: String(lender.row.id),
      owner: { partyType: "employee" as const, partyId: leadA },
    };
    const open = await createRequest(ctxA, {
      ...requestBase,
      requestText: "Provide final debt payoff letter.",
      dueAt: new Date("2026-09-04T12:00:00.000Z"),
    });
    const acknowledged = await createRequest(ctxA, {
      ...requestBase,
      requestText: "Provide lender funds-flow confirmation.",
      dueAt: new Date("2026-09-10T12:00:00.000Z"),
    });
    const fulfilled = await createRequest(ctxA, { ...requestBase, requestText: "Provide historical covenant schedule." });
    const cancelled = await createRequest(ctxA, { ...requestBase, requestText: "Provide obsolete lender checklist." });
    openRequestId = String(open.row.id);
    acknowledgedRequestId = String(acknowledged.row.id);
    await acknowledgeRequest(ctxA, { requestId: acknowledgedRequestId, expectedVersion: 1 });
    await fulfillRequest(ctxA, { requestId: String(fulfilled.row.id), expectedVersion: 1 });
    await cancelRequest(ctxA, { requestId: String(cancelled.row.id), expectedVersion: 1, reason: "Superseded request" });

    const finding = await createFinding(ctxA, {
      dealId,
      workstreamId: financingWorkstreamId,
      relatedRequestId: openRequestId,
      statement: "Top customer represents 31% of revenue.",
      severity: "high",
      materiality: "material",
      owner: { partyType: "employee", partyId: leadA },
    });
    findingId = String(finding.row.id);
    const risk = await createDealRisk(ctxA, {
      dealId,
      workstreamId: financingWorkstreamId,
      statement: "Customer concentration may breach lender underwriting tolerance.",
      severity: "high",
      owner: { partyType: "employee", partyId: leadA },
      originatingFindingIds: [findingId],
    });
    riskId = String(risk.row.id);
    const condition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: financingWorkstreamId,
      conditionText: "Final lender commitment is issued.",
      category: "financing",
      evidenceRequired: true,
      owner: { partyType: "employee", partyId: leadA },
    });
    financingConditionId = String(condition.row.id);
    await markClosingConditionEvidencePending(ctxA, { closingConditionId: financingConditionId, expectedVersion: 1 });
    const missingCondition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: legalWorkstreamId,
      conditionText: "Regulatory consent evidence is received.",
      category: "regulatory",
      evidenceRequired: true,
      owner: { partyType: "employee", partyId: leadA },
    });
    missingConditionId = String(missingCondition.row.id);
    const item = await createClosingItem(ctxA, {
      dealId,
      workstreamId: legalWorkstreamId,
      itemText: "Seller signature packet is complete.",
      category: "signature",
      verificationEvidenceRequired: true,
      owner: { partyType: "employee", partyId: leadA },
    });
    closingItemId = String(item.row.id);
    await markClosingItemReady(ctxA, { closingItemId, expectedVersion: 1 });
    await createDependency(ctxA, {
      dealId,
      blocker: { entityType: "pe_deal_risk", entityId: riskId },
      blocked: { entityType: "pe_closing_condition", entityId: financingConditionId },
    });
    await createDependency(ctxA, {
      dealId,
      blocker: { entityType: "pe_closing_condition", entityId: financingConditionId },
      blocked: { entityType: "pe_closing_item", entityId: closingItemId },
    });

    directWork = await receiveWork({
      tenantId: tenantA,
      userId: leadA,
      channel: "console",
      instruction: "Inspect Atlas closing readiness.",
      idempotencyKey: `pe3-direct-${randomUUID()}`,
    });
    anchoredWork = await receiveWork({
      tenantId: tenantA,
      userId: leadA,
      channel: "console",
      instruction: "Track the Atlas financing condition.",
      idempotencyKey: `pe3-anchor-${randomUUID()}`,
    });
    for (const work of [directWork, anchoredWork]) {
      await attachWorkToDealGraph(ctxA, { dealId, workId: work.workId, entities: [
        { entityType: "pe_deal", entityId: dealId, relationship: "about" },
        { entityType: "pe_workstream", entityId: financingWorkstreamId, relationship: "target" },
        { entityType: "pe_closing_condition", entityId: financingConditionId, relationship: "target" },
      ] });
    }

    conditionBeforeEvidence = (await admin.query(
      "SELECT state,version,satisfied_at FROM finnor_os.pe_closing_conditions WHERE tenant_id=$1 AND id=$2",
      [tenantA, financingConditionId],
    )).rows[0]!;
    await recordPrivateEquityProviderAcknowledgement(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
      integrationId: portalIntegration,
      provider: "synthetic_lender_portal",
      externalObjectType: "commitment",
      externalId: "ATLAS-COMMITMENT",
    });
    acknowledgementSnapshot = (await admin.query(
      `SELECT mapping_status,sync_status,freshness_state,observed_state,last_observed_at
         FROM finnor_os.external_refs
        WHERE tenant_id=$1 AND integration_id=$2 AND external_id='ATLAS-COMMITMENT'`,
      [tenantA, portalIntegration],
    )).rows[0]!;
    const portalInput = {
      dealId,
      entity: { entityType: "pe_closing_condition" as const, entityId: financingConditionId },
      integrationId: portalIntegration,
      provider: "synthetic_lender_portal",
      sourceScope: "lender-commitments",
      externalObjectType: "commitment",
      externalId: "ATLAS-COMMITMENT",
      claims: [{
        entity: { entityType: "pe_closing_condition" as const, entityId: financingConditionId },
        predicate: "closing_condition.state" as const,
        value: "satisfied",
      }],
      observedAt: "2026-09-05T11:30:00.000Z",
      sourceVersion: "v12",
      sourceSequence: "12",
      provenance: { fixture: "provider-observation" },
    };
    firstObservation = await recordPrivateEquitySourceObservation(ctxA, portalInput);
    duplicateObservation = await recordPrivateEquitySourceObservation(ctxA, portalInput);
    olderObservation = await recordPrivateEquitySourceObservation(ctxA, {
      ...portalInput,
      sourceVersion: "v10",
      sourceSequence: "10",
      observedAt: "2026-09-05T11:45:00.000Z",
      claims: [{
        entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
        predicate: "closing_condition.state",
        value: "open",
      }],
    });
    staleObservation = await recordPrivateEquitySourceObservation(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
      integrationId: archiveIntegration,
      provider: "synthetic_archive",
      sourceScope: "archived-lender-email",
      externalObjectType: "email",
      externalId: "ATLAS-LENDER-EMAIL",
      claims: [{
        entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
        predicate: "closing_condition.state",
        value: "evidence_pending",
        maximumAgeMs: 60_000,
        freshnessPolicyRef: "policy:financing-observation:v1",
      }],
      observedAt: "2026-09-01T09:00:00.000Z",
      sourceVersion: "email-1",
      sourceSequence: "1",
    });
    await attachCanonicalDocument(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
      documentId: lenderDocument,
      linkRole: "source",
    });
    documentEvidence = await recordPrivateEquityDocumentClaim(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
      documentId: lenderDocument,
      predicate: "closing_condition.state",
      value: "satisfied",
      observedAt: "2026-09-05T11:35:00.000Z",
    });
    await attachCanonicalDocument(ctxA, {
      dealId,
      entity: { entityType: "pe_finding", entityId: findingId },
      documentId: findingDocument,
      linkRole: "source",
    });
    await recordPrivateEquityDocumentClaim(ctxA, {
      dealId,
      entity: { entityType: "pe_finding", entityId: findingId },
      documentId: findingDocument,
      predicate: "finding.current",
      value: true,
      observedAt: "2026-09-05T11:40:00.000Z",
    });
    tombstoneObservation = await recordPrivateEquitySourceObservation(ctxA, {
      ...portalInput,
      claims: [],
      deleted: true,
      sourceVersion: "v13",
      sourceSequence: "13",
      observedAt: "2026-09-05T11:50:00.000Z",
    });
    conditionAfterEvidence = (await admin.query(
      "SELECT state,version,satisfied_at FROM finnor_os.pe_closing_conditions WHERE tenant_id=$1 AND id=$2",
      [tenantA, financingConditionId],
    )).rows[0]!;
  }, 60_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("keeps acknowledgement, observation, Document evidence, ordering, dedupe, and tombstone distinct from canonical state", async () => {
    expect(acknowledgementSnapshot).toMatchObject({
      mapping_status: "mapped",
      sync_status: "acknowledged",
      freshness_state: "unknown",
      observed_state: {},
      last_observed_at: null,
    });
    expect(firstObservation.materialization.status).toBe("observed");
    expect(firstObservation.evidenceSourceId).toBeTruthy();
    expect(firstObservation.evidenceVersionId).toBeTruthy();
    expect(duplicateObservation.materialization.status).toBe("duplicate");
    expect(duplicateObservation.evidenceVersionId).toBe(firstObservation.evidenceVersionId);
    expect(olderObservation).toMatchObject({
      materialization: { status: "out_of_order", reason: "provider sequence regressed" },
      evidenceSourceId: null,
      evidenceVersionId: null,
    });
    expect(staleObservation.materialization.status).toBe("observed");
    expect(documentEvidence.evidenceVersionId).toBeTruthy();
    expect(tombstoneObservation.materialization.status).toBe("tombstoned");
    expect(conditionBeforeEvidence).toEqual(conditionAfterEvidence);
    expect(conditionAfterEvidence).toMatchObject({ state: "evidence_pending", version: 2, satisfied_at: null });

    const stored = await admin.query<{
      source_type: string;
      version_id: string;
      snapshot: Record<string, unknown>;
      as_of: Date;
    }>(
      `SELECT s.source_type,v.id::text version_id,v.snapshot,v.as_of
         FROM finnor_os.pe_evidence_links l
         JOIN finnor_os.evidence_sources s ON s.id=l.evidence_source_id AND s.tenant_id=l.tenant_id
         JOIN finnor_os.evidence_source_versions v ON v.id=l.evidence_version_id AND v.tenant_id=l.tenant_id
        WHERE l.tenant_id=$1 AND l.entity_type='pe_closing_condition' AND l.entity_id=$2
        ORDER BY s.source_type,v.as_of`,
      [tenantA, financingConditionId],
    );
    expect(stored.rows.map((row) => row.source_type)).toEqual(expect.arrayContaining(["pe_provider_observation", "pe_document_claim"]));
    expect(stored.rows.some((row) => JSON.stringify(row.snapshot).includes(lenderDocument))).toBe(true);
    expect(stored.rows.some((row) => row.as_of.toISOString() === "2026-09-01T09:00:00.000Z")).toBe(true);
    await expect(admin.query(
      "UPDATE finnor_os.evidence_source_versions SET content='tampered' WHERE id=$1",
      [documentEvidence.evidenceVersionId],
    )).rejects.toThrow(/append-only|immutable/i);
    expect((await admin.query(
      `SELECT count(*)::int count FROM finnor_os.business_events
        WHERE tenant_id=$1 AND entity_type='pe_closing_condition' AND entity_id=$2
          AND event_type='external_source_tombstoned'`,
      [tenantA, financingConditionId],
    )).rows[0]?.count).toBe(0);
  });

  it("executes all bounded PE queries, reuses exact PE2 blockers, and emits a Work read receipt without business mutation", async () => {
    const canonicalBefore = (await admin.query(
      `SELECT jsonb_build_object(
        'deal',(SELECT jsonb_build_object('status',status,'version',version,'graphVersion',graph_version) FROM finnor_os.pe_deals WHERE id=$2),
        'conditions',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'version',version) ORDER BY id) FROM finnor_os.pe_closing_conditions WHERE deal_id=$2),
        'items',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'version',version) ORDER BY id) FROM finnor_os.pe_closing_items WHERE deal_id=$2),
        'requests',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'version',version) ORDER BY id) FROM finnor_os.pe_requests WHERE deal_id=$2),
        'effects',(SELECT count(*) FROM finnor_os.business_effects WHERE tenant_id=$1),
        'approvals',(SELECT count(*) FROM finnor_os.authority_approval_requests WHERE tenant_id=$1)
      ) snapshot`,
      [tenantA, dealId],
    )).rows[0]!.snapshot;

    const dealContext = await executeTenantOperationalQuery(tenantA, { intent: "deal_context", dealId }, { now: AS_OF, maxRows: 10 });
    const pageOne = await executeTenantOperationalQuery(tenantA, { intent: "deal_workstreams", dealId, page: { limit: 1 } }, { now: AS_OF });
    const pageTwo = await executeTenantOperationalQuery(tenantA, {
      intent: "deal_workstreams", dealId, page: { limit: 1, cursor: pageOne.page.nextCursor! },
    }, { now: AS_OF });
    const requests = await executeTenantOperationalQuery(tenantA, { intent: "open_requests", dealId }, { now: AS_OF });
    const overdue = await executeTenantOperationalQuery(tenantA, { intent: "open_requests", dealId, dueState: "overdue" }, { now: AS_OF });
    const findings = await executeTenantOperationalQuery(tenantA, { intent: "open_findings", dealId }, { now: AS_OF });
    const risks = await executeTenantOperationalQuery(tenantA, { intent: "open_deal_risks", dealId }, { now: AS_OF });
    const dependencies = await executeTenantOperationalQuery(tenantA, { intent: "critical_dependencies", dealId }, { now: AS_OF });
    const readiness = await executeTenantOperationalQuery(tenantA, { intent: "closing_readiness", dealId }, {
      now: AS_OF,
      workId: directWork.workId,
      workInputId: directWork.workInputId,
      executionKey: "pe3-closing-readiness-proof",
    });

    expect(dealContext.deal).toMatchObject({ id: dealId, name: "Atlas Software acquisition", status: "active" });
    expect(dealContext.target).toEqual({ id: targetA, name: "Atlas Software" });
    expect(dealContext.workRefs.map((row) => row.workId)).toEqual(expect.arrayContaining([directWork.workId, anchoredWork.workId]));
    expect(JSON.stringify(dealContext)).not.toMatch(/household|inventory|water/i);
    expect(pageOne.rows).toHaveLength(1);
    expect(pageOne.page).toMatchObject({ hasMore: true, truncated: true, limit: 1 });
    expect(pageTwo.rows).toHaveLength(1);
    expect(pageTwo.rows[0]!.id).not.toBe(pageOne.rows[0]!.id);
    expect(requests.rows.map((row) => row.id).sort()).toEqual([acknowledgedRequestId, openRequestId].sort());
    expect(overdue.rows.map((row) => row.id)).toEqual([openRequestId]);
    expect(findings.rows).toEqual([
      expect.objectContaining({ id: findingId, state: "open", evidenceRefs: expect.arrayContaining([expect.any(String)]), riskRefs: [riskId] }),
    ]);
    expect(risks.rows).toEqual([
      expect.objectContaining({ id: riskId, state: "open", findingRefs: [findingId] }),
    ]);
    expect(dependencies.rows).toHaveLength(2);
    expect(dependencies.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ blocker: { entityType: "pe_deal_risk", entityId: riskId }, blocked: { entityType: "pe_closing_condition", entityId: financingConditionId }, resolved: false }),
      expect.objectContaining({ blocker: { entityType: "pe_closing_condition", entityId: financingConditionId }, blocked: { entityType: "pe_closing_item", entityId: closingItemId }, resolved: false }),
    ]));
    expect(readiness).toMatchObject({
      eligible: false,
      execution: { workId: directWork.workId, workInputId: directWork.workInputId, status: "succeeded" },
      queryTrace: ["closing_readiness", "critical_dependencies", "open_findings", "open_deal_risks"],
    });
    expect(readiness.blockingConditions.map((row) => row.id)).toEqual(expect.arrayContaining([financingConditionId, missingConditionId]));
    expect(readiness.unverifiedClosingItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: closingItemId, state: "ready" })]));
    expect(readiness.blockingDependencies.length).toBeGreaterThan(0);
    expect(readiness.epistemicWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: "closing_condition.state", status: "CONTRADICTED" }),
      expect.objectContaining({ predicate: "closing_condition.state", status: "STALE" }),
      expect.objectContaining({ propositionId: pePropositionId(dealId, "pe_closing_item", closingItemId, "closing_item.verified"), status: "UNKNOWN" }),
    ]));
    const missingDecision = readiness.decisionReadiness.find((row) => row.decisionId === `pe:decision:closing-condition:${missingConditionId}`)!;
    expect(missingDecision.ready).toBe(false);
    expect(missingDecision.unresolvedPropositionIds).toEqual([
      pePropositionId(dealId, "pe_closing_condition", missingConditionId, "closing_condition.evidence_sufficient"),
    ]);
    expect(missingDecision.acquisitionOptions.map((row) => row.adapterId)).toEqual([
      "CLARIFICATION_REQUEST", "EVIDENCE_CORPUS_RETRIEVAL", "SOURCE_TRUTH_OBSERVATION",
    ]);
    const itemDecision = readiness.decisionReadiness.find((row) => row.decisionId === `pe:decision:closing-item:${closingItemId}`)!;
    expect(itemDecision.ready).toBe(false);
    expect(itemDecision.unresolvedPropositionIds).toEqual([
      pePropositionId(dealId, "pe_closing_item", closingItemId, "closing_item.verified"),
    ]);

    const aggregate = await workAggregate(tenantA, directWork.workId);
    expect(aggregate?.queryExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ intent: "closing_readiness", status: "succeeded", executionKey: "pe3-closing-readiness-proof" }),
    ]));
    const canonicalAfter = (await admin.query(
      `SELECT jsonb_build_object(
        'deal',(SELECT jsonb_build_object('status',status,'version',version,'graphVersion',graph_version) FROM finnor_os.pe_deals WHERE id=$2),
        'conditions',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'version',version) ORDER BY id) FROM finnor_os.pe_closing_conditions WHERE deal_id=$2),
        'items',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'version',version) ORDER BY id) FROM finnor_os.pe_closing_items WHERE deal_id=$2),
        'requests',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'version',version) ORDER BY id) FROM finnor_os.pe_requests WHERE deal_id=$2),
        'effects',(SELECT count(*) FROM finnor_os.business_effects WHERE tenant_id=$1),
        'approvals',(SELECT count(*) FROM finnor_os.authority_approval_requests WHERE tenant_id=$1)
      ) snapshot`,
      [tenantA, dealId],
    )).rows[0]!.snapshot;
    expect(canonicalAfter).toEqual(canonicalBefore);
  });

  it("uses exact active Work anchors and routes the natural question before any planner can guess", async () => {
    const interpretation = await interpretPrivateEquityQuestion(tenantA, "What's still missing here?", {
      workId: anchoredWork.workId,
      userId: leadA,
    });
    expect(interpretation).toMatchObject({
      route: "fast_read",
      request: { intent: "closing_readiness", dealId },
      resolution: { status: "resolved", matchedBy: "work", dealId },
    });

    const assembled = await assembleOperatingContext(
      { tenantId: tenantA, userId: leadA, employeeId: leadA, role: "owner" },
      {
        instruction: "What's still missing here?",
        workId: anchoredWork.workId,
        includeMemory: false,
        includeCanonicalBusinessState: true,
      },
    );
    expect(assembled.context.tenant.vertical?.verticalKey).toBe("private_equity");
    expect(assembled.context.referencedEntities).toEqual(expect.arrayContaining([
      { entityType: "pe_deal", entityId: dealId },
      { entityType: "pe_workstream", entityId: financingWorkstreamId },
      { entityType: "pe_closing_condition", entityId: financingConditionId },
    ]));
    expect(assembled.context.canonicalSummaries.map((summary) => summary.name)).toEqual(["deal_context", "closing_readiness"]);
    expect(assembled.context.epistemicWarnings?.length).toBeGreaterThan(0);

    let plannerCalls = 0;
    const orchestrator = new FinnorOrchestrator({
      planner: { async plan() { plannerCalls += 1; throw new Error("PE informational question reached the planner"); } },
      executor: {} as never,
    });
    const result = await orchestrator.handleInstructionResult(
      "What's still missing here?",
      { tenantId: tenantA, userId: "system:pe3-query", role: "owner" },
      { workId: anchoredWork.workId, idempotencyKey: `pe3-question-${randomUUID()}` },
    );
    expect(plannerCalls).toBe(0);
    expect(result.query?.request).toEqual({ intent: "closing_readiness", dealId });
    expect(result.answer?.spokenSummary).toMatch(/not ready to close.*2 blocking conditions remain/i);
  }, 30_000);

  it("fails closed across tenants and the retired vertical while preserving shared Core query registration", async () => {
    await expect(executeTenantOperationalQuery(tenantB, { intent: "deal_context", dealId }, { now: AS_OF }))
      .rejects.toThrow(/not found|authenticated tenant/i);
    await expect(recordPrivateEquityDocumentClaim(ctxB, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
      documentId: foreignDocument,
      predicate: "closing_condition.state",
      value: "satisfied",
    })).rejects.toThrow(/authenticated Deal|not part/i);
    await expect(recordPrivateEquitySourceObservation(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
      integrationId: foreignIntegration,
      provider: "synthetic_foreign",
      sourceScope: "foreign",
      externalObjectType: "condition",
      externalId: "FOREIGN-CONDITION",
      claims: [{
        entity: { entityType: "pe_closing_condition", entityId: financingConditionId },
        predicate: "closing_condition.state",
        value: "satisfied",
      }],
      observedAt: AS_OF.toISOString(),
    })).rejects.toThrow(/integration|tenant/i);

    expect(operationalQueryIntentsForVertical("private_equity")).toEqual(expect.arrayContaining([
      "work_list", "agent_activity", "company_context", "party_lookup", "party_context", "team_roster",
      "deal_context", "deal_workstreams", "open_requests", "open_findings", "open_deal_risks", "critical_dependencies", "closing_readiness",
    ]));
    expect(operationalQueryIntentsForVertical("private_equity")).not.toEqual(expect.arrayContaining([
      "customer_lookup", "customer_cohort", "schedule_range", "inventory_status", "business_state", "party_availability",
    ]));
    expect(() => operationalQueryIntentsForVertical("water")).toThrow(/retired.*unavailable/i);
    await expect(executeTenantOperationalQuery(retirementBoundaryTenant, { intent: "deal_context", dealId }, { now: AS_OF }))
      .rejects.toThrow(/not found|authenticated tenant|vertical identity is missing/i);
  });
});
