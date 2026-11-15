/** Real emitted Next, signed disposable auth and production API/SQL only.
 * Predicates are specified in mounted-proof-contract.md, before this driver.
 * A barrier holds a completed original response; it never supplies a response. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium, type BrowserContext, type Page } from "playwright";

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
  barrier: ReturnType<typeof mountedResponseBarrier>;
  output: string;
  artifact: (name: string, value: unknown) => Promise<unknown>;
  run: (id: string, input: unknown, expected: unknown, action: () => Promise<unknown>) => Promise<unknown>;
  pump: () => Promise<void>;
  snapshot: () => Promise<unknown>;
  restartApi: () => Promise<unknown>;
  revokeOwner: (revoked: boolean) => Promise<void>;
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
  const currentPage = () => { assert(page, "W3_OWNED_HEADED_PAGE_REQUIRED"); return page };
  const evaluate = (source: string): Promise<any> => { input.checkBound(); return currentPage().evaluate(source) };
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
        return args[1] === "--fn"
          ? active.waitForFunction(argument(2), undefined, { timeout: 30000 })
          : active.locator(argument(1)).waitFor({ state: "visible", timeout: 30000 });
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
  const rowCount = () => evaluate(`document.querySelectorAll('${panel} tbody tr').length`);
  const wait = (predicate: string) => browser(["wait", "--fn", predicate]);
  const rendered = async () => {
    await wait(`document.querySelectorAll('${panel} tbody tr').length === 7`);
    const view: any = await evaluate(`({
      ids: Array.from(document.querySelectorAll('${panel} tbody tr')).map(x => x.cells[0].textContent),
      text: document.querySelector('${panel}').innerText,
      retainedDrafts: Array.from(document.querySelectorAll('[data-testid="w3-service-panel"] textarea'))
        .filter(element => element.value.startsWith(${JSON.stringify(draftPrefix)})).length,
      online: navigator.onLine, url: location.href
    })`);
    assert.deepEqual([...view.ids].sort(), [...input.expectedInstanceIds].sort());
    assert.equal(view.retainedDrafts, 0, "W3_OLD_PRIVATE_DRAFT_REAPPEARED_AFTER_FRESH_READ");
    assert(view.text.includes("No field qualification or admission")
      && view.text.includes("Financially reconciled: false"));
    return view;
  };
  const seedDraft = async (boundary: string) => {
    const marker = draftPrefix + boundary;
    const form = panel + " > details:last-of-type";
    if (!await evaluate(`document.querySelector('${form}').open`)) await browser(["click", form + " > summary"]);
    await browser(["fill", panel + ' textarea[aria-label="Service request JSON"]', marker]);
    assert.equal(await evaluate(`document.querySelector('${panel} textarea').value`), marker);
    return { marker, submitted: false };
  };
  const clear = async () => {
    await wait(`document.querySelectorAll('${panel} tbody tr').length === 0`);
    const retained = await evaluate(`Array.from(document.querySelectorAll('[data-testid="w3-service-panel"] textarea'))
      .filter(element => element.value.startsWith(${JSON.stringify(draftPrefix)})).length`);
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
    await wait(`Array.from(document.querySelector('${selector}')?.options ?? []).some(option => option.value === ${JSON.stringify(key)})`);
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
    await wait(`(() => {
      const value = new URL(location.href).searchParams.get('root');
      return value && JSON.parse(value).entityId === ${JSON.stringify(companyId)};
    })()`);
    if (selectWork) {
      const work = currentPage().locator(".ct-world__objects button")
        .filter({ hasText: "seven-day cook continuity assignment" });
      await work.waitFor({ state: "visible" });
      assert.equal(await work.count(), 1, "W3_ORIGINAL_WORK_CONTROL_MUST_BE_UNIQUE");
      await work.click(); inputEvents.pointerActions++;
      await wait(`(() => {
        const value = new URL(location.href).searchParams.get('object');
        return value && JSON.parse(value).id === ${JSON.stringify(input.workId)};
      })()`);
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
    await wait(`!location.pathname.endsWith('/login')`);
  };
  const logout = async () => {
    await browser(["click", 'summary[aria-label="Account menu"]']);
    await browser(["find", "role", "button", "click", "--name", "Sign out", "--exact"]);
    await browser(["wait", "#centropy-login-email"]);
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
    profile = await mkdtemp("/tmp/finnor-w3-headed-");
    const executablePath = chromium.executablePath();
    context = await chromium.launchPersistentContext(profile, {
      headless: false, executablePath, viewport: { width: 1440, height: 1000 },
      // D033: Chromium answers CDP Browser.getBrowserCommandLine only under
      // --enable-automation (attempt 013 retained the refusal); the unchanged
      // custody assertions below require the browser's own command line.
      args: ["--window-size=1440,1000", "--enable-automation"], timeout: 30000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile, TMPDIR: "/tmp", LANG: "en_US.UTF-8" },
    });
    context.setDefaultTimeout(30000);
    page = context.pages()[0] ?? await context.newPage();
    await page.bringToFront();
    await wait("document.visibilityState === 'visible'");
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
      visibilityState: await evaluate("document.visibilityState"),
    });
    const allowedOrigins = new Set([origin, input.auth.origin, input.auth.authOrigin]);
    await context.route("**/*", route => allowedOrigins.has(new URL(route.request().url()).origin)
      ? route.continue() : route.abort("blockedbyclient"));
    await login(input.owner);
    await browser(["open", origin + "/centropy/world"]);
    await chooseRoot(input.companyId, true);
    await input.run("W052-emitted-mounted-original-Work", { companyId: input.companyId, workId: input.workId },
      { emittedNext: true, visibleHeadedFreshProfile: true, originalInstances: 7, noFieldClaim: true }, async () => ({
        hostReady, browser: browserProof, view: await rendered(), screenshot: await screenshot("original-Work"), durable: await input.snapshot(),
      }));
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
        assert.equal(await evaluate("navigator.onLine"), false);
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
        await wait(`Array.from(document.querySelectorAll('summary')).some(x => x.textContent.includes('My purpose-bound service invitations'))`);
        await wait(`(() => {
          const actual = Array.from(document.querySelectorAll('${participantPanel} [data-w3-protocol-id]'))
            .map(element => element.getAttribute('data-w3-protocol-id'));
          const expected = ${JSON.stringify(input.participantProtocolIds)};
          return actual.length === expected.length && expected.every(id => actual.includes(id));
        })()`);
        const participantView = await evaluate(`({
          ownerProgrammeRows: document.querySelectorAll('${panel} tbody tr').length,
          protocols: Array.from(document.querySelectorAll('${participantPanel} [data-w3-protocol-id]')).map(element => ({
            id: element.getAttribute('data-w3-protocol-id'),
            state: element.getAttribute('data-w3-protocol-state'),
            disclosure: element.querySelector('pre') ? JSON.parse(element.querySelector('pre').textContent) : null
          }))
        })`);
        assert.equal(participantView.ownerProgrammeRows, 0);
        assert.deepEqual(participantView.protocols.map((p: any) => p.id).sort(), [...input.participantProtocolIds].sort());
        for (const protocol of participantView.protocols) {
          assert.equal(protocol.disclosure?.scope.workId, input.workId);
          assert.equal(protocol.disclosure.scope.companyId, input.companyId);
          for (const forbidden of ["originalMeaning", "parentPolicy", "parentAllocation", "mandateSource"])
            assert(!Object.hasOwn(protocol.disclosure, forbidden));
        }
        await browser(["find", "text", "My purpose-bound service invitations", "click", "--exact"]);
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
                  await wait(`!document.querySelector('${selector}')`);
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
                  const stale = await evaluate(`({
                    disclosureCount: document.querySelector('${selector}')?.querySelectorAll('pre').length ?? 0,
                    state: document.querySelector('${selector}')?.getAttribute('data-w3-protocol-state') ?? null,
                    buttonCount: document.querySelector('${selector}')?.querySelectorAll('button').length ?? 0
                  })`);
                  await input.artifact("mounted/pre-write-inbox-after-revocation.json", {
                    stale, barriers: input.barrier.receipts(), writeResponseStillHeld: !consent.original.releasedAt });
                  assert.equal(stale.disclosureCount, 0, "W3_PRE_WRITE_INBOX_RESURRECTED_OPERATIONAL_DISCLOSURE");
                  assert.equal(stale.buttonCount, 0, "W3_PRE_WRITE_INBOX_RESURRECTED_PROTOCOL_CONTROLS");
                  assert.equal(consent.original.automatic, false);
                  consent.release(); await consent.done;
                  return { stale, barriers: input.barrier.receipts() };
                } finally { inbox.release(); consent.release(); await Promise.all([inbox.done, consent.done]) }
              });
            await wait(`document.querySelector('${selector}')?.getAttribute('data-w3-protocol-state') === 'REVOKED'`);
            const receipt = await evaluate(`({
              text: document.querySelector('${selector}').innerText,
              disclosureCount: document.querySelector('${selector}').querySelectorAll('pre').length,
              disabled: Array.from(document.querySelector('${selector}').querySelectorAll('button')).every(x => x.disabled)
            })`);
            assert.equal(receipt.disclosureCount, 0); assert.equal(receipt.disabled, true);
            assert(receipt.text.includes("Historical protocol receipt only"));
            assert.equal(await rowCount(), 0); await input.pump();
            return { participantView, receipt, durable: await input.snapshot() };
          });
        await input.run("W052-wall-time-protocol-expiry", { wallClock: "REAL_NOT_CONTROLLED_SERVICE_TIME" },
          { actuallyConsentedThenExpired: true, disclosureRemoved: true, authenticatedLateReportRefused: true }, async () => {
            const protocol = await input.createExpiringProtocol();
            assert(Date.parse(protocol.expiresAt) > Date.parse(protocol.createdAt));
            const selector = `${participantPanel} [data-w3-protocol-id="${protocol.protocolId}"]`;
            await wait(`document.querySelector('${selector}')?.getAttribute('data-w3-protocol-state') === 'INVITED'`);
            await browser(["click", selector + " summary"]);
            await browser(["click", selector + " button:nth-of-type(1)"]);
            await wait(`document.querySelector('${selector}')?.getAttribute('data-w3-protocol-state') === 'CONSENTED'`);
            await wait(`Date.now() >= ${Date.parse(protocol.expiresAt)}
              && document.querySelector('${selector}')?.getAttribute('data-w3-protocol-state') === 'EXPIRED'`);
            const receipt = await evaluate(`({
              observedAt: new Date().toISOString(),
              disclosureCount: document.querySelector('${selector}').querySelectorAll('pre').length,
              disabled: Array.from(document.querySelector('${selector}').querySelectorAll('button')).every(x => x.disabled)
            })`);
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
        await input.revokeOwner(true); revoked = true;
        // A real reload expires the rendered private scope. The retained old
        // response is delivered only after the new authority has been refused.
        await browser(["open", workUrl()]);
        await clear(); hold.release(); await hold.done;
        assert.equal(hold.original.automatic, false);
        await wait(`!document.body.innerText.includes(${JSON.stringify(input.expectedInstanceIds[0])})`);
        return { draft, barrier: input.barrier.receipts(), durable: await input.snapshot(),
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
