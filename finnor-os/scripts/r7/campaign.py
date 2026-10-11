"""Serial, non-renewable R7 campaign supervisor; stdlib, no ambient credentials.

The registration, not a phase or restart, owns the absolute 3600-second expiry.
This is an operational guard, not protected admission or a complete cost meter.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(pathlib.Path(path).read_text())


def save(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".writing")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def remaining(reg):
    wall = dt.datetime.fromisoformat(reg["deadlineAt"]).timestamp() - time.time()
    return min(wall, reg["deadlineMonotonicSeconds"] - time.monotonic())


def bytes_under(root):
    # Evidence quota counts durable evidence/specs/logs only. Phase tmp holds
    # regenerable disposable databases and isolated HOME, separately guarded by
    # the disk reserve; it is not evidence and is not counted here.
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs
                   if d != "tmp" and not (pathlib.Path(directory) / d).is_symlink()]
        for name in files:
            p = pathlib.Path(directory) / name
            try:
                if not p.is_symlink():
                    total += p.stat().st_size
            except FileNotFoundError:
                pass
    return total


def free_bytes(root):
    s = os.statvfs(root)
    return s.f_bavail * s.f_frsize


def processes():
    # comm, not args: never collect session tokens, SQL URLs or process secrets.
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,rss=,stat=,lstart=,comm="],
        text=True, capture_output=True, timeout=2, check=True,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
    )
    table = {}
    for line in result.stdout.splitlines():
        p = line.split(None, 10)
        if len(p) == 11:
            pid, parent, group, rss = map(int, p[:4])
            table[pid] = dict(pid=pid, ppid=parent, pgid=group, rssBytes=rss * 1024,
                              state=p[4], born=" ".join(p[5:10]), comm=p[10])
    return table


def identity(p):
    # (pid, start instant) only: a freshly spawned child legitimately changes
    # comm when its exec completes (observed as a false OWNED_PID_IDENTITY_CHANGED
    # in successor-1); born changing under the same pid detects reuse.
    return (p["pid"], p["born"])


def scrub(spec, temporary, home, control, stop, reg):
    allowed = {
        "NODE_ENV", "CI", "LOG_LEVEL", "AUTH_DEV_BYPASS", "RATE_LIMIT_PER_MINUTE",
        "FINNOR_TEST_MANAGED_EXTENSIONS", "NEXT_TELEMETRY_DISABLED", "TSX_TSCONFIG_PATH",
        "FINNOR_R7_EVIDENCE_DIR", "FINNOR_R7_SERIAL_SCHEMA", "FINNOR_R7_CASE_FILTER",
        "FINNOR_R7_ALT_PYTHON", "FINNOR_R7_PYTHON", "FINNOR_S3_PYTHON",
        "FINNOR_S5_PYTHON", "FINNOR_S5_EVIDENCE_DIR", "FINNOR_S4_POLICY_STORE",
        "FINNOR_S3_MODEL_STORE", "FINNOR_S5_CASE_FILTER", "FINNOR_R7_BOUNDARY_READY",
    }
    extra = spec.get("environment", {})
    if set(extra) - allowed:
        raise ValueError("Unregistered/unsafe inherited binding: " + str(sorted(set(extra) - allowed)))
    env = {
        "PATH": "/Users/paramdave/.local/bin:/usr/bin:/bin:/usr/sbin",
        "HOME": str(home), "TMPDIR": str(temporary), "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
        "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
        "NEXT_TELEMETRY_DISABLED": "1",
        "FINNOR_R7_CAMPAIGN_CONTROL": str(control), "FINNOR_R7_CAMPAIGN_STOP": str(stop),
        "FINNOR_R7_CAMPAIGN_DEADLINE_AT": str(int(dt.datetime.fromisoformat(reg["deadlineAt"]).timestamp() * 1000)),
        "FINNOR_R7_CAMPAIGN_SUPERVISOR_PID": str(os.getpid()),
    }
    env.update(extra)
    return env


def run_phase(registration, spec_path):
    reg_path, spec_path = pathlib.Path(registration), pathlib.Path(spec_path)
    reg, spec = read(reg_path), read(spec_path)
    root = pathlib.Path(reg["outputRoot"]).resolve()
    assert str(root).startswith(("/tmp/", "/private/tmp/")), "Explicit private temporary root required"
    assert reg["limits"]["campaignSeconds"] == 3600
    assert dt.datetime.fromisoformat(reg["deadlineAt"]) - dt.datetime.fromisoformat(reg["startedAt"]) == dt.timedelta(seconds=3600)
    limits = reg["limits"].copy()
    for key, value in spec.get("diagnosticLimits", {}).items():
        assert reg.get("diagnosticOnly"), "Diagnostic subcaps cannot replace the real campaign"
        assert key in {"maxGeneratedEvidenceBytes", "aggregateRssGuardBytes", "minimumFreeBytes"}
        assert (value >= limits[key] if key == "minimumFreeBytes" else 0 < value <= limits[key])
        limits[key] = value
    assert isinstance(spec["id"], str) and spec["id"].replace("-", "").isalnum()
    assert all(isinstance(v, str) for v in spec["argv"]) and "--browser" not in spec["argv"]
    cwd = pathlib.Path(spec["cwd"]).resolve()
    assert cwd.is_dir()
    root.mkdir(parents=True, exist_ok=True)
    journal = root / "campaign-state.json"
    reg_hash = digest(reg_path.read_bytes())
    if journal.exists():
        state = read(journal)
        assert state["registrationSha256"] == reg_hash, "Immutable registration changed on restart"
        assert state["deadlineAt"] == reg["deadlineAt"] and state["deadlineMonotonicSeconds"] == reg["deadlineMonotonicSeconds"]
        assert state["status"] == "OPEN", "Stopped/exhausted campaign cannot resume"
    else:
        state = dict(schema="finnor.r7.campaign-state.v1", registrationSha256=reg_hash,
                     startedAt=reg["startedAt"], deadlineAt=reg["deadlineAt"],
                     deadlineMonotonicSeconds=reg["deadlineMonotonicSeconds"], status="OPEN", phases=[])
        save(journal, state)
    assert spec["id"] not in state["phases"], "A phase cannot silently rerun under the same registration"
    phase_root = root / "phases" / spec["id"]
    phase_root.mkdir(parents=True, exist_ok=False)
    temporary, home = phase_root / "tmp", phase_root / "home"
    temporary.mkdir(); home.mkdir()
    control, stop = phase_root / "control.json", phase_root / "stop-request.json"
    env = scrub(spec, temporary, home, control, stop, reg)
    receipt = dict(schema="finnor.r7.global-phase-supervision.v1", phase=spec["id"],
                   registrationSha256=reg_hash, specSha256=digest(spec_path.read_bytes()),
                   startedAt=utc(), registrationStartedAt=reg["startedAt"], deadlineAt=reg["deadlineAt"],
                   deadlineMonotonicSeconds=reg["deadlineMonotonicSeconds"], command=spec["argv"],
                   cwd=str(cwd), sanitizedEnvironment=env, limits=limits, pid=None,
                   guardPredicate=None, status="INCOMPLETE", peakObservedAggregateRssBytes=0,
                   minimumFreeBytes=free_bytes(root), maximumGeneratedBytes=bytes_under(root),
                   observations=0, ownedProcesses=[], residualProcesses=[],
                   money=None, humanSeconds=None, unacknowledgedCosts="UNKNOWN",
                   qualification="Operational global guard, sampled owned RSS; not protected/all-cost/installed qualification")
    receipt["inputBindingsSha256"] = digest(json.dumps(
        {"argv": spec["argv"], "cwd": str(cwd), "environment": env}, sort_keys=True,
        separators=(",", ":")).encode())
    began = time.monotonic()
    known, child, interrupted = {}, None, []
    old_handlers = {}
    for sig in [signal.SIGTERM, signal.SIGINT]:
        old_handlers[sig] = signal.signal(sig, lambda signum, _frame: interrupted.append(signum))

    def observe():
        table = processes()
        owned = {child.pid} if child and child.pid in table else set()
        if child:
            owned.update(pid for pid, p in table.items() if p["pgid"] == child.pid)
        owned.update(pid for pid, p in table.items() if pid in known and identity(p) == identity(known[pid]))
        # PostgreSQL daemonizes before a poll can see its short-lived pg_ctl parent.
        # Its actual private postmaster.pid is an ownership witness, not a guessed PID.
        # The scan itself must tolerate the driver wiping the disposable datadir
        # mid-iteration (observed successor-7 SUPERVISION_EXCEPTION on base/4).
        try:
            witnesses = list(temporary.rglob("postmaster.pid"))
        except OSError:
            witnesses = []
        for witness in witnesses:
            try:
                pid = int(witness.read_text().splitlines()[0])
                p = table.get(pid)
                if p and pathlib.Path(p["comm"]).name == "postgres" and witness.resolve().is_relative_to(temporary.resolve()):
                    owned.add(pid)
            except (FileNotFoundError, ValueError, IndexError):
                pass
        while True:
            more = {pid for pid, p in table.items() if p["ppid"] in owned} - owned
            if not more:
                break
            owned.update(more)
        for pid in owned:
            p = table[pid]
            if pid in known and identity(p) != identity(known[pid]):
                raise RuntimeError("OWNED_PID_IDENTITY_CHANGED")
            known[pid] = p
        active = [table[pid] for pid in owned if pid in table and not table[pid]["state"].startswith("Z")]
        rss = sum(p["rssBytes"] for p in active) + table.get(os.getpid(), {}).get("rssBytes", 0)
        receipt["peakObservedAggregateRssBytes"] = max(receipt["peakObservedAggregateRssBytes"], rss)
        receipt["minimumFreeBytes"] = min(receipt["minimumFreeBytes"], free_bytes(root))
        receipt["maximumGeneratedBytes"] = max(receipt["maximumGeneratedBytes"], bytes_under(root))
        receipt["observations"] += 1
        return active

    def boundary():
        if remaining(reg) <= 0:
            return "GLOBAL_DEADLINE"
        if interrupted:
            return "SUPERVISOR_INTERRUPTED"
        if receipt["minimumFreeBytes"] < limits["minimumFreeBytes"]:
            return "DISK_RESERVE"
        if receipt["maximumGeneratedBytes"] > limits["maxGeneratedEvidenceBytes"]:
            return "EVIDENCE_QUOTA"
        if receipt["peakObservedAggregateRssBytes"] > limits["aggregateRssGuardBytes"]:
            return "AGGREGATE_RSS_QUOTA"
        if time.monotonic() - began >= spec["phaseSeconds"]:
            return "PHASE_DEADLINE"
        return None

    def send(p, sig):
        current = processes().get(p["pid"])
        if current and identity(current) == identity(p) and not current["state"].startswith("Z"):
            try:
                os.kill(p["pid"], sig)
            except ProcessLookupError:
                pass

    try:
        observe()
        receipt["guardPredicate"] = boundary()
        if receipt["guardPredicate"] is None:
            with (phase_root / "runner.log").open("wb") as log:
                child = subprocess.Popen(spec["argv"], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                receipt["pid"] = child.pid
                save(control, {"schema": "finnor.r7.campaign-control.v1", "supervisorPid": os.getpid(),
                               "deadlineAt": reg["deadlineAt"], "stopPath": str(stop)})
                while True:
                    observe()
                    receipt["guardPredicate"] = boundary()
                    if receipt["guardPredicate"] or child.poll() is not None:
                        break
                    time.sleep(limits["pollSeconds"])
                if receipt["guardPredicate"]:
                    save(stop, {"predicate": receipt["guardPredicate"], "at": utc(),
                                "deadlineAt": reg["deadlineAt"], "newDecisionWorkAllowed": False,
                                "financialReleaseOrSettlementAllowed": False})
                    receipt["stopRequestedAt"] = utc()
                    if child.pid in known:
                        send(known[child.pid], signal.SIGTERM)
                    cleanup = time.monotonic()
                    while child.poll() is None and time.monotonic() - cleanup < limits["cleanupGraceSeconds"]:
                        observe()
                        time.sleep(limits["pollSeconds"])
                    receipt["cleanupGraceWallSeconds"] = time.monotonic() - cleanup
                active = observe()
                # Even normal exit is not proof that detached work exited.
                if active and receipt["guardPredicate"] is None:
                    receipt["guardPredicate"] = "UNEXPECTED_RESIDUAL_CHILD"
                for p in reversed(active):
                    send(p, signal.SIGTERM)
                until = time.monotonic() + 2
                while observe() and time.monotonic() < until:
                    time.sleep(limits["pollSeconds"])
                for p in observe():
                    send(p, signal.SIGKILL)
                try:
                    receipt["exitCode"] = child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    receipt["exitCode"] = None
                time.sleep(limits["pollSeconds"])
                receipt["residualProcesses"] = observe()
                if receipt["residualProcesses"]:
                    receipt["guardPredicate"] = receipt["guardPredicate"] or "RESIDUAL_CHILD_UNKNOWN"
                if receipt["guardPredicate"] is None and receipt["exitCode"] == 0:
                    expected = spec.get("expectedResult")
                    if expected:
                        result = read(expected["path"])
                        actual = result["cases"]
                        ids = [v["id"] for v in actual]
                        required = expected["caseIds"]
                        if sorted(ids) != sorted(required) or any(v["status"] != "PASS" for v in actual):
                            receipt["guardPredicate"] = "FAILED_OR_MISSING_ORIGINAL_CASE"
                    if receipt["guardPredicate"] is None and remaining(reg) > 0:
                        receipt["status"] = "PASS"
                if receipt["guardPredicate"] is None and receipt["status"] != "PASS":
                    receipt["guardPredicate"] = "CHILD_PHASE_FAILED"
    except BaseException as error:
        receipt["guardPredicate"] = receipt["guardPredicate"] or "SUPERVISION_EXCEPTION"
        receipt["error"] = type(error).__name__ + ": " + str(error)
        if child:
            for p in reversed(observe()):
                send(p, signal.SIGKILL)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            receipt["residualProcesses"] = observe()
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        receipt["ownedProcesses"] = list(known.values())
        receipt["finishedAt"] = utc()
        receipt["phaseWallSeconds"] = time.monotonic() - began
        receipt["campaignElapsedSeconds"] = time.monotonic() - reg["startedMonotonicSeconds"]
        receipt["remainingSeconds"] = remaining(reg)
        state["phases"].append(spec["id"])
        if receipt["status"] != "PASS":
            state["status"] = "INCOMPLETE"
        save(journal, state)
        save(phase_root / "supervision.json", receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--registration", required=True)
    parser.add_argument("--phase", required=True)
    args = parser.parse_args()
    receipt = run_phase(args.registration, args.phase)
    print(json.dumps({k: receipt[k] for k in ["phase", "status", "guardPredicate",
                                            "phaseWallSeconds", "campaignElapsedSeconds", "remainingSeconds"]}))
    sys.exit(0 if receipt["status"] == "PASS" else 2)
