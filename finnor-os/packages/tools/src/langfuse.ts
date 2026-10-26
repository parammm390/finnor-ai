import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

/** OTLP/HTTP JSON is supported by Langfuse v4. Do not use the sunset legacy
 * ingestion API. This exporter does not install a global tracer or replace Sentry.
 * No prompts, results, tool arguments, exception messages or credentials are sent. */
interface ObservationContext { traceId: string; spanId: string }
export interface AiObservation {
  kind: "generation" | "tool" | "span";
  name: string;
  tenantId?: string;
  correlationId?: string;
  actionId?: string;
  purpose?: string;
  channel?: string;
  model?: string;
}
export interface AiObservationUsage { model?: string; inputTokens?: number | null; outputTokens?: number | null; failed?: boolean }
interface Attribute { key: string; value: { stringValue: string } | { intValue: string } }
interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string; attributes: Attribute[]; status: { code: number };
}
const context = new AsyncLocalStorage<ObservationContext>();
const pending: OtlpSpan[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sending: Promise<void> | undefined;
const stats = { exported: 0, dropped: 0, failedBatches: 0 };
const QUEUE_LIMIT = 512, BATCH_LIMIT = 64;

function configuration(): { endpoint: string; authorization: string } | null {
  if (process.env.LANGFUSE_ENABLED !== "1") return null;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY, secretKey = process.env.LANGFUSE_SECRET_KEY;
  const base = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST;
  if (!publicKey || !secretKey || !base) return null;
  try {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/public/otel/v1/traces`;
    return { endpoint: url.toString(), authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` };
  } catch { return null; }
}

export function langfuseStatus() {
  return { enabled: process.env.LANGFUSE_ENABLED === "1", configured: configuration() !== null,
    queued: pending.length, inFlight: Boolean(sending), ...stats, contentExported: false, protocol: "OTLP_HTTP_JSON_V4" };
}

function schedule(): void {
  if (timer || !pending.length) return;
  timer = setTimeout(() => { timer = undefined; void flushLangfuse(); }, 1_000);
  timer.unref();
}

/** Explicit flush is useful before a short-lived process exits. Export failure
 * stays observable in counters and never changes a business operation's result. */
export async function flushLangfuse(deadlineAt = Date.now() + 15_000): Promise<void> {
  while (sending) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([sending, new Promise<void>(done => { wait = setTimeout(done, remaining); })]); }
    finally { if (wait) clearTimeout(wait); }
  }
  const config = configuration();
  if (!config) { stats.dropped += pending.length; pending.length = 0; return; }
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (!pending.length) return;
  const snapshot = pending.splice(0, QUEUE_LIMIT);
  sending = (async () => {
    for (let offset = 0; offset < snapshot.length; offset += BATCH_LIMIT) {
    const batch = snapshot.slice(offset, offset + BATCH_LIMIT);
    if (Date.now() >= deadlineAt) { stats.dropped += snapshot.length - offset; break; }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), Math.min(1_500, Math.max(1, deadlineAt - Date.now())));
    try {
      const response = await fetch(config.endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: config.authorization, "content-type": "application/json", "x-langfuse-ingestion-version": "4" },
        body: JSON.stringify({ resourceSpans: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: "finnor-os" } }] },
          scopeSpans: [{ scope: { name: "finnor.ai-observability", version: "1" }, spans: batch }],
        }] }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("LANGFUSE_EXPORT_REJECTED"); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 65_536) throw new Error("LANGFUSE_ACKNOWLEDGEMENT_TOO_LARGE");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      const raw: unknown = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("LANGFUSE_ACKNOWLEDGEMENT_INVALID");
      const partial: unknown = "partialSuccess" in raw ? raw.partialSuccess : undefined;
      if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("LANGFUSE_PARTIAL_ACKNOWLEDGEMENT_INVALID");
      const rejected = partial && typeof partial === "object" && "rejectedSpans" in partial ? Number(partial.rejectedSpans) : 0;
      if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > batch.length) throw new Error("LANGFUSE_PARTIAL_ACKNOWLEDGEMENT_INVALID");
      stats.exported += batch.length - rejected; stats.dropped += rejected;
      if (rejected) stats.failedBatches++;
    } catch { stats.failedBatches++; stats.dropped += batch.length; }
    finally { clearTimeout(deadline); }
    }
  })();
  try { await sending; } finally { sending = undefined; schedule(); }
}

function stringAttribute(key: string, value: string | undefined): Attribute[] {
  return value === undefined ? [] : [{ key, value: { stringValue: value.slice(0, 256) } }];
}

export async function observeAiOperation<T>(meta: AiObservation, run: () => Promise<T>, usage?: () => AiObservationUsage | undefined): Promise<T> {
  if (!configuration() || !meta.tenantId) return run();
  const parent = context.getStore();
  const traceId = parent?.traceId ?? createHash("sha256")
    .update(`${meta.tenantId}:${meta.correlationId ?? meta.actionId ?? randomBytes(16).toString("hex")}`).digest("hex").slice(0, 32);
  const spanId = randomBytes(8).toString("hex"), start = Date.now();
  let failed = false, errorType: string | undefined;
  try { return await context.run({ traceId, spanId }, run); }
  catch (error) { failed = true; errorType = error instanceof Error ? error.name : "UnknownError"; throw error; }
  finally {
    // Telemetry must remain best effort even when a caller-supplied usage getter fails.
    try {
      const used = usage?.();
      const attributes: Attribute[] = [
        ...stringAttribute("langfuse.observation.type", meta.kind),
        ...stringAttribute("langfuse.session.id", meta.correlationId ?? meta.actionId),
        ...stringAttribute("langfuse.trace.name", meta.purpose ?? meta.name),
        ...stringAttribute("langfuse.trace.metadata.tenantId", meta.tenantId),
        ...stringAttribute("finnor.action.id", meta.actionId),
        ...stringAttribute("finnor.channel", meta.channel),
        ...stringAttribute("gen_ai.request.model", used?.model ?? meta.model),
        ...stringAttribute("error.type", errorType),
      ];
      for (const [key, value] of [["gen_ai.usage.input_tokens", used?.inputTokens], ["gen_ai.usage.output_tokens", used?.outputTokens]] as const)
        if (Number.isSafeInteger(value) && Number(value) >= 0) attributes.push({ key, value: { intValue: String(value) } });
      if (pending.length >= QUEUE_LIMIT) stats.dropped++;
      else pending.push({ traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}), name: meta.name.slice(0, 256), kind: 1,
        startTimeUnixNano: String(BigInt(start) * 1_000_000n), endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
        attributes, status: { code: failed || used?.failed ? 2 : 1 } });
      schedule();
    } catch { stats.dropped++; }
  }
}
