import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { isDeepStrictEqual } from "node:util"
import { readCanonicalPlanner } from "./canonical-planner.mjs"

const root = resolve(import.meta.dirname, "../..")
const ts = createRequire(join(root, "package.json"))("typescript")
const read = (path) => readFileSync(join(root, path), "utf8")
const digest = (value) => createHash("sha256").update(value).digest("hex")
const walk = (directory) => readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap((entry) => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`])
const manifestPath = "src/lib/centropy/capability-manifest.generated.json"
const formPath = "src/lib/centropy/human-forms.generated.json"
const manifest = JSON.parse(read(manifestPath))
const forms = JSON.parse(read(formPath)).forms
// The generated catalogue is not its own denominator. Reconstruct the actual
// registry before the frontend audit, including unavailable and native entries.
const canonicalPlanner = readCanonicalPlanner()
const plannerRows = manifest.capabilities.filter(row => row.transport === "planner")
const canonicalIdentities = canonicalPlanner.entries.map(entry => `planner.${entry.capability}`).sort()
if (!isDeepStrictEqual(plannerRows.map(row => row.capabilityId).sort(), canonicalIdentities))
  throw new Error("Canonical planner identities differ: missing, extra or duplicate capability")
for (const entry of canonicalPlanner.entries) {
  const row = plannerRows.find(candidate => candidate.capabilityId === `planner.${entry.capability}`)
  const humanOnly = canonicalPlanner.humanOnly.includes(entry.capability)
  const fields = {
    planning: entry, requiredContext: entry.requiredReferences,
    kind: entry.kind === "query" ? "read" : entry.kind === "action" ? "mutation" : entry.kind,
    classification: entry.kind === "query" ? "READ" : entry.kind === "action" ? "MUTATION" : "CONTROL",
    modelCallable: entry.modelProposable, agentProduct: entry.modelProposable && entry.available,
    humanOnly, authorityClass: humanOnly ? "human_attestation" : entry.authorityRequirement,
    effectClass: entry.effectClass, method: null, routePattern: null, routeDepth: 0,
  }
  for (const [field, value] of Object.entries(fields))
    if (!isDeepStrictEqual(row[field], value)) throw new Error(`Canonical planner metadata differs: ${entry.capability}.${field}`)
}
const source = new Map()
const entries = walk("src/app/centropy").filter((file) => /\/(page|layout)\.tsx$/.test(file))
function visit(file) {
  if (source.has(file) || !existsSync(join(root, file))) return
  const text = read(file)
  source.set(file, text)
  for (const match of text.matchAll(/\b(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
    const spec = match[1]
    const path = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? relative(root, resolve(root, dirname(file), spec)) : null
    if (!path) continue
    const resolved = [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`].find((candidate) => existsSync(join(root, candidate)) && !readdirIsDirectory(candidate))
    if (resolved && /\.(ts|tsx|json|css)$/.test(resolved)) visit(resolved)
  }
}
function readdirIsDirectory(file) { try { readFileSync(join(root, file)); return false } catch { return true } }
entries.forEach(visit)
const calls = []
const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
const program = ts.createProgram([...source.keys()].filter(file => /\.tsx?$/.test(file)).map(file => join(root, file)), options)
const checker = program.getTypeChecker()
const canonicalApi = join(root, "src/components/centropy/lib/api.ts")
const symbolFor = (node) => {
  const symbol = checker.getSymbolAtLocation(node)
  return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}
const methodFor = (node) => {
  const symbol = symbolFor(node)
  if (!symbol?.declarations?.some(declaration => declaration.getSourceFile().fileName === canonicalApi)) return null
  const match = /^centropy(Get|Post|Put|Delete|Patch|Download)$/.exec(symbol.name)
  return match ? match[1] === "Download" ? "GET" : match[1].toUpperCase() : null
}
function finiteStrings(node) {
  const type = checker.getTypeAtLocation(node)
  const members = type.isUnion() ? type.types : [type]
  const relevant = members.filter(member => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)))
  return relevant.length && relevant.every(member => member.isStringLiteral())
    ? [...new Set(relevant.map(member => member.value))] : null
}
function combine(left, right) {
  if (left.length * right.length > 128) throw new Error("Frontend route alternatives exceed the finite audit bound")
  return [...new Set(left.flatMap(a => right.map(b => a + b)))]
}
function routeValues(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return routeValues(node.expression)
  if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((values, span) =>
    combine(values, routeValues(span.expression).map(value => value + span.literal.text)), [node.head.text])
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return combine(routeValues(node.left), routeValues(node.right))
  return finiteStrings(node) ?? [":ref"]
}
const trees = [...source.keys()].filter(file => /\.tsx?$/.test(file)).map(file => program.getSourceFile(join(root, file)))
const calledSymbols = new Set()
function indexCalls(node) {
  if (ts.isCallExpression(node)) {
    const symbol = symbolFor(node.expression)
    if (symbol) calledSymbols.add(symbol)
  }
  ts.forEachChild(node, indexCalls)
}
trees.forEach(indexCalls)
const unusedHelpers = new Set()
for (const tree of trees) {
  const file = relative(root, tree.fileName)
  const collect = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && /^[a-z]/.test(node.name.text) &&
      node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && !calledSymbols.has(symbolFor(node.name))) {
      unusedHelpers.add(`${file}:${node.name.text}`)
      return
    }
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0], method = methodFor(node.expression)
      if (first && method) for (const route of routeValues(first)) calls.push({ file, route: route.split("?")[0], method,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, binding: "Canonical API import and finite TypeScript expression; source evidence only" })
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch" && first) {
        const options = node.arguments[1]
        const methodProperty = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === "method") : null
        const method = methodProperty && ts.isStringLiteral(methodProperty.initializer) ? methodProperty.initializer.text : null
        if (method && /^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) for (const route of routeValues(first)) {
          if (!route.startsWith("/api/")) continue
          if (!route.startsWith("/api/centropy/")) throw new Error(`Mounted native fetch bypasses the product proxy: ${file} ${route}`)
          calls.push({ file, route: route.slice(14).split("?")[0], method,
            line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
            binding: "Native product proxy fetch with explicit HTTP method; source evidence only" })
        }
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)
}
const matchesRoute = (pattern, route) => {
  const left = pattern.split("/"), right = route.split("/")
  const segmentMatches = (part, value) => {
    // Only the catalogue side is a pattern. A dynamic frontend expression
    // cannot prove that it names every concrete operation in a family.
    if (value.includes(":")) return part.startsWith(":")
    const expression = part.split(/:[A-Za-z]+/).map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")
    return new RegExp(`^${expression}$`).test(value)
  }
  return left.length === right.length && left.every((part, index) => segmentMatches(part, right[index]))
}
// Dynamic reads must be registered in a reached, explicit GET-only control.
// A family renderer reference alone is never enough to prove reachability.
const supportingFile = "src/components/centropy/controls/SupportingReadDesk.tsx"
const supportingCatalog = "src/lib/centropy/supporting-reads.ts"
if (source.has(supportingFile) && source.has(supportingCatalog)) {
  for (const match of read(supportingCatalog).matchAll(/routePattern:\s*"([^"]+)"/g)) {
    const route = match[1]
    if (!manifest.capabilities.some((entry) => entry.transport === "http" && entry.method === "GET" && entry.routePattern === route)) throw new Error(`Supporting read is absent from the canonical manifest: ${route}`)
    const line = read(supportingFile).slice(0, read(supportingFile).indexOf("await centropyGet")).split("\n").length
    calls.push({ file: supportingFile, route, method: "GET", line, registrationSource: supportingCatalog, binding: "Explicit GET-only selector; actual required identifiers and query fields" })
  }
}
const streamFile = "src/components/centropy/runtime/instruction-events.ts"
if (source.get(streamFile)?.includes('fetch(`/api/centropy/stream?instructionId=')) calls.push({ file: streamFile, route: "stream", method: "GET", line: 120, binding: "Native authenticated fetch/SSE transport" })
const compatibility = new Map([
  ["workspace-config", "The retained P8 workspace configuration is outside the active Investigation navigation; it must not restore the retired primary four-surface UI."],
  ["push-subscriptions", "Retained device transport. No active subscription sender/dispatcher is certified in CENTROPY."],
  ["activity", "Retained aggregate activity read. The active product reads semantic-activity and declared causal replay."],
  ["insights", "Retained aggregate read. No active CENTROPY consumer is claimed."],
  ["operational-deltas", "Retained transport/read projection; active product updates through canonical invalidation and reads."],
  ["read-models/activity-snapshot", "Retained compatibility projection; active product uses semantic activity and causal replay."],
  ["read-models/work-cases", "Retained compatibility projection; active product uses exact Work and Outcome Pack aggregates."],
  ["objectives", "Alternate canonical Objective intake API. CENTROPY starts the same Objective owner through actions intake, preserving its employee Thread and client instruction ID."],
  ["queries", "Alternate canonical read intake API. CENTROPY submits ordinary questions through actions intake and renders the canonical query answer in the employee Thread."],
  ["economic-outcomes", "Native S7 economic outcome owner API; no direct CENTROPY control or executed economic qualification is claimed."],
  ["experiments", "Native S2 experiment owner API; the active Work review uses identification plans rather than a generic experiment control."],
  ["interventions", "Native S3 intervention owner API; generic model mutation is not an active CENTROPY control."],
  ["identification-plans/read", "Native R4 artifact read API. The active Work panel reads the authorized work aggregate instead."],
  ["identification-plans/status", "Native R4 run status API. The active Work panel reads the authorized work aggregate instead."],
  ["identification-plans/register", "Native R4 input registration API. The active Work panel submits existing owner-resolved inputs and does not register arbitrary models."],
  ["decision-atlases/status", "Native R7 status alias. The active Work panel rereads the authenticated build through decision-atlases/read."],
  ["decision-atlases/continue", "Native R7 original-policy continuation API. Authenticated owner execution is checked separately; no direct CENTROPY continuation control is claimed."],
])
const humanRoutes = {
  configure_ic_committee: "private-equity/ic/committee-configurations",
  record_ic_vote: "private-equity/ic/cases/:id/votes", cast_ic_vote: "private-equity/ic/cases/:id/votes",
  record_ic_dissent: "private-equity/ic/cases/:id/dissents",
  waive_ic_question: "private-equity/ic/cases/:id/questions/:questionId/waive",
  waive_ic_condition: "private-equity/ic/cases/:id/conditions/:conditionId/waive",
  open_ic_voting: "private-equity/ic/cases/:id/voting/open", close_ic_voting: "private-equity/ic/cases/:id/voting/close",
  finalize_ic_decision: "private-equity/ic/cases/:id/finalize",
  waive_closing_condition: "actions/human", verify_closing_item: "actions/human",
}
const familyRenderers = {
  connection: ["src/components/centropy/controls/SettingsDialog.tsx", "src/components/centropy/canvas/SourceDiagnostics.tsx"],
  m365: ["src/components/centropy/canvas/SourceDiagnostics.tsx", "src/components/centropy/controls/SettingsDialog.tsx"],
  "outcome-pack": ["src/components/centropy/thread/OutcomePacks.tsx", "src/components/centropy/thread/ObjectiveControl.tsx", "src/components/centropy/controls/SettingsDialog.tsx"],
  preference: ["src/components/centropy/controls/SettingsDialog.tsx", "src/components/centropy/shell/CentropyWorkspace.tsx"],
  action: ["src/components/centropy/thread/PendingEffects.tsx", "src/components/centropy/world/WorldWorkRecord.tsx"],
  artifact: ["src/components/centropy/canvas/ArtifactCanvas.tsx", "src/components/centropy/canvas/ArtifactTemplateDesk.tsx"],
  computer: ["src/components/centropy/world/WorldWorkRecord.tsx"], correction: ["src/components/centropy/world/WorldWorkRecord.tsx"],
  underwriting: ["src/components/centropy/canvas/UnderwritingScenarioLab.tsx", "src/components/centropy/canvas/UnderwritingSensitivityLab.tsx", "src/components/centropy/canvas/CanvasDocument.tsx"],
  instruction: ["src/components/centropy/runtime/instruction-events.ts", "src/components/centropy/thread/ExecutionObject.tsx"],
  ic: ["src/components/centropy/canvas/IcVoteControl.tsx", "src/components/centropy/controls/IcHumanControls.tsx", "src/components/centropy/canvas/CanvasDocument.tsx"],
  receipt: ["src/components/centropy/world/WorldWorkRecord.tsx", "src/components/centropy/canvas/CausalReplayPanel.tsx"],
  stream: ["src/components/centropy/runtime/instruction-events.ts"],
  thread: ["src/components/centropy/thread/thread-api.ts", "src/components/centropy/shell/CentropyWorkspace.tsx"],
  "canvas-preference": ["src/components/centropy/canvas/use-canvas-preferences.ts"],
  workflow: ["src/components/centropy/controls/WorkflowRecoveryDesk.tsx", "src/components/centropy/world/WorldWorkRecord.tsx"],
  workforce: ["src/components/centropy/thread/WorkforceAssignments.tsx", "src/components/centropy/controls/SettingsDialog.tsx"],
  work: ["src/components/centropy/world/WorldWorkRecord.tsx", "src/components/centropy/canvas/CanvasDocument.tsx"],
  "company-brain": ["src/components/centropy/world/WorldExplorer.tsx"], objective: ["src/components/centropy/thread/ObjectiveControl.tsx"],
  "digital-twin": ["src/components/centropy/world/WorldExplorer.tsx", "src/components/centropy/controls/HumanControlDesk.tsx"],
  query: ["src/components/centropy/shell/CentropyWorkspace.tsx"], reconciliation: ["src/components/centropy/world/WorldWorkRecord.tsx"],
  "semantic-activity": ["src/components/centropy/canvas/CausalReplayPanel.tsx"],
  "operating-profile": ["src/components/centropy/controls/SettingsDialog.tsx"],
}
const tests = walk("e2e").filter((path) => path.endsWith(".spec.ts")).concat(walk("finnor-os/tests/integration").filter((path) => path.endsWith(".test.ts")))
const testSources = tests.map((path) => [path, read(path)])
const unclassified = []
const unmounted = []
const dynamicFrontendCalls = calls.filter((call) => call.route.includes(":"))
const registeredDynamicCalls = dynamicFrontendCalls.filter(call => call.route === ":ref" && (
  call.file === "src/components/centropy/controls/CanonicalRecordForm.tsx" && forms.some(form => form.method === call.method) ||
  call.file === supportingFile && call.method === "GET" && source.has(supportingCatalog)))
const unresolvedDynamicCalls = dynamicFrontendCalls.filter((call) => !registeredDynamicCalls.includes(call) && !manifest.capabilities.some((capability) =>
  capability.transport === "http" && capability.userProduct && capability.method === call.method &&
  matchesRoute(capability.routePattern, call.route)))
const deniedLiteralCalls = calls.filter((call) => !call.route.includes(":") &&
  !manifest.capabilities.some((capability) => capability.transport === "http" && capability.userProduct &&
    capability.method === call.method && matchesRoute(capability.routePattern, call.route)))
if (deniedLiteralCalls.length) throw new Error(`Mounted frontend calls denied by the product route catalogue: ${JSON.stringify(deniedLiteralCalls)}`)
const capabilities = manifest.capabilities.map((capability) => {
  const c = capability
  const direct = c.transport === "http" ? calls.filter((call) => call.method === c.method && matchesRoute(c.routePattern, call.route)) : []
  const humanForms = forms.filter((form) => form.capabilityId === c.capabilityId)
  const name = c.capabilityId.replace(/^planner\./, "")
  const retained = c.transport === "http" ? [...compatibility].find(([prefix]) => c.routePattern === prefix || c.routePattern.startsWith(`${prefix}/`)) : null
  const callback = c.transport === "http" && c.routePattern.endsWith("/callback")
  let disposition
  if (c.adminOnly || c.systemOnly) disposition = "RESTRICTED_SYSTEM_OR_ADMIN"
  else if (retained) disposition = ["objectives", "queries"].includes(c.routePattern) ? "INTENTIONAL_ALTERNATE_CANONICAL_INTAKE" : "INTENTIONAL_COMPATIBILITY"
  else if (callback) disposition = "PROVIDER_PROTOCOL_CALLBACK"
  else if (c.transport === "planner") disposition = c.humanOnly ? "HUMAN_ONLY_CANONICAL_DECISION" :
    !c.planning.available || c.planning.health === "unavailable" ? "UNAVAILABLE_CANONICAL_CAPABILITY" :
      !c.planning.modelProposable ? "NATIVE_NON_MODEL_PROPOSABLE_CAPABILITY" :
        c.planning.kind === "wait" || c.planning.kind === "check" ? "CANONICAL_RUNTIME_CONTROL" : "CANONICAL_AGENT_CAPABILITY"
  else if (direct.length) disposition = "ACTIVE_DIRECT_FRONTEND_PATH"
  else if (humanForms.length) disposition = "ACTIVE_TYPED_HUMAN_CONTROL"
  else { unmounted.push(c.capabilityId); disposition = "BACKEND_API_NO_MOUNTED_FRONTEND" }
  const humanRoute = c.transport === "planner" && c.humanOnly ? humanRoutes[name] : null
  if (c.transport === "planner" && c.humanOnly && !humanRoute) throw new Error(`Human-only capability lacks an explicit canonical human route: ${name}`)
  const renderers = (familyRenderers[c.family] ?? (c.transport === "planner" ? ["src/components/centropy/thread/RecordedValue.tsx", "src/components/centropy/thread/PendingEffects.tsx", "src/components/centropy/world/WorldWorkRecord.tsx"] : direct.map((call) => call.file))).filter((file) => source.has(file))
  const needles = c.transport === "planner" ? [name.replace(/^query:/, "")] : [c.routePattern, `/api/${c.routePattern.replaceAll(/:[A-Za-z]+/g, "")}`]
  const registeredTests = testSources.filter(([, text]) => needles.some((needle) => needle.length > 4 && text.includes(needle))).map(([path]) => path)
  return {
    ...c, disposition, actualRouteOrTool: c.transport === "http" ? `${c.method} /api/${c.routePattern}` : name,
    frontendSourceBindings: direct, humanForms: humanForms.map((form) => ({ id: form.id, group: form.group, generatedFrom: form.generatedFrom })), humanRoute,
    agentPath: c.transport === "planner" ? { registry: c.source, modelCallable: c.modelCallable,
      available: c.planning.available, health: c.planning.health, kind: c.planning.kind,
      executor: c.humanOnly ? "human initiation only; model planner rejects this capability" :
        !c.planning.available || c.planning.health === "unavailable" ? "unavailable in canonical registry; no agent execution claimed" :
          !c.planning.modelProposable ? "native owner only; not model-proposable" :
            c.planning.kind === "query" ? "canonical operational-query executor" :
              c.planning.kind === "wait" ? "canonical objective event wait" :
                c.planning.kind === "check" ? "canonical objective success check" : "canonical plugin/Core action executor" } : null,
    authorityPath: { class: c.authorityClass, backendSource: c.source, frontendNeverAuthorizes: true }, verificationPath: { class: c.verificationClass, backendSource: c.source },
    presentation: { targets: c.presentationTargets, familyRendererSources: renderers, directRuntimeExecutionProvenByThisReport: false },
    tests: registeredTests, testEvidenceState: "SOURCE_REFERENCES_ONLY; executed proofs are indexed separately",
    compatibilityReason: retained?.[1] ?? null,
    externalConfiguration: c.family === "m365" || c.family === "connection" || /artifact\/(publish|publish-new|publications|provider-creations)/.test(c.routePattern ?? "") ? "Provider credentials/scopes/destination and independent provider readback required; M365 publication BLOCKED_EXTERNAL" : null,
  }
})
if (unclassified.length) throw new Error(`Unclassified capabilities: ${unclassified.join(", ")}`)
const counts = Object.fromEntries([...new Set(capabilities.map((c) => c.disposition))].map((key) => [key, capabilities.filter((c) => c.disposition === key).length]))
const proofFiles = walk("docs/centropy/evidence").filter((file) => /release-candidate-/.test(file) && /(proof|summary)\.json$/.test(file)).map((file) => {
  const bytes = read(file), proof = JSON.parse(bytes)
  return { file, sha256: digest(bytes), result: proof.result ?? proof.status ?? null, capturedAt: proof.capturedAt ?? proof.verifiedAt ?? null, note: "Consult this proof's scope and limitations. A family proof does not certify every capability." }
})
const document = {
  canonicalPlanner: {
    source: "finnor-os/packages/orchestration/src/plugin-registry.ts",
    verticalKey: canonicalPlanner.verticalKey, count: canonicalPlanner.entries.length,
    entriesSha256: digest(JSON.stringify(canonicalPlanner.entries)), fullMetadataMatched: true,
    scope: "Credential-free registration metadata; not tenant authority, executed owner coverage or public HTTP admission",
  },
  schema: "centropy.capability-coverage-audit/v1", generatedAt: new Date().toISOString(), sourceBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), manifestSha256: digest(read(manifestPath)), formsSha256: digest(read(formPath)), method: "Actual API catalogue and independently re-enumerated canonical planner metadata; import graph from active CENTROPY route entries; literal API call bindings; typed human form registrations; explicit restricted/compatibility/protocol classifications. Source presence is not execution evidence.", counts: { total: capabilities.length, http: capabilities.filter((c) => c.transport === "http").length, planner: capabilities.filter((c) => c.transport === "planner").length, classified: capabilities.length, classificationCoveragePercent: 100, unclassified: 0, backendApiWithoutMountedFrontend: unmounted.length, dynamicFrontendCalls: dynamicFrontendCalls.length, unresolvedDynamicCalls: unresolvedDynamicCalls.length, disposition: counts }, unclassifiedCapabilities: [], backendApiWithoutMountedFrontend: unmounted, dynamicFrontendCalls, registeredDynamicCalls, unresolvedDynamicCalls, unconfirmedExportedHelpers: [...unusedHelpers].sort(), frontendImportGraph: { entries, files: [...source.keys()].sort(), hashes: [...source].map(([file, text]) => ({ file, sha256: digest(text) })) }, capabilities, executedProofIndex: proofFiles, limitations: ["Classification coverage is not a claim of 100% executed capability coverage", "Backend API without mounted frontend is an unverified path, not a proven malfunction", "Dynamic frontend call expressions cannot certify any named operation without explicit finite bindings", "Registered dynamic form/read expressions are qualified by their separate canonical registries; uncalled exported helpers are not mounted evidence", "Import reachability is file-level; a matched call does not prove its enclosing function executes, conditional eligibility, or a rendered control", "Provider protocol callbacks and real external publication require configured provider systems", "Retained compatibility routes are explicitly outside the active primary product"] }
const output = "docs/centropy/capability-coverage.json"
if (process.argv.includes("--check")) {
  if (unresolvedDynamicCalls.length) throw new Error(`Mounted frontend operations lack finite route bindings: ${JSON.stringify(unresolvedDynamicCalls)}`)
  const existing = JSON.parse(read(output))
  const stable = (value) => JSON.stringify({ ...value, generatedAt: null, sourceBaseCommit: null })
  if (stable(existing) !== stable(document)) throw new Error("CENTROPY coverage audit is stale; run node scripts/centropy/audit-capability-coverage.mjs")
} else writeFileSync(join(root, output), JSON.stringify(document, null, 2) + "\n")
console.log(JSON.stringify({ output, counts: document.counts }))
