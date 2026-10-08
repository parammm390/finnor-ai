"""Lossless, exclusive M3 run packaging with independent member verification."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import tarfile


ROOT = Path(__file__).resolve().parents[3]
PHASE = ROOT / "scope-pm/phase-05-m3-capital-program"
RAW = PHASE / "scope-evidence"


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def summary(directory):
    for name in ("receipt.json", "results.json", "run-manifest.json", "vitest-results.json"):
        path = directory / name
        if not path.exists():
            continue
        try:
            value = json.loads(path.read_bytes())
        except json.JSONDecodeError:
            return {
                "receipt": str(path.relative_to(ROOT)),
                "sha256": digest(path),
                "reportedStatus": "MALFORMED_RESULT_RECEIPT",
                "counts": None,
                "qualification": "Original bytes retained; interrupted receipt is not a passing run",
            }
        cases = value.get("cases", value.get("results", []))
        checks = value.get("checks", [])
        counts = value.get("counts")
        if counts is None and cases:
            counts = {
                "total": len(cases),
                "passed": sum(row.get("status") == "PASS" for row in cases),
                "notPassed": sum(row.get("status") != "PASS" for row in cases),
            }
        elif counts is None and checks:
            def check_passed(row):
                return row["status"] == "PASS" if "status" in row else row.get("pass") is True

            counts = {
                "total": len(checks),
                "passed": sum(check_passed(row) for row in checks),
                "notPassed": sum(not check_passed(row) for row in checks),
            }
        elif counts is None and "numTotalTests" in value:
            counts = {
                "total": value["numTotalTests"],
                "passed": value["numPassedTests"],
                "failed": value["numFailedTests"],
                "pending": value["numPendingTests"],
            }
        return {
            "receipt": str(path.relative_to(ROOT)),
            "sha256": digest(path),
            "selection": value.get("selection"),
            "excludedCases": value.get("excludedCases", []),
            "unmatchedSelection": value.get("unmatchedSelection", []),
            "counts": counts,
            "reportedStatus": value.get("status"),
            "caseStatuses": [{"id": row.get("id"), "status": row.get("status")} for row in cases],
            "qualification": value.get("qualification"),
            "sourceIdentity": value.get("sourceIdentity"),
            "startedAt": value.get("startedAt"),
            "finishedAt": value.get("finishedAt"),
        }
    return {"reportedStatus": "NO_TERMINAL_RESULT_RECEIPT", "counts": None}


def verify(archive, records):
    expected = {row["path"]: row for row in records}
    seen = set()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = PurePosixPath(member.name)
            if (
                not member.isfile()
                or name.is_absolute()
                or ".." in name.parts
                or member.name not in expected
                or member.name in seen
            ):
                raise ValueError("Unsafe, duplicate or unregistered archive member")
            row = expected[member.name]
            hasher = hashlib.sha256()
            stream = bundle.extractfile(member)
            if stream is None:
                raise ValueError("Missing archive member stream")
            with stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    hasher.update(block)
            if member.size != row["bytes"] or hasher.hexdigest() != row["sha256"] or member.mode != row["mode"]:
                raise ValueError("Archived member identity mismatch: " + member.name)
            seen.add(member.name)
    if seen != set(expected):
        raise ValueError("Archive omitted an original evidence file")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="New absolute packaging directory")
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or output.parent != PHASE / "evidence-archives":
        parser.error("Use a new directory immediately under the phase's evidence-archives")
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    runs = []
    raw_bytes = 0
    for directory in sorted(path for path in RAW.iterdir() if path.is_dir() or path.is_symlink()):
        if directory.is_symlink():
            raise ValueError("Evidence directory is a symbolic link")
        files = []
        for path in sorted(directory.rglob("*")):
            metadata = path.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError("Nonregular evidence entry: " + str(path))
            files.append({
                "path": str(path.relative_to(ROOT)),
                "bytes": metadata.st_size,
                "mode": stat.S_IMODE(metadata.st_mode),
                "sha256": digest(path),
            })
        archive = output / (directory.name + ".tar.gz")
        with archive.open("xb") as stream:
            archive.chmod(0o600)
            with gzip.GzipFile(filename="", mode="wb", fileobj=stream, compresslevel=6, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as bundle:
                    for row in files:
                        path = ROOT / row["path"]
                        if digest(path) != row["sha256"] or path.stat().st_size != row["bytes"]:
                            raise ValueError("Original evidence changed during packaging")
                        metadata = bundle.gettarinfo(str(path), arcname=row["path"])
                        metadata.uid = metadata.gid = 0
                        metadata.uname = metadata.gname = ""
                        metadata.mtime = 0
                        with path.open("rb") as source:
                            bundle.addfile(metadata, source)
        verify(archive, files)
        if any(digest(ROOT / row["path"]) != row["sha256"] for row in files):
            raise ValueError("Original evidence changed after packaging")
        raw_bytes += sum(row["bytes"] for row in files)
        manifest = {
            "schema": "finnor.m3.lossless-run-archive.v1",
            "originalDirectory": str(directory.relative_to(ROOT)),
            "observed": summary(directory),
            "archive": str(archive.relative_to(ROOT)),
            "archiveSha256": digest(archive),
            "archiveBytes": archive.stat().st_size,
            "files": files,
            "memberVerification": "PASS",
            "originalBytesPreserved": True,
        }
        manifest_path = output / (directory.name + ".manifest.json")
        with manifest_path.open("x") as stream:
            json.dump(manifest, stream, indent=2)
            stream.write("\n")
        manifest_path.chmod(0o600)
        runs.append({
            "originalDirectory": manifest["originalDirectory"],
            "archive": manifest["archive"],
            "archiveSha256": manifest["archiveSha256"],
            "archiveBytes": manifest["archiveBytes"],
            "manifest": str(manifest_path.relative_to(ROOT)),
            "manifestSha256": digest(manifest_path),
            "observed": {key: value for key, value in manifest["observed"].items() if key != "sourceIdentity"},
        })
    result = {
        "schema": "finnor.m3.lossless-evidence-package.v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "packagingSourceSha256": digest(Path(__file__)),
        "qualification": "LOCAL_LOSSLESS_RECONSTRUCTION_NOT_NEW_ECONOMIC_OR_INDEPENDENT_GATE",
        "runs": runs,
        "verifiedRunCount": len(runs),
        "rawBytes": raw_bytes,
        "archiveBytes": sum(row["archiveBytes"] for row in runs),
        "rawEvidenceDeleted": False,
    }
    index = output / "package-index.json"
    with index.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    index.chmod(0o600)
    print(json.dumps({"output": str(index), "verifiedRuns": len(runs), "archiveBytes": result["archiveBytes"]}))


if __name__ == "__main__":
    main()
