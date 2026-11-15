/** Actual browser/control client. Credentials stay on stdin in an owned vault;
 * no storage injection, business API substitution or simulated human claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
assert(args[0] === "--fixture" && args[1]?.startsWith("/") && args[2], "ABSOLUTE_OWNED_PRIVATE_FIXTURE_REQUIRED");
const privateFile = args[1], action = args[2], rest = args.slice(3);
assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
const fixture = JSON.parse(await readFile(privateFile, "utf8")), origin = new URL(fixture.frontendOrigin);
assert(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port && !origin.username && !origin.password);
const bin = process.env.FINNOR_AGENT_BROWSER_BIN ?? "agent-browser";
const env = { ...process.env };
if (!env.AGENT_BROWSER_SESSION) {
  const id = spawnSync(bin, ["session", "id", "--scope", "worktree", "--prefix", "postz-w2"], { encoding: "utf8" });
  assert.equal(id.status, 0); env.AGENT_BROWSER_SESSION = id.stdout.trim();
}
const prefix = env.FACTORY_DESKTOP_CDP_PORT
  ? (assert(env.AGENT_BROWSER_CDP, "DESKTOP_BROWSER_ENDPOINT_REQUIRED"), ["--cdp", env.AGENT_BROWSER_CDP]) : [];
const browser = (command, input) => {
  const result = spawnSync(bin, [...prefix, ...command], { env, encoding: "utf8", input, timeout: 120000, maxBuffer: 2097152 });
  if (result.status !== 0 || result.error) {
    process.stderr.write(result.stderr ?? "");
    if (result.stdout) process.stderr.write(result.stdout);
    throw Error("ACTUAL_BROWSER_COMMAND_FAILED:" + command[0]);
  }
  return result.stdout;
};
const reportPath = join(fixture.evidence, "mounted-browser-report.json");
let report;
try { report = JSON.parse(await readFile(reportPath, "utf8")); }
catch { report = { schema: "finnor.postz.w2.mounted-browser-evidence.v1", status: "IN_PROGRESS", assertions: [], steps: [],
  source: "ACTUAL_AGENT_BROWSER_CDP_DOM_NOT_A_FIXTURE_PROJECTION", genuineHumanQualified: false }; }
const record = async (name, observed, assertion = false) => {
  report.steps.push({ name, at: new Date().toISOString(), observed });
  if (assertion) report.assertions.push(name);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ action: name, status: "PASS", evidence: reportPath }));
};
const control = async (name, body) => {
  const response = await fetch(fixture.controlOrigin + "/" + name, {
    method: name === "state" ? "GET" : "POST", headers: { authorization: "Bearer " + fixture.controlKey,
      "content-type": "application/json" }, ...(name === "state" ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
};
if (action === "login") {
  const identity = rest[0] ?? "owner", credentials = fixture[identity];
  assert(["owner", "alternate", "foreign"].includes(identity) && credentials);
  const alias = "w2-owned-" + createHash("sha256").update(origin.origin + credentials.email).digest("hex").slice(0, 16);
  browser(["auth", "save", alias, "--url", origin.origin + "/centropy/login", "--username", credentials.email,
    "--password-stdin", "--username-selector", "#centropy-login-email", "--password-selector", "#centropy-login-password",
    "--submit-selector", "button[type=submit]"], credentials.password + "\n");
  try { browser(["auth", "login", alias]); }
  finally { browser(["auth", "delete", alias]); }
  await record("authenticated-browser-login-" + identity, { actualForm: true, credentialsRecorded: false });
} else if (action === "open") {
  const url = rest[0] === "other" ? fixture.otherUrl : rest[0] === "alternate" ? fixture.alternate.url :
    rest[0] === "foreign" ? fixture.foreign.url : fixture.url;
  browser(["open", url]); await record("open-" + (rest[0] ?? "owner"), { url });
} else if (action === "snapshot") {
  const name = rest[0] ?? "current"; assert(/^[a-z0-9-]+$/.test(name));
  const value = browser(["snapshot", "-i"]);
  await writeFile(join(fixture.evidence, "mounted-" + name + ".txt"), value, { mode: 0o600 });
  process.stdout.write(value); await record("snapshot-" + name, { sha256: createHash("sha256").update(value).digest("hex") });
} else if (action === "screenshot") {
  const name = rest[0] ?? "current"; assert(/^[a-z0-9-]+$/.test(name));
  const path = join(fixture.evidence, "mounted-" + name + ".png");
  browser(["screenshot", path]); await record("screenshot-" + name, { path });
} else if (action === "assert-positive") {
  const selector = `[data-workforce-work="${fixture.workId}"]`;
  browser(["wait", "--fn", `Boolean(document.querySelector(${JSON.stringify(selector)})?.textContent.includes("W2_PRIVATE_MOUNTED_TASK") && document.querySelector(${JSON.stringify(selector)})?.textContent.includes("closed"))`]);
  const observed = browser(["eval", "--stdin"], `const section=document.querySelector(${JSON.stringify(selector)});
if(!section || !section.textContent.includes("W2_PRIVATE_MOUNTED_TASK") || !section.textContent.includes("closed"))throw Error("MOUNTED_ORIGINAL_CLOSED_CONTRACT_MISSING");
({workId:section.getAttribute("data-workforce-work"),text:section.innerText,actualDOM:true});`);
  const completion = await control("completion");
  await record("mounted-original-compile-and-verified-completion", { actualDOM: observed, nativeCompletion: completion }, true);
} else if (action === "assert-absent") {
  const name = rest[0]; assert(name && /^[a-z0-9-]+$/.test(name));
  const observed = browser(["eval", "--stdin"], `const panels=[...document.querySelectorAll("[data-workforce-work]")];
if(panels.some(section=>section.textContent.includes("W2_PRIVATE_MOUNTED_TASK")))throw Error("STALE_PRIVATE_WORKFORCE_CONTRACT_VISIBLE");
({actualDOM:true,privateContractVisible:false,workforcePanels:panels.length,url:location.href});`);
  await record(name, { actualDOM: observed }, true);
} else if (action === "control") {
  assert(["state", "delay-next", "release", "revoke-owner", "abort"].includes(rest[0]));
  const value = await control(rest[0]); await record("control-" + rest[0], value); console.log(JSON.stringify(value));
} else if (action === "finish") {
  const required = ["mounted-original-compile-and-verified-completion", "work-switch-withdrawal",
    "same-tenant-principal-withdrawal", "foreign-tenant-withdrawal", "offline-private-withdrawal", "delayed-revoked-response-withdrawal"];
  assert(required.every(name => report.assertions.includes(name)), "ALL_ACTUAL_BROWSER_PREDICATES_REQUIRED");
  report.status = "PASS"; await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await control("finish"); await record("actual-browser-suite-complete", { genuineHumanQualified: false });
} else if (action === "cli") {
  assert(!["close", "reload", "connect", "install"].includes(rest[0]), "USER_OWNED_DESKTOP_BROWSER_MUST_BE_PRESERVED");
  process.stdout.write(browser(rest));
} else throw Error("UNKNOWN_OWNED_BROWSER_ACTION");
