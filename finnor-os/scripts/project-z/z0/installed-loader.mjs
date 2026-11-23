/** Resolve canonical dynamic source names to this installation's emitted JS.
 * Original TS remains hashable evidence, never an executable fallback. */
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(here, "../.."));
const require = createRequire(import.meta.url);
const installation = require(resolve(root, "finnor-os/packages/source-custody/installation.cjs")).installedRuntime(true);
const declaredFiles = new Set(installation.manifest.files.map(item => resolve(root, item.path)));
const mappings = JSON.parse(readFileSync(resolve(here, "emitted-source-map.json"), "utf8"));
const emitted = new Map(mappings.map(item => [pathToFileURL(resolve(root, item.source)).href,
  pathToFileURL(resolve(root, item.emitted)).href]));
const original = new Map([...emitted].map(([a, b]) => [b, a]));
const remap = url => {
  if (!url.startsWith("file:")) return url;
  const path = fileURLToPath(url);
  if (!path.startsWith(root + sep)) throw Error("Z0_RUNTIME_IMPORT_OUTSIDE_INSTALLATION");
  if (/\.(?:[cm]?ts|tsx)$/.test(path)) {
    const target = emitted.get(pathToFileURL(path).href);
    if (!target) throw Error("Z0_SOURCE_EXECUTION_WITHOUT_EMISSION_REFUSED");
    return target;
  }
  return url;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("file:") && emitted.has(specifier)) return { url: remap(specifier), shortCircuit: true };
    try {
      const result = nextResolve(specifier, context);
      const url = remap(result.url);
      return url === result.url ? result : { url, format: "module", shortCircuit: true };
    } catch (error) {
      if (!specifier.startsWith(".") || !context.parentURL?.startsWith("file:")) throw error;
      const parent = original.get(context.parentURL) ?? context.parentURL;
      for (const suffix of ["", ".ts", ".tsx", ".mts", "/index.ts"]) {
        const candidate = new URL(specifier + suffix, parent).href;
        if (emitted.has(candidate)) return { url: emitted.get(candidate), format: "module", shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) {
      const path = fileURLToPath(url);
      if (!declaredFiles.has(realpathSync(path))) throw Error("Z0_UNDECLARED_EXECUTABLE_IMPORT_REFUSED");
      if (/\.(?:[cm]?ts|tsx)$/.test(path) || /\/node_modules\/(?:tsx|ts-node|jiti)\//.test(path)) {
        throw Error("Z0_RUNTIME_TYPESCRIPT_FALLBACK_REFUSED");
      }
    }
    return nextLoad(url, context);
  },
});
// Offline closure doctors must not reach a network or listen. This flag grants
// nothing and is never used by the native driver or regular runtime launch.
if (process.argv.includes("--z0-offline-doctor")) {
  const fail = () => { throw Error("Z0_OFFLINE_DOCTOR_NETWORK_REFUSED"); };
  const net = require("node:net"), http = require("node:http"), https = require("node:https");
  net.Socket.prototype.connect = fail;
  net.Server.prototype.listen = fail;
  http.request = fail; http.get = fail; https.request = fail; https.get = fail;
  globalThis.fetch = fail;
  syncBuiltinESMExports();
}
if (!existsSync(installation.entrypoint("checker"))) throw Error("Z0_COMPILED_CHECKER_MISSING");
