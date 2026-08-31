import type {
  AcquisitionBudget,
  AcquisitionUsage,
  DecisionRequirement,
  EpistemicState,
  InformationAction,
  InformationActionScore,
  InformationObservation,
  StaticAdmissibilityResultLike,
  StopDecision,
  Uncertainty,
} from "./contracts";
import { applyInformationObservation } from "./belief-update";
import {
  assertAcquisitionBudget,
  consumeActionBudget,
  createInformationAction,
  type InformationActionExecutor,
  type InformationActionOverrides,
} from "./information-actions";
import { decideAcquisitionStop, selectInformationAction } from "./scoring";
import { addPropositionDefinitions, initialAcquisitionUsage } from "./state";
import {
  analyzeUncertainty,
  requirementsFromP2Unresolved,
  type AcquisitionPolicySnapshot,
} from "./uncertainty";

export type P2P3HandoffStatus =
  | "P2_ADMISSIBLE"
  | "P2_REJECTED"
  | "P2_RESOLVED_TO_ADMISSIBLE"
  | "P2_RESOLVED_TO_REJECTED"
  | "P2_STILL_UNRESOLVED";

export interface P2P3HandoffRound {
  index: number;
  p2Before: StaticAdmissibilityResultLike;
  uncertainties: Uncertainty[];
  candidates: InformationAction[];
  scores: InformationActionScore[];
  selectedAction?: InformationAction;
  observation?: InformationObservation;
  p2After?: StaticAdmissibilityResultLike;
  stopDecision: StopDecision;
}

export interface P2P3HandoffResult {
  status: P2P3HandoffStatus;
  initialP2: StaticAdmissibilityResultLike;
  finalP2: StaticAdmissibilityResultLike;
  state: EpistemicState;
  requirements: DecisionRequirement[];
  rounds: P2P3HandoffRound[];
  usage: AcquisitionUsage;
  p2History: StaticAdmissibilityResultLike["status"][];
  rejectedOverrideAttempts: 0;
}

export interface ResolveP2WithInformationInput {
  initialP2: StaticAdmissibilityResultLike;
  state: EpistemicState;
  budget: AcquisitionBudget;
  executor: InformationActionExecutor;
  rerunP2(state: EpistemicState, previous: StaticAdmissibilityResultLike): Promise<StaticAdmissibilityResultLike>;
  now?: () => string;
  acquisitionPolicy?: AcquisitionPolicySnapshot;
  actionOverrides?: (uncertainty: Uncertainty, adapterId: InformationAction["adapterId"]) => InformationActionOverrides;
  utilityThreshold?: number;
}

function terminal(input: ResolveP2WithInformationInput): P2P3HandoffResult | null {
  if (input.initialP2.status === "ADMISSIBLE") {
    return {
      status: "P2_ADMISSIBLE",
      initialP2: input.initialP2,
      finalP2: input.initialP2,
      state: input.state,
      requirements: [],
      rounds: [],
      usage: initialAcquisitionUsage(),
      p2History: ["ADMISSIBLE"],
      rejectedOverrideAttempts: 0,
    };
  }
  if (input.initialP2.status === "REJECTED") {
    return {
      status: "P2_REJECTED",
      initialP2: input.initialP2,
      finalP2: input.initialP2,
      state: input.state,
      requirements: [],
      rounds: [],
      usage: initialAcquisitionUsage(),
      p2History: ["REJECTED"],
      rejectedOverrideAttempts: 0,
    };
  }
  return null;
}

function mergeRequirements(existing: DecisionRequirement[], additions: readonly DecisionRequirement[]): DecisionRequirement[] {
  const byId = new Map(existing.map((requirement) => [requirement.propositionId, requirement]));
  for (const requirement of additions) byId.set(requirement.propositionId, requirement);
  return [...byId.values()].sort((left, right) => left.propositionId.localeCompare(right.propositionId));
}

export async function resolveP2WithInformation(input: ResolveP2WithInformationInput): Promise<P2P3HandoffResult> {
  assertAcquisitionBudget(input.budget);
  const immediate = terminal(input);
  if (immediate) return immediate;
  const now = input.now ?? (() => new Date().toISOString());
  let currentP2 = input.initialP2;
  let state = input.state;
  let usage = initialAcquisitionUsage();
  let requirements: DecisionRequirement[] = [];
  const rounds: P2P3HandoffRound[] = [];
  const p2History: StaticAdmissibilityResultLike["status"][] = [currentP2.status];

  // Evaluate one terminal round after the last permitted acquisition. This makes
  // maxActions=0 and exhausted budgets replay-visible instead of silently falling
  // out of the loop without requirements or a stop decision.
  for (let index = 0; index <= input.budget.maxActions; index += 1) {
    // currentP2 is guaranteed UNRESOLVED here; REJECTED/ADMISSIBLE return below.
    const derived = requirementsFromP2Unresolved(currentP2, state.scope.decisionId);
    state = addPropositionDefinitions(state, derived.propositions);
    requirements = mergeRequirements(requirements, derived.requirements);
    const activeRequirements = derived.requirements;
    const uncertainties = analyzeUncertainty(state, activeRequirements, input.acquisitionPolicy);
    const candidates = uncertainties.flatMap((uncertainty) => uncertainty.possibleAcquisitionActions.map((option) => createInformationAction(
      state.scope,
      uncertainty,
      option,
      input.actionOverrides?.(uncertainty, option.adapterId) ?? {},
    )));
    const at = now();
    const selection = selectInformationAction(candidates, {
      state,
      uncertainties,
      requirements: activeRequirements,
      budget: input.budget,
      usage,
      now: at,
    });
    const stop = decideAcquisitionStop(state, activeRequirements, candidates, selection.scores, input.budget, usage, at, input.utilityThreshold);
    if (stop.stop || !selection.action) {
      rounds.push({ index, p2Before: currentP2, uncertainties, candidates, scores: selection.scores, stopDecision: stop });
      return {
        status: "P2_STILL_UNRESOLVED",
        initialP2: input.initialP2,
        finalP2: currentP2,
        state,
        requirements,
        rounds,
        usage,
        p2History,
        rejectedOverrideAttempts: 0,
      };
    }

    const observation = await input.executor.execute(selection.action);
    usage = consumeActionBudget(usage, selection.action, selection.action.latency.maximumMs);
    state = applyInformationObservation(state, observation);
    const after = await input.rerunP2(state, currentP2);
    p2History.push(after.status);
    const terminalStop: StopDecision = after.status === "ADMISSIBLE"
      ? { stop: true, reason: "P2_ADMISSIBLE", unresolvedMandatory: [], reasonCodes: ["P2_RERUN_ADMISSIBLE"] }
      : after.status === "REJECTED"
        ? { stop: true, reason: "P2_REJECTED", unresolvedMandatory: activeRequirements.map((requirement) => requirement.propositionId), reasonCodes: ["P2_RERUN_REJECTED_NO_OVERRIDE"] }
        : { stop: false, reason: "CONTINUE_ACQUISITION", unresolvedMandatory: activeRequirements.map((requirement) => requirement.propositionId), reasonCodes: ["P2_RERUN_STILL_UNRESOLVED"] };
    rounds.push({ index, p2Before: currentP2, uncertainties, candidates, scores: selection.scores, selectedAction: selection.action, observation, p2After: after, stopDecision: terminalStop });
    currentP2 = after;
    if (after.status === "ADMISSIBLE") {
      return { status: "P2_RESOLVED_TO_ADMISSIBLE", initialP2: input.initialP2, finalP2: after, state, requirements, rounds, usage, p2History, rejectedOverrideAttempts: 0 };
    }
    if (after.status === "REJECTED") {
      return { status: "P2_RESOLVED_TO_REJECTED", initialP2: input.initialP2, finalP2: after, state, requirements, rounds, usage, p2History, rejectedOverrideAttempts: 0 };
    }
  }

  return {
    status: "P2_STILL_UNRESOLVED",
    initialP2: input.initialP2,
    finalP2: currentP2,
    state,
    requirements,
    rounds,
    usage,
    p2History,
    rejectedOverrideAttempts: 0,
  };
}
