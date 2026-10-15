/** Evaluator-only comparison with a separately integrity-checked provider journal.
 * Never imported by learner, checker, planner, provider or native workers. */
import { createHash } from "node:crypto";
import type {
  ApplicationActionModel, ApplicationField, ApplicationPredicate, ApplicationScalar,
  ApplicationState, ApplicationTransitionEvidence, ExperimentRef,
} from "@finnor/shared-types";
import type { AuthorizedApplicationProfile } from "../../packages/private-equity/src/application-semantics/ports";
import type { ApplicationRequestRow } from "../../packages/private-equity/src/application-semantics/obligations";

type Json = Record<string, any>;
const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const same = (left: unknown, right: unknown) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export function nativeDiscoveryCaseCommitment(evidenceRef: ExperimentRef, requestRef: ExperimentRef | null, journalDigest: string) {
  return hash({ evidenceRef, requestRef, journalDigest });
}
function prediction(guard: ApplicationPredicate, state: ApplicationState, parameters: ApplicationState): boolean | "UNKNOWN" {
  let unknown = false;
  for (const atom of guard.all) {
    if (!own(state, atom.field)) { unknown = true; continue; }
    if (atom.operator === "present") continue;
    const operands: ApplicationScalar[] = [];
    for (const operand of atom.values) {
      if (operand.kind === "literal") operands.push(operand.value);
      else if (own(parameters, operand.name)) operands.push(parameters[operand.name]!);
      else unknown = true;
    }
    const match = operands.some(value => same(value, state[atom.field]));
    if (atom.operator === "neq" ? match : !match && operands.length === atom.values.length) return false;
  }
  return unknown ? "UNKNOWN" : true;
}
function publicValue(record: Json, field: ApplicationField, target: ApplicationTransitionEvidence["before"]["target"]) {
  let raw: any = record;
  for (const segment of field.path.split(".")) {
    if (raw === null || raw === undefined) { raw = null; break; }
    raw = raw[segment];
  }
  if (raw === undefined || raw === null) return null;
  if (field.kind === "quantity") return {
    kind: "quantity", decimal: raw.amount, currency: raw.currency,
    entity: raw.entity, unit: raw.unit, time: raw.date, basis: raw.basis,
  };
  if (field.kind === "identity") return {
    kind: "identity", application: record.applicationId, account: record.accountId,
    entity: target.entity, id: raw,
  };
  return raw;
}
export interface NativeDiscoveryInspection {
  schema: "finnor.x2.independent-discovery-inspection.v1";
  verdict: "SUPPORTED_DEVELOPMENT" | "INCONCLUSIVE" | "REFUSED";
  falseValid: number; falseInvalid: number; authorityViolations: number;
  duplicateEffects: number; falseCompletions: number;
  positives: number; denied: number; unknown: number;
  checks: Array<{ name: string; passed: boolean; observed: unknown }>;
  cases: Array<{ commitment: string; evidenceId: string; requestId: string; actual: string; predicted: boolean | "UNKNOWN" | "OUTSIDE_MODEL_ROLE_DOMAIN" }>;
  journalDigest: string; journalBytesSha256: string; protectedAdmission: false;
  costs: "UNKNOWN";
}
export function inspectNativeDiscovery(input: {
  model: ApplicationActionModel; fields: ApplicationField[]; evidence: ApplicationTransitionEvidence[];
  requests: ApplicationRequestRow[]; profiles: AuthorizedApplicationProfile[];
  journal: { rows: Array<{ sequence: number; state: Json }>; events: Json[]; digest: string; bytesSha256: string };
}): NativeDiscoveryInspection {
  const result: NativeDiscoveryInspection = {
    schema: "finnor.x2.independent-discovery-inspection.v1", verdict: "INCONCLUSIVE",
    falseValid: 0, falseInvalid: 0, authorityViolations: 0, duplicateEffects: 0, falseCompletions: 0,
    positives: 0, denied: 0, unknown: 0, checks: [], cases: [],
    journalDigest: input.journal.digest, journalBytesSha256: input.journal.bytesSha256,
    protectedAdmission: false, costs: "UNKNOWN",
  };
  const check = (name: string, passed: boolean, observed: unknown) => result.checks.push({ name, passed, observed });
  const positiveTargets = new Map<string, Set<string>>();
  const seenEffects = new Set<string>();
  check("original-evidence-population", input.evidence.length > 0 && input.evidence.length <= 256, input.evidence.length);
  for (const evidence of input.evidence) {
    const request = input.requests.find(row => row.body.wire.identity.effectId === evidence.effectRef?.id);
    const prefix = evidence.ref.id;
    if (!request) { check(prefix + ":original-request", false, null); result.unknown++; continue; }
    const identity = request.body.wire.identity;
    const profile = input.profiles.find(value => value.id === request.body.profileId);
    const events = input.journal.events.filter(event => event.requestId === identity.requestId
      && ["dispatch.accepted", "dispatch.denied", "dispatch.idempotent"].includes(event.type));
    const dispatched = events[0];
    check(prefix + ":exactly-one-original-dispatch", events.length === 1, events.length);
    if (!dispatched || !profile) { result.unknown++; continue; }
    const accepted = dispatched.type === "dispatch.accepted", denied = dispatched.type === "dispatch.denied";
    const externalLineage = accepted ? same(dispatched.request, identity)
      && dispatched.context?.applicationId === evidence.before.scope.application
      && dispatched.context?.accountId === evidence.before.scope.account
      && dispatched.context?.principalId === profile.actingPrincipal
      : denied && dispatched.effectId === identity.effectId && dispatched.accountId === profile.account;
    // Denials expose only the request/effect/account/target tuple, not a
    // successful authority snapshot or the entire unaccepted request.
    check(prefix + (accepted ? ":original-wire-lineage" : ":independent-denial-scope"), Boolean(externalLineage)
      && dispatched.recordId === evidence.before.target.id
      && profile.role === evidence.before.scope.role
      && same(profile.grantRef, evidence.before.scope.grantRef), {
      requestId: identity.requestId, operation: dispatched.operation, recordId: dispatched.recordId,
    });
    if (seenEffects.has(identity.effectId)) result.duplicateEffects++;
    seenEffects.add(identity.effectId);
    if (accepted) {
      const auth = dispatched.authorization;
      const requiredRole = dispatched.operation === "approve" ? "approver" : "editor";
      const authorized = Boolean(auth?.principalActive && auth.grantActive
        && auth.roles?.includes(requiredRole) && auth.actions?.includes(dispatched.action)
        && auth.recordIds?.includes(dispatched.recordId)
        && auth.principalId === profile.actingPrincipal && auth.accountId === profile.account
        && auth.applicationId === profile.application && auth.grantId === dispatched.context.grantId
        && auth.grantRevision === dispatched.context.grantRevision
        && auth.authorityRevision === dispatched.context.authorityRevision
        && Date.parse(dispatched.at) < Date.parse(auth.expiresAt)
        && Date.parse(dispatched.at) < Date.parse(identity.deadline)
        && Date.parse(identity.deadline) <= Date.parse(auth.expiresAt));
      if (!authorized) result.authorityViolations++;
      check(prefix + ":current-independent-authority", authorized, { role: requiredRole, action: dispatched.action });
    }
    const originalRecord = input.journal.rows.find(row => row.sequence < dispatched.sequence
      && String(row.state.records[evidence.before.target.id]?.version) === evidence.before.recordRevision)?.state.records[evidence.before.target.id];
    check(prefix + ":before-durable-record-revision", Boolean(originalRecord), evidence.before.recordRevision);
    if (originalRecord) for (const field of input.fields) check(prefix + ":before:" + field.path,
      own(evidence.before.state, field.path) && same(evidence.before.state[field.path], publicValue(originalRecord, field, evidence.before.target)),
      { kind: field.kind, comparison: "NATIVE_AGAINST_ORIGINAL_PROVIDER_REVISION" });
    if (accepted) {
      result.positives++;
      const targets = positiveTargets.get(evidence.operationId) ?? new Set<string>();
      targets.add(evidence.before.target.id); positiveTargets.set(evidence.operationId, targets);
      const after = evidence.after;
      const durable = after && input.journal.rows.find(row => row.sequence >= dispatched.sequence
        && String(row.state.records[after.target.id]?.version) === after.recordRevision)?.state.records[after.target.id];
      check(prefix + ":independently-observed-completion", evidence.disposition === "OBSERVED"
        && evidence.independentOutcome === "ESTABLISHED" && Boolean(after && durable), { disposition: evidence.disposition });
      if (evidence.disposition !== "OBSERVED" || !after || !durable) result.falseCompletions++;
      if (after && durable) for (const field of input.fields) check(prefix + ":after:" + field.path,
        own(after.state, field.path) && same(after.state[field.path], publicValue(durable, field, after.target)),
        { kind: field.kind, comparison: "NATIVE_AGAINST_DURABLE_PROVIDER_REVISION" });
      if (dispatched.operation === "submit") {
        const completed = input.journal.events.filter(event => event.type === "submission.completed" && event.requestId === identity.requestId);
        const completion = completed[0];
        const exact = completed.length === 1 && completion !== undefined && completion.effectId === identity.effectId
          && completion.obligationId === identity.obligationId && completion.parentId === identity.parentId
          && completion.sequence > dispatched.sequence
          && after && Date.parse(completion.at) <= Date.parse(after.observedAt);
        check(prefix + ":delayed-durable-submission-not-toast", Boolean(exact), { count: completed.length });
        if (!exact) result.falseCompletions++;
      }
      for (const parameter of Object.values(evidence.parameters)) if (parameter && typeof parameter === "object" && parameter.kind === "quantity") {
        check(prefix + ":exact-quantity-input", same(parameter, {
          kind: "quantity", decimal: dispatched.reporting?.amount, currency: dispatched.reporting?.currency,
          entity: dispatched.reporting?.entity, unit: dispatched.reporting?.unit,
          time: dispatched.reporting?.date, basis: dispatched.reporting?.basis,
        }), { representation: "EXACT_DECIMAL_AND_CONTEXT_STRINGS" });
      }
    } else if (denied) {
      result.denied++;
      check(prefix + ":independent-denial-not-success", evidence.disposition === "REJECTED"
        && evidence.independentOutcome === "DENIED" && evidence.after?.recordRevision === evidence.before.recordRevision
        && same(evidence.after?.state, evidence.before.state), evidence.disposition);
    } else result.unknown++;
    const operation = input.model.operations.find(value => value.id === evidence.operationId);
    const predicted = operation ? prediction(operation.precondition, evidence.before.state, evidence.parameters) : "OUTSIDE_MODEL_ROLE_DOMAIN";
    if (operation && accepted && predicted === false) result.falseInvalid++;
    if (operation && denied && predicted === true) result.falseValid++;
    if (operation && predicted === "UNKNOWN") result.unknown++;
    result.cases.push({ commitment: nativeDiscoveryCaseCommitment(evidence.ref, request.request_ref, input.journal.digest),
      evidenceId: evidence.ref.id, requestId: identity.requestId, actual: accepted ? "ACCEPTED" : denied ? "DENIED" : "UNKNOWN", predicted });
  }
  for (const operation of input.model.operations) check(operation.id + ":positive-independent-fresh-partitions",
    (positiveTargets.get(operation.id)?.size ?? 0) >= 2, positiveTargets.get(operation.id)?.size ?? 0);
  if (result.falseValid || result.falseInvalid || result.authorityViolations || result.duplicateEffects
    || result.falseCompletions || result.checks.some(value => !value.passed)) result.verdict = "REFUSED";
  else if (!result.unknown) result.verdict = "SUPPORTED_DEVELOPMENT";
  return result;
}
