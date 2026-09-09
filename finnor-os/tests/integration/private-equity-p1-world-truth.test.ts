import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import {
  PE_ENTITY_TYPES,
  PeDomainError,
  activateInvestmentCase,
  attachWorkToWorldEntity,
  attachCanonicalDocument,
  attachCanonicalDocumentToWorld,
  attachCanonicalEvidence,
  attachCanonicalEvidenceToWorld,
  createAssumption,
  createDeal,
  createInvestmentCase,
  createOpportunity,
  createStrategy,
  createThesis,
  createWorkstream,
  executePrivateEquityOperationalQuery,
  finalizeDecision,
  linkDecisionEffects,
  loadPrivateEquityWorldState,
  promoteOpportunityToDeal,
  recordDecision,
  recordPrivateEquitySourceObservation,
  reviseAssumption,
  supersedeDecision,
  transitionOpportunity,
  transitionStrategy,
  transitionThesis,
  type PeMutationContext,
  type PeWorldRootRef,
} from "@finnor/private-equity";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function tenantQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  userId: string,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path=finnor_os,public");
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
      [tenantId, userId],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const databaseAvailable = await canConnect(SUPER_URL);

describe.skipIf(!databaseAvailable)("P1 canonical PE world and temporal truth", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const targetA = randomUUID();
  const targetDirect = randomUUID();
  const targetB = randomUUID();
  const documentStrategy = randomUUID();
  const documentDeal = randomUUID();
  const documentB = randomUUID();
  const evidenceEligible = randomUUID();
  const evidenceEligibleVersion = randomUUID();
  const evidenceHindsight = randomUUID();
  const evidenceHindsightVersion = randomUUID();
  const evidenceDeal = randomUUID();
  const evidenceDealVersion = randomUUID();
  const integrationA = randomUUID();
  const workId = randomUUID();
  const collisionWorkId = randomUUID();
  const actionId = randomUUID();
  const receiptId = randomUUID();
  const ctxA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: ownerA, employeeId: ownerA, role: "owner" },
    provenance: { sourceSystem: "integration:p1", createdBy: ownerA },
  };
  const ctxB: PeMutationContext = {
    auth: { tenantId: tenantB, userId: ownerB, employeeId: ownerB, role: "owner" },
    provenance: { sourceSystem: "integration:p1", createdBy: ownerB },
  };

  let admin: pg.Client;
  let baselineAt: Date;
  let strategyId = "";
  let strategyDraftAt: Date;
  let strategyActiveAt: Date;
  let opportunityId = "";
  let promotedDealId = "";
  let directDealId = "";
  let investmentCaseId = "";
  let thesisId = "";
  let assumptionId = "";
  let revisedAssumptionId = "";
  let finalDecisionId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
        ($1,$2,'P1 PE project A'),($3,$4,'P1 PE project B')`,
      [tenantA, `p1-a-${randomUUID()}`, tenantB, `p1-b-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
        ($1,$2,$3,'owner','active','P1 Owner A'),($4,$5,$6,'owner','active','P1 Owner B')`,
      [ownerA, tenantA, `p1-a-${randomUUID()}@test.invalid`, ownerB, tenantB, `p1-b-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
        ($1,$4,'p1-target-a','P1 Target A','other'),
        ($2,$4,'p1-target-direct','P1 Direct Target','other'),
        ($3,$5,'p1-target-b','P1 Target B','other')`,
      [targetA, targetDirect, targetB, tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES
        ($1,$4,'strategy','P1 Strategy Source','integration:p1',$5),
        ($2,$4,'loi','P1 Direct Deal LOI','integration:p1',$5),
        ($3,$6,'foreign','P1 Foreign Document','integration:p1',$7)`,
      [documentStrategy, documentDeal, documentB, tenantA, ownerA, tenantB, ownerB],
    );
    await admin.query(
      `INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES
        ($1,'tenant',$4,'p1-eligible','pe_provider_observation','P1 eligible evidence'),
        ($2,'tenant',$4,'p1-hindsight','pe_provider_observation','P1 future-retrieved evidence'),
        ($3,'tenant',$4,'p1-deal-evidence','document','P1 Deal evidence')`,
      [evidenceEligible, evidenceHindsight, evidenceDeal, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode)
       VALUES ($1,$2,'private_equity_source','p1_vdr','emulator')`,
      [integrationA, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,idempotency_key)
       VALUES
        ($1,$3,'received','console','Implement the semantic PE decision',$4,$5),
        ($2,$3,'received','console','Same UUID cross-type isolation probe',$4,$6)`,
      [workId, collisionWorkId, tenantA, ownerA, `p1-work-${workId}`, `p1-work-${collisionWorkId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,status,summary,initiated_by)
       VALUES ($1,$2,'private_equity:record_decision','completed','P1 governed effect',$3)`,
      [actionId, tenantA, ownerA],
    );
    await admin.query(
      `INSERT INTO finnor_os.decision_receipts(
        id,tenant_id,domain_action_id,objective,evidence,policy_applied,risk_tier,
        proposed_action,approval,actual_result,finalized_at
       ) VALUES ($1,$2,$3,'Record P1 semantic decision','[]','{}','medium','{}','{}','{}',now())`,
      [receiptId, tenantA, actionId],
    );

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({
      tenantId: tenantA,
      verticalKey: "private_equity",
      expectedVersion: 0,
      createdBy: ownerA,
      sourceSystem: "integration:p1",
    });
    await configureTenantVertical({
      tenantId: tenantB,
      verticalKey: "private_equity",
      expectedVersion: 0,
      createdBy: ownerB,
      sourceSystem: "integration:p1",
    });
    baselineAt = (await admin.query<{ at: Date }>(
      "SELECT min(coverage_started_at) at FROM finnor_os.canonical_history_coverage WHERE vertical_key='private_equity'",
    )).rows[0]!.at;
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("registers exactly the six P1 owners while retaining all existing PE owners", async () => {
    const rows = await admin.query<{ entity_type: string; source_table: string; writable_owner: string }>(
      `SELECT entity_type,source_table,writable_owner FROM finnor_os.canonical_truth_registry
        WHERE vertical_key='private_equity' AND active ORDER BY entity_type`,
    );
    expect(rows.rows.map((row) => row.entity_type).sort()).toEqual([...PE_ENTITY_TYPES].sort());
    const expected = [
      "pe_assumption", "pe_decision", "pe_investment_case", "pe_opportunity", "pe_strategy", "pe_thesis",
    ];
    expect(rows.rows.filter((row) => expected.includes(row.entity_type)).map((row) => row.entity_type).sort()).toEqual(expected);
    expect(rows.rows.filter((row) => expected.includes(row.entity_type)).every(
      (row) => row.writable_owner === "@finnor/private-equity",
    )).toBe(true);
    const rls = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p
          WHERE p.schemaname='finnor_os' AND p.tablename=c.relname AND p.policyname='tenant_isolation') policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[])`,
      [["pe_strategies", "pe_opportunities", "pe_investment_cases", "pe_theses", "pe_assumptions", "pe_decisions", "pe_decision_effect_links"]],
    );
    expect(rls.rows).toHaveLength(7);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1)).toBe(true);
    await expect(admin.query(
      `INSERT INTO finnor_os.canonical_truth_registry(entity_type,source_table,writable_owner,mutation_boundary)
       VALUES ('pe_strategy','pe_strategies','duplicate','duplicate')`,
    )).rejects.toMatchObject({ code: "23505" });
    await admin.query("BEGIN");
    try {
      await admin.query("DELETE FROM finnor_os.canonical_truth_registry WHERE entity_type='pe_strategy'");
      expect((await admin.query<{ available: boolean }>(
        "SELECT finnor_os.canonical_entity_available($1,'pe_strategy') available",
        [tenantA],
      )).rows[0]?.available).toBe(false);
      await expect(admin.query(
        "SELECT finnor_os.canonical_entity_tenant('pe_strategy',$1::uuid)",
        [randomUUID()],
      )).rejects.toThrow(/unsupported canonical entity type/i);
    } finally {
      await admin.query("ROLLBACK");
    }
    await expect(admin.query(
      "SELECT finnor_os.canonical_entity_tenant('pe_unsupported',$1::uuid)",
      [randomUUID()],
    )).rejects.toThrow(/unsupported canonical entity type/i);
  });

  it("creates and transitions Strategy and Opportunity with historical replay", async () => {
    const strategy = await createStrategy(ctxA, {
      name: "Control software buyout strategy",
      description: "Acquire durable vertical software businesses",
      investmentCriteria: { geography: "North America", control: true },
    });
    strategyId = String(strategy.row.id);
    await admin.query("SELECT pg_sleep(0.01)");
    strategyDraftAt = (await admin.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at;
    await admin.query("SELECT pg_sleep(0.01)");
    const active = await transitionStrategy(ctxA, { strategyId, expectedVersion: 1, targetState: "active" });
    expect(active.row).toMatchObject({ state: "active", version: 2 });
    await expect(transitionStrategy(ctxA, { strategyId, expectedVersion: 1, targetState: "retired" }))
      .rejects.toMatchObject({ code: "PE_STALE_VERSION" });
    await admin.query("SELECT pg_sleep(0.01)");
    strategyActiveAt = (await admin.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at;

    const opportunity = await createOpportunity(ctxA, {
      strategyId,
      targetOrganizationId: targetA,
      name: "P1 Target opportunity",
    });
    opportunityId = String(opportunity.row.id);
    expect(opportunity.row).toMatchObject({ state: "identified", strategyId, targetOrganizationId: targetA });
    const screening = await transitionOpportunity(ctxA, {
      opportunityId,
      expectedVersion: 1,
      targetState: "screening",
    });
    const qualified = await transitionOpportunity(ctxA, {
      opportunityId,
      expectedVersion: Number(screening.row.version),
      targetState: "qualified",
    });
    expect(qualified.row).toMatchObject({ state: "qualified", version: 3 });

    const rejected = await createOpportunity(ctxA, {
      strategyId,
      targetOrganizationId: targetDirect,
      name: "Rejected P1 opportunity",
    });
    const rejectedId = String(rejected.row.id);
    await transitionOpportunity(ctxA, {
      opportunityId: rejectedId,
      expectedVersion: 1,
      targetState: "rejected",
      rejectionReason: "Outside mandate",
    });
    await expect(promoteOpportunityToDeal(ctxA, {
      opportunityId: rejectedId,
      expectedVersion: 2,
      deal: {
        name: "Must not exist",
        dealLeadEmployeeId: ownerA,
        signedLoiAt: new Date(),
        targetClosingAt: new Date(Date.now() + 86_400_000),
      },
    })).rejects.toMatchObject({ code: "PE_INVALID_TRANSITION" });

    await expect(createOpportunity(ctxA, {
      strategyId,
      targetOrganizationId: targetB,
      name: "Cross-tenant target",
    })).rejects.toBeTruthy();

    const before = await loadPrivateEquityWorldState(ctxA, { entityType: "pe_strategy", entityId: strategyId }, strategyDraftAt);
    const after = await loadPrivateEquityWorldState(ctxA, { entityType: "pe_strategy", entityId: strategyId }, strategyActiveAt);
    expect(before.strategy).toMatchObject({ state: "draft", version: 1 });
    expect(after.strategy).toMatchObject({ state: "active", version: 2 });
    expect(after.opportunities).toEqual([]);
    expect((await loadPrivateEquityWorldState(
      ctxA,
      { entityType: "pe_strategy", entityId: strategyId },
    )).opportunities.map((row) => row.id)).toContain(opportunityId);
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='pe_strategy' AND entity_id=$2",
      [tenantA, strategyId],
    )).rows[0]?.count).toBe(2);
    const eventTypes = (await admin.query<{ event_type: string }>(
      `SELECT event_type FROM finnor_os.business_events
        WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[]) ORDER BY occurred_at,id`,
      [tenantA, [strategyId, opportunityId]],
    )).rows.map((row) => row.event_type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "pe_strategy_created", "pe_strategy_active", "pe_opportunity_created",
      "pe_opportunity_screening", "pe_opportunity_qualified",
    ]));
  });

  it("supports pre-Deal Documents, Evidence, and Source Truth without fake Deal ids", async () => {
    const strategyRoot: PeWorldRootRef = { entityType: "pe_strategy", entityId: strategyId };
    const opportunityRoot: PeWorldRootRef = { entityType: "pe_opportunity", entityId: opportunityId };
    const documentLink = await attachCanonicalDocumentToWorld(ctxA, {
      worldRoot: strategyRoot,
      entity: { entityType: "pe_strategy", entityId: strategyId },
      documentId: documentStrategy,
      linkRole: "source",
    });
    expect(documentLink.row).toMatchObject({ dealId: null, worldRootType: "pe_strategy", worldRootId: strategyId });
    await attachWorkToWorldEntity(ctxA, {
      workId,
      entity: { entityType: "pe_opportunity", entityId: opportunityId, relationship: "about" },
    });

    const cutoff = new Date(Date.now() + 5_000);
    const eligibleSnapshot = {
      schema: "finnor.pe.observation.v2",
      worldRoot: opportunityRoot,
      entity: { entityType: "pe_opportunity", entityId: opportunityId },
      claims: [{
        propositionId: `pe:v1:pe_opportunity:${opportunityId}:pe_opportunity:${opportunityId}:opportunity.state`,
        predicate: "opportunity.state",
        value: "qualified",
      }],
    };
    await admin.query(
      `INSERT INTO finnor_os.evidence_source_versions(
        id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at
       ) VALUES
        ($1,$2,'tenant',$5,1,$6,'eligible',$7,$8,$9),
        ($3,$4,'tenant',$5,1,$10,'future retrieved',$7,$8,$11)`,
      [
        evidenceEligibleVersion, evidenceEligible, evidenceHindsightVersion, evidenceHindsight, tenantA,
        "a".repeat(64), eligibleSnapshot, new Date(cutoff.getTime() - 60_000),
        new Date(cutoff.getTime() - 30_000), "b".repeat(64), new Date(cutoff.getTime() + 60_000),
      ],
    );
    await attachCanonicalEvidenceToWorld(ctxA, {
      worldRoot: opportunityRoot,
      entity: { entityType: "pe_opportunity", entityId: opportunityId },
      evidenceSourceId: evidenceEligible,
      evidenceVersionId: evidenceEligibleVersion,
      relationship: "supports",
    });
    await attachCanonicalEvidenceToWorld(ctxA, {
      worldRoot: opportunityRoot,
      entity: { entityType: "pe_opportunity", entityId: opportunityId },
      evidenceSourceId: evidenceHindsight,
      evidenceVersionId: evidenceHindsightVersion,
      relationship: "supports",
    });
    const historical = await loadPrivateEquityWorldState(ctxA, opportunityRoot, cutoff);
    expect(historical.evidence.map((row) => row.versionId)).toContain(evidenceEligibleVersion);
    expect(historical.evidence.map((row) => row.versionId)).not.toContain(evidenceHindsightVersion);
    expect(historical.evidence.every((row) => Date.parse(String(row.retrievedAt)) <= cutoff.getTime())).toBe(true);
    expect(historical.workLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ workId, entityType: "pe_opportunity", entityId: opportunityId }),
    ]));

    await expect(attachCanonicalDocumentToWorld(ctxA, {
      worldRoot: strategyRoot,
      entity: { entityType: "pe_opportunity", entityId: opportunityId },
      documentId: documentStrategy,
      linkRole: "source",
    })).rejects.toThrow(/world[- ]root/i);
    await expect(attachCanonicalEvidenceToWorld(ctxA, {
      worldRoot: strategyRoot,
      entity: { entityType: "pe_opportunity", entityId: opportunityId },
      evidenceSourceId: evidenceEligible,
      evidenceVersionId: evidenceEligibleVersion,
      relationship: "supports",
    })).rejects.toThrow(/world[- ]root/i);

    const baseObservation = {
      integrationId: integrationA,
      provider: "p1_vdr",
      sourceScope: "pipeline",
      externalObjectType: "opportunity",
      externalId: "OPP-P1-1",
      worldRoot: opportunityRoot,
      entity: { entityType: "pe_opportunity" as const, entityId: opportunityId },
      claims: [{
        entity: { entityType: "pe_opportunity" as const, entityId: opportunityId },
        predicate: "opportunity.state" as const,
        value: "qualified",
      }],
      observedAt: new Date().toISOString(),
      sourceSequence: "10",
    };
    expect((await recordPrivateEquitySourceObservation(ctxA, baseObservation)).materialization.status).toBe("observed");
    expect((await recordPrivateEquitySourceObservation(ctxA, baseObservation)).materialization.status).toBe("duplicate");
    expect((await recordPrivateEquitySourceObservation(ctxA, {
      ...baseObservation,
      sourceSequence: "9",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    })).materialization.status).toBe("out_of_order");
    expect((await recordPrivateEquitySourceObservation(ctxA, {
      ...baseObservation,
      claims: [{
        entity: { entityType: "pe_opportunity", entityId: opportunityId },
        predicate: "opportunity.state",
        value: "rejected",
      }],
    })).materialization.status).toBe("conflict");
    const conflictAt = (await admin.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at;
    expect((await recordPrivateEquitySourceObservation(ctxA, {
      ...baseObservation,
      sourceSequence: "11",
      observedAt: new Date(Date.now() + 1_000).toISOString(),
      deleted: true,
      claims: [],
    })).materialization.status).toBe("tombstoned");
    expect((await recordPrivateEquitySourceObservation(ctxA, {
      ...baseObservation,
      sourceSequence: "12",
      observedAt: new Date(Date.now() + 2_000).toISOString(),
    })).materialization.status).toBe("observed");
    const historicalConflict = await loadPrivateEquityWorldState(ctxA, opportunityRoot, conflictAt);
    expect(historicalConflict.conflicts.some((row) => row.materializationStatus === "conflict")).toBe(true);
    const ledger = await admin.query<{ materialization_status: string }>(
      `SELECT materialization_status FROM finnor_os.external_ref_observations
        WHERE tenant_id=$1 AND integration_id=$2 ORDER BY received_at,id`,
      [tenantA, integrationA],
    );
    expect(ledger.rows.map((row) => row.materialization_status)).toEqual(
      expect.arrayContaining(["observed", "duplicate", "out_of_order", "conflict", "tombstoned"]),
    );
  });

  it("promotes one qualified Opportunity atomically and keeps direct Deal creation", async () => {
    const historyBefore = Number((await admin.query<{ count: string }>(
      `SELECT count(*) count FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND ((entity_type='pe_opportunity' AND entity_id=$2) OR entity_type='pe_deal')`,
      [tenantA, opportunityId],
    )).rows[0]!.count);
    const promoted = await promoteOpportunityToDeal(ctxA, {
      opportunityId,
      expectedVersion: 3,
      deal: {
        name: "P1 promoted signed-LOI Deal",
        codeName: "World",
        dealLeadEmployeeId: ownerA,
        signedLoiAt: new Date(Date.now() - 86_400_000),
        targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    promotedDealId = String(promoted.deal.id);
    expect(promoted.opportunity).toMatchObject({ state: "promoted", version: 4 });
    expect(promoted.deal).toMatchObject({ opportunityId, targetOrganizationId: targetA, status: "active" });
    const historyAfter = Number((await admin.query<{ count: string }>(
      `SELECT count(*) count FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND ((entity_type='pe_opportunity' AND entity_id=$2) OR entity_type='pe_deal')`,
      [tenantA, opportunityId],
    )).rows[0]!.count);
    expect(historyAfter - historyBefore).toBe(2);
    const replay = await promoteOpportunityToDeal(ctxA, {
      opportunityId,
      expectedVersion: 3,
      deal: {
        name: "Ignored idempotent replay",
        dealLeadEmployeeId: ownerA,
        signedLoiAt: new Date(),
        targetClosingAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(replay).toMatchObject({ changed: false, idempotent: true });
    expect(replay.deal.id).toBe(promotedDealId);
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.pe_deals WHERE opportunity_id=$1",
      [opportunityId],
    )).rows[0]?.count).toBe(1);

    const failingOpportunity = await createOpportunity(ctxA, {
      strategyId,
      targetOrganizationId: targetDirect,
      name: "Atomic rollback opportunity",
    });
    const failingId = String(failingOpportunity.row.id);
    await transitionOpportunity(ctxA, { opportunityId: failingId, expectedVersion: 1, targetState: "screening" });
    await transitionOpportunity(ctxA, { opportunityId: failingId, expectedVersion: 2, targetState: "qualified" });
    const failedHistoryBefore = Number((await admin.query<{ count: string }>(
      "SELECT count(*) count FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1",
      [tenantA],
    )).rows[0]!.count);
    await expect(promoteOpportunityToDeal(ctxA, {
      opportunityId: failingId,
      expectedVersion: 3,
      deal: {
        name: "Must roll back",
        dealLeadEmployeeId: ownerA,
        signedLoiAt: new Date(),
        signedLoiDocumentId: documentB,
        targetClosingAt: new Date(Date.now() + 86_400_000),
      },
    })).rejects.toBeTruthy();
    expect((await admin.query("SELECT state FROM finnor_os.pe_opportunities WHERE id=$1", [failingId])).rows[0]?.state).toBe("qualified");
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.pe_deals WHERE opportunity_id=$1", [failingId])).rows[0]?.count).toBe(0);
    expect(Number((await admin.query<{ count: string }>(
      "SELECT count(*) count FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1",
      [tenantA],
    )).rows[0]!.count)).toBe(failedHistoryBefore);

    const direct = await createDeal(ctxA, {
      targetOrganizationId: targetDirect,
      name: "P1 direct signed-LOI Deal",
      dealLeadEmployeeId: ownerA,
      signedLoiAt: new Date(Date.now() - 86_400_000),
      signedLoiDocumentId: documentDeal,
      targetClosingAt: new Date(Date.now() + 40 * 86_400_000),
    });
    directDealId = String(direct.row.id);
    expect(direct.row).toMatchObject({ status: "active", opportunityId: null, targetOrganizationId: targetDirect });
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.pe_document_links WHERE deal_id=$1 AND entity_type='pe_deal'",
      [directDealId],
    )).rows[0]?.count).toBe(1);
  });

  it("enforces InvestmentCase, Thesis, Assumption, and semantic Decision semantics", async () => {
    const firstCase = await createInvestmentCase(ctxA, {
      dealId: promotedDealId,
      title: "Base investment case",
    });
    investmentCaseId = String(firstCase.row.id);
    const secondCase = await createInvestmentCase(ctxA, {
      dealId: promotedDealId,
      title: "Alternative investment case",
    });
    expect((await activateInvestmentCase(ctxA, {
      investmentCaseId,
      expectedVersion: 1,
    })).row.state).toBe("active");
    await expect(activateInvestmentCase(ctxA, {
      investmentCaseId: String(secondCase.row.id),
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: "23505" });

    const thesis = await createThesis(ctxA, {
      dealId: promotedDealId,
      investmentCaseId,
      thesisType: "value_creation",
      title: "Durable recurring revenue",
      statement: "Retention and pricing support durable growth.",
    });
    thesisId = String(thesis.row.id);
    const activeThesis = await transitionThesis(ctxA, { thesisId, expectedVersion: 1, targetState: "active" });
    expect(activeThesis.row).toMatchObject({ state: "active" });
    expect(activeThesis.row).not.toHaveProperty("epistemicSupport");

    const assumption = await createAssumption(ctxA, {
      dealId: promotedDealId,
      investmentCaseId,
      assumptionKey: "entry_multiple",
      statement: "Entry multiple is 9.5x EBITDA.",
      valueType: "number",
      value: 9.5,
      materiality: "high",
    });
    assumptionId = String(assumption.row.id);
    expect(assumption.row).toMatchObject({ investmentCaseId, state: "active" });
    expect(assumption.row).not.toHaveProperty("thesisId");
    const revised = await reviseAssumption(ctxA, {
      assumptionId,
      expectedVersion: 1,
      replacement: {
        statement: "Entry multiple is 9.0x EBITDA.",
        valueType: "number",
        value: 9,
        materiality: "high",
      },
    });
    revisedAssumptionId = String(revised.row.id);
    expect(revised.row).toMatchObject({ supersedesAssumptionId: assumptionId, state: "active" });
    expect((await admin.query(
      "SELECT state FROM finnor_os.pe_assumptions WHERE id=$1",
      [assumptionId],
    )).rows[0]?.state).toBe("superseded");
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.canonical_entity_versions WHERE entity_type='pe_assumption' AND entity_id=ANY($1::uuid[])",
      [[assumptionId, revisedAssumptionId]],
    )).rows[0]?.count).toBe(3);
    await expect(tenantQuery(
      tenantA,
      ownerA,
      `UPDATE finnor_os.pe_assumptions
          SET state='superseded',superseded_at=now(),version=version+1
        WHERE id=$1`,
      [revisedAssumptionId],
    )).rejects.toThrow(/requires a committed replacement revision/i);

    const invalidPartyDecision = await recordDecision(ctxA, {
      dealId: promotedDealId,
      investmentCaseId,
      decisionType: "screening",
      title: "Invalid actor probe",
      decision: "Do not commit",
    });
    await expect(finalizeDecision(ctxA, {
      decisionId: String(invalidPartyDecision.row.id),
      expectedVersion: 1,
      decidedBy: { partyType: "employee", partyId: ownerB },
    })).rejects.toBeTruthy();
    expect((await admin.query("SELECT state FROM finnor_os.pe_decisions WHERE id=$1", [invalidPartyDecision.row.id])).rows[0]?.state).toBe("draft");

    const decision = await recordDecision(ctxA, {
      dealId: promotedDealId,
      investmentCaseId,
      decisionType: "investment_committee",
      title: "Proceed to final diligence",
      decision: "Proceed subject to customer reference completion.",
      rationale: "Base case meets return threshold.",
    });
    finalDecisionId = String(decision.row.id);
    const final = await finalizeDecision(ctxA, {
      decisionId: finalDecisionId,
      expectedVersion: 1,
      decidedBy: { partyType: "employee", partyId: ownerA },
    });
    expect(final.row).toMatchObject({ state: "final", decidedByPartyId: ownerA, version: 2 });
    await expect(tenantQuery(
      tenantA,
      ownerA,
      "UPDATE finnor_os.pe_decisions SET title='forbidden',version=version+1 WHERE id=$1",
      [finalDecisionId],
    )).rejects.toThrow(/immutable PE world truth/i);
    await expect(tenantQuery(
      tenantA,
      ownerA,
      "UPDATE finnor_os.pe_decisions SET decided_at=decided_at+interval '1 second',version=version+1 WHERE id=$1",
      [finalDecisionId],
    )).rejects.toThrow(/must perform an allowed lifecycle transition/i);

    const replacement = await supersedeDecision(ctxA, {
      decisionId: finalDecisionId,
      expectedVersion: 2,
      decisionType: "investment_committee",
      title: "Proceed to signing",
      decision: "Proceed to signing.",
      rationale: "Customer references completed.",
      decidedBy: { partyType: "employee", partyId: ownerA },
    });
    expect(replacement.row).toMatchObject({ state: "final", supersedesDecisionId: finalDecisionId });
    expect((await admin.query("SELECT state FROM finnor_os.pe_decisions WHERE id=$1", [finalDecisionId])).rows[0]?.state).toBe("superseded");
    const effects = await linkDecisionEffects(ctxA, {
      decisionId: String(replacement.row.id),
      effects: [
        { effectType: "work", effectId: workId, relationship: "implements" },
        { effectType: "decision_receipt", effectId: receiptId, relationship: "records" },
      ],
    });
    expect(effects).toHaveLength(2);
    expect(new Set(effects.map((row) => row.effectType))).toEqual(new Set(["work", "decision_receipt"]));

    const otherCase = await createInvestmentCase(ctxA, { dealId: directDealId, title: "Other Deal case" });
    await expect(recordDecision(ctxA, {
      dealId: directDealId,
      investmentCaseId: String(otherCase.row.id),
      decisionType: "invalid_supersession",
      title: "Cross-Deal correction",
      decision: "Must fail.",
      supersedesDecisionId: String(replacement.row.id),
    })).rejects.toBeTruthy();
  });

  it("composes Strategy, Opportunity, and complete Deal world-state through the operational query", async () => {
    const workstream = await createWorkstream(ctxA, {
      dealId: promotedDealId,
      kind: "commercial",
      name: "P1 commercial diligence",
      owner: { partyType: "employee", partyId: ownerA },
    });
    await attachCanonicalEvidence(ctxA, {
      dealId: promotedDealId,
      entity: { entityType: "pe_investment_case", entityId: investmentCaseId },
      evidenceSourceId: evidenceDeal,
      relationship: "supports",
    });
    const dealDocument = await attachCanonicalDocument(ctxA, {
      dealId: promotedDealId,
      entity: { entityType: "pe_investment_case", entityId: investmentCaseId },
      documentId: documentStrategy,
      linkRole: "source",
    });
    expect(dealDocument.row).toMatchObject({ worldRootType: "pe_deal", worldRootId: promotedDealId });

    const strategyWorld = await loadPrivateEquityWorldState(ctxA, { entityType: "pe_strategy", entityId: strategyId });
    expect(strategyWorld.strategy?.id).toBe(strategyId);
    expect(strategyWorld.opportunities.map((row) => row.id)).toContain(opportunityId);
    expect(strategyWorld.deals.map((row) => row.id)).toContain(promotedDealId);
    const opportunityWorld = await loadPrivateEquityWorldState(ctxA, { entityType: "pe_opportunity", entityId: opportunityId });
    expect(opportunityWorld).toMatchObject({
      opportunity: { id: opportunityId, state: "promoted" },
      deal: { id: promotedDealId },
    });
    await createOpportunity(ctxA, {
      id: promotedDealId,
      strategyId,
      targetOrganizationId: targetDirect,
      name: "Cross-type UUID collision opportunity",
    });
    await attachWorkToWorldEntity(ctxA, {
      workId: collisionWorkId,
      entity: { entityType: "pe_opportunity", entityId: promotedDealId, relationship: "about" },
    });
    const dealWorld = await loadPrivateEquityWorldState(ctxA, { entityType: "pe_deal", entityId: promotedDealId });
    expect(dealWorld.investmentCases.map((row) => row.id)).toContain(investmentCaseId);
    expect(dealWorld.theses.map((row) => row.id)).toContain(thesisId);
    expect(dealWorld.assumptions.map((row) => row.id)).toEqual(expect.arrayContaining([assumptionId, revisedAssumptionId]));
    expect(dealWorld.decisions.length).toBeGreaterThanOrEqual(2);
    expect(dealWorld.workstreams.map((row) => row.id)).toContain(workstream.row.id);
    expect(dealWorld.workLinks.map((row) => row.workId)).not.toContain(collisionWorkId);
    for (const field of [
      "dealParties", "workstreams", "requests", "deliverables", "findings", "dealRisks",
      "findingRiskLinks", "dependencies", "milestones", "closingConditions", "closingItems",
      "documents", "evidence", "workLinks", "taskLinks", "businessEvents", "authorityDecisions",
      "approvalRequests", "decisionReceipts", "conflicts", "epistemicWarnings", "provenance",
    ]) expect(dealWorld).toHaveProperty(field);

    const query = await executePrivateEquityOperationalQuery(tenantA, {
      intent: "pe_world_state",
      root: { entityType: "pe_deal", entityId: promotedDealId },
    }, { userId: ownerA, employeeId: ownerA });
    expect(query).toMatchObject({ intent: "pe_world_state", status: "ok", root: { entityId: promotedDealId } });
    expect(query.source.tables).toContain("canonical_entity_versions");
    await expect(loadPrivateEquityWorldState(
      ctxA,
      { entityType: "pe_deal", entityId: promotedDealId },
      "not-a-timestamp",
    )).rejects.toMatchObject({ code: "PE_INVALID_TEMPORAL_TIMESTAMP" });
    await expect(loadPrivateEquityWorldState(
      ctxA,
      { entityType: "pe_thesis", entityId: thesisId } as unknown as PeWorldRootRef,
    )).rejects.toMatchObject({ code: "PE_UNSUPPORTED_WORLD_ROOT" });
  });

  it("reports pre-baseline history honestly and enforces append-only, deterministic, tenant-isolated history", async () => {
    const beforeBaseline = new Date(baselineAt.getTime() - 1);
    const unavailable = await loadPrivateEquityWorldState(
      ctxA,
      { entityType: "pe_strategy", entityId: strategyId },
      beforeBaseline,
    );
    expect(unavailable.temporalCompleteness.status).toBe("unavailable_before_baseline");
    expect(unavailable.strategy).toBeNull();
    expect(unavailable.epistemicWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "UNKNOWN", reason: "HISTORY_UNAVAILABLE_BEFORE_BASELINE" }),
    ]));

    const badHashes = await admin.query<{ count: number }>(
      `SELECT count(*)::int count FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1
          AND snapshot_hash<>encode(digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex')`,
      [tenantA],
    );
    expect(badHashes.rows[0]?.count).toBe(0);
    await expect(admin.query(
      `UPDATE finnor_os.canonical_entity_versions SET actor='forbidden'
        WHERE id=(SELECT id FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 LIMIT 1)`,
      [tenantA],
    )).rejects.toThrow(/append-only/i);
    await expect(admin.query(
      `INSERT INTO finnor_os.canonical_entity_versions(
        tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,origin
       ) SELECT tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,clock_timestamp(),'mutation'
         FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 LIMIT 1`,
      [tenantA],
    )).rejects.toMatchObject({ code: "23505" });

    const foreign = await createStrategy(ctxB, { name: "Foreign strategy" });
    const foreignId = String(foreign.row.id);
    await expect(loadPrivateEquityWorldState(ctxA, { entityType: "pe_strategy", entityId: foreignId }))
      .rejects.toMatchObject({ code: "PE_ENTITY_NOT_FOUND" });
    expect((await tenantQuery(
      tenantA,
      ownerA,
      "SELECT * FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_id=$2",
      [tenantB, foreignId],
    )).rowCount).toBe(0);
    await expect(createOpportunity(ctxA, {
      strategyId: foreignId,
      targetOrganizationId: targetA,
      name: "Foreign Strategy link",
    })).rejects.toBeTruthy();

    const foreignDeal = await createDeal(ctxB, {
      targetOrganizationId: targetB,
      name: "Foreign signed-LOI Deal",
      dealLeadEmployeeId: ownerB,
      signedLoiAt: new Date(Date.now() - 86_400_000),
      targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const foreignCase = await createInvestmentCase(ctxB, {
      dealId: String(foreignDeal.row.id),
      title: "Foreign investment case",
    });
    await expect(createAssumption(ctxA, {
      dealId: promotedDealId,
      investmentCaseId: String(foreignCase.row.id),
      assumptionKey: "cross_tenant_probe",
      statement: "Must not commit.",
      valueType: "boolean",
      value: true,
    })).rejects.toBeTruthy();

    const originSpoofId = randomUUID();
    await tenantQuery(
      tenantA,
      ownerA,
      `WITH configured AS MATERIALIZED (
         SELECT set_config('app.canonical_history_origin','baseline',true)
       )
       INSERT INTO finnor_os.pe_strategies(id,tenant_id,name,source_system,created_by)
       SELECT $1,$2,'Application origin spoof probe','integration:p1',$3::text FROM configured`,
      [originSpoofId, tenantA, ownerA],
    );
    expect((await admin.query<{ origin: string }>(
      `SELECT origin FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND entity_type='pe_strategy' AND entity_id=$2`,
      [tenantA, originSpoofId],
    )).rows[0]?.origin).toBe("mutation");
    await expect(tenantQuery(
      tenantA,
      ownerA,
      "UPDATE finnor_os.evidence_sources SET source_type='retroactive_reclassification' WHERE id=$1",
      [evidenceEligible],
    )).rejects.toThrow(/source type is immutable/i);

    const strategySnapshot = (await admin.query<{ snapshot: Record<string, unknown> }>(
      "SELECT to_jsonb(s) snapshot FROM finnor_os.pe_strategies s WHERE id=$1",
      [strategyId],
    )).rows[0]!.snapshot;
    const corruptRecordedAt = (await admin.query<{ recorded_at: Date }>(
      `INSERT INTO finnor_os.canonical_entity_versions(
        tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,origin
       ) VALUES ($1,'pe_strategy',$2,1000000,$3,$4,clock_timestamp(),'mutation')
       RETURNING recorded_at`,
      [tenantA, strategyId, strategySnapshot, "f".repeat(64)],
    )).rows[0]!.recorded_at;
    await expect(loadPrivateEquityWorldState(
      ctxA,
      { entityType: "pe_strategy", entityId: strategyId },
      new Date(corruptRecordedAt.getTime() + 1),
    ))
      .rejects.toMatchObject({ code: "PE_HISTORY_HASH_MISMATCH" });

    const poisonedId = randomUUID();
    await admin.query(
      `INSERT INTO finnor_os.canonical_entity_versions(
        tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,origin
       ) VALUES ($1,'pe_strategy',$2,2147483647,$3,$4,clock_timestamp(),'mutation')`,
      [tenantA, poisonedId, { id: poisonedId, tenant_id: tenantA, name: "poison" }, "0".repeat(64)],
    );
    const canonicalBefore = Number((await admin.query<{ count: string }>(
      "SELECT count(*) count FROM finnor_os.pe_strategies WHERE tenant_id=$1",
      [tenantA],
    )).rows[0]!.count);
    await expect(createStrategy(ctxA, { id: poisonedId, name: "History failure must roll back" })).rejects.toBeTruthy();
    expect(Number((await admin.query<{ count: string }>(
      "SELECT count(*) count FROM finnor_os.pe_strategies WHERE tenant_id=$1",
      [tenantA],
    )).rows[0]!.count)).toBe(canonicalBefore);
  });
});
