/**
 * Phase-5 retirement ledger.
 *
 * These names are historical deny-list evidence, never an executable registry.
 * Keeping the deny list in a vertical-neutral package lets every ingress reject an
 * old queue row, webhook, import, or known-action request without importing retired
 * implementation code.
 */
export const RETIRED_WATER_ACTION_TYPES = [
  "schedule_water_test",
  "renew_maintenance_agreement",
  "create_lead",
  "update_lead_status",
  "log_interaction",
  "assign_lead_to_technician",
  "check_stock_level",
  "flag_reorder_needed",
  "log_stock_used_on_visit",
  "assign_technician_to_visit",
  "check_technician_availability",
  "reschedule_visit",
  "generate_quote",
  "size_equipment_for_household",
  "send_proposal",
  "create_invoice",
  "send_payment_reminder",
  "record_payment",
  "call_overdue_invoices",
  "summarize_ad_performance",
  "launch_ad_campaign",
  "create_review_request",
  "answer_customer_question",
  "send_customer_message",
  "send_follow_up",
  "answer_water_question",
  "send_proposal_to_recent_installs",
  "bulk_notify_existing_customers",
  "log_visit_report",
  "flag_visit_issue",
  "check_reminder_due",
  "generate_compliance_summary",
  "scan_competitors",
  "check_business_reviews",
  "get_business_overview",
  "answer_business_question",
  "start_water_test_workflow",
  "request_proposal_signature",
  "start_installation_workflow",
  "start_invoice_to_cash_workflow",
  "manual_step_suggestion",
  "route_suggestion",
] as const;

export const RETIRED_WATER_QUERY_INTENTS = [
  "customer_lookup",
  "customer_cohort",
  "schedule_range",
  "money_summary",
  "inventory_status",
  "business_state",
  "party_availability",
] as const;

export const RETIRED_WATER_CANONICAL_ENTITY_TYPES = [
  "household",
  "contact",
  "technician",
  "equipment",
  "service_visit",
  "maintenance_agreement",
  "lead",
  "opportunity",
  "quote",
  "proposal",
  "work_order",
  "appointment",
  "invoice",
  "payment",
  "conversation",
  "call",
  "message",
  "communication",
  "inventory_item",
] as const;

export const RETIRED_WATER_IMPORT_ENTITY_TYPES = [
  "customer",
  "lead",
  "appointment",
  "service_visit",
  "equipment",
  "work_order",
  "quote",
  "proposal",
  "invoice",
  "payment",
  "inventory_item",
  "technician",
] as const;

export const RETIRED_WATER_PARTY_TYPES = ["household", "contact", "technician"] as const;

export const RETIRED_WATER_JOB_TYPES = [
  "scheduled_reminder",
  "scan_cold_leads",
  "scan_low_inventory",
  "scan_service_due",
  "scan_appointment_no_shows",
  "simulator_tick",
  "owner_digest",
  "suggest_daily_routes",
  "scan_ewma_reorder",
  "scan_data_quality",
  "quickbooks_sync",
  "dispatch_business_operation",
  "execute_business_operation_target",
  "execute_business_operation_call_batch",
  "run_client_factory",
] as const;

export const RETIRED_WATER_WORKFLOW_TYPES = [
  "lead_to_water_test",
  "maintenance_agreement",
  "maintenance_agreement_renewal",
  "proposal_signature",
  "proposal_to_installation",
  "invoice_to_cash",
] as const;

export const RETIRED_WATER_SOURCE_PROVIDERS = ["ghl", "quickbooks", "stripe"] as const;

export const RETIRED_WATER_READ_MODELS = [
  "household-360",
  "technician-load",
  "water-pipeline",
  "quote-proposal-pipeline",
  "service-due",
  "route-savings",
  "inventory-stock",
  "water-operational-scorecard",
] as const;

export const RETIRED_WATER_DOCTRINE_SURFACES = [
  "planner-water-examples",
  "conversation-water-doctrine",
  "objective-loop-water-context",
  "water-capability-descriptions",
  "water-critic-repair-examples",
  "water-current-eval-corpus",
  "water-policy-defaults",
  "water-provisioning-defaults",
  "dealer-zero-reference-product",
] as const;

/**
 * Source roots whose PE0 disposition was WATER_RETIRE. Directories represent the
 * complete implementation subtree; the permanent boundary proves that each is
 * absent rather than trusting a prose deletion list.
 */
export const RETIRED_WATER_IMPLEMENTATION_PATHS = [
  "apps/api/app/api/business-world",
  "apps/api/app/api/comms",
  "apps/api/app/api/data-quality/findings",
  "apps/api/app/api/dealer-zero",
  "apps/api/app/api/dispatch",
  "apps/api/app/api/operations/[id]/retry/route.ts",
  "apps/api/app/api/overview",
  "apps/api/app/api/price-book",
  "apps/api/app/api/resources",
  "apps/api/app/api/stats",
  "apps/api/app/api/technician",
  "apps/api/app/api/workflows/steps/[id]/compensate/route.ts",
  "apps/api/lib/price-book-provenance.ts",
  "apps/worker/src/simulator",
  "apps/worker/src/handlers/business-operation.ts",
  "apps/worker/src/handlers/owner-digest.ts",
  "apps/worker/src/handlers/quickbooks-sync.ts",
  "apps/worker/src/handlers/run-client-factory.ts",
  "apps/worker/src/handlers/scan-appointment-no-shows.ts",
  "apps/worker/src/handlers/scan-cold-leads.ts",
  "apps/worker/src/handlers/scan-data-quality.ts",
  "apps/worker/src/handlers/scan-ewma-reorder.ts",
  "apps/worker/src/handlers/scan-low-inventory.ts",
  "apps/worker/src/handlers/scan-service-due.ts",
  "apps/worker/src/handlers/scheduled-reminder.ts",
  "apps/worker/src/handlers/simulator-tick.ts",
  "apps/worker/src/handlers/suggest-daily-routes.ts",
  "packages/data-platform/src/appointments.ts",
  "packages/data-platform/src/contacts.ts",
  "packages/data-platform/src/conversations.ts",
  "packages/data-platform/src/import-writes.ts",
  "packages/data-platform/src/leads.ts",
  "packages/data-platform/src/payments.ts",
  "packages/data-platform/src/price-book.ts",
  "packages/data-platform/src/quotes.ts",
  "packages/data-platform/src/work-orders.ts",
  "packages/db/seed-scale.ts",
  "packages/domain-plugins/accounting",
  "packages/domain-plugins/bulk-notify",
  "packages/domain-plugins/compliance-documentation",
  "packages/domain-plugins/crm",
  "packages/domain-plugins/customer-comm",
  "packages/domain-plugins/inventory",
  "packages/domain-plugins/invoice-to-cash",
  "packages/domain-plugins/lead-to-water-test",
  "packages/domain-plugins/maintenance-agreement",
  "packages/domain-plugins/manual-step",
  "packages/domain-plugins/marketing",
  "packages/domain-plugins/ops-overview",
  "packages/domain-plugins/proposal-batch",
  "packages/domain-plugins/proposal-signature",
  "packages/domain-plugins/proposal-to-installation",
  "packages/domain-plugins/quotation",
  "packages/domain-plugins/route-optimization",
  "packages/domain-plugins/scheduling",
  "packages/domain-plugins/service-reminders",
  "packages/domain-plugins/technician-reports",
  "packages/domain-plugins/water-domain-knowledge",
  "packages/domain-plugins/water-test",
  "packages/domain-plugins/web-research/watch-service.ts",
  "packages/orchestration/src/dealer-zero-replay.ts",
  "packages/orchestration/src/training-mode.ts",
  "packages/read-models/src/churn-risk.ts",
  "packages/read-models/src/reorder-points.ts",
  "packages/read-models/src/route-optimizer.ts",
  "packages/read-models/src/slot-recommender.ts",
  "packages/shared-types/src/business-world.ts",
  "packages/shared-types/src/dealer-zero-fixtures.ts",
  "packages/shared-types/src/dealer-zero-scenarios.ts",
  "packages/shared-types/src/dealer-zero-time-compression.ts",
  "packages/tools/src/ads-write.ts",
  "packages/tools/src/ads.ts",
  "packages/tools/src/binding-resolution.ts",
  "packages/tools/src/capabilities/accounting.ts",
  "packages/tools/src/capabilities/communications.ts",
  "packages/tools/src/capabilities/crm.ts",
  "packages/tools/src/capabilities/documents.ts",
  "packages/tools/src/capabilities/governed-runtime.ts",
  "packages/tools/src/capabilities/inventory.ts",
  "packages/tools/src/capabilities/marketing.ts",
  "packages/tools/src/capabilities/scheduling.ts",
  "packages/tools/src/compensation-capabilities.ts",
  "packages/tools/src/docusign.ts",
  "packages/tools/src/maps.ts",
  "packages/tools/src/quickbooks.ts",
  "packages/tools/src/sandbox.ts",
  "packages/tools/src/stripe.ts",
  "packages/workflow-runtime/src/capability.ts",
  "packages/workflow-runtime/src/compensation.ts",
  "scripts/client-factory.ts",
  "scripts/client-lifecycle.ts",
  "scripts/client-manifest.ts",
  "scripts/client-provisioning.ts",
  "scripts/eval-planner.ts",
  "scripts/import-client-data.ts",
  "scripts/import-synthetic-dealer.ts",
  "scripts/provision-tenant.ts",
  "scripts/seed-dealer-zero.ts",
  "scripts/seed-demo-tenant.ts",
  "scripts/seed-tenant-policies.ts",
  "scripts/tenant-bootstrap.ts",
  "scripts/update-vapi-winback.ts",
] as const;

const retiredActions = new Set<string>(RETIRED_WATER_ACTION_TYPES);
const retiredQueries = new Set<string>(RETIRED_WATER_QUERY_INTENTS);
const retiredEntities = new Set<string>(RETIRED_WATER_CANONICAL_ENTITY_TYPES);
const retiredImports = new Set<string>(RETIRED_WATER_IMPORT_ENTITY_TYPES);
const retiredParties = new Set<string>(RETIRED_WATER_PARTY_TYPES);
const retiredJobs = new Set<string>(RETIRED_WATER_JOB_TYPES);
const retiredWorkflows = new Set<string>(RETIRED_WATER_WORKFLOW_TYPES);

export const isRetiredWaterAction = (value: string): boolean => retiredActions.has(value);
export const isRetiredWaterQuery = (value: string): boolean => retiredQueries.has(value);
export const isRetiredWaterCanonicalEntity = (value: string): boolean => retiredEntities.has(value);
export const isRetiredWaterImportEntity = (value: string): boolean => retiredImports.has(value);
export const isRetiredWaterParty = (value: string): boolean => retiredParties.has(value);
export const isRetiredWaterJob = (value: string): boolean => retiredJobs.has(value);
export const isRetiredWaterWorkflow = (value: string): boolean => retiredWorkflows.has(value);

export type Phase5Disposition =
  | "REMOVE_RUNTIME"
  | "DELETE_SOURCE"
  | "QUARANTINE_HISTORY"
  | "RETAIN_CORE"
  | "RETAIN_PROVIDER_TRANSPORT";

export type Pe0Disposition =
  | "WATER_RETIRE"
  | "CORE_EXTRACT"
  | "PE_REUSE"
  | "CORE_KEEP"
  | "HISTORY_ONLY";

export type P1ExtractionResult =
  | "NOT_REQUIRED"
  | "EXTRACTED_TO_CORE"
  | "OWNED_BY_PRIVATE_EQUITY"
  | "PRESERVED_AS_HISTORY";

export type PostCutoverReachability =
  | "ABSENT_FROM_ACTIVE_RUNTIME"
  | "CORE_ONLY"
  | "PRIVATE_EQUITY_ONLY"
  | "PROVIDER_TRANSPORT_ONLY"
  | "HISTORICAL_READ_ONLY";

export interface Phase5DispositionEntry {
  id: string;
  category: string;
  artifact: string;
  pe0Disposition: Pe0Disposition;
  p1ExtractionResult: P1ExtractionResult;
  p5Action: Phase5Disposition;
  postCutoverReachability: PostCutoverReachability;
  evidence: string;
}

export const PHASE5_DISPOSITION_LEDGER_VERSION = 2 as const;

function entries(
  category: string,
  artifacts: readonly string[],
  transition: Omit<Phase5DispositionEntry, "id" | "category" | "artifact">,
): Phase5DispositionEntry[] {
  return artifacts.map((artifact) => ({
    id: `${category}:${artifact}`,
    category,
    artifact,
    ...transition,
  }));
}

const removeRuntime = {
  pe0Disposition: "WATER_RETIRE",
  p1ExtractionResult: "NOT_REQUIRED",
  p5Action: "REMOVE_RUNTIME",
  postCutoverReachability: "ABSENT_FROM_ACTIVE_RUNTIME",
} as const;

/**
 * Machine-readable PE0 -> P1 -> P5 transition ledger. The arrays above are the
 * exact deny contracts; this ledger makes every row independently auditable and
 * rejects duplicate or UNKNOWN rows in PE-DOMAIN-BOUNDARY.
 */
export const PHASE5_DISPOSITION_LEDGER: readonly Phase5DispositionEntry[] = [
  ...entries("action", RETIRED_WATER_ACTION_TYPES, {
    ...removeRuntime,
    evidence: "active action discovery + policy/known-action/DB retirement guards",
  }),
  ...entries("query", RETIRED_WATER_QUERY_INTENTS, {
    ...removeRuntime,
    evidence: "OPERATIONAL_QUERY_INTENTS contains Core + PE only",
  }),
  ...entries("canonical_entity", RETIRED_WATER_CANONICAL_ENTITY_TYPES, {
    pe0Disposition: "HISTORY_ONLY",
    p1ExtractionResult: "PRESERVED_AS_HISTORY",
    p5Action: "QUARANTINE_HISTORY",
    postCutoverReachability: "HISTORICAL_READ_ONLY",
    evidence: "canonical truth registrations inactive; legacy tables protected by migration 0108",
  }),
  ...entries("import_entity", RETIRED_WATER_IMPORT_ENTITY_TYPES, {
    ...removeRuntime,
    evidence: "active import definition and canonical writer registries are empty",
  }),
  ...entries("party", RETIRED_WATER_PARTY_TYPES, {
    ...removeRuntime,
    evidence: "active PartyRef contract excludes the Water extension",
  }),
  ...entries("job", RETIRED_WATER_JOB_TYPES, {
    ...removeRuntime,
    evidence: "worker registry/scheduler inspection + persisted queue guard",
  }),
  ...entries("workflow", RETIRED_WATER_WORKFLOW_TYPES, {
    ...removeRuntime,
    evidence: "workflow registration removed; historical workflow rows remain readable",
  }),
  ...entries("read_model", RETIRED_WATER_READ_MODELS, {
    ...removeRuntime,
    evidence: "active read-model and operational-query barrels contain Core + PE only",
  }),
  ...entries("doctrine", RETIRED_WATER_DOCTRINE_SURFACES, {
    ...removeRuntime,
    evidence: "active cognition/eval/provisioning/policy surfaces scanned by permanent boundary",
  }),
  ...entries("source_implementation", RETIRED_WATER_IMPLEMENTATION_PATHS, {
    pe0Disposition: "WATER_RETIRE",
    p1ExtractionResult: "NOT_REQUIRED",
    p5Action: "DELETE_SOURCE",
    postCutoverReachability: "ABSENT_FROM_ACTIVE_RUNTIME",
    evidence: "path absence asserted by PE-DOMAIN-BOUNDARY",
  }),
  ...entries("core_extraction", [
    "work-objective-runtime",
    "authority-approval-runtime",
    "business-effect-runtime",
    "event-wait-runtime",
    "reconciliation-runtime",
    "universal-actions",
    "computer-runtime",
    "generic-reference-tenant-machinery",
  ], {
    pe0Disposition: "CORE_EXTRACT",
    p1ExtractionResult: "EXTRACTED_TO_CORE",
    p5Action: "RETAIN_CORE",
    postCutoverReachability: "CORE_ONLY",
    evidence: "P1 boundary and post-cutover Core/PE regression suite",
  }),
  ...entries("pe_reuse", [
    "source-truth-engine",
    "generic-import-engine",
    "canonical-company-graph",
    "operational-query-plane",
  ], {
    pe0Disposition: "PE_REUSE",
    p1ExtractionResult: "OWNED_BY_PRIVATE_EQUITY",
    p5Action: "RETAIN_CORE",
    postCutoverReachability: "PRIVATE_EQUITY_ONLY",
    evidence: "PE package boundary and post-cutover P2/P3/P4 certification",
  }),
  ...entries("provider_transport", [
    "email-gmail-resend",
    "vapi-employee-voice",
    "exa-firecrawl-research",
    "docusign-transport",
    "quickbooks-transport",
    "stripe-transport",
    "ghl-transport",
  ], {
    pe0Disposition: "CORE_KEEP",
    p1ExtractionResult: "EXTRACTED_TO_CORE",
    p5Action: "RETAIN_PROVIDER_TRANSPORT",
    postCutoverReachability: "PROVIDER_TRANSPORT_ONLY",
    evidence: "transport retained without active Water mapper/action/provider binding",
  }),
  ...entries("history", [
    "old-forward-migrations",
    "legacy-water-tables",
    "historical-work",
    "historical-domain-actions",
    "decision-receipts",
    "business-events",
    "external-refs",
    "causal-replay",
  ], {
    pe0Disposition: "HISTORY_ONLY",
    p1ExtractionResult: "PRESERVED_AS_HISTORY",
    p5Action: "QUARANTINE_HISTORY",
    postCutoverReachability: "HISTORICAL_READ_ONLY",
    evidence: "fresh/upgrade/restore/fingerprint/replay acceptance suite",
  }),
] as const;

export const PHASE5_DISPOSITION_COUNTS = {
  retiredActions: RETIRED_WATER_ACTION_TYPES.length,
  retiredQueries: RETIRED_WATER_QUERY_INTENTS.length,
  retiredCanonicalEntities: RETIRED_WATER_CANONICAL_ENTITY_TYPES.length,
  retiredImportEntities: RETIRED_WATER_IMPORT_ENTITY_TYPES.length,
  retiredParties: RETIRED_WATER_PARTY_TYPES.length,
  retiredJobs: RETIRED_WATER_JOB_TYPES.length,
  retiredWorkflows: RETIRED_WATER_WORKFLOW_TYPES.length,
  retiredReadModels: RETIRED_WATER_READ_MODELS.length,
  retiredDoctrineSurfaces: RETIRED_WATER_DOCTRINE_SURFACES.length,
  retiredImplementationPaths: RETIRED_WATER_IMPLEMENTATION_PATHS.length,
  total: PHASE5_DISPOSITION_LEDGER.length,
  byP5Action: Object.fromEntries(
    (["REMOVE_RUNTIME", "DELETE_SOURCE", "QUARANTINE_HISTORY", "RETAIN_CORE", "RETAIN_PROVIDER_TRANSPORT"] as const)
      .map((action) => [action, PHASE5_DISPOSITION_LEDGER.filter((row) => row.p5Action === action).length]),
  ),
  unknown: 0,
} as const;
