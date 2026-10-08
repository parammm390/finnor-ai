"""Start the actual P2 owner-bound UI fixture; no business transport is mocked."""
import hashlib,json,os,pathlib,subprocess,sys
from datetime import datetime,timezone
backend=pathlib.Path(__file__).resolve().parents[2]
output=pathlib.Path(sys.argv[1]).resolve();output.mkdir(exist_ok=False)
node=pathlib.Path(os.environ['FINNOR_TEST_NODE']).resolve(strict=True)
python=pathlib.Path(os.environ['FINNOR_TEST_PYTHON']).absolute();python.resolve(strict=True)
env={k:v for k,v in os.environ.items() if k in ('HOME','PATH','TMPDIR')}
env.update(NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='1',FINNOR_TEST_MANAGED_EXTENSIONS='omit',FINNOR_M1_PROFILE='DISPOSABLE_NATIVE',FINNOR_M1_STORE=str(output/'producer-store'),FINNOR_S3_MODEL_STORE=str(output/'models'),FINNOR_S4_POLICY_STORE=str(output/'policies'),FINNOR_S3_PYTHON=str(python),FINNOR_S5_PYTHON=str(python),P3_GOVERNORS='1',RATE_LIMIT_PER_MINUTE='100000',FINNOR_P2_EVIDENCE_DIR=str(output),FINNOR_P2_BROWSER_FIXTURE='1')
command=[str(node),'--import=tsx','scripts/p2/run-e2e.mts']
receipt={'schema':'finnor.p2.browser-fixture-driver.v1','startedAt':datetime.now(timezone.utc).isoformat(),'command':command,'cwd':str(backend),'environmentNames':sorted(env),'sourceSha256':hashlib.sha256((backend/command[-1]).read_bytes()).hexdigest(),'driverSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'qualification':'DISPOSABLE_LOCAL_AUTH_SERVICE; ACTUAL_NATIVE_API_QUEUE_S4_S5; NOT_HOSTED_SUPABASE_OR_PROTECTED_EXECUTION'}
(output/'driver-start.json').write_text(json.dumps(receipt,indent=2)+'\n')
with (output/'runner.log').open('w') as log:
 try:receipt['exitCode']=subprocess.run(command,cwd=backend,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1200).returncode
 except subprocess.TimeoutExpired:receipt.update(exitCode=124,failure='FIXTURE_TIMEOUT')
results_path=output/'results.json'
if results_path.exists():
 cases=json.loads(results_path.read_text()).get('results',[])
 receipt['counts']={s:sum(r.get('status')==s for r in cases)for s in ('PASS','FAIL','NOT_RUN')}
 if receipt['counts']['PASS']!=1 or receipt['counts']['FAIL']:receipt['exitCode']=receipt['exitCode'] or 1
else:receipt.update(exitCode=receipt['exitCode'] or 1,failure='MISSING_NATIVE_BROWSER_STORY_RECEIPT')
receipt['finishedAt']=datetime.now(timezone.utc).isoformat();(output/'driver-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt));raise SystemExit(receipt['exitCode'])
