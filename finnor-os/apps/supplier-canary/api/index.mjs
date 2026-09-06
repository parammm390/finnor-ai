import { createHmac, timingSafeEqual } from "node:crypto";

const DILIGENCE_RECORD = Object.freeze({
  reference: "DD-48",
  status: "Third-party diligence packet received",
  asOf: "August 28, 2026 at 5:00 PM CDT",
  externalReference: "VDR-9848",
  finding: "Insurance evidence is current; the environmental reliance letter remains under counsel review.",
  risk: "Reliance-letter completion is an open closing dependency. No other critical exception is recorded."
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f6f8fb;color:#172033;margin:0}main{max-width:760px;margin:64px auto;padding:32px;background:white;border:1px solid #dbe2ea;border-radius:16px}h1{margin-top:0}a,button{display:inline-block;background:#164e63;color:white;padding:10px 16px;border:0;border-radius:8px;text-decoration:none;font-weight:650}label{display:block;margin:16px 0 6px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #94a3b8;border-radius:7px}dl{display:grid;grid-template-columns:180px 1fr;gap:12px}dt{font-weight:700}dd{margin:0}.muted{color:#64748b}.risk{padding:14px;background:#fff7ed;border-left:4px solid #ea580c}</style></head><body><main>${body}</main></body></html>`;
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2));
}

function sign(payload, key) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verify(token, key) {
  const [encoded, supplied] = String(token ?? "").split(".");
  if (!encoded || !supplied) return null;
  const expected = createHmac("sha256", key).update(encoded).digest("base64url");
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload?.sub === "finnor-canary" && Number(payload.exp) > Date.now() ? payload : null;
  } catch { return null; }
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual ?? "")); const right = Buffer.from(String(expected ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function formBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return Object.fromEntries(new URLSearchParams(typeof req.body === "string" ? req.body : ""));
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default function handler(req, res) {
  const role = process.env.PORTAL_ROLE;
  const signingKey = process.env.CANARY_SIGNING_KEY;
  const appOrigin = process.env.APP_ORIGIN;
  const authOrigin = process.env.AUTH_ORIGIN;
  if (!role || !signingKey || !appOrigin || !authOrigin) return send(res, 503, page("Unavailable", "<h1>Canary configuration unavailable</h1>"));
  const url = new URL(req.url, role === "auth" ? authOrigin : appOrigin);

  if (url.pathname === "/health") {
    const commitSha = String(process.env.FINNOR_COMMIT_SHA ?? "unknown");
    return sendJson(res, /^[0-9a-f]{40}$/i.test(commitSha) ? 200 : 503, {
      ok: /^[0-9a-f]{40}$/i.test(commitSha),
      service: "supplier-canary",
      commitSha,
      buildId: process.env.FINNOR_BUILD_ID ?? "unknown",
      version: process.env.FINNOR_VERSION ?? "unknown",
      source: process.env.FINNOR_RELEASE_SOURCE ?? "unknown",
      environment: process.env.FINNOR_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown",
      cutoverProtocol: 5,
      migrationHead: "0109_atomic_water_runtime_retirement.sql",
    });
  }

  if (role === "auth") {
    if (url.pathname !== "/login") return send(res, 404, page("Not found", "<h1>Not found</h1>"));
    if (req.method === "GET") return send(res, 200, page("Supplier Canary Sign In", `<h1>Supplier Canary Sign In</h1><p class="muted">Authorized deterministic test account only.</p><form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form>`));
    if (req.method !== "POST") return send(res, 405, page("Method not allowed", "<h1>Method not allowed</h1>"), { Allow: "GET, POST" });
    const body = formBody(req);
    if (!secureEqual(body.username, process.env.CANARY_USERNAME) || !secureEqual(body.password, process.env.CANARY_PASSWORD)) {
      return send(res, 401, page("Sign in failed", "<h1>Sign in failed</h1><p>The test account could not be authenticated.</p>"));
    }
    const access = sign({ sub: "finnor-canary", exp: Date.now() + 10 * 60_000 }, signingKey);
    res.statusCode = 303;
    res.setHeader("Location", `${appOrigin}/callback?access=${encodeURIComponent(access)}`);
    res.end();
    return;
  }

  if (url.pathname === "/callback") {
    const access = url.searchParams.get("access");
    if (!verify(access, signingKey)) return send(res, 401, page("Unauthorized", "<h1>Unauthorized</h1>"));
    res.statusCode = 303;
    res.setHeader("Set-Cookie", `canary_session=${encodeURIComponent(access)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    res.setHeader("Location", "/records");
    res.end();
    return;
  }

  const authenticated = verify(decodeURIComponent(cookies(req).canary_session ?? ""), signingKey);
  if (!authenticated) return send(res, 200, page("Diligence Canary Portal", `<h1>Diligence Canary Portal</h1><p>Secure deterministic external-record fixture for governed browser verification.</p><a href="${escapeHtml(authOrigin)}/login">Sign in to diligence portal</a>`));
  if (url.pathname === "/" || url.pathname === "/records") {
    return send(res, 200, page("Diligence Records", `<h1>Diligence records</h1><p class="muted">Signed in with the governed test account.</p><table><thead><tr><th>Reference</th><th>Status</th></tr></thead><tbody><tr><td><a href="/records/DD-48">DD-48</a></td><td>${escapeHtml(DILIGENCE_RECORD.status)}</td></tr></tbody></table>`));
  }
  if (url.pathname === "/records/DD-48") {
    return send(res, 200, page("Diligence DD-48", `<h1>Diligence DD-48</h1><section data-testid="diligence-evidence"><dl><dt>Status</dt><dd>${escapeHtml(DILIGENCE_RECORD.status)}</dd><dt>Evidence as of</dt><dd>${escapeHtml(DILIGENCE_RECORD.asOf)}</dd><dt>External reference</dt><dd>${escapeHtml(DILIGENCE_RECORD.externalReference)}</dd><dt>Finding</dt><dd>${escapeHtml(DILIGENCE_RECORD.finding)}</dd></dl><p class="risk"><strong>Closing risk:</strong> ${escapeHtml(DILIGENCE_RECORD.risk)}</p></section><a href="/records">Back to records</a>`));
  }
  return send(res, 404, page("Not found", "<h1>Not found</h1>"));
}
