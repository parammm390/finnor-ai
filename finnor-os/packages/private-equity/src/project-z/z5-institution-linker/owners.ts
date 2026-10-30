/** Concrete original-owner joins. No caller-supplied live state or allowances. */
import { z } from "zod";
import type { PoolClient } from "pg";
import { isImmutableWorkStatus, type WorkStatus } from "@finnor/db";
import type { ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "../../types";
import { authorize, assertDependencies } from "../../owner-context";
import { readEnterpriseContingentPolicy, readEnterpriseContingentHandoffPreparation } from "../../enterprise-control";
import { readValidatedNumericEnterpriseAllocation, readEnterpriseAllocationSettlement } from "../../enterprise-allocation";
import { readEnterpriseDurableObligation, readEnterpriseDurableObligationExecutionHandoff } from "../../enterprise-obligations";
import { readEnterpriseEconomicAssignmentRecord } from "../../enterprise-economic-assignments";
import { readStoredEconomicRecord } from "../../economic-store";
import { validateInstitutionDemand } from "../../allocation-store";
import { readOwnerTransportReference } from "../../../../governed-execution/src/owner-transport";
import { RefSchema, RegisterSchema, parseInput, canonical, digest, type Profile, type OwnerCut, type Submit, type State } from "./contracts";
import { transaction, principal, profileTx } from "./store";
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const ProfileSchema = z.object({
  schema: z.literal("finnor.s8.fixed-institution-components.v1"), domain: z.literal("ORDINARY_DEVELOPMENT"),
  tenantId: z.string().uuid(), principalId: z.string().uuid(), workId: z.string().uuid(), root: RegisterSchema.shape.root,
  validUntil: z.string().datetime({ offset: true }), rightsRevision: z.string().regex(/^[1-9][0-9]*$/),
  sourceRef: RefSchema, contract: z.unknown().transform(parseInput), componentAdmissionRefs: z.array(RefSchema).min(2).max(32),
  sourceDependencies: z.array(z.object({ key: z.string().min(1).max(512), revision: z.number().int().safe().nonnegative(),
    nodeIds: z.array(z.string()).max(256), digest: z.null() }).strict()).min(1).max(128),
  nativeLocals: z.array(z.object({ component: z.string().min(1).max(192),
    owner: z.enum(["S4_PREPARATION", "S5_RESERVATION", "S6_EFFECT"]), states: z.record(z.string().min(1).max(192)) }).strict()).min(2).max(16),
  nativeCells: z.array(z.object({ cell: z.string().min(1).max(192),
    meaning: z.enum(["POLICY_DIGEST", "RESERVATION_ID", "OBLIGATION_DIGEST", "RESOURCE_ENVELOPE_DIGEST", "RIGHTS_REVISION", "UNKNOWN_FLAG"]),
    values: z.record(z.string().min(1).max(192)) }).strict()).min(1).max(8),
  protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict();
export async function registerFixedProfile(ctx: PeMutationContext, raw: unknown) {
  const input = RegisterSchema.parse(raw);
  await authorize(ctx, input.root, [{ type: "work", id: input.workId }]);
  if (input.sourceRef.owner !== "S8") throw Error("Z5_EXISTING_S8_FIXED_CONTRACT_REQUIRED");
  const accepted = await readOwnerTransportReference({ semanticOwner: "S8", tenantId: ctx.auth.tenantId, principalId: principal(ctx) }, input.sourceRef.id);
  const { content, ...ref } = accepted.reference;
  if (!same(ref, input.sourceRef)) throw Error("Z5_PROFILE_ORIGINAL_PREIMAGE_REQUIRED");
  const profile = ProfileSchema.parse(content) as Profile;
  if (profile.tenantId !== ctx.auth.tenantId || profile.principalId !== principal(ctx) || profile.workId !== input.workId
    || !same(profile.root, input.root) || profile.contract.domain !== "ORDINARY_DEVELOPMENT"
    || [...profile.contract.components, ...profile.contract.replacementCandidates].some(c =>
      c.correspondence.admission !== "NATIVE_S8_CURRENT_DECLARED_CONTRACT")
    || profile.componentAdmissionRefs.length !== profile.contract.components.length + profile.contract.replacementCandidates.length
    || profile.nativeLocals.length !== profile.contract.components.length
    || new Set(profile.nativeLocals.map(x => x.component)).size !== profile.nativeLocals.length
    || !profile.contract.components.every(c => profile.nativeLocals.some(x => x.component === c.id))
    || new Set(profile.nativeCells.map(x => x.cell)).size !== profile.nativeCells.length
    || profile.nativeCells.length !== profile.contract.cells.length
    || !profile.contract.cells.every(cell => profile.nativeCells.some(binding => binding.cell === cell.id)))
    throw Error("Z5_FIXED_PROFILE_OWNER_OR_CORRESPONDENCE_MISMATCH");
  const components = [...profile.contract.components, ...profile.contract.replacementCandidates];
  for (let i = 0; i < components.length; i++) {
    const admissionRef = profile.componentAdmissionRefs[i]!;
    if (admissionRef.owner !== "S8") throw Error("Z5_SEPARATE_COMPONENT_ADMISSION_REQUIRED");
    const actual = await readOwnerTransportReference({ semanticOwner: "S8", tenantId: ctx.auth.tenantId, principalId: principal(ctx) }, admissionRef.id);
    const { content: body, ...descriptor } = actual.reference;
    const c = components[i]!;
    if (!same(descriptor, admissionRef) || body.schema !== "finnor.s8.fixed-component-admission.v1"
      || body.domain !== "ORDINARY_DEVELOPMENT" || body.tenantId !== ctx.auth.tenantId || body.principalId !== principal(ctx)
      || body.status !== "ADMITTED" || body.componentDigest !== digest(c)
      || body.correspondenceScope !== "EXACT_LISTED_KERNEL_ONLY"
      || !Number.isFinite(Date.parse(body.validUntil)) || Date.parse(body.validUntil) < Date.parse(profile.validUntil)
      || body.protectedAdmission !== false || body.executionAuthorityGranted !== false)
      throw Error("Z5_ORIGINAL_COMPONENT_ADMISSION_NOT_CURRENT");
  }
  if (digest(profile) !== input.sourceRef.contentDigest) throw Error("Z5_PROFILE_CANONICAL_PREIMAGE_REQUIRED");
  return transaction(ctx, async c => {
    const rights = await authorize(ctx, input.root, [{ type: "work", id: input.workId }], [], c);
    if (String(rights.revision) !== profile.rightsRevision || Date.parse(profile.validUntil) <= Date.now())
      throw Error("Z5_PROFILE_RIGHTS_OR_DEADLINE_CHANGED");
    await assertDependencies(ctx, profile.sourceDependencies, c, true);
    await c.query(`INSERT INTO finnor_os.z5_component_profiles(tenant_id,principal_id,profile_id,work_id,source_ref,digest,body)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) ON CONFLICT(tenant_id,profile_id) DO NOTHING`,
    [ctx.auth.tenantId, principal(ctx), input.sourceRef.id, input.workId, canonical(input.sourceRef), input.sourceRef.contentDigest, canonical(profile)]);
    await profileTx(ctx, c, input.sourceRef);
    return { profileRef: input.sourceRef, fixedRevisions: components.map(x => ({ id: x.id, revision: x.revision })),
      protectedAdmission: false, executionAuthorityGranted: false };
  });
}
async function nativeSnapshot(ctx: PeMutationContext, c: PoolClient, request: Submit) {
  const rights = await authorize(ctx, request.root, [{ type: "work", id: request.workId }], [], c);
  const work = (await c.query<{ id: string; status: WorkStatus }>(`SELECT id,status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE`,
    [ctx.auth.tenantId, request.workId])).rows[0];
  const input = (await c.query<{ id: string; body: { context_snapshot?: { businessRoot?: unknown; focusedEntity?: unknown } } }>(`SELECT id::text,to_jsonb(i) body FROM finnor_os.work_inputs i
    WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
  [ctx.auth.tenantId, request.workId])).rows[0];
  const originalRoot = input?.body.context_snapshot?.businessRoot ?? input?.body.context_snapshot?.focusedEntity;
  if (!work || !input || isImmutableWorkStatus(work.status) || !same(originalRoot, request.root)
    || (await c.query("SELECT finnor_os.y4_control_context_complete() complete")).rows[0]?.complete !== true)
    throw Error("Z5_COMPLETE_ORIGINAL_WORK_CONTEXT_UNAVAILABLE");
  const consumption = (await c.query(`SELECT co.body,st.status,st.revision,st.effect_ref,co.reservation_id
    FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.consumption_id=$3 FOR SHARE OF co,st`,
  [ctx.auth.tenantId, principal(ctx), request.consumptionRef.id])).rows[0];
  if (!consumption || !same(consumption.body.ref, request.consumptionRef)) throw Error("Z5_ORIGINAL_CONSUMPTION_UNAVAILABLE");
  const reservation = (await c.query(`SELECT reservation_id,revision,status,revocation_reason,envelopes
    FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR SHARE`,
  [ctx.auth.tenantId, consumption.reservation_id])).rows[0];
  if (!reservation || reservation.status === "RELEASED" || reservation.revocation_reason)
    throw Error("Z5_ORIGINAL_CAPITAL_RESERVATION_NOT_CURRENT_LIABILITY_RETAINED");
  const obligations = (await c.query<{ body: { ref: ExperimentRef; effectRef: { id: string }; workLineage?: { workId: string } };
    effect_status: string; effect: unknown; action: unknown; semantic_hash: string; verification: unknown; action_status: string }>(
    `SELECT o.body,to_jsonb(e) effect,to_jsonb(a) action,e.status effect_status,e.semantic_hash,e.verification,a.status action_status
    FROM finnor_os.s6_obligation_origins o
    JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
    JOIN finnor_os.domain_actions a ON a.tenant_id=e.tenant_id AND a.id=e.domain_action_id
    WHERE o.tenant_id=$1 AND o.principal_id=$2
      AND (o.body->'workLineage'->>'workId'=$3 OR o.body->'reservationRef'->>'id'=$4)
    ORDER BY o.obligation_id LIMIT 65 FOR SHARE OF o,e,a`,
  [ctx.auth.tenantId, principal(ctx), request.workId, reservation.reservation_id])).rows;
  if (obligations.length > 64 || !same(obligations.map(o => o.body.ref).sort((a, b) => a.id < b.id ? -1 : 1),
    [...request.obligationRefs].sort((a, b) => a.id < b.id ? -1 : 1)))
    throw Error("Z5_ALL_ORIGINAL_S6_OBLIGATIONS_MUST_BE_CARRIED");
  return { input, rightsRevision: String(rights.revision), reservation, consumption, obligations };
}
export async function inspectOwners(ctx: PeMutationContext, request: Submit, profile: Profile): Promise<OwnerCut> {
  const policy = await readEnterpriseContingentPolicy(ctx, request.policyRef);
  const preparation = await readEnterpriseContingentHandoffPreparation(ctx, request.preparationRef, { originalBeforeComposition: true });
  if (Reflect.has(preparation, "compositionContract"))
    throw Error("Z5_ORIGINAL_PREPARATION_MUST_PRECEDE_COMPOSITION_SELECTION");
  const { issued, validation } = await readValidatedNumericEnterpriseAllocation(ctx, request.allocationRef);
  const compute = await validateInstitutionDemand(ctx, request.parentReservation);
  const assignment = await readEnterpriseEconomicAssignmentRecord(ctx, request.assignmentRef);
  const estimand = await readStoredEconomicRecord(ctx, String(assignment.content.estimandRef?.id ?? ""));
  const estimandValue = estimand.payload.estimand as { mandateRef?: ExperimentRef } | undefined;
  if (validation.status !== "CURRENT" || compute.status !== "CURRENT" || compute.reservation.workId !== request.workId
    || compute.reservation.demand.chargeScope?.kind !== "ORIGINAL_WORK_EPISODE"
    || !compute.reservation.demand.responsibilityIdentities.includes(request.responsibilityIdentity)
    || !same(policy.mandateRef, request.mandateRef) || !same(estimandValue?.mandateRef, request.mandateRef)
    || !same(preparation.handoff.policyRef, request.policyRef) || !same(preparation.handoff.allocationRef, request.allocationRef)
    || !same(issued.certificate.mandateRef, request.mandateRef) || !issued.reservation
    || !issued.consumptions.some(x => same(x.ref, request.consumptionRef))
    || policy.bindings.rightsRef !== issued.certificate.rightsRef
    || request.originalDeadline !== compute.reservation.originalDeadline
    || Date.parse(request.originalDeadline) > Math.min(Date.parse(policy.validUntil), Date.parse(issued.certificate.validUntil), Date.parse(profile.validUntil))
    || Date.parse(request.originalDeadline) <= Date.now())
    throw Error("Z5_ORIGINAL_S4_S5_ASSIGNMENT_OR_REMAINING_BUDGET_MISMATCH");
  const capitalReservation = issued.reservation;
  const observed: { obligationRef: ExperimentRef; digest: string | null; status: string }[] = [];
  for (const ref of request.obligationRefs) {
    const obligation = await readEnterpriseDurableObligation(ctx, ref);
    if (!same(obligation.allocationRef, request.allocationRef) || !same(obligation.reservationRef, issued.reservation.ref)
      || !same(obligation.consumptionRef, request.consumptionRef) || obligation.workLineage?.workId !== request.workId)
      throw Error("Z5_OLD_S6_ORIGIN_OR_RESERVATION_SUBSTITUTION");
    try {
      const handoff = await readEnterpriseDurableObligationExecutionHandoff(ctx, { obligationRef: ref });
      const body = handoff.handoff as { history: { event: { eventId: string } }[];
        settlements: { event: { eventId: string; detail?: { status?: string } } }[] };
      const settled = body.settlements.find(row => row.event.detail?.status === "VERIFIED");
      if (!settled) throw Error("Z5_INDEPENDENT_SETTLEMENT_UNAVAILABLE");
      await readEnterpriseAllocationSettlement(ctx, { allocationRef: request.allocationRef,
        consumptionRef: request.consumptionRef, settlementEventId: settled.event.eventId });
      observed.push({ obligationRef: ref, digest: digest(body.history.map(row => row.event.eventId)), status: "INDEPENDENT_SETTLEMENT_VERIFIED" });
    } catch {
      observed.push({ obligationRef: ref, digest: null, status: "UNKNOWN" });
    }
  }
  return transaction(ctx, async c => {
    const snapshot = await nativeSnapshot(ctx, c, request);
    await assertDependencies(ctx, profile.sourceDependencies, c, true);
    if (snapshot.rightsRevision !== profile.rightsRevision) throw Error("Z5_ORIGINAL_RIGHTS_CHANGED");
    const unknown = snapshot.obligations.some(o => o.effect_status !== "verified") || observed.some(o => o.status === "UNKNOWN");
    const statuses = { S4_PREPARATION: "PREPARED", S5_RESERVATION: snapshot.reservation.status,
      S6_EFFECT: request.obligationRefs.length === 0 ? "NO_OBLIGATION" : unknown ? "UNKNOWN" : "OBSERVED_VERIFIED" };
    const live: State = { locals: {}, cells: { ...profile.contract.live.cells } };
    for (const binding of profile.nativeLocals) {
      const state = binding.states[statuses[binding.owner]];
      if (!state) throw Error("Z5_NATIVE_LIVE_LOCATION_OUTSIDE_ADMITTED_CONTRACT");
      live.locals[binding.component] = state;
    }
    const facts = { POLICY_DIGEST: request.policyRef.contentDigest, RESERVATION_ID: capitalReservation.ref.id,
      OBLIGATION_DIGEST: digest(request.obligationRefs), RESOURCE_ENVELOPE_DIGEST: digest(snapshot.reservation.envelopes),
      RIGHTS_REVISION: snapshot.rightsRevision, UNKNOWN_FLAG: unknown ? "1" : "0" };
    for (const binding of profile.nativeCells) {
      // Exact allowlisted owner facts, never caller body or arbitrary JSON paths.
      const value = binding.values[facts[binding.meaning]];
      if (!value || !profile.contract.cells.some(cell => cell.id === binding.cell && cell.values.includes(value)))
        throw Error("Z5_NATIVE_SHARED_STATE_OUTSIDE_ADMITTED_CORRESPONDENCE");
      live.cells[binding.cell] = value;
    }
    const preserve = profile.contract.cells.filter(cell => ["reservation", "obligation", "authorization", "resource"].includes(cell.kind));
    if (!preserve.every(cell => profile.nativeCells.some(x => x.cell === cell.id))
      || !["POLICY_DIGEST", "RESERVATION_ID", "OBLIGATION_DIGEST", "RESOURCE_ENVELOPE_DIGEST", "RIGHTS_REVISION", "UNKNOWN_FLAG"]
        .every(meaning => profile.nativeCells.some(x => x.meaning === meaning)))
      throw Error("Z5_RESOURCE_OBLIGATION_AUTHORIZATION_CORRESPONDENCE_INCOMPLETE");
    parseInput({ ...profile.contract, live });
    return { workInputId: snapshot.input.id, workInputDigest: digest(snapshot.input.body),
      rightsRevision: snapshot.rightsRevision, dependencies: profile.sourceDependencies, live, liveDigest: digest(live),
      originalObligationRefs: snapshot.obligations.map(o => o.body.ref),
      nativeDigest: digest(snapshot), independentObservationDigest: digest(observed),
      estimandRef: estimand.ref, rightsRef: policy.bindings.rightsRef, exposureRetained: true, effectAuthority: false };
  });
}
export async function assertOwnerCutTx(ctx: PeMutationContext, c: PoolClient, request: Submit, profile: Profile, cut: OwnerCut) {
  await profileTx(ctx, c, request.profileRef);
  await assertDependencies(ctx, cut.dependencies, c, true);
  const actual = await nativeSnapshot(ctx, c, request);
  if (digest(actual) !== cut.nativeDigest || actual.input.id !== cut.workInputId || digest(actual.input.body) !== cut.workInputDigest
    || actual.rightsRevision !== cut.rightsRevision || Date.parse(request.originalDeadline) <= Date.now()
    || profile.rightsRevision !== cut.rightsRevision) throw Error("Z5_ORIGINAL_LIVE_WORK_SOURCE_RIGHTS_OR_RESERVATION_CHANGED");
}
