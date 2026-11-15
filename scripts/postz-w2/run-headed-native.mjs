/** One physical native fixture plus its independent, separately visible browser.
 * The caller owns the shared heavy/medium locks; this runner never bypasses them. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const backend = join(root, "finnor-os");
let browser, nativeStatus = null, browserStatus = null, browserStarted = false;
const native = spawn(process.execPath, ["--max-old-space-size=1536", "--import",
  join(backend, "node_modules/tsx/dist/loader.mjs"), join(backend, "scripts/postz-w2/run-native-e2e.mts")],
{ cwd: backend, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FINNOR_W2_MOUNTED: "1" } });
let lines = "", control;
const abort = async () => {
  if (!control) return;
  await fetch(control.controlOrigin + "/abort", { method: "POST",
    headers: { authorization: "Bearer " + control.controlKey, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(10000) }).catch(() => {});
};
const browserDone = new Promise(resolve => {
  native.stdout.on("data", bytes => {
    process.stdout.write(bytes); lines += bytes.toString();
    assert(lines.length <= 2097152, "NATIVE_CONTROLLER_LINE_BOUND");
    while (lines.includes("\n")) {
      const end = lines.indexOf("\n"), line = lines.slice(0, end); lines = lines.slice(end + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.event !== "W2_MOUNTED_FIXTURE_READY") continue;
      assert(!browserStarted, "ONE_OWNED_BROWSER_ONLY"); browserStarted = true;
      void (async () => {
        control = JSON.parse(await readFile(value.privateFile, "utf8"));
        browser = spawn(process.execPath, [join(root, "scripts/postz-w2/headed-browser.mjs"),
          "--fixture", value.privateFile], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
        browser.stdout.on("data", bytes => process.stdout.write(bytes));
        browser.stderr.on("data", bytes => process.stderr.write(bytes));
        browser.once("error", async error => { console.error(error); browserStatus = 1; await abort(); resolve(); });
        browser.once("exit", async (code, signal) => {
          browserStatus = code ?? 1;
          if (browserStatus) await abort();
          console.log(JSON.stringify({ event: "W2_HEADED_BROWSER_EXIT", code, signal })); resolve();
        });
      })().catch(async error => { console.error(error); browserStatus = 1; await abort(); resolve(); });
    }
  });
  native.once("exit", () => { if (!browserStarted) resolve(); });
});
native.stderr.on("data", bytes => process.stderr.write(bytes));
const nativeDone = new Promise(resolve => {
  native.once("error", error => { console.error(error); nativeStatus = 1; resolve(); });
  native.once("exit", (code, signal) => {
    nativeStatus = code ?? 1;
    if (nativeStatus && browser && browser.exitCode === null) browser.kill("SIGTERM");
    console.log(JSON.stringify({ event: "W2_NATIVE_CONTROLLER_EXIT", code, signal })); resolve();
  });
});
await Promise.all([nativeDone, browserDone]);
assert.equal(nativeStatus, 0, "ACTUAL_NATIVE_CONTROLLER_MUST_PASS");
assert(browserStarted, "ACTUAL_SEPARATE_HEADED_BROWSER_MUST_RUN");
assert.equal(browserStatus, 0, "ACTUAL_SIX_MOUNTED_PREDICATES_MUST_PASS");
