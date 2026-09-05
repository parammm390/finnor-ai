// P1.T1 — deterministic, guarded certification data. This seed is intentionally
// separate from the developer seed: it creates the three fixed Phase 1 tenants and
// the entity ids consumed by the parameterized contract matrix.

import pg from "pg";
import { pgConnectionConfig } from "../../packages/db/index";
import { actionHardeningSpecForVertical } from "./action-hardening-spec";

const WATER_ACTION_HARDENING_SPEC = actionHardeningSpecForVertical("water");

export type CertificationTenantKey = "alpha" | "bravo" | "charlie";

export const CERTIFICATION_TENANTS: Record<CertificationTenantKey, { id: string; alias: string; marker: string }> = {
  alpha: { id: "00000000-0000-4000-8000-0000000000a1", alias: "Alpha", marker: "ALPHA-CERTIFICATION" },
  bravo: { id: "00000000-0000-4000-8000-0000000000b1", alias: "Bravo", marker: "BRAVO-ISOLATION-SENTINEL" },
  charlie: { id: "00000000-0000-4000-8000-0000000000c1", alias: "Charlie", marker: "CHARLIE-CONFIGURATION" },
};

const RESOURCE_PREFIX: Record<CertificationTenantKey, Record<string, string>> = {
  alpha: { technician: "a0100000", user: "a0200000", household: "a1000000", contact: "a2000000", lead: "a3000000", opportunity: "a4000000", quote: "a5000000", quoteLine: "a5100000", invoice: "a6000000", workOrder: "a7000000", visit: "a7100000", appointment: "a7200000", proposal: "a8000000", agreement: "a8100000", conversation: "a9000000", call: "a9100000", message: "a9200000", document: "a9300000", warehouse: "a9400000", stock: "a9500000", policy: "aa000000", revision: "aa100000", action: "aa200000", permission: "aa300000", orgUnit: "ab000000", work: "ab100000", task: "ab200000", delegation: "ab300000", internalEvent: "ab400000" },
  bravo: { technician: "b0100000", user: "b0200000", household: "b1000000", contact: "b2000000", lead: "b3000000", opportunity: "b4000000", quote: "b5000000", quoteLine: "b5100000", invoice: "b6000000", workOrder: "b7000000", visit: "b7100000", appointment: "b7200000", proposal: "b8000000", agreement: "b8100000", conversation: "b9000000", call: "b9100000", message: "b9200000", document: "b9300000", warehouse: "b9400000", stock: "b9500000", policy: "ba000000", revision: "ba100000", action: "ba200000", permission: "ba300000", orgUnit: "bb000000", work: "bb100000", task: "bb200000", delegation: "bb300000", internalEvent: "bb400000" },
  charlie: { technician: "c0100000", user: "c0200000", household: "c1000000", contact: "c2000000", lead: "c3000000", opportunity: "c4000000", quote: "c5000000", quoteLine: "c5100000", invoice: "c6000000", workOrder: "c7000000", visit: "c7100000", appointment: "c7200000", proposal: "c8000000", agreement: "c8100000", conversation: "c9000000", call: "c9100000", message: "c9200000", document: "c9300000", warehouse: "c9400000", stock: "c9500000", policy: "ca000000", revision: "ca100000", action: "ca200000", permission: "ca300000", orgUnit: "cb000000", work: "cb100000", task: "cb200000", delegation: "cb300000", internalEvent: "cb400000" },
};

export function certificationId(tenant: CertificationTenantKey, resource: string, ordinal: number): string {
  const prefix = RESOURCE_PREFIX[tenant][resource];
  if (!prefix || ordinal < 1 || ordinal > 999_999_999_999) throw new Error(`Unknown certification id ${tenant}/${resource}/${ordinal}`);
  return `${prefix}-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function requiredAllowlist(name: string): string[] {
  const values = (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one explicit certification value`);
  return values;
}

function markerFor(tenant: CertificationTenantKey, family: string, ordinal: number): string {
  return `${CERTIFICATION_TENANTS[tenant].marker}:${family}:${String(ordinal).padStart(2, "0")}`;
}

export function certificationPolicyForAction(actionType: string, capabilityFamily: string, approvalFloor: string): Record<string, unknown> {
  if (actionType === "schedule_water_test") {
    return { service_radius_miles: 50, default_duration_minutes: 45, allowed_windows: ["09:00-12:00", "13:00-17:00"], certification: true };
  }
  if (actionType === "renew_maintenance_agreement") {
    return { renewal_window_days: 30, price_usd: 250, cadence_options: ["annual", "semi_annual"], certification: true };
  }
  if (actionType === "generate_compliance_summary") {
    return {
      pfoa_mcl_ppt: 4,
      pfos_mcl_ppt: 4,
      fluoride_mcl_mg_l: 4,
      fluoride_secondary_standard_mg_l: 2,
      hardness_classification_gpg: { soft: "<1", slightly_hard: "1-3.5", moderately_hard: "3.5-7", hard: "7-10.5", very_hard: ">10.5" },
      source: "EPA National Primary/Secondary Drinking Water Regulations",
      certification: true,
    };
  }
  if (actionType === "check_reminder_due") return { sediment_filter_months: "3-6", carbon_filter_months: "6-12", ro_membrane_years: "2-3", certification: true };
  return { capabilityFamily, approvalFloor, certification: true };
}

async function insertTenant(client: pg.Client, tenant: CertificationTenantKey, testEmails: string[], testPhones: string[]): Promise<void> {
  const config = CERTIFICATION_TENANTS[tenant];
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [config.id]);
  await client.query(
    `INSERT INTO tenants (id, name, owner_phone, timezone) VALUES ($1, $2, $3, 'America/Chicago')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_phone = EXCLUDED.owner_phone`,
    [config.id, `Certification Tenant ${config.alias}`, testPhones[0]],
  );
  await client.query(
    `INSERT INTO tenant_settings (tenant_id, is_dealer_zero, simulator_enabled, training_mode)
     VALUES ($1, false, false, true)
     ON CONFLICT (tenant_id) DO UPDATE SET training_mode = true, simulator_enabled = false`,
    [config.id],
  );

  for (let i = 1; i <= 10; i += 1) {
    const id = certificationId(tenant, "technician", i);
    await client.query(
      `INSERT INTO technicians (id, tenant_id, name, contact_info, availability)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, contact_info = EXCLUDED.contact_info, availability = EXCLUDED.availability`,
      [id, config.id, `${config.alias} Technician ${String(i).padStart(2, "0")}`, JSON.stringify({ phone: testPhones[i % testPhones.length] }), JSON.stringify({ mon_fri: "08:00-17:00" })],
    );
  }

  const userCount = tenant === "alpha" ? 15 : 3;
  for (let i = 1; i <= userCount; i += 1) {
    // The database role enum is intentionally limited to owner/dispatcher/technician;
    // Alpha's second owner slot is the §4 finance/admin semantic user without a schema change.
    const role = tenant === "alpha" ? (i === 1 || i === 15 ? "owner" : i <= 4 ? "dispatcher" : "technician") : i === 1 ? "owner" : "dispatcher";
    const technicianId = role === "technician" ? certificationId(tenant, "technician", i - 4) : null;
    const email = `${tenant}.certification.user.${String(i).padStart(2, "0")}@example.invalid`;
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, technician_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email, role = EXCLUDED.role, technician_id = EXCLUDED.technician_id`,
      [certificationId(tenant, "user", i), config.id, email, role, technicianId],
    );
  }

  for (let i = 1; i <= 40; i += 1) {
    const householdId = certificationId(tenant, "household", i);
    const marker = markerFor(tenant, "household", i);
    await client.query(
      `INSERT INTO households (id, tenant_id, address, contact_info, water_profile, marketing_consent)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, true)
       ON CONFLICT (id) DO UPDATE SET address = EXCLUDED.address, contact_info = EXCLUDED.contact_info, water_profile = EXCLUDED.water_profile, marketing_consent = true`,
      [householdId, config.id, `${tenant.toUpperCase()} ${String(i).padStart(2, "0")} Certification Household`, JSON.stringify({ name: `${config.alias} Contact ${i}`, phone: testPhones[i % testPhones.length] }), JSON.stringify({ hardness_gpg: 14 + (i % 5), iron_ppm: 0.2, source: "certification", marker })],
    );
    const contactId = certificationId(tenant, "contact", i);
    await client.query(
      `INSERT INTO contacts (id, tenant_id, household_id, name, role, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, 'primary', 'certification', $5, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET household_id = EXCLUDED.household_id, name = EXCLUDED.name, external_id = EXCLUDED.external_id`,
      [contactId, config.id, householdId, `${config.alias} Contact ${String(i).padStart(2, "0")}`, marker],
    );
    await client.query(
      `INSERT INTO contact_methods (id, tenant_id, contact_id, method_type, value, consent, consent_recorded_at)
       VALUES ($1, $2, $3, 'phone', $4, true, now()), ($5, $2, $3, 'email', $6, true, now())
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, consent = true, consent_recorded_at = now()`,
      [certificationId(tenant, "contact", i * 2 - 1), config.id, contactId, testPhones[i % testPhones.length], certificationId(tenant, "contact", i * 2), testEmails[i % testEmails.length]],
    );
  }

  for (let i = 1; i <= 20; i += 1) {
    const id = certificationId(tenant, "lead", i);
    const marker = markerFor(tenant, "lead", i);
    await client.query(
      `INSERT INTO leads (id, tenant_id, household_id, contact_method_id, name, phone, email, address, status, source, notes, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'certification', $10, 'certification', $11, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET household_id = EXCLUDED.household_id, contact_method_id = EXCLUDED.contact_method_id, name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email, notes = EXCLUDED.notes, external_id = EXCLUDED.external_id`,
      [id, config.id, certificationId(tenant, "household", i), certificationId(tenant, "contact", i * 2 - 1), `${config.alias} Lead ${String(i).padStart(2, "0")}`, testPhones[i % testPhones.length], testEmails[i % testEmails.length], `${config.alias} lead address ${i}`, i % 3 === 0 ? "qualified" : "new", marker, marker],
    );
  }

  for (let i = 1; i <= 12; i += 1) {
    await client.query(
      `INSERT INTO opportunities (id, tenant_id, lead_id, household_id, pipeline_stage, expected_value_usd, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'certification', $7, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET pipeline_stage = EXCLUDED.pipeline_stage, expected_value_usd = EXCLUDED.expected_value_usd, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "opportunity", i), config.id, certificationId(tenant, "lead", i), certificationId(tenant, "household", i), i % 4 === 0 ? "won" : "open", String(1200 + i * 50), markerFor(tenant, "opportunity", i)],
    );
  }

  for (let i = 1; i <= 10; i += 1) {
    const quoteId = certificationId(tenant, "quote", i);
    await client.query(
      `INSERT INTO quotes (id, tenant_id, household_id, lead_id, opportunity_id, status, total_usd, valid_until, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'sent', $6, now() + interval '30 days', 'certification', $7, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET status = 'sent', total_usd = EXCLUDED.total_usd, external_id = EXCLUDED.external_id`,
      [quoteId, config.id, certificationId(tenant, "household", i), certificationId(tenant, "lead", i), certificationId(tenant, "opportunity", i), String(1800 + i * 100), markerFor(tenant, "quote", i)],
    );
    await client.query(
      `INSERT INTO quote_line_items (id, tenant_id, quote_id, sku, label, quantity, unit_price_usd)
       VALUES ($1, $2, $3, 'SOFT-48K-PRO', 'Whole-home softener', 1, 1800)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, unit_price_usd = EXCLUDED.unit_price_usd`,
      [certificationId(tenant, "quoteLine", i), config.id, quoteId],
    );
  }

  for (let i = 1; i <= 8; i += 1) {
    await client.query(
      `INSERT INTO invoices (id, tenant_id, household_id, amount_usd, status, memo, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 day')
       ON CONFLICT (id) DO UPDATE SET household_id = EXCLUDED.household_id, amount_usd = EXCLUDED.amount_usd, status = EXCLUDED.status, memo = EXCLUDED.memo, due_date = EXCLUDED.due_date`,
      [certificationId(tenant, "invoice", i), config.id, certificationId(tenant, "household", i), String(500 + i * 125), i <= 4 ? "overdue" : i <= 6 ? "paid" : "sent", markerFor(tenant, "invoice", i), i <= 4 ? -14 : 30],
    );
  }

  for (let i = 1; i <= 10; i += 1) {
    await client.query(
      `INSERT INTO work_orders (id, tenant_id, household_id, quote_id, type, status, technician_id, deposit_amount_usd, stock_reservation, scheduled_at, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, 'install', $5, $6, 350, $7::jsonb, now() + interval '2 days', 'certification', $8, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, stock_reservation = EXCLUDED.stock_reservation, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "workOrder", i), config.id, certificationId(tenant, "household", i), certificationId(tenant, "quote", i), i % 3 === 0 ? "completed" : "scheduled", certificationId(tenant, "technician", i), JSON.stringify({ sku: "SOFT-48K-PRO", quantity: 1, marker: markerFor(tenant, "work_order", i) }), markerFor(tenant, "work_order", i)],
    );
  }

  for (let i = 1; i <= 12; i += 1) {
    await client.query(
      `INSERT INTO service_visits (id, household_id, technician_id, type, scheduled_at, completed_at, notes)
       VALUES ($1, $2, $3, $4, now() + $5 * interval '1 day', $6, $7)
       ON CONFLICT (id) DO UPDATE SET technician_id = EXCLUDED.technician_id, type = EXCLUDED.type, notes = EXCLUDED.notes`,
      [certificationId(tenant, "visit", i), certificationId(tenant, "household", i), certificationId(tenant, "technician", ((i - 1) % 10) + 1), i <= 4 ? "install" : "water_test", i, i <= 4 ? new Date(Date.now() - 86400000) : null, markerFor(tenant, "visit", i)],
    );
    await client.query(
      `INSERT INTO appointments (id, tenant_id, subject_type, subject_id, technician_id, status, scheduled_at, duration_minutes, notes, source_system, external_id, created_by)
       VALUES ($1, $2, 'household', $3, $4, 'confirmed', now() + $5 * interval '1 day', 60, $6, 'certification', $7, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET status = 'confirmed', notes = EXCLUDED.notes, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "appointment", i), config.id, certificationId(tenant, "household", i), certificationId(tenant, "technician", ((i - 1) % 10) + 1), i, markerFor(tenant, "appointment", i), markerFor(tenant, "appointment", i)],
    );
  }

  for (let i = 1; i <= 8; i += 1) {
    await client.query(
      `INSERT INTO proposals (id, household_id, quote_id, content, status, sent_at)
       VALUES ($1, $2, $3, $4::jsonb, 'sent', now() - interval '2 days')
       ON CONFLICT (id) DO UPDATE SET quote_id = EXCLUDED.quote_id, content = EXCLUDED.content, status = 'sent'`,
      [certificationId(tenant, "proposal", i), certificationId(tenant, "household", i), certificationId(tenant, "quote", i), JSON.stringify({ title: `${config.alias} certification proposal ${i}`, marker: markerFor(tenant, "proposal", i) })],
    );
  }

  for (let i = 1; i <= 3; i += 1) {
    await client.query(
      `INSERT INTO maintenance_agreements (id, household_id, cadence, terms, status, renewal_date)
       VALUES ($1, $2, 'annual', $3::jsonb, 'renewal_window', now() + interval '21 days')
       ON CONFLICT (id) DO UPDATE SET terms = EXCLUDED.terms, status = 'renewal_window', renewal_date = EXCLUDED.renewal_date`,
      [certificationId(tenant, "agreement", i), certificationId(tenant, "household", i), JSON.stringify({ plan: "certification", marker: markerFor(tenant, "agreement", i) })],
    );
  }

  const stock = [
    ["SED-FILT-10", "Sediment filter", 24, 10],
    ["CARB-FILT-10", "Carbon filter", 18, 8],
    ["RO-MEM-75", "RO membrane", 6, 3],
    ["RESIN-CUFT", "Softener resin", 12, 4],
    ["UV-BULB-STD", "UV bulb", 2, 5],
    ["PREFILT-HSG", "Pre-filter housing", 9, 3],
  ];
  for (let i = 0; i < stock.length; i += 1) {
    const [sku, name, quantity, reorder] = stock[i]!;
    await client.query(
      `INSERT INTO inventory_items (id, tenant_id, sku, name, quantity, reorder_threshold, unit_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, 25)
       ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, name = EXCLUDED.name, quantity = EXCLUDED.quantity, reorder_threshold = EXCLUDED.reorder_threshold`,
      [certificationId(tenant, "stock", i + 1), config.id, sku, tenant === "bravo" ? `${name} ${config.marker}` : name, quantity, reorder],
    );
  }

  const warehouseId = certificationId(tenant, "warehouse", 1);
  await client.query(
    `INSERT INTO warehouses (id, tenant_id, name, address, is_default) VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, is_default = true`,
    [warehouseId, config.id, `${config.alias} Certification Warehouse`, `${config.alias} staging address`],
  );
  for (let i = 0; i < stock.length; i += 1) {
    await client.query(
      `INSERT INTO warehouse_stock (id, tenant_id, warehouse_id, sku, quantity, unit_of_measure, reorder_threshold)
       VALUES ($1, $2, $3, $4, $5, 'each', $6)
       ON CONFLICT (id) DO UPDATE SET quantity = EXCLUDED.quantity, reorder_threshold = EXCLUDED.reorder_threshold`,
      [certificationId(tenant, "stock", i + 20), config.id, warehouseId, stock[i]![0], stock[i]![2], stock[i]![3]],
    );
  }
  for (let i = 1; i <= 6; i += 1) {
    await client.query(
      `INSERT INTO price_book_items (id, tenant_id, sku, label, price_usd, unit_of_measure, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'each', 'certification', $6, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, price_usd = EXCLUDED.price_usd, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "warehouse", i + 10), config.id, stock[i - 1]![0], stock[i - 1]![1], String(25 + i * 100), markerFor(tenant, "price_book", i)],
    );
  }

  for (let i = 1; i <= 4; i += 1) {
    const conversationId = certificationId(tenant, "conversation", i);
    await client.query(
      `INSERT INTO conversations (id, tenant_id, household_id, contact_id, channel, status, last_activity_at, source_system, external_id, created_by)
       VALUES ($1, $2, $3, $4, 'sms', 'closed', now(), 'certification', $5, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET status = 'closed', external_id = EXCLUDED.external_id`,
      [conversationId, config.id, certificationId(tenant, "household", i), certificationId(tenant, "contact", i), markerFor(tenant, "conversation", i)],
    );
    await client.query(
      `INSERT INTO calls (id, tenant_id, conversation_id, direction, from_number, to_number, transcript, ended_reason, raw, source_system, external_id, created_by)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'completed', $7::jsonb, 'certification', $8, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET transcript = EXCLUDED.transcript, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "call", i), config.id, conversationId, testPhones[i % testPhones.length], testPhones[0], `${config.alias} certification call ${i}`, JSON.stringify({ marker: markerFor(tenant, "call", i) }), markerFor(tenant, "call", i)],
    );
    await client.query(
      `INSERT INTO messages (id, tenant_id, conversation_id, direction, channel, content, source_system, external_id, created_by)
       VALUES ($1, $2, $3, 'outbound', 'sms', $4, 'certification', $5, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "message", i), config.id, conversationId, `${config.alias} certification message ${i} ${markerFor(tenant, "message", i)}`, markerFor(tenant, "message", i)],
    );
  }
  for (let i = 1; i <= 8; i += 1) {
    await client.query(
      `INSERT INTO documents (id, tenant_id, household_id, kind, title, storage_ref, source_system, external_id, created_by)
       VALUES ($1, $2, $3, 'proposal_pdf', $4, $5, 'certification', $6, 'release-seed')
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, external_id = EXCLUDED.external_id`,
      [certificationId(tenant, "document", i), config.id, certificationId(tenant, "household", i), `${config.alias} certification document ${i}`, `certification/${tenant}/document/${i}`, markerFor(tenant, "document", i)],
    );
  }

  for (const spec of WATER_ACTION_HARDENING_SPEC) {
    const policyId = certificationId(tenant, "policy", WATER_ACTION_HARDENING_SPEC.indexOf(spec) + 1);
    const revisionId = certificationId(tenant, "revision", WATER_ACTION_HARDENING_SPEC.indexOf(spec) + 1);
    const policy = certificationPolicyForAction(spec.actionType, spec.capabilityFamily, spec.approvalFloor);
    const requiresConfirmation = spec.approvalFloor !== "NONE";
    const template = requiresConfirmation ? `Certification approval for ${spec.actionType}.` : null;
    await client.query(
      `INSERT INTO domain_policies (id, tenant_id, action_type, policy, requires_confirmation, confirmation_template, version, effective_from)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 1, now())
       ON CONFLICT (id) DO UPDATE SET action_type = EXCLUDED.action_type, policy = EXCLUDED.policy, requires_confirmation = EXCLUDED.requires_confirmation, confirmation_template = EXCLUDED.confirmation_template, version = 1, effective_from = EXCLUDED.effective_from`,
      [policyId, config.id, spec.actionType, JSON.stringify(policy), requiresConfirmation, template],
    );
    await client.query(
      `INSERT INTO domain_policy_revisions (id, tenant_id, policy_id, action_type, version, policy, requires_confirmation, confirmation_template, effective_from)
       VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, $7, now())
       ON CONFLICT (policy_id, version) DO UPDATE SET policy = EXCLUDED.policy, requires_confirmation = EXCLUDED.requires_confirmation, confirmation_template = EXCLUDED.confirmation_template, effective_from = EXCLUDED.effective_from`,
      [revisionId, config.id, policyId, spec.actionType, JSON.stringify(policy), requiresConfirmation, template],
    );
    await client.query(
      `INSERT INTO role_permissions (id, tenant_id, role, action_type, can_approve)
       VALUES ($1, $2, 'owner', $3, $4), ($5, $2, 'dispatcher', $3, false)
       ON CONFLICT (id) DO UPDATE SET can_approve = EXCLUDED.can_approve`,
      [certificationId(tenant, "permission", WATER_ACTION_HARDENING_SPEC.indexOf(spec) * 2 + 1), config.id, spec.actionType, requiresConfirmation, certificationId(tenant, "permission", WATER_ACTION_HARDENING_SPEC.indexOf(spec) * 2 + 2)],
    );
  }

  // P2 contract fixtures use real canonical rows in every certification tenant so
  // the cross-tenant gate distinguishes an existing foreign ref from a missing ref.
  const delegationPolicyIndex = WATER_ACTION_HARDENING_SPEC.findIndex((row) => row.actionType === "delegate_objective") + 1;
  const schedulingPolicyIndex = WATER_ACTION_HARDENING_SPEC.findIndex((row) => row.actionType === "schedule_internal_event") + 1;
  const workId = certificationId(tenant, "work", 1);
  const taskId = certificationId(tenant, "task", 1);
  const delegationActionId = certificationId(tenant, "action", 100);
  const schedulingActionId = certificationId(tenant, "action", 101);
  await client.query(
    `INSERT INTO org_units(id,tenant_id,unit_key,name,kind)
     VALUES ($1,$2,$3,$4,'team')
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,active=true`,
    [certificationId(tenant, "orgUnit", 1), config.id, `${tenant}-certification-team`, `${config.alias} Certification Team`],
  );
  await client.query(
    `INSERT INTO works(id,tenant_id,status,initial_channel,initial_instruction,created_by,current_owner_id,assigned_to)
     VALUES ($1,$2,'ready','console',$3,$4,$4,$4)
     ON CONFLICT (id) DO UPDATE SET initial_instruction=EXCLUDED.initial_instruction,current_owner_id=EXCLUDED.current_owner_id,assigned_to=EXCLUDED.assigned_to`,
    [workId, config.id, `${config.alias} universal-action certification Work`, certificationId(tenant, "user", 1)],
  );
  await client.query(
    `INSERT INTO tasks(id,tenant_id,subject_type,subject_id,title,work_id,status,priority)
     VALUES ($1,$2,'work',$3,$4,$3,'open','normal')
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,work_id=EXCLUDED.work_id,status='open'`,
    [taskId, config.id, workId, `${config.alias} universal-action certification task`],
  );
  await client.query(
    `INSERT INTO domain_actions(id,tenant_id,action_type,payload,policy_id,policy_version,status,summary,initiated_by,work_id)
     VALUES
      ($1,$3,'delegate_objective','{}'::jsonb,$4,1,'completed','Certification delegation substrate',$6,$7),
      ($2,$3,'schedule_internal_event','{}'::jsonb,$5,1,'completed','Certification scheduling substrate',$6,$7)
     ON CONFLICT (id) DO UPDATE SET initiated_by=EXCLUDED.initiated_by,work_id=EXCLUDED.work_id`,
    [delegationActionId, schedulingActionId, config.id, certificationId(tenant, "policy", delegationPolicyIndex), certificationId(tenant, "policy", schedulingPolicyIndex), certificationId(tenant, "user", 1), workId],
  );
  await client.query(
    `INSERT INTO delegations(id,tenant_id,domain_action_id,work_id,task_id,created_by,target_type,target_id,objective,status)
     VALUES ($1,$2,$3,$4,$5,$6,'employee',$6,'Certification delegated objective','delivered')
     ON CONFLICT (id) DO UPDATE SET objective=EXCLUDED.objective,status='delivered'`,
    [certificationId(tenant, "delegation", 1), config.id, delegationActionId, workId, taskId, certificationId(tenant, "user", 1)],
  );
  await client.query(
    `INSERT INTO internal_events(id,tenant_id,origin_domain_action_id,last_domain_action_id,work_id,title,starts_at,ends_at,status,created_by)
     VALUES ($1,$2,$3,$3,$4,'Certification internal event','2026-09-01T14:00:00.000Z','2026-09-01T15:00:00.000Z','scheduled',$5)
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,status='scheduled'`,
    [certificationId(tenant, "internalEvent", 1), config.id, schedulingActionId, workId, certificationId(tenant, "user", 1)],
  );

  for (let i = 1; i <= 3; i += 1) {
    const actionType = ["get_business_overview", "create_lead", "log_interaction"][i - 1]!;
    const policyIndex = WATER_ACTION_HARDENING_SPEC.findIndex((row) => row.actionType === actionType) + 1;
    const actionId = certificationId(tenant, "action", i);
    await client.query(
      `INSERT INTO domain_actions (id, tenant_id, action_type, payload, policy_id, policy_version, status, summary)
       VALUES ($1, $2, $3, $4::jsonb, $5, 1, $6, $7)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, policy_id = EXCLUDED.policy_id, policy_version = 1, status = EXCLUDED.status, summary = EXCLUDED.summary`,
      [actionId, config.id, actionType, JSON.stringify({ certification: true, marker: markerFor(tenant, "action", i) }), certificationId(tenant, "policy", policyIndex), i === 1 ? "completed" : i === 2 ? "rejected" : "completed", `${config.alias} certification action history ${i}`],
    );
    await client.query(
      `INSERT INTO action_log (domain_action_id, tenant_id, step, input, output)
       SELECT $1, $2, 'certification_seed', $3::jsonb, $4::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM action_log WHERE domain_action_id = $1 AND step = 'certification_seed')`,
      [actionId, config.id, JSON.stringify({ source: "release-seed", marker: markerFor(tenant, "action", i) }), JSON.stringify({ status: "recorded", actionType })],
    );
  }
}

export async function seedCertificationTenants(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Certification seed is disabled when NODE_ENV=production");
  if (process.env.CERTIFICATION_SEED_ALLOWED !== "1") throw new Error("Set CERTIFICATION_SEED_ALLOWED=1 to run the certification seed");
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the certification seed");
  const testEmails = requiredAllowlist("CERTIFICATION_TEST_EMAILS");
  const testPhones = requiredAllowlist("CERTIFICATION_TEST_PHONES");
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = finnor_os, public");
    for (const tenant of ["alpha", "bravo", "charlie"] as const) await insertTenant(client, tenant, testEmails, testPhones);
    await client.query("COMMIT");
    console.log("CERTIFICATION_SEED_PASS tenants=Alpha,Bravo,Charlie counts=Alpha:15u/40h/40c/20l/12o/10q/8i/10w/12a/8p/3m;Bravo:sentinel;Charlie:degraded-config");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedCertificationTenants().catch((error) => {
    console.error(`CERTIFICATION_SEED_FAIL ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
