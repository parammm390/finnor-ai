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

const LEGACY_PE_ACTIONS = [
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

const P5_PLANNER_SAFE_ACTIONS = [
  "open_ic_case",
  "begin_ic_preparation",
  "select_ic_memo_version",
  "select_ic_underwriting_run",
  "create_ic_question",
  "attach_ic_question_evidence",
  "request_ic_memo_review",
  "satisfy_ic_condition",
  "prepare_ic_decision_proposal",
] as const;

const EXPECTED_PE_ACTIONS = [...P5_PLANNER_SAFE_ACTIONS, ...LEGACY_PE_ACTIONS] as const;

describe("Private Equity Phase 4 executable action contract", () => {
  it("preserves the 15 historical actions and adds only the 9 certified P5 planner-safe actions", () => {
    expect(PRIVATE_EQUITY_ACTION_TYPES).toEqual(EXPECTED_PE_ACTIONS);
    expect(privateEquityPlugin.actionTypes).toEqual(EXPECTED_PE_ACTIONS);
    expect(Object.keys(PRIVATE_EQUITY_ACTION_SCHEMAS)).toEqual(EXPECTED_PE_ACTIONS);
    expect(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => row.actionType)).toEqual(EXPECTED_PE_ACTIONS);
    expect(PRIVATE_EQUITY_ACTION_TYPES.slice(-LEGACY_PE_ACTIONS.length)).toEqual(LEGACY_PE_ACTIONS);
    expect(new Set(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => row.canonicalMutationOwner)).size).toBe(24);
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

  it("composes the PE and Core manifests and refuses the retired vertical", () => {
    const registry = createDefaultPluginRegistry();
    const pe = plannerActionTypesForVertical(registry, "private_equity");
    const shared = plannerActionTypesForVertical(registry, "none");
    const plannerSafePeActions = EXPECTED_PE_ACTIONS.filter((action) => action !== "waive_closing_condition");
    expect(pe).toHaveLength(40);
    expect(shared).toHaveLength(17);
    expect(plannerSafePeActions.every((action) => pe.includes(action))).toBe(true);
    expect(pe).not.toContain("waive_closing_condition");
    expect(EXPECTED_PE_ACTIONS.every((action) => !shared.includes(action))).toBe(true);
    expect(() => plannerActionTypesForVertical(registry, "water")).toThrow(/retired/i);
    expect(pe).not.toContain("create_invoice");
    expect(actionHardeningSpecForVertical("private_equity").map((row) => row.actionType).sort())
      .toEqual([...pe, "waive_closing_condition"].sort());
  });

  it("requires a receipt for every PE action and enforces unconditional human floors for waiver and close", () => {
    expect(PRIVATE_EQUITY_ACTION_HARDENING_SPEC).toHaveLength(24);
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
