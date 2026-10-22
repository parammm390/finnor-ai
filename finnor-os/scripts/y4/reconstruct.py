"""Fresh verified source/runtime materialization. No donor or registry installs."""
import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import tarfile
import zlib
from pathlib import Path


def sha(body):
    return hashlib.sha256(body).hexdigest()


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def allocated_bytes(size, block=4096):
    return (size + block - 1) // block * block


def source_capacity(archives, working_sources):
    total, objects = 0, {}
    for key, path in archives.items():
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                if key != "baseSourceArchive" or working_sources is None or member.name in working_sources:
                    total += allocated_bytes(member.size)
                if key == "baseSourceArchive" and member.isfile():
                    with archive.extractfile(member) as stream:
                        body = stream.read()
                    objects[git_hash("blob", body)] = len(zlib.compress(body)) + 10 + 32
    return {"worktreeBytes": total, "gitBytes": sum(objects.values()) + 24 * 1024 ** 2}


def git_hash(kind, body):
    return hashlib.sha1(kind.encode() + b" " + str(len(body)).encode() + b"\0" + body).hexdigest()


class GitObjects:
    """Write only freshly verified objects; never consult donor Git storage."""
    def __init__(self, repository, git_directory):
        self.repository, self.seen = repository, set()
        directory = git_directory / "objects/pack"
        self.path = directory / "reconstruction-pending.pack"
        self.stream = self.path.open("x+b")
        self.stream.write(b"PACK" + (2).to_bytes(4, "big") + bytes(4))

    def write(self, kind, body):
        fingerprint = git_hash(kind, body)
        if fingerprint in self.seen:
            return fingerprint
        size = len(body)
        header = bytearray([({"commit": 1, "tree": 2, "blob": 3}[kind] << 4) | (size & 15)])
        size >>= 4
        while size:
            header[-1] |= 128
            header.append(size & 127)
            size >>= 7
        self.stream.write(header)
        self.stream.write(zlib.compress(body))
        self.seen.add(fingerprint)
        return fingerprint

    def finish(self):
        self.stream.seek(8)
        self.stream.write(len(self.seen).to_bytes(4, "big"))
        self.stream.flush()
        self.stream.seek(0)
        digest = hashlib.file_digest(self.stream, "sha1")
        self.stream.seek(0, 2)
        self.stream.write(digest.digest())
        self.stream.close()
        final = self.path.with_name("pack-" + digest.hexdigest() + ".pack")
        self.path.rename(final)
        # Ancestors are intentionally absent, so do not assert full history
        # connectivity. Git still checks every packed object and its trailer.
        subprocess.run(["git", "-C", str(self.repository), "index-pack", str(final)], check=True,
                       stdout=subprocess.DEVNULL)

    def close(self):
        self.stream.close()


def unpack(archive, destination, expected=None, objects=None, working_sources=None):
    observed, tree = {}, {}
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            parts = Path(member.name).parts
            if not parts or member.name.startswith("/") or ".." in parts or ".git" in parts:
                raise ValueError("CONTAINED_REGULAR_ARCHIVE_MEMBER_REQUIRED")
            if member.isdir():
                continue
            if not member.isfile() or member.name in observed:
                raise ValueError("UNIQUE_REGULAR_ARCHIVE_MEMBER_REQUIRED")
            with tar.extractfile(member) as stream:
                body = stream.read()
            if expected is not None and (member.name not in expected or sha(body) != expected[member.name]):
                raise ValueError("ARCHIVE_MEMBER_IDENTITY_MISMATCH")
            observed[member.name] = sha(body)
            mode = "100755" if member.mode & stat.S_IXUSR else "100644"
            if objects is not None:
                objects.write("blob", body)
            node = tree
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = (mode, git_hash("blob", body))
            if working_sources is not None and member.name not in working_sources:
                continue
            path = destination.joinpath(*parts)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with path.open("wb" if path.exists() else "xb") as output:
                output.write(body)
            path.chmod(0o755 if mode == "100755" else 0o644)
    if expected is not None and observed != expected:
        raise ValueError("EXACT_ARCHIVE_INVENTORY_REQUIRED")
    return tree


def tree_hash(tree, repository=None):
    body = b""
    for name in sorted(tree, key=lambda key: (key + ("/" if isinstance(tree[key], dict) else "")).encode()):
        value = tree[name]
        mode, fingerprint = ("40000", tree_hash(value, repository)) if isinstance(value, dict) else value
        body += mode.encode() + b" " + name.encode() + b"\0" + bytes.fromhex(fingerprint)
    return repository.write("tree", body) if repository else git_hash("tree", body)


def runtime_unpack(archive, destination, records, scientific=False, fresh_content=None, working_files=None):
    seen, links = set(), []
    fresh_content = {} if fresh_content is None else fresh_content
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            name, parts = member.name, Path(member.name).parts
            if name not in records or name in seen or not parts or member.name.startswith("/") \
                    or ".." in parts or parts[0] not in (("python",) if scientific else ("backend", "frontend")):
                raise ValueError("EXACT_CONTAINED_RUNTIME_MEMBER_REQUIRED")
            seen.add(name)
            record = records[name]
            materialize = working_files is None or name in working_files
            path = destination.joinpath(*parts) if scientific else destination.joinpath(parts[0], "node_modules", *parts[1:])
            if materialize:
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if member.mode != record["mode"]:
                raise ValueError("EXACT_RUNTIME_FILE_MODE_REQUIRED")
            if record["kind"] == "link":
                if not member.issym() or member.linkname != record["target"] or Path(member.linkname).is_absolute():
                    raise ValueError("EXACT_INTERNAL_DEPENDENCY_LINK_REQUIRED")
                if materialize:
                    links.append((path, member.linkname))
            else:
                if not member.isfile() or member.size != record["bytes"]:
                    raise ValueError("EXACT_REGULAR_DEPENDENCY_FILE_REQUIRED")
                fingerprint = (record["sha256"], record["mode"])
                previous = fresh_content.get(fingerprint)
                digest, count = hashlib.sha256(), 0
                with tar.extractfile(member) as stream:
                    if previous is None and materialize:
                        with path.open("xb") as output:
                            while chunk := stream.read(1024 * 1024):
                                count += len(chunk)
                                digest.update(chunk)
                                output.write(chunk)
                    else:
                        while chunk := stream.read(1024 * 1024):
                            count += len(chunk)
                            digest.update(chunk)
                if count != record["bytes"] or digest.hexdigest() != record["sha256"]:
                    raise ValueError("DEPENDENCY_BYTE_IDENTITY_CHANGED")
                if not materialize:
                    continue
                if previous is None:
                    path.chmod(record["mode"])
                    fresh_content[fingerprint] = path
                else:
                    # Only a regular file created from this verified archive set
                    # in this invocation can become an internal deduplication link.
                    os.link(previous, path)
    if seen != set(records):
        raise ValueError("COMPLETE_RUNTIME_CLOSURE_REQUIRED")
    for path, literal in links:
        path.symlink_to(literal)
    for path, _ in links:
        group = destination if scientific else destination / path.relative_to(destination).parts[0] / "node_modules"
        if not path.resolve(strict=True).is_relative_to(group):
            raise ValueError("DEPENDENCY_LINK_ESCAPES_RECONSTRUCTED_GROUP")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--handoff", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--runtime-package", type=Path)
    parser.add_argument("--scientific-package", type=Path)
    parser.add_argument("--runtime-output", type=Path)
    parser.add_argument("--full-worktree", action="store_true")
    parser.add_argument("--full-dependencies", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if not args.handoff.is_absolute() or not args.output.is_absolute() or args.output.exists() \
            or args.handoff.resolve(strict=True) != args.handoff \
            or args.output.resolve(strict=False) != args.output:
        raise ValueError("REGULAR_HANDOFF_AND_NEW_ABSOLUTE_RECONSTRUCTION_REQUIRED")
    args.output.mkdir(mode=0o700)
    runtime_output = args.runtime_output or args.output
    report = {"schema": "finnor.y4.native-reconstruction.v1", "status": "FAIL",
              "scope": "COMPLETE_BASE_SOURCE_PLUS_Y4_AND_FRESH_NATIVE_CALCULATION",
              "fullProductCleanInstall": False, "protectedAdmission": False, "productionActive": False,
              "separatelyAdministered": False, "privateValuesPublished": False,
              "reconstructionRoots": [str(p) for p in dict.fromkeys((args.output, runtime_output))]}
    bootstrap = Path(__file__).read_bytes()
    (args.output / "reconstruction-driver.py").write_bytes(bootstrap)
    report["driverSha256"] = sha(bootstrap)
    try:
        if runtime_output != args.output and (not runtime_output.is_absolute() or runtime_output.exists()
                or runtime_output.resolve(strict=False) != runtime_output
                or runtime_output.is_relative_to(args.output) or args.output.is_relative_to(runtime_output)):
            raise ValueError("DISTINCT_NEW_ABSOLUTE_RUNTIME_STORAGE_REQUIRED")
        raw = (args.handoff / "handoff.json").read_bytes()
        if sha(raw) != (args.handoff / "handoff.sha256").read_text().strip():
            raise ValueError("HANDOFF_RECEIPT_CHANGED")
        receipt = json.loads(raw)
        archives = {}
        for key in ("baseSourceArchive", "sourceArchive", "nativeRuntimeArchive"):
            item = receipt[key]
            if Path(item["name"]).name != item["name"]:
                raise ValueError("REGULAR_LOCAL_PACKAGE_NAME_REQUIRED")
            path = args.handoff / item["name"]
            if path.is_symlink() or file_sha(path) != item["sha256"]:
                raise ValueError("ORIGINAL_PACKAGE_BYTES_CHANGED")
            archives[key] = path
        commit = (args.handoff / "base-commit.raw").read_bytes()
        if sha(commit) != receipt["baseCommitObject"]["sha256"] \
                or git_hash("commit", commit) != receipt["sourceBase"]:
            raise ValueError("ORIGINAL_BASE_COMMIT_OBJECT_CHANGED")
        # All required capacity is measured before exposing participant inputs.
        working_sources = None if args.full_worktree else set(receipt["reconstructionWorkingTreeSources"])
        expanded = source_capacity({k: v for k, v in archives.items() if k != "nativeRuntimeArchive"},
                                   working_sources)
        with tarfile.open(archives["nativeRuntimeArchive"], "r:gz") as archive:
            native_expanded = sum(allocated_bytes(m.size) for m in archive if m.isfile())
        runtime, scientific, runtime_files = None, None, None
        if args.runtime_package is not None:
            if not args.runtime_package.is_absolute() or args.runtime_package.resolve(strict=True) != args.runtime_package:
                raise ValueError("REGULAR_EXPLICIT_OFFLINE_RUNTIME_PACKAGE_REQUIRED")
            runtime = json.loads(Path(str(args.runtime_package) + ".json").read_bytes())
            pinned_runtime = receipt["offlineRuntimePackage"]
            if sha(Path(str(args.runtime_package) + ".json").read_bytes()) != pinned_runtime["inventorySha256"] \
                    or file_sha(args.runtime_package) != pinned_runtime["archiveSha256"] \
                    or runtime["archiveSha256"] != pinned_runtime["archiveSha256"]:
                raise ValueError("OFFLINE_RUNTIME_PACKAGE_CHANGED")
            if args.scientific_package is None or not args.scientific_package.is_absolute() \
                    or args.scientific_package.resolve(strict=True) != args.scientific_package:
                raise ValueError("EXPLICIT_OFFLINE_SCIENTIFIC_CLOSURE_REQUIRED")
            scientific_inventory = Path(str(args.scientific_package) + ".json")
            scientific = json.loads(scientific_inventory.read_bytes())
            pin = receipt["scientificRuntimePackage"]
            if file_sha(scientific_inventory) != pin["inventorySha256"] \
                    or file_sha(args.scientific_package) != pin["archiveSha256"] \
                    or scientific["archiveSha256"] != pin["archiveSha256"]:
                raise ValueError("SCIENTIFIC_RUNTIME_PACKAGE_CHANGED")
            if not args.full_dependencies:
                runtime_files = set(receipt["runtimeFrontendMaterialization"]) | set(receipt["runtimeBackendMaterialization"])
                if not runtime_files or not runtime_files.issubset(runtime["files"]):
                    raise ValueError("EXACT_MOUNTED_WORLD_DEPENDENCY_CLOSURE_REQUIRED")
        runtime_parent = runtime_output if runtime_output == args.output else runtime_output.parent
        volumes = {}
        def reserve(path, amount):
            device = path.stat().st_dev
            if device not in volumes:
                fs = os.statvfs(path)
                volumes[device] = {"path": str(path), "freeBytes": fs.f_bavail * fs.f_frsize, "requiredBytes": 0}
            volumes[device]["requiredBytes"] += amount
        reserve(args.output, expanded["worktreeBytes"])
        reserve(runtime_parent, expanded["gitBytes"] + native_expanded)
        if runtime is not None:
            unique = {(r["sha256"], r["mode"]): allocated_bytes(r["bytes"])
                      for inventory in (runtime, scientific) for name, r in inventory["files"].items()
                      if r["kind"] == "file" and (runtime_files is None or name.startswith("python/") or name in runtime_files)}
            reserve(runtime_parent, sum(unique.values()) + receipt["installedNonDependencyAllocatedBytes"]
                    + 192 * 1024 ** 2)
        else:
            reserve(args.output, 140 * 1024 ** 2)
        report["capacityBeforeInputDelivery"] = list(volumes.values())
        if any(v["freeBytes"] < v["requiredBytes"] for v in volumes.values()):
            raise ValueError("INDEPENDENT_SOURCE_AND_RUNTIME_CAPACITY_UNAVAILABLE")
        if runtime_output != args.output:
            runtime_output.mkdir(mode=0o700)
        source = args.output / "source"
        source.mkdir(mode=0o700)
        git_directory = runtime_output / "source-git" if runtime_output != args.output else source / ".git"
        command = ["git", "init", "-q"]
        if runtime_output != args.output:
            command += ["--separate-git-dir", str(git_directory)]
        subprocess.run([*command, str(source)], check=True)
        report["freshGitObjectStorage"] = str(git_directory)
        objects = GitObjects(source, git_directory)
        try:
            base_tree = tree_hash(unpack(archives["baseSourceArchive"], source, objects=objects,
                                        working_sources=working_sources), objects)
            if base_tree != receipt["baseSourceArchive"]["tree"] or not commit.startswith(("tree " + base_tree + "\n").encode()):
                raise ValueError("RECONSTRUCTED_BASE_GIT_TREE_CHANGED")
            objects.write("commit", commit)
            objects.finish()
        finally:
            objects.close()
        subprocess.run(["git", "-C", str(source), "update-ref", "HEAD", receipt["sourceBase"]], check=True)
        subprocess.run(["git", "-C", str(source), "read-tree", receipt["sourceBase"]], check=True)
        if working_sources is not None:
            # Base objects/index remain complete. Mark only deliberately absent
            # regular base files sparse, so Git never invents unrelated deletions.
            omitted = subprocess.check_output(["git", "-C", str(source), "ls-files", "-z"]).split(b"\0")
            omitted = [name for name in omitted if name and not (source / os.fsdecode(name)).exists()]
            subprocess.run(["git", "-C", str(source), "update-index", "--skip-worktree", "-z", "--stdin"],
                           input=b"\0".join(omitted)+b"\0", check=True)
        overlay = {item["path"]: item["sha256"] for item in receipt["sources"]}
        unpack(archives["sourceArchive"], source, overlay)
        native = runtime_output / "native-runtime"
        native.mkdir(mode=0o700)
        unpack(archives["nativeRuntimeArchive"], native, receipt["nativeRuntimeArchive"]["files"])
        for directory in ("Bytecode", "Functions", "Public-Input", "Schedules", "Source"):
            (native / "Programs" / directory).mkdir(mode=0o700, exist_ok=True)
        script = source / "finnor-os/scripts/y4"
        env = {"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1",
               "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        if runtime is not None:
            dependencies = runtime_output / "dependencies"
            dependencies.mkdir(mode=0o700)
            fresh_content = {}
            runtime_unpack(args.runtime_package, dependencies, runtime["files"], fresh_content=fresh_content,
                           working_files=runtime_files)
            scientific_root = runtime_output / "scientific"
            scientific_root.mkdir(mode=0o700)
            runtime_unpack(args.scientific_package, scientific_root, scientific["files"],
                           scientific=True, fresh_content=fresh_content)
            python = scientific_root / "python/bin/python3"
            private = args.output / "PRIVATE-NOT-FOR-HANDOFF"
            private.mkdir(mode=0o700)
            probe = subprocess.run([str(python), "-I", "-B", "-c",
                "import sys,json,importlib;from pathlib import Path;"
                "names=('numpy','scipy','statsmodels','arch','pandas','patsy','packaging','dateutil','pytz','tzdata','six');"
                "root=Path(sys.executable).resolve().parent.parent;"
                "assert Path(sys.prefix).resolve()==root;"
                "mods=[importlib.import_module(n) for n in names];"
                "assert all(Path(m.__file__).resolve().is_relative_to(root) for m in mods);"
                "assert all(Path(m.__file__).resolve().is_relative_to(root) for m in list(sys.modules.values())"
                " if getattr(m,'__file__',None) and not m.__file__.startswith('<'));"
                "print(json.dumps({'status':'PASS','isolated':bool(sys.flags.isolated),"
                "'versions':{m.__name__:m.__version__ for m in mods}}))"],
                env=env, capture_output=True, timeout=45)
            if probe.returncode:
                (private / "scientific-probe.private.log").write_bytes(probe.stderr)
                raise ValueError("ISOLATED_PACKAGED_SCIENTIFIC_IMPORTS_FAILED")
            report["scientificRuntimeProbe"] = json.loads(probe.stdout)
            frontend = dependencies / "frontend/node_modules"
            backend_dependencies = dependencies / "backend/node_modules"
            (source / "node_modules").symlink_to(frontend, target_is_directory=True)
            (source / "finnor-os/node_modules").symlink_to(backend_dependencies, target_is_directory=True)
            installation = runtime_output / "installation"
            with (private / "installation-build.log").open("xb") as log:
                built = subprocess.run(["node", str(script / "build-installed.mjs"), "--output", str(installation),
                                        "--dependencies", str(backend_dependencies), "--link-dependencies"], cwd=source,
                                       stdout=log, stderr=subprocess.STDOUT, timeout=300, env=env)
            if built.returncode:
                raise ValueError("RECONSTRUCTED_INSTALLED_BUILD_FAILED")
            # The original emitted hashes travel in the handoff receipt. No
            # original installation or dependency directory is read here.
            for name, expected in receipt["installedEntrypointDigests"].items():
                if file_sha(installation / name) != expected:
                    raise ValueError("RECONSTRUCTED_EMITTED_RUNTIME_CHANGED")
            report["installationManifestSha256"] = file_sha(installation / "installation.json")
            report["installedEntrypointDigests"] = {
                name: file_sha(installation / name) for name in receipt["installedEntrypointDigests"]}
            env.update(TMPDIR="/dev/shm", FINNOR_Y4_INSTALLATION=str(installation),
                       FINNOR_Y4_BACKEND=str(native),
                       FINNOR_S3_PYTHON=str(python), FINNOR_S5_PYTHON=str(python), FINNOR_Y4_PYTHON=str(python),
                       FINNOR_Y4_POSTGRES_PACKAGE=str(backend_dependencies / "@embedded-postgres/linux-x64"),
                       FINNOR_Y4_BROWSER="1")
            if os.environ.get("AGENT_BROWSER_SESSION"):
                env["AGENT_BROWSER_SESSION"] = os.environ["AGENT_BROWSER_SESSION"]
            command = ["node", str(backend_dependencies / "tsx/dist/cli.mjs"), str(script / "product-e2e.ts"),
                       "--case", "lifecycle", "--evidence", str(args.output / "product-episode")]
        else:
            command = [sys.executable, "-I", "-B", "-c",
                   "import sys,json;from pathlib import Path;"
                   "sys.path.insert(0,sys.argv[1]);"
                   "from engineering import function,binary,inp,installed;"
                   "f=function([('joint',binary('add',binary('add',inp('a'),inp('b')),inp('c')),'count',['p0'])],suffix='independent-reconstruction');"
                   "e=Path(sys.argv[3]);e.mkdir(mode=0o700);"
                   "r=installed(f,{'a':'5','b':'-7','c':'3'},Path(sys.argv[2]),e);"
                   "(e/'result.json').write_text(json.dumps(r,sort_keys=True)+'\\n');"
                   "assert r['status']=='PASS'",
                       str(script), str(native), str(args.output / "native-episode")]
            private = args.output / "PRIVATE-NOT-FOR-HANDOFF"
            private.mkdir(mode=0o700)
        with (private / "reconstruction-process.log").open("xb") as log:
            child = subprocess.run(command, cwd=source / "finnor-os", stdout=log, stderr=subprocess.STDOUT, timeout=3500, env=env)
        if child.returncode:
            raise ValueError("RECONSTRUCTED_NATIVE_EPISODE_FAILED")
        if runtime is not None:
            native_result = json.loads((args.output / "product-episode/result.json").read_text())
            report["productResultSha256"] = file_sha(args.output / "product-episode/result.json")
            if native_result["status"] != "PASS" or not all(r["status"] == "PASS" for r in native_result["results"]) \
                    or not {"installed-native-mpc", "recipient-release-and-native-consumer", "canonical-work-completion",
                            "mounted-recipient-scope-and-reload", "mounted-revocation-fence",
                            "actual-upstream-owner-context", "actual-recipient-s4-s5-s6-continuation",
                            "actual-typed-s8-construction-review", "native-owner-and-s8-revocation-fences"}.issubset(r["id"] for r in native_result["results"]):
                raise ValueError("RECONSTRUCTED_FULL_PRODUCT_PREDICATE_UNPASSED")
            rebuilds = next(r["observed"]["independentNativeRebuilds"] for r in native_result["results"]
                            if r["id"] == "installed-native-mpc")
            if file_sha(args.runtime_package) != runtime["archiveSha256"] \
                    or file_sha(args.scientific_package) != scientific["archiveSha256"]:
                raise ValueError("RECONSTRUCTION_CHANGED_OFFLINE_DEPENDENCIES")
        else:
            native_result = json.loads((args.output / "native-episode/result.json").read_text())
            rebuilds = native_result["independentNativeReconstructions"]
        for key, path in archives.items():
            if file_sha(path) != receipt[key]["sha256"]:
                raise ValueError("RECONSTRUCTION_CHANGED_ORIGINAL_PACKAGE")
        report["reconstructedSourceFiles"] = {name: file_sha(source / name) for name in overlay}
        if report["reconstructedSourceFiles"] != overlay:
            raise ValueError("EXECUTED_RECONSTRUCTED_SOURCE_CHANGED")
        report.update(status="PASS", baseTree=base_tree, exactOriginalCommitObjectVerified=True,
                      scope="FULL_OFFLINE_PRODUCT_SOURCE_RUNTIME_AND_BROWSER_RECONSTRUCTION" if runtime else report["scope"],
                      overlayFiles=len(overlay), nativeFiles=len(receipt["nativeRuntimeArchive"]["files"]),
                      completeOriginalBaseGitObjectsRetained=True,
                      workingTreeMaterialization="COMPLETE_BASE" if args.full_worktree else "EXACT_INSTALLED_SOURCE_CLOSURE_PLUS_COMPLETE_Y4_OVERLAY",
                      independentNativeReconstructions=rebuilds,
                      freshNativeOracleMatches=True, donorWorktreeOrDependencyReads=False,
                      originalPackageBytesUnchanged=True, nativeBinaryRebuiltFromUpstream=False,
                      hostDependencies=["Node executable", "Git executable", "agent-browser CLI and browser binary", "OpenSSL",
                                        "compatible ELF loader/glibc/system libraries", "Linux x86-64 kernel", "loopback"],
                      fullProductCleanInstall=runtime is not None,
                      installationMethod="VERIFIED_OFFLINE_BYTE_MATERIALIZATION" if runtime else "NATIVE_ONLY",
                      frontendDependencyClosureReconstructed=runtime is not None,
                      scientificDependencyClosureReconstructed=scientific is not None,
                      allArchivedDependencyMembersVerified=True,
                      frontendMaterializationProfile="COMPLETE_ARCHIVED_PACKAGES" if args.full_dependencies
                        else "ACTUAL_MOUNTED_WORLD_INPUTS_PACKAGE_METADATA_AND_NOTICES",
                      backendMaterializationProfile="COMPLETE_ARCHIVED_PACKAGES" if args.full_dependencies
                        else "COMPLETE_RUNTIME_AND_TYPES_WITH_OPTIONAL_DEBUG_MAPS_RETAINED_IN_ARCHIVE",
                      dependencyDeduplication="FRESH_VERIFIED_ARCHIVE_BYTES_WITHIN_RECONSTRUCTION_ONLY",
                      upstreamNodeOrNativeBuildReproduced=False,
                      missing=["separately administered participants", "protected or economic qualification"])
    except Exception as error:
        report["failurePredicate"] = str(error) if isinstance(error, ValueError) else type(error).__name__
    (args.output / "result.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
