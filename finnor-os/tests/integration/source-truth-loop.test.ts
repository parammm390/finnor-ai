import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  closePool,
  configureTenantVertical,
  externalRefObservations,
  externalRefs,
  integrationSyncCheckpoints,
  reconciliationCases,
  withTenant,
} from "@finnor/db";
import { materializeSourceRecord, SourceTruthError } from "@finnor/data-platform";
import type { CanonicalSourceRecord } from "@finnor/shared-types";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const available = await (async () => {
  const client = new pg.Client({ connectionString: SUPER_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
})();

const tenantA = randomUUID();
const tenantB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const strategyA = randomUUID();
const strategyB = randomUUID();
const opportunityA = randomUUID();
const opportunityAlternative = randomUUID();
const opportunityOrdered = randomUUID();
const opportunityConflict = randomUUID();
const opportunityDeleted = randomUUID();
const opportunityB = randomUUID();
const targetA = randomUUID();
const targetAlternative = randomUUID();
const targetB = randomUUID();
const integrationA = randomUUID();
const integrationB = randomUUID();

function observation(externalId: string, overrides: Partial<CanonicalSourceRecord> = {}): CanonicalSourceRecord {
  return {
    tenantId: tenantA,
    integrationId: integrationA,
    provider: "p1_vdr",
    sourceScope: "pipeline",
    externalObjectType: "opportunity",
    externalId,
    canonicalEntity: "pe_opportunity",
    materialization: "observe_only",
    candidateCanonicalIds: [opportunityA],
    sourceSequence: "100",
    observedAt: "2026-08-24T12:00:00.000Z",
    identityKey: `opportunity:${externalId}`,
    data: { state: "qualified", sourceLabel: externalId },
    ownership: { default: "external", direction: "inbound" },
    provenance: { fixture: "active-pe-source-truth" },
    ...overrides,
  };
}

describe.skipIf(!available)("active PE Source Truth observe-only loop", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
        ($1,$2,'Source Truth PE project A'),($3,$4,'Source Truth PE project B')`,
      [tenantA, `source-a-${tenantA}`, tenantB, `source-b-${tenantB}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
        ($1,$2,$3,'owner','active','Source Owner A'),
        ($4,$5,$6,'owner','active','Source Owner B')`,
      [ownerA, tenantA, `${ownerA}@test.invalid`, ownerB, tenantB, `${ownerB}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
        ($1,$4,'source-target-a','Source Target A','other'),
        ($2,$4,'source-target-alt','Source Target Alternative','other'),
        ($3,$5,'source-target-b','Source Target B','other')`,
      [targetA, targetAlternative, targetB, tenantA, tenantB],
    );
    await admin.end();

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({
      tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0,
      createdBy: ownerA, sourceSystem: "integration:source-truth",
    });
    await configureTenantVertical({
      tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0,
      createdBy: ownerB, sourceSystem: "integration:source-truth",
    });

    const seeded = new pg.Client({ connectionString: SUPER_URL });
    await seeded.connect();
    await seeded.query("SET app.test_vertical_mode = 'explicit'");
    await seeded.query(
      `INSERT INTO finnor_os.pe_strategies(id,tenant_id,name,source_system,created_by) VALUES
        ($1,$2,'Source Strategy A','integration:source-truth',$3::text),
        ($4,$5,'Source Strategy B','integration:source-truth',$6::text)`,
      [strategyA, tenantA, ownerA, strategyB, tenantB, ownerB],
    );
    await seeded.query(
      `INSERT INTO finnor_os.pe_opportunities(
        id,tenant_id,strategy_id,target_organization_id,name,source_system,created_by
       ) VALUES
        ($1,$2,$3,$4,'Observed Opportunity A','integration:source-truth',$5::text),
        ($6,$2,$3,$7,'Observed Opportunity Alternative','integration:source-truth',$5::text),
        ($8,$9,$10,$11,'Observed Opportunity B','integration:source-truth',$12::text)`,
      [opportunityA, tenantA, strategyA, targetA, ownerA, opportunityAlternative, targetAlternative,
        opportunityB, tenantB, strategyB, targetB, ownerB],
    );
    await seeded.query(
      `INSERT INTO finnor_os.pe_opportunities(
        id,tenant_id,strategy_id,target_organization_id,name,source_system,created_by
       ) VALUES
        ($1,$4,$5,$6,'Ordered provider Opportunity','integration:source-truth',$7::text),
        ($2,$4,$5,$6,'Conflicting provider Opportunity','integration:source-truth',$7::text),
        ($3,$4,$5,$6,'Tombstoned provider Opportunity','integration:source-truth',$7::text)`,
      [opportunityOrdered, opportunityConflict, opportunityDeleted, tenantA, strategyA, targetA, ownerA],
    );
    await seeded.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES
        ($1,$2,'private_equity_source','p1_vdr','emulator'),
        ($3,$4,'private_equity_source','p1_vdr','emulator')`,
      [integrationA, tenantA, integrationB, tenantB],
    );
    await seeded.end();
  }, 120_000);

  afterAll(async () => {
    await closePool();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("records one mapped observation and an immutable duplicate without mutating canonical PE truth", async () => {
    const first = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("initial")), ownerA);
    const replay = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("initial")), ownerA);
    expect(first).toMatchObject({ status: "observed", canonicalEntityType: "pe_opportunity", canonicalEntityId: opportunityA });
    expect(replay).toMatchObject({ status: "duplicate", canonicalEntityId: opportunityA, sourceLinkId: first.sourceLinkId });
    const links = await withTenant(tenantA, (db) => db.select().from(externalRefs)
      .where(and(eq(externalRefs.tenantId, tenantA), eq(externalRefs.externalId, "initial"))), ownerA);
    const ledger = await withTenant(tenantA, (db) => db.select().from(externalRefObservations).where(and(
        eq(externalRefObservations.tenantId, tenantA),
        eq(externalRefObservations.externalId, "initial"),
      )), ownerA);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ mappingStatus: "mapped", syncStatus: "observed", internalId: opportunityA });
    expect(ledger.map((row) => row.materializationStatus)).toEqual(["observed", "duplicate"]);
    const canonical = await withTenant(tenantA, (db) => db.execute<{ name: string; state: string }>(sql`
      SELECT name,state FROM finnor_os.pe_opportunities WHERE id=${opportunityA}::uuid
    `), ownerA);
    expect(canonical.rows[0]).toEqual({ name: "Observed Opportunity A", state: "identified" });
  });

  it("accepts a strictly newer provider observation while leaving canonical state unchanged", async () => {
    const changed = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("initial", {
      sourceSequence: "200",
      observedAt: "2026-08-24T12:01:00.000Z",
      data: { state: "rejected", sourceLabel: "provider-only-update" },
    })), ownerA);
    expect(changed.status).toBe("observed");
    const [link] = await withTenant(tenantA, (db) => db.select().from(externalRefs)
      .where(and(eq(externalRefs.tenantId, tenantA), eq(externalRefs.externalId, "initial"))), ownerA);
    expect(link?.observedState).toEqual({ state: "rejected", sourceLabel: "provider-only-update" });
    const canonical = await withTenant(tenantA, (db) => db.execute<{ state: string }>(sql`
      SELECT state FROM finnor_os.pe_opportunities WHERE id=${opportunityA}::uuid
    `), ownerA);
    expect(canonical.rows[0]?.state).toBe("identified");
  });

  it("quarantines ambiguous deterministic candidates in existing reconciliation_cases", async () => {
    const result = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("ambiguous", {
      candidateCanonicalIds: [opportunityA, opportunityAlternative],
    })), ownerA);
    expect(result.status).toBe("ambiguous");
    const [link] = await withTenant(tenantA, (db) => db.select().from(externalRefs)
      .where(eq(externalRefs.id, result.sourceLinkId)), ownerA);
    const cases = await withTenant(tenantA, (db) => db.select().from(reconciliationCases).where(and(
        eq(reconciliationCases.tenantId, tenantA),
        eq(reconciliationCases.sourceLinkId, result.sourceLinkId),
      )), ownerA);
    expect(link).toMatchObject({ mappingStatus: "ambiguous", conflictState: "ambiguous", internalId: null });
    expect(cases).toEqual([expect.objectContaining({ caseType: "mapping_ambiguous", status: "open" })]);
  });

  it("rejects an older provider sequence without rolling the current projection backward", async () => {
    await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("ordered", {
      sourceSequence: "500", candidateCanonicalIds: [opportunityOrdered],
      data: { state: "qualified", sourceLabel: "newest" },
    })), ownerA);
    const older = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("ordered", {
      sourceSequence: "499",
      candidateCanonicalIds: [opportunityOrdered],
      observedAt: "2026-08-24T12:02:00.000Z",
      data: { state: "screening", sourceLabel: "older" },
    })), ownerA);
    expect(older.status).toBe("out_of_order");
    const [link] = await withTenant(tenantA, (db) => db.select().from(externalRefs)
      .where(and(eq(externalRefs.tenantId, tenantA), eq(externalRefs.externalId, "ordered"))), ownerA);
    expect(link?.observedState).toEqual({ state: "qualified", sourceLabel: "newest" });
  });

  it("opens divergence at the same provider position instead of last-write-wins", async () => {
    await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("conflict", {
      sourceSequence: "10", candidateCanonicalIds: [opportunityConflict], data: { state: "qualified" },
    })), ownerA);
    const conflict = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("conflict", {
      sourceSequence: "10", candidateCanonicalIds: [opportunityConflict], data: { state: "rejected" },
    })), ownerA);
    expect(conflict).toMatchObject({ status: "conflict", reason: "changed payload at the same provider position" });
    const [sourceCase] = await withTenant(tenantA, (db) => db.select().from(reconciliationCases).where(and(
      eq(reconciliationCases.tenantId, tenantA),
      eq(reconciliationCases.sourceLinkId, conflict.sourceLinkId),
    )), ownerA);
    expect(sourceCase).toMatchObject({ caseType: "external_drift", classification: "observe_only_divergent", status: "open" });
  });

  it("tombstones the provider projection while retaining canonical Opportunity truth", async () => {
    const created = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("deleted", {
      sourceSequence: "20", candidateCanonicalIds: [opportunityDeleted],
    })), ownerA);
    const deleted = await withTenant(tenantA, (db) => materializeSourceRecord(db, observation("deleted", {
      sourceSequence: "21",
      candidateCanonicalIds: [opportunityDeleted],
      observedAt: "2026-08-24T12:04:00.000Z",
      deleted: true,
      data: {},
    })), ownerA);
    expect(deleted).toMatchObject({ status: "tombstoned", canonicalEntityId: created.canonicalEntityId });
    const [link] = await withTenant(tenantA, (db) => db.select().from(externalRefs)
      .where(eq(externalRefs.id, deleted.sourceLinkId)), ownerA);
    expect(link).toMatchObject({ mappingStatus: "tombstoned", providerDeleted: true, syncStatus: "source_missing" });
    const canonical = await withTenant(tenantA, (db) => db.execute<{ count: number }>(sql`
      SELECT count(*)::int count FROM finnor_os.pe_opportunities WHERE id=${opportunityDeleted}::uuid
    `), ownerA);
    expect(canonical.rows[0]?.count).toBe(1);
  });

  it("fails closed on cross-tenant canonical candidates and checkpoint forgery", async () => {
    await expect(withTenant(tenantB, (db) => materializeSourceRecord(db, observation("forged", {
      tenantId: tenantB,
      integrationId: integrationB,
      candidateCanonicalIds: [opportunityA],
    })), ownerB)).rejects.toBeInstanceOf(SourceTruthError);
    await expect(withTenant(tenantB, (db) => db.insert(integrationSyncCheckpoints).values({
      tenantId: tenantB,
      integrationId: integrationA,
      sourceScope: "pipeline",
    }), ownerB)).rejects.toThrow();
    const foreign = await withTenant(tenantB, (db) => db.select().from(externalRefs)
      .where(eq(externalRefs.externalId, "forged")), ownerB);
    expect(foreign).toHaveLength(0);
    const own = await withTenant(tenantB, (db) => materializeSourceRecord(db, observation("tenant-b-own", {
      tenantId: tenantB,
      integrationId: integrationB,
      candidateCanonicalIds: [opportunityB],
    })), ownerB);
    expect(own).toMatchObject({ status: "observed", canonicalEntityId: opportunityB });
  });
});
