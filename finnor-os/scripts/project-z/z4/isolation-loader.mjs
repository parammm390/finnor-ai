import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A build/replay audit boundary, not an OS sandbox. Never redirect an import
// to a convenient parent checkout when a declared installed asset is absent.
const root = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
Object.defineProperty(globalThis, Symbol.for("finnor.z4.declared-runtime-root"), {
  value: root, writable: false, configurable: false,
});
function assertLocal(url) {
  if (url.startsWith("node:") || url.startsWith("data:")) return;
  if (!url.startsWith("file:")) throw new Error("Z4_UNDECLARED_MODULE_SCHEME");
  const path = relative(root, realpathSync(fileURLToPath(url)));
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error("Z4_EXTERNAL_MODULE_FALLBACK_REFUSED");
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    assertLocal(result.url);
    return result;
  },
  load(url, context, nextLoad) {
    assertLocal(url);
    return nextLoad(url, context);
  },
});
