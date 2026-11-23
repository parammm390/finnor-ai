"""Bounded, credential-free profiler for the explicit offline diagnostic binaries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import sys
import time

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--native",required=True,type=Path)
    p.add_argument("--mode",choices=["field-prove","field-verify","warm-verify"],required=True)
    p.add_argument("--candidate",type=Path)
    a=p.parse_args()
    if not a.native.is_absolute() or a.native.resolve()!=a.native: raise ValueError("exact native directory required")
    identity=json.loads((a.native/"build-identity.json").read_text())
    field=a.mode.startswith("field-")
    binary=a.native/"bin"/("z4-field-falsifier" if field else "z4-proof")
    identity_key="diagnosticBinarySha256" if field else "binarySha256"
    if binary.is_symlink() or hashlib.sha256(binary.read_bytes()).hexdigest()!=identity[identity_key]: raise ValueError("diagnostic binary changed")
    candidate=json.loads(a.candidate.read_text()) if a.candidate else None
    messages=[{"operation":"prove"}] if a.mode=="field-prove" else (
        [{"operation":"verify","artifact":candidate}] if field else [candidate,candidate])
    def restrict():
        resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
        resource.setrlimit(resource.RLIMIT_CPU,(180,180))
        resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
        resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    started=time.monotonic()
    proc=subprocess.Popen([str(binary)]+([] if field else ["verify","--stream"]),stdin=subprocess.PIPE,
          stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=restrict,
          cwd=a.native,env={"PATH":"/usr/bin:/bin","RAYON_NUM_THREADS":"2"},close_fds=True)
    def terminate(signum,frame):
        os.killpg(proc.pid,signal.SIGKILL)
        proc.communicate()
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,terminate)
    signal.signal(signal.SIGINT,terminate)
    readings=[]
    err=bytearray()
    try:
        selector=selectors.DefaultSelector()
        selector.register(proc.stdout,selectors.EVENT_READ,"out")
        selector.register(proc.stderr,selectors.EVENT_READ,"err")
        for message in messages:
            mark=time.monotonic()
            body=json.dumps(message,separators=(",",":")).encode()+b"\n"
            if len(body)>1024*1024: raise ValueError("diagnostic input bound")
            proc.stdin.write(body);proc.stdin.flush()
            if field: proc.stdin.close()
            output=bytearray()
            while b"\n" not in output:
                if time.monotonic()-started>180: raise TimeoutError("diagnostic timeout")
                ready=selector.select(1)
                for key,_ in ready:
                    part=os.read(key.fd,65536)
                    if not part:
                        selector.unregister(key.fileobj)
                        if key.data=="out" and b"\n" not in output: raise ValueError("diagnostic truncated output")
                    elif key.data=="out": output.extend(part)
                    else: err.extend(part)
                if len(output)>1024*1024 or len(err)>65536: raise ValueError("diagnostic output bound")
            parsed=json.loads(output)
            if parsed.get("ok") is not True: raise ValueError("diagnostic verifier rejected")
            readings.append({"wallMs":(time.monotonic()-mark)*1000,"response":parsed["body"]})
        if not field: proc.stdin.close()
        exit_code=proc.wait(timeout=max(1,180-(time.monotonic()-started)))
        if exit_code!=0: raise ValueError("diagnostic process failed")
        usage=resource.getrusage(resource.RUSAGE_CHILDREN)
        print(json.dumps({"status":"OFFLINE_DIAGNOSTIC_ONLY","mode":a.mode,"binarySha256":identity[identity_key],
          "readings":readings,"process":{"pid":proc.pid,"exitCode":exit_code,"wallMs":(time.monotonic()-started)*1000,
          "cpuMicros":round((usage.ru_utime+usage.ru_stime)*1000000),"peakRSSBytes":usage.ru_maxrss*1024,
          "stderrBytes":len(err),"perResponseCPU":None,"aggregateRSS":None,"usd":None,"humanSeconds":None}}))
    finally:
        if proc.poll() is None: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
if __name__=="__main__": main()
