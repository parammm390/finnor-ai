// Phase 3.2/3.6: Dealer Zero seeding must be genuinely idempotent — re-running it twice
// must produce the identical row counts, not silently double them. Regression test for
// the real bug this script hit during development: a running "amcsAssigned < target"
// counter whose increment was conditioned on "row didn't already exist" desynced the
// per-household hashed-rng derivation on a rerun, causing equipment/visit rows (whose
// hashed seeds depend only on household index, not on what ran before them) to
// re-generate different values and duplicate. Fixed by deriving every random value from
// a pure hash of (seed, entity kind, index, slot) — this test proves that holds.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed } from "../../packages/db/seed";
import { withTenant, closePool, households, equipment, serviceVisits, maintenanceAgreements, leads, technicians, domainPolicies, priceBookItems, tenantSettings } from "@finnor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { seedDealerZero, DEALER_ZERO_TENANT_ID } from "../../scripts/seed-dealer-zero";
import { seedTenantPolicies } from "../../scripts/seed-tenant-policies";
import { createDefaultPluginRegistry } from "@finnor/orchestration";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

async function counts() {
  return withTenant(DEALER_ZERO_TENANT_ID, async (db) => {
    const hh = await db.select().from(households).where(eq(households.tenantId, DEALER_ZERO_TENANT_ID));
    const hhIds = hh.map((h) => h.id);
    const eqRows = hhIds.length ? await db.select().from(equipment).where(inArray(equipment.householdId, hhIds)) : [];
    const svRows = hhIds.length ? await db.select().from(serviceVisits).where(inArray(serviceVisits.householdId, hhIds)) : [];
    const amcRows = hhIds.length ? await db.select().from(maintenanceAgreements).where(inArray(maintenanceAgreements.householdId, hhIds)) : [];
    const techRows = await db.select().from(technicians).where(eq(technicians.tenantId, DEALER_ZERO_TENANT_ID));
    const leadRows = await db.select().from(leads).where(eq(leads.tenantId, DEALER_ZERO_TENANT_ID));
    return { households: hh.length, equipment: eqRows.length, serviceVisits: svRows.length, amcs: amcRows.length, technicians: techRows.length, leads: leadRows.length };
  });
}

describe.skipIf(!available)("Dealer Zero seeding (§3.2/§3.6)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  }, 30_000);
  afterAll(async () => {
    await closePool();
  });

  it("seeds 120 households (105 established + 15 leads), 3 technicians, ~40 AMCs, labeled dealer-zero", async () => {
    const result = await seedDealerZero();
    expect(result.establishedHouseholdCount).toBe(105);
    expect(result.openLeadCount).toBe(15);
    expect(result.technicianCount).toBe(3);

    const c = await counts();
    // >= not ===: the simulator (§3.3, tested separately) is a real, ongoing process
    // that adds more households/leads to this SAME permanent tenant over time — this
    // seed function's own contract is "at least the base 120," not "forever exactly 120."
    expect(c.households).toBeGreaterThanOrEqual(120);
    expect(c.technicians).toBe(3);
    expect(c.leads).toBeGreaterThanOrEqual(15);
    // ~40 per DECISIONS — an independent per-household draw, not an exact count.
    expect(c.amcs).toBeGreaterThan(25);
    expect(c.amcs).toBeLessThan(55);
    expect(c.equipment).toBeGreaterThan(0);
    expect(c.serviceVisits).toBeGreaterThan(0);

    const mapped = await withTenant(DEALER_ZERO_TENANT_ID, (db) =>
      db.select({ latitude: households.latitude, longitude: households.longitude }).from(households).where(and(eq(households.tenantId, DEALER_ZERO_TENANT_ID), sql`${households.latitude} is not null`, sql`${households.longitude} is not null`)).limit(1),
    );
    expect(Number(mapped[0]?.latitude)).toBeGreaterThan(29.5);
    expect(Number(mapped[0]?.latitude)).toBeLessThan(30);
    expect(Number(mapped[0]?.longitude)).toBeGreaterThan(-96);
    expect(Number(mapped[0]?.longitude)).toBeLessThan(-95);

    const [settings] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, DEALER_ZERO_TENANT_ID)));
    expect(settings?.isDealerZero).toBe(true);
  }, 60_000);

  it("re-running seedDealerZero() twice more produces IDENTICAL row counts — the regression this test exists for", async () => {
    const after1 = await counts();
    await seedDealerZero();
    const after2 = await counts();
    expect(after2).toEqual(after1);
    await seedDealerZero();
    const after3 = await counts();
    expect(after3).toEqual(after1);
  }, 60_000);

  it("seedTenantPolicies covers all 41 registered action types + the pricing_catalog row for Dealer Zero, zero placeholders", async () => {
    const registry = createDefaultPluginRegistry();
    const result = await seedTenantPolicies(DEALER_ZERO_TENANT_ID, { reviewLinkUrl: "https://g.page/r/dealer-zero-finnor-water-co/review" });
    expect(result.registeredActionTypeCount).toBe(registry.actionTypes().length);
    expect(result.missingFromMatrix).toEqual([]);
    expect(result.extraInMatrix).toEqual([]);
    expect(result.actionTypesSeeded).toBe(registry.actionTypes().length + 1); // +1 for the pricing_catalog pseudo-row

    const rows = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(domainPolicies).where(eq(domainPolicies.tenantId, DEALER_ZERO_TENANT_ID)));
    const withPlaceholder = rows.filter((r) => JSON.stringify(r.policy).includes("PLACEHOLDER_NEEDS_REAL_VALUE"));
    expect(withPlaceholder).toEqual([]);

    const items = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(priceBookItems).where(eq(priceBookItems.tenantId, DEALER_ZERO_TENANT_ID)));
    expect(items.length).toBeGreaterThanOrEqual(12);
    expect(items.length).toBeLessThanOrEqual(20);
  }, 30_000);

  it("re-running unchanged seedTenantPolicies is convergence-idempotent — no version bumps or duplicates", async () => {
    const before = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(domainPolicies).where(eq(domainPolicies.tenantId, DEALER_ZERO_TENANT_ID)));
    await seedTenantPolicies(DEALER_ZERO_TENANT_ID, { reviewLinkUrl: "https://g.page/r/dealer-zero-finnor-water-co/review" });
    const after = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(domainPolicies).where(eq(domainPolicies.tenantId, DEALER_ZERO_TENANT_ID)));
    expect(after.length).toBe(before.length);
    const beforeById = new Map(before.map((r) => [r.id, r]));
    for (const row of after) {
      const prior = beforeById.get(row.id);
      expect(prior).toBeTruthy();
      expect(row.version).toBe(prior!.version);
    }
  }, 30_000);
});
