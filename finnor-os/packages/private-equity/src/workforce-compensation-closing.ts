import type { PoolClient } from "pg";
import { z } from "zod";
import {
  ClosingObservationSchema, ClosingOwnerRefSchema, ClosingSpecSchema,
  type AllocationEnvelope, type AllocationOutstandingCommitment, type ClosingOwnerRef, type ExperimentRef,
} from "@finnor/shared-types";
import { allocationDerivedQuantity, allocationRef, sameAllocationRef } from "../../epistemic-runtime/src/allocation-contracts";
import { workforceTermsSchema } from "../../workforce/src/execution-program/schema";
import { ClosingProfileSchema } from "./closing/contracts";
import { closingCanonical, closingDigest } from "./closing/compiler";
import { verifyClosingObservation } from "./closing/store";
import type { PeMutationContext } from "./types";

const Ref = ClosingOwnerRefSchema.omit({ kind: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const quantity = (value: string) => allocationDerivedQuantity(
  value.includes("/") && !value.startsWith("r3q:") ? "r3q:" + value : value);
const text = (value: ReturnType<typeof quantity>) => value.d === 1n ? String(value.n) : `r3q:${value.n}/${value.d}`;
function fail(code: string): never { throw Object.assign(new Error(code), { code, status: 409 }); }

const PromiseSchema = z.object({
  schema: z.literal("finnor.s5.workforce-compensation-obligation.v1"), ref: Ref,
  tenantId: z.string().uuid(), principalId: z.string().uuid(), workId: z.string().uuid(),
  rootId: z.string().uuid(), programmeId: z.string().uuid(), assignmentId: z.string(),
  payeePrincipalId: z.string().uuid(), termsDigest: digest, offeredTerms: workforceTermsSchema,
  acceptedAt: z.string().datetime({ offset: true }), dispositionEventId: z.string(), dispositionRef: Ref,
  originalBudget: Ref, originalReservation: Ref, status: z.literal("OPEN"),
  mapping: z.object({ amount: z.object({ value: z.string(), currency: z.literal("USD") }).strict(),
    resourceRef: Ref, resourceId: z.string(), resourceUnit: z.enum(["USD", "microUSD"]),
    resourceAmount: z.string(), resourcePeriod: z.literal(0), originalReservation: Ref }).passthrough(),
}).passthrough();
const LinkSchema = z.object({
  schema: z.literal("finnor.s5.workforce-closing-payment.v1"), ref: Ref,
  tenantId: z.string().uuid(), principalId: z.string().uuid(), programmeId: z.string().uuid(),
  workId: z.string().uuid(), assignmentId: z.string(), obligationRef: Ref,
  originalBudget: Ref, originalReservation: Ref, termsDigest: digest,
  closingProgrammeId: z.string().uuid(), closingSpecDigest: digest, closingNodeKey: z.string(),
  consumptionRef: Ref, financialReservation: Ref, effectRef: Ref,
  evidenceVersionId: z.string().uuid(), evidenceContentHash: digest,
  checkId: z.string().uuid(), checkCutDigest: digest, at: z.string().datetime({ offset: true }),
  resourceId: z.string(), resourceUnit: z.enum(["USD", "microUSD"]), resourceAmount: z.string(),
  resourcePeriod: z.literal(0), environment: z.enum(["DEVELOPMENT", "LIVE"]),
  accounting: z.literal("ONE_ORIGINAL_FINANCIAL_CONSUMPTION"),
  rootCapacityReplenished: z.literal(false), independentGrantCreated: z.literal(false),
}).strict();
export type WorkforceClosingPayment = z.infer<typeof LinkSchema>;
const CheckSchema = z.object({
  schema: z.literal("finnor.independent-close-check.v1"), specDigest: digest,
  checkedAt: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }),
  reasons: z.array(z.string()),
  acceptedEvidence: z.array(z.object({ requirementKey: z.string(), kind: z.string(),
    ref: z.object({ versionId: z.string().uuid() }).passthrough() }).passthrough()),
  verifiedOperationSettlements: z.array(z.object({ businessEffectId: z.string().uuid(), operationKey: z.string(),
    originalSpecDigest: digest, ref: z.object({ sourceId: z.string().uuid(), versionId: z.string().uuid(),
      versionNumber: z.number().int().positive(), contentHash: digest, snapshotHash: digest }).strict() }).strict()),
}).passthrough();

async function originalPromise(c: PoolClient, tenantId: string, reference: ExperimentRef) {
  const row = (await c.query(`SELECT h.body,b.body budget
    FROM finnor_os.s5_history h JOIN finnor_os.s5_history b
      ON b.tenant_id=h.tenant_id AND b.subject_id=h.body->'originalReservation'->>'id' AND b.operation='WORKFORCE_BUDGET'
    WHERE h.tenant_id=$1 AND h.subject_id=$2 AND h.operation='WORKFORCE_COMPENSATION_ACCEPTANCE'`,
  [tenantId, reference.id])).rows[0];
  if (!row) return null;
  const parsed = PromiseSchema.safeParse(row.body);
  if (!parsed.success) fail("WORKFORCE_CLOSING_PROMISE_PREIMAGE_INVALID");
  const promise = parsed.data, { ref, ...body } = promise;
  const { ref: budgetRef, ...budgetBody } = row.budget;
  if (!sameAllocationRef(ref, reference) || promise.tenantId !== tenantId ||
      promise.principalId !== row.budget.principalId || promise.workId !== row.budget.workId || promise.rootId !== row.budget.workId ||
      promise.programmeId !== row.budget.programmeId ||
      !sameAllocationRef(ref, allocationRef("S5", "workforce-compensation-obligation", body, "s5-workforce-v1")) ||
      !sameAllocationRef(budgetRef, allocationRef("S5", "workforce-budget", budgetBody, "s5-workforce-v1")) ||
      !sameAllocationRef(promise.originalBudget, row.budget.ref) ||
      !sameAllocationRef(promise.originalReservation, row.budget.reservationRef) ||
      !sameAllocationRef(promise.mapping.originalReservation, promise.originalReservation) ||
      quantity(promise.mapping.amount.value).compare(quantity(promise.offeredTerms.compensation.value)) !== 0 ||
      promise.offeredTerms.compensation.unit !== promise.mapping.amount.currency)
    fail("WORKFORCE_CLOSING_PROMISE_PREIMAGE_CHANGED");
  return { promise, budget: row.budget };
}

async function paymentSource(c: PoolClient, tenantId: string, programmeId: string, effectId: string, versionId: string) {
  const rows = (await c.query(`SELECT q.id,q.tenant_id,q.transaction_id,q.principal_id,q.spec,q.spec_digest,
      q.approved_terms_revision,q.profile_digest,q.last_check_id,q.status,
      p.body profile,p.status profile_status,p.digest profile_content_digest,p.valid_until profile_valid_until,
      l.node_key,l.consumption_ref,e.semantic_hash,o.verification_status,o.observation,
      co.body consumption,st.status consumption_status,st.effect_ref,v.id evidence_version_id,
      ro.body financial_origin,r.status reservation_status,r.envelopes financial_envelopes,
      v.content,v.content_hash,v.snapshot
    FROM finnor_os.pe_closing_programmes q
    JOIN finnor_os.pe_closing_profiles p ON p.tenant_id=q.tenant_id AND p.id=q.profile_id
    JOIN finnor_os.pe_closing_node_links l ON l.tenant_id=q.tenant_id AND l.programme_id=q.id
    JOIN finnor_os.business_effects e ON e.tenant_id=l.tenant_id AND e.id=l.business_effect_id
    JOIN finnor_os.external_operations o ON o.tenant_id=e.tenant_id AND o.business_effect_id=e.id
    JOIN finnor_os.s5_consumptions co ON co.tenant_id=q.tenant_id AND co.consumption_id=l.consumption_ref->>'id'
    JOIN finnor_os.s5_consumption_states st ON st.tenant_id=co.tenant_id AND st.consumption_id=co.consumption_id
    JOIN finnor_os.s5_reservation_origins ro ON ro.tenant_id=co.tenant_id AND ro.reservation_id=co.reservation_id
    JOIN finnor_os.s5_reservations r ON r.tenant_id=ro.tenant_id AND r.reservation_id=ro.reservation_id
    JOIN finnor_os.evidence_source_versions v ON v.tenant_id=q.tenant_id AND v.id=$4
    JOIN finnor_os.pe_closing_evidence_bindings b ON b.tenant_id=q.tenant_id AND b.programme_id=q.id AND b.source_id=v.source_id
    WHERE q.tenant_id=$1 AND q.id=$2 AND e.id=$3 AND o.provider='finnor_closing_provider' LIMIT 2`,
  [tenantId, programmeId, effectId, versionId])).rows;
  if (rows.length !== 1) return null;
  const row = rows[0], spec = ClosingSpecSchema.parse(row.spec), profile = ClosingProfileSchema.parse(row.profile);
  const observation = ClosingObservationSchema.parse(row.snapshot?.closingObservation);
  const step = spec.steps.find(step => step.key === row.node_key);
  const flow = spec.fundsFlows.find(flow => flow.key === step?.requirementKey);
  const provider = profile.providers.find(provider => provider.id === step?.providerProfileId);
  const { admission: _admission, ...profileBody } = profile;
  const { ref: consumptionRef, ...consumptionBody } = row.consumption;
  const { ref: reservationRef, ...reservationBody } = row.financial_origin;
  const strip = (r: ClosingOwnerRef) => ({ owner: r.owner, id: r.id, version: r.version, contentDigest: r.contentDigest });
  if (!step || step.kind !== "PAY_FUNDS" || !flow?.workforceCompensation || !provider ||
      spec.tenantId !== tenantId || closingDigest(spec) !== row.spec_digest ||
      closingDigest(profileBody) !== row.profile_digest || row.profile_content_digest !== row.profile_digest ||
      !provider.observationIssuerIds.includes(observation.issuerId) ||
      observation.kind !== "RECEIVING_SETTLEMENT" || observation.status !== "CONFIRMED" ||
      observation.requirementKey !== flow.key || observation.predicateDigest !== flow.evidence.predicateDigest ||
      !flow.evidence.issuerIds.includes(observation.issuerId) || !flow.evidence.channels.includes(observation.channel) ||
      row.content !== closingCanonical(observation) || closingDigest(row.content) !== row.content_hash ||
      observation.claims.businessEffectId !== effectId || observation.claims.operationKey !== flow.operationKey ||
      observation.claims.receivingState !== "SETTLED_RECEIVED" ||
      observation.claims.payerEntityId !== flow.payerEntityId ||
      observation.claims.receivingEntityId !== flow.receivingEntityId || observation.claims.accountDigest !== flow.receivingAccountDigest ||
      closingCanonical(observation.claims.workforceCompensation ?? null) !== closingCanonical(flow.workforceCompensation) ||
      closingCanonical(observation.claims.money ?? null) !== closingCanonical(flow.money) || flow.money.entityId !== flow.payerEntityId ||
      row.consumption_status !== "RECONCILED" || row.reservation_status === "RELEASED" ||
      !sameAllocationRef(consumptionRef, allocationRef("S5", "allocation-consumption", consumptionBody)) ||
      !sameAllocationRef(reservationRef, allocationRef("S5", "allocation-reservation", reservationBody)) ||
      !sameAllocationRef(row.consumption.reservationRef, reservationRef) ||
      !step.allocationRef || !sameAllocationRef(strip(step.allocationRef), row.consumption.certificateRef) ||
      row.consumption.principalId !== flow.workforceCompensation.payerPrincipalId ||
      row.effect_ref?.id !== effectId || row.effect_ref.contentDigest !== row.semantic_hash ||
      !sameAllocationRef({ owner: row.consumption_ref.owner, id: row.consumption_ref.id,
        version: row.consumption_ref.version, contentDigest: row.consumption_ref.contentDigest }, row.consumption.ref) ||
      !sameAllocationRef(row.consumption_ref.reservationRef && {
        owner: row.consumption_ref.reservationRef.owner, id: row.consumption_ref.reservationRef.id,
        version: row.consumption_ref.reservationRef.version, contentDigest: row.consumption_ref.reservationRef.contentDigest,
      }, row.financial_origin.ref)) return null;
  verifyClosingObservation(observation, profile, { tenant_id: tenantId, transaction_id: row.transaction_id,
    spec_digest: row.spec_digest, approved_terms_revision: row.approved_terms_revision, spec }, true);
  return { row, spec, profile, step, flow, observation };
}

async function currentReceipt(c: PoolClient, tenantId: string, source: NonNullable<Awaited<ReturnType<typeof paymentSource>>>) {
  const { row, spec, profile, flow } = source;
  if (row.profile_status !== "ACTIVE" || Date.parse(row.profile_valid_until) <= Date.now() ||
      row.verification_status !== "verified" || row.observation?.closingEvidenceRef?.versionId !== row.evidence_version_id)
    return null;
  const check = (await c.query(`SELECT ch.id,ch.body,ch.checker_digest,ch.observation_cut_digest,ch.valid_until,
      (ch.observation_cut_digest=finnor_os.pe_closing_cut_digest($1,$2) OR EXISTS(
        SELECT 1 FROM finnor_os.pe_closed_transaction_certificates cert JOIN finnor_os.pe_deals d
          ON d.tenant_id=cert.tenant_id AND d.id=cert.transaction_id
        WHERE cert.tenant_id=$1 AND cert.programme_id=$2 AND cert.body->'receiptAndCurrentness'->>'checkId'=ch.id::text
          AND cert.post_publication_cut_digest=finnor_os.pe_closing_cut_digest($1,$2) AND d.status='closed')) current
    FROM finnor_os.pe_closing_checks ch WHERE ch.tenant_id=$1 AND ch.programme_id=$2 AND ch.id=$3
      AND ch.spec_digest=$4 AND ch.valid_until>clock_timestamp()`,
  [tenantId, row.id, row.last_check_id, row.spec_digest])).rows[0];
  const parsed = CheckSchema.safeParse(check?.body);
  if (!check?.current || !parsed.success || check.checker_digest !== profile.checkerDigest ||
      parsed.data.specDigest !== row.spec_digest || parsed.data.reasons.some(reason => [
        "CURRENT_WORK_INPUT_CHANGED", "APPROVED_TERMS_CHANGED", "DEPENDENCIES_CHANGED", "AUTHORITY_CHANGED",
        "APPROVED_DOCUMENT_BYTES_OR_CURRENT_VERSION_CHANGED", "PROFILE_CURRENTNESS_OR_ENVIRONMENT_UNPASSED",
      ].includes(reason))) return null;
  const proof = parsed.data.verifiedOperationSettlements.find(proof => proof.businessEffectId === source.observation.claims.businessEffectId
    && proof.operationKey === source.step.key && proof.originalSpecDigest === row.spec_digest
    && proof.ref.contentHash === row.content_hash);
  const beneficiary = spec.beneficiaries.find(b => b.key === flow.beneficiaryRequirementKey && b.required
    && b.legalEntityId === flow.receivingEntityId && b.accountDigest === flow.receivingAccountDigest);
  const roles = (await c.query(`SELECT to_jsonb(a) assignment,to_jsonb(r) definition
    FROM finnor_os.employee_role_assignments a JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id
    JOIN finnor_os.users u ON u.tenant_id=a.tenant_id AND u.id=a.employee_id AND u.status='active'
    WHERE a.tenant_id=$1 AND a.id=ANY($2::uuid[])`, [tenantId, profile.roleBindings.map(binding => binding.assignmentId)])).rows;
  const role = (id: string, entity: string) => profile.roleBindings.some(binding => binding.principalId === id && binding.legalEntityIds.includes(entity)
    && roles.some(({ assignment, definition }) => {
      const scope = assignment.resource_scope;
      return assignment.id === binding.assignmentId && assignment.employee_id === id && assignment.active && definition.active
        && closingDigest(assignment) === binding.assignmentDigest && closingDigest(definition) === binding.roleDefinitionDigest
        && Date.parse(assignment.effective_from) <= Date.now() && (!assignment.expires_at || Date.parse(assignment.expires_at) > Date.now())
        && (scope?.kind === "tenant" || scope?.kind === "resources" && (!scope.resourceType || ["*", "pe_deal"].includes(scope.resourceType))
          && scope.resourceIds?.includes(spec.transactionId));
    }));
  if (!proof || !beneficiary || !parsed.data.acceptedEvidence.some(e => e.requirementKey === beneficiary.key && e.kind === "BENEFICIARY_VALIDATED") ||
      !parsed.data.acceptedEvidence.some(e => e.requirementKey === flow.key && e.kind === "RECEIVING_SETTLEMENT" && e.ref.versionId === proof.ref.versionId) ||
      !role(flow.workforceCompensation!.payerPrincipalId, flow.payerEntityId) ||
      !role(flow.workforceCompensation!.payeePrincipalId, flow.receivingEntityId)) return null;
  return { check, proof };
}

export async function recordWorkforceClosingPaymentsTx(ctx: PeMutationContext, c: PoolClient, programmeId: string) {
  const q = (await c.query("SELECT spec,principal_id FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND id=$2",
    [ctx.auth.tenantId, programmeId])).rows[0];
  if (!q) return;
  const spec = ClosingSpecSchema.parse(q.spec);
  for (const flow of spec.fundsFlows) {
    const binding = flow.workforceCompensation;
    if (!binding) continue;
    const original = await originalPromise(c, ctx.auth.tenantId, binding.obligationRef);
    if (!original) continue;
    const { promise } = original;
    const native = (await c.query(`SELECT p.original,p.principal_id,p.work_id,e.body disposition
      FROM finnor_os.w2_programs p JOIN finnor_os.w2_events e
        ON e.tenant_id=p.tenant_id AND e.program_id=p.id AND e.event_id=$3 AND e.kind='DISPOSITION'
      WHERE p.tenant_id=$1 AND p.id=$2`, [ctx.auth.tenantId, promise.programmeId, promise.dispositionEventId])).rows[0];
    if (!native || native.principal_id !== promise.principalId || native.work_id !== promise.workId ||
        native.disposition.observation?.decision !== "ACCEPT" ||
        !sameAllocationRef(native.disposition.observation.ref, promise.dispositionRef) ||
        native.disposition.observation.termsDigest !== promise.termsDigest ||
        native.disposition.observation.assignmentId !== promise.assignmentId)
      fail("WORKFORCE_CLOSING_ORIGINAL_ACCEPTANCE_REQUIRED");
    if (binding.payerPrincipalId !== promise.principalId || binding.payeePrincipalId !== promise.payeePrincipalId ||
        q.principal_id !== promise.principalId || promise.principalId !== (ctx.auth.employeeId ?? ctx.auth.userId) ||
        binding.programmeId !== promise.programmeId || binding.workId !== promise.workId || binding.originalRoot !== promise.rootId ||
        binding.assignmentId !== promise.assignmentId || binding.termsDigest !== promise.termsDigest ||
        !sameAllocationRef(binding.originalBudget, promise.originalBudget) || !sameAllocationRef(binding.originalReservation, promise.originalReservation) ||
        flow.money.currency !== promise.mapping.amount.currency || quantity(flow.money.amount).compare(quantity(promise.mapping.amount.value)) !== 0 ||
        !(spec.environment === "DEVELOPMENT" && native.original.sourceClass === "CONTROLLED_ACTOR_RECORDS" || spec.environment === "LIVE")) continue;
    const steps = spec.steps.filter(step => step.kind === "PAY_FUNDS" && step.requirementKey === flow.key);
    if (steps.length !== 1) continue;
    const operation = (await c.query(`SELECT l.business_effect_id,o.observation->'closingEvidenceRef'->>'versionId' evidence_version_id
      FROM finnor_os.pe_closing_node_links l JOIN finnor_os.external_operations o
        ON o.tenant_id=l.tenant_id AND o.business_effect_id=l.business_effect_id
      WHERE l.tenant_id=$1 AND l.programme_id=$2 AND l.node_key=$3 AND o.provider='finnor_closing_provider'`,
    [ctx.auth.tenantId, programmeId, steps[0]!.key])).rows[0];
    if (!operation?.evidence_version_id) continue;
    const source = await paymentSource(c, ctx.auth.tenantId, programmeId, operation.business_effect_id, operation.evidence_version_id);
    if (!source) continue;
    const receipt = await currentReceipt(c, ctx.auth.tenantId, source);
    if (!receipt || receipt.proof.ref.versionId !== operation.evidence_version_id ||
        Date.parse(source.observation.observedAt) < Date.parse(promise.acceptedAt)) continue;
    const resource = original.budget.resources.find((r: { resourceId: string }) => r.resourceId === promise.mapping.resourceId);
    const bound = source.step.resourceBindings.find(b => sameAllocationRef(
      { owner: b.resourceRef.owner, id: b.resourceRef.id, version: b.resourceRef.version, contentDigest: b.resourceRef.contentDigest }, promise.mapping.resourceRef));
    if (!resource || resource.resourceClass !== "CASH" || resource.currency !== "USD" || !bound || bound.unit !== promise.mapping.resourceUnit ||
        quantity(bound.quantity).compare(quantity(promise.mapping.resourceAmount)) !== 0 ||
        !sameAllocationRef(resource.ref, promise.mapping.resourceRef)) continue;
    const prior = (await c.query(`SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1
      AND operation='WORKFORCE_CLOSING_PAYMENT' AND (body->'obligationRef'->>'id'=$2 OR body->'effectRef'->>'id'=$3) LIMIT 2`,
    [ctx.auth.tenantId, promise.ref.id, operation.business_effect_id])).rows;
    if (prior.length) {
      if (prior.length !== 1 || !sameAllocationRef(prior[0].body.obligationRef, promise.ref) ||
          prior[0].body.effectRef.id !== operation.business_effect_id) fail("WORKFORCE_CLOSING_PAYMENT_ALREADY_ASSIGNED");
      continue;
    }
    const body = { schema: "finnor.s5.workforce-closing-payment.v1" as const,
      tenantId: ctx.auth.tenantId, principalId: promise.principalId, programmeId: promise.programmeId,
      workId: promise.workId, assignmentId: promise.assignmentId, obligationRef: promise.ref,
      originalBudget: promise.originalBudget, originalReservation: promise.originalReservation, termsDigest: promise.termsDigest,
      closingProgrammeId: programmeId, closingSpecDigest: source.row.spec_digest, closingNodeKey: source.step.key,
      consumptionRef: source.row.consumption.ref, financialReservation: source.row.financial_origin.ref,
      effectRef: source.row.effect_ref, evidenceVersionId: operation.evidence_version_id, evidenceContentHash: source.row.content_hash,
      checkId: receipt.check.id, checkCutDigest: receipt.check.observation_cut_digest, at: source.observation.observedAt,
      resourceId: promise.mapping.resourceId, resourceUnit: promise.mapping.resourceUnit,
      resourceAmount: promise.mapping.resourceAmount, resourcePeriod: 0 as const, environment: spec.environment,
      accounting: "ONE_ORIGINAL_FINANCIAL_CONSUMPTION" as const, rootCapacityReplenished: false as const, independentGrantCreated: false as const };
    const link = LinkSchema.parse({ ...body, ref: allocationRef("S5", "workforce-closing-payment", body, "s5-workforce-v1") });
    await c.query(`INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body)
      VALUES($1,$2,1,'WORKFORCE_CLOSING_PAYMENT',$3::jsonb)`, [ctx.auth.tenantId, link.ref.id, JSON.stringify(link)]);
  }
}

export async function readWorkforceClosingPaymentsTx(c: PoolClient, tenantId: string, programmeId?: string) {
  const rows = (await c.query(`SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND operation='WORKFORCE_CLOSING_PAYMENT'
    AND ($2::text IS NULL OR body->>'programmeId'=$2) ORDER BY subject_id LIMIT 8193`, [tenantId, programmeId ?? null])).rows;
  if (rows.length > 8192) fail("WORKFORCE_CLOSING_PAYMENT_PROFILE_INCOMPLETE");
  const links: WorkforceClosingPayment[] = [], effects = new Set<string>(), obligations = new Set<string>();
  for (const row of rows) {
    const link = LinkSchema.parse(row.body), { ref, ...body } = link;
    if (link.tenantId !== tenantId || !sameAllocationRef(ref, allocationRef("S5", "workforce-closing-payment", body, "s5-workforce-v1")) ||
        effects.has(link.effectRef.id) || obligations.has(link.obligationRef.id)) fail("WORKFORCE_CLOSING_PAYMENT_PREIMAGE_CHANGED");
    const original = await originalPromise(c, tenantId, link.obligationRef);
    const source = await paymentSource(c, tenantId, link.closingProgrammeId, link.effectRef.id, link.evidenceVersionId);
    const historicalCheck = (await c.query(`SELECT body,spec_digest,observation_cut_digest FROM finnor_os.pe_closing_checks
      WHERE tenant_id=$1 AND programme_id=$2 AND id=$3`, [tenantId, link.closingProgrammeId, link.checkId])).rows[0];
    const checked = CheckSchema.safeParse(historicalCheck?.body);
    if (!original || !source || !sameAllocationRef(original.promise.originalBudget, link.originalBudget) ||
        !sameAllocationRef(original.promise.originalReservation, link.originalReservation) ||
        original.promise.assignmentId !== link.assignmentId || original.promise.termsDigest !== link.termsDigest ||
        original.promise.mapping.resourceId !== link.resourceId || original.promise.mapping.resourceUnit !== link.resourceUnit ||
        original.promise.mapping.resourceAmount !== link.resourceAmount ||
        !sameAllocationRef(source.row.consumption.ref, link.consumptionRef) ||
        !sameAllocationRef(source.row.financial_origin.ref, link.financialReservation) ||
        !sameAllocationRef(source.row.effect_ref, link.effectRef) || source.row.content_hash !== link.evidenceContentHash ||
        !checked.success || historicalCheck.spec_digest !== link.closingSpecDigest || historicalCheck.observation_cut_digest !== link.checkCutDigest ||
        !checked.data.verifiedOperationSettlements.some(proof => proof.businessEffectId === link.effectRef.id && proof.operationKey === link.closingNodeKey
          && proof.originalSpecDigest === link.closingSpecDigest && proof.ref.versionId === link.evidenceVersionId && proof.ref.contentHash === link.evidenceContentHash))
      fail("WORKFORCE_CLOSING_PAYMENT_ORIGINAL_CONSUMPTION_CHANGED");
    links.push(link); effects.add(link.effectRef.id); obligations.add(link.obligationRef.id);
  }
  return links;
}

export async function currentWorkforceClosingPaymentTx(c: PoolClient, tenantId: string, link: WorkforceClosingPayment) {
  const source = await paymentSource(c, tenantId, link.closingProgrammeId, link.effectRef.id, link.evidenceVersionId);
  if (!source) return null;
  const current = await currentReceipt(c, tenantId, source);
  return current?.proof.ref.versionId === link.evidenceVersionId ? { ...link, currentCheckId: current.check.id } : null;
}

export async function workforceAccountingFrontierTx(c: PoolClient, tenantId: string, outstanding: AllocationOutstandingCommitment[]) {
  const result = structuredClone(outstanding);
  for (const link of await readWorkforceClosingPaymentsTx(c, tenantId)) {
    const original = result.find(r => sameAllocationRef(r.reservationRef, link.originalReservation));
    const financial = result.find(r => sameAllocationRef(r.reservationRef, link.financialReservation));
    const coordinate = (e: AllocationEnvelope) => e.resourceId === link.resourceId && e.unit === link.resourceUnit;
    const held = original?.envelopes.find(coordinate), paid = financial?.envelopes.find(coordinate);
    if (!held || !paid || sameAllocationRef(link.originalReservation, link.financialReservation) ||
        !sameAllocationRef(held.horizon, paid.horizon) || held.kind !== paid.kind ||
        quantity(held.quantities[link.resourcePeriod] ?? "0").compare(quantity(link.resourceAmount)) < 0 ||
        quantity(paid.quantities[link.resourcePeriod] ?? "0").compare(quantity(link.resourceAmount)) < 0)
      fail("WORKFORCE_CLOSING_PAYMENT_FRONTIER_REQUIRED");
    held.quantities[link.resourcePeriod] = text(quantity(held.quantities[link.resourcePeriod]!).sub(quantity(link.resourceAmount)));
    held.minimumQuantities[link.resourcePeriod] = "0";
  }
  return result;
}
