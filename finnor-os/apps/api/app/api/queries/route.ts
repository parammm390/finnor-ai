// POST /api/queries — authenticated, typed operational reads.
//
// This route never accepts natural language and never invokes the planner. The
// canonical read-model executor receives only the authenticated tenantId and
// attaches the execution to durable Work when Work context is supplied.

import { performance } from "node:perf_hooks";
import { requireContext, errorResponse } from "../../../lib/auth";
import { getOrchestrator } from "../../../lib/orchestrator";
import { validateOperationalQueryRequest, type OperationalQueryRequest } from "@finnor/orchestration";
import { recordWorkResponse } from "@finnor/db";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

// Public OpenAPI shape is intentionally flat. Rich session/channel fields stay
// internal to orchestration; accepting them here would create an undocumented
// second wire contract.
const ENVELOPE_KEYS = new Set(["workId", "idempotencyKey", "executionKey"]);

function parseRequestBody(input: unknown): {
  success: true;
  request: OperationalQueryRequest;
  options: {
    workId?: string;
    idempotencyKey?: string;
    executionKey?: string;
  };
} | { success: false; error: string } {
  if (!isRecord(input)) return { success: false, error: "A JSON object is required" };
  const directFields = Object.fromEntries(Object.entries(input).filter(([key]) => !ENVELOPE_KEYS.has(key)));
  const queryInput = directFields;
  if (input.workId !== undefined && !uuid(input.workId)) return { success: false, error: "workId must be a UUID" };
  if (input.idempotencyKey !== undefined && !boundedString(input.idempotencyKey, 200)) return { success: false, error: "idempotencyKey must be a non-empty string of at most 200 characters" };
  if (input.executionKey !== undefined && !boundedString(input.executionKey, 200)) return { success: false, error: "executionKey must be a non-empty string of at most 200 characters" };

  const parsed = validateOperationalQueryRequest(queryInput);
  if (!parsed.success) return parsed;
  return {
    success: true,
    request: parsed.request,
    options: {
      ...(typeof input.workId === "string" ? { workId: input.workId } : {}),
      ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(typeof input.executionKey === "string" ? { executionKey: input.executionKey } : {}),
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const body = parseRequestBody(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: body.error }, { status: 400, headers: { "Cache-Control": "no-store" } });

    const started = performance.now();
    const run = await getOrchestrator().handleOperationalQuery(body.request, ctx, body.options);
    const elapsedMs = Math.max(0, performance.now() - started);
    const queryDurationMs = Math.max(run.metadata.durationMs, elapsedMs);
    const response = {
      request: run.request,
      result: run.result,
      execution: run.metadata,
      workId: run.workId,
      workInputId: run.workInputId,
      instructionId: run.instructionId,
      ...(run.answer ? { answer: run.answer } : {}),
      ...(run.duplicate ? { duplicate: true } : {}),
    };
    // handleOperationalQuery's completed Work outcome is the canonical durable
    // receipt. This additive response projection gives /api/actions and retries
    // the exact same typed query payload without creating another lifecycle row.
    if (!run.duplicate) await recordWorkResponse(ctx.tenantId, run.workId, response);
    return Response.json(response, {
      status: run.duplicate ? 200 : 201,
      headers: {
        "Cache-Control": "no-store",
        "Server-Timing": `query;dur=${queryDurationMs.toFixed(1)}`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
