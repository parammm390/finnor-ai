const { createHash } = require("node:crypto");
const { readFileSync, readSync, readlinkSync, existsSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, readdirSync, constants } = require("node:fs");
const { resolve, dirname, sep, join } = require("node:path");

// The fixed sibling manifest belongs to this installation. Neither CWD nor an
// environment variable can select a different source tree or artifact.
const root = realpathSync(resolve(__dirname, "../../.."));
const candidates = ["finnor-os/x1-development-installation.json", "finnor-os/w2-development-installation.json"];
const available = candidates.filter(path => existsSync(resolve(root, path)));
if (available.length > 1) throw Error("OWNED_INSTALLATION_PROFILE_AMBIGUOUS");
const manifestPath = resolve(root, available[0] || candidates[0]);
const schema = available[0] === candidates[1]
  ? "finnor.postz.w2.development-installation.v1" : "finnor.x1.development-installation.v1";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let loadedPlan;
const measured = new Map();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
function measuredFileHash(path, observed = lstatSync(path, { bigint: true })) {
  if (!observed.isFile()) throw Error('X1_INSTALLATION_FILE_OUTSIDE_CUSTODY');
  const previous = measured.get(path);
  if (previous && sameFile(previous.metadata, observed)) return previous.sha256;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let actual;
  try {
    const held = fstatSync(fd, { bigint: true });
    if (!held.isFile() || !sameFile(held, observed)) throw Error('X1_INSTALLATION_FILE_CHANGED_DURING_CHECK');
    const hash = createHash('sha256');
    let count, bytes = 0n;
    while ((count = readSync(fd, hashBuffer, 0, hashBuffer.length, null)) !== 0) {
      hash.update(hashBuffer.subarray(0, count)); bytes += BigInt(count);
    }
    if (bytes !== held.size || !sameFile(fstatSync(fd, { bigint: true }), observed))
      throw Error('X1_INSTALLATION_FILE_CHANGED_DURING_CHECK');
    actual = hash.digest('hex');
  } finally { closeSync(fd); }
  measured.set(path, { metadata: observed, sha256: actual });
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
function readManifest() {
  const manifestStat = lstatSync(manifestPath, { bigint: true });
  if (!manifestStat.isFile() || (manifestStat.mode & 0o7777n) !== 0o444n)
    throw Error("X1_INSTALLATION_MANIFEST_PATH_OR_MODE_REFUSED");
  const fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(fstatSync(fd, { bigint: true }), manifestStat))
      throw Error("X1_INSTALLATION_FILE_CHANGED_DURING_CHECK");
    const bytes = readFileSync(fd);
    if (BigInt(bytes.length) !== manifestStat.size || !sameFile(fstatSync(fd, { bigint: true }), manifestStat))
      throw Error("X1_INSTALLATION_FILE_CHANGED_DURING_CHECK");
    return bytes;
  } finally { closeSync(fd); }
}
function freezeJson(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function prepareManifest(bytes, manifestDigest) {
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== schema || manifest.mode !== "DEVELOPMENT_ONLY"
      || manifest.productionActive !== false || manifest.executionAuthorityGranted !== false
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.checkerPins) || !Array.isArray(manifest.links)
      || manifest.runtime.node !== process.version || manifest.runtime.platform !== process.platform
      || manifest.runtime.architecture !== process.arch) {
    throw Error("X1_INSTALLATION_CONTRACT_OR_RUNTIME_MISMATCH");
  }
  const directories = new Set(), declared = new Set();
  const files = manifest.files.map(pin => {
    if (!/^[a-f0-9]{64}$/.test(pin.sha256) || declared.has(pin.path))
      throw Error("X1_INSTALLATION_PIN_INVALID");
    const path = pathInRoot(pin.path);
    for (let directory = dirname(path); directory !== root && !directories.has(directory); directory = dirname(directory))
      directories.add(directory);
    declared.add(pin.path);
    return { path, pin };
  });
  const links = manifest.links.map(link => {
    if (typeof link.path !== "string" || link.path.startsWith("/") || link.path.includes("\\")
        || link.path.split("/").some(p => !p || p === "." || p === "..") || typeof link.target !== "string")
      throw Error("X1_INSTALLATION_LINK_INVALID");
    return { path: resolve(root, link.path), link };
  });
  for (const entry of Object.values(manifest.entrypoints)) {
    if (!declared.has(entry)) throw Error("X1_INSTALLATION_ENTRYPOINT_UNPINNED");
  }
  for (const path of manifest.checkerPins) if (!declared.has(path)) throw Error("X1_INSTALLATION_CHECKER_CLOSURE_UNPINNED");
  const scientificRoots = [...new Set(Object.values(manifest.entrypoints)
    .filter(entry => typeof entry === "string" && entry.startsWith("finnor-os/scientific/"))
    .map(entry => pathInRoot(entry.split("/").slice(0, 3).join("/"))))];
  return { manifest: freezeJson(manifest), manifestDigest, files, links, scientificRoots,
    declared, declaredLinks: new Set(manifest.links.map(link => link.path)),
    directories: [...directories].sort((a, b) => a.length - b.length) };
}
function installedRuntime(required = false) {
  if (!existsSync(manifestPath)) {
    if (required || loadedPlan) throw Error("X1_COMPILED_INSTALLATION_MANIFEST_REQUIRED");
    return null;
  }
  const bytes = readManifest(), manifestDigest = sha(bytes);
  if (loadedPlan && loadedPlan.manifestDigest !== manifestDigest) throw Error("X1_LOADED_INSTALLATION_MANIFEST_CHANGED");
  // Reuse the immutable path plan. Inspect every declared directory, link and
  // file, and the closed scientific import namespace, on every call.
  const plan = loadedPlan ?? prepareManifest(bytes, manifestDigest);
  const { manifest } = plan;
  if (manifest.runtime.nodeBinarySha256 !== measuredFileHash(realpathSync(process.execPath)))
    throw Error("X1_INSTALLATION_CONTRACT_OR_RUNTIME_MISMATCH");
  for (const directory of plan.directories)
    if (!lstatSync(directory).isDirectory()) throw Error("X1_INSTALLATION_DIRECTORY_REPLACED");
  for (const { path, link } of plan.links) {
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== link.target
        || !realpathSync(path).startsWith(root + sep)) throw Error("X1_INSTALLATION_LINK_PIN_MISMATCH:" + link.path);
  }
  for (const { path, pin } of plan.files) {
    const observed = lstatSync(path, { bigint: true });
    if (!observed.isFile()) throw Error("X1_INSTALLATION_FILE_OUTSIDE_CUSTODY");
    if (!Number.isInteger(pin.mode) || Number(observed.mode & 0o7777n) !== pin.mode)
      throw Error("X1_INSTALLATION_FILE_MODE_MISMATCH:" + pin.path);
    if (measuredFileHash(path, observed) !== pin.sha256) throw Error("X1_INSTALLATION_BYTE_PIN_MISMATCH:" + pin.path);
  }
  for (const rootPath of plan.scientificRoots) {
    const pending = [rootPath];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) { pending.push(absolute); continue; }
        const relative = absolute.slice(root.length + 1);
        const listed = entry.isSymbolicLink() ? plan.declaredLinks.has(relative) : plan.declared.has(relative);
        if (!listed) throw Error("X1_INSTALLATION_UNLISTED_SCIENTIFIC_INPUT:" + relative);
      }
    }
  }
  loadedPlan = plan;
  return { root, manifestPath, manifestDigest, manifest,
    entrypoint: name => safeFile(manifest.entrypoints[name]),
    checkerPins: () => Object.fromEntries([...new Set([manifestPath,
      ...manifest.checkerPins.map(safeFile), realpathSync(process.execPath)])].sort().map(path => [path, measuredFileHash(path)])) };
}
exports.installedRuntime = installedRuntime;
