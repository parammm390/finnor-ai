import type { PoolClient } from "pg";
import type { TenantContext, DurableObligation, AllocationEnvelope, AllocationConsumption, BusinessEffectSet } from "@finnor/shared-types";
import { canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import { epistemicHash } from "../../../epistemic-runtime/src/source-precedence";
import { readAllocationSnapshot } from "../allocation-store";
import { liveOrganizationObligation, organizationReference, organizationResourceConstraint, OrganizationTransformationError,
  type LiveOrganizationObligation, type OrganizationReference, type OrganizationResourceConstraint } from "./contracts";
import { organizationDigest } from "./compiler";
import { organizationConstraintRetained } from "./lifecycle";
import { readOrganizationResourceOwnersTx } from "./resource-owners";
import { orgFail, rawDigest, principal, orgLock, type OrganizationRequestRow } from "./store";

export interface OrganizationBusinessScope {
  company_id: string; work_id?: string; budget?: Pick<OrganizationRequestRow["budget"], "reservationRef">;
}
interface NativeOrigin {
  principal_id: string; obligation_id: string; consumption_id: string; effect_id: string;
  domain_action_id: string; body: DurableObligation; work_id: string | null;
}
interface NativeReservation {
  reservation_id: string; allocation_digest: string; status: string; revision: number; revocation_reason: string | null;
  envelopes: AllocationEnvelope[]; principal_id: string | null;
  body: ({ ref: OrganizationReference; schema: string } & Record<string, unknown>) | null;
  problem: Record<string, unknown> | null; certificate: Record<string, unknown> | null;
}
interface NativeConsumption {
  consumption_id: string; reservation_id: string; principal_id: string;
  body: AllocationConsumption | ({ schema: string; ref: OrganizationReference; reservationRef: OrganizationReference;
    certificateRef: OrganizationReference; envelope: AllocationEnvelope[] } & Record<string, unknown>); status: string;
  effect_ref: OrganizationReference | null;
}
interface NativeEffect {
  id: string; work_id: string; domain_action_id: string; semantic_hash: string; version: number;
  status: string; effect: BusinessEffectSet;
}
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const objects = (v: unknown) => Array.isArray(v) ? v.map(record).filter((x): x is Record<string, unknown> => !!x) : [];
function reservationScope(row: NativeReservation, companyId: string, workIds: string[], s6ReservationIds: Set<string>) {
  const roots: Array<{ entityType: string; entityId: string }> = [];
  const addRoot = (v: unknown) => {
    const root = record(v);
    if (typeof root?.entityType === "string" && typeof root.entityId === "string")
      roots.push({ entityType: root.entityType, entityId: root.entityId });
  };
  const schema = row.problem?.schema;
  if (schema === "finnor.allocation-problem.v1") {
    const check = record(row.certificate?.check);
    const selected = Array.isArray(check?.selectedPolicyIds) ? check.selectedPolicyIds : [];
    for (const policy of objects(row.problem?.policies).filter(p => !selected.length || selected.includes(record(p.ref)?.id)))
      for (const pin of objects(record(policy.bindings)?.beliefPins)) addRoot(pin.root);
  } else if (["finnor.s5.workforce-resource-problem.v1", "finnor.s5.fixed-primary-problem.v1",
    "finnor.s5.fixed-programme-problem.v1"].includes(String(schema))) addRoot(row.problem?.root);
  else if (row.body?.schema === "finnor.s5.institution-reservation.v1" && typeof row.body.workId === "string")
    addRoot({ entityType: "work", entityId: row.body.workId });
  const directS6 = s6ReservationIds.has(row.reservation_id);
  const matches = roots.some(root => root.entityType === "work" && workIds.includes(root.entityId) ||
    ["COMPANY", "external_organization"].includes(root.entityType) && root.entityId === companyId);
  const understood = roots.length > 0 && roots.every(root => ["work", "COMPANY", "external_organization"].includes(root.entityType));
  return { status: directS6 || matches ? "MATCH" as const : understood ? "OTHER" as const : "UNKNOWN" as const,
    basis: directS6 ? "ACTUAL_S6_ORIGIN_OR_EFFECT_CONSUMPTION" : schema === "finnor.allocation-problem.v1"
      ? "CANONICAL_SELECTED_S4_POLICY_BELIEF_ROOTS" : "SCHEMA_SPECIFIC_CANONICAL_S5_ROOT",
    roots };
}

/** The business population comes from Core's company links, not the producer's
 * supplied obligation array. The table lock closes new-link phantoms; Work and
 * action row locks also fence new FK-bound acceptances until this cut commits.
 * S5 writers are serialized by the existing tenant portfolio lock. */
export async function organizationBusinessPopulationTx(ctx: TenantContext, q: OrganizationBusinessScope, c: PoolClient) {
  await c.query(`SELECT set_config('lock_timeout',least(nullif(setting::bigint,0),1000)::text,true)
    FROM pg_settings WHERE name='lock_timeout'`);
  await orgLock(ctx, c);
  // The native owner verifies complete permitted capacity, including its actual
  // accounting frontier. W5 retains originals; it does not recompute clearance.
  const s5Capacity = await readAllocationSnapshot({ auth: ctx }, c);
  // Some operation bindings have no FK to the effect row. Lock their actual
  // writers too; locking only parents cannot close those insertion phantoms.
  await c.query(`LOCK TABLE finnor_os.work_entity_links,finnor_os.domain_actions,finnor_os.business_effects,
    finnor_os.integration_operations,finnor_os.external_operations,finnor_os.provider_operation_attempts,
    finnor_os.p1_requests,finnor_os.p2_requests,finnor_os.p2_units,finnor_os.p2_attempts,
    finnor_os.p2_grant_usage,finnor_os.w2_programs IN SHARE MODE`);
  const company = (await c.query(`SELECT id FROM finnor_os.external_organizations
    WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`, [ctx.tenantId, q.company_id])).rows[0];
  if (!company) orgFail("W5_CURRENT_CANONICAL_COMPANY_REQUIRED");
  const works = (await c.query<{ id: string; initial_instruction: string; status: string; created_by: string }>(
    `SELECT w.id,w.initial_instruction,w.status,w.created_by FROM finnor_os.works w
    WHERE w.tenant_id=$1 AND EXISTS(SELECT 1 FROM finnor_os.work_entity_links l
      WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id AND l.entity_type='external_organization' AND l.entity_id=$2)
    ORDER BY w.id LIMIT 1025 FOR UPDATE OF w`, [ctx.tenantId, q.company_id])).rows;
  if (works.length > 1024 || q.work_id && !works.some(w => w.id === q.work_id))
    orgFail("W5_COMPLETE_ORIGINAL_BUSINESS_WORK_POPULATION_REQUIRED");
  for (const work of works) if (!await canExerciseWorkforceAuthorityTx(ctx, {
    operation: "query", capability: "query:work", risk: "low", workId: work.id, resource: { type: "work", id: work.id },
  }, c)) orgFail("W5_COMPLETE_BUSINESS_POPULATION_AUTHORITY_REQUIRED", 403);
  const ids = works.map(w => w.id);
  const actions = (await c.query(`SELECT d.id,d.work_id,d.status,d.business_effect_id,d.action_type,d.initiated_by,
    d.authority_context,d.depends_on FROM finnor_os.domain_actions d
    WHERE d.tenant_id=$1 AND d.work_id=ANY($2::uuid[]) ORDER BY d.id LIMIT 2049 FOR UPDATE OF d`,
    [ctx.tenantId, ids])).rows;
  if (actions.length > 2048) orgFail("W5_COMPLETE_ACCEPTED_ACTION_POPULATION_REQUIRED");
  const effects = (await c.query<NativeEffect>(`SELECT e.*,d.work_id FROM finnor_os.business_effects e
    JOIN finnor_os.domain_actions d ON d.tenant_id=e.tenant_id AND d.id=e.domain_action_id
    WHERE e.tenant_id=$1 AND d.work_id=ANY($2::uuid[]) ORDER BY e.id LIMIT 1025 FOR UPDATE OF e`,
    [ctx.tenantId, ids])).rows;
  if (effects.length > 1024) orgFail("W5_COMPLETE_CANONICAL_EFFECT_POPULATION_REQUIRED");
  const effectIds = effects.map(e => e.id);
  const origins = (await c.query<NativeOrigin>(`SELECT o.principal_id,o.obligation_id,o.consumption_id,o.effect_id,
    o.domain_action_id,o.body,d.work_id FROM finnor_os.s6_obligation_origins o
    LEFT JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id
    WHERE o.tenant_id=$1 AND (d.work_id=ANY($2::uuid[]) OR o.body#>>'{workLineage,workId}'=ANY($2::text[])
      OR o.effect_id=ANY($3::uuid[])) ORDER BY o.obligation_id LIMIT 1025`,
    [ctx.tenantId, ids, effectIds])).rows;
  if (origins.length > 1024) orgFail("W5_COMPLETE_CANONICAL_S6_ORIGIN_POPULATION_REQUIRED");
  const operations = (await c.query(`SELECT 'integration' kind,to_jsonb(o) body FROM finnor_os.integration_operations o
    WHERE o.tenant_id=$1 AND o.business_effect_id=ANY($2::uuid[])
    UNION ALL SELECT 'external' kind,to_jsonb(o) body FROM finnor_os.external_operations o
    WHERE o.tenant_id=$1 AND o.business_effect_id=ANY($2::uuid[]) LIMIT 4097`,
    [ctx.tenantId, effectIds])).rows;
  if (operations.length > 4096) orgFail("W5_COMPLETE_CANONICAL_OPERATION_POPULATION_REQUIRED");
  const providerAttempts = (await c.query(`SELECT to_jsonb(a) body,o.business_effect_id FROM finnor_os.provider_operation_attempts a
    JOIN finnor_os.external_operations o ON o.tenant_id=a.tenant_id AND o.id=a.external_operation_id
    WHERE a.tenant_id=$1 AND o.business_effect_id=ANY($2::uuid[]) ORDER BY a.id LIMIT 4097`,
    [ctx.tenantId, effectIds])).rows;
  if (providerAttempts.length > 4096) orgFail("W5_COMPLETE_CANONICAL_PROVIDER_ATTEMPT_POPULATION_REQUIRED");
  const effectUses = (await c.query(`SELECT co.reservation_id FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND st.effect_ref->>'id'=ANY($2::text[]) ORDER BY co.consumption_id LIMIT 4097`,
    [ctx.tenantId, effectIds])).rows;
  if (effectUses.length > 4096) orgFail("W5_COMPLETE_CANONICAL_EFFECT_CONSUMPTION_POPULATION_REQUIRED");
  const s6ReservationIds = new Set<string>([...origins.map(o => o.body.reservationRef.id), ...effectUses.map(o => String(o.reservation_id))]);
  // Scan the bounded tenant reservation owner first. A Work-only WHERE clause
  // loses genuine COMPANY-root joint allocations. Missing/unsupported preimages
  // remain visible blockers instead of being removed by an inner join/filter.
  const allReservations = (await c.query<NativeReservation>(`SELECT r.reservation_id,r.allocation_digest,r.status,r.revision,r.revocation_reason,
    r.envelopes,o.principal_id,o.body,p.problem,p.certificate
    FROM finnor_os.s5_reservations r LEFT JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
    LEFT JOIN finnor_os.s5_proposals p ON p.tenant_id=r.tenant_id AND p.content_digest=r.allocation_digest
    WHERE r.tenant_id=$1 AND r.reservation_id<>$2
    ORDER BY r.reservation_id LIMIT 1025 FOR UPDATE OF r`,
    [ctx.tenantId, q.budget?.reservationRef.id ?? ""])).rows;
  if (allReservations.length > 1024) orgFail("W5_COMPLETE_CANONICAL_RESERVATION_POPULATION_REQUIRED");
  const reservations = allReservations.map(r => ({ ...r, scope: reservationScope(r, q.company_id, ids, s6ReservationIds) }))
    .filter(r => r.scope.status !== "OTHER");
  const consumptions = (await c.query<NativeConsumption>(`SELECT co.consumption_id,co.reservation_id,co.principal_id,co.body,st.status,st.effect_ref
    FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.reservation_id=ANY($2::text[]) ORDER BY co.consumption_id LIMIT 4097 FOR UPDATE OF st`,
    [ctx.tenantId, reservations.map(r => r.reservation_id)])).rows;
  if (consumptions.length > 4096) orgFail("W5_COMPLETE_CANONICAL_CONSUMPTION_POPULATION_REQUIRED");
  const inputIds = origins.flatMap(o => o.body.workLineage?.workInputId ? [o.body.workLineage.workInputId] : []);
  const workInputs = (await c.query<{ id: string; work_id: string; instruction_text: string }>(`SELECT id,work_id,instruction_text
    FROM finnor_os.work_inputs WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [ctx.tenantId, inputIds])).rows;
  const nativeResourceOwners = await readOrganizationResourceOwnersTx(ctx, works, reservations, c);
  return { tenantId: ctx.tenantId, principalId: principal(ctx), works, workInputs, actions, effects, origins,
    operations, providerAttempts, reservations, consumptions, s5Capacity, nativeResourceOwners };
}
export type OrganizationBusinessPopulation = Awaited<ReturnType<typeof organizationBusinessPopulationTx>>;
export function organizationNativeOrigin(population: OrganizationBusinessPopulation, ref: OrganizationReference) {
  const origin = population.origins.find(o => o.obligation_id === ref.id), body = origin?.body;
  if (!origin || !body || origin.principal_id !== population.principalId) orgFail("W5_CURRENT_S6_OWNER_PREIMAGE_REQUIRED", 403);
  const { ref: nativeRef, ...preimage } = body;
  const effect = population.effects.find(e => e.id === origin.effect_id);
  const use = population.consumptions.find(s => s.consumption_id === origin.consumption_id);
  const reservation = population.reservations.find(r => r.reservation_id === body.reservationRef.id);
  const workId = body.workLineage?.workId;
  if (body.schema !== "finnor.durable-obligation.v1" || body.semanticOwner !== "S6" || body.tenantId !== population.tenantId ||
    body.principalId !== population.principalId || nativeRef.owner !== "S6" || nativeRef.version !== "s6-obligation-v1" ||
    nativeRef.id !== "durable-obligation:" + nativeRef.contentDigest || epistemicHash(preimage) !== nativeRef.contentDigest ||
    organizationDigest(nativeRef) !== organizationDigest(ref) || body.executionAuthorityGranted !== false || body.protectedReceipt !== null ||
    !workId || origin.work_id !== workId || !effect || effect.work_id !== workId || effect.domain_action_id !== body.domainActionId ||
    effect.id !== body.effectRef.id || effect.semantic_hash !== body.effectRef.semanticHash || effect.version !== body.effectRef.schemaVersion ||
    effect.effect.source.workId !== workId || organizationDigest(effect.effect.delta.values.workLineage) !== organizationDigest(body.workLineage) ||
    organizationDigest(effect.effect.delta.values.intervention) !== organizationDigest(body.intervention) ||
    !use || use.body.schema !== "finnor.allocation-consumption.v1" || !reservation?.body ||
    organizationDigest(use.body.ref) !== organizationDigest(body.consumptionRef) ||
    organizationDigest(use.body.reservationRef) !== organizationDigest(body.reservationRef) ||
    organizationDigest(use.body.certificateRef) !== organizationDigest(body.allocationRef) ||
    organizationDigest(reservation.body.ref) !== organizationDigest(body.reservationRef) ||
    organizationDigest(reservation.envelopes) !== organizationDigest(body.resourceEnvelope) ||
    organizationDigest(use.body.envelope) !== organizationDigest(body.resourceEnvelope) ||
    use.effect_ref?.id !== effect.id || use.effect_ref.contentDigest !== effect.semantic_hash ||
    use.effect_ref.owner !== "S6" || use.effect_ref.version !== "business-effect-v" + effect.version)
    orgFail("W5_EXACT_CANONICAL_S6_S5_WORK_LINEAGE_REQUIRED");
  const { ref: reservationRef, ...reservationPreimage } = reservation.body;
  const { ref: consumptionRef, ...consumptionPreimage } = use.body;
  if (epistemicHash(reservationPreimage) !== reservationRef.contentDigest ||
    epistemicHash(consumptionPreimage) !== consumptionRef.contentDigest ||
    organizationDigest(reservation.certificate?.ref) !== organizationDigest(body.allocationRef))
    orgFail("W5_EXACT_CANONICAL_S5_PREIMAGE_REQUIRED");
  return { origin, body, effect, use, reservation };
}
export function organizationNativeObligationIdentity(population: OrganizationBusinessPopulation, ref: OrganizationReference) {
  const native = organizationNativeOrigin(population, ref), { body } = native;
  const lineage = body.workLineage;
  if (!lineage) orgFail("W5_EXACT_ORIGINAL_WORK_LINEAGE_REQUIRED");
  const work = population.works.find(w => w.id === lineage.workId);
  const input = lineage.workInputId ? population.workInputs.find(i => i.id === lineage.workInputId && i.work_id === lineage.workId) : null;
  if (!work || lineage.workInputId && !input) orgFail("W5_EXACT_ORIGINAL_WORK_INPUT_REQUIRED");
  return { ...native, work, meaningDigest: rawDigest(input ? input.instruction_text : work.initial_instruction),
    canonical: { obligationRef: body.ref, allocationRef: body.allocationRef, consumptionRef: body.consumptionRef,
      workInputId: lineage.workInputId, planRevisionId: lineage.planRevisionId, planDigest: lineage.planDigest,
      deadlines: body.deadline, resourceEnvelopeDigest: organizationDigest(body.resourceEnvelope),
      reservationRevisionAtPreparation: body.preconditions.reservationRevision } };
}
export function resolveOrganizationObligation(q: OrganizationBusinessScope, value: unknown, population: OrganizationBusinessPopulation): LiveOrganizationObligation {
  const obligation = liveOrganizationObligation.parse(value), work = population.works.find(w => w.id === obligation.workId);
  const reservation = population.reservations.find(r => r.reservation_id === obligation.reservationRef.id);
  const native = obligation.canonical ? organizationNativeObligationIdentity(population, obligation.canonical.obligationRef) : null;
  const meaningDigest = native ? native.meaningDigest : work ? rawDigest(work.initial_instruction) : null;
  if (!work || meaningDigest !== obligation.meaningDigest || !reservation?.body || reservation.scope.status !== "MATCH" ||
      reservation.principal_id !== population.principalId ||
      organizationDigest(reservation.body.ref) !== organizationDigest(obligation.reservationRef))
    orgFail("W5_CANONICAL_ORIGINAL_WORK_AND_RESERVATION_REQUIRED");
  if (native && (native.body.workLineage?.workId !== obligation.workId ||
    obligation.id !== native.body.ref.id || obligation.effectRefs.length !== 1 ||
    organizationDigest(obligation.effectRefs[0]) !== organizationDigest(native.use.effect_ref) ||
    obligation.termsDigest !== native.effect.semantic_hash ||
    organizationDigest(native.canonical) !== organizationDigest(obligation.canonical) ||
    native.body.deadline.businessPeriodEndAt !== obligation.deadline ||
    organizationDigest(native.body.reservationRef) !== organizationDigest(obligation.reservationRef)))
    orgFail("W5_ORIGINAL_S6_DEADLINE_AND_DEPENDENCIES_REQUIRED");
  if (population.origins.some(o => obligation.effectRefs.some(r => r.id === o.effect_id)) && !native)
    orgFail("W5_CANONICAL_S6_BINDING_REQUIRED");
  if (obligation.consumedMinor !== null || obligation.unresolvedMinor !== null || obligation.currency !== null)
    orgFail("W5_NATIVE_MONEY_OBSERVATION_UNAVAILABLE_NOT_ZERO");
  const effects = obligation.effectRefs.map(ref => {
    const effect = population.effects.find(e => e.id === ref.id);
    if (ref.owner !== "S6" || !effect || effect.work_id !== obligation.workId || effect.semantic_hash !== ref.contentDigest ||
        "business-effect-v" + effect.version !== ref.version) orgFail("W5_CANONICAL_ORIGINAL_EFFECT_PREIMAGE_REQUIRED");
    return effect;
  });
  const terms = effects.length === 1 ? effects[0]!.semantic_hash : effects.length
    ? organizationDigest(effects.map(e => e.semantic_hash).sort()) : obligation.meaningDigest;
  if (obligation.termsDigest !== terms) orgFail("W5_EXACT_CANONICAL_ACCEPTED_TERMS_REQUIRED");
  const operationRows = population.operations.filter(o => effects.some(e => o.body.business_effect_id === e.id));
  let state = obligation.state;
  const uses = population.consumptions.filter(s => s.reservation_id === reservation.reservation_id &&
    (s.effect_ref && effects.some(e => e.id === s.effect_ref?.id) || native && s.consumption_id === native.use.consumption_id));
  if (effects.some(e => e.status === "divergent")) state = "DISPUTED";
  else if (effects.some(e => ["unverified", "reconciliation_required"].includes(e.status)) ||
      uses.some(s => s.status === "UNKNOWN_OUTCOME") || reservation.status === "UNKNOWN_OUTCOME" ||
      operationRows.some(o => ["unknown", "unverified", "reconciliation_required"].includes(o.body.verification_status) ||
        ["unknown", "unknown_outcome", "reconciliation_required"].includes(o.body.status))) state = "UNKNOWN";
  else if (effects.some(e => e.status === "executing") || operationRows.some(o => ["running", "in_flight"].includes(o.body.status)))
    state = "MAY_HAVE_LEFT";
  else if (effects.length && effects.every(e => ["verified", "compensated", "cancelled"].includes(e.status))) state = "SETTLED";
  else if (effects.some(e => ["executed", "partially_verified"].includes(e.status))) state = "DISPATCHED";
  else if (effects.some(e => e.status === "authorized")) state = "ACCEPTED";
  if (["UNKNOWN", "MAY_HAVE_LEFT", "DISPATCHED"].includes(obligation.state) && !effects.length)
    orgFail("W5_UNCERTAIN_OBLIGATION_REQUIRES_CANONICAL_EFFECT");
  if (obligation.state === "SETTLED" && state !== "SETTLED") orgFail("W5_ORIGINAL_SETTLEMENT_NOT_OBSERVED");
  if (reservation.status === "RELEASED" && state !== "SETTLED")
    orgFail("W5_ORIGINAL_LIABILITY_RESERVATION_RELEASED");
  const providerAttempts = population.providerAttempts.filter(a => effects.some(e => a.business_effect_id === e.id));
  return { ...obligation, state, attempts: Math.max(obligation.attempts, operationRows.length, providerAttempts.length),
    attemptAccounting: "NATIVE_OBSERVED_MINIMUM_NOT_COMPLETE_PROVIDER_METER" };
}
/** Read immutable originals from S5. No S6 origin or business Work is invented
 * for a pure company hold; every actual native Work root must resolve. */
export function organizationNativeResourceConstraint(population: OrganizationBusinessPopulation, ref: OrganizationReference) {
  const reservation = population.reservations.find(r => r.reservation_id === ref.id);
  if (!reservation?.body || !reservation.problem || !reservation.certificate ||
      reservation.principal_id !== population.principalId || reservation.scope.status !== "MATCH" ||
      !reservation.scope.roots.length || reservation.scope.roots.some(root =>
        !["work", "COMPANY", "external_organization"].includes(root.entityType)))
    orgFail("W5_COMPLETE_PERMITTED_CANONICAL_S5_CONSTRAINT_REQUIRED");
  const { body, problem, certificate } = reservation;
  const versions: Record<string, string> = { "finnor.allocation-problem.v1": "s5-joint-finite-v1",
    "finnor.s5.workforce-resource-problem.v1": "s5-workforce-v1",
    "finnor.s5.fixed-primary-problem.v1": "s5-primary-fixed-v1",
    "finnor.s5.fixed-programme-problem.v1": "s5-primary-fixed-v1" };
  const expectedVersion = versions[String(problem.schema)];
  const exactRef = (value: unknown) => {
    const parsed = organizationReference.safeParse(value);
    if (!parsed.success || parsed.data.owner !== "S5" || parsed.data.version !== expectedVersion)
      orgFail("W5_EXACT_NATIVE_S5_CONSTRAINT_REFERENCE_REQUIRED");
    return parsed.data;
  };
  const reservationRef = exactRef(body.ref), certificateRef = exactRef(certificate.ref), problemRef = exactRef(certificate.problemRef);
  if (population.nativeResourceOwners.failures.some(f => f.certificateId === certificateRef.id &&
      (f.reservationId === null || f.reservationId === reservation.reservation_id)))
    orgFail("W5_COMPLETE_ORIGINAL_NATIVE_RESOURCE_OWNER_BINDINGS_REQUIRED");
  const nativeOwners = population.nativeResourceOwners.bindings.filter(b => b.certificateId === certificateRef.id &&
    (b.reservationId === null || b.reservationId === reservation.reservation_id)).map(b => b.owner);
  const { ref: _reservationRef, ...reservationPreimage } = body;
  const { ref: _certificateRef, ...certificatePreimage } = certificate;
  const { ref: problemNativeRef, ...problemPreimage } = problem;
  const canonicalRoots = [...new Map(reservation.scope.roots.map(root =>
    [root.entityType + ":" + root.entityId, root])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, root]) => root);
  const originalWorkIds = [...new Set([...canonicalRoots.filter(root => root.entityType === "work").map(root => root.entityId),
    ...nativeOwners.map(owner => owner.workId)])].sort();
  const originalWorks = originalWorkIds.map(workId => {
    const work = population.works.find(w => w.id === workId);
    if (!work) orgFail("W5_ACTUAL_ORIGINAL_CONSTRAINT_WORK_REQUIRED");
    return { workId: work.id as string, initialMeaningDigest: rawDigest(work.initial_instruction) };
  });
  if (!expectedVersion || body.schema !== "finnor.allocation-reservation.v1" ||
      body.tenantId !== population.tenantId || body.principalId !== population.principalId ||
      problem.tenantId !== population.tenantId || problem.principalId !== population.principalId ||
      certificate.tenantId !== population.tenantId || certificate.principalId !== population.principalId ||
      certificate.semanticOwner !== "S5" || body.executionAuthorityGranted !== false || body.protectedReceipt !== null ||
      reservation.allocation_digest !== certificateRef.contentDigest ||
      reservationRef.id !== "allocation-reservation:" + reservationRef.contentDigest ||
      certificateRef.id !== "allocation-certificate:" + certificateRef.contentDigest ||
      organizationDigest(ref) !== organizationDigest(reservationRef) ||
      organizationDigest(body.certificateRef) !== organizationDigest(certificateRef) ||
      organizationDigest(body.envelopes) !== organizationDigest(reservation.envelopes) ||
      epistemicHash(reservationPreimage) !== reservationRef.contentDigest ||
      epistemicHash(certificatePreimage) !== certificateRef.contentDigest ||
      epistemicHash(problemNativeRef ? problemPreimage : problem) !== problemRef.contentDigest ||
      problemNativeRef && organizationDigest(exactRef(problemNativeRef)) !== organizationDigest(problemRef))
    orgFail("W5_EXACT_ORIGINAL_S5_CONSTRAINT_PREIMAGE_REQUIRED");
  const consumptions = population.consumptions.filter(s => s.reservation_id === reservation.reservation_id).map(use => {
    const { ref: useRef, ...preimage } = use.body;
    const parsedRef = exactRef(useRef);
    if (use.principal_id !== population.principalId ||
        !["finnor.allocation-consumption.v1", "finnor.s5.workforce-consumption.v1"].includes(use.body.schema) ||
        epistemicHash(preimage) !== parsedRef.contentDigest ||
        organizationDigest(use.body.reservationRef) !== organizationDigest(reservationRef) ||
        organizationDigest(use.body.certificateRef) !== organizationDigest(certificateRef))
      orgFail("W5_EXACT_ORIGINAL_S5_CONSTRAINT_CONSUMPTION_REQUIRED");
    return { ref: parsedRef, status: use.status, effectRef: use.effect_ref };
  });
  const parsed = organizationResourceConstraint.safeParse({
    schema: "finnor.organization-native-resource-constraint.v1", id: reservationRef.id,
    reservationRef, certificateRef, problemRef, nativeProblemDigest: epistemicHash(problem),
    originalDeadline: certificate.validUntil, canonicalRoots, originalWorks, nativeOwners,
    originalResourceEnvelope: reservation.envelopes, reservationRevision: reservation.revision,
    reservationStatus: reservation.status, revocationReason: reservation.revocation_reason, consumptions,
    monetaryExposure: { consumedMinor: null, unresolvedMinor: null, currency: null },
    retention: "EXISTING_S5_OWNER_CONSTRAINT_NOT_NEW_WORK_OR_RESOURCE_GRANT",
  });
  if (!parsed.success) orgFail("W5_SUPPORTED_NATIVE_S5_CONSTRAINT_SHAPE_REQUIRED");
  return parsed.data;
}
export async function inspectOrganizationObligationPopulationTx(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient) {
  const population = await organizationBusinessPopulationTx(ctx, q, c);
  const links = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2
    AND kind='OBLIGATION_ROUTE_BOUND' ORDER BY event_key LIMIT 1025`, [ctx.tenantId, q.id])).rows;
  if (links.length > 1024) orgFail("W5_COMPLETE_BOUND_OBLIGATION_POPULATION_REQUIRED");
  const declared = [...q.original.organization.obligations];
  for (const link of links) {
    if (organizationDigest(link.body) !== link.body_digest) orgFail("W5_BOUND_OBLIGATION_PREIMAGE_CHANGED");
    declared.push(liveOrganizationObligation.parse(link.body.obligation));
  }
  if (declared.length > 1024 || new Set(declared.map(o => o.id)).size !== declared.length)
    orgFail("W5_COMPLETE_UNIQUE_LIVE_OBLIGATION_POPULATION_REQUIRED");
  const obligations = declared.map(o => resolveOrganizationObligation(q, o, population));
  const resourceConstraints: OrganizationResourceConstraint[] = [], constraintErrors: string[] = [];
  for (const reservation of population.reservations.filter(r => r.scope.status === "MATCH")) {
    try {
      if (!reservation.body) orgFail("W5_ORIGINAL_S5_CONSTRAINT_PREIMAGE_UNAVAILABLE");
      resourceConstraints.push(organizationNativeResourceConstraint(population, reservation.body.ref));
    } catch (error) {
      if (!(error instanceof OrganizationTransformationError)) throw error;
      constraintErrors.push(error.code + ":" + reservation.reservation_id);
    }
  }
  for (const original of q.original.organization.resourceConstraints ?? []) {
    const current = resourceConstraints.find(r => r.id === original.id);
    if (!current || !organizationConstraintRetained(original, current))
      constraintErrors.push("ORIGINAL_NATIVE_RESOURCE_CONSTRAINT_NOT_RETAINED:" + original.id);
  }
  const representedEffects = new Set(obligations.flatMap(o => o.effectRefs.map(r => r.id)));
  const representedReservations = new Set([...obligations.map(o => o.reservationRef.id), ...resourceConstraints.map(r => r.id)]);
  const unmappedEffects = population.effects.filter(e => !representedEffects.has(e.id));
  const unmappedReservations = population.reservations.filter(r => r.status !== "RELEASED" && !representedReservations.has(r.reservation_id));
  const acceptedWithoutEffect = population.actions.filter(a => ["approved", "executing", "completed"].includes(a.status) &&
    !a.business_effect_id);
  const unsupportedScopes = population.reservations.filter(r => r.scope.status === "UNKNOWN" && r.status !== "RELEASED");
  const errors = [
    ...population.nativeResourceOwners.failures.map(f => f.code + ":" + f.ownerId),
    ...constraintErrors,
    ...unsupportedScopes.map(() => "COMPLETE_RESERVATION_SCOPE_OR_PREIMAGE_UNAVAILABLE"),
    ...unmappedEffects.map(e => "NO_LAWFUL_CANONICAL_EFFECT_BRIDGE:" + e.id),
    ...unmappedReservations.map(r => "NO_LAWFUL_CANONICAL_RESERVATION_BRIDGE:" + r.reservation_id),
    ...acceptedWithoutEffect.map(a => "NO_LAWFUL_ACCEPTED_ACTION_BRIDGE:" + a.id),
  ];
  const manifest = {
    schema: "finnor.organization-canonical-business-population.v1", companyId: q.company_id,
    workIds: population.works.map(w => w.id), actionIds: population.actions.map(a => a.id),
    effects: population.effects.map(e => ({ id: e.id, workId: e.work_id, semanticHash: e.semantic_hash, status: e.status })),
    operations: population.operations.map(o => ({ kind: o.kind, id: o.body.id, effectId: o.body.business_effect_id,
      status: o.body.status, verificationStatus: o.body.verification_status, preimageDigest: organizationDigest(o.body) })),
    nativeS6Origins: population.origins.map(o => ({ obligationRef: o.body.ref, workId: o.work_id,
      reservationRef: o.body.reservationRef, consumptionRef: o.body.consumptionRef, effectId: o.effect_id,
      originalDeadlines: o.body.deadline, preimageDigest: organizationDigest(o.body) })),
    resourceConstraints,
    nativeResourceOwnerFailures: population.nativeResourceOwners.failures,
    standaloneNativeOwnersWithoutS5Binding: population.nativeResourceOwners.bindings.filter(b => b.certificateId === "").map(b => b.owner),
    nativeS5Capacity: { snapshotDigest: population.s5Capacity.snapshotDigest,
      resourceRefs: population.s5Capacity.resources.map(r => r.ref), originalOutstanding: population.s5Capacity.outstanding,
      qualification: "ORIGINAL_S5_PERMITTED_ACCOUNTING_FRONTIER_NOT_NEW_CLEARANCE" },
    reservations: population.reservations.map(r => ({ id: r.reservation_id, ref: r.body?.ref ?? null, status: r.status,
      scope: r.scope, envelopeDigest: organizationDigest(r.envelopes), originalEnvelopes: r.envelopes,
      consumedMinor: null, unresolvedMinor: null, currency: null })),
    consumptions: population.consumptions.map(s => ({ ref: s.body.ref, reservationId: s.reservation_id,
      status: s.status, effectRef: s.effect_ref, preimageDigest: organizationDigest(s.body) })),
    providerAttempts: population.providerAttempts.map(a => ({ id: a.body.id, effectId: a.business_effect_id,
      status: a.body.status, preimageDigest: organizationDigest(a.body) })),
    originalNativeComputeReservation: q.budget.reservationRef, originalDeadline: q.original.mandate.originalDeadline,
    scope: "COMPLETE_CANONICAL_COMPANY_LINKED_WORK_NOT_ONLY_SUPPLIED_OBLIGATIONS",
    unknownMoneyRetained: true, automaticRedispatch: false, monetaryCostInferredFromAttempts: false,
    snapshotFences: ["S5_TENANT_PORTFOLIO", "CORE_COMPANY_LINK_TABLE", "CORE_WORK_ACTION_EFFECT_ROWS",
      "NATIVE_OPERATION_AND_PHYSICAL_ATTEMPT_WRITERS", "ORIGINAL_P1_P2_W2_REQUEST_GRANT_AND_ATTEMPT_WRITERS"],
    lockWaitCeilingMs: 1000, attemptAccounting: "NATIVE_OBSERVED_MINIMUM_NOT_COMPLETE_PROVIDER_METER",
  };
  return { status: errors.length ? "BLOCKED" as const : "READY" as const, errors, obligations, resourceConstraints,
    manifest, populationDigest: organizationDigest(manifest), lostLiabilitiesDropped: false };
}
