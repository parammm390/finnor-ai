/** Real mounted controls only. Never route, fulfill, inject a session, create
 * an owner, or substitute a context for the authenticated native transport. */
import { originalDigest } from "./native-original-oracle.mjs";

const ensure = (condition, code) => { if (!condition) throw Error(code); };
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const equal = (a, b) => a !== undefined && b !== undefined && originalDigest(a) === originalDigest(b);
const panelAt = (page, workId) => page.locator(`.ct-application-semantics[data-application-work="${workId}"]`);
export const mountedWorkContract = Object.freeze({
  schema: "finnor.project-z.z0.real-mounted-controls.v1",
  authentication: "ACTUAL_BROWSER_ME_BEARER_VERIFIED_WITH_OWNED_REAL_AUTH_USER",
  acquisition: "SEMANTIC_FORM_KEYBOARD_NATIVE_ORIGINAL_RESERVATION",
  context: "REAL_INVESTIGATIONS_DRAWER_DISTINCT_ROOT_AND_WORK",
  principal: "REAL_SIGN_OUT_OTHER_EXISTING_OWNER_DENIED_OLD_WORK_AND_RESTORE",
  transportInterception: false, injectedAuth: false, createdTenantsOrPrincipals: false,
});

export async function signInExistingOwner(session, credentials, envValue) {
  const { page, target } = session, actor = credentials.actor;
  ensure(uuid(actor?.tenantId) && uuid(actor.principalId), "Z0_EXISTING_REAL_OWNER_IDENTITY_REQUIRED");
  await page.goto(target.frontendOrigin + "/centropy/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(envValue(credentials.ownerEmailEnv));
  await page.getByLabel("Password", { exact: true }).fill(envValue(credentials.ownerPasswordEnv));
  const response = page.waitForResponse(value => value.request().method() === "GET"
    && new URL(value.url()).origin === target.frontendOrigin && new URL(value.url()).pathname === "/api/centropy/me",
  { timeout: 30000 });
  const results = await Promise.allSettled([response, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  ensure(results.every(row => row.status === "fulfilled"), "Z0_REAL_MOUNTED_LOGIN_RESPONSE_NOT_OBSERVED");
  const me = results[0].value, identity = await me.json(), headers = await me.request().allHeaders();
  const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? "");
  ensure(me.ok() && identity.role === "owner" && identity.userId === actor.principalId
    && identity.tenantId === actor.tenantId && bearer && !headers["x-centropy-key"],
  "Z0_REAL_MOUNTED_OWNER_AUTH_REQUIRED");
  const userResponse = await fetch(target.authOrigin + "/auth/v1/user", {
    headers: { authorization: bearer[0], apikey: envValue(target.authAnonKeyEnv) },
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const user = await userResponse.json();
  ensure(userResponse.ok() && user.id === actor.principalId, "Z0_REAL_AUTH_USER_FOR_ACTUAL_BROWSER_BEARER_REQUIRED");
  await page.getByRole("heading", { name: "What needs to move forward?" }).waitFor({ state: "visible", timeout: 30000 });
  session.token = bearer[1]; session.authenticatedActor = { ...actor };
  session.steps.push({ kind: "ACTUAL_BROWSER_BEARER_REAL_AUTH_USER_AND_NATIVE_OWNER",
    tenantId: actor.tenantId, principalId: actor.principalId, meStatus: me.status(),
    authUserStatus: userResponse.status, identitySha256: originalDigest({ role: identity.role,
      tenantId: identity.tenantId, principalId: identity.userId }), secretsRecorded: false });
}
export async function signOutExistingOwner(session) {
  await session.page.locator('summary[aria-label="Account menu"]').click();
  await session.page.getByRole("button", { name: "Sign out", exact: true }).click();
  await session.page.locator(".ct-topbar").waitFor({ state: "hidden", timeout: 30000 });
  await session.page.locator(".ct-application-semantics").waitFor({ state: "hidden", timeout: 30000 });
  session.token = null; session.authenticatedActor = null;
}
export async function openMountedWork(session, fixture) {
  ensure(uuid(fixture.threadId) && uuid(fixture.workId), "Z0_ACTUAL_NATIVE_THREAD_AND_WORK_REQUIRED");
  await session.page.goto(session.target.frontendOrigin + "/centropy/investigations/" + fixture.threadId,
    { waitUntil: "domcontentloaded" });
  const panel = panelAt(session.page, fixture.workId);
  ensure(await panel.count() <= 1, "Z0_UNIQUE_MOUNTED_ORIGINAL_WORK_REQUIRED");
  await panel.waitFor({ state: "visible", timeout: 30000 });
  ensure(await panel.getAttribute("data-application-work") === fixture.workId, "Z0_MOUNTED_ORIGINAL_WORK_MISMATCH");
  return panel;
}
export async function submitMountedLearning(session, fixture, envValue) {
  const request = fixture.mountedAcquire, expected = session.originalExpected;
  ensure(request && expected && request.root?.entityType === "pe_deal"
    && request.root.entityId === expected.frozenPayload.dealId && equal(request.profileIds, fixture.profileIds)
    && equal(request.institutionalOrigin, { compilerRequestId: expected.compilerRequestId,
      programId: expected.programId, responsibilityIdentity: expected.stableIdentity })
    && request.expectedStatus === 200 && request.expectedResponse && Number.isFinite(Date.parse(request.deadlineAt))
    && Date.parse(request.deadlineAt) <= Date.parse(expected.originalDeadlineAt),
  "Z0_INDEPENDENT_MOUNTED_ORIGINAL_ACQUISITION_REQUIRED");
  ensure(equal(session.authenticatedActor, session.target.actor), "Z0_MOUNTED_ORIGINAL_ACTOR_MISMATCH");
  const endpoint = session.target.frontendOrigin + "/api/centropy/company-brain/application-acquire";
  ensure(session.target.allowedHttpOperations.some(row => row.method === "POST" && row.url === endpoint),
    "Z0_MOUNTED_ACQUISITION_AUTHORITY_NOT_DELIVERED");
  const panel = await openMountedWork(session, fixture);
  await panel.getByLabel("Existing discovery-profile UUIDs — JSON array, 1–8 distinct references").fill(JSON.stringify(request.profileIds));
  await panel.getByLabel("Authorized discovery targets — JSON array, 2–16 distinct identities").fill(JSON.stringify(request.targets));
  await panel.getByLabel("Original resource demand — JSON array, 1–2 resource bindings").fill(JSON.stringify(request.resourceDemand));
  await panel.getByLabel("Original deadline — ISO timestamp with explicit time-zone offset").fill(request.deadlineAt);
  await panel.getByText("Learn for an unfinished original X1 responsibility", { exact: true }).click();
  await panel.getByLabel("Original institution references (optional for a standalone non-X1 Work)")
    .fill(JSON.stringify(request.institutionalOrigin));
  const button = panel.getByRole("button", { name: "Request learning under original reservation", exact: true });
  await button.focus();
  const response = session.page.waitForResponse(value => value.url() === endpoint && value.request().method() === "POST",
    { timeout: 30000 });
  const results = await Promise.allSettled([response, button.press("Enter")]);
  ensure(results.every(row => row.status === "fulfilled"), "Z0_REAL_MOUNTED_LEARNING_SUBMISSION_NOT_OBSERVED");
  const actual = results[0].value, body = actual.request().postDataJSON(), returned = await actual.json();
  const { idempotencyKey, ...standing } = body;
  const expectedBody = { root: request.root, workId: fixture.workId, profileIds: request.profileIds,
    targets: request.targets, resourceDemand: request.resourceDemand, deadlineAt: request.deadlineAt,
    institutionalOrigin: request.institutionalOrigin };
  ensure(actual.status() === request.expectedStatus && uuid(idempotencyKey) && equal(standing, expectedBody)
    && uuid(returned.sessionId) && returned.protectedAdmission === false
    && Object.entries(request.expectedResponse).every(([key, value]) => equal(returned[key], value)),
  "Z0_MOUNTED_NATIVE_REQUEST_OR_RESERVATION_RESPONSE_MISMATCH");
  session.steps.push({ kind: "REAL_MOUNTED_KEYBOARD_ORIGINAL_LEARNING_ACQUISITION", workId: fixture.workId,
    sessionId: returned.sessionId, status: actual.status(), requestSha256: originalDigest(body),
    responseSha256: originalDigest(returned), secretEnvironmentNamesOnly: [session.target.ownerEmailEnv],
    newAllowance: false, protectedAdmission: false });
  return returned.sessionId;
}

export async function refreshMountedWork(session, fixture, panel) {
  const url = session.target.frontendOrigin + "/api/centropy/company-brain/application-projection";
  const response = session.page.waitForResponse(value => value.url() === url && value.request().method() === "POST"
    && value.request().postDataJSON()?.workId === fixture.workId, { timeout: 30000 });
  const button = panel.getByRole("button", { name: "Refresh current scope", exact: true });
  await button.focus();
  const results = await Promise.allSettled([response, button.press("Enter")]);
  ensure(results.every(row => row.status === "fulfilled") && results[0].value.ok(), "Z0_REAL_MOUNTED_REFRESH_NOT_OBSERVED");
  const actual = await results[0].value.json();
  ensure(actual.workId === fixture.workId && actual.tenantId === session.target.actor.tenantId
    && actual.principalId === session.target.actor.principalId, "Z0_REFRESHED_NATIVE_SCOPE_MISMATCH");
  session.steps.push({ kind: "REAL_MOUNTED_KEYBOARD_REFRESH", workId: fixture.workId,
    responseSha256: originalDigest(actual), status: results[0].value.status() });
}
async function selectInvestigation(session, fixture) {
  ensure(uuid(fixture.threadId) && uuid(fixture.workId) && typeof fixture.threadTitle === "string"
    && fixture.threadTitle.trim().length > 0, "Z0_PREEXISTING_DRAWER_INVESTIGATION_REQUIRED");
  await session.page.getByRole("button", { name: "Investigations", exact: true }).click();
  const drawer = session.page.getByRole("dialog", { name: "Recent Investigations", exact: true });
  const control = drawer.locator("ol li button").filter({ has: drawer.getByText(fixture.threadTitle, { exact: true }) });
  ensure(await control.count() === 1, "Z0_UNIQUE_REAL_INVESTIGATION_DRAWER_CONTROL_REQUIRED");
  await control.focus(); await control.press("Enter");
  await session.page.waitForURL(url => url.pathname === "/centropy/investigations/" + fixture.threadId, { timeout: 30000 });
  const panel = panelAt(session.page, fixture.workId);
  await panel.waitFor({ state: "visible", timeout: 30000 });
  return panel;
}
export async function switchMountedContexts(session, fixture, envValue) {
  const other = fixture.otherMountedContext, alternate = session.target.alternateOwner;
  ensure(other && uuid(other.root?.entityId) && other.root.entityType === "pe_deal"
    && other.root.entityId !== fixture.root?.entityId && other.workId !== fixture.workId
    && other.threadId !== fixture.threadId && other.threadTitle !== fixture.threadTitle
    && alternate?.actor?.principalId !== session.target.actor.principalId
    && alternate?.actor?.tenantId !== session.target.actor.tenantId
    && Array.isArray(fixture.privateMountedMarkers) && fixture.privateMountedMarkers.length > 0,
  "Z0_DISTINCT_EXISTING_ROOT_WORK_AND_REAL_OWNER_REQUIRED");
  const originalPanel = panelAt(session.page, fixture.workId), originalText = await originalPanel.innerText();
  ensure(fixture.privateMountedMarkers.every(marker => typeof marker === "string" && marker.length >= 16
    && originalText.includes(marker)), "Z0_ACTUAL_PRIVATE_MARKERS_REQUIRED_BEFORE_PRINCIPAL_SWITCH");
  const otherPanel = await selectInvestigation(session, other);
  ensure((await otherPanel.innerText()).includes(other.root.entityId)
    && await panelAt(session.page, fixture.workId).count() === 0, "Z0_ROOT_SWITCH_RETAINED_OLD_PRIVATE_WORK");
  const restored = await selectInvestigation(session, fixture);
  ensure(await restored.getAttribute("data-application-work") === fixture.workId
    && await panelAt(session.page, other.workId).count() === 0, "Z0_ORIGINAL_ROOT_SWITCH_NOT_RESTORED");
  session.steps.push({ kind: "REAL_DRAWER_ROOT_WORK_SWITCH_AND_RETURN", originalWorkId: fixture.workId,
    otherWorkId: other.workId, otherRootSha256: originalDigest(other.root) });
  await signOutExistingOwner(session);
  try {
    await signInExistingOwner(session, alternate, envValue);
    await session.page.goto(session.target.frontendOrigin + "/centropy/investigations/" + fixture.threadId,
      { waitUntil: "domcontentloaded" });
    const denied = await session.browserContext.request.get(session.target.frontendOrigin + "/api/centropy/works/" + fixture.workId,
      { headers: { authorization: "Bearer " + session.token } });
    ensure([403, 404].includes(denied.status()), "Z0_OTHER_REAL_OWNER_READ_ORIGINAL_PRIVATE_WORK");
    await panelAt(session.page, fixture.workId).waitFor({ state: "hidden", timeout: 30000 });
    const text = await session.page.locator("body").innerText();
    ensure(fixture.privateMountedMarkers.every(marker => !text.includes(marker)),
      "Z0_PRIVATE_ORIGINAL_MARKER_SURVIVED_REAL_PRINCIPAL_SWITCH");
    session.steps.push({ kind: "REAL_OTHER_OWNER_NATIVE_OLD_WORK_DENIED", status: denied.status(),
      originalWorkId: fixture.workId, privateMarkersSha256: originalDigest(fixture.privateMountedMarkers),
      otherPrincipalId: alternate.actor.principalId, createdIdentity: false });
  } finally {
    if (session.authenticatedActor) await signOutExistingOwner(session);
    await signInExistingOwner(session, session.target, envValue);
    await openMountedWork(session, fixture);
  }
}
