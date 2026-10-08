"""Pin and independently reconstruct owned/shared exact-C integration bytes."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

repo = pathlib.Path(sys.argv[1]).resolve(strict=True)
output = pathlib.Path(sys.argv[2])
if not pathlib.Path(sys.argv[1]).is_absolute() or not output.is_absolute():
    raise SystemExit("Absolute repository and fresh delivery directory required")
base = "a72b4f402cfa1bbf51e518891db2d893b9a71aca"
phase = repo / "scope-pm/phase-12-p6-procedure-induction"
owned = ["finnor-os/packages/private-equity/src/procedure-induction",
         "finnor-os/scripts/p6", "scope-pm/phase-12-p6-procedure-induction",
         "src/components/centropy/canvas/ProcedureInductionPanel.tsx"]
output.mkdir()

def git(*args, env=None):
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)

commit = git("rev-parse", "HEAD").decode().strip()
tree = git("rev-parse", "HEAD^{tree}").decode().strip()
assert commit != base
assert not git("status", "--porcelain", "--", *owned), "Owned source must be committed and clean"
paths = git("diff", "--name-only", base, commit).decode().splitlines()
assert all(any(p == root or p.startswith(root + "/") for root in owned) for p in paths)
patch = output / "owned.exact-c.patch"
patch.write_bytes(git("diff", "--binary", "--full-index", base, commit, "--", *owned))
bundle = output / "owned.bundle"
git("bundle", "create", str(bundle), "HEAD", "^" + base)
bundle_heads = git("bundle", "list-heads", str(bundle)).decode().splitlines()
assert bundle_heads == [commit + " HEAD"], "Bundle must advertise the exact owned HEAD"
shared = [phase / f"handoff/shared-{name}.exact-c.patch" for name in ["native", "generated"]]
proposal_pins = []
for name, proposal in zip(["native", "generated"], shared):
    preimages = phase / f"handoff/shared-{name}-preimages.json"
    metadata = json.loads(preimages.read_bytes())
    actual = hashlib.sha256(proposal.read_bytes()).hexdigest()
    assert metadata["base"] == base and actual == metadata["patchDigest"]
    shutil.copy2(proposal, output / proposal.name)
    shutil.copy2(preimages, output / preimages.name)
    proposal_pins.append({"name": proposal.name, "sha256": actual,
                          "preimages": preimages.name, "files": len(metadata["files"])})
shutil.copy2(phase / "handoff/schema.proposed.sql", output / "schema.proposed.sql")
git("bundle", "verify", str(bundle))
with tempfile.TemporaryDirectory(prefix="p6-independent-index-") as temporary:
    env = {**os.environ, "GIT_INDEX_FILE": str(pathlib.Path(temporary) / "index")}
    git("read-tree", base, env=env)
    git("apply", "--cached", str(patch), env=env)
    reconstructed = git("write-tree", env=env).decode().strip()
    assert reconstructed == tree, "Independent owned-tree reconstruction mismatch"
    for proposal in shared:
        git("apply", "--cached", str(proposal), env=env)
    integrated = git("write-tree", env=env).decode().strip()
files = []
for path in paths:
    content = git("show", commit + ":" + path)
    files.append({"path": path, "sha256": hashlib.sha256(content).hexdigest()})
manifest = {
    "schema": "finnor.p6.exact-delivery.v1",
    "base": base, "commit": commit, "tree": tree, "reconstructedOwnedTree": reconstructed,
    "proposedIntegratedTree": integrated, "integratedTreeIsSerialOwnerSuccessor": False,
    "order": ["owned.exact-c.patch", "shared-native.exact-c.patch", "shared-generated.exact-c.patch",
              "SERIAL_OWNER_ALLOCATED_FORWARD_MIGRATION"],
    "ownedPatchSha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
    "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
    "bundleHeads": bundle_heads,
    "sharedProposals": proposal_pins,
    "schemaProposalSha256": hashlib.sha256((output / "schema.proposed.sql").read_bytes()).hexdigest(),
    "files": files, "protectedActivation": False, "GateP6": "UNQUALIFIED",
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({k: manifest[k] for k in ["commit", "tree", "reconstructedOwnedTree", "proposedIntegratedTree"]}))
