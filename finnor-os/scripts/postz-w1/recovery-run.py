"""Parent-run only: two physical cases, fixed clocks, immutable baseline gate.

No credentials are accepted on the command line or saved in evidence.
The database URLs are environment-only and must point to existing disposable
fixtures. This runner never provisions roles, permissions, signers, or databases.
"""
import argparse
import hashlib
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

API = "finnor-os/packages/private-equity/src/compute-search/api.ts"
BROKEN_SHA = "9432cef52e0431c3543c3811cfdcf2fd038b67b6ef9717050fc344b7ff6fdb13"
REPAIRED_SHA = "2914d5fd14a85b91bf742d3a1878b77a8f894835164a781300298b3a195ed192"
DB_KEYS = [f"FINNOR_W1_RECOVERY_{track}_{role}_URL"
           for track in ("A", "B") for role in ("ADMIN", "APP", "WORKER")]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def absolute_file(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise ValueError("RUNNER_ABSOLUTE_EXISTING_FILE_REQUIRED")
    # A venv executable is a symlink; invoking its resolved base loses its deps.
    return path.absolute()


def freeze(repo, tools, contract):
    files = {}
    suffixes = {".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".py", ".m", ".sql", ".json"}
    for folder in ("packages", "apps", "scripts"):
        for directory, names, paths in os.walk(repo / "finnor-os" / folder):
            names[:] = sorted(n for n in names if n not in ("node_modules", "__pycache__", "dist", "build")
                              and not n.startswith("."))
            for name in sorted(paths):
                path = Path(directory) / name
                if path.suffix in suffixes:
                    files[path.relative_to(repo).as_posix()] = sha(path.read_bytes())
    for relative in ("package-lock.json", "finnor-os/package-lock.json",
                     "scope-postz/w1-economic-orchestration/native/physical-recovery-contract.md"):
        files[relative] = sha((repo / relative).read_bytes())
    return {"files": files, "tools": {name: {"path": str(path), "resolvedPath": str(path.resolve()), "sha256": sha(path.read_bytes())}
                                     for name, path in tools.items()},
            "registeredContract": {"path": str(contract), "sha256": sha(contract.read_bytes())}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--tsx", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--phase", choices=("broken", "repaired"), required=True)
    parser.add_argument("--baseline")
    parser.add_argument("--disposable-local-fixtures", action="store_true", required=True)
    args = parser.parse_args()
    start = time.monotonic()
    def deadline_expired(_signal, _frame):
        raise TimeoutError("TOTAL_RUNNER_300S_BOUND")
    def runner_terminated(_signal, _frame):
        raise InterruptedError("OWNED_RUNNER_TERMINATED")
    signal.signal(signal.SIGALRM, deadline_expired)
    signal.signal(signal.SIGTERM, runner_terminated)
    signal.setitimer(signal.ITIMER_REAL, 300)
    repo = Path(__file__).resolve().parents[3]
    evidence = Path(args.evidence)
    if not evidence.is_absolute() or evidence.exists():
        raise ValueError("NEW_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED")
    evidence.mkdir(parents=True, mode=0o700)
    tools = {name: absolute_file(getattr(args, name)) for name in ("node", "tsx", "python")}
    contract = absolute_file(args.contract)
    for name in ("node", "python"):
        if not os.access(tools[name], os.X_OK):
            raise ValueError("RUNNER_EXECUTABLE_REQUIRED")
    urls = {key: os.environ.get(key, "") for key in DB_KEYS}
    secrets = []
    targets = {}
    for key, value in urls.items():
        if not value:
            raise ValueError("RUNNER_EXISTING_DATABASE_URL_REQUIRED:" + key)
        url = urlsplit(value)
        if url.scheme not in ("postgres", "postgresql") or url.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("RUNNER_LOOPBACK_DATABASE_REQUIRED")
        if not url.path or url.path == "/":
            raise ValueError("RUNNER_EXPLICIT_DATABASE_REQUIRED")
        expected = "finnor_app" if "_APP_" in key else "finnor_worker" if "_WORKER_" in key else None
        if expected and url.username != expected:
            raise ValueError("RUNNER_EXISTING_ROLE_REQUIRED")
        targets[key] = (url.port or 5432, url.path)
        secrets.extend([value, unquote(url.password or "")])
    for track in ("A", "B"):
        if len({targets[f"FINNOR_W1_RECOVERY_{track}_{role}_URL"] for role in ("ADMIN", "APP", "WORKER")}) != 1:
            raise ValueError("ONE_DATABASE_PER_TRACK_REQUIRED")
    if targets[DB_KEYS[0]] == targets[DB_KEYS[3]]:
        raise ValueError("SEPARATE_DEDICATED_TRACK_DATABASES_REQUIRED")

    def redact(text):
        for secret in sorted(set(secrets), key=len, reverse=True):
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text

    def left(cap, reserve=0):
        value = min(cap, 300 - (time.monotonic() - start) - reserve)
        if value <= 0:
            raise TimeoutError("TOTAL_RUNNER_300S_BOUND")
        return value

    environment = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")}
    environment.update(urls)
    environment.update(NODE_ENV="test", AUTH_DEV_BYPASS="1", FINNOR_P4_PROFILE="ordinary_disposable",
                       FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_TEST_MANAGED_EXTENSIONS="omit",
                       FINNOR_S3_PYTHON=str(tools["python"]), FINNOR_S5_PYTHON=str(tools["python"]),
                       FINNOR_TEST_PYTHON=str(tools["python"]), FINNOR_W1_RECOVERY_TSX=str(tools["tsx"]),
                       FINNOR_W1_RECOVERY_PHASE=args.phase)
    oracle = repo / "finnor-os/scripts/postz-w1/recovery-oracle.py"

    def process(command, env, timeout, log):
        before = time.monotonic()
        child = subprocess.Popen(command, cwd=repo / "finnor-os", env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        try:
            output, _ = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGKILL)
            output, _ = child.communicate()
        finally:
            # This is timeout/leak cleanup, never the scored exact-victim kill.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
        text = redact(output.decode("utf8", errors="replace"))
        log.write_text(text)
        log.chmod(0o600)
        result = {"pid": child.pid, "exitCode": child.returncode, "timedOut": timed_out,
                  "wallMs": (time.monotonic() - before) * 1000, "command": [str(x) for x in command]}
        if len(output) > 8 * 1024 * 1024:
            result["outputBoundExceeded"] = True
        return result

    before = freeze(repo, tools, contract)
    expected = BROKEN_SHA if args.phase == "broken" else REPAIRED_SHA
    if before["files"].get(API) != expected:
        raise ValueError("EXACT_FROZEN_API_PREIMAGE_REQUIRED")
    write(evidence / "source-freeze-before.json", before)
    baseline = None
    baseline_sha = None
    if args.phase == "repaired":
        if not args.baseline:
            raise ValueError("RETAINED_FIRST_BROKEN_OBSERVATIONS_REQUIRED")
        baseline_path = absolute_file(args.baseline)
        baseline_raw = baseline_path.read_bytes()
        baseline_sha = sha(baseline_raw)
        baseline = json.loads(baseline_raw)
        receipt = evidence / "baseline-independent-recheck.json"
        result = process([str(tools["python"]), str(oracle), str(baseline_path), "--output", str(receipt)],
                         environment, left(10, 20), evidence / "baseline-independent-recheck.log")
        write(evidence / "baseline-oracle-process.json", result)
        checked = json.loads(receipt.read_bytes())
        if result["exitCode"] != 1 or result["timedOut"] or not checked.get("expectedFailureMatch") \
                or checked["originalObservationsSha256"] != baseline_sha:
            raise ValueError("FIRST_FAILURE_MUST_BE_EXACT_PLAN_KEY_STUCK_WITH_TRACK_B_PASS")
        if baseline["phase"] != "broken":
            raise ValueError("BROKEN_BASELINE_REQUIRED")
        baseline_files = {x["path"]: x["sha256"] for x in baseline["productionIdentity"]["files"]}
        if baseline_files.get(API) != BROKEN_SHA:
            raise ValueError("BASELINE_API_PREIMAGE_REQUIRED")
        if {k: v for k, v in baseline["runnerFreezeBefore"]["files"].items() if k != API} != \
                {k: v for k, v in before["files"].items() if k != API} \
                or baseline["runnerFreezeBefore"]["tools"] != before["tools"] \
                or baseline["runnerFreezeBefore"]["registeredContract"] != before["registeredContract"]:
            raise ValueError("ONLY_API_MAY_DIFFER_BETWEEN_FROZEN_EPOCHS")
        write(evidence / "baseline-custody.json", {"path": str(baseline_path), "sha256": baseline_sha,
                                                 "predicate": checked["predicate"], "originalNotModified": True})
    elif args.baseline:
        raise ValueError("BROKEN_PHASE_CANNOT_SUBSTITUTE_A_PRIOR_RUN")

    runs = []
    observations = []
    for track in ("A", "B"):
        destination = evidence / (track + "-runtime")
        destination.mkdir(mode=0o700)
        # Set these before any production import, including import-time stores.
        env = dict(environment, FINNOR_W1_RECOVERY_TRACK=track, FINNOR_W1_RECOVERY_EVIDENCE=str(destination),
                   DATABASE_URL=urls[f"FINNOR_W1_RECOVERY_{track}_APP_URL"],
                   FINNOR_P2_WORKER_DATABASE_URL=urls[f"FINNOR_W1_RECOVERY_{track}_WORKER_URL"],
                   FINNOR_M1_STORE=str(destination / track / "m1-store"),
                   FINNOR_S3_MODEL_STORE=str(destination / track / "s3-store"),
                   FINNOR_S4_POLICY_STORE=str(destination / track / "s4-store"))
        command = [str(tools["node"]), "--max-old-space-size=2048",
                   "--import=" + str(repo / "finnor-os/scripts/postz-w1/read-network-guard.mjs"),
                   "--import=" + str(tools["tsx"]), str(repo / "finnor-os/scripts/postz-w1/recovery-e2e.mts")]
        result = process(command, env, left(120, 20), destination / "driver-process.log")
        result["track"] = track
        runs.append(result)
        write(destination / "driver-process.json", result)
        raw = destination / "observations.json"
        if raw.exists():
            observed = json.loads(raw.read_bytes())
            for case in observed["cases"]:
                case["artifactDirectory"] = track + "-runtime/" + track
            observations.append(observed)
        else:
            observations.append({"cases": [{"track": track, "error": {"message": "NO_DRIVER_OBSERVATIONS"},
                                            "status": "DRIVER_FAILED"}]})
        # Do not hide A's first failure just because the independent B case fails.

    after = freeze(repo, tools, contract)
    write(evidence / "source-freeze-after.json", after)
    combined = dict(observations[0])
    combined["cases"] = [case for o in observations for case in o["cases"]]
    combined["runnerFreezeBefore"] = before
    combined["runnerFreezeAfter"] = after
    combined["runner"] = {"driverProcesses": runs, "totalWallMs": (time.monotonic() - start) * 1000,
                          "boundMs": 300000, "oracleStillToRun": True, "environmentNamesOnly": sorted(environment)}
    combined["network"] = {"installed": all(o.get("network", {}).get("installed") for o in observations),
                           "blockedExternalAttempts": sum(o.get("network", {}).get("blockedExternalAttempts", 0) for o in observations)}
    for o in observations:
        if o.get("productionIdentity") != combined.get("productionIdentity") \
                or o.get("finalProductionIdentity") != combined.get("finalProductionIdentity") or o.get("freezeFailure"):
            combined["freezeFailure"] = "FROZEN_TRACK_PRODUCTION_IDENTITIES_DIFFER"
    combined["baselineObservationsSha256"] = baseline_sha
    combined_path = evidence / "observations.json"
    write(combined_path, combined)
    oracle_path = evidence / "independent-recovery-oracle.json"
    oracle_process = process([str(tools["python"]), str(oracle), str(combined_path), "--output", str(oracle_path)],
                             environment, left(10), evidence / "independent-recovery-oracle.log")
    write(evidence / "oracle-process.json", oracle_process)
    checked = json.loads(oracle_path.read_bytes())
    terminal_freeze = freeze(repo, tools, contract)
    write(evidence / "source-freeze-terminal.json", terminal_freeze)
    elapsed_ms = (time.monotonic() - start) * 1000
    baseline_unchanged = baseline is None or sha(absolute_file(args.baseline).read_bytes()) == baseline_sha
    pass_run = (args.phase == "repaired" and oracle_process["exitCode"] == 0 and checked["status"] == "PASS"
                and before == after == terminal_freeze and elapsed_ms <= 300000 and baseline_unchanged
                and all(not p["timedOut"] and not p.get("outputBoundExceeded") and p["exitCode"] == 0 for p in runs))
    final = {"status": "PASS" if pass_run else "FAIL", "phase": args.phase,
             "expectedFailureMatch": bool(args.phase == "broken" and checked.get("expectedFailureMatch")),
             "oracle": checked, "totalWallMs": elapsed_ms, "runnerBoundMs": 300000,
             "baselineObservationsSha256": baseline_sha, "baselineUnchanged": baseline_unchanged,
             "terminalSourceFreezeMatches": before == after == terminal_freeze,
             "measurementCut": "AFTER_ORACLE_AND_TERMINAL_FREEZE_BEFORE_FINAL_PACKAGING",
             "finalPackagingTailUSD": None, "billingUSD": None, "completeChildUsage": None,
             "validation": "EXECUTED_BY_PARENT_RUNNER"}
    write(evidence / "result.json", final)
    inventory = {}
    for path in sorted(evidence.rglob("*")):
        if path.is_file():
            inventory[path.relative_to(evidence).as_posix()] = {"sha256": sha(path.read_bytes()), "bytes": path.stat().st_size}
    write(evidence / "evidence-sha256.json", {"schema": "finnor.w1.recovery-evidence-manifest.v2", "files": inventory})
    completion_ms = (time.monotonic() - start) * 1000
    write(evidence / "runner-exit.json", {"status": final["status"], "wallMsThroughPackaging": completion_ms,
                                         "boundMs": 300000, "costUSD": None, "manifestExcludesOwnBytesAndThisExitReceipt": True})
    signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps({"status": final["status"], "expectedFailureMatch": final["expectedFailureMatch"],
                      "result": str(evidence / "result.json"), "totalWallMs": completion_ms}))
    return 0 if pass_run else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # A URL parser may put input in attributes or text. Only our fixed
        # uppercase predicates are safe to echo; never dump exception objects.
        message = str(error).splitlines()[0] if str(error) else "RUNNER_FAILED"
        if any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:" for c in message):
            message = "RUNNER_PRECONDITION_OR_IO_FAILED"
        print(json.dumps({"status": "FAIL", "predicate": type(error).__name__, "message": message}))
        raise SystemExit(2)
