import { execFileSync } from "node:child_process"

const NOT_FOUND = /(?:ResourceNotFound|could not be found|was not found|does not exist)/i
const TRANSIENT_CONTROL_PLANE = /(?:ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENETUNREACH|socket hang up|temporarily unavailable|ServiceUnavailable|TooManyRequests|GatewayTimeout|BadGateway|InternalServerError|HTTP\s+(?:429|5\d\d)|timed out|timeout)/i
const TERMINAL_FAILURE_STATES = new Set(["Failed", "Canceled", "Cancelled", "TimedOut", "Timedout"])
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 90 * 1000
const CONTROL_PLANE_RETRY_ATTEMPTS = 3
const CONTROL_PLANE_RETRY_BASE_MS = 2 * 1000
const POLL_INTERVAL_MS = 5 * 1000
const EXECUTION_GRACE_MS = 10 * 60 * 1000
const CLEANUP_GRACE_MS = 6 * 60 * 1000

function errorDiagnostic(error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : ""
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
  return [stdout, stderr].filter(Boolean).join("\n") || (error instanceof Error ? error.message : String(error))
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function runAz(exec, az, args, timeout = CONTROL_PLANE_REQUEST_TIMEOUT_MS) {
  return exec(az, [...args, "--only-show-errors", "-o", "json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  })
}

function runAzWithTransientRetry({ exec, az, args, deadline, sleep, now, attempts = CONTROL_PLANE_RETRY_ATTEMPTS }) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runAz(exec, az, args)
    } catch (error) {
      lastError = error
      const diagnostic = errorDiagnostic(error)
      if (!TRANSIENT_CONTROL_PLANE.test(diagnostic) || attempt === attempts || now() >= deadline) throw error
      sleep(Math.min(CONTROL_PLANE_RETRY_BASE_MS * attempt, 10_000))
    }
  }
  throw lastError
}

function showCommand({ exec, az, worker, name, deadline, sleep, now, allowMissing }) {
  try {
    const raw = runAzWithTransientRetry({
      exec,
      az,
      args: [
        "vm", "run-command", "show",
        "--resource-group", worker.resourceGroup,
        "--vm-name", worker.resourceName,
        "--run-command-name", name,
        "--instance-view",
      ],
      deadline,
      sleep,
      now,
    })
    return JSON.parse(raw)
  } catch (error) {
    const diagnostic = errorDiagnostic(error)
    if (allowMissing && NOT_FOUND.test(diagnostic)) return null
    throw error
  }
}

function deleteCommand({ exec, az, worker, name, allowMissing, sleep, now }) {
  const deadline = now() + CLEANUP_GRACE_MS
  let lastError
  try {
    runAzWithTransientRetry({
      exec,
      az,
      args: [
        "vm", "run-command", "delete",
        "--resource-group", worker.resourceGroup,
        "--vm-name", worker.resourceName,
        "--run-command-name", name,
        "--yes",
        "--no-wait",
      ],
      deadline,
      sleep,
      now,
    })
  } catch (error) {
    const diagnostic = errorDiagnostic(error)
    if (allowMissing && NOT_FOUND.test(diagnostic)) return
    if (!TRANSIENT_CONTROL_PLANE.test(diagnostic)) {
      throw new Error(`Azure managed RunCommand cleanup failed for ${name}:\n${diagnostic}`, { cause: error })
    }
    lastError = error
  }

  while (now() < deadline) {
    try {
      const current = showCommand({ exec, az, worker, name, deadline, sleep, now, allowMissing: true })
      if (current === null) return
    } catch (error) {
      lastError = error
      const diagnostic = errorDiagnostic(error)
      if (!TRANSIENT_CONTROL_PLANE.test(diagnostic)) {
        throw new Error(`Azure managed RunCommand cleanup verification failed for ${name}:\n${diagnostic}`, { cause: error })
      }
    }
    sleep(POLL_INTERVAL_MS)
  }

  const diagnostic = lastError ? errorDiagnostic(lastError) : "RunCommand still exists after bounded cleanup window"
  throw new Error(`Azure managed RunCommand cleanup timed out for ${name}:\n${diagnostic}`, { cause: lastError })
}

function createCommand({ exec, az, worker, name, script, timeoutSeconds, deadline, sleep, now }) {
  let lastError
  for (let attempt = 1; attempt <= CONTROL_PLANE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      runAz(exec, az, [
        "vm", "run-command", "create",
        "--resource-group", worker.resourceGroup,
        "--vm-name", worker.resourceName,
        "--location", worker.location,
        "--run-command-name", name,
        // Detach ARM's long-running operation while keeping guest execution
        // synchronous so instance-view reaches a terminal state after exit.
        "--async-execution", "false",
        "--no-wait",
        "--timeout-in-seconds", String(timeoutSeconds),
        "--script", script,
      ])
      return
    } catch (error) {
      lastError = error
      const diagnostic = errorDiagnostic(error)
      if (!TRANSIENT_CONTROL_PLANE.test(diagnostic)) throw error

      try {
        const current = showCommand({ exec, az, worker, name, deadline, sleep, now, allowMissing: true })
        if (current !== null) return
      } catch (showError) {
        const showDiagnostic = errorDiagnostic(showError)
        if (!TRANSIENT_CONTROL_PLANE.test(showDiagnostic)) throw showError
      }

      if (attempt === CONTROL_PLANE_RETRY_ATTEMPTS || now() >= deadline) throw error
      sleep(Math.min(CONTROL_PLANE_RETRY_BASE_MS * attempt, 10_000))
    }
  }
  throw lastError
}

export function managedRunCommandName(stage, commitSha) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(stage)) throw new Error(`invalid managed RunCommand stage: ${stage}`)
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("managed RunCommand requires a full lowercase Git SHA")
  return `finnor-${stage}-${commitSha.slice(0, 12)}`
}

/**
 * Execute release work through Azure's managed RunCommand resource rather than
 * the legacy single-active action extension. Each stage/SHA gets a deterministic
 * resource that is cleaned before and after use.
 */
export function runManagedAzureCommand({
  stage,
  commitSha,
  script,
  timeoutSeconds,
  worker,
  az = process.env.AZURE_CLI || "az",
}, { exec = execFileSync, sleep = defaultSleep, now = Date.now } = {}) {
  if (!worker?.resourceGroup || !worker?.resourceName || !worker?.location) {
    throw new Error("managed RunCommand requires the canonical worker resource group, name, and location")
  }
  if (typeof script !== "string" || script.length === 0) throw new Error("managed RunCommand script is empty")
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60 * 60) {
    throw new Error(`managed RunCommand timeout is invalid: ${timeoutSeconds}`)
  }

  const name = managedRunCommandName(stage, commitSha)
  deleteCommand({ exec, az, worker, name, allowMissing: true, sleep, now })

  let primaryError
  try {
    const deadline = now() + timeoutSeconds * 1000 + EXECUTION_GRACE_MS
    createCommand({ exec, az, worker, name, script, timeoutSeconds, deadline, sleep, now })

    while (now() < deadline) {
      const result = showCommand({ exec, az, worker, name, deadline, sleep, now, allowMissing: true })
      if (result === null) {
        sleep(POLL_INTERVAL_MS)
        continue
      }

      const view = result.instanceView ?? result.properties?.instanceView
      const provisioningState = result.provisioningState ?? result.properties?.provisioningState
      const executionState = view?.executionState
      const exitCode = Number(view?.exitCode)
      const output = typeof view?.output === "string" ? view.output : ""
      const error = typeof view?.error === "string" ? view.error : ""

      if (executionState === "Succeeded") {
        if (exitCode !== 0) {
          throw new Error(`Azure managed RunCommand ${name} failed (state=Succeeded, exit=${Number.isFinite(exitCode) ? exitCode : "missing"}):\n${error || output || "no command output"}`)
        }
        return { name, executionState, exitCode, output, error }
      }
      if (TERMINAL_FAILURE_STATES.has(executionState)) {
        throw new Error(`Azure managed RunCommand ${name} failed (state=${executionState}, exit=${Number.isFinite(exitCode) ? exitCode : "missing"}):\n${error || output || "no command output"}`)
      }
      if (TERMINAL_FAILURE_STATES.has(provisioningState)) {
        throw new Error(`Azure managed RunCommand ${name} provisioning failed (state=${provisioningState}):\n${error || output || "no command output"}`)
      }
      sleep(POLL_INTERVAL_MS)
    }

    throw new Error(`Azure managed RunCommand ${name} exceeded bounded execution deadline of ${timeoutSeconds + EXECUTION_GRACE_MS / 1000}s`)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      deleteCommand({ exec, az, worker, name, allowMissing: true, sleep, now })
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], `Azure managed RunCommand ${name} failed and could not be cleaned up`)
      throw cleanupError
    }
  }
}
