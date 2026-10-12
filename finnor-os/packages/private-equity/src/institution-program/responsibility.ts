import { createHash } from "node:crypto";
import type { DigitalInstitutionProfile } from "./contracts";
import type { InstitutionCandidate, InstitutionCheck, OriginalInstitutionEvidence } from "./checker";
import { institutionDigest as hash } from "./canonical-json";

export const X1_RESPONSIBILITY_VERSION = "institution-responsibility-v1";
const observerEntity = {
  create_deal_request: "pe_request",
  open_workstream: "pe_workstream",
  record_finding: "pe_finding",
} as const;
const originalDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const witness = (sourceId: string, recordId: string) => `${sourceId}/${recordId}`;
export type InstitutionObligationPreimage = {
  tenantId: string; institutionId: string; mandateId: string; ruleId: string;
  subjectRef: string; sourceId: string; recordId: string; occurredAt: string;
};
export function institutionObligationIdentity(preimage: InstitutionObligationPreimage): string {
  const { tenantId, institutionId, mandateId, ruleId, subjectRef, sourceId, recordId, occurredAt } = preimage;
  if ([tenantId, institutionId, mandateId, ruleId, subjectRef, sourceId, recordId, occurredAt].some((item) => !item)) {
    throw new Error("X1_OBLIGATION_IDENTITY_INCOMPLETE");
  }
  return `x1-obligation:${hash(["institution-obligation-identity-v1", tenantId, institutionId,
    mandateId, ruleId, subjectRef.replace(/@v\d+$/, ""), sourceId, recordId, occurredAt])}`;
}
export type InstitutionResponsibility = {
  schema: "finnor.x1.institution-responsibility.v1";
  obligation: {
    stableIdentity: string; derivationRevision: string;
    trigger: { witness: string; sourceId: string; recordId: string; occurredAt: string; availableAt: string };
    rule: { id: string; mandateId: string; mandateRevision: string; triggerKind: string };
    materiality: string; priority: { rank: number }; originalDeadline: string;
    responsiblePrincipal: string; permissibleOperationClass: string;
    preconditions: { ref: string; status: "satisfied" }[];
    postcondition: { contractRef: string; structuralObserver: { entityType: string; dealId: string } };
    independentObserver: { ref: string };
    effectBinding: { kind: "ordinary"; operation: string } | { kind: "none"; reason: string };
  };
  status: "LOWERED"; executionAuthorityGranted: false; protectedReceipt: null;
  qualification: "TYPED_OWNER_PROGRESSION_NOT_NUMERIC_S4_NOT_S3_CAUSAL";
};
type DutyPopulation = {
  admission: { originalDigest: string; candidateDigest: string; checkerDigest: string };
  dutyPopulationDigest: string;
};
export function verifyInstitutionDutyPopulation(
  programme: DutyPopulation, responsibilities: InstitutionResponsibility[],
  unresolved: Array<{ stableIdentity: string; reason: string; originalDeadline: string }>,
): string {
  const digest = hash(["x1-checked-duty-population-v1", programme.admission,
    responsibilities, unresolved]);
  if (programme.dutyPopulationDigest !== digest)
    throw new Error("X1_P1_CHECKED_DUTY_POPULATION_MISMATCH");
  return digest;
}
type Input = {
  original: OriginalInstitutionEvidence; candidate: InstitutionCandidate; check: InstitutionCheck;
  admittedCanonicalRefs: string[]; authorizedOperations: string[]; profile: DigitalInstitutionProfile;
};
export function deriveInstitutionResponsibilities(input: Input) {
  const { original, candidate, check, admittedCanonicalRefs, authorizedOperations, profile } = input;
  if (candidate.obligations.length > profile.bounds.derivedObligations) throw new Error("X1_DERIVED_OBLIGATION_BOUND");
  if (check.disposition !== "ACCEPTED_DEVELOPMENT" || check.inputDigest !== originalDigest(original)
      || check.candidateDigest !== originalDigest(candidate) || check.profileDigest !== originalDigest(profile)
      || check.checkerRevision !== original.current.checkerRevision
      || check.obligationDenominator !== candidate.obligations.length) {
    throw new Error("X1_CHECK_NOT_ACCEPTED_FOR_CANDIDATE");
  }
  const responsibilities: InstitutionResponsibility[] = [];
  const unresolved: { stableIdentity: string; sourceId: string; recordId: string; reason: string;
    originalDeadline: string; ruleId?: string; unsupportedFields?: string[]; ruleDigest?: string }[] = [];
  const graphNodes = new Set<string>(), graphEdges = new Set<string>();
  let deadlineAt: string | null = null;
  for (const [rank, obligation] of candidate.obligations.entries()) {
    const rule = original.mandate.rules.find((item) => item.id === obligation.ruleId);
    if (!rule || obligation.trigger !== witness(obligation.sourceId, obligation.recordId)
        || !obligation.occurredAt || !obligation.availableAt) throw new Error("X1_TRIGGER_RULE_BINDING_CHANGED");
    const row = { sourceId: obligation.sourceId, recordId: obligation.recordId,
      occurredAt: obligation.occurredAt, availableAt: obligation.availableAt };
    const identity = institutionObligationIdentity({
      tenantId: original.tenantId, institutionId: original.institutionId,
      mandateId: original.mandate.standingId??original.mandate.id, ruleId: rule.id, subjectRef: obligation.subjectRef,
      sourceId: row.sourceId, recordId: row.recordId, occurredAt: row.occurredAt,
    });
    if (deadlineAt === null || rule.deadlineAt < deadlineAt) deadlineAt = rule.deadlineAt;
    const ruleFields = new Set(["id", "triggerKind", "operation", "principalId", "deadlineAt",
      "materiality", "postconditionRef", "observerRef", "operationInputs", "actionPayload",
      "expectedEntityId", "postconditionDigest"]);
    const unsupportedFields = Object.keys(rule).filter(field => !ruleFields.has(field)).sort();
    const reason = unsupportedFields.length ? "X1_RULE_MEANING_UNSUPPORTED"
      : !admittedCanonicalRefs.includes(obligation.subjectRef)
      ? "X1_SUBJECT_NOT_ESTABLISHED_CANONICAL_FACT"
      : !authorizedOperations.includes(rule.operation) || !profile.ordinaryOperations.includes(rule.operation)
        ? "X1_OPERATION_NOT_CURRENTLY_AUTHORIZED"
        : !(rule.operation in observerEntity)
          ? "X1_OPERATION_POSTCONDITION_UNSUPPORTED"
        : !/^pe_deal:([^@]+)@v\d+$/.test(obligation.subjectRef)
          ? "X1_OPERATION_SUBJECT_KIND_UNSUPPORTED" : null;
    if (reason) {
      unresolved.push({ stableIdentity: identity, sourceId: row.sourceId, recordId: row.recordId,
        reason, originalDeadline: rule.deadlineAt,
        ...(unsupportedFields.length ? { ruleId: rule.id, unsupportedFields, ruleDigest: hash(rule) } : {}) });
      continue;
    }
    const match = /^pe_deal:([^@]+)@v\d+$/.exec(obligation.subjectRef)!;
    const trigger = { witness: obligation.trigger, sourceId: row.sourceId, recordId: row.recordId,
      occurredAt: row.occurredAt, availableAt: row.availableAt };
    const derivationRevision = hash(["institution-derivation-v1", identity, check.inputDigest,
      check.candidateDigest, check.checkerRevision, original.current]);
    responsibilities.push({
      schema: "finnor.x1.institution-responsibility.v1",
      obligation: {
        stableIdentity: identity, derivationRevision, trigger,
        rule: { id: rule.id, mandateId: original.mandate.id,
          mandateRevision: original.mandate.revision, triggerKind: rule.triggerKind },
        materiality: rule.materiality, priority: { rank }, originalDeadline: rule.deadlineAt,
        responsiblePrincipal: rule.principalId, permissibleOperationClass: rule.operation,
        preconditions: [{ ref: obligation.subjectRef, status: "satisfied" }],
        postcondition: { contractRef: rule.postconditionRef,
          structuralObserver: { entityType: observerEntity[rule.operation as keyof typeof observerEntity], dealId: match[1]! } },
        independentObserver: { ref: rule.observerRef },
        effectBinding: { kind: "ordinary", operation: rule.operation },
      },
      status: "LOWERED", executionAuthorityGranted: false, protectedReceipt: null,
      qualification: "TYPED_OWNER_PROGRESSION_NOT_NUMERIC_S4_NOT_S3_CAUSAL",
    });
    const recordNode = JSON.stringify(["original", row.sourceId, row.recordId]);
    const ruleNode = JSON.stringify(["rule", original.mandate.id, rule.id]);
    const dutyNode = JSON.stringify(["obligation", identity]);
    const subjectNode = JSON.stringify(["canonical", obligation.subjectRef]);
    for (const node of [recordNode, ruleNode, dutyNode, subjectNode]) graphNodes.add(node);
    for (const [from, to] of [[recordNode, ruleNode], [ruleNode, dutyNode], [dutyNode, subjectNode]]) {
      graphEdges.add(JSON.stringify([from, to]));
    }
  }
  if (graphNodes.size > profile.bounds.institutionDependencyNodes
      || graphEdges.size > profile.bounds.institutionDependencyEdges) throw new Error("X1_INSTITUTION_GRAPH_BOUND");
  const programmeBody = {
    schema: "finnor.x1.institution-responsibility-programme.v1" as const,
    version: X1_RESPONSIBILITY_VERSION, semanticOwner: "S4_P1" as const,
    tenantId: original.tenantId, workId: original.workId, principalId: original.principalId,
    institutionId: original.institutionId,
    parentEnvelope: { deadlineAt, wallSeconds: profile.bounds.episodeWallSeconds,
      humanSeconds: profile.bounds.episodeHumanSeconds, source: "FROZEN_PROFILE_NOT_S5_FUNDING" as const },
    admission: { originalDigest: check.inputDigest, candidateDigest: check.candidateDigest,
      checkerDigest: check.checkerRevision },
    dependencyGraph: { nodes: [...graphNodes].sort(), edges: [...graphEdges].sort() },
    status: "LOWERED" as const,
    qualification: "TYPED_OWNER_PROGRESSION_NOT_NUMERIC_S4_NOT_S3_CAUSAL" as const,
    executionAuthorityGranted: false as const, protectedReceipt: null,
  };
  const programme = { ...programmeBody,
    dutyPopulationDigest: hash(["x1-checked-duty-population-v1",
      programmeBody.admission, responsibilities, unresolved]) };
  return { programme, responsibilities, unresolved };
}
