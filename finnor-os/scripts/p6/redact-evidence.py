"""Redact authorized token disclosures, preserving outcomes and original pins."""
import hashlib
import json
import pathlib
import re
import sys

repo, receipt_path = map(pathlib.Path, sys.argv[1:3])
if not repo.is_absolute() or not receipt_path.is_absolute():
    raise SystemExit("Absolute owned checkout and fresh receipt required")
phase = repo / "scope-pm/phase-12-p6-procedure-induction"
evidence = phase / "evidence"
names = [
    "native-01-overlay/results.json", "native-02-overlay/results.json",
    "native-03-overlay/results.json",
    *[f"native-{n:02}-overlay/{f}" for n in range(4, 10)
      for f in ["diagnostic-comparison.json", "results.json"]],
    "native-10-overlay/results.json",
    "native-11-overlay/diagnostic-comparison.json", "native-11-overlay/results.json",
    *[f"p1-capital-06/capital/{f}.json" for f in [
        "all-owner-operations-boundary", "baseline-boundary", "baseline",
        "reserved-boundary", "reserved", "tightened-boundary", "tightened"]],
    "p1-capital-06/results.json",
    *[f"p1-regressions-{n:02}/results.json" for n in [3, 4, 5, 7]],
    "p5-crash-01/results.json", "p5-programme-01/results.json",
    "p7-native-01/results.json", "p7-native-02/results.json",
]
assert len(names) == len(set(names)) == 34
if sys.argv[3:]:
    assert all(name in names for name in sys.argv[3:])
    names = sys.argv[3:]
assert not receipt_path.exists()
keys = {"token", "claim_token", "claimToken", "lease_token", "executionKey"}
embedded = re.compile(r'("(?:token|claim_token|claimToken|lease_token|executionKey)"\s*:\s*")([^"]{16,})(")')
sha = lambda content: hashlib.sha256(content).hexdigest()

def outcomes(value):
    if isinstance(value, dict):
        rows = value.get("results", value.get("cases", value.get("steps")))
        if isinstance(rows, list):
            return [(row.get("id"), row.get("status")) for row in rows]
    return None

def redact(value, path, edits):
    if isinstance(value, dict):
        for key, child in value.items():
            location = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in keys and isinstance(child, str) and child != "REDACTED":
                value[key] = "REDACTED"
                edits.append({"jsonPointer": location,
                              "kind": "execution-key" if key == "executionKey" else "execution-token"})
            else:
                value[key] = redact(child, location, edits)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            value[index] = redact(child, path + "/" + str(index), edits)
    elif isinstance(value, str):
        count = len(list(embedded.finditer(value)))
        if count:
            value = embedded.sub(lambda match: match[1] + "REDACTED" + match[3], value)
            edits.append({"jsonPointer": path, "kind": "embedded-token", "count": count})
    return value

records = []
for name in names:
    file = evidence / name
    raw = file.read_bytes()
    data = json.loads(raw)
    before_outcomes = outcomes(data)
    edits = []
    sanitized = redact(data, "", edits)
    assert edits, f"No authorized token locations found: {name}"
    assert outcomes(sanitized) == before_outcomes, name
    public = (json.dumps(sanitized, indent=2, ensure_ascii=False) + "\n").encode()
    verify_edits = []
    redact(json.loads(public), "", verify_edits)
    assert not verify_edits, name
    file.write_bytes(public)
    records.append({"path": "evidence/" + name, "beforeSha256": sha(raw),
                    "afterSha256": sha(public), "redactions": edits,
                    "caseOutcomesUnchanged": True,
                    "isOriginalProductPreimage": False})

by_path = {(phase / r["path"]).resolve(): r for r in records}
derived = []
for file in evidence.rglob("derived-summary.json"):
    data = json.loads(file.read_bytes())
    pin = by_path.get(pathlib.Path(data["rawPath"]).resolve())
    if pin:
        assert data["rawSha256"] == pin["beforeSha256"], str(file)
        data.setdefault("originalRawSha256", data["rawSha256"])
        data.setdefault("priorRedactionSha256", []).append(data["rawSha256"])
        data["rawSha256"] = pin["afterSha256"]
        data["rawEvidenceRedacted"] = True
        file.write_text(json.dumps(data, indent=2) + "\n")
        derived.append(str(file.relative_to(phase)))
index_path = phase / "handoff/evidence-index.json"
index = json.loads(index_path.read_bytes())
for entry in index["entries"]:
    pin = by_path.get((phase / entry["path"]).resolve())
    if pin:
        assert entry["sha256"] == pin["beforeSha256"], entry["path"]
        entry.setdefault("originalSha256", entry["sha256"])
        entry.setdefault("priorRedactionSha256", []).append(entry["sha256"])
        content = (phase / entry["path"]).read_bytes()
        entry["sha256"] = sha(content)
        entry["bytes"] = len(content)
        entry["evidenceRedacted"] = True
previous = index.pop("redactionReceipt", None)
receipts = index.setdefault("redactionReceipts", [])
if previous and previous not in receipts:
    receipts.append(previous)
receipts.append(str(receipt_path.relative_to(phase)))
index_path.write_text(json.dumps(index, indent=2) + "\n")
receipt = {"schema": "finnor.p6.authorized-evidence-redaction.v1",
           "scope": "Exact authorized Droid Shield flagged retained evidence files",
           "placeholder": "REDACTED", "files": records,
           "derivedHashesRefreshed": derived,
           "originalProductDigestPinsChanged": False,
           "authorityGranted": False, "GateP6": "UNQUALIFIED"}
with receipt_path.open("x") as file:
    json.dump(receipt, file, indent=2)
    file.write("\n")
print(json.dumps({"files": len(records),
                  "redactions": sum(e.get("count", 1) for r in records for e in r["redactions"]),
                  "caseOutcomesUnchanged": True, "authorityGranted": False}))
