"""One finite 7x5 sweep. Each observation owns and then releases the heavy lock."""
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
    a.evidence.mkdir(parents=True,exist_ok=False,mode=0o700)
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    env={"PATH":str(a.node.parent)+":/usr/bin:/bin","HOME":str(a.evidence),"TMPDIR":str(a.evidence),
         "NODE_OPTIONS":"--max-old-space-size=1024 --import="+str(a.repository/"finnor-os/scripts/project-z/z4/isolation-loader.mjs"),
         "PYTHONDONTWRITEBYTECODE":"1","RAYON_NUM_THREADS":"2","TSX_DISABLE_CACHE":"1","CI":"1"}
    report={"schema":"finnor.z4.scaling-sweep.v1","eligibleReuseN":0,"nativeWork":False,"observations":[],
            "operational100x":"NOT_PASSED","financial100x":"NOT_RUN","status":"RUNNING"}
    completed=set()
    if a.previous:
        if not a.previous.is_absolute(): raise ValueError("absolute previous report required")
        raw=a.previous.read_bytes();previous=json.loads(raw)
        identity=json.loads((a.repository/"finnor-os/packages/epistemic-runtime/native/z4-execution-proof/build-identity.json").read_text())
        for entry in previous["observations"]:
            if entry["exit"]!=0: continue
            key=(entry["steps"],entry["observation"])
            path=a.previous.parent/f"t{key[0]}-o{key[1]}"/"report.json"
            body=json.loads(path.read_text())
            if key in completed or key[0] not in [1,2,4,8,16,64,256] or key[1] not in range(5) or \
              body["status"]!="PASSED_OFFLINE_MEASUREMENT_ONLY" or (body["steps"],body["observation"])!=key or \
              body["identity"]["binarySha256"]!=identity["binarySha256"] or \
              body["identity"]["sourceDigest"]!=identity["sourceDigest"]:
                raise ValueError("previous scaling observation is not complete and source-bound")
            completed.add(key);report["observations"].append({**entry,"retainedEvidence":str(path),
              "retainedEvidenceSha256":hashlib.sha256(path.read_bytes()).hexdigest()})
        (a.evidence/"previous-report.snapshot.json").write_bytes(raw)
        report["previousSweep"]={"path":str(a.previous),"sha256":hashlib.sha256(raw).hexdigest(),
          "status":previous["status"],"parentTerminalExit":"UNOBSERVED_NOT_REWRITTEN",
          "originalFailedCoordinates":[[e["steps"],e["observation"]] for e in previous["observations"] if e["exit"]!=0],
          "policy":"Keep failures; bounded affected reruns and missing observations use new directories."}
    for steps in [1,2,4,8,16,64,256]:
        for observation in range(5):
            if (steps,observation) in completed: continue
            name=f"t{steps}-o{observation}"
            command=["flock","/home/factory-user/repos/finnor-z-shared-heavy.lock",str(a.node),"--import","tsx",
             str(a.repository/"finnor-os/scripts/project-z/z4/scaling.mts"),"--steps",str(steps),"--observation",str(observation),
             "--evidence",str(a.evidence/name)]
            started=time.monotonic()
            with (a.evidence/(name+".log")).open("xb") as output:
                result=subprocess.run(command,cwd=a.repository/"finnor-os",stdout=output,stderr=subprocess.STDOUT,
                  env=env,timeout=2400)
            row={"steps":steps,"observation":observation,"exit":result.returncode,"wallMsIncludingLockWait":round((time.monotonic()-started)*1000),
                 "command":command}
            if (a.evidence/name/"report.json").is_file():
                body=json.loads((a.evidence/name/"report.json").read_text())
                row.update(status=body["status"],proofBytes=body.get("proofBytes"),fullOriginal=body.get("fullOriginal"),
                  fullProofLifecycleWallMs=body.get("fullProofLifecycleWallMs"),coldAndWarmVerifier=body.get("coldAndWarmVerifier"))
            report["observations"].append(row)
            (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    report["status"]="PASSED_OFFLINE_MEASUREMENT_ONLY" if len(report["observations"])==35 and all(x["exit"]==0 for x in report["observations"]) else "FAILED"
    report["diagnosticReuseIsNotDemand"]=True
    report["crossover"]="NOT_ESTABLISHED_AT_ACTUAL_ELIGIBLE_N_ZERO"
    report["costGaps"]=["money","tokens","human work","aggregate RSS","native recovery","eligible financial demand"]
    (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"status":report["status"],"observations":len(report["observations"]),"output":str(a.evidence)}))
    return 0 if report["status"]=="PASSED_OFFLINE_MEASUREMENT_ONLY" else 1
if __name__=="__main__": raise SystemExit(main())
