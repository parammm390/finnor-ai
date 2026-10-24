/** Executable native driver. --plan / --doctor are network-free. Native run
 * requires separately delivered, expiring authority and an independent oracle.
 * No provisioning, arbitrary SQL/commands, fake owner, Auth or queue override. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, realpath, stat, readdir, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { nativePlan } from "./native-e2e-plan.mjs";

const own = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sha = data => createHash("sha256").update(data).digest("hex");
const digest = value => sha(JSON.stringify(canonical(value)));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const ensure = (condition, predicate) => { if (!condition) throw Error(predicate); };
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(plan|doctor|run)$/.exec(arg);
  if (match) return [match[1], true];
  const value = /^--(authority|oracle|oracle-sha256|output|ack)=(.+)$/.exec(arg);
  ensure(value, "Z0_NATIVE_DRIVER_ARGUMENT_INVALID");
  return [value[1], value[2]];
}));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function subset(actual, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    const used = new Set();
    return expected.every(value => {
      const index = actual.findIndex((row, position) => !used.has(position) && subset(row, value));
      if (index < 0) return false;
      used.add(index); return true;
    });
  }
  return expected && typeof expected === "object"
    ? actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
    : actual !== undefined && digest(actual) === digest(expected);
}
const envValue = name => {
  ensure(typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && process.env[name], "Z0_REQUIRED_ENVIRONMENT_NAME_UNAVAILABLE");
  return process.env[name];
};
const origin = value => {
  const url = new URL(value);
  ensure(url.origin === value && !url.username && !url.password && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Z0_OWNED_LOOPBACK_ORIGIN_REQUIRED");
  return url.origin;
};
const bounded = rows => { ensure(rows.length <= 1024, "Z0_NATIVE_EVIDENCE_TRUNCATED"); return rows; };
let output, authority, oracle, currentCase = null, completed = false;
const reports = [], sessions = [], sourceBindings = [];

async function processIdentity(pid) {
  ensure(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, "Z0_OWNED_PROCESS_ID_REQUIRED");
  const path = "/proc/" + pid;
  const raw = await readFile(path + "/stat", "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const [executable, cwd, cmdline, metadata] = await Promise.all([
    realpath(path + "/exe"), realpath(path + "/cwd"), readFile(path + "/cmdline"), stat(path),
  ]);
  return { pid, state: fields[0], parentPid: Number(fields[1]), pgid: Number(fields[2]), startTicks: fields[19],
    executable, cwd, cmdlineSha256: sha(cmdline), uid: metadata.uid,
    executableSha256: sha(await readFile(executable)) };
}
async function checkProcess(expected, group = false) {
  const actual = await processIdentity(expected.pid);
  ensure(actual.uid === process.getuid() && actual.startTicks === expected.startTicks
    && actual.cmdlineSha256 === expected.cmdlineSha256 && actual.executableSha256 === expected.executableSha256
    && actual.cwd === expected.cwd && (!group || actual.pgid === actual.pid), "Z0_BORROWED_OR_CHANGED_PROCESS_REFUSED");
  return actual;
}
async function checkListener(value, processes) {
  const port = Number(new URL(value).port || 80), inodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(table, "utf8")).trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && parseInt(fields[1].split(":").at(-1), 16) === port) inodes.add(fields[9]);
    }
  }
  ensure(inodes.size > 0, "Z0_OWNED_LISTENER_NOT_DELIVERED");
  for (const owner of processes) for (const fd of await readdir("/proc/" + owner.pid + "/fd")) {
    let link; try { link = await readlink("/proc/" + owner.pid + "/fd/" + fd); } catch { continue; }
    if (inodes.has(/^socket:\[(\d+)\]$/.exec(link)?.[1])) return;
  }
  throw Error("Z0_BORROWED_LISTENER_REFUSED");
}
async function waitExit(before) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      const now = await processIdentity(before.pid);
      if (now.startTicks !== before.startTicks || now.state === "Z") return;
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return; throw error; }
    await delay(50);
  }
  throw Error("Z0_PHYSICAL_PROCESS_EXIT_NOT_OBSERVED");
}
function nativeEnvironment(target) {
  ensure(Number.isInteger(target.worker.leaseSeconds) && target.worker.leaseSeconds >= 30
    && target.worker.leaseSeconds <= 60, "Z0_PREAUTHORIZED_FINITE_WORKER_LEASE_REQUIRED");
  const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: target.home, LANG: "C.UTF-8",
    NODE_ENV: "development", AUTH_DEV_BYPASS: "0", FINNOR_ENVIRONMENT: "staging", FINNOR_P4_PROFILE: "ordinary_disposable", FINNOR_X1_PROFILE: "ordinary_disposable",
    FINNOR_X2_PROFILE: "ordinary_disposable", FINNOR_Z0_NATIVE_AUTHORIZED: "explicit_disposable_z0",
    NODE_OPTIONS: "--max-old-space-size=4096", GIT_CEILING_DIRECTORIES: dirname(target.root),
    WORKER_JOB_LEASE_SECONDS: String(target.worker.leaseSeconds),
    PLAYWRIGHT_BROWSERS_PATH: resolve(target.root, "browsers") };
  for (const [key, source] of Object.entries(target.nativeEnvironment)) {
    ensure(["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "FINNOR_DB_ROLE",
      "FINNOR_WORKER_INSTANCE_ID", "FINNOR_X1_RUNTIME", "FINNOR_X1_COMPILED"].includes(key), "Z0_LIVE_PROVIDER_ENVIRONMENT_REFUSED");
    env[key] = envValue(source);
  }
  ensure(env.DATABASE_URL && env.AUTH_DEV_BYPASS === "0", "Z0_REAL_NATIVE_ENVIRONMENT_REQUIRED");
  const database = new URL(env.DATABASE_URL);
  ensure(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
    && database.pathname.slice(1) === target.database.name
    && Number(database.port || 5432) === target.database.port, "Z0_NATIVE_DISPOSABLE_DATABASE_MISMATCH");
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    if (env[key]) ensure(new URL(env[key]).origin === target.authOrigin, "Z0_NATIVE_AUTH_PROJECT_MISMATCH");
  }
  if (target.kind === "INSTALLED") env.NODE_OPTIONS += " --import=" + target.loader;
  return env;
}
async function checkOwnedWorker(target, expected = target.worker) {
  const actual = await checkProcess(expected, true), native = nativeEnvironment(target);
  const entries = (await readFile("/proc/" + actual.pid + "/environ", "utf8")).split("\0").filter(Boolean);
  const environment = Object.fromEntries(entries.map(entry => {
    const equals = entry.indexOf("="); return [entry.slice(0, equals), entry.slice(equals + 1)];
  }));
  const argv = (await readFile("/proc/" + actual.pid + "/cmdline", "utf8")).split("\0").filter(Boolean);
  ensure(actual.executableSha256 === sha(await readFile(process.execPath))
    && argv.some(value => resolve(actual.cwd, value) === target.worker.entry)
    && environment.AUTH_DEV_BYPASS !== "1", "Z0_ACTUAL_CANONICAL_NONBYPASS_WORKER_REQUIRED");
  for (const key of ["NODE_ENV", "FINNOR_ENVIRONMENT", "FINNOR_P4_PROFILE", "FINNOR_X1_PROFILE",
    "FINNOR_X2_PROFILE", "DATABASE_URL", "WORKER_JOB_LEASE_SECONDS"]) {
    ensure(environment[key] === native[key], "Z0_WORKER_NATIVE_CONFIGURATION_CHANGED");
  }
  ensure(environment.FINNOR_WORKER_INSTANCE_ID === native.FINNOR_WORKER_INSTANCE_ID,
    "Z0_WORKER_INSTANCE_CONFIGURATION_CHANGED");
  await checkProcess(actual, true);
  return { ...actual, workerInstanceId: environment.FINNOR_WORKER_INSTANCE_ID?.trim() || `worker:${hostname()}:${actual.pid}` };
}
async function deliveryGroupMembers(worker) {
  const members = [worker], seen = new Set([worker.pid]);
  for (let i = 0; i < members.length; i++) {
    const parent = members[i];
    let children;
    try { children = await readFile(`/proc/${parent.pid}/task/${parent.pid}/children`, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const value of children.trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(value); if (seen.has(pid)) continue;
      let child;
      try { child = await processIdentity(pid); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
      ensure(child.parentPid === parent.pid && child.uid === process.getuid() && child.pgid === worker.pid,
        "Z0_DETACHED_OR_UNOWNED_PHYSICAL_PRODUCER_REFUSED");
      ensure(members.length < 128, "Z0_OWNED_DELIVERY_PROCESS_BOUND");
      seen.add(pid); members.push(child);
    }
  }
  return members;
}
async function observer(target) {
  const require = createRequire(resolve(target.root, "finnor-os/package.json"));
  const pgPath = await realpath(require.resolve("pg"));
  ensure(pgPath.startsWith(target.root + sep), "Z0_BORROWED_OBSERVER_DEPENDENCY_REFUSED");
  const { Client } = require("pg"), url = new URL(envValue(target.observerDatabaseEnv));
  ensure(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname.slice(1) === target.database.name
    && Number(url.port || 5432) === target.database.port && decodeURIComponent(url.username) === target.database.observerRole,
  "Z0_EXACT_DISPOSABLE_OBSERVER_REQUIRED");
  const client = new Client({ connectionString: url.href, ssl: false, statement_timeout: 15000,
    query_timeout: 20000, options: "-c default_transaction_read_only=on", application_name: "project-z-z0-independent-observer" });
  try {
    await client.connect();
    const role = (await client.query("SELECT current_user rolname,rolsuper,rolbypassrls,current_setting('default_transaction_read_only') readonly FROM pg_roles WHERE rolname=current_user")).rows[0];
    ensure(role?.rolname === target.database.observerRole && !role.rolsuper && !role.rolbypassrls && role.readonly === "on",
      "Z0_RESTRICTED_READONLY_OBSERVER_REQUIRED");
    return client;
  } catch (error) { await client.end().catch(() => {}); throw error; }
}
async function snapshot(session, fixture) {
  const { db, target } = session, actor = target.actor, p = [actor.tenantId, actor.principalId, fixture.workId, fixture.reservationId ?? ""];
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.principal_id',$2,true),set_config('app.user_id',$2,true)", p.slice(0, 2));
    const read = async sql => bounded((await db.query("WITH z0_scope AS (SELECT $1::uuid tenant_id,$2::uuid principal_id,"
      + "$3::uuid work_id,$4::text reservation_id) " + sql, p)).rows);
    const value = {
      work: await read("SELECT id,created_by,status FROM finnor_os.works WHERE tenant_id=$1 AND id=$3 LIMIT 1025"),
      globalCounts: await read("SELECT (SELECT count(*)::text FROM finnor_os.works WHERE tenant_id=$1 AND created_by=$2) works,(SELECT count(*)::text FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id WHERE w.tenant_id=$1 AND w.created_by=$2) inputs,(SELECT count(*)::text FROM finnor_os.domain_actions WHERE tenant_id=$1 AND initiated_by=$2) actions"),
      inputs: await read("SELECT id,instruction_id,created_at FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$3 ORDER BY created_at,id LIMIT 1025"),
      compiler: await read("SELECT r.id,r.work_id,r.work_input_id,r.episode_id,r.status,r.generation,r.program_id,r.artifact_id,r.input_manifest,e.original_deadline,e.wall_deadline,e.parent_reservation,e.parent_demand FROM finnor_os.x1_compiler_requests r JOIN finnor_os.x1_compiler_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 LIMIT 1025"),
      programs: await read("SELECT id,work_id,work_input_id,episode_id,status,generation,claim_token,claim_fence,proposed,request FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 LIMIT 1025"),
      programHeads: await read("SELECT p.id,p.request_id,p.body,p.digest FROM finnor_os.p1_programs p JOIN finnor_os.p1_requests r ON r.tenant_id=p.tenant_id AND r.head_id=p.id AND r.id=p.request_id WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 LIMIT 1025"),
      applications: await read("SELECT id,work_id,work_input_id,parent_id,original_parent_ref,parent,status,generation,claim_token,claim_fence,deadline_at,reservation_ref,allocation_ref,model_ref,check_ref,request FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 LIMIT 1025"),
      actions: await read("SELECT id,work_id,initiated_by,action_type,status,payload,authority_context FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$3 LIMIT 1025"),
      uses: await read("SELECT e.request_id,e.generation,e.kind,e.body FROM finnor_os.p1_events e JOIN finnor_os.p1_requests p ON p.tenant_id=e.tenant_id AND p.id=e.request_id WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.work_id=$3 AND e.kind IN ('P1_ORIGINAL_APPLICATION_MODEL_CONSUMED','P1_ORIGINAL_APPLICATION_MODEL_MATERIALIZED','P1_ORIGINAL_APPLICATION_DIRECT_FALLBACK') LIMIT 1025"),
      refusals: await read("SELECT 'P1' event_owner,e.id::text event_id,e.kind,e.body FROM finnor_os.p1_events e JOIN finnor_os.p1_requests p ON p.tenant_id=e.tenant_id AND p.id=e.request_id WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.work_id=$3 UNION ALL SELECT 'X2' event_owner,e.event_id,e.kind,e.body FROM finnor_os.application_semantics_events e JOIN finnor_os.application_semantics_sessions s ON s.tenant_id=e.tenant_id AND s.id=e.session_id WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.work_id=$3 UNION ALL SELECT 'X1' event_owner,e.id::text event_id,e.kind,e.body FROM finnor_os.x1_compiler_events e JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.id=e.request_id WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 LIMIT 1025"),
      queryExecutions: await read("SELECT id,work_id,work_input_id,intent,status,execution_key FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$3 LIMIT 1025"),
      jobs: await read("SELECT id,type,status,claim_fence,claim_token,lease_owner,lease_expires_at,payload FROM finnor_os.jobs WHERE tenant_id=$1 AND (payload->>'workId'=$3::text OR payload->>'requestId' IN(SELECT id::text FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3) OR payload->>'programId' IN(SELECT id::text FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3) OR payload->>'sessionId' IN(SELECT id::text FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3)) LIMIT 1025"),
      deliveries: await read("SELECT d.job_id,d.claim_token,d.claim_fence,d.worker_id,d.outcome FROM finnor_os.job_delivery_attempts d JOIN finnor_os.jobs j ON j.tenant_id=d.tenant_id AND j.id=d.job_id WHERE d.tenant_id=$1 AND (j.payload->>'workId'=$3::text OR j.payload->>'requestId' IN(SELECT id::text FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3) OR j.payload->>'programId' IN(SELECT id::text FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3) OR j.payload->>'sessionId' IN(SELECT id::text FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3)) LIMIT 1025"),
      applicationArtifacts: await read("SELECT artifact_id,content_digest,private,body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id IN(SELECT model_ref->>'id' FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 UNION SELECT check_ref->>'id' FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 UNION SELECT e.body->'modelUseRef'->>'id' FROM finnor_os.p1_events e JOIN finnor_os.p1_requests p ON p.tenant_id=e.tenant_id AND p.id=e.request_id WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.work_id=$3) LIMIT 1025"),
      reservations: await read("SELECT reservation_id,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$4 LIMIT 1025"),
      charges: await read("SELECT charge_key,phase,resource_id,unit,units::text,body FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$4 LIMIT 1025"),
      obligations: await read("SELECT o.obligation_id,o.consumption_id,o.effect_id,o.domain_action_id,st.status consumption_status,e.status effect_status,ar.status application_status,ar.possible_egress FROM finnor_os.s6_obligation_origins o JOIN finnor_os.s5_consumptions c USING(tenant_id,consumption_id) JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id LEFT JOIN finnor_os.application_semantics_requests ar ON ar.tenant_id=o.tenant_id AND ar.obligation_id=o.obligation_id WHERE o.tenant_id=$1 AND o.principal_id=$2 AND c.reservation_id=$4 LIMIT 1025"),
      compute: await read("SELECT record_id,body->'payload' payload FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND body->'payload'->>'workId'=$3::text AND body->'payload'->>'schema'='finnor.x1.native-compute.v1' LIMIT 1025"),
      authority: await read("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 LIMIT 1025"),
    };
    if (fixture.owner) {
      const table = { open_workstream: "pe_workstreams", create_deal_request: "pe_requests", record_finding: "pe_findings" }[fixture.owner.operation];
      ensure(table, "Z0_CLOSED_ORIGINAL_BUSINESS_OWNER_REQUIRED");
      value.owner = bounded((await db.query(`SELECT to_jsonb(r) body FROM finnor_os.${table} r WHERE tenant_id=$1 AND id=$2 LIMIT 2`,
        [actor.tenantId, fixture.owner.entityId])).rows).map(row => row.body);
    }
    await db.query("COMMIT");
    return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
const consumed = value => value.uses.filter(row => row.kind === "P1_ORIGINAL_APPLICATION_MODEL_CONSUMED");
const unknown = value => value.obligations.filter(row => row.consumption_status === "UNKNOWN_OUTCOME"
  || ["executing", "reconciliation_required"].includes(row.effect_status));
function sameOriginal(before, after, fixture) {
  ensure(after.work.length === 1 && after.work[0].id === fixture.workId, "Z0_ORIGINAL_WORK_CHANGED");
  ensure(after.inputs.at(-1)?.id === fixture.workInputId && before.inputs.at(-1)?.id === fixture.workInputId, "Z0_ORIGINAL_INPUT_CHANGED");
  for (const prior of before.compiler) {
    const next = after.compiler.find(row => row.id === prior.id);
    const frozen = row => row && ({ id: row.id, work_id: row.work_id, work_input_id: row.work_input_id,
      episode_id: row.episode_id, input_manifest: row.input_manifest, original_deadline: row.original_deadline,
      wall_deadline: row.wall_deadline, parent_reservation: row.parent_reservation, parent_demand: row.parent_demand });
    ensure(next && digest(frozen(next)) === digest(frozen(prior)), "Z0_ORIGINAL_COMPILER_INPUT_OR_ALLOWANCE_CHANGED");
  }
  for (const prior of before.programs) {
    const next = after.programs.find(row => row.id === prior.id);
    ensure(next && next.work_id === prior.work_id && next.work_input_id === prior.work_input_id
      && next.episode_id === prior.episode_id && digest(next.proposed) === digest(prior.proposed)
      && digest(next.request) === digest(prior.request), "Z0_COMPLETE_FROZEN_ORIGINAL_PROGRAMME_CHANGED");
  }
  for (const prior of before.applications) {
    const next = after.applications.find(row => row.id === prior.id);
    ensure(next && next.parent_id === prior.parent_id && digest(next.reservation_ref) === digest(prior.reservation_ref)
      && digest(next.original_parent_ref) === digest(prior.original_parent_ref) && digest(next.parent) === digest(prior.parent)
      && new Date(next.deadline_at).toISOString() === new Date(prior.deadline_at).toISOString(), "Z0_PARENT_OR_DEADLINE_RENEWED");
  }
  for (const row of after.applications) {
    const root = after.applications.find(item => item.id === row.parent_id);
    const selector = row.request.institutionalOrigin ?? root?.request.institutionalOrigin;
    if (!selector) continue;
    const original = before.compiler.find(item => item.id === selector.compilerRequestId && item.program_id === selector.programId);
    ensure(original && root && row.work_id === fixture.workId && row.work_input_id === fixture.workInputId
      && digest(row.reservation_ref) === digest(original.parent_reservation)
      && digest(row.original_parent_ref) === digest(root.original_parent_ref)
      && Date.parse(row.deadline_at) <= Math.min(Date.parse(original.original_deadline), Date.parse(original.wall_deadline))
      && Date.parse(row.deadline_at) <= Date.parse(root.deadline_at), "Z0_NEW_APPLICATION_DID_NOT_INHERIT_ORIGINAL_PARENT");
  }
  ensure(digest(after.reservations.map(row => row.envelopes)) === digest(before.reservations.map(row => row.envelopes)), "Z0_ORIGINAL_S5_ENVELOPE_CHANGED");
  for (const bound of fixture.resourceBudgets ?? []) {
    const spent = after.charges.filter(row => row.resource_id === bound.resourceId && row.unit === bound.unit)
      .reduce((sum, row) => sum + BigInt(row.units), 0n);
    ensure(spent <= BigInt(bound.reservedUnits), "Z0_ORIGINAL_RESOURCE_BOUND_EXCEEDED");
  }
  const keys = after.charges.map(row => row.charge_key);
  ensure(new Set(keys).size === keys.length, "Z0_PHYSICAL_CHARGE_DUPLICATED");
}
function hasTypedPredicate(value, predicate, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return false;
  return ["code", "reason", "failureCode", "predicate", "message", "error"].some(key => value[key] === predicate)
    || ["detail", "failure", "error", "result", "check", "cause"].some(key => hasTypedPredicate(value[key], predicate, depth + 1));
}
const eventKey = row => row.event_owner + ":" + row.event_id;
const observedRefusal = (session, value, predicate) => typeof predicate === "string"
  && (session.steps.some(step => step.status >= 400 && step.refusalPredicate === predicate)
    || value.refusals.some(row => !session.beforeRefusalIds.has(eventKey(row)) && hasTypedPredicate(row.body, predicate)));
function originalOwnerObserved(value, fixture, canonicalActionId = null) {
  const owner = fixture.owner;
  if (!owner?.expectedFullRow || !owner.originalDeadlineAt) return false;
  const operationFields = {
    open_workstream: ["kind", "name", "state", "completed_at", "cancelled_at"],
    create_deal_request: ["workstream_id", "requested_from_deal_party_id", "request_text", "requested_at", "due_at",
      "requires_accepted_deliverable", "state", "acknowledged_at", "fulfilled_at", "cancelled_at"],
    record_finding: ["workstream_id", "related_request_id", "related_deliverable_id", "statement", "severity", "materiality",
      "required_for_workstream_completion", "state", "disposition", "resolved_at", "accepted_at", "superseded_at"],
  }[owner.operation];
  const fields = ["tenant_id", "id", "deal_id", "owner_party_type", "owner_party_id", "archived_at", ...(operationFields ?? [])];
  return operationFields && fields.every(key => Object.hasOwn(owner.expectedFullRow, key))
    && value.owner?.length === 1 && subset(value.owner[0], owner.expectedFullRow)
    && Date.parse(value.owner[0].created_at) <= Date.parse(owner.originalDeadlineAt)
    && value.programHeads.some(head => Array.isArray(head.body.observedPostconditions) && head.body.observedPostconditions.some(observed =>
      observed.stableIdentity === owner.stableIdentity && observed.observerDigest
      && value.actions.some(action => action.id === observed.actionId && action.action_type === owner.operation
        && action.authority_context?.stableIdentity === owner.stableIdentity
        && (!canonicalActionId || action.id === canonicalActionId))));
}
const frozenAction = row => ({ id: row.id, work_id: row.work_id, initiated_by: row.initiated_by,
  action_type: row.action_type, payload: row.payload, programId: row.authority_context.programId,
  stableIdentity: row.authority_context.stableIdentity, workInputId: row.authority_context.workInputId,
  modelUseRef: row.authority_context.applicationModelUseRef, acceptanceRef: row.authority_context.applicationModelAcceptanceRef,
  modelInputDigest: row.authority_context.applicationModelInputDigest });
async function call(session, step) {
  ensure(step.kind === "HTTP" && ["GET", "POST", "PATCH", "DELETE"].includes(step.method), "Z0_CLOSED_NATIVE_HTTP_STEP_REQUIRED");
  const url = new URL(step.url), allowed = session.target.allowedHttpOperations.find(op => op.method === step.method && op.url === step.url);
  ensure(allowed && [session.target.apiOrigin, session.target.frontendOrigin, ...session.target.applicationOrigins].includes(url.origin)
    && !url.username && !url.password && !url.search && !url.hash, "Z0_UNREQUESTED_HTTP_OPERATION_REFUSED");
  const response = await fetch(url, { method: step.method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { authorization: "Bearer " + session.token, ...(step.method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(step.method === "GET" ? {} : { body: JSON.stringify(step.body) }) });
  const raw = await response.text();
  ensure(Buffer.byteLength(raw) <= 2 * 1024 ** 2, "Z0_NATIVE_HTTP_RESPONSE_BOUND");
  let body; try { body = JSON.parse(raw); } catch { throw Error("Z0_NATIVE_JSON_RESPONSE_REQUIRED"); }
  ensure(response.status === step.expectedStatus && subset(body, step.expectedResponse ?? {}), "Z0_NATIVE_HTTP_EXPECTATION_FAILED");
  session.steps.push({ kind: "AUTHENTICATED_NATIVE_HTTP", method: step.method, path: url.pathname,
    requestSha256: digest(step.body ?? null), status: response.status, responseSha256: sha(raw),
    refusalPredicate: typeof body.code === "string" ? body.code : typeof body.error?.code === "string" ? body.error.code : null });
  return body;
}
async function observeNative(session, operation, query, options) {
  const entry = resolve(session.target.root, "finnor-os/scripts/project-z/z0/native-observation-child.mjs");
  const args = session.target.kind === "INSTALLED" ? ["--import", session.target.loader] : ["--import", session.target.tsx];
  const child = spawn(process.execPath, [...args, entry], { cwd: session.target.root, env: nativeEnvironment(session.target), stdio: ["pipe", "pipe", "pipe"] });
  const input = { root: session.target.root, operation, query, options, apiOrigin: session.target.apiOrigin,
    ...session.target.actor, bearer: session.token };
  let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  child.stdout.on("data", b => { stdout += b; if (stdout.length > 2 * 1024 ** 2) child.kill("SIGKILL"); });
  child.stderr.on("data", b => { stderr += b; if (stderr.length > 1024 ** 2) child.kill("SIGKILL"); });
  child.stdin.end(JSON.stringify(input));
  child.stdin.on("error", () => {});
  const exit = await new Promise((resolveExit, reject) => { child.once("exit", (code, signal) => resolveExit({ code, signal })); child.once("error", reject); });
  clearTimeout(timer);
  ensure(exit.code === 0 || exit.code === 2, "Z0_ACTUAL_NATIVE_OBSERVATION_CHILD_FAILED");
  const result = JSON.parse(stdout.trim());
  session.steps.push({ kind: "REAL_AUTH_NATIVE_QUERY_OWNER", operation, exit, resultSha256: sha(stdout), stderrSha256: sha(stderr) });
  return result;
}
async function waitFor(session, fixture, predicate, timeoutMs = 60000) {
  const end = Date.now() + Math.min(timeoutMs, 120000);
  while (Date.now() < end) {
    const value = await snapshot(session, fixture);
    if (predicate(value)) return value;
    await delay(200);
  }
  throw Error("Z0_NATIVE_DURABLE_BOUNDARY_NOT_OBSERVED");
}
function atBoundary(value, boundary) {
  if (boundary === "CLAIM") return value.jobs.some(row => row.status === "running" && row.claim_token && Number(row.claim_fence) > 0);
  if (boundary === "ARTIFACT") return value.applications.some(row => row.model_ref && row.check_ref) && consumed(value).length === 0;
  if (boundary === "AMBIGUITY") return unknown(value).some(row => row.effect_status === "reconciliation_required"
    || row.application_status === "UNKNOWN" && row.possible_egress === true);
  return false;
}
async function restartWorker(session) {
  const { target } = session;
  ensure(await realpath(target.worker.entry) === target.worker.entry && target.worker.entry.startsWith(target.root + sep)
    && sha(await readFile(target.worker.entry)) === target.worker.entrySha256, "Z0_WORKER_ENTRY_CHANGED");
  const imports = target.kind === "INSTALLED" ? target.loader : target.tsx;
  const child = spawn(process.execPath, ["--max-old-space-size=4096", "--import", imports, target.worker.entry],
    { cwd: target.root, env: nativeEnvironment(target), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  await new Promise((ok, reject) => { child.once("spawn", ok); child.once("error", reject); });
  const identity = await processIdentity(child.pid);
  ensure(identity.pgid === identity.pid, "Z0_OWNED_INDEPENDENT_WORKER_GROUP_REQUIRED");
  session.worker = identity; session.restarted = child;
  session.worker = await checkOwnedWorker(target, identity);
  return session.worker;
}
async function physicalCut(session, fixture, boundary) {
  const lifecycleStartedAt = new Date().toISOString();
  ensure(session.target.worker.independentlySupervised === true && authority.permissions.physicalRecovery === true,
    "Z0_PHYSICAL_RECOVERY_AUTHORITY_REQUIRED");
  ensure(fixture.expectedDurableState && Object.keys(fixture.expectedDurableState).length > 0
    && ["ORIGINAL_OWNER_OBSERVED", "TYPED_REMAINING_BUDGET_REFUSAL", "UNKNOWN_RETAINED"].includes(fixture.recoveryOutcome)
    && (boundary === "AMBIGUITY") === (fixture.recoveryOutcome === "UNKNOWN_RETAINED"),
  "Z0_INDEPENDENT_RECOVERY_TERMINAL_EXPECTATION_REQUIRED");
  let paused = false, before, identity, killedClaim, killedProcesses;
  try {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      identity = await checkOwnedWorker(session.target, session.worker);
      process.kill(-identity.pid, "SIGSTOP"); paused = true;
      before = await snapshot(session, fixture);
      if (atBoundary(before, boundary)) break;
      process.kill(-identity.pid, "SIGCONT"); paused = false;
      await delay(100);
    }
    ensure(paused && before && atBoundary(before, boundary), "Z0_PHYSICAL_CUT_BOUNDARY_MISSED");
    killedClaim = before.jobs.find(row => row.status === "running" && row.claim_token
      && row.lease_owner === identity.workerInstanceId && Date.parse(row.lease_expires_at) > Date.now());
    ensure(killedClaim && before.deliveries.some(row => row.job_id === killedClaim.id
      && row.claim_token === killedClaim.claim_token && Number(row.claim_fence) === Number(killedClaim.claim_fence)
      && row.worker_id === identity.workerInstanceId), "Z0_KILLED_WORKER_DID_NOT_OWN_ORIGINAL_CLAIM");
    killedProcesses = await deliveryGroupMembers(identity);
    await checkProcess(identity, true);
    process.kill(-identity.pid, "SIGKILL"); paused = false;
    for (const member of killedProcesses) await waitExit(member);
    const exitedAt = new Date().toISOString(), afterExit = await snapshot(session, fixture);
    ensure(atBoundary(afterExit, boundary), "Z0_PHYSICAL_CUT_BOUNDARY_ADVANCED");
    sameOriginal(before, afterExit, fixture);
    const replacement = await restartWorker(session);
    ensure(replacement.pid !== identity.pid || replacement.startTicks !== identity.startTicks, "Z0_ACTUAL_WORKER_RESTART_NOT_OBSERVED");
    for (const step of fixture.afterRestart ?? []) await call(session, step);
    const reclaimed = value => value.deliveries.some(row => row.job_id === killedClaim.id
      && Number(row.claim_fence) > Number(killedClaim.claim_fence) && row.worker_id === replacement.workerInstanceId);
    const recovered = await waitFor(session, fixture, value => reclaimed(value) && subset(value, fixture.expectedDurableState)
      && (fixture.recoveryOutcome !== "ORIGINAL_OWNER_OBSERVED" || originalOwnerObserved(value, fixture))
      && (fixture.recoveryOutcome !== "TYPED_REMAINING_BUDGET_REFUSAL"
        || observedRefusal(session, value, fixture.expectedRefusalPredicate))
      && (fixture.recoveryOutcome !== "UNKNOWN_RETAINED" || unknown(value).length > 0), 120000);
    sameOriginal(before, recovered, fixture);
    for (const prior of before.actions) {
      const next = recovered.actions.find(row => row.id === prior.id);
      ensure(next && digest(frozenAction(next)) === digest(frozenAction(prior)), "Z0_NATIVE_EFFECT_REPLACEMENT_DETECTED");
    }
    const intentKeys = recovered.actions.filter(row => row.authority_context.programId && row.authority_context.stableIdentity)
      .map(row => digest([row.authority_context.programId, row.authority_context.stableIdentity]));
    ensure(new Set(intentKeys).size === intentKeys.length, "Z0_DUPLICATE_ORIGINAL_RESPONSIBILITY_ACTION");
    if (fixture.recoveryOutcome === "TYPED_REMAINING_BUDGET_REFUSAL") ensure(
      consumed(recovered).length === consumed(before).length && recovered.actions.length === before.actions.length,
      "Z0_REMAINING_BUDGET_REFUSAL_ADDED_NATIVE_USE_OR_ACTION");
    if (boundary === "AMBIGUITY") ensure(before.obligations.every(row => recovered.obligations.some(next =>
      next.obligation_id === row.obligation_id && next.consumption_id === row.consumption_id && next.effect_id === row.effect_id)),
    "Z0_S6_OBLIGATION_LOST_DURING_RECOVERY");
    if (fixture.recoveryOutcome === "UNKNOWN_RETAINED") ensure(
      unknown(before).every(row => unknown(recovered).some(next => next.obligation_id === row.obligation_id
        && next.consumption_id === row.consumption_id && next.effect_id === row.effect_id))
      && consumed(recovered).length === consumed(before).length && recovered.actions.length === before.actions.length,
      "Z0_UNKNOWN_ORIGINAL_EXPOSURE_RELEASED_OR_FORWARD_USE_ADDED");
    session.steps.push({ kind: "PHYSICAL_OWNED_PROCESS_GROUP_EXIT_RESTART", boundary, beforeProcess: identity,
      killedClaim: { jobId: killedClaim.id, claimFence: killedClaim.claim_fence,
        claimTokenSha256: sha(killedClaim.claim_token), workerId: identity.workerInstanceId },
      killedProcesses,
      exitedAt, replacement, beforeSha256: digest(before), afterExitSha256: digest(afterExit), recoveredSha256: digest(recovered),
      lifecycleStartedAt, recoveryOutcome: fixture.recoveryOutcome, externallyObservedElapsedMs: Date.now() - Date.parse(lifecycleStartedAt),
      killedDeliveryCpuSeconds: null, aggregatePeakMemoryBytes: null, money: null,
      meterGaps: ["KILLED_DELIVERY_CPU_MEMORY_MONEY_UNOBSERVED", "EXTERNAL_LIFECYCLE_NOT_AN_S7_ROW"] });
    return recovered;
  } finally { if (paused && identity) process.kill(-identity.pid, "SIGCONT"); }
}
async function mount(session, fixture) {
  const page = session.page;
  ensure(/^[0-9a-f-]{36}$/.test(fixture.threadId), "Z0_ACTUAL_NATIVE_THREAD_ID_REQUIRED");
  await page.goto(session.target.frontendOrigin + "/centropy/investigations/" + fixture.threadId, { waitUntil: "domcontentloaded" });
  const panel = page.locator(`.ct-application-semantics[data-application-work="${fixture.workId}"]`).first();
  await panel.waitFor({ state: "visible", timeout: 30000 });
  ensure(await panel.getAttribute("data-application-work") === fixture.workId, "Z0_MOUNTED_ORIGINAL_WORK_MISMATCH");
  for (const text of fixture.mountedExpectedTexts) ensure(await panel.getByText(text, { exact: false }).count() > 0, "Z0_MOUNTED_EXPECTATION_MISSING");
  await page.reload({ waitUntil: "domcontentloaded" }); await panel.waitFor({ state: "visible", timeout: 30000 });
  const work = await session.browserContext.request.get(session.target.frontendOrigin + "/api/centropy/works/" + fixture.workId);
  ensure(work.ok() && subset(await work.json(), fixture.mountedExpectedWorkResponse), "Z0_RELOADED_ORIGINAL_WORK_HTTP_MISMATCH");
  session.steps.push({ kind: "REAL_OWNER_MOUNT_RELOAD_ORIGINAL_WORK", workId: fixture.workId, threadId: fixture.threadId,
    mountedSession: await panel.getAttribute("data-application-session"), expectedTextsSha256: digest(fixture.mountedExpectedTexts) });
  const screenshot = resolve(output, session.target.kind.toLowerCase() + "-" + fixture.id + "-mounted.png");
  await page.screenshot({ path: screenshot, fullPage: true,
    mask: [page.getByText(envValue(session.target.ownerEmailEnv), { exact: false })] });
  session.steps.push({ kind: "REDACTED_SYNTHETIC_MOUNT_SCREENSHOT", sha256: sha(await readFile(screenshot)) });
}
async function runCase(session, obligation, fixture) {
  session.steps = []; currentCase = { target: session.target.kind, id: obligation.id };
  ensure(fixture.id === obligation.id && fixture.oracleProvenance === "ORIGINAL_STANDING_INPUTS_NOT_LEARNED_MODEL",
    "Z0_INDEPENDENT_CASE_ORACLE_REQUIRED");
  const before = await snapshot(session, fixture);
  session.beforeRefusalIds = new Set(before.refusals.map(eventKey));
  ensure(before.work.length === 1 && before.inputs.at(-1)?.id === fixture.workInputId, "Z0_ORIGINAL_NATIVE_FIXTURE_NOT_DELIVERED");
  for (const step of fixture.prepare ?? []) await call(session, step);
  let after;
  if (obligation.family === "QUERY") {
    const response = await observeNative(session, "QUERY", fixture.query, fixture.queryOptions);
    after = await snapshot(session, fixture);
    ensure(digest(before.globalCounts) === digest(after.globalCounts) && before.inputs.length === after.inputs.length
      && before.work[0].status === after.work[0].status, "Z0_OBSERVATION_STEERED_OR_CREATED_WORK");
    ensure(subset(response, fixture.expectedNativeResponse), "Z0_NATIVE_QUERY_ORIGINAL_ORACLE_MISMATCH");
    if (obligation.outcome === "ORIGINAL_IDENTITY") {
      const actual = response.response;
      ensure(actual?.workId === fixture.workId && actual.workInputId === fixture.workInputId
        && actual.result.execution.workId === fixture.workId && actual.result.execution.workInputId === fixture.workInputId
        && after.queryExecutions.some(row => row.id === actual.result.execution.id && row.work_id === fixture.workId
          && row.work_input_id === fixture.workInputId), "Z0_NATIVE_HTTP_DB_ORIGINAL_IDENTITY_REQUIRED");
    } else ensure(response.refused === true && digest(before.queryExecutions) === digest(after.queryExecutions),
      "Z0_INVALID_NATIVE_QUERY_NOT_REFUSED_BEFORE_ACCOUNTING");
  } else if (obligation.family === "INVENTORY") {
    ensure(oracle.inventory.length === 77 && oracle.inventory.every(row => row.capability && row.kind), "Z0_LITERAL_CANONICAL_DENOMINATOR_REQUIRED");
    const actual = (await observeNative(session, "INVENTORY")).inventory;
    ensure(actual?.length === oracle.inventory.length
      && digest([...actual].sort((a, b) => a.capability.localeCompare(b.capability)))
        === digest([...oracle.inventory].sort((a, b) => a.capability.localeCompare(b.capability))), "Z0_CANONICAL_INVENTORY_METADATA_MISMATCH");
    after = await snapshot(session, fixture);
  } else if (obligation.family === "RECOVERY") {
    for (const step of fixture.drive) await call(session, step);
    after = await physicalCut(session, fixture, obligation.boundary);
  } else {
    if (obligation.family === "LEARNING") ensure(before.compiler.some(row => row.program_id
      && ["WAITING", "PARTIAL"].includes(row.status)) && before.programs.length > 0
      && before.applications.length === 0 && before.reservations.length === 1
      && fixture.resourceBudgets?.length > 0, "Z0_REAL_ORIGINAL_PARENT_REQUIRED_BEFORE_LEARNING");
    if (obligation.family === "CURRENTNESS") {
      ensure(fixture.stage === obligation.stage && fixture.dependency === obligation.dependency
        && fixture.beforeMutation && fixture.afterMutation && fixture.fault?.length, "Z0_ACTUAL_CURRENTNESS_FAULT_REQUIRED");
      await waitFor(session, fixture, value => subset(value, fixture.beforeMutation));
      for (const step of fixture.fault) await call(session, step);
      await waitFor(session, fixture, value => subset(value, fixture.afterMutation)
        && digest(value) !== digest(before));
    }
    for (const step of fixture.drive) await call(session, step);
    const refusalObserved = value => observedRefusal(session, value, fixture.expectedRefusalPredicate);
    ensure(fixture.expectedDurableState && Object.keys(fixture.expectedDurableState).length > 0,
      "Z0_NONEMPTY_ORIGINAL_DURABLE_EXPECTATION_REQUIRED");
    after = await waitFor(session, fixture, value => subset(value, fixture.expectedDurableState)
      && (obligation.family !== "LEARNING" || consumed(value).length > 0 && originalOwnerObserved(value, fixture))
      && (!["REFUSAL", "CURRENTNESS"].includes(obligation.family) || refusalObserved(value)));
    if (obligation.family === "LEARNING") {
      const actualUses = consumed(after), use = actualUses.find(row => row.body?.actualOwner === "ORIGINAL_NATIVE_P1_ACTION_BRIDGE"
        && row.body?.schema === "finnor.z0.original-owner-model-use.v1");
      const action = use && after.actions.find(row => row.id === use.body.canonicalActionId);
      const checked = after.applicationArtifacts.find(row => row.body.schema === "finnor.x2.model-check.v1"
        && row.body.disposition === "ACCEPTED_EVIDENCED_DOMAIN" && row.body.falseValid === 0 && row.body.falseInvalid === 0);
      const materialized = use && after.applicationArtifacts.find(row => row.artifact_id === use.body.modelUseRef.id);
      ensure(use && checked && materialized?.body.schema === "finnor.z0.original-owner-model-materialization.v1"
        && materialized.body.predictionIsBusinessCompletion === false && action && action.action_type === fixture.owner.operation
        && digest(action.authority_context.applicationModelUseRef) === digest(use.body.modelUseRef)
        && subset(action.payload, fixture.owner.frozenPayload) && use.body.completed === false
        && originalOwnerObserved(after, fixture, action.id),
      "Z0_USEFUL_NATIVE_ARGUMENT_AND_INDEPENDENT_ORIGINAL_OWNER_ROW_REQUIRED");
      ensure(after.compute.length > 0 && after.compute.every(row => row.payload.money === null), "Z0_PHYSICAL_COMPUTE_AND_UNKNOWN_MONEY_REQUIRED");
    }
    if (["REFUSAL", "CURRENTNESS"].includes(obligation.family)) {
      ensure(consumed(after).length === consumed(before).length, "Z0_INVALID_MODEL_REACHED_NATIVE_OWNER");
      ensure(refusalObserved(after), "Z0_TYPED_ORIGINAL_REFUSAL_NOT_OBSERVED");
    }
    if (obligation.family === "STANDALONE") {
      ensure(after.applications.some(row => row.model_ref && row.check_ref)
        && before.compiler.length === 0 && after.applications.every(row => !row.request.institutionalOrigin)
        && consumed(after).length === consumed(before).length, "Z0_STANDALONE_NATIVE_MODEL_REGRESSION");
    }
    if (obligation.family === "ACCOUNTING") ensure(after.compute.length > 0 && after.obligations.length > 0
      && fixture.resourceBudgets.length > 0 && after.charges.length > 0, "Z0_ORIGINAL_S5_S6_S7_EVIDENCE_REQUIRED");
    if (obligation.family === "MOUNT" || obligation.family === "LEARNING") await mount(session, fixture);
  }
  sameOriginal(before, after, fixture);
  const report = { schema: "finnor.project-z.z0.native-case.v1", ...currentCase, status: "PASSED",
    oracleSha256: authority.oracleSha256, originalWorkId: fixture.workId, originalWorkInputId: fixture.workInputId,
    reservationId: fixture.reservationId ?? null, beforeSha256: digest(before), afterSha256: digest(after),
    actualOwnerRowsSha256: digest(after.owner ?? []), steps: session.steps, money: "UNKNOWN", completedByPrediction: false };
  await save(resolve(output, session.target.kind.toLowerCase() + "-" + obligation.id + ".json"), report);
  reports.push(report);
}
async function login(target) {
  const rootRequire = createRequire(resolve(target.root, "package.json")), pwPath = await realpath(rootRequire.resolve("@playwright/test"));
  ensure(pwPath.startsWith(target.root + sep), "Z0_BORROWED_BROWSER_DEPENDENCY_REFUSED");
  const { chromium } = rootRequire("@playwright/test");
  const browser = await chromium.launch({ executablePath: target.chromiumExecutable, headless: true });
  const session = { browser, target, worker: target.worker, steps: [] }; sessions.push(session);
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await browserContext.newPage();
  await page.goto(target.frontendOrigin + "/centropy/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(envValue(target.ownerEmailEnv));
  await page.getByLabel("Password", { exact: true }).fill(envValue(target.ownerPasswordEnv));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "What needs to move forward?" }).waitFor({ state: "visible", timeout: 30000 });
  const me = await browserContext.request.get(target.frontendOrigin + "/api/centropy/me");
  const identity = await me.json();
  ensure(me.ok() && identity.role === "owner" && identity.userId === target.actor.principalId
    && identity.tenantId === target.actor.tenantId, "Z0_REAL_MOUNTED_OWNER_AUTH_REQUIRED");
  const auth = await fetch(target.authOrigin + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: envValue(target.authAnonKeyEnv), "content-type": "application/json" },
    body: JSON.stringify({ email: envValue(target.ownerEmailEnv), password: envValue(target.ownerPasswordEnv) }),
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const token = await auth.json();
  ensure(auth.ok() && token.access_token && token.user?.id === target.actor.principalId, "Z0_REAL_NATIVE_OWNER_BEARER_REQUIRED");
  Object.assign(session, { browserContext, page, token: token.access_token });
  return session;
}
async function checkTargetSource(target) {
  const bytes = await readFile(resolve(dirname(target.root), "source-snapshot.json"));
  const source = JSON.parse(bytes);
  ensure(/^[a-f0-9]{64}$/.test(target.sourceSnapshotSha256 ?? "") && sha(bytes) === target.sourceSnapshotSha256
    && source.runtime === target.root && source.sourcePopulationSha256 === authority.sourcePopulationSha256
    && Array.isArray(source.files) && source.files.length > 0
    && sha(JSON.stringify(source.files)) === source.sourcePopulationSha256, "Z0_ACTUAL_TARGET_SOURCE_SNAPSHOT_MISMATCH");
  const driverSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  ensure(source.files.some(file => file.path === "finnor-os/scripts/project-z/z0/run-native-e2e.mjs"
    && file.sha256 === driverSha256), "Z0_NATIVE_DRIVER_NOT_BOUND_TO_FROZEN_SOURCE");
  let manifest = null, manifestDigest = null;
  if (target.kind === "INSTALLED") {
    const manifestBytes = await readFile(resolve(target.root, "finnor-os/x1-development-installation.json"));
    manifest = JSON.parse(manifestBytes); manifestDigest = sha(manifestBytes);
    ensure(manifest.source.snapshotPopulationSha256 === authority.sourcePopulationSha256
      && manifest.source.snapshotSha256 === target.sourceSnapshotSha256, "Z0_INSTALLED_SOURCE_BINDING_MISMATCH");
    ensure(target.loader === resolve(target.root, manifest.sourceCustodyAdapter.preload)
      && manifest.sourceCustodyAdapter.runtimeTypeScriptFallback === "REFUSED", "Z0_INSTALLED_JS_ONLY_LOADER_REQUIRED");
  }
  for (const file of source.files) {
    const path = resolve(target.root, file.path);
    ensure(path.startsWith(target.root + sep) && await realpath(path) === path, "Z0_TARGET_SOURCE_PATH_CHANGED");
    let expected = file.sha256;
    if (manifest && file.path === manifest.sourceCustodyAdapter.path) {
      ensure(manifest.sourceCustodyAdapter.originalSha256 === file.sha256
        && source.files.some(item => item.path === manifest.sourceCustodyAdapter.source
          && item.sha256 === manifest.sourceCustodyAdapter.installedSha256), "Z0_UNDECLARED_INSTALLED_CUSTODY_TRANSFORM");
      expected = manifest.sourceCustodyAdapter.installedSha256;
    } else if (manifest && file.path === "next-env.d.ts") {
      const generated = manifest.generatedFrontendChanges.find(item => item.path === file.path);
      if (generated) {
        const actual = await readFile(path, "utf8");
        ensure(generated.originalSha256 === file.sha256
          && sha(actual.replaceAll('import "./.next-x1-install/types/', 'import "./.next/types/')) === file.sha256,
        "Z0_UNDECLARED_INSTALLED_FRONTEND_TRANSFORM");
        expected = generated.generatedSha256;
      }
    }
    ensure(sha(await readFile(path)) === expected, "Z0_TARGET_SOURCE_BYTES_CHANGED");
  }
  if (manifest) {
    const require = createRequire(resolve(target.root, "finnor-os/package.json"));
    const installed = require(resolve(target.root, "finnor-os/packages/source-custody/installation.cjs")).installedRuntime(true);
    ensure(installed?.manifestDigest === manifestDigest, "Z0_ACTUAL_INSTALLED_ASSET_CUSTODY_REQUIRED");
  }
  sourceBindings.push({ kind: target.kind, sourceSnapshotSha256: sha(bytes), sourcePopulationSha256: source.sourcePopulationSha256,
    originalSourceFiles: source.files.length, manifestSha256: manifestDigest, runtimeTypeScriptFallback: manifest ? "REFUSED" : "SOURCE_TARGET" });
}
async function main() {
  if (opts.plan || opts.doctor) {
    ensure(!opts.run, "Z0_PLAN_CANNOT_RUN_NATIVE");
    console.log(JSON.stringify({ ...nativePlan, driverSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      authority: "NOT_DELIVERED", database: "NOT_RUN", auth: "NOT_RUN", browser: "NOT_RUN", physicalRecovery: "NOT_RUN",
      driver: opts.doctor ? "NETWORK_FREE_AUTHORITY_GUARD_DOCTOR" : "NETWORK_FREE_EXECUTABLE_PLAN" }));
    return;
  }
  ensure(opts.run && opts.ack === "ALLOW_Z0_DISPOSABLE_NATIVE_FLOW_ONLY"
    && opts.authority?.startsWith("/") && existsSync(opts.authority), "Z0_NATIVE_AUTHORITY_NOT_DELIVERED");
  authority = JSON.parse(await readFile(opts.authority, "utf8"));
  ensure(authority.schema === "finnor.project-z.z0.native-authority.v1" && authority.phase === "Z0"
    && authority.sessionId === "66647028-fac4-4793-bec3-22b564d12b90"
    && Date.parse(authority.expiresAt) > Date.now() && authority.syntheticOnly === true
    && authority.fixtureOrigin === "EXISTING_CANONICAL_NATIVE_OWNER_RECORDS" && authority.effects === "DISPOSABLE_INTERNAL_ONLY"
    && authority.noProvisioning === true && authority.authBypass === false, "Z0_EXPLICIT_DISPOSABLE_NATIVE_AUTHORITY_REQUIRED");
  ensure(opts.oracle?.startsWith("/")
    && /^[a-f0-9]{64}$/.test(opts["oracle-sha256"] ?? "") && opts["oracle-sha256"] === authority.oracleSha256,
  "Z0_PRECOMMITTED_INDEPENDENT_ORACLE_REQUIRED");
  const oracleBytes = await readFile(opts.oracle);
  ensure(sha(oracleBytes) === authority.oracleSha256, "Z0_INDEPENDENT_ORACLE_BYTES_CHANGED");
  oracle = JSON.parse(oracleBytes);
  ensure(oracle.schema === "finnor.project-z.z0.original-semantics-oracle.v1"
    && oracle.candidateDerived === false && oracle.committedBeforeAcquisition === true
    && authority.targets.length === 2 && new Set(authority.targets.map(t => t.kind)).size === 2,
  "Z0_ORIGINAL_SEMANTICS_AND_SEPARATE_TARGETS_REQUIRED");
  ensure(process.versions.node.split(".")[0] === "22", "Z0_NATIVE_NODE22_REQUIRED");
  output = resolve(opts.output ?? "");
  ensure(opts.output?.startsWith("/") && output.startsWith(resolve(own, "scope-z/phase-evidence/z0") + sep)
    && !existsSync(output), "Z0_NEW_OWNED_NATIVE_EVIDENCE_REQUIRED");
  const identities = new Set();
  for (const target of authority.targets) {
    ensure(nativePlan.requiredTargets.includes(target.kind) && target.root?.startsWith("/")
      && await realpath(target.root) === target.root && target.root.startsWith(resolve(own, "scope-z/phase-evidence/z0") + sep)
      && target.sourcePopulationSha256 === authority.sourcePopulationSha256, "Z0_INDEPENDENT_EXACT_NATIVE_TARGET_REQUIRED");
    origin(target.apiOrigin); origin(target.frontendOrigin); origin(target.authOrigin);
    for (const item of target.applicationOrigins) origin(item);
    const dbIdentity = `${target.database.port}/${target.database.name}`;
    ensure(!identities.has(dbIdentity), "Z0_SEPARATELY_ISOLATED_INSTALLED_DATABASE_REQUIRED"); identities.add(dbIdentity);
    for (const process of target.ownedProcesses) await checkProcess(process);
    for (const value of [target.apiOrigin, target.frontendOrigin, ...target.applicationOrigins]) await checkListener(value, target.ownedProcesses);
    await checkOwnedWorker(target);
    ensure(target.worker.independentlySupervised === true && target.worker.cascadeOnExit === false,
      "Z0_CASCADING_OR_BORROWED_STACK_REFUSED");
    await checkTargetSource(target);
    const fixtures = oracle.targets[target.kind];
    ensure(fixtures?.length === nativePlan.cases.length && new Set(fixtures.map(f => f.id)).size === nativePlan.cases.length
      && nativePlan.cases.every(c => fixtures.some(f => f.id === c.id)), "Z0_COMPLETE_NATIVE_FIXTURE_COVERAGE_NOT_DELIVERED");
  }
  await mkdir(output, { mode: 0o700 });
  await save(resolve(output, "preflight.json"), { schema: "finnor.project-z.z0.native-preflight.v1",
    driverSha256: sha(await readFile(fileURLToPath(import.meta.url))), oracleSha256: authority.oracleSha256,
    authoritySha256: sha(await readFile(opts.authority)), sourcePopulationSha256: authority.sourcePopulationSha256,
    casesPerTarget: nativePlan.cases.length, requiredTargets: nativePlan.requiredTargets, sourceBindings,
    environmentNames: [...new Set(authority.targets.flatMap(t => [t.observerDatabaseEnv, t.ownerEmailEnv, t.ownerPasswordEnv,
      t.authAnonKeyEnv, ...Object.values(t.nativeEnvironment)]))].sort(), secretsRecorded: false });
  for (const target of authority.targets) {
    const session = await login(target);
    session.db = await observer(target);
    for (const obligation of nativePlan.cases) await runCase(session, obligation, oracle.targets[target.kind].find(f => f.id === obligation.id));
  }
  completed = true;
}
try { await main(); }
catch (error) {
  const predicate = /^[A-Z][A-Z0-9_]{1,159}$/.test(error?.message ?? "") ? error.message : "Z0_NATIVE_DRIVER_FAILED";
  const failure = { status: output && existsSync(output) ? "FAILED_NATIVE_ATTEMPT" : "NOT_RUN",
    predicate, currentCase, completedCases: reports.length, diagnosticSha256: sha(String(error?.message ?? error)) };
  if (output && existsSync(output)) await save(resolve(output, "failure.json"), failure);
  console.log(JSON.stringify(failure)); process.exitCode = 2;
} finally {
  for (const session of sessions.reverse()) {
    const failures = [];
    if (session.restarted) {
      try {
        await checkProcess(session.worker, true);
        process.kill(-session.worker.pid, "SIGTERM"); await waitExit(session.worker);
      } catch { failures.push("OWNED_RESTART_STOP"); }
    }
    try { await session.browser.close(); } catch { failures.push("BROWSER_CLOSE"); }
    try { await session.db?.end(); } catch { failures.push("OBSERVER_CLOSE"); }
    if (failures.length) {
      completed = false; process.exitCode = 2;
      if (output) await save(resolve(output, "cleanup-" + session.target.kind + ".json"), {
        status: "FAILED", predicate: "Z0_OWNED_NATIVE_CLEANUP_FAILED", failures });
    }
  }
}
if (completed) {
  await save(resolve(output, "qualification.json"), { schema: "finnor.project-z.z0.native-qualification.v1",
    status: "PASSED_DEVELOPMENT_NATIVE_AND_SEPARATE_INSTALLED", cases: reports.map(r => ({ target: r.target, id: r.id, status: r.status })),
    cleanup: "OWNED_RESTARTS_STOPPED_BROWSER_AND_OBSERVER_CLOSED", scientificIncrement: false,
    protectedAdmission: "NOT_GRANTED", production: "NOT_AUTHORIZED", money: "UNKNOWN" });
  console.log(JSON.stringify({ status: "PASSED_DEVELOPMENT_NATIVE_AND_SEPARATE_INSTALLED", cases: reports.length }));
}
