/** Z2 native replay session: creates the extra real owner users, the original Works with same-Work Y1 theory,
 * fixed meanings, canonical claims and S5 reservations through the real owner libraries and bearer routes, freezes
 * the expected values (independent oracle hand profile, never the producer), drains every fixture job, starts the
 * owned replay worker, writes the target declaration, and runs the installed driver. Never prints credentials. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const state = process.env.FINNOR_NATIVE_STATE, out = process.env.FINNOR_NATIVE_EVIDENCE,
  pack = process.env.FINNOR_Z2_PACK_ROOT, installReportPath = process.env.FINNOR_Z2_INSTALL_REPORT,
  issuer = process.env.FINNOR_Z2_AUTH_ISSUER, spkiBase64 = process.env.FINNOR_Z2_AUTH_SPKI_BASE64;
assert(state && out && pack && installReportPath && issuer && spkiBase64, "Z2_SESSION_ENVIRONMENT_REQUIRED");
const isolated = JSON.parse(readFileSync(join(state, "environment.private.json"), "utf8"));
const appEnvFile = JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"));
const appState = JSON.parse(readFileSync(join(state, "native-app-state.json"), "utf8"));
const receipt = JSON.parse(readFileSync(installReportPath, "utf8"));
assert.equal(receipt.engineeringStatus, "PASSED");
const backend = join(pack, "finnor-os");
const require = createRequire(join(backend, "package.json"));
const { Client } = require("pg");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) :
  Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" :
    "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const digestJ = value => sha(canonical(value));

// Library calls in this process connect as the application role inside tenant transactions.
process.env.DATABASE_URL = appEnvFile.DATABASE_URL;
Object.assign(process.env, { NODE_ENV: "test", FINNOR_ENVIRONMENT: "ordinary_disposable",
  FINNOR_Y1_PROFILE: "ordinary_disposable", FINNOR_Y3_PROFILE: "ordinary_disposable",
  FINNOR_Z2_DISPOSABLE_E2E: "1", FINNOR_Z2_CONVERGED_DEVELOPMENT: "1", SECRETS_PROVIDER: "env",
  ALLOW_PLAINTEXT_ENV_SECRETS: "1", TSX_DISABLE_CACHE: "1" });

// Fixture builders are provenance-checked pack files; import them from the pack so this scenario file may
// also run from outside the pack during harness iteration without diverging the verified fixture code.
const L = await import(join(pack, "finnor-os/scripts/project-z/native/z2-fixtures.mjs"));
const lib = await L.loadLibraries(pack);
const admin = new Client({ connectionString: isolated.DATABASE_URL });
await admin.connect();

const evidence = [];
async function step(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const value = await fn();
    evidence.push({ name, startedAt, status: "OK" });
    await writeFile(join(out, "z2-session-receipt.json"), JSON.stringify({ evidence }, null, 2) + "\n", { mode: 0o600 });
    return value;
  } catch (error) {
    evidence.push({ name, startedAt, status: "FAILED", code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) });
    await writeFile(join(out, "z2-session-receipt.json"), JSON.stringify({ evidence }, null, 2) + "\n", { mode: 0o600 });
    throw error;
  }
}

const TENANT_A = "00000000-0000-4000-8000-000000000001", TENANT_B = "99999999-9999-4999-8999-999999999990";
const ROOT_A = { entityType: "external_organization", entityId: "90000000-0000-4000-8000-000000000027" };
const ROOT_B = { entityType: "external_organization", entityId: "99999999-9999-4999-8999-999999999992" };
const MEMBER_TWO = "90000000-0000-4000-8000-000000000045", MEMBER_THREE = "90000000-0000-4000-8000-000000000046";
const FOREIGN_OWNER = "99999999-9999-4999-8999-999999999991";
const apiOrigin = "http://127.0.0.1:3101", frontendOrigin = "http://127.0.0.1:3001";

// Real Auth users for the two seeded extra owner rows and the foreign-tenant owner row. Passwords only here and
// in one 0600 private file; the driver receives them through named environment variables.
const secrets = await step("real-auth-users", async () => {
  const result = {};
  for (const [key, email] of [["ACTOR0", isolated.TEST_OWNER_EMAIL], ["ACTOR1", "phase9.ic.member.two@test.invalid"],
    ["ACTOR2", "phase9.ic.member.three@test.invalid"], ["FOREIGN", "phase9.foreign.owner@test.invalid"]]) {
    const password = key === "ACTOR0" ? isolated.TEST_OWNER_PASSWORD : randomBytes(24).toString("base64url");
    if (key !== "ACTOR0") {
      const created = await fetch(isolated.SUPABASE_URL + "/auth/v1/admin/users", {
        method: "POST", headers: { Authorization: "Bearer " + isolated.SUPABASE_SERVICE_ROLE_KEY,
          apikey: isolated.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true }), signal: AbortSignal.timeout(10000) });
      assert.equal(created.status, 200, "Z2_AUTH_USER_CREATION_FAILED");
    }
    result[key] = { email, password };
  }
  await writeFile(join(out, "z2-actor-secrets.private.json"), JSON.stringify({
    note: "Actor credentials for this disposable replay only. Never committed.", actors: result }) + "\n", { mode: 0o600, flag: "wx" });
  return result;
});

async function login(email, password) {
  const response = await fetch(isolated.SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: isolated.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, "Z2_AUTH_LOGIN_FAILED");
  return (await response.json()).access_token;
}
const tokens = {};
for (const key of ["ACTOR0", "ACTOR1", "ACTOR2", "FOREIGN"]) tokens[key] = await login(secrets[key].email, secrets[key].password);

const actorIds = await step("owner-identity-rows", async () => {
  const rows = (await admin.query("SELECT id::text,tenant_id::text,email,role,status FROM finnor_os.users WHERE id=ANY($1::uuid[])",
    [[MEMBER_TWO, MEMBER_THREE, FOREIGN_OWNER]])).rows;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.role, "owner"); assert.equal(row.status, "active");
    assert.equal(row.tenant_id, row.id === FOREIGN_OWNER ? TENANT_B : TENANT_A);
  }
  const first = (await admin.query("SELECT * FROM finnor_os.resolve_authenticated_identity($1)", [isolated.TEST_OWNER_EMAIL])).rows[0];
  assert(first && first.user_role === "owner" && String(first.tenant_id) === TENANT_A, "Z2_FIRST_OWNER_BINDING");
  return { actor0: String(first.user_id), actor1: MEMBER_TWO, actor2: MEMBER_THREE, foreign: FOREIGN_OWNER };
});

async function api(token, family, operation, body, expected = [200, 202]) {
  const response = await fetch(apiOrigin + "/api/" + family + "/" + operation, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert(expected.includes(response.status), operation + " -> " + response.status + " " + JSON.stringify(value).slice(0, 300));
  return value;
}

// Fixture worker: stock worker from the installed pack, stopped and drained before the replay worker exists.
let fixtureWorker = null;
const workerLogs = [];
function startFixtureWorker() {
  const log = openSync(join(out, "fixture-worker.private.log"), "wx", 0o600);
  fixtureWorker = spawn(process.execPath, ["--import", "tsx", join(backend, "apps/worker/src/index.ts")], {
    cwd: backend, stdio: ["ignore", log, log], env: {
      NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: pack + "/node_modules/.bin:/usr/bin:/bin",
      HOME: out, DATABASE_URL: appEnvFile.FINNOR_WORKER_DATABASE_URL, SECRETS_PROVIDER: "env",
      ALLOW_PLAINTEXT_ENV_SECRETS: "1", WORKER_CONCURRENCY: "1", FINNOR_ENVIRONMENT: "ordinary_disposable",
      FINNOR_Y1_PROFILE: "ordinary_disposable", FINNOR_Y3_PROFILE: "ordinary_disposable", FINNOR_Z2_CONVERGED_DEVELOPMENT: "1",
      SUPABASE_URL: appEnvFile.SUPABASE_URL, SUPABASE_ANON_KEY: appEnvFile.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: appEnvFile.SUPABASE_SERVICE_ROLE_KEY, NODE_EXTRA_CA_CERTS: process.env.FINNOR_Z2_AUTH_CERT,
      FINNOR_Z2_ASSET_ROOT: join(backend, "packages/epistemic-runtime/src/project-z/z2-coalitions"),
      FINNOR_Z2_OWNER_ASSET_ROOT: join(backend, "packages/private-equity/src/project-z/z2-coalitions"),
      FINNOR_Y3_ASSET_ROOT: join(backend, "packages/private-equity/src/interaction-synthesis"),
      FINNOR_Y3_OWNER_ASSET_ROOT: join(backend, "packages/private-equity/src/interaction-synthesis") } });
  closeSync(log);
  return fixtureWorker;
}
async function stopFixtureWorker() {
  if (!fixtureWorker || fixtureWorker.exitCode !== null) return;
  fixtureWorker.kill("SIGTERM");
  await Promise.race([new Promise(done => fixtureWorker.once("exit", done)), delay(8000)]);
  if (fixtureWorker.exitCode === null) fixtureWorker.kill("SIGKILL");
  await new Promise(done => fixtureWorker.once("exit", done));
}

const horizon = { startAt: new Date(Date.now() - 3600000).toISOString(), periodMs: 7200000, periods: 1 };
const period = { startAt: horizon.startAt, endAt: new Date(Date.parse(horizon.startAt) + horizon.periodMs).toISOString() };

async function theory(tenant, principal, token, root, label) {
  const problem = lib.y1.publicProblem(root, period, label);
  const bound = await L.bindCanonicalInputs(lib, admin, tenant, principal, root, problem, label);
  const accepted = await api(token, "company-brain", "economic-theory-submit", bound.request, [202]);
  let view;
  for (let i = 0; i < 240; i++) {
    await delay(1500);
    view = await api(token, "company-brain", "economic-theory-read", { theoryId: accepted.theoryId });
    if (!["QUEUED", "CONSTRUCTING", "CHECKING"].includes(view.status)) break;
  }
  assert.equal(view.status, "CHECKED", "Z2_THEORY_CONSTRUCTION_FAILED:" + label);
  await api(token, "company-brain", "economic-theory-admit", { theoryId: accepted.theoryId });
  return { ...bound, accepted, view };
}

async function expectedFor(problem) {
  const run = spawnSync("/usr/bin/python3", ["-I", "-B", join(pack, "finnor-os/scripts/project-z/native/z2-expected.py"), pack],
    { input: JSON.stringify(problem), encoding: "utf8", timeout: 60000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  assert.equal(run.status, 0, "Z2_EXPECTED_ORACLE_FAILED:" + String(run.stderr).slice(0, 300));
  return JSON.parse(run.stdout);
}

const mixtureModel = (modelRef, principal, peer) => {
  // z2/fixtures.py mixture family, rebased onto the real canonical model claim; every node carries the reservation
  // state unchanged so every terminal lowers to NO_EFFECT.
  const base = lib.math.dynamicFixture();
  const mixture = JSON.parse(JSON.stringify(base.models[0]));
  const nodes = [], resources = { available: "3", committed: "2" };
  const add = (id, date, kind, fields) => { nodes.push({ id, date, state: [0, 1], kind, observations: [],
    resources: { ...resources }, payments: ["0", "0"], liabilities: ["0", "0"], ...fields }); };
  add("unverified-prior", 0, "CHANCE", { chanceRole: "PRIOR",
    probabilityBasis: { population: "public-synthetic", conditioning: "ex-ante", identificationRef: modelRef },
    edges: [{ actionId: "s0", next: "unverified-s0", probability: "1/2" }, { actionId: "s1", next: "unverified-s1", probability: "1/2" }] });
  for (const state of [0, 1]) {
    const nid = "unverified-s" + state;
    add(nid, 0, "DECISION", { participant: "P0",
      observations: [{ key: "private-state", value: String(state), recipients: ["P0"] }],
      edges: ["coordinate", "stay"].map(a => ({ actionId: a, next: nid + "-" + a })) });
    for (const early of ["coordinate", "stay"]) {
      const mid = nid + "-" + early;
      add(mid, 1, "DECISION", { participant: "P1", edges: ["join", "decline"].map(a => ({ actionId: a, next: mid + "-" + a })) });
      for (const later of ["join", "decline"]) {
        const fin = mid + "-" + later;
        add(fin, 2, "DECISION", { participant: "P0", edges: ["left", "right"].map(a => ({ actionId: a, next: fin + "-" + a })) });
        for (const last of ["left", "right"]) {
          const payoff = early === "coordinate" && later === "join" ? (last === "left" ? ["4", "-2"] : ["-1", "1"])
            : early === "coordinate" ? ["-1", "0"] : later === "join" ? ["0", "-1"] : ["0", "0"];
          add(fin + "-" + last, 2, "TERMINAL", { payoff, ownerValue: "2" });
        }
      }
    }
  }
  mixture.root = "unverified-prior"; mixture.nodes = nodes;
  return mixture;
};

async function caseFixture(label, recovery, principal, peer, token, change) {
  const th = await theory(TENANT_A, principal, token, ROOT_A, label);
  const input = await L.interactionInput(lib, admin, TENANT_A, principal, peer, ROOT_A, th, label, change);
  const expected = await expectedFor(input.request.problem);
  const owned = await api(token, "allocations", "resource",
    { resource: L.resourceInput(lib, TENANT_A, principal, ROOT_A, horizon, label) });
  const held = await api(token, "company-brain", "economic-reservation-create", {
    theoryId: th.accepted.theoryId, initialState: { available: "3", committed: "2" },
    bindings: th.request.problem.quantities.map(q => ({ quantityId: q.id, resourceRef: owned.ref })), idempotencyKey: randomUUID() });
  const doneOutcome = input.request.lowering.outcomes.find(o => o.terminalNodeId.endsWith("-done"));
  const observation = await L.observationSource(lib, admin, TENANT_A, ROOT_A, input.request, "P0", 0, "market", "0");
  return { id: label, recovery, request: input.request, originalRequestDigest: digestJ(input.request),
    expectedOriginalUtilitiesDigest: digestJ(expected.utilities),
    expectedInternalEffectDigest: digestJ(L.effectMeaning(doneOutcome)),
    expectedInternalEffectKind: doneOutcome.kind, reservation: { ref: held.origin.ref, expectedRevision: held.revision },
    actionByInformationKey: expected.actionByInformationKey,
    canonicalObservations: [{ actorIndex: 0, observation: { date: 0, key: "market", value: "0",
      classification: "SOURCED_FACT", source: observation } }],
    modelSourceId: input.modelSource.sourceId };
}

const protocolOutcomes = async () => {
  const outcomes = {};
  for (const [name, [family, operation, input, token, until]] of Object.entries(pending)) {
    for (let i = 0; i < 240; i++) {
      await delay(1500);
      const view = await api(token, family, operation, input);
      const status = view.status;
      if (!["QUEUED", "CONSTRUCTING", "CHECKING"].includes(status)) { outcomes[name] = view; break; }
      assert(i < 239, "Z2_FIXTURE_CONSTRUCTION_TIMEOUT:" + name);
    }
    assert.equal(outcomes[name].status, until, name + " -> " + JSON.stringify(outcomes[name]).slice(0, 200));
  }
  return outcomes;
};
const pending = {};

await step("fixture-worker-start", async () => startFixtureWorker());

const cases = [];
for (const [label, recovery] of [["c-claim", "CLAIM"], ["c-checkpoint", "CHECKPOINT"],
  ["c-artifact", "ARTIFACT"], ["c-partial", "PARTIAL_CONSENT"]]) {
  cases.push(await step("case-fixture-" + label, () =>
    caseFixture(label, recovery, actorIds.actor0, actorIds.actor1, tokens.ACTOR0, problem => {
      // One SOURCED_FACT market observation cuts the chance branches; the private type is visible to everyone so
      // every later local view is unambiguous without another observation.
      for (const node of problem.models[0].nodes)
        for (const observation of node.observations ?? [])
          if (observation.key === "private-type") observation.recipients = ["PUBLIC"];
      problem.observationRules = [
        { key: "market", allowedRecipients: ["PUBLIC"], mandatoryByDate: 0, classification: "SOURCED_FACT",
          sourceRef: problem.models[0].qualificationRef },
        { key: "private-type", allowedRecipients: ["P0", "P1", "PUBLIC"], mandatoryByDate: null,
          classification: "MODEL_RELATIVE_STATEMENT", sourceRef: problem.models[0].qualificationRef }];
    })));
}

// Preexisting negatives. N1: real CHECKED protocol whose second participant is suspended afterwards (revoked rights).
// N2: real CHECKED protocol whose model source then moves (stale source). N3: producer-UNSUPPORTED (policy alphabet
// bound). N4: producer-INCOMPLETE (mixture family, frozen expectation). N5: real protocol in the foreign tenant.
const negatives = await step("negative-fixtures", async () => {
  const n1Theory = await theory(TENANT_A, actorIds.actor0, tokens.ACTOR0, ROOT_A, "n-revoked");
  const n1 = await L.interactionInput(lib, admin, TENANT_A, actorIds.actor0, actorIds.actor2, ROOT_A, n1Theory, "n-revoked");
  const n1Submitted = await api(tokens.ACTOR0, "company-brain", "coalition-submit", n1.request, [202]);
  pending.n1 = ["company-brain", "interaction-read", { protocolId: n1Submitted.protocolId }, tokens.ACTOR0, "CHECKED"];

  const n2Theory = await theory(TENANT_A, actorIds.actor0, tokens.ACTOR0, ROOT_A, "n-stale");
  const n2 = await L.interactionInput(lib, admin, TENANT_A, actorIds.actor0, actorIds.actor1, ROOT_A, n2Theory, "n-stale");
  const n2Submitted = await api(tokens.ACTOR0, "company-brain", "coalition-submit", n2.request, [202]);
  pending.n2 = ["company-brain", "interaction-read", { protocolId: n2Submitted.protocolId }, tokens.ACTOR0, "CHECKED"];

  const n3Theory = await theory(TENANT_A, actorIds.actor0, tokens.ACTOR0, ROOT_A, "n-unsupported");
  const n3 = await L.interactionInput(lib, admin, TENANT_A, actorIds.actor0, actorIds.actor1, ROOT_A, n3Theory, "n-unsupported", problem => {
    problem.controls = [...problem.controls, ...Array.from({ length: 7 }, (_, i) =>
      ({ id: "pad-" + i, kind: "DISCLOSURE", options: ["a", "b"] }))];
  });
  const n3Submitted = await api(tokens.ACTOR0, "company-brain", "coalition-submit", n3.request, [202]);
  pending.n3 = ["company-brain", "interaction-read", { protocolId: n3Submitted.protocolId }, tokens.ACTOR0, "UNSUPPORTED"];

  const n4Theory = await theory(TENANT_A, actorIds.actor0, tokens.ACTOR0, ROOT_A, "n-incomplete");
  const n4 = await L.interactionInput(lib, admin, TENANT_A, actorIds.actor0, actorIds.actor1, ROOT_A, n4Theory, "n-incomplete", problem => {
    problem.models[0] = mixtureModel(problem.models[0].qualificationRef, actorIds.actor0, actorIds.actor1);
    problem.controls = [];
    problem.observationRules = [{ key: "private-state", allowedRecipients: ["P0"], mandatoryByDate: null,
      classification: "MODEL_RELATIVE_STATEMENT", sourceRef: problem.models[0].qualificationRef }];
  });
  const n4Submitted = await api(tokens.ACTOR0, "company-brain", "coalition-submit", n4.request, [202]);
  pending.n4 = ["company-brain", "interaction-read", { protocolId: n4Submitted.protocolId }, tokens.ACTOR0, "INCOMPLETE"];

  // The foreign tenant has one seeded owner; a second owner identity row is bootstrapped exactly like the phase9
  // seed inserts identity rows, so the tenant-B protocol can carry two distinct real principals.
  const foreignPeer = randomUUID();
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Z2 Foreign Second Owner')",
    [foreignPeer, TENANT_B, "z2.foreign.peer." + foreignPeer + "@test.invalid"]);
  const n5Theory = await theory(TENANT_B, actorIds.foreign, tokens.FOREIGN, ROOT_B, "n-foreign");
  const n5 = await L.interactionInput(lib, admin, TENANT_B, actorIds.foreign, foreignPeer, ROOT_B, n5Theory, "n-foreign");
  const n5Submitted = await api(tokens.FOREIGN, "company-brain", "coalition-submit", n5.request, [202]);
  pending.n5 = ["company-brain", "interaction-read", { protocolId: n5Submitted.protocolId }, tokens.FOREIGN, "CHECKED"];
  return { n1Submitted, n2Submitted, n3Submitted, n4Submitted, n5Submitted, n2ModelSourceId: n2.modelSource.sourceId };
});

await step("fixture-constructions", async () => {
  const outcomes = await protocolOutcomes();
  assert.equal(outcomes.n1.protocolId, negatives.n1Submitted.protocolId);
  // Stale source: the model claim source of the CHECKED N2 protocol moves to a new head version.
  await lib.memory.appendEvidenceVersion(TENANT_A, negatives.n2ModelSourceId,
    { content: JSON.stringify({ moved: "n-stale", at: new Date().toISOString() }), snapshot: { note: "stale-source negative" }, asOf: new Date() });
});

// Revoked rights: the second participant of N1 stays an active, authenticated owner but receives an active deny grant on
// world queries through a dedicated role (authority tables, the same rows scripts/s1/run-s1-e2e.mts writes for its deny).
// A suspended identity could not authenticate, so identity suspension is deliberately not used.
await step("revoked-rights-authority", async () => {
  const role = (await admin.query("INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,'z2-revoked-world-query','Z2 revoked world query') RETURNING id",
    [TENANT_A])).rows[0].id;
  await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id) VALUES($1,$2,$3)", [TENANT_A, MEMBER_THREE, role]);
  await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:pe_world_state','*','deny')",
    [TENANT_A, role]);
});

await step("fixture-jobs-drained-and-worker-stopped", async () => {
  for (let i = 0; i < 240; i++) {
    const rows = (await admin.query("SELECT count(*)::int count FROM finnor_os.jobs WHERE status IN ('queued','running')")).rows;
    if (rows[0].count === 0) break;
    assert(i < 239, "Z2_FIXTURE_QUEUE_DRAIN_TIMEOUT");
    await delay(1500);
  }
  await stopFixtureWorker();
  const open = (await admin.query("SELECT type,status,count(*)::int count FROM finnor_os.jobs WHERE status IN ('queued','running','failed','dead_letter') GROUP BY 1,2")).rows;
  assert.equal(open.length, 0, "Z2_UNRELATED_JOBS_REMAIN:" + JSON.stringify(open));
});

const replayWorker = await step("owned-initial-replay-worker", async () => {
  const log = openSync(join(out, "replay-worker-initial.private.log"), "wx", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", join(backend, "apps/worker/src/index.ts")], {
    cwd: backend, stdio: ["ignore", log, log], env: {
      NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      PATH: dirname(process.execPath) + ":/usr/bin:/bin",
      HOME: join(out, "worker-home-initial"), DATABASE_URL: appEnvFile.FINNOR_WORKER_DATABASE_URL,
      SECRETS_PROVIDER: "env", WORKER_JOB_LEASE_SECONDS: "10", WORKER_CONCURRENCY: "1",
      FINNOR_ENVIRONMENT: "ordinary_disposable", FINNOR_Y1_PROFILE: "ordinary_disposable",
      FINNOR_Y3_PROFILE: "ordinary_disposable", FINNOR_Z2_CONVERGED_DEVELOPMENT: "0",
      FINNOR_Z2_DISPOSABLE_REPLAY_WORKER: "1", FINNOR_Z2_EXCLUSIVE_REPLAY_DATABASE: "1",
      FINNOR_Z2_REPLAY_TENANT_ID: TENANT_A, FINNOR_Z2_REPLAY_WORK_IDS: JSON.stringify(cases.map(c => c.request.workId)),
      FINNOR_Z2_ENABLE_PHYSICAL_RECOVERY: "0", FINNOR_Z2_RECOVERY_WORK_ID: "", FINNOR_Z2_RECOVERY_BOUNDARY: "",
      FINNOR_Z2_RECOVERY_NONCE: "",
      FINNOR_Z2_ASSET_ROOT: join(backend, "packages/epistemic-runtime/src/project-z/z2-coalitions"),
      FINNOR_Z2_OWNER_ASSET_ROOT: join(backend, "packages/private-equity/src/project-z/z2-coalitions"),
      FINNOR_Y3_ASSET_ROOT: join(backend, "packages/private-equity/src/interaction-synthesis"),
      FINNOR_Y3_OWNER_ASSET_ROOT: join(backend, "packages/private-equity/src/interaction-synthesis") } });
  closeSync(log);
  await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
  await delay(3000);
  assert.equal(child.exitCode, null, "Z2_INITIAL_REPLAY_WORKER_EXITED");
  return child;
});

function identityOf(pid) {
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const fd = openSync("/proc/" + pid + "/cmdline", "r");
  try {
    const chunks = [];
    while (true) {
      const buffer = Buffer.alloc(65536), read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      chunks.push(buffer.subarray(0, read));
    }
    return { pid, startTicks: fields[19], cmdlineSha256: sha(Buffer.concat(chunks)) };
  } finally { closeSync(fd); }
}

const targetPath = join(out, "z2-target.private.json");
const replayEvidence = join(out, "z2-replay");
const buildReceiptSha256 = sha(readFileSync(installReportPath));
const sourceFinal = JSON.parse(readFileSync(join(resolve(installReportPath, ".."), "source-final-sha256.json"), "utf8"));
const driverExit = await step("native-replay-driver", async () => {
  const target = {
    schema: "finnor.project-z.z2.native-replay-target.v1",
    authorization: {
      explicitDisposableExecution: true, noDatabaseInitialization: true, noGrantsOrProvisioning: true,
      noExternalOrFinancialEffects: true, realAuthOnly: true, ownedWorkerKillAndSameBuildRestart: true,
      exclusiveNativeReplayDatabase: true, consumeOriginalRemainingConstructionBudget: true,
      leaveOwnedWorkerStoppedAfterReplay: true, expiresAt: new Date(Date.now() + 6 * 3600000).toISOString() },
    origin: frontendOrigin, apiOrigin,
    frontendAuthIssuer: issuer, apiAuthIssuer: issuer, authIssuerSpkiSha256Base64: spkiBase64,
    sourceRoot: pack, sourceSha256: sourceFinal,
    buildReceiptPath: installReportPath, buildReceiptSha256,
    tenantId: TENANT_A,
    database: { environmentName: "FINNOR_Z2_REPLAY_DATABASE_URL", host: "127.0.0.1", port: 55441, name: "finnor" },
    worker: { ...identityOf(replayWorker.pid), coupledSupervisor: false },
    processes: { api: identityOf(appState.pids.api), frontend: identityOf(appState.pids.frontend) },
    actors: [
      { userId: actorIds.actor0, principalId: actorIds.actor0, emailEnvironmentName: "FINNOR_Z2_ACTOR0_EMAIL", passwordEnvironmentName: "FINNOR_Z2_ACTOR0_PASSWORD" },
      { userId: actorIds.actor1, principalId: actorIds.actor1, emailEnvironmentName: "FINNOR_Z2_ACTOR1_EMAIL", passwordEnvironmentName: "FINNOR_Z2_ACTOR1_PASSWORD" },
      { userId: actorIds.actor2, principalId: actorIds.actor2, emailEnvironmentName: "FINNOR_Z2_ACTOR2_EMAIL", passwordEnvironmentName: "FINNOR_Z2_ACTOR2_PASSWORD" }],
    cases: cases.map(({ modelSourceId, ...rest }) => rest),
    preexistingNegativeCases: [
      { kind: "UNSUPPORTED", actorIndex: 0, operation: "interaction-read",
        input: { protocolId: negatives.n3Submitted.protocolId }, httpStatuses: [200], expectedCodeOrStatus: "UNSUPPORTED" },
      { kind: "INCOMPLETE", actorIndex: 1, operation: "interaction-read",
        input: { protocolId: negatives.n4Submitted.protocolId }, httpStatuses: [200], expectedCodeOrStatus: "INCOMPLETE" },
      { kind: "STALE_SOURCE", actorIndex: 0, operation: "interaction-admit",
        input: { protocolId: negatives.n2Submitted.protocolId }, httpStatuses: [422], expectedCodeOrStatus: "Y3_PROTOCOL_DEPENDENCIES_CHANGED" },
      { kind: "REVOKED_RIGHTS", actorIndex: 2, operation: "interaction-local",
        input: { protocolId: negatives.n1Submitted.protocolId }, httpStatuses: [404], expectedCodeOrStatus: "Y3_AUTHENTICATED_RESOURCE_UNAVAILABLE" },
      { kind: "CROSS_TENANT", actorIndex: 0, operation: "interaction-read",
        input: { protocolId: negatives.n5Submitted.protocolId }, httpStatuses: [404], expectedCodeOrStatus: "Y3_AUTHENTICATED_RESOURCE_UNAVAILABLE" },
      { kind: "RESOURCE_BOUND", actorIndex: 0, operation: "coalition-submit",
        input: { schema: "finnor.interaction-request.v1", note: "resource-bound negative", pad: "x".repeat(1100000) },
        httpStatuses: [413], expectedCodeOrStatus: "Y3_REQUEST_BYTE_BOUND" }] };
  await writeFile(targetPath, JSON.stringify(target, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const validate = spawnSync(process.execPath, [join(backend, "scripts/project-z/z2/native-replay.mjs"),
    "--validate-target", "--target", targetPath, "--evidence-dir", join(out, "z2-validate")], {
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", LANG: "C.UTF-8", HOME: out }, encoding: "utf8", timeout: 300000 });
  await writeFile(join(out, "z2-validate-output.private.log"), String(validate.stdout) + String(validate.stderr), { mode: 0o600 });
  assert.equal(validate.status, 0, "Z2_TARGET_VALIDATION_FAILED");
  const log = openSync(join(out, "z2-driver.private.log"), "wx", 0o600);
  const child = spawn(process.execPath, [join(backend, "scripts/project-z/z2/native-replay.mjs"),
    "--execute-native", "--target", targetPath, "--evidence-dir", replayEvidence], {
    stdio: ["ignore", log, log], env: {
      PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: out, TMPDIR: out,
      NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      FINNOR_ENVIRONMENT: "ordinary_disposable", FINNOR_Y1_PROFILE: "ordinary_disposable",
      FINNOR_Y3_PROFILE: "ordinary_disposable", FINNOR_Z2_CONVERGED_DEVELOPMENT: "1", FINNOR_Z2_DISPOSABLE_E2E: "1",
      FINNOR_Z2_REPLAY_DATABASE_URL: appEnvFile.FINNOR_WORKER_DATABASE_URL,
      FINNOR_Z2_ACTOR0_EMAIL: secrets.ACTOR0.email, FINNOR_Z2_ACTOR0_PASSWORD: secrets.ACTOR0.password,
      FINNOR_Z2_ACTOR1_EMAIL: secrets.ACTOR1.email, FINNOR_Z2_ACTOR1_PASSWORD: secrets.ACTOR1.password,
      FINNOR_Z2_ACTOR2_EMAIL: secrets.ACTOR2.email, FINNOR_Z2_ACTOR2_PASSWORD: secrets.ACTOR2.password } });
  closeSync(log);
  const code = await new Promise(done => child.once("exit", done));
  return code;
});

// The initial replay worker is owned here; the driver kills it at the first case boundary and leaves its own last
// replacement stopped. If the driver never ran, stop ours now.
if (replayWorker.exitCode === null) {
  replayWorker.kill("SIGTERM");
  await Promise.race([new Promise(done => replayWorker.once("exit", done)), delay(5000)]);
  if (replayWorker.exitCode === null) replayWorker.kill("SIGKILL");
}
const report = JSON.parse(await readFile(join(replayEvidence, "report.json"), "utf8").catch(() => "null"));
console.log(JSON.stringify({ status: "Z2_SESSION_COMPLETE", driverExit, driverStatus: report?.status ?? null,
  authenticatedOwner: report?.authenticatedOwner ?? null, physicalRecovery: report?.physicalRecovery ?? null,
  installedOwnerExecution: report?.installedOwnerExecution ?? null, target: targetPath, replayEvidence }));
process.exit(driverExit === 0 ? 0 : 1);
