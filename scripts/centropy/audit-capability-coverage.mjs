import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"

const root = resolve(import.meta.dirname, "../..")
const ts = createRequire(join(root, "package.json"))("typescript")
const read = (path) => readFileSync(join(root, path), "utf8")
const digest = (value) => createHash("sha256").update(value).digest("hex")
const walk = (directory) => readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`])
const manifestPath = "src/lib/centropy/capability-manifest.generated.json"
const formPath = "src/lib/centropy/human-forms.generated.json"
const manifest = JSON.parse(read(manifestPath))
const forms = JSON.parse(read(formPath)).forms
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
for (const [file, text] of source) {
  if (!/\.(ts|tsx)$/.test(file)) continue
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const collect = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const match = /^centropy(Get|Post|Put|Delete|Patch|Download)$/.exec(node.expression.text)
      const first = node.arguments[0]
      if (match && first) {
        const route = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : ts.isTemplateExpression(first) ? first.head.text + first.templateSpans.map((span) => ":ref" + span.literal.text).join("") : null
        if (route) calls.push({ file, route: route.split("?")[0], method: match[1] === "Download" ? "GET" : match[1].toUpperCase(), line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)
}
const matchesRoute = (pattern, route) => {
  const left = pattern.split("/"), right = route.split("/")
  return left.length === right.length && left.every((part, index) => part.startsWith(":") || right[index]?.startsWith(":") || part === right[index])
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
  else if (c.transport === "planner") disposition = c.humanOnly ? "HUMAN_ONLY_CANONICAL_DECISION" : "CANONICAL_AGENT_CAPABILITY"
  else if (direct.length) disposition = "ACTIVE_DIRECT_FRONTEND_PATH"
  else if (humanForms.length) disposition = "ACTIVE_TYPED_HUMAN_CONTROL"
  else throw new Error(`Unclassified capability: ${c.capabilityId}`)
  const humanRoute = c.transport === "planner" && c.humanOnly ? humanRoutes[name] : null
  if (c.transport === "planner" && c.humanOnly && !humanRoute) throw new Error(`Human-only capability lacks an explicit canonical human route: ${name}`)
  const renderers = (familyRenderers[c.family] ?? (c.transport === "planner" ? ["src/components/centropy/thread/RecordedValue.tsx", "src/components/centropy/thread/PendingEffects.tsx", "src/components/centropy/world/WorldWorkRecord.tsx"] : direct.map((call) => call.file))).filter((file) => source.has(file))
  const needles = c.transport === "planner" ? [name.replace(/^query:/, "")] : [c.routePattern, `/api/${c.routePattern.replaceAll(/:[A-Za-z]+/g, "")}`]
  const registeredTests = testSources.filter(([, text]) => needles.some((needle) => needle.length > 4 && text.includes(needle))).map(([path]) => path)
  return {
    ...c, disposition, actualRouteOrTool: c.transport === "http" ? `${c.method} /api/${c.routePattern}` : name,
    frontendSourceBindings: direct, humanForms: humanForms.map((form) => ({ id: form.id, group: form.group, generatedFrom: form.generatedFrom })), humanRoute,
    agentPath: c.transport === "planner" ? { registry: c.source, modelCallable: c.modelCallable, executor: name.startsWith("query:") ? "canonical operational-query executor" : c.humanOnly ? "human initiation only; model planner rejects this capability" : "canonical plugin/Core action executor" } : null,
    authorityPath: { class: c.authorityClass, backendSource: c.source, frontendNeverAuthorizes: true }, verificationPath: { class: c.verificationClass, backendSource: c.source },
    presentation: { targets: c.presentationTargets, familyRendererSources: renderers, directRuntimeExecutionProvenByThisReport: false },
    tests: registeredTests, testEvidenceState: "SOURCE_REFERENCES_ONLY; executed proofs are indexed separately",
    compatibilityReason: retained?.[1] ?? null,
    externalConfiguration: c.family === "m365" || c.family === "connection" || /artifact\/(publish|publish-new|publications|provider-creations)/.test(c.routePattern ?? "") ? "Provider credentials/scopes/destination and independent provider readback required; M365 publication BLOCKED_EXTERNAL" : null,
  }
})
const counts = Object.fromEntries([...new Set(capabilities.map((c) => c.disposition))].map((key) => [key, capabilities.filter((c) => c.disposition === key).length]))
const proofFiles = walk("docs/centropy/evidence").filter((file) => /release-candidate-/.test(file) && /(proof|summary)\.json$/.test(file)).map((file) => {
  const bytes = read(file), proof = JSON.parse(bytes)
  return { file, sha256: digest(bytes), result: proof.result ?? proof.status ?? null, capturedAt: proof.capturedAt ?? proof.verifiedAt ?? null, note: "Consult this proof's scope and limitations. A family proof does not certify every capability." }
})
const document = { schema: "centropy.capability-coverage-audit/v1", generatedAt: new Date().toISOString(), sourceBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), manifestSha256: digest(read(manifestPath)), formsSha256: digest(read(formPath)), method: "Actual API/planner manifest; import graph from active CENTROPY route entries; literal API call bindings; typed human form registrations; explicit restricted/compatibility/protocol classifications. Source presence is not execution evidence.", counts: { total: capabilities.length, http: capabilities.filter((c) => c.transport === "http").length, planner: capabilities.filter((c) => c.transport === "planner").length, classified: capabilities.length, classificationCoveragePercent: 100, unclassified: 0, disposition: counts }, unclassifiedCapabilities: [], frontendImportGraph: { entries, files: [...source.keys()].sort(), hashes: [...source].map(([file, text]) => ({ file, sha256: digest(text) })) }, capabilities, executedProofIndex: proofFiles, limitations: ["Classification coverage is not a claim of 100% executed capability coverage", "Literal source matching is supplemented by typed controls and explicit owning renderer references; it does not infer conditional eligibility", "Provider protocol callbacks and real external publication require configured provider systems", "Retained compatibility routes are explicitly outside the active primary product"] }
const output = "docs/centropy/capability-coverage.json"
writeFileSync(join(root, output), JSON.stringify(document, null, 2) + "\n")
console.log(JSON.stringify({ output, counts: document.counts }))
