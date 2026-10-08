"""Start the real disposable native browser fixture in a scrubbed environment.

Use a new evidence directory, start the frontend with the three values recorded
in scope-evidence/browser/frontend-env.json, then run browser-e2e.mjs. The browser
runner stops the fixture through its local control port. This driver grades setup
and shutdown only; the browser receipt contains the interaction results.
"""
import hashlib,json,os,pathlib,subprocess,sys
from datetime import datetime,timezone
backend=pathlib.Path(__file__).resolve().parents[2]
output=pathlib.Path(sys.argv[1]).resolve();output.mkdir(exist_ok=False)
node=pathlib.Path(os.environ.get('FINNOR_TEST_NODE','/Users/paramdave/.hermes/node/bin/node')).resolve(strict=True)
python=pathlib.Path(os.environ.get('FINNOR_TEST_PYTHON','/tmp/finnor-s3-python/bin/python')).absolute();python.resolve(strict=True)
env={k:v for k,v in os.environ.items() if k in ('HOME','PATH','TMPDIR')}
env.update(NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='1',FINNOR_TEST_MANAGED_EXTENSIONS='omit',FINNOR_M1_PROFILE='DISPOSABLE_NATIVE',FINNOR_M1_STORE=str(output/'producer-store'),FINNOR_S3_MODEL_STORE=str(output/'models'),FINNOR_S4_POLICY_STORE=str(output/'policies'),FINNOR_S3_PYTHON=str(python),FINNOR_S5_PYTHON=str(python),P3_GOVERNORS='1',RATE_LIMIT_PER_MINUTE='100000',FINNOR_P1_EVIDENCE_DIR=str(output),FINNOR_P1_BROWSER_FIXTURE='1',FINNOR_P1_CASE_FILTER='__browser_only__')
command=[str(node),'--import=tsx','scripts/p1/run-program-e2e.mts']
receipt={'schema':'finnor.p1.browser-fixture-driver.v1','startedAt':datetime.now(timezone.utc).isoformat(),'command':command,'cwd':str(backend),'environmentNames':sorted(env),'sourceSha256':hashlib.sha256((backend/command[-1]).read_bytes()).hexdigest(),'driverSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'qualification':'DISPOSABLE_LOCAL_AUTH_SERVICE; ACTUAL_NATIVE_API_AND_QUEUE; NOT_HOSTED_SUPABASE'}
(output/'driver-start.json').write_text(json.dumps(receipt,indent=2))
with (output/'runner.log').open('w') as log:
 try:receipt['exitCode']=subprocess.run(command,cwd=backend,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=2400).returncode
 except subprocess.TimeoutExpired:receipt.update(exitCode=124,failure='FIXTURE_TIMEOUT')
receipt['finishedAt']=datetime.now(timezone.utc).isoformat();(output/'driver-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt));raise SystemExit(receipt['exitCode'])
