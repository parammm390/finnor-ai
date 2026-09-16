export function classifyPullRequestFiles(files) {
  return {
    backend: files.some((path) => path.startsWith("finnor-os/") || path.startsWith("scripts/release/") || path.startsWith("infra/") || path.startsWith(".github/workflows/") || /^(package(?:-lock)?\.json|JARVIS-CREDENTIALS-LEDGER\.md)$/.test(path)),
    root: files.some((path) => /^(src\/|public\/|e2e\/|scripts\/(?!release\/)|package(?:-lock)?\.json$|next\.config|tsconfig|playwright\.config|\.eslintrc)/.test(path) || path.startsWith(".github/workflows/")),
    dependencies: files.some((path) => /(^|\/)(package(?:-lock)?\.json)$/.test(path)),
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

export function evaluateRequiredPrVerdict({ files, classifyResult, backendApplicable, backendResult, rootApplicable, rootResult, dependencyApplicable, securityResult }) {
  const requiredOrNa = (applicable, result) => applicable
    ? { applicability: "REQUIRED", result }
    : { applicability: "N/A", result: "not_applicable" }
  const verdict = {
    schema: "finnor-pr-verdict.v1",
    changedFiles: files,
    gates: {
      classify: { applicability: "REQUIRED", result: classifyResult },
      backend: requiredOrNa(backendApplicable, backendResult),
      root: requiredOrNa(rootApplicable, rootResult),
      gitleaks: { applicability: "REQUIRED_EVERY_PR", result: securityResult },
      dependencies: requiredOrNa(dependencyApplicable, securityResult),
    },
  }
  const failures = []
  if (verdict.gates.classify.result !== "success") failures.push("scope classification")
  if (verdict.gates.backend.applicability === "REQUIRED" && verdict.gates.backend.result !== "success") failures.push("backend")
  if (verdict.gates.root.applicability === "REQUIRED" && verdict.gates.root.result !== "success") failures.push("root")
  if (verdict.gates.gitleaks.result !== "success") failures.push("universal security/gitleaks")
  verdict.verdict = failures.length ? "FAIL" : "PASS"
  return { verdict, failures }
}
