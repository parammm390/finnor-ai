import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { DomainAction, DomainPolicy, UniversalActionType } from "@finnor/shared-types";
import {
  acknowledgementRequests,
  closePool,
  communicationDeliveries,
  delegationEvents,
  delegations,
  documentShares,
  domainActions,
  externalOperations,
  internalEventEvents,
  internalEvents,
  tasks,
  tenantIntegrations,
  tenantSettings,
  universalActionEvents,
  withTenant,
  workEvents,
  works,
} from "@finnor/db";
import {
  reconcileExternalOperation,
  ScopedToolRegistry,
  ToolRegistry,
} from "@finnor/tools";
import { assembleOperatingContext, createDefaultPluginRegistry, GatedExecutor, groundEntitiesWithDb } from "@finnor/orchestration";
import { resolveParty } from "@finnor/read-models";
import { migrate } from "../../packages/db/migrate";
import universalActionsPlugin, {
  acceptDelegation,
  acknowledgeDelegation,
  completeDelegation,
} from "../../packages/domain-plugins/universal-actions/index";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await canConnect(SUPER_URL);

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const OWNER = randomUUID();
const MARIO_A = randomUUID();
const MARIO_B = randomUUID();
const SARAH = randomUUID();
const SUSPENDED = randomUUID();
const SUSPENDED_OWNER = randomUUID();
const ROGUE = randomUUID();
const DENY_ASSIGN_TASK_ROLE = randomUUID();
const TENANT_B_EMPLOYEE = randomUUID();
const PHOENIX_TEAM = randomUUID();
const WORK_A = randomUUID();
const WORK_B = randomUUID();
const DOCUMENT_A = randomUUID();
const HOUSEHOLD_A = randomUUID();
const EXTERNAL_CONTACT_A = randomUUID();
const EMAIL_IDENTITY = randomUUID();
const SMS_IDENTITY = randomUUID();
const VOICE_IDENTITY = randomUUID();
const UNAUTHORIZED_IDENTITY = randomUUID();

const policy = (actionType: string, requiresConfirmation = true): DomainPolicy => ({
  id: randomUUID(),
  tenantId: TENANT_A,
  actionType,
  policy: {},
  requiresConfirmation,
  confirmationTemplate: null,
  version: 1,
});

async function createAction(
  actionType: UniversalActionType,
  payload: Record<string, unknown>,
  tenantId: string = TENANT_A,
  actorId: string = OWNER,
  workId?: string,
) {
  return withTenant(tenantId, async (db) => {
    const [row] = await db.insert(domainActions).values({
      tenantId,
      actionType,
      payload,
      status: "executing",
      initiatedBy: actorId,
      workId: workId ?? null,
    }).returning();
    return row!;
  });
}

async function executeAction(params: {
  actionType: UniversalActionType;
  payload: Record<string, unknown>;
  tools?: ToolRegistry;
  tenantId?: string;
  actorId?: string;
  communicationIdentityId?: string;
  workId?: string;
}) {
  const tenantId = params.tenantId ?? TENANT_A;
  const actorId = params.actorId ?? OWNER;
  const action = await createAction(params.actionType, params.payload, tenantId, actorId, params.workId);
  const validation = universalActionsPlugin.validate(params.actionType, params.payload, policy(params.actionType));
  if (!validation.valid) throw new Error(`invalid test fixture: ${validation.errors.join("; ")}`);
  const draft = await universalActionsPlugin.draft(params.actionType, params.payload, policy(params.actionType));
  const scoped = new ScopedToolRegistry(params.tools ?? new ToolRegistry(), {
    tenantId,
    domainActionId: action.id,
    actorId,
    purpose: params.actionType,
    ...(params.communicationIdentityId ? { communicationIdentityId: params.communicationIdentityId } : {}),
  });
  return { action, result: await universalActionsPlugin.execute(draft, scoped) };
}

function communicationTools(calls: Array<{ tool: string; input: Record<string, unknown> }>): ToolRegistry {
  const tools = new ToolRegistry();
  for (const name of ["send_email", "send_sms_to_number", "vapi_place_call"] as const) {
    tools.register({
      name,
      description: "deterministic acceptance provider",
      integration: "acceptance-provider",
      inputSchema: z.object({}).passthrough(),
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 1_000 },
      async run(input, runtime) {
        calls.push({ tool: name, input });
        return {
          messageId: `provider-${calls.length}`,
          ...(name === "vapi_place_call" ? { callId: `call-${calls.length}` } : {}),
          ...(runtime?.communicationIdentityId ? { communicationIdentityId: runtime.communicationIdentityId } : {}),
        };
      },
    });
  }
  return tools;
}

describe.skipIf(!available)("Phase 2 Universal Action + Delegation Fabric", () => {
  const priorCredentials = {
    GOHIGHLEVEL_API_KEY: process.env.GOHIGHLEVEL_API_KEY,
    VAPI_API_KEY: process.env.VAPI_API_KEY,
    VAPI_PHONE_NUMBER_ID: process.env.VAPI_PHONE_NUMBER_ID,
    VAPI_ASSISTANT_ID: process.env.VAPI_ASSISTANT_ID,
    GMAIL_USER: process.env.GMAIL_USER,
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
    FINNOR_LEGACY_CREDENTIAL_TENANT_IDS: process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS,
  };

  beforeAll(async () => {
    process.env.GOHIGHLEVEL_API_KEY = "pe4-test-ghl-key";
    process.env.VAPI_API_KEY = "pe4-test-vapi-key";
    process.env.VAPI_PHONE_NUMBER_ID = "pe4-test-phone-number";
    process.env.VAPI_ASSISTANT_ID = "pe4-test-assistant";
    process.env.GMAIL_USER = "owner@example.test";
    process.env.GMAIL_APP_PASSWORD = "pe4-test-app-password";
    process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS = TENANT_A;
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO finnor_os.tenants(id,client_key,name)
         VALUES ($1,$2,'P2 Tenant A'),($3,$4,'P2 Tenant B')`,
        [TENANT_A, `p2-a-${TENANT_A.slice(0, 8)}`, TENANT_B, `p2-b-${TENANT_B.slice(0, 8)}`],
      );
      await admin.query(
        `INSERT INTO finnor_os.tenant_settings(tenant_id) VALUES ($1),($2)`,
        [TENANT_A, TENANT_B],
      );
      await admin.query(
        `INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name,phone_number,status)
         VALUES
          ($1,$8,$9,'owner','Owner','+15550000001','active'),
          ($2,$8,$10,'technician','Mario','+15550000002','active'),
          ($3,$8,$11,'technician','Mario','+15550000003','active'),
          ($4,$8,$12,'dispatcher','Sarah','+15550000004','active'),
          ($5,$8,$13,'technician','Suspended Sam','+15550000005','suspended'),
          ($6,$8,$14,'technician','Rogue','+15550000006','active'),
          ($7,$15,$16,'owner','Tenant B Employee','+15550000007','active')`,
        [
          OWNER, MARIO_A, MARIO_B, SARAH, SUSPENDED, ROGUE, TENANT_B_EMPLOYEE, TENANT_A,
          `owner-${TENANT_A}@example.test`, `mario-a-${TENANT_A}@example.test`, `mario-b-${TENANT_A}@example.test`,
          `sarah-${TENANT_A}@example.test`, `suspended-${TENANT_A}@example.test`, `rogue-${TENANT_A}@example.test`,
          TENANT_B, `employee-${TENANT_B}@example.test`,
        ],
      );
      await admin.query(
        `INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name,phone_number,status)
         VALUES ($1,$2,$3,'owner','Suspended Owner','+15550000008','suspended')`,
        [SUSPENDED_OWNER, TENANT_A, `suspended-owner-${TENANT_A}@example.test`],
      );
      await admin.query(
        `INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind)
         VALUES ($1,$2,'phoenix-install','Phoenix Install Team','team')`,
        [PHOENIX_TEAM, TENANT_A],
      );
      await admin.query(
        `INSERT INTO finnor_os.org_unit_memberships(tenant_id,org_unit_id,employee_id,membership_role,active)
         VALUES ($1,$2,$3,'installer',true),($1,$2,$4,'installer',true),($1,$2,$5,'installer',true)`,
        [TENANT_A, PHOENIX_TEAM, MARIO_A, SARAH, SUSPENDED],
      );
      await admin.query(
        `INSERT INTO finnor_os.works(id,tenant_id,initial_channel,initial_instruction,created_by,current_owner_id,assigned_to)
         VALUES ($1,$3,'console','Coordinate Peterson installation',$4,$4,$4),
                ($2,$5,'console','Tenant B work',$6,$6,$6)`,
        [WORK_A, WORK_B, TENANT_A, OWNER, TENANT_B, TENANT_B_EMPLOYEE],
      );
      await admin.query(
        `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,storage_ref)
         VALUES ($1,$2,'proposal_pdf','Peterson Proposal','governed://peterson-proposal')`,
        [DOCUMENT_A, TENANT_A],
      );
      await admin.query(
        `INSERT INTO finnor_os.households(id,tenant_id,address,contact_info)
         VALUES ($1,$2,'Governed address','{"name":"Peterson"}'::jsonb)`,
        [HOUSEHOLD_A, TENANT_A],
      );
      await admin.query(
        `INSERT INTO finnor_os.external_contacts(id,tenant_id,contact_key,name,business_email)
         VALUES ($1,$2,'external-contact-a','External Contact','external-contact@example.test')`,
        [EXTERNAL_CONTACT_A, TENANT_A],
      );
      await admin.query(
        `INSERT INTO finnor_os.communication_identities
          (id,tenant_id,identity_key,provider,channel,address,status,capabilities,credential_provider,credential_ref)
         VALUES
          ($1,$5,'owner-email','gmail','email','owner@example.test','active','["send"]','legacy-env','legacy-env:gmail'),
          ($2,$5,'owner-sms','ghl','sms','+15551110000','active','["send"]','legacy-env','legacy-env:ghl'),
          ($3,$5,'owner-voice','vapi','voice','+15551110002','active','["call"]','legacy-env','legacy-env:vapi'),
          ($4,$5,'sarah-sms','ghl','sms','+15551110001','active','["send"]','legacy-env','legacy-env:ghl')`,
        [EMAIL_IDENTITY, SMS_IDENTITY, VOICE_IDENTITY, UNAUTHORIZED_IDENTITY, TENANT_A],
      );
      await admin.query(
        `INSERT INTO finnor_os.communication_identity_bindings
          (tenant_id,communication_identity_id,principal_type,principal_id,purpose,priority,status)
         VALUES
          ($1,$2,'employee',$3,'default',100,'active'),
          ($1,$4,'employee',$3,'default',100,'active'),
          ($1,$5,'employee',$3,'default',100,'active'),
          ($1,$6,'employee',$7,'default',100,'active')`,
        [TENANT_A, EMAIL_IDENTITY, OWNER, SMS_IDENTITY, VOICE_IDENTITY, UNAUTHORIZED_IDENTITY, SARAH],
      );
      await admin.query(
        `INSERT INTO finnor_os.tenant_integrations(tenant_id,capability,binding,mode)
         VALUES ($1,'crm','ghl','real'),($1,'communications','vapi','real')`,
        [TENANT_A],
      );
      // Legacy tenants intentionally bootstrap broad role grants. Give the rogue
      // employee an explicit, narrower deny so this journey exercises the real
      // deny-precedence boundary instead of assuming the absence of a grant.
      await admin.query(
        `INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
         VALUES ($1,$2,'deny-task-assignment','Task assignment denied')`,
        [DENY_ASSIGN_TASK_ROLE, TENANT_A],
      );
      await admin.query(
        `INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)
         VALUES ($1,$2,$3,'{"kind":"tenant"}'::jsonb)`,
        [TENANT_A, ROGUE, DENY_ASSIGN_TASK_ROLE],
      );
      await admin.query(
        `INSERT INTO finnor_os.role_authority_grants
          (tenant_id,role_id,capability,resource_type,effect,max_risk)
         VALUES ($1,$2,'action:assign_task','*','deny','high')`,
        [TENANT_A, DENY_ASSIGN_TASK_ROLE],
      );
    } finally {
      await admin.end();
    }
    process.env.DATABASE_URL = APP_URL;
    await closePool();
  }, 30_000);

  afterAll(async () => {
    await closePool();
    process.env.DATABASE_URL = SUPER_URL;
    for (const [name, value] of Object.entries(priorCredentials)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("resolves ambiguity before execution and sends one canonical email with a durable receipt", async () => {
    const before = await withTenant(TENANT_A, (db) => db.select().from(communicationDeliveries));
    const ambiguous = await resolveParty(TENANT_A, { query: "Mario" }, { requesterEmployeeId: OWNER });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.candidates).toHaveLength(2);
    expect(await withTenant(TENANT_A, (db) => db.select().from(communicationDeliveries))).toHaveLength(before.length);

    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const payload = {
      recipient: { partyType: "employee", partyId: MARIO_A },
      channel: "email",
      subject: "Peterson installation update",
      body: "The Peterson install moved to 2 PM.",
      purpose: "installation_update",
      communicationIdentityRef: { communicationIdentityId: EMAIL_IDENTITY },
      workRef: { workId: WORK_A },
    };
    const { action, result } = await executeAction({
      actionType: "send_message",
      payload,
      tools: communicationTools(calls),
      communicationIdentityId: EMAIL_IDENTITY,
      workId: WORK_A,
    });
    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "send_email", input: { to: `mario-a-${TENANT_A}@example.test` } });
    const deliveries = await withTenant(TENANT_A, (db) => db.select().from(communicationDeliveries).where(eq(communicationDeliveries.domainActionId, action.id)));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ recipientType: "employee", recipientId: MARIO_A, channel: "email", status: "sent", communicationIdentityId: EMAIL_IDENTITY });
    const events = await withTenant(TENANT_A, (db) => db.select().from(universalActionEvents).where(eq(universalActionEvents.domainActionId, action.id)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: OWNER, communicationIdentityId: EMAIL_IDENTITY, route: expect.stringMatching(/native|api/) });
  });

  it("places one governed call through the explicitly permitted voice identity", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const { action, result } = await executeAction({
      actionType: "place_call",
      payload: {
        recipient: { partyType: "employee", partyId: MARIO_A },
        objective: "Confirm the Peterson installation window.",
        communicationIdentityRef: { communicationIdentityId: VOICE_IDENTITY },
        workRef: { workId: WORK_A },
      },
      tools: communicationTools(calls),
      communicationIdentityId: VOICE_IDENTITY,
      workId: WORK_A,
    });
    expect(result.status).toBe("success");
    expect(calls).toEqual([expect.objectContaining({ tool: "vapi_place_call", input: expect.objectContaining({ phoneNumber: "+15550000002" }) })]);
    const [delivery] = await withTenant(TENANT_A, (db) => db.select().from(communicationDeliveries).where(eq(communicationDeliveries.domainActionId, action.id)));
    expect(delivery).toMatchObject({ channel: "voice", status: "sent", communicationIdentityId: VOICE_IDENTITY });
  });

  it("expands an active team deterministically, deduplicates recipients, and tracks each email delivery", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const { result } = await executeAction({
      actionType: "notify_group",
      payload: {
        teamRef: { partyType: "team", partyId: PHOENIX_TEAM },
        channel: "email",
        subject: "Phoenix installation update",
        body: "Review the Friday schedule.",
        communicationIdentityRef: { communicationIdentityId: EMAIL_IDENTITY },
      },
      tools: communicationTools(calls),
      communicationIdentityId: EMAIL_IDENTITY,
    });
    expect(result.status).toBe("success");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.input.to))).toEqual(new Set([
      `mario-a-${TENANT_A}@example.test`,
      `sarah-${TENANT_A}@example.test`,
    ]));
    expect(result.output).toMatchObject({ counts: { sent: 2 } });
  });

  it("keeps delivery separate from acknowledgement, acceptance, and completion and makes delegation retry-idempotent", async () => {
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
    const completion = new Date(Date.now() + 4 * 3_600_000).toISOString();
    const payload = {
      workRef: { workId: WORK_A },
      targetRef: { partyType: "employee", partyId: MARIO_A },
      objective: "Handle the Peterson installation Thursday.",
      acknowledgementDeadline: deadline,
      completionDeadline: completion,
      escalationTargetRef: { partyType: "employee", partyId: SARAH },
      evidenceRefs: [{ entityType: "document", entityId: DOCUMENT_A }],
    };
    const action = await createAction("delegate_objective", payload, TENANT_A, OWNER, WORK_A);
    const draft = await universalActionsPlugin.draft("delegate_objective", payload, policy("delegate_objective"));
    const run = () => universalActionsPlugin.execute(draft, new ScopedToolRegistry(new ToolRegistry(), {
      tenantId: TENANT_A,
      domainActionId: action.id,
      actorId: OWNER,
      purpose: "delegate_objective",
    }));
    const first = await run();
    const second = await run();
    expect(first.status).toBe("success");
    expect(second.status).toBe("success");

    const [delegation] = await withTenant(TENANT_A, (db) => db.select().from(delegations).where(eq(delegations.domainActionId, action.id)));
    expect(delegation).toMatchObject({
      status: "delivered",
      targetId: MARIO_A,
      escalationTargetId: SARAH,
      acknowledgedAt: null,
      acceptedAt: null,
      completedAt: null,
    });
    expect(delegation!.acknowledgementDeadline?.toISOString()).toBe(deadline);
    expect(delegation!.escalationRule).toMatchObject({ onAcknowledgementDeadline: "overdue" });
    expect(await withTenant(TENANT_A, (db) => db.select().from(delegations).where(eq(delegations.domainActionId, action.id)))).toHaveLength(1);
    expect(await withTenant(TENANT_A, (db) => db.select().from(tasks).where(eq(tasks.sourceDomainActionId, action.id)))).toHaveLength(1);
    expect(await withTenant(TENANT_A, (db) => db.select().from(communicationDeliveries).where(eq(communicationDeliveries.domainActionId, action.id)))).toHaveLength(1);

    const [ack] = await withTenant(TENANT_A, (db) => db.select().from(acknowledgementRequests).where(eq(acknowledgementRequests.delegationId, delegation!.id)));
    expect(ack).toMatchObject({ status: "delivered", acknowledgedAt: null });
    await expect(acknowledgeDelegation({ tenantId: TENANT_A, delegationId: delegation!.id, acknowledgementRequestId: ack!.id, actorId: SARAH }))
      .rejects.toThrow(/Only the delegated employee/);
    await acknowledgeDelegation({ tenantId: TENANT_A, delegationId: delegation!.id, acknowledgementRequestId: ack!.id, actorId: MARIO_A });
    expect((await withTenant(TENANT_A, (db) => db.select().from(delegations).where(eq(delegations.id, delegation!.id))))[0]?.status).toBe("acknowledged");
    await acceptDelegation({ tenantId: TENANT_A, delegationId: delegation!.id, actorId: MARIO_A });
    expect((await withTenant(TENANT_A, (db) => db.select().from(delegations).where(eq(delegations.id, delegation!.id))))[0]?.status).toBe("accepted");
    await completeDelegation({ tenantId: TENANT_A, delegationId: delegation!.id, actorId: MARIO_A, evidence: { outcome: "installed" } });
    expect((await withTenant(TENANT_A, (db) => db.select().from(delegations).where(eq(delegations.id, delegation!.id))))[0]?.status).toBe("completed");

    const invalidCancel = await executeAction({
      actionType: "cancel_delegation",
      payload: { delegationRef: { delegationId: delegation!.id }, reason: "Too late" },
    });
    expect(invalidCancel.result.status).toBe("failure");
    expect(invalidCancel.result.error).toMatch(/Invalid delegation transition completed -> cancelled/);
    const lifecycle = await withTenant(TENANT_A, (db) => db.select().from(delegationEvents).where(eq(delegationEvents.delegationId, delegation!.id)));
    expect(lifecycle.map((event) => event.toStatus)).toEqual(["created", "sent", "delivered", "acknowledged", "accepted", "completed"]);
  });

  it("creates acknowledgement delivery evidence without claiming acknowledgement", async () => {
    const { action, result } = await executeAction({
      actionType: "request_acknowledgement",
      payload: {
        recipient: { partyType: "employee", partyId: SARAH },
        request: "Acknowledge the Peterson handoff.",
        workRef: { workId: WORK_A },
      },
    });
    expect(result).toMatchObject({ status: "success", expected: { delivered: true, acknowledged: false } });
    const [request] = await withTenant(TENANT_A, (db) => db.select().from(acknowledgementRequests).where(eq(acknowledgementRequests.domainActionId, action.id)));
    expect(request).toMatchObject({ status: "delivered", acknowledgedAt: null });
    expect(request?.deliveryId).toBeTruthy();
  });

  it("reuses the canonical task and Work substrates for create, assign, update, and handoff", async () => {
    const created = await executeAction({
      actionType: "create_task",
      payload: {
        subjectRef: { entityType: "work", entityId: WORK_A },
        workRef: { workId: WORK_A },
        title: "Confirm Peterson arrival window",
        assigneeRef: { partyType: "employee", partyId: MARIO_A },
        priority: "high",
      },
      workId: WORK_A,
    });
    expect(created.result.status).toBe("success");
    const taskId = String((created.result.output.taskRef as { taskId: string }).taskId);
    const countBefore = (await withTenant(TENANT_A, (db) => db.select().from(tasks))).length;
    const assigned = await executeAction({
      actionType: "assign_task",
      payload: { taskRef: { taskId }, assigneeRef: { partyType: "team", partyId: PHOENIX_TEAM } },
    });
    expect(assigned.result.status).toBe("success");
    const updated = await executeAction({
      actionType: "update_task",
      payload: { taskRef: { taskId }, title: "Confirm Peterson 2 PM arrival", priority: "normal" },
    });
    expect(updated.result.status).toBe("success");
    const [task] = await withTenant(TENANT_A, (db) => db.select().from(tasks).where(eq(tasks.id, taskId)));
    expect(task).toMatchObject({ assignedPartyType: "team", assignedPartyId: PHOENIX_TEAM, title: "Confirm Peterson 2 PM arrival" });
    expect((await withTenant(TENANT_A, (db) => db.select().from(tasks))).length).toBe(countBefore);

    const workCount = (await withTenant(TENANT_A, (db) => db.select().from(works).where(eq(works.id, WORK_A)))).length;
    const handedOff = await executeAction({
      actionType: "handoff_work",
      payload: { workRef: { workId: WORK_A }, targetEmployeeRef: { partyType: "employee", partyId: SARAH }, note: "Sarah owns Friday coordination." },
      workId: WORK_A,
    });
    expect(handedOff.result.status).toBe("success");
    const [work] = await withTenant(TENANT_A, (db) => db.select().from(works).where(eq(works.id, WORK_A)));
    expect(work).toMatchObject({ currentOwnerId: SARAH, assignedTo: SARAH });
    expect((await withTenant(TENANT_A, (db) => db.select().from(works).where(eq(works.id, WORK_A)))).length).toBe(workCount);
    const handoff = (await withTenant(TENANT_A, (db) => db.select().from(workEvents).where(eq(workEvents.workId, WORK_A))))
      .find((event) => event.eventType === "employee_handoff");
    expect(handoff?.payload).toMatchObject({ fromEmployeeId: OWNER, toEmployeeId: SARAH, actorId: OWNER });
  });

  it("persists escalation and cancellation without deleting the original delegation history", async () => {
    const delegated = await executeAction({
      actionType: "delegate_objective",
      payload: {
        workRef: { workId: WORK_A },
        targetRef: { partyType: "employee", partyId: MARIO_B },
        objective: "Confirm material delivery.",
        escalationTargetRef: { partyType: "employee", partyId: SARAH },
        evidenceRefs: [],
      },
      workId: WORK_A,
    });
    const delegationId = String((delegated.result.output.delegationRef as { delegationId: string }).delegationId);
    const escalated = await executeAction({
      actionType: "escalate_work",
      payload: { delegationRef: { delegationId }, targetRef: { partyType: "employee", partyId: SARAH }, reason: "Acknowledgement deadline missed.", evidenceRefs: [] },
    });
    expect(escalated.result.status).toBe("success");
    const cancelled = await executeAction({
      actionType: "cancel_delegation",
      payload: { delegationRef: { delegationId }, reason: "Material already delivered." },
    });
    expect(cancelled.result.status).toBe("success");
    const [row] = await withTenant(TENANT_A, (db) => db.select().from(delegations).where(eq(delegations.id, delegationId)));
    expect(row).toMatchObject({ status: "cancelled", targetId: MARIO_B, escalationTargetId: SARAH });
    expect(row?.cancelledAt).toBeInstanceOf(Date);
    const events = await withTenant(TENANT_A, (db) => db.select().from(delegationEvents).where(eq(delegationEvents.delegationId, delegationId)));
    expect(events.map((event) => event.toStatus)).toEqual(["created", "sent", "delivered", "escalated", "cancelled"]);
  });

  it("schedules and reschedules the same internal event without fabricating an external calendar result", async () => {
    const scheduled = await executeAction({
      actionType: "schedule_internal_event",
      payload: {
        title: "Peterson installation review",
        purpose: "Coordinate Friday work",
        startsAt: "2026-09-04T15:00:00.000Z",
        endsAt: "2026-09-04T15:30:00.000Z",
        participants: [
          { partyType: "employee", partyId: SARAH },
          { partyType: "team", partyId: PHOENIX_TEAM },
        ],
        workRef: { workId: WORK_A },
      },
      workId: WORK_A,
    });
    expect(scheduled.result.status).toBe("success");
    const eventId = String((scheduled.result.output.internalEventRef as { internalEventId: string }).internalEventId);
    expect(scheduled.result.output.route).toMatchObject({ route: "native", executable: true });
    const moved = await executeAction({
      actionType: "reschedule_internal_event",
      payload: {
        internalEventRef: { internalEventId: eventId },
        startsAt: "2026-09-07T15:00:00.000Z",
        endsAt: "2026-09-07T15:30:00.000Z",
        reason: "Move to Monday.",
      },
    });
    expect(moved.result.status).toBe("success");
    const [event] = await withTenant(TENANT_A, (db) => db.select().from(internalEvents).where(eq(internalEvents.id, eventId)));
    expect(event).toMatchObject({ id: eventId, status: "rescheduled", revision: 2 });
    expect(event?.startsAt.toISOString()).toBe("2026-09-07T15:00:00.000Z");
    expect(await withTenant(TENANT_A, (db) => db.select().from(internalEvents).where(eq(internalEvents.id, eventId)))).toHaveLength(1);
    expect(await withTenant(TENANT_A, (db) => db.select().from(internalEventEvents).where(eq(internalEventEvents.internalEventId, eventId)))).toHaveLength(2);

    const assembled = await assembleOperatingContext(
      { tenantId: TENANT_A, userId: SARAH, employeeId: SARAH, role: "owner", authorityRoles: ["owner"] },
      { instruction: "Coordinate the diligence review", workId: WORK_A, includeMemory: false, includeCanonicalBusinessState: false },
    );
    expect(assembled.context.universalActions?.capabilities).toMatchObject({ browserExecutable: false, computerExecutable: false });
    expect(assembled.context.universalActions?.upcomingInternalEvents).toContainEqual(expect.objectContaining({
      internalEventRef: { internalEventId: eventId },
      participantCount: 2,
    }));
    expect(JSON.stringify(assembled.context.universalActions)).not.toMatch(/credential|storageRef|phoneNumber|@/i);
  });

  it("shares a canonical document internally and returns an honest manual result for unavailable external sharing", async () => {
    const internal = await executeAction({
      actionType: "share_document",
      payload: { documentRef: { documentId: DOCUMENT_A }, recipient: { partyType: "employee", partyId: SARAH }, accessLevel: "view" },
    });
    expect(internal.result.status).toBe("success");
    expect(internal.result.output).not.toHaveProperty("storageRef");
    const [share] = await withTenant(TENANT_A, (db) => db.select().from(documentShares).where(eq(documentShares.domainActionId, internal.action.id)));
    expect(share).toMatchObject({ documentId: DOCUMENT_A, recipientId: SARAH, route: "native", status: "shared" });

    const external = await executeAction({
      actionType: "share_document",
      payload: { documentRef: { documentId: DOCUMENT_A }, recipient: { partyType: "external_contact", partyId: EXTERNAL_CONTACT_A }, accessLevel: "view" },
    });
    expect(external.result.status).toBe("integration_unavailable");
    expect(external.result.output.route).toMatchObject({ route: "manual", executable: false, reasonCode: "external_sharing_disallowed" });
  });

  it("denies sender spoofing and unavailable providers without calling a tool", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const spoofed = await executeAction({
      actionType: "send_message",
      actorId: OWNER,
      communicationIdentityId: UNAUTHORIZED_IDENTITY,
      tools: communicationTools(calls),
      payload: {
        recipient: { partyType: "employee", partyId: MARIO_A },
        channel: "sms",
        body: "Spoof attempt",
        communicationIdentityRef: { communicationIdentityId: UNAUTHORIZED_IDENTITY },
      },
    });
    expect(spoofed.result.status).toBe("failure");
    expect(spoofed.result.error).toMatch(/not available to this actor/);
    expect(calls).toHaveLength(0);

    await withTenant(TENANT_A, (db) => db.update(tenantIntegrations).set({ binding: "native", mode: "emulator" }).where(and(
      eq(tenantIntegrations.tenantId, TENANT_A),
      eq(tenantIntegrations.capability, "crm"),
    )));
    const incompatible = await executeAction({
      actionType: "send_message",
      actorId: OWNER,
      communicationIdentityId: SMS_IDENTITY,
      tools: communicationTools(calls),
      payload: {
        recipient: { partyType: "employee", partyId: MARIO_A },
        channel: "sms",
        body: "Do not emulate an explicitly requested GHL sender.",
        communicationIdentityRef: { communicationIdentityId: SMS_IDENTITY },
      },
    });
    expect(incompatible.result.status).toBe("integration_unavailable");
    expect(incompatible.result.output.route).toMatchObject({ route: "manual", executable: false });
    const [incompatibleDelivery] = await withTenant(TENANT_A, (db) => db.select().from(communicationDeliveries).where(eq(communicationDeliveries.domainActionId, incompatible.action.id)));
    expect(incompatibleDelivery?.communicationIdentityId).toBeNull();
    expect(calls).toHaveLength(0);
    await withTenant(TENANT_A, (db) => db.update(tenantIntegrations).set({ binding: "ghl", mode: "real" }).where(and(
      eq(tenantIntegrations.tenantId, TENANT_A),
      eq(tenantIntegrations.capability, "crm"),
    )));

    const unavailable = await executeAction({
      actionType: "send_message",
      actorId: ROGUE,
      tools: communicationTools(calls),
      payload: {
        recipient: { partyType: "employee", partyId: MARIO_A },
        channel: "email",
        subject: "No sender configured",
        body: "This must not fabricate success.",
      },
    });
    expect(unavailable.result.status).toBe("integration_unavailable");
    expect(unavailable.result.output.route).toMatchObject({ route: "manual", executable: false });
    expect(calls).toHaveLength(0);
  });

  it("fails closed for forged cross-tenant PartyRef, TaskRef, DelegationRef, and WorkRef", async () => {
    const forgedParty = await executeAction({
      actionType: "send_message",
      tenantId: TENANT_B,
      actorId: TENANT_B_EMPLOYEE,
      payload: { recipient: { partyType: "employee", partyId: MARIO_A }, channel: "internal", body: "forged" },
    });
    expect(forgedParty.result.status).toBe("failure");

    const [taskA] = await withTenant(TENANT_A, (db) => db.select().from(tasks).limit(1));
    const forgedTask = await executeAction({
      actionType: "assign_task",
      tenantId: TENANT_B,
      actorId: TENANT_B_EMPLOYEE,
      payload: { taskRef: { taskId: taskA!.id }, assigneeRef: { partyType: "employee", partyId: TENANT_B_EMPLOYEE } },
    });
    expect(forgedTask.result.status).toBe("failure");

    const [delegationA] = await withTenant(TENANT_A, (db) => db.select().from(delegations).limit(1));
    const forgedDelegation = await executeAction({
      actionType: "cancel_delegation",
      tenantId: TENANT_B,
      actorId: TENANT_B_EMPLOYEE,
      payload: { delegationRef: { delegationId: delegationA!.id }, reason: "forged" },
    });
    expect(forgedDelegation.result.status).toBe("failure");

    const forgedEvidence = await executeAction({
      actionType: "delegate_objective",
      tenantId: TENANT_B,
      actorId: TENANT_B_EMPLOYEE,
      workId: WORK_B,
      payload: {
        workRef: { workId: WORK_B },
        targetRef: { partyType: "employee", partyId: TENANT_B_EMPLOYEE },
        objective: "Do not persist a foreign evidence reference.",
        evidenceRefs: [{ entityType: "document", entityId: DOCUMENT_A }],
      },
    });
    expect(forgedEvidence.result.status).toBe("failure");

    const actionB = await createAction("create_task", { subjectRef: { entityType: "work", entityId: WORK_B }, title: "forged work link", priority: "normal" }, TENANT_B, TENANT_B_EMPLOYEE, WORK_B);
    await expect(withTenant(TENANT_B, (db) => db.insert(tasks).values({
      tenantId: TENANT_B,
      subjectType: "work",
      subjectId: WORK_B,
      title: "forged WorkRef",
      workId: WORK_A,
      sourceDomainActionId: actionB.id,
    }))).rejects.toThrow();

    expect(await withTenant(TENANT_B, (db) => db.select().from(communicationDeliveries))).toHaveLength(0);
    expect(await withTenant(TENANT_B, (db) => db.select().from(delegations))).toHaveLength(0);
  });

  it("grounds nested universal references against the authenticated tenant", async () => {
    const [taskA] = await withTenant(TENANT_A, (db) => db.select().from(tasks).limit(1));
    const grounded = await withTenant(TENANT_A, (db) => groundEntitiesWithDb(db, TENANT_A, {
      recipient: { partyType: "employee", partyId: MARIO_A },
      workRef: { workId: WORK_A },
      taskRef: { taskId: taskA!.id },
      evidenceRefs: [{ entityType: "document", entityId: DOCUMENT_A }],
      forgedRecipient: { partyType: "employee", partyId: TENANT_B_EMPLOYEE },
    }));
    expect(grounded).toEqual(expect.arrayContaining([
      { field: "recipient.partyId", status: "verified" },
      { field: "workRef.workId", status: "verified" },
      { field: "taskRef.taskId", status: "verified" },
      { field: "evidenceRefs[0].entityId", status: "verified" },
      { field: "forgedRecipient.partyId", status: "not_found" },
    ]));
  });

  it("denies a suspended owner task assignment before mutation or provider effect", async () => {
    const [targetTask] = await withTenant(TENANT_A, (db) => db.select().from(tasks).limit(1));
    const [row] = await withTenant(TENANT_A, (db) => db.insert(domainActions).values({
      tenantId: TENANT_A,
      actionType: "assign_task",
      payload: { taskRef: { taskId: targetTask!.id }, assigneeRef: { partyType: "employee", partyId: MARIO_A } },
      status: "draft",
      initiatedBy: SUSPENDED_OWNER,
    }).returning());
    const action = { ...row!, createdAt: row!.createdAt.toISOString(), payload: row!.payload as Record<string, unknown> } as DomainAction;
    const before = (await withTenant(TENANT_A, (db) => db.select().from(tasks).where(eq(tasks.id, targetTask!.id))))[0];
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const result = await new GatedExecutor(createDefaultPluginRegistry(), communicationTools(calls))
      .execute(action, policy("assign_task"));
    expect(result.status).toBe("failure");
    expect(result.error).toMatch(/Authority denied/);
    const after = (await withTenant(TENANT_A, (db) => db.select().from(tasks).where(eq(tasks.id, targetTask!.id))))[0];
    expect(after?.assignedPartyId).toBe(before?.assignedPartyId);
    expect(calls).toHaveLength(0);
  });

  it("never repeats an unknown provider outcome until explicit reconciliation", async () => {
    let invocations = 0;
    let settle = false;
    const tools = new ToolRegistry();
    tools.register({
      name: "uncertain_send",
      description: "unknown outcome probe",
      integration: "uncertain-provider",
      inputSchema: z.object({}).passthrough(),
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 10 },
      async run() {
        invocations += 1;
        if (!settle) await new Promise((resolve) => setTimeout(resolve, 50));
        return { messageId: "settled-message" };
      },
    });
    const action = await createAction("send_message", { recipient: { partyType: "employee", partyId: MARIO_A }, channel: "sms", body: "unknown outcome" });
    const first = await new ScopedToolRegistry(tools, { tenantId: TENANT_A, domainActionId: action.id, actorId: OWNER })
      .callIdempotent("uncertain_send", { body: "same business message" }, "delivery:peterson-unknown");
    expect(first).toMatchObject({ ok: false, errorKind: "unknown_outcome" });
    const second = await new ScopedToolRegistry(tools, { tenantId: TENANT_A, domainActionId: action.id, actorId: OWNER })
      .callIdempotent("uncertain_send", { body: "same business message" }, "delivery:peterson-unknown");
    expect(second).toMatchObject({ ok: false, errorKind: "unknown_outcome" });
    expect(invocations).toBe(1);
    const [operation] = await withTenant(TENANT_A, (db) => db.select().from(externalOperations).where(eq(externalOperations.domainActionId, action.id)));
    expect(operation?.status).toBe("unknown");
    await reconcileExternalOperation(TENANT_A, action.id, operation!.operationKey, "failed", { providerLookup: "not_found" });
    settle = true;
    const third = await new ScopedToolRegistry(tools, { tenantId: TENANT_A, domainActionId: action.id, actorId: OWNER })
      .callIdempotent("uncertain_send", { body: "same business message" }, "delivery:peterson-unknown");
    expect(third.ok).toBe(true);
    expect(invocations).toBe(2);
  });

  it("enforces append-only lifecycle evidence, RLS, and secret-free tenant configuration", async () => {
    const [event] = await withTenant(TENANT_A, (db) => db.select().from(delegationEvents).limit(1));
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    try {
      await expect(admin.query("UPDATE finnor_os.delegation_events SET event_type='tampered' WHERE id=$1", [event!.id]))
        .rejects.toThrow(/append-only/);
      await expect(admin.query(
        `UPDATE finnor_os.tenant_settings
         SET universal_action_config='{"communication":{"apiKey":"secret"}}'::jsonb
         WHERE tenant_id=$1`,
        [TENANT_A],
      )).rejects.toThrow(/tenant_settings_universal_action_config_no_secrets_check/);
    } finally {
      await admin.end();
    }
    expect(await withTenant(TENANT_B, (db) => db.select().from(universalActionEvents))).toHaveLength(0);
    const [settings] = await withTenant(TENANT_A, (db) => db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, TENANT_A)));
    expect(settings?.universalActionConfig).not.toHaveProperty("apiKey");
  });
});
