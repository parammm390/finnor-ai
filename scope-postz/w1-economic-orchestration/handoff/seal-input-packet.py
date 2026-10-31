"""Seal source and retained evidence; never display shield-blocked evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("plan", type=Path)
parser.add_argument("source_inputs", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--generated", action="append", default=[], metavar="LABEL=ABSOLUTE_PATH")
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
scope = root / "scope-postz/w1-economic-orchestration"
assert args.output.is_absolute() and not args.output.exists()
args.output = args.output.parent.resolve(strict=True) / args.output.name
assert not args.output.is_relative_to(root.resolve(strict=True)), "CANONICAL_PACKET_MUST_BE_OUTSIDE_SOURCE"
args.plan = args.plan.resolve(strict=True)
args.source_inputs = args.source_inputs.resolve(strict=True)
plan = json.loads(args.plan.read_text())
global_floor = plan["limits"]["globalDiskFloorBytes"]
seal_forecast = next(stage["forecastBytes"] for stage in plan["stages"] if stage["id"] == "seal")
assert global_floor >= 3 * 1024 ** 3
assert shutil.disk_usage(args.output.parent).free >= global_floor + seal_forecast, "FROZEN_SEAL_CAPACITY_UNAVAILABLE"
args.output.mkdir(mode=0o700)
started = time.monotonic()
inputs = json.loads(args.source_inputs.read_text())
assets = {}


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def add(name, path, boundary):
    assert not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts
    assert name not in assets, "DUPLICATE_ARCHIVE_MEMBER"
    assert path.resolve(strict=True).is_relative_to(boundary.resolve(strict=True)), "ARCHIVE_PATH_ESCAPE"
    if path.is_dir() and not path.is_symlink():
        for child in sorted(path.iterdir()):
            add(name + "/" + child.name, child, boundary)
    else:
        assert path.is_file() or path.is_symlink(), "REGULAR_FILE_OR_INTERNAL_LINK_REQUIRED"
        assets[name] = path


manifest = {"schema": "finnor.w1.sealed-cold-input.v1", "status": "NOT_RUN",
    "sourceCommit": plan["sourceCommit"], "sourceTree": plan["sourceTree"],
    "frozenPlanSha256": sha(args.plan), "frozenPlanPath": str(args.plan.relative_to(root)),
    "reconstructionLimits": {key: plan["limits"][key] for key in ("globalDiskFloorBytes", "coldAdditionalFilesystemBytes")},
    "sourceInputsSha256": sha(args.source_inputs), "requirementsSha256": plan["requirementsSha256"],
    "createdAt": datetime.now(timezone.utc).isoformat(), "members": [],
    "coldInputNamespace": "source/", "generatedAndEvidenceAreNeverColdDependencyInputs": True,
    "costUSD": None, "admitted": False, "productionActive": False}
try:
    for pin in inputs["files"]:
        path = root / pin["path"]
        assert not path.is_symlink() and sha(path) == pin["sha256"], "CANONICAL_SOURCE_INPUT_DRIFT"
        assert not set(path.relative_to(root).parts) & {"node_modules", ".git", ".venv"}
        assert not any(part == ".env" or part.startswith(".env.") for part in path.parts)
        add("source/" + pin["path"], path, root)
    if "source/AGENTS.md" not in assets:
        add("source/AGENTS.md", root / "AGENTS.md", root)
    for pin in plan["sourceFiles"]:
        assert sha(root / pin["path"]) == pin["sha256"], "FROZEN_SOURCE_DRIFT"
        assert "source/" + pin["path"] in assets, "ALL_FROZEN_SOURCE_INPUTS_REQUIRED"
    for path, expected in plan["locks"].items():
        assert sha(root / path) == expected, "ORIGINAL_LOCK_DRIFT"
    for path in sorted(scope.rglob("*")):
        if path.is_dir():
            continue
        assert not path.is_symlink(), "W1_EVIDENCE_SYMLINK_REFUSED"
        assert "node_modules" not in path.parts and ".git" not in path.parts
        add("evidence/" + str(path.relative_to(root)), path, scope)
    governing = Path(plan["requirementsPath"])
    assert sha(governing) == plan["requirementsSha256"], "GOVERNING_REQUIREMENTS_DRIFT"
    add("governance/FINNOR-POST-Z-FRONTIER-5-PRD.md", governing, governing.parent)
    private_custody = plan["privateCustody"]
    custody_root = Path(private_custody["root"]).resolve(strict=True)
    sidecar_pin = private_custody["controlSidecar"]
    sidecar_path = Path(sidecar_pin["path"])
    assert sidecar_path.resolve(strict=True).is_relative_to(custody_root) and sha(sidecar_path) == sidecar_pin["sha256"]
    sidecar = json.loads(sidecar_path.read_text())
    assert len(sidecar["files"]) == 53 and sum(x["droidShieldFlagged"] for x in sidecar["files"]) == 11
    add("private-custody/control-sidecar.json", sidecar_path, custody_root)
    for pin in sidecar["files"]:
        relative = PurePosixPath(pin["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        source = custody_root / relative
        assert not source.is_symlink() and source.is_file() and sha(source) == pin["sha256"], "ORIGINAL_CONTROL_EVIDENCE_CHANGED"
        add("private-custody/control/" + pin["path"], source, custody_root)
    manifest["originalControlCustody"] = {"sidecarSha256": sha(sidecar_path), "allFiles": 53,
        "shieldFlaggedOriginals": 11, "bytesPrintedOrRedacted": False,
        "archivePrefix": "private-custody/control/", "neverColdDependencyInputs": True,
        "privatePacketNeverPublished": True}
    for specification in args.generated:
        label, text = specification.split("=", 1)
        path = Path(text)
        assert path.is_absolute() and label and not label.startswith("/")
        add("generated/" + label, path, path if path.is_dir() else path.parent)
    manifest["workingHeadAtSeal"] = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    packet = args.output / "cold-input.tar.gz"
    with tarfile.open(packet, "x:gz", compresslevel=6) as archive:
        for name, path in sorted(assets.items()):
            assert shutil.disk_usage(args.output).free >= global_floor, "GLOBAL_FREE_FLOOR"
            info = archive.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            if path.is_symlink():
                target = os.readlink(path)
                pin = {"path": name, "kind": "link", "target": target, "bytes": 0,
                       "sha256": hashlib.sha256(target.encode()).hexdigest()}
                archive.addfile(info)
            else:
                before = path.stat()
                # Source and evidence intentionally include some identical
                # inodes. Store independent bytes, never TAR hardlink inputs.
                info.type = tarfile.REGTYPE
                info.linkname = ""
                info.size = before.st_size
                pin = {"path": name, "kind": "file", "bytes": before.st_size,
                       "sha256": sha(path), "mode": before.st_mode & 0o777}
                with path.open("rb") as body:
                    archive.addfile(info, body)
                assert path.stat().st_mtime_ns == before.st_mtime_ns and sha(path) == pin["sha256"], "SEAL_INPUT_CHANGED"
            manifest["members"].append(pin)
    expected = {pin["path"]: pin for pin in manifest["members"]}
    observed = set()
    with tarfile.open(packet, "r:gz") as archive:
        for member in archive:
            assert member.name in expected and member.name not in observed
            observed.add(member.name)
            pin = expected[member.name]
            if pin["kind"] == "link":
                assert member.issym() and member.linkname == pin["target"]
            else:
                assert member.isfile() and member.size == pin["bytes"]
                with archive.extractfile(member) as body:
                    assert hashlib.file_digest(body, "sha256").hexdigest() == pin["sha256"], "SEALED_MEMBER_CHANGED"
    assert observed == set(expected)
    manifest.update(status="SEALED_AND_VERIFIED", packetSha256=sha(packet),
                    packetBytes=packet.stat().st_size, memberCount=len(observed))
    packet.chmod(0o444)
except Exception as error:
    manifest.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
finally:
    manifest.update(elapsedSeconds=time.monotonic() - started)
    destination = args.output / "cold-input.manifest.json"
    with destination.open("x") as stream:
        stream.write(json.dumps(manifest, indent=2) + "\n")
    destination.chmod(0o444)
    if manifest["status"] == "SEALED_AND_VERIFIED":
        checksums = args.output / "SHA256SUMS"
        checksums.write_text(
            manifest["packetSha256"] + "  cold-input.tar.gz\n" + sha(destination) + "  cold-input.manifest.json\n")
        checksums.chmod(0o444)
    print(json.dumps({key: value for key, value in manifest.items() if key != "members"}))
raise SystemExit(0 if manifest["status"] == "SEALED_AND_VERIFIED" else 1)
