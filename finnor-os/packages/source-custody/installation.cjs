const { createHash } = require("node:crypto");
const { readFileSync, readSync, readlinkSync, existsSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, constants } = require("node:fs");
const { resolve, dirname, sep } = require("node:path");

// The fixed sibling manifest belongs to this installation. Neither CWD nor an
// environment variable can select a different source tree or artifact.
const root = realpathSync(resolve(__dirname, "../../.."));
const manifestPath = resolve(root, "finnor-os/x1-development-installation.json");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let loadedDigest;
const measured = new Map();
const metadata = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode].join(':');
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
function measuredFileHash(path, observed = lstatSync(path, { bigint: true })) {
  if (!observed.isFile()) throw Error('X1_INSTALLATION_FILE_OUTSIDE_CUSTODY');
  const current = metadata(observed), previous = measured.get(path);
  if (previous?.metadata === current) return previous.sha256;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let actual;
  try {
    const held = fstatSync(fd, { bigint: true });
    if (!held.isFile() || metadata(held) !== current) throw Error('X1_INSTALLATION_FILE_CHANGED_DURING_CHECK');
    const hash = createHash('sha256');
    let count, bytes = 0n;
    while ((count = readSync(fd, hashBuffer, 0, hashBuffer.length, null)) !== 0) {
      hash.update(hashBuffer.subarray(0, count)); bytes += BigInt(count);
    }
    if (bytes !== held.size || metadata(fstatSync(fd, { bigint: true })) !== current)
      throw Error('X1_INSTALLATION_FILE_CHANGED_DURING_CHECK');
    actual = hash.digest('hex');
  } finally { closeSync(fd); }
  measured.set(path, { metadata: current, sha256: actual });
  return actual;
}
function pathInRoot(relative) {
  if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\")
      || relative.split("/").some(p => !p || p === "." || p === "..")) throw Error("X1_INSTALLATION_PATH_INVALID");
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) throw Error("X1_INSTALLATION_FILE_OUTSIDE_CUSTODY");
  return path;
}
function safeFile(relative) {
  const path = pathInRoot(relative);
  if (!realpathSync(path).startsWith(root + sep)
      || !lstatSync(path).isFile()) throw Error("X1_INSTALLATION_FILE_OUTSIDE_CUSTODY");
  return path;
}
function installedRuntime(required = false) {
  if (!existsSync(manifestPath)) {
    if (required || loadedDigest) throw Error("X1_COMPILED_INSTALLATION_MANIFEST_REQUIRED");
    return null;
  }
  const manifestStat = lstatSync(manifestPath, { bigint: true });
  if (!manifestStat.isFile() || (manifestStat.mode & 0o7777n) !== 0o444n)
    throw Error('X1_INSTALLATION_MANIFEST_PATH_OR_MODE_REFUSED');
  const manifestFd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    if (metadata(fstatSync(manifestFd, { bigint: true })) !== metadata(manifestStat))
      throw Error('X1_INSTALLATION_FILE_CHANGED_DURING_CHECK');
    bytes = readFileSync(manifestFd);
    if (BigInt(bytes.length) !== manifestStat.size || metadata(fstatSync(manifestFd, { bigint: true })) !== metadata(manifestStat))
      throw Error('X1_INSTALLATION_FILE_CHANGED_DURING_CHECK');
  } finally { closeSync(manifestFd); }
  const manifestDigest = sha(bytes);
  if (loadedDigest && loadedDigest !== manifestDigest) throw Error("X1_LOADED_INSTALLATION_MANIFEST_CHANGED");
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== "finnor.x1.development-installation.v1" || manifest.mode !== "DEVELOPMENT_ONLY"
      || manifest.productionActive !== false || manifest.executionAuthorityGranted !== false
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.checkerPins) || !Array.isArray(manifest.links)
      || manifest.runtime.node !== process.version || manifest.runtime.platform !== process.platform
      || manifest.runtime.architecture !== process.arch
      || manifest.runtime.nodeBinarySha256 !== measuredFileHash(realpathSync(process.execPath))) {
    throw Error("X1_INSTALLATION_CONTRACT_OR_RUNTIME_MISMATCH");
  }
  const declared = new Map();
  // All regular-file parent paths must be real directories. Validate each
  // namespace component once; declared alias links are checked separately.
  const directories = new Set();
  for (const pin of manifest.files) {
    let directory = dirname(pathInRoot(pin.path));
    while (directory !== root) { directories.add(directory); directory = dirname(directory); }
  }
  for (const directory of [...directories].sort((a,b) => a.length-b.length))
    if (!lstatSync(directory).isDirectory()) throw Error('X1_INSTALLATION_DIRECTORY_REPLACED');
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
    const path = pathInRoot(pin.path), observed = lstatSync(path, { bigint: true });
    if (!observed.isFile()) throw Error('X1_INSTALLATION_FILE_OUTSIDE_CUSTODY');
    if (!Number.isInteger(pin.mode) || Number(observed.mode & 0o7777n) !== pin.mode)
      throw Error('X1_INSTALLATION_FILE_MODE_MISMATCH:' + pin.path);
    const actual = measuredFileHash(path, observed);
    if (actual !== pin.sha256) throw Error("X1_INSTALLATION_BYTE_PIN_MISMATCH:" + pin.path);
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
      ...manifest.checkerPins.map(safeFile), realpathSync(process.execPath)])].sort().map(path => [path, measuredFileHash(path)])) };
}
exports.installedRuntime = installedRuntime;
