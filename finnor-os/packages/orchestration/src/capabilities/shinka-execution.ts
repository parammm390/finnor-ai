import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CanonicalAllocationProblem } from "@finnor/shared-types";
import { CapabilityEngineError, runPythonEngine } from "@finnor/tools/capabilities/python-runner";
import { resolveProviderForPurpose } from "@finnor/tools/llm";
import { releaseBudget } from "@finnor/tools/provider-budget";
import { ExperimentRefSchema } from "../../../epistemic-runtime/src/experiments";
import { verifyCanonicalAllocation } from "../../../epistemic-runtime/src/allocation-checker";
import { readStoredAllocation } from "../../../private-equity/src/allocation-store";
import { loadCapabilitySource } from "./repository";
import { capabilityDigest } from "./policy";
import { executeModalStep, terminateInternalModalSandbox } from "./modal-execution";
import type { CapabilityActor, CapabilityRun } from "./contracts";
import type { ProviderCheckpoint } from "./provider-step";
import { withOptimizationBroker } from "./optimization-broker";

const taskSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), split: z.enum(["development", "holdout"]), allocationRef: ExperimentRefSchema }).strict();
export const AllocationEvolutionDatasetSchema = z.object({ schema: z.literal("finnor.allocation-evolution-dataset.v1"), seedCode: z.string().min(1).max(100_000),
  objectiveScale: z.number().finite().positive().max(1e12), tasks: z.array(taskSchema).min(2).max(8) }).strict().superRefine((data, ctx) => {
  if (new Set(data.tasks.map(task => task.id)).size !== data.tasks.length || new Set(data.tasks.map(task => task.allocationRef.contentDigest)).size !== data.tasks.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_EVOLUTION_TASK_OR_ALLOCATION" });
  for (const split of ["development", "holdout"]) if (!data.tasks.some(task => task.split === split)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `MISSING_${split}_SPLIT` });
});
const solutionsSchema = z.object({ solutions: z.array(z.object({ taskId: z.string(), selectedPolicyIds: z.array(z.string().min(1).max(512)).max(32) }).strict()).min(1).max(8) }).strict();

export async function executeShinka(actor: CapabilityActor, run: CapabilityRun, checkpoint: ProviderCheckpoint): Promise<Record<string, unknown>> {
  const request = run.request;
  if (request.kind !== "shinka_evolve") throw new CapabilityEngineError("SHINKA_REQUEST_KIND_INVALID");
  if (process.env.FINNOR_SHINKA_ENABLED !== "1" || process.env.FINNOR_MODAL_ENABLED !== "1") throw new CapabilityEngineError("SHINKA_AND_MODAL_MUST_BE_ENABLED");
  const source = run.sources[0], deadlineAt = Date.parse(run.deadlineAt); if (!source) throw new CapabilityEngineError("CAPABILITY_FROZEN_SOURCE_MISSING");
  const optimizationDeadline = deadlineAt - Math.min(90_000, Math.max(20_000, Math.floor(request.timeoutMs / 3)));
  const bytes = await loadCapabilitySource(actor, source, deadlineAt); if (bytes.length > 262_144) throw new CapabilityEngineError("SHINKA_DATASET_TOO_LARGE");
  const dataset = AllocationEvolutionDatasetSchema.parse(JSON.parse(bytes.toString("utf8")));
  const tasks: Array<z.infer<typeof taskSchema> & { problem: CanonicalAllocationProblem }> = [];
  for (const task of dataset.tasks) {
    const original = await readStoredAllocation({ auth: { ...actor, employeeId: actor.userId } }, task.allocationRef);
    if (!("problem" in original)) throw new CapabilityEngineError("SHINKA_NUMERIC_ALLOCATION_REQUIRED");
    if (Date.parse(original.problem.validUntil) <= Date.now()) throw new CapabilityEngineError("SHINKA_ALLOCATION_PROBLEM_EXPIRED");
    tasks.push({ ...task, problem: original.problem });
  }
  const development = tasks.filter(task => task.split === "development"), holdout = tasks.filter(task => task.split === "holdout");
  const model = resolveProviderForPurpose("repair", "background");
  let proposalCalls = 0, evaluationCalls = 0;
  const evaluations: Array<Record<string, unknown>> = [], sandboxes: Array<Record<string, unknown>> = [];
  const evaluate = async (code: string, split: "development" | "holdout", signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (++evaluationCalls > request.generations * 3 + 8) throw new CapabilityEngineError("SHINKA_EVALUATION_LIMIT");
    const selected = split === "development" ? development : holdout;
    const stdin = JSON.stringify({ problems: selected.map(task => ({ taskId: task.id, problem: task.problem })) });
    if (Buffer.byteLength(stdin) > 100_000) throw new CapabilityEngineError("SHINKA_SANDBOX_PROBLEM_BYTES_LIMIT");
    const sandboxDeadline = Math.min((split === "development" ? optimizationDeadline : deadlineAt) - 1000, Date.now() + 45_000), physicalId = randomUUID();
    const computation: CapabilityRun = { ...run, id: physicalId, kind: "modal_execute", request: { kind: "modal_execute", idempotencyKey: `${run.id}:${evaluationCalls}`, code, sources: [], stdin,
      timeoutMs: Math.max(100, sandboxDeadline - Date.now()) }, sources: [], remoteState: {}, deadlineAt: new Date(sandboxDeadline).toISOString() };
    const receipt: Record<string, unknown> = { physicalId, split, candidateSha256: createHash("sha256").update(code).digest("hex"), state: {} }; sandboxes.push(receipt);
    const record: ProviderCheckpoint = async (state, event) => {
      if (event === "PROVIDER_DISPATCH") signal?.throwIfAborted();
      receipt.state = state;
      await checkpoint({ provider: "shinka", phase: event === "PROVIDER_DISPATCH" ? "dispatching" : "accepted", optimizerRunId: run.id, sandboxes,
        candidateExecution: "MODAL_SANDBOX_ONLY" }, event);
    };
    let step = await executeModalStep(actor, computation, record);
    while (step.status === "waiting") {
      if (Date.now() >= sandboxDeadline) throw new CapabilityEngineError("SHINKA_SANDBOX_DEADLINE");
      signal?.throwIfAborted();
      await new Promise(done => setTimeout(done, Math.min(500, sandboxDeadline - Date.now())));
      computation.remoteState = step.remoteState; step = await executeModalStep(actor, computation, record);
    }
    if (step.status === "not_dispatched") {
      receipt.state = step.remoteState;
      try { await releaseBudget(actor.tenantId, "modal", "capability_submissions", 1, new Date(deadlineAt - request.timeoutMs), `${run.id}:${physicalId}`); }
      catch { /* Keep a conservative reservation if the budget store is unavailable. */ }
      throw new CapabilityEngineError(step.code);
    }
    if (step.status !== "complete") throw new CapabilityEngineError("SHINKA_SANDBOX_OUTCOME_UNKNOWN");
    const program = z.object({ program: z.object({ stdoutBase64: z.string(), exitCode: z.literal(0), failure: z.null() }) }).safeParse(step.result);
    let parsed: ReturnType<typeof solutionsSchema.safeParse> | null = null;
    if (program.success) { try { parsed = solutionsSchema.safeParse(JSON.parse(Buffer.from(program.data.program.stdoutBase64, "base64").toString("utf8"))); } catch { parsed = null; } }
    const checks = [], scores: number[] = []; let correct = parsed?.success === true;
    for (const task of selected) {
      const matches = parsed?.success ? parsed.data.solutions.filter(row => row.taskId === task.id) : [];
      if (matches.length !== 1) { correct = false; checks.push({ taskId: task.id, feasible: false, reasons: ["MISSING_OR_DUPLICATE_TASK_SOLUTION"] }); continue; }
      // Original S5 semantics and exact-decimal feasibility remain outside the
      // sandbox. Candidate scores, objectives and checks are never accepted.
      const check = verifyCanonicalAllocation(task.problem, matches[0]!.selectedPolicyIds), objective = check.objective === null ? null : Number(check.objective);
      const finite = objective !== null && Number.isFinite(objective);
      correct &&= check.feasible && finite;
      scores.push(check.feasible && finite ? 0.5 + Math.atan(objective / dataset.objectiveScale) / Math.PI : 0);
      checks.push({ taskId: task.id, allocationRef: task.allocationRef, problemRef: task.problem.ref, check });
    }
    if (parsed?.success && parsed.data.solutions.some(row => !selected.some(task => task.id === row.taskId))) correct = false;
    const score = correct ? scores.reduce((sum, value) => sum + value, 0) / selected.length : 0;
    const observed = { split, candidateSha256: receipt.candidateSha256, score, correct, checks, sandboxId: z.object({ sandboxId: z.string() }).parse(step.result).sandboxId };
    evaluations.push(observed); return { ...observed, feedback: correct ? "All original S5 problems passed the independent exact-decimal feasibility checker." : "Original S5 checker rejected one or more allocations; candidate-supplied scores were ignored." };
  };
  try {
    await checkpoint({ provider: "shinka", phase: "dispatching", optimizerRunId: run.id, sandboxes: [] }, "PROVIDER_DISPATCH");
    const optimized = await withOptimizationBroker({ deadlineAt: optimizationDeadline, handle: async (path, raw, signal) => {
      if (path === "/evaluate") {
        const candidate = z.object({ code: z.string().min(1).max(100_000), sha256: z.string() }).strict().parse(raw);
        if (createHash("sha256").update(candidate.code).digest("hex") !== candidate.sha256) throw new Error("CANDIDATE_DIGEST_MISMATCH");
        const observed = await evaluate(candidate.code, "development", signal); return { correct: observed.correct, score: observed.score, feedback: observed.feedback };
      } else if (path === "/v1/chat/completions") {
        const input = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1).max(64) }).passthrough().parse(raw);
        if (++proposalCalls > request.generations * 3 + 4) throw new Error("PROPOSAL_LIMIT");
        const content = await model.complete({ tenantId: actor.tenantId, purpose: "repair", channel: "background", traceId: run.correlationId, deadlineAt: optimizationDeadline, signal,
          system: "You propose Python allocation algorithms only. Preserve the supplied program I/O and immutable regions. You cannot change the independent FINNOR evaluator, original allocation problems or execution permissions. Holdout problems are unavailable.",
          user: JSON.stringify(input.messages) });
        return { id: `finnor-shinka-${proposalCalls}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "finnor",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: model.lastUsage?.inputTokens ?? 0, completion_tokens: model.lastUsage?.outputTokens ?? 0 } };
      }
      throw new CapabilityEngineError("SHINKA_BROKER_PATH_UNKNOWN");
    }, run: connection => runPythonEngine("shinka", { ...connection, deadlineAt: optimizationDeadline,
      seedCode: dataset.seedCode, generations: request.generations, seed: request.seed,
      taskInstruction: "Improve a Python program that reads JSON {problems:[{taskId,problem}]} from stdin and writes JSON {solutions:[{taskId,selectedPolicyIds}]} to stdout. Choose feasible policy-id subsets maximizing the original S5 robust utility under the original resources. Never access a network or evaluator. Output full code using the required Shinka patch format." }, { deadlineAt: optimizationDeadline }) });
    const result = z.object({ bestCode: z.string().min(1).max(100_000), programs: z.array(z.record(z.string(), z.unknown())) }).passthrough().parse(optimized.result);
    const baseline = await evaluate(dataset.seedCode, "holdout"), heldout = await evaluate(result.bestCode, "holdout");
    await checkpoint({ provider: "shinka", phase: "accepted", optimizerRunId: run.id, sandboxes, candidateSha256: createHash("sha256").update(result.bestCode).digest("hex") }, "PROVIDER_ACCEPTED");
    return { schema: "finnor.shinka-allocation-candidate.v1", source, candidate: { code: result.bestCode, sha256: createHash("sha256").update(result.bestCode).digest("hex") },
      optimizer: optimized.result, computeIdentity: optimized.identity, evaluations, sandboxes, proposalCalls, evaluationCalls,
      holdout: { baseline: baseline.score, candidate: heldout.score, allFeasible: heldout.correct, disposition: heldout.correct && heldout.score > baseline.score ? "IMPROVED_ON_THIS_HELDOUT_CUT" : "NO_VERIFIED_HOLDOUT_IMPROVEMENT" },
      holdoutAvailableToEvolution: false, evaluator: "ORIGINAL_S5_EXACT_DECIMAL_ALLOCATION_CHECKER_OUTSIDE_SANDBOX", admission: { status: "BLOCKED_EXTERNAL", receipt: null },
      activation: "REQUIRES_S8_INDEPENDENT_EVALUATION_AND_ADMISSION", qualification: "VERSIONED_ALLOCATION_PROGRAM_CANDIDATE_NO_NATIVE_METHOD_OR_BUSINESS_EFFECT_AUTHORITY", executionAuthorityGranted: false };
  } finally {
    for (const record of sandboxes) {
      const state = z.object({ sandboxId: z.string(), stage: z.string() }).safeParse(record.state);
      if (state.success && state.data.stage !== "terminated") {
        try { record.cleanupAcknowledged = await terminateInternalModalSandbox(state.data.sandboxId, Date.now() + 5000); } catch { record.cleanupAcknowledged = false; }
      }
    }
  }
}
