/** Pre-code bounded transport regression. The independent HTTP fixture owns
 * accepted bytes, auth and attempts. Not native Work/S6 or mounted UI proof. */
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ApplicationComputerProvider, ApplicationProviderFault, applicationByteDigest, applicationContentRef,
  type ApplicationComputerSession, type ApplicationDocument, type ApplicationPublicSource,
  type ApplicationSessionOptions,
} from "../../packages/computer/src/application-provider";
import type {
  AuthorizedApplicationProfile, PreparedApplicationWire,
} from "../../packages/private-equity/src/application-semantics/ports";
import type { ScopedApplicationIdentity } from "@finnor/shared-types";
import { ApplicationSourceSession } from "../../packages/private-equity/src/application-semantics/source";

const destination = process.argv[2];
if (!destination?.startsWith("/")) throw Error("FRESH_ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED");
await mkdir(destination, { mode: 0o700 });
const credential = randomBytes(24).toString("base64url"), cookie = randomBytes(24).toString("base64url");
const csrf = randomBytes(24).toString("base64url");
const document = (content: string) => `<!doctype html><html><head><title>Bounded fixture</title></head><body>${content}</body></html>`;
const valid = document(`<section><h2>Change value</h2><form action="/change" method="post">
<input type="hidden" name="csrf" value="${csrf}">
<label for="choice">Choice</label><select name="value" id="choice"><option value="one" selected>One</option><option value="two">Two</option></select>
<label for="note">Note</label><textarea id="note" name="note">A &amp; B</textarea>
<button type="submit">Change value</button></form></section>
<article aria-label="Observed record"><dl><dt>status</dt><dd>READY</dd><dt>absent</dt><dd></dd></dl></article>`);
const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const collisionBinding = {
  applicationId: "passive-fixture", accountId: "ordinary-account", recordId: "collision",
  principalId: "ordinary-actor", grantId: "public-fixture-grant", applicationVersion: "fixture-v1",
  schemaRevision: "1", semanticRevision: 1, renderingRevision: 1, authorityRevision: 1, grantRevision: 1,
};
const collisionRecord = { ...collisionBinding, version: 1, phase: "READY", reporting: {
  amount: "1.00", currency: "USD", entity: "ordinary-entity", unit: "ones", date: "2027-06-30", basis: "cash",
}, observation: { available: ["phase", "reporting"], unavailable: [] } };
const collisionForm = (unsupported: boolean) => `<form aria-label="Change value" method="post"
action="/records/collision/change"${unsupported ? ' target="_blank"' : ""}>
<input type="hidden" name="context" value="${escape(JSON.stringify(collisionBinding))}">
<input type="hidden" name="request" value="${escape(JSON.stringify({
  requestId: "request", effectId: "effect", obligationId: "obligation", idempotencyKey: "key",
  parentId: "original-parent", deadline: "2027-06-30T00:00:00.000Z",
}))}"><input type="hidden" name="expectedVersion" value="1"><input name="next" value="READY" required>
<button type="submit">Change value</button></form>`;
const collisionDocument = document(`<article><dl>${Object.entries(collisionRecord).map(([name, value]) =>
  `<dt>${escape(name)}</dt><dd>${escape(typeof value === "object" ? JSON.stringify(value) : value)}</dd>`).join("")}
</dl></article>${collisionForm(false)}${collisionForm(true)}`);
const malformed = [
  { id: "script", html: document("<script>alert(1)</script>"), code: "X2_PASSIVE_ACTIVE_DOCUMENT" },
  { id: "frame", html: document('<iframe src="/secret"></iframe>'), code: "X2_PASSIVE_ACTIVE_DOCUMENT" },
  { id: "handler", html: valid.replace("<section>", '<section onclick="fetch(\'/secret\')">'), code: "X2_PASSIVE_ACTIVE_DOCUMENT" },
  { id: "external-control", html: valid.replace('name="note"', 'name="note" form="other"'), code: "X2_PASSIVE_EXTERNAL_CONTROL" },
  { id: "submit-override", html: valid.replace('type="submit"', 'type="submit" formaction="/other"'), code: "X2_PASSIVE_SUBMIT_OVERRIDE" },
  { id: "duplicate-name", html: valid.replace('name="note"', 'name="value"'), code: "X2_PASSIVE_AMBIGUOUS_CONTROL" },
  { id: "duplicate-id", html: valid.replace('id="note"', 'id="choice"'), code: "X2_PASSIVE_AMBIGUOUS_ID" },
  { id: "duplicate-attribute", html: valid.replace('name="note"', 'name="note" NAME="other"'), code: "X2_PASSIVE_AMBIGUOUS_ATTRIBUTE" },
  { id: "nested-form", html: valid.replace("<button", '<form action="/other"><button'), code: "X2_PASSIVE_NESTED_FORM" },
  { id: "unknown-entity", html: valid.replace("A &amp; B", "A &unknown; B"), code: "X2_PASSIVE_UNSUPPORTED_ENTITY" },
  { id: "bad-codepoint", html: valid.replace("A &amp; B", "&#xD800;"), code: "X2_PASSIVE_UNSUPPORTED_ENTITY" },
  { id: "unbalanced", html: valid.replace("</section>", "</div>"), code: "X2_PASSIVE_UNBALANCED_DOCUMENT" },
  { id: "unquoted-value", html: valid.replace('name="note"', "name=note"), code: "X2_PASSIVE_MALFORMED_ATTRIBUTE" },
  { id: "multiple-select", html: valid.replace('name="value"', 'name="value" multiple'), code: "X2_PASSIVE_UNSUPPORTED_CONTROL" },
  { id: "double-selected", html: valid.replace('value="two"', 'value="two" selected'), code: "X2_PASSIVE_AMBIGUOUS_CONTROL" },
  { id: "file", html: valid.replace('type="hidden"', 'type="file"'), code: "X2_PASSIVE_UNSUPPORTED_CONTROL" },
  { id: "depth-bound", html: document("<div>".repeat(33) + "</div>".repeat(33)), code: "X2_PASSIVE_STRUCTURE_BOUND" },
  { id: "node-bound", html: document("<span></span>".repeat(2050)), code: "X2_PASSIVE_STRUCTURE_BOUND" },
  { id: "form-bound", html: document('<form method="post"></form>'.repeat(17)), code: "X2_DOCUMENT_STRUCTURE_BOUND" },
  { id: "control-bound", html: document('<form method="post">' + Array.from({ length: 33 }, (_, n) => `<input name="v${n}">`).join("") + "</form>"), code: "X2_DOCUMENT_STRUCTURE_BOUND" },
  { id: "description-bound", html: document("<dl></dl>".repeat(17)), code: "X2_DOCUMENT_STRUCTURE_BOUND" },
  { id: "entry-bound", html: document("<dl>" + "<dt>x</dt><dd>v</dd>".repeat(33) + "</dl>"), code: "X2_DOCUMENT_STRUCTURE_BOUND" },
  { id: "select-control", html: valid.replace("<option", '<input name="extra"><option'), code: "X2_PASSIVE_AMBIGUOUS_STRUCTURE" },
  { id: "paragraph-form", html: valid.replace("<section>", "<section><p>").replace("</section>", "</p></section>"), code: "X2_PASSIVE_AMBIGUOUS_STRUCTURE" },
  { id: "button-form", html: document('<button><form action="/change"><input name="v"></form></button>'), code: "X2_PASSIVE_AMBIGUOUS_STRUCTURE" },
  { id: "external-option", html: document('<option value="one">One</option>'), code: "X2_PASSIVE_AMBIGUOUS_STRUCTURE" },
] as const;
const journal: Array<{ method: string; path: string; bodyDigest: string | null; outcome: string }> = [];
let acceptNext = true, loseResponse = false;
const expectedBody = new URLSearchParams([["csrf", csrf], ["value", "two"], ["note", "A & B"]]).toString();
const server = createServer(async (request, response) => {
  const path = request.url ?? "/";
  const chunks: Buffer[] = [];
  for await (const piece of request) chunks.push(Buffer.from(piece));
  const body = Buffer.concat(chunks).toString("utf8");
  if (request.method === "POST" && path === "/login" && body === new URLSearchParams({ credential }).toString()) {
    journal.push({ method: "POST", path, bodyDigest: null, outcome: "SESSION_CREATED" });
    response.writeHead(303, { location: "/records/valid", "set-cookie": `fixture_session=${cookie}; Path=/; HttpOnly; SameSite=Strict` }).end();
    return;
  }
  if (request.headers.cookie !== `fixture_session=${cookie}` || request.headers.authorization) {
    journal.push({ method: request.method ?? "", path, bodyDigest: null, outcome: "AUTH_REFUSED" });
    response.writeHead(403).end(); return;
  }
  if (request.method === "GET" && path.startsWith("/records/")) {
    const html = path === "/records/collision" ? collisionDocument
      : malformed.find(item => path === `/records/${item.id}`)?.html ?? valid;
    journal.push({ method: "GET", path, bodyDigest: null, outcome: "SOURCE" });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html); return;
  }
  const accepted = request.method === "POST" && path === "/change" && acceptNext
    && request.headers["content-type"] === "application/x-www-form-urlencoded" && body === expectedBody;
  journal.push({ method: request.method ?? "", path, bodyDigest: applicationByteDigest(body), outcome: accepted ? "ACCEPTED" : "REFUSED" });
  if (accepted && loseResponse) { request.socket.destroy(); return; }
  response.writeHead(accepted ? 200 : 409, { "content-type": "application/json" }).end(JSON.stringify({ accepted }));
});
await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
const address = server.address();
if (!address || typeof address === "string") throw Error("OWNED_LOOPBACK_REQUIRED");
const origin = `http://127.0.0.1:${address.port}`;
const login = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ credential }),
  headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
assert.equal(login.status, 303);
const authCookie = login.headers.get("set-cookie")?.split(";")[0];
assert.equal(authCookie, `fixture_session=${cookie}`);
const target = (id = "valid"): ScopedApplicationIdentity => ({ kind: "identity", application: "passive-fixture",
  account: "ordinary-account", entity: "ordinary-entity", id });
const profile: AuthorizedApplicationProfile = {
  id: "ordinary-profile", tenantId: "ordinary-tenant", principalId: "ordinary-actor",
  application: "passive-fixture", account: "ordinary-account", actingPrincipal: "ordinary-actor", role: "editor",
  grantRef: applicationContentRef("fixture-current-grant", { current: true }), origin,
  entrypoint: "/records/{recordId}", documentationPaths: [], contextPath: null,
  recordPathTemplate: "/records/{recordId}", requestPathTemplate: null,
  allowedTargets: ["valid"], validUntil: new Date(Date.now() + 600000).toISOString(),
  credentials: { headers: { cookie: authCookie! } }, sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1",
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY", discoverySurface: "UI",
};
// Future document overload is declared here before its implementation.
type PassiveSession = Omit<ApplicationComputerSession, "document"> & {
  document(kind: "entrypoint" | "record" | "request", target?: ScopedApplicationIdentity,
    identity?: PreparedApplicationWire["identity"], source?: ApplicationPublicSource): Promise<ApplicationDocument>;
};
const sessions: PassiveSession[] = [], reads: Array<{ stage: string; kind: string }> = [];
const sources: Array<{ digest: string; kind: string }> = [];
function session(id = "valid") {
  const options: ApplicationSessionOptions & { documentTransport: "PASSIVE_HTML" } = {
    documentTransport: "PASSIVE_HTML", readFence: {
      beforeRead: async input => { reads.push({ stage: "START", kind: input.kind }); },
      afterRead: async input => { reads.push({ stage: "FINISH", kind: input.kind }); },
    },
  };
  const s = new ApplicationComputerProvider().createSession({ ...profile, allowedTargets: [id] }, async (ref, body) => {
    sources.push({ digest: ref.contentDigest!, kind: (body as { kind: string }).kind });
  }, options) as unknown as PassiveSession;
  sessions.push(s); return s;
}
function wire(overrides: Partial<PreparedApplicationWire> = {}): PreparedApplicationWire {
  return { url: origin + "/change", method: "POST", contentType: "application/x-www-form-urlencoded",
    body: expectedBody, bodyDigest: applicationByteDigest(expectedBody),
    bindingRef: applicationContentRef("fixture-wire-binding", { current: true }),
    identity: { requestId: randomUUID(), effectId: randomUUID(), obligationId: randomUUID(),
      idempotencyKey: randomUUID(), parentId: "original-test-parent", deadline: profile.validUntil },
    context: { application: profile.application, account: profile.account }, expectedVersion: "1", ...overrides };
}
const controls = () => ({ csrf, value: "two", note: "A & B" });
const results: Array<{ id: string; pass: boolean; code: string | null; observed: unknown }> = [];
async function test(id: string, perform: () => Promise<unknown>) {
  try { results.push({ id, pass: true, code: null, observed: await perform() }); }
  catch (error) { results.push({ id, pass: false, code: error instanceof ApplicationProviderFault ? error.code : "ASSERTION_OR_UNCLASSIFIED_FAILURE", observed: null }); }
}
async function refusal(call: () => unknown, code: string) {
  let actual: string | null = null;
  try { await call(); } catch (error) { actual = error instanceof ApplicationProviderFault ? error.code : "UNCLASSIFIED"; }
  assert.equal(actual, code, "INTENDED_TRANSPORT_GUARD_REQUIRED"); return { expected: code, actual };
}
const fence = { beforeWire: async () => {}, afterWire: async () => {} };
try {
  await test("ordinary-session-source-reuse-successful-ordered-controls", async () => {
    const s = session(), source = await s.recordSource(target()), d = await s.document("record", target(), undefined, source);
    assert.equal(journal.filter(row => row.path === "/records/valid").length, 1, "NO_DUPLICATE_SOURCE_READ");
    assert.equal(reads.length, 2);
    assert.equal(d.forms[0]?.label, "Change value");
    assert.deepEqual(d.forms[0]?.controls.map(c => c.name), ["csrf", "value", "note"]);
    assert.equal(d.forms[0]?.controls[1]?.label, "Choice");
    assert.deepEqual(d.descriptions[0]?.entries, [{ name: "status", value: "READY" }, { name: "absent", value: "" }]);
    const w = s.seal(wire(), { document: d, formIndex: 0, controls: controls() });
    const result = await s.execute(w, fence);
    assert.equal(result.status, 200); assert.equal(result.possibleEgress, true);
    assert.equal(journal.filter(row => row.outcome === "ACCEPTED").length, 1);
    await refusal(() => s.execute(w, fence), "X2_ONE_USE_WIRE_REQUIRED");
    return { physicalReads: 1, accepted: 1, replayRefused: true, mounted: false };
  });
  await test("logical-label-collision-includes-unsupported-form", async () => {
    const before = journal.length;
    const source = new ApplicationSourceSession({
      ...profile, allowedTargets: ["collision"],
      credentials: { headers: { cookie: authCookie!, "x-portal-grant": collisionBinding.grantId } },
    }, async () => {}, { documentTransport: "PASSIVE_HTML", readFence: {
      beforeRead: async input => { reads.push({ stage: "START", kind: input.kind }); },
      afterRead: async input => { reads.push({ stage: "FINISH", kind: input.kind }); },
    } });
    try {
      let actualCode: string | null = null, publishedOperations: string[] = [];
      try { publishedOperations = (await source.discover()).operations.map(operation => operation.id); }
      catch (error) { actualCode = error instanceof ApplicationProviderFault ? error.code : "UNCLASSIFIED"; }
      await writeFile(resolve(destination, "collision-discovery.json"), JSON.stringify({
        expectedPublishedOperations: 0, publishedOperations, actualCode,
        gaps: source.unsupported.map(gap => gap.code), inputDigest: applicationByteDigest(collisionDocument),
      }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      assert.equal(actualCode, "X2_UNSUPPORTED_EMPTY_APPLICATION_DOMAIN", "INTENDED_DISCOVERY_AMBIGUITY_REQUIRED");
      assert.equal(publishedOperations.length, 0);
      assert(source.unsupported.some(gap => gap.code === "X2_UI_LOGICAL_LABEL_COLLISION"),
        "EXPOSED_FORM_AMBIGUITY_MUST_NOT_DISAPPEAR_AFTER_FILTERING");
      assert(journal.slice(before).every(entry => entry.method === "GET"), "DISCOVERY_MUST_NOT_MUTATE");
      return { actualCode, publishedOperations: 0, noMutation: true };
    } finally { await source.close(); }
  });
  for (const input of malformed) await test(`document-${input.id}`, async () => {
    const s = session(input.id), before = journal.length;
    const result = await refusal(() => s.document("record", target(input.id)), input.code);
    assert.equal(journal.length - before, 1); assert.equal(journal.at(-1)?.method, "GET");
    return { ...result, noMutation: true };
  });
  for (const mode of ["copied", "released", "changed"] as const) await test(`document-handle-${mode}`, async () => {
    const s = session(), d = await s.document("record", target());
    let next = d;
    if (mode === "copied") next = structuredClone(d);
    if (mode === "released") await s.releaseDocument(d);
    if (mode === "changed") d.forms[0]!.action = origin + "/other";
    return refusal(() => s.seal(wire(), { document: next, formIndex: 0, controls: controls() }), "X2_PRIVATE_FORM_HANDLE_UNAVAILABLE");
  });
  await test("foreign-retained-source", async () => {
    const s = session(), other = session(), source = await s.recordSource(target());
    return refusal(() => other.document("record", target(), undefined, source), "X2_RETAINED_SOURCE_PROVENANCE_REQUIRED");
  });
  for (const mode of ["url", "method", "body", "controls"] as const) await test(`sealed-form-${mode}-substitution`, async () => {
    const s = session(), d = await s.document("record", target());
    const changes = mode === "url" ? { url: origin + "/other" } : mode === "method" ? { method: "GET", body: null, bodyDigest: applicationByteDigest("") }
      : mode === "body" ? { body: expectedBody + "&extra=true", bodyDigest: applicationByteDigest(expectedBody + "&extra=true") } : {};
    return refusal(() => s.seal(wire(changes), { document: d, formIndex: 0,
      controls: mode === "controls" ? { ...controls(), extra: "true" } : controls() }),
    mode === "controls" ? "X2_PASSIVE_FORM_CONTROL_SUBSTITUTION" : "X2_PASSIVE_FORM_WIRE_MISMATCH");
  });
  await test("failed-final-fence-no-physical-mutation", async () => {
    const s = session(), d = await s.document("record", target()), before = journal.length;
    const w = s.seal(wire(), { document: d, formIndex: 0, controls: controls() });
    let observed: boolean | null = null;
    const result = await refusal(() => s.execute(w, { beforeWire: async () => { throw new ApplicationProviderFault("FIXTURE_CURRENT_AUTHORITY_REFUSED"); },
      afterWire: async outcome => { observed = outcome.possibleEgress; } }), "FIXTURE_CURRENT_AUTHORITY_REFUSED");
    assert.equal(journal.length, before); assert.equal(observed, false);
    return { ...result, physicalWrites: 0, possibleEgress: false };
  });
  await test("accepted-response-loss-original-and-no-replay", async () => {
    const s = session(), d = await s.document("record", target());
    const w = s.seal(wire(), { document: d, formIndex: 0, controls: controls() });
    loseResponse = true; acceptNext = true;
    const before = journal.filter(row => row.outcome === "ACCEPTED").length;
    const result = await s.execute(w, fence);
    assert.equal(result.status, null); assert.equal(result.possibleEgress, true);
    assert.equal(journal.filter(row => row.outcome === "ACCEPTED").length - before, 1);
    await refusal(() => s.execute(w, fence), "X2_ONE_USE_WIRE_REQUIRED");
    return { accepted: 1, originalEffectDigest: applicationByteDigest(w.identity.effectId), possibleEgress: true, replayRefused: true };
  });
} finally {
  for (const s of sessions) await s.close();
  await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
}
const root = resolve(import.meta.dirname, "../../.."), pins: Record<string, string> = {};
for (const path of ["finnor-os/packages/computer/src/application-provider.ts",
  "finnor-os/packages/computer/src/application-passive-document.ts",
  "finnor-os/packages/private-equity/src/application-semantics/source.ts",
  "finnor-os/scripts/x2/verify-passive-provider.mts", "finnor-os/package-lock.json"]) {
  pins[path] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}
const failed = results.filter(row => !row.pass).length;
await writeFile(resolve(destination, "result.json"), JSON.stringify({
  schema: "finnor.x2.passive-provider-integration.v1",
  qualification: "ISOLATED_BOUNDED_TRANSPORT_NOT_NATIVE_WORK_S6_MOUNTED_OR_APPLICATION_ALGEBRA",
  node: process.version, pins, inputs: malformed.map(({ id, html, code }) => ({
    id, html: html.replaceAll(csrf, "<SYNTHETIC_CSRF>"), inputDigest: applicationByteDigest(html), code,
  })),
  validInputDigest: applicationByteDigest(valid), expectedWireDigest: applicationByteDigest(expectedBody),
  logicalLabelCollisionInputDigest: applicationByteDigest(collisionDocument),
  journal, reads, sources, results, passed: results.length - failed, failed,
  rerun: "cd <absolute-checkout>/finnor-os && node --import=tsx scripts/x2/verify-passive-provider.mts <fresh-absolute-output>",
}, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ status: failed ? "FAIL" : "PASS_TRANSPORT_ONLY", passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
