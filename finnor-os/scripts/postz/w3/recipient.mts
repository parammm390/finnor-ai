/** Real loopback TLS conditional recipient and independent disposable S6 roots.
 * This exercises software egress/readback, not a person, meal, safety inspection
 * or money transfer. Production and field admission are never minted here. */
import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign, randomUUID, type KeyObject } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { canonical, hash } from "../../../packages/private-equity/src/real-world-service/contracts";
import { enterpriseObligationAuthoritySourcePaths } from "../../../packages/private-equity/src/enterprise-obligations";

const bytesHash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const pub = (k: { publicKey: KeyObject }) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const pem = (k: { privateKey: KeyObject }) => k.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const listen = (s: ReturnType<typeof httpServer>) => new Promise<number>((accept, reject) => {
  s.once("error", reject); s.listen(0, "127.0.0.1", () => accept((s.address() as { port: number }).port));
});
const close = (s: ReturnType<typeof httpServer>) => new Promise<void>(done => { s.closeAllConnections(); s.close(() => done()) });
export async function serviceRecipient(input: {
  directory: string; tenantId: string; principalId: string; providerIds: string[]; rightsRef: string;
  ownerCall: (operation: string, body: unknown) => Promise<{ status: number; body: any }>;
  artifact: (name: string, body: unknown) => Promise<unknown>;
}) {
  const root = resolve(input.directory); await mkdir(root, { recursive: true, mode: 0o700 });
  const method = generateKeyPairSync("ed25519"), owner = generateKeyPairSync("ed25519");
  const business = generateKeyPairSync("ed25519"), ledger = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519"), originKey = generateKeyPairSync("ed25519");
  const tokens = Object.fromEntries(["control", "protected", "S5", "S7", "provider", "authority"].map(k => [k, randomUUID() + randomUUID()]));
  const path = (name: string) => join(root, name);
  const secret = async (name: string, value: string) => { await writeFile(path(name), value, { mode: 0o600 }); return path(name) };
  await secret("owner.pem", pem(owner)); await secret("origin.pem", pem(originKey)); await secret("ledger.pem", pem(ledger));
  const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path("tls.key"),
    "-out", path("tls.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  assert.equal(cert.status, 0, cert.stderr); await chmod(path("tls.crt"), 0o600);
  const ca = await readFile(path("tls.crt"), "utf8");
  const records = new Map<string, { applicationAccountId: string; recordKey: string; version: string;
    fields: { serviceTransition: number }; lastOperationId: string | null }>();
  const requests: any[] = [], assessments: any[] = [];
  let loseNext = false, wrongRead = false, killOnPatch: (() => void) | null = null;
  const provider = httpsServer({ key: await readFile(path("tls.key")), cert: ca }, async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw Error("BODY_BOUND") }
      const match = /^\/accounts\/([^/]+)\/records\/(.+)$/.exec(req.url ?? "");
      const account = match?.[1], key = match ? decodeURIComponent(match[2]!) : "";
      const record = records.get(account + "/" + key);
      requests.push({ method: req.method, account, recordKey: key, at: new Date().toISOString(),
        authenticated: req.headers.authorization === "Bearer " + tokens.provider, body: raw ? JSON.parse(raw) : null });
      if (!record || req.headers.authorization !== "Bearer " + tokens.provider) { res.writeHead(403); res.end("{}"); return }
      if (req.method === "PATCH") {
        if (req.headers["if-match"] !== record.version) { res.writeHead(412); res.end("{}"); return }
        const body = JSON.parse(raw);
        assert.deepEqual(Object.keys(body).sort(), ["changes", "operationId"]);
        assert.deepEqual(body.changes, { serviceTransition: .15 }); assert.equal(typeof body.operationId, "string");
        Object.assign(record, { version: '"v2"', fields: body.changes, lastOperationId: body.operationId });
        killOnPatch?.(); killOnPatch = null;
        if (loseNext) { loseNext = false; req.socket.destroy(); return }
      }
      const observed = req.method === "GET" && wrongRead ? { ...record, recordKey: "wrong-original-record" } : record;
      res.writeHead(200, { "content-type": "application/json", etag: record.version }); res.end(JSON.stringify(observed));
    } catch { res.writeHead(400); res.end('{"code":"CONTROLLED_RECIPIENT_REJECTED"}') }
  });
  const providerOrigin = "https://127.0.0.1:" + await listen(provider);
  const authority = httpServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + tokens.authority) { res.writeHead(401); res.end("{}"); return }
    try {
      let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 8388608) throw Error("BODY_BOUND") }
      const operation = req.url?.split("/").at(-1) ?? "";
      if (!["check-budget", "check-dispatch"].includes(operation)) throw Error("UNSUPPORTED_OWNER_CALL");
      const body = JSON.parse(raw), result = await input.ownerCall(operation, body);
      assessments.push({ operation, input: body, status: result.status, assessment: result.body, at: new Date().toISOString() });
      res.writeHead(result.status, { "content-type": "application/json" }); res.end(JSON.stringify(result.body));
    } catch { res.writeHead(503); res.end('{"code":"OWNER_ASSESSMENT_UNAVAILABLE"}') }
  });
  const authorityOrigin = "http://127.0.0.1:" + await listen(authority);
  const digests = (paths: string[]) => Promise.all(paths.map(async p => ({ path: resolve(p), sha256: bytesHash(await readFile(p)) })));
  const fsExt = dirname(createRequire(import.meta.url).resolve("fs-ext/package.json"));
  const sourceDigests = await digests([
    "packages/governed-execution/src/ledger.ts", "packages/governed-execution/src/ledger-server.mts",
    "packages/governed-execution/src/protocol.ts", "packages/governed-execution/src/request-verifier.ts",
    "packages/governed-execution/src/adapter-contract.ts", "packages/governed-execution/src/dispatch-broker.ts",
    "packages/governed-execution/src/broker-io.ts", join(fsExt, "fs-ext.js"),
    join(fsExt, "build/Release/fs_ext.node"), join(fsExt, "package.json"),
  ]);
  const baseOwner = { tenantId: input.tenantId, principalId: input.principalId, rightsRefs: [input.rightsRef],
    append: true, read: true, sealedAppend: false, sealedRead: false };
  const ledgerPolicy = { schema: "finnor.s6.ledger-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
    signerPublicKey: pub(ledger), methodAdmissionPublicKey: pub(method), maxEntries: 100000,
    owners: [
      { ...baseOwner, owner: "S6", tokenHash: bytesHash(tokens.control!), dispatch: true },
      { ...baseOwner, owner: "S6", tokenHash: bytesHash(tokens.protected!), protectedExecution: true },
      ...["S5", "S7"].map(key => ({ ...baseOwner, owner: key, tokenHash: bytesHash(tokens[key]!) })),
    ] };
  const validAfter = new Date(Date.now() - 60000).toISOString();
  const validUntil = new Date(Date.now() + 3600000).toISOString();
  const releaseBody = { schema: "finnor.s6.ledger-release.v3", releaseId: "w3-disposable-" + randomUUID(),
    sourceDigests, runtime: { node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    policyDigest: hash(ledgerPolicy), validUntil };
  const brokerPolicy = { schema: "finnor.s6.dispatch-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY", validUntil,
    protectedTokenPath: await secret("protected.token", tokens.protected!), protectedTokenSha256: bytesHash(tokens.protected!),
    businessOwnerPublicKey: pub(business), authority: { endpoint: authorityOrigin,
      tokenPath: await secret("authority.token", tokens.authority!), tokenSha256: bytesHash(tokens.authority!),
      publicKey: pub(owner), sourceDigests: await digests(enterpriseObligationAuthoritySourcePaths()) },
    routes: input.providerIds.map(applicationAccountId => ({ providerOrigin, applicationAccountId,
      contract: "CONDITIONAL_JSON_RECORD_V1", tokenPath: path("provider.token"),
      tokenSha256: bytesHash(tokens.provider!), caPath: path("tls.crt"), caSha256: bytesHash(ca) })) };
  await secret("provider.token", tokens.provider!);
  await secret("broker.json", JSON.stringify({ policy: brokerPolicy,
    signature: sign(null, Buffer.from(canonical(brokerPolicy)), release.privateKey).toString("base64") }));
  await secret("ledger.json", JSON.stringify({ policy: ledgerPolicy, release: { ...releaseBody,
    signature: sign(null, Buffer.from(canonical(releaseBody)), release.privateKey).toString("base64") },
    signerPath: path("ledger.pem"), protectedDirectory: path("protected"), contentDirectory: path("ordinary"),
    dispatchConfigPath: path("broker.json"), port: 0 }));
  let broker: ChildProcess | null = null, endpoint = "", brokerLog = "";
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
    const p = broker; await new Promise<void>(done => { p.once("exit", () => done()); p.kill(signal) });
  };
  const start = async () => {
    brokerLog = "";
    broker = spawn(process.execPath, ["--import=tsx", "packages/governed-execution/src/ledger-server.mts"], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, FINNOR_S6_LEDGER_CONFIG: path("ledger.json"),
        FINNOR_S6_LEDGER_RELEASE_ROOT: pub(release), FINNOR_S6_DISPATCH_RELEASE_ROOT: pub(release) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { broker?.kill("SIGKILL"); reject(Error("W3_BROKER_START_BOUND")) }, 15000);
      broker!.stdout!.on("data", b => { brokerLog += b;
        for (const line of brokerLog.split("\n")) try { const row = JSON.parse(line);
          if (row.status === "READY") { endpoint = "http://127.0.0.1:" + row.port; clearTimeout(timer); accept() }
        } catch { /* Ordinary log lines are not receipts. */ }
      });
      broker!.stderr!.on("data", b => { brokerLog += b });
      broker!.once("exit", (code, signal) => { clearTimeout(timer); reject(Error("W3_BROKER_EXIT:" + code + ":" + signal + ":" + brokerLog)) });
    });
    const transportPolicy = { schema: "finnor.s6.owner-transport-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
      validAfter, validUntil,
      routes: ["S6", "S5", "S7"].map(semanticOwner => ({ semanticOwner, tenantId: input.tenantId, principalId: input.principalId,
        rightsRefs: [input.rightsRef], originKeys: [{ id: "w3-owner", publicKey: pub(originKey),
          validAfter, validUntil, revoked: false }],
        originSigner: { keyId: "w3-owner", path: path("origin.pem") },
        tokenPath: path(semanticOwner === "S6" ? "control.token" : semanticOwner + ".token"),
        tokenSha256: bytesHash(tokens[semanticOwner === "S6" ? "control" : semanticOwner]!),
        ledger: { endpoint, acceptedReceipts: [{ signerPublicKey: pub(ledger), releaseId: releaseBody.releaseId,
          verifierDigest: hash(sourceDigests), policyDigest: hash(ledgerPolicy) }] },
        requestTimeoutMs: 10000, leaseMs: 30000 })) };
    for (const key of ["control", "S5", "S7"]) await secret(key + ".token", tokens[key]!);
    await secret("transport.json", JSON.stringify({ policy: transportPolicy,
      signature: sign(null, Buffer.from(canonical(transportPolicy)), release.privateKey).toString("base64") }));
    process.env.FINNOR_S6_CURRENT_OWNER_SIGNER = path("owner.pem");
    process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG = path("transport.json");
    process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT = pub(release);
  };
  await start();
  const call = async (route: string, body?: unknown) => {
    const r = await fetch(endpoint + route, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + tokens.control, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json() as any };
  };
  const bind = async (obligation: any, account: string, recordKey: string) => {
    const { ref, ...content } = obligation;
    const accepted = await call("/references", { reference: { ...ref, content }, rightsRefs: [input.rightsRef] });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    records.set(account + "/" + recordKey, { applicationAccountId: account, recordKey, version: '"v1"',
      fields: { serviceTransition: 0 }, lastOperationId: null });
    const bindings = obligation.intervention.channels.map((channel: any) => ({ exposureId: channel.exposureId,
      methodRef: { owner: "S8", id: "method:" + "1".repeat(64), version: "json-field-replace-v1", contentDigest: "1".repeat(64) },
      providerOrigin, applicationAccountId: account, recordKey, field: "serviceTransition", expectedVersion: '"v1"' }));
    const first = await input.ownerCall("compile-request", { obligationRef: ref, bindings });
    assert.equal(first.status, 200, JSON.stringify(first));
    const admissions = obligation.intervention.channels.map((channel: any, i: number) => {
      assert.equal(channel.operation, "SERVICE_TRANSITION_V1"); assert.equal(channel.unit, "service_transition");
      const body = { schema: "finnor.s8.method-admission.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
        tenantId: input.tenantId, principalId: input.principalId, rightsRef: input.rightsRef,
        obligationRef: ref, effectRef: obligation.effectRef, compiler: first.body.ir.compiler, verifierSourceDigests: sourceDigests,
        validAfter: new Date(Date.now() - 1000).toISOString(), validUntil,
        semantic: { exposureId: channel.exposureId, target: channel.target, operation: channel.operation, unit: channel.unit,
          intendedExposure: channel.intendedExposure, permittedRefinements: [], doseRange: [-1, 1] },
        request: { kind: "CONDITIONAL_JSON_FIELDS_REPLACE", providerOrigin, applicationAccountId: account,
          recordKey, field: "serviceTransition", expectedVersion: '"v1"' }, qualification: "CONTROLLED_RECORD_ONLY_NOT_PHYSICAL_SERVICE" };
      const methodRef = { owner: "S8", id: "method:" + hash(body), version: "json-field-replace-v1", contentDigest: hash(body) };
      bindings[i].methodRef = methodRef;
      return { ref: methodRef, body, signature: sign(null, Buffer.from(canonical(body)), method.privateKey).toString("base64") };
    });
    const compiled = await input.ownerCall("compile-request", { obligationRef: ref, bindings });
    assert.equal(compiled.status, 200, JSON.stringify(compiled));
    const request = { ref: compiled.body.ref, ir: compiled.body.ir, admissions };
    const body = { schema: "finnor.business-owner.effect-authorization.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
      tenantId: input.tenantId, principalId: input.principalId, rightsRef: input.rightsRef, obligationRef: ref,
      requestRef: request.ref, effectRef: obligation.effectRef, mandateRef: obligation.mandateRef,
      allocationRef: obligation.allocationRef, consumptionRef: obligation.consumptionRef, resourceEnvelope: obligation.resourceEnvelope,
      validAfter: new Date(Date.now() - 1000).toISOString(), validUntil };
    return { request, authorization: { body, signature: sign(null, Buffer.from(canonical(body)), business.privateKey).toString("base64") } };
  };
  return { bind, requests, assessments, records, sourceDigests,
    loseNextResponse: () => { loseNext = true }, wrongRead: (value: boolean) => { wrongRead = value },
    killNextPatch: (kill: () => void) => { killOnPatch = kill },
    restart: async () => { const previousPid = broker!.pid; await stop("SIGKILL"); await start(); return { previousPid, currentPid: broker!.pid } },
    snapshot: () => ({ requests, assessments, records: [...records.values()], sourceDigests,
      qualification: "CONTROLLED_LOOPBACK_RECORDS_ONLY", fieldValidated: false }),
    close: async () => { await input.artifact("controlled-recipient.json", { requests, assessments,
      records: [...records.values()], sourceDigests, productionActive: false, fieldValidated: false });
      await stop(); await close(provider); await close(authority);
      delete process.env.FINNOR_S6_CURRENT_OWNER_SIGNER; delete process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG;
      delete process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT;
    },
  };
}
