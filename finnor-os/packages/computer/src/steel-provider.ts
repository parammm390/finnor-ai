import Steel from "steel-sdk";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ComputerProviderCapability, ComputerTaskInput } from "@finnor/shared-types";
import type {
  ComputerLocator,
  ComputerOriginPolicy,
  ComputerPrimitive,
  ComputerPrimitiveResult,
  ComputerProvider,
  ComputerProviderCost,
  ComputerProviderSession,
  ComputerSessionRequest,
  StructuredPageObservation,
} from "./contracts";
import { ComputerProviderError } from "./contracts";
import { assertAllowedUrl, safePageUrl } from "./origins";
import { redactComputerValue } from "./redaction";

interface SteelSessionShape {
  id: string;
  websocketUrl: string;
  sessionViewerUrl: string;
  creditsUsed: number;
}

/** Narrow port over the verified steel-sdk 0.18 surface. Keeping it here makes the
 * adapter mockable without leaking any Steel SDK type into FINNOR contracts. */
interface SteelClientPort {
  sessions: {
    create(body: {
      profileId?: string;
      namespace?: string;
      credentials?: { autoSubmit?: boolean; blurFields?: boolean; exactOrigin?: boolean };
      persistProfile?: boolean;
      timeout?: number;
      headless?: boolean;
      debugConfig?: { interactive?: boolean; systemCursor?: boolean };
      dimensions?: { width: number; height: number };
    }): Promise<SteelSessionShape>;
    retrieve(id: string): Promise<SteelSessionShape>;
    liveDetails(id: string): Promise<{ wsUrl: string; sessionViewerUrl: string }>;
    computer(id: string, body:
      | { action: "click_mouse"; button: "left"; coordinates: number[]; screenshot?: boolean }
      | { action: "type_text"; text: string; screenshot?: boolean }
      | { action: "take_screenshot" }
    ): Promise<{ base64_image?: string; output?: string; error?: string }>;
    release(id: string): Promise<{ success: boolean }>;
    files: {
      list(id: string): Promise<{ data: Array<{ path: string; size: number }> }>;
      download(id: string, path: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>;
    };
  };
}

interface RuntimeBrowser {
  browser: Browser;
  context: BrowserContext;
  blockedOrigin: boolean;
  blockedMutation: boolean;
}

export interface SteelProviderOptions {
  apiKey: string;
  baseURL?: string;
  client?: SteelClientPort;
  connectOverCDP?: (url: string) => Promise<Browser>;
}

const CAPABILITIES: ReadonlySet<ComputerProviderCapability> = new Set([
  "cloud_session", "cdp", "structured_page", "screenshot", "visual_input",
  "live_view", "persistent_profile", "file_download",
]);

function cdpUrl(websocketUrl: string, apiKey: string): string {
  if (!apiKey || /[?&]apiKey=/.test(websocketUrl)) return websocketUrl;
  return `${websocketUrl}${websocketUrl.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}`;
}

function locatorFor(page: Page, locator: ComputerLocator): Locator {
  switch (locator.kind) {
    case "role": return page.getByRole(locator.role as never, { name: locator.name, exact: locator.exact });
    case "label": return page.getByLabel(locator.label, { exact: locator.exact });
    case "text": return page.getByText(locator.text, { exact: locator.exact });
    case "test_id": return page.getByTestId(locator.testId);
    case "css": return page.locator(locator.selector);
  }
}

function activePage(context: BrowserContext): Page {
  const pages = context.pages();
  const page = pages.at(-1);
  if (!page) throw new ComputerProviderError("session_lost", "The Steel browser has no active page");
  return page;
}

/** Deterministic network guard used in addition to semantic effect interception.
 * It is deliberately method/resource/origin based, never a button-label list. */
export function readOnlyRequestWouldMutate(
  mode: ComputerTaskInput["mode"],
  method: string,
  resourceType: string,
  url: string,
  origins: ComputerOriginPolicy,
): boolean {
  if (mode !== "READ_ONLY" || ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) || !["document", "fetch", "xhr"].includes(resourceType)) return false;
  try { return origins.allowedOrigins.includes(new URL(url).origin); }
  catch { return true; }
}

export class SteelProvider implements ComputerProvider {
  readonly name = "steel";
  readonly capabilities = CAPABILITIES;
  private readonly client: SteelClientPort;
  private readonly connect: (url: string) => Promise<Browser>;
  private readonly runtimes = new Map<string, RuntimeBrowser>();

  constructor(private readonly options: SteelProviderOptions) {
    if (!options.apiKey.trim()) throw new ComputerProviderError("provider_unavailable", "STEEL_API_KEY is not configured");
    // A Steel SDK retry is a second physical provider request. The durable
    // computer/effect runtime must decide whether repetition is legal and record
    // every invocation first, so the SDK is deliberately single-shot here.
    this.client = options.client ?? new Steel({ steelAPIKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), maxRetries: 0 }) as unknown as SteelClientPort;
    this.connect = options.connectOverCDP ?? ((url) => chromium.connectOverCDP(url));
  }

  async createSession(request: ComputerSessionRequest): Promise<ComputerProviderSession> {
    try {
      const created = await this.client.sessions.create({
        ...(request.auth.profileId ? { profileId: request.auth.profileId } : {}),
        ...(request.auth.namespace ? {
          namespace: request.auth.namespace,
          credentials: { autoSubmit: true, blurFields: true, exactOrigin: true },
        } : {}),
        // Close only this ephemeral browser. Never mutate/destroy the governed profile.
        persistProfile: false,
        timeout: request.limits.timeoutMs,
        headless: false,
        debugConfig: { interactive: false, systemCursor: true },
        dimensions: { width: 1440, height: 1000 },
      });
      const session = { sessionRef: created.id, cdpUrl: created.websocketUrl, liveViewUrl: created.sessionViewerUrl, executionMode: request.mode, downloadLimitBytes: request.limits.maxDownloadBytes };
      // Return the provider handle before CDP attachment. The runner persists it
      // immediately, so even an attach crash leaves a durable orphan-cleanup handle.
      return session;
    } catch (error) {
      throw this.normalize(error, "Steel could not provision an isolated browser session");
    }
  }

  async observe(session: ComputerProviderSession, origins: ComputerOriginPolicy): Promise<StructuredPageObservation> {
    const runtime = await this.runtime(session, origins);
    this.assertRuntimeGuards(runtime);
    const pages = runtime.context.pages();
    for (const candidate of pages) assertAllowedUrl(candidate.url(), origins);
    const page = activePage(runtime.context);
    const raw = await page.locator("button,a,input,textarea,select,[role],[contenteditable='true']").evaluateAll((nodes) => nodes.slice(0, 200).map((node, index) => {
      const element = node as HTMLElement;
      const input = element as HTMLInputElement;
      const rect = element.getBoundingClientRect();
      return {
        id: `e${index + 1}`,
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        name: element.getAttribute("aria-label") ?? element.getAttribute("name") ?? element.getAttribute("title"),
        text: (element.innerText || element.getAttribute("placeholder") || "").trim().slice(0, 500) || null,
        disabled: Boolean((input as { disabled?: boolean }).disabled) || element.getAttribute("aria-disabled") === "true",
        inputKind: element.tagName === "INPUT" ? (input.type || "text") : element.tagName === "TEXTAREA" ? "textarea" : null,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }));
    const safeBodyText = await page.locator("body").evaluate((body) => {
      const clone = body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,textarea,select,[contenteditable='true'],script,style").forEach((node) => node.remove());
      return clone.innerText;
    });
    const safeElements = raw.map((element) => ({
      ...element,
      name: element.name ? String(redactComputerValue(element.name)) : null,
      text: element.text ? String(redactComputerValue(element.text)) : null,
    }));
    const observation = {
      url: safePageUrl(page.url()),
      title: String(redactComputerValue((await page.title()).slice(0, 500))),
      text: String(redactComputerValue(safeBodyText.slice(0, 30_000))),
      elements: safeElements,
      openPageUrls: pages.map((candidate) => safePageUrl(candidate.url())),
    };
    this.assertRuntimeGuards(runtime);
    return observation;
  }

  async perform(session: ComputerProviderSession, primitive: ComputerPrimitive, origins: ComputerOriginPolicy): Promise<ComputerPrimitiveResult> {
    const runtime = await this.runtime(session, origins);
    const page = activePage(runtime.context);
    try {
      switch (primitive.kind) {
        case "navigate":
          assertAllowedUrl(primitive.url, origins);
          await page.goto(primitive.url, { waitUntil: "domcontentloaded" });
          this.assertRuntimeGuards(runtime);
          assertAllowedUrl(page.url(), origins);
          return { summary: "Opened the governed application", pageUrl: safePageUrl(page.url()) };
        case "click":
          await locatorFor(page, primitive.locator).click({ timeout: 15_000 });
          this.assertRuntimeGuards(runtime);
          assertAllowedUrl(page.url(), origins);
          return { summary: "Activated a structured page control", pageUrl: safePageUrl(page.url()) };
        case "type":
          await locatorFor(page, primitive.locator).fill(primitive.text, { timeout: 15_000 });
          this.assertRuntimeGuards(runtime);
          return { summary: "Entered authorized task data in a structured field", pageUrl: safePageUrl(page.url()) };
        case "press":
          if (primitive.locator) await locatorFor(page, primitive.locator).press(primitive.key);
          else await page.keyboard.press(primitive.key);
          this.assertRuntimeGuards(runtime);
          return { summary: "Pressed a deterministic keyboard key", pageUrl: safePageUrl(page.url()) };
        case "wait":
          await page.waitForTimeout(Math.min(Math.max(primitive.milliseconds, 0), 10_000));
          return { summary: "Waited for the application state", pageUrl: safePageUrl(page.url()) };
        case "screenshot": {
          const bytes = await page.screenshot({ type: "png", fullPage: false });
          return { summary: "Captured application evidence", pageUrl: safePageUrl(page.url()), screenshot: bytes };
        }
        case "visual_click": {
          const response = await this.client.sessions.computer(session.sessionRef, { action: "click_mouse", button: "left", coordinates: [primitive.x, primitive.y], screenshot: true });
          if (response.error) throw new Error(response.error);
          this.assertRuntimeGuards(runtime);
          return { summary: "Used bounded visual input after structured interaction was unavailable", pageUrl: safePageUrl(page.url()), ...(response.base64_image ? { screenshot: Buffer.from(response.base64_image, "base64") } : {}) };
        }
        case "visual_type": {
          const response = await this.client.sessions.computer(session.sessionRef, { action: "type_text", text: primitive.text, screenshot: true });
          if (response.error) throw new Error(response.error);
          this.assertRuntimeGuards(runtime);
          return { summary: "Used bounded visual keyboard input after structured interaction was unavailable", pageUrl: safePageUrl(page.url()), ...(response.base64_image ? { screenshot: Buffer.from(response.base64_image, "base64") } : {}) };
        }
        case "download": {
          const listed = await this.client.sessions.files.list(session.sessionRef);
          const selected = primitive.filename ? listed.data.find((file) => file.path === primitive.filename) : listed.data[0];
          if (!selected) throw new Error("No permitted session download was found");
          if (selected.size > (session.downloadLimitBytes ?? 0)) throw new ComputerProviderError("limit_exceeded", "The session download exceeds the governed byte limit");
          const response = await this.client.sessions.files.download(session.sessionRef, selected.path);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { summary: "Captured a permitted downloaded artifact", pageUrl: safePageUrl(page.url()), download: { filename: selected.path.split("/").at(-1) ?? "download", mimeType: response.headers.get("content-type") ?? "application/octet-stream", bytes } };
        }
      }
    } catch (error) {
      if (error instanceof ComputerProviderError) throw error;
      if (runtime.blockedOrigin) throw new ComputerProviderError("origin_blocked", "Steel blocked navigation outside the governed application origins");
      if (runtime.blockedMutation) throw new ComputerProviderError("read_only_mutation", "Steel blocked a non-idempotent application request in READ_ONLY mode");
      throw this.normalize(error, "Steel browser operation failed");
    }
  }

  async cost(session: ComputerProviderSession): Promise<ComputerProviderCost> {
    try {
      const details = await this.client.sessions.retrieve(session.sessionRef);
      return { creditsUsed: Number.isFinite(details.creditsUsed) ? details.creditsUsed : 0 };
    } catch (error) { throw this.normalize(error, "Steel usage could not be read"); }
  }

  async release(session: ComputerProviderSession): Promise<void> {
    const runtime = this.runtimes.get(session.sessionRef);
    this.runtimes.delete(session.sessionRef);
    await runtime?.browser.close().catch(() => undefined);
    try { await this.client.sessions.release(session.sessionRef); } catch (error) { throw this.normalize(error, "Steel session release failed"); }
  }

  private async runtime(session: ComputerProviderSession, origins: ComputerOriginPolicy): Promise<RuntimeBrowser> {
    return this.runtimes.get(session.sessionRef) ?? this.attach(session, origins);
  }

  private async attach(session: ComputerProviderSession, origins: ComputerOriginPolicy): Promise<RuntimeBrowser> {
    const websocketUrl = session.cdpUrl ?? (await this.client.sessions.liveDetails(session.sessionRef)).wsUrl;
    const browser = await this.connect(cdpUrl(websocketUrl, this.options.apiKey));
    const context = browser.contexts()[0] ?? await browser.newContext();
    const runtime: RuntimeBrowser = { browser, context, blockedOrigin: false, blockedMutation: false };
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()) {
        try { assertAllowedUrl(request.url(), origins); }
        catch {
          runtime.blockedOrigin = true;
          await route.abort("blockedbyclient");
          return;
        }
      }
      if (readOnlyRequestWouldMutate(session.executionMode ?? "READ_ONLY", request.method(), request.resourceType(), request.url(), origins)) {
        runtime.blockedMutation = true;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    this.runtimes.set(session.sessionRef, runtime);
    return runtime;
  }

  private assertRuntimeGuards(runtime: RuntimeBrowser): void {
    if (runtime.blockedOrigin) throw new ComputerProviderError("origin_blocked", "Steel blocked navigation outside the governed application origins");
    if (runtime.blockedMutation) throw new ComputerProviderError("read_only_mutation", "Steel blocked a non-idempotent application request in READ_ONLY mode");
  }

  private normalize(error: unknown, fallback: string): ComputerProviderError {
    const message = error instanceof Error && error.message ? error.message : fallback;
    const redacted = String(redactComputerValue(message.slice(0, 500)));
    const safe = /api.?key|token|authorization|cookie|password/i.test(redacted) ? fallback : redacted;
    return new ComputerProviderError(/closed|lost|released/i.test(safe) ? "session_lost" : "provider_failure", safe);
  }
}
