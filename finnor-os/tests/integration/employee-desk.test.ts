import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  approvalChains, attachWorkEntityTx, authorityApprovalRequests, authorityApprovalRequestSteps, authorityDecisions,
  closePool, domainActions, evidenceSources, evidenceSourceVersions, tenants, transitionWorkTx, users, withTenant, works,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { GET } from "../../apps/api/app/api/me/desk/route";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const tenantId = randomUUID(), dealId = randomUUID(), targetId = randomUUID();
const associate = randomUUID(), controller = randomUUID(), peer = randomUUID();
const diligence = randomUUID(), treasury = randomUUID(), sourceId = randomUUID();
const actionId = randomUUID(), chainId = randomUUID(), decisionId = randomUUID(), requestId = randomUUID();
const exhibit = (versionNumber: number, content: string, asOf: string) => ({
  id: randomUUID(), sourceId, scope: "tenant" as const, tenantId, versionNumber, content,
  contentHash: createHash("sha256").update(content).digest("hex"), asOf: new Date(asOf),
});
const cited = exhibit(1, "Synthetic exhibit: $10m recurring revenue.", "2026-11-01T12:00:00Z");
const amended = exhibit(2, "Synthetic exhibit: $9m recurring revenue.", "2026-11-02T12:00:00Z");
const unrecorded = exhibit(3, "Synthetic exhibit not recorded on Work.", "2026-11-03T12:00:00Z");
const reviewer = "approve:pe_diligence_review";
const affectedDecision = "Review Q3 recurring revenue";
const version = ({ id, versionNumber, contentHash, asOf }: typeof cited) => ({ id, versionNumber, contentHash, asOf: asOf.toISOString() });

function desk(employee: string, query = "") {
  return GET(new Request(`http://localhost/api/me/desk${query}`, {
    headers: { "x-tenant-id": tenantId, "x-user-id": employee, "x-user-role": "participant" },
  }));
}

async function counts() {
  return withTenant(tenantId, async db => (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM works WHERE tenant_id=${tenantId}) AS works,
           (SELECT count(*)::int FROM work_events WHERE tenant_id=${tenantId}) AS events,
           (SELECT count(*)::int FROM work_entity_links WHERE tenant_id=${tenantId}) AS links,
           (SELECT count(*)::int FROM evidence_sources WHERE tenant_id=${tenantId}) AS sources,
           (SELECT count(*)::int FROM evidence_source_versions WHERE tenant_id=${tenantId}) AS versions,
           (SELECT count(*)::int FROM domain_actions WHERE tenant_id=${tenantId}) AS actions,
           (SELECT count(*)::int FROM authority_decisions WHERE tenant_id=${tenantId}) AS decisions,
           (SELECT count(*)::int FROM authority_approval_requests WHERE tenant_id=${tenantId}) AS approvals,
           (SELECT count(*)::int FROM authority_approval_request_steps WHERE tenant_id=${tenantId}) AS approval_steps
  `)).rows[0]);
}

describe("read-only employee desk pilot", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("AUTH_DEV_BYPASS", "1");
    await migrate(databaseUrl);
    await withTenant(tenantId, async db => {
      await db.execute(sql`SET LOCAL app.test_vertical_mode = 'explicit'`);
      await db.insert(tenants).values({ id: tenantId, name: "Synthetic employee desk" });
      await db.insert(users).values([associate, controller, peer].map(id => ({
        id, tenantId, role: "participant" as const, email: `${id}@example.test`,
      })));
      await db.execute(sql`
        INSERT INTO tenant_vertical_assignments(tenant_id,vertical_key,source_system,created_by)
        VALUES (${tenantId},'private_equity','integration:employee-desk','synthetic-fixture')
      `);
      await db.execute(sql`
        INSERT INTO external_organizations(id,tenant_id,organization_key,name,kind)
        VALUES (${targetId},${tenantId},'synthetic-target','Synthetic target','other')
      `);
      await db.execute(sql`
        INSERT INTO pe_deals(id,tenant_id,target_organization_id,name,deal_lead_employee_id,
          signed_loi_at,target_closing_at,source_system,created_by)
        VALUES (${dealId},${tenantId},${targetId},'Synthetic deal',${controller},
          '2026-11-01','2026-12-01','integration:employee-desk','synthetic-fixture')
      `);
      await db.insert(works).values([
        { id: diligence, tenantId, initialChannel: "text", initialInstruction: "Check Q3 diligence exhibit",
          assignedTo: associate, status: "awaiting_approval" },
        { id: treasury, tenantId, initialChannel: "text", initialInstruction: "Check closing funds",
          currentOwnerId: controller, status: "ready" },
        { tenantId, initialChannel: "text", initialInstruction: "An unassigned Work originated by the peer", createdBy: peer },
      ]);
      await db.insert(evidenceSources).values({ id: sourceId, tenantId, sourceKey: "diligence-exhibit",
        sourceType: "exhibit", title: "Q3 diligence exhibit" });
      await db.insert(evidenceSourceVersions).values(cited);
      for (const workId of [diligence, treasury]) {
        await attachWorkEntityTx(db, { tenantId, workId, entity: { entityType: "pe_deal", entityId: dealId } });
      }
      await transitionWorkTx(db, tenantId, diligence, "awaiting_approval", "evidence_version_cited", {
        sourceId, ...version(cited),
      });
      await db.insert(evidenceSourceVersions).values(amended);
      await transitionWorkTx(db, tenantId, diligence, "awaiting_approval", "evidence_version_observed", {
        sourceId, ...version(amended),
      });
      await db.insert(evidenceSourceVersions).values(unrecorded);
      await transitionWorkTx(db, tenantId, diligence, "awaiting_approval", "approval_requested", {
        privateContext: "Not desk data",
      });
      await db.insert(domainActions).values({
        id: actionId, tenantId, workId: diligence, actionType: "pe_diligence_review", summary: affectedDecision, status: "pending",
      });
      await db.insert(approvalChains).values({ id: chainId, tenantId, name: "Diligence review", key: "diligence" });
      await db.insert(authorityDecisions).values({
        id: decisionId, tenantId, employeeId: associate, workId: diligence, domainActionId: actionId,
        authorityRevision: 1, operation: "action", capability: "action:pe_diligence_review",
        risk: "medium", outcome: "approval_required", reasonCode: "REVIEW", approvalChainId: chainId,
      });
      await db.insert(authorityApprovalRequests).values({
        id: requestId, tenantId, requesterId: associate, domainActionId: actionId,
        authorityDecisionId: decisionId, approvalChainId: chainId, currentStep: 2,
      });
      await db.insert(authorityApprovalRequestSteps).values([
        { tenantId, approvalRequestId: requestId, sequence: 1, approverCapability: "approve:triage", status: "approved" },
        { tenantId, approvalRequestId: requestId, sequence: 2, approverCapability: reviewer },
        { tenantId, approvalRequestId: requestId, sequence: 3, approverCapability: "approve:final" },
      ]);
    });
  }, 120_000);

  afterAll(async () => { await closePool(); vi.unstubAllEnvs(); });

  it("shows the amended exhibit, affected decision and next step without exposing or changing other Work", async () => {
    const before = await counts();
    const appUrl = new URL(databaseUrl);
    appUrl.searchParams.set("options", "-c role=finnor_app");
    let observations: Record<string, unknown>;
    process.env.DATABASE_URL = appUrl.href;
    try {
      const associateResponse = await desk(associate);
      expect(associateResponse.status).toBe(200);
      expect(associateResponse.headers.get("cache-control")).toBe("private, no-store");
      const associateDesk = await associateResponse.json();
      expect(associateDesk.works).toHaveLength(1);
      expect(associateDesk.works[0]).toMatchObject({
        id: diligence, href: `/centropy/workforce?workId=${diligence}`, instruction: "Check Q3 diligence exhibit",
        status: "awaiting_approval", updatedAt: expect.any(String),
        approvals: [{ actionId, summary: affectedDecision, sequence: 2, approverCapability: reviewer }],
      });
      expect(associateDesk.works[0].evidence).toEqual([{ sourceId, cited: version(cited), current: version(amended), changed: true }]);
      expect(associateDesk.works[0].events).toEqual([
        { sequence: 3, type: "approval_requested", status: "awaiting_approval", createdAt: expect.any(String) },
        { sequence: 2, type: "evidence_version_observed", status: "awaiting_approval", createdAt: expect.any(String) },
        { sequence: 1, type: "evidence_version_cited", status: "awaiting_approval", createdAt: expect.any(String) },
      ]);
      const controllerResponse = await desk(controller);
      expect(controllerResponse.status).toBe(200);
      const controllerDesk = await controllerResponse.json();
      expect(controllerDesk.works).toHaveLength(1);
      expect(controllerDesk.works[0]).toMatchObject({ id: treasury, instruction: "Check closing funds", evidence: [], approvals: [] });
      const peerResponse = await desk(peer);
      expect(peerResponse.status).toBe(200);
      const peerDesk = await peerResponse.json();
      expect(peerDesk).toEqual({ works: [] });
      expect((await desk("not-an-employee")).status).toBe(403);
      const requestedById = await desk(associate, `?workId=${diligence}&versionId=${cited.id}`);
      expect(await requestedById.json()).toEqual(associateDesk);
      observations = { associate: associateDesk, controller: controllerDesk, peer: peerDesk };
    } finally {
      process.env.DATABASE_URL = databaseUrl;
    }
    const after = await counts();
    expect(after).toEqual(before);
    const artifact = JSON.stringify({
      pilot: "employee-desk", tenantId, dealId, associate, controller, peer, diligence, treasury,
      fixture: "Synthetic setup inserts deal, Work, exhibit and approval rows. It records evidence metadata via the existing transitionWorkTx writer; no live exhibit-to-Work publisher is part of this pilot.",
      inputs: { sourceId, cited: version(cited), latestRecorded: version(amended), unrecorded: unrecorded.id, reviewer },
      steps: ["cite exhibit v1 on Work", "record v2 on Work", "leave v3 outside Work", "read as each participant", "compare row counts"],
      observations: { ...observations, before, after },
    });
    const artifactPath = process.env.EMPLOYEE_DESK_ARTIFACT_PATH;
    if (artifactPath) writeFileSync(artifactPath, artifact + "\n");
    else console.info(artifact);
  });
});
