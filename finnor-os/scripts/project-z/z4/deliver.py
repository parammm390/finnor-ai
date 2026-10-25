"""Freeze and read back a local engineering delivery, never a qualification gate."""
import argparse
import difflib
import gzip
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import stat
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
R = runpy.run_path(str(HERE / "reconstruct.py"))
NATIVE = "finnor-os/packages/epistemic-runtime/native/z4-execution-proof"


def check(ok, predicate):
    if not ok:
        raise RuntimeError(predicate)


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(path, 0o600)


def manifest(root, files):
    result = []
    for rel in sorted(files):
        path = root / rel
        check(not rel.startswith("/") and ".." not in Path(rel).parts, "Z4_DELIVERY_UNSAFE_PATH")
        check(path.resolve().is_relative_to(root.resolve()), "Z4_DELIVERY_SOURCE_FALLBACK")
        if path.is_symlink():
            target = os.readlink(path)
            check(not os.path.isabs(target), "Z4_DELIVERY_ABSOLUTE_SYMLINK")
            result.append({"path": rel, "kind": "symlink", "target": target})
        else:
            check(path.is_file(), "Z4_DELIVERY_REGULAR_MEMBER_REQUIRED")
            result.append({"path": rel, "kind": "file", "bytes": path.stat().st_size,
                           "sha256": sha(path), "executable": bool(path.stat().st_mode & stat.S_IXUSR)})
    return result


def archive(root, destination, members):
    content_targets, hardlinks = {}, {}
    with destination.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as tar:
                for entry in members:
                    path = root / entry["path"]
                    info = tarfile.TarInfo(entry["path"])
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ""
                    if entry["kind"] == "symlink":
                        check(os.readlink(path) == entry["target"], "Z4_DELIVERY_SYMLINK_CHANGED")
                        info.type, info.linkname, info.mode = tarfile.SYMTYPE, entry["target"], 0o700
                        tar.addfile(info)
                    else:
                        check(sha(path) == entry["sha256"], "Z4_DELIVERY_MEMBER_CHANGED")
                        info.mode = 0o500 if entry["executable"] else 0o400
                        key = (entry["sha256"], entry["bytes"], entry["executable"])
                        if key in content_targets:
                            info.type, info.linkname = tarfile.LNKTYPE, content_targets[key]
                            hardlinks[entry["path"]] = info.linkname
                            tar.addfile(info)
                        else:
                            content_targets[key] = entry["path"]
                            info.size = entry["bytes"]
                            with path.open("rb") as stream:
                                tar.addfile(info, stream)
    os.chmod(destination, 0o600)
    expected = {entry["path"]: entry for entry in members}
    seen = set()
    with tarfile.open(destination, "r:gz") as tar:
        for item in tar:
            check(item.name in expected and item.name not in seen, "Z4_DELIVERY_UNDECLARED_ARCHIVE_MEMBER")
            seen.add(item.name)
            entry = expected[item.name]
            if entry["kind"] == "symlink":
                check(item.issym() and item.linkname == entry["target"], "Z4_DELIVERY_SYMLINK_READBACK")
            else:
                if item.islnk():
                    target = expected.get(item.linkname)
                    check(item.linkname in seen and item.linkname != item.name and target is not None and
                          target["kind"] == "file" and target["sha256"] == entry["sha256"] and
                          target["executable"] == entry["executable"] and
                          hardlinks.get(item.name) == item.linkname, "Z4_DELIVERY_HARDLINK_READBACK")
                else:
                    check(item.isfile() and item.size == entry["bytes"], "Z4_DELIVERY_FILE_READBACK")
                h = hashlib.sha256()
                with tar.extractfile(item) as stream:
                    while chunk := stream.read(1024 * 1024):
                        h.update(chunk)
                check(h.hexdigest() == entry["sha256"], "Z4_DELIVERY_CONTENT_READBACK")
    check(seen == set(expected), "Z4_DELIVERY_ARCHIVE_DENOMINATOR")
    return {"path": destination.name, "sha256": sha(destination), "bytes": destination.stat().st_size,
            "members": len(members), "hardlinkMembers": len(hardlinks),
            "readback": "PASSED_ALL_DECLARED_MEMBERS"}


def evidence_files(root, output, target):
    files = set()
    for directory, dirs, names in os.walk(root):
        path = Path(directory)
        dirs[:] = [name for name in dirs if
                   (path / name).resolve() not in (output.resolve(), target.resolve()) and
                   not (path.name.startswith("vendor") and name == "vendor")]
        for name in names:
            file = path / name
            if file.is_file() and not file.is_symlink():
                files.add(str(file.relative_to(root)))
    return files


def installed_files(target):
    target = target.resolve()
    files, directories = set(), set()

    def add(path):
        # NFT paths contain ../ components. Resolve parents, not the final
        # workspace symlink whose alias must remain in the installed closure.
        path = path.parent.resolve() / path.name
        if path.name == "..":
            path = path.resolve()
        check(path.is_relative_to(target) and path.resolve().is_relative_to(target),
              "Z4_INSTALLED_PACKAGE_SOURCE_FALLBACK")
        if path.is_symlink():
            files.add(str(path.relative_to(target)))
        elif path.is_file():
            files.add(str(path.relative_to(target)))
        elif path.is_dir():
            if path in directories:
                return
            directories.add(path)
            for child in sorted(path.iterdir()):
                if child in (target / ".next-x1-install/cache", target / "finnor-os/apps/api/.next/cache"):
                    continue
                if path == target / NATIVE and child.name in (".cargo", ".cargo-home", ".toolchain", "target"):
                    continue
                add(child)
        else:
            raise RuntimeError("Z4_INSTALLED_PACKAGE_MISSING_ASSET:" + str(path.relative_to(target)))

    for rel in [".next-x1-install", "finnor-os/apps/api/.next", "public",
                ".z4-toolchains/node", ".z4-toolchains/npm", ".z4-toolchains/receipt.json",
                "z4-reconstruction-source.json", "scope-z/phase-evidence/z4/installed-provenance.json",
                R["REGISTRATION"], "package.json", "package-lock.json", "next.config.mjs",
                "finnor-os/package.json", "finnor-os/package-lock.json", "finnor-os/tsconfig.json",
                "finnor-os/tsconfig.base.json", "tsconfig.json"]:
        add(target / rel)
    for entry in R["owned_inventory"](target):
        add(target / entry["path"])
    for rel in ("bin/z4-proof", "bin/z4-field-falsifier"):
        add(target / NATIVE / rel)
    for build in (target / ".next-x1-install", target / "finnor-os/apps/api/.next"):
        for trace in sorted(build.rglob("*.nft.json")):
            for rel in json.loads(trace.read_text()).get("files", []):
                add(trace.parent / rel)
    # Exact concrete replay dependencies, not an inherited browser cache.
    for root, packages in [
        ("node_modules", ("@playwright/test", "playwright", "playwright-core")),
        ("finnor-os/node_modules", ("tsx", "esbuild", "@esbuild/linux-x64",
                                   "playwright", "playwright-core")),
    ]:
        for package in packages:
            add(target / root / package)
    # Native replay imports real workspace source, not just the bundled API.
    # Resolve the complete declared production graph plus replay equipment by
    # the same ancestor-node_modules search, never a convenient parent tree.
    def dependency(base, name):
        current = base
        while current.is_relative_to(target):
            if current.name != "node_modules":
                candidate = current / "node_modules" / name
                if (candidate / "package.json").is_file():
                    check(candidate.resolve().is_relative_to(target.resolve()), "Z4_REPLAY_DEPENDENCY_FALLBACK")
                    return candidate
            if current == target:
                break
            current = current.parent
        return None

    pending = []
    workspace = target / "finnor-os"
    for root in (target, workspace):
        for name in json.loads((root / "package.json").read_text()).get("dependencies", {}):
            package = dependency(root, name)
            check(package is not None, "Z4_REPLAY_REQUIRED_PRODUCTION_DEPENDENCY_MISSING:" + name)
            pending.append(package)
        scope = root / "node_modules/@finnor"
        if scope.is_dir():
            for link in scope.iterdir():
                if link.is_symlink():
                    check((link / "package.json").is_file(), "Z4_REPLAY_WORKSPACE_PACKAGE_MISSING")
                    add(link)
                    pending.append(link)
    for root, names in [
        (target, ("@playwright/test", "playwright", "playwright-core")),
        (workspace, ("tsx", "esbuild", "@esbuild/linux-x64", "playwright", "playwright-core")),
    ]:
        for name in names:
            package = dependency(root, name)
            check(package is not None, "Z4_REPLAY_REQUIRED_EQUIPMENT_MISSING:" + name)
            pending.append(package)
    visited = set()
    while pending:
        package = pending.pop()
        actual = package.resolve()
        if actual in visited:
            continue
        visited.add(actual)
        add(package)
        if package.is_symlink():
            add(actual)
        data = json.loads((actual / "package.json").read_text())
        required = set(data.get("dependencies", {})) - set(data.get("optionalDependencies", {}))
        optional = set(data.get("optionalDependencies", {}))
        for name in data.get("peerDependencies", {}):
            if data.get("peerDependenciesMeta", {}).get(name, {}).get("optional"):
                optional.add(name)
            else:
                required.add(name)
        for name in sorted(required | optional):
            found = dependency(actual, name)
            check(found is not None or name in optional, "Z4_REPLAY_REQUIRED_TRANSITIVE_DEPENDENCY_MISSING:" + name)
            if found is not None:
                pending.append(found)
    for scope in (target / "node_modules/@finnor", target / "finnor-os/node_modules/@finnor"):
        if scope.is_dir():
            for link in scope.iterdir():
                if link.is_symlink():
                    add(link)
    for rel in files:
        if "/native/z4-execution-proof/" in rel:
            check(not any(p in (".cargo", ".cargo-home", ".toolchain", "target") for p in Path(rel).parts),
                  "Z4_INSTALLED_PACKAGE_BUILD_INTERMEDIATE")
    for rel in files:
        file = target / rel
        if file.is_symlink():
            canonical = str(file.resolve().relative_to(target.resolve()))
            check(canonical in files or any(p.startswith(canonical + "/") for p in files),
                  "Z4_INSTALLED_PACKAGE_MISSING_SYMLINK_TARGET")
    return files


def main():
    parser = argparse.ArgumentParser()
    for name in ("repository", "target", "requests", "checks", "builds", "evidence"):
        parser.add_argument("--" + name, type=Path, required=True)
    a = parser.parse_args()
    check(all(value.is_absolute() for value in vars(a).values()), "Z4_ABSOLUTE_DELIVERY_PATHS_REQUIRED")
    check(a.evidence.resolve().is_relative_to((a.repository / "scope-z/phase-evidence/z4").resolve()),
          "Z4_OWNED_DELIVERY_PATH_REQUIRED")
    a.evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = {"schema": "finnor.z4.engineering-delivery.v1", "status": "PACKAGING",
              "nativeAuthenticatedSource": "NOT_RUN", "nativeAuthenticatedInstalled": "NOT_RUN",
              "protectedAdmission": "NOT_RUN", "financialQualification": "NOT_RUN",
              "coordinatorAcceptance": "NOT_ACCEPTED_BY_THIS_BUNDLE", "eligibleReuseN": 0}
    try:
        checks = json.loads((a.checks / "report.json").read_text())
        builds = json.loads((a.builds / "report.json").read_text())
        check(checks["status"] == "PASSED_ISOLATED_PRODUCT_SOURCE_CHECKS_ONLY" and
              builds["status"] == "PASSED_ISOLATED_INSTALLED_PRODUCT_BUILDS_ONLY" and
              checks["sourceUnchanged"] and builds["sourceUnchanged"], "Z4_FINAL_ENGINEERING_CHECKS_REQUIRED")
        check(checks["sourceDigest"] == builds["sourceDigest"], "Z4_CHECK_BUILD_SOURCE_POPULATION_MISMATCH")
        for item in builds["source"]:
            check(sha(a.target / item["path"]) == item["sha256"], "Z4_FINAL_INSTALLED_SOURCE_DRIFT")
        owned = R["owned_inventory"](a.repository)
        staged = {f["path"]: f["sha256"] for f in R["owned_inventory"](a.target)}
        check(set(staged) == {f["path"] for f in owned} and all(staged.get(f["path"]) == f["sha256"] for f in owned
                  if f["path"] != NATIVE + "/build-identity.json"), "Z4_FINAL_OWNED_SOURCE_DRIFT")
        requests = json.loads((a.requests / "manifest.json").read_text())
        check(sha(a.requests / "combined.patch") == requests["combinedPatchSha256"] and
              sha(HERE / "shared-requests.py") == requests["generatorSha256"],
              "Z4_FINAL_SHARED_REQUEST_IDENTITY")
        for item in requests["requests"]:
            file = a.repository / item["path"]
            check(not file.exists() if item["requiresAbsent"] else sha(file) == item["preimageSha256"],
                  "Z4_LIVE_SHARED_PREIMAGE_CHANGED")
        metadata = {}
        for name, rel in {
            "core-stage.json": "stage-report.json",
            "source-lineage.json": "z4-reconstruction-source.json",
            "source-paths.json": "z4-source-paths.json",
            "runtime-toolchain.json": ".z4-toolchains/receipt.json",
            "rust-toolchain.json": NATIVE + "/.toolchain/reconstruction-receipt.json",
        }.items():
            source = a.target / rel
            check(source.is_file(), "Z4_DELIVERY_REQUIRED_METADATA_MISSING")
            shutil.copyfile(source, a.evidence / name)
            os.chmod(a.evidence / name, 0o600)
            metadata[name] = sha(source)
        report["metadataSha256"] = metadata
        source_members = manifest(a.repository, {f["path"] for f in owned} |
                                  {NATIVE + "/bin/z4-proof", NATIVE + "/bin/z4-field-falsifier"})
        save(a.evidence / "source-manifest.json", source_members)
        report["sourceArchive"] = archive(a.repository, a.evidence / "owned-source.tar.gz", source_members)
        patch = []
        for item in owned:
            rel = item["path"]
            prior = subprocess.run(["git", "-C", str(a.repository), "show", requests["baseCommit"] + ":" + rel],
                                   capture_output=True)
            before = prior.stdout.decode() if prior.returncode == 0 else ""
            after = (a.repository / rel).read_text()
            patch.append("".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                                    fromfile="a/" + rel if before else "/dev/null", tofile="b/" + rel)))
        (a.evidence / "owned-source.patch").write_text("".join(patch))
        report["ownedSourcePatchSha256"] = sha(a.evidence / "owned-source.patch")
        installed_members = manifest(a.target, installed_files(a.target))
        save(a.evidence / "installed-manifest.json", installed_members)
        report["installedArchive"] = archive(a.target, a.evidence / "installed-product.tar.gz", installed_members)
        phase = a.repository / "scope-z/phase-evidence/z4"
        evidence_members = manifest(phase, evidence_files(phase, a.evidence, a.target))
        save(a.evidence / "evidence-manifest.json", evidence_members)
        report["evidenceArchive"] = archive(phase, a.evidence / "evidence.tar.gz", evidence_members)
        report.update(
            status="PACKAGED_ENGINEERING_ONLY_AWAITING_COORDINATOR",
            sourceCommit=R["git"](a.repository, "rev-parse", "HEAD"),
            sourceTree=R["git"](a.repository, "rev-parse", "HEAD^{tree}"),
            sourceBaseCommit=requests["baseCommit"], sharedPatchSha256=requests["combinedPatchSha256"],
            ownedSourceDigest=R["digest_bytes"](R["canonical"](owned)),
            checkedInstalledSourceDigest=builds["sourceDigest"], buildIds=builds["buildIds"],
            checkReportSha256=sha(a.checks / "report.json"), buildReportSha256=sha(a.builds / "report.json"),
            sourceNativeIdentity=json.loads((a.repository / NATIVE / "build-identity.json").read_text()),
            installedNativeIdentity=json.loads((a.target / NATIVE / "build-identity.json").read_text()),
            liveSharedFilesWritten=0,
        )
        save(a.evidence / "report.json", report)
        print(json.dumps({k: report[k] for k in ("status", "sourceCommit", "sourceTree", "ownedSourceDigest",
                                                "sharedPatchSha256", "coordinatorAcceptance")}))
        return 0
    except Exception as error:
        report.update(status="FAILED_DELIVERY_NOT_ACCEPTED", failure=str(error))
        save(a.evidence / "report.json", report)
        print(json.dumps({"status": report["status"], "failure": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
