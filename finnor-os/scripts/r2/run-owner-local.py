"""One scrubbed disposable owner lane; no inherited production credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
task = repo.parent
output = repo/'scope-r/r2-robust-programme-search/evidence/owner'/(
    datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8])
output.mkdir(parents=True, mode=0o700)
base = Path('/Users/paramdave/.factory/worktrees/completed-release-2026-10-08/FINNOR')
env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR')}
env.update(NODE_ENV='test', CI='1', LOG_LEVEL='silent', AUTH_DEV_BYPASS='1',
           FINNOR_TEST_MANAGED_EXTENSIONS='omit', RATE_LIMIT_PER_MINUTE='100000',
           FINNOR_M3_PROFILE='DISPOSABLE_NATIVE', FINNOR_M3_STORE=str(output/'store'),
           FINNOR_R2_EVIDENCE_DIR=str(output), FINNOR_M1_PROFILE='DISPOSABLE_NATIVE',
           FINNOR_M1_STORE=str(output/'m1'), FINNOR_P4_PROFILE='ordinary_disposable',
           FINNOR_P4_EVIDENCE_DIR=str(output/'p4'), FINNOR_S4_POLICY_STORE=str(output/'policies'),
           FINNOR_S3_MODEL_STORE=str(output/'models'), FINNOR_S3_PYTHON=str(base/'.m1-python/bin/python'),
           FINNOR_S5_PYTHON=str(base/'.m1-s5-python/bin/python'), P3_GOVERNORS='1',
           FINNOR_R2_RUNTIME=str(task/'r2-native/runtime'),
           FINNOR_R2_PYTHON='/Users/paramdave/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')
with (output/'runner.log').open('x') as log:
    run = subprocess.run(['node', '--import', 'tsx', 'scripts/r2/run-owner.mts', *sys.argv[1:]],
                         cwd=repo/'finnor-os', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
result_path=output/'results.json'
result=json.loads(result_path.read_text()) if result_path.exists() else {'cases':[]}
status=run.returncode if result['cases'] and all(c['status']=='PASS' for c in result['cases']) else 1
print(json.dumps({'output': str(output), 'exitCode': status}))
sys.exit(status)
