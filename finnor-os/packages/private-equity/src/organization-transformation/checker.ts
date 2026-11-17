import { organizationDigest, parseOrganizationTransformation, acyclic } from "./compiler";
import type { OrganizationTransformationProgram, OrganizationAlternative, OrganizationTransformationInput } from "./contracts";

function ancestor(process: OrganizationAlternative["processes"][number], before: string, after: string) {
  const done = new Set<string>(), pending = [after];
  while (pending.length) {
    const id = pending.pop()!;
    if (done.has(id)) continue;
    done.add(id);
    const node = process.nodes.find(n => n.id === id);
    if (node?.after.includes(before)) return true;
    pending.push(...node?.after ?? []);
  }
  return false;
}
function alternativeErrors(input: OrganizationTransformationInput, alt: OrganizationAlternative) {
  const errors: string[] = [], original = input.organization;
  if (organizationDigest(alt.roles) !== organizationDigest(original.roles)) errors.push("EMPLOYEE_CAPACITY_AUTHORITY_OR_PROTECTION_CHANGED");
  if (alt.processes.length !== original.processes.length || new Set(alt.processes.map(p => p.id)).size !== alt.processes.length)
    errors.push("ORIGINAL_PROCESS_POPULATION_CHANGED");
  for (const prior of original.processes) {
    const current = alt.processes.find(p => p.id === prior.id);
    if (!current || current.serviceId !== prior.serviceId || current.family !== prior.family ||
        organizationDigest(current.teamIds) !== organizationDigest(prior.teamIds)) { errors.push("ORIGINAL_SERVICE_CHANGED"); continue; }
    if (!acyclic(current) || new Set(current.nodes.map(n => n.id)).size !== current.nodes.length ||
        current.nodes.some(n => n.after.some(id => !current.nodes.some(other => other.id === id))))
      errors.push("PROCESS_GRAPH_INVALID");
    for (const node of prior.nodes) {
      const next = current.nodes.find(n => n.id === node.id);
      if (!next) { errors.push(node.mandatory ? "MANDATORY_CONTROL_REMOVED" : "ORIGINAL_OPERATION_LOST"); continue; }
      const { after: _a, ...old } = node, { after: _b, ...now } = next;
      if (organizationDigest(old) !== organizationDigest(now)) errors.push("ORIGINAL_OPERATION_OR_CONTROL_CHANGED");
      if (node.after.some(id => !ancestor(current, id, node.id))) errors.push("ORIGINAL_CONTROL_ORDER_WEAKENED");
    }
    for (const node of current.nodes.filter(n => !prior.nodes.some(old => old.id === n.id))) {
      const role = alt.roles.find(r => r.id === node.roleId);
      const asset = alt.constructedAssets.find(a => a.processId === current.id && a.nodeId === node.id);
      if (!role?.capabilities.includes(node.operation) || !["EVIDENCE_GATE", "COORDINATE"].includes(node.kind) ||
          node.mandatory || !asset || asset.grantsAuthority !== false ||
          organizationDigest(asset.inputFields) !== organizationDigest(node.requiredEvidence))
        errors.push("UNSUPPORTED_CONSTRUCTED_OPERATION");
    }
  }
  const addedHuman = alt.processes.flatMap(p => p.nodes.filter(n =>
    !original.processes.find(old => old.id === p.id)?.nodes.some(old => old.id === n.id))
    .map(n => ({ process: p.id, node: n }))).reduce((sum, { process, node }) => {
      const role = alt.roles.find(r => r.id === node.roleId);
      const samples = Math.max(1, ...original.observations.filter(o => o.processId === process).map(o => o.samples));
      return sum + (role?.kind === "DIGITAL" ? 0 : node.effortSeconds * samples);
    }, 0);
  if (addedHuman !== alt.addedOperationHumanSeconds || addedHuman > input.mandate.maxAddedOperationHumanSeconds ||
      alt.migrationHumanSeconds < alt.constructedAssets.length * 60 ||
      alt.migrationHumanSeconds > input.mandate.maxMigrationHumanSeconds ||
      alt.migrationCostMinor !== null && (alt.migrationCostMinor < 0 || alt.migrationCostMinor > input.mandate.maxMigrationCostMinor))
    errors.push("CROSS_TEAM_HUMAN_OR_MIGRATION_BUDGET_EXCEEDED");
  if (alt.kind !== "RETAIN" && (!alt.constructedAssets.length ||
      organizationDigest(alt.processes) === organizationDigest(original.processes))) errors.push("NONTRIVIAL_TRANSFORMATION_REQUIRED");
  if (alt.kind === "RETAIN" && (organizationDigest(alt.processes) !== organizationDigest(original.processes) ||
      alt.constructedAssets.length || alt.migrationHumanSeconds || alt.addedOperationHumanSeconds)) errors.push("NO_CHANGE_ALTERNATIVE_CHANGED");
  return errors;
}
export function checkOrganizationTransformation(value: unknown, program: OrganizationTransformationProgram) {
  const errors: string[] = [];
  try {
    const input = parseOrganizationTransformation(value);
    if (program.schema !== "finnor.organization-transformation-program.v1" ||
        program.requirements !== "FINNOR-POSTZ-W-PRD-1.0.0" ||
        program.originalDigest !== organizationDigest(input) || program.tenantId !== input.tenantId ||
        program.principalId !== input.principalId || program.workId !== input.workId || program.workInputId !== input.workInputId ||
        program.companyId !== input.companyId || program.originalDeadline !== input.mandate.originalDeadline ||
        organizationDigest(program.mandateRef) !== organizationDigest(input.mandate.ref) ||
        organizationDigest(program.originalOrganizationRef) !== organizationDigest(input.organization.ref) ||
        organizationDigest(program.sourceRefs) !== organizationDigest(input.organization.sourceRefs) ||
        organizationDigest(program.originalObligations) !== organizationDigest(input.organization.obligations) ||
        organizationDigest(program.originalResourceConstraints) !== organizationDigest(input.organization.resourceConstraints ?? []))
      errors.push("ORIGINAL_BINDING_OR_OBLIGATION_CHANGED");
    if (!program.alternatives.some(a => a.id === "retain" && a.kind === "RETAIN") ||
        program.alternatives.length > input.mandate.maxAlternatives ||
        new Set(program.alternatives.map(a => a.id)).size !== program.alternatives.length ||
        !program.alternatives.some(a => a.id === program.recommendedAlternativeId))
      errors.push("ALTERNATIVE_POPULATION_INVALID");
    for (const alternative of program.alternatives) errors.push(...alternativeErrors(input, alternative));
    if (program.claims.newAuthorityGranted || program.claims.fieldBenefit || program.claims.protectedAdmission)
      errors.push("UNSUPPORTED_AUTHORITY_OR_QUALIFICATION_CLAIM");
  } catch { errors.push("MALFORMED_OR_UNSUPPORTED_TRANSFORMATION"); }
  return { schema: "finnor.organization-transformation-check.v1" as const,
    status: errors.length ? "REJECTED" as const : "CHECKED" as const, errors: [...new Set(errors)],
    programDigest: organizationDigest(program), owner: "W5_INVARIANT_CHECKER_NOT_S8_ADMISSION" as const };
}
