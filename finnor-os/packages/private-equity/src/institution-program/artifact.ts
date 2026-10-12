import { InstitutionProgram, type Binding, type InstitutionProgram as Program } from "./contracts";
import type { InstitutionCandidate, InstitutionCheck, OriginalInstitutionEvidence } from "./checker";
import type { AcceptedInstitutionMappingRef } from "./owner-admission";
import type { deriveInstitutionResponsibilities } from "./responsibility";
import { institutionDigest as hash } from "./canonical-json";

type Lowered = ReturnType<typeof deriveInstitutionResponsibilities>;
type OwnerRef = { owner: string; id: string; version: string; contentDigest: string };

/** A complete immutable projection. Every known binding has an actual owner
 * input/receipt. A requested contract or unavailable receipt stays unknown. */
export function buildInstitutionArtifact(input: {
  id: string; revision: string; workInput: {id:string;digest:string}; original: OriginalInstitutionEvidence; candidate: InstitutionCandidate;
  check: InstitutionCheck; mappings: AcceptedInstitutionMappingRef[]; lowered: Lowered | null;
  admissionId: string | null; programme: { id: string; revision: string; digest: string } | null;
  reservation: OwnerRef | null; producer: { digest: string; files: unknown[]; node: string };
  lockDigest: string; baseline: { ref: string; digest: string } | null;
  parents: Binding[]; costRefs: Binding[];
  operationGaps?: Array<{ stableIdentity: string; reason: string; originalDeadline: string }>;
  incrementalGraph?: unknown; updatePlan?: unknown;
}): Program {
  const o = input.original;
  const unknown = (reason: string, owner: string, refs: string[] = []): Binding => ({
    status: "unknown", reason, affectedRefs: refs, requiredOwnerOrInput: owner,
  });
  const known = (owner: Extract<Binding, { status: "known" }>["owner"], kind: string,
    ref: string, revision: string, digest: string): Binding => ({
    status: "known", owner, kind, ref, revision, digest, tenantRef: o.tenantId,
    institutionRef: o.institutionId, rightsRevision: o.current.rightsRevision, knowledgeCut: o.knowledgeCut,
  });
  const source = (id: string) => {
    const s = o.sources.find(item => item.id === id);
    return s ? known("source", "authorized_original", s.id, s.revision,
      o.current.sourceDigests?.[s.id] ?? hash(s)) : unknown("Original source not retained", "source", [id]);
  };
  const check = input.check.disposition === "ACCEPTED_DEVELOPMENT"
    ? known("runtime", "separate_original_evidence_check", `x1-check:${input.id}`,
      input.check.checkerRevision, hash(input.check))
    : unknown("Independent checker rejected this candidate", "independent checker", [input.id]);
  const mandate = known("Work", "standing_mandate", o.mandate.id, o.mandate.revision, hash(o.mandate));
  const unresolved = [
    ...(input.candidate.unresolved ?? []).map(item => ({ basis: "unresolved" as const,
      statement: `Interpretation of ${item.witness}`, witnessRefs: [item.witness],
      domainRef: "pe-institution-responsibility-v1", knowledgeCut: o.knowledgeCut,
      reason: item.reason, requiredOwnerOrInput: "mandate owner or source owner",
      affectedRefs: item.alternatives })),
    ...(input.lowered?.unresolved ?? []).map(item => ({ basis: "unresolved" as const,
      statement: `Responsibility ${item.stableIdentity}`, witnessRefs: [item.stableIdentity],
      domainRef: "pe-institution-responsibility-v1", knowledgeCut: o.knowledgeCut,
      reason: item.reason, requiredOwnerOrInput: "current operation or canonical owner",
      affectedRefs: [item.stableIdentity],
      ...(item.unsupportedFields ? { alternatives: item.unsupportedFields.map(field =>
        `Interpret ${field} in standing rule ${item.ruleId}`) } : {}) })),
    ...(input.operationGaps ?? []).map(item => ({ basis: "unresolved" as const,
      statement: `Operation intent for ${item.stableIdentity}`, witnessRefs: [item.stableIdentity],
      domainRef: "pe-institution-responsibility-v1", knowledgeCut: o.knowledgeCut,
      reason: item.reason, requiredOwnerOrInput: "standing mandate owner or source owner",
      affectedRefs: [item.stableIdentity] })),
  ];
  const rules = (input.lowered?.responsibilities ?? []).map(r => {
    const duty = r.obligation;
    return {
      stableIdentity: duty.stableIdentity, derivationRevision: duty.derivationRevision,
      triggerOccurrence: duty.trigger.occurredAt, triggeringEvidence: [source(duty.trigger.sourceId)],
      normativeRule: known("Work", "supplied_responsibility_rule", `${o.mandate.id}/${duty.rule.id}`,
        o.mandate.revision, hash(o.mandate.rules.find(rule => rule.id === duty.rule.id))),
      condition: duty.rule.triggerKind, materiality: duty.materiality, priority: String(duty.priority.rank),
      originalDeadline: duty.originalDeadline,
      responsiblePrincipal: known("Work", "mandated_principal", duty.responsiblePrincipal,
        o.current.rightsRevision, hash([o.mandate.id, duty.rule.id, duty.responsiblePrincipal])),
      permissibleOperationClass: duty.permissibleOperationClass,
      preconditions: duty.preconditions.map(p => known("S1", "canonical_identity_precondition", p.ref,
        o.canonical.revision, hash(o.canonical.entities.find(entity => entity.ref === p.ref)))),
      postcondition: unknown("Completion contract requires the native action and canonical observer",
        "S6/native effect owner", [duty.postcondition.contractRef]),
      independentObserver: unknown("Canonical observation has not yet been made",
        "independent canonical owner reader", [duty.independentObserver.ref]),
      effectBinding: { kind: "ordinary" as const,
        effect: unknown("Action intent is not a verified effect", "native DomainAction/BusinessEffect", [duty.stableIdentity]) },
    };
  });
  const mappingRefs = input.mappings.map(m => known("S1", m.assertionKind==='QUANTITY'
    ?"checked_quantity_source_assertion":"checked_source_assertion_attachment",
    m.evidenceLinkId, m.originalDocumentVersionId, hash(m)));
  const canonicalRefs = input.mappings.flatMap(m => [
    known("S1", "canonical_identity", m.canonicalRef, o.canonical.revision,
      hash(o.canonical.entities.find(entity => entity.ref === m.canonicalRef))),
    ...(m.relationId ? [known("S1", "canonical_relationship", m.relationId,
      o.canonical.revision, hash(m))] : []),
  ]);
  const temporal = input.candidate.quantities.map(q => ({
    identity: known("S1", "checked_quantity_subject", q.canonicalRef, o.canonical.revision,
      hash(o.canonical.entities.find(e => e.ref === q.canonicalRef))),
    quantity: { decimal: q.value, currency: q.currency, unit: q.unit,
      canonicalEntity: known("S1", "checked_quantity_subject", q.canonicalRef, o.canonical.revision,
        hash(o.canonical.entities.find(e => e.ref === q.canonicalRef))),
      period: q.period, accountingBasis: q.basis, sourceWitness: source(q.sourceId),
      occurrenceAt: q.occurredAt, availableAt: q.availableAt, knowledgeCut: o.knowledgeCut },
    occurrenceAt: q.occurredAt, availableAt: q.availableAt, knowledgeCut: o.knowledgeCut,
    disposition: input.candidate.contradictions.some(c =>
      c.leftRef.sourceId === q.sourceId && c.leftRef.recordId === q.recordId
      || c.rightRef.sourceId === q.sourceId && c.rightRef.recordId === q.recordId)
      ? "contradicted" as const : "supported" as const,
    counterevidenceRefs: input.candidate.contradictions.filter(c =>
      c.leftRef.sourceId === q.sourceId && c.leftRef.recordId === q.recordId
      || c.rightRef.sourceId === q.sourceId && c.rightRef.recordId === q.recordId).flatMap(c => [c.left, c.right]),
  }));
  const body = {
    mandate_ref: mandate, inferred_source_mapping_refs: mappingRefs,
    canonical_entity_and_relation_refs: canonicalRefs, temporal_and_unit_constraints: temporal,
    obligation_derivation_rules: rules, materiality_and_priority_contract: mandate,
    unresolved_interpretations: unresolved,
    evidence_dependency_graph: input.lowered ? known("S4_P1", "typed_institution_dependency_graph",
      `x1-dependencies:${input.id}`, input.revision, hash(input.incrementalGraph ?? input.lowered.programme.dependencyGraph))
      : unknown("No checked responsibility graph", "S4/P1"),
    incremental_update_rules: known("P7", "source_rule_subject_dependency_contract", input.id,
      input.revision, hash(input.updatePlan ?? input.candidate.dependencies)),
    s4_programme_ref: input.programme ? known("S4_P1", "native_institution_programme_request",
      input.programme.id, input.programme.revision, input.programme.digest)
      : unknown("No native programme submitted", "S4/P1", [input.id]),
    s6_obligation_refs: [],
    validity_and_invalidation_contract: known("P7", "owner_currentness_vector", input.id,
      input.revision, hash(o.current)),
    independently_checked_model_revision: check,
  };
  const semanticDigest = hash(body);
  const envelope = {
    artifact_id: input.id, kind: "InstitutionProgram", schema_revision: "finnor.institution-program.v1",
    tenant_ref: known("Work", "authenticated_tenant", o.tenantId, o.current.rightsRevision, hash(o.tenantId)),
    work_ref: known("Work", "exact_work_revision", o.workId, input.workInput.id, input.workInput.digest),
    institutional_program_ref: known("S4_P1", "immutable_institution_projection", input.id, input.revision, semanticDigest),
    parent_artifact_refs: input.parents,
    producer_revision: known("runtime", "loaded_code_identity", "InstitutionalProgrammeCompiler", input.producer.digest, input.producer.digest),
    baseline_manifest_ref: input.baseline ? known("runtime", "frozen_baseline_manifest", input.baseline.ref,
      input.baseline.digest, input.baseline.digest) : unknown("Baseline receipt not supplied to this installed episode", "baseline integrator"),
    authority_grant_ref: unknown("Current operation grant references require native dispatch revalidation",
      "authority owner", o.current.authorizedOperations),
    rights_revision: known("Work", "current_authority_revision", `authority:${o.tenantId}`,
      o.current.rightsRevision, hash(o.current.rightsRevision)),
    resource_grant_ref: input.reservation ? known("S5", "original_parent_reservation", input.reservation.id,
      input.reservation.version, input.reservation.contentDigest) : unknown("Original resource reservation unavailable", "S5"),
    source_refs: o.sources.map(s => source(s.id)), source_revision_vector: o.current.sourceRevisions,
    knowledge_cut: o.knowledgeCut,
    admitted_domain_ref: o.current.methodCapability?known('S8','DISPOSABLE_METHOD_ADMISSION_NOT_PROTECTED_DOMAIN_QUALIFICATION',
      o.current.methodCapability.admissionRef.id,o.current.methodCapability.admissionRef.version,
      o.current.methodCapability.admissionRef.contentDigest)
      :unknown("Development profile has no protected domain qualification/admission", "S8 admission owner", ["pe-institution-responsibility-v1"]),
    application_fingerprints: [known("runtime", "actual_loaded_application", "FINNOR", input.producer.digest, input.producer.digest)],
    model_refs: [],
    dependency_lock_digest: known("runtime", "installed_dependency_lock", "finnor-os/package-lock.json", input.lockDigest, input.lockDigest),
    runtime_digest: known("runtime", "actual_node_runtime", input.producer.node,
      o.current.runtimeRevision, hash(o.current.runtimeRevision)),
    observed_claims: o.sources.map(s => ({ basis: "observed" as const,
      statement: `Authorized original ${s.id} retained; its assertions are not settled business truth`,
      witnessRefs: s.coverage.readObjectIds.map(id => JSON.stringify([s.id, id])),
      domainRef: "pe-institution-responsibility-v1", knowledgeCut: o.knowledgeCut, sourceRef: s.id })),
    inferred_claims: input.candidate.mappings.map(m => ({ basis: "inferred" as const,
      statement: `Original ${JSON.stringify([m.sourceId, m.recordId])} maps to ${m.canonicalRef}`,
      witnessRefs: [JSON.stringify([m.sourceId, m.recordId])], domainRef: "pe-institution-responsibility-v1",
      knowledgeCut: o.knowledgeCut, alternatives: [m.canonicalRef], checkRef: check })),
    predicted_claims: [], unresolved_claims: unresolved,
    postcondition_contract_refs: rules.map(r => r.postcondition), independent_check_refs: [check],
    S6_obligation_refs: [], provider_observation_refs: [],
    invalidation_dependencies: [mandate, ...o.sources.map(s => source(s.id))],
    lifecycle_state: input.check.disposition === "ACCEPTED_DEVELOPMENT" ? "CHECKED_DEVELOPMENT" as const : "UNKNOWN" as const,
    lifecycle_events: [{ at: o.knowledgeCut, state: input.check.disposition, basis: check }],
    build_learning_compute_cost_refs: [...input.costRefs,
      unknown("Build/setup, monetary pricing, storage/network and complete validator attribution remain unobserved",
        "S5/S7 metering owner", [input.id])],
    attributable_human_work_refs: [unknown("Human supervision/clarification has no complete observed attribution receipt", "human work metering owner", [input.id])],
  };
  // The self binding addresses the semantic body, avoiding recursive digests.
  return InstitutionProgram.parse({ ...body, envelope: { ...envelope, content_digest: hash({ body, envelope }) } });
}
