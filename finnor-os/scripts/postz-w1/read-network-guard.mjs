/** Verification-process transport budget. It blocks, never supplies, external data. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const meter = { installed: true, loopbackGateChecks: 0, blockedExternalAttempts: 0 };
Object.defineProperty(globalThis, "__FINNOR_W1_READ_NETWORK_METER", { value: meter, writable: false });
const local = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
function allow(host) {
  let value = String(host ?? "localhost");
  if (value.startsWith("/")) return; // Local UNIX socket, not an external transport.
  if (!local.has(value)) {
    try { value = new URL(`http://${value}`).hostname; } catch { value = ""; }
  }
  if (!local.has(value)) {
    meter.blockedExternalAttempts++;
    throw Error("W1_READ_PROOF_EXTERNAL_NETWORK_FORBIDDEN");
  }
  meter.loopbackGateChecks++;
}
function check(args) {
  const first = args[0];
  if (Array.isArray(first)) { check(first); return; }
  if (first instanceof URL) { allow(first.hostname); return; }
  if (typeof first === "string") {
    if (first.startsWith("/")) return;
    allow(new URL(first).hostname); return;
  }
  if (typeof first === "number") { allow(typeof args[1] === "string" ? args[1] : "localhost"); return; }
  if (first && typeof first === "object") {
    allow(first.hostname ?? first.host ?? (first.path?.startsWith("/") ? "localhost" : undefined));
    if (first.method === "CONNECT") allow(first.path);
    return;
  }
  throw Error("W1_READ_PROOF_EXPLICIT_NETWORK_TARGET_REQUIRED");
}
for (const [module, names] of [[http, ["request", "get"]], [https, ["request", "get"]], [net, ["connect", "createConnection"]], [net.Socket.prototype, ["connect"]], [tls, ["connect"]]]) {
  for (const name of names) {
    const original = module[name];
    module[name] = function (...args) { check(args); return Reflect.apply(original, this, args); };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  allow(new URL(input instanceof Request ? input.url : input).hostname);
  return Reflect.apply(originalFetch, this, [input, init]);
};
syncBuiltinESMExports();
