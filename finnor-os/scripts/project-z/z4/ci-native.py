"""Build locked Z4 test assets once; refuse mismatched artifacts before installing.

This prepares existing native CI processes. It grants no runtime/effect admission
and makes no byte-reproducibility, proof-security or phase-completion claim.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from reconstruct import (canonical, digest_bytes, digest_file, git,
                         native_build_identity, native_source_files)

NATIVE = "finnor-os/packages/epistemic-runtime/native/z4-execution-proof"
RECIPE = "finnor-os/scripts/project-z/z4"
RECIPES = [f"{RECIPE}/{name}" for name in
           ("ci-native.py", "reconstruct.py", "install-rust.py", "toolchain-pins.json")]
MEMBERS = {"receipt.json", "build-identity.json", "z4-proof", "z4-field-falsifier"}
QUALIFICATION = "COMPILED_NATIVE_ASSET_INSTALLATION_ONLY_NOT_PHASE_OR_SECURITY_ACCEPTANCE"


def require(condition, code):
    if not condition:
        raise ValueError(code)


def read_json(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 65536,
            "Z4_CI_METADATA_BOUND_OR_TYPE")
    return json.loads(path.read_text())


def source_identity(repository, expected):
    require(re.fullmatch(r"[0-9a-f]{40}", expected) is not None, "Z4_CI_FULL_SOURCE_SHA_REQUIRED")
    require(git(repository, "rev-parse", "HEAD") == expected, "Z4_CI_SOURCE_HEAD_MISMATCH")
    native = repository / NATIVE
    paths = RECIPES + [f"{NATIVE}/{item['path']}" for item in native_source_files(native)]
    # Build the committed inputs, rather than label an uncommitted repair as HEAD.
    for relative in paths:
        path = repository / relative
        require(path.is_file() and not path.is_symlink(), "Z4_CI_SOURCE_FILE_TYPE")
        committed = subprocess.run(["git", "-C", str(repository), "show", f"HEAD:{relative}"],
                                   capture_output=True, check=True).stdout
        require(digest_bytes(committed) == digest_file(path), "Z4_CI_SOURCE_DIRTY")
    return {"sourceCommit": expected, "sourceTree": git(repository, "rev-parse", "HEAD^{tree}"),
            "recipeSha256": digest_bytes(canonical([
                {"path": path, "sha256": digest_file(repository / path)} for path in RECIPES]))}


def atomic_file(path, data, mode):
    require(not path.is_symlink(), "Z4_CI_INSTALL_SYMLINK")
    fd, name = tempfile.mkstemp(prefix=".z4-ci-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def prepare(a):
    source = source_identity(a.repository, a.expected_sha)
    require(a.output.is_absolute() and not a.output.exists(), "Z4_CI_NEW_OUTPUT_REQUIRED")
    require(a.work.is_absolute() and not a.work.exists(), "Z4_CI_NEW_WORK_REQUIRED")
    a.work.mkdir(mode=0o700, parents=True)
    a.output.mkdir(mode=0o700, parents=True)
    native = a.repository / NATIVE
    pins = read_json(a.repository / RECIPE / "toolchain-pins.json")["rust"]
    toolchain = a.toolchain_root or a.work / "rust"
    if not a.toolchain_root:
        subprocess.run([sys.executable, str(a.repository / RECIPE / "install-rust.py"),
                        "--prefix", str(toolchain)], check=True, timeout=1200)
    toolchain_receipt = read_json(toolchain / "receipt.json")
    require(toolchain_receipt["version"] == pins["version"]
            and toolchain_receipt["target"] == pins["target"]
            and [{k: c[k] for k in ("component", "url", "sha256")}
                 for c in toolchain_receipt["components"]] == pins["components"],
            "Z4_CI_TOOLCHAIN_RECEIPT_MISMATCH")
    # Recheck the original downloaded bytes, including when using a local owned cache.
    for item in pins["components"]:
        archive = toolchain / item["url"].rsplit("/", 1)[1]
        require(digest_file(archive) == item["sha256"], "Z4_CI_TOOLCHAIN_ARCHIVE_CHANGED")
    compiler = toolchain / "installed/bin"
    env = {"PATH": str(compiler) + ":/usr/bin:/bin", "HOME": str(a.work),
           "CARGO_HOME": str(a.work / "cargo-home"), "CARGO_NET_GIT_FETCH_WITH_CLI": "true",
           "CARGO_BUILD_JOBS": "2", "RAYON_NUM_THREADS": "2", "LANG": "C.UTF-8",
           "RUSTFLAGS": f"--remap-path-prefix={native}=/finnor-z4-reconstruction"}
    rustc = subprocess.run([str(compiler / "rustc"), "--version"], env=env,
                           check=True, capture_output=True, text=True).stdout.strip()
    require(rustc.startswith(f"rustc {pins['version']} "), "Z4_CI_COMPILER_VERSION_MISMATCH")
    vendor = a.work / "vendor"
    config = a.work / "vendor.toml"
    # Public dependency transport may require the host's proxy. Never inherit
    # product/database credentials, Git credential helpers or the complete host env.
    transport = {**env, **{key: os.environ[key] for key in
        ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
         "http_proxy", "https_proxy", "all_proxy", "no_proxy") if key in os.environ}}
    with config.open("xb") as out, (a.work / "vendor.log").open("xb") as log:
        subprocess.run([str(compiler / "cargo"), "vendor", "--locked", str(vendor)],
                       cwd=native, env=transport, stdout=out, stderr=log, check=True, timeout=1200)
    env["CARGO_NET_OFFLINE"] = "true"
    with (a.work / "build.log").open("xb") as log:
        subprocess.run([str(compiler / "cargo"), "build", "--frozen", "--release", "--bins",
                        "--target-dir", str(a.work / "target"), "--config", str(config)],
                       cwd=native, env=env, stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=2400)
    require(source_identity(a.repository, a.expected_sha) == source, "Z4_CI_BUILD_SOURCE_MOVED")
    proof = a.work / "target/release/finnor-z4-execution-proof"
    diagnostic = a.work / "target/release/z4-field-falsifier"
    identity = native_build_identity(native, proof, diagnostic, rustc)
    for name, path in (("z4-proof", proof), ("z4-field-falsifier", diagnostic)):
        require(0 < path.stat().st_size <= 64 * 1024**2, "Z4_CI_BINARY_BOUND")
        atomic_file(a.output / name, path.read_bytes(), 0o500)
    identity_bytes = (json.dumps(identity, indent=2) + "\n").encode()
    atomic_file(a.output / "build-identity.json", identity_bytes, 0o600)
    receipt = {"schema": "finnor.z4.ci-assets.v1", **source,
               "identitySha256": digest_bytes(identity_bytes),
               "binarySha256": identity["binarySha256"],
               "diagnosticBinarySha256": identity["diagnosticBinarySha256"],
               "toolchainReceiptSha256": digest_file(toolchain / "receipt.json"),
               "compilerSha256": digest_file(compiler / "rustc"),
               "cargoSha256": digest_file(compiler / "cargo"),
               "buildMode": "cargo-vendor-locked-then-build-frozen-offline",
               "qualification": QUALIFICATION}
    atomic_file(a.output / "receipt.json", (json.dumps(receipt, indent=2) + "\n").encode(), 0o600)
    print(json.dumps({"status": "PREPARED", **receipt}))


def install(a):
    source = source_identity(a.repository, a.expected_sha)
    require(a.artifact.is_absolute() and a.artifact.is_dir() and not a.artifact.is_symlink(),
            "Z4_CI_ARTIFACT_DIRECTORY")
    require({p.name for p in a.artifact.iterdir()} == MEMBERS, "Z4_CI_ARTIFACT_MEMBERS")
    for path in a.artifact.iterdir():
        require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 64 * 1024**2,
                "Z4_CI_ARTIFACT_FILE_TYPE_OR_BOUND")
    receipt = read_json(a.artifact / "receipt.json")
    identity = read_json(a.artifact / "build-identity.json")
    require(receipt["schema"] == "finnor.z4.ci-assets.v1"
            and receipt["qualification"] == QUALIFICATION, "Z4_CI_RECEIPT_SCHEMA")
    require(all(receipt[key] == value for key, value in source.items()), "Z4_CI_ARTIFACT_SOURCE_MISMATCH")
    require(digest_file(a.artifact / "build-identity.json") == receipt["identitySha256"],
            "Z4_CI_ARTIFACT_IDENTITY_CHANGED")
    pins = read_json(a.repository / RECIPE / "toolchain-pins.json")["rust"]
    require(identity["rustc"].startswith(f"rustc {pins['version']} "), "Z4_CI_COMPILER_VERSION_MISMATCH")
    expected = native_build_identity(a.repository / NATIVE, a.artifact / "z4-proof",
                                     a.artifact / "z4-field-falsifier", identity["rustc"])
    require(identity == expected and receipt["binarySha256"] == identity["binarySha256"]
            and receipt["diagnosticBinarySha256"] == identity["diagnosticBinarySha256"],
            "Z4_CI_ARTIFACT_NATIVE_IDENTITY_MISMATCH")
    native = a.repository / NATIVE
    require(not native.is_symlink() and not (native / "bin").is_symlink(), "Z4_CI_INSTALL_SYMLINK")
    destinations = [(a.artifact / name, native / "bin" / name, 0o500)
                    for name in ("z4-proof", "z4-field-falsifier")]
    destinations.append((a.artifact / "build-identity.json", native / "build-identity.json", 0o600))
    # Preparation is allowed only in a fresh checkout, or idempotently for this exact build.
    for src, dst, _ in destinations:
        require(not dst.is_symlink(), "Z4_CI_INSTALL_SYMLINK")
        if dst.parent.name == "bin" and dst.exists():
            require(dst.is_file() and digest_file(dst) == digest_file(src), "Z4_CI_EXISTING_BINARY_DIFFERS")
    # All validations precede the first write. Runtime identity also rejects partial crash installs.
    (native / "bin").mkdir(mode=0o700, exist_ok=True)
    for src, dst, mode in destinations:
        atomic_file(dst, src.read_bytes(), mode)
    print(json.dumps({"status": "INSTALLED", **source, "binarySha256": identity["binarySha256"],
                      "qualification": QUALIFICATION}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "install"):
        command = commands.add_parser(name)
        command.add_argument("--repository", type=Path, required=True)
        command.add_argument("--expected-sha", required=True)
        if name == "prepare":
            command.add_argument("--output", type=Path, required=True)
            command.add_argument("--work", type=Path, required=True)
            command.add_argument("--toolchain-root", type=Path)
        else:
            command.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    require(args.repository.is_absolute(), "Z4_CI_ABSOLUTE_REPOSITORY_REQUIRED")
    (prepare if args.command == "prepare" else install)(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        # No arbitrary log/error payloads enter the shared receipt.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"Z4_[A-Z_]+", str(error)) else "Z4_CI_PREPARATION_FAILED"
        print(json.dumps({"status": "REFUSED", "code": code}), file=sys.stderr)
        sys.exit(1)
