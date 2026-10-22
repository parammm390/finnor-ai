"""Preserve a stopped synthetic episode; never resume it or publish private hashes."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
from pathlib import Path


def snapshot(root):
    result = {}
    for path in root.rglob("*"):
        mode = path.lstat().st_mode
        name = str(path.relative_to(root))
        if stat.S_ISLNK(mode):
            target = os.readlink(path)
            resolved = (path.parent / target).resolve(strict=False)
            program = path.name == "Programs" and resolved.is_relative_to(root)
            certificate = path.parent.name == "Player-Data" and re.fullmatch(r"[0-9a-f]{8}\.\d+", path.name) \
                and re.fullmatch(r"P[0-7]\.pem", target) and resolved.parent == path.parent \
                and stat.S_ISREG(resolved.lstat().st_mode)
            if not program and not certificate:
                raise ValueError("ONLY_OWN_SESSION_PROGRAM_LINK_ALLOWED")
            result[name] = ("link", target)
        elif stat.S_ISREG(mode):
            if "PRIVATE-NOT-FOR-HANDOFF" in path.parts and mode & 0o077:
                raise ValueError("PRIVATE_SOURCE_FILE_PERMISSIONS_REQUIRED")
            result[name] = ("file", hashlib.sha256(path.read_bytes()).hexdigest())
        elif stat.S_ISDIR(mode):
            if "PRIVATE-NOT-FOR-HANDOFF" in path.parts and mode & 0o077:
                raise ValueError("PRIVATE_SOURCE_DIRECTORY_PERMISSIONS_REQUIRED")
            result[name] = ("directory",)
        else:
            raise ValueError("REGULAR_STOPPED_EPISODE_REQUIRED")
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source, output = args.source, args.output
    match = re.fullmatch(r"finnor-y4-((?:finite|adverse)-\d{3})", source.name)
    if source.parent != Path("/dev/shm") or match is None \
            or source.resolve(strict=True) != source or not source.is_dir() \
            or output.parent != Path("/home/factory-user/y4-delivery") \
            or output.name != match[1] or output.exists() \
            or output.resolve(strict=False) != output:
        raise ValueError("OWN_FINITE_SOURCE_AND_UNUSED_PRIVATE_DELIVERY_REQUIRED")
    if source.stat().st_mode & 0o077:
        raise ValueError("PRIVATE_EPISODE_ROOT_REQUIRED")
    receipt_path = source / ("campaign.json" if output.name.startswith("finite-") else "result.json")
    campaign = json.loads(receipt_path.read_text())
    if output.name.startswith("finite-"):
        if campaign["schema"] != "finnor.y4.finite-local-engineering.v1" or campaign["protectedCases"] != 0:
            raise ValueError("STOPPED_TASK_SYNTHETIC_CAMPAIGN_REQUIRED")
    elif campaign.get("case") != "adverse" or campaign.get("protectedSubmission") is not False \
            or campaign.get("status") not in ("PASS", "FAIL") \
            or any(f.get("states") != ["ABORTED"] * 3 for f in campaign.get("faults", [])):
        raise ValueError("STOPPED_TASK_SYNTHETIC_ADVERSE_EPISODE_REQUIRED")
    before = snapshot(source)
    shutil.copytree(source, output, symlinks=True)
    # Links intentionally retain their old literal targets. Compare without
    # following them, including dangling links to disposed compiler workspaces.
    copied = {}
    for name, expected in before.items():
        path = output / name
        if expected[0] == "file":
            observed = ("file", hashlib.sha256(path.read_bytes()).hexdigest())
        elif expected[0] == "link":
            observed = ("link", os.readlink(path))
        else:
            observed = ("directory",) if path.is_dir() and not path.is_symlink() else None
        copied[name] = observed
    if copied != before or snapshot(source) != before:
        raise ValueError("SOURCE_OR_RETAINED_EPISODE_BYTES_CHANGED")
    receipt = {"schema": "finnor.y4.private-local-retention.v1", "source": str(source), "output": str(output),
               "status": "PASS", "filesLinksAndDirectoriesVerified": len(before),
               "sourceBytesAndLinkTargetsUnchanged": True, "retainedBytesAndLinkTargetsMatch": True,
               "privateStateRetainedPrivately": True, "privatePerFileHashesPublished": False,
               "sourceMovedDeletedChmoddedOrResumed": False, "independentReconstruction": False,
               "protectedCases": 0, "originalReceiptFile": receipt_path.name,
               "originalCampaignSha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest()}
    (output / "retention-custody.json").write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
