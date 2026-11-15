import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://localhost:3000");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw Error("LOCAL_DISPOSABLE_TARGET_REQUIRED");
const out = resolve(process.argv[3] ?? "test-results/workos-auth-http");
await mkdir(out, { recursive: true, mode: 0o700 });
const results = [];
const authOrigin = process.env.AUTH_EXPECTED_ORIGIN ?? base.origin;

async function check(name, path, expected, options = {}) {
  const response = await fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(30_000), ...options });
  assert.equal(response.status, expected, name);
  results.push({ name, path, method: options.method ?? "GET", expected, observed: response.status });
  return response;
}

try {
  const session = await check("signed-out session", "/api/auth/session", 200);
  assert.deepEqual(await session.json(), { session: null });
  assert.match(session.headers.get("cache-control") ?? "", /no-store/);
  const injected = await check("untrusted session headers", "/api/auth/session", 200, {
    headers: { "x-workos-middleware": "true", "x-workos-session": "forged-session" },
  });
  assert.deepEqual(await injected.json(), { session: null });
  for (const target of ["https://evil.example", "//evil.example", "/admin", "/centropy?tenant=foreign"]) {
    await check("reject return path", `/api/auth/sign-in?returnTo=${encodeURIComponent(target)}`, 400);
  }
  await check("reject callback without state", "/api/auth/callback?code=fake", 400);
  await check("reject callback without verifier", "/api/auth/callback?code=fake&state=fake", 400);
  await check("logout rejects GET", "/api/auth/sign-out", 405);
  await check("logout rejects missing origin", "/api/auth/sign-out", 403, { method: "POST" });
  await check("logout rejects foreign origin", "/api/auth/sign-out", 403, { method: "POST", headers: { origin: "https://evil.example" } });
  const login = await check("real authorization initiation", "/api/auth/sign-in?returnTo=/centropy", 307);
  const location = new URL(login.headers.get("location"));
  assert.equal(location.protocol, "https:");
  assert.equal(location.hostname, "api.workos.com");
  assert.equal(location.pathname, "/user_management/authorize");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("state"));
  const cookie = login.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(login.headers.get("cache-control") ?? "", /no-store/);
  const forged = await check("reject callback state mismatch", "/api/auth/callback?code=fake&state=forged", 400, {
    headers: { cookie: cookie.split(";")[0] },
  });
  assert.match(forged.headers.get("cache-control") ?? "", /no-store/);
  const logout = await check("signed-out same-origin logout", "/api/auth/sign-out", 303, { method: "POST", headers: { origin: authOrigin } });
  assert.equal(logout.headers.get("location"), new URL("/centropy/login", authOrigin).toString());
  await writeFile(resolve(out, "report.json"), JSON.stringify({
    classification: "LOCAL_NEXT_HTTP_AUTH_BOUNDARIES", status: "PASS", base: base.origin, cases: results,
    coverage: ["signed-out", "header injection", "redirect validation", "callback CSRF", "logout CSRF", "PKCE initiation"],
    notRun: ["user-completed WorkOS sign-in", "authenticated tenant access", "mounted user switch", "production deployment"],
    rerun: "node scripts/auth/verify-workos-boundaries.mjs http://localhost:3000 <evidence-directory>",
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: "PASS", cases: results.length, report: resolve(out, "report.json") }));
} catch (error) {
  await writeFile(resolve(out, "failure.json"), JSON.stringify({ status: "FAIL", cases: results, error: String(error.message) }, null, 2) + "\n", { mode: 0o600 });
  throw error;
}
