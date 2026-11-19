// Independent verification owner. Do not import the closing compiler, controller,
// adapter or their interpretation functions here.
import { createHash, verify } from "node:crypto";
import {
  ClosingMoneySchema, ClosingObservationSchema, ClosingSpecSchema,
  type ClosingCheck, type ClosingEvidenceRef, type ClosingGraph, type ClosingIssuer,
  type ClosingMoney, type ClosingObservation, type ClosingOwnerRef, type ClosingSpec,
} from "@finnor/shared-types";

const VERSION = "finnor-independent-closing-v1";
function bytes(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(bytes).join(",")}]`;
  return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${bytes(x)}`).join(",")}}`;
}
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : bytes(v)).digest("hex");
const equal = (a: unknown, b: unknown) => bytes(a) === bytes(b);

/** Exact decimal normalization. No amount, quantity or acceptance comparison
 * passes through floating point or display rounding. */
export function closingExact(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/.test(value)) throw Error("CLOSING_EXACT_DECIMAL_REQUIRED");
  const [whole, part = ""] = value.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(part.padEnd(18, "0"));
}
function moneyEqual(actual: unknown, expected: ClosingMoney): boolean {
  const parsed = ClosingMoneySchema.safeParse(actual);
  if (!parsed.success) return false;
  const { amount: a, ...ad } = parsed.data, { amount: b, ...bd } = expected;
  return closingExact(a) === closingExact(b) && equal(ad, bd);
}

export interface ClosingCheckInput {
  spec: ClosingSpec;
  graph: ClosingGraph;
  observations: Array<{ ref: ClosingEvidenceRef; observation: ClosingObservation }>;
  issuers: ClosingIssuer[];
  operations: Array<{
    operationKey: string; businessEffectId: string;
    status: "UNATTEMPTED" | "UNKNOWN" | "ACKNOWLEDGED" | "SETTLED" | "AUTHORITATIVELY_ABSENT" | "DIVERGENT";
    material: boolean; originalReservationRef: ClosingOwnerRef | null;
    settlement?: {
      originalSpec: ClosingSpec; stepKey: string; issuer: ClosingIssuer;
      evidence: { ref: ClosingEvidenceRef; observation: ClosingObservation };
      relatedEvidence?: Array<{ ref: ClosingEvidenceRef; observation: ClosingObservation; issuer: ClosingIssuer }>;
    };
  }>;
  dutyHandoffs: Array<{
    key: string; ownerPrincipalId: string; dueAt: string; statementDigest: string;
    dependencyKeys: string[]; liability: ClosingMoney | null; obligationRef: ClosingOwnerRef;
    canonicalTaskId: string; status: "OWNED" | "CANCELLED";
  }>;
  currentActorIds: string[];
  validRoleBindings: Array<{ ref: ClosingOwnerRef; principalId: string; legalEntityIds: string[] }>;
  canonicalWaivers?: Array<{ conditionId: string; authorityRef: ClosingOwnerRef; actorId: string; current: boolean }>;
  /** Resolved by the independent service from its own canonical DB cut. These
   * are not accepted from a controller HTTP request or generated expected result. */
  currentness: {
    expectedWorkInputId: string; currentWorkInputId: string;
    approvedTermsRevision: string; approvedTermsDigest: string;
    dependenciesCurrent: boolean; authorityCurrent: boolean; documentsCurrent: boolean;
    legalSpecAccepted: boolean; profileEnvironment: ClosingSpec["environment"];
    profileCurrent: boolean; programmeStopped: boolean;
  };
}

/** A generic native "verified" flag is not financial settlement. Reconstruct the
 * original operation and independently authenticate its immutable signed fact.
 * Historical settlement does not expire into permission to repeat an effect. */
function operationSettled(operation: ClosingCheckInput["operations"][number], currentSpec: ClosingSpec, now: number): boolean {
  if (operation.status === "DIVERGENT" || !operation.settlement) return false;
  const parsed = ClosingSpecSchema.safeParse(operation.settlement.originalSpec);
  const fact = ClosingObservationSchema.safeParse(operation.settlement.evidence.observation);
  if (!parsed.success || !fact.success) return false;
  const spec = parsed.data, specDigest = hash(spec), o = fact.data, issuer = operation.settlement.issuer;
  if (spec.tenantId !== currentSpec.tenantId || spec.transactionId !== currentSpec.transactionId) return false;
  const step = spec.steps.find(s => s.key === operation.settlement!.stepKey);
  const requirements = [spec.documents, spec.funding, spec.fundsFlows, spec.rightsTransfers, spec.legalEffectiveness];
  const requirement = requirements.flatMap(rs => rs.filter(r => r.key === step?.requirementKey))[0];
  if (!step || !requirement) return false;
  const authenticate = (v: { ref: ClosingEvidenceRef; observation: ClosingObservation; issuer: ClosingIssuer }) => {
    const f = ClosingObservationSchema.safeParse(v.observation);
    if (!f.success) return false;
    const x = f.data, { signature, ...body } = x, i = v.issuer;
    let authentic = false;
    try { authentic = verify(null, Buffer.from(bytes(body)), i.publicKeyPem, Buffer.from(signature, "base64")); } catch { /* Fail closed. */ }
    return authentic && i.status === "ACTIVE" && x.tenantId === spec.tenantId && x.transactionId === spec.transactionId
      && x.specDigest === specDigest && x.approvedTermsRevision === spec.approvedTermsRevision
      && x.requirementKey === requirement.key && x.predicateDigest === requirement.evidence.predicateDigest
      && x.kind === requirement.evidence.kind && requirement.evidence.issuerIds.includes(x.issuerId)
      && requirement.evidence.channels.includes(x.channel) && i.id === x.issuerId
      && i.actorId === x.actorId && i.environment === spec.environment
      && i.kinds.includes(x.kind) && i.channels.includes(x.channel)
      && Date.parse(x.observedAt) <= now && Date.parse(x.validUntil) > Date.parse(x.observedAt)
      && Date.parse(i.validUntil) > Date.parse(x.observedAt) && v.ref.contentHash === hash(bytes(x));
  };
  const primary = { ...operation.settlement.evidence, issuer };
  if (!authenticate(primary) || o.status !== "CONFIRMED" || o.claims.businessEffectId !== operation.businessEffectId) return false;
  const facts = [primary, ...(operation.settlement.relatedEvidence ?? [])].filter(authenticate);
  const factsById = new Map<string, (typeof facts)[number]>();
  for (const f of facts) if (!factsById.has(f.observation.factId)) factsById.set(f.observation.factId, f);
  const superseded = new Set<string>();
  for (const f of facts) for (const id of f.observation.supersedesFactIds) {
    const old = factsById.get(id);
    if (!old || old.observation.issuerId !== f.observation.issuerId || old.observation.channel !== f.observation.channel
        || Date.parse(old.observation.observedAt) >= Date.parse(f.observation.observedAt)) return false;
    superseded.add(id);
  }
  // A correction cannot leave a formerly accepted financial fact authoritative.
  // Never turn that loss of proof into permission to repeat the original effect.
  if (superseded.has(o.factId)) return false;
  if (facts.some(f => f.observation.factId !== o.factId && !superseded.has(f.observation.factId)
      && f.observation.claims.businessEffectId === operation.businessEffectId
      && (f.observation.status !== "CONFIRMED" || !equal(f.observation.claims, o.claims)))) return false;
  if (step.kind === "REQUEST_SIGNATURE") {
    const d = spec.documents.find(d => d.key === step.requirementKey);
    if (!d) return false;
    return o.claims.documentId === d.documentId && o.claims.documentVersionId === d.documentVersionId
      && o.claims.documentDigest === d.documentDigest && equal(o.claims.signers, d.signers);
  }
  if (step.kind === "DRAW_FUNDS") {
    const f = spec.funding.find(f => f.key === step.requirementKey);
    if (!f) return false;
    return moneyEqual(o.claims.money, f.money) && o.claims.facilityDigest === f.facilityDigest
      && o.claims.providerEntityId === f.providerEntityId && o.claims.sourceClass === f.sourceClass
      && o.claims.operationKey === f.drawOperationKey
      && o.claims.state === (f.sourceClass === "EQUITY_CAPITAL" ? "SETTLED_CONTRIBUTION" : "SETTLED_DRAW");
  }
  if (step.kind === "PAY_FUNDS") {
    const f = spec.fundsFlows.find(f => f.key === step.requirementKey);
    if (!f) return false;
    return moneyEqual(o.claims.money, f.money) && o.claims.operationKey === f.operationKey
      && o.claims.receivingEntityId === f.receivingEntityId && o.claims.accountDigest === f.receivingAccountDigest
      && o.claims.receivingState === "SETTLED_RECEIVED"
      && (!f.workforceCompensation || o.claims.payerEntityId === f.payerEntityId
        && equal(o.claims.workforceCompensation, f.workforceCompensation));
  }
  if (step.kind === "TRANSFER_RIGHTS") {
    const t = spec.rightsTransfers.find(t => t.key === step.requirementKey);
    if (!t) return false;
    return o.claims.fromEntityId === t.fromEntityId && o.claims.toEntityId === t.toEntityId
      && o.claims.rightsDigest === t.rightsDigest && o.claims.operationKey === t.operationKey
      && typeof o.claims.quantity === "string" && /^[0-9]+(?:\.[0-9]{1,18})?$/.test(o.claims.quantity)
      && closingExact(o.claims.quantity) === closingExact(t.quantity) && o.claims.unit === t.unit;
  }
  if (step.kind === "FILE") {
    const e = spec.legalEffectiveness.find(e => e.key === step.requirementKey);
    if (!e) return false;
    return o.claims.effective === true && o.claims.operationKey === e.operationKey
      && o.claims.jurisdiction === e.jurisdiction && o.claims.legalBasisDigest === e.legalBasisDigest
      && o.professionalScope === e.professionalScope && issuer.qualifiedScopes.includes(e.professionalScope);
  }
  return false;
}

/** Exact bipartite flow prevents one funding source being spent twice or an
 * aggregate surplus hiding a shortfall in a restricted subset of flows. */
function financingFeasible(funding: ReadonlyArray<{ key: string; money: ClosingMoney }>, flows: ReadonlyArray<{ money: ClosingMoney; fundingKeys: readonly string[] }>): boolean {
  const count = funding.length + flows.length + 2, source = count - 2, sink = count - 1;
  const capacity = Array.from({ length: count }, () => Array<bigint>(count).fill(0n));
  const demand = flows.reduce((n, f) => n + closingExact(f.money.amount), 0n);
  funding.forEach((f, i) => {
    capacity[source]![i] = closingExact(f.money.amount);
    flows.forEach((flow, j) => { if (flow.fundingKeys.includes(f.key)) capacity[i]![funding.length + j] = demand; });
  });
  flows.forEach((f, j) => { capacity[funding.length + j]![sink] = closingExact(f.money.amount); });
  let delivered = 0n;
  for (;;) {
    const parent = Array<number>(count).fill(-1), queue = [source]; parent[source] = source;
    for (let index = 0; index < queue.length && parent[sink] === -1; index++) {
      const from = queue[index]!;
      for (let to = 0; to < count; to++) if (parent[to] === -1 && capacity[from]![to]! > 0n) {
        parent[to] = from; queue.push(to);
      }
    }
    if (parent[sink] === -1) return delivered === demand;
    let amount = demand;
    for (let at = sink; at !== source; at = parent[at]!) {
      const remaining = capacity[parent[at]!]![at]!;
      if (remaining < amount) amount = remaining;
    }
    for (let at = sink; at !== source; at = parent[at]!) {
      const from = parent[at]!;
      capacity[from]![at] = capacity[from]![at]! - amount;
      capacity[at]![from] = capacity[at]![from]! + amount;
    }
    delivered += amount;
  }
}

function checkGraph(spec: ClosingSpec, graph: ClosingGraph): string[] {
  const errors: string[] = [], expected = new Map<string, ClosingGraph["nodes"][number]>();
  const families = {
    documents: spec.documents, conditions: spec.conditions, fundsFlows: spec.fundsFlows,
    rightsTransfers: spec.rightsTransfers, legalEffectiveness: spec.legalEffectiveness,
    funding: spec.funding, beneficiaries: spec.beneficiaries,
  };
  const requirements = new Set(Object.values(families).flatMap(rs => rs.map(r => r.key)));
  const steps = new Set(spec.steps.map(s => s.key));
  const resolve = (key: string) => requirements.has(key) ? `requirement:${key}`
    : steps.has(key) ? `operation:${key}` : `unresolved:${key}`;
  for (const [family, original] of Object.entries(families)) {
    for (const r of original) {
      const key = `requirement:${r.key}`;
      if (expected.has(key)) errors.push("GRAPH_DUPLICATE_ORIGINAL_REQUIREMENT");
      expected.set(key, {
        key, kind: "REQUIREMENT", requirementClass: family, originalDigest: hash(r),
        actorIds: family === "documents" ? (r as ClosingSpec["documents"][number]).signers.map(s => s.principalId).sort() : [],
        dependsOn: r.dependsOn.map(resolve).sort(), irreversible: false,
      });
    }
  }
  for (const s of spec.steps) {
    if (!requirements.has(s.requirementKey)) errors.push(`GRAPH_OPERATION_ORIGINAL_REQUIREMENT_MISSING:${s.key}`);
    expected.set(`operation:${s.key}`, {
      key: `operation:${s.key}`, kind: "OPERATION", requirementClass: s.kind,
      originalDigest: hash(s), actorIds: [s.actor.principalId],
      dependsOn: [...new Set(s.dependsOn.map(resolve))].sort(), irreversible: s.irreversible,
    });
    if (["DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE"].includes(s.kind)
        && (!s.irreversible || !s.exposureCap || !s.policyRef || !s.allocationRef)) {
      errors.push(`GRAPH_IRREVERSIBLE_ENVELOPE_OR_OWNER_MISSING:${s.key}`);
    }
  }
  for (const d of spec.continuingDuties) {
    expected.set(`duty:${d.key}`, {
      key: `duty:${d.key}`, kind: "CONTINUING_DUTY", requirementClass: "continuingDuties",
      originalDigest: hash(d), actorIds: [d.ownerPrincipalId], dependsOn: [], irreversible: false,
    });
  }
  expected.set("independent-close-check", {
    key: "independent-close-check", kind: "INDEPENDENT_CLOSE_CHECK",
    requirementClass: "completeConjunction", originalDigest: hash(spec), actorIds: [], irreversible: false,
    dependsOn: [
      ...Object.values(families).flatMap(rs => rs.filter(r => r.required).map(r => `requirement:${r.key}`)),
      ...spec.continuingDuties.map(d => `duty:${d.key}`),
    ].sort(),
  });
  if (graph.schema !== "finnor.closing-graph.v1" || graph.specDigest !== hash(spec)) errors.push("GRAPH_SPEC_BINDING");
  if (graph.nodes.length !== expected.size || new Set(graph.nodes.map(n => n.key)).size !== graph.nodes.length) errors.push("GRAPH_MISSING_DUPLICATE_OR_INVENTED_NODE");
  for (const n of graph.nodes) if (!equal(n, expected.get(n.key) ?? null)) errors.push(`GRAPH_ORIGINAL_SEMANTICS_CHANGED:${n.key}`);
  if (graph.bounds.nodes !== expected.size || graph.bounds.maxNodes !== 1024 || expected.size > 1024) errors.push("GRAPH_BOUND");
  const seen = new Set<string>(), stack = new Set<string>();
  const visit = (key: string): void => {
    if (stack.has(key)) { errors.push("GRAPH_CYCLE"); return; }
    if (seen.has(key)) return;
    const n = expected.get(key);
    if (!n) { errors.push(`GRAPH_UNRESOLVED_EDGE:${key}`); return; }
    stack.add(key); n.dependsOn.forEach(visit); stack.delete(key); seen.add(key);
  };
  expected.forEach(n => visit(n.key));
  return errors;
}

export function checkClosingTransaction(input: ClosingCheckInput, checkedAt = new Date().toISOString()): ClosingCheck {
  const spec = ClosingSpecSchema.parse(input.spec), now = Date.parse(checkedAt), specDigest = hash(spec);
  if (!Number.isFinite(now)) throw Error("CLOSING_CHECK_CLOCK_REQUIRED");
  const reasons = checkGraph(spec, input.graph);
  const acceptedEvidence: ClosingCheck["acceptedEvidence"] = [];
  const deadline = Date.parse(spec.originalGrant.deadlineAt);
  const expiry: number[] = [];
  const c = input.currentness;
  if (c.expectedWorkInputId !== c.currentWorkInputId) reasons.push("CURRENT_WORK_INPUT_CHANGED");
  if (c.approvedTermsRevision !== spec.approvedTermsRevision || c.approvedTermsDigest !== spec.approvedTermsDigest) reasons.push("APPROVED_TERMS_CHANGED");
  if (!c.dependenciesCurrent) reasons.push("DEPENDENCIES_CHANGED");
  if (!c.documentsCurrent) reasons.push("APPROVED_DOCUMENT_BYTES_OR_CURRENT_VERSION_CHANGED");
  if (!c.authorityCurrent) reasons.push("AUTHORITY_CHANGED");
  if (!c.legalSpecAccepted) reasons.push("QUALIFIED_LEGAL_SPEC_ACCEPTANCE_MISSING");
  if (!c.profileCurrent || c.profileEnvironment !== spec.environment) reasons.push("PROFILE_CURRENTNESS_OR_ENVIRONMENT_UNPASSED");
  if (c.programmeStopped) reasons.push("PROGRAMME_STOPPED");
  if (now >= deadline) reasons.push("ORIGINAL_GRANT_DEADLINE_EXPIRED");
  if (spec.unsupportedPredicates.length) reasons.push(...spec.unsupportedPredicates.map(p => `UNSUPPORTED_PREDICATE:${p}`));

  const verified: Array<ClosingCheckInput["observations"][number]> = [];
  const originalKeys = new Set([spec.documents, spec.conditions, spec.fundsFlows, spec.rightsTransfers,
    spec.legalEffectiveness, spec.funding, spec.beneficiaries].flatMap(rs => rs.map(r => r.key)));
  for (const raw of input.observations) {
    const parsed = ClosingObservationSchema.safeParse(raw.observation);
    if (!parsed.success) { reasons.push("INVALID_OBSERVATION_SCHEMA"); continue; }
    const o = parsed.data;
    if (o.kind !== "LEGAL_SPEC_ACCEPTANCE" && !originalKeys.has(o.requirementKey)) {
      reasons.push(`UNBOUND_MATERIAL_OBSERVATION:${o.requirementKey}`);
    }
    const issuer = input.issuers.find(i => i.id === o.issuerId);
    const { signature, ...body } = o;
    let authentic = false;
    try { authentic = Boolean(issuer && verify(null, Buffer.from(bytes(body)), issuer.publicKeyPem, Buffer.from(signature, "base64"))); } catch { /* Invalid key/signature is not truth. */ }
    if (!authentic || !issuer || issuer.status !== "ACTIVE" || issuer.actorId !== o.actorId
        || issuer.environment !== spec.environment || !issuer.kinds.includes(o.kind)
        || !issuer.channels.includes(o.channel)
        || Date.parse(issuer.validUntil) <= Date.parse(o.observedAt)
        || Date.parse(o.observedAt) > now || Date.parse(o.validUntil) <= Date.parse(o.observedAt)
        || o.tenantId !== spec.tenantId || o.transactionId !== spec.transactionId
        || o.specDigest !== specDigest || o.approvedTermsRevision !== spec.approvedTermsRevision) {
      reasons.push(`OBSERVATION_IDENTITY_SCOPE_SIGNATURE_OR_CURRENTNESS:${o.requirementKey}`);
      continue;
    }
    if (o.kind === "PROFESSIONAL_CONDITION" || o.kind === "LEGAL_EFFECTIVENESS" || o.kind === "LEGAL_SPEC_ACCEPTANCE") {
      if (!o.professionalScope || !issuer.qualifiedScopes.includes(o.professionalScope)) {
        reasons.push(`PROFESSIONAL_QUALIFICATION_SCOPE:${o.requirementKey}`); continue;
      }
    }
    verified.push({ ref: raw.ref, observation: o });
  }
  // Corrections must name existing same-issuer/channel facts. A later favourable
  // row does not implicitly erase contradictory or adverse evidence.
  const verifiedById = new Map<string, (typeof verified)[number]>();
  for (const f of verified) if (!verifiedById.has(f.observation.factId)) verifiedById.set(f.observation.factId, f);
  const superseded = new Set<string>();
  for (const { observation: o } of verified) {
    for (const oldId of o.supersedesFactIds) {
      const old = verifiedById.get(oldId)?.observation;
      if (!old || old.issuerId !== o.issuerId || old.channel !== o.channel
          || old.requirementKey !== o.requirementKey || Date.parse(old.observedAt) >= Date.parse(o.observedAt)) {
        reasons.push(`INVALID_CORRECTION:${o.requirementKey}`);
      } else superseded.add(oldId);
    }
  }
  const current = verified.filter(x => {
    if (superseded.has(x.observation.factId)) return false;
    const o = x.observation, issuer = input.issuers.find(i => i.id === o.issuerId)!;
    if (!input.currentActorIds.includes(o.actorId) || Date.parse(issuer.validUntil) <= now || Date.parse(o.validUntil) <= now) {
      reasons.push(`OBSERVATION_IDENTITY_SCOPE_SIGNATURE_OR_CURRENTNESS:${o.requirementKey}`);
      return false;
    }
    return true;
  });
  const evidenceExpiry = (o: ClosingObservation) => expiry.push(Date.parse(o.validUntil),
    Date.parse(input.issuers.find(i => i.id === o.issuerId)!.validUntil));
  const legalAcceptance = current.filter(x => x.observation.kind === "LEGAL_SPEC_ACCEPTANCE");
  if (!legalAcceptance.length || legalAcceptance.some(({ observation: o }) =>
    o.status !== "CONFIRMED" || o.predicateDigest !== specDigest || o.professionalScope !== "closing-spec"
    || o.claims.accepted !== true || o.claims.specDigest !== specDigest)) {
    reasons.push("INDEPENDENT_SIGNED_LEGAL_SPEC_ACCEPTANCE_REQUIRED");
  } else {
    legalAcceptance.forEach(x => {
      evidenceExpiry(x.observation);
      acceptedEvidence.push({ requirementKey: "closing-spec", kind: "LEGAL_SPEC_ACCEPTANCE", ref: x.ref });
    });
  }
  const test = (r: { key: string; required: boolean; evidence: ClosingSpec["documents"][number]["evidence"] }, kind: ClosingObservation["kind"], predicate: (o: ClosingObservation) => boolean): boolean => {
    if (!r.required) return true;
    if (r.evidence.kind !== kind) { reasons.push(`WRONG_ACCEPTED_EVIDENCE_TYPE:${r.key}`); return false; }
    const facts = current.filter(x => {
      const o = x.observation;
      return o.requirementKey === r.key && o.kind === kind && o.predicateDigest === r.evidence.predicateDigest
        && r.evidence.issuerIds.includes(o.issuerId) && r.evidence.channels.includes(o.channel)
        && now - Date.parse(o.observedAt) <= r.evidence.maxAgeMs;
    });
    if (!facts.length) { reasons.push(`MISSING_CURRENT_EVIDENCE:${r.key}`); return false; }
    if (facts.some(x => x.observation.status !== "CONFIRMED" || !predicate(x.observation))) {
      reasons.push(`FAILED_PARTIAL_UNKNOWN_OR_CONFLICTING_EVIDENCE:${r.key}`); return false;
    }
    for (const f of facts) {
      evidenceExpiry(f.observation);
      expiry.push(Date.parse(f.observation.observedAt) + r.evidence.maxAgeMs);
      acceptedEvidence.push({ requirementKey: r.key, kind, ref: f.ref });
    }
    return true;
  };
  const every = <T>(rows: T[], predicate: (r: T) => boolean) => rows.map(predicate).every(Boolean);
  const docs = every(spec.documents, d => test(d, "DOCUMENT_EXECUTION", o =>
    o.claims.documentId === d.documentId && o.claims.documentVersionId === d.documentVersionId
    && o.claims.documentDigest === d.documentDigest && equal(o.claims.signers, d.signers)
    && d.approvedTermsRevision === spec.approvedTermsRevision
    && d.signers.every(a => input.currentActorIds.includes(a.principalId) && input.validRoleBindings.some(r =>
      r.principalId === a.principalId && r.legalEntityIds.includes(a.legalEntityId) && equal(r.ref, a.roleRef)))));
  const conditions = every(spec.conditions, r => {
    if (!r.required) return true;
    const waived = current.filter(x => x.observation.requirementKey === r.key && x.observation.kind === "WAIVER");
    if (waived.length) {
      const w = r.waiver;
      if (!w || !r.canonicalConditionId || Date.parse(w.expiresAt) <= now || waived.some(x => {
        const o = x.observation;
        return o.status !== "CONFIRMED" || o.predicateDigest !== r.evidence.predicateDigest
          || !w.actorIds.includes(o.actorId) || !w.allowedReasonCodes.includes(String(o.claims.reasonCode))
          || !equal(o.claims.authorityRef, w.authorityRef)
          || !input.canonicalWaivers?.some(cw => cw.current && cw.conditionId === r.canonicalConditionId && cw.actorId === o.actorId && equal(cw.authorityRef, w.authorityRef))
          || (w.maximumAmount && (!ClosingMoneySchema.safeParse(o.claims.amount).success
            || !moneyEqual({ ...(o.claims.amount as ClosingMoney), amount: w.maximumAmount.amount }, w.maximumAmount)
            || closingExact((o.claims.amount as ClosingMoney).amount) > closingExact(w.maximumAmount.amount)));
      })) { reasons.push(`INVALID_EXACT_WAIVER:${r.key}`); return false; }
      expiry.push(Date.parse(w.expiresAt));
      waived.forEach(x => {
        evidenceExpiry(x.observation);
        acceptedEvidence.push({ requirementKey: r.key, kind: "WAIVER", ref: x.ref });
      });
      return true;
    }
    if (r.evidenceClass === "UNRESOLVED") { reasons.push(`UNRESOLVED_CONDITION:${r.key}`); return false; }
    const kind = r.evidenceClass === "PROFESSIONALLY_ATTESTED" ? "PROFESSIONAL_CONDITION" : "OBSERVABLE_CONDITION";
    return test(r, kind, o => o.claims.satisfied === true && (kind !== "PROFESSIONAL_CONDITION" || o.professionalScope === r.professionalScope));
  });
  const moneyScope = (m: ClosingMoney) => bytes({ entityId: m.entityId, currency: m.currency, unit: m.unit,
    timeBasis: m.timeBasis, asOf: Date.parse(m.asOf), periodEnd: Date.parse(m.periodEnd), rounding: m.rounding });
  const fundingAvailable = new Set<string>(), fundingSettled = new Set<string>();
  const funding = every(spec.funding, f => {
    const available = test(f, "FUNDING_AVAILABLE", o =>
    moneyEqual(o.claims.money, f.money) && o.claims.facilityDigest === f.facilityDigest
    && o.claims.providerEntityId === f.providerEntityId && o.claims.sourceClass === f.sourceClass
    && (f.sourceClass === "DEBT_FACILITY" ? ["EFFECTIVE_AVAILABLE", "SETTLED_DRAW"]
      : f.sourceClass === "EQUITY_CAPITAL" ? ["EFFECTIVE_AVAILABLE", "SETTLED_CONTRIBUTION"]
        : ["EFFECTIVE_AVAILABLE"]).includes(String(o.claims.state)));
    if (!f.required) return true;
    if (available) fundingAvailable.add(f.key);
    const capitalRequiresSettlement = ["DEBT_FACILITY", "EQUITY_CAPITAL"].includes(f.sourceClass);
    const drawn = available && (!capitalRequiresSettlement || current.filter(x =>
      x.observation.requirementKey === f.key && x.observation.kind === "FUNDING_AVAILABLE"
      && x.observation.predicateDigest === f.evidence.predicateDigest
      && f.evidence.issuerIds.includes(x.observation.issuerId) && f.evidence.channels.includes(x.observation.channel)
      && now - Date.parse(x.observation.observedAt) <= f.evidence.maxAgeMs
    ).every(x => x.observation.claims.state === (f.sourceClass === "EQUITY_CAPITAL" ? "SETTLED_CONTRIBUTION" : "SETTLED_DRAW") && x.observation.claims.operationKey === f.drawOperationKey));
    if (drawn) fundingSettled.add(f.key);
    else reasons.push(`FUNDING_DRAW_NOT_SETTLED:${f.key}`);
    if (f.sourceClass === "DEBT_FACILITY") {
      const liability = f.continuingDutyKeys.map(k => spec.continuingDuties.find(d => d.key === k));
      if (!liability.length || liability.some(d => !d?.liability || !moneyEqual({ ...d.liability, amount: f.money.amount }, f.money))
          || liability.reduce((sum, d) => sum + (d?.liability ? closingExact(d.liability.amount) : 0n), 0n) < closingExact(f.money.amount)) {
        reasons.push(`DECLARED_DEBT_PRINCIPAL_DUTY_MISSING:${f.key}`);
      }
    }
    return drawn;
  });
  const debts = spec.funding.filter(f => f.required && f.sourceClass === "DEBT_FACILITY");
  for (const scope of new Set(debts.map(f => moneyScope(f.money)))) {
    const scoped = debts.filter(f => moneyScope(f.money) === scope);
    const keys = new Set(scoped.flatMap(f => f.continuingDutyKeys));
    const liabilities = spec.continuingDuties.filter(d => keys.has(d.key) && d.liability && moneyScope(d.liability) === scope)
      .map(d => ({ key: d.key, money: d.liability! }));
    if (!financingFeasible(liabilities, scoped.map(f => ({ money: f.money, fundingKeys: f.continuingDutyKeys })))) {
      reasons.push(`DECLARED_DEBT_PRINCIPAL_DUTY_CAPACITY_REUSED_OR_SHORT:${scoped[0]!.money.currency}:${scoped[0]!.money.entityId}`);
    }
  }
  const beneficiaries = every(spec.beneficiaries, b => test(b, "BENEFICIARY_VALIDATED", o =>
    o.claims.legalEntityId === b.legalEntityId && o.claims.accountDigest === b.accountDigest
    && o.claims.independentlyValidated === true && o.channel === b.independentValidationChannel));
  const flows = every(spec.fundsFlows, f => test(f, "RECEIVING_SETTLEMENT", o =>
    moneyEqual(o.claims.money, f.money) && o.claims.receivingEntityId === f.receivingEntityId
    && o.claims.accountDigest === f.receivingAccountDigest && o.claims.operationKey === f.operationKey
    && o.claims.receivingState === "SETTLED_RECEIVED"
    && (!f.workforceCompensation || o.claims.payerEntityId === f.payerEntityId
      && equal(o.claims.workforceCompensation, f.workforceCompensation))
    && spec.beneficiaries.some(b => b.required && b.key === f.beneficiaryRequirementKey
      && b.accountDigest === f.receivingAccountDigest && b.legalEntityId === f.receivingEntityId)
    && f.money.entityId === f.payerEntityId
    && f.fundingKeys.every(k => spec.funding.some(s => s.key === k && s.required && s.money.entityId === f.payerEntityId && s.money.currency === f.money.currency))));
  for (const scope of new Set(spec.fundsFlows.filter(f => f.required).map(f => moneyScope(f.money)))) {
    const grouped = spec.fundsFlows.filter(f => f.required && moneyScope(f.money) === scope);
    const keys = new Set(grouped.flatMap(f => f.fundingKeys));
    const sources = spec.funding.filter(f => f.required && keys.has(f.key) && moneyScope(f.money) === scope);
    if (!financingFeasible(sources, grouped)) reasons.push(`EXACT_FINANCING_SHORTFALL:${grouped[0]!.money.currency}:${grouped[0]!.payerEntityId}`);
  }
  const facilityKeys = spec.funding.filter(f => f.required).map(f => bytes({ facility: f.facilityDigest,
    provider: f.providerEntityId, entityId: f.money.entityId, currency: f.money.currency }));
  if (new Set(facilityKeys).size !== facilityKeys.length) reasons.push("OVERLAPPING_FUNDING_SOURCE_CANNOT_BE_COUNTED_TWICE");
  const transfers = every(spec.rightsTransfers, t => test(t, "RIGHTS_TRANSFER", o =>
    o.claims.fromEntityId === t.fromEntityId && o.claims.toEntityId === t.toEntityId
    && o.claims.rightsDigest === t.rightsDigest && typeof o.claims.quantity === "string"
    && closingExact(o.claims.quantity) === closingExact(t.quantity)
    && o.claims.unit === t.unit && o.claims.operationKey === t.operationKey));
  const effective = every(spec.legalEffectiveness, e => test(e, "LEGAL_EFFECTIVENESS", o =>
    o.claims.jurisdiction === e.jurisdiction && o.claims.legalBasisDigest === e.legalBasisDigest
    && o.professionalScope === e.professionalScope && o.claims.effective === true
    && (!e.operationKey || o.claims.operationKey === e.operationKey)));
  const settledOperations = input.operations.filter(o => operationSettled(o, spec, now));
  // There is no qualified whole-operation absence interface in this profile.
  // A caller-set absent/verified status cannot erase possible financial egress.
  const unresolved = input.operations.filter(o => o.material && o.status !== "UNATTEMPTED" && !settledOperations.includes(o));
  if (unresolved.length) reasons.push(...unresolved.map(o => `UNRECONCILED_MATERIAL_EXPOSURE:${o.operationKey}`));
  if (input.operations.some(o => o.status !== "UNATTEMPTED" && !o.originalReservationRef)) reasons.push("ORIGINAL_S5_EXPOSURE_ENVELOPE_MISSING");
  const duties = every(spec.continuingDuties, d => {
    const matches = input.dutyHandoffs.filter(h => h.key === d.key);
    const h = matches[0];
    const accepted = matches.length === 1 && h?.status === "OWNED" && h.obligationRef.owner === "S6"
      && Boolean(h.canonicalTaskId) && h.ownerPrincipalId === d.ownerPrincipalId && h.dueAt === d.dueAt
      && h.statementDigest === hash(d.statement) && equal(h.dependencyKeys, d.dependencyKeys)
      && (d.liability ? moneyEqual(h.liability, d.liability) : h.liability === null)
      && (!d.obligationRef || equal(h.obligationRef, d.obligationRef))
      && input.currentActorIds.includes(d.ownerPrincipalId);
    if (!accepted) reasons.push(`CONTINUING_DUTY_HANDOFF_MISSING_OR_CHANGED:${d.key}`);
    return accepted;
  });
  const retainedDutiesRepresented = input.dutyHandoffs.every(h => {
    const represented = spec.continuingDuties.some(d => d.key === h.key && d.ownerPrincipalId === h.ownerPrincipalId
      && d.statement && hash(d.statement) === h.statementDigest && equal(d.dependencyKeys, h.dependencyKeys)
      && Date.parse(d.dueAt) === Date.parse(h.dueAt)
      && (d.liability ? moneyEqual(h.liability, d.liability) : h.liability === null));
    if (!represented) reasons.push(`RETAINED_CONTINUING_DUTY_NOT_REPRESENTED:${h.key}`);
    return represented;
  });
  const conjunction = {
    executedDocuments: docs, conditionsSatisfiedOrValidlyWaived: conditions,
    receivingSettlement: flows && funding && beneficiaries,
    rightsTransfer: transfers, legalEffectiveness: effective,
    noUnreconciledMaterialExposure: unresolved.length === 0 && !reasons.includes("ORIGINAL_S5_EXPOSURE_ENVELOPE_MISSING"),
    continuingDutiesHandedOff: duties && retainedDutiesRepresented,
  };
  const rawKnown = new Set(acceptedEvidence.map(e => e.requirementKey));
  const rawSettled = new Set(settledOperations.map(o => o.operationKey));
  const requirements = new Map([...spec.documents, ...spec.conditions, ...spec.funding, ...spec.beneficiaries,
    ...spec.fundsFlows, ...spec.rightsTransfers, ...spec.legalEffectiveness].map(r => [r.key, r]));
  const operations = new Map(spec.steps.map(s => [s.key, s]));
  const satisfied = new Map<string, boolean>(), visiting = new Set<string>();
  const dependencySatisfied = (key: string): boolean => {
    const prior = satisfied.get(key); if (prior !== undefined) return prior;
    if (visiting.has(key) || visiting.size >= 1024) return false;
    const requirement = requirements.get(key), operation = operations.get(key);
    const deps = requirement?.dependsOn ?? (operation
      ? [...operation.dependsOn, ...(requirements.get(operation.requirementKey)?.dependsOn ?? [])] : []);
    const present = requirement ? rawKnown.has(key) : Boolean(operation && rawSettled.has(key));
    visiting.add(key);
    const result = present && deps.every(dependencySatisfied);
    visiting.delete(key); satisfied.set(key, result); return result;
  };
  const known = new Set([...rawKnown].filter(dependencySatisfied));
  const settled = new Set([...rawSettled].filter(dependencySatisfied));
  for (const requirement of requirements.values()) {
    if (requirement.required && rawKnown.has(requirement.key) && !dependencySatisfied(requirement.key)) {
      reasons.push(`UNMET_ORIGINAL_REQUIREMENT_DEPENDENCY:${requirement.key}`);
    }
  }
  const accepted = reasons.length === 0 && Object.values(conjunction).every(Boolean);
  const admissionCurrent = c.profileCurrent && c.authorityCurrent && c.dependenciesCurrent && c.documentsCurrent
    && c.expectedWorkInputId === c.currentWorkInputId && !c.programmeStopped
    && now < deadline && legalAcceptance.length > 0 && !reasons.some(r => /^(GRAPH|INVALID_OBSERVATION|OBSERVATION_|PROFESSIONAL_|APPROVED_TERMS|INDEPENDENT_SIGNED_LEGAL|UNSUPPORTED|UNBOUND_MATERIAL|INVALID_CORRECTION|OVERLAPPING_FUNDING|DECLARED_DEBT|RETAINED_CONTINUING)/.test(r));
  const readyOperationKeys = spec.steps.filter(s => {
    if (!admissionCurrent || input.operations.some(o => o.operationKey === s.key && o.status !== "UNATTEMPTED")
        || !input.currentActorIds.includes(s.actor.principalId)
        || !input.validRoleBindings.some(r => r.principalId === s.actor.principalId
          && r.legalEntityIds.includes(s.actor.legalEntityId) && equal(r.ref, s.actor.roleRef))
        || !s.dependsOn.every(k => known.has(k) || settled.has(k))
        || !(requirements.get(s.requirementKey)?.dependsOn ?? []).every(dependencySatisfied)
        || (s.irreversible && unresolved.length)) return false;
    if (s.kind === "DRAW_FUNDS") {
      const f = spec.funding.find(f => f.key === s.requirementKey);
      return Boolean(f && fundingAvailable.has(f.key) && !fundingSettled.has(f.key));
    }
    if (s.kind === "PAY_FUNDS") {
      const f = spec.fundsFlows.find(f => f.key === s.requirementKey);
      return Boolean(f && !known.has(f.key) && f.money.entityId === f.payerEntityId && known.has(f.beneficiaryRequirementKey) && f.fundingKeys.every(k => fundingSettled.has(k)
        && spec.funding.some(source => source.key === k && moneyScope(source.money) === moneyScope(f.money)))
        && !reasons.some(r => r.startsWith(`EXACT_FINANCING_SHORTFALL:${f.money.currency}:${f.payerEntityId}`)));
    }
    return !known.has(s.requirementKey) && ["REQUEST_SIGNATURE", "TRANSFER_RIGHTS", "FILE", "ACQUIRE_EVIDENCE", "REQUEST_PROFESSIONAL"].includes(s.kind);
  }).map(s => s.key);
  const disposition = accepted ? "READY_FOR_PUBLICATION" : c.programmeStopped ? "STOPPED"
    : unresolved.length ? "RECONCILING" : reasons.some(r => r.startsWith("GRAPH")) ? "FAILED"
    : reasons.every(r => r.startsWith("MISSING_CURRENT_EVIDENCE")) ? "WAITING" : "BLOCKED";
  return {
    schema: "finnor.independent-close-check.v1", specDigest, graphDigest: hash(input.graph),
    checkedAt, validUntil: new Date(Math.min(...expiry, accepted ? Infinity : now + 60000)).toISOString(), accepted, disposition,
    reasons: [...new Set(reasons)], acceptedEvidence, readyOperationKeys, closeConjunction: conjunction, interpretationVersion: VERSION,
    verifiedOperationSettlements: settledOperations.map(o => ({
      businessEffectId: o.businessEffectId, operationKey: o.operationKey,
      originalSpecDigest: hash(o.settlement!.originalSpec), ref: o.settlement!.evidence.ref,
    })),
    exclusions: ["SOURCE_TRUTH_NOT_PROVED_BY_HASH", "LEGAL_TRUTH_REQUIRES_DESIGNATED_PROFESSIONAL",
      "NO_EXECUTION_AUTHORITY_FROM_THIS_CHECK", "NO_ATOMIC_MULTI_PROVIDER_GUARANTEE",
      "NO_S8_ADMISSION_FROM_LOCAL_PROOF", "FINANCING_PRINCIPAL_IS_NOT_S7_PROFIT"],
  };
}
