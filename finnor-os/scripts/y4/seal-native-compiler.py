"""Record reviewed upstream compiler bytes, never repin a modified checkout."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--backend", type=Path, required=True)
parser.add_argument("--receipt", type=Path, required=True)
args = parser.parse_args()
root = args.backend.resolve(strict=True)
assets = Path(__file__).resolve().parents[2] / "packages/private-equity/src/confidential-computation"
profile = json.loads((assets / "profile.json").read_text())
revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if revision != profile["backend"]["revision"]:
    raise ValueError("EXACT_UPSTREAM_COMPILER_REVISION_REQUIRED")
tracked = set(subprocess.check_output(
    ["git", "-C", str(root), "ls-files", "--", "compile.py", "setup.py", "Compiler"], text=True).splitlines())
paths = sorted([*root.glob("*.py"), *(root / "Compiler").rglob("*.py")])
names = [str(p.relative_to(root)) for p in paths]
if not set(names).issubset(tracked):
    raise ValueError("UNREVIEWED_COMPILER_SOURCE_NOT_ADMITTED")
subprocess.run(["git", "-C", str(root), "diff", "--exit-code", "HEAD", "--", *names], check=True,
               stdout=subprocess.DEVNULL)
files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}
identity_path = assets / "backend-identity.json"
identity = json.loads(identity_path.read_text())
identity["compilerFiles"] = files
receipt = {"schema": "finnor.y4.native-compiler-closure.v1", "upstreamRevision": revision,
           "compilerFiles": files, "sourceCount": len(files), "reviewedTrackedSourceUnchanged": True,
           "protectedAdmission": False}
with args.receipt.open("x") as output:
    output.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
identity_path.write_text(json.dumps(identity, indent=2) + "\n")
print(json.dumps({"compilerSourceCount": len(files), "upstreamRevision": revision,
                  "receipt": str(args.receipt), "protectedAdmission": False}))
