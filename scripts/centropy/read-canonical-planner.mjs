import { createRequire, syncBuiltinESMExports } from "node:module"
import { resolve } from "node:path"

const backend = resolve(import.meta.dirname, "../../finnor-os")
const require = createRequire(resolve(backend, "package.json"))
const attempts = []
const deny = name => (...args) => {
  const error = new Error(`CAPABILITY_ENUMERATION_NETWORK_DENIED:${name}`)
  const loaderIPC = name === "net.createConnection" && typeof args[0] === "string" &&
    args[0].endsWith(`/${process.ppid}.pipe`) && error.stack.includes("/node_modules/tsx/dist/client-")
  attempts.push({ name, loaderIPC })
  throw error
}
for (const [name, methods] of Object.entries({
  http: ["request", "get"], https: ["request", "get"], net: ["connect", "createConnection"],
  tls: ["connect"], dns: ["lookup", "resolve", "resolve4", "resolve6"], dgram: ["createSocket"],
})) {
  const api = require(`node:${name}`)
  for (const method of methods) api[method] = deny(`${name}.${method}`)
}
require("node:net").Socket.prototype.connect = deny("Socket.connect")
for (const method of ["lookup", "resolve", "resolve4", "resolve6"])
  require("node:dns").promises[method] = deny(`dns.promises.${method}`)
globalThis.fetch = deny("fetch")
syncBuiltinESMExports()

// The installed TS loader attempts optional local parent IPC on import.
// Deny it too, but distinguish this reviewed bootstrap attempt from product
// registration. No socket is opened, including for this local IPC.
require("tsx/cjs/api").register()
const loaderAttempts = attempts.splice(0)
if (loaderAttempts.some(attempt => !attempt.loaderIPC))
  throw new Error("Unexpected network attempt while loading the capability TS loader")

const { createDefaultPluginRegistry, planningCapabilitiesForVertical, HUMAN_ONLY_PLANNING_CAPABILITIES } =
  require("./packages/orchestration/src/plugin-registry.ts")
const { PRIVATE_EQUITY_VERTICAL } = require("@finnor/shared-types")
const { PRIVATE_EQUITY_ACTION_TYPES } = require("./packages/domain-plugins/private-equity/index.ts")
const { ECONOMIC_NATIVE_ACTION } = require("./packages/private-equity/src/program-synthesis/economic-native.ts")
const registry = createDefaultPluginRegistry()
let actionInvocations = 0
for (const name of registry.actionTypes()) registry.resolve(name).execute = () => {
  actionInvocations++
  throw new Error("CAPABILITY_ENUMERATION_ACTION_EXECUTION_DENIED")
}
const entries = planningCapabilitiesForVertical(registry, PRIVATE_EQUITY_VERTICAL)
if (attempts.length || actionInvocations)
  throw new Error("Capability registration attempted a network request or action execution")
process.stdout.write(JSON.stringify({
  entries, humanOnly: [...HUMAN_ONLY_PLANNING_CAPABILITIES],
  privateEquityActions: [...PRIVATE_EQUITY_ACTION_TYPES, ECONOMIC_NATIVE_ACTION],
  plugins: Object.fromEntries(registry.actionTypes().map(name => [name, registry.resolve(name).name])),
  verticalKey: PRIVATE_EQUITY_VERTICAL, blockedLoaderIPC: loaderAttempts.length,
}))
