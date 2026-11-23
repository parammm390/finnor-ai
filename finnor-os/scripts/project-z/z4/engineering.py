"""Finite isolated product reconstruction. Never initializes a runtime target."""
import argparse
import ast
import base64
import difflib
import fcntl
import hashlib
import json
import os
import platform
from pathlib import Path
import runpy
import shutil
import signal
import stat
import subprocess
import tarfile
import time

HERE = Path(__file__).resolve().parent
R = runpy.run_path(str(HERE / "reconstruct.py"))
NATIVE = "finnor-os/packages/epistemic-runtime/native/z4-execution-proof"
LOCK = Path("/home/factory-user/repos/finnor-z-shared-heavy.lock")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(path, 0o600)


def check(condition, predicate):
    if not condition:
        raise RuntimeError(predicate)


def inside(path, root):
    return path.resolve().is_relative_to(root.resolve()) and not path.is_symlink()


def runtime(target):
    node = target / ".z4-toolchains/node/bin/node"
    npm = target / ".z4-toolchains/npm/bin/npm-cli.js"
    check(node.is_file() and npm.is_file(), "Z4_INDEPENDENT_NODE_NPM_REQUIRED")
    return node, npm


def environment(target):
    node, _ = runtime(target)
    home = target / ".z4-build-home"
    home.mkdir(mode=0o700, exist_ok=True)
    (home / "tmp").mkdir(mode=0o700, exist_ok=True)
    loader = target / "finnor-os/scripts/project-z/z4/isolation-loader.mjs"
    # No inherited DB, Auth, provider, upload token, telemetry or credential env.
    return {
        "PATH": str(node.parent) + ":/usr/bin:/bin", "HOME": str(home),
        "NODE_OPTIONS": "--max-old-space-size=4096 --import=" + str(loader), "CI": "1",
        "TMPDIR": str(home / "tmp"),
        "NEXT_TELEMETRY_DISABLED": "1", "DO_NOT_TRACK": "1",
        "PYTHONDONTWRITEBYTECODE": "1", "CARGO_BUILD_JOBS": "2",
        "RAYON_NUM_THREADS": "2", "CIRCLE_NODE_TOTAL": "2",
        "npm_config_jobs": "2", "npm_config_audit": "false",
        "npm_config_fund": "false", "npm_config_update_notifier": "false",
        "npm_config_cache": str(target / ".z4-npm-cache"),
        "npm_config_nodedir": str(target / ".z4-toolchains/node"),
        "FINNOR_ENVIRONMENT": "staging",
        "FINNOR_V4_PROFILE": "DISPOSABLE",
        "FINNOR_V4_NO_PERSISTENT_BUILD_CACHE": "1",
        "FINNOR_X1_FRONTEND_INSTALL": "1",
    }


class Run:
    def __init__(self, args, schema):
        self.a = args
        args.evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.report = {
            "schema": schema, "status": "RUNNING", "steps": [],
            "databaseActionsRequested": 0, "authActionsRequested": 0, "listenersStarted": 0,
            "childNetworkObservation": "NOT_INSTRUMENTED_CREDENTIAL_FREE_BUILD",
            "nativeOwner": "NOT_RUN", "protectedAdmission": "NOT_RUN",
        }

    def persist(self):
        save(self.a.evidence / "report.json", self.report)

    def command(self, name, command, cwd, env, timeout=2400):
        log_path = self.a.evidence / (name + ".log")
        start = time.monotonic()
        cpus = sorted(os.sched_getaffinity(0))[:2]
        row = {"name": name, "command": [str(v) for v in command], "cwd": str(cwd)}
        with log_path.open("xb") as output:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True,
                                       preexec_fn=lambda: os.sched_setaffinity(0, cpus))
            try:
                row["exit"] = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                row.update(exit=None, signal="TIMEOUT")
        row.update(wallMs=round((time.monotonic() - start) * 1000),
                   logSha256=sha(log_path), cpus=cpus)
        self.report["steps"].append(row)
        self.persist()
        return row["exit"] == 0

    def finish(self, status):
        self.report["status"] = status
        self.persist()
        print(json.dumps({"status": status, "steps": len(self.report["steps"]),
                          "evidence": str(self.a.evidence)}), flush=True)
        return 0 if status.startswith("PASSED_") else 1


def source_paths(target):
    return json.loads((target / "z4-source-paths.json").read_text())


def refresh_owned(a):
    run = Run(a, "finnor.z4.owned-stage-refresh.v1")
    old = json.loads(a.inventory.read_text())
    saved_identity = (a.target / NATIVE / "build-identity.json").read_bytes()
    built = json.loads(saved_identity)
    check(R["native_source_digest"](a.repository / NATIVE) == built["sourceDigest"],
          "Z4_NATIVE_SOURCE_CHANGED_REBUILD_REQUIRED")
    changes = []
    for entry in old["ownedFiles"]:
        rel = entry["path"]
        path = a.target / rel
        if rel == NATIVE + "/build-identity.json":
            continue
        check(path.is_file() and sha(path) == entry["sha256"], "Z4_OLD_STAGE_PREIMAGE_MISMATCH")
    for entry in R["owned_inventory"](a.repository):
        rel = entry["path"]
        if rel == NATIVE + "/build-identity.json":
            continue
        source, destination = a.repository / rel, a.target / rel
        if destination.is_file():
            os.chmod(destination, 0o600)
        destination.parent.mkdir(parents=True, exist_ok=True)
        previous = sha(destination) if destination.is_file() else None
        shutil.copyfile(source, destination)
        os.chmod(destination, 0o500 if source.stat().st_mode & stat.S_IXUSR else 0o400)
        if previous != entry["sha256"]:
            changes.append({"path": rel, "preimageSha256": previous, "postimageSha256": entry["sha256"]})
    check((a.target / NATIVE / "build-identity.json").read_bytes() == saved_identity,
          "Z4_REBUILT_NATIVE_IDENTITY_CHANGED")
    if (a.target / "z4-source-paths.json").is_file():
        save(a.target / "z4-source-paths.json",
             sorted(set(source_paths(a.target)) | {f["path"] for f in R["owned_inventory"](a.target)}))
    run.report.update(changes=changes, oldInventorySha256=sha(a.inventory),
                      rebuiltNativeIdentityPreserved=True, nativeSourceDigest=built["sourceDigest"])
    return run.finish("PASSED_EXACT_OWNED_STAGE_REFRESH_ONLY")


def inventory(target):
    paths = set(source_paths(target))
    # Include new source members too, not just modifications of the first list.
    for directory, dirs, names in os.walk(target):
        path = Path(directory)
        dirs[:] = [name for name in dirs if
                   name not in ("node_modules", ".git", "vendor-z4", ".cargo-home", ".cargo", ".toolchain", "target") and
                   not name.startswith((".next", ".z4-")) and
                   (path / name) != target / "scope-z/phase-evidence/z4"]
        for name in names:
            file = path / name
            if file.suffix in (".ts", ".tsx", ".mts", ".mjs", ".cjs", ".py", ".rs", ".toml",
                               ".json", ".sql", ".md", ".yaml", ".yml", ".sh") and not file.is_symlink():
                paths.add(str(file.relative_to(target)))
    for rel in paths:
        check((target / rel).is_file() and not (target / rel).is_symlink(),
              "Z4_DECLARED_SOURCE_MEMBER_MISSING_OR_SYMLINK")
    return [{"path": p, "sha256": sha(target / p)} for p in sorted(paths)]


def stage(a):
    run = Run(a, "finnor.z4.product-stage.v1")
    shared = json.loads((a.requests / "manifest.json").read_text())
    check(sha(a.requests / "combined.patch") == shared["combinedPatchSha256"],
          "Z4_SHARED_PATCH_DIGEST_MISMATCH")
    head = R["git"](a.repository, "rev-parse", "HEAD")
    tree = R["git"](a.repository, "rev-parse", "HEAD^{tree}")
    base_commit = shared["baseCommit"]
    check(subprocess.run(["git", "-C", str(a.repository), "merge-base", "--is-ancestor",
                          base_commit, head], capture_output=True).returncode == 0,
          "Z4_SHARED_PATCH_BASE_NOT_ANCESTOR")
    if a.target.exists():
        check(a.expand_core and (a.target / "stage-report.json").is_file(),
              "Z4_NEW_ISOLATED_TARGET_REQUIRED")
        check(not (a.target / "z4-source-paths.json").exists(),
              "Z4_PRODUCT_TARGET_ALREADY_EXPANDED")
        original = {f["path"]: f["sha256"] for f in R["owned_inventory"](a.repository)}
        staged = {f["path"]: f["sha256"] for f in R["owned_inventory"](a.target)}
        allowed = NATIVE + "/build-identity.json"
        check(all(staged.get(p) == h for p, h in original.items() if p != allowed),
              "Z4_CORE_STAGE_OWNED_SOURCE_MISMATCH")
    else:
        a.target.mkdir(mode=0o700, parents=True)
    check(inside(a.target, a.repository / "scope-z/phase-evidence/z4"),
          "Z4_TARGET_MUST_REMAIN_IN_OWNED_EVIDENCE")
    for request in shared["requests"]:
        path = a.repository / request["path"]
        check((not path.exists()) if request["requiresAbsent"] else
              sha(path) == request["preimageSha256"], "Z4_LIVE_SHARED_PREIMAGE_CHANGED")
    # A declared git archive, not the surrounding worktree or its Git objects.
    archive = subprocess.Popen(["git", "-C", str(a.repository), "archive", "--format=tar", base_commit],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
            tar.extractall(a.target, filter="data")
        error = archive.stderr.read()
        check(archive.wait() == 0, "Z4_BASE_ARCHIVE_FAILED:" + error.decode()[:300])
    finally:
        if archive.poll() is None:
            archive.kill()
            archive.wait()
    if not a.expand_core:
        R["copy_owned"](a.repository, a.target)
    for request in shared["requests"]:
        path = a.target / request["path"]
        check((not path.exists()) if request["requiresAbsent"] else
              sha(path) == request["preimageSha256"], "Z4_ARCHIVED_SHARED_PREIMAGE_MISMATCH")
    env = {"PATH": "/usr/bin:/bin", "HOME": str(a.target)}
    ok = run.command("apply-exact-shared-requests",
                     ["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i",
                      str(a.requests / "combined.patch")], a.target, env, timeout=120)
    check(ok, "Z4_ISOLATED_PATCH_APPLICATION_FAILED")
    for request in shared["requests"]:
        check(sha(a.target / request["path"]) == request["postimageSha256"],
              "Z4_ISOLATED_PATCH_POSTIMAGE_MISMATCH")
        live = a.repository / request["path"]
        check((not live.exists()) if request["requiresAbsent"] else
              sha(live) == request["preimageSha256"], "Z4_LIVE_SHARED_PREIMAGE_CHANGED")
    tracked = subprocess.run(["git", "-C", str(a.repository), "ls-tree", "-r", "--name-only", "-z", base_commit],
                             capture_output=True, check=True).stdout.decode().split("\0")
    owned = R["owned_inventory"](a.target)
    paths = sorted(set(filter(None, tracked)) | {p["path"] for p in owned} |
                   {p["path"] for p in shared["requests"]})
    save(a.target / "z4-source-paths.json", paths)
    provenance = {"schema": "finnor.z4.installed-source.v1", "sourceCommit": head,
                  "sourceTree": tree, "ownedSourceDigest": R["digest_bytes"](R["canonical"](owned)),
                  "sourceBaseCommit": base_commit,
                  "sourceBaseTree": R["git"](a.repository, "rev-parse", base_commit + "^{tree}"),
                  "originalOwnedSourceDigest": R["digest_bytes"](R["canonical"](R["owned_inventory"](a.repository))),
                  "sharedPatchSha256": shared["combinedPatchSha256"], "borrowedModules": False,
                  "borrowedBinaries": False, "gitObjectsRequired": False}
    save(a.target / "z4-reconstruction-source.json", provenance)
    run.report.update(provenance=provenance, source=inventory(a.target),
                      sharedFiles=len(shared["requests"]), liveSharedFilesWritten=0)
    return run.finish("PASSED_ISOLATED_SOURCE_STAGE_ONLY")


def rebind(a):
    """Rebind an unchanged composed tree to a reviewed local owned-source commit."""
    run = Run(a, "finnor.z4.source-lineage-rebind.v1")
    file = a.target / "z4-reconstruction-source.json"
    previous = json.loads(file.read_text())
    original_files, staged_files = R["owned_inventory"](a.repository), R["owned_inventory"](a.target)
    original = {f["path"]: f["sha256"] for f in original_files}
    staged = {f["path"]: f["sha256"] for f in staged_files}
    check(set(original) == set(staged) and all(staged.get(p) == h for p, h in original.items()
              if p != NATIVE + "/build-identity.json"), "Z4_REBIND_OWNED_SOURCE_MISMATCH")
    built = json.loads((a.target / NATIVE / "build-identity.json").read_text())
    check(R["native_source_digest"](a.target / NATIVE) == built["sourceDigest"] and
          sha(a.target / NATIVE / "bin/z4-proof") == built["binarySha256"],
          "Z4_REBIND_REBUILT_NATIVE_IDENTITY_MISMATCH")
    base = previous.get("sourceBaseCommit", previous["sourceCommit"])
    head = R["git"](a.repository, "rev-parse", "HEAD")
    check(subprocess.run(["git", "-C", str(a.repository), "merge-base", "--is-ancestor", base, head],
                         capture_output=True).returncode == 0, "Z4_REBIND_BASE_NOT_ANCESTOR")
    before_sha = sha(file)
    updated = {**previous, "sourceBaseCommit": base,
               "ownedSourceDigest": R["digest_bytes"](R["canonical"](staged_files)),
               "originalOwnedSourceDigest": R["digest_bytes"](R["canonical"](original_files)),
               "sourceBaseTree": R["git"](a.repository, "rev-parse", base + "^{tree}"),
               "sourceCommit": head, "sourceTree": R["git"](a.repository, "rev-parse", "HEAD^{tree}")}
    save(file, updated)
    run.report.update(preimageSha256=before_sha, postimageSha256=sha(file), provenance=updated)
    return run.finish("PASSED_EXACT_SOURCE_LINEAGE_REBIND_ONLY")


def update_requests(a):
    """Apply only an exact old-proposal to new-proposal transition in the target."""
    run = Run(a, "finnor.z4.exact-shared-stage-update.v1")
    old = json.loads((a.previous_requests / "manifest.json").read_text())
    new = json.loads((a.requests / "manifest.json").read_text())
    check(old["baseCommit"] == new["baseCommit"] and
          sha(a.requests / "combined.patch") == new["combinedPatchSha256"] and
          sha(HERE / "shared-requests.py") == new["generatorSha256"], "Z4_SHARED_UPDATE_IDENTITY")
    G = runpy.run_path(str(HERE / "shared-requests.py"))
    before, after, _ = G["proposals"](a.repository)
    previous = {entry["path"]: entry for entry in old["requests"]}
    check(set(previous).issubset(after), "Z4_SHARED_UPDATE_CANNOT_REMOVE_PRIOR_REQUEST")
    planned = []
    for entry in new["requests"]:
        rel = entry["path"]
        check(inside(a.target / rel, a.target), "Z4_SHARED_UPDATE_PATH_ESCAPE")
        check(hashlib.sha256(after[rel].encode()).hexdigest() == entry["postimageSha256"],
              "Z4_SHARED_UPDATE_PROJECTED_POSTIMAGE")
        live = a.repository / rel
        check(not live.exists() if entry["requiresAbsent"] else sha(live) == entry["preimageSha256"],
              "Z4_LIVE_SHARED_PREIMAGE_CHANGED")
        target = a.target / rel
        expected = previous[rel]["postimageSha256"] if rel in previous else entry["preimageSha256"]
        check(not target.exists() if expected is None else target.is_file() and sha(target) == expected,
              "Z4_SHARED_UPDATE_OLD_STAGE_PREIMAGE")
        if expected != entry["postimageSha256"]:
            planned.append({"path": rel, "preimageSha256": expected, "postimageSha256": entry["postimageSha256"]})
    lineage = a.target / "z4-reconstruction-source.json"
    p = json.loads(lineage.read_text())
    check(p["sharedPatchSha256"] == old["combinedPatchSha256"], "Z4_SHARED_UPDATE_LINEAGE_PREIMAGE")
    for change in planned:
        target = a.target / change["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(after[change["path"]])
        check(sha(target) == change["postimageSha256"], "Z4_SHARED_UPDATE_POSTIMAGE")
    p["sharedPatchSha256"] = new["combinedPatchSha256"]
    save(lineage, p)
    save(a.target / "z4-source-paths.json", sorted(set(source_paths(a.target)) | set(after)))
    run.report.update(changes=planned, previousPatchSha256=old["combinedPatchSha256"],
                      currentPatchSha256=new["combinedPatchSha256"], liveSharedFilesWritten=0)
    return run.finish("PASSED_EXACT_SHARED_STAGE_UPDATE_ONLY")


def extract_package(archive, destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as tar:
        root = R["npm_archive_root"](tar)
        for member in tar.getmembers():
            if not member.name.startswith(root):
                continue
            rel = member.name[len(root):]
            if not rel:
                continue
            check(not rel.startswith("/") and ".." not in rel.split("/") and
                  (member.isfile() or member.isdir()), "Z4_UNSAFE_TOOLCHAIN_ARCHIVE")
            output = destination / rel
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, output.open("xb") as sink:
                    shutil.copyfileobj(source, sink)
                os.chmod(output, member.mode & 0o700 or 0o400)


def toolchains(a):
    run = Run(a, "finnor.z4.independent-toolchain-install.v1")
    pins = json.loads((HERE / "toolchain-pins.json").read_text())
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not a.rust_only:
            tools = a.target / ".z4-toolchains"
            tools.mkdir(mode=0o700, exist_ok=True)
            archives = tools / "archives"
            archives.mkdir(mode=0o700, exist_ok=True)
            if a.npm_only:
                previous_file = tools / "receipt.json"
                check(a.receipt_preimage and sha(previous_file) == a.receipt_preimage,
                      "Z4_TOOLCHAIN_REPLACEMENT_PREIMAGE_REQUIRED")
                previous = json.loads(previous_file.read_text())
                check(previous["status"] == "PASSED_INDEPENDENT_TOOLCHAIN_INSTALL_ONLY" and
                      sha(tools / "node/bin/node") == previous["nodeBinarySha256"],
                      "Z4_PREVIOUS_TERMINAL_TOOLCHAIN_REQUIRED")
                old_version = previous["npm"]["version"]
                check(json.loads((tools / "npm/package.json").read_text())["version"] == old_version,
                      "Z4_PREVIOUS_NPM_VERSION_CHANGED")
                retained = tools / ("npm-" + old_version + ".retained")
                check(not retained.exists(), "Z4_NEW_NPM_RETENTION_PATH_REQUIRED")
                shutil.copyfile(previous_file, a.evidence / "previous-toolchain-receipt.json")
                (tools / "npm").rename(retained)
                run.report.update(node=previous["node"], nodeBinarySha256=previous["nodeBinarySha256"],
                                  previousToolchainReceiptSha256=a.receipt_preimage,
                                  previousNpmPrefix=str(retained), normalPeerResolutionUnchanged=True)
            for name in (("npm",) if a.npm_only else ("node", "npm")):
                meta = pins[name]
                archive = archives / (name + "-" + meta["version"] + ".tgz")
                check(not archive.exists(), "Z4_TOOLCHAIN_ARCHIVE_ALREADY_EXISTS")
                provenance, size = R["fetch_tarball"](name, meta, archive)
                extract_package(archive, tools / name)
                run.report[name] = {**meta, "tarballSha256": sha(archive),
                                    "tarballBytes": size, "provenance": provenance}
            for name, relative in [("npm", "../../npm/bin/npm-cli.js"),
                                   ("npx", "../../npm/bin/npx-cli.js")]:
                link = tools / "node/bin" / name
                if link.is_symlink():
                    check(os.readlink(link) == relative, "Z4_NODE_NPM_LINK_CHANGED")
                else:
                    link.symlink_to(relative)
            node, npm = runtime(a.target)
            env = environment(a.target)
            check(run.command("node-version", [node, "--version"], a.target, env, 30),
                  "Z4_NODE_VERSION_FAILED")
            check(run.command("npm-version", [node, npm, "--version"], a.target, env, 30),
                  "Z4_NPM_VERSION_FAILED")
            run.report["nodeBinarySha256"] = sha(node)
            run.report["borrowedBinaries"] = False
            save(tools / "receipt.json", run.report)
        if not a.runtime_only and not a.npm_only:
            prefix = a.target / NATIVE / ".toolchain"
            prefix.mkdir(mode=0o700, exist_ok=True)
            installed = prefix / "installed"
            check(not installed.exists(), "Z4_FRESH_RUST_PREFIX_REQUIRED")
            env = {"PATH": "/usr/bin:/bin", "HOME": str(prefix)}
            components = []
            for component in pins["rust"]["components"]:
                name = component["url"].rsplit("/", 1)[1]
                archive = a.repository / NATIVE / ".toolchain" / name
                check(sha(archive) == component["sha256"], "Z4_PINNED_RUST_ARCHIVE_MISMATCH")
                directory = prefix / name.removesuffix(".tar.xz")
                check(not directory.exists(), "Z4_FRESH_RUST_COMPONENT_REQUIRED")
                with tarfile.open(archive) as tar:
                    tar.extractall(prefix, filter="data")
                ok = run.command("install-" + component["component"],
                                 [directory / "install.sh", "--disable-ldconfig",
                                  "--prefix=" + str(installed)], prefix, env, 180)
                check(ok, "Z4_FRESH_RUST_COMPONENT_INSTALL_FAILED")
                components.append({**component, "archiveBytes": archive.stat().st_size})
                # This exact newly extracted directory is disposable installer staging.
                check(inside(directory, prefix), "Z4_INSTALLER_CLEANUP_SCOPE")
                shutil.rmtree(directory)
            receipt = {"schema": "finnor.z4.independent-rust-install.v1", **pins["rust"],
                       "components": components, "installedPrefix": str(installed),
                       "borrowedBinaries": False,
                       "binaries": {n: sha(installed / "bin" / n) for n in ("rustc", "cargo")}}
            save(prefix / "reconstruction-receipt.json", receipt)
            run.report["rust"] = receipt
    result = run.finish("PASSED_INDEPENDENT_TOOLCHAIN_INSTALL_ONLY")
    if not a.rust_only:
        save(a.target / ".z4-toolchains/receipt.json", run.report)
    return result


def compatible(values, value):
    if not values:
        return True
    return ("!" + value) not in values and (value in values or all(v.startswith("!") for v in values))


def install(a):
    run = Run(a, "finnor.z4.independent-product-install.v1")
    node, npm = runtime(a.target)
    env = environment(a.target)
    cache = a.target / ".z4-npm-cache/_cacache/content-v2"
    selected, local, skipped = {}, [], []
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run.report["systemToolObservation"] = {
            "basis": "OBSERVED_AT_THIS_PRODUCT_INSTALL_NOT_A_RETROACTIVE_NATIVE_BUILD_RECEIPT",
            "platform": platform.platform(), "machine": platform.machine(),
            "tools": {name: {"path": str(Path("/usr/bin") / name),
                              "sha256": sha(Path("/usr/bin") / name)}
                      for name in ("python3", "c++", "cc", "make")},
        }
        for name in ("python3", "c++", "cc", "make"):
            check(run.command("system-" + name.replace("+", "p"), ["/usr/bin/" + name, "--version"],
                              a.target, env, 30), "Z4_SYSTEM_BUILD_TOOL_UNAVAILABLE")
        for rel in ("package-lock.json", "finnor-os/package-lock.json"):
            packages = json.loads((a.target / rel).read_text())["packages"]
            for key, entry in packages.items():
                resolved = entry.get("resolved", "")
                if not resolved or entry.get("link"):
                    continue
                if resolved.startswith("file:"):
                    path = (a.target / rel).parent / resolved[5:]
                    check(inside(path, a.target) and path.is_file(), "Z4_LOCAL_LOCK_TARBALL_ABSENT")
                    local.append({"lock": rel, "path": str(path.relative_to(a.target)),
                                  "sha256": sha(path), "integrity": entry.get("integrity")})
                    continue
                check(resolved.startswith("https://registry.npmjs.org/") and entry.get("integrity"),
                      "Z4_UNPINNED_PRODUCT_DEPENDENCY")
                if not all(compatible(entry.get(k), v) for k, v in
                           (("os", "linux"), ("cpu", "x64"), ("libc", "glibc"))):
                    skipped.append({"lock": rel, "path": key, "resolved": resolved})
                    continue
                selected[entry["integrity"]] = {k: entry[k] for k in ("version", "resolved", "integrity")}
        run.report.update(lockFiles={r: sha(a.target / r) for r in
                                    ("package-lock.json", "finnor-os/package-lock.json")},
                          localTarballs=local, skippedPlatformPackages=skipped,
                          borrowedModules=False, borrowedBinaries=False, lifecycleScripts="IGNORED")
        run.persist()
        fetched = []
        for integrity, meta in sorted(selected.items()):
            algo, encoded = integrity.split("-", 1)
            binary_digest = base64.b64decode(encoded).hex()
            destination = cache / algo / binary_digest[:2] / binary_digest[2:4] / binary_digest[4:]
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_file():
                body = destination.read_bytes()
                check(hashlib.new(algo, body).hexdigest() == binary_digest,
                      "Z4_RETAINED_TARGET_TARBALL_INTEGRITY_CHANGED")
                provenance, size = "previous-declared-target-integrity-cache", len(body)
            else:
                source = R["cacache_path"](integrity)
                check(source.is_file() or a.fetch_missing_pinned, "Z4_PINNED_PRODUCT_TARBALL_NOT_CACHED")
                provenance, size = R["fetch_tarball"](meta["resolved"], meta, destination)
            fetched.append({**meta, "tarballSha256": sha(destination), "bytes": size, "provenance": provenance})
        run.report["dependencyTarballs"] = fetched
        run.persist()
        for name, cwd in [("root", a.target), ("workspace", a.target / "finnor-os")]:
            ok = run.command("npm-ci-" + name, [node, npm, "ci", "--offline", "--ignore-scripts",
                                               "--no-audit", "--no-fund"], cwd, env, 900)
            check(ok, "Z4_PINNED_OFFLINE_INSTALL_FAILED:" + name)
        for rel, expected in run.report["lockFiles"].items():
            check(sha(a.target / rel) == expected, "Z4_NPM_LOCK_CHANGED")
        binding = a.target / "finnor-os/node_modules/fs-ext"
        gyp = a.target / ".z4-toolchains/npm/node_modules/node-gyp/bin/node-gyp.js"
        check(run.command("fs-ext-native-binding", [node, gyp, "rebuild", "--jobs=2",
                                                   "--nodedir=" + str(a.target / ".z4-toolchains/node")],
                          binding, env, 180), "Z4_FS_EXT_NATIVE_BINDING_FAILED")
        licenses = []
        for rel in ("package-lock.json", "finnor-os/package-lock.json"):
            package_paths = json.loads((a.target / rel).read_text())["packages"]
            for key, entry in sorted(package_paths.items()):
                if not key or entry.get("link") or not entry.get("resolved"):
                    continue
                package = (a.target / rel).parent / key / "package.json"
                if not package.is_file():
                    continue
                if package.parent.is_symlink():
                    continue
                p = json.loads(package.read_text())
                files = [x.name for x in package.parent.iterdir() if x.is_file() and
                         x.name.lower().startswith(("license", "licence", "copying", "notice"))]
                licenses.append({"path": str(package.parent.relative_to(a.target)),
                                 "name": p.get("name"), "version": p.get("version"),
                                 "license": p.get("license") or p.get("licenses"), "noticeFiles": files})
        run.report["licenses"] = licenses
        run.report["licenseMetadataGaps"] = [p["path"] for p in licenses if not p["license"] and not p["noticeFiles"]]
    return run.finish("PASSED_INDEPENDENT_PRODUCT_INSTALL_ONLY")


def checks(a):
    run = Run(a, "finnor.z4.isolated-product-checks.v1")
    node, npm = runtime(a.target)
    env = environment(a.target)
    ws = a.target / "finnor-os"
    provenance = json.loads((a.target / "z4-reconstruction-source.json").read_text())
    run.report.update(sourceProvenance=provenance, environmentVariableNames=sorted(env))
    all_ok = True
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        preparation = [
            ("workspace-generate", [node, npm, "run", "workspace:generate"], a.target),
            ("authz-matrix-generate", [node, "--import", "tsx", "scripts/generate-authz-matrix.ts"], ws),
            ("action-manifest-generate", [node, "--import", "tsx",
                                           "scripts/release/verify-action-manifest.ts", "--write"], ws),
            ("openapi-generate", [node, npm, "run", "openapi"], ws),
            ("client-generate", [node, npm, "run", "centropy:client"], a.target),
            ("manifest-generate", [node, npm, "run", "centropy:manifest"], a.target),
            ("forms-generate", [node, npm, "run", "centropy:forms"], a.target),
            ("coverage-generate", [node, npm, "run", "centropy:coverage"], a.target),
            ("frontend-typegen", [node, a.target / "node_modules/next/dist/bin/next", "typegen"], a.target),
            ("api-typegen", [node, ws / "node_modules/next/dist/bin/next", "typegen"], ws / "apps/api"),
        ]
        for method in ("x3", "x5", "x4", "y2"):
            preparation.append(("stamp-" + method, [node, "--import", "tsx",
                                                    "scripts/" + method + "/stamp-source.mts"], ws))
        provenance_file = a.target / "scope-z/phase-evidence/z4/installed-provenance.json"
        provenance_command = [node, "--import", "tsx", "scripts/project-z/z4/installed-identity.mts"]
        if provenance_file.is_file():
            provenance_command += ["--replace-sha256", sha(provenance_file)]
        preparation.append(("installed-identity", provenance_command, ws))
        for name, command, cwd in preparation:
            all_ok = run.command(name, command, cwd, env) and all_ok
        paths = source_paths(a.target)
        if provenance_file.is_file() and str(provenance_file.relative_to(a.target)) not in paths:
            paths.append(str(provenance_file.relative_to(a.target)))
            save(a.target / "z4-source-paths.json", sorted(paths))
        before = inventory(a.target)
        run.report["source"] = before
        run.report["sourceDigest"] = R["digest_bytes"](R["canonical"](before))
        commands = [
            ("workspace-check", [node, npm, "run", "workspace:check"], a.target),
            ("authz-matrix-check", [node, npm, "run", "authz:matrix:check"], ws),
            ("action-manifest-check", [node, npm, "run", "release:manifest"], ws),
            ("pe-domain-boundary-check", [node, npm, "run", "release:pe-domain-boundary"], ws),
        ]
        for name in ("client", "manifest", "forms", "coverage"):
            commands.append((name + "-check", [node, npm, "run", "centropy:" + name + ":check"], a.target))
        for name, cwd, project in [
            ("backend-types", ws, "tsconfig.json"), ("root-types", a.target, "tsconfig.json"),
            ("scripts-types", ws, "scripts/project-z/z4/tsconfig.scripts.json"),
            ("panel-types", ws, "scripts/project-z/z4/tsconfig.frontend.json")]:
            commands.append((name, [node, cwd / "node_modules/typescript/bin/tsc",
                                    "--noEmit", "--incremental", "false", "-p", project], cwd))
        commands.append(("root-lint", [node, npm, "run", "lint"], a.target))
        commands.append(("existing-compute-policy-tests",
                         [node, "--test", "scripts/release/compute-plane-policy.test.mjs"], a.target))
        owned_js = [p for p in source_paths(a.target)
                    if p.startswith(tuple(R["OWNED_SOURCE_ROOTS"])) and Path(p).suffix in (".ts", ".tsx", ".mts", ".mjs")]
        commands.append(("owned-source-lint", [node, a.target / "node_modules/eslint/bin/eslint.js",
                                               "--config", "finnor-os/scripts/project-z/z4/eslint.owned.config.mjs",
                                               "--no-ignore", *owned_js], a.target))
        for name, command, cwd in commands:
            all_ok = run.command(name, command, cwd, env) and all_ok
        for path in HERE.glob("*.py"):
            ast.parse((ws / "scripts/project-z/z4" / path.name).read_text())
        after = inventory(a.target)
        run.report["sourceUnchanged"] = before == after
        run.report["sourceDrift"] = [p["path"] for p in before if p not in after]
        run.report["sourceAdded"] = sorted({p["path"] for p in after} - {p["path"] for p in before})
        all_ok = all_ok and before == after
    return run.finish("PASSED_ISOLATED_PRODUCT_SOURCE_CHECKS_ONLY" if all_ok else "FAILED")


def builds(a):
    run = Run(a, "finnor.z4.isolated-product-builds.v1")
    node, npm = runtime(a.target)
    env = environment(a.target)
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = inventory(a.target)
        digest = R["digest_bytes"](R["canonical"](before))
        env["FINNOR_BUILD_ID"] = "z4-isolated-" + digest[:20]
        run.report.update(source=before, sourceDigest=digest, expectedBuildId=env["FINNOR_BUILD_ID"],
                          environmentVariableNames=sorted(env))
        front = run.command("frontend-build",
                            [node, a.target / "node_modules/next/dist/bin/next", "build", "--webpack"],
                            a.target, env)
        api = run.command("api-build", [node, npm, "run", "build", "--workspace=@finnor/api"],
                          a.target / "finnor-os", env)
        after = inventory(a.target)
        run.report["sourceUnchanged"] = before == after
        run.report["sourceDrift"] = [p["path"] for p in before if p not in after]
        run.report["sourceAdded"] = sorted({p["path"] for p in after} - {p["path"] for p in before})
        ids = {}
        for name, rel in [("frontend", ".next-x1-install/BUILD_ID"), ("api", "finnor-os/apps/api/.next/BUILD_ID")]:
            file = a.target / rel
            ids[name] = {"path": rel, "value": file.read_text().strip() if file.is_file() else None,
                         "sha256": sha(file) if file.is_file() else None}
        run.report["buildIds"] = ids
        traces, invalid = [], []
        for path in sorted((a.target / "finnor-os/apps/api/.next").rglob("*.nft.json")):
            files = json.loads(path.read_text()).get("files", [])
            for item in files:
                absolute = (path.parent / item).resolve()
                if "/native/z4-execution-proof/" not in str(absolute):
                    continue
                check(inside(absolute, a.target), "Z4_BUILD_TRACE_SOURCE_FALLBACK")
                rel = str(absolute.relative_to(a.target))
                traces.append(rel)
                if any(part in ("target", ".cargo", ".cargo-home", ".toolchain") for part in Path(rel).parts):
                    invalid.append(rel)
        run.report["nativeTraceFiles"] = sorted(set(traces))
        run.report["forbiddenNativeTraceFiles"] = sorted(set(invalid))
        required = [NATIVE + "/bin/z4-proof", NATIVE + "/build-identity.json", NATIVE + "/supervise.py"]
        run.report["missingNativeTraceFiles"] = sorted(set(required) - set(traces))
        ok = (front and api and before == after and not invalid and
              not run.report["missingNativeTraceFiles"] and
              all(item["value"] == env["FINNOR_BUILD_ID"] for item in ids.values()))
    return run.finish("PASSED_ISOLATED_INSTALLED_PRODUCT_BUILDS_ONLY" if ok else "FAILED")


def generated_requests(a):
    run = Run(a, "finnor.z4.generated-shared-requests.v1")
    requests, diffs = [], []
    for rel in sorted({entry["path"] for entry in inventory(a.target)}):
        if (rel.startswith(tuple(R["OWNED_SOURCE_ROOTS"])) or rel.startswith("scope-z/phase-evidence/z4/") or
                rel in ("stage-report.json", "z4-reconstruction-source.json", "z4-source-paths.json")):
            continue
        original, built = a.repository / rel, a.target / rel
        if not built.is_file() or original.is_file() and sha(original) == sha(built):
            continue
        try:
            before, after = original.read_text() if original.is_file() else "", built.read_text()
        except UnicodeDecodeError:
            continue
        diff = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                          fromfile="a/" + rel if original.is_file() else "/dev/null", tofile="b/" + rel))
        diffs.append(diff)
        requests.append({"path": rel, "preimageSha256": sha(original) if original.is_file() else None,
                         "requiresAbsent": not original.is_file(),
                         "postimageSha256": sha(built), "status": "REQUESTED_NOT_APPLIED"})
    body = "".join(diffs)
    (a.evidence / "combined.patch").write_text(body)
    run.report.update(requests=requests, combinedPatchSha256=sha(a.evidence / "combined.patch"),
                      liveSharedFilesWritten=0, note="Includes direct and generated deltas; alternative complete request set.")
    return run.finish("PASSED_EXACT_GENERATED_REQUEST_CAPTURE_ONLY")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["stage", "refresh-owned", "rebind", "update-requests", "toolchains", "install", "checks", "builds", "generated-requests"])
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--requests", type=Path)
    parser.add_argument("--previous-requests", type=Path)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--expand-core", action="store_true")
    parser.add_argument("--rust-only", action="store_true")
    parser.add_argument("--runtime-only", action="store_true")
    parser.add_argument("--npm-only", action="store_true")
    parser.add_argument("--receipt-preimage")
    parser.add_argument("--fetch-missing-pinned", action="store_true")
    a = parser.parse_args()
    check(sum((a.rust_only, a.runtime_only, a.npm_only)) <= 1, "Z4_EXACT_TOOLCHAIN_MODE_REQUIRED")
    check(all(p.is_absolute() for p in (a.repository, a.target, a.evidence)), "Z4_ABSOLUTE_PATHS_REQUIRED")
    check(inside(a.target, a.repository / "scope-z/phase-evidence/z4"), "Z4_OWNED_ISOLATED_TARGET_REQUIRED")
    try:
        return {"stage": stage, "refresh-owned": refresh_owned, "rebind": rebind, "update-requests": update_requests, "toolchains": toolchains, "install": install, "checks": checks,
                "builds": builds, "generated-requests": generated_requests}[a.command](a)
    except Exception as error:
        report_file = a.evidence / "report.json"
        report = json.loads(report_file.read_text()) if report_file.is_file() else {
            "schema": "finnor.z4.engineering-refusal.v1", "steps": []}
        predicate = str(error)
        if not predicate.startswith("Z4_"):
            predicate = "Z4_ENGINEERING_STEP_FAILED"
        report.update(status="FAILED", failure=predicate, terminalExit=1)
        a.evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
        save(report_file, report)
        print(json.dumps({"status": "FAILED", "failure": predicate, "evidence": str(a.evidence)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
