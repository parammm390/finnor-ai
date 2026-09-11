import type { DomainEnginePlugin } from "../shared/plugin-interface";
import type { DraftAction, DomainPolicy, ExecutionResult, UniversalActionType, ValidationResult } from "@finnor/shared-types";
import { UNIVERSAL_ACTION_SCHEMAS } from "./schemas";
import { executeUniversalAction } from "./runtime";
export {
  inspectCommunicationActionAvailability,
  type CommunicationActionAvailability,
} from "./runtime";
export * from "./schemas";
export * from "./delegation-state";
export * from "./endpoint-resolver";

const ACTION_TYPES: UniversalActionType[] = [
  "send_message",
  "place_call",
  "request_acknowledgement",
  "notify_group",
  "create_task",
  "assign_task",
  "update_task",
  "handoff_work",
  "delegate_objective",
  "escalate_work",
  "cancel_delegation",
  "schedule_internal_event",
  "reschedule_internal_event",
  "share_document",
];
const ACTION_SET = new Set<string>(ACTION_TYPES);

function summary(actionType: UniversalActionType, payload: Record<string, unknown>): string {
  const labels: Record<UniversalActionType, string> = {
    send_message: "Send a governed message to the referenced party",
    place_call: "Place a governed call to the referenced party",
    request_acknowledgement: "Request acknowledgement without treating delivery as acknowledgement",
    notify_group: "Notify the current active members of the referenced team",
    create_task: "Create a canonical task",
    assign_task: "Assign the canonical task",
    update_task: "Update the canonical task",
    handoff_work: "Hand off current Work ownership",
    delegate_objective: "Delegate the Work objective with deadlines and acknowledgement tracking",
    escalate_work: "Escalate the referenced delegation",
    cancel_delegation: "Cancel the referenced delegation",
    schedule_internal_event: "Schedule an internal event for canonical participants",
    reschedule_internal_event: "Reschedule the referenced internal event",
    share_document: "Share the canonical document with the referenced party",
  };
  const target = payload.recipient ?? payload.teamRef ?? payload.targetRef ?? payload.targetEmployeeRef ?? payload.assigneeRef;
  return `${labels[actionType]}${target ? ` (${JSON.stringify(target)})` : ""}.`;
}

export const universalActionsPlugin: DomainEnginePlugin = {
  name: "universal-actions",
  actionTypes: [
    "send_message",
    "place_call",
    "request_acknowledgement",
    "notify_group",
    "create_task",
    "assign_task",
    "update_task",
    "handoff_work",
    "delegate_objective",
    "escalate_work",
    "cancel_delegation",
    "schedule_internal_event",
    "reschedule_internal_event",
    "share_document",
  ],
  payloadSchemas: UNIVERSAL_ACTION_SCHEMAS,
  canHandle(actionType) {
    return ACTION_SET.has(actionType);
  },
  validate(actionType, payload): ValidationResult {
    const schema = UNIVERSAL_ACTION_SCHEMAS[actionType as UniversalActionType];
    if (!schema) return { valid: false, errors: [`unhandled action ${actionType}`] };
    const parsed = schema.safeParse(payload);
    return parsed.success
      ? { valid: true, errors: [] }
      : { valid: false, errors: parsed.error.issues.map((issue) => `payload.${issue.path.join(".")}: ${issue.message}`) };
  },
  draft(actionType, payload, policy: DomainPolicy): DraftAction {
    const typedAction = actionType as UniversalActionType;
    const parsed = UNIVERSAL_ACTION_SCHEMAS[typedAction].parse(payload) as Record<string, unknown>;
    return {
      actionType,
      summary: summary(typedAction, parsed),
      // No tenant, endpoint, route, credential, or sender secret is introduced here.
      payload: parsed,
      requiresConfirmation: policy.requiresConfirmation,
    };
  },
  simulate(actionType, payload) {
    const parsed = UNIVERSAL_ACTION_SCHEMAS[actionType as UniversalActionType].parse(payload) as Record<string, unknown>;
    return {
      mode: "schema",
      summary: `${actionType.replaceAll("_", " ")} is schema-valid. Route, authority, identity, and current tenant state will be resolved only at execution.`,
      predicted: { actionType, canonicalInputFields: Object.keys(parsed).sort(), fieldChanges: [] },
    };
  },
  async execute(draft, tools): Promise<ExecutionResult> {
    try {
      return await executeUniversalAction(draft.actionType as UniversalActionType, draft.payload, tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Universal action failed";
      const validationLike = /not found|does not exist|could not be resolved|crosses tenant|invalid|requires an authenticated|canonical entity/i.test(message);
      return { status: "failure", output: { actionType: draft.actionType }, error: message, errorKind: validationLike ? "validation" : "terminal" };
    }
  },
};

export default universalActionsPlugin;
