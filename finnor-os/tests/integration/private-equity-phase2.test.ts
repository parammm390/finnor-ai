import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTask } from "@finnor/data-platform";
import { closePool, configureTenantVertical, receiveWork, withTenant } from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import {
  DealCloseRejectedError,
  PeDomainError,
  acceptDealRisk,
  acceptDeliverable,
  acknowledgeRequest,
  addDealParty,
  attachCanonicalEvidence,
  attachWorkToDealGraph,
  createClosingCondition,
  createClosingItem,
  createDeal,
  createDealRisk,
  createDeliverable,
  createDependency,
  createFinding,
  createMilestone,
  createRequest,
  createWorkstream,
  declareDealClosed,
  evaluateDealCloseEligibility,
  failClosingCondition,
  getDeal,
  listDealHistory,
  loadDealExecutionGraph,
  markClosingConditionEvidencePending,
  markClosingItemReady,
  receiveDeliverable,
  rejectDeliverable,
  resolveFinding,
  satisfyClosingCondition,
  startWorkstream,
  verifyClosingItem,
  waiveClosingCondition,
} from "@finnor/private-equity";
import type { PeMutationContext } from "@finnor/private-equity";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const databaseAvailable = await canConnect(SUPER_URL);

async function scopedQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  userId: string,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path=finnor_os,public");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenantId, userId]);
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe.skipIf(!databaseAvailable)("Private Equity Phase 2 canonical execution graph", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const waterTenant = randomUUID();
  const noneTenant = randomUUID();
  const leadA = randomUUID();
  const associateA = randomUUID();
  const leadB = randomUUID();
  const teamA = randomUUID();
  const targetA = randomUUID();
  const targetB = randomUUID();
  const sellerCounselA = randomUUID();
  const qoeAdvisorA = randomUUID();
  const lenderA = randomUUID();
  const loiA = randomUUID();
  const qoeDraftA = randomUUID();
  const qoeFinalA = randomUUID();
  const disclosureA = randomUUID();
  const lenderCommitmentA = randomUUID();
  const signaturesA = randomUUID();
  const otherTenantDocument = randomUUID();
  const evidenceA = randomUUID();
  const evidenceVersionA = randomUUID();
  const evidenceB = randomUUID();
  const evidenceVersionB = randomUUID();
  const ctxA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: leadA, employeeId: leadA, role: "owner" },
    provenance: { sourceSystem: "integration:pe2", createdBy: leadA, observedAt: new Date("2026-09-05T09:00:00Z") },
  };
  const ctxB: PeMutationContext = {
    auth: { tenantId: tenantB, userId: leadB, employeeId: leadB, role: "owner" },
    provenance: { sourceSystem: "integration:pe2", createdBy: leadB },
  };
  const waterCtx: PeMutationContext = {
    auth: { tenantId: waterTenant, userId: "system:water-test", role: "owner" },
    provenance: { sourceSystem: "integration:pe2", createdBy: "system:water-test" },
  };

  let admin: pg.Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
        ($1,$2,'Atlas PE Tenant'),($3,$4,'Other PE Tenant'),($5,$6,'Water Regression Tenant'),
        ($7,$8,'No Vertical Tenant')`,
      [tenantA, `pe-a-${randomUUID()}`, tenantB, `pe-b-${randomUUID()}`, waterTenant, `water-${randomUUID()}`,
        noneTenant, `none-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name) VALUES
        ($1,$4,$5,'owner','Atlas Deal Lead'),($2,$4,$6,'dispatcher','Atlas Associate'),
        ($3,$7,$8,'owner','Other Deal Lead')`,
      [leadA, associateA, leadB, tenantA, `lead-a-${randomUUID()}@test.invalid`,
        `associate-a-${randomUUID()}@test.invalid`, tenantB, `lead-b-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind) VALUES ($1,$2,'atlas-deal-team','Atlas Deal Team','team')`,
      [teamA, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
        ($1,$6,'atlas-software','Atlas Software','other'),
        ($2,$6,'seller-counsel','Seller Counsel LLP','agency'),
        ($3,$6,'qoe-advisor','QoE Advisory LLP','agency'),
        ($4,$6,'atlas-lender','Atlas Lender','partner'),
        ($5,$7,'other-target','Other Target','other')`,
      [targetA, sellerCounselA, qoeAdvisorA, lenderA, targetB, tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES
        ($1,$8,'loi','Atlas Signed LOI','integration:pe2',$9),
        ($2,$8,'qoe','Atlas_QoE_Draft.pdf','integration:pe2',$9),
        ($3,$8,'qoe','Atlas_QoE_Final.pdf','integration:pe2',$9),
        ($4,$8,'legal','Atlas_Disclosure_Schedules.pdf','integration:pe2',$9),
        ($5,$8,'financing','Atlas_Lender_Commitment.pdf','integration:pe2',$9),
        ($6,$8,'closing','Atlas_Seller_Signatures.pdf','integration:pe2',$9),
        ($7,$10,'other','Other Tenant Document','integration:pe2',$11)`,
      [loiA, qoeDraftA, qoeFinalA, disclosureA, lenderCommitmentA, signaturesA,
        otherTenantDocument, tenantA, leadA, tenantB, leadB],
    );
    await admin.query(
      `INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES
        ($1,'tenant',$3,'atlas-customer-analysis','document','Atlas customer analysis'),
        ($2,'tenant',$4,'other-evidence','document','Other tenant evidence')`,
      [evidenceA, evidenceB, tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES
        ($1,$2,'tenant',$3,1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Top customer is 31%', '{}',now()),
        ($4,$5,'tenant',$6,1,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','Other tenant truth', '{}',now())`,
      [evidenceVersionA, evidenceA, tenantA, evidenceVersionB, evidenceB, tenantB],
    );
    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 1, createdBy: leadA, sourceSystem: "integration:pe2" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 1, createdBy: leadB, sourceSystem: "integration:pe2" });
    await configureTenantVertical({ tenantId: noneTenant, verticalKey: "none", expectedVersion: 1, createdBy: "system:none-test", sourceSystem: "integration:pe2" });
  });

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  async function allowedProof(tenantId: string, employeeId: string, capability: string, resourceType: string, resourceId: string) {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO finnor_os.authority_decisions
        (id,tenant_id,employee_id,authority_revision,operation,capability,resource_type,resource_id,risk,outcome,reason_code,evidence)
       VALUES ($1,$2,$3,coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$2),1),'action',$4,$5,$6,'high','allowed','integration_governed','{}')`,
      [id, tenantId, employeeId, capability, resourceType, resourceId],
    );
    return { authorityDecisionId: id };
  }

  async function approvedProof(conditionId: string) {
    const chainId = randomUUID();
    const actionId = randomUUID();
    const decisionId = randomUUID();
    const requestId = randomUUID();
    const receiptId = randomUUID();
    await admin.query("INSERT INTO finnor_os.approval_chains(id,tenant_id,key,name) VALUES ($1,$2,$3,'PE Waiver Approval')", [chainId, tenantA, `waiver-${randomUUID()}`]);
    await admin.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,status,summary) VALUES ($1,$2,'private_equity:waive_closing_condition','completed','Governed waiver')", [actionId, tenantA]);
    await admin.query(
      `INSERT INTO finnor_os.authority_decisions
        (id,tenant_id,employee_id,authority_revision,operation,capability,resource_type,resource_id,risk,outcome,reason_code,approval_chain_id,evidence,domain_action_id)
       VALUES ($1,$2,$3,coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$2),1),'action','private_equity:waive_closing_condition','pe_closing_condition',$4,'high','approval_required','policy_requires_approval',$5,'{}',$6)`,
      [decisionId, tenantA, leadA, conditionId, chainId, actionId],
    );
    await admin.query(
      `INSERT INTO finnor_os.authority_approval_requests
        (id,tenant_id,domain_action_id,requester_id,authority_decision_id,approval_chain_id,status,resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,'approved',now())`,
      [requestId, tenantA, actionId, leadA, decisionId, chainId],
    );
    await admin.query(
      `INSERT INTO finnor_os.decision_receipts
        (id,tenant_id,domain_action_id,objective,evidence,policy_applied,risk_tier,proposed_action,approval,actual_result,finalized_at)
       VALUES ($1,$2,$3,'Authorize exact PE condition waiver','[]','{}','high','{}',$4,'{}',now())`,
      [receiptId, tenantA, actionId, { required: true, approvedBy: leadA }],
    );
    return { authorityDecisionId: decisionId, decisionReceiptId: receiptId };
  }

  async function allowedProofWithReceipt(
    tenantId: string,
    employeeId: string,
    capability: string,
    resourceType: string,
    resourceId: string,
  ) {
    const actionId = randomUUID();
    const decisionId = randomUUID();
    const receiptId = randomUUID();
    await admin.query(
      "INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,status,summary) VALUES ($1,$2,$3,'completed','Governed PE action')",
      [actionId, tenantId, capability],
    );
    await admin.query(
      `INSERT INTO finnor_os.authority_decisions
        (id,tenant_id,employee_id,authority_revision,operation,capability,resource_type,resource_id,risk,outcome,reason_code,evidence,domain_action_id)
       VALUES ($1,$2,$3,coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$2),1),'action',$4,$5,$6,'high','allowed','integration_governed','{}',$7)`,
      [decisionId, tenantId, employeeId, capability, resourceType, resourceId, actionId],
    );
    await admin.query(
      `INSERT INTO finnor_os.decision_receipts
        (id,tenant_id,domain_action_id,objective,evidence,policy_applied,risk_tier,proposed_action,approval,actual_result,finalized_at)
       VALUES ($1,$2,$3,'Governed PE action','[]','{}','high','{}','{}','{}',now())`,
      [receiptId, tenantId, actionId],
    );
    return { authorityDecisionId: decisionId, decisionReceiptId: receiptId };
  }

  it("persists the complete Atlas signed-LOI to verified-close world without duplicate owners", async () => {
    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Atlas Software acquisition", codeName: "Atlas",
      dealLeadEmployeeId: leadA, signedLoiAt: new Date("2026-09-01T16:00:00Z"),
      signedLoiDocumentId: loiA, targetClosingAt: new Date("2026-09-30T16:00:00Z"),
    });
    const dealId = String(deal.row.id);
    expect(deal.row).toMatchObject({ tenantId: tenantA, targetOrganizationId: targetA, status: "active" });
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.external_organizations WHERE id=$1", [targetA])).rows[0]?.count).toBe(1);
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_type='pe_deal' AND entity_id=$2 AND event_type='pe_deal_target_linked'",
      [tenantA, dealId],
    )).rows[0]?.count).toBe(1);

    const buyer = await addDealParty(ctxA, { dealId, party: { partyType: "employee", partyId: leadA }, role: "buyer_sponsor" });
    const sellerCounsel = await addDealParty(ctxA, { dealId, party: { partyType: "external_organization", partyId: sellerCounselA }, role: "seller_legal_counsel" });
    const qoeAdvisor = await addDealParty(ctxA, { dealId, party: { partyType: "external_organization", partyId: qoeAdvisorA }, role: "qoe_advisor" });
    const lender = await addDealParty(ctxA, { dealId, party: { partyType: "external_organization", partyId: lenderA }, role: "lender" });
    expect([buyer, sellerCounsel, qoeAdvisor, lender].map((result) => result.row.partyId)).toEqual([leadA, sellerCounselA, qoeAdvisorA, lenderA]);

    const kinds = ["financial_diligence", "legal", "tax", "commercial", "technology", "financing"] as const;
    const streams = new Map<string, Record<string, unknown>>();
    for (const kind of kinds) {
      const created = await createWorkstream(ctxA, { dealId, kind, name: kind.replaceAll("_", " "), owner: { partyType: "team", partyId: teamA } });
      const started = await startWorkstream(ctxA, { workstreamId: String(created.row.id), expectedVersion: 1 });
      streams.set(kind, started.row);
    }
    expect([...streams.values()].every((row) => row.state === "active")).toBe(true);
    expect((await getDeal(ctxA, dealId)).status).toBe("active");

    const request = await createRequest(ctxA, {
      dealId, workstreamId: String(streams.get("legal")?.id), requestedFromDealPartyId: String(sellerCounsel.row.id),
      owner: { partyType: "employee", partyId: associateA },
      requestText: "Seller counsel provide final disclosure schedules by Thursday.",
      dueAt: new Date("2026-09-04T12:00:00Z"),
    });
    const acknowledged = await acknowledgeRequest(ctxA, { requestId: String(request.row.id), expectedVersion: 1 });
    expect(acknowledged.row).toMatchObject({ state: "acknowledged", fulfilledAt: null });
    const task = await withTenant(tenantA, (db) => createTask(db, {
      tenantId: tenantA, subjectType: "pe_request", subjectId: String(request.row.id),
      title: "Associate review disclosure schedules", assigneeType: "user", assigneeId: associateA,
    }), leadA);
    expect(task.taskId).not.toBe(request.row.id);
    let graph = await loadDealExecutionGraph(ctxA, dealId, new Date("2026-09-05T12:00:00Z"));
    expect(graph.requests.find((row) => row.id === request.row.id)).toMatchObject({ state: "acknowledged", overdue: true });
    expect(graph.taskLinks).toHaveLength(1);

    const qoeRequest = await createRequest(ctxA, {
      dealId, workstreamId: String(streams.get("financial_diligence")?.id), requestedFromDealPartyId: String(qoeAdvisor.row.id),
      owner: { partyType: "employee", partyId: associateA }, requestText: "QoE advisor provides final QoE report.",
      requiresAcceptedDeliverable: true,
    });
    const deliverable = await createDeliverable(ctxA, {
      dealId, workstreamId: String(streams.get("financial_diligence")?.id), requestId: String(qoeRequest.row.id),
      responsibleDealPartyId: String(qoeAdvisor.row.id), description: "Final QoE Report", kind: "quality_of_earnings",
    });
    await createDependency(ctxA, {
      dealId, blocker: { entityType: "pe_deliverable", entityId: String(deliverable.row.id) },
      blocked: { entityType: "pe_workstream", entityId: String(streams.get("financial_diligence")?.id) },
    });
    const receivedDraft = await receiveDeliverable(ctxA, {
      dealId, deliverableId: String(deliverable.row.id), expectedVersion: 1, documentId: qoeDraftA,
    });
    expect(receivedDraft.row).toMatchObject({ state: "received", acceptedAt: null });
    const rejected = await rejectDeliverable(ctxA, { deliverableId: String(deliverable.row.id), expectedVersion: 2, reason: "Draft requires revision" });
    const receivedFinal = await receiveDeliverable(ctxA, {
      dealId, deliverableId: String(deliverable.row.id), expectedVersion: Number(rejected.row.version), documentId: qoeFinalA,
    });
    const accepted = await acceptDeliverable(ctxA, {
      dealId, deliverableId: String(deliverable.row.id), expectedVersion: Number(receivedFinal.row.version), documentId: qoeFinalA,
    });
    expect(accepted.row).toMatchObject({ state: "accepted" });
    graph = await loadDealExecutionGraph(ctxA, dealId);
    expect(graph.documentLinks.filter((row) => row.entityId === deliverable.row.id).map((row) => row.linkRole)).toEqual(expect.arrayContaining(["submission", "accepted"]));

    const finding = await createFinding(ctxA, {
      dealId, workstreamId: String(streams.get("commercial")?.id),
      statement: "Top customer represents 31% of revenue.", severity: "high", materiality: "material",
      owner: { partyType: "employee", partyId: associateA },
    });
    await attachCanonicalEvidence(ctxA, {
      dealId, entity: { entityType: "pe_finding", entityId: String(finding.row.id) },
      evidenceSourceId: evidenceA, evidenceVersionId: evidenceVersionA, relationship: "supports",
    });
    const risk = await createDealRisk(ctxA, {
      dealId, workstreamId: String(streams.get("commercial")?.id),
      statement: "Loss of top customer materially impairs underwriting case.", severity: "high",
      owner: { partyType: "employee", partyId: leadA }, originatingFindingIds: [String(finding.row.id)],
    });
    const resolvedFinding = await resolveFinding(ctxA, { findingId: String(finding.row.id), expectedVersion: 1, disposition: "Validated and incorporated into underwriting" });
    expect(resolvedFinding.row.state).toBe("resolved");
    expect((await loadDealExecutionGraph(ctxA, dealId)).dealRisks.find((row) => row.id === risk.row.id)?.state).toBe("open");
    await acceptDealRisk(ctxA, { dealRiskId: String(risk.row.id), expectedVersion: 1, response: "Investment committee accepts concentration risk" });
    expect((await loadDealExecutionGraph(ctxA, dealId)).findings.find((row) => row.id === finding.row.id)?.state).toBe("resolved");

    const milestoneA = await createMilestone(ctxA, { dealId, name: "Signing", kind: "signing", owner: { partyType: "employee", partyId: leadA }, targetAt: new Date("2026-09-20T12:00:00Z") });
    const milestoneB = await createMilestone(ctxA, { dealId, name: "Closing", kind: "closing", owner: { partyType: "employee", partyId: leadA }, targetAt: new Date("2026-09-30T12:00:00Z") });
    const milestoneC = await createMilestone(ctxA, { dealId, name: "Funding", kind: "funding", owner: { partyType: "employee", partyId: leadA }, targetAt: new Date("2026-09-29T12:00:00Z") });
    await createDependency(ctxA, { dealId, blocker: { entityType: "pe_milestone", entityId: String(milestoneA.row.id) }, blocked: { entityType: "pe_milestone", entityId: String(milestoneB.row.id) } });
    await expect(createDependency(ctxA, { dealId, blocker: { entityType: "pe_milestone", entityId: String(milestoneB.row.id) }, blocked: { entityType: "pe_milestone", entityId: String(milestoneA.row.id) } })).rejects.toThrow(/cycle/i);
    await createDependency(ctxA, { dealId, blocker: { entityType: "pe_milestone", entityId: String(milestoneB.row.id) }, blocked: { entityType: "pe_milestone", entityId: String(milestoneC.row.id) } });
    await expect(createDependency(ctxA, { dealId, blocker: { entityType: "pe_milestone", entityId: String(milestoneC.row.id) }, blocked: { entityType: "pe_milestone", entityId: String(milestoneA.row.id) } })).rejects.toThrow(/cycle/i);
    expect((await loadDealExecutionGraph(ctxA, dealId)).dependencies.filter((row) => !row.removedAt)).toHaveLength(3);

    const otherDeal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Atlas add-on", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-02T12:00:00Z"), targetClosingAt: new Date("2026-10-15T12:00:00Z"),
    });
    const otherStream = await createWorkstream(ctxA, { dealId: String(otherDeal.row.id), kind: "legal", name: "Legal", owner: { partyType: "employee", partyId: leadA } });
    await expect(createDependency(ctxA, {
      dealId, blocker: { entityType: "pe_milestone", entityId: String(milestoneA.row.id) },
      blocked: { entityType: "pe_workstream", entityId: String(otherStream.row.id) },
    })).rejects.toThrow(/Deal boundary|deal boundary/i);

    const financingCondition = await createClosingCondition(ctxA, {
      dealId, workstreamId: String(streams.get("financing")?.id), conditionText: "Final lender commitment received.",
      category: "financing", owner: { partyType: "employee", partyId: leadA }, responsibleDealPartyId: String(lender.row.id),
    });
    await expect(satisfyClosingCondition(ctxA, { dealId, closingConditionId: String(financingCondition.row.id), expectedVersion: 1 })).rejects.toMatchObject({ code: "PE_EVIDENCE_REQUIRED" });
    const pendingCondition = await markClosingConditionEvidencePending(ctxA, { closingConditionId: String(financingCondition.row.id), expectedVersion: 1 });
    const satisfiedCondition = await satisfyClosingCondition(ctxA, {
      dealId, closingConditionId: String(financingCondition.row.id), expectedVersion: Number(pendingCondition.row.version), documentId: lenderCommitmentA,
    });
    expect(satisfiedCondition.row).toMatchObject({ state: "satisfied" });
    await expect(markClosingConditionEvidencePending(ctxA, { closingConditionId: String(financingCondition.row.id), expectedVersion: Number(satisfiedCondition.row.version) })).rejects.toMatchObject({ code: "PE_INVALID_TRANSITION" });

    const consentCondition = await createClosingCondition(ctxA, {
      dealId, workstreamId: String(streams.get("legal")?.id), conditionText: "Minor customer consent obtained or validly waived.",
      category: "consent", owner: { partyType: "employee", partyId: leadA }, waiverRequiresApproval: true,
    });
    await expect(waiveClosingCondition(ctxA, {
      closingConditionId: String(consentCondition.row.id), expectedVersion: 1, reason: "Immaterial contract",
    })).rejects.toBeInstanceOf(PeDomainError);
    const waiverProof = await approvedProof(String(consentCondition.row.id));
    const waived = await waiveClosingCondition(ctxA, {
      closingConditionId: String(consentCondition.row.id), expectedVersion: 1,
      reason: "Investment committee approved immaterial consent waiver", governance: waiverProof,
    });
    expect(waived.row).toMatchObject({ state: "waived", waiverAuthorityDecisionId: waiverProof.authorityDecisionId, waiverDecisionReceiptId: waiverProof.decisionReceiptId });

    const closingItem = await createClosingItem(ctxA, {
      dealId, workstreamId: String(streams.get("legal")?.id), itemText: "Seller signatures complete.",
      category: "signature", owner: { partyType: "employee", partyId: associateA }, responsibleDealPartyId: String(sellerCounsel.row.id),
    });
    const ready = await markClosingItemReady(ctxA, { closingItemId: String(closingItem.row.id), expectedVersion: 1 });
    let eligibility = await evaluateDealCloseEligibility(ctxA, dealId);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.unverifiedClosingItems.map((item) => item.item)).toContain("Seller signatures complete.");
    await expect(declareDealClosed(ctxA, { dealId })).rejects.toBeInstanceOf(DealCloseRejectedError);
    const verified = await verifyClosingItem(ctxA, {
      dealId, closingItemId: String(closingItem.row.id), expectedVersion: Number(ready.row.version),
      verifierEmployeeId: leadA, documentId: signaturesA,
    });
    expect(verified.row).toMatchObject({ state: "verified", verifiedByEmployeeId: leadA });

    const work = await receiveWork({ tenantId: tenantA, userId: leadA, channel: "console",
      instruction: "Resolve Atlas financing condition before Friday.", idempotencyKey: `pe-work-${randomUUID()}` });
    await attachWorkToDealGraph(ctxA, { dealId, workId: work.workId, entities: [
      { entityType: "pe_deal", entityId: dealId, relationship: "about" },
      { entityType: "pe_workstream", entityId: String(streams.get("financing")?.id), relationship: "target" },
      { entityType: "pe_closing_condition", entityId: String(financingCondition.row.id), relationship: "target" },
    ] });
    await closePool();
    process.env.DATABASE_URL = APP_URL;
    graph = await loadDealExecutionGraph(ctxA, dealId);
    expect(graph.workLinks.filter((row) => row.workId === work.workId)).toHaveLength(3);

    eligibility = await evaluateDealCloseEligibility(ctxA, dealId);
    expect(eligibility).toMatchObject({ eligible: true, signedLoiPresent: true, blockingConditions: [], failedConditions: [], unverifiedClosingItems: [], blockingDependencies: [], invalidWaivers: [] });
    const closeProof = await allowedProof(tenantA, leadA, "private_equity:close_deal", "pe_deal", dealId);
    const closed = await declareDealClosed(ctxA, { dealId, governance: closeProof });
    expect(closed).toMatchObject({ changed: true, idempotent: false });
    expect(closed.row).toMatchObject({ status: "closed" });
    expect(Number.isNaN(Date.parse(String(closed.row.actualCloseAt)))).toBe(false);
    const duplicate = await declareDealClosed(ctxA, { dealId });
    expect(duplicate).toMatchObject({ changed: false, idempotent: true });
    await expect(scopedQuery(tenantA, leadA,
      "INSERT INTO finnor_os.tasks(tenant_id,subject_type,subject_id,title,priority) VALUES ($1,'pe_deal',$2,'Task after close must fail','normal')",
      [tenantA, dealId],
    )).rejects.toThrow(/closed or terminated PE Deal graph/i);
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_type='pe_deal' AND entity_id=$2 AND event_type='pe_deal_closed'", [tenantA, dealId])).rows[0]?.count).toBe(1);

    const history = await listDealHistory(ctxA, dealId);
    const conditionHistory = history.filter((event) => event.entityId === financingCondition.row.id);
    expect(conditionHistory.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "pe_closing_condition_created", "pe_closing_condition_evidence_pending", "pe_closing_condition_satisfied",
    ]));
    expect(conditionHistory.find((event) => event.eventType === "pe_closing_condition_satisfied")?.payload).toMatchObject({
      actor: leadA, to: "satisfied", evidence: expect.arrayContaining([expect.objectContaining({ type: "document", id: lenderCommitmentA })]),
    });
  }, 60_000);

  it("certifies registry ownership, RLS, initial states, immutable close truth, and vertical=none", async () => {
    const peTables = [
      "pe_deals", "pe_deal_parties", "pe_workstreams", "pe_requests", "pe_deliverables", "pe_findings",
      "pe_deal_risks", "pe_finding_risk_links", "pe_dependencies", "pe_milestones",
      "pe_closing_conditions", "pe_closing_items", "pe_document_links", "pe_evidence_links",
    ];
    const peTypes = peTables.map((table) => table === "pe_deals" ? "pe_deal"
      : table === "pe_deal_parties" ? "pe_deal_party"
        : table === "pe_deal_risks" ? "pe_deal_risk"
          : table.replace(/^pe_/, "pe_").replace(/ies$/, "y").replace(/s$/, ""));
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='finnor_os' AND p.tablename=c.relname AND p.policyname='tenant_isolation') policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [peTables],
    );
    expect(rls.rows).toHaveLength(peTables.length);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1)).toBe(true);

    const registry = await admin.query<{ entity_type: string; vertical_key: string; writable_owner: string; mutation_boundary: string }>(
      "SELECT entity_type,vertical_key,writable_owner,mutation_boundary FROM finnor_os.canonical_truth_registry WHERE vertical_key='private_equity' ORDER BY entity_type",
    );
    expect(registry.rows).toHaveLength(peTables.length);
    expect(registry.rows.every((row) => row.writable_owner === "@finnor/private-equity" && row.mutation_boundary.length > 0)).toBe(true);
    expect(registry.rows.map((row) => row.entity_type).sort()).toEqual(peTypes.sort());

    const none = await admin.query<{ vertical: string; core_available: boolean; water_available: boolean; pe_available: boolean }>(
      `SELECT finnor_os.active_tenant_vertical($1) vertical,
        finnor_os.canonical_entity_available($1,'work') core_available,
        finnor_os.canonical_entity_available($1,'household') water_available,
        finnor_os.canonical_entity_available($1,'pe_deal') pe_available`,
      [noneTenant],
    );
    expect(none.rows[0]).toEqual({ vertical: "none", core_available: true, water_available: false, pe_available: false });
    expect((await admin.query("SELECT finnor_os.active_tenant_vertical($1) vertical", [waterTenant])).rows[0]?.vertical).toBe("water");

    const fabricatedDealId = randomUUID();
    await expect(scopedQuery(tenantA, leadA,
      `INSERT INTO finnor_os.pe_deals
        (id,tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,target_closing_at,
         status,actual_close_at,source_system,created_by)
       VALUES ($1,$2,$3,'Fabricated closed Deal',$4,now(),now(),'closed',now(),'integration:pe2',$5)`,
      [fabricatedDealId, tenantA, targetA, leadA, leadA],
    )).rejects.toThrow(/must be created.*active/i);
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.pe_deals WHERE id=$1", [fabricatedDealId])).rows[0]?.count).toBe(0);

    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Canonical boundary deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-05T10:00:00Z"), targetClosingAt: new Date("2026-11-01T12:00:00Z"),
    });
    const stream = await createWorkstream(ctxA, {
      dealId: String(deal.row.id), kind: "closing", name: "Boundary Closing",
      owner: { partyType: "employee", partyId: leadA },
    });
    const fabricatedItemId = randomUUID();
    await expect(scopedQuery(tenantA, leadA,
      `INSERT INTO finnor_os.pe_closing_items
        (id,tenant_id,deal_id,workstream_id,item_text,category,owner_party_type,owner_party_id,
         state,ready_at,source_system,created_by)
       VALUES ($1,$2,$3,$4,'Fabricated ready item','signature','employee',$5,'ready',now(),'integration:pe2',$6)`,
      [fabricatedItemId, tenantA, deal.row.id, stream.row.id, leadA, leadA],
    )).rejects.toThrow(/initial state open/i);
    expect((await admin.query("SELECT count(*)::int count FROM finnor_os.pe_closing_items WHERE id=$1", [fabricatedItemId])).rows[0]?.count).toBe(0);

    const condition = await createClosingCondition(ctxA, {
      dealId: String(deal.row.id), workstreamId: String(stream.row.id), conditionText: "Immutable required condition",
      category: "governance", owner: { partyType: "employee", partyId: leadA }, evidenceRequired: false,
    });
    await expect(scopedQuery(tenantA, leadA,
      "UPDATE finnor_os.pe_closing_conditions SET required_for_close=false,version=version+1 WHERE id=$1",
      [condition.row.id],
    )).rejects.toThrow(/immutable PE business truth/i);
    await expect(scopedQuery(tenantA, leadA,
      "UPDATE finnor_os.pe_closing_conditions SET version=version+1 WHERE id=$1",
      [condition.row.id],
    )).rejects.toThrow(/must change canonical business truth/i);
    expect((await admin.query("SELECT required_for_close,version FROM finnor_os.pe_closing_conditions WHERE id=$1", [condition.row.id])).rows[0]).toMatchObject({ required_for_close: true, version: 1 });

    await expect(scopedQuery(tenantA, leadA,
      "UPDATE finnor_os.pe_deals SET status='closed',actual_close_at=now(),version=version+1 WHERE id=$1",
      [deal.row.id],
    )).rejects.toThrow();
    await expect(scopedQuery(tenantA, leadA,
      "INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source) VALUES ($1,'pe_deal',$2,'pe_deal_closed','{}','forged')",
      [tenantA, deal.row.id],
    )).rejects.toThrow(/canonical PE history/i);
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.business_events WHERE entity_type='pe_deal' AND entity_id=$1 AND event_type='pe_deal_closed'",
      [deal.row.id],
    )).rows[0]?.count).toBe(0);
  });

  it("fails all cross-tenant graph references closed under application RLS", async () => {
    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Cross tenant guard deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-03T12:00:00Z"), targetClosingAt: new Date("2026-10-30T12:00:00Z"),
    });
    const stream = await createWorkstream(ctxA, { dealId: String(deal.row.id), kind: "legal", name: "Guard Legal", owner: { partyType: "employee", partyId: leadA } });
    const finding = await createFinding(ctxA, {
      dealId: String(deal.row.id), workstreamId: String(stream.row.id), statement: "Guard finding",
      severity: "low", materiality: "immaterial", owner: { partyType: "employee", partyId: leadA },
    });
    await expect(createDeal(ctxA, {
      targetOrganizationId: targetB, name: "Cross tenant target", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-03T12:00:00Z"), targetClosingAt: new Date("2026-10-30T12:00:00Z"),
    })).rejects.toThrow(/target.*tenant|party.*resolved|outside the authenticated tenant/i);
    await expect(addDealParty(ctxA, { dealId: String(deal.row.id), party: { partyType: "external_organization", partyId: targetB }, role: "seller" })).rejects.toMatchObject({ code: "PE_PARTY_NOT_RESOLVED" });
    await expect(scopedQuery(tenantA, leadA,
      `INSERT INTO finnor_os.pe_document_links(tenant_id,deal_id,entity_type,entity_id,document_id,link_role,source_system,created_by)
       VALUES ($1,$2,'pe_finding',$3,$4,'source','integration:pe2',$5)`,
      [tenantA, deal.row.id, finding.row.id, otherTenantDocument, leadA])).rejects.toThrow();
    await expect(attachCanonicalEvidence(ctxA, {
      dealId: String(deal.row.id), entity: { entityType: "pe_finding", entityId: String(finding.row.id) },
      evidenceSourceId: evidenceB, evidenceVersionId: evidenceVersionB, relationship: "supports",
    })).rejects.toThrow(/tenant boundary/i);

    const milestoneA = await createMilestone(ctxA, {
      dealId: String(deal.row.id), name: "Tenant A milestone", kind: "guard",
      owner: { partyType: "employee", partyId: leadA }, targetAt: new Date("2026-10-01T12:00:00Z"),
    });
    const dealB = await createDeal(ctxB, {
      targetOrganizationId: targetB, name: "Tenant B guard deal", dealLeadEmployeeId: leadB,
      signedLoiAt: new Date("2026-09-03T12:00:00Z"), targetClosingAt: new Date("2026-10-30T12:00:00Z"),
    });
    const milestoneB = await createMilestone(ctxB, {
      dealId: String(dealB.row.id), name: "Tenant B milestone", kind: "guard",
      owner: { partyType: "employee", partyId: leadB }, targetAt: new Date("2026-10-01T12:00:00Z"),
    });
    await expect(createDependency(ctxA, {
      dealId: String(deal.row.id),
      blocker: { entityType: "pe_milestone", entityId: String(milestoneA.row.id) },
      blocked: { entityType: "pe_milestone", entityId: String(milestoneB.row.id) },
    })).rejects.toThrow(/tenant|Deal boundary|missing/i);

    const condition = await createClosingCondition(ctxA, {
      dealId: String(deal.row.id), workstreamId: String(stream.row.id), conditionText: "Tenant-scoped waiver",
      category: "consent", owner: { partyType: "employee", partyId: leadA },
      evidenceRequired: false, waiverRequiresApproval: false,
    });
    const otherTenantProof = await allowedProofWithReceipt(
      tenantB, leadB, "private_equity:waive_closing_condition", "pe_closing_condition", String(condition.row.id),
    );
    await expect(scopedQuery(tenantA, leadA,
      `UPDATE finnor_os.pe_closing_conditions SET state='waived',waived_at=now(),waiver_reason='Invalid cross-tenant proof',
        waiver_authority_decision_id=$2,waiver_decision_receipt_id=$3,version=version+1 WHERE id=$1`,
      [condition.row.id, otherTenantProof.authorityDecisionId, otherTenantProof.decisionReceiptId],
    )).rejects.toThrow(/authority|tenant|foreign key/i);
    expect((await admin.query("SELECT state,version FROM finnor_os.pe_closing_conditions WHERE id=$1", [condition.row.id])).rows[0]).toMatchObject({ state: "open", version: 1 });
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.pe_dependencies WHERE deal_id=$1 AND blocked_id=$2",
      [deal.row.id, milestoneB.row.id],
    )).rows[0]?.count).toBe(0);
    expect((await scopedQuery(tenantA, leadA, "SELECT * FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id IN (SELECT id FROM finnor_os.pe_deals WHERE tenant_id=$2)", [tenantB, tenantB])).rows).toHaveLength(0);
  });

  it("isolates Water and PE registrations while preserving Water writes", async () => {
    const waterHousehold = randomUUID();
    await scopedQuery(waterTenant, "system:water-test",
      "INSERT INTO finnor_os.households(id,tenant_id,address,contact_info) VALUES ($1,$2,$3,$4)",
      [waterHousehold, waterTenant, "1 Water Way", { name: "Water Customer" }]);
    expect((await scopedQuery(waterTenant, "system:water-test", "SELECT id FROM finnor_os.households WHERE id=$1", [waterHousehold])).rows).toHaveLength(1);
    await expect(scopedQuery(tenantA, leadA,
      "INSERT INTO finnor_os.households(id,tenant_id,address,contact_info) VALUES ($1,$2,$3,$4)",
      [randomUUID(), tenantA, "2 Invalid Way", { name: "Not a PE target" }])).rejects.toThrow(/unsupported.*vertical/i);
    await expect(createDeal(waterCtx, {
      targetOrganizationId: targetA, name: "Invalid Water Deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date(), targetClosingAt: new Date(),
    })).rejects.toBeInstanceOf(PeDomainError);
  });

  it("names open, failed, and dependency blockers and never emits premature close history", async () => {
    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Premature close guard deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-04T12:00:00Z"), targetClosingAt: new Date("2026-10-15T12:00:00Z"),
    });
    const dealId = String(deal.row.id);
    const stream = await createWorkstream(ctxA, {
      dealId, kind: "closing", name: "Premature Close", owner: { partyType: "employee", partyId: leadA },
    });
    const condition = await createClosingCondition(ctxA, {
      dealId, workstreamId: String(stream.row.id), conditionText: "Regulatory approval obtained",
      category: "regulatory", owner: { partyType: "employee", partyId: leadA }, evidenceRequired: false,
    });
    const proof = await allowedProof(tenantA, leadA, "private_equity:close_deal", "pe_deal", dealId);
    let eligibility = await evaluateDealCloseEligibility(ctxA, dealId);
    expect(eligibility.blockingConditions).toEqual([
      expect.objectContaining({ id: condition.row.id, condition: "Regulatory approval obtained", state: "open" }),
    ]);
    await expect(declareDealClosed(ctxA, { dealId, governance: proof })).rejects.toMatchObject({
      code: "PE_DEAL_NOT_CLOSE_ELIGIBLE",
      eligibility: expect.objectContaining({ blockingConditions: expect.arrayContaining([expect.objectContaining({ id: condition.row.id })]) }),
    });
    await failClosingCondition(ctxA, { closingConditionId: String(condition.row.id), expectedVersion: 1, reason: "Regulator denied approval" });
    eligibility = await evaluateDealCloseEligibility(ctxA, dealId);
    expect(eligibility.failedConditions).toEqual([
      expect.objectContaining({ id: condition.row.id, state: "failed", reason: "Regulator denied approval" }),
    ]);
    await expect(declareDealClosed(ctxA, { dealId, governance: proof })).rejects.toBeInstanceOf(DealCloseRejectedError);
    expect((await getDeal(ctxA, dealId)).status).toBe("active");
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.business_events WHERE entity_type='pe_deal' AND entity_id=$1 AND event_type='pe_deal_closed'",
      [dealId],
    )).rows[0]?.count).toBe(0);

    const dependencyDeal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Dependency close guard deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-04T13:00:00Z"), targetClosingAt: new Date("2026-10-16T12:00:00Z"),
    });
    const dependencyDealId = String(dependencyDeal.row.id);
    const dependencyStream = await createWorkstream(ctxA, {
      dealId: dependencyDealId, kind: "financing", name: "Dependency Financing",
      owner: { partyType: "employee", partyId: leadA },
    });
    const blocker = await createDealRisk(ctxA, {
      dealId: dependencyDealId, workstreamId: String(dependencyStream.row.id),
      statement: "Lender commitment remains unavailable", severity: "high",
      owner: { partyType: "employee", partyId: leadA },
    });
    const blockedCondition = await createClosingCondition(ctxA, {
      dealId: dependencyDealId, workstreamId: String(dependencyStream.row.id),
      conditionText: "Financing commitment obtained", category: "financing",
      owner: { partyType: "employee", partyId: leadA }, evidenceRequired: false,
    });
    const dependency = await createDependency(ctxA, {
      dealId: dependencyDealId,
      blocker: { entityType: "pe_deal_risk", entityId: String(blocker.row.id) },
      blocked: { entityType: "pe_closing_condition", entityId: String(blockedCondition.row.id) },
    });
    eligibility = await evaluateDealCloseEligibility(ctxA, dependencyDealId);
    expect(eligibility.blockingDependencies).toEqual([
      expect.objectContaining({ dependencyId: dependency.row.id, blocker: { entityType: "pe_deal_risk", entityId: blocker.row.id } }),
    ]);
    await expect(satisfyClosingCondition(ctxA, {
      dealId: dependencyDealId, closingConditionId: String(blockedCondition.row.id), expectedVersion: 1,
    })).rejects.toThrow(/unresolved hard blocker/i);
    await acceptDealRisk(ctxA, { dealRiskId: String(blocker.row.id), expectedVersion: 1, response: "Lender commitment received and reviewed" });
    await satisfyClosingCondition(ctxA, {
      dealId: dependencyDealId, closingConditionId: String(blockedCondition.row.id), expectedVersion: 1,
    });
    expect((await evaluateDealCloseEligibility(ctxA, dependencyDealId)).eligible).toBe(true);
  });

  it("rejects a stale close when a required condition commits after its eligibility snapshot", async () => {
    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Close race deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-04T12:00:00Z"), targetClosingAt: new Date("2026-10-01T12:00:00Z"),
    });
    const stream = await createWorkstream(ctxA, { dealId: String(deal.row.id), kind: "closing", name: "Race Closing", owner: { partyType: "employee", partyId: leadA } });
    const snapshot = await evaluateDealCloseEligibility(ctxA, String(deal.row.id));
    expect(snapshot.eligible).toBe(true);
    const proof = await allowedProof(tenantA, leadA, "private_equity:close_deal", "pe_deal", String(deal.row.id));

    const txA = new pg.Client({ connectionString: APP_URL });
    await txA.connect();
    await txA.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await txA.query("SET LOCAL search_path=finnor_os,public");
    await txA.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenantA, leadA]);
    const inTransaction = await txA.query<{ eligibility: { eligible: boolean } }>(
      "SELECT finnor_os.pe_evaluate_deal_close_eligibility($1,$2) eligibility", [tenantA, deal.row.id]);
    expect(inTransaction.rows[0]?.eligibility.eligible).toBe(true);
    await createClosingCondition(ctxA, {
      dealId: String(deal.row.id), workstreamId: String(stream.row.id), conditionText: "Newly required consent",
      category: "consent", owner: { partyType: "employee", partyId: leadA }, evidenceRequired: false,
    });
    await expect(txA.query(
      "SELECT finnor_os.pe_declare_deal_closed($1,$2,$3,$4,$5,$6,$7,$8)",
      [tenantA, deal.row.id, snapshot.dealVersion, snapshot.graphVersion, proof.authorityDecisionId, null, "integration:pe2", leadA],
    )).rejects.toMatchObject({ code: "40001" });
    await txA.query("ROLLBACK");
    await txA.end();
    expect((await getDeal(ctxA, String(deal.row.id))).status).toBe("active");
  });

  it("serializes competing condition outcomes without last-write-wins", async () => {
    const deal = await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "Condition race deal", dealLeadEmployeeId: leadA,
      signedLoiAt: new Date("2026-09-04T12:00:00Z"), targetClosingAt: new Date("2026-10-01T12:00:00Z"),
    });
    const stream = await createWorkstream(ctxA, { dealId: String(deal.row.id), kind: "financing", name: "Race Financing", owner: { partyType: "employee", partyId: leadA } });
    const condition = await createClosingCondition(ctxA, {
      dealId: String(deal.row.id), workstreamId: String(stream.row.id), conditionText: "Race lender commitment",
      category: "financing", owner: { partyType: "employee", partyId: leadA },
    });
    const outcomes = await Promise.allSettled([
      satisfyClosingCondition(ctxA, { dealId: String(deal.row.id), closingConditionId: String(condition.row.id), expectedVersion: 1, documentId: lenderCommitmentA }),
      failClosingCondition(ctxA, { closingConditionId: String(condition.row.id), expectedVersion: 1, reason: "Lender withdrew" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const graph = await loadDealExecutionGraph(ctxA, String(deal.row.id));
    expect(["satisfied", "failed"]).toContain(graph.closingConditions[0]?.state);
    const transitions = (await listDealHistory(ctxA, String(deal.row.id))).filter((event) =>
      event.entityId === condition.row.id && ["pe_closing_condition_satisfied", "pe_closing_condition_failed"].includes(String(event.eventType)));
    expect(transitions).toHaveLength(1);
  });
});
