import { describe, expect, it } from "vitest";
import {
  PRIVATE_EQUITY_ACTION_CONTRACTS,
  PRIVATE_EQUITY_ACTION_SCHEMAS,
  PRIVATE_EQUITY_ACTION_TYPES,
  privateEquityPlugin,
} from "../../packages/domain-plugins/private-equity/index";
import {
  PRIVATE_EQUITY_ACTION_HARDENING_SPEC,
  actionHardeningSpecForVertical,
  approvalRequirementForAction,
} from "../../scripts/release/action-hardening-spec";
import { createDefaultPluginRegistry, plannerActionTypesForVertical } from "@finnor/orchestration";

const EXPECTED_PE_ACTIONS = [
  "open_workstream",
  "create_deal_request",
  "submit_deliverable",
  "record_finding",
  "resolve_finding",
  "raise_deal_risk",
  "resolve_deal_risk",
  "link_deal_dependency",
  "mark_dependency_resolved",
  "create_closing_condition",
  "submit_condition_evidence",
  "satisfy_closing_condition",
  "waive_closing_condition",
  "verify_closing_item",
  "declare_deal_closed",
] as const;

describe("Private Equity Phase 4 executable action contract", () => {
  it("registers exactly the 15 schema-backed PE actions with one PE2 mutation owner and the core receipt path", () => {
    expect(PRIVATE_EQUITY_ACTION_TYPES).toEqual(EXPECTED_PE_ACTIONS);
    expect(privateEquityPlugin.actionTypes).toEqual(EXPECTED_PE_ACTIONS);
    expect(Object.keys(PRIVATE_EQUITY_ACTION_SCHEMAS)).toEqual(EXPECTED_PE_ACTIONS);
    expect(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => row.actionType)).toEqual(EXPECTED_PE_ACTIONS);
    expect(new Set(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => row.canonicalMutationOwner)).size).toBe(15);
    expect(PRIVATE_EQUITY_ACTION_CONTRACTS.every((row) => (
      row.idempotencyIdentity === "domain_action_id"
      && row.verification === "canonical_return_and_reread"
      && row.receiptPath === "core_durable_action_receipt"
    ))).toBe(true);
  });

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

  it("composes manifests by vertical and keeps PE actions out of Water planning", () => {
    const registry = createDefaultPluginRegistry();
    const pe = plannerActionTypesForVertical(registry, "private_equity");
    const water = plannerActionTypesForVertical(registry, "water");
    const shared = plannerActionTypesForVertical(registry, "none");
    expect(pe).toHaveLength(32);
    expect(water).toHaveLength(59);
    expect(shared).toHaveLength(17);
    expect(EXPECTED_PE_ACTIONS.every((action) => pe.includes(action))).toBe(true);
    expect(EXPECTED_PE_ACTIONS.every((action) => !water.includes(action) && !shared.includes(action))).toBe(true);
    expect(pe).not.toContain("create_invoice");
    expect(actionHardeningSpecForVertical("private_equity").map((row) => row.actionType).sort()).toEqual([...pe].sort());
  });

  it("requires a receipt for every PE action and enforces unconditional human floors for waiver and close", () => {
    expect(PRIVATE_EQUITY_ACTION_HARDENING_SPEC).toHaveLength(15);
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
