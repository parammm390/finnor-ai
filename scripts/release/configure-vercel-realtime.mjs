import { loadContract } from "./release-policy.mjs"
import { authorizeProductionMutation } from "./production-mutation-guard.mjs"

const contract = loadContract()
const target = contract.topology.frontend
const token = process.env.VERCEL_TOKEN?.trim()
const apply = process.argv.includes("--apply")
if (!token) throw new Error("VERCEL_TOKEN is required")

async function request(path, init = {}) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Vercel request failed (${response.status}) for ${path}: ${body?.error?.message ?? body?.message ?? "unknown error"}`)
  return body
}

const envResponse = await request(`/v10/projects/${target.projectId}/env?teamId=${target.organizationId}&decrypt=false`)
const REALTIME_ENV = "CENTROPY_SSE_GATEWAY_URL"
const LEGACY_REALTIME_ENV = "JARVIS_SSE_GATEWAY_URL"
const productionEntries = (envResponse.envs ?? []).filter((entry) => [REALTIME_ENV, LEGACY_REALTIME_ENV].includes(entry.key) && (entry.target === "production" || entry.target?.includes?.("production")))
const preferred = productionEntries.find((entry) => entry.key === REALTIME_ENV) ?? productionEntries.find((entry) => entry.key === LEGACY_REALTIME_ENV)
if (!preferred?.id) throw new Error(`Vercel frontend must have production ${REALTIME_ENV} (legacy ${LEGACY_REALTIME_ENV} is accepted during cutover)`)
const entry = preferred
const expected = contract.topology.worker.sseGatewayUrl
if (apply) {
  await authorizeProductionMutation("vercel-environment-update")
  await request(`/v9/projects/${target.projectId}/env/${entry.id}?teamId=${target.organizationId}`, {
    method: "PATCH",
    body: JSON.stringify({ key: REALTIME_ENV, value: expected, target: ["production"], type: entry.type === "sensitive" ? "sensitive" : "encrypted" }),
  })
}
const verified = await request(`/v10/projects/${target.projectId}/env?teamId=${target.organizationId}&decrypt=false`)
const remaining = (verified.envs ?? []).filter((candidate) => candidate.key === (apply ? REALTIME_ENV : entry.key) && (candidate.target === "production" || candidate.target?.includes?.("production")))
if (remaining.length !== 1) throw new Error("Vercel frontend realtime environment entry disappeared or duplicated")
console.log(JSON.stringify({ ok: true, applied: apply, projectId: target.projectId, environment: "production", key: apply ? REALTIME_ENV : entry.key, expectedValue: expected }, null, 2))
