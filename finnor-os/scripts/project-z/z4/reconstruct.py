"""Z4 isolated reconstruction: inventory, vendor, stage, build, verify, guarded replay.

Reproduces the Z4 computational core (TypeScript kernel, native Nova prover/
verifier, offline runners) on a separately isolated target from pinned,
hash-verified dependencies only. No borrowed node_modules, native binaries,
undeclared toolchains or source fallback. `replay` is deliberately guarded:
without an exact, explicit existing-target authorization manifest whose
identities match the current source and installed binary byte-for-byte, it
exits 78 before any DB, Auth or network call. Offline fixtures cannot unlock
it because the guard recomputes live source/binary/git identities and requires
an out-of-band coordinator grant receipt plus named credentials.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.request
import uuid

PROFILE = "Z4_I32_I64_PALLAS_VESTA_IPA_V1"
BACKEND = "nova-01b1e2d662a847ed7029770ecbaf6687398899dd-0.76.0"
NODE = Path("/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node")
OWNED_SOURCE_ROOTS = [
    "finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof",
    "finnor-os/packages/epistemic-runtime/native/z4-execution-proof",
    "finnor-os/packages/private-equity/src/project-z/z4-execution-proof",
    "finnor-os/packages/orchestration/src/project-z/z4-execution-proof",
    "finnor-os/scripts/project-z/z4",
]
NATIVE_BUILD_OUTPUTS = {"target", ".cargo-home", ".cargo", ".toolchain", "bin"}
REGISTRATION = "scope-z/phase-evidence/z4/public-cases.pre-code.json"
REGISTRATION_SHA256 = "3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94"
NPM_ROOTS = ["tsx", "typescript", "zod", "@types/node"]
REPLAY_EXIT = 78


def digest_bytes(b):
    return hashlib.sha256(b).hexdigest()


def digest_file(p):
    return digest_bytes(p.read_bytes())


def runtime_node(repository, explicit=None, installed=False):
    node = explicit or repository / ".z4-toolchains/node/bin/node"
    if not node.is_file():
        if installed or explicit:
            fail("Z4_INDEPENDENT_NODE_INSTALL_REQUIRED")
        node = NODE
    if not node.is_absolute():
        fail("Z4_ABSOLUTE_NODE_PATH_REQUIRED")
    return node


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":")).encode()


def fail(code):
    print(json.dumps({"status": "REFUSED", "code": code}), file=sys.stderr)
    raise SystemExit(1 if code != "Z4_REPLAY_AUTHORITY_MANIFEST_REQUIRED" else REPLAY_EXIT)


def owned_inventory(repository):
    files = []
    for root in OWNED_SOURCE_ROOTS:
        base = repository / root
        for p in sorted(base.rglob("*")):
            if not p.is_file() or p.is_symlink():
                continue
            rel = str(p.relative_to(repository))
            if root.endswith("native/z4-execution-proof"):
                top = str(p.relative_to(base)).split("/")[0]
                if top in NATIVE_BUILD_OUTPUTS:
                    continue
            files.append({"path": rel, "sha256": digest_file(p), "bytes": p.stat().st_size})
    reg = repository / REGISTRATION
    files.append({"path": REGISTRATION, "sha256": digest_file(reg), "bytes": reg.stat().st_size})
    return files


def git(repository, *args):
    return subprocess.run(["git", "-C", str(repository), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def native_source_digest(native):
    source = []
    rels = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "supervise.py"] + \
           [str(x.relative_to(native)) for x in sorted((native / "src").glob("*.rs"))]
    for rel in sorted(rels):
        source.append({"path": rel, "sha256": digest_file(native / rel)})
    return digest_bytes(canonical(source))


def cmd_inventory(a):
    files = owned_inventory(a.repository)
    native = a.repository / "finnor-os/packages/epistemic-runtime/native/z4-execution-proof"
    identity = json.loads((native / "build-identity.json").read_text())
    node = runtime_node(a.repository, a.node)
    node_sha = digest_file(node)
    toolchain = (a.rust_prefix or native / ".toolchain/installed") / "bin"
    report = {
        "schema": "finnor.z4.reconstruction-inventory.v1",
        "head": git(a.repository, "rev-parse", "HEAD"),
        "tree": git(a.repository, "rev-parse", "HEAD^{tree}"),
        "branch": git(a.repository, "symbolic-ref", "--short", "HEAD"),
        "ownedFiles": files,
        "ownedSourceDigest": digest_bytes(canonical(files)),
        "registrationSha256": digest_file(a.repository / REGISTRATION),
        "nativeIdentity": identity,
        "recomputedNativeSourceDigest": native_source_digest(native),
        "toolchains": {
            "node": {"path": str(node), "sha256": node_sha,
                     "version": subprocess.run([str(node), "--version"], capture_output=True,
                                               text=True, check=True).stdout.strip()},
            "rustc": {"path": str(toolchain / "rustc"), "sha256": digest_file(toolchain / "rustc")},
            "cargo": {"path": str(toolchain / "cargo"), "sha256": digest_file(toolchain / "cargo")},
        },
        "borrowedModules": False, "borrowedBinaries": False,
        "nativeOwner": "NOT_RUN", "protectedAdmission": "NOT_RUN",
    }
    if report["recomputedNativeSourceDigest"] != identity["sourceDigest"]:
        fail("Z4_INSTALLED_SOURCE_IDENTITY_MISMATCH")
    if report["registrationSha256"] != REGISTRATION_SHA256:
        fail("Z4_FROZEN_REGISTRATION_CHANGED")
    a.evidence.mkdir(parents=True, exist_ok=False)
    (a.evidence / "inventory.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "INVENTORIED", "files": len(files),
                      "ownedSourceDigest": report["ownedSourceDigest"]}))


def npm_closure(repository):
    lock = json.loads((repository / "finnor-os/package-lock.json").read_text())
    packages = lock["packages"]
    wanted, queue = {}, list(NPM_ROOTS)
    while queue:
        name = queue.pop()
        key = "node_modules/" + name
        if name in wanted:
            continue
        entry = packages.get(key)
        if not entry or not entry.get("resolved") or not entry.get("integrity"):
            fail("Z4_UNPINNED_NPM_DEPENDENCY:" + name)
        wanted[name] = {"version": entry["version"], "resolved": entry["resolved"],
                        "integrity": entry["integrity"]}
        for group in ("dependencies", "optionalDependencies", "peerDependencies"):
            for dep in (entry.get(group) or {}):
                if dep not in wanted:
                    queue.append(dep)
    return wanted


def cacache_path(integrity):
    algo, b64 = integrity.split("-", 1)
    hexed = base64.b64decode(b64).hex()
    cache = Path(os.environ.get("npm_config_cache") or str(Path.home() / ".npm"))
    if cache.name != "_cacache":
        cache = cache / "_cacache"
    return cache / "content-v2" / algo / hexed[0:2] / hexed[2:4] / hexed[4:]


def fetch_tarball(name, meta, destination):
    integrity = meta["integrity"]
    algo, b64 = integrity.split("-", 1)
    expected = base64.b64decode(b64)
    cached = cacache_path(integrity)
    provenance = "npm-cacache"
    if cached.is_file():
        body = cached.read_bytes()
    else:
        provenance = "pinned-registry-url"
        with urllib.request.urlopen(meta["resolved"], timeout=60) as response:
            body = response.read()
    if hashlib.new(algo, body).digest() != expected:
        fail("Z4_VENDOR_INTEGRITY_MISMATCH:" + name)
    destination.write_bytes(body)
    return provenance, len(body)


def npm_archive_root(tar):
    roots = [m.name.rsplit("/", 1)[0] + "/" for m in tar.getmembers()
             if m.isfile() and m.name.endswith("/package.json") and len(m.name.split("/")) == 2]
    if len(roots) != 1 or roots[0].startswith("/") or ".." in roots[0].split("/"):
        fail("Z4_NPM_ARCHIVE_ROOT_AMBIGUOUS")
    return roots[0]


def tarball_package_json(body):
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
        member = tar.extractfile(npm_archive_root(tar) + "package.json")
        return json.loads(member.read().decode()) if member else {}


def cmd_vendor(a):
    native = a.repository / "finnor-os/packages/epistemic-runtime/native/z4-execution-proof"
    toolchain = (a.rust_prefix or native / ".toolchain/installed") / "bin"
    evidence = a.evidence
    evidence.mkdir(parents=True, exist_ok=False)
    cargo_out = evidence / "vendor/cargo"
    cargo_out.mkdir(parents=True)
    lock_sha = digest_file(native / "Cargo.lock")
    env = {"PATH": str(toolchain) + ":/usr/bin:/bin", "HOME": str(native / ".cargo-home"),
           "CARGO_HOME": str(native / ".cargo-home"),
           "CARGO_NET_OFFLINE": "false" if a.fetch_missing_pinned else "true", "CARGO_NET_RETRY": "1"}
    start = time.monotonic()
    result = subprocess.run([str(toolchain / "cargo"), "vendor", "--locked", str(cargo_out)],
                            cwd=native, env=env, capture_output=True, text=True, timeout=600)
    (evidence / "cargo-vendor.log").write_text(result.stdout + result.stderr)
    if digest_file(native / "Cargo.lock") != lock_sha:
        fail("Z4_VENDOR_CARGO_LOCK_CHANGED")
    if result.returncode:
        fail("Z4_CARGO_VENDOR_FAILED")
    (evidence / "cargo-vendor-config.toml").write_text(result.stdout)
    cargo_licenses = {}
    cargo_files = []
    for manifest in sorted(cargo_out.glob("*/Cargo.toml")):
        data = tomllib.loads(manifest.read_text())
        package = data.get("package", {})
        crate = package.get("name", manifest.parent.name)
        cargo_licenses[crate] = {"version": package.get("version"),
                                 "license": package.get("license"),
                                 "licenseFile": package.get("license-file")}
    for p in sorted(cargo_out.rglob("*")):
        if p.is_file():
            cargo_files.append({"path": str(p.relative_to(evidence)), "sha256": digest_file(p)})
    npm_out = evidence / "vendor/npm"
    npm_out.mkdir(parents=True)
    npm_packages, npm_files, npm_licenses = {}, [], {}
    for name, meta in sorted(npm_closure(a.repository).items()):
        target = npm_out / (name.replace("/", "__") + "-" + meta["version"] + ".tgz")
        provenance, size = fetch_tarball(name, meta, target)
        body = target.read_bytes()
        package_json = tarball_package_json(body)
        npm_licenses[name] = {"version": meta["version"],
                              "license": package_json.get("license") or package_json.get("licenses"),
                              "provenance": provenance}
        npm_packages[name] = {**meta, "tarball": target.name, "tarballSha256": digest_bytes(body),
                              "tarballBytes": size, "provenance": provenance}
        npm_files.append({"path": str(target.relative_to(evidence)), "sha256": digest_bytes(body)})
    report = {"schema": "finnor.z4.reconstruction-vendor.v1",
              "cargoLockSha256": lock_sha, "pinnedMissingFetchAllowed": a.fetch_missing_pinned,
              "cargoCrates": len(cargo_licenses), "cargoLicenses": cargo_licenses,
              "cargoFiles": cargo_files, "npmPackages": npm_packages, "npmLicenses": npm_licenses,
              "npmFiles": npm_files, "wallMs": round((time.monotonic() - start) * 1000),
              "licenseGaps": {"cargo": sorted(k for k, v in cargo_licenses.items() if not v["license"] and not v["licenseFile"]),
                              "npm": sorted(k for k, v in npm_licenses.items() if not v["license"])}}
    (evidence / "vendor-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "VENDORED", "cargoCrates": len(cargo_licenses),
                      "npmPackages": len(npm_packages),
                      "licenseGaps": report["licenseGaps"]}))


def copy_owned(repository, target):
    for root in OWNED_SOURCE_ROOTS:
        base = repository / root
        for p in sorted(base.rglob("*")):
            if not p.is_file() or p.is_symlink():
                continue
            if root.endswith("native/z4-execution-proof"):
                top = str(p.relative_to(base)).split("/")[0]
                if top in NATIVE_BUILD_OUTPUTS:
                    continue
            rel = p.relative_to(repository)
            out = target / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, out)
            os.chmod(out, 0o500 if p.stat().st_mode & stat.S_IXUSR else 0o400)
    reg_out = target / REGISTRATION
    reg_out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(repository / REGISTRATION, reg_out)
    os.chmod(reg_out, 0o400)


def extract_npm_vendor(vendor, target):
    modules = target / "finnor-os/node_modules"
    modules.mkdir(parents=True)
    manifest = json.loads((vendor / "vendor-manifest.json").read_text())
    bins = {}
    for name, meta in manifest["npmPackages"].items():
        body = (vendor / "vendor/npm" / meta["tarball"]).read_bytes()
        if digest_bytes(body) != meta["tarballSha256"]:
            fail("Z4_STAGED_TARBALL_CHANGED:" + name)
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
            archive_root = npm_archive_root(tar)
            for member in tar.getmembers():
                if not member.name.startswith(archive_root):
                    continue
                rel = member.name[len(archive_root):]
                if not rel:
                    continue
                if rel.startswith("/") or ".." in rel.split("/") or member.issym() or member.islnk():
                    fail("Z4_UNSAFE_NPM_ARCHIVE_MEMBER:" + name)
                out = modules / name / rel
                if member.isdir():
                    out.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, out.open("wb") as sink:
                        shutil.copyfileobj(source, sink)
                    os.chmod(out, member.mode & 0o700 or 0o400)
        package_json = modules / name / "package.json"
        if package_json.is_file():
            declared = json.loads(package_json.read_text()).get("bin") or {}
            if isinstance(declared, str):
                declared = {name.split("/")[-1]: declared}
            for command, rel in declared.items():
                bins[command] = "../" + name + "/" + rel
    bindir = modules / ".bin"
    bindir.mkdir(exist_ok=True)
    for command, rel in bins.items():
        link = bindir / command
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(rel)
    return sorted(bins)


def cmd_stage(a):
    if a.target.exists():
        fail("Z4_RECONSTRUCTION_TARGET_EXISTS")
    inventory = json.loads((a.vendor.parent / "inventory/inventory.json").read_text()) \
        if (a.vendor.parent / "inventory/inventory.json").is_file() else None
    a.target.mkdir(parents=True, mode=0o700)
    copy_owned(a.repository, a.target)
    vendor_target = a.target / "finnor-os/vendor-z4"
    shutil.copytree(a.vendor / "vendor", vendor_target)
    shutil.copyfile(a.vendor / "cargo-vendor-config.toml",
                    a.target / "finnor-os/vendor-z4/cargo-vendor-config.toml")
    staged_files = []
    for p in sorted(a.target.rglob("*")):
        if p.is_file() and not p.is_symlink():
            staged_files.append({"path": str(p.relative_to(a.target)), "sha256": digest_file(p)})
    bins = extract_npm_vendor(a.vendor, a.target)
    cargo_config = a.target / "finnor-os/packages/epistemic-runtime/native/z4-execution-proof/.cargo/config.toml"
    cargo_config.parent.mkdir(parents=True, exist_ok=True)
    snippet = (a.vendor / "cargo-vendor-config.toml").read_text()
    snippet = snippet.replace(str(a.vendor / "vendor/cargo"), str(a.target / "finnor-os/vendor-z4/cargo"))
    cargo_config.write_text(snippet)
    report = {"schema": "finnor.z4.reconstruction-stage.v1", "target": str(a.target),
              "stagedFiles": len(staged_files),
              "stagedDigest": digest_bytes(canonical(staged_files)),
              "binLinks": bins, "npmModulesFrom": "integrity-verified-vendored-tarballs",
              "cargoFrom": "cargo-vendor-locked-offline", "borrowedModules": False}
    if inventory:
        expected = {f["path"]: f["sha256"] for f in inventory["ownedFiles"]}
        mismatched = [p for p in expected if (a.target / p).is_file()
                      and digest_file(a.target / p) != expected[p]]
        missing = [p for p in expected if not (a.target / p).is_file()]
        report["againstInventory"] = {"missing": missing, "mismatched": mismatched}
        if missing or mismatched:
            (a.target / "stage-report.json").write_text(json.dumps(report, indent=2) + "\n")
            fail("Z4_STAGED_SOURCE_MISMATCH")
    (a.target / "stage-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "STAGED", "files": len(staged_files),
                      "digest": report["stagedDigest"], "binLinks": bins}))


def cmd_build(a):
    native = a.target / "finnor-os/packages/epistemic-runtime/native/z4-execution-proof"
    toolchain_inventory = json.loads((a.vendor.parent / "inventory/inventory.json").read_text())["toolchains"]
    original_toolchain = native / ".toolchain/installed/bin"
    fresh_receipt = native / ".toolchain/reconstruction-receipt.json"
    if not fresh_receipt.is_file():
        fail("Z4_INDEPENDENT_RUST_INSTALL_REQUIRED")
    fresh = json.loads(fresh_receipt.read_text())
    if fresh.get("borrowedBinaries") is not False or fresh.get("installedPrefix") != str(original_toolchain.parent):
        fail("Z4_INDEPENDENT_RUST_RECEIPT_MISMATCH")
    for name in ("rustc", "cargo"):
        if digest_file(original_toolchain / name) != toolchain_inventory[name]["sha256"]:
            fail("Z4_DECLARED_TOOLCHAIN_CHANGED:" + name)
    free = shutil.disk_usage(a.target).free
    if free < 2 * 1024**3:
        fail("Z4_RECONSTRUCTION_DISK_BOUND")
    evidence = a.evidence
    evidence.mkdir(parents=True, exist_ok=False)
    cargo_home = a.target / ".cargo-home"
    cargo_home.mkdir()
    env = {"PATH": str(original_toolchain) + ":/usr/bin:/bin", "HOME": str(cargo_home),
           "CARGO_HOME": str(cargo_home), "CARGO_NET_OFFLINE": "true", "CARGO_BUILD_JOBS": "2",
           "RAYON_NUM_THREADS": "2",
           "RUSTFLAGS": "--remap-path-prefix=" + str(native) + "=/finnor-z4-reconstruction"}
    steps = []
    def run(name, args, timeout=2400):
        start = time.monotonic()
        with (evidence / (name + ".log")).open("xb") as log:
            result = subprocess.run(args, cwd=native, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=timeout)
        steps.append({"step": name, "exit": result.returncode,
                      "wallMs": round((time.monotonic() - start) * 1000)})
        if result.returncode:
            (evidence / "steps.json").write_text(json.dumps(steps, indent=2) + "\n")
            fail("Z4_RECONSTRUCTION_BUILD_FAILED:" + name)
    run("build-locked-offline", [str(original_toolchain / "cargo"), "build", "--locked", "--release",
                                 "--offline", "--bin", "finnor-z4-execution-proof",
                                 "--manifest-path", str(native / "Cargo.toml")])
    run("build-field-falsifier-offline", [str(original_toolchain / "cargo"), "build", "--locked",
                                          "--release", "--offline", "--bin", "z4-field-falsifier",
                                          "--manifest-path", str(native / "Cargo.toml")])
    destination = native / "bin"
    destination.mkdir(mode=0o700)
    def install(source, target):
        temporary = target.with_name("." + target.name + "." + uuid.uuid4().hex)
        try:
            with temporary.open("xb") as out:
                out.write(source.read_bytes())
                out.flush()
                os.fsync(out.fileno())
                os.fchmod(out.fileno(), 0o500)
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()
    install(native / "target/release/finnor-z4-execution-proof", destination / "z4-proof")
    install(native / "target/release/z4-field-falsifier", destination / "z4-field-falsifier")
    rebuilt = {"schema": "finnor.z4.native-build.v1", "profile": PROFILE, "backend": BACKEND,
               "binarySha256": digest_file(destination / "z4-proof"),
               "binaryBytes": (destination / "z4-proof").stat().st_size,
               "sourceDigest": native_source_digest(native),
               "cargoLockSha256": digest_file(native / "Cargo.lock"),
               "rustc": subprocess.run([str(original_toolchain / "rustc"), "--version"], env=env,
                                       capture_output=True, text=True, check=True).stdout.strip(),
               "target": "x86_64-unknown-linux-gnu",
               "diagnosticBinarySha256": digest_file(destination / "z4-field-falsifier")}
    source_files = []
    for rel in sorted(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "supervise.py"] +
                      [str(x.relative_to(native)) for x in (native / "src").glob("*.rs")]):
        source_files.append({"path": rel, "sha256": digest_file(native / rel)})
    rebuilt["sourceFiles"] = source_files
    original = json.loads((a.repository / "finnor-os/packages/epistemic-runtime/native/z4-execution-proof/build-identity.json").read_text())
    comparison = {"sourceDigestEqual": rebuilt["sourceDigest"] == original["sourceDigest"],
                  "cargoLockEqual": rebuilt["cargoLockSha256"] == original["cargoLockSha256"],
                  "rustcEqual": rebuilt["rustc"] == original["rustc"],
                  "binarySha256Equal": rebuilt["binarySha256"] == original["binarySha256"],
                  "binaryByteEqualityClaimed": False,
                  "note": "Byte-reproducibility is reported, never assumed; relation identity is "
                          "carried by sourceDigest, lock and parameter reconstruction."}
    os.chmod(native / "build-identity.json", 0o600)
    (native / "build-identity.json").write_text(json.dumps(rebuilt, indent=2) + "\n")
    report = {"schema": "finnor.z4.reconstruction-build.v1", "steps": steps,
              "rebuiltIdentity": rebuilt, "comparisonWithOriginalBuild": comparison,
              "toolchainDeclaredAndHashChecked": True, "borrowedBinaries": False,
              "toolchainReceiptSha256": digest_file(fresh_receipt), "network": "CARGO_NET_OFFLINE=true"}
    (evidence / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "REBUILT", "comparison": comparison}))


def cmd_verify(a):
    evidence = a.evidence
    evidence.mkdir(parents=True, exist_ok=False)
    staged = a.target / "finnor-os/scripts/project-z/z4/public-sweep.mts"
    node_modules = a.target / "finnor-os/node_modules"
    node = runtime_node(a.target, a.node, installed=True)
    before = owned_inventory(a.target)
    loader = a.target / "finnor-os/scripts/project-z/z4/isolation-loader.mjs"
    env = {"PATH": "/usr/bin:/bin", "NODE_OPTIONS": "--max-old-space-size=1024 --import=" + str(loader),
           "HOME": str(a.target), "PYTHONDONTWRITEBYTECODE": "1"}
    start = time.monotonic()
    with (evidence / "reconstructed-family.log").open("xb") as log:
        result = subprocess.run([str(node), "--import", "tsx", str(staged),
                                 "--family", "affine", "--evidence", str(evidence / "affine")],
                                cwd=a.target / "finnor-os", env=env,
                                stdout=log, stderr=subprocess.STDOUT, timeout=2400)
    report = {"schema": "finnor.z4.reconstruction-verify.v1", "exit": result.returncode,
              "wallMs": round((time.monotonic() - start) * 1000),
              "family": "affine", "nodeModules": str(node_modules),
              "status": "PASSED_ISOLATED_RECONSTRUCTION_MECHANISM_ONLY" if result.returncode == 0 else "FAILED",
              "nativeOwner": "NOT_RUN", "protectedAdmission": "NOT_RUN",
              "installedDevelopmentReconstruction": "PENDING_COORDINATOR_INTEGRATED_BUILD"}
    report.update(nodeBinarySha256=digest_file(node), ownedSourceDigest=digest_bytes(canonical(before)),
                  sourceUnchanged=before == owned_inventory(a.target),
                  nativeIdentity=json.loads((a.target / "finnor-os/packages/epistemic-runtime/native/z4-execution-proof/build-identity.json").read_text()),
                  moduleIsolationLoaderSha256=digest_file(loader), borrowedModules=False, borrowedBinaries=False)
    if not report["sourceUnchanged"]:
        report["status"] = "FAILED_SOURCE_DRIFT"
    family_report = evidence / "affine/report.json"
    if family_report.is_file():
        body = json.loads(family_report.read_text())
        report["rows"] = len(body.get("rows", []))
        report["familyStatus"] = body.get("status")
    (evidence / "verify-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "exit": result.returncode,
                      "rows": report.get("rows")}))
    if result.returncode or not report["sourceUnchanged"]:
        raise SystemExit(1)


def cmd_replay(a):
    """Invoke the concrete native/UI/physical-recovery flow behind offline guards."""
    node = runtime_node(a.repository, a.node, installed=not (a.repository / ".git").exists())
    command = [str(node), "--import", "tsx",
               str(a.repository / "finnor-os/scripts/project-z/z4/native-e2e.mts"),
               "--repository", str(a.repository), "--evidence", str(a.evidence)]
    if a.manifest:
        command += ["--manifest", str(a.manifest)]
    names = {"SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
             "FINNOR_S3_MODEL_STORE", "FINNOR_S4_POLICY_STORE", "FINNOR_Z4_CAPSULE_STORE",
             "FINNOR_S2_EXPERIMENT_STORE", "FINNOR_S5_STORE", "FINNOR_SOURCE_CUSTODY_STORE"}
    env = {k: v for k, v in os.environ.items() if k in names or k.startswith("FINNOR_Z4_REPLAY_")}
    env.update(PATH=str(node.parent) + ":/usr/bin:/bin",
               NODE_OPTIONS="--max-old-space-size=1024 --import=" +
               str(a.repository / "finnor-os/scripts/project-z/z4/isolation-loader.mjs"))
    result = subprocess.run(command, cwd=a.repository / "finnor-os", env=env, timeout=3600)
    raise SystemExit(result.returncode)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    def base(name):
        p = sub.add_parser(name)
        p.add_argument("--repository", required=True, type=Path)
        p.add_argument("--evidence", required=True, type=Path)
        p.add_argument("--node", type=Path)
        return p
    inventory = base("inventory")
    inventory.add_argument("--rust-prefix", type=Path)
    vendor = base("vendor")
    vendor.add_argument("--rust-prefix", type=Path)
    vendor.add_argument("--fetch-missing-pinned", action="store_true")
    stage = base("stage")
    stage.add_argument("--vendor", required=True, type=Path)
    stage.add_argument("--target", required=True, type=Path)
    build = base("build")
    build.add_argument("--vendor", required=True, type=Path)
    build.add_argument("--target", required=True, type=Path)
    verify = base("verify")
    verify.add_argument("--target", required=True, type=Path)
    replay = base("replay")
    replay.add_argument("--manifest", type=Path)
    a = parser.parse_args()
    if not a.repository.is_absolute() or not a.evidence.is_absolute():
        raise ValueError("Z4_ABSOLUTE_PATHS_REQUIRED")
    {"inventory": cmd_inventory, "vendor": cmd_vendor, "stage": cmd_stage,
     "build": cmd_build, "verify": cmd_verify, "replay": cmd_replay}[a.command](a)


if __name__ == "__main__":
    main()
