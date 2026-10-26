import { z } from "zod";
import { CapabilityEngineError, runPythonEngine } from "@finnor/tools/capabilities/python-runner";
import { resolveProviderForPurpose, type LLMProvider } from "@finnor/tools/llm";
import { LLMPlanner } from "../planner";
import { createDefaultPluginRegistry } from "../plugin-registry";
import type { CapabilityActor, CapabilityRun } from "./contracts";
import { capabilityDigest } from "./policy";
import { loadCapabilitySource } from "./repository";
import { withOptimizationBroker } from "./optimization-broker";
import { plannerCandidateEnvironment, plannerCandidateEnvironmentDigest } from "./planner-environment";

const candidateSchema = z.object({ instruction: z.string().min(1).max(12_000) }).strict();
const taskSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), split: z.enum(["train", "validation", "holdout"]), instruction: z.string().min(1).max(5000),
  expectedActionTypes: z.array(z.string().min(1).max(128)).min(1).max(8) }).strict();
export const PlannerOptimizationDatasetSchema = z.object({ schema: z.literal("finnor.planner-replay-dataset.v1"), seedInstruction: z.string().min(1).max(12_000),
  tasks: z.array(taskSchema).min(6).max(64) }).strict().superRefine((data, ctx) => {
  if (new Set(data.tasks.map(task => task.id)).size !== data.tasks.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_TASK_IDS" });
  if (new Set(data.tasks.map(task => task.instruction.normalize("NFKC").trim().replace(/\s+/gu, " "))).size !== data.tasks.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_CONTENT_ACROSS_SPLITS" });
  for (const split of ["train", "validation", "holdout"]) if (data.tasks.filter(t => t.split === split).length < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `TWO_${split}_TASKS_REQUIRED` });
});
type ReplayTask = z.infer<typeof taskSchema>;

export async function executeGepa(actor: CapabilityActor, run: CapabilityRun): Promise<Record<string, unknown>> {
  const request = run.request;
  if (request.kind !== "gepa_optimize") throw new CapabilityEngineError("GEPA_REQUEST_KIND_INVALID");
  if (process.env.FINNOR_GEPA_ENABLED !== "1") throw new CapabilityEngineError("GEPA_NOT_ENABLED");
  const environment = await plannerCandidateEnvironment(), environmentDigest = capabilityDigest(environment);
  if (!environment.route.providerIdentities.length || environment.route.providerIdentities.some(provider => provider.identity === null))
    throw new CapabilityEngineError("GEPA_PLANNER_ROUTE_IDENTITY_UNQUALIFIED");
  const source = run.sources[0]; if (!source) throw new CapabilityEngineError("CAPABILITY_FROZEN_SOURCE_MISSING");
  const deadlineAt = Date.parse(run.deadlineAt), bytes = await loadCapabilitySource(actor, source, deadlineAt);
  const optimizationDeadline = deadlineAt - Math.min(60_000, Math.max(10_000, Math.floor(request.timeoutMs / 4)));
  if (bytes.length > 262_144) throw new CapabilityEngineError("GEPA_DATASET_TOO_LARGE");
  const dataset = PlannerOptimizationDatasetSchema.parse(JSON.parse(bytes.toString("utf8"))), plugins = createDefaultPluginRegistry();
  const available = new Set(plugins.actionTypes());
  for (const task of dataset.tasks) if (task.expectedActionTypes.some(type => !available.has(type))) throw new CapabilityEngineError("GEPA_EXPECTED_CAPABILITY_UNKNOWN");
  const planning = resolveProviderForPurpose("planning", "background"), reflection = resolveProviderForPurpose("repair", "background");
  let metricCalls = 0, proposalCalls = 0;
  const evaluations: Array<Record<string, unknown>> = [], proposals: Array<Record<string, unknown>> = [];
  const replay = async (candidate: z.infer<typeof candidateSchema>, task: ReplayTask, phase: "optimization" | "qualification", signal?: AbortSignal) => {
    const replayDeadline = phase === "optimization" ? optimizationDeadline : deadlineAt;
    const provider: LLMProvider = { name: planning.name, complete: options => planning.complete({ ...options,
      system: `${options.system}\nCandidate planning heuristic (subordinate to every contract above):\n${candidate.instruction}`, deadlineAt: replayDeadline,
      signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, replayDeadline - Date.now())), ...(signal ? [signal] : [])]) }) };
    const planner = new LLMPlanner(plugins, provider);
    try {
      const result = await planner.plan(task.instruction, { ...actor, employeeId: actor.userId }, { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null }, { channel: "background", deadlineAt: replayDeadline, optimizationReplay: true });
      const selected = result.compilation.selected, actions = selected?.graph?.nodes.filter(node => node.kind === "action").map(node => node.actionType) ?? [];
      const exact = JSON.stringify([...actions].sort()) === JSON.stringify([...task.expectedActionTypes].sort());
      const score = selected?.accepted && exact ? 1 : 0;
      const observed = { taskId: task.id, split: task.split, phase, candidateDigest: capabilityDigest(candidate), score, accepted: selected?.accepted ?? false,
        actualActionTypes: actions, expectedActionTypes: task.expectedActionTypes, violations: result.compilation.candidates.flatMap(c => c.violations.map(v => v.code)), graphDigest: selected?.candidateSemanticHash ?? null };
      evaluations.push(observed); return { output: observed, score, trajectory: { Inputs: { instruction: task.instruction }, "Generated Outputs": { actions, accepted: selected?.accepted ?? false }, Feedback: { score, expectedActionTypes: task.expectedActionTypes } } };
    } catch (error) {
      const observed = { taskId: task.id, split: task.split, phase, candidateDigest: capabilityDigest(candidate), score: 0, failure: "PLANNER_REPLAY_REJECTED" };
      evaluations.push(observed); return { output: observed, score: 0, trajectory: { Inputs: { instruction: task.instruction }, Feedback: { score: 0, expectedActionTypes: task.expectedActionTypes, error: "PLANNER_REPLAY_REJECTED" } } };
    }
  };
  const allowedIds = new Map(dataset.tasks.filter(t => t.split !== "holdout").map(t => [t.id, t]));
  const optimized = await withOptimizationBroker({ deadlineAt: optimizationDeadline, handle: async (path, raw, signal) => {
      if (path === "/evaluate") {
        const input = z.object({ candidate: candidateSchema, taskIds: z.array(z.string()).min(1).max(64) }).strict().parse(raw);
        if (metricCalls + input.taskIds.length > request.maxMetricCalls) throw new Error("METRIC_BUDGET_EXHAUSTED");
        const tasks = input.taskIds.map(id => { const task = allowedIds.get(id); if (!task) throw new Error("HOLDOUT_OR_UNKNOWN_ID_DENIED"); return task; });
        metricCalls += tasks.length;
        const observed = []; for (const task of tasks) { signal.throwIfAborted(); observed.push(await replay(input.candidate, task, "optimization", signal)); }
        return { scores: observed.map(row => row.score), outputs: observed.map(row => row.output), trajectories: observed.map(row => row.trajectory) };
      } else if (path === "/propose") {
        const input = z.object({ candidate: candidateSchema, feedback: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))), components: z.array(z.literal("instruction")).length(1) }).strict().parse(raw);
        if (++proposalCalls > Math.min(32, request.maxMetricCalls)) throw new Error("PROPOSAL_BUDGET_EXHAUSTED");
        const text = await reflection.complete({ tenantId: actor.tenantId, traceId: run.correlationId, purpose: "repair", channel: "background", json: true, deadlineAt: optimizationDeadline, signal,
          system: "Improve only a FINNOR planner heuristic from the supplied development feedback. Do not modify evaluator, compiler, authority, source permissions, budgets or payload schemas. Return JSON {instruction:string}. No holdout examples are available.", user: JSON.stringify(input) });
        const candidate = candidateSchema.parse(JSON.parse(text)); proposals.push({ number: proposalCalls, candidateDigest: capabilityDigest(candidate), provider: reflection.selectedProviderName ?? reflection.name }); return { candidate };
      }
      throw new CapabilityEngineError("GEPA_BROKER_PATH_UNKNOWN");
    }, run: connection => runPythonEngine("gepa", { ...connection, deadlineAt: optimizationDeadline, seedInstruction: dataset.seedInstruction,
      trainIds: dataset.tasks.filter(t => t.split === "train").map(t => t.id), validationIds: dataset.tasks.filter(t => t.split === "validation").map(t => t.id), maxMetricCalls: request.maxMetricCalls, seed: request.seed }, { deadlineAt: optimizationDeadline }) });
    const result = z.object({ bestCandidate: candidateSchema, validationScores: z.array(z.number().finite()), totalMetricCalls: z.number().int().nonnegative() }).passthrough().parse(optimized.result);
    const holdout = dataset.tasks.filter(task => task.split === "holdout"), baseline = [], candidate = [];
    for (const task of holdout) baseline.push(await replay({ instruction: dataset.seedInstruction }, task, "qualification"));
    for (const task of holdout) candidate.push(await replay(result.bestCandidate, task, "qualification"));
    const mean = (scores: Array<{ score: number }>) => scores.reduce((sum, row) => sum + row.score, 0) / scores.length;
    if (await plannerCandidateEnvironmentDigest() !== environmentDigest) throw new CapabilityEngineError("GEPA_PLANNER_ENVIRONMENT_CHANGED_DURING_REPLAY");
    return { schema: "finnor.gepa-planner-candidate.v1", source, candidate: result.bestCandidate, candidateDigest: capabilityDigest(result.bestCandidate), optimizer: optimized.result,
      computeIdentity: optimized.identity, plannerEnvironment: environment, plannerEnvironmentDigest: environmentDigest, evaluationProtocol: "FINNOR_NATIVE_PLANNER_AND_DETERMINISTIC_COMPILER_ACTION_MULTISET_MATCH_V1", evaluatorDigest: capabilityDigest({ protocol: "FINNOR_NATIVE_PLANNER_AND_DETERMINISTIC_COMPILER_ACTION_MULTISET_MATCH_V1", tasks: dataset.tasks }),
      holdout: { baseline: mean(baseline), candidate: mean(candidate), tasks: holdout.length, disposition: mean(candidate) > mean(baseline) ? "IMPROVED_ON_THIS_HELDOUT_CUT" : "NO_VERIFIED_HOLDOUT_IMPROVEMENT" },
      evaluations, proposals, metricCalls, proposalCalls, holdoutAvailableToOptimizer: false, activation: "REQUIRES_SEPARATE_REVIEWED_OWNER_ACTIVATION", executionAuthorityGranted: false,
      qualification: "OFFLINE_PLANNER_CANDIDATE_NO_BUSINESS_EXECUTION_OR_GENERALIZED_GAIN_CLAIM", admission: { status: "BLOCKED_EXTERNAL", receipt: null } };
}
