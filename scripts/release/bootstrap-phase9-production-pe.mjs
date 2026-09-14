import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const databaseEnvIndex = process.argv.indexOf("--database-env")
const databaseEnvPath = databaseEnvIndex >= 0 ? process.argv[databaseEnvIndex + 1] : undefined
const apply = process.argv.includes("--apply")

if (!databaseEnvPath) {
  console.error("Usage: node scripts/release/bootstrap-phase9-production-pe.mjs --database-env <path> [--apply]")
  process.exit(2)
}
if (apply && process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Production PE bootstrap mutation is restricted to GitHub Actions")
}
if (apply && process.env.FINNOR_ENVIRONMENT !== "production") {
  throw new Error("Production PE bootstrap requires FINNOR_ENVIRONMENT=production")
}

process.loadEnvFile(resolve(databaseEnvPath))
const databaseUrl = process.env.MIGRATIONS_DATABASE_URL
if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is missing from the protected production environment")

const HISTORICAL_WATER_TENANT_ID = "00000000-0000-4000-8000-000000000001"
const PE_TENANT_ID = process.env.FINNOR_PHASE9_PE_TENANT_ID || "7d57aa44-df32-4ff7-87e8-e0b8236d9c31"
const PE_CLIENT_KEY = process.env.FINNOR_PHASE9_PE_CLIENT_KEY || "finnor-internal-pe-production"
const PE_TENANT_NAME = process.env.FINNOR_PHASE9_PE_TENANT_NAME || "Finnor Private Equity Internal"
const OWNER_EMAIL = (process.env.FINNOR_PHASE9_OWNER_EMAIL || "owner@test-dealer.finnor.local").trim().toLowerCase()

if (!OWNER_EMAIL.includes("@")) throw new Error("FINNOR_PHASE9_OWNER_EMAIL is invalid")

const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
})

async function readAuthority() {
  const result = await client.query(
    `SELECT epoch,state,active_product_vertical
       FROM finnor_os.product_runtime_authority
      WHERE authority_key='product'`,
  )
  if (result.rowCount !== 1) throw new Error("Product runtime authority is unavailable")
  return result.rows[0]
}

async function readTenant(tenantId) {
  return (await client.query(
    `SELECT t.id,t.client_key,t.name,v.vertical_key
       FROM finnor_os.tenants t
       LEFT JOIN finnor_os.tenant_vertical_assignments v ON v.tenant_id=t.id
      WHERE t.id=$1`,
    [tenantId],
  )).rows[0] ?? null
}

async function readIdentity(email) {
  return (await client.query(
    `SELECT id,tenant_id,email,role,status,display_name,phone_number
       FROM finnor_os.users
      WHERE lower(email)=lower($1)`,
    [email],
  )).rows[0] ?? null
}

function assertSafePreconditions(authority, historicalTenant, targetTenant, identity) {
  if (authority.state !== "water_retired" || authority.active_product_vertical !== "private_equity") {
    throw new Error(`PE bootstrap blocked: product authority is ${authority.state}/${authority.active_product_vertical}`)
  }
  if (!historicalTenant || historicalTenant.vertical_key !== "water") {
    throw new Error("PE bootstrap blocked: historical Water tenant identity is not preserved")
  }
  if (targetTenant) {
    if (targetTenant.client_key !== PE_CLIENT_KEY || targetTenant.name !== PE_TENANT_NAME) {
      throw new Error("PE bootstrap blocked: target tenant ID already belongs to a different tenant")
    }
    if (targetTenant.vertical_key && targetTenant.vertical_key !== "private_equity") {
      throw new Error(`PE bootstrap blocked: target tenant vertical is ${targetTenant.vertical_key}`)
    }
  }
  if (identity && ![HISTORICAL_WATER_TENANT_ID, PE_TENANT_ID].includes(identity.tenant_id)) {
    throw new Error(`PE bootstrap blocked: ${OWNER_EMAIL} already belongs to unrelated tenant ${identity.tenant_id}`)
  }
  if (identity && identity.role !== "owner") {
    throw new Error(`PE bootstrap blocked: ${OWNER_EMAIL} is not an owner identity`)
  }
}

async function verifyFinalState() {
  const tenant = await readTenant(PE_TENANT_ID)
  const identity = await readIdentity(OWNER_EMAIL)
  const resolved = (await client.query(
    `SELECT user_id,tenant_id,user_role,employee_status
       FROM finnor_os.resolve_authenticated_identity($1)`,
    [OWNER_EMAIL],
  )).rows[0] ?? null
  if (!tenant || tenant.vertical_key !== "private_equity") throw new Error("PE bootstrap verification failed: target tenant is not Private Equity")
  if (!identity || identity.tenant_id !== PE_TENANT_ID || identity.status !== "active" || identity.role !== "owner") {
    throw new Error("PE bootstrap verification failed: owner application identity is not active in the PE tenant")
  }
  if (!resolved || resolved.tenant_id !== PE_TENANT_ID || resolved.user_role !== "owner" || resolved.employee_status !== "active") {
    throw new Error("PE bootstrap verification failed: authenticated identity does not resolve to the PE tenant")
  }
  return { tenant, identity: { id: identity.id, tenantId: identity.tenant_id, email: identity.email, role: identity.role, status: identity.status } }
}

await client.connect()
try {
  const authority = await readAuthority()
  const historicalTenant = await readTenant(HISTORICAL_WATER_TENANT_ID)
  const targetTenant = await readTenant(PE_TENANT_ID)
  const identity = await readIdentity(OWNER_EMAIL)
  assertSafePreconditions(authority, historicalTenant, targetTenant, identity)

  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      mode: "read-only",
      ownerEmail: OWNER_EMAIL,
      historicalWaterTenantId: HISTORICAL_WATER_TENANT_ID,
      targetPeTenantId: PE_TENANT_ID,
      authority: { state: authority.state, activeProductVertical: authority.active_product_vertical },
      currentIdentity: identity ? { id: identity.id, tenantId: identity.tenant_id, role: identity.role, status: identity.status } : null,
      targetTenant: targetTenant ? { id: targetTenant.id, clientKey: targetTenant.client_key, name: targetTenant.name, vertical: targetTenant.vertical_key } : null,
    }, null, 2))
  } else {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    try {
      await client.query("SET LOCAL row_security = off")
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`phase9-pe-bootstrap:${OWNER_EMAIL}`])

      const lockedAuthority = await readAuthority()
      const lockedHistoricalTenant = await readTenant(HISTORICAL_WATER_TENANT_ID)
      const lockedTargetTenant = await readTenant(PE_TENANT_ID)
      const lockedIdentity = await readIdentity(OWNER_EMAIL)
      assertSafePreconditions(lockedAuthority, lockedHistoricalTenant, lockedTargetTenant, lockedIdentity)

      await client.query(
        `INSERT INTO finnor_os.tenants(id,client_key,name,timezone)
         VALUES($1,$2,$3,'America/New_York')
         ON CONFLICT (id) DO NOTHING`,
        [PE_TENANT_ID, PE_CLIENT_KEY, PE_TENANT_NAME],
      )
      await client.query(
        `INSERT INTO finnor_os.tenant_vertical_assignments
           (tenant_id,vertical_key,version,effective_from,source_system,created_by)
         VALUES($1,'private_equity',1,now(),'phase9:production-bootstrap','system:phase9-production-bootstrap')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [PE_TENANT_ID],
      )
      await client.query(
        `INSERT INTO finnor_os.tenant_settings(tenant_id)
         VALUES($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [PE_TENANT_ID],
      )

      if (lockedIdentity?.tenant_id === HISTORICAL_WATER_TENANT_ID) {
        const archiveEmail = `archived+${lockedIdentity.id}@retired-water.finnor.local`
        await client.query(
          `UPDATE finnor_os.users
              SET email=$2,status='suspended'
            WHERE id=$1 AND tenant_id=$3 AND lower(email)=lower($4)`,
          [lockedIdentity.id, archiveEmail, HISTORICAL_WATER_TENANT_ID, OWNER_EMAIL],
        )
      }

      const existingTargetIdentity = await readIdentity(OWNER_EMAIL)
      if (!existingTargetIdentity) {
        await client.query(
          `INSERT INTO finnor_os.users(tenant_id,email,role,status,display_name,phone_number)
           VALUES($1,$2,'owner','active',$3,$4)`,
          [
            PE_TENANT_ID,
            OWNER_EMAIL,
            lockedIdentity?.display_name || "Private Equity Owner",
            lockedIdentity?.phone_number || null,
          ],
        )
      } else if (existingTargetIdentity.tenant_id === PE_TENANT_ID) {
        await client.query(
          `UPDATE finnor_os.users
              SET role='owner',status='active'
            WHERE id=$1 AND tenant_id=$2`,
          [existingTargetIdentity.id, PE_TENANT_ID],
        )
      } else {
        throw new Error(`PE bootstrap raced with unrelated identity assignment ${existingTargetIdentity.tenant_id}`)
      }

      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }

    const verified = await verifyFinalState()
    console.log(JSON.stringify({
      ok: true,
      mode: "applied",
      ownerEmail: OWNER_EMAIL,
      historicalWaterTenantId: HISTORICAL_WATER_TENANT_ID,
      targetPeTenantId: PE_TENANT_ID,
      verified,
    }, null, 2))
  }
} finally {
  await client.end()
}
