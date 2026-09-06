import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/
export const CONTRACT_PATH = resolve(fileURLToPath(new URL("../../infra/deployment/production.contract.json", import.meta.url)))

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, "utf8"))
}

export function assertCanonicalRelease({ head, remoteMain, dirty }) {
  if (!FULL_COMMIT_SHA.test(head)) throw new Error(`HEAD is not a full commit SHA: ${head}`)
  if (head !== remoteMain) throw new Error(`release SHA ${head} is not canonical remote main ${remoteMain || "<missing>"}`)
  if (dirty) throw new Error("production release requires a clean worktree")
}

export function expectedRelease(commitSha, source = "github-actions") {
  if (!FULL_COMMIT_SHA.test(commitSha)) throw new Error(`invalid release SHA: ${commitSha}`)
  const shortSha = commitSha.slice(0, 12)
  return {
    commitSha,
    buildId: `finnor-${shortSha}`,
    version: `0.1.0+${shortSha}`,
    environment: "production",
    source,
  }
}

export function assertDeploymentPlan(contract, deployedComponents) {
  const required = new Set(contract.release.requiredComponents)
  if (contract.topology.orchestrator.separateDeployment) required.add("orchestrator")
  const deployed = new Set(deployedComponents)
  const missing = [...required].filter((component) => !deployed.has(component))
  if (missing.length) throw new Error(`release omitted required component(s): ${missing.join(", ")}`)
}

export function assertResolvedTarget(label, expected, observed, keys) {
  const failures = keys.flatMap((key) => {
    const expectedValue = expected[key]
    const observedValue = observed?.[key]
    if (typeof expectedValue === "string" && typeof observedValue === "string") {
      return expectedValue.toLowerCase() === observedValue.toLowerCase() ? [] : [`${key}: ${observedValue} != ${expectedValue}`]
    }
    return observedValue === expectedValue ? [] : [`${key}: ${observedValue ?? "<missing>"} != ${expectedValue ?? "<missing>"}`]
  })
  if (failures.length) throw new Error(`${label} target differs from canonical contract:\n${failures.join("\n")}`)
}

export function assertRuntimeParity(contract, expected, observed) {
  const failures = []
  if (contract.topology.orchestrator.separateDeployment === false && contract.topology.orchestrator.releaseIdentity !== "worker") {
    failures.push("embedded orchestrator must inherit worker release identity")
  }
  for (const component of contract.release.requiredComponents) {
    const release = observed[component]
    if (!release) {
      failures.push(`${component}: missing release evidence`)
      continue
    }
    for (const key of ["commitSha", "buildId", "version", "environment", "source"]) {
      const expectedValue = expected[key]
      if (release[key] !== expectedValue) failures.push(`${component}.${key}: ${release[key] ?? "<missing>"} != ${expectedValue ?? "<missing>"}`)
    }
    if (release.traceable !== true) failures.push(`${component}: release metadata is not traceable`)
  }
  if (!observed.worker?.capabilities?.includes(contract.topology.orchestrator.requiredCapability)) {
    failures.push("worker release does not prove the embedded orchestrator capability")
  }
  if (observed.migrationHead !== contract.release.requiredMigrationHead) {
    failures.push(`database migration head: ${observed.migrationHead ?? "<missing>"} != ${contract.release.requiredMigrationHead}`)
  }
  if (failures.length) throw new Error(`release parity failed:\n${failures.join("\n")}`)
}

export function readGitRelease(repoRoot = process.cwd(), contract = loadContract()) {
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
  const head = git(["rev-parse", "HEAD"]).toLowerCase()
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"])
  const { remote, branch } = contract.canonicalGit
  const remoteMain = git(["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/)[0]?.toLowerCase() ?? ""
  return { head, remoteMain, dirty }
}
