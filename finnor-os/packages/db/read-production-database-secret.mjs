import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"

/** Resolve only the existing canonical database secret. Values remain in memory
 * and never appear in proof metadata or provider-error output. */
export async function readProductionDatabaseSecret(environment, worker, kind = "application") {
  let mappings
  try { mappings = JSON.parse(environment.FINNOR_SECRET_IDS || "{}") } catch {
    throw new Error("Canonical managed database secret mapping required")
  }
  const reference = mappings?.DATABASE_URL
  const name = kind === "application" ? "finnor/prod/database-url"
    : kind === "worker" ? "finnor/prod/worker-database-url" : null
  const arn = `arn:aws:secretsmanager:${worker.region}:${worker.accountId}:secret:${name}-`
  if (!name || environment.SECRETS_PROVIDER !== "aws-secrets-manager"
      || (reference !== name && !(typeof reference === "string"
        && reference.startsWith(arn) && /^[A-Za-z0-9]{6}$/.test(reference.slice(arn.length))))) {
    throw new Error("Canonical managed database secret mapping required")
  }
  const client = new SecretsManagerClient({ region: worker.region, maxAttempts: 1 })
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: reference }))
    const raw = response.SecretString || (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : "")
    let value = raw
    try {
      const decoded = JSON.parse(raw)
      value = decoded?.DATABASE_URL || decoded?.value
    } catch { /* Single-value managed secrets follow the runtime bootstrap. */ }
    if (typeof value !== "string" || !value) throw new Error("missing")
    return value
  } catch {
    throw new Error("Canonical managed database secret read failed; verify the approved single-secret read permission")
  } finally { client.destroy() }
}
