"""Finite emitted/cold/seal stages; a build alone is never an owning PASS."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
SCOPE = ROOT / "scope-postz/w1-economic-orchestration"
HANDOFF = SCOPE / "handoff"
parser = argparse.ArgumentParser()
parser.add_argument("plan", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--stage", required=True, choices=("emitted", "cold", "seal"))
args = parser.parse_args()
plan = json.loads(args.plan.read_text())
assert args.output.is_absolute() and not args.output.exists()
args.output.mkdir(parents=True)
clock = time.monotonic()
record = {"schema": "finnor.w1.frozen-handoff-stage.v1", "status": "FAIL", "stage": args.stage,
    "startedAt": datetime.now(timezone.utc).isoformat(), "steps": [],
    "domainQualified": False, "admitted": False, "productionActive": False, "fieldValidated": False,
    "billingUSD": None, "completeDescendantUsage": None, "missingCostIsZero": False}
workspace = Path(plan["handoff"]["workspace"])
assert workspace.is_absolute() and workspace.parent.resolve() == Path("/tmp").resolve()
assert workspace.name.startswith("finnor-w1-handoff-") and not workspace.is_symlink()
workspace = workspace.parent.resolve() / workspace.name
python, node = (plan["runtimes"][name]["path"] for name in ("python", "node"))
limit = plan["limits"][{"emitted": "emittedSeconds", "cold": "coldSeconds", "seal": "sealSeconds"}[args.stage]]
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
record["planSha256"] = sha(args.plan)
child = None


def verify_sources():
    assert all((ROOT / pin["path"]).is_file() and sha(ROOT / pin["path"]) == pin["sha256"]
               for pin in plan["sourceFiles"]), "FROZEN_HANDOFF_SOURCE_DRIFT"
    for runtime in plan["runtimes"].values():
        assert sha(Path(runtime["path"])) == runtime["sha256"], "FROZEN_HANDOFF_RUNTIME_DRIFT"


def stop_owned():
    if child is None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def interrupted(signum, _frame):
    raise InterruptedError("HANDOFF_STAGE_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)


def run(identity, command, seconds):
    global child
    row = {"id": identity, "status": "FAIL", "command": list(map(str, command))}
    record["steps"].append(row)
    remaining = min(seconds, limit - (time.monotonic() - clock))
    assert remaining > 0, "ORIGINAL_FINITE_HANDOFF_BOUND"
    log_path = args.output / (identity + ".log")
    try:
        with log_path.open("x") as log:
            child = subprocess.Popen(row["command"], cwd=ROOT, env=dict(os.environ),
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            row["childExitCode"] = child.wait(timeout=remaining)
        assert row["childExitCode"] == 0, "HANDOFF_CHILD_FAILED:" + identity
        row["status"] = "PASS"
    finally:
        previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            stop_owned()
            row["terminalChildExitCode"] = child.returncode if child else None
        except Exception as error:
            row.update(status="FAIL", cleanupFailure=repr(error))
            raise
        finally:
            child = None
            row["logSha256"] = sha(log_path)
            for sig, handler in previous.items():
                signal.signal(sig, handler)


try:
    verify_sources()
    marker = workspace / "owner.json"
    if args.stage == "emitted":
        assert not workspace.exists(), "NEW_TASK_OWNED_HANDOFF_REQUIRED"
        workspace.mkdir(mode=0o700)
        stat = workspace.stat()
        marker.write_text(json.dumps({"id": str(uuid.uuid4()), "uid": os.getuid(),
            "dev": stat.st_dev, "ino": stat.st_ino, "planSha256": record["planSha256"]}) + "\n")
    owner = json.loads(marker.read_text())
    stat = workspace.stat()
    assert stat.st_uid == owner["uid"] == os.getuid() and not marker.is_symlink()
    assert (stat.st_dev, stat.st_ino) == (owner["dev"], owner["ino"])
    assert owner["planSha256"] == record["planSha256"], "ORIGINAL_HANDOFF_OWNER_REQUIRED"
    installed = workspace / "installed"
    if args.stage == "emitted":
        run("emit", [node, HANDOFF / "emit-installed.mjs", "--output", installed, "--plan", args.plan], 600)
        run("owning", [python, HANDOFF / "run-installed-owning.py", installed, args.output / "owning", python], 1800)
        owning = json.loads((args.output / "owning/installed-owning-receipt.json").read_text())
        assert owning["status"] == "PASS_LOCAL_EMITTED_OWNING"
        assert [row["id"] for row in owning["results"]] == ["p2", "native"]
        assert all(row["status"] == "PASS" and row["childExitCode"] == 0 for row in owning["results"])
        metadata = args.output / "metadata"
        metadata.mkdir()
        for name in ("build-manifest.json", "source-inputs.json", "dependency-assets.json",
                     "emitter-transformations.json", "emitter-metafile.json"):
            source = installed / name
            assert source.is_file() and not source.is_symlink()
            shutil.copyfile(source, metadata / name)
        record.update(status="PASS_LOCAL_EMITTED_HANDOFF",
            owningReceiptSha256=sha(args.output / "owning/installed-owning-receipt.json"))
    else:
        emitted = Path(plan["evidence"]) / "emitted-owning/results.json"
        emitted_record = json.loads(emitted.read_text())
        assert emitted_record["status"] == "PASS_LOCAL_EMITTED_HANDOFF"
        assert emitted_record["planSha256"] == record["planSha256"]
        source_inputs = emitted.parent / "metadata/source-inputs.json"
        if args.stage == "cold":
            packet = workspace / "cold-input"
            run("input-packet", [python, HANDOFF / "seal-input-packet.py", args.plan, source_inputs, packet], 600)
            manifest = packet / "cold-input.manifest.json"
            run("cold-reconstruction", [python, HANDOFF / "reconstruct-cold.py", packet / "cold-input.tar.gz",
                manifest, sha(manifest), workspace / "cold", node, plan["runtimes"]["python"]["resolvedPath"],
                plan["handoff"]["uv"], plan["handoff"]["npmCli"]], plan["limits"]["coldSeconds"])
            cold_path = workspace / "cold/cold-reconstruction-receipt.json"
            cold = json.loads(cold_path.read_text())
            assert cold["status"] == "PASS_LOCAL_COLD_EMITTED_OWNING"
            assert cold["disposableCleanup"]["status"] == "PASS"
            shutil.copyfile(cold_path, args.output / cold_path.name)
            record.update(status="PASS_LOCAL_COLD_HANDOFF", coldReceiptSha256=sha(cold_path))
        else:
            receipts = []
            for identity in plan["internalDevelopmentStages"]:
                path = Path(plan["evidence"]) / (identity + ".stage.json")
                gate = json.loads(path.read_text())
                assert gate["id"] == identity and gate["status"] == "PASS"
                assert gate["planSha256"] == record["planSha256"], "ONE_FROZEN_DEVELOPMENT_EPOCH_REQUIRED"
                receipts.append({"id": identity, "sha256": sha(path)})
            scrutiny_path = Path(plan["evidence"]) / "scrutiny/qualification.json"
            scrutiny = json.loads(scrutiny_path.read_text())
            assert scrutiny["status"] == "PASS_SELECTED_REVIEWERS_VALIDATED"
            assert scrutiny["planSha256"] == record["planSha256"]
            assert scrutiny["requestedModel"] == "gpt-6.1-sol" and scrutiny["requestedEffort"] == "max"
            assert scrutiny["unresolvedFindings"] == []
            packet = workspace / "final-packet"
            run("seal", [python, HANDOFF / "seal-input-packet.py", args.plan, source_inputs, packet,
                "--generated", "emitted-suite.mjs=" + str(installed / "runtime/finnor-os/scripts/p2/run-e2e.mjs"),
                "--generated", "emitted-worker.mjs=" + str(installed / "runtime/finnor-os/scripts/p5/physical-worker.mjs")], 600)
            manifest = packet / "cold-input.manifest.json"
            assert json.loads(manifest.read_text())["status"] == "SEALED_AND_VERIFIED"
            record.update(status="SEALED_LOCAL_W1_INTERNAL_EVIDENCE", developmentReceipts=receipts,
                scrutinySha256=sha(scrutiny_path), manifest=str(manifest), manifestSha256=sha(manifest))
    verify_sources()
except Exception as error:
    record.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        stop_owned()
    except Exception as error:
        record.update(status="FAIL", cleanupFailure=repr(error))
    record.update(finishedAt=datetime.now(timezone.utc).isoformat(), elapsedSeconds=time.monotonic() - clock)
    with (args.output / "results.json").open("x") as output:
        output.write(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))
raise SystemExit(0 if record["status"] != "FAIL" else 1)
