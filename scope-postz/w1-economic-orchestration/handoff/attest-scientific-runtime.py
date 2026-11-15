"""Inspect the real scientific environment and complete Python asset populations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def locked_versions(path):
    versions, hashes, current = {}, {}, None
    for raw in path.read_text().splitlines():
        line = raw.strip().removesuffix("\\").strip()
        if not line or line.startswith("#"):
            continue
        pin = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)", line)
        if pin:
            current = normalized(pin[1])
            assert current not in versions, "DUPLICATE_LOCKED_DISTRIBUTION"
            versions[current], hashes[current] = pin[2], 0
        else:
            assert current and re.fullmatch(r"--hash=sha256:[a-f0-9]{64}", line), "UNSUPPORTED_SCIENTIFIC_LOCK_ENTRY"
            hashes[current] += 1
    assert versions and all(hashes.values()), "COMPLETE_HASH_LOCK_REQUIRED"
    return versions


def asset_population(prefix, allowed):
    assets = []
    for parent, directories, files in os.walk(prefix, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            relative = path.relative_to(prefix).as_posix()
            if path.is_symlink():
                target = path.resolve(strict=True)
                assert any(target.is_relative_to(root) for root in allowed), "RUNTIME_ASSET_LINK_ESCAPE:" + relative
                assets.append({"path": relative, "kind": "link", "target": os.readlink(path)})
            elif path.is_file():
                assets.append({"path": relative, "kind": "file", "bytes": path.stat().st_size, "sha256": sha(path)})
            else:
                assert path.is_dir(), "RUNTIME_ASSET_SPECIAL_FILE:" + relative
    return sorted(assets, key=lambda row: row["path"])


PROBE = """
import importlib.metadata,json,os,platform,sys
import numpy,scipy,scipy.linalg,scipy.optimize,scipy.stats,statsmodels.api,arch,pandas
packages={}
for dist in importlib.metadata.distributions():
 name=dist.metadata["Name"]
 if name in packages: raise RuntimeError("DUPLICATE_INSTALLED_DISTRIBUTION:"+name)
 packages[name]={"version":dist.version,"metadataPath":str(dist._path)}
libraries=[]
if sys.platform=="linux":
 for line in open("/proc/self/maps"):
  fields=line.split(None,5)
  if len(fields)==6 and fields[5].strip().startswith("/"):
   path=fields[5].strip()
   if ".so" in path and path not in libraries: libraries.append(path)
print(json.dumps({"prefix":sys.prefix,"basePrefix":sys.base_prefix,"executable":sys.executable,
 "baseExecutable":sys._base_executable,"version":sys.version,"implementation":sys.implementation.name,
 "platform":sys.platform,"machine":platform.machine(),"sysPath":sys.path,"distributions":packages,
 "modules":{name:module.__file__ for name,module in [("numpy",numpy),("scipy",scipy),("arch",arch),("pandas",pandas)]},
 "observedLibraries":sorted(libraries),"bytecodeWritesDisabled":sys.dont_write_bytecode}))
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected", type=Path)
    args = parser.parse_args()
    python = args.python.absolute()
    assert python.is_absolute() and python.is_file()
    lock = args.lock.resolve(strict=True)
    output = args.output
    assert output.is_absolute() and not output.exists(), "NEW_ABSOLUTE_ATTESTATION_OUTPUT_REQUIRED"
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"schema": "finnor.w1.scientific-runtime-attestation.v1", "status": "FAIL",
              "pythonEntry": str(python), "lock": str(lock), "lockSha256": sha(lock),
              "qualification": "EXACT_PACKAGE_AND_BASE_DISTRIBUTION_ASSETS_NOT_HOST_IMAGE_OR_PROTECTED_ADMISSION"}
    try:
        expected = locked_versions(lock)
        report["lockedDistributions"] = expected
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                       "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        child = subprocess.run([str(python), "-I", "-B", "-c", PROBE], env=environment,
                               text=True, capture_output=True, timeout=30)
        report["probeExitCode"] = child.returncode
        assert child.returncode == 0, "SCIENTIFIC_RUNTIME_PROBE_FAILED:" + child.stderr[-2000:]
        identity = json.loads(child.stdout)
        report["identity"] = identity
        prefix, base = (Path(identity[key]).resolve(strict=True) for key in ("prefix", "basePrefix"))
        assert prefix != base, "REAL_ISOLATED_NUMERICAL_ENVIRONMENT_REQUIRED"
        assert identity["bytecodeWritesDisabled"] is True
        observed = {}
        for name, item in identity["distributions"].items():
            key = normalized(name)
            assert key not in observed, "DUPLICATE_NORMALIZED_DISTRIBUTION"
            observed[key] = item["version"]
            assert Path(item["metadataPath"]).resolve(strict=True).is_relative_to(prefix), "DONOR_PACKAGE_METADATA_ESCAPE"
        report["observedDistributions"] = observed
        report["distributionDifferences"] = {name: {"expected": expected.get(name), "observed": observed.get(name)}
            for name in sorted(expected.keys() | observed.keys()) if expected.get(name) != observed.get(name)}
        assert observed == expected, "EXACT_TRANSITIVE_DISTRIBUTION_POPULATION_MISMATCH"
        for path in identity["modules"].values():
            assert Path(path).resolve(strict=True).is_relative_to(prefix), "DONOR_SCIENTIFIC_MODULE_ESCAPE"
        assert Path(identity["baseExecutable"]).resolve(strict=True).is_relative_to(base), "BASE_EXECUTABLE_OUTSIDE_DISTRIBUTION"
        report["baseExecutableSha256"] = sha(Path(identity["baseExecutable"]).resolve(strict=True))
        report["baseAssets"] = asset_population(base, [base])
        report["environmentAssets"] = asset_population(prefix, [prefix, base])
        assert report["baseAssets"] and report["environmentAssets"]
        libraries = []
        for name in identity["observedLibraries"]:
            path = Path(name).resolve(strict=True)
            if not path.is_relative_to(prefix) and not path.is_relative_to(base):
                libraries.append({"path": str(path), "bytes": path.stat().st_size, "sha256": sha(path)})
        report["observedHostLibraries"] = libraries
        report["completeBaseDistributionAttestation"] = "ESTABLISHED_FOR_ENUMERATED_BASE_PREFIX"
        report["hostImageAttestation"] = "NOT_ESTABLISHED"
        if args.expected:
            previous = json.loads(args.expected.read_text())
            assert previous["status"] == "PASS"
            for key in ("lockSha256", "lockedDistributions", "observedDistributions",
                        "baseExecutableSha256", "baseAssets", "environmentAssets", "observedHostLibraries"):
                assert report[key] == previous[key], "SCIENTIFIC_RUNTIME_ASSET_DRIFT:" + key
        report["status"] = "PASS"
    except Exception as error:
        report.update(error=str(error), errorType=type(error).__name__)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": report["status"], "artifact": str(output), "sha256": sha(output),
                      "distributions": len(report.get("observedDistributions", {})),
                      "baseAssets": len(report.get("baseAssets", [])),
                      "environmentAssets": len(report.get("environmentAssets", [])),
                      "error": report.get("error"), "differences": report.get("distributionDifferences")}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
