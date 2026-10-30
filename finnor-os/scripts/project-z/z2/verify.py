"""Failure-first CLI E2E; a process proof, never an authenticated native proof."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixtures import cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[5]))
    args = parser.parse_args()
    repo, out = Path(args.repo).resolve(), Path(args.evidence_dir).resolve()
    out.mkdir(parents=True, exist_ok=False)
    engine = repo/"finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions"
    rows = []
    for case in cases():
        target = out/case["id"]
        target.mkdir()
        request = {"problem": case["problem"], "budgetMs": 20000}
        (target/"input.json").write_text(json.dumps(request, sort_keys=True)+"\n")
        started = time.monotonic()
        process = subprocess.run([sys.executable, "-I", "-B", str(engine/"producer.py")],
                                 input=json.dumps(request), capture_output=True, text=True,
                                 timeout=40, env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"})
        (target/"producer.stdout").write_text(process.stdout)
        (target/"producer.stderr").write_text(process.stderr)
        try:
            construction = json.loads(process.stdout)
            checked = subprocess.run([sys.executable, "-I", "-B", str(engine/"checker.py")],
                                     input=json.dumps({"problem": case["problem"], "construction": construction}),
                                     capture_output=True, text=True, timeout=40,
                                     env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"})
            (target/"checker.stdout").write_text(checked.stdout)
            (target/"checker.stderr").write_text(checked.stderr)
            report = json.loads(checked.stdout)
            ok = process.returncode == checked.returncode == 0 and report["status"] == case["expected"]
            if case["expected"] == "CHECKED_CANDIDATE":
                ok = ok and set(construction["candidate"]["policy"].values()) == {"authorized"}
                # A missing model/coalition certificate must fail at coverage, not unrelated auth/schema.
                forged = copy.deepcopy(construction)
                forged["certificates"] = forged["certificates"][:-1]
                negative = subprocess.run([sys.executable, "-I", "-B", str(engine/"checker.py")],
                    input=json.dumps({"problem": case["problem"], "construction": forged}),
                    capture_output=True, text=True, timeout=40,
                    env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"})
                (target/"omitted-certificate.stdout").write_text(negative.stdout)
                rejection = json.loads(negative.stdout)
                ok = ok and rejection["status"] == "COUNTEREXAMPLE" and rejection["reason"] == "Z2_CERTIFICATE_COVERAGE"
            rows.append({"id": case["id"], "expected": case["expected"], "actual": report.get("status"),
                         "reason": report.get("reason"), "passed": ok, "wallMs": int((time.monotonic()-started)*1000)})
        except (ValueError, KeyError) as error:
            rows.append({"id": case["id"], "expected": case["expected"], "actual": "HARNESS_FAILURE",
                         "passed": False, "exitCode": process.returncode, "error": type(error).__name__})
    report = {"schema": "finnor.project-z.z2.public-process-e2e.v1", "cases": rows,
              "passed": sum(r["passed"] for r in rows), "failed": sum(not r["passed"] for r in rows),
              "scope": "PUBLIC_TWO_PARTY_PROCESS_DEVELOPMENT_NOT_32x8_QUALIFICATION",
              "authenticatedOwner": "NOT_RUN", "nativePhysicalRecovery": "NOT_RUN", "protectedAdmission": False}
    (out/"report.json").write_text(json.dumps(report, indent=2)+"\n")
    inventory = {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted(out.rglob("*")) if p.is_file()}
    (out/"sha256.json").write_text(json.dumps(inventory, indent=2)+"\n")
    print(json.dumps({"passed": report["passed"], "failed": report["failed"], "report": str(out/"report.json")}))
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
