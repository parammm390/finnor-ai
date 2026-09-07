import assert from "node:assert/strict"
import test from "node:test"
import { invokeAzureRunCommand } from "./azure-runcommand-control-plane.mjs"

const worker = {
  resourceGroup: "finnor-production-rg",
  resourceName: "finnor-jarvis-worker",
}

function wedgedError() {
  const error = new Error("Command failed")
  error.stderr = "ERROR: (OperationNotAllowed) Operation 'PUT Extension' is not allowed on VM extension 'RunCommandLinux' since it is marked for deletion. You can only retry the Delete operation (or wait for an ongoing one to complete)."
  return error
}

test("resets only the wedged RunCommandLinux extension and retries the preflight", () => {
  const calls = []
  let extensionPresent = true
  let invokeAttempts = 0
  let clock = 0

  const exec = (_az, args) => {
    calls.push(args)
    if (args[0] === "vm" && args[1] === "run-command" && args[2] === "invoke") {
      invokeAttempts += 1
      if (invokeAttempts === 1) throw wedgedError()
      return JSON.stringify({ value: [{ message: "FINNOR_AZURE_PREFLIGHT_OK" }] })
    }
    if (args[0] === "vm" && args[1] === "extension" && args[2] === "list") {
      return JSON.stringify(extensionPresent ? [
        { name: "RunCommandLinux", publisher: "Microsoft.CPlat.Core", typePropertiesType: "RunCommandLinux" },
        { name: "ApplicationHealthLinux", publisher: "Microsoft.Azure.Extensions", typePropertiesType: "CustomScript" },
      ] : [])
    }
    if (args[0] === "vm" && args[1] === "extension" && args[2] === "delete") {
      assert.equal(args[args.indexOf("--name") + 1], "RunCommandLinux")
      extensionPresent = false
      return "{}"
    }
    throw new Error(`unexpected Azure operation: ${args.join(" ")}`)
  }

  const result = invokeAzureRunCommand(
    { worker, commandId: "RunShellScript", scripts: "echo preflight", az: "az" },
    {
      exec,
      sleep: (ms) => { clock += Math.max(ms, 60_000) },
      now: () => clock,
    },
  )

  assert.deepEqual(result, { value: [{ message: "FINNOR_AZURE_PREFLIGHT_OK" }] })
  assert.equal(invokeAttempts, 2)
  assert.equal(extensionPresent, false)
  assert.equal(calls.filter((args) => args[0] === "vm" && args[1] === "extension" && args[2] === "delete").length, 1)
  assert.equal(calls.some((args) => args[0] === "vm" && args[1] === "extension" && args[2] === "delete" && args.includes("ApplicationHealthLinux")), false)
})

test("does not mutate the worker for unrelated RunCommand failures", () => {
  const calls = []
  const error = new Error("Command failed")
  error.stderr = "ERROR: (AuthorizationFailed) the client is not authorized"

  assert.throws(
    () => invokeAzureRunCommand(
      { worker, commandId: "RunShellScript", scripts: "echo preflight", az: "az" },
      { exec: (_az, args) => { calls.push(args); throw error } },
    ),
    /Command failed/,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "vm")
  assert.equal(calls[0][1], "run-command")
})

test("retries the canonical delete when Azure hides the extension during deletion", () => {
  const calls = []
  let invokeAttempts = 0
  let clock = 0

  const exec = (_az, args) => {
    calls.push(args)
    if (args[0] === "vm" && args[1] === "run-command" && args[2] === "invoke") {
      invokeAttempts += 1
      if (invokeAttempts === 1) throw wedgedError()
      return JSON.stringify({ value: [{ message: "FINNOR_AZURE_PREFLIGHT_OK" }] })
    }
    if (args[0] === "vm" && args[1] === "extension" && args[2] === "list") return "[]"
    if (args[0] === "vm" && args[1] === "extension" && args[2] === "delete") {
      assert.equal(args[args.indexOf("--name") + 1], "RunCommandLinux")
      return "{}"
    }
    throw new Error(`unexpected Azure operation: ${args.join(" ")}`)
  }

  const result = invokeAzureRunCommand(
    { worker, commandId: "RunShellScript", scripts: "echo preflight", az: "az" },
    {
      exec,
      sleep: (ms) => { clock += Math.max(ms, 60_000) },
      now: () => clock,
    },
  )

  assert.deepEqual(result, { value: [{ message: "FINNOR_AZURE_PREFLIGHT_OK" }] })
  assert.equal(invokeAttempts, 2)
  assert.equal(calls.some((args) => args[0] === "vm" && args[1] === "extension" && args[2] === "delete" && args.includes("RunCommandLinux")), true)
})

test("falls back to guest-agent SSH recovery when extension delete is unauthorized", () => {
  const calls = []
  let invokeAttempts = 0
  let clock = 0
  const extensionDeleteError = new Error("Command failed")
  extensionDeleteError.stderr = "ERROR: (AuthorizationFailed) not authorized to perform action 'Microsoft.Compute/virtualMachines/extensions/delete'"

  const exec = (_az, args) => {
    calls.push(args)
    if (args[0] === "vm" && args[1] === "run-command" && args[2] === "invoke") {
      invokeAttempts += 1
      if (invokeAttempts === 1) throw wedgedError()
      return JSON.stringify({ value: [{ message: "FINNOR_AZURE_PREFLIGHT_OK" }] })
    }
    if (args[0] === "vm" && args[1] === "extension" && args[2] === "list") {
      return JSON.stringify([{ name: "RunCommandLinux", publisher: "Microsoft.CPlat.Core", typePropertiesType: "RunCommandLinux" }])
    }
    if (args[0] === "vm" && args[1] === "extension" && args[2] === "delete") throw extensionDeleteError
    if (args[0] === "extension" && args[1] === "add") return ""
    if (args[0] === "ssh" && args[1] === "vm") return ""
    throw new Error(`unexpected Azure operation: ${args.join(" ")}`)
  }

  const result = invokeAzureRunCommand(
    { worker, commandId: "RunShellScript", scripts: "echo preflight", az: "az" },
    {
      exec,
      sleep: (ms) => { clock += Math.max(ms, 60_000) },
      now: () => clock,
    },
  )

  assert.deepEqual(result, { value: [{ message: "FINNOR_AZURE_PREFLIGHT_OK" }] })
  assert.equal(invokeAttempts, 2)
  assert.equal(calls.some((args) => args[0] === "extension" && args[1] === "add" && args.includes("ssh")), true)
  assert.equal(calls.some((args) => args[0] === "ssh" && args[1] === "vm"), true)
})
