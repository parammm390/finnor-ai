import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, externalContacts, loadEmployeeConversationThread, tenants, users, withTenant, workInputs } from "@finnor/db";
import { POST } from "../../apps/api/app/api/actions/route";
import { migrate } from "../../packages/db/migrate";
import { installVerticalFixtureSeam } from "../vertical-fixture-seam";

vi.mock("../../apps/api/lib/orchestrator", () => ({
  getOrchestrator: () => ({ handleInstructionResult: async () => ({ actions: [], answer: "Synthetic response" }) }),
}));
vi.mock("../../apps/api/lib/worker-readiness", () => ({ requireWorkerFleetReady: async () => {} }));
vi.mock("../../apps/api/lib/backpressure", () => ({ enforceBatchBackpressure: async () => {} }));

vi.mock("@finnor/memory", () => ({
  mirrorConversationMessageToZep: vi.fn(),
  queryConsolidatedFacts: async () => [],
}));

vi.mock("../../packages/orchestration/src/conversation-memory", () => ({
  hydrateConversationMemory: async ({ context }: { context: unknown }) => context,
  scheduleConversationCompaction: vi.fn(),
}));

const databaseUrl = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const tenantId = randomUUID();
const employeeId = randomUUID();
const contacts = {
  terry: { id: randomUUID(), label: "Terry Morgan" },
  birchTerry: { id: randomUUID(), label: "Terry Morgan (Birch)" },
  bob: { id: randomUUID(), label: "Bob Smith" },
  alice: { id: randomUUID(), label: "Alice Chen" },
};

async function databaseAvailable() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)) return false;
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

describe.skipIf(!await databaseAvailable())("persisted conversation outreach recipients", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    vi.stubEnv("AUTH_DEV_BYPASS", "1");
    await migrate(databaseUrl);
    await installVerticalFixtureSeam(databaseUrl);
    await withTenant(tenantId, async db => {
      await db.insert(tenants).values({ id: tenantId, name: "Synthetic outreach fixture" });
      await db.insert(users).values({ id: employeeId, tenantId, role: "owner", email: `${employeeId}@example.test` });
      await db.insert(externalContacts).values(Object.entries(contacts).map(([contactKey, contact]) => ({
        id: contact.id, tenantId, contactKey: contactKey.toLowerCase(), name: contact.label,
      })));
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });

  it.each([
    ["body name", "Email Terry Morgan. Body: Call Bob Smith about next steps.", [contacts.terry]],
    ["subject name", "Email Terry Morgan. Subject: Call Bob Smith.", [contacts.terry]],
    ["quoted text", "Email Terry Morgan: ‘Call Bob Smith.’", [contacts.terry]],
    ["drafted text", "Email Terry Morgan. Draft: Call Bob Smith.", [contacts.terry]],
    ["body namesake", "Email Terry Morgan. Body: Call Terry Morgan from Birch.", [contacts.terry]],
    ["two addressees", "Email Terry Morgan and Alice Chen. Body: Call Bob Smith.", [contacts.terry, contacts.alice]],
    ["no addressee", "Email body: Call Bob Smith about next steps.", []],
    ["subject only", "Subject: Bob Smith intro", []],
    ["inline content", "Email Terry Morgan saying to call Bob Smith.", [contacts.terry]],
    ["inline topic", "Email Terry Morgan about whether to call Bob Smith.", [contacts.terry]],
    ["corrected addressee", "Email Terry Morgan — sorry, Terry Morgan from Birch", [contacts.birchTerry]],
    ["channel switch with a result clause", "I can't call Terry Morgan from Birch, so email Terry Morgan", [], "Which active target do you mean for Terry Morgan?"],
  ])("persists only the addressees for %s", async (_scenario, instruction, recipients, clarificationQuestion = null) => {
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": employeeId, "x-user-role": "owner" },
      body: JSON.stringify({ instruction, channel: "text" }),
    }));
    const body = await response.json() as { workId: string; workInputId: string; threadId: string; instructionId: string };
    expect(response.ok, JSON.stringify(body)).toBe(true);
    const persisted = await loadEmployeeConversationThread({
      tenantId, ownerEmployeeId: employeeId, threadId: body.threadId, messageLimit: 2,
    });

    const expected = recipients.map(({ id, label }) => ({ entityType: "external_contact", entityId: id, label }));
    expect(persisted?.messages.find(message => message.role === "user")).toMatchObject({
      instructionId: body.instructionId,
      originalText: instruction,
      resolutionSnapshot: {
        status: clarificationQuestion ? "clarification_required" : expected.length ? "resolved" : "none",
        resolvedReferences: expected,
        clarificationQuestion,
      },
    });
    expect(persisted?.thread.activeReferences.map(({ entityType, entityId, label }) => ({ entityType, entityId, label })))
      .toEqual(expected);
    const [input] = await withTenant(tenantId, db => db.select().from(workInputs).where(and(
      eq(workInputs.tenantId, tenantId), eq(workInputs.workId, body.workId), eq(workInputs.id, body.workInputId),
    )));
    expect(input).toMatchObject({ instructionText: instruction });
    const context = input?.contextSnapshot as { selectedEntities?: Array<{ entityType: string; entityId: string }> } | null;
    expect(context?.selectedEntities ?? []).toEqual(expected.map(({ entityType, entityId }) => ({ entityType, entityId })));
  });
});
