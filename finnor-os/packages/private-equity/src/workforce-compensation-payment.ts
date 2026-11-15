/** W2 owned canonical outbound compensation payment path, up to the protected
 * S6 financial broker boundary and never past it. No qualified outbound
 * financial settlement provider is installed: this module prepares exact
 * obligation-bound payment requests, presents them to the boundary, and
 * records the boundary's durable UNADMITTED decision. It never authorizes a
 * financial transfer, never infers a payer legal entity or a payee receiving
 * account, and never rewrites the accepted S5 compensation obligation. */
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { z } from "zod";
import { allocationRef, sameAllocationRef } from "../../epistemic-runtime/src/allocation-contracts";
import { epistemicHash } from "../../epistemic-runtime/src/source-precedence";
import type { PeMutationContext } from "./types";

function fail(code: string): never { throw Object.assign(new Error(code), { code, status: 409 }); }
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const refSchema = z.object({ owner: z.string().min(1).max(128), id: z.string().min(1).max(512),
  version: z.string().min(1).max(128), contentDigest: hex }).strict();

export const workforceCompensationPaymentBindingSchema = z.object({
  schema: z.literal("finnor.s6.workforce-compensation-payment-binding.v1"),
  obligationRef: refSchema, originalRoot: z.string().uuid(), originalReservation: refSchema,
  programmeId: z.string().uuid(), workId: z.string().uuid(), assignmentId: z.string().min(1).max(256),
  amount: z.object({ value: z.string().min(1).max(64), currency: z.literal("USD") }).strict(),
  payeePrincipalId: z.string().uuid(),
  payer: z.object({ kind: z.literal("UNKNOWN"),
    reason: z.literal("CANONICAL_FINANCIAL_PAYER_LEGAL_ENTITY_NOT_INSTALLED") }).strict(),
  payeeReceiving: z.object({ kind: z.literal("UNKNOWN"),
    reason: z.literal("OWNER_PROVISIONED_PAYEE_RECEIVING_ENTITY_NOT_INSTALLED") }).strict(),
  termsDigest: hex, preparedAt: z.string().min(1).max(64), preparedByPrincipalId: z.string().uuid(),
  financialTransferAuthorized: z.literal(false), externalSettlementEstablished: z.literal(false),
  independentGrantCreated: z.literal(false), bindingDigest: hex }).strict();
export const workforceCompensationPrepareSchema = z.object({
  schema: z.literal("finnor.s6.workforce-compensation-payment-request.v1"),
  requestId: z.string().min(1).max(640), binding: workforceCompensationPaymentBindingSchema }).strict();
export type WorkforceCompensationPrepareRequest = z.infer<typeof workforceCompensationPrepareSchema>;

/** The broker-side durable refusal: content-addressed, before any credential
 * resolution or provider transport, and always UNADMITTED while no qualified
 * W2 outbound settlement provider exists. */
export function workforceCompensationBoundaryRefusal(request: WorkforceCompensationPrepareRequest) {
  const body = { schema: "finnor.s6.workforce-compensation-payment-refusal.v1" as const,
    reachedBoundary: "S6_FINANCIAL_BROKER" as const, admission: "UNADMITTED" as const,
    financialTransferAuthorized: false as const, settlementEstablished: false as const,
    requestId: request.requestId, obligationDigest: request.binding.obligationRef.contentDigest,
    reason: "NO_QUALIFIED_W2_OUTBOUND_FINANCIAL_SETTLEMENT_PROVIDER_INSTALLED" as const,
    providerTransportAttempted: false as const, credentialsResolved: false as const,
    at: new Date().toISOString(), retryPermitted: false as const };
  return { ...body, refusalDigest: epistemicHash(body) };
}

export interface WorkforceCompensationBoundaryObservation {
  schema: "finnor.s6.workforce-compensation-boundary-observation.v1";
  requestId: string; reachedBoundary: "S6_FINANCIAL_BROKER"; admission: "UNADMITTED";
  financialTransferAuthorized: false; brokerContacted: boolean;
  transport: "NO_INSTALLED_QUALIFIED_BROKER" | "BROKER_ORIGIN_NOT_LOOPBACK_REFUSED"
    | "BROKER_UNREACHABLE" | "BROKER_DURABLE_REFUSAL" | "BROKER_REPLY_NOT_A_DURABLE_REFUSAL";
  reason: string; refusalDigest: string | null; at: string; retryPermitted: false;
}

/** W2-side boundary gate. The request always reaches the S6 financial broker
 * boundary decision and is never admitted: without a configured loopback
 * broker the W2 perimeter gate itself halts the request; with one, only the
 * broker's exact durable content-addressed refusal is accepted. Any other
 * reply is recorded as a boundary fault, still UNADMITTED. */
export async function admitWorkforceCompensationAtFinancialBrokerBoundary(
  request: WorkforceCompensationPrepareRequest): Promise<WorkforceCompensationBoundaryObservation> {
  const at = new Date().toISOString();
  const base = process.env.FINNOR_W2_COMPENSATION_BROKER_URL, tokenFile = process.env.FINNOR_W2_COMPENSATION_BROKER_TOKEN_FILE;
  const halt = (transport: WorkforceCompensationBoundaryObservation["transport"], reason: string,
    brokerContacted: boolean, refusalDigest: string | null): WorkforceCompensationBoundaryObservation => ({
    schema: "finnor.s6.workforce-compensation-boundary-observation.v1", requestId: request.requestId,
    reachedBoundary: "S6_FINANCIAL_BROKER", admission: "UNADMITTED", financialTransferAuthorized: false,
    brokerContacted, transport, reason, refusalDigest, at, retryPermitted: false });
  if (!base || !tokenFile)
    return halt("NO_INSTALLED_QUALIFIED_BROKER", "NO_QUALIFIED_W2_OUTBOUND_FINANCIAL_SETTLEMENT_PROVIDER_INSTALLED", false, null);
  let origin: URL;
  try { origin = new URL(base); } catch { return halt("BROKER_ORIGIN_NOT_LOOPBACK_REFUSED", "W2_BROKER_ORIGIN_INVALID", false, null); }
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(origin.hostname))
    return halt("BROKER_ORIGIN_NOT_LOOPBACK_REFUSED", "W2_BROKER_ORIGIN_MUST_BE_LOOPBACK_HTTP", false, null);
  let token: string;
  try { token = (await readFile(tokenFile, "utf8")).trim(); } catch {
    return halt("NO_INSTALLED_QUALIFIED_BROKER", "W2_BROKER_CALLER_CREDENTIAL_UNAVAILABLE", false, null); }
  try {
    const response = await fetch(new URL("/workforce-compensation/prepare", origin), {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(request), signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || !body || body.schema !== "finnor.s6.workforce-compensation-payment-refusal.v1" ||
        body.requestId !== request.requestId || body.admission !== "UNADMITTED" ||
        body.financialTransferAuthorized !== false || body.settlementEstablished !== false ||
        body.providerTransportAttempted !== false || body.credentialsResolved !== false ||
        typeof body.refusalDigest !== "string") {
      const { refusalDigest: _ignored, ...rest } = body ?? {};
      void _ignored;
      return halt("BROKER_REPLY_NOT_A_DURABLE_REFUSAL", "W2_BROKER_REPLY_REJECTED_NOT_AN_ADMISSION", true,
        body && typeof rest === "object" ? epistemicHash(rest) : null);
    }
    const { refusalDigest, ...preimage } = body as Record<string, unknown>;
    if (epistemicHash(preimage) !== refusalDigest)
      return halt("BROKER_REPLY_NOT_A_DURABLE_REFUSAL", "W2_BROKER_REFUSAL_DIGEST_MISMATCH", true, null);
    return halt("BROKER_DURABLE_REFUSAL", String(body.reason), true, refusalDigest);
  } catch {
    return halt("BROKER_UNREACHABLE", "W2_BROKER_TRANSPORT_FAILED_REQUEST_NEVER_ADMITTED", false, null);
  }
}

/** The request row is created once per exact obligation (unique obligation
 * digest) and never mutated; preparation of the same obligation replays. */
export async function ensureWorkforceCompensationPaymentRequestTx(ctx: PeMutationContext, c: PoolClient,
  programme: { id: string; principal_id: string; work_id: string },
  obligation: { ref: { owner: string; id: string; version: string; contentDigest: string };
    originalReservation: { owner: string; id: string; version: string; contentDigest: string };
    assignmentId: string; payeePrincipalId: string; termsDigest: string;
    mapping: { amount: { value: string; currency: string } } }) {
  if (obligation.mapping.amount.currency !== "USD") fail("WORKFORCE_S6_PAYMENT_EXACT_CURRENCY_UNSUPPORTED");
  const requestId = "w2pay:" + obligation.ref.contentDigest;
  const prior = (await c.query(`SELECT body FROM finnor_os.s5_workforce_payment_requests
    WHERE tenant_id=$1 AND obligation_digest=$2`, [ctx.auth.tenantId, obligation.ref.contentDigest])).rows[0];
  if (prior) {
    if (prior.body?.requestId !== requestId || prior.body?.binding?.obligationRef?.contentDigest !== obligation.ref.contentDigest)
      fail("WORKFORCE_S6_PAYMENT_PREPARATION_IDEMPOTENCY_CONFLICT");
    const observation = (await c.query(`SELECT observation_id FROM finnor_os.s5_workforce_payment_observations
      WHERE tenant_id=$1 AND request_id=$2 LIMIT 1`, [ctx.auth.tenantId, requestId])).rows[0];
    return { requestId, obligationDigest: obligation.ref.contentDigest, bindingDigest: prior.body.binding.bindingDigest as string,
      request: prior.body as unknown as WorkforceCompensationPrepareRequest, created: false, awaitingBoundary: !observation };
  }
  const bindingPreimage = { schema: "finnor.s6.workforce-compensation-payment-binding.v1" as const,
    obligationRef: obligation.ref, originalRoot: programme.work_id, originalReservation: obligation.originalReservation,
    programmeId: programme.id, workId: programme.work_id, assignmentId: obligation.assignmentId,
    amount: { value: obligation.mapping.amount.value, currency: "USD" as const },
    payeePrincipalId: obligation.payeePrincipalId,
    payer: { kind: "UNKNOWN" as const, reason: "CANONICAL_FINANCIAL_PAYER_LEGAL_ENTITY_NOT_INSTALLED" as const },
    payeeReceiving: { kind: "UNKNOWN" as const, reason: "OWNER_PROVISIONED_PAYEE_RECEIVING_ENTITY_NOT_INSTALLED" as const },
    termsDigest: obligation.termsDigest, preparedAt: new Date().toISOString(),
    preparedByPrincipalId: programme.principal_id, financialTransferAuthorized: false as const,
    externalSettlementEstablished: false as const, independentGrantCreated: false as const };
  const binding = { ...bindingPreimage, bindingDigest: epistemicHash(bindingPreimage) };
  const request: WorkforceCompensationPrepareRequest = {
    schema: "finnor.s6.workforce-compensation-payment-request.v1", requestId, binding };
  workforceCompensationPrepareSchema.parse(request);
  await c.query(`INSERT INTO finnor_os.s5_workforce_payment_requests(tenant_id,request_id,programme_id,obligation_digest,body)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [ctx.auth.tenantId, requestId, programme.id, obligation.ref.contentDigest,
    JSON.stringify(request)]);
  return { requestId, obligationDigest: obligation.ref.contentDigest, bindingDigest: binding.bindingDigest,
    request, created: true, awaitingBoundary: true };
}

/** First boundary decision stands. A superseding observation requires a
 * qualified settlement proof that does not exist yet, so duplicates are
 * refused by identity rather than appended by a producer's clock. */
export async function recordWorkforceCompensationBoundaryObservationTx(ctx: PeMutationContext, c: PoolClient,
  dispatch: { requestId: string; obligationDigest: string }, observation: WorkforceCompensationBoundaryObservation) {
  if (observation.schema !== "finnor.s6.workforce-compensation-boundary-observation.v1" ||
      observation.requestId !== dispatch.requestId || observation.reachedBoundary !== "S6_FINANCIAL_BROKER" ||
      observation.admission !== "UNADMITTED" || observation.financialTransferAuthorized !== false ||
      observation.retryPermitted !== false)
    fail("WORKFORCE_S6_PAYMENT_BOUNDARY_OBSERVATION_NOT_A_DURABLE_REFUSAL");
  const observationId = "w2pay-boundary:" + dispatch.obligationDigest;
  const result = await c.query(`INSERT INTO finnor_os.s5_workforce_payment_observations(tenant_id,observation_id,request_id,body)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`, [ctx.auth.tenantId, observationId, dispatch.requestId,
    JSON.stringify(observation)]);
  return (result.rowCount ?? 0) === 1;
}

/** A paid machine assignment whose payee is the accountable principal itself
 * is an internal counter-entry of one sovereign budget, never an outbound
 * payment. Discharging it is a durable accounting observation: no cash moves,
 * no external settlement is claimed, and the accepted obligation record stays
 * byte-identical with status OPEN in its own history. */
export async function recordWorkforceCompensationInternalDischargeTx(ctx: PeMutationContext, c: PoolClient,
  obligation: { ref: { owner: string; id: string; version: string; contentDigest: string };
    tenantId: string; principalId: string; workId: string; rootId: string; programmeId: string;
    assignmentId: string; actorId: string; payeePrincipalId: string; termsDigest: string;
    acceptedAt: string; mapping: { amount: { value: string; currency: string } } }) {
  if (obligation.payeePrincipalId !== obligation.principalId)
    fail("WORKFORCE_S5_COMPENSATION_INTERNAL_DISCHARGE_REQUIRES_SELF_OBLIGATION");
  const prior = (await c.query(`SELECT body FROM finnor_os.s5_history
    WHERE tenant_id=$1 AND operation='WORKFORCE_COMPENSATION_SETTLEMENT' AND body->'settlementOf'->>'id'=$2`,
  [ctx.auth.tenantId, obligation.ref.id])).rows[0]?.body;
  const at = new Date().toISOString();
  const body = { schema: "finnor.s5.workforce-compensation-settlement.v1" as const, tenantId: ctx.auth.tenantId,
    settlementOf: obligation.ref, obligationDigest: obligation.ref.contentDigest,
    programmeId: obligation.programmeId, workId: obligation.workId, rootId: obligation.rootId,
    assignmentId: obligation.assignmentId, actorId: obligation.actorId,
    payerPrincipalId: obligation.principalId, payeePrincipalId: obligation.payeePrincipalId,
    amount: obligation.mapping.amount, termsDigest: obligation.termsDigest, acceptedAt: obligation.acceptedAt,
    kind: "INTERNAL_SELF_OBLIGATION_DISCHARGE" as const,
    basis: "PAYER_AND_PAYEE_ARE_THE_SAME_ACCOUNTABLE_PRINCIPAL" as const,
    monetaryMovement: "NONE_INTERNAL_COUNTER_ENTRY" as const,
    financialTransferAuthorized: false as const, externalSettlementEstablished: false as const,
    realPayment: false as const, independentGrantCreated: false as const, at,
    dischargedBy: "W2_ACCOUNTABLE_WORKER_BOUNDED_PREPARATION" as const,
    qualification: "CONTROLLED_NATIVE_RECORDS_UNADMITTED" as const };
  const record = { ...body, ref: allocationRef("S5", "workforce-compensation-settlement", body, "s5-workforce-v1") };
  if (prior) {
    // The wall clock is the only permitted difference between replayed
    // discharges; identical logical content under a later clock is the same
    // discharge, so replay returns the durable original.
    const { ref: _priorRef, at: _priorAt, ...logicalPrior } = prior;
    const { at: _bodyAt, ...logicalBody } = body;
    void _priorRef; void _priorAt; void _bodyAt;
    if (epistemicHash(logicalPrior) !== epistemicHash(logicalBody)) fail("WORKFORCE_S5_COMPENSATION_SETTLEMENT_IDEMPOTENCY_CONFLICT");
    return null;
  }
  await c.query(`INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body)
    VALUES($1,$2,1,'WORKFORCE_COMPENSATION_SETTLEMENT',$3::jsonb)`,
  [ctx.auth.tenantId, record.ref.id, JSON.stringify(record)]);
  return record;
}
/** Readback joins every prepared request with its boundary observations and
 * re-verifies each preimage against the accepted obligation. A producer's
 * closure or admission claim is never trusted: anything that is not the exact
 * durable UNADMITTED refusal fails the projection instead of passing. */
export async function readWorkforceCompensationPaymentRequestsTx(ctx: PeMutationContext, c: PoolClient,
  programme: { id: string; work_id: string },
  obligations: Array<{ ref: { contentDigest: string }; payeePrincipalId: string; termsDigest: string;
    originalReservation: unknown }>) {
  const rows = (await c.query(`SELECT request_id, obligation_digest, body FROM finnor_os.s5_workforce_payment_requests
    WHERE tenant_id=$1 AND programme_id=$2 ORDER BY request_id LIMIT 8193`, [ctx.auth.tenantId, programme.id])).rows;
  if (rows.length > 8192) fail("WORKFORCE_S6_PAYMENT_PREPARATION_PROFILE_INCOMPLETE");
  const requests = [];
  for (const row of rows) {
    const parsed = workforceCompensationPrepareSchema.safeParse(row.body);
    if (!parsed.success || parsed.data.requestId !== row.request_id ||
        parsed.data.binding.obligationRef.contentDigest !== row.obligation_digest ||
        parsed.data.binding.workId !== programme.work_id)
      fail("WORKFORCE_S6_PAYMENT_PREPARATION_PREIMAGE_CHANGED");
    const binding = parsed.data.binding;
    const { bindingDigest, ...bindingPreimage } = binding;
    if (epistemicHash(bindingPreimage) !== bindingDigest) fail("WORKFORCE_S6_PAYMENT_PREPARATION_PREIMAGE_CHANGED");
    const obligation = obligations.find(record => record.ref.contentDigest === row.obligation_digest);
    if (!obligation || !sameAllocationRef(obligation.ref, binding.obligationRef) ||
        obligation.payeePrincipalId !== binding.payeePrincipalId || obligation.termsDigest !== binding.termsDigest ||
        !sameAllocationRef(obligation.originalReservation, binding.originalReservation))
      fail("WORKFORCE_S6_PAYMENT_PREPARATION_OBLIGATION_MISMATCH");
    const observationRows = (await c.query(`SELECT body FROM finnor_os.s5_workforce_payment_observations
      WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,observation_id LIMIT 1025`,
      [ctx.auth.tenantId, row.request_id])).rows;
    if (observationRows.length > 1024) fail("WORKFORCE_S6_PAYMENT_BOUNDARY_PROFILE_INCOMPLETE");
    const boundaryObservations = observationRows.map(observed => {
      const body = observed.body;
      if (body?.schema !== "finnor.s6.workforce-compensation-boundary-observation.v1" ||
          body.requestId !== row.request_id || body.reachedBoundary !== "S6_FINANCIAL_BROKER" ||
          body.admission !== "UNADMITTED" || body.financialTransferAuthorized !== false ||
          body.retryPermitted !== false)
        fail("WORKFORCE_S6_PAYMENT_BOUNDARY_OBSERVATION_NOT_A_DURABLE_REFUSAL");
      return body as Record<string, unknown>;
    });
    requests.push({ requestId: row.request_id as string, obligationDigest: row.obligation_digest as string,
      binding, preparedAt: binding.preparedAt, boundaryObservations });
  }
  return requests;
}
