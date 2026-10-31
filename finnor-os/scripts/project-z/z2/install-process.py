"""Fresh locked process installation, explicit assets and real emitted entrypoints.

This does not install or impersonate an authenticated owner/database/browser.
It runs no migration, signer, provider, grant or financial operation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    repo, out, node = Path(args.repo).resolve(), Path(args.evidence_dir).resolve(), Path(args.node).resolve()
    out.relative_to(repo/"scope-z/phase-evidence/z2")
    out.mkdir(parents=True, exist_ok=False)
    pack = out/"pack"
    pack.mkdir()
    (pack/"bin").mkdir()
    (out/"proof").mkdir()
    (out/"inputs").mkdir()
    started, steps = time.monotonic(), []
    environment = {"HOME": str(out/"home"), "PATH": str(node.parent)+":/usr/bin:/bin",
        "LANG": "C.UTF-8", "NODE_OPTIONS": "--max-old-space-size=1536",
        "npm_config_userconfig": str(out/"home/user.npmrc"), "npm_config_globalconfig": str(out/"home/global.npmrc"),
        "npm_config_cache": str(out/"npm-cache"), "npm_config_registry": "https://registry.npmjs.org"}
    (out/"home").mkdir()
    (out/"home/user.npmrc").write_text("")
    (out/"home/global.npmrc").write_text("")

    def run(name, command, cwd=pack):
        result = subprocess.run(command, cwd=cwd, env=environment, capture_output=True, text=True, timeout=150)
        (out/(name+".stdout")).write_text(result.stdout)
        (out/(name+".stderr")).write_text(result.stderr)
        steps.append({"id": name, "command": [str(c) for c in command], "cwd": str(cwd), "exitCode": result.returncode})
        (out/"steps.json").write_text(json.dumps(steps, indent=2)+"\n")
        if result.returncode:
            raise RuntimeError("Z2_INSTALL_STEP_FAILED:"+name)
        return result.stdout

    version = run("node-version", [str(node), "--version"]).strip()
    if not version.startswith("v22."):
        raise RuntimeError("Z2_NODE22_REQUIRED")
    prefixes = [
        "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions",
        "finnor-os/packages/private-equity/src/project-z/z2-coalitions"
    ]
    sources = {p.relative_to(repo) for prefix in prefixes for p in (repo/prefix).iterdir()
               if p.is_file() and p.suffix in (".ts", ".py", ".json")}
    native = Path("finnor-os/packages/private-equity/src/interaction-synthesis")
    native_names = [
        "profile.json", "producer.py", "checker.py", "contracts.ts", "exact.ts", "game.ts", "producer.ts", "process.ts",
        "product-contracts.ts", "product-runtime.ts", "store.ts", "worker.ts", "api.ts", "continuation.ts", "execution-guard.ts",
        "../economic-control.ts", "../../../capability-evolution/src/interaction-port.ts",
        "../../../../apps/api/app/api/company-brain/[operation]/route.ts", "../../../../apps/worker/src/index.ts",
        "../../../db/compute-contract.ts", "../../../db/migrations/0197_postx_y3_interaction_protocol.sql"
    ]
    sources.update((repo/native/name).resolve().relative_to(repo) for name in native_names)
    source_hashes = {}
    for relative in sorted(sources):
        source, target = repo/relative, pack/relative
        source_hashes[str(relative)] = sha(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    shutil.copyfile(repo/"finnor-os/scripts/project-z/z2/installed-driver.mjs", pack/"installed-driver.mjs")
    source_hashes["finnor-os/scripts/project-z/z2/installed-driver.mjs"] = sha(pack/"installed-driver.mjs")
    for name, case in [
        ("dynamic", "construct-authorized"), ("mixture", "exact-original-mixture-quarter"),
        ("pooling", "private-pooling"), ("native-floor", "weakened-native-sequential-floor"),
        ("impossible", "full-family-exclusion")
    ]:
        shutil.copyfile(repo/"scope-z/phase-evidence/z2/run-falsifiers-01"/case/"input.json", out/"inputs"/(name+".json"))
    lock_path = repo/"finnor-os/package-lock.json"
    original_lock = json.loads(lock_path.read_text())
    dependencies = {n: original_lock["packages"]["node_modules/"+n]["version"] for n in ("esbuild", "zod")}
    (pack/"package.json").write_text(json.dumps({"name": "finnor-z2-installed-process-development", "version": "1.0.0",
        "private": True, "type": "module", "engines": {"node": "22.x"}, "dependencies": dependencies}, indent=2)+"\n")
    npm = [str(node), "/usr/lib/node_modules/npm/bin/npm-cli.js"]
    # Ubuntu's npm launcher is a script at /usr/share/nodejs/npm/bin/npm-cli.js on some images.
    if not Path(npm[1]).is_file():
        npm[1] = str(Path("/usr/bin/npm").resolve())
    run("lock", npm+["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"])
    installed_lock = json.loads((pack/"package-lock.json").read_text())
    closure = []
    for path, installed in installed_lock["packages"].items():
        if not path:
            continue
        original = original_lock["packages"].get(path)
        if not original or any(installed.get(k) != original.get(k) for k in ("version", "integrity", "resolved")):
            raise RuntimeError("Z2_INSTALLED_DEPENDENCY_NOT_PROJECT_LOCK_BOUND:"+path)
        closure.append({"path": path, "version": installed["version"], "integrity": installed["integrity"]})
    run("ci", npm+["ci", "--ignore-scripts", "--no-audit", "--no-fund"])
    entry = (
        'export {coalitionProductRuntime} from "./finnor-os/packages/private-equity/src/project-z/z2-coalitions/runtime.ts";\n'
        'export {constructCoalitions,independentlyCheckCoalitions} from "./finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions/process.ts";\n'
        'export {runtimeIdentity as nativeRuntimeIdentity,independentlyCheck as independentlyCheckNative} from "./finnor-os/packages/private-equity/src/interaction-synthesis/process.ts";\n'
    )
    (pack/"build-entry.mjs").write_text(entry)
    esbuild = pack/"node_modules/esbuild/bin/esbuild"
    build_inputs = {}
    for name in ("api", "worker"):
        run("build-"+name, [str(node), str(esbuild), str(pack/"build-entry.mjs"), "--bundle", "--platform=node", "--format=esm",
            "--target=node22", "--packages=external", "--outfile="+str(pack/"bin"/(name+"-runtime.mjs")),
            "--metafile="+str(pack/"bin"/(name+"-inputs.json"))])
        metadata = json.loads((pack/"bin"/(name+"-inputs.json")).read_text())
        for path in metadata["inputs"]:
            (pack/path).resolve().relative_to(pack)
        for output in metadata["outputs"].values():
            if any(i.get("external") and not (i["path"] == "zod" or i["path"].startswith("node:")) for i in output["imports"]):
                raise RuntimeError("Z2_UNDECLARED_EXTERNAL_BUILD_IMPORT")
        build_inputs[name] = metadata
    environment.update({
        "FINNOR_Z2_ASSET_ROOT": str(pack/prefixes[0]),
        "FINNOR_Z2_OWNER_ASSET_ROOT": str(pack/prefixes[1]),
        "FINNOR_Y3_ASSET_ROOT": str(pack/native), "FINNOR_Y3_OWNER_ASSET_ROOT": str(pack/native)
    })
    for mode in ("api", "worker"):
        run("run-"+mode, [str(node), str(pack/"installed-driver.mjs"), str(out), mode])
    if any(sha(repo/path) != value for path, value in source_hashes.items()):
        raise RuntimeError("Z2_RECONSTRUCTION_SOURCE_CHANGED")
    files = {str(p.relative_to(pack)): sha(p) for p in sorted(pack.rglob("*")) if p.is_file()}
    report = {"schema": "finnor.project-z.z2.separate-process-install.v1", "steps": steps, "sourceHashes": source_hashes,
        "base": run("source-head", ["git", "-C", str(repo), "rev-parse", "HEAD"], cwd=repo).strip(),
        "node": {"path": str(node), "version": version, "sha256": sha(node)},
        "python": {"path": "/usr/bin/python3", "sha256": sha(Path("/usr/bin/python3").resolve())},
        "projectDependencyLockSha256": sha(lock_path), "installedDependencyLockSha256": sha(pack/"package-lock.json"),
        "dependencyClosureMatchesProjectLock": closure, "buildInputs": build_inputs,
        "sourceFallbackUsed": False, "borrowedNodeModules": False,
        "wallMs": round(1000*(time.monotonic()-started)), "moneyUsd": None, "humanSeconds": None,
        "aggregatePeakMemoryBytes": None, "costStatus": "PARTIALLY_METERED",
        "scope": "SEPARATELY_INSTALLED_PROCESS_DEVELOPMENT_NOT_WHOLE_OWNER_RECONSTRUCTION",
        "authenticatedOwner": "NOT_RUN", "nativePhysicalRecovery": "NOT_RUN", "mountedWork": "NOT_RUN",
        "installedWholeOwnerReconstruction": "INCOMPLETE", "protectedAdmission": False}
    (out/"installed-file-sha256.json").write_text(json.dumps(files, indent=2)+"\n")
    (out/"install-report.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"node": version, "wallMs": report["wallMs"], "steps": len(steps),
                      "scope": report["scope"], "report": str(out/"install-report.json")}))


if __name__ == "__main__":
    main()
