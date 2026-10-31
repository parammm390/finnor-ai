"""Finite paired CONTROL fixture, source custody and independent oracle."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from urllib.parse import urlsplit, unquote

spec = importlib.util.spec_from_file_location("recovery_runner_custody", Path(__file__).with_name("recovery-run.py"))
custody = importlib.util.module_from_spec(spec)
spec.loader.exec_module(custody)
CONTROLLER = "finnor-os/packages/private-equity/src/economic-orchestration/controller.ts"
# One runner bound carried by the per-child remaining budget, the pass/fail
# elapsed check, and the reported runnerBoundMs; all three must agree.
RUNNER_LIMIT_SECONDS = 300


def main():
    parser = argparse.ArgumentParser()
    for name in ("node", "tsx", "python", "evidence", "contract", "phase"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--baseline")
    parser.add_argument("--disposable-local-fixtures", action="store_true", required=True)
    args = parser.parse_args()
    assert args.phase in ("broken", "repaired"), "EXPLICIT_CONTROL_PHASE_REQUIRED"
    began = time.monotonic()
    def interrupted(_signal, _frame):
        # selectors used by communicate swallow InterruptedError as EINTR.
        raise RuntimeError("OWNED_CONTROL_RUNNER_INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    root = Path(__file__).resolve().parents[3]
    destination = Path(args.evidence)
    assert destination.is_absolute() and not destination.exists(), "EXCLUSIVE_CONTROL_EVIDENCE_REQUIRED"
    destination.mkdir(mode=0o700)
    tools = {name: custody.absolute_file(getattr(args, name)) for name in ("node", "tsx", "python")}
    contract = custody.absolute_file(args.contract)
    before = custody.freeze(root, tools, contract)
    custody.write(destination / "source-freeze-before.json", before)
    environment = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")}
    secrets = []
    targets = set()
    for role in ("ADMIN", "APP", "WORKER"):
        key = "FINNOR_W1_RECOVERY_C_" + role + "_URL"
        value = os.environ.get(key, "")
        url = urlsplit(value)
        assert url.scheme in ("postgres", "postgresql") and url.hostname in ("127.0.0.1", "localhost", "::1"), "EXISTING_LOOPBACK_CONTROL_DATABASE_REQUIRED"
        assert url.path not in ("", "/") and not url.query, "EXPLICIT_UNREDIRECTED_CONTROL_DATABASE_REQUIRED"
        if role != "ADMIN":
            assert url.username == ("finnor_app" if role == "APP" else "finnor_worker"), "EXISTING_RESTRICTED_CONTROL_ROLE_REQUIRED"
        environment[key] = value
        targets.add((url.hostname, url.port or 5432, url.path))
        secrets.extend([value, unquote(url.password or "")])
    assert len(targets) == 1, "ONE_ORIGINAL_CONTROL_DATABASE_REQUIRED"
    environment.update(NODE_ENV="test", AUTH_DEV_BYPASS="1", FINNOR_P4_PROFILE="ordinary_disposable",
        FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_TEST_MANAGED_EXTENSIONS="omit", P3_GOVERNORS="1",
        FINNOR_S3_PYTHON=str(tools["python"]), FINNOR_S5_PYTHON=str(tools["python"]), FINNOR_TEST_PYTHON=str(tools["python"]),
        FINNOR_W1_RECOVERY_TSX=str(tools["tsx"]), FINNOR_W1_RECOVERY_PHASE=args.phase,
        FINNOR_W1_RECOVERY_EVIDENCE=str(destination), DATABASE_URL=environment["FINNOR_W1_RECOVERY_C_APP_URL"],
        FINNOR_P2_WORKER_DATABASE_URL=environment["FINNOR_W1_RECOVERY_C_WORKER_URL"],
        FINNOR_M1_STORE=str(destination / "m1-store"), FINNOR_S3_MODEL_STORE=str(destination / "s3-store"),
        FINNOR_S4_POLICY_STORE=str(destination / "s4-store"))
    oracle = Path(__file__).with_name("control-recovery-oracle.py")

    def run(command, limit, name):
        remaining = min(limit, RUNNER_LIMIT_SECONDS - (time.monotonic() - began) - 5)
        assert remaining > 0, "ORIGINAL_CONTROL_RUNNER_BOUND_EXHAUSTED"
        child = subprocess.Popen([str(x) for x in command], cwd=root / "finnor-os", env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        expired = False
        try:
            output, _ = child.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            expired = True
            os.killpg(child.pid, signal.SIGKILL)
            output, _ = child.communicate(timeout=5)
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
        text = output.decode("utf8", errors="replace")
        for secret in sorted(set(secrets), key=len, reverse=True):
            if secret:
                text = text.replace(secret, "[REDACTED]")
        (destination / (name + ".log")).write_text(text)
        result = {"pid": child.pid, "exitCode": child.returncode, "timedOut": expired, "outputBytes": len(output)}
        custody.write(destination / (name + ".json"), result)
        assert not expired and len(output) <= 8 * 1024 * 1024, "FINITE_CONTROL_PROCESS_BOUND"
        return result

    baseline_sha = None
    if args.phase == "repaired":
        assert args.baseline, "ACTUAL_CONTROL_FIRST_FAILURE_REQUIRED"
        baseline_path = custody.absolute_file(args.baseline)
        baseline_raw = baseline_path.read_bytes()
        baseline_sha = hashlib.sha256(baseline_raw).hexdigest()
        checked = destination / "baseline-independent-oracle.json"
        process = run([tools["python"], oracle, baseline_path, "--output", checked], 10, "baseline-oracle-process")
        baseline = json.loads(baseline_raw)
        check = json.loads(checked.read_bytes())
        assert process["exitCode"] == 1 and check["expectedFailureMatch"] and check["originalObservationsSha256"] == baseline_sha, "EXACT_CONTROL_FIRST_FAILURE_RECHECK_REQUIRED"
        old = baseline["runnerFreezeBefore"]
        assert {k: v for k, v in before["files"].items() if k != CONTROLLER} == {k: v for k, v in old["files"].items() if k != CONTROLLER}, "ONLY_CONTROL_REPLANNER_MAY_DIFFER"
        assert before["tools"] == old["tools"] and before["registeredContract"] == old["registeredContract"], "CONTROL_TOOLS_OR_CONTRACT_CHANGED"
    else:
        assert not args.baseline, "BROKEN_CONTROL_EPOCH_CANNOT_SUBSTITUTE_BASELINE"
    process = run([tools["node"], "--max-old-space-size=2048",
        "--import=" + str(root / "finnor-os/scripts/postz-w1/read-network-guard.mjs"),
        "--import=" + str(tools["tsx"]), Path(__file__).with_name("control-recovery-e2e.mts")], 280, "driver-process")
    observed_path = destination / "observations.json"
    observed = json.loads(observed_path.read_bytes())
    after = custody.freeze(root, tools, contract)
    observed.update(runnerFreezeBefore=before, runnerFreezeAfter=after, baselineObservationsSha256=baseline_sha)
    custody.write(observed_path, observed)
    checked = destination / "independent-recovery-oracle.json"
    oracle_process = run([tools["python"], oracle, observed_path, "--output", checked], 10, "oracle-process")
    check = json.loads(checked.read_bytes())
    terminal = custody.freeze(root, tools, contract)
    baseline_unchanged = baseline_sha is None or hashlib.sha256(Path(args.baseline).read_bytes()).hexdigest() == baseline_sha
    source_same = before == after == terminal
    elapsed = (time.monotonic() - began) * 1000
    passed = args.phase == "repaired" and process["exitCode"] == oracle_process["exitCode"] == 0 and check["status"] == "PASS"
    expected = args.phase == "broken" and process["exitCode"] == 0 and oracle_process["exitCode"] == 1 and check["expectedFailureMatch"]
    complete = source_same and baseline_unchanged and elapsed <= RUNNER_LIMIT_SECONDS * 1000
    result = {"status": "PASS" if passed and complete else "FAIL", "phase": args.phase,
        "expectedFailureMatch": bool(expected and complete), "terminalSourceFreezeMatches": source_same,
        "baselineUnchanged": baseline_unchanged, "baselineObservationsSha256": baseline_sha,
        "totalWallMs": elapsed, "runnerBoundMs": RUNNER_LIMIT_SECONDS * 1000, "oracle": check,
        "driverProcess": process, "oracleProcess": oracle_process,
        "billingUSD": None, "completeChildUsage": None, "measurementCut": "AFTER_ORACLE_AND_TERMINAL_FREEZE_BEFORE_PACKAGING"}
    custody.write(destination / "source-freeze-terminal.json", terminal)
    custody.write(destination / "result.json", result)
    print(json.dumps(result))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
