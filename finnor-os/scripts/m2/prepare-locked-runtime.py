"""Fresh exact-lock frontend runtime without a disk archive cache or lifecycle scripts.

Usage: python prepare-locked-runtime.py REPO EVIDENCE_DIR
Production graph, required peers, compatible optional packages, and essential
TypeScript/types/CSS tools are selected from the existing root lockfile.
Source maps and unrelated lint/test tools are explicitly outside this runtime.
"""
import base64
import gzip
import hashlib
import io
import json
import os
import pathlib
import platform
import resource
import ssl
import sys
import tarfile
import time
import urllib.parse
import urllib.request

repo = pathlib.Path(sys.argv[1]).resolve(strict=True)
evidence = pathlib.Path(sys.argv[2]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
if (evidence / "receipt.json").exists():
    raise SystemExit("Immutable installation receipt already exists")
lock_bytes = (repo / "package-lock.json").read_bytes()
lock = json.loads(lock_bytes)
packages = lock["packages"]
system = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}[platform.system()]
cpu = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}[platform.machine()]
runtime = repo / "node_modules"
if runtime.exists():
    raise SystemExit("Fresh destination required; preserve or remove only its failed partial runtime first")
essential = [n for n in packages[""].get("devDependencies", {})
             if n.startswith("@types/") or n in {"typescript", "tailwindcss", "postcss", "autoprefixer"}]
selected = set()


def compatible(entry):
    for field, value in (("os", system), ("cpu", cpu)):
        choices = entry.get(field)
        if choices and ("!" + value in choices or
                        any(not x.startswith("!") for x in choices) and value not in choices):
            return False
    return True


def resolve(parent, name):
    path = pathlib.PurePosixPath(parent)
    while True:
        candidate = (str(path) + "/" if str(path) != "." else "") + "node_modules/" + name
        if candidate in packages:
            return candidate
        if str(path) == ".":
            return None
        path = path.parent
        if path.name == "node_modules":
            path = path.parent


def visit(parent, name, optional=False):
    key = resolve(parent, name)
    if key is None:
        if optional:
            return
        raise ValueError("Missing required locked dependency: " + parent + " / " + name)
    entry = packages[key]
    if not compatible(entry):
        if optional:
            return
        raise ValueError("Unsupported required platform: " + key)
    if key in selected:
        return
    selected.add(key)
    if len(selected) > 1200:
        raise ValueError("Package graph bound")
    for dep in entry.get("dependencies", {}):
        visit(key, dep)
    for dep in entry.get("optionalDependencies", {}):
        visit(key, dep, True)
    for dep in entry.get("peerDependencies", {}):
        visit(key, dep, entry.get("peerDependenciesMeta", {}).get(dep, {}).get("optional", False))


for name in list(packages[""].get("dependencies", {})) + essential:
    visit("", name)
if not selected:
    raise ValueError("Zero-package runtime cannot pass")
started = time.monotonic()
receipt = {"schema": "finnor.m2.exact-lock-runtime.v1", "status": "INCOMPLETE",
           "repo": str(repo), "runtime": str(runtime), "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
           "platform": {"os": system, "cpu": cpu}, "essentialDevelopmentRoots": essential,
           "selectedPackagePaths": sorted(selected), "packages": [], "lifecycleScriptsExecuted": False,
           "qualification": "Fresh SRI-verified locked required runtime; source maps and unrelated lint/test tools omitted; no full clean dependency/image or protected resource attestation",
           "costUSD": None, "command": sys.argv, "python": sys.version}
(evidence / "preparation-freeze.json").write_text(json.dumps(receipt, indent=2) + "\n")
installed_files = []
omitted = []
duplicates = []
bins = {}
network_bytes = 0
installed_bytes = 0
try:
    for key in sorted(selected, key=lambda x: (x.count("/node_modules/"), x)):
        entry = packages[key]
        url = entry.get("resolved", "")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "registry.npmjs.org" or not entry.get("integrity"):
            raise ValueError("Exact registry/SRI package required: " + key)
        with urllib.request.urlopen(url, timeout=60, context=ssl.create_default_context()) as response:
            if urllib.parse.urlparse(response.geturl()).hostname != "registry.npmjs.org":
                raise ValueError("Unexpected registry redirect")
            archive = response.read(192 * 1024 * 1024 + 1)
        if len(archive) > 192 * 1024 * 1024:
            raise ValueError("Archive byte bound")
        network_bytes += len(archive)
        if network_bytes > 2 * 1024 * 1024 * 1024 or time.monotonic() - started > 1800:
            raise ValueError("Aggregate network/time bound")
        matches = []
        for integrity in entry["integrity"].split():
            algorithm, encoded = integrity.split("-", 1)
            if algorithm in {"sha512", "sha384", "sha256", "sha1"}:
                matches.append(hashlib.new(algorithm, archive).digest() == base64.b64decode(encoded, validate=True))
        if not matches or not any(matches):
            raise ValueError("Archive integrity mismatch: " + key)
        target = repo / key
        if not target.is_relative_to(runtime) or target.is_symlink():
            raise ValueError("Invalid locked package destination")
        target.mkdir(parents=True, exist_ok=True)
        records = []
        seen_members = {}
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            for member in tar:
                parts = pathlib.PurePosixPath(member.name).parts
                if not parts or parts[0] != "package" or ".." in parts or member.name.startswith("/"):
                    raise ValueError("Archive path escape")
                if len(parts) == 1:
                    continue
                relative = pathlib.Path(*parts[1:])
                path = target / relative
                if not path.parent.resolve().is_relative_to(target.resolve()):
                    raise ValueError("Archive parent link escape")
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                if member.size > 256 * 1024 * 1024:
                    raise ValueError("Member byte bound")
                if str(relative).endswith(".map"):
                    omitted.append({"path": str(path.relative_to(repo)), "bytes": member.size, "reason": "NONEXECUTED_SOURCE_MAP"})
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                if member.issym():
                    if os.path.isabs(member.linkname) or not (path.parent / member.linkname).resolve().is_relative_to(target.resolve()):
                        raise ValueError("Archive symlink escape")
                    path.symlink_to(member.linkname)
                    row = {"path": str(path.relative_to(repo)), "kind": "symlink", "target": member.linkname}
                elif member.isfile():
                    canonical_path = str(path.relative_to(repo))
                    if canonical_path in seen_members:
                        # Some SRI-verified npm archives repeat ./-normalized
                        # members. Accept only an identical same-package file;
                        # never overwrite or adopt an unrelated existing file.
                        prior = seen_members[canonical_path]
                        source = tar.extractfile(member)
                        if source is None or prior["kind"] != "file" or member.size != prior["bytes"] or oct(member.mode & 0o777) != prior["mode"]:
                            raise ValueError("Conflicting canonical archive member")
                        digest = hashlib.sha256()
                        copied = 0
                        while chunk := source.read(1024 * 1024):
                            copied += len(chunk)
                            if copied > member.size:
                                raise ValueError("Duplicate member length mismatch")
                            digest.update(chunk)
                        if copied != member.size or digest.hexdigest() != prior["sha256"]:
                            raise ValueError("Conflicting duplicate archive bytes")
                        duplicates.append({"path": canonical_path, "archiveMember": member.name, "sha256": digest.hexdigest()})
                        if len(duplicates) > 120000:
                            raise ValueError("Duplicate member count bound")
                        continue
                    installed_bytes += member.size
                    if installed_bytes > 2 * 1024 * 1024 * 1024:
                        raise ValueError("Aggregate installed byte bound")
                    digest = hashlib.sha256()
                    copied = 0
                    source = tar.extractfile(member)
                    if source is None:
                        raise ValueError("Missing member stream")
                    with path.open("xb") as output:
                        while chunk := source.read(1024 * 1024):
                            copied += len(chunk)
                            if copied > member.size:
                                raise ValueError("Member length mismatch")
                            digest.update(chunk)
                            output.write(chunk)
                    if copied != member.size:
                        raise ValueError("Incomplete member")
                    path.chmod(member.mode & 0o777)
                    row = {"path": str(path.relative_to(repo)), "kind": "file", "bytes": copied,
                           "mode": oct(member.mode & 0o777), "sha256": digest.hexdigest()}
                else:
                    raise ValueError("Hardlink/device/FIFO package member refused")
                records.append(row)
                seen_members[row["path"]] = row
                if len(installed_files) + len(records) > 120000:
                    raise ValueError("Installed member count bound")
        package_json = target / "package.json"
        package = json.loads(package_json.read_text())
        if package.get("version") != entry["version"]:
            raise ValueError("Installed version differs from lock")
        descriptor = package.get("bin", {})
        if isinstance(descriptor, str):
            descriptor = {package["name"].split("/")[-1]: descriptor}
        for name, relative_bin in descriptor.items():
            if pathlib.PurePosixPath(name).name != name or name in {".", ".."}:
                raise ValueError("Invalid binary link name")
            binary = target / relative_bin
            if not binary.resolve().is_relative_to(target.resolve()) or not binary.is_file():
                raise ValueError("Invalid package binary")
            bin_dir = (repo / key.rsplit("/node_modules/", 1)[0] / "node_modules" / ".bin"
                       if "/node_modules/" in key else runtime / ".bin")
            bin_dir.mkdir(parents=True, exist_ok=True)
            link = bin_dir / name
            if link.exists() or link.is_symlink():
                if link.resolve() != binary.resolve():
                    raise ValueError("Conflicting package binary")
            else:
                link.symlink_to(os.path.relpath(binary, bin_dir))
            bins[str(link.relative_to(repo))] = os.readlink(link)
        installed_files.extend(records)
        receipt["packages"].append({"path": key, "name": package["name"], "version": entry["version"],
                                    "resolved": url, "integrity": entry["integrity"],
                                    "archiveSha256": hashlib.sha256(archive).hexdigest(),
                                    "packageJsonSha256": hashlib.sha256(package_json.read_bytes()).hexdigest(),
                                    "fileCount": len(records), "fileManifestSha256": hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()})
        if len(receipt["packages"]) % 25 == 0:
            print(json.dumps({"installed": len(receipt["packages"]), "total": len(selected)}), flush=True)
    if (repo / "package-lock.json").read_bytes() != lock_bytes:
        raise ValueError("Lock changed during installation")
    # Independent second read: every installed regular file and link must still
    # match the exact member bytes/mode written from the SRI-verified archives.
    for row in installed_files:
        path = repo / row["path"]
        if row["kind"] == "symlink":
            if not path.is_symlink() or os.readlink(path) != row["target"]:
                raise ValueError("Installed symlink changed")
        elif path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"] or oct(path.stat().st_mode & 0o777) != row["mode"]:
            raise ValueError("Installed member changed")
    receipt["status"] = "PASS_SCOPED_REQUIRED_RUNTIME"
except BaseException as error:
    receipt["failure"] = {"type": type(error).__name__, "message": str(error)}
    raise
finally:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    receipt.update(elapsedSeconds=time.monotonic() - started, networkBytes=network_bytes, installedBytes=installed_bytes,
                   measuredMaxRssNativeUnits=usage.ru_maxrss, measuredUserCpuSeconds=usage.ru_utime,
                   measuredSystemCpuSeconds=usage.ru_stime, aggregatePhysicalAttestation=None,
                   installedFileCount=len(installed_files), omittedSourceMapCount=len(omitted), binaryLinks=bins)
    receipt["identicalCanonicalDuplicateMembers"] = duplicates
    with gzip.open(evidence / "installed-files.json.gz", "wt") as output:
        json.dump(installed_files, output, sort_keys=True)
    with gzip.open(evidence / "omitted-members.json.gz", "wt") as output:
        json.dump(omitted, output, sort_keys=True)
    receipt["installedFileManifestSha256"] = hashlib.sha256((evidence / "installed-files.json.gz").read_bytes()).hexdigest()
    receipt["omittedManifestSha256"] = hashlib.sha256((evidence / "omitted-members.json.gz").read_bytes()).hexdigest()
    (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"status": receipt["status"], "packages": len(receipt["packages"]), "evidence": str(evidence)}))
