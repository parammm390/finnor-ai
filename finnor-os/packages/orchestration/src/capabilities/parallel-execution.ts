import { z } from "zod";
import { ParallelResearchClient } from "@finnor/tools/parallel";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { CapabilityProviderError } from "@finnor/tools/capabilities/provider-json";
import { parallelMonitorRemoteId, type CapabilityActor, type CapabilityRun } from "./contracts";
import { readCapabilityRun } from "./repository";
import type { ProviderCheckpoint, ProviderStep } from "./provider-step";
const accepted = z.object({ provider: z.literal("parallel"), phase: z.literal("accepted"), remoteId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), polls: z.number().int().min(0).max(60) }).passthrough();

export async function executeParallelStep(run: CapabilityRun, checkpoint: ProviderCheckpoint): Promise<ProviderStep> {
  if (process.env.FINNOR_PARALLEL_ENABLED !== "1" || !process.env.PARALLEL_API_KEY)
    throw new CapabilityEngineError("PARALLEL_NOT_CONFIGURED");
  const client = new ParallelResearchClient({ apiKey: process.env.PARALLEL_API_KEY, baseUrl: process.env.FINNOR_PARALLEL_BASE_URL });
  const deadlineAt = Date.parse(run.deadlineAt), request = run.request;
  if (request.kind !== "parallel_task" && request.kind !== "parallel_find" && request.kind !== "parallel_monitor")
    throw new CapabilityEngineError("PARALLEL_REQUEST_KIND_INVALID");
  if (request.kind === "parallel_monitor" && process.env.FINNOR_PARALLEL_MONITORS_ENABLED !== "1") throw new CapabilityEngineError("PARALLEL_MONITORS_NOT_ENABLED");
  let state = accepted.safeParse(run.remoteState);
  if (!state.success) {
    if (Object.keys(run.remoteState).length) return { status: "unknown", remoteState: run.remoteState, code: "PARALLEL_SUBMISSION_REQUIRES_RECONCILIATION" };
    const dispatching = { provider: "parallel", phase: "dispatching", requestDigest: run.requestDigest, submittedAt: new Date().toISOString() };
    await checkpoint(dispatching, "PROVIDER_DISPATCH");
    let remoteId: string;
    try {
      switch (request.kind) {
        case "parallel_task": remoteId = (await client.createTask({ text: request.input, outputSchema: request.outputSchema, processor: request.processor, correlationId: run.id, deadlineAt })).run_id; break;
        case "parallel_find": remoteId = (await client.createFindAll({ objective: request.objective, entityType: request.entityType, conditions: request.matchConditions, matchLimit: request.matchLimit, generator: request.generator, correlationId: run.id, deadlineAt })).findall_id; break;
        case "parallel_monitor": remoteId = (await client.createMonitor({ query: request.query, cadence: request.cadence, correlationId: run.id, deadlineAt })).monitor_id; break;
      }
    } catch (error) {
      if (error instanceof CapabilityProviderError && error.disposition === "UNKNOWN")
        return { status: "unknown", remoteState: dispatching, code: `PARALLEL_${error.code}` };
      throw error;
    }
    const saved = { provider: "parallel" as const, phase: "accepted" as const, remoteId, polls: 0 };
    await checkpoint(saved, "PROVIDER_ACCEPTED");
    state = accepted.safeParse(saved);
  }
  if (!state.success) throw new CapabilityEngineError("PARALLEL_REMOTE_STATE_INVALID");
  const remote = state.data;
  const result = (value: Record<string, unknown>): ProviderStep => ({ status: "complete", result: {
    schema: "finnor.parallel-research.v1", remoteId: remote.remoteId, provider: "parallel", kind: request.kind, ...value,
    qualification: "UNTRUSTED_PROVIDER_RESEARCH_WITH_SOURCE_CITATIONS", canonicalTruthEstablished: false, executionAuthorityGranted: false,
  } });
  try {
    switch (request.kind) {
      case "parallel_task": {
        const observed = await client.taskStatus(remote.remoteId, deadlineAt);
        if (observed.status === "completed") return result({ research: await client.taskResult(remote.remoteId, deadlineAt) });
        if (["failed", "cancelled"].includes(observed.status)) throw new CapabilityEngineError(`PARALLEL_TASK_${observed.status.toUpperCase()}`);
        break;
      }
      case "parallel_find": {
        const observed = await client.findAllStatus(remote.remoteId, deadlineAt);
        if (!observed.status.is_active && observed.status.status === "completed") return result({ research: await client.findAllResult(remote.remoteId, deadlineAt), exhaustivenessEstablished: false });
        if (!observed.status.is_active) throw new CapabilityEngineError("PARALLEL_FIND_TERMINATED_WITHOUT_COMPLETION");
        break;
      }
      case "parallel_monitor": {
        const observed = await client.monitorStatus(remote.remoteId, deadlineAt);
        return result({ monitor: observed, lifecycle: "ACTIVE_PROVIDER_RESOURCE_REQUIRES_EXPLICIT_CANCELLATION", monitoringResultsAreNotAutomaticBusinessEvents: true });
      }
    }
  } catch (error) {
    // GET may be retried using the durable remote id. Never create a new run.
    if (!(error instanceof CapabilityProviderError) || error.disposition === "BEFORE_DISPATCH") throw error;
    await checkpoint({ ...remote, lastReadFailure: error.code }, "PROVIDER_OBSERVED");
  }
  if (remote.polls >= 60) return { status: "unknown", remoteState: remote, code: "PARALLEL_POLL_LIMIT_REQUIRES_RECONCILIATION" };
  return { status: "waiting", remoteState: { ...remote, polls: remote.polls + 1 }, delayMs: Math.min(5000, Math.max(1000, deadlineAt - Date.now())) };
}

export async function executeParallelMonitorControl(actor: CapabilityActor, run: CapabilityRun, checkpoint: ProviderCheckpoint): Promise<ProviderStep> {
  const request = run.request;
  if (request.kind !== "parallel_monitor_control") throw new CapabilityEngineError("PARALLEL_REQUEST_KIND_INVALID");
  if (process.env.FINNOR_PARALLEL_ENABLED !== "1" || !process.env.PARALLEL_API_KEY) throw new CapabilityEngineError("PARALLEL_NOT_CONFIGURED");
  const original = await readCapabilityRun(actor, request.monitorRunId);
  const remoteId = original ? parallelMonitorRemoteId(original) : null;
  if (!original || remoteId === null) throw new CapabilityEngineError("CAPABILITY_MONITOR_NOT_FOUND");
  const reference = { remoteId };
  const client = new ParallelResearchClient({ apiKey: process.env.PARALLEL_API_KEY, baseUrl: process.env.FINNOR_PARALLEL_BASE_URL }), deadlineAt = Date.parse(run.deadlineAt);
  let observed: unknown;
  switch (request.operation) {
    case "status": observed = await client.monitorStatus(reference.remoteId, deadlineAt); break;
    case "events":
      observed = await client.monitorEvents(reference.remoteId, request.eventGroupId, deadlineAt); break;
    case "cancel": {
      if (run.remoteState.phase !== "accepted") {
        const state = { provider: "parallel", phase: "dispatching", remoteId: reference.remoteId, operation: "cancel", monitorRunId: original.id };
        await checkpoint(state, "PROVIDER_DISPATCH");
        try { await client.cancelMonitor(reference.remoteId, deadlineAt); }
        catch (error) {
          if (error instanceof CapabilityProviderError && error.disposition === "UNKNOWN") return { status: "unknown", remoteState: state, code: "PARALLEL_MONITOR_CANCELLATION_UNKNOWN" };
          throw error;
        }
        await checkpoint({ ...state, phase: "accepted" }, "PROVIDER_ACCEPTED");
      }
      observed = { providerAcknowledgedCancellation: true }; break;
    }
  }
  return { status: "complete", result: { schema: "finnor.parallel-monitor-control.v1", monitorRunId: original.id, remoteId: reference.remoteId,
    operation: request.operation, observed, qualification: "PROVIDER_OBSERVATION_NOT_AUTOMATIC_BUSINESS_EFFECT", executionAuthorityGranted: false } };
}
