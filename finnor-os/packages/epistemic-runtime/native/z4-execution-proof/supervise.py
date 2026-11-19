"""Credential-free, bounded scientific subprocess. No network or owner adapter."""
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import time

MAX = 8*1024*1024


def main():
    if len(sys.argv) != 5: raise ValueError("Z4_SUPERVISOR_ARGUMENTS")
    operation, milliseconds, memory, cpu = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    if operation not in {"identity", "plan", "commit", "interpret", "prove", "verify"}:
        raise ValueError("Z4_SUPERVISOR_OPERATION")
    if not 1 <= milliseconds <= 900000 or not 128*1024*1024 <= memory <= 2*1024*1024*1024 or not 1 <= cpu <= 900:
        raise ValueError("Z4_SUPERVISOR_LIMITS")
    payload = sys.stdin.buffer.read(MAX+1)
    if len(payload) > MAX: raise ValueError("Z4_PROCESS_INPUT_BOUND")
    binary = Path(__file__).resolve().parent/"bin"/"z4-proof"

    def restrict():
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))

    started = time.monotonic()
    proc = subprocess.Popen([str(binary), operation], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            cwd=binary.parent, close_fds=True, preexec_fn=restrict,
                            env={"PATH": "/usr/bin:/bin", "RAYON_NUM_THREADS": "2"})
    def cancelled(signum, frame):
        proc.kill()
        proc.communicate()
        sys.exit(128+signum)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    timeout = False
    try:
        out, err = proc.communicate(payload, timeout=milliseconds/1000)
    except subprocess.TimeoutExpired:
        timeout = True
        proc.kill()
        out, err = proc.communicate()
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    # The native executable cannot emit unbounded stdout: all requests and proof
    # encodings are bounded internally. Preserve non-success status independently.
    if len(out) > MAX or len(err) > 65536: raise ValueError("Z4_PROCESS_OUTPUT_BOUND")
    code = "Z4_PROCESS_TIMEOUT" if timeout else "Z4_PROCESS_FAILED"
    try:
        native = json.loads(out)
        if native.get("ok") is False:
            value = native.get("code", "")
            if isinstance(value, str) and value.startswith("Z4_") and len(value) <= 160:
                code = value
    except (ValueError, AttributeError):
        native = None
    body = {"ok": proc.returncode == 0 and not timeout and native is not None and native.get("ok") is True,
            "code": code, "native": native,
            "meters": {"exitCode": proc.returncode, "timedOut": timeout,
                       "wallMs": round((time.monotonic()-started)*1000),
                       "cpuMicros": round((usage.ru_utime+usage.ru_stime)*1000000),
                       "peakRSSBytes": usage.ru_maxrss*1024,
                       "inputBytes": len(payload), "outputBytes": len(out),
                       "stderrBytes": len(err), "usd": None,
                       "aggregateProcessRSS": None, "humanSeconds": None}}
    print(json.dumps(body, separators=(",", ":")))
    return 0 if body["ok"] else 1


if __name__ == "__main__":
    try: sys.exit(main())
    except Exception:
        print(json.dumps({"ok": False, "code": "Z4_SUPERVISOR_FAILED", "native": None, "meters": None}))
        sys.exit(1)
