/** Disposable, independently observed commercial records. Derived from the W3
 * owning-boundary transport fixture, but with declared W4 fields/units/doses.
 * These are durable software transactions, never real customers or payments. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, randomUUID, type KeyObject } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, rename, open } from "node:fs/promises";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import type { BeliefView } from "@finnor/shared-types";
import { listCanonicalTruthRegistrations, withTenantTransaction } from "@finnor/db";
import { deliverOwnerTransportBatch } from "../../packages/governed-execution/src/owner-delivery-store";
import { canonical, hash } from "../../packages/private-equity/src/demand-to-business/contracts";
import { enterpriseObligationAuthoritySourcePaths } from "../../packages/private-equity/src/enterprise-obligations";

const bytesHash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const publicPem = (k: { publicKey: KeyObject }) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = (k: { privateKey: KeyObject }) => k.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const listen = (s: ReturnType<typeof httpServer>) => new Promise<number>((yes, no) => {
  s.once("error", no); s.listen(0, "127.0.0.1", () => yes((s.address() as { port: number }).port));
});
const close = (s: ReturnType<typeof httpServer>) => new Promise<void>(yes => { s.closeAllConnections(); s.close(() => yes()) });
type RecordState = { applicationAccountId: string; recordKey: string; version: string;
  fields: Record<string, number>; lastOperationId: string | null };
export async function growthRecipient(input: {
  directory: string; tenantId: string; principalId: string; companyId: string; accountIds: string[]; rightsRef: string;
  readCanonicalOwnerView: () => Promise<BeliefView>;
  readCurrentOwnerAuthority: () => Promise<{ employeeId: string; revision: number }>;
  checkBound: () => void;
  ownerCall: (op: string, body: unknown) => Promise<{ status: number; body: any }>;
  artifact: (name: string, body: unknown) => Promise<unknown>;
}) {
  const view = await input.readCanonicalOwnerView();
  assert(view && view.schema === "finnor.belief-view.v1" && view.semanticOwner === "S1", "W4_CANONICAL_OWNER_VIEW_REQUIRED");
  assert(view.tenantId === input.tenantId && view.principalId === input.principalId, "W4_CANONICAL_OWNER_VIEW_SCOPE_MISMATCH");
  assert(view.root?.entityType === "external_organization" && view.root.entityId === input.companyId,
    "W4_CANONICAL_OWNER_VIEW_COMPANY_MISMATCH");
  assert(view.rights?.scope === "CURRENT_AUTHORIZED_RESOURCES"
    && Number.isSafeInteger(view.rights.revision) && view.rights.revision > 0, "W4_CANONICAL_OWNER_RIGHTS_REVISION_REQUIRED");
  assert(typeof view.rights.ref === "string" && view.rights.ref.length > 0 && view.rights.ref.length <= 512
    && !view.rights.ref.includes("*"), "W4_GENUINE_CANONICAL_RIGHTS_REF_REQUIRED");
  assert(typeof view.contentDigest === "string" && /^[a-f0-9]{64}$/.test(view.contentDigest)
    && typeof view.id === "string" && /^belief-view:[a-f0-9]{64}$/.test(view.id)
    && view.id.slice("belief-view:".length) === view.contentDigest, "W4_CANONICAL_OWNER_VIEW_IDENTITY_REQUIRED");
  assert(view.pin?.tenantId === input.tenantId && view.pin.principalId === input.principalId
    && view.pin.root?.entityType === "external_organization" && view.pin.root.entityId === input.companyId
    && view.pin.rightsRevision === view.rights.revision && view.pin.dependencyDigest === view.dependencyDigest,
    "W4_CANONICAL_OWNER_VIEW_PIN_MISMATCH");
  const canonicalOwnerAuthority = Object.freeze({ tenantId: view.tenantId, principalId: view.principalId,
    companyId: view.root.entityId, rightsRef: view.rights.ref, revision: view.rights.revision,
    viewId: view.id, viewContentDigest: view.contentDigest });
  let ownerAuthorityChecks = 0;
  const assertCurrentOwnerAuthority = async () => {
    const current = await input.readCurrentOwnerAuthority();
    assert(current.employeeId === canonicalOwnerAuthority.principalId, "W4_CANONICAL_OWNER_PRINCIPAL_CHANGED");
    assert(Number.isSafeInteger(current.revision) && current.revision === canonicalOwnerAuthority.revision,
      "W4_CANONICAL_OWNER_AUTHORITY_REVISION_CHANGED");
    ownerAuthorityChecks++;
    return { employeeId: current.employeeId, revision: current.revision };
  };
  const initialAuthority = await assertCurrentOwnerAuthority();
  const registrations = await listCanonicalTruthRegistrations(input.tenantId);
  const sourceTypes = new Set(view.claims.map(claim => claim.ownerRef.entityType));
  for (const entityType of ["pe_metric_series", "pe_metric_observation", "evidence_source_version"])
    sourceTypes.add(entityType);
  const sourceOwners = new Map(registrations.filter(row => sourceTypes.has(row.entityType))
    .map(row => [row.entityType, row.writableOwner]));
  assert.equal(sourceOwners.size, sourceTypes.size, "W4_CANONICAL_SOURCE_REGISTRATION_REQUIRED");
  for (const claim of view.claims) assert.equal(claim.ownerRef.owner, sourceOwners.get(claim.ownerRef.entityType),
    "W4_CANONICAL_VIEW_SOURCE_OWNER_MISMATCH");
  const canonicalSourceOwners = [...new Set(sourceOwners.values())].sort();
  const canonicalRightsOwners = [...new Set(["S1", "S2", "S3", ...canonicalSourceOwners])];
  const rightsForOwner = (owner: string) => canonicalRightsOwners.includes(owner)
    ? [input.rightsRef, canonicalOwnerAuthority.rightsRef] : [input.rightsRef];
  await input.artifact("canonical-owner-authority-readback.json", { sourceOperation: "/api/company-brain/belief-view",
    canonicalOwnerAuthority, rights: { ref: view.rights.ref, revision: view.rights.revision,
      evaluatedAt: view.rights.evaluatedAt, scope: view.rights.scope }, initialAuthority, canonicalRightsOwners,
    canonicalSourceOwners: [...sourceOwners.entries()].sort(([left], [right]) => left.localeCompare(right)),
    experienceStatus: view.experience.status, protectedReceiptRecorded: false,
    qualification: "ORDINARY_CANONICAL_READBACK_NOT_EFFECT_AUTHORITY" });
  const ownerCall = async (operation: string, body: unknown) => {
    await assertCurrentOwnerAuthority(); return input.ownerCall(operation, body);
  };
  const root = resolve(input.directory); await mkdir(root, { recursive: true, mode: 0o700 });
  const method = generateKeyPairSync("ed25519"), authorityKey = generateKeyPairSync("ed25519");
  const business = generateKeyPairSync("ed25519"), ledger = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519"), origin = generateKeyPairSync("ed25519");
  const owners = [...new Set([...canonicalSourceOwners, "S1", "S3", "S2", "BUSINESS_OWNER", "S4", "S5", "S6", "S7"])];
  const ownerTokenName = (owner: string) => "owner-" + bytesHash(owner) + ".token";
  const tokens: Record<string, string> = Object.fromEntries([...owners, "protected", "provider", "authority"].map(k => [k, randomUUID() + randomUUID()]));
  const path = (name: string) => join(root, name);
  const secret = async (name: string, value: string) => { await writeFile(path(name), value, { mode: 0o600 }); return path(name) };
  await secret("authority.pem", privatePem(authorityKey)); await secret("origin.pem", privatePem(origin));
  await secret("ledger.pem", privatePem(ledger));
  const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path("tls.key"),
    "-out", path("tls.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  assert.equal(cert.status, 0, cert.stderr); await chmod(path("tls.crt"), 0o600);
  const ca = await readFile(path("tls.crt"), "utf8"), records = new Map<string, RecordState>();
  const declarations = new Map<string, { field: string; value: number }>(), requests: any[] = [], assessments: any[] = [];
  let loseNext = false, wrongRead = false, killOnPatch: (() => void) | null = null, serial = Promise.resolve();
  const persist = async () => {
    const bytes = canonical([...records.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const temporary = path("records-" + randomUUID() + ".tmp");
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await rename(temporary, path("records.json"));
    const directory = await open(root, "r"); try { await directory.sync() } finally { await directory.close() }
  };
  const provider = httpsServer({ key: await readFile(path("tls.key")), cert: ca }, async (req, res) => {
    let unlock: (() => void) | undefined;
    try {
      let raw = ""; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw Error("BODY_BOUND") }
      const previous = serial; serial = new Promise<void>(yes => { unlock = yes }); await previous;
      const match = /^\/accounts\/([^/]+)\/records\/(.+)$/.exec(req.url ?? "");
      const account = match?.[1], key = match ? decodeURIComponent(match[2]!) : "", identity = account + "/" + key;
      const record = records.get(identity), declaration = declarations.get(identity);
      requests.push({ method: req.method, account, recordKey: key, at: new Date().toISOString(),
        authenticated: req.headers.authorization === "Bearer " + tokens.provider, body: raw ? JSON.parse(raw) : null });
      if (!record || !declaration || req.headers.authorization !== "Bearer " + tokens.provider) {
        res.writeHead(403); res.end("{}"); return;
      }
      if (req.method === "PATCH") {
        const body = JSON.parse(raw);
        assert.deepEqual(Object.keys(body).sort(), ["changes", "operationId"]);
        assert.deepEqual(body.changes, { [declaration.field]: declaration.value });
        assert.equal(typeof body.operationId, "string");
        if (req.headers["if-match"] !== record.version) { res.writeHead(412); res.end("{}"); return }
        const old = structuredClone(record);
        Object.assign(record, { version: '"v2"', fields: body.changes, lastOperationId: body.operationId });
        try { await persist() } catch (error) { records.set(identity, old); throw error }
        killOnPatch?.(); killOnPatch = null;
        if (loseNext) { loseNext = false; req.socket.destroy(); return }
      } else assert.equal(req.method, "GET");
      const observed = req.method === "GET" && wrongRead ? { ...record, recordKey: "wrong-original-identity" } : record;
      res.writeHead(200, { "content-type": "application/json", etag: record.version }); res.end(JSON.stringify(observed));
    } catch { res.writeHead(400); res.end('{"code":"CONTROLLED_COMMERCIAL_RECORD_REFUSED"}') }
    finally { unlock?.() }
  });
  const providerOrigin = "https://127.0.0.1:" + await listen(provider);
  const authority = httpServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + tokens.authority) { res.writeHead(401); res.end("{}"); return }
    try {
      let raw = ""; for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 8388608) throw Error("BODY_BOUND") }
      const operation = req.url?.split("/").at(-1) ?? "";
      assert(["check-budget", "check-dispatch"].includes(operation));
      const body = JSON.parse(raw), result = await ownerCall(operation, body);
      assessments.push({ operation, input: body, status: result.status, assessment: result.body, at: new Date().toISOString() });
      res.writeHead(result.status, { "content-type": "application/json" }); res.end(JSON.stringify(result.body));
    } catch { res.writeHead(503); res.end('{"code":"NATIVE_OWNER_ASSESSMENT_UNAVAILABLE"}') }
  });
  const authorityOrigin = "http://127.0.0.1:" + await listen(authority);
  const digests = (paths: string[]) => Promise.all(paths.map(async p => ({ path: resolve(p), sha256: bytesHash(await readFile(p)) })));
  const fsExt = dirname(createRequire(import.meta.url).resolve("fs-ext/package.json"));
  const sourceDigests = await digests(["packages/governed-execution/src/ledger.ts", "packages/governed-execution/src/ledger-server.mts",
    "packages/governed-execution/src/protocol.ts", "packages/governed-execution/src/request-verifier.ts",
    "packages/governed-execution/src/adapter-contract.ts", "packages/governed-execution/src/dispatch-broker.ts",
    "packages/governed-execution/src/broker-io.ts", join(fsExt, "fs-ext.js"), join(fsExt, "build/Release/fs_ext.node"), join(fsExt, "package.json")]);
  const base = { tenantId: input.tenantId, principalId: input.principalId, rightsRefs: [input.rightsRef],
    append: true, read: true, sealedAppend: false, sealedRead: false };
  const ledgerPolicy = { schema: "finnor.s6.ledger-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
    signerPublicKey: publicPem(ledger), methodAdmissionPublicKey: publicPem(method), maxEntries: 100000,
    owners: [...owners.map(owner => ({ ...base, owner, rightsRefs: rightsForOwner(owner), tokenHash: bytesHash(tokens[owner]!),
      ...(owner === "S6" ? { dispatch: true } : {}) })),
      { ...base, owner: "S6", tokenHash: bytesHash(tokens.protected!), protectedExecution: true }] };
  const validAfter = new Date(Date.now() - 60000).toISOString(), validUntil = new Date(Date.now() + 3600000).toISOString();
  const releaseBody = { schema: "finnor.s6.ledger-release.v3", releaseId: "w4-disposable-" + randomUUID(), sourceDigests,
    runtime: { node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    policyDigest: hash(ledgerPolicy), validUntil };
  const brokerPolicy = { schema: "finnor.s6.dispatch-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY", validUntil,
    protectedTokenPath: await secret("protected.token", tokens.protected!), protectedTokenSha256: bytesHash(tokens.protected!),
    businessOwnerPublicKey: publicPem(business), authority: { endpoint: authorityOrigin,
      tokenPath: await secret("authority.token", tokens.authority!), tokenSha256: bytesHash(tokens.authority!),
      publicKey: publicPem(authorityKey), sourceDigests: await digests(enterpriseObligationAuthoritySourcePaths()) },
    routes: input.accountIds.map(applicationAccountId => ({ providerOrigin, applicationAccountId, contract: "CONDITIONAL_JSON_RECORD_V1",
      tokenPath: path("provider.token"), tokenSha256: bytesHash(tokens.provider!), caPath: path("tls.crt"), caSha256: bytesHash(ca) })) };
  await secret("provider.token", tokens.provider!);
  await secret("broker.json", JSON.stringify({ policy: brokerPolicy, signature: sign(null, Buffer.from(canonical(brokerPolicy)), release.privateKey).toString("base64") }));
  const portProbe = httpServer();
  const brokerPort = await listen(portProbe); await close(portProbe);
  await secret("ledger.json", JSON.stringify({ policy: ledgerPolicy, release: { ...releaseBody,
    signature: sign(null, Buffer.from(canonical(releaseBody)), release.privateKey).toString("base64") },
    signerPath: path("ledger.pem"), protectedDirectory: path("protected"), contentDirectory: path("ordinary"),
    dispatchConfigPath: path("broker.json"), port: brokerPort }));
  let broker: ChildProcess | null = null, endpoint = "", brokerLog = "";
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
    const p = broker; await new Promise<void>(yes => { p.once("exit", () => yes()); p.kill(signal) });
  };
  const start = async () => {
    await assertCurrentOwnerAuthority();
    brokerLog = "";
    broker = spawn(process.execPath, ["--import=tsx", "packages/governed-execution/src/ledger-server.mts"], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "test", FINNOR_S6_LEDGER_CONFIG: path("ledger.json"),
        FINNOR_S6_LEDGER_RELEASE_ROOT: publicPem(release), FINNOR_S6_DISPATCH_RELEASE_ROOT: publicPem(release) },
      stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => { broker?.kill("SIGKILL"); no(Error("W4_BROKER_START_BOUND")) }, 15000);
      broker!.stdout!.on("data", b => { brokerLog += b;
        for (const line of brokerLog.split("\n")) try { const row = JSON.parse(line);
          if (row.status === "READY") { endpoint = "http://127.0.0.1:" + row.port; clearTimeout(timer); yes() }
        } catch { /* Logs cannot act as receipts. */ }
      });
      broker!.stderr!.on("data", b => { brokerLog += b });
      broker!.once("exit", (code, signal) => { clearTimeout(timer); no(Error("W4_BROKER_EXIT:" + code + ":" + signal + ":" + brokerLog)) });
    });
    for (const owner of owners) await secret(ownerTokenName(owner), tokens[owner]!);
    const transportPolicy = { schema: "finnor.s6.owner-transport-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY", validAfter, validUntil,
      routes: owners.map(semanticOwner => ({ semanticOwner, tenantId: input.tenantId, principalId: input.principalId,
        rightsRefs: rightsForOwner(semanticOwner), originKeys: [{ id: "w4-owner", publicKey: publicPem(origin), validAfter, validUntil, revoked: false }],
        originSigner: { keyId: "w4-owner", path: path("origin.pem") }, tokenPath: path(ownerTokenName(semanticOwner)),
        tokenSha256: bytesHash(tokens[semanticOwner]!), ledger: { endpoint, acceptedReceipts: [{ signerPublicKey: publicPem(ledger),
          releaseId: releaseBody.releaseId, verifierDigest: hash(sourceDigests), policyDigest: hash(ledgerPolicy) }] },
        requestTimeoutMs: 10000, leaseMs: 30000 })) };
    await secret("transport.json", JSON.stringify({ policy: transportPolicy,
      signature: sign(null, Buffer.from(canonical(transportPolicy)), release.privateKey).toString("base64") }));
    process.env.FINNOR_S6_CURRENT_OWNER_SIGNER = path("authority.pem");
    process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG = path("transport.json"); process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT = publicPem(release);
  };
  try { await start() }
  catch (error) { await stop(); await close(provider); await close(authority); throw error }
  let drainNumber = 0;
  const drainNativeReferences = async (minimumPendingPerOwner = 0) => {
    const batches = [];
    const unresolved = () => withTenantTransaction(input.tenantId, { userId: input.principalId, readOnly: true }, async (_db, c) =>
      (await c.query<{ owner: string; identity: string; status: string; lastError: string | null; due: Date }>(
        `SELECT semantic_owner owner,identity,status,last_error "lastError",
          CASE WHEN status='CLAIMED' THEN lease_until ELSE next_attempt_at END due
         FROM finnor_os.s6_owner_delivery_states WHERE tenant_id=$1 AND principal_id=$2
         AND semantic_owner=ANY($3::text[]) AND status<>'ACCEPTED'
         ORDER BY semantic_owner,identity LIMIT 16385`, [input.tenantId, input.principalId, owners])).rows);
    let pending = await unresolved();
    if (minimumPendingPerOwner > 0) {
      const counts = new Map<string, number>();
      for (const row of pending) counts.set(row.owner, (counts.get(row.owner) ?? 0) + 1);
      const requiresRecovery = pending.some(row => row.status === "REFUSED_ORIGIN" || row.status === "REQUIRES_OPERATOR");
      if (!requiresRecovery && [...counts.values()].every(count => count < minimumPendingPerOwner)) return;
    }
    await assertCurrentOwnerAuthority();
    for (let round = 0; pending.length && round < 8; round++) {
      assert(pending.length <= 16384, "W4_NATIVE_DELIVERY_POPULATION_BOUND");
      assert(pending.every(row => !["REFUSED_ORIGIN", "REQUIRES_OPERATOR"].includes(row.status)),
        "W4_NATIVE_DELIVERY_REQUIRES_OWNER_RECOVERY");
      for (const semanticOwner of owners) {
        for (let batch = 0; batch < 8; batch++) {
          input.checkBound();
          const report = await deliverOwnerTransportBatch({ semanticOwner,
            tenantId: input.tenantId, principalId: input.principalId }, { limit: 32 });
          batches.push({ round, semanticOwner, report });
          if (!report.inspected) break;
        }
      }
      pending = await unresolved();
      if (pending.length && round < 7) {
        const dueAt = Math.min(...pending.map(row => row.due.getTime()));
        while (dueAt > Date.now()) {
          input.checkBound();
          await new Promise(done => setTimeout(done, Math.min(30000, dueAt - Date.now() + 25)));
        }
        input.checkBound();
      }
    }
    const unresolvedOrigins = pending.length ? await withTenantTransaction(input.tenantId,
      { userId: input.principalId, readOnly: true }, async (_db, c) => (await c.query(
        `SELECT o.semantic_owner,o.kind,o.identity,o.payload_digest,o.envelope,o.signature
         FROM finnor_os.s6_owner_delivery_origins o JOIN finnor_os.s6_owner_delivery_states s
         USING(tenant_id,principal_id,semantic_owner,kind,identity)
         WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.semantic_owner=ANY($3::text[])
         AND s.status<>'ACCEPTED' ORDER BY o.semantic_owner,o.identity LIMIT 16385`,
        [input.tenantId, input.principalId, owners])).rows) : [];
    assert(unresolvedOrigins.length <= 16384, "W4_NATIVE_DELIVERY_ORIGIN_POPULATION_BOUND");
    await input.artifact("native-deliveries/" + (++drainNumber) + ".json", { batches, unresolved: pending,
      unresolvedOrigins, consumerRights: owners.map(owner => ({ owner, rightsRefs: rightsForOwner(owner) })),
      authorityGranted: false, qualification: "ORDINARY_SIGNED_OUTBOX_TO_SEPARATE_DISPOSABLE_LEDGER" });
    assert.equal(pending.length, 0, "W4_NATIVE_DELIVERY_UNRESOLVED");
  };
  const call = async (route: string, body: unknown) => {
    const r = await fetch(endpoint + route, { method: "POST", headers: { authorization: "Bearer " + tokens.S6, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json() as any };
  };
  const bind = async (obligation: any, account: string, recordKey: string,
    declaration = { field: "serviceTransition", value: .15, unit: "service_transition" }) => {
    await assertCurrentOwnerAuthority();
    assert.equal(obligation.intervention.channels.length, 1); const channel = obligation.intervention.channels[0];
    assert.equal(channel.operation, "SERVICE_TRANSITION_V1"); assert.equal(channel.unit, declaration.unit);
    assert.deepEqual(channel.doses, [declaration.value]); assert(input.accountIds.includes(account));
    const { ref, ...content } = obligation;
    const accepted = await call("/references", { reference: { ...ref, content }, rightsRefs: [input.rightsRef] });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    const identity = account + "/" + recordKey;
    assert(!records.has(identity), "W4_PROVIDER_ORIGINAL_RECORD_IDENTITY_ALREADY_BOUND");
    declarations.set(identity, declaration);
    records.set(identity, { applicationAccountId: account, recordKey, version: '"v1"',
      fields: { [declaration.field]: 0 }, lastOperationId: null }); await persist();
    const binding = { exposureId: channel.exposureId, methodRef: { owner: "S8", id: "method:" + "1".repeat(64),
      version: "json-field-replace-v1", contentDigest: "1".repeat(64) }, providerOrigin, applicationAccountId: account,
      recordKey, field: declaration.field, expectedVersion: '"v1"' };
    const first = await ownerCall("compile-request", { obligationRef: ref, bindings: [binding] });
    assert.equal(first.status, 200, JSON.stringify(first));
    const admission = { schema: "finnor.s8.method-admission.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
      tenantId: input.tenantId, principalId: input.principalId, rightsRef: input.rightsRef, obligationRef: ref,
      effectRef: obligation.effectRef, compiler: first.body.ir.compiler, verifierSourceDigests: sourceDigests,
      validAfter: new Date(Date.now() - 1000).toISOString(), validUntil,
      semantic: { exposureId: channel.exposureId, target: channel.target, operation: channel.operation, unit: channel.unit,
        intendedExposure: channel.intendedExposure, permittedRefinements: [], doseRange: [declaration.value, declaration.value] },
      request: { kind: "CONDITIONAL_JSON_FIELDS_REPLACE", providerOrigin, applicationAccountId: account,
        recordKey, field: declaration.field, expectedVersion: '"v1"' },
      qualification: "CONTROLLED_DURABLE_COMMERCIAL_RECORD_NOT_REAL_CASH_OR_FIELD_DEMAND" };
    const methodRef = { owner: "S8", id: "method:" + hash(admission), version: "json-field-replace-v1", contentDigest: hash(admission) };
    binding.methodRef = methodRef;
    const compiled = await ownerCall("compile-request", { obligationRef: ref, bindings: [binding] });
    assert.equal(compiled.status, 200, JSON.stringify(compiled));
    const request = { ref: compiled.body.ref, ir: compiled.body.ir, admissions: [{ ref: methodRef, body: admission,
      signature: sign(null, Buffer.from(canonical(admission)), method.privateKey).toString("base64") }] };
    const authorization = { schema: "finnor.business-owner.effect-authorization.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
      tenantId: input.tenantId, principalId: input.principalId, rightsRef: input.rightsRef, obligationRef: ref, requestRef: request.ref,
      effectRef: obligation.effectRef, mandateRef: obligation.mandateRef, allocationRef: obligation.allocationRef,
      consumptionRef: obligation.consumptionRef, resourceEnvelope: obligation.resourceEnvelope,
      validAfter: new Date(Date.now() - 1000).toISOString(), validUntil };
    return { request, authorization: { body: authorization,
      signature: sign(null, Buffer.from(canonical(authorization)), business.privateKey).toString("base64") } };
  };
  return { bind, requests, assessments, records, sourceDigests, assertCurrentOwnerAuthority, drainNativeReferences, loseNextResponse: () => { loseNext = true },
    wrongRead: (v: boolean) => { wrongRead = v }, killNextPatch: (kill: () => void) => { killOnPatch = kill },
    reloadRecords: async () => { const original = [...records.entries()];
      const stored = JSON.parse(await readFile(path("records.json"), "utf8")); assert.deepEqual(stored, original.sort(([a], [b]) => a.localeCompare(b)));
      records.clear(); for (const [key, record] of stored) records.set(key, record); return { durableRecords: records.size }; },
    restart: async () => {
      await assertCurrentOwnerAuthority();
      const previousPid = broker!.pid, previous = broker!, originalEndpoint = endpoint;
      await stop("SIGKILL"); assert.equal(previous.signalCode, "SIGKILL");
      await start(); assert.equal(endpoint, originalEndpoint); assert.notEqual(broker!.pid, previousPid);
      return { previousPid, currentPid: broker!.pid, signal: previous.signalCode, endpointPreserved: true,
        issuerKeyDigest: bytesHash(publicPem(origin)), ledgerDirectoryDigest: hash([path("protected"), path("ordinary")]) };
    },
    snapshot: () => ({ requests, assessments, records: [...records.values()], sourceDigests, canonicalOwnerAuthority, ownerAuthorityChecks,
      qualification: "CONTROLLED_DURABLE_RECORDS_ONLY", fieldValidated: false }),
    close: async () => { await input.artifact("w4-controlled-recipient.json", { requests, assessments,
      records: [...records.values()], sourceDigests, canonicalOwnerAuthority, ownerAuthorityChecks, productionActive: false, fieldValidated: false });
      await stop(); await close(provider); await close(authority);
      delete process.env.FINNOR_S6_CURRENT_OWNER_SIGNER; delete process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG; delete process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT; },
  };
}
