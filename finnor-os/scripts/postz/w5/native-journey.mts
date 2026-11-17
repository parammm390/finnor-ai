/** Real HTTP/Core/S1/S4/S5/queue journey, with disposable canonical inputs.
 * Expected controls, deadlines, actors and budgets are frozen before delivery.
 * Administrative setup creates fixture identities, never adoption or results. */
import { strict as assert } from "node:assert";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { prepareOrganizationFixture } from "./fixture.mjs";
import { observeNativeProspectiveAssignments, type NativeProspectiveUnit } from "./prospective-native.mjs";

export async function runNativeOrganizationJourney(output: string, originalContract: unknown) {
  const backend = resolve(import.meta.dirname, "../../.."), repo = dirname(backend), start = performance.now();
  const cases: unknown[] = [], traffic: unknown[] = [], workers: unknown[] = [];
  let bytes = 0, httpOrdinal = 0;
  const checkBound = () => assert(performance.now() - start < 300000, "W5_NATIVE_ORIGINAL_WALL_BOUND");
  const remainingMilliseconds = () => { checkBound(); return Math.max(1, Math.floor(300000 - (performance.now() - start))); };
  const artifact = async (name: string, value: unknown) => {
    const path = resolve(output, name);
    assert(path.startsWith(output + "/"), "W5_EVIDENCE_PATH_BOUND");
    const content = JSON.stringify(value, (key, v) => /^(claim_token|claimToken)$/.test(key) && typeof v === "string"
      ? "sha256:" + createHash("sha256").update(v).digest("hex") : v, 2) + "\n";
    bytes += Buffer.byteLength(content);
    assert(bytes <= 128 * 1024 * 1024, "W5_NATIVE_ORIGINAL_EVIDENCE_BYTE_BOUND");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  };
  const run = async (id: string, input: unknown, expected: unknown, action: () => Promise<unknown>) => {
    checkBound();
    await artifact("cases/" + id + "-original.json", { input, expected, beforeDelivery: new Date().toISOString() });
    try {
      const observed = await action();
      checkBound();
      cases.push({ id, status: "PASS" });
      await artifact("cases/" + id + "-observed.json", observed);
      console.log(JSON.stringify({ case: id, status: "PASS" }));
      return observed;
    } catch (error) {
      cases.push({ id, status: "FAILED_RETAINED" });
      await artifact("cases/" + id + "-observed.json", { status: "FAILED_RETAINED",
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
      throw error;
    }
  };
  Object.assign(process.env, {
    NODE_ENV: "test", CI: "1", AUTH_DEV_BYPASS: "0", LOG_LEVEL: "error",
    FINNOR_ENVIRONMENT: "staging", FINNOR_P4_PROFILE: "ordinary_disposable",
    FINNOR_TEST_MANAGED_EXTENSIONS: "omit", WORKER_JOB_LEASE_SECONDS: "5", FINNOR_STEP_LEASE_SECONDS: "5",
    RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_IP_PER_MINUTE: "100000",
  });
  delete process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG;
  delete process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT;
  const port = await new Promise<number>((accept, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => accept(port));
    });
  });
  const pgDirectory = join(output, "disposable-postgres"), adminPassword = randomUUID();
  const appPassword = randomUUID(), workerPassword = randomUUID();
  const postgres = new EmbeddedPostgres({ databaseDir: pgDirectory, user: "w5_admin",
    password: adminPassword, port, persistent: false, onLog: () => undefined });
  let admin: pg.Client | null = null, auth: any = null, activeWorker: ChildProcess | null = null;
  let closePool: (() => Promise<void>) | null = null;
  try {
    await postgres.initialise();
    await appendFile(join(pgDirectory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n");
    await postgres.start(); await postgres.createDatabase("w5_organization");
    const adminUrl = `postgres://w5_admin:${adminPassword}@127.0.0.1:${port}/w5_organization`;
    const { migrate } = await import("../../../packages/db/migrate");
    const migrations = await migrate(adminUrl);
    await artifact("actual-migrations.json", { migrations });
    assert(migrations.includes("0201_postz_w5_organization_transformation.sql"));
    assert(migrations.includes("0203_postz_w5_approver_continuation.sql"));
    assert(migrations.includes("postz_w2_zz_participant_legacy_authority.sql"));
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD '" + appPassword + "'");
    await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD '" + workerPassword + "'");
    process.env.DATABASE_URL = `postgres://finnor_app:${appPassword}@127.0.0.1:${port}/w5_organization`;
    const workerUrl = `postgres://finnor_worker:${workerPassword}@127.0.0.1:${port}/w5_organization`;
    const db = await import("@finnor/db"); closePool = db.closePool;
    const tenant = randomUUID(), otherTenant = randomUUID(), company = randomUUID();
    const owner = randomUUID(), support = randomUUID(), approver = randomUUID(), digital = randomUUID();
    const provider = randomUUID(), evaluator = randomUUID(), unrelated = randomUUID(), foreign = randomUUID();
    const actors = [owner, support, approver, digital, provider, evaluator, unrelated, foreign];
    await admin.query(`INSERT INTO finnor_os.tenants(id,client_key,name)
      VALUES($1,$2,'W5 controlled company'),($3,$4,'W5 foreign company')`,
    [tenant, randomUUID(), otherTenant, randomUUID()]);
    for (const actor of actors) {
      const actorTenant = actor === foreign ? otherTenant : tenant;
      await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status)
        VALUES($1,$2,$3,$4,'active')`, [actor, actorTenant, actor + "@test.invalid",
        actor === owner || actor === foreign ? "owner" : "participant"]);
      await admin.query(`INSERT INTO finnor_os.employee_actor_profiles(tenant_id,principal_id,actor_kind)
        VALUES($1,$2,$3) ON CONFLICT(tenant_id,principal_id) DO UPDATE SET actor_kind=EXCLUDED.actor_kind,version=employee_actor_profiles.version+1`,
      [actorTenant, actor, actor === digital ? "SERVICE" : "HUMAN"]);
    }
    await db.configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0,
      createdBy: owner, sourceSystem: "w5:controlled-native" });
    await db.configureTenantVertical({ tenantId: otherTenant, verticalKey: "private_equity", expectedVersion: 0,
      createdBy: foreign, sourceSystem: "w5:controlled-native" });
    await admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
      VALUES($1,$2,$3,'Controlled W5 enterprise','other')`, [company, tenant, randomUUID()]);
    const { authenticatedApiFixture } = await import("../../frontier5/x1/authenticated-api-fixture.mjs");
    auth = await authenticatedApiFixture(repo, owner, row => traffic.push(row), {
      additionalActors: actors.slice(1), maximumActors: 8,
    });
    const tokens = new Map<string, string>([[owner, auth.token]]);
    for (const identity of auth.additionalIdentities) {
      const response = await fetch(auth.authOrigin + "/auth/v1/token?grant_type=password", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: identity.email, password: identity.password }),
      });
      assert.equal(response.status, 200);
      tokens.set(identity.actor, (await response.json() as { access_token: string }).access_token);
    }
    const request = async (method: "GET" | "POST", group: string, operation: string, body?: unknown, actor: string = owner) => {
      checkBound();
      const ordinal = ++httpOrdinal, began = performance.now();
      const response = await fetch(`${auth.origin}/api/${group}${operation ? "/" + operation : ""}`, {
        method, headers: { "content-type": "application/json", authorization: "Bearer " + tokens.get(actor) },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Math.min(30000, remainingMilliseconds())),
      });
      const result = { status: response.status, body: await response.json() as any };
      checkBound();
      await artifact("http/" + String(ordinal).padStart(4, "0") + ".json", {
        method, group, operation, actor, ...result, elapsedMs: performance.now() - began,
        cacheControl: response.headers.get("cache-control"), authorizationRecorded: false,
      });
      return result;
    };
    const http = (group: string, operation: string, body: unknown, actor: string = owner) =>
      request("POST", group, operation, body, actor);
    const ok = async (group: string, operation: string, body: unknown, actor: string = owner) => {
      const response = await http(group, operation, body, actor);
      assert.equal(response.status, 200, JSON.stringify(response)); return response.body;
    };
    const group = "organization/transformation-programs";
    const read = async (requestId: string, actor: string = owner) => {
      const result = await request("GET", group, "read?requestId=" + requestId, undefined, actor);
      assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
    };
    const tick = async (killAtCommittedAcceptance = false, maximumTicks = 1) => {
      checkBound();
      const child = spawn(process.execPath, ["--import=tsx", "scripts/postz/w3/worker.mts",
        "--maximum-ticks", String(maximumTicks)], {
        cwd: backend, env: { ...process.env, DATABASE_URL: workerUrl, NODE_OPTIONS: "--max-old-space-size=1024" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeWorker = child; let log = "", killed = false;
      const began = performance.now();
      child.stdout!.on("data", chunk => {
        log += chunk.toString();
        if (log.length > 4 * 1024 * 1024) child.kill("SIGKILL");
        if (killAtCommittedAcceptance && !killed && log.includes('"event":"W5_NATIVE_COMPUTE_ACCEPTED"')) {
          killed = true; child.kill("SIGKILL");
        }
      });
      child.stderr!.on("data", chunk => { log += chunk.toString(); if (log.length > 4 * 1024 * 1024) child.kill("SIGKILL"); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), Math.min(60000, remainingMilliseconds()));
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", (code, signal) => { clearTimeout(timer); accept({ code, signal }); });
      });
      activeWorker = null;
      const observation = { ...result, pid: child.pid, killedAtCommittedAcceptance: killed, log,
        elapsedMs: performance.now() - began, actualEntry: "scripts/postz/w3/worker.mts",
        registration: "UNMODIFIED_PRODUCTION_CREATE_WORKER", heapMiB: 1024 };
      workers.push(observation); await artifact("workers/" + workers.length + ".json", observation);
      checkBound();
      if (killAtCommittedAcceptance) { assert(killed); assert.equal(result.signal, "SIGKILL"); }
      else {
        assert.equal(result.code, 0, log);
        assert(log.includes('"current_user":"finnor_worker"') && log.includes('"rolbypassrls":false') &&
          log.includes('"rolsuper":false'), "W5_ACTUAL_RESTRICTED_WORKER_REQUIRED");
      }
      return observation;
    };
    const sourceWork = await db.receiveWork({ tenantId: tenant, userId: owner, channel: "text",
      instruction: "Controlled W5 source collection, not a field or protected outcome.",
      idempotencyKey: "w5-original-source-work", requireExactIntake: true });
    const workId = randomUUID(), deadline = new Date(Date.now() + 3600000).toISOString();
    const unitRoster: NativeProspectiveUnit[] = [];
    for (let index = 0; index < 40; index++) {
      const unit = await db.receiveWork({ tenantId: tenant, userId: owner, channel: "text",
        instruction: "Controlled predeclared resolution unit " + index +
          ". Observe authenticated packet preparation only; human time, service and invoices remain unknown.",
        idempotencyKey: "w5-original-prospective-unit:" + index, requireExactIntake: true });
      await db.attachWorkEntity(tenant, unit.workId, { entityType: "external_organization", entityId: company,
        relationship: "about", source: "w5-original-prospective-unit" });
      const original = await db.withTenantTransaction(tenant, { userId: owner }, async (_db, c) =>
        (await c.query(`SELECT id,instruction_text FROM finnor_os.work_inputs
          WHERE tenant_id=$1 AND work_id=$2 AND id=$3`, [tenant, unit.workId, unit.workInputId])).rows[0]);
      assert(original, "W5_REAL_ORIGINAL_UNIT_INPUT_REQUIRED");
      unitRoster.push({ workId: unit.workId, workInputId: original.id,
        workInputDigest: createHash("sha256").update(original.instruction_text).digest("hex") });
    }
    await artifact("original-prospective-work-roster.json", { company, owner, units: unitRoster,
      declaredBeforeProgrammeAcceptance: true, unitCount: 40, originalComputeRequestCeiling: 64,
      noAssignmentsOrHumanOutcomesSupplied: true, noReplacementUnits: true });
    // Reviewed W2 fixture pattern: explicit pre-existing canonical grants, not
    // an enrollment side effect, inherited legacy role or owner promotion.
    const participantRole = randomUUID(), retainedReadRole = randomUUID();
    await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
      VALUES($1,$2,'w5-controlled-existing-participant','Controlled existing contract participation'),
            ($3,$2,'w5-controlled-retained-work-read','Controlled explicit Work read after role change')`,
      [participantRole, tenant, retainedReadRole]);
    const scope = JSON.stringify({ kind: "resources", resourceType: "work",
      resourceIds: [sourceWork.workId, workId, ...unitRoster.map(unit => unit.workId)] });
    // Contract responses retain their native assignment resource. Work reads
    // are separately scoped to the declared original programme/source/units.
    for (const actor of [support, approver, digital, provider])
      await admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)
        VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb)`, [tenant, actor, participantRole]);
    await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
      VALUES($1,$2,'action:workforce_respond_contract','workforce_assignment','allow','low')`, [tenant, participantRole]);
    await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
      VALUES($1,$2,'query:work','work','allow','low')`, [tenant, retainedReadRole]);
    for (const actor of [owner, support, approver, digital, provider, evaluator])
      await admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)
        VALUES($1,$2,$3,$4::jsonb)`, [tenant, actor, retainedReadRole, scope]);
    await artifact("canonical-controlled-existing-standing-authority.json", {
      participantRole, retainedReadRole, owner, participants: [support, approver, digital, provider, evaluator],
      scope: JSON.parse(scope), canonicalParticipantRole: "participant", inheritedLegacyGrant: false,
      ordinaryFixtureGrantSetupNotEnrollment: true, financialOrProtectedCapabilityGranted: false,
      genuineHumanAdoptionOrProviderEmploymentProven: false,
      patternSource: "REVIEWED_W2_CANONICAL_PARTICIPANT_AUTHORITY_AND_LEGACY_DEMOTION_NATIVE_FIXTURE",
    });
    const now = new Date(Date.now() - 1000).toISOString();
    const declaration = (id: string, body: unknown) => ({
      owner: "BUSINESS_OWNER", id, version: "authenticated-controlled-declaration-v1",
      contentDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    });
    const resourceBody = {
      schema: "finnor.allocation-resource.v1", resourceId: "w5-native-request", tenantId: tenant,
      ownerRef: declaration(owner, { owner }), legalEntityRef: declaration(company, { company }),
      scopeRef: declaration("w5-controlled-native", { sourceWorkId: sourceWork.workId }),
      permittedRoots: [{ entityType: "work", entityId: workId }], rightsRef: "w5-controlled-owner-resource-rights",
      unit: "request", currency: null, kind: "CUMULATIVE_EXPENDITURE", resourceClass: "COMPUTE",
      horizon: { startAt: now, periodMs: 3600000, periods: 1 },
      sourceRef: declaration("w5-resource-declaration", { resourceClass: "COMPUTE", capacity: 64 }),
      asOf: now, knowledgeAt: now, validUntil: deadline, beliefPins: [],
      availability: ["64", "64"].map(amount => ({ amount, basis: "REPORTED_AVAILABLE" })),
      existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
      qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED",
    };
    await artifact("original-resource-declaration.json", resourceBody);
    const resource = await ok("allocations", "resource", { resource: resourceBody });
    const fixture = await prepareOrganizationFixture({ http, artifact }, {
      sourceWorkId: sourceWork.workId, workId, ownerId: owner, evaluatorId: evaluator, companyId: company,
      roles: { support, approver, digital, provider }, obligations: [],
      resources: { resourceRefs: [resource.ref], schedules: [{ resourceId: resourceBody.resourceId, quantities: ["64", "0"] }] },
      originalDeadline: deadline, key: "original-w5-native",
    });
    const intake = await run("authenticated-original-intake", fixture.intake,
      { workId, originalDeadline: deadline, originalApproverPrincipalId: approver, publicationBeforeWorker: false },
      async () => {
        const first = await ok(group, "intake", fixture.intake), replay = await ok(group, "intake", fixture.intake);
        assert.equal(first.workId, workId); assert.equal(first.requestId, replay.requestId); assert.equal(replay.semanticReplay, true);
        const before = await read(first.requestId); assert.equal(before.program, null);
        return { first, replay, before };
      }) as any;
    const id = intake.first.requestId;
    await run("original-query-preserves-work", { requestId: id, workId },
      { steeringInputs: 0, changedPlans: 0, changedResourceOrEffectRecords: 0 }, async () => {
        const snapshot = async () => {
          const records: Record<string, unknown> = {};
          for (const table of ["works", "work_inputs", "work_plan_revisions", "s5_resources", "s5_resource_heads",
            "s5_reservations", "s5_consumptions", "business_effects"]) {
            const rows = await admin!.query(`SELECT to_jsonb(t) AS record FROM finnor_os.${table} t
              WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [tenant]);
            records[table] = rows.rows.map(row => row.record);
          }
          return records;
        };
        const before = await snapshot();
        const query = { intent: "organization_transformation_v1", requestId: id, workId };
        const replies = [];
        for (const suffix of ["first", "replay"]) {
          const response = await http("queries", "", { ...query, executionKey: "w5-original-query:" + suffix });
          assert.equal(response.status, 201, JSON.stringify(response));
          assert.equal(response.body.workId, workId);
          assert.equal(response.body.workInputId, intake.first.workInputId);
          assert.equal(response.body.result.data.requestId, id);
          assert.equal(response.body.result.data.workInputId, intake.first.workInputId);
          assert.equal(response.body.result.data.fieldBenefitEstablished, false);
          assert.equal(response.body.result.data.newAuthorityGranted, false);
          replies.push(response);
        }
        const denied = [];
        for (const invalid of [{ ...query, requestId: "invalid" }, { ...query, userId: owner },
          { ...query, alternativeId: "" }]) {
          const response = await http("queries", "", invalid);
          assert.equal(response.status, 400, JSON.stringify(response));
          denied.push(response);
        }
        const wrongWork = await http("queries", "", { ...query, workId: sourceWork.workId });
        assert.equal(wrongWork.status, 404, JSON.stringify(wrongWork));
        for (const actor of [unrelated, foreign]) {
          const response = await http("queries", "", query, actor);
          assert([403, 404].includes(response.status), JSON.stringify(response));
          assert.equal(response.body.result, undefined);
          denied.push(response);
        }
        const after = await snapshot();
        assert.deepEqual(after, before, "W5_QUERY_MUST_PRESERVE_ORIGINAL_WORK_AND_OWNERS");
        return { query, replies, denied, wrongWork, before, after };
      });
    await run("forged-physical-claim-denied", { requestId: id, fakeDelivery: true }, { accepted: false, S5ConsumptionDelta: 0 }, async () => {
      const { requireContext } = await import("../../../apps/api/lib/auth");
      const ctx = await requireContext(new Request(auth.origin + "/api/organization/transformation-programs/read", {
        headers: { authorization: "Bearer " + tokens.get(owner) },
      }));
      const { runOrganizationTransformationJob } = await import("../../../packages/private-equity/src/organization-transformation/worker");
      const count = async () => (await admin!.query("SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1", [tenant])).rows[0].n;
      const before = await count();
      await assert.rejects(() => runOrganizationTransformationJob({ tenantId: ctx.tenantId, principalId: ctx.userId,
        requestId: id, phase: "COMPILE" }, { tenantId: ctx.tenantId, jobId: randomUUID(), claimToken: randomUUID(),
          claimFence: 1, deliveryAttemptId: randomUUID(), workerId: "counterfeit-physical-worker" } as any), /W5_PHYSICAL_CLAIM_FENCED/);
      assert.equal(await count(), before); return { refused: true, S5ConsumptionDelta: 0 };
    });
    await run("restricted-physical-compile", { requestId: id }, { requiredOriginalControls: fixture.originalControlIds,
      approverPrincipalId: approver, fieldBenefitEstablished: false }, async () => {
      await tick(); const result = await read(id); assert(result.program);
      assert.equal(result.program.claims.fieldBenefit, false);
      const alternative = result.program.alternatives.find((a: any) => a.kind === "PREPARED_HANDOFF");
      assert(alternative?.constructedAssets.some((a: any) => a.kind === "EVIDENCE_CONTRACT"));
      const originalControls = alternative.processes[0].nodes.filter((n: any) => fixture.originalControlIds.includes(n.id));
      assert.deepEqual(originalControls.map((n: any) => n.id), fixture.originalControlIds);
      assert.equal(alternative.roles.find((r: any) => r.id === "approver").principalId, approver);
      assert.equal(originalControls.find((n: any) => n.id === "original-approval").mandatory, true);
      return result;
    });
    let view = await read(id), selected = view.program.alternatives.find((a: any) => a.kind === "PREPARED_HANDOFF");
    const originalBudget = view.nativeBudgetRef, originalInput = view.workInputId;
    await ok(group, "action", { requestId: id, expectedRevision: view.revision, idempotencyKey: "select-current-graph",
      action: { kind: "SELECT", alternativeId: selected.id } });
    await run("physical-accepted-kill-and-recovery", { requestId: id, originalBudget, originalInput, originalDeadline: deadline },
      { actualSIGKILL: true, expiredPhysicalDelivery: true, originalBudgetRetained: true, orphanCost: "UNKNOWN" }, async () => {
        await tick(true);
        const killed = (await admin!.query(`SELECT j.id,j.status,j.lease_expires_at,a.id attempt_id,a.claim_fence,a.outcome
          FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id
          WHERE j.tenant_id=$1 AND j.payload->>'requestId'=$2 AND j.status='running' ORDER BY a.started_at DESC LIMIT 1`,
        [tenant, id])).rows[0];
        assert(killed, "W5_PHYSICAL_KILL_MUST_PRECEDE_QUEUE_FINISH");
        const delay = killed.lease_expires_at.getTime() - Date.now() + 50;
        assert(delay >= 0 && delay <= 6000); await new Promise(done => setTimeout(done, delay));
        await tick();
        const recovered = await read(id);
        assert.equal(recovered.program.selectedAlternativeId, selected.id);
        assert.deepEqual(recovered.nativeBudgetRef, originalBudget); assert.equal(recovered.workInputId, originalInput);
        assert.equal(recovered.originalDeadline, deadline);
        const orphan = (await admin!.query(`SELECT body FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2
          AND kind='ORPHANED_DELIVERY_RETAINED_UNKNOWN'`, [tenant, id])).rows;
        assert.equal(orphan.length, 1); assert.equal(orphan[0].body.deliveryAttemptId, killed.attempt_id);
        assert.equal(orphan[0].body.resourceEnvelopeRetained, true);
        return { killed, recovered, orphan };
      });
    await run("private-participant-and-cross-tenant", { requestId: id, roleParticipants: [support, approver, digital, provider] },
      { ownerImpersonationDenied: true, unrelatedDenied: true, foreignDenied: true, onlySelfDisclosure: true }, async () => {
        for (const actor of [unrelated, foreign]) assert.equal((await request("GET", group, "read?requestId=" + id, undefined, actor)).status, 404);
        const own = await read(id, digital); assert.equal(own.access, "PARTICIPANT");
        assert.equal(own.parentPrivateDataDisclosed, false); assert.equal(own.offers.length, 1);
        assert.equal(own.offers[0].role_id, "digital"); assert.equal(own.program, undefined);
        const offer = own.offers[0];
        const denied = await http(group, "adoption", { requestId: id, roleId: "digital", alternativeId: selected.id,
          termsDigest: offer.terms_digest, decision: "ADOPT", idempotencyKey: "cannot-impersonate" }, owner);
        assert.equal(denied.status, 403);
        return { own, denied, unrelatedDenied: true, foreignDenied: true };
      });
    await run("actual-self-adoption-not-installation", { requestId: id, roles: ["support", "approver", "digital", "provider"] },
      { authenticatedDecisionCount: 4, actualUseBeforeDelivery: false }, async () => {
        for (const actor of [support, approver, digital, provider]) {
          const self = await read(id, actor), offer = self.offers[0];
          await ok(group, "adoption", { requestId: id, roleId: offer.role_id, alternativeId: offer.alternative_id,
            termsDigest: offer.terms_digest, decision: "ADOPT", idempotencyKey: "self-adopt" }, actor);
        }
        await tick(false, 4); const result = await read(id);
        assert.equal(result.program.status, "ADOPTED"); assert.equal(result.program.adoptions.length, 4);
        assert.equal(result.program.claims.observedOperation, false); return result;
      });
    view = await read(id);
    await ok(group, "action", { requestId: id, expectedRevision: view.revision, idempotencyKey: "stage-trial",
      action: { kind: "MIGRATE", stage: "TRIAL" } });
    await tick();
    await run("native-constructed-process-use", { requestId: id, processId: "resolution", roleId: "digital",
      evidence: fixture.evidence }, { originalApprovalsRetained: true, actualPreparedPacket: true, fieldBenefit: false }, async () => {
        const trial = await read(id); assert.equal(trial.program.status, "TRIAL");
        const prepared = await ok(group, "process-use", { requestId: id, workId, processId: "resolution", roleId: "digital",
          idempotencyKey: "first-native-packet", evidence: fixture.evidence }, digital);
        assert.equal(prepared.approvalGranted, false); await tick();
        const result = await read(id); assert.equal(result.nativeUses.length, 1);
        assert.equal(result.program.claims.observedOperation, true);
        assert.equal(result.nativeUses[0].result.approvalGranted, false);
        assert.equal(result.nativeUses[0].result.fullCostStatus, "UNKNOWN");
        return { prepared, result };
      });
    await run("original-approver-actual-packet-delivery-and-read",
      { requestId: id, workId, originalControlId: "original-approval", originalApprover: approver },
      { actualDelivery: true, selfOnlyRead: true, exactPacketReplay: true, approvalOrEffectInferred: false }, async () => {
        const list = await request("GET", group, "packets?requestId=" + id + "&workId=" + workId, undefined, approver);
        assert.equal(list.status, 200, JSON.stringify(list));
        assert.equal(list.body.parentPrivateDataDisclosed, false);
        const packet = list.body.packets.find((p: any) => p.control.id === "original-approval");
        assert(packet, "W5_REAL_ORIGINAL_APPROVER_PACKET_DELIVERY_REQUIRED");
        assert.equal(packet.control.roleId, "approver"); assert.equal(packet.control.kind, "APPROVE");
        assert.equal(packet.workId, workId); assert.equal(packet.disclosure.approvalGranted, false);
        assert.deepEqual(packet.disclosure.preparedEvidence.map((e: any) => e.field).sort(), ["delivery", "invoice"]);
        const input = { requestId: id, useKey: packet.useKey, controlId: packet.control.id,
          termsDigest: packet.termsDigest, packetRef: packet.packetRef,
          disclosureDigest: packet.disclosureDigest, idempotencyKey: "original-approver-read" };
        for (const actor of [owner, digital, unrelated, foreign])
          assert.equal((await http(group, "packet-read", input, actor)).status, 403);
        const wrongPacket = await http(group, "packet-read", { ...input,
          packetRef: { ...packet.packetRef, contentDigest: "0".repeat(64) } }, approver);
        assert.equal(wrongPacket.status, 409);
        const coreCounts = async () => (await admin!.query(`SELECT
          (SELECT count(*) FROM finnor_os.domain_actions WHERE tenant_id=$1) actions,
          (SELECT count(*) FROM finnor_os.business_effects WHERE tenant_id=$1) effects,
          (SELECT count(*) FROM finnor_os.s5_consumptions WHERE tenant_id=$1) consumptions`, [tenant])).rows[0];
        const before = await coreCounts();
        const first = await ok(group, "packet-read", input, approver), replay = await ok(group, "packet-read", input, approver);
        assert.equal(first.approvalGranted, false); assert.equal(first.externalEffectDispatched, false);
        assert.equal(replay.semanticReplay, true); assert.deepEqual(replay.readRef, first.readRef);
        assert.deepEqual(await coreCounts(), before);
        const reads = (await admin!.query(`SELECT participant_id,control_id,packet_ref,disclosure_digest
          FROM finnor_os.w5_control_reads WHERE tenant_id=$1 AND request_id=$2`, [tenant, id])).rows;
        assert.equal(reads.length, 1); assert.equal(reads[0].participant_id, approver);
        assert.equal(reads[0].control_id, "original-approval");
        assert.deepEqual(reads[0].packet_ref, packet.packetRef);
        assert.equal(reads[0].disclosure_digest, packet.disclosureDigest);
        return { list: list.body, wrongPacket, first, replay, reads, unchangedCore: before };
      });
    await run("prospective-native-mailbox-interruption-and-independent-evaluation",
      { requestId: id, company, units: unitRoster, originalBudget, originalInput, originalDeadline: deadline,
        computeRequestCeiling: 64 },
      { realNativeAssignments: 40, noResampling: true, sameKeyConcurrentReplay: "ONE_ORIGINAL_PACKET_AND_JOB",
        differentKey: "DENIED", assignedUseInterruption: "SAME_ORIGINAL_MAILBOX_OR_NOT_OBSERVED",
        ordinaryRoleForgedNativeInsert: "SQLSTATE_42501", evaluation: "UNIDENTIFIED", unknownMoneyAndHumanTime: null },
      async () => {
        let firstSubmitted: any = null, concurrentReplay: unknown = null, recoveredUse: unknown = null;
        const probeRequest = async (method: "GET" | "POST", apiGroup: string, operation: string,
          value: unknown, actor: string) => {
          const input = value as any;
          if (method !== "POST" || apiGroup !== group || operation !== "process-use" ||
              !input?.trialAssignmentRef || firstSubmitted)
            return request(method, apiGroup, operation, value, actor);
          // The genuine original-arm negative is intentionally left untouched.
          const trial = await request("GET", group, "trial?requestId=" + id, undefined, owner);
          assert.equal(trial.status, 200);
          const assignment = trial.body.assignments.find((a: any) => a.body.unit.workId === input.workId);
          if (assignment?.body.arm !== "TRANSFORMED") return request(method, apiGroup, operation, value, actor);
          firstSubmitted = { input, actor };
          const [first, concurrent] = await Promise.all([
            request(method, apiGroup, operation, value, actor),
            request(method, apiGroup, operation, value, actor),
          ]);
          assert.equal(first.status, 200, JSON.stringify(first));
          assert.equal(concurrent.status, 200, JSON.stringify(concurrent));
          assert.deepEqual(first.body.packetRef, concurrent.body.packetRef);
          assert.equal(first.body.jobId, concurrent.body.jobId);
          assert.equal([first.body.semanticReplay, concurrent.body.semanticReplay].filter(Boolean).length, 1);
          const duplicate = await http(group, "process-use", { ...input,
            idempotencyKey: input.idempotencyKey + ":other" }, actor);
          assert.equal(duplicate.status, 409);
          assert.equal(duplicate.body.error, "W5_ASSIGNED_UNIT_ORIGINAL_MAILBOX_CANNOT_BE_REPLACED");
          concurrentReplay = { first, concurrent, duplicate };
          return first;
        };
        const probeTick = async (maximumTicks: number) => {
          if (!firstSubmitted || recoveredUse) return tick(false, maximumTicks);
          await tick(true);
          const rows = (await admin!.query(`SELECT j.id,j.payload,j.lease_expires_at,a.id delivery_id,
            m.assignment_id,m.idempotency_key,m.packet_ref,m.job_id FROM finnor_os.jobs j
            JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id AND a.finished_at IS NULL
            JOIN finnor_os.w5_trial_use_mailboxes m ON m.tenant_id=j.tenant_id AND m.job_id=j.id
            WHERE j.tenant_id=$1 AND j.payload->>'requestId'=$2 AND j.status='running'`, [tenant, id])).rows;
          assert.equal(rows.length, 1, "W5_ACTUAL_INTERRUPTED_ASSIGNED_MAILBOX_REQUIRED");
          const original = rows[0], packetInput = original.payload.processUse;
          assert(packetInput?.trialAssignmentRef);
          const repeated = await ok(group, "process-use", packetInput && {
            requestId: packetInput.requestId, workId: packetInput.workId, processId: packetInput.processId,
            roleId: packetInput.roleId, idempotencyKey: packetInput.idempotencyKey,
            trialAssignmentRef: packetInput.trialAssignmentRef, evidence: packetInput.evidence,
          }, packetInput.authenticatedPrincipalId);
          assert.equal(repeated.semanticReplay, true); assert.equal(repeated.jobId, original.job_id);
          assert.deepEqual(repeated.packetRef, original.packet_ref);
          const denied = await http(group, "process-use", { requestId: packetInput.requestId,
            workId: packetInput.workId, processId: packetInput.processId, roleId: packetInput.roleId,
            trialAssignmentRef: packetInput.trialAssignmentRef, evidence: packetInput.evidence,
            idempotencyKey: packetInput.idempotencyKey + ":after-loss" }, packetInput.authenticatedPrincipalId);
          assert.equal(denied.status, 409);
          const delay = Math.max(0, original.lease_expires_at.getTime() - Date.now() + 50);
          assert(delay <= 6000); await new Promise(done => setTimeout(done, delay));
          await tick(false, maximumTicks);
          const retained = (await admin!.query(`SELECT assignment_id,idempotency_key,packet_ref,job_id
            FROM finnor_os.w5_trial_use_mailboxes WHERE tenant_id=$1 AND assignment_id=$2`,
            [tenant, original.assignment_id])).rows[0];
          assert.equal(retained.job_id, original.job_id); assert.equal(retained.idempotency_key, original.idempotency_key);
          assert.deepEqual(retained.packet_ref, original.packet_ref);
          const orphan = (await admin!.query(`SELECT body FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2
            AND kind='ORPHANED_DELIVERY_RETAINED_UNKNOWN' AND body->>'deliveryAttemptId'=$3`,
            [tenant, id, original.delivery_id])).rows;
          assert.equal(orphan.length, 1); assert.equal(orphan[0].body.resourceEnvelopeRetained, true);
          recoveredUse = { original, repeated, denied, retained, orphan, noNewMailboxOrEpisode: true };
          return recoveredUse;
        };
        const observation = await observeNativeProspectiveAssignments({
          request: probeRequest, tick: probeTick, artifact, read: () => read(id), checkBound,
        }, { requestId: id, companyId: company, ownerId: owner, evaluatorId: evaluator, digitalId: digital,
          originalDeadline: deadline, key: "w5-native-prospective", units: unitRoster, evidence: fixture.evidence });
        const roleDenials: unknown[] = [];
        for (const table of ["w5_trial_assignments", "w5_process_uses"] as const) {
          let denied: any = null, actualRole: unknown = null;
          try {
            await db.withTenantTransaction(tenant, { userId: owner }, async (_db, c) => {
              actualRole = (await c.query(`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
              assert.equal((actualRole as any).current_user, "finnor_app");
              assert.equal((actualRole as any).rolsuper, false); assert.equal((actualRole as any).rolbypassrls, false);
              const available = (await c.query(`SELECT 1 FROM finnor_os.${table} WHERE tenant_id=$1 AND request_id=$2 LIMIT 1`,
                [tenant, id])).rows;
              assert.equal(available.length, 1, "W5_FORGERY_NEGATIVE_NEEDS_GENUINE_VISIBLE_PREIMAGE");
              await c.query(`INSERT INTO finnor_os.${table} SELECT * FROM finnor_os.${table}
                WHERE tenant_id=$1 AND request_id=$2 LIMIT 1 ON CONFLICT DO NOTHING`, [tenant, id]);
              throw new Error("W5_ORDINARY_ROLE_NATIVE_INSERT_NOT_DENIED");
            });
          } catch (error) { denied = error; }
          assert.equal(denied?.code, "42501", table + " must reject through RLS before conflict handling");
          roleDenials.push({ table, actualRole, sqlState: denied.code, rolledBack: true, copiedExistingRowOnly: true });
        }
        const evaluation = await ok(group, "evaluation", { requestId: id, idempotencyKey: "native-fixed-roster-evaluation" });
        assert.equal(evaluation.status, "UNIDENTIFIED");
        assert.equal(evaluation.causalContext.assignmentVerified, true);
        assert.equal(evaluation.causalContext.causalBenefitEstablished, false);
        assert.equal(evaluation.fullCost.monetaryCostMinor, null);
        assert.equal(evaluation.fullCost.humanSupervisionSeconds, null);
        assert.equal(evaluation.fieldBenefitEstablished, false); assert.equal(evaluation.economicRecordRef.owner, "S7");
        const final = await read(id);
        assert.deepEqual(final.nativeBudgetRef, originalBudget); assert.equal(final.workInputId, originalInput);
        assert.equal(final.originalDeadline, deadline);
        return { observation, roleDenials, evaluation, final, concurrentReplay: concurrentReplay ??
          { status: "NOT_OBSERVED_NO_TRANSFORMED_UNIT_IN_GENUINE_DRAW" }, recoveredUse: recoveredUse ??
          { status: "NOT_OBSERVED_NO_TRANSFORMED_UNIT_IN_GENUINE_DRAW" }, fullW5Qualification: false };
      });
    await run("participant-original-source-revocation-withdraws-terms",
      { requestId: id, organizationRef: fixture.original.organization.ref, participant: digital },
      { currentTermsBefore: true, currentTermsAfter: false, exactOldAdoptionDenied: true }, async () => {
        const before = await read(id, digital), offer = before.offers[0];
        assert.equal(offer.currentness.status, "CURRENT"); assert(offer.disclosure);
        const nativeSource = (await admin!.query(`SELECT s.id,s.metadata FROM finnor_os.evidence_sources s
          JOIN finnor_os.evidence_source_versions v ON v.tenant_id=s.tenant_id AND v.source_id=s.id
          WHERE v.tenant_id=$1 AND v.id=$2`, [tenant, fixture.original.organization.ref.id])).rows[0];
        assert(nativeSource, "W5_REAL_ORIGINAL_SOURCE_BEFORE_REVOCATION_REQUIRED");
        await admin!.query(`UPDATE finnor_os.evidence_sources SET metadata=metadata||'{"revoked":true}'::jsonb
          WHERE tenant_id=$1 AND id=$2`, [tenant, nativeSource.id]);
        const after = await read(id, digital);
        assert.equal(after.offers[0].currentness.status, "INVALIDATED"); assert.equal(after.offers[0].disclosure, null);
        const denied = await http(group, "adoption", { requestId: id, roleId: offer.role_id,
          alternativeId: offer.alternative_id, termsDigest: offer.terms_digest, decision: "ADOPT",
          idempotencyKey: "cannot-adopt-revoked-original-source" }, digital);
        assert.equal(denied.status, 409); assert.equal(denied.body.error, "W5_CURRENT_SELF_CONTRACT_REQUIRED");
        return { before, nativeSource, after, denied, actualCanonicalSourceMetadataRevoked: true };
      });
    await run("former-owner-with-work-read-has-no-parent-projection",
      { requestId: id, originalOwner: owner, newActualRole: "participant", workId },
      { canonicalWorkReadRetained: true, parentOwnerProjectionUnavailable: true }, async () => {
        await admin!.query("UPDATE finnor_os.users SET role='participant' WHERE tenant_id=$1 AND id=$2", [tenant, owner]);
        const { requireContext } = await import("../../../apps/api/lib/auth");
        const ctx = await requireContext(new Request(auth.origin + "/api/organization/transformation-programs/read", {
          headers: { authorization: "Bearer " + tokens.get(owner) },
        }));
        const { canExerciseWorkforceAuthorityTx } = await import("@finnor/authority");
        const permitted = await db.withTenantTransaction(tenant, { userId: owner }, async (_db, client) =>
          canExerciseWorkforceAuthorityTx(ctx, { operation: "query", capability: "query:work",
            workId, resource: { type: "work", id: workId }, risk: "low" }, client));
        assert.equal(permitted, true, "W5_ROLE_DOWNGRADE_NEGATIVE_REQUIRES_RETAINED_REAL_WORK_QUERY_AUTHORITY");
        const result = await request("GET", group, "read?requestId=" + id, undefined, owner);
        assert.equal(result.status, 404); assert.notEqual(result.body.access, "OWNER");
        assert.equal(result.body.program, undefined); assert.equal(result.body.nativeBudgetRef, undefined);
        return { actualRole: ctx.role, canonicalWorkReadRetained: permitted, result };
      });
    await artifact("verified-basic-native-checkpoint.json", { requestId: id, workId, originalInput, originalBudget,
      originalDeadline: deadline, sourceClass: "CONTROLLED", qualification: "NATIVE_HTTP_WORKER_NOT_FIELD",
      verifiedCases: cases, requiredOriginalContract: originalContract,
      remainingRequiredProof: ["COMPLETE_LIVE_OBLIGATION_CONTINUATION", "CAUSAL_FULL_COST_EVALUATION"] });
    assert.fail("W5_NATIVE_REQUIRED_ORIGINAL_EFFECT_CONTINUATION_AND_EVALUATION_NOT_YET_OBSERVED");
  } finally {
    if (activeWorker) activeWorker.kill("SIGKILL");
    await artifact("native-run-summary.json", { cases, httpRequests: httpOrdinal, workerProcesses: workers.length,
      bytes, elapsedMs: performance.now() - start, qualification: "CONTROLLED_NOT_FIELD_OR_PROTECTED" });
    await artifact("authenticated-transport.json", { traffic });
    if (auth) await auth.close();
    if (closePool) await closePool();
    if (admin) await admin.end();
    await postgres.stop().catch(() => undefined);
  }
}
