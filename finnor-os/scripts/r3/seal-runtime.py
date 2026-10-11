"""Create a byte-bound LOCAL or final-image runtime manifest, never admission."""
import argparse
import base64
import csv
import hashlib
import importlib.metadata
import json
import os
import pathlib
import platform
import sys
import sysconfig

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--scip-license", required=True)
args = parser.parse_args()
if os.getuid() == 0:
    raise SystemExit("R3_NON_ROOT_RUNTIME_REQUIRED")
files = {}
licenses = []
for name, version, license_name in [("pyscipopt", "6.0.0", "MIT"), ("numpy", "2.2.6", "BSD-3-Clause and bundled notices")]:
    distribution = importlib.metadata.distribution(name)
    if distribution.version != version:
        raise SystemExit("R3_LOCKED_DISTRIBUTION_VERSION_MISMATCH")
    for entry in distribution.files:
        path = pathlib.Path(distribution.locate_file(entry)).resolve()
        if path.suffix == ".pyc" or not path.is_file():
            continue
        raw = path.read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        if entry.hash and entry.hash.mode == "sha256":
            actual = base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
            if actual != entry.hash.value:
                raise SystemExit("R3_INSTALLED_RECORD_INTEGRITY_MISMATCH")
        files[str(path)] = sha
        if path.name in ("LICENSE", "LICENSE.txt"):
            licenses.append({"component": name, "license": license_name, "source": str(path), "evidenceDigest": sha})
executable = pathlib.Path(sys.executable).resolve()
files[str(executable)] = hashlib.sha256(executable.read_bytes()).hexdigest()
for name in ("fractions", "json", "hashlib", "resource", "decimal", "math", "itertools"):
    module = __import__(name)
    if getattr(module, "__file__", None):
        path = pathlib.Path(module.__file__).resolve()
        files[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
libdir = sysconfig.get_config_var("LIBDIR")
library = sysconfig.get_config_var("LDLIBRARY")
if libdir and library:
    path = pathlib.Path(libdir) / library
    if path.is_file():
        path = path.resolve()
        files[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
scip_license = pathlib.Path(args.scip_license).resolve()
licenses.append({"component": "SCIP 10.0.0", "license": "Apache-2.0", "source": str(scip_license),
                 "evidenceDigest": hashlib.sha256(scip_license.read_bytes()).hexdigest()})
licenses.append({"component": "GCC libgcc/libgfortran/libquadmath (wheel libraries)", "license": "GPL-3.0 with GCC Runtime Library Exception; retain bundled NumPy notices",
                 "source": "numpy-2.2.6.dist-info/LICENSE.txt", "evidenceDigest": next(v["evidenceDigest"] for v in licenses if v["component"] == "numpy")})
import pyscipopt
model = pyscipopt.Model()
version = "%s.%s.%s" % (model.getMajorVersion(), model.getMinorVersion(), model.getTechVersion())
if version != "10.0.0" or "exact/enable" in model.getParams():
    raise SystemExit("R3_REGISTERED_NUMERICAL_RUNTIME_CHANGED")
manifest = {"schema": "finnor.r3.native-runtime.v1", "python": str(pathlib.Path(sys.executable).absolute()),
            "pythonVersion": platform.python_version(), "scipVersion": version, "pyscipoptVersion": "6.0.0", "numpyVersion": "2.2.6",
            "platform": sys.platform, "architecture": platform.machine(),
            "files": [{"path": path, "sha256": sha} for path, sha in sorted(files.items())], "licenseInventory": licenses,
            "exactMode": "NOT_AVAILABLE_FLOAT64_PROPOSALS_ONLY"}
output = pathlib.Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"runtimeManifest": str(output), "files": len(files), "scip": version, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                  "qualification": "OBSERVED_INSTALLED_BYTES_NOT_S8_ADMISSION_OR_SCIP_SOURCE_BUILD_PROOF"}))
