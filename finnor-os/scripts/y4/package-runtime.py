"""Package closed Y4 runtime dependencies, not an unscoped npm installation."""
import argparse
import gzip
import hashlib
import json
import os
import stat
import tarfile
from pathlib import Path


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def slot(path):
    parts = path.parts
    return Path(*parts[:2] if parts[0].startswith("@") else parts[:1])


def packages(root, initial):
    """Retain actual npm slots and nested versions, never flatten aliases."""
    selected, visited, pending = set(), set(), [root / name for name in initial]
    while pending:
        package = pending.pop()
        if package in visited:
            continue
        visited.add(package)
        resolved = package.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValueError("CONTAINED_DEPENDENCY_PACKAGE_REQUIRED")
        selected.add(slot(package.relative_to(root)))
        manifest = json.loads((resolved / "package.json").read_bytes())
        required = set(manifest.get("dependencies", {}))
        required.update(name for name in manifest.get("peerDependencies", {})
                        if not manifest.get("peerDependenciesMeta", {}).get(name, {}).get("optional"))
        children = required | set(manifest.get("optionalDependencies", {})) | set(manifest.get("peerDependencies", {}))
        for name in children:
            # Same explicit non-Next-server profile as the emitted installer.
            if name.startswith("@next/swc-") or name == "sharp":
                continue
            if not name or name.startswith("/") or ".." in Path(name).parts:
                raise ValueError("CONTAINED_NPM_PACKAGE_SLOT_REQUIRED")
            parent, found = resolved, None
            while parent.is_relative_to(root) and parent != root:
                candidate = parent / "node_modules" / name
                if (candidate / "package.json").is_file():
                    found = candidate
                    break
                parent = parent.parent
            candidate = root / name
            if found is None and (candidate / "package.json").is_file():
                found = candidate
            if found is None:
                if name in required:
                    raise ValueError("REQUIRED_RUNTIME_PACKAGE_MISSING:" + name)
            else:
                pending.append(found)
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--installation", required=True, type=Path)
    parser.add_argument("--browser-evidence", required=True, type=Path)
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if not all(p.is_absolute() for p in (args.output, args.installation, args.browser_evidence)) or args.output.exists():
        raise ValueError("NEW_ABSOLUTE_RUNTIME_PACKAGE_AND_PINNED_INPUTS_REQUIRED")
    installation = json.loads((args.installation / "installation.json").read_bytes())
    if file_hash(args.installation / "installation.json") != (args.installation / "installation.sha256").read_text().strip():
        raise ValueError("INSTALLED_DEPENDENCY_MANIFEST_CHANGED")
    roots = {
        "backend": Path("/home/factory-user/y4-tools/node-runtime/node_modules").resolve(strict=True),
        "frontend": Path("/home/factory-user/repos/finnor-postx-y4/node_modules").resolve(strict=True),
    }
    backend = {str(slot(Path(r["path"]).relative_to("runtime/node_modules")))
               for r in installation["files"] if r["path"].startswith("runtime/node_modules/")}
    backend.update(("esbuild", "@esbuild/linux-x64", "embedded-postgres", "@embedded-postgres/linux-x64"))
    browser = json.loads(args.browser_evidence.read_bytes())
    if browser.get("status") != "PASS" or not browser.get("sourceCut"):
        raise ValueError("ACTUAL_VERIFIED_BROWSER_DEPENDENCY_CUT_REQUIRED")
    frontend = set()
    for item in browser["sourceCut"]:
        path = item["path"]
        if "/node_modules/" not in path:
            continue
        relative = Path(path.split("/node_modules/", 1)[1])
        actual = roots["frontend"] / relative
        if not actual.resolve(strict=True).is_relative_to(roots["frontend"]) or file_hash(actual) != item["sha256"]:
            raise ValueError("OBSERVED_BROWSER_DEPENDENCY_CHANGED")
        frontend.add(str(slot(relative)))
    selected = {group: packages(root, backend if group == "backend" else frontend) for group, root in roots.items()}
    entries = {}
    for group, names in selected.items():
        root = roots[group]
        for name in sorted(names):
            for path in sorted((root / name).rglob("*")):
                relative = path.relative_to(root)
                if any(part in (".git", ".cache", ".npmrc", "__pycache__") or part == ".env" or part.startswith(".env.")
                       for part in relative.parts):
                    continue
                mode = path.lstat().st_mode
                if stat.S_ISDIR(mode):
                    continue
                target = group + "/" + str(relative)
                if target in entries:
                    continue
                if not stat.S_ISREG(mode) and not stat.S_ISLNK(mode):
                    raise ValueError("REGULAR_DEPENDENCY_PACKAGE_REQUIRED")
                if path.is_symlink():
                    resolved = path.resolve(strict=True)
                    if Path(os.readlink(path)).is_absolute() or not resolved.is_relative_to(root) \
                            or slot(resolved.relative_to(root)) not in names:
                        raise ValueError("ONLY_SELECTED_CONTAINED_INTERNAL_LINKS_ALLOWED")
                entries[target] = path
    expanded = sum(p.stat().st_size for p in entries.values() if not p.is_symlink())
    if args.plan:
        print(json.dumps({"entries": len(entries), "expandedBytes": expanded,
                          "packages": {k: sorted(map(str, v)) for k, v in selected.items()}}))
        return
    files = {}
    with args.output.open("xb") as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0, compresslevel=1) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|") as archive:
                for target, path in sorted(entries.items()):
                    info = tarfile.TarInfo(target)
                    info.mode, info.mtime = stat.S_IMODE(path.lstat().st_mode), 0
                    if path.is_symlink():
                        literal = os.readlink(path)
                        info.type, info.linkname = tarfile.SYMTYPE, literal
                        files[target] = {"kind": "link", "target": literal, "mode": info.mode}
                        archive.addfile(info)
                    else:
                        info.size = path.stat().st_size
                        files[target] = {"kind": "file", "bytes": info.size, "sha256": file_hash(path), "mode": info.mode}
                        with path.open("rb") as body:
                            archive.addfile(info, body)
    digest = file_hash(args.output)
    receipt = {"schema": "finnor.y4.offline-node-closure.v1", "archiveSha256": digest, "files": files,
               "profile": "Y4_EMITTED_OWNERS_AND_MOUNTED_WORLD_NOT_A_DEPLOYED_NEXT_SERVER",
               "packageSlots": {k: sorted(map(str, v)) for k, v in selected.items()},
               "installationManifestSha256": file_hash(args.installation / "installation.json"),
               "browserEvidenceSha256": file_hash(args.browser_evidence),
               "byteMaterializedOfflineInstall": True, "upstreamPackagesIndependentlyRebuilt": False,
               "externalLinksOrPrivateConfigurationIncluded": False}
    with Path(str(args.output) + ".json").open("x") as out:
        json.dump(receipt, out, sort_keys=True)
        out.write("\n")
    print(json.dumps({"archive": str(args.output), "sha256": digest, "entries": len(files),
                      "archiveBytes": args.output.stat().st_size, "expandedBytes": expanded}))


if __name__ == "__main__":
    main()
