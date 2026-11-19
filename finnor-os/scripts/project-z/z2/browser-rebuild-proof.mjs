/** Installed browser/renderer packaging proof. No server, Auth or native Work. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm, stat, readlink } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [rootArg, outArg] = process.argv.slice(2);
assert(isAbsolute(rootArg) && isAbsolute(outArg));
const root = await realpath(rootArg), out = resolve(outArg);
await mkdir(out, { mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const started = performance.now(), cpuStart = process.cpuUsage();
const proof = { schema: "finnor.project-z.z2.installed-browser-packaging.v1", status: "FAILED",
  scope: "LITERAL_LOCAL_DOCUMENT_PACKAGING_ONLY", authenticatedOwner: "NOT_RUN",
  databaseOrAuthAccess: false, nativeWork: "NOT_RUN", listenerStarted: false, servicesStarted: false };
let browser, tmp;
try {
  const require = createRequire(resolve(root, "finnor-os/package.json"));
  const packagePath = await realpath(require.resolve("playwright/package.json"));
  assert(!relative(root, packagePath).startsWith(".."));
  const packageBytes = await readFile(packagePath);
  const { chromium } = require("playwright");
  const assetRoot = await realpath(resolve(root, ".z2-installed/browsers"));
  assert.equal(await realpath(process.env.PLAYWRIGHT_BROWSERS_PATH ?? ""), assetRoot,
    "Z2_INSTALLED_BROWSER_ASSET_ROOT_REQUIRED");
  proof.browser = { playwrightPackagePath: packagePath, playwrightPackageSha256: hash(packageBytes),
    playwrightVersion: JSON.parse(packageBytes).version, launchSelection: "PINNED_PLAYWRIGHT_DEFAULT_HEADLESS_CHROMIUM" };
  const home = resolve(out, "browser-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Chromium's process-singleton socket is $TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket;
  // AF_UNIX sun_path is 108 bytes, so the evidence directory itself is too deep for TMPDIR.
  tmp = await mkdtemp("/tmp/z2-browser-proof-");
  const projectedSingletonSocket = tmp+"/org.chromium.Chromium.XXXXXX/SingletonSocket";
  assert(projectedSingletonSocket.length < 100, "Z2_BROWSER_TMPDIR_SOCKET_PATH_BUDGET");
  proof.temporaryDirectory = { path: tmp, projectedSingletonSocketBytes: projectedSingletonSocket.length,
    cleanup: "PENDING" };
  const env = { HOME: home, TMPDIR: tmp, PATH: dirname(process.execPath)+":/usr/bin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NODE_ENV: "test" };
  proof.browserEnvironmentNames = Object.keys(env).sort();
  const input = '<!doctype html><meta charset="utf-8"><title>Z2 installed browser packaging</title>'+
    '<button id="check" onclick="document.querySelector(\'output\').textContent=\'installed renderer ready\'">Check installed renderer</button>'+
    '<output aria-label="Packaging result">not checked</output>';
  await writeFile(resolve(out, "input.html"), input, { mode: 0o600 });
  proof.inputSha256 = hash(input);
  browser = await chromium.launch({ headless: true, env, timeout: 45000,
    args: ["--disable-background-networking", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND"] });
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send("SystemInfo.getProcessInfo");
  const pid = Number(processes.processInfo.find(p => p.type === "browser")?.id);
  assert(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  assert.equal((await stat("/proc/"+pid)).uid, process.getuid());
  const executable = await realpath(await readlink("/proc/"+pid+"/exe"));
  assert(!relative(assetRoot, executable).startsWith(".."));
  proof.browser.executablePath = executable;
  proof.browser.executableSha256 = hash(await readFile(executable));
  const command = await readFile("/proc/"+pid+"/cmdline");
  const args = command.toString().split("\0");
  assert(args.includes("--remote-debugging-pipe") && !args.some(arg => arg.startsWith("--remote-debugging-port")));
  const raw = await readFile("/proc/"+pid+"/stat", "utf8");
  proof.browserProcess = { pid, startTicks: raw.slice(raw.lastIndexOf(")")+2).split(" ")[19],
    commandSha256: hash(command), executableSha256: proof.browser.executableSha256, transport: "PIPE_NO_LISTENER" };
  const context = await browser.newContext({ serviceWorkers: "block" });
  let externalRequests = 0;
  await context.route("**/*", route => { externalRequests++; return route.abort(); });
  const page = await context.newPage();
  await page.goto("data:text/html,"+encodeURIComponent(input));
  await page.getByRole("button", { name: "Check installed renderer", exact: true }).click();
  const observed = await page.locator('output[aria-label="Packaging result"]').innerText();
  assert.equal(observed, "installed renderer ready");
  assert.equal(externalRequests, 0);
  const screenshot = await page.screenshot();
  await writeFile(resolve(out, "renderer.png"), screenshot, { mode: 0o600 });
  proof.observed = observed; proof.expected = "installed renderer ready";
  proof.screenshotSha256 = hash(screenshot); proof.browserVersion = browser.version();
  proof.externalPageRequests = externalRequests;
  await context.close();
  proof.status = "PASSED";
} catch (error) {
  proof.failure = { name: error.name, code: error.code ?? null, message: error.message };
  console.error(error);
} finally {
  try {
    await browser?.close();
    if (proof.browserProcess) {
      const deadline = Date.now()+5000;
      let exited = false;
      while (Date.now() < deadline && !exited) {
        try {
          const raw = await readFile("/proc/"+proof.browserProcess.pid+"/stat", "utf8");
          const fields = raw.slice(raw.lastIndexOf(")")+2).split(" ");
          exited = fields[0] === "Z" || fields[19] !== proof.browserProcess.startTicks;
        } catch (error) { if (error.code === "ENOENT") exited = true; else throw error; }
        if (!exited) await delay(25);
      }
      assert(exited, "Z2_OWNED_PACKAGING_BROWSER_EXIT_NOT_OBSERVED");
      proof.cleanup = "OWNED_BROWSER_EXIT_OBSERVED";
    }
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      proof.temporaryDirectory.cleanup = "REMOVED";
    }
  } catch (error) {
    proof.status = "FAILED"; proof.cleanup = "UNRESOLVED_OWNED_BROWSER";
    proof.cleanupFailureCode = error.code ?? null;
    console.error(error);
  }
  const cpu = process.cpuUsage(cpuStart);
  proof.costs = { wallMs: performance.now()-started, nodeCpuMs: (cpu.user+cpu.system)/1000,
    nodePeakRssBytes: process.resourceUsage().maxRSS*1024, aggregateBrowserMemoryBytes: null,
    moneyUsd: null, humanSeconds: null, status: "PARTIALLY_METERED" };
  await writeFile(resolve(out, "report.json"), JSON.stringify(proof, null, 2)+"\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: proof.status, scope: proof.scope, cleanup: proof.cleanup }));
  process.exitCode = proof.status === "PASSED" ? 0 : 1;
}
