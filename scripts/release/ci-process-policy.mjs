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
  const operatingProfit = workflowJob(ci, "operating-profit")
  require(operatingProfit.length > 0 && !/^ {4}if:/m.test(operatingProfit)
    && operatingProfit.includes("python3 scripts/s4/run-local.py"),
    "S4 must execute the complete original owner and replay path unconditionally")
  require(operatingProfit.includes("ghcr.io/astral-sh/uv:0.10.9@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82")
    && operatingProfit.includes('python install 3.12.13')
    && operatingProfit.includes('venv --python 3.12.13')
    && operatingProfit.includes('pip sync --require-hashes --only-binary :all:')
    && operatingProfit.includes('scripts/r4/numerical-requirements.lock'),
    "S4 requires the pinned interpreter and complete hash-locked scientific runtime")
  require(operatingProfit.includes("assert sys.version.split()[0] == '3.12.13'")
    && operatingProfit.includes("('2.3.3', '1.16.2', '1.8.0')")
    && operatingProfit.includes('FINNOR_S3_PYTHON=$RUNNER_TEMP/s4-python/bin/python'),
    "S4 must verify the actual Python, NumPy, SciPy and HiGHS identity before owner execution")
  const pr = workflows["pr-verdict.yml"] ?? ""
  const production = workflows["production-release.yml"] ?? ""
  const projectZ = workflowJob(ci, "project-z-public")
  const projectZ4 = workflowJob(ci, "project-z-public-z4")
  const projectZAssets = workflowJob(ci, "project-z-native-assets")
  const projectZOwner = workflowJob(ci, "project-z-owner-smoke")
  require(projectZOwner.includes("node scripts/project-z/run-native-ci.mjs")
    && projectZOwner.length > 0 && !/^ {4}if:/m.test(projectZOwner)
    && !/AUTH_DEV_BYPASS/.test(projectZOwner),
    "Project Z real owner transport must be required, isolated and without auth bypass")
  require(projectZ.includes("node scripts/project-z/run-ci.mjs")
    && projectZ.includes("phase: [z1, z2, z3]") && projectZ.includes("fail-fast: false")
    && projectZ4.includes("node scripts/project-z/run-ci.mjs --phase=z4")
    && projectZ4.length > 0 && !/^ {4}if:/m.test(projectZ4),
    "Project Z must execute every declared independent public phase process")
  require(projectZAssets.includes("ci-native.py prepare") && projectZAssets.includes("if-no-files-found: error")
    && projectZAssets.includes("artifact_name: ${{ steps.identity.outputs.artifact_name }}")
    && !/^ {4}if:/m.test(projectZAssets), "Z4 test assets require a fail-closed locked build producer")
  for (const [name, job] of [["owner", projectZOwner], ["public Z4", projectZ4]]) {
    require(job.includes("needs: project-z-native-assets")
      && job.includes("needs.project-z-native-assets.outputs.artifact_name")
      && job.includes("ci-native.py install") && job.includes('--expected-sha "$SOURCE_SHA"'),
      `${name}: native consumers must verify and install the successful producer artifact`)
  }
  for (const job of [projectZAssets, projectZOwner, projectZ4]) {
    require(job.includes("ref: ${{ github.event.pull_request.head.sha || github.sha }}"),
      "Native producer and consumers must use the same exact current source")
  }
  require(projectZ4.includes("ci-assets-e2e.mjs"), "Native artifact corruption controls must execute")
  require(projectZ.length > 0 && !/^ {4}if:/m.test(projectZ),
    "Project Z required backend/release check must not be optional")
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
  require(source.includes("npm run build:inputs:check || status=1"), "source gate must verify generated build stamps and replay custody before image work")
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

  // Display names explain purpose; stable protection and receipt identities remain.
  const stableNames = new Set(["required-pr-verdict", "w2-pair-verdict",
    "notify-ci-completion", "post-merge-certification",
    "original-owner (${{ matrix.mode }})"])
  for (const [file, text] of Object.entries(workflows)) {
    const title = text.match(/^name:\s*(.+)$/m)?.[1] ?? ""
    require(/[A-Za-z].*\s+[A-Za-z]/.test(title),
      file + ": workflow title must explain its purpose in plain language")
    const jobs = text.slice(text.indexOf("\njobs:") + 1)
    for (const [, id] of jobs.matchAll(/^  ([\w-]+):\n/gm)) {
      const name = workflowJob(text, id).match(/^    name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? ""
      require(stableNames.has(name) || /[A-Za-z].*\s+[A-Za-z]/.test(name),
        file + "/" + id + ": add a descriptive job display name")
    }
  }
  const w1Episode = workflows["w1-owning-episode.yml"] ?? ""
  require(w1Episode.includes("name: Retain a finite W1 outcome")
    && w1Episode.includes('schema: "finnor.w1.finite-outcome.v1"')
    && w1Episode.includes("OWNER_NOT_STARTED_OR_RECEIPT_MISSING")
    && w1Episode.includes("terminal-summary.json")
    && w1Episode.includes("console.log(JSON.stringify(summary))"),
    "W1 failures require a privacy-safe finite outcome with exact mode and case identities")
  const w3Episode = workflows["w3-owning-episode.yml"] ?? ""
  require(w3Episode.includes("node --max-old-space-size=3072 finnor-os/node_modules/typescript/bin/tsc -p finnor-os/scripts/postz/w3/tsconfig.json"),
    "W3 complete owner compilation requires the bounded 3 GiB heap qualified for this source graph")
  require(w3Episode.includes("name: Retain a finite W3 outcome")
    && w3Episode.includes('schema: "finnor.w3.finite-outcome.v1"')
    && w3Episode.includes("OWNER_NOT_STARTED_OR_RESULT_MISSING")
    && w3Episode.includes("terminal-summary.json")
    && w3Episode.includes("console.log(JSON.stringify(summary))")
    && !w3Episode.includes("console.log(JSON.stringify(terminal))"),
    "W3 failures require a privacy-safe finite outcome without printing retained private diagnostics")

  for (const [file, label, required] of [
    ["w1-owning-verification.yml", "W1 result - economic orchestration and recovery",
      "needs: [source-checks, native-positive, owning-regressions]"],
    ["w3-owning-verification.yml", "W3 result - fulfillment and publication",
      "needs: [fast-owner, full-positive-and-publication, cold-installed-and-mounted]"],
  ]) {
    const text = workflows[file] ?? ""
    require(text.split("\njobs:")[0].includes("codex/zw-integration-quality-20261115"),
      file + ": existing owner verification must run on the integration branch")
    const terminal = workflowJob(text, "verdict")
    require(terminal.includes(required) && terminal.includes("if: ${{ always() }}")
      && terminal.includes('Object.values(results).every(result => result === "success")'),
      file + ": all original owner and adverse checks require a fail-closed terminal result")
    const report = workflowJob(text, "completion-receipt")
    require(report.includes("needs: verdict")
      && report.includes("uses: ./.github/workflows/ci-completion.yml")
      && report.includes('gate: "' + label + '"')
      && report.includes("result: ${{ needs.verdict.result }}"),
      file + ": completed results must use the existing source-bound receipt")
    require((workflows["ci-completion.yml"] ?? "").includes('"' + label + '"'),
      file + ": reporter must accept the declared result identity")
  }

  for (const [file, control, positive, episode] of [
    ["w2-atomic-settlement-verification.yml", "controls", "exact", "w2-compensation-episode.yml"],
    ["w3-owning-verification.yml", "full-positive-and-publication", "fast-owner", "w3-owning-episode.yml"],
    ["phase-w-verification.yml", "w2-compensation-controls", "w2-compensation-positive", "w2-compensation-episode.yml"],
    ["phase-w-verification.yml", "w3-native-and-publication", "w3-fast-owner", "w3-owning-episode.yml"],
  ]) {
    const text = workflows[file] ?? ""
    const original = workflowJob(text, positive)
    const matrix = workflowJob(text, control)
    const use = "uses: ./.github/workflows/" + episode
    require(original.includes(use) && !original.includes("checked_source_sha:")
      && matrix.includes(use) && matrix.includes("needs: " + positive + "\n")
      && matrix.includes("checked_source_sha: ${{ needs." + positive + ".outputs.checked_source_sha }}"),
      file + "/" + control + ": preflight reuse requires the successful same-source positive job")
  }

  return { workflows: Object.keys(workflows).sort(), failures }
}
