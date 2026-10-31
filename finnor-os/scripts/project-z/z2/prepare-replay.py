"""Reconstruct source and apply exact coordinator proposals only in a new owned tree."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--patch-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    repo, patch_dir, out = (Path(v).resolve() for v in (args.repo, args.patch_dir, args.output))
    out.relative_to(repo/"scope-z/phase-evidence/z2")
    assert not out.exists()
    request = json.loads((patch_dir/"request.json").read_bytes())
    actual_head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    assert actual_head == request["sourceBase"]
    assert sha(patch_dir/"coordinator.patch") == request["patchSha256"]
    for record in request["files"]:
        assert sha(repo/record["path"]) == record["preimageSha256"], record["path"]
    for path, expected in request["ownedSourceSha256"].items():
        assert sha(repo/path) == expected, path
    result = subprocess.run(["git", "-C", str(repo), "ls-files", "-z"], capture_output=True, check=True)
    paths = [Path(p.decode()) for p in result.stdout.split(b"\0") if p]
    suffixes = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".sql",
                ".css", ".scss", ".c", ".h", ".yml", ".yaml", ".sh", ".tgz", ".wasm",
                ".svg", ".png", ".jpg", ".webp", ".woff", ".woff2", ".ico", ".txt", ".m", ".lock",
                ".cc", ".cpp", ".hh", ".hpp", ".cmake"}
    sources = {p for p in paths if (p.suffix in suffixes or p.name.startswith("Dockerfile")) and
               not any(part.startswith(".env") for part in p.parts) and
               (str(p).startswith(("finnor-os/", "src/", "scripts/", "e2e/", "vendor/", "public/", "infra/")) or len(p.parts) == 1)}
    sources.update(Path(p) for p in request["ownedSourceSha256"])
    # Never broaden root documentation into credential/user metadata. Runtime
    # source, explicit notices and the owned runbook form the declared closure.
    markdown_names = {"AGENTS.md", "README.md", "THIRD_PARTY_NOTICES.md", "LICENSE.md", "LICENCE.md"}
    sources.update(p for p in paths if p.name in markdown_names and
                   (len(p.parts) == 1 or str(p).startswith(("finnor-os/", "vendor/"))))
    # Existing worker-image COPY/runtime declarations, not new phase authority.
    sources.add(Path("scope-r/r3-incentive-rule-synthesis/verification-plan.json"))
    sources.add(Path("docs/centropy/capability-coverage.json"))
    sources.update(p for p in paths if p.name in ("LICENSE", "LICENCE", "Makefile") and
                   str(p).startswith(("finnor-os/", "vendor/")))
    # All current replay drivers, including those added after a historical packet.
    sources.update(p.relative_to(repo) for p in (repo/"finnor-os/scripts/project-z/z2").glob("*") if p.suffix in suffixes)
    tree = out/"tree"
    tree.mkdir(parents=True)
    inventory = {}
    for path in sorted(sources):
        assert path.name != "JARVIS-CREDENTIALS-LEDGER.md"
        assert not str(path).startswith("docs/centropy/evidence/")
        source, target = repo/path, tree/path
        assert source.is_file() and not source.is_symlink()
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        shutil.copymode(source, target)
        inventory[str(path)] = sha(source)
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
            "tree": str(tree), "patchSha256": request["patchSha256"], "sourcePreimages": inventory,
            "sharedOriginalSourceModified": False, "dependencyInstall": "NOT_RUN",
            "rootMarkdownAllowlist": sorted(markdown_names), "credentialMetadataExcluded": True,
            "historicalOwnerProofDocumentsExcluded": True,
            "generatedBuildInputs": {".z2-source-build.json": sha(metadata_path)}, "actualOriginalSourceHead": actual_head,
            "authenticatedOwner": "NOT_RUN", "protectedAdmission": False}
    (out/"source-receipt.json").write_text(json.dumps(body, sort_keys=True, indent=2)+"\n")
    print(json.dumps({"tree": str(tree), "files": len(inventory)+1, "patchSha256": request["patchSha256"]}))


if __name__ == "__main__":
    main()
