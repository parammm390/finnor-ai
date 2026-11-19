import type { TenantContext } from "@finnor/shared-types";
import { readEnterpriseDurableObligation } from "../enterprise-obligations";
import { organizationDigest } from "./compiler";
import { liveOrganizationObligation } from "./contracts";
import { organizationObligationComposition, organizationResourceConstraintComposition } from "./native-contracts";
import { organizationBusinessPopulationTx, organizationNativeObligationIdentity,
  organizationNativeResourceConstraint, resolveOrganizationObligation } from "./population";
import { orgActor, orgAuthority, orgFail, orgTx } from "./store";

/** Compose a declaration from the original S6/S5/Work owners, not caller money
 * or a fabricated cross-engine Work. The destination is an owner's proposed
 * accountable route; composition itself grants no adoption or execution. */
export async function composeOrganizationObligation(ctx: TenantContext, value: unknown) {
  const input = organizationObligationComposition.parse(value);
  const original = await readEnterpriseDurableObligation({ auth: ctx }, input.obligationRef);
  const workId = original.workLineage?.workId;
  if (!workId || organizationDigest(original.reservationRef) !== organizationDigest(input.reservationRef))
    orgFail("W5_EXACT_ORIGINAL_S6_WORK_AND_S5_REFERENCE_REQUIRED");
  return orgTx(ctx, async c => {
    await orgActor(ctx, c, true);
    await orgAuthority(ctx, c, workId, false);
    const scope = { company_id: input.companyId, work_id: workId };
    const population = await organizationBusinessPopulationTx(ctx, scope, c);
    const native = organizationNativeObligationIdentity(population, input.obligationRef);
    if (organizationDigest(native.body) !== organizationDigest(original))
      orgFail("W5_ORIGINAL_NATIVE_OWNER_PREIMAGE_CHANGED");
    const declaration = liveOrganizationObligation.parse({
      id: original.ref.id, workId, meaningDigest: native.meaningDigest, termsDigest: native.effect.semantic_hash,
      deadline: original.deadline.businessPeriodEndAt, reservationRef: original.reservationRef,
      consumedMinor: null, unresolvedMinor: null, currency: null,
      accountableRoleId: input.accountableRoleId, processId: input.processId, nodeId: input.nodeId,
      state: "OPEN", effectRefs: [native.use.effect_ref],
      dependencyRefs: [original.ref, original.preparationRef, original.mandateRef, original.policyRef,
        original.decisionRef, original.allocationRef, original.consumptionRef, original.interventionRef],
      attempts: 0, attemptAccounting: "NATIVE_OBSERVED_MINIMUM_NOT_COMPLETE_PROVIDER_METER",
      canonical: native.canonical,
    });
    const obligation = resolveOrganizationObligation(scope, declaration, population);
    return {
      schema: "finnor.organization-native-obligation-composition.v1",
      obligation,
      nativeReadback: {
        obligationRef: original.ref, allocationRef: original.allocationRef, reservationRef: original.reservationRef,
        consumptionRef: original.consumptionRef, effectRef: native.use.effect_ref, workId,
        workInputId: original.workLineage?.workInputId ?? null, originalDeadlines: original.deadline,
        originalResourceEnvelope: original.resourceEnvelope, reservationStatus: native.reservation.status,
        reservationRevision: native.reservation.revision, reservationRevocation: native.reservation.revocation_reason,
        consumptionStatus: native.use.status, nativeEffectStatus: native.effect.status,
        originalS5Scope: native.reservation.scope, originPreimageDigest: organizationDigest(original),
      },
      monetaryEvidence: {
        consumedMinor: null, unresolvedMinor: null, currency: null, status: "UNKNOWN_NATIVE_MONEY_UNMETERED",
        envelopeQuantitiesAreMoney: false, attemptsAreMoney: false, releaseSufficient: false,
      },
      qualification: "EXACT_ORDINARY_OWNER_BINDING_NOT_ADOPTION_EXECUTION_OR_PROTECTED_SETTLEMENT",
      originalIdentityRetained: true, newWorkCreated: false, executionAuthorityGranted: false,
      resourcesReleased: false, effectsRetried: false, adoptionEstablished: false, fieldTruthEstablished: false,
    };
  });
}
export type OrganizationObligationCompositionResult = Awaited<ReturnType<typeof composeOrganizationObligation>>;

/** A company hold needs no artificial Work/S6 wrapper. Its original S5 owner
 * and complete permitted capacity remain authoritative after composition. */
export async function composeOrganizationResourceConstraint(ctx: TenantContext, value: unknown) {
  const input = organizationResourceConstraintComposition.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c, true);
    const population = await organizationBusinessPopulationTx(ctx, { company_id: input.companyId }, c);
    const constraint = organizationNativeResourceConstraint(population, input.reservationRef);
    const original = population.reservations.find(r => r.reservation_id === constraint.id);
    if (!original) orgFail("W5_ORIGINAL_S5_CONSTRAINT_PREIMAGE_UNAVAILABLE");
    return {
      schema: "finnor.organization-native-resource-constraint-composition.v1", constraint,
      nativeReadback: { reservationRef: constraint.reservationRef, certificateRef: constraint.certificateRef,
        problemRef: constraint.problemRef, originalProblemSchema: original.problem?.schema,
        originalProblemValidUntil: original.problem?.validUntil, originalCertificateValidUntil: constraint.originalDeadline,
        originalProblemAndOwnerBindingsDigest: constraint.nativeProblemDigest,
        canonicalRoots: constraint.canonicalRoots, originalWorks: constraint.originalWorks,
        originalNativeOwnerBindings: constraint.nativeOwners ?? [],
        unresolvedOriginalOwnerBindings: population.nativeResourceOwners.failures,
        originalResourceEnvelope: constraint.originalResourceEnvelope, reservationStatus: constraint.reservationStatus,
        reservationRevision: constraint.reservationRevision, reservationRevocation: constraint.revocationReason,
        consumptions: constraint.consumptions, nativeS5CapacitySnapshotDigest: population.s5Capacity.snapshotDigest },
      qualification: "EXACT_EXISTING_NATIVE_S5_CONSTRAINT_RETENTION_NOT_WORK_S6_OR_NEW_CLEARANCE",
      monetaryEvidence: { ...constraint.monetaryExposure, status: "UNKNOWN_NATIVE_MONEY_UNMETERED",
        envelopeQuantitiesAreMoney: false, attemptsAreMoney: false, releaseSufficient: false },
      originalIdentityRetained: true, newWorkCreated: false, newS6OriginCreated: false,
      executionAuthorityGranted: false, resourcesReleased: false, resourcesReReserved: false,
      effectsRetried: false, adoptionEstablished: false, fieldTruthEstablished: false,
    };
  });
}
export type OrganizationResourceConstraintCompositionResult = Awaited<ReturnType<typeof composeOrganizationResourceConstraint>>;
