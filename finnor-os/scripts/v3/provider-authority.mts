/** Independently administered, durable local receiving/signature/registry oracle.
 * No production interpretation, compiler, checker or expected-receipt imports.
 * Hypothetical DEVELOPMENT facts do not qualify a provider or a professional. */
import assert from "node:assert/strict";
import { createHash, createPrivateKey, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve(process.argv[2] ?? "");
const permissions = await stat(file);
assert.equal(permissions.mode & 0o077, 0, "Fixture private custody must be owner-only");
const config = JSON.parse(await readFile(file, "utf8"));
const canonical = (v: any): string => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort((a, b) => a.localeCompare(b)).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const hash = (v: any) => createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : canonical(v)).digest("hex");
const equal = (a: any, b: any) => canonical(a) === canonical(b);
const money = (s: string) => {
  assert(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(s), "Exact independent decimal required");
  const [whole, part = ""] = s.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(part.padEnd(18, "0"));
};
const programmes = new Map<string, any>();
const requests: any[] = [];
let gateReads = false;
const journal = await open(config.journal, "ax", 0o600);
async function record(body: unknown) {
  await journal.write(JSON.stringify({ recordedAt: new Date().toISOString(), ...body as object }) + "\n");
  await journal.sync();
}
function signed(s: any, requirement: any, kind: string, issuerId: string, claims: any, extra: any = {}) {
  const issuer = s.issuers.find((i: any) => i.id === issuerId);
  assert(issuer);
  const body = {
    schema: "finnor.closing-observation.v1", factId: randomUUID(),
    tenantId: s.spec.tenantId, transactionId: s.spec.transactionId, specDigest: s.digest,
    approvedTermsRevision: s.spec.approvedTermsRevision, requirementKey: requirement.key,
    predicateDigest: requirement.evidence.predicateDigest, kind, issuerId, channel: requirement.evidence.channels[0],
    actorId: issuer.actorId, professionalScope: null, status: "CONFIRMED",
    observedAt: new Date().toISOString(), validUntil: s.spec.originalGrant.deadlineAt, claims,
    supersedesFactIds: [], ...extra,
  };
  return { ...body, signature: sign(null, Buffer.from(canonical(body)), createPrivateKey(config.privateKeys[issuerId])).toString("base64") };
}
function originalOperation(s: any, key: string) {
  const step = s.spec.steps.find((r: any) => r.key === key);
  assert(step, "Unknown original step");
  let r: any, op: any;
  if (step.kind === "REQUEST_SIGNATURE") {
    r = s.spec.documents.find((r: any) => r.key === step.requirementKey);
    const bytes = Buffer.from(s.documents[r.documentId], "base64");
    assert.equal(hash(bytes), r.documentDigest, "Frozen document bytes changed");
    op = { kind: step.kind, documentId: r.documentId, documentVersionId: r.documentVersionId, documentDigest: hash(bytes), signers: r.signers };
  } else if (step.kind === "DRAW_FUNDS") {
    r = s.spec.funding.find((r: any) => r.key === step.requirementKey);
    op = { kind: step.kind, operationKey: r.drawOperationKey, facilityDigest: r.facilityDigest,
      money: r.money, providerEntityId: r.providerEntityId, sourceClass: r.sourceClass };
  } else if (step.kind === "PAY_FUNDS") {
    r = s.spec.fundsFlows.find((r: any) => r.key === step.requirementKey);
    op = { kind: step.kind, operationKey: r.operationKey, money: r.money, payerEntityId: r.payerEntityId,
      receivingEntityId: r.receivingEntityId, receivingAccountDigest: r.receivingAccountDigest, purpose: r.purpose };
  } else if (step.kind === "TRANSFER_RIGHTS") {
    r = s.spec.rightsTransfers.find((r: any) => r.key === step.requirementKey);
    op = { kind: step.kind, operationKey: r.operationKey, fromEntityId: r.fromEntityId, toEntityId: r.toEntityId,
      rightsDigest: r.rightsDigest, quantity: r.quantity, unit: r.unit };
  } else {
    assert.equal(step.kind, "FILE");
    r = s.spec.legalEffectiveness.find((r: any) => r.key === step.requirementKey);
    op = { kind: step.kind, operationKey: r.operationKey, jurisdiction: r.jurisdiction, legalBasisDigest: r.legalBasisDigest };
  }
  return { step, requirement: r, operation: op };
}
async function mutate(s: any, body: any) {
  const { step, requirement: r, operation } = originalOperation(s, body.nodeKey);
  assert.equal(body.schema, "finnor.s6.closing-operation.v1");
  assert.equal(body.tenantId, s.spec.tenantId); assert.equal(body.transactionId, s.spec.transactionId);
  assert.equal(body.specDigest, s.digest); assert.equal(body.environment, "DEVELOPMENT");
  assert.equal(body.approvedTermsRevision, s.spec.approvedTermsRevision);
  assert.equal(body.approvedTermsDigest, s.spec.approvedTermsDigest);
  assert.equal(body.requirementKey, r.key); assert.equal(body.predicateDigest, r.evidence.predicateDigest);
  assert(equal(body.actor, step.actor) && equal(body.operation, operation), "Physical request differs from frozen original agreement");
  assert(!s.effects.has(body.businessEffectId), "A second physical POST is prohibited, even if economically idempotent");
  const claims: any = { businessEffectId: body.businessEffectId };
  let issuerId: string;
  if (step.kind === "REQUEST_SIGNATURE") {
    Object.assign(claims, { documentId: r.documentId, documentVersionId: r.documentVersionId,
      documentDigest: r.documentDigest, signers: r.signers });
    if (s.fault === "wrong-signer") claims.signers = [r.signers[0]];
    issuerId = "document-authority"; s.signed = true;
  } else if (step.kind === "DRAW_FUNDS") {
    assert(s.signed, "Bank cannot draw before actual document execution");
    assert(!s.drawn, "Original facility cannot be drawn twice");
    s.balance += money(r.money.amount); s.drawn = true;
    Object.assign(claims, { money: r.money, facilityDigest: r.facilityDigest, providerEntityId: r.providerEntityId,
      sourceClass: r.sourceClass, operationKey: r.drawOperationKey, state: "SETTLED_DRAW" });
    issuerId = "receiving-authority";
  } else if (step.kind === "PAY_FUNDS") {
    assert(s.drawn && s.balance >= money(r.money.amount), "Receiving ledger has no settled funds for payment");
    s.balance -= money(r.money.amount); s.received += money(r.money.amount);
    Object.assign(claims, { money: r.money, receivingEntityId: r.receivingEntityId,
      accountDigest: r.receivingAccountDigest, operationKey: r.operationKey, receivingState: "SETTLED_RECEIVED" });
    if (s.fault === "wrong-beneficiary") claims.accountDigest = "0".repeat(64);
    if (s.fault === "partial-settlement") {
      claims.money = { ...r.money, amount: "119999999.99" }; claims.receivingState = "PARTIAL";
    }
    issuerId = "receiving-authority";
  } else if (step.kind === "TRANSFER_RIGHTS") {
    assert(s.received === money("120000000"), "Registry cannot transfer before full independent receiving settlement");
    s.transferred = true;
    Object.assign(claims, { fromEntityId: r.fromEntityId, toEntityId: r.toEntityId,
      rightsDigest: r.rightsDigest, quantity: r.quantity, unit: r.unit, operationKey: r.operationKey });
    issuerId = "registry-authority";
  } else {
    assert(s.transferred, "Legal filing cannot precede rights transfer"); s.effective = true;
    Object.assign(claims, { effective: true, jurisdiction: r.jurisdiction,
      legalBasisDigest: r.legalBasisDigest, operationKey: r.operationKey });
    issuerId = "counsel-authority";
  }
  const observation = signed(s, r, r.evidence.kind, issuerId, claims, {
    professionalScope: step.kind === "FILE" ? r.professionalScope : null,
    supersedesFactIds: step.kind === "DRAW_FUNDS" ? [s.initialDebtFactId] : [],
  });
  s.effects.set(body.businessEffectId, observation);
  await record({ type: "ACCEPTED", tenantId: s.spec.tenantId, transactionId: s.spec.transactionId,
    businessEffectId: body.businessEffectId, nodeKey: step.key, kind: step.kind, request: body, observation,
    ledger: { borrowerBalanceExact18: String(s.balance), sellerReceivedExact18: String(s.received),
      drawn: s.drawn, rightsTransferred: s.transferred, legallyEffective: s.effective },
    responseWithheld: step.kind === "DRAW_FUNDS" && s.fault === "lost-draw" });
  return { observation, withhold: step.kind === "DRAW_FUNDS" && s.fault === "lost-draw" };
}
async function json(req: any) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert(size <= 1024 * 1024); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
  try {
    const supplied = req.headers.authorization ?? "", expected = `Bearer ${config.token}`;
    assert(Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
    if (req.url === "/__fixture/register" && req.method === "POST") {
      const input = await json(req);
      assert.equal(input.spec.environment, "DEVELOPMENT");
      const digest = hash(input.spec); assert.equal(digest, input.digest);
      assert(!programmes.has(digest));
      programmes.set(digest, { ...input, balance: money("40000000"), received: 0n, drawn: false,
        signed: false, transferred: false, effective: false, effects: new Map() });
      await record({ type: "REGISTERED", digest, input: { ...input, documents: Object.keys(input.documents) } });
      res.end('{"registered":true}'); return;
    }
    if (req.url === "/__fixture/read-gate" && req.method === "POST") {
      const input = await json(req);
      gateReads = Boolean(input.blocked);
      await record({ type: "DRAW_READ_GATE", blocked: gateReads, nodeKey: "draw-debt" });
      res.end(JSON.stringify({ gateReads, nodeKey: "draw-debt" })); return;
    }
    if (req.url === "/__fixture/requalify" && req.method === "POST") {
      const input = await json(req), original = programmes.get(input.originalDigest);
      assert(original?.effective && original.drawn && original.transferred);
      assert.equal(hash(input.spec), input.digest);
      assert(equal({ ...original.spec, assumptions: input.spec.assumptions }, input.spec),
        "Re-attestation cannot alter original effects, money, documents, actors or grants");
      const current = { ...original, spec: input.spec, digest: input.digest };
      const observations = [...original.effects.entries()].map(([effectId, observation]) => {
        const nodeKey = requests.find(request => request.effectId === effectId)?.nodeKey;
        const { requirement } = originalOperation(original, nodeKey);
        return signed(current, requirement, observation.kind, observation.issuerId, observation.claims,
          { professionalScope: observation.professionalScope });
      });
      await record({ type: "ORIGINAL_PHYSICAL_FACTS_REATTESTED", originalDigest: input.originalDigest,
        currentDigest: input.digest, observations, requestCountUnchanged: requests.length });
      res.end(JSON.stringify({ observations, requestCount: requests.length })); return;
    }
    if (req.url === "/__fixture/state" && req.method === "GET") {
      res.end(JSON.stringify({ requests, programmes: [...programmes.values()].map(s => ({
        digest: s.digest, tenantId: s.spec.tenantId, transactionId: s.spec.transactionId,
        borrowerBalanceExact18: String(s.balance), sellerReceivedExact18: String(s.received),
        drawn: s.drawn, rightsTransferred: s.transferred, legallyEffective: s.effective,
        effects: [...s.effects.entries()].map(([businessEffectId, observation]) => ({ businessEffectId, observation })),
      })) })); return;
    }
    const match = req.url?.match(/^\/v1\/accounts\/disposable-account\/closing-operations\/([a-f0-9-]{36})$/);
    assert(match, "Unsupported fixture interface");
    const effectId = match[1];
    if (req.method === "GET") {
      const fact = [...programmes.values()].flatMap(s => [...s.effects.entries()]).find(([id]) => id === effectId);
      const nodeKey = requests.find(request => request.effectId === effectId)?.nodeKey;
      if (gateReads && nodeKey === "draw-debt") { res.writeHead(404); res.end('{"observed":false}'); return; }
      if (!fact) { res.writeHead(404); res.end('{"observed":false}'); return; }
      res.end(JSON.stringify(fact[1])); return;
    }
    assert.equal(req.method, "POST");
    const body = await json(req); assert.equal(body.businessEffectId, effectId);
    requests.push({ effectId, nodeKey: body.nodeKey, specDigest: body.specDigest, at: new Date().toISOString() });
    await record({ type: "PHYSICAL_POST", requestOrdinal: requests.length, body });
    const s = programmes.get(body.specDigest); assert(s, "Unknown independently frozen agreement");
    const result = await mutate(s, body);
    if (result.withhold) { req.on("close", () => undefined); return; }
    res.writeHead(202); res.end(JSON.stringify({ accepted: true, businessEffectId: effectId, acknowledgementIsNotSettlement: true }));
  } catch (error) {
    await record({ type: "REJECTED", message: error instanceof Error ? error.message : String(error) });
    res.writeHead(409); res.end('{"error":"DISPOSABLE_ORIGINAL_AGREEMENT_REJECTED"}');
  }
});
server.listen(config.port, "127.0.0.1", () => console.log(JSON.stringify({ role: "independent-development-provider", ready: true })));
process.on("SIGTERM", () => {
  server.closeAllConnections(); server.close(async () => { await journal.close(); process.exit(0); });
});
