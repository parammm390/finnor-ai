import type { Thread } from "../kernel/store"
import type { WorkspaceKind, WorkspaceProjection } from "./contracts"

const SCHEDULE_ACTIONS = new Set(["schedule_water_test", "assign_technician_to_visit", "check_technician_availability", "reschedule_visit", "route_suggestion"])
const MONEY_ACTIONS = new Set(["create_invoice", "send_payment_reminder", "record_payment", "call_overdue_invoices", "start_invoice_to_cash_workflow"])
const CUSTOMER_ACTIONS = new Set(["create_lead", "update_lead_status", "log_interaction", "assign_lead_to_technician", "send_customer_message", "send_follow_up", "answer_customer_question"])
const RESEARCH_ACTIONS = new Set(["search_web", "scan_competitors", "check_business_reviews"])
const CAMPAIGN_ACTIONS = new Set(["bulk_notify_existing_customers", "send_proposal_to_recent_installs", "launch_ad_campaign", "create_review_request"])

function queryWorkspace(intent: string): WorkspaceKind {
  if (intent === "customer_lookup" || intent === "company_context") return "customer"
  if (intent === "customer_cohort") return "customer-cohort"
  if (intent === "schedule_range") return "schedule"
  if (intent === "money_summary") return "money"
  if (intent === "work_list" || intent === "agent_activity") return "execution"
  return "plan"
}

function actionWorkspace(actionTypes: string[]): WorkspaceKind {
  if (actionTypes.some((type) => CAMPAIGN_ACTIONS.has(type))) return "campaign"
  if (actionTypes.some((type) => SCHEDULE_ACTIONS.has(type))) return "schedule"
  if (actionTypes.some((type) => MONEY_ACTIONS.has(type))) return "money"
  if (actionTypes.some((type) => CUSTOMER_ACTIONS.has(type))) return "customer"
  if (actionTypes.some((type) => RESEARCH_ACTIONS.has(type))) return "research"
  return "plan"
}

function titleFor(kind: WorkspaceKind, thread: Thread): string {
  const query = thread.answerResult?.query?.result
  if (query?.intent === "customer_lookup") return query.status === "ambiguous" ? "Customer matches" : "Customer record"
  if (query?.intent === "customer_cohort") return "Inactive customer cohort"
  if (query?.intent === "schedule_range") return "Operational schedule"
  if (query?.intent === "money_summary") return "Money position"
  if (query?.intent === "work_list") return "Active Work"
  if (query?.intent === "inventory_status") return "Inventory action plan"
  if (query?.intent === "agent_activity") return "Execution activity"
  if (query?.intent === "business_state") return "Business operating state"
  if (query?.intent === "company_context") return "Connected customer context"
  if (kind === "research") return thread.answerResult?.displaySummary ?? "Evidence-backed research"
  if (kind === "answer") return thread.answerResult?.displaySummary ?? "Direct answer"
  if (kind === "campaign") return "Campaign workspace"
  if (kind === "execution") return "Execution workspace"
  if (kind === "receipt") return "Work receipt"
  if (kind === "recovery") return "Recovery workspace"
  if (kind === "schedule") return "Schedule work"
  if (kind === "money") return "Money work"
  if (kind === "customer") return "Customer work"
  return "Plan and action"
}

export function projectThreadWorkspace(thread: Thread): WorkspaceProjection {
  const state = thread.machine.instructionState
  const actionTypes = thread.nodes.map((node) => node.actionType)
  let kind: WorkspaceKind
  if (thread.answerResult?.query) kind = queryWorkspace(thread.answerResult.query.result.intent)
  else if (thread.answerResult) kind = actionTypes.some((type) => RESEARCH_ACTIONS.has(type)) ? "research" : "answer"
  else if (state === "failed") kind = "recovery"
  else if (state === "completed" || state === "partial" || state === "cancelled") kind = "receipt"
  else if (state === "executing" || state === "verifying" || (state === "awaiting_approval" && thread.everExecuted)) kind = "execution"
  else kind = actionWorkspace(actionTypes)

  return {
    key: `${thread.workId ?? thread.id}:${thread.instructionId ?? thread.id}`,
    kind,
    title: titleFor(kind, thread),
    eyebrow: kind.replace("-", " "),
    description: thread.answerResult?.spokenSummary ?? thread.instructionText,
    state,
    workId: thread.workId ?? null,
    instructionId: thread.instructionId,
    instruction: thread.instructionText,
    updatedAtMs: Date.now(),
    actions: thread.nodes.map((node) => ({
      id: node.id,
      actionType: node.actionType,
      targetLabel: node.targetLabel,
      amountUsd: node.amountUsd,
      payload: node.payload,
      reasoning: node.reasoning,
      dependsOn: node.dependsOn,
      policyVersion: node.policyVersion,
    })),
    answer: thread.answerResult,
    query: thread.answerResult?.query ?? null,
  }
}

export const WORKSPACE_ACTION_FAMILIES = {
  schedule: SCHEDULE_ACTIONS,
  money: MONEY_ACTIONS,
  customer: CUSTOMER_ACTIONS,
  research: RESEARCH_ACTIONS,
  campaign: CAMPAIGN_ACTIONS,
}
