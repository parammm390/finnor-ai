import { describe, expect, it } from "vitest";
import {
  privateEquityPlugin,
} from "../../packages/domain-plugins/private-equity/index";
import {
  PRIVATE_EQUITY_ACTION_HARDENING_SPEC,
  approvalRequirementForAction,
} from "../../scripts/release/action-hardening-spec";

describe("Private Equity Phase 4 executable action contract", () => {
  it("rejects invented tenant, provider, credential, and integration selectors at the schema boundary", () => {
    const payload = {
      dealId: "11111111-1111-4111-8111-111111111111",
      kind: "legal",
      name: "Legal diligence",
      owner: { partyType: "employee", partyId: "22222222-2222-4222-8222-222222222222" },
    };
    expect(privateEquityPlugin.validate("open_workstream", payload, {} as never).valid).toBe(true);
    for (const forbidden of ["tenantId", "provider", "credentialId", "integrationBindingId"] as const) {
      const result = privateEquityPlugin.validate("open_workstream", { ...payload, [forbidden]: "attacker-selected" }, {} as never);
      expect(result.valid, forbidden).toBe(false);
    }
  });

  it("requires a receipt for every PE action and enforces unconditional human floors for waiver and close", () => {
    expect(PRIVATE_EQUITY_ACTION_HARDENING_SPEC.every((row) => row.receipt)).toBe(true);
    expect(approvalRequirementForAction("waive_closing_condition", false, false)).toEqual({
      requiresConfirmation: true,
      typedConfirmation: false,
      approvalFloor: "REQUIRED",
    });
    expect(approvalRequirementForAction("declare_deal_closed", false, false)).toEqual({
      requiresConfirmation: true,
      typedConfirmation: true,
      approvalFloor: "TYPED_REQUIRED",
    });
  });
});
