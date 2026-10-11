"""Preregistered real subprocess/resource faults, never a financial checker."""
import json
import os
import pathlib
import subprocess
import sys
import time

mode, output = sys.argv[1], pathlib.Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
if mode == "write":
    child = subprocess.Popen([sys.executable, __file__, "writer", str(output)],
                             stdin=subprocess.DEVNULL)
elif mode == "memory":
    child = subprocess.Popen([sys.executable, __file__, "allocator", str(output)],
                             stdin=subprocess.DEVNULL)
elif mode == "writer":
    with (output / "actual-evidence.bin").open("ab", buffering=0) as f:
        while True:
            f.write(b"x" * 8192)
            time.sleep(.02)
elif mode == "allocator":
    live = bytearray(32 * 1024 * 1024)
    for i in range(0, len(live), 4096):
        live[i] = 1
    while True:
        time.sleep(.1)
elif mode == "launch-marker":
    (output / "launched.json").write_text(json.dumps({"pid": os.getpid()}) + "\n")
    sys.exit(0)
else:
    raise ValueError("Unknown registered fixture")
if mode in ["write", "memory"]:
    (output / "actual-child.json").write_text(json.dumps(
        {"parentPid": os.getpid(), "childPid": child.pid,
         "responsibility": "ACTUAL_TEST_CHILD_NO_FINANCIAL_EFFECT_UNKNOWN_IF_UNACKNOWLEDGED"}) + "\n")
    while True:
        time.sleep(.1)
