"""Linux-owned child lifetime meter. No authentication or sandbox claim.

The private input pipe stays empty until the caller durably records the real
child PID from fd 3. wait4 measures the exited child, not a self-reported sample.
Parent death kills the supervisor and its direct child; the executable set is
fixed by processes.ts, never by an authenticated request.
"""
import ctypes
import json
import os
import resource
import signal
import sys
import threading
import time


def parent_death_signal():
    parent = os.getppid()
    if parent == 1 or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL) != 0:
        raise RuntimeError("OWNED_PARENT_DEATH_BINDING_REQUIRED")
    if os.getppid() != parent:
        os.kill(os.getpid(), signal.SIGKILL)


def report(value):
    os.write(3, (json.dumps(value, separators=(",", ":")) + "\n").encode())


def main():
    parent_death_signal()
    wall_ms = int(sys.argv[1])
    if not 0 < wall_ms <= 30000 or len(sys.argv) < 3:
        raise RuntimeError("BOUNDED_FIXED_CHILD_REQUIRED")
    started = time.monotonic_ns()
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            parent_death_signal()
            os.close(write_end)
            os.dup2(read_end, 0)
            os.close(read_end)
            os.close(3)
            resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
            resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
            resource.setrlimit(resource.RLIMIT_FSIZE, (134217728, 134217728))
            if os.path.basename(sys.argv[2]).startswith("python3"):
                resource.setrlimit(resource.RLIMIT_AS, (1610612736, 1610612736))
            os.execvpe(sys.argv[2], sys.argv[2:], dict(os.environ))
        except BaseException:
            os._exit(125)
    os.close(read_end)
    report({"kind": "START", "pid": child, "supervisorPid": os.getpid()})

    def forward():
        total = 0
        try:
            while True:
                chunk = os.read(0, 65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > 134217728:
                    os.kill(child, signal.SIGKILL)
                    break
                view = memoryview(chunk)
                while view:
                    view = view[os.write(write_end, view):]
        except (BrokenPipeError, OSError):
            pass
        finally:
            os.close(write_end)

    threading.Thread(target=forward, daemon=True).start()

    def expired(_signum, _frame):
        os.kill(child, signal.SIGKILL)

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, wall_ms / 1000)
    _pid, status, usage = os.wait4(child, 0)
    signal.setitimer(signal.ITIMER_REAL, 0)
    own = resource.getrusage(resource.RUSAGE_SELF)
    report({
        "kind": "FINISH", "pid": child, "supervisorPid": os.getpid(),
        "exitCode": os.waitstatus_to_exitcode(status),
        "wallMicros": (time.monotonic_ns() - started) // 1000,
        "cpuMicros": int((usage.ru_utime + usage.ru_stime) * 1000000),
        "peakRSSBytes": usage.ru_maxrss * 1024,
        "blockInputs": usage.ru_inblock, "blockOutputs": usage.ru_oublock,
        "supervisorCpuMicros": int((own.ru_utime + own.ru_stime) * 1000000),
        "supervisorPeakRSSBytes": own.ru_maxrss * 1024,
        "supervisorMeasurementScope": "SELF_THROUGH_PRE_FINISH_REPORT_EXIT_TAIL_UNKNOWN",
        "scope": "WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR",
    })
    return 0 if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        os.write(2, b"Z1_OWNED_SUPERVISOR_INCOMPLETE\n")
        sys.exit(1)
