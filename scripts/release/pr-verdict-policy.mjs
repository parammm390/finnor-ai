import { readGit } from "./worktree-state.mjs"

export function classifyPullRequestFiles(files) {
  return {
    backend: files.some((path) => path.startsWith("finnor-os/") || path.startsWith("scripts/release/") || path.startsWith("infra/") || path.startsWith(".github/workflows/") || /^(package(?:-lock)?\.json|JARVIS-CREDENTIALS-LEDGER\.md|\.gitleaks\.toml)$/.test(path)),
    root: files.some((path) => /^(src\/|public\/|e2e\/|vendor\/|scripts\/|package(?:-lock)?\.json$|next\.config|next-env\.d\.ts$|tsconfig|(?:playwright|vitest|eslint|postcss|tailwind)\.config|instrumentation(?:-client)?\.[cm]?[jt]s$|\.eslintrc)/.test(path) || path.startsWith(".github/workflows/")),
    dependencies: files.some((path) => /(^|\/)(package(?:-lock)?\.json|(?:[^/]+-)?requirements(?:[-_.][^/]+)?\.(?:txt|lock)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|Dockerfile(?:\.[^/]+)?)$/.test(path) || path.startsWith("vendor/")),
  }
}

export function encodeChangedFiles(files) {
  return Buffer.from(JSON.stringify(files), "utf8").toString("base64")
}

export function decodeChangedFiles(value) {
  if (!value) return []
  const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"))
  if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) throw new Error("changed-file evidence is invalid")
  return parsed
}

export function evaluateRequiredPrVerdict({ files, classifyResult, sourceResult, backendApplicable, backendResult, rootApplicable, rootResult, dependencyApplicable, securityResult, replayResult, readinessResult }) {
  const requiredOrNa = (applicable, result) => applicable
    ? { applicability: "REQUIRED", result }
    : { applicability: "N/A", result: "not_applicable" }
  const verdict = {
    schema: "finnor-pr-verdict.v1",
    changedFiles: files,
    gates: {
      classify: { applicability: "REQUIRED", result: classifyResult },
      source: requiredOrNa(backendApplicable || rootApplicable, sourceResult),
      backend: requiredOrNa(backendApplicable, backendResult),
      root: requiredOrNa(rootApplicable, rootResult),
      gitleaks: { applicability: "REQUIRED_EVERY_PR", result: securityResult },
      dependencies: requiredOrNa(dependencyApplicable, securityResult),
      replay: requiredOrNa(backendApplicable, replayResult),
      readiness: requiredOrNa(backendApplicable, readinessResult),
    },
  }
  const failures = []
  if (verdict.gates.classify.result !== "success") failures.push("scope classification")
  if (verdict.gates.source.applicability === "REQUIRED" && sourceResult !== "success") failures.push("source checks")
  if (verdict.gates.backend.applicability === "REQUIRED" && verdict.gates.backend.result !== "success") failures.push("backend")
  if (verdict.gates.root.applicability === "REQUIRED" && verdict.gates.root.result !== "success") failures.push("root")
  if (verdict.gates.gitleaks.result !== "success") failures.push("universal security/gitleaks")
  if (backendApplicable && replayResult !== "success") failures.push("Dealer Zero replay")
  if (backendApplicable && readinessResult !== "success") failures.push("release readiness")
  verdict.verdict = failures.length ? "FAIL" : "PASS"
  return { verdict, failures }
}
export function changedPullRequestFiles({ base, head, cwd = process.cwd() }) {
  if (![base, head].every(value => /^[0-9a-f]{40}$/.test(value ?? ""))) throw new Error("PR diff requires full commit SHAs")
  const git = args => readGit(args, cwd)
  const mergeBase = git(["merge-base", base, head]).trim()
  // Disable rename folding so moving code into docs retains the deleted code
  // path. NUL separation preserves spaces, newlines and non-ASCII filenames.
  return git(["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACDMRT", mergeBase, head]).split("\0").filter(Boolean)
}
