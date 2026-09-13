import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  P8_WATER_TENANT_DISPOSITIONS,
  assertExactWaterTenantCensus,
  assertReleaseIdentity,
  assertSupplierCanaryRelease,
  assertZeroWaterRetirementBlockers,
  blockerMap,
} from "./p8-water-retirement-policy.mjs"
import {
  drainAuditedWaterFixtures,
  readWaterOperationalCensus,
  writeTenantDispositions,
} from "./p8-water-retirement-store.mjs"
import { assertCanonicalRelease, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"
import { vercelProtectionHeaders } from "./vercel-protection.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const databaseEnvIndex = process.argv.indexOf("--database-env")
const authorizationRefIndex = process.argv.indexOf("--authorization-ref")
const databaseEnvPath = databaseEnvIndex >= 0 ? process.argv[databaseEnvIndex + 1] : undefined
const authorizationRef = authorizationRefIndex >= 0 ? process.argv[authorizationRefIndex + 1]?.trim() : undefined
const apply = process.argv.includes("--apply")

if (!databaseEnvPath || (apply && !authorizationRef)) {
  console.error("Usage: node scripts/release/run-p8-production-water-retirement.mjs --database-env <path> [--apply --authorization-ref <auditable-ref>]")
  process.exit(2)
}
if (apply && process.env.GITHUB_ACTIONS !== "true") throw new Error("Production Water retirement mutation is restricted to the protected GitHub Actions release")
if (apply && process.env.FINNOR_ENVIRONMENT !== "production") throw new Error("Production Water retirement requires FINNOR_ENVIRONMENT=production")

const contract = loadContract()
const gitRelease = readGitRelease(repoRoot, contract)
assertCanonicalRelease(gitRelease)
const expected = expectedRelease(gitRelease.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")
const migrationHead = contract.release.requiredMigrationHead
const minimumProtocol = 5
async function fetchJson(url, component, { allowUnavailable = false } = {}) {
  const response = await fetch(url, {
    headers: vercelProtectionHeaders(component),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => null)
  if ((!response.ok && !(allowUnavailable && response.status === 503)) || !body || typeof body !== "object") {
    throw new Error(`${url} returned HTTP ${response.status} without valid release evidence`)
  }
  return { status: response.status, body }
}

async function inspectReleaseSurfaces() {
  const appTarget = contract.topology.supplierCanaryApp
  const authTarget = contract.topology.supplierCanaryAuth
  const apiTarget = contract.topology.api
  const [app, auth, apiReady] = await Promise.all([
    fetchJson(`${appTarget.productionUrl}${appTarget.releasePath}`, "supplierCanaryApp"),
    fetchJson(`${authTarget.productionUrl}${authTarget.releasePath}`, "supplierCanaryAuth"),
    fetchJson(`${apiTarget.productionUrl}${apiTarget.readinessPath}`, "api", { allowUnavailable: true }),
  ])
  assertSupplierCanaryRelease("supplierCanaryApp", app.body, expected, appTarget, migrationHead, minimumProtocol)
  assertSupplierCanaryRelease("supplierCanaryAuth", auth.body, expected, authTarget, migrationHead, minimumProtocol)
  assertReleaseIdentity("api readiness", apiReady.body.provenance, expected)
  if (apiReady.body.checks?.runtimeHeartbeat?.ok !== true) throw new Error("API did not record a cutover-compatible runtime heartbeat")
  return { app: app.body, auth: auth.body, apiReady: apiReady.body }
}

process.loadEnvFile(resolve(databaseEnvPath))
const databaseUrl = process.env.MIGRATIONS_DATABASE_URL
if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is missing from the protected production environment")
const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 })

const requiredRuntimeRoles = ["api", "worker", "orchestrator", "supplier-canary", "scheduler-owner"]
const persistentRuntimeRoles = ["api", "worker", "orchestrator", "scheduler-owner"]

async function readAuthority({ forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT epoch,state,active_product_vertical,minimum_cutover_protocol,
            water_intake_frozen_at,water_retired_at,activation_evidence
       FROM finnor_os.product_runtime_authority
      WHERE authority_key='product'${forUpdate ? " FOR UPDATE" : ""}`,
  )
  if (result.rowCount !== 1) throw new Error("The single product runtime authority row is unavailable")
  return result.rows[0]
}

async function readWaterTenantCensus() {
  const result = await client.query(
    `SELECT t.id AS tenant_id,t.name,v.vertical_key,v.source_system,v.source_ref,v.created_by,
            s.is_dealer_zero,s.simulator_enabled,s.training_mode,
            d.classification,d.authorized,d.authorization_ref,d.obligations,d.classified_by,d.classified_at
       FROM finnor_os.tenants t
       JOIN finnor_os.tenant_vertical_assignments v ON v.tenant_id=t.id AND v.vertical_key='water'
       LEFT JOIN finnor_os.tenant_settings s ON s.tenant_id=t.id
       LEFT JOIN finnor_os.water_tenant_retirement_dispositions d ON d.tenant_id=t.id
      ORDER BY t.id`,
  )
  return result.rows
}

async function readBlockers() {
  return (await client.query("SELECT * FROM finnor_os.water_retirement_blockers() ORDER BY category")).rows
}

async function readFreshRuntimeRows() {
  return (await client.query(
    `SELECT service,instance_id,release_sha,build_id,version,release_source,migration_head,
            deployment_id,capabilities,environment,cutover_protocol,product_epoch,
            extract(epoch FROM (now()-last_beat_at))::int AS age_seconds
       FROM finnor_os.service_release_heartbeats
      WHERE service=ANY($1::text[]) AND last_beat_at>now()-interval '90 seconds'
      ORDER BY service,instance_id`,
    [requiredRuntimeRoles],
  )).rows
}

function assertCompatibleRuntimeRows(rows, roles, epoch) {
  for (const role of roles) {
    const roleRows = rows.filter((row) => row.service === role)
    if (roleRows.length === 0) throw new Error(`Cutover-compatible ${role} heartbeat is missing`)
    for (const row of roleRows) {
      if (
        row.release_sha !== expected.commitSha
        || row.build_id !== expected.buildId
        || row.version !== expected.version
        || row.release_source !== expected.source
        || row.migration_head !== migrationHead
        || row.environment !== expected.environment
        || Number(row.cutover_protocol) < minimumProtocol
        || Number(row.product_epoch) !== Number(epoch)
      ) {
        throw new Error(`Fresh ${role} instance ${row.instance_id} is incompatible with the exact cutover release`)
      }
    }
  }
}

async function upsertSupplierCanaryHeartbeat(releaseSurfaces, epoch) {
  await client.query(
    `INSERT INTO finnor_os.service_release_heartbeats
       (service,instance_id,release_sha,build_id,version,release_source,core_certification_id,
        migration_head,deployment_id,capabilities,environment,cutover_protocol,product_epoch,last_beat_at)
     VALUES ('supplier-canary','supplier-canary:production',$1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (service,instance_id) DO UPDATE SET
       release_sha=EXCLUDED.release_sha,build_id=EXCLUDED.build_id,version=EXCLUDED.version,
       release_source=EXCLUDED.release_source,core_certification_id=NULL,
       migration_head=EXCLUDED.migration_head,deployment_id=EXCLUDED.deployment_id,
       capabilities=EXCLUDED.capabilities,environment=EXCLUDED.environment,
       cutover_protocol=EXCLUDED.cutover_protocol,product_epoch=EXCLUDED.product_epoch,last_beat_at=now()`,
    [
      expected.commitSha,
      expected.buildId,
      expected.version,
      expected.source,
      migrationHead,
      `vercel:${releaseSurfaces.app.deploymentId}:${releaseSurfaces.auth.deploymentId}`,
      ["authenticated-browser", "external-diligence", "private-equity"],
      expected.environment,
      minimumProtocol,
      Number(epoch),
    ],
  )
}

function compactAuthority(authority) {
  return {
    epoch: Number(authority.epoch),
    state: authority.state,
    activeProductVertical: authority.active_product_vertical,
    minimumCutoverProtocol: Number(authority.minimum_cutover_protocol),
    waterIntakeFrozenAt: authority.water_intake_frozen_at,
    waterRetiredAt: authority.water_retired_at,
  }
}

async function awaitFinalConvergence(initialSurfaces, activatedEpoch) {
  const convergenceDeadline = Date.now() + 120_000
  let releaseSurfaces = initialSurfaces
  let finalAuthority = await readAuthority()
  let finalRows = []
  let finalReady = null
  let lastError = null
  while (Date.now() < convergenceDeadline) {
    await upsertSupplierCanaryHeartbeat(releaseSurfaces, activatedEpoch)
    finalAuthority = await readAuthority()
    finalRows = await readFreshRuntimeRows()
    try {
      assertCompatibleRuntimeRows(finalRows, requiredRuntimeRoles, activatedEpoch)
      const readiness = await fetchJson(`${contract.topology.api.productionUrl}${contract.topology.api.readinessPath}`, "api", { allowUnavailable: true })
      if (readiness.body.ok === true) {
        finalReady = readiness.body
        lastError = null
        break
      }
    } catch (error) {
      lastError = error
      // The worker owns three durable role beats on a 30-second cadence. Keep
      // polling until they observe the incremented authority epoch.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
    releaseSurfaces = await inspectReleaseSurfaces()
  }
  try {
    assertCompatibleRuntimeRows(finalRows, requiredRuntimeRoles, activatedEpoch)
  } catch (error) {
    lastError = error
  }
  if (finalReady?.ok !== true || lastError) {
    throw new Error(`Final production readiness did not converge after Water retirement${lastError ? `: ${lastError.message}` : ""}`)
  }
  if (
    finalAuthority.state !== "water_retired"
    || finalAuthority.active_product_vertical !== "private_equity"
    || Number(finalAuthority.epoch) !== Number(activatedEpoch)
  ) {
    throw new Error("Final production authority evidence does not match the activated epoch")
  }
  return { finalAuthority, finalRows, finalReady }
}

async function awaitPreCutoverFleet(initialSurfaces, epoch) {
  const deadline = Date.now() + 180_000
  let releaseSurfaces = initialSurfaces
  let rows = []
  let lastError = null
  while (Date.now() < deadline) {
    try {
      releaseSurfaces = await inspectReleaseSurfaces()
      await upsertSupplierCanaryHeartbeat(releaseSurfaces, epoch)
      rows = await readFreshRuntimeRows()
      assertCompatibleRuntimeRows(rows, requiredRuntimeRoles, epoch)
      return { releaseSurfaces, rows }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  }
  throw new Error(`The exact production fleet did not converge before the Water freeze: ${lastError?.message ?? "unknown incompatibility"}`)
}

const releaseSurfaces = await inspectReleaseSurfaces()
await client.connect()
try {
  const head = (await client.query("SELECT max(name) AS name FROM finnor_os._migrations")).rows[0]?.name
  if (head !== migrationHead) throw new Error(`Production migration head ${head ?? "<missing>"} is not ${migrationHead}`)
  const authorityBefore = await readAuthority()
  if (!['preparing', 'water_intake_frozen', 'water_retired'].includes(authorityBefore.state)) {
    throw new Error(`Unsupported product authority state ${authorityBefore.state}`)
  }
  if (authorityBefore.active_product_vertical !== "private_equity" || Number(authorityBefore.minimum_cutover_protocol) < minimumProtocol) {
    throw new Error("Product authority vertical or cutover protocol is incompatible")
  }
  const census = await readWaterTenantCensus()
  assertExactWaterTenantCensus(census)
  const operationalCensusBefore = await readWaterOperationalCensus(client)
  const blockersBefore = await readBlockers()
  const freshBefore = await readFreshRuntimeRows()
  if (authorityBefore.state !== "water_retired") {
    assertCompatibleRuntimeRows(freshBefore, persistentRuntimeRoles, authorityBefore.epoch)
  }

  let output
  if (!apply) {
    output = {
      ok: true,
      mode: "read-only",
      release: expected,
      migrationHead: head,
      authority: compactAuthority(authorityBefore),
      tenantCensus: census.map((row) => ({
        tenantId: row.tenant_id,
        name: row.name,
        sourceSystem: row.source_system,
        disposition: row.classification
          ? {
              classification: row.classification,
              authorized: row.authorized,
              authorizationRef: row.authorization_ref,
              obligations: row.obligations,
              classifiedBy: row.classified_by,
              classifiedAt: row.classified_at,
            }
          : null,
      })),
      blockers: blockerMap(blockersBefore),
      operationalCensus: operationalCensusBefore,
      freshRuntimeRoles: [...new Set(freshBefore.map((row) => row.service))].sort(),
      canaries: {
        app: { role: releaseSurfaces.app.role, deploymentId: releaseSurfaces.app.deploymentId },
        auth: { role: releaseSurfaces.auth.role, deploymentId: releaseSurfaces.auth.deploymentId },
      },
    }
  } else {
    const actor = `p8-production-release:${expected.commitSha}`
    if (authorityBefore.state === "water_retired") {
      const blockersAfter = assertZeroWaterRetirementBlockers(await readBlockers())
      const { finalAuthority, finalRows, finalReady } = await awaitFinalConvergence(releaseSurfaces, Number(authorityBefore.epoch))
      output = {
        ok: true,
        mode: "already-applied",
        release: expected,
        migrationHead,
        authorizationRef,
        authorityBefore: compactAuthority(authorityBefore),
        authorityAfter: compactAuthority(finalAuthority),
        blockersBefore: blockerMap(blockersBefore),
        blockersAfter,
        operationalCensus: operationalCensusBefore,
        drain: { actions: 0, effects: 0, objectives: 0, jobs: 0, works: 0 },
        runtimeRoles: [...new Set(finalRows.map((row) => row.service))].sort(),
        readiness: { ok: finalReady.ok, productAuthority: finalReady.checks?.productAuthority, runtimeEpoch: finalReady.checks?.runtimeEpoch },
      }
    } else {
      let currentSurfaces = releaseSurfaces
      const fleet = await awaitPreCutoverFleet(currentSurfaces, Number(authorityBefore.epoch))
      currentSurfaces = fleet.releaseSurfaces

      let frozenEpoch
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        const lockedAuthority = await readAuthority({ forUpdate: true })
        if (!['preparing', 'water_intake_frozen'].includes(lockedAuthority.state)) {
          throw new Error(`Water freeze cannot continue from authority state ${lockedAuthority.state}`)
        }
        const lockedCensus = await readWaterTenantCensus()
        assertExactWaterTenantCensus(lockedCensus)
        await writeTenantDispositions(client, { actor, authorizationRef })
        await upsertSupplierCanaryHeartbeat(currentSurfaces, lockedAuthority.epoch)
        assertCompatibleRuntimeRows(await readFreshRuntimeRows(), requiredRuntimeRoles, lockedAuthority.epoch)
        frozenEpoch = Number(lockedAuthority.epoch)
        if (lockedAuthority.state === "preparing") {
          const freezeEvidence = {
            p0P4Verified: true,
            phase8SourceGatesVerified: true,
            tenantCensus: P8_WATER_TENANT_DISPOSITIONS.map(({ tenantId, classification }) => ({ tenantId, classification })),
            operationalCensusBefore,
            authorizationRef,
            releaseSha: expected.commitSha,
            migrationHead,
            supplierCanaryDeployments: [currentSurfaces.app.deploymentId, currentSurfaces.auth.deploymentId],
          }
          const freeze = await client.query(
            "SELECT finnor_os.freeze_water_intake($1,$2,$3::jsonb) AS epoch",
            [frozenEpoch, actor, JSON.stringify(freezeEvidence)],
          )
          frozenEpoch = Number(freeze.rows[0]?.epoch)
        }
        const frozenAuthority = await readAuthority()
        if (frozenAuthority.state !== "water_intake_frozen" || Number(frozenAuthority.epoch) !== frozenEpoch) {
          throw new Error("Water intake did not reach the frozen authority state")
        }
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      }

      const frozenFleet = await awaitPreCutoverFleet(currentSurfaces, frozenEpoch)
      currentSurfaces = frozenFleet.releaseSurfaces
      let drain
      let activatedEpoch
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      try {
        const frozenAuthority = await readAuthority({ forUpdate: true })
        if (frozenAuthority.state !== "water_intake_frozen" || Number(frozenAuthority.epoch) !== frozenEpoch) {
          throw new Error("Water drain requires the committed frozen authority state")
        }
        assertExactWaterTenantCensus(await readWaterTenantCensus())
        await writeTenantDispositions(client, { actor, authorizationRef })
        await upsertSupplierCanaryHeartbeat(currentSurfaces, frozenEpoch)
        assertCompatibleRuntimeRows(await readFreshRuntimeRows(), requiredRuntimeRoles, frozenEpoch)
        drain = await drainAuditedWaterFixtures(client, {
          actor,
          authorizationRef,
          releaseSha: expected.commitSha,
        })
        const zeroCensus = assertZeroWaterRetirementBlockers(await readBlockers())
        const activationEvidence = {
          safetyCensusZero: true,
          phase8SourceGatesVerified: true,
          authorizationRef,
          releaseSha: expected.commitSha,
          migrationHead,
          zeroCensus,
          drain,
          tenantCensus: P8_WATER_TENANT_DISPOSITIONS.map(({ tenantId, classification }) => ({ tenantId, classification })),
          operationalCensusBefore,
        }
        const activation = await client.query(
          "SELECT finnor_os.activate_private_equity_product_authority($1,$2,$3::jsonb) AS epoch",
          [frozenEpoch, actor, JSON.stringify(activationEvidence)],
        )
        activatedEpoch = Number(activation.rows[0]?.epoch)
        const authorityAfter = await readAuthority()
        if (
          authorityAfter.state !== "water_retired"
          || authorityAfter.active_product_vertical !== "private_equity"
          || Number(authorityAfter.epoch) !== activatedEpoch
        ) {
          throw new Error("Product authority did not reach water_retired + private_equity")
        }
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      }

      const { finalAuthority, finalRows, finalReady } = await awaitFinalConvergence(currentSurfaces, activatedEpoch)
      const finalBlockers = assertZeroWaterRetirementBlockers(await readBlockers())
      const operationalCensusAfter = await readWaterOperationalCensus(client)
      output = {
        ok: true,
        mode: "applied",
        release: expected,
        migrationHead,
        authorizationRef,
        authorityBefore: compactAuthority(authorityBefore),
        authorityAfter: compactAuthority(finalAuthority),
        blockersBefore: blockerMap(blockersBefore),
        blockersAfter: finalBlockers,
        operationalCensusBefore,
        operationalCensusAfter,
        drain,
        runtimeRoles: [...new Set(finalRows.map((row) => row.service))].sort(),
        readiness: { ok: finalReady.ok, productAuthority: finalReady.checks?.productAuthority, runtimeEpoch: finalReady.checks?.runtimeEpoch },
      }
    }
  }
  console.log(JSON.stringify(output, null, 2))
} finally {
  await client.end()
}
