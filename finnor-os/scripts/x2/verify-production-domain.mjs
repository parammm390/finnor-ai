/** Pre-repair production-Node guard probe. No admission or effect is issued. */
import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign, createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, fixture, destination] = process.argv.slice(2);
if (![runtime, fixture, destination].every(path => path?.startsWith("/"))) throw Error("ABSOLUTE_PROBE_PATHS_REQUIRED");
mkdirSync(destination, { mode: 0o700 });
const privateDir = join(destination, "private"); mkdirSync(privateDir, { mode: 0o700 });
const json = path => JSON.parse(readFileSync(path, "utf8"));
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const hash = value => createHash("sha256").update(value).digest("hex");
const freeze = json(join(fixture, "freeze.json")), originalRoot = freeze.repoRoot;
const relocate = path => {
  if (!path.startsWith(originalRoot + "/")) throw Error("UNDECLARED_PROBE_SOURCE_PATH");
  return join(runtime, path.slice(originalRoot.length + 1));
};
const sourcePins = freeze.sourcePins.map(pin => ({ path: relocate(pin.path), sha256: pin.sha256 }));
for (const pin of sourcePins) assert.equal(hash(readFileSync(pin.path)), pin.sha256, "PROBE_SOURCE_PREIMAGE_REQUIRED");
const sourcePolicy = json(join(fixture, "s8/config.json")).signedPolicy.body;
const lifecycleSourcePins = sourcePolicy.sourcePins.map(pin => ({path:relocate(pin.path),sha256:pin.sha256}));
for(const pin of lifecycleSourcePins) assert.equal(hash(readFileSync(pin.path)),pin.sha256,"PROBE_LIFECYCLE_SOURCE_PREIMAGE_REQUIRED");
assert(Date.parse(sourcePolicy.validUntil) > Date.now(), "ORIGINAL_POLICY_EXPIRED_NOT_A_GUARD_PROOF");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = body => ({ body, keyId: "ordinary-x2-domain-probe",
  signature: sign(null, Buffer.from(canonical(body)), keys.privateKey).toString("base64") });
const policy = { ...sourcePolicy, sourcePins:lifecycleSourcePins, applicationSemantics: { ...sourcePolicy.applicationSemantics, sourceRoot: runtime, sourcePins } };
const configPath = join(privateDir, "lifecycle.json");
writeFileSync(configPath, JSON.stringify({ signedPolicy: signed(policy), directory: join(privateDir, "journal"),
  signerPath: join(fixture, "journal.pem") }), { mode: 0o600, flag: "wx" });
const reservePort = () => new Promise((yes, no) => {
  const server = createServer(); server.once("error", no); server.listen(0, "127.0.0.1", () => {
    const address = server.address(); server.close(() => yes(address.port));
  });
});
const port = await reservePort(), ledgerPort = await reservePort();
const origin = "http://127.0.0.1:" + port;
const consumer = { ...json(join(fixture, "consumer-policy-1.json")).body,
  sourceRoot: runtime, sourcePins, endpoint: origin };
const consumerPath = join(privateDir, "consumer.json");
writeFileSync(consumerPath, JSON.stringify(signed(consumer)), { flag: "wx", mode: 0o600 });
const ledgerConfig = json(join(fixture, "s6/config.json"));
const ledgerRelease = { ...ledgerConfig.release, releaseId: "x2-domain-probe:" + randomUUID(),
  sourceDigests: ledgerConfig.release.sourceDigests.map(pin => ({ ...pin, path: relocate(pin.path) })) };
delete ledgerRelease.signature;
for (const name of ["s6", "s6/protected", "s6/content"]) mkdirSync(join(privateDir, name), { mode: 0o700 });
const ledgerConfigPath = join(privateDir, "ledger.json");
writeFileSync(ledgerConfigPath, JSON.stringify({ ...ledgerConfig, port: ledgerPort,
  protectedDirectory: join(privateDir, "s6/protected"), contentDirectory: join(privateDir, "s6/content"),
  release: { ...ledgerRelease, signature: signed(ledgerRelease).signature } }), { flag: "wx", mode: 0o600 });
const transport = json(join(fixture, "owner-transport.json")).policy;
for (const route of transport.routes) {
  route.ledger.endpoint = "http://127.0.0.1:" + ledgerPort;
  route.ledger.acceptedReceipts = route.ledger.acceptedReceipts.map(pin => ({
    ...pin, releaseId: ledgerRelease.releaseId, verifierDigest: hash(canonical(ledgerRelease.sourceDigests)),
  }));
}
const transportPath = join(privateDir, "transport.json");
writeFileSync(transportPath, JSON.stringify({ policy: transport, signature: signed(transport).signature }), { flag: "wx", mode: 0o600 });
const managed = [];
function launch(script, environment) {
  let log = "", ready, rejectReady;
  const readiness = new Promise((yes, no) => { ready = yes; rejectReady = no; });
  const child = spawn(process.execPath, [join(runtime, "finnor-os/x2-runtime", script)], {
    cwd: join(runtime, "finnor-os"), stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH, HOME: privateDir, TMPDIR: privateDir, LANG: "C", TZ: "UTC",
      NODE_ENV: "production", FINNOR_ENVIRONMENT: "staging", FINNOR_X2_PROFILE: "ordinary_disposable",
      ...environment,
    },
  });
  const exited = new Promise(yes => child.once("close", (code, signal) => yes({ code, signal })));
  child.once("error", rejectReady);
  child.once("close", () => rejectReady(Error("EMITTED_SERVICE_EXITED_BEFORE_GUARD")));
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    log += chunk.toString(); if (log.includes('"status":"READY"')) ready();
  });
  managed.push({ child, exited, script, log: () => log });
  return Promise.race([readiness, new Promise((_, no) => {
    const timer = setTimeout(() => no(Error("EMITTED_SERVICE_READINESS_FAILED")), 15000); timer.unref();
  })]);
}
const results = [];
try {
  await launch("ledger-server.js", { FINNOR_S6_LEDGER_CONFIG: ledgerConfigPath, FINNOR_S6_LEDGER_RELEASE_ROOT: publicKey });
  await launch("s8-server.js", { FINNOR_S8_PORT: String(port), FINNOR_S8_LIFECYCLE_CONFIG: configPath,
    FINNOR_S8_RELEASE_ROOT: publicKey, FINNOR_S6_OWNER_TRANSPORT_CONFIG: transportPath,
    FINNOR_S6_OWNER_TRANSPORT_ROOT: publicKey });
  const command = async (role, operation) => {
    const response = await fetch(origin + "/command", { method: "POST", redirect: "error",
      headers: { "content-type": "application/json",
        authorization: "Bearer " + readFileSync(join(fixture, "lifecycle-" + role + ".token"), "utf8") },
      body: JSON.stringify({ operation, requestId: "domain-probe:" + randomUUID(), body: {} }),
      signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  // READ ignores application bodies. This establishes signed-policy startup
  // and actual bearer authentication before probing the application owner.
  const authenticated = await command("reader", "READ");
  assert.equal(authenticated.status, 200, "AUTHENTICATED_SERVICE_CONTROL_REQUIRED");
  const application = await command("proposer", "APPLICATION_SEMANTICS_PROPOSE");
  results.push({ owner: "AUTHENTICATED_APPLICATION_COMMAND", status: application.status, code: application.body.code });
  assert.equal(application.status, 403);
  assert.equal(application.body.code, "S8_PROTECTED_APPLICATION_DOMAIN_UNADMITTED");
  process.env.FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_CONFIG = consumerPath;
  process.env.FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_ROOT = publicKey;
  process.env.FINNOR_ENVIRONMENT = "staging"; process.env.FINNOR_X2_PROFILE = "ordinary_disposable";
  const { applicationConsumerPolicy } = await import(pathToFileURL(join(runtime, "finnor-os/x2-runtime/application-consumer.js")).href);
  const scope = { tenantId: consumer.tenantId, principalId: consumer.principalId, rightsRef: consumer.rightsRef };
  process.env.NODE_ENV = "development";
  assert(await applicationConsumerPolicy(scope), "VALID_SIGNED_CONSUMER_CONFIGURATION_REQUIRED");
  process.env.NODE_ENV = "production";
  let refused = null;
  try { await applicationConsumerPolicy(scope); } catch (error) { refused = { status: error.status, code: error.code }; }
  results.push({ owner: "EMITTED_CONSUMER_POLICY", ...refused });
  assert.equal(refused?.status, 403); assert.equal(refused?.code, "S8_PROTECTED_APPLICATION_DOMAIN_UNADMITTED");
  writeFileSync(join(destination, "result.json"), JSON.stringify({
    status: "PRE_REPAIR_OWNING_REFUSALS_REPRODUCED", results, authenticatedControl: 200,
    policyValidUntil: policy.validUntil, originalDeadlineRenewed: false, admissionOrEffectIssued: false,
    runtime, fixture: resolve(fixture), qualification: "CONFIGURATION_GUARD_PROBE_NOT_INSTALLED_BUSINESS_EXECUTION",
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ status: "PRE_REPAIR_OWNING_REFUSALS_REPRODUCED", results }));
} finally {
  for (const process of managed.reverse()) {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM");
    await process.exited;
    writeFileSync(join(privateDir, process.script + ".log"), process.log(), { flag: "wx", mode: 0o600 });
  }
}
