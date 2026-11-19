"""Portable shared-host admission and exact owned-session/namespace cleanup."""
import argparse
from datetime import datetime, timezone
import errno
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from campaign_runtime import ResourcePolicy, host_facts, sha
from disposable_cleanup import cleanup_namespace

ROOT = Path(__file__).resolve().parents[3]


def now():
    return datetime.now(timezone.utc).isoformat()


class FileLock:
    """Keep one stable inode locked until its owned descriptor is closed."""
    def __init__(self, path):
        self.path = Path(path)
        self.fd = None
        self.identity = None

    def acquire(self):
        assert self.fd is None, "LOCK_ALREADY_HELD"
        flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
        fd = os.open(self.path, flags, 0o600)
        try:
            owner = os.fstat(fd)
            assert stat.S_ISREG(owner.st_mode) and owner.st_uid == os.getuid(), "OWNED_REGULAR_LOCK_FILE_REQUIRED"
            assert not self.path.is_symlink() and self.path.stat().st_ino == owner.st_ino
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EAGAIN):
                    return False
                raise
            self.fd, self.identity = fd, (owner.st_dev, owner.st_ino)
            fd = None
            return True
        finally:
            if fd is not None:
                os.close(fd)

    def owner(self, value):
        assert self.fd is not None
        os.ftruncate(self.fd, 0)
        os.write(self.fd, (json.dumps(value) + "\n").encode())
        os.fsync(self.fd)

    def release(self):
        assert self.fd is not None and self.identity is not None
        fd, self.fd = self.fd, None
        try:
            current = self.path.lstat()
            assert stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid()
            assert (current.st_dev, current.st_ino) == self.identity, "OWNED_LOCK_IDENTITY_CHANGED"
            return {"path": str(self.path), "status": "PASS", "inodeRetained": True}
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--heavy", action="store_true")
    parser.add_argument("--forecast-bytes", type=int, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--timeout", type=int, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not args.receipt.is_absolute() or args.receipt.exists() or args.timeout <= 0:
        raise ValueError("NEW_ABSOLUTE_RECEIPT_FINITE_TIMEOUT_AND_COMMAND_REQUIRED")
    if not args.plan.is_absolute():
        raise ValueError("ABSOLUTE_FROZEN_PLAN_REQUIRED")
    plan = json.loads(args.plan.read_text())
    if plan["state"] != "FROZEN_EXECUTABLE_W1_SCOPED_NOT_COMPLETE":
        raise ValueError("FROZEN_PLAN_REQUIRED")
    policy = ResourcePolicy.parse(plan["resourcePolicy"])
    if not 0 <= args.forecast_bytes <= policy.laneNetNewBudgetBytes:
        raise ValueError("FORECAST_MUST_FIT_FROZEN_LANE_DISK_BUDGET")
    if os.environ.get("FINNOR_W1_RESOURCE_PARENT"):
        raise RuntimeError("NESTED_RESOURCE_WRAPPER_FORBIDDEN")
    policy.coordinationDirectory.mkdir(exist_ok=True, parents=True)
    record = {"schema": "finnor.w1.shared-host-run.v2", "startedAt": now(), "status": "NOT_RUN",
        "command": command, "heavy": args.heavy, "planSha256": sha(args.plan),
        "diskBefore": host_facts(ROOT)["filesystem"]["freeBytes"],
        "forecastBytes": args.forecast_bytes, "globalFloorBytes": policy.globalDiskFloorBytes,
        "laneNetNewBudgetBytes": policy.laneNetNewBudgetBytes, "resourcePolicy": policy.record(),
        "childTimeoutSeconds": args.timeout, "childExitCode": None,
        "billingUSD": None, "humanSeconds": None, "completeDescendantUsage": None}
    held = []
    child = temporary = temporary_identity = None
    started = time.monotonic()

    def free():
        facts = host_facts(ROOT)
        record["hostLatest"] = facts
        return facts["filesystem"]["freeBytes"]

    def capacity(before_launch=False):
        available = free()
        if available - (args.forecast_bytes if before_launch else 0) < policy.globalDiskFloorBytes:
            raise RuntimeError("GLOBAL_DISK_FLOOR_CHANGED_BEFORE_LAUNCH" if before_launch else "GLOBAL_DISK_FLOOR_DURING_CHILD")
        if record["diskBefore"] - available > policy.laneNetNewBudgetBytes:
            raise RuntimeError("FROZEN_LANE_NET_NEW_DISK_BUDGET_EXHAUSTED")

    def event(name):
        entry = {"at": now(), "lane": "W1", "event": name, "receipt": str(args.receipt), "freeBytes": free()}
        fd = os.open(policy.coordinationDirectory / "ledger.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, (json.dumps(entry, separators=(",", ":")) + "\n").encode())
        finally:
            os.close(fd)

    def acquire(paths):
        while time.monotonic() - started < policy.lockWaitSeconds:
            for path in paths:
                lock = FileLock(path)
                if lock.acquire():
                    held.append(lock)
                    lock.owner({"lane": "W1", "at": now(), "receipt": str(args.receipt), "pid": os.getpid()})
                    return
            time.sleep(0.1)
        raise TimeoutError("SHARED_RESOURCE_LOCK_20_MINUTE_BOUND")

    def interrupted(_signal, _frame):
        raise InterruptedError("OWNED_RESOURCE_WRAPPER_INTERRUPTED")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        if free() - args.forecast_bytes < policy.globalDiskFloorBytes:
            raise RuntimeError("GLOBAL_DISK_FLOOR_PREFLIGHT")
        if args.heavy:
            policy.heavyLockPath.parent.mkdir(parents=True, exist_ok=True)
            acquire([policy.heavyLockPath])
        acquire([policy.coordinationDirectory / "mediumslot-1.lock", policy.coordinationDirectory / "mediumslot-2.lock"])
        record["locksAcquiredAt"] = now()
        if args.heavy:
            while True:
                facts = host_facts(ROOT)
                record["hostBefore"] = facts
                if (facts["loadAverage"][0] <= facts["cpuCapacity"] * policy.maximumLoadFraction
                        and facts["memory"]["availableBytes"] >= policy.minimumAvailableMemoryBytes):
                    break
                if time.monotonic() - started >= policy.lockWaitSeconds:
                    raise TimeoutError("ACTUAL_HOST_CAPACITY_NOT_AVAILABLE_BEFORE_TIMING_RUN")
                capacity(before_launch=True)
                time.sleep(1)
        capacity(before_launch=True)
        event("start")
        record["childStartedAt"] = now()
        temporary = Path(tempfile.mkdtemp(prefix="finnor-w1-run-", dir="/tmp")).resolve(strict=True)
        identity = temporary.stat()
        temporary_identity = (identity.st_dev, identity.st_ino)
        record["childTemporaryNamespace"] = str(temporary)
        child = subprocess.Popen(command, cwd=ROOT, env=dict(os.environ, TMPDIR=str(temporary),
            FINNOR_W1_RESOURCE_PARENT=str(uuid.uuid4())), start_new_session=True)
        deadline = time.monotonic() + args.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                record["timedOut"] = True
                raise TimeoutError("FROZEN_CHILD_TIMEOUT")
            try:
                record["childExitCode"] = child.wait(timeout=min(2, remaining))
                break
            except subprocess.TimeoutExpired:
                capacity()
        capacity()
        record["status"] = "PASS" if child.returncode == 0 else "FAIL"
    except Exception as error:
        record.update(status="FAIL" if child else "NOT_RUN", failure=str(error), failureType=type(error).__name__)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if child:
            try:
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(child.pid, sig)
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=10 if sig == signal.SIGTERM else 5)
                    except subprocess.TimeoutExpired:
                        if sig == signal.SIGKILL:
                            raise
                record["terminalChildExitCode"] = child.returncode
                if record["status"] == "PASS" and child.returncode != 0:
                    record["status"] = "FAIL"
            except Exception as error:
                record.update(status="FAIL", childTerminationFailure=repr(error))
        if temporary:
            try:
                record["disposableCleanup"] = cleanup_namespace(temporary, identity=temporary_identity)
            except Exception as error:
                record.update(status="FAIL", disposableCleanup={"status": "FAIL",
                    "directory": str(temporary), "failure": repr(error)})
        record["lockReleases"] = []
        for lock in reversed(held):
            try:
                release = lock.release()
            except Exception as error:
                record["status"] = "FAIL"
                release = {"path": str(lock.path), "status": "FAIL", "failure": repr(error)}
            record["lockReleases"].append(release)
        record.update(completedAt=now(), wallSeconds=time.monotonic() - started, diskAfter=free())
        try:
            event("finish-" + record["status"])
        except Exception as error:
            record.update(status="FAIL", coordinationLedgerFailure=repr(error))
        args.receipt.parent.mkdir(exist_ok=True, parents=True)
        with args.receipt.open("x") as out:
            json.dump(record, out, indent=2)
            out.write("\n")
    print(json.dumps({key: record[key] for key in ("status", "childExitCode", "wallSeconds", "diskBefore", "diskAfter")}))
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
