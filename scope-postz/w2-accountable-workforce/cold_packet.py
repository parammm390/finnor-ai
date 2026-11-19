"""Sealed source/cache/toolchain intake shared by the W2 cold producer/consumer."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("w2_job", Path(__file__).with_name("run-job.py"))
job = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = job
spec.loader.exec_module(job)
SCHEMA = "finnor.w2.sealed-cold-packet.v1"
_PUBLIC_NPM_CONFIGURATION = {
    "class": "TRACKED_PUBLIC_NPM_BOOLEAN_FLAGS_V1",
    "gitBlob": "51df798a520d03f9313c458c9c67008676b094d0",
    "sha256": "5602bb233ec1478ef60941257e98dfa8a86c9aeb22a4705aeb4beb15605e8a40",
    "bytes": 23,
    "mode": 0o644,
}
PUBLIC_NPM_CONFIGURATIONS = {
    name: _PUBLIC_NPM_CONFIGURATION for name in (".npmrc", "finnor-os/.npmrc")
}


def relative(value):
    if not isinstance(value, str):
        raise ValueError("CANONICAL_RELATIVE_PACKET_PATH_REQUIRED")
    path = PurePosixPath(value)
    if (not isinstance(value, str) or not value or path.is_absolute() or "\\" in value
            or ".." in path.parts or "." in path.parts or path.as_posix() != value):
        raise ValueError("CANONICAL_RELATIVE_PACKET_PATH_REQUIRED")
    return path.as_posix()


def source_path(value, row=None):
    name = relative(value)
    path = PurePosixPath(name)
    if (set(path.parts) & {".git", "node_modules", ".venv", "__pycache__"}
            or name == "artifacts" or name.startswith("artifacts/")
            or any(part.startswith((".next", ".turbo")) for part in path.parts)):
        raise ValueError("ONLY_SEALED_SOURCE_NOT_DONOR_RUNTIME_REQUIRED")
    if ((path.name.startswith(".env") and not path.name.endswith((".example", ".template")))
            or path.name in {".pypirc", ".git-credentials", ".job-owner.json", ".campaign-owner.json", ".owner.json",
                             ".process-group.json", "mounted-private-fixture.json", "driver.log"}):
        raise ValueError("PRIVATE_CONFIGURATION_MUST_NOT_ENTER_SOURCE_PACKET")
    if path.name == ".npmrc":
        expected = PUBLIC_NPM_CONFIGURATIONS.get(name)
        if (expected is None or not isinstance(row, dict) or row.get("path") != name
                or any(row.get(key) != expected[key] for key in ("sha256", "bytes", "mode"))
                or row.get("publicConfiguration") !=
                   {key: expected[key] for key in ("class", "gitBlob")}):
            raise ValueError("PRIVATE_CONFIGURATION_MUST_NOT_ENTER_SOURCE_PACKET")
    elif isinstance(row, dict) and "publicConfiguration" in row:
        raise ValueError("UNDECLARED_PUBLIC_CONFIGURATION_CLASS")
    return name


def validate_source_rows(rows):
    if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows):
        raise ValueError("EXACT_SOURCE_FILE_POPULATION_REQUIRED")
    names = [source_path(row["path"], row) for row in rows]
    for row in rows:
        if (type(row["bytes"]) is not int or row["bytes"] < 0 or row["bytes"] > 268435456
                or type(row["mode"]) is not int or row["mode"] & ~0o777
                or not isinstance(row["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"])):
            raise ValueError("EXACT_SOURCE_FILE_BYTES_MODE_AND_HASH_REQUIRED")
    if len(names) != len(set(names)):
        raise ValueError("DUPLICATE_SOURCE_FILE_REFUSED")
    if not set(PUBLIC_NPM_CONFIGURATIONS).issubset(names):
        raise ValueError("TRACKED_PUBLIC_NPM_CONFIGURATION_MUST_REMAIN_IN_SOURCE")
    if not {"package-lock.json", "finnor-os/package-lock.json"}.issubset(names):
        raise ValueError("BOTH_ORIGINAL_LOCKS_REQUIRED")
    return names


def verify_public_configuration(source, name, row):
    source_path(name, row)
    expected = PUBLIC_NPM_CONFIGURATIONS.get(name)
    if expected is None:
        raise ValueError("EXACT_TRACKED_PUBLIC_CONFIGURATION_REQUIRED")
    path = Path(source)
    if path.is_symlink():
        raise ValueError("PUBLIC_CONFIGURATION_SYMLINK_REFUSED")
    if path.resolve(strict=True) == Path.home().resolve(strict=True):
        raise ValueError("USER_HOME_CONFIGURATION_MUST_NOT_ENTER_SOURCE_PACKET")
    for part in PurePosixPath(name).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("PUBLIC_CONFIGURATION_SYMLINK_REFUSED")
    verify_file(path, row)
    if stat.S_IMODE(path.lstat().st_mode) != expected["mode"]:
        raise ValueError("PUBLIC_CONFIGURATION_MODE_CHANGED")
    blob = expected["gitBlob"]
    committed = git(source, "--no-replace-objects", "ls-tree", "-z", "HEAD", "--", name)
    indexed = git(source, "ls-files", "--stage", "-z", "--", name)
    if committed != ("100644 blob " + blob + "\t" + name + "\0").encode():
        raise ValueError("PUBLIC_CONFIGURATION_HEAD_BLOB_BINDING_REQUIRED")
    if indexed != ("100644 " + blob + " 0\t" + name + "\0").encode():
        raise ValueError("PUBLIC_CONFIGURATION_TRACKED_INDEX_BINDING_REQUIRED")
    data = git(source, "--no-replace-objects", "cat-file", "blob", blob)
    if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
        raise ValueError("PUBLIC_CONFIGURATION_GIT_BYTES_CHANGED")
    return dict(row["publicConfiguration"])


def packet_asset(manifest, name):
    root = Path(manifest).parent.resolve(strict=True)
    path = root / relative(name)
    if not path.resolve(strict=True).is_relative_to(root):
        raise ValueError("SEALED_PACKET_ASSET_ESCAPE")
    return path


def pin(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("REGULAR_DECLARED_ASSET_REQUIRED")
    return {"path": str(path), "bytes": info.st_size, "sha256": job.sha(path)}


def verify_file(path, row):
    observed = pin(path)
    if observed["sha256"] != row["sha256"] or observed["bytes"] != row["bytes"]:
        raise ValueError("EXACT_DECLARED_ASSET_BYTES_REQUIRED")


def population(root):
    root = Path(root).resolve(strict=True)
    rows = []
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(directory) / name
            if path.is_symlink():
                target = os.readlink(path)
                if not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError("DECLARED_DISTRIBUTION_LINK_MUST_REMAIN_INSIDE_ROOT")
                rows.append({"path": path.relative_to(root).as_posix(), "type": "link", "target": target})
            elif path.is_file():
                row = pin(path)
                row["path"] = path.relative_to(root).as_posix()
                row["type"] = "file"
                rows.append(row)
            elif not path.is_dir():
                raise ValueError("DECLARED_DISTRIBUTION_SPECIAL_FILE_REFUSED")
    return sorted(rows, key=lambda row: row["path"])


def verify_runtime(runtime):
    if runtime["platform"] != sys.platform or runtime["architecture"] != os.uname().machine:
        raise ValueError("ACTUAL_DECLARED_COLD_HOST_PLATFORM_REQUIRED")
    for name in ("node", "python", "npmCli"):
        verify_file(Path(runtime[name]["path"]), runtime[name])
    npm = runtime["npmCli"]
    if population(npm["distributionRoot"]) != npm["assets"]:
        raise ValueError("FULL_DECLARED_NPM_RUNTIME_DISTRIBUTION_REQUIRED")
    if not Path(npm["path"]).resolve().is_relative_to(Path(npm["distributionRoot"]).resolve()):
        raise ValueError("NPM_CLI_MUST_BE_IN_DECLARED_DISTRIBUTION")


def verify_cache(cache, root):
    root = Path(root).resolve(strict=True)
    seen = set()
    for row in cache["assets"]:
        name = relative(row["path"])
        if name in seen or not name.startswith("_cacache/content-v2/"):
            raise ValueError("EXACT_CONTENT_ADDRESSED_NPM_CACHE_POPULATION_REQUIRED")
        seen.add(name)
        path = root / name
        if not path.resolve(strict=True).is_relative_to(root):
            raise ValueError("CACHE_ASSET_ESCAPE")
        verify_file(path, row)
        parts = PurePosixPath(name).parts
        if (len(parts) != 6 or parts[2] != "sha512" or list(map(len, parts[3:])) != [2, 2, 124]
                or not all(re.fullmatch(r"[a-f0-9]+", part) for part in parts[3:])):
            raise ValueError("CACACHE_SHA512_CONTENT_ADDRESS_REQUIRED")
        digest = hashlib.sha512()
        with path.open("rb") as stream:
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
        if digest.hexdigest() != parts[3] + parts[4] + parts[5]:
            raise ValueError("CACHE_ASSET_CONTENT_ADDRESS_MISMATCH")
    if not seen:
        raise ValueError("DECLARED_NPM_PACKAGE_ASSETS_REQUIRED")
    observed = {row["path"] for row in population(root)}
    if observed != seen:
        raise ValueError("CACHE_MUST_CONTAIN_EXACTLY_DECLARED_REGULAR_ASSETS")


def verify_installation(root, frontend=False):
    root = Path(root).resolve(strict=True)
    manifest_name = "w2-frontend-installation.json" if frontend else "finnor-os/w2-development-installation.json"
    manifest_path = root / manifest_name
    manifest = json.loads(manifest_path.read_text())
    schema = "finnor.postz.w2." + ("frontend" if frontend else "development") + "-installation.v1"
    if (manifest.get("schema") != schema or manifest.get("mode") != "DEVELOPMENT_ONLY"
            or manifest.get("productionActive") is not False):
        raise ValueError("EXACT_W2_DEVELOPMENT_INSTALLATION_REQUIRED")
    files, links = {}, {}
    for row in manifest.get("files", []):
        name = relative(row["path"])
        if name in files or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]):
            raise ValueError("DUPLICATE_OR_INVALID_INSTALLED_FILE")
        files[name] = row
        path = root / name
        if not path.resolve(strict=True).is_relative_to(root):
            raise ValueError("INSTALLED_FILE_ESCAPE")
        verify_file(path, row)
        if stat.S_IMODE(path.lstat().st_mode) != row["mode"]:
            raise ValueError("INSTALLED_FILE_MODE_CHANGED")
    for row in manifest.get("links", []):
        name = relative(row["path"])
        path = root / name
        if (name in files or name in links or not path.is_symlink()
                or os.readlink(path) != row["target"] or not path.resolve(strict=True).is_relative_to(root)):
            raise ValueError("INSTALLED_LINK_MISSING_CHANGED_OR_ESCAPED")
        links[name] = row["target"]
    if not files:
        raise ValueError("NONEMPTY_ACTUAL_INSTALLED_FILE_POPULATION_REQUIRED")
    extras = {manifest_name}
    if frontend:
        extras.add("build-resources.json")
        receipt = manifest["buildReceipt"]
        if receipt["path"] != "build-resources.json" or job.sha(root / receipt["path"]) != receipt["sha256"]:
            raise ValueError("ACTUAL_FRONTEND_BUILD_RECEIPT_REQUIRED")
    actual = population(root)
    if ({row["path"] for row in actual if row["type"] == "file"} != set(files) | extras
            or {row["path"] for row in actual if row["type"] == "link"} != set(links)):
        raise ValueError("EXACT_INSTALLED_FILE_AND_LINK_CLOSURE_REQUIRED")
    return manifest


def verify_baseline(file, packet):
    baseline = packet["baseline"]
    values = {}
    for name in ("manifest", "nativeReport", "nativeFreeze", "nativePositive", "nativeCleanup", "nativeCustody"):
        path = packet_asset(file, baseline[name]["path"])
        verify_file(path, baseline[name])
        values[name] = json.loads(path.read_text())
    report, freeze, cleanup = values["nativeReport"], values["nativeFreeze"], values["nativeCleanup"]
    if (report.get("status") != "PASS" or report.get("installedRuntime") is not True
            or report.get("actualOrdinaryAuthentication") is not True or report.get("actualRestrictedRoles") is not True
            or any(row.get("status") != "PASS" for row in report.get("results", [])) or not report.get("results")
            or cleanup.get("status") != "PASS" or not cleanup.get("steps")
            or any(row.get("status") != "PASS" for row in cleanup["steps"])):
        raise ValueError("ACTUAL_INSTALLED_BASELINE_NATIVE_AND_CLEANUP_PASS_REQUIRED")
    if freeze.get("installation", {}).get("manifestSha256") != baseline["manifest"]["sha256"]:
        raise ValueError("BASELINE_NATIVE_MUST_BIND_ACTUAL_INSTALLATION_MANIFEST")
    manifest = verify_installation(baseline["installationRoot"])
    actual = Path(baseline["installationRoot"]) / "finnor-os/w2-development-installation.json"
    verify_file(actual, baseline["manifest"])
    if any(freeze["source"][key] != manifest["source"][key] for key in ("commit", "tree")):
        raise ValueError("BASELINE_NATIVE_AND_INSTALLED_SOURCE_CUT_MISMATCH")
    positive = values["nativePositive"]
    if positive.get("completed", {}).get("currentCheck", {}).get("valid") is not True:
        raise ValueError("ACTUAL_NATIVE_CHECKED_POSITIVE_REQUIRED")
    custody = values["nativeCustody"]
    target = {row["path"]: row for row in manifest["files"]}.get(custody.get("target"))
    if (not target or target["sha256"] != custody.get("originalSha256")
            or custody.get("refusalStatus") != 503 or custody.get("restoredStatus") != 200
            or custody.get("sourceRestoredExactly") is not True or custody.get("originalManifestUnchanged") is not True
            or not any(row.get("id") == "installed-owner-byte-mismatch-refusal-and-exact-restoration"
                       and row.get("status") == "PASS" for row in report["results"])):
        raise ValueError("ACTUAL_INSTALLED_SOURCE_TAMPER_REFUSAL_AND_EXACT_RESTORATION_REQUIRED")
    return values


def inspect_packet(file, expected_sha):
    file = Path(file)
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha) or job.sha(file) != expected_sha:
        raise ValueError("EXPLICIT_SEALED_MANIFEST_SHA256_REQUIRED")
    packet = json.loads(file.read_text())
    if packet["schema"] != SCHEMA:
        raise ValueError("EXACT_W2_COLD_PACKET_SCHEMA_REQUIRED")
    for name in ("sourceArchive", "sourceGitObjects"):
        asset = packet[name]
        verify_file(file.parent / relative(asset["path"]), asset)
    validate_source_rows(packet["source"]["files"])
    commits = packet["source"]["gitCommits"]
    if (not isinstance(commits, list) or not commits
            or any(not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit) for commit in commits)
            or packet["source"]["identity"]["commit"] not in commits):
        raise ValueError("ACTUAL_SOURCE_COMMIT_OBJECT_REQUIRED")
    verify_runtime(packet["runtime"])
    verify_cache(packet["packageCache"], packet_asset(file, packet["packageCache"]["root"]))
    verify_baseline(file, packet)
    if packet["forecastNetNewBytes"] < sum(row["bytes"] for row in packet["source"]["files"]) + sum(
            row["bytes"] for row in packet["packageCache"]["assets"]) + 5 * 1024 ** 3:
        raise ValueError("COMPLETE_COLD_SOURCE_CACHE_AND_DEPENDENCY_BUILD_ALLOCATION_REQUIRED")
    job.canonical_origin(packet["frontendOrigin"])
    return packet


def extract_source(archive_path, rows, target):
    validate_source_rows(rows)
    target = Path(target)
    target.mkdir(mode=0o700)
    expected = {relative(row["path"]): row for row in rows}
    seen = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            name = relative(member.name)
            if name in seen or name not in expected or not member.isfile() or member.size != expected[name]["bytes"]:
                raise ValueError("EXACT_REGULAR_SOURCE_ARCHIVE_POPULATION_REQUIRED")
            seen.add(name)
            row, path = expected[name], target / name
            if member.mode != row["mode"] or member.mode & ~0o777:
                raise ValueError("SEALED_SOURCE_MODE_CHANGED")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.extractfile(member) as source, path.open("xb") as destination:
                digest = hashlib.sha256()
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                    destination.write(block)
            if digest.hexdigest() != row["sha256"]:
                raise ValueError("SEALED_SOURCE_FILE_CHANGED")
            path.chmod(row["mode"])
    if seen != set(expected):
        raise ValueError("COMPLETE_SOURCE_ARCHIVE_REQUIRED")


def git(root, *args, data=None, env=None):
    result = subprocess.run([os.environ.get("FINNOR_W2_GIT_BIN", "git"), "-C", str(root), *args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, env=env)
    if result.returncode:
        raise RuntimeError("DECLARED_SOURCE_GIT_OPERATION_FAILED")
    return result.stdout
