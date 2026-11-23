"""Cold setup bodies, supervised by run-job.py, never a donor-module fallback."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("w2_cold_packet", HERE.with_name("cold_packet.py"))
cold = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cold
spec.loader.exec_module(cold)
job = cold.job


def write_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")


def source_unchanged(source, packet):
    expected = set(cold.validate_source_rows(packet["source"]["files"]))
    declared = {row["path"]: row for row in packet["source"]["files"]}
    for row in packet["source"]["files"]:
        if row["path"] in cold.PUBLIC_NPM_CONFIGURATIONS:
            cold.verify_public_configuration(source, row["path"], row)
        cold.verify_file(source / row["path"], row)
        if stat.S_IMODE((source / row["path"]).lstat().st_mode) != row["mode"]:
            raise ValueError("SEALED_SOURCE_MODE_CHANGED")
    observed = set(filter(None, (cold.git(source, "ls-files", "-z") +
        cold.git(source, "ls-files", "--others", "--exclude-standard", "-z")).decode().split("\0")))
    committed = set(filter(None, cold.git(source, "--no-replace-objects", "ls-tree", "-r",
        "--name-only", "-z", "HEAD").decode().split("\0")))
    if observed != expected or not committed.issubset(expected):
        raise ValueError("EXACT_SEALED_SOURCE_FILE_POPULATION_REQUIRED")
    for directory, directories, files in os.walk(source, followlinks=False):
        directories[:] = [name for name in directories if name not in ("node_modules", ".git")]
        for name in files:
            if ((name.startswith(".env") and not name.endswith((".example", ".template")))
                    or name in (".npmrc", ".pypirc", ".git-credentials")):
                relative = (Path(directory) / name).relative_to(source).as_posix()
                if name != ".npmrc" or relative not in cold.PUBLIC_NPM_CONFIGURATIONS or relative not in declared:
                    raise ValueError("UNDECLARED_PRIVATE_INSTALL_CONFIGURATION_REFUSED")
                cold.verify_public_configuration(source, relative, declared[relative])
    if cold.git(source, "rev-parse", "HEAD").decode().strip() != packet["source"]["identity"]["commit"]:
        raise ValueError("COLD_RECONSTRUCTED_SOURCE_COMMIT_CHANGED")


def environment(prepared, node, python):
    result = {"PATH": str(Path(node).parent) + ":" + str(Path(python).parent) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
              "HOME": str(prepared / "home"), "TMPDIR": str(prepared / "tmp"), "LANG": "C",
              "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
              "NEXT_TELEMETRY_DISABLED": "1", "NODE_OPTIONS": "--max-old-space-size=1536",
              "npm_config_offline": "true", "npm_config_audit": "false", "npm_config_fund": "false",
              "npm_config_cache": str(prepared / "npm-cache"),
              "npm_config_python": str(python),
              "npm_config_userconfig": str(prepared / "empty-user.npmrc"),
              "npm_config_globalconfig": str(prepared / "empty-global.npmrc")}
    return result


def prepare(args, packet):
    output = Path(args.output)
    source = output / "source"
    cold.extract_source(cold.packet_asset(args.packet, packet["sourceArchive"]["path"]),
                        packet["source"]["files"], source)
    for name in ("home", "tmp", "npm-cache"):
        (output / name).mkdir(mode=0o700)
    for name in ("empty-user.npmrc", "empty-global.npmrc"):
        with os.fdopen(os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"):
            pass
    env = environment(output, packet["runtime"]["node"]["path"], packet["runtime"]["python"]["path"])
    cold.git(source, "init", "--quiet", "--template=", env=env)
    pack = cold.packet_asset(args.packet, packet["sourceGitObjects"]["path"])
    with pack.open("rb") as stream:
        result = subprocess.run([os.environ.get("FINNOR_W2_GIT_BIN", "git"), "-C", str(source), "index-pack", "--stdin"],
                                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, env=env)
    if result.returncode:
        raise ValueError("SEALED_GIT_OBJECT_PACK_RESTORE_FAILED")
    commits = packet["source"]["gitCommits"]
    with (source / ".git/shallow").open("x") as stream:
        stream.write("\n".join(commits) + "\n")
    commit = packet["source"]["identity"]["commit"]
    cold.git(source, "update-ref", "--no-deref", "HEAD", commit, env=env)
    cold.git(source, "read-tree", "HEAD", env=env)
    observed_tree = cold.git(source, "rev-parse", "HEAD^{tree}", env=env).decode().strip()
    if observed_tree != packet["source"]["identity"]["tree"]:
        raise ValueError("ACTUAL_SEALED_SOURCE_TREE_REQUIRED")
    if (source / ".git/objects/info/alternates").exists():
        raise ValueError("DONOR_GIT_ALTERNATES_FORBIDDEN")
    objects = packet["sourceGitObjects"]["objects"]
    checked = cold.git(source, "cat-file", "--batch-check",
                       data=("\n".join(objects) + "\n").encode(), env=env).decode().splitlines()
    if len(checked) != len(objects) or any(" missing" in row for row in checked):
        raise ValueError("COMPLETE_DECLARED_SOURCE_GIT_OBJECTS_REQUIRED")
    donor_cache = cold.packet_asset(args.packet, packet["packageCache"]["root"])
    for row in packet["packageCache"]["assets"]:
        target = output / "npm-cache" / cold.relative(row["path"])
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (donor_cache / row["path"]).open("rb") as src, target.open("xb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        cold.verify_file(target, row)
    for name in ("node_modules", "finnor-os/node_modules"):
        if (source / name).exists() or (source / name).is_symlink():
            raise ValueError("COLD_SOURCE_MUST_START_WITHOUT_INSTALLED_MODULES")
    source_unchanged(source, packet)
    if cold.git(source, "status", "--porcelain=v1", "-uall", env=env).decode() != packet["source"]["identity"]["dirty"]:
        raise ValueError("EXACT_SEALED_SOURCE_OVERLAY_REQUIRED")
    return {"status": "PASS", "source": str(source), "prepared": str(output), "commit": commit,
            "tree": observed_tree, "gitObjects": len(objects), "packageCacheAssets": len(packet["packageCache"]["assets"]),
            "donorApplicationModulesCopied": False, "sourcePopulation": len(packet["source"]["files"]),
            "applicationNodeModulesAbsentBeforeInstall": True, "newPrivateHomeAndCache": True}


def installed_links_contained(source):
    count = 0
    for relative in ("node_modules", "finnor-os/node_modules"):
        root = source / relative
        if not root.is_dir() or root.is_symlink():
            raise ValueError("ACTUAL_COLD_NODE_MODULES_DIRECTORY_REQUIRED")
        for directory, directories, files in os.walk(root, followlinks=False):
            for name in directories + files:
                path = Path(directory) / name
                if path.is_symlink():
                    if not path.resolve(strict=True).is_relative_to(source):
                        raise ValueError("COLD_APPLICATION_DEPENDENCY_LINK_ESCAPE")
                    count += 1
    return count


def install(args, packet, started):
    prepared = Path(args.prepared).resolve(strict=True)
    source = prepared / "source"
    receipt = json.loads((prepared / "preparation.json").read_text())
    if receipt.get("status") != "PASS" or receipt.get("source") != str(source):
        raise ValueError("ACTUAL_FRESH_PREPARATION_RECEIPT_REQUIRED")
    source_unchanged(source, packet)
    relative = "" if args.action == "root-install" else "finnor-os"
    target = source / relative
    modules = target / "node_modules"
    if modules.exists() or modules.is_symlink():
        raise ValueError("COLD_INSTALL_MUST_NOT_REUSE_APPLICATION_MODULES")
    env = environment(prepared, packet["runtime"]["node"]["path"], packet["runtime"]["python"]["path"])
    command = [packet["runtime"]["node"]["path"], "--max-old-space-size=1536",
               packet["runtime"]["npmCli"]["path"], "ci", "--offline", "--no-audit", "--no-fund",
               "--cache", env["npm_config_cache"], "--userconfig", env["npm_config_userconfig"],
               "--globalconfig", env["npm_config_globalconfig"]]
    remaining = 900 - (time.monotonic() - started)
    if remaining <= 0:
        raise ValueError("ORIGINAL_COLD_INSTALL_WALL_EXHAUSTED")
    # Output goes only to run-job's bounded, redacted pipe. There is no network
    # mode fallback, cache import from HOME, module copy, or install retry.
    result = subprocess.run(command, cwd=target, env=env, timeout=remaining)
    if result.returncode:
        raise ValueError("ACTUAL_OFFLINE_NPM_CI_FAILED")
    source_unchanged(source, packet)
    contained = None
    if relative:
        contained = installed_links_contained(source)
    return {"status": "PASS", "action": args.action, "source": str(source), "actualExitCode": result.returncode,
            "command": command, "offline": True, "donorApplicationModulesCopied": False,
            "node": packet["runtime"]["node"], "npmCliSha256": packet["runtime"]["npmCli"]["sha256"],
            "locks": [{"path": name, "sha256": job.sha(source / name)}
                      for name in ("package-lock.json", "finnor-os/package-lock.json")],
            "containedDependencyLinks": contained}


def compatibility(args, packet):
    if not args.backend or not args.fresh_native:
        raise ValueError("ACTUAL_FRESH_INSTALLATION_AND_NATIVE_EVIDENCE_REQUIRED")
    fresh = Path(args.backend).resolve(strict=True)
    cold.verify_installation(fresh)
    script = HERE.parents[2] / "scripts/postz-w2/cold-compare.mjs"
    command = [packet["runtime"]["node"]["path"], "--max-old-space-size=512", str(script),
               "--packet", str(Path(args.packet).resolve()), "--fresh-installation", str(fresh),
               "--fresh-native", str(Path(args.fresh_native).resolve(strict=True)), "--output", args.output]
    result = subprocess.run(command, timeout=115)
    if result.returncode:
        raise ValueError("ACTUAL_INSTALLED_READER_INTERCHANGE_FAILED")
    return json.loads((Path(args.output) / "compatibility.json").read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("prepare", "root-install", "backend-install", "compatibility"), required=True)
    parser.add_argument("--packet", required=True)
    parser.add_argument("--packet-sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--prepared")
    parser.add_argument("--backend")
    parser.add_argument("--fresh-native")
    args = parser.parse_args()
    if args.action in ("root-install", "backend-install") and args.prepared:
        prepared = Path(args.prepared)
        if any(component.is_symlink() for component in reversed((prepared, *prepared.parents))):
            raise ValueError("PUBLIC_CONFIGURATION_SYMLINK_REFUSED")
    output = Path(args.output)
    if not output.is_absolute() or ".." in output.parts:
        raise ValueError("NEW_ABSOLUTE_COLD_STAGE_OUTPUT_REQUIRED")
    output.mkdir(mode=0o700)
    started, result = time.monotonic(), {"status": "FAIL", "action": args.action}
    report = "preparation.json" if args.action == "prepare" else "install.json"
    if args.action == "compatibility":
        report = "compatibility.json"
    try:
        packet = cold.inspect_packet(Path(args.packet).resolve(strict=True), args.packet_sha256)
        if args.action == "prepare":
            result = prepare(args, packet)
        elif args.action == "compatibility":
            result = compatibility(args, packet)
        else:
            result = install(args, packet, started)
    except Exception as error:
        result = {"status": "FAIL", "action": args.action, "failure": type(error).__name__ + ":" +
                  (str(error) if str(error).replace("_", "").isalnum() else "COLD_STAGE_OWNER_BOUNDARY_FAILED")}
    result.update(schema="finnor.w2.cold-stage.v1", packetSha256=args.packet_sha256)
    # The Node reader writes its independently observed result. Preserve it.
    path = output / report
    if not path.exists():
        write_json(path, result)
    print(json.dumps({"status": result["status"], "action": args.action, "report": str(path)}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
