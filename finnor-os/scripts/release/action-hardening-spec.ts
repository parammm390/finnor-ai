export type ActionProfile =
  | "READ_ONLY"
  | "INTERNAL_DRAFT"
  | "INTERNAL_WRITE"
  | "OPERATIONAL_CHANGE"
  | "FINANCIAL_WRITE"
  | "EXTERNAL_SIDE_EFFECT"
  | "EXTERNAL_SPEND"
  | "BATCH_EXTERNAL"
  | "DURABLE_WORKFLOW"
  | "META_NO_SIDE_EFFECT";

export type ApprovalFloor = "NONE" | "POLICY" | "REQUIRED" | "TYPED_REQUIRED";

export interface ActionHardeningSpecRow {
  plugin: string;
  actionType: string;
  profile: ActionProfile;
  approvalFloor: ApprovalFloor;
  capabilityFamily: string;
  external: boolean;
  receipt: true;
}

/** The binding table in plan §3.3. This is intentionally not inferred from code. */
const LEGACY_FIXED_ROWS: ReadonlyArray<readonly [string, string, ActionProfile, ApprovalFloor, string, boolean]> = [
  ["accounting", "create_invoice", "OPERATIONAL_CHANGE", "REQUIRED", "accounting", true],
  ["accounting", "send_payment_reminder", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "communications/accounting", true],
  ["accounting", "record_payment", "FINANCIAL_WRITE", "TYPED_REQUIRED", "accounting/payments", true],
  ["accounting", "call_overdue_invoices", "BATCH_EXTERNAL", "TYPED_REQUIRED", "voice/communications", true],
  ["bulk-notify", "bulk_notify_existing_customers", "BATCH_EXTERNAL", "TYPED_REQUIRED", "communications", true],
  ["clarification", "clarification_request", "META_NO_SIDE_EFFECT", "NONE", "none", false],
  ["compliance-documentation", "generate_compliance_summary", "INTERNAL_DRAFT", "POLICY", "documents", false],
  ["crm", "create_lead", "INTERNAL_WRITE", "POLICY", "crm", false],
  ["crm", "update_lead_status", "INTERNAL_WRITE", "POLICY", "crm", false],
  ["crm", "log_interaction", "INTERNAL_WRITE", "NONE", "crm", false],
  ["crm", "assign_lead_to_technician", "OPERATIONAL_CHANGE", "REQUIRED", "crm/scheduling", false],
  ["customer-comm", "answer_customer_question", "READ_ONLY", "NONE", "llm/evidence", false],
  ["customer-comm", "send_customer_message", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "communications", true],
  ["customer-comm", "send_follow_up", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "communications", true],
  ["inventory", "check_stock_level", "READ_ONLY", "NONE", "inventory", false],
  ["inventory", "flag_reorder_needed", "INTERNAL_WRITE", "POLICY", "inventory", false],
  ["inventory", "log_stock_used_on_visit", "OPERATIONAL_CHANGE", "POLICY", "inventory", false],
  ["invoice-to-cash", "start_invoice_to_cash_workflow", "DURABLE_WORKFLOW", "TYPED_REQUIRED", "accounting/communications", true],
  ["lead-to-water-test", "start_water_test_workflow", "DURABLE_WORKFLOW", "REQUIRED", "crm/scheduling/communications", true],
  ["maintenance-agreement", "renew_maintenance_agreement", "DURABLE_WORKFLOW", "REQUIRED", "documents/esign/communications", true],
  ["manual-step", "manual_step_suggestion", "META_NO_SIDE_EFFECT", "NONE", "none", false],
  ["marketing", "summarize_ad_performance", "READ_ONLY", "NONE", "marketing", false],
  ["marketing", "launch_ad_campaign", "EXTERNAL_SPEND", "TYPED_REQUIRED", "marketing", true],
  ["marketing", "create_review_request", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "communications", true],
  ["ops-overview", "get_business_overview", "READ_ONLY", "NONE", "read-models", false],
  ["ops-overview", "answer_business_question", "READ_ONLY", "NONE", "read-models/llm", false],
  ["proposal-batch", "send_proposal_to_recent_installs", "BATCH_EXTERNAL", "TYPED_REQUIRED", "documents/communications", true],
  ["proposal-signature", "request_proposal_signature", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "esign/communications", true],
  ["proposal-to-installation", "start_installation_workflow", "DURABLE_WORKFLOW", "REQUIRED", "scheduling/documents/communications", true],
  ["quotation", "generate_quote", "INTERNAL_DRAFT", "POLICY", "documents/price-book", false],
  ["quotation", "size_equipment_for_household", "READ_ONLY", "NONE", "water-domain/price-book", false],
  ["quotation", "send_proposal", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "documents/communications", true],
  ["route-optimization", "route_suggestion", "READ_ONLY", "NONE", "routing", false],
  ["scheduling", "assign_technician_to_visit", "OPERATIONAL_CHANGE", "REQUIRED", "scheduling", false],
  ["scheduling", "check_technician_availability", "READ_ONLY", "NONE", "scheduling", false],
  ["scheduling", "reschedule_visit", "OPERATIONAL_CHANGE", "REQUIRED", "scheduling/communications", true],
  ["service-reminders", "check_reminder_due", "READ_ONLY", "NONE", "scheduling", false],
  ["technician-reports", "log_visit_report", "INTERNAL_WRITE", "POLICY", "crm/documents", false],
  ["technician-reports", "flag_visit_issue", "INTERNAL_WRITE", "POLICY", "crm/operations", false],
  ["water-domain-knowledge", "answer_water_question", "READ_ONLY", "NONE", "llm/evidence", false],
  ["water-test", "schedule_water_test", "OPERATIONAL_CHANGE", "REQUIRED", "scheduling/communications", true],
  ["web-research", "search_web", "READ_ONLY", "NONE", "exa/firecrawl/evidence", false],
  ["web-research", "scan_competitors", "READ_ONLY", "NONE", "exa/firecrawl/evidence", false],
  ["web-research", "check_business_reviews", "READ_ONLY", "NONE", "exa/firecrawl/evidence", false],
];

const UNIVERSAL_FIXED_ROWS: ReadonlyArray<readonly [string, string, ActionProfile, ApprovalFloor, string, boolean]> = [
  ["universal-actions", "send_message", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "communications/identity", true],
  ["universal-actions", "place_call", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "voice/communications/identity", true],
  ["universal-actions", "request_acknowledgement", "INTERNAL_WRITE", "POLICY", "delegation/communications", false],
  ["universal-actions", "notify_group", "BATCH_EXTERNAL", "TYPED_REQUIRED", "communications/identity", true],
  ["universal-actions", "create_task", "INTERNAL_WRITE", "POLICY", "tasks/work", false],
  ["universal-actions", "assign_task", "OPERATIONAL_CHANGE", "REQUIRED", "tasks/authority", false],
  ["universal-actions", "update_task", "OPERATIONAL_CHANGE", "REQUIRED", "tasks/work", false],
  ["universal-actions", "handoff_work", "OPERATIONAL_CHANGE", "REQUIRED", "work/authority", false],
  ["universal-actions", "delegate_objective", "DURABLE_WORKFLOW", "REQUIRED", "delegation/tasks/work", false],
  ["universal-actions", "escalate_work", "OPERATIONAL_CHANGE", "REQUIRED", "delegation/authority", false],
  ["universal-actions", "cancel_delegation", "OPERATIONAL_CHANGE", "REQUIRED", "delegation/authority", false],
  ["universal-actions", "schedule_internal_event", "OPERATIONAL_CHANGE", "REQUIRED", "scheduling/work", false],
  ["universal-actions", "reschedule_internal_event", "OPERATIONAL_CHANGE", "REQUIRED", "scheduling/work", false],
  ["universal-actions", "share_document", "EXTERNAL_SIDE_EFFECT", "REQUIRED", "documents/communications", true],
];

const COMPUTER_FIXED_ROWS: ReadonlyArray<readonly [string, string, ActionProfile, ApprovalFloor, string, boolean]> = [
  ["computer-task", "computer_task", "EXTERNAL_SIDE_EFFECT", "POLICY", "computer/application/identity", true],
];

const PRIVATE_EQUITY_FIXED_ROWS: ReadonlyArray<readonly [string, string, ActionProfile, ApprovalFloor, string, boolean]> = [
  ["private-equity", "open_workstream", "INTERNAL_WRITE", "POLICY", "private-equity/work", false],
  ["private-equity", "create_deal_request", "INTERNAL_WRITE", "POLICY", "private-equity/work", false],
  ["private-equity", "submit_deliverable", "OPERATIONAL_CHANGE", "POLICY", "private-equity/documents", false],
  ["private-equity", "record_finding", "INTERNAL_WRITE", "POLICY", "private-equity/evidence", false],
  ["private-equity", "resolve_finding", "OPERATIONAL_CHANGE", "POLICY", "private-equity/evidence", false],
  ["private-equity", "raise_deal_risk", "INTERNAL_WRITE", "POLICY", "private-equity/risk", false],
  ["private-equity", "resolve_deal_risk", "OPERATIONAL_CHANGE", "POLICY", "private-equity/risk", false],
  ["private-equity", "link_deal_dependency", "OPERATIONAL_CHANGE", "POLICY", "private-equity/dependency", false],
  ["private-equity", "mark_dependency_resolved", "OPERATIONAL_CHANGE", "POLICY", "private-equity/dependency", false],
  ["private-equity", "create_closing_condition", "INTERNAL_WRITE", "POLICY", "private-equity/closing", false],
  ["private-equity", "submit_condition_evidence", "INTERNAL_WRITE", "POLICY", "private-equity/evidence", false],
  ["private-equity", "satisfy_closing_condition", "OPERATIONAL_CHANGE", "POLICY", "private-equity/closing", false],
  ["private-equity", "waive_closing_condition", "OPERATIONAL_CHANGE", "REQUIRED", "private-equity/closing", false],
  ["private-equity", "verify_closing_item", "OPERATIONAL_CHANGE", "POLICY", "private-equity/closing", false],
  ["private-equity", "declare_deal_closed", "OPERATIONAL_CHANGE", "TYPED_REQUIRED", "private-equity/closing", false],
];

const mapRows = (rows: ReadonlyArray<readonly [string, string, ActionProfile, ApprovalFloor, string, boolean]>): readonly ActionHardeningSpecRow[] => rows.map(([plugin, actionType, profile, approvalFloor, capabilityFamily, external]) => ({
  plugin,
  actionType,
  profile,
  approvalFloor,
  capabilityFamily,
  external,
  receipt: true as const,
}));

export const LEGACY_ACTION_HARDENING_SPEC = mapRows(LEGACY_FIXED_ROWS);
export const UNIVERSAL_ACTION_HARDENING_SPEC = mapRows(UNIVERSAL_FIXED_ROWS);
export const COMPUTER_ACTION_HARDENING_SPEC = mapRows(COMPUTER_FIXED_ROWS);
export const PRIVATE_EQUITY_ACTION_HARDENING_SPEC = mapRows(PRIVATE_EQUITY_FIXED_ROWS);
export const ACTION_HARDENING_SPEC: readonly ActionHardeningSpecRow[] = [...LEGACY_ACTION_HARDENING_SPEC, ...UNIVERSAL_ACTION_HARDENING_SPEC, ...COMPUTER_ACTION_HARDENING_SPEC, ...PRIVATE_EQUITY_ACTION_HARDENING_SPEC];
export const LEGACY_ACTION_COUNT = 44;
export const UNIVERSAL_ACTION_COUNT = 14;
export const COMPUTER_ACTION_COUNT = 1;
export const PRIVATE_EQUITY_ACTION_COUNT = 15;
/** Compatibility count for the global replay registry. Runtime and release
 * manifests must use actionHardeningSpecForVertical instead. */
export const TOTAL_ACTION_COUNT = ACTION_HARDENING_SPEC.length;

const PRIVATE_EQUITY_SHARED_ACTIONS = new Set([
  "clarification_request", "search_web", "computer_task",
  ...UNIVERSAL_ACTION_HARDENING_SPEC.map((row) => row.actionType),
]);

export function actionHardeningSpecForVertical(verticalKey: string): readonly ActionHardeningSpecRow[] {
  if (verticalKey === "private_equity") {
    return ACTION_HARDENING_SPEC.filter((row) => PRIVATE_EQUITY_SHARED_ACTIONS.has(row.actionType) || row.plugin === "private-equity");
  }
  if (verticalKey === "water") return ACTION_HARDENING_SPEC.filter((row) => row.plugin !== "private-equity");
  return ACTION_HARDENING_SPEC.filter((row) => PRIVATE_EQUITY_SHARED_ACTIONS.has(row.actionType));
}

export const ACTION_HARDENING_SPEC_BY_ACTION = new Map(ACTION_HARDENING_SPEC.map((row) => [row.actionType, row]));

/** Resolve the fixed approval floor at the execution boundary. */
export function approvalRequirementForAction(
  actionType: string,
  policyRequiresConfirmation: boolean,
  draftRequiresConfirmation: boolean,
): { requiresConfirmation: boolean; typedConfirmation: boolean; approvalFloor: ApprovalFloor } {
  const spec = ACTION_HARDENING_SPEC_BY_ACTION.get(actionType);
  if (!spec) throw new Error(`Action ${actionType} is not present in the fixed hardening spec.`);

  switch (spec.approvalFloor) {
    case "NONE":
      return { requiresConfirmation: false, typedConfirmation: false, approvalFloor: spec.approvalFloor };
    case "POLICY":
      return {
        requiresConfirmation: policyRequiresConfirmation || draftRequiresConfirmation,
        typedConfirmation: false,
        approvalFloor: spec.approvalFloor,
      };
    case "REQUIRED":
      return { requiresConfirmation: true, typedConfirmation: false, approvalFloor: spec.approvalFloor };
    case "TYPED_REQUIRED":
      return { requiresConfirmation: true, typedConfirmation: true, approvalFloor: spec.approvalFloor };
  }
}

export function requiresTypedConfirmation(actionType: string): boolean {
  return ACTION_HARDENING_SPEC_BY_ACTION.get(actionType)?.approvalFloor === "TYPED_REQUIRED";
}

if (LEGACY_ACTION_HARDENING_SPEC.length !== LEGACY_ACTION_COUNT
  || UNIVERSAL_ACTION_HARDENING_SPEC.length !== UNIVERSAL_ACTION_COUNT
  || COMPUTER_ACTION_HARDENING_SPEC.length !== COMPUTER_ACTION_COUNT
  || PRIVATE_EQUITY_ACTION_HARDENING_SPEC.length !== PRIVATE_EQUITY_ACTION_COUNT
  || new Set(ACTION_HARDENING_SPEC.map((row) => row.actionType)).size !== TOTAL_ACTION_COUNT) {
  throw new Error("Each registered action must have exactly one hardening row; vertical manifests are composed at runtime.");
}
