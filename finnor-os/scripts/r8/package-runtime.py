"""Observe and verify the installed, explicitly pinned ordinary scientific closure.

Installation is separately reproducible from runtime-lock.json. This driver never
selects a PATH fallback. --conformance executes the exact registered Rosette DSL.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--node", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--conformance", action="store_true")
args = parser.parse_args()
root = pathlib.Path(args.root).resolve(strict=True)
output = pathlib.Path(args.output).resolve()
repo = pathlib.Path(__file__).resolve().parents[3]
python = root / "python/bin/python"
racket = root / "racket/bin/racket"
solver = root / "python/bin/z3"
node = pathlib.Path(args.node).resolve(strict=True)
user = root / "user"
env = {"PLTUSERHOME": str(user), "PLT_PKG_BUILD_SERVICE": "1", "FINNOR_R8_Z3": str(solver),
       "HOME": str(user), "LANG": "C", "TZ": "UTC"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def run(command, supplied=None):
    result = subprocess.run([str(v) for v in command], input=supplied, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60)
    if result.returncode:
        raise RuntimeError("Runtime conformance failed: " + result.stderr[-8192:])
    return result.stdout.strip()


commit = subprocess.check_output(["git", "-C", str(root / "rosette"), "rev-parse", "HEAD"], text=True).strip()
assert commit == "373c8c35e4a7667f38fce10cf0b74ae17de07f1d"
python_prefix = pathlib.Path(run([python, "-c", "import sys;print(sys.base_prefix)"])).resolve(strict=True)
inventory = []
licenses = []
for prefix in [root / "racket", root / "rosette", user, root / "python", python_prefix]:
    for path in sorted(prefix.rglob("*")):
        if not path.is_file() or path.is_symlink() or ".git" in path.parts or "__pycache__" in path.parts:
            continue
        if path.name == ".DS_Store" or path.name.endswith(".lock"):
            continue
        entry = {"path": str(path), "sha256": sha(path), "bytes": path.stat().st_size}
        inventory.append(entry)
        if any(term in path.name.lower() for term in ["license", "copyright", "copying"]):
            licenses.append({"path": entry["path"], "sha256": entry["sha256"], "name": path.name})
inventory = sorted({entry["path"]: entry for entry in inventory}.values(), key=lambda v: v["path"])
identity = {
    "schema": "finnor.r8.scientific-runtime.v1",
    "platform": "darwin" if sys.platform == "darwin" else sys.platform,
    "architecture": "arm64" if platform.machine() == "arm64" else "x64",
    "racket": {"path": str(racket), "sha256": sha(racket), "version": run([racket, "--version"])},
    "rosette": {"commit": commit, "treeDigest": hashlib.sha256(canonical(
        [v for v in inventory if str(root / "rosette") + "/" in v["path"]]).encode()).hexdigest()},
    "solver": {"path": str(solver), "sha256": sha(solver), "version": run([solver, "--version"]),
               "options": ["-smt2", "-in", ":timeout=40000", ":random-seed=0", "current-bitwidth=#f"]},
    "python": {"path": str(python), "sha256": sha(python), "version": run([python, "--version"])},
    "node": {"path": str(node), "sha256": sha(node), "version": run([node, "--version"])},
    "userHome": str(user),
    "inventoryDigest": hashlib.sha256(canonical(inventory).encode()).hexdigest(),
    "inventory": inventory, "licenses": licenses,
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(identity, indent=2) + "\n")
if args.conformance:
    examples = [{"input": [0, 0, 0, 0, 0, 0], "mask": 0},
                {"input": [1, 7, 7, 1, 0, 0], "mask": 1},
                {"input": [7, 1, 7, 0, 1, 0], "mask": 2},
                {"input": [7, 7, 1, 0, 0, 1], "mask": 4},
                {"input": [7, 7, 7, 7, 0, 0], "mask": 1}]
    began = time.monotonic()
    source = repo / "finnor-os/packages/epistemic-runtime/src/solver-synthesis/engine.rkt"
    answer = json.loads(run([racket, source], canonical(
        {"operation": "SYNTHESIZE", "enabledLimit": 7, "examples": examples})))
    assert answer["status"] == "SAT"
    verify = json.loads(run([racket, source], canonical({"operation": "VERIFY", "choices": answer["choices"]})))
    assert verify["status"] in ("COUNTEREXAMPLE", "UNSAT_ORIGINAL_D_NOT_ACCEPTANCE")
    receipt = {"schema": "finnor.r8.runtime-conformance.v1", "status": "PASS",
               "engineDigest": sha(source), "runtimeDigest": hashlib.sha256(canonical(identity).encode()).hexdigest(),
               "synthesis": answer, "verification": verify, "elapsedMs": (time.monotonic() - began) * 1000,
               "qualification": "Actual exact-integer pinned Rosette/Z3, not whole-domain acceptance or Linux isolation"}
    output.with_name("runtime-conformance.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"output": str(output), "files": len(inventory), "bytes": sum(v["bytes"] for v in inventory),
                  "licenses": len(licenses), "conformance": args.conformance}))
