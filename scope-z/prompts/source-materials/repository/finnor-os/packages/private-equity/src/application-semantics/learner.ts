import type {
  ApplicationActionModel, ApplicationAssignmentOperand, ApplicationField, ApplicationPredicate,
  ApplicationScalar, ApplicationState, ApplicationTransitionEvidence, LearnedApplicationOperation,
  ScopedApplicationIdentity,
} from "@finnor/shared-types";
import type { ApplicationDiscovery, ApplicationLearningPort, DescribedApplicationOperation } from "./ports";
import {
  ApplicationActionModelBodySchema, parseApplicationModel, parseTransitionEvidence,
  sameApplicationScalar, X2_LIMITS, x2Digest, x2Fault, x2Ref,
} from "./contracts";
import { buildApplicationEnvelope } from "./envelope";
import { deriveApplicationTransition, projectApplicationSnapshot, type ApplicationTransitionView } from "./observation";

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const distinct = (values: Array<ApplicationScalar | undefined>) => {
  const result: ApplicationScalar[] = [];
  for (const value of values) {
    if (value === undefined) x2Fault("X2_UNAVAILABLE_INFERENCE_VALUE");
    if (!result.some((other) => sameApplicationScalar(other, value))) result.push(value);
  }
  return result;
};
function inferGuard(evidence: ApplicationTransitionView[], fields: ApplicationField[]): ApplicationPredicate {
  const positive = evidence.filter((item) => item.disposition === "OBSERVED" && item.independentOutcome === "ESTABLISHED");
  if (!positive.length) return { all: [] };
  const atoms: ApplicationPredicate["all"] = [];
  for (const field of fields) {
    if (field.kind === "identity" || field.kind === "quantity") continue;
    const values = distinct(positive.filter((item) => owns(item.before.state, field.path)).map((item) => item.before.state[field.path]));
    if (!values.length || positive.some((item) => !owns(item.before.state, field.path))) continue;
    atoms.push({ field: field.path, operator: values.length === 1 ? "eq" : "in", values: values.map((value) => ({ kind: "literal", value })) });
  }
  // No negative sample is not evidence of an unconditional operation.
  // These are conservative observed partitions, not universally learned law.
  return { all: atoms };
}
function inferredOperation(description: DescribedApplicationOperation, evidence: ApplicationTransitionView[], fields: ApplicationField[]): LearnedApplicationOperation | null {
  const successful = evidence.filter((item) => item.disposition === "OBSERVED" && item.after && item.independentOutcome === "ESTABLISHED");
  if (!successful.length) return null;
  const assignments: LearnedApplicationOperation["postcondition"]["assignments"] = [];
  const unchanged: string[] = [], unknownFields: string[] = [], writes: string[] = [];
  const observedParameterBindings: Record<string, string> = {};
  for (const parameter of description.parameters.filter((item) => item.kind === "identity")) {
    const candidates = fields.filter((field) => field.kind === "identity" && successful.every((item) =>
      owns(item.before.state, field.path) && owns(item.parameters, parameter.name)
      && sameApplicationScalar(item.before.state[field.path], item.parameters[parameter.name])));
    if (candidates.length === 1 && new Set(successful.map((item) => item.before.target.id)).size >= 2
      && distinct(successful.map((item) => item.parameters[parameter.name])).length >= 2) {
      observedParameterBindings[parameter.name] = candidates[0]!.path;
    }
  }
  for (const field of fields) {
    const complete = successful.every((item) => item.after && owns(item.before.state, field.path) && owns(item.after.state, field.path));
    if (!complete) {
      unknownFields.push(field.path);
      if (successful.some((item) => owns(item.before.state, field.path) && owns(item.after!.state, field.path)
        && !sameApplicationScalar(item.before.state[field.path], item.after!.state[field.path]))) writes.push(field.path);
      continue;
    }
    if (successful.every((item) => sameApplicationScalar(item.before.state[field.path], item.after!.state[field.path]))) {
      unchanged.push(field.path);
      continue;
    }
    writes.push(field.path);
    let operand: ApplicationAssignmentOperand | null = null;
    for (const parameter of description.parameters) {
      if (successful.every((item) => owns(item.parameters, parameter.name)
        && sameApplicationScalar(item.parameters[parameter.name], item.after!.state[field.path]))
        && distinct(successful.map((item) => item.parameters[parameter.name])).length >= 2) {
        operand = { kind: "parameter", name: parameter.name };
        break;
      }
    }
    if (!operand) for (const source of fields) {
      if (source.path === field.path) continue;
      if (successful.every((item) => owns(item.before.state, source.path)
        && sameApplicationScalar(item.before.state[source.path], item.after!.state[field.path]))
        && distinct(successful.map((item) => item.before.state[source.path])).length >= 2) {
        operand = { kind: "field", field: source.path };
        break;
      }
    }
    const outcomes = distinct(successful.map((item) => item.after!.state[field.path]));
    if (!operand && outcomes.length === 1 && field.kind !== "identity" && field.kind !== "quantity") {
      operand = { kind: "literal", value: outcomes[0]! };
    }
    if (operand) assignments.push({ field: field.path, value: operand });
    else unknownFields.push(field.path);
  }
  const uncertainWrites = unknownFields.filter((path) => writes.includes(path));
  const alternatives = [...new Map(successful.map((item) => {
    const state = Object.fromEntries(uncertainWrites.flatMap((path) => {
      const value = item.after!.state[path];
      return value === undefined || value && typeof value === "object" ? [] : [[path, value]];
    })) as ApplicationState;
    return [x2Digest(state), state] as const;
  })).values()];
  if (alternatives.length > 8) x2Fault("X2_TRANSITION_BRANCH_BOUND");
  const precondition = inferGuard(evidence, fields);
  return {
    id: description.id, label: description.label, parameters: description.parameters, observedParameterBindings,
    precondition,
    postcondition: {
      assignments, unchanged, unknownFields, alternatives,
      completion: "INDEPENDENT_OBSERVATION_REQUIRED",
      asynchronous: evidence.some((item) => item.disposition === "PENDING" || item.failureCode === "ASYNC_ACCEPTANCE"),
    },
    reads: [...new Set([...assignments.map((item) => item.field),
      ...assignments.flatMap((item) => item.value.kind === "field" ? [item.value.field] : []), ...unchanged,
      ...precondition.all.map((item) => item.field), ...Object.values(observedParameterBindings)])],
    writes, effects: {
      classification: description.observationOnly ? "OBSERVATION" : writes.length ? "STATE_MUTATION" : "POSSIBLY_CONSEQUENTIAL",
      replay: "NEVER_AFTER_POSSIBLE_EGRESS",
      observationFields: [...new Set([...writes, ...unchanged])],
    },
    authorization: { role: description.role, grantRef: successful[0]!.before.scope.grantRef, commitment: "CURRENT_NATIVE_AND_EXTERNAL_AUTHORITY_REQUIRED" },
    resources: { originalParentRequired: true, maximumInteractions: 64, unresolvedEffects: description.observationOnly ? 0 : 1 },
    observerContractRef: description.observerContractRef, privateBindingRef: description.privateBindingRef,
    semanticRevision: description.semanticRevision, renderingDigest: description.renderingDigest,
    dependencies: description.sourceRefs, evidenceRefs: evidence.map((item) => item.originalEvidenceRef),
    uncertainty: {
      identification: unknownFields.length ? "PARTIALLY_IDENTIFIED" : "EVIDENCE_SUPPORTED",
      assumptions: ["Observed scope and typed input partitions; current independent observation before every consequential successor"],
      unobservedCases: ["Unseen external states and policy changes are not universally identified"],
      falsifierRefs: evidence.filter((item) => item.disposition !== "OBSERVED").map((item) => item.originalEvidenceRef),
    },
  };
}
function observedFields(discovery: ApplicationDiscovery, evidence: ApplicationTransitionEvidence[]): ApplicationField[] {
  const byPath = new Map(discovery.fields.map((item) => [item.path, structuredClone(item)]));
  for (const item of evidence) for (const observation of [item.before, item.after].filter(Boolean)) {
    const original = observation!, kinds = original.structuralWitness?.leafKinds;
    for (const [path, value] of Object.entries(original.structuralWitness?.leaves ?? original.state)) {
      if (value === null && !byPath.has(path)) continue;
      const kind = kinds?.[path] ?? (typeof value === "boolean" ? "boolean"
        : value && typeof value === "object" && "kind" in value ? value.kind : "text");
      if (!["text", "boolean", "enum", "quantity", "identity"].includes(String(kind))) x2Fault("X2_UNSUPPORTED_ORIGINAL_FIELD_KIND");
      const previous = byPath.get(path);
      if (previous && previous.kind !== kind) x2Fault("X2_ORIGINAL_FIELD_KIND_DRIFT");
      if (!previous) byPath.set(path, { path, kind: kind as ApplicationField["kind"],
        nullable: false, observedValues: [], observationRefs: [original.sourceRef] });
    }
  }
  if (byPath.size > 16) x2Fault("X2_STATE_FIELD_BOUND");
  const fields = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const item of evidence) for (const original of [item.before, item.after].filter(Boolean)) {
    const view = projectApplicationSnapshot(original, fields);
    for (const field of fields) if (owns(view.state, field.path)) {
      const value = view.state[field.path]!;
      field.nullable ||= value === null;
      field.observedValues = ["quantity", "identity"].includes(field.kind) ? [] : distinct([...field.observedValues, value]);
      field.observationRefs = [...new Map([...field.observationRefs, original!.sourceRef].map(ref => [x2Digest(ref), ref])).values()];
      if (field.observedValues.length > 32) x2Fault("X2_STATE_PARTITION_BOUND");
    }
  }
  return fields;
}

export async function learnApplicationActions(port: ApplicationLearningPort, targets: ScopedApplicationIdentity[]): Promise<ApplicationActionModel> {
  if (targets.length < 2 || targets.length > 16 || new Set(targets.map((target) => target.id)).size !== targets.length) {
    x2Fault("X2_DISTINCT_AUTHORIZED_EXPLORATION_TARGETS_REQUIRED");
  }
  await port.assertCurrent();
  let discovery = await port.discover();
  if (!discovery.operations.length || discovery.operations.length > 16) x2Fault("X2_DISCOVERED_OPERATION_BOUND");
  const tested = new Set<string>();
  const experiments = new Map<string, number>();
  let interactions = 0;
  for (let wave = 0; wave < 8 && interactions < X2_LIMITS.maxExplorationInteractions; wave++) {
    if (wave) {
      const next = await port.discover();
      const operations = [...new Map([...discovery.operations, ...next.operations].map((item) => [item.id, item])).values()];
      if (operations.length > 16) x2Fault("X2_DISCOVERED_OPERATION_BOUND");
      discovery = { ...next, operations,
        fields: [...new Map([...discovery.fields, ...next.fields].map(field => [field.path, field])).values()],
        sourceRefs: [...new Map([...discovery.sourceRefs, ...next.sourceRefs].map((ref) => [ref.id, ref])).values()],
        typeSignatureRefs: [...new Map([...discovery.typeSignatureRefs, ...next.typeSignatureRefs].map((ref) => [ref.id, ref])).values()],
      };
    }
    let progress = false;
    for (const target of targets) for (const description of discovery.operations) {
      await port.assertCurrent();
      const observation = await port.observe(target, description.profileId);
      const samples = await port.parameterSamples(description, observation);
      if (!samples.length) continue; // An uncreated identity is not a fabricated sample.
      if (samples.length > 8) x2Fault("X2_PARAMETER_SAMPLE_BOUND");
      const experimentKey = x2Digest([description.id, description.profileId]);
      const offset = (experiments.get(experimentKey) ?? 0) % samples.length;
      const ordered = [...samples.slice(offset), ...samples.slice(0, offset)];
      for (const parameters of ordered) {
        if (interactions >= X2_LIMITS.maxExplorationInteractions) break;
        const key = x2Digest([description.id, description.profileId, target.id, observation.state, parameters]);
        if (tested.has(key)) continue;
        tested.add(key);
        await port.charge({ phase: "ACQUISITION", units: 1 });
        const evidence = parseTransitionEvidence(await port.interact({
          operation: description, target, parameters, purpose: "AUTHORIZED_EXPLORATION",
        }));
        interactions++;
        experiments.set(experimentKey, (experiments.get(experimentKey) ?? 0) + 1);
        if (evidence.after && x2Digest(evidence.before.state) !== x2Digest(evidence.after.state)) progress = true;
        // Re-observe before any other physical experiment. This loop never
        // replays an UNKNOWN or assumes a predicted predecessor state.
        if (evidence.possibleEgress && evidence.independentOutcome === "UNAVAILABLE") x2Fault("X2_EXPLORATION_RECONCILIATION_REQUIRED");
        break;
      }
    }
    const retained = await port.originalEvidence();
    const covered = discovery.operations.every((operation) => {
      const rows = retained.filter((item) => item.operationId === operation.id);
      const positives = rows.filter((item) => item.independentOutcome === "ESTABLISHED");
      return new Set(positives.map((item) => item.before.target.id)).size >= 2
        || !positives.length && new Set(rows.filter((item) => item.independentOutcome === "DENIED").map((item) => item.before.target.id)).size >= 2;
    });
    if (!progress || covered) break;
  }
  const original = (await port.originalEvidence()).map(parseTransitionEvidence);
  if (!original.length || original.length > 256) x2Fault("X2_ORIGINAL_OBSERVATION_BOUND");
  const fields = observedFields(discovery, original);
  const views = original.map(item => deriveApplicationTransition(item, fields));
  const operations: LearnedApplicationOperation[] = [];
  for (const description of discovery.operations) {
    const operation = inferredOperation(description, views.filter((item) => item.operationId === description.id), fields);
    if (operation) operations.push(operation);
  }
  if (!operations.length) x2Fault("X2_NO_EVIDENCED_OPERATIONS");
  const claims = operations.map((operation) => x2Ref("S4", "application-operation-claim", operation));
  for (let index = 0; index < operations.length; index++) await port.retainClaim(claims[index]!, operations[index]);
  const semantic = { scope: discovery.scope, stateSchema: fields, operations, source_observations: original.map((item) => item.ref) };
  const semanticRef = x2Ref("S4", "application-semantic-revision", semantic);
  await port.retainClaim(semanticRef, semantic);
  const envelope = buildApplicationEnvelope({
    parent: port.parent, semanticRevisionRef: semanticRef, scope: discovery.scope,
    substrate: discovery.substrate, sourceRefs: discovery.sourceRefs,
    evidenceRefs: original.map((item) => item.ref), inferredRefs: claims,
    observerRefs: operations.map((item) => item.observerContractRef),
    obligationRefs: original.flatMap((item) => item.obligationRef ? [item.obligationRef] : []),
    dependencies: [...new Map(operations.flatMap((item) => item.dependencies).map((ref) => [ref.id, ref])).values()],
  });
  const body = ApplicationActionModelBodySchema.parse({
    schema: "finnor.x2.application-action-model.v1", envelope, scope: discovery.scope,
    application_identity_and_version_evidence: discovery.sourceRefs,
    observable_state_schema: fields, operation_signatures: operations.map((item) => ({ operationId: item.id, parameters: item.parameters })),
    parameter_and_unit_constraints: discovery.typeSignatureRefs,
    precondition_predicates: operations.map((item) => ({ operationId: item.id, predicate: item.precondition })),
    effect_and_obligation_contracts: claims, postcondition_observers: operations.map((item) => item.observerContractRef),
    transition_model_and_uncertainty: claims, compositional_rules: [port.parent.grammarRef],
    permitted_exploration_record: original.map((item) => item.ref), drift_detectors: operations.flatMap((item) => item.dependencies),
    held_out_execution_evidence: [], supported_domain: envelope.supportedDomain,
    stateSchema: fields, operations, source_observations: original.map((item) => item.ref),
    declared_type_signatures: discovery.typeSignatureRefs, inferred_preconditions: claims,
    inferred_postconditions: claims, generated_interaction_code: operations.map((item) => item.privateBindingRef),
    checker_results: [], falsifier_tests: operations.flatMap((item) => item.uncertainty.falsifierRefs),
    actual_independent_outcomes: original.filter((item) => item.independentOutcome === "ESTABLISHED").map((item) => item.ref),
    validities: {
      scope: "PRINCIPAL_ACCOUNT_ROLE_GRANT_BOUND", rendering: "LAWFUL_PRIVATE_BINDING_REVALIDATION_REQUIRED",
      semantic: "FENCE_MINIMAL_SOUND_DEPENDENCY_CLOSURE", missingEvidence: "UNKNOWN",
    },
  });
  const model = parseApplicationModel({ ...body, ref: x2Ref("S4", "application-model", body) });
  await port.retainClaim(model.ref, body);
  await port.assertCurrent();
  return model;
}
