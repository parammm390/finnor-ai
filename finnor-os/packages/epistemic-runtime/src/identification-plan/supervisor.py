"""Trusted bounded native supervisor. A dead worker cannot orphan scientific work."""
import argparse
import json
import os
import pathlib
import resource
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("kind", choices=["producer", "checker"])
parser.add_argument("--deadline", type=float, required=True)
args = parser.parse_args()
parent = os.getppid()
limit = 524288 if args.kind == "producer" else 64 * 1024**2 + 524288
data = sys.stdin.buffer.read(limit + 1)
if len(data) > limit:
    raise SystemExit("R4_SUPERVISOR_INPUT_BOUND")
process = subprocess.Popen([sys.executable, "-I", str(pathlib.Path(__file__).with_name(args.kind + ".py"))],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env={"PATH": str(pathlib.Path(sys.executable).parent), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"})
print("R4_CHILD_PID:" + str(process.pid), file=sys.stderr, flush=True)
terminated = None
def stop(signum=None, frame=None):
    global terminated
    terminated = terminated or "PARENT_CANCEL_SIGNAL"
    process.terminate()
for s in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
    signal.signal(s, stop)
begin = time.monotonic()
payload = data
while True:
    try:
        stdout, stderr = process.communicate(input=payload, timeout=0.1)
        break
    except subprocess.TimeoutExpired:
        payload = None
        if os.getppid() != parent:
            terminated = "WORKER_PARENT_DIED"
            process.terminate()
        elif time.time() * 1000 >= args.deadline or time.monotonic() - begin >= 20:
            terminated = "ORIGINAL_DEADLINE_EXHAUSTED"
            process.terminate()
        if terminated:
            try:
                stdout, stderr = process.communicate(timeout=0.5)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=1)
            break
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
receipt = {"pid": process.pid, "supervisorPid": os.getpid(), "exitCode": process.returncode,
           "termination": terminated or "RETURNED", "terminationObserved": True,
           "peakRssBytes": int(usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024),
           "cpuMicros": int((usage.ru_utime + usage.ru_stime) * 1000000),
           "elapsedMs": (time.monotonic() - begin) * 1000,
           "stderrDigest": __import__("hashlib").sha256(stderr).hexdigest()}
if len(stdout) > 64 * 1024**2:
    receipt["termination"] = "OUTPUT_BOUND_EXCEEDED"
    stdout = b""
try:
    value = json.loads(stdout) if not terminated and process.returncode == 0 else None
except ValueError:
    value = None
print(json.dumps({"value": value, "receipt": receipt}, separators=(",", ":")))
