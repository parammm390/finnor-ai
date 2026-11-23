import { describe, expect, it } from "vitest";
import {
  applicationObservationReadbackDelay,
  classifyNativeApplicationObservation,
} from "../../packages/private-equity/src/application-semantics/runtime";

function observation(overrides: Record<string, unknown> = {}) {
  const before = {
    scope: { application: "app", account: "account" }, target: { id: "record" },
    applicationRevision: "app-v1", schemaDigest: "schema-v1", observationQualification: "LAWFUL_INDEPENDENT_READBACK",
    recordRevision: "1", state: {}, unavailableFields: [], observedAt: "2026-01-01T00:00:00.000Z",
  };
  const after = { ...before, recordRevision: "2", observedAt: "2026-01-01T00:00:02.000Z" };
  const identity = { requestId: "request", effectId: "effect", obligationId: "obligation", idempotencyKey: "key",
    parentId: "parent", deadline: "2026-01-01T00:01:00.000Z" };
  const input = {
    request: { possible_egress: true, body: { wire: { expectedVersion: "1", identity,
      context: { principalId: "principal", applicationVersion: "1", schemaRevision: "schema", semanticRevision: 1 } } } },
    before,
    after,
    observedRequest: { available: true, sourceRef: { layer: "X2", type: "request", id: "source", contentDigest: "digest" },
      body: { applicationId: "app", accountId: "account", recordId: "record", principalId: "principal", request: identity,
        applicationVersion: "1", schemaRevision: "schema", semanticRevision: 1, status: "RECORDED",
        acceptedAt: "2026-01-01T00:00:01.000Z", completedAt: null } },
    response: null,
    parameters: {},
    ...overrides,
  };
  return classifyNativeApplicationObservation(input as unknown as Parameters<typeof classifyNativeApplicationObservation>[0]);
}

describe("application observation readback reconciliation", () => {
  it("retries only read-only provider states that can become authoritative", () => {
    expect(applicationObservationReadbackDelay("EXACT_REQUEST_READBACK_UNAVAILABLE", 0, 1_000, 10_000)).toBe(100);
    expect(applicationObservationReadbackDelay("ASYNC_ACCEPTANCE_NOT_COMPLETED", 3, 1_000, 10_000)).toBe(800);
    expect(applicationObservationReadbackDelay("EXACT_REQUEST_SCOPE_UNPROVED", 0, 1_000, 10_000)).toBeNull();
    expect(applicationObservationReadbackDelay("EXACT_POSTCONDITION_COVERAGE_UNAVAILABLE", 0, 1_000, 10_000)).toBeNull();
  });

  it("is finite and never crosses the original deadline", () => {
    expect(applicationObservationReadbackDelay("EXACT_REQUEST_READBACK_UNAVAILABLE", 5, 1_000, 10_000)).toBeNull();
    expect(applicationObservationReadbackDelay("EXACT_REQUEST_READBACK_UNAVAILABLE", 2, 9_700, 10_000)).toBeNull();
    expect(applicationObservationReadbackDelay("EXACT_REQUEST_READBACK_UNAVAILABLE", -1, 1_000, 10_000)).toBeNull();
  });

  it("separates transient readback absence from terminal scope and coverage failures", () => {
    expect(observation({ observedRequest: { available: false, sourceRef: null, body: null } }).reason)
      .toBe("EXACT_REQUEST_READBACK_UNAVAILABLE");
    const wrongScope = observation().reason === "INDEPENDENT_EXACT_REQUEST_AND_RECORD_TRANSITION"
      ? observation({ observedRequest: { available: true, sourceRef: { layer: "X2", type: "request", id: "source", contentDigest: "digest" },
        body: { applicationId: "other" } } }) : null;
    expect(wrongScope?.reason).toBe("EXACT_REQUEST_SCOPE_UNPROVED");
    const base = {
      scope: { application: "app", account: "account" }, target: { id: "record" }, applicationRevision: "app-v1",
      schemaDigest: "schema-v1", observationQualification: "LAWFUL_INDEPENDENT_READBACK", recordRevision: "2",
      state: {}, unavailableFields: ["reporting"], observedAt: "2026-01-01T00:00:02.000Z",
    };
    expect(observation({ after: base }).reason).toBe("EXACT_POSTCONDITION_COVERAGE_UNAVAILABLE");
  });
});
