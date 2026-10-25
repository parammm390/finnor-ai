"""Finite registered sweep, releases the shared heavy lock between families."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--repository",required=True,type=Path)
    p.add_argument("--node",required=True,type=Path)
    p.add_argument("--evidence",required=True,type=Path)
    p.add_argument("--previous",type=Path)
    a=p.parse_args()
    if not all(x.is_absolute() for x in [a.repository,a.node,a.evidence]): raise ValueError("absolute paths required")
    a.evidence.mkdir(mode=0o700,parents=True,exist_ok=False)
    raw=(a.repository/"scope-z/phase-evidence/z4/public-cases.pre-code.json").read_bytes()
    digest=hashlib.sha256(raw).hexdigest()
    if digest!="3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94": raise ValueError("frozen registration changed")
    frozen=json.loads(raw)
    report={"schema":"finnor.z4.public-sweep.v1","registrationSha256":digest,"denominator":256,
            "nativeOwner":False,"eligibleReuseN":0,"protectedAdmission":"NOT_RUN","families":[],"status":"RUNNING"}
    completed=set()
    if a.previous:
        if not a.previous.is_absolute(): raise ValueError("absolute previous report required")
        raw_previous=a.previous.read_bytes()
        previous=json.loads(raw_previous)
        if previous["registrationSha256"]!=digest: raise ValueError("previous registration mismatch")
        identity=json.loads((a.repository/"finnor-os/packages/epistemic-runtime/native/z4-execution-proof/build-identity.json").read_text())
        for entry in previous["families"]:
            if entry["exit"]!=0: continue
            family=entry["family"]
            path=a.previous.parent/family/"report.json"
            body=json.loads(path.read_text())
            expected={c["id"]:c for c in frozen["cases"] if c["family"]==family}
            if family not in frozen["families"] or family in completed or len(body["rows"])!=8 or len(expected)!=8 or \
               body["status"]!="PASSED_OFFLINE_MECHANISM_ONLY" or body["processPositivePassed"]!=2 or \
               body["identity"]["binarySha256"]!=identity["binarySha256"] or \
               body["identity"]["sourceDigest"]!=identity["sourceDigest"] or \
               {r["id"] for r in body["rows"]}!=set(expected) or \
               any(r["status"] in ["FAILED","RUNNING"] or r["expectedFinal"]!=expected[r["id"]]["expectedFinal"] for r in body["rows"]):
                raise ValueError("previous family is not a complete source-bound observation")
            completed.add(family)
            report["families"].append({**entry,"retainedEvidence":str(path),
              "retainedEvidenceSha256":hashlib.sha256(path.read_bytes()).hexdigest()})
        (a.evidence/"previous-report.snapshot.json").write_bytes(raw_previous)
        report["previousSweep"]={"path":str(a.previous),"sha256":hashlib.sha256(raw_previous).hexdigest(),
          "status":previous["status"],"parentTerminalExit":"UNOBSERVED_NOT_REWRITTEN",
          "policy":"Reuse only complete exact registered observations; run missing families in new directories."}
    for family in frozen["families"]:
        if family in completed: continue
        target=a.evidence/family
        cmd=["flock","/home/factory-user/repos/finnor-z-shared-heavy.lock",str(a.node),"--import","tsx",
             str(a.repository/"finnor-os/scripts/project-z/z4/public-sweep.mts"),"--family",family,"--evidence",str(target)]
        started=time.monotonic()
        with (a.evidence/(family+".process.log")).open("xb") as log:
            result=subprocess.run(cmd,cwd=a.repository/"finnor-os",stdout=log,stderr=subprocess.STDOUT,
                                  env={**os.environ,"NODE_OPTIONS":"--max-old-space-size=1024"},timeout=2400)
        entry={"family":family,"exit":result.returncode,"wallMs":round((time.monotonic()-started)*1000),"command":cmd}
        if (target/"report.json").is_file():
            body=json.loads((target/"report.json").read_text())
            entry.update(status=body["status"],rows=len(body["rows"]),positivePassed=body.get("processPositivePassed",0))
        report["families"].append(entry)
        (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    report["rows"]=sum(x.get("rows",0) for x in report["families"])
    report["processPositiveDenominator"]=64
    report["processPositivePassed"]=sum(x.get("positivePassed",0) for x in report["families"])
    report["status"]="PASSED_OFFLINE_MECHANISM_ONLY" if len(report["families"])==32 and report["rows"]==256 and \
      report["processPositivePassed"]==64 and all(x["exit"]==0 for x in report["families"]) else "FAILED"
    report["nativeAuthorityCurrentnessRecovery"]="NOT_RUN_NO_AUTHORIZED_TARGET"
    (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"status":report["status"],"output":str(a.evidence),"rows":report["rows"]}))
    return 0 if report["status"]=="PASSED_OFFLINE_MECHANISM_ONLY" else 1
if __name__=="__main__": raise SystemExit(main())
