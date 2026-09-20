import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const db = source("../../packages/db/index.ts");
const workCases = source("../../packages/read-models/src/work-cases.ts");
const causalReplay = source("../../packages/read-models/src/causal-replay.ts");
const executionProjection = source("../../packages/read-models/src/execution-projection.ts");
const planDag = source("../../packages/orchestration/src/plan-dag.ts");
const objectiveSuccess = source("../../packages/orchestration/src/objective-success.ts");
const objectiveLoop = source("../../packages/orchestration/src/objective-loop.ts");
const pendingRoute = source("../../apps/api/app/api/actions/pending/route.ts");
const workRoute = source("../../apps/api/app/api/works/[id]/route.ts");
const instructionEventsRoute = source("../../apps/api/app/api/instructions/[id]/events/route.ts");
const streamRoute = source("../../apps/api/app/api/stream/route.ts");
const digestRoute = source("../../apps/api/app/api/user-prefs/digest/route.ts");
const reliability = source("../../packages/read-models/src/index.ts");
const runtimeBridge = source("../../packages/orchestration/src/runtime-bridge.ts");
const learning = source("../../packages/orchestration/src/learning.ts");
const orchestration = source("../../packages/orchestration/src/index.ts");

describe("production egress regression protection", () => {
  it("keeps every high-volume Work/history read bounded in PostgreSQL", () => {
    expect(db).toContain("MAX_WORK_AGGREGATE_ROWS + 1");
    expect(db).toContain('bounded("action_log"');
    expect(db).toContain('bounded("domain_actions"');
    expect(db).toContain('bounded("business_operation_targets"');
    expect(workCases.match(/MAX_CHILD_ROWS_PER_TABLE \+ 1/g)?.length).toBeGreaterThanOrEqual(5);
    expect(causalReplay).toContain("instructionRowsPlus");
    expect(causalReplay).toContain(".limit(ACTION_EVENT_LIMIT + 1)");
    expect(executionProjection).toContain(".limit(ACTION_LIMIT * 10)");
    expect(planDag).toContain(".limit(MAX_HIGH_EGRESS_ROWS + 1)");
    expect(objectiveSuccess).toContain('bounded("domain_actions"');
    expect(objectiveLoop).toContain("effectRowsPlus");
    expect(objectiveLoop).toContain("MAX_HIGH_EGRESS_ROWS + 1");
  });

  it("keeps instruction polling and pending-approval enrichment SQL-bounded", () => {
    expect(instructionEventsRoute).toContain(".limit(limit + 1)");
    expect(streamRoute).toContain(".limit(EVENT_BATCH_SIZE)");
    expect(pendingRoute).toContain("selectDistinctOn([decisionReceipts.domainActionId]");
    expect(pendingRoute).toContain("selectDistinctOn([actionLog.domainActionId]");
    expect(pendingRoute).toContain(".limit(actionIds.length)");
    expect(pendingRoute).not.toMatch(/const receiptRows[\s\S]*?\.orderBy\(desc\(decisionReceipts\.createdAt\)\),/);
    expect(workRoute).toContain("workExists");
    expect((workRoute.match(/workAggregate\(/g) ?? []).length).toBe(1);
    expect(runtimeBridge).toContain("jsonb_typeof");
    expect(runtimeBridge).toContain(".limit(1)");
    expect(orchestration).toContain("WITH rejected AS");
    expect(orchestration).not.toContain(".returning({ id: domainActions.id })");
  });

  it("uses database aggregates for counts and prediction metrics instead of row transfer", () => {
    expect(digestRoute).toContain("count(*)::int");
    expect(digestRoute).not.toContain('select({ id: domainActions.id }).from(domainActions)');
    expect(reliability).toContain("jsonb_typeof");
    expect(reliability).toContain("groupBy(domainActions.actionType)");
    expect(reliability).not.toContain("const predictionRows = await db.select().from(domainActions)");
    expect(learning).toContain("extract(epoch from");
    expect(learning).toContain("selectDistinct({ voiceSessionId: pendingConfirmations.voiceSessionId })");
    expect(learning).toContain("MAX_HIGH_EGRESS_ROWS + 1");
  });

  it("keeps the new index migration additive and aligned with the schema", () => {
    const migration = source("../../packages/db/migrations/0131_egress_bounded_read_indexes.sql");
    const schema = source("../../packages/db/schema.ts");
    for (const name of [
      "action_log_tenant_action_timestamp_id_idx",
      "instruction_events_tenant_instruction_seq_idx",
      "domain_actions_tenant_work_created_id_idx",
      "business_operation_targets_tenant_operation_ordinal_id_idx",
      "communications_log_tenant_timestamp_id_idx",
    ]) {
      expect(migration).toContain(name);
      expect(schema).toContain(name);
    }
    expect(migration).not.toMatch(/DROP\s+(TABLE|INDEX|TRIGGER|POLICY)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});
