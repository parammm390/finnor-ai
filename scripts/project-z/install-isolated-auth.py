"""Install or independently verify the exact official, pinned local Auth release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PIN = json.loads((ROOT / "infra/deployment/project-z-verification-toolchain.json").read_text())["supabaseAuth"]


def members(archive):
    found = archive.getmembers()
    assert len(found) == 78, "OFFICIAL_AUTH_ARCHIVE_MEMBER_COUNT"
    files = []
    for member in found:
        name = member.name
        assert not Path(name).is_absolute() and ".." not in Path(name).parts
        if member.isdir():
            assert name == "migrations"
        elif member.issym():
            assert name == "gotrue" and member.linkname == "auth"
        else:
            assert member.isfile(), "NONREGULAR_AUTH_ARCHIVE_MEMBER"
            assert name == "auth" or re.fullmatch(r"migrations/[a-zA-Z0-9_.-]+\.sql", name)
            files.append(member)
    assert len(files) == 76 and sum(row.name.startswith("migrations/") for row in files) == 75
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    target = args.target
    assert target.is_absolute() and target.parent.resolve() == target.parent
    assert sys.platform == "linux" and platform.machine() == "x86_64"
    if not args.verify_only:
        target.mkdir(mode=0o700, exist_ok=False)
        source = args.archive.open("rb") if args.archive else urllib.request.urlopen(PIN["url"], timeout=60)
        with source, (target / "auth.tar.xz").open("xb") as out:
            os.chmod(out.name, 0o600)
            count = 0
            while chunk := source.read(65536):
                count += len(chunk)
                assert count <= PIN["archiveBytes"], "AUTH_ARCHIVE_SIZE_BOUND"
                out.write(chunk)
    archive_path = target / "auth.tar.xz"
    assert archive_path.stat().st_size == PIN["archiveBytes"]
    assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == PIN["archiveSha256"]
    with tarfile.open(archive_path, "r:xz") as archive:
        files = members(archive)
        if not args.verify_only:
            (target / "migrations").mkdir(mode=0o700)
        for member in files:
            content = archive.extractfile(member).read()
            destination = target / member.name
            if args.verify_only:
                assert destination.is_file() and not destination.is_symlink()
                assert destination.read_bytes() == content, "INSTALLED_AUTH_BYTES_DIFFER_FROM_PINNED_ARCHIVE"
            else:
                with destination.open("xb") as out:
                    os.chmod(out.name, 0o500 if member.name == "auth" else 0o400)
                    out.write(content)
    receipt = {"schema": "finnor.project-z.pinned-auth-install.v1", "status": "PASS",
               "version": PIN["version"], "sourceCommit": PIN["sourceCommit"],
               "archiveSha256": PIN["archiveSha256"], "regularFilesByteVerified": len(files),
               "symlinkExtracted": False, "verifyOnly": args.verify_only,
               "download": "NOT_RUN_RETAINED_ARCHIVE" if args.archive or args.verify_only else "PINNED_HTTPS_GET"}
    if not args.verify_only:
        with (target / "installation.json").open("x") as out:
            os.chmod(out.name, 0o600)
            out.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("PINNED_AUTH_INSTALL_OR_VERIFICATION_FAILED_RETAIN_FILES", file=sys.stderr)
        sys.exit(1)
