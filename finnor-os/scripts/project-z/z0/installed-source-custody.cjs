// Installation adapter: metadata still names the exact original pinned source.
// Executable imports are mapped to emitted JS by installed-loader.mjs. No TS
// loader, environment-selected root or builder directory is registered here.
const { existsSync, realpathSync } = require("node:fs");
const { dirname, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const root = realpathSync(resolve(__dirname, "../../.."));
if (!existsSync(resolve(root, "finnor-os/x1-development-installation.json"))) {
  throw Error("Z0_EMITTED_INSTALLATION_CUSTODY_REQUIRED");
}
function sourcePath(path) {
  if (typeof path !== "string" || !/^(?:finnor-os\/(?:packages|scripts|apps)|scripts\/release)\/[^\\]+\.(?:[cm]?ts|tsx|[cm]?js)$/.test(path)
    || path.split("/").some(part => !part || part === "." || part === "..")) throw Error("Z0_CANONICAL_SOURCE_PATH_REQUIRED");
  const file = realpathSync(resolve(root, path));
  if (!file.startsWith(root + sep)) throw Error("Z0_SOURCE_OUTSIDE_INSTALLATION");
  return file;
}
exports.sourceURL = path => pathToFileURL(sourcePath(path)).href;
exports.sourceDirectory = path => dirname(sourcePath(path));
