// Authoring precedes the checker implementation. These isolated mutation probes
// do not substitute for authenticated HTTP, queue, provider or installed proof.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ClosingSpecSchema, type ClosingObservation, type ClosingSpec } from "@finnor/shared-types";
import { compileClosingGraph } from "../../packages/private-equity/src/closing/compiler";
import { checkClosingTransaction, type ClosingCheckInput } from "../../packages/epistemic-runtime/src/closing-checker";

const out = process.env.FINNOR_V3_EVIDENCE_DIR;
if (!out?.startsWith("/")) throw Error("An absolute fresh FINNOR_V3_EVIDENCE_DIR is required");
await mkdir(out, { recursive: true });
const canonical = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex");
const now = new Date().toISOString(), until = new Date(Date.now() + 3600_000).toISOString();
const tenantId = randomUUID(), transactionId = randomUUID(), actorId = randomUUID(), entityId = randomUUID();
const ref = { owner: "S1", kind: "qualification", id: "independent-test-counsel", version: "1", contentDigest: digest("qualification") };
const actor = { principalId: actorId, legalEntityId: entityId, roleRef: ref };
const rule = (kind: string) => ({ kind, predicateDigest: digest(kind), issuerIds: ["independent"], channels: ["direct-receiving"], maxAgeMs: 3600_000 });
const money = { amount: "120000000.00", currency: "USD", unit: "currency", entityId, asOf: now, timeBasis: "INSTANT", periodEnd: now, rounding: "EXACT" };
const spec: ClosingSpec = ClosingSpecSchema.parse({
  schema: "finnor.closing-spec.v1", tenantId, transactionId, approvedTermsRevision: "terms:1",
  approvedTermsDigest: digest("approved-original-terms"), profileId: "independent-development", environment: "DEVELOPMENT",
  originalGrant: { episodeRef: { ...ref, owner: "P1", kind: "original-work-episode" }, deadlineAt: until, maxSteps: 256, maxHumanSeconds: 900, maxComputeDataIntegrationUsd: "100" },
  documents: [{ key: "purchase-agreement", required: true, dependsOn: [], evidence: rule("DOCUMENT_EXECUTION"), documentId: randomUUID(), documentVersionId: randomUUID(), documentDigest: digest("actual-approved-document"), approvedTermsRevision: "terms:1", signers: [actor] }],
  conditions: [{ key: "legal-condition", required: true, dependsOn: [], evidence: rule("PROFESSIONAL_CONDITION"), canonicalConditionId: null, statement: "Independent counsel establishes the exact condition.", evidenceClass: "PROFESSIONALLY_ATTESTED", professionalScope: "qualified-transaction-counsel", waiver: null }],
  fundsFlows: [{ key: "seller-receipt", required: true, dependsOn: ["legal-condition"], evidence: rule("RECEIVING_SETTLEMENT"), money, payerEntityId: entityId, receivingEntityId: entityId, receivingAccountDigest: digest("independently-validated-seller-account"), beneficiaryRequirementKey: "seller-account", fundingKeys: ["debt", "equity"], purpose: "PURCHASE_PRICE", operationKey: "purchase-wire" }],
  rightsTransfers: [{ key: "shares", required: true, dependsOn: ["seller-receipt"], evidence: rule("RIGHTS_TRANSFER"), fromEntityId: entityId, toEntityId: entityId, rightsDigest: digest("100-percent-exact-share-rights"), quantity: "100", unit: "percent", operationKey: "share-transfer" }],
  legalEffectiveness: [{ key: "effective", required: true, dependsOn: ["shares"], evidence: rule("LEGAL_EFFECTIVENESS"), jurisdiction: "registered", legalBasisDigest: digest("qualified-legal-basis"), professionalScope: "qualified-transaction-counsel", operationKey: null }],
  funding: [
    { key: "debt", required: true, dependsOn: [], evidence: rule("FUNDING_AVAILABLE"), money: { ...money, amount: "80000000" }, facilityDigest: digest("debt"), providerEntityId: entityId, sourceClass: "DEBT_FACILITY", continuingDutyKeys: ["debt-principal"], requiredState: "EFFECTIVE_AVAILABLE", drawOperationKey: "draw" },
    { key: "equity", required: true, dependsOn: [], evidence: rule("FUNDING_AVAILABLE"), money: { ...money, amount: "40000000" }, facilityDigest: digest("equity"), providerEntityId: entityId, sourceClass: "EQUITY_CAPITAL", continuingDutyKeys: [], requiredState: "EFFECTIVE_AVAILABLE", drawOperationKey: null },
  ],
  beneficiaries: [{ key: "seller-account", required: true, dependsOn: [], evidence: rule("BENEFICIARY_VALIDATED"), legalEntityId: entityId, accountDigest: digest("independently-validated-seller-account"), independentValidationChannel: "direct-receiving" }],
  continuingDuties: [{ key: "debt-principal", ownerPrincipalId: actorId, statement: "Own the continuing $80m debt principal and its exact approved scope.", dueAt: until, dependencyKeys: ["canonical:pe_deal:original"],
    liability: { ...money, amount: "80000000" }, obligationRef: null }],
  steps: [], dependencyKeys: ["canonical:pe_deal:original", "rights:tenant"], assumptions: [], unsupportedPredicates: [],
});
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rules = [...spec.documents, ...spec.conditions, ...spec.fundsFlows, ...spec.rightsTransfers, ...spec.legalEffectiveness, ...spec.funding, ...spec.beneficiaries];
const observations = rules.map(r => {
  const claims = r.key === "purchase-agreement" ? { documentId: spec.documents[0]!.documentId, documentVersionId: spec.documents[0]!.documentVersionId, documentDigest: spec.documents[0]!.documentDigest, signers: [actor] }
    : r.key === "seller-receipt" ? { money, receivingEntityId: entityId, accountDigest: spec.beneficiaries[0]!.accountDigest, operationKey: "purchase-wire", receivingState: "SETTLED_RECEIVED" }
    : r.key === "shares" ? { fromEntityId: entityId, toEntityId: entityId, rightsDigest: spec.rightsTransfers[0]!.rightsDigest, quantity: "100", unit: "percent", operationKey: "share-transfer" }
    : r.key === "effective" ? { jurisdiction: "registered", legalBasisDigest: spec.legalEffectiveness[0]!.legalBasisDigest, effective: true }
    : ["debt", "equity"].includes(r.key) ? { money: spec.funding.find(f => f.key === r.key)!.money, facilityDigest: spec.funding.find(f => f.key === r.key)!.facilityDigest,
      sourceClass: spec.funding.find(f => f.key === r.key)!.sourceClass, state: r.key === "debt" ? "SETTLED_DRAW" : "SETTLED_CONTRIBUTION",
      operationKey: spec.funding.find(f => f.key === r.key)!.drawOperationKey, providerEntityId: entityId }
    : r.key === "seller-account" ? { legalEntityId: entityId, accountDigest: spec.beneficiaries[0]!.accountDigest, independentlyValidated: true }
    : { satisfied: true };
  const body = { schema: "finnor.closing-observation.v1", factId: randomUUID(), tenantId, transactionId, specDigest: digest(spec), approvedTermsRevision: spec.approvedTermsRevision, requirementKey: r.key, predicateDigest: r.evidence.predicateDigest, kind: r.evidence.kind, issuerId: "independent", channel: "direct-receiving", actorId, professionalScope: "qualified-transaction-counsel", status: "CONFIRMED", observedAt: now, validUntil: until, claims, supersedesFactIds: [] };
  const observation = { ...body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString("base64") } as ClosingObservation;
  return { ref: { sourceId: randomUUID(), versionId: randomUUID(), versionNumber: 1, contentHash: digest(observation), snapshotHash: digest({ closingObservation: observation }) }, observation };
});
const acceptanceBody = {
  schema: "finnor.closing-observation.v1", factId: randomUUID(), tenantId, transactionId,
  specDigest: digest(spec), approvedTermsRevision: spec.approvedTermsRevision,
  requirementKey: "closing-spec", predicateDigest: digest(spec), kind: "LEGAL_SPEC_ACCEPTANCE",
  issuerId: "independent", channel: "direct-receiving", actorId, professionalScope: "closing-spec",
  status: "CONFIRMED", observedAt: now, validUntil: until,
  claims: { accepted: true, specDigest: digest(spec) }, supersedesFactIds: [],
};
const acceptance = { ...acceptanceBody, signature: sign(null, Buffer.from(canonical(acceptanceBody)), privateKey).toString("base64") } as ClosingObservation;
observations.push({ ref: { sourceId: randomUUID(), versionId: randomUUID(), versionNumber: 1, contentHash: digest(acceptance), snapshotHash: digest({ closingObservation: acceptance }) }, observation: acceptance });
const duty = spec.continuingDuties[0]!, canonicalTaskId = randomUUID();
const input: ClosingCheckInput = {
  spec, graph: compileClosingGraph(spec), observations,
  issuers: [{ id: "independent", actorId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), status: "ACTIVE", kinds: [...rules.map(r => r.evidence.kind), "LEGAL_SPEC_ACCEPTANCE"], channels: ["direct-receiving"], qualifiedScopes: ["qualified-transaction-counsel", "closing-spec"], validUntil: until, environment: "DEVELOPMENT", qualificationRef: ref }],
  operations: [], dutyHandoffs: [{ ...duty, statementDigest: digest(duty.statement), canonicalTaskId, status: "OWNED",
    obligationRef: { ...ref, owner: "S6", kind: "canonical-task-responsibility", id: canonicalTaskId } }],
  currentActorIds: [actorId], validRoleBindings: [{ ref, principalId: actorId, legalEntityIds: [entityId] }],
  currentness: { expectedWorkInputId: "original", currentWorkInputId: "original", approvedTermsRevision: spec.approvedTermsRevision, approvedTermsDigest: spec.approvedTermsDigest, dependenciesCurrent: true, authorityCurrent: true, documentsCurrent: true, legalSpecAccepted: true, profileEnvironment: "DEVELOPMENT", profileCurrent: true, programmeStopped: false },
};
const results: unknown[] = [];
function probe(name: string, candidate: ClosingCheckInput, expected: boolean, reason?: string) {
  const actual = checkClosingTransaction(candidate, now);
  assert.equal(actual.accepted, expected, name);
  if (reason) assert(actual.reasons.some(x => x.includes(reason)), `${name}: ${JSON.stringify(actual.reasons)}`);
  results.push({ name, expected, actual });
}
probe("complete independently signed conjunction", input, true);
for (const node of input.graph.nodes.filter(n => n.kind !== "INDEPENDENT_CLOSE_CHECK")) {
  probe(`compiler omission ${node.key}`, { ...input, graph: { ...input.graph, nodes: input.graph.nodes.filter(n => n.key !== node.key) } }, false, "GRAPH");
}
for (const r of rules) {
  probe(`missing original requirement ${r.key}`, { ...input, observations: observations.filter(o => o.observation.requirementKey !== r.key) }, false);
}
probe("no readback, original draw exposure retained", { ...input, operations: [{ operationKey: "draw", businessEffectId: randomUUID(), status: "UNKNOWN", material: true, originalReservationRef: ref }] }, false, "EXPOSURE");
probe("stale native Work input", { ...input, currentness: { ...input.currentness, currentWorkInputId: "substituted" } }, false, "WORK");
probe("professional issuer revoked", { ...input, issuers: input.issuers.map(i => ({ ...i, status: "REVOKED" })) }, false);
const tampered = structuredClone(input);
tampered.observations.find(o => o.observation.requirementKey === "seller-receipt")!.observation.claims.receivingState = "DEBITED_ONLY";
probe("forged receiving observation", tampered, false);
const source = [
  "scripts/v3/checker-probes.mts", "packages/shared-types/src/closing.ts",
  "packages/epistemic-runtime/src/closing-checker.ts", "packages/private-equity/src/closing/compiler.ts",
];
const files = await Promise.all(source.map(async p => ({ path: p, sha256: digest(await readFile(resolve(import.meta.dirname, "../..", p), "utf8")) })));
await writeFile(resolve(out, "checker-probes.json"), JSON.stringify({
  schema: "finnor.v3.isolated-checker-probes.v1", classification: "DEVELOPMENT_ISOLATED_NOT_RUNTIME_QUALIFICATION",
  command: "FINNOR_V3_EVIDENCE_DIR=<absolute-fresh-dir> node --import=tsx scripts/v3/checker-probes.mts",
  originalSpec: spec, graph: input.graph, observations, input, files, results, passed: true,
}, null, 2), { flag: "wx" });
console.log(JSON.stringify({ passed: true, probes: results.length, evidence: resolve(out, "checker-probes.json") }));
