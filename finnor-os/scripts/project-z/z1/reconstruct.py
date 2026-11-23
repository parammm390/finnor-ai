"""Fresh locked-dependency reconstruction of the Z1 development kernel.

The target has no .git and no borrowed node_modules. This is not a full
authenticated installed FINNOR/Work proof. Run under the shared heavy flock.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

PREFIXES = (
    "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work",
    "finnor-os/packages/orchestration/src/project-z/z1-shared-work",
    "finnor-os/scripts/project-z/z1",
)


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    source = Path(__file__).resolve().parents[4]
    evidence = Path(sys.argv[1])
    if not evidence.is_absolute():
        raise ValueError("ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED")
    evidence.mkdir(mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix="finnor-z1-cold-"))
    target = temporary / "source"
    target.mkdir()
    report = {"schema": "finnor.z1.fresh-development-reconstruction.v1", "status": "IN_PROGRESS",
              "scope": "Fresh locked dependencies, Z1 original-semantics/process E2E. Not full application installation.",
              "temporaryTarget": str(target), "steps": [], "sourceInventory": [],
              "authenticatedNativeOwnerFlow": "NOT_RUN", "nativeMountedWork": "NOT_RUN",
              "protectedAdmission": "NOT_RUN", "borrowedNodeModules": False}
    try:
        head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        tree = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD^{tree}"], text=True).strip()
        report.update(sourceHead=head, sourceTree=tree)
        archive = temporary / "base.tar"
        with archive.open("xb") as output:
            subprocess.run(["git", "-C", str(source), "archive", "--format=tar", head,
                            "finnor-os", "scope-z/prompts/qualification-families.json"], stdout=output, check=True)
        report["declaredGitArchiveSha256"] = sha(archive)
        with tarfile.open(archive) as packed:
            packed.extractall(target, filter="data")
        for prefix in PREFIXES:
            for path in sorted((source / prefix).rglob("*")):
                if not path.is_file() or any(x in ("node_modules", "__pycache__") for x in path.parts):
                    continue
                relative = path.relative_to(source)
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
                original_digest = sha(path)
                if sha(destination) != original_digest:
                    raise ValueError("SOURCE_OVERLAY_COPY_MISMATCH")
                report["sourceInventory"].append({"path": str(relative), "sha256": original_digest, "bytes": path.stat().st_size})
        report["dependencyLockSha256"] = sha(target / "finnor-os/package-lock.json")
        if (target / ".git").exists() or (target / "finnor-os/node_modules").exists():
            raise ValueError("TARGET_NOT_FRESH")
        home, cache = temporary / "home", temporary / "npm-cache"
        home.mkdir()
        user_config, global_config = temporary / "user.npmrc", temporary / "global.npmrc"
        user_config.touch()
        global_config.touch()
        node = shutil.which("node")
        npm = shutil.which("npm")
        if not node or not npm:
            raise ValueError("DECLARED_NODE_NPM_REQUIRED")
        version = subprocess.check_output([node, "--version"], text=True).strip()
        if not version.startswith("v22."):
            raise ValueError("NODE22_REQUIRED")
        report["toolchain"] = {
            "node": version, "nodePath": str(Path(node).resolve()), "nodeSha256": sha(Path(node).resolve()),
            "npm": subprocess.check_output([npm, "--version"], text=True).strip(),
            "python": sys.version.split()[0], "pythonPath": str(Path(sys.executable).resolve()),
            "pythonSha256": sha(Path(sys.executable).resolve()),
        }
        env = {
            "PATH": os.environ["PATH"], "HOME": str(home), "LANG": "C.UTF-8",
            "NODE_OPTIONS": "--max-old-space-size=1536", "PYTHONDONTWRITEBYTECODE": "1", "TSX_DISABLE_CACHE": "1",
            "FINNOR_Z1_SOURCE_COMMIT": head, "FINNOR_Z1_SOURCE_TREE": tree,
            "npm_config_cache": str(cache), "npm_config_userconfig": str(user_config),
            "npm_config_globalconfig": str(global_config),
        }
        report["environmentNames"] = sorted(env)

        def run(name, args, timeout):
            log = evidence / (name + ".log")
            start = time.monotonic()
            with log.open("xb") as output:
                try:
                    result = subprocess.run(args, cwd=target / "finnor-os", env=env,
                                            stdout=output, stderr=subprocess.STDOUT, timeout=timeout, check=False)
                    code, timed_out = result.returncode, False
                except subprocess.TimeoutExpired:
                    code, timed_out = None, True
            step = {"name": name, "command": args, "exitCode": code, "timedOut": timed_out,
                    "wallMs": round((time.monotonic() - start) * 1000),
                    "logSha256": sha(log), "log": log.name}
            report["steps"].append(step)
            return code == 0

        if not run("fresh-npm-ci", [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], 600):
            raise ValueError("FRESH_DEPENDENCY_INSTALL_FAILED")
        installed = target / "finnor-os/node_modules"
        report["installedTsxRealpath"] = str((installed / "tsx").resolve())
        report["installedZodRealpath"] = str((installed / "zod").resolve())
        for package in ("tsx", "zod", "typescript"):
            actual = (installed / package).resolve()
            if not actual.is_relative_to(target):
                raise ValueError("BORROWED_DEPENDENCY_DETECTED")
        report["installedDependencyAssets"] = [
            {"path": relative, "sha256": sha(installed / relative)}
            for relative in ("tsx/dist/loader.mjs", "typescript/lib/typescript.js", "zod/package.json",
                             "@esbuild/linux-x64/bin/esbuild")
        ]
        loader = str(installed / "tsx/dist/loader.mjs")
        runner_dir = target / "finnor-os/scripts/project-z/z1"
        engine = target / PREFIXES[0] / "engine.ts"
        child = target / PREFIXES[0] / "producer-child.ts"
        processes = target / PREFIXES[1] / "processes.ts"
        checked = run("fresh-kernel-types", [
            node, str(installed / "typescript/bin/tsc"), "--noEmit", "--strict", "--noUncheckedIndexedAccess",
            "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
            "--types", "node", str(engine), str(child), str(processes),
        ], 120)
        checked = run("fresh-isolated-translation", [
            node, str(runner_dir / "check-syntax.mjs"), str(evidence / "fresh-isolated-translation.json"),
        ], 120) and checked
        for name, script in (
            ("fresh-original-semantics", "verify.mjs"),
            ("fresh-process-edges", "edge-cases.mjs"),
            ("fresh-local-physical-recovery", "physical-recovery.mjs"),
        ):
            checked = run(name, [node, "--import", loader, str(runner_dir / script), str(evidence / name)], 240) and checked
        report["status"] = "PASSED" if checked else "FAILED"
        report["installedApplicationReconstruction"] = "NOT_RUN"
        report["packageLifecycleScripts"] = "DISABLED; this proof needs the packaged tsx/esbuild optional binary only"
    except Exception as error:
        report["status"] = "FAILED"
        report["failure"] = {"type": type(error).__name__, "code": str(error)}
    finally:
        shutil.rmtree(temporary)
        report["temporaryTargetRemoved"] = not temporary.exists()
        with (evidence / "report.json").open("x") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    print(json.dumps({"status": report["status"], "evidence": str(evidence), "scope": report["scope"]}))
    return 0 if report["status"] == "PASSED" else 1


if __name__ == "__main__":
    sys.exit(main())
