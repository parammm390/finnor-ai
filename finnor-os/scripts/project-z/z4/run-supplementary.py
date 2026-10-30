"""Bounded source/reference continuation. Native execution is host-bound, never CLI-authorized."""
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

DIGEST='4479bce31a46945067d88b262bcb549040c20d91b2dc57e788e6b335bda4f163'
NEGATIVE_DIGEST='8b88a2ad27212242e921446f11a53179682862cb07707ad149f94a3cf2d46ee1'
NODE_DIGEST='94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90'
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser()
    p.add_argument('--repository',type=Path,required=True)
    p.add_argument('--node',type=Path,required=True)
    p.add_argument('--evidence',type=Path,required=True)
    p.add_argument('--deadline',required=True)
    p.add_argument('--mode',choices=['prepare','original'],default='prepare')
    a=p.parse_args()
    if not all(x.is_absolute() for x in [a.repository,a.node,a.evidence]):raise ValueError('absolute paths required')
    deadline=dt.datetime.fromisoformat(a.deadline.replace('Z','+00:00')).timestamp()
    if not time.time()<deadline:raise ValueError('original deadline exhausted')
    scripts=a.repository/'finnor-os/scripts/project-z/z4'
    if sha(scripts/'supplementary-positive.v3.json')!=DIGEST or sha(scripts/'supplementary-negatives.v4.json')!=NEGATIVE_DIGEST:
        raise ValueError('frozen registration changed')
    if sha(a.node)!=NODE_DIGEST:raise ValueError('pinned Node changed')
    a.evidence.mkdir(parents=True,exist_ok=False,mode=0o700)
    cpus=sorted(os.sched_getaffinity(0))[:2]
    if len(cpus)!=2:raise ValueError('two CPUs unavailable')
    os.sched_setaffinity(0,cpus)
    disk=shutil.disk_usage(a.repository)
    memory=int(next(s.split()[1] for s in Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:')))*1024
    report={'schema':'finnor.z4.supplementary-source-campaign.v5','mode':a.mode,'status':'PREPARED',
            'registrationSha256':DIGEST,'negativeRegistrationSha256':NEGATIVE_DIGEST,
            'positiveDenominator':256,'selectedFreshProofs':256,'proofPassed':0,'proofNotRun':256,
            'nativeExecution':'NOT_RUN_NO_CURRENT_TARGET_OWNER_OR_UNCONSUMED_ADMISSION_BINDING',
            'retainedProofsImported':False,'protectedAdmission':'NOT_RUN','eligibleReuseN':0,
            'executionAuthorityGranted':False,'cpus':cpus,'deadlineAt':a.deadline,
            'diskStart':{'used':disk.used,'free':disk.free},'availableMemoryBytes':memory}
    output=a.evidence/'report.json'
    def save():output.write_text(json.dumps(report,indent=2)+'\n')
    save()
    if disk.free<6*1024**3 or memory<4*1024**3:
        report['status']='RESOURCE_REFUSED_NO_RETRY';save();return 1
    env={'PATH':str(a.node.parent)+':/usr/bin:/bin','HOME':str(a.evidence),'TMPDIR':str(a.evidence),
         'NODE_OPTIONS':'--max-old-space-size=1024 --import='+str(scripts/'isolation-loader.mjs'),
         'TSX_DISABLE_CACHE':'1','PYTHONDONTWRITEBYTECODE':'1','CI':'1'}
    command=['flock','-w','300','-E','75','/home/factory-user/repos/finnor-z-shared-heavy.lock',str(a.node),
             '--import','tsx',str(scripts/'supplementary-qualification.mts'),'--mode',a.mode,'--evidence',str(a.evidence/'process')]
    identities={str(f.relative_to(a.repository)):sha(f) for f in [
        scripts/'supplementary-positive.v3.json',scripts/'supplementary-negatives.v4.json',scripts/'public-cases.pre-code.json',
        scripts/'supplementary-qualification.mts',scripts/'run-supplementary.py']}
    runtime=a.repository/'finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof'
    identities.update({str(f.relative_to(a.repository)):sha(f) for f in runtime.glob('*.ts')})
    report.update(command=command,cwd=str(a.repository/'finnor-os'),environmentVariableNames=sorted(env),
                  sourceIdentities=identities,startedAt=dt.datetime.now(dt.timezone.utc).isoformat())
    save()
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
        report['status']='STOPPED_NO_RETRY';save()
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    started=time.monotonic();before=resource.getrusage(resource.RUSAGE_CHILDREN)
    with (a.evidence/'process.log').open('xb') as log:
        child=subprocess.Popen(command,cwd=a.repository/'finnor-os',env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:code=child.wait(timeout=max(1,min(600,deadline-time.time())))
        except subprocess.TimeoutExpired:stop(signal.SIGTERM,None)
    usage=resource.getrusage(resource.RUSAGE_CHILDREN)
    parent=resource.getrusage(resource.RUSAGE_SELF)
    report.update(exit=code,pid=child.pid,wallMsIncludingLockWait=round((time.monotonic()-started)*1000),
        processTreeCpuMicros=round((usage.ru_utime-before.ru_utime+usage.ru_stime-before.ru_stime)*1e6),
        controllerLifetimeCpuMicrosThroughSnapshot=round((parent.ru_utime+parent.ru_stime)*1e6),
        controllerFinalWriteAndExitCpu="UNMEASURED_NOT_ZERO",
        maximumSingleChildRSSBytesNotAggregate=usage.ru_maxrss*1024)
    path=a.evidence/'process/report.json'
    if path.exists():
        body=json.loads(path.read_bytes());report['processStatus']=body['status']
        report['positivePassed']=body['positivePassed']
    report['sourcesUnchanged']=all(sha(a.repository/name)==digest for name,digest in identities.items())
    final=shutil.disk_usage(a.repository)
    report['diskEnd']={'used':final.used,'free':final.free,'growthBytes':final.used-disk.used}
    report['status']='PASSED_SOURCE_PROCESS_ONLY' if code==0 and report['sourcesUnchanged'] else 'FAILED_STOPPED_NO_RETRY'
    if final.used-disk.used>256*1024**2:report['status']='RESOURCE_REFUSED_NO_RETRY'
    report['endedAt']=dt.datetime.now(dt.timezone.utc).isoformat();save()
    print(json.dumps({k:report.get(k) for k in ['status','positivePassed','selectedFreshProofs','proofPassed','nativeExecution']}))
    return 0 if report['status']=='PASSED_SOURCE_PROCESS_ONLY' else 1
if __name__=='__main__':raise SystemExit(main())
