/** Supported CLI only. No Playwright, raw CDP socket, discovery, or fallback. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { observeAssignedBrowser, passiveAssignedBrowserProvenance, readPinnedBrowserProof,
  requireCanonicalObserverPath, requireCurrentPriorProof, validateObservedBrowserProof
} from "./browser-provenance-observer.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const loopbackOrigin = value => {
  const url = new URL(value);
  assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) >= 1024
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "EXACT_DISPOSABLE_LOOPBACK_ORIGIN_REQUIRED");
  return url.origin;
};
export async function createAssignedClient() {
  const env = { ...process.env };
  assert(env.FACTORY_DESKTOP_CDP_PORT && env.AGENT_BROWSER_CDP && env.AGENT_BROWSER_SESSION,
    "ASSIGNED_DESKTOP_CDP_AND_SESSION_REQUIRED_NO_AUTOLAUNCH_FALLBACK");
  let binary = env.FINNOR_AGENT_BROWSER_BIN;
  if (!binary) for (const directory of (env.PATH ?? "").split(":").filter(value => value.startsWith("/"))) {
    const candidate = join(directory, "agent-browser");
    try { await access(candidate, 1); binary = await realpath(candidate); break; } catch {}
  }
  assert(binary, "DECLARED_SUPPORTED_AGENT_BROWSER_BINARY_REQUIRED");
  assert(binary.startsWith("/"), "DECLARED_ABSOLUTE_AGENT_BROWSER_BINARY_REQUIRED");
  await requireCanonicalObserverPath(binary);
  const info = await lstat(binary);
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 536870912,
    "DECLARED_REGULAR_BOUNDED_AGENT_BROWSER_BINARY_REQUIRED");
  const binaryHash = createHash("sha256");
  let bytesRead = 0;
  for await (const bytes of createReadStream(binary)) {
    bytesRead += bytes.length;
    assert(bytesRead <= info.size, "SUPPORTED_BROWSER_BINARY_GREW_DURING_PIN");
    binaryHash.update(bytes);
  }
  assert.equal(bytesRead, info.size, "SUPPORTED_BROWSER_BINARY_CHANGED_DURING_PIN");
  const binarySha256 = binaryHash.digest("hex");
  const prefix = ["--cdp", env.AGENT_BROWSER_CDP, "--session", env.AGENT_BROWSER_SESSION, "--json"];
  const run = (command, input, limits = {}) => {
    const readOnlyTabList = command.length === 2 && command[0] === "tab" && command[1] === "list";
    assert(command.length && (readOnlyTabList
      || !["close", "reload", "connect", "install", "doctor", "tab"].includes(command[0])),
    "USER_OWNED_DESKTOP_BROWSER_MUST_BE_PRESERVED");
    const timeout = limits.timeoutMs ?? 25000, maxBuffer = limits.maxBuffer ?? 2097152;
    assert(Number.isInteger(timeout) && timeout >= 1 && timeout <= 25000
      && Number.isInteger(maxBuffer) && maxBuffer >= 1 && maxBuffer <= 2097152,
    "FINITE_SUPPORTED_BROWSER_COMMAND_LIMITS_REQUIRED");
    const result = spawnSync(binary, [...prefix, ...command], {
      env, input, encoding: "utf8", timeout, maxBuffer,
    });
    // Browser stdout/stderr can contain endpoints, credentials or private DOM.
    // Never echo either stream on failure.
    assert(!result.error && result.status === 0 && !result.signal,
      "ACTUAL_SUPPORTED_BROWSER_COMMAND_FAILED:" + command[0]);
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw Error("ACTUAL_BROWSER_JSON_RESULT_REQUIRED"); }
    assert(value.success === true && value.error === undefined, "ACTUAL_BROWSER_SUCCESS_RECEIPT_REQUIRED");
    return value;
  };
  const dom = (source, limits) => {
    const value = run(["eval", "--stdin"], "JSON.stringify((()=>{\n" + source + "\n})());", limits);
    let result = value.data?.result ?? value.data ?? value.result;
    if (typeof result === "string") result = JSON.parse(result);
    assert(result && typeof result === "object", "ACTUAL_DOM_JSON_RESULT_REQUIRED");
    return result;
  };
  const wait = expression => run(["wait", "--fn", expression]);
  const binaryPin = Object.freeze({ path: resolve(binary), sha256: binarySha256 });
  const provenance = async () => passiveAssignedBrowserProvenance({ env, binary: binaryPin });
  const observeProvenance = (options = {}) => observeAssignedBrowser({ env, binary: binaryPin, run, dom,
    inputReference: options.inputReference, clock: options.clock });
  const validateProof = async (file, sha256) => {
    const prior = await readPinnedBrowserProof(file, sha256);
    requireCurrentPriorProof(prior);
    // A pinned previous file cannot replace this fresh, active native/DOM binding.
    const current = await observeProvenance();
    try { return validateObservedBrowserProof(prior, current); }
    catch (error) {
      return { ...current, status: "UNKNOWN", reason: "CURRENT_BROWSER_PROOF_DOES_NOT_MATCH_PRIOR",
        proofValidationFailure: error.observerCode ?? "CURRENT_BROWSER_PROOF_VALIDATION_FAILED" };
    }
  };
  const login = (origin, credentials) => {
    assert(credentials && typeof credentials.email === "string" && typeof credentials.password === "string");
    const alias = "w2-owned-" + randomBytes(16).toString("hex");
    run(["open", origin + "/centropy/login"]);
    let failure;
    try {
      run(["auth", "save", alias, "--url", origin + "/centropy/login", "--username", credentials.email,
        "--password-stdin", "--username-selector", "#centropy-login-email",
        "--password-selector", "#centropy-login-password", "--submit-selector", "button[type=submit]"],
      credentials.password + "\n");
      run(["auth", "login", alias]);
      wait('location.pathname !== "/centropy/login"');
    } catch (error) {
      failure = error;
    } finally {
      try { run(["auth", "delete", alias]); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  return { run, dom, wait, provenance, observeProvenance, validateProof, login };
}
