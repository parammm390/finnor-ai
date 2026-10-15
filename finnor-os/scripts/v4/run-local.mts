/** Finite original-source E2E. Real loopback bearer API and physical queue.
 * Development custody is administered by this runner, not a blind S8 custodian.
 * No credential, provider, bank, peer completion or field benefit is invented. */
import { strict as assert } from "node:assert";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer, request as proxyRequest } from "node:http";
import { createServer as createPortServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, withTenantTransaction } from "@finnor/db";
import { linkEmployeeConversationTurnToWork } from "@finnor/orchestration";
import { createStrategy, createOpportunity } from "@finnor/private-equity";
import { createUpstreamFixtureSupport } from "../s5/owner-fixture.mts";
import { resolveDecisionWork } from "../../packages/private-equity/src/decision-slice/adapters";
import { revisions } from "../../packages/private-equity/src/evidence-execution/store";
import { capitalTx, capitalProgramme, capitalOwnerSnapshot, currentCapitalMethod } from "../../packages/private-equity/src/capital-formation/store";
import { capitalDigest, canonicalCapital } from "../../packages/private-equity/src/capital-formation/contracts";
import { CAPITAL_PROVIDER_INTERFACE_DIGEST } from "../../packages/tools/src/capital-provider";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), os = join(repo, "finnor-os");
const startedAt = new Date().toISOString(), programmeWallMs = 600000;
const campaignWallMs = 5400000, campaignDeadline = Date.parse(startedAt) + campaignWallMs;
const remainingCampaign = () => {
  const remaining = campaignDeadline - Date.now();
  assert(remaining > 0, "Original finite campaign deadline exhausted"); return remaining;
};
const output = resolve(process.env.FINNOR_V4_EVIDENCE_DIR ?? join(repo, "scope-v/v4-autonomous-capital-formation/evidence",
  "run-" + startedAt.replaceAll(":", "-") + "-" + randomUUID().slice(0, 8)));
const python = process.env.FINNOR_S3_PYTHON;
const mounted = process.env.FINNOR_V4_MOUNTED === "1";
assert(python, "Provide an explicit installed scientific Python runtime");
await mkdir(output, { recursive: true });
console.log(JSON.stringify({ evidenceDirectory: output }));
const results: any[] = [], calls: any[] = [], processes = new Set<ChildProcess>(), sourceManifest: any[] = [];
const fixtures: Record<string, any> = {};
let admin: pg.Client | undefined, apiOrigin = "", worker: ChildProcess | undefined, workerUrl = "", migrationCount = 0;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function artifact(name: string, value: unknown) {
  const path = join(output, name); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n"); return path;
}
async function save() {
  await artifact("results.json", { schema: "finnor.v4.development-e2e.v1", startedAt, finishedAt: new Date().toISOString(),
    results, calls, migrationCount, sourceManifest, versions: { node: process.version },
    custody: "RUNNER_ADMINISTERED_DEVELOPMENT_ACTORS_NOT_BLIND_INDEPENDENT_ADMISSION",
    securityPosture: "INSTALLED_BUILD_WITH_GENERATED_LOOPBACK_ENV_CREDENTIALS_NOT_MANAGED_PRODUCTION_SECRETS_QUALIFICATION",
    qualification: { engineering: results.some(r => r.status === "FAIL") ? "INCOMPLETE" : "SELECTED_DEVELOPMENT_CASES_ONLY",
      admission: "NOT_ESTABLISHED", activation: "DISABLED", protectedGate: "BLOCKED_EXTERNAL", fieldEconomic: "NOT_EVALUATED" },
    limits: { programmeWallMs, campaignWallMs, sourceEvidenceBytesCap: 33554432, noLiveTargets: true },
    meterGaps: ["engineering labour", "attributable preparation", "full aggregate peer memory", "hardware and idle price", "real financial billing"],
    rerun: "FINNOR_S3_PYTHON=<pinned-python> node --import=tsx finnor-os/scripts/v4/run-local.mts",
  });
}
async function check(id: string, predicate: string, fn: () => Promise<unknown>) {
  const begun = performance.now();
  try { remainingCampaign(); results.push({ id, predicate, status: "PASS", observed: await fn(), wallMs: performance.now() - begun }); }
  catch (e) { results.push({ id, predicate, status: "FAIL", observed: { message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : null }, wallMs: performance.now() - begun }); }
  console.log(JSON.stringify({ id, status: results.at(-1).status })); await save();
  if (results.at(-1).status === "FAIL") throw Error("Registered predicate failed: " + id);
}
async function freePort() {
  return new Promise<number>((yes, no) => { const s = createPortServer(); s.once("error", no); s.listen(0, "127.0.0.1", () => {
    const a = s.address(); if (!a || typeof a === "string") return no(Error("port")); s.close(() => yes(a.port));
  }); });
}
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }), jwtKey = { ...rsa.publicKey.export({ format: "jwk" }), kid: "v4-disposable-auth", alg: "RS256", use: "sig" };
let authOrigin = "", frontendOrigin = "";
let holdFinancingReads = false;
const heldFinancingReads: Array<() => void> = [];
const tokens = new Map<string, any>();
function token(f: any) {
  const body = { sub: f.principal, email: f.email ?? `${f.name}@s5.example.test`, aud: "authenticated", role: "authenticated",
    iss: authOrigin + "/auth/v1", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const input = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwtKey.kid })).toString("base64url") + "." + Buffer.from(JSON.stringify(body)).toString("base64url");
  const result = input + "." + sign("RSA-SHA256", Buffer.from(input), rsa.privateKey).toString("base64url");
  tokens.set(result, { id: body.sub, email: body.email, role: "authenticated", aud: "authenticated", app_metadata: {}, user_metadata: {} });
  return result;
}
const authServer = createServer(async (req, res) => {
  if (!req.url?.startsWith("/auth/") && frontendOrigin) {
    const upstream = proxyRequest(frontendOrigin + req.url, { method: req.method, headers: req.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const deliver = () => { res.writeHead(response.statusCode ?? 502, response.headers); res.end(Buffer.concat(chunks)); };
        if (holdFinancingReads && req.url?.includes("company-brain/capital-formation-read")) heldFinancingReads.push(deliver);
        else deliver();
      });
    });
    upstream.on("error", () => { res.statusCode = 502; res.end("Owned frontend unavailable"); });
    req.pipe(upstream); return;
  }
  res.setHeader("content-type", "application/json"); res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.url?.includes("/.well-known/jwks.json")) { res.end(JSON.stringify({ keys: [jwtKey] })); return; }
  if (req.url?.startsWith("/auth/v1/token") && req.method === "POST") {
    let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.statusCode = 413; res.end("{}"); return; } }
    const input = JSON.parse(body), f = Object.values(fixtures).find((value: any) => (value.email ?? `${value.name}@s5.example.test`) === input.email);
    if (!f || input.password !== "v4-disposable-local-login") { res.statusCode = 401; res.end('{"msg":"Disposable fixture credentials required"}'); return; }
    const access = token(f), user = tokens.get(access);
    res.end(JSON.stringify({ access_token: access, token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "v4-disposable-refresh-" + randomUUID(), user })); return;
  }
  const user = tokens.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  if (req.url?.startsWith("/auth/v1/user") && user) { res.end(JSON.stringify(user)); return; }
  if (req.url?.startsWith("/auth/v1/logout") && user) { res.statusCode = 204; res.end(); return; }
  res.statusCode = 401; res.end('{"message":"Disposable authenticated user required"}');
});
await new Promise<void>((r, reject) => { authServer.once("error", reject);
  authServer.listen(mounted ? Number(process.env.FINNOR_V4_AUTH_PORT ?? 40441) : 0, "127.0.0.1", r); });
const authAddress = authServer.address(); assert(authAddress && typeof authAddress !== "string");
authOrigin = "http://127.0.0.1:" + authAddress.port;
async function http(f: any, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const begun = performance.now(), r = await fetch(apiOrigin + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (f.token ??= token(f)), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(35000, remainingCampaign())) });
  const value = await r.json(); calls.push({ path, status: r.status, wallMs: performance.now() - begun, requestDigest: body === undefined ? null : capitalDigest(body) });
  return { status: r.status, body: value as any };
}
const success = (r: any) => { assert([200, 201, 202].includes(r.status), JSON.stringify(r)); return r.body; };
const cb = (f: any, operation: string, body: unknown) => http(f, "company-brain/" + operation, body);
function child(name: string, args: string[], env: NodeJS.ProcessEnv, ipc = false, cwd = os) {
  remainingCampaign();
  const cp = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])] });
  processes.add(cp); const log = createWriteStream(join(output, name + ".log")); cp.stdout!.pipe(log); cp.stderr!.pipe(log);
  cp.on("exit", () => { processes.delete(cp); log.end(); }); return cp;
}
const actorEnvironment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "test" };
async function actor(role: string, config: any) {
  const cp = child("actor-" + role + "-" + config.id, [join(os, "scripts/v4/fixture-actor.mjs"), role], actorEnvironment, true);
  const rpc = (command: string, value?: unknown) => new Promise<any>((yes, no) => {
    const id = randomUUID(), timer = setTimeout(() => { cp.off("message", listener); no(Error("Actor deadline: " + role)); }, Math.min(10000, remainingCampaign()));
    const listener = (m: any) => { if (m.kind === "RPC_RESULT" && m.id === id) { clearTimeout(timer); cp.off("message", listener); m.error ? no(Error(m.error)) : yes(m.result); } };
    cp.on("message", listener); cp.send!({ id, command, value });
  });
  return { cp, rpc, public: await rpc("INIT", config), config, role };
}
const environment: NodeJS.ProcessEnv = { ...actorEnvironment, CI: "1", LOG_LEVEL: "silent", FINNOR_ENVIRONMENT: "development",
  FINNOR_V4_PROFILE: "DISPOSABLE", RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_IP_PER_MINUTE: "100000",
  FINNOR_TEST_MANAGED_EXTENSIONS: "omit", FINNOR_S3_PYTHON: python, FINNOR_S5_PYTHON: python,
  FINNOR_S3_MODEL_STORE: join(output, "ordinary-models"), FINNOR_S4_POLICY_STORE: join(output, "ordinary-policies"),
  SUPABASE_URL: authOrigin, SUPABASE_SERVICE_ROLE_KEY: "v4-disposable-public-service-configuration", FINNOR_SOURCE_ROOT: repo,
  ALLOW_PLAINTEXT_ENV_SECRETS: "1",
  NODE_OPTIONS: "--max-old-space-size=1536", FINNOR_V4_WORKER_WALL_SECONDS: "600",
};
Object.assign(process.env, environment);
delete process.env.AUTH_DEV_BYPASS;
const dbDirectory = await mkdtemp(join(tmpdir(), "finnor-v4-database-")), dbPort = await freePort();
const databasePassword = randomBytes(32).toString("hex");
const postgres = new EmbeddedPostgres({ databaseDir: dbDirectory, user: "v4_owner", password: databasePassword,
  port: dbPort, persistent: false, onLog: () => undefined });
const registeredActors: any[] = [];
async function originalEvidence(f: any, key: string, content: string, snapshot: unknown = {}, privateScope = false, versionId = randomUUID()) {
  const sourceId = randomUUID();
  await admin!.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title,metadata) VALUES($1,'tenant',$2,$3,'v4_independent_development_input',$3,$4::jsonb)",
    [sourceId, f.tenant, key, JSON.stringify(privateScope ? { capitalPrivateScope: { principalId: f.principal, workId: f.workId } } : {})]);
  await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,clock_timestamp())",
    [versionId, sourceId, f.tenant, capitalDigest(content), content, JSON.stringify(snapshot)]);
  return { sourceId, versionId };
}
async function enrol(f: any, actor: any, instruments: string[], purposes: string[], activities: string[]) {
  const body = { id: actor.public.id, revision: 1, legalEntityId: actor.public.legalEntityId, actorId: actor.public.actorId,
    publicKey: actor.public.publicKey, purposes, instruments, activities, validFrom: new Date(Date.now() - 86400000).toISOString(),
    validUntil: new Date(Date.now() + 3600000).toISOString(), revoked: false, independentOfProducer: true,
    sourceRef: "independently-keyed-development-process-not-licensed-field-professional", domainDigest: capitalDigest({ instruments, purposes, actor: actor.public.id }) };
  const evidence = await originalEvidence(f, "v4:issuer:" + body.id, canonicalCapital(body), body, true);
  await admin!.query("INSERT INTO finnor_os.s1_capital_issuers(tenant_id,principal_id,issuer_id,revision,body,content_digest,source_evidence_version_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)",
    [f.tenant, f.principal, body.id, canonicalCapital(body), capitalDigest(body), evidence.versionId]);
  return body;
}
async function startWorker() {
  worker = child("worker-" + randomUUID(), ["--import=tsx", join(os, "scripts/v4/worker-process.mts")],
    { ...environment, DATABASE_URL: workerUrl }, true);
  await new Promise<void>((yes, no) => { const timer = setTimeout(() => no(Error("Physical worker startup deadline")), 30000);
    worker!.on("message", (m: any) => { if (m.kind === "WORKER_READY") { clearTimeout(timer); yes(); } }); worker!.once("error", no); });
}
async function stopWorker() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const original = worker;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { original.kill("SIGKILL"); fail(Error("Finite physical worker pause deadline")); }, 15000);
    original.once("exit", () => { clearTimeout(timer); done(); }); original.kill("SIGTERM");
  });
}
async function killWorker() {
  assert(worker && worker.exitCode === null && worker.signalCode === null);
  const original = worker;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(Error("Finite physical worker kill deadline")), 15000);
    original.once("exit", () => { clearTimeout(timer); done(); }); original.kill("SIGKILL");
  });
}
function disposeFixture(f: any) {
  for (const group of Object.values(f.domainActors ?? {}) as any[]) for (const a of Object.values(group) as any[]) a.cp.kill("SIGTERM");
  f.authorityActor?.cp.kill("SIGTERM");
}
async function current(f: any, predicate: (v: any) => boolean, maximum = 30000) {
  const deadline = Date.now() + maximum;
  while (Date.now() < deadline) {
    const r = await cb(f, "capital-formation-read", { programmeId: f.mandate.programmeId });
    if (r.status === 200 && predicate(r.body)) return r.body;
    await sleep(200);
  }
  const diagnostic = (await admin!.query("SELECT id,type,status,last_error,claim_token,claim_fence,lease_expires_at,run_at,attempts,max_attempts FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY id",
    [f.tenant])).rows; await artifact(f.name + "/deadline-jobs.json", diagnostic);
  throw Error("Original observation deadline, inspect retained physical jobs");
}
async function fixture(support: any, name: string, delayed = false, options: { issuerLocalIds?: boolean; providerCostMicroUSD?: string;
  providerCostFinal?: boolean; additionalTranche?: boolean; allowedGuarantee?: boolean; shadowDebtProfile?: boolean;
  activityReview?: "INDEPENDENT" | "REPRESENTATIVE" | "SHARED_KEY" } = {}) {
  remainingCampaign();
  const f = await support.fixture(name, 1, [
    { id: "cash", unit: "USD", capacity: 100, totalLimit: 100, resourceClass: "CASH" },
    { id: "contacts", unit: "contact", capacity: 8, totalLimit: 8, resourceClass: "INQUIRY_EXPOSURE" },
    { id: "compute", unit: "request", capacity: 32, totalLimit: 32, resourceClass: "COMPUTE" },
    { id: "human", unit: "seconds", capacity: 900, totalLimit: 900, resourceClass: "HUMAN_ATTENTION" },
  ]);
  f.token = token(f);
  if (mounted && name === "original-positive") {
    const strategy = await createStrategy(f.ctx, { name: "Disposable financing scope, not field investment evidence" });
    const opportunity = await createOpportunity(f.ctx, { strategyId: String(strategy.row.id), targetOrganizationId: f.root.entityId,
      name: "Original hypothetical financing programme", summary: "Mounted owner-route proof only, no signed LOI, legal commitment or field investment inferred" });
    f.uiRoot = { entityType: "pe_opportunity", entityId: String(opportunity.row.id) };
    f.wrongUiRoot = { entityType: "pe_strategy", entityId: String(strategy.row.id) };
    await artifact(name + "/canonical-mounted-root.json", { uiRoot: f.uiRoot, financingRoot: f.root, strategy, opportunity });
  }
  const intake = await http(f, "actions", { instruction: "Prepare an original bounded financing programme for the selected company, subject to exact approval. Do not execute borrowing or funding.",
    instructionId: randomUUID(), idempotencyKey: "v4-native-intake:" + name, channel: "text",
    activeContext: { version: 1, capturedAt: new Date().toISOString(), source: "text", selectedEntities: [f.root],
      excludedEntities: [], surface: { id: "home", route: "/centropy", spatialState: "canvas" }, filters: [] } });
  assert(intake.body.workId, "Actual bearer intake must retain an original Work id");
  f.workId = intake.body.workId; f.intake = intake;
  if (intake.status === 503 && intake.body.code === "worker_fleet_unavailable") {
    const recovery = await http(f, `works/${f.workId}/retry`, { idempotencyKey: "same-original-financing-intake-" + name });
    await artifact(name + "/original-intake-recovery.json", { intake, recovery, originalWorkId: f.workId,
      originalWorkInputId: intake.body.workInputId, changedFinancingGrant: false });
    assert([200, 201, 202].includes(recovery.status), JSON.stringify(recovery));
    const nativeThreads = success(await http(f, "threads")).threads;
    let projected = false;
    for (const thread of nativeThreads) {
      const loaded = success(await http(f, `threads/${thread.id}`));
      const message = loaded.messages.find((m: any) => m.role === "user" && m.instructionId === intake.body.instructionId);
      if (!message) continue;
      await linkEmployeeConversationTurnToWork({ tenantId: f.tenant, employeeId: f.principal, threadId: thread.id,
        userMessageId: message.id, workId: f.workId, workInputId: intake.body.workInputId });
      const observed = success(await http(f, `threads/${thread.id}`));
      assert.equal(observed.thread.activeWorkId, f.workId);
      await artifact(name + "/original-recovery-projection.json", { originalWorkId: f.workId, originalWorkInputId: intake.body.workInputId,
        threadId: thread.id, messageId: message.id, observed,
        path: "Canonical conversation-owner seam completes original recovery projection. Not an unbroken installed objective-intake/fleet proof.",
        newWorkInputOrFinancingGrantCreated: false });
      projected = true; break;
    }
    assert(projected, "Same original recovered Work must bind its actual canonical user turn");
  } else success(intake);
  const policy = await support.policy(f, "budget", { cash: 100, contacts: 8, compute: 32, human: 900 });
  for (const [id, unit, amount] of [["cash", "USD", "100"], ["contacts", "contact", "8"], ["compute", "request", "32"], ["human", "seconds", "900"]]) {
    await support.resource(f, id, unit, "STOCK", [amount, amount]);
  }
  const cleared = success(await http(f, "allocations/clear", support.clearing(f, { budget: ["100"] })));
  await artifact(name + "/original-budget-owner-result.json", cleared);
  assert.equal(cleared.status, "FEASIBLE", JSON.stringify(cleared)); assert(cleared.certificate.policyBindings.some((p: any) => p.policyRef.id === policy.ref.id));
  const authorityActor = await actor("authority", { id: randomUUID(), actorId: f.principal, legalEntityId: f.root.entityId });
  registeredActors.push(authorityActor);
  const authorityIssuer = await enrol(f, authorityActor, ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"], ["AUTHORITY"], ["APPROVE"]);
  const domainActors: any = {}, profiles: any[] = [], providerIds: string[] = [], recipientIds: string[] = [];
  const method = await currentCapitalMethod();
  for (const instrument of options.shadowDebtProfile ? ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY"]
    : ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"]) {
    const providerEntity = randomUUID(), representative = randomUUID(), idActor = await actor("identity", { id: randomUUID(), actorId: randomUUID(), legalEntityId: randomUUID() }),
      profActor = await actor("professional", { id: randomUUID(), actorId: options.activityReview === "REPRESENTATIVE" && instrument === "CORPORATE_DEBT" ? representative : randomUUID(), legalEntityId: randomUUID() }),
      receiver = await actor("receiver", { id: randomUUID(), actorId: randomUUID(), legalEntityId: randomUUID() }),
      meter = await actor("meter", { id: randomUUID(), actorId: randomUUID(), legalEntityId: randomUUID() });
    const provider = await actor("provider", { id: randomUUID(), actorId: representative, legalEntityId: providerEntity,
      identityOrigin: idActor.public.origin, professionalOrigin: profActor.public.origin });
    registeredActors.push(idActor, profActor, receiver, meter, provider);
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",
      [providerEntity, f.tenant, (name + "-" + instrument).toLowerCase()]);
    await admin!.query("INSERT INTO finnor_os.external_contacts(id,tenant_id,external_organization_id,contact_key,name,business_email) VALUES($1,$2,$3,$4,$4,$5)",
      [representative, f.tenant, providerEntity, "v4-" + representative, representative + "@disposable.example.test"]);
    await enrol(f, idActor, [instrument], ["IDENTITY"], []);
    await enrol(f, options.activityReview === "SHARED_KEY" && instrument === "CORPORATE_DEBT"
      ? { ...profActor, public: { ...profActor.public, publicKey: provider.public.publicKey } } : profActor, [instrument], ["PROFESSIONAL"], ["DETERMINE_LEGAL_STATUS"]);
    await enrol(f, receiver, [instrument], ["SETTLEMENT"], []);
    await enrol(f, meter, [instrument], ["HUMAN_METER"], []);
    await enrol(f, provider, [instrument], ["PROVIDER", "CONDITION"], ["APPROACH", "NEGOTIATE", "EXECUTE_COMMITMENT"]);
    const profile = { id: randomUUID(), revision: 1, instrument, environment: "DISPOSABLE", jurisdiction: "DISPOSABLE_REGISTERED_DOMAIN",
      legalBasisDigest: capitalDigest("Hypothetical exact " + instrument), activityAuthorityDigest: capitalDigest("Declared development activity"),
      professionalIssuerIds: [profActor.public.id], identityIssuerIds: [idActor.public.id], settlementIssuerIds: [receiver.public.id], humanMeterIssuerIds: [meter.public.id],
      receivingPredicate: "RECEIVER_CONFIRMED_AND_SETTLEMENT_FINAL", operationCostCeilingMicroUSD: "2500", independentCheckerDigest: method.checkerDigest,
      providerInterfaceRef: { owner: "S6", id: provider.public.origin, version: "capital-disposable-http-v1", contentDigest: CAPITAL_PROVIDER_INTERFACE_DIGEST },
      admissionRef: null, qualified: false, activated: false, legalStatusSemantics: "EXACT_PROFESSIONAL_DETERMINATION_WITH_MATERIAL_CONDITION_INVENTORY",
      permittedRootTypes: ["external_organization"], executionRequirements: ["Original exact source and independent professional"],
      validUntil: new Date(Date.now() + 3600000).toISOString(), revoked: false };
    if (options.shadowDebtProfile) {
      for (let n = 0; n < 64 && capitalDigest(profile) < "8"; n++) profile.id = randomUUID();
      assert(capitalDigest(profile) >= "8", "Finite original selected-profile digest preparation");
    }
    const source = await originalEvidence(f, "v4:profile:" + profile.id, canonicalCapital(profile), profile, true);
    await admin!.query("INSERT INTO finnor_os.v4_instrument_profiles(tenant_id,principal_id,profile_id,revision,body,content_digest,source_evidence_version_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)",
      [f.tenant, f.principal, profile.id, canonicalCapital(profile), capitalDigest(profile), source.versionId]);
    profiles.push(profile); domainActors[instrument] = { provider, identity: idActor, professional: profActor, receiver, meter };
    if (instrument !== "FUND_LP") { providerIds.push(providerEntity); recipientIds.push(representative); }
  }
  if (options.shadowDebtProfile) {
    const shadow = { ...profiles[0], id: "00000000-0000-4000-8000-000000000001", revoked: true };
    for (let n = 0; n < 64 && capitalDigest(shadow) >= "8"; n++) {
      shadow.activityAuthorityDigest = capitalDigest("Separate revoked development profile " + n);
    }
    assert(capitalDigest(shadow) < "8", "Finite original earlier content-digest profile preparation");
    const source = await originalEvidence(f, "v4:profile:" + shadow.id, canonicalCapital(shadow), shadow, true);
    await admin!.query("INSERT INTO finnor_os.v4_instrument_profiles(tenant_id,principal_id,profile_id,revision,body,content_digest,source_evidence_version_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)",
      [f.tenant, f.principal, shadow.id, canonicalCapital(shadow), capitalDigest(shadow), source.versionId]);
    f.shadowProfile = shadow;
    await artifact(name + "/original-unselected-revoked-profile.json", { shadow, source, selectedProfileIds: profiles.map(p => p.id),
      enrolledProfiles: 3, ownerOrdering: "content_digest", profileDigestPreparationBound: 64, programmeDeadlineOrBudgetChanged: false });
  }
  if (options.activityReview) { providerIds.splice(1); recipientIds.splice(1); }
  const programmeId = randomUUID(), rights = (await admin!.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [f.tenant])).rows[0].revision;
  const disclosure = await originalEvidence(f, "original-disclosure-" + programmeId, "V4_PRIVATE_SYNTHETIC_CANARY_" + programmeId);
  const sourceRevision = (await revisions(f.ctx, ["evidence:" + disclosure.sourceId]))[0]!.revision;
  const expires = new Date(Date.now() + programmeWallMs).toISOString(), until = new Date(Date.now() + 3600000).toISOString();
  const disclosureBody = { evidenceVersionId: disclosure.versionId, contentDigest: capitalDigest("V4_PRIVATE_SYNTHETIC_CANARY_" + programmeId),
    sourceRevision, rightsRevision: rights, principalId: f.principal, programmeId, purpose: "ORIGINAL_DISPOSABLE_FINANCING",
    consentRef: "EXPLICIT_GENERATED_DISPOSABLE_CONSENT_NOT_REAL_DATA", confidentiality: "CAPITAL_PRIVATE",
    permittedProviderIds: providerIds, permittedChannels: ["capital-disposable-http-v1"], validUntil: until, retentionUntil: until, acceptedLimitations: [] };
  await admin!.query("INSERT INTO finnor_os.s1_capital_disclosures(tenant_id,principal_id,programme_id,work_id,evidence_version_id,source_id,body,content_digest,valid_until,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)",
    [f.tenant, f.principal, programmeId, f.workId, disclosure.versionId, disclosure.sourceId, canonicalCapital(disclosureBody), capitalDigest(disclosureBody), until]);
  const work = await resolveDecisionWork(f.ctx, f.workId);
  const authority = { id: randomUUID(), revision: 1, issuingPrincipalId: f.principal, legalEntityIds: [f.root.entityId],
    jurisdictions: ["DISPOSABLE_REGISTERED_DOMAIN"], instruments: ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"],
    activities: ["RESEARCH", "APPROACH", "DISCLOSE", "NEGOTIATE"].map(activity => ({ activity, actorIds: [f.principal], channelIds: ["capital-disposable-http-v1"], professionalRequired: false })),
    permittedProviderIds: providerIds, suppressedProviderIds: [], permittedRecipientIds: recipientIds, templates: [capitalDigest("Frozen disposable exact template")],
    disclosurePurpose: disclosureBody.purpose, legalReviewEvidenceRef: "DEVELOPMENT_NO_FIELD_LEGAL_ACTIVATION", offeringRoute: "DISPOSABLE_ONLY",
    compensationRules: "No real compensation or financial attribution", policyRevision: "v4-disposable-v1",
    validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: until, revoked: false, maxContacts: 8, maxExposureMinor: "12000000000",
    pricingBounds: { minRate: { numerator: "0", denominator: "1" }, maxRate: { numerator: "1", denominator: "10" }, maxFeesMinor: "0" },
    permittedGuaranteeIds: options.allowedGuarantee ? ["development-allowed-guarantee"] : [], approvalConditions: [], escalationConditions: [], stopConditions: ["Original expiry or bounded budget exhausted"] };
  let activityReviewSource: { sourceId: string; versionId: string } | undefined;
  if (options.activityReview) {
    const group = domainActors.CORPORATE_DEBT, versionId = randomUUID();
    authority.legalReviewEvidenceRef = versionId;
    authority.activities = authority.activities.map(a => ({ ...a, professionalRequired: true }));
    const review = await (options.activityReview === "SHARED_KEY" ? group.provider : group.professional).rpc("ACTIVITY_REVIEW", {
      schema: "finnor.v4.professional-activity-review.v1", issuerId: group.professional.public.id, tenantId: f.tenant,
      programmeId, principalId: f.principal, legalEntityId: f.root.entityId, authorityDigest: capitalDigest(authority),
      activities: authority.activities.map(a => a.activity), instruments: ["CORPORATE_DEBT"], providerIds, recipientIds,
      channels: ["capital-disposable-http-v1"], satisfiedApprovalConditionIds: [], legalBasisDigest: profiles[0].legalBasisDigest,
      validFrom: authority.validFrom, validUntil: until,
    });
    activityReviewSource = await originalEvidence(f, "v4:activity-review:" + programmeId, canonicalCapital(review), review, true, versionId);
  }
  const signedAuthority = await authorityActor.rpc("SIGN", authority);
  const money = { legalEntityId: f.root.entityId, ownerShare: { numerator: "1", denominator: "1" }, amountMinor: "12000000000", currency: "USD",
    minorUnits: 2, unit: "CURRENCY_MINOR_UNIT", timeBasis: "ORIGINAL_APPROVED_REQUIREMENT", valuationDate: new Date().toISOString(), rounding: "EXACT" };
  const keys = ["rights:tenant", "work-inputs:" + f.workId, "canonical:" + f.root.entityType + ":" + f.root.entityId,
    ...profiles.slice(0, 2).map(p => "v4-profile:" + p.id), `v4-disclosure:${programmeId}:${disclosure.versionId}`];
  if (activityReviewSource) keys.push("evidence:" + activityReviewSource.sourceId);
  f.ownerFixture = { ...f, mandate: f.mandate };
  f.mandate = { schema: "finnor.s4.financing-mandate.v1", programmeId, tenantId: f.tenant, principalId: f.principal,
    workId: f.workId, workInputId: work.inputId, workInputDigest: work.inputDigest, root: f.root, legalEntityId: f.root.entityId,
    approvedProgrammeRef: policy.ref, approvedTermsDigest: capitalDigest(policy.problem), approvalDecisionId: randomUUID(),
    authorityProfileId: authority.id, domainProfileIds: profiles.slice(0, 2).map(p => p.id), budgetGrantRef: cleared.certificate.ref,
    requirement: money, tranches: [{ id: "principal", purpose: "PRINCIPAL", requiredMinor: money.amountMinor, currency: "USD",
      dueAt: new Date(Date.now() + 300000).toISOString(), instruments: ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY"] }],
    providerIds, disclosureRefs: [disclosureBody], readinessBasis: "EFFECTIVE_UNDRAWN_AND_RECONCILED_FUNDING", readinessRevision: "original-v1",
    acceptedConversions: [], prohibitedCovenantIds: [], prohibitedCrossDefaults: [], maxEconomicOwnership: { numerator: "1", denominator: "2" },
    maxVotingOwnership: { numerator: "1", denominator: "2" }, requiredCollateralConsents: [], expiresAt: expires, waitingUntil: expires,
    contactGrant: 8, maxCostMicroUSD: "100000000", maxHumanSeconds: 900, maxSteps: 32, stoppingRules: ["Original deadline and bounded grant"],
    sourceRevisionVector: (await revisions(f.ctx, keys)).map(({ key, revision }) => ({ key, revision })) };
  if (options.additionalTranche) {
    f.mandate.tranches[0].requiredMinor = "6000000000";
    f.mandate.tranches.push({ ...f.mandate.tranches[0], id: "secondary" });
  }
  const approval = await authorityActor.rpc("SIGN", { schema: "finnor.s4.capital-approval.v1", tenantId: f.tenant, principalId: f.principal,
    programmeId, mandateDigest: capitalDigest(f.mandate), authorityDigest: capitalDigest(authority) });
  await admin!.query("INSERT INTO finnor_os.authority_decisions(id,tenant_id,employee_id,work_id,operation,capability,resource_type,resource_id,risk,outcome,reason_code,authority_revision,evidence) VALUES($1,$2,$3,$4,'approval','capital:financing-mandate','financing_programme',$5,'high','allowed','independently_signed_development_approval',$6,$7::jsonb)",
    [f.mandate.approvalDecisionId, f.tenant, f.principal, f.workId, programmeId, rights, JSON.stringify({ capitalApproval: { ...approval, issuerId: authorityIssuer.id } })]);
  f.request = { mandate: f.mandate, authority: { ...signedAuthority, issuerId: authorityIssuer.id }, idempotencyKey: "original-" + name };
  f.domainActors = domainActors; f.profiles = profiles; f.disclosure = disclosure; f.authorityActor = authorityActor; f.authorityIssuer = authorityIssuer;
  const definition = { programmeId, tenantId: f.tenant, principalId: f.principal, requirement: money, debtMinor: "8000000000", equityMinor: "4000000000",
    facilityId: randomUUID(), securityId: randomUUID(), conditional: true, availableFrom: new Date(Date.now() - 1000).toISOString(),
    expiresAt: until, authorityDigest: capitalDigest(authority), responseDelayMs: delayed ? 20000 : 0,
    legalBasisDigests: Object.fromEntries(profiles.map(p => [p.instrument, p.legalBasisDigest])),
    providers: Object.fromEntries(Object.entries(domainActors).map(([instrument, d]: any) => [instrument, { entityId: d.provider.public.legalEntityId, actorId: d.provider.public.actorId }])),
    issuerLocalIds: options.issuerLocalIds ?? false, ...(options.providerCostMicroUSD ? { providerCostMicroUSD: options.providerCostMicroUSD } : {}),
    providerCostFinal: options.providerCostFinal ?? true };
  for (const group of Object.values(domainActors) as any[]) for (const a of Object.values(group) as any[]) await a.rpc("DEFINE", definition);
  f.definition = definition; await artifact(name + "/original-input.json", { request: f.request, intake, definition, profiles });
  return f;
}
try {
  const method = await currentCapitalMethod(), sources = [...new Set([...method.files.map(f => f.path),
    "finnor-os/scripts/v4/run-local.mts", "finnor-os/scripts/v4/fixture-actor.mjs", "finnor-os/scripts/v4/reference.py",
    "finnor-os/scripts/v4/worker-process.mts", "finnor-os/scripts/v4/boundary-proof.mts", "finnor-os/scripts/v4/browser-proof.mts",
    "finnor-os/apps/worker/src/queue.ts", "finnor-os/apps/worker/src/index.ts",
    "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts", "finnor-os/packages/db/compute-contract.ts",
    "finnor-os/packages/db/migration-head.ts", "finnor-os/apps/api/next.config.mjs", "src/components/centropy/canvas/CapitalFormationPanel.tsx",
    "src/components/centropy/canvas/capital-formation-view.ts", "src/components/centropy/canvas/canvas-compose.ts",
    "src/components/centropy/canvas/canvas-contract.ts", "src/components/centropy/canvas/CanvasDocument.tsx",
    "next.config.mjs", "scope-v/v4-autonomous-capital-formation/failure-model.md", "scope-v/v4-autonomous-capital-formation/verification-plan.json",
    "scope-v/v4-autonomous-capital-formation/review-boundary-plan.json"])];
  let sourceBytes = 0;
  for (const path of sources) { const bytes = await readFile(join(repo, path)); sourceBytes += bytes.length;
    assert(sourceBytes <= 33554432); const target = join(output, "source-snapshot", path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
    sourceManifest.push({ path, sha256: capitalDigest(bytes), bytes: bytes.length }); }
  await postgres.initialise(); await appendFile(join(dbDirectory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n"); await postgres.start();
  await postgres.createDatabase("v4_development");
  const ownerUrl = `postgres://v4_owner:${encodeURIComponent(databasePassword)}@127.0.0.1:${dbPort}/v4_development`;
  migrationCount = (await migrate(ownerUrl)).length; assert.deepEqual(await migrate(ownerUrl), []);
  admin = new pg.Client({ connectionString: ownerUrl }); await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'v4_disposable_application'"); await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'v4_disposable_worker'");
  workerUrl = `postgres://finnor_worker:v4_disposable_worker@127.0.0.1:${dbPort}/v4_development`;
  environment.DATABASE_URL = `postgres://finnor_app:v4_disposable_application@127.0.0.1:${dbPort}/v4_development`;
  process.env.DATABASE_URL = environment.DATABASE_URL; await closePool();
  const apiPort = await freePort(); apiOrigin = "http://127.0.0.1:" + apiPort;
  const api = child("installed-api", [join(os, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(apiPort)],
    { ...environment, NODE_ENV: "production" }, false, join(os, "apps/api"));
  const warmDeadline = Math.min(Date.now() + 60000, campaignDeadline);
  let apiReady = false;
  while (Date.now() < warmDeadline) {
    remainingCampaign();
    try { const r = await fetch(apiOrigin + "/api/health", { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, warmDeadline - Date.now()))) });
      if (r.status < 500) { apiReady = true; break; } } catch {}
    if (api.exitCode !== null) throw Error("Installed API exited"); await sleep(200);
  }
  assert(apiReady, "Original installed API readiness deadline exhausted");
  if (mounted) {
    const frontendEnvironment = { ...actorEnvironment, NODE_ENV: "production", CI: "1", NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: "--max-old-space-size=3584", NEXT_PUBLIC_SUPABASE_URL: authOrigin,
      FINNOR_V4_PROFILE: "DISPOSABLE", FINNOR_V4_NO_PERSISTENT_BUILD_CACHE: "1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "v4-disposable-public-browser-configuration", FINNOR_OS_API_URL: apiOrigin };
    const frontendFiles = ["next.config.mjs", "package-lock.json", "src/components/centropy/canvas/CapitalFormationPanel.tsx",
      "src/components/centropy/canvas/capital-formation-view.ts", "src/components/centropy/canvas/canvas-compose.ts",
      "src/components/centropy/canvas/canvas-contract.ts", "src/components/centropy/canvas/CanvasDocument.tsx",
      "finnor-os/packages/shared-types/src/capital-formation.ts", "finnor-os/packages/shared-types/src/enterprise-beliefs.ts",
      "src/components/centropy/shell/CentropyWorkspace.tsx", "src/components/centropy/lib/centropy-auth.tsx",
      "src/components/centropy/lib/api.ts", "src/lib/centropy/supabase-browser.ts",
      "src/lib/centropy/capability-manifest.generated.json", "src/app/api/centropy/[...path]/route.ts"];
    const frontendCut = { publicAuthOrigin: authOrigin, buildCache: "DISPOSABLE_NO_PERSISTENT_WEBPACK_CACHE", files: await Promise.all(frontendFiles.map(async path => ({
      path, sha256: capitalDigest(await readFile(join(repo, path))) }))) };
    const frontendRecord = join(repo, ".next/v4-disposable-installed-cut.json");
    if (process.env.FINNOR_V4_REUSE_FRONTEND === "1") {
      assert.equal(capitalDigest(JSON.parse(await readFile(frontendRecord, "utf8"))), capitalDigest(frontendCut),
        "Installed frontend/public configuration changed; a fresh build is required");
      await artifact("installed-frontend-compatible-reuse.json", { frontendCut, buildId: (await readFile(join(repo, ".next/BUILD_ID"), "utf8")).trim(),
        compatibility: "EXACT_NAMED_MOUNTED_AND_AUTH_PROXY_FILES_AND_PUBLIC_AUTH_ORIGIN_NOT_CLEAN_INSTALL_CERTIFICATION" });
    } else {
      const build = child("installed-frontend-build", [join(repo, "node_modules/next/dist/bin/next"), "build", "--webpack"],
        frontendEnvironment, false, repo);
      const code = await new Promise<number | null>((r, reject) => {
        const timer = setTimeout(() => { build.kill("SIGTERM"); reject(Error("Original finite frontend build campaign deadline exhausted")); }, remainingCampaign());
        build.once("exit", code => { clearTimeout(timer); r(code); });
        build.once("error", error => { clearTimeout(timer); reject(error); });
      });
      assert.equal(code, 0, "Installed frontend build failed, inspect its retained log");
      await writeFile(frontendRecord, canonicalCapital(frontendCut));
      await artifact("installed-frontend-cut.json", frontendCut);
    }
    const frontendPort = await freePort(); frontendOrigin = "http://127.0.0.1:" + frontendPort;
    const frontend = child("installed-frontend", [join(repo, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(frontendPort)],
      { ...frontendEnvironment, NODE_OPTIONS: "--max-old-space-size=1536" }, false, repo);
    const readyDeadline = Math.min(Date.now() + 30000, campaignDeadline);
    let frontendReady = false;
    while (Date.now() < readyDeadline) {
      remainingCampaign();
      try { if ((await fetch(authOrigin + "/centropy/login", { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, readyDeadline - Date.now()))) })).status === 200) {
        frontendReady = true; break;
      } } catch {}
      if (frontend.exitCode !== null) throw Error("Installed frontend exited"); await sleep(200);
    }
    assert(frontendReady, "Original installed frontend readiness deadline exhausted");
  }
  const generated = spawnSync(python, [join(os, "scripts/s3/reference.py")], { input: '{"operation":"equivalent"}', encoding: "utf8", timeout: 30000 });
  assert.equal(generated.status, 0, generated.stderr); const day = 86400000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString();
  const support = createUpstreamFixtureSupport({ admin: () => admin, generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures,
    api: async (f: any, op: string, body: unknown, handler: unknown) => {
      const endpoint = ["fit", "scope", "read-model", "models"].includes(op) ? "interventions" : op === "synthesize" ? "policies" : "allocations";
      return http(f, endpoint + "/" + op, body);
    }, artifact });
  await check("RUNTIME_MIGRATION_RLS", "Complete migration, idempotent reapplication and non-superuser application role", async () => {
    assert.equal((await admin!.query("SELECT count(*)::int n FROM finnor_os._migrations WHERE name='0175_v4_autonomous_capital_formation.sql'")).rows[0].n, 1);
    const application = new pg.Client({ connectionString: environment.DATABASE_URL }); await application.connect();
    let role;
    try { role = (await application.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    } finally { await application.end(); }
    const physicalWorker = new pg.Client({ connectionString: workerUrl }); await physicalWorker.connect();
    let workerRole;
    try { workerRole = (await physicalWorker.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(workerRole.rolsuper, false); assert.equal(workerRole.rolbypassrls, false);
    } finally { await physicalWorker.end(); }
    return { applied: migrationCount, reapplication: [], actualApplicationRole: role, actualWorkerRole: workerRole,
      ownedDisposableDatabase: true, installedApiPid: api.pid, computeCutoverActivated: false };
  });
  const positive = await fixture(support, "original-positive");
  await startWorker();
  await check("A_B_ORIGINAL_SOURCE", "Actual bearer API and physical worker produce 80m conditional debt, 40m indicative equity, zero received and incomplete readiness", async () => {
    const accepted = success(await cb(positive, "capital-formation-submit", positive.request));
    assert.equal(accepted.executionAuthorityGranted, false);
    const view = await current(positive, v => v.current && v.package?.conditionalCommittedMinor === "8000000000" && v.package?.indicativeEquityMinor === "4000000000");
    const snapshot = await capitalTx(positive.ctx, async c => capitalOwnerSnapshot(positive.ctx, await capitalProgramme(positive.ctx, positive.mandate.programmeId, c), c));
    const reference = spawnSync(python, [join(os, "scripts/v4/reference.py")], { input: canonicalCapital(snapshot), encoding: "utf8", timeout: 10000 });
    assert.equal(reference.status, 0, reference.stderr); const oracle = JSON.parse(reference.stdout);
    for (const key of ["conditionalCommittedMinor", "indicativeEquityMinor", "fundingReceivedMinor", "requirementMinor", "readiness"]) assert.equal(view.package[key], oracle[key], key);
    assert.equal(view.package.raisedPrincipalIsProfit, false); assert.equal(view.executionAuthorityGranted, false);
    positive.view = view; positive.snapshot = snapshot;
    const providerReadback = await Promise.all(Object.values(positive.domainActors).map((d: any) => d.provider.rpc("READBACK")));
    await artifact("original-positive/observed-source-and-oracle.json", { accepted, view, snapshot, oracle, providerReadback });
    return { conditional: "8000000000", indicative: "4000000000", received: "0", readiness: view.package.readiness, originalIntakeStatus: positive.intake.status,
      authenticatedEvents: snapshot.events.length, qualification: "DEVELOPMENT_SOURCE_ROUTE_ONLY" };
  });
  await check("C_AUTHENTICATION_AND_ENTITY", "Signature, enrolled issuer, exact operation and exact legal-entity substitutions fail at their intended boundaries", async () => {
    const original = positive.snapshot.events.find((e: any) => e.body.kind === "COMMITMENT_EXECUTED");
    const forged = structuredClone(original); forged.body.eventId += "-forged"; forged.signature = Buffer.alloc(64).toString("base64");
    const r = await cb(positive, "capital-formation-event", { programmeId: positive.mandate.programmeId, event: forged });
    assert.equal(r.status, 409); assert.equal(r.body.code, "ISSUER_EVENT_AUTHENTICATION");
    const wrong = await positive.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "COMMITMENT_EXECUTED",
      context: { ...original.body, terms: original.body.terms }, extra: { terms: { ...original.body.terms, programmeId: randomUUID() }, termsDigest: original.body.termsDigest } });
    const substitution = await cb(positive, "capital-formation-event", { programmeId: positive.mandate.programmeId, event: wrong });
    assert.equal(substitution.status, 409); assert.equal(substitution.body.code, "ISSUER_EXACT_TERMS_SUBSTITUTION");
    const replay = await cb(positive, "capital-formation-event", { programmeId: positive.mandate.programmeId, event: original });
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
    await artifact("C-authentication.json", { r, substitution, replay }); return { intendedBoundaries: [r.body.code, substitution.body.code], replayedNotCountedTwice: true };
  });
  await check("F_ACTUAL_CORPUS_READER", "Generic raw/version/chunk/search SQL cannot read capital-private bytes without their exact purpose, principal and Work scope", async () => {
    const chunkId = randomUUID(), runId = randomUUID(), canary = "V4_PRIVATE_SYNTHETIC_CANARY_" + positive.mandate.programmeId;
    await admin!.query("INSERT INTO finnor_os.evidence_chunks(id,source_id,version_id,scope,tenant_id,ordinal,content,token_count) VALUES($1,$2,$3,'tenant',$4,1,$5,8)",
      [chunkId, positive.disclosure.sourceId, positive.disclosure.versionId, positive.tenant, canary]);
    await admin!.query("INSERT INTO finnor_os.research_runs(id,tenant_id,query,as_of,status,completed_at) VALUES($1,$2,$3,clock_timestamp(),'completed',clock_timestamp())",
      [runId, positive.tenant, canary]);
    await admin!.query(`INSERT INTO finnor_os.research_run_hits(tenant_id,research_run_id,source_id,version_id,chunk_id,scope,rank,fused_score,excerpt)
      VALUES($1,$2,$3,$4,$5,'tenant',1,1,$6)`, [positive.tenant, runId, positive.disclosure.sourceId, positive.disclosure.versionId, chunkId, canary]);
    const populated = (await admin!.query(`SELECT
      (SELECT count(*)::int FROM finnor_os.evidence_chunks WHERE id=$1) chunks,
      (SELECT count(*)::int FROM finnor_os.research_run_hits WHERE research_run_id=$2) excerpts`, [chunkId, runId])).rows[0];
    assert.equal(populated.chunks, 1); assert.equal(populated.excerpts, 1);
    const readback = await withTenantTransaction(positive.tenant, { userId: positive.principal, readOnly: true }, async (_db, c) => ({
      role: (await c.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0],
      sources: (await c.query("SELECT id FROM finnor_os.evidence_sources WHERE id=$1", [positive.disclosure.sourceId])).rows,
      raw: (await c.query("SELECT content,snapshot FROM finnor_os.evidence_source_versions WHERE id=$1", [positive.disclosure.versionId])).rows,
      chunks: (await c.query("SELECT content FROM finnor_os.evidence_chunks WHERE source_id=$1", [positive.disclosure.sourceId])).rows,
      excerpts: (await c.query("SELECT excerpt FROM finnor_os.research_run_hits WHERE research_run_id=$1", [runId])).rows,
      lexical: (await c.query("SELECT content FROM finnor_os.evidence_chunks WHERE search_vector @@ plainto_tsquery('simple',$1)", [canary])).rows,
    }));
    assert.equal(readback.role.rolsuper, false); assert.equal(readback.role.rolbypassrls, false);
    assert.deepEqual(readback.sources, []); assert.deepEqual(readback.raw, []); assert.deepEqual(readback.chunks, []);
    assert.deepEqual(readback.excerpts, []); assert.deepEqual(readback.lexical, []);
    const search = await cb(positive, "search", { root: positive.uiRoot ?? positive.root, query: canary, limit: 100 });
    assert.equal(search.status, 200); assert(!JSON.stringify(search.body).includes(canary));
    const exposed = (await admin!.query("SELECT payload FROM finnor_os.domain_actions WHERE tenant_id=$1 AND action_type='capital_provider_request'", [positive.tenant])).rows;
    assert(!JSON.stringify(exposed).includes("V4_PRIVATE_SYNTHETIC_CANARY_"));
    await artifact("F-reader-boundaries.json", { populated, chunkId, runId, canary, readback, search, rawDisclosureAbsentFromEffects: true });
    return { ordinaryRole: readback.role, populatedChunks: 1, populatedExcerpts: 1, rawRows: 0, chunkRows: 0, excerptRows: 0, lexicalRows: 0, exactPurposeRequired: true };
  });
  await check("F_ENROLLED_WRITER_GUARDS", "Application and physical-worker lock-only UPDATE privilege cannot mutate independently enrolled inputs", async () => {
    const observations = [];
    for (const [name, url] of [["application", environment.DATABASE_URL], ["worker", workerUrl]]) {
      const connection = new pg.Client({ connectionString: url }); await connection.connect();
      try {
        const role = (await connection.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
        assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
        for (const table of ["s1_capital_issuers", "v4_instrument_profiles", "s1_capital_disclosures"]) {
          await connection.query("BEGIN"); let error;
          try {
            await connection.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [positive.tenant, positive.principal]);
            const locked = await connection.query(`SELECT revision FROM finnor_os.${table} WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE`, [positive.tenant, positive.principal]);
            assert(locked.rows.length > 0);
            await connection.query(`UPDATE finnor_os.${table} SET revision=revision WHERE tenant_id=$1 AND principal_id=$2`, [positive.tenant, positive.principal]);
          } catch (e) { error = e instanceof Error ? e.message : String(e); }
          finally { await connection.query("ROLLBACK"); }
          assert.match(error ?? "", /V4 enrolled inputs require an independent owner writer/);
          observations.push({ name, role, table, lockAllowed: true, actualSameValueMutationRejected: true, error });
        }
      } finally { await connection.end(); }
    }
    await artifact("F-enrolled-writer-guards.json", observations);
    return { actualRestrictedRoles: 2, lockOnlyTables: 3, independentlyEnrolledInputsMutable: false };
  });
  await check("E_CURRENT_MATERIAL_GRANT", "Unapproved pricing and guarantee cannot be negotiated under an old exact grant", async () => {
    const terms = structuredClone(positive.snapshot.events.find((e: any) => e.body.kind === "COMMITMENT_EXECUTED").body.terms);
    terms.fixedRate = { numerator: "1", denominator: "2" };
    const view = success(await cb(positive, "capital-formation-read", { programmeId: positive.mandate.programmeId }));
    const rejected = await cb(positive, "capital-formation-proposal", { programmeId: positive.mandate.programmeId, expectedRevision: view.revision,
      terms, recipientId: terms.representativeId, channelId: "capital-disposable-http-v1" });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, "NEGOTIATION_MATERIAL_TERMS_OUTSIDE_GRANT");
    await artifact("E-old-grant.json", rejected); return { code: rejected.body.code, originalGrantRenewed: false };
  });
  await check("J_RECORD_WRITE_IS_NOT_FUNDING", "No current indicative/conditional or invented record mutation can be handed off as an S6 financial draw", async () => {
    const view = success(await cb(positive, "capital-formation-read", { programmeId: positive.mandate.programmeId }));
    const r = await cb(positive, "capital-formation-draw-handoff", { programmeId: positive.mandate.programmeId,
      commitmentId: view.package.commitments[0].commitmentId, expectedRevision: view.revision,
      allocationRef: positive.mandate.budgetGrantRef, drawEffectId: randomUUID() });
    assert.equal(r.status, 409); assert.equal(r.body.code, "EXACT_CURRENT_S5_S6_FINANCING_OBLIGATION_REQUIRED");
    return { negativeBoundary: r.body.code, positiveV3S6FinancingRoute: "BLOCKED_NO_ADMITTED_IMMUTABLE_FINANCING_ADAPTER" };
  });
  if (mounted) await check("F_MOUNTED_CURRENT_WORK_LIFECYCLE", "Actual installed Canvas displays exact original package; Work switching, delayed original replies and authority loss clear private state", async () => {
    const projection = success(await cb(positive, "projection", { root: positive.uiRoot }));
    await artifact("mounted/canonical-projection.json", projection);
    const nativeThread = success(await http(positive, "threads")).threads.find((t: any) => t.activeWorkId === positive.workId);
    assert(nativeThread, "Native intake must link the original Work to its actual Investigation");
    const otherThread = success(await http(positive, "threads", { title: "Separate owned Work scope for lifecycle proof" })).thread;
    const { runMountedCapitalProof } = await import("./browser-proof.mts");
    return runMountedCapitalProof({ origin: authOrigin, positive, threadId: nativeThread.id, otherThreadId: otherThread.id, output, artifact,
      startHolding: () => { holdFinancingReads = true; },
      held: () => heldFinancingReads.length,
      release: () => { holdFinancingReads = false; for (const deliver of heldFinancingReads.splice(0)) deliver(); },
      revoke: async () => {
        await admin!.query("UPDATE finnor_os.s1_capital_disclosures SET revision=revision+1 WHERE tenant_id=$1 AND principal_id=$2 AND evidence_version_id=$3",
          [positive.tenant, positive.principal, positive.disclosure.versionId]);
      },
    });
  });
  await check("G_PHYSICAL_ACCEPTANCE_KILL", "Real process kill after external acceptance retains one original operation and recovers by GET-only observation", async () => {
    const delayed = await fixture(support, "original-kill", true);
    const provider = delayed.domainActors.CORPORATE_DEBT.provider;
    const acceptedExternally = new Promise<any>(yes => provider.cp.on("message", (m: any) => { if (m.kind === "ACCEPTED_ORIGINAL_OPERATION" && m.programmeId === delayed.mandate.programmeId) yes(m); }));
    success(await cb(delayed, "capital-formation-submit", delayed.request));
    const original = await Promise.race([acceptedExternally, sleep(30000).then(() => { throw Error("External acceptance was not observed"); })]);
    assert(worker?.pid); worker.kill("SIGKILL"); await new Promise<void>(r => worker!.once("exit", () => r()));
    const before = (await admin!.query("SELECT id,request_hash,execution_state FROM finnor_os.external_operations WHERE tenant_id=$1", [delayed.tenant])).rows;
    assert.equal(before.length, 1); assert.equal(before[0].id, original.operationId);
    await startWorker();
    const view = await current(delayed, v => v.current && v.package?.conditionalCommittedMinor === "8000000000", 100000);
    const readback = await provider.rpc("READBACK"), mutations = readback.calls.filter((c: any) => c.method === "POST" && c.operationId === original.operationId),
      polls = readback.calls.filter((c: any) => c.method === "GET" && c.operationId === original.operationId);
    assert.equal(mutations.length, 1); assert(polls.length > 0);
    const after = (await admin!.query("SELECT id,request_hash,execution_state FROM finnor_os.external_operations WHERE tenant_id=$1 AND id=$2", [delayed.tenant, original.operationId])).rows;
    assert.equal(after[0].request_hash, before[0].request_hash); assert.equal(after[0].execution_state, "reconciled");
    await artifact("G-original-operation.json", { original, before, after, readback, view, realProcessKill: true, noFreshGrant: true });
    return { originalOperationId: original.operationId, posts: mutations.length, readbacks: polls.length, costsAndResponsibilitiesRetained: true };
  });
  disposeFixture(positive);
  const { runCapitalBoundaryProofs } = await import("./boundary-proof.mts");
  await runCapitalBoundaryProofs({ repo, python, admin, support, cb, http, current, check, artifact, stopWorker, startWorker, killWorker,
    fixture: async (name, options) => fixture(support, name, options?.delayed ?? false, options), dispose: disposeFixture });
  await save();
} catch (error) {
  results.push({ id: "CAMPAIGN_INTERRUPTION", status: "FAIL", error: error instanceof Error ? error.message : String(error), originalDeadlinesPreserved: true });
  if (admin) {
    try {
      await artifact("failure-runtime-diagnostics.json", {
        activity: (await admin.query("SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blocking_pids FROM pg_stat_activity WHERE datname=current_database()")).rows,
        jobs: (await admin.query("SELECT id,type,status,last_error,claim_fence,lease_expires_at,run_at,attempts,max_attempts FROM finnor_os.jobs ORDER BY id")).rows,
        programmes: (await admin.query("SELECT programme_id,status,revision,contacts_spent,steps_spent,cost_unknown,failure FROM finnor_os.v4_programmes")).rows,
      });
    } catch (diagnosticError) { await artifact("failure-runtime-diagnostics.json", { unavailable: String(diagnosticError) }); }
  }
  await save(); process.exitCode = 1;
} finally {
  for (const cp of processes) cp.kill("SIGTERM");
  await sleep(500);
  for (const cp of processes) if (cp.exitCode === null && cp.signalCode === null) cp.kill("SIGKILL");
  await closePool(); await admin?.end(); authServer.close(); await postgres.stop();
}
// async-exit-hook otherwise supplies zero to process.exit on beforeExit, even
// after a retained predicate failed. Preserve the actual campaign verdict.
process.exit(results.some(r => r.status === "FAIL") ? 1 : 0);
