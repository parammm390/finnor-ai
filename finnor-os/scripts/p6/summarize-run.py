"""Derive a compact, hash-pinned case receipt without changing raw evidence."""
import hashlib
import json
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
if not source.is_absolute() or not destination.is_absolute():
    raise SystemExit("Absolute raw result and fresh receipt required")
raw = source.read_bytes()
result = json.loads(raw)
cases = result.get("results", result.get("cases", result.get("steps")))
if not isinstance(cases, list) or not cases:
    raise SystemExit("Nonempty recorded case denominator required")
records = []
for case in cases:
    observed = case.get("observed")
    predicate = case.get("predicate")
    if case.get("status") == "FAIL" and isinstance(observed, dict):
        predicate = observed.get("message", predicate)
    records.append({
        "id": case["id"],
        "status": case.get("status", "UNKNOWN"),
        "predicate": str(predicate)[:600] if predicate is not None else None,
    })
receipt = {
    "schema": "finnor.p6.derived-run-receipt.v1",
    "rawPath": str(source),
    "rawSha256": hashlib.sha256(raw).hexdigest(),
    "cases": records,
    "counts": {status: sum(r["status"] == status for r in records)
               for status in ["PASS", "FAIL", "NOT_RUN", "UNKNOWN"]},
    "independentAuthorityGranted": False,
    "qualification": "Derived raw-case summary, not admission or a new evaluation",
}
with destination.open("x") as file:
    json.dump(receipt, file, indent=2)
    file.write("\n")
print(json.dumps({"receipt": str(destination), "counts": receipt["counts"]}))
