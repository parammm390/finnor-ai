"""Inspect actual installed scientific bytes against the complete hash lock.

No container or production activation claim is made by this local inspection.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--python", default="/Users/paramdave/.factory/worktrees/r4-identification-plan-compiler/runtime/y0/bin/python")
parser.add_argument("--output")
parser.add_argument("--verify", action="store_true")
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parents[3]
lock = pathlib.Path(__file__).with_name("requirements.lock")
inspection = r'''
import hashlib,importlib.metadata as m,json,pathlib,sys
packages=[]
for d in sorted(m.distributions(),key=lambda d:d.metadata["Name"].lower()):
 files=[]
 for f in d.files or []:
  p=pathlib.Path(d.locate_file(f))
  if p.is_file() and not str(f).endswith(".pyc") and "__pycache__" not in str(f) and not str(f).startswith("../"):
   files.append({"path":str(f),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()})
 licenses=[str(f) for f in d.files or [] if "license" in str(f).lower() or "copying" in str(f).lower()]
 packages.append({"name":d.metadata["Name"],"version":d.version,"license":d.metadata.get("License-Expression") or d.metadata.get("License") or
                  [c for c in d.metadata.get_all("Classifier",[]) if c.startswith("License ::")],
                  "licenseFiles":licenses,"installedContentsDigest":hashlib.sha256(json.dumps(files,sort_keys=True,separators=(",",":")).encode()).hexdigest(),
                  "files":len(files)})
print(json.dumps({"python":sys.version,"executableDigest":hashlib.sha256(pathlib.Path(sys.executable).resolve().read_bytes()).hexdigest(),"packages":packages}))
'''
result = subprocess.run([args.python, "-I", "-c", inspection], text=True, capture_output=True, timeout=60)
assert result.returncode == 0, result.stderr
runtime = json.loads(result.stdout)
assert runtime["python"].startswith("3.11.15 "), runtime["python"]
normalize = lambda s: s.lower().replace("_", "-").replace(".", "-")
pins = {}
for line in lock.read_text().splitlines():
    match = re.match(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", line)
    if not match or "python_full_version >= '3.12'" in line:
        continue
    pins[normalize(match[1])] = match[2]
for package in runtime["packages"]:
    assert pins.get(normalize(package["name"])) == package["version"], package
    assert package["license"] or package["licenseFiles"], package["name"] + ": license trace missing"
source = repo / "finnor-os/packages/epistemic-runtime/src/identification-plan"
manifest = {"schema":"finnor.r4.scientific-runtime.v1","pythonPin":"3.11.15","sourceCommit":"15cfeeacf2870107560d209863fc177a5fd25b0c",
            "method":"y0-0.2.11-current-kernel-trace-v1","lockSha256":hashlib.sha256(lock.read_bytes()).hexdigest(),
            "universalLockPackages":len(pins),"installedRuntime":runtime,
            "programDigests":{name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in ["producer.py","checker.py"]},
            "checkerIndependence":"Python stdlib only, no y0/producer imports",
            "y0ReleaseWheelOrSdistHashes":["076d5bcd8c0bf0ad48b0a1ee226b3eaea85f5be9000ebd69325daf9fbdb94172","64d724307f8c9a962ffa10f1b573d8fbb7722ba8e63855874e48a0752097db74"],
            "qualification":"LOCAL_INSTALLED_BYTES_ONLY; FINAL_CONTAINER_IMAGE_NOT_RUN"}
if args.output:
    path=pathlib.Path(args.output)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(manifest,indent=2)+"\n")
else:
    print(json.dumps(manifest,indent=2))
