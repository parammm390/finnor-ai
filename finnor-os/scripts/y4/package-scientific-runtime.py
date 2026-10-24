"""Offline CPython/S3/S5 dependency bytes. No pip, network or upstream rebuild."""
import argparse
import gzip
import hashlib
import importlib.metadata
import json
import os
import stat
import subprocess
import sys
import sysconfig
import tarfile
from pathlib import Path

NAMES = ("numpy", "scipy", "statsmodels", "arch", "pandas", "patsy", "packaging",
         "python-dateutil", "pytz", "tzdata", "six")
PINNED = {"numpy": "2.3.3", "scipy": "1.16.2", "statsmodels": "0.14.5", "arch": "8.0.0", "pandas": "2.3.2"}


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()



def isolated_site_directory(executable):
    probe = subprocess.run([str(executable), "-I", "-B", "-c",
        "import json,site,sys;print(json.dumps({'prefix':sys.prefix,'sites':site.getsitepackages()}))"],
        env={"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, text=True, check=True, timeout=10)
    layout = json.loads(probe.stdout)
    prefix = Path(layout["prefix"])
    if not prefix.is_absolute():
        raise ValueError("ABSOLUTE_BASE_PYTHON_PREFIX_REQUIRED")
    for directory in layout["sites"]:
        path = Path(directory)
        if path.is_absolute() and path.is_relative_to(prefix) and path != prefix and ".." not in path.parts:
            return Path("python") / path.relative_to(prefix)
    raise ValueError("CONTAINED_ISOLATED_PYTHON_SITE_DIRECTORY_REQUIRED")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if not args.output.is_absolute() or args.output.exists() or sys.version_info[:3] != (3, 12, 3):
        raise ValueError("NEW_PACKAGE_AND_PINNED_CPYTHON_REQUIRED")
    site = Path(sysconfig.get_path("purelib")).resolve(strict=True)
    stdlib = Path(sysconfig.get_path("stdlib")).resolve(strict=True)
    files = {"python/bin/python3": Path(sys.executable).resolve(strict=True)}
    package_site = isolated_site_directory(files["python/bin/python3"])
    versions, excluded = {}, []
    for name in NAMES:
        dist = importlib.metadata.distribution(name)
        versions[name] = dist.version
        if name in PINNED and dist.version != PINNED[name]:
            raise ValueError("PINNED_SCIENTIFIC_VERSION_REQUIRED")
        licensed = False
        for entry in dist.files or ():
            if Path(entry).is_absolute() or ".." in Path(entry).parts:
                excluded.append({"distribution": name, "entry": str(entry), "reason": "NON_RUNTIME_BUILD_SCRIPT"})
                continue
            path = Path(dist.locate_file(entry)).absolute()
            if not path.is_relative_to(site) or not path.is_file():
                continue
            relative = path.relative_to(site)
            if any(p in ("__pycache__", "tests", "test") for p in relative.parts) or path.suffix == ".pyc":
                continue
            if not path.resolve(strict=True).is_relative_to(site):
                raise ValueError("CONTAINED_SCIENTIFIC_DISTRIBUTION_REQUIRED")
            licensed |= any(token in path.name.lower() for token in ("license", "copying", "copyright", "notice"))
            files[str(package_site / relative)] = path
        if not licensed:
            raise ValueError("SCIENTIFIC_REDISTRIBUTION_LICENSE_REQUIRED:" + name)
    for path in stdlib.rglob("*"):
        relative = path.relative_to(stdlib)
        if any(p in ("__pycache__", "site-packages", "dist-packages", "tests", "test") or p.startswith("config-")
               for p in relative.parts) or path.suffix in (".pyc", ".a") or not path.is_file():
            continue
        files["python/lib/python3.12/" + str(relative)] = path
    license_path = Path("/usr/share/doc/python3.12/copyright")
    if not license_path.is_file():
        raise ValueError("CPYTHON_REDISTRIBUTION_LICENSE_REQUIRED")
    files["python/licenses/CPython-copyright"] = license_path
    expanded = sum(path.stat().st_size for path in files.values())
    if args.plan:
        print(json.dumps({"entries": len(files), "expandedBytes": expanded, "versions": versions,
                          "python": sys.version, "pythonBinarySha256": file_hash(files["python/bin/python3"]),
                          "isolatedSiteDirectory": str(package_site)}))
        return
    records = {}
    with args.output.open("xb") as out:
        with gzip.GzipFile(fileobj=out, mode="wb", mtime=0, compresslevel=1) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|") as tar:
                for name, path in sorted(files.items()):
                    info = tarfile.TarInfo(name)
                    info.mode, info.mtime, info.size = stat.S_IMODE(path.stat().st_mode), 0, path.stat().st_size
                    records[name] = {"kind": "file", "bytes": info.size, "mode": info.mode, "sha256": file_hash(path)}
                    with path.open("rb") as body:
                        tar.addfile(info, body)
    receipt = {"schema": "finnor.y4.offline-scientific-closure.v1", "archiveSha256": file_hash(args.output),
               "files": records, "pythonVersion": sys.version.split()[0], "versions": versions,
               "platform": sys.platform, "architecture": os.uname().machine,
               "upstreamPackagesIndependentlyRebuilt": False, "privateConfigurationIncluded": False,
               "excludedNonRuntimeEntries": excluded,
               "profile": "ISOLATED_CPYTHON_S3_AND_S5_RUNTIME_NO_PIP_OR_DISTRIBUTION_TESTS",
               "requiredHostDependencies": ["Linux x86-64 kernel", "compatible ELF loader and glibc/system libraries"]}
    with Path(str(args.output) + ".json").open("x") as out:
        json.dump(receipt, out, sort_keys=True)
        out.write("\n")
    print(json.dumps({"archive": str(args.output), "sha256": receipt["archiveSha256"], "entries": len(records),
                      "archiveBytes": args.output.stat().st_size, "expandedBytes": expanded}))


if __name__ == "__main__":
    main()
