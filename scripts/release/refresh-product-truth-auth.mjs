import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const { Client: PgClient } = requireFromOs("pg")
const { GetSecretValueCommand, SecretsManagerClient } = requireFromOs("@aws-sdk/client-secrets-manager")

function arg(name) {
  const prefix = `--${name}=`
  const inline = process.argv.find((value) => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function decodeJwt(value, label) {
  const payload = value?.split(".")?.[1]
  if (!payload) throw new Error(`${label} is not a JWT`)
  let claims
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) } catch { throw new Error(`${label} JWT payload is invalid`) }
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || !claims.email) {
    throw new Error(`${label} JWT is missing sub/email identity claims`)
  }
  return claims
}

async function resolveManagedSecret(name) {
  if (process.env.SECRETS_PROVIDER !== "aws-secrets-manager") return process.env[name]
  let mapping
  try { mapping = JSON.parse(process.env.FINNOR_SECRET_IDS || "{}") } catch { throw new Error("FINNOR_SECRET_IDS is not valid JSON") }
  const secretId = mapping?.[name]
  if (!secretId) return process.env[name]
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("managed-secret environment is missing AWS credentials")
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || process.env.AWS_BEDROCK_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  })
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
  const raw = response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : "")
  if (!raw) throw new Error(`managed secret for ${name} had no value`)
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.[name] === "string") return parsed[name]
  } catch {
    // Single-value Secrets Manager payloads are valid.
  }
  return raw
}

async function verifyInternalProbeTenants(primaryEmail, secondaryEmail) {
  const databaseUrl = process.env.MIGRATIONS_DATABASE_URL
  if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is required to verify certification principals")
  const client = new PgClient({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 })
  await client.connect()
  try {
    const result = await client.query(
      `SELECT lower(u.email) AS email, u.tenant_id, t.name,
              EXISTS (
                SELECT 1 FROM finnor_os.households h
                WHERE h.tenant_id = u.tenant_id
                  AND h.address = 'A5 internal isolation marker — not a customer address'
              ) AS has_marker
       FROM finnor_os.users u
       JOIN finnor_os.tenants t ON t.id = u.tenant_id
       WHERE lower(u.email) = ANY($1::text[])`,
      [[primaryEmail.toLowerCase(), secondaryEmail.toLowerCase()]],
    )
    const byEmail = new Map(result.rows.map((row) => [row.email, row]))
    const primary = byEmail.get(primaryEmail.toLowerCase())
    const secondary = byEmail.get(secondaryEmail.toLowerCase())
    if (!primary || !secondary) throw new Error("certification principals are not both mapped to production tenants")
    if (primary.tenant_id === secondary.tenant_id) throw new Error("certification principals unexpectedly share one tenant")
    if (primary.name !== "A5 Internal Security Tenant A" || secondary.name !== "A5 Internal Security Tenant B") {
      throw new Error("refusing auth refresh: bearer identities are not the A5 internal security tenants")
    }
    if (primary.has_marker !== true) throw new Error("refusing auth refresh: A5 tenant A marker is missing")
  } finally {
    await client.end()
  }
}

async function authRequest(baseUrl, serviceKey, path, init = {}) {
  return fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
}

async function refreshPrincipal(baseUrl, serviceKey, staleToken, label) {
  const stale = decodeJwt(staleToken, label)
  const lookup = await authRequest(baseUrl, serviceKey, `/auth/v1/admin/users/${encodeURIComponent(stale.sub)}`)
  const user = await lookup.json().catch(() => null)
  if (!lookup.ok) throw new Error(`${label} Supabase admin lookup failed: HTTP ${lookup.status}`)
  if (String(user?.email || "").toLowerCase() !== stale.email.toLowerCase()) throw new Error(`${label} Supabase user identity does not match the bearer claims`)

  const password = randomBytes(36).toString("base64url")
  const update = await authRequest(baseUrl, serviceKey, `/auth/v1/admin/users/${encodeURIComponent(stale.sub)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, email_confirm: true }),
  })
  if (!update.ok) throw new Error(`${label} Supabase password rotation failed: HTTP ${update.status}`)

  const signIn = await authRequest(baseUrl, serviceKey, "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: stale.email, password }),
  })
  const body = await signIn.json().catch(() => null)
  if (!signIn.ok || typeof body?.access_token !== "string") throw new Error(`${label} Supabase sign-in failed: HTTP ${signIn.status}`)
  const fresh = decodeJwt(body.access_token, `${label} refreshed bearer`)
  if (fresh.sub !== stale.sub || fresh.email.toLowerCase() !== stale.email.toLowerCase()) throw new Error(`${label} refreshed bearer changed identity`)
  if (!Number.isFinite(Number(fresh.exp)) || Number(fresh.exp) - Math.floor(Date.now() / 1000) < 30 * 60) {
    throw new Error(`${label} refreshed bearer lifetime is too short for deployed certification`)
  }
  return { token: body.access_token, expiresAt: Number(fresh.exp) }
}

const productionEnv = resolve(arg("production-env") || "finnor-os/apps/api/.vercel/.env.production.local")
const outputFile = arg("output-file")
if (!outputFile) throw new Error("Usage: node scripts/release/refresh-product-truth-auth.mjs --production-env <path> --output-file <path>")
if (!existsSync(productionEnv)) throw new Error(`production environment file not found: ${productionEnv}`)
if (existsSync(outputFile)) throw new Error("refusing to overwrite Product Truth auth output")
process.loadEnvFile(productionEnv)

const primaryBearer = process.env.PRODUCT_TRUTH_AUTH_BEARER?.trim()
const secondaryBearer = process.env.PRODUCT_TRUTH_OTHER_AUTH_BEARER?.trim()
if (!primaryBearer || !secondaryBearer) throw new Error("both Product Truth certification bearers are required as identity anchors")
const primaryClaims = decodeJwt(primaryBearer, "PRODUCT_TRUTH_AUTH_BEARER")
const secondaryClaims = decodeJwt(secondaryBearer, "PRODUCT_TRUTH_OTHER_AUTH_BEARER")
if (primaryClaims.sub === secondaryClaims.sub || primaryClaims.email.toLowerCase() === secondaryClaims.email.toLowerCase()) {
  throw new Error("Product Truth certification requires two distinct principals")
}

await verifyInternalProbeTenants(primaryClaims.email, secondaryClaims.email)
const supabaseUrl = process.env.SUPABASE_URL
const serviceKey = await resolveManagedSecret("SUPABASE_SERVICE_ROLE_KEY")
if (!supabaseUrl || !serviceKey) throw new Error("production Supabase admin configuration is unavailable")

const [primary, secondary] = await Promise.all([
  refreshPrincipal(supabaseUrl, serviceKey, primaryBearer, "tenant A"),
  refreshPrincipal(supabaseUrl, serviceKey, secondaryBearer, "tenant B"),
])

writeFileSync(outputFile, `${JSON.stringify({ primary: primary.token, secondary: secondary.token })}\n`, { mode: 0o600 })
chmodSync(outputFile, 0o600)
console.log(JSON.stringify({ ok: true, refreshed: 2, expiresAt: Math.min(primary.expiresAt, secondary.expiresAt) }, null, 2))
