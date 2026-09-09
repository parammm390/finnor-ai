import type { MicrosoftGraphAuthContext } from "@finnor/security";
import { randomUUID } from "node:crypto";
import { acquireMicrosoftGraphAccessToken, clearMicrosoftGraphTokenCache } from "./auth";
import { MicrosoftGraphError, retryAfterMilliseconds } from "./errors";
import {
  MICROSOFT_GRAPH_HOST,
  type MicrosoftGraphLogger,
} from "./types";

const JSON_TYPES = ["application/json"];

export interface MicrosoftGraphRequest {
  operation: string;
  pathOrUrl: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: Readonly<Record<string, unknown>>;
  rawBody?: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowedOpaquePath?: (url: URL) => boolean;
}

export interface MicrosoftGraphResponse<T> {
  value: T;
  status: number;
  requestId?: string;
  clientRequestId: string;
  headers: Headers;
}

interface SentGraphResponse {
  response: Response;
  clientRequestId: string;
}

function validatedUrl(input: MicrosoftGraphRequest): URL {
  let url: URL;
  if (/^https?:/i.test(input.pathOrUrl)) {
    try { url = new URL(input.pathOrUrl); } catch {
      throw new MicrosoftGraphError("blocked_config", "Stored Microsoft Graph cursor URL is invalid", null, false);
    }
    if (url.protocol !== "https:" || url.hostname !== MICROSOFT_GRAPH_HOST || url.port || url.username || url.password) {
      throw new MicrosoftGraphError("blocked_config", "Stored Microsoft Graph cursor URL is outside the allowed host", null, false);
    }
  } else {
    if (!input.pathOrUrl.startsWith("/")) throw new MicrosoftGraphError("blocked_config", "Microsoft Graph path must be absolute", null, false);
    url = new URL(`/v1.0${input.pathOrUrl}`, `https://${MICROSOFT_GRAPH_HOST}`);
  }
  if (!url.pathname.toLowerCase().startsWith("/v1.0/") || url.pathname.toLowerCase().includes("/beta/")) {
    throw new MicrosoftGraphError("blocked_config", "Only Microsoft Graph v1.0 URLs are allowed", null, false);
  }
  if (input.allowedOpaquePath && !input.allowedOpaquePath(url)) {
    throw new MicrosoftGraphError("blocked_config", "Stored Microsoft Graph cursor does not match its configured resource family", null, false);
  }
  return url;
}

function controlledHeaders(request: MicrosoftGraphRequest, token: string, clientRequestId: string): Headers {
  if (request.body && request.rawBody) {
    throw new MicrosoftGraphError("blocked_config", "Microsoft Graph request cannot contain JSON and binary bodies together", null, false);
  }
  const headers = new Headers(request.headers);
  for (const forbidden of ["authorization", "host", "cookie", "client-request-id", "return-client-request-id"]) {
    if (headers.has(forbidden)) {
      throw new MicrosoftGraphError("blocked_config", `Microsoft Graph caller cannot override the ${forbidden} header`, null, false);
    }
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", headers.get("accept") ?? "application/json");
  headers.set("client-request-id", clientRequestId);
  headers.set("return-client-request-id", "true");
  if (request.body) headers.set("content-type", "application/json");
  return headers;
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph response exceeded the configured size bound", response.status, false);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new MicrosoftGraphError("invalid_response", "Microsoft Graph response exceeded the configured size bound", response.status, false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function jsonObject(bytes: Uint8Array, status: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph returned malformed JSON", status, false);
  }
}

function nestedObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function graphFailure(response: Response, bytes: Uint8Array): MicrosoftGraphError {
  let body: Record<string, unknown> = {};
  try { body = jsonObject(bytes, response.status); } catch { body = {}; }
  const providerError = nestedObject(body.error);
  let inner = nestedObject(providerError.innerError ?? providerError.innererror);
  let innerCode = typeof inner.code === "string" ? inner.code : undefined;
  for (let depth = 0; depth < 4 && !innerCode; depth += 1) {
    inner = nestedObject(inner.innerError ?? inner.innererror);
    innerCode = typeof inner.code === "string" ? inner.code : undefined;
  }
  const providerCode = typeof providerError.code === "string" ? providerError.code : undefined;
  const requestId = response.headers.get("request-id") ?? response.headers.get("x-ms-request-id") ?? undefined;
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
  if (response.status === 401) return new MicrosoftGraphError("auth", "Microsoft Graph rejected the app-only token", 401, false, undefined, providerCode, innerCode, requestId);
  if (response.status === 403) return new MicrosoftGraphError("permission", "Microsoft Graph denied effective resource access", 403, false, undefined, providerCode, innerCode, requestId);
  if (response.status === 404) return new MicrosoftGraphError("not_found", "Microsoft Graph resource was not found; deletion is not yet proven", 404, false, undefined, providerCode, innerCode, requestId);
  if (response.status === 409 || response.status === 412) return new MicrosoftGraphError("conflict", "Microsoft Graph rejected a stale or conflicting file write", response.status, false, undefined, providerCode, innerCode, requestId);
  if (response.status === 410) {
    const location = response.headers.get("location") ?? undefined;
    return new MicrosoftGraphError("resync_required", "Microsoft Graph requires provider-directed resynchronization", 410, false, undefined, providerCode, innerCode, requestId, location);
  }
  if (response.status === 429) return new MicrosoftGraphError("throttled", "Microsoft Graph throttled the request", 429, true, retryAfterMs, providerCode, innerCode, requestId);
  if (response.status >= 500) return new MicrosoftGraphError("provider_down", "Microsoft Graph is temporarily unavailable", response.status, true, retryAfterMs, providerCode, innerCode, requestId);
  return new MicrosoftGraphError("invalid_response", "Microsoft Graph rejected the request", response.status, false, undefined, providerCode, innerCode, requestId);
}

export class MicrosoftGraphClient {
  constructor(
    private readonly auth: MicrosoftGraphAuthContext,
    private readonly options: { fetch?: typeof fetch; logger?: MicrosoftGraphLogger } = {},
  ) {}

  invalidateToken(): void {
    clearMicrosoftGraphTokenCache(this.auth.cacheKey);
  }

  private async send(request: MicrosoftGraphRequest, refreshAttempted: boolean): Promise<SentGraphResponse> {
    const url = validatedUrl(request);
    const method = request.method ?? "GET";
    const clientRequestId = randomUUID();
    const token = await acquireMicrosoftGraphAccessToken(this.auth, refreshAttempted);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(request.timeoutMs ?? 20_000, 1_000), 60_000));
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method,
        signal: controller.signal,
        redirect: "manual",
        headers: controlledHeaders(request, token.accessToken, clientRequestId),
        ...(request.body ? { body: JSON.stringify(request.body) } : request.rawBody ? { body: new Uint8Array(request.rawBody) } : {}),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new MicrosoftGraphError("provider_down", timedOut ? "Microsoft Graph request timed out" : "Microsoft Graph network request failed", null, true);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
    const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
    this.options.logger?.({
      operation: request.operation,
      status: response.status,
      durationMs: Date.now() - started,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(response.headers.get("request-id") ? { requestId: response.headers.get("request-id")! } : {}),
      clientRequestId,
    });
    if (response.status === 401 && !refreshAttempted) {
      await response.body?.cancel().catch(() => undefined);
      this.invalidateToken();
      return this.send(request, true);
    }
    return { response, clientRequestId };
  }

  async requestJson<T extends Record<string, unknown>>(request: MicrosoftGraphRequest): Promise<MicrosoftGraphResponse<T>> {
    const { response, clientRequestId } = await this.send(request, false);
    const bytes = await boundedBytes(response, request.maxResponseBytes ?? 1_048_576);
    if (!response.ok) throw graphFailure(response, bytes);
    if (response.status === 204 || (response.status === 202 && bytes.length === 0)) {
      return { value: {} as T, status: response.status, clientRequestId, headers: response.headers };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!JSON_TYPES.some((expected) => contentType.includes(expected))) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph response content type was not JSON", response.status, false);
    }
    return {
      value: jsonObject(bytes, response.status) as T,
      status: response.status,
      requestId: response.headers.get("request-id") ?? response.headers.get("x-ms-request-id") ?? undefined,
      clientRequestId,
      headers: response.headers,
    };
  }

  async requestText(request: MicrosoftGraphRequest & { acceptedContentTypes: readonly string[] }): Promise<MicrosoftGraphResponse<string>> {
    const { response, clientRequestId } = await this.send({ ...request, headers: { accept: request.acceptedContentTypes.join(", "), ...request.headers } }, false);
    const bytes = await boundedBytes(response, request.maxResponseBytes ?? 2_097_152);
    if (!response.ok) throw graphFailure(response, bytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!request.acceptedContentTypes.some((expected) => contentType.includes(expected.toLowerCase()))) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph transcript response content type was not allowed", response.status, false);
    }
    return {
      value: new TextDecoder().decode(bytes),
      status: response.status,
      requestId: response.headers.get("request-id") ?? response.headers.get("x-ms-request-id") ?? undefined,
      clientRequestId,
      headers: response.headers,
    };
  }

  /** Download Graph content while keeping the bearer token off the short-lived
   * preauthenticated CDN URL returned by DriveItem content endpoints. */
  async requestBytes(request: MicrosoftGraphRequest & { acceptedContentTypes?: readonly string[] }): Promise<MicrosoftGraphResponse<Uint8Array>> {
    const { response: graphResponse, clientRequestId } = await this.send(request, false);
    let response = graphResponse;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new MicrosoftGraphError("invalid_response", "Microsoft Graph content redirect omitted Location", response.status, false);
      response = await this.fetchPreauthenticated(location, request.timeoutMs ?? 20_000, request.signal);
    }
    const bytes = await boundedBytes(response, request.maxResponseBytes ?? 10_485_760);
    if (!response.ok) throw graphFailure(response, bytes);
    const allowed = request.acceptedContentTypes ?? [];
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (allowed.length && !allowed.some((expected) => contentType.includes(expected.toLowerCase()))) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph file response content type was not allowed", response.status, false);
    }
    return {
      value: bytes,
      status: response.status,
      requestId: response.headers.get("request-id") ?? response.headers.get("x-ms-request-id") ?? undefined,
      clientRequestId,
      headers: response.headers,
    };
  }

  /** Upload-session URLs are opaque, short-lived provider capabilities. They must
   * never receive the Graph bearer token. */
  async putUploadChunk(input: {
    operation: string;
    uploadUrl: string;
    bytes: Uint8Array;
    start: number;
    total: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<MicrosoftGraphResponse<Record<string, unknown>>> {
    if (input.bytes.byteLength === 0 || input.start < 0 || input.total <= 0 || input.start + input.bytes.byteLength > input.total) {
      throw new MicrosoftGraphError("blocked_config", "Upload chunk range is invalid", null, false);
    }
    let url = preauthenticatedUrl(input.uploadUrl);
    const clientRequestId = randomUUID();
    let response: Response | undefined;
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(input.timeoutMs ?? 60_000, 1_000), 120_000));
      const onAbort = () => controller.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        response = await (this.options.fetch ?? fetch)(url, {
          method: "PUT",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-length": String(input.bytes.byteLength),
            "content-range": `bytes ${input.start}-${input.start + input.bytes.byteLength - 1}/${input.total}`,
          },
          body: new Uint8Array(input.bytes),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new MicrosoftGraphError("provider_down", timedOut ? "Microsoft upload chunk timed out" : "Microsoft upload chunk failed", null, true);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new MicrosoftGraphError("invalid_response", "Microsoft upload redirect omitted Location", response.status, false);
      url = preauthenticatedUrl(new URL(location, url).toString());
      response = undefined;
    }
    if (!response) throw new MicrosoftGraphError("invalid_response", "Microsoft upload exceeded the redirect bound", null, false);
    const bytes = await boundedBytes(response, 1_048_576);
    if (!response.ok) throw graphFailure(response, bytes);
    const value = bytes.byteLength ? jsonObject(bytes, response.status) : {};
    this.options.logger?.({ operation: input.operation, status: response.status, durationMs: 0, clientRequestId });
    return { value, status: response.status, clientRequestId, headers: response.headers };
  }

  private async fetchPreauthenticated(location: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    let url = preauthenticatedUrl(location);
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1_000), 60_000));
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(url, { method: "GET", redirect: "manual", signal: controller.signal });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new MicrosoftGraphError("provider_down", timedOut ? "Microsoft content download timed out" : "Microsoft content download failed", null, true);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const next = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!next) throw new MicrosoftGraphError("invalid_response", "Microsoft content redirect omitted Location", response.status, false);
      url = preauthenticatedUrl(new URL(next, url).toString());
    }
    throw new MicrosoftGraphError("invalid_response", "Microsoft content download exceeded the redirect bound", null, false);
  }
}

function preauthenticatedUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch {
    throw new MicrosoftGraphError("invalid_response", "Microsoft returned an invalid preauthenticated URL", null, false);
  }
  const host = url.hostname.toLowerCase();
  const privateIpv4 = /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  const privateIpv6 = host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  if (url.protocol !== "https:" || url.username || url.password || url.port || host === "localhost" || host.endsWith(".local") || privateIpv4 || privateIpv6) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft preauthenticated URL failed transport validation", null, false);
  }
  return url;
}
