"""Actual outer-runner OS controls. No DB, browser, npm install or native build."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("w2_job", HERE.with_name("run-job.py"))
job = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = job
spec.loader.exec_module(job)


def write(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or output.resolve().is_relative_to(job.ROOT) or ".." in output.parts:
        raise ValueError("NEW_EXTERNAL_OWNED_CONTROL_OUTPUT_REQUIRED")
    output.mkdir(mode=0o700)
    started = time.monotonic()
    report = {"schema": "finnor.w2.outer-qualification-controls.v1", "status": "FAIL", "cases": [],
              "sourceCommit": job.source_cut()["commit"], "qualification": "PROCESS_FILESYSTEM_ONLY",
              "installedColdNativeBrowserHostAdmission": "NOT_ESTABLISHED", "wallSeconds": 120,
              "maximumAllowedChildBytes": 256 * 1024 ** 2, "peakObservedChildBytes": None, "cleanup": "NOT_RUN"}
    write(output / "frozen-contract.json", {"cases": [
        "actual-outer-original-twelve-controls", "wrong-manifest-sha-refused", "missing-source-pin-refused",
        "wrong-active-controller-source-pin-refused", "wrong-tool-bytes-refused", "changed-policy-bytes-refused",
        "outer-live-output-collision-noninterference", "active-external-pinset-change-stops-only-owned-launch"],
        "sourceSha256": job.sha(HERE), "runnerSha256": job.sha(HERE.with_name("run-job.py")),
        "wallSeconds": 120, "nativeDatabaseBrowserInstallExecuted": False})
    active = None
    roots, owned, groups = [], {}, set()
    neighbor = None
    cleanup_errors = []
    previous = {}
    manifest = None

    def stop(_signum, _frame):
        raise RuntimeError("ORIGINAL_OUTER_CONTROL_TOTAL_WALL_OR_INTERRUPT")

    def launch(command):
        child = subprocess.Popen(command, cwd=job.ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        roots.append(child)
        groups.add(child.pid)
        return child

    def collect(child, limit=65):
        until = min(started + 120, time.monotonic() + limit)
        data = bytearray()
        os.set_blocking(child.stdout.fileno(), False)
        while True:
            observed = job.observe_owned(child, owned, groups)
            for row in observed:
                report["peakObservedChildBytes"] = max(report["peakObservedChildBytes"] or 0, row["residentBytes"])
                if row["residentBytes"] > 256 * 1024 ** 2:
                    raise RuntimeError("ORIGINAL_LIGHT_CHILD_RSS_BOUND")
            while True:
                try:
                    block = os.read(child.stdout.fileno(), 65536)
                except BlockingIOError:
                    break
                if not block:
                    break
                data.extend(block)
                if len(data) > 2097152:
                    raise RuntimeError("ORIGINAL_CONTROL_LOG_BOUND")
            if child.poll() is not None:
                while True:
                    try:
                        block = os.read(child.stdout.fileno(), 65536)
                    except BlockingIOError:
                        break
                    if not block:
                        break
                    data.extend(block)
                    if len(data) > 2097152:
                        raise RuntimeError("ORIGINAL_CONTROL_LOG_BOUND")
                child.stdout.close()
                return child.returncode, bytes(data)
            if time.monotonic() >= until:
                raise RuntimeError("ORIGINAL_OWNED_CONTROL_COMMAND_WALL")
            try:
                child.wait(timeout=0.05)
            except subprocess.TimeoutExpired:
                pass

    def neighbor_alive():
        assert neighbor and neighbor.poll() is None, "SEPARATELY_OWNED_NEIGHBOR_MUST_SURVIVE"

    def passed(name, observed):
        neighbor_alive()
        report["cases"].append({"name": name, "status": "PASS", "observed": observed})

    def command(name, file, digest, extra=()):
        return [sys.executable, "-B", str(HERE.with_name("run-job.py")), "--case", "supervision",
                "--output", str(output / name), "--node", str(Path(args.node).resolve()),
                "--harness-manifest", str(file), "--harness-manifest-sha256", digest, *extra]

    try:
        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)}
        signal.setitimer(signal.ITIMER_REAL, 120)
        neighbor = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(150)"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        pin_file = output / "prelaunch-harness.json"
        active = launch([sys.executable, "-B", str(HERE.with_name("freeze-harness.py")),
                         "--output", str(pin_file), "--node", str(Path(args.node).resolve())])
        exit_code, _ = collect(active, 15)
        assert exit_code == 0, "ACTUAL_PRELAUNCH_FREEZE_MUST_SUCCEED"
        manifest = json.loads(pin_file.read_text())
        pin_sha = job.sha(pin_file)
        report["harnessManifestSha256"] = pin_sha
        active = launch(command("outer-original-twelve", pin_file, pin_sha))
        exit_code, _ = collect(active)
        outer = json.loads((output / "outer-original-twelve/job-result.json").read_text())
        nested = json.loads((output / "outer-original-twelve/controls/report.json").read_text())
        assert exit_code == 0 and outer["status"] == "PASS" and outer["cleanup"]["status"] == "PASS"
        assert nested["status"] == "PASS" and len(nested["results"]) == 12
        assert outer["finalHarnessIntegrity"] == "PASS"
        passed("actual-outer-original-twelve-controls", {"outer": "PASS", "nestedCases": len(nested["results"]),
                "cleanup": outer["cleanup"], "receiptSha256": job.sha(output / "outer-original-twelve/job-result.json")})
        policy = output / "control-policy-input.json"
        write(policy, {"scope": "HASH_REFUSAL_CONTROL_ONLY_NOT_HOST_ADMISSION"})
        mutants = [
            ("wrong-manifest-sha-refused", None, "EXACT_EXTERNAL_HARNESS_MANIFEST_REQUIRED"),
            ("missing-source-pin-refused", "missing", "COMPLETE_INDEPENDENT_HARNESS_SOURCE_PINSET_REQUIRED"),
            ("wrong-active-controller-source-pin-refused", "source", "ACTIVE_EXECUTING_HARNESS_SOURCE_CHANGED"),
            ("wrong-tool-bytes-refused", "tool", "ACTIVE_FROZEN_TOOL_BINARY_CHANGED"),
            ("changed-policy-bytes-refused", "policy", "ACTIVE_FROZEN_RESOURCE_POLICY_CHANGED"),
        ]
        for name, mutation, expected in mutants:
            value = json.loads(json.dumps(manifest))
            extra = []
            if mutation == "missing":
                value["sources"].pop("scope-postz/w2-accountable-workforce/qualify.py")
            elif mutation == "source":
                value["sources"]["scope-postz/w2-accountable-workforce/qualify.py"]["sha256"] = "0" * 64
            elif mutation == "tool":
                value["tools"]["node"]["sha256"] = "0" * 64
            elif mutation == "policy":
                value["resourcePolicy"] = job.freeze_pin(policy) | {"sha256": "0" * 64}
                extra = ["--resource-policy", str(policy)]
            file = output / (name + ".json")
            write(file, value)
            digest = "0" * 64 if mutation is None else job.sha(file)
            active = launch(command(name, file, digest, extra))
            exit_code, _ = collect(active, 15)
            receipt = json.loads((output / name / "job-result.json").read_text())
            assert exit_code == 1 and receipt["status"] == "FAIL" and receipt["childSpawned"] is False
            assert receipt["failure"]["predicate"] == expected and receipt["cleanup"]["status"] == "PASS"
            passed(name, {"expectedRefusal": expected, "actualRefusal": receipt["failure"]["predicate"],
                         "childSpawned": receipt["childSpawned"], "neighborSurvived": True})
        mutable = output / "active-pinset.json"
        write(mutable, manifest)
        active = launch(command("active-pinset-owner", mutable, job.sha(mutable)))
        until = time.monotonic() + 10
        sample = output / "active-pinset-owner/owned-process-first-sample.json"
        while not sample.exists():
            job.observe_owned(active, owned, groups)
            assert active.poll() is None, "ACTUAL_RUNNING_PINSET_CONTROL_REQUIRED"
            if time.monotonic() >= until:
                raise RuntimeError("ORIGINAL_ACTIVE_CONTROL_STARTUP_WALL")
            time.sleep(0.05)
        first_sample = job.sha(sample)
        losing = launch(command("active-pinset-owner", mutable, job.sha(mutable)))
        loser_code, loser_output = collect(losing, 15)
        assert loser_code == 1 and active.poll() is None
        assert json.loads(loser_output)["reason"] == "OUTPUT_ALREADY_CLAIMED"
        assert job.sha(sample) == first_sample
        passed("outer-live-output-collision-noninterference", {"winnerAlive": True, "childSpawnedByLoser": False,
                                                            "winnerFirstSampleUnchanged": True})
        changed = json.loads(json.dumps(manifest))
        changed["controlMutation"] = "ACTUAL_EXTERNAL_PINSET_CHANGED_AFTER_REAL_CHILD_OBSERVED"
        # This is our private input, never a live product/controller edit.
        with mutable.open("w") as stream:
            stream.write(json.dumps(changed) + "\n")
        exit_code, _ = collect(active, 25)
        receipt = json.loads((output / "active-pinset-owner/job-result.json").read_text())
        assert exit_code == 1 and receipt["status"] == "FAIL" and receipt["childSpawned"] is True
        assert receipt["failure"]["predicate"] == "ACTIVE_HARNESS_MANIFEST_CHANGED"
        assert receipt["cleanup"]["status"] == "PASS"
        passed("active-external-pinset-change-stops-only-owned-launch",
               {"actualRefusal": receipt["failure"]["predicate"], "childSpawned": True,
                "cleanup": receipt["cleanup"], "neighborSurvived": True})
        job.FrozenHarness(pin_file, pin_sha, job.ROOT, args.node).verify(all_tools=True)
        assert len(report["cases"]) == 8
        report["status"] = "PASS"
    except Exception as error:
        report["failure"] = {"type": type(error).__name__, "predicate": str(error)
            if str(error).replace("_", "").isalnum() else "ACTUAL_OUTER_CONTROL_BOUNDARY_FAILED"}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for child in roots:
            if child.poll() is None:
                try:
                    job.observe_owned(child, owned, groups)
                    os.killpg(child.pid, signal.SIGCONT)
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=3)
                except ProcessLookupError:
                    pass
        live = job.process_rows()
        for group in groups:
            members = [row for row in live if row["group"] == group]
            if not members:
                continue
            if any(row["pid"] not in owned or not job.same_process(owned[row["pid"]], row) for row in members):
                cleanup_errors.append("CONTROL_GROUP_IDENTITY_UNKNOWN")
                continue
            os.killpg(group, signal.SIGCONT); os.killpg(group, signal.SIGKILL)
            cleanup_errors.append("CONTROL_LAUNCH_LEAKED_OWNED_GROUP")
        if neighbor:
            try:
                report["neighborSurvivedAllControls"] = neighbor.poll() is None
                if neighbor.poll() is None:
                    neighbor.terminate(); neighbor.wait(timeout=3)
            except subprocess.TimeoutExpired:
                neighbor.kill(); neighbor.wait(timeout=3)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if cleanup_errors:
            report["status"] = "FAIL"
        report["cleanup"] = {"status": "FAIL" if cleanup_errors else "PASS", "errors": cleanup_errors}
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        report["elapsedSeconds"] = time.monotonic() - started
        write(output / "report.json", report)
        print(json.dumps({"status": report["status"], "cases": len(report["cases"]), "cleanup": report["cleanup"],
                          "report": str(output / "report.json")}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
