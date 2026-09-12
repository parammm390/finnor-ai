import { createRequire } from "node:module"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const osRoot = join(repoRoot, "finnor-os")
const allowlistPath = join(repoRoot, "scripts/release/p8-water-allowlist.json")
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"]
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path, predicate)
    return entry.isFile() && predicate(path) ? [path] : []
  })
}

function sourceFilesUnder(directory) {
  return walk(directory, (path) => sourceExtensions.includes(extname(path)) && !/\.(?:test|spec)\.[^.]+$/.test(path))
}

function relativePath(path) {
  return relative(repoRoot, path).replaceAll("\\", "/")
}

const packageDirectories = new Map()
for (const packageJson of walk(osRoot, (path) => path.endsWith("package.json"))) {
  const directory = dirname(packageJson)
  const manifest = JSON.parse(readFileSync(packageJson, "utf8"))
  if (typeof manifest.name === "string" && manifest.name.startsWith("@finnor/")) {
    packageDirectories.set(manifest.name, { directory, main: manifest.main || "src/index.ts" })
  }
}

function resolveCandidate(base) {
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => join(base, `index${extension}`)),
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null
}

function resolveImport(specifier, importer) {
  if (specifier.startsWith("@/")) return resolveCandidate(join(repoRoot, "src", specifier.slice(2)))
  if (specifier.startsWith(".")) return resolveCandidate(resolve(dirname(importer), specifier))
  if (!specifier.startsWith("@finnor/")) return null

  const parts = specifier.split("/")
  const packageName = parts.slice(0, 2).join("/")
  const registration = packageDirectories.get(packageName)
  if (!registration) return null
  const subpath = parts.slice(2).join("/")
  return resolveCandidate(subpath ? join(registration.directory, subpath) : join(registration.directory, registration.main))
}

function importsFor(path) {
  if (!codeExtensions.has(extname(path))) return []
  const source = readFileSync(path, "utf8")
  const imports = ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName)
  return imports.map((specifier) => resolveImport(specifier, path)).filter(Boolean)
}

function reachableFrom(entries) {
  const queue = [...new Set(entries.filter(Boolean))]
  const reachable = new Set()
  while (queue.length) {
    const path = queue.shift()
    if (!path || reachable.has(path)) continue
    reachable.add(path)
    for (const dependency of importsFor(path)) {
      if (!reachable.has(dependency)) queue.push(dependency)
    }
  }
  return reachable
}

const rootAppFiles = sourceFilesUnder(join(repoRoot, "src/app"))
const apiAppFiles = sourceFilesUnder(join(osRoot, "apps/api/app"))
const entryGroups = {
  jarvis: sourceFilesUnder(join(repoRoot, "src/app/jarvis")),
  planner: [
    join(osRoot, "packages/orchestration/src/planner.ts"),
    join(osRoot, "packages/orchestration/src/objective-loop.ts"),
    join(osRoot, "packages/orchestration/src/plugin-registry.ts"),
  ],
  orchestrator: [join(osRoot, "apps/orchestrator/src/index.ts")],
  worker: [join(osRoot, "apps/worker/src/index.ts"), join(osRoot, "apps/worker/src/sse-server.ts")],
  supplierCanary: [join(osRoot, "apps/supplier-canary/api/index.mjs")],
  demo: [
    join(repoRoot, "src/components/marketing/PrivateEquityPublicPage.tsx"),
    join(repoRoot, "src/components/ai-concierge/FinnorAIConcierge.tsx"),
  ],
  publicWebsite: [...rootAppFiles, join(repoRoot, "next.config.mjs")],
  productionApi: [...apiAppFiles, join(osRoot, "apps/api/middleware.ts")],
}
const reachableByGroup = Object.fromEntries(Object.entries(entryGroups).map(([name, entries]) => [name, reachableFrom(entries)]))
const allReachable = new Set(Object.values(reachableByGroup).flatMap((paths) => [...paths]))

const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"))
if (allowlist.schemaVersion !== 1 || !Array.isArray(allowlist.entries)) throw new Error("P8 Water allowlist schema is invalid")
const allowByPath = new Map()
for (const entry of allowlist.entries) {
  if (!entry || typeof entry.path !== "string" || entry.path.includes("*") || entry.path.startsWith("/")) {
    throw new Error("Every P8 Water allowlist entry needs one exact repository-relative path")
  }
  if (!['history', 'retirement', 'deny_guard', 'legacy_redirect'].includes(entry.category)) {
    throw new Error(`Invalid P8 Water allowlist category for ${entry.path}`)
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
    throw new Error(`P8 Water allowlist entry ${entry.path} needs an explicit reason`)
  }
  if (allowByPath.has(entry.path)) throw new Error(`Duplicate P8 Water allowlist entry: ${entry.path}`)
  allowByPath.set(entry.path, entry)
}

const doctrinePatterns = [
  ["water_vertical", /(?<!-)\bwater\b|water[_-]/i],
  ["field_service_persona", /\b(?:homeowner|household|technician)s?\b|\bservice[ _-]?visits?\b/i],
  ["retired_workflow", /\b(?:lead_to_water_test|invoice_to_cash|maintenance_agreement(?:_renewal)?|proposal_to_installation)\b/i],
  ["retired_query", /\b(?:customer_lookup|customer_cohort|schedule_range|money_summary|inventory_status|party_availability)\b/i],
  ["retired_action", /\b(?:schedule_water_test|assign_lead_to_technician|assign_technician_to_visit|size_equipment_for_household|call_overdue_invoices|answer_water_question)\b/i],
  ["field_dispatch", /(?:technician|field service|route|homeowner|household).{0,60}\bdispatch(?:er|ing)?\b|\bdispatch(?:er|ing)?\b.{0,60}(?:technician|field service|route|homeowner|household)/i],
]

const matchedAllowlist = new Set()
const violations = []
const matches = []
for (const path of [...allReachable].sort()) {
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].includes(extname(path))) continue
  const source = readFileSync(path, "utf8")
  const pathMatches = doctrinePatterns.filter(([, pattern]) => pattern.test(source)).map(([id]) => id)
  if (!pathMatches.length) continue
  const repoPath = relativePath(path)
  const allowed = allowByPath.get(repoPath)
  matches.push({ path: repoPath, patterns: pathMatches, category: allowed?.category || null })
  if (allowed) matchedAllowlist.add(repoPath)
  else violations.push(`${repoPath}: ${pathMatches.join(", ")}`)
}

for (const entry of allowlist.entries) {
  if (!matchedAllowlist.has(entry.path)) violations.push(`${entry.path}: unused allowlist entry`)
}

const retiredLedgerPath = join(osRoot, "packages/shared-types/src/retired-water.ts")
const retiredLedger = ts.createSourceFile(retiredLedgerPath, readFileSync(retiredLedgerPath, "utf8"), ts.ScriptTarget.Latest, true)
const retiredImplementationPaths = []
function visit(node) {
  const unwrap = (value) => ts.isAsExpression(value) || ts.isSatisfiesExpression?.(value) ? unwrap(value.expression) : value
  if (ts.isVariableDeclaration(node)
    && node.name.getText(retiredLedger) === "RETIRED_WATER_IMPLEMENTATION_PATHS"
    && node.initializer && ts.isArrayLiteralExpression(unwrap(node.initializer))) {
    for (const element of unwrap(node.initializer).elements) {
      if (ts.isStringLiteral(element)) retiredImplementationPaths.push(element.text)
    }
  }
  ts.forEachChild(node, visit)
}
visit(retiredLedger)
if (!retiredImplementationPaths.length) violations.push("retirement ledger: no implementation paths could be read")
for (const retiredPath of retiredImplementationPaths) {
  const absolute = join(osRoot, retiredPath)
  if (existsSync(absolute)) violations.push(`retired implementation still exists: finnor-os/${retiredPath}`)
  if ([...allReachable].some((path) => path === absolute || path.startsWith(`${absolute}/`))) {
    violations.push(`retired implementation is production-reachable: finnor-os/${retiredPath}`)
  }
}

const report = {
  ok: violations.length === 0,
  checks: {
    staticDoctrine: violations.filter((item) => !item.startsWith("retired implementation") && !item.startsWith("retirement ledger")).length === 0,
    importReachability: violations.filter((item) => item.startsWith("retired implementation") || item.startsWith("retirement ledger")).length === 0,
  },
  entrypoints: Object.fromEntries(Object.entries(entryGroups).map(([name, entries]) => [name, entries.length])),
  reachableModules: Object.fromEntries(Object.entries(reachableByGroup).map(([name, paths]) => [name, paths.size])),
  doctrineMatches: matches,
  allowlistEntries: allowlist.entries.length,
  retiredImplementationPaths: retiredImplementationPaths.length,
  violations,
}

console.log(JSON.stringify(report, null, 2))
if (violations.length) process.exit(1)
