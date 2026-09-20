import { describe, expect, it } from "vitest";
import { integrationEventMatchesWait } from "@finnor/db";

type Event = Parameters<typeof integrationEventMatchesWait>[0];
type Wait = Parameters<typeof integrationEventMatchesWait>[1];

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORK_A = "00000000-0000-4000-8000-000000000010";
const WORK_B = "00000000-0000-4000-8000-000000000011";
const PARTY = "00000000-0000-4000-8000-000000000020";
const DELEGATION = "00000000-0000-4000-8000-000000000030";

function event(overrides: Partial<Event> = {}): Event {
  const occurredAt = new Date("2026-08-22T10:29:59.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000040",
    tenantId: TENANT,
    source: "test",
    provider: "email",
    sourceEventId: "provider-event-1",
    eventType: "delegation.acknowledged",
    occurredAt,
    receivedAt: occurredAt,
    partyType: "employee",
    partyId: PARTY,
    resourceType: "delegation",
    resourceId: DELEGATION,
    workId: WORK_A,
    taskId: null,
    delegationId: DELEGATION,
    acknowledgementRequestId: null,
    computerRunId: null,
    domainActionId: null,
    providerConversationId: null,
    providerMessageId: null,
    applicationRef: null,
    correlationId: null,
    payload: {},
    evidenceRefs: [],
    trustClass: "trusted_runtime",
    contentTreatment: "untrusted_evidence",
    instructionEligible: false,
    status: "received",
    matchedAt: null,
    processedAt: null,
    createdAt: occurredAt,
    ...overrides,
  };
}

function wait(overrides: Partial<Wait> = {}): Wait {
  const earliestAt = new Date("2026-08-22T10:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000050",
    tenantId: TENANT,
    workId: WORK_A,
    objectiveLoopId: "00000000-0000-4000-8000-000000000060",
    objectiveStepId: "00000000-0000-4000-8000-000000000070",
    planRevisionId: null,
    planNodeId: null,
    objectiveRevision: null,
    status: "waiting",
    expectedEventType: "delegation.acknowledged",
    subjectType: "employee",
    subjectId: PARTY,
    resourceType: "delegation",
    resourceId: DELEGATION,
    delegationId: DELEGATION,
    taskId: null,
    acknowledgementRequestId: null,
    computerRunId: null,
    domainActionId: null,
    provider: null,
    providerConversationId: null,
    providerMessageId: null,
    applicationRef: null,
    correlationId: null,
    conditionSummary: "Mario acknowledges this delegation",
    continuationPolicy: { mode: "reinspect_current_state", maxDecisions: 1 },
    earliestAt,
    deadlineAt: new Date("2026-08-22T10:30:00.000Z"),
    matchedEventId: null,
    satisfiedAt: null,
    timedOutAt: null,
    cancelledAt: null,
    createdAt: earliestAt,
    updatedAt: earliestAt,
    ...overrides,
  };
}

describe("Phase 4 deterministic event-to-wait matching", () => {
  it("matches exact canonical Work, PartyRef, resource, event type, and timestamp", () => {
    expect(integrationEventMatchesWait(event(), wait())).toBe(true);
  });

  it("never lets the same Mario satisfy a different Work", () => {
    expect(integrationEventMatchesWait(event({ workId: WORK_B }), wait())).toBe(false);
  });

  it("rejects wrong refs and events outside the wait window", () => {
    expect(integrationEventMatchesWait(event({ delegationId: "00000000-0000-4000-8000-000000000031" }), wait())).toBe(false);
    expect(integrationEventMatchesWait(event({ occurredAt: new Date("2026-08-22T10:30:00.001Z") }), wait())).toBe(false);
  });

  it("accepts an exact provider conversation or application ref without guessing from text", () => {
    const supplierWait = wait({
      expectedEventType: "email.reply_received",
      subjectType: null,
      subjectId: null,
      resourceType: null,
      resourceId: null,
      delegationId: null,
      provider: "email",
      providerConversationId: "thread-WS-48",
    });
    expect(integrationEventMatchesWait(event({
      eventType: "email.reply_received",
      workId: null,
      partyType: null,
      partyId: null,
      resourceType: null,
      resourceId: null,
      delegationId: null,
      providerConversationId: "thread-WS-48",
    }), supplierWait)).toBe(true);

    const applicationWait = wait({
      expectedEventType: "calendar.response_changed",
      subjectType: null,
      subjectId: null,
      resourceType: null,
      resourceId: null,
      delegationId: null,
      applicationRef: "calendar-event-123",
    });
    expect(integrationEventMatchesWait(event({
      eventType: "calendar.response_changed",
      workId: null,
      partyType: null,
      partyId: null,
      resourceType: null,
      resourceId: null,
      delegationId: null,
      applicationRef: "calendar-event-123",
    }), applicationWait)).toBe(true);
  });

  it("does not treat a PartyRef alone as a cross-Work correlation", () => {
    expect(integrationEventMatchesWait(
      event({ workId: null, resourceType: null, resourceId: null, delegationId: null }),
      wait({ resourceType: null, resourceId: null, delegationId: null }),
    )).toBe(false);
  });
});
