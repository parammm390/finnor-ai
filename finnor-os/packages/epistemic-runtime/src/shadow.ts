import type {
  AcquisitionBudget,
  DecisionRequirement,
  EpistemicBehaviorSummary,
  EpistemicSemanticDiff,
  EpistemicState,
  InformationAction,
  InformationAdapterId,
  InformationObservation,
  RedactedEpistemicTrace,
  StaticAdmissibilityResultLike,
} from "./contracts";
import {
  controllerMutationCount,
  runEpistemicController,
  type EpistemicControllerClock,
  type EpistemicControllerRun,
} from "./controller";
import type { InformationActionExecutor } from "./information-actions";
import { compareEpistemicBehavior } from "./semantic-diff";
import { requirementResolved } from "./state";
import { redactEpistemicTrace } from "./trace";
import { EXISTING_TRUTH_PRECEDENCE } from "./source-precedence";

export class ShadowInformationExecutor implements InformationActionExecutor {
  private readonly allowed: ReadonlySet<InformationAdapterId>;

  constructor(
    allowedAdapters: readonly InformationAdapterId[],
    private readonly inner?: InformationActionExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.allowed = new Set(allowedAdapters);
  }

  async execute(action: InformationAction): Promise<InformationObservation> {
    if (action.mutability !== "READ_ONLY") throw new Error("Shadow controller refused a consequential action");
    if (!this.allowed.has(action.adapterId)) {
      return {
        actionId: action.id,
        adapterId: action.adapterId,
        tenantId: action.scope.tenantId,
        observedAt: this.now(),
        evidence: [],
        propositionIds: action.expectedInformation.propositionIds,
        outcome: "PERMISSION_BLOCKED",
        failureCode: "SHADOW_ADAPTER_NOT_ALLOWED",
      };
    }
    if (!this.inner) {
      return {
        actionId: action.id,
        adapterId: action.adapterId,
        tenantId: action.scope.tenantId,
        observedAt: this.now(),
        evidence: [],
        propositionIds: action.expectedInformation.propositionIds,
        outcome: "NO_RESULT",
        failureCode: "SHADOW_SIMULATION_NOT_CONFIGURED",
      };
    }
    return this.inner.execute(action);
  }
}

function behaviorFromRun(
  run: EpistemicControllerRun,
  requirements: readonly DecisionRequirement[],
  p2?: StaticAdmissibilityResultLike,
): EpistemicBehaviorSummary {
  const unresolved = requirements.filter((requirement) => !requirementResolved(run.finalState, requirement));
  const known = run.finalState.propositions.filter((proposition) => proposition.status === "KNOWN");
  const selectedProposition = requirements
    .map((requirement) => known.find((proposition) => proposition.id === requirement.propositionId))
    .find((proposition) => proposition !== undefined) ?? known[0];
  const selected = selectedProposition?.source ?? null;
  const clarification = run.rounds.some((round) => round.selectedAction?.kind === "ASK");
  return {
    requiredFacts: requirements.map((requirement) => requirement.propositionId).sort(),
    factsAvailable: known.map((proposition) => proposition.id).sort(),
    canonicalFactsAvailable: run.finalState.canonicalTruth.map((truth) => truth.propositionId).sort(),
    missingFacts: unresolved.map((requirement) => requirement.propositionId).sort(),
    sourcePrecedence: [...EXISTING_TRUTH_PRECEDENCE],
    clarificationNecessary: clarification,
    selectedSource: selected,
    freshness: selectedProposition?.freshness.status ?? "UNKNOWN",
    conflicts: run.finalState.conflicts.filter((conflict) => conflict.resolution === "UNRESOLVED").map((conflict) => conflict.propositionId).sort(),
    decisionCriticalUncertainty: unresolved.filter((requirement) => requirement.mandatory).map((requirement) => requirement.propositionId).sort(),
    stopCondition: run.finalStop.reason,
    consequentialDecisionAllowed: unresolved.filter((requirement) => requirement.mandatory).length === 0
      && (p2 === undefined || p2.status === "ADMISSIBLE"),
    ...(p2 ? { p2Status: p2.status } : {}),
  };
}

export interface RunEpistemicShadowInput<T> {
  /** Existing planner result is passed through by identity and never modified. */
  authoritativePlannerResult: T;
  state: EpistemicState;
  requirements: readonly DecisionRequirement[];
  budget: AcquisitionBudget;
  existingBehavior: EpistemicBehaviorSummary;
  executor?: InformationActionExecutor;
  allowedAdapters?: readonly InformationAdapterId[];
  clock?: EpistemicControllerClock;
  p2?: StaticAdmissibilityResultLike;
}

export interface EpistemicShadowResult<T> {
  authoritativePlannerResult: T;
  run: EpistemicControllerRun;
  proposedBehavior: EpistemicBehaviorSummary;
  semanticDiff: EpistemicSemanticDiff;
  trace: RedactedEpistemicTrace;
  consequentialMutations: 0;
  plannerCallsAdded: 0;
  authoritativeBehaviorChanged: false;
}

/** Shadow-only orchestration. It performs no planner call and returns the exact
 * existing planner result object unchanged. */
export async function runEpistemicShadow<T>(input: RunEpistemicShadowInput<T>): Promise<EpistemicShadowResult<T>> {
  const executor = new ShadowInformationExecutor(
    input.allowedAdapters ?? [],
    input.executor,
    input.clock?.now ?? (() => new Date().toISOString()),
  );
  const run = await runEpistemicController({
    state: input.state,
    requirements: input.requirements,
    budget: input.budget,
    executor,
    clock: input.clock,
    acquisitionPolicy: { allowedAdapters: input.allowedAdapters ?? [] },
  });
  if (controllerMutationCount(run) !== 0) throw new Error("Shadow epistemic controller produced a consequential mutation");
  const proposedBehavior = behaviorFromRun(run, input.requirements, input.p2);
  const semanticDiff = compareEpistemicBehavior(input.existingBehavior, proposedBehavior);
  const trace = redactEpistemicTrace(run, { p2Statuses: input.p2 ? [input.p2.status] : [], semanticDiff });
  return {
    authoritativePlannerResult: input.authoritativePlannerResult,
    run,
    proposedBehavior,
    semanticDiff,
    trace,
    consequentialMutations: 0,
    plannerCallsAdded: 0,
    authoritativeBehaviorChanged: false,
  };
}
