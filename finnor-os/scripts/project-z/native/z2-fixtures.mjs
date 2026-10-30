/** Original-input builders for the Z2 native replay. They mirror scripts/y1 and scripts/y3 business fixtures (public
 * disposable inputs, no candidate, checker reply, admission or observation result is supplied) with one difference: every
 * claim and resource stays valid for the whole replay instead of one hour. Run under tsx with the installed pack. */
import { createHash, randomUUID } from "node:crypto";

export const VALIDITY_MS = 6 * 3600000;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) :
  Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" :
    "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
export const digest = value => sha(canonical(value));

export async function loadLibraries(pack) {
  const base = pack + "/finnor-os";
  const load = path => import(base + "/" + path);
  const [db, memory, contracts, product, y1, math, economic] = await Promise.all([
    load("packages/db/index.ts"), load("packages/memory/src/evidence.ts"),
    load("packages/private-equity/src/interaction-synthesis/contracts.ts"),
    load("packages/private-equity/src/interaction-synthesis/product-contracts.ts"),
    load("scripts/y1/business-fixtures.mts"), load("scripts/y3/math-fixtures.mts"),
    load("packages/private-equity/src/economic-action-theory/contracts.ts")]);
  return { db, memory, contracts, product, y1, math, economic };
}

const meaningClaims = (L, problem) => problem.meanings.map(m => ({ key: m.key, kind: m.kind, subjectId: m.subjectId,
  dimensions: problem.quantities.concat(problem.parameters).filter(q => q.meaningKey === m.key).map(q => ({
    unit: q.unit, currency: q.currency, entityId: q.entityId, accountingBasis: q.accountingBasis, period: q.period })),
  invariants: problem.invariants.filter(i => i.meaningKey === m.key).map(i => ({ id: i.id, digest: L.economic.digest(i) })),
  operatorExamples: problem.operators.filter(o => o.requirements.some(r => r.key === m.key && r.kind === "OBSERVATION"))
    .map(o => ({ operatorId: o.id, examplesDigest: L.economic.digest(o.examples) })),
  permittedOperatorIds: problem.operators.map(o => o.id), validUntil: new Date(Date.now() + VALIDITY_MS).toISOString(),
  protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT", externalEffects: false }));

export async function bindCanonicalInputs(L, admin, tenant, principal, root, problem, label) {
  const source = await L.memory.createEvidenceSource(tenant, { sourceKey: "z2:" + label + ":" + randomUUID(), sourceType: "manual",
    title: "Public declared finite observations " + label });
  const snapshot = { worldRoot: root, economicMeanings: meaningClaims(L, problem),
    qualification: "PUBLIC_DEVELOPMENT_INPUT_NOT_PROTECTED_OR_BUSINESS_TRUTH" };
  const version = await L.memory.appendEvidenceVersion(tenant, source.id, { content: JSON.stringify({ label,
    examples: problem.operators.map(o => o.examples) }), snapshot, asOf: new Date() });
  const hash = (await admin.query("SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2",
    [tenant, version.versionId])).rows[0].content_hash;
  problem.meanings = problem.meanings.map(m => ({ ...m, sourceId: source.id, versionId: version.versionId, contentDigest: hash }));
  const work = await L.db.receiveWork({ tenantId: tenant, userId: principal, channel: "console",
    instruction: "Z2 public native replay Work " + label, idempotencyKey: randomUUID(),
    entityAttachments: [{ ...root, source: "Z2:public-native-replay" }] });
  return { work, request: { schema: "finnor.economic-theory-request.v1", root, workId: work.workId, problem, idempotencyKey: randomUUID() } };
}

export async function canonicalClaim(L, admin, tenant, root, claim) {
  const source = await L.memory.createEvidenceSource(tenant, { sourceKey: "z2:public:" + randomUUID(), sourceType: "manual",
    title: "Public Z2 native claim" });
  const version = await L.memory.appendEvidenceVersion(tenant, source.id, { content: JSON.stringify(claim),
    snapshot: { worldRoot: root, interactionClaims: [claim], qualification: "PUBLIC_DISPOSABLE_INPUT_NOT_PROTECTED_OR_FIELD_TRUTH" },
    asOf: new Date() });
  const head = (await admin.query("SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2",
    [tenant, version.versionId])).rows[0];
  return { sourceId: source.id, versionId: version.versionId, contentDigest: head.content_hash, claimKey: String(claim.key),
    ref: L.product.reference("S1", "interaction-claim", claim) };
}

export function interactionProblem(L, principal, peer, theory, modelRef, label) {
  const problem = L.math.dynamicFixture();
  problem.id = "z2_native_" + label; problem.title = "Public dynamic interaction " + label;
  problem.participants[0].principalId = principal; problem.participants[1].principalId = peer;
  problem.dates = [3000, 2000, 1000].map(gap => new Date(Date.now() - gap).toISOString());
  problem.fixedOperatorRefs = [theory.view.artifact.envelope.contentRef]; problem.actorModelRefs = [modelRef];
  const rebase = v => { v.sourceRef = modelRef; };
  problem.participants.forEach(p => rebase(p.outsideOption.basis));
  rebase(problem.goal.minimumOwnerValue.basis);
  [...problem.quantityBasis.utilities, problem.quantityBasis.ownerValue].forEach(rebase);
  [...problem.financialLimits.absolutePayments, ...problem.financialLimits.liabilities].forEach(q => rebase(q.basis));
  problem.observationRules.forEach(rule => { rule.sourceRef = modelRef; });
  problem.resourceLimits = Object.fromEntries(theory.request.problem.quantities.map(quantity => [quantity.id, { value: "5",
    basis: { unit: quantity.unit, currency: quantity.currency, owner: quantity.entityId,
      timeBasis: quantity.accountingBasis + ":" + quantity.period.startAt + "/" + quantity.period.endAt,
      rounding: "EXACT", sourceStatus: "SUPPLIED_MODEL", sourceRef: modelRef } }]));
  const before = { available: "3", committed: "2" }, after = { available: "1", committed: "4" };
  for (const model of problem.models) {
    model.qualificationRef = modelRef;
    for (const node of model.nodes) {
      node.resources = { ...(node.kind === "TERMINAL" && node.id.endsWith("-done") ? after : before) };
      if (node.kind === "CHANCE") node.probabilityBasis.identificationRef = modelRef;
    }
  }
  return { problem, before, after };
}

export async function interactionInput(L, admin, tenant, principal, peer, root, theory, label, change) {
  const validUntil = new Date(Date.now() + VALIDITY_MS).toISOString();
  const modelClaim = { key: "supplied:" + label, kind: "SUPPLIED_MODEL_QUALIFICATION", profileDigest: L.contracts.PROFILE_DIGEST,
    modelId: "supplied", exactModelSemantics: "SUPPLIED_NOT_EMPIRICALLY_IDENTIFIED", protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT", validUntil };
  const modelSource = await canonicalClaim(L, admin, tenant, root, modelClaim);
  const { problem, before, after } = interactionProblem(L, principal, peer, theory, modelSource.ref, label);
  change?.(problem);
  const outcomes = problem.models.flatMap(model => model.nodes.filter(node => node.kind === "TERMINAL").map(node => {
    const effectAfter = Object.fromEntries(Object.entries(node.resources));
    return { modelId: model.id, terminalNodeId: node.id, terminalDigest: L.contracts.digest(node), before, after: effectAfter,
      ...(L.contracts.digest(before) === L.contracts.digest(effectAfter) ? { kind: "NO_EFFECT" } :
        { kind: "RIGHT_TRANSITION", operatorId: theory.request.problem.operators.find(o => o.id.startsWith("shift_")).id,
          parameters: { amount: "2" } }) };
  }));
  const lowering = { schema: "finnor.y3.fixed-y1-lowering.v1", theoryId: theory.accepted.theoryId,
    theoryRef: theory.view.artifact.envelope.contentRef, outcomes };
  const specificationClaim = { key: "specification:" + label, kind: "INTERACTION_SPECIFICATION", profileDigest: L.contracts.PROFILE_DIGEST,
    problem, lowering, protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT", validUntil };
  const specificationSource = await canonicalClaim(L, admin, tenant, root, specificationClaim);
  return { request: { schema: "finnor.interaction-request.v1", root, workId: theory.request.workId, problem, lowering,
    sources: [modelSource, specificationSource], idempotencyKey: randomUUID() }, modelSource, specificationSource };
}

export const observationSource = (L, admin, tenant, root, request, participant, date, key, value) =>
  canonicalClaim(L, admin, tenant, root, { key: "observation:" + randomUUID(), kind: "INTERACTION_OBSERVATION",
    problemDigest: L.contracts.digest(request.problem), participant, date, observationKey: key, value, classification: "SOURCED_FACT",
    observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + VALIDITY_MS).toISOString(),
    protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT" });

export function resourceInput(L, tenant, principal, root, horizon, label) {
  const input = L.y1.resourceInput(tenant, principal, root, horizon, label);
  return { ...input, validUntil: new Date(Date.now() + VALIDITY_MS).toISOString() };
}

export const effectMeaning = outcome => outcome.kind === "NO_EFFECT" ? { kind: outcome.kind, before: outcome.before, after: outcome.after } :
  { kind: outcome.kind, operatorId: outcome.operatorId, before: outcome.before, after: outcome.after, parameters: outcome.parameters };
