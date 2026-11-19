"""Execute frozen W1 stages and retain all60 original case dispositions.

A passing mechanism/read slice is never promoted over a missing whole-case
obligation. Evidence and stage receipts are exclusive; reruns need a new epoch.
"""
import argparse
from datetime import datetime, timezone
import glob
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from campaign_runtime import runtime_asset_population

ROOT = Path(__file__).resolve().parents[3]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    with path.open("x") as out:
        out.write(json.dumps(value, indent=2) + "\n")


def sources(plan):
    return [row["path"] for row in plan["sourceFiles"]
            if not (ROOT / row["path"]).is_file() or sha(ROOT / row["path"]) != row["sha256"]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("--phase", default="base", choices=("base", "on-off", "mounted", "handoff", "seal"))
    parser.add_argument("--stages", help="Execute only these registered IDs; other stages remain NOT_RUN")
    args = parser.parse_args()
    args.plan = args.plan.resolve(strict=True)
    plan = json.loads(args.plan.read_text())
    assert plan["state"] == "FROZEN_EXECUTABLE_W1_SCOPED_NOT_COMPLETE"
    assert [row["id"] for row in plan["cases"]] == [f"W{number:03d}" for number in range(1, 61)]
    evidence = Path(plan["evidence"])
    evidence.mkdir(exist_ok=True)
    configuration = plan["runtimeConfiguration"]
    assert sha(Path(configuration["path"])) == configuration["sha256"], "FROZEN_CONFIGURATION_DRIFT"
    chosen = args.stages.split(",") if args.stages else [row["id"] for row in plan["stages"] if row["phase"] == args.phase]
    registered = {row["id"]: row for row in plan["stages"]}
    assert chosen and len(set(chosen)) == len(chosen) and all(identity in registered for identity in chosen)
    assert all(registered[identity]["phase"] == args.phase for identity in chosen)
    environment = {key: value for key, value in os.environ.items() if key in ("HOME", "PATH", "TMPDIR", "LANG", "LC_ALL")}
    environment.update(plan["environment"])
    began = time.monotonic()
    clock_path = evidence / "campaign-clock.json"
    if not clock_path.exists():
        save(clock_path, {"schema": "finnor.w1.single-campaign-clock.v1", "planSha256": sha(args.plan),
            "startedAt": datetime.now(timezone.utc).isoformat(), "startedEpochSeconds": time.time(),
            "limitSeconds": plan["limits"]["campaignSeconds"]})
    campaign_clock = json.loads(clock_path.read_text())
    assert campaign_clock["planSha256"] == sha(args.plan) and campaign_clock["limitSeconds"] == plan["limits"]["campaignSeconds"]
    assert time.time() >= campaign_clock["startedEpochSeconds"], "CAMPAIGN_CLOCK_CANNOT_MOVE_BACKWARD"
    remaining_campaign = campaign_clock["startedEpochSeconds"] + campaign_clock["limitSeconds"] - time.time()
    deadline = began + remaining_campaign
    failed = []
    cancelled = False
    def interrupted(signum, _frame):
        nonlocal cancelled
        cancelled = True
        raise InterruptedError("FROZEN_CAMPAIGN_INTERRUPTED_" + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    for identity in chosen:
        stage = registered[identity]
        receipt_path = evidence / (identity + ".stage.json")
        assert not receipt_path.exists(), "NEW_EPOCH_REQUIRED_FOR_STAGE_RERUN:" + identity
        row = {"schema": "finnor.w1.frozen-stage.v1", "id": identity, "status": "NOT_RUN",
               "planSha256": sha(args.plan), "startedAt": datetime.now(timezone.utc).isoformat(),
               "command": stage["command"], "owningReport": None}
        start = time.monotonic()
        child = None
        try:
            assert not sources(plan), "FROZEN_SOURCE_DRIFT_BEFORE_STAGE"
            for runtime in plan["runtimes"].values():
                assert sha(Path(runtime["path"])) == runtime["sha256"], "RUNTIME_EXECUTABLE_DRIFT"
            npm = plan["runtimes"]["npmCli"]
            assert runtime_asset_population(Path(npm["distributionRoot"])) == npm["assets"], "BOOTSTRAP_NPM_DISTRIBUTION_DRIFT"
            assert time.monotonic() < deadline, "FINITE_CAMPAIGN_BOUND"
            command = [plan["runtimes"]["python"]["path"], str(Path(__file__).with_name("with-resources.py")),
                       "--plan", str(args.plan),
                       "--forecast-bytes", str(stage["forecastBytes"]), "--receipt", stage["resourceReceipt"],
                       "--timeout", str(stage["timeoutSeconds"])]
            if stage["heavy"]:
                command += ["--heavy"]
            command += ["--", *stage["command"]]
            with Path(stage["evidenceLog"]).open("x") as log:
                child = subprocess.Popen(command, cwd=ROOT, env=environment,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    row["wrapperExitCode"] = child.wait(
                        timeout=min(stage["timeoutSeconds"] + 1230, deadline - time.monotonic()))
                finally:
                    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                        try:
                            child.wait(timeout=40)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL)
                            child.wait(timeout=5)
                    for sig, handler in previous.items():
                        signal.signal(sig, handler)
            resource = json.loads(Path(stage["resourceReceipt"]).read_text())
            row["resource"] = {"status": resource["status"], "childExitCode": resource["childExitCode"],
                               "receiptSha256": sha(Path(stage["resourceReceipt"]))}
            if resource["status"] == "NOT_RUN":
                row["reason"] = resource.get("failure", "RESOURCE_NOT_ADMITTED")
            else:
                row["status"] = "FAIL"
                assert row["wrapperExitCode"] == 0 and resource["status"] == "PASS", "REGISTERED_CHILD_OR_RESOURCE_GATE_FAILED"
                matches = glob.glob(stage["reportGlob"])
                assert len(matches) == 1, "ONE_EXACT_OWNING_REPORT_REQUIRED"
                report_path = Path(matches[0])
                report = json.loads(report_path.read_text())
                row["owningReport"] = {"path": str(report_path), "sha256": sha(report_path)}
                if identity == "types":
                    assert report["exitCode"] == 0 and report["compilerClosureQualified"] is True
                    assert not report["sourceChangedDuringCheck"] and not report["timedOut"]
                if stage["requiredStatus"]:
                    assert report["status"] == stage["requiredStatus"], "REQUIRED_OWNING_STATUS"
                cases = report.get("cases", report.get("results"))
                if stage["requiredCount"] is not None:
                    assert isinstance(cases, list) and len(cases) == stage["requiredCount"], "COMPLETE_REGISTERED_PREDICATE_COUNT"
                    assert len({case.get("id", case.get("name")) for case in cases}) == len(cases), "NO_DUPLICATE_PREDICATE_IDS"
                    assert all(case["status"] == "PASS" for case in cases), "EVERY_REGISTERED_PREDICATE_REQUIRED"
                if stage.get("requiredFamilyIds") is not None:
                    assert [case["id"] for case in cases] == stage["requiredFamilyIds"], "ALL_ORIGINAL_INTERNAL_FAMILY_IDS_REQUIRED"
                    assert report["childExitCode"] == 0 and report["ownedChildStopped"] is True
                if identity == "reads":
                    assert report["predicateCounts"] == {"PASS": 65, "FAIL": 0, "NOT_RUN": 0}
                    assert report["shutdown"]["complete"] is True
                row["sourceDriftAfter"] = sources(plan)
                assert not row["sourceDriftAfter"], "FROZEN_SOURCE_DRIFT_AFTER_STAGE"
                for runtime in plan["runtimes"].values():
                    assert sha(Path(runtime["path"])) == runtime["sha256"], "RUNTIME_EXECUTABLE_DRIFT_AFTER_STAGE"
                assert runtime_asset_population(Path(npm["distributionRoot"])) == npm["assets"], "BOOTSTRAP_NPM_DISTRIBUTION_DRIFT_AFTER_STAGE"
                row["status"] = "PASS"
        except Exception as error:
            row.update(status="FAIL" if child else "NOT_RUN", failure=str(error), failureType=type(error).__name__)
        row.update(completedAt=datetime.now(timezone.utc).isoformat(), durationSeconds=time.monotonic() - start)
        save(receipt_path, row)
        print(json.dumps({"id": identity, "status": row["status"], "failure": row.get("failure", row.get("reason")),
                          "durationSeconds": row["durationSeconds"]}), flush=True)
        if row["status"] != "PASS":
            failed.append(identity)
        if cancelled or sources(plan) or identity == "types" and row["status"] != "PASS":
            break
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    observed = {}
    for path in evidence.glob("*.stage.json"):
        row = json.loads(path.read_text())
        observed[row["id"]] = row
    case_results = []
    for original in plan["cases"]:
        slices = [{"stage": identity, "status": observed.get(identity, {}).get("status", "NOT_RUN"),
                   "receipt": str(evidence / (identity + ".stage.json"))} for identity in original["stages"]]
        all_pass = bool(slices) and all(row["status"] == "PASS" for row in slices)
        status = "FAIL" if any(row["status"] == "FAIL" for row in slices) else (
            "PASS" if all_pass and original["wholeFamilyPassAllowed"] else "NOT_RUN")
        case_results.append(dict(original, status=status, observedSlices=slices,
            sliceStatus="PASS_LOCAL_SLICES_ONLY" if all_pass and original["gap"] else status,
            noWholeCaseClaimForPartialEvidence=bool(original["gap"])))
    snapshot = {"schema": "finnor.w1.all-sixty-campaign-results.v1",
                "status": "PASS_LOCAL_SELECTED_STAGES_ONLY" if not failed else "INCOMPLETE",
                "phase": args.phase, "selectedStages": chosen, "failedOrNotRunStages": failed,
                "sourceCommit": plan["sourceCommit"], "planSha256": sha(args.plan),
                "sourceDriftAtPublication": sources(plan), "cases": case_results,
                "counts": {state: sum(row["status"] == state for row in case_results) for state in ("PASS", "FAIL", "NOT_RUN")},
                "allSixtyExecuted": all(row["status"] != "NOT_RUN" for row in case_results),
                "CODE_COMPLETE": False, "E2E_DEV_VERIFIED": False, "DOMAIN_QUALIFIED": False,
                "ADMITTED": False, "PRODUCTION_ACTIVE": False, "FIELD_VALIDATED": False,
                "elapsedSeconds": time.monotonic() - began, "billingUSD": None, "humanSeconds": None,
                "completeDescendantUsage": None, "missingCostIsZero": False}
    publication = evidence / ("results-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    save(publication, snapshot)
    print(json.dumps({"publication": str(publication), "status": snapshot["status"], "counts": snapshot["counts"],
                      "allSixtyExecuted": snapshot["allSixtyExecuted"]}), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
