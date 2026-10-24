"""New task-owned runtime paths; no checkout edits and no asset deletion."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--backend", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--programs", type=Path, required=True)
args = parser.parse_args()
os.umask(0o077)
source = args.backend.resolve(strict=True)
target, programs = args.output.resolve(), args.programs.resolve()
if not all(p.is_absolute() for p in (args.backend, args.output, args.programs)) or target.exists() or programs.exists():
    raise ValueError("UNUSED_ABSOLUTE_TASK_PATHS_REQUIRED")
assets = Path(__file__).resolve().parents[2] / "packages/private-equity/src/confidential-computation"
identity = json.loads((assets / "backend-identity.json").read_text())
files = {name: identity[name] for name in ("mascot-party.x", "libSPDZ.so",
         "local/lib/liblibOTe.a", "local/lib/libcryptoTools.a")}
files.update(identity["compilerFiles"])
files.update({"local/runtime-libs/" + name: value for name, value in identity["runtimeLibraries"].items()})
target.mkdir(mode=0o700, parents=True)
programs.mkdir(mode=0o700, parents=True)
for name, expected in files.items():
    original = (source / name).resolve(strict=True)
    if hashlib.sha256(original.read_bytes()).hexdigest() != expected:
        raise ValueError("PINNED_SOURCE_BYTES_REQUIRED")
    output = target / name
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.link(original, output)
for name in ("Bytecode", "Circuits", "Functions", "Public-Input", "Schedules", "Source"):
    (programs / name).mkdir(mode=0o700)
circuit = source / "Programs/Circuits/sha256.txt"
if hashlib.sha256(circuit.read_bytes()).hexdigest() != identity["Programs/Circuits/sha256.txt"]:
    raise ValueError("PINNED_CIRCUIT_REQUIRED")
shutil.copyfile(circuit, programs / "Circuits/sha256.txt")
(target / "Programs").symlink_to(programs, target_is_directory=True)
print(json.dumps({"backend": str(target), "programs": str(programs), "files": len(files),
                  "materialization": "TASK_LOCAL_HARDLINKS_NOT_INDEPENDENT", "protectedAdmission": False}))
