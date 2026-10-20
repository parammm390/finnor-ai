/** Preregistered review regressions against real native rows and physical reads.
 * The relay delays one real response; it never supplies product truth. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { receiveWork, withTenantTransaction } from "@finnor/db";
import type { ApplicationActionModel, ApplicationModelCheck, ApplicationTransitionEvidence } from "@finnor/shared-types";
import type { PeMutationContext } from "../../packages/private-equity/src/types";
import { withS5PortfolioTransaction } from "../../packages/private-equity/src/allocation-store";
import { revokeConnection } from "../../packages/security/src/connections";
import { applicationArtifact, applicationSession, currentApplicationWork, nativeApplicationProfile } from "../../packages/private-equity/src/application-semantics/store";
import { composeApplicationActions, assertApplicationComposition } from "../../packages/private-equity/src/application-semantics/composition";
import { projectApplicationSnapshot } from "../../packages/private-equity/src/application-semantics/observation";
import { sameApplicationScalar } from "../../packages/private-equity/src/application-semantics/contracts";

const pause = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
async function until<T>(read: () => Promise<T>, accepted: (value: T) => boolean, code: string): Promise<T> {
  const end = Date.now() + 15000;
  do { const value = await read(); if (accepted(value)) return value; await pause(20); } while (Date.now() < end);
  throw Error(code);
}
export const NATIVE_REVIEW_CASES = [
  "canonical-request-UUID-replacement-refusal",
  "canonical-application-header-connection-revocation",
  "canonical-observed-identity-composition",
  "canonical-Work-input-lock-contention",
  "canonical-read-account-revocation-after-S5-contention",
  "canonical-read-profile-revocation-after-S5-contention",
] as const;

export async function nativeReadRelay(upstream: string) {
  const origin = new URL(upstream);
  assert.equal(origin.hostname, "127.0.0.1");
  const trace: Array<{ method: string; path: string; status: number }> = [];
  let armedPath: string | null = null, captured: (() => void) | null = null, release: (() => void) | null = null;
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = []; let length = 0;
      for await (const part of request) {
        length += part.length; assert(length <= 2 * 1024 * 1024, "RELAY_REQUEST_BOUND"); parts.push(part);
      }
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter(([key, value]) => value !== undefined && !["host", "connection", "content-length"].includes(key))
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value!]));
      if (request.headers.origin) {
        const local = server.address(); assert(local && typeof local !== "string");
        assert.equal(request.headers.origin, `http://127.0.0.1:${local.port}`, "RELAY_ORIGIN_REQUIRED");
        headers.origin = origin.origin;
      }
      const target = new URL(request.url ?? "/", origin);
      assert.equal(target.origin, origin.origin);
      const reply = await fetch(target, { method: request.method, headers,
        ...(!["GET", "HEAD"].includes(request.method ?? "GET") ? { body: Buffer.concat(parts) } : {}),
        redirect: "manual", signal: AbortSignal.timeout(10000) });
      const bytes = Buffer.from(await reply.arrayBuffer());
      assert(bytes.length <= 2 * 1024 * 1024, "RELAY_RESPONSE_BOUND");
      trace.push({ method: request.method ?? "", path: target.pathname, status: reply.status });
      if (request.method === "GET" && target.pathname === armedPath) {
        armedPath = null;
        await new Promise<void>(yes => { release = yes; captured?.(); });
      }
      const responseHeaders: Record<string, string> = {};
      reply.headers.forEach((value, key) => {
        if (!["connection", "content-length", "transfer-encoding"].includes(key)) responseHeaders[key] = value;
      });
      response.writeHead(reply.status, responseHeaders);
      response.end(bytes);
    } catch { response.writeHead(502).end(); }
  });
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const address = server.address(); assert(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    trace,
    arm(path: string) {
      assert.equal(armedPath, null); assert.equal(release, null);
      armedPath = new URL(path, upstream).pathname;
      return new Promise<void>(yes => { captured = yes; });
    },
    release() { release?.(); release = null; captured = null; },
    async close() { release?.(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); },
  };
}

export async function runNativeReviewGates(input: {
  ctx: PeMutationContext; sql: pg.Client; adminUrl: string; sessionId: string; profiles: string[];
  model: ApplicationActionModel; check: ApplicationModelCheck; relay: Awaited<ReturnType<typeof nativeReadRelay>>;
  call(body: unknown): Promise<{ status: number; body: any }>;
  startWorker(id: string): Promise<{ completed: Promise<{ status: string; reason: string | null }> }>;
  record(id: string, action: () => Promise<unknown>): Promise<boolean>;
}) {
  const { ctx, sql, model, check, record } = input, tenant = ctx.auth.tenantId, actor = ctx.auth.userId;
  const original = await applicationSession(ctx, input.sessionId);
  await record(NATIVE_REVIEW_CASES[0], async () => {
    const row = (await sql.query("SELECT id FROM finnor_os.application_semantics_requests WHERE session_id=$1 AND possible_egress ORDER BY id LIMIT 1",
      [original.id])).rows[0]; assert(row, "ACTUAL_RETAINED_POSSIBLE_EGRESS_REQUEST_REQUIRED");
    let refused = false;
    await withTenantTransaction(tenant, { userId: actor }, async (_db, client) => {
      await client.query("SAVEPOINT request_uuid_probe");
      try { await client.query("UPDATE finnor_os.application_semantics_requests SET id=$2 WHERE id=$1", [row.id, randomUUID()]); }
      catch (error) {
        const failure = error as { code?: string; message?: string };
        refused = failure.code === "P0001" && failure.message === "Application request identity and possible-egress fence are immutable";
      } finally { await client.query("ROLLBACK TO SAVEPOINT request_uuid_probe"); }
    });
    assert(refused, "REQUEST_UUID_UPDATE_WAS_NOT_REFUSED_BY_IMMUTABILITY_OWNER");
    assert.equal((await sql.query("SELECT count(*)::int n FROM finnor_os.application_semantics_requests WHERE id=$1", [row.id])).rows[0].n, 1);
    return { originalRequestId: row.id, intendedTriggerRefusal: true, probeRolledBack: true };
  });
  await record(NATIVE_REVIEW_CASES[1], async () => {
    const id = randomUUID(), ref = "x2-connection-review-" + randomUUID();
    const source = (await sql.query("SELECT restrictions FROM finnor_os.auth_profiles WHERE id=$1", [input.profiles[0]])).rows[0];
    const restrictions = { ...source.restrictions, allowedPurposes: ["connection_admin"] };
    await sql.query("INSERT INTO finnor_os.auth_profiles SELECT (jsonb_populate_record(NULL::finnor_os.auth_profiles,to_jsonb(p)"
      + " || jsonb_build_object('id',$2::uuid,'auth_profile_ref',$3::text,'purpose','connection_admin','restrictions',$4::jsonb))).*"
      + " FROM finnor_os.auth_profiles p WHERE p.id=$1", [input.profiles[0], id, ref, JSON.stringify(restrictions)]);
    const result = await revokeConnection({ tenantId: tenant, actorId: actor, authProfileRef: ref });
    assert.equal(result.status, "revoked");
    const state = (await sql.query("SELECT connection_status,credential_provider,credential_ref,credential_version,connection_revision"
      + " FROM finnor_os.auth_profiles WHERE id=$1", [id])).rows[0];
    assert.equal(state.connection_status, "revoked"); assert.equal(state.credential_provider, null);
    assert.equal(state.credential_ref, null); assert.equal(state.credential_version, null);
    return { profileId: id, state, owner: "EXISTING_REVOKE_CONNECTION", externalRevocationClaimed: false };
  });
  await record(NATIVE_REVIEW_CASES[2], async () => {
    for (const operation of model.operations) for (const assignment of operation.postcondition.assignments) {
      if (assignment.value.kind !== "parameter") continue;
      const name = assignment.value.name, observed = operation.observedParameterBindings[name];
      if (!observed) continue;
      for (const ref of operation.evidenceRefs) {
        const evidence = await applicationArtifact<ApplicationTransitionEvidence>(ctx, ref);
        if (!evidence.before || !evidence.after) continue;
        const initial = { ...evidence.before, ...projectApplicationSnapshot(evidence.before, model.stateSchema) };
        const known = evidence.parameters[name];
        if (!known || typeof known !== "object" || known.kind !== "identity"
          || !sameApplicationScalar(initial.state[observed], known)
          || sameApplicationScalar(initial.state[assignment.field], known)) continue;
        const composition = composeApplicationActions({ model, check, initial,
          goal: { [assignment.field]: known }, parameters: evidence.parameters,
          originalParentRef: original.original_parent_ref, deadlineAt: new Date(Math.min(Date.now() + 60000, original.deadline_at.getTime())).toISOString(),
          authorizedRoles: [operation.authorization.role] });
        assert.equal(composition.disposition, "COMPOSED_WITH_REQUIRED_OBSERVATIONS",
          "KNOWN_OBSERVED_IDENTITY_COMPOSITION_MISSING:" + JSON.stringify({
            operationId: operation.id, observedField: observed, destinationField: assignment.field,
            originalIdentityObserved: true, disposition: composition.disposition, gaps: composition.gaps,
          }));
        assertApplicationComposition({ composition, model, check, initial });
        const step = composition.steps.find(item => item.operationId === operation.id);
        assert(step); assert.equal(step.parameterObservations[name], observed);
        assert(!Object.hasOwn(step.parameters, name), "OBSERVED_IDENTITY_MUST_NOT_BE_FROZEN_PHYSICAL_ARGUMENT");
        assert(sameApplicationScalar(step.expectedState[assignment.field], known));
        return { compositionRef: composition.ref, operationId: operation.id, observedField: observed,
          destinationField: assignment.field, retainedObservationDependency: true, executionAuthorityGranted: false };
      }
    }
    throw Error("ACTUAL_LEARNED_OBSERVED_IDENTITY_COPY_REQUIRED");
  });
  for (const kind of ["account", "profile"] as const) await record(
    kind === "account" ? NATIVE_REVIEW_CASES[4] : NATIVE_REVIEW_CASES[5], async () => {
      const work = await receiveWork({ tenantId: tenant, userId: actor, channel: "console",
        instruction: "Exercise one owned physical-read revocation boundary without a business mutation.",
        activeContext: { ...original.root }, idempotencyKey: "read-review:" + randomUUID() });
      const reply = await input.call({ ...original.request, workId: work.workId, idempotencyKey: "read-review:" + randomUUID() });
      assert.equal(reply.status, 202, "REAL_REVIEW_ACQUISITION_REGISTRATION_REQUIRED");
      const profile = await nativeApplicationProfile(ctx, input.profiles[0]!);
      const saved = (await sql.query("SELECT restrictions,connection_revision FROM finnor_os.auth_profiles WHERE id=$1", [input.profiles[0]])).rows[0];
      const account = (await sql.query("SELECT status FROM finnor_os.application_accounts WHERE id=$1", [profile.applicationAccountId])).rows[0];
      const captured = input.relay.arm(profile.profile.documentationPaths[0]!);
      let releasePortfolio: (() => void) | undefined, portfolio: Promise<unknown> | undefined, worker: Awaited<ReturnType<typeof input.startWorker>> | undefined;
      try {
        worker = await input.startWorker(reply.body.sessionId); worker.completed.catch(() => undefined);
        await Promise.race([captured, pause(15000).then(() => { throw Error("REAL_DOCUMENTATION_RESPONSE_NOT_CAPTURED"); })]);
        let blocker = 0, locked: () => void = () => {};
        const held = new Promise<void>(yes => { locked = yes; });
        portfolio = withS5PortfolioTransaction(ctx, async client => {
          blocker = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          locked(); await new Promise<void>(yes => { releasePortfolio = yes; });
        }); portfolio.catch(() => undefined);
        await held;
        input.relay.release();
        const wait = await until(async () => (await sql.query("SELECT pid,wait_event_type,wait_event FROM pg_stat_activity"
          + " WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1", [blocker])).rows[0],
        Boolean, "ACTUAL_PHYSICAL_READ_S5_CONTENTION_NOT_REACHED");
        const started = (await sql.query("SELECT count(*)::int n FROM finnor_os.application_semantics_events"
          + " WHERE session_id=$1 AND kind='PHYSICAL_READ_STARTED'", [reply.body.sessionId])).rows[0].n;
        assert.equal(started, 1, "FIRST_REAL_READ_MUST_PRECEDE_SECOND_READ_CONTENTION");
        const before = input.relay.trace.length;
        if (kind === "account") await sql.query("UPDATE finnor_os.application_accounts SET status='disabled' WHERE id=$1", [profile.applicationAccountId]);
        else {
          const restrictions = structuredClone(saved.restrictions);
          restrictions.applicationSemantics.allowedTargets = ["revoked-" + randomUUID()];
          await sql.query("UPDATE finnor_os.auth_profiles SET restrictions=$2::jsonb,connection_revision=connection_revision+1 WHERE id=$1",
            [input.profiles[0], JSON.stringify(restrictions)]);
        }
        releasePortfolio!(); await portfolio;
        const outcome = await worker.completed, subsequent = input.relay.trace.slice(before);
        assert.equal(subsequent.length, 0, "COMMITTED_NATIVE_REVOCATION_REACHED_PHYSICAL_PORTAL_READ:"
          + JSON.stringify({ kind, wait, physicalReadsBeforeContention: started, subsequent, outcome }));
        assert.notEqual(outcome.status, "MODEL_READY");
        return { kind, wait, physicalReadsBeforeContention: 1, subsequent, outcome, originalDeadline: original.parent.deadlineAt };
      } finally {
        input.relay.release(); releasePortfolio?.(); await portfolio?.catch(() => undefined);
        if (worker) await worker.completed.catch(() => undefined);
        await sql.query("UPDATE finnor_os.application_accounts SET status=$2 WHERE id=$1", [profile.applicationAccountId, account.status]);
        await sql.query("UPDATE finnor_os.auth_profiles SET restrictions=$2::jsonb,connection_revision=$3 WHERE id=$1",
          [input.profiles[0], JSON.stringify(saved.restrictions), saved.connection_revision]);
      }
    });
  await record(NATIVE_REVIEW_CASES[3], async () => {
    const controller = new pg.Client({ connectionString: input.adminUrl }); await controller.connect();
    let editor: Promise<unknown> | undefined, reader: Promise<void> | undefined;
    let committed = false, readerFailure: string | null = null;
    try {
      await controller.query("BEGIN");
      const blocker = (await controller.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await controller.query("SELECT id FROM finnor_os.works WHERE id=$1 FOR NO KEY UPDATE", [original.work_id]);
      editor = receiveWork({ tenantId: tenant, userId: actor, workId: original.work_id, channel: "console",
        instruction: "Supersede the previous disposable instruction with a new canonical input.",
        activeContext: { ...original.root }, idempotencyKey: "input-review:" + randomUUID() }); editor.catch(() => undefined);
      const writerWait = await until<{ pid: number }>(async () => (await sql.query("SELECT pid,wait_event_type,wait_event FROM pg_stat_activity"
        + " WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR NO KEY UPDATE%' LIMIT 1", [blocker])).rows[0],
      Boolean, "ACTUAL_CANONICAL_RECEIVE_WORK_LOCK_NOT_REACHED");
      reader = withTenantTransaction(tenant, { userId: actor }, async (_db, client) => {
        await currentApplicationWork(ctx, original, client);
      }).catch(error => { readerFailure = error instanceof Error ? error.message : "UNCLASSIFIED"; });
      const readerWait = await until(async () => (await sql.query("SELECT pid,wait_event_type,wait_event FROM pg_stat_activity"
        + " WHERE ($1=ANY(pg_blocking_pids(pid)) OR $2=ANY(pg_blocking_pids(pid)))"
        + " AND query LIKE '%works%' AND query LIKE '%FOR SHARE%' LIMIT 1", [blocker, writerWait.pid])).rows[0],
      Boolean, "ACTUAL_ORIGINAL_WORK_SHARE_LOCK_NOT_REACHED");
      await controller.query("COMMIT"); committed = true; await editor; await reader;
      assert.equal(readerFailure, "X2_CURRENT_ACTOR_OR_WORK_INPUT_CHANGED",
        "SUPERSEDED_WORK_INPUT_PASSED_FINAL_CURRENTNESS:" + JSON.stringify({
          writerWait, readerWait, originalInputId: original.work_input_id, readerFailure,
        }));
      return { writerWait, readerWait, originalInputId: original.work_input_id, readerFailure, actualCanonicalReceiveWork: true };
    } finally {
      if (!committed) await controller.query("ROLLBACK");
      await editor?.catch(() => undefined); await reader?.catch(() => undefined); await controller.end();
    }
  });
}
