import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import {
  appendEmployeeConversationMessage,
  businessEffects,
  closePool,
  communicationIdentities,
  createEmployeeConversationThread,
  domainActions,
  listEmployeeConversationThreads,
  listEmployeePersonalMemories,
  loadEmployeeConversationThread,
  rememberExplicitEmployeeMemory,
  receiveWork,
  updateEmployeeConversationThreadContext,
  withTenant,
} from "@finnor/db";
import {
  FinnorOrchestrator,
  linkEmployeeConversationTurnToWork,
  persistEmployeeAssistantTurn,
  prepareEmployeeConversationTurn,
  resolveCanonicalHumanPrincipal,
} from "@finnor/orchestration";
import { and, eq } from "drizzle-orm";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SUPER_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const available = await dbUp();

describe.skipIf(!available)("Phase 6 authenticated-employee conversation context kernel", () => {
  const priorCredentials = {
    GMAIL_USER: process.env.GMAIL_USER,
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
    FINNOR_LEGACY_CREDENTIAL_TENANT_IDS: process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS,
  };
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const sarah = randomUUID();
  const peer = randomUUID();
  const otherTenantOwner = randomUUID();
  const pentair = randomUUID();
  const johnSmith = randomUUID();
  const petersonHousehold = randomUUID();
  const petersonAppointment = randomUUID();
  const salesIdentity = randomUUID();
  const ctx = { tenantId: tenantA, userId: sarah, employeeId: sarah, role: "owner" as const };
  let goldenThreadId = "";

  beforeAll(async () => {
    delete process.env.ZEP_API_KEY;
    process.env.GMAIL_USER = "sales@example.test";
    process.env.GMAIL_APP_PASSWORD = "phase6-test-app-password";
    process.env.FINNOR_LEGACY_CREDENTIAL_TENANT_IDS = tenantA;
    await migrate(SUPER_URL);
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES ($1,'Phase 6 A'),($2,'Phase 6 B')", [tenantA, tenantB]);
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name) VALUES ($1,$4,$6,'owner','Sarah'),($2,$4,$7,'dispatcher','Peer'),($3,$5,$8,'owner','Other Tenant')",
      [sarah, peer, otherTenantOwner, tenantA, tenantB, `sarah-${sarah}@example.test`, `peer-${peer}@example.test`, `other-${otherTenantOwner}@example.test`],
    );
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES ($1,$2,'pentair-phase6','Pentair','partner')", [pentair, tenantA]);
    await admin.query("INSERT INTO finnor_os.external_contacts(id,tenant_id,contact_key,external_organization_id,name) VALUES ($1,$2,'john-smith-phase6',$3,'John Smith')", [johnSmith, tenantA, pentair]);
    await admin.query("INSERT INTO finnor_os.households(id,tenant_id,address,contact_info) VALUES ($1,$2,'10 Peterson Way',$3::jsonb)", [petersonHousehold, tenantA, JSON.stringify({ name: "Peterson Family" })]);
    await admin.query("INSERT INTO finnor_os.appointments(id,tenant_id,subject_type,subject_id,status,scheduled_at) VALUES ($1,$2,'household',$3,'confirmed',now()+interval '3 days')", [petersonAppointment, tenantA, petersonHousehold]);
    await admin.query("INSERT INTO finnor_os.communication_identities(id,tenant_id,identity_key,provider,channel,address,status,capabilities,credential_provider,credential_ref) VALUES ($1,$2,'sales_email_phase6','gmail','email','sales@example.test','active','[]','legacy-env','legacy-env:gmail')", [salesIdentity, tenantA]);
    await admin.query("INSERT INTO finnor_os.communication_identity_bindings(tenant_id,communication_identity_id,principal_type,principal_id,purpose,priority,status) VALUES ($1,$2,'employee',$3,'sales',100,'active')", [tenantA, salesIdentity, sarah]);
    await admin.end();
    process.env.DATABASE_URL = APP_URL;
    await closePool();
  });

  afterAll(async () => {
    await closePool();
    process.env.DATABASE_URL = SUPER_URL;
    for (const [name, value] of Object.entries(priorCredentials)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("uses the active users.id as the canonical human and rejects service principals", async () => {
    await expect(resolveCanonicalHumanPrincipal(ctx)).resolves.toBe(sarah);
    await expect(resolveCanonicalHumanPrincipal({ tenantId: tenantA, userId: "system:worker", role: "owner" })).rejects.toThrow("canonical_human_principal_required");
  });

  it("persists exact ordered messages idempotently and enforces employee + tenant isolation", async () => {
    const thread = await createEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, title: "Durable exact history" });
    const first = await appendEmployeeConversationMessage({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, role: "user", channel: "text", originalText: "Exact whitespace:  two spaces.", idempotencyKey: "exact-1" });
    const duplicate = await appendEmployeeConversationMessage({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, role: "user", channel: "text", originalText: "Exact whitespace:  two spaces.", idempotencyKey: "exact-1" });
    const assistant = await appendEmployeeConversationMessage({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, role: "assistant", channel: "text", originalText: "This is the actual assistant response.", idempotencyKey: "exact-2", outcomeRefs: [{ kind: "test", id: first.message.id }] });
    expect(duplicate).toMatchObject({ duplicate: true, message: { id: first.message.id, sequence: 1 } });
    expect(assistant.message.sequence).toBe(2);
    await closePool(); // process restart simulation; Postgres must remain canonical
    const loaded = await loadEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, messageLimit: 100 });
    expect(loaded?.messages.map((message) => message.originalText)).toEqual(["Exact whitespace:  two spaces.", "This is the actual assistant response."]);
    await expect(loadEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: peer, threadId: thread.id })).resolves.toBeNull();
    await expect(loadEmployeeConversationThread({ tenantId: tenantB, ownerEmployeeId: otherTenantOwner, threadId: thread.id })).resolves.toBeNull();
    expect(await listEmployeeConversationThreads(tenantA, peer)).toEqual([]);
    await expect(prepareEmployeeConversationTurn({ ctx: { tenantId: tenantA, userId: peer, employeeId: peer, role: "dispatcher" }, threadId: thread.id, instruction: "Continue this private thread.", instructionId: randomUUID(), channel: "text" })).rejects.toThrow("conversation_thread_not_found");

    const serviceConnection = new pg.Client({ connectionString: APP_URL });
    await serviceConnection.connect();
    await serviceConnection.query("BEGIN");
    await serviceConnection.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
    const serviceVisible = await serviceConnection.query("SELECT count(*)::int AS count FROM finnor_os.employee_conversation_threads");
    expect(serviceVisible.rows[0]?.count).toBe(0);
    await serviceConnection.query("ROLLBACK");
    await serviceConnection.end();
  });

  it("passes the Sarah/Pentair/Peterson golden sequence with current sender revalidation and supersession", async () => {
    const day1 = await prepareEmployeeConversationTurn({
      ctx,
      instruction: "I spoke with John Smith from Pentair. Use my sales email when contacting him.",
      instructionId: randomUUID(),
      idempotencyKey: "golden-day-1",
      channel: "text",
      transportSessionId: "browser-transport-only",
    });
    goldenThreadId = day1.threadId;
    expect(day1.context.resolution.resolvedReferences).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: "external_contact", entityId: johnSmith })]));
    expect(day1.context.personalMemories).toEqual(expect.arrayContaining([expect.objectContaining({ subjectKey: "communication.sender.email:outbound_sales" })]));

    const day2 = await prepareEmployeeConversationTurn({ ctx, threadId: goldenThreadId, instruction: "Email him and tell him we're moving Peterson to Friday.", instructionId: randomUUID(), idempotencyKey: "golden-day-2", channel: "text" });
    expect(day2.context.resolution).toMatchObject({ status: "resolved", senderIdentityRef: { communicationIdentityId: salesIdentity, channel: "email", purpose: "sales" } });
    expect(day2.context.resolution.resolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "external_contact", entityId: johnSmith }),
      expect.objectContaining({ entityType: "appointment", entityId: petersonAppointment }),
    ]));

    const day3 = await prepareEmployeeConversationTurn({ ctx, threadId: goldenThreadId, instruction: "Move the Peterson appointment to Friday.", instructionId: randomUUID(), idempotencyKey: "golden-day-3", channel: "voice", transportSessionId: "vapi:transport-only" });
    expect(day3.context.resolution).toMatchObject({ status: "resolved" });
    expect(day3.context.resolution.resolvedReferences[0]).toMatchObject({ entityType: "appointment", entityId: petersonAppointment });
    const day3Followup = await prepareEmployeeConversationTurn({ ctx, threadId: goldenThreadId, instruction: "Move it to Saturday.", instructionId: randomUUID(), idempotencyKey: "golden-day-3-followup", channel: "text" });
    expect(day3Followup.context.resolution).toMatchObject({ status: "resolved" });
    expect(day3Followup.context.resolution.resolvedReferences).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: "appointment", entityId: petersonAppointment })]));

    await prepareEmployeeConversationTurn({ ctx, threadId: goldenThreadId, instruction: "Use ops@example.com from now on.", instructionId: randomUUID(), idempotencyKey: "golden-day-4", channel: "text" });
    const memories = await listEmployeePersonalMemories({ tenantId: tenantA, ownerEmployeeId: sarah, subjectKey: "communication.sender.email:outbound_sales", includeSuperseded: true });
    expect(memories).toHaveLength(2);
    expect(memories.filter((memory) => memory.supersededAt === null)).toEqual([expect.objectContaining({ structuredValue: expect.objectContaining({ selector: "ops@example.com" }) })]);
    expect(memories.filter((memory) => memory.supersededAt !== null)[0]?.supersededById).toBe(memories.find((memory) => memory.supersededAt === null)?.id);
  });

  it("never promotes assistant output into personal memory", async () => {
    const loaded = await loadEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: goldenThreadId, messageLimit: 10 });
    const message = loaded!.messages.at(-1)!;
    await expect(rememberExplicitEmployeeMemory({ tenantId: tenantA, ownerEmployeeId: sarah, sourceThreadId: goldenThreadId, sourceMessageId: message.id, role: "assistant", memoryType: "preference", subjectKey: "poison", proposition: "Assistant says Sarah prefers a guessed sender", structuredValue: { guessed: true }, provenance: { source: "assistant" } })).resolves.toBeNull();
    expect(await listEmployeePersonalMemories({ tenantId: tenantA, ownerEmployeeId: sarah, subjectKey: "poison" })).toEqual([]);
  });

  it("links canonical conversation continuity to existing Work and objective truth", async () => {
    const objectiveText = "Reconcile the open appointment schedule and report completion.";
    const prepared = await prepareEmployeeConversationTurn({ ctx, instruction: objectiveText, instructionId: randomUUID(), idempotencyKey: "objective-continuity", channel: "text" });
    const started = await new FinnorOrchestrator().startObjective(objectiveText, ctx, {
      instructionId: prepared.userMessage.instructionId!,
      idempotencyKey: "objective-continuity-work",
      channel: "text",
    });
    await linkEmployeeConversationTurnToWork({
      tenantId: tenantA,
      employeeId: sarah,
      threadId: prepared.threadId,
      userMessageId: prepared.userMessage.id,
      workId: started.workId,
      workInputId: started.workInputId,
      objectiveLoopId: started.objectiveLoopId,
    });
    await persistEmployeeAssistantTurn({
      tenantId: tenantA,
      employeeId: sarah,
      threadId: prepared.threadId,
      instructionId: started.instructionId,
      channel: "text",
      text: "Objective accepted; canonical inspection is next.",
      workId: started.workId,
      workInputId: started.workInputId,
      outcomeRefs: [{ kind: "objective_loop", id: started.objectiveLoopId }],
    });
    const continued = await prepareEmployeeConversationTurn({ ctx, threadId: prepared.threadId, instruction: "Continue that.", instructionId: randomUUID(), idempotencyKey: "objective-continuity-followup", channel: "text" });
    expect(continued.context.resolution).toMatchObject({ status: "resolved", resolvedReferences: [expect.objectContaining({ entityType: "work", entityId: started.workId })] });
    const loaded = await loadEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: prepared.threadId, messageLimit: 10 });
    expect(loaded?.thread).toMatchObject({ activeWorkId: started.workId, activeObjectiveLoopId: started.objectiveLoopId });
    expect(loaded?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: prepared.userMessage.id, workId: started.workId, workInputId: started.workInputId }),
      expect.objectContaining({ role: "assistant", originalText: "Objective accepted; canonical inspection is next.", workId: started.workId }),
    ]));
  });

  it("clarifies an ambiguous Work continuation when no active Work is selected", async () => {
    const thread = await createEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, title: "Ambiguous Work continuation" });
    const firstWork = await receiveWork({ tenantId: tenantA, userId: sarah, instruction: "Review the Peterson schedule.", channel: "text", instructionId: randomUUID(), idempotencyKey: "ambiguous-continuation-a" });
    const secondWork = await receiveWork({ tenantId: tenantA, userId: sarah, instruction: "Review the Pentair quote.", channel: "text", instructionId: randomUUID(), idempotencyKey: "ambiguous-continuation-b" });
    await appendEmployeeConversationMessage({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, role: "user", channel: "text", originalText: "Started the Peterson schedule Work.", workId: firstWork.workId, workInputId: firstWork.workInputId, instructionId: firstWork.instructionId, idempotencyKey: "ambiguous-continuation-message-a" });
    await appendEmployeeConversationMessage({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, role: "user", channel: "text", originalText: "Started the Pentair quote Work.", workId: secondWork.workId, workInputId: secondWork.workInputId, instructionId: secondWork.instructionId, idempotencyKey: "ambiguous-continuation-message-b" });
    await updateEmployeeConversationThreadContext({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: thread.id, activeWorkId: null });
    const continued = await prepareEmployeeConversationTurn({ ctx, threadId: thread.id, instruction: "Continue what we started yesterday.", instructionId: randomUUID(), idempotencyKey: "ambiguous-continuation-followup", channel: "text" });
    expect(continued.context.resolution).toMatchObject({ status: "clarification_required", consequential: true });
    expect(continued.context.resolution.unresolvedExpressions).toContain("continuation");
    expect(continued.context.resolution.candidates.filter((candidate) => candidate.entityType === "work")).toHaveLength(2);
  });

  it("fails closed after a sender is revoked and after current company truth supersedes an appointment", async () => {
    await withTenant(tenantA, (db) => db.update(communicationIdentities).set({ status: "disabled" }).where(and(eq(communicationIdentities.tenantId, tenantA), eq(communicationIdentities.id, salesIdentity))));
    const revoked = await prepareEmployeeConversationTurn({ ctx, threadId: goldenThreadId, instruction: "Email John Smith from Pentair the update.", instructionId: randomUUID(), idempotencyKey: "revoked-sender", channel: "text" });
    expect(revoked.context.resolution).toMatchObject({ status: "clarification_required", senderIdentityRef: null });

    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("UPDATE finnor_os.appointments SET status='canceled' WHERE id=$1", [petersonAppointment]);
    await admin.end();
    const stale = await prepareEmployeeConversationTurn({ ctx, threadId: goldenThreadId, instruction: "Move that appointment to Monday.", instructionId: randomUUID(), idempotencyKey: "stale-appointment", channel: "text" });
    expect(stale.context.resolution).toMatchObject({ status: "clarification_required", resolvedReferences: [] });
    expect(stale.context.resolution.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ result: "rejected", reason: "no longer current" })]));
  });

  it("retrieves an exact reference beyond 100 messages without loading unbounded history", async () => {
    const historical = await createEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, title: "Long exact history" });
    const old = await appendEmployeeConversationMessage({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: historical.id, role: "user", channel: "text", originalText: "We discussed John Smith from Pentair during the quarterly review.", idempotencyKey: "old-john", resolutionSnapshot: { resolvedReferences: [{ entityType: "external_contact", entityId: johnSmith }] } });
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query(
      "INSERT INTO finnor_os.employee_conversation_messages(tenant_id,thread_id,owner_employee_id,sequence,role,channel,author_employee_id,original_text,idempotency_key) SELECT $1,$2,$3,n,'user','text',$3,'Filler exact turn '||n,'filler-'||n FROM generate_series(2,106) n",
      [tenantA, historical.id, sarah],
    );
    await admin.end();
    const bounded = await loadEmployeeConversationThread({ tenantId: tenantA, ownerEmployeeId: sarah, threadId: historical.id, messageLimit: 100 });
    expect(bounded?.messages).toHaveLength(100);
    expect(bounded?.messages.some((message) => message.id === old.message.id)).toBe(false);
    const resolved = await prepareEmployeeConversationTurn({ ctx, threadId: historical.id, instruction: "Email the John we discussed.", instructionId: randomUUID(), idempotencyKey: "old-john-resolve", channel: "text" });
    expect(resolved.context.olderRelevantMessages.some((message) => message.id === old.message.id)).toBe(true);
    expect(resolved.context.resolution.resolvedReferences[0]).toMatchObject({ entityType: "external_contact", entityId: johnSmith, source: "history_search" });
  });

  it("clarifies duplicate current targets and creates zero Business Effects", async () => {
    const secondOrganization = randomUUID();
    const secondJohn = randomUUID();
    const admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES ($1,$2,'second-org-phase6','Second Org','partner')", [secondOrganization, tenantA]);
    await admin.query("INSERT INTO finnor_os.external_contacts(id,tenant_id,contact_key,external_organization_id,name) VALUES ($1,$2,'john-other-phase6',$3,'John Peterson')", [secondJohn, tenantA, secondOrganization]);
    await admin.end();
    const ambiguous = await prepareEmployeeConversationTurn({ ctx, instruction: "Email John the update.", instructionId: randomUUID(), idempotencyKey: "ambiguous-john", channel: "text" });
    expect(ambiguous.context.resolution).toMatchObject({ status: "clarification_required", consequential: true });
    expect(ambiguous.context.resolution.candidates.length).toBeGreaterThanOrEqual(2);
    const result = await new FinnorOrchestrator().handleInstructionResult("Email John the update.", ctx, { instructionId: ambiguous.userMessage.instructionId!, channel: "text", conversationContext: ambiguous.context, instructionRouteDecision: { version: 1, route: "ATOMIC_EFFECT", reasonCodes: ["phase6_reference_or_sender_ambiguous"] }, skipFastReadClassification: true });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.actionType).toBe("clarification_request");
    const effects = await withTenant(tenantA, (db) => db
      .select({ id: businessEffects.id })
      .from(businessEffects)
      .innerJoin(domainActions, eq(domainActions.id, businessEffects.domainActionId))
      .where(eq(domainActions.workId, result.workId!)));
    expect(effects).toEqual([]);
  });
});
