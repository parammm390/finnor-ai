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

import { PRIVATE_EQUITY_VERTICAL, assertExecutableVertical } from "@finnor/shared-types";

/** Fixed executable Core actions; historical vertical actions live only in the
 * central retirement ledger and immutable evidence artifacts. */
const CORE_FIXED_ROWS: ReadonlyArray<readonly [string, string, ActionProfile, ApprovalFloor, string, boolean]> = [
  ["clarification", "clarification_request", "META_NO_SIDE_EFFECT", "NONE", "none", false],
  ["web-research", "search_web", "READ_ONLY", "NONE", "exa/firecrawl/evidence", false],
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
  ["private-equity", "open_ic_case", "DURABLE_WORKFLOW", "REQUIRED", "private-equity/ic/work/authority", false],
  ["private-equity", "begin_ic_preparation", "OPERATIONAL_CHANGE", "POLICY", "private-equity/ic/work", false],
  ["private-equity", "select_ic_memo_version", "OPERATIONAL_CHANGE", "REQUIRED", "private-equity/ic/artifacts", false],
  ["private-equity", "select_ic_underwriting_run", "OPERATIONAL_CHANGE", "REQUIRED", "private-equity/ic/underwriting", false],
  ["private-equity", "create_ic_question", "INTERNAL_WRITE", "POLICY", "private-equity/ic/evidence/work", false],
  ["private-equity", "attach_ic_question_evidence", "INTERNAL_WRITE", "POLICY", "private-equity/ic/evidence", false],
  ["private-equity", "request_ic_memo_review", "OPERATIONAL_CHANGE", "POLICY", "private-equity/ic/artifacts/work", false],
  ["private-equity", "satisfy_ic_condition", "OPERATIONAL_CHANGE", "POLICY", "private-equity/ic/evidence/work", false],
  ["private-equity", "prepare_ic_decision_proposal", "INTERNAL_DRAFT", "POLICY", "private-equity/ic/policy", false],
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

export const CORE_ACTION_HARDENING_SPEC = mapRows(CORE_FIXED_ROWS);
export const UNIVERSAL_ACTION_HARDENING_SPEC = mapRows(UNIVERSAL_FIXED_ROWS);
export const COMPUTER_ACTION_HARDENING_SPEC = mapRows(COMPUTER_FIXED_ROWS);
export const PRIVATE_EQUITY_ACTION_HARDENING_SPEC = mapRows(PRIVATE_EQUITY_FIXED_ROWS);
export const ACTION_HARDENING_SPEC: readonly ActionHardeningSpecRow[] = [...CORE_ACTION_HARDENING_SPEC, ...UNIVERSAL_ACTION_HARDENING_SPEC, ...COMPUTER_ACTION_HARDENING_SPEC, ...PRIVATE_EQUITY_ACTION_HARDENING_SPEC];
export const CORE_ACTION_COUNT = 2;
export const UNIVERSAL_ACTION_COUNT = 14;
export const COMPUTER_ACTION_COUNT = 1;
export const PRIVATE_EQUITY_ACTION_COUNT = 24;
export const EXECUTABLE_ACTION_COUNT = ACTION_HARDENING_SPEC.length;
/** Compatibility alias for release scripts that count the complete executable set. */
export const TOTAL_ACTION_COUNT = EXECUTABLE_ACTION_COUNT;

const PRIVATE_EQUITY_SHARED_ACTIONS = new Set([
  "clarification_request", "search_web", "computer_task",
  ...UNIVERSAL_ACTION_HARDENING_SPEC.map((row) => row.actionType),
]);

export function actionHardeningSpecForVertical(verticalKey: string): readonly ActionHardeningSpecRow[] {
  assertExecutableVertical(verticalKey);
  if (verticalKey === PRIVATE_EQUITY_VERTICAL) {
    return ACTION_HARDENING_SPEC.filter((row) => PRIVATE_EQUITY_SHARED_ACTIONS.has(row.actionType) || row.plugin === "private-equity");
  }
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

if (CORE_ACTION_HARDENING_SPEC.length !== CORE_ACTION_COUNT
  || UNIVERSAL_ACTION_HARDENING_SPEC.length !== UNIVERSAL_ACTION_COUNT
  || COMPUTER_ACTION_HARDENING_SPEC.length !== COMPUTER_ACTION_COUNT
  || PRIVATE_EQUITY_ACTION_HARDENING_SPEC.length !== PRIVATE_EQUITY_ACTION_COUNT
  || new Set(ACTION_HARDENING_SPEC.map((row) => row.actionType)).size !== EXECUTABLE_ACTION_COUNT) {
  throw new Error("Each registered action must have exactly one hardening row; vertical manifests are composed at runtime.");
}
