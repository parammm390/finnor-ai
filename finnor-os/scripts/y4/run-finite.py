"""Serial execution of the already registered local engineering entries.

Each attempt remains separate; failures never change the manifest or denominator.
No private artifact is read or copied by this campaign supervisor.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--backend", required=True, type=Path)
parser.add_argument("--evidence", required=True, type=Path)
parser.add_argument("--cases", nargs="+", default=["correspondence", "hash-conformance",
                                                  "numerical", "numerical-reject", "binding"])
args = parser.parse_args()
os.umask(0o077)
args.evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
results = []
for case in args.cases:
    start = time.monotonic()
    directory = args.evidence / case
    command = [sys.executable, str(Path(__file__).with_name("engineering.py")), "--case", case,
               "--backend", str(args.backend), "--evidence", str(directory)]
    failure = None
    exit_code = None
    result_path = directory / "result.json"
    try:
        if case == "release":
            if not results or results[-1]["case"] != "numerical" or results[-1]["status"] != "PASS":
                raise ValueError("RELEASE_REQUIRES_IMMEDIATELY_PRECEDING_CURRENT_NUMERICAL_PASS")
            command += ["--original-episode", str(args.evidence / "numerical")]
        with (args.evidence / (case + ".log")).open("xb") as log:
            child = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=1050)
            exit_code = child.returncode
        result = json.loads(result_path.read_text())
        status = "PASS" if exit_code == 0 and result["status"] == "PASS" else "FAIL"
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError) as error:
        failure = type(error).__name__ + ": " + str(error)
        status = "FAIL"
    results.append({"case": case, "status": status, "exitCode": exit_code,
                    "wallSeconds": time.monotonic() - start, "result": str(result_path),
                    "resultAvailable": result_path.is_file(), "failure": failure})
    print(json.dumps(results[-1]), flush=True)
(args.evidence / "campaign.json").write_text(json.dumps({
    "schema": "finnor.y4.finite-local-engineering.v1", "attempts": results,
    "protectedCases": 0, "separatelyAdministered": False,
    "status": "PASS" if all(r["status"] == "PASS" for r in results) else "FAIL",
    "qualifiesProductOrProtectedCampaign": False}, indent=2) + "\n")
sys.exit(0 if all(r["status"] == "PASS" for r in results) else 1)
