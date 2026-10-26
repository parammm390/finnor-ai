import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { withTenant } from "@finnor/db";
import { CapabilityEngineError, runPythonEngine } from "@finnor/tools/capabilities/python-runner";
import type { CapabilityActor, CapabilityRun } from "./contracts";
import { appendCapabilityEvent, loadCapabilitySource, loadOwnedModalHandle } from "./repository";
import { assertCurrentClaim, type CapabilityJobClaim } from "./job-claim";
import type { ProviderCheckpoint, ProviderStep } from "./provider-step";

const sandboxId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const stateSchema = z.object({ provider: z.literal("modal"), phase: z.literal("accepted"), sandboxId,
  stage: z.enum(["awaiting_input", "input_may_have_left", "executing", "terminated"]), bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
  imageId: z.string(), polls: z.number().int().min(0).max(120) }).passthrough();
const outputSchema = z.object({ schema: z.literal("finnor.modal-program-result.v1"), exitCode: z.number().int(), failure: z.string().nullable(),
  stdoutBase64: z.string().max(1_398_104), stderrBase64: z.string().max(174_764), codeSha256: z.string().regex(/^[a-f0-9]{64}$/), candidateUid: z.literal(65534), sources: z.array(z.unknown()).max(8) }).strict();

function config(cleanup = false) {
  const tokenId = process.env.MODAL_TOKEN_ID, tokenSecret = process.env.MODAL_TOKEN_SECRET, appName = process.env.FINNOR_MODAL_APP_NAME, imageId = process.env.FINNOR_MODAL_IMAGE_ID;
  if (!tokenId || !tokenSecret || !process.env.FINNOR_CAPABILITY_PYTHON || !cleanup && (process.env.FINNOR_MODAL_ENABLED !== "1" || !appName || !imageId))
    throw new CapabilityEngineError("MODAL_NOT_CONFIGURED");
  const serverUrl = process.env.FINNOR_MODAL_SERVER_URL ?? "https://api.modal.com,https://api.modal2.com";
  for (const value of serverUrl.split(",")) {
    const url = new URL(value);
    if (url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      throw new CapabilityEngineError("MODAL_ENDPOINT_REJECTED");
  }
  return { tokenId, tokenSecret, appName: appName ?? "", imageId: imageId ?? "", serverUrl };
}

/** Resource containment is bounded separately from the expired business run.
 * It can only stop the acknowledged sandbox under this still-current claim. */
export async function cleanupFailedModalRun(actor: CapabilityActor, run: CapabilityRun, claim: CapabilityJobClaim, reason: string): Promise<void> {
  if (run.kind !== "modal_execute") return;
  let state: z.infer<typeof stateSchema> | null = null;
  try {
    state = await withTenant(actor.tenantId, async db => {
      await assertCurrentClaim(db, claim, actor.tenantId);
      const selected = await db.execute(sql`SELECT remote_state FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${run.id}::uuid`);
      const parsed = stateSchema.safeParse(selected.rows[0]?.remote_state); return parsed.success ? parsed.data : null;
    }, actor.userId);
    if (!state || state.stage === "terminated" && state.terminationAcknowledged === true) return;
  } catch { return; }
  const target = state;
  if (!target) return;
  const cleanupDeadline = Date.now() + 5000;
  let acknowledged = false;
  try {
    const cleaned = await runPythonEngine("modal", { ...config(true), op: "terminate", sandboxId: target.sandboxId, deadlineAt: cleanupDeadline }, { deadlineAt: cleanupDeadline });
    acknowledged = cleaned.result.terminationAcknowledged === true;
  } catch { /* The provider TTL and bootstrap deadline remain independent bounds. */ }
  try {
    await withTenant(actor.tenantId, async db => {
      await appendCapabilityEvent(db, actor.tenantId, run.id, "PROVIDER_OBSERVED", { cleanup: { sandboxId: target.sandboxId, reason, acknowledged, cleanupDeadlineAt: new Date(cleanupDeadline).toISOString(),
        businessDeadlineExtended: false }, receipt: { jobId: claim.jobId, claimFence: claim.claimFence, claimToken: claim.claimToken, requestDigest: run.requestDigest } });
    }, actor.userId);
  } catch { /* Cleanup reporting must not replace the original terminal outcome. */ }
}

export async function executeModalStep(actor: CapabilityActor, run: CapabilityRun, checkpoint: ProviderCheckpoint): Promise<ProviderStep> {
  if (run.request.kind !== "modal_execute") throw new CapabilityEngineError("MODAL_REQUEST_KIND_INVALID");
  const credentials = config(), deadlineAt = Date.parse(run.deadlineAt), request = run.request;
  if (Buffer.byteLength(request.code) > 100_000 || Buffer.byteLength(request.stdin) > 100_000 || run.sources.reduce((size, source) => size + source.sizeBytes, 0) > 10_485_760)
    throw new CapabilityEngineError("MODAL_INPUT_TOO_LARGE");
  const invoke = (operation: Record<string, unknown>) => runPythonEngine("modal", { ...credentials, ...operation, deadlineAt }, { deadlineAt: Math.min(deadlineAt, Date.now() + 15_000) });
  let state: z.infer<typeof stateSchema>;
  if (!Object.keys(run.remoteState).length) {
    const probe = await runPythonEngine("modal", { op: "probe" }, { deadlineAt: Math.min(deadlineAt, Date.now() + 5000) });
    const identity = z.object({ bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal("1.6.2") }).parse(probe.result);
    const marker = { provider: "modal", phase: "dispatching", name: `finnor-${run.id}`, imageId: credentials.imageId, bootstrapSha256: identity.bootstrapSha256 };
    await checkpoint(marker, "PROVIDER_DISPATCH");
    let created;
    try { created = await invoke({ op: "create", runId: run.id, name: marker.name, bootstrapSha256: identity.bootstrapSha256 }); }
    catch (error) {
      if (error instanceof CapabilityEngineError && error.dispatchDisposition === "NOT_DISPATCHED") return { status: "not_dispatched", remoteState: { ...marker, phase: "not_dispatched", reason: error.code }, code: error.code };
      if (error instanceof CapabilityEngineError) return { status: "unknown", remoteState: marker, code: "MODAL_SANDBOX_CREATION_UNKNOWN" };
      throw error;
    }
    const acknowledged = z.object({ sandboxId, bootstrapSha256: z.literal(identity.bootstrapSha256), imageId: z.literal(credentials.imageId) }).parse(created.result);
    state = { provider: "modal", phase: "accepted", sandboxId: acknowledged.sandboxId, bootstrapSha256: acknowledged.bootstrapSha256, imageId: acknowledged.imageId, stage: "awaiting_input", polls: 0 };
    await checkpoint(state, "PROVIDER_ACCEPTED");
  } else {
    const saved = stateSchema.safeParse(run.remoteState);
    if (!saved.success) return { status: "unknown", remoteState: run.remoteState, code: "MODAL_SANDBOX_REQUIRES_RECONCILIATION" };
    state = saved.data;
  }
  if (state.stage === "awaiting_input") {
    const sources = []; let size = 0;
    for (const source of run.sources) {
      const bytes = await loadCapabilitySource(actor, source, deadlineAt); size += bytes.length;
      if (size > 10_485_760) throw new CapabilityEngineError("MODAL_SOURCES_TOO_LARGE");
      sources.push({ source, sha256: source.sha256, bytesBase64: bytes.toString("base64") });
    }
    state = { ...state, stage: "input_may_have_left" };
    // The durable stage precedes stdin delivery. A retry may only observe this
    // sandbox; it must never send a possibly duplicated program input again.
    await checkpoint(state, "PROVIDER_DISPATCH");
    let inputAcknowledged = false;
    try {
      await invoke({ op: "supply", sandboxId: state.sandboxId, program: { code: request.code, codeSha256: createHash("sha256").update(request.code).digest("hex"), stdin: request.stdin, sources } });
      inputAcknowledged = true;
    } catch (error) { if (!(error instanceof CapabilityEngineError) || !["ENGINE_TIMEOUT", "ENGINE_PROCESS_FAILED", "MODAL_CONTROL_OUTCOME_UNKNOWN"].includes(error.code)) throw error; }
    if (inputAcknowledged) state = { ...state, stage: "executing" };
    await checkpoint(state, "PROVIDER_ACCEPTED");
  }
  try {
    const polled = await invoke({ op: "poll", sandboxId: state.sandboxId });
    const observed = z.object({ status: z.enum(["running", "completed"]), bootstrapExitCode: z.number().int().optional(), stdout: z.string().optional(), stderr: z.string().optional(), terminationAcknowledged: z.boolean().optional() }).passthrough().parse(polled.result);
    if (observed.status === "completed") {
      let program: z.infer<typeof outputSchema> | null = null;
      try { program = outputSchema.parse(JSON.parse(observed.stdout ?? "")); } catch { /* The bootstrap can exit before receiving valid input. */ }
      if (program && program.codeSha256 !== createHash("sha256").update(request.code).digest("hex")) throw new CapabilityEngineError("MODAL_PROGRAM_IDENTITY_MISMATCH");
      await checkpoint({ ...state, stage: "terminated", terminationAcknowledged: observed.terminationAcknowledged === true }, "PROVIDER_ACCEPTED");
      return { status: "complete", result: { schema: "finnor.modal-execution.v1", sandboxId: state.sandboxId, imageId: state.imageId, bootstrapSha256: state.bootstrapSha256,
        program, executionStatus: program && program.exitCode === 0 && program.failure === null ? "PROGRAM_COMPLETED" : "PROGRAM_FAILED", bootstrapExitCode: observed.bootstrapExitCode,
        terminationAcknowledged: observed.terminationAcknowledged === true, sources: run.sources, backend: { provider: "modal", sdkVersion: "1.6.2" },
        configuredPolicy: { networkBlocked: true, memoryMiB: 512, cpus: 1, secrets: 0, volumes: 0, candidateUid: 65534, absoluteDeadlineAt: run.deadlineAt },
        qualification: "UNTRUSTED_SANDBOX_PROGRAM_OUTPUT_NOT_BUSINESS_OR_EVALUATION_AUTHORITY", executionAuthorityGranted: false } };
    }
  } catch (error) { if (!(error instanceof CapabilityEngineError) || !["ENGINE_TIMEOUT", "ENGINE_PROCESS_FAILED", "MODAL_CONTROL_OUTCOME_UNKNOWN"].includes(error.code)) throw error; }
  if (state.polls >= 120) return { status: "unknown", remoteState: state, code: "MODAL_POLL_LIMIT_REQUIRES_RECONCILIATION" };
  return { status: "waiting", remoteState: { ...state, polls: state.polls + 1 }, delayMs: 1000 };
}

export async function executeModalControlStep(actor: CapabilityActor, run: CapabilityRun, checkpoint: ProviderCheckpoint): Promise<ProviderStep> {
  const request = run.request;
  if (request.kind !== "modal_control") throw new CapabilityEngineError("MODAL_REQUEST_KIND_INVALID");
  const state = stateSchema.safeParse(await loadOwnedModalHandle(actor, request.executionRunId));
  if (!state.success) throw new CapabilityEngineError("MODAL_ACKNOWLEDGED_SANDBOX_NOT_FOUND");
  const credentials = config(), deadlineAt = Date.parse(run.deadlineAt);
  if (request.operation === "terminate" && run.remoteState.phase === "accepted" && run.remoteState.stage === "terminated")
    return { status: "complete", result: { schema: "finnor.modal-control.v1", executionRunId: request.executionRunId, operation: "terminate", observed: { sandboxId: state.data.sandboxId, terminationAcknowledged: true }, qualification: "DURABLE_PROVIDER_ACKNOWLEDGEMENT", executionAuthorityGranted: false } };
  if (request.operation === "terminate") await checkpoint({ ...state.data, phase: "dispatching", operation: "terminate", executionRunId: request.executionRunId }, "PROVIDER_DISPATCH");
  const executed = await runPythonEngine("modal", { ...credentials, op: request.operation === "terminate" ? "terminate" : "status", sandboxId: state.data.sandboxId, deadlineAt }, { deadlineAt: Math.min(deadlineAt, Date.now() + 15_000) });
  // Status controls deliberately return no program output or original source data.
  const observed = z.object({ sandboxId, status: z.string().optional(), bootstrapExitCode: z.number().int().optional(), terminationAcknowledged: z.boolean().optional() }).strip().parse(executed.result);
  if (request.operation === "terminate") await checkpoint({ ...state.data, stage: "terminated", operation: "terminate", executionRunId: request.executionRunId }, "PROVIDER_ACCEPTED");
  return { status: "complete", result: { schema: "finnor.modal-control.v1", executionRunId: request.executionRunId, operation: request.operation, observed,
    qualification: "PROVIDER_CONTROL_ACKNOWLEDGEMENT_NOT_SOURCE_READ_AUTHORITY", executionAuthorityGranted: false } };
}

export async function terminateInternalModalSandbox(id: string, deadlineAt: number): Promise<boolean> {
  const result = await runPythonEngine("modal", { ...config(true), op: "terminate", sandboxId: sandboxId.parse(id), deadlineAt }, { deadlineAt });
  return result.result.terminationAcknowledged === true;
}
