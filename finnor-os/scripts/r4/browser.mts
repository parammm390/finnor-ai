/** Preregistered actual CENTROPY -> CanvasDocument -> EvidenceWorkbench mount.
 * Only the disposable issuer owns tokens; no mock plan or component is served. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createEmployeeConversationThread, receiveWork } from "@finnor/db";

export async function mountedIdentification(input: {
  repo: string; output: string; admin: any; fixture: any; issuer: any; artifact: (name: string, value: unknown) => Promise<unknown>;
  expiryFixture: () => Promise<any>;
  inspect?: boolean;
  remainingOnly?: boolean;
}) {
  const { repo, output, admin, fixture: f, issuer, artifact } = input;
  const steps: any[] = [], traffic: any[] = [];
  const thread = await createEmployeeConversationThread({ tenantId: f.tenant, ownerEmployeeId: f.principal,
    title: "R4 identification acquisition Work" });
  const root = { entityType: "pe_deal", entityId: String(f.deal.row.id) };
  await admin.query("UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3,active_references=$4::jsonb WHERE tenant_id=$1 AND id=$2",
    [f.tenant, thread.id, f.work.workId, JSON.stringify([root])]);
  await artifact("browser/fixture.json", { tenantId: f.tenant, principalId: f.principal, root, companyRoot: f.root,
    threadId: thread.id, workId: f.work.workId, authentication: "DISPOSABLE_RS256_NO_BYPASS",
    expected: { selected: "affordable-joint", cost: "2 USD", delay: "1 second(s)", masks: 4, pairs: 12, identification: "CONDITIONAL" } });
  const apiRoot = join(repo, "finnor-os/apps/api/app/api"), routes: Array<{ file: string; parts: string[]; dynamic: number }> = [];
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name === "route.ts") {
        const parts = relative(apiRoot, directory).split("/");
        routes.push({ file: path, parts, dynamic: parts.filter(p => p.startsWith("[")).length });
      }
    }
  }
  await scan(apiRoot); routes.sort((a, b) => a.dynamic - b.dynamic);
  let hold = false, held = false, release: (() => void) | undefined;
  const backend = createServer(async (req, res) => {
    const begin = performance.now();
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1"), parts = url.pathname.replace(/^\/api\//, "").split("/").map(decodeURIComponent);
      let found: { file: string; params: Record<string, string> } | undefined;
      for (const route of routes) {
        if (route.parts.length !== parts.length) continue;
        const params: Record<string, string> = {};
        if (route.parts.every((part, i) => {
          if (part.startsWith("[") && !part.startsWith("[...")) { params[part.slice(1, -1)] = parts[i]!; return true; }
          return part === parts[i];
        })) { found = { file: route.file, params }; break; }
      }
      if (!found) { res.writeHead(404); res.end("{}"); return; }
      let body = "";
      for await (const bytes of req) { body += bytes; if (Buffer.byteLength(body) > 2_000_000) throw Error("BROWSER_HOST_REQUEST_BOUND"); }
      const module = await import(pathToFileURL(found.file).href), handler = module[req.method ?? "GET"];
      if (!handler) { res.writeHead(405); res.end("{}"); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const response: Response = await handler(new Request(url, { method: req.method, headers,
        ...(!["GET", "HEAD"].includes(req.method ?? "GET") ? { body } : {}) }), { params: Promise.resolve(found.params) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hold && url.pathname === "/api/identification-plans/work") {
        hold = false; held = true;
        await new Promise<void>(yes => { release = yes; });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers.entries())); res.end(bytes);
      traffic.push({ path: url.pathname, method: req.method, status: response.status, bearerPresent: Boolean(req.headers.authorization),
        wallMs: performance.now() - begin, responseBytes: bytes.length });
    } catch (error) {
      res.writeHead(500); res.end('{"error":"Disposable route host failed"}');
      traffic.push({ path: req.url, status: 500, diagnostic: String(error) });
    }
  });
  await new Promise<void>(yes => backend.listen(0, "127.0.0.1", yes));
  const address = backend.address(); assert(address && typeof address !== "string");
  const upstream = `http://127.0.0.1:${address.port}`;
  const next = spawn(process.execPath, [join(repo, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "0", "--webpack"], {
    cwd: repo, env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_OS_API_URL: upstream,
      FINNOR_OS_API_URL: upstream, NEXT_PUBLIC_SUPABASE_URL: issuer.authOrigin,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "r4-disposable-public-key", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [next.stdout, next.stderr]) stream!.on("data", bytes => { if (log.length < 2_000_000) log += bytes.toString(); });
  const desktop = Boolean(process.env.FACTORY_DESKTOP_CDP_PORT && process.env.AGENT_BROWSER_CDP);
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!,
    AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION ?? "r4-mounted-work" };
  const ab = (args: string[], stdin?: string) => new Promise<string>((yes, no) => {
    const child = spawn("agent-browser", [...(desktop ? ["--cdp", process.env.AGENT_BROWSER_CDP!] : []), ...args],
      { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin!.end(stdin ?? ""); let out = "", err = "";
    child.stdout!.on("data", bytes => out += bytes); child.stderr!.on("data", bytes => err += bytes);
    const operation = args[0] === "--json" ? args[1] : args[0];
    const timer = setTimeout(() => { child.kill("SIGKILL"); no(Error("BROWSER_COMMAND_BOUND:" + operation)); }, 45000);
    child.once("error", error => { clearTimeout(timer); no(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? yes(out) : no(Error("BROWSER_COMMAND_FAILED:" + operation + ":" + args.slice(1).join(" ") + ":" + err)); });
  });
  const evaluate = async (source: string) => {
    const raw = JSON.parse((await ab(["eval", "--stdin"], source)).trim());
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };
  const button = async (name: string) => {
    const snapshot = await ab(["snapshot"]);
    const line = snapshot.split("\n").find(line => line.includes(`button "${name}"`));
    const ref = line?.match(/\[ref=(e\d+)\]/)?.[1] ?? line?.match(/@(e\d+)\b/)?.[1];
    assert(ref, "Fresh accessible button required: " + name);
    await ab(["focus", "@" + ref]);
    await ab(["press", "Enter"]);
  };
  const openCanvas = async () => {
    await ab(["wait", "--fn", 'document.querySelector(".ct-identification-plan") && document.querySelector(".ct-mobile-switch button:nth-child(2)")?.getBoundingClientRect().width > 0']);
    await button("Canvas");
    steps.push({ action: "Actual Canvas keyboard control; CDP browser input, not native OS qualification" });
    await ab(["wait", "--fn", 'document.querySelector(".ct-mobile-switch button:nth-child(2)")?.getAttribute("aria-pressed") === "true" && getComputedStyle(document.querySelector(".ct-canvas")).display !== "none"']);
  };
  function session(bearer: string, id: string) {
    return { access_token: bearer, refresh_token: "disposable-unused", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email: id + "@r4.example.test", role: "authenticated",
        aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
  }
  const changeSession = (value: unknown) => ab(["eval", "--stdin"],
    `(()=>{const key="sb-127-auth-token",session=${JSON.stringify(value)},oldValue=localStorage.getItem(key),newValue=JSON.stringify(session);localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent("storage",{key,oldValue,newValue,storageArea:localStorage}));const channel=new BroadcastChannel(key);channel.postMessage({event:"SIGNED_IN",session});setTimeout(()=>channel.close(),1000);return null})()`);
  let url = "";
  try {
    for (let i = 0; i < 600; i++) {
      const match = log.match(/Local:\s+(http:\/\/[^ \n]+)/);
      if (match) { url = `${match[1]}/centropy/investigations/${thread.id}?root=${encodeURIComponent(JSON.stringify(root))}`; break; }
      if (next.exitCode !== null) throw Error("ACTUAL_NEXT_START_FAILED");
      await new Promise(yes => setTimeout(yes, 100));
    }
    assert(url, "Next preparation bound");
    const origin = new URL(url).origin;
    for (const path of ["/api/centropy/me", `/api/centropy/threads/${thread.id}?limit=100`]) {
      const response = await fetch(origin + path, { headers: { authorization: "Bearer " + f.bearer }, signal: AbortSignal.timeout(45000) });
      await response.arrayBuffer(); assert.equal(response.status, 200);
    }
    await ab(["set", "viewport", "720", "1000"]);
    await ab(["open", url]); await ab(["wait", "--text", "Sign in"]);
    await changeSession(session(f.bearer, f.principal));
    await ab(["open", url]); await ab(["wait", "--text", "R4 identification acquisition Work"]);
    if (input.inspect) {
      await artifact("browser/live-diagnostic-ready.json", { url, seconds: 120,
        qualification: "DIAGNOSTIC_ONLY_NO_MOUNT_PASS" });
      console.log(JSON.stringify({ diagnostic: "LIVE_MOUNTED_INPUT_WINDOW", url }));
      await new Promise(yes => setTimeout(yes, 120000));
      return { status: "DIAGNOSTIC_ONLY", steps };
    }
    await ab(["eval", "--stdin"], 'window.__r4Input=[];document.addEventListener("click",e=>window.__r4Input.push({type:e.type,trusted:e.isTrusted,tag:e.target.tagName}),{capture:true});null');
    await openCanvas();
    await ab(["wait", "--text", "Conditional acquisition plan"]);
    const observed = await evaluate(`JSON.stringify({
      selected:document.querySelector("[data-identification-selected]")?.textContent,
      cost:document.querySelector("[data-identification-cost]")?.textContent,
      delay:document.querySelector("[data-identification-delay]")?.textContent,
      coverage:document.querySelector("[data-identification-coverage]")?.textContent,
      graphs:[...document.querySelectorAll("[data-identification-graph]")].map(e=>({id:e.getAttribute("data-identification-graph"),text:e.textContent})),
      text:document.querySelector(".ct-identification-plan")?.textContent,
      inputs:window.__r4Input})`);
    assert.equal(observed.selected, "affordable-joint"); assert.equal(observed.cost, "2 USD");
    assert.equal(observed.delay, "1 second(s)"); assert(observed.coverage.includes("4 masks / 12 graph pairs"));
    assert.equal(observed.graphs.length, 3); assert(observed.graphs.every((g: any) => g.text.includes("outcome") && g.text.includes("price") && g.text.includes("required future collection condition")));
    assert(observed.inputs.some((e: any) => e.type === "click" && e.trusted === true), "Trusted actual Canvas keyboard input must execute");
    assert(!observed.text.includes("VERIFIED")); assert(observed.text.includes("not a measured effect"));
    steps.push({ action: "Actual persisted plan through existing Canvas/EvidenceWorkbench", observed, snapshot: await ab(["snapshot"]) });
    if (!input.remainingOnly) {
      try {
        const capture = JSON.parse(await ab(["--json", "screenshot", ".ct-identification-plan",
          join(output, "browser/conditional-plan.png")]));
        assert.equal(capture.success, true, "Screenshot command must complete, not merely write a file");
        steps.push({ action: "Completed JSON-mode element capture", path: capture.data.path });
      } catch (error) {
        steps.push({ action: "Screenshot capture PARTIAL; command failure retained separately from DOM/control predicates", message: String(error) });
      }
    }
    if (!input.remainingOnly) {
    await button("Recheck identification sources"); await ab(["wait", "--text", "Conditional acquisition plan"]);
    await ab(["open", url]); await ab(["wait", "--text", "R4 identification acquisition Work"]); await openCanvas(); await ab(["wait", "--text", "Conditional acquisition plan"]);
    steps.push({ action: "Authenticated reload and owner revalidation", snapshot: await ab(["snapshot"]) });

    // The held response is genuine old-principal owner output, not a mock.
    hold = true; held = false;
    await button("Recheck identification sources");
    for (let i = 0; i < 200 && !held; i++) await new Promise(yes => setTimeout(yes, 50));
    assert(held, "Actual delayed owner response required");
    await changeSession(session(f.otherBearer, f.otherPrincipal));
    await ab(["wait", "--fn", `!document.querySelector(".ct-identification-plan") || document.querySelector(".ct-identification-plan").getAttribute("data-identification-scope").startsWith(${JSON.stringify(f.otherPrincipal + ":")})`]);
    await ab(["wait", "--fn", '!document.querySelector("[data-identification-accepted]")']);
    release!(); release = undefined;
    await ab(["wait", "--fn", '!document.querySelector("[data-identification-query]")']);
    steps.push({ action: "Actual principal/session switch fences delayed private response", snapshot: await ab(["snapshot"]) });
    await changeSession(session(f.bearer, f.principal));
    await ab(["open", url]); await ab(["wait", "--text", "R4 identification acquisition Work"]); await openCanvas(); await ab(["wait", "--text", "Conditional acquisition plan"]);

    const otherWork = await receiveWork({ tenantId: f.tenant, userId: f.principal,
      instruction: "Separate Work without an identification profile", channel: "console", idempotencyKey: "r4-browser-other-work" });
    await admin.query("UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3 WHERE tenant_id=$1 AND id=$2",
      [f.tenant, thread.id, otherWork.workId]);
    await ab(["open", url]); await ab(["wait", "--text", "R4 identification acquisition Work"]); await openCanvas(); await ab(["wait", "--fn", '!document.querySelector("[data-identification-accepted]")']);
    assert.equal(await evaluate('JSON.stringify(Boolean(document.querySelector("[data-identification-query]")))'), false);
    steps.push({ action: "Actual current Work switch clears profile and output", workId: otherWork.workId, snapshot: await ab(["snapshot"]) });
    await admin.query("UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3 WHERE tenant_id=$1 AND id=$2",
      [f.tenant, thread.id, f.work.workId]);
    await ab(["open", url]); await ab(["wait", "--text", "R4 identification acquisition Work"]); await openCanvas(); await ab(["wait", "--text", "Conditional acquisition plan"]);
    }

    await ab(["focus", ".ct-identification-plan > details:last-of-type > summary"]);
    await ab(["press", "Enter"]);
    await button("Read immutable identification history");
    await ab(["wait", "--fn", 'Boolean(document.querySelector(".ct-identification-plan > details:last-of-type > pre"))']);
    const retainedHistory = await evaluate('JSON.stringify(JSON.parse(document.querySelector(".ct-identification-plan > details:last-of-type > pre").textContent))');
    assert(retainedHistory.records.history.some((entry: any) => entry.kind === "DEVELOPMENT_VERIFIED"));
    steps.push({ action: "Actual authenticated immutable history in mounted Work", retainedHistory });
    await button("Ask S4 to wait or stop");
    await ab(["wait", "--text", "Original utility unchanged"]);
    steps.push({ action: "Mounted control reaches real S4 WAIT/STOP without collection or effect authority", snapshot: await ab(["snapshot"]) });

    await button("Run registered identification search");
    await ab(["wait", "--fn", 'document.querySelector(".ct-identification-plan")?.textContent.includes("queued search")']);
    assert.equal(await evaluate('JSON.stringify(Boolean(document.querySelector("[data-identification-accepted]")))'), false);
    await button("Cancel identification search");
    await ab(["wait", "--text", "Only physically terminated compute is released"]);
    const cancelled = (await admin.query("SELECT status,head_id FROM finnor_os.r4_runs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC LIMIT 1",
      [f.tenant, f.work.workId])).rows[0];
    assert.equal(cancelled.status, "CANCELLED"); assert.equal(cancelled.head_id, null);
    steps.push({ action: "Actual durable submit/cancel stays provisional and does not renew authority", cancelled, snapshot: await ab(["snapshot"]) });

    const sourceVersion = randomUUID(), snapshot = { worldRoot: f.root,
      identificationLaws: f.r4Problem.bundles.flatMap((b: any) => b.laws),
      revisionReason: "Real disposable S1 revision invalidates the previous collection declaration" };
    await admin.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,$2,'tenant',$3,2,$4,'Revised hypothetical collection declaration',$5::jsonb,clock_timestamp())",
      [sourceVersion, f.r4Source.sourceId, f.tenant,
        createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), JSON.stringify(snapshot)]);
    await button("Recheck identification sources");
    await ab(["wait", "--fn", '!document.querySelector("[data-identification-query]") && !document.querySelector("[data-identification-accepted]")']);
    const revised = await issuer.call(f, "read", { runId: f.accepted.runId });
    assert.equal(revised.status, 200); assert.equal(revised.body.status, "INVALIDATED"); assert.equal(revised.body.artifact, null);
    const historical = await issuer.call(f, "history", { runId: f.accepted.runId });
    assert.equal(historical.status, 200);
    assert(historical.body.records.artifacts.some((entry: any) => entry.kind === "PLAN"));
    steps.push({ action: "Actual S1 source revision clears mounted private query and output; historical checked plan remains inspectable",
      sourceVersion, revised: revised.body, historical: historical.body, snapshot: await ab(["snapshot"]) });

    const expiring = await input.expiryFixture();
    const expiryThread = await createEmployeeConversationThread({ tenantId: expiring.tenant, ownerEmployeeId: expiring.principal,
      title: "R4 original grant expiry Work" });
    const expiryRoot = { entityType: "pe_deal", entityId: String(expiring.deal.row.id) };
    await admin.query("UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3,active_references=$4::jsonb WHERE tenant_id=$1 AND id=$2",
      [expiring.tenant, expiryThread.id, expiring.work.workId, JSON.stringify([expiryRoot])]);
    const expiryUrl = `${origin}/centropy/investigations/${expiryThread.id}?root=${encodeURIComponent(JSON.stringify(expiryRoot))}`;
    await changeSession(session(expiring.bearer, expiring.principal));
    await ab(["open", expiryUrl]); await ab(["wait", "--text", "R4 original grant expiry Work"]); await openCanvas();
    await ab(["wait", "--text", "Conditional acquisition plan"]);
    hold = true; held = false;
    // Hold the next real background revalidation, leaving the displayed profile
    // intact so the original-expiry timer, not a manual clear, is tested.
    for (let i = 0; i < 300 && !held; i++) await new Promise(yes => setTimeout(yes, 50));
    assert(held, "A genuine pre-expiry owner response must be held");
    assert.equal(await evaluate('JSON.stringify(Boolean(document.querySelector("[data-identification-query]")))'), true);
    assert.equal(await evaluate('JSON.stringify(Boolean(document.querySelector("[data-identification-accepted]")))'), true);
    const expiryAt = Date.parse(expiring.mandate.validUntil), remaining = expiryAt - Date.now();
    assert(remaining > 0 && remaining <= 70000, "Original short fixture expiry, never a renewed deadline");
    await new Promise(yes => setTimeout(yes, remaining + 100));
    await ab(["wait", "--fn", '!document.querySelector("[data-identification-query]") && !document.querySelector("[data-identification-accepted]")']);
    release!(); release = undefined;
    await ab(["wait", "--fn", '!document.querySelector("[data-identification-query]") && !document.querySelector("[data-identification-accepted]")']);
    const expired = await issuer.call(expiring, "read", { runId: expiring.accepted.runId });
    assert.equal(expired.status, 200); assert.equal(expired.body.status, "INVALIDATED");
    assert.equal(expired.body.costs.attempts.length, 2);
    steps.push({ action: "Actual original S4/S5 expiry with delayed genuine response clears private output, preserves costs and never renews grant",
      originalExpiry: expiring.mandate.validUntil, observedAt: new Date().toISOString(),
      expired: expired.body, snapshot: await ab(["snapshot"]) });
    assert(traffic.filter(t => t.path?.startsWith("/api/identification-plans/")).every(t => t.bearerPresent));
    return { status: "PASS", boundary: "ACTUAL_CENTROPY_CANVAS_EVIDENCEWORKBENCH_PROXY_SQL_OWNERS",
      steps, hostedAuthenticationQualified: false, nativeInput: "NATIVE_OS_INPUT_NOT_RUN",
      controlInput: "TRUSTED_CDP_BROWSER_KEYBOARD_NO_MOCK_COMPONENT_OR_ENDPOINT",
      moneyUSD: null, preparationQualifiedAsColdProduction: false };
  } catch (error) {
    await ab(["snapshot"]).then(snapshot => steps.push({ action: "Failure snapshot", snapshot })).catch(() => undefined);
    await artifact("browser/failure.json", { message: String(error), stack: (error as Error).stack });
    throw error;
  } finally {
    release?.();
    await artifact("browser/results.json", { url, steps, traffic });
    await artifact("browser/next-log.json", { log });
    next.kill("SIGTERM");
    if (next.exitCode === null) await new Promise<void>(yes => {
      const timer = setTimeout(() => { next.kill("SIGKILL"); yes(); }, 5000);
      next.once("exit", () => { clearTimeout(timer); yes(); });
    });
    backend.closeAllConnections(); await new Promise<void>(yes => backend.close(() => yes()));
    if (!desktop) await ab(["close"]).catch(() => undefined);
  }
}
