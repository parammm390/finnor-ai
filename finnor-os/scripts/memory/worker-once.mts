import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { registerProvider } from "../../packages/tools/src/llm";
import { closePool, PRODUCTION_JOB_CONTRACTS } from "../../packages/db/index";
import { JobQueue } from "../../apps/worker/src/queue";
import { compactEmployeeConversationJob } from "../../apps/worker/src/handlers/compact-employee-conversation";
import { captureMemoryProvider } from "./fixtures.mjs";

registerProvider("memory-e2e-capture", captureMemoryProvider);
createRequire(import.meta.url)("../../packages/tools/src/llm.ts").registerProvider("memory-e2e-capture", captureMemoryProvider);
const objective = process.argv[2]?.startsWith("objective");
const queue = new JobQueue("memory-e2e:" + process.pid, 3, objective ? "INTERACTIVE" : "BACKGROUND");
if (process.argv[2] === "objective-compat") {
  const { FinnorOrchestrator } = await import("../../packages/orchestration/src/index");
  const { LLMObjectiveDecisionPlanner } = await import("../../packages/orchestration/src/objective-loop");
  const orchestrator = new FinnorOrchestrator({ objectiveDecisionPlanner: new LLMObjectiveDecisionPlanner(captureMemoryProvider()) });
  queue.register("run_objective_iteration", async payload => {
    const tenantId = String(payload.tenantId ?? ""), workId = String(payload.workId ?? ""), objectiveLoopId = String(payload.objectiveLoopId ?? "");
    if (!tenantId || !workId || !objectiveLoopId) throw new Error("Objective fixture requires exact durable binding");
    await orchestrator.runObjectiveIteration({ tenantId, workId, objectiveLoopId, expectedRevision: Number(payload.expectedRevision), expectedStepNumber: Number(payload.expectedStepNumber), deferToWorkforceJob: true });
  }, PRODUCTION_JOB_CONTRACTS.run_objective_iteration);
} else if (objective) {
  const { runObjectiveIteration } = await import("../../apps/worker/src/handlers/run-objective-iteration");
  queue.register("run_objective_iteration", runObjectiveIteration, PRODUCTION_JOB_CONTRACTS.run_objective_iteration);
}
else queue.register("compact_employee_conversation_v1", async (payload, execution) => {
  await compactEmployeeConversationJob(payload, execution);
  if (process.env.FINNOR_MEMORY_AFTER_PUBLICATION_MARKER) {
    await writeFile(process.env.FINNOR_MEMORY_AFTER_PUBLICATION_MARKER, JSON.stringify({ pid: process.pid, phase: "after_publication_before_ack" }));
    await new Promise(() => undefined);
  }
}, PRODUCTION_JOB_CONTRACTS.compact_employee_conversation_v1);
try {
  await queue.recoverExpiredRunningJobs();
  const worked = await queue.tick();
  process.stdout.write(JSON.stringify({ pid: process.pid, worked }) + "\n");
} finally { await closePool(); }
