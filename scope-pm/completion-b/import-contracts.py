"""Import omitted baseline protocol bytes from one exact committed delivery."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--m4-source", required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
commit = "ee9018546a587cea4500b7f331c3b073a18d71c7"
receipt = []
for name in ("registration.json", "domain-claim-contract.md", "comparison-protocol.md", "business-window-registration.md"):
    relative = "scope-pm/phase-06-m4-counterexample-search/" + name
    value = subprocess.check_output(["git", "-C", str(Path(args.m4_source).resolve()), "show", commit + ":" + relative])
    target = repo / relative
    if target.exists() and target.read_bytes() != value:
        raise RuntimeError("Conflicting baseline protocol refused")
    if not target.exists():
        target.write_bytes(value)
    receipt.append({"phase": "M4", "commit": commit, "path": relative, "sha256": hashlib.sha256(value).hexdigest()})
(Path(__file__).parent / "evidence/baseline-protocol-imports.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"importedProtocols": len(receipt), "commit": commit}))
