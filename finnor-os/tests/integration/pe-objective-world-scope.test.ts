import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import {
  FinnorOrchestrator, LLMPlanner, createDefaultPluginRegistry, registerProvider,
  type LLMProvider, type PlanningResult,
} from "@finnor/orchestration";
import { configureAgentProfile } from "../../packages/orchestration/src/workforce-runtime";
import { resolveProviderForPurpose } from "../../packages/orchestration/src/llm";
import { createDeal, createDealRisk, createWorkstream, createFund, createOpportunity, createStrategy, type PeMutationContext } from "@finnor/private-equity";
import type { CanonicalOperationalQueryRequest, ObjectiveSuccessCondition, PeWorldRootRef } from "@finnor/shared-types";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { startHeartbeat } from "../../apps/worker/src/heartbeat";
import { readWorkerFleetReadiness } from "../../apps/api/lib/worker-readiness";
import { browserHttpFixture } from "../../scripts/v2/browser-http-fixture.mjs";
import { operatingSelection } from "../../../src/components/centropy/world/world-context";
import { buildConstraintSet, type PlanningConstraint } from "@finnor/planning";

// Authoring gate: this owns the authenticated non-Deal objective regression.
// A real owner world read and the generic graph test do not exercise HTTP intake,
// accepted scope, Deal fallback, principal restoration or economic completion.
// Only the model proposal is deterministic; owners, authority, plans, queries,
// receipts and completion checks are real and no success receipt is supplied.
const SOURCE_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const available = await (async () => {
  if (!SOURCE_DATABASE_URL) return false;
  assertDisposableDatabaseTarget(SOURCE_DATABASE_URL, "PE objective world-scope E2E");
  const client = new pg.Client({ connectionString: SOURCE_DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
})();

describe.skipIf(!available)("authenticated PE objective world scope", () => {
  const tenantId = randomUUID(), foreignTenantId = randomUUID();
  const actorId = randomUUID(), otherActorId = randomUUID(), foreignActorId = randomUUID();
  const companyId = randomUUID(), roleId = randomUUID();
  const runId = randomUUID();
  const evidenceDirectory = process.env.FINNOR_PE_OBJECTIVE_EVIDENCE_DIR ?? join(tmpdir(), "finnor-pe-objective-world-scope", runId);
  const observations: Array<Record<string, unknown>> = [];
  let sourceCut: Record<string, unknown>;
  const originalEnvironment = Object.fromEntries(["DATABASE_URL", "SECRETS_PROVIDER", "HEALTHCHECK_PING_URL"].map(key => [key, process.env[key]]));
  let admin: pg.Client;
  let http: Awaited<ReturnType<typeof browserHttpFixture>>;
  let heartbeat: ReturnType<typeof startHeartbeat>;
  const heartbeatStop = new AbortController();
  let opportunity: PeWorldRootRef, fund: PeWorldRootRef, foreignFund: PeWorldRootRef;
  let incidentalDealId: string;
  let analysisRisk: Awaited<ReturnType<typeof createDealRisk>> | undefined;
  const ctx: PeMutationContext = { auth: { tenantId, userId: actorId, employeeId: actorId, role: "owner" }, provenance: { sourceSystem: "integration:pe-objective-world-scope", createdBy: actorId } };

  async function record(step: string, value: unknown) {
    observations.push({ step, observedAt: new Date().toISOString(), value });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, `world-scope-${runId}.json`), JSON.stringify({
      schema: "finnor.pe-objective-world-scope-e2e.v1", runId,
      qualification: "Disposable signed local authentication, ordinary SQL role, actual HTTP routes, canonical owners and Objective runtime. Deterministic proposal source; no field-profit, browser or production-activation claim.",
      rerun: "Set DATABASE_URL to the migrated disposable admin database and FINNOR_PE_OBJECTIVE_EVIDENCE_DIR to a private directory; run vitest run tests/integration/pe-objective-world-scope.test.ts from finnor-os.",
      sourceCut, inputs: { tenantId, actorId, opportunity, fund, foreignFund, incidentalDealId }, observations,
    }, null, 2) + "\n");
  }

  function context(root: PeWorldRootRef, shape: "selected" | "focused" | "businessRoot" = "selected") {
    return {
      version: 1, capturedAt: new Date().toISOString(), source: "text",
      selectedEntities: shape === "selected" ? [root] : [], excludedEntities: [],
      ...(shape === "focused" ? { focusedEntity: root } : {}),
      ...(shape === "businessRoot" ? { businessRoot: root } : {}),
      surface: { id: "world", route: "/centropy", spatialState: "detail" }, filters: [],
    };
  }

  function readContract(root: PeWorldRootRef): ObjectiveSuccessCondition {
    return { version: 1, source: "explicit", mode: "all", statement: "Inspect the exact selected PE world record; this is a factual read, not a profit outcome.", criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 0 },
      { kind: "canonical_query", request: { intent: "pe_world_state", root }, assertion: { path: ["root", "entityId"], operator: "eq", expected: root.entityId } },
    ] };
  }

  function runtimeFor(root: PeWorldRootRef) {
    // This protocol fixture must select an actual advertised read. It cannot
    // compensate for a missing planner binding by manufacturing the request.
    const provider: LLMProvider = { name: "world-scope-proposal-fixture", contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user);
      const request = input.snapshot.availableReads.map((item: { request: Record<string, unknown> }) => item.request)
        .find((item: { intent?: string; root?: PeWorldRootRef }) => item.intent === "pe_world_state" && item.root?.entityType === root.entityType && item.root.entityId === root.entityId);
      await record("planner-advertised-reads", { expectedRoot: root, availableReads: input.snapshot.availableReads, canonicalEntities: input.snapshot.canonicalEntities });
      expect(request, "The ordinary planner must advertise the exact accepted non-Deal world read").toBeDefined();
      const criteria = input.goal.criteria as Array<{ id: string }>;
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "inspect-accepted-world-root", nodes: [
        { key: "inspect_world", kind: "query", request, supports: criteria.map(item => item.id) },
        ...criteria.map((item, index) => ({ key: `check_${index}`, kind: "check", criterionId: item.id, dependsOn: ["inspect_world"] })),
      ] }] });
    } };
    return new FinnorOrchestrator({ planner: new LLMPlanner(createDefaultPluginRegistry(), provider) });
  }

  async function state(workId: string) {
    const work = (await admin.query("SELECT id::text,status,active_context,failure FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenantId, workId])).rows[0];
    const input = (await admin.query("SELECT id::text,context_snapshot FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId, workId])).rows[0];
    const loop = (await admin.query("SELECT id::text,state,created_by::text,success_condition,max_steps,max_actions,max_queries,deadline_at,query_count FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId])).rows[0];
    const links = (await admin.query("SELECT entity_type,entity_id::text,relationship FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 ORDER BY entity_type,entity_id", [tenantId, workId])).rows;
    const queries = (await admin.query("SELECT id::text,intent,status,request,result_summary FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 ORDER BY started_at,id", [tenantId, workId])).rows;
    const plans = (await admin.query("SELECT id::text,status,plan_graph,completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision", [tenantId, workId])).rows;
    return { work, input, loop, links, queries, plans };
  }

  async function start(root: PeWorldRootRef, options: { shape?: "selected" | "focused" | "businessRoot"; economic?: boolean } = {}) {
    const body = {
      objective: options.economic ? "Increase this fund's attributable net profit by USD 100 million, after all costs. A record read does not establish that result." : "Inspect the exact selected investment-world record and report its recorded state.",
      channel: "text", idempotencyKey: `world-scope:${randomUUID()}`, activeContext: context(root, options.shape),
      ...(!options.economic ? { successCondition: readContract(root) } : {}),
      budgets: { maxSteps: 8, maxActions: 1, maxQueries: 16, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() },
    };
    const result = await http.request("objectives", body);
    await record("authenticated-objective-intake", { body, result });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.objective?.objectiveLoopId).toBeTruthy();
    return result.body.objective as { workId: string; objectiveLoopId: string; workInputId: string };
  }

  async function drive(objective: { workId: string; objectiveLoopId: string }, root: PeWorldRootRef) {
    const runtime = runtimeFor(root), outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runtime.runObjectiveIteration({ tenantId, ...objective });
      outcomes.push(outcome);
      if (["completed", "blocked", "failed", "cancelled", "awaiting_approval", "waiting"].includes(outcome)) break;
    }
    const current = await state(objective.workId);
    await record("objective-runtime-observation", { root, outcomes, current });
    return current;
  }

  beforeAll(async () => {
    assertDisposableDatabaseTarget(SOURCE_DATABASE_URL, "PE objective world-scope setup");
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    sourceCut = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim(),
      workingPatchSha256: createHash("sha256").update(patch).digest("hex"),
      workingPatch: `source-${runId}.patch`, node: process.version, migrationHead: CURRENT_MIGRATION_HEAD,
    };
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, `source-${runId}.patch`), patch);
    admin = new pg.Client({ connectionString: SOURCE_DATABASE_URL });
    await admin.connect();
    sourceCut.postgresVersion = (await admin.query("SHOW server_version")).rows[0].server_version;
    // Migrations create the restricted role; a fresh CI service has not enabled
    // its fixture-only login. Never depend on another test file doing this first.
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    const applicationRole = (await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='finnor_app'")).rows[0];
    expect(applicationRole).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    await record("disposable-application-role", applicationRole);
    expect((await admin.query("SELECT max(name COLLATE \"C\") AS head FROM finnor_os._migrations")).rows[0].head).toBe(CURRENT_MIGRATION_HEAD);
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'PE world objective'),($3,$4,'Foreign PE world objective')", [tenantId, randomUUID(), foreignTenantId, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$4,$6,'owner','active','World operator'),($2,$4,$7,'owner','active','Other operator'),($3,$5,$8,'owner','active','Foreign operator')", [actorId, otherActorId, foreignActorId, tenantId, foreignTenantId, `${actorId}@world.test.invalid`, `${otherActorId}@world.test.invalid`, `${foreignActorId}@world.test.invalid`]);
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'World scope company','other')", [companyId, tenantId, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'World objective authority')", [roleId, tenantId, `world-${runId}`]);
    await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{\"kind\":\"tenant\"}'::jsonb)", [tenantId, actorId, roleId]);
    await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)", [tenantId, roleId]);
    const applicationUrl = new URL(SOURCE_DATABASE_URL); applicationUrl.username = "finnor_app"; applicationUrl.password = "finnor_app";
    await closePool(); process.env.DATABASE_URL = applicationUrl.toString(); process.env.SECRETS_PROVIDER = "env"; delete process.env.HEALTHCHECK_PING_URL;
    await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorId, sourceSystem: "integration:world-scope" });
    await configureTenantVertical({ tenantId: foreignTenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: foreignActorId, sourceSystem: "integration:world-scope" });
    const strategy = await createStrategy(ctx, { name: "World-scope strategy" });
    opportunity = { entityType: "pe_opportunity", entityId: String((await createOpportunity(ctx, { strategyId: String(strategy.row.id), targetOrganizationId: companyId, name: "Explicit pre-Deal opportunity" })).row.id) };
    fund = { entityType: "pe_fund", entityId: String((await createFund(ctx, { name: "Explicit investment fund", baseCurrency: "USD", vintageYear: 2026 })).row.id) };
    const foreignCtx: PeMutationContext = { auth: { tenantId: foreignTenantId, userId: foreignActorId, employeeId: foreignActorId, role: "owner" } };
    foreignFund = { entityType: "pe_fund", entityId: String((await createFund(foreignCtx, { name: "Foreign private fund", baseCurrency: "USD" })).row.id) };
    incidentalDealId = String((await createDeal(ctx, { targetOrganizationId: companyId, name: "Unrelated sole active Deal", dealLeadEmployeeId: actorId, signedLoiAt: new Date("2026-09-01"), targetClosingAt: new Date("2026-12-01") })).row.id);
    await configureAgentProfile(tenantId, createDefaultPluginRegistry(), { key: `world-${runId}`, name: "World query worker", actor: ctx.auth, capabilityGrants: [{ kind: "query", capability: "query:pe_world_state" }, { kind: "query", capability: "query:party_context" }, { kind: "check", capability: "check:objective_success" }], autonomyLimits: { maxActions: 1, maxQueries: 11, maxReplans: 8, maxPlannerCalls: 8, maxWallClockMs: 120_000 } });
    http = await browserHttpFixture(admin, tenantId, actorId, otherActorId);
    heartbeat = startHeartbeat(1_000, heartbeatStop.signal);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const fleet = await readWorkerFleetReadiness();
      if ((fleet.legacyCompatibleWorkers ?? 0) > 0 || fleet.computeReady) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(ready, "Real worker heartbeat must satisfy the ordinary intake readiness guard").toBe(true);
    await record("setup", { currentMigrationHead: CURRENT_MIGRATION_HEAD, transport: "actual signed local bearer HTTP", runtimeSqlRole: "finnor_app", evidenceDirectory });
  }, 120_000);

  afterAll(async () => {
    heartbeatStop.abort();
    await heartbeat?.markDraining();
    await http?.close();
    await closePool();
    await admin?.end();
    for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log(`PE_OBJECTIVE_WORLD_SCOPE_EVIDENCE ${join(evidenceDirectory, `world-scope-${runId}.json`)}`);
  });

  it.each([
    "Analyze this deal. Identify the 5 biggest closing risks. Rank by severity and show evidence.",
    "For every claim you just made, show its exact source, timestamp, and confidence. Separate facts from assumptions.",
    "Identify conflicting financial figures across this deal's documents. Show both values and their sources.",
    "Find the highest-impact EBITDA improvement opportunity. Quantify upside, assumptions, confidence, implementation cost, and evidence gaps.",
  ])("retains analytical instructions as durable Work instead of an unrelated party lookup: %s", async (instruction) => {
    const response = await http.request("actions", {
      instruction, channel: "text", idempotencyKey: `analysis-routing:${randomUUID()}`,
    });
    await record("analytical-instruction-intake", { instruction, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.objective?.objectiveLoopId).toBeTruthy();
    const current = await state(response.body.workId);
    expect(current.loop.id).toBe(response.body.objective.objectiveLoopId);
    expect(current.loop.state).toBe("continue");
    expect(current.queries).toEqual([]);
  });

  it.each(["supported", "polite_supported", "unknown_reference", "rejected_review", "rights_revoked", "cancelled"])("grounds selected Deal analysis and preserves publication boundaries: %s", async (mode) => {
    const statement = "Synthetic concentration risk: the principal customer renewal remains unverified.";
    if (!analysisRisk) {
      const workstream = await createWorkstream(ctx, { dealId: incidentalDealId, kind: "financial_diligence", name: "Financial source review", owner: { partyType: "employee", partyId: actorId } });
      analysisRisk = await createDealRisk(ctx, { dealId: incidentalDealId, workstreamId: String(workstream.row.id), statement, severity: "high", owner: { partyType: "employee", partyId: actorId } });
    }
    const risk = analysisRisk;
    const providerKey = `analysis-${runId}`;
    const liveModels = process.env.FINNOR_GROUNDED_ANALYSIS_LIVE === "1" && mode === "supported";
    const priorAnswer = process.env.LLM_PROVIDER_ANSWER_TEXT, priorCritic = process.env.LLM_PROVIDER_CRITIC_TEXT;
    const modelInputs: unknown[] = [];
    const modelDeadlines: number[] = [];
    let denyId: string | undefined;
    let cancelledInstruction: string | undefined;
    registerProvider(providerKey, () => ({ name: providerKey, contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user); modelInputs.push(input);
      expect(options.timeoutMs).toBe(20_000);
      modelDeadlines.push(z.number().finite().parse(options.deadlineAt));
      expect(input.registeredCapabilities).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "query:pe_world_state", kind: "query" })]));
      const claim = input.canonicalEvidence?.claims?.find((item: { ownerRef: { id: string } }) => item.ownerRef.id === risk.row.id);
      expect(claim, "The actual risk and its immutable owner evidence must reach the responder").toBeDefined();
      if (input.phase === "grounded_analysis_review") {
        if (mode === "rights_revoked") denyId = String((await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'query:pe_world_state','*','deny','high',false) RETURNING id", [tenantId, roleId])).rows[0].id);
        if (mode === "cancelled") {
          cancelledInstruction = String((await admin.query("SELECT id FROM finnor_os.instruction_sessions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId])).rows[0].id);
          const cancellation = await http.request(`instructions/${cancelledInstruction}/cancel`, {});
          await record("grounded-analysis-concurrent-cancellation", cancellation);
          expect(cancellation.status).toBe(200);
        }
        return JSON.stringify({ status: mode === "rejected_review" ? "UNSUPPORTED" : "SUPPORTED", issues: mode === "rejected_review" ? ["The proposed assessment is not supported."] : [] });
      }
      return JSON.stringify({ summary: "The available registered records identify closing risk; five independent risks are not established.", assessments: [{ claimId: mode === "unknown_reference" ? foreignFund.entityId : claim.id, analysis: "An unverified renewal is an unresolved closing risk; this assessment does not establish an actual loss." }], assumptions: [], limitations: ["The registered risk record is not the underlying customer contract."] });
    } }));
    if (!liveModels) { process.env.LLM_PROVIDER_ANSWER_TEXT = providerKey; process.env.LLM_PROVIDER_CRITIC_TEXT = providerKey; }
    try {
      if (liveModels) {
        const startedAt = Date.now();
        try {
          const control = await resolveProviderForPurpose("answer", "text").complete({
            system: "Return OK only.", user: "Transport control. Return OK.",
            tenantId, traceId: randomUUID(), purpose: "answer", channel: "text",
            deadlineAt: startedAt + 15_000, timeoutMs: 10_000, maxOutputTokens: 16,
          });
          await record("grounded-analysis-live-transport-control", { elapsedMs: Date.now() - startedAt, response: control });
          expect(control.trim()).toContain("OK");
        } catch (error) {
          await record("grounded-analysis-live-transport-control", { elapsedMs: Date.now() - startedAt, error: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
          throw error;
        }
      }
      const instruction = mode === "polite_supported" ? "Can you analyze this deal and identify its biggest closing risks?"
        : "Analyze this deal. Identify the 5 biggest closing risks. Rank by severity and show evidence.";
      const body = { instruction, channel: "text", idempotencyKey: `grounded-analysis:${randomUUID()}`, activeContext: context({ entityType: "pe_deal", entityId: incidentalDealId }) };
      const response = liveModels ? await (async () => {
        const login = await fetch(http.authOrigin + "/auth/v1/token?grant_type=password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: http.loginEmail, password: "local-disposable-no-authority" }), signal: AbortSignal.timeout(5_000) });
        const token = z.object({ access_token: z.string().min(1) }).parse(await login.json());
        try {
          const result = await fetch(http.origin + "/api/actions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token.access_token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
          return { status: result.status, body: await result.json() };
        } catch (error) {
          await record("grounded-analysis-live-failure-stage", {
            error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            works: (await admin.query("SELECT id,status,failure FROM finnor_os.works WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 3", [tenantId])).rows,
            events: (await admin.query("SELECT phase,payload FROM finnor_os.instruction_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 12", [tenantId])).rows,
            calls: (await admin.query("SELECT purpose,provider,model,status,detail FROM finnor_os.llm_calls WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 4", [tenantId])).rows,
          });
          throw error;
        }
      })() : await http.request("actions", body);
      await record("grounded-analysis-http-result", { mode, liveModels, instruction, response, modelInputs, modelDeadlines });
      expect(new Set(modelDeadlines).size).toBeLessThanOrEqual(1);
      const liveCalls = liveModels ? (await admin.query("SELECT provider,model,purpose,status,input_tokens,output_tokens,detail FROM finnor_os.llm_calls WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows : [];
      if (liveModels) await record("grounded-analysis-live-diagnostics", { calls: liveCalls, events: (await admin.query("SELECT phase,payload FROM finnor_os.instruction_events WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows });
      expect(JSON.stringify(modelInputs)).not.toContain(foreignFund.entityId);
      if (mode !== "supported" && mode !== "polite_supported") {
        expect(response.status, JSON.stringify(response.body)).toBe(500);
        if (mode === "cancelled") {
          expect((await state(response.body.workId)).work.status).toBe("cancelled");
          expect((await admin.query("SELECT id FROM finnor_os.instruction_events WHERE tenant_id=$1 AND instruction_id=$2 AND phase='completed'", [tenantId, cancelledInstruction])).rows).toEqual([]);
          expect(response.body.error).toBe("GROUNDING_WORK_CANCELLED");
          expect(response.body.answer).toBeUndefined();
          return;
        }
        const expectedError = mode === "unknown_reference" ? "GROUNDING_CITATION_UNAVAILABLE"
          : mode === "rejected_review" ? "GROUNDED_ANALYSIS_UNSUPPORTED" : "GROUNDING_SOURCE_OR_RIGHTS_CHANGED";
        expect(response.body.error).toBe(expectedError);
        expect(response.body.answer).toBeUndefined();
        expect((await state(response.body.workId)).work.status).toBe("failed");
        return;
      }
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.objective).toBeUndefined();
      expect(response.body.answer.spokenSummary).toContain(statement);
      expect(response.body.answer.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: String(risk.row.id), kind: "CANONICAL" })]));
      const thread = await http.read(`threads/${response.body.threadId}`);
      expect(thread.status).toBe(200);
      expect(thread.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", originalText: response.body.answer.spokenSummary })]));
      const current = await state(response.body.workId);
      expect(current.work.status).toBe("completed");
      expect(current.loop).toBeUndefined();
      expect(current.queries).toEqual(expect.arrayContaining([expect.objectContaining({ intent: "pe_world_state", status: "succeeded" })]));
      expect((await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, response.body.workId])).rows).toEqual([]);
      if (liveModels) {
        expect(liveCalls).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: "answer", status: "completed" }), expect.objectContaining({ purpose: "critic", status: "completed" })]));
      }
    } finally {
      if (denyId) await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND id=$2", [tenantId, denyId]);
      if (priorAnswer === undefined) delete process.env.LLM_PROVIDER_ANSWER_TEXT; else process.env.LLM_PROVIDER_ANSWER_TEXT = priorAnswer;
      if (priorCritic === undefined) delete process.env.LLM_PROVIDER_CRITIC_TEXT; else process.env.LLM_PROVIDER_CRITIC_TEXT = priorCritic;
    }
  }, 60_000);

  it("advertises and executes the authenticated employee's exact party-context read", async () => {
    const request = { intent: "party_context", ref: { partyType: "employee", partyId: actorId } } satisfies CanonicalOperationalQueryRequest;
    const response = await http.request("objectives", {
      objective: `Inspect the canonical context of employee ${actorId}.`, channel: "text",
      idempotencyKey: `employee-context:${randomUUID()}`, activeContext: context(fund, "businessRoot"),
      successCondition: { version: 1, source: "explicit", mode: "all", statement: "Read the exact authenticated employee record; no business effect is requested.", criteria: [
        { kind: "no_open_execution" }, { kind: "all_objective_effects_verified", minimumCount: 0 },
        { kind: "canonical_query", request, assertion: { path: ["party", "ref", "partyId"], operator: "eq", expected: actorId } },
      ] },
      budgets: { maxSteps: 8, maxActions: 0, maxQueries: 12, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const objective = response.body.objective as { workId: string; objectiveLoopId: string };
    const provider: LLMProvider = { name: "grounded-party-query-fixture", contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user);
      const advertised = input.snapshot.availableReads.map((item: { request: Record<string, unknown> }) => item.request);
      await record("authenticated-employee-advertised-reads", { actorId, advertised });
      expect(advertised, "Copying an advertised query must retain the authenticated employee reference").toContainEqual(request);
      const criteria = input.goal.criteria as Array<{ id: string }>;
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "read-authenticated-employee", nodes: [
        { key: "read_employee", kind: "query", request, supports: criteria.map(item => item.id) },
        ...criteria.map((item, index) => ({ key: `check_${index}`, kind: "check", criterionId: item.id, dependsOn: ["read_employee"] })),
      ] }] });
    } };
    const runtime = new FinnorOrchestrator({ planner: new LLMPlanner(createDefaultPluginRegistry(), provider) });
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runtime.runObjectiveIteration({ tenantId, ...objective });
      if (["completed", "blocked", "failed", "cancelled", "awaiting_approval", "waiting"].includes(outcome)) break;
    }
    const current = await state(objective.workId);
    await record("authenticated-employee-read-result", current);
    expect(current.loop.state).toBe("completed");
    expect(current.queries).toEqual(expect.arrayContaining([expect.objectContaining({ intent: "party_context", status: "succeeded", request })]));
  });

  it.each([false, true])("enforces draft-only against a send proposal with supplied constraints %s", async (suppliedConstraints) => {
    const response = await http.request("objectives", {
      objective: "Resolve every outstanding diligence request. Draft necessary follow-ups, but do not send anything.",
      channel: "text", idempotencyKey: `draft-only:${randomUUID()}`, activeContext: context(fund, "businessRoot"),
      budgets: { maxSteps: 8, maxActions: 1, maxQueries: 12, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const objective = response.body.objective as { workId: string; objectiveLoopId: string };
    const plans: PlanningResult[] = [];
    const provider: LLMProvider = { name: "adversarial-draft-only-fixture", contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user);
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "attempt-forbidden-send", nodes: [
        { key: "send_despite_instruction", kind: "action", actionType: "send_message", payload: { recipient: { partyType: "employee", partyId: actorId }, channel: "internal", body: "This must never be sent." }, supports: input.goal.criteria.map((item: { id: string }) => item.id) },
        ...input.goal.criteria.map((item: { id: string }, index: number) => ({ key: `check_${index}`, kind: "check", criterionId: item.id, dependsOn: ["send_despite_instruction"] })),
      ] }] });
    } };
    const delegate = new LLMPlanner(createDefaultPluginRegistry(), provider);
    const preservedDeadline: PlanningConstraint = {
      id: "independent-work-deadline", kind: "deadline", source: "work", strength: "hard", scope: { type: "plan" },
      requirement: { deadlineAt: new Date(Date.now() + 60_000).toISOString() },
      provenance: { ref: "disposable-work-deadline", hash: "independent-deadline-fixture" },
    };
    const runtime = new FinnorOrchestrator({ planner: { async plan(instruction, tenantContext, memory, options) {
      const initial = await delegate.plan(instruction, tenantContext, memory, options);
      const plan = suppliedConstraints ? await delegate.plan(instruction, tenantContext, memory, {
        ...options, constraints: buildConstraintSet({ ...initial.constraints, prohibitedCapabilities: [], constraints: [...initial.constraints.constraints, preservedDeadline] }),
      }) : initial;
      plans.push(plan); return plan;
    } } });
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runtime.runObjectiveIteration({ tenantId, ...objective });
      if (["completed", "blocked", "failed", "cancelled", "awaiting_approval", "waiting"].includes(outcome)) break;
    }
    await record("draft-only-adversarial-planning", plans);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      if (suppliedConstraints) expect(plan.constraints.constraints).toContainEqual(preservedDeadline);
      expect(plan.constraints.prohibitedCapabilities).toEqual(expect.arrayContaining(["send_message", "place_call", "notify_group", "share_document", "computer_task", "delegate_objective"]));
      expect(plan.compilation.selected).toBeNull();
      expect(plan.compilation.candidates.flatMap(candidate => candidate.violations)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "CAPABILITY_NOT_ALLOWED", nodeKey: "send_despite_instruction" }),
      ]));
    }
    const current = await state(objective.workId);
    const effects = (await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, objective.workId])).rows;
    await record("draft-only-persisted-no-send", { current, effects });
    expect(effects).toEqual([]);
    expect(current.loop.success_condition.criteria).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "decision_evidence", accepted: expect.arrayContaining(["business_effect"]) }),
    ]));
  });

  it("retains an explicitly selected opportunity instead of linking the sole incidental Deal, then verifies only its accepted factual-read contract", async () => {
    // Contract: accepted pre-Deal subject survives HTTP intake and real planning.
    // Defect: generic Deal fallback silently captures unrelated non-Deal work.
    const objective = await start(opportunity);
    const accepted = await state(objective.workId);
    await record("accepted-opportunity-scope", accepted);
    expect(accepted.loop.created_by).toBe(actorId);
    expect(accepted.work.active_context.selectedEntities).toEqual([opportunity]);
    expect(accepted.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(accepted.input.context_snapshot?.selectedEntities).toEqual([opportunity]);
    const current = await drive(objective, opportunity);
    expect(current.loop.state).toBe("completed");
    expect(current.queries.some(row => row.intent === "pe_world_state" && row.status === "succeeded" && row.request.root?.entityId === opportunity.entityId)).toBe(true);
    expect(current.plans.some(row => row.completion_proof?.verified === true)).toBe(true);
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
  });

  it("accepts an explicit fund businessRoot without requiring a fake Deal", async () => {
    // Contract: an objective can name its business subject independently of UI focus.
    // Defect: schema strips/rejects businessRoot or later treats the fund as a Deal.
    const objective = await start(fund, { shape: "businessRoot" });
    const accepted = await state(objective.workId);
    await record("accepted-fund-business-root", accepted);
    expect(accepted.work.active_context.businessRoot).toEqual(fund);
    expect(accepted.input.context_snapshot.businessRoot).toEqual(fund);
    expect(accepted.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect((await drive(objective, fund)).loop.state).toBe("completed");
  });

  it("reads the selected fund through Centropy's actual selection builder and instruction route", async () => {
    // The objective endpoint cannot prove the interactive classifier or request
    // builder. A dropped root otherwise redirects this finite read into a Deal
    // lookup or an unsupported long-running objective.
    const activeContext = { ...context(fund), ...operatingSelection(fund, null) };
    const response = await http.request("actions", {
      instruction: "Show world state for the selected fund.", channel: "text",
      idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-selected-fund-query", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.query?.request).toEqual({ intent: "pe_world_state", root: fund });
    expect(response.body.query?.result.root).toEqual(fund);
    const current = await state(response.body.workId);
    expect(current.input.context_snapshot.businessRoot).toEqual(fund);
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(current.queries).toHaveLength(1);
    expect(current.queries[0].request).toEqual({ intent: "pe_world_state", root: fund });
  });

  it("refuses an unrelated focused Deal before Centropy's fast-read lane executes it", async () => {
    // A same-tenant focus is not proof of membership in the accepted fund. The
    // objective-only refusal does not cover this separate synchronous read path.
    const activeContext = { ...context(fund), ...operatingSelection(fund, {
      namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal", id: incidentalDealId,
    }) };
    const response = await http.request("actions", {
      instruction: "Show deal closing readiness.", channel: "text",
      idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-unrelated-deal-refusal", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.query).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("Unrelated sole active Deal");
    const current = await state(response.body.workId);
    expect(current.loop).toBeUndefined();
    expect(current.queries).toEqual([]);
  });

  it("keeps the fund and unresolved profit outcome through Centropy's ordinary objective intake", async () => {
    const activeContext = { ...context(fund), ...operatingSelection(fund, null) };
    const response = await http.request("actions", {
      instruction: "Ensure this fund increases attributable net profit by USD 100 million after all costs.",
      channel: "text", idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-fund-profit-intake", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const objective = { workId: String(response.body.workId), objectiveLoopId: String(response.body.objective?.objectiveLoopId) };
    expect(response.body.objective?.objectiveLoopId).toBeTruthy();
    const current = await drive(objective, fund);
    expect(current.input.context_snapshot.businessRoot).toEqual(fund);
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(current.loop.state).not.toBe("completed");
    expect(current.plans.every(row => row.completion_proof?.verified !== true)).toBe(true);
  });

  it("retains an exact internal recipient alongside the fund without treating the recipient as a different investment subject", async () => {
    // Conversation resolution carries exact recipients in selectedEntities. A
    // fund's institutional graph is not the owner of employee membership; the
    // ordinary tenant/party and action-authority boundaries still own that.
    const activeContext = {
      ...context(fund),
      ...operatingSelection(fund, { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_fund", id: fund.entityId }),
      selectedEntities: [fund, { entityType: "user", entityId: otherActorId }],
    };
    const response = await http.request("actions", {
      instruction: "Ensure this fund's recorded state is inspected, then prepare an internal handoff to the selected operator.",
      channel: "text", idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-fund-recipient-intake", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const current = await state(String(response.body.workId));
    expect(current.input.context_snapshot.businessRoot).toEqual(fund);
    expect(current.input.context_snapshot.selectedEntities).toContainEqual({ entityType: "user", entityId: otherActorId });
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(current.loop.state).not.toBe("completed");
  });

  it("does not complete a fund profit objective after reading the fund, and redirect preserves the unresolved outcome and original limits", async () => {
    // Contract: successful inspection is not an economic outcome.
    // Defect: generic decision_evidence or redirect default proves only existence.
    const objective = await start(fund, { shape: "focused", economic: true });
    const accepted = await state(objective.workId);
    const current = await drive(objective, fund);
    expect(current.queries.some(row => row.intent === "pe_world_state" && row.status === "succeeded" && row.request.root?.entityId === fund.entityId)).toBe(true);
    expect(current.loop.state).not.toBe("completed");
    expect(current.plans.every(row => row.completion_proof?.verified !== true)).toBe(true);
    const redirect = await http.request(`works/${objective.workId}/objective`, { command: "redirect", objective: "Continue increasing the same fund's attributable net profit by USD 100 million after all costs.", idempotencyKey: randomUUID() });
    await record("economic-objective-redirect", redirect);
    expect(redirect.status).toBe(202);
    const redirected = await state(objective.workId);
    expect(redirected.loop.success_condition.criteria.some((criterion: { kind: string }) => criterion.kind === "manual_verification")).toBe(true);
    for (const key of ["max_steps", "max_actions", "max_queries"]) expect(redirected.loop[key]).toBe(accepted.loop[key]);
    expect(redirected.loop.deadline_at).toEqual(accepted.loop.deadline_at);
  });

  it("rejects a foreign business root at authenticated intake without exposing its name or making an objective loop", async () => {
    // Contract: root extension retains canonical tenant isolation at the actual API.
    // Defect: newly accepted businessRoot bypasses the established context resolver.
    const response = await http.request("objectives", { objective: "Inspect this exact fund", channel: "text", activeContext: context(foreignFund, "businessRoot"), idempotencyKey: randomUUID(), successCondition: readContract(foreignFund) });
    await record("foreign-root-refusal", response);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("Foreign private fund");
    expect(response.body.objective?.objectiveLoopId).toBeUndefined();
    if (response.body.workId) expect((await state(response.body.workId)).loop).toBeUndefined();
  });

  it("refuses a focused Deal outside the explicitly selected fund instead of substituting its closing context", async () => {
    const response = await http.request("objectives", {
      objective: "Inspect this fund and the selected investment.", channel: "text", idempotencyKey: randomUUID(),
      activeContext: { ...context(fund, "businessRoot"), focusedEntity: { entityType: "pe_deal", entityId: incidentalDealId }, selectedEntities: [{ entityType: "pe_deal", entityId: incidentalDealId }] },
      successCondition: readContract(fund),
    });
    await record("unrelated-focus-refusal", response);
    expect(response.status).toBe(403);
    expect(response.body.objective?.objectiveLoopId).toBeUndefined();
    if (response.body.workId) {
      const current = await state(response.body.workId);
      expect(current.loop).toBeUndefined();
      expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    }
  });

  it("rechecks current authority before a previously accepted fund objective can publish a verified read", async () => {
    const objective = await start(fund, { shape: "businessRoot" });
    const denialId = randomUUID();
    await admin.query("INSERT INTO finnor_os.role_authority_grants(id,tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,$3,'query:pe_world_state','pe_fund','deny','high',false)", [denialId, tenantId, roleId]);
    try {
      const current = await drive(objective, fund);
      expect(current.loop.state).not.toBe("completed");
      expect(current.work.failure?.detail?.code).toBe("operating_context_scope_denied");
      expect(current.plans.every(row => row.completion_proof?.verified !== true)).toBe(true);
      expect(current.queries.filter(row => row.intent === "pe_world_state" && row.status === "succeeded")).toEqual([]);
    } finally {
      await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND id=$2", [tenantId, denialId]);
    }
  });
});
