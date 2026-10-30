import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { readCanonicalPlanner } from "./canonical-planner.mjs"

const project = resolve(import.meta.dirname, "../..")
const apiRoot = join(project, "finnor-os/apps/api/app/api")
const output = join(project, "src/lib/centropy/capability-manifest.generated.json")

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : entry.name === "route.ts" ? [path] : []
  })
}

function block(source, start, end) {
  const begin = source.indexOf(start)
  const finish = source.indexOf(end, begin + start.length)
  if (begin < 0 || finish < 0) throw new Error(`Cannot find registry block ${start}`)
  return source.slice(begin + start.length, finish)
}

const companyBrainSource = readFileSync(join(apiRoot, "company-brain/[operation]/route.ts"), "utf8")
const r1Operations = registeredOperations("finnor-os/packages/private-equity/src/r1/api.ts", "R1_OPERATIONS")
const r1Reads=new Set(["r1-read","r1-review","r1-projection","r1-history","r1-record"])
const viabilityOperations = registeredOperations("finnor-os/packages/private-equity/src/project-z/z3-viability/contracts.ts", "Z3_OPERATIONS")
if (!companyBrainSource.includes("VIABILITY_OPERATIONS")) throw new Error("Viability operations must be actually delegated")
function registeredOperations(path, name) {
  const source = readFileSync(join(project, path), "utf8")
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:new\\s+Set\\s*\\(\\s*)?\\[([\\s\\S]*?)\\]`))
  const derived = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*Object\\.keys\\(\\s*(\\w+)\\s*\\)`))
  if (!match && !derived) throw new Error(`Cannot find operation registry ${name}`)
  const operations = derived
    ? [...block(source, `export const ${derived[1]}={`, "\n}").matchAll(/['"]([a-z][a-z0-9-]+)['"]\s*:/g)].map((entry) => entry[1])
    : [...match[1].matchAll(/['"]([a-z][a-z0-9-]+)['"]/g)].map((entry) => entry[1])
  if (!operations.length || new Set(operations).size !== operations.length) throw new Error(`Invalid operation registry ${name}`)
  return operations
}
const delegatedRegistries = [
  ["SharedWorkOperations", "project-z/z1-shared-work/api.ts"],
  ["INSTITUTION_OPERATIONS", "institution-program/api.ts"],
  ["EVIDENCE_OPERATIONS", "evidence-execution/api.ts"],
  ["PRIMARY_OPERATIONS", "primary-diligence/api.ts"],
  ["BILATERAL_OPERATIONS", "bilateral-opportunities/api.ts"],
  ["PROGRAM_OPERATIONS", "program-synthesis/api.ts"],
  ["COMPUTE_SEARCH_OPERATIONS", "compute-search/api.ts"],
  ["INTERFACE_OPERATIONS", "interface-synthesis/api.ts"],
  ["APPLICATION_OPERATIONS", "enterprise-applications/api.ts"],
  ["LEARNING_OPERATIONS", "policy-learning/api.ts"],
  ["IDENTIFICATION_OPERATIONS", "system-identification/api.ts"],
  ["EconomicOperations", "economic-action-theory/api.ts"],
  ["StrategicOperations", "strategic-response/contracts.ts"],
  ["CONFIDENTIAL_OPERATIONS", "confidential-computation/api.ts"],
  ["EXECUTION_PROOF_OPERATIONS", "project-z/z4-execution-proof/contracts.ts"],
  ["InteractionOperations", "interaction-synthesis/api.ts"],
  ["CoalitionOperations", "project-z/z2-coalitions/api.ts"],
  ["M1_OPERATIONS", "decision-slice/handler.ts"],
  ["CONTINUATION_OPERATIONS", "live-recompilation/api.ts"],
  ["PROCEDURE_OPERATIONS", "procedure-induction/api.ts"],
  ["DELIBERATION_OPERATIONS", "deliberation/api.ts"],
  ["APPLICATION_OPERATIONS", "application-semantics/api.ts"],
]
const identificationOperations = registeredOperations("finnor-os/packages/private-equity/src/r4/contracts.ts", "R4_OPERATIONS")
const identificationReads = new Set(registeredOperations("finnor-os/packages/private-equity/src/r4/contracts.ts", "R4_READ_OPERATIONS"))
const capitalSource = readFileSync(join(project,"finnor-os/packages/shared-types/src/capital-program.ts"),"utf8")
const capitalOperations = [...block(capitalSource,"export const CapitalProgramV2Operations=","} as const;")
  .matchAll(/["'](capital-program-[a-z]+)["']\s*:/g)].map(match=>match[1])
const formationSource = readFileSync(join(project,"finnor-os/packages/private-equity/src/capital-formation/contracts.ts"),"utf8")
const formationOperations = [...block(formationSource,"export const CAPITAL_FORMATION_OPERATIONS = {","} as const;")
  .matchAll(/["'](capital-formation-[a-z-]+)["']\s*:/g)].map(match=>match[1])
if(!formationOperations.length||!companyBrainSource.includes("CAPITAL_FORMATION_OPERATION_NAMES"))throw new Error("Capital formation must be actually delegated")
const m4Source = readFileSync(join(project,"finnor-os/packages/private-equity/src/counterexample-search/handler.ts"),"utf8")
const m4Operations = new Map([...block(m4Source,"export const M4Operations={","} as const")
  .matchAll(/'([^']+)':\s*\{schema:\w+,classification:'(READ|CONTROL|MUTATION)'\}/g)]
  .map(match=>[match[1],match[2]]))
const branchSource = readFileSync(join(project,"finnor-os/packages/private-equity/src/branch-fabric/contracts.ts"),"utf8")
const branchOperations = new Map([...block(branchSource,"export const BranchOperations = {","} as const;")
  .matchAll(/(?:^|\n)\s*(?:'([^']+)'|(\w+)):\s*\{schema:.+?,classification:'(READ|CONTROL|MUTATION)'\}/g)]
  .map(match=>[match[1]??match[2],match[3]]))
if(!capitalOperations.length||!m4Operations.size||!branchOperations.size||
  !companyBrainSource.includes("CAPITAL_PROGRAM_V2_OPERATIONS")||!companyBrainSource.includes("M4_OPERATIONS"))
  throw new Error("Completed owner operation registries must be present and actually delegated")
// Product admission is limited to the mounted coalition controls; the generic
// owner catalogue does not grant release, consent or effect authority.
const coalitionOperations = new Map([
  ["policies/coalition-read", "READ"],
  ["allocations/coalition-read", "READ"],
  ["allocations/coalition-clear", "MUTATION"],
  ["allocations/coalition-consume", "MUTATION"],
  ["obligations/coalition-read", "READ"],
  ["obligations/coalition-consent-history", "READ"],
  ["obligations/coalition-prepare", "MUTATION"],
])
const companyBrainOperations = [...new Set([
  ...viabilityOperations,
  ...capitalOperations,...formationOperations,...m4Operations.keys(),
  ...[...companyBrainSource.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]),
  ...delegatedRegistries.flatMap(([name, file]) => {
    if (!companyBrainSource.includes(name)) throw new Error(`Undelegated operation registry ${name}`)
    return registeredOperations(`finnor-os/packages/private-equity/src/${file}`, name)
  }),
])]
const closingOperations = registeredOperations("finnor-os/packages/private-equity/src/closing/api.ts", "CLOSING_OPERATIONS")
const companyBrainReads = new Set([
  "viability-read",
  "z1-read-shared-work", "z1-project-original-work",
  "institution-read", "institution-status", "institution-witness", "institution-sources", "institution-inputs",
  "belief-view", "belief-pin", "roots", "projection", "search", "object", "traverse",
  "provenance", "history", "evidence-lineage", "decision-lineage", "available-actions", "context",
  "evidence-handles", "evidence-read", "evidence-witness",
  "primary-context", "primary-read",
  "bilateral-context", "bilateral-read", "bilateral-handoff",
  "program-read", "program-witness", "program-module", "program-projection", "program-artifact", "program-ports", "program-interface-module",
  "compute-search-read", "compute-search-projection",
  "interface-read", "interface-projection", "interface-catalogue", "interface-module", "interface-ports",
  "application-read", "application-record", "application-list", "application-history", "application-asset", "application-impact", "application-admission",
  "learning-read", "learning-list", "learning-experience", "learning-admission",
  "confidential-read", "confidential-list",
  "identification-targets", "identification-read", "identification-list", "identification-history", "identification-experiment", "identification-admission",
  "decision-slice-read", "decision-slice-context", "decision-slice-witness", "decision-slice-changes", "decision-slice-view",
  "continuation-read", "continuation-projection",
  "procedure-experience", "procedure-induction-read", "procedure-read", "procedure-component", "procedure-projection", "procedure-admission-request", "procedure-interface", "procedure-costs",
  "deliberation-read", "deliberation-projection", "deliberation-module-read", "deliberation-evidence-read",
  "capital-program-read","capital-program-status","capital-program-list","capital-program-context","capital-program-ports","capital-program-witness","capital-program-module",
  "capital-formation-read","capital-formation-list","capital-formation-profiles",
  "application-projection",
  "economic-theory-read", "economic-theory-list", "economic-theory-artifact", "economic-theory-compare",
  "economic-programme-read", "economic-reservation-read",
  "response-model-read", "response-model-list", "response-model-artifact", "response-model-compare", "response-use-read",
  "interaction-read", "interaction-list", "interaction-artifact", "interaction-compare", "interaction-local", "interaction-run-read",
  "coalition-read",
])
const elicitationOperations=registeredOperations("finnor-os/packages/epistemic-runtime/src/incentive-rule-synthesis/contracts.ts","ELICITATION_OPERATIONS")
const elicitationReads=new Set(["context","read","status","history"])
const ownerLeafOperations=new Map()
for(const family of ["interventions","policies","allocations","obligations","experiments","economic-outcomes","coalition-programmes"]){
 const source=readFileSync(join(apiRoot,`${family}/[operation]/route.ts`),"utf8")
 const operations = new Set([
   ...[...source.matchAll(/case\s+['"]([a-z][a-z0-9-]*)['"]\s*:/g)].map(m=>m[1]),
   ...[...source.matchAll(/route\.operation\s*===?\s*['"]([a-z][a-z0-9-]*)['"]/g)].map(m=>m[1]),
 ])
 if (!operations.size) throw new Error(`Missing owner operation dispatch: ${family}`)
 ownerLeafOperations.set(family,[...operations])
}
const ownerLeafReads=new Set(["read-pywhy-assessment","query","validate","finite-preference","experiment-projection","read","read-mechanism",
 "resources","budget-status","read-commitment","read-execution-handoff","check-budget","check-dispatch",
 "history","execution-evidence","learning-assessment"])
const readModelsSource = readFileSync(join(apiRoot, "read-models/[view]/route.ts"), "utf8")
const readModels = ["attention", ...[...block(readModelsSource, "const VIEWS:", "export async function GET").matchAll(/^[ \t]+"([a-z-]+)":/gm)].map((match) => match[1])]
const artifactOperations = {
  GET: [
    "versions/:versionId", "ir/:versionId", "diff", "comments", "reviews", "bindings", "lineage",
    "publications/:publicationId", "provider-creations/:creationId", "context",
  ],
  POST: ["drafts", "patches", "comments", "reviews", "bindings", "lineage", "publish", "publish-new", "recalculate"],
}

const atlasSource = readFileSync(join(project, "finnor-os/packages/private-equity/src/r7/contracts.ts"), "utf8")
const atlasOperations = new Map([...block(atlasSource, "export const R7OperationClasses={", "} as const;")
  .matchAll(/([a-z]+):'(READ|CONTROL|MUTATION)'/g)].map(match => [match[1], match[2]]))
if (!atlasOperations.size) throw new Error("Missing versioned R7 operation classes")

const operationClasses = new Map()
operationClasses.set("company-brain/z1-cancel-shared-work", "CONTROL")
operationClasses.set("company-brain/viability-recover", "CONTROL")
for (const operation of ["execution-proof-read", "execution-proof-list"])
  operationClasses.set(`company-brain/${operation}`, "READ")
operationClasses.set("company-brain/execution-proof-cancel", "CONTROL")
for (const operation of ["execution-proof-intake", "execution-proof-plan", "execution-proof-submit", "execution-proof-audit", "execution-proof-consume"])
  operationClasses.set(`company-brain/${operation}`, "MUTATION")
for (const operation of ["response-model-cancel", "response-model-resume", "response-use-cancel", "response-use-resume"])
  operationClasses.set(`company-brain/${operation}`, "CONTROL")
for (const [family, operations] of ownerLeafOperations) for (const operation of operations)
  operationClasses.set(`${family}/${operation}`, ownerLeafReads.has(operation) ? "READ" :
    ["cancel-delivery", "reconcile-request", "reconcile"].includes(operation) ? "CONTROL" : "MUTATION")
for (const [family, operations] of [
  ["branches", branchOperations], ["decision-atlases", atlasOperations], ["company-brain", m4Operations],
  ["identification-plans", new Map(identificationOperations.map(operation => [operation,
    identificationReads.has(operation) ? "READ" : operation === "cancel" ? "CONTROL" : "MUTATION"]))],
  ["policies", new Map(r1Operations.map(operation => [operation,
    r1Reads.has(operation) ? "READ" : ["r1-cancel", "r1-reconcile"].includes(operation) ? "CONTROL" : "MUTATION"]))],
  ["elicitation-protocols", new Map(elicitationOperations.map(operation => [operation,
    elicitationReads.has(operation) ? "READ" : operation === "cancel" ? "CONTROL" : "MUTATION"]))],
]) for (const [operation, classification] of operations) operationClasses.set(`${family}/${operation}`, classification)
for (const [path, classification] of coalitionOperations) {
  if (!ownerLeafOperations.get(path.split("/")[0])?.includes(path.split("/")[1]))
    throw new Error(`Product coalition operation is not dispatched by its owner: ${path}`)
  operationClasses.set(path, classification)
}
const routeOperations = new Map([...ownerLeafOperations].map(([family, operations]) => [`${family}/:operation`, operations]))
for (const [path, operations] of [
  ["company-brain/:operation", companyBrainOperations], ["elicitation-protocols/:operation", elicitationOperations],
  ["closing/:operation", closingOperations], ["branches/:operation", [...branchOperations.keys()]],
  ["identification-plans/:operation", identificationOperations], ["decision-atlases/:operation", [...atlasOperations.keys()]],
  ["policies/:operation", [...new Set([...ownerLeafOperations.get("policies"), ...r1Operations])]],
]) routeOperations.set(path, operations)


const familyRules = [
  [/^capabilities\//, "capability-upgrades", "@finnor/orchestration", ["CANVAS"]],
  [/^policies\/r1-/, "exact-control", "@finnor/private-equity", ["CANVAS"]],
  [/^identification-plans\//, "identification-plan", "@finnor/private-equity", ["CANVAS"]],
  [/^decision-atlases\//, "decision-atlas", "@finnor/private-equity", ["CANVAS"]],
  [/^elicitation-protocols\//,"elicitation-protocol","@finnor/private-equity",["CANVAS"]],
  [/^closing\//, "closing", "@finnor/private-equity", ["WORLD", "CANVAS"]],
  [/^live-controls$/, "live-control", "@finnor/private-equity", ["WORLD", "CANVAS"]],
  [/^branches\//,"branch-fabric","@finnor/private-equity",["CANVAS"]],
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
  "setup/", "events/", "private-equity/calibration/", "coalition-programmes/", "experiments/", "economic-outcomes/",
]
const restrictedOperations = new Set(["allocations/coalition-release", "obligations/coalition-consent"])
const humanOnlyPatterns = [
  /^company-brain\/z1-admit-shared-work$/,
  /^company-brain\/confidential-(?:consent|revoke|import-release)$/,
  /^company-brain\/interaction-(?:consent|observe|action)$/,
  /^elicitation-protocols\/(?:report|event|review|close|use)$/,
  /^closing\/(submit|stop|resume|observe)$/,
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
    "exact-control": ["work", "company-brain"],
    "coalition-programme": ["work", "company-brain", "authority"],
    "decision-atlas": ["work", "company-brain"],
    "identification-plan": ["work", "company-brain"],
    closing: ["closing", "work", "objective", "company-brain", "semantic-activity"],
    "live-control": ["work", "company-brain", "underwriting", "authority"],
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
  const coalitionClassification = method === "POST" ? coalitionOperations.get(path) : undefined
  const { family, owner, presentationTargets } = coalitionClassification
    ? { family: "coalition-programme", owner: "@finnor/private-equity", presentationTargets: ["CANVAS"] }
    : familyFor(path)
  const stream = path === "stream"
  const r1 = path.startsWith("policies/") && r1Operations.includes(path.slice("policies/".length))
  const ownerClassification = operationClasses.get(path)
  const read = method === "GET" || ownerClassification==="READ" || (family === "company-brain" && companyBrainReads.has(path.slice("company-brain/".length))) || ["query", "semantic-activity"].includes(family) || family === "closing" && ["read", "projection", "ports"].includes(path.slice("closing/".length))
  const adminOnly = restrictedOperations.has(path) || !r1 && !coalitionClassification && denyPrefixes.some((prefix) => `${path}/`.startsWith(prefix)) ||
    (family === "read-model" && /read-models\/(reliability|readiness|readiness-slo|failure-injections)/.test(path))
  const control = r1&&["r1-cancel","r1-reconcile"].includes(path.slice("policies/".length)) || path === "live-controls" || path === "closing/stop" || controls.test(path) || path === "company-brain/procedure-induction-cancel" || /^company-brain\/(?:evidence|program|compute-search|interface|decision-slice|deliberation|capital-program|capital-formation|application)-(?:cancel|resume|reconcile|advance)$/.test(path)
  const classification = adminOnly ? "ADMIN" : stream ? "STREAM" : ownerClassification ?? (read ? "READ" : control ? "CONTROL" : "MUTATION")
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
    invalidationTags: read ? [] : family==="elicitation-protocol"?["work","company-brain","elicitation-protocol"]:family==="branch-fabric"?["work","branch-fabric"]:
      path.startsWith("company-brain/z1-")?["work","company-brain","authority","source"]:
      path.startsWith("company-brain/viability-")?["work","company-brain"]:
      path.startsWith("company-brain/response-")?["work","company-brain"]:
      path.startsWith("company-brain/execution-proof-")?["work","company-brain","authority","source"]:
      path.startsWith("company-brain/confidential-")?["work","company-brain","authority","source","underwriting"]:
      path.startsWith("company-brain/capital-formation-")?["work","company-brain","authority","source"]:
      path.startsWith("company-brain/capital-program-")||m4Operations.has(path.slice("company-brain/".length))?["work","company-brain"]:tags(family),
    timeoutClass: stream ? "STREAM" : read ? "READ" : "WRITE",
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
    // Next shares the segment name with S4; existing nested clients still
    // supply a tenant reference and the backend aliases it before enforcing it.
    .replace(/^policies\/:operation\/:actionType(?=\/|$)/, "policies/:tenantId/:actionType")
  for (const method of methods) {
    if (routeOperations.has(path)) {
      for (const operation of routeOperations.get(path)) routes.push(routeEntry(method, path.replace(":operation", operation), source))
    } else if (path === "read-models/:view") {
      for (const view of readModels) routes.push(routeEntry(method, `read-models/${view}`, source))
    } else if (path === "documents/:id/artifact/[...action]") {
      for (const operation of artifactOperations[method] ?? []) routes.push(routeEntry(method, `documents/:id/artifact/${operation}`, source))
    } else routes.push(routeEntry(method, path, source))
  }
}

function registryEntries() {
  const snapshot = readCanonicalPlanner()
  const humanOnlySet = new Set(snapshot.humanOnly)
  const privateEquitySet = new Set(snapshot.privateEquityActions)
  return snapshot.entries.map(entry => {
    const name = entry.capability, humanOnly = humanOnlySet.has(name)
    const family = privateEquitySet.has(name) ? "private-equity" : humanOnly ? "human-attestation" :
      entry.kind === "query" ? "operational-query" : entry.kind === "wait" || entry.kind === "check" ? "objective-runtime" :
        snapshot.plugins[name] === "universal-actions" ? "universal-action" : "shared-action"
    const owner = family === "private-equity" || humanOnly ? "@finnor/private-equity" :
      snapshot.plugins[name] && snapshot.plugins[name] !== "clarification" ? `@finnor/plugin-${snapshot.plugins[name]}` : "@finnor/orchestration"
    return {
      capabilityId: `planner.${name}`, family, owner, transport: "planner", method: null, routePattern: null, routeDepth: 0,
      classification: entry.kind === "query" ? "READ" : entry.kind === "action" ? "MUTATION" : "CONTROL",
      kind: entry.kind === "query" ? "read" : entry.kind === "action" ? "mutation" : entry.kind,
      userProduct: true, agentProduct: entry.modelProposable && entry.available, modelCallable: entry.modelProposable,
      humanOnly, adminOnly: false, systemOnly: false,
      requiredContext: entry.requiredReferences, authorityClass: humanOnly ? "human_attestation" : entry.authorityRequirement,
      effectClass: entry.effectClass, verificationClass: "backend_runtime",
      presentationTargets: family === "private-equity" ? ["THREAD", "CANVAS", "WORLD"] : ["THREAD", "CANVAS"],
      invalidationTags: [], timeoutClass: "RUNTIME", tests: [], source: "finnor-os/packages/orchestration/src/plugin-registry.ts",
      planning: entry,
    }
  })
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
