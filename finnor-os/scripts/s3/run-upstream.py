"""Replay the existing S1/S2 E2E owners without changing upstream code/evidence.
Sequential disposable runs use a clean environment and save results under S3.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import uuid
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[3]
output = repo/'scope-3/scope-evidence'/('upstream-'+datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')+'-'+str(uuid.uuid4())[:8])
output.mkdir(parents=True)
base = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR')}
base.update(NODE_ENV='test', CI='1', LOG_LEVEL='silent', FINNOR_TEST_MANAGED_EXTENSIONS='omit',
            AUTH_DEV_BYPASS='1', RATE_LIMIT_PER_MINUTE='100000')
results = []
for scope in ['s1', 's2']:
    directory = output/scope
    directory.mkdir()
    environment = dict(base)
    environment[f'FINNOR_{scope.upper()}_EVIDENCE_DIR'] = str(directory)
    runner = f'scripts/{scope}/run-{scope}-e2e.mts'
    with (directory/'wrapper.log').open('w') as log:
        result = subprocess.run(['node_modules/.bin/tsx', runner], cwd=repo/'finnor-os', env=environment,
                                stdout=log, stderr=subprocess.STDOUT)
    results.append({'scope': scope, 'runner': runner, 'exitCode': result.returncode,
                    'runnerSha256': hashlib.sha256((repo/'finnor-os'/runner).read_bytes()).hexdigest(),
                    'evidenceDirectory': str(directory)})
    (output/'manifest.json').write_text(json.dumps({'schema': 'finnor.s3.upstream-regression.v1',
        'results': results, 'rerun': 'python3 finnor-os/scripts/s3/run-upstream.py',
        'boundary': 'Original S1/S2 E2E contracts and limits remain unchanged; no new upstream admission'}, indent=2)+'\n')
print(json.dumps({'output': str(output), 'results': results}))
sys.exit(1 if any(r['exitCode'] != 0 for r in results) else 0)
