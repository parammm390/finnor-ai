/**
 * Z0 mounted-browser scenario (real Chromium, real Auth, real Next app, real API,
 * real worker). Launcher profile `z0` started with --no-worker; this scenario owns
 * the production worker. Governed by scope-z/phase-evidence/z0/mounted-failure-model.md
 * (including its section 6 amendments). Expected values are fixed before the run.
 *
 * Nothing here routes, fulfils, rewrites or injects a request, a session or a token.
 * Delay of an old-principal response is an owned database lock (observed in
 * pg_stat_activity); offline is context.setOffline; token refresh is the real
 * supabase-js refresh against the real Auth after the page clock is advanced.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readNativeEnvironment, signInOwner, startOwnedWorker, createOriginalInstitutionParent,
  driveAcquisitionToModelReady, submitInstitutionAcquisition,
} from "./x1-origin-fixture.mts";
import {
  APP, FRONTEND, INST, RequestWatch, claimLabelProbe, elementWith, ensureAuthCredential, idpUserId, loadPlaywright, newMountedContext,
  openWork, panelFor, privateDir, readPanels, refreshGrantStatus, screenshots, sha, sleep, storageScan, uiSignIn, uiSignOut,
  waitForPanel, waitUntil, workUrl, writePrivateJson,
} from "./z0-mounted-lib.mts";
import { readOwnerTruth, witness } from "./z0-mounted-oracle.mts";

const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE, root = process.env.FINNOR_NATIVE_ROOT;
if (!state || !evidence || !root) throw Error("Z0M_SCENARIO_NATIVE_ENVIRONMENT_REQUIRED");
const runName = state.split("/").at(-1);
const env = readNativeEnvironment(state);
mkdirSync(evidence, { recursive: true });
const privateRoot = privateDir(join(state, "z0m-private"));
const shotDirs = { original: privateDir(join(evidence, "screenshots-private")), redacted: privateDir(join(evidence, "screenshots-redacted")) };
const browserTmp = privateDir(join(privateRoot, "browser-tmp"));
const authOrigin = new URL(env.SUPABASE_URL).origin;
const startedAt = new Date();
const costs = { sqlQueries: 0, nodeAuthGrants: 0, modelCalls: 0, money: "UNKNOWN" };

const RERUN = "/home/factory-user/repos/project-z-worker-notes/rbg.sh w0m-native-NN /home/factory-user/repos/fzv-w-z0m stack -- "
  + "/home/factory-user/repos/fzv-int-out/native-run-z0m.sh w0m-native-NN z0 finnor-os/scripts/project-z/native/z0-mounted-session.mjs --no-worker";

/* ---------------------------------------------------------------- results and checks */
const cases = [];
class NotRun extends Error {}
const notRun = predicate => { throw new NotRun(predicate); };
const check = (c, id, expected, provenance, observed, pass) => {
  c.checks.push({ id, expected, provenance, observed, pass: Boolean(pass) });
  return Boolean(pass);
};
async function runCase(id, rows, title, body) {
  const c = { id, rows, title, outcome: "PASS", startedAt: new Date().toISOString(), checks: [], observations: {}, screenshots: [], gaps: [], error: null, reason: null };
  const t0 = Date.now();
  try { await body(c); }
  catch (error) {
    if (error instanceof NotRun) { c.reason = error.message; c.outcome = c.checks.some(item => !item.pass) ? "FAIL" : "NOT_RUN"; }
    else { c.outcome = "FAIL"; c.error = String(error?.message ?? error).slice(0, 700); }
  }
  if (c.outcome === "PASS" && c.checks.some(item => !item.pass)) c.outcome = "FAIL";
  if (c.outcome === "PASS" && c.checks.length === 0) { c.outcome = "FAIL"; c.error = "NO_CHECKS_EVALUATED"; }
  c.wallMs = Date.now() - t0;
  c.failedChecks = c.checks.filter(item => !item.pass).map(item => item.id);
  cases.push(c);
  writePrivateJson(join(evidence, `case-${id}.json`), c);
  console.log(JSON.stringify({ case: id, outcome: c.outcome, failed: c.failedChecks, error: c.error, reason: c.reason }));
}
const shot = async (page, c, name) => {
  try { c.screenshots.push(await screenshots(page, shotDirs, `${c.id}-${name}`)); } catch (error) { c.screenshots.push({ name, error: String(error?.message ?? error).slice(0, 120) }); }
};

/* ---------------------------------------------------------------- DB, worker, owner */
const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => { costs.sqlQueries++; return (await sql.query(text, params)).rows; };
const record = (name, value) => writePrivateJson(join(evidence, `fixture-${name}.json`), value);

const worker = env.FINNOR_WORKER_DATABASE_URL ? await startOwnedWorker(env, { logPath: join(privateRoot, "worker.log"), leaseSeconds: 30 }) : null;
const owner = await signInOwner(env); costs.nodeAuthGrants++;
for (const route of ["institution-mandate", "institution-register-source", "institution-sources", "institution-submit", "institution-read", "application-acquire", "application-projection", "application-cancel"])
  await owner.operation(route, {}).catch(() => null);

/* ---------------------------------------------------------------- setup (M-00) */
const setup = { workerOwned: Boolean(worker), A: null, B: null, foreign: null, errors: [] };
let parentA = null, acqA = null, threadA = null, parentB = null, sessionB = null, threadB = null, acquisitionB = null, foreignCreds = null, foreignRow = null;
const TERMINAL = ["MODEL_READY", "FAILED", "BLOCKED", "UNKNOWN", "STALE", "CANCELLED"];
const tagA = "ma" + randomUUID().slice(0, 6), tagB = "mb" + randomUUID().slice(0, 6);
let witnessBefore = null;

await runCase("M-00", [], "Preconditions: worker, original parent A at MODEL_READY, blocked parent B, threads, foreign owner", async c => {
  if (!worker) notRun("SCENARIO_OWNED_WORKER_REQUIRES_NO_WORKER_LAUNCH");
  parentA = await createOriginalInstitutionParent(env, { record, tag: tagA });
  check(c, "A.quiescent", "compiler WAITING|PARTIAL and zero live jobs", "O-SQL x1_compiler_requests/jobs via fixture", parentA.nativeStatus,
    ["WAITING", "PARTIAL"].includes(parentA.nativeStatus.compiler) && parentA.nativeStatus.liveJobs === 0);
  acqA = await driveAcquisitionToModelReady(env, parentA, { privateRoot, record });
  await acqA.portal.stop().catch(() => undefined);
  const [row] = await q("SELECT status FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parentA.tenantId, acqA.sessionId]);
  check(c, "A.session.MODEL_READY", "MODEL_READY with S4 acceptance event", "O-SQL sessions + fixture acceptance", { status: row?.status, acceptance: acqA.acceptance?.eventId ?? null }, row?.status === "MODEL_READY" && Boolean(acqA.acceptance));
  const title = `Z0 mounted original ${tagA} ${randomUUID().slice(0, 8)}`;
  const created = await owner.call("/api/threads", { title, workId: parentA.workId });
  threadA = { id: created.body?.thread?.id, title: created.body?.thread?.title ?? title };
  const [thread] = await q("SELECT active_work_id FROM finnor_os.employee_conversation_threads WHERE tenant_id=$1 AND id=$2", [parentA.tenantId, threadA.id]);
  check(c, "A.thread", "owner thread whose active Work is the original Work", "O-SQL employee_conversation_threads", { status: created.status, activeWorkId: thread?.active_work_id ?? null }, created.status === 201 && thread?.active_work_id === parentA.workId);

  try {
    parentB = await createOriginalInstitutionParent(env, { record, tag: tagB });
    const submitted = await submitInstitutionAcquisition(env, parentB, { privateRoot, record }, owner);
    acquisitionB = submitted.request;
    if (submitted.response.status !== 202) { await submitted.handle.portal.stop(); throw Error("B_ACQUIRE_" + submitted.response.status); }
    sessionB = submitted.response.body.sessionId;
    const status = async () => (await q("SELECT status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parentB.tenantId, sessionB]))[0];
    const requests = async () => (await q("SELECT count(*)::int n FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2", [parentB.tenantId, sessionB]))[0].n;
    let reached = false;
    for (let i = 0; i < 12000 && !reached; i++) {
      if (TERMINAL.includes((await status())?.status)) break;
      if (await requests() >= 2) { reached = true; break; }
      await sleep(50);
    }
    let revoked = [];
    if (reached) revoked = await q("UPDATE finnor_os.application_accounts SET status='disabled' WHERE tenant_id=$1 AND application='x2_portal' AND status<>'disabled' AND account_key LIKE $2 RETURNING id", [parentB.tenantId, `x2-%-${tagB}-%`]);
    let final = null;
    for (let i = 0; i < 120; i++) { final = await status(); if (TERMINAL.includes(final?.status)) break; await sleep(2500); }
    await submitted.handle.portal.stop().catch(() => undefined);
    setup.B = { sessionId: sessionB, raceReached: reached, revokedAccounts: revoked.length, final };
    check(c, "B.revocation.race", "revocation reached while the acquisition was in flight and B settled in a non-ready terminal state", "O-SQL sessions/application_accounts",
      setup.B, reached && revoked.length > 0 && TERMINAL.includes(final?.status) && final.status !== "MODEL_READY");
    const titleB = `Z0 mounted blocked ${tagB} ${randomUUID().slice(0, 8)}`;
    const createdB = await owner.call("/api/threads", { title: titleB, workId: parentB.workId });
    threadB = { id: createdB.body?.thread?.id, title: createdB.body?.thread?.title ?? titleB };
    check(c, "B.thread", "owner thread for B's Work", "owner API", { status: createdB.status }, createdB.status === 201 && Boolean(threadB.id));
  } catch (error) {
    setup.errors.push("B:" + String(error?.message ?? error).slice(0, 300));
    check(c, "B.setup", "second original parent with a revoked acquisition", "fixture", setup.errors.at(-1), false);
  }

  const [foreign] = await q("SELECT id,tenant_id,email FROM finnor_os.users WHERE role='owner' AND status='active' AND tenant_id<>$1 ORDER BY (email LIKE 'phase9.foreign%') DESC, email LIMIT 1", [parentA.tenantId]);
  if (foreign) {
    try {
      foreignCreds = await ensureAuthCredential(env, foreign.email);
      foreignRow = { userId: foreign.id, tenantId: foreign.tenant_id, emailSha256: sha(foreign.email).slice(0, 16) };
      const probe = await signInOwner(env, foreignCreds); costs.nodeAuthGrants++;
      check(c, "foreign.owner", "existing owner of another tenant signs in through real Auth and /api/me names a different tenant", "O-SQL users + O-API /api/me",
        { tenantDiffers: probe.tenantId !== parentA.tenantId, rowTenantMatches: probe.tenantId === foreign.tenant_id }, probe.tenantId !== parentA.tenantId && probe.tenantId === foreign.tenant_id);
    } catch (error) { check(c, "foreign.owner", "real credential for an existing foreign owner", "Auth admin + API", String(error?.message ?? error).slice(0, 200), false); }
  } else check(c, "foreign.owner", "a launcher-seeded owner of another tenant exists", "O-SQL users", "none", false);
  witnessBefore = await witness(q, parentA);
  workStatusBeforeMounted = (await q("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [parentA.tenantId, parentA.workId]))[0]?.status ?? null;
  setup.A = { tag: tagA, workId: parentA.workId, dealId: parentA.dealId, sessionId: acqA.sessionId, threadId: threadA.id, status: row?.status };
  setup.foreign = foreignRow;
});
const setupOk = Boolean(parentA && acqA && threadA?.id);
const rootA = parentA ? { entityType: "pe_deal", entityId: parentA.dealId } : null;
const rootB = parentB ? { entityType: "pe_deal", entityId: parentB.dealId } : null;
const ownerCreds = { email: env.TEST_OWNER_EMAIL, password: env.TEST_OWNER_PASSWORD };

/* ---------------------------------------------------------------- browser */
const watch = new RequestWatch();
let browser = null, context = null, page = null;
async function startBrowser() {
  const { chromium } = loadPlaywright(root);
  browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: browserTmp } });
  context = await newMountedContext(browser);
  page = await context.newPage();
  watch.attach(page, "main", authOrigin);
}

const normalise = (text, clock = false) => {
  let out = (text ?? "").replace(/Last successful scope read: \S+/g, "Last successful scope read: T");
  if (clock) out = out.replace(/ · expired; no fresh work is implied| · this is not a renewed allocation/g, "").replace(/within its time bounds|not currently within its time bounds/g, "VALIDITY");
  return out;
};
const signature = (f, clock = false) => sha({ work: f.appAttributes?.work, session: f.appAttributes?.session, status: f.appAttributes?.status,
  app: normalise(f.app?.text, clock), inst: normalise(f.inst?.text, clock), budget: f.budgetJson, charges: f.charges.map(item => item.text), costs: f.appCosts });
const coreSignature = f => sha({ work: f.appAttributes?.work, session: f.appAttributes?.session, status: f.appAttributes?.status, budget: f.budgetJson, charges: f.charges.map(item => item.text), costs: f.appCosts });
const instants = text => [...(text ?? "").matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g)].map(match => Date.parse(match[0]));
const minuteText = value => new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).replace(/[\u202f\u00a0]/g, " ");
const flat = text => (text ?? "").replace(/[\u202f\u00a0]/g, " ");
const jsonOf = text => { try { return JSON.parse(text); } catch { return null; } };
const hits = (haystack, markers) => markers.filter(marker => haystack.includes(marker.value)).map(marker => marker.label);
const strongLabels = new Set(["sessionId", "programId", "compilerRequestId", "responsibilityIdentity", "reservationId", "computeResource", "humanResource", "institutionId"]);
let referenceSignature = null, referenceCore = null, referenceTruthA = null, workStatusBeforeMounted = null;

async function ensureOwnerOnWork(which = "A") {
  const target = which === "A" ? { thread: threadA, parent: parentA, root: rootA } : { thread: threadB, parent: parentB, root: rootB };
  if (!(await page.locator(".ct-topbar").isVisible().catch(() => false))) await uiSignIn(page, ownerCreds.email, ownerCreds.password, watch);
  return openWork(page, target.thread.id, target.parent.workId, target.root);
}
const mutationsOf = (c, mark, allowed = 0) => {
  const summary = watch.summary(mark);
  c.observations.requests = summary;
  return check(c, "no-mutating-requests", `${allowed} mutating browser requests`, "browser request watch (page.on request)", { mutations: summary.mutations, otherNonGet: summary.otherNonGet, nonGet: summary.nonGetPaths }, summary.mutations === allowed && summary.otherNonGet === 0);
};

/* ---- M-01 */
await runCase("M-01", ["Z0-R08-C01", "Z0-R45-C01", "Z0-R09-C01"], "Reload shows original mandate/Work, terms, remaining resources, requested computation", async c => {
  if (!setupOk) notRun("M-00_PRECONDITIONS_NOT_MET");
  await startBrowser();
  const mark = watch.mark();
  const login = await uiSignIn(page, ownerCreds.email, ownerCreds.password, watch);
  const idp = login.bearer ? await idpUserId(env, login.bearer) : { status: 0, id: null };
  check(c, "identity.me", "browser /api/centropy/me carried a Bearer, answered 200 for the owner of the original tenant", "O-IDP /auth/v1/user + O-SQL",
    { meStatus: login.meStatus, role: login.identity?.role, tenantMatches: login.identity?.tenantId === parentA.tenantId, principalMatches: login.identity?.userId === parentA.ownerId, idpStatus: idp.status, idpIdEqualsNativePrincipal: idp.id === login.identity?.userId },
    login.meStatus === 200 && login.identity?.role === "owner" && login.identity?.tenantId === parentA.tenantId && login.identity?.userId === parentA.ownerId && idp.status === 200);
  const opened = await openWork(page, threadA.id, parentA.workId, rootA);
  c.observations.rootCarriedBy = opened.rootCarriedBy;
  const truth = await readOwnerTruth({ q, owner, parent: parentA, sessionId: acqA.sessionId, acquisitionInput: acqA.request });
  referenceTruthA = truth;
  check(c, "oracles.agree", "O-SQL and O-API agree before either is used as an expectation", "O-SQL vs O-API", truth.disagreements, truth.disagreements.length === 0);
  await waitForPanel(page, parentA.workId);
  const f0 = await readPanels(page);
  await shot(page, c, "open");
  await page.reload({ waitUntil: "domcontentloaded" }); await waitForPanel(page, parentA.workId);
  const f1 = await readPanels(page);
  await page.reload({ waitUntil: "domcontentloaded" }); await waitForPanel(page, parentA.workId);
  const f2 = await readPanels(page);
  await shot(page, c, "after-second-reload");
  c.observations.signatures = { f0: signature(f0), f1: signature(f1), f2: signature(f2) };
  referenceSignature = signature(f2);
  referenceCore = coreSignature(f2);

  const app = f2.app?.text ?? "";
  check(c, "positive-control.markers", "the DOM detector finds the markers while signed in", "harness", { found: hits(f2.html, truth.markers) },
    ["workId", "tenantId", "sessionId", "programId", "reservationId"].every(label => hits(f2.html, truth.markers).includes(label)));
  const store = await storageScan(page, context, truth.markers);
  check(c, "positive-control.storage", "the storage detector sees the Supabase session key while signed in", "harness", { supabaseSessionKeyPresent: store.supabaseSessionKeyPresent, areas: Object.fromEntries(Object.entries(store.result).map(([k, v]) => [k, { count: v.count ?? v.keys?.length }])) }, store.supabaseSessionKeyPresent);
  check(c, "1.work-root-tenant-principal", "data-application-work = Work; root pe_deal/deal; tenant and native principal of the owner", "O-SQL (fixture rows)",
    { attr: f2.appAttributes?.work, root: app.includes(`root pe_deal / ${parentA.dealId}`), tenant: app.includes(`Tenant ${parentA.tenantId} · native principal ${parentA.ownerId}`) },
    f2.appAttributes?.work === parentA.workId && app.includes(`root pe_deal / ${parentA.dealId}`) && app.includes(`Tenant ${parentA.tenantId} · native principal ${parentA.ownerId}`));
  const idsWanted = { programId: parentA.programId, compilerRequestId: parentA.compilerRequestId, responsibilityIdentity: parentA.responsibilityIdentity, reservationId: parentA.parentReservation.id, originalWorkInputId: parentA.workInputId };
  check(c, "2.original-identities", "programme, compiler request, responsibility identity, original reservation and Work input are shown", "O-SQL fixture rows",
    Object.fromEntries(Object.entries(idsWanted).map(([k, v]) => [k, app.includes(v)])), Object.values(idsWanted).every(v => app.includes(v)));
  const shownInstants = instants(f2.app?.textNoPre);
  const cutoffMatch = /Learning cutoff: (\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))/.exec(app);
  const apiInst = truth.api.session?.institutional;
  const cutoff = cutoffMatch ? Date.parse(cutoffMatch[1]) : NaN;
  const orig = Date.parse(truth.episode.originalDeadlineAt), wall = Date.parse(truth.episode.wallDeadlineAt);
  check(c, "3.deadlines", "original, wall deadline and learning cutoff shown as the owner instants; cutoff <= both", "O-SQL x1_compiler_episodes + O-API institutional.childDeadlineAt",
    { original: shownInstants.includes(orig), wall: shownInstants.includes(wall), cutoffMatchesApi: cutoff === Date.parse(apiInst?.childDeadlineAt), cutoffWithin: cutoff <= orig && cutoff <= wall, sqlSessionDeadlineEqualsCutoff: Date.parse(truth.session.deadlineAt) === cutoff },
    shownInstants.includes(orig) && shownInstants.includes(wall) && cutoff === Date.parse(apiInst?.childDeadlineAt) && cutoff <= orig && cutoff <= wall);
  const budget = jsonOf(f2.budgetJson);
  const shownBudget = (budget?.resources ?? []).map(r => ({ resourceId: r.resourceId, unit: r.unit, limit: r.limit, used: r.used, remaining: r.remaining }));
  check(c, "4.remaining-resources", "remaining per resource = limit - sum(charges) of the original reservation; no new reservation, no release", "O-SQL s5_reservations + s5_governed_resource_charges",
    { shownBudget, expected: truth.budget, newReservation: budget?.newReservation, releaseGranted: budget?.releaseGranted }, JSON.stringify(shownBudget) === JSON.stringify(truth.budget) && budget?.newReservation === false && budget?.releaseGranted === false);

  const rules = truth.api.institution?.artifact?.obligation_derivation_rules ?? [];
  const rows = f2.instRows;
  const rule5a = rules.length > 0 && rows.length === rules.length && rules.every((rule, index) => flat(rows[index]?.[1]) === minuteText(rule.originalDeadline))
    && (truth.program.executable > 0 || rows.every(row => /Exact decision required/.test(row[2] ?? "")));
  const gap = (id, predicate) => { c.gaps.push({ id, predicate }); };
  if (!check(c, "5a.mandate-responsibility-rows", "one responsibility row per mandate rule with its original deadline and independent-completion state", "O-API institution-read obligation_derivation_rules + O-SQL p1_programs",
    { rows, rules: rules.map(rule => ({ op: rule.permissibleOperationClass, deadline: rule.originalDeadline })), executableNodes: truth.program.executable }, rule5a)) gap("5a", "UI_GAP_MANDATE_OR_REQUESTED_COMPUTATION_NOT_SHOWN");
  const demand = truth.request.resourceDemand ?? [];
  const demandFound = [];
  for (const item of demand) demandFound.push(await elementWith(page, `${APP},${INST}`, [item.resourceId, String(item.amount)], "request|demand"));
  if (!check(c, "5b.requested-resource-demand", "requested demand per resource (resource id and amount) is shown on the Work outside raw JSON", `${truth.request.sourceOfValues}`,
    { demand, found: demandFound }, demand.length > 0 && demandFound.every(Boolean))) gap("5b", "UI_GAP_MANDATE_OR_REQUESTED_COMPUTATION_NOT_SHOWN");
  const targets = truth.request.targets ?? [];
  const targetsFound = [];
  for (const target of targets) targetsFound.push(await elementWith(page, `${APP},${INST}`, [String(target.id)], "."));
  if (!check(c, "5c.requested-targets", "each requested discovery target identity is shown outside raw JSON", truth.request.sourceOfValues,
    { count: targets.length, found: targetsFound.map(Boolean) }, targets.length > 0 && targetsFound.every(Boolean))) gap("5c", "UI_GAP_MANDATE_OR_REQUESTED_COMPUTATION_NOT_SHOWN");
  const requestedDeadline = truth.request.deadlineAt ? Date.parse(truth.request.deadlineAt) : NaN;
  if (!check(c, "5d.requested-deadline", "the requested deadline instant is shown outside raw JSON", truth.request.sourceOfValues,
    { requested: truth.request.deadlineAt, shown: shownInstants.includes(requestedDeadline) }, shownInstants.includes(requestedDeadline))) gap("5d", "UI_GAP_MANDATE_OR_REQUESTED_COMPUTATION_NOT_SHOWN");

  check(c, "6.no-predicted-completion", "status attribute = owner status; no COMPLETED anywhere; MODEL_READY says a fresh native binding is still required; no effect VERIFIED without observation", "O-SQL sessions + panel label contract",
    { attr: f2.appAttributes?.status, owner: truth.session.status, completedShown: /\bCOMPLETED\b/.test(f2.html.replace(/<[^>]*>/g, " ")), effects: f2.appEffects.length },
    f2.appAttributes?.status === truth.session.status && !/\bCOMPLETED\b/.test(app) && (truth.session.status !== "MODEL_READY" || /fresh native binding is still required/.test(app))
      && f2.appEffects.every(effect => effect.state !== "VERIFIED" || !/No independent observation reference supplied/.test(effect.text)));
  check(c, "7.reload-stable", "fact set after reload 2 equals reload 1", "DOM facts", { f1: signature(f1), f2: signature(f2) }, signature(f1) === signature(f2));
  mutationsOf(c, mark);
  c.observations.truthSha256 = truth.truthSha256;
});

/* ---- M-02 */
await runCase("M-02", ["Z0-R08-C02", "Z0-R45-C03"], "S5/S6/S7 accounting, producer/checker/consumer, observation, no predicted completion", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  const mark = watch.mark();
  await ensureOwnerOnWork("A");
  await page.reload({ waitUntil: "domcontentloaded" }); await waitForPanel(page, parentA.workId);
  const f = await readPanels(page);
  await shot(page, c, "accounting");
  const truth = await readOwnerTruth({ q, owner, parent: parentA, sessionId: acqA.sessionId, acquisitionInput: acqA.request });
  const app = f.app?.text ?? "";
  const after = await witness(q, parentA);
  check(c, "1.same-parent", "reservation shown = original reservation; reservation count and envelope digest unchanged by the mounted phase", "O-SQL s5_reservations before/after",
    { shown: app.includes(truth.reservation.id), before: witnessBefore.reservations, after: after.reservations }, app.includes(truth.reservation.id) && witnessBefore.reservations.count === after.reservations.count && witnessBefore.reservations.digest === after.reservations.digest);
  const dom = f.charges.map(item => { const m = /Charged units: (\d+) \S+\. Original limit: \S+\. Cumulative original occupation after this charge: (\d+)/.exec(item.text); const r = /resource (\S+)$/.exec(item.heading); return m && r ? `${r[1]}|${m[1]}|${m[2]}` : item.text.slice(0, 80); }).sort();
  const own = truth.charges.map(row => `${row.resourceId}|${row.units}|${row.usedAfter}`).sort();
  check(c, "2.charges", "charge records shown (count, units, cumulative occupation) = O-SQL running sums; money/human/peak bytes UNKNOWN", "O-SQL s5_governed_resource_charges",
    { shownCount: f.charges.length, ownerCount: own.length, headingCount: new RegExp(`Original resource charges · ${own.length} supplied records`).test(app), equal: JSON.stringify(dom) === JSON.stringify(own), costs: f.appCosts },
    own.length > 0 && JSON.stringify(dom) === JSON.stringify(own) && new RegExp(`Original resource charges · ${own.length} supplied records`).test(app) && ["money", "humanSeconds", "aggregatePeakBytes"].every(key => f.appCosts[key] === "UNKNOWN"));
  const api = truth.api.session;
  const accepted = api?.check?.acceptedOperationIds ?? [];
  const acceptedShown = /Accepted operation IDs: (.*?)\. Check: /.exec(app)?.[1];
  check(c, "3.producer-checker-consumer", "model (producer), independent check and checker, accepted operations, S4 acceptance (consumer) and original-P1 consumption flag shown", "O-API application-projection + O-SQL events/p1_events",
    { model: api?.model ? app.includes(api.model.ref.id) : null, check: api?.check ? app.includes(api.check.ref.id) : null, checker: api?.check ? app.includes(api.check.checkerRef.id) : null,
      disposition: api?.check ? app.includes(`Check disposition: ${api.check.disposition}`) : null, acceptedCount: acceptedShown ? acceptedShown.split(", ").length : 0, ownerAccepted: accepted.length,
      acceptance: truth.acceptanceRefId ? app.includes(truth.acceptanceRefId) : null, consumed: app.includes(`Original P1 consumed the checked model: ${truth.consumedByOriginalP1 ? "yes" : "not observed"}`) },
    Boolean(api?.model && api?.check) && app.includes(api.model.ref.id) && app.includes(api.check.ref.id) && app.includes(api.check.checkerRef.id) && app.includes(`Check disposition: ${api.check.disposition}`)
      && (acceptedShown ? acceptedShown.split(", ").length : 0) === accepted.length && Boolean(truth.acceptanceRefId) && app.includes(truth.acceptanceRefId)
      && app.includes(`Original P1 consumed the checked model: ${truth.consumedByOriginalP1 ? "yes" : "not observed"}`));
  const states = f.appEffects.map(effect => effect.state).sort();
  const ownerStates = truth.requests.map(row => row.status).sort();
  check(c, "4.effects-and-observation", "effect cards = owner request rows; each state equals the row status; observation reference shown iff stored; none VERIFIED without observation", "O-SQL application_semantics_requests",
    { shown: states, owner: ownerStates, noRecordsText: truth.requests.length === 0 ? /No effect records supplied/.test(app) : null },
    JSON.stringify(states) === JSON.stringify(ownerStates) && (truth.requests.length > 0 || /No effect records supplied/.test(app)) && f.appEffects.every(effect => (effect.state !== "VERIFIED") || !/No independent observation reference supplied/.test(effect.text)));
  const counters = api?.check?.counterexamples ?? [];
  const shownCounters = jsonOf(f.counterexamplesJson);
  check(c, "5.counterexamples-and-composition", "counterexamples shown = check body count; absent composition stated as 'No checked composition', not as success", "O-API application-projection",
    { owner: counters.length, shown: Array.isArray(shownCounters) ? shownCounters.length : (counters.length === 0 ? /No counterexamples supplied/.test(app) : null), composition: api?.composition ? "present" : /No checked composition supplied/.test(app) },
    (counters.length === 0 ? /No counterexamples supplied/.test(app) : Array.isArray(shownCounters) && shownCounters.length === counters.length) && (api?.composition ? true : /No checked composition supplied/.test(app)));
  check(c, "6.original-completion-owner", "the panel says learning does not complete the responsibility; the original Work status is unchanged by the mounted phase", "O-SQL works.status before/after",
    { text: /Learning never fulfills the responsibility/.test(app), before: workStatusBeforeMounted, after: truth.workStatus }, /Learning never fulfills the responsibility/.test(app) && workStatusBeforeMounted !== null && workStatusBeforeMounted === truth.workStatus);
  mutationsOf(c, mark);
});

/* ---- M-03 */
await runCase("M-03", ["Z0-R45-C02"], "Claim basis classes are distinguishable and equal the native class", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  const mark = watch.mark();
  await ensureOwnerOnWork("A");
  const f = await readPanels(page);
  const truth = referenceTruthA;
  const art = truth.api.institution?.artifact;
  const instCounts = f.instCounts;
  check(c, "institution.class-counts", "Observed originals / Inferred mappings / Unresolved interpretations counts equal the compiler artifact", "O-API institution-read artifact",
    { shown: instCounts, owner: { observed: art?.envelope?.observed_claims?.length, inferred: art?.envelope?.inferred_claims?.length, unresolved: art?.unresolved_interpretations?.length } },
    Boolean(art) && instCounts["Observed originals"] === String(art.envelope.observed_claims.length) && instCounts["Inferred mappings"] === String(art.envelope.inferred_claims.length) && instCounts["Unresolved interpretations"] === String(art.unresolved_interpretations.length));
  if (!truth.claims.length) { c.observations.claimCounts = truth.claimCounts; notRun("NO_CLAIM_ENTRIES_IN_OWNER_MODEL_ENVELOPE"); }
  const probe = await claimLabelProbe(page, truth.claims);
  const re = { observed: /observ|sourc/i, inferred: /infer/i, predicted: /predict/i, unresolved: /unresolved|unknown/i };
  const labelled = probe.map(item => ({ ...item, ok: item.foundOutsidePre && (item.ancestorClass === item.cls || (item.nearestHeading && re[item.cls].test(item.nearestHeading) && !Object.entries(re).some(([k, r]) => k !== item.cls && r.test(item.nearestHeading)))) }));
  const perClass = Object.fromEntries(Object.keys(re).map(k => [k, { owner: truth.claims.filter(x => x.cls === k).length, labelledCorrectly: labelled.filter(x => x.cls === k && x.ok).length }]));
  if (!check(c, "claims.per-entry-class-label", "every claim entry of the owner envelope is shown outside raw JSON under a distinct label equal to its native class (observed/inferred/predicted/unresolved)", "O-API application-projection model.envelope",
    { perClass, entries: labelled.map(({ cls, foundOutsidePre, ancestorClass, nearestHeading, ok }) => ({ cls, foundOutsidePre, ancestorClass, nearestHeading, ok })) }, labelled.every(item => item.ok))) c.gaps.push({ id: "claims", predicate: "UI_GAP_CLAIM_CLASS_NOT_DISTINGUISHABLE" });
  const inPre = (f.app?.pres ?? []).some(text => /"observedClaims"/.test(text));
  c.observations.claimsOnlyInRawJson = inPre && labelled.every(item => !item.foundOutsidePre);
  await shot(page, c, "claims");
  mutationsOf(c, mark);
});

/* ---- M-04 */
await runCase("M-04", ["Z0-R45-C03", "Z0-R09-C01"], "Blocked/needs-action state survives reload (B: revoked acquisition)", async c => {
  if (!setupOk || !parentB || !threadB?.id) notRun("PARENT_B_NOT_AVAILABLE");
  if (!page) notRun("BROWSER_NOT_STARTED");
  if (!setup.B?.raceReached || !TERMINAL.includes(setup.B.final?.status) || setup.B.final.status === "MODEL_READY") notRun("REVOCATION_RACE_NOT_REACHED");
  const mark = watch.mark();
  const opened = await ensureOwnerOnWork("B");
  c.observations.rootCarriedBy = opened.rootCarriedBy;
  const truth = await readOwnerTruth({ q, owner, parent: parentB, sessionId: sessionB, acquisitionInput: acquisitionB });
  const f0 = await readPanels(page);
  await page.reload({ waitUntil: "domcontentloaded" }); await waitForPanel(page, parentB.workId);
  const f1 = await readPanels(page);
  await shot(page, c, "blocked");
  const app = f1.app?.text ?? "";
  const nextAction = Boolean(await page.locator(`${APP} [data-application-next-action]`).count()) || /(next action|owner must|you must|re-?authori[sz]e|re-?enable|restore the|grant again)/i.test(f1.app?.textNoPre ?? "");
  check(c, "owner.state", "B's session is terminal and not MODEL_READY with a database reason; B's original programme unchanged", "O-SQL sessions/p1_requests",
    { status: truth.session.status, reason: truth.session.reason }, TERMINAL.includes(truth.session.status) && truth.session.status !== "MODEL_READY");
  check(c, "dom.state-and-reason", "after open and after reload the Work shows the owner status attribute and the owner reason; no MODEL_READY or COMPLETED", "O-SQL sessions",
    { attr0: f0.appAttributes?.status, attr1: f1.appAttributes?.status, reasonShown: truth.session.reason ? app.includes(`Reason: ${truth.session.reason}`) : /No reason supplied/.test(app) },
    f0.appAttributes?.status === truth.session.status && f1.appAttributes?.status === truth.session.status && (truth.session.reason ? app.includes(`Reason: ${truth.session.reason}`) : true) && !/\bCOMPLETED\b|Logical model available/.test(app));
  check(c, "dom.no-allowance-reset-form", "no acquisition form that could renew the allowance is offered", "panel contract (acquire form absent when a session exists)",
    { acquireButtons: f1.app?.buttons.filter(b => /Request learning under original reservation|Request acquisition and native reservation/.test(b.name)).length }, (f1.app?.buttons ?? []).every(b => !/Request learning under original reservation|Request acquisition and native reservation/.test(b.name)));
  if (!check(c, "dom.next-action-stated", "the missing predicate and who acts next are stated for the blocked state", "O-SQL reason + product contract (blocked needs-action)",
    { reasonShown: truth.session.reason ? app.includes(truth.session.reason) : null, nextActionStated: nextAction }, nextAction)) c.gaps.push({ id: "next-action", predicate: "UI_GAP_BLOCKED_STATE_NOT_ACTIONABLE" });
  check(c, "reload-stable", "fact set after reload equals the set before it", "DOM facts", { f0: signature(f0), f1: signature(f1) }, signature(f0) === signature(f1));
  mutationsOf(c, mark);
});

/* ---- M-05 */
await runCase("M-05", ["Z0-R09-C02", "Z0-R45-C04"], "Work/root switch through the real Investigations drawer", async c => {
  if (!referenceTruthA || !parentB || !threadB?.id) notRun("PARENT_A_OR_B_NOT_AVAILABLE");
  const mark = watch.mark();
  await ensureOwnerOnWork("A");
  const truthB = await readOwnerTruth({ q, owner, parent: parentB, sessionId: sessionB, acquisitionInput: acquisitionB });
  const aOnly = referenceTruthA.markers.filter(marker => !truthB.markers.some(other => other.value === marker.value));
  const select = async thread => {
    await page.getByRole("button", { name: "Investigations", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Recent Investigations", exact: true });
    const control = drawer.locator("ol li button").filter({ has: drawer.getByText(thread.title, { exact: true }) });
    if (await control.count() !== 1) throw Error("DRAWER_CONTROL_COUNT_" + await control.count());
    await control.focus(); await control.press("Enter");
    await page.waitForURL(url => url.pathname === "/centropy/investigations/" + thread.id, { timeout: 30000 });
  };
  await select(threadB);
  const markB = watch.mark();
  let mountedB = true;
  try { await waitForPanel(page, parentB.workId, 45000); } catch { mountedB = false; }
  const fb = await readPanels(page);
  await shot(page, c, "after-switch-to-B");
  check(c, "B.mounted-with-own-root", "after the drawer switch the panel is B's: its own Work attribute, root and ids", "O-SQL B rows",
    { mounted: mountedB, work: fb.appAttributes?.work, rootShown: (fb.app?.text ?? "").includes(`root pe_deal / ${parentB.dealId}`) },
    mountedB && fb.appAttributes?.work === parentB.workId && (fb.app?.text ?? "").includes(`root pe_deal / ${parentB.dealId}`));
  check(c, "A.absent-under-B", "no panel of the original Work and none of A's distinguishing private values anywhere in the DOM", "O-SQL A rows (values not shared with B)",
    { panelsOfA: await panelFor(page, parentA.workId).count(), leaked: hits(fb.html, aOnly.filter(m => m.label !== "ownerId")) }, await panelFor(page, parentA.workId).count() === 0 && hits(fb.html, aOnly.filter(m => m.label !== "ownerId")).length === 0);
  const projB = watch.since(markB).filter(row => row.path.endsWith("application-projection"));
  check(c, "only-B-projection-requests", "after the switch every projection request names B's Work", "browser request watch", projB.map(r => (r.workId === parentB.workId ? "B" : r.workId === parentA.workId ? "A" : r.workId)),
    projB.length >= 1 && projB.every(row => row.workId === parentB.workId));
  const mark2 = watch.mark();
  await select(threadA);
  let mountedA = true;
  try { await waitForPanel(page, parentA.workId, 45000); } catch { mountedA = false; }
  const fa = await readPanels(page);
  await watch.settle();
  const reread = watch.since(mark2).filter(row => row.path.endsWith("application-projection") && row.workId === parentA.workId);
  await shot(page, c, "back-on-A");
  check(c, "A.restored-from-fresh-read", "returning to A issues a fresh projection read for A and the facts equal the earlier A facts", "browser request watch + M-01 reference signature",
    { mountedA, freshReads: reread.length, signatureEqual: signature(fa) === referenceSignature, panelsOfB: await panelFor(page, parentB.workId).count() },
    mountedA && reread.length >= 1 && signature(fa) === referenceSignature && await panelFor(page, parentB.workId).count() === 0);
  mutationsOf(c, mark);
});

/* ---- M-09 */
await runCase("M-09", ["Z0-R09-C05"], "Offline then reconnect", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  await ensureOwnerOnWork("A");
  await waitForPanel(page, parentA.workId);
  const before = await witness(q, parentA);
  const markers = referenceTruthA.markers;
  const strong = markers.filter(marker => strongLabels.has(marker.label));
  const mark = watch.mark();
  await context.setOffline(true);
  await waitUntil("OFFLINE_BOUNDARY", 20000, async () => /Offline or hidden view/.test((await page.locator(APP).first().innerText().catch(() => "")) ?? ""));
  const f = await readPanels(page);
  await shot(page, c, "offline");
  const offlineStore = await storageScan(page, context, markers);
  const appHaystack = (f.app?.text ?? "") + " " + (f.app?.pres ?? []).join(" ");
  check(c, "offline.boundary", "while offline the panel shows the offline boundary and hides private evidence; no panel private value", "panel contract + O-SQL markers",
    { boundary: /Offline or hidden view/.test(f.app?.text ?? ""), panelLeaks: hits(appHaystack, markers) }, /Offline or hidden view/.test(f.app?.text ?? "") && hits(appHaystack, markers).length === 0);
  check(c, "offline.page-level-private-values", "no application-private value (session, programme, compiler request, responsibility, reservation, resources) anywhere in the page DOM while offline", "O-SQL markers",
    { hits: hits(f.html, strong) }, hits(f.html, strong).length === 0);
  check(c, "offline.no-operable-mutating-control", "no enabled mutating control in the application panel while offline", "DOM", f.app?.buttons, (f.app?.buttons ?? []).every(b => b.disabled));
  check(c, "offline.storage-clean", "no application-private value in any browser storage while offline", "storage scan", Object.fromEntries(Object.entries(offlineStore.result).map(([k, v]) => [k, v.markerHits ?? []])), offlineStore.markerHitCount === 0);
  const offlineRequests = watch.since(mark).filter(row => row.kind !== "read" && row.kind !== "read-post");
  check(c, "offline.no-writes-emitted", "no non-GET request is emitted while offline", "browser request watch", offlineRequests.map(row => `${row.method} ${row.path}`), offlineRequests.length === 0);
  const mark2 = watch.mark();
  await context.setOffline(false);
  await waitForPanel(page, parentA.workId, 60000);
  await watch.settle();
  const fresh = watch.since(mark2).filter(row => row.path.endsWith("application-projection") && row.workId === parentA.workId);
  const after = await readPanels(page);
  const afterWitness = await witness(q, parentA);
  await shot(page, c, "reconnected");
  check(c, "reconnect.fresh-read-and-facts", "after reconnect a fresh projection request is observed and the facts equal the earlier ones", "browser request watch + M-01 reference signature",
    { freshReads: fresh.length, signatureEqual: signature(after) === referenceSignature }, fresh.length >= 1 && signature(after) === referenceSignature);
  check(c, "reconnect.no-replay", "no queued request replays: owner witness (sessions, cancel requests, requests, charges) unchanged", "O-SQL witness before/after",
    { before: { sessions: before.sessions, requests: before.requests, charges: before.charges }, after: { sessions: afterWitness.sessions, requests: afterWitness.requests, charges: afterWitness.charges } },
    JSON.stringify([before.sessions, before.requests, before.charges]) === JSON.stringify([afterWitness.sessions, afterWitness.requests, afterWitness.charges]));
  mutationsOf(c, mark);
});

/* ---- M-08 */
await runCase("M-08", ["Z0-R09-C04", "Z0-R45-C04"], "Real logout then new sign-in", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  await ensureOwnerOnWork("A");
  await waitForPanel(page, parentA.workId);
  const markers = referenceTruthA.markers;
  const prior = await storageScan(page, context, markers);
  await watch.settle();
  const oldBearer = watch.lastBearer(row => row.path === "/api/centropy/me") ?? prior.accessToken;
  const secrets = [{ label: "previousAccessToken", value: oldBearer }, { label: "previousAccessTokenInStorage", value: prior.accessToken }, { label: "previousRefreshToken", value: prior.refreshToken }];
  check(c, "positive-control.session-present", "before logout the storage detector sees the Supabase session and the previous tokens", "harness", { sessionKey: prior.supabaseSessionKeyPresent, refreshTokenFound: Boolean(prior.refreshToken) }, prior.supabaseSessionKeyPresent && Boolean(prior.refreshToken));
  const mark = watch.mark();
  await uiSignOut(page);
  await watch.settle();
  const rows = watch.since(mark);
  const f = await readPanels(page);
  await shot(page, c, "signed-out");
  check(c, "positive-control.sign-out-observed", "the request watch recorded the real sign-out end-delivery POST and the Auth logout", "browser request watch",
    { signOut: rows.filter(r => r.kind === "sign-out").map(r => r.status), logout: rows.filter(r => r.kind === "auth-logout").map(r => r.status) },
    rows.some(r => r.kind === "sign-out") && rows.some(r => r.kind === "auth-logout"));
  const store = await storageScan(page, context, markers, secrets);
  check(c, "after.dom-clean", "no panel and none of the original private values in the DOM after logout", "O-SQL markers", { panels: f.applicationCount, leaked: hits(f.html, markers) }, f.applicationCount === 0 && hits(f.html, markers).length === 0);
  check(c, "after.storage-clean", "no private marker, previous access token or refresh token in any storage after logout", "storage scan (booleans only)",
    { sessionKeyPresent: store.supabaseSessionKeyPresent, areas: Object.fromEntries(Object.entries(store.result).map(([k, v]) => [k, { markers: v.markerHits ?? [], secrets: v.secretHits ?? [] }])) },
    store.markerHitCount === 0 && store.secretHitCount === 0 && !store.supabaseSessionKeyPresent);
  const replay = await refreshGrantStatus(env, prior.refreshToken ?? "missing"); costs.nodeAuthGrants++;
  check(c, "after.refresh-token-replay-refused", "replaying the old refresh token against the real Auth is refused (non-200)", "O-IDP /auth/v1/token", { status: replay }, replay !== 200);
  const oldUser = oldBearer ? await idpUserId(env, oldBearer) : null;
  c.observations.oldAccessTokenAtIdpAfterLogout = oldUser?.status ?? null;
  const mark2 = watch.mark();
  const login = await uiSignIn(page, ownerCreds.email, ownerCreds.password, watch);
  await openWork(page, threadA.id, parentA.workId, rootA);
  await waitForPanel(page, parentA.workId);
  await watch.settle();
  const reads = watch.since(mark2).filter(row => row.path.endsWith("application-projection") && row.workId === parentA.workId);
  const fresh = await readPanels(page);
  await shot(page, c, "signed-in-again");
  check(c, "again.new-token-and-fresh-read", "the new sign-in carries a different access token, a new projection read is observed and the facts equal the earlier ones", "browser request watch + M-01 reference signature",
    { newToken: Boolean(login.bearer) && login.bearer !== oldBearer, freshReads: reads.length, signatureEqual: signature(fresh) === referenceSignature },
    Boolean(login.bearer) && login.bearer !== oldBearer && reads.length >= 1 && signature(fresh) === referenceSignature);
  mutationsOf(c, mark);
});

/* ---- M-06 */
await runCase("M-06", ["Z0-R09-C02", "Z0-R09-C04", "Z0-R45-C04"], "Principal switch: logout, then a different real owner", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  if (!foreignCreds) notRun("FOREIGN_OWNER_NOT_SEEDED");
  await ensureOwnerOnWork("A");
  await waitForPanel(page, parentA.workId);
  const markers = [...referenceTruthA.markers, { label: "threadTitle", value: threadA.title }];
  const prior = await storageScan(page, context, markers);
  await watch.settle();
  const oldBearer = watch.lastBearer(row => row.path === "/api/centropy/me") ?? prior.accessToken;
  const secrets = [{ label: "previousAccessToken", value: oldBearer }, { label: "previousRefreshToken", value: prior.refreshToken }];
  const mark = watch.mark();
  await uiSignOut(page);
  const login = await uiSignIn(page, foreignCreds.email, foreignCreds.password, watch);
  check(c, "foreign.identity", "the foreign real owner's /api/me names a different tenant and principal", "O-SQL users + browser /api/centropy/me",
    { tenantDiffers: login.identity?.tenantId !== parentA.tenantId, principalDiffers: login.identity?.userId !== parentA.ownerId, rowMatches: login.identity?.userId === foreignRow.userId }, login.identity?.tenantId !== parentA.tenantId && login.identity?.userId !== parentA.ownerId && login.identity?.userId === foreignRow.userId);
  await page.goto(workUrl(threadA.id), { waitUntil: "domcontentloaded", timeout: 120000 });
  await sleep(6000);
  const f = await readPanels(page);
  await shot(page, c, "foreign-on-original-url");
  const store = await storageScan(page, context, markers, secrets);
  const nodeForeign = await signInOwner(env, foreignCreds); costs.nodeAuthGrants++;
  const denied = await nodeForeign.operation("application-projection", { root: rootA, workId: parentA.workId });
  const deniedWork = await nodeForeign.call(`/api/works/${parentA.workId}`);
  check(c, "foreign.dom-clean", "the original Work's panel count is 0 and no original private value (including the thread title) is in the DOM", "O-SQL markers",
    { panels: f.applicationCount, leaked: hits(f.html, markers.filter(m => m.label !== "threadId")) }, f.applicationCount === 0 && hits(f.html, markers).length === 0);
  check(c, "foreign.storage-clean", "no original private value and no previous token in any storage", "storage scan", { markers: store.markerHitCount, secrets: store.secretHitCount }, store.markerHitCount === 0 && store.secretHitCount === 0);
  check(c, "foreign.owner-read-refused", "the original Work's projection and Work read made with the foreign owner's own bearer are refused", "O-API (Node-side grant of the foreign owner)",
    { projection: denied.status, work: deniedWork.status }, [403, 404].includes(denied.status) && [403, 404].includes(deniedWork.status));
  await uiSignOut(page);
  const back = await uiSignIn(page, ownerCreds.email, ownerCreds.password, watch);
  const mark2 = watch.mark();
  await openWork(page, threadA.id, parentA.workId, rootA);
  await waitForPanel(page, parentA.workId);
  await watch.settle();
  const reads = watch.since(mark2).filter(row => row.path.endsWith("application-projection") && row.workId === parentA.workId);
  const restored = await readPanels(page);
  check(c, "restore.fresh-read", "after the original owner signs in again the facts equal the earlier ones from a fresh read", "browser request watch + M-01 reference signature",
    { freshReads: reads.length, signatureEqual: signature(restored) === referenceSignature, tokenDiffers: back.bearer !== oldBearer }, reads.length >= 1 && signature(restored) === referenceSignature && back.bearer !== oldBearer);
  mutationsOf(c, mark);
});

/* ---- M-07 */
await runCase("M-07", ["Z0-R09-C03", "Z0-R45-C04"], "Token refresh (real Auth refresh triggered by the browser clock)", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  const clockContext = await newMountedContext(browser);
  const clockPage = await clockContext.newPage();
  const clockWatch = new RequestWatch();
  clockWatch.attach(clockPage, "clock", authOrigin);
  try {
    await clockPage.clock.install({ time: new Date() });
    await uiSignIn(clockPage, ownerCreds.email, ownerCreds.password, clockWatch);
    await openWork(clockPage, threadA.id, parentA.workId, rootA);
    await waitForPanel(clockPage, parentA.workId);
    await clockWatch.settle();
    const before = await storageScan(clockPage, clockContext, referenceTruthA.markers);
    const beforeTag = before.accessToken ? sha(before.accessToken).slice(0, 12) : null;
    const lastReadTag = clockWatch.records.filter(r => r.path.endsWith("application-projection")).at(-1)?.bearerTag ?? null;
    const mark = clockWatch.mark();
    await clockPage.clock.fastForward(3520 * 1000);
    const refresh = await waitUntil("REFRESH_NOT_OBSERVED", 60000, async () => {
      const rows = clockWatch.since(mark).filter(row => row.kind === "auth-token" && /grant_type=refresh_token/.test(row.query) && row.status !== undefined);
      return rows.length ? rows : null;
    }, 500).catch(() => null);
    check(c, "refresh.observed", "the browser performed a real refresh_token grant against the real Auth and it answered 200", "browser request watch (page.on) + O-IDP",
      { requests: refresh?.map(row => ({ status: row.status, path: row.path })) ?? [] }, Boolean(refresh) && refresh.every(row => row.status === 200));
    await sleep(2000);
    await clockWatch.settle();
    const after = await storageScan(clockPage, clockContext, referenceTruthA.markers);
    const afterTag = after.accessToken ? sha(after.accessToken).slice(0, 12) : null;
    const idp = after.accessToken ? await idpUserId(env, after.accessToken) : { status: 0 };
    check(c, "refresh.new-token", "the stored access token changed to a new one that the real Auth accepts", "storage scan (hash tags only) + O-IDP /auth/v1/user", { beforeTag, afterTag, idpStatus: idp.status }, Boolean(afterTag) && afterTag !== beforeTag && idp.status === 200);
    const reread = await waitUntil("REREAD_AFTER_REFRESH", 45000, async () => {
      await clockWatch.settle();
      return clockWatch.since(mark).find(row => row.path.endsWith("application-projection") && row.workId === parentA.workId && row.bearerTag && row.bearerTag !== lastReadTag && row.status === 200);
    }, 1000).catch(() => null);
    check(c, "refresh.panel-reread-under-new-token", "the panel re-reads under the new token without any click", "browser request watch", { lastReadTag, newReadTag: reread?.bearerTag ?? null }, Boolean(reread));
    const f = await readPanels(clockPage);
    await shot(clockPage, c, "after-refresh");
    check(c, "refresh.facts-equal", "Work, session, status, remaining resources, charges and cost cells equal the M-01 facts (the page clock is advanced, so clock-dependent phrases are not compared)", "M-01 reference core signature + O-SQL",
      { equal: coreSignature(f) === referenceCore, work: f.appAttributes?.work }, f.appAttributes?.work === parentA.workId && coreSignature(f) === referenceCore);
    c.observations.fullSignatureEqualsReference = signature(f) === referenceSignature;
    const summary = clockWatch.summary(mark);
    c.observations.requests = summary;
    check(c, "no-mutating-requests", "0 mutating browser requests; every observed refresh is a real 200 grant", "browser request watch", { mutations: summary.mutations, otherNonGet: summary.otherNonGet, authToken: summary.authToken }, summary.mutations === 0 && summary.otherNonGet === 0);
  } finally { await clockContext.close().catch(() => undefined); }
});

/* ---- M-10 */
await runCase("M-10", ["Z0-R09-C06"], "Delayed old-principal response (owned database lock hold)", async c => {
  if (!referenceTruthA) notRun("M-01_DID_NOT_READ_THE_ORIGINAL_WORK");
  if (!foreignCreds) notRun("FOREIGN_OWNER_NOT_SEEDED");
  await ensureOwnerOnWork("A");
  await waitForPanel(page, parentA.workId);
  const markers = [...referenceTruthA.markers, { label: "threadTitle", value: threadA.title }];
  const prior = await storageScan(page, context, markers);
  const secrets = [{ label: "previousRefreshToken", value: prior.refreshToken }];
  const lock = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
  await lock.connect();
  let released = null;
  const release = async by => { if (released) return; released = { by, atMs: Date.now() - tLock }; await lock.query("COMMIT").catch(() => undefined); };
  let tLock = Date.now();
  try {
    await lock.query("BEGIN");
    await lock.query("SET LOCAL lock_timeout='15s'");
    await lock.query("LOCK TABLE finnor_os.application_semantics_sessions IN ACCESS EXCLUSIVE MODE");
    const lockPid = (await lock.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    tLock = Date.now();
    const timer = setTimeout(() => void release("TIMER_BEFORE_PROXY_BUDGET"), 14000);
    const mark = watch.mark();
    await page.getByRole("button", { name: "Refresh current scope", exact: true }).click();
    const hold = await waitUntil("HOLD_NOT_IN_FLIGHT", 12000, async () => (await q(
      "SELECT pid,state,wait_event_type,left(query,120) query FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%application_semantics_sessions%' LIMIT 1", [lockPid]))[0], 250).catch(() => null);
    const inflight = watch.since(mark).filter(row => row.path.endsWith("application-projection") && row.workId === parentA.workId);
    check(c, "hold.in-flight", "a Postgres backend is waiting on the lock with the sessions query and the browser's projection request has no response yet", "O-SQL pg_stat_activity + browser request watch",
      { waiting: hold ? { state: hold.state, waitEventType: hold.wait_event_type } : null, requests: inflight.map(r => ({ status: r.status ?? null, failure: r.failure ?? null })) },
      Boolean(hold) && inflight.length >= 1 && inflight.every(row => row.status === undefined));
    await uiSignOut(page);
    const signedOutAt = Date.now() - tLock;
    const login = await uiSignIn(page, foreignCreds.email, foreignCreds.password, watch);
    const foreignAt = Date.now() - tLock;
    await release("FOREIGN_SIGNED_IN"); clearTimeout(timer);
    const f1 = await readPanels(page);
    await sleep(5000);
    await watch.settle();
    const f2 = await readPanels(page);
    await shot(page, c, "foreign-after-release");
    const old = watch.since(mark).filter(row => row.path.endsWith("application-projection") && row.workId === parentA.workId);
    c.observations.oldRequestOutcome = old.map(row => ({ status: row.status ?? null, failure: row.failure ?? null }));
    c.observations.timeline = { signedOutAtMs: signedOutAt, foreignSignedInAtMs: foreignAt, released };
    check(c, "foreign.identity", "the new principal is the foreign owner", "browser /api/centropy/me", { tenantDiffers: login.identity?.tenantId !== parentA.tenantId }, login.identity?.tenantId !== parentA.tenantId);
    check(c, "foreign.dom-clean-before-and-after-release", "no panel of the original Work and no original private value, before the release and after a further 5 s", "O-SQL markers",
      { before: { panels: f1.applicationCount, leaked: hits(f1.html, markers) }, after: { panels: f2.applicationCount, leaked: hits(f2.html, markers) } },
      f1.applicationCount === 0 && f2.applicationCount === 0 && hits(f1.html, markers).length === 0 && hits(f2.html, markers).length === 0);
    const store = await storageScan(page, context, markers, secrets);
    check(c, "foreign.storage-clean", "no original private value and no previous refresh token in any storage", "storage scan", { markers: store.markerHitCount, secrets: store.secretHitCount }, store.markerHitCount === 0 && store.secretHitCount === 0);
    check(c, "released-before-proxy-budget", "the lock was released before the proxy's 20 s budget so the old request completes at the API", "timeline", released, Boolean(released) && released.atMs < 20000);
    mutationsOf(c, mark);
  } finally { await release("FINALLY"); await lock.end().catch(() => undefined); }
});

/* ---------------------------------------------------------------- finish */
const cleanup = { signedOut: false };
try { if (page && await page.locator(".ct-topbar").isVisible().catch(() => false)) { await uiSignOut(page); cleanup.signedOut = true; } } catch {}
await browser?.close().catch(() => undefined);
await acqA?.portal?.stop?.().catch(() => undefined);
await worker?.stop().catch(() => undefined);
const finishedAt = new Date();

const worse = (a, b) => ["PASS", "NOT_RUN", "FAIL"].indexOf(a) >= ["PASS", "NOT_RUN", "FAIL"].indexOf(b) ? a : b;
const MATRIX = { "Z0-R08-C01": ["M-01"], "Z0-R08-C02": ["M-02"], "Z0-R09-C01": ["M-01", "M-04"], "Z0-R09-C02": ["M-05", "M-06"], "Z0-R09-C03": ["M-07"],
  "Z0-R09-C04": ["M-06", "M-08"], "Z0-R09-C05": ["M-09"], "Z0-R09-C06": ["M-10"], "Z0-R45-C01": ["M-01"], "Z0-R45-C02": ["M-03"], "Z0-R45-C03": ["M-02", "M-04"], "Z0-R45-C04": ["M-05", "M-06", "M-07", "M-08"] };
const rows = Object.fromEntries(Object.entries(MATRIX).map(([row, ids]) => {
  const parts = ids.map(id => cases.find(item => item.id === id)).filter(Boolean);
  const outcome = parts.length === ids.length ? parts.map(item => item.outcome).reduce(worse, "PASS") : "NOT_RUN";
  return [row, { outcome, cases: Object.fromEntries(ids.map(id => [id, cases.find(item => item.id === id)?.outcome ?? "NOT_RUN"])) }];
}));
const tally = cases.reduce((acc, item) => ({ ...acc, [item.outcome]: (acc[item.outcome] ?? 0) + 1 }), {});
let head = null; try { head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
const allRequests = watch.records;
const artifact = {
  schema: "finnor.project-z.z0-mounted-session.v1", runName, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), sourceHead: head,
  qualification: "DISPOSABLE_TEST_AUTHORITY_DEVELOPMENT_RUN_NOT_PHASE_ACCEPTANCE_NOT_PROTECTED_ADMISSION",
  failureModel: { file: "scope-z/phase-evidence/z0/mounted-failure-model.md", amendments: "section 6" },
  inputs: { profile: "z0", ownerWorkerLifecycle: "SCENARIO_OWNED", frontend: FRONTEND, authOrigin, browser: "Chromium headless (Playwright)", viewport: "1440x1000", locale: "en-US", timezone: "UTC",
    originalWork: setup.A, blockedWork: setup.B ? { workId: parentB?.workId, ...setup.B } : null, foreignOwner: setup.foreign, setupErrors: setup.errors,
    secretsRecorded: false, tokensWrittenToDisk: false },
  mechanisms: {
    delayedOldPrincipalResponse: "owned PostgreSQL ACCESS EXCLUSIVE lock on finnor_os.application_semantics_sessions held from the admin connection; proven in pg_stat_activity; released before the proxy's 20 s budget; no request or response body touched",
    tokenRefresh: "page.clock.install + fastForward(3520 s) in a dedicated browser context so supabase-js performs its own grant_type=refresh_token against the real Auth; Auth server clock unchanged; no route interception",
    offline: "BrowserContext.setOffline(true/false)", requestInterception: false, injectedAuth: false, storagePlanting: false,
    harnessInitScript: "defines only globalThis.__name (identity) so compiled evaluate callbacks run in the page",
  },
  oracles: { sql: "admin connection (CENTROPY_E2E_DB_ADMIN_URL)", api: "Node-side owner password grant calling /api/company-brain/*", idp: "/auth/v1/user with the browser's observed bearer", dom: "details opened by real clicks" },
  matrixRows: rows, cases, tally,
  skips: cases.filter(item => item.outcome === "NOT_RUN").map(item => ({ id: item.id, reason: item.reason })),
  uiGaps: cases.flatMap(item => item.gaps.map(gap => ({ case: item.id, ...gap }))),
  costs: { ...costs, wallClockMs: finishedAt - startedAt, browserRequests: allRequests.length, nonGetBrowserRequests: allRequests.filter(r => r.kind !== "read").length, mutatingBrowserRequests: allRequests.filter(r => r.kind === "mutation").length },
  cleanup, exitCode: 0, rerunCommand: RERUN,
};
writePrivateJson(join(evidence, "z0-mounted-session.v1.json"), artifact);
chmodSync(evidence, 0o700);
console.log(JSON.stringify({ artifact: "z0-mounted-session.v1.json", tally, rows: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.outcome])) }));
await sql.end();
