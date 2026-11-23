/** Standalone exact-archive source reconstruction. No Git or module fallback.
 * Installed engineering is separately guarded and never starts DB/Auth/services. */
import { readFile, writeFile, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const installRequiredFreeBytes = 8 * 1024 ** 3;
async function installationHeadroom(directory) {
  const space = await statfs(directory), available = Number(space.bavail) * Number(space.bsize);
  const measured = Number.isSafeInteger(available) && available >= 0, sufficient = measured && available >= installRequiredFreeBytes;
  return { state: sufficient ? "PASSED_INSTALLATION_HEADROOM_ONLY" : measured ? "BLOCKED_INSUFFICIENT_DISK" : "BLOCKED_UNVERIFIED_DISK",
    exit: sufficient ? 0 : 2, requiredFreeBytes: installRequiredFreeBytes, actualFreeBytes: measured ? available : null,
    installedZ5Proof: false, databaseActions: 0, listenersStarted: 0, installsStarted: 0 };
}
async function memoryHeadroom(profile) {
  if (!["process", "graph"].includes(profile)) throw Error("EXACT_PROCESS_OR_GRAPH_MEMORY_PROFILE_REQUIRED");
  const requiredAvailableBytes = (profile === "process" ? 4 : 6) * 1024 ** 3;
  let actualAvailableBytes = null;
  try {
    const memory = await readFile("/proc/meminfo", "utf8");
    const value = Number(/^MemAvailable:\s+([0-9]+)\s+kB$/m.exec(memory)?.[1]) * 1024;
    if (Number.isSafeInteger(value) && value >= 0) actualAvailableBytes = value;
  } catch { /* Unavailable memory metadata cannot authorize a child. */ }
  const measured = actualAvailableBytes !== null, sufficient = measured && actualAvailableBytes >= requiredAvailableBytes;
  return { state: sufficient ? "PASSED_MEMORY_HEADROOM_ONLY" : measured ? "BLOCKED_INSUFFICIENT_MEMORY" : "BLOCKED_UNVERIFIED_MEMORY",
    profile, exit: sufficient ? 0 : 2, requiredAvailableBytes, actualAvailableBytes,
    installedZ5Proof: false, databaseActions: 0, listenersStarted: 0, installsStarted: 0 };
}
if (process.argv[2] === "--memory-headroom") {
  if (process.argv.length !== 4 || process.version !== "v22.23.4")
    throw Error("EXACT_MEMORY_PROFILE_AND_NODE22_REQUIRED");
  const report = await memoryHeadroom(process.argv[3]);
  console.log(JSON.stringify({ ...report, sourceSha256: sha(await readFile(fileURLToPath(import.meta.url))) }));
  process.exit(report.exit);
}
// Read-only diagnostic, also called inside each already-held install lock.
// It never authenticates a receipt, extracts source or invokes npm.
if (process.argv[2] === "--installation-headroom") {
  if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3] ?? "") || process.version !== "v22.23.4")
    throw Error("EXACT_ABSOLUTE_HEADROOM_DIRECTORY_AND_NODE22_REQUIRED");
  const report = await installationHeadroom(process.argv[3]);
  console.log(JSON.stringify({ ...report, sourceSha256: sha(await readFile(fileURLToPath(import.meta.url))) }));
  process.exit(report.exit);
}
const [receiptPath, expectedReceiptSha256, destination, mode = "--offline-replay"] = process.argv.slice(2);
if (![receiptPath, destination].every(p => p && path.isAbsolute(p))
  || !/^[a-f0-9]{64}$/.test(expectedReceiptSha256 ?? "")
  || !["--offline-replay", "--extract-only", "--install-engineering"].includes(mode)
  || process.version !== "v22.23.4") throw Error("EXACT_ABSOLUTE_RECEIPT_DESTINATION_NODE22_AND_MODE_REQUIRED");
const receiptBytes = await readFile(receiptPath);
if (sha(receiptBytes) !== expectedReceiptSha256) throw Error("DELIVERY_RECEIPT_PREIMAGE_MISMATCH");
const receipt = JSON.parse(receiptBytes), delivery = path.dirname(receiptPath);
const member = name => {
  if (typeof name !== "string" || path.basename(name) !== name || !/^[A-Za-z0-9_.-]+$/.test(name))
    throw Error("DELIVERY_MEMBER_ESCAPE");
  return path.join(delivery, name);
};
if (receipt.schema !== "finnor.z5.reconstruction-delivery.v1"
  || sha(await readFile(fileURLToPath(import.meta.url))) !== receipt.reconstructorSha256)
  throw Error("EXACT_DELIVERED_RECONSTRUCTOR_REQUIRED");
const manifestBytes = await readFile(member(receipt.manifest));
if (sha(manifestBytes) !== receipt.manifestSha256) throw Error("SOURCE_MANIFEST_PREIMAGE_MISMATCH");
const manifest = JSON.parse(manifestBytes);
const lock = process.env.FINNOR_Z5_HEAVY_LOCK;
if (mode !== "--extract-only" && (!lock || !path.isAbsolute(lock))) throw Error("EXPLICIT_ABSOLUTE_SHARED_HEAVY_LOCK_REQUIRED");
if (mode === "--install-engineering") {
  const headroom = await installationHeadroom(path.dirname(destination));
  if (headroom.exit !== 0) {
    const report = { ...headroom, sourceHead: receipt.sourceHead };
    await writeFile(path.join(delivery, "installed-engineering-guard.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(report)); process.exit(2);
  }
}
const environment = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", LANG: "C.UTF-8",
  PYTHONDONTWRITEBYTECODE: "1", FINNOR_Z5_DECLARED_RECONSTRUCTION: "EXACT_MANIFEST",
  FINNOR_Z5_SOURCE_ROOT: destination };
const steps = [];
// The same flock owns preflight and npm. No stale pre-extraction measurement
// or lock release can authorize either root/backend dependency installation.
const installUnderLock = String.raw`
import { spawnSync } from "node:child_process";
const guard = spawnSync(process.execPath, [process.argv[1], "--installation-headroom", process.cwd()], { stdio: "inherit" });
if (guard.error || guard.status !== 0) {
  console.error(JSON.stringify({ stage: "INSTALLATION_HEADROOM", exitCode: guard.status, signal: guard.signal,
    spawnError: guard.error?.code ?? null }));
  process.exit(guard.error ? 1 : guard.status ?? 1);
}
const install = spawnSync("/usr/bin/npm", ["ci", "--no-audit", "--no-fund"], { stdio: "inherit" });
if (install.error || install.signal) console.error(JSON.stringify({ stage: "NPM_CI", exitCode: install.status,
  signal: install.signal, spawnError: install.error?.code ?? null }));
process.exit(install.error ? 1 : install.status ?? 1);
`;
const memoryUnderLock = String.raw`
import { spawnSync } from "node:child_process";
const [driver, profile, executable, ...args] = process.argv.slice(1);
const guard = spawnSync(process.execPath, [driver, "--memory-headroom", profile], { stdio: "inherit" });
if (guard.error || guard.status !== 0) {
  console.error(JSON.stringify({ stage: "MEMORY_HEADROOM", exitCode: guard.status, signal: guard.signal,
    spawnError: guard.error?.code ?? null }));
  // Exit 2 belongs to the real native authority guard, never this preflight.
  process.exit(1);
}
const child = spawnSync(executable, args, { stdio: "inherit" });
if (child.error || child.signal) console.error(JSON.stringify({ stage: "GUARDED_CHILD", exitCode: child.status,
  signal: child.signal, spawnError: child.error?.code ?? null }));
process.exit(child.error ? 1 : child.status ?? 1);
`;
async function run(name, executable, args, expectedExit = 0, cwd = destination, extra = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...environment, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", bounded = false;
    const stopOwnedGroup = () => {
      bounded = true;
      if (Number.isSafeInteger(child.pid) && child.pid > 1) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The owned group may already be gone. */ }
      }
    };
    const timer = setTimeout(stopOwnedGroup, mode === "--install-engineering" ? 1200000 : 180000);
    child.stdout.on("data", b => { out += b; if (Buffer.byteLength(out) > 4 * 1024 * 1024) stopOwnedGroup(); });
    child.stderr.on("data", b => { err += b; if (Buffer.byteLength(err) > 1024 * 1024) stopOwnedGroup(); });
    child.on("error", () => undefined);
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timer);
      const result = { name, exitCode, signal, expectedExit, bounded, processGroupId: child.pid ?? null,
        stdout: out, stderr: err, wallMs: performance.now() - started };
      steps.push(result);
      try {
        if (name !== "exact-source-extraction") await writeFile(path.join(destination, "scope-z/phase-evidence/z5/reconstruction", name + ".json"),
          JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        if (exitCode !== expectedExit || bounded) reject(Error("RECONSTRUCTION_STEP_REFUSED:" + name));
        else resolve(result);
      } catch (error) { reject(error); }
    });
  });
}
async function runUnderLock(name, profile, executable, args, expectedExit = 0, cwd = destination, extra = {}) {
  return run(name, "/usr/bin/flock", [lock, process.execPath, "--input-type=module", "-e", memoryUnderLock,
    fileURLToPath(import.meta.url), profile, executable, ...args], expectedExit, cwd, extra);
}
// Python's standard library is an explicitly declared native asset. It never
// extracts links, uses extractall, reads outside the delivery or opens a socket.
const extractor = String.raw`
import sys,pathlib,json,hashlib,tarfile,os,stat,shutil
if sys.version_info[:3]!=(3,12,3): raise RuntimeError("PINNED_PYTHON_3_12_3_REQUIRED")
archive,manifest_file,target,archive_hash=sys.argv[1:]
target=pathlib.Path(target)
raw=pathlib.Path(manifest_file).read_bytes()
m=json.loads(raw)
if m.get("schema")!="finnor.z5.exact-source-reconstruction.v1": raise RuntimeError("MANIFEST_SCHEMA")
if target.exists() or target.is_symlink(): raise RuntimeError("FRESH_TARGET_REQUIRED")
files=m.get("files")
if not isinstance(files,list) or not 1<=len(files)<=16384: raise RuntimeError("MANIFEST_COUNT")
expected={}
for entry in files:
 p=entry["path"]
 if not isinstance(p,str) or pathlib.PurePosixPath(p).is_absolute() or "\\" in p or any(x in ("..",".",".git","node_modules","") for x in p.split("/")) or p in expected:
  raise RuntimeError("MANIFEST_ESCAPE_OR_DUPLICATE")
 if not isinstance(entry["bytes"],int) or entry["bytes"]<0 or entry["bytes"]>256*1024**2 or entry["mode"] not in ("100644","100755"):
  raise RuntimeError("MANIFEST_BOUND")
 expected[p]=entry
total=sum(e["bytes"] for e in files)
if total!=m["uncompressedBytes"] or total>512*1024**2 or shutil.disk_usage(target.parent).free<total*2+128*1024**2:
 raise RuntimeError("SAFE_SOURCE_ONLY_HEADROOM")
actual_hash=hashlib.sha256()
with open(archive,"rb") as source:
 for chunk in iter(lambda:source.read(1024*1024),b""): actual_hash.update(chunk)
if actual_hash.hexdigest()!=archive_hash: raise RuntimeError("ARCHIVE_PREIMAGE")
target.mkdir(mode=0o700)
seen=set()
with tarfile.open(archive,"r:gz") as package:
 for item in package:
  if not item.isfile() or item.name not in expected or item.name in seen or item.size!=expected[item.name]["bytes"]:
   raise RuntimeError("UNDECLARED_LINK_OR_DUPLICATE_ARCHIVE_MEMBER")
  seen.add(item.name)
  output=target/item.name
  output.parent.mkdir(parents=True,exist_ok=True)
  check=hashlib.sha256()
  with package.extractfile(item) as source,output.open("xb") as sink:
   for chunk in iter(lambda:source.read(1024*1024),b""): check.update(chunk);sink.write(chunk)
  if check.hexdigest()!=expected[item.name]["sha256"]: raise RuntimeError("EXACT_SOURCE_MEMBER_CHANGED")
  os.chmod(output,0o755 if expected[item.name]["mode"]=="100755" else 0o644)
if seen!=set(expected): raise RuntimeError("MISSING_SOURCE_MEMBER")
where=target/"scope-z/phase-evidence/z5/reconstruction"
where.mkdir(parents=True,exist_ok=True)
(where/"source-manifest.json").write_bytes(raw)
print(json.dumps({"state":"PASSED_EXACT_SOURCE_EXTRACTION","files":len(seen),"bytes":total,"sourceHead":m["sourceHead"],"gitPresent":False,"nodeModulesPresent":False,"databaseActions":0}))
`;
try {
  await run("exact-source-extraction", "/usr/bin/python3", ["-I", "-B", "-c", extractor,
    member(receipt.archive), member(receipt.manifest), destination, receipt.archiveSha256], 0, delivery);
  const scripts = path.join(destination, "finnor-os/scripts/project-z/z5"), evidence = path.join(destination, "scope-z/phase-evidence/z5/reconstruction");
  if (mode !== "--extract-only") {
    const membership = `const m=await import(${JSON.stringify("file://" + path.join(scripts, "source-identity.ts"))});const h=await m.exactSourceHead(process.argv[1]);if(h!==process.argv[2])throw Error("EXACT_SOURCE_HEAD");console.log(JSON.stringify({sourceHead:h,parentGitAdopted:false,declaredManifest:true}));`;
    await run("explicit-no-git-membership", process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", membership, destination, receipt.sourceHead]);
    for (const [name, file, expected] of [["source-finite-boundary-e2e", "finite-boundary-e2e.mjs", 0],
      ["source-process-e2e", "process-e2e.mjs", 0], ["source-recovery-e2e", "recovery-e2e.mjs", 0], ["source-native-guard", "native-e2e.mjs", 2]])
      await runUnderLock(name, "process", process.execPath,
        ["--experimental-strip-types", "--max-old-space-size=384", path.join(scripts, file), path.join(evidence, name)], expected);
  }
  if (mode === "--install-engineering") {
    const npm = await run("installed-npm-version", "/usr/bin/npm", ["--version"]);
    if (npm.stdout.trim() !== "11.19.1") throw Error("RECONSTRUCTION_STEP_REFUSED:PINNED_NPM_VERSION");
    for (const [name, cwd] of [["root-ci", destination], ["backend-ci", path.join(destination, "finnor-os")]])
      await runUnderLock(name, "graph", process.execPath, ["--input-type=module", "-e", installUnderLock,
        fileURLToPath(import.meta.url)], 0, cwd);
    for (const graph of ["backend", "frontend"])
      await runUnderLock(graph + "-installed-proposed-types", "graph", process.execPath, ["--max-old-space-size=4096",
        path.join(scripts, "check-graphs.mjs"), destination, graph,
        path.join(destination, "finnor-os/node_modules/typescript/lib/typescript.js"), destination,
        path.join(destination, manifest.integrationManifest)]);
    for (const command of ["workspace:check", "centropy:manifest:check", "centropy:coverage:check", "centropy:client:check", "centropy:forms:check", "lint"])
      await runUnderLock("installed-" + command.replaceAll(":", "-"), "graph", "/usr/bin/npm", ["run", command], 0, destination,
        { NODE_OPTIONS: command === "centropy:coverage:check"
          ? "--max-old-space-size=4096 --experimental-strip-types --import " + JSON.stringify(path.join(scripts, "source-metadata.mjs"))
          : "--max-old-space-size=4096" });
    for (const [name, cwd] of [["baseline-frontend-build", destination], ["baseline-api-build", path.join(destination, "finnor-os/apps/api")]])
      await runUnderLock(name, "graph", "/usr/bin/npm", ["run", "build"], 0, cwd, { NODE_OPTIONS: "--max-old-space-size=1536" });
  }
  const report = { schema: "finnor.z5.reconstructed-source-replay.v1",
    state: mode === "--extract-only" ? "PASSED_EXACT_SOURCE_EXTRACTION" : "PASSED_SOURCE_ENGINEERING_REPLAY",
    sourceHead: receipt.sourceHead, sourceTree: receipt.sourceTree, receiptSha256: expectedReceiptSha256,
    patchSha256: receipt.patchSha256, integrationApplied: false,
    steps: steps.map(({ stdout, stderr, ...result }) => result), borrowedModules: false, hiddenSourceFallback: false,
    installedEngineeringRequested: mode === "--install-engineering", installedNativeQualification: "NOT_RUN",
    applicationBuildScope: "BASELINE_PLUS_OWNED_LEAVES_WITH_SHARED_Z5_PROPOSAL_UNAPPLIED",
    protectedAdmission: false, productionActivated: false, databaseActions: 0, listenersStarted: 0 };
  await writeFile(path.join(destination, "scope-z/phase-evidence/z5/reconstruction/report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { state: "FAILED_SOURCE_ENGINEERING_REPLAY", sourceHead: receipt.sourceHead,
    reason: error instanceof Error && /^RECONSTRUCTION_STEP_REFUSED:/.test(error.message) ? error.message : "EXACT_RECONSTRUCTION_DEPENDENCY_OR_SOURCE_REFUSAL",
    steps: steps.map(({ stdout, stderr, ...result }) => result), installedNativeQualification: "NOT_RUN", databaseActions: 0, listenersStarted: 0 };
  await writeFile(path.join(delivery, "reconstruction-failure.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report)); process.exitCode = 1;
}
