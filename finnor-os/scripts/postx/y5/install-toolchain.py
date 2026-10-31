#!/usr/bin/env python3
"""Install the pinned native verifier in this checkout, never a global SDK."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import time
import urllib.request
import zipfile


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def selected(parts):
    if len(parts) < 2:
        return False
    if parts[1].startswith(("LICENSE", "NOTICE")):
        return True
    if parts[1] == "bin":
        return len(parts) == 3 and parts[2] in ("lean", "lake", "leanchecker")
    if parts[1] == "lib":
        return "clang" not in parts and not parts[-1].endswith((".a", ".o", ".bc"))
    return parts[1] == "src" and parts[-1].endswith(".lean")


def main():
    started = time.monotonic()
    parser = argparse.ArgumentParser()
    parser.add_argument("--tool-root", required=True)
    args = parser.parse_args()
    checkout = Path(__file__).resolve().parents[4]
    root = Path(args.tool_root).expanduser().resolve()
    if not root.is_relative_to(checkout) or root == checkout:
        raise RuntimeError("Tool root must be a dedicated directory inside this checkout")
    lock_bytes = Path(__file__).with_name("toolchain.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    if platform.system() != "Darwin" or platform.machine() != lock["architecture"]:
        raise RuntimeError("Only the registered native darwin-arm64 profile is supported")

    def bounded():
        if time.monotonic() - started > 600:
            raise RuntimeError("Original 600-second installation limit exceeded")

    install = root / lock["archiveRoot"]
    identity_path = install / "finnor-runtime-identity.json"
    if root.exists() and not (root / ".finnor-y5-owned").is_file():
        raise RuntimeError("Refusing an existing directory without task ownership marker")
    root.mkdir(parents=True, exist_ok=True)
    (root / ".finnor-y5-owned").touch(exist_ok=True)
    if install.exists():
        identity = json.loads(identity_path.read_text())
        if identity["lockSha256"] != hashlib.sha256(lock_bytes).hexdigest():
            raise RuntimeError("Existing toolchain lock mismatch; preserve it for inspection")
        for entry in identity["files"]:
            bounded()
            p = install / entry["path"]
            actual = hashlib.sha256(os.readlink(p).encode()).hexdigest() if p.is_symlink() else digest(p)
            if actual != entry["sha256"]:
                raise RuntimeError("Existing runtime asset mismatch: " + entry["path"])
        print(json.dumps({"status": "VERIFIED_EXISTING", "root": str(install),
                          "archiveSha256": lock["sha256"]}))
        return
    archive = root / (lock["archiveRoot"] + ".zip")
    if not archive.exists():
        if shutil.disk_usage(root).free < lock["archiveBytes"] + 3_000_000_000:
            raise RuntimeError("Insufficient disk for the bounded archive/runtime installation")
        request = urllib.request.Request(lock["url"], headers={"User-Agent": "FINNOR-Y5-local-install"})
        with urllib.request.urlopen(request, timeout=30) as response, archive.open("xb") as out:
            count = 0
            while True:
                bounded()
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
                if count > lock["archiveBytes"]:
                    raise RuntimeError("Pinned archive size exceeded")
                out.write(chunk)
    if archive.stat().st_size != lock["archiveBytes"] or digest(archive) != lock["sha256"]:
        raise RuntimeError("Pinned archive integrity failed; partial bytes retained, not executed")

    staging = root / (lock["archiveRoot"] + ".installing")
    if staging.exists():
        raise RuntimeError("Previous incomplete extraction retained; inspect before retry")
    files, links = [], []
    with zipfile.ZipFile(archive) as z:
        chosen = []
        for info in z.infolist():
            path = PurePosixPath(info.filename)
            parts = path.parts
            if path.is_absolute() or ".." in parts or not parts or parts[0] != lock["archiveRoot"]:
                raise RuntimeError("Archive path outside the pinned release root")
            if not info.is_dir() and selected(parts):
                chosen.append(info)
        total = sum(i.file_size for i in chosen)
        if total > 2_800_000_000 or shutil.disk_usage(root).free < total + 1_000_000_000:
            raise RuntimeError("Runtime extraction exceeds registered disk/safety envelope")
        staging.mkdir()
        for info in chosen:
            bounded()
            relative = PurePosixPath(info.filename).relative_to(lock["archiveRoot"])
            path = staging / str(relative)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                target = z.read(info).decode()
                resolved = (path.parent / target).resolve()
                if not resolved.is_relative_to(staging):
                    raise RuntimeError("Archive symlink escapes runtime")
                links.append((path, relative, target))
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            h = hashlib.sha256()
            with z.open(info) as source, path.open("xb") as out:
                while True:
                    bounded()
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    h.update(chunk)
                    out.write(chunk)
            path.chmod(mode & 0o755)
            files.append({"path": str(relative), "sha256": h.hexdigest(), "bytes": info.file_size,
                          "kind": "FILE"})
        for path, relative, target in links:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
            files.append({"path": str(relative), "sha256": hashlib.sha256(target.encode()).hexdigest(),
                          "bytes": len(target.encode()), "kind": "SYMLINK"})
    if digest(staging / "LICENSE") != lock["licenseSourceSha256"]:
        raise RuntimeError("Pinned upstream license mismatch")
    inventory = sorted(files, key=lambda f: f["path"])
    inventory_digest = hashlib.sha256(json.dumps(inventory, separators=(",", ":")).encode()).hexdigest()
    identity = {"schema": "finnor.postx.y5.installed-toolchain.v1", "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
                "archiveSha256": lock["sha256"], "profile": lock["profile"], "inventoryDigest": inventory_digest,
                "files": inventory, "host": {"system": platform.system(), "architecture": platform.machine()},
                "trustPolicyApproval": "NOT_ESTABLISHED"}
    (staging / "finnor-runtime-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    staging.rename(install)
    bounded()
    result = subprocess.run([str(install / "bin/lean"), "--version"], check=True,
                            capture_output=True, text=True, timeout=30)
    if lock["version"] not in result.stdout:
        raise RuntimeError("Installed native version mismatch")
    print(json.dumps({"status": "INSTALLED", "root": str(install), "version": result.stdout.strip(),
                      "archiveSha256": lock["sha256"], "inventoryDigest": inventory_digest,
                      "installedBytes": total, "fileCount": len(inventory),
                      "wallSeconds": time.monotonic() - started,
                      "trustPolicyApproval": "NOT_ESTABLISHED"}))


if __name__ == "__main__":
    main()
