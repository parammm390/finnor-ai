import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const api = JSON.parse(readFileSync(resolve(root, "finnor-os/openapi.json"), "utf8"))
const manifest = JSON.parse(readFileSync(resolve(root, "src/lib/centropy/capability-manifest.generated.json"), "utf8"))
const output = resolve(root, "src/lib/centropy/human-forms.generated.json")
function dereference(value, seen = new Set()) {
  if (Array.isArray(value)) return value.map((v) => dereference(v, seen))
  if (!value || typeof value !== "object") return value
  if (value.$ref) {
    if (!value.$ref.startsWith("#/") || seen.has(value.$ref)) throw new Error(`Unsupported form schema reference: ${value.$ref}`)
    const target = value.$ref.slice(2).split("/").reduce((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], api)
    if (!target) throw new Error(`Unknown form schema: ${value.$ref}`)
    return dereference(target, new Set([...seen, value.$ref]))
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["$schema", "definitions", "$defs"].includes(key)).map(([key, item]) => [key, dereference(item, seen)]))
}
const words = (s) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll(/[_-]/g, " ")
function group(c) {
  if (c.family === "digital-twin") return "institutional-records"
  if (c.family === "ic") return c.routePattern === "private-equity/ic/committee-configurations" ? "committee-configuration" : "committee-records"
  if (c.family === "m365") return "microsoft"
  if (c.family === "workforce") return "workforce"
  if (c.family === "operating-profile") return "operating-profile"
  if (c.family === "preference") return "preferences"
  if (c.family === "workflow") return "workflow-controls"
  if (c.family === "outcome-pack" && c.routePattern.includes("grants")) return "autonomy"
  if (c.family === "underwriting" && /models|artifact-bindings|projections|comparisons/.test(c.routePattern)) return "model-records"
  return null
}
const formEntries = []
for (const c of manifest.capabilities) {
  const family = group(c)
  if (!family || c.transport !== "http" || !c.userProduct || c.method === "GET") continue
  // Official votes use the dedicated immutable-basis control. Reassignment
  // remains attached to its actual Workforce execution object.
  if (/\/(votes|reassign)$/.test(c.routePattern)) continue
  const apiPath = "/api/" + c.routePattern.replaceAll(/:([A-Za-z]+)/g, "{$1}")
  const operation = api.paths[apiPath]?.[c.method.toLowerCase()]
  if (!operation) continue
  const raw = operation.requestBody?.content?.["application/json"]?.schema
  if (!raw && c.method !== "DELETE") continue
  const body = dereference(raw ?? { type: "object", properties: {}, additionalProperties: false })
  const schemaVariants = c.family === "digital-twin" ? body.anyOf ?? body.oneOf ?? [] : [body]
  for (const schema of schemaVariants) {
    const selector = schema.properties?.operation?.const
    if (c.family === "digital-twin" && typeof selector !== "string") throw new Error("Every Digital Twin variant needs its exact selector")
    const suffix = c.routePattern.split("/").filter((part) => !part.startsWith(":"))
    let title = words(selector ?? suffix.slice(-2).join(" "))
    if (c.routePattern === "operating-profile") title = "Edit operating profile"
    if (c.routePattern === "user-prefs") title = c.method === "DELETE" ? "Reset my preferences" : "Edit my preferences"
    if (c.routePattern === "workforce/profiles") title = "Configure a specialist profile"
    if (c.routePattern === "private-equity/ic/cases") title = "Open an IC case"
    if (c.routePattern === "private-equity/ic/committee-configurations") title = "Register committee membership"
    if (c.routePattern === "connections/microsoft-graph/start") title = "Connect Microsoft 365"
    if (c.routePattern === "integrations/microsoft-graph/source-scopes") title = "Register a Microsoft source scope"
    if (c.routePattern === "outcome-packs/grants") title = "Create a bounded autonomy grant"
    const id = `${c.capabilityId}${selector ? `.${selector}` : ""}`
    formEntries.push({ id, capabilityId: c.capabilityId, group: family, title: title.charAt(0).toUpperCase() + title.slice(1),
      method: c.method, routePattern: c.routePattern, operation: selector ?? null,
      readOnly: ["resolve-identity-as-known", "closed-world-claim"].includes(selector),
      owner: c.owner, humanOnly: c.humanOnly,
      pathFields: [...c.routePattern.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]),
      schema, source: c.source, generatedFrom: `finnor-os/openapi.json#paths/${apiPath}/${c.method.toLowerCase()}` })
  }
}
formEntries.sort((a, b) => a.id.localeCompare(b.id))
const document = JSON.stringify({ schemaVersion: 1, generatedFrom: "Actual backend OpenAPI input schemas and product route manifest", forms: formEntries }, null, 2) + "\n"
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== document) throw new Error("Human form catalogue is stale; run npm run centropy:forms")
} else writeFileSync(output, document)
console.log(`Typed human forms: ${formEntries.length}; Digital Twin variants: ${formEntries.filter((entry) => entry.group === "institutional-records").length}`)
