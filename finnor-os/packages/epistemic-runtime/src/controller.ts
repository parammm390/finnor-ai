import type {
  AcquisitionBudget,
  AcquisitionUsage,
  DecisionRequirement,
  EpistemicState,
  InformationAction,
  InformationActionScore,
  InformationObservation,
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
import { initialAcquisitionUsage } from "./state";
import { analyzeUncertainty, type AcquisitionPolicySnapshot } from "./uncertainty";
import { epistemicHash } from "./source-precedence";

export interface EpistemicControllerRound {
  index: number;
  uncertainties: Uncertainty[];
  candidates: InformationAction[];
  scores: InformationActionScore[];
  selectedAction?: InformationAction;
  observation?: InformationObservation;
  stateHashBefore: string;
  stateHashAfter: string;
  stopDecision: StopDecision;
}

export interface EpistemicControllerRun {
  initialState: EpistemicState;
  finalState: EpistemicState;
  requirements: DecisionRequirement[];
  rounds: EpistemicControllerRound[];
  usage: AcquisitionUsage;
  finalStop: StopDecision;
  startedAt: string;
  completedAt: string;
}

export interface EpistemicControllerClock {
  now(): string;
}

export interface RunEpistemicControllerInput {
  state: EpistemicState;
  requirements: readonly DecisionRequirement[];
  budget: AcquisitionBudget;
  executor: InformationActionExecutor;
  clock?: EpistemicControllerClock;
  acquisitionPolicy?: AcquisitionPolicySnapshot;
  utilityThreshold?: number;
  actionOverrides?: (uncertainty: Uncertainty, adapterId: InformationAction["adapterId"]) => InformationActionOverrides;
  usage?: AcquisitionUsage;
}

function defaultClock(): EpistemicControllerClock {
  return { now: () => new Date().toISOString() };
}

function candidatesFor(
  state: EpistemicState,
  uncertainties: readonly Uncertainty[],
  overrides?: RunEpistemicControllerInput["actionOverrides"],
): InformationAction[] {
  return uncertainties.flatMap((uncertainty) => uncertainty.possibleAcquisitionActions.map((option) => createInformationAction(
    state.scope,
    uncertainty,
    option,
    overrides?.(uncertainty, option.adapterId) ?? {},
  )));
}

function stateDecisionHash(state: EpistemicState): string {
  return epistemicHash({
    propositions: state.propositions.map((proposition) => ({ id: proposition.id, status: proposition.status, evidenceRefs: proposition.evidenceRefs, value: proposition.value })),
    evidence: state.evidence.map((record) => record.id),
    conflicts: state.conflicts.map((conflict) => ({ id: conflict.id, resolution: conflict.resolution })),
  });
}

export async function runEpistemicController(input: RunEpistemicControllerInput): Promise<EpistemicControllerRun> {
  assertAcquisitionBudget(input.budget);
  const clock = input.clock ?? defaultClock();
  const startedAt = clock.now();
  let state = input.state;
  let usage = input.usage ?? initialAcquisitionUsage();
  const rounds: EpistemicControllerRound[] = [];
  let finalStop: StopDecision | undefined;

  // maxActions is both a budget and a hard structural loop bound.
  for (let index = 0; index <= input.budget.maxActions; index += 1) {
    const now = clock.now();
    const uncertainties = analyzeUncertainty(state, input.requirements, input.acquisitionPolicy);
    const candidates = candidatesFor(state, uncertainties, input.actionOverrides);
    const selection = selectInformationAction(candidates, {
      state,
      uncertainties,
      requirements: input.requirements,
      budget: input.budget,
      usage,
      now,
    });
    const stop = decideAcquisitionStop(
      state,
      input.requirements,
      candidates,
      selection.scores,
      input.budget,
      usage,
      now,
      input.utilityThreshold,
    );
    const before = stateDecisionHash(state);
    if (stop.stop || !selection.action) {
      finalStop = stop;
      rounds.push({ index, uncertainties, candidates, scores: selection.scores, stateHashBefore: before, stateHashAfter: before, stopDecision: stop });
      break;
    }

    const selectedAction = selection.action;
    const observation = await input.executor.execute(selectedAction);
    // Worst-case reservation keeps the recorded usage within budget even if a
    // provider clock is unavailable or reports zero elapsed time.
    usage = consumeActionBudget(usage, selectedAction, selectedAction.latency.maximumMs);
    state = applyInformationObservation(state, observation);
    const after = stateDecisionHash(state);
    const noProgress = before === after;
    const roundStop: StopDecision = noProgress
      ? { stop: false, reason: "CONTINUE_ACQUISITION", unresolvedMandatory: stop.unresolvedMandatory, reasonCodes: ["SELECTED_ACTION_MADE_NO_PROGRESS", "DUPLICATE_FINGERPRINT_WILL_BE_INELIGIBLE"] }
      : { ...stop, reasonCodes: [...stop.reasonCodes, "BELIEF_STATE_UPDATED"] };
    rounds.push({ index, uncertainties, candidates, scores: selection.scores, selectedAction, observation, stateHashBefore: before, stateHashAfter: after, stopDecision: roundStop });
  }

  if (!finalStop) {
    const unresolvedMandatory = input.requirements.filter((requirement) => requirement.mandatory).map((requirement) => requirement.propositionId).sort();
    finalStop = { stop: true, reason: "BUDGET_EXHAUSTED", unresolvedMandatory, reasonCodes: ["STRUCTURAL_MAX_ACTION_BOUND_REACHED"] };
  }
  return {
    initialState: input.state,
    finalState: state,
    requirements: [...input.requirements],
    rounds,
    usage,
    finalStop,
    startedAt,
    completedAt: clock.now(),
  };
}

export function controllerMutationCount(run: EpistemicControllerRun): number {
  return run.rounds.filter((round) => round.selectedAction?.mutability !== undefined && round.selectedAction.mutability !== "READ_ONLY").length;
}
