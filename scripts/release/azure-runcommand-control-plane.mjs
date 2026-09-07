import { execFileSync } from "node:child_process"

const POLL_INTERVAL_MS = 5_000
const EXTENSION_RESET_TIMEOUT_MS = 5 * 60_000
const GUEST_AGENT_SETTLE_MS = 20_000
const RUNCOMMAND_EXTENSION_NAME = "RunCommandLinux"
const DELETE_RETRYABLE = /(?:ResourceNotFound|could not be found|was not found|does not exist|AnotherOperationInProgress|OperationPreempted|Conflict|HTTP\s+409|operation.*in progress|marked for deletion)/i
const EXTENSION_DELETE_AUTHORIZATION = /AuthorizationFailed[\s\S]*virtualMachines\/extensions\/delete/i
const WEDGED_RUNCOMMAND_EXTENSION = /OperationNotAllowed[\s\S]*?RunCommandLinux[\s\S]*?marked for deletion/i

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function diagnostic(error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : ""
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
  return [stdout, stderr].filter(Boolean).join("\n") || (error instanceof Error ? error.message : String(error))
}

export function isWedgedRunCommandExtensionError(error) {
  return WEDGED_RUNCOMMAND_EXTENSION.test(diagnostic(error))
}

function runAzure(exec, az, args, timeout = EXTENSION_RESET_TIMEOUT_MS) {
  return exec(az, [...args, "--only-show-errors", "-o", "json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  })
}

function runRawAzure(exec, az, args, timeout = EXTENSION_RESET_TIMEOUT_MS) {
  return exec(az, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  })
}

function azJson(exec, az, args, timeout) {
  const raw = runAzure(exec, az, args, timeout)
  return raw.trim() ? JSON.parse(raw) : null
}

function runCommandExtensionNames(exec, az, worker) {
  const rows = azJson(exec, az, [
    "vm", "extension", "list",
    "--resource-group", worker.resourceGroup,
    "--vm-name", worker.resourceName,
  ]) ?? []

  return rows
    .filter((row) => {
      const publisher = row?.publisher ?? row?.properties?.publisher
      const type = row?.virtualMachineExtensionType ?? row?.typePropertiesType ?? row?.properties?.type
      return publisher === "Microsoft.CPlat.Core" && type === "RunCommandLinux"
    })
    .map((row) => row?.name)
    .filter((name) => typeof name === "string" && name.length > 0)
}

export function resetRunCommandLinuxExtension({ worker, az = process.env.AZURE_CLI || "az" }, {
  exec = execFileSync,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  // Azure can omit an extension from `vm extension list` while its delete
  // operation is still propagating. The canonical name is safe to target
  // directly and is exactly the extension named by the guarded error.
  const names = [...new Set([...runCommandExtensionNames(exec, az, worker), RUNCOMMAND_EXTENSION_NAME])]

  for (const name of names) {
    try {
      runAzure(exec, az, [
        "vm", "extension", "delete",
        "--resource-group", worker.resourceGroup,
        "--vm-name", worker.resourceName,
        "--name", name,
        "--no-wait",
      ], EXTENSION_RESET_TIMEOUT_MS)
    } catch (error) {
      if (!DELETE_RETRYABLE.test(diagnostic(error))) throw error
    }
  }

  const deadline = now() + EXTENSION_RESET_TIMEOUT_MS
  let remaining = runCommandExtensionNames(exec, az, worker)
  while (remaining.length && now() < deadline) {
    sleep(POLL_INTERVAL_MS)
    remaining = runCommandExtensionNames(exec, az, worker)
  }
  if (remaining.length) {
    throw new Error(`Azure RunCommandLinux VM extension did not delete through the control plane: ${remaining.join(", ")}`)
  }

  sleep(GUEST_AGENT_SETTLE_MS)
  return { extensionNames: names }
}

export function restartAzureGuestAgentOverSsh({ worker, az = process.env.AZURE_CLI || "az" }, {
  exec = execFileSync,
} = {}) {
  // This is the least-privilege fallback for identities that can invoke
  // RunCommand but are intentionally denied extension-delete permission. It
  // only restarts the Azure guest agent; it does not restart the VM or mutate
  // application files. The next guarded RunCommand invocation reinstalls the
  // extension after Azure finishes its pending deletion.
  runRawAzure(exec, az, ["extension", "add", "--name", "ssh", "--yes", "--only-show-errors"], EXTENSION_RESET_TIMEOUT_MS)
  runRawAzure(exec, az, [
    "ssh", "vm",
    "--resource-group", worker.resourceGroup,
    "--name", worker.resourceName,
    "--resource-type", worker.resourceType || "Microsoft.Compute/virtualMachines",
    "--yes-without-prompt",
    "--",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=30",
    "sudo sh -c 'systemctl restart walinuxagent.service || systemctl restart waagent.service'",
  ], EXTENSION_RESET_TIMEOUT_MS)
}

export function invokeAzureRunCommand({ worker, commandId, scripts, az = process.env.AZURE_CLI || "az" }, {
  exec = execFileSync,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const args = [
    "vm", "run-command", "invoke",
    "--resource-group", worker.resourceGroup,
    "--name", worker.resourceName,
    "--command-id", commandId,
    "--scripts", scripts,
  ]

  try {
    return azJson(exec, az, args)
  } catch (error) {
    if (!isWedgedRunCommandExtensionError(error)) throw error
    try {
      resetRunCommandLinuxExtension({ worker, az }, { exec, sleep, now })
    } catch (resetError) {
      if (!EXTENSION_DELETE_AUTHORIZATION.test(diagnostic(resetError))) throw resetError
      restartAzureGuestAgentOverSsh({ worker, az }, { exec })
      sleep(GUEST_AGENT_SETTLE_MS)
    }
    return azJson(exec, az, args)
  }
}
