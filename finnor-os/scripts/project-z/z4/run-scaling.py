"""One finite 7x5 sweep. Each observation owns and then releases the heavy lock."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import time

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--repository",required=True,type=Path)
    p.add_argument("--node",required=True,type=Path)
    p.add_argument("--evidence",required=True,type=Path)
    p.add_argument("--previous",type=Path)
    p.add_argument("--deadline",required=True)
    a=p.parse_args()
    if not all(x.is_absolute() for x in [a.repository,a.node,a.evidence]): raise ValueError("absolute paths required")
    deadline=dt.datetime.fromisoformat(a.deadline.replace("Z","+00:00")).timestamp()
    if deadline<=time.time():raise ValueError("original measurement deadline exhausted")
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
            completed.add(key);report.setdefault("historicalObservations",[]).append({**entry,"retainedEvidence":str(path),
              "retainedEvidenceSha256":hashlib.sha256(path.read_bytes()).hexdigest()})
        (a.evidence/"previous-report.snapshot.json").write_bytes(raw)
        report["previousSweep"]={"path":str(a.previous),"sha256":hashlib.sha256(raw).hexdigest(),
          "status":previous["status"],"parentTerminalExit":"UNOBSERVED_NOT_REWRITTEN",
          "originalFailedCoordinates":[[e["steps"],e["observation"]] for e in previous["observations"] if e["exit"]!=0],
          "policy":"Historical only. Never imports retained proofs or old partial timers into new full-cost observations."}
    completed.clear()
    child=None
    def stop(signum,frame):
        if child is not None and child.poll() is None:
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                child.wait()
        report["status"]="STOPPED_NO_RETRY"
        (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    for steps in [1,2,4,8,16,64,256]:
        for observation in range(5):
            if (steps,observation) in completed: continue
            disk=shutil.disk_usage(a.repository)
            memory=int(next(s.split()[1] for s in Path("/proc/meminfo").read_text().splitlines() if s.startswith("MemAvailable:")))*1024
            if time.time()>=deadline or disk.free<6*1024**3 or memory<4*1024**3:
                report.update(status="RESOURCE_OR_DEADLINE_REFUSED_NO_RETRY",freeDiskBytes=disk.free,availableMemoryBytes=memory)
                (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
                return 1
            name=f"t{steps}-o{observation}"
            command=["flock","-w","300","-E","75","/home/factory-user/repos/finnor-z-shared-heavy.lock",str(a.node),"--import","tsx",
             str(a.repository/"finnor-os/scripts/project-z/z4/scaling.mts"),"--steps",str(steps),"--observation",str(observation),
             "--evidence",str(a.evidence/name),"--deadline",a.deadline]
            started=time.monotonic()
            before=resource.getrusage(resource.RUSAGE_CHILDREN)
            with (a.evidence/(name+".log")).open("xb") as output:
                child=subprocess.Popen(command,cwd=a.repository/"finnor-os",stdout=output,stderr=subprocess.STDOUT,
                  env=env,start_new_session=True)
                try:code=child.wait(timeout=max(1,min(600,deadline-time.time())))
                except subprocess.TimeoutExpired:stop(signal.SIGTERM,None)
            usage=resource.getrusage(resource.RUSAGE_CHILDREN)
            parent=resource.getrusage(resource.RUSAGE_SELF)
            row={"steps":steps,"observation":observation,"exit":code,"pid":child.pid,
                 "wallMsIncludingLockWait":round((time.monotonic()-started)*1000),
                 "processTreeCpuMicros":round((usage.ru_utime-before.ru_utime+usage.ru_stime-before.ru_stime)*1e6),
                 "controllerCumulativeCpuMicrosThroughSnapshot":round((parent.ru_utime+parent.ru_stime)*1e6),
                 "controllerCpuScope":"Cumulative checkpoint, never sum these rows as independent totals",
                 "maximumSingleChildRSSBytesNotAggregate":usage.ru_maxrss*1024,"command":command}
            child=None
            if (a.evidence/name/"report.json").is_file():
                body=json.loads((a.evidence/name/"report.json").read_text())
                row.update(status=body["status"],proofBytes=body.get("proofBytes"),fullOriginal=body.get("fullOriginal"),
                  fullProofLifecycleWallMs=body.get("fullProofLifecycleWallMs"),coldAndWarmVerifier=body.get("coldAndWarmVerifier"),
                  fullIndependentProofCheck=body.get("fullIndependentProofCheck"),intervals=body.get("intervals"),
                  fullCostGaps=body.get("fullCostGaps"))
            report["observations"].append(row)
            (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
            if code!=0:
                report["status"]="FAILED_STOPPED_NO_RETRY"
                (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
                return 1
    report["status"]="PASSED_OFFLINE_MEASUREMENT_ONLY" if len(report["observations"])==35 and all(x["exit"]==0 for x in report["observations"]) else "FAILED"
    report["diagnosticReuseIsNotDemand"]=True
    report["crossover"]="NOT_ESTABLISHED_AT_ACTUAL_ELIGIBLE_N_ZERO"
    report["costGaps"]=["money","tokens","human work","aggregate RSS","native recovery","eligible financial demand"]
    (a.evidence/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"status":report["status"],"observations":len(report["observations"]),"output":str(a.evidence)}))
    return 0 if report["status"]=="PASSED_OFFLINE_MEASUREMENT_ONLY" else 1
if __name__=="__main__": raise SystemExit(main())
