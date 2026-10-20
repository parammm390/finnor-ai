/** Original-observation checker. No learner, locator or inference imports. */
import type {
  ApplicationActionModel, ApplicationField, ApplicationModelCheck, ApplicationParameter, ApplicationPredicate,
  ApplicationScalar, ApplicationScope, ApplicationState, ApplicationTransitionEvidence, ExperimentRef,
} from "@finnor/shared-types";
import type { DescribedApplicationOperation } from "./ports";
import {
  ApplicationModelCheckBodySchema, parseApplicationCheck, parseApplicationModel,
  parseTransitionEvidence, sameX2Ref, x2Digest, x2Fault, x2Ref,
} from "./contracts";
import { deriveApplicationTransition } from "./observation";

const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const equal = (a: ApplicationScalar | undefined, b: ApplicationScalar | undefined) => {
  if (a === undefined || b === undefined) x2Fault("X2_CHECKER_UNAVAILABLE_EQUALITY");
  return x2Digest(a) === x2Digest(b);
};
export function evaluateApplicationGuard(predicate: ApplicationPredicate, state: ApplicationState, parameters: ApplicationState): boolean | "UNKNOWN" {
  let unavailable = false;
  for (const atom of predicate.all) {
    if (!owns(state, atom.field)) { unavailable = true; continue; }
    if (atom.operator === "present") continue;
    const values: ApplicationScalar[] = [];
    let missing = false;
    for (const expression of atom.values) {
      if (expression.kind === "literal") values.push(expression.value);
      else if (owns(parameters, expression.name)) values.push(parameters[expression.name]!);
      else missing = true;
    }
    if (missing) { unavailable = true; continue; }
    const member = values.some((value) => equal(state[atom.field], value));
    if ((atom.operator === "neq" && member) || (atom.operator !== "neq" && !member)) return false;
  }
  return unavailable ? "UNKNOWN" : true;
}
export function parameterBindingCode(schema: ApplicationParameter[], parameters: ApplicationState): string | null {
  const names = new Set(schema.map((parameter) => parameter.name));
  if (Object.keys(parameters).some((name) => !names.has(name))) return "UNDECLARED_PARAMETER";
  for (const parameter of schema) {
    if (!owns(parameters, parameter.name)) {
      if (parameter.required) return "MISSING_REQUIRED_PARAMETER";
      continue;
    }
    const value = parameters[parameter.name];
    if (parameter.kind === "boolean" && typeof value !== "boolean") return "BOOLEAN_PARAMETER_TYPE";
    if (["text", "enum"].includes(parameter.kind) && typeof value !== "string") return "TEXT_PARAMETER_TYPE";
    if (typeof value === "string" && value.length > parameter.maxLength) return "PARAMETER_LENGTH";
    if ((parameter.kind === "enum" || parameter.kind === "boolean" && parameter.values.length > 0)
      && !parameter.values.some((allowed) => equal(allowed, value))) return "ENUM_PARAMETER_DOMAIN";
    if (parameter.kind === "identity" && (!value || typeof value !== "object" || value.kind !== "identity")) return "SCOPED_IDENTITY_PARAMETER_TYPE";
    if (parameter.kind === "quantity") {
      if (!value || typeof value !== "object" || value.kind !== "quantity" || !parameter.quantityContext) return "EXACT_QUANTITY_PARAMETER_TYPE";
      const context = parameter.quantityContext;
      if (!context.currencies.includes(value.currency) || !context.units.includes(value.unit)
        || !context.bases.includes(value.basis) || !value.entity || !value.time
        || (value.decimal.split(".")[1]?.length ?? 0) > context.maxDecimalPlaces) return "QUANTITY_CONTEXT_OR_REPRESENTATION";
    }
  }
  return null;
}
export interface ApplicationCheckerFacts {
  scope: ApplicationScope;
  originalParentRef: ExperimentRef;
  checkerRef: ExperimentRef;
  runtimeRef: ExperimentRef;
  grammarRef: ExperimentRef;
  dependencyPins: Array<{ path: string; sha256: string }>;
  descriptions: DescribedApplicationOperation[];
  declaredFields: ApplicationField[];
  originalEvidence: ApplicationTransitionEvidence[];
}
export function checkApplicationModel(input: unknown, facts: ApplicationCheckerFacts): ApplicationModelCheck {
  const model = parseApplicationModel(input);
  const evidence = facts.originalEvidence.map(parseTransitionEvidence);
  if (!evidence.length || evidence.length > 256 || new Set(evidence.map((item) => item.ref.id)).size !== evidence.length) {
    x2Fault("X2_CHECKER_ORIGINAL_EVIDENCE_DOMAIN");
  }
  const failures: ApplicationModelCheck["counterexamples"] = [];
  let falseValid = 0, falseInvalid = 0, unavailable = false;
  const reject = (operationId: string, source: ExperimentRef, code: string) => {
    if (!failures.some((item) => item.operationId === operationId && sameX2Ref(item.evidenceRef, source) && item.code === code)) {
      if (failures.length >= 256) x2Fault("X2_COUNTEREXAMPLE_BOUND");
      failures.push({ operationId, evidenceRef: source, code });
    }
  };
  const representative = evidence[0]!.ref;
  if (x2Digest(model.scope) !== x2Digest(facts.scope)) reject("MODEL", representative, "MODEL_SCOPE_SUBSTITUTION");
  if (!sameX2Ref(model.envelope.originalParentRef, facts.originalParentRef)
    || evidence.some((item) => !sameX2Ref(item.originalParentRef, facts.originalParentRef))) {
    reject("MODEL", representative, "ORIGINAL_RESOURCE_PARENT_SUBSTITUTION");
  }
  if (!sameX2Ref(model.envelope.checkerRef, facts.checkerRef) || !sameX2Ref(model.envelope.runtimeRef, facts.runtimeRef)
    || !sameX2Ref(model.envelope.grammarRef, facts.grammarRef)
    || x2Digest(model.envelope.dependencyPins) !== x2Digest(facts.dependencyPins)) {
    reject("MODEL", representative, "CHECKER_RUNTIME_GRAMMAR_SOURCE_SUBSTITUTION");
  }
  const originalRefs = evidence.map((item) => item.ref);
  if (x2Digest(originalRefs) !== x2Digest(model.source_observations)
    || x2Digest(originalRefs) !== x2Digest(model.permitted_exploration_record)
    || x2Digest(originalRefs) !== x2Digest(model.envelope.evidenceRefs)) {
    reject("MODEL", representative, "ORIGINAL_EVIDENCE_OMISSION_OR_SUBSTITUTION");
  }
  if (x2Digest(model.operation_signatures) !== x2Digest(model.operations.map((item) => ({ operationId: item.id, parameters: item.parameters })))
    || x2Digest(model.precondition_predicates) !== x2Digest(model.operations.map((item) => ({ operationId: item.id, predicate: item.precondition })))
    || x2Digest(model.generated_interaction_code) !== x2Digest(model.operations.map((item) => item.privateBindingRef))
    || x2Digest(model.postcondition_observers) !== x2Digest(model.operations.map((item) => item.observerContractRef))) {
    reject("MODEL", representative, "SEMANTIC_ALIAS_SUBSTITUTION");
  }
  if (x2Digest(model.stateSchema) !== x2Digest(model.observable_state_schema)
    || x2Digest(model.stateSchema.map((field) => field.path).sort()) !== x2Digest(facts.declaredFields.map((field) => field.path).sort())
    || model.stateSchema.some((field) => {
      const declared = facts.declaredFields.find((item) => item.path === field.path);
      return !declared || declared.kind !== field.kind || declared.nullable && !field.nullable;
    })) reject("MODEL", representative, "ORIGINAL_STATE_SCHEMA_OMISSION_OR_TYPE_SUBSTITUTION");
  if (model.stateSchema.some((field) => ["identity", "quantity"].includes(field.kind) && field.observedValues.length)) {
    reject("MODEL", representative, "PRIVATE_DEMONSTRATION_FACT_IN_REUSABLE_SCHEMA");
  }
  const accepted: string[] = [];
  const fields = new Set(model.stateSchema.map((field) => field.path));
  const views = evidence.map(original => deriveApplicationTransition(original, model.stateSchema));
  for (const field of model.stateSchema) if (!field.nullable && views.some(item => [item.before, item.after].some(snapshot =>
    snapshot && owns(snapshot.state, field.path) && snapshot.state[field.path] === null))) {
    reject("MODEL", representative, "ORIGINAL_NULLABLE_FIELD_NARROWING");
  }
  for (const operation of model.operations) {
    const observed = views.filter((item) => item.operationId === operation.id);
    const descriptor = facts.descriptions.find((item) => item.id === operation.id);
    const priorFailures = failures.length;
    if (!descriptor || !observed.length) { reject(operation.id, representative, "UNOBSERVED_OPERATION"); continue; }
    if (x2Digest(descriptor.parameters) !== x2Digest(operation.parameters)
      || descriptor.role !== operation.authorization.role
      || !sameX2Ref(descriptor.privateBindingRef, operation.privateBindingRef)
      || !sameX2Ref(descriptor.observerContractRef, operation.observerContractRef)
      || descriptor.semanticRevision !== operation.semanticRevision || descriptor.renderingDigest !== operation.renderingDigest) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "ORIGINAL_SIGNATURE_BINDING_OR_VERSION_SUBSTITUTION");
    }
    if (x2Digest(observed.map((item) => item.originalEvidenceRef)) !== x2Digest(operation.evidenceRefs)) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "OPERATION_EVIDENCE_OMISSION");
    }
    const parameterNames = new Set(operation.parameters.map((parameter) => parameter.name));
    const assignments = operation.postcondition.assignments.map((item) => item.field);
    const partition = [...assignments, ...operation.postcondition.unchanged, ...operation.postcondition.unknownFields];
    if (new Set(partition).size !== partition.length || partition.length !== fields.size || partition.some((field) => !fields.has(field))
      || new Set(operation.reads).size !== operation.reads.length || new Set(operation.writes).size !== operation.writes.length
      || [...operation.reads, ...operation.writes].some((field) => !fields.has(field))
      || operation.postcondition.assignments.some((assignment) => assignment.value.kind === "parameter"
        ? !parameterNames.has(assignment.value.name)
        : assignment.value.kind === "field" ? !fields.has(assignment.value.field)
          : Boolean(assignment.value.value && typeof assignment.value.value === "object"))) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "POSTCONDITION_PARTITION_OR_DEMONSTRATION_LITERAL");
    }
    if (parameterNames.size !== operation.parameters.length
      || operation.precondition.all.some((atom) => !fields.has(atom.field) || atom.values.some((operand) =>
        operand.kind === "parameter" ? !parameterNames.has(operand.name)
          : operand.value && typeof operand.value === "object" && operand.value.kind === "identity"))) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "UNDECLARED_GUARD_OR_DEMONSTRATION_IDENTITY");
    }
    const expectedWrites = new Set<string>();
    let positives = 0;
    for (const item of observed) {
      if (item.before.scope.tenantId !== facts.scope.tenantId || item.before.scope.principalId !== facts.scope.principalId
        || item.before.scope.application !== facts.scope.application || item.before.scope.account !== facts.scope.account
        || item.before.scope.role !== operation.authorization.role || item.before.scope.rightsRef !== facts.scope.rightsRef
        || !sameX2Ref(item.before.scope.grantRef, operation.authorization.grantRef)
        || item.before.target.account !== item.before.scope.account || item.before.target.application !== item.before.scope.application) {
        reject(operation.id, item.originalEvidenceRef, "ORIGINAL_OBSERVATION_SCOPE"); continue;
      }
      const binding = parameterBindingCode(operation.parameters, item.parameters);
      if (binding) { reject(operation.id, item.originalEvidenceRef, binding); continue; }
      const guard = evaluateApplicationGuard(operation.precondition, item.before.state, item.parameters);
      if (item.disposition === "REJECTED" && item.independentOutcome === "DENIED") {
        if (guard === true) { falseValid++; reject(operation.id, item.originalEvidenceRef, "FALSE_VALID_PRECONDITION"); }
        else if (guard === "UNKNOWN") unavailable = true;
        continue;
      }
      if (item.disposition !== "OBSERVED" || item.independentOutcome !== "ESTABLISHED" || !item.after) {
        unavailable = true; continue;
      }
      positives++;
      if (guard === false) { falseInvalid++; reject(operation.id, item.originalEvidenceRef, "FALSE_INVALID_PRECONDITION"); }
      if (guard === "UNKNOWN") unavailable = true;
      if (x2Digest(item.after.scope) !== x2Digest(item.before.scope) || x2Digest(item.after.target) !== x2Digest(item.before.target)
        || item.after.applicationRevision !== item.before.applicationRevision
        || item.after.schemaDigest !== item.before.schemaDigest
        || item.after.observationQualification !== "LAWFUL_INDEPENDENT_READBACK"
        || Date.parse(item.after.observedAt) < Date.parse(item.before.observedAt)) reject(operation.id, item.originalEvidenceRef, "POSTCONDITION_TARGET_SCOPE_OR_OBSERVER");
      for (const path of fields) if (owns(item.before.state, path) && owns(item.after.state, path)
        && !equal(item.before.state[path], item.after.state[path])) expectedWrites.add(path);
      for (const assignment of operation.postcondition.assignments) {
        const expected = assignment.value.kind === "literal" ? assignment.value.value
          : assignment.value.kind === "parameter" ? item.parameters[assignment.value.name]
            : item.before.state[assignment.value.field];
        if (!fields.has(assignment.field) || expected === undefined || !owns(item.after.state, assignment.field)) {
          unavailable = true; continue;
        }
        if (!equal(expected, item.after.state[assignment.field])) reject(operation.id, item.originalEvidenceRef, "FALSE_POSTCONDITION");
      }
      for (const path of operation.postcondition.unchanged) {
        if (!owns(item.before.state, path) || !owns(item.after.state, path)) unavailable = true;
        else if (!equal(item.before.state[path], item.after.state[path])) reject(operation.id, item.originalEvidenceRef, "FALSE_UNCHANGED_FIELD");
      }
    }
    if (!positives) reject(operation.id, observed[0]!.originalEvidenceRef, "NO_POSITIVE_INDEPENDENT_OUTCOME");
    if (x2Digest([...expectedWrites].sort()) !== x2Digest([...operation.writes].sort())) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "WRITE_FOOTPRINT_OMISSION_OR_INVENTION");
    }
    if (descriptor.observationOnly ? operation.effects.classification !== "OBSERVATION" || expectedWrites.size !== 0
      : operation.effects.classification !== (expectedWrites.size ? "STATE_MUTATION" : "POSSIBLY_CONSEQUENTIAL")) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "EFFECT_CLASS_SUBSTITUTION");
    }
    if (operation.effects.replay !== "NEVER_AFTER_POSSIBLE_EGRESS"
      || operation.resources.originalParentRequired !== true || operation.postcondition.completion !== "INDEPENDENT_OBSERVATION_REQUIRED"
      || operation.resources.unresolvedEffects !== (descriptor.observationOnly ? 0 : 1)
      || [...expectedWrites].some((field) => !operation.effects.observationFields.includes(field))
      || operation.precondition.all.some((atom) => !operation.reads.includes(atom.field))
      || operation.postcondition.assignments.some((assignment) => assignment.value.kind === "field" && !operation.reads.includes(assignment.value.field))
      || operation.postcondition.asynchronous !== observed.some((item) => item.disposition === "PENDING" || item.failureCode === "ASYNC_ACCEPTANCE")) {
      reject(operation.id, observed[0]!.originalEvidenceRef, "EFFECT_OBSERVATION_OR_PARENT_CONTRACT");
    }
    const outcomes = observed.filter((item) => item.disposition === "OBSERVED" && item.after && item.independentOutcome === "ESTABLISHED");
    // Independent finite support check, not an external illegality claim.
    // Domain values come from original observations, not candidate inventories.
    for (const field of facts.declaredFields) {
      if (["identity", "quantity"].includes(field.kind) || !outcomes.length
        || outcomes.some((item) => !owns(item.before.state, field.path))) continue;
      const supported = new Set(outcomes.map((item) => x2Digest(item.before.state[field.path])));
      const domain = new Map(views.flatMap((item) => [item.before, item.after].flatMap((snapshot) =>
        snapshot && owns(snapshot.state, field.path) ? [[x2Digest(snapshot.state[field.path]), snapshot.state[field.path]!] as const] : [])));
      if (domain.size > 32) x2Fault("X2_CHECKER_ORIGINAL_STATE_PARTITION_BOUND");
      for (const [digest, value] of domain) {
        if (supported.has(digest)) continue;
        if (outcomes.some((item) => evaluateApplicationGuard(operation.precondition,
          { ...item.before.state, [field.path]: value }, item.parameters) === true)) {
          reject(operation.id, outcomes[0]!.originalEvidenceRef, "GUARD_EXPANDS_OBSERVED_PRIMITIVE_SUPPORT");
        }
      }
    }
    for (const [parameterName, path] of Object.entries(operation.observedParameterBindings)) {
      const parameter = operation.parameters.find((item) => item.name === parameterName);
      const field = model.stateSchema.find((item) => item.path === path);
      if (parameter?.kind !== "identity" || field?.kind !== "identity" || !operation.reads.includes(path)
        || new Set(outcomes.map((item) => item.before.target.id)).size < 2
        || new Set(outcomes.map((item) => owns(item.parameters, parameterName) ? x2Digest(item.parameters[parameterName]) : "MISSING")).size < 2
        || outcomes.some((item) => !owns(item.before.state, path) || !owns(item.parameters, parameterName)
          || !equal(item.before.state[path], item.parameters[parameterName]))) {
        reject(operation.id, observed[0]!.originalEvidenceRef, "FRESH_PARAMETER_OBSERVATION_BINDING_UNPROVED");
      }
    }
    const uncertainWrites = operation.postcondition.unknownFields.filter((field) => expectedWrites.has(field));
    for (const alternative of operation.postcondition.alternatives) {
      if (Object.keys(alternative).some((field) => !uncertainWrites.includes(field))
        || Object.values(alternative).some((value) => value && typeof value === "object")
        || !outcomes.some((outcome) => Object.entries(alternative).every(([field, value]) =>
          owns(outcome.after!.state, field) && equal(outcome.after!.state[field], value)))) {
        reject(operation.id, observed[0]!.originalEvidenceRef, "UNOBSERVED_CORRELATED_TRANSITION_ALTERNATIVE");
      }
    }
    for (const outcome of outcomes) {
      const visible = uncertainWrites.filter((field) => owns(outcome.after!.state, field)
        && !(outcome.after!.state[field] && typeof outcome.after!.state[field] === "object"));
      if (visible.length && !operation.postcondition.alternatives.some((branch) => visible.every((field) =>
        owns(branch, field) && equal(branch[field], outcome.after!.state[field])))) {
        reject(operation.id, outcome.originalEvidenceRef, "OBSERVED_TRANSITION_ALTERNATIVE_OMITTED");
      }
    }
    for (const path of expectedWrites) {
      const values = outcomes.map((item) => item.after!.state[path]).filter((value) => value !== undefined);
      if (values.length === outcomes.length && values.length && values.every((value) => equal(value, values[0]))
        && !operation.postcondition.assignments.some((assignment) => assignment.field === path)
        && !(values[0] && typeof values[0] === "object")) {
        reject(operation.id, outcomes[0]!.originalEvidenceRef, "KNOWN_POSTCONDITION_WITHHELD_AS_UNCERTAINTY");
      }
    }
    if (failures.length === priorFailures) accepted.push(operation.id);
  }
  const body = ApplicationModelCheckBodySchema.parse({
    schema: "finnor.x2.model-check.v1", modelRef: model.ref,
    originalEvidenceRefs: originalRefs, checkerRef: facts.checkerRef, checkedAt: new Date().toISOString(),
    disposition: failures.length ? "COUNTEREXAMPLE" : unavailable ? "UNKNOWN"
      : accepted.length === model.operations.length ? "ACCEPTED_EVIDENCED_DOMAIN" : "UNSUPPORTED",
    falseValid, falseInvalid, counterexamples: failures, acceptedOperationIds: accepted,
    externalUniversalProof: false,
  });
  return parseApplicationCheck({ ...body, ref: x2Ref("S4", "application-model-check", body) });
}
export function assertApplicationModelUse(model: ApplicationActionModel, check: ApplicationModelCheck, at = Date.now()): void {
  parseApplicationModel(model);
  parseApplicationCheck(check);
  if (!sameX2Ref(model.ref, check.modelRef) || check.disposition !== "ACCEPTED_EVIDENCED_DOMAIN"
    || check.falseValid || check.falseInvalid || check.counterexamples.length
    || x2Digest(check.acceptedOperationIds) !== x2Digest(model.operations.map((operation) => operation.id))) {
    x2Fault("X2_CURRENT_INDEPENDENT_MODEL_CHECK_REQUIRED");
  }
  if (at < Date.parse(model.envelope.validAfter) || at >= Date.parse(model.envelope.validUntil)) x2Fault("X2_MODEL_VALIDITY_EXPIRED");
}
