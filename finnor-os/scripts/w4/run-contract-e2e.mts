import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileOperatingProgram } from "../../packages/private-equity/src/demand-to-business/compiler";
import { checkOperatingProgram } from "../../packages/private-equity/src/demand-to-business/checker";
import { projectOperatingProgram } from "../../packages/private-equity/src/demand-to-business/projection";
import { hash, W4_VERSION, COST_CATEGORIES, type GrowthInput, type EventOriginal,
  type CommercialEvent, type EffectObservation } from "../../packages/private-equity/src/demand-to-business/contracts";

const out = resolve(process.env.FINNOR_W4_EVIDENCE_DIR ?? "/tmp/finnor-w4-contract-evidence-" + Date.now());
await mkdir(out, { recursive: true });
const startedAt = new Date().toISOString(), now = Date.now(), iso = (hours: number) => new Date(now + hours * 3600000).toISOString();
const source = () => ({ sourceId: randomUUID(), versionId: randomUUID(), contentDigest: "a".repeat(64) });
const ref = (owner = "S5") => ({ owner, id: randomUUID(), version: "v1", contentDigest: "b".repeat(64) });
const scope = { tenantId: randomUUID(), principalId: randomUUID(), companyId: randomUUID(), workId: randomUUID(), businessAssignmentId: "unseen-adjacent-workflow" };
const buyers = [randomUUID(), randomUUID()], operator = randomUUID(), accountant = randomUUID(), observer = randomUUID();
const money = (minor: string) => ({ currency: "USD", minor });
const input: GrowthInput = {
  schema: "finnor.growth-outcome.v1", scope, originalMeaning: "Investigate an adjacent workflow and stop if it is not viable",
  mandateSource: source(), validFrom: iso(-1), originalDeadlineAt: iso(240), marketRevision: "market-a",
  currency: "USD", parentPolicy: ref("S4"), parentAllocation: ref(), budgetObligation: ref("S6"),
  question: "Will consenting customers commit to a complete supported workflow at viable terms?", permittedPurpose: "adjacent-workflow",
  permittedCapabilityIds: ["ingest", "reconcile"],
  capabilities: ["ingest", "reconcile"].map((id, i) => ({
    id, name: id, outcomeIds: [i === 0 ? "accepted-input" : "checked-reconciliation"],
    prerequisites: i === 0 ? [] : ["ingest"], source: source(), validUntil: iso(241),
    capacityUnits: 6, committedUnits: 1, supportCapacityUnits: 6, committedSupportUnits: 1,
    unitCost: money(i === 0 ? "200" : "300"), unitSupportCost: money("50"),
    deliveryLeadHours: 12, supportHours: 24, permittedClaims: [id + " within the registered domain"],
    operatorId: operator, operationRef: ref("S6"),
  })),
  demands: [{ id: "month-end", description: "A source-backed unseen reconciliation problem", source: source(),
    outcomeIds: ["accepted-input", "checked-reconciliation"], buyerIds: buyers, existingAlternatives: ["manual reconciliation"],
    selectionBias: ["Existing consenting customers are not a random market sample"], validUntil: iso(241) }],
  population: buyers.map(buyerId => ({ buyerId, customerRef: ref("external_contact"), consentSource: source(),
    affiliation: "UNAFFILIATED_ASSERTED", consentValidUntil: iso(241), permittedPurpose: "adjacent-workflow" })),
  test: { populationSource: source(), protocolSource: source(), independentObservationOwnerId: observer,
    design: "OBSERVATIONAL", causalStatus: "UNIDENTIFIED", s2ProtocolRef: ref("S2"), s3ModelRef: null,
    maxContacts: 2, maxMoney: money("10000"), maxHumanSeconds: 300, closesAt: iso(36),
    minimumCommitments: 2, minimumRepetitions: 2, stopOnIncrementalLoss: true,
    nonresponse: "RETAIN_IN_ORIGINAL_DENOMINATOR", offeredExposure: "ASSIGNED_ONCE_BEFORE_CONTACT", allowedChanges: ["NO_NEW_EXPOSURE"] },
  terms: { revision: "original", minimumContributionMinor: "400", maximumUnitPrice: money("2000"),
    maximumUnitsPerBuyer: 1, refunds: "Refund undelivered value", warranty: "Correct defects during the support window",
    exclusions: ["No regulated or unadmitted operations"], disclosure: "Controlled test, no actual field validation",
    accountingPolicySource: source(), accountingCalendar: "UTC-daily", taxTreatment: "Actual accrual tax expense retained",
    recognition: "DELIVERED_AND_INDEPENDENTLY_ACCEPTED_ACCRUAL" },
  reservedDecisions: [],
};
const identity = { methodDigest: "c".repeat(64), checkerDigest: "d".repeat(64), runtimeDigest: "e".repeat(64) };
const cases: Array<{ id: string; title: string; status: string }> = [];
const check = (id: string, title: string, run: () => void) => { run(); cases.push({ id, title, status: "PASS" }) };
try {
  const program = compileOperatingProgram(input, identity, now);
  const offer = program.offers[0]!;
  check("W033", "Construct fresh complete capability package and preserve original independent protocol", () => {
    assert.equal(program.schema, W4_VERSION); assert.equal(program.validationState, "CANDIDATE");
    assert.equal(program.fieldValidated, false); assert.deepEqual(program.protocol, input.test);
    assert.equal(program.hypotheses[0]!.explanations[0], "NO_VIABLE_DEMAND");
    assert.deepEqual(offer.capabilityIds, ["ingest", "reconcile"]);
    assert.equal(offer.unitLifecycleCost.minor, "600"); assert.equal(offer.unitPrice.minor, "1000");
    assert.equal(program.assignedExposure.length, 2);
    assert.equal(checkOperatingProgram(input, program, identity, now).disposition, "CHECKED_DEVELOPMENT");
    const altered = structuredClone(program); altered.offers[0]!.unitPrice.minor = "1";
    assert.equal(checkOperatingProgram(input, altered, identity, now).disposition, "REJECTED");
    const populationSwap = structuredClone(program); populationSwap.population[0]!.buyerId = randomUUID();
    assert.equal(checkOperatingProgram(input, populationSwap, identity, now).disposition, "REJECTED");
  });
  const events: EventOriginal[] = [], effects: EffectObservation[] = [];
  const record = (body: CommercialEvent, authorId: string, role: EventOriginal["role"], at = iso(1)) => {
    const original: EventOriginal = { ref: source(), body: { ...body, at }, authorId, role, receivedAt: at,
      consentCurrent: true, evidenceClass: "CONTROLLED" }; events.push(original); return original;
  };
  const common = (buyerId: string) => ({ scope, buyerId, offerId: offer.id, termsDigest: offer.termsDigest, at: iso(1) });
  for (const buyerId of buyers) effects.push({ ref: ref("S6"), kind: "OFFER", buyerId, offerId: offer.id,
    termsDigest: offer.termsDigest, state: "VERIFIED", quantity: 1, amount: null, originalIdentityReadback: true });
  check("W034", "Interest is not a commitment, collection, delivery or revenue", () => {
    for (const buyerId of buyers) record({ ...common(buyerId), kind: "RESPONSE", response: "INTEREST", quantity: 1 }, buyerId, "BUYER");
    const p = projectOperatingProgram(input, program, events, effects, now + 2 * 3600000, true);
    assert.equal(p.counts.accepted, 0); assert.equal(p.accounting.recognizedMinor, "0");
    assert.equal(p.accounting.collectedMinor, "0"); assert.equal(p.fieldValidated, false);
  });
  check("W035", "No package when delivery or support cannot fit original obligations", () => {
    const unavailable = structuredClone(input);
    unavailable.capabilities[1]!.committedUnits = unavailable.capabilities[1]!.capacityUnits;
    const noOffer = compileOperatingProgram(unavailable, identity, now);
    assert.equal(noOffer.offers.length, 0); assert.ok(noOffer.gaps.some(s => s.includes("CAPACITY")));
    const noSupport = structuredClone(input);
    noSupport.capabilities[1]!.committedSupportUnits = noSupport.capabilities[1]!.supportCapacityUnits;
    assert.equal(compileOperatingProgram(noSupport, identity, now).offers.length, 0);
  });
  for (const buyerId of buyers) {
    record({ ...common(buyerId), kind: "RESPONSE", response: "ACCEPTED", quantity: 1 }, buyerId, "BUYER");
    const effect = ref("S6");
    effects.push({ ref: effect, kind: "DELIVER", buyerId, offerId: offer.id, termsDigest: offer.termsDigest,
      state: "VERIFIED", quantity: 1, amount: null, originalIdentityReadback: true });
    const delivery = record({ ...common(buyerId), kind: "DELIVERY", quantity: 1, effectRef: effect }, operator, "OPERATOR", iso(12));
    const acceptance = record({ ...common(buyerId), kind: "DELIVERY_ACCEPTANCE", deliveredSourceIds: [delivery.ref.sourceId],
      quantity: 1, accepted: true }, buyerId, "BUYER", iso(13));
    const collection = ref("S6");
    effects.push({ ref: collection, kind: "COLLECT", buyerId, offerId: offer.id, termsDigest: offer.termsDigest,
      state: "VERIFIED", quantity: null, amount: money("1000"), originalIdentityReadback: true });
    record({ ...common(buyerId), kind: "COLLECTION", amount: money("1000"), invoiceRef: ref("S1"),
      accountingRef: ref("S7"), effectRef: collection }, accountant, "ACCOUNTANT", iso(14));
    record({ ...common(buyerId), kind: "RECOGNITION", amount: money("1000"), accountingRef: ref("S7"),
      accountingPolicySource: input.terms.accountingPolicySource, acceptedSourceIds: [acceptance.ref.sourceId] }, accountant, "ACCOUNTANT", iso(14));
  }
  check("W036_COMPONENT", "Controlled exact acceptance/delivery/collection/recognition stays distinct from field and S7 qualification", () => {
    const p = projectOperatingProgram(input, program, events, effects, now + 40 * 3600000, true);
    assert.equal(p.counts.accepted, 2); assert.equal(p.counts.delivered, 2);
    assert.equal(p.accounting.bookingsMinor, "2000"); assert.equal(p.accounting.collectedMinor, "2000");
    assert.equal(p.accounting.recognizedMinor, "2000"); assert.equal(p.fieldValidated, false);
    assert.equal(p.s7ProfitQualified, false); assert.equal(p.accounting.incrementalNetAfterTaxMinor, null);
  });
  for (const category of COST_CATEGORIES) record({ scope, at: iso(15), kind: "COST",
    itemId: "cost-" + category, category, expense: money(category === "ACQUISITION" ? "1500" : category === "CANNIBALIZATION" ? "900" : "0"),
    cash: money(category === "WORKING_CAPITAL" ? "500" : "0"), additionalTerminalLiability: money("0"),
    accountingRef: ref("S7"), treatment: "NO_DUPLICATE_EXPENSE_OR_TERMINAL_LIABILITY" }, accountant, "ACCOUNTANT", iso(15));
  check("W037", "Revenue with loss/cannibalization and complete coordinates stops, working capital is not double-expensed", () => {
    const p = projectOperatingProgram(input, program, events, effects, now + 40 * 3600000, true);
    assert.equal(p.accounting.incrementalNetAfterTaxMinor, "-400"); assert.equal(p.accounting.cashCostMinor, "500");
    assert.equal(p.decision, "STOP"); assert.equal(p.s7ProfitQualified, false);
  });
  check("W038", "Related-party and synthetic responses keep obligations but do not earn independent demand credit", () => {
    const related = structuredClone(input); related.population[0]!.affiliation = "RELATED_PARTY";
    related.population[1]!.affiliation = "SYNTHETIC";
    const relatedProgram = compileOperatingProgram(related, identity, now);
    const p = projectOperatingProgram(related, relatedProgram, events, effects, now + 40 * 3600000, true);
    assert.equal(p.counts.independentEligibleAccepted, 0); assert.equal(p.counts.accepted, 2);
    assert.equal(p.fieldValidated, false); assert.equal(p.accounting.expenseMinor, "2400");
  });
  check("W040", "Market drift stops new exposure and retains original customer identities and obligations", () => {
    const p = projectOperatingProgram(input, program, events, effects, now + 14 * 3600000, false);
    assert.equal(p.currentness, "STALE"); assert.equal(p.decision, "STOP_NEW_EXPOSURE_RETAIN_OBLIGATIONS");
    assert.equal(p.commitments.length, 2);
    assert.ok(p.commitments.every(c => c.continuingObligations.some(x => x.includes("SUPPORT"))));
  });
  check("ADVERSARIAL", "Wrong terms/actor, unsupported accounting, duplicate physical receipts and ambiguous effects cannot qualify", () => {
    const forged = structuredClone(events);
    const accepted = forged.find(e => e.body.kind === "RESPONSE" && e.body.response === "ACCEPTED")!;
    accepted.authorId = scope.principalId;
    const altered = projectOperatingProgram(input, program, forged, effects, now + 40 * 3600000, true);
    assert.equal(altered.counts.accepted, 1); assert.ok(altered.gaps.some(g => g.includes("ACTOR")));
    const ambiguous = effects.map(e => e.kind === "DELIVER" ? { ...e, state: "UNKNOWN" as const } : e);
    const p = projectOperatingProgram(input, program, events, ambiguous, now + 40 * 3600000, true);
    assert.equal(p.counts.delivered, 0); assert.equal(p.accounting.recognizedMinor, "0");
    assert.ok(p.commitments.every(c => c.continuingObligations.some(x => x.includes("DELIVERY"))));
    const duplicate = projectOperatingProgram(input, program, [...events, ...events], effects, now + 40 * 3600000, true);
    assert.equal(duplicate.accounting.recognizedMinor, "2000"); assert.equal(duplicate.accounting.expenseMinor, "2400");
  });
  const paths = ["contracts.ts", "compiler.ts", "checker.ts", "projection.ts"];
  const sources = await Promise.all(paths.map(async p => ({ path: p, digest: hash(await readFile(resolve("packages/private-equity/src/demand-to-business", p), "utf8")) })));
  const artifact = { schema: "finnor.w4.contract-evidence.v1", startedAt, finishedAt: new Date().toISOString(),
    classification: "DETERMINISTICALLY_VERIFIED_CONTROLLED_COMPONENT_CONTRACT_NOT_OWNER_OR_FIELD", sources, cases,
    inputs: input, observedProgram: program, finalProjection: projectOperatingProgram(input, program, events, effects, now + 40 * 3600000, true),
    remainingGates: ["AUTHENTICATED_OWNER_E2E", "MOUNTED", "RECONSTRUCTION", "FIELD", "INDEPENDENT_ADMISSION", "COMPARISON", "ECONOMIC_QUALIFICATION"],
    rerun: "FINNOR_W4_EVIDENCE_DIR=<new-path> npx --no-install tsx scripts/w4/run-contract-e2e.mts" };
  await writeFile(resolve(out, "evidence.json"), JSON.stringify(artifact, null, 2) + "\n");
  console.log(JSON.stringify({ status: "PASS", cases: cases.length, evidence: resolve(out, "evidence.json") }));
} catch (error) {
  await writeFile(resolve(out, "failure.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), cases,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2) + "\n");
  throw error;
}
