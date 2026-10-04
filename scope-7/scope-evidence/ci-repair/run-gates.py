"""Run reviewable command plans; retain each real exit and fail their aggregate."""
import datetime,hashlib,json,os,pathlib,signal,subprocess,sys
plan_path=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=False)
root=pathlib.Path(__file__).resolve().parents[3]
plan=json.loads(plan_path.read_text());results=[]
for gate in plan:
    start=datetime.datetime.now(datetime.timezone.utc).isoformat()
    log=out/(gate['id']+'.log')
    with log.open('w') as stream:
        child=subprocess.Popen(gate['command'],cwd=root/gate.get('cwd','.'),env=os.environ.copy(),stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        try:code=child.wait(timeout=gate.get('timeoutSeconds',1800))
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            code=124
    results.append(dict(gate,exitCode=code,status='PASS' if code==0 else 'FAIL',startedAt=start,finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),log=log.name,logSha256=hashlib.sha256(log.read_bytes()).hexdigest()))
    report={'qualification':'ACTUAL_COMMAND_EXIT_CODES; NOT_FIELD_OR_REMOTE_CI_PROOF','planSha256':hashlib.sha256(plan_path.read_bytes()).hexdigest(),'results':results,'complete':len(results)==len(plan),'status':'PASS' if len(results)==len(plan) and all(v['exitCode']==0 for v in results) else 'FAIL'}
    (out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'id':gate['id'],'exitCode':code}),flush=True)
sys.exit(0 if report['status']=='PASS' else 1)
