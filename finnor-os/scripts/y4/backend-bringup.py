"""Finite backend diagnostic. NOT a compiler or protected acceptance case.

Exercises fresh live preprocessing, authenticated TLS, one secret product and
private output under the selected native backend. A timeout retains the original
failure and stops every child. No protocol security option is disabled.
"""
import argparse
import hashlib
import json
import os
import re
import resource
import secrets
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2] / "packages/private-equity/src/confidential-computation"
sys.path.insert(0, str(PACKAGE))
from backend import verify_backend, canonical


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    backend = verify_backend(args.backend)
    args.evidence.mkdir(parents=True, exist_ok=False, mode=0o700)
    private = args.evidence / "PRIVATE-NOT-FOR-HANDOFF"
    private.mkdir(mode=0o700)
    name = "y4_bringup_" + secrets.token_hex(12)
    source = ("a = sint.get_input_from(0)\nb = sint.get_input_from(1)\nc = sint.get_input_from(2)\n"
              "from Compiler.library import check_point, print_ln_to\n"
              "x = (a * b + c).reveal_to(0)\ncheck_point()\n"
              "print_ln_to(0, 'Y4_BRINGUP:%s', x)\ncheck_point()\n")
    (backend / "Programs/Source" / (name + ".mpc")).write_text(source)
    children, logs = [], []
    started = time.monotonic()
    result = {"case": "NATIVE_BACKEND_BRINGUP_ONLY", "status": "FAIL", "protectedCases": 0}
    try:
        compiled = subprocess.run([sys.executable, "compile.py", "-F", "84", name], cwd=backend,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        (args.evidence / "compile.log").write_bytes(compiled.stdout)
        assert compiled.returncode == 0, "NATIVE_DIAGNOSTIC_COMPILE_FAILED"
        roots = []
        for i in range(3):
            root = private / ("p" + str(i))
            ssl = root / "Player-Data"
            ssl.mkdir(parents=True, mode=0o700)
            subprocess.run(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-x509", "-days", "1",
                            "-out", str(ssl / f"P{i}.pem"), "-keyout", str(ssl / f"P{i}.key"),
                            "-subj", f"/CN=P{i}"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            (ssl / f"P{i}.key").chmod(0o600)
            (ssl / f"Input-P{i}-0").write_text(str([7, -2, 19][i]) + "\n")
            (root / "Programs").symlink_to(backend / "Programs", target_is_directory=True)
            roots.append(root)
        for root in roots:
            for i, origin in enumerate(roots):
                if origin != root:
                    shutil.copyfile(origin / "Player-Data" / f"P{i}.pem", root / "Player-Data" / f"P{i}.pem")
            subprocess.run(["openssl", "rehash", str(root / "Player-Data")], check=True, capture_output=True)
        for i, root in enumerate(roots):
            log = (root / "native.private.log").open("wb")
            logs.append(log)
            command = [str(backend / "mascot-party.x"), "-e", "-N", "3", "-p", str(i), "-h", "127.0.0.1",
                       "-pn", "29430", "-P", "170141183460469231731687303715885907969",
                       "-S", "40", "-b", "1000", "-OF", ".", "-v", "-o", "debug_networking", name]
            children.append(subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                             start_new_session=True, env={"PATH": os.environ["PATH"]}))
        for child in children:
            child.wait(timeout=max(1, 90 - (time.monotonic() - started)))
        for log in logs:
            log.flush()
        result["exitCodes"] = [c.returncode for c in children]
        texts = [(r / "native.private.log").read_text(errors="replace") for r in roots]
        assert all(c.returncode == 0 for c in children), "NATIVE_DIAGNOSTIC_ABORT"
        assert re.findall(r"Y4_BRINGUP:(-?\d+)", texts[0]) == ["5"], "PRIVATE_PRODUCT_MISMATCH"
        assert all("Y4_BRINGUP:" not in t for t in texts[1:]), "NONRECIPIENT_OUTPUT"
        result["status"] = "PASS"
    except BaseException as error:
        result["failurePredicate"] = str(error) if isinstance(error, AssertionError) else type(error).__name__
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        for log in logs:
            log.close()
        result["wallSeconds"] = time.monotonic() - started
        result["physicalProcessesStopped"] = all(c.poll() is not None for c in children)
        result["childCPUSeconds"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime
        result["moneyUSD"] = result["humanSeconds"] = result["aggregatePeakMemoryBytes"] = None
        (args.evidence / "result.json").write_text(canonical(result) + "\n")
        print(canonical(result))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
