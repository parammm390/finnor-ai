import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const { parse } = requireFromOs("dotenv")

export function readProtectedEnv(path) {
  return parse(readFileSync(resolve(path)))
}

export function readProtectedEnvValue(path, key, { fallbackKey } = {}) {
  const values = readProtectedEnv(path)
  const value = values[key] || (fallbackKey ? values[fallbackKey] : undefined)
  if (!value) throw new Error(`${key}${fallbackKey ? ` or ${fallbackKey}` : ""} is missing from the protected environment`)
  return value
}

const BUILD_SAFE_EXACT_NAMES = new Set([
  "APP_ORIGIN",
  "AUTH_ORIGIN",
  "AWS_BEDROCK_REGION",
  "AWS_REGION",
  "AXIOM_DATASET",
  "COMMS_MODE",
  "COMMUNICATIONS_BINDING",
  "CONSOLE_ORIGIN",
  "CRM_BINDING",
  "DOCUMENTS_BINDING",
  "FINNOR_BUILD_ID",
  "FINNOR_COMMIT_SHA",
  "FINNOR_ENVIRONMENT",
  "FINNOR_RELEASE_SOURCE",
  "FINNOR_SECRET_IDS",
  "FINNOR_SYSTEM_CREDENTIAL_PROVIDERS",
  "FINNOR_TENANT_SECRET_PREFIX",
  "FINNOR_VERSION",
  "GEMINI_MODEL",
  "GROQ_MODEL",
  "INVENTORY_BINDING",
  "JARVIS_SSE_GATEWAY_URL",
  "NODE_ENV",
  "PLANNER_MEMORY",
  "PORTAL_ROLE",
  "SCHEDULING_BINDING",
  "SECRETS_PROVIDER",
  "SUPABASE_URL",
  "VAPI_ASSISTANT_ID",
  "VAPI_DEFAULT_TENANT_ID",
  "VAPI_PHONE_NUMBER_ID",
  "VAPI_PUBLIC_KEY",
])

export function isBuildSafeEnvironmentName(name) {
  return name.startsWith("NEXT_PUBLIC_") || BUILD_SAFE_EXACT_NAMES.has(name)
}

export function sanitizeVercelBuildEnvironment(path, releaseValues = {}) {
  const destination = resolve(path)
  const input = readProtectedEnv(destination)
  const output = {}
  for (const [name, value] of Object.entries(input)) if (isBuildSafeEnvironmentName(name)) output[name] = value
  for (const [name, value] of Object.entries(releaseValues)) {
    if (!isBuildSafeEnvironmentName(name)) throw new Error(`release build environment name is not allowlisted: ${name}`)
    if (value !== undefined && value !== "") output[name] = String(value)
  }
  const serialized = Object.entries(output).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")
  writeFileSync(destination, `${serialized}${serialized ? "\n" : ""}`, { mode: 0o600 })
  return { retained: Object.keys(output).length, removed: Object.keys(input).filter((name) => !Object.hasOwn(output, name)).length }
}
