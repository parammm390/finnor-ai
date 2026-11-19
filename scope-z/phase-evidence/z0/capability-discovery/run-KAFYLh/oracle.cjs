
const {createRequire, syncBuiltinESMExports} = require("node:module");
const req = createRequire(process.cwd() + "/finnor-os/package.json");
const attempts = [];
const deny = name => () => { attempts.push(name); throw new Error("ORACLE_NETWORK_DENIED:" + name); };
for (const [name, methods] of Object.entries({
  http:["request","get"], https:["request","get"], net:["connect","createConnection"],
  tls:["connect"], dns:["lookup","resolve","resolve4","resolve6"],
  dgram:["createSocket"]
})) {
  const api = require("node:" + name);
  for (const method of methods) api[method] = deny(name + "." + method);
}
require("node:net").Socket.prototype.connect = deny("Socket.connect");
for (const method of ["lookup","resolve","resolve4","resolve6"])
  require("node:dns").promises[method] = deny("dns.promises." + method);
globalThis.fetch = deny("fetch");
syncBuiltinESMExports();
req("tsx/cjs/api").register();
const owner = req("./packages/orchestration/src/plugin-registry.ts");
const shared = req("@finnor/shared-types");
const original = owner.PluginRegistry.prototype.register;
let actionCalls = 0;
owner.PluginRegistry.prototype.register = function(plugin) {
  plugin.execute = () => { actionCalls++; throw new Error("ORACLE_ACTION_EXECUTION_DENIED"); };
  return original.call(this, plugin);
};
const entries = owner.planningCapabilitiesForVertical(owner.createDefaultPluginRegistry(), shared.PRIVATE_EQUITY_VERTICAL);
if (attempts.length || actionCalls) throw new Error("Oracle observed forbidden effect attempts");
process.stdout.write(JSON.stringify({
  entries, humanOnly: [...owner.HUMAN_ONLY_PLANNING_CAPABILITIES], attempts, actionCalls,
  workspaceSources: Object.keys(require.cache).filter(path => /\/finnor-os\/(?:packages|apps)\//.test(path)),
  registrySource: req.resolve("./packages/orchestration/src/plugin-registry.ts"),
  sharedSource: req.resolve("@finnor/shared-types")
}));
