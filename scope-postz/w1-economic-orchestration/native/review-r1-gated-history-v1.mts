/** Failure-first R1 driver (remaining-roots-failure-contract-v1.md).
 * Real disposable embedded PostgreSQL (migrated), REAL
 * persistEmployeeAssistantTurn + loadEmployeeConversationThread against a
 * fixture whose gated Work carries a financial finalOutcome summary.
 * Zep is never live: ZEP_API_KEY stays unset, so mirrorConversationMessageToZep
 * is the real no-op path; the mirror's content argument is the same storedText
 * variable by construction (source marker asserted).
 * Broken signature R1_FINANCIAL_PROSE_IN_UNGATED_HISTORY: the stored
 * assistant message originalText contains the amounts, and the ownership-only
 * reader returns them with no current authorization check (verified by
 * suspending the principal and reading again: amounts still returned).
 * Repaired signature R1_GATED_REFERENCE_PERSISTENCE: stored text is the
 * non-sensitive reference; an active principal's read hydrates the amounts
 * from the gated Work record; a suspended principal's read returns the
 * reference alone. */
import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { ownDisposablePostgres, closeDisposablePostgres } from "../../../finnor-os/scripts/postz-w1/disposable-postgres.mjs";

const destination = process.argv[2] ?? "";
assert(isAbsolute(destination) && !existsSync(destination), "NEW_ABSOLUTE_REGRESSION_RECEIPT_REQUIRED");
const root = resolve(import.meta.dirname, "../../..");
const kernelSource = readFileSync(join(root, "finnor-os/packages/orchestration/src/conversation-kernel.ts"), "utf8");
const persistBody = kernelSource.slice(kernelSource.indexOf("export async function persistEmployeeAssistantTurn"));
const repairedMarkers = persistBody.includes("referenceText") && persistBody.includes("originalText: storedText")
  && persistBody.includes("content: storedText");
assert(!process.env.ZEP_API_KEY, "ZEP_MUST_BE_UNSET_IN_HARNESS");

const port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const scratch = mkdtempSync(join(tmpdir(), "finnor-w1-r1-"));
const owned = ownDisposablePostgres(scratch, join(scratch, "db"), destination + ".cleanup.json");
try {
const requireFinnor = createRequire(join(root, "finnor-os/package.json"));
const embeddedModule = requireFinnor("embedded-postgres");
const EmbeddedPostgres = embeddedModule.default ?? embeddedModule;
const database = owned.attach(new EmbeddedPostgres({ databaseDir: join(scratch, "db"), user: "finnor", password: "finnor", port,
  persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1"], onLog: () => undefined, onError: () => undefined }));
await database.initialise(); await database.start();
await database.createDatabase("w1_r1");
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
const { migrate } = await import("../../../finnor-os/packages/db/migrate");
await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/w1_r1`);
process.env.DATABASE_URL = `postgres://finnor:finnor@127.0.0.1:${port}/w1_r1`;

const dbModule = await import("../../../finnor-os/packages/db/index");
const { createEmployeeConversationThread, loadEmployeeConversationThread } = dbModule as never as Record<string, any>;
const { persistEmployeeAssistantTurn } = await import("../../../finnor-os/packages/orchestration/src/conversation-kernel");
const pg = requireFinnor("pg");

const tenantId = randomUUID(), employeeId = randomUUID(), workId = randomUUID(), inputId = randomUUID(), instructionId = randomUUID();
const PROSE = "Revenue reached $12,500 against a $9,750 baseline.";
const REFERENCE = "Outcome recorded for the Work; financial detail is available after a current authorization check.";
const seed = new pg.Client({ connectionString: process.env.DATABASE_URL });
await seed.connect();
await seed.query("INSERT INTO finnor_os.tenants (id, name) VALUES ($1, 'w1-r1')", [tenantId]);
await seed.query("INSERT INTO finnor_os.users (tenant_id, id, email, display_name, role, status) VALUES ($1, $2, 'w1-r1@example.invalid', 'w1-r1', 'owner', 'active')", [tenantId, employeeId]);
await seed.query("INSERT INTO finnor_os.works (id, tenant_id, initial_channel, initial_instruction, status, final_outcome) VALUES ($1, $2, 'text', 'r1', 'completed', $3::jsonb)",
  [workId, tenantId, JSON.stringify({ summary: PROSE })]);
await seed.query("INSERT INTO finnor_os.work_inputs (id, tenant_id, work_id, instruction_text, channel, instruction_id) VALUES ($1, $2, $3, 'r1', 'text', $4)", [inputId, tenantId, workId, instructionId]);
const thread = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId });
await persistEmployeeAssistantTurn({
  tenantId, employeeId, threadId: thread.id, instructionId, channel: "text",
  text: PROSE, workId, workInputId: inputId,
  outcomeRefs: [{ kind: "work", id: workId }],
  referenceText: REFERENCE,
} as never);

const stored = await seed.query("SELECT original_text FROM finnor_os.employee_conversation_messages WHERE tenant_id=$1 AND role='assistant'", [tenantId]);
const storedText = String(stored.rows[0]?.original_text ?? "");
const readActive = await loadEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id });
const assistantActive = readActive?.messages?.find((m: { role: string }) => m.role === "assistant");
await seed.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [tenantId, employeeId]);
const readSuspended = await loadEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id });
const assistantSuspended = readSuspended?.messages?.find((m: { role: string }) => m.role === "assistant");
await seed.end();

const amount = "12,500";
const receipt = {
  schema: "finnor.w1.r1-gated-history.v1",
  repairedMarkers,
  zepConfigured: false,
  storedContainsAmounts: storedText.includes(amount),
  activeRead: { originalText: assistantActive?.originalText ?? null, hydratedText: assistantActive?.hydratedText ?? null },
  suspendedRead: { originalText: assistantSuspended?.originalText ?? null, hydratedText: assistantSuspended?.hydratedText ?? null },
};
let observed: string;
let defect: boolean;
if (!repairedMarkers) {
  observed = receipt.storedContainsAmounts ? "R1_FINANCIAL_PROSE_IN_UNGATED_HISTORY" : "R1_BROKEN_NOT_REPRODUCED";
  defect = observed === "R1_FINANCIAL_PROSE_IN_UNGATED_HISTORY";
} else {
  const ok = !receipt.storedContainsAmounts
    && assistantActive?.hydratedText?.includes(amount)
    && !assistantSuspended?.hydratedText
    && !String(assistantSuspended?.originalText ?? "").includes(amount);
  observed = ok ? "R1_GATED_REFERENCE_PERSISTENCE" : "R1_REPAIR_INCOMPLETE";
  defect = !ok;
}
Object.assign(receipt, { observed, defect });
writeFileSync(destination, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ observed, defect, storedContainsAmounts: receipt.storedContainsAmounts,
  activeHydrated: Boolean(assistantActive?.hydratedText), suspendedHydrated: Boolean(assistantSuspended?.hydratedText) }));
process.exitCode = defect ? 1 : 0;
} finally {
  await closeDisposablePostgres(owned, [async () => (await import("../../../finnor-os/packages/db/index")).closePool()]);
}
