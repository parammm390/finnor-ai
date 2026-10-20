/** Finite real-owner HTTP/SQL/queue/native story, oracles registered before code.
 * No protected receipt, field law, payment or live acquisition is synthesized. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawnSync, execFileSync, fork, type ChildProcess } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { httpFixture } from "./http-fixture.mts";
import { createUpstreamFixtureSupport } from "../s5/owner-fixture.mts";
import { economicFixture } from "../s7/economic-fixtures.mts";

const repo = resolve(import.meta.dirname, "../../..");
const outputArg = process.argv.indexOf("--output"), out = process.argv[outputArg + 1];
if (outputArg < 0 || !out?.startsWith("/")) throw Error("FRESH_ABSOLUTE_OUTPUT_REQUIRED");
const resumeArg = process.argv.indexOf("--resume-mounted"), priorOutput = resumeArg < 0 ? null : process.argv[resumeArg + 1];
if (priorOutput && !priorOutput.startsWith("/")) throw Error("ABSOLUTE_RETAINED_MOUNTED_EVIDENCE_REQUIRED");
const retained = priorOutput ? JSON.parse(await readFile(join(priorOutput, "retained-disposable-directory.json"), "utf8")) : null;
if (retained && retained.stopped !== true) throw Error("ONLY_STOPPED_OWNED_DISPOSABLE_MAY_BE_RESUMED");
await mkdir(out, { recursive: false, mode: 0o700 });
const results: any[] = [], calls: any[] = [], started = Date.now();
const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const artifact = async (name: string, value: unknown) => {
  const path = join(out, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  return path;
};
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const packaged = process.env.FINNOR_R4_PACKAGED_SOURCE === "1";
if (packaged && (!/^[0-9a-f]{40}$/.test(process.env.FINNOR_COMMIT_SHA ?? "") ||
    !/^[0-9a-f]{40}$/.test(process.env.FINNOR_R4_SOURCE_TREE ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(process.env.FINNOR_R4_IMAGE_ID ?? ""))) throw Error("EXACT_INSTALLED_IMAGE_IDENTITY_REQUIRED");
const dirtyPaths = packaged
  ? ["finnor-os/Dockerfile.worker", "finnor-os/scripts/r4/requirements.lock",
     "finnor-os/packages/epistemic-runtime/src/identification-plan/producer.py",
     "finnor-os/packages/epistemic-runtime/src/identification-plan/checker.py",
     "finnor-os/packages/epistemic-runtime/src/identification-plan/supervisor.py"]
  : execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"],
      {encoding: "utf8", maxBuffer: 16 * 1024 * 1024}).trimEnd().split("\n").filter(Boolean).map(s => s.slice(3));
const sourceIdentity = await Promise.all(dirtyPaths.map(async path => ({
  path, sha256: packaged ? sha(await readFile(join(repo, path)))
    : await readFile(join(repo, path)).then(sha).catch(() => null),
})));
await artifact("freeze.json", { head: packaged ? process.env.FINNOR_COMMIT_SHA : git("rev-parse", "HEAD"),
  tree: packaged ? process.env.FINNOR_R4_SOURCE_TREE : git("rev-parse", "HEAD^{tree}"),
  packagedSource: packaged, imageId: packaged ? process.env.FINNOR_R4_IMAGE_ID : null,
  sourceIdentity, node: process.version, platform: process.platform, startedUTC: new Date(started).toISOString(),
  expected: { selectedBundles: ["affordable-joint"], cost: { numerator: "2", denominator: "1" },
    completion: { numerator: "1", denominator: "1" }, masks: 4, pairs: 12,
    functional: "P(outcome|price)", prospective: true, scientificAdmission: null },
  qualification: "REAL_DISPOSABLE_AUTHENTICATED_OWNERS_NOT_FIELD_OR_PROTECTED_GATES",
  limits: { wallSeconds: 1800, ownerFixtures: 8, physicalDeliveries: 32, totalMoneyUSD: null } });
async function save() { await artifact("results.json", { results, calls, elapsedMs: Date.now() - started,
  qualifiedScope: "R4_ON_PINNED_MAIN_DISPOSABLE_DEVELOPMENT", moneyUSD: null,
  completeCostQualification: "MATERIAL_METERS_INCOMPLETE", combinedR1R4: "NOT_RUN" }); }
async function story(id: string, expected: string, fn: () => Promise<unknown>) {
  const begin = performance.now();
  try { results.push({ id, expected, status: "PASS", observed: await fn(), elapsedMs: performance.now() - begin }); }
  catch (e) { results.push({ id, expected, status: "FAIL", message: String(e), stack: (e as Error).stack,
    code: (e as any).code ?? null, elapsedMs: performance.now() - begin }); }
  console.log(JSON.stringify({ id, status: results.at(-1).status }));
  await save();
}
const directory = retained?.directory ?? await mkdtemp(join(tmpdir(), "finnor-r4-owner-"));
const port = retained?.databasePort ?? await new Promise<number>((yes, no) => {
  const server = createServer(); server.once("error", no);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address(); if (!address || typeof address === "string") return no(Error("PORT_REQUIRED"));
    server.close(() => yes(address.port));
  });
});
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor",
  port, persistent: true, onLog: () => undefined });
let admin: pg.Client | undefined, http: Awaited<ReturnType<typeof httpFixture>> | undefined, queue: any, workerChild: ChildProcess | undefined;
const runtimeBase = "/Users/paramdave/.factory/worktrees/r4-identification-plan-compiler/runtime";
process.env.NODE_ENV = "test"; process.env.LOG_LEVEL = "silent";
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit"; process.env.FINNOR_P4_PROFILE = "ordinary_disposable";
process.env.FINNOR_R4_PYTHON ??= join(runtimeBase, "y0/bin/python");
process.env.FINNOR_S3_PYTHON ??= join(runtimeBase, "numerical/bin/python");
process.env.FINNOR_S5_PYTHON ??= process.env.FINNOR_S3_PYTHON;
process.env.FINNOR_S3_MODEL_STORE = join(directory, "s3");
process.env.FINNOR_S4_POLICY_STORE = join(directory, "s4");
process.env.FINNOR_S5_ALLOCATION_STORE = join(directory, "s5");
const fixtures: Record<string, any> = {};
type FixtureOptions = { expiryMs?: number; prices?: [number, number]; delays?: [number, number];
  capacity?: number; twoWorks?: boolean; lawMode?: "UNSUPPORTED" | "UNKNOWN_CHEAPER" };
const fixtureOptions = new Map<string, FixtureOptions>();
let f: any, support: ReturnType<typeof createUpstreamFixtureSupport>, registration: any, registered: any, accepted: any;
function ok(result: any, status = 200) { assert.equal(result.status, status, JSON.stringify(result)); return result.body; }
async function ownerApi(scope: any, op: string, body: any, handler?: any) {
  const { POST: allocation } = await import("../../apps/api/app/api/allocations/[operation]/route");
  scope.bearer ??= await http!.issue(scope.tenant, scope.principal);
  if (op === "fit" && !scope.r4Problem) {
    const db = await import("@finnor/db"), pe = await import("@finnor/private-equity"), memory = await import("@finnor/memory");
    scope.otherPrincipal = randomUUID();
    await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [scope.otherPrincipal, scope.tenant, scope.otherPrincipal + "@r4.example.test"]);
    scope.otherBearer = await http!.issue(scope.tenant, scope.otherPrincipal);
    scope.deal = await pe.createDeal(scope.ctx, { targetOrganizationId: scope.root.entityId,
      name: "R4 conditional observational acquisition Work", dealLeadEmployeeId: scope.principal,
      signedLoiAt: new Date(Date.now() - 86400000), targetClosingAt: new Date(Date.now() + 86400000) });
    scope.work = await db.receiveWork({ tenantId: scope.tenant, userId: scope.principal,
      instruction: "Review the least registered-cost conditional observational acquisition.",
      channel: "console", idempotencyKey: randomUUID(), activeContext: { entityRefs: [scope.root] } });
    if (fixtureOptions.get(scope.name)?.twoWorks) scope.competingWork = await db.receiveWork({
      tenantId: scope.tenant, userId: scope.principal,
      instruction: "Competing identification under the unchanged original S4/S5 grant.",
      channel: "console", idempotencyKey: randomUUID(), activeContext: { entityRefs: [scope.root] } });
    const source = await memory.createEvidenceSource(scope.tenant, { sourceKey: "r4-laws-" + randomUUID(),
      sourceType: "manual", title: "Owner-declared hypothetical collection laws, not observed distributions" });
    const version = randomUUID();
    scope.times = { start: new Date(Date.now() + 60000).toISOString(), end: new Date(Date.now() + 36 * 31 * 86400000).toISOString() };
    const native = spawnSync(process.env.FINNOR_R4_PYTHON!, ["-c",
      "import sys,json;sys.path.insert(0,sys.argv[1]);from corpus import base,bundle;p=base();bundle(p,'affordable-joint',cost=2);bundle(p,'expensive-joint',cost=5,delay=5);p['baseline']=[];print(json.dumps(p))",
      join(repo, "finnor-os/scripts/r4")], { encoding: "utf8", timeout: 20000 });
    assert.equal(native.status, 0, native.stderr);
    const p = JSON.parse(native.stdout), options = fixtureOptions.get(scope.name);
    if (options?.prices) for (const [i, cost] of p.costItems.entries())
      cost.amount = { numerator: String(options.prices[i]), denominator: "1" };
    if (options?.delays) for (const [i, bundle] of p.bundles.entries())
      bundle.schedule.duration = { numerator: String(options.delays[i]), denominator: "1" };
    if (options?.delays) p.constraints.collectBy = { numerator: "1000", denominator: "1" };
    if (options?.lawMode === "UNSUPPORTED") for (const bundle of p.bundles) bundle.laws[0].kind = "EXPERIMENTAL";
    if (options?.lawMode === "UNKNOWN_CHEAPER") p.bundles[0].laws[0].premises.positivity.status = "UNKNOWN";
    const rename = (v: any): any => typeof v === "string" ? ({ X: "price", Y: "outcome" } as any)[v] ?? v
      : Array.isArray(v) ? v.map(rename) : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [({ X: "price", Y: "outcome" } as any)[k] ?? k, rename(x)])) : v;
    scope.r4Problem = rename(p);
    scope.r4Problem.query.scope.population = "r4-population-" + scope.root.entityId;
    scope.r4Problem.query.scope.intervention = "r4-set-price-" + scope.root.entityId;
    scope.r4Problem.query.scope.time = scope.times;
    scope.r4Problem.query.scope.units = { price: "fraction", outcome: "normalized-value" };
    scope.r4Problem.variables = [{ id: "price", unit: "fraction" }, { id: "outcome", unit: "normalized-value" }];
    scope.r4Problem.graphs = Array.from({ length: 3 }, (_, i) => ({ ...scope.r4Problem.graphs[0], id: "g" + (i + 1) }));
    scope.r4Problem.constraints.resourceOrder = ["compute"];
    scope.r4Problem.constraints.resources = [{ id: "compute", unit: "native-attempt", capacity: { numerator: String(options?.capacity ?? 64), denominator: "1" } }];
    scope.r4Problem.constraints.costBasis.horizon = scope.times;
    for (const cost of scope.r4Problem.costItems) cost.basis = structuredClone(scope.r4Problem.constraints.costBasis);
    for (const bundle of scope.r4Problem.bundles) {
      bundle.resources = [{ id: "compute", quantity: { numerator: "1", denominator: "1" } }];
      for (const law of bundle.laws) {
        law.scope = structuredClone(scope.r4Problem.query.scope);
        law.sourceRefs = [version];
        for (const premise of Object.values(law.premises) as any[])
          premise.reason = "Hypothetical prospective same-cohort complete joint and support, conditional on successful permitted collection, not observed numeric training counts.";
      }
    }
    scope.r4Source = { sourceId: source.id, versionId: version };
    // Query intervention version is declared before fit, not its coefficient model.
    // All laws are immutable before S3/S4 freeze their source cut.
    await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,$2,'tenant',$3,1,$4,'Hypothetical prospective collection declaration',$5::jsonb,clock_timestamp())",
      [version, source.id, scope.tenant, sha(version), JSON.stringify({ worldRoot: scope.root,
        identificationLaws: scope.r4Problem.bundles.flatMap((b: any) => b.laws) })]);
    await pe.attachCanonicalEvidenceToWorld(scope.ctx, { worldRoot: scope.root,
      entity: { entityType: "pe_metric_series", entityId: body.request.stateVariables[0].seriesId },
      evidenceSourceId: source.id, evidenceVersionId: version, relationship: "supports" });
  }
  const response = await (handler ?? allocation)(new Request("http://127.0.0.1/api/owner/" + op, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + scope.bearer },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ operation: op }) });
  const result = { status: response.status, body: await response.json() as any };
  calls.push({ ownerOperation: op, status: result.status });
  await artifact("owner-calls/" + calls.length + "-" + op + ".json", { input: body, result });
  return result;
}
async function drain(scope: any, id: string) {
  for (let i = 0; i < 32; i++) {
    await queue.tick();
    const value = ok(await http!.call(scope, "read", { runId: id }));
    if (!["QUEUED", "RUNNING"].includes(value.status)) return value;
  }
  throw Error("REGISTERED_QUEUE_TICK_BOUND_EXHAUSTED");
}
async function prepareOwnerFixture(name: string, options: FixtureOptions = {}) {
  fixtureOptions.set(name, options);
  const f = await support.fixture(name, 1,
    [{ id: "compute", unit: "native-attempt", capacity: options.capacity ?? 64, totalLimit: options.capacity ?? 64, resourceClass: "COMPUTE" }],
    { expiryMs: options.expiryMs });
  const { allocationRef } = await import("@finnor/epistemic-runtime");
  const { ref: _oldRef, ...mandateBody } = f.mandate;
  mandateBody.utility.deliberation = { schema: "finnor.s4.finite-deliberation-terms.v1",
    scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS", lossWithoutQualifiedResult: 100, lossWithQualifiedResult: 0,
    nativeAttemptCost: 1, controllerMsCost: 0, delayMsCost: 0.001, unit: "USD",
    qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH" };
  mandateBody.utilityRef = allocationRef("BUSINESS_OWNER", "utility", mandateBody.utility);
  f.mandate = { ...mandateBody, ref: allocationRef("BUSINESS_OWNER", "mandate", mandateBody, "economic-mandate-v1") };
  f.policy = await support.policy(f, "compute", { compute: options.capacity ?? 64 });
  await support.resource(f, "compute", "native-attempt", "CUMULATIVE_EXPENDITURE", Array(2).fill(String(options.capacity ?? 64)));
  f.allocation = ok(await ownerApi(f, "clear", support.clearing(f, { compute: ["100"] })));
  assert.equal(f.allocation.status, "FEASIBLE");
  const e = economicFixture(2, 0, 0).input.estimand;
  e.key = "r4-" + randomUUID(); e.episodeId = f.mandate.episodeId; e.mandateRef = f.mandate.ref;
  e.registeredAt = new Date(Date.now() - 1).toISOString(); e.assignmentAt = f.times.start;
  e.endpointAt = f.times.end; e.outcomeAccessNotBefore = f.times.end;
  e.discountSchedule = [{ at: e.endpointAt, factor: "1" }]; e.analysis.registeredLooks = [e.endpointAt];
  e.populationRef.id = f.r4Problem.query.scope.population; e.allocationRef = f.allocation.certificate.ref;
  e.assignment = { kind: "OBSERVATIONAL_UNIDENTIFIED", protocolRef: e.assignment.protocolRef,
    exposureMappingRef: e.assignment.exposureMappingRef, reasons: ["Generated prospective graph-law planning only, no actual joint data"] };
  e.controllers[1].policyRefs = [f.policy.ref];
  e.controllers[1].interventionRefs = [{ owner: "S3", id: f.r4Problem.query.scope.intervention,
    version: "r4-owner-declared-price-intervention-v1", contentDigest: sha(JSON.stringify({
      variable: "price", unit: "fraction", operation: "PRICE_CHANGE", sourceVersion: f.r4Source.versionId,
    })) }];
  const { POST: s7Post } = await import("../../apps/api/app/api/economic-outcomes/[operation]/route");
  f.estimand = ok(await ownerApi(f, "register", { estimand: e, rightsRef: f.mandate.rightsRef, idempotencyKey: e.key }, s7Post)).record;
  f.r4Problem.query.estimandRef = f.estimand.ref.id;
  f.target = ok(await ownerApi(f, "append", { kind: "SOURCE", estimandRefId: f.estimand.ref.id,
    record: { schema: "finnor.r4.s7-query-binding.v1", estimandId: f.estimand.ref.id,
      episodeId: f.mandate.episodeId, scope: f.r4Problem.query.scope,
      query: { outcomes: ["outcome"], treatments: ["price"], conditions: [] },
      qualification: "SUPPLIED_MODEL_RELATIVE_TARGET_QUERY_NO_MATURE_WEALTH_OR_ATTRIBUTION" },
    sourceRefs: [f.model.ref], validAt: e.registeredAt, idempotencyKey: randomUUID() }, s7Post)).record;
  const registration = { root: f.root, workId: f.work.workId, workInputId: f.work.workInputId,
    modelRef: f.model.ref, policyRef: f.policy.ref, allocationRef: f.allocation.certificate.ref,
    estimandId: f.estimand.ref.id, targetRecordId: f.target.ref.id, problem: f.r4Problem, priorProfileId: null };
  const registered = ok(await http!.call(f, "register", registration));
  f.registration = registration; f.registered = registered;
  await artifact(name + "/owner-registration.json", { registration, registered, S7: { estimand: f.estimand, target: f.target } });
  return f;
}
async function submitFixture(scope: any) {
  const request = { schema: "finnor.r4.run-request.v1", envelope_inputs: { profileId: scope.registered.profileId },
    problem_ref: scope.registered.profileRef, existing_work_revision: scope.registered.workRevision,
    domain_profile_ref: scope.registered.profileRef, budget_grant_ref: scope.allocation.certificate.ref,
    cancellation_ref: randomUUID(), idempotencyKey: randomUUID() };
  const accepted = ok(await http!.call(scope, "submit", request), 202);
  return { request, accepted };
}
try {
  const { migrate } = await import("../../packages/db/migrate");
  if (!retained) {
    await postgres.initialise(); await appendFile(join(directory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n");
  }
  await postgres.start();
  if (!retained) await postgres.createDatabase("r4_owner");
  const adminUrl = `postgres://finnor:finnor@127.0.0.1:${port}/r4_owner`;
  admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  if (!retained) await story("candidate-upgrade-restart", "Committed R1/R2 prefix, additive R4 and cumulative successors each install exactly once", async () => {
    const migrationsDirectory = join(repo, "finnor-os/packages/db/migrations");
    const names = (await readdir(migrationsDirectory)).filter(p => p.endsWith(".sql")).sort();
    const base = await Promise.all(names.filter(n => n < "0184").map(async name => ({ name,
      sql: await readFile(join(migrationsDirectory, name), "utf8") })));
    const installedBase = await migrate(adminUrl, base);
    const candidate = { name: "0184_identification_plan_compiler.sql",
      sql: await readFile(join(migrationsDirectory, "0184_identification_plan_compiler.sql"), "utf8") };
    const upgrade = await migrate(adminUrl, [candidate]);
    assert.deepEqual(installedBase, base.map(migration => migration.name));
    assert(installedBase.includes("0183_r2_robust_programme_search.sql"));
    assert.deepEqual(upgrade, ["0184_identification_plan_compiler.sql"]);
    const candidateRestart = await migrate(adminUrl, [candidate]);
    assert.deepEqual(candidateRestart, []);
    const cumulativeUpgrade = await migrate(adminUrl), restart = await migrate(adminUrl);
    assert.deepEqual(cumulativeUpgrade, names.filter(n => n >= "0184" && n !== candidate.name));
    assert.deepEqual(restart, []);
    const tracker = (await admin!.query("SELECT name FROM finnor_os._migrations ORDER BY name")).rows;
    assert.deepEqual(tracker.map(row => row.name), names);
    const observed = { installedBase, upgrade, candidateRestart, cumulativeUpgrade, restart, tracker };
    await artifact("migration.json", observed); return observed;
  });
  if (retained) {
    assert.deepEqual(await migrate(adminUrl), []);
    await artifact("reused-evidence.json", { priorOutput, retained,
      scope: "Unchanged persisted owners, migration and accepted native result reused; mounted boundary rerun only",
      priorResultsDigest: sha(await readFile(join(priorOutput!, "results.json"))),
      originalFailuresRetained: true, deadlinesRenewed: false });
  } else if (results.at(-1).status !== "PASS") throw Error("MIGRATION_SETUP_UNPASSED");
  // Synthetic credentials only, scoped to this disposable cluster.
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'");
  await admin.query("SET app.test_vertical_mode='explicit'");
  process.env.DATABASE_URL = `postgres://finnor_app:finnor_app@127.0.0.1:${port}/r4_owner`;
  process.env.WORKER_DATABASE_URL = `postgres://finnor_worker:finnor_worker@127.0.0.1:${port}/r4_owner`;
  let corruptionMarker: string | undefined;
  if (process.argv.includes("--faults")) {
    const { installFaultExecutable } = await import("./faults.mts");
    const fault = await installFaultExecutable(directory, process.env.FINNOR_R4_PYTHON!, artifact);
    process.env.FINNOR_R4_PYTHON = fault.executable; corruptionMarker = fault.marker;
  }
  const db = await import("@finnor/db"); await db.closePool();
  if (!retained) await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('native:r4',2,2,0,60,true,'Explicit disposable operator capacity, not protected funding'),('native:r4-memory-1g',16,16,0,60,true,'Explicit disposable 1GiB native slots; container overhead remains unqualified')");
  http = await httpFixture(admin);
  const rows = spawnSync(process.env.FINNOR_S3_PYTHON!, [join(repo, "finnor-os/scripts/s3/reference.py")],
    { input: JSON.stringify({ operation: "equivalent" }), encoding: "utf8", timeout: 20000 });
  assert.equal(rows.status, 0, rows.stderr);
  const day = 86400000;
  support = createUpstreamFixtureSupport({ admin: () => admin, generatedRows: JSON.parse(rows.stdout).rows,
    begin: new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString(), day, fixtures, api: ownerApi, artifact });
  if (!retained) await story("actual-owner-registration", "Authenticated S1/S3/S4/S5/S7 binds an explicit prospective menu, not a coefficient graph", async () => {
    f = await prepareOwnerFixture("r4-" + randomUUID().slice(0, 8));
    registration = f.registration; registered = f.registered;
    await artifact("owner-registration.json", { registration, registered, S7: { estimand: f.estimand, target: f.target } });
    return registered;
  });
  if (retained) {
    const p = (await admin.query("SELECT body FROM finnor_os.r4_profiles ORDER BY created_at LIMIT 1")).rows[0]?.body;
    assert(p, "Retained immutable R4 profile required");
    const { runtimeIdentity } = await import("../../packages/private-equity/src/r4/store");
    assert.equal((await runtimeIdentity()).digest, p.runtime.digest, "Only the changed mounted boundary may be rerun against this persisted cut");
    const pe = await import("@finnor/private-equity"), browserFixture = JSON.parse(await readFile(join(priorOutput!, "browser/fixture.json"), "utf8"));
    f = { tenant: p.tenantId, principal: p.principalId, root: p.root, r4Problem: p.problem,
      work: { workId: p.workId, workInputId: p.workInputId }, deal: { row: { id: browserFixture.root.entityId } },
      ctx: { auth: { tenantId: p.tenantId, userId: p.principalId, employeeId: p.principalId, role: "owner" } } };
    const context = await pe.readEnterpriseControlDecisionContext(f.ctx, p.ownerBinding.S4.policyRef);
    f.model = context.model; f.policy = context.policy; f.mandate = context.policy.mandate;
    f.allocation = await pe.readEnterpriseAllocation(f.ctx, p.ownerBinding.S5.allocationRef);
    f.otherPrincipal = (await admin.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id<>$2 ORDER BY id LIMIT 1", [f.tenant, f.principal])).rows[0]?.id;
    assert(f.otherPrincipal);
    f.bearer = await http.issue(f.tenant, f.principal); f.otherBearer = await http.issue(f.tenant, f.otherPrincipal);
    f.r4Source = { sourceId: p.ownerBinding.S1.sourceHandles[0].sourceId, versionId: p.ownerBinding.S1.sourceHandles[0].versionId };
    registration = p.registration;
    registered = { profileId: p.id, profileRef: p.ref, workRevision: p.workInputId };
    accepted = { runId: (await admin.query("SELECT id FROM finnor_os.r4_runs WHERE profile_id=$1 AND status='COMPLETE' ORDER BY created_at LIMIT 1", [p.id])).rows[0]?.id };
    assert(accepted.runId, "Retained checked plan required"); f.accepted = accepted;
    f.registration = registration; f.registered = registered;
  }
  if (!registered) throw Error("ACTUAL_OWNER_SETUP_UNPASSED");
  async function startWorker() {
  workerChild = fork(join(import.meta.dirname, "worker-child.mts"), [], { execArgv: ["--max-old-space-size=384", "--import=tsx"],
    env: { ...process.env, DATABASE_URL: process.env.WORKER_DATABASE_URL }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let workerLog = "";
  for (const stream of [workerChild.stdout, workerChild.stderr])
    stream?.on("data", b => { if (workerLog.length < 1048576) workerLog += b.toString(); });
  const ready: any = await new Promise((yes, no) => {
    const timeout = setTimeout(() => no(Error("WORKER_START_BOUND")), 20000);
    workerChild!.once("error", no);
    workerChild!.once("message", value => { clearTimeout(timeout); yes(value); });
  });
  assert.equal(ready.role, "finnor_worker"); assert(ready.registeredTypes.includes("run_identification_plan_v1"));
  await artifact("worker-ready.json", ready);
  const command = (operation: string): Promise<any> => new Promise((yes, no) => {
    const child = workerChild!;
    const id = randomUUID(), timeout = setTimeout(() => no(Error("FINITE_WORKER_COMMAND_BOUND")), process.argv.includes("--faults") ? 120000 : 60000);
    const exited = () => { clearTimeout(timeout); child.off("message", listener); no(Error("OWNED_WORKER_EXIT_WITH_PENDING_COMMAND")); };
    const listener = (m: any) => { if (m.id !== id) return; clearTimeout(timeout); child.off("message", listener); child.off("exit", exited); m.error ? no(Error(m.error)) : yes(m); };
    child.on("message", listener); child.once("exit", exited); child.send({ id, operation });
  });
  queue = { registeredTypes: () => ready.registeredTypes, tick: () => command("tick"),
    stop: async () => { await command("stop"); await writeFile(join(out!, "worker.log"), workerLog, { mode: 0o600 }); } };
  }
  await startWorker();
  if (!retained) await story("http-sql-native-checked-plan", "Real canonical registered worker, two separately metered children, all four masks/twelve pairs and cheapest conditional joint", async () => {
    assert(queue.registeredTypes().includes("run_identification_plan_v1"));
    const request = { schema: "finnor.r4.run-request.v1", envelope_inputs: { profileId: registered.profileId },
      problem_ref: registered.profileRef, existing_work_revision: registered.workRevision, domain_profile_ref: registered.profileRef,
      budget_grant_ref: f.allocation.certificate.ref, cancellation_ref: randomUUID(), idempotencyKey: randomUUID() };
    accepted = ok(await http!.call(f, "submit", request), 202);
    f.accepted = accepted;
    assert.equal(ok(await http!.call(f, "submit", request), 202).runId, accepted.runId);
    const result = await drain(f, accepted.runId); await artifact("positive.json", { request, accepted, result });
    assert.equal(result.status, "COMPLETE", JSON.stringify(result));
    assert.deepEqual(result.artifact.plan.selected.bundleIds, ["affordable-joint"]);
    assert.deepEqual(result.artifact.plan.selected.totalCost, { numerator: "2", denominator: "1" });
    assert.equal(result.artifact.plan.identification, "CONDITIONAL");
    assert.equal(result.artifact.checker.checks.masks, 4); assert.equal(result.artifact.checker.checks.pairs, 12);
    assert.equal(result.costs.attempts.length, 2); assert(result.costs.attempts.every((a: any) => a.terminationObserved));
    return { runId: accepted.runId, selected: result.artifact.plan.selected, checker: result.artifact.checker, costs: result.costs };
  });
  if (accepted) {
    if (!retained) await story("owner-consumers-accept-decline-wait", "Actual S2 observational proposal and persisted S3 assessment; S4 planning accept, owner decline, and original WAIT/STOP", async () => {
      const proposed = ok(await http!.call(f, "consume", { runId: accepted.runId, disposition: "PROPOSE" }));
      assert.equal(proposed.scientific.S2.collectionObserved, false);
      assert.equal(proposed.scientific.S3.effectEstimate, null);
      assert.equal(proposed.decision.review.status, "ACCEPT_FOR_PLANNING");
      assert(proposed.decision.decision);
      const declined = ok(await http!.call(f, "consume", { runId: accepted.runId, disposition: "DECLINE" }));
      assert.equal(declined.decision.review.status, "DECLINED_BY_OWNER");
      const waiting = ok(await http!.call(f, "consume", { runId: accepted.runId, disposition: "WAIT" }));
      assert.equal(waiting.decision.review.status, "WAIT");
      await artifact("consumers.json", { proposed, declined, waiting });
      const counts = (await admin!.query("SELECT (SELECT count(*)::int FROM finnor_os.s5_reservations WHERE tenant_id=$1) reservations,(SELECT count(*)::int FROM finnor_os.business_effects WHERE tenant_id=$1) effects", [f.tenant])).rows[0];
      assert.equal(counts.reservations, 1); assert.equal(counts.effects, 0); return { proposed, declined, waiting, counts };
    });
    if (!retained) await story("authenticated-privacy-and-bounds", "Bearer identity overrides forged tenant/principal headers; same-tenant other principal cannot read or submit; malformed/oversized bodies do not expose private output", async () => {
      const anonymous = await http!.call(f, "read", { runId: accepted.runId }, { bearer: null });
      const forged = await http!.call(f, "read", { runId: accepted.runId }, { bearer: f.otherBearer, claimedPrincipal: f.principal });
      const oversized = await http!.call(f, "read", "x".repeat(524289));
      assert.equal(anonymous.status, 401); assert.equal(forged.status, 404); assert.equal(oversized.status, 413);
      assert(!JSON.stringify(forged).includes("affordable-joint"));
      return { anonymous, forged, oversized, auth: http!.observed };
    });
    if (process.argv.includes("--mounted")) await story(process.argv.includes("--inspect-mounted") ? "mounted-input-diagnostic" : "mounted-existing-evidence-work",
      process.argv.includes("--inspect-mounted") ? "Bounded live input diagnosis only, not a mounted PASS" : "Actual CanvasDocument EvidenceWorkbench shows persisted conditional plan, exact costs/coverage and clears delayed private output on session and Work changes", async () => {
      const { mountedIdentification } = await import("./browser.mts");
      return mountedIdentification({ repo, output: out, admin, fixture: f, issuer: http, artifact,
        inspect: process.argv.includes("--inspect-mounted"),
        remainingOnly: process.argv.includes("--mounted-remaining"),
        expiryFixture: async () => {
          const expiring = await prepareOwnerFixture("r4-expiry-" + randomUUID().slice(0, 8), { expiryMs: 70000 });
          const submitted = await submitFixture(expiring);
          expiring.accepted = submitted.accepted;
          expiring.result = await drain(expiring, submitted.accepted.runId);
          assert.equal(expiring.result.status, "COMPLETE");
          return expiring;
        } });
    });
    if (process.argv.includes("--faults")) {
      const { runFaultProbes } = await import("./faults.mts");
      await runFaultProbes({ repo, admin, http, fixture: f, prepareOwnerFixture, submitFixture,
        drain, story, artifact, tick: () => queue.tick(), startWorker, worker: () => workerChild!, corruptionMarker: corruptionMarker!,
        remainingOnly: process.argv.includes("--faults-remaining"),
        finalOnly: process.argv.includes("--faults-final"), tailOnly: process.argv.includes("--faults-tail"),
        stopWorker: () => queue.stop() });
    }
  }
} catch (e) {
  results.push({ id: "campaign-setup-or-bound", status: "FAIL", message: String(e), stack: (e as Error).stack });
} finally {
  process.exitCode = results.some(r => r.status === "FAIL") ? 1 : 0;
  if (admin) await artifact("final-sql.json", {
    runs: (await admin.query("SELECT * FROM finnor_os.r4_runs").catch(() => ({ rows: [] }))).rows,
    attempts: (await admin.query("SELECT * FROM finnor_os.r4_attempts").catch(() => ({ rows: [] }))).rows,
    episodes: (await admin.query("SELECT * FROM finnor_os.r4_episodes").catch(() => ({ rows: [] }))).rows,
    jobs: (await admin.query("SELECT id,type,status,attempts,claim_fence,last_error,lease_owner,lease_expires_at FROM finnor_os.jobs").catch(() => ({ rows: [] }))).rows,
    deliveries: (await admin.query("SELECT * FROM finnor_os.job_delivery_attempts").catch(() => ({ rows: [] }))).rows,
    leases: (await admin.query("SELECT * FROM finnor_os.compute_resource_leases").catch(() => ({ rows: [] }))).rows,
    histories: (await admin.query("SELECT * FROM finnor_os.r4_history ORDER BY created_at,id").catch(() => ({ rows: [] }))).rows,
  });
  await save(); await queue?.stop?.().catch(() => undefined); await http?.close();
  await (await import("@finnor/db")).closePool(); await admin?.end(); await postgres.stop().catch(() => undefined);
  await artifact("retained-disposable-directory.json", { directory, databasePort: port, stopped: true,
    qualification: "OWNED_DISPOSABLE_FILES_RETAINED_NOT_PRODUCTION" });
  process.exitCode = results.some(r => r.status === "FAIL") ? 1 : 0;
}
process.exit(process.exitCode ?? 1);
