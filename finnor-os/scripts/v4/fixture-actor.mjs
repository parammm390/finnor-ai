/** Independently keyed development actor. No product, checker or expected-answer imports.
 * Administrative IPC is owned by the E2E runner, never exposed to the product.
 * This is not sealed custody, a professional licence, live finance or S8 admission. */
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const role = process.argv[2], { privateKey, publicKey } = generateKeyPairSync("ed25519");
const canonical = x => x === null || typeof x !== "object" ? JSON.stringify(x) : Array.isArray(x)
  ? "[" + x.map(canonical).join(",") + "]" : "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + canonical(x[k])).join(",") + "}";
const hash = x => createHash("sha256").update(typeof x === "string" ? x : canonical(x)).digest("hex");
const signed = body => ({ body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString("base64") });
let config, sequence = 0, server, origin;
const operations = new Map(), calls = [], definitions = new Map();
async function read(req) {
  const buffers = []; let count = 0;
  for await (const chunk of req) { count += chunk.length; if (count > 262144) throw Error("fixture ingress bound"); buffers.push(chunk); }
  return JSON.parse(Buffer.concat(buffers).toString());
}
function source(kind, context, extra = {}) {
  const d = definitions.get(context.programmeId);
  if (!d) throw Error("Original independently administered definition missing");
  return signed({
    schema: "finnor.capital-source-event.v1", eventId: (d.issuerLocalIds ? "event-" : config.id + ":") + (++sequence), issuerId: config.id, issuerRevision: 1, sequence,
    tenantId: d.tenantId, programmeId: context.programmeId, providerEntityId: context.providerEntityId,
    representativeId: context.representativeId, instrument: context.instrument, commitmentIdentity: context.commitmentIdentity,
    operationId: context.operationId ?? null, operationRequestDigest: context.operationRequestDigest ?? null,
    termsDigest: context.terms ? hash(context.terms) : null, kind, observedAt: new Date().toISOString(),
    effectiveAt: d.availableFrom, expiresAt: d.expiresAt, sourceRecord: "independent-development-" + role + ":" + sequence,
    terms: null, identity: null, determination: null, condition: null, funding: null, reason: null,
    cost: { receiptId: d.issuerLocalIds ? "receipt-" + (context.operationId ?? sequence) : "development-" + role + ":" + (context.operationId ?? sequence),
      microUSD: d[role + "CostMicroUSD"] ?? (role === "professional" ? "250" : role === "provider" ? "1000" : "0"),
      final: role === "provider" && context.instrument === "CORPORATE_DEBT" ? d.providerCostFinal !== false : true },
    ...extra,
  });
}
function terms(d, request) {
  if (request.activity === "NEGOTIATE" && request.terms) return structuredClone(request.terms);
  const debt = request.instrument === "CORPORATE_DEBT";
  return {
    providerEntityId: request.providerEntityId, representativeId: request.recipientId, programmeId: request.programmeId,
    instrument: request.instrument, instrumentIdentity: debt ? d.facilityId : d.securityId,
    facilityId: debt ? d.facilityId : null, securityId: debt ? null : d.securityId,
    commitmentIdentity: debt ? "independent-debt-commitment" : "independent-equity-indication", trancheId: "principal",
    amount: { ...d.requirement, amountMinor: debt ? d.debtMinor : d.equityMinor },
    availableFrom: d.availableFrom, drawDeadline: d.expiresAt, expiresAt: d.expiresAt,
    fixedRate: debt ? { numerator: "3", denominator: "100" } : null,
    rateConvention: debt ? "FIXED_RATE_NO_COMPUTED_SCHEDULE" : "NOT_APPLICABLE", financialIRRef: null,
    fees: [], security: [], covenants: [], guarantees: [], crossDefaults: [],
    ownership: debt ? null : { subjectEntityId: d.requirement.legalEntityId, economicShare: { numerator: "1", denominator: "5" },
      votingShare: { numerator: "1", denominator: "5" }, class: "COMMON" },
    conditions: debt && d.conditional ? [{ id: "committee-approval", predicate: "Original provider committee decision is received",
      kind: "PROVIDER_APPROVAL", material: true, responsibleActorId: request.recipientId,
      interpretation: "Original independent provider committee approved the exact executed terms",
      requiredIssuerIds: [config.id], dependencyCommitmentIds: [], waiverActorIds: [], expiry: d.expiresAt }] : [],
    withdrawalRules: ["EXACT_PROVIDER_WITHDRAWAL_OR_EXPIRY_RETAINS_PRIOR_DUTIES"],
    materialObligations: debt ? [{ id: "repayment-on-actual-draw", meaning: "Any actual draw is repayable under the original executed terms",
      accountingDestination: "ENTITY_LIABILITY" }] : [],
    capacityResourceIds: [debt ? "debt-capacity" : "equity-capacity"],
    executionDigest: debt ? hash({ originalIndependentDocument: d.facilityId, programmeId: d.programmeId, amountMinor: d.debtMinor }) : null,
    disclosureRevision: hash(request.disclosures), offeringAuthorityDigest: request.authorityDigest, materialInventoryComplete: true,
  };
}
async function peer(url, context) {
  const r = await fetch(url + "/source", { method: "POST", body: canonical(context), headers: { "content-type": "application/json" } });
  if (!r.ok) throw Error("Independent peer did not attest"); return r.json();
}
async function handle(req, res) {
  try {
    const path = new URL(req.url, origin).pathname;
    if (req.method === "GET" && path === "/health") return send(200, { role, ready: true });
    if (role !== "provider" && req.method === "POST" && path === "/source") {
      const context = await read(req), d = definitions.get(context.programmeId);
      if (!d || context.providerEntityId !== d.providers[context.instrument]?.entityId
        || context.representativeId !== d.providers[context.instrument]?.actorId) throw Error("Independent original provider identity differs");
      if (role === "identity") return send(200, source("IDENTITY_CONFIRMED", context, { identity: {
        legalName: "Hypothetical independently administered " + context.instrument, registryRecord: "DISPOSABLE_REGISTRY_" + context.providerEntityId,
        jurisdiction: "DISPOSABLE_REGISTERED_DOMAIN", providerEligible: d.identityEligible !== false,
        representativeActs: d.identityActs ?? ["APPROACH", "NEGOTIATE", "EXECUTE_COMMITMENT"],
        permittedChannels: ["capital-disposable-http-v1"],
      } }));
      if (role === "professional") return send(200, source("PROFESSIONAL_DETERMINATION", context, { determination: {
        operativeStatus: d.professionalStatus ?? (context.terms.conditions.length ? "BINDING_CONDITIONAL" : "EFFECTIVE"),
        termsDigest: hash(context.terms), materialConditionIds: context.terms.conditions.filter(c => c.material).map(c => c.id),
        unsatisfiedConditionIds: d.professionalSatisfied ? [] : context.terms.conditions.map(c => c.id),
        interpretation: "Exact hypothetical document, actor and complete material condition inventory, not a field legal opinion",
        legalBasisDigest: d.legalBasisDigests[context.instrument], executionEstablished: d.executionEstablished !== false,
        issuerAuthorityEstablished: true, offeringActivityEstablished: true, liabilitiesComplete: true,
      } }));
      throw Error("Unsupported independent source role");
    }
    if (role === "provider" && req.method === "POST" && path === "/operations") {
      const wire = await read(req), request = wire.request, d = definitions.get(request.programmeId);
      if (!d || wire.schema !== "finnor.capital-provider-wire.v1" || wire.requestDigest !== hash(request)
        || request.tenantId !== d.tenantId || request.principalId !== d.principalId
        || request.providerEntityId !== d.providers[request.instrument]?.entityId || request.recipientId !== d.providers[request.instrument]?.actorId
        || request.channelId !== "capital-disposable-http-v1" || request.authorityDigest !== d.authorityDigest
        || !wire.disclosureContents?.length || request.disclosures.some(ref => !wire.disclosureContents.some(raw =>
          raw.evidenceVersionId === ref.evidenceVersionId && hash(raw.content) === ref.contentDigest))) throw Error("Original wire, authority or disclosure differs");
      calls.push({ method: "POST", operationId: wire.operationId, requestDigest: wire.requestDigest, at: new Date().toISOString() });
      if (operations.has(wire.operationId)) return send(409, { duplicateMutation: true });
      const t = terms(d, request), context = { programmeId: request.programmeId, providerEntityId: request.providerEntityId,
        representativeId: request.recipientId, instrument: request.instrument, commitmentIdentity: t.commitmentIdentity,
        operationId: wire.operationId, operationRequestDigest: wire.requestDigest, terms: t };
      const identity = await peer(config.identityOrigin, context), provider = source(
        request.instrument === "CORPORATE_DEBT" ? "COMMITMENT_EXECUTED" : "INDICATION", context, { terms: t });
      const events = [identity, provider];
      if (request.instrument === "CORPORATE_DEBT") events.push(await peer(config.professionalOrigin, context));
      const answer = { schema: "finnor.capital-provider-response.v1", operationId: wire.operationId, requestDigest: wire.requestDigest, events };
      operations.set(wire.operationId, { answer, terms: t, originalRequest: request, rawDisclosureDigest: hash(wire.disclosureContents),
        acceptedAt: new Date().toISOString(), mutationCount: 1 });
      process.send?.({ kind: "ACCEPTED_ORIGINAL_OPERATION", operationId: wire.operationId, programmeId: request.programmeId });
      if (d.responseDelayMs) await new Promise(r => setTimeout(r, d.responseDelayMs));
      return send(200, answer);
    }
    if (role === "provider" && req.method === "GET" && path.startsWith("/operations/")) {
      const id = decodeURIComponent(path.slice("/operations/".length)), existing = operations.get(id);
      calls.push({ method: "GET", operationId: id, at: new Date().toISOString() });
      return send(existing ? 200 : 404, existing?.answer ?? { originalOutcome: "NOT_KNOWN_NOT_NO_EFFECT" });
    }
    send(404, { unavailable: true });
  } catch { send(422, { independentFixtureRejected: true }); }
  function send(status, value) { if (!res.destroyed) { res.writeHead(status, { "content-type": "application/json" }); res.end(canonical(value)); } }
}
process.on("message", async message => {
  const { id, command, value } = message;
  try {
    let result;
    if (command === "INIT") {
      config = value; server = createServer((req, res) => void handle(req, res));
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      origin = "http://127.0.0.1:" + server.address().port;
      result = { id: config.id, actorId: config.actorId, legalEntityId: config.legalEntityId,
        publicKey: publicKey.export({ type: "spki", format: "pem" }), origin, role };
    } else if (command === "DEFINE") { definitions.set(value.programmeId, value); result = { definitionDigest: hash(value) }; }
    else if (command === "SIGN") {
      if (!["authority", "meter"].includes(role)) throw Error("Source actor cannot sign a principal grant");
      result = signed(value);
    } else if (command === "ACTIVITY_REVIEW") {
      if (!["professional", "provider"].includes(role) || value.schema !== "finnor.v4.professional-activity-review.v1") throw Error("Unsupported activity-review challenge");
      result = signed(value);
    } else if (command === "EVENT") result = source(value.kind, value.context, value.extra);
    else if (command === "READBACK") result = { role, operations: [...operations.entries()].map(([operationId, o]) => ({ operationId, ...o })), calls };
    else if (command === "STOP") { server.close(); result = { stopped: true }; }
    else throw Error("Unknown administrative command");
    process.send?.({ kind: "RPC_RESULT", id, result });
  } catch (error) { process.send?.({ kind: "RPC_RESULT", id, error: String(error.message) }); }
});
