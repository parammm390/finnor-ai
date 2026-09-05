import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  businessEffects,
  closePool,
  communicationDeliveries,
  decisionReceipts,
  domainActions,
  integrationOperations,
  receiveWork,
  workAggregate,
  workEventWaits,
  withTenant,
} from "@finnor/db";
import {
  FinnorOrchestrator,
  evaluateObjectiveSuccessCondition,
  ingestIntegrationEvent,
  inspectCurrentObjectiveSuccessState,
  privateEquityObjectiveSuccessCondition,
  processWorkEventWaitDeadline,
  settleExternalEffectObservation,
  type ObjectiveDecision,
  type ObjectiveDecisionPlanner,
  type ObjectiveInspection,
  verifyBusinessEffectPreconditions,
} from "@finnor/orchestration";
import {
  addDealParty,
  attachWorkToDealGraph,
  createClosingCondition,
  createDeal,
  createWorkstream,
  evaluateDealCloseEligibility,
  failClosingCondition,
  fulfillRequest,
  getDeal,
  listDealHistory,
  loadDealExecutionGraph,
  markClosingConditionEvidencePending,
  recordPrivateEquitySourceObservation,
  type PeMutationContext,
} from "@finnor/private-equity";
import { configureTenantVertical } from "@finnor/db";
import type { BusinessEffectSet } from "@finnor/shared-types";
import { ToolRegistry } from "@finnor/tools";
import { migrate } from "../../packages/db/migrate";
import { citeObservedObjectiveEvidence } from "./helpers/objective-completion-evidence";
import { driveDurableAction } from "./helpers/durable-action";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const databaseAvailable = await canConnect(SUPER_URL);

class ScriptedPePlanner implements ObjectiveDecisionPlanner {
  providerName = "pe4-shadow-certification-planner";
  calls = 0;

  constructor(private readonly decisions: Array<ObjectiveDecision | ((inspection: ObjectiveInspection) => ObjectiveDecision)>) {}

  async decide(input: { inspection: ObjectiveInspection }): Promise<ObjectiveDecision> {
    const decision = this.decisions[this.calls++];
    if (!decision) throw new Error("PE4 shadow certification planner exhausted");
    return citeObservedObjectiveEvidence(
      typeof decision === "function" ? decision(input.inspection) : decision,
      input.inspection,
    );
  }
}

describe.skipIf(!databaseAvailable)("Private Equity Phase 4 governed execution", () => {
  const priorGmailUser = process.env.GMAIL_USER;
  const priorGmailPassword = process.env.GMAIL_APP_PASSWORD;
  const priorLegacyCredentialTenants = process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const waterTenant = randomUUID();
  const actor = randomUUID();
  const approver = randomUUID();
  const actorB = randomUUID();
  const targetA = randomUUID();
  const counselA = randomUUID();
  const targetB = randomUUID();
  const authorityRole = randomUUID();
  const approvalChain = randomUUID();
  const evidenceIntegration = randomUUID();
  const communicationIntegration = randomUUID();
  const communicationIdentity = randomUUID();
  const supportingDocument = randomUUID();
  const ctxA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: actor, employeeId: actor, role: "owner" },
    provenance: { sourceSystem: "integration:pe4", createdBy: actor },
  };
  const ctxB: PeMutationContext = {
    auth: { tenantId: tenantB, userId: actorB, employeeId: actorB, role: "owner" },
    provenance: { sourceSystem: "integration:pe4", createdBy: actorB },
  };
  let admin: pg.Client;

  async function anchoredWork(dealId: string, instruction: string, entities: Array<{ entityType: "pe_deal" | "pe_workstream" | "pe_closing_condition"; entityId: string }> = []) {
    const work = await receiveWork({
      tenantId: tenantA,
      userId: actor,
      channel: "console",
      instruction,
      idempotencyKey: `pe4-${randomUUID()}`,
    });
    await attachWorkToDealGraph(ctxA, {
      dealId,
      workId: work.workId,
      entities: [
        { entityType: "pe_deal", entityId: dealId, relationship: "about" },
        ...entities.map((entity) => ({ ...entity, relationship: "target" as const })),
      ],
    });
    return work;
  }

  async function createActiveDeal(name: string) {
    return createDeal(ctxA, {
      targetOrganizationId: targetA,
      name,
      dealLeadEmployeeId: actor,
      signedLoiAt: new Date("2026-09-01T12:00:00.000Z"),
      targetClosingAt: new Date("2026-10-15T17:00:00.000Z"),
    });
  }

  async function approve(orchestrator: FinnorOrchestrator, actionId: string, typedConfirmation = false) {
    return orchestrator.decide(actionId, tenantA, "approve", approver, {
      role: "owner",
      typedConfirmation,
    });
  }

  async function settleShadowDelivery(actionId: string, providerRef: string) {
    const [action] = await withTenant(tenantA, (db) => db.select({ businessEffectId: domainActions.businessEffectId }).from(domainActions).where(and(
      eq(domainActions.tenantId, tenantA), eq(domainActions.id, actionId),
    )).limit(1));
    expect(action?.businessEffectId).toBeTruthy();
    const [operation] = await withTenant(tenantA, (db) => db.select({ id: integrationOperations.id }).from(integrationOperations).where(and(
      eq(integrationOperations.tenantId, tenantA), eq(integrationOperations.businessEffectId, action!.businessEffectId!),
    )).limit(1));
    expect(operation?.id).toBeTruthy();
    await settleExternalEffectObservation({
      tenantId: tenantA,
      businessEffectId: action!.businessEffectId!,
      integrationId: communicationIntegration,
      provider: "gmail",
      externalObjectType: "message",
      externalId: providerRef,
      observedAt: new Date().toISOString(),
      classification: "present",
      expected: { status: "sent", providerRef },
      observed: { status: "sent", providerRef },
      evidence: { mechanism: "read_after_write" },
    }, { integrationOperationId: operation!.id, domainActionId: actionId });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    // The identity fabric requires a governed credential reference even though
    // this test replaces send_email with a no-egress adapter. Restrict the test
    // credential compatibility seam to the single isolated PE tenant.
    process.env.GMAIL_USER = "deal-team@shadow.invalid";
    process.env.GMAIL_APP_PASSWORD = "pe4-shadow-test-only";
    process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS = tenantA;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
        ($1,$2,'PE4 Atlas Shadow'),($3,$4,'PE4 Foreign'),($5,$6,'PE4 Water')`,
      [tenantA, `pe4-a-${randomUUID()}`, tenantB, `pe4-b-${randomUUID()}`, waterTenant, `pe4-water-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name) VALUES
        ($1,$4,$5,'owner','PE4 Deal Lead'),($2,$4,$6,'owner','PE4 Human Approver'),
        ($3,$7,$8,'owner','PE4 Foreign Lead')`,
      [actor, approver, actorB, tenantA, `actor-${randomUUID()}@test.invalid`, `approver-${randomUUID()}@test.invalid`, tenantB, `foreign-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind,business_email) VALUES
        ($1,$4,'pe4-atlas','Atlas Software','other',NULL),
        ($2,$4,'pe4-seller-counsel','Seller Counsel LLP','agency','seller-counsel@shadow.invalid'),
        ($3,$5,'pe4-foreign-target','Foreign Target','other',NULL)`,
      [targetA, counselA, targetB, tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by)
       VALUES ($1,$2,'closing','PE4 governed closing evidence','integration:pe4',$3)`,
      [supportingDocument, tenantA, actor],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode)
       VALUES ($1,$3,'documents','pe4-evidence-emulator','emulator'),
              ($2,$3,'communications','gmail','emulator')`,
      [evidenceIntegration, communicationIntegration, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.communication_identities
        (id,tenant_id,identity_key,provider,channel,address,status,capabilities,credential_provider,credential_ref)
       VALUES ($1,$2,'pe4-shadow-mail','gmail','email','deal-team@shadow.invalid','active','["send"]'::jsonb,'legacy-env','legacy-env:gmail')`,
      [communicationIdentity, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.communication_identity_bindings
        (tenant_id,communication_identity_id,principal_type,principal_id,purpose,priority,status)
       VALUES ($1,$2,'employee',$3,'default',100,'active')`,
      [tenantA, communicationIdentity, actor],
    );
    await admin.query(
      `INSERT INTO finnor_os.approval_chains(id,tenant_id,key,name)
       VALUES ($1,$2,'pe4-human-review','PE4 governed human review')`,
      [approvalChain, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.approval_chain_steps(tenant_id,approval_chain_id,sequence,approver_capability,min_approvals)
       VALUES ($1,$2,1,'approve:$action',1)`,
      [tenantA, approvalChain],
    );
    await admin.query(
      `INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
       VALUES ($1,$2,'pe4-runtime','PE4 Runtime Authority')`,
      [authorityRole, tenantA],
    );
    await admin.query(
      `INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)
       VALUES ($1,$2,$4,'{"kind":"tenant"}'::jsonb),($1,$3,$4,'{"kind":"tenant"}'::jsonb)`,
      [tenantA, actor, approver, authorityRole],
    );
    await admin.query(
      `INSERT INTO finnor_os.role_authority_grants
        (tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required,approval_chain_id)
       VALUES ($1,$2,'*','*','allow','high',false,$3)`,
      [tenantA, authorityRole, approvalChain],
    );

    const actionTypes = [
      "open_workstream", "create_deal_request", "submit_deliverable", "record_finding", "resolve_finding",
      "raise_deal_risk", "resolve_deal_risk", "link_deal_dependency", "mark_dependency_resolved",
      "create_closing_condition", "submit_condition_evidence", "satisfy_closing_condition",
      "waive_closing_condition", "verify_closing_item", "declare_deal_closed",
    ];
    for (const actionType of actionTypes) {
      const policyId = randomUUID();
      await admin.query(
        `INSERT INTO finnor_os.domain_policies
          (id,tenant_id,action_type,policy,requires_confirmation,confirmation_template,version,effective_from)
         VALUES ($1,$2,$3,'{}'::jsonb,false,NULL,1,now())`,
        [policyId, tenantA, actionType],
      );
      await admin.query(
        `INSERT INTO finnor_os.domain_policy_revisions
          (id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,confirmation_template,effective_from)
         VALUES ($1,$2,$3,$4,1,'{}'::jsonb,false,NULL,now())`,
        [randomUUID(), tenantA, policyId, actionType],
      );
    }

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 1, createdBy: actor, sourceSystem: "integration:pe4" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 1, createdBy: actorB, sourceSystem: "integration:pe4" });
  }, 60_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
    if (priorGmailUser === undefined) delete process.env.GMAIL_USER;
    else process.env.GMAIL_USER = priorGmailUser;
    if (priorGmailPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = priorGmailPassword;
    if (priorLegacyCredentialTenants === undefined) delete process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS;
    else process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS = priorLegacyCredentialTenants;
  });

  it("creates one exact Request through DomainAction/BusinessEffect/worker/receipt, blocks duplicates and foreign Deals, and does not mistake creation for fulfillment", async () => {
    const deal = await createActiveDeal("PE4 request journey");
    const dealId = String(deal.row.id);
    const legal = await createWorkstream(ctxA, { dealId, kind: "legal", name: "Legal", owner: { partyType: "employee", partyId: actor } });
    const counsel = await addDealParty(ctxA, {
      dealId,
      party: { partyType: "external_organization", partyId: counselA },
      role: "seller_legal_counsel",
    });
    const work = await anchoredWork(dealId, "Get seller counsel to provide final disclosure schedules.", [
      { entityType: "pe_workstream", entityId: String(legal.row.id) },
    ]);
    const payload = {
      dealId,
      workstreamId: String(legal.row.id),
      requestedFromDealPartyId: String(counsel.row.id),
      owner: { partyType: "employee", partyId: actor },
      requestText: "Provide final disclosure schedules.",
    };
    const orchestrator = new FinnorOrchestrator();
    const drafted = await orchestrator.draftKnownAction("create_deal_request", payload, tenantA, {
      workId: work.workId,
      initiatedBy: actor,
      source: "pe4-shadow-certification",
    });
    expect(drafted.result).toMatchObject({ status: "success", output: { durableWorkerExecution: true, queued: true } });
    const executed = await driveDurableAction(tenantA, drafted.action.id);
    expect(executed).toMatchObject({ status: "success", output: { canonicalMutationOwner: "createRequest", canonicalObserved: true, verified: true } });

    const graph = await loadDealExecutionGraph(ctxA, dealId);
    expect(graph.requests.filter((row) => row.requestText === payload.requestText)).toEqual([
      expect.objectContaining({ id: drafted.action.id, state: "open" }),
    ]);
    expect(graph.workLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ workId: work.workId, entityType: "pe_request", entityId: drafted.action.id }),
    ]));
    const [receipt] = await withTenant(tenantA, (db) => db.select().from(decisionReceipts).where(and(
      eq(decisionReceipts.tenantId, tenantA),
      eq(decisionReceipts.domainActionId, drafted.action.id),
    )).orderBy(desc(decisionReceipts.createdAt)).limit(1));
    expect(receipt).toMatchObject({ finalizedAt: expect.any(Date), failure: null });

    const condition = privateEquityObjectiveSuccessCondition({
      objective: "Get seller counsel to provide final disclosure schedules.",
      dealId,
      subject: { entityType: "pe_request", entityId: drafted.action.id },
    });
    const inspection = await inspectCurrentObjectiveSuccessState(tenantA, work.workId, randomUUID());
    const beforeFulfillment = await evaluateObjectiveSuccessCondition({
      tenantId: tenantA,
      workId: work.workId,
      loopId: randomUUID(),
      stepNumber: 1,
      condition,
      inspection,
      evidence: [{ kind: "business_effect", businessEffectId: inspection.businessEffects[0]!.id }],
    });
    expect(beforeFulfillment.state).toBe("unsatisfied");
    await fulfillRequest(ctxA, { requestId: drafted.action.id, expectedVersion: 1 });
    const afterFulfillment = await evaluateObjectiveSuccessCondition({
      tenantId: tenantA,
      workId: work.workId,
      loopId: randomUUID(),
      stepNumber: 2,
      condition,
      inspection: await inspectCurrentObjectiveSuccessState(tenantA, work.workId, randomUUID()),
      evidence: [{ kind: "business_effect", businessEffectId: inspection.businessEffects[0]!.id }],
    });
    expect(afterFulfillment.state).toBe("verified");

    const duplicateWork = await anchoredWork(dealId, "Avoid a duplicate seller-counsel request.");
    const duplicate = await orchestrator.draftKnownAction("create_deal_request", {
      ...payload,
      requestText: "  PROVIDE   FINAL DISCLOSURE SCHEDULES. ",
    }, tenantA, { workId: duplicateWork.workId, initiatedBy: actor });
    // The earlier Request is now fulfilled, so the same semantic request is legal
    // again. Create one unresolved copy, then prove a third action is blocked.
    expect(duplicate.result.output.durableWorkerExecution).toBe(true);
    await driveDurableAction(tenantA, duplicate.action.id);
    const blockedWork = await anchoredWork(dealId, "Do not duplicate an unresolved request.");
    const blocked = await orchestrator.draftKnownAction("create_deal_request", payload, tenantA, {
      workId: blockedWork.workId,
      initiatedBy: actor,
    });
    expect(blocked.result).toMatchObject({ status: "failure", output: { groundingBlocked: true, code: "PE_REQUEST_ALREADY_EXISTS" } });
    expect((await loadDealExecutionGraph(ctxA, dealId)).requests.filter((row) => String(row.requestText).toLocaleLowerCase().includes("final disclosure schedules"))).toHaveLength(2);

    const foreignDeal = await createDeal(ctxB, {
      targetOrganizationId: targetB,
      name: "PE4 foreign Deal",
      dealLeadEmployeeId: actorB,
      signedLoiAt: new Date("2026-09-01T12:00:00.000Z"),
      targetClosingAt: new Date("2026-10-15T17:00:00.000Z"),
    });
    const foreignAttempt = await orchestrator.draftKnownAction("open_workstream", {
      dealId: String(foreignDeal.row.id),
      kind: "legal",
      name: "Cross-tenant leak",
      owner: { partyType: "employee", partyId: actor },
    }, tenantA, { workId: blockedWork.workId, initiatedBy: actor });
    expect(foreignAttempt.result).toMatchObject({ status: "failure", output: { groundingBlocked: true } });
  }, 60_000);

  it("keeps one PE Work across request, shadow message, durable deadline, chase, response evidence, restart, and verified condition resolution", async () => {
    const deal = await createActiveDeal("PE4 long-lived shadow journey");
    const dealId = String(deal.row.id);
    const legal = await createWorkstream(ctxA, { dealId, kind: "legal", name: "Disclosure schedules", owner: { partyType: "employee", partyId: actor } });
    const counsel = await addDealParty(ctxA, {
      dealId,
      party: { partyType: "external_organization", partyId: counselA },
      role: "seller_legal_counsel",
    });
    const condition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: String(legal.row.id),
      conditionText: "Final disclosure schedules are received and sufficient.",
      category: "legal",
      evidenceRequired: true,
      owner: { partyType: "employee", partyId: actor },
    });
    const conditionId = String(condition.row.id);
    await markClosingConditionEvidencePending(ctxA, { closingConditionId: conditionId, expectedVersion: 1 });

    const providerConversationId = `pe4-disclosures-${randomUUID()}`;
    const firstDeadline = new Date(Date.now() + 30_000);
    const outbound: Array<{ messageId: string; to: string; body: string }> = [];
    const shadowTools = new ToolRegistry();
    shadowTools.register({
      name: "send_email",
      description: "PE4 deterministic no-egress mail emulator",
      integration: "gmail",
      inputSchema: z.object({ tenantId: z.string().uuid(), to: z.string().email(), subject: z.string(), body: z.string() }).passthrough(),
      piiAllowlist: ["tenantId", "to", "subject", "body"],
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 1_000 },
      async run(input) {
        const messageId = `shadow-message-${outbound.length + 1}`;
        outbound.push({ messageId, to: String(input.to), body: String(input.body) });
        return { messageId, providerConversationId, acknowledged: true, observedOutcome: false };
      },
    });

    let requestId = "";
    let sufficientEvidence: Awaited<ReturnType<typeof recordPrivateEquitySourceObservation>> | null = null;
    let objective: { workId: string; objectiveLoopId: string };
    const planner: ScriptedPePlanner = new ScriptedPePlanner([
      {
        kind: "action",
        actionType: "create_deal_request",
        payload: {
          dealId,
          workstreamId: String(legal.row.id),
          requestedFromDealPartyId: String(counsel.row.id),
          owner: { partyType: "employee", partyId: actor },
          requestText: "Provide final disclosure schedules.",
          dueAt: firstDeadline.toISOString(),
        },
        reason: "Create the exact canonical Request once before communicating.",
      },
      () => ({
        kind: "action",
        actionType: "send_message",
        payload: {
          recipient: { partyType: "external_organization", partyId: counselA },
          channel: "email",
          subject: "Final disclosure schedules request",
          body: `Please provide the final disclosure schedules for Request ${requestId}.`,
          workRef: { workId: objective.workId },
          communicationIdentityRef: { communicationIdentityId: communicationIdentity },
          purpose: `pe_request:${requestId}`,
        },
        reason: "Send one bounded message through the configured shadow provider.",
      }),
      () => ({
        kind: "wait",
        waitFor: {
          eventType: "pe.request.response_received",
          resource: { type: "pe_request", id: requestId },
          provider: "gmail",
          providerConversationId,
          correlationId: `pe-request:${requestId}`,
        },
        deadlineAt: firstDeadline.toISOString(),
        condition: "The exact seller-counsel Request responds or its explicit fixture deadline fires.",
        reason: "Persist the exact wait instead of treating provider acknowledgement as fulfillment.",
      }),
      () => ({
        kind: "action",
        actionType: "send_message",
        payload: {
          recipient: { partyType: "external_organization", partyId: counselA },
          channel: "email",
          subject: "Follow-up: final disclosure schedules",
          body: `Following up after the explicit deadline for Request ${requestId}.`,
          workRef: { workId: objective.workId },
          communicationIdentityRef: { communicationIdentityId: communicationIdentity },
          purpose: `pe_request:${requestId}:deadline-follow-up`,
        },
        reason: "The deadline woke Work; current truth is still unresolved, so policy permits one universal follow-up.",
      }),
      () => ({
        kind: "wait",
        waitFor: {
          eventType: "pe.request.response_received",
          resource: { type: "pe_request", id: requestId },
          provider: "gmail",
          providerConversationId,
          correlationId: `pe-request:${requestId}`,
        },
        condition: "Wait for the exact response after the bounded follow-up.",
        reason: "A second send still does not prove the requested outcome.",
      }),
      () => {
        if (!sufficientEvidence?.evidenceSourceId || !sufficientEvidence.evidenceVersionId) throw new Error("Exact response evidence is unavailable");
        return {
          kind: "action",
          actionType: "satisfy_closing_condition",
          payload: {
            dealId,
            closingConditionId: conditionId,
            expectedVersion: 2,
            evidenceSourceId: sufficientEvidence.evidenceSourceId,
            evidenceVersionId: sufficientEvidence.evidenceVersionId,
          },
          reason: "Fresh authoritative response evidence now establishes the exact condition proposition.",
        };
      },
      (inspection) => {
        const conditionEffect = (inspection.businessEffects as Array<{
          id: string;
          status: string;
          effect?: { operation?: { name?: string } };
        }>).find((row) => row.status === "verified" && row.effect?.operation?.name === "satisfy_closing_condition");
        if (!conditionEffect) throw new Error("The verified closing-condition EffectSet is unavailable");
        return {
          kind: "complete",
          outcome: { conditionResolved: conditionId },
          evidence: [{ kind: "business_effect", businessEffectId: conditionEffect.id }],
          reason: "Canonical reread and the exact verified condition EffectSet establish completion.",
        };
      },
    ]);
    let runtime: FinnorOrchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: planner, tools: shadowTools });
    objective = await runtime.startObjective("Resolve the final disclosure schedules condition through one durable PE Work.", {
      tenantId: tenantA,
      userId: actor,
      employeeId: actor,
      role: "owner",
    }, {
      idempotencyKey: `pe4-shadow-objective:${randomUUID()}`,
      activeContext: {
        deal: { entityType: "pe_deal", entityId: dealId },
        condition: { entityType: "pe_closing_condition", entityId: conditionId },
      },
      successCondition: privateEquityObjectiveSuccessCondition({
        objective: "Resolve the final disclosure schedules condition.",
        dealId,
        subject: { entityType: "pe_closing_condition", entityId: conditionId },
      }),
      maxSteps: 12,
      maxActions: 4,
      maxQueries: 12,
    });
    await attachWorkToDealGraph(ctxA, {
      dealId,
      workId: objective.workId,
      entities: [
        { entityType: "pe_deal", entityId: dealId, relationship: "about" },
        { entityType: "pe_workstream", entityId: String(legal.row.id), relationship: "target" },
        { entityType: "pe_closing_condition", entityId: conditionId, relationship: "target" },
      ],
    });

    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("waiting");
    const requestAction = (await withTenant(tenantA, (db) => db.select().from(domainActions).where(and(
      eq(domainActions.tenantId, tenantA), eq(domainActions.workId, objective.workId), eq(domainActions.actionType, "create_deal_request"),
    ))))[0]!;
    requestId = requestAction.id;
    expect(await driveDurableAction(tenantA, requestId, shadowTools)).toMatchObject({ status: "success", output: { canonicalMutationOwner: "createRequest" } });

    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("awaiting_approval");
    let sendActions = await withTenant(tenantA, (db) => db.select().from(domainActions).where(and(
      eq(domainActions.tenantId, tenantA), eq(domainActions.workId, objective.workId), eq(domainActions.actionType, "send_message"),
    )));
    expect(sendActions).toHaveLength(1);
    const firstSendActionId = sendActions[0]!.id;
    await approve(runtime, firstSendActionId);
    expect(await driveDurableAction(tenantA, firstSendActionId, shadowTools)).toMatchObject({
      status: "failure",
      error: "Action remained executing",
    });
    expect(outbound).toEqual([expect.objectContaining({ to: "seller-counsel@shadow.invalid", messageId: "shadow-message-1" })]);
    expect((await withTenant(tenantA, (db) => db.select({ status: businessEffects.status }).from(businessEffects).where(and(
      eq(businessEffects.tenantId, tenantA), eq(businessEffects.domainActionId, firstSendActionId),
    )).limit(1)))[0]).toMatchObject({ status: "partially_verified" });
    await settleShadowDelivery(firstSendActionId, "shadow-message-1");
    expect(await driveDurableAction(tenantA, firstSendActionId, shadowTools)).toMatchObject({ status: "success" });

    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("waiting");
    const firstWait = (await withTenant(tenantA, (db) => db.select().from(workEventWaits).where(and(
      eq(workEventWaits.tenantId, tenantA), eq(workEventWaits.objectiveLoopId, objective.objectiveLoopId), eq(workEventWaits.status, "waiting"),
    )))).find((row) => row.expectedEventType === "pe.request.response_received")!;
    expect(firstWait).toMatchObject({ workId: objective.workId, resourceType: "pe_request", resourceId: requestId });

    // Reconstruct the runtime after a process boundary, then advance the durable
    // fixture clock rather than sleeping for the deadline.
    await closePool();
    runtime = new FinnorOrchestrator({ objectiveDecisionPlanner: planner, tools: shadowTools });
    expect((await processWorkEventWaitDeadline(tenantA, firstWait.id, new Date(firstDeadline.getTime() + 2_001))).outcome).toBe("timed_out");
    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("awaiting_approval");
    sendActions = await withTenant(tenantA, (db) => db.select().from(domainActions).where(and(
      eq(domainActions.tenantId, tenantA), eq(domainActions.workId, objective.workId), eq(domainActions.actionType, "send_message"),
    )));
    expect(sendActions).toHaveLength(2);
    const chaseAction = sendActions.find((row) => row.id !== firstSendActionId)!;
    await approve(runtime, chaseAction.id);
    expect(await driveDurableAction(tenantA, chaseAction.id, shadowTools)).toMatchObject({ status: "failure", error: "Action remained executing" });
    expect(outbound).toHaveLength(2);
    await settleShadowDelivery(chaseAction.id, "shadow-message-2");
    expect(await driveDurableAction(tenantA, chaseAction.id, shadowTools)).toMatchObject({ status: "success" });

    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("waiting");
    const openResponseWait = (await withTenant(tenantA, (db) => db.select().from(workEventWaits).where(and(
      eq(workEventWaits.tenantId, tenantA), eq(workEventWaits.objectiveLoopId, objective.objectiveLoopId), eq(workEventWaits.status, "waiting"),
    )))).find((row) => row.expectedEventType === "pe.request.response_received")!;
    const wrong = await ingestIntegrationEvent({
      tenantId: tenantA,
      source: "pe4_mail_webhook",
      provider: "gmail",
      sourceEventId: `wrong-request-${randomUUID()}`,
      eventType: "pe.request.status_changed",
      workId: objective.workId,
      resource: { type: "pe_request", id: requestId },
      providerConversationId,
      correlationId: `pe-request:${requestId}`,
      payload: { response: "wrong Request" },
      trustClass: "untrusted_external",
    });
    expect(wrong.wakeClaimIds).toEqual([]);

    sufficientEvidence = await recordPrivateEquitySourceObservation(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: conditionId },
      integrationId: evidenceIntegration,
      provider: "pe4-evidence-emulator",
      sourceScope: "disclosure-schedules",
      externalObjectType: "seller-response",
      externalId: `request-${requestId}`,
      claims: [{
        entity: { entityType: "pe_closing_condition", entityId: conditionId },
        predicate: "closing_condition.evidence_sufficient",
        value: true,
      }],
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      sourceVersion: "1",
      sourceSequence: "1",
    });
    const responseInput = {
      tenantId: tenantA,
      source: "pe4_mail_webhook",
      provider: "gmail",
      sourceEventId: `seller-response-${randomUUID()}`,
      eventType: "pe.request.response_received",
      workId: objective.workId,
      resource: { type: "pe_request", id: requestId },
      providerConversationId,
      correlationId: `pe-request:${requestId}`,
      payload: { evidenceSourceId: sufficientEvidence.evidenceSourceId, evidenceVersionId: sufficientEvidence.evidenceVersionId },
      evidenceRefs: [{ type: "evidence_source", id: sufficientEvidence.evidenceSourceId! }],
      trustClass: "untrusted_external" as const,
    };
    const response = await ingestIntegrationEvent(responseInput);
    const replay = await ingestIntegrationEvent(responseInput);
    expect(response).toMatchObject({ duplicate: false, matchedWaitIds: [openResponseWait.id], wakeClaimIds: [expect.any(String)] });
    expect(replay).toMatchObject({ duplicate: true, matchedWaitIds: [], wakeClaimIds: [] });

    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("waiting");
    const conditionAction = (await withTenant(tenantA, (db) => db.select().from(domainActions).where(and(
      eq(domainActions.tenantId, tenantA), eq(domainActions.workId, objective.workId), eq(domainActions.actionType, "satisfy_closing_condition"),
    ))))[0]!;
    expect(await driveDurableAction(tenantA, conditionAction.id, shadowTools)).toMatchObject({ status: "success", output: { canonicalMutationOwner: "satisfyClosingCondition" } });
    expect(await runtime.runObjectiveIteration({ tenantId: tenantA, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("completed");

    const aggregate = await workAggregate(tenantA, objective.workId);
    const graph = await loadDealExecutionGraph(ctxA, dealId);
    expect(aggregate?.objectiveLoop).toMatchObject({ state: "completed", actionCount: 4 });
    expect(graph.requests.filter((row) => row.id === requestId)).toEqual([expect.objectContaining({ state: "open" })]);
    expect(graph.closingConditions.find((row) => row.id === conditionId)).toMatchObject({ state: "satisfied", version: 3 });
    expect(graph.workLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ workId: objective.workId, entityType: "pe_request", entityId: requestId }),
      expect.objectContaining({ workId: objective.workId, entityType: "pe_closing_condition", entityId: conditionId }),
    ]));
    const deliveries = await withTenant(tenantA, (db) => db.select().from(communicationDeliveries).where(and(
      eq(communicationDeliveries.tenantId, tenantA),
      eq(communicationDeliveries.workId, objective.workId),
    )));
    expect(deliveries).toHaveLength(2);
    const journeyWaits = await withTenant(tenantA, (db) => db.select().from(workEventWaits).where(and(
      eq(workEventWaits.tenantId, tenantA), eq(workEventWaits.objectiveLoopId, objective.objectiveLoopId),
    )));
    expect(journeyWaits).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedEventType: "pe.request.response_received", status: "timed_out" }),
      expect.objectContaining({ expectedEventType: "pe.request.response_received", status: "satisfied" }),
    ]));
  }, 90_000);

  it("blocks unresolved P3 evidence, satisfies only from exact authoritative evidence, and rejects stale grounded state", async () => {
    const deal = await createActiveDeal("PE4 condition journey");
    const dealId = String(deal.row.id);
    const stream = await createWorkstream(ctxA, { dealId, kind: "financing", name: "Financing", owner: { partyType: "employee", partyId: actor } });
    const condition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: String(stream.row.id),
      conditionText: "Final lender commitment is issued.",
      category: "financing",
      evidenceRequired: true,
      owner: { partyType: "employee", partyId: actor },
    });
    const conditionId = String(condition.row.id);
    await markClosingConditionEvidencePending(ctxA, { closingConditionId: conditionId, expectedVersion: 1 });
    const falseObservation = await recordPrivateEquitySourceObservation(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: conditionId },
      integrationId: evidenceIntegration,
      provider: "pe4-evidence-emulator",
      sourceScope: "lender-commitments",
      externalObjectType: "commitment",
      externalId: `condition-${conditionId}`,
      claims: [{
        entity: { entityType: "pe_closing_condition", entityId: conditionId },
        predicate: "closing_condition.evidence_sufficient",
        value: false,
      }],
      observedAt: "2026-09-05T17:59:00.000Z",
      sourceVersion: "1",
      sourceSequence: "1",
    });
    const blockedWork = await anchoredWork(dealId, "Resolve financing only when evidence is sufficient.");
    const orchestrator = new FinnorOrchestrator();
    const blocked = await orchestrator.draftKnownAction("satisfy_closing_condition", {
      dealId,
      closingConditionId: conditionId,
      expectedVersion: 2,
      evidenceSourceId: falseObservation.evidenceSourceId!,
      evidenceVersionId: falseObservation.evidenceVersionId!,
    }, tenantA, { workId: blockedWork.workId, initiatedBy: actor });
    expect(blocked.result).toMatchObject({ status: "failure", output: { code: "PE_DECISION_NOT_READY", groundingBlocked: true } });
    expect((await loadDealExecutionGraph(ctxA, dealId)).closingConditions[0]).toMatchObject({ state: "evidence_pending", version: 2 });

    const trueObservation = await recordPrivateEquitySourceObservation(ctxA, {
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: conditionId },
      integrationId: evidenceIntegration,
      provider: "pe4-evidence-emulator",
      sourceScope: "lender-commitments",
      externalObjectType: "commitment",
      externalId: `condition-${conditionId}`,
      claims: [{
        entity: { entityType: "pe_closing_condition", entityId: conditionId },
        predicate: "closing_condition.evidence_sufficient",
        value: true,
        supersedesEvidenceRefs: [
          `evidence-source:${falseObservation.evidenceSourceId}:version:${falseObservation.evidenceVersionId}`,
        ],
      }],
      observedAt: "2026-09-05T18:00:00.000Z",
      sourceVersion: "2",
      sourceSequence: "2",
    });
    const satisfiedWork = await anchoredWork(dealId, "Apply the current lender evidence.");
    const satisfied = await orchestrator.draftKnownAction("satisfy_closing_condition", {
      dealId,
      closingConditionId: conditionId,
      expectedVersion: 2,
      evidenceSourceId: trueObservation.evidenceSourceId!,
      evidenceVersionId: trueObservation.evidenceVersionId!,
    }, tenantA, { workId: satisfiedWork.workId, initiatedBy: actor });
    expect(satisfied.result.output.durableWorkerExecution).toBe(true);
    expect(await driveDurableAction(tenantA, satisfied.action.id)).toMatchObject({ status: "success", output: { canonicalMutationOwner: "satisfyClosingCondition" } });
    expect((await loadDealExecutionGraph(ctxA, dealId)).closingConditions[0]).toMatchObject({ state: "satisfied", version: 3 });

    const staleCondition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: String(stream.row.id),
      conditionText: "Consent remains current.",
      category: "consent",
      evidenceRequired: false,
      owner: { partyType: "employee", partyId: actor },
      requiredForClose: false,
    });
    const staleWork = await anchoredWork(dealId, "Prove stale satisfaction cannot overwrite truth.");
    const stale = await orchestrator.draftKnownAction("satisfy_closing_condition", {
      dealId,
      closingConditionId: String(staleCondition.row.id),
      expectedVersion: 1,
      documentId: supportingDocument,
    }, tenantA, { workId: staleWork.workId, initiatedBy: actor });
    expect(stale.result.output.durableWorkerExecution).toBe(true);
    await failClosingCondition(ctxA, { closingConditionId: String(staleCondition.row.id), expectedVersion: 1, reason: "Consent withdrawn" });
    expect((await driveDurableAction(tenantA, stale.action.id)).status).toBe("failure");
    const staleAfter = (await loadDealExecutionGraph(ctxA, dealId)).closingConditions.find((row) => row.id === staleCondition.row.id);
    expect(staleAfter).toMatchObject({ state: "failed", version: 2 });
  }, 60_000);

  it("requires exact human approval for waiver and rejects an approved waiver after canonical state changes", async () => {
    const deal = await createActiveDeal("PE4 waiver journey");
    const dealId = String(deal.row.id);
    const stream = await createWorkstream(ctxA, { dealId, kind: "closing", name: "Closing", owner: { partyType: "employee", partyId: actor } });
    const condition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: String(stream.row.id),
      conditionText: "Landlord consent is obtained.",
      category: "consent",
      evidenceRequired: false,
      owner: { partyType: "employee", partyId: actor },
    });
    const work = await anchoredWork(dealId, "Waive the landlord consent condition.");
    const orchestrator = new FinnorOrchestrator();
    const drafted = await orchestrator.draftKnownAction("waive_closing_condition", {
      dealId,
      closingConditionId: String(condition.row.id),
      expectedVersion: 1,
      reason: "Seller indemnity accepted for this exact condition.",
    }, tenantA, { workId: work.workId, initiatedBy: actor });
    expect(drafted.result).toMatchObject({ status: "success", output: { gated: true, pendingConfirmation: true } });
    expect((await loadDealExecutionGraph(ctxA, dealId)).closingConditions[0]).toMatchObject({ state: "open", version: 1 });
    expect(await driveDurableAction(tenantA, drafted.action.id)).toMatchObject({ status: "failure" });

    expect(await approve(orchestrator, drafted.action.id)).toMatchObject({ status: "success", output: { durable: true, queued: true } });
    await failClosingCondition(ctxA, { closingConditionId: String(condition.row.id), expectedVersion: 1, reason: "New adverse fact" });
    expect((await driveDurableAction(tenantA, drafted.action.id)).status).toBe("failure");
    expect((await loadDealExecutionGraph(ctxA, dealId)).closingConditions[0]).toMatchObject({ state: "failed", version: 2 });

    const validCondition = await createClosingCondition(ctxA, {
      dealId,
      workstreamId: String(stream.row.id),
      conditionText: "Minor notice condition.",
      category: "notice",
      evidenceRequired: false,
      owner: { partyType: "employee", partyId: actor },
      requiredForClose: false,
    });
    const validWork = await anchoredWork(dealId, "Waive the exact minor notice condition.");
    const valid = await orchestrator.draftKnownAction("waive_closing_condition", {
      dealId,
      closingConditionId: String(validCondition.row.id),
      expectedVersion: 1,
      reason: "Counterparty written consent is recorded.",
    }, tenantA, { workId: validWork.workId, initiatedBy: actor });
    expect(await approve(orchestrator, valid.action.id)).toMatchObject({ status: "success", output: { durable: true, queued: true } });
    expect(await driveDurableAction(tenantA, valid.action.id)).toMatchObject({ status: "success", output: { canonicalMutationOwner: "waiveClosingCondition" } });
    const waived = (await loadDealExecutionGraph(ctxA, dealId)).closingConditions.find((row) => row.id === validCondition.row.id);
    expect(waived).toMatchObject({ state: "waived", version: 2 });
    expect(waived?.waiverAuthorityDecisionId).toBeTruthy();
    expect(waived?.waiverDecisionReceiptId).toBeTruthy();
  }, 60_000);

  it("revalidates approved close against stale reality, then closes an eligible Deal once with a finalized receipt and evidence-backed success", async () => {
    const orchestrator = new FinnorOrchestrator();
    const staleDeal = await createActiveDeal("PE4 stale close journey");
    const staleDealId = String(staleDeal.row.id);
    const staleStream = await createWorkstream(ctxA, { dealId: staleDealId, kind: "closing", name: "Stale Closing", owner: { partyType: "employee", partyId: actor } });
    const staleWork = await anchoredWork(staleDealId, "Close only if reality remains eligible.");
    const staleEligibility = await evaluateDealCloseEligibility(ctxA, staleDealId);
    expect(staleEligibility.eligible).toBe(true);
    const staleAction = await orchestrator.draftKnownAction("declare_deal_closed", {
      dealId: staleDealId,
      expectedVersion: staleEligibility.dealVersion,
      expectedGraphVersion: staleEligibility.graphVersion,
    }, tenantA, { workId: staleWork.workId, initiatedBy: actor });
    expect(staleAction.result.output.pendingConfirmation).toBe(true);
    expect(await approve(orchestrator, staleAction.action.id)).toMatchObject({ status: "failure", output: { requiresTypedConfirmation: true } });
    expect(await approve(orchestrator, staleAction.action.id, true)).toMatchObject({ status: "success", output: { durable: true, queued: true } });
    await createClosingCondition(ctxA, {
      dealId: staleDealId,
      workstreamId: String(staleStream.row.id),
      conditionText: "Newly required regulatory consent.",
      category: "regulatory",
      evidenceRequired: false,
      owner: { partyType: "employee", partyId: actor },
    });
    expect((await driveDurableAction(tenantA, staleAction.action.id)).status).toBe("failure");
    expect((await getDeal(ctxA, staleDealId)).status).toBe("active");
    expect((await listDealHistory(ctxA, staleDealId)).filter((event) => event.eventType === "pe_deal_closed")).toHaveLength(0);

    const validDeal = await createActiveDeal("PE4 valid close journey");
    const validDealId = String(validDeal.row.id);
    const validWork = await anchoredWork(validDealId, "Close Atlas through the governed runtime.");
    const eligibility = await evaluateDealCloseEligibility(ctxA, validDealId);
    expect(eligibility.eligible).toBe(true);
    const validAction = await orchestrator.draftKnownAction("declare_deal_closed", {
      dealId: validDealId,
      expectedVersion: eligibility.dealVersion,
      expectedGraphVersion: eligibility.graphVersion,
    }, tenantA, { workId: validWork.workId, initiatedBy: actor });
    expect(await approve(orchestrator, validAction.action.id, true)).toMatchObject({ status: "success", output: { durable: true, queued: true } });
    expect(await driveDurableAction(tenantA, validAction.action.id)).toMatchObject({ status: "success", output: { canonicalMutationOwner: "declareDealClosed" } });

    const graph = await loadDealExecutionGraph(ctxA, validDealId);
    expect(graph.deal).toMatchObject({ status: "closed", actualCloseAt: expect.any(Date) });
    expect(graph.businessEvents.filter((event) => event.eventType === "pe_deal_closed")).toHaveLength(1);
    const [action, effect, receipt] = await withTenant(tenantA, async (db) => {
      const [actionRow] = await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantA), eq(domainActions.id, validAction.action.id))).limit(1);
      const [effectRow] = await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantA), eq(businessEffects.domainActionId, validAction.action.id))).limit(1);
      const [receiptRow] = await db.select().from(decisionReceipts).where(and(eq(decisionReceipts.tenantId, tenantA), eq(decisionReceipts.domainActionId, validAction.action.id))).orderBy(desc(decisionReceipts.createdAt)).limit(1);
      return [actionRow, effectRow, receiptRow] as const;
    });
    expect(action).toMatchObject({ status: "completed" });
    expect(effect).toMatchObject({ status: "verified" });
    expect(receipt).toMatchObject({ finalizedAt: expect.any(Date), failure: null });

    const inspection = await inspectCurrentObjectiveSuccessState(tenantA, validWork.workId, randomUUID());
    const verified = await evaluateObjectiveSuccessCondition({
      tenantId: tenantA,
      workId: validWork.workId,
      loopId: randomUUID(),
      stepNumber: 1,
      condition: privateEquityObjectiveSuccessCondition({ objective: "Close Atlas.", dealId: validDealId }),
      inspection,
      evidence: [{ kind: "business_effect", businessEffectId: effect!.id }],
    });
    expect(verified.state).toBe("verified");
    expect((await driveDurableAction(tenantA, validAction.action.id)).status).toBe("success");
    expect((await listDealHistory(ctxA, validDealId)).filter((event) => event.eventType === "pe_deal_closed")).toHaveLength(1);
  }, 60_000);

  it("blocks PE external egress unless an explicit sandbox/emulator binding exists while leaving Water active", async () => {
    const externalEffect = {
      operation: { name: "send_message", class: "external_side_effect", external: true },
      bindings: [],
      preconditions: [],
    } as unknown as BusinessEffectSet;
    await expect(verifyBusinessEffectPreconditions(tenantB, externalEffect)).rejects.toThrow(/sandbox or emulator.*unbound egress is blocked/i);
    await expect(verifyBusinessEffectPreconditions(tenantA, externalEffect)).resolves.toBeUndefined();
    await expect(verifyBusinessEffectPreconditions(waterTenant, externalEffect)).resolves.toBeUndefined();
  });
});
