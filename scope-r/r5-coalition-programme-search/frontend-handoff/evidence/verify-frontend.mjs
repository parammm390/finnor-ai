import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const evidence = dirname(fileURLToPath(import.meta.url))
const root = resolve(evidence, "../../../..")
const backend = "/Users/paramdave/.factory/worktrees/r-programme-completion-2026-10-11/FINNOR"
const dependencies = join(backend, "node_modules")
const require = createRequire(join(dependencies, "typescript/package.json"))
const ts = require("./lib/typescript.js")
const sources = [
  "src/components/centropy/canvas/CoalitionProgrammeReview.tsx",
  "src/components/centropy/canvas/coalition-programme-view.ts",
]
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const started = performance.now()
const results = {
  schema: "finnor.r5.frontend-static-evidence.v1",
  qualification: "STATIC_SOURCE_ONLY_NOT_MOUNTED_OR_INSTALLED_BUILD",
  root,
  backend,
  sourcePins: sources.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
  dependencyVersions: Object.fromEntries(["next", "react", "zod", "typescript", "eslint"].map(name =>
    [name, JSON.parse(readFileSync(join(dependencies, name, "package.json"))).version])),
  lockSha256: sha256(readFileSync(join(root, "package-lock.json"))),
  commands: [],
  mounted: "NOT RUN",
}
if (results.lockSha256 !== sha256(readFileSync(join(backend, "package-lock.json"))))
  throw Error("Read-only dependency lock differs from the owned base")

function run(id, executable, args) {
  if (performance.now() - started > 600000) throw Error("Registered campaign wall limit exceeded")
  const before = performance.now()
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024 })
  const row = { id, command: [executable, ...args], exitCode: result.status, signal: result.signal,
    elapsedMs: performance.now() - before, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    error: result.error?.message ?? null }
  results.commands.push(row)
  console.log(`${id}: ${row.exitCode === 0 ? "PASS" : "FAIL"}`)
  return row.exitCode === 0
}

let passed = run("TYPECHECK", process.execPath, [
  "--max-old-space-size=768", join(dependencies, "typescript/bin/tsc"),
  "--project", join(evidence, "tsconfig.frontend.json"), "--pretty", "false",
])
passed = run("LINT", process.execPath, [
  "--max-old-space-size=768", join(dependencies, "eslint/bin/eslint.js"),
  "--config", join(backend, "eslint.config.mjs"), ...sources,
]) && passed

const transpile = sources.map(path => {
  const source = ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.ESNext, true)
  const imports = source.statements.flatMap(statement =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
  const diagnostics = ts.transpileModule(source.text, { fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true } }).diagnostics ?? []
  return { path, imports, diagnostics: diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    frontendOnly: imports.every(name => !/^(node:|@finnor\/)/.test(name) && !name.includes("finnor-os")) }
})
results.clientTranspile = transpile
passed = transpile.every(row => row.frontendOnly && row.diagnostics.length === 0) && passed
passed = run("DIFF_CHECK", "git", ["-C", root, "diff", "--check"]) && passed
results.elapsedMs = performance.now() - started
results.staticChecksPassed = passed
writeFileSync(join(evidence, "static-checks.json"), JSON.stringify(results, null, 2) + "\n")
process.exitCode = passed ? 0 : 1
