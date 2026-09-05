// Idempotent tenant policy seed: every registered action plus the price-book row.
// from finnor-os/docs/policy-matrix.md (the single source of truth — if this script and
// that doc ever disagree, the doc wins, fix this file). Covers all 41 registered
// domain_policies rows plus the pricing_catalog pseudo-row + its price_book_items.
//
// Idempotent: an existing (tenantId, actionType) policy row is UPDATEd in place (with a
// real version bump — see below), never duplicated; price_book_items upserts by
// (tenantId, sku) via the table's own unique constraint.
//
// Usage:
//   npx tsx scripts/seed-tenant-policies.ts --tenant=<uuid> [--reviewLinkUrl=<url>]
//   PRIMARY_TENANT_REVIEW_LINK_URL=<url> npx tsx scripts/seed-tenant-policies.ts --tenant=<uuid>
//   npx tsx scripts/seed-tenant-policies.ts --tenant=<uuid> --dealerZero   (uses the synthetic review link)
//   npx tsx scripts/seed-tenant-policies.ts --verify   (no writes — prints the registered action-type count)

import "dotenv/config";
import { isDeepStrictEqual } from "node:util";
import { withTenant, closePool, domainPolicies, domainPolicyRevisions, priceBookItems } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { createDefaultPluginRegistry } from "@finnor/orchestration";
import { PRICING_CATALOG_ACTION_TYPE } from "../packages/domain-plugins/shared/pricing-catalog";

const DEALER_ZERO_REVIEW_LINK = "https://g.page/r/dealer-zero-finnor-water-co/review";

interface PolicyRow {
  actionType: string;
  policy: Record<string, unknown>;
  requiresConfirmation: boolean;
  confirmationTemplate?: string | null;
}

export interface PolicyOverride {
  policy?: Record<string, unknown>;
  requiresConfirmation?: boolean;
  confirmationTemplate?: string | null;
}

function mergePolicy(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = value && current && typeof value === "object" && typeof current === "object"
      && !Array.isArray(value) && !Array.isArray(current)
      ? mergePolicy(current as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return merged;
}

// One row per action type in policy-matrix.md — the 41 registered types, in the same
// order as the matrix's sections. `reviewLinkUrl` is threaded in below, not hardcoded
// here, since it's the one genuinely tenant-specific field (see the matrix's
// "Owner-blocked field" section).
export function policyRows(reviewLinkUrl: string | null, overrides: Record<string, PolicyOverride> = {}): PolicyRow[] {
  const rows: PolicyRow[] = [
    { actionType: "schedule_water_test", policy: { service_radius_miles: 25, default_duration_minutes: 45, allowed_windows: ["09:00-12:00", "13:00-17:00"] }, requiresConfirmation: true, confirmationTemplate: "Schedule a water test at {{address}} on {{scheduled_at}} with {{technician}}. Approve?" },
    { actionType: "renew_maintenance_agreement", policy: { renewal_window_days: 30, price_usd: 249, cadence_options: ["annual", "semi_annual"] }, requiresConfirmation: true, confirmationTemplate: "Send a renewal offer to {{household}} for their {{cadence}} maintenance agreement. Approve?" },

    { actionType: "create_lead", policy: {}, requiresConfirmation: true },
    { actionType: "update_lead_status", policy: {}, requiresConfirmation: true },
    { actionType: "log_interaction", policy: {}, requiresConfirmation: true },
    { actionType: "assign_lead_to_technician", policy: {}, requiresConfirmation: true },

    { actionType: "check_stock_level", policy: {}, requiresConfirmation: false },
    // autoDraftReorderFlags is read by scan_low_inventory, not the plugin itself — §3.4
    // detection loop: below-threshold stock drafts a real flag_reorder_needed action.
    { actionType: "flag_reorder_needed", policy: { autoDraftReorderFlags: true }, requiresConfirmation: false },
    { actionType: "log_stock_used_on_visit", policy: {}, requiresConfirmation: true },

    { actionType: "assign_technician_to_visit", policy: {}, requiresConfirmation: true },
    { actionType: "check_technician_availability", policy: {}, requiresConfirmation: false },
    { actionType: "reschedule_visit", policy: {}, requiresConfirmation: true },

    { actionType: "size_equipment_for_household", policy: {}, requiresConfirmation: false },
    { actionType: "generate_quote", policy: {}, requiresConfirmation: true },
    { actionType: "send_proposal", policy: {}, requiresConfirmation: true },

    { actionType: "create_invoice", policy: {}, requiresConfirmation: true },
    { actionType: "send_payment_reminder", policy: {}, requiresConfirmation: true },
    { actionType: "record_payment", policy: {}, requiresConfirmation: true },
    { actionType: "call_overdue_invoices", policy: {}, requiresConfirmation: true },

    { actionType: "summarize_ad_performance", policy: {}, requiresConfirmation: false },
    { actionType: "launch_ad_campaign", policy: { default_daily_budget_usd: 30, max_daily_budget_usd: 50 }, requiresConfirmation: true },
    {
      actionType: "create_review_request",
      policy: reviewLinkUrl ? { review_link_url: reviewLinkUrl, channel: "sms" } : { review_link_url: "PLACEHOLDER_NEEDS_REAL_VALUE", channel: "sms" },
      requiresConfirmation: true,
    },

    { actionType: "answer_customer_question", policy: {}, requiresConfirmation: true },
    { actionType: "send_customer_message", policy: {}, requiresConfirmation: true },
    // serviceDueScript is read by scan_service_due, not the plugin itself — §3.4
    // detection loop: a due reminder drafts a real, gated send_follow_up.
    {
      actionType: "send_follow_up",
      policy: { serviceDueScript: "Hi! Our records show your {{equipmentType}} may be due for service. Reply or call to book a visit — happy to answer any questions in the meantime." },
      requiresConfirmation: true,
    },

    { actionType: "answer_water_question", policy: {}, requiresConfirmation: false },

    { actionType: "send_proposal_to_recent_installs", policy: { window_days_default: 30, max_batch: 10 }, requiresConfirmation: true },

    { actionType: "bulk_notify_existing_customers", policy: {}, requiresConfirmation: true },

    { actionType: "log_visit_report", policy: {}, requiresConfirmation: false },
    { actionType: "flag_visit_issue", policy: {}, requiresConfirmation: false },

    { actionType: "check_reminder_due", policy: { sediment_filter_months: "3-6", carbon_filter_months: "6-12", ro_membrane_years: "2-3" }, requiresConfirmation: false },

    {
      actionType: "generate_compliance_summary",
      policy: {
        pfoa_mcl_ppt: 4,
        pfos_mcl_ppt: 4,
        fluoride_mcl_mg_l: 4.0,
        fluoride_secondary_standard_mg_l: 2.0,
        hardness_classification_gpg: { soft: "<1", slightly_hard: "1-3.5", moderately_hard: "3.5-7", hard: "7-10.5", very_hard: ">10.5" },
        source: "EPA National Primary/Secondary Drinking Water Regulations",
        paperwork_format: "pdf",
      },
      requiresConfirmation: false,
    },

    { actionType: "search_web", policy: {}, requiresConfirmation: false },
    { actionType: "scan_competitors", policy: {}, requiresConfirmation: false },
    { actionType: "check_business_reviews", policy: {}, requiresConfirmation: false },

    { actionType: "get_business_overview", policy: {}, requiresConfirmation: false },
    { actionType: "answer_business_question", policy: {}, requiresConfirmation: false },

    { actionType: "start_water_test_workflow", policy: {}, requiresConfirmation: true },
    { actionType: "request_proposal_signature", policy: {}, requiresConfirmation: true },
    { actionType: "start_installation_workflow", policy: {}, requiresConfirmation: true },
    { actionType: "start_invoice_to_cash_workflow", policy: {}, requiresConfirmation: true },

    // Planner safety/advisory actions are registered plugins too, so every tenant
    // receives a real policy row rather than relying on an implicit fallback.
    // clarification_request deliberately remains in the normal pending queue; it
    // records a human question and never authorizes the missing business action.
    { actionType: "clarification_request", policy: {}, requiresConfirmation: true },
    { actionType: "manual_step_suggestion", policy: {}, requiresConfirmation: false },
    { actionType: "route_suggestion", policy: {}, requiresConfirmation: true },

    // Phase 2 Universal Action + Delegation Fabric. Route selection and identity
    // resolution remain runtime-owned; these rows contain business policy only.
    { actionType: "send_message", policy: {}, requiresConfirmation: true },
    { actionType: "place_call", policy: {}, requiresConfirmation: true },
    { actionType: "request_acknowledgement", policy: {}, requiresConfirmation: true },
    { actionType: "notify_group", policy: {}, requiresConfirmation: true },
    { actionType: "create_task", policy: {}, requiresConfirmation: true },
    { actionType: "assign_task", policy: {}, requiresConfirmation: true },
    { actionType: "update_task", policy: {}, requiresConfirmation: true },
    { actionType: "handoff_work", policy: {}, requiresConfirmation: true },
    { actionType: "delegate_objective", policy: {}, requiresConfirmation: true },
    { actionType: "escalate_work", policy: {}, requiresConfirmation: true },
    { actionType: "cancel_delegation", policy: {}, requiresConfirmation: true },
    { actionType: "schedule_internal_event", policy: {}, requiresConfirmation: true },
    { actionType: "reschedule_internal_event", policy: {}, requiresConfirmation: true },
    { actionType: "share_document", policy: {}, requiresConfirmation: true },

    // Phase 3 Computer Execution Fabric. READ_ONLY may be relaxed by an explicit
    // tenant override; WRITE remains confirmation-gated by the plugin itself.
    { actionType: "computer_task", policy: {}, requiresConfirmation: true },

    // Private Equity Phase 4. Core authority can still require approval for any
    // row; waiver and close also carry non-downgradeable hardening floors.
    { actionType: "open_workstream", policy: {}, requiresConfirmation: false },
    { actionType: "create_deal_request", policy: {}, requiresConfirmation: false },
    { actionType: "submit_deliverable", policy: {}, requiresConfirmation: false },
    { actionType: "record_finding", policy: {}, requiresConfirmation: false },
    { actionType: "resolve_finding", policy: {}, requiresConfirmation: false },
    { actionType: "raise_deal_risk", policy: {}, requiresConfirmation: false },
    { actionType: "resolve_deal_risk", policy: {}, requiresConfirmation: false },
    { actionType: "link_deal_dependency", policy: {}, requiresConfirmation: false },
    { actionType: "mark_dependency_resolved", policy: {}, requiresConfirmation: false },
    { actionType: "create_closing_condition", policy: {}, requiresConfirmation: false },
    { actionType: "submit_condition_evidence", policy: {}, requiresConfirmation: false },
    { actionType: "satisfy_closing_condition", policy: {}, requiresConfirmation: false },
    { actionType: "waive_closing_condition", policy: {}, requiresConfirmation: true },
    { actionType: "verify_closing_item", policy: {}, requiresConfirmation: false },
    { actionType: "declare_deal_closed", policy: {}, requiresConfirmation: true },

    // The pricing_catalog pseudo-row: scalars only (DECISIONS: labor $95/h). Real US
    // sales-tax rates vary by state/locality — 7% is a real, usable generic default the
    // dealer localizes later, not the placeholder sentinel.
    { actionType: PRICING_CATALOG_ACTION_TYPE, policy: { laborRatePerHourUsd: 95, taxRatePct: 7, items: [] }, requiresConfirmation: false },
  ];
  return rows.map((row) => {
    const override = overrides[row.actionType];
    if (!override) return row;
    return {
      ...row,
      policy: override.policy ? mergePolicy(row.policy, override.policy) : row.policy,
      requiresConfirmation: override.requiresConfirmation ?? row.requiresConfirmation,
      confirmationTemplate: override.confirmationTemplate === undefined
        ? row.confirmationTemplate
        : override.confirmationTemplate,
    };
  });
}

// The 12-20 item price book (policy-matrix.md §Pricing) — RO systems, softeners,
// filters, consumables, priced for a realistic mid-market US water-treatment dealer.
const PRICE_BOOK_ITEMS: Array<{ sku: string; label: string; priceUsd: number }> = [
  { sku: "RO-STD", label: "Standard 4-Stage Reverse Osmosis System", priceUsd: 899 },
  { sku: "RO-PRM", label: "Premium 6-Stage Reverse Osmosis System (Remineralizing)", priceUsd: 1349 },
  { sku: "SOFT-32K", label: "32,000 Grain Water Softener", priceUsd: 1199 },
  { sku: "SOFT-48K", label: "48,000 Grain Water Softener", priceUsd: 1549 },
  { sku: "SOFT-64K", label: "64,000 Grain Whole-House Water Softener", priceUsd: 1899 },
  { sku: "FILT-SED", label: "Sediment Pre-Filter Cartridge", priceUsd: 18 },
  { sku: "FILT-CARB", label: "Carbon Block Filter Cartridge", priceUsd: 24 },
  { sku: "FILT-WH-SED", label: "Whole-House Sediment Filter Housing", priceUsd: 149 },
  { sku: "FILT-WH-CARB", label: "Whole-House Carbon Filtration System", priceUsd: 649 },
  { sku: "MEMB-RO", label: "RO Membrane Replacement (50 GPD)", priceUsd: 65 },
  { sku: "UV-STER", label: "UV Water Sterilization System", priceUsd: 749 },
  { sku: "NEUT-CAL", label: "Calcite Acid Neutralizer System (pH Correction)", priceUsd: 1099 },
  { sku: "IRON-FILT", label: "Iron & Sulfur Removal Filter System", priceUsd: 1299 },
  { sku: "TANK-PRESS", label: "Well Pressure Tank (20-Gallon)", priceUsd: 399 },
  { sku: "SALT-BAG", label: "Water Softener Salt (40lb bag)", priceUsd: 9 },
];

export interface SeedTenantPoliciesResult {
  actionTypesSeeded: number;
  inserted: number;
  updated: number;
  unchanged: number;
  priceBookItemsSeeded: number;
  registeredActionTypeCount: number;
  missingFromMatrix: string[];
  extraInMatrix: string[];
}

export async function seedTenantPolicies(
  tenantId: string,
  opts: { reviewLinkUrl?: string | null; overrides?: Record<string, PolicyOverride> } = {},
): Promise<SeedTenantPoliciesResult> {
  const registry = createDefaultPluginRegistry();
  const registered = new Set(registry.actionTypes());
  const rows = policyRows(opts.reviewLinkUrl ?? null, opts.overrides ?? {});
  const knownPolicyTypes = new Set(rows.map((row) => row.actionType));
  const unknownOverrides = Object.keys(opts.overrides ?? {}).filter((actionType) => !knownPolicyTypes.has(actionType));
  if (unknownOverrides.length > 0) {
    throw new Error(`Unknown policy override action types: ${unknownOverrides.join(", ")}`);
  }
  const matrixTypes = new Set(rows.map((r) => r.actionType).filter((t) => t !== PRICING_CATALOG_ACTION_TYPE));

  // Cross-check: the matrix must cover every currently-registered action type, and
  // never claim to cover one that no longer exists — a real drift detector, not a
  // silent staleness risk as plugins get added/removed over time.
  const missingFromMatrix = [...registered].filter((t) => !matrixTypes.has(t));
  const extraInMatrix = [...matrixTypes].filter((t) => !registered.has(t));

  let actionTypesSeeded = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  await withTenant(tenantId, async (db) => {
    for (const row of rows) {
      const desiredTemplate = row.confirmationTemplate ?? null;
      const [created] = await db.insert(domainPolicies).values({
        tenantId,
        actionType: row.actionType,
        policy: row.policy,
        requiresConfirmation: row.requiresConfirmation,
        confirmationTemplate: desiredTemplate,
      }).onConflictDoNothing({ target: [domainPolicies.tenantId, domainPolicies.actionType] }).returning();

      const [existing] = created ? [] : await db
        .select()
        .from(domainPolicies)
        .where(and(eq(domainPolicies.tenantId, tenantId), eq(domainPolicies.actionType, row.actionType)))
        .for("update");
      if (!created && !existing) throw new Error(`Policy seed could not lock ${row.actionType}`);

      const changed = Boolean(existing) && (
        !isDeepStrictEqual(existing!.policy, row.policy)
        || existing!.requiresConfirmation !== row.requiresConfirmation
        || existing!.confirmationTemplate !== desiredTemplate
      );
      const [persisted] = changed
        ? await db
          .update(domainPolicies)
          .set({
            policy: row.policy,
            requiresConfirmation: row.requiresConfirmation,
            confirmationTemplate: desiredTemplate,
            version: existing!.version + 1,
            effectiveFrom: new Date(),
          })
          .where(eq(domainPolicies.id, existing!.id))
          .returning()
        : [created ?? existing!];
      if (!persisted) throw new Error(`Policy seed did not persist ${row.actionType}`);
      if (created || changed) {
        await db.insert(domainPolicyRevisions).values({
          tenantId,
          policyId: persisted.id,
          actionType: persisted.actionType,
          version: persisted.version,
          policy: persisted.policy,
          requiresConfirmation: persisted.requiresConfirmation,
          confirmationTemplate: persisted.confirmationTemplate,
          modelProvider: persisted.modelProvider,
          confirmationTimeoutHours: persisted.confirmationTimeoutHours,
          effectiveFrom: persisted.effectiveFrom,
        });
      }
      if (created) inserted++;
      else if (changed) updated++;
      else unchanged++;
      actionTypesSeeded++;
    }
  });

  let priceBookItemsSeeded = 0;
  await withTenant(tenantId, async (db) => {
    for (const item of PRICE_BOOK_ITEMS) {
      const desiredPrice = item.priceUsd.toFixed(2);
      const [created] = await db.insert(priceBookItems).values({
        tenantId,
        sku: item.sku,
        label: item.label,
        priceUsd: desiredPrice,
        unitOfMeasure: "each",
      }).onConflictDoNothing({ target: [priceBookItems.tenantId, priceBookItems.sku] }).returning();
      if (!created) {
        const [existing] = await db.select().from(priceBookItems)
          .where(and(eq(priceBookItems.tenantId, tenantId), eq(priceBookItems.sku, item.sku)))
          .for("update");
        if (!existing) throw new Error(`Price-book seed could not lock ${item.sku}`);
        if (existing.label !== item.label || existing.priceUsd !== desiredPrice || existing.unitOfMeasure !== "each") {
          await db.update(priceBookItems).set({
            label: item.label,
            priceUsd: desiredPrice,
            unitOfMeasure: "each",
            updatedAt: new Date(),
          }).where(eq(priceBookItems.id, existing.id));
        }
      }
      priceBookItemsSeeded++;
    }
  });

  return { actionTypesSeeded, inserted, updated, unchanged, priceBookItemsSeeded, registeredActionTypeCount: registered.size, missingFromMatrix, extraInMatrix };
}

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    }),
  );
  return {
    tenant: args.tenant as string | undefined,
    dealerZero: "dealerZero" in args,
    reviewLinkUrl: (args.reviewLinkUrl as string | undefined) ?? process.env.PRIMARY_TENANT_REVIEW_LINK_URL,
    verify: "verify" in args,
  };
}

const isMain = process.argv[1]?.endsWith("seed-tenant-policies.ts") || process.argv[1]?.endsWith("seed-tenant-policies.js");
if (isMain) {
  const { tenant, dealerZero, reviewLinkUrl, verify } = parseArgs();
  if (verify) {
    const registry = createDefaultPluginRegistry();
    console.log(`Registered action types: ${registry.actionTypes().length}`);
    closePool().then(() => process.exit(0));
  } else {
    if (!tenant) {
      console.error("Usage: npx tsx scripts/seed-tenant-policies.ts --tenant=<uuid> [--reviewLinkUrl=<url>] [--dealerZero]");
      process.exit(1);
    }
    const effectiveReviewLink = dealerZero ? DEALER_ZERO_REVIEW_LINK : reviewLinkUrl ?? null;
    seedTenantPolicies(tenant, { reviewLinkUrl: effectiveReviewLink })
      .then(async (result) => {
        console.log(`Seeded ${result.actionTypesSeeded} policy rows + ${result.priceBookItemsSeeded} price book items for tenant ${tenant}.`);
        console.log(`Registered action types: ${result.registeredActionTypeCount}.`);
        if (result.missingFromMatrix.length > 0) console.warn(`MATRIX GAP — registered but not in policy-matrix.md: ${result.missingFromMatrix.join(", ")}`);
        if (result.extraInMatrix.length > 0) console.warn(`MATRIX STALE — in policy-matrix.md but not registered: ${result.extraInMatrix.join(", ")}`);
        if (!effectiveReviewLink) console.warn("create_review_request.review_link_url left as PLACEHOLDER_NEEDS_REAL_VALUE — pass --reviewLinkUrl or --dealerZero.");
        await closePool();
      })
      .catch(async (err) => {
        console.error(err);
        await closePool();
        process.exit(1);
      });
  }
}
