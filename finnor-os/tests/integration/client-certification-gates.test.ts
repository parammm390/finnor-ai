import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, getPool } from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { parseClientManifest } from "../../scripts/client-manifest";
import { runClientFactory, startClientFactory } from "../../scripts/client-factory";
import type { TenantAuthAdmin } from "../../scripts/tenant-user";
import { runClientCertificationGates } from "../../scripts/release/client-certification-gates";
import {
  CORE_GATE_KEYS,
  createClientCertification,
  createClientRelease,
  createCoreCertification,
  deploymentEvidenceProjection,
  gateResult,
  hashClientConfiguration,
  sha256,
} from "../../scripts/release/certification-model";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
async function dbUp() {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const available = await dbUp();

function fakeAuth(): TenantAuthAdmin {
  const users = new Map<string, { id: string; email: string }>();
  return {
    listUsers: vi.fn(async () => ({ data: { users: [...users.values()], nextPage: null }, error: null })),
    createUser: vi.fn(async ({ email }: { email: string }) => {
      const user = { id: randomUUID(), email };
      users.set(email, user);
      return { data: { user }, error: null };
    }),
    updateUserById: vi.fn(async () => ({ data: { user: {} }, error: null })),
  } as unknown as TenantAuthAdmin;
}

describe.skipIf(!available).sequential("Phase 5 bounded client certification gates", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
  });
  afterAll(() => closePool());

  it("certifies a converged native client and invalidates the certification after deployed policy drift", async () => {
    const suffix = randomUUID().slice(0, 8);
    const manifest = parseClientManifest({
      clientKey: `cert-client-${suffix}`,
      tenant: { name: "Certified Client Water", timezone: "America/Chicago" },
      users: [{ email: `cert-client-${suffix}@example.test`, role: "owner" }],
      requiredCapabilities: ["crm"],
      policyOverrides: { create_review_request: { policy: { review_link_url: "https://example.test/certified-review" } } },
    });
    const started = await startClientFactory(manifest, { enqueue: false });
    const factory = await runClientFactory(started.run.id, { auth: fakeAuth() });
    expect(factory.status).toBe("passed");
    const tenantId = factory.tenantId!;

    const core = createCoreCertification({
      canonicalCoreSha: "d".repeat(40),
      coreSourceTreeHash: sha256("certification-test-tree"),
      gates: CORE_GATE_KEYS.map((gate) => gateResult(gate, "PASS", { gate })),
    });
    const deployment = {
      service: "finnor-api",
      commitSha: core.canonicalCoreSha,
      coreCertificationId: core.certificationId,
      buildId: `finnor-${core.canonicalCoreSha.slice(0, 12)}`,
      deploymentId: "dpl_client_certification",
      environment: "production",
      version: `0.1.0+${core.canonicalCoreSha.slice(0, 12)}`,
      source: "integration-test",
      traceable: true,
    };
    await getPool().query(
      `INSERT INTO finnor_os.worker_heartbeat(id,last_beat_at,meta)
       VALUES('worker',now(),$1::jsonb)
       ON CONFLICT(id) DO UPDATE SET last_beat_at=now(),meta=excluded.meta`,
      [JSON.stringify({ releaseSha: core.canonicalCoreSha, coreCertificationId: core.certificationId, deploymentId: "worker-deployment-test" })],
    );

    const actionTypes = ["schedule_water_test", "size_equipment_for_household", "generate_quote"];
    const receiptIds: string[] = [];
    for (const actionType of actionTypes) {
      const action = await getPool().query<{ id: string }>(
        `INSERT INTO finnor_os.domain_actions(tenant_id,action_type,payload,status,summary)
         VALUES($1,$2,'{}'::jsonb,'completed',$2 || ' certification journey') RETURNING id`,
        [tenantId, actionType],
      );
      const receipt = await getPool().query<{ id: string }>(
        `INSERT INTO finnor_os.decision_receipts
           (tenant_id,domain_action_id,objective,evidence,policy_applied,proposed_action,approval,expected_result,actual_result,finalized_at)
         VALUES($1,$2,$3::text,'[{"source":"certification-journey"}]'::jsonb,
           '{"version":1}'::jsonb,jsonb_build_object('actionType',$3::text),'{"required":false}'::jsonb,
           '{"expected":"complete"}'::jsonb,'{"completed":true}'::jsonb,now()) RETURNING id`,
        [tenantId, action.rows[0]!.id, actionType],
      );
      receiptIds.push(receipt.rows[0]!.id);
    }
    const journeyEvidence = {
      canonicalCoreSha: core.canonicalCoreSha,
      deploymentEvidenceHash: sha256(deploymentEvidenceProjection(deployment)),
      journeys: actionTypes.map((actionType, index) => ({ journey: actionType, actionTypes: [actionType], receiptIds: [receiptIds[index]!], outcomeVerified: true })),
    };
    const coreDiff = {
      canonicalCoreSha: core.canonicalCoreSha,
      coreSourceTreeHash: core.coreSourceTreeHash,
      changedSharedCorePaths: [],
      changedClientPaths: ["finnor-os/clients/test/config.json"],
      clean: true,
    };
    const first = await runClientCertificationGates({
      manifest,
      pool: getPool(),
      factoryRunId: factory.id,
      canonicalCoreSha: core.canonicalCoreSha,
      coreCertificationId: core.certificationId,
      deploymentEvidence: deployment,
      coreDiff,
      journeyEvidence,
    });
    expect(first.gates.every((gate) => gate.status === "PASS")).toBe(true);
    const certification = createClientCertification({
      clientKey: manifest.clientKey,
      tenantId,
      coreCertification: core,
      configurationHashes: hashClientConfiguration(manifest),
      deploymentEvidence: deployment,
      migrationVersion: first.migrationVersion,
      schemaHash: first.schemaHash,
      gates: first.gates,
    });
    const release = createClientRelease({
      coreCertification: core,
      clientCertification: certification,
      deploymentEvidence: deployment,
      integrations: first.integrations,
      factoryRunId: factory.id,
    });
    expect(release.certification.status).toBe("PASS");

    const repeated = await runClientCertificationGates({
      manifest,
      pool: getPool(),
      factoryRunId: factory.id,
      canonicalCoreSha: core.canonicalCoreSha,
      coreCertificationId: core.certificationId,
      deploymentEvidence: deployment,
      coreDiff,
      journeyEvidence,
    });
    const repeatedCertification = createClientCertification({
      clientKey: manifest.clientKey,
      tenantId,
      coreCertification: core,
      configurationHashes: hashClientConfiguration(manifest),
      deploymentEvidence: deployment,
      migrationVersion: repeated.migrationVersion,
      schemaHash: repeated.schemaHash,
      gates: repeated.gates,
    });
    const repeatedRelease = createClientRelease({
      coreCertification: core,
      clientCertification: repeatedCertification,
      deploymentEvidence: deployment,
      integrations: repeated.integrations,
      factoryRunId: factory.id,
    });
    expect(repeated.gates.map((gate) => gate.evidenceHash)).toEqual(first.gates.map((gate) => gate.evidenceHash));
    expect(repeatedCertification.certificationId).toBe(certification.certificationId);
    expect(repeatedRelease.releaseId).toBe(release.releaseId);

    const emulatorRequired = parseClientManifest({
      ...manifest,
      requiredCapabilities: ["crm", "communications"],
    });
    const emulatorResult = await runClientCertificationGates({
      manifest: emulatorRequired,
      pool: getPool(),
      factoryRunId: factory.id,
      canonicalCoreSha: core.canonicalCoreSha,
      coreCertificationId: core.certificationId,
      deploymentEvidence: deployment,
      coreDiff,
      journeyEvidence,
    });
    expect(emulatorResult.gates.find((gate) => gate.gate === "required_integrations_capabilities")?.status)
      .toBe("BLOCKED_CONFIG");

    await getPool().query(
      `UPDATE finnor_os.domain_policies SET policy=jsonb_set(policy,'{review_link_url}','"https://example.test/drifted"'::jsonb)
       WHERE tenant_id=$1 AND action_type='create_review_request'`,
      [tenantId],
    );
    const drifted = await runClientCertificationGates({
      manifest,
      pool: getPool(),
      factoryRunId: factory.id,
      canonicalCoreSha: core.canonicalCoreSha,
      coreCertificationId: core.certificationId,
      deploymentEvidence: deployment,
      coreDiff,
      journeyEvidence,
    });
    expect(drifted.gates.find((gate) => gate.gate === "workspace_policies")?.status).toBe("FAIL");
    expect(drifted.gates.find((gate) => gate.gate === "configuration_completeness")?.status).toBe("FAIL");
  }, 120_000);
});
