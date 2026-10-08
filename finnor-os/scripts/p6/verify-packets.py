"""Validate review packets and exact shared preimages, without owner activation."""
import hashlib
import json
import pathlib
import subprocess
import sys

repo = pathlib.Path(sys.argv[1]).resolve(strict=True)
output = pathlib.Path(sys.argv[2])
if not pathlib.Path(sys.argv[1]).is_absolute() or not output.is_absolute():
    raise SystemExit("Absolute repository and fresh receipt required")
phase = repo / "scope-pm/phase-12-p6-procedure-induction"
request = json.loads((phase / "handoff/independent-gate-p6.request.json").read_text())
assert request["currentGate"] == "UNQUALIFIED"
assert request["authority"] == {
    "signature": None, "admission": None,
    "evaluatorAuthorityGranted": False, "economicCreditGranted": False,
}
assert request["splitPlan"]["sampleSize"] is None
assert request["splitPlan"]["gainThreshold"] is None
assert request["costAccounting"]["realReuseHorizon"] is None
assert request["resources"]["humanSecondsPerEpisode"] == 900
assert request["resources"]["normalizedCapitalAndResourceCap"] == 1
assert request["resources"]["computeDataIntegrationDollarsPerEpisode"] == 100
policies = json.loads((phase / "rights-and-splits.json").read_text())
assert not any(s.get("independentlyControlled") for s in policies["splits"])
patches = []
for name in ["native", "generated"]:
    manifest = json.loads((phase / f"handoff/shared-{name}-preimages.json").read_text())
    patch = phase / f"handoff/shared-{name}.exact-c.patch"
    assert hashlib.sha256(patch.read_bytes()).hexdigest() == manifest["patchDigest"]
    for pin in manifest["files"]:
        original = subprocess.check_output(["git", "-C", str(repo), "show",
                                             manifest["base"] + ":" + pin["path"]])
        assert hashlib.sha256(original).hexdigest() == pin["preimage"], pin["path"]
    subprocess.run(["git", "-C", str(repo), "apply", "--check", str(patch)], check=True)
    patches.append({"name": name, "digest": manifest["patchDigest"], "files": len(manifest["files"])})
assert "schema.proposed.sql" not in subprocess.check_output([
    "git", "-C", str(repo), "ls-tree", "-r", "--name-only",
    request["frozenSource"]["restrictedBaseCommit"], "--", "finnor-os/packages/db/migrations",
]).decode()
output.parent.mkdir(parents=True, exist_ok=True)
with output.open("x") as file:
    json.dump({"schema": "finnor.p6.review-packet-validation.v1", "status": "PASS",
               "patches": patches, "authorityGranted": False, "protectedActivation": False,
               "qualification": "DETERMINISTIC_PACKET_AND_PREIMAGE_CHECK_NOT_OWNER_APPROVAL_OR_GATE"}, file, indent=2)
    file.write("\n")
print(json.dumps({"status": "PASS", "patches": patches, "authorityGranted": False}))
