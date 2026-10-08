"""Credential-free disposable S4 qualification; never provisions AWS."""
import json, os, pathlib, subprocess, sys, uuid
from datetime import datetime, timezone
repo=pathlib.Path(__file__).resolve().parents[3]
output=repo/'scope-4/scope-evidence'/('run-'+datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')+'-'+str(uuid.uuid4())[:8])
output.mkdir(parents=True)
env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR')}
env.update(NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='1',RATE_LIMIT_PER_MINUTE='100000',FINNOR_TEST_MANAGED_EXTENSIONS='omit',FINNOR_S4_EVIDENCE_DIR=str(output),FINNOR_S4_POLICY_STORE=str(output/'ordinary-policies'),FINNOR_S3_MODEL_STORE=str(output/'ordinary-models'),FINNOR_S3_PYTHON=os.environ.get('FINNOR_S3_PYTHON','/tmp/finnor-s3-python/bin/python'))
with (output/'runner.log').open('w') as log:
    run=subprocess.run(['node_modules/.bin/tsx','scripts/s4/run-s4-e2e.mts'],cwd=repo/'finnor-os',env=env,stdout=log,stderr=subprocess.STDOUT)
status=run.returncode
if (output/'results.json').exists():
    result=json.loads((output/'results.json').read_text())
    if any(x['status']!='PASS' for x in result['cases']): status=1
else: status=1
print(json.dumps({'output':str(output),'exitCode':status}));sys.exit(status)
