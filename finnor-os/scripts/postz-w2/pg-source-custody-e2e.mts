/** Actual PG custody lane, not a mock or complete publication qualification.
 * Uses an already-enrolled disposable owner/worker fixture. Never provisions
 * roles, enrollments, keys, a host, a candidate COMMIT, or a model invocation. */
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { digest, byteDigest } from "../../packages/capability-evolution/src/contracts";
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer";
import { loadSpecialistPublicationScope } from "../../packages/orchestration/src/workforce-execution/specialist";
import { nativeSpecialistDefinerSignatures, type CanonicalSpecialistAuthority } from "../../packages/capability-evolution/src/specialist-publication-authority";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../apps/worker/src/queue";

const fixtureSchema = z.object({
  schema: z.literal("finnor.w2.actual-pg-source-custody-fixture.v1"),
  lane: z.enum(["FRESH_DATABASE", "ALREADY_APPLIED_UPGRADE"]),
  database: z.string().regex(/^finnor_w2_e2e_[a-z0-9_]+$/),
  enrollmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: z.string().uuid(), principalId: z.string().uuid(), programmeId: z.string().uuid(),
  assignmentId: z.string().min(1).max(160),
  foreign: z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), programmeId: z.string().uuid(),
    assignmentId: z.string().min(1).max(160), workId: z.string().uuid(), workInputId: z.string().uuid(),
    jobId: z.string().uuid(), markerPublicationId: z.string().regex(/^[a-f0-9]{64}$/),
    markerOriginalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    genuineEpisodeEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  job: z.object({ jobId: z.string().uuid(), tenantId: z.string().uuid(),
    deliveryAttemptId: z.string().uuid(), claimToken: z.string().min(16).max(4096),
    claimFence: z.number().int().positive(), protocolVersion: z.literal(1),
    workerId: z.string().min(1).max(200), retrySafety: z.string().min(1),
    leaseSeconds: z.number().int().positive() }).strict(),
}).strict();
const [fixturePath, artifactPath] = process.argv.slice(2);
if (!fixturePath || !artifactPath || !isAbsolute(fixturePath) || !isAbsolute(artifactPath)
  || process.argv.length !== 4) throw Error("W2_CUSTODY_E2E_ABSOLUTE_ARGUMENTS_REQUIRED");
const fd = await open(fixturePath, constants.O_RDONLY | constants.O_NOFOLLOW);
let bytes: Buffer;
try {
  const st = await fd.stat();
  if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 65536)
    throw Error("W2_CUSTODY_E2E_PRIVATE_FIXTURE_REQUIRED");
  bytes = await fd.readFile();
} finally { await fd.close(); }
const fixture = fixtureSchema.parse(JSON.parse(bytes.toString()));
const steps: Array<{ id: string; status: "PASS"; evidence: unknown }> = [];
const pass = (id: string, evidence: unknown) => steps.push({ id, status: "PASS", evidence });
const requireTrue = (condition: unknown, id: string) => { if (!condition) throw Error(id); };
let authority: CanonicalSpecialistAuthority | undefined;
let client: PoolClient | undefined;
let completed = false, failureCode: string | null = null;
try {
  authority = await openWorkforceSpecialistPublicationAuthority("candidate", false);
  client = await authority.candidateConnection();
  requireTrue(authority.enrollment.digest === fixture.enrollmentDigest
    && authority.enrollment.body.tenantId === fixture.tenantId
    && authority.enrollment.body.principalId === fixture.principalId
    && fixture.job.tenantId === fixture.tenantId, "W2_CUSTODY_E2E_ENROLLED_FIXTURE_MISMATCH");
  const connection = (await client.query("SELECT current_database() database,session_user login,current_user actor")).rows[0];
  requireTrue(connection.database === fixture.database
    && connection.login === authority.enrollment.body.roles.candidate
    && connection.actor === connection.login, "W2_CUSTODY_E2E_REAL_LOGIN_MISMATCH");
  pass("actual-login-no-set-role-substitution", connection);
  const connectionClient = client;
  const denied = async (id: string, sql: string, args: unknown[] = [],
    expected: "PRIVILEGE" | "ROW_WRITE_GUARD" = "PRIVILEGE") => {
    await connectionClient.query("SAVEPOINT custody_negative");
    let code: string | null = null, reason = "";
    try { await connectionClient.query(sql, args); }
    catch (error) { code = (error as {code?: string}).code ?? null; reason = String((error as Error).message); }
    finally {
      await connectionClient.query("ROLLBACK TO SAVEPOINT custody_negative");
      await connectionClient.query("RELEASE SAVEPOINT custody_negative");
    }
    requireTrue(code === "42501" || expected === "ROW_WRITE_GUARD" && code === "P0001"
      && reason === "SPECIALIST_SOURCE_ROW_LOCK_ONLY_NO_MUTATION", "W2_CUSTODY_E2E_NEGATIVE_NOT_PROVEN:" + id);
    pass(id, { sqlState: code, expected });
  };
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
    [fixture.tenantId, fixture.principalId]);
  const pendingPort = (await client.query(
    "SELECT has_function_privilege(session_user,'finnor_specialist.native_pending(uuid,uuid)','EXECUTE') allowed"
  )).rows[0]?.allowed === true;
  requireTrue(pendingPort, "W2_CUSTODY_E2E_EXACT_NATIVE_PENDING_PRIVILEGE_REQUIRED");
  pass("exact-native-pending-signature-execute", { signature: "finnor_specialist.native_pending(uuid,uuid)", allowed: true });
  requireTrue(fixture.foreign.tenantId !== fixture.tenantId
    && fixture.foreign.principalId !== fixture.principalId
    && fixture.foreign.programmeId !== fixture.programmeId, "W2_CUSTODY_E2E_GENUINE_FOREIGN_FIXTURE_REQUIRED");
  // Create these before the first scope-helper call on this backend. Do not let
  // an earlier real-table plan make an otherwise vulnerable function look safe.
  await client.query(`CREATE TEMP TABLE candidate_transactions(backend_pid integer,xid xid8,
    tenant_id uuid,principal_id uuid,programme_id uuid,assignment_id text,work_id uuid,input_id uuid,job_id uuid)`);
  await client.query(`CREATE TEMP TABLE domains(tenant_id uuid,principal_id uuid,enrollment_digest text,status text)`);
  await client.query(`CREATE TEMP TABLE enrollments(digest text,tenant_id uuid,principal_id uuid,body jsonb,evidence jsonb)`);
  await client.query("GRANT SELECT ON pg_temp.candidate_transactions,pg_temp.domains,pg_temp.enrollments TO finnor_specialist_owner");
  for (const target of [
    { tenantId: fixture.tenantId, principalId: fixture.principalId, programmeId: fixture.programmeId,
      assignmentId: fixture.assignmentId, workId: fixture.foreign.workId,
      workInputId: fixture.foreign.workInputId, jobId: fixture.job.jobId },
    fixture.foreign,
  ]) {
    const fakeDigest = digest({ target: target.programmeId, attack: "TEMP_PRIVATE_SCOPE" });
    await client.query(`INSERT INTO pg_temp.candidate_transactions VALUES
      (pg_backend_pid(),pg_current_xact_id(),$1,$2,$3,$4,$5,$6,$7)`,
      [target.tenantId, target.principalId, target.programmeId, target.assignmentId,
        target.workId, target.workInputId, target.jobId]);
    await client.query("INSERT INTO pg_temp.domains VALUES($1,$2,$3,'ACTIVE')",
      [target.tenantId, target.principalId, fakeDigest]);
    await client.query(`INSERT INTO pg_temp.enrollments VALUES($1,$2,$3,
      jsonb_build_object('roles',jsonb_build_object('candidate',session_user)),'{}')`,
      [fakeDigest, target.tenantId, target.principalId]);
  }
  const shadowDenied = async (id: string) => {
    await connectionClient.query("SAVEPOINT temp_shadow_probe");
    try {
      await connectionClient.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [fixture.foreign.tenantId, fixture.foreign.principalId]);
      const scope = (await connectionClient.query(
        "SELECT finnor_specialist.candidate_source_scope($1) scope_allowed,finnor_specialist.candidate_source_row($1,'w2_programs',$2) row_allowed",
        [fixture.foreign.tenantId, fixture.foreign.programmeId])).rows[0];
      requireTrue(scope?.scope_allowed === false && scope?.row_allowed === false, "W2_CUSTODY_E2E_TEMP_PRIVATE_SCOPE_FORGED:" + id);
      await denied("native-pending-genuine-foreign-temp-spoof-denied:" + id,
        "SELECT finnor_specialist.native_pending($1,$2)", [fixture.foreign.tenantId, fixture.foreign.programmeId]);
      pass("actual-temp-private-tables-no-foreign-authority:" + id,
        { backendAndFullXidMatched: true, ownerSelectGranted: true,
          foreignEpisodeEvidenceDigest: fixture.foreign.genuineEpisodeEvidenceDigest });
    } finally {
      await connectionClient.query("ROLLBACK TO SAVEPOINT temp_shadow_probe");
      await connectionClient.query("RELEASE SAVEPOINT temp_shadow_probe");
    }
  };
  await shadowDenied("login-before-open");
  requireTrue((await client.query("SELECT finnor_specialist.candidate_source_scope($1) allowed",
    [fixture.tenantId])).rows[0]?.allowed === false, "W2_CUSTODY_E2E_TEMP_LOCAL_SCOPE_FORGED");
  await denied("native-pending-before-private-scope-denied",
    "SELECT finnor_specialist.native_pending($1,$2)", [fixture.tenantId, fixture.programmeId]);
  const scopeIdentity = (await client.query("SELECT finnor_specialist.open_candidate_scope($1,$2,$3,$4,$5,$6,$7) value",
    [fixture.tenantId, fixture.principalId, fixture.programmeId, fixture.assignmentId,
      fixture.job.jobId, fixture.job.claimFence, byteDigest(Buffer.from(fixture.job.claimToken))])).rows[0]?.value;
  requireTrue(scopeIdentity?.sessionUser === connection.login
    && scopeIdentity?.currentUser === "finnor_specialist_owner", "W2_CUSTODY_E2E_ACTUAL_DEFINER_IDENTITY_REQUIRED");
  pass("actual-secdef-session-versus-current-user", scopeIdentity);
  const pending = (await client.query("SELECT finnor_specialist.native_pending($1,$2) value",
    [fixture.tenantId, fixture.programmeId])).rows[0]?.value;
  requireTrue(pending === null || Array.isArray(pending), "W2_CUSTODY_E2E_REAL_NATIVE_PENDING_LOADER_FAILED");
  pass("actual-native-pending-loader-in-private-scope", { pendingCount: pending?.length ?? 0 });
  await denied("native-pending-other-programme-denied", "SELECT finnor_specialist.native_pending($1,$2)",
    [fixture.tenantId, "00000000-0000-0000-0000-000000000000"]);
  await denied("native-pending-other-tenant-denied", "SELECT finnor_specialist.native_pending($1,$2)",
    ["00000000-0000-0000-0000-000000000000", fixture.programmeId]);
  const execution: JobExecutionContext = { ...fixture.job,
    retrySafety: fixture.job.retrySafety as JobExecutionContext["retrySafety"],
    registerHeartbeat() { throw Error("W2_CUSTODY_E2E_CANNOT_INVOKE_OR_RENEW"); } };
  const scope = await loadSpecialistPublicationScope({ tenantId: fixture.tenantId,
    userId: fixture.principalId, role: "owner", employeeId: fixture.principalId },
    fixture.programmeId, fixture.assignmentId, execution, client);
  pass("real-native-s5-loader-same-transaction", { programDigest: digest(scope.program),
    originalXid8: scopeIdentity.xid8, sourceScopeDigest: scope.scopeDigest });
  await shadowDenied("login-after-genuine-open");
  for (const [table, key, value] of [
    ["w2_programs", "id", fixture.programmeId],
    ["s5_reservations", "reservation_id", scope.q.budget.reservationRef.id],
  ] as const) {
    const sql = `SELECT to_jsonb(r) body FROM finnor_os.${table} r WHERE tenant_id=$1 AND ${key}=$2`;
    const args = [fixture.tenantId, value];
    const before = (await client.query(sql + " FOR SHARE", args)).rows;
    requireTrue(before.length === 1, "W2_CUSTODY_E2E_NONEMPTY_SHARE_REQUIRED:" + table);
    const locked = (await client.query(sql + " FOR UPDATE", args)).rows;
    requireTrue(locked.length === 1 && digest(locked) === digest(before),
      "W2_CUSTODY_E2E_NONEMPTY_UPDATE_LOCK_REQUIRED:" + table);
    pass("actual-share-and-update-lock:" + table, { count: 1, rowDigest: digest(before) });
    await denied("actual-noop-update-denied:" + table,
      `UPDATE finnor_os.${table} SET tenant_id=tenant_id WHERE tenant_id=$1 AND ${key}=$2`, args, "ROW_WRITE_GUARD");
    requireTrue(digest((await client.query(sql, args)).rows) === digest(before),
      "W2_CUSTODY_E2E_SOURCE_MUTATED:" + table);
  }
  await client.query("SET LOCAL ROLE finnor_specialist_candidate");
  await shadowDenied("group-after-genuine-open");
  const switched = (await client.query("SELECT session_user login,current_user actor")).rows[0];
  requireTrue(switched.login === connection.login && switched.actor === "finnor_specialist_candidate",
    "W2_CUSTODY_E2E_GROUP_NOT_LOGIN");
  pass("actual-set-role-candidate", switched);
  const groupSql = "SELECT to_jsonb(r) body FROM finnor_os.w2_programs r WHERE tenant_id=$1 AND id=$2";
  const groupArgs = [fixture.tenantId, fixture.programmeId];
  const groupBefore = (await client.query(groupSql + " FOR SHARE", groupArgs)).rows;
  const groupLocked = (await client.query(groupSql + " FOR UPDATE", groupArgs)).rows;
  requireTrue(groupBefore.length === 1 && groupLocked.length === 1 && digest(groupBefore) === digest(groupLocked),
    "W2_CUSTODY_E2E_NONEMPTY_GROUP_ROWLOCK_PRECONDITION_REQUIRED");
  pass("group-role-actual-share-and-update-lock", { count: 1, rowDigest: digest(groupBefore) });
  await denied("group-role-real-update-denied",
    "UPDATE finnor_os.w2_programs SET tenant_id=tenant_id WHERE tenant_id=$1 AND id=$2",
    groupArgs, "ROW_WRITE_GUARD");
  requireTrue(digest((await client.query(groupSql, groupArgs)).rows) === digest(groupBefore),
    "W2_CUSTODY_E2E_GROUP_SOURCE_MUTATED");
  await client.query("RESET ROLE");
  const forbidden = new Set(["finnor_app", "finnor_worker", "finnor_specialist_owner",
    ...Object.entries(authority.enrollment.body.roles).filter(([kind]) => kind !== "candidate").map(([,name]) => name)]);
  for (const role of forbidden) await denied("set-role-denied:" + role,
    'SET LOCAL ROLE "' + role.replaceAll('"', '""') + '"');
  await denied("set-session-authorization-owner-denied", "SET SESSION AUTHORIZATION finnor_specialist_owner");
  await denied("s5-write-function-execute-denied", "SELECT finnor_os.s5_consume_institution($1,$2::jsonb)",
    [scope.q.budget.reservationRef.id, "{}"]);
  await denied("source-delete-denied", "DELETE FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2",
    [fixture.tenantId, fixture.programmeId]);
  await denied("source-truncate-denied", "TRUNCATE finnor_os.w2_programs");
  await denied("source-insert-denied", "INSERT INTO finnor_os.w2_programs SELECT * FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2",
    [fixture.tenantId, fixture.programmeId]);
  await client.query("CREATE TEMP TABLE custody_trigger_probe(tenant_id uuid,id uuid,role text,legacy_role text)");
  const cut = (await client.query("SELECT finnor_specialist.read_native_acl_custody() value")).rows[0]?.value;
  requireTrue(Array.isArray(cut) && cut.length === nativeSpecialistDefinerSignatures.length
    && nativeSpecialistDefinerSignatures.every((signature, index) => cut[index]?.signature === signature),
  "W2_CUSTODY_E2E_FINITE_ACL_CUT_REQUIRED");
  for (const item of cut) {
    requireTrue(/^finnor_os\.[a-z_]+\(\)$/.test(item.signature), "W2_CUSTODY_E2E_UNEXPECTED_SIGNATURE");
    await denied("temp-trigger-definer-escape-denied:" + item.signature,
      "CREATE TRIGGER candidate_escape BEFORE INSERT ON custody_trigger_probe FOR EACH ROW EXECUTE FUNCTION " + item.signature);
  }
  await client.query("SAVEPOINT changed_guc");
  await client.query("SELECT set_config('app.user_id',$1,true)", ["00000000-0000-0000-0000-000000000000"]);
  requireTrue((await client.query("SELECT finnor_specialist.candidate_source_scope($1) allowed",
    [fixture.tenantId])).rows[0]?.allowed === false, "W2_CUSTODY_E2E_CHANGED_PRINCIPAL_NOT_FENCED");
  await denied("native-pending-changed-principal-denied", "SELECT finnor_specialist.native_pending($1,$2)",
    [fixture.tenantId, fixture.programmeId]);
  await client.query("ROLLBACK TO SAVEPOINT changed_guc");
  pass("changed-principal-source-scope-fenced", true);
  await client.query("ROLLBACK");
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
    [fixture.tenantId, fixture.principalId]);
  requireTrue((await client.query("SELECT finnor_specialist.candidate_source_scope($1) allowed",
    [fixture.tenantId])).rows[0]?.allowed === false, "W2_CUSTODY_E2E_OLD_XID_SCOPE_REUSED");
  await denied("native-pending-old-xid-denied", "SELECT finnor_specialist.native_pending($1,$2)",
    [fixture.tenantId, fixture.programmeId]);
  await client.query("ROLLBACK");
  pass("rolled-back-xid-source-scope-fenced", true);
  completed = true;
} catch (error) {
  failureCode = (error as {code?: string}).code ?? "E2E_ASSERTION_OR_QUALIFICATION_REFUSAL";
  throw Error("W2_CUSTODY_E2E_FAILED:" + failureCode);
} finally {
  if (client) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  await authority?.close();
  await writeFile(artifactPath, JSON.stringify({ schema: "finnor.w2.actual-pg-source-custody-e2e.v1",
    status: completed ? "ACL_LANE_PASSED_NOT_FULL_PUBLICATION_QUALIFICATION" : "FAILED",
    lane: fixture.lane, fixtureSha256: byteDigest(bytes), steps, failureCode,
    remaining: ["fresh-and-upgrade-ordinary-caller-positive", "native-original-commit-all-origin-witness",
      "abort-clock-unknown-races", "replay-and-register-holds", "cancellation-and-settlement-negatives"] }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
}
