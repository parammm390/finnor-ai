import { loadContract } from "./release-policy.mjs"

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
const productionEntries = (envResponse.envs ?? []).filter((entry) => entry.key === "JARVIS_SSE_GATEWAY_URL" && (entry.target === "production" || entry.target?.includes?.("production")))
if (productionEntries.length !== 1 || !productionEntries[0].id) throw new Error("Vercel frontend must have exactly one production JARVIS_SSE_GATEWAY_URL entry")
const entry = productionEntries[0]
const expected = contract.topology.worker.sseGatewayUrl
if (apply) {
  await request(`/v9/projects/${target.projectId}/env/${entry.id}?teamId=${target.organizationId}`, {
    method: "PATCH",
    body: JSON.stringify({ key: entry.key, value: expected, target: ["production"], type: entry.type === "sensitive" ? "sensitive" : "encrypted" }),
  })
}
const verified = await request(`/v10/projects/${target.projectId}/env?teamId=${target.organizationId}&decrypt=false`)
const remaining = (verified.envs ?? []).filter((candidate) => candidate.key === entry.key && (candidate.target === "production" || candidate.target?.includes?.("production")))
if (remaining.length !== 1) throw new Error("Vercel frontend realtime environment entry disappeared or duplicated")
console.log(JSON.stringify({ ok: true, applied: apply, projectId: target.projectId, environment: "production", key: entry.key, expectedValue: expected }, null, 2))
