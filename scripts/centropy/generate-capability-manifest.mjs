import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const project = resolve(import.meta.dirname, "../..")
const apiRoot = join(project, "finnor-os/apps/api/app/api")
const output = join(project, "src/lib/centropy/capability-manifest.generated.json")

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : entry.name === "route.ts" ? [path] : []
  })
}

function quoted(content) { return [...content.matchAll(/"([a-z][a-z0-9_-]+)"/g)].map((match) => match[1]) }
function block(source, start, end) {
  const begin = source.indexOf(start)
  const finish = source.indexOf(end, begin + start.length)
  if (begin < 0 || finish < 0) throw new Error(`Cannot find registry block ${start}`)
  return source.slice(begin + start.length, finish)
}

const companyBrainSource = readFileSync(join(apiRoot, "company-brain/[operation]/route.ts"), "utf8")
function registeredOperations(path, name) {
  const source = readFileSync(join(project, path), "utf8")
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:new\\s+Set\\s*\\(\\s*)?\\[([\\s\\S]*?)\\]`))
  if (!match) throw new Error(`Cannot find operation registry ${name}`)
  const operations = [...match[1].matchAll(/['"]([a-z][a-z0-9-]+)['"]/g)].map((entry) => entry[1])
  if (!operations.length || new Set(operations).size !== operations.length) throw new Error(`Invalid operation registry ${name}`)
  return operations
}
const delegatedRegistries = [
  ["EVIDENCE_OPERATIONS", "evidence-execution/api.ts"],
  ["PROGRAM_OPERATIONS", "program-synthesis/api.ts"],
  ["COMPUTE_SEARCH_OPERATIONS", "compute-search/api.ts"],
  ["INTERFACE_OPERATIONS", "interface-synthesis/api.ts"],
  ["M1_OPERATIONS", "decision-slice/handler.ts"],
  ["CONTINUATION_OPERATIONS", "live-recompilation/api.ts"],
  ["PROCEDURE_OPERATIONS", "procedure-induction/api.ts"],
  ["DELIBERATION_OPERATIONS", "deliberation/api.ts"],
]
const companyBrainOperations = [...new Set([
  ...[...companyBrainSource.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]),
  ...delegatedRegistries.flatMap(([name, file]) => {
    if (!companyBrainSource.includes(name)) throw new Error(`Undelegated operation registry ${name}`)
    return registeredOperations(`finnor-os/packages/private-equity/src/${file}`, name)
  }),
])]
const companyBrainReads = new Set([
  "belief-view", "belief-pin", "roots", "projection", "search", "object", "traverse",
  "provenance", "history", "evidence-lineage", "decision-lineage", "available-actions", "context",
  "evidence-handles", "evidence-read", "evidence-witness",
  "program-read", "program-witness", "program-module", "program-projection", "program-artifact", "program-ports", "program-interface-module",
  "compute-search-read", "compute-search-projection",
  "interface-read", "interface-projection", "interface-catalogue", "interface-module", "interface-ports",
  "decision-slice-read", "decision-slice-context", "decision-slice-witness", "decision-slice-changes", "decision-slice-view",
  "continuation-read", "continuation-projection",
  "procedure-experience", "procedure-induction-read", "procedure-read", "procedure-component", "procedure-projection", "procedure-admission-request", "procedure-interface", "procedure-costs",
  "deliberation-read", "deliberation-projection", "deliberation-module-read", "deliberation-evidence-read",
])
const readModelsSource = readFileSync(join(apiRoot, "read-models/[view]/route.ts"), "utf8")
const readModels = ["attention", ...[...block(readModelsSource, "const VIEWS:", "export async function GET").matchAll(/^[ \t]+"([a-z-]+)":/gm)].map((match) => match[1])]
const artifactOperations = {
  GET: [
    "versions/:versionId", "ir/:versionId", "diff", "comments", "reviews", "bindings", "lineage",
    "publications/:publicationId", "provider-creations/:creationId", "context",
  ],
  POST: ["drafts", "patches", "comments", "reviews", "bindings", "lineage", "publish", "publish-new", "recalculate"],
}

const familyRules = [
  [/^company-brain\//, "company-brain", "@finnor/private-equity", ["WORLD", "CANVAS"]],
  [/^private-equity\/digital-twin$/, "digital-twin", "@finnor/private-equity", ["WORLD", "CANVAS"]],
  [/^private-equity\/ic\//, "ic", "@finnor/private-equity", ["CANVAS"]],
  [/^underwriting\/|^investment-cases\//, "underwriting", "@finnor/private-equity", ["CANVAS"]],
  [/^artifacts|^artifact-templates|^documents\//, "artifact", "@finnor/artifacts", ["CANVAS"]],
  [/^integrations\/microsoft-graph/, "m365", "@finnor/data-platform", ["SETTINGS", "CANVAS"]],
  [/^connections\//, "connection", "@finnor/security", ["SETTINGS"]],
  [/^computer\//, "computer", "@finnor/computer", ["THREAD", "CANVAS"]],
  [/^corrections\//, "correction", "@finnor/memory", ["CANVAS"]],
  [/^reconciliation\//, "reconciliation", "@finnor/workflow-runtime", ["CANVAS"]],
  [/^push-subscriptions\//, "device-subscription", "@finnor/db", ["SETTINGS"]],
  [/^threads\/:id\/canvas$/, "canvas-preference", "@finnor/db", ["CANVAS"]],
  [/^threads\//, "thread", "@finnor/db", ["THREAD"]],
  [/^instructions\//, "instruction", "@finnor/db", ["THREAD"]],
  [/^works\//, "work", "@finnor/db", ["THREAD", "CANVAS"]],
  [/^objectives\//, "objective", "@finnor/orchestration", ["THREAD", "CANVAS"]],
  [/^workflows\//, "workflow", "@finnor/workflow-runtime", ["CANVAS"]],
  [/^workforce\//, "workforce", "@finnor/workforce", ["CANVAS"]],
  [/^outcome-packs\//, "outcome-pack", "@finnor/orchestration", ["THREAD", "CANVAS"]],
  [/^actions\//, "action", "@finnor/orchestration", ["THREAD", "CANVAS"]],
  [/^receipts\//, "receipt", "@finnor/orchestration", ["CANVAS"]],
  [/^private-equity\/calibration$/, "calibration", "@finnor/private-equity", ["SETTINGS"]],
  [/^queries\//, "query", "@finnor/orchestration", ["THREAD", "CANVAS"]],
  [/^semantic-activity\//, "semantic-activity", "@finnor/private-equity", ["WORLD", "CANVAS"]],
  [/^read-models\//, "read-model", "@finnor/read-models", ["CANVAS"]],
  [/^user-prefs\//, "preference", "@finnor/db", ["SETTINGS"]],
  [/^workspace-config\//, "workspace", "@finnor/db", ["SETTINGS"]],
  [/^operating-profile\//, "operating-profile", "@finnor/db", ["SETTINGS"]],
]

const denyPrefixes = [
  "admin/", "webhooks/", "dlq/", "policies/", "audit/", "ready/", "release/", "vitals/",
  "setup/", "events/", "private-equity/calibration/",
]
const humanOnlyPatterns = [
  /^private-equity\/ic\/committee-configurations$/,
  /^private-equity\/ic\/cases\/:id\/(votes|dissents|finalize)$/,
  /^private-equity\/ic\/cases\/:id\/reviewed-deck-link$/,
  /^private-equity\/ic\/cases\/:id\/voting\/(open|close)$/,
  /^private-equity\/ic\/cases\/:id\/questions\/:questionId\/waive$/,
  /^private-equity\/ic\/cases\/:id\/conditions\/:conditionId\/waive$/,
  /^actions\/:id\/(confirm|reject|escalate|revert)$/,
  /^actions\/human$/,
  /^outcome-packs\/grants/,
  /^workforce\/profiles$/,
  /^workforce\/proposals\/:id$/,
]
const controls = /\/(cancel|retry|pause|resume|escalate|revert|reject|confirm|handoff|compensate|control|reassign|verify|resolve)$/

function familyFor(path) {
  const match = familyRules.find(([pattern]) => pattern.test(path) || pattern.test(`${path}/`))
  if (match) return { family: match[1], owner: match[2], presentationTargets: match[3] }
  const family = path.split("/")[0]
  return { family, owner: "@finnor/api", presentationTargets: ["CANVAS"] }
}

function tags(family) {
  const byFamily = {
    "company-brain": ["company-brain"], "digital-twin": ["company-brain"], ic: ["ic", "company-brain", "semantic-activity"],
    underwriting: ["underwriting", "company-brain", "semantic-activity"], artifact: ["artifact", "source", "company-brain"], m365: ["source"], connection: ["source"],
    computer: ["work"], correction: ["work"], reconciliation: ["workflow", "work"],
    "canvas-preference": ["canvas"], thread: ["thread"], instruction: ["work", "thread", "company-brain"], work: ["work", "objective", "company-brain"], objective: ["objective", "work"],
    workflow: ["workflow", "work"], workforce: ["agents", "work"], "outcome-pack": ["objective", "work"],
    action: ["work", "authority", "company-brain", "semantic-activity"], receipt: ["work"], query: [], "semantic-activity": ["semantic-activity"],
    workspace: ["preferences"], preference: ["preferences"], "operating-profile": ["preferences"],
  }
  return byFamily[family] ?? [family]
}

function routeEntry(method, path, source) {
  const { family, owner, presentationTargets } = familyFor(path)
  const stream = path === "stream"
  // Digital Twin POST includes evidence-backed canonical mutations.
  const read = method === "GET" || (family === "company-brain" && companyBrainReads.has(path.slice("company-brain/".length))) || ["query", "semantic-activity"].includes(family)
  const adminOnly = denyPrefixes.some((prefix) => `${path}/`.startsWith(prefix)) ||
    (family === "read-model" && /read-models\/(reliability|readiness|readiness-slo|failure-injections)/.test(path))
  const control = controls.test(path) || path === "company-brain/procedure-induction-cancel" || /^company-brain\/(?:evidence|program|compute-search|interface|decision-slice|deliberation)-(?:cancel|resume|reconcile)$/.test(path)
  const classification = adminOnly ? "ADMIN" : stream ? "STREAM" : read ? "READ" : control ? "CONTROL" : "MUTATION"
  const systemOnly = path.startsWith("webhooks/") || ["ready", "release", "vitals", "health"].includes(path)
  const humanOnly = humanOnlyPatterns.some((pattern) => pattern.test(path))
  const userProduct = !adminOnly && !systemOnly
  return {
    capabilityId: `http.${method.toLowerCase()}.${path.replaceAll("/", ".").replaceAll(":", "$")}`,
    family, owner, transport: "http", method, routePattern: path, routeDepth: path.split("/").length,
    classification, kind: read ? "read" : classification === "CONTROL" ? "control" : "mutation",
    userProduct, agentProduct: false, modelCallable: false, humanOnly, adminOnly, systemOnly,
    requiredContext: path.includes(":") ? ["path_reference"] : [],
    authorityClass: read ? "query" : humanOnly ? "human_attestation" : "backend_policy",
    effectClass: read ? null : classification === "CONTROL" ? "runtime_control" : "domain_mutation",
    verificationClass: read ? "canonical_read" : "canonical_reread",
    presentationTargets: userProduct ? presentationTargets : [],
    invalidationTags: read ? [] : tags(family), timeoutClass: stream ? "STREAM" : read ? "READ" : "WRITE",
    tests: [], source,
  }
}

const routes = []
for (const file of files(apiRoot)) {
  const source = relative(project, file).replaceAll("\\", "/")
  const code = readFileSync(file, "utf8")
  const methods = new Set([
    ...[...code.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]),
    ...[...code.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)].map((match) => match[1]),
  ])
  const path = relative(apiRoot, file).replace(/\/route\.ts$/, "").replaceAll("\\", "/")
    .replaceAll(/\[([^\].]+)\]/g, ":$1")
  for (const method of methods) {
    if (path === "company-brain/:operation") {
      for (const operation of companyBrainOperations) routes.push(routeEntry(method, `company-brain/${operation}`, source))
    } else if (path === "read-models/:view") {
      for (const view of readModels) routes.push(routeEntry(method, `read-models/${view}`, source))
    } else if (path === "documents/:id/artifact/[...action]") {
      for (const operation of artifactOperations[method] ?? []) routes.push(routeEntry(method, `documents/:id/artifact/${operation}`, source))
    } else routes.push(routeEntry(method, path, source))
  }
}

function registryEntries() {
  const pe = readFileSync(join(project, "finnor-os/packages/domain-plugins/private-equity/index.ts"), "utf8")
  const peActions = [...block(pe, "export const PRIVATE_EQUITY_ACTION_CONTRACTS", "].map(").matchAll(/\["([a-z_]+)"/g)].map((match) => match[1])
  const universal = readFileSync(join(project, "finnor-os/packages/domain-plugins/universal-actions/index.ts"), "utf8")
  const universalActions = quoted(block(universal, "const ACTION_TYPES:", "];"))
  const querySource = readFileSync(join(project, "finnor-os/packages/shared-types/src/operational-queries.ts"), "utf8")
  const queries = [...quoted(block(querySource, "export const CORE_OPERATIONAL_QUERY_INTENTS = [", "] as const")),
    ...quoted(block(querySource, "export const PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS = [", "] as const")),
    ...quoted(block(querySource, "export const PROGRAM_OPERATIONAL_QUERY_INTENTS = [", "] as const"))]
  const registry = readFileSync(join(project, "finnor-os/packages/orchestration/src/plugin-registry.ts"), "utf8")
  const humanOnly = quoted(block(registry, "export const HUMAN_ONLY_PLANNING_CAPABILITIES = [", "] as const"))
  const humanOnlySet = new Set(humanOnly)
  const registered = new Set([...peActions, ...universalActions])
  const planner = (name, family, owner, modelCallable, humanOnly) => ({
    capabilityId: `planner.${name}`, family, owner, transport: "planner", method: null, routePattern: null, routeDepth: 0,
    classification: name.startsWith("query:") ? "READ" : "MUTATION", kind: name.startsWith("query:") ? "read" : "mutation",
    userProduct: true, agentProduct: modelCallable, modelCallable, humanOnly, adminOnly: false, systemOnly: false,
    requiredContext: [], authorityClass: humanOnly ? "human_attestation" : name.startsWith("query:") ? "query" : "backend_policy",
    effectClass: name.startsWith("query:") ? null : "planner_action", verificationClass: "backend_runtime",
    presentationTargets: family === "private-equity" ? ["THREAD", "CANVAS", "WORLD"] : ["THREAD", "CANVAS"],
    invalidationTags: [], timeoutClass: "RUNTIME", tests: [], source: "finnor-os/packages/orchestration/src/plugin-registry.ts",
  })
  return [
    ...peActions.map((name) => planner(name, "private-equity", "@finnor/private-equity", !humanOnlySet.has(name), humanOnlySet.has(name))),
    ...universalActions.map((name) => planner(name, "universal-action", "@finnor/plugin-universal-actions", true, false)),
    ...queries.map((name) => planner(`query:${name}`, "operational-query", "@finnor/orchestration", true, false)),
    ...humanOnly.filter((name) => !registered.has(name)).map((name) => planner(name, "human-attestation", "@finnor/private-equity", false, true)),
  ]
}

const capabilities = [...routes, ...registryEntries()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))
const duplicate = capabilities.find((entry, index) => index > 0 && entry.capabilityId === capabilities[index - 1].capabilityId)
if (duplicate) throw new Error(`Duplicate capability: ${duplicate.capabilityId}`)
const document = JSON.stringify({ schemaVersion: 1, generatedFrom: "actual API route files + canonical planner registries", capabilities }, null, 2) + "\n"
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== document) throw new Error("CENTROPY capability manifest is stale; run npm run centropy:manifest")
} else {
  mkdirSync(resolve(output, ".."), { recursive: true })
  writeFileSync(output, document)
}
console.log(`CENTROPY capabilities: ${routes.length} HTTP route operations, ${capabilities.length - routes.length} planner operations`)
