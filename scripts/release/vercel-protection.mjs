const PROTECTION_ENV_BY_COMPONENT = Object.freeze({
  frontend: "VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET",
  api: "VERCEL_API_AUTOMATION_BYPASS_SECRET",
  supplierCanaryApp: "VERCEL_SUPPLIER_CANARY_APP_AUTOMATION_BYPASS_SECRET",
  supplierCanaryAuth: "VERCEL_SUPPLIER_CANARY_AUTH_AUTOMATION_BYPASS_SECRET",
})

export function vercelProtectionEnvName(component) {
  const envName = PROTECTION_ENV_BY_COMPONENT[component]
  if (!envName) throw new Error(`No Vercel protection credential is mapped for ${component}`)
  return envName
}

export function vercelProtectionHeaders(component) {
  const envName = vercelProtectionEnvName(component)
  const secret = process.env[envName]?.trim()
  if (!secret) throw new Error(`${envName} is required before probing the protected ${component} deployment`)
  return {
    accept: "application/json",
    "cache-control": "no-cache",
    "x-vercel-protection-bypass": secret,
  }
}
