/** Real emitted Next, signed disposable auth and production API/SQL only.
 * Predicates are specified in mounted-proof-contract.md, before this driver.
 * A barrier holds a completed original response; it never supplies a response. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium, type BrowserContext, type Page, type Request as BrowserRequest } from "playwright";
import type { OwnerReadTiming } from "../../frontier5/x1/authenticated-api-fixture.mts";

type Gate = { id: string; principalId: string; workId: string; enteredAt: string | null;
  releasedAt: string | null; bodyDigest: string | null; automatic: boolean;
  path: string; protocolId: string | null; requestDigest: string | null;
  entered: Promise<void>; release: () => void; done: Promise<void> };

export function mountedResponseBarrier() {
  const gates = new Map<string, Gate & { original: Gate; hold(body: string, request: string): Promise<void> }>();
  const receipts: Gate[] = [];
  return {
    receipts: () => receipts.map(({ entered, done, release, ...receipt }) => receipt),
    arm(id: string, principalId: string, workId: string, path = "/api/real-world-services/read", protocolId: string | null = null) {
      assert(!gates.has(id), "W3_MOUNTED_BARRIER_ALREADY_ARMED");
      assert(["/api/real-world-services/read", "/api/real-world-services/inbox", "/api/real-world-services/consent"].includes(path));
      let enter!: () => void, resume!: () => void, finish!: () => void;
      const entered = new Promise<void>(yes => { enter = yes });
      const pending = new Promise<void>(yes => { resume = yes });
      const done = new Promise<void>(yes => { finish = yes });
      const original: Gate = { id, principalId, workId, path, protocolId, enteredAt: null, releasedAt: null,
        bodyDigest: null, requestDigest: null, automatic: false, entered, done,
        release: () => {
          if (!original.releasedAt) { original.releasedAt = new Date().toISOString(); resume() }
          if (!original.enteredAt) { finish(); gates.delete(id) }
        } };
      receipts.push(original);
      const control = { ...original, original,
        async hold(body: string, request: string) {
          original.bodyDigest = createHash("sha256").update(body).digest("hex");
          original.requestDigest = createHash("sha256").update(request).digest("hex");
          original.enteredAt = new Date().toISOString(); enter();
          const timer = setTimeout(() => { original.automatic = true; original.release() }, 20000);
          try { await pending } finally { clearTimeout(timer); finish(); gates.delete(id) }
        } };
      gates.set(id, control);
      return control;
    },
    async afterResponse(path: string, body: string, status: number, request: { observer: boolean; body: string }) {
      if (status !== 200 || request.observer
        || ![...gates.values()].some(gate => !gate.original.enteredAt && gate.path === path)) return;
      const actual = JSON.parse(body);
      for (const gate of gates.values()) {
        if (gate.original.enteredAt || path !== gate.path) continue;
        if (path === "/api/real-world-services/consent") {
          if (!gate.protocolId || JSON.parse(request.body).protocolId !== gate.protocolId
            || actual.authoredByAuthenticatedParticipant !== true) continue;
        } else {
          if (actual.scope?.principalId !== gate.principalId) continue;
          if (path.endsWith("/read") && actual.scope?.workId !== gate.workId) continue;
        }
        await gate.hold(body, request.body); return;
      }
    },
    release() { for (const gate of gates.values()) gate.release() },
  };
}

type MountedInput = {
  installation: string;
  descriptor: any;
  auth: { origin: string; authOrigin: string; email: string; password: string;
    additionalIdentities: Array<{ actor: string; email: string; password: string }> };
  owner: string;
  participant: string;
  participantProtocolIds: string[];
  revokeProtocolId: string;
  companyId: string;
  alternateCompanyId: string;
  workId: string;
  expectedInstanceIds: string[];
  lastDirectRead: { elapsedMs: number; projectedInstances: number; exactWork: boolean } | null;
  installedReadTimings: readonly OwnerReadTiming[];
  barrier: ReturnType<typeof mountedResponseBarrier>;
  output: string;
  artifact: (name: string, value: unknown) => Promise<unknown>;
  run: (id: string, input: unknown, expected: unknown, action: () => Promise<unknown>) => Promise<unknown>;
  pump: () => Promise<void>;
  snapshot: () => Promise<unknown>;
  restartApi: () => Promise<unknown>;
  revokeOwner: (revoked: boolean) => Promise<"active" | "suspended">;
  createExpiringProtocol: () => Promise<{ protocolId: string; expiresAt: string; createdAt: string }>;
  refuseExpiredReport: (protocolId: string) => Promise<unknown>;
  checkBound: () => void;
};

export async function mountedServiceProof(input: MountedInput) {
  // Deliberately do not attach to Factory CDP, an existing browser or a saved
  // session. This context and its newly created /tmp profile are the only ones
  // this proof may close. Credentials never pass through page.evaluate.
  let context: BrowserContext | undefined, page: Page | undefined, profile: string | undefined;
  const browserProof: Record<string, unknown> = {
    method: "SEPARATELY_LAUNCHED_VISIBLE_HEADED_FRESH_PROFILE",
    embeddedPaneDeviation: "COORDINATOR_REQUIRED_2026_10_29",
    dependencyClass: "DECLARED_HOST_PLAYWRIGHT_MANAGED_VERIFICATION_BROWSER",
    headlessRequested: false, launched: false, profileRemoved: false,
    credentialEntry: "REAL_KEYBOARD_AND_RENDERED_LOGIN_BUTTON",
    credentialsRecorded: false, domCredentialInjection: false, savedSessionImported: false,
  };
  const inputEvents = { pointerActions: 0, keyboardActions: 0 };
  // These response summaries contain route classes and statuses only, never tokens,
  // request bodies, private Work content or browser storage.
  const mountedReadOutcomes: Array<{ route: string; status: number; responseStartMs: number | null }> = [];
  const serviceRequests = new Map<BrowserRequest, { began: number; status: number | null; responseMs: number | null; failed: boolean }>();
  const mountedNavigations: Array<{ path: string; queryKeys: string[] }> = [];
  const mountedRuntimeErrors: Array<{ name: string; category: string; property?: string }> = [];
  const mountedAuthResponses: Array<{ route: string; method: string; status: number; identityDenied: boolean }> = [];
  const currentPage = () => { assert(page, "W3_OWNED_HEADED_PAGE_REQUIRED"); return page };
  const evaluate = <Arg, Result>(read: (arg: Arg) => Result, arg: Arg) => {
    input.checkBound();
    // These arguments are plain values. Playwright also accepts handle arguments.
    return currentPage().evaluate<Result, Arg>(read as (arg: any) => Result, arg);
  };
  const wait = <Arg,>(predicate: (arg: Arg) => boolean, arg: Arg) => {
    input.checkBound();
    return currentPage().waitForFunction<boolean, Arg>(predicate as (arg: any) => boolean, arg, { timeout: 30000 });
  };
  const browser = async (args: string[]) => {
    input.checkBound();
    const active = currentPage();
    const argument = (index: number) => {
      const value = args[index];
      assert(typeof value === "string", "W3_BROWSER_ACTION_ARGUMENT_REQUIRED");
      return value;
    };
    switch (args[0]) {
      case "open":
        assert.equal(new URL(argument(1)).origin, origin, "W3_MOUNTED_LOOPBACK_ORIGIN_ONLY");
        return active.goto(argument(1), { waitUntil: "domcontentloaded", timeout: 30000 });
      case "wait":
        return active.locator(argument(1)).waitFor({ state: "visible", timeout: 30000 });
      case "fill":
        await active.locator(argument(1)).click(); inputEvents.pointerActions++;
        await active.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await active.keyboard.type(argument(2), { delay: 2 }); inputEvents.keyboardActions += 2;
        return;
      case "click":
        await active.locator(argument(1)).click(); inputEvents.pointerActions++; return;
      case "find":
        if (args[1] === "role") {
          assert.equal(args[2], "button");
          await active.getByRole("button", { name: argument(5), exact: true }).click();
        } else {
          assert.equal(args[1], "text");
          await active.getByText(argument(2), { exact: true }).click();
        }
        inputEvents.pointerActions++; return;
      case "set":
        assert.equal(args[1], "offline"); assert(context);
        return context.setOffline(args[2] === "on");
      case "screenshot":
        assert.equal(await active.locator("#centropy-login-password").isVisible(), false,
          "W3_NO_LOGIN_CREDENTIAL_SCREENSHOT");
        return active.screenshot({ path: argument(1), fullPage: true });
      default: throw Error("W3_UNSPECIFIED_BROWSER_ACTION:" + args[0]);
    }
  };
  const panel = `[data-testid="w3-service-panel"][data-w3-context="${input.workId}"]`;
  const participantPanel = `[data-testid="w3-service-panel"][data-w3-context="my-invitations"]`;
  const draftPrefix = "CONTROLLED_UNSUBMITTED_W3_DRAFT:";
  const rowCount = () => evaluate(selector => document.querySelectorAll(selector + " tbody tr").length, panel);
  const retainReadFailure = async (file: string) => {
    const cutoff = performance.now();
    const recentReads = [...serviceRequests].slice(-16);
    const serviceReads = recentReads.map(([, { began, status, responseMs, failed }]) => ({
      ageMs: Math.round(cutoff - began), responseMs, status, failed,
    }));
    const pendingRead = recentReads.reverse().find(([, row]) => row.status === null && !row.failed);
    // An absent row is not proof that fulfillment is absent. Retain the
    // exact mounted/transport boundary before propagating the original failure.
    const browserState = await currentPage().evaluate((selector: string) => {
      const service = document.querySelector(selector);
      const work = document.querySelector(".ct-world-work");
      const contextPanels = Array.from(document.querySelectorAll('[data-testid="w3-service-panel"]'));
      const locationUrl = new URL(location.href);
      const visibleRoot = document.querySelector(".ct-world");
      const auth = document.querySelector(".ct-auth-state");
      const authTitle = auth?.querySelector("h1")?.textContent?.trim();
      const authScreen = !auth ? "NONE"
        : auth.getAttribute("data-private-workspace-state") === "unavailable" ? "VISIBILITY_CLOSED"
        : auth.getAttribute("role") === "status" ? "AUTH_BOOTSTRAP"
        : authTitle === "Workspace unavailable" ? "AUTH_OR_ROLE_ERROR"
        : authTitle === "Participant workspace" ? "PARTICIPANT_SCOPE"
        : authTitle === "Your investment context stays private." ? "SESSION_MISSING"
        : "UNKNOWN_CLOSED_SCOPE";
      const authRejection = !!auth?.textContent?.includes("Your workspace access is no longer available.");
      return {
        authScreen, authRejection,
        pathname: locationUrl.pathname,
        queryKeys: [...locationUrl.searchParams.keys()]
          .filter(key => ["root", "object", "workId", "context", "threadId"].includes(key)).slice(0, 8),
        documentReady: document.readyState,
        visibility: document.visibilityState,
        appMounted: Boolean(document.querySelector(".ct-app")),
        workspaceError: Boolean(document.querySelector(".ct-auth-state")),
        workspaceUnavailable: Boolean(document.querySelector('[data-private-workspace-state="unavailable"]')),
        nextErrorOverlay: Boolean(document.querySelector("nextjs-portal")),
        mainMounted: Boolean(document.querySelector('main[aria-label="WORLD explorer"]')),
        visibleRoot: Boolean(visibleRoot),
        loginScreen: Boolean(document.querySelector("#centropy-login-email")),
        worldExplorer: Boolean(document.querySelector(".ct-world")),
        workRecord: Boolean(work),
        workRecordLoading: Boolean(work?.querySelector('[role="status"]')),
        workRecordAlert: Boolean(work?.querySelector('[role="alert"]')),
        serviceMounted: Boolean(service),
        serviceRowCount: service?.querySelectorAll("tbody tr").length ?? null,
        serviceStatus: Boolean(service?.querySelector('[role="status"]')),
        servicePanelCount: contextPanels.length,
        otherServicePanelCount: contextPanels.filter(p => p !== service).length,
        worldRootSelected: Boolean(document.querySelector('select[aria-label="Choose WORLD root"]')?.getAttribute("value")),
        workRecordTab: Boolean(document.querySelector('button[aria-current="page"]')),
      };
    }, panel).catch(() => ({ browserProbeUnavailable: true }));
    if (pendingRead) {
      // The verdict already failed. Observe the same request briefly to retain
      // its outcome when the browser assertion ends ahead of the owner deadline.
      const [request, row] = pendingRead;
      if (row.status === null && !row.failed) {
        await currentPage().waitForResponse(response => response.request() === request,
          { timeout: Math.max(1, Math.min(6000, 32000 - (performance.now() - row.began))) }).catch(() => null);
      }
    }
    const duration = (value: number | null) => value === null ? null : Math.round(value);
    await input.artifact("mounted/" + file + ".json", {
      schema: "finnor.w3.mounted-read-diagnostic.v1",
      browserState, routeStatuses: mountedReadOutcomes.slice(-60),
      serviceReads,
      lastDirectRead: input.lastDirectRead,
      installedApiReads: input.installedReadTimings.filter(sample => sample.receivedMs <= cutoff).slice(-16).map(sample => ({
        sequence: sample.sequence, receivedBeforeCutoffMs: Math.round(cutoff - sample.receivedMs),
        upstreamHeadersMs: duration(sample.upstreamHeadersMs), upstreamBodyMs: duration(sample.upstreamBodyMs),
        forwardedMs: duration(sample.forwardedMs), status: sample.upstreamStatus, clientClosed: sample.clientClosed,
      })),
      watchedAfterCutoff: pendingRead ? { status: pendingRead[1].status,
        responseMs: pendingRead[1].responseMs, failed: pendingRead[1].failed } : null,
      navigations: mountedNavigations.slice(-25),
      runtimeErrors: mountedRuntimeErrors.slice(-20),
      authResponses: mountedAuthResponses.slice(-75),
      noPrivateResponseBodiesOrTokens: true,
    });
  };
  const rendered = async () => {
    try {
      await wait(selector => document.querySelectorAll(selector + " tbody tr").length === 7, panel);
    } catch (error) {
      await retainReadFailure("first-render-failure").catch(() => undefined);
      throw error;
    }
    const view = await evaluate(({ selector, prefix }) => ({
      ids: Array.from(document.querySelectorAll<HTMLTableRowElement>(selector + " tbody tr")).map(x => x.cells[0]!.textContent),
      text: document.querySelector<HTMLElement>(selector)!.innerText,
      retainedDrafts: Array.from(document.querySelectorAll<HTMLTextAreaElement>('[data-testid="w3-service-panel"] textarea'))
        .filter(element => element.value.startsWith(prefix)).length,
      online: navigator.onLine, url: location.href
    }), { selector: panel, prefix: draftPrefix });
    assert.deepEqual([...view.ids].sort(), [...input.expectedInstanceIds].sort());
    assert.equal(view.retainedDrafts, 0, "W3_OLD_PRIVATE_DRAFT_REAPPEARED_AFTER_FRESH_READ");
    assert(view.text.includes("No field qualification or admission")
      && view.text.includes("Financially reconciled: false"));
    return view;
  };
  const seedDraft = async (boundary: string) => {
    const marker = draftPrefix + boundary;
    const form = panel + " > details:last-of-type";
    if (!await evaluate(selector => document.querySelector<HTMLDetailsElement>(selector)!.open, form)) {
      await browser(["click", form + " > summary"]);
    }
    await browser(["fill", panel + ' textarea[aria-label="Service request JSON"]', marker]);
    assert.equal(await evaluate(selector => document.querySelector<HTMLTextAreaElement>(selector + " textarea")!.value, panel), marker);
    return { marker, submitted: false };
  };
  const clear = async () => {
    await wait(selector => document.querySelectorAll(selector + " tbody tr").length === 0, panel);
    const retained = await evaluate(prefix => Array.from(document.querySelectorAll<HTMLTextAreaElement>('[data-testid="w3-service-panel"] textarea'))
      .filter(element => element.value.startsWith(prefix)).length, draftPrefix);
    assert.equal(retained, 0, "W3_OLD_PRIVATE_DRAFT_REAPPEARED");
  };
  const root = (companyId: string) => ({ entityType: "external_organization", entityId: companyId });
  const workUrl = (companyId = input.companyId, selected = true) => {
    const url = new URL("/centropy/world", origin);
    url.searchParams.set("root", JSON.stringify(root(companyId)));
    if (selected) {
      url.searchParams.set("object", JSON.stringify({ namespace: "core", type: "work",
        id: input.workId, owner: "@finnor/db" }));
      url.searchParams.set("workId", input.workId);
    }
    return url.href;
  };
  const manifest = JSON.parse(await readFile(join(input.installation, input.descriptor.frontend.manifest), "utf8"));
  const origin = manifest.frontendOrigin;
  assert.equal(origin, input.descriptor.frontend.origin);
  const chooseRoot = async (companyId: string, selectWork: boolean) => {
    const key = "external_organization:" + companyId;
    const selector = 'select[aria-label="Choose WORLD root"]';
    await wait(({ selector, key }) => Array.from(document.querySelector<HTMLSelectElement>(selector)?.options ?? [])
      .some(option => option.value === key), { selector, key });
    const control = currentPage().locator(selector);
    const selection = await control.evaluate((element, expected) => {
      const select = element as HTMLSelectElement;
      return { current: select.selectedIndex,
        target: Array.from(select.options).findIndex(option => option.value === expected) };
    }, key);
    assert(selection.target >= 0);
    // The native select is operated with pointer/keyboard, never a router,
    // pushState, React state or DOM value assignment.
    await control.click(); inputEvents.pointerActions++;
    const delta = selection.target - selection.current;
    for (let i = 0; i < Math.abs(delta); i++) {
      await currentPage().keyboard.press(delta > 0 ? "ArrowDown" : "ArrowUp");
      inputEvents.keyboardActions++;
    }
    await currentPage().keyboard.press("Enter"); inputEvents.keyboardActions++;
    await wait(id => {
      const value = new URL(location.href).searchParams.get("root");
      return Boolean(value && JSON.parse(value).entityId === id);
    }, companyId);
    if (selectWork) {
      const work = currentPage().locator(".ct-world__objects button")
        .filter({ hasText: "seven-day cook continuity assignment" });
      await work.waitFor({ state: "visible" });
      assert.equal(await work.count(), 1, "W3_ORIGINAL_WORK_CONTROL_MUST_BE_UNIQUE");
      await work.click(); inputEvents.pointerActions++;
      await wait(id => {
        const value = new URL(location.href).searchParams.get("object");
        return Boolean(value && JSON.parse(value).id === id);
      }, input.workId);
    }
  };
  const host = spawn(process.execPath, [join(input.installation, input.descriptor.entrypoints.w3Frontend),
    "--api-origin", input.auth.origin, "--auth-origin", input.auth.authOrigin], {
    cwd: input.installation, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let hostLog = "", hostReady: any;
  host.stdout!.on("data", b => { hostLog += b; if (hostLog.length > 1048576) host.kill("SIGKILL") });
  host.stderr!.on("data", b => { hostLog += b; if (hostLog.length > 1048576) host.kill("SIGKILL") });
  const hostStarted = performance.now();
  const screenshot = async (name: string) => {
    const path = join(input.output, "mounted", name + ".png");
    await mkdir(dirname(path), { recursive: true });
    await browser(["screenshot", path]);
    return path;
  };
  const login = async (who: string) => {
    const identity = who === input.owner ? input.auth : input.auth.additionalIdentities.find(i => i.actor === who);
    assert(identity, "W3_MOUNTED_ORIGINAL_SIGNED_IDENTITY_REQUIRED");
    await browser(["open", origin + "/centropy/login"]);
    await browser(["wait", "#centropy-login-email"]);
    await browser(["fill", "#centropy-login-email", identity.email]);
    // Real keyboard events into the ordinary password control. No credential
    // string is evaluated, passed on a command line, traced or put in evidence.
    await browser(["fill", "#centropy-login-password", identity.password]);
    await browser(["find", "role", "button", "click", "--name", "Sign in", "--exact"]);
    await wait(() => !location.pathname.endsWith("/login"), undefined);
  };
  const logout = async () => {
    await browser(["click", 'summary[aria-label="Account menu"]']);
    const active = currentPage();
    const providerLogout = active.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === origin && url.pathname === "/auth/v1/logout"
        && response.request().method() === "POST" && [200, 204].includes(response.status());
    });
    const [response] = await Promise.all([
      providerLogout, browser(["find", "role", "button", "click", "--name", "Sign out", "--exact"]),
    ]);
    assert.equal(await response.finished(), null, "W3_PROVIDER_LOGOUT_RESPONSE_INCOMPLETE");
    const signedOut = active.locator(".ct-auth-state").getByRole("link", { name: "Sign in", exact: true });
    await signedOut.waitFor({ state: "visible" });
    assert.equal(await signedOut.getAttribute("href"), "/centropy/login");
    assert.equal(await active.locator(".ct-topbar").count(), 0, "W3_SIGNED_OUT_OWNER_SHELL_STILL_MOUNTED");
  };
  const prepare = (id: string) => {
    const hold = input.barrier.arm(id, input.owner, input.workId);
    return hold;
  };
  const entered = async (hold: ReturnType<typeof prepare>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([hold.entered, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("W3_MOUNTED_REAL_RESPONSE_NOT_OBSERVED:" + hold.original.id)), 15000);
      })]);
    } catch (error) {
      await retainReadFailure("read-barrier-" + hold.original.id).catch(() => undefined);
      throw error;
    } finally { if (timer) clearTimeout(timer) }
    return hold;
  };
  const arm = (id: string) => entered(prepare(id));
  const freshReturn = async (id: string, action: () => Promise<unknown>) => {
    const hold = prepare(id);
    await action(); await entered(hold); await clear();
    assert.equal(await rowCount(), 0, "W3_ORIGINAL_ROWS_APPEARED_BEFORE_FRESH_RESPONSE");
    hold.release(); await hold.done;
    assert.equal(hold.original.automatic, false);
    return rendered();
  };
  let offline = false, revoked = false;
  let proofFailure: unknown;
  try {
    while (performance.now() - hostStarted < 30000) {
      assert(host.exitCode === null && host.signalCode === null, "W3_EMITTED_FRONTEND_HOST_EXITED:" + hostLog);
      const line = hostLog.split("\n").find(line => line.startsWith('{"event":"X1_FRONTEND_READY"'));
      if (line) { hostReady = JSON.parse(line); break }
      await new Promise(yes => setTimeout(yes, 100));
    }
    assert(hostReady?.compiled && hostReady.authBypass === false, "W3_EMITTED_FRONTEND_STARTUP_BOUND:" + hostLog);
    // xvfb-run owns this display and cookie for the confined verification process.
    const { DISPLAY, XAUTHORITY } = process.env;
    assert(DISPLAY && XAUTHORITY, "W3_HEADED_DISPLAY_AND_AUTHORITY_REQUIRED");
    profile = await mkdtemp("/tmp/finnor-w3-headed-");
    const executablePath = chromium.executablePath();
    context = await chromium.launchPersistentContext(profile, {
      headless: false, executablePath, viewport: { width: 1440, height: 1000 },
      // D033: Chromium answers CDP Browser.getBrowserCommandLine only under
      // --enable-automation (attempt 013 retained the refusal); the unchanged
      // custody assertions below require the browser's own command line.
      args: ["--window-size=1440,1000", "--enable-automation"], timeout: 30000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile, TMPDIR: "/tmp", LANG: "en_US.UTF-8", DISPLAY, XAUTHORITY },
    });
    context.setDefaultTimeout(30000);
    page = context.pages()[0] ?? await context.newPage();
    page.on("framenavigated", frame => {
      if (!page || frame !== page.mainFrame()) return;
      try {
        const target = new URL(frame.url());
        if (target.origin !== origin) return;
        mountedNavigations.push({ path: target.pathname,
          queryKeys: [...target.searchParams.keys()].filter(key =>
            ["root", "object", "workId", "context", "threadId"].includes(key)).slice(0, 8) });
      } catch { /* Browser can navigate through opaque URLs. */ }
    });
    page.on("pageerror", error => {
      const message = error.message ?? "";
      const name = ["TypeError", "ReferenceError", "RangeError", "SyntaxError", "Error"].includes(error.name) ? error.name : "Other";
      const category = /Cannot read properties of (undefined|null)/.test(message) ? "NULLISH_PROPERTY_ACCESS"
        : /Maximum update depth/.test(message) ? "REACT_UPDATE_LOOP"
        : /Minified React error/.test(message) ? "REACT_RUNTIME_ERROR"
        : /hydration/i.test(message) ? "HYDRATION_ERROR"
        : /is not defined/.test(message) ? "UNDEFINED_IDENTIFIER"
        : /Invalid hook call/.test(message) ? "HOOK_ERROR" : "OTHER_RUNTIME_ERROR";
      const readProperty = /reading ['"]([a-zA-Z][a-zA-Z0-9_]{0,60})['"]/.exec(message)?.[1];
      mountedRuntimeErrors.push({ name, category,
        ...(readProperty ? { property: readProperty } : {}) });
    });
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/centropy/real-world-services/read"
          && serviceRequests.size < 128) serviceRequests.set(request, {
        began: performance.now(), status: null, responseMs: null, failed: false,
      });
    });
    page.on("requestfailed", request => {
      const service = serviceRequests.get(request);
      if (service) service.failed = true;
    });
    page.on("response", response => {
      let path = "";
      try { path = new URL(response.url()).pathname } catch { return }
      const status = response.status();
      const service = serviceRequests.get(response.request());
      if (service) {
        service.status = status;
        service.responseMs = Math.round(performance.now() - service.began);
      }
      if (path.startsWith("/api/centropy/") && (status >= 400 || path === "/api/centropy/me")) {
        const routeParts = path.slice("/api/centropy/".length).split("/").slice(0, 3);
        const route = routeParts.map(part => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part) ? ":id"
          : /^[a-z][a-z0-9-]{0,50}$/.test(part) ? part : ":part").join("/");
        const identityDenied = response.headers()["x-finnor-identity-state"] === "denied";
        mountedAuthResponses.push({ route, method: response.request().method(), status, identityDenied });
      } else if (path.startsWith("/auth/v1/") && status >= 400) {
        mountedAuthResponses.push({ route: "AUTH_SESSION", method: response.request().method(), status, identityDenied: false });
      }
      const route = /^\/api\/centropy\/works\/[^/]+$/.test(path) ? "work-record"
        : path === "/api/centropy/real-world-services/read" ? "service-read"
        : path === "/api/centropy/real-world-services/inbox" ? "service-inbox"
        : path === "/api/centropy/company-brain/project" ? "world-projection" : null;
      if (route) {
        const responseStart = response.request().timing().responseStart;
        mountedReadOutcomes.push({ route, status, responseStartMs: Number.isFinite(responseStart) && responseStart >= 0
          ? Math.round(responseStart) : null });
      }
    });
    await page.bringToFront();
    await wait(() => document.visibilityState === "visible", undefined);
    const cdp = await context.newCDPSession(page);
    const version = await cdp.send("Browser.getVersion");
    const commandLine = await cdp.send("Browser.getBrowserCommandLine");
    assert(!commandLine.arguments.some(argument => argument.startsWith("--headless")), "W3_HEADLESS_BROWSER_REFUSED");
    assert(commandLine.arguments.includes("--user-data-dir=" + profile), "W3_EXACT_NEW_PROFILE_REQUIRED");
    await cdp.detach();
    const require = createRequire(import.meta.url);
    Object.assign(browserProof, {
      launched: true, launchedAt: new Date().toISOString(), product: version.product,
      protocolVersion: version.protocolVersion, userAgent: version.userAgent,
      executablePath, executableSha256: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
      playwrightVersion: require("playwright/package.json").version, profile,
      actualCommandLineHeadless: false, actualCommandLineOwnProfile: true,
      visibilityState: await evaluate(() => document.visibilityState, undefined),
    });
    const allowedOrigins = new Set([origin, input.auth.origin, input.auth.authOrigin]);
    await context.route("**/*", route => allowedOrigins.has(new URL(route.request().url()).origin)
      ? route.continue() : route.abort("blockedbyclient"));
    await login(input.owner);
    await browser(["open", origin + "/centropy/world"]);
    await chooseRoot(input.companyId, true);
    await input.run("W052-emitted-mounted-original-Work", { companyId: input.companyId, workId: input.workId },
      { emittedNext: true, visibleHeadedFreshProfile: true, originalInstances: 7, noFieldClaim: true }, async () => {
        const view = await rendered();
        const tools = currentPage().getByText("Other Work tools", { exact: true });
        assert(await tools.isVisible(), "W3_ADDITIONAL_WORK_TOOLS_MUST_REMAIN_REACHABLE");
        assert(await tools.evaluate(summary => summary.parentElement?.matches("details:not([open])")),
          "W3_INITIAL_WORK_READ_MUST_NOT_OPEN_OTHER_TOOLS");
        return { hostReady, browser: browserProof, view, screenshot: await screenshot("original-Work"), durable: await input.snapshot() };
      });
    await input.run("W052-mounted-native-continuation", { workId: input.workId },
      { actualAuthorizedAdvanceAndWorker: true }, async () => {
        const before = await input.snapshot();
        await browser(["find", "role", "button", "click", "--name", "Revalidate native continuation", "--exact"]);
        await rendered(); await input.pump();
        const after = await input.snapshot();
        assert.notDeepEqual(after, before, "W3_MOUNTED_CONTINUATION_DID_NOT_CHANGE_DURABLE_QUEUE");
        return { before, after, view: await rendered() };
      });
    await input.run("W052-real-offline-and-fresh-return", { boundary: "actual browser offline" },
      { staleProgrammeHidden: true, privateDraftHidden: true, freshOriginalRequired: true }, async () => {
        const draft = await seedDraft("offline");
        const hold = await arm("actual-offline");
        await browser(["set", "offline", "on"]); offline = true;
        await clear(); hold.release(); await hold.done;
        assert.equal(hold.original.automatic, false);
        assert.equal(await rowCount(), 0);
        assert.equal(await evaluate(() => navigator.onLine, undefined), false);
        const view = await freshReturn("fresh-after-offline", async () => {
          await browser(["set", "offline", "off"]); offline = false;
        });
        return { draft, view, barrier: input.barrier.receipts() };
      });
    await input.run("W052-root-A-B-A-no-old-response", { original: input.companyId, alternate: input.alternateCompanyId },
      { oldRootCannotRepopulate: true, privateDraftHidden: true }, async () => {
        const draft = await seedDraft("root-A-B-A");
        const hold = await arm("root-A-B-A");
        await chooseRoot(input.alternateCompanyId, false);
        await clear(); hold.release(); await hold.done;
        assert.equal(hold.original.automatic, false); assert.equal(await rowCount(), 0);
        const view = await freshReturn("fresh-after-root-return", () => chooseRoot(input.companyId, true));
        return { draft, view, barrier: input.barrier.receipts() };
      });
    await input.run("W052-logout-principal-A-B-A", { owner: input.owner, participant: input.participant },
      { noOldOwnerProgramme: true, privateDraftHidden: true, participantInboxOnly: true, freshReturn: true }, async () => {
        const draft = await seedDraft("principal-A-B-A");
        const hold = await arm("logout-A-B-A");
        await logout(); await clear(); hold.release(); await hold.done;
        assert.equal(hold.original.automatic, false);
        await login(input.participant);
        await browser(["open", workUrl()]);
        await clear();
        await wait(() => Array.from(document.querySelectorAll("summary"))
          .some(x => x.textContent?.includes("My purpose-bound service invitations")), undefined);
        await browser(["find", "text", "My purpose-bound service invitations", "click", "--exact"]);
        await wait(({ selector, expected }) => {
          const actual = Array.from(document.querySelectorAll(selector + " [data-w3-protocol-id]"))
            .map(element => element.getAttribute('data-w3-protocol-id'));
          return actual.length === expected.length && expected.every(id => actual.includes(id));
        }, { selector: participantPanel, expected: input.participantProtocolIds });
        const participantView = await evaluate(({ ownerPanel, inboxPanel }) => ({
          ownerProgrammeRows: document.querySelectorAll(ownerPanel + " tbody tr").length,
          protocols: Array.from(document.querySelectorAll(inboxPanel + " [data-w3-protocol-id]")).map(element => ({
            id: element.getAttribute('data-w3-protocol-id'),
            state: element.getAttribute('data-w3-protocol-state'),
            disclosure: element.querySelector('pre') ? JSON.parse(element.querySelector('pre')!.textContent!) : null
          }))
        }), { ownerPanel: panel, inboxPanel: participantPanel });
        assert.equal(participantView.ownerProgrammeRows, 0);
        assert.deepEqual(participantView.protocols.map((p: any) => p.id).sort(), [...input.participantProtocolIds].sort());
        for (const protocol of participantView.protocols) {
          assert.equal(protocol.disclosure?.scope.workId, input.workId);
          assert.equal(protocol.disclosure.scope.companyId, input.companyId);
          for (const forbidden of ["originalMeaning", "parentPolicy", "parentAllocation", "mandateSource"])
            assert(!Object.hasOwn(protocol.disclosure, forbidden));
        }
        await input.run("W052-participant-exact-purpose-and-consent-revocation",
          { protocolId: input.revokeProtocolId, participantId: input.participant },
          { actualParticipantControl: true, historicalReceiptOnly: true, ownerWorkHidden: true }, async () => {
            const selector = `${participantPanel} [data-w3-protocol-id="${input.revokeProtocolId}"]`;
            await browser(["click", selector + " summary"]);
            await input.run("W052-inbox-read-cannot-cross-consent-write",
              { protocolId: input.revokeProtocolId, order: ["completed old inbox", "committed revocation", "old inbox released", "write response released"] },
              { preWriteDisclosureNotResurrected: true, freshRevokedReceiptRequired: true }, async () => {
                const inbox = input.barrier.arm("pre-revocation-inbox", input.participant, input.workId,
                  "/api/real-world-services/inbox");
                const consent = input.barrier.arm("committed-participant-revocation", input.participant, input.workId,
                  "/api/real-world-services/consent", input.revokeProtocolId);
                try {
                  await entered(inbox);
                  await browser(["click", selector + " button:nth-of-type(2)"]);
                  await entered(consent);
                  await wait(query => !document.querySelector(query), selector);
                  const received = currentPage().waitForResponse(response =>
                    new URL(response.url()).pathname === "/api/centropy/real-world-services/inbox" && response.status() === 200);
                  inbox.release(); await inbox.done;
                  assert.equal(inbox.original.automatic, false);
                  const old = await received;
                  assert.equal(await old.finished(), null, "W3_ORIGINAL_INBOX_RESPONSE_NOT_DELIVERED");
                  assert.equal(createHash("sha256").update(await old.body()).digest("hex"), inbox.original.bodyDigest);
                  // Observe rendered state after the real response has crossed
                  // fetch/JSON and React commits, while the write stays held.
                  await currentPage().evaluate(() => new Promise<void>(done =>
                    requestAnimationFrame(() => requestAnimationFrame(() => done()))));
                  const stale = await evaluate(query => ({
                    disclosureCount: document.querySelector(query)?.querySelectorAll('pre').length ?? 0,
                    state: document.querySelector(query)?.getAttribute('data-w3-protocol-state') ?? null,
                    buttonCount: document.querySelector(query)?.querySelectorAll('button').length ?? 0
                  }), selector);
                  await input.artifact("mounted/pre-write-inbox-after-revocation.json", {
                    stale, barriers: input.barrier.receipts(), writeResponseStillHeld: !consent.original.releasedAt });
                  assert.equal(stale.disclosureCount, 0, "W3_PRE_WRITE_INBOX_RESURRECTED_OPERATIONAL_DISCLOSURE");
                  assert.equal(stale.buttonCount, 0, "W3_PRE_WRITE_INBOX_RESURRECTED_PROTOCOL_CONTROLS");
                  assert.equal(consent.original.automatic, false);
                  consent.release(); await consent.done;
                  return { stale, barriers: input.barrier.receipts() };
                } finally { inbox.release(); consent.release(); await Promise.all([inbox.done, consent.done]) }
              });
            await wait(query => document.querySelector(query)?.getAttribute("data-w3-protocol-state") === "REVOKED", selector);
            // The consent write clears the prior disclosure and its open state.
            await browser(["click", selector + " > summary"]);
            const receipt = await evaluate(query => {
              const protocol = document.querySelector<HTMLDetailsElement>(query)!;
              return { open: protocol.open, text: protocol.innerText, disclosureCount: protocol.querySelectorAll("pre").length,
                disabled: Array.from(protocol.querySelectorAll("button")).every(x => x.disabled) };
            }, selector);
            assert.equal(receipt.open, true);
            assert.equal(receipt.disclosureCount, 0); assert.equal(receipt.disabled, true);
            assert(receipt.text.includes("Historical protocol receipt only"), "W3_VISIBLE_REVOKED_RECEIPT_REQUIRED");
            assert.equal(await rowCount(), 0); await input.pump();
            return { participantView, receipt, durable: await input.snapshot() };
          });
        await input.run("W052-wall-time-protocol-expiry", { wallClock: "REAL_NOT_CONTROLLED_SERVICE_TIME" },
          { actuallyConsentedThenExpired: true, disclosureRemoved: true, authenticatedLateReportRefused: true }, async () => {
            const protocol = await input.createExpiringProtocol();
            assert(Date.parse(protocol.expiresAt) > Date.parse(protocol.createdAt));
            const selector = `${participantPanel} [data-w3-protocol-id="${protocol.protocolId}"]`;
            await wait(query => document.querySelector(query)?.getAttribute("data-w3-protocol-state") === "INVITED", selector);
            await browser(["click", selector + " summary"]);
            await browser(["click", selector + " button:nth-of-type(1)"]);
            await wait(query => document.querySelector(query)?.getAttribute("data-w3-protocol-state") === "CONSENTED", selector);
            await wait(({ query, expiry }) => Date.now() >= expiry
              && document.querySelector(query)?.getAttribute("data-w3-protocol-state") === "EXPIRED",
            { query: selector, expiry: Date.parse(protocol.expiresAt) });
            const receipt = await evaluate(query => {
              const protocol = document.querySelector(query)!;
              return { observedAt: new Date().toISOString(), disclosureCount: protocol.querySelectorAll("pre").length,
                disabled: Array.from(protocol.querySelectorAll("button")).every(x => x.disabled) };
            }, selector);
            assert(Date.parse(receipt.observedAt) >= Date.parse(protocol.expiresAt));
            assert.equal(receipt.disclosureCount, 0); assert.equal(receipt.disabled, true);
            const refusal = await input.refuseExpiredReport(protocol.protocolId);
            assert.equal(await rowCount(), 0);
            return { protocol, receipt, refusal, durable: await input.snapshot() };
          });
        await logout();
        const returned = await freshReturn("fresh-after-principal-return", async () => {
          await login(input.owner); await browser(["open", workUrl()]);
        });
        return { draft, participantView, returned, barrier: input.barrier.receipts() };
      });
    await input.run("W052-emitted-reopen-and-API-restart", { workId: input.workId },
      { restoredActualSessionAndOriginalWork: true }, async () => {
        const restart = await input.restartApi();
        const view = await freshReturn("fresh-after-API-restart", () => browser(["open", workUrl()]));
        return { restart, view, durable: await input.snapshot(),
          screenshot: await screenshot("restored-original-Work") };
      });
    await input.run("W052-revoked-authority-no-late-response", { owner: input.owner },
      { alreadySuccessfulOldResponseCannotRestore: true, privateDraftHidden: true }, async () => {
        const draft = await seedDraft("authority-revoked");
        const hold = await arm("authority-revocation");
        const ownerStatus = await input.revokeOwner(true); revoked = true;
        assert.equal(ownerStatus, "suspended");
        // A real reload expires the rendered private scope. The retained old
        // response is delivered only after the new authority has been refused.
        const denied = currentPage().waitForResponse(response =>
          new URL(response.url()).pathname === "/api/centropy/me"
          && response.request().method() === "GET" && [401, 403].includes(response.status())
          && response.headers()["x-finnor-identity-state"] === "denied", { timeout: 15000 });
        const [refusal] = await Promise.all([denied, browser(["open", workUrl()])]);
        assert.equal(await refusal.finished(), null, "W3_AUTHORITY_REFUSAL_RESPONSE_INCOMPLETE");
        await clear(); hold.release(); await hold.done;
        assert.equal(hold.original.automatic, false);
        await wait(id => !document.body.innerText.includes(id), input.expectedInstanceIds[0]!);
        return { draft, ownerStatus, refusalStatus: refusal.status(), barrier: input.barrier.receipts(), durable: await input.snapshot(),
          screenshot: await screenshot("authority-refused") };
      });
  } catch (error) {
    proofFailure = error;
    throw error;
  } finally {
    input.barrier.release();
    const failures: Array<{ step: string; error: unknown }> = [];
    const cleanup = async (step: string, action: () => Promise<unknown>) => {
      try { await action() } catch (error) { failures.push({ step, error }) }
    };
    const safeFailure = (error: unknown) => {
      let detail = error instanceof Error ? error.name + ": " + error.message : String(error);
      for (const identity of [input.auth, ...input.auth.additionalIdentities])
        if (identity.password) detail = detail.split(identity.password).join("<credential-redacted>");
      return detail.slice(0, 4000);
    };
    if (offline) await cleanup("restore-owned-network", async () => context?.setOffline(false));
    if (revoked) await cleanup("restore-disposable-principal", () => input.revokeOwner(false));
    const ownedContext = context;
    let closed = !ownedContext;
    if (ownedContext) await cleanup("close-owned-context", async () => {
      await ownedContext.close(); closed = true; browserProof.closedAt = new Date().toISOString();
    });
    const ownedProfile = profile;
    if (ownedProfile && closed) await cleanup("remove-owned-profile", async () => {
      await rm(ownedProfile, { recursive: true, force: true }); browserProof.profileRemoved = true;
    });
    browserProof.profileCleanupDeferred = !!profile && !closed;
    browserProof.cleanupFailures = failures.map(({ step, error }) => ({ step, error: safeFailure(error) }));
    browserProof.primaryFailure = proofFailure === undefined ? null : safeFailure(proofFailure);
    await cleanup("retain-host-receipt", () => input.artifact("mounted/host.json", {
      ready: hostReady ?? null, log: hostLog, browser: browserProof, inputEvents, credentialsRecorded: false }));
    await cleanup("retain-barrier-receipts", () => input.artifact("mounted/barriers.json", input.barrier.receipts()));
    await cleanup("stop-owned-frontend", () => stop(host));
    if (failures.length) throw new AggregateError([
      ...(proofFailure === undefined ? [] : [proofFailure]), ...failures.map(f => f.error),
    ], "W3_MOUNTED_CLEANUP_FAILED:" + failures.map(f => f.step).join(",")
      + (proofFailure === undefined ? "" : "; original=" + safeFailure(proofFailure)));
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(yes => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); yes() }, 7000);
    child.once("exit", () => { clearTimeout(timer); yes() });
  });
}
