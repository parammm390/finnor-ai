import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import {
  PE_ENTITY_TYPES,
  closedWorldClaimPermitted,
  createDeal,
  createDebtFacility,
  createFund,
  createMetricSeries,
  createPortfolioHolding,
  createSecurity,
  createVehicle,
  declareDealClosed,
  linkDebtFacilityLender,
  linkFundVehicle,
  loadCompanyBrainProjection,
  loadPrivateEquityWorldState,
  recordCompanyHierarchy,
  recordFactCoverage,
  recordIdentityResolution,
  recordMetricObservation,
  recordOwnershipInterest,
  recordExit,
  resolveIdentityAsKnown,
  restateMetricObservation,
  reviseFactCoverage,
  type PeMutationContext,
} from "@finnor/private-equity";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const databaseAvailable = await canConnect(SUPER_URL);
const SCOPE4_ENTITY_TYPES = [
  "pe_fund", "pe_vehicle", "pe_fund_vehicle_link", "pe_strategy_mandate", "pe_portfolio_holding",
  "pe_company_hierarchy", "pe_company_party_role", "pe_security", "pe_debt_facility",
  "pe_debt_facility_lender", "pe_ownership_interest", "pe_benchmark", "pe_metric_series",
  "pe_metric_observation", "pe_benchmark_observation", "pe_outcome", "pe_exit", "pe_fact_coverage",
] as const;

describe.skipIf(!databaseAvailable)("Scope 4 institutional PE Digital Twin", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const actorA = randomUUID();
  const actorB = randomUUID();
  const targetA = randomUUID();
  const parentA = randomUUID();
  const lenderA = randomUUID();
  const buyerA = randomUUID();
  const targetB = randomUUID();
  const loi = randomUUID();
  const evidenceSource = randomUUID();
  const evidenceVersion = randomUUID();
  const integration = randomUUID();
  const sourceLink = randomUUID();
  const sourceLinkRace = randomUUID();
  const sourceLinkAmbiguous = randomUUID();
  const evidence = { evidenceSourceId: evidenceSource, evidenceVersionId: evidenceVersion };
  const validFrom = new Date("2026-01-01T00:00:00.000Z");
  const ctxA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: actorA, employeeId: actorA, role: "owner" },
    provenance: { sourceSystem: "integration:scope4", createdBy: actorA, observedAt: new Date("2026-09-01T00:00:00.000Z") },
  };

  let admin: pg.Client;
  let fundId: string;
  let vehicleId: string;
  let holdingId: string;
  let closedDealId: string;
  let activeDealId: string;

  async function knowledgeBoundary(pauseBeforeNextWrite = false): Promise<Date> {
    const at = (await admin.query<{ at: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond' AS at",
    )).rows[0]!.at;
    if (pauseBeforeNextWrite) await new Promise((resolve) => setTimeout(resolve, 5));
    return at;
  }

  async function allowedProof(resourceId: string) {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO finnor_os.authority_decisions
        (id,tenant_id,employee_id,authority_revision,operation,capability,resource_type,resource_id,risk,outcome,reason_code,evidence)
       VALUES ($1,$2,$3,coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$2),1),
        'action','private_equity:close_deal','pe_deal',$4,'high','allowed','scope4_certified','{}')`,
      [id, tenantA, actorA, resourceId],
    );
    return { authorityDecisionId: id };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
        ($1,$2,'Scope 4 PE project'),($3,$4,'Scope 4 foreign project')`,
      [tenantA, `scope4-a-${randomUUID()}`, tenantB, `scope4-b-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
        ($1,$2,$3,'owner','active','Scope 4 owner'),($4,$5,$6,'owner','active','Foreign owner')`,
      [actorA, tenantA, `scope4-a-${randomUUID()}@test.invalid`, actorB, tenantB, `scope4-b-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
        ($1,$6,'scope4-target','Scope 4 Target','other'),
        ($2,$6,'scope4-parent','Scope 4 Parent','other'),
        ($3,$6,'scope4-lender','Scope 4 Lender','partner'),
        ($4,$6,'scope4-buyer','Scope 4 Buyer','other'),
        ($5,$7,'scope4-foreign','Scope 4 Foreign','other')`,
      [targetA, parentA, lenderA, buyerA, targetB, tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by)
       VALUES ($1,$2,'loi','Scope 4 signed LOI','integration:scope4',$3)`,
      [loi, tenantA, actorA],
    );
    await admin.query(
      `INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title)
       VALUES ($1,'tenant',$2,'scope4-observed-facts','document','Scope 4 observed facts')`,
      [evidenceSource, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.evidence_source_versions
        (id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at)
       VALUES ($1,$2,'tenant',$3,1,$4,'Scope 4 observed facts','{}',$5,$5)`,
      [evidenceVersion, evidenceSource, tenantA, "a".repeat(64), validFrom],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode)
       VALUES ($1,$2,'private_equity_source','scope4-registry','emulator')`,
      [integration, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_refs
        (id,tenant_id,entity,internal_id,provider,external_id,integration_id,external_object_type,
         mapping_status,observed_hash,observed_state,conflict_state)
       VALUES ($1,$2,'external_organization',$3,'scope4_registry','legacy-target',$6,'company',
        'mapped',$7,'{}','none'),
        ($4,$2,'external_organization',$8,'scope4_registry','race-target',$6,'company',
        'mapped',$7,'{}','none'),
        ($5,$2,'external_organization',$9,'scope4_registry','ambiguous-target',$6,'company',
        'mapped',$7,'{}','none')`,
      [sourceLink, tenantA, parentA, sourceLinkRace, sourceLinkAmbiguous, integration, "b".repeat(64), lenderA, buyerA],
    );

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorA, sourceSystem: "integration:scope4" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorB, sourceSystem: "integration:scope4" });

    fundId = String((await createFund(ctxA, { name: "Scope 4 Fund I", vintageYear: 2025, baseCurrency: "USD" })).row.id);
    vehicleId = String((await createVehicle(ctxA, { name: "Scope 4 Main Vehicle", vehicleType: "main", jurisdiction: "DE" })).row.id);
    await linkFundVehicle(ctxA, { fundId, vehicleId, relationshipKind: "master", validFrom, completeness: "complete", evidence });

    const closedDeal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Scope 4 acquisition", codeName: "S4",
      dealLeadEmployeeId: actorA, signedLoiAt: new Date("2026-08-01T00:00:00.000Z"), signedLoiDocumentId: loi,
      targetClosingAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    closedDealId = String(closedDeal.row.id);
    const closed = await declareDealClosed(ctxA, { dealId: closedDealId, governance: await allowedProof(closedDealId) });
    const entryDate = String(closed.row.actualCloseAt).slice(0, 10);
    holdingId = String((await createPortfolioHolding(ctxA, {
      fundId, companyId: targetA, originDealId: closedDealId, entryDate, completeness: "complete", evidence,
    })).row.id);

    activeDealId = String((await createDeal(ctxA, {
      targetOrganizationId: parentA, name: "Unclosed transaction", codeName: "OPEN",
      dealLeadEmployeeId: actorA, signedLoiAt: new Date("2026-08-10T00:00:00.000Z"), signedLoiDocumentId: loi,
      targetClosingAt: new Date("2026-12-01T00:00:00.000Z"),
    })).row.id);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("registers one canonical owner per new type with forced tenant isolation and append-only history", async () => {
    const registry = await admin.query<{ entity_type: string; writable_owner: string; source_table: string }>(
      `SELECT entity_type,writable_owner,source_table FROM finnor_os.canonical_truth_registry
       WHERE vertical_key='private_equity' AND entity_type=ANY($1::text[])`,
      [[...PE_ENTITY_TYPES]],
    );
    expect(registry.rows).toHaveLength(PE_ENTITY_TYPES.length);
    expect(registry.rows.every((row) => row.writable_owner === "@finnor/private-equity")).toBe(true);
    const scope4Registry = registry.rows.filter((row) => SCOPE4_ENTITY_TYPES.includes(row.entity_type as (typeof SCOPE4_ENTITY_TYPES)[number]));
    expect(scope4Registry).toHaveLength(SCOPE4_ENTITY_TYPES.length);
    expect(new Set(scope4Registry.map((row) => row.source_table)).size).toBe(SCOPE4_ENTITY_TYPES.length);

    const controls = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number; history: number }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='finnor_os' AND p.tablename=c.relname AND p.policyname='tenant_isolation') policies,
        (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgname='canonical_history') history
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[])`,
      [scope4Registry.map((row) => row.source_table)],
    );
    expect(controls.rows).toHaveLength(18);
    expect(controls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1 && row.history === 1)).toBe(true);
    await expect(admin.query("DELETE FROM finnor_os.pe_funds WHERE id=$1", [fundId])).rejects.toThrow(/cannot be deleted/i);
  });

  it("requires verified Deal close lineage and preserves exact Fund, Vehicle, Company, and Deal identities", async () => {
    await expect(createPortfolioHolding(ctxA, {
      vehicleId, companyId: parentA, originDealId: activeDealId, entryDate: "2026-09-01", evidence,
    })).rejects.toThrow(/verified closed Deal/i);
    const row = (await admin.query(
      `SELECT h.fund_id::text,h.vehicle_id::text,h.company_id::text,h.origin_deal_id::text,d.target_organization_id::text
       FROM finnor_os.pe_portfolio_holdings h JOIN finnor_os.pe_deals d ON d.tenant_id=h.tenant_id AND d.id=h.origin_deal_id
       WHERE h.id=$1`,
      [holdingId],
    )).rows[0];
    expect(row).toMatchObject({ fund_id: fundId, vehicle_id: null, company_id: targetA, origin_deal_id: closedDealId, target_organization_id: targetA });
  });

  it("enforces tenant boundaries, hierarchy acyclicity, and concurrent temporal exclusivity", async () => {
    await expect(recordOwnershipInterest(ctxA, {
      ownerType: "external_organization", ownerId: targetB, subjectType: "external_organization", subjectId: targetA,
      economicPercentage: "10", completeness: "complete", validFrom, evidence,
    })).rejects.toThrow(/tenant boundary|missing identity/i);

    await recordCompanyHierarchy(ctxA, {
      parentCompanyId: parentA, childCompanyId: targetA, relationshipKind: "parent_subsidiary",
      validFrom, completeness: "complete", evidence,
    });
    await expect(recordCompanyHierarchy(ctxA, {
      parentCompanyId: targetA, childCompanyId: parentA, relationshipKind: "parent_subsidiary",
      validFrom, completeness: "complete", evidence,
    })).rejects.toThrow(/cycle/i);

    const concurrent = await Promise.allSettled([1, 2].map(() => recordOwnershipInterest(ctxA, {
      ownerType: "pe_fund", ownerId: fundId, subjectType: "external_organization", subjectId: targetA,
      ownershipClass: "common", economicPercentage: "0.6", completeness: "complete", validFrom, evidence,
    })));
    if (concurrent.every((result) => result.status === "rejected")) {
      throw new Error(`Both concurrent ownership writes failed: ${concurrent.map((result) => result.status === "rejected" ? String(result.reason) : "fulfilled").join(" | ")}`);
    }
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("never turns partial observations into closed-world totals and preserves corrected coverage history", async () => {
    const partial = await recordFactCoverage(ctxA, {
      subjectType: "external_organization", subjectId: targetA, proposition: "ownership_total",
      coverageStatus: "partial", validFrom, evidence,
    });
    const partialKnowledge = await knowledgeBoundary(true);
    expect((await closedWorldClaimPermitted(ctxA, {
      subjectType: "external_organization", subjectId: targetA, proposition: "ownership_total",
      validAt: new Date("2026-09-01T00:00:00.000Z"), knowledgeAt: partialKnowledge,
    })).permitted).toBe(false);
    const partialProjection = await loadCompanyBrainProjection(ctxA, {
      root: { entityType: "external_organization", entityId: targetA },
      validAt: "2026-09-01T00:00:00.000Z", knowledgeAt: partialKnowledge.toISOString(),
    });
    expect(partialProjection.capitalStructures.find((row) => row.companyId === targetA)).toMatchObject({
      ownershipCompleteness: "partial", observedEconomicPercentageTotal: null,
    });

    await reviseFactCoverage(ctxA, { priorCoverageId: String(partial.row.id), expectedVersion: 1, coverageStatus: "complete", evidence });
    const completeKnowledge = await knowledgeBoundary();
    expect((await closedWorldClaimPermitted(ctxA, {
      subjectType: "external_organization", subjectId: targetA, proposition: "ownership_total",
      validAt: new Date("2026-09-01T00:00:00.000Z"), knowledgeAt: partialKnowledge,
    })).permitted).toBe(false);
    expect((await closedWorldClaimPermitted(ctxA, {
      subjectType: "external_organization", subjectId: targetA, proposition: "ownership_total",
      validAt: new Date("2026-09-01T00:00:00.000Z"), knowledgeAt: completeKnowledge,
    })).permitted).toBe(true);
    const completeProjection = await loadCompanyBrainProjection(ctxA, {
      root: { entityType: "external_organization", entityId: targetA },
      validAt: "2026-09-01T00:00:00.000Z", knowledgeAt: completeKnowledge.toISOString(),
    });
    expect(completeProjection.capitalStructures.find((row) => row.companyId === targetA)).toMatchObject({
      ownershipCompleteness: "complete", observedEconomicPercentageTotal: "0.6",
    });
  });

  it("projects observed capital, immutable metric restatements, and as-known identity corrections", async () => {
    const securityId = String((await createSecurity(ctxA, {
      issuerCompanyId: targetA, securityKey: "COMMON", securityType: "common_equity", name: "Common Equity",
      validFrom, completeness: "complete", evidence,
    })).row.id);
    const facilityId = String((await createDebtFacility(ctxA, {
      borrowerCompanyId: targetA, facilityKey: "TL-A", name: "Term Loan A", facilityType: "term_loan",
      committedAmount: "125000000", currencyCode: "USD", validFrom, completeness: "complete", evidence,
    })).row.id);
    await linkDebtFacilityLender(ctxA, {
      debtFacilityId: facilityId, lenderPartyType: "external_organization", lenderPartyId: lenderA, lenderRole: "agent",
      commitmentAmount: "125000000", currencyCode: "USD", validFrom, completeness: "complete", evidence,
    });
    const lenderRace = await Promise.allSettled([1, 2].map(() => linkDebtFacilityLender(ctxA, {
      debtFacilityId: facilityId, lenderPartyType: "external_organization", lenderPartyId: lenderA, lenderRole: "lender",
      commitmentAmount: "25000000", currencyCode: "USD", validFrom, completeness: "complete", evidence,
    })));
    expect(lenderRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(lenderRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    const seriesId = String((await createMetricSeries(ctxA, {
      subjectType: "external_organization", subjectId: targetA, metricKey: "revenue", name: "Revenue", unit: "currency",
      currencyCode: "USD", frequency: "annual",
    })).row.id);
    const observation = await recordMetricObservation(ctxA, {
      metricSeriesId: seriesId, periodStart: new Date("2025-01-01T00:00:00.000Z"), periodEnd: new Date("2025-12-31T23:59:59.000Z"),
      value: { type: "number", value: "100000000" }, evidence,
    });
    const beforeRestatement = await knowledgeBoundary(true);
    await restateMetricObservation(ctxA, {
      priorObservationId: String(observation.row.id), expectedVersion: 1,
      replacement: { value: { type: "number", value: "105000000" }, evidence },
    });
    const afterRestatement = await knowledgeBoundary();
    const metricHistory = await admin.query<{ revision: number; value: unknown; recorded_at: Date }>(
      `SELECT (snapshot->>'revision')::int revision,snapshot->>'value_numeric' value,recorded_at
         FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND entity_type='pe_metric_observation' ORDER BY recorded_at,entity_version`,
      [tenantA],
    );
    if (!metricHistory.rows.some((row) => row.revision === 2)) {
      throw new Error(`Metric correction was not captured in canonical history: ${JSON.stringify(metricHistory.rows)}`);
    }
    const oldWorld = await loadPrivateEquityWorldState(ctxA, { entityType: "external_organization", entityId: targetA }, {
      validAt: new Date("2025-12-31T23:59:59.000Z"), knowledgeAt: beforeRestatement,
    });
    const newWorld = await loadPrivateEquityWorldState(ctxA, { entityType: "external_organization", entityId: targetA }, {
      validAt: new Date("2025-12-31T23:59:59.000Z"), knowledgeAt: afterRestatement,
    });
    expect(oldWorld.metricObservations.map((row) => Number(row.valueNumeric))).toContain(100000000);
    const revisedMetricValues = newWorld.metricObservations.map((row) => Number(row.valueNumeric));
    if (!revisedMetricValues.includes(105000000)) {
      throw new Error(`Expected corrected metric in as-known world; history=${JSON.stringify(metricHistory.rows)} world=${JSON.stringify(newWorld.metricObservations)}`);
    }
    const currentWorld = await loadPrivateEquityWorldState(ctxA, { entityType: "external_organization", entityId: targetA }, {
      validAt: new Date("2026-09-01T00:00:00.000Z"), knowledgeAt: afterRestatement,
    });
    expect(currentWorld.securities.map((row) => row.id)).toContain(securityId);
    expect(currentWorld.debtFacilities.map((row) => row.id)).toContain(facilityId);
    expect(currentWorld.debtFacilityLenders.some((row) => row.lenderPartyId === lenderA)).toBe(true);

    const raceObservation = await recordMetricObservation(ctxA, {
      metricSeriesId: seriesId, periodStart: new Date("2024-01-01T00:00:00.000Z"), periodEnd: new Date("2024-12-31T23:59:59.000Z"),
      value: { type: "number", value: "90000000" }, evidence,
    });
    const metricRace = await Promise.allSettled(["91000000", "92000000"].map((value) => restateMetricObservation(ctxA, {
      priorObservationId: String(raceObservation.row.id), expectedVersion: 1,
      replacement: { value: { type: "number", value }, evidence },
    })));
    expect(metricRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(metricRace.filter((result) => result.status === "rejected")).toHaveLength(1);

    await recordIdentityResolution(ctxA, {
      decisionId: "scope4-correction-1", sourceLinkId: sourceLink, expectedObservedHash: "b".repeat(64), kind: "correction",
      fromRefs: [{ entityType: "external_organization", entityId: parentA }],
      toRefs: [{ entityType: "external_organization", entityId: targetA }],
      decision: "Registry identifier belongs to the acquired company", validFrom,
      authority: { actorId: actorA, method: "reviewed_source" }, evidence,
    });
    const resolutionKnowledge = await knowledgeBoundary();
    const known = await resolveIdentityAsKnown(ctxA, { sourceLinkId: sourceLink, validAt: new Date("2026-09-01T00:00:00.000Z"), knowledgeAt: resolutionKnowledge });
    expect(known).toMatchObject({ resolutionKind: "correction", canonicalEntityType: "external_organization", canonicalEntityId: targetA });
    await expect(recordIdentityResolution(ctxA, {
      decisionId: "scope4-stale-correction", sourceLinkId: sourceLink, expectedObservedHash: "b".repeat(64), kind: "correction",
      fromRefs: [{ entityType: "external_organization", entityId: targetA }],
      toRefs: [{ entityType: "external_organization", entityId: parentA }], decision: "stale write", validFrom,
      authority: { actorId: actorA }, evidence,
    })).rejects.toThrow(/changed since/i);

    const ambiguous = await recordIdentityResolution(ctxA, {
      decisionId: "scope4-split-ambiguous", sourceLinkId: sourceLinkAmbiguous, expectedObservedHash: "b".repeat(64), kind: "split",
      fromRefs: [{ entityType: "external_organization", entityId: buyerA }],
      toRefs: [
        { entityType: "external_organization", entityId: targetA },
        { entityType: "external_organization", entityId: buyerA },
      ],
      decision: "One provider record may refer to either reviewed canonical company; no merge is authorized",
      validFrom, authority: { actorId: actorA, method: "manual_review" }, evidence,
    });
    expect(ambiguous.sourceLink).toMatchObject({ mappingStatus: "ambiguous", internalId: null, conflictState: "ambiguous" });
    expect(ambiguous.sourceLink.candidateCanonicalIds).toEqual(expect.arrayContaining([targetA, buyerA]));

    const identityRace = await Promise.allSettled([
      { id: "scope4-race-a", target: targetA },
      { id: "scope4-race-b", target: buyerA },
    ].map(({ id, target }) => recordIdentityResolution(ctxA, {
      decisionId: id, sourceLinkId: sourceLinkRace, expectedObservedHash: "b".repeat(64), kind: "correction",
      fromRefs: [{ entityType: "external_organization", entityId: lenderA }],
      toRefs: [{ entityType: "external_organization", entityId: target }], decision: `Concurrent reviewed correction ${id}`,
      validFrom, authority: { actorId: actorA, method: "reviewed_source" }, evidence,
    })));
    expect(identityRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(identityRace.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("preserves Deal to Holding to Exit lineage and does not replace canonical Company identity", async () => {
    const exit = await recordExit(ctxA, {
      portfolioHoldingId: holdingId, expectedHoldingVersion: 1, exitType: "strategic_sale", buyerCompanyId: buyerA,
      status: "closed", closedAt: new Date("2027-09-20T12:00:00.000Z"), grossProceeds: "175000000",
      currencyCode: "USD", observedAt: new Date("2027-09-20T13:00:00.000Z"), evidence,
    });
    const lineage = (await admin.query(
      `SELECT h.origin_deal_id::text,h.company_id::text,x.portfolio_holding_id::text,x.buyer_company_id::text,
              h.holding_status,h.exit_date::text
         FROM finnor_os.pe_exits x JOIN finnor_os.pe_portfolio_holdings h ON h.tenant_id=x.tenant_id AND h.id=x.portfolio_holding_id
        WHERE x.id=$1`,
      [exit.row.id],
    )).rows[0];
    expect(lineage).toMatchObject({ origin_deal_id: closedDealId, company_id: targetA, portfolio_holding_id: holdingId, buyer_company_id: buyerA, holding_status: "exited", exit_date: "2027-09-20" });
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2", [tenantA, targetA])).rows[0]?.count).toBe(1);
  });
});
