import { describe, expect, it } from "vitest";
import { analyzeUncertainty } from "./uncertainty";
import {
  budgetAllowsAction,
  createInformationAction,
  informationActionFingerprint,
  informationActionKindsAreNonMutating,
  informationActionPrivacyErrors,
  initialAcquisitionUsage,
} from "./index";
import {
  compareInformationActionScores,
  scoreInformationAction,
  selectInformationAction,
} from "./scoring";
import { TEST_NOW, testDefinition, testOption, testRequirement, testState } from "./test-support";

const BUDGET = {
  maxActions: 3,
  maxUserInterruptions: 1,
  maxLatencyMs: 100_000_000,
  maxCostUnits: 20,
  deadline: "2026-09-01T00:00:00.000Z",
} as const;

describe("information-action contracts and deterministic scoring", () => {
  it("represents every acquisition as read-only and rejects privacy boundary violations", () => {
    expect(informationActionKindsAreNonMutating()).toBe(true);
    const state = testState([testDefinition("external.market", { kind: "external", type: "market" })]);
    const requirement = testRequirement("external.market", [testOption("RESEARCH", "WEB_RESEARCH", "PUBLIC_RESEARCH")]);
    const uncertainty = analyzeUncertainty(state, [requirement])[0]!;
    const action = createInformationAction(state.scope, uncertainty, requirement.acquisitionOptions[0]!, { sensitivity: ["PII"] });
    expect(action.mutability).toBe("READ_ONLY");
    expect(informationActionPrivacyErrors(action)).toContain("PRIVATE_DATA_TO_PUBLIC_RESEARCH_FORBIDDEN");
  });

  it("chooses a legal machine read before interrupting the user", () => {
    const state = testState([testDefinition("entity.choice")]);
    const requirement = testRequirement("entity.choice", [
      testOption("READ", "CANONICAL_OPERATIONAL_QUERY", "CANONICAL_OWNER"),
      testOption("ASK", "CLARIFICATION_REQUEST", "USER_INTENT_OWNER"),
    ]);
    const uncertainty = analyzeUncertainty(state, [requirement])[0]!;
    const actions = requirement.acquisitionOptions.map((option) => createInformationAction(state.scope, uncertainty, option));
    const selected = selectInformationAction(actions, {
      state,
      uncertainties: [uncertainty],
      requirements: [requirement],
      budget: BUDGET,
      usage: initialAcquisitionUsage(),
      now: TEST_NOW,
    });
    expect(selected.action?.kind).toBe("READ");
    expect(selected.scores.find((score) => actions.find((action) => action.id === score.actionId)?.kind === "ASK")?.reasonCodes)
      .toContain("MACHINE_SOURCE_PRECEDES_CLARIFICATION");
  });

  it("allows decision-specific clarification when the proposition is user-owned", () => {
    const state = testState([testDefinition("intent.choice", { kind: "user_intent", type: "choice" })]);
    const requirement = testRequirement("intent.choice", [testOption("ASK", "CLARIFICATION_REQUEST", "USER_INTENT_OWNER")]);
    const uncertainty = analyzeUncertainty(state, [requirement])[0]!;
    const action = createInformationAction(state.scope, uncertainty, requirement.acquisitionOptions[0]!);
    const selected = selectInformationAction([action], {
      state,
      uncertainties: [uncertainty],
      requirements: [requirement],
      budget: BUDGET,
      usage: initialAcquisitionUsage(),
      now: TEST_NOW,
    });
    expect(selected.action).toEqual(action);
    expect(action.userInterruption.promptFields).toEqual(["intent.choice"]);
  });

  it("keeps safety and legality lexicographically above convenience and cost", () => {
    const state = testState();
    const requirement = testRequirement();
    const uncertainty = analyzeUncertainty(state, [requirement])[0]!;
    const safe = createInformationAction(state.scope, uncertainty, testOption("READ", "CANONICAL_OPERATIONAL_QUERY", "CANONICAL_OWNER"), {
      estimate: { safetyLegalityPriority: 100, decisionRelevance: 100, expectedUncertaintyReduction: 70 },
      cost: { toolUnits: 20 },
    });
    const convenient = createInformationAction(state.scope, uncertainty, testOption("RETRIEVE", "HYBRID_RETRIEVAL", "SEMANTIC_MEMORY"), {
      estimate: { safetyLegalityPriority: 50, decisionRelevance: 100, expectedUncertaintyReduction: 100 },
      cost: { toolUnits: 0 },
    });
    const wideBudget = { ...BUDGET, maxCostUnits: 100 };
    const context = { state, uncertainties: [uncertainty], requirements: [requirement], budget: wideBudget, usage: initialAcquisitionUsage(), now: TEST_NOW };
    const safeScore = scoreInformationAction(safe, [safe, convenient], context);
    const convenientScore = scoreInformationAction(convenient, [safe, convenient], context);
    expect(compareInformationActionScores(safeScore, convenientScore)).toBeLessThan(0);
  });

  it("enforces hard budgets, deadline, and duplicate-loop prevention before execution", () => {
    const state = testState();
    const requirement = testRequirement();
    const uncertainty = analyzeUncertainty(state, [requirement])[0]!;
    const action = createInformationAction(state.scope, uncertainty, requirement.acquisitionOptions[0]!);
    expect(budgetAllowsAction({ ...BUDGET, maxActions: 0 }, initialAcquisitionUsage(), action, TEST_NOW).reasonCodes)
      .toContain("MAX_ACTIONS_EXCEEDED");
    expect(budgetAllowsAction(BUDGET, { ...initialAcquisitionUsage(), selectedActionFingerprints: [
      // A prior identical acquisition is enough to make a retry ineligible.
      informationActionFingerprint(action),
    ] }, action, TEST_NOW).reasonCodes).toContain("DUPLICATE_ACQUISITION_LOOP");
    expect(budgetAllowsAction(BUDGET, initialAcquisitionUsage(), action, "2026-09-01T00:00:00.000Z").reasonCodes)
      .toContain("DEADLINE_REACHED");
  });
});
