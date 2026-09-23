const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i

export type ReleaseMetadata = {
  service: string
  commitSha: string
  buildId: string
  deploymentId: string | null
  environment: string
  version: string
  source: string
  projectId: string | null
  coreCertificationId: string | null
  traceable: boolean
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export function getReleaseMetadata(service: string): ReleaseMetadata {
  const commitSha = firstEnv("FINNOR_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA", "GITHUB_SHA", "RELEASE_SHA") ?? "unknown"
  const shortSha = FULL_COMMIT_SHA.test(commitSha) ? commitSha.slice(0, 12) : "unknown"
  const buildId = firstEnv("FINNOR_BUILD_ID", "NEXT_BUILD_ID") ?? `centropy-${shortSha}`
  const version = firstEnv("FINNOR_VERSION") ?? `0.1.0+${shortSha}`
  const deploymentId = firstEnv("VERCEL_DEPLOYMENT_ID", "FINNOR_DEPLOYMENT_ID") ?? null
  const environment = firstEnv("FINNOR_ENVIRONMENT", "VERCEL_ENV", "NODE_ENV") ?? "unknown"
  const source = firstEnv("FINNOR_RELEASE_SOURCE") ?? (process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "unknown")
  const projectId = firstEnv("VERCEL_PROJECT_ID") ?? null
  const coreCertificationId = firstEnv("FINNOR_CORE_CERTIFICATION_ID") ?? null

  return {
    service,
    commitSha,
    buildId,
    deploymentId,
    environment,
    version,
    source,
    projectId,
    coreCertificationId,
    traceable:
      FULL_COMMIT_SHA.test(commitSha) &&
      buildId !== "unknown" &&
      deploymentId !== null &&
      environment !== "unknown" &&
      version !== "unknown" &&
      source !== "unknown",
  }
}
