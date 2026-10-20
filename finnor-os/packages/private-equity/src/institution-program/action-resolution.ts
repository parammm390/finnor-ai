import { createHash } from "node:crypto";
import type { PeMutationContext } from "../types";
import { tx, authorize } from "../evidence-execution/store";
import { decodeInstitutionSources } from "./source-decoder";
import type { OriginalInstitutionEvidence } from "./checker";
import type { DigitalInstitutionProfile } from "./contracts";
import type { InstitutionResponsibility } from "./responsibility";
import type { InstitutionHarnessRequest } from "../program-synthesis/contracts";
import { frozenDutyExpectation } from "../program-synthesis/duty-observer";
import { institutionDigest } from "./canonical-json";
import { supportsInstitutionCompletion } from "./completion-contracts";

type Action = NonNullable<InstitutionHarnessRequest["institution"]["actions"]>[number];
const entityId = (identity: string) => {
  const h = createHash("sha256").update(JSON.stringify(["x1-original-effect-v1", identity])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Generic supported vocabulary only. Business fields come from an exact raw
 * record or the standing rule. Canonical links are resolved by stable external
 * identifiers; ambiguous links require a precise decision, never name matching. */
export async function resolveInstitutionActions(ctx: PeMutationContext, original: OriginalInstitutionEvidence,
  responsibilities: InstitutionResponsibility[], profile: DigitalInstitutionProfile) {
  const decoded = await decodeInstitutionSources(original, profile);
  const actions: Action[] = [], gaps: Array<{ stableIdentity: string; reason: string; originalDeadline: string }> = [];
  for (const responsibility of responsibilities) {
    const d = responsibility.obligation;
    const row = decoded.observations.find(r => r.sourceId === d.trigger.sourceId && r.objectId === d.trigger.recordId);
    const rule = original.mandate.rules.find(r => r.id === d.rule.id) as
      (OriginalInstitutionEvidence["mandate"]["rules"][number] & { operationInputs?: Record<string, string | boolean> }) | undefined;
    if (!row || !rule) throw Error("X1_ACTION_TRIGGER_OR_RULE_CHANGED");
    if (!supportsInstitutionCompletion(d.permissibleOperationClass,d.postcondition.contractRef,d.independentObserver.ref)) {
      gaps.push({stableIdentity:d.stableIdentity,reason:"X1_COMPLETION_CONTRACT_NOT_REGISTERED",originalDeadline:d.originalDeadline});
      continue;
    }
    const raw = Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key.replace(/[^a-z0-9]/gi, "").toLowerCase(), value]));
    const inputs = rule.operationInputs ?? {};
    const allowedInputs = d.permissibleOperationClass === "open_workstream"
      ? ["workstreamKind", "workstreamName"]
      : d.permissibleOperationClass === "create_deal_request"
        ? ["workstreamExternalId", "workstreamKind", "requestedFromExternalId", "requestText", "requiresAcceptedDeliverable"]
        : ["workstreamExternalId", "workstreamKind", "findingStatement", "findingSeverity", "requiredForWorkstreamCompletion"];
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)
        || Object.keys(inputs).some(key => !allowedInputs.includes(key))
        || Object.values(inputs).some(value => typeof value !== "string" && typeof value !== "boolean")) {
      gaps.push({ stableIdentity: d.stableIdentity, reason: "X1_OPERATION_INPUT_MEANING_UNSUPPORTED", originalDeadline: d.originalDeadline });
      continue;
    }
    const value = (key: string): string | boolean | undefined => inputs[key] ?? raw[key.toLowerCase()];
    const string = (key: string): string | undefined => typeof value(key) === "string" && String(value(key)).trim()
      ? String(value(key)).trim() : undefined;
    const boolean = (key: string): boolean | undefined => value(key) === true || value(key) === "true" ? true
      : value(key) === false || value(key) === "false" ? false : undefined;
    const dealId = d.postcondition.structuralObserver.dealId, id = entityId(d.stableIdentity);
    await authorize(ctx, { entityType: "pe_deal", entityId: dealId }, [{ type: "work", id: original.workId }]);
    let payload: Record<string, unknown> | null = null, reason: string | null = null;
    const owner = { partyType: "employee", partyId: d.responsiblePrincipal };
    if (d.permissibleOperationClass === "open_workstream") {
      const kind = string("workstreamKind"), name = string("workstreamName");
      if (!kind || !name) reason = "X1_WORKSTREAM_KIND_AND_NAME_REQUIRED_FROM_SOURCE_OR_MANDATE";
      else payload = { dealId, workstreamId: id, kind, name, owner };
    } else {
      const external = string("workstreamExternalId"), kind = string("workstreamKind");
      const workstreams = await tx(ctx, async c => (await c.query<{ id: string }>(`SELECT id::text
        FROM finnor_os.pe_workstreams WHERE tenant_id=$1 AND deal_id=$2 AND archived_at IS NULL
        AND state NOT IN('complete','cancelled') AND (($3::text IS NOT NULL AND external_id=$3)
          OR ($3::text IS NULL AND $4::text IS NOT NULL AND kind=$4)) LIMIT 2`,
      [original.tenantId, dealId, external ?? null, kind ?? null])).rows, true);
      if (workstreams.length !== 1) reason = "X1_EXACT_ACTIVE_WORKSTREAM_REFERENCE_REQUIRED";
      else if (d.permissibleOperationClass === "create_deal_request") {
        const requestedFrom = string("requestedFromExternalId"), requestText = string("requestText");
        const parties = requestedFrom ? await tx(ctx, async c => (await c.query<{ id: string }>(`SELECT id::text
          FROM finnor_os.pe_deal_parties WHERE tenant_id=$1 AND deal_id=$2 AND external_id=$3
          AND state='active' AND removed_at IS NULL LIMIT 2`, [original.tenantId, dealId, requestedFrom])).rows, true) : [];
        const accepted = boolean("requiresAcceptedDeliverable");
        if (parties.length !== 1 || !requestText || accepted === undefined)
          reason = "X1_EXACT_REQUEST_RECIPIENT_TEXT_AND_ACCEPTANCE_RULE_REQUIRED";
        else payload = { dealId, requestId: id, workstreamId: workstreams[0]!.id,
          requestedFromDealPartyId: parties[0]!.id, owner, requestText,
          requestedAt: d.trigger.occurredAt, dueAt: d.originalDeadline, requiresAcceptedDeliverable: accepted };
      } else if (d.permissibleOperationClass === "record_finding") {
        const statement = string("findingStatement"), severity = string("findingSeverity"), required = boolean("requiredForWorkstreamCompletion");
        if (!statement || !severity || required === undefined)
          reason = "X1_FINDING_STATEMENT_SEVERITY_AND_COMPLETION_RULE_REQUIRED";
        else payload = { dealId, findingId: id, workstreamId: workstreams[0]!.id,
          statement, severity, materiality: d.materiality, owner, requiredForWorkstreamCompletion: required };
      } else reason = "X1_OPERATION_PAYLOAD_VOCABULARY_UNSUPPORTED";
    }
    if (!payload || reason) {
      gaps.push({ stableIdentity: d.stableIdentity, reason: reason!, originalDeadline: d.originalDeadline });
      continue;
    }
    const action: Action = { responsibilityIdentity: d.stableIdentity,
      operation: d.permissibleOperationClass as Action["operation"], payload,
      expectedEntityId: id, postconditionDigest: institutionDigest({ operation: d.permissibleOperationClass,
        payload, expectedEntityId: id, deadlineAt: d.originalDeadline,
        contractRef: d.postcondition.contractRef, observerRef: d.independentObserver.ref }) };
    const explicit = rule as typeof rule & { actionPayload?: unknown; expectedEntityId?: unknown; postconditionDigest?: unknown };
    if (Object.hasOwn(explicit, "actionPayload") && institutionDigest(explicit.actionPayload) !== institutionDigest(payload)
        || Object.hasOwn(explicit, "expectedEntityId") && explicit.expectedEntityId !== id
        || Object.hasOwn(explicit, "postconditionDigest") && explicit.postconditionDigest !== action.postconditionDigest) {
      gaps.push({ stableIdentity: d.stableIdentity, reason: "X1_EXPLICIT_MANDATE_INTENT_CONFLICT", originalDeadline: d.originalDeadline });
      continue;
    }
    try {
      frozenDutyExpectation(original.tenantId, { id: d.stableIdentity, stableIdentity: d.stableIdentity,
        derivationRevision: d.derivationRevision, operation: action.operation,
        deadlineAt: d.originalDeadline, postconditionRef: d.postcondition.contractRef,
        observerRef: d.independentObserver.ref, action });
      actions.push(action);
    } catch {
      gaps.push({ stableIdentity: d.stableIdentity, reason: "X1_EXPLICIT_OPERATION_FIELDS_UNSUPPORTED",
        originalDeadline: d.originalDeadline });
    }
  }
  return { actions, gaps };
}
