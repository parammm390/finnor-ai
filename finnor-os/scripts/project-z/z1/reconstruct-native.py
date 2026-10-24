"""Whole-owner cold installation/replay. Run under the shared heavy flock.

No .git, borrowed node_modules, DB, Auth, listener, provision, migration or grant.
Source construction requires a committed native cut. Shared postimages remain
coordinator requests and are applied only to this newly created validation copy.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
OWN = (
    "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work",
    "finnor-os/packages/orchestration/src/project-z/z1-shared-work",
    "finnor-os/scripts/project-z/z1",
)
ARCHIVE = (
    "finnor-os", "src", "scripts", "public", "vendor", "e2e", "docs", "infra",
    "AGENTS.md", "README.md", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json",
    "next.config.mjs", "next-env.d.ts", "tsconfig.json", "postcss.config.mjs", "tailwind.config.ts",
    "eslint.config.mjs", ".eslintrc.cjs", "instrumentation.ts", "instrumentation-client.ts",
    "sentry.client.config.ts", "sentry.server.config.ts", "sentry.edge.config.ts",
    "scope-z/prompts/qualification-families.json",
)


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()


def document(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def load_request(path):
    request = json.loads((path / "request.json").read_text())
    if request["schema"] != "finnor.z1.integration-request.v1":
        raise ValueError("EXACT_INTEGRATION_REQUEST_REQUIRED")
    if sha(path / "shared-integration.patch") != request["sharedPatchSha256"]:
        raise ValueError("INTEGRATION_PATCH_BYTES_CHANGED")
    return request


def apply_request(path, target):
    request = load_request(path)
    # Check the entire cut before any postimage write.
    for file in request["files"]:
        name = Path(file["path"])
        if name.is_absolute() or ".." in name.parts or name.parts[0] in (".git", "node_modules"):
            raise ValueError("INVALID_REQUESTED_RELATIVE_PATH")
        current = target / name
        if file["preimageSha256"] is None:
            if current.exists():
                raise ValueError("NEW_SHARED_PATH_ALREADY_EXISTS:" + str(name))
        elif not current.is_file() or sha(current) != file["preimageSha256"]:
            raise ValueError("SHARED_PREIMAGE_CHANGED:" + str(name))
        if sha(path / file["postimage"]) != file["postimageSha256"]:
            raise ValueError("SHARED_POSTIMAGE_CHANGED:" + str(name))
    for file in request["files"]:
        destination = target / file["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path / file["postimage"], destination)
    return request


def request_module(root):
    path = root / "finnor-os/scripts/project-z/z1/integration-request.py"
    spec = importlib.util.spec_from_file_location("z1_exact_request", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--archive-installed", action="store_true")
    args = parser.parse_args()
    evidence = args.output
    if not evidence.is_absolute() or evidence.exists():
        raise ValueError("ABSOLUTE_NEW_RECONSTRUCTION_REPORT_REQUIRED")
    evidence.mkdir(mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix="finnor-z1-native-install-"))
    target = temporary / "source"
    target.mkdir()
    report = {"schema": "finnor.z1.whole-owner-reconstruction.v1", "status": "IN_PROGRESS",
              "scope": "Independent locked source/build reconstruction, not authenticated native execution.",
              "temporaryTarget": str(target), "steps": [], "databaseActions": 0, "listenersStarted": 0,
              "borrowedNodeModules": False, "sourceOwnerFlow": "NOT_RUN", "installedOwnerFlow": "NOT_RUN",
              "protectedAdmission": False, "productionActivated": False,
              "failures": [], "environmentNames": []}
    delivered = None
    code = 1
    try:
        if shutil.disk_usage(evidence).free < 8 * 1024**3:
            raise ValueError("EIGHT_GIB_FREE_INSTALL_BUILD_BUDGET_REQUIRED")
        if args.replay:
            if not args.replay.is_absolute():
                raise ValueError("ABSOLUTE_RECONSTRUCTIBLE_PACKAGE_MANIFEST_REQUIRED")
            package = json.loads(args.replay.read_text())
            if package["schema"] != "finnor.z1.reconstructible-package.v1":
                raise ValueError("EXACT_NATIVE_PACKAGE_REQUIRED")
            delivered = package
            archive = args.replay.parent / package["sourceArchive"]["path"]
            requests = args.replay.parent / package["integrationRequest"]["path"]
            if sha(archive) != package["sourceArchive"]["sha256"] or sha(requests / "request.json") != package["integrationRequest"]["sha256"]:
                raise ValueError("REPLAY_PACKAGE_BYTES_CHANGED")
            head, tree = package["sourceCommit"], package["sourceTree"]
            shutil.copyfile(archive, evidence / "source.tar.gz")
            shutil.copytree(requests, evidence / "integration-request")
        else:
            source = args.source
            if not source.is_absolute():
                raise ValueError("ABSOLUTE_COMMITTED_SOURCE_REQUIRED")
            dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--", *OWN], text=True)
            if dirty:
                raise ValueError("COMMIT_THE_FINAL_OWN_NATIVE_SOURCE_BEFORE_RECONSTRUCTION")
            head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
            tree = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD^{tree}"], text=True).strip()
            # Only declared, tracked source/build inputs. Never copy .env, local
            # credentials, user media, the worktree, its Git database or modules.
            tracked = set(subprocess.check_output(["git", "-C", str(source), "ls-tree", "--name-only", head], text=True).splitlines())
            paths = [name for name in ARCHIVE if name.split("/")[0] in tracked]
            with (evidence / "source.tar.gz").open("xb") as raw:
                with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
                    result = subprocess.Popen(["git", "-C", str(source), "archive", "--format=tar", head, *paths], stdout=subprocess.PIPE)
                    report["omittedArchivePaths"] = []
                    with tarfile.open(fileobj=result.stdout, mode="r|") as original:
                        with tarfile.open(fileobj=zipped, mode="w|") as declared:
                            for member in original:
                                if any(part == ".git" or part == "node_modules" or part.startswith(".env")
                                       for part in Path(member.name).parts):
                                    report["omittedArchivePaths"].append(member.name)
                                    continue
                                declared.addfile(member, original.extractfile(member) if member.isfile() else None)
                    if result.wait() != 0:
                        raise ValueError("DECLARED_SOURCE_ARCHIVE_FAILED")
            request_module(source).emit(source, evidence / "integration-request")
        archive, requests = evidence / "source.tar.gz", evidence / "integration-request"
        report.update(sourceCommit=head, sourceTree=tree, sourceArchiveSha256=sha(archive))
        with tarfile.open(archive) as packed:
            if any(Path(member.name).is_absolute() or ".." in Path(member.name).parts or
                   any(part == ".git" or part == "node_modules" or part.startswith(".env") for part in Path(member.name).parts)
                   for member in packed.getmembers()):
                raise ValueError("ARCHIVE_HAS_UNDECLARED_GIT_ENV_OR_DEPENDENCIES")
            packed.extractall(target, filter="data")
        request = apply_request(requests, target)
        if (target / ".git").exists() or (target / "node_modules").exists() or (target / "finnor-os/node_modules").exists():
            raise ValueError("COLD_TARGET_MUST_NOT_BORROW_GIT_OR_MODULES")
        home, cache = temporary / "home", temporary / "npm-cache"
        home.mkdir()
        for name in ("user.npmrc", "global.npmrc"):
            (temporary / name).touch()
        env = {
            "PATH": os.environ["PATH"], "HOME": str(home), "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1", "TSX_DISABLE_CACHE": "1", "NEXT_TELEMETRY_DISABLED": "1",
            "npm_config_cache": str(cache), "npm_config_userconfig": str(temporary / "user.npmrc"),
            "npm_config_globalconfig": str(temporary / "global.npmrc"),
            "FINNOR_ENVIRONMENT": "ordinary_disposable", "FINNOR_Z1_PROFILE": "ordinary_disposable",
            "FINNOR_Z1_INSTALLED_DEVELOPMENT": "1", "P3_GOVERNORS": "1",
        }
        report["environmentNames"] = sorted(env)
        node, npm = shutil.which("node"), shutil.which("npm")
        if not node or not npm:
            raise ValueError("DECLARED_NODE_AND_NPM_REQUIRED")
        node_version = subprocess.check_output([node, "--version"], env=env, text=True).strip()
        if not node_version.startswith("v22."):
            raise ValueError("NODE22_REQUIRED")
        report["toolchain"] = {
            "node": node_version, "nodePath": str(Path(node).resolve()), "nodeSha256": sha(Path(node).resolve()),
            "npm": subprocess.check_output([npm, "--version"], env=env, text=True).strip(),
            "npmPath": str(Path(npm).resolve()), "npmEntrySha256": sha(Path(npm).resolve()),
            "python": sys.version.split()[0], "pythonSha256": sha(Path(sys.executable).resolve()),
            "platform": sys.platform, "machine": platform.machine(), "libc": list(platform.libc_ver()),
        }
        report["toolchain"]["nativeBuildTools"] = []
        for name in ("cc", "c++", "make", "ld"):
            binary = shutil.which(name)
            if not binary:
                raise ValueError("DECLARED_NATIVE_BUILD_TOOL_REQUIRED:" + name)
            version = subprocess.check_output([binary, "--version"], env=env, text=True, timeout=10).splitlines()[0]
            report["toolchain"]["nativeBuildTools"].append({
                "command": name, "version": version, "path": str(Path(binary).resolve()),
                "sha256": sha(Path(binary).resolve())})
        report["dependencyLocks"] = [{"path": name, "sha256": sha(target / name)}
                                     for name in ("package-lock.json", "finnor-os/package-lock.json")]
        base = target / "finnor-os/packages/private-equity/src/project-z/z1-shared-work"
        reconstruction = {"schema": "finnor.z1.reconstruction-input.v1", "sourceCommit": head, "sourceTree": tree,
                          "sourceArchiveSha256": sha(archive), "integrationPatchSha256": request["sharedPatchSha256"]}
        document(base / "reconstruction-input.json", reconstruction)

        def run(name, command, cwd=target, timeout=600, heap=1536, extra=None, required=True):
            start, log = time.monotonic(), evidence / (name + ".log")
            actual = {**env, "NODE_OPTIONS": f"--max-old-space-size={heap}", **(extra or {})}
            with log.open("xb") as output:
                try:
                    result = subprocess.run(command, cwd=cwd, env=actual, stdout=output,
                                            stderr=subprocess.STDOUT, timeout=timeout, check=False)
                    exit_code, timed_out = result.returncode, False
                except subprocess.TimeoutExpired:
                    exit_code, timed_out = None, True
            step = {"name": name, "command": command, "cwd": str(cwd.relative_to(target)) or ".",
                    "exitCode": exit_code, "timedOut": timed_out, "nodeHeapMiB": heap,
                    "wallMs": round((time.monotonic() - start) * 1000), "log": log.name, "logSha256": sha(log)}
            report["steps"].append(step)
            if exit_code != 0:
                report["failures"].append(step)
                if required:
                    raise ValueError("RECONSTRUCTION_STEP_FAILED:" + name)
            return exit_code == 0

        run("root-fresh-npm-ci", [npm, "ci", "--no-audit", "--no-fund"], timeout=900)
        run("backend-fresh-npm-ci", [npm, "ci", "--no-audit", "--no-fund"], cwd=target / "finnor-os", timeout=900)
        if any(sha(target / lock["path"]) != lock["sha256"] for lock in report["dependencyLocks"]):
            raise ValueError("COLD_INSTALL_CHANGED_DECLARED_DEPENDENCY_LOCK")
        report["installedPackages"] = []
        for prefix in ("", "finnor-os/"):
            for package_name in ("next", "react", "typescript", "zod"):
                actual = (target / prefix / "node_modules" / package_name).resolve()
                if not actual.is_relative_to(target):
                    raise ValueError("BORROWED_INSTALLED_PACKAGE:" + prefix + package_name)
                metadata = actual / "package.json"
                report["installedPackages"].append({"path": prefix + "node_modules/" + package_name,
                    "version": json.loads(metadata.read_text())["version"], "packageJsonSha256": sha(metadata)})
        loader = str(target / "finnor-os/node_modules/tsx/dist/loader.mjs")
        scripts = target / "finnor-os/scripts/project-z/z1"
        backend = target / "finnor-os"
        if not args.replay:
            for phase in ("x3", "x5", "x4", "y2"):
                run("prerequisite-stamp-" + phase, [node, "--import", loader, str(backend / f"scripts/{phase}/stamp-source.mts")], cwd=backend)
            for name, command, heap in (
                ("generate-openapi", [npm, "--prefix", str(backend), "run", "openapi"], 1536),
                ("generate-manifest", [npm, "run", "centropy:manifest"], 1536),
                ("generate-client", [npm, "run", "centropy:client"], 1536),
                ("generate-forms", [npm, "run", "centropy:forms"], 1536),
                ("generate-coverage", [npm, "run", "centropy:coverage"], 4096),
            ):
                run(name, command, heap=heap)
            # Retain the initial request, including every original preimage.
            requests.rename(evidence / "integration-request-initial")
            request = request_module(args.source).emit(args.source, requests, generated_root=target)
            reconstruction["integrationPatchSha256"] = request["sharedPatchSha256"]
            document(base / "reconstruction-input.json", reconstruction)
        run("stamp-whole-owner", [node, "--import", loader, str(scripts / "stamp-installed.mjs")], cwd=backend)
        for name, command, cwd, heap in (
            ("full-backend-typecheck", [npm, "run", "typecheck"], backend, 4096),
            ("full-frontend-typecheck", [node, str(target / "node_modules/typescript/bin/tsc"), "-p", str(target / "tsconfig.json"), "--noEmit"], target, 4096),
            ("workspace-check", [npm, "run", "workspace:check"], target, 1536),
            ("manifest-check", [npm, "run", "centropy:manifest:check"], target, 1536),
            ("client-check", [npm, "run", "centropy:client:check"], target, 1536),
            ("forms-check", [npm, "run", "centropy:forms:check"], target, 1536),
            ("coverage-check", [npm, "run", "centropy:coverage:check"], target, 4096),
        ):
            run(name, command, cwd=cwd, heap=heap)
        run("frontend-lint", [npm, "run", "lint"], required=False)
        # Framework-generated next-env inputs join the final patch after build.
        # Archive identity is already frozen and is identical during replay.
        build_id = "z1-" + head + "-" + report["sourceArchiveSha256"][:16]
        run("api-build", [node, str(backend / "node_modules/next/dist/bin/next"), "build"],
            cwd=backend / "apps/api", timeout=1500, heap=4096,
            extra={"FINNOR_BUILD_ID": build_id + "-api", "FINNOR_Z1_PACKAGE_BUILD": "1"})
        run("frontend-build", [node, str(target / "node_modules/next/dist/bin/next"), "build", "--webpack"],
            timeout=1500, heap=4096, extra={"FINNOR_BUILD_ID": build_id + "-front", "FINNOR_Z1_FRONTEND_INSTALL": "1"})
        # Framework type-input generation can change next-env.d.ts. Freeze and
        # request those exact generated postimages too, then verify the runtime
        # stamp against the final tree. The native stamp is read from disk, not
        # bundled as a caller-provided source label.
        if not args.replay:
            final_requests = evidence / "integration-request-final"
            final_request = request_module(args.source).emit(args.source, final_requests, generated_root=target)
            report["postbuildIntegrationRequest"] = {"path": final_requests.name, "sha256": sha(final_requests / "request.json")}
            request, requests = final_request, final_requests
            reconstruction["integrationPatchSha256"] = request["sharedPatchSha256"]
            document(base / "reconstruction-input.json", reconstruction)
        run("verify-final-whole-owner", [node, "--import", loader, str(scripts / "stamp-installed.mjs")], cwd=backend)
        source_files = json.loads((base / "installed-source-files.json").read_text())["files"]
        trace = backend / "apps/api/.next/server/app/api/company-brain/[operation]/route.js.nft.json"
        if not trace.is_file():
            raise ValueError("ACTUAL_NATIVE_INTAKE_API_TRACE_REQUIRED")
        traced = {(trace.parent / name).resolve() for name in json.loads(trace.read_text())["files"]}
        missing = [file["path"] for file in source_files if (target / file["path"]).resolve() not in traced]
        stamps = [base / name for name in ("installed-source.json", "installed-source-files.json")]
        missing.extend(str(path.relative_to(target)) for path in stamps if path.resolve() not in traced)
        trace_report = {"schema": "finnor.z1.whole-owner-trace-review.v1", "status": "FAILED" if missing else "PASSED",
                        "tracePath": str(trace.relative_to(target)), "traceSha256": sha(trace),
                        "declaredSourceFiles": len(source_files), "missingFiles": missing, "databaseActions": 0}
        document(evidence / "trace-review.json", trace_report)
        report["sourceTrace"] = {"path": "trace-review.json", "sha256": sha(evidence / "trace-review.json"),
                                 "status": trace_report["status"]}
        if missing:
            raise ValueError("DECLARED_WHOLE_OWNER_SOURCE_MISSING_FROM_API_TRACE")
        for name, script in (("original-semantics", "verify.mjs"), ("process-edges", "edge-cases.mjs"),
                             ("file-fixture-physical-recovery", "physical-recovery.mjs"),
                             ("independent-original-episode", "original-episode.mjs")):
            run(name, [node, "--import", loader, str(scripts / script), str(evidence / name)], cwd=backend, timeout=600)
        run("native-guard", [node, str(scripts / "native-e2e.mjs"), "--report", str(evidence / "native-guard-not-run")], required=False)
        guard = json.loads((evidence / "native-guard-not-run/report.json").read_text())
        if guard["status"] != "NOT_RUN" or guard["actions"] or report["steps"][-1]["exitCode"] != 2:
            raise ValueError("COLD_RECONSTRUCTION_MUST_NOT_CREATE_NATIVE_AUTHORITY")
        report["guardedNativePrerequisiteCheck"] = "PASSED_GUARD_NATIVE_EXECUTION_NOT_RUN"
        report["builds"] = [{"path": name, "id": (target / name).read_text().strip()}
                            for name in (".next-z1-install/BUILD_ID", "finnor-os/apps/api/.next/BUILD_ID")]
        report["installedSource"] = json.loads((base / "installed-source.json").read_text())
        if delivered:
            fields = ("sourceCommit", "sourceTree", "integrationPatchSha256", "sourceFilesManifestSha256",
                      "sourceArchiveSha256", "nativeRuntimeDigest", "node", "reconstructionReference")
            differences = [field for field in fields if report["installedSource"][field] != delivered["installedSource"][field]]
            if report["builds"] != delivered["builds"]:
                differences.append("builds")
            if report["dependencyLocks"] != delivered["dependencyLocks"]:
                differences.append("dependencyLocks")
            for field in ("node", "nodeSha256", "npm", "npmEntrySha256", "python", "pythonSha256", "platform", "machine", "libc"):
                if report["toolchain"][field] != delivered["toolchain"][field]:
                    differences.append("toolchain." + field)
            tools = lambda items: [{key: item[key] for key in ("command", "version", "sha256")} for item in items]
            if tools(report["toolchain"]["nativeBuildTools"]) != tools(delivered["toolchain"]["nativeBuildTools"]):
                differences.append("toolchain.nativeBuildTools")
            report["deliveredCutComparison"] = {"status": "FAILED" if differences else "PASSED", "differences": differences,
                "scope": "Exact source, requested patch, runtime, build IDs and declared toolchain; not bit-for-bit emitted artifact identity."}
            if differences:
                raise ValueError("SEPARATE_REBUILD_CHANGED_DELIVERED_SOURCE_BUILD_OR_TOOLCHAIN")
        shutil.copyfile(base / "installed-source.json", evidence / "installed-source.json")
        shutil.copyfile(base / "installed-source-files.json", evidence / "installed-source-files.json")
        assets = []
        for directory in ("node_modules", "finnor-os/node_modules", ".next-z1-install", "finnor-os/apps/api/.next"):
            for path in sorted((target / directory).rglob("*")):
                if path.is_symlink():
                    if not path.resolve().is_relative_to(target):
                        raise ValueError("INSTALLED_RUNTIME_SYMLINK_ESCAPES_TARGET")
                elif path.is_file() and "cache" not in path.relative_to(target / directory).parts:
                    assets.append({"path": str(path.relative_to(target)), "bytes": path.stat().st_size, "sha256": sha(path)})
        document(evidence / "installed-assets.json", {"schema": "finnor.z1.installed-native-assets.v1", "files": assets})
        report["installedAssets"] = {"path": "installed-assets.json", "files": len(assets), "sha256": sha(evidence / "installed-assets.json")}
        package = {"schema": "finnor.z1.reconstructible-package.v1", "sourceCommit": head, "sourceTree": tree,
                   "sourceArchive": {"path": archive.name, "sha256": sha(archive)},
                   "integrationRequest": {"path": requests.name, "sha256": sha(requests / "request.json")},
                   "installedSource": report["installedSource"], "toolchain": report["toolchain"],
                   "dependencyLocks": report["dependencyLocks"], "builds": report["builds"],
                   "migrationState": request["schemaProposal"]["state"],
                   "nativeOwnerExecution": "NOT_RUN", "protectedAdmission": False}
        if args.archive_installed:
            installed_archive = evidence / "installed-owner.tar.gz"
            with tarfile.open(installed_archive, "w:gz") as packed:
                packed.add(target, arcname="source", filter=lambda info: None if "/cache/" in info.name or
                           any(part.startswith(".env") or part == ".git" for part in Path(info.name).parts) else info)
            package["installedArchive"] = {"path": installed_archive.name, "sha256": sha(installed_archive)}
        document(evidence / "package.json", package)
        report["status"] = "PASSED_ENGINEERING_WITH_NATIVE_AND_COORDINATOR_GATES_NOT_RUN"
        report["sqlApplied"] = False
        report["remainingBlockers"] = ["COORDINATOR_SHARED_PATCH_ACCEPTANCE_AND_MIGRATION_FILENAME",
                                      "EXPLICIT_DISPOSABLE_NATIVE_DATABASE_AUTH_OWNER_AND_STACK"]
        # The guard's expected exit 2 is not a product failure.
        unexpected = [step for step in report["failures"] if step["name"] != "native-guard"]
        if unexpected:
            report["status"] = "FAILED"
        else:
            code = 0
    except Exception as error:
        report["status"] = "FAILED"
        report["failure"] = {"type": type(error).__name__, "code": str(error)}
    finally:
        shutil.rmtree(temporary)
        report["temporaryTargetRemoved"] = not temporary.exists()
        document(evidence / "report.json", report)
    print(json.dumps({"status": report["status"], "evidence": str(evidence), "steps": len(report["steps"]),
                      "failure": report.get("failure"), "databaseActions": 0, "temporaryTargetRemoved": report["temporaryTargetRemoved"]}))
    return code


if __name__ == "__main__":
    sys.exit(main())
