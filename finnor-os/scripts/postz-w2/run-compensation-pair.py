"""Run one registered actual closing-owner comparison with exact source restoration."""
import argparse
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
INPUTS = Path(__file__).with_name("compensation-recovery-inputs")
PREFIX = "finnor-os/packages/private-equity/src/"
ALLOCATION = PREFIX + "allocation-store.ts"
JOIN = PREFIX + "workforce-compensation-closing.ts"
GIB = 1024 ** 3


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--episode", required=True, choices=("before-exact", "after-exact",
        "after-wrong-amount", "after-wrong-payee", "after-wrong-receipt"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--python", required=True, type=Path)
    args = parser.parse_args()
    assert args.output.is_absolute() and not args.output.exists(), "NEW_ABSOLUTE_OUTPUT_REQUIRED"
    assert args.python.is_absolute() and args.python.is_file(), "EXPLICIT_SCIENTIFIC_PYTHON_REQUIRED"
    node = shutil.which("node")
    assert node and subprocess.check_output([node, "--version"], text=True).strip() == "v22.22.3"
    args.output.mkdir(mode=0o700, parents=True)
    report = args.output / "report"
    report.mkdir(mode=0o700)
    temporary = args.output / "tmp"
    temporary.mkdir(mode=0o700)
    owner = args.output / "owner"
    command = [node, "--import=tsx", "scripts/v3/run-closing-e2e.mts", "--case", "workforce-compensation"]
    selected = args.episode.removeprefix("after-") if args.episode.startswith("after-") else "exact"
    manifest = json.loads((INPUTS / "manifest.json").read_text())
    assert manifest["schema"] == "finnor.w2.compensation-recovery-preimages.v1"
    paths = [ALLOCATION, *[row["target"] for row in manifest["files"]], JOIN]
    assert len(paths) == 5 and len(set(paths)) == 5
    fixed = {path: (ROOT / path).read_bytes() for path in paths}
    reversed_bytes = dict(fixed)
    for treatment, original in (
        (b"import {workforceAccountingFrontierTx} from './workforce-compensation-closing';\n", b""),
        (b"const value={resources,outstanding:await workforceAccountingFrontierTx(c,tenantId,outstanding)};",
         b"const value={resources,outstanding};"),
    ):
        assert reversed_bytes[ALLOCATION].count(treatment) == 1, "EXACT_ALLOCATION_TREATMENT_REQUIRED"
        reversed_bytes[ALLOCATION] = reversed_bytes[ALLOCATION].replace(treatment, original, 1)
    for row in manifest["files"]:
        assert row["target"] in paths and "/../" not in row["target"]
        before = (INPUTS / row["beforeSource"]).read_bytes()
        assert digest(before) == row["beforeSha256"]
        assert digest(fixed[row["target"]]) == row["fixedSha256"], "REPAIRED_OWNER_PREIMAGE_CHANGED"
        reversed_bytes[row["target"]] = before
    reversed_bytes[JOIN] = None
    assert not subprocess.check_output(["git", "diff", "--name-only"], cwd=ROOT).strip(), "CLEAN_TRACKED_SOURCE_REQUIRED"
    record = {"schema": "finnor.w2.compensation-owner-comparison.v1", "status": "RUNNING",
        "episode": args.episode, "selected": selected, "startedAt": time.time(), "command": command,
        "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceTree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
        "preimageManifestSha256": digest((INPUTS / "manifest.json").read_bytes()),
        "fixedHashes": {path: digest(data) for path, data in fixed.items()},
        "baselineHashes": {path: digest(data) if data is not None else None for path, data in reversed_bytes.items()},
        "limits": {"episodeSeconds": 1200, "initialAvailableMemoryBytes": 4 * GIB,
            "initialDiskBytes": 4 * GIB, "continuousDiskFloorBytes": 1536 * 1024 ** 2},
        "qualification": "CONTROLLED_ACTUAL_NATIVE_OWNERS_NO_REAL_PAYMENT_OR_PROTECTED_ADMISSION"}
    child = None
    source_reversed = False
    heavy_lock = None

    def save():
        target = report / "receipt.json"
        stage = target.with_suffix(".tmp")
        stage.write_text(json.dumps(record, indent=2) + "\n")
        stage.replace(target)

    def interrupted(number, _frame):
        raise InterruptedError("OWNED_COMPARISON_INTERRUPTED:" + str(number))

    def stop_owned():
        if child and child.poll() is None:
            rows = [tuple(map(int, line.split())) for line in
                subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()]
            owned = {child.pid}
            while True:
                more = {pid for pid, parent in rows if parent in owned}
                if more <= owned:
                    break
                owned |= more
            for number in (signal.SIGTERM, signal.SIGKILL):
                for pid in sorted(owned, reverse=True):
                    try:
                        os.kill(pid, number)
                    except ProcessLookupError:
                        pass
                if number == signal.SIGTERM:
                    time.sleep(2)
            child.wait(timeout=10)
        for pidfile in temporary.glob("finnor-v3-runtime-pg-*/postmaster.pid"):
            lines = pidfile.read_text().splitlines()
            pid = int(lines[0])
            assert lines[1] == str(pidfile.parent), "OWNED_POSTGRES_DIRECTORY_MISMATCH"
            identity = subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "command="],
                capture_output=True, text=True).stdout.strip()
            if not identity:
                continue
            assert str(ROOT / "finnor-os/node_modules/@embedded-postgres/") in identity
            assert "-D " + str(pidfile.parent) in identity, "OWNED_POSTGRES_IDENTITY_MISMATCH"
            os.kill(pid, signal.SIGTERM)
            until = time.monotonic() + 10
            while pidfile.exists() and time.monotonic() < until:
                time.sleep(0.1)
            assert not pidfile.exists(), "OWNED_POSTGRES_DID_NOT_STOP"

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    save()
    try:
        heavy_lock = open("/tmp/finnor-w123-local-heavy.lock", "a")
        fcntl.flock(heavy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert shutil.disk_usage(ROOT).free >= 4 * GIB, "INITIAL_DISK_FLOOR_UNAVAILABLE"
        if sys.platform == "linux":
            available = next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines()
                if line.startswith("MemAvailable:"))
            available_memory = int(available) * 1024
        elif sys.platform == "darwin":
            pressure = subprocess.check_output(["memory_pressure"], text=True, timeout=5)
            percent = int(pressure.split("System-wide memory free percentage:")[1].strip().removesuffix("%"))
            available_memory = percent * int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)) // 100
        else:
            raise AssertionError("UNSUPPORTED_RESOURCE_OBSERVATION_PLATFORM")
        assert available_memory >= 4 * GIB, "INITIAL_AVAILABLE_MEMORY_FLOOR_UNAVAILABLE"
        record["initialAvailableMemoryBytes"] = available_memory
        if args.episode == "before-exact":
            source_reversed = True
            for path, data in reversed_bytes.items():
                if data is None:
                    (ROOT / path).unlink()
                else:
                    (ROOT / path).write_bytes(data)
        environment = {"PATH": str(Path(node).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(Path.home()), "TMPDIR": str(temporary), "LANG": "C.UTF-8",
            "NODE_OPTIONS": "--max-old-space-size=2048", "FINNOR_V3_EVIDENCE_DIR": str(owner),
            "FINNOR_S3_PYTHON": str(args.python), "FINNOR_S5_PYTHON": str(args.python),
            "FINNOR_W2_COMPENSATION_CASE": selected, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
            "FINNOR_W2_CUT_SECTION_DIAGNOSTIC": os.environ.get("FINNOR_W2_CUT_SECTION_DIAGNOSTIC", "0")}
        with (args.output / "driver.log").open("x") as log:
            child = subprocess.Popen(command, cwd=ROOT / "finnor-os", env=environment,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            record["pid"] = child.pid
            save()
            deadline = time.monotonic() + 1200
            while child.poll() is None:
                assert time.monotonic() < deadline, "ORIGINAL_EPISODE_TIME_LIMIT"
                assert shutil.disk_usage(ROOT).free >= 1536 * 1024 ** 2, "ORIGINAL_DISK_FLOOR_BREACHED"
                time.sleep(1)
        result = json.loads((owner / "results.json").read_text())
        observed_path = owner / "workforce-compensation/settled-owner-before-projection-assertion.json"
        observed = json.loads(observed_path.read_text())
        record["driverExitCode"] = child.returncode
        assert all(row["exit"] is not None for row in result["processes"]), "OWNED_CHILD_EXIT_NOT_RECORDED"
        record["actualClosingOwnerStatus"] = observed["completed"]["q"]["status"]
        record["actualCompensationStatus"] = observed["compensation"]["observations"][0]["status"]
        join_probe = owner / "workforce-compensation/sanitized-join-diagnostic.json"
        if join_probe.exists():
            verified_counts = json.loads(join_probe.read_text())
            allowed = ("acceptedPromises", "paymentLinks", "closedCertificates",
                "nativePaymentLinks", "verifiedPaymentOperations",
                "reconciledPaymentConsumptions", "acceptedCurrentChecks")
            record["joinDiagnostic"] = {key: int(verified_counts[key]) for key in allowed}
        cut_report = owner / "workforce-compensation/material-cut-section-diff.json"
        if cut_report.exists():
            cut_data = json.loads(cut_report.read_text())
            permitted_keys = {"checkedPreCertificateSections", "changedSections",
                "unchangedSections", "proofDomain", "financialSettlementClaimed"}
            assert set(cut_data) == permitted_keys, "UNEXPECTED_CUT_PROBE_FIELDS"
            assert cut_data["proofDomain"] == "DISPOSABLE_NATIVE_POSTCLOSE_DIAGNOSTIC_ONLY"
            assert cut_data["financialSettlementClaimed"] is False
            assert isinstance(cut_data["checkedPreCertificateSections"], int) and 0 <= cut_data["checkedPreCertificateSections"] <= 64
            assert isinstance(cut_data["unchangedSections"], int) and 0 <= cut_data["unchangedSections"] <= 64
            keys = cut_data["changedSections"]
            assert isinstance(keys, list) and len(keys) <= 64
            assert all(isinstance(key, str) and 0 < len(key) <= 64
                and re.fullmatch(r"[a-z][a-zA-Z0-9_]*", key) for key in keys)
            record["cutSectionDiagnostic"] = {
                "sectionsCaptured": cut_data["checkedPreCertificateSections"],
                "changedSections": keys,
                "unchangedSectionCount": cut_data["unchangedSections"],
                "qualification": "SANDBOX_SECTION_NAMES_ONLY_NOT_FINANCIAL_SETTLEMENT",
            }
        # The real owner's debug evaluation is rollback-only; export only four
        # allowlisted non-identifying fields, not original financial or actor data.
        candidate_file = owner / "workforce-compensation/rollback-only-post-close-candidate.json"
        if candidate_file.exists():
            candidate = json.loads(candidate_file.read_text())
            assert isinstance(candidate.get("linkWouldInsertAfterClosed"), bool)
            assert isinstance(candidate.get("rolledBack"), bool)
            assert isinstance(candidate.get("durableLinkCount"), int)
            error_code = candidate.get("errorCode")
            assert error_code is None or error_code in (
                "UNCLASSIFIED_REPLAY_ERROR", "WORKFORCE_CLOSING_PROMISE_PREIMAGE_INVALID",
                "WORKFORCE_CLOSING_PROMISE_PREIMAGE_CHANGED", "WORKFORCE_CLOSING_ORIGINAL_ACCEPTANCE_REQUIRED",
                "WORKFORCE_CLOSING_PAYMENT_ALREADY_ASSIGNED", "WORKFORCE_CLOSING_PAYMENT_PREIMAGE_CHANGED",
                "WORKFORCE_CLOSING_PAYMENT_ORIGINAL_CONSUMPTION_CHANGED")
            permitted = ("promiseBudgetJoined", "operationJoined", "consumptionOriginJoined",
                "evidenceVersionJoined", "evidenceBound", "checkCutMatches",
                "certificateCheckIdentityMatches", "certificateOriginalCutMatches",
                "certificateCurrentCutMatches")
            stages = candidate.get("stagedJoins")
            assert isinstance(stages, dict) and set(stages) == set(permitted)
            assert all(type(stages[key]) is int and 0 <= stages[key] <= 2 for key in permitted)
            record["postCloseRollbackDiagnostic"] = {
                "linkWouldInsertAfterClosed": candidate["linkWouldInsertAfterClosed"],
                "rolledBack": candidate["rolledBack"],
                "durableLinkCount": candidate["durableLinkCount"],
                "errorCode": error_code,
                "stageCounts": {key: stages[key] for key in permitted},
            }
        if args.episode == "before-exact":
            assert not result["passed"] and child.returncode != 0
            assert record["actualClosingOwnerStatus"] == "CLOSED"
            assert record["actualCompensationStatus"] == "OPEN"
            assert "Exact receiving receipt join" in result["failed"]["message"], "UNRELATED_BASELINE_FAILURE"
            record["expectedOriginalMissingJoinDemonstrated"] = True
        else:
            assert result["passed"] and child.returncode == 0, "REPAIRED_OWNER_EPISODE_FAILED"
        for name in ("results.json", "closing-reader-privacy-original.json", "closing-reader-privacy-result.json",
                "workforce-compensation/settled-owner-before-projection-assertion.json",
                "workforce-compensation/receiving-join-" + selected + ".json"):
            source = owner / name
            if source.exists():
                shutil.copyfile(source, report / Path(name).name)
        originals = list(owner.glob("*/w2-original-obligation.json"))
        assert len(originals) == 1, "ONE_ORIGINAL_CONTROLLED_OBLIGATION_REQUIRED"
        shutil.copyfile(originals[0], report / "original-obligation.json")
        record["status"] = "PASS"
    except BaseException as error:
        record.update(status="FAIL", errorType=type(error).__name__, error=str(error))
        if (owner / "results.json").exists():
            result = json.loads((owner / "results.json").read_text())
            record["ownerFailure"] = result.get("failed")
        canonical_failure = owner / "failed-canonical-readback.json"
        if canonical_failure.exists():
            canonical = json.loads(canonical_failure.read_text())
            record["closingOwnerDiagnostics"] = [
                {"kind": row["kind"], "diagnostic": row["body"]["diagnostic"]}
                for row in canonical.get("events", [])
                if row.get("kind") == "CONTROLLER_BLOCKED_WITH_RESPONSIBILITY_RETAINED"
                and isinstance(row.get("body"), dict) and "diagnostic" in row["body"]
            ]
        checker_log = owner / "checker.log"
        if checker_log.exists():
            record["independentCheckerDiagnostics"] = []
            for line in checker_log.read_text().splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict) and entry.get("event") == "INDEPENDENT_CLOSING_CHECK_FAILED":
                    record["independentCheckerDiagnostics"].append(entry)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            stop_owned()
        except BaseException as error:
            record.update(status="FAIL", cleanupError=str(error))
        try:
            if source_reversed:
                for path, data in fixed.items():
                    actual = (ROOT / path).read_bytes() if (ROOT / path).exists() else None
                    assert actual == reversed_bytes[path], "BASELINE_SOURCE_CHANGED_EXTERNALLY:" + path
                    (ROOT / path).write_bytes(data)
            assert all((ROOT / path).read_bytes() == data for path, data in fixed.items())
            assert not subprocess.check_output(["git", "diff", "--name-only"], cwd=ROOT).strip(), "UNRELATED_TRACKED_SOURCE_DRIFT"
            record["sourceRestored"] = True
        except BaseException as error:
            record.update(status="FAIL", restorationError=str(error), sourceRestored=False)
        record.update(finishedAt=time.time(), freeBytes=shutil.disk_usage(ROOT).free)
        save()
        if heavy_lock:
            heavy_lock.close()
    print(json.dumps({"episode": args.episode, "status": record["status"],
        "error": record.get("error"), "ownerFailure": record.get("ownerFailure"),
        "closingOwnerDiagnostics": record.get("closingOwnerDiagnostics"),
        "independentCheckerDiagnostics": record.get("independentCheckerDiagnostics"),
        "receipt": str(report / "receipt.json")}))
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
