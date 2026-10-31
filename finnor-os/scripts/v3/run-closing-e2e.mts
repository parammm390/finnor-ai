/** Preregistered authenticated V3 runtime driver. Actual Next, production worker,
 * ordinary roles, native S3/S4/S5, separate checker/broker and durable oracle.
 * No route-handler calls, test authority bypass, seeded receipts or live effects. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, withTenantTransaction, receiveWork, attachWorkEntity, withTenant, workObjectiveLoops } from "@finnor/db";
import { startWorkObjective, closingWorkGoalDigest } from "../../packages/orchestration/src/objective-loop";
import { and, eq as dbEq } from "drizzle-orm";
import { createDeal } from "@finnor/private-equity";
import { createEvidenceSource } from "@finnor/memory";
import { createUpstreamFixtureSupport } from "../s5/owner-fixture.mjs";
import { ClosingSpecSchema } from "@finnor/shared-types";
import { compensationCases, prepareCompensationFixture, compensationReadback, compensationFunding,
  type CompensationCase } from "../postz-w2/closing-compensation-fixture.mts";

process.umask(0o077); // Includes the database library's transient password file.
const root = resolve(import.meta.dirname, "../../.."), backend = join(root, "finnor-os");
const output = process.env.FINNOR_V3_EVIDENCE_DIR;
if (!output?.startsWith("/")) throw Error("Absolute fresh FINNOR_V3_EVIDENCE_DIR required");
const caseArgument = process.argv.indexOf("--case");
const selected = caseArgument < 0 ? "authenticated-positive" : process.argv[caseArgument + 1];
const continuationProof = process.env.FINNOR_V3_ORIGINAL_WORK_CONTINUATION_PROOF === "1";
assert(selected, "Registered case name required");
assert(["authenticated-positive", "lost-draw", "signer-professional", "settlement", "ordering-cancellation",
  "currentness", "concurrency-isolation", "reopening", "requalification", "fallback", "cross-phase",
  "workforce-compensation"].includes(selected), "Unsupported registered case");
const workforceCompensation = selected === "workforce-compensation";
const compensationCase = (process.env.FINNOR_W2_COMPENSATION_CASE ?? "exact") as CompensationCase;
if (workforceCompensation) assert(compensationCases.includes(compensationCase), "Registered compensation control required");
await mkdir(output, { recursive: true });
const privateDirectory = await mkdtemp(join(tmpdir(), "finnor-v3-runtime-private-"));
const dbDirectory = await mkdtemp(join(tmpdir(), "finnor-v3-runtime-pg-"));
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const canonical = (v: any): string => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort((a, b) => a.localeCompare(b)).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const hash = (v: any) => createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : canonical(v)).digest("hex");
const reference = (id: string, owner = "INDEPENDENT_DEVELOPMENT_OWNER", kind = "hypothetical-input") =>
  ({ owner, kind, id, version: "disposable-v1", contentDigest: hash(id) });
const withKind = (r: any, kind: string) => ({ ...r, kind });
const successes: any[] = [], calls: any[] = [], processes: any[] = [], children = new Set<ChildProcess>();
const keys = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>();
const fixtures: Record<string, any> = {};
const startedAt = new Date().toISOString();
let admin: pg.Client | undefined, authServer: Server | undefined, postgresRunning = false;
let apiOrigin = "", authOrigin = "", providerOrigin = "", checkerDigest = "", worker: ChildProcess | undefined;
let compensationWorkerEnv: NodeJS.ProcessEnv = {};
let compensationHorizon: { startAt: string; periodMs: number; periods: number };
let failed: any, current: any;
let resourceMonitor: NodeJS.Timeout | undefined, resourceFailure: Error | undefined;
const resourceObservation = { profile: continuationProof ? "USER_AUTHORIZED_BOUNDED_CONTINUATION_ENGINEERING" : "ORIGINAL_DEFAULT",
  peakOwnedRssBytes: 0, minimumObservedFreeBytes: Number.MAX_SAFE_INTEGER, samples: 0 };
const password = randomBytes(24).toString("hex");
const providerToken = randomBytes(32).toString("base64url"), checkerToken = randomBytes(32).toString("base64url");
const brokerToken = randomBytes(32).toString("base64url");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "v3-local-development-rsa-v1", alg: "RS256", use: "sig" };
async function save(path: string, value: unknown) {
  const target = join(output!, path); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return target;
}
async function privateFile(name: string, value: string) {
  const path = join(privateDirectory, name); await writeFile(path, value, { flag: "wx", mode: 0o600 }); return path;
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const a = server.address(); assert(a && typeof a !== "string");
  await new Promise<void>(done => server.close(() => done())); return a.port;
}
function bearer(f: any, id = f.principal, expires = 3600) {
  const actor = f.actors?.find((a: any) => a.id === id);
  const email = actor?.email ?? `${f.name}@s5.example.test`;
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = part({ alg: "RS256", typ: "JWT", kid: jwk.kid }) + "." +
    part({ sub: id, email, aud: "authenticated", role: "authenticated", iss: authOrigin + "/auth/v1", iat: now, exp: now + expires });
  return body + "." + sign("RSA-SHA256", Buffer.from(body), rsa.privateKey).toString("base64url");
}
const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: privateDirectory, TMPDIR: process.env.TMPDIR,
  NODE_ENV: "test", CI: "1", NEXT_TELEMETRY_DISABLED: "1", LOG_LEVEL: "warn",
  AUTH_DEV_BYPASS: "0", RATE_LIMIT_PER_MINUTE: "100000", FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
  FINNOR_ENVIRONMENT: "staging", P3_DISABLE_PROACTIVE_SCHEDULER: "1",
  FINNOR_S3_PYTHON: process.env.FINNOR_S3_PYTHON ?? "/tmp/finnor-v3-numerics-312-20261012/bin/python",
  FINNOR_S5_PYTHON: process.env.FINNOR_S5_PYTHON ?? "/tmp/finnor-v3-numerics-312-20261012/bin/python",
  FINNOR_S3_MODEL_STORE: join(output, "native-models"), FINNOR_S4_POLICY_STORE: join(output, "native-policies"),
  OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", DOTENV_CONFIG_PATH: join(privateDirectory, "empty.env"),
};
async function launch(name: string, args: string[], env: NodeJS.ProcessEnv, cwd = backend) {
  const cp = spawn(process.execPath, args, { cwd, env: { ...baseEnv, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(cp); let text = "";
  cp.stdout!.on("data", b => { text += b.toString(); void appendFile(join(output!, name + ".log"), b); });
  cp.stderr!.on("data", b => { text += b.toString(); void appendFile(join(output!, name + ".log"), b); });
  const entry = { name, pid: cp.pid, args, cwd, startedAt: new Date().toISOString(), exit: null as any };
  processes.push(entry); cp.on("exit", (code, signal) => { entry.exit = { code, signal, at: new Date().toISOString() }; children.delete(cp); });
  return { cp, text: () => text };
}
async function ready(service: Awaited<ReturnType<typeof launch>>, label: string) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const line = service.text().split("\n").find(s => { try { return JSON.parse(s).ready === true; } catch { return false; } });
    if (line) return JSON.parse(line);
    assert(service.cp.exitCode === null, `${label} exited: ${service.text().slice(-5000)}`); await sleep(100);
  }
  throw Error(label + " readiness deadline");
}
async function request(f: any, path: string, body?: unknown, actorId?: string, token?: string) {
  const began = performance.now();
  const response = await fetch(apiOrigin + path, { method: body === undefined ? "GET" : "POST", headers: {
    authorization: "Bearer " + (token ?? bearer(f, actorId)), "content-type": "application/json",
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const text = await response.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { throw Error(`Actual Next returned ${response.status}: ${text.slice(0, 1000)}`); }
  const result = { status: response.status, body: parsed, elapsedMs: performance.now() - began };
  const row = { path, tenantId: f.tenant, actorId: actorId ?? f.principal, request: body, response: result };
  calls.push({ path, tenantId: f.tenant, actorId: row.actorId, status: result.status, elapsedMs: result.elapsedMs });
  await save(`calls/${String(calls.length).padStart(4, "0")}.json`, row); return result;
}
const ok = (r: any) => { assert(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body; };
async function actors(f: any) {
  if (f.actors) return;
  f.actors = [{ id: f.principal, email: `${f.name}@s5.example.test`, kind: "buyer" }];
  for (const kind of ["seller", "document-authority", "receiving-authority", "registry-authority", "counsel-authority"]) {
    const actor = { id: randomUUID(), email: `${f.name}-${kind}@v3.example.test`, kind };
    await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [actor.id, f.tenant, actor.email]);
    f.actors.push(actor);
  }
}
async function ownerApi(f: any, op: string, body: unknown) {
  await actors(f);
  const family = op === "fit" ? "interventions" : op === "synthesize" ? "policies" : "allocations";
  return request(f, `/api/${family}/${op}`, body);
}
async function providerRequest(path: string, body?: unknown) {
  const r = await fetch(providerOrigin + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + providerToken, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result as any;
}
function fact(f: any, requirement: any, kind: string, issuerId: string, claims: any, extra: any = {}) {
  const issuer = f.profile.issuers.find((i: any) => i.id === issuerId); assert(issuer);
  const body = {
    schema: "finnor.closing-observation.v1", factId: randomUUID(), tenantId: f.tenant, transactionId: f.dealId,
    specDigest: hash(f.spec), approvedTermsRevision: f.spec.approvedTermsRevision,
    requirementKey: requirement.key, predicateDigest: requirement.evidence?.predicateDigest ?? hash(f.spec),
    kind, issuerId, channel: requirement.evidence?.channels[0] ?? "disposable-contract",
    actorId: issuer.actorId, professionalScope: null, status: "CONFIRMED",
    observedAt: new Date().toISOString(), validUntil: f.spec.originalGrant.deadlineAt,
    claims, supersedesFactIds: [], ...extra,
  };
  return { ...body, signature: sign(null, Buffer.from(canonical(body)), keys.get(issuerId)!.privateKey).toString("base64") };
}
async function observe(f: any, observation: any) {
  return request(f, "/api/closing/observe", { programmeId: f.programmeId, observation }, observation.actorId);
}
async function snapshot(f: any) {
  return {
    programme: (await admin!.query("SELECT * FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 32", [f.tenant])).rows,
    works: (await admin!.query("SELECT id,status,current_owner_id FROM finnor_os.works WHERE tenant_id=$1 ORDER BY id LIMIT 32", [f.tenant])).rows,
    workforce: (await admin!.query("SELECT * FROM finnor_os.workforce_assignments WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 128", [f.tenant])).rows,
    materialCut: (await admin!.query("SELECT finnor_os.pe_closing_cut($1,$2) body,finnor_os.pe_closing_cut_digest($1,$2) digest", [f.tenant, f.programmeId])).rows[0],
    actions: (await admin!.query("SELECT a.*,e.semantic_hash,e.status effect_status FROM finnor_os.domain_actions a LEFT JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id WHERE a.tenant_id=$1 ORDER BY a.created_at,a.id LIMIT 128", [f.tenant])).rows,
    businessEffects: (await admin!.query("SELECT * FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 128", [f.tenant])).rows,
    jobs: (await admin!.query("SELECT * FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY run_at,id LIMIT 256", [f.tenant])).rows,
    operations: (await admin!.query("SELECT * FROM finnor_os.external_operations WHERE tenant_id=$1 ORDER BY id", [f.tenant])).rows,
    invocations: (await admin!.query("SELECT * FROM finnor_os.provider_invocations WHERE tenant_id=$1 ORDER BY started_at,id", [f.tenant])).rows,
    checks: (await admin!.query("SELECT * FROM finnor_os.pe_closing_checks WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 128", [f.tenant])).rows,
    duties: (await admin!.query("SELECT * FROM finnor_os.s6_closing_duty_handoffs WHERE tenant_id=$1 ORDER BY duty_key", [f.tenant])).rows,
    budgets: (await admin!.query("SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1", [f.tenant])).rows,
    workInputs: (await admin!.query("SELECT * FROM finnor_os.work_inputs WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 32", [f.tenant])).rows,
    plannerAttempts: (await admin!.query("SELECT * FROM finnor_os.work_planner_attempts WHERE tenant_id=$1 ORDER BY started_at,id LIMIT 32", [f.tenant])).rows,
    planRevisions: (await admin!.query("SELECT * FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 ORDER BY revision,id LIMIT 32", [f.tenant])).rows,
    events: (await admin!.query("SELECT * FROM finnor_os.pe_closing_events WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 128", [f.tenant])).rows,
    workflowSteps: (await admin!.query("SELECT * FROM finnor_os.workflow_steps WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 128", [f.tenant])).rows,
    consumptions: (await admin!.query("SELECT c.body,s.status,s.effect_ref FROM finnor_os.s5_consumptions c JOIN finnor_os.s5_consumption_states s USING(tenant_id,consumption_id) WHERE c.tenant_id=$1", [f.tenant])).rows,
    nodeLinks: (await admin!.query("SELECT * FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 ORDER BY programme_id,node_key", [f.tenant])).rows,
    actionLog: (await admin!.query('SELECT * FROM finnor_os.action_log WHERE tenant_id=$1 ORDER BY "timestamp",id LIMIT 256', [f.tenant])).rows,
    reservations: (await admin!.query("SELECT reservation_id,status,envelopes,revocation_reason FROM finnor_os.s5_reservations WHERE tenant_id=$1", [f.tenant])).rows,
    s5Invalidations: (await admin!.query("SELECT * FROM finnor_os.s5_experience WHERE tenant_id=$1 AND body->>'type'='INVALIDATION' ORDER BY recorded_at,event_id LIMIT 32", [f.tenant])).rows,
    authority: (await admin!.query("SELECT * FROM finnor_os.authority_decisions WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 256", [f.tenant])).rows,
  };
}
async function approve(f: any) {
  f.reviewedEffects ??= new Map<string, string>();
  const rows = (await admin!.query(
    "SELECT a.id,a.action_type,a.payload,e.semantic_hash,e.effect FROM finnor_os.domain_actions a JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id WHERE a.tenant_id=$1 AND a.status IN('pending','needs_human_review') ORDER BY a.created_at,a.id",
    [f.tenant])).rows;
  for (const row of rows) {
    const reviewed = f.reviewedEffects.get(row.id);
    if (reviewed) {
      assert.equal(row.semantic_hash, reviewed, "A changed effect requires a new independent exact review, not automatic approval");
      continue; // Retained failures/UNKNOWN require readback, not another approval.
    }
    if (row.action_type === "execute_closing_operation") {
      const step = f.spec.steps.find((s: any) => s.key === row.payload.nodeKey);
      assert(step && equal(row.effect.delta.values.closingStep, step), "Approval differs from frozen original step");
    }
    ok(await request(f, `/api/actions/${row.id}/confirm`, { expectedEffectHash: row.semantic_hash, typedConfirmation: true,
      note: "Exact reviewed hypothetical DEVELOPMENT effect only. No protected or live authority." }));
    f.reviewedEffects.set(row.id, row.semantic_hash);
  }
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
async function projection(f: any) { return ok(await request(f, "/api/closing/read", { programmeId: f.programmeId })); }
async function waitFor(f: any, predicate: (q: any, state: any) => boolean, limitMs = 240000) {
  const deadline = Date.now() + limitMs; let last: any;
  while (Date.now() < deadline) {
    await approve(f); const q = await projection(f), state = await providerRequest("/__fixture/state");
    last = { q, state }; if (predicate(q, state)) return last;
    if (q.children.some((child: any) => child.nodeKey === "publish-close" && child.actionStatus === "failed")) {
      throw Error("Canonical close publication failed with its original child retained");
    }
    if (["authenticated-positive", "fallback", "concurrency-isolation", "reopening", "requalification", "lost-draw"].includes(selected ?? "")
        && q.status === "REOPENED") {
      await save("unexpected-reopening-canonical-readback.json", await snapshot(f));
      throw Error("Positive programme lost current validity before native completion: " + JSON.stringify(q.reason));
    }
    if (selected === "authenticated-positive") {
      const blocked = (await admin!.query("SELECT terminal_reason FROM finnor_os.workflow_steps WHERE tenant_id=$1 AND execution_state='blocked' AND effect_commit_at IS NULL ORDER BY updated_at DESC,id LIMIT 1", [f.tenant])).rows[0];
      if (blocked) throw Error("Native pre-egress refusal: " + blocked.terminal_reason);
      const unavailable = (await admin!.query("SELECT id FROM finnor_os.external_operations WHERE tenant_id=$1 AND response->>'error'='S6_CLOSING_BROKER_CURRENT_DISPATCH_OR_OBSERVATION_UNAVAILABLE' LIMIT 1", [f.tenant])).rows[0];
      if (unavailable) throw Error("Native original broker attempt unavailable; UNKNOWN retained: " + unavailable.id);
      const rejected = (await admin!.query("SELECT o.response->>'error' reason FROM finnor_os.external_operations o JOIN finnor_os.provider_operation_attempts a ON a.tenant_id=o.tenant_id AND a.external_operation_id=o.id JOIN finnor_os.provider_invocations i ON i.tenant_id=a.tenant_id AND i.provider_operation_attempt_id=a.id WHERE o.tenant_id=$1 AND o.status='failed' AND i.outcome='definite_pre_dispatch_failure' ORDER BY i.started_at DESC,i.id LIMIT 1", [f.tenant])).rows[0];
      if (rejected) throw Error("Native original invocation failed before egress: " + rejected.reason);
    }
    const fatal = q.reason && /BOUNDARY_UNAVAILABLE|EXACT_COMPILED|BUDGET_EXHAUSTED|PLAN_REJECTED|CLOSING_S5_/.test(q.reason);
    if (fatal) throw Error("Native owner stopped: " + q.reason);
    const invalidDraft = (await admin!.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND status='needs_human_review' AND business_effect_id IS NULL LIMIT 1", [f.tenant])).rows[0];
    if (invalidDraft) throw Error("Native typed child rejected before Business Effect compilation: " + invalidDraft.id);
    await sleep(1800);
  }
  throw Error("Registered runtime wait exhausted: " + JSON.stringify(last?.q).slice(0, 7000));
}
async function completedNativeWork(f: any) {
  const deadline = Date.now() + 30000; let completion: any;
  while (Date.now() < deadline) {
    completion = (await admin!.query("SELECT w.status work_status,o.state,o.step_count,o.action_count,o.query_count,o.max_steps,o.max_actions,o.max_queries,o.deadline_at,o.reason FROM finnor_os.works w JOIN finnor_os.work_objective_loops o ON o.tenant_id=w.tenant_id AND o.work_id=w.id WHERE w.tenant_id=$1 AND w.id=$2", [f.tenant, f.workId])).rows[0];
    if (completion?.state === "completed" && completion.work_status === "completed") break;
    await sleep(500);
  }
  assert.equal(completion?.state, "completed", "Canonical objective did not observe the exact verified close: " + JSON.stringify(completion));
  assert.equal(completion.work_status, "completed", "Canonical Work did not complete its accepted goal");
  return completion;
}
let support: ReturnType<typeof createUpstreamFixtureSupport>;
async function configureClosingOwner(f: any) {
  // The funding buyer and acquired company are distinct legal entities. Closing
  // mutates the target's deal graph; it must not silently rebase the original
  // scientific model and S5 resource witnesses for the buyer's budget.
  f.targetEntity = randomUUID();
  await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$4,'other')",
    [f.targetEntity, f.tenant, `${f.name}-acquired-target`, "Hypothetical acquired target"]);
  f.dealId = String((await createDeal(f.ctx, { targetOrganizationId: f.targetEntity, name: f.name,
    dealLeadEmployeeId: f.principal, signedLoiAt: new Date(), targetClosingAt: new Date(Date.now() + 3600000) })).row.id);
  // Independent fixture administration supplies an exact canonical scheduling
  // grant. Default action:* does not grant private_equity:close_deal. This is not
  // a seeded authority decision, receipt, financial clearance or runtime bypass.
  const controllerRole = randomUUID();
  await admin!.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,'v3-disposable-controller','Disposable exact closing controller')",
    [controllerRole, f.tenant]);
  await admin!.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk) VALUES($1,$2,'private_equity:close_deal','pe_deal','allow','high')",
    [f.tenant, controllerRole]);
  await admin!.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)",
    [f.tenant, f.principal, controllerRole, JSON.stringify({ kind: "resources", resourceType: "pe_deal", resourceIds: [f.dealId] })]);
  const profile = ok(await request(f, "/api/workforce/profiles", {
    key: "v3-disposable-native-readback", name: "Disposable exact closing query and completion checker",
    capabilityGrants: [{ kind: "query", capability: "query:closing_readiness" },
      { kind: "check", capability: "check:objective_success" }],
    autonomyLimits: { maxActions: 1, maxQueries: 8, maxReplans: 6, maxPlannerCalls: 8, maxWallClockMs: 3600000 },
    planningHints: { qualification: "DEVELOPMENT_NATIVE_EXECUTOR_NOT_PROTECTED_OR_LIVE_ADMISSION" },
  }));
  await save(f.name + "/native-agent-profile.json", profile);
}
async function fixture(label: string, fault?: string) {
  const price = workforceCompensation ? "2" : "120000000";
  const debtAmount = workforceCompensation ? "1" : "80000000";
  const equityAmount = workforceCompensation ? "1" : "40000000";
  const f = await support.fixture(label, 1, [
    { id: "cash", unit: "USD", capacity: workforceCompensation ? 6 : 120000000, totalLimit: workforceCompensation ? 6 : 120000000, resourceClass: "CASH" },
    { id: "debt", unit: "USD", capacity: Number(debtAmount), totalLimit: Number(debtAmount), resourceClass: "BORROWING_HEADROOM" },
  ], { beforeFit: async f => {
    await configureClosingOwner(f);
    if (!workforceCompensation) return;
    await actors(f);
    current = f; f.w2WorkId = randomUUID(); f.compensationHorizon = compensationHorizon;
    f.compensationFixture = await prepareCompensationFixture({ admin: admin! as any, f, request, save,
      startWorker: async () => {
        worker = (await launch("w2-original-compiler", ["--import=tsx", join(backend, "scripts/postz-w2/physical-worker.mts")],
          compensationWorkerEnv)).cp;
      },
      stopWorker: async () => {
        assert(worker);
        const cp = worker, exited = new Promise<void>(done => cp.once("exit", () => done()));
        const timer = setTimeout(() => process.kill(-cp.pid!, "SIGKILL"), 5000);
        process.kill(-cp.pid!, "SIGTERM"); await exited; clearTimeout(timer); worker = undefined;
      } }, compensationCase);
  } });
  current = f;
  for (const [label, spend] of [["signature", {}], ["draw", { debt: Number(debtAmount) }], ["pay", { cash: Number(price) }],
    ["transfer", {}], ["file", {}]] as const) await support.policy(f, label, spend);
  if (!workforceCompensation) await support.resource(f, "cash", "USD", "STOCK", ["120000000", "120000000"]);
  await support.resource(f, "debt", "USD", "STOCK", [debtAmount, debtAmount]);
  const clearing = support.clearing(f, { signature: ["10"], draw: ["10"], pay: ["10"], transfer: ["10"], file: ["10"] });
  const cleared = ok(await ownerApi(f, "clear", clearing)); assert.equal(cleared.status, "FEASIBLE", JSON.stringify(cleared));
  assert.equal(cleared.certificate.policyBindings.length, 5, "All original operation policies must be genuinely selected");
  f.certificate = cleared.certificate;
  const sellerEntity = randomUUID(), lenderEntity = randomUUID(), equityEntity = randomUUID();
  for (const [id, name] of [[sellerEntity, "Seller"], [lenderEntity, "Lender"], [equityEntity, "Equity"]] as const)
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$4,'other')", [id, f.tenant, `${label}-${name.toLowerCase()}`, name]);
  const sourceId = (await createEvidenceSource(f.tenant, { sourceKey: "approved-closing-terms:" + label,
    sourceType: "independently_accepted_transaction_terms", title: "Hypothetical exact approved closing terms" })).id;
  const terms = `Hypothetical original ${label}: buyer ${f.root.entityId}; seller ${sellerEntity}; acquired company ${f.targetEntity}; price USD${price}; debt USD${debtAmount}; settled equity USD${equityAmount}; exact approved document and parties.`;
  const termsVersion = randomUUID();
  await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,$5,'{}'::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())", [termsVersion, sourceId, f.tenant, hash(terms), terms]);
  const documentId = randomUUID(), documentBytes = Buffer.from(`%PDF-1.4\n% Hypothetical approved exact agreement\n${terms}\n%%EOF\n`);
  await admin!.query("INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES($1,$2,'approved_transaction_agreement',$3,'v3:independent-development',$4)", [documentId, f.tenant, label, f.principal]);
  await admin!.query("INSERT INTO finnor_os.document_contents(document_id,tenant_id,bytes,size_bytes,content_type) VALUES($1,$2,$3,$4,'application/pdf')", [documentId, f.tenant, documentBytes, documentBytes.length]);
  const documentVersionId = (await admin!.query("SELECT version_id FROM finnor_os.document_version_heads WHERE tenant_id=$1 AND document_id=$2 AND kind='current' AND head_key='default'", [f.tenant, documentId])).rows[0].version_id;
  const roleBindings = [];
  for (const [principalId, entityId] of [[f.principal, f.root.entityId], [f.actors.find((a: any) => a.kind === "seller").id, sellerEntity]]) {
    const row = (await admin!.query("SELECT to_jsonb(a) assignment,to_jsonb(r) definition FROM finnor_os.employee_role_assignments a JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active AND r.key='owner'", [f.tenant, principalId])).rows[0];
    assert(row);
    roleBindings.push({ ref: reference(row.assignment.id, "@finnor/authority", "role-bound-legal-entity"),
      principalId, assignmentId: row.assignment.id, assignmentDigest: hash(row.assignment),
      roleDefinitionDigest: hash(row.definition), legalEntityIds: [entityId] });
  }
  const issuerKinds: Record<string, string[]> = {
    "document-authority": ["DOCUMENT_EXECUTION"],
    "receiving-authority": ["FUNDING_AVAILABLE", "RECEIVING_SETTLEMENT", "BENEFICIARY_VALIDATED", "OPERATION_ABSENT"],
    "registry-authority": ["RIGHTS_TRANSFER"],
    "counsel-authority": ["LEGAL_SPEC_ACCEPTANCE", "PROFESSIONAL_CONDITION", "LEGAL_EFFECTIVENESS", "OBSERVABLE_CONDITION", "WAIVER"],
  };
  const integrationId = randomUUID();
  await admin!.query("INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode,health,source_policy) VALUES($1,$2,'private_equity_source','finnor_closing_provider','emulator','ok','{}')", [integrationId, f.tenant]);
  const validUntil = new Date(Date.now() + 3600000).toISOString();
  f.profile = {
    schema: "finnor.closing-profile.v1", environment: "DEVELOPMENT", checkerDigest,
    legalScope: "DISPOSABLE_HYPOTHETICAL_CONTRACT_NOT_COUNSEL_QUALIFICATION",
    issuers: Object.entries(issuerKinds).map(([id, kinds]) => ({ id, kinds,
      publicKeyPem: keys.get(id)!.publicKey.export({ type: "spki", format: "pem" }).toString(),
      actorId: f.actors.find((a: any) => a.kind === id).id, status: "ACTIVE",
      qualifiedScopes: id === "counsel-authority" ? ["closing-spec", "regulatory-condition", "legal-effectiveness"] : [],
      channels: ["disposable-contract"], validUntil, environment: "DEVELOPMENT",
      qualificationRef: reference(id, "INDEPENDENT_DEVELOPMENT_FIXTURE", "NOT_PROTECTED_QUALIFICATION") })),
    roleBindings, providers: [{ id: "disposable-provider", origin: providerOrigin, accountId: "disposable-account",
      integrationId, credentialRef: "disposable-provider-credential",
      allowedKinds: ["REQUEST_SIGNATURE", "DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE"],
      observationIssuerIds: Object.keys(issuerKinds), qualificationRef: reference("disposable-provider", "S6", "DEVELOPMENT_ONLY") }],
    admission: null, prerequisiteAdmissions: { V1: null, V2: null },
    irreversibleOrdering: "EXPLICIT_DEPENDENCIES_WITH_RETAINED_EXPOSURE_NOT_ATOMIC",
  };
  const profileId = "development-" + f.dealId, { admission: _admission, ...profileBody } = f.profile;
  await admin!.query("INSERT INTO finnor_os.pe_closing_profiles(tenant_id,id,revision,environment,status,body,digest,valid_until) VALUES($1,$2,1,'DEVELOPMENT','ACTIVE',$3::jsonb,$4,$5)", [f.tenant, profileId, canonical(f.profile), hash(profileBody), validUntil]);
  const bindingsPath = join(privateDirectory, "provider-bindings.json");
  await writeFile(bindingsPath, JSON.stringify({ "disposable-provider-credential": { origin: providerOrigin,
    accountId: "disposable-account", integrationId, environment: "DEVELOPMENT", tokenPath: join(privateDirectory, "provider.token") } }), { mode: 0o600 });
  const evidence = (kind: string, key: string, issuer: string) => ({ kind, predicateDigest: hash("original-predicate:" + key),
    issuerIds: [issuer], channels: ["disposable-contract"], maxAgeMs: 3600000 });
  const asOf = new Date(Date.now() - 1000).toISOString();
  const usd = (amount: string) => ({ amount, currency: "USD", unit: "currency", entityId: f.root.entityId,
    asOf, timeBasis: "INSTANT", periodEnd: validUntil, rounding: "EXACT" });
  const actor = { principalId: f.principal, legalEntityId: f.root.entityId, roleRef: roleBindings[0]!.ref };
  const debt = f.resources.find((r: any) => r.resourceId === "debt");
  const cash = f.resources.find((r: any) => r.resourceId === "cash");
  const step = (key: string, kind: string, requirementKey: string, dependsOn: string[], label: string | null, exposure: string | null, resource?: any) => {
    const p = label ? f.policies.find((p: any) => f.labels[p.ref.id] === label) : null;
    return { key, kind, requirementKey, dependsOn, actor, irreversible: ["DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE"].includes(kind),
      providerProfileId: label ? "disposable-provider" : null,
      policyRef: p ? withKind(p.ref, "native-S4-policy") : null,
      allocationRef: p ? withKind(f.certificate.ref, "native-S5-allocation") : null,
      decision: p ? support.decision(f, f.certificate.ref) : null, failureDisposition: "RECONCILING",
      exposureCap: exposure ? usd(exposure) : null,
      resourceBindings: resource ? [{ resourceRef: withKind(resource.ref, "native-S5-resource"), quantity: exposure, unit: "USD" }] : [] };
  };
  const sellerActor = { principalId: roleBindings[1]!.principalId, legalEntityId: sellerEntity, roleRef: roleBindings[1]!.ref };
  const specInput = {
    schema: "finnor.closing-spec.v1", transactionId: f.dealId, tenantId: f.tenant,
    approvedTermsRevision: termsVersion, approvedTermsDigest: hash(terms), profileId, environment: "DEVELOPMENT",
    originalGrant: { episodeRef: { ...withKind(f.mandate.ref, "original-native-episode"), id: f.mandate.episodeId },
      deadlineAt: validUntil, maxSteps: 256, maxHumanSeconds: 900, maxComputeDataIntegrationUsd: "100" },
    documents: [{ key: "agreement", required: true, dependsOn: [], evidence: evidence("DOCUMENT_EXECUTION", "agreement", "document-authority"),
      documentId, documentVersionId, documentDigest: hash(documentBytes), approvedTermsRevision: termsVersion, signers: [actor, sellerActor] }],
    conditions: [{ key: "regulatory-condition", required: true, dependsOn: [], evidence: evidence("PROFESSIONAL_CONDITION", "regulatory-condition", "counsel-authority"),
      canonicalConditionId: null, statement: "Hypothetical independently administered regulatory condition",
      evidenceClass: "PROFESSIONALLY_ATTESTED", professionalScope: "regulatory-condition", waiver: null },
    { key: "observable-condition", required: true, dependsOn: [], evidence: evidence("OBSERVABLE_CONDITION", "observable-condition", "counsel-authority"),
      canonicalConditionId: null, statement: "Exact hypothetical recorded condition", evidenceClass: "OBSERVABLE", professionalScope: null, waiver: null }],
    funding: [{ key: "debt", required: true, dependsOn: [], evidence: evidence("FUNDING_AVAILABLE", "debt", "receiving-authority"),
      money: usd(debtAmount), facilityDigest: debt.sourceRef.contentDigest, providerEntityId: lenderEntity,
      sourceClass: "DEBT_FACILITY", continuingDutyKeys: ["debt-principal"], requiredState: "EFFECTIVE_AVAILABLE", drawOperationKey: "original-debt-draw" },
    { key: "equity", required: true, dependsOn: [], evidence: evidence("FUNDING_AVAILABLE", "equity", "receiving-authority"),
      money: usd(equityAmount), facilityDigest: hash("original-settled-equity"), providerEntityId: equityEntity,
      sourceClass: "EQUITY_CAPITAL", continuingDutyKeys: [], requiredState: "EFFECTIVE_AVAILABLE", drawOperationKey: null }],
    beneficiaries: [{ key: "seller-beneficiary", required: true, dependsOn: [], evidence: evidence("BENEFICIARY_VALIDATED", "seller-beneficiary", "receiving-authority"),
      legalEntityId: sellerEntity, accountDigest: hash("frozen-original-seller-account:" + sellerEntity), independentValidationChannel: "disposable-contract" }],
    fundsFlows: [{ key: "purchase-price", required: true, dependsOn: ["agreement", "debt", "equity", "seller-beneficiary", "regulatory-condition"],
      evidence: evidence("RECEIVING_SETTLEMENT", "purchase-price", "receiving-authority"),
      money: usd(price), payerEntityId: f.root.entityId, receivingEntityId: sellerEntity,
      receivingAccountDigest: hash("frozen-original-seller-account:" + sellerEntity), beneficiaryRequirementKey: "seller-beneficiary",
      fundingKeys: ["debt", "equity"], purpose: workforceCompensation ? "FEE" : "PURCHASE_PRICE", operationKey: "original-purchase-price",
      ...(workforceCompensation ? { workforceCompensation: f.compensationFixture.binding } : {}) }],
    rightsTransfers: [{ key: "equity-rights", required: true, dependsOn: ["purchase-price"], evidence: evidence("RIGHTS_TRANSFER", "equity-rights", "registry-authority"),
      fromEntityId: sellerEntity, toEntityId: f.root.entityId, rightsDigest: hash("exact-original-equity-rights:" + f.targetEntity), quantity: "100",
      unit: "shares", operationKey: "original-rights-transfer" }],
    legalEffectiveness: [{ key: "legal-effectiveness", required: true, dependsOn: ["equity-rights"], evidence: evidence("LEGAL_EFFECTIVENESS", "legal-effectiveness", "counsel-authority"),
      jurisdiction: "DISPOSABLE", legalBasisDigest: hash("hypothetical-original-effectiveness"), professionalScope: "legal-effectiveness", operationKey: "original-legal-filing" }],
    continuingDuties: [{ key: "debt-principal", ownerPrincipalId: f.principal, statement: "Retain exact USD" + debtAmount + " debt principal and service duties",
      dueAt: new Date(Date.now() + 86400000).toISOString(), dependencyKeys: ["original-debt-draw"], liability: usd(debtAmount), obligationRef: null },
    { key: "post-close-record", ownerPrincipalId: f.principal, statement: "Maintain original closing record and continuing legal duties",
      dueAt: new Date(Date.now() + 2 * 86400000).toISOString(), dependencyKeys: ["original-legal-filing"], liability: null, obligationRef: null }],
    steps: [step("request-signature", "REQUEST_SIGNATURE", "agreement", [], "signature", null),
      step("draw-debt", "DRAW_FUNDS", "debt", ["agreement", "regulatory-condition"], "draw", debtAmount, debt),
      step("pay-seller", "PAY_FUNDS", "purchase-price", ["agreement", "regulatory-condition", "debt", "equity", "seller-beneficiary"], "pay", price, cash),
      step("transfer-rights", "TRANSFER_RIGHTS", "equity-rights", ["purchase-price"], "transfer", price),
      step("file-effectiveness", "FILE", "legal-effectiveness", ["equity-rights"], "file", price),
      step("acquire-observable", "ACQUIRE_EVIDENCE", "observable-condition", [], null, null),
      step("request-professional", "REQUEST_PROFESSIONAL", "regulatory-condition", [], null, null)],
    dependencyKeys: ["closing-material:" + f.dealId], assumptions: ["Independent hypothetical DEVELOPMENT fixture only. No protected, live, V1/V2 or economic qualification."],
    unsupportedPredicates: [],
  };
  f.spec = workforceCompensation ? specInput : ClosingSpecSchema.parse(specInput);
  const legal = fact(f, { key: "closing-spec" }, "LEGAL_SPEC_ACCEPTANCE", "counsel-authority",
    { accepted: true, specDigest: hash(f.spec) }, { professionalScope: "closing-spec" });
  f.intake = { spec: f.spec, expectedSpecDigest: hash(f.spec), acceptedTermsEvidence: { sourceId, versionId: termsVersion },
    legalAcceptance: legal, idempotencyKey: "original-intake:" + label };
  if (continuationProof) {
    const instruction = "Preserve the original full development mandate: verified close and independently recorded whole-mandate economics. Close alone is insufficient.";
    const received = await receiveWork({ tenantId: f.tenant, userId: f.principal, instruction, channel: "console",
      idempotencyKey: "full-original:" + label });
    await attachWorkEntity(f.tenant, received.workId, { entityType: "pe_deal", entityId: f.dealId,
      relationship: "target", source: "V3:original-full-mandate-fixture" });
    await startWorkObjective(instruction, f.ctx.auth, { workId: received.workId, workInputId: received.workInputId,
      instructionId: received.instructionId, channel: "console", maxSteps: 96, maxQueries: 50, maxActions: 25,
      deadlineAt: new Date(f.spec.originalGrant.deadlineAt), deferInitialIteration: true,
      successCondition: { version: 1, statement: instruction, mode: "all", source: "explicit", criteria: [
        { kind: "canonical_query", request: { intent: "closing_readiness", dealId: f.dealId },
          assertion: { path: ["verifiedClosing", "status"], operator: "eq", expected: "CLOSED" } },
        // Deliberately not supplied by this closing-only scenario. Its absence
        // must prevent completion, not be erased by a narrower phase goal.
        { kind: "canonical_query", request: { intent: "closing_readiness", dealId: f.dealId },
          assertion: { path: ["verifiedClosing", "wholeMandateEconomicsRecorded"], operator: "eq", expected: true } },
      ] } });
    const [loop] = await withTenant(f.tenant, db => db.select().from(workObjectiveLoops)
      .where(and(dbEq(workObjectiveLoops.tenantId, f.tenant), dbEq(workObjectiveLoops.workId, received.workId))));
    assert(loop);
    f.originalWorkGoal = loop; f.workId = received.workId;
    f.intake.workId = received.workId;
    f.intake.continuation = { workInputId: received.workInputId, objectiveLoopId: loop.id,
      objectiveRevision: loop.revision, objectiveDigest: closingWorkGoalDigest(loop) };
  }
  f.initialDebt = fact(f, f.spec.funding[0], "FUNDING_AVAILABLE", "receiving-authority", {
    money: f.spec.funding[0].money, facilityDigest: f.spec.funding[0].facilityDigest, providerEntityId: lenderEntity,
    sourceClass: "DEBT_FACILITY", state: selected === "cross-phase" ? "CONDITIONAL_AVAILABLE" : "EFFECTIVE_AVAILABLE", operationKey: "original-debt-draw" });
  await save(label + "/frozen-independent-inputs.json", { intake: f.intake, profile: f.profile,
    documentBytesBase64: documentBytes.toString("base64"), originalS5: cleared, originalS5Request: clearing,
    classification: "HYPOTHETICAL_INDEPENDENT_OWNER_INPUTS_NOT_DOMAIN_QUALIFICATION" });
  await providerRequest("/__fixture/register", { spec: f.spec, digest: hash(f.spec), issuers: f.profile.issuers,
    documents: { [documentId]: documentBytes.toString("base64") }, initialDebtFactId: f.initialDebt.factId, fault: fault ?? null });
  ok(await request(f, "/api/closing/ports", {})); // Compile the actual authenticated route before episode intake.
  if (continuationProof) {
    const { continuation, ...missing } = f.intake;
    assert.equal((await request(f, "/api/closing/submit", missing)).status, 409);
    for (const changed of [{ objectiveDigest: "0".repeat(64) }, { workInputId: randomUUID() },
      { objectiveRevision: continuation.objectiveRevision + 1 }]) {
      assert.equal((await request(f, "/api/closing/submit", {
        ...f.intake, continuation: { ...continuation, ...changed },
      })).status, 409);
    }
    assert.equal((await admin!.query("SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2",
      [f.tenant, f.workId])).rows[0].n, 1, "Rejected continuation appended an input");
  }
  const submitted = await request(f, "/api/closing/submit", f.intake); ok(submitted);
  assert(submitted.elapsedMs < 30000, "Original intake response budget exceeded");
  assert.notEqual(submitted.body.status, "BLOCKED", JSON.stringify(submitted.body));
  f.programmeId = submitted.body.programmeId; f.workId = submitted.body.workId;
  assert(f.programmeId && f.workId);
  ok(await observe(f, f.initialDebt));
  const eq = f.spec.funding[1];
  ok(await observe(f, fact(f, eq, "FUNDING_AVAILABLE", "receiving-authority", {
    money: eq.money, facilityDigest: eq.facilityDigest, providerEntityId: eq.providerEntityId, sourceClass: eq.sourceClass,
    state: selected === "cross-phase" ? "INDICATIVE" : "SETTLED_CONTRIBUTION", operationKey: null })));
  const beneficiary = f.spec.beneficiaries[0];
  ok(await observe(f, fact(f, beneficiary, "BENEFICIARY_VALIDATED", "receiving-authority",
    { legalEntityId: beneficiary.legalEntityId, accountDigest: beneficiary.accountDigest, independentlyValidated: true })));
  if (selected !== "fallback") ok(await observe(f, fact(f, f.spec.conditions[0], "PROFESSIONAL_CONDITION", "counsel-authority",
    { satisfied: true }, { professionalScope: "regulatory-condition" })));
  ok(await observe(f, fact(f, f.spec.conditions[1], "OBSERVABLE_CONDITION", "counsel-authority", { satisfied: true })));
  const validation = ok(await request(f, "/api/allocations/validate", { allocationRef: f.certificate.ref }));
  assert.equal(validation.status, "CURRENT", "Native original S5 after accepted intake: " + JSON.stringify(validation));
  return f;
}
const databasePort = await port();
const postgres = new EmbeddedPostgres({ databaseDir: dbDirectory, user: "finnor_v3", password,
  port: databasePort, persistent: true, onLog: () => undefined });
try {
  let freeMemoryBytesEstimate: number, memoryProbe: string;
  if (process.platform === "linux") {
    const available = (await readFile("/proc/meminfo", "utf8")).match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    assert(available, "Kernel MemAvailable observation with explicit kB units required");
    freeMemoryBytesEstimate = Number(available[1]) * 1024;
    memoryProbe = "LINUX_KERNEL_MEM_AVAILABLE_KIB_TO_BYTES";
  } else if (process.platform === "darwin") {
    const pressure = execFileSync("memory_pressure", { encoding: "utf8", timeout: 5000 })
      .match(/free percentage:\s*(\d+)%/);
    assert(pressure, "macOS free-memory pressure observation required");
    freeMemoryBytesEstimate = Number(pressure[1]) * totalmem() / 100;
    memoryProbe = "MACOS_PRESSURE_PERCENT_OF_TOTAL_ESTIMATE";
  } else throw Error("Unsupported closing verification resource-probe platform: " + process.platform);
  assert(Number.isFinite(freeMemoryBytesEstimate) && freeMemoryBytesEstimate >= 0 &&
    freeMemoryBytesEstimate <= totalmem(), "Physically valid free-memory observation required");
  assert(freeMemoryBytesEstimate >= 4 * 1024 ** 3, "Registered free-memory floor");
  const disk = execFileSync("df", ["-k", root], { encoding: "utf8" }).trim().split("\n").at(-1)!.trim().split(/\s+/);
  const diskAdmissionBytes = continuationProof ? 512 * 1024 ** 2 : 1.5 * 1024 ** 3;
  assert(Number(disk[3]) * 1024 >= diskAdmissionBytes, "Registered runtime disk floor");
  if (continuationProof) resourceMonitor = setInterval(async () => {
    if (resourceFailure) return;
    try {
      const free = await statfs(root), freeBytes = free.bavail * free.bsize;
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 2000 })
        .trim().split("\n").map(line => {
          const values = line.trim().split(/\s+/).map(Number);
          assert(values.length === 3 && values.every(n => Number.isSafeInteger(n) && n >= 0)
            && values[0]! > 0, "CONTINUATION_PROCESS_OBSERVATION_MALFORMED");
          return values as [number, number, number];
        });
      const owned = new Set([process.pid, ...[...children].filter(c => c.exitCode === null && c.signalCode === null).map(c => c.pid!)]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
      }
      const rss = rows.filter(([pid]) => owned.has(pid)).reduce((sum, row) => sum + row[2]! * 1024, 0);
      resourceObservation.samples++; resourceObservation.peakOwnedRssBytes = Math.max(resourceObservation.peakOwnedRssBytes, rss);
      resourceObservation.minimumObservedFreeBytes = Math.min(resourceObservation.minimumObservedFreeBytes, freeBytes);
      if (freeBytes < 256 * 1024 ** 2 || rss > 16 * 1024 ** 3) throw Error("CONTINUATION_OWNED_RESOURCE_SAFETY_STOP");
    } catch (error) {
      resourceFailure = error instanceof Error ? error : Error("CONTINUATION_RESOURCE_OBSERVATION_FAILED");
      for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
      }
    }
  }, 1000);
  resourceMonitor?.unref();
  const sourceFiles = [...execFileSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8" }).trim().split("\n"),
    ...execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "--", ":(exclude)scope-v/**/evidence/**"], { encoding: "utf8" }).trim().split("\n"),
    "finnor-os/scripts/s5/owner-fixture.mts", "finnor-os/scripts/s3/reference.py",
    "finnor-os/apps/api/next.config.mjs", "finnor-os/apps/worker/src/queue.ts", "finnor-os/package-lock.json", "package-lock.json"];
  const sourceCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const manifest = [], absentSourceFiles: string[] = [];
  for (const path of [...new Set(sourceFiles)].filter(p => p && !p.includes("/evidence/")).sort()) {
    let bytes: Buffer;
    try { bytes = await readFile(join(root, path)); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        absentSourceFiles.push(path); continue;
      }
      throw error;
    }
    const target = join(output, "source-snapshot", path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, path), target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    assert.equal(hash(await readFile(target)), hash(bytes), "Source snapshot bytes changed");
    manifest.push({ path, sha256: hash(bytes) });
  }
  await save("freeze.json", { schema: "finnor.v3.runtime-freeze.v1", startedAt, selected, node: process.version,
    sourceCommit, sourceTree, manifest, absentSourceFiles,
    originalFullWorkContinuationProof: continuationProof,
    resourceFloor: { freeMemoryBytesEstimate, memoryProbe, diskAvailableBytes: Number(disk[3]) * 1024,
      diskAdmissionBytes, originalDefaultDiskAdmissionBytes: 1.5 * 1024 ** 3 },
    classification: "FINITE_AUTHENTICATED_DEVELOPMENT_ENGINEERING_NOT_PROTECTED_DOMAIN_OR_IMAGE_QUALIFICATION" });
  const generated = spawnSync(baseEnv.FINNOR_S3_PYTHON!, [join(backend, "scripts/s3/reference.py")],
    { input: '{"operation":"equivalent"}', encoding: "utf8" }); assert.equal(generated.status, 0, generated.stderr);
  const generatedRows = JSON.parse(generated.stdout).rows;
  const numerical = spawnSync(baseEnv.FINNOR_S3_PYTHON!, ["-I", "-c",
    "import sys,time,json; start=time.monotonic(); import numpy,scipy,statsmodels.api,arch,pandas; import importlib.metadata as m; print(json.dumps({'python':sys.version,'installedVersions':{p:m.version(p) for p in ['numpy','scipy','statsmodels','arch','pandas','patsy','packaging','python-dateutil','six','pytz','tzdata']},'installationImportSeconds':time.monotonic()-start,'qualification':'INSTALLATION_PREPARATION_OUTSIDE_CLOSING_EPISODE_NOT_COLD_IMAGE_PROOF'}))"],
    { encoding: "utf8", timeout: 120000, env: { PATH: baseEnv.PATH, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" } });
  assert.equal(numerical.status, 0, numerical.stderr); await save("numerical-runtime.json", JSON.parse(numerical.stdout));
  process.env.NODE_ENV = "test"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  await postgres.initialise(); await postgres.start(); postgresRunning = true; await postgres.createDatabase("v3_runtime");
  const databaseUrl = (role: string) => `postgres://${role}:${password}@127.0.0.1:${databasePort}/v3_runtime`;
  const migrations = await migrate(databaseUrl("finnor_v3"));
  admin = new pg.Client({ connectionString: databaseUrl("finnor_v3") }); await admin.connect();
  for (const role of ["finnor_app", "finnor_worker", "finnor_closing_checker", "finnor_closing_broker"])
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.query("SET app.test_vertical_mode='explicit'");
  Object.assign(process.env, baseEnv, { DATABASE_URL: databaseUrl("finnor_app") }); await closePool();
  authServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    if (_req.url?.includes("/.well-known/jwks.json")) { res.end(JSON.stringify({ keys: [jwk] })); return; }
    res.writeHead(404); res.end('{"error":"DISPOSABLE_JWKS_ONLY"}');
  });
  const authPort = await port(); await new Promise<void>(done => authServer!.listen(authPort, "127.0.0.1", done));
  authOrigin = `http://127.0.0.1:${authPort}`;
  const providerPort = await port(); providerOrigin = `http://127.0.0.1:${providerPort}`;
  for (const id of ["document-authority", "receiving-authority", "registry-authority", "counsel-authority"])
    keys.set(id, generateKeyPairSync("ed25519") as any);
  const providerFile = await privateFile("provider-authority.json", JSON.stringify({ port: providerPort,
    token: providerToken, journal: join(output, "provider-journal.jsonl"),
    privateKeys: Object.fromEntries([...keys].map(([id, key]) => [id, key.privateKey.export({ type: "pkcs8", format: "pem" })])) }));
  await privateFile("provider.token", providerToken); await privateFile("checker.token", checkerToken);
  const brokerTokenFile = await privateFile("broker.token", brokerToken); await privateFile("empty.env", "");
  await privateFile("provider-bindings.json", "{}");
  const provider = await launch("provider", ["--import=tsx", join(backend, "scripts/v3/provider-authority.mts"), providerFile], {}); await ready(provider, "Provider");
  const checkerPort = await port();
  const checker = await launch("checker", ["--import=tsx", join(backend, "packages/epistemic-runtime/src/closing-checker-service.mts")],
    { FINNOR_V3_CHECKER_DATABASE_URL: databaseUrl("finnor_closing_checker"), FINNOR_V3_CHECKER_BEARER: checkerToken, FINNOR_V3_CHECKER_PORT: String(checkerPort) });
  checkerDigest = (await ready(checker, "Checker")).checkerDigest;
  const brokerPort = await port();
  const broker = await launch("broker", ["--import=tsx", join(backend, "packages/governed-execution/src/closing-provider-broker.mts")], {
    FINNOR_V3_BROKER_DATABASE_URL: databaseUrl("finnor_closing_broker"), FINNOR_V3_BROKER_SERVER_TOKEN_FILE: brokerTokenFile,
    FINNOR_V3_BROKER_PORT: String(brokerPort), FINNOR_V3_PROVIDER_BINDINGS_FILE: join(privateDirectory, "provider-bindings.json"),
  }); await ready(broker, "Broker");
  const appEnv = { DATABASE_URL: databaseUrl("finnor_app"), SUPABASE_URL: authOrigin,
    SUPABASE_SERVICE_ROLE_KEY: "disposable-public-development-verifier-key",
    FINNOR_V3_CHECKER_ORIGIN: `http://127.0.0.1:${checkerPort}`, FINNOR_V3_CHECKER_CLIENT_TOKEN_FILE: join(privateDirectory, "checker.token"),
    FINNOR_V3_BROKER_ORIGIN: `http://127.0.0.1:${brokerPort}`, FINNOR_V3_BROKER_CLIENT_TOKEN_FILE: brokerTokenFile };
  const workerEnv = { ...appEnv, DATABASE_URL: databaseUrl("finnor_worker") };
  compensationWorkerEnv = workerEnv;
  const apiPort = await port(); apiOrigin = `http://127.0.0.1:${apiPort}`;
  const api = await launch("api", [join(backend, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(apiPort)],
    { ...appEnv, NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=3072" }, join(backend, "apps/api"));
  const warmUntil = Date.now() + 90000;
  let warm = false;
  while (Date.now() < warmUntil) {
    assert(api.cp.exitCode === null, "Actual Next startup exited");
    try {
      const r = await fetch(apiOrigin + "/api/closing/ports", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) });
      if (r.status === 401) { warm = true; break; }
    } catch { /* Actual listener/compilation startup only. */ }
    await sleep(300);
  }
  assert(warm, "Actual Next auth route never became ready");
  const day = 86400000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString();
  compensationHorizon = { startAt: new Date(Date.parse(begin) + 128 * day).toISOString(), periodMs: day, periods: 1 };
  support = createUpstreamFixtureSupport({ admin: () => admin, generatedRows, begin, day, fixtures,
    api: ownerApi, artifact: save });
  await save("runtime-identities.json", { migrations, checkerDigest, publicJwk: jwk, apiOrigin, authOrigin, providerOrigin,
    database: { directory: dbDirectory, port: databasePort, name: "v3_runtime" },
    roles: (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker','finnor_closing_checker','finnor_closing_broker') ORDER BY rolname")).rows,
    authentication: "REAL_RS256_JWKS_NO_AUTH_DEV_BYPASS", privateCredentialsIncluded: false });
  if (workforceCompensation) {
    const ownerSources = (await readdir(join(backend, "packages/private-equity/src")))
      .filter(name => name.startsWith("workforce-") && name.endsWith(".ts"))
      .map(name => "packages/private-equity/src/" + name);
    const paths = [...ownerSources, "packages/private-equity/src/allocation-store.ts",
      "packages/private-equity/src/closing/store.ts", "packages/orchestration/src/workforce-execution/dependencies.ts",
      "packages/shared-types/src/closing.ts", "packages/epistemic-runtime/src/closing-checker.ts",
      "packages/governed-execution/src/closing-provider.ts", "scripts/v3/provider-authority.mts",
      "scripts/v3/run-closing-e2e.mts", "scripts/postz-w2/closing-compensation-fixture.mts"];
    await save("workforce-compensation/source-preimages.json", {
      schema: "finnor.w2.closing-compensation-sources.v1", compensationCase,
      sources: await Promise.all(paths.sort().map(async path => ({ path,
        sha256: createHash("sha256").update(await readFile(join(backend, path))).digest("hex") }))),
      qualification: "EXACT_EXECUTED_DEVELOPMENT_SOURCE_NOT_INSTALLED_OR_COLD_PROOF" });
  }
  const f = await fixture("registered-" + selected + (workforceCompensation ? "-" + compensationCase : ""),
    workforceCompensation && compensationCase === "exact" ? "lost-pay" : selected === "lost-draw" ? "lost-draw"
    : selected === "signer-professional" ? "wrong-signer" : selected === "settlement" ? "partial-settlement" : undefined);
  assert.equal((await request(f, "/api/closing/read", { programmeId: f.programmeId }, undefined, bearer(f, f.principal, -1))).status, 401);
  if (selected === "authenticated-positive") {
    let insertDenial: { code?: string; message: string } | undefined;
    try {
      await withTenantTransaction(f.tenant, { userId: f.principal }, async (_db, c) => c.query(
        `INSERT INTO finnor_os.pe_closing_programmes(
          tenant_id,transaction_id,principal_id,work_id,work_input_id,work_input_digest,profile_id,profile_digest,
          accepted_terms_source_id,accepted_terms_version_id,approved_terms_revision,spec,spec_digest,graph,
          dependency_pins,authority_revision,intake_authority_decision_id,original_deadline_at,status,idempotency_key,intake_digest)
        SELECT tenant_id,transaction_id,principal_id,work_id,work_input_id,work_input_digest,profile_id,profile_digest,
          accepted_terms_source_id,accepted_terms_version_id,approved_terms_revision,spec,spec_digest,graph,
          dependency_pins,authority_revision,intake_authority_decision_id,original_deadline_at,'CLOSED',$3,intake_digest
          FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND id=$2`,
        [f.tenant, f.programmeId, "native-unsafe-initial-close:" + randomUUID()],
      ));
    } catch (error) { insertDenial = { code: (error as { code?: string }).code, message: (error as Error).message }; }
    assert.equal(insertDenial?.code, "P0001");
    assert.equal(insertDenial.message, "Initial closing programme cannot assert independent check or publication");
    const originalStatus = (await admin.query("SELECT status FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND id=$2", [f.tenant, f.programmeId])).rows[0].status;
    // Explicit disposable corruption injection, not a runtime-owned certificate.
    await admin.query("BEGIN");
    try {
      await admin.query("ALTER TABLE finnor_os.pe_closing_programmes DISABLE TRIGGER pe_closing_programme_guard");
      await admin.query("UPDATE finnor_os.pe_closing_programmes SET status='CLOSED' WHERE tenant_id=$1 AND id=$2", [f.tenant, f.programmeId]);
      await admin.query("ALTER TABLE finnor_os.pe_closing_programmes ENABLE TRIGGER pe_closing_programme_guard");
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    let defensiveProjection: any;
    try {
      defensiveProjection = await projection(f);
      assert.equal(defensiveProjection.status, "BLOCKED");
      assert.equal(defensiveProjection.certificate, null);
      assert.equal(defensiveProjection.qualification.liveCountsEligible, false);
    } finally {
      await admin.query("UPDATE finnor_os.pe_closing_programmes SET status=$3 WHERE tenant_id=$1 AND id=$2", [f.tenant, f.programmeId, originalStatus]);
    }
    const deepSpec = structuredClone(f.spec);
    let extension: any = {}; const deepExtension = extension;
    for (let depth = 0; depth < 40; depth++) { extension.next = {}; extension = extension.next; }
    deepSpec.steps[0].decision.extension = deepExtension;
    const deepDenial = await request(f, "/api/closing/submit", {
      ...f.intake, spec: deepSpec, expectedSpecDigest: hash(deepSpec), idempotencyKey: "unsafe-deep-json",
    });
    assert.equal(deepDenial.status, 400);
    const duplicateResourceSpec = structuredClone(f.spec);
    duplicateResourceSpec.steps[1].resourceBindings.push(structuredClone(duplicateResourceSpec.steps[1].resourceBindings[0]));
    const duplicateResourceDenial = await request(f, "/api/closing/submit", {
      ...f.intake, spec: duplicateResourceSpec, expectedSpecDigest: hash(duplicateResourceSpec), idempotencyKey: "unsafe-duplicate-resource",
    });
    assert.equal(duplicateResourceDenial.status, 400);
    await save("safety-repairs/native-insert-projection-json-and-resource-guards.json",
      { insertDenial, defensiveProjection, deepDenial, duplicateResourceDenial,
        physicalEffectsBeforeFaultInjection: (await providerRequest("/__fixture/state")).requests.length });
  }
  if (selected === "concurrency-isolation") {
    const replay = await Promise.all(Array.from({ length: 8 }, () => request(f, "/api/closing/submit", f.intake)));
    assert(replay.every(r => r.status === 202 && r.body.programmeId === f.programmeId));
    assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1", [f.tenant])).rows[0].n, 1);
    assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.works WHERE tenant_id=$1", [f.tenant])).rows[0].n, 1);
    const competitor = await support.policy(f, "competing-pay", { cash: 120000000 });
    const competingClearance = ok(await ownerApi(f, "clear", support.clearing(f, { "competing-pay": ["100"] }, [], [], [competitor])));
    assert.equal(competingClearance.certificate?.policyBindings.length, 0, "Second Work cannot reuse the held original cash");
    const foreign = { name: "foreign-closing-scope", tenant: randomUUID(), principal: randomUUID() };
    await admin.query("INSERT INTO finnor_os.tenants(id,name,client_key) VALUES($1,$2,$3)", [foreign.tenant, foreign.name, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [foreign.principal, foreign.tenant, foreign.name + "@s5.example.test"]);
    await admin.query("INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,effective_from,source_system,created_by) VALUES($1,'private_equity',1,now(),'v3:fixture','independent-development-owner')", [foreign.tenant]);
    const denied = await request(foreign, "/api/closing/read", { programmeId: f.programmeId });
    assert.equal(denied.status, 404);
    await save("concurrency-isolation/replay-competing-cash-and-foreign-read.json", { replay, competingClearance, denied });
  }
  if (["lost-draw", "ordering-cancellation", "currentness"].includes(selected)) {
    await providerRequest("/__fixture/read-gate", { blocked: true });
  }
  if (workforceCompensation && compensationCase === "exact")
    await providerRequest("/__fixture/read-gate", { blocked: true, nodeKey: "pay-seller" });
  worker = (await launch("worker-1", ["--import=tsx", join(backend, "apps/worker/src/index.ts")], workerEnv)).cp;
  if (selected === "fallback") {
    await waitFor(f, q => q.children.some((c: any) => c.nodeKey === "request-professional"));
    const before = await snapshot(f); await save("fallback/original-professional-request.json", before);
    ok(await observe(f, fact(f, f.spec.conditions[0], "PROFESSIONAL_CONDITION", "counsel-authority",
      { satisfied: true }, { professionalScope: "regulatory-condition" })));
  }
  if (selected === "lost-draw") {
    const accepted = await waitFor(f, (_q, state) => state.programmes.some((p: any) => p.drawn));
    const killedPid = worker.pid; process.kill(-worker.pid!, "SIGKILL"); await sleep(500);
    const killed = await snapshot(f); await save("lost-draw/killed-original-worker.json", { killedPid, accepted, killed });
    assert(killed.invocations.some((i: any) => i.closing_provider_egress_at), "Independent possible-egress marker missing");
    assert(killed.consumptions.some((c: any) => c.status === "UNKNOWN_OUTCOME"), "Original S5 exposure not retained");
    worker = (await launch("worker-2", ["--import=tsx", join(backend, "apps/worker/src/index.ts")], workerEnv)).cp;
    await sleep(12000);
    const retained = await projection(f); assert.notEqual(retained.status, "CLOSED");
    await save("lost-draw/unknown-before-original-readback.json", retained);
    await providerRequest("/__fixture/read-gate", { blocked: false });
    ok(await request(f, "/api/closing/resume", { programmeId: f.programmeId }));
  }
  if (workforceCompensation) {
    if (compensationCase === "exact") {
      const unknown = await waitFor(f, q => q.unresolvedEffects.some((e: any) => e.nodeKey === "pay-seller"));
      const promise = await compensationReadback({ f, request });
      assert.equal(promise.observations[0].status, "OPEN", "Acknowledgement or UNKNOWN paid the accepted promise");
      assert.equal(promise.externalSettlementEstablished, false);
      await save("workforce-compensation/unknown-original-effect.json", { unknown, promise, funding: await compensationFunding({ f }) });
      await providerRequest("/__fixture/read-gate", { blocked: false, nodeKey: "pay-seller" });
      ok(await request(f, "/api/closing/resume", { programmeId: f.programmeId }));
    }
    const completed = await waitFor(f, q => q.status === "CLOSED" && q.certificate?.currentlyValid, 480000);
    const nativeCompletion = await completedNativeWork(f);
    const compensation = await compensationReadback({ f, request }), funding = await compensationFunding({ f });
    const portfolio = ok(await request(f, "/api/allocations/resources", {}));
    await save("workforce-compensation/settled-owner-before-projection-assertion.json",
      { completed, nativeCompletion, compensation, funding, portfolio });
    assert.equal(JSON.stringify(compensation.records[0]), f.compensationFixture.acceptedBytes, "Immutable acceptance was rewritten");
    assert.equal(compensation.observations[0].status, compensationCase === "exact" ? "SETTLED" : "OPEN",
      "Exact receiving receipt join must pay only the original amount, payee and reservation");
    assert.equal(compensation.externalSettlementEstablished, compensationCase === "exact");
    if (compensationCase === "exact") {
      const paid = funding.find(row => row.assignmentId === f.compensationFixture.obligation.assignmentId);
      assert(paid);
      const cashSpent = paid.spent.find(e => e.resourceId === "cash"), cashHeld = paid.directReserved.find(e => e.resourceId === "cash");
      assert(cashSpent && cashHeld);
      assert.equal(cashSpent.quantities[0], "2");
      assert.equal(cashHeld.quantities[0], "0",
        "Paid cash was made available again");
      const cashCommitted = portfolio.outstanding.flatMap((row: any) => row.envelopes)
        .filter((e: any) => e.resourceId === "cash").reduce((sum: bigint, e: any) => sum + BigInt(e.quantities[0]), 0n);
      assert.equal(cashCommitted, 2n, "The same physical payment was charged to both original reservations");
    }
    const before = await snapshot(f), posts = completed.state.requests.filter((r: any) => r.specDigest === hash(f.spec));
    assert.equal(posts.filter((r: any) => r.nodeKey === "pay-seller").length, 1, "Physical payment repeated");
    const paidEffect = posts.find((r: any) => r.nodeKey === "pay-seller").effectId;
    assert.equal(before.consumptions.filter((r: any) => r.effect_ref?.id === paidEffect).length, 1,
      "The original physical financial effect must have exactly one S5 consumption");
    const killedPid = worker!.pid;
    process.kill(-killedPid!, "SIGKILL");
    await new Promise<void>(done => worker!.once("exit", () => done()));
    worker = (await launch("worker-compensation-recovery", ["--import=tsx", join(backend, "apps/worker/src/index.ts")], workerEnv)).cp;
    const replay = await compensationReadback({ f, request }), replayFunding = await compensationFunding({ f });
    assert.deepEqual(replay, compensation, "Read-only recovery changed the receipt join");
    assert.deepEqual(replayFunding, funding, "Receipt replay charged or freed cash twice");
    assert.equal((await providerRequest("/__fixture/state")).requests.length, completed.state.requests.length,
      "Receipt recovery performed a new physical mutation");
    let currentness: any;
    if (compensationCase === "exact") {
      const originalReceipt = completed.state.programmes.find((p: any) => p.transactionId === f.dealId).effects
        .find((effect: any) => effect.businessEffectId === paidEffect).observation;
      const correction = fact(f, f.spec.fundsFlows[0], "RECEIVING_SETTLEMENT", "receiving-authority",
        { ...originalReceipt.claims, receivingState: "DISPUTED" },
        { status: "FAILED", supersedesFactIds: [originalReceipt.factId] });
      ok(await observe(f, correction));
      const corrected = await projection(f), retained = await compensationReadback({ f, request });
      assert.equal(corrected.status, "REOPENED");
      assert.equal(retained.observations[0].status, "OPEN", "A stale independent closing receipt discharged a promise");
      assert.equal(retained.externalSettlementEstablished, false);
      assert.equal(JSON.stringify(retained.records[0]), f.compensationFixture.acceptedBytes);
      assert.deepEqual(await compensationFunding({ f }), funding, "A receipt correction refunded historical cash");
      assert.equal((await providerRequest("/__fixture/state")).requests.length, completed.state.requests.length);
      currentness = { correction, corrected, retained, physicalPaymentNotUndone: true };
    }
    await save("workforce-compensation/receiving-join-" + compensationCase + ".json",
      { completed, nativeCompletion, compensation, funding, before, killedPid, replay, replayFunding, currentness,
        realPayment: false, genuineHumanQualified: false, newFinancialTransport: false });
    successes.push({ id: "workforce-compensation-" + compensationCase, fullNativeHttpWorkerClose: true,
      exactReceiptDischarged: compensationCase === "exact", noReplay: true, realPayment: false, protectedAdmission: "NOT_ADMITTED" });
  } else if (selected === "ordering-cancellation" || selected === "currentness") {
    const before = await waitFor(f, (_q, state) => state.programmes.some((p: any) => p.drawn));
    if (selected === "currentness") {
      await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",
        [f.tenant, f.actors.find((a: any) => a.kind === "seller").id]);
    }
    const stopped = selected === "ordering-cancellation"
      ? ok(await request(f, "/api/closing/stop", { programmeId: f.programmeId }))
      : await projection(f);
    await providerRequest("/__fixture/read-gate", { blocked: false });
    await sleep(6000);
    const state = await providerRequest("/__fixture/state"), after = await snapshot(f);
    assert.notEqual(stopped.status, "CLOSED"); assert(state.programmes[0].drawn);
    assert(!state.programmes[0].legallyEffective); assert.equal(after.duties.length, 2);
    assert.equal(state.requests.length, before.state.requests.length, "Cancellation or changed current authority allowed another physical effect");
    assert.equal(state.programmes[0].sellerReceivedExact18, "0");
    successes.push({ id: selected, before, stopped, state, after, cancellationIsNotCompensation: true });
  } else if (["signer-professional", "settlement", "cross-phase"].includes(selected)) {
    const refusal = await waitFor(f, (q, state) => q.check && q.pendingPredicates.some((r: string) => selected === "signer-professional"
      ? r === "FAILED_PARTIAL_UNKNOWN_OR_CONFLICTING_EVIDENCE:agreement"
      : selected === "settlement" ? r === "FAILED_PARTIAL_UNKNOWN_OR_CONFLICTING_EVIDENCE:purchase-price"
        : r === "FUNDING_DRAW_NOT_SETTLED:debt") && (selected !== "cross-phase"
          || q.check.closeConjunction.executedDocuments
            && state.requests.some((request: any) => request.nodeKey === "request-signature")));
    assert.notEqual(refusal.q.status, "CLOSED"); assert(!refusal.state.programmes[0].legallyEffective);
    if (selected === "cross-phase") assert.equal(refusal.state.requests.filter((request: any) => request.nodeKey === "draw-debt").length, 0,
      "Conditional facility availability was promoted into a physical draw");
    successes.push({ id: selected, refusal, oracle: await snapshot(f), qualifiedPeers: null });
  } else {
    const completed = await waitFor(f, q => q.status === "CLOSED" && q.certificate?.currentlyValid, 480000);
    const state = completed.state.programmes.find((p: any) => p.transactionId === f.dealId); assert(state);
    assert.equal(state.sellerReceivedExact18, String(120000000n * 10n ** 18n));
    assert(state.drawn && state.rightsTransferred && state.legallyEffective);
    assert(Object.values(completed.q.check.closeConjunction).every(v => v === true));
    assert.equal(completed.q.continuingDuties.length, 2);
    assert.equal(completed.state.requests.filter((r: any) => r.nodeKey === "draw-debt").length, 1);
    let nativeCompletion: any;
    if (continuationProof) {
      const [loop] = await withTenant(f.tenant, db => db.select().from(workObjectiveLoops)
        .where(and(dbEq(workObjectiveLoops.tenantId, f.tenant), dbEq(workObjectiveLoops.workId, f.workId))));
      assert(loop);
      assert.equal(closingWorkGoalDigest(loop), closingWorkGoalDigest(f.originalWorkGoal));
      assert.equal(loop.revision, f.originalWorkGoal.revision);
      assert.notEqual(loop.state, "completed", "Closing-only success erased the remaining original criterion");
      const work = (await admin!.query("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
        [f.tenant, f.workId])).rows[0];
      assert.notEqual(work.status, "completed");
      assert.equal((await admin!.query("SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2",
        [f.tenant, f.workId])).rows[0].n, 1);
      nativeCompletion = { fullGoalPreserved: true, wholeWorkNotPrematurelyCompleted: true, loop, work };
    } else nativeCompletion = await completedNativeWork(f);
    const terminalProjection = await projection(f);
    assert.equal(terminalProjection.status, "CLOSED");
    assert.equal(terminalProjection.certificate.currentlyValid, true, "Native completion invalidated its own certificate");
    const ordinary = await withTenantTransaction(f.tenant, { userId: f.principal, readOnly: true }, async (_db, c) =>
      (await c.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]);
    assert.equal(ordinary.rolsuper, false); assert.equal(ordinary.rolbypassrls, false);
    await save("authenticated-positive/complete-canonical-close.json", { completed, terminalProjection, nativeCompletion, ordinary, oracle: await snapshot(f) });
    if (selected === "reopening" || selected === "requalification") {
      const historical = completed.q.certificate.body;
      const correction = fact(f, f.spec.conditions[0], "PROFESSIONAL_CONDITION", "counsel-authority",
        { satisfied: false }, { professionalScope: "regulatory-condition", status: "FAILED" });
      ok(await observe(f, correction)); const reopened = await projection(f);
      assert.equal(reopened.status, "REOPENED"); assert.equal(reopened.certificate.currentlyValid, false);
      assert.deepEqual(reopened.certificate.body, historical); assert.equal(reopened.continuingDuties.length, 2);
      await save("reopening/historical-and-current.json", { correction, reopened, historical });
      if (selected === "requalification") {
        const originalProgrammeId = f.programmeId, originalDigest = hash(f.spec);
        const originalDuties = (await snapshot(f)).duties;
        process.kill(-worker.pid!, "SIGSTOP");
        f.spec = ClosingSpecSchema.parse({ ...f.spec, assumptions: [...f.spec.assumptions,
          "Independently corrected condition; requalify original effects without fresh financial action or grant."] });
        const reattested = await providerRequest("/__fixture/requalify", {
          originalDigest, spec: f.spec, digest: hash(f.spec),
        });
        const continuation = ok(await request(f, "/api/closing/submit", {
          ...f.intake, workId: f.workId, spec: f.spec, expectedSpecDigest: hash(f.spec),
          legalAcceptance: fact(f, { key: "closing-spec" }, "LEGAL_SPEC_ACCEPTANCE", "counsel-authority",
            { accepted: true, specDigest: hash(f.spec) }, { professionalScope: "closing-spec" }),
          idempotencyKey: "original-work-requalification",
        }));
        assert.equal(continuation.workId, f.workId); assert.notEqual(continuation.programmeId, originalProgrammeId);
        assert.notEqual(continuation.status, "BLOCKED", JSON.stringify(continuation));
        f.programmeId = continuation.programmeId;
        for (const observation of reattested.observations) ok(await observe(f, observation));
        const eq = f.spec.funding[1], beneficiary = f.spec.beneficiaries[0];
        ok(await observe(f, fact(f, eq, "FUNDING_AVAILABLE", "receiving-authority", {
          money: eq.money, facilityDigest: eq.facilityDigest, providerEntityId: eq.providerEntityId,
          sourceClass: eq.sourceClass, state: "SETTLED_CONTRIBUTION", operationKey: null })));
        ok(await observe(f, fact(f, beneficiary, "BENEFICIARY_VALIDATED", "receiving-authority",
          { legalEntityId: beneficiary.legalEntityId, accountDigest: beneficiary.accountDigest, independentlyValidated: true })));
        ok(await observe(f, fact(f, f.spec.conditions[0], "PROFESSIONAL_CONDITION", "counsel-authority",
          { satisfied: true }, { professionalScope: "regulatory-condition" })));
        ok(await observe(f, fact(f, f.spec.conditions[1], "OBSERVABLE_CONDITION", "counsel-authority", { satisfied: true })));
        process.kill(-worker.pid!, "SIGCONT");
        const requalified = await waitFor(f, q => q.status === "CLOSED" && q.certificate?.currentlyValid);
        const retainedCompletion = await completedNativeWork(f);
        const currentCertificate = await projection(f);
        assert.equal(currentCertificate.certificate.currentlyValid, true);
        assert.notEqual(requalified.q.certificate.id, completed.q.certificate.id);
        assert(requalified.q.certificate.body.validityAndSupersession.supersedes.includes(completed.q.certificate.id));
        assert.equal(requalified.state.requests.length, completed.state.requests.length, "Requalification repeated a physical effect");
        assert.equal(requalified.state.requests.filter((r: any) => r.nodeKey === "draw-debt").length, 1);
        for (const key of ["max_steps", "max_actions", "max_queries"]) assert.equal(retainedCompletion[key], nativeCompletion[key]);
        assert.equal(new Date(retainedCompletion.deadline_at).toISOString(), new Date(nativeCompletion.deadline_at).toISOString());
        for (const key of ["step_count", "action_count", "query_count"]) assert(retainedCompletion[key] >= nativeCompletion[key]);
        const prior = ok(await request(f, "/api/closing/read", { programmeId: originalProgrammeId }));
        assert.deepEqual(prior.certificate.body, historical);
        assert.deepEqual((await snapshot(f)).duties, originalDuties);
        await save("requalification/current-superseding-certificate-and-original-grant.json",
          { continuation, reattested, requalified, retainedCompletion, nativeCompletion, prior, currentCertificate,
            oracle: await snapshot(f) });
      }
    }
    successes.push({ id: selected, programmeId: f.programmeId, workId: f.workId,
      fullNativeHttpWorkerClose: true, mountedBrowser: "NOT_RUN", installedImage: "NOT_RUN", qualifiedDomain: "NOT_ESTABLISHED" });
  }
  if (process.env.FINNOR_V3_MOUNTED_BROWSER === "1") {
    assert.equal(selected, "authenticated-positive", "Mounted browser uses the registered completed ordinary programme");
    const f = current;
    const bootstrap = await privateFile("mounted-browser-session.json", JSON.stringify({
      apiOrigin, authOrigin, tenantId: f.tenant, principalId: f.principal, workId: f.workId,
      transactionId: f.dealId, programmeId: f.programmeId, accessToken: bearer(f),
    }));
    await save("browser-hold.json", { bootstrap, apiOrigin, authOrigin, workId: f.workId,
      transactionId: f.dealId, programmeId: f.programmeId, maximumHoldMs: 900_000,
      generatedDisposableSessionOnly: true, originalProgrammeGrantsUnchanged: true });
    const holdDeadline = Date.now() + 900_000;
    let released = false;
    while (Date.now() < holdDeadline) {
      try {
        const release = JSON.parse(await readFile(join(output, "browser-release.json"), "utf8"));
        assert.equal(release.release, true); released = true; break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await sleep(500);
    }
    assert(released, "Bounded mounted-browser hold expired without release");
  }
} catch (error) {
  failed = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null };
  if (current?.tenant) try { await save("failed-canonical-readback.json", await snapshot(current)); } catch (e) { failed.readbackError = String(e); }
} finally {
  if (resourceMonitor) clearInterval(resourceMonitor);
  if (resourceFailure && !failed) failed = { message: resourceFailure.message, stack: resourceFailure.stack };
  for (const cp of children) { try { process.kill(-cp.pid!, "SIGCONT"); process.kill(-cp.pid!, "SIGTERM"); } catch { cp.kill("SIGTERM"); } }
  await sleep(1200);
  for (const cp of children) { try { process.kill(-cp.pid!, "SIGKILL"); } catch { cp.kill("SIGKILL"); } }
  authServer?.closeAllConnections(); await new Promise<void>(done => authServer ? authServer.close(() => done()) : done());
  await closePool().catch(() => undefined); await admin?.end().catch(() => undefined);
  if (postgresRunning) await postgres.stop();
  await save("results.json", {
    schema: "finnor.v3.authenticated-runtime-e2e.v1", startedAt, finishedAt: new Date().toISOString(),
    selected, successes, failed: failed ?? null, passed: !failed && successes.length > 0, calls, processes,
    resourceObservation, resourceFailure: resourceFailure?.message ?? null,
    classification: "AUTHENTICATED_DISPOSABLE_DEVELOPMENT_NATIVE_RUNTIME_NOT_PROTECTED_OR_LIVE",
    mountedBrowser: "NOT_RUN", installedImage: "NOT_RUN", protectedAdmission: "NOT_ADMITTED",
    costsUsd: null, economics: "NOT_ESTABLISHED", originalPrivateCustodyDirectory: privateDirectory,
    command: "FINNOR_V3_EVIDENCE_DIR=<absolute-fresh-dir> node --import=tsx scripts/v3/run-closing-e2e.mts --case " + selected,
  });
  console.log(JSON.stringify({ passed: !failed && successes.length > 0, evidence: join(output, "results.json"), failure: failed?.message?.slice(0, 1200) ?? null }));
  // The database package's beforeExit hook otherwise rewrites failure to 0.
  process.exit(!failed && successes.length > 0 ? 0 : 1);
}
