const { existsSync, realpathSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
// Source-loaded producer adapters need the same TS execution support as the
// native worker. Register once, before their native dynamic imports execute.
const tsconfig = resolve(repositoryRoot(), "finnor-os/tsconfig.json");
require("tsx/esm/api").register({ tsconfig });
require("tsx/cjs/api").register({ tsconfig });

// The real source tree is packaged with the function. Never use a builder's
// absolute filename, an environment override, or a substituted source digest.
function repositoryRoot() {
  for (const start of [__dirname, process.cwd()]) {
    let directory = realpathSync(start);
    for (let n = 0; n < 16; n++) {
      if (existsSync(resolve(directory, "finnor-os/packages/private-equity/src/decision-slice/contracts.ts"))
        && existsSync(resolve(directory, "package-lock.json"))
        && existsSync(resolve(directory, "finnor-os/package-lock.json"))) return directory;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error("CANONICAL_RUNTIME_SOURCE_TREE_UNAVAILABLE");
}
function sourcePath(relativePath) {
  if (!/^finnor-os\/(?:packages|scripts|apps)\/[^\\]*\.(?:[cm]?ts|tsx|[cm]?js)$/.test(relativePath)
    || relativePath.split("/").includes("..")) throw new Error("INVALID_RUNTIME_SOURCE_PATH");
  const path = resolve(repositoryRoot(), relativePath);
  if (!existsSync(path)) throw new Error("CANONICAL_RUNTIME_SOURCE_FILE_UNAVAILABLE");
  return path;
}
exports.sourceDirectory = relativePath => dirname(sourcePath(relativePath));
exports.sourceURL = relativePath => pathToFileURL(sourcePath(relativePath)).href;
