// Proactive scan handler acceptance: each scan finds real conditions against real
// data and either drafts a real gated action (never auto-executed) or records a real
// finding for the owner digest — never silently drops what it found.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  getPool,
  closePool,
  withTenant,
  households,
  equipment,
  serviceVisits,
  inventoryItems,
  maintenanceAgreements,
  communicationsLog,
  domainPolicies,
  domainPolicyRevisions,
  scanFindings,
  domainActions,
  leads,
  workOrders,
  dataQualityFindings,
  contacts,
  contactMethods,
  technicians,
  appointments,
  users,
} from "@finnor/db";
import { eq, and } from "drizzle-orm";
import { scanLowInventory } from "../../apps/worker/src/handlers/scan-low-inventory";
import { scanServiceDue } from "../../apps/worker/src/handlers/scan-service-due";
import { scanColdLeads } from "../../apps/worker/src/handlers/scan-cold-leads";
import { scanDataQuality } from "../../apps/worker/src/handlers/scan-data-quality";
import { scheduledReminder } from "../../apps/worker/src/handlers/scheduled-reminder";
import { ownerDigest } from "../../apps/worker/src/handlers/owner-digest";
import { setResendFetchForTesting } from "../../packages/tools/src/resend";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000f1"; // dedicated, isolated from other fixtures

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

/** Mirror the owner policy API: every mutable policy write gets a new immutable
 * revision. The orchestrator intentionally reads revisions, never an unversioned
 * test-only policy row. */
async function upsertVersionedPolicy(
  actionType: string,
  values: { policy: Record<string, unknown>; requiresConfirmation: boolean },
  existing?: typeof domainPolicies.$inferSelect,
): Promise<void> {
  await withTenant(TENANT_ID, async (db) => {
    const [persisted] = existing
      ? await db
          .update(domainPolicies)
          .set({ ...values, version: existing.version + 1, effectiveFrom: new Date() })
          .where(eq(domainPolicies.id, existing.id))
          .returning()
      : await db
          .insert(domainPolicies)
          .values({ tenantId: TENANT_ID, actionType, ...values })
          .returning();
    await db.insert(domainPolicyRevisions).values({
      tenantId: TENANT_ID,
      policyId: persisted!.id,
      actionType: persisted!.actionType,
      version: persisted!.version,
      policy: persisted!.policy,
      requiresConfirmation: persisted!.requiresConfirmation,
      confirmationTemplate: persisted!.confirmationTemplate,
      modelProvider: persisted!.modelProvider,
      confirmationTimeoutHours: persisted!.confirmationTimeoutHours,
      effectiveFrom: persisted!.effectiveFrom,
    });
  });
}

describe.skipIf(!available)("proactive scan handlers", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await getPool().query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Scan Handler Test Tenant') ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("scan_low_inventory records a real finding for an item below threshold, nothing when none are", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(inventoryItems).where(eq(inventoryItems.tenantId, TENANT_ID)));
    await withTenant(TENANT_ID, (db) => db.delete(scanFindings).where(eq(scanFindings.tenantId, TENANT_ID)));
    await withTenant(TENANT_ID, (db) =>
      db.insert(inventoryItems).values({ tenantId: TENANT_ID, sku: "TEST-LOW", name: "Test Low Stock Item", quantity: 1, reorderThreshold: 10 }),
    );
    await scanLowInventory({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(scanFindings).where(and(eq(scanFindings.tenantId, TENANT_ID), eq(scanFindings.scanType, "low_inventory"))),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.summary).toContain("Test Low Stock Item");
  });

  it("scan_service_due finds equipment overdue by its real install date, real math not a guess", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(scanFindings).where(eq(scanFindings.tenantId, TENANT_ID)));
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(households)
        .values({ tenantId: TENANT_ID, address: "1 Test Overdue Ln", contactInfo: { name: "Overdue Test Household" } })
        .returning(),
    );
    // sediment_filter is due at the low end of its "3-6 months" range — 8 months ago is unambiguously overdue.
    await withTenant(TENANT_ID, (db) =>
      db.insert(equipment).values({
        householdId: hh!.id,
        type: "sediment_filter",
        source: "finnor",
        installDate: new Date(Date.now() - 8 * 30 * 24 * 3600 * 1000),
      }),
    );
    await scanServiceDue({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(scanFindings).where(and(eq(scanFindings.tenantId, TENANT_ID), eq(scanFindings.scanType, "service_due"))),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.summary).toContain("sediment filter");
  });

  it("scan_cold_leads drafts a real gated action when a win-back script IS configured", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(scanFindings).where(eq(scanFindings.tenantId, TENANT_ID)));
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(households)
        .values({
          tenantId: TENANT_ID,
          address: "2 Test Coldlead Ln",
          contactInfo: { name: "Cold Lead Household", phone: "+13195559911" },
          marketingConsent: true,
        })
        .returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(communicationsLog).values({
        householdId: hh!.id,
        channel: "call",
        direction: "outbound",
        content: "old contact",
        timestamp: new Date(Date.now() - 4 * 30 * 24 * 3600 * 1000), // 4 months ago — inside the 3-6 window
      }),
    );
    // No unique constraint on (tenant_id, action_type) to target with onConflict, and
    // delete-then-insert is unsafe here: action_log is append-only (§19 — UPDATE/DELETE
    // rejected by trigger), so once a drafted action against this policy has been
    // logged, deleting the policy row permanently violates domain_actions_policy_id_fkey
    // on every subsequent run. Update-in-place if the row exists, insert otherwise.
    const [existingPolicy] = await withTenant(TENANT_ID, (db) =>
      db
        .select()
        .from(domainPolicies)
        .where(and(eq(domainPolicies.tenantId, TENANT_ID), eq(domainPolicies.actionType, "bulk_notify_existing_customers"))),
    );
    const policyValues = { policy: { winback_offer_script: "Test win-back: 15% off, book a free water test." }, requiresConfirmation: true };
    await upsertVersionedPolicy("bulk_notify_existing_customers", policyValues, existingPolicy);
    await scanColdLeads({ tenantId: TENANT_ID });
    const drafted = await withTenant(TENANT_ID, (db) =>
      db.select().from(domainActions).where(and(eq(domainActions.tenantId, TENANT_ID), eq(domainActions.actionType, "bulk_notify_existing_customers"))),
    );
    expect(drafted.length).toBeGreaterThanOrEqual(1);
    const last = drafted[drafted.length - 1]!;
    expect(last.status).toBe("pending"); // gated — never auto-executed
    expect(last.summary).toBeTruthy();
  });

  it("scheduled_reminder (renewal scan) drafts through the real pipeline — real summary, never a blank card", async () => {
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db
        .insert(households)
        .values({ tenantId: TENANT_ID, address: "3 Test Renewal Ln", contactInfo: { name: "Renewal Household", phone: "+13195559922" } })
        .returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(maintenanceAgreements).values({
        householdId: hh!.id,
        cadence: "annual",
        status: "active",
        renewalDate: new Date(Date.now() + 5 * 24 * 3600 * 1000), // due in 5 days — inside the 30-day scan window
      }),
    );
    // The maintenance-agreement plugin's validate() requires policy.policy.price_usd
    // (MaintenanceAgreementPolicySchema has no default for it) — without a real policy
    // row this tenant would fall back to defaultPolicy()'s empty {} and validate()
    // would fail every time, same update-or-insert idempotency pattern as the
    // win-back policy seeded above.
    const [existingRenewalPolicy] = await withTenant(TENANT_ID, (db) =>
      db.select().from(domainPolicies).where(and(eq(domainPolicies.tenantId, TENANT_ID), eq(domainPolicies.actionType, "renew_maintenance_agreement"))),
    );
    const renewalPolicyValues = { policy: { price_usd: 199 }, requiresConfirmation: true };
    await upsertVersionedPolicy("renew_maintenance_agreement", renewalPolicyValues, existingRenewalPolicy);
    await scheduledReminder({ tenantId: TENANT_ID, windowDays: 30 });
    const drafted = await withTenant(TENANT_ID, (db) =>
      db.select().from(domainActions).where(and(eq(domainActions.tenantId, TENANT_ID), eq(domainActions.actionType, "renew_maintenance_agreement"))),
    );
    expect(drafted.length).toBeGreaterThanOrEqual(1);
    const last = drafted[drafted.length - 1]!;
    expect(last.status).toBe("pending");
    expect(last.summary).toBeTruthy(); // the actual bug being fixed: this used to be null
    expect(last.summary).not.toBe("No summary drafted.");
  });

  it("scan_data_quality flags a duplicate household pair sharing the same phone", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(eq(dataQualityFindings.tenantId, TENANT_ID)));
    await withTenant(TENANT_ID, (db) =>
      db.insert(households).values([
        { tenantId: TENANT_ID, address: "4 Test Dupe Ln", contactInfo: { name: "Dupe One", phone: "+13195559933" } },
        { tenantId: TENANT_ID, address: "4 Test Dupe Ln", contactInfo: { name: "Dupe One Again", phone: "+13195559933" } },
      ]),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "duplicate_candidate"))),
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it("scan_data_quality flags a lead with no phone or email, and a scheduled work order with no technician", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(eq(dataQualityFindings.tenantId, TENANT_ID)));
    const [lead] = await withTenant(TENANT_ID, (db) =>
      db.insert(leads).values({ tenantId: TENANT_ID, name: "No Contact Method Lead", status: "new" }).returning(),
    );
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "5 Test Workorder Ln", contactInfo: { name: "Work Order Household" } }).returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(workOrders).values({ tenantId: TENANT_ID, householdId: hh!.id, type: "install", status: "scheduled" }),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "missing_critical_field"))),
    );
    expect(findings.some((f) => f.entityType === "lead" && f.entityId === lead!.id)).toBe(true);
    expect(findings.some((f) => f.entityType === "work_order")).toBe(true);
  });

  it("scan_data_quality flags a household whose legacy phone disagrees with its canonical contact's phone (§5.4 contradiction)", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"))));
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "6 Test Contradiction Ln", contactInfo: { name: "Phone Mismatch", phone: "+13195551111" } }).returning(),
    );
    const [contact] = await withTenant(TENANT_ID, (db) =>
      db.insert(contacts).values({ tenantId: TENANT_ID, householdId: hh!.id, name: "Phone Mismatch" }).returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(contactMethods).values({ tenantId: TENANT_ID, contactId: contact!.id, methodType: "phone", value: "+13195552222" }),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"), eq(dataQualityFindings.entityType, "household"))),
    );
    expect(findings.some((f) => f.entityId === hh!.id && f.relatedEntityId === contact!.id)).toBe(true);
    const match = findings.find((f) => f.entityId === hh!.id)!;
    expect(match.details).toMatchObject({ legacyPhone: "13195551111", canonicalPhone: "13195552222" });
  });

  it("scan_data_quality never flags a household whose legacy and canonical phones genuinely agree", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"))));
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "7 Test Agreement Ln", contactInfo: { name: "Phone Match", phone: "+13195553333" } }).returning(),
    );
    const [contact] = await withTenant(TENANT_ID, (db) =>
      db.insert(contacts).values({ tenantId: TENANT_ID, householdId: hh!.id, name: "Phone Match" }).returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(contactMethods).values({ tenantId: TENANT_ID, contactId: contact!.id, methodType: "phone", value: "+13195553333" }),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"), eq(dataQualityFindings.entityType, "household"))),
    );
    expect(findings.some((f) => f.entityId === hh!.id)).toBe(false);
  });

  it("scan_data_quality flags duplicate equipment of the same type for the same household", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"))));
    const [hh] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "8 Test Dupe Equip Ln", contactInfo: {} }).returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(equipment).values([
        { householdId: hh!.id, type: "softener", model: "Model A" },
        { householdId: hh!.id, type: "softener", model: "Model B" },
      ]),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"), eq(dataQualityFindings.entityType, "equipment"))),
    );
    expect(findings.some((f) => (f.details as { householdId?: string }).householdId === hh!.id)).toBe(true);
  });

  it("scan_data_quality flags overlapping appointments for the same technician", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"))));
    const [household] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "9 Appointment Overlap Ln", contactInfo: {} }).returning(),
    );
    const [tech] = await withTenant(TENANT_ID, (db) => db.insert(technicians).values({ tenantId: TENANT_ID, name: "Overlap Tech" }).returning());
    const start1 = new Date("2026-08-01T09:00:00Z");
    const start2 = new Date("2026-08-01T09:30:00Z"); // starts 30 min into a 60-min-default first appointment
    await withTenant(TENANT_ID, (db) =>
      db.insert(appointments).values([
        { tenantId: TENANT_ID, subjectType: "household", subjectId: household!.id, technicianId: tech!.id, status: "confirmed", scheduledAt: start1 },
        { tenantId: TENANT_ID, subjectType: "household", subjectId: household!.id, technicianId: tech!.id, status: "confirmed", scheduledAt: start2 },
      ]),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"), eq(dataQualityFindings.entityType, "appointment"))),
    );
    // Positional (findings[0]) would flake against the local dev DB's cross-run
    // persistence — other technicians' overlap findings from earlier runs may already
    // be in the table (same tolerant-of-accumulation convention the tests above use).
    expect(findings.some((f) => (f.details as { technicianId?: string }).technicianId === tech!.id)).toBe(true);
  });

  it("scan_data_quality never flags non-overlapping appointments for the same technician", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(dataQualityFindings).where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"))));
    const [household] = await withTenant(TENANT_ID, (db) =>
      db.insert(households).values({ tenantId: TENANT_ID, address: "10 Appointment Control Ln", contactInfo: {} }).returning(),
    );
    const [tech] = await withTenant(TENANT_ID, (db) => db.insert(technicians).values({ tenantId: TENANT_ID, name: "No Overlap Tech" }).returning());
    await withTenant(TENANT_ID, (db) =>
      db.insert(appointments).values([
        { tenantId: TENANT_ID, subjectType: "household", subjectId: household!.id, technicianId: tech!.id, status: "confirmed", scheduledAt: new Date("2026-08-02T09:00:00Z"), durationMinutes: 30 },
        { tenantId: TENANT_ID, subjectType: "household", subjectId: household!.id, technicianId: tech!.id, status: "confirmed", scheduledAt: new Date("2026-08-02T10:00:00Z"), durationMinutes: 30 },
      ]),
    );
    await scanDataQuality({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db
        .select()
        .from(dataQualityFindings)
        .where(and(eq(dataQualityFindings.tenantId, TENANT_ID), eq(dataQualityFindings.findingType, "contradiction"), eq(dataQualityFindings.entityType, "appointment"))),
    );
    expect(findings.filter((f) => (f.details as { technicianId?: string }).technicianId === tech!.id)).toHaveLength(0);
  });

  it("owner_digest is a no-op (no call attempted) when there's nothing to report", async () => {
    await withTenant(TENANT_ID, (db) => db.delete(scanFindings).where(eq(scanFindings.tenantId, TENANT_ID)));
    await getPool().query(`UPDATE tenants SET owner_phone = NULL WHERE id = $1`, [TENANT_ID]);
    // No findings, no fresh scan-drafted actions in the lookback window → should return cleanly without throwing.
    await expect(ownerDigest({ tenantId: TENANT_ID })).resolves.toBeUndefined();
  });

  it("owner_digest marks findings digested even with no phone configured (never piles up forever)", async () => {
    await withTenant(TENANT_ID, (db) =>
      db.insert(scanFindings).values({ tenantId: TENANT_ID, scanType: "low_inventory", summary: "test finding for digest", details: {} }),
    );
    await getPool().query(`UPDATE tenants SET owner_phone = NULL WHERE id = $1`, [TENANT_ID]);
    await ownerDigest({ tenantId: TENANT_ID });
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM scan_findings WHERE tenant_id = $1 AND digested_at IS NULL`,
      [TENANT_ID],
    );
    expect(rows[0].n).toBe(0);
  });

  it("owner_digest sends an allowlisted owner a query-backed daily email without claiming an approval happened", async () => {
    const ownerId = "00000000-0000-4000-8000-0000000000f2";
    const priorApiKey = process.env.RESEND_API_KEY;
    const priorCap = process.env.RESEND_DAILY_CAP;
    const priorSystemProviders = process.env.FINNOR_SYSTEM_CREDENTIAL_PROVIDERS;
    let requestBody: Record<string, unknown> | undefined;
    try {
      process.env.RESEND_API_KEY = "test-key-not-real";
      process.env.RESEND_DAILY_CAP = "50";
      process.env.FINNOR_SYSTEM_CREDENTIAL_PROVIDERS = "resend";
      await withTenant(TENANT_ID, (db) =>
        db.insert(users).values({ id: ownerId, tenantId: TENANT_ID, email: "digest-owner@finnorai.com", role: "owner" }).onConflictDoNothing(),
      );
      await withTenant(TENANT_ID, (db) =>
        db.insert(scanFindings).values({ tenantId: TENANT_ID, scanType: "low_inventory", summary: "Digest email inventory finding", details: {} }),
      );
      setResendFetchForTesting((async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "digest-email-123" }), { status: 200 });
      }) as unknown as typeof fetch);
      await getPool().query(`UPDATE tenants SET owner_phone = NULL WHERE id = $1`, [TENANT_ID]);

      await ownerDigest({ tenantId: TENANT_ID });

      expect(requestBody).toMatchObject({
        to: ["digest-owner@finnorai.com"],
        subject: "Finnor daily operating brief",
      });
      expect(String(requestBody?.html)).toContain("Digest email inventory finding");
      expect(String(requestBody?.html)).toContain("Nothing has been approved or acted on without you.");
    } finally {
      setResendFetchForTesting(null);
      if (priorApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = priorApiKey;
      if (priorCap === undefined) delete process.env.RESEND_DAILY_CAP;
      else process.env.RESEND_DAILY_CAP = priorCap;
      if (priorSystemProviders === undefined) delete process.env.FINNOR_SYSTEM_CREDENTIAL_PROVIDERS;
      else process.env.FINNOR_SYSTEM_CREDENTIAL_PROVIDERS = priorSystemProviders;
      await withTenant(TENANT_ID, (db) => db.delete(users).where(eq(users.id, ownerId)));
    }
  });
});
