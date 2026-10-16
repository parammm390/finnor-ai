"""Trusted finite scientific child supervisor. Candidate data is never argv/code.

On actual parent death kill the entire scientific process group, including SMT.
Inherited credentials are scrubbed by the caller. This is not hostile OS custody.
"""
import json
import os
import resource
import signal
import subprocess
import sys
import threading
import time

parent = os.getppid()
deadline = float(sys.argv[1])
began = time.monotonic()
# JsonProcess already creates the isolated process group. Keep every scientific
# descendant in it so the unsandboxed parent can physically kill and observe
# that one group. A second session hid SMT descendants from its close boundary.
group = os.getpgrp()
child = subprocess.Popen(sys.argv[2:], stdin=sys.stdin.buffer, stdout=sys.stdout.buffer,
                         stderr=sys.stderr.buffer)
termination = "EXITED"


def kill_group():
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass


def guard():
    global termination
    while child.poll() is None:
        if os.getppid() != parent:
            termination = "PARENT_DIED"
            kill_group()
            return
        if time.time() * 1000 >= deadline:
            termination = "ORIGINAL_DEADLINE"
            kill_group()
            return
        time.sleep(0.05)


watcher = threading.Thread(target=guard, daemon=True)
watcher.start()
code = child.wait()
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
print("\nR8_RESOURCE:" + json.dumps({"elapsedMs": (time.monotonic() - began) * 1000,
      "cpuUserSeconds": usage.ru_utime, "cpuSystemSeconds": usage.ru_stime,
      "maximumRss": usage.ru_maxrss, "maximumRssUnit": "bytes" if sys.platform == "darwin" else "KiB",
      "termination": termination, "childPid": child.pid, "exitCode": code}), file=sys.stderr, flush=True)
sys.exit(code if code >= 0 else 128 - code)
