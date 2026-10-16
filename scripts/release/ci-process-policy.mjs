import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

export function ownerExportPath(packageRoot, target) {
  if (typeof target !== "string" || !target.startsWith("./") || target.includes("\\")) throw new Error("Owner exports require a package-relative target")
  const owner = realpathSync(packageRoot)
  const inside = path => {
    const rel = relative(owner, path)
    return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
  }
  const lexical = resolve(owner, target)
  if (!inside(lexical)) throw new Error("Owner export escapes its package")
  const physical = realpathSync(lexical)
  if (!inside(physical)) throw new Error("Owner export symlink escapes its package")
  return physical
}

export function sourceCheckFailures({ backend, root, outcomes }) {
  const required = ["workspace", "types", "inventory", "drift", ...(backend ? ["shards", "backend"] : []), ...(root ? ["lint"] : [])]
  return required.filter(name => outcomes[name] !== "success")
}

export function workflowJob(text, name) {
  return text.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|(?![\\s\\S]))`, "m"))?.[1] ?? ""
}

export function verifyCiProcess(root) {
  const directory = join(root, ".github/workflows")
  const workflows = Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [name, readFileSync(join(directory, name), "utf8")]))
  const failures = []
  const require = (condition, message) => { if (!condition) failures.push(message) }
  const ci = workflows["ci.yml"] ?? ""
  const pr = workflows["pr-verdict.yml"] ?? ""
  const production = workflows["production-release.yml"] ?? ""
  for (const file of ["ci.yml", "security.yml", "marketing-ci.yml", "source-checks.yml", "release-readiness.yml"]) {
    require(!/^  (?:push|pull_request):/m.test(workflows[file] ?? ""), `${file}: reusable checks must have one caller, not a duplicate Git trigger`)
  }
  for (const name of ["backend", "root", "replay", "readiness"]) {
    require(/needs: \[classify, source\]/.test(workflowJob(pr, name)), `${name}: expensive PR work must wait for source checks`)
  }
  const verdict = workflowJob(pr, "verdict")
  require(verdict.includes("always()") && /needs: \[classify, source, backend, root, security, replay, readiness\]/.test(verdict), "stable PR verdict must consume every applicable result, even after failure")
  require(workflowJob(pr, "readiness").includes("uses: ./.github/workflows/release-readiness.yml"), "production readiness must be rehearsed before merge")
  const readiness = workflows["release-readiness.yml"] ?? ""
  require(readiness.includes("release:scope4-digital-twin") && readiness.includes("release:scope5-epistemic-impact") && readiness.includes("rehearse-historical-upgrade.ts"), "shared readiness must retain both certifications and historical upgrades")
  const readinessWrapper = workflowJob(production, "readiness-release-gate")
  require(readinessWrapper.includes("uses: ./.github/workflows/release-readiness.yml") && readinessWrapper.includes("canonical_source: true") && !/^\s+gate:/m.test(readinessWrapper), "production must call the entire shared readiness path once for canonical main")
  const certificates = workflowJob(readiness, "phase5-readiness")
  require(certificates.includes("certification: [scope4, scope5]") && certificates.includes("fail-fast: false") && certificates.includes("${{ matrix.certification }}"), "independent readiness certifications must run in two complete, isolated matrix jobs")
  const sourceWorkflow = workflows["source-checks.yml"] ?? ""
  for (const name of ["source", "governance"]) {
    require(/needs: validate\b/.test(workflowJob(sourceWorkflow, name)), `${name}: workflow validation must precede parallel source/governance work`)
  }
  require(workflowJob(sourceWorkflow, "governance").includes("npm run test:release") && !workflowJob(sourceWorkflow, "source").includes("npm run test:release"), "governance fixtures must run once in parallel with source checks")
  const source = workflowJob(sourceWorkflow, "source")
  require(source.includes('import { sourceCheckFailures } from "./scripts/release/ci-process-policy.mjs"') && source.includes("const failures = sourceCheckFailures(") && source.includes("id: aggregate") && source.includes("if: ${{ always() }}"), "independent source diagnostics must end in a fail-closed aggregate")
  for (const name of ["shards", "workspace", "backend", "types", "inventory", "lint", "drift"]) {
    require(source.includes(`id: ${name}`) && source.includes(`steps.${name}.outcome`), `source aggregate must consume ${name} outcome`)
  }
  require(/name: required-pr-verdict\b/.test(verdict), "protected main requires the unchanged required-pr-verdict name")
  const tests = workflowJob(ci, "test")
  require(tests.includes("shard: [1, 2, 3]") && tests.includes("--shard=${{ matrix.shard }}/3") && tests.includes("fail-fast: false"), "backend must execute all three independent test shards")
  require(tests.includes("services:") && tests.includes("postgres:") && tests.includes("redis:"), "each backend shard must own its disposable database and Redis")
  require(!tests.includes("release:pe-p7-workforce-learning") && workflowJob(ci, "phase7").includes("release:pe-p7-workforce-learning"), "P7 certification must run once, outside the shard matrix")
  const certification = workflowJob(production, "post-merge-certification")
  const certificationNeeds = certification.match(/needs:\s*\[([^\]]+)\]/)?.[1].split(",").map(value => value.trim()) ?? []
  for (const name of ["source-release-gate", "backend-release-gate", "security-release-gate", "root-release-gate", "readiness-release-gate"]) {
    require(certificationNeeds.includes(name) && certification.includes(`needs.${name}.result`), `production certification must require ${name}`)
  }
  require(/cancel-in-progress: false/.test(production) && !/cancel-in-progress: true/.test(production), "production mutations must not be cancelled by a newer push")
  require(/needs: \[post-merge-certification\]/.test(workflowJob(production, "release")), "production authority must wait for merged-source certification")
  require(!/run-p8-production-water-retirement\.mjs|release:scope5:rollout/.test(production), "software release must leave separately protected effects off")
  require(!/^  pull_request:/m.test(workflows["dealer-zero-replay.yml"] ?? ""), "Dealer Zero PR replay must be called by the stable verdict")
  for (const [file, text] of Object.entries(workflows)) {
    for (const [, ref] of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)$/gm)) require(ref.startsWith("./.github/workflows/") || /@[0-9a-f]{40}$/i.test(ref), `${file}: mutable action ${ref}`)
  }
  return { workflows: Object.keys(workflows).sort(), failures }
}
