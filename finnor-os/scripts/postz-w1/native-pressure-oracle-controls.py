"""CLI corruption controls over complete actual original W006/W015 evidence."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("observations", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    assert args.observations.is_absolute() and args.observations.is_file()
    assert args.destination.is_absolute() and not args.destination.exists()
    os.umask(0o077)
    raw = args.observations.read_bytes()
    original = json.loads(raw)
    assert original["schema"] == "finnor.w1.concurrent-native-pressure.v1"
    assert len(original["population"]) == 4
    oracle = Path(__file__).with_name("native-pressure-oracle.py")
    oracle_raw = oracle.read_bytes()
    args.destination.mkdir(mode=0o700)
    began = time.monotonic()
    results = []

    def run(name, value, accepted):
        assert time.monotonic() - began < 60, "W006_W015_ORACLE_CONTROL_TOTAL_BOUND"
        with tempfile.TemporaryDirectory(prefix=name + "-", dir=args.destination) as temporary:
            root = Path(temporary)
            source, output = root / "input.json", root / "oracle.json"
            encoded = json.dumps(value).encode()
            source.write_bytes(encoded)
            child = subprocess.run([sys.executable, str(oracle), str(source), str(output)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=min(5, 60 - (time.monotonic() - began)))
            receipt = json.loads(output.read_bytes()) if output.exists() else None
            passed = child.returncode == 0 and receipt is not None and receipt.get("status") == (
                "PASS_INDEPENDENT_CONSERVATION_AND_MISSED_POPULATION")
            results.append({"name": name, "expectedAccepted": accepted, "accepted": passed,
                "exitCode": child.returncode, "inputSha256": hashlib.sha256(encoded).hexdigest(),
                "stdoutSha256": hashlib.sha256(child.stdout).hexdigest(),
                "stderrSha256": hashlib.sha256(child.stderr).hexdigest(),
                "status": "PASS" if passed == accepted and (accepted or child.returncode != 0) else "FAIL"})

    run("original-complete-pressure", original, True)
    for name in ("tied-original-age", "not-lower-priority", "changed-source-cohort",
                 "wrong-first-deferral", "reset-original-deadline", "refunded-shared-grant",
                 "missing-population", "failed-unaffected-acceptance", "wrong-expired-delivery"):
        value = copy.deepcopy(original)
        population = {row["label"]: row for row in value["population"]}
        a = population["A_CANCELLED_IN_FLIGHT"]
        b = population["B_UNAFFECTED_PROGRESS"]
        d = population["D_NATIVE_QUEUE_DEADLINE_MISSED"]
        initial_jobs = {job["id"]: job for entry in value["priorityInputs"] for job in entry["rows"]}
        d_job = next(row for row in initial_jobs.values() if row["payload"]["searchId"] == d["searchId"])
        b_job = next(row for row in initial_jobs.values() if row["payload"]["searchId"] == b["searchId"])
        if name == "tied-original-age":
            d_job["run_at"] = b_job["run_at"]
        elif name == "not-lower-priority":
            d_job["priority"] = b_job["priority"]
        elif name == "changed-source-cohort":
            value["unaffectedSourcePreparationIsolation"]["after"]["searches"][0]["status"] = "CORRUPTED"
        elif name == "wrong-first-deferral":
            jobs = {row["id"]: row for row in value["terminal"]["jobs"]}
            deliveries = [row for row in value["terminal"]["job_delivery_attempts"]
                if jobs[row["job_id"]]["payload"].get("searchId") in (b["searchId"], d["searchId"])]
            first = min(deliveries, key=lambda row: (row["started_at"], row["id"]))
            first["outcome"] = "completed"
        elif name == "reset-original-deadline":
            parent = next(row for row in value["before"]["p1_requests"] if row["id"] == d["programId"])
            episode = next(row for row in value["before"]["p1_episodes"] if row["id"] == parent["episode_id"])
            episode["deadline_at"] = "2000-01-01T00:00:00Z"
        elif name == "refunded-shared-grant":
            for row in value["terminal"]["p2_grant_usage"]:
                row["spent"] = 0
        elif name == "missing-population":
            value["population"].pop()
        elif name == "failed-unaffected-acceptance":
            value["unaffected"]["body"]["status"] = "FAILED"
        elif name == "wrong-expired-delivery":
            jobs = {row["id"]: row for row in value["prepressureMiss"]["cut"]["jobs"]}
            deliveries = [row for row in value["prepressureMiss"]["cut"]["job_delivery_attempts"]
                if jobs[row["job_id"]]["type"] == "run_compute_search_unit_v1"
                and jobs[row["job_id"]]["payload"].get("searchId") in {
                    identity["searchId"] for identity in value["population"]}]
            assert deliveries, "ACTUAL_EXPIRED_NATIVE_DELIVERY_REQUIRED_FOR_CONTROL"
            first = min(deliveries, key=lambda row: (row["started_at"], row["id"]))
            first["job_id"] = next(row["id"] for row in jobs.values()
                if row["type"] == "run_compute_search_unit_v1"
                and row["payload"].get("searchId") == a["searchId"])
        run(name, value, False)
    assert args.observations.read_bytes() == raw and oracle.read_bytes() == oracle_raw
    passed = all(row["status"] == "PASS" for row in results)
    report = {"schema": "finnor.w1.pressure-oracle-controls.v1",
        "status": "PASS" if passed else "FAIL", "cases": results,
        "originalInputSha256": hashlib.sha256(raw).hexdigest(),
        "oracleSha256": hashlib.sha256(oracle_raw).hexdigest(),
        "wallSeconds": time.monotonic() - began, "productionRuntimeImported": False,
        "originalObservationsUnchanged": True, "originalOwnerProofSubstituted": False}
    with (args.destination / "results.json").open("x") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "cases": len(results)}))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
