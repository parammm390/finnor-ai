import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "../../packages/db/migrate";
import {
  ComputerBroker,
  ComputerRunner,
  authorizedEffectHash,
  computerEffectOperationKey,
  getComputerRunBundle,
  markComputerSessionCleanupFailed,
  queueComputerRun,
  recoverComputerRunJobs,
  requestComputerCancellation,
  type ComputerDecisionEngine,
  type ComputerProvider,
  type StructuredPageObservation,
} from "@finnor/computer";
import { claimExternalOperation, markExternalOperationUnknown } from "@finnor/tools";
import { activitySnapshot } from "@finnor/read-models";
import { closePool } from "@finnor/db";
import { setTenantSecretReaderForTesting } from "@finnor/security";
import { purgeTenantRetention } from "../../apps/worker/src/handlers/purge-retention";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { runWorkflowStep } from "../../apps/worker/src/handlers/run-workflow-step";
import { recoverStaleSteps } from "@finnor/workflow-runtime";
import { observeExternalEffectHandler } from "../../apps/worker/src/handlers/observe-external-effect";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const available = await canConnect(SUPER_URL);

function observation(text = "Order WS-48. ETA August 30, 2026."): StructuredPageObservation {
  return { url: "https://supplier.example/orders/WS-48", title: "Supplier order WS-48", text, elements: [{ id: "e1", role: "link", name: "WS-48", text: "WS-48", disabled: false, inputKind: null }], openPageUrls: ["https://supplier.example/orders/WS-48"] };
}

function fakeProvider(text?: string): ComputerProvider & { performed: Array<string>; released: boolean } {
  return {
    name: "steel",
    capabilities: new Set(["cloud_session", "cdp", "structured_page", "screenshot", "persistent_profile"]),
    performed: [],
    released: false,
    async createSession() { return { sessionRef: `fake-${randomUUID()}`, liveViewUrl: "https://viewer.invalid/safe-only-inside-provider" }; },
    async observe() { return observation(text); },
    async perform(_session, primitive) { this.performed.push(primitive.kind); return { summary: primitive.kind, pageUrl: "https://supplier.example/orders/WS-48" }; },
    async cost() { return { creditsUsed: 0 }; },
    async release() { this.released = true; },
  };
}

describe.skipIf(!available)("Phase 3 Computer Execution Fabric", () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const roleId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  let admin: pg.Client;

  beforeAll(async () => {
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query(`INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Computer A'),($3,$4,'Computer B')`, [tenantId, `computer-${tenantId}`, otherTenantId, `computer-${otherTenantId}`]);
    await admin.query(`INSERT INTO finnor_os.tenant_settings(tenant_id,computer_config) VALUES ($1,$2::jsonb),($3,$2::jsonb)`, [tenantId, JSON.stringify({ enabled: true, provider: "steel", maxSteps: 5, timeoutMs: 60_000, maxProviderCredits: 5, maxScreenshots: 2, maxArtifacts: 5, maxDownloadBytes: 1024, maxUploadBytes: 0, maxOutputBytes: 16_384 }), otherTenantId]);
    await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name,status) VALUES ($1,$2,$3,'owner','Computer Owner','active'),($4,$5,$6,'owner','Other Owner','active')`, [actorId, tenantId, `${actorId}@example.test`, otherActorId, otherTenantId, `${otherActorId}@example.test`]);
    await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,active) VALUES ($1,$2,'computer-owner','Computer Owner',true)`, [roleId, tenantId]);
    await admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,active) VALUES ($1,$2,$3,'{"kind":"tenant"}',true)`, [tenantId, actorId, roleId]);
    await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES ($1,$2,'*','*','allow','high',false)`, [tenantId, roleId]);
    await admin.query(`INSERT INTO finnor_os.application_accounts(id,tenant_id,account_key,application,provider,display_name,status,capabilities,metadata) VALUES ($1,$2,'supplier-west','supplier_portal','supplier_portal','Supplier West','active','["read","write"]',$3::jsonb)`, [accountId, tenantId, JSON.stringify({ homeUrl: "https://supplier.example/orders", allowedOrigins: ["https://supplier.example"], authOrigins: ["https://login.example"] })]);
    await admin.query(`INSERT INTO finnor_os.auth_profiles(id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,priority,credential_provider,credential_ref,status,capabilities,restrictions) VALUES ($1,$2,'supplier-west','employee',$3,$4,'computer_task',100,'aws-secrets-manager',$5,'active','["read","write"]','{}')`, [profileId, tenantId, actorId, accountId, `finnor/tenants/${tenantId}/steel/supplier-west`]);
    await admin.query("INSERT INTO finnor_os.tenant_integrations(tenant_id,capability,binding,mode,application_account_id,auth_profile_id,health) VALUES ($1,'communications','supplier_portal','emulator',$2,$3,'ok')", [tenantId, accountId, profileId]);
    setTenantSecretReaderForTesting(async () => ({ steelProfileId: "credential-sensitive-steel-profile" }));
    process.env.DATABASE_URL = APP_URL;
    await closePool();
  });

  afterAll(async () => {
    setTenantSecretReaderForTesting(null);
    await closePool();
    process.env.DATABASE_URL = SUPER_URL;
    await admin?.end();
  });

  async function executingAction(): Promise<string> {
    const actionId = randomUUID();
    await admin.query(`INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,initiated_by,authority_context) VALUES ($1,$2,'computer_task',$3::jsonb,'executing',$4,'{"outcome":"allowed","resources":[]}')`, [actionId, tenantId, JSON.stringify({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }), actorId]);
    await admin.query(`INSERT INTO finnor_os.action_log(tenant_id,domain_action_id,step,input,output) VALUES ($1,$2,'policy_ungated_authorized','{}','{}')`, [tenantId, actionId]);
    return actionId;
  }

  async function executingWriteAction(changes: Record<string, string | number | boolean | null> = { deliveryNote: "Call warehouse before delivery" }): Promise<string> {
    const actionId = randomUUID();
    const effectId = randomUUID();
    const payload = { application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect: { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes } };
    await admin.query(`INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,initiated_by,authority_context) VALUES ($1,$2,'computer_task',$3::jsonb,'executing',$4,'{"outcome":"allowed","resources":[]}')`, [actionId, tenantId, JSON.stringify(payload), actorId]);
    const effectHash = createHash("sha256").update(JSON.stringify(payload.authorizedEffect)).digest("hex");
    await admin.query(
      `INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,authorized_at,execution_started_at)
       VALUES ($1,$2,$3,$4,$4,'external_side_effect',$5::jsonb,'executing',now(),now())`,
      [effectId, tenantId, actionId, effectHash, JSON.stringify({
        schemaVersion: 1,
        semanticHash: effectHash,
        source: { domainActionId: actionId, actionType: "computer_task", workId: null, objectiveStepId: null },
        targets: [{ kind: "resource", type: "proposed_business_change", id: actionId, sourcePath: "domainActionId" }],
        bindings: [],
        authority: { policyId: null },
        delta: payload.authorizedEffect,
      })],
    );
    await admin.query(`UPDATE finnor_os.domain_actions SET business_effect_id=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, actionId, effectId]);
    await admin.query(`INSERT INTO finnor_os.action_log(tenant_id,domain_action_id,step,input,output) VALUES ($1,$2,'confirmed','{}',$3::jsonb)`, [tenantId, actionId, JSON.stringify({ approved: true, businessEffectId: effectId, authorizedEffectHash: effectHash })]);
    return actionId;
  }

  async function recordBrowserChallenge(id: string, evidence: Record<string, unknown>): Promise<void> {
    const directory = process.env.FINNOR_S6_BROWSER_EVIDENCE_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const paths = ["packages/computer/src/runner.ts", "packages/computer/src/contracts.ts", "packages/computer/src/steel-provider.ts", "tests/integration/computer-execution-fabric.test.ts"];
    const sourceDigests = await Promise.all(paths.map(async (path) => ({ path, sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex") })));
    await writeFile(resolve(directory, `${id}.json`), JSON.stringify({
      schema: "finnor.s6.browser-owner-challenge.v1", id, recordedAt: new Date().toISOString(),
      qualification: "REAL_DATABASE_OWNER_BOUNDARY_WITH_GENERIC_PROVIDER_FIXTURE_NOT_LIVE_BROWSER_OR_CONFINEMENT",
      versions: { node: process.version, provider: "generic fixture; no admission", protocol: 2 },
      authority: { tenantId, actorId, applicationAccountId: accountId, authProfileId: profileId }, sourceDigests,
      rerun: "FINNOR_S6_BROWSER_EVIDENCE_DIR=<absolute-directory> DATABASE_URL=<disposable-test-database> npx vitest run tests/integration/computer-execution-fabric.test.ts --testNamePattern 'S6 browser'",
      ...evidence,
    }, null, 2) + "\n");
  }

  it.each([
    { id: "wrong-record", changes: { deliveryNote: "Call warehouse before delivery" }, intendedRecord: { identifier: "WS-48", deliveryNote: "Old target note" }, text: "Orders WS-48 and WS-99. WS-48 delivery note: Old target note. WS-99 delivery note: Call warehouse before delivery" },
    { id: "null-clear", changes: { deliveryNote: null }, intendedRecord: { identifier: "WS-48", deliveryNote: "Old target note" }, text: "Order WS-48 delivery note: Old target note" },
  ])("S6 browser rejects $id page evidence at the recovery settlement boundary", async ({ id, changes, intendedRecord, text }) => {
    const actionId = await executingWriteAction(changes);
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId });
    const operationKey = computerEffectOperationKey(authorizedEffect);
    await claimExternalOperation(tenantId, actionId, operationKey, authorizedEffectHash(authorizedEffect));
    await markExternalOperationUnknown(tenantId, actionId, operationKey, { preexistingPossibleDispatch: true });
    await admin.query("UPDATE finnor_os.computer_runs SET status='reconciling',provider_session_ref='preexisting-s6-session',effect_status='unknown',effect_operation_key=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, queued.run.id, operationKey]);
    const provider = fakeProvider(text); const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { return { kind: "complete", summary: "Unqualified page claim", result: { order: "WS-48" }, evidenceText: "WS-48" }; } } }).run(tenantId, queued.run.id);
    const operations = (await admin.query("SELECT status,execution_state FROM finnor_os.external_operations WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, actionId])).rows;
    const effects = (await admin.query("SELECT status,verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, actionId])).rows;
    const reconciliation = (await admin.query("SELECT status,case_type FROM finnor_os.reconciliation_cases WHERE tenant_id=$1 AND business_effect_id=(SELECT business_effect_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2)", [tenantId, actionId])).rows;
    await recordBrowserChallenge(id, { inputs: { intendedRecord, authorizedEffect, observation: observation(text), actionId, runId: queued.run.id, operationKey }, injectedFault: "possible dispatch followed by unrelated or uncleared target observation", terminal, performed: provider.performed, operations, effects, reconciliation });
    expect(intendedRecord.deliveryNote).not.toEqual(changes.deliveryNote);
    expect(terminal).toMatchObject({ status: "blocked", code: "effect_outcome_unknown" });
    expect(operations).toEqual([expect.objectContaining({ status: "unknown" })]);
    expect(effects).toEqual([expect.objectContaining({ status: "reconciliation_required" })]);
    expect(reconciliation).toEqual([expect.objectContaining({ status: "open", case_type: "unknown_delivery" })]);
    expect(provider.performed).toEqual([]);
  });

  it("S6 browser refuses unadmitted WRITE before provisioning or relabeled act egress", async () => {
    const actionId = await executingWriteAction();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId });
    const provider = fakeProvider(); let provisioned = 0;
    const create = provider.createSession.bind(provider); provider.createSession = async input => { provisioned += 1; return create(input); };
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { return { kind: "act", summary: "Relabel unauthorized submit", primitive: { kind: "click", locator: { kind: "role", role: "button", name: "Submit wrong record" } } }; } } }).run(tenantId, queued.run.id);
    await recordBrowserChallenge("unadmitted-write-act", { inputs: { authorizedEffect, actionId, runId: queued.run.id }, injectedFault: "untrusted planner labels consequential click as act", terminal, provisioned, performed: provider.performed });
    expect(terminal).toMatchObject({ status: "blocked", code: "effect_transport_unadmitted" });
    expect(provisioned).toBe(0);
    expect(provider.performed).toEqual([]);
  });

  it("runs an isolated read, verifies literal evidence, reconstructs live steps, and releases the session", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const provider = fakeProvider();
    const broker = new ComputerBroker(); broker.register(provider);
    const engine: ComputerDecisionEngine = { decide: vi.fn().mockResolvedValue({ kind: "complete", summary: "ETA found and verified", result: { order: "WS-48", eta: "August 30, 2026" }, evidenceText: "ETA August 30, 2026" }) };
    const terminal = await new ComputerRunner({ broker, decisionEngine: engine }).run(tenantId, queued.run.id);
    expect(terminal).toEqual({ status: "succeeded", result: expect.objectContaining({ order: "WS-48", eta: "August 30, 2026", verified: true, evidenceCaptured: true }) });
    expect(provider.performed).toEqual(["navigate"]);
    expect(engine.decide).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ successCriteria: ["ETA observed"] }) }));
    expect(provider.released).toBe(true);
    const bundle = await getComputerRunBundle(tenantId, queued.run.id);
    expect(bundle?.run.status).toBe("succeeded");
    expect(bundle?.steps.map((step) => step.operation)).toEqual(expect.arrayContaining(["queue", "authorize", "create_session", "open_application", "capture_evidence", "release_session"]));
    expect(bundle?.artifacts).toEqual([expect.objectContaining({ kind: "result_evidence", metadata: { verified: true, mode: "READ_ONLY" } })]);
    expect(JSON.stringify(bundle)).not.toMatch(/credential-sensitive|sessionRef|providerSession|cookie|apiKey/i);
    expect(await getComputerRunBundle(otherTenantId, queued.run.id)).toBeNull();
    expect((await activitySnapshot(tenantId)).items.some((item) => item.source === "computer_step" && item.detail.runId === queued.run.id)).toBe(true);
  });

  it("blocks a read-only mutation before the provider receives it", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId });
    const provider = fakeProvider();
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { return { kind: "effect", summary: "Submit a change", effect: { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { note: "broader" } }, primitive: { kind: "click", locator: { kind: "role", role: "button", name: "Submit" } } }; } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "blocked", code: "read_only_mutation" });
    expect(provider.performed).toEqual(["navigate"]);
    expect(provider.released).toBe(true);
  });

  it("fails closed when employee authority changes while the run is pending", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    await admin.query(`UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, actorId]);
    try {
      const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
      const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("must not decide after authority revocation"); } } }).run(tenantId, queued.run.id);
      expect(terminal).toMatchObject({ status: "blocked", code: "authorization_changed" });
      expect(provider.performed).toEqual([]);
      expect(provider.released).toBe(false);
    } finally {
      await admin.query(`UPDATE finnor_os.employee_role_assignments SET active=true WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, actorId]);
    }
  });

  it("refuses unadmitted generic WRITE and replays its refusal without egress", async () => {
    const actionId = await executingWriteAction();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId });
    let applied = false;
    const provider = fakeProvider() as ReturnType<typeof fakeProvider>;
    provider.observe = async () => observation(applied ? "Order WS-48. Delivery note: Call warehouse before delivery" : "Order WS-48. Delivery note: none");
    provider.perform = async (_session, primitive) => {
      provider.performed.push(primitive.kind);
      if (primitive.kind === "click") applied = true;
      return { summary: primitive.kind, pageUrl: "https://supplier.example/orders/WS-48" };
    };
    const broker = new ComputerBroker(); broker.register(provider);
    const decide = vi.fn()
      .mockResolvedValueOnce({ kind: "effect", summary: "Submit exact approved delivery note", effect: authorizedEffect, primitive: { kind: "click", locator: { kind: "role", role: "button", name: "Save delivery note" } } })
      .mockResolvedValueOnce({ kind: "complete", summary: "Delivery note verified", result: { order: "WS-48", deliveryNote: "Call warehouse before delivery" }, evidenceText: "Delivery note: Call warehouse before delivery" });
    const runner = new ComputerRunner({ broker, decisionEngine: { decide } });
    expect(await runner.run(tenantId, queued.run.id)).toMatchObject({ status: "blocked", code: "effect_transport_unadmitted" });
    expect(provider.performed).toEqual([]);
    expect((await admin.query(`SELECT status FROM finnor_os.external_operations WHERE tenant_id=$1 AND domain_action_id=$2`, [tenantId, actionId])).rows).toEqual([]);
    expect(await runner.run(tenantId, queued.run.id)).toMatchObject({ status: "blocked", code: "effect_transport_unadmitted" });
    expect(provider.performed).toEqual([]);
  });

  it("retains possible WRITE responsibility when recovered observation fails", async () => {
    const actionId = await executingWriteAction();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId });
    const key = computerEffectOperationKey(authorizedEffect);
    await claimExternalOperation(tenantId, actionId, key, authorizedEffectHash(authorizedEffect));
    await markExternalOperationUnknown(tenantId, actionId, key, { possibleDispatch: true });
    await admin.query("UPDATE finnor_os.computer_runs SET status='reconciling',provider_session_ref='lost-observation-session',effect_status='unknown',effect_operation_key=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, queued.run.id, key]);
    const provider = fakeProvider();
    provider.observe = async () => { throw Error("Recovered provider readback unavailable"); };
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw Error("No decision without recovered observation"); } } }).run(tenantId, queued.run.id);
    expect(terminal.status).not.toBe("succeeded");
    expect(provider.performed).toEqual([]);
    expect(provider.released).toBe(true);
    expect((await admin.query("SELECT status FROM finnor_os.external_operations WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, actionId])).rows).toEqual([{ status: "unknown" }]);
    expect((await admin.query("SELECT status FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, actionId])).rows).toEqual([{ status: "reconciliation_required" }]);
  });

  it("reattaches after a worker restart and inspects possible write state before navigating", async () => {
    const actionId = await executingWriteAction();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const operationKey = computerEffectOperationKey(authorizedEffect);
    await claimExternalOperation(tenantId, actionId, operationKey, authorizedEffectHash(authorizedEffect));
    await markExternalOperationUnknown(tenantId, actionId, operationKey, { simulatedWorkerRestart: true });
    await admin.query(`UPDATE finnor_os.computer_runs SET status='reconciling', provider_session_ref='existing-isolated-session', effect_status='unknown', effect_operation_key=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, queued.run.id, operationKey]);
    const provider = fakeProvider("Order WS-48. Delivery note: Call warehouse before delivery");
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { return { kind: "complete", summary: "Recovered delivery note verified", result: { order: "WS-48", deliveryNote: "Call warehouse before delivery" }, evidenceText: "Delivery note: Call warehouse before delivery" }; } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "blocked", code: "effect_outcome_unknown" });
    expect(provider.performed).toEqual([]);
    expect(provider.released).toBe(true);
    expect((await getComputerRunBundle(tenantId, queued.run.id))?.steps.map((step) => step.operation)).toEqual(expect.arrayContaining(["recover_session", "inspect_recovered_state", "reconcile_effect"]));
  });

  it("refuses a broader candidate on the unadmitted generic WRITE transport", async () => {
    const actionId = await executingWriteAction();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId });
    const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { return { kind: "effect", summary: "Broader update", effect: { ...authorizedEffect, changes: { ...authorizedEffect.changes, expedite: true } }, primitive: { kind: "click", locator: { kind: "role", role: "button", name: "Save" } } }; } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "blocked", code: "effect_transport_unadmitted" });
    expect(provider.performed).toEqual([]);
  });

  it("honors durable cancellation and preserves prior history", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId });
    await requestComputerCancellation(tenantId, queued.run.id);
    const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("must not decide after cancellation"); } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "cancelled" });
    expect(provider.released).toBe(false);
    expect((await getComputerRunBundle(tenantId, queued.run.id))?.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves possible dispatch responsibility when cancellation arrives before recovery", async () => {
    const actionId = await executingWriteAction();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, { tenantId, actorId, domainActionId: actionId });
    const operationKey = computerEffectOperationKey(authorizedEffect);
    await claimExternalOperation(tenantId, actionId, operationKey, authorizedEffectHash(authorizedEffect));
    await admin.query("UPDATE finnor_os.computer_runs SET status='running',effect_status='dispatching',effect_operation_key=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, queued.run.id, operationKey]);
    await requestComputerCancellation(tenantId, queued.run.id);
    const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("Cancelled run cannot dispatch again"); } } }).run(tenantId, queued.run.id);
    const effect = (await admin.query("SELECT status,verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, actionId])).rows[0];
    const action = (await admin.query("SELECT status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2", [tenantId, actionId])).rows[0];
    const unresolved = (await admin.query("SELECT status,case_type FROM finnor_os.reconciliation_cases WHERE tenant_id=$1 AND business_effect_id=(SELECT business_effect_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2)", [tenantId, actionId])).rows;
    await recordBrowserChallenge("cancel-during-dispatch", { inputs: { actionId, runId: queued.run.id, authorizedEffect, operationKey }, injectedFault: "persisted possible dispatch followed by cancellation before recovery", terminal, effect, action, unresolved, performed: provider.performed });
    expect(terminal.status).toBe("cancelled");
    expect(provider.performed).toEqual([]);
    expect(effect).toMatchObject({ status: "reconciliation_required", verification: { state: "reconciliation_required" } });
    expect(action.status).toBe("needs_human_review");
    expect(unresolved).toEqual([expect.objectContaining({ status: "open", case_type: "unknown_delivery" })]);
  });

  it.each([[false,false],[true,false],[false,true],[true,true]] as const)("keeps native parent accountable through child terminal state (possible dispatch=%s, worker crash=%s)", async (possible, crash) => {
    const orchestrator = new FinnorOrchestrator();
    const authorizedEffect = { operation: "update_delivery_note", target: { kind: "supplier_order", identifier: "WS-48" }, changes: { deliveryNote: "Call warehouse before delivery" } };
    const drafted = await orchestrator.draftKnownAction("computer_task", { application: "supplier_portal", authProfileRef: "supplier-west", task: "Update the delivery note for WS-48", target: authorizedEffect.target, mode: "WRITE", successCriteria: ["Exact delivery note observed"], authorizedEffect }, tenantId, { initiatedBy: actorId, source: "s6_child_lifecycle" });
    await orchestrator.decide(drafted.action.id, tenantId, "approve", actorId, { role: "owner" });
    const before = (await admin.query("SELECT * FROM finnor_os.workflow_steps WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, drafted.action.id])).rows[0];
    expect(before).toBeTruthy();
    let crashEvidence: Record<string, unknown> | null = null;
    if (crash) {
      const faultName = `s6_child_crash_${randomUUID().replaceAll('-', '')}`;
      const applicationName = faultName;
      const workerUrl = new URL(APP_URL); workerUrl.searchParams.set('application_name', applicationName);
      await admin.query(`CREATE FUNCTION finnor_os.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${before.id}'::uuid AND NEW.status='waiting_observation' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER ${faultName} BEFORE UPDATE ON finnor_os.workflow_steps FOR EACH ROW EXECUTE FUNCTION finnor_os.${faultName}()`);
      const childWorker = spawn(process.execPath, ['--import=tsx', '--input-type=module', '--eval', `import {runWorkflowStep} from './apps/worker/src/handlers/run-workflow-step.ts';import {closePool} from './packages/db/index.ts';import {setTenantSecretReaderForTesting} from './packages/security/src/index.ts';setTenantSecretReaderForTesting(async()=>({steelProfileId:'credential-sensitive-steel-profile'}));try{await runWorkflowStep(${JSON.stringify({tenantId,workflowStepId:before.id})});}finally{await closePool();}`], { cwd: resolve('.'), env: {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,DATABASE_URL:workerUrl.toString(),NODE_ENV:'test',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',LOG_LEVEL:'silent'}, stdio: ['ignore','pipe','pipe'] });
      let logs = ''; childWorker.stdout.on('data', chunk => logs += chunk.toString()); childWorker.stderr.on('data', chunk => logs += chunk.toString());
      const exited = new Promise<{code:number|null;signal:NodeJS.Signals|null}>(done => childWorker.once('exit',(code,signal)=>done({code,signal})));
      let stall: {pid:number} | undefined;
      try {
        const until = Date.now() + 20000;
        while (Date.now() < until && childWorker.exitCode === null && childWorker.signalCode === null) {
          stall = (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'", [applicationName])).rows[0];
          if (stall) break;
          await new Promise(done => setTimeout(done,50));
        }
        if (!stall) {
          await recordBrowserChallenge(`native-child-crash-setup-${possible ? 'possible' : 'refused'}`, {inputs:{tenantId,actionId:drafted.action.id,stepId:before.id},workerPid:childWorker.pid,workerExit:childWorker.exitCode,workerSignal:childWorker.signalCode,logs});
          throw new Error(`Child crash window was not reached: ${logs}`);
        }
        const persisted = (await admin.query("SELECT s.status,s.evidence,o.id operation_id,o.status operation_status,o.response,c.id child_id FROM finnor_os.workflow_steps s JOIN finnor_os.integration_operations o ON o.tenant_id=s.tenant_id AND o.workflow_step_id=s.id JOIN finnor_os.computer_runs c ON c.tenant_id=s.tenant_id AND c.domain_action_id=s.domain_action_id WHERE s.tenant_id=$1 AND s.id=$2 AND o.provider='finnor_plugin_runtime'", [tenantId,before.id])).rows[0];
        expect(persisted).toMatchObject({status:'leased',operation_status:'succeeded',response:{status:'success',output:{pendingComputerRun:true,computerRunId:expect.any(String)}}});
        expect(persisted.response.output.computerRunId).toBe(persisted.child_id);
        childWorker.kill('SIGKILL'); const exit = await exited; expect(exit.signal).toBe('SIGKILL');
        await admin.query('SELECT pg_terminate_backend($1)',[stall!.pid]);
        await admin.query(`DROP TRIGGER IF EXISTS ${faultName} ON finnor_os.workflow_steps`);
        crashEvidence = {workerPid:childWorker.pid,signal:exit.signal,persisted,logs,qualification:'Separate actual handler process; existing test-mode preclaim seam; disposable database delay injection'};
        await recordBrowserChallenge(`native-child-physical-crash-${possible ? 'possible' : 'refused'}`, {inputs:{actionId:drafted.action.id,parentStepId:before.id},crashEvidence});
        await admin.query("UPDATE finnor_os.workflow_steps SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[tenantId,before.id]);
        const recovered = await recoverStaleSteps(tenantId);
        await observeExternalEffectHandler({tenantId,integrationOperationId:persisted.operation_id});
        crashEvidence = {...crashEvidence,recovered};
      } finally {
        if (childWorker.exitCode === null && childWorker.signalCode === null) { childWorker.kill('SIGKILL'); await exited; }
        if (stall) await admin.query('SELECT pg_terminate_backend($1)',[stall.pid]);
        await admin.query(`DROP TRIGGER IF EXISTS ${faultName} ON finnor_os.workflow_steps`);
        await admin.query(`DROP FUNCTION IF EXISTS finnor_os.${faultName}()`);
      }
    } else await runWorkflowStep({ tenantId, workflowStepId: before.id });
    const child = (await admin.query("SELECT * FROM finnor_os.computer_runs WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, drafted.action.id])).rows[0];
    expect(child).toBeTruthy();
    const waiting = (await admin.query("SELECT status,evidence FROM finnor_os.workflow_steps WHERE tenant_id=$1 AND id=$2", [tenantId, before.id])).rows[0];
    if (crash) await recordBrowserChallenge(`native-child-crash-window-${possible ? 'possible' : 'refused'}`, {inputs:{actionId:drafted.action.id,parentStepId:before.id,childRunId:child.id},crashEvidence,waiting});
    expect(waiting).toMatchObject({ status: "waiting_observation", evidence: { delegatedRuntime: { kind: "computer", id: child.id } } });
    if (possible) {
      const operationKey = computerEffectOperationKey(authorizedEffect);
      await claimExternalOperation(tenantId, drafted.action.id, operationKey, authorizedEffectHash(authorizedEffect));
      await admin.query("UPDATE finnor_os.computer_runs SET status='running',effect_status='dispatching',effect_operation_key=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, child.id, operationKey]);
      await requestComputerCancellation(tenantId, child.id);
    }
    const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
    const runner = new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("Unadmitted/cancelled child cannot execute"); } } });
    const terminal = await runner.run(tenantId, child.id);
    await runner.run(tenantId, child.id);
    expect(terminal.status).toBe(possible ? "cancelled" : "blocked");
    const parent = (await admin.query("SELECT s.status,s.execution_state,r.status run_status FROM finnor_os.workflow_steps s JOIN finnor_os.workflow_runs r ON r.id=s.workflow_run_id WHERE s.tenant_id=$1 AND s.id=$2", [tenantId, before.id])).rows[0];
    expect(parent).toMatchObject(possible ? { status: "waiting_observation", execution_state: "reconciling", run_status: "running" } : { status: "failed", run_status: "failed" });
    const action = (await admin.query("SELECT status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2", [tenantId, drafted.action.id])).rows[0];
    const effects = (await admin.query("SELECT id,status,verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2", [tenantId, drafted.action.id])).rows;
    await recordBrowserChallenge(`native-child-${possible ? "possible" : "refused"}${crash ? '-crash' : ''}`, { inputs: { actionId: drafted.action.id, parentStepId: before.id, childRunId: child.id, authorizedEffect }, injectedFault: possible ? "possible dispatch cancelled before observation" : "generic transport unadmitted at real child owner", crashEvidence, waiting, terminal, parent, action, effects, performed: provider.performed });
    expect(action.status).toBe("needs_human_review");
    expect(provider.performed).toEqual([]);
  }, 60000);

  it("stops an active run at the next boundary and releases its provider session", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const provider = fakeProvider();
    provider.observe = async () => {
      await requestComputerCancellation(tenantId, queued.run.id);
      return observation();
    };
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("must not decide after active cancellation"); } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "cancelled" });
    expect(provider.performed).toEqual(["navigate"]);
    expect(provider.released).toBe(true);
    expect((await getComputerRunBundle(tenantId, queued.run.id))?.steps.map((step) => step.operation)).toEqual(expect.arrayContaining(["cancel", "release_session"]));
  });

  it("ends truthfully at the governed step limit", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { return { kind: "act", summary: "Wait for data", primitive: { kind: "wait", milliseconds: 0 } }; } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "timed_out", code: "step_limit" });
    expect(provider.performed).toEqual(["navigate", "wait", "wait", "wait", "wait", "wait"]);
    expect((await getComputerRunBundle(tenantId, queued.run.id))?.run.status).toBe("timed_out");
  });

  it("stops deterministically at the provider-cost budget", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const provider = fakeProvider();
    provider.cost = async () => ({ creditsUsed: 5 });
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("must not decide after budget exhaustion"); } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "timed_out", code: "provider_budget" });
    expect(provider.performed).toEqual(["navigate"]);
  });

  it("stops deterministically at the wall-clock timeout", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const provider = fakeProvider(); const broker = new ComputerBroker(); broker.register(provider);
    let clockReads = 0;
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("must not decide after timeout"); } }, now: () => clockReads++ === 0 ? 0 : 60_001 }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "timed_out", code: "wall_clock_timeout" });
    expect(provider.performed).toEqual(["navigate"]);
  });

  it("records provider failure without inventing success", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    const provider = fakeProvider();
    provider.createSession = async () => { throw new Error("simulated provider outage"); };
    const broker = new ComputerBroker(); broker.register(provider);
    const terminal = await new ComputerRunner({ broker, decisionEngine: { async decide() { throw new Error("must not decide after provisioning failure"); } } }).run(tenantId, queued.run.id);
    expect(terminal).toMatchObject({ status: "failed", code: "computer_failure" });
    expect((await getComputerRunBundle(tenantId, queued.run.id))?.run.result).toBeNull();
  });

  it("requeues a stranded active run once per recovery scan", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    await admin.query(`UPDATE finnor_os.jobs SET status='completed', completed_at=now() WHERE type='run_computer_task' AND payload->>'runId'=$1`, [queued.run.id]);
    expect(await recoverComputerRunJobs(tenantId)).toMatchObject({ queued: 1 });
    expect(await recoverComputerRunJobs(tenantId)).toMatchObject({ queued: 0 });
    expect(Number((await admin.query(`SELECT count(*) FROM finnor_os.jobs WHERE type='run_computer_task' AND status='queued' AND payload->>'runId'=$1`, [queued.run.id])).rows[0].count)).toBe(1);
    await requestComputerCancellation(tenantId, queued.run.id);
    expect(await new ComputerRunner({ broker: new ComputerBroker(), decisionEngine: { async decide() { throw new Error("cancelled before decision"); } } }).run(tenantId, queued.run.id)).toMatchObject({ status: "cancelled" });
  });

  it("times out a run past its durable deadline and retains an orphan session for bounded cleanup retry", async () => {
    const actionId = await executingAction();
    const queued = await queueComputerRun({ application: "supplier_portal", authProfileRef: "supplier-west", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] }, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" });
    await admin.query(
      `UPDATE finnor_os.computer_runs
          SET status='running',provider_session_ref='orphan-provider-session',deadline_at=now()-interval '1 second'
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, queued.run.id],
    );
    await admin.query(
      `UPDATE finnor_os.jobs SET status='completed',completed_at=now()
        WHERE type='run_computer_task' AND payload->>'runId'=$1`, [queued.run.id],
    );
    const recovery = await recoverComputerRunJobs(tenantId);
    expect(recovery.queued).toBe(0);
    expect(recovery.orphanSessions).toContainEqual({ runId: queued.run.id, sessionRef: "orphan-provider-session" });
    expect((await getComputerRunBundle(tenantId, queued.run.id))?.run).toMatchObject({ status: "timed_out" });
    await markComputerSessionCleanupFailed(tenantId, queued.run.id, "provider_unavailable");
    const cleanup = await admin.query(
      "SELECT provider_session_ref,cleanup_attempted_at,cleanup_failure_code FROM finnor_os.computer_runs WHERE id=$1", [queued.run.id],
    );
    expect(cleanup.rows[0]).toMatchObject({ provider_session_ref: "orphan-provider-session", cleanup_failure_code: "provider_unavailable" });
    expect(cleanup.rows[0].cleanup_attempted_at).not.toBeNull();
  });

  it("redacts expired artifact bytes and locators while preserving immutable evidence metadata", async () => {
    const existing = await admin.query<{ run_id: string; step_id: string | null }>(
      "SELECT run_id,step_id FROM finnor_os.computer_artifacts WHERE tenant_id=$1 ORDER BY created_at LIMIT 1",
      [tenantId],
    );
    expect(existing.rowCount).toBe(1);
    const bytes = Buffer.from("sensitive screenshot bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const artifact = await admin.query<{ id: string }>(
      `INSERT INTO finnor_os.computer_artifacts
         (tenant_id,run_id,step_id,kind,mime_type,size_bytes,sha256,storage_ref,content,metadata,created_at)
       VALUES ($1,$2,$3,'screenshot','image/png',$4,$5,'private/object/key',$6,'{"verified":true}',now()-interval '31 days')
       RETURNING id`,
      [tenantId, existing.rows[0]!.run_id, existing.rows[0]!.step_id, bytes.length, hash, bytes],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_retention_policies(tenant_id,data_class,retention_days,legal_hold)
       VALUES ($1,'computer_artifact_content',30,false)
       ON CONFLICT (tenant_id,data_class) DO UPDATE SET retention_days=excluded.retention_days,legal_hold=false`,
      [tenantId],
    );
    const result = await purgeTenantRetention(tenantId);
    expect(result.computerArtifactContentsScrubbed).toBeGreaterThanOrEqual(1);
    const retained = await admin.query(
      "SELECT content,storage_ref,sha256,size_bytes,mime_type,metadata FROM finnor_os.computer_artifacts WHERE id=$1",
      [artifact.rows[0]!.id],
    );
    expect(retained.rows[0]).toEqual({
      content: null,
      storage_ref: null,
      sha256: hash,
      size_bytes: bytes.length,
      mime_type: "image/png",
      metadata: { verified: true },
    });
  });

  it("refuses a missing governed auth profile before creating a run", async () => {
    const actionId = randomUUID();
    const payload = { application: "supplier_portal", authProfileRef: "missing-profile", task: "Find ETA for WS-48", target: { kind: "supplier_order", identifier: "WS-48" }, mode: "READ_ONLY", successCriteria: ["ETA observed"] };
    await admin.query(`INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,initiated_by,authority_context) VALUES ($1,$2,'computer_task',$3::jsonb,'executing',$4,'{"outcome":"allowed","resources":[]}')`, [actionId, tenantId, JSON.stringify(payload), actorId]);
    await expect(queueComputerRun(payload as never, { tenantId, actorId, domainActionId: actionId, purpose: "computer_task" })).rejects.toThrow(/profile|account/i);
    expect(Number((await admin.query(`SELECT count(*) FROM finnor_os.computer_runs WHERE tenant_id=$1 AND domain_action_id=$2`, [tenantId, actionId])).rows[0].count)).toBe(0);
  });
});
