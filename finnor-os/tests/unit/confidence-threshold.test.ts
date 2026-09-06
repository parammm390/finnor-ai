// §5.5: "thresholds live in policy rows, not code" — readConfidenceThreshold pulls a
// plain number from domain_policies.policy, never fabricates a default itself.

import { describe, it, expect } from "vitest";
import { readConfidenceThreshold } from "@finnor/plugins-shared";
import type { DomainPolicy } from "@finnor/shared-types";

function policyWith(policy: Record<string, unknown>): DomainPolicy {
  return {
    id: "p1",
    tenantId: "t1",
    actionType: "record_finding",
    policy,
    requiresConfirmation: false,
    confirmationTemplate: null,
    version: 1,
  };
}

describe("readConfidenceThreshold", () => {
  it("returns the configured number", () => {
    expect(readConfidenceThreshold(policyWith({ retrievalConfidenceThreshold: 0.8 }))).toBe(0.8);
  });

  it("returns undefined when unset — never fabricates a default", () => {
    expect(readConfidenceThreshold(policyWith({}))).toBeUndefined();
  });

  it("returns undefined for a non-number value rather than coercing it", () => {
    expect(readConfidenceThreshold(policyWith({ retrievalConfidenceThreshold: "0.8" }))).toBeUndefined();
  });
});
