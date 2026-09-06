import type { OperationalQueryRequest } from "./operational-queries";

export const OBJECTIVE_SUCCESS_CONDITION_VERSION = 1 as const;

export type ObjectiveSuccessAssertionOperator =
  | "exists"
  | "not_exists"
  | "eq"
  | "not_eq"
  | "gte"
  | "lte"
  | "contains"
  | "array_contains";

export interface ObjectiveSuccessAssertion {
  path: Array<string | number>;
  operator: ObjectiveSuccessAssertionOperator;
  expected?: unknown;
}
export type ObjectiveCompletionEvidence =
  | {
      kind: "canonical_query";
      request: OperationalQueryRequest;
      assertion: ObjectiveSuccessAssertion;
    }
  | { kind: "business_effect"; businessEffectId: string }
  | { kind: "matched_event"; integrationEventId: string }
  | { kind: "delegation"; delegationId: string; requiredStatus: "acknowledged" | "accepted" | "completed" }
  | { kind: "computer_run"; computerRunId: string; evidenceRequired?: boolean };

export type ObjectiveSuccessCriterion =
  | { kind: "no_open_execution" }
  | { kind: "all_objective_effects_verified"; minimumCount: number }
  | { kind: "canonical_query"; request: OperationalQueryRequest; assertion: ObjectiveSuccessAssertion }
  | {
      kind: "private_equity_truth";
      dealId: string;
      entityType: "pe_deal" | "pe_request" | "pe_finding" | "pe_deal_risk" | "pe_closing_condition" | "pe_closing_item";
      entityId: string;
      requirement:
        | { kind: "state_in"; states: string[] }
        | { kind: "close_eligible" }
        | { kind: "deal_closed" };
    }
  | { kind: "matched_wait"; minimumCount: number; eventType?: string }
  | { kind: "delegation_state"; minimumCount: number; requiredStatus: "acknowledged" | "accepted" | "completed" }
  | { kind: "computer_run_state"; minimumCount: number; requiredStatus: "succeeded"; evidenceRequired: boolean }
  | {
      kind: "decision_evidence";
      minimumCount: number;
      accepted: Array<ObjectiveCompletionEvidence["kind"]>;
    }
  | { kind: "manual_verification"; reason: string };

/** Persisted at objective acceptance. The controller may collect evidence later, but
 * it may not weaken or replace these success conditions in order to declare success. */
export interface ObjectiveSuccessCondition {
  version: typeof OBJECTIVE_SUCCESS_CONDITION_VERSION;
  statement: string;
  mode: "all";
  source: "explicit" | "objective_first_policy" | "legacy_backfill";
  criteria: ObjectiveSuccessCriterion[];
}

export interface ObjectiveSuccessCriterionResult {
  index: number;
  kind: ObjectiveSuccessCriterion["kind"];
  satisfied: boolean;
  basis: string;
  evidenceRefs: Array<{ type: string; id: string }>;
  observed?: unknown;
}

export interface ObjectiveSuccessVerification {
  version: typeof OBJECTIVE_SUCCESS_CONDITION_VERSION;
  state: "verified" | "unsatisfied" | "blocked";
  checkedAt: string;
  conditionHash: string;
  results: ObjectiveSuccessCriterionResult[];
  evidence: ObjectiveCompletionEvidence[];
  queryExecutionIds: string[];
}
