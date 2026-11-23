import { organizationDigest } from "./compiler";
import { OrganizationTransformationError, liveOrganizationObligation, organizationResourceConstraint,
  type OrganizationTransformationInput, type OrganizationTransformationProgram, type TransformationDecision,
  type LiveOrganizationObligation, type OrganizationResourceConstraint, type OrganizationResourceOwner } from "./contracts";

export function applyTransformationDecision(previous: OrganizationTransformationProgram, decision: TransformationDecision) {
  const program = structuredClone(previous);
  const fail = (code: string): never => { throw new OrganizationTransformationError(code); };
  if (!Number.isFinite(Date.parse(decision.at)) || Date.parse(decision.at) >= Date.parse(program.originalDeadline))
    fail("W5_ORIGINAL_DEADLINE_EXPIRED");
  if (program.status === "CANCELLED") fail("W5_CANCELLED_RECONCILIATION_ONLY");
  if (decision.kind === "SELECT") {
    if (decision.principalId !== program.principalId || program.selectedAlternativeId ||
        !program.alternatives.some(a => a.id === decision.alternativeId)) fail("W5_SELECTION_NOT_CURRENT");
    program.selectedAlternativeId = decision.alternativeId;
    program.status = decision.alternativeId === "retain" ? "RETAINED" : "AWAITING_ADOPTION";
  } else if (decision.kind === "CANCEL") {
    if (decision.principalId !== program.principalId) fail("W5_CANCEL_AUTHORITY_REQUIRED");
    program.status = "CANCELLED";
  } else {
    const alternative = program.alternatives.find(a => a.id === program.selectedAlternativeId);
    const role = alternative?.roles.find(r => r.id === decision.roleId);
    if (!alternative || alternative.id !== decision.alternativeId || !role ||
        role.principalId !== decision.principalId || alternative.kind === "RETAIN") fail("W5_SELF_ADOPTION_IDENTITY_REQUIRED");
    const termsDigest = organizationDigest({ alternativeId: alternative!.id, role: role! });
    if (decision.kind === "ADOPT" && decision.termsDigest !== termsDigest) fail("W5_EXACT_ADOPTION_TERMS_REQUIRED");
    const existing = program.adoptions.find(a => a.roleId === decision.roleId);
    const adoption = { roleId: decision.roleId, principalId: decision.principalId, termsDigest,
      state: decision.kind === "ADOPT" ? "ADOPTED" as const : decision.kind === "DECLINE" ? "DECLINED" as const : "REVOKED" as const,
      at: decision.at, observationRef: decision.kind === "ADOPT" ? decision.observationRef ?? null : null };
    if (existing) Object.assign(existing, adoption); else program.adoptions.push(adoption);
    program.status = program.adoptions.some(a => a.state !== "ADOPTED") ? "PARTIAL" :
      alternative!.roles.every(r => program.adoptions.some(a => a.roleId === r.id && a.state === "ADOPTED")) ? "ADOPTED" : "AWAITING_ADOPTION";
    program.claims.actualAdoption = "AUTHENTICATED_DECISIONS_ONLY";
  }
  program.revision++;
  program.events.push({ revision: program.revision, kind: decision.kind, principalId: decision.principalId,
    at: decision.at, body: { ...decision, originalObligationsRetained: true, newAuthorityGranted: false } });
  return program;
}
export function organizationConstraintIdentity(value: OrganizationResourceConstraint) {
  return { id: value.id, reservationRef: value.reservationRef, certificateRef: value.certificateRef,
    problemRef: value.problemRef, nativeProblemDigest: value.nativeProblemDigest,
    originalDeadline: value.originalDeadline, canonicalRoots: value.canonicalRoots,
    originalResourceEnvelope: value.originalResourceEnvelope, monetaryExposure: value.monetaryExposure, retention: value.retention };
}
function nativeOwnerIdentity(value: OrganizationResourceOwner) {
  return { owner: value.owner, id: value.id, parentId: value.parentId, workId: value.workId, workInputId: value.workInputId,
    workInputDigest: value.workInputDigest, requestDigest: value.requestDigest, originalTermsDigest: value.originalTermsDigest,
    originalDeadline: value.originalDeadline, originalLimits: value.originalLimits,
    physicalAttemptCoverage: value.physicalAttemptCoverage, counterAccounting: value.counterAccounting };
}
function nativeOwnerRetained(original: OrganizationResourceOwner, current: OrganizationResourceOwner) {
  const attemptIdentity = (a: OrganizationResourceOwner["physicalAttempts"][number]) =>
    ({ id: a.id, unitId: a.unitId, deliveryId: a.deliveryId, claimFence: a.claimFence });
  return organizationDigest(nativeOwnerIdentity(original)) === organizationDigest(nativeOwnerIdentity(current)) &&
    (original.generation === null ? current.generation === null : current.generation !== null && current.generation >= original.generation) &&
    Object.entries(original.observedCounters).every(([key, value]) =>
      current.observedCounters[key] !== undefined && current.observedCounters[key]! >= value) &&
    original.physicalAttempts.every(before => current.physicalAttempts.some(now =>
      organizationDigest(attemptIdentity(now)) === organizationDigest(attemptIdentity(before))));
}
export function organizationConstraintRetained(original: OrganizationResourceConstraint, current: OrganizationResourceConstraint) {
  return organizationDigest(organizationConstraintIdentity(original)) === organizationDigest(organizationConstraintIdentity(current)) &&
    original.originalWorks.every(before => current.originalWorks.some(now => organizationDigest(before) === organizationDigest(now))) &&
    (original.nativeOwners ?? []).every(before => (current.nativeOwners ?? []).some(now =>
      now.owner === before.owner && now.id === before.id && nativeOwnerRetained(before, now))) &&
    current.reservationRevision >= original.reservationRevision && original.consumptions.every(before =>
      current.consumptions.some(now => organizationDigest(now.ref) === organizationDigest(before.ref) &&
        (before.effectRef === null || organizationDigest(now.effectRef) === organizationDigest(before.effectRef))));
}
export function planObligationBridge(input: OrganizationTransformationInput, program: OrganizationTransformationProgram,
  current: LiveOrganizationObligation[], direction: "FORWARD" | "ROLLBACK",
  currentResourceConstraints: OrganizationResourceConstraint[] = input.organization.resourceConstraints ?? []) {
  const errors: string[] = [];
  const live = current.map(o => liveOrganizationObligation.parse(o));
  const resourceConstraints = currentResourceConstraints.map(value => organizationResourceConstraint.parse(value));
  if (resourceConstraints.length > 1024 || new Set(resourceConstraints.map(r => r.id)).size !== resourceConstraints.length)
    errors.push("COMPLETE_UNIQUE_NATIVE_RESOURCE_CONSTRAINT_POPULATION_REQUIRED");
  for (const original of input.organization.resourceConstraints ?? []) {
    const retained = resourceConstraints.find(r => r.id === original.id);
    if (!retained || !organizationConstraintRetained(original, retained))
      errors.push("ORIGINAL_NATIVE_RESOURCE_CONSTRAINT_NOT_RETAINED:" + original.id);
  }
  const selected = program.alternatives.find(a => a.id === program.selectedAlternativeId);
  if (!selected || selected.kind === "RETAIN" || direction === "FORWARD" && !["ADOPTED", "TRIAL", "ACTIVE"].includes(program.status))
    errors.push("EXACT_CURRENT_ADOPTION_REQUIRED");
  if (new Set(live.map(o => o.id)).size !== live.length || live.length > 1024) errors.push("COMPLETE_LIVE_OBLIGATION_POPULATION_REQUIRED");
  for (const original of input.organization.obligations) {
    const obligation = live.find(o => o.id === original.id);
    const identity = (o: LiveOrganizationObligation) => ({ id: o.id, workId: o.workId, meaningDigest: o.meaningDigest,
      termsDigest: o.termsDigest, deadline: o.deadline, reservationRef: o.reservationRef, currency: o.currency,
      accountableRoleId: o.accountableRoleId, processId: o.processId, nodeId: o.nodeId, dependencyRefs: o.dependencyRefs,
      canonical: o.canonical ?? null });
    const exposureRetained = (now: number | null, before: number | null) =>
      before === null ? now === null : now !== null && now >= before;
    if (!obligation || organizationDigest(identity(obligation)) !== organizationDigest(identity(original)) ||
        !exposureRetained(obligation.consumedMinor, original.consumedMinor) ||
        !exposureRetained(obligation.unresolvedMinor, original.unresolvedMinor) ||
        obligation.attempts < original.attempts ||
        original.effectRefs.some(ref => !obligation.effectRefs.some(now => organizationDigest(now) === organizationDigest(ref))))
      errors.push("ORIGINAL_IDENTITY_TERMS_RESOURCE_EXPOSURE_OR_STATE_CHANGED:" + original.id);
  }
  const destination = direction === "ROLLBACK" ? input.organization.processes : selected?.processes ?? [];
  const obligations = structuredClone(live);
  const routes = live.map(obligation => {
    const target = destination.find(p => p.id === obligation.processId)?.nodes.find(n => n.id === obligation.nodeId);
    if (!target) errors.push("NO_LAWFUL_OBLIGATION_DESTINATION:" + obligation.id);
    return { obligationId: obligation.id, workId: obligation.workId, processId: obligation.processId,
      nodeId: obligation.nodeId, accountableRoleId: obligation.accountableRoleId,
      mode: ["UNKNOWN", "MAY_HAVE_LEFT", "DISPATCHED", "DISPUTED"].includes(obligation.state)
        ? "RECONCILE_ORIGINAL_EFFECT" as const : "CONTINUE_ORIGINAL_TERMS" as const,
      originalEffectRefs: obligation.effectRefs, reservationRef: obligation.reservationRef,
      canonical: obligation.canonical ?? null,
      monetaryExposure: { consumedMinor: obligation.consumedMinor, unresolvedMinor: obligation.unresolvedMinor,
        currency: obligation.currency, unknownIsZero: false, attemptCountsAreMoney: false } };
  });
  return { schema: "finnor.organization-obligation-bridge.v1" as const, direction,
    status: errors.length ? "BLOCKED" as const : "READY" as const, errors,
    originalDigest: program.originalDigest, selectedAlternativeId: program.selectedAlternativeId,
    populationDigest: organizationDigest({ obligations: live, resourceConstraints }), obligations, routes,
    resourceConstraints: structuredClone(resourceConstraints), resourceConstraintMode: "RETAIN_WITH_ORIGINAL_S5_OWNER" as const,
    oldArrangementRetained: true, effectsRetried: false, resourcesReset: false, deadlinesReset: false };
}
