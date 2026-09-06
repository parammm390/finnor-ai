import { describe, expect, it } from "vitest";
import type { DomainPolicy, PartyRef, UniversalActionType } from "@finnor/shared-types";
import { UNIVERSAL_ACTION_TYPES, decideUniversalActionRoute } from "@finnor/shared-types";
import { createDefaultPluginRegistry } from "@finnor/orchestration";
import { authorityResourcesFromPayload } from "../../packages/orchestration/src/authority-runtime";
import universalActionsPlugin, {
  CommunicationIdentityRefSchema,
  SendMessageSchema,
  canTransitionDelegation,
} from "../../packages/domain-plugins/universal-actions/index";
import {
  ACTION_HARDENING_SPEC,
  TOTAL_ACTION_COUNT,
  UNIVERSAL_ACTION_HARDENING_SPEC,
} from "../../scripts/release/action-hardening-spec";

const EMPLOYEE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const WORK_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const DELEGATION_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "66666666-6666-4666-8666-666666666666";
const DOCUMENT_ID = "77777777-7777-4777-8777-777777777777";

const employee: PartyRef = { partyType: "employee", partyId: EMPLOYEE_ID };

const payloads: Record<UniversalActionType, Record<string, unknown>> = {
  send_message: { recipient: employee, channel: "internal", body: "The handoff is ready." },
  place_call: { recipient: employee, objective: "Confirm the urgent handoff." },
  request_acknowledgement: { recipient: employee, request: "Acknowledge the handoff." },
  notify_group: { teamRef: { partyType: "team", partyId: TEAM_ID }, channel: "internal", body: "Shift briefing." },
  create_task: { subjectRef: { entityType: "work", entityId: WORK_ID }, title: "Review evidence", priority: "high" },
  assign_task: { taskRef: { taskId: TASK_ID }, assigneeRef: employee },
  update_task: { taskRef: { taskId: TASK_ID }, status: "done" },
  handoff_work: { workRef: { workId: WORK_ID }, targetEmployeeRef: employee, note: "Owner-approved handoff." },
  delegate_objective: { workRef: { workId: WORK_ID }, targetRef: employee, objective: "Close the loop.", evidenceRefs: [] },
  escalate_work: { delegationRef: { delegationId: DELEGATION_ID }, reason: "Acknowledgement deadline missed.", evidenceRefs: [] },
  cancel_delegation: { delegationRef: { delegationId: DELEGATION_ID }, reason: "Objective superseded." },
  schedule_internal_event: {
    title: "Operations review",
    startsAt: "2026-09-01T10:00:00.000Z",
    endsAt: "2026-09-01T10:30:00.000Z",
    participants: [employee],
  },
  reschedule_internal_event: {
    internalEventRef: { internalEventId: EVENT_ID },
    startsAt: "2026-09-01T11:00:00.000Z",
    endsAt: "2026-09-01T11:30:00.000Z",
    reason: "Participant conflict.",
  },
  share_document: { documentRef: { documentId: DOCUMENT_ID }, recipient: employee, accessLevel: "view" },
};

function policy(actionType: string): DomainPolicy {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    tenantId: "99999999-9999-4999-8999-999999999999",
    actionType,
    policy: {},
    requiresConfirmation: true,
    confirmationTemplate: null,
    version: 1,
  };
}

describe("Universal Action + Delegation contract", () => {
  it("registers exactly the active Core, universal, computer, and Private Equity catalog", () => {
    expect(UNIVERSAL_ACTION_TYPES).toEqual([
      "send_message", "place_call", "request_acknowledgement", "notify_group",
      "create_task", "assign_task", "update_task", "handoff_work",
      "delegate_objective", "escalate_work", "cancel_delegation",
      "schedule_internal_event", "reschedule_internal_event", "share_document",
    ]);
    expect(ACTION_HARDENING_SPEC).toHaveLength(TOTAL_ACTION_COUNT);
    expect(UNIVERSAL_ACTION_HARDENING_SPEC.map((row) => row.actionType)).toEqual(UNIVERSAL_ACTION_TYPES);
    expect(universalActionsPlugin.actionTypes).toEqual(UNIVERSAL_ACTION_TYPES);

    const registered = createDefaultPluginRegistry().actionTypes();
    expect(registered).toHaveLength(TOTAL_ACTION_COUNT);
    expect(new Set(registered).size).toBe(TOTAL_ACTION_COUNT);
    expect(registered).toContain("computer_task");
    for (const row of ACTION_HARDENING_SPEC) expect(registered).toContain(row.actionType);
    for (const actionType of UNIVERSAL_ACTION_TYPES) expect(registered).toContain(actionType);
  });

  it("accepts each canonical payload and rejects planner-selected tenant, endpoint, route, or credential fields", () => {
    for (const actionType of UNIVERSAL_ACTION_TYPES) {
      const valid = universalActionsPlugin.validate(actionType, payloads[actionType], policy(actionType));
      expect(valid, actionType).toEqual({ valid: true, errors: [] });
      for (const forbidden of ["tenantId", "endpoint", "route", "credentials"]) {
        const invalid = universalActionsPlugin.validate(
          actionType,
          { ...payloads[actionType], [forbidden]: forbidden === "tenantId" ? "forged-tenant" : { secret: "do-not-accept" } },
          policy(actionType),
        );
        expect(invalid.valid, `${actionType} accepted ${forbidden}`).toBe(false);
      }
    }

    expect(SendMessageSchema.safeParse({
      ...payloads.send_message,
      recipient: { ...employee, endpoint: "+15550000000" },
    }).success).toBe(false);
    expect(CommunicationIdentityRefSchema.safeParse({
      communicationIdentityId: EMPLOYEE_ID,
      credentials: { accessToken: "secret" },
    }).success).toBe(false);
  });

  it("keeps browser and computer as non-executable route vocabulary only", () => {
    const parties: PartyRef[] = [
      employee,
      { partyType: "external_contact", partyId: TEAM_ID },
    ];
    const observed = new Set<string>();
    for (const actionType of UNIVERSAL_ACTION_TYPES) {
      for (const channel of ["internal", "email", "sms", "voice"] as const) {
        for (const recipient of parties) {
          for (const apiAvailable of [false, true]) {
            const decision = decideUniversalActionRoute({
              actionType,
              channel,
              recipient,
              apiAvailable,
              provider: apiAvailable ? "configured-provider" : null,
              externalSharingAllowed: apiAvailable,
            });
            observed.add(decision.route);
            expect(["native", "api", "manual"]).toContain(decision.route);
            if (decision.route === "browser" || decision.route === "computer") expect(decision.executable).toBe(false);
          }
        }
      }
    }
    expect(observed.has("browser")).toBe(false);
    expect(observed.has("computer")).toBe(false);
  });

  it("models delivery, acknowledgement, acceptance, and completion as separate transitions", () => {
    expect(canTransitionDelegation("sent", "delivered")).toBe(true);
    expect(canTransitionDelegation("delivered", "acknowledged")).toBe(true);
    expect(canTransitionDelegation("delivered", "accepted")).toBe(false);
    expect(canTransitionDelegation("acknowledged", "accepted")).toBe(true);
    expect(canTransitionDelegation("acknowledged", "completed")).toBe(false);
    expect(canTransitionDelegation("accepted", "completed")).toBe(true);
    expect(canTransitionDelegation("delivered", "escalated")).toBe(true);
    expect(canTransitionDelegation("completed", "cancelled")).toBe(false);
  });

  it("extracts nested PartyRefs and canonical refs for the authority boundary", () => {
    expect(authorityResourcesFromPayload({
      workRef: { workId: WORK_ID },
      targetRef: employee,
      evidenceRefs: [{ entityType: "document", entityId: DOCUMENT_ID }],
      nested: { taskRef: { taskId: TASK_ID } },
    })).toEqual(expect.arrayContaining([
      { type: "work", id: WORK_ID },
      { type: "employee", id: EMPLOYEE_ID },
      { type: "document", id: DOCUMENT_ID },
      { type: "task", id: TASK_ID },
    ]));
  });
});
