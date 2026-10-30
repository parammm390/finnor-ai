"""Separate locked whole-owner build. Never starts services or a database."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import zipfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def descendant_rss(root_pid):
    """Sample this command's process tree, including detached descendants."""
    processes = {}
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(")", 1)[1].split()
            processes[int(path.parent.name)] = (int(fields[1]), int(fields[2]), int(fields[21]))
        except (OSError, ValueError, IndexError):
            continue
    owned = {root_pid}
    while True:
        expanded = owned | {pid for pid, (parent, group, _) in processes.items()
                            if parent in owned or group == root_pid}
        if expanded == owned:
            break
        owned = expanded
    return sum(processes[pid][2] for pid in owned if pid in processes)*os.sysconf("SC_PAGE_SIZE")


def install_browsers(node, package_path, pack, backend, out, logs, run):
    """Use the locked public CLI's selection, with one transfer per asset."""
    receipt = {"schema": "finnor.project-z.z2.browser-acquisition.v1", "status": "FAILED",
               "selection": "LOCKED_PUBLIC_PLAYWRIGHT_CLI_DRY_RUN",
               "downloadRetries": 0, "fallbacksUsed": False, "assets": [],
               "dependencyValidationMarkerWritten": False}
    try:
        if not run("browser-locked-dry-run",
                   [node, package_path.parent/"cli.js", "install", "chromium", "--only-shell", "--dry-run"],
                   cwd=backend, timeout=60):
            return False
        selection = []
        browser_root = pack/".z2-installed/browsers"
        for block in (logs/"browser-locked-dry-run.log").read_text().strip().split("\n\n"):
            location = re.search(r"^\s*Install location:\s+(.+)$", block, re.MULTILINE)
            url = re.search(r"^\s*Download url:\s+(\S+)$", block, re.MULTILINE)
            assert location and url, "Z2_BROWSER_PUBLIC_SELECTION_SHAPE"
            path = Path(location[1])
            assert path.is_absolute() and path.resolve() == path and not path.exists()
            local = path.relative_to(browser_root)
            assert len(local.parts) == 1 and re.fullmatch(r"(chromium_headless_shell|ffmpeg)-[0-9]+", local.name)
            parsed = urlsplit(url[1])
            assert parsed.scheme == "https" and parsed.hostname in {
                "cdn.playwright.dev", "playwright.download.prss.microsoft.com"}
            assert not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
            assert parsed.port in (None, 443)
            selection.append((path, url[1]))
        assert len(selection) == 2 and len({str(p) for p, _ in selection}) == 2
        assert sum(p.name.startswith("chromium_headless_shell-") for p, _ in selection) == 1
        downloads = out/"browser-downloads"
        downloads.mkdir(mode=0o700)
        browser_root.mkdir(mode=0o700, parents=True, exist_ok=False)
        curl = Path("/usr/bin/curl").resolve()
        receipt["downloadTool"] = {"path": str(curl), "sha256": sha(curl)}
        for index, (destination, url) in enumerate(selection, 1):
            archive = downloads/(str(index)+".zip")
            asset = {"url": url, "destination": str(destination), "status": "FAILED",
                     "archive": str(archive), "attempts": 1}
            receipt["assets"].append(asset)
            if not run("browser-asset-"+str(index)+"-download",
                       [curl, "--fail", "--location", "--max-redirs", "3", "--retry", "0",
                        "--connect-timeout", "20", "--max-time", "550",
                        "--proto", "=https", "--proto-redir", "=https",
                        "--silent", "--show-error", "--write-out", "\nZ2_HTTP_STATUS=%{http_code}\n",
                        "--output", archive, url], cwd=backend, timeout=600):
                return False
            asset.update(archiveSha256=sha(archive), archiveBytes=archive.stat().st_size)
            assert archive.stat().st_size <= 512*1024*1024, "Z2_BROWSER_ARCHIVE_BYTE_BOUND"
            with zipfile.ZipFile(archive) as zipped:
                members, total = {}, 0
                for entry in zipped.infolist():
                    name = entry.filename.rstrip("/")
                    path = PurePosixPath(name)
                    assert entry.orig_filename == entry.filename and "\\" not in name and "\0" not in name
                    assert name and not path.is_absolute() and str(path) == name
                    assert not any(p in ("", ".", "..") for p in name.split("/"))
                    assert name not in members and not entry.flag_bits & 1
                    mode = entry.external_attr >> 16
                    assert stat.S_IFMT(mode) in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)
                    permissions = stat.S_IMODE(mode)
                    assert permissions in (0, 0o600, 0o644, 0o755), "Z2_BROWSER_ARCHIVE_MODE"
                    assert 0 <= entry.file_size <= 512*1024*1024
                    total += entry.file_size
                    members[name] = (entry, permissions or (0o755 if entry.is_dir() else 0o644))
                assert 0 < len(members) <= 10000 and total <= 1024*1024*1024
                for name in members:
                    assert all(str(parent) not in members or members[str(parent)][0].is_dir()
                               for parent in PurePosixPath(name).parents if str(parent) != ".")
                # No extraction occurs until every member has passed the audit.
                destination.mkdir(mode=0o700)
                files = {}
                for name, (entry, permissions) in sorted(members.items()):
                    target = destination/name
                    if entry.is_dir():
                        target.mkdir(mode=permissions, parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                    with zipped.open(entry) as reader, target.open("xb") as writer:
                        shutil.copyfileobj(reader, writer, length=1024*1024)
                    target.chmod(permissions)
                    assert target.stat().st_size == entry.file_size
                    files[name] = {"sha256": sha(target), "bytes": entry.file_size, "mode": permissions}
                assert files and "INSTALLATION_COMPLETE" not in members
                (destination/"INSTALLATION_COMPLETE").touch(mode=0o600, exist_ok=False)
                asset.update(status="PASSED", memberCount=len(members), uncompressedBytes=total,
                             completeMemberAudit=True, files=files)
        receipt["status"] = "PASSED"
        return True
    except (AssertionError, OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
        receipt["failure"] = type(error).__name__+": "+str(error)
        print(json.dumps({"browserAcquisition": "FAILED", "failure": receipt["failure"]}), flush=True)
        return False
    finally:
        (out/"browser-acquisition.json").write_text(json.dumps(receipt, sort_keys=True, indent=2)+"\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--source-tree", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--temporary-cache-parent", help="New private npm/header/temp cache under /dev/shm only")
    args = parser.parse_args()
    if not args.temporary_cache_parent:
        return install(args)
    parent = Path(args.temporary_cache_parent)
    assert parent.is_absolute() and parent.resolve() == Path("/dev/shm")
    out = Path(args.evidence_dir).resolve()
    out.relative_to(Path(args.repo).resolve()/"scope-z/phase-evidence/z2")
    assert not out.exists(), "Z2_NEW_INSTALL_EVIDENCE_DIRECTORY_REQUIRED"
    cache = tempfile.TemporaryDirectory(prefix="z2-install-cache-", dir=parent)
    temporary = Path(cache.name)
    receipt = {"schema": "finnor.project-z.z2.temporary-build-cache.v1", "path": str(temporary),
               "scope": "NPM_DOWNLOADS_NODE_HEADERS_AND_TEMP_ONLY_NOT_RUNTIME_ASSETS", "cleanup": "PENDING"}
    try:
        return install(args, temporary)
    finally:
        original_error = sys.exc_info()[0] is not None
        try:
            files = [p for p in temporary.rglob("*") if p.is_file() and not p.is_symlink()]
            receipt["fileCount"] = len(files)
            receipt["retainedBytesBeforeCleanup"] = sum(p.stat().st_size for p in files)
            if out.is_dir():
                target = out/"logs/temporary-npm-cache"
                target.mkdir(parents=True, exist_ok=True)
                for path in (temporary/"npm-cache/_logs").glob("*.log"):
                    shutil.copyfile(path, target/path.name)
        except OSError as error:
            receipt["inspectionFailure"] = type(error).__name__
        try:
            cache.cleanup()
            receipt["cleanup"] = "REMOVED" if not temporary.exists() else "FAILED"
        except OSError as error:
            receipt["cleanup"] = "FAILED"
            receipt["cleanupFailure"] = type(error).__name__
        if out.is_dir():
            (out/"temporary-cache-receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=2)+"\n")
        if receipt["cleanup"] != "REMOVED" and not original_error:
            raise RuntimeError("Z2_TEMPORARY_BUILD_CACHE_CLEANUP_FAILED")


def install(args, temporary_cache=None):
    repo, source, out, node = [Path(v).resolve() for v in (args.repo, args.source_tree, args.evidence_dir, args.node)]
    source.relative_to(repo/"scope-z/phase-evidence/z2")
    out.relative_to(repo/"scope-z/phase-evidence/z2")
    node.relative_to(repo)
    npm_path = node.parent.parent/"lib/node_modules/npm/bin/npm-cli.js"
    assert node.is_file() and npm_path.is_file() and npm_path.resolve() == npm_path, "Z2_OWN_NODE_DISTRIBUTION_NPM_REQUIRED"
    required_node = json.loads((source/"infra/deployment/release-toolchain.json").read_text())["nodeVersion"]
    out.mkdir(parents=True, exist_ok=False)
    pack, logs, home = out/"pack", out/"logs", out/"home"
    bin_dir = pack/"finnor-os/.z2-installed/bin"
    logs.mkdir()
    home.mkdir()
    (home/"user.npmrc").write_text("")
    (home/"global.npmrc").write_text("")
    inputs = {}
    for path in sorted(source.rglob("*")):
        if path.is_dir():
            continue
        assert path.is_file() and not path.is_symlink()
        relative = path.relative_to(source)
        assert "node_modules" not in relative.parts and not any(p.startswith(".env") for p in relative.parts)
        assert relative.name != "JARVIS-CREDENTIALS-LEDGER.md"
        assert not str(relative).startswith("docs/centropy/evidence/")
        target = pack/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        shutil.copymode(path, target)
        inputs[str(relative)] = sha(path)
    (out/"source-input-sha256.json").write_text(json.dumps(inputs, sort_keys=True, indent=2)+"\n")
    original_locks = {name: sha(pack/name) for name in ("package-lock.json", "finnor-os/package-lock.json")}
    env = {"HOME": str(home), "PATH": str(node.parent)+":/usr/bin:/bin", "NODE_ENV": "test",
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "CI": "1", "NEXT_TELEMETRY_DISABLED": "1",
           "NODE_OPTIONS": "--max-old-space-size=4096", "PYTHONDONTWRITEBYTECODE": "1",
           "npm_config_userconfig": str(home/"user.npmrc"), "npm_config_globalconfig": str(home/"global.npmrc"),
           "npm_config_cache": str(out/"npm-cache"), "npm_config_devdir": str(out/"node-headers"),
           "npm_config_registry": "https://registry.npmjs.org", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
           "npm_config_fetch_retries": "0",
           "PLAYWRIGHT_BROWSERS_PATH": str(pack/".z2-installed/browsers"),
           "GIT_CEILING_DIRECTORIES": str(out),
           "FINNOR_Z2_ISOLATED_SOURCE_BUILD": "1",
           "FINNOR_Z2_SOURCE_BUILD_METADATA_SHA256": inputs[".z2-source-build.json"],
           "FINNOR_Z2_BUILD_GRAPH": "1", "FINNOR_X1_FRONTEND_INSTALL": "1",
           "FINNOR_BUILD_ID": "z2-"+digest(inputs)[:24]}
    if temporary_cache is not None:
        (temporary_cache/"tmp").mkdir()
        env.update(npm_config_cache=str(temporary_cache/"npm-cache"),
                   npm_config_devdir=str(temporary_cache/"node-headers"), TMPDIR=str(temporary_cache/"tmp"))
    backend = pack/"finnor-os"
    for name, path in {"FINNOR_Z2_ASSET_ROOT": "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions",
                       "FINNOR_Z2_OWNER_ASSET_ROOT": "finnor-os/packages/private-equity/src/project-z/z2-coalitions",
                       "FINNOR_Y3_ASSET_ROOT": "finnor-os/packages/private-equity/src/interaction-synthesis",
                       "FINNOR_Y3_OWNER_ASSET_ROOT": "finnor-os/packages/private-equity/src/interaction-synthesis"}.items():
        env[name] = str(pack/path)
    npm = [str(node), str(npm_path)]
    started, steps, browser_proof, authority_stop = time.monotonic(), [], {}, None

    def run(name, command, cwd=pack, expected=(0,), timeout=900, variables=None, required_log=None):
        nonlocal authority_stop
        begin = time.monotonic()
        usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        peak_rss, limit = 0, (6 if name.endswith("-project-build") else 4)*1024**3
        with (logs/(name+".log")).open("wb") as log:
            if authority_stop:
                log.write(("NOT_RUN_AFTER_"+authority_stop+"\n").encode())
                code, termination = None, authority_stop
            else:
                child = subprocess.Popen([str(c) for c in command], cwd=cwd, env=variables or env,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                termination = None
                while True:
                    peak_rss = max(peak_rss, descendant_rss(child.pid))
                    if peak_rss > limit or time.monotonic()-begin >= timeout:
                        termination = "AGGREGATE_RSS_BOUND" if peak_rss > limit else "TIMEOUT"
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait()
                        code = None
                        break
                    try:
                        code = child.wait(timeout=0.25)
                        break
                    except subprocess.TimeoutExpired:
                        continue
        log_text = (logs/(name+".log")).read_text()
        blocked = re.search(r"(?:\bcode E|Z2_HTTP_STATUS=|server returned code |"
                            r"\b(?:HTTP|http)(?:/[0-9.]+)?[ :]+)(401|402|403|429)\b", log_text)
        if blocked:
            authority_stop = "HTTP_"+blocked[1]
        usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        required_log_matched = required_log is None or required_log in log_text
        record = {"id": name, "command": [str(c) for c in command], "cwd": str(cwd), "exitCode": code,
                  "signal": termination, "expectedExitCodes": list(expected),
                  "passed": code in expected and required_log_matched and not termination and not blocked,
                  "requiredLogFragment": required_log, "requiredLogMatched": required_log_matched,
                  "sampledAggregatePeakRssBytes": peak_rss, "aggregateRssGuardBytes": limit,
                  "childUserCpuSeconds": usage_after.ru_utime-usage_before.ru_utime,
                  "childSystemCpuSeconds": usage_after.ru_stime-usage_before.ru_stime,
                  "wallMs": round(1000*(time.monotonic()-begin)), "logSha256": sha(logs/(name+".log"))}
        steps.append(record)
        (out/"steps.json").write_text(json.dumps(steps, indent=2)+"\n")
        print(json.dumps({k: record[k] for k in ("id", "exitCode", "passed", "wallMs")}), flush=True)
        return record["passed"]

    # One full dependency installation/heavy graph on this shared host at once.
    heavy_lock = "/home/factory-user/repos/finnor-z-remote-heavy.lock"
    with Path(heavy_lock).open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        run("node-version", [node, "--version"])
        assert (logs/"node-version.log").read_text().strip() == "v"+required_node, "Z2_EXACT_RELEASE_NODE_REQUIRED"
        run("npm-version", npm+["--version"])
        for name in ("gcc", "g++", "make", "git", "ldd", "curl"):
            run(name+"-version", ["/usr/bin/"+name, "--version"], timeout=30)
        run("parent-git-discovery-refused", ["/usr/bin/git", "rev-parse", "--show-toplevel"], expected=(128,))
        front = run("frontend-locked-ci", npm+["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0"], timeout=900)
        back = run("backend-locked-ci", npm+["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0"], cwd=backend, timeout=900)
        if front and back:
            run("native-flock-rebuild", npm+["rebuild", "fs-ext", "--build-from-source", "--no-audit", "--no-fund"], cwd=backend, timeout=300)
            run("native-flock-load", [node, "-e", "require('fs-ext'); console.log('installed native flock loaded')"], cwd=backend)
            package_found = run("browser-package-path", [node, "-p", "require.resolve('playwright/package.json')"], cwd=backend)
            if package_found:
                package_path = Path((logs/"browser-package-path.log").read_text().strip()).resolve()
                package_path.relative_to(pack)
                browser_installed = install_browsers(node, package_path, pack, backend, out, logs, run)
                if browser_installed:
                    run("browser-installed-renderer", [node, backend/"scripts/project-z/z2/browser-rebuild-proof.mjs",
                        pack, out/"browser-proof"], cwd=backend, timeout=120)
                    if (out/"browser-proof/report.json").is_file():
                        browser_proof = json.loads((out/"browser-proof/report.json").read_text())
            run("node-system-libraries", ["/usr/bin/ldd", node])
            if browser_proof.get("browser"):
                run("browser-system-libraries", ["/usr/bin/ldd", browser_proof["browser"]["executablePath"]])
            run("openapi-generate", npm+["run", "openapi"], cwd=backend)
            for name in ("client", "manifest", "forms", "coverage"):
                run(name+"-generate", npm+["run", "centropy:"+name])
            for name in ("workspace:check", "centropy:client:check", "centropy:manifest:check", "centropy:forms:check", "centropy:coverage:check"):
                run(name.replace(":", "-"), npm+["run", name])
            run("coverage-source-metadata-tamper-refused",
                [node, pack/"scripts/centropy/audit-capability-coverage.mjs", "--check"], expected=(1,),
                variables={**env, "FINNOR_Z2_SOURCE_BUILD_METADATA_SHA256": "0"*64},
                required_log="Z2_ISOLATED_COVERAGE_METADATA_HASH")
            for phase in ("x3", "x5", "x4", "y2"):
                run(phase+"-source-stamp", [node, "--import", "tsx", backend/("scripts/"+phase+"/stamp-source.mts")], cwd=backend)
            run("backend-full-graph", [node, backend/"node_modules/typescript/bin/tsc", "-p", backend/"tsconfig.json"], timeout=600)
            run("frontend-full-graph", [node, pack/"node_modules/typescript/bin/tsc", "-p", pack/"tsconfig.json", "--incremental", "false"], timeout=600)
            run("mounted-component-lint", [node, pack/"node_modules/eslint/bin/eslint.js",
                pack/"src/components/centropy/canvas/InteractionProtocolPanel.tsx"])
            run("root-full-lint", npm+["run", "lint"], timeout=600)
            run("owner-root-bundles", [node, backend/"scripts/project-z/z2/bundle-owner.mjs", pack, bin_dir], timeout=600)
            if steps[-1]["passed"]:
                run("installed-emitted-processes", [node, backend/"scripts/project-z/z2/runtime-harness.mjs", pack, bin_dir, out/"process-proof"], timeout=600)
            run("guarded-native-driver", [node, backend/"scripts/project-z/z2/native-replay.mjs",
                "--evidence-dir", out/"native-not-run"], expected=(78,))
            run("guarded-invalid-native-target", [node, backend/"scripts/project-z/z2/native-replay.mjs",
                "--validate-target", "--target", backend/"scripts/project-z/z2/native-replay-target.template.json",
                "--evidence-dir", out/"native-invalid-target"], expected=(1,))
            # Normal project build scripts retain their deterministic source stamps.
            run("api-project-build", npm+["run", "build", "--workspace", "@finnor/api"], cwd=backend,
                timeout=1500, variables={**env, "NODE_ENV": "production"})
            run("frontend-project-build", npm+["run", "build", "--", "--webpack"], timeout=1500,
                variables={**env, "NODE_ENV": "production"})
            run("installed-critical-falsifiers", ["/usr/bin/python3", "-I", "-B",
                backend/"scripts/project-z/z2/falsify.py", "--repo", pack, "--evidence-dir", out/"critical-falsifiers"], timeout=600)
            run("installed-eight-obligation-equipment", ["/usr/bin/python3", "-I", "-B",
                backend/"scripts/project-z/z2/obligation-replay.py", "--repo", pack,
                "--evidence-dir", out/"eight-obligation-equipment"], timeout=900)
            run("installed-structural-32x8", ["/usr/bin/python3", "-I", "-B",
                backend/"scripts/project-z/z2/structural-replay.py", "--repo", pack,
                "--evidence-dir", out/"structural-32x8", "--cases", "8", "--budget-ms", "20000"], timeout=900)
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    assert all(sha(pack/path) == value for path, value in original_locks.items())
    assert all(sha(source/path) == value for path, value in inputs.items())
    generated = {path: {"before": value, "after": sha(pack/path)} for path, value in inputs.items()
                 if sha(pack/path) != value}
    final_sources = {path: sha(pack/path) for path in inputs}
    (out/"source-final-sha256.json").write_text(json.dumps(final_sources, sort_keys=True, indent=2)+"\n")
    # Only generated build inputs may change. Every change is named and retained.
    expected_next_env, import_count = re.subn(
        r'^import "\./(?:\.next|\.next-x1-install|\.next-z1-install)/types/(routes\.d\.ts|root-params\.d\.ts)";$',
        lambda match: 'import "./.next-x1-install/types/'+match[1]+'";',
        (source/"next-env.d.ts").read_text(), flags=re.MULTILINE)
    exact_generated_next_env = import_count == 2 and (pack/"next-env.d.ts").read_text() == expected_next_env
    forbidden = [p for p in generated if not (p == "next-env.d.ts" and exact_generated_next_env or
                 p.endswith(".generated.ts") or p.endswith(".generated.json") or
                 p in {"finnor-os/openapi.json", "src/lib/centropy/openapi-types.ts", "src/lib/jarvis/openapi-types.ts",
                       "finnor-os/packages/private-equity/src/system-identification/core-child.generated.mjs",
                       "docs/centropy/capability-coverage.json",
                       "finnor-os/apps/api/next-env.d.ts", "finnor-os/apps/api/tsconfig.json"})]
    build_ids = {}
    for name, directory in {"api": backend/"apps/api/.next", "frontend": pack/".next-x1-install"}.items():
        build_ids[name] = (directory/"BUILD_ID").read_text().strip() if (directory/"BUILD_ID").is_file() else None
    outputs = {str(p.relative_to(out)): sha(p) for folder in [bin_dir, backend/"apps/api/.next", pack/".next-x1-install"]
               if folder.exists() for p in sorted(folder.rglob("*"))
               if p.is_file() and not p.is_symlink() and "cache" not in p.relative_to(folder).parts
               and "node_modules" not in p.relative_to(folder).parts}
    (out/"build-output-sha256.json").write_text(json.dumps(outputs, sort_keys=True, indent=2)+"\n")
    native_assets = {str(p.relative_to(pack)): sha(p)
        for base in (pack/"node_modules", backend/"node_modules")
        for p in sorted(base.rglob("*"))
        if p.is_file() and not p.is_symlink() and (p.suffix in (".node", ".wasm", ".so", ".dylib") or
           ".so." in p.name or p.name == "esbuild" and "@esbuild" in p.parts)}
    (out/"installed-native-asset-sha256.json").write_text(json.dumps(native_assets, sort_keys=True, indent=2)+"\n")
    header_root = Path(env["npm_config_devdir"])
    header_files = {str(p.relative_to(header_root)): sha(p) for p in sorted(header_root.rglob("*"))
                    if p.is_file() and not p.is_symlink()}
    (out/"installed-node-header-sha256.json").write_text(json.dumps(header_files, sort_keys=True, indent=2)+"\n")
    os_tools = {}
    for name in ("gcc", "g++", "make", "git", "ldd", "curl"):
        path = Path("/usr/bin/"+name).resolve()
        os_tools[name] = {"path": str(path), "sha256": sha(path)}
    browser_root, browser_assets, browser_problems = pack/".z2-installed/browsers", {}, []
    for path in sorted(browser_root.rglob("*")):
        if path.is_symlink():
            browser_problems.append({"symlink": str(path.relative_to(pack))})
        elif path.is_file():
            browser_assets[str(path.relative_to(pack))] = sha(path)
    (out/"installed-browser-asset-sha256.json").write_text(json.dumps(browser_assets, sort_keys=True, indent=2)+"\n")
    system_libraries, library_problems = {}, []
    for name in ("node-system-libraries", "browser-system-libraries"):
        log = logs/(name+".log")
        if not log.is_file():
            library_problems.append({"missingCommand": name})
            continue
        data = log.read_text()
        if "not found" in data:
            library_problems.append({"command": name, "missingLibraries": True})
        for filename in re.findall(r"(?:=>\s+)?(/[^\s()]+)\s+\(", data):
            path = Path(filename).resolve()
            if not str(path).startswith(("/usr/lib/", "/lib/", "/usr/local/lib/")) or ".so" not in path.name:
                library_problems.append({"unexpectedLibraryPath": str(path)})
                continue
            system_libraries[str(path)] = sha(path)
    (out/"installed-system-library-sha256.json").write_text(json.dumps(system_libraries, sort_keys=True, indent=2)+"\n")
    trace_files, trace_directories, trace_problems = {}, {}, []
    for folder in (backend/"apps/api/.next", pack/".next-x1-install"):
        if not folder.exists():
            continue
        for manifest in sorted(folder.rglob("*.nft.json")):
            for name in json.loads(manifest.read_text()).get("files", []):
                path = (manifest.parent/name).resolve()
                try:
                    local = str(path.relative_to(pack))
                except ValueError:
                    trace_problems.append({"manifest": str(manifest.relative_to(pack)), "outsideInstalledTarget": str(path)})
                    continue
                if path.is_file():
                    if local not in trace_files:
                        trace_files[local] = native_assets.get(local) or sha(path)
                elif path.is_dir():
                    if local in trace_directories:
                        continue
                    entries = {}
                    for entry in sorted(path.rglob("*")):
                        if entry.is_symlink():
                            trace_problems.append({"manifest": str(manifest.relative_to(pack)),
                                                   "symlinkInsideTracedDirectory": str(entry.relative_to(pack))})
                            continue
                        if not entry.is_file():
                            continue
                        asset = entry.resolve()
                        try:
                            key = str(asset.relative_to(pack))
                        except ValueError:
                            trace_problems.append({"manifest": str(manifest.relative_to(pack)),
                                                   "outsideInstalledTarget": str(asset)})
                            continue
                        trace_files[key] = trace_files.get(key) or native_assets.get(key) or sha(asset)
                        entries[key] = trace_files[key]
                    if not entries:
                        trace_problems.append({"manifest": str(manifest.relative_to(pack)), "emptyTracedDirectory": local})
                    trace_directories[local] = {"fileCount": len(entries), "filesDigest": digest(entries)}
                else:
                    trace_problems.append({"manifest": str(manifest.relative_to(pack)), "missing": local})
    (out/"installed-trace-closure-sha256.json").write_text(json.dumps(trace_files, sort_keys=True, indent=2)+"\n")
    coverage = json.loads((pack/"docs/centropy/capability-coverage.json").read_text())
    source_metadata = json.loads((pack/".z2-source-build.json").read_text())
    source_metadata_verified = (coverage.get("executedProofIndexMode") == "DECLARED_BASELINE_INDEX_NOT_REOBSERVED" and
        (coverage.get("sourceBuildProvenance") or {}).get("metadataSha256") == inputs[".z2-source-build.json"] and
        coverage.get("sourceBaseCommit") == source_metadata["sourceBaseCommit"])
    report = {"schema": "finnor.project-z.z2.whole-owner-install.v1", "sourceInputDigest": digest(inputs),
              "sourceDigest": digest(final_sources), "sourceFileCount": len(inputs), "sourceRoot": str(source),
              "installedRoot": str(pack), "dependencyLocks": original_locks, "generatedInputChanges": generated,
              "unexpectedSourceChanges": forbidden, "exactGeneratedNextEnvRewrite": exact_generated_next_env,
              "steps": steps, "buildIds": build_ids, "buildOutputsDigest": digest(outputs),
              "nativeAssetsDigest": digest(native_assets), "nativeAssetCount": len(native_assets),
              "nodeHeadersDigest": digest(header_files), "nodeHeaderFileCount": len(header_files),
              "declaredOsToolchain": os_tools,
              "browser": {**browser_proof.get("browser", {}), "proofStatus": browser_proof.get("status", "NOT_RUN"),
                  "assetRoot": str(browser_root), "assetsDigest": digest(browser_assets), "assetFileCount": len(browser_assets),
                  "installSelection": "PINNED_CHROMIUM_HEADLESS_SHELL_ONLY",
                  "assetProblems": browser_problems, "packagingScope": "LITERAL_LOCAL_DOCUMENT_NOT_NATIVE_OWNER"},
              "systemLibrariesDigest": digest(system_libraries), "systemLibraryCount": len(system_libraries),
              "systemLibraryProblems": library_problems, "systemLibraryScope": "DECLARED_NODE_AND_CHROMIUM_OS_TOOLCHAIN",
              "sourceBuildMetadataSha256": inputs[".z2-source-build.json"],
              "sourceBuildMetadataVerified": source_metadata_verified,
              "legacyOwnerProofIndexScope": "DECLARED_BASELINE_NOT_REOBSERVED_NOT_NATIVE_OWNER_EVIDENCE",
              "traceClosureDigest": digest(trace_files), "traceClosureFileCount": len(trace_files),
              "traceDirectoryEntries": trace_directories, "traceClosureProblems": trace_problems,
              "engineeringStatus": "PASSED" if all(r["passed"] for r in steps) and not forbidden and
                  all(build_ids.values()) and native_assets and trace_files and not trace_problems and browser_assets and
                  browser_proof.get("status") == "PASSED" and not browser_problems and system_libraries and
                  not library_problems and source_metadata_verified else "FAILED",
              "node": {"path": str(node), "sha256": sha(node), "requiredVersion": required_node},
              "npm": {"path": str(npm_path), "sha256": sha(npm_path), "borrowedSystemNpm": False},
              "pythonSha256": sha(Path("/usr/bin/python3").resolve()),
              "heavyLock": heavy_lock, "authorityOrQuotaStop": authority_stop,
              "environmentNames": sorted(env), "borrowedNodeModules": False, "sourceFallbackUsed": False,
              "temporaryBuildCache": str(temporary_cache) if temporary_cache is not None else None,
              "parentGitDiscoveryBlocked": next(r for r in steps if r["id"] == "parent-git-discovery-refused")["exitCode"] == 128,
              "sourceSharedFilesModified": False, "servicesStarted": False, "databaseOrAuthAccess": False,
              "authenticatedOwner": "NOT_RUN", "mountedOwnerExecution": "NOT_RUN", "physicalRecovery": "NOT_RUN",
              "installedOwnerExecution": "NOT_RUN", "protectedAdmission": False, "financialQualification": "NOT_RUN",
              "wallMs": round(1000*(time.monotonic()-started)), "moneyUsd": None, "humanSeconds": None,
              "aggregatePeakMemoryBytes": None,
              "sampledAggregatePeakRssBytes": max((r["sampledAggregatePeakRssBytes"] for r in steps), default=0),
              "childUserCpuSeconds": sum(r["childUserCpuSeconds"] for r in steps),
              "childSystemCpuSeconds": sum(r["childSystemCpuSeconds"] for r in steps),
              "memoryScope": "SAMPLED_COMMAND_DESCENDANTS_NOT_HOST_OR_Z1",
              "costStatus": "PARTIALLY_METERED"}
    (out/"install-report.json").write_text(json.dumps(report, sort_keys=True, indent=2)+"\n")
    print(json.dumps({"engineeringStatus": report["engineeringStatus"], "steps": len(steps), "buildIds": build_ids,
                      "failed": [r["id"] for r in steps if not r["passed"]], "unexpectedSourceChanges": forbidden}), flush=True)
    return int(report["engineeringStatus"] != "PASSED")


if __name__ == "__main__":
    raise SystemExit(main())
