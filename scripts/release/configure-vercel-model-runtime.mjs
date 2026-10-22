import { loadContract } from "./release-policy.mjs"
import { authorizeProductionMutation } from "./production-mutation-guard.mjs"

const contract = loadContract()
const target = contract.topology.api
const environment = contract.topology.computePlane.providerRuntime.environment
const apply = process.argv.includes("--apply")
const token = process.env.VERCEL_TOKEN?.trim()
if (!token) throw new Error("VERCEL_TOKEN is required")
if (environment.AWS_BEDROCK_AUTH_MODE !== "iam" || environment.AWS_BEDROCK_REGION !== contract.topology.worker.region) {
  throw new Error("API model runtime must use IAM in the selected project Region")
}
if (Object.keys(environment).some((key) => !/^AWS_BEDROCK_(AUTH_MODE|REGION|(GLM|MISTRAL|DEEPSEEK)_MODEL_ID)$/.test(key))) {
  throw new Error("Model runtime configuration may contain only non-secret routing fields")
}
if (apply) {
  await authorizeProductionMutation("vercel-environment-update")
  const response = await fetch(`https://api.vercel.com/v10/projects/${target.projectId}/env?teamId=${target.organizationId}&upsert=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(Object.entries(environment).map(([key, value]) => ({ key, value, type: "plain", target: ["production"] }))),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json()
  if (!response.ok || body.error || body.failed?.length) throw new Error("API model runtime environment update failed")
  const check = await fetch(`https://api.vercel.com/v10/projects/${target.projectId}/env?teamId=${target.organizationId}&decrypt=false`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  })
  if (!check.ok) throw new Error("API model runtime environment readback failed")
  const entries = (await check.json()).envs
  for (const [key, value] of Object.entries(environment)) {
    const found = entries?.filter((entry) => entry.key === key && entry.target?.includes("production") && !entry.gitBranch) ?? []
    if (found.length !== 1 || found[0].type !== "plain" || found[0].value !== value) {
      throw new Error(`API model runtime readback mismatch for ${key}`)
    }
  }
}
console.log(JSON.stringify({ applied: apply, projectId: target.projectId, environment: "production", modelEnvironment: environment }))
