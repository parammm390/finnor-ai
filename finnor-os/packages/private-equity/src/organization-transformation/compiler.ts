import { createHash } from "node:crypto";
import { organizationTransformationInput, OrganizationTransformationError,
  type OrganizationTransformationInput, type OrganizationTransformationProgram, type OrganizationAlternative,
  type OrganizationProcess } from "./contracts";

export function organizationCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(organizationCanonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" +
    organizationCanonical((value as Record<string, unknown>)[key])).join(",") + "}";
}
export const organizationDigest = (value: unknown) => createHash("sha256").update(organizationCanonical(value)).digest("hex");
export function parseOrganizationTransformation(value: unknown) {
  const input = organizationTransformationInput.parse(value);
  const unique = (values: string[]) => new Set(values).size === values.length;
  const { organization: org } = input;
  if (!unique(org.roles.map(r => r.id)) || !unique(org.processes.map(p => p.id)) ||
      !unique(org.obligations.map(o => o.id)) || new Set(org.roles.map(r => r.teamId)).size > 4 ||
      !unique((org.resourceConstraints ?? []).map(r => r.id)) ||
      org.roles.some(r => r.committedSeconds > r.availableSeconds) ||
      input.mandate.evaluatorPrincipalId === input.principalId ||
      Date.parse(input.mandate.originalDeadline) <= Date.parse(input.mandate.validFrom))
    throw new OrganizationTransformationError("W5_ORIGINAL_PROFILE_OR_INDEPENDENCE_REQUIRED", 422);
  for (const process of org.processes) {
    const keys = new Set(process.nodes.map(n => n.id));
    if (keys.size !== process.nodes.length || process.teamIds.some(t => !org.roles.some(r => r.teamId === t)) ||
        process.nodes.some(n => !org.roles.some(r => r.id === n.roleId && r.capabilities.includes(n.operation)) ||
          n.after.some(p => p === n.id || !keys.has(p))) || !acyclic(process))
      throw new OrganizationTransformationError("W5_ORIGINAL_PROCESS_GRAPH_INVALID", 422);
  }
  if (input.mandate.requiredServiceIds.some(id => !org.processes.some(p => p.serviceId === id)) ||
      org.observations.some(o => o.incompleteEvidenceCount > o.samples ||
        !org.processes.some(p => p.id === o.processId && p.nodes.some(n => n.id === o.nodeId))) ||
      org.obligations.some(o => !org.roles.some(r => r.id === o.accountableRoleId) ||
        !org.processes.some(p => p.id === o.processId && p.nodes.some(n => n.id === o.nodeId)) ||
        o.currency !== null && o.currency !== input.mandate.currency ||
        o.currency === null && (o.consumedMinor !== null || o.unresolvedMinor !== null)))
    throw new OrganizationTransformationError("W5_ORIGINAL_SERVICE_OBLIGATION_OR_MEASUREMENT_INVALID", 422);
  return input;
}
export function acyclic(process: OrganizationProcess) {
  const pending = new Map(process.nodes.map(n => [n.id, n.after]));
  const done = new Set<string>();
  while (pending.size) {
    const ready = [...pending].filter(([, after]) => after.every(id => done.has(id)));
    if (!ready.length) return false;
    for (const [id] of ready) { done.add(id); pending.delete(id); }
  }
  return true;
}
function retained(input: OrganizationTransformationInput): OrganizationAlternative {
  return { id: "retain", kind: "RETAIN", roles: structuredClone(input.organization.roles),
    processes: structuredClone(input.organization.processes), diagnoses: [], constructedAssets: [],
    migrationHumanSeconds: 0, addedOperationHumanSeconds: 0, migrationCostMinor: 0,
    predictedImprovementSeconds: 0, predictionBasis: "NO_CHANGE", unresolved: [] };
}
function construct(input: OrganizationTransformationInput, kind: "PREPARED_HANDOFF" | "COORDINATION_INTERFACE") {
  const alt = retained(input); alt.kind = kind; alt.id = "";
  const capability = kind === "PREPARED_HANDOFF" ? "prepare_evidence" : "coordinate";
  const capable = input.organization.roles.filter(r => r.capabilities.includes(capability) &&
    r.availableSeconds > r.committedSeconds).sort((a, b) => (a.kind === "DIGITAL" ? -1 : 0) -
      (b.kind === "DIGITAL" ? -1 : 0) || a.id.localeCompare(b.id));
  if (!capable.length) return null;
  const remainingSeconds = new Map(capable.map(role => [role.id, role.availableSeconds - role.committedSeconds]));
  for (const obs of input.organization.observations) {
    if (obs.externalWaitSeconds >= obs.queueSeconds + obs.repeatedInterpretationSeconds) {
      alt.diagnoses.push({ processId: obs.processId, nodeId: obs.nodeId, cause: "EXTERNAL_LIMIT",
        evidenceRefs: obs.evidenceRefs, claim: "OBSERVED_ASSOCIATION_NOT_CAUSAL_IDENTIFICATION" });
      continue;
    }
    const process = alt.processes.find(p => p.id === obs.processId)!;
    const node = process.nodes.find(n => n.id === obs.nodeId)!;
    const relevant = kind === "PREPARED_HANDOFF"
      ? obs.incompleteEvidenceCount > 0 && node.requiredEvidence.length > 0
      : obs.repeatedInterpretationSeconds > 0 && process.teamIds.length > 1;
    if (!relevant) continue;
    const samples = Math.max(1, ...input.organization.observations.filter(o => o.processId === process.id).map(o => o.samples));
    const operatingSeconds = 30 * samples;
    const role = capable.find(r => operatingSeconds <= remainingSeconds.get(r.id)!
      && (r.kind === "DIGITAL" || alt.addedOperationHumanSeconds + operatingSeconds <= input.mandate.maxAddedOperationHumanSeconds));
    if (!role) { alt.unresolved.push("NO_LAWFUL_CAPACITY:" + process.id); continue; }
    const id = "w5_" + organizationDigest([kind, process.id, node.id]).slice(0, 24);
    if (process.nodes.some(n => n.id === id) || process.nodes.length >= 64) continue;
    const gate = { id, kind: kind === "PREPARED_HANDOFF" ? "EVIDENCE_GATE" as const : "COORDINATE" as const,
      roleId: role.id, operation: capability, after: [...node.after], requiredEvidence: [...node.requiredEvidence],
      mandatory: false, effortSeconds: 30 };
    process.nodes.push(gate); node.after = [id];
    alt.constructedAssets.push({ id: "asset_" + id, kind: kind === "PREPARED_HANDOFF" ? "EVIDENCE_CONTRACT" : "COORDINATION_CONTRACT",
      processId: process.id, nodeId: id, inputFields: [...node.requiredEvidence],
      outputFields: [...node.requiredEvidence, "prepared_for:" + node.id], grantsAuthority: false });
    alt.diagnoses.push({ processId: process.id, nodeId: node.id,
      cause: kind === "PREPARED_HANDOFF" ? "INCOMPLETE_EVIDENCE" : "REPEATED_COORDINATION",
      evidenceRefs: obs.evidenceRefs, claim: "OBSERVED_ASSOCIATION_NOT_CAUSAL_IDENTIFICATION" });
    alt.migrationHumanSeconds += 60;
    remainingSeconds.set(role.id, remainingSeconds.get(role.id)! - operatingSeconds);
    alt.addedOperationHumanSeconds += role.kind === "DIGITAL" ? 0 : operatingSeconds;
  }
  if (!alt.constructedAssets.length) return null;
  alt.migrationCostMinor = null;
  alt.predictedImprovementSeconds = null;
  alt.predictionBasis = "UNQUALIFIED_QUEUE_HYPOTHESIS";
  alt.unresolved.push("ACTUAL_ADOPTION_AND_CAUSAL_BENEFIT_NOT_OBSERVED", "MIGRATION_MONEY_REQUIRES_S7_OBSERVATION");
  alt.id = kind.toLowerCase() + ":" + organizationDigest(alt.processes).slice(0, 24);
  return alt;
}
export function constructOrganizationTransformation(value: unknown): OrganizationTransformationProgram {
  const input = parseOrganizationTransformation(value);
  const alternatives = [retained(input)];
  for (const kind of ["PREPARED_HANDOFF", "COORDINATION_INTERFACE"] as const) {
    const alt = construct(input, kind);
    if (alt && alt.migrationHumanSeconds <= input.mandate.maxMigrationHumanSeconds &&
        alt.addedOperationHumanSeconds <= input.mandate.maxAddedOperationHumanSeconds) alternatives.push(alt);
  }
  const bounded = alternatives.slice(0, input.mandate.maxAlternatives);
  return { schema: "finnor.organization-transformation-program.v1", requirements: "FINNOR-POSTZ-W-PRD-1.0.0",
    originalDigest: organizationDigest(input), tenantId: input.tenantId, principalId: input.principalId,
    companyId: input.companyId, workId: input.workId, workInputId: input.workInputId,
    originalOrganizationRef: input.organization.ref, mandateRef: input.mandate.ref,
    originalDeadline: input.mandate.originalDeadline, sourceRefs: input.organization.sourceRefs,
    originalObligations: structuredClone(input.organization.obligations), alternatives: bounded,
    originalResourceConstraints: structuredClone(input.organization.resourceConstraints ?? []),
    recommendedAlternativeId: bounded.find(a => a.kind === "PREPARED_HANDOFF")?.id ??
      bounded.find(a => a.kind !== "RETAIN")?.id ?? "retain", selectedAlternativeId: null,
    status: "CANDIDATE", revision: 1, adoptions: [], events: [],
    exclusions: ["EMPLOYMENT_CHANGES", "NEW_AUTHORITY", "PROTECTED_ADMISSION", "UNOBSERVED_FIELD_BENEFIT",
      "ARBITRARY_HUMAN_ORGANIZATION_PROOF", "CASH_CREDIT_FOR_SAVED_SALARIED_TIME"],
    unresolved: ["S4_SELECTION", "S5_CURRENT_JOINT_FEASIBILITY", "PARTICIPANT_ADOPTION", "LIVE_TRANSITION", "S2_S3_S7_EVALUATION"],
    claims: { actualAdoption: false, observedOperation: false, fieldBenefit: false, protectedAdmission: false, newAuthorityGranted: false } };
}
