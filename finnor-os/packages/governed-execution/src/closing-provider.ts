/** Operation-specific S6 closing transport. It neither grants authority nor
 * interprets an acknowledgement as signature, settlement, transfer or legal truth. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { ClosingSpecSchema, type ClosingSpec, type ClosingStep } from "@finnor/shared-types";
import { closingExact } from "../../epistemic-runtime/src/closing-checker";
import { brokerCanonicalRequest } from "./closing-provider-client";
import { brokerHash } from "./broker-io";

export const CLOSING_PROVIDER_CONTRACT = Object.freeze({
  schema: "finnor.s6.closing-provider-contract.v1",
  operations: ["REQUEST_SIGNATURE", "DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE"],
  mutation: "EXACT_ORIGINAL_SPEC_ACTOR_REQUIREMENT_AND_NATIVE_EFFECT",
  acknowledgement: "NOT_SETTLEMENT",
  observation: "INDEPENDENT_SIGNED_ORIGINAL_OPERATION_REQUIREMENT_AND_RECEIVING_STATE",
  compensationBinding: "EXACT_OPTIONAL_ORIGINAL_WORKFORCE_OBLIGATION_PAYER_AND_PAYEE",
  absence: "NO_QUERY_MISS_OR_POLL_EXHAUSTION_AUTHORITY",
  repetition: "NO_SECOND_PHYSICAL_MUTATION_AFTER_POSSIBLE_EGRESS",
  cancellation: "STOP_FUTURE_WORK_RETAIN_ORIGINAL_S5_EFFECT_AND_DUTIES",
  atomicity: "NONE_ACROSS_PROVIDERS",
});
const canonical = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
export const closingProviderContractDigest = () => brokerHash(CLOSING_PROVIDER_CONTRACT);

export function originalClosingRequirement(spec: ClosingSpec, step: ClosingStep) {
  const groups = [spec.documents, spec.conditions, spec.fundsFlows, spec.rightsTransfers, spec.legalEffectiveness, spec.funding, spec.beneficiaries];
  const matches = groups.flatMap(rs => rs.filter(r => r.key === step.requirementKey));
  if (matches.length !== 1) throw Error("S6_CLOSING_ORIGINAL_REQUIREMENT_UNRESOLVED");
  return matches[0]!;
}
export function closingOperationRequest(specValue: unknown, step: ClosingStep, effectId: string) {
  const spec = ClosingSpecSchema.parse(specValue), requirement = originalClosingRequirement(spec, step);
  let operation: unknown;
  if (step.kind === "REQUEST_SIGNATURE") {
    const d = spec.documents.find(d => d.key === step.requirementKey);
    if (!d) throw Error("S6_CLOSING_SIGNATURE_DOCUMENT_BINDING");
    operation = { kind: step.kind, documentId: d.documentId, documentVersionId: d.documentVersionId, documentDigest: d.documentDigest, signers: d.signers };
  } else if (step.kind === "DRAW_FUNDS") {
    const f = spec.funding.find(f => f.key === step.requirementKey);
    if (!f || !f.drawOperationKey) throw Error("S6_CLOSING_DRAW_FACILITY_BINDING");
    operation = { kind: step.kind, operationKey: f.drawOperationKey, facilityDigest: f.facilityDigest, money: f.money, providerEntityId: f.providerEntityId, sourceClass: f.sourceClass };
  } else if (step.kind === "PAY_FUNDS") {
    const f = spec.fundsFlows.find(f => f.key === step.requirementKey);
    if (!f) throw Error("S6_CLOSING_PAYMENT_BINDING");
    operation = { kind: step.kind, operationKey: f.operationKey, money: f.money, payerEntityId: f.payerEntityId,
      receivingEntityId: f.receivingEntityId, receivingAccountDigest: f.receivingAccountDigest, purpose: f.purpose,
      ...(f.workforceCompensation ? { workforceCompensation: f.workforceCompensation } : {}) };
  } else if (step.kind === "TRANSFER_RIGHTS") {
    const t = spec.rightsTransfers.find(t => t.key === step.requirementKey);
    if (!t) throw Error("S6_CLOSING_RIGHTS_BINDING");
    operation = { kind: step.kind, operationKey: t.operationKey, fromEntityId: t.fromEntityId, toEntityId: t.toEntityId, rightsDigest: t.rightsDigest, quantity: t.quantity, unit: t.unit };
  } else if (step.kind === "FILE") {
    const f = spec.legalEffectiveness.find(f => f.key === step.requirementKey);
    if (!f?.operationKey) throw Error("S6_CLOSING_FILING_BINDING");
    operation = { kind: step.kind, operationKey: f.operationKey, jurisdiction: f.jurisdiction, legalBasisDigest: f.legalBasisDigest };
  } else throw Error("S6_CLOSING_OPERATION_CLASS_UNSUPPORTED");
  if (step.irreversible && !step.exposureCap) throw Error("S6_CLOSING_EXPOSURE_CAP_REQUIRED");
  if ("money" in (operation as object)) {
    const money = (operation as { money: ClosingSpec["funding"][number]["money"] }).money, cap = step.exposureCap;
    if (!cap || cap.currency !== money.currency || cap.entityId !== money.entityId || cap.unit !== money.unit
        || cap.timeBasis !== money.timeBasis || Date.parse(money.asOf) > Date.now()
        || Date.parse(cap.asOf) > Date.parse(money.asOf) || Date.parse(cap.periodEnd) < Date.parse(money.periodEnd)
        || Date.parse(money.periodEnd) < Date.parse(money.asOf)
        || closingExact(money.amount) > closingExact(cap.amount)) throw Error("S6_CLOSING_EXACT_EXPOSURE_CAP_EXCEEDED");
  }
  return {
    schema: "finnor.s6.closing-operation.v1", tenantId: spec.tenantId, transactionId: spec.transactionId,
    specDigest: createHash("sha256").update(canonical(spec)).digest("hex"),
    environment: spec.environment,
    approvedTermsRevision: spec.approvedTermsRevision, approvedTermsDigest: spec.approvedTermsDigest,
    businessEffectId: effectId, nodeKey: step.key, actor: step.actor,
    requirementKey: requirement.key, predicateDigest: requirement.evidence.predicateDigest, operation,
  };
}

export const ClosingBrokerRequestSchema = z.object({
  tenantId: z.string().uuid(), programmeId: z.string().uuid(), nodeKey: z.string().min(1).max(160),
  domainActionId: z.string().uuid(), businessEffectId: z.string().uuid(),
  providerOperationAttemptId: z.string().uuid().optional(), businessEffectHash: z.string().min(1).max(128),
}).strict();
export const dispatchClosingProvider = (request: z.infer<typeof ClosingBrokerRequestSchema>) => brokerCanonicalRequest("/dispatch", request);
export const readClosingProvider = (request: z.infer<typeof ClosingBrokerRequestSchema>) => brokerCanonicalRequest("/read", request);
