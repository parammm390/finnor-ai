/**
 * Browser-side helpers for the Z0 mounted scenario. Everything here observes or
 * drives the real mounted product through real controls; nothing routes,
 * fulfils, rewrites or injects a request, a session or a token.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const FRONTEND = "http://127.0.0.1:3001";
export const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

const SENSITIVE_KEY = /token|secret|password|authorization|apikey|credential/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const redactText = (text: string) => text.replace(JWT, "[JWT]").replace(EMAIL, "[EMAIL]");
export function redact(value: any): any {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE_KEY.test(key) && typeof item === "string" ? "[REDACTED]" : redact(item)]));
  return value;
}

export function loadPlaywright(root: string) {
  return createRequire(join(root, "package.json"))("playwright-core");
}

/** The scenario loader compiles with esbuild keepNames, which wraps functions in a module-level `__name` helper
 * that does not exist inside the page once Playwright serialises an evaluate callback. This defines only that
 * identity helper; it touches no product code, request, storage or session. */
export const HARNESS_NAME_HELPER = "globalThis.__name = globalThis.__name || (target => target);";

export async function newMountedContext(browser: any, options: Record<string, unknown> = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC", ...options });
  await context.addInitScript(HARNESS_NAME_HELPER);
  return context;
}

export async function waitUntil<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>, everyMs = 250): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw Error("TIMEOUT_" + label);
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ request watch */

const READ_POSTS = /\/api\/centropy\/(company-brain\/(application-projection|institution-read|institution-sources)|me)$/;
const MUTATIONS = /\/api\/centropy\/(company-brain\/(application-(acquire|execute|cancel|resume)|institution-(submit|revise|cancel|resume|mandate|register-source|consent|revoke-consent))|actions(\/|$)|outcome-packs|threads$|works\/[^/]+\/objective|instructions\/[^/]+\/cancel)/;

export type WatchRecord = { seq: number; at: number; page: string; method: string; origin: string; path: string; kind: string; operation: string | null;
  hasBearer: boolean; bearerTag: string | null; workId: string | null; query: string; status?: number; failure?: string };

/** Observes with page.on only. Bearer values stay in memory; records carry a short hash tag. */
export class RequestWatch {
  records: WatchRecord[] = [];
  private bearers = new Map<number, string>();
  private byRequest = new WeakMap<object, number>();
  private seq = 0;
  private pending: Promise<unknown>[] = [];
  /** Header values arrive asynchronously; callers that need a bearer or a tag settle first. */
  async settle() { await Promise.all(this.pending.splice(0)); }
  attach(page: any, label: string, authOrigin: string) {
    page.on("request", (request: any) => {
      const url = new URL(request.url());
      const method = request.method();
      let operation: string | null = null;
      if (method !== "GET" && /live-controls$/.test(url.pathname)) {
        try { operation = String(request.postDataJSON()?.operation ?? ""); } catch { operation = null; }
      }
      let workId: string | null = null;
      if (method === "POST" && /application-projection$/.test(url.pathname)) {
        try { workId = request.postDataJSON()?.workId ?? null; } catch { workId = null; }
      }
      const seq = ++this.seq;
      this.byRequest.set(request, seq);
      const row: WatchRecord = { seq, at: Date.now(), page: label, method, origin: url.origin, path: url.pathname,
        kind: this.classify(method, url, operation, authOrigin), operation, hasBearer: false, bearerTag: null, workId, query: url.search.slice(0, 80) };
      this.records.push(row);
      this.pending.push(Promise.resolve(request.allHeaders()).then((headers: Record<string, string>) => {
        const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1] ?? null;
        if (bearer) { this.bearers.set(seq, bearer); row.hasBearer = true; row.bearerTag = sha(bearer).slice(0, 12); }
      }, () => undefined));
    });
    page.on("response", (response: any) => {
      const seq = this.byRequest.get(response.request());
      const row = seq ? this.records.find(item => item.seq === seq) : null;
      if (row) row.status = response.status();
    });
    page.on("requestfailed", (request: any) => {
      const seq = this.byRequest.get(request);
      const row = seq ? this.records.find(item => item.seq === seq) : null;
      if (row) row.failure = String(request.failure()?.errorText ?? "failed").slice(0, 80);
    });
  }
  private classify(method: string, url: URL, operation: string | null, authOrigin: string) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
    if (url.origin === authOrigin) return url.pathname.endsWith("/logout") ? "auth-logout" : url.pathname.endsWith("/token") ? "auth-token" : "auth-other";
    if (/live-controls$/.test(url.pathname)) return operation === "end-delivery" ? "sign-out" : operation === "dispatch" ? "mutation" : "other-non-get";
    if (MUTATIONS.test(url.pathname)) return "mutation";
    if (READ_POSTS.test(url.pathname)) return "read-post";
    return "other-non-get";
  }
  mark() { return this.seq; }
  since(mark: number) { return this.records.filter(row => row.seq > mark); }
  bearerOf(seq: number) { return this.bearers.get(seq) ?? null; }
  lastBearer(predicate: (row: WatchRecord) => boolean, from = 0) {
    const rows = this.records.filter(row => row.seq > from && row.hasBearer && predicate(row));
    const last = rows.at(-1);
    return last ? this.bearers.get(last.seq) ?? null : null;
  }
  summary(from = 0) {
    const rows = this.since(from);
    const count = (kind: string) => rows.filter(row => row.kind === kind).length;
    return { total: rows.length, mutations: count("mutation"), signOut: count("sign-out"), readPosts: count("read-post"), otherNonGet: count("other-non-get"),
      authToken: count("auth-token"), authLogout: count("auth-logout"),
      nonGetPaths: rows.filter(row => row.kind !== "read" && row.kind !== "read-post").map(row => `${row.method} ${row.path}${row.operation ? ":" + row.operation : ""} -> ${row.status ?? row.failure ?? "?"}`) };
  }
}

/* ------------------------------------------------------------------ storage and DOM scans */

export type Marker = { label: string; value: string };

/** Enumerates every browser storage area of the page origin. Returns only key names, sizes and marker labels. */
export async function storageScan(page: any, context: any, markers: Marker[], secrets: Array<{ label: string; value: string | null }> = []) {
  const blobs = await page.evaluate(async () => {
    const out: any = { local: {}, session: {}, idb: [], caches: [], workers: 0, errors: [] };
    try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i)!; out.local[key] = localStorage.getItem(key); } } catch (e) { out.errors.push("local"); }
    try { for (let i = 0; i < sessionStorage.length; i++) { const key = sessionStorage.key(i)!; out.session[key] = sessionStorage.getItem(key); } } catch (e) { out.errors.push("session"); }
    try {
      const dbs = (await (indexedDB as any).databases?.()) ?? [];
      for (const info of dbs) {
        if (!info.name) continue;
        const db: IDBDatabase = await new Promise((yes, no) => { const req = indexedDB.open(info.name!); req.onsuccess = () => yes(req.result); req.onerror = () => no(req.error); });
        const stores: any[] = [];
        for (const name of Array.from(db.objectStoreNames)) {
          const rows: any[] = await new Promise(yes => {
            try { const req = db.transaction(name, "readonly").objectStore(name).getAll(); req.onsuccess = () => yes(req.result); req.onerror = () => yes([]); } catch { yes([]); }
          });
          let text = "";
          try { text = JSON.stringify(rows); } catch { text = String(rows.length); }
          stores.push({ name, count: rows.length, text });
        }
        db.close();
        out.idb.push({ name: info.name, stores });
      }
    } catch (e) { out.errors.push("idb"); }
    try {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        const entries: string[] = [];
        for (const request of requests) {
          const response = await cache.match(request);
          entries.push(request.url + " " + (response ? (await response.clone().text().catch(() => "")) : ""));
        }
        out.caches.push({ name, count: requests.length, text: entries.join("\n") });
      }
    } catch (e) { out.errors.push("caches"); }
    try { out.workers = (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0; } catch { out.errors.push("workers"); }
    return out;
  });
  const cookies = await context.cookies();
  const areas: Record<string, { text: string; keys: string[]; count: number }> = {
    localStorage: { text: JSON.stringify(blobs.local), keys: Object.keys(blobs.local), count: Object.keys(blobs.local).length },
    sessionStorage: { text: JSON.stringify(blobs.session), keys: Object.keys(blobs.session), count: Object.keys(blobs.session).length },
    indexedDB: { text: blobs.idb.flatMap((db: any) => db.stores.map((store: any) => store.text)).join("\n"),
      keys: blobs.idb.flatMap((db: any) => db.stores.map((store: any) => `${db.name}/${store.name}`)),
      count: blobs.idb.reduce((sum: number, db: any) => sum + db.stores.reduce((inner: number, store: any) => inner + store.count, 0), 0) },
    cacheStorage: { text: blobs.caches.map((cache: any) => cache.text).join("\n"), keys: blobs.caches.map((cache: any) => cache.name),
      count: blobs.caches.reduce((sum: number, cache: any) => sum + cache.count, 0) },
    cookies: { text: JSON.stringify(cookies.map((cookie: any) => cookie.name + "=" + cookie.value)), keys: cookies.map((cookie: any) => cookie.name), count: cookies.length },
  };
  const result: Record<string, any> = {};
  for (const [name, area] of Object.entries(areas)) {
    result[name] = { keys: area.keys.map(key => redactText(key).slice(0, 120)), count: area.count, bytes: area.text.length,
      markerHits: markers.filter(marker => marker.value && area.text.includes(marker.value)).map(marker => marker.label),
      secretHits: secrets.filter(secret => secret.value && area.text.includes(secret.value)).map(secret => secret.label) };
  }
  result.serviceWorkers = { count: blobs.workers };
  result.enumerationErrors = blobs.errors;
  const anySupabaseKey = areas.localStorage!.keys.some(key => /^sb-.*-auth-token$/.test(key)) || areas.cookies!.keys.some(key => /^sb-/.test(key));
  const refreshToken = (() => {
    for (const [key, raw] of Object.entries(blobs.local) as Array<[string, string]>) {
      if (!/^sb-.*-auth-token$/.test(key)) continue;
      try { return JSON.parse(raw)?.refresh_token ?? null; } catch { return null; }
    }
    return null;
  })();
  const accessToken = (() => {
    for (const [key, raw] of Object.entries(blobs.local) as Array<[string, string]>) {
      if (!/^sb-.*-auth-token$/.test(key)) continue;
      try { return JSON.parse(raw)?.access_token ?? null; } catch { return null; }
    }
    return null;
  })();
  return { result, supabaseSessionKeyPresent: anySupabaseKey, refreshToken: refreshToken as string | null, accessToken: accessToken as string | null,
    markerHitCount: Object.values(result).reduce((sum: number, area: any) => sum + (area.markerHits?.length ?? 0), 0),
    secretHitCount: Object.values(result).reduce((sum: number, area: any) => sum + (area.secretHits?.length ?? 0), 0) };
}

export const APP = ".ct-application-semantics";
export const INST = 'section[aria-label="Institution responsibility"]';

/** Opens every collapsed <details> in scope with real clicks, deepest last-to-first so indices stay valid. */
export async function openAllDetails(page: any, scope: string) {
  let opened = 0;
  for (let pass = 0; pass < 8; pass++) {
    const closed = page.locator(`${scope} details:not([open]) > summary`);
    const count = await closed.count();
    if (!count) return opened;
    for (let index = count - 1; index >= 0; index--) {
      const done = await closed.nth(index).click({ timeout: 4000 }).then(() => true, () => false);
      if (done) opened++;
    }
  }
  return opened;
}

/** DOM facts of both private panels plus the whole-document marker haystack. Collapsed content is opened first. */
export async function readPanels(page: any) {
  await openAllDetails(page, APP);
  await openAllDetails(page, INST);
  return page.evaluate(({ app, inst }: { app: string; inst: string }) => {
    const collapse = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
    const noPre = (root: Element) => { const copy = root.cloneNode(true) as Element; copy.querySelectorAll("pre").forEach(node => node.remove()); return collapse(copy.textContent); };
    const describe = (root: Element | null) => root ? {
      text: collapse((root as HTMLElement).innerText),
      textNoPre: noPre(root),
      headings: Array.from(root.querySelectorAll("h3,h4,h5")).map(node => collapse((node as HTMLElement).innerText)),
      buttons: Array.from(root.querySelectorAll("button")).map(node => ({ name: collapse((node.getAttribute("aria-label") || (node as HTMLElement).innerText)), disabled: (node as HTMLButtonElement).disabled })),
      statuses: Array.from(root.querySelectorAll("[role=status],[role=alert]")).map(node => ({ role: node.getAttribute("role"), text: collapse((node as HTMLElement).innerText) })),
      pres: Array.from(root.querySelectorAll("pre")).map(node => node.textContent ?? ""),
      textareas: root.querySelectorAll("textarea").length,
      forms: root.querySelectorAll("form").length,
    } : null;
    const appRoot = document.querySelector(app);
    const instRoot = document.querySelector(inst);
    const summaryPre = (prefix: string, root: Element | null) => {
      const summary = Array.from(root?.querySelectorAll("summary") ?? []).find(node => collapse((node as HTMLElement).innerText).startsWith(prefix));
      return summary?.closest("details")?.querySelector("pre")?.textContent ?? null;
    };
    const charges = (() => {
      const summary = Array.from(appRoot?.querySelectorAll("summary") ?? []).find(node => collapse((node as HTMLElement).innerText).startsWith("Original resource charges"));
      const details = summary?.closest("details");
      return details ? Array.from(details.querySelectorAll(":scope > article")).map(article => ({
        heading: collapse(article.querySelector("h5")?.textContent ?? null), text: collapse((article as HTMLElement).innerText) })) : [];
    })();
    return {
      url: location.href,
      app: describe(appRoot),
      appAttributes: appRoot ? { work: appRoot.getAttribute("data-application-work"), session: appRoot.getAttribute("data-application-session"),
        status: appRoot.getAttribute("data-application-status"), busy: appRoot.getAttribute("aria-busy") } : null,
      appCosts: Object.fromEntries(Array.from(appRoot?.querySelectorAll("[data-application-cost]") ?? []).map(node => [node.getAttribute("data-application-cost"), collapse(node.textContent)])),
      appEffects: Array.from(appRoot?.querySelectorAll("[data-application-effect-state]") ?? []).map(node => ({ state: node.getAttribute("data-application-effect-state"), text: collapse((node as HTMLElement).innerText) })),
      budgetJson: summaryPre("Remaining original resources", appRoot),
      counterexamplesJson: summaryPre("Counterexamples", appRoot),
      charges,
      inst: describe(instRoot),
      instRows: Array.from(instRoot?.querySelectorAll("table tbody tr") ?? []).map(row => Array.from(row.querySelectorAll("td")).map(cell => collapse((cell as HTMLElement).innerText))),
      instCounts: Object.fromEntries(Array.from(instRoot?.querySelectorAll("dl.ct-evidence__values > div") ?? []).map(node => [collapse(node.querySelector("dt")?.textContent ?? null), collapse(node.querySelector("dd")?.textContent ?? null)])),
      instWitnessJson: summaryPre("Evidence witnesses", instRoot),
      bodyText: collapse(document.body.innerText),
      html: document.documentElement.outerHTML,
      topbar: Boolean(document.querySelector(".ct-topbar")),
      applicationCount: document.querySelectorAll(app).length,
    };
  }, { app: APP, inst: INST });
}

/** Where, outside any <pre>, does a claim's identifying text appear and what class label governs it. */
export async function claimLabelProbe(page: any, claims: Array<{ cls: string; key: string }>) {
  return page.evaluate(({ app, claims }: { app: string; claims: Array<{ cls: string; key: string }> }) => {
    const root = document.querySelector(app);
    const out: any[] = [];
    for (const claim of claims) {
      let hit: Element | null = null;
      const walker = document.createTreeWalker(root ?? document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && !hit; node = walker.nextNode()) {
        if ((node.nodeValue ?? "").includes(claim.key) && !(node.parentElement?.closest("pre"))) hit = node.parentElement;
      }
      if (!hit) { out.push({ ...claim, foundOutsidePre: false, ancestorClass: null, nearestHeading: null }); continue; }
      let ancestorClass: string | null = null;
      for (let el: Element | null = hit; el && !ancestorClass; el = el.parentElement)
        ancestorClass = el.getAttribute("data-claim-class") ?? el.getAttribute("data-basis-class");
      let nearestHeading: string | null = null;
      for (let el: Element | null = hit; el && !nearestHeading; el = el.parentElement) {
        for (let sib = el.previousElementSibling; sib && !nearestHeading; sib = sib.previousElementSibling)
          if (/^(H3|H4|H5|H6|SUMMARY|DT|LEGEND)$/.test(sib.tagName)) nearestHeading = (sib.textContent ?? "").trim().slice(0, 120);
        if (!nearestHeading && el.tagName === "DETAILS") nearestHeading = (el.querySelector("summary")?.textContent ?? "").trim().slice(0, 120);
      }
      out.push({ ...claim, foundOutsidePre: true, ancestorClass, nearestHeading });
    }
    return out;
  }, { app: APP, claims });
}

/** Smallest element outside <pre> whose text contains every needle and the label pattern. */
export async function elementWith(page: any, scope: string, needles: string[], label: string) {
  return page.evaluate(({ scope, needles, label }: { scope: string; needles: string[]; label: string }) => {
    const pattern = new RegExp(label, "i");
    let best: string | null = null;
    for (const root of Array.from(document.querySelectorAll(scope))) {
      for (const el of Array.from(root.querySelectorAll("p,li,dd,dt,td,div,span,article,h5,summary,label"))) {
        if (el.closest("pre")) continue;
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (needles.every(needle => text.includes(needle)) && pattern.test(text) && (best === null || text.length < best.length)) best = text;
      }
    }
    return best ? best.slice(0, 300) : null;
  }, { scope, needles, label });
}

/* ------------------------------------------------------------------ real UI navigation */

export async function uiSignIn(page: any, email: string, password: string, watch: RequestWatch) {
  await page.goto(FRONTEND + "/centropy/login", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const mark = watch.mark();
  const me = page.waitForResponse((response: any) => response.request().method() === "GET" && new URL(response.url()).origin === FRONTEND
    && new URL(response.url()).pathname === "/api/centropy/me" && response.status() === 200, { timeout: 90000 });
  const settled = await Promise.allSettled([me, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  if (settled.some(row => row.status !== "fulfilled")) throw Error("UI_SIGN_IN_ME_RESPONSE_NOT_OBSERVED");
  const response = (settled[0] as PromiseFulfilledResult<any>).value;
  const identity = await response.json();
  await page.getByRole("heading", { name: "What needs to move forward?" }).waitFor({ state: "visible", timeout: 90000 });
  await watch.settle();
  const bearer = watch.lastBearer(row => row.path === "/api/centropy/me", mark);
  return { identity, bearer, meStatus: response.status() };
}

export async function uiSignOut(page: any) {
  await page.locator('summary[aria-label="Account menu"]').click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator(".ct-topbar").waitFor({ state: "hidden", timeout: 45000 });
}

export const workUrl = (threadId: string, root?: { entityType: string; entityId: string }) =>
  `${FRONTEND}/centropy/investigations/${threadId}${root ? "?root=" + encodeURIComponent(JSON.stringify(root)) : ""}`;

export const panelFor = (page: any, workId: string) => page.locator(`${APP}[data-application-work="${workId}"]`);

/** Waits for the panel of a Work to be mounted and to have finished its current read. */
export async function waitForPanel(page: any, workId: string, timeoutMs = 60000) {
  const panel = panelFor(page, workId);
  await panel.waitFor({ state: "visible", timeout: timeoutMs });
  await waitUntil("PANEL_SETTLED", timeoutMs, async () =>
    (await panel.getAttribute("aria-busy")) === "false" && (await panel.getAttribute("data-application-session")) !== "none");
  return panel;
}

export async function openWork(page: any, threadId: string, workId: string, root: { entityType: string; entityId: string }) {
  const shell = 'section[aria-label="CENTROPY conversation"], main[aria-label="Investigation Canvas"]';
  await page.goto(workUrl(threadId), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator(shell).first().waitFor({ state: "visible", timeout: 120000 }).catch(() => undefined);
  let rootCarriedBy = "THREAD_PERSISTED_ROOT";
  try { await waitForPanel(page, workId, 45000); }
  catch {
    rootCarriedBy = "ROOT_URL_PARAMETER";
    await page.goto(workUrl(threadId, root), { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(shell).first().waitFor({ state: "visible", timeout: 120000 }).catch(() => undefined);
    await waitForPanel(page, workId, 60000);
  }
  return { rootCarriedBy };
}

/* ------------------------------------------------------------------ evidence output */

export function privateDir(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; }

export async function screenshots(page: any, dirs: { original: string; redacted: string }, name: string) {
  const original = join(dirs.original, name + ".png");
  const derivative = join(dirs.redacted, name + ".redacted.png");
  await page.screenshot({ path: original, fullPage: false });
  chmodSync(original, 0o600);
  await page.screenshot({ path: derivative, fullPage: false,
    mask: [page.locator(".ct-topbar"), page.locator('summary[aria-label="Account menu"]'), page.locator("input")], maskColor: "#000000" });
  chmodSync(derivative, 0o600);
  return { original: original, redacted: derivative };
}

export function writePrivateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
}

/* ------------------------------------------------------------------ real Auth credential for an existing owner row */

/** Gives an existing database owner a local Auth credential through the isolated Auth admin endpoint. The password stays in memory. */
export async function ensureAuthCredential(env: Record<string, string>, email: string) {
  const password = randomBytes(18).toString("base64url") + "aA1!";
  const headers = { Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_ANON_KEY!, "Content-Type": "application/json" };
  const created = await fetch(env.SUPABASE_URL + "/auth/v1/admin/users", { method: "POST", headers,
    body: JSON.stringify({ email, password, email_confirm: true }), signal: AbortSignal.timeout(15000) });
  if (created.status !== 200) throw Error("AUTH_ADMIN_CREATE_" + created.status);
  const login = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY!, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
  if (login.status !== 200) throw Error("AUTH_PASSWORD_GRANT_" + login.status);
  return { email, password };
}

/** Real refresh-token grant from Node; used only to prove a logged-out session cannot be resurrected. */
export async function refreshGrantStatus(env: Record<string, string>, refreshToken: string) {
  const response = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", { method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY!, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(15000) });
  await response.text();
  return response.status;
}

export async function idpUserId(env: Record<string, string>, bearer: string) {
  const response = await fetch(env.SUPABASE_URL + "/auth/v1/user", { headers: { apikey: env.SUPABASE_ANON_KEY!, Authorization: "Bearer " + bearer }, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({})) as any;
  return { status: response.status, id: typeof body.id === "string" ? body.id : null };
}
