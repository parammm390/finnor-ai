"""Replay unchanged upstream owner proofs into S5-owned evidence directories."""
import hashlib,json,os,pathlib,subprocess,sys,uuid
from datetime import datetime,timezone
repo=pathlib.Path(__file__).resolve().parents[3]
output=repo/'scope-5/scope-evidence'/('upstream-'+datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')+'-'+str(uuid.uuid4())[:8]);output.mkdir(parents=True)
base={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR')}
base.update(NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='1',RATE_LIMIT_PER_MINUTE='100000',FINNOR_TEST_MANAGED_EXTENSIONS='omit',FINNOR_S3_PYTHON='/tmp/finnor-s3-python/bin/python')
results=[]
for scope in ['s4','s3','s2','s1']:
 directory=output/scope;directory.mkdir();env=dict(base);env[f'FINNOR_{scope.upper()}_EVIDENCE_DIR']=str(directory);env['FINNOR_S3_MODEL_STORE']=str(directory/'ordinary-models');env['FINNOR_S4_POLICY_STORE']=str(directory/'ordinary-policies')
 runner=f'scripts/{scope}/run-{scope}-e2e.mts'
 with (directory/'wrapper.log').open('w') as log:
  run=subprocess.run(['node','--import=tsx',runner],cwd=repo/'finnor-os',env=env,stdout=log,stderr=subprocess.STDOUT)
 p=directory/'results.json';artifact=json.loads(p.read_text()) if p.exists() else {};cases=artifact.get('cases',artifact.get('results',[]))
 valid=isinstance(cases,list) and bool(cases) and all(isinstance(c,dict) and c.get('status')=='PASS' for c in cases) and artifact.get('status','PASS') in ('PASS','PASS_LOCAL')
 result={'scope':scope,'runner':runner,'runnerSha256':hashlib.sha256((repo/'finnor-os'/runner).read_bytes()).hexdigest(),'processExitCode':run.returncode,'exitCode':run.returncode or (0 if valid else 1),'evidenceDirectory':str(directory),'artifactSchema':artifact.get('schema'),'artifactStatus':artifact.get('status'),'cases':[{k:c.get(k) for k in ('id','status')} for c in cases if isinstance(c,dict)]};results.append(result)
 (output/'manifest.json').write_text(json.dumps({'schema':'finnor.s5.upstream-regression.v1','results':results,'qualification':'Unchanged original owner contracts; local evidence only, no upstream gate promotion','rerun':'python3 finnor-os/scripts/s5/run-upstream.py'},indent=2)+'\n');print(json.dumps(result),flush=True)
sys.exit(1 if any(r['exitCode']!=0 for r in results) else 0)
