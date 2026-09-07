import assert from "node:assert/strict"
import test from "node:test"
import { managedRunCommandName, runManagedAzureCommand } from "./azure-managed-run-command.mjs"

const worker = {
  resourceGroup: "canonical-rg",
  resourceName: "canonical-vm",
  location: "North Central US",
}

test("managed RunCommand retries transient reads and cleans the deterministic resource", () => {
  const calls = []
  let exists = false
  let executionShows = 0
  const exec = (_az, args) => {
    calls.push(args)
    const operation = args[2]
    if (operation === "delete") {
      if (!exists) throw Object.assign(new Error("missing"), { stderr: "ResourceNotFound: command was not found" })
      exists = false
      return "{}"
    }
    if (operation === "create") {
      exists = true
      return "{}"
    }
    if (operation === "show") {
      if (!exists) throw Object.assign(new Error("missing"), { stderr: "ResourceNotFound" })
      executionShows += 1
      if (executionShows === 1) throw Object.assign(new Error("control plane timeout"), { stderr: "ETIMEDOUT" })
      return JSON.stringify({ instanceView: { executionState: "Succeeded", exitCode: 0, output: "FINNOR_OK", error: "" } })
    }
    throw new Error(`unexpected Azure operation: ${operation}`)
  }

  const commitSha = "b".repeat(40)
  assert.equal(managedRunCommandName("preflight", commitSha), "finnor-preflight-bbbbbbbbbbbb")
  assert.deepEqual(runManagedAzureCommand(
    { stage: "preflight", commitSha, script: "echo FINNOR_OK", timeoutSeconds: 60, worker },
    { exec, sleep: () => {} },
  ), {
    name: "finnor-preflight-bbbbbbbbbbbb",
    executionState: "Succeeded",
    exitCode: 0,
    output: "FINNOR_OK",
    error: "",
  })
  const create = calls.find((args) => args[2] === "create")
  assert.equal(create[create.indexOf("--async-execution") + 1], "false")
  assert.ok(create.includes("--no-wait"))
  assert.ok(calls.filter((args) => args[2] === "show").length >= 2)
  assert.equal(exists, false)
})

test("managed RunCommand reports guest failure and still removes the resource", () => {
  let exists = false
  let deletes = 0
  const exec = (_az, args) => {
    const operation = args[2]
    if (operation === "delete") {
      deletes += 1
      if (!exists) throw Object.assign(new Error("missing"), { stderr: "ResourceNotFound" })
      exists = false
      return "{}"
    }
    if (operation === "create") {
      exists = true
      return "{}"
    }
    if (operation === "show") {
      if (!exists) throw Object.assign(new Error("missing"), { stderr: "ResourceNotFound" })
      return JSON.stringify({ instanceView: { executionState: "Failed", exitCode: 23, output: "", error: "remote failure" } })
    }
    throw new Error(`unexpected Azure operation: ${operation}`)
  }

  const commitSha = "c".repeat(40)
  assert.throws(
    () => runManagedAzureCommand(
      { stage: "deploy", commitSha, script: "exit 23", timeoutSeconds: 60, worker },
      { exec, sleep: () => {} },
    ),
    /state=Failed, exit=23[\s\S]*remote failure/,
  )
  assert.equal(exists, false)
  assert.ok(deletes >= 2)
})
