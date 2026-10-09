"""Rebuild documentary hashes/coverage from retained real evidence.

No source execution, admission, external writes or invented successful gates.
"""
import datetime
import hashlib
import json
import pathlib
import subprocess

repo = pathlib.Path(__file__).resolve().parents[3]
record = repo / "scope-r/r4-identification-plan-compiler"
evidence = repo.parent / "evidence"
sha = lambda b: hashlib.sha256(b).hexdigest()
load = lambda p: json.loads(p.read_text())
write = lambda p, v: p.write_text(json.dumps(v, indent=2) + "\n")
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
scientific = load(evidence / "scientific-4/results.json")
assert scientific["status"] == "PASS"
source_matches = []
for name, expected in scientific["sourceDigests"].items():
    path = pathlib.Path(name)
    if not path.is_absolute():
        path = repo / path
    source_matches.append({"path": str(path), "expected": expected,
                           "current": sha(path.read_bytes()), "matches": sha(path.read_bytes()) == expected})
assert all(x["matches"] for x in source_matches)

files = ["scientific-4/results.json", "scientific-4/comparison.json"]
for n in range(1, 5):
    files.extend([f"owner-faults-{n}/results.json", f"owner-faults-{n}/freeze.json",
                  f"owner-faults-{n}/final-sql.json"])
files.extend(["owner-faults-1/faults/producer-kill.json", "owner-faults-1/faults/checker-kill.json",
              "owner-faults-2/faults/cancellation.json", "owner-faults-2/faults/worker-restart.json",
              "owner-faults-2/faults/publication-rights.json", "owner-faults-4/faults/publication-expiry.json",
              "mounted-dom-boundary-8/results.json", "mounted-dom-boundary-8/browser/receipt.json",
              "mounted-dom-boundary-9/results.json", "mounted-remaining-10/results.json",
              "final-local-checks/api-build.log", "final-local-checks/work-build.log",
              "final-local-checks/scientific-runtime.json", "final-local-checks/affected-release-guards.log",
              "final-local-checks/r4-script-types-final.log", "final-local-checks/os-types.log"])
indexed = []
for name in files:
    p = evidence / name
    if p.is_file():
        indexed.append({"path": str(p), "sha256": sha(p.read_bytes()), "bytes": p.stat().st_size})
write(record / "evidence-index.json", {"schema": "finnor.r4.private-evidence-index.v1",
       "updatedUTC": now, "scientificSourceMatches": source_matches, "records": indexed,
       "qualification": "Hashes locate private retained evidence, not admission or one fresh all-predicate campaign",
       "notRetainedPhysically": ["Original integrated-7, mounted-1 and mounted-2 temporary runtime directories"]})

coverage = load(record / "requirement-coverage.json")
science = str(evidence / "scientific-4/results.json")
faults = [str(evidence / f"owner-faults-{n}/results.json") for n in range(1, 5)]
for row in coverage["rows"]:
    c = row["clause"]
    row["status"] = "PASS_SELECTED_DEVELOPMENT"
    row["evidence"] = [science] if row["boundary"] == "scientific" else faults
    if c in ["R4.4.comparative", "common.13.1", "common.13.2", "common.13.4"]:
        row["status"] = "NOT_RUN_PROTECTED"
        row["evidence"] = [str(record / "external-request-packets.json"),
                           str(evidence / "scientific-4/comparison.json")]
    elif c == "common.13.3":
        row["status"] = "INCOMPLETE_MATERIAL_METERS"
    elif c == "common.12.1":
        row["status"] = "PARTIAL_S6_RECEIPT_CUSTODY_UNVERIFIED"
    elif c == "common.3.Pi":
        row["status"] = "NOT_APPLICABLE_PI_NOT_ADOPTED"
    elif c in ["current.combined", "current.migration"]:
        row["status"] = "PARTIAL_LOCAL_CANDIDATE_ONLY_COMBINED_NOT_RUN"
    elif c == "blueprint.delivery":
        row["status"] = "INCOMPLETE_FINAL_IMAGE_BUILT_API_RUNTIME"
    elif c in ["current.ownership", "common.14", "blueprint.finite"]:
        row["status"] = "DOCUMENTED_LOCAL_SEAL_PENDING"
coverage["capturedUTC"] = now
coverage["basis"] = "Retained dependency-scoped scientific/owner/fault/DOM evidence; original failures preserved"
coverage["overallFunctionalGate"] = "INCOMPLETE_FINAL_PACKAGE_GATE"
coverage["limitations"] = ["Final worker image not built/executed; no Docker/Podman/Lima/Colima",
    "Built API runtime proof not complete", "Sustained controller RSS exceeded fixed 1 GiB guard in serial campaign",
    "Native desktop input remains PARTIAL", "Complete monetary/build/container/human meters unavailable",
    "Actual sealed cumulative R1 adoption/checks are separate", "Inherited S6 interruption receipt not in verified custody"]
write(record / "requirement-coverage.json", coverage)

python = repo.parent / "runtime/y0/bin/python"
licenses = subprocess.run([str(python), "-I", "-c", """
import importlib.metadata as m,pathlib,hashlib,json
notices=[]
for d in m.distributions():
 for f in d.files or []:
  if 'license' not in str(f).lower() and 'copying' not in str(f).lower(): continue
  p=pathlib.Path(d.locate_file(f))
  if p.is_file() and p.stat().st_size<500000:
   b=p.read_bytes()
   try: text=b.decode('utf-8')
   except UnicodeDecodeError: continue
   notices.append({'package':d.metadata['Name'],'version':d.version,'path':str(f),
                   'sha256':hashlib.sha256(b).hexdigest(),'notice':text})
print(json.dumps(notices))
"""], check=True, capture_output=True, text=True, timeout=60)
write(record / "license-notices.json", {"schema": "finnor.r4.local-scientific-license-notices.v1",
       "runtimeInventory": str(evidence / "final-local-checks/scientific-runtime.json"),
       "qualification": "Actual installed dependency notices; no legal/admission or final-image approval",
       "notices": json.loads(licenses.stdout)})
print(json.dumps({"scientificSourceBindings": len(source_matches), "evidenceRecords": len(indexed),
                  "coverageRows": len(coverage["rows"]), "overall": coverage["overallFunctionalGate"]}))
