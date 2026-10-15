"""Seal an unpublished, self-contained two-commit handoff after source freeze.

Never copies private evidence, credentials, installed runtimes or peer branches.
The full-history bundle and ordered patches are verified in a new bare repository.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

BASE = "517003a4396bc8101a90be4b425ee01de9446740"
BRANCH = "codex/r3-incentive-rule-synthesis"
parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
args = parser.parse_args()
repo = pathlib.Path(args.repo).resolve()
if not pathlib.Path(args.repo).is_absolute():
    raise SystemExit("R3_ABSOLUTE_REPOSITORY_REQUIRED")
handoff = repo / "scope-r/r3-incentive-rule-synthesis/handoff"
os.umask(0o077)


def git(*arguments, cwd=repo, env=None):
    return subprocess.run(["git", "-C", str(cwd), *arguments], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env, timeout=300).stdout


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def create(path, contents):
    with path.open("xb") as stream:
        stream.write(contents)


if git("status", "--porcelain").strip():
    raise SystemExit("R3_CLEAN_SOURCE_FREEZE_REQUIRED")
if git("branch", "--show-current").decode().strip() != BRANCH:
    raise SystemExit("R3_SELECTED_BRANCH_REQUIRED")
commits = git("rev-list", "--reverse", BASE + "..HEAD").decode().splitlines()
if len(commits) != 2:
    raise SystemExit("R3_EXACTLY_TWO_REVIEWABLE_COMMIT_GROUPS_REQUIRED")
head = git("rev-parse", "HEAD").decode().strip()
tree = git("rev-parse", "HEAD^{tree}").decode().strip()
targets = [handoff / "r3-standalone.bundle", handoff / "01-r3-owned.patch",
           handoff / "02-shared-integration.patch", handoff / "release.json"]
if any(path.exists() for path in targets):
    raise SystemExit("R3_NEW_HANDOFF_OUTPUTS_REQUIRED")

for commit, path in zip(commits, targets[1:3]):
    create(path, git("format-patch", "--stdout", "-1", commit))
git("bundle", "create", str(targets[0]), "refs/heads/" + BRANCH)
targets[0].chmod(0o600)
verification = git("bundle", "verify", str(targets[0])).decode()

scratch = repo / ".r3-scratch"
scratch.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="r3-reconstruction-", dir=scratch) as directory:
    clone = pathlib.Path(directory) / "reconstruction.git"
    git("clone", "--bare", "--no-hardlinks", str(targets[0]), str(clone))
    rebuilt = git("rev-parse", "refs/heads/" + BRANCH + "^{tree}", cwd=clone).decode().strip()
    if rebuilt != tree:
        raise SystemExit("R3_STANDALONE_TREE_RECONSTRUCTION_MISMATCH")
    git("fsck", "--connectivity-only", "--no-reflogs", cwd=clone)
    # Replay both patches in a fresh index, without another full working tree.
    env = {**os.environ, "GIT_INDEX_FILE": str(pathlib.Path(directory) / "index")}
    git("read-tree", BASE + "^{tree}", cwd=clone, env=env)
    for path in targets[1:3]:
        git("apply", "--cached", "--check", str(path), cwd=clone, env=env)
        git("apply", "--cached", str(path), cwd=clone, env=env)
    if git("write-tree", cwd=clone, env=env).decode().strip() != tree:
        raise SystemExit("R3_ORDERED_PATCH_TREE_RECONSTRUCTION_MISMATCH")

manifest = {
    "schema": "finnor.r3.unpublished-release-handoff.v1",
    "baseCommit": BASE, "branch": BRANCH, "commitGroups": commits,
    "headCommit": head, "headTree": tree,
    "artifacts": [{"path": path.name, "bytes": path.stat().st_size,
                   "sha256": digest(path)} for path in targets[:3]],
    "standaloneReconstruction": "PASS", "orderedPatchReconstruction": "PASS",
    "bundleVerification": verification,
    "functionalGate": "INCOMPLETE_FINAL_LINUX_IMAGE_NOT_VERIFIED",
    "combinedR": "NOT_RUN", "S3Qualification": "UNQUALIFIED",
    "S8Admission": "NOT_RUN", "activation": "NOT_AUTHORIZED",
    "PostXGain": "NOT_RUN", "economicReleaseH2": "NOT_RUN",
    "privateEvidence": "private-evidence-index.json",
    "privateEvidenceIndexSha256": digest(handoff / "private-evidence-index.json"),
    "sourceSealSha256": digest(handoff / "source-seal.json"),
    "linuxImageDigest": None,
    "publicationPerformed": False,
}
create(targets[3], (json.dumps(manifest, indent=2) + "\n").encode())
if git("status", "--porcelain").strip():
    raise SystemExit("R3_HANDOFF_MUST_NOT_DIRTY_SEALED_SOURCE")
print(json.dumps({"head": head, "tree": tree, "handoff": str(handoff),
                  "reconstruction": "PASS", "functional": manifest["functionalGate"]}))
