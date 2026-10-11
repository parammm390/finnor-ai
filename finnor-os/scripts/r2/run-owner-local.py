"""One scrubbed disposable owner lane; no inherited production credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
import hashlib
import resource
import signal
import time
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
required = ('FINNOR_TEST_NODE', 'FINNOR_S3_PYTHON', 'FINNOR_S5_PYTHON',
            'FINNOR_R2_RUNTIME', 'FINNOR_R2_PYTHON')
missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise SystemExit('Set explicit verified runtime bindings: '+', '.join(missing))
bindings = {name: Path(os.environ[name]).absolute() for name in required}
for path in bindings.values():
    path.resolve(strict=True)
bindings['FINNOR_TEST_NODE'] = bindings['FINNOR_TEST_NODE'].resolve()
bindings['FINNOR_R2_RUNTIME'] = bindings['FINNOR_R2_RUNTIME'].resolve()
output = Path(os.environ.get('FINNOR_R2_EVIDENCE_DIR') or str(
    repo/'scope-r/r2-robust-programme-search/evidence/owner'/(
        datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8]))).resolve()
output.mkdir(parents=True, mode=0o700, exist_ok=False)
env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR')}
env.update(NODE_ENV='test', CI='1', LOG_LEVEL='silent', AUTH_DEV_BYPASS='1',
           FINNOR_TEST_MANAGED_EXTENSIONS='omit', RATE_LIMIT_PER_MINUTE='100000',
           FINNOR_M3_PROFILE='DISPOSABLE_NATIVE', FINNOR_M3_STORE=str(output/'store'),
           FINNOR_R2_EVIDENCE_DIR=str(output), FINNOR_M1_PROFILE='DISPOSABLE_NATIVE',
           FINNOR_M1_STORE=str(output/'m1'), FINNOR_P4_PROFILE='ordinary_disposable',
           FINNOR_P4_EVIDENCE_DIR=str(output/'p4'), FINNOR_S4_POLICY_STORE=str(output/'policies'),
           FINNOR_S3_MODEL_STORE=str(output/'models'), P3_GOVERNORS='1',
           OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
env.update({name: str(path) for name, path in bindings.items() if name != 'FINNOR_TEST_NODE'})
command = [str(bindings['FINNOR_TEST_NODE']), '--import', 'tsx',
           'scripts/r2/run-owner.mts', *sys.argv[1:]]
sha = lambda data: hashlib.sha256(data).hexdigest()
receipt = {'schema': 'finnor.r2.owner-driver.v2', 'status': 'RUNNING',
           'command': command, 'cwd': str(repo/'finnor-os'), 'wallCeilingSeconds': 1200,
           'executables': [{'binding': name, 'path': str(path), 'sha256': sha(path.read_bytes())}
                           for name, path in bindings.items() if name != 'FINNOR_R2_RUNTIME'],
           'nativeManifestSha256': sha((bindings['FINNOR_R2_RUNTIME']/'manifest.json').read_bytes()),
           'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
           'trackedOverlaySha256': sha(subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=repo)),
           'driverSha256': sha(Path(__file__).read_bytes()),
           'protectedAdmission': False, 'economicQualification': False}
(output/'driver-receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
started = time.monotonic()
with (output/'runner.log').open('x') as log:
    child = subprocess.Popen(command, cwd=repo/'finnor-os', env=env,
                             stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = child.wait(timeout=1200)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        code = 124
        receipt['failure'] = 'ORIGINAL_DRIVER_WALL_CEILING_UNKNOWN_RESPONSIBILITIES_RETAINED'
result_path=output/'results.json'
try:
    result=json.loads(result_path.read_text()) if result_path.exists() else {'cases':[]}
except (OSError, ValueError):
    result={'cases':[]}
complete=bool(result['cases']) and all(c['status']=='PASS' for c in result['cases'])
if '--serve' in sys.argv:
    complete=complete and any(c['id']=='mounted-Work' and c['status']=='PASS' for c in result['cases'])
status=code if complete else code or 1
usage=resource.getrusage(resource.RUSAGE_CHILDREN)
receipt.update(status='PASS_LOCAL' if status == 0 else 'FAIL', exitCode=status,
               ownedDriverPid=child.pid, elapsedSeconds=time.monotonic()-started,
               childCpuUserSeconds=usage.ru_utime, childCpuSystemSeconds=usage.ru_stime,
               childMaxRssNative=usage.ru_maxrss, memoryScope='CHILD_HIGH_WATER_NOT_AGGREGATE_PEAK',
               dollars=None, humanSeconds=None)
(output/'driver-receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
print(json.dumps({'output': str(output), 'exitCode': status}))
sys.exit(status)
