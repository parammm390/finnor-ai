/** S6 ordinary, disposable capital-provider transport. These are operation facts,
 * never legal classification, funding settlement, live admission or wealth. */
import { createHash } from "node:crypto";
import type { BusinessEffectSet } from "@finnor/shared-types";
import { withTenantTransaction, type Db } from "@finnor/db";
import { brokerResponseBytes } from "../../governed-execution/src/broker-io";
import {
  claimOwnedExternalOperation, prepareProviderInvocation, markProviderRequestMayHaveLeft,
  recordProviderInvocationAcknowledged, recordProviderInvocationFailure,
  reconcileOwnedExternalOperationTx, readOwnedExternalOperationTx,
  type ExternalOperationRow, type ProviderInvocationContext,
} from "./idempotent-call";

export interface CapitalProviderRequest {
  schema: "finnor.s6.capital-provider-request.v1"; tenantId: string; principalId: string; workId: string;
  programmeId: string; mandateDigest: string; authorityDigest: string;
  providerEntityId: string; recipientId: string; channelId: string;
  instrument: string; activity: "APPROACH" | "NEGOTIATE" | "REQUEST_PROFESSIONAL_REVIEW";
  disclosures: Array<{ evidenceVersionId: string; contentDigest: string; purpose: string; consentRef: string }>;
  terms: Record<string, unknown> | null; templateDigest: string;
}
export interface CapitalProviderBinding {
  tenantId: string; actionId: string; effectId: string; operationKey: string;
  providerOrigin: string; interfaceDigest: string; request: CapitalProviderRequest;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value as Record<string, unknown>).sort().map(k =>
    JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const CAPITAL_PROVIDER_INTERFACE = {
  schema: "finnor.s6.capital-http-interface.v1", domain: "DISPOSABLE_LOOPBACK_ONLY",
  submit: "POST /operations", reconcile: "GET /operations/:originalOperationId",
  retry: "NEVER_RESUBMIT_POSSIBLE_DELIVERY", maximumResponseBytes: 262144, requestTimeoutMs: 5000,
  providerResponses: "ORIGINAL_ISSUER_SIGNED_SOURCE_EVENTS", legalAndFundingInference: false,
  disclosureContent: "CURRENT_EXACT_DIGEST_WITNESSES_NOT_STORED_IN_EFFECT_PAYLOAD",
} as const;
export const CAPITAL_PROVIDER_INTERFACE_DIGEST = digest(CAPITAL_PROVIDER_INTERFACE);

export function validateCapitalProviderBinding(binding: CapitalProviderBinding): void {
  const url = new URL(binding.providerOrigin);
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.FINNOR_V4_PROFILE !== "DISPOSABLE" || !["127.0.0.1", "[::1]"].includes(database.hostname)
    || process.env.FINNOR_ENVIRONMENT === "production" || url.protocol !== "http:"
    || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== binding.providerOrigin
    || url.username || url.password || binding.interfaceDigest !== CAPITAL_PROVIDER_INTERFACE_DIGEST) {
    throw Error("CAPITAL_PROVIDER_INTERFACE_UNADMITTED");
  }
  if (binding.tenantId !== binding.request.tenantId || Buffer.byteLength(canonical(binding.request)) > 65536) throw Error("CAPITAL_PROVIDER_REQUEST_SCOPE_OR_BOUND");
}
export function compileCapitalProviderIntent(binding: CapitalProviderBinding, compiledAt: string): BusinessEffectSet {
  validateCapitalProviderBinding(binding);
  const actionType = "capital_provider_request", source = { domainActionId: binding.actionId, actionType, workId: binding.request.workId, objectiveStepId: null },
    targets: BusinessEffectSet["targets"] = [
      { kind: "party", type: "external_organization", id: binding.request.providerEntityId, sourcePath: "providerEntityId" },
      { kind: "party", type: "external_contact", id: binding.request.recipientId, sourcePath: "recipientId" },
    ],
    scope = { actionType, operationClass: "external_side_effect" as const, targets, bindings: [],
      delta: { operation: actionType, values: { request: binding.request, providerOrigin: binding.providerOrigin, interfaceDigest: binding.interfaceDigest } }, exposure: null },
    expected = { observation: "provider_delivery" as const, state: { operationKey: binding.operationKey, requestDigest: digest(binding.request) } };
  return {
    id: binding.effectId, schemaVersion: 1, semanticHash: digest({ source, ...scope, expected }), scopeHash: digest(scope), source,
    mode: "consequential", operation: { name: actionType, class: "external_side_effect", external: true },
    targets, bindings: [], preconditions: [], before: [], delta: scope.delta, expected, exposure: null,
    authority: { capability: `capital:${binding.request.activity}`, risk: "high", policyId: null, policyVersion: null },
    approval: { required: true, typedConfirmation: true, summary: "Exact independently approved capital activity and disclosure; disposable operation only" },
    reversibility: { classification: "unknown_provider_dependent", compensationCapability: null },
    uncertainty: { unknownOutcome: "reconcile_before_retry", stalePrecondition: "block_and_recompile" },
    provenance: { compiler: "finnor_effect_compiler", compilerVersion: 1, compiledAt, replacementForEffectId: null, compensationForEffectId: null },
  };
}
async function response(origin: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const result = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
      signal: controller.signal, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: canonical(body) }) });
    if (!result.body) throw Error("PROVIDER_RESPONSE_MISSING");
    const bytes = await brokerResponseBytes(result, CAPITAL_PROVIDER_INTERFACE.maximumResponseBytes).catch(error => {
      if (error instanceof Error && error.message === "BROKER_RESPONSE_BOUND") throw Error("PROVIDER_RESPONSE_BOUND");
      throw error;
    });
    if (!result.ok) throw Error("PROVIDER_RESPONSE_UNRESOLVED");
    const answer = JSON.parse(bytes.toString()) as Record<string, unknown>;
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw Error("PROVIDER_RESPONSE_INVALID");
    return answer;
  } finally { clearTimeout(timer); }
}
const owner = (binding: CapitalProviderBinding) => ({ type: "domain_action" as const, key: binding.actionId, domainActionId: binding.actionId });
async function withOriginalCapitalOperation<T>(binding: CapitalProviderBinding, fn: (db: Db) => Promise<T>) {
  return withTenantTransaction(binding.tenantId, { userId: binding.request.principalId }, async (db, c) => {
    await c.query("SELECT set_config('app.capital_reader_scope','CAPITAL_FORMATION',true),set_config('app.capital_original_programme_id',$1,true)", [binding.request.programmeId]);
    return fn(db);
  });
}
export async function capitalProviderOperation(binding: CapitalProviderBinding): Promise<ExternalOperationRow | null> {
  return withOriginalCapitalOperation(binding, db => readOwnedExternalOperationTx(db, binding.tenantId, owner(binding), binding.operationKey));
}

/** The boundary callback holds current owner/disclosure rows until wire completion.
 * A lost reply is UNKNOWN under the original canonical operation, not a retry. */
export async function dispatchDisposableCapitalProvider(
  binding: CapitalProviderBinding,
  withCurrentOwnerBoundary: <T>(action: (disclosureContents: Array<{ evidenceVersionId: string; content: string }>) => Promise<T>) => Promise<T>,
): Promise<{ operation: ExternalOperationRow; answer: Record<string, unknown> | null; reconciliationOnly: boolean }> {
  validateCapitalProviderBinding(binding);
  const prior = await capitalProviderOperation(binding);
  if (prior && (prior.requestHash !== digest(binding.request) || prior.businessEffectId !== binding.effectId)) throw Error("CAPITAL_ORIGINAL_OPERATION_BINDING_CHANGED");
  if (prior) return { operation: prior, answer: await response(binding.providerOrigin, "/operations/" + encodeURIComponent(prior.id)),
    reconciliationOnly: true };
  const requestHash = digest(binding.request), claim = await claimOwnedExternalOperation(
    binding.tenantId, owner(binding), binding.operationKey, requestHash, "capital_disposable_v1", binding.effectId, undefined,
    { principalId: binding.request.principalId, protocolVersion: 2, targetKey: binding.request.providerEntityId, retrySafety: "readback_required", verification: "readback", idempotency: { mode: "readback" } },
  );
  if (!claim.claimed) return { operation: claim.existing, answer: await response(binding.providerOrigin, "/operations/" + encodeURIComponent(claim.existing.id)), reconciliationOnly: true };
  const context: ProviderInvocationContext = { tenantId: binding.tenantId, principalId: binding.request.principalId, provider: "capital_disposable_v1",
    providerOperationAttemptId: claim.providerOperationAttemptId, requestHash, transportLayer: "provider_adapter" };
  const invocation = await prepareProviderInvocation(context, 1);
  let possiblyDelivered = false;
  try {
    const answer = await withCurrentOwnerBoundary(async disclosureContents => {
      await markProviderRequestMayHaveLeft(binding.tenantId, invocation, binding.request.principalId); possiblyDelivered = true;
      return response(binding.providerOrigin, "/operations", { schema: "finnor.capital-provider-wire.v1",
        operationId: claim.operation.id, requestDigest: requestHash, request: binding.request, disclosureContents });
    });
    await recordProviderInvocationAcknowledged(context, invocation, { operationId: claim.operation.id, requestDigest: requestHash,
      qualification: "PROVIDER_RESPONSE_ONLY_NOT_FINANCING_OR_FUNDING" }, { advanceLogicalOperation: false });
    return { operation: claim.operation, answer, reconciliationOnly: false };
  } catch (error) {
    await recordProviderInvocationFailure(context, invocation, { kind: "capital_provider_unresolved",
      message: "Original operation requires bounded source readback", definitePreDispatch: !possiblyDelivered });
    if (possiblyDelivered) return { operation: claim.operation, answer: null, reconciliationOnly: true };
    throw error;
  }
}
export async function reconcileCapitalProviderDeliveryTx(db: Db, binding: CapitalProviderBinding, observed: Record<string, unknown>) {
  // The caller authenticates the original provider event and exact request digest.
  // This settles only APPROACH/NEGOTIATE delivery, never commitment or bank truth.
  const operation = await readOwnedExternalOperationTx(db, binding.tenantId, owner(binding), binding.operationKey);
  if (!operation || operation.requestHash !== digest(binding.request) || operation.businessEffectId !== binding.effectId) throw Error("CAPITAL_ORIGINAL_OPERATION_UNAVAILABLE");
  if (operation.executionState === "reconciled") return operation;
  return reconcileOwnedExternalOperationTx(db, binding.tenantId, operation.id, "succeeded", observed);
}
