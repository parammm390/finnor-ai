const { createHash } = require("node:crypto");
const { readFileSync, readlinkSync, existsSync, realpathSync, lstatSync } = require("node:fs");
const { resolve, sep } = require("node:path");

// The fixed sibling manifest belongs to this installation. Neither CWD nor an
// environment variable can select a different source tree or artifact.
const root = realpathSync(resolve(__dirname, "../../.."));
const manifestPath = resolve(root, "finnor-os/x1-development-installation.json");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let loadedDigest;
function safeFile(relative) {
  if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\")
      || relative.split("/").some(p => !p || p === "." || p === "..")) throw Error("X1_INSTALLATION_PATH_INVALID");
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep) || !realpathSync(path).startsWith(root + sep)
      || !lstatSync(path).isFile()) throw Error("X1_INSTALLATION_FILE_OUTSIDE_CUSTODY");
  return path;
}
function installedRuntime(required = false) {
  if (!existsSync(manifestPath)) {
    if (required) throw Error("X1_COMPILED_INSTALLATION_MANIFEST_REQUIRED");
    return null;
  }
  const bytes = readFileSync(manifestPath), manifestDigest = sha(bytes);
  if (loadedDigest && loadedDigest !== manifestDigest) throw Error("X1_LOADED_INSTALLATION_MANIFEST_CHANGED");
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== "finnor.x1.development-installation.v1" || manifest.mode !== "DEVELOPMENT_ONLY"
      || manifest.productionActive !== false || manifest.executionAuthorityGranted !== false
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.checkerPins) || !Array.isArray(manifest.links)
      || manifest.runtime.node !== process.version || manifest.runtime.platform !== process.platform
      || manifest.runtime.architecture !== process.arch
      || manifest.runtime.nodeBinarySha256 !== sha(readFileSync(process.execPath))) {
    throw Error("X1_INSTALLATION_CONTRACT_OR_RUNTIME_MISMATCH");
  }
  const declared = new Map();
  for (const link of manifest.links) {
    if (typeof link.path !== 'string' || link.path.startsWith('/') || link.path.includes('\\')
        || link.path.split('/').some(p => !p || p === '.' || p === '..') || typeof link.target !== 'string')
      throw Error('X1_INSTALLATION_LINK_INVALID');
    const path = resolve(root, link.path);
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== link.target
        || !realpathSync(path).startsWith(root + sep)) throw Error('X1_INSTALLATION_LINK_PIN_MISMATCH:' + link.path);
  }
  for (const pin of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(pin.sha256) || declared.has(pin.path)) throw Error("X1_INSTALLATION_PIN_INVALID");
    const path = safeFile(pin.path);
    if (!Number.isInteger(pin.mode) || (lstatSync(path).mode & 0o777) !== pin.mode)
      throw Error('X1_INSTALLATION_FILE_MODE_MISMATCH:' + pin.path);
    if (sha(readFileSync(path)) !== pin.sha256) throw Error("X1_INSTALLATION_BYTE_PIN_MISMATCH:" + pin.path);
    declared.set(pin.path, pin.sha256);
  }
  for (const entry of Object.values(manifest.entrypoints)) {
    if (!declared.has(entry)) throw Error("X1_INSTALLATION_ENTRYPOINT_UNPINNED");
  }
  for (const path of manifest.checkerPins) if (!declared.has(path)) throw Error("X1_INSTALLATION_CHECKER_CLOSURE_UNPINNED");
  loadedDigest = manifestDigest;
  return { root, manifestPath, manifestDigest, manifest,
    entrypoint: name => safeFile(manifest.entrypoints[name]),
    checkerPins: () => Object.fromEntries([...new Set([manifestPath,
      ...manifest.checkerPins.map(safeFile), process.execPath])].sort().map(path => [path, sha(readFileSync(path))])) };
}
exports.installedRuntime = installedRuntime;
