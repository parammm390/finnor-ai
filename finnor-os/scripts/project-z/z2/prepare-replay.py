"""Reconstruct authenticated composed source, or exact unapplied proposals."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


OWNED = (
    "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions/",
    "finnor-os/packages/private-equity/src/project-z/z2-coalitions/",
    "finnor-os/packages/orchestration/src/project-z/z2-coalitions/",
    "finnor-os/scripts/project-z/z2/",
)
SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".sql",
            ".css", ".scss", ".c", ".h", ".yml", ".yaml", ".sh", ".tgz", ".wasm",
            ".svg", ".png", ".jpg", ".webp", ".woff", ".woff2", ".ico", ".txt", ".m", ".lock",
            ".cc", ".cpp", ".hh", ".hpp", ".cmake"}
MARKDOWN = {"AGENTS.md", "README.md", "THIRD_PARTY_NOTICES.md", "LICENSE.md", "LICENCE.md"}
EXPLICIT = {"scope-r/r3-incentive-rule-synthesis/verification-plan.json",
            "docs/centropy/capability-coverage.json",
            "finnor-os/scripts/project-z/z2/NATIVE-REPLAY.md"}


def relative_path(value):
    assert isinstance(value, str) and value and "\\" not in value and "\0" not in value
    path = Path(value)
    assert not path.is_absolute() and path.parts and not any(p in (".", "..") for p in value.split("/"))
    assert str(path) == value, "Z2_NONCANONICAL_SOURCE_PATH"
    return path


def selected(path):
    name = str(path)
    if any(p.startswith(".env") for p in path.parts) or \
       name.startswith("docs/centropy/evidence/") or "node_modules" in path.parts:
        return False
    runtime = (path.suffix in SUFFIXES or path.name.startswith("Dockerfile")) and \
        (name.startswith(("finnor-os/", "src/", "scripts/", "e2e/", "vendor/", "public/", "infra/")) or
         len(path.parts) == 1)
    notice = path.name in MARKDOWN and (len(path.parts) == 1 or name.startswith(("finnor-os/", "vendor/")))
    license_or_make = path.name in ("LICENSE", "LICENCE", "Makefile") and name.startswith(("finnor-os/", "vendor/"))
    return runtime or notice or license_or_make or name in EXPLICIT


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, "Z2_DUPLICATE_MANIFEST_JSON_KEY"
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--patch-dir")
    mode.add_argument("--integrated-manifest")
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    assert all(Path(v).is_absolute() for v in (args.repo, args.output,
               args.patch_dir or args.integrated_manifest)), "Z2_ABSOLUTE_SOURCE_PATHS_REQUIRED"
    repo, out = (Path(v).resolve() for v in (args.repo, args.output))
    out.relative_to(repo/"scope-z/phase-evidence/z2")
    assert not out.exists(), "Z2_NEW_RECONSTRUCTION_DIRECTORY_REQUIRED"
    actual_head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    actual_tree = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD^{tree}"], capture_output=True, text=True, check=True).stdout.strip()
    request, patch_dir, manifest, records, owned_changes = None, None, None, {}, {}
    if args.integrated_manifest:
        assert args.manifest_sha256 and re.fullmatch(r"[a-f0-9]{64}", args.manifest_sha256), "Z2_MANIFEST_HASH_REQUIRED"
        manifest_path = Path(args.integrated_manifest).resolve()
        manifest_path.relative_to(repo)
        assert sha(manifest_path) == args.manifest_sha256, "Z2_INTEGRATED_MANIFEST_HASH"
        manifest = json.loads(manifest_path.read_bytes(), object_pairs_hook=unique_object)
        assert manifest["schema"] == "finnor.project-z.remote-handover.v1"
        for record in manifest["files"]:
            path = relative_path(record["path"])
            assert str(path) not in records, "Z2_DUPLICATE_MANIFEST_SOURCE_PATH"
            assert type(record["mode"]) is int and record["mode"] in (0o644, 0o755)
            assert type(record["bytes"]) is int and record["bytes"] >= 0
            assert re.fullmatch(r"[a-f0-9]{64}", record["sha256"])
            records[str(path)] = record
        base_tree = subprocess.run(["git", "-C", str(repo), "rev-parse", manifest["sourceHead"]+"^{tree}"],
                                   capture_output=True, text=True, check=True).stdout.strip()
        assert base_tree == manifest["sourceTree"], "Z2_INTEGRATED_BASE_TREE"
        if actual_head != manifest["sourceHead"]:
            subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor",
                            manifest["sourceHead"], actual_head], check=True)
        sources = {Path(p) for p in records if selected(Path(p))}
        # The authenticated manifest, not git ls-files, owns the composed
        # untracked Z1/Z3 closure. Only Z2 may add or change source leaves.
        for prefix in OWNED:
            sources.update(p.relative_to(repo) for p in (repo/prefix).rglob("*")
                           if p.is_file() and selected(p.relative_to(repo)))
    else:
        assert args.manifest_sha256 is None, "Z2_MANIFEST_HASH_WITHOUT_MANIFEST"
        patch_dir = Path(args.patch_dir).resolve()
        request = json.loads((patch_dir/"request.json").read_bytes())
        assert actual_head == request["sourceBase"], "Z2_UNAPPLIED_REQUEST_BASE_MISMATCH"
        assert sha(patch_dir/"coordinator.patch") == request["patchSha256"]
        for record in request["files"]:
            assert sha(repo/relative_path(record["path"])) == record["preimageSha256"], record["path"]
        for path, expected in request["ownedSourceSha256"].items():
            assert sha(repo/relative_path(path)) == expected, path
        result = subprocess.run(["git", "-C", str(repo), "ls-files", "-z"], capture_output=True, check=True)
        paths = [relative_path(p.decode()) for p in result.stdout.split(b"\0") if p]
        sources = {p for p in paths if selected(p)}
        sources.update(relative_path(p) for p in request["ownedSourceSha256"])
        sources.update(p.relative_to(repo) for p in (repo/"finnor-os/scripts/project-z/z2").glob("*")
                       if selected(p.relative_to(repo)))
    sources.update(Path(p) for p in EXPLICIT)
    inventory, source_modes = {}, {}
    # Validate the complete plan before creating the output or copying bytes.
    for path in sorted(sources):
        source, name = repo/path, str(path)
        assert source.resolve() == source and source.is_file() and not source.is_symlink(), name
        mode = stat.S_IMODE(source.stat().st_mode)
        assert mode in (0o644, 0o755), name
        value = sha(source)
        inventory[name], source_modes[name] = value, mode
        if manifest:
            record = records.get(name)
            matches = record and value == record["sha256"] and mode == record["mode"] and \
                source.stat().st_size == record["bytes"]
            if name.startswith(OWNED):
                if not matches:
                    owned_changes[name] = {"delivered": record, "currentSha256": value, "currentMode": mode}
            else:
                assert matches, "Z2_INTEGRATED_SHARED_PREIMAGE: "+name
    tree = out/"tree"
    tree.mkdir(parents=True)
    for path in sorted(sources):
        assert path.name != "JARVIS-CREDENTIALS-LEDGER.md"
        assert not str(path).startswith("docs/centropy/evidence/")
        source, target = repo/path, tree/path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        shutil.copymode(source, target)
        assert sha(source) == sha(target) == inventory[str(path)]
        assert stat.S_IMODE(target.stat().st_mode) == source_modes[str(path)]
    if request:
        process = subprocess.run(["git", "apply", "--check", str(patch_dir/"coordinator.patch")], cwd=tree, capture_output=True, text=True)
        (out/"patch-check.log").write_text(process.stdout+process.stderr)
        assert process.returncode == 0
        process = subprocess.run(["git", "apply", str(patch_dir/"coordinator.patch")], cwd=tree, capture_output=True, text=True)
        (out/"patch-apply.log").write_text(process.stdout+process.stderr)
        assert process.returncode == 0
        for record in request["files"]:
            assert sha(tree/record["path"]) == record["proposedPostimageSha256"], record["path"]
    coverage_path = repo/"docs/centropy/capability-coverage.json"
    coverage = json.loads(coverage_path.read_text())
    metadata = {"schema": "finnor.project-z.z2.isolated-source-build.v1", "sourceBaseCommit": actual_head,
                "baselineCoverageSha256": sha(coverage_path), "baselineIndexSourceCommit": coverage["sourceBaseCommit"],
                "executedProofIndex": coverage["executedProofIndex"], "reobservedOriginalProofs": False,
                "nativeOwnerExecuted": False, "protectedAdmission": False}
    metadata_path = tree/".z2-source-build.json"
    metadata_path.write_text(json.dumps(metadata, sort_keys=True, indent=2)+"\n")
    body = {"schema": "finnor.project-z.z2.integrated-source-reconstruction.v1", "sourceRoot": str(repo),
            "tree": str(tree), "patchSha256": request["patchSha256"] if request else None,
            "mode": "AUTHENTICATED_COMPOSED_SOURCE" if manifest else "EXACT_UNAPPLIED_PROPOSAL",
            "integratedManifestSha256": args.manifest_sha256, "sourcePreimages": inventory,
            "sourceModes": source_modes, "ownedSourceChanges": owned_changes,
            "sharedPreimagesVerified": bool(manifest), "actualOriginalSourceTree": actual_tree,
            "deliveredSourceBaseCommit": manifest["sourceHead"] if manifest else None,
            "sharedOriginalSourceModified": False, "dependencyInstall": "NOT_RUN",
            "rootMarkdownAllowlist": sorted(MARKDOWN), "credentialMetadataExcluded": True,
            "historicalOwnerProofDocumentsExcluded": True,
            "generatedBuildInputs": {".z2-source-build.json": sha(metadata_path)}, "actualOriginalSourceHead": actual_head,
            "authenticatedOwner": "NOT_RUN", "protectedAdmission": False}
    (out/"source-receipt.json").write_text(json.dumps(body, sort_keys=True, indent=2)+"\n")
    print(json.dumps({"tree": str(tree), "files": len(inventory)+1,
                      "mode": body["mode"], "ownedSourceChanges": len(owned_changes),
                      "patchSha256": body["patchSha256"]}))


if __name__ == "__main__":
    main()
