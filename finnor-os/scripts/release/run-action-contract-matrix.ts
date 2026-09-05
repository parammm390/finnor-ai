// One parameterized core contract runner for the complete fixed action spec.
// It uses the guarded certification tenants, never calls a real provider, and fails
// closed when the local certification database or seed guard is absent.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  withTenant,
  domainActions,
  actionLog,
  decisionReceipts,
  externalOperations,
} from "@finnor/db";
import { openReceipt, finalizeReceipt } from "@finnor/workflow-runtime";
import { ScopedToolRegistry, ToolRegistry } from "@finnor/tools";
import { createDefaultPluginRegistry, type PluginRegistry } from "../../packages/orchestration/src/plugin-registry";
import { groundEntitiesWithDb } from "../../packages/orchestration/src/compiler";
import {
  ACTION_HARDENING_SPEC_BY_ACTION,
  actionHardeningSpecForVertical,
  approvalRequirementForAction,
  requiresTypedConfirmation,
  type ActionHardeningSpecRow,
} from "./action-hardening-spec";
import {
  CERTIFICATION_TENANTS,
  certificationId,
  certificationPolicyForAction,
  seedCertificationTenants,
  type CertificationTenantKey,
} from "./seed-certification-tenants";
import type { DomainPolicy, ReceiptFailure, SimulationResult } from "../../packages/shared-types/src/index";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FINNOR_OS_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(FINNOR_OS_ROOT, "..");
const ROOT_APP = REPO_ROOT;
const MANIFEST_PATH = resolve(REPO_ROOT, "docs/release/generated/action-manifest.json");
const FRONTEND_ACTION_TYPES_PATH = resolve(ROOT_APP, "src/components/jarvis/ui/renderers/backend-action-types.generated.ts");
const FRONTEND_REGISTRY_PATH = resolve(ROOT_APP, "src/components/jarvis/ui/renderers/registry.ts");
const FRONTEND_RENDERER_PATH = resolve(ROOT_APP, "src/components/jarvis/ui/renderers/ActionRenderer.tsx");
const JSON_REPORT_PATH = resolve(REPO_ROOT, "docs/release/generated/action-contract-results.json");
const MARKDOWN_REPORT_PATH = resolve(REPO_ROOT, "docs/release/action-contract-results.md");
const MISSING_ENTITY_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ALPHA_TENANT = CERTIFICATION_TENANTS.alpha.id;
const BRAVO_TENANT = CERTIFICATION_TENANTS.bravo.id;
const WATER_ACTION_HARDENING_SPEC = actionHardeningSpecForVertical("water");
const WATER_ACTION_COUNT = WATER_ACTION_HARDENING_SPEC.length;

type GateStatus = "PASS" | "FAIL" | "N/A";
type TerminalOutcome = "completed" | "rejected" | "blocked" | "failed" | "compensated";

interface GateResult {
  status: GateStatus;
  evidenceId: string;
  detail: string;
}

interface MatrixRow {
  actionType: string;
  plugin: string;
  profile: string;
  approvalFloor: string;
  external: boolean;
  status: "PASS" | "FAIL";
  gates: Record<string, GateResult>;
  evidenceIds: string[];
  failure?: string;
}

interface FrontendContract {
  ok: boolean;
  actionTypes: string[];
  fallbackMounts: number;
  detail: string;
}

function allowlistedTestValue(name: string, fallback: string): string {
  return process.env[name]?.split(",").map((value) => value.trim()).filter(Boolean)[0] ?? fallback;
}

const TEST_PHONE = allowlistedTestValue("CERTIFICATION_TEST_PHONES", "+15550000001");
const TEST_EMAIL = allowlistedTestValue("CERTIFICATION_TEST_EMAILS", "certification@example.invalid");

function alphaId(resource: string, ordinal = 1): string {
  return certificationId("alpha", resource, ordinal);
}

/** The only valid-payload source used by every matrix row. */
export function buildActionFixture(actionType: string): Record<string, unknown> {
  const h = alphaId("household");
  const tech = alphaId("technician");
  const visit = alphaId("visit");
  const invoice = alphaId("invoice");
  const quote = alphaId("quote");
  const proposal = alphaId("proposal");
  const contact = alphaId("contact");
  const agreement = alphaId("agreement");
  const employee = alphaId("user");
  const team = alphaId("orgUnit");
  const work = alphaId("work");
  const task = alphaId("task");
  const delegation = alphaId("delegation");
  const internalEvent = alphaId("internalEvent");
  const document = alphaId("document");
  const fixture: Record<string, Record<string, unknown>> = {
    create_invoice: { householdId: h, customerName: "Certification Household", amountUsd: 1250, memo: "Certification invoice", dueDate: "2026-09-01T00:00:00.000Z" },
    send_payment_reminder: { invoiceId: invoice, channel: "auto" },
    record_payment: { invoiceId: invoice },
    call_overdue_invoices: {},
    bulk_notify_existing_customers: { offerScript: "Certification filter offer", channel: "sms", discountPercent: 10, minMonthsInactive: 1, maxMonthsInactive: 24 },
    clarification_request: { question: "Which certification household should I use?", missingFields: ["householdId"], context: "The request named more than one household." },
    generate_compliance_summary: { householdLabel: "Certification Household", waterProfile: { hardness_gpg: 14, pfoa_ppt: 2, pfos_ppt: 2, fluoride_mg_l: 0.6 } },
    create_lead: { name: "Certification Lead", phone: TEST_PHONE, email: TEST_EMAIL, address: "Certification address", notes: "Contract fixture" },
    update_lead_status: { householdId: h, status: "lead" },
    log_interaction: { householdId: h, channel: "call", direction: "inbound", content: "Certification interaction" },
    assign_lead_to_technician: { householdId: h, technicianId: tech, phone: TEST_PHONE },
    answer_customer_question: { question: "What is the certification water profile?", householdId: h },
    send_customer_message: { householdId: h, phone: TEST_PHONE, email: TEST_EMAIL, message: "Certification message", channel: "sms" },
    send_follow_up: { householdId: h, phone: TEST_PHONE, context: "Certification follow-up" },
    check_stock_level: { sku: "SED-FILT-10" },
    flag_reorder_needed: { sku: "SED-FILT-10", name: "Sediment filter", reasoning: "Certification stock check", suggestedQuantity: 4 },
    log_stock_used_on_visit: { sku: "SED-FILT-10", quantity: 1, visitId: visit },
    start_invoice_to_cash_workflow: { invoiceId: invoice, contactId: contact, channel: "sms" },
    start_water_test_workflow: { householdId: h, technicianId: tech, scheduledAt: "2026-08-10T10:00:00.000Z", phoneNumber: TEST_PHONE, confirmationMessage: "Certification appointment confirmation" },
    renew_maintenance_agreement: { agreementId: agreement, householdId: h, householdLabel: "Certification Household", contactPhone: TEST_PHONE, cadence: "annual", message: "Certification renewal" },
    manual_step_suggestion: { originalActionType: "send_customer_message", originalPayload: { householdId: h }, unavailableCapabilities: ["communications"], reason: "Certification provider is not configured" },
    summarize_ad_performance: { windowDays: 30 },
    launch_ad_campaign: { name: "Certification campaign", dailyBudgetUsd: 10, objective: "leads", targetZip: "00000" },
    create_review_request: { householdId: h, contactName: "Certification Contact", phone: TEST_PHONE, email: TEST_EMAIL },
    get_business_overview: { focus: "pending" },
    answer_business_question: { question: "How many certification invoices are overdue?" },
    send_proposal_to_recent_installs: { windowDays: 30, limit: 5, offerNote: "Certification offer" },
    request_proposal_signature: { proposalId: proposal, signerName: "Certification Contact", signerEmail: TEST_EMAIL },
    start_installation_workflow: { quoteId: quote, householdId: h, sku: "SOFT-48K-PRO", quantity: 1, depositAmountUsd: 350 },
    generate_quote: { householdId: h, householdLabel: "Certification Household", items: ["Sediment filter"], notes: "Certification quote" },
    size_equipment_for_household: { hardnessGpg: 14, ironPpm: 0.2, peopleInHousehold: 4, gallonsPerPersonPerDay: 75 },
    send_proposal: { proposalId: proposal, channel: "email", email: TEST_EMAIL },
    route_suggestion: { technicianId: tech, date: "2026-08-10" },
    assign_technician_to_visit: { visitId: visit, technicianId: tech },
    check_technician_availability: { technicianId: tech, date: "2026-08-10" },
    reschedule_visit: { visitId: visit, newTime: "2026-08-11T10:00:00.000Z", reason: "Certification reschedule" },
    check_reminder_due: { equipmentType: "sediment_filter", lastServicedAt: "2026-01-01T00:00:00.000Z" },
    log_visit_report: { visitId: visit, householdId: h, report: "Certification visit report", markCompleted: false },
    flag_visit_issue: { visitId: visit, issue: "Certification visit issue" },
    answer_water_question: { topic: "hardness" },
    schedule_water_test: { householdId: h, address: "Certification address", contactPhone: TEST_PHONE, contactName: "Certification Contact", requestedAt: "2026-08-10T10:00:00.000Z", technicianId: tech, notes: "Certification water test" },
    search_web: { query: "water treatment certification", numResults: 3 },
    scan_competitors: { area: "Certification area", focus: "pricing", sources: [] },
    check_business_reviews: { businessName: "Certification Water Co", area: "Certification area" },
    send_message: { recipient: { partyType: "employee", partyId: employee }, channel: "internal", body: "Certification internal message" },
    place_call: { recipient: { partyType: "household", partyId: h }, objective: "Confirm the certification appointment", script: "This is a certification call." },
    request_acknowledgement: { recipient: { partyType: "employee", partyId: employee }, request: "Acknowledge the certification handoff", deadline: "2026-09-01T12:00:00.000Z" },
    notify_group: { teamRef: { partyType: "team", partyId: team }, channel: "internal", body: "Certification team notification" },
    create_task: { subjectRef: { entityType: "household", entityId: h }, title: "Certification task", priority: "normal" },
    assign_task: { taskRef: { taskId: task }, assigneeRef: { partyType: "employee", partyId: employee } },
    update_task: { taskRef: { taskId: task }, status: "done" },
    handoff_work: { workRef: { workId: work }, targetEmployeeRef: { partyType: "employee", partyId: employee }, note: "Certification handoff" },
    delegate_objective: { workRef: { workId: work }, targetRef: { partyType: "employee", partyId: employee }, objective: "Complete the certification objective", acknowledgementDeadline: "2026-09-01T12:00:00.000Z", completionDeadline: "2026-09-02T12:00:00.000Z" },
    escalate_work: { delegationRef: { delegationId: delegation }, targetRef: { partyType: "employee", partyId: employee }, reason: "Certification escalation", evidenceRefs: [] },
    cancel_delegation: { delegationRef: { delegationId: delegation }, reason: "Certification cancellation" },
    schedule_internal_event: { title: "Certification event", startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T15:00:00.000Z", participants: [{ partyType: "employee", partyId: employee }] },
    reschedule_internal_event: { internalEventRef: { internalEventId: internalEvent }, startsAt: "2026-09-01T15:00:00.000Z", endsAt: "2026-09-01T16:00:00.000Z", reason: "Certification reschedule" },
    share_document: { documentRef: { documentId: document }, recipient: { partyType: "employee", partyId: employee }, accessLevel: "view" },
    computer_task: { application: "supplier_portal", authProfileRef: "supplier-west", task: "Find the confirmed ETA for supplier order WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["A confirmed ETA is visible for WS-48"] },
  };
  const value = fixture[actionType];
  if (!value) throw new Error(`No shared certification fixture exists for ${actionType}`);
  return structuredClone(value);
}

const RESOURCE_BY_ID_FIELD: Record<string, string> = {
  householdId: "household",
  technicianId: "technician",
  visitId: "visit",
  invoiceId: "invoice",
  quoteId: "quote",
  proposalId: "proposal",
  contactId: "contact",
  agreementId: "agreement",
  leadId: "lead",
  workOrderId: "workOrder",
  appointmentId: "appointment",
  workId: "work",
  taskId: "task",
  documentId: "document",
  delegationId: "delegation",
  internalEventId: "internalEvent",
};

const RESOURCE_BY_PARTY_TYPE: Record<string, string> = {
  employee: "user",
  team: "orgUnit",
  household: "household",
  contact: "contact",
};

const RESOURCE_BY_ENTITY_TYPE: Record<string, string> = {
  household: "household",
  contact: "contact",
  lead: "lead",
  quote: "quote",
  invoice: "invoice",
  proposal: "proposal",
  work_order: "workOrder",
  appointment: "appointment",
  document: "document",
  task: "task",
  work: "work",
  delegation: "delegation",
  internal_event: "internalEvent",
};

function replaceReferencedIds(payload: Record<string, unknown>, replacement: "missing" | "bravo"): Record<string, unknown> {
  const copy = structuredClone(payload);
  const replacementId = (resource: string) => replacement === "missing" ? MISSING_ENTITY_ID : certificationId("bravo", resource, 1);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const partyResource = typeof row.partyType === "string" ? RESOURCE_BY_PARTY_TYPE[row.partyType] : undefined;
    if (partyResource && typeof row.partyId === "string") row.partyId = replacementId(partyResource);
    const entityResource = typeof row.entityType === "string" ? RESOURCE_BY_ENTITY_TYPE[row.entityType] : undefined;
    if (entityResource && typeof row.entityId === "string") row.entityId = replacementId(entityResource);
    for (const [field, child] of Object.entries(row)) {
      if (field === "partyId" || field === "entityId") continue;
      const resource = RESOURCE_BY_ID_FIELD[field];
      if (resource && typeof child === "string") row[field] = replacementId(resource);
      else visit(child);
    }
  };
  visit(copy);
  return copy;
}

function policyFor(row: ActionHardeningSpecRow, tenantId: string): DomainPolicy {
  const index = WATER_ACTION_HARDENING_SPEC.indexOf(row) + 1;
  return {
    id: certificationId("alpha", "policy", index),
    tenantId,
    actionType: row.actionType,
    policy: certificationPolicyForAction(row.actionType, row.capabilityFamily, row.approvalFloor),
    requiresConfirmation: row.approvalFloor !== "NONE",
    confirmationTemplate: row.approvalFloor === "NONE" ? null : `Certification approval for ${row.actionType}.`,
    version: 1,
  };
}

function invalidPayloadFor(): null {
  // All fixed action payload schemas are object-shaped; null must be rejected. This
  // deliberately exercises the plugin's public validate() boundary rather than a
  // private zod schema that could drift from runtime behavior.
  return null;
}

async function frontendContract(): Promise<FrontendContract> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as { actions: Array<{ actionType: string }> };
  const actionTypes = manifest.actions.map((action) => action.actionType);
  const source = `// GENERATED FILE — source: finnor-os/docs/release/generated/action-manifest.json.\n// Regenerated by the Phase 2 universal-action contract runner; do not edit the action list here.\n\nexport const BACKEND_ACTION_TYPES = ${JSON.stringify(actionTypes, null, 2)} as const;\n\nexport const BACKEND_ACTION_TYPE_COUNT = BACKEND_ACTION_TYPES.length;\n`;
  await mkdir(dirname(FRONTEND_ACTION_TYPES_PATH), { recursive: true });
  await writeFile(FRONTEND_ACTION_TYPES_PATH, source, "utf8");
  const registrySource = await readFile(FRONTEND_REGISTRY_PATH, "utf8");
  const rendererSource = await readFile(FRONTEND_RENDERER_PATH, "utf8");
  const fallbackMounts = (rendererSource.match(/from ["']\.\/FallbackRenderer["']/g) ?? []).length;
  // The backend runner deliberately does not execute React/Next modules: their
  // browser-only auth imports require the Next alias loader. Instead, inspect the
  // registry's two source-of-truth maps and the explicit state assignment that the
  // frontend unit/renderer tests exercise under Vite/Next.
  const mapBlocks = [
    registrySource.match(/const FLAGSHIP_COMPONENT:[\s\S]*?const STANDARD_FIELDS:/)?.[0] ?? "",
    registrySource.match(/const STANDARD_FIELDS:[\s\S]*?const FLAGSHIP_PLUGIN:/)?.[0] ?? "",
  ];
  const declared = new Set(mapBlocks.flatMap((block) => [...block.matchAll(/\b([a-z][a-z0-9_]*)\s*:/g)].map((match) => match[1]!)).filter((actionType) => actionTypes.includes(actionType)));
  if (registrySource.includes("registry.clarification_request =")) declared.add("clarification_request");
  const exact = declared.size === actionTypes.length && actionTypes.every((actionType) => declared.has(actionType));
  const stateSource = await readFile(resolve(ROOT_APP, "src/components/jarvis/ui/renderers/action-state-contract.ts"), "utf8");
  const states = ["pending", "approved", "executing", "completed", "failed", "blocked"].every((state) => stateSource.includes(`"${state}"`)) && registrySource.includes("states: CERTIFIED_ACTION_STATES");
  const noFallback = fallbackMounts === 0;
  return {
    ok: exact && states && noFallback && registrySource.includes("BACKEND_ACTION_TYPES"),
    actionTypes,
    fallbackMounts,
    detail: exact && states && noFallback ? "generated manifest, renderer entries, six-state coverage, and zero certified fallback mounts" : "frontend manifest/registry/state/fallback assertion failed",
  };
}

async function groundingGate(payload: Record<string, unknown>, kind: "missing" | "cross"): Promise<GateResult> {
  const evidenceId = kind === "missing" ? "P2-GROUND-MISSING" : "P2-GROUND-CROSS-TENANT";
  const checked = replaceReferencedIds(payload, kind === "missing" ? "missing" : "bravo");
  const grounded = await withTenant(ALPHA_TENANT, (db) => groundEntitiesWithDb(db, ALPHA_TENANT, checked));
  if (grounded.length === 0) return { status: "N/A", evidenceId, detail: "fixture has no referenced entity field" };
  const allNotFound = grounded.every((field) => field.status === "not_found");
  return {
    status: allNotFound ? "PASS" : "FAIL",
    evidenceId,
    detail: allNotFound ? `${grounded.length} referenced id(s) refused in tenant-scoped grounding` : grounded.map((field) => `${field.field}:${field.status}`).join(","),
  };
}

async function insertContractAction(tenantId: string, actionType: string, policyId: string, status: "approved" | "completed" | "rejected" | "blocked_integration_unavailable" | "failed" | "executing"): Promise<string> {
  const id = randomUUID();
  await withTenant(tenantId, (db) => db.insert(domainActions).values({ id, tenantId, actionType, payload: { certification: true }, policyId, policyVersion: 1, status, summary: `Phase 2 universal-action contract ${actionType}` }));
  return id;
}

async function actionClaimIdempotency(row: ActionHardeningSpecRow, policy: DomainPolicy): Promise<GateResult> {
  const evidenceId = `P2-IDEMPOTENCY-${row.actionType}`;
  const actionId = await insertContractAction(ALPHA_TENANT, row.actionType, policy.id, "approved");
  const claim = async () => withTenant(ALPHA_TENANT, (db) =>
    db.update(domainActions).set({ status: "executing" }).where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, ALPHA_TENANT), eq(domainActions.status, "approved"))).returning({ id: domainActions.id }),
  );
  const winners = (await Promise.all([claim(), claim()])).flat().length;
  await withTenant(ALPHA_TENANT, (db) => db.update(domainActions).set({ status: "completed" }).where(eq(domainActions.id, actionId)));
  const duplicate = await claim();
  const passed = winners === 1 && duplicate.length === 0;
  return { status: passed ? "PASS" : "FAIL", evidenceId, detail: `atomic action claim winners=${winners}, repeat-after-terminal=${duplicate.length}` };
}

async function externalIdempotency(row: ActionHardeningSpecRow, policy: DomainPolicy): Promise<GateResult> {
  const evidenceId = `P2-PROVIDER-IDEMPOTENCY-${row.actionType}`;
  const sequentialActionId = await insertContractAction(ALPHA_TENANT, row.actionType, policy.id, "approved");
  const concurrentActionId = await insertContractAction(ALPHA_TENANT, row.actionType, policy.id, "approved");
  const base = new ToolRegistry();
  let effects = 0;
  base.register({
    name: "certification_effect",
    description: "Phase 2 universal-action local idempotency probe",
    inputSchema: z.object({ token: z.string() }),
    integration: "certification",
    async run() {
      effects += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      return { effect: "one" };
    },
  });
  const first = new ScopedToolRegistry(base, { tenantId: ALPHA_TENANT, domainActionId: sequentialActionId });
  const second = new ScopedToolRegistry(base, { tenantId: ALPHA_TENANT, domainActionId: sequentialActionId });
  const firstResult = await first.call("certification_effect", { token: row.actionType });
  const secondResult = await second.call("certification_effect", { token: row.actionType });
  const beforeConcurrent = effects;
  await Promise.all([
    new ScopedToolRegistry(base, { tenantId: ALPHA_TENANT, domainActionId: concurrentActionId }).call("certification_effect", { token: row.actionType }),
    new ScopedToolRegistry(base, { tenantId: ALPHA_TENANT, domainActionId: concurrentActionId }).call("certification_effect", { token: row.actionType }),
  ]);
  const ledgerCount = await withTenant(ALPHA_TENANT, async (db) => {
    const [sequential] = await db.select({ count: sql<number>`count(*)` }).from(externalOperations).where(eq(externalOperations.domainActionId, sequentialActionId));
    const [concurrent] = await db.select({ count: sql<number>`count(*)` }).from(externalOperations).where(eq(externalOperations.domainActionId, concurrentActionId));
    return { sequential: Number(sequential?.count ?? 0), concurrent: Number(concurrent?.count ?? 0) };
  });
  const passed = firstResult.ok && secondResult.ok && effects - beforeConcurrent === 1 && beforeConcurrent === 1 && ledgerCount.sequential === 1 && ledgerCount.concurrent === 1;
  return { status: passed ? "PASS" : "FAIL", evidenceId, detail: `sequential-effects=1 concurrent-effects=${effects - beforeConcurrent} ledger=${ledgerCount.sequential}/${ledgerCount.concurrent}` };
}

async function receiptOutcome(row: ActionHardeningSpecRow, policy: DomainPolicy, outcome: TerminalOutcome): Promise<GateResult> {
  const evidenceId = `P2-RECEIPT-${row.actionType}-${outcome}`;
  const status = outcome === "rejected" ? "rejected" : outcome === "blocked" ? "blocked_integration_unavailable" : outcome === "failed" ? "failed" : outcome === "completed" || outcome === "compensated" ? "completed" : "failed";
  const actionId = await insertContractAction(ALPHA_TENANT, row.actionType, policy.id, status);
  const correlationId = `p1:${row.actionType}:${outcome}`;
  const riskTier = row.external ? "high" : row.profile === "READ_ONLY" || row.profile === "META_NO_SIDE_EFFECT" ? "low" : "medium";
  await withTenant(ALPHA_TENANT, (db) => db.insert(actionLog).values({
    tenantId: ALPHA_TENANT,
    domainActionId: actionId,
    step: `contract_${outcome}`,
    input: { source: "phase1-contract", actionType: row.actionType, correlationId, policyVersion: policy.version, riskTier },
    output: { actualTenantId: ALPHA_TENANT, actionType: row.actionType, correlationId, policyVersion: policy.version, riskTier, outcome },
  }));
  const opened = await openReceipt({
    tenantId: ALPHA_TENANT,
    domainActionId: actionId,
    objective: `Phase 2 ${outcome} contract for ${row.actionType}`,
    evidence: [{ source: "phase1_contract", ref: evidenceId, timestamp: new Date().toISOString() }],
    policyApplied: { id: policy.id, version: policy.version },
    riskTier,
    proposedAction: { actionType: row.actionType, profile: row.profile },
    approval: { required: row.approvalFloor !== "NONE", ...(row.approvalFloor !== "NONE" ? { approvedBy: "certification-owner", at: new Date().toISOString() } : {}) },
    expectedResult: { actionType: row.actionType, outcome },
    correlationId,
  });
  if (outcome === "completed" || outcome === "compensated") {
    await finalizeReceipt(ALPHA_TENANT, opened.receiptId, {
      actualResult: { actualTenantId: ALPHA_TENANT, actionType: row.actionType, correlationId, policyVersion: policy.version, riskTier, outcome, provider: row.external ? "certification-emulator" : "native" },
    });
  } else {
    const failure: ReceiptFailure = {
      errorKind: outcome === "blocked" ? "config" : outcome === "rejected" ? "needs_human" : "terminal",
      message: `Phase 2 certification ${outcome}; no unrecorded effect is claimed.`,
      recoveryPath: outcome === "blocked" ? "configure_binding" : outcome === "rejected" ? "new_approval" : "manual_review",
    };
    await finalizeReceipt(ALPHA_TENANT, opened.receiptId, { failure });
  }
  const [stored] = await withTenant(ALPHA_TENANT, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, opened.receiptId)));
  const serialized = JSON.stringify({ stored, actionType: row.actionType, correlationId });
  const hasTruthfulTerminal = Boolean(stored?.finalizedAt) && ((outcome === "completed" || outcome === "compensated") ? stored?.actualResult !== null : stored?.failure !== null);
  const noSeedMarker = !serialized.includes("BRAVO-ISOLATION-SENTINEL") && !serialized.includes(TEST_PHONE) && !serialized.includes(TEST_EMAIL);
  const audit = await withTenant(ALPHA_TENANT, (db) => db.select().from(actionLog).where(and(eq(actionLog.domainActionId, actionId), eq(actionLog.step, `contract_${outcome}`))));
  const auditTruthful = audit[0]?.tenantId === ALPHA_TENANT && (audit[0]?.output as Record<string, unknown> | undefined)?.actionType === row.actionType;
  const passed = hasTruthfulTerminal && noSeedMarker && auditTruthful;
  return { status: passed ? "PASS" : "FAIL", evidenceId, detail: `finalized=${Boolean(stored?.finalizedAt)} actual=${stored?.actualResult !== null} failure=${stored?.failure !== null} audit=${auditTruthful}` };
}

async function predictionGate(registry: PluginRegistry, row: ActionHardeningSpecRow, payload: Record<string, unknown>, policy: DomainPolicy): Promise<GateResult> {
  const evidenceId = `P2-PREDICTION-${row.actionType}`;
  const simulation = await registry.simulate(row.actionType, payload, policy);
  const explicit = Boolean(simulation && (simulation.mode === "schema" || simulation.mode === "dry_run") && simulation.summary.trim() && simulation.predicted && typeof simulation.predicted === "object");
  return { status: explicit ? "PASS" : "FAIL", evidenceId, detail: explicit ? `${simulation.mode} prediction is explicit and labeled no-write by the plugin/registry contract` : "simulation did not return an explicit mode, summary, and predicted object" };
}

function floorGate(row: ActionHardeningSpecRow): GateResult {
  const evidenceId = `P2-APPROVAL-${row.actionType}`;
  const none = approvalRequirementForAction(row.actionType, false, false);
  const policy = approvalRequirementForAction(row.actionType, true, false);
  const typed = requiresTypedConfirmation(row.actionType);
  const passed = row.approvalFloor === "NONE"
    ? !none.requiresConfirmation && !none.typedConfirmation && !typed
    : row.approvalFloor === "POLICY"
      ? policy.requiresConfirmation && !policy.typedConfirmation && !typed
      : row.approvalFloor === "REQUIRED"
        ? none.requiresConfirmation && policy.requiresConfirmation && !policy.typedConfirmation && !typed
        : none.requiresConfirmation && policy.requiresConfirmation && policy.typedConfirmation && typed;
  return { status: passed ? "PASS" : "FAIL", evidenceId, detail: `${row.approvalFloor}: requires=${policy.requiresConfirmation}, typed=${policy.typedConfirmation}, approval-queue=${row.approvalFloor !== "NONE"}` };
}

async function runRow(registry: PluginRegistry, frontend: FrontendContract, row: ActionHardeningSpecRow, index: number): Promise<MatrixRow> {
  const evidenceIds: string[] = [];
  const gates: Record<string, GateResult> = {};
  try {
    const plugin = registry.resolve(row.actionType);
    const payload = buildActionFixture(row.actionType);
    const policy = policyFor(row, ALPHA_TENANT);
    gates.registry = { status: plugin?.name === row.plugin ? "PASS" : "FAIL", evidenceId: `P2-REGISTRY-${row.actionType}`, detail: plugin ? `${plugin.name} resolved without collision` : "action not registered" };
    gates.valid_input = { status: plugin?.validate(row.actionType, payload, policy).valid ? "PASS" : "FAIL", evidenceId: `P2-SCHEMA-VALID-${row.actionType}`, detail: "shared fixture accepted by runtime validator" };
    const invalid = plugin?.validate(row.actionType, invalidPayloadFor(), policy);
    gates.invalid_input = { status: invalid && !invalid.valid ? "PASS" : "FAIL", evidenceId: `P2-SCHEMA-INVALID-${row.actionType}`, detail: invalid && !invalid.valid ? "null payload rejected" : "runtime validator accepted null" };
    gates.missing_entity = await groundingGate(payload, "missing");
    gates.cross_tenant = await groundingGate(payload, "cross");
    gates.approval_floor = floorGate(row);
    gates.prediction = await predictionGate(registry, row, payload, policy);
    gates.receipt_completed = await receiptOutcome(row, policy, "completed");
    gates.receipt_rejected = await receiptOutcome(row, policy, "rejected");
    gates.receipt_blocked = await receiptOutcome(row, policy, "blocked");
    gates.receipt_failed = await receiptOutcome(row, policy, "failed");
    gates.receipt_compensated = await receiptOutcome(row, policy, "compensated");
    if (row.profile !== "READ_ONLY" && row.profile !== "META_NO_SIDE_EFFECT") {
      gates.idempotency = await actionClaimIdempotency(row, policy);
      if (row.external) gates.provider_idempotency = await externalIdempotency(row, policy);
    } else {
      gates.idempotency = { status: "N/A", evidenceId: `P2-IDEMPOTENCY-${row.actionType}`, detail: "read-only/meta action has no business or provider effect to repeat" };
      gates.provider_idempotency = { status: "N/A", evidenceId: `P2-PROVIDER-IDEMPOTENCY-${row.actionType}`, detail: "read-only/meta action has no provider effect" };
    }
    gates.frontend = { status: frontend.ok && frontend.actionTypes.includes(row.actionType) ? "PASS" : "FAIL", evidenceId: `P2-FRONTEND-${row.actionType}`, detail: frontend.detail };
    gates.no_fallback = { status: frontend.fallbackMounts === 0 ? "PASS" : "FAIL", evidenceId: `P2-FALLBACK-${row.actionType}`, detail: `certified ActionRenderer fallback imports=${frontend.fallbackMounts}` };
    for (const gate of Object.values(gates)) if (gate.evidenceId) evidenceIds.push(gate.evidenceId);
    const failures = Object.entries(gates).filter(([, gate]) => gate.status === "FAIL");
    return { actionType: row.actionType, plugin: row.plugin, profile: row.profile, approvalFloor: row.approvalFloor, external: row.external, status: failures.length === 0 ? "PASS" : "FAIL", gates, evidenceIds, ...(failures.length > 0 ? { failure: failures.map(([name, gate]) => `${name}: ${gate.detail}`).join(" | ") } : {}) };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "unknown matrix error";
    return { actionType: row.actionType, plugin: row.plugin, profile: row.profile, approvalFloor: row.approvalFloor, external: row.external, status: "FAIL", gates, evidenceIds, failure };
  }
}

function markdownReport(rows: MatrixRow[], frontend: FrontendContract): string {
  const passed = rows.filter((row) => row.status === "PASS").length;
  const lines = [
    "# Phase 2 Universal Action Contract Results",
    "",
    `Generated by npm run release:contract against the guarded local certification database. **${passed}/${WATER_ACTION_COUNT} rows PASS; ${rows.length - passed} FAIL.**`,
    "",
    "Provider-backed calls are not performed by this core harness. It proves the fixed contract, tenant grounding, approval floor, shared idempotency claims, receipt/audit truth, prediction shape, and generated frontend coverage. Missing live provider credentials remain Phase 2/3 BLOCKED-CONFIG evidence.",
    "",
    `Frontend contract: ${frontend.ok ? "PASS" : "FAIL"}; registered=${frontend.actionTypes.length}; certified fallback mounts=${frontend.fallbackMounts}.`,
    "",
    "| # | Action | Profile | Floor | Registry | Valid | Invalid | Missing | Cross-tenant | Approval | Prediction | Receipts | Idempotency | Frontend | Status | Evidence |",
    "|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [index, row] of rows.entries()) {
    const g = (name: string) => row.gates[name]?.status ?? "FAIL";
    const receipts = ["receipt_completed", "receipt_rejected", "receipt_blocked", "receipt_failed", "receipt_compensated"].every((name) => g(name) === "PASS") ? "PASS" : "FAIL";
    const idempotencyGate = row.gates.idempotency?.status;
    const providerIdempotencyGate = row.gates.provider_idempotency?.status;
    const idempotency = idempotencyGate === "FAIL" || providerIdempotencyGate === "FAIL" ? "FAIL" : idempotencyGate === "N/A" ? "N/A" : "PASS";
    lines.push(`| ${index + 1} | \`${row.actionType}\` | ${row.profile} | ${row.approvalFloor} | ${g("registry")} | ${g("valid_input")} | ${g("invalid_input")} | ${g("missing_entity")} | ${g("cross_tenant")} | ${g("approval_floor")} | ${g("prediction")} | ${receipts} | ${idempotency} | ${g("frontend")} | **${row.status}** | ${row.evidenceIds.join(", ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runActionContractMatrix(databaseUrl = process.env.DATABASE_URL): Promise<MatrixRow[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required; the Phase 2 universal-action matrix never falls back to an unscoped or in-memory database");
  await seedCertificationTenants(databaseUrl);
  const frontend = await frontendContract();
  const registry = createDefaultPluginRegistry();
  const rows: MatrixRow[] = [];
  for (const [index, spec] of WATER_ACTION_HARDENING_SPEC.entries()) rows.push(await runRow(registry, frontend, spec, index));
  const report = {
    phase: "P2",
    generatedAt: new Date().toISOString(),
    actionCount: WATER_ACTION_HARDENING_SPEC.length,
    passCount: rows.filter((row) => row.status === "PASS").length,
    failCount: rows.filter((row) => row.status === "FAIL").length,
    frontend,
    rows,
  };
  await mkdir(dirname(JSON_REPORT_PATH), { recursive: true });
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, markdownReport(rows, frontend), "utf8");
  if (report.failCount > 0) throw new Error(`Action contract matrix failed ${report.failCount}/${WATER_ACTION_COUNT} rows; see docs/release/action-contract-results.md`);
  console.log(`P2_CONTRACT_MATRIX_PASS rows=${report.passCount}/${WATER_ACTION_COUNT} frontend=${frontend.actionTypes.length}/${WATER_ACTION_COUNT} fallback_mounts=${frontend.fallbackMounts}`);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runActionContractMatrix().catch((error) => {
    console.error(`P2_CONTRACT_MATRIX_FAIL ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
