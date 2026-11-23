/** Mounted startup follows the explicitly granted fresh current-campaign browser gate. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { loopbackOrigin } from "./agent-browser-client.mjs";
import { observeMountedCampaign } from "./browser-campaign-coordinator.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), backend = join(root, "finnor-os");
for (const name of ["FINNOR_W2_INSTALLATION", "FINNOR_W2_FRONTEND_INSTALLATION", "FINNOR_W2_EVIDENCE_ROOT"])
  assert(process.env[name]?.startsWith("/"), "ACTUAL_INSTALLED_MOUNTED_INPUT_REQUIRED:" + name);
loopbackOrigin(process.env.FINNOR_W2_FRONTEND_ORIGIN);
const gate = await observeMountedCampaign();
const client = gate.client, actualProvenance = gate.proof;
const mountedEnvironment = { ...process.env, ...gate.environment };
assert.equal(actualProvenance.status, "PASS", "ACTUAL_BROWSER_PROVENANCE_UNKNOWN_OR_NOT_ELIGIBLE");
let native, browser, fixture, nativeExit = null, browserExit = null;
let failure = null, started = false, bytesSeen = 0, lines = "";
let browserFinished;
const browserDone = new Promise(resolve => { browserFinished = resolve; });
const abort = async () => {
  if (!fixture) return;
  try {
    const response = await fetch(loopbackOrigin(fixture.controlOrigin) + "/abort", { method: "POST",
      headers: { authorization: "Bearer " + fixture.controlKey, "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) failure ??= "ACTUAL_NATIVE_ABORT_FAILED";
  } catch { failure ??= "ACTUAL_NATIVE_ABORT_FAILED"; }
};
const bounded = bytes => {
  bytesSeen += bytes.length;
  if (bytesSeen > 2097152) throw Error("ORIGINAL_MOUNTED_CONTROLLER_OUTPUT_BOUND");
};
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGCONT"); child.kill("SIGTERM");
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 12000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
};
const onSignal = () => {
  failure ??= "MOUNTED_CONTROLLER_INTERRUPTED";
  void abort().finally(() => { native?.kill("SIGTERM"); browser?.kill("SIGTERM"); });
};
process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
try {
  native = spawn(process.execPath, ["--max-old-space-size=1536", "--import",
    join(backend, "node_modules/tsx/dist/loader.mjs"), join(backend, "scripts/postz-w2/run-native-e2e.mts")], {
    cwd: backend, stdio: ["ignore", "pipe", "pipe"], env: { ...mountedEnvironment,
      FINNOR_W2_MOUNTED: "1", FINNOR_W2_PARTICIPANT_EXPIRY_ONLY: "0" },
  });
  native.stdout.on("data", bytes => {
    try {
      bounded(bytes); lines += bytes.toString();
      while (lines.includes("\n")) {
        const end = lines.indexOf("\n"), line = lines.slice(0, end); lines = lines.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.event !== "W2_MOUNTED_FIXTURE_READY") {
          if (/^[a-z0-9-]{1,160}$/.test(value.id ?? "") && ["PASS", "FAIL"].includes(value.status))
            console.log(JSON.stringify({ id: value.id, status: value.status }));
          continue;
        }
        assert(!started, "ONLY_ONE_ACTUAL_MOUNTED_FIXTURE_REQUIRED"); started = true;
        void (async () => {
          const mode = await lstat(value.privateFile);
          assert(mode.isFile() && !mode.isSymbolicLink() && (mode.mode & 0o777) === 0o600);
          fixture = JSON.parse(await readFile(value.privateFile, "utf8"));
          const evidenceRoot = resolve(process.env.FINNOR_W2_EVIDENCE_ROOT);
          assert(resolve(fixture.evidence).startsWith(evidenceRoot + sep), "ACTUAL_OWNED_NATIVE_EVIDENCE_REQUIRED");
          assert.equal(loopbackOrigin(fixture.frontendOrigin), loopbackOrigin(process.env.FINNOR_W2_FRONTEND_ORIGIN));
          browser = spawn(process.execPath, ["--max-old-space-size=128", join(root, "scripts/postz-w2/cdp-browser.mjs"),
            "--fixture", value.privateFile], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: mountedEnvironment });
          for (const stream of [browser.stdout, browser.stderr]) stream.on("data", bytes => {
            try { bounded(bytes); } catch { failure ??= "ORIGINAL_MOUNTED_CONTROLLER_OUTPUT_BOUND"; void abort(); }
          });
          browser.once("error", () => { browserExit = 1; failure ??= "SUPPORTED_CDP_CLIENT_SPAWN_FAILED";
            void abort().finally(browserFinished); });
          browser.once("exit", (code, signal) => {
            browserExit = code ?? 1;
            if (browserExit || signal) {
              failure ??= "ACTUAL_SUPPORTED_CDP_CLIENT_FAILED"; void abort().finally(browserFinished);
            } else browserFinished();
          });
        })().catch(() => {
          browserExit = 1; failure ??= "ACTUAL_MOUNTED_FIXTURE_OR_CLIENT_FAILED";
          void abort().finally(browserFinished);
        });
      }
    } catch {
      failure ??= "ORIGINAL_MOUNTED_CONTROLLER_OUTPUT_BOUND";
      void abort(); native.kill("SIGTERM");
    }
  });
  native.stderr.on("data", bytes => {
    try { bounded(bytes); } catch { failure ??= "ORIGINAL_MOUNTED_CONTROLLER_OUTPUT_BOUND"; native.kill("SIGTERM"); }
  });
  const nativeDone = new Promise(resolve => {
    native.once("error", () => { nativeExit = 1; failure ??= "ACTUAL_NATIVE_CONTROLLER_SPAWN_FAILED";
      if (!started) browserFinished(); resolve(); });
    native.once("exit", (code, signal) => {
      nativeExit = code ?? 1;
      if (nativeExit || signal) { failure ??= "ACTUAL_NATIVE_CONTROLLER_FAILED"; browser?.kill("SIGTERM"); }
      if (!started) browserFinished();
      resolve();
    });
  });
  await Promise.all([nativeDone, browserDone]);
  assert.equal(nativeExit, 0, "ACTUAL_NATIVE_MOUNTED_CONTROLLER_MUST_PASS");
  assert(started, "ACTUAL_SUPPORTED_BROWSER_MUST_RUN");
  assert.equal(browserExit, 0, "ACTUAL_ORIGINAL_PARTICIPANT_AND_SIX_PREDICATES_MUST_PASS");
  assert(!failure, failure ?? "ACTUAL_MOUNTED_CONTROLLER_FAILED");
} catch {
  failure ??= "ACTUAL_SUPPORTED_MOUNTED_CONTROLLER_FAILED";
  await abort();
  process.exitCode = 1;
} finally {
  await stop(browser); await stop(native);
  // Fault cleanup concerns this assigned tab only, never browser close/reload.
  if (started) {
    try { client.run(["set", "offline", "off"]); }
    catch { failure ??= "ASSIGNED_TAB_OFFLINE_FAULT_CLEANUP_FAILED"; process.exitCode = 1; }
  }
  process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  console.log(JSON.stringify({ event: "W2_SUPPORTED_CDP_CONTROLLER_TERMINAL",
    status: failure ? "FAIL" : "PASS", nativeExit, browserExit, browserStarted: started,
    userOwnedBrowserClosed: false, failure }));
}
