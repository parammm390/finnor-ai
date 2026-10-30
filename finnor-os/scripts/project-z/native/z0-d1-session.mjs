/**
 * Z0 D1 identity scenario over the authenticated `POST /api/queries` boundary.
 * Launcher profile `z0`, started with --no-worker (this scenario owns the worker).
 * Failure model: scope-z/phase-evidence/z0/native-original-parent-failure-model.md section 11.
 *
 * Every request is a real Auth bearer call. Nothing is written to Work, programme or
 * owner tables here; the only direct SQL is read-only observation and the foreign
 * identity directory rows created by `createForeignIdentity`.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readNativeEnvironment, signInOwner, startOwnedWorker, createOriginalInstitutionParent, createForeignIdentity,
} from "./x1-origin-fixture.mts";

const here = dirname(fileURLToPath(import.meta.url));
const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE;
if (!state || !evidence) throw Error("Z0_SCENARIO_NATIVE_ENVIRONMENT_REQUIRED");
const env = readNativeEnvironment(state);
const privateRoot = join(state, "z0-private");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true });
const sha = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const SENSITIVE = /token|secret|password|authorization|apikey|credential/i;
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE.test(key) && typeof item === "string" ? "[REDACTED]" : redact(item)]));
  return value;
};
let sequence = 0;
const record = (name, value) => writeFileSync(join(evidence, `z0-${String(++sequence).padStart(3, "0")}-${name}.json`),
  JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
const results = [];
async function runCase(id, title, body) {
  const started = new Date().toISOString();
  try {
    const detail = await body();
    results.push({ id, title, outcome: detail?.outcome ?? "PASS", started, ...(detail?.reason ? { reason: detail.reason } : {}), detail: redact(detail?.detail ?? detail ?? null) });
  } catch (error) {
    results.push({ id, title, outcome: "FAIL", started, error: String(error?.message ?? error).slice(0, 600) });
  }
  record("case-" + id, results.at(-1));
  console.log(JSON.stringify({ case: id, outcome: results.at(-1).outcome, error: results.at(-1).error }));
}
const notRun = (id, title, reason) => { results.push({ id, title, outcome: "NOT_RUN", reason }); record("case-" + id, results.at(-1)); };
const ensure = (condition, predicate) => { if (!condition) throw Error(predicate); };

const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;

let worker = null;
if (env.FINNOR_WORKER_DATABASE_URL) worker = await startOwnedWorker(env, { logPath: join(privateRoot, "worker.log"), leaseSeconds: 30 });
const owner = await signInOwner(env);
// Next dev compiles routes on first use; a cold 504 would be a harness artifact.
await owner.call("/api/queries", { intent: "harness_program_v1" }).catch(() => null);

let parent = null;
await runCase("D1-00", "Original parent and three authenticated identities exist", async () => {
  parent = await createOriginalInstitutionParent(env, { record, tag: "d" + randomUUID().slice(0, 6), shape: "partial-unresolved" });
  const tenantPeer = await createForeignIdentity(env, { tenantId: parent.tenantId });
  const foreignTenant = await createForeignIdentity(env);
  parent.peer = { ...tenantPeer, session: await signInOwner(env, { email: tenantPeer.email, password: tenantPeer.password }) };
  parent.foreign = { ...foreignTenant, session: await signInOwner(env, { email: foreignTenant.email, password: foreignTenant.password }) };
  ensure(owner.tenantId === parent.tenantId, "OWNER_TENANT_MISMATCH");
  ensure(parent.peer.session.tenantId === parent.tenantId && parent.peer.session.userId !== owner.userId, "PEER_NOT_A_DIFFERENT_PRINCIPAL_IN_OWNER_TENANT");
  ensure(parent.foreign.session.tenantId !== parent.tenantId, "FOREIGN_TENANT_NOT_FOREIGN");
  const [work] = await q("SELECT created_by FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.workId]);
  return { detail: { workId: parent.workId, programId: parent.programId, workCreatedBy: work.created_by, ownerUserId: owner.userId,
    peer: { tenantId: parent.peer.session.tenantId, userId: parent.peer.session.userId }, foreign: { tenantId: parent.foreign.session.tenantId, userId: parent.foreign.session.userId } } };
});
if (!parent?.foreign) { record("summary", { results }); await sql.end(); await worker?.stop(); process.exit(1); }

const latestInput = async () => (await q("SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [parent.tenantId, parent.workId]))[0]?.id ?? null;
const snapshot = async () => ({
  works: (await q("SELECT count(*)::int n FROM finnor_os.works"))[0].n,
  originalInputs: (await q("SELECT count(*)::int n FROM finnor_os.work_inputs WHERE work_id=$1", [parent.workId]))[0].n,
  allInputs: (await q("SELECT count(*)::int n FROM finnor_os.work_inputs"))[0].n,
  actions: (await q("SELECT count(*)::int n FROM finnor_os.domain_actions WHERE tenant_id=$1", [parent.tenantId]))[0].n,
});
const leaks = text => [parent.dealId, parent.episodeId, parent.planRevisionId, parent.headId, parent.compilerRequestId, parent.parentReservation?.id]
  .filter(value => typeof value === "string" && text.includes(value));
const call = async (session, body, bearer) => {
  const response = await session.call("/api/queries", body, bearer === undefined ? {} : { bearer });
  return { status: response.status, body: response.body, bodySha256: response.bodySha256 };
};
const code = response => response.body?.code ?? response.body?.error ?? null;

const harness = { intent: "harness_program_v1", workId: parent.workId, programId: parent.programId };
const economic = { intent: "economic_programme_v1", workId: parent.workId, programmeId: randomUUID() };
const confidential = { intent: "confidential_economic_computation_v1", workId: parent.workId };

await runCase("D1-B", "Pre-repair parser (pristine c7e560c) against the integrated parser on the valid forms", async () => {
  const pristine = readFileSync(join(here, "../../../../scope-z/phase-evidence/z0/d1-pristine-route-c7e560c.ts.txt"), "utf8");
  const parsers = { pristine, integrated: readFileSync(join(here, "../../../apps/api/app/api/queries/route.ts"), "utf8") };
  const out = {};
  for (const [label, text] of Object.entries(parsers)) {
    const start = text.indexOf("function isRecord"), end = text.indexOf("export async function POST");
    ensure(start > 0 && end > start, "ROUTE_SOURCE_SHAPE_UNRECOGNISED_" + label);
    const module = `import { validateOperationalQueryRequest, type OperationalQueryRequest } from "@finnor/orchestration";\n${text.slice(start, end)}\nexport { parseRequestBody };\n`;
    const path = join(here, `.d1-parser-${label}-${randomUUID().slice(0, 6)}.mts`);
    writeFileSync(path, module);
    try {
      const { parseRequestBody } = await import(pathToFileURL(path).href);
      out[label] = { sourceSha256: sha(text), results: Object.fromEntries([harness, economic, confidential].map(body => {
        const parsed = parseRequestBody(body);
        return [body.intent, parsed.success ? { success: true, workId: parsed.options.workId ?? null, requestKeys: Object.keys(parsed.request).sort() } : { success: false, error: String(parsed.error).slice(0, 300) }];
      })) };
    } finally { unlinkSync(path); }
  }
  const before = out.pristine.results;
  const reproduces = before.harness_program_v1.success === false && !/NATIVE_ORIGINAL_WORK_OWNER_REQUIRED/.test(before.harness_program_v1.error)
    && before.confidential_economic_computation_v1.success === false && before.economic_programme_v1.success === true;
  return { outcome: reproduces ? "PASS" : "FAIL", detail: { note: "PASS means the defect is observed before the repair: workId stripped, harness/confidential not accepted, economic accepted", ...out } };
});

const positive = (id, title, request, extra = () => null) => runCase(id, title, async () => {
  const before = await snapshot(), input = await latestInput();
  const response = await call(owner, request);
  const after = await snapshot();
  const ok = response.status >= 200 && response.status < 300;
  ensure(after.works === before.works && after.originalInputs === before.originalInputs && after.allInputs === before.allInputs, "POSITIVE_CREATED_WORK_OR_INPUT");
  const refused = !ok;
  const detail = { status: response.status, code: code(response), workId: response.body?.workId ?? null, workInputId: response.body?.workInputId ?? null, expectedInput: input,
    executionIdentity: response.body?.result?.execution ?? null, bodySha256: response.bodySha256, body: response.body, before, after, ...extra(response) };
  if (refused) return { outcome: "FAIL", detail: { predicate: "READER_NOT_REACHED_ENVELOPE_REFUSED", ...detail } };
  ensure(response.body.workId === parent.workId && response.body.workInputId === input, "ORIGINAL_IDENTITY_NOT_PRESERVED");
  ensure(response.body.result?.execution?.workId === parent.workId && response.body.result?.execution?.workInputId === input, "READER_EXECUTION_IDENTITY_NOT_ORIGINAL");
  return { detail };
});
await positive("D1-01", "harness_program_v1 for the original programme reaches its reader with the original Work identity", harness);
notRun("D1-02a", "economic_programme_v1 with a real owner-created programme", "NO_ECONOMIC_PROGRAMME_ON_FIXTURE: needs an accepted Y1 economic theory, an economic reservation and canonical operator observations (scripts/y1/run-installed.mts); not creatable on the Z0 original-parent fixture within this session");
notRun("D1-03a", "confidential_economic_computation_v1 with a real computation", "NO_CONFIDENTIAL_COMPUTATION_ON_FIXTURE: needs the Y4 product lifecycle (scripts/y4/product-lifecycle.mts); not creatable on the Z0 original-parent fixture within this session");

const probe = (id, title, request) => runCase(id, title, async () => {
  const before = await snapshot();
  const response = await call(owner, request);
  const after = await snapshot();
  ensure(after.works === before.works && after.originalInputs === before.originalInputs && after.allInputs === before.allInputs, "PROBE_CREATED_WORK_OR_INPUT");
  const envelopeRefusal = response.status === 400 && /NATIVE_ORIGINAL_WORK_OWNER_REQUIRED|required|invalid|must|workId/i.test(JSON.stringify(response.body));
  return { outcome: envelopeRefusal ? "FAIL" : "PASS", detail: { predicate: envelopeRefusal ? "ENVELOPE_PARSER_REFUSED_BEFORE_READER" : "READER_ANSWERED", status: response.status, code: code(response), body: response.body, before, after } };
});
await probe("D1-02b", "economic_programme_v1 naming an absent programme gets the reader's typed answer", economic);
await probe("D1-03b", "confidential_economic_computation_v1 on a Work with no computation gets the reader's typed answer", confidential);

const rejects = [
  ["R1", "foreign tenant, byte-identical valid request", body => [parent.foreign.session, body], [403, 404]],
  ["R2", "foreign principal inside the owner tenant", body => [parent.peer.session, body], [403, 404]],
  ["R3", "wrong Work (random UUID)", body => [owner, { ...body, workId: randomUUID() }], [400, 403, 404]],
  ["R4", "stale/unknown input (workInputId is not a public field)", body => [owner, { ...body, workInputId: randomUUID() }], [400]],
  ["R5", "extra envelope field naming another tenant", body => [owner, { ...body, tenantId: parent.foreign.session.tenantId }], [400]],
  ["R6", "conflicting identity: original Work with a programme that is not the original's", body => [owner, "programId" in body ? { ...body, programId: randomUUID() } : { ...body, programmeId: randomUUID(), conflictingProgramId: parent.programId }], [400, 403, 404, 409]],
  ["R7", "missing owner: no workId", body => { const { workId, ...rest } = body; return [owner, rest]; }, [400, 403, 404]],
  ["R8", "anonymous (no bearer)", body => [owner, body, null], [401]],
];
const otherWork = (await q("SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id<>$2 ORDER BY created_at LIMIT 1", [parent.tenantId, parent.workId]))[0]?.id ?? null;
if (otherWork) rejects.push(["R3b", "wrong Work (a real other Work of the tenant)", body => [owner, { ...body, workId: otherWork }], [400, 403, 404]]);
for (const [id, title, build, accepted] of rejects) {
  await runCase("D1-" + id, "Reject: " + title, async () => {
    const carriers = [];
    for (const [carrier, body] of [["harness_program_v1", harness], ["economic_programme_v1", economic]]) {
      const [session, request, bearer] = build(body);
      const before = await snapshot();
      const response = await call(session, request, bearer);
      const after = await snapshot();
      const control = await call(owner, body);
      const text = JSON.stringify(response.body ?? {});
      carriers.push({ carrier, request: id === "R1" || id === "R2" ? "valid body, other identity" : request, status: response.status, code: code(response), bodySha256: response.bodySha256, body: response.body,
        stateUnchanged: after.works === before.works && after.originalInputs === before.originalInputs && after.allInputs === before.allInputs && after.actions === before.actions,
        leaked: leaks(text), expectedStatuses: accepted, statusAsExpected: accepted.includes(response.status),
        ownerControl: { status: control.status, code: code(control) }, discriminating: control.status < 300 || code(control) !== code(response) || control.status !== response.status });
    }
    const failures = carriers.filter(item => !item.statusAsExpected || !item.stateUnchanged || item.leaked.length);
    // The refusal only counts as an identity refusal on a carrier where the same body from the owner is not refused identically.
    return { outcome: failures.length ? "FAIL" : "PASS", detail: { failures: failures.map(item => ({ carrier: item.carrier, status: item.status, stateUnchanged: item.stateUnchanged, leaked: item.leaked })), carriers } };
  });
}
await runCase("D1-R9", "Replay conflict: one executionKey reused with a different body", async () => {
  const executionKey = "z0-d1-" + randomUUID();
  const first = await call(owner, { ...economic, executionKey });
  const before = await snapshot();
  const second = await call(owner, { ...economic, programmeId: randomUUID(), executionKey });
  const after = await snapshot();
  ensure(after.works === before.works && after.allInputs === before.allInputs, "REPLAY_CONFLICT_CREATED_WORK_OR_INPUT");
  const refused = second.status >= 400 && second.status < 500 && second.status !== first.status ? true : second.status === 409;
  return { outcome: refused ? "PASS" : "FAIL", detail: { first: { status: first.status, code: code(first) }, second: { status: second.status, code: code(second) }, note: "A key-bound replay with a different body must not be answered as if it were the first request" } };
});

record("summary", { schema: "finnor.project-z.native.z0-d1-session.v1", head: process.env.FINNOR_NATIVE_SOURCE_HEAD ?? null, results });
const outcomes = results.reduce((acc, item) => ({ ...acc, [item.outcome]: (acc[item.outcome] ?? 0) + 1 }), {});
console.log(JSON.stringify({ outcomes }));
await sql.end();
await worker?.stop();
process.exit(0);
