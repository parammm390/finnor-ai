/** Original six mounted predicates, real input in a separate visible browser.
 * No credential/storage injection and no business-API substitute for the DOM. */
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { access, appendFile, lstat, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [flag, file] = process.argv.slice(2);
assert(flag === "--fixture" && file?.startsWith("/"), "OWNED_PRIVATE_FIXTURE_REQUIRED");
assert.equal((await stat(file)).mode & 0o777, 0o600);
const fixture = JSON.parse(await readFile(file, "utf8"));
const origin = new URL(fixture.frontendOrigin);
assert(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port);
const candidates = [process.env.FINNOR_W2_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium", chromium.executablePath()].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch {}
}
assert(executablePath, "EXISTING_VISIBLE_CHROMIUM_REQUIRED");
const profile = await mkdtemp("/tmp/finnor-w2-headed-");
const reportFile = join(fixture.evidence, "mounted-browser-report.json");
const report = { schema: "finnor.postz.w2.mounted-browser-evidence.v1", status: "IN_PROGRESS",
  source: "SEPARATELY_LAUNCHED_HEADED_PLAYWRIGHT_REAL_KEYBOARD_POINTER_AND_DOM",
  browser: { executablePath, version: null, headed: true, separatelyLaunched: true,
    freshTemporaryProfile: profile, userOwnedProfile: false },
  deviation: "Factory embedded pane replaced by coordinator-authorized separate visible local Chromium; hidden-pane input was unavailable.",
  genuineHumanQualified: false, protectedQualification: false, assertions: [], steps: [],
  profile: fixture.participantOnly ? "FOCUSED_PARTICIPANT_EXPIRY_ORIGINAL_SIX_NOT_RUN" : "ORIGINAL_COMPLETE_MOUNTED",
  rerun: "node scripts/postz-w2/headed-browser.mjs --fixture <new-mode-0600-native-mounted-fixture>",
  credentialsRecorded: false };
const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const record = async (name, observed, assertion = false) => {
  report.steps.push({ name, at: new Date().toISOString(), observed });
  if (assertion) report.assertions.push(name);
  await save(); console.log(JSON.stringify({ name, status: "PASS" }));
};
const control = async name => {
  const response = await fetch(fixture.controlOrigin + "/" + name, {
    method: name === "state" ? "GET" : "POST",
    headers: { authorization: "Bearer " + fixture.controlKey, "content-type": "application/json" },
    ...(name === "state" ? {} : { body: "{}" }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert.equal(response.status, 200, "OWNED_FAULT_CONTROL:" + name);
  return value;
};
let context;
try {
  await expect.poll(async () => {
    try { return (await fetch(origin.origin + "/centropy/login", { signal: AbortSignal.timeout(3000) })).status; }
    catch { return 0; }
  }, { timeout: 25000 }).toBe(200);
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: false,
    viewport: { width: 1440, height: 1000 }, args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check"] });
  report.browser.version = context.browser()?.version() ?? "unknown";
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["http:", "https:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)
      ? route.abort("blockedbyclient") : route.continue();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(25000);
  const panel = () => page.locator(`[data-workforce-work="${fixture.workId}"]`);
  const screenshot = name => page.screenshot({ path: join(fixture.evidence, "mounted-" + name + ".png") });
  const absent = async name => {
    await expect(page.locator("[data-workforce-work]").filter({ hasText: "W2_PRIVATE_MOUNTED_TASK" })).toHaveCount(0);
    await screenshot(name);
    await record(name, { actualDOM: true, privateContractVisible: false, url: page.url() }, true);
  };
  const login = async identity => {
    await page.goto(origin.origin + "/centropy/login");
    await page.locator("#centropy-login-email").click();
    await page.keyboard.type(fixture[identity].email);
    await page.locator("#centropy-login-password").click();
    await page.keyboard.type(fixture[identity].password);
    await page.locator("button[type=submit]").click();
    await page.waitForURL(url => url.pathname !== "/centropy/login");
    await record("ordinary-form-login-" + identity, { realKeyboardAndPointer: true, credentialsRecorded: false });
  };
  const signOut = async () => {
    await page.getByLabel("Account menu", { exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("link", { name: /^Sign in/ }).first()).toBeVisible({ timeout: 25000 });
  };
  // Additional product gate, before any deliberate canonical revocation.
  // The original six assertions below keep their exact count and predicates.
  await login("participant");
  await page.goto(fixture.participant.url);
  await expect(page.getByRole("heading", { name: "Your workforce contracts", level: 1, exact: true })).toBeVisible({ timeout: 25000 });
  const ownContracts = page.locator(`[data-workforce-work="${fixture.participant.workId}"]`);
  // The panel's exact RECIPIENT_SCOPED marker ("your contracts only" is rendered
  // only for that view); the earlier literal never matched shipped copy.
  await expect(ownContracts).toContainText("your contracts only", { timeout: 25000 });
  await expect(ownContracts.locator("tbody tr")).toHaveCount(fixture.participant.expectedOwnAssignments, { timeout: 25000 });
  await expect(page.getByRole("button", { name: "Compile original workforce outcome", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Account menu", { exact: true })).toHaveCount(0);
  await screenshot("nonowner-own-contracts");
  await record("nonowner-participant-workspace-exact-own-contracts", { actualDOM: true, canonicalRole: "technician",
    exactWork: fixture.participant.workId, ownAssignmentCount: 2, ownerShellAbsent: true, genuineHumanQualified: false });
  const expiredEnrollment = page.getByRole("article").filter({ has: page.getByRole("heading",
    { name: "expired: " + fixture.participant.expiryPurpose, exact: true }) });
  await expect(expiredEnrollment).toBeVisible({ timeout: 25000 });
  await expect(expiredEnrollment.getByRole("button")).toHaveCount(0);
  const freshEnrollment = page.getByRole("article").filter({ has: page.getByRole("heading",
    { name: "proposed: " + fixture.participant.expiryPurpose, exact: true }) });
  await expect(freshEnrollment).toBeVisible({ timeout: 25000 });
  await freshEnrollment.getByRole("button", { name: "Confirm my existing identity binding", exact: true }).click();
  await expect(page.getByRole("heading", { name: "confirmed: " + fixture.participant.expiryPurpose, exact: true }))
    .toBeVisible({ timeout: 25000 });
  const expiry = await control("participant-expiry");
  await screenshot("participant-natural-expiry-and-fresh-consent");
  await record("participant-natural-expiry-and-fresh-exact-mounted-consent", {
    actualDOM: true, expiredTerminalActions: 0, freshConfirmationByPointer: true, canonicalReadback: expiry });
  if (!fixture.participantOnly) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: /^Sign in/ }).first()).toBeVisible({ timeout: 25000 });
  await login("owner");
  await page.goto(fixture.url);
  await panel().getByRole("button", { name: "Compile original workforce outcome", exact: true }).click();
  // Use the driver's own declared 25-second browser bound for the real compile
  // and physical closure; Playwright's implicit 5s expect default was never
  // the declared limit and is too short for installed worker claim latency.
  await expect(panel()).toContainText("W2_PRIVATE_MOUNTED_TASK", { timeout: 25000 });
  await expect(panel()).toContainText("closed", { timeout: 25000 });
  const completion = await control("completion");
  await screenshot("original-positive");
  await record("mounted-original-compile-and-verified-completion",
    { actualDOM: true, realCompileClick: true, nativeCompletion: completion, originalWork: fixture.workId }, true);

  await page.goto(fixture.otherUrl);
  await expect(page.getByRole("heading", { name: "W2 separate empty Work scope", level: 1, exact: true })).toBeVisible({ timeout: 25000 });
  await absent("work-switch-withdrawal");
  await signOut();
  await login("alternate");
  await page.goto(fixture.alternate.url);
  await absent("same-tenant-principal-withdrawal");
  // A revoked alternate may show the closed access boundary; sign-out remains
  // possible through the ordinary login page rather than injecting a session.
  const account = page.getByLabel("Account menu", { exact: true });
  if (await account.isVisible()) await signOut();
  else {
    const logout = page.getByRole("button", { name: "Sign out", exact: true });
    await expect(logout).toBeVisible({ timeout: 25000 }); await logout.click();
    await expect(page.getByRole("link", { name: /^Sign in/ }).first()).toBeVisible({ timeout: 25000 });
  }
  await login("foreign");
  await page.goto(fixture.foreign.url);
  await expect(page.getByRole("heading", { name: "W2 foreign tenant private context", level: 1, exact: true })).toBeVisible({ timeout: 25000 });
  await absent("foreign-tenant-withdrawal");
  await signOut();
  await login("owner");
  await page.goto(fixture.url);
  await expect(panel()).toContainText("W2_PRIVATE_MOUNTED_TASK", { timeout: 25000 });
  await context.setOffline(true);
  await absent("offline-private-withdrawal");
  await context.setOffline(false);
  await page.goto(fixture.url);
  await expect(panel()).toContainText("W2_PRIVATE_MOUNTED_TASK", { timeout: 25000 });
  await control("delay-next");
  const pendingRequest = page.waitForEvent("request", { predicate: request =>
    request.method() === "GET" && new URL(request.url()).pathname.endsWith("/workforce/execution-programs/" + completion.programId) });
  await panel().getByRole("button", { name: "Refresh current contracts", exact: true }).click();
  const originalRequest = await pendingRequest;
  await expect.poll(async () => (await control("state")).delay.entered, { timeout: 25000 }).toBe(true);
  let drainTimer;
  const drained = new Promise((resolve, reject) => {
    const finish = (request, result) => {
      if (request !== originalRequest) return;
      clearTimeout(drainTimer); page.off("requestfinished", succeeded); page.off("requestfailed", failed);
      resolve({ originalUrl: request.url(), result });
    };
    const succeeded = request => finish(request, "FINISHED");
    const failed = request => finish(request, "FAILED_BY_DECLARED_OFFLINE_FAULT");
    page.on("requestfinished", succeeded); page.on("requestfailed", failed);
    drainTimer = setTimeout(() => reject(Error("ORIGINAL_DELAYED_REQUEST_DID_NOT_DRAIN")), 25000);
  });
  await context.setOffline(true);
  const revoked = await control("revoke-owner");
  await control("release");
  await context.setOffline(false);
  const actualDrain = await drained;
  await expect.poll(async () => (await control("state")).delay.drained, { timeout: 25000 }).toBe(true);
  // This sixth predicate must pass in the original document after the real old
  // request settles. A reload below cannot hide delayed-response resurrection.
  await absent("delayed-revoked-response-withdrawal");
  await record("original-delayed-response-drained-before-any-reload", { actualDrain, revoked,
    gate: (await control("state")).delay, noReloadUsedForSixthPredicate: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: /Workspace unavailable|Your investment context stays private/ })).toBeVisible({ timeout: 25000 });
  await expect(page.locator("[data-workforce-work]").filter({ hasText: "W2_PRIVATE_MOUNTED_TASK" })).toHaveCount(0);
  await screenshot("revoked-current-auth-after-independent-reload");
  await record("revocation-fault-observed", { revoked, oldResponseReleased: true });
  assert.equal(report.assertions.length, 6);
  }
  report.status = "PASS"; await save(); await control("finish");
} catch (error) {
  report.status = "FAIL"; report.failure = error instanceof Error ? error.stack : String(error);
  await save();
  if (context) await context.pages()[0]?.screenshot({ path: join(fixture.evidence, "mounted-failure.png") }).catch(() => {});
  await control("abort").catch(() => {});
  throw error;
} finally {
  await context?.close();
  const diskBytes = async path => {
    const value = await lstat(path);
    if (!value.isDirectory()) return value.blocks * 512;
    const children = await readdir(path);
    return value.blocks * 512 + (await Promise.all(children.map(child => diskBytes(join(path, child))))).reduce((a, b) => a + b, 0);
  };
  const deletedBytes = await diskBytes(profile);
  await rm(profile, { recursive: true, force: true });
  const disk = await statfs(fixture.evidence, { bigint: true });
  const ledger = process.env.FINNOR_W2_COORDINATION_LEDGER ?? join(fixture.evidence, "cleanup-ledger.log");
  assert(ledger.startsWith("/"), "ABSOLUTE_OWNED_COORDINATION_LEDGER_REQUIRED");
  await appendFile(ledger, `${new Date().toISOString()} W2 removed-owned-headed-profile path=${profile} deletedBytes=${deletedBytes} freeGiB=${disk.bavail * disk.bsize / 1073741824n}\n`);
  report.browser.temporaryProfileRemoved = true; report.browser.temporaryProfileDeletedBytes = deletedBytes;
  await save();
}
