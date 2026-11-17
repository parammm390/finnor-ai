"""CLI evidence-corruption controls over a complete actual original W007 run."""
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
    assert [row["boundary"] for row in original["cases"]] == [
        "SUBMIT", "CLAIM", "USE", "CHECK", "PUBLISH", "DISPATCH"]
    assert all(row["status"] == "PASS" for row in original["cases"])
    oracle = Path(__file__).with_name("native-revocation-oracle.py")
    oracle_raw = oracle.read_bytes()
    args.destination.mkdir(mode=0o700)
    began = time.monotonic()
    results = []

    def run(name, value, accepted):
        assert time.monotonic() - began < 45, "W007_ORACLE_CONTROL_TOTAL_BOUND"
        with tempfile.TemporaryDirectory(prefix=name + "-", dir=args.destination) as temporary:
            root = Path(temporary)
            source, output = root / "input.json", root / "oracle.json"
            encoded = json.dumps(value).encode()
            source.write_bytes(encoded)
            child = subprocess.run([sys.executable, str(oracle), str(source), str(output)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=min(5, 45 - (time.monotonic() - began)))
            receipt = json.loads(output.read_bytes()) if output.exists() else None
            passed = child.returncode == 0 and receipt is not None and receipt.get("status") == (
                "PASS_INDEPENDENT_SIX_BOUNDARY_LINEAGE_AND_LIABILITY")
            results.append({"name": name, "expectedAccepted": accepted, "accepted": passed,
                "exitCode": child.returncode, "inputSha256": hashlib.sha256(encoded).hexdigest(),
                "stdoutSha256": hashlib.sha256(child.stdout).hexdigest(),
                "stderrSha256": hashlib.sha256(child.stderr).hexdigest(),
                "status": "PASS" if passed == accepted and (accepted or child.returncode != 0) else "FAIL"})

    run("original-full-six-boundary", original, True)
    for name in ("wrong-event-kind", "missing-committed-event", "foreign-unit",
                 "missing-cleanup", "late-publish", "late-search-scoped-dispatch",
                 "resumed-before-revocation"):
        value = copy.deepcopy(original)
        case = next(row for row in value["cases"] if row["boundary"] == (
            "DISPATCH" if name == "late-search-scoped-dispatch" else
            "PUBLISH" if name == "late-publish" else "CLAIM"))
        event = case["pause"]["event"]
        if name == "wrong-event-kind":
            event["kind"] = "NOT_THE_COMMITTED_ORIGINAL_BOUNDARY"
        elif name == "missing-committed-event":
            case["preRevocation"]["p2_events"] = [
                row for row in case["preRevocation"]["p2_events"] if row["id"] != event["eventId"]]
        elif name == "foreign-unit":
            event["unitId"] = "00000000-0000-0000-0000-000000000000"
        elif name == "missing-cleanup":
            case["cleanup"]["status"] = "FAIL"
        elif name.startswith("late-"):
            late = {"id": "negative-control-late-event", "search_id": case["searchId"],
                "kind": "W1_BOUNDARY_CURRENTNESS_CHECKED", "body": {"boundary": case["boundary"]}}
            if case["boundary"] != "DISPATCH":
                late["body"]["unitId"] = event["unitId"]
            case["preRevocation"]["p2_events"].append(late)
        elif name == "resumed-before-revocation":
            case["pause"]["resumedAt"] = case["before"]["observedAt"]
        run(name, value, False)
    assert args.observations.read_bytes() == raw and oracle.read_bytes() == oracle_raw
    passed = all(row["status"] == "PASS" for row in results)
    report = {"schema": "finnor.w1.revocation-oracle-controls.v1",
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
