/** S4's finite operation search. Physical successors always require readback. */
import type {
  ApplicationActionModel, ApplicationModelCheck, ApplicationSnapshot, ApplicationState,
  CheckedApplicationComposition, ExperimentRef, LearnedApplicationOperation,
} from "@finnor/shared-types";
import {
  CheckedApplicationCompositionBodySchema, parseApplicationComposition,
  sameApplicationScalar, sameX2Ref, x2Digest, x2Fault, x2Ref,
} from "./contracts";
import { assertApplicationModelUse, evaluateApplicationGuard, parameterBindingCode } from "./checker";

type Path = CheckedApplicationComposition["steps"];
type Gap = CheckedApplicationComposition["gaps"][number];
interface Node { state: ApplicationState; path: Path; gaps: Gap[]; pendingIdentities: Set<string> }
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function observedParameters(operation: LearnedApplicationOperation, state: ApplicationState, parameters: ApplicationState): ApplicationState {
  const resolved = { ...parameters };
  for (const [name, field] of Object.entries(operation.observedParameterBindings)) {
    if (own(state, field)) resolved[name] = state[field]!;
  }
  return resolved;
}
export function applicationGoalEstablished(goal: ApplicationState, observed: ApplicationState): boolean {
  return Object.keys(goal).length > 0 && Object.entries(goal).every(([field, value]) =>
    own(observed, field) && sameApplicationScalar(value, observed[field]));
}
function bindingFor(operation: LearnedApplicationOperation, supplied: ApplicationState, state: ApplicationState,
  pendingIdentities: Set<string>): {
  parameters: ApplicationState; parameterObservations: Record<string, string>;
} | null {
  const binding: ApplicationState = {};
  const parameterObservations: Record<string, string> = {};
  for (const parameter of operation.parameters) {
    const observedPath = operation.observedParameterBindings[parameter.name];
    if (observedPath) {
      if (own(state, observedPath) && !parameterBindingCode([parameter], { [parameter.name]: state[observedPath]! })
        || !own(state, observedPath) && parameter.kind === "identity" && pendingIdentities.has(observedPath)) {
        parameterObservations[parameter.name] = observedPath;
      } else if (parameter.required) return null;
    }
    else if (own(supplied, parameter.name)) binding[parameter.name] = supplied[parameter.name]!;
    else if (own(state, parameter.name)) binding[parameter.name] = state[parameter.name]!;
    else if (parameter.required) return null;
  }
  return parameterBindingCode(operation.parameters.filter((parameter) => !parameterObservations[parameter.name]), binding)
    ? null : { parameters: binding, parameterObservations };
}
export function predictedApplicationSuccessors(operation: LearnedApplicationOperation, state: ApplicationState,
  parameters: ApplicationState, model: ApplicationActionModel): Array<{ predicted: ApplicationState; requiresObservation: boolean }> {
  parameters = observedParameters(operation, state, parameters);
  const next = { ...state };
  for (const assignment of operation.postcondition.assignments) {
    const value = assignment.value.kind === "literal" ? assignment.value.value
      : assignment.value.kind === "parameter" ? parameters[assignment.value.name]
        : state[assignment.value.field];
    if (value === undefined) {
      if (assignment.value.kind !== "parameter" || !operation.observedParameterBindings[assignment.value.name]) return [];
      delete next[assignment.field];
    } else next[assignment.field] = value;
  }
  const uncertain = operation.postcondition.unknownFields.filter((field) => operation.writes.includes(field));
  for (const field of uncertain) delete next[field]; // Never retain a stale unknown identity.
  if (!uncertain.length) return [{ predicted: next, requiresObservation: false }];
  if (uncertain.some((field) => !model.stateSchema.some((item) => item.path === field))) return [];
  const finite = uncertain.filter((field) => !["identity", "quantity"].includes(model.stateSchema.find((item) => item.path === field)!.kind));
  return operation.postcondition.alternatives.filter((branch) => finite.every((field) => own(branch, field)))
    .map((branch) => ({ predicted: { ...next, ...branch }, requiresObservation: true }));
}
export function composeApplicationActions(input: {
  model: ApplicationActionModel;
  check: ApplicationModelCheck;
  initial: ApplicationSnapshot;
  goal: ApplicationState;
  parameters: ApplicationState;
  originalParentRef: ExperimentRef;
  deadlineAt: string;
  authorizedRoles: string[];
  firstOperationId?: string;
}): CheckedApplicationComposition {
  const { model, check, initial, goal, parameters } = input;
  assertApplicationModelUse(model, check);
  if (!Object.keys(goal).length || Object.keys(goal).length > 16) x2Fault("X2_NONEMPTY_TYPED_GOAL_REQUIRED");
  if (initial.scope.tenantId !== model.scope.tenantId || initial.scope.principalId !== model.scope.principalId
    || initial.scope.account !== model.scope.account || initial.scope.application !== model.scope.application
    || initial.target.account !== model.scope.account || initial.target.application !== model.scope.application) {
    x2Fault("X2_FRESH_TARGET_CURRENT_SCOPE_REQUIRED");
  }
  if (!sameX2Ref(input.originalParentRef, model.envelope.originalParentRef)
    || Date.parse(input.deadlineAt) > Date.parse(model.envelope.validUntil)
    || Date.parse(input.deadlineAt) <= Date.now()) x2Fault("X2_ORIGINAL_COMPOSITION_DEADLINE_OR_PARENT");
  const pending: Node[] = [{ state: initial.state, path: [], gaps: [], pendingIdentities: new Set() }];
  const visited = new Set<string>([x2Digest({ state: initial.state, pendingIdentities: [] })]);
  let exploredNodes = 0, selected: Node | null = null, overflow = false;
  while (pending.length && exploredNodes < 64) {
    const node = pending.shift()!;
    exploredNodes++;
    if (node.path.length && applicationGoalEstablished(goal, node.state)) { selected = node; break; }
    if (node.path.length >= 8) continue;
    for (const operation of model.operations) {
      if (!node.path.length && input.firstOperationId !== undefined && operation.id !== input.firstOperationId) continue;
      if (!check.acceptedOperationIds.includes(operation.id) || !input.authorizedRoles.includes(operation.authorization.role)) continue;
      const binding = bindingFor(operation, parameters, node.state, node.pendingIdentities);
      if (!binding) continue;
      if (evaluateApplicationGuard(operation.precondition, node.state,
        observedParameters(operation, node.state, binding.parameters)) !== true) continue;
      const successors = predictedApplicationSuccessors(operation, node.state, binding.parameters, model);
      if (!successors.length) { overflow = true; continue; }
      for (const successor of successors) {
        const pendingIdentities = new Set(node.pendingIdentities);
        for (const field of operation.writes) {
          pendingIdentities.delete(field);
          if (operation.postcondition.unknownFields.includes(field) && !own(successor.predicted, field)
            && model.stateSchema.some((item) => item.path === field && item.kind === "identity")) pendingIdentities.add(field);
        }
        const stateDigest = x2Digest({ state: successor.predicted, pendingIdentities: [...pendingIdentities].sort() });
        if (visited.has(stateDigest)) continue;
        visited.add(stateDigest);
        if (visited.size > 64) { overflow = true; continue; }
        const id = `step-${node.path.length + 1}`;
        const step: Path[number] = {
          id, operationId: operation.id, ...binding,
          // Guessed alternatives are search nodes, not verified postconditions.
          expectedState: Object.fromEntries(Object.entries(successor.predicted)
            .filter(([field]) => !operation.postcondition.unknownFields.includes(field))),
          conditionalState: successor.predicted,
          observationRequired: true,
        };
        pending.push({ state: successor.predicted, path: [...node.path, step], pendingIdentities,
          gaps: successor.requiresObservation || Object.keys(binding.parameterObservations).length
            ? [...node.gaps, { stepId: id, code: "SUCCESSOR_GUARD_REQUIRES_INDEPENDENT_OBSERVATION", observationRequired: true }]
            : node.gaps,
        });
      }
    }
  }
  const body = CheckedApplicationCompositionBodySchema.parse({
    schema: "finnor.x2.checked-composition.v1", modelRef: model.ref, checkRef: check.ref,
    originalParentRef: input.originalParentRef, scope: initial.scope, target: initial.target,
    initialObservationRef: initial.sourceRef, goal, steps: selected?.path ?? [],
    exploredNodes, gaps: selected?.gaps ?? [{ stepId: "search", code: overflow || exploredNodes >= 64
      ? "BOUNDED_SEARCH_OR_BRANCH_EXHAUSTED" : "NO_EVIDENCED_COMPOSITION", observationRequired: true }],
    disposition: selected ? "COMPOSED_WITH_REQUIRED_OBSERVATIONS" : "UNKNOWN",
    deadlineAt: input.deadlineAt, executionAuthorityGranted: false,
  });
  return parseApplicationComposition({ ...body, ref: x2Ref("S4", "application-composition", body) });
}
export function assertApplicationComposition(input: {
  composition: CheckedApplicationComposition; model: ApplicationActionModel;
  check: ApplicationModelCheck; initial: ApplicationSnapshot;
}): void {
  const { composition, model, check, initial } = input;
  parseApplicationComposition(composition);
  assertApplicationModelUse(model, check);
  if (!sameX2Ref(composition.modelRef, model.ref) || !sameX2Ref(composition.checkRef, check.ref)
    || !sameX2Ref(composition.initialObservationRef, initial.sourceRef)
    || !sameX2Ref(composition.originalParentRef, model.envelope.originalParentRef)
    || x2Digest(composition.scope) !== x2Digest(initial.scope) || x2Digest(composition.target) !== x2Digest(initial.target)
    || initial.scope.tenantId !== model.scope.tenantId || initial.scope.principalId !== model.scope.principalId
    || initial.scope.account !== model.scope.account || initial.scope.application !== model.scope.application
    || Date.parse(composition.deadlineAt) > Date.parse(model.envelope.validUntil) || Date.parse(composition.deadlineAt) <= Date.now()
    || new Set(composition.steps.map((step) => step.id)).size !== composition.steps.length
    || composition.disposition !== "COMPOSED_WITH_REQUIRED_OBSERVATIONS") x2Fault("X2_COMPOSITION_CHECK_OR_TARGET_SUBSTITUTION");
  let state = initial.state;
  const pendingIdentities = new Set<string>();
  for (const step of composition.steps) {
    const operation = model.operations.find((item) => item.id === step.operationId);
    if (!operation || !check.acceptedOperationIds.includes(operation.id)
      || parameterBindingCode(operation.parameters.filter((parameter) => !step.parameterObservations[parameter.name]), step.parameters)
      || evaluateApplicationGuard(operation.precondition, state,
        observedParameters(operation, state, step.parameters)) !== true) x2Fault("X2_COMPOSITION_GUARD_OR_PARAMETER");
    // Validate dependency availability separately from the search's binding
    // selection. A declared observation gap cannot create a missing identity.
    for (const [name, field] of Object.entries(step.parameterObservations)) {
      const parameter = operation.parameters.find((item) => item.name === name);
      if (!parameter || operation.observedParameterBindings[name] !== field
        || own(state, field) && parameterBindingCode([parameter], { [name]: state[field]! })
        || !own(state, field) && (parameter.kind !== "identity" || !pendingIdentities.has(field))) {
        x2Fault("X2_COMPOSITION_DEPENDENCY_IDENTITY_UNAVAILABLE");
      }
    }
    if (operation.parameters.some((parameter) => parameter.required && operation.observedParameterBindings[parameter.name]
      && step.parameterObservations[parameter.name] !== operation.observedParameterBindings[parameter.name])) {
      x2Fault("X2_COMPOSITION_REQUIRED_OBSERVATION_BINDING_OMITTED");
    }
    const branches = predictedApplicationSuccessors(operation, state, step.parameters, model);
    const branch = branches.find((candidate) => x2Digest(candidate.predicted) === x2Digest(step.conditionalState)
      && x2Digest(step.expectedState) === x2Digest(Object.fromEntries(Object.entries(candidate.predicted)
        .filter(([field]) => !operation.postcondition.unknownFields.includes(field)))));
    if (!branch) x2Fault("X2_COMPOSITION_POSTCONDITION_SUBSTITUTION");
    if ((branch.requiresObservation || Object.keys(step.parameterObservations).length) && !composition.gaps.some((gap) => gap.stepId === step.id
      && gap.observationRequired && gap.code === "SUCCESSOR_GUARD_REQUIRES_INDEPENDENT_OBSERVATION")) {
      x2Fault("X2_COMPOSITION_UNPROVEN_SUCCESSOR_IMPLICATION");
    }
    state = branch.predicted;
    for (const field of operation.writes) {
      pendingIdentities.delete(field);
      if (!Object.hasOwn(state, field) && operation.postcondition.unknownFields.includes(field)
        && model.stateSchema.some((item) => item.path === field && item.kind === "identity")) pendingIdentities.add(field);
    }
  }
  if (!applicationGoalEstablished(composition.goal, state)) x2Fault("X2_COMPOSITION_GOAL_NOT_IMPLIED");
}
