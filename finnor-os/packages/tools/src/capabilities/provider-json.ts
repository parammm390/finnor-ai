export type ProviderFailureDisposition = "BEFORE_DISPATCH" | "REJECTED" | "UNKNOWN";

export class CapabilityProviderError extends Error {
  constructor(readonly provider: string, readonly code: string, readonly disposition: ProviderFailureDisposition, readonly httpStatus?: number) {
    super(`${provider}:${code}`); this.name = "CapabilityProviderError";
  }
}

/** Server configuration chooses the destination and credentials. Payloads cannot
 * redirect an authenticated provider request or set transport headers. */
export class CapabilityJsonTransport {
  private readonly base: URL;
  constructor(private readonly provider: string, base: string, private readonly headers: Readonly<Record<string, string>>) {
    this.base = new URL(base);
    if (this.base.username || this.base.password || this.base.search || this.base.hash
      || this.base.protocol !== "https:" && !(this.base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)))
      throw new CapabilityProviderError(provider, "INVALID_PROVIDER_ENDPOINT", "BEFORE_DISPATCH");
  }

  async request(input: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown; form?: FormData; deadlineAt: number; maxBytes?: number; maxRequestMs?: number }): Promise<unknown> {
    const remaining = input.deadlineAt - Date.now();
    if (remaining < 1) throw new CapabilityProviderError(this.provider, "DEADLINE_EXCEEDED", "BEFORE_DISPATCH");
    const url = new URL(input.path, this.base);
    if (!input.path.startsWith("/") || input.path.startsWith("//") || url.origin !== this.base.origin)
      throw new CapabilityProviderError(this.provider, "PROVIDER_PATH_REJECTED", "BEFORE_DISPATCH");
    if (input.form && input.body !== undefined) throw new CapabilityProviderError(this.provider, "REQUEST_BODY_AMBIGUOUS", "BEFORE_DISPATCH");
    const body = input.form ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
    if (typeof body === "string" && Buffer.byteLength(body) > 1_048_576) throw new CapabilityProviderError(this.provider, "REQUEST_TOO_LARGE", "BEFORE_DISPATCH");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(remaining, input.maxRequestMs ?? 15_000, 120_000));
    let dispatched = false, status: number | undefined;
    try {
      const headers = new Headers({ ...this.headers, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) });
      dispatched = true;
      const response = await fetch(url, { method: input.method, headers, body, redirect: "error", signal: controller.signal });
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        // A server-side 5xx after a create request does not establish absence.
        const disposition = input.method === "GET" || status >= 400 && status < 500 ? "REJECTED" : "UNKNOWN";
        throw new CapabilityProviderError(this.provider, `HTTP_${status}`, disposition, status);
      }
      if (status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) throw new CapabilityProviderError(this.provider, "EMPTY_RESPONSE", input.method === "GET" ? "REJECTED" : "UNKNOWN", status);
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > (input.maxBytes ?? 8_388_608)) { await reader.cancel(); throw new Error("RESPONSE_TOO_LARGE"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof CapabilityProviderError) throw error;
      throw new CapabilityProviderError(this.provider, controller.signal.aborted ? "REQUEST_TIMEOUT" : "TRANSPORT_OR_RESPONSE_FAILED",
        dispatched ? "UNKNOWN" : "BEFORE_DISPATCH", status);
    } finally { clearTimeout(timer); }
  }
}
