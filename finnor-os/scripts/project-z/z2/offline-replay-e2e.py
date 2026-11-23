"""Actual CLI E2E for offline fixture isolation, never an owner execution."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ("repo", "whole-owner", "evidence-dir", "node"):
        parser.add_argument("--"+name, required=True)
    args = parser.parse_args()
    for value in vars(args).values():
        assert Path(value).is_absolute(), "Z2_OFFLINE_E2E_ABSOLUTE_PATHS_REQUIRED"
    repo, owner, out, node = [Path(v).resolve() for v in
                              (args.repo, args.whole_owner, args.evidence_dir, args.node)]
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    scripts = repo/"finnor-os/scripts/project-z/z2"
    driver, generator = scripts/"native-replay.mjs", scripts/"offline-target-fixture.mjs"
    before = {str(p.relative_to(scripts)): sha(p) for p in (driver, generator,
              scripts/"native-replay-target.schema.json")}
    env = {"PATH": str(node.parent)+":/usr/bin:/bin", "NODE_ENV": "test",
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
    started, cases, fixture = time.monotonic(), [], out/"target.offline-fixture.json"
    grant_names = ("explicitDisposableExecution", "ownedWorkerKillAndSameBuildRestart",
                   "exclusiveNativeReplayDatabase", "consumeOriginalRemainingConstructionBudget",
                   "leaveOwnedWorkerStoppedAfterReplay")

    def run(name, command, expected, variables=None, report_dir=None, failure=None):
        log_path = out/(name+".log")
        begin = time.monotonic()
        with log_path.open("wb") as log:
            child = subprocess.Popen([str(c) for c in command], env=variables or env,
                                     cwd=repo, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            try:
                code, termination = child.wait(timeout=180), None
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                code, termination = None, "TIMEOUT"
        receipt = json.loads((report_dir/"report.json").read_text()) if report_dir else None
        passed = code == expected and termination is None
        if receipt is not None:
            passed = passed and receipt["databaseOrAuthAccess"] is False and receipt["servicesStarted"] is False
            passed = passed and all(receipt[key] == "NOT_RUN" for key in
                                   ("authenticatedOwner", "mountedWork", "physicalRecovery",
                                    "installedOwnerExecution", "financialQualification"))
            if failure:
                passed = passed and receipt.get("failure") == failure and not receipt["steps"]
            elif expected == 0:
                passed = passed and receipt["status"] == "VALIDATED_TARGET_BYTES_NOT_EXECUTED"
                passed = passed and receipt["validationOnly"] is True and receipt["executionAuthority"] is False
        entry = {"id": name, "command": [str(c) for c in command], "environmentNames": sorted(variables or env),
                 "exitCode": code, "expectedExitCode": expected, "signal": termination, "passed": bool(passed),
                 "wallMs": round(1000*(time.monotonic()-begin)), "logSha256": sha(log_path)}
        if receipt is not None:
            entry.update(reportSha256=sha(report_dir/"report.json"), status=receipt["status"],
                         failure=receipt.get("failure"), databaseOrAuthAccess=receipt["databaseOrAuthAccess"])
        cases.append(entry)
        print(json.dumps(entry), flush=True)
        return entry, receipt

    failure = None
    link = None
    try:
        generated, _ = run("fixture-generate", [node, generator, "--whole-owner", owner,
                                                "--output", fixture], 0)
        assert generated["passed"] and fixture.is_file()
        target = json.loads(fixture.read_text())
        assert target["validationOnly"] is True
        assert all(target["authorization"][name] is False for name in grant_names)
        fixture_hash = sha(fixture)
        original_receipt_hash = sha(owner/"install-report.json")

        proof_dir = out/"positive"
        run("positive-offline-binding", [node, driver, "--validate-target", "--target", fixture,
                                         "--evidence-dir", proof_dir], 0, report_dir=proof_dir)

        for name, mutate in [
            ("marker-removed", lambda t: t.pop("validationOnly")),
            ("fixture-grant-true", lambda t: t["authorization"].update(explicitDisposableExecution=True)),
        ]:
            value = json.loads(fixture.read_text())
            mutate(value)
            path, proof_dir = out/(name+".json"), out/(name+"-proof")
            path.write_text(json.dumps(value, indent=2)+"\n")
            path.chmod(0o600)
            run(name, [node, driver, "--validate-target", "--target", path, "--evidence-dir", proof_dir],
                1, report_dir=proof_dir, failure="Z2_TARGET_SCHEMA_ONE_OF")

        # A nonexistent source canary and absent credential variables independently
        # prevent execution even if this fixture guard were to regress.
        value = json.loads(fixture.read_text())
        value["sourceRoot"] = str(out/"nonexistent-source-canary")
        denied = out/"execution-denied.json"
        denied.write_text(json.dumps(value, indent=2)+"\n")
        denied.chmod(0o600)
        proof_dir = out/"execution-denied-proof"
        run("fixture-not-executable", [node, driver, "--execute-native", "--target", denied,
                                      "--evidence-dir", proof_dir], 1,
            variables={**env, "FINNOR_Z2_DISPOSABLE_E2E": "1"}, report_dir=proof_dir,
            failure="Z2_OFFLINE_FIXTURE_NOT_EXECUTABLE")

        # Empty negative-path pack, not a fabricated installation receipt. Both
        # output guards must reject before looking for any receipt or writing.
        dummy = out/"containment"
        pack = dummy/"pack"
        pack.mkdir(parents=True)
        link = out/"pack-link"
        link.symlink_to(pack, target_is_directory=True)
        for name, path in [("dotdot-name-descendant", pack/"..offline-fixture-output.json"),
                           ("symlink-parent-descendant", link/"offline-fixture-output.json")]:
            entry, _ = run(name, [node, generator, "--whole-owner", dummy, "--output", path], 1)
            entry["passed"] = entry["passed"] and not path.exists() and \
                "Z2_OFFLINE_FIXTURE_OUTPUT_OUTSIDE_PACK_REQUIRED" in (out/(name+".log")).read_text()

        entry, _ = run("overwrite-refused", [node, generator, "--whole-owner", owner, "--output", fixture], 1)
        entry["passed"] = entry["passed"] and "EEXIST" in (out/"overwrite-refused.log").read_text() and sha(fixture) == fixture_hash
        assert sha(owner/"install-report.json") == original_receipt_hash
        assert all(sha(scripts/path) == expected for path, expected in before.items())
    except Exception as error:
        failure = type(error).__name__+": "+str(error)
    finally:
        if link is not None:
            link.unlink(missing_ok=True)
    passed = failure is None and len(cases) == 8 and all(c["passed"] for c in cases)
    report = {"schema": "finnor.project-z.z2.offline-replay-cli-e2e.v1",
              "status": "PASSED" if passed else "FAILED", "cases": cases, "failure": failure,
              "sourceSha256": before, "sourcesUnchanged": all(sha(scripts/path) == expected for path, expected in before.items()),
              "fixtureSha256": sha(fixture) if fixture.is_file() else None,
              "wholeOwnerReceiptSha256": sha(owner/"install-report.json"),
              "scope": "OFFLINE_BINDING_AND_PREEXECUTION_REFUSAL_ONLY",
              "servicesStarted": False, "databaseOrAuthAccess": False,
              "authenticatedOwner": "NOT_RUN", "protectedAdmission": "NOT_RUN",
              "financialQualification": "NOT_RUN", "wallMs": round(1000*(time.monotonic()-started)),
              "moneyUsd": None, "humanSeconds": None, "costStatus": "PARTIALLY_METERED"}
    (out/"report.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"status": report["status"], "cases": len(cases), "failure": failure}), flush=True)
    return int(not passed)


if __name__ == "__main__":
    raise SystemExit(main())
