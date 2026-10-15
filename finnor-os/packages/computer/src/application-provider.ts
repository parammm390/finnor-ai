import { createHash } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ComputerProviderCapability, ExperimentRef, ScopedApplicationIdentity } from "@finnor/shared-types";
import type {
  ApplicationPhysicalEgressFence, AuthorizedApplicationProfile, NativeApplicationRequestIdentity,
  PreparedApplicationWire,
} from "../../private-equity/src/application-semantics/ports";
import { canonical } from "../../governed-execution/src/protocol";
import { normalizeOrigin } from "./origins";
import { ComputerProviderError, type ComputerProvider, type ComputerProviderSession, type ComputerSessionRequest } from "./contracts";
import { parsePassiveApplicationDocument, passiveFormWire } from "./application-passive-document";

/**
 * Private, bounded application transport. This is NOT a ComputerRunner WRITE
 * implementation, an admission decision, a planner, or a receipt producer.
 *
 * Pre-code failure contract: unauthorized/expired resources, redirects, implicit
 * requests, oversized sources, ambiguous forms, substituted/reused permits and
 * response loss fail closed. A response, including a 2xx, is never completion.
 */
export class ApplicationProviderFault extends Error {
  constructor(readonly code: string) { super(code); this.name = "ApplicationProviderFault"; }
}

export function applicationProviderFault(code: string): never { throw new ApplicationProviderFault(code); }
const MAX_BYTES = 32 * 1024;
const MAX_OBSERVATIONS = 256;
const MAX_INTERACTIONS = 64;
const VERSION = "application-operation-v1";
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
export const applicationByteDigest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const applicationContentRef = (kind: string, body: unknown): ExperimentRef => {
  const contentDigest = applicationByteDigest(canonical(body));
  return { owner: "COMPUTER", id: `${kind}:${contentDigest}`, version: VERSION, contentDigest };
};
export type ApplicationSourceRetainer = (ref: ExperimentRef, body: unknown) => Promise<void>;
export interface ApplicationReadFence {
  beforeRead(input: { kind: "documentation" | "context" | "record" | "request" | "entrypoint";
    url: string; identity: NativeApplicationRequestIdentity | null }): Promise<void>;
  afterRead(input: { kind: string; resourceDigest: string; status: number | null;
    bytes: number | null; wallMs: number; outcome: "RESPONSE" | "UNAVAILABLE" }): Promise<void>;
}
export interface ApplicationSessionOptions {
  browserEndpoint?: string;
  documentTransport?: "PASSIVE_HTML" | "OWNED_BROWSER";
  readFence?: ApplicationReadFence;
}

export interface ApplicationPublicSource {
  ref: ExperimentRef;
  status: number;
  contentType: string | null;
  text: string;
}
export interface ApplicationFormControl {
  name: string;
  label: string | null;
  kind: string;
  value: string;
  required: boolean;
  disabled: boolean;
  pattern: string | null;
  maxLength: number | null;
  options: string[];
}
export interface ApplicationDocumentForm {
  index: number;
  label: string;
  method: string;
  action: string;
  encoding: string;
  target: string;
  overrides: boolean;
  controls: ApplicationFormControl[];
}
export interface ApplicationDocument {
  source: ApplicationPublicSource;
  url: string;
  transport: "PASSIVE_HTML" | "OWNED_BROWSER";
  forms: ApplicationDocumentForm[];
  descriptions: Array<{ label: string | null; entries: Array<{ name: string; value: string }> }>;
}
interface HttpResult {
  status: number;
  contentType: string | null;
  bytes: Buffer;
  headers: Record<string, string>;
}
interface PreparedHandle {
  digest: string;
  consumed: boolean;
  page: Page | null;
  formIndex: number | null;
  controls: Record<string, string> | null;
  passiveDocument: ApplicationDocument | null;
}
interface ReadPermit {
  url: string;
  kind: "entrypoint" | "record" | "request";
  identity: NativeApplicationRequestIdentity | null;
  consumed: boolean;
  result: HttpResult | null;
  failure: ApplicationProviderFault | null;
}
interface MutationPermit {
  wire: PreparedApplicationWire;
  handle: PreparedHandle;
  fence: ApplicationPhysicalEgressFence;
  consumed: boolean;
  result: HttpResult | null;
  possibleEgress: boolean;
  failure: ApplicationProviderFault | null;
}

/** Only transport placeholders from the closed, native-scoped envelope. */
export function applicationResourcePath(
  template: string, profile: AuthorizedApplicationProfile, target?: ScopedApplicationIdentity,
  identity?: NativeApplicationRequestIdentity,
): string {
  const replacements: Record<string, string | undefined> = {
    account: profile.account, accountId: profile.account,
    record: target?.id, recordId: target?.id,
    request: identity?.requestId, requestId: identity?.requestId,
  };
  return template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    const value = replacements[key];
    if (!value) return applicationProviderFault("X2_UNSUPPORTED_RESOURCE_PLACEHOLDER");
    return encodeURIComponent(value);
  });
}

const attachments = new Map<string, Promise<Browser>>();
async function attach(endpoint: string): Promise<Browser> {
  let pending = attachments.get(endpoint);
  if (!pending) {
    pending = chromium.connectOverCDP(endpoint, { timeout: 5000 });
    attachments.set(endpoint, pending);
    pending.catch(() => attachments.delete(endpoint));
  }
  try { return await pending; }
  catch { return applicationProviderFault("X2_BROWSER_ATTACHMENT_UNAVAILABLE"); }
}

export class ApplicationComputerProvider implements ComputerProvider {
  readonly name = "bounded-application";
  // Registerable by ComputerBroker without admitting any generic BROWSER
  // capability. Only native owners possess the scoped application overload.
  readonly capabilities: ReadonlySet<ComputerProviderCapability> = new Set();
  createSession(request: ComputerSessionRequest): Promise<ComputerProviderSession>;
  createSession(
    profile: AuthorizedApplicationProfile, retain: ApplicationSourceRetainer,
    options?: ApplicationSessionOptions,
  ): ApplicationComputerSession;
  createSession(
    input: AuthorizedApplicationProfile | ComputerSessionRequest, retain?: ApplicationSourceRetainer,
    options: ApplicationSessionOptions = {},
  ): ApplicationComputerSession | Promise<ComputerProviderSession> {
    if (!retain || !("sourceContract" in input)) {
      return Promise.reject(new ComputerProviderError("capability_unavailable", "A native authorized application profile and physical fence are required"));
    }
    return new ApplicationComputerSession(input, retain, options);
  }
  async observe(): Promise<never> { throw new ComputerProviderError("capability_unavailable", "Generic browser observation is not admitted"); }
  async perform(): Promise<never> { throw new ComputerProviderError("capability_unavailable", "Generic browser primitives are not admitted"); }
  async cost() { return { creditsUsed: null }; } // UNKNOWN, never zero.
  async release(): Promise<never> { throw new ComputerProviderError("session_lost", "No generic browser session is owned"); }
}

export class ApplicationComputerSession {
  private readonly profile: AuthorizedApplicationProfile;
  private readonly origin: string;
  private readonly handles = new WeakMap<PreparedApplicationWire, PreparedHandle>();
  private readonly usedIdentityParts = new Set<string>();
  private readonly pages = new Set<Page>();
  private readonly documentPages = new WeakMap<ApplicationDocument, Page>();
  private readonly passiveDocuments = new WeakMap<ApplicationDocument, string>();
  private readonly retainedSources = new WeakMap<ApplicationPublicSource, { kind: string; url: string; digest: string }>();
  private readonly activeRequests = new Set<ClientRequest>();
  private pendingWire: PreparedApplicationWire | null = null;
  private context: BrowserContext | null = null;
  private contextPromise: Promise<BrowserContext> | null = null;
  private closed = false;
  private observations = 0;
  private interactions = 0;
  private responseLost = false;
  private readPermit: ReadPermit | null = null;
  private mutationPermit: MutationPermit | null = null;
  private browserBusy = false;
  private executing = false;

  constructor(
    profile: AuthorizedApplicationProfile, private readonly retain: ApplicationSourceRetainer,
    private readonly options: ApplicationSessionOptions = {},
  ) {
    this.profile = structuredClone(profile);
    this.origin = (() => {
      try { return normalizeOrigin(profile.origin); }
      catch { return applicationProviderFault("X2_INVALID_APPROVED_ORIGIN"); }
    })();
    if (profile.origin !== this.origin || profile.sourceContract !== "BOUNDED_CONDITIONAL_APPLICATION_V1"
      || profile.protectionDomain !== "DISPOSABLE_TEST_AUTHORITY") {
      applicationProviderFault("X2_UNSUPPORTED_APPLICATION_AUTHORITY");
    }
    if (!profile.allowedTargets.length || profile.allowedTargets.length > 16
      || new Set(profile.allowedTargets).size !== profile.allowedTargets.length) {
      applicationProviderFault("X2_TARGET_BOUND_OR_AMBIGUITY");
    }
    for (const value of [profile.id, profile.tenantId, profile.principalId, profile.application,
      profile.account, profile.actingPrincipal, profile.role, ...profile.allowedTargets]) {
      if (typeof value !== "string" || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) {
        applicationProviderFault("X2_INVALID_APPROVED_SCOPE");
      }
    }
    if (profile.documentationPaths.length > 16) applicationProviderFault("X2_DOCUMENTATION_BOUND");
    for (const path of [profile.entrypoint, profile.recordPathTemplate, ...profile.documentationPaths,
      ...(profile.contextPath ? [profile.contextPath] : []),
      ...(profile.requestPathTemplate ? [profile.requestPathTemplate] : [])]) this.checkTemplate(path);
    for (const [name, value] of Object.entries(profile.credentials.headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n\x00]/.test(value) || value.length > 8192
        || ["host", "origin", "content-length", "content-type", "connection", "transfer-encoding"]
          .includes(name.toLowerCase())) applicationProviderFault("X2_INVALID_PRIVATE_AUTH_BINDING");
    }
    this.assertCurrent();
  }

  assertCurrent(target?: ScopedApplicationIdentity, identity?: NativeApplicationRequestIdentity): void {
    if (this.closed) applicationProviderFault("X2_APPLICATION_SESSION_CLOSED");
    const end = Date.parse(this.profile.validUntil);
    if (!Number.isFinite(end) || end <= Date.now()) applicationProviderFault("X2_APPROVED_PROFILE_EXPIRED");
    if (target && (target.kind !== "identity" || target.application !== this.profile.application
      || target.account !== this.profile.account || !this.profile.allowedTargets.includes(target.id))) {
      applicationProviderFault("X2_TARGET_OUTSIDE_APPROVED_PROFILE");
    }
    if (identity) {
      const keys = ["requestId", "effectId", "obligationId", "idempotencyKey", "parentId", "deadline"];
      if (Object.keys(identity).length !== keys.length || keys.some((key) => {
        const value = identity[key as keyof NativeApplicationRequestIdentity];
        return typeof value !== "string" || !value || value.length > 256 || /[\x00-\x1f]/.test(value);
      })) applicationProviderFault("X2_INVALID_NATIVE_REQUEST_IDENTITY");
      const deadline = Date.parse(identity.deadline);
      if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > end) {
        applicationProviderFault("X2_NATIVE_REQUEST_DEADLINE");
      }
    }
  }

  private checkTemplate(path: string): void {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")
      || path.includes("#") || path.includes("?") || /(?:^|\/)\.\.?(?:\/|$)/.test(path)
      || /%(?:2f|5c|2e|00)/i.test(path)) applicationProviderFault("X2_UNAPPROVED_RESOURCE_SHAPE");
    const stripped = path.replace(/\{(?:account|accountId|record|recordId|request|requestId)\}/g, "scope");
    if (/[{}]/.test(stripped)) applicationProviderFault("X2_UNSUPPORTED_RESOURCE_PLACEHOLDER");
    this.url(stripped);
  }

  private url(path: string): string {
    let url: URL;
    try { url = new URL(path, this.origin); }
    catch { return applicationProviderFault("X2_INVALID_RESOURCE_URL"); }
    if (url.origin !== this.origin || url.username || url.password || url.hash
      || /[\x00-\x1f\\]/.test(path)) applicationProviderFault("X2_RESOURCE_ORIGIN_FENCE");
    return url.href;
  }

  /** The source may compare a public grant ID to the private configured binding;
   * neither the header name nor its value is returned or retained as a claim. */
  matchesRemoteGrant(grantId: string): boolean {
    return grantId === this.profile.grantRef.id
      || Object.values(this.profile.credentials.headers).some((value) => value === grantId);
  }

  private observationAttempt(): void {
    this.assertCurrent();
    if (++this.observations > MAX_OBSERVATIONS) applicationProviderFault("X2_OBSERVATION_BOUND");
  }

  private async retainSource(kind: string, url: string, result: HttpResult): Promise<ApplicationPublicSource> {
    if (result.bytes.length > MAX_BYTES) applicationProviderFault("X2_SOURCE_BYTE_BOUND");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); }
    catch { return applicationProviderFault("X2_UNSUPPORTED_SOURCE_ENCODING"); }
    // The retainer is a private owner custody port. Raw HTML can contain fresh
    // CSRF/context slots. It must never be mounted as learner/model input.
    const body = {
      schema: "finnor.x2.private-original-application-source.v1", kind, profileId: this.profile.id,
      method: kind === "response" ? "RESPONSE" : "GET",
      resourceDigest: applicationByteDigest(url), status: result.status,
      contentType: result.contentType, byteDigest: applicationByteDigest(result.bytes),
      bytesBase64: result.bytes.toString("base64"),
    };
    const ref = applicationContentRef("application-source", body);
    await this.retain(ref, body);
    const source = { ref, status: result.status, contentType: result.contentType, text };
    this.retainedSources.set(source, { kind, url, digest: applicationByteDigest(canonical(source)) });
    return source;
  }

  /** One Node request, no agents/SDK retries, redirects, fallback, or reconnect.
   * Streaming enforces the byte ceiling before buffering an oversized source. */
  private async send(
    url: string, method: string, body: string | null, contentType: string | null,
    identity?: NativeApplicationRequestIdentity, extraHeaders: Record<string, string> = {},
    onWire: () => void = () => {},
  ): Promise<HttpResult> {
    this.assertCurrent(undefined, identity);
    if (this.url(url) !== url) applicationProviderFault("X2_RESOURCE_ORIGIN_FENCE");
    const timeout = Math.min(5000, Date.parse(this.profile.validUntil) - Date.now(),
      identity ? Date.parse(identity.deadline) - Date.now() : 5000);
    if (timeout <= 0) applicationProviderFault("X2_REQUEST_DEADLINE");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (!["host", "connection", "content-length", "transfer-encoding", "content-type",
        "authorization", "origin"].includes(name.toLowerCase())
        && !Object.keys(this.profile.credentials.headers).some((key) => key.toLowerCase() === name.toLowerCase())) {
        headers[name] = value;
      }
    }
    Object.assign(headers, this.profile.credentials.headers);
    headers.origin = this.origin;
    headers.connection = "close";
    headers["accept-encoding"] = "identity";
    if (contentType) headers["content-type"] = contentType;
    if (body !== null) headers["content-length"] = String(Buffer.byteLength(body));
    if (body !== null && Buffer.byteLength(body) > MAX_BYTES) applicationProviderFault("X2_WIRE_BYTE_BOUND");
    return await new Promise<HttpResult>((resolve, reject) => {
      const request = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(
        url, { method, headers, agent: false }, (response) => {
          const pieces: Buffer[] = [];
          let bytes = 0;
          const fail = (code: string) => {
            response.destroy();
            request.destroy();
            reject(new ApplicationProviderFault(code));
          };
          const length = response.headers["content-length"];
          if (length && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))) {
            fail("X2_SOURCE_BYTE_BOUND"); return;
          }
          if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            fail("X2_UNSUPPORTED_SOURCE_ENCODING"); return;
          }
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) fail("X2_SOURCE_BYTE_BOUND");
            else pieces.push(chunk);
          });
          response.on("aborted", () => reject(new ApplicationProviderFault("X2_RESPONSE_LOST")));
          response.on("error", () => reject(new ApplicationProviderFault("X2_RESPONSE_LOST")));
          response.on("end", () => {
            if (!response.complete) { reject(new ApplicationProviderFault("X2_RESPONSE_LOST")); return; }
            const publicHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (typeof value === "string" && !["connection", "transfer-encoding", "content-length"].includes(key)) {
                publicHeaders[key] = value;
              }
            }
            resolve({
              status: response.statusCode ?? 0, contentType: response.headers["content-type"] ?? null,
              headers: publicHeaders, bytes: Buffer.concat(pieces),
            });
          });
        },
      );
      this.activeRequests.add(request);
      const timer = setTimeout(() => request.destroy(new ApplicationProviderFault("X2_RESPONSE_LOST")), timeout);
      request.on("close", () => { clearTimeout(timer); this.activeRequests.delete(request); });
      request.on("error", () => reject(new ApplicationProviderFault("X2_RESPONSE_LOST")));
      // ATTEMPT/S6 was awaited by the caller. Mark possible egress before .end.
      onWire();
      request.end(body ?? undefined);
    });
  }

  private async fencedRead(kind: "documentation" | "context" | "record" | "request" | "entrypoint",
    url: string, identity: NativeApplicationRequestIdentity | null = null,
    extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
    const fence = this.options.readFence;
    if (!fence) applicationProviderFault("X2_NATIVE_READ_FENCE_REQUIRED");
    await fence.beforeRead({ kind, url, identity });
    this.assertCurrent();
    const started = performance.now();
    let result: HttpResult | null = null;
    try {
      result = await this.send(url, "GET", null, null, undefined, extraHeaders);
      return result;
    } finally {
      await fence.afterRead({ kind, resourceDigest: applicationByteDigest(url),
        status: result?.status ?? null, bytes: result?.bytes.length ?? null,
        wallMs: performance.now() - started, outcome: result ? "RESPONSE" : "UNAVAILABLE" });
    }
  }

  async documentation(): Promise<ApplicationPublicSource[]> {
    const sources: ApplicationPublicSource[] = [];
    for (const path of this.profile.documentationPaths) {
      this.observationAttempt();
      const url = this.url(path);
      const result = await this.fencedRead("documentation", url);
      const source = await this.retainSource("documentation", url, result);
      if (result.status >= 300 && result.status < 400) applicationProviderFault("X2_REDIRECT_REFUSED");
      sources.push(source);
    }
    return sources;
  }

  async contextSource(): Promise<ApplicationPublicSource | null> {
    if (!this.profile.contextPath) return null;
    return await this.read("context", this.profile.contextPath);
  }
  async recordSource(target: ScopedApplicationIdentity): Promise<ApplicationPublicSource> {
    this.assertCurrent(target);
    return await this.read("record", applicationResourcePath(this.profile.recordPathTemplate, this.profile, target));
  }
  async requestSource(identity: NativeApplicationRequestIdentity): Promise<ApplicationPublicSource | null> {
    this.assertCurrent();
    if (!this.profile.requestPathTemplate) return null;
    return await this.read("request", applicationResourcePath(this.profile.requestPathTemplate, this.profile, undefined, identity), identity);
  }
  private async read(kind: "context" | "record" | "request", path: string,
    identity: NativeApplicationRequestIdentity | null = null): Promise<ApplicationPublicSource> {
    this.observationAttempt();
    const url = this.url(path);
    const result = await this.fencedRead(kind, url, identity);
    const source = await this.retainSource(kind, url, result);
    if (result.status >= 300 && result.status < 400) applicationProviderFault("X2_REDIRECT_REFUSED");
    return source;
  }

  private async ownedContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.contextPromise) return await this.contextPromise;
    const endpoint = this.options.browserEndpoint ?? process.env.AGENT_BROWSER_CDP;
    if (!endpoint) applicationProviderFault("X2_BROWSER_ENDPOINT_UNAVAILABLE");
    this.contextPromise = (async () => {
      const browser = await attach(endpoint);
      this.assertCurrent();
      let context: BrowserContext;
      try {
        context = await browser.newContext({
          serviceWorkers: "block", javaScriptEnabled: false, acceptDownloads: false,
        });
      } catch { return applicationProviderFault("X2_OWNED_BROWSER_CONTEXT_UNAVAILABLE"); }
      if (this.closed) {
        await context.close().catch(() => {});
        applicationProviderFault("X2_APPLICATION_SESSION_CLOSED");
      }
      this.context = context;
      // No inherited/user page, cookies, service worker, popup, or auth session.
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", async (route) => {
        const request = route.request();
        const read = this.readPermit;
        const mutation = this.mutationPermit;
        if (read && !read.consumed && request.isNavigationRequest() && request.resourceType() === "document"
          && request.method() === "GET" && request.url() === read.url && !request.postData()) {
          read.consumed = true;
          try {
            this.assertCurrent();
            read.result = await this.fencedRead(read.kind, read.url, read.identity, request.headers());
            if (read.result.status >= 300 && read.result.status < 400) {
              applicationProviderFault("X2_REDIRECT_REFUSED");
            }
            await route.fulfill({
              status: read.result.status, body: read.result.bytes,
              headers: this.documentHeaders(read.result.headers),
            });
          } catch (error) {
            read.failure = this.safeFault(error, "X2_BROWSER_READ_UNAVAILABLE");
            await route.abort("blockedbyclient").catch(() => {});
          }
          return;
        }
        if (mutation && !mutation.consumed && request.isNavigationRequest()
          && request.resourceType() === "document" && request.method() === mutation.wire.method
          && request.url() === mutation.wire.url && (request.postData() ?? null) === mutation.wire.body) {
          mutation.consumed = true; // Atomic, before an async authority decision.
          try {
            this.checkHandle(mutation.wire, mutation.handle);
            this.assertCurrent(undefined, mutation.wire.identity);
            await this.boundedFence(() => mutation.fence.beforeWire(mutation.wire),
              Math.min(5000, Date.parse(mutation.wire.identity.deadline) - Date.now()), "X2_NATIVE_BEFORE_WIRE_UNAVAILABLE");
            if (this.mutationPermit !== mutation || this.closed) {
              applicationProviderFault("X2_LATE_PHYSICAL_PERMIT_REFUSED");
            }
            this.assertCurrent(undefined, mutation.wire.identity);
            this.checkHandle(mutation.wire, mutation.handle);
            mutation.result = await this.send(
              mutation.wire.url, mutation.wire.method, mutation.wire.body, mutation.wire.contentType,
              mutation.wire.identity, request.headers(), () => { mutation.possibleEgress = true; },
            );
            // Redirect callbacks and any browser retries remain blocked.
            await route.fulfill({
              status: mutation.result.status, body: mutation.result.bytes,
              headers: this.documentHeaders(mutation.result.headers),
            });
          } catch (error) {
            mutation.failure = this.safeFault(error, "X2_MUTATION_UNAVAILABLE");
            await route.abort("blockedbyclient").catch(() => {});
          }
          return;
        }
        // Includes same-origin images/XHR/autosave, foreign requests, callbacks,
        // method-deceptive GET links, frame navigation and repeated requests.
        await route.abort("blockedbyclient");
      });
      return context;
    })();
    try { return await this.contextPromise; }
    catch (error) {
      const owned = this.context as BrowserContext | null;
      if (owned) await owned.close().catch(() => {});
      this.context = null;
      this.contextPromise = null;
      throw this.safeFault(error, "X2_OWNED_BROWSER_CONTEXT_UNAVAILABLE");
    }
  }

  private documentHeaders(headers: Record<string, string>): Record<string, string> {
    return {
      ...headers,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-src 'none'",
      "cache-control": "no-store",
    };
  }

  async document(
    kind: "entrypoint" | "record" | "request", target?: ScopedApplicationIdentity,
    identity?: NativeApplicationRequestIdentity, originalSource?: ApplicationPublicSource,
  ): Promise<ApplicationDocument> {
    this.assertCurrent(target);
    if (this.browserBusy) applicationProviderFault("X2_CONCURRENT_BROWSER_INTERACTION");
    const template = kind === "entrypoint" ? this.profile.entrypoint
      : kind === "record" ? this.profile.recordPathTemplate : this.profile.requestPathTemplate;
    if (!template) applicationProviderFault("X2_OBSERVER_UNAVAILABLE");
    const path = applicationResourcePath(template, this.profile, target, identity);
    const url = this.url(path);
    if ((this.options.documentTransport ?? "PASSIVE_HTML") === "PASSIVE_HTML") {
      this.browserBusy = true;
      try {
        let source = originalSource;
        if (source) {
          const original = this.retainedSources.get(source);
          if (!original || original.kind !== kind || original.url !== url
            || original.digest !== applicationByteDigest(canonical(source))) {
            applicationProviderFault("X2_RETAINED_SOURCE_PROVENANCE_REQUIRED");
          }
        } else {
          this.observationAttempt();
          const result = await this.fencedRead(kind, url, identity ?? null);
          source = await this.retainSource(kind, url, result);
          if (result.status >= 300 && result.status < 400) applicationProviderFault("X2_REDIRECT_REFUSED");
        }
        const captured = parsePassiveApplicationDocument(source, url, applicationProviderFault);
        this.passiveDocuments.set(captured, applicationByteDigest(canonical(captured)));
        return captured;
      } finally { this.browserBusy = false; }
    }
    if (this.options.documentTransport !== "OWNED_BROWSER" || originalSource) {
      applicationProviderFault("X2_DOCUMENT_TRANSPORT_UNSUPPORTED");
    }
    this.observationAttempt();
    this.browserBusy = true;
    let page: Page | null = null;
    const permit: ReadPermit = { url, kind, identity: identity ?? null, consumed: false, result: null, failure: null };
    try {
      const context = await this.ownedContext();
      try { page = await context.newPage(); }
      catch { return applicationProviderFault("X2_OWNED_BROWSER_PAGE_UNAVAILABLE"); }
      this.pages.add(page);
      page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
      this.readPermit = permit;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
      this.readPermit = null;
      if (permit.failure) throw permit.failure;
      if (!permit.consumed || !permit.result || page.url() !== url) applicationProviderFault("X2_BROWSER_READ_UNAVAILABLE");
      const source = await this.retainSource(kind, url, permit.result);
      // Fixed adapter code only: no page/source/model-supplied JavaScript.
      const structure = await page.evaluate(() => ({
        forms: Array.from(document.forms).map((form, index) => ({
          index, label: (form.getAttribute("aria-label") ?? form.querySelector("legend")?.textContent
            ?? form.parentElement?.querySelector("h1,h2,h3")?.textContent
            ?? form.querySelector("button[type='submit'],input[type='submit']")?.textContent ?? "").trim(),
          method: form.method.toUpperCase(), action: form.action, encoding: form.enctype, target: form.target,
          overrides: Boolean(form.querySelector("[formaction],[formmethod],[formenctype],[formtarget]")),
          controls: Array.from(form.elements).filter((element) =>
            ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)).map((element) => {
            const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            return {
              name: control.name, label: Array.from(control.labels ?? []).map((label) => label.textContent ?? "").join(" ").trim() || null,
              kind: control.tagName === "SELECT" ? "select" : control.tagName === "TEXTAREA" ? "textarea" : (control as HTMLInputElement).type,
              value: control.value, required: control.required, disabled: control.disabled,
              pattern: control.getAttribute("pattern"), maxLength: control.hasAttribute("maxlength") ? Number(control.getAttribute("maxlength")) : null,
              options: control.tagName === "SELECT" ? Array.from((control as HTMLSelectElement).options).map((option) => option.value) : [],
            };
          }),
        })),
        descriptions: Array.from(document.querySelectorAll("dl")).map((list) => ({
          label: list.parentElement?.getAttribute("aria-label") ?? null,
          entries: Array.from(list.querySelectorAll(":scope > dt")).map((term) => ({
            name: (term.textContent ?? "").trim(),
            value: term.nextElementSibling?.tagName === "DD" ? term.nextElementSibling.textContent ?? "" : "",
          })),
        })),
      }));
      if (structure.forms.length > 16 || structure.descriptions.length > 16
        || structure.forms.some((form) => form.controls.length > 32)
        || structure.descriptions.some((list) => list.entries.length > 32)) {
        applicationProviderFault("X2_DOCUMENT_STRUCTURE_BOUND");
      }
      const captured: ApplicationDocument = { source, url, transport: "OWNED_BROWSER", ...structure };
      this.documentPages.set(captured, page);
      return captured;
    } catch (error) {
      if (page) { this.pages.delete(page); await page.close().catch(() => {}); }
      throw this.safeFault(error, "X2_DOCUMENT_UNSUPPORTED");
    } finally {
      this.readPermit = null;
      this.browserBusy = false;
    }
  }

  async releaseDocument(document: ApplicationDocument): Promise<void> {
    this.passiveDocuments.delete(document);
    const page = this.documentPages.get(document);
    if (!page) return;
    this.documentPages.delete(document);
    this.pages.delete(page);
    await page.close().catch(() => {});
  }

  /** Source-owned exact wire, not a model URL/script. Private handles are WeakMap
   * members; serializing/copying/substituting a prepared wire loses its permit. */
  seal(
    wire: PreparedApplicationWire,
    ui?: { document: ApplicationDocument; formIndex: number; controls: Record<string, string> },
  ): PreparedApplicationWire {
    this.assertCurrent(undefined, wire.identity);
    if (this.pendingWire || this.executing || this.responseLost) applicationProviderFault("X2_OUTSTANDING_PREPARED_WIRE");
    if (this.url(wire.url) !== wire.url || applicationByteDigest(wire.body ?? "") !== wire.bodyDigest) {
      applicationProviderFault("X2_PREPARED_WIRE_SUBSTITUTION");
    }
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(wire.method)
      || (wire.method === "GET" && wire.body !== null)) applicationProviderFault("X2_UNSUPPORTED_WIRE_METHOD");
    let page: Page | null = null;
    if (ui) {
      if (ui.document.transport === "PASSIVE_HTML") {
        if (this.passiveDocuments.get(ui.document) !== applicationByteDigest(canonical(ui.document))) {
          applicationProviderFault("X2_PRIVATE_FORM_HANDLE_UNAVAILABLE");
        }
        const form = ui.document.forms.find(form => form.index === ui.formIndex);
        if (!form) applicationProviderFault("X2_PRIVATE_FORM_HANDLE_UNAVAILABLE");
        const expected = passiveFormWire(form, ui.controls, applicationProviderFault);
        if (expected.method !== wire.method || expected.url !== wire.url
          || expected.body !== wire.body || expected.contentType !== wire.contentType) {
          applicationProviderFault("X2_PASSIVE_FORM_WIRE_MISMATCH");
        }
      } else {
        page = this.documentPages.get(ui.document) ?? null;
        if (!page || !this.pages.has(page) || page.url() !== ui.document.url
          || !ui.document.forms.some((form) => form.index === ui.formIndex)) {
          applicationProviderFault("X2_PRIVATE_FORM_HANDLE_UNAVAILABLE");
        }
      }
    }
    Object.freeze(wire.identity);
    Object.freeze(wire.context);
    Object.freeze(wire);
    this.handles.set(wire, {
      digest: applicationByteDigest(canonical(wire)), consumed: false,
      page, formIndex: ui?.formIndex ?? null, controls: ui ? structuredClone(ui.controls) : null,
      passiveDocument: ui?.document.transport === "PASSIVE_HTML" ? ui.document : null,
    });
    this.pendingWire = wire;
    return wire;
  }

  private checkHandle(wire: PreparedApplicationWire, handle: PreparedHandle): void {
    if (applicationByteDigest(canonical(wire)) !== handle.digest
      || applicationByteDigest(wire.body ?? "") !== wire.bodyDigest || this.url(wire.url) !== wire.url) {
      applicationProviderFault("X2_PREPARED_WIRE_SUBSTITUTION");
    }
    if (handle.passiveDocument
      && this.passiveDocuments.get(handle.passiveDocument) !== applicationByteDigest(canonical(handle.passiveDocument))) {
      applicationProviderFault("X2_PRIVATE_FORM_HANDLE_UNAVAILABLE");
    }
  }

  async execute(wire: PreparedApplicationWire, fence: ApplicationPhysicalEgressFence): Promise<{
    status: number | null; body: unknown; responseRef: ExperimentRef | null; possibleEgress: boolean;
  }> {
    const handle = this.handles.get(wire);
    if (!handle || handle.consumed) applicationProviderFault("X2_ONE_USE_WIRE_REQUIRED");
    if (this.executing || this.responseLost) applicationProviderFault("X2_UNRESOLVED_OR_CONCURRENT_EGRESS");
    this.assertCurrent(undefined, wire.identity);
    this.checkHandle(wire, handle);
    if (++this.interactions > MAX_INTERACTIONS) applicationProviderFault("X2_INTERACTION_BOUND");
    const parts = ["requestId", "effectId", "obligationId", "idempotencyKey"] as const;
    if (parts.some((key) => this.usedIdentityParts.has(`${key}:${wire.identity[key]}`))) {
      applicationProviderFault("X2_NATIVE_IDENTITY_REPLAY_REFUSED");
    }
    handle.consumed = true;
    this.pendingWire = null;
    for (const key of parts) this.usedIdentityParts.add(`${key}:${wire.identity[key]}`);
    this.executing = true;
    let result: HttpResult | null = null;
    let possibleEgress = false;
    let failure: ApplicationProviderFault | null = null;
    try {
      if (handle.page) {
        if (this.browserBusy) applicationProviderFault("X2_CONCURRENT_BROWSER_INTERACTION");
        this.browserBusy = true;
        const permit: MutationPermit = {
          wire, handle, fence, consumed: false, result: null, possibleEgress: false, failure: null,
        };
        this.mutationPermit = permit;
        try {
          const form = handle.page.locator("form").nth(handle.formIndex!);
          // Only source-bound controls, no arbitrary locator or runtime code.
          for (const [name, value] of Object.entries(handle.controls!)) {
            if (unsafeKeys.has(name) || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
              applicationProviderFault("X2_UNSUPPORTED_FORM_CONTROL");
            }
            const control = form.locator(`[name=${JSON.stringify(name)}]`);
            if (await control.count() !== 1) applicationProviderFault("X2_AMBIGUOUS_FORM_CONTROL");
            await control.evaluate((element, next) => {
              (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value = next;
            }, value);
          }
          await form.evaluate((element) => HTMLFormElement.prototype.submit.call(element)).catch(() => {});
          // Native form submission is asynchronous. Wait for the actual route,
          // not a toast or expected business outcome; all further routes block.
          await handle.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
          const end = Math.min(Date.now() + 5000, Date.parse(wire.identity.deadline));
          while (!permit.result && !permit.failure && Date.now() < end) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!permit.consumed) applicationProviderFault("X2_FORM_WIRE_MISMATCH");
          result = permit.result; possibleEgress = permit.possibleEgress; failure = permit.failure;
          if (!result && !failure) failure = new ApplicationProviderFault("X2_RESPONSE_LOST");
        } finally {
          // A late continuation cannot find a permit and cannot send again.
          this.mutationPermit = null;
          this.browserBusy = false;
        }
      } else {
        await this.boundedFence(() => fence.beforeWire(wire),
          Math.min(5000, Date.parse(wire.identity.deadline) - Date.now()), "X2_NATIVE_BEFORE_WIRE_UNAVAILABLE");
        this.assertCurrent(undefined, wire.identity);
        this.checkHandle(wire, handle);
        result = await this.send(wire.url, wire.method, wire.body, wire.contentType, wire.identity,
          {}, () => { possibleEgress = true; });
      }
    } catch (error) { failure = this.safeFault(error, "X2_MUTATION_UNAVAILABLE"); }
    if (handle.page) {
      this.pages.delete(handle.page);
      await handle.page.close().catch(() => {});
    }
    if (handle.passiveDocument) this.passiveDocuments.delete(handle.passiveDocument);
    const status = result?.status ?? null;
    const responseDigest = result ? applicationByteDigest(result.bytes) : null;
    try {
      await this.boundedFence(() => fence.afterWire({ status, responseDigest, possibleEgress }),
        5000, "X2_NATIVE_AFTER_WIRE_UNAVAILABLE");
    } catch {
      if (possibleEgress) this.responseLost = true;
      this.executing = false;
      applicationProviderFault("X2_NATIVE_AFTER_WIRE_UNAVAILABLE");
    }
    this.executing = false;
    if (!result && possibleEgress) this.responseLost = true;
    if (failure && !possibleEgress) throw failure;
    if (!result) return { status: null, body: null, responseRef: null, possibleEgress };
    const source = await this.retainSource("response", wire.url, result);
    let body: unknown = null;
    if (source.contentType?.split(";")[0]?.trim() === "application/json") {
      try { body = JSON.parse(source.text) as unknown; }
      catch { body = null; }
    }
    // HTML/CSRF never leaves this private adapter as an executor "receipt".
    return { status, body, responseRef: source.ref, possibleEgress };
  }

  private safeFault(error: unknown, fallback: string): ApplicationProviderFault {
    return error instanceof ApplicationProviderFault ? error : new ApplicationProviderFault(fallback);
  }

  private async boundedFence(call: () => Promise<void>, timeout: number, code: string): Promise<void> {
    if (timeout <= 0) applicationProviderFault(code);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve().then(call),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ApplicationProviderFault(code)), timeout);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.readPermit = null;
    this.mutationPermit = null;
    for (const request of this.activeRequests) request.destroy();
    this.activeRequests.clear();
    for (const page of this.pages) await page.close().catch(() => {});
    this.pages.clear();
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    // Never Browser.close(): the browser belongs to Factory/the user. A child
    // process exit disconnects its attachment; broker owners manage lifetime.
  }
}
